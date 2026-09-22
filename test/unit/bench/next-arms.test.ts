/**
 * contract 1.9 (Fastlane), docs/LLM-LOOP-DESIGN.md §8: the `jev-on-next` / `jev-on-next-nofast` arms and their
 * measurement. Four things are pinned here, each because it is a place the wave can silently measure nothing:
 *
 *   1. the arms are the `jev-on` engine with PINNED mechanisms (never the environment's), the control differs in
 *      exactly one of them, and the runner refuses either at any concurrency but 1;
 *   2. the §5.5 bridge — a `steps.jsonl` row's `fastPath` / `router` / `riskSource` members reach `StepsSummary`,
 *      and a row written by an engine without them contributes zeros rather than throwing;
 *   3. the §8.3 rows, §8.4 predictions and §8.5 accept rule, including the two readings §8's prose leaves open and
 *      the cases that must NOT read as a pass (no control, no gate report, an arm that was never armed);
 *   4. the one cross-slot gap: `src/cli/args.ts` keeps its own `--conditions` allow-list.
 */
import { describe, expect, it } from 'vitest';
import { CONDITIONS } from '../../../src/cli/args.js';
import { CONDITION_ORDER, armMechanisms, buildEngineOptions, conditionConfig, engineModeOf, isNextArm, parseConditions, pinnedGeneration, requiresSerialBench, usesSynthesizer, usesTunedProvider } from '../../../src/bench/conditions.js';
import { computeSuiteMetrics } from '../../../src/bench/metrics.js';
import { evaluateAcceptRule, evaluatePredictions, FASTPATH_REASONS, FRESH_18, measurementRows, recorded, RECORDED_BUILD } from '../../../src/bench/next-arms.js';
import { buildRecord, validateOptions } from '../../../src/bench/runner.js';
import { emptyStepsSummary, mergeStepsSummaries, summariseStepRows, withWaveMembers } from '../../../src/bench/step-records.js';
import type { BenchRecord, StepsSummary } from '../../../src/bench/types.js';
import type { BenchCondition } from '../../../src/core/types.js';
import { baseOptions, createFakeDeps, fakeRunResult, syntheticSource } from './helpers.js';

const step = (over: Record<string, unknown>): string => JSON.stringify({ step: 1, proposer: 'synth', ...over });

function rec(task: string, condition: BenchCondition, over: Partial<BenchRecord> = {}): BenchRecord {
  const base = buildRecord({
    source: syntheticSource({ id: task }),
    condition,
    result: fakeRunResult({ runId: `r-${task}-${condition}`, mode: engineModeOf(condition), steps: 2, wallMs: over.wallMs ?? 20_000 }),
    evaluation: { pass: over.pass ?? true, evaluator: 'local' },
    patch: { modelPatch: 'd', patchBytes: 1, patchEmpty: false },
    capFired: null,
  });
  return { ...base, suite: 'quixbugs', ...over };
}

describe('the jev-on-next arms (§8.1)', () => {
  it('are the jev-on engine with pinned mechanisms, and the control differs in exactly one', () => {
    expect(CONDITION_ORDER.slice(-2)).toEqual(['jev-on-next', 'jev-on-next-nofast']);
    for (const arm of ['jev-on-next', 'jev-on-next-nofast'] as const) {
      expect(engineModeOf(arm)).toBe('jev-on');
      // the fast path builds its own jev-only synthesizer per run; it is not the arm's proposer
      expect(usesSynthesizer(arm)).toBe(false);
      expect(usesTunedProvider(arm)).toBe(false);
      expect(isNextArm(arm)).toBe(true);
      expect(pinnedGeneration(arm, 'z-ai/glm-5.3-flash')).toMatchObject({ proposer: 'generator', maxTokens: 1500, deadlineMs: 20_000, repositoryDeadlineMs: 30_000, lengthHandling: 'double-once' });
      expect(pinnedGeneration(arm, 'z-ai/glm-5.3-flash').s2).toEqual({ hedges: { perRound: 1, afterMsMin: 3_000, afterMsMax: 8_000, ttfbP50Multiple: 2 }, prefix: 'byte-stable', reasoningMaxTokens: 256 });
    }
    // the tuned object, minus the S2 block, is what the arms pin: the two differ only in `s2`
    const { s2, ...next } = pinnedGeneration('jev-on-next', 'm');
    expect(s2).toBeDefined();
    expect(next).toEqual(pinnedGeneration('jev-off-tuned', 'm'));
    // ONE mechanism apart — that is what makes the pair a contrast
    expect(armMechanisms('jev-on-next')).toEqual({ fastPath: 'auto', routers: true, s2: true });
    expect(armMechanisms('jev-on-next-nofast')).toEqual({ fastPath: 'off', routers: true, s2: true });
    for (const older of ['jev-on', 'jev-off', 'jev-only', 'llm-jev', 'llm-sieve', 'jev-off-tuned'] as const) {
      expect(armMechanisms(older)).toEqual({ fastPath: 'off', routers: false, s2: false });
    }
    expect(parseConditions('jev-on-next,jev-on-next-nofast')).toEqual(['jev-on-next', 'jev-on-next-nofast']);
  });

  it('write their mechanisms into EngineOptions and summary.json, never reading them from the environment', () => {
    const opts = baseOptions('/r', '/o');
    const input = { task: 't', workspace: '/w', provider: { model: 'm' }, decider: {}, meter: {} } as unknown as Parameters<typeof buildEngineOptions>[0];
    const prev = process.env['JEVCODE_FASTPATH'];
    process.env['JEVCODE_FASTPATH'] = 'auto';
    try {
      // the env says 'auto' for every arm; the arm's own row is what lands
      expect(buildEngineOptions({ ...input, condition: 'jev-on' }, opts)).toMatchObject({ mode: 'jev-on', fastPath: 'off', routers: 'off' });
      expect(buildEngineOptions({ ...input, condition: 'jev-on-next' }, opts)).toMatchObject({ mode: 'jev-on', fastPath: 'auto', routers: 'on' });
      expect(buildEngineOptions({ ...input, condition: 'jev-on-next-nofast' }, opts)).toMatchObject({ mode: 'jev-on', fastPath: 'off', routers: 'on' });
    } finally {
      if (prev === undefined) delete process.env['JEVCODE_FASTPATH'];
      else process.env['JEVCODE_FASTPATH'] = prev;
    }
    expect(conditionConfig('jev-on-next', opts, 'm').mechanisms).toEqual({ fastPath: 'auto', routers: true, s2: true });
    expect(conditionConfig('llm-jev', opts, 'm').mechanisms).toEqual({ fastPath: 'off', routers: false, s2: false });
  });

  it('are measured at --concurrency 1, and the runner refuses anything else (§8.2 / §6 row 15)', () => {
    expect(requiresSerialBench(['jev-on', 'llm-jev'])).toBe(false);
    expect(requiresSerialBench(['jev-on-next'])).toBe(true);
    // the control is held to the same bar: a paired contrast whose arms ran at different concurrencies is not one
    expect(requiresSerialBench(['jev-on-next-nofast'])).toBe(true);
    const deps = createFakeDeps({ script: () => ({ result: { steps: 1, tokensPerStep: [10], generatorTokensPerStep: [10], jevTokensPerStep: [0], jevLatencyMs: [], counters: { blocked: 0, reviews: 0, declined: 0, failed: 0, loops: 0, replans: 0, reads: 0 } }, decisions: 0, spendUsd: 0 }) }).deps;
    const base = baseOptions('/r', '/o');
    expect(() => validateOptions({ ...base, conditions: ['jev-on-next'], concurrency: 2 }, deps)).toThrow(/--concurrency must be 1 for jev-on-next/);
    expect(() => validateOptions({ ...base, conditions: ['jev-on-next', 'jev-on-next-nofast'], concurrency: 1 }, deps)).not.toThrow();
    // the older arms are untouched: this must not become a global serialisation
    expect(() => validateOptions({ ...base, conditions: ['llm-jev'], concurrency: 4 }, deps)).not.toThrow();
  });

  it('are NOT yet reachable from the CLI — src/cli/args.ts keeps its own allow-list (the one cross-slot handoff)', () => {
    // src/cli/** is not this slot's to edit. When the two rows are added there, replace this assertion with
    // `expect([...CONDITIONS]).toEqual([...CONDITION_ORDER])` — the gap, not the fix, is what must not be silent.
    expect(CONDITION_ORDER.filter((c) => !(CONDITIONS as readonly string[]).includes(c))).toEqual(['jev-on-next', 'jev-on-next-nofast']);
  });
});

describe('the §5.5 bench bridge', () => {
  // the rows below are the shapes slot C's writer actually produces (`llm-loop-C-fastpath` src/loop/stages/fastpath.ts
  // `declinedRecord` / `firedRecord`): `stage: 1` ONLY on a free decline, `stage: 2` on every row of a round that ran,
  // `decision: 'fired'` ONLY on a proposal, and `decision: 'failed'` with outcome timeout/refused/error otherwise.
  it('folds fastPath, router, riskSource and the S2 verify members out of steps.jsonl', () => {
    const text = [
      step({ fastPath: { decision: 'fired', reason: 'none', stage: 2, outcome: 'proposed', candidatesTested: 12, testRuns: 3, jevRequests: 2, wallMs: 4000, budgetMs: 45_000 }, router: { issued: 3, applied: 2, dropped: 1, waitMs: 0 }, riskSource: 'code', verify: { ttfbMs: [300, 500], hedges: 1, hedgeWins: 1, cacheRead: 100, cacheWrite: 10 } }),
      step({ step: 2, fastPath: { decision: 'declined', reason: 'multi_file', stage: 1, outcome: 'skipped', wallMs: 1, budgetMs: 45_000 }, router: { issued: 2, applied: 2, dropped: 0, waitMs: 7 }, riskSource: 'jev', jevUnavailable: true }),
      step({ step: 3, fastPath: { decision: 'declined', reason: 'no_passer_class', stage: 2, outcome: 'skipped', wallMs: 900, budgetMs: 45_000 } }),
      // a round that ran and blew its own budget: R-b counts it whatever it then decided, and against the budget THAT
      // row carried. A refusal is `decision: 'failed'` — counting overruns on 'fired' alone misses it entirely.
      step({ step: 4, fastPath: { decision: 'failed', reason: 'error', stage: 2, outcome: 'refused', wallMs: 50_000, budgetMs: 45_000, candidatesTested: 1 } }),
      // an engine without the wave: no fastPath key at all
      step({ step: 5, timing: { synthMs: 100 } }),
      '{"torn": ',
    ].join('\n');
    const s = summariseStepRows(text);
    expect(s.steps).toBe(5);
    // stage1Held = the rows that REACHED stage 2 (fired + stage-2 declined + stage-2 failed): what the writer records
    expect(s.fastPath).toMatchObject({ considered: 4, fired: 1, declined: 2, failed: 1, proposed: 1, refused: 1, timeouts: 0, stage1Held: 3, stage2Declined: 1, candidatesTested: 13, testRuns: 3, jevRequests: 2, budgetOverruns: 1 });
    expect(s.fastPath.wallMs).toBe(54_901);
    // the histogram is over INELIGIBLE steps only: the fired row's `none` reason is not a decline
    expect(s.fastPath.reasons).toEqual({ multi_file: 1, no_passer_class: 1, error: 1 });
    expect(s.routers).toEqual({ issued: 5, applied: 4, dropped: 1, maxWaitMs: 7 });
    expect(s.risk).toEqual({ codeVerdicts: 1, jevUnavailable: 1 });
    expect(s.s2).toEqual({ ttfbMs: [300, 500], hedges: 1, hedgeWins: 1, cacheRead: 100, cacheWrite: 10 });

    const merged = mergeStepsSummaries([s, s, emptyStepsSummary()]);
    expect(merged.fastPath.fired).toBe(2);
    expect(merged.fastPath.stage1Held).toBe(6);
    expect(merged.fastPath.reasons).toEqual({ multi_file: 2, no_passer_class: 2, error: 2 });
    // maxWaitMs is a MAX across runs, not a sum: R-a's bar is "no step ever waited"
    expect(merged.routers).toEqual({ issued: 10, applied: 8, dropped: 2, maxWaitMs: 7 });
    expect(merged.s2.ttfbMs).toEqual([300, 500, 300, 500]);
  });

  it('gives a pre-wave run zeros, and an unarmed run considered = 0 (which is not "declined every step")', () => {
    const old = summariseStepRows([step({ timing: { synthMs: 10 } }), step({ step: 2, proposer: 'generic' })].join('\n'));
    expect(old.fastPath).toEqual(emptyStepsSummary().fastPath);
    expect(old.fastPath.considered).toBe(0);
    expect(old.routers.maxWaitMs).toBe(0);
    expect(old.risk).toEqual({ codeVerdicts: 0, jevUnavailable: 0 });
  });
});

/**
 * Every results dir checked in under `bench/results/` carries `synth: { genericSteps, steps, synthMs, synthSteps,
 * verify }` and no `fastPath` / `routers` / `risk` / `s2` key — the four blocks contract 1.9 added. `isRecord`
 * (runner.ts) never validates `synth`, so `--resume` parses one of those rows back, accepts it, and hands it to the
 * end-of-bench summariser AFTER every run has been paid for. The type says the blocks are there; the FILE is the
 * authority.
 */
describe('a tasks.jsonl written before contract 1.9', () => {
  const legacySynth = (): StepsSummary =>
    ({
      steps: 3,
      synthSteps: 2,
      synthMs: 500,
      genericSteps: 1,
      verify: { samples: 4, distinct: 3, malformed: 0, timeouts: 0, cancelled: 0, misanchored: 0, candidatesTested: 9, passers: 1, partials: 0, graceMs: 0, localisationMissed: 0 },
    }) as unknown as StepsSummary;

  it('merges without throwing: the missing wave blocks read as zeros, the older members still count', () => {
    const fresh = summariseStepRows(step({ fastPath: { decision: 'fired', reason: 'none', stage: 2, outcome: 'proposed', wallMs: 10, budgetMs: 45_000 }, router: { issued: 1, applied: 1, dropped: 0, waitMs: 0 } }));
    const merged = mergeStepsSummaries([legacySynth(), fresh]);
    expect(merged.steps).toBe(4);
    expect(merged.verify.candidatesTested).toBe(9);
    expect(merged.fastPath.considered).toBe(1);
    expect(merged.routers).toEqual({ issued: 1, applied: 1, dropped: 0, maxWaitMs: 0 });
    // normalising a legacy part is the identity on the older members and empty on the new ones
    expect(withWaveMembers(legacySynth())).toEqual({ ...emptyStepsSummary(), steps: 3, synthSteps: 2, synthMs: 500, genericSteps: 1, verify: { ...emptyStepsSummary().verify, samples: 4, distinct: 3, candidatesTested: 9, passers: 1 } });
  });

  it('survives the end-of-bench summary and every --resume: computeSuiteMetrics folds it', () => {
    const records = [
      { ...rec('a', 'llm-jev'), synth: legacySynth() },
      { ...rec('b', 'llm-jev'), synth: legacySynth() },
    ];
    const metrics = computeSuiteMetrics(records, 'quixbugs', ['llm-jev'], 20);
    const synth = metrics.perCondition['llm-jev']!.synth;
    expect(synth.verify.candidatesTested).toBe(18);
    expect(synth.fastPath).toEqual(emptyStepsSummary().fastPath);
    expect(synth.s2.ttfbMs).toEqual([]);
  });
});

describe('the §8.3 rows', () => {
  const withSynth = (task: string, condition: BenchCondition, steps: string[], over: Partial<BenchRecord> = {}): BenchRecord => ({ ...rec(task, condition, over), synth: summariseStepRows(steps.join('\n')) });

  it('pass on a clean arm and name the failure on a dirty one', () => {
    const clean = [
      withSynth('a', 'jev-on-next', [step({ fastPath: { decision: 'fired', reason: 'none', stage: 2, outcome: 'proposed', wallMs: 100, budgetMs: 45_000 }, router: { issued: 2, applied: 2, dropped: 0, waitMs: 0 } })]),
      // a STRUCTURAL decline (stage 1) is the cheap, expected shape: it costs nothing and does not count against R-c
      withSynth('b', 'jev-on-next', [step({ fastPath: { decision: 'declined', reason: 'multi_file', stage: 1, outcome: 'skipped', wallMs: 1, budgetMs: 45_000 }, router: { issued: 1, applied: 1, dropped: 0, waitMs: 0 } })]),
    ];
    const rows = measurementRows(clean, 'jev-on-next', ['quixbugs']);
    expect(rows.map((r) => [r.id, r.status])).toEqual([['R-a', 'pass'], ['R-b', 'pass'], ['R-c', 'pass'], ['R-d', 'pass'], ['R-e', 'reported']]);

    const dirty = [
      withSynth('a', 'jev-on-next', [step({ fastPath: { decision: 'fired', reason: 'none', stage: 2, outcome: 'proposed', wallMs: 60_000, budgetMs: 45_000 }, router: { issued: 1, applied: 0, dropped: 1, waitMs: 120 } })]),
      // two stage-2 declines against one stage-1 fire = 2.0, far over the 0.3 bar: the PREDICATE is wrong
      withSynth('b', 'jev-on-next', [step({ fastPath: { decision: 'declined', reason: 'error', stage: 2, outcome: 'error', wallMs: 1, budgetMs: 1 } }), step({ step: 2, fastPath: { decision: 'declined', reason: 'error', stage: 2, outcome: 'error', wallMs: 1, budgetMs: 1 } })]),
    ];
    const bad = measurementRows(dirty, 'jev-on-next', ['quixbugs']);
    expect(bad.map((r) => [r.id, r.status])).toEqual([['R-a', 'fail'], ['R-b', 'fail'], ['R-c', 'fail'], ['R-d', 'fail'], ['R-e', 'reported']]);
    expect(bad[2]!.detail).toContain('the predicate is wrong, not the budget');
    // 2 stage-2 declines out of 3 rounds that ran
    expect(bad[2]!.detail).toContain('quixbugs 2/3 = 0.67');
    // R-d names the clause, which is the whole reason it exists beside R-c
    expect(bad[3]!.detail).toContain('error 2 (100.0 %)');
  });

  it('R-c is FAILABLE on the shape the writer produces (no row is ever `stage: 1, decision: fired`)', () => {
    // one round proposed, three rounds ran and were thrown out by the stage that costs real work: 3/4 = 0.75, far
    // over the 0.3 bar. With a stage-1-FIRED denominator this arm read `pass | quixbugs 3/0 = n/a` — the row could
    // not fail on any run slot C's writer can produce, which is the same as not having the row.
    const records = [
      withSynth('a', 'jev-on-next', [step({ fastPath: { decision: 'fired', reason: 'none', stage: 2, outcome: 'proposed', wallMs: 100, budgetMs: 45_000 } })]),
      withSynth('b', 'jev-on-next', [
        step({ fastPath: { decision: 'declined', reason: 'no_sites', stage: 2, outcome: 'skipped', wallMs: 100, budgetMs: 45_000 } }),
        step({ step: 2, fastPath: { decision: 'declined', reason: 'no_sites', stage: 2, outcome: 'skipped', wallMs: 100, budgetMs: 45_000 } }),
        step({ step: 3, fastPath: { decision: 'declined', reason: 'no_sites', stage: 2, outcome: 'skipped', wallMs: 100, budgetMs: 45_000 } }),
      ]),
    ];
    const rc = measurementRows(records, 'jev-on-next', ['quixbugs']).find((r) => r.id === 'R-c')!;
    expect(rc.status).toBe('fail');
    expect(rc.detail).toContain('quixbugs 3/4 = 0.75');
  });

  it('R-b sees a round that blew its budget and then timed out — those rows are `failed`, not `fired`', () => {
    // every round over the 45 s budget and killed by it: `fired` is 0, so a fired-only R-b read "no step fired" while
    // the arm spent past its share on every step.
    const records = [
      withSynth('a', 'jev-on-next', [
        step({ fastPath: { decision: 'failed', reason: 'error', stage: 2, outcome: 'timeout', wallMs: 60_000, budgetMs: 45_000 } }),
        step({ step: 2, fastPath: { decision: 'failed', reason: 'error', stage: 2, outcome: 'timeout', wallMs: 58_000, budgetMs: 45_000 } }),
      ]),
    ];
    const rb = measurementRows(records, 'jev-on-next', ['quixbugs']).find((r) => r.id === 'R-b')!;
    expect(rb.status).toBe('fail');
    expect(rb.detail).toContain('0/2 within budget');
  });

  it('reads "not evaluable", never "pass", when the arm was never armed', () => {
    const rows = measurementRows([withSynth('a', 'jev-on-next', [step({ timing: { synthMs: 5 } })])], 'jev-on-next', ['quixbugs']);
    expect(rows.filter((r) => r.gating).every((r) => r.status === 'not_evaluable')).toBe(true);
  });

  it('flags a reason that is not in FastPathReason rather than dropping it', () => {
    const rows = measurementRows([{ ...rec('a', 'jev-on-next'), synth: summariseStepRows(step({ fastPath: { decision: 'declined', reason: 'invented_clause', stage: 1, outcome: 'skipped', wallMs: 1, budgetMs: 1 } })) }], 'jev-on-next', ['quixbugs']);
    expect(rows.find((r) => r.id === 'R-d')).toMatchObject({ status: 'fail' });
    expect(rows.find((r) => r.id === 'R-d')!.detail).toContain('NOT in FastPathReason: invented_clause');
    expect(FASTPATH_REASONS).toContain('scope_unusable');
    expect(FASTPATH_REASONS).toHaveLength(26);
  });
});

describe('the §8.4 predictions and the §8.5 accept rule', () => {
  const recordedFresh = recorded('fresh-18', 'llm-jev');

  it('reads the recorded iteration-1 rows as the reference, at the build they were taken on', () => {
    expect(recordedFresh).toMatchObject({ solved: 12, n: 18, bothSolvedMedianWallMs: 26_000 });
    expect(recorded('fresh-18', 'jev-off-tuned')).toMatchObject({ solved: 9, n: 18, bothSolvedMedianWallMs: 19_700 });
    expect(recorded('in-sample-28', 'llm-jev')).toMatchObject({ solved: 27, n: 28 });
    expect(RECORDED_BUILD).toBe('751e3bf');
  });

  it('(a) is pinned to the fresh-18 TASK IDS, not to a count of 18 records', () => {
    expect(FRESH_18).toHaveLength(18);
    expect(FRESH_18.filter((t) => t.suite === 'quixbugs')).toHaveLength(8);
    expect(FRESH_18.filter((t) => t.suite === 'ladder')).toHaveLength(6);
    expect(FRESH_18.filter((t) => t.suite === 'swebench')).toHaveLength(4);

    // eighteen evaluated records that are NOT the recorded slice: a bare count read them as the fresh 18 and
    // compared 18 solves against 12/18, which is not a comparison at all
    const wrong = Array.from({ length: 18 }, (_, i) => rec(`t${i}`, 'jev-on-next'));
    const a = evaluatePredictions({ records: wrong, arm: 'jev-on-next', control: 'jev-on-next-nofast' }).find((p) => p.id === 'a')!;
    expect(a.status).toBe('not_evaluable');
    expect(a.detail).toContain('NOT the recorded slice');
    expect(a.detail).toContain('must not retire route R9');

    // the recorded ids, at their own suites, are the slice
    const right = FRESH_18.map((t) => rec(t.task, 'jev-on-next', { suite: t.suite }));
    expect(evaluatePredictions({ records: right, arm: 'jev-on-next', control: 'jev-on-next-nofast' }).find((p) => p.id === 'a')).toMatchObject({ status: 'pass' });

    // one task swapped for another is not the slice either, however the count comes out
    const swapped = [...right.slice(0, 17), rec('extra_task', 'jev-on-next', { suite: 'quixbugs' })];
    expect(evaluatePredictions({ records: swapped, arm: 'jev-on-next', control: 'jev-on-next-nofast' }).find((p) => p.id === 'a')).toMatchObject({ status: 'not_evaluable' });
  });

  it('does not accept a wave whose control is missing, even when every row passes', () => {
    const records = Array.from({ length: 18 }, (_, i) => ({ ...rec(`t${i}`, 'jev-on-next'), synth: summariseStepRows(step({ fastPath: { decision: 'fired', reason: 'none', stage: 2, outcome: 'proposed', wallMs: 10, budgetMs: 45_000 }, router: { issued: 1, applied: 1, dropped: 0, waitMs: 0 } })) }));
    const rows = measurementRows(records, 'jev-on-next', ['quixbugs']);
    const slice = records.map((r) => ({ suite: r.suite, task: r.task }));
    const predictions = evaluatePredictions({ records, arm: 'jev-on-next', control: 'jev-on-next-nofast', slice });
    expect(predictions.find((p) => p.id === 'a')).toMatchObject({ status: 'pass' });
    expect(predictions.find((p) => p.id === 'f')).toMatchObject({ status: 'not_evaluable' });
    // a partial slice is not a failure of (a): a count against 12/18 needs the 18
    const partial = evaluatePredictions({ records: records.slice(0, 5), arm: 'jev-on-next', control: 'jev-on-next-nofast', slice });
    expect(partial.find((p) => p.id === 'a')).toMatchObject({ status: 'not_evaluable' });
    expect(partial.find((p) => p.id === 'a')!.detail).toContain('must not retire route R9');
    expect(predictions.find((p) => p.id === 'f')!.detail).toContain('confounds tuned generation');
    const verdict = evaluateAcceptRule({ records, arm: 'jev-on-next', control: 'jev-on-next-nofast', rows, predictions, gatesGreen: true });
    expect(verdict.accept).toBe(false);
    expect(verdict.clauses.find((c) => c.n === 4)).toMatchObject({ status: 'not_evaluable' });
  });

  it('does not accept on an unreported gate run either (clause 1 is a tree fact, and silence is not green)', () => {
    const records = [rec('t', 'jev-on-next'), rec('t', 'jev-on-next-nofast', { pass: false })];
    const rows = measurementRows(records, 'jev-on-next', ['quixbugs']);
    const predictions = evaluatePredictions({ records, arm: 'jev-on-next', control: 'jev-on-next-nofast' });
    const verdict = evaluateAcceptRule({ records, arm: 'jev-on-next', control: 'jev-on-next-nofast', rows, predictions, gatesGreen: null });
    expect(verdict.clauses.find((c) => c.n === 1)).toMatchObject({ status: 'not_evaluable' });
    expect(verdict.accept).toBe(false);
  });

  it('(f) attributes the win to the fast path by the paired control, and (b) is judged on the both-solved tasks', () => {
    const records = [
      ...Array.from({ length: 18 }, (_, i) => rec(`t${i}`, 'jev-on-next', { wallMs: 18_000 })),
      ...Array.from({ length: 10 }, (_, i) => rec(`t${i}`, 'jev-on-next-nofast')),
      ...Array.from({ length: 18 }, (_, i) => rec(`t${i}`, 'jev-off-tuned', { wallMs: 19_000 })),
    ];
    const predictions = evaluatePredictions({ records, arm: 'jev-on-next', control: 'jev-on-next-nofast', ladderLong2: ['t0', 't1', 't2', 't3', 't4', 't5'] });
    expect(predictions.find((p) => p.id === 'f')).toMatchObject({ status: 'pass' });
    // 18.0 s: under llm-jev's recorded 26.0 s and within 10 % of tuned's 19.7 s
    expect(predictions.find((p) => p.id === 'b')).toMatchObject({ status: 'pass' });
    expect(predictions.find((p) => p.id === 'c')).toMatchObject({ status: 'pass' });
    // the same arm 12 s slower fails (b) without touching (a): the 2× regression shape §8.4 calls the first risk
    const slow = records.map((r) => (r.condition === 'jev-on-next' ? { ...r, wallMs: 40_000 } : r));
    expect(evaluatePredictions({ records: slow, arm: 'jev-on-next', control: 'jev-on-next-nofast' }).find((p) => p.id === 'b')).toMatchObject({ status: 'fail' });
  });

  it('(e) is evaluable on the writer\'s shape and counts only the QuixBugs steps its title claims', () => {
    const fired = (outcome: string): string => step({ fastPath: { decision: outcome === 'proposed' ? 'fired' : 'failed', reason: outcome === 'proposed' ? 'none' : 'error', stage: 2, outcome, wallMs: 100, budgetMs: 45_000 } });
    const withSteps = (task: string, suite: BenchRecord['suite'], steps: string[]): BenchRecord => ({ ...rec(task, 'jev-on-next', { suite }), synth: summariseStepRows(steps.join('\n')) });
    const records = [
      withSteps('q1', 'quixbugs', [fired('proposed'), fired('proposed')]),
      withSteps('q2', 'quixbugs', [fired('refused')]),
      // SWE steps are NOT in (e)'s denominator: the prediction is about the QuixBugs steps where stage 1 held
      withSteps('s1', 'swebench', [fired('refused'), fired('refused'), fired('refused'), fired('refused')]),
    ];
    const e = evaluatePredictions({ records, arm: 'jev-on-next', control: 'jev-on-next-nofast' }).find((p) => p.id === 'e')!;
    expect(e.status).toBe('pass');
    expect(e.detail).toContain('2/3');
  });

  it('does NOT launder a missing control into a pass, even when (a)/(e) already retire R9', () => {
    // the shape the escape was written for is "(f) ran and lost"; this is "(f) never ran". 18 solved arm records,
    // 18 paired tuned records, no control record at all, and (e) failing on refusals: clause 4 used to take the
    // `retireR9 ? 'pass'` branch before it ever asked whether (f) was evaluable, and the wave read ACCEPT with no
    // same-build contrast in the table.
    const refused = step({ fastPath: { decision: 'failed', reason: 'error', stage: 2, outcome: 'refused', wallMs: 10, budgetMs: 45_000 }, router: { issued: 1, applied: 1, dropped: 0, waitMs: 0 } });
    const records = [
      ...Array.from({ length: 18 }, (_, i) => ({ ...rec(`t${i}`, 'jev-on-next'), synth: summariseStepRows(refused) })),
      ...Array.from({ length: 18 }, (_, i) => rec(`t${i}`, 'jev-off-tuned', { wallMs: 19_000 })),
    ];
    const rows = measurementRows(records, 'jev-on-next', ['quixbugs']);
    const slice = records.filter((r) => r.condition === 'jev-on-next').map((r) => ({ suite: r.suite, task: r.task }));
    const predictions = evaluatePredictions({ records, arm: 'jev-on-next', control: 'jev-on-next-nofast', slice });
    expect(predictions.find((p) => p.id === 'a')).toMatchObject({ status: 'pass' });
    expect(predictions.find((p) => p.id === 'e')).toMatchObject({ status: 'fail' });
    expect(predictions.find((p) => p.id === 'f')).toMatchObject({ status: 'not_evaluable' });
    const verdict = evaluateAcceptRule({ records, arm: 'jev-on-next', control: 'jev-on-next-nofast', rows, predictions, gatesGreen: true });
    expect(verdict.retireR9).toBe(true);
    expect(verdict.clauses.find((c) => c.n === 4)).toMatchObject({ status: 'not_evaluable' });
    expect(verdict.accept).toBe(false);
  });

  it('clause 5 is titled as what it does — R-e is reported, not checked', () => {
    const records = [rec('t', 'jev-on-next'), rec('t', 'jev-on-next-nofast', { pass: false })];
    const rows = measurementRows(records, 'jev-on-next', ['quixbugs']);
    const predictions = evaluatePredictions({ records, arm: 'jev-on-next', control: 'jev-on-next-nofast' });
    const clause5 = evaluateAcceptRule({ records, arm: 'jev-on-next', control: 'jev-on-next-nofast', rows, predictions, gatesGreen: true }).clauses.find((c) => c.n === 5)!;
    // the old title ("R-e shows no allowed harmful command") claimed a machine check the clause does not make: it
    // reads 'reported' for any R-e row whatever `risk.codeVerdicts` / `risk.jevUnavailable` say
    expect(clause5.status).toBe('reported');
    expect(clause5.title).toContain('reported for the §2.4 judgement');
    expect(clause5.title).not.toContain('shows no allowed harmful command');
  });

  it('retires route R9 when (a) or (e) fails, and lets clause 4 pass on that branch', () => {
    const records = [
      ...Array.from({ length: 18 }, (_, i) => ({ ...rec(`t${i}`, 'jev-on-next', { pass: false }), synth: summariseStepRows(step({ fastPath: { decision: 'failed', reason: 'error', stage: 2, outcome: 'refused', wallMs: 10, budgetMs: 45_000 } })) })),
      rec('t0', 'jev-on-next-nofast'),
    ];
    const rows = measurementRows(records, 'jev-on-next', ['quixbugs']);
    const slice = records.filter((r) => r.condition === 'jev-on-next').map((r) => ({ suite: r.suite, task: r.task }));
    const predictions = evaluatePredictions({ records, arm: 'jev-on-next', control: 'jev-on-next-nofast', slice });
    expect(predictions.find((p) => p.id === 'a')).toMatchObject({ status: 'fail', retiresR9: true });
    expect(predictions.find((p) => p.id === 'e')).toMatchObject({ status: 'fail', retiresR9: true });
    const verdict = evaluateAcceptRule({ records, arm: 'jev-on-next', control: 'jev-on-next-nofast', rows, predictions, gatesGreen: true });
    expect(verdict.retireR9).toBe(true);
    expect(verdict.clauses.find((c) => c.n === 4)!.detail).toContain('ship S2 + routers');
    // …and the wave still does not accept, because clause 3 carries (a)
    expect(verdict.accept).toBe(false);
  });
});
