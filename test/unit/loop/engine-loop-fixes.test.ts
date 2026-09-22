/**
 * The three loop-side fixes of experiments/results/jev-only-ladder-4-analysis.md §4, end to end
 * through the engine: a `done` after the engine's own green run is not refused (Fix 1), the
 * standing verification run is never a review item (Fix 2), and refused proposals are signed on
 * the proposal alone with per-signature resets, `intent:unresolved` only for a real fallback, and
 * the §5.5 third-identical-`done` exit (Fix 3).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { answer, choiceOver, createFakeSandbox, execResult, intentIs, makeEngine, noulA, passingTests, riskAll, scoreA, turn } from './fakes.js';
import type { Answer, JsonObject, Synthesizer } from '../../../src/core/types.js';
import type { DeciderRule } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

const INTENT_KEYS = ['investigate', 'edit', 'verify', 'fix_environment', 'finish', 'none_of_these'];
const REPLAN_KEYS = ['change_approach', 'gather_context', 'fix_environment', 'revert_changes', 'stop_and_report', 'none_of_these'];

/** units step 12 of the ladder-4 run: a green `done` declined at review 0.36 from out_of_scope, dominant level 0, confidence 0.00 */
const greenDoneReview = (step?: number): DeciderRule => answer('risk', 'out_of_scope', scoreA({ 0: 0.64, 3: 0.36 }), step);
/** calendar_utils step 13: `python3 -m pytest -q` declined at review 0.43 from plan_mismatch, dominant level 0, confidence 0.00 */
const spreadMassRun = (step?: number): DeciderRule => (ctx) =>
  ctx.stage === 'risk' && (step === undefined || ctx.step === step) ? { plan_mismatch: scoreA({ 0: 0.31, 1: 0.06, 2: 0.2, 3: 0.18, 4: 0.25 }), out_of_scope: scoreA({ 0: 0.89, 1: 0.02, 4: 0.09 }) } : undefined;
/** every paired Noul below 0.5 with Jev's Choice on `option`: a §6 fallback */
const lowNouls = (option: string, p: number, step: number, nouls: Record<string, number> = {}): DeciderRule => (ctx) => {
  if (ctx.stage !== 'intent' || ctx.step !== step) return undefined;
  const out: Record<string, Answer> = { intent: choiceOver(INTENT_KEYS, option, p) };
  for (const k of INTENT_KEYS) if (k !== 'none_of_these') out[`can_${k}`] = noulA(nouls[k] ?? 0.2);
  return out;
};

describe('Fix 1: a done after the engine\'s own green run is completion the harness verified', () => {
  it('the risk stage does not refuse it: verdict ok with the verified-completion reason, Jev\'s answers kept, no review counted, the completion Noul decides', async () => {
    const h = await build({
      turns: [turn({ kind: 'run', command: 'pytest -q' }, { remaining: ['verify the full test suite passes'] }), turn({ kind: 'done', summary: 'all 2 tests pass; 1 fix committed' }, { done: ['verify the full test suite passes'], remaining: [] })],
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [intentIs('verify', 1), intentIs('finish', 2), greenDoneReview(2), answer('judge', 'task_complete', noulA(0.95), 2)] },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    expect(r.steps).toBe(2);
    const [s1, s2] = h.store.steps;
    expect(s1!.outcome?.status).toBe('executed');
    expect(h.store.last()!.lastTestRun).toMatchObject({ step: 1, command: 'pytest -q', allPassed: true });
    expect(s2!.risk?.verdict).toBe('ok');
    expect(s2!.risk?.risk).toBeCloseTo(0.36, 6);
    expect(s2!.risk?.reason).toMatch(/^completion verified by the engine's own passing run `pytest -q` at step 1; Jev risk answers kept for audit: risk 0\.36 \(review\) from out_of_scope: 0\.36 probability of level 3 or above/);
    expect(s2!.risk?.dims.out_of_scope).toMatchObject({ level: 0, tailMass: 0.36 });
    // Jev's own verdict stays on the Score rows (audit); nothing went to the confirmer
    expect(s2!.decisions.find((d) => d.stage === 'risk' && d.id === 'out_of_scope')?.verdict).toBe('review');
    expect(h.of('confirm:request')).toEqual([]);
    expect(r.counters).toMatchObject({ reviews: 0, declined: 0, blocked: 0 });
    expect(s2!.outcome?.status).toBe('noop');
    expect(s2!.completion).toBe(0.95);
    // TUI-DESIGN-4 §3.7 G3 (D-V): the `risk` item is ONE row and no longer interpolates the audit string; the
    // clause is asserted on `RiskAssessment.reason` above (`:55`), which §3.6 edge 9 leaves untouched
    expect(h.store.transcript.some((l) => /^\[step 2\] risk 0\.36 ok [·-] destructive 0 [·-] irreversible 0$/.test(l))).toBe(true);
    expect(h.store.transcript.some((l) => l.includes('completion verified by'))).toBe(false);
  });

  it('ladder round 6: the judge state of the green `done` carries the run (`executed.tests`, `testsCurrent`, `executed.lastRun` with the tail), so the completion Noul sees the evidence rather than a bare `done`', async () => {
    const h = await build({
      turns: [turn({ kind: 'run', command: 'pytest -q' }, { remaining: ['verify the full test suite passes'] }), turn({ kind: 'done', summary: 'all 2 tests pass; 1 fix committed' }, { done: ['verify the full test suite passes'], remaining: [] })],
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [intentIs('verify', 1), intentIs('finish', 2), answer('judge', 'task_complete', noulA(0.9), 2)] },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    const judge = h.decider.calls.filter((c) => c.step === 2 && c.stage === 'judge');
    expect(judge).toHaveLength(1);
    const state = judge[0]!.state as { executed: JsonObject; workspace: JsonObject };
    expect(state.workspace).toMatchObject({ testsCurrent: true, lastTestRun: { step: 1, allPassed: true } });
    expect(state.executed).toEqual({
      action: 'done',
      summary: 'all 2 tests pass; 1 fix committed',
      exitCode: null,
      output: '',
      tests: { command: 'pytest -q', parsed: { passed: 2, failed: 0, errors: 0 }, allPassed: true },
      testsCurrent: true,
      lastRun: { step: 1, command: 'pytest -q', allPassed: true, total: 2, passed: 2, failed: 0, errors: 0, workspaceUnchangedSince: true, output: passingTests.stdout },
    });
    // the completion question names the block
    expect(String(judge[0]!.questions['task_complete']!.instructions)).toContain('executed.lastRun');
  });

  it('the rule needs the facts: a change after the run (testsCurrent false), a failing run, or a partial done (planClaim.remaining non-empty) leave the review to the confirmer', async () => {
    // a file changed after the green run
    const h = await build({
      turns: [turn({ kind: 'run', command: 'pytest -q' }), turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' }), turn({ kind: 'done', summary: 'done' }, { remaining: [] })],
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [greenDoneReview(3)] },
      limits: { maxSteps: 3 },
    });
    await h.engine.run();
    const s3 = h.store.steps[2]!;
    expect(s3.outcome?.status).toBe('declined');
    expect(s3.risk?.reason).not.toContain('completion verified');
    // the last run failed
    const h2 = await build({
      turns: [turn({ kind: 'run', command: 'pytest -q' }), turn({ kind: 'done', summary: 'done' }, { remaining: [] })],
      sandbox: createFakeSandbox(() => execResult({ exitCode: 1, stdout: '1 failed, 1 passed in 0.10s\n' })),
      deciderOptions: { rules: [greenDoneReview(2)] },
      limits: { maxSteps: 2 },
    });
    await h2.engine.run();
    expect(h2.store.steps[1]!.outcome?.status).toBe('declined');
    // a partial done: the proposal itself says work remains
    const h3 = await build({
      turns: [turn({ kind: 'run', command: 'pytest -q' }), turn({ kind: 'done', summary: 'partial: fixed 0 of 3 failing tests' }, { remaining: ['fix tests/test_a.py::test_f in src/a.py'] })],
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [greenDoneReview(2)] },
      limits: { maxSteps: 2 },
    });
    await h3.engine.run();
    expect(h3.store.steps[1]!.outcome?.status).toBe('declined');
    expect(h3.store.steps[1]!.risk?.reason).toMatch(/^risk 0\.36 \(review\)/);
  });

  it('jev-only: a `finish` answer whose paired Noul is under 0.5 is rescued after the engine\'s green run (no intent:unresolved), and the green done then completes the run', async () => {
    const synth: Synthesizer = {
      name: 'green-then-done',
      async synthesize(ctx) {
        if (ctx.step === 1) return { goal: 'verify the suite', action: { kind: 'run', command: 'pytest -q' }, plan: { done: [], remaining: ['fix tests/test_a.py::test_f in tests/test_a.py', 'verify the full test suite passes'], openProblems: [] }, rawText: '' };
        return { goal: 'all 2 tests pass; 1 fix committed', action: { kind: 'done', summary: 'all 2 tests pass; 1 fix committed' }, plan: { done: ['verify the full test suite passes'], remaining: [], openProblems: [] }, rawText: '' };
      },
    };
    const h = await build({
      mode: 'jev-only',
      synthesizer: synth,
      sandbox: createFakeSandbox(() => passingTests),
      // units step 13: finish 0.63, can_finish 0.31; the plan still lists a stale `fix …` item
      deciderOptions: { rules: [intentIs('verify', 1), lowNouls('finish', 0.63, 2, { finish: 0.31 }), greenDoneReview(2), answer('judge', 'task_complete', noulA(0.92), 2)] },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    expect(r.steps).toBe(2);
    const s2 = h.store.steps[1]!;
    expect(s2.intent).toBe('finish');
    expect(s2.intentAnswer).toBe('finish');
    expect(s2.loopSignatures).not.toContain('intent:unresolved');
    expect(s2.decisions.find((d) => d.stage === 'intent' && d.id === 'intent')?.verdict).toBe('chosen');
    const risk2 = h.decider.callsAt('risk').find((c) => c.step === 2)!.state as JsonObject;
    expect((risk2['intent'] as JsonObject)['choice']).toBe('finish');
    expect(((risk2['workspace'] as JsonObject)['lastTestRun'] as JsonObject)['allPassed']).toBe(true);
    expect((risk2['workspace'] as JsonObject)['testsCurrent']).toBe(true);
    expect(s2.risk?.verdict).toBe('ok');
    expect(s2.outcome?.status).toBe('noop');
    expect(r.usage.generator.calls).toBe(0);
  });
});

describe('Fix 2: the standing verification run is never a review item', () => {
  it('a spread-mass plan_mismatch answer on the workspace test command executes; the same answers on another command or a composed shell line are declined', async () => {
    const h = await build({ turns: [turn({ kind: 'run', command: 'python3 -m pytest -q' })], sandbox: createFakeSandbox(() => passingTests), deciderOptions: { rules: [spreadMassRun()] }, limits: { maxSteps: 1 } });
    const r = await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.risk?.verdict).toBe('ok');
    expect(s1.risk?.dims.plan_mismatch.risk).toBeCloseTo(0.43, 6);
    expect(s1.risk?.reason).toContain('verification run of the workspace test command: out_of_scope 0.09 (dominant level 0), plan_mismatch 0.43 (dominant level 0) recorded, not gating');
    expect(s1.outcome?.status).toBe('executed');
    expect(h.sandbox.commands).toEqual(['python3 -m pytest -q']);
    expect(h.store.last()!.lastTestRun).toMatchObject({ step: 1, allPassed: true });
    expect(r.counters).toMatchObject({ reviews: 0, declined: 0 });
    for (const command of ['pip install x', 'pytest -q && rm -rf .']) {
      const h2 = await build({ turns: [turn({ kind: 'run', command })], deciderOptions: { rules: [spreadMassRun()] }, limits: { maxSteps: 1 } });
      await h2.engine.run();
      expect(h2.store.steps[0]!.outcome?.status).toBe('declined');
      expect(h2.store.steps[0]!.risk?.reason).toMatch(/^risk 0\.43 \(review\) from plan_mismatch/);
      expect(h2.sandbox.commands).toEqual([]);
    }
  });
  it('destructive and irreversible still gate a test run', async () => {
    const h = await build({ turns: [turn({ kind: 'run', command: 'pytest -q' })], deciderOptions: { rules: [spreadMassRun(), answer('risk', 'destructive', scoreA({ 3: 0.8, 0: 0.2 }))] }, limits: { maxSteps: 1 } });
    await h.engine.run();
    expect(h.store.steps[0]!.outcome?.status).toBe('blocked');
    expect(h.store.steps[0]!.risk?.reason).toMatch(/^risk 0\.80 \(block\) from destructive/);
    expect(h.sandbox.commands).toEqual([]);
  });
});

describe('Fix 3: loop signatures for refused proposals', () => {
  it('a declined then twice-blocked identical run is one `run:<cmd>:refused` signature and trips at step 3', async () => {
    const h = await build({
      turns: [turn({ kind: 'run', command: 'rm -rf build' })],
      deciderOptions: { rules: [riskAll({ 2: 1 }, 1), riskAll({ 4: 1 }, 2), riskAll({ 4: 1 }, 3)] },
      limits: { maxSteps: 3 },
    });
    const r = await h.engine.run();
    const [s1, s2, s3] = h.store.steps;
    expect([s1!.outcome?.status, s2!.outcome?.status, s3!.outcome?.status]).toEqual(['declined', 'blocked', 'blocked']);
    expect(s1!.loopSignatures).toEqual(s3!.loopSignatures);
    expect(s1!.loopSignatures[0]).toMatch(/^run:[0-9a-f]{12}:refused$/);
    expect(h.of('loop:tripped')).toHaveLength(1);
    expect(h.of('loop:tripped')[0]).toMatchObject({ step: 3, occurrences: 3, signature: s1!.loopSignatures[0] });
    expect(r.counters.loops).toBe(1);
  });

  it('intent:unresolved is emitted only when the fallback lands away from Jev\'s answer (escape, or a low-Noul non-investigate answer)', async () => {
    const h = await build({
      // three different reads, so only the intent signature could trip
      turns: [turn({ kind: 'read', paths: ['src/a.py'] }), turn({ kind: 'read', paths: ['tests/test_a.py'] }), turn({ kind: 'read', paths: ['src/a.py', 'tests/test_a.py'] })],
      deciderOptions: { rules: [lowNouls('investigate', 0.79, 1, { investigate: 0.47 }), lowNouls('none_of_these', 0.8, 2), lowNouls('edit', 0.6, 3)] },
      limits: { maxSteps: 3 },
    });
    await h.engine.run();
    const [s1, s2, s3] = h.store.steps;
    // account step 9 of the ladder-4 run: investigate 0.79, can_investigate 0.47 -> fallback -> effective intent investigate anyway
    expect(s1!.intent).toBe('investigate');
    expect(s1!.intentAnswer).toBe('investigate');
    expect(s1!.decisions.find((d) => d.id === 'intent')?.verdict).toBe('fallback');
    expect(s1!.loopSignatures).not.toContain('intent:unresolved');
    expect(h.store.last()!.window[0]!.notes).not.toContain('intent unresolved: fallback to investigate');
    expect(s2!.intentAnswer).toBe('none_of_these');
    expect(s2!.loopSignatures).toContain('intent:unresolved');
    expect(s3!.intentAnswer).toBe('edit');
    expect(s3!.intent).toBe('investigate');
    expect(s3!.loopSignatures).toContain('intent:unresolved');
    expect(h.of('loop:tripped')).toEqual([]);
  });

  it('the §5.5 exit: three refused dones trip, `gather_context` is directed; three more trip again and a second `gather_context` for the same signature is treated as stop_and_report', async () => {
    const gather: DeciderRule = (ctx) => (ctx.stage === 'replan' ? { next_move: choiceOver(REPLAN_KEYS, 'gather_context', 0.8), can_gather_context: noulA(0.9), can_stop_and_report: noulA(0.1), task_impossible: noulA(0.1) } : undefined);
    const h = await build({
      turns: [turn({ kind: 'done', summary: 'partial: fixed 0 of 3 failing tests' }, { remaining: ['fix tests/test_a.py::test_f in src/a.py'] })],
      deciderOptions: { rules: [riskAll({ 4: 1 }), gather] },
      limits: { maxSteps: 12, maxReplans: 5 },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('replan_stop');
    expect(r.steps).toBe(6);
    expect(h.store.steps.every((s) => s.outcome?.status === 'blocked')).toBe(true);
    expect(h.of('loop:tripped').map((e) => e.step)).toEqual([3, 6]);
    const sig = h.of('loop:tripped')[0]!.signature;
    expect(sig).toMatch(/^done:/);
    expect(h.of('loop:tripped')[1]!.signature).toBe(sig);
    // the first replan (step 4) directed gather_context and was recorded for the signature; the second (step 7) is the exit
    expect(h.of('replan')).toHaveLength(2);
    expect(h.of('replan').map((e) => e.directive.move)).toEqual(['gather_context', 'gather_context']);
    expect(r.counters.replans).toBe(1);
    expect(h.store.last()!.loopDetector.tripsBySignature[sig]).toMatchObject({ trips: 2, directives: [{ step: 4 }] });
    expect(h.store.transcript.some((l) => l.startsWith(`[step 7] replan: gather_context directed again for ${sig} (already directed at step 4); treated as stop_and_report`))).toBe(true);
    // §3.7 G1: the `stop:` line is deleted — it restated, one row later, the `[step 7] replan:` row above it
    expect(h.store.transcript.some((l) => l.includes('stop: replan_stop'))).toBe(false);
    expect(h.store.transcript.at(-1)).toMatch(/^\[run\] finished [·-] replan_stop [·-] /);
    expect(h.store.transcript.filter((l) => /^\[run\] (?:warn: )?stop: /.test(l))).toEqual([]);
  });

  it('a second replan that picks another move is not the exit; a first gather_context on a run signature is not either', async () => {
    let n = 0;
    const alternate: DeciderRule = (ctx) => {
      if (ctx.stage !== 'replan') return undefined;
      const move = n++ === 0 ? 'gather_context' : 'change_approach';
      return { next_move: choiceOver(REPLAN_KEYS, move, 0.8), [`can_${move}`]: noulA(0.9), task_impossible: noulA(0.1) };
    };
    const h = await build({ turns: [turn({ kind: 'done', summary: 'x' }, { remaining: ['a'] })], deciderOptions: { rules: [riskAll({ 4: 1 }), alternate] }, limits: { maxSteps: 7, maxReplans: 5 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(r.counters.replans).toBe(2);
    expect(h.of('replan').map((e) => e.directive.move)).toEqual(['gather_context', 'change_approach']);
  });
});
