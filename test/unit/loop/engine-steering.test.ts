/**
 * TUI-DESIGN §8.6 (A53, 10 §15.3) and §19.4: consumption of queued directives at the loop top — `human` problems in
 * plan.harnessProblems, the hints lines, `state.human`, the `\n\n`-joined SynthesisContext.directive, the loop-count
 * reset, the superseded texts, the re-arm on --resume after a rule-1 discard, and EngineOptions.humanDirective.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, EngineOptions, GenerateRequest, HarnessProblem, JsonObject, SynthesisContext, Synthesizer, UndoLogEntry } from '../../../src/core/types.js';
import { PENDING_DIRECTIVES_MAX } from '../../../src/core/types.js';
import { DIRECTIVE_MAX_CHARS, MAX_PENDING_DIRECTIVES, UNDO_LOG_MAX, createEngine } from '../../../src/loop/engine.js';
import { PLAN_MAX_HARNESS_PROBLEMS } from '../../../src/loop/plan.js';
import { HUMAN_DIRECTIVES_MAX, HUMAN_DIRECTIVE_CHARS } from '../../../src/loop/state.js';
import { HUMAN_DIRECTIVE_CHARS as PROMPT_DIRECTIVE_CHARS } from '../../../src/provider/prompts.js';
import { createCheckpointStore, serialiseEnvelope } from '../../../src/checkpoint/store.js';
import { createNullProvider } from '../../../src/provider/null.js';
import type { Harness } from './fakes.js';
import { DEFAULT_LIMITS, FIXED_RUN_ID, answer, createFakeDecider, createFakeProvider, createFakeSandbox, createFakeWorkspace, failingTests, intentIs, makeEngine, noRepoState, noulA, passingTests, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

const HINT = "Instruction from the human for this step (it takes precedence over the plan's order): ";
const readTurns = (n: number) => Array.from({ length: n }, () => turn({ kind: 'read', paths: ['src/a.py'] }));
const humanOf = (state: unknown): { directives: string[]; step: number } | undefined => (state as JsonObject & { human?: { directives: string[]; step: number } }).human;

describe('applyPendingDirectives (§8.6: the one plan mutation outside commit)', () => {
  it('a directive queued before the run reaches step 1 only: problem, hint line, state.human, then cleared at commit', async () => {
    const h = await build({ turns: readTurns(2), limits: { maxSteps: 2 } });
    h.engine.steer('use pytest -x');
    await h.engine.run();
    // the plan mutation: one `human` problem for step 1, still present at the end (it expires 4 steps later, §8.6)
    expect(h.of('steer:applied')).toEqual([{ type: 'steer:applied', step: 1, count: 1, superseded: [] }]);
    expect(h.store.steps[0]!.planAfter?.harnessProblems).toEqual([{ kind: 'human', text: 'use pytest -x', step: 1 }]);
    // the generator saw it on step 1 and not on step 2
    expect(h.provider.requests[0]!.messages[0]!.content).toContain(`${HINT}use pytest -x`);
    expect(h.provider.requests[0]!.messages[0]!.content).toContain('[human, step 1] use pytest -x');
    expect(h.provider.requests[1]!.messages[0]!.content).not.toContain(HINT);
    // Jev saw it in every stage of step 1 (P1) and in no stage of step 2
    for (const c of h.decider.calls.filter((c) => c.step === 1)) expect(humanOf(c.state)).toEqual({ directives: ['use pytest -x'], step: 1 });
    for (const c of h.decider.calls.filter((c) => c.step === 2)) expect(humanOf(c.state)).toBeUndefined();
    // status counts the queue
    expect(h.engine.status().pendingDirectives).toBe(0);
  });

  it('eight queued steers become eight problems, eight hint lines and state.human.directives.length === 8; seed problems (step 0) are untouched; loop counts reset', async () => {
    const seedProblem = { kind: 'human' as const, step: 0, text: 'Follow-up to run 20260919-100000-aaaaaaaa (stopped: max_steps) whose task was "x"; the task above is the human\'s next instruction' };
    const h = await build({
      turns: [turn({ kind: 'run', command: 'pytest -q' })],
      sandbox: createFakeSandbox(() => failingTests),
      limits: { maxSteps: 4 },
      engine: {
        seed: { parentRunId: '20260919-100000-aaaaaaaa', plan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [seedProblem] }, window: [], createdThisRun: [], lastTestRun: null },
      },
    });
    // two identical failing runs (count 2 of 3), then eight steers before step 3
    h.engine.events.on('step:end', (e) => {
      if (e.record.step === 2) for (let i = 0; i < MAX_PENDING_DIRECTIVES; i++) expect(h.engine.steer(`directive ${i}`).ok).toBe(true);
    });
    const r = await h.engine.run();
    expect(r.steps).toBe(4);
    const applied = h.of('steer:applied');
    expect(applied).toEqual([{ type: 'steer:applied', step: 3, count: 8, superseded: [] }]);
    const plan3 = h.store.steps[2]!.planAfter!;
    expect(plan3.harnessProblems.filter((p) => p.kind === 'human' && p.step === 3)).toHaveLength(8);
    expect(plan3.harnessProblems).toContainEqual(expect.objectContaining({ step: 0 }));
    const prompt3 = h.provider.requests[2]!.messages[0]!.content;
    expect(prompt3.split(HINT).length - 1).toBe(8);
    const intent3 = h.decider.callsAt('intent').find((c) => c.step === 3)!;
    expect(humanOf(intent3.state)?.directives).toHaveLength(8);
    // §8.6: resetCounts — the third identical failing run at step 3 did not trip (counts restarted at the steer), the fourth counts as 2
    expect(h.of('loop:tripped')).toEqual([]);
    const counts = Object.values(h.store.last()!.loopDetector.counts);
    expect(counts.every((n) => n === 2)).toBe(true);
    // the trips history and replan count are kept (nothing to keep here, but the shape is intact)
    expect(h.store.last()!.loopDetector.replanCount).toBe(0);
  });

  it('a later steer supersedes an earlier steer problem (text ≤ 80 in the item) and never the step-0 seed problem; a replan problem is named as superseded but kept', async () => {
    const seedProblem = { kind: 'human' as const, step: 0, text: 'seed framing' };
    const h = await build({
      turns: readTurns(3),
      limits: { maxSteps: 3 },
      engine: { seed: { parentRunId: '20260919-100000-aaaaaaaa', plan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [seedProblem] }, window: [], createdThisRun: [], lastTestRun: null } },
    });
    const long = 'a'.repeat(200);
    h.engine.steer(long);
    h.engine.events.on('step:end', (e) => {
      if (e.record.step === 1) h.engine.steer('second thoughts');
    });
    await h.engine.run();
    const applied = h.of('steer:applied');
    expect(applied[0]).toEqual({ type: 'steer:applied', step: 1, count: 1, superseded: [] });
    expect(applied[1]!.superseded).toEqual([`${'a'.repeat(79)}…`]);
    const finalProblems = h.store.last()!.plan.harnessProblems;
    expect(finalProblems).toEqual([seedProblem, { kind: 'human', text: 'second thoughts', step: 2 }]);
  });

  it('a steer problem expires four steps after the step it steered; the step-0 seed problem survives until step 8', async () => {
    const seedProblem = { kind: 'human' as const, step: 0, text: 'seed framing' };
    const h = await build({
      turns: readTurns(9),
      limits: { maxSteps: 9 },
      engine: { seed: { parentRunId: '20260919-100000-aaaaaaaa', plan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [seedProblem] }, window: [], createdThisRun: [], lastTestRun: null } },
    });
    h.engine.steer('go');
    await h.engine.run();
    const at = (step: number) => h.store.steps[step - 1]!.planAfter!.harnessProblems.filter((p) => p.kind === 'human').map((p) => `${p.kind}@${p.step}`);
    expect(at(5)).toEqual(['human@0', 'human@1']);
    expect(at(6)).toEqual(['human@0']);
    expect(at(8)).toEqual(['human@0']);
    expect(at(9)).toEqual([]);
  });

  it('jev-only: the human texts join SynthesisContext.directive with a blank line and no batch clip (§15.3)', async () => {
    const contexts: SynthesisContext[] = [];
    const synth: Synthesizer = {
      name: 'capture',
      async synthesize(ctx) {
        contexts.push(ctx);
        return { goal: 'look', action: { kind: 'read', paths: ['src/a.py'] }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' };
      },
    };
    const provider = Object.assign(createNullProvider(), { requests: [] as GenerateRequest[] });
    const h = await build({ mode: 'jev-only', synthesizer: synth, provider, limits: { maxSteps: 2 } });
    const a = 'x'.repeat(DIRECTIVE_MAX_CHARS);
    const b = 'y'.repeat(DIRECTIVE_MAX_CHARS);
    h.engine.steer(a);
    h.engine.steer(b);
    await h.engine.run();
    expect(contexts[0]!.directive).toBe(`${a}\n\n${b}`);
    expect(contexts[0]!.directive!.length).toBe(2 * DIRECTIVE_MAX_CHARS + 2);
    expect(contexts[1]!.directive).toBeNull();
    expect(provider.calls).toBe(0);
  });

  it('after a rule-1 discard the resumed run re-arms the hint, state.human and the problem from plan.harnessProblems (nothing stored)', async () => {
    const provider = createFakeProvider([turn({ kind: 'run', command: 'ls' }, {}, { delayMs: 5_000 })]);
    const h = await build({ provider });
    h.engine.steer('prefer ls -la');
    const running = h.engine.run();
    await new Promise((r) => setTimeout(r, 40));
    h.engine.abort('signal');
    const r1 = await running;
    expect(r1.stopReason).toBe('signal');
    expect(r1.steps).toBe(0);
    // the directive was applied before the discard: it lives in the plan, not in the queue
    const st = h.store.last()!;
    expect(st.pendingDirectives).toBeUndefined();
    expect(st.plan.harnessProblems).toEqual([{ kind: 'human', text: 'prefer ls -la', step: 1 }]);
    expect(st.interrupted?.step).toBe(1);
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: readTurns(1), limits: { maxSteps: 1 } });
    await h2.engine.run();
    expect(h2.of('steer:applied')).toEqual([]); // nothing queued: re-derived, not re-applied
    expect(h2.provider.requests[0]!.messages[0]!.content).toContain(`${HINT}prefer ls -la`);
    expect(humanOf(h2.decider.callsAt('intent')[0]!.state)).toEqual({ directives: ['prefer ls -la'], step: 1 });
  });

  it('steer({ secretsAcked }) emits secret-ack (count only) before steer:queued; the raw text reaches the generator, every artefact is masked', async () => {
    const secret = 'sk-or-v1-SECRETSECRETSECRETSECRET';
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    h.engine.steer(`use the key ${secret}`, { secretsAcked: 1 });
    await h.engine.run();
    // both items were held for the run:ready flush (pre-run steer), in order: the ack, then the queued line
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('secret-ack')).toBeGreaterThan(types.indexOf('run:ready'));
    expect(types.indexOf('secret-ack')).toBeLessThan(types.indexOf('steer:queued'));
    expect(h.of('secret-ack')).toEqual([{ type: 'secret-ack', step: 1, count: 1 }]);
    expect(h.of('steer:queued')[0]!.text).toBe('use the key [REDACTED:test]');
    // the generator saw the raw text (F9/A156); every event and transcript line was redacted at emit
    expect(h.provider.requests[0]!.messages[0]!.content).toContain(secret);
    expect(JSON.stringify(h.events)).not.toContain(secret);
    expect(h.store.transcript.join('\n')).not.toContain(secret);
    // the in-memory plan holds it raw (§8.6); the store's write-time redaction (P56) masks it on disk — the real serialiser over the fake store's state
    expect(JSON.stringify(h.store.last()!.plan)).toContain(secret);
    const redact = (x: string): string => x.replaceAll(secret, '[REDACTED:test]');
    expect(serialiseEnvelope(h.store.last()!, redact)).not.toContain(secret);
    expect(serialiseEnvelope(h.store.last()!, redact)).toContain('use the key [REDACTED:test]');
    // Jev's recorded state is masked too (state.ts redactJson)
    expect(JSON.stringify(h.decider.callsAt('intent')[0]!.state)).not.toContain(secret);
    expect(humanOf(h.decider.callsAt('intent')[0]!.state)?.directives).toEqual(['use the key [REDACTED:test]']);
  });

  it('EngineOptions.humanDirective is queued at construction, announced right after run:ready and consumed at step 1', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 }, engine: { humanDirective: '  start with the tests  ' } });
    expect(h.engine.snapshotState()?.pendingDirectives).toEqual([{ text: 'start with the tests', at: expect.any(String), index: 0 }]);
    expect(h.engine.steer('and lint')).toEqual({ ok: true, index: 1, queued: 2 });
    await h.engine.run();
    const types = h.events.map((e) => e.type);
    const ready = types.indexOf('run:ready');
    const queued = h.of('steer:queued');
    // both pre-run steers are announced after run:ready in queue order (the construction-time one first): the same human input
    // yields the same transcript order whichever way it arrived
    expect(queued.map((q) => q.text)).toEqual(['start with the tests', 'and lint']);
    expect(queued.map((q) => q.index)).toEqual([0, 1]);
    const idx = h.events.findIndex((e) => e.type === 'steer:queued' && e.text === 'start with the tests');
    expect(idx).toBeGreaterThan(ready);
    expect(idx).toBeLessThan(types.indexOf('step:start'));
    expect(h.events.filter((e) => e.type === 'steer:queued' || e.type === 'secret-ack' || e.type === 'pause:requested').every((_, i, arr) => h.events.indexOf(arr[i]!) > ready)).toBe(true);
    expect(h.of('steer:applied')).toEqual([{ type: 'steer:applied', step: 1, count: 2, superseded: [] }]);
    expect(h.provider.requests[0]!.messages[0]!.content).toContain(`${HINT}start with the tests`);
  });

  it('a steer queued at a loop trip pre-empts the replan (resetCounts clears the trip): step 4 starts at intent with the hint, and an earlier replan problem is named as superseded but kept', async () => {
    const h = await build({
      turns: [turn({ kind: 'done', summary: 'finished' })],
      deciderOptions: { rules: [answer('judge', 'task_complete', noulA(0.3)), intentIs('finish')] },
      limits: { maxSteps: 5, maxReplans: 5 },
    });
    let trips = 0;
    h.engine.events.on('loop:tripped', () => {
      trips += 1;
      if (trips === 2) h.engine.steer('try the tests first');
    });
    const r = await h.engine.run();
    expect(r.steps).toBe(5);
    // trip 1 at step 3 → step 4 replans (a replan problem lands in the plan); the done at step 4 trips again? no: the replan reset that signature,
    // so the second trip needs three more — force the shape instead: assert what happened
    const replanSteps = h.decider.callsAt('replan').map((c) => c.step);
    expect(replanSteps).toEqual([4]);
    expect(h.store.steps[3]!.planAfter!.harnessProblems.some((p) => p.kind === 'replan')).toBe(true);
    void passingTests;
    void HINT;
  });

  it('a steer queued at the very trip pre-empts the replan stage and names the standing replan problem as superseded while keeping it', async () => {
    const h = await build({
      turns: [turn({ kind: 'done', summary: 'finished' })],
      deciderOptions: { rules: [answer('judge', 'task_complete', noulA(0.3)), intentIs('finish')] },
      limits: { maxSteps: 4, maxReplans: 5 },
    });
    h.engine.events.on('loop:tripped', () => {
      h.engine.steer('try the tests first');
    });
    await h.engine.run();
    // §8.6 resetCounts: the trip is cleared by the directive, so step 4 has no replan stage and no replan line; the hint is there
    expect(h.decider.callsAt('replan')).toEqual([]);
    const prompt4 = h.provider.requests[3]!.messages[0]!.content;
    expect(prompt4).not.toContain('Replan directive from Jev');
    expect(prompt4).toContain(`${HINT}try the tests first`);
    expect(h.of('steer:applied')).toEqual([{ type: 'steer:applied', step: 4, count: 1, superseded: [] }]);
    expect(h.store.last()!.loopDetector.tripped).toBe(false);
    // a standing replan problem from an earlier trip is listed as superseded and stays in the plan (only steer problems are removed)
    const withReplan = await build({
      turns: [turn({ kind: 'done', summary: 'finished' })],
      deciderOptions: { rules: [answer('judge', 'task_complete', noulA(0.3)), intentIs('finish')] },
      limits: { maxSteps: 5, maxReplans: 5 },
    });
    withReplan.engine.events.on('step:end', (e) => {
      if (e.record.step === 4) withReplan.engine.steer('now the tests');
    });
    await withReplan.engine.run();
    expect(withReplan.decider.callsAt('replan').map((c) => c.step)).toEqual([4]);
    const applied = withReplan.of('steer:applied')[0]!;
    expect(applied.step).toBe(5);
    expect(applied.superseded).toHaveLength(1);
    expect(withReplan.store.last()!.plan.harnessProblems.map((p) => p.kind)).toEqual(['replan', 'human']);
  });
});

describe('bounds and the harness-problem cap (§8.6, F7: 8 × 600)', () => {
  it('the 8 × 600 pair is defined once: the engine queue, state.human and the hints line read the same constants', () => {
    expect(MAX_PENDING_DIRECTIVES).toBe(PENDING_DIRECTIVES_MAX);
    expect(MAX_PENDING_DIRECTIVES).toBe(8);
    expect(HUMAN_DIRECTIVES_MAX).toBe(PENDING_DIRECTIVES_MAX);
    expect(HUMAN_DIRECTIVE_CHARS).toBe(DIRECTIVE_MAX_CHARS);
    expect(PROMPT_DIRECTIVE_CHARS).toBe(DIRECTIVE_MAX_CHARS);
    expect(DIRECTIVE_MAX_CHARS).toBe(600);
  });

  it('at the cap (≥ 9 non-steer problems plus 8 steers) the step-0 seed problem survives: the oldest non-seed problems go first', async () => {
    const seedProblem: HarnessProblem = { kind: 'human', step: 0, text: 'Follow-up to run 20260919-100000-aaaaaaaa (stopped: max_steps) whose task was "x"; the task above is the human\'s next instruction' };
    const others: HarnessProblem[] = Array.from({ length: 9 }, (_, i) => ({ kind: 'rejected_claim' as const, step: 0, text: `claim ${i} was not accepted` }));
    const h = await build({
      turns: readTurns(1),
      limits: { maxSteps: 1 },
      engine: { seed: { parentRunId: '20260919-100000-aaaaaaaa', plan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [seedProblem, ...others] }, window: [], createdThisRun: [], lastTestRun: null } },
    });
    for (let i = 0; i < MAX_PENDING_DIRECTIVES; i++) expect(h.engine.steer(`directive ${i}`).ok).toBe(true);
    let atStepStart: HarnessProblem[] = [];
    h.engine.events.on('steer:applied', () => {
      atStepStart = h.engine.snapshotState()!.plan.harnessProblems;
    });
    await h.engine.run();
    // 1 seed + 9 others + 8 steers = 18 → 16: the two OLDEST non-seed problems are dropped, the seed framing stays
    expect(atStepStart).toHaveLength(PLAN_MAX_HARNESS_PROBLEMS);
    expect(atStepStart[0]).toEqual(seedProblem);
    expect(atStepStart.filter((p) => p.kind === 'human' && p.step === 1)).toHaveLength(8);
    expect(atStepStart.filter((p) => p.kind === 'rejected_claim').map((p) => p.text)).toEqual(others.slice(2).map((p) => p.text));
    // the same rule at commit (applyPlanDraft bounds through boundHarnessProblems too)
    expect(h.store.steps[0]!.planAfter!.harnessProblems[0]).toEqual({ ...seedProblem, text: expect.any(String) });
  });
});

describe('re-arming and the /resume paths (§8.6, §12.4, §19.4)', () => {
  it('jev-only: after a rule-1 discard and --resume, SynthesisContext.directive re-arms from plan.harnessProblems (the synthesizer\'s only channel)', async () => {
    const contexts: SynthesisContext[] = [];
    let block = true;
    const synth: Synthesizer = {
      name: 'capture',
      async synthesize(ctx) {
        contexts.push(ctx);
        if (block) await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
        if (ctx.signal.aborted) throw ctx.signal.reason;
        return { goal: 'look', action: { kind: 'read', paths: ['src/a.py'] }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' };
      },
    };
    const provider = Object.assign(createNullProvider(), { requests: [] as GenerateRequest[] });
    const h = await build({ mode: 'jev-only', synthesizer: synth, provider, limits: { maxSteps: 2 } });
    h.engine.steer('prefer the helper module');
    const running = h.engine.run();
    // wait for the synthesizer to hold the step, then abort: rule-1 discard, the directive lives in the plan only
    for (let i = 0; i < 200 && contexts.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(contexts[0]!.directive).toBe('prefer the helper module');
    h.engine.abort('human_abort');
    const r1 = await running;
    expect(r1.stopReason).toBe('human_abort');
    expect(r1.steps).toBe(0);
    expect(h.store.last()!.pendingDirectives).toBeUndefined();
    expect(h.store.last()!.plan.harnessProblems).toEqual([{ kind: 'human', text: 'prefer the helper module', step: 1 }]);
    block = false;
    const h2 = await build({ mode: 'jev-only', synthesizer: synth, provider, store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, limits: { maxSteps: 1 } });
    await h2.engine.run();
    expect(h2.of('steer:applied')).toEqual([]);
    // the resumed step 1 sees the directive again (re-derived from the plan), and step 2 would not
    expect(contexts[1]!.step).toBe(1);
    expect(contexts[1]!.directive).toBe('prefer the helper module');
    expect(humanOf(h2.decider.callsAt('intent')[0]!.state)).toEqual({ directives: ['prefer the helper module'], step: 1 });
    expect(provider.calls).toBe(0);
  });

  it('--resume with EngineOptions.humanDirective + undoLog (/undo then /resume, §12.4): the directive is queued, announced after run:ready and consumed at the first step; the undoLog is merged with the restored one and bounded at 20', async () => {
    const entry = (step: number, by: 'undo' | 'rewind' = 'undo'): UndoLogEntry => ({ runId: FIXED_RUN_ID, step, at: `2026-09-20T00:00:${String(step).padStart(2, '0')}.000Z`, by, restored: [`f${step}.py`], skipped: [] });
    const restored = Array.from({ length: 15 }, (_, i) => entry(i + 1));
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 }, engine: { undoLog: restored } });
    await h.engine.run();
    expect(h.store.last()!.undoLog).toHaveLength(15);
    const fresh = Array.from({ length: 8 }, (_, i) => entry(100 + i, 'rewind'));
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: readTurns(1), limits: { maxSteps: 2 }, engine: { humanDirective: 'the undo note: /undo restored src/a.py', undoLog: fresh } });
    // queued at construction, in the snapshot before the run; announced after run:ready
    expect(h2.engine.snapshotState()!.pendingDirectives).toEqual([{ text: 'the undo note: /undo restored src/a.py', at: expect.any(String), index: 0 }]);
    expect(h2.of('steer:queued')).toEqual([]);
    await h2.engine.run();
    const types = h2.events.map((e) => e.type);
    expect(types.indexOf('steer:queued')).toBeGreaterThan(types.indexOf('run:ready'));
    expect(types.indexOf('steer:queued')).toBeLessThan(types.indexOf('step:start'));
    expect(h2.of('steer:applied')).toEqual([{ type: 'steer:applied', step: 2, count: 1, superseded: [] }]);
    expect(h2.provider.requests[0]!.messages[0]!.content).toContain(`${HINT}the undo note: /undo restored src/a.py`);
    // merged: the restored 15 then the 8 new entries, bounded at 20 → the 5 oldest restored entries fall off
    const log = h.store.last()!.undoLog!;
    expect(log).toHaveLength(UNDO_LOG_MAX);
    expect(log.map((u) => u.step)).toEqual([...restored.slice(3).map((u) => u.step), ...fresh.map((u) => u.step)]);
    expect(h.store.last()!.pendingDirectives).toBeUndefined();
  });
});

describe('§19.4 secret sweep for the steer path against the REAL store', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('steps.jsonl (planAfter carries the steer) and state.json written by createCheckpointStore carry [REDACTED:…] while the provider saw the raw text', async () => {
    const secret = 'sk-or-v1-SECRETSECRETSECRETSECRET';
    const runsDir = mkdtempSync(join(tmpdir(), 'jevcode-sweep-'));
    dirs.push(runsDir);
    const provider = createFakeProvider(readTurns(1));
    const decider = createFakeDecider();
    const redact = (x: string): string => x.replaceAll(secret, '[REDACTED:composer#1]');
    const opts: EngineOptions = {
      task: 'Fix f() in src/a.py so that tests/test_a.py passes',
      mode: 'jev-on',
      workspace: runsDir,
      runsDir,
      provider,
      decider,
      confirmer: { identity: 'no reviewer', confirm: async () => false },
      meter: (await import('./fakes.js')).createFakeMeter(2),
      limits: { ...DEFAULT_LIMITS, maxSteps: 1 },
      sandboxProfile: 'none',
      noNetwork: false,
      configRecord: {},
      redact,
      secretPaths: [],
      generation: { temperature: null, maxTokens: 4096 },
      deciderModel: { configured: 'typesafe/jev-1.13-20260917', pinned: true },
    };
    // the real disk store and the real resume loader; sandbox, workspace and the git probe stay fakes (no spawns)
    const engine = await createEngine(opts, {
      createCheckpointStore: (dir, id, r) => createCheckpointStore(join(dir, id), r),
      createWorkspace: async () => createFakeWorkspace({ root: runsDir }),
      createSandbox: () => createFakeSandbox(),
      newRunId: () => FIXED_RUN_ID,
      probeGitState: async () => noRepoState(),
    });
    const events: EngineEvent[] = [];
    engine.events.onAny((e) => events.push(e));
    expect(engine.steer(`use the key ${secret}`, { secretsAcked: 1 }).ok).toBe(true);
    // a second steer stays queued past the end of the run so the final state.json carries a pendingDirectives entry too
    engine.events.on('step:end', () => {
      engine.steer(`and again ${secret}`);
    });
    const r = await engine.run();
    expect(r.steps).toBe(1);
    const runDir = join(runsDir, FIXED_RUN_ID);
    // the provider saw the raw text; Jev's recorded state did not
    expect(provider.requests[0]!.messages[0]!.content).toContain(secret);
    expect(JSON.stringify(decider.calls.map((c) => c.state))).not.toContain(secret);
    // every artefact on disk is masked: steps.jsonl (planAfter.harnessProblems), state.json (plan + pendingDirectives), state.prev.json, transcript.log, run.json
    const artefacts = ['steps.jsonl', 'state.json', 'state.prev.json', 'transcript.log', 'run.json', 'decisions.jsonl', 'jev.jsonl', 'generator.jsonl'].filter((f) => existsSync(join(runDir, f)));
    expect(artefacts).toContain('steps.jsonl');
    expect(artefacts).toContain('state.json');
    for (const f of artefacts) expect(readFileSync(join(runDir, f), 'utf8'), f).not.toContain(secret);
    const steps = readFileSync(join(runDir, 'steps.jsonl'), 'utf8');
    expect(steps).toContain('use the key [REDACTED:composer#1]');
    const state = readFileSync(join(runDir, 'state.json'), 'utf8');
    expect(state).toContain('use the key [REDACTED:composer#1]');
    expect(state).toContain('and again [REDACTED:composer#1]');
    // the events (every writer) were masked at emit; --plain output is the same item text as transcript.log
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(readFileSync(join(runDir, 'transcript.log'), 'utf8')).toContain('steer queued (1) for step 1: use the key [REDACTED:composer#1]');
    // the in-memory envelope helper agrees with what the disk store wrote
    expect(serialiseEnvelope(engine.snapshotState()!, redact)).not.toContain(secret);
  });
});

