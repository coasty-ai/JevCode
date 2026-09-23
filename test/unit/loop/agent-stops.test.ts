/**
 * docs/AGENT-LOOP-DESIGN.md §3.3 / §3.6 / §8 / §15 S4 — the agent stop rules in the engine: `complete` only after a current, green run
 * of the UNSCOPED detected test command (a scoped or subdirectory run gives `generator_done`; pending todos never block); the 6th loop
 * trip stops `stuck` (exit 4, resumable); a throwing `observe()` is a stage failure whose step still commits, and three in a row stop
 * the run with `error`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LoopTrip, SandboxRunOptions } from '../../../src/core/types.js';
import { AGENT_MAX_LOOP_NUDGES } from '../../../src/loop/stages/agent.js';
import type { AgentHarness, ToolTurn } from './fakes.js';
import { createFakeSandbox, execResult, failingTests, makeAgentEngine, passingTests } from './fakes.js';

const harnesses: AgentHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function agent(...args: Parameters<typeof makeAgentEngine>): Promise<AgentHarness> {
  const h = await makeAgentEngine(...args);
  harnesses.push(h);
  return h;
}

const edit: ToolTurn = { toolCalls: [{ name: 'edit_file', input: { path: 'src/a.py', old_string: 'return 1', new_string: 'return 2' } }] };
const bash = (command: string, workdir?: string): ToolTurn => ({ toolCalls: [{ name: 'bash', input: workdir === undefined ? { command } : { command, workdir } }] });
const tests = createFakeSandbox;

describe('complete needs a current, green, unscoped run of the detected test command (§3.3)', () => {
  it('the unscoped run after the last change completes, with todo items still pending (they are a note, never a gate)', async () => {
    const h = await agent([edit, bash('pytest -q'), { text: 'Fixed; docs are still to do.' }], { sandbox: tests(() => passingTests), driver: { plan: { remaining: ['update the docs'] } } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    expect(h.store.last()!.plan.remaining).toEqual(['update the docs']);
  });

  it('a scoped green run (`pytest -q tests/test_a.py`) is a test run but never `complete`: generator_done', async () => {
    const h = await agent([edit, bash('pytest -q tests/test_a.py'), { text: 'Fixed.' }], { sandbox: tests(() => passingTests) });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('generator_done');
    expect(h.store.last()!.lastTestRun).toMatchObject({ command: 'pytest -q tests/test_a.py', allPassed: true });
  });

  it('the test command in a subdirectory (`workdir`) reaches the sandbox as cwd and is recorded as `cd <dir> && …`: generator_done', async () => {
    const cwds: (string | undefined)[] = [];
    const sandbox = tests(() => passingTests);
    const run = sandbox.run.bind(sandbox);
    sandbox.run = async (command: string, o: SandboxRunOptions) => {
      cwds.push(o.cwd);
      return run(command, o);
    };
    const h = await agent([edit, bash('pytest -q', 'pkg'), { text: 'Fixed.' }], { sandbox });
    const r = await h.engine.run();
    expect(cwds).toEqual(['pkg']);
    expect(h.store.steps[1]!.proposal?.action).toEqual({ kind: 'run', command: 'pytest -q', cwd: 'pkg' });
    expect(h.store.last()!.lastTestRun).toMatchObject({ command: 'cd pkg && pytest -q', allPassed: true });
    expect(r.stopReason).toBe('generator_done');
  });

  it('a failing run, and a green run followed by an edit, are not complete', async () => {
    const failing = await agent([edit, bash('pytest -q'), { text: 'Tried.' }], { sandbox: tests(() => failingTests) });
    expect((await failing.engine.run()).stopReason).toBe('generator_done');
    const stale = await agent([bash('pytest -q'), edit, { text: 'Changed after the run.' }], { sandbox: tests(() => passingTests) });
    expect((await stale.engine.run()).stopReason).toBe('generator_done');
  });

  it('a legacy-mode `done` is untouched by the agent rule: jev-off still stops generator_done on its own done', async () => {
    const { makeEngine, turn } = await import('./fakes.js');
    const h = await makeEngine({ mode: 'jev-off', turns: [turn({ kind: 'done', summary: 'x' })] });
    try {
      expect((await h.engine.run()).stopReason).toBe('generator_done');
      expect(h.store.steps[0]!.agent).toBeUndefined();
      expect(h.store.steps[0]!.proposer).toBeUndefined();
      expect(h.store.last()!.agentState).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe('loop trips (§3.6, §8)', () => {
  it(`each trip emits loop:tripped and spends a nudge; the trip after ${AGENT_MAX_LOOP_NUDGES} nudges stops \`stuck\` (exit 4, resumable)`, async () => {
    let n = 0;
    const trip: LoopTrip = { signature: 'abc123def456', count: 3, rule: 'repeat', tool: 'bash' };
    const h = await agent(() => ({ toolCalls: [{ id: `c${++n}`, name: 'bash', input: { command: 'make' } }] }), {
      sandbox: tests(() => execResult({ exitCode: 2, stderr: 'make: *** No rule to make target' })),
      driver: { loopTripAt: () => trip },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('stuck');
    expect(r.steps).toBe(AGENT_MAX_LOOP_NUDGES + 1);
    const end = h.of('run:end')[0]!;
    expect(end.exitCode).toBe(4);
    expect(end.resumable).toBe(true);
    expect(h.of('loop:tripped').map((e) => [e.step, e.signature, e.occurrences])).toEqual(Array.from({ length: AGENT_MAX_LOOP_NUDGES + 1 }, (_, i) => [i + 1, 'abc123def456', 3]));
    expect(r.counters.loopNudges).toBe(AGENT_MAX_LOOP_NUDGES);
    expect(r.counters.loops).toBe(AGENT_MAX_LOOP_NUDGES + 1);
    // the trip rides the step record, and the stuck line names it
    expect(h.store.steps.every((s) => s.agent?.loopTrip?.signature === 'abc123def456')).toBe(true);
    expect(h.of('transcript').some((t) => t.text.startsWith(`stuck: the agent repeated itself after ${AGENT_MAX_LOOP_NUDGES} loop nudges`))).toBe(true);
    // the last step committed whole before the stop
    expect(h.store.last()!.step).toBe(AGENT_MAX_LOOP_NUDGES + 1);
  });

  it('fewer trips than the bound only nudge: the run ends on the model’s own answer', async () => {
    const h = await agent([bash('make'), bash('make'), { text: 'The Makefile has no default target.' }], {
      sandbox: tests(() => execResult({ exitCode: 2 })),
      driver: { loopTripAt: (step) => (step === 2 ? { signature: 's', count: 2, rule: 'window', tool: 'bash' } : null) },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('generator_done');
    expect(r.counters.loopNudges).toBe(1);
    expect(h.store.steps[0]!.agent?.loopTrip).toBeUndefined();
    expect(h.store.steps[1]!.agent?.loopTrip).toMatchObject({ rule: 'window' });
  });
});

describe('a throwing observe() (§2.2, §3.4)', () => {
  it('is a transcript warning and a stage failure; the step still commits with its real outcome, and the run goes on', async () => {
    const h = await agent([bash('ls -la src'), bash('make'), { text: 'ok' }], { sandbox: tests(() => execResult({ exitCode: 0, stdout: 'built' })), driver: { failObserveAt: (step) => step === 1 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('generator_done');
    // `ls -la src` is read-only for the scripted driver: an observe step, and observe() is never called for it
    expect(h.store.steps[0]!.agent?.kind).toBe('observe');
    expect(h.driver.observations.map((o) => o.step)).toEqual([2, 3]);
    const w = await agent([bash('make'), { text: 'ok' }], { sandbox: tests(() => execResult({ exitCode: 0 })), driver: { failObserveAt: (step) => step === 1 } });
    const r2 = await w.engine.run();
    expect(r2.stopReason).toBe('generator_done');
    const s1 = w.store.steps[0]!;
    expect(s1.outcome?.status).toBe('executed');
    expect(s1.error).toMatchObject({ stage: 'propose', message: expect.stringContaining('transcript append failed') });
    expect(w.of('transcript').some((t) => t.level === 'warn' && t.text.startsWith('agent observe failed: transcript append failed'))).toBe(true);
    expect(w.of('error').some((e) => !e.fatal)).toBe(true);
    // the step after it is clean, so the failure counter reset
    expect(w.store.steps[1]!.error).toBeUndefined();
    expect(w.store.last()!.consecutiveStageFailures).toBe(0);
  });

  it('three in a row stop the run with `error`', async () => {
    let n = 0;
    const h = await agent(() => ({ toolCalls: [{ id: `m${++n}`, name: 'bash', input: { command: 'make' } }] }), { sandbox: tests(() => execResult({ exitCode: 0 })), driver: { failObserveAt: () => true } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('error');
    expect(r.steps).toBe(3);
    expect(h.store.steps.every((s) => s.error?.stage === 'propose')).toBe(true);
  });
});
