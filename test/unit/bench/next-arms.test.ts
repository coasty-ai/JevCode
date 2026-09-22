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
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONDITIONS } from '../../../src/cli/args.js';
import { resolveFastPathOption } from '../../../src/loop/engine.js';
import { s2Mode } from '../../../src/synth/llm/hedge.js';
import { CONDITION_ORDER, MECHANISM_ENV_VARS, armMechanisms, buildEngineOptions, conditionConfig, engineModeOf, isNextArm, parseConditions, pinMechanismEnv, pinnedGeneration, requiresSerialBench, usesSynthesizer, usesTunedProvider } from '../../../src/bench/conditions.js';
import { computeSuiteMetrics } from '../../../src/bench/metrics.js';
import { evaluateAcceptRule, evaluatePredictions, FASTPATH_REASONS, FRESH_18, measurementRows, observedArmS2, recorded, RECORDED_BUILD } from '../../../src/bench/next-arms.js';
import { buildRecord, runBenchWithSources, validateOptions } from '../../../src/bench/runner.js';
import { STEPS_FILE, emptyStepsSummary, mergeStepsSummaries, summariseStepRows, withWaveMembers } from '../../../src/bench/step-records.js';
import type { BenchRecord, StepsSummary } from '../../../src/bench/types.js';
import type { BenchCondition } from '../../../src/core/types.js';
import { baseOptions, createFakeDeps, fakeRunResult, syntheticSource, tempDir } from './helpers.js';

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
    }
    // F05: the arms ARE the tuned object. The S2 block used to ride on them and named mechanisms `jev-on` cannot
    // reach; the block returns with F17 (docs/LLM-LOOP-DESIGN.md §9.1), on whatever arm can actually run it.
    expect(pinnedGeneration('jev-on-next', 'm')).toEqual(pinnedGeneration('jev-off-tuned', 'm'));
    expect(pinnedGeneration('jev-on-next', 'm').s2).toBeUndefined();
    // ONE mechanism apart — that is what makes the pair a contrast
    expect(armMechanisms('jev-on-next')).toEqual({ fastPath: 'auto', routers: true, s2: 'off' });
    expect(armMechanisms('jev-on-next-nofast')).toEqual({ fastPath: 'off', routers: true, s2: 'off' });
    for (const older of ['jev-on', 'jev-off', 'jev-only', 'llm-jev', 'llm-sieve', 'jev-off-tuned'] as const) {
      expect(armMechanisms(older)).toEqual({ fastPath: 'off', routers: false, s2: 'off' });
    }
    expect(parseConditions('jev-on-next,jev-on-next-nofast')).toEqual(['jev-on-next', 'jev-on-next-nofast']);
  });

  // NB this asserts what buildEngineOptions RETURNS. The engine resolves both mechanisms env-first, so the option
  // below is only the effective one because the runner clears the two switches — the test after next.
  it('write their mechanisms into EngineOptions and summary.json from the arm\'s own row', () => {
    const opts = baseOptions('/r', '/o');
    const input = { task: 't', workspace: '/w', provider: { model: 'm' }, decider: {}, meter: {} } as unknown as Parameters<typeof buildEngineOptions>[0];
    const prev = process.env['JEVCODE_FASTPATH'];
    process.env['JEVCODE_FASTPATH'] = 'auto';
    try {
      // the env says 'auto' for every arm; the arm's own row is what lands
      expect(buildEngineOptions({ ...input, condition: 'jev-on' }, opts)).toMatchObject({ mode: 'jev-on', fastPath: 'off', routers: 'off', s2: 'off' });
      expect(buildEngineOptions({ ...input, condition: 'jev-on-next' }, opts)).toMatchObject({ mode: 'jev-on', fastPath: 'auto', routers: 'on', s2: 'on' });
      expect(buildEngineOptions({ ...input, condition: 'jev-on-next-nofast' }, opts)).toMatchObject({ mode: 'jev-on', fastPath: 'off', routers: 'on', s2: 'on' });
    } finally {
      if (prev === undefined) delete process.env['JEVCODE_FASTPATH'];
      else process.env['JEVCODE_FASTPATH'] = prev;
    }
    expect(conditionConfig('jev-on-next', opts, 'm').mechanisms).toEqual({ fastPath: 'auto', routers: true, s2: 'off' });
    expect(conditionConfig('llm-jev', opts, 'm').mechanisms).toEqual({ fastPath: 'off', routers: false, s2: 'off' });
  });

  /**
   * The arm's row in summary.json is only the truth if nothing beats it at resolution time. When this slot landed
   * both mechanisms were resolved from the environment FIRST: `resolveFastPathOption` read `JEVCODE_FASTPATH`
   * before the option in BOTH directions and `routersOn` ORed `JEVCODE_ROUTERS=on` in, so an exported
   * `JEVCODE_FASTPATH=off` ran `jev-on-next` disarmed while recording `'auto'` and `=auto` ran the
   * `jev-on-next-nofast` CONTROL armed while recording `'off'` — destroying the one-mechanism contrast clause 4
   * rests on, unobservably. **Both resolvers were inverted by the §7.5 engine seam** (slot B's post-C commit):
   * the explicit option now wins and the env only fills an absent one. `pinMechanismEnv` stays, as the belt that
   * makes an arm's row true for a worker that pins nothing, and the assertions below now drive the real
   * resolver's new polarity.
   */
  it('clears the mechanism env switches, and the PINNED option beats an env that survives anyway', () => {
    expect([...MECHANISM_ENV_VARS]).toEqual(['JEVCODE_FASTPATH', 'JEVCODE_ROUTERS', 'JEVCODE_S2', 'JEVCODE_HEDGE']);
    const env: Record<string, string | undefined> = { JEVCODE_FASTPATH: 'auto', JEVCODE_ROUTERS: 'on', JEVCODE_S2: 'on', JEVCODE_HEDGE: 'off', JEVCODE_WARM: 'off' };
    expect(pinMechanismEnv(env)).toEqual([
      { name: 'JEVCODE_FASTPATH', was: 'auto' },
      { name: 'JEVCODE_ROUTERS', was: 'on' },
      { name: 'JEVCODE_S2', was: 'on' },
      { name: 'JEVCODE_HEDGE', was: 'off' },
    ]);
    expect('JEVCODE_FASTPATH' in env).toBe(false);
    expect('JEVCODE_ROUTERS' in env).toBe(false);
    expect('JEVCODE_S2' in env).toBe(false);
    expect('JEVCODE_HEDGE' in env).toBe(false);
    // only these two: JEVCODE_WARM is the documented escape every arm of the recorded runs was taken under
    expect(env['JEVCODE_WARM']).toBe('off');
    expect(pinMechanismEnv(env)).toEqual([]);

    // the REAL resolver, after the §7.5 seam inverted it: the arm's pinned value stands whether or not the
    // environment was cleared, and it still stands once it has been
    const saved = process.env['JEVCODE_FASTPATH'];
    try {
      for (const pinned of ['auto', 'off'] as const) {
        const opposite = pinned === 'auto' ? 'off' : 'auto';
        process.env['JEVCODE_FASTPATH'] = opposite;
        expect(resolveFastPathOption('jev-on', pinned)).toBe(pinned);
        pinMechanismEnv();
        expect(resolveFastPathOption('jev-on', pinned)).toBe(pinned);
        // an arm that pins NOTHING is still the environment's to set — which is why `pinMechanismEnv` stays
        process.env['JEVCODE_FASTPATH'] = 'off';
        expect(resolveFastPathOption('jev-on', undefined)).toBe('off');
        pinMechanismEnv();
        expect(resolveFastPathOption('jev-on', undefined)).toBe('auto');
      }
    } finally {
      if (saved === undefined) delete process.env['JEVCODE_FASTPATH'];
      else process.env['JEVCODE_FASTPATH'] = saved;
    }
  });

  /**
   * F25's HEADLINE claim, and review defect **A5**. Every S2 mechanism was built and reachable, but behind
   * `JEVCODE_S2=on`, which nothing in `src/bench` set: `armMechanisms('jev-on-next')` returned `s2: true` while
   * `buildEngineOptions` wrote no `s2` option, so the arm ran with S2 OFF and its `summary.json` said `true`.
   * The converse half was live contamination: `JEVCODE_S2` was in nobody's `MECHANISM_ENV_VARS`, so an exported
   * `JEVCODE_S2=on` armed the whole generation path on the plain `jev-on` CONTROL arm and on
   * `jev-on-next-nofast` while both rows recorded `s2: false`.
   *
   * The pin is end to end: the arm's row, the option it writes, and what the ENGINE's own resolver makes of that
   * option against a hostile environment.
   */
  it("jev-on-next really runs S2 and jev-on really does not, whatever JEVCODE_S2 says (F25 headline / A5)", () => {
    const opts = baseOptions('/r', '/o');
    const input = { task: 't', workspace: '/w', provider: { model: 'm' }, decider: {}, meter: {} } as unknown as Parameters<typeof buildEngineOptions>[0];
    const saved = process.env['JEVCODE_S2'];
    try {
      for (const hostile of ['on', 'off'] as const) {
        process.env['JEVCODE_S2'] = hostile;
        for (const arm of CONDITION_ORDER) {
          const built = buildEngineOptions({ ...input, condition: arm }, opts);
          const want = armMechanisms(arm).s2;
          expect(built.s2).toBe(want ? 'on' : 'off');
          // the engine's own resolver, with the hostile env still set: the arm's row is what runs
          expect(s2Mode(engineModeOf(arm), built.s2) !== 'off').toBe(want && engineModeOf(arm) === 'jev-on');
        }
      }
    } finally {
      if (saved === undefined) delete process.env['JEVCODE_S2'];
      else process.env['JEVCODE_S2'] = saved;
    }
  });

  it('the runner clears them before any engine is built, and says so', async () => {
    const t = await tempDir();
    try {
      const prev = process.env['JEVCODE_FASTPATH'];
      process.env['JEVCODE_FASTPATH'] = 'auto';
      const lines: string[] = [];
      const { deps } = createFakeDeps({ script: () => ({ result: { steps: 1, tokensPerStep: [10], generatorTokensPerStep: [10], jevTokensPerStep: [0], jevLatencyMs: [], counters: { blocked: 0, reviews: 0, declined: 0, failed: 0, loops: 0, replans: 0, reads: 0 } }, decisions: 0, spendUsd: 0 }) });
      const opts = baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { conditions: ['jev-on'], concurrency: 1, log: (l) => lines.push(l) });
      try {
        await runBenchWithSources([syntheticSource({ id: 'a' })], opts, deps);
        expect(process.env['JEVCODE_FASTPATH']).toBeUndefined();
        expect(lines.some((l) => l.includes('JEVCODE_FASTPATH=auto'))).toBe(true);
      } finally {
        if (prev === undefined) delete process.env['JEVCODE_FASTPATH'];
        else process.env['JEVCODE_FASTPATH'] = prev;
      }
    } finally {
      await t.cleanup();
    }
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

  it('are reachable from the CLI — src/cli/args.ts CONDITIONS equals CONDITION_ORDER (the cross-slot handoff landed with the flag rows)', () => {
    expect([...CONDITIONS]).toEqual([...CONDITION_ORDER]);
  });
});

/**
 * F05 — the record must not describe a run that did not happen.
 *
 * `armMechanisms` pinned `s2: true` for both next arms and `pinnedGeneration` pinned the whole
 * `S2_GENERATION` block on them, so summary.json said the §3 generation path was live. It was not, and
 * nothing read the flag: `conditionConfig` applies `mech.fastPath` and `mech.routers` and `mech.s2` had
 * no reader anywhere in src. Both arms run `engineModeOf === 'jev-on'`, and in `jev-on` no S2 mechanism
 * is reachable — nothing sets `PromptInput.prefixOrder`, `onFirstByte` is forwarded only on the
 * synthesizer sample path, and hedging plus the §3.4 reasoning cap live in `src/synth/llm/source.ts`,
 * which `jev-on` never enters. The head-to-head is measured from that file days later.
 *
 * Two rules, and the second is what keeps the first from rotting:
 *
 *   1. a PINNED `s2` other than `'off'` requires `engineModeOf(condition) === 'llm-jev'`; and
 *   2. what summary.json records is the OBSERVED value when the run reported one — never a constant —
 *      so slot A (F25) wiring S2 onto the `jev-on` path cannot make the record disagree with the run in
 *      the other direction either.
 */
describe('§8.1 the recorded mechanisms are the mechanisms that ran (F05)', () => {
  const opts = baseOptions('/r', '/o');

  it('a pinned s2 implies the arm is on the llm-jev sample path, for every condition', () => {
    for (const c of CONDITION_ORDER) {
      const m = armMechanisms(c);
      if (m.s2 !== 'off') expect(engineModeOf(c)).toBe('llm-jev');
      // and the two arms whose row claimed it are `jev-on`, so they claim it no longer
      expect(conditionConfig(c, opts, 'm').mechanisms.s2).toBe(m.s2);
    }
    expect(armMechanisms('jev-on-next')).toEqual({ fastPath: 'auto', routers: true, s2: 'off' });
    expect(armMechanisms('jev-on-next-nofast')).toEqual({ fastPath: 'off', routers: true, s2: 'off' });
  });

  it('no arm pins the S2 generation block either — the next arms ARE the tuned object', () => {
    for (const arm of ['jev-on-next', 'jev-on-next-nofast'] as const) {
      expect(pinnedGeneration(arm, 'm').s2).toBeUndefined();
      expect(pinnedGeneration(arm, 'm')).toEqual(pinnedGeneration('jev-off-tuned', 'm'));
    }
  });

  it('summary.json records the OBSERVED value when the run reported one, and NOTHING when it reported none (B4)', () => {
    // absent -> null, never 'off': "no run reported the member" and "the run reported that S2 was off" are
    // different facts, and only the second may overwrite an arm's pin. The reader this argument was written for
    // returned 'off' for both, so `armMechanisms(c, observed)` would have overwritten a pinned 'on' with a
    // measurement nobody made — and it had no caller in src at all, so summary.json kept the constant.
    const arm = (...rows: string[]): BenchRecord[] => [{ ...rec('t', 'jev-on-next'), synth: summariseStepRows(rows.join('\n')) }];
    const m = (s2: unknown): string => step({ mechanisms: { s2 } });
    expect(observedArmS2([], 'jev-on-next')).toBeNull();
    expect(observedArmS2(arm(step({ step: 1 }), step({ step: 2, mechanisms: {} })), 'jev-on-next')).toBeNull();
    expect(observedArmS2(arm(m('on'), m('on')), 'jev-on-next')).toBe('on');
    // some steps ran it and some did not: that is 'partial', never rounded up to 'on'
    expect(observedArmS2(arm(m('on'), m('off')), 'jev-on-next')).toBe('partial');
    expect(observedArmS2(arm(m('partial')), 'jev-on-next')).toBe('partial');
    // a value the union does not know is not a measurement
    expect(observedArmS2(arm(m('yes')), 'jev-on-next')).toBeNull();
    // a measured 'off' IS a measurement and does overwrite
    expect(observedArmS2(arm(m('off')), 'jev-on-next')).toBe('off');
    // …and it is the ARM's own records that are read: another arm's steps are not this arm's observation
    expect(observedArmS2(arm(m('on')), 'jev-on-next-nofast')).toBeNull();
    // the observation WINS over the arm's row, in both directions: the record follows the run
    expect(armMechanisms('jev-on-next', 'on').s2).toBe('on');
    // …while an ABSENT observation leaves the pin (and its clamp) exactly where it was
    expect(armMechanisms('jev-on-next', null).s2).toBe('off');
    expect(conditionConfig('jev-on-next', opts, 'm', { s2: 'partial' }).mechanisms.s2).toBe('partial');
    expect(conditionConfig('jev-on-next', opts, 'm', { s2: null }).mechanisms.s2).toBe('off');
    expect(conditionConfig('jev-on-next', opts, 'm').mechanisms.s2).toBe('off');
  });

  it('the measurement table carries an S2 row that says why it cannot be evaluated', () => {
    const rows = measurementRows([], 'jev-on-next', ['quixbugs']);
    const s2 = rows.find((r) => r.id === 'R-s2');
    expect(s2).toBeDefined();
    expect(s2!.status).toBe('not_evaluable');
    expect(s2!.detail).toBe("S2 lives on the llm-jev sample path; this arm's mode is jev-on");
    // it reports, it does not gate: §8.5's clauses are unchanged by it
    expect(s2!.gating).toBe(false);
    const rule = evaluateAcceptRule({ records: [], arm: 'jev-on-next', control: 'jev-on-next-nofast', rows, predictions: [], gatesGreen: true });
    expect(rule.clauses.map((c) => c.n)).toEqual([1, 2, 3, 4, 5]);
  });

  // B6: `measurementRows` takes any `BenchCondition`, and every condition now clamps to `s2: 'off'`, so the
  // hard-coded mode in the row's reason made the row self-contradictory on every arm but the two it was written
  // for: "this arm's mode is jev-on" printed under `measurementRows(records, 'llm-jev', …)`.
  it("the S2 row names the arm's OWN mode, not the mode the row was written for", () => {
    const detailOf = (c: BenchCondition): string => measurementRows([], c, ['quixbugs']).find((r) => r.id === 'R-s2')!.detail;
    expect(detailOf('llm-jev')).toBe("S2 lives on the llm-jev sample path; this arm's mode is llm-jev");
    expect(detailOf('llm-sieve')).toBe("S2 lives on the llm-jev sample path; this arm's mode is llm-jev");
    expect(detailOf('jev-off-tuned')).toBe("S2 lives on the llm-jev sample path; this arm's mode is jev-off");
    for (const c of CONDITION_ORDER) expect(detailOf(c)).toContain(`this arm's mode is ${engineModeOf(c)}`);
  });
});

/**
 * F05's second half, B4 — the OBSERVED value must actually be observed.
 *
 * `observedS2` was written, exported and tested, and then had no caller in `src`: `runner.ts` still built every
 * `ConditionConfig` with `conditionConfig(c, opts, model)` — three arguments — so `mechanisms.s2` in summary.json
 * was the constant the item's owner note forbids ("record it from that runtime value … never from a constant").
 * It is gone: `observedArmS2` replaces it with the reader the runner and the §8.3 table BOTH call, so there is one
 * observation and no second copy to leave unwired.
 * It reads correctly today only because 'off' is also what ran; the moment slot A's F25 writes a runtime
 * `mechanisms.s2: 'on'` onto the step records, summary.json keeps saying 'off' and the §8.3 table keeps saying
 * `not_evaluable` — the same class of defect F05 exists to remove, in the other direction.
 *
 * So the observation travels the way every other steps.jsonl fact travels (§5.5): folded by
 * `src/bench/step-records.ts` onto `StepsSummary.s2.state`, carried by the normaliser and the merge, and read
 * ONCE — by the runner for summary.json and by `measurementRows` for the table, so the two cannot disagree.
 */
describe('§8.1 the observed s2 reaches summary.json and the §8.3 table (F05 second half, B4)', () => {
  const mech = (s2: unknown, over: Record<string, unknown> = {}): string => step({ mechanisms: { s2 }, ...over });

  it('the §5.5 bridge folds mechanisms.s2 out of steps.jsonl, and an absent member stays absent', () => {
    expect(summariseStepRows([mech('on'), mech('on')].join('\n')).s2.state).toBe('on');
    // steps that disagree fold to 'partial': one S2 step must not stand for the arm
    expect(summariseStepRows([mech('on'), mech('off')].join('\n')).s2.state).toBe('partial');
    expect(summariseStepRows([mech('partial')].join('\n')).s2.state).toBe('partial');
    // a build that does not report the member, and a value the union does not know, are both "nothing measured"
    expect(summariseStepRows(step({ timing: { synthMs: 1 } })).s2.state).toBeUndefined();
    expect(summariseStepRows(mech('yes')).s2.state).toBeUndefined();
    expect(emptyStepsSummary().s2.state).toBeUndefined();
  });

  it('the normaliser and the merge carry it, so --resume and an arm-wide fold do not erase the observation', () => {
    // `withWaveMembers` rebuilds the part from `emptyStepsSummary()`: a member it does not name is LOST
    expect(withWaveMembers(summariseStepRows(mech('on'))).s2.state).toBe('on');
    expect(mergeStepsSummaries([summariseStepRows(mech('on')), summariseStepRows(mech('on'))]).s2.state).toBe('on');
    expect(mergeStepsSummaries([summariseStepRows(mech('on')), summariseStepRows(mech('off'))]).s2.state).toBe('partial');
    // a run that reported nothing does not dilute one that did — and does not invent one either
    expect(mergeStepsSummaries([summariseStepRows(mech('on')), emptyStepsSummary()]).s2.state).toBe('on');
    expect(mergeStepsSummaries([emptyStepsSummary(), emptyStepsSummary()]).s2.state).toBeUndefined();
  });

  it('the §8.3 S2 row reads the SAME observation, so the table cannot disagree with summary.json', () => {
    const on = [{ ...rec('t1', 'jev-on-next'), synth: summariseStepRows([mech('on', { verify: { ttfbMs: [100], hedges: 2, hedgeWins: 1, cacheRead: 90, cacheWrite: 0, cacheInput: 100 } })].join('\n')) }];
    expect(observedArmS2(on, 'jev-on-next')).toBe('on');
    const row = measurementRows(on, 'jev-on-next', ['quixbugs']).find((r) => r.id === 'R-s2')!;
    expect(row.status).toBe('reported');
    expect(row.detail).toContain('S2 on');
    expect(row.detail).toContain('90/100');
    // still reported, never gating: an arm that ran a mechanism does not thereby gate the wave on it
    expect(row.gating).toBe(false);
    // and with no observation the row is back to the clamp's reason
    expect(observedArmS2([rec('t1', 'jev-on-next')], 'jev-on-next')).toBeNull();
    expect(measurementRows([rec('t1', 'jev-on-next')], 'jev-on-next', ['quixbugs']).find((r) => r.id === 'R-s2')!.status).toBe('not_evaluable');
  });

  it('summary.json records what the run reported, end to end through the runner', async () => {
    const t = await tempDir();
    const runsDir = join(t.dir, 'runs');
    const rows = [
      { step: 1, proposer: 'generator', mechanisms: { s2: 'on' }, timing: { generatorMs: 1, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 1 } },
      { step: 2, proposer: 'generator', mechanisms: { s2: 'on' }, timing: { generatorMs: 1, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 1 } },
    ];
    const { deps, captured } = createFakeDeps({
      script: () => ({
        result: { steps: 2 },
        spendUsd: 0.01,
        effect: async () => {
          const runId = captured.engines.at(-1)!.runId;
          await writeFile(join(runsDir, runId, STEPS_FILE), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
        },
      }),
    });
    const opts = baseOptions(runsDir, join(t.dir, 'out'), { conditions: ['jev-on-next'], concurrency: 1 });
    try {
      const out = await runBenchWithSources([syntheticSource({ id: 't1' })], opts, deps);
      // the arm PINS 'off' (its mode is jev-on); the run said 'on', and the record follows the run
      expect(armMechanisms('jev-on-next').s2).toBe('off');
      expect(out.summary.conditions['jev-on-next']!.mechanisms.s2).toBe('on');
    } finally {
      await t.cleanup();
    }
  });

  it('…and records the pin when the run reported nothing, rather than a measurement nobody made', async () => {
    const t = await tempDir();
    const { deps } = createFakeDeps({ script: () => ({ result: { steps: 2 }, spendUsd: 0.01 }) });
    const opts = baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { conditions: ['jev-on-next'], concurrency: 1 });
    try {
      const out = await runBenchWithSources([syntheticSource({ id: 't1' })], opts, deps);
      expect(out.summary.conditions['jev-on-next']!.mechanisms.s2).toBe('off');
    } finally {
      await t.cleanup();
    }
  });
});

describe('the §5.5 bench bridge', () => {
  // the rows below are the shapes slot C's writer actually produces (`llm-loop-C-fastpath` src/loop/stages/fastpath.ts
  // `declinedRecord` / `firedRecord`): `stage: 1` ONLY on a free decline, `stage: 2` on every row of a round that ran,
  // `decision: 'fired'` ONLY on a proposal, and `decision: 'failed'` with outcome timeout/refused/error otherwise.
  it('folds fastPath, router, riskSource and the S2 verify members out of steps.jsonl', () => {
    const text = [
      step({ fastPath: { decision: 'fired', reason: 'none', stage: 2, outcome: 'proposed', candidatesTested: 12, testRuns: 3, jevRequests: 2, wallMs: 4000, budgetMs: 45_000 }, router: { issued: 3, applied: 2, dropped: 1, waitMs: 0 }, riskSource: 'code', verify: { ttfbMs: [300, 500], hedges: 1, hedgeWins: 1, cacheRead: 100, cacheWrite: 10, cacheInput: 1_000 } }),
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
    // F19: `cacheInput` is the §3.4 hit rate's DENOMINATOR and travels with the two counts, so the run-level rate is
    // Σread / Σinput. The four rows without a `verify` block add nothing to it, exactly as they add nothing to the rest.
    expect(s.s2).toEqual({ ttfbMs: [300, 500], hedges: 1, hedgeWins: 1, cacheRead: 100, cacheWrite: 10, cacheInput: 1_000 });

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
    expect(rows.map((r) => [r.id, r.status])).toEqual([['R-a', 'pass'], ['R-b', 'pass'], ['R-c', 'pass'], ['R-d', 'pass'], ['R-e', 'reported'], ['R-s2', 'not_evaluable']]);

    const dirty = [
      withSynth('a', 'jev-on-next', [step({ fastPath: { decision: 'fired', reason: 'none', stage: 2, outcome: 'proposed', wallMs: 60_000, budgetMs: 45_000 }, router: { issued: 1, applied: 0, dropped: 1, waitMs: 120 } })]),
      // two stage-2 declines against one stage-1 fire = 2.0, far over the 0.3 bar: the PREDICATE is wrong
      withSynth('b', 'jev-on-next', [step({ fastPath: { decision: 'declined', reason: 'error', stage: 2, outcome: 'error', wallMs: 1, budgetMs: 1 } }), step({ step: 2, fastPath: { decision: 'declined', reason: 'error', stage: 2, outcome: 'error', wallMs: 1, budgetMs: 1 } })]),
    ];
    const bad = measurementRows(dirty, 'jev-on-next', ['quixbugs']);
    expect(bad.map((r) => [r.id, r.status])).toEqual([['R-a', 'fail'], ['R-b', 'fail'], ['R-c', 'fail'], ['R-d', 'fail'], ['R-e', 'reported'], ['R-s2', 'not_evaluable']]);
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
    // slot C's union is the source of truth now (integration, 2026-09-22): the two reasons the mirror was missing
    // are declines/failures the writer really emits, so R-d must NOT call them unknown
    expect(FASTPATH_REASONS).toContain('warm_plane');
    expect(FASTPATH_REASONS).toContain('no_passer');
    expect(FASTPATH_REASONS).toHaveLength(29);
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
    // B1: the EMITTED copy of the confound list. F05 struck S2 off the arms, report.ts's paragraph and §8.1 —
    // and left this one, which is the copy a reader of the §8.3 table actually sees.
    expect(predictions.find((p) => p.id === 'f')!.detail).toBe('the jev-on-next-nofast control has no evaluated record — without it a win confounds tuned generation, the routers and the fast path');
    expect(predictions.find((p) => p.id === 'f')!.detail).not.toContain('S2');
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
    // B3: the escape may only name a mechanism the wave MEASURED. After F05 no arm in the plan runs S2, so
    // "ship S2 + routers alone" authorised shipping an unmeasured mechanism on the strength of a measured one.
    const clause4 = verdict.clauses.find((c) => c.n === 4)!;
    expect(clause4.detail).toContain('ship the routers');
    expect(clause4.detail).not.toContain('S2');
    expect(clause4.title).toContain('the wave ships as the routers alone');
    expect(clause4.title).not.toContain('S2');
    // …and the wave still does not accept, because clause 3 carries (a)
    expect(verdict.accept).toBe(false);
  });
});
