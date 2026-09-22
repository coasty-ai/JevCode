import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { answer, choiceOver, createFakeSandbox, execResult, failingTests, makeEngine, noulA, riskAll, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

const REPLAN_KEYS = ['change_approach', 'gather_context', 'fix_environment', 'revert_changes', 'stop_and_report', 'none_of_these'];

describe('loop detection and replan', () => {
  it('trips on the third identical run result; the next step starts with replan and the directive reaches the prompt', async () => {
    const h = await build({
      turns: [turn({ kind: 'run', command: 'pytest -q' }), turn({ kind: 'run', command: 'pytest -q' }), turn({ kind: 'run', command: 'pytest -q' }), turn({ kind: 'run', command: 'pytest -q' })],
      sandbox: createFakeSandbox(() => failingTests),
      limits: { maxSteps: 4 },
    });
    const result = await h.engine.run();
    expect(h.store.steps[0]!.loopSignatures).toHaveLength(2); // run: and fail: (exit 1)
    const trip = h.of('loop:tripped');
    expect(trip).toHaveLength(1);
    expect(trip[0]).toMatchObject({ step: 3, occurrences: 3 });
    expect(trip[0]!.signature).toMatch(/^run:/);
    expect(h.decider.calls.filter((c) => c.step === 4).map((c) => c.stage)[0]).toBe('replan');
    expect(h.decider.calls.filter((c) => c.step <= 3).every((c) => c.stage !== 'replan')).toBe(true);
    const replanState = h.decider.callsAt('replan')[0]!.state as { trigger: string; loop: { kind: string; occurrences: number; trips: number; priorDirectives: unknown[] } };
    expect(replanState.trigger).toBe('loop');
    expect(replanState.loop).toMatchObject({ kind: 'run', occurrences: 3, trips: 1, priorDirectives: [] });
    expect(h.provider.requests[3]!.messages[0]!.content).toMatch(/Replan directive from Jev \(move `change_approach`/);
    expect(result.counters.loops).toBe(1);
    expect(result.counters.replans).toBe(1);
    expect(result.finalPlan.harnessProblems.some((p) => p.kind === 'replan')).toBe(true);
    const st = h.store.last()!;
    expect(st.loopDetector.tripped).toBe(false);
    expect(st.loopDetector.replanCount).toBe(1);
    expect(Object.values(st.loopDetector.tripsBySignature)[0]).toMatchObject({ trips: 1, directives: [{ step: 4 }] });
    // after the replan step the counts restart from that step
    expect(Object.values(st.loopDetector.counts)).toEqual([1, 1]);
  });

  it('the same test command with different output four times does not trip', async () => {
    let n = 0;
    const h = await build({
      turns: [turn({ kind: 'run', command: 'pytest -q' })],
      sandbox: createFakeSandbox(() => execResult({ exitCode: 1, stdout: `${4 - n++} failed, ${n} passed\nFAILED test_${['a', 'b', 'c', 'd'][n - 1]}` })),
      limits: { maxSteps: 4 },
    });
    await h.engine.run();
    expect(h.of('loop:tripped')).toHaveLength(0);
  });

  it('three blocked proposals with the same reason trip; three rejected dones trip', async () => {
    const h = await build({
      turns: [turn({ kind: 'run', command: 'rm -rf /' })],
      deciderOptions: { rules: [riskAll({ 4: 1 })] },
      limits: { maxSteps: 3 },
    });
    await h.engine.run();
    expect(h.of('loop:tripped')).toHaveLength(1);
    const h2 = await build({ turns: [turn({ kind: 'done', summary: 'finished' })], deciderOptions: { rules: [answer('judge', 'task_complete', noulA(0.3))] }, limits: { maxSteps: 3 } });
    await h2.engine.run();
    expect(h2.of('loop:tripped')[0]!.signature).toMatch(/^done:/);
  });

  it('replan stop_and_report -> replan_stop; task_impossible >= 0.85 -> impossible regardless of move', async () => {
    const stopRule = (id: string, p: number) => (ctx: { stage: string; questions: Record<string, unknown> }) =>
      ctx.stage === 'replan' ? { next_move: choiceOver(REPLAN_KEYS, id, 0.8), [`can_${id}`]: noulA(p) } : undefined;
    const h = await build({ turns: [turn({ kind: 'run', command: 'make' })], sandbox: createFakeSandbox(() => failingTests), deciderOptions: { rules: [stopRule('stop_and_report', 0.9)] } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('replan_stop');
    expect(r.steps).toBe(3);
    expect(h.store.last()!.stopReason).toBe('replan_stop');
    const h2 = await build({
      turns: [turn({ kind: 'run', command: 'make' })],
      sandbox: createFakeSandbox(() => failingTests),
      deciderOptions: { rules: [stopRule('change_approach', 0.9), answer('replan', 'task_impossible', noulA(0.9))] },
    });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('impossible');
    // §3.7 G1: the `stop:` line is deleted; the `[step 4] replan:` row below still carries the diagnosis
    expect(h2.store.transcript.some((l) => l.includes('stop: impossible'))).toBe(false);
    expect(h2.store.transcript.at(-1)).toMatch(/^\[run\] finished [·-] impossible [·-] /);
    expect(h2.store.transcript.filter((l) => /^\[run\] (?:warn: )?stop: /.test(l))).toEqual([]);
    // the replan stage ran at the start of step 4, which was then discarded (§9.1 rule 1); the stop names the last committed step
    expect(h2.store.transcript.some((l) => /^\[step 4\] replan: impossible \(move change_approach p=0\.80, task_impossible=0\.90\)$/.test(l))).toBe(true);
  });

  it('none_of_these at replan maps to change_approach with the "no listed recovery" wording', async () => {
    const h = await build({
      turns: [turn({ kind: 'run', command: 'make' })],
      sandbox: createFakeSandbox(() => failingTests),
      deciderOptions: {
        rules: [(ctx) => (ctx.stage === 'replan' ? { next_move: choiceOver(REPLAN_KEYS, 'none_of_these', 0.7), can_change_approach: noulA(0.2), can_gather_context: noulA(0.1), can_fix_environment: noulA(0.1), can_revert_changes: noulA(0.1), can_stop_and_report: noulA(0.1) } : undefined)],
      },
      limits: { maxSteps: 4 },
    });
    await h.engine.run();
    const replan = h.of('replan')[0]!;
    expect(replan.directive.move).toBe('change_approach');
    expect(replan.directive.text).toMatch(/no listed recovery applicable/);
    expect(h.store.steps[3]!.decisions.find((d) => d.id === 'next_move')?.verdict).toBe('fallback');
  });

  it('max_replans stops when a further replan would be needed', async () => {
    const h = await build({ turns: [turn({ kind: 'run', command: 'make' })], sandbox: createFakeSandbox(() => failingTests), limits: { maxReplans: 1, maxSteps: 20 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_replans');
    expect(r.counters.replans).toBe(1);
    expect(r.counters.loops).toBe(2);
    expect(r.steps).toBe(6);
  });

  it('resume mid-loop: two occurrences checkpointed, third occurrence trips after resume', async () => {
    const h = await build({ turns: [turn({ kind: 'run', command: 'make' })], sandbox: createFakeSandbox(() => failingTests), limits: { maxSteps: 2 } });
    await h.engine.run();
    expect(h.of('loop:tripped')).toHaveLength(0);
    const state = h.store.last()!;
    expect(Object.values(state.loopDetector.counts)).toEqual([2, 2]);
    // resume from the same store with a raised max_steps
    const h2 = await build({ turns: [turn({ kind: 'run', command: 'make' })], sandbox: createFakeSandbox(() => failingTests), store: h.store, runsDir: h.runsDir, limits: { maxSteps: 3 }, resume: { runId: h.engine.runId, force: false } });
    const r2 = await h2.engine.run();
    expect(h2.of('run:start')[0]).toMatchObject({ resumedFromStep: 2 });
    expect(h2.of('loop:tripped')).toHaveLength(1);
    expect(h2.of('loop:tripped')[0]!.step).toBe(3);
    expect(r2.steps).toBe(3);
    expect(h2.store.last()!.resumes).toBe(1);
    expect(h2.provider.requests[0]!.messages[0]!.content).toContain('resumed run: these files differ');
  });
});
