import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { answer, createFakeDecider, createFakeProvider, createFakeSandbox, execResult, makeEngine, noulA, passingTests, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

describe('budgets', () => {
  it('spend cap (a): the propose call crosses the cap -> before-execute check fires, rule 1', async () => {
    const provider = createFakeProvider([turn({ kind: 'run', command: 'pytest -q' }, {}, { usage: { costUsd: 0.5 } })]);
    const h = await build({ provider, limits: { spendCapUsd: 0.4 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('spend_cap');
    expect(r.steps).toBe(0);
    expect(h.store.steps).toHaveLength(0);
    expect(h.sandbox.commands).toHaveLength(0);
    const st = h.store.last()!;
    expect(st.stopReason).toBe('spend_cap');
    expect(st.interrupted).toMatchObject({ step: 1, stage: 'execute' });
    expect(st.interrupted?.proposal?.action).toEqual({ kind: 'run', command: 'pytest -q' });
    expect(st.spend.totalUsd).toBeGreaterThanOrEqual(0.5);
    // the stop line goes through the shared item model; the run:end line is the last one (§10)
    expect(h.store.transcript.at(-2)).toBe('[run] warn: stop: spend_cap at step 0 (before_execute)');
    expect(h.store.transcript.at(-1)).toMatch(/^\[run\] end spend_cap steps=0 /);
    // usage in RunResult includes the paid call
    expect(r.usage.generator.costUsd).toBeCloseTo(0.5);
  });

  it('spend cap (b): the judge call crosses the cap -> step recorded whole, run stops at the next step start', async () => {
    const decider = createFakeDecider({ usageAt: (ctx) => (ctx.stage === 'judge' ? { costUsd: 1 } : undefined), rules: [answer('judge', 'done_0', noulA(0.9))] });
    const h = await build({ decider, turns: [turn({ kind: 'run', command: 'pytest -q' }, { done: ['tests run'] })], sandbox: createFakeSandbox(() => passingTests), limits: { spendCapUsd: 0.5 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('spend_cap');
    expect(r.steps).toBe(1);
    const s1 = h.store.steps[0]!;
    expect(s1.outcome?.status).toBe('executed');
    expect(s1.judge).not.toBeNull();
    expect(s1.completion).not.toBeNull();
    expect(s1.decisions.some((d) => d.stage === 'complete')).toBe(true);
    expect(s1.stoppedAt).toBe('step_start');
    expect(r.finalPlan.done.map((d) => d.text)).toEqual(['tests run']);
    expect(h.store.last()!.stopReason).toBe('spend_cap');
  });

  it('resume of a spend_cap run without a raised cap stops immediately; with a raised cap it continues', async () => {
    const provider = createFakeProvider([turn({ kind: 'run', command: 'pytest -q' }, {}, { usage: { costUsd: 0.5 } })]);
    const h = await build({ provider, limits: { spendCapUsd: 0.4 } });
    await h.engine.run();
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, limits: { spendCapUsd: 0.4 } });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('spend_cap');
    expect(h2.provider.requests).toHaveLength(0);
    expect(h2.store.steps).toHaveLength(0);
    const h3 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, limits: { spendCapUsd: 5, maxSteps: 1 }, turns: [turn({ kind: 'run', command: 'ls' })], sandbox: createFakeSandbox(() => passingTests) });
    const r3 = await h3.engine.run();
    expect(r3.steps).toBe(1);
    expect(r3.stopReason).toBe('max_steps');
    expect(r3.usage.generator.costUsd).toBeGreaterThanOrEqual(0.5); // restored, not re-paid
  });

  it('max_steps stops at step start and the record carries stoppedAt step_start', async () => {
    const h = await build({ turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 2 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(r.steps).toBe(2);
    expect(h.store.steps[1]!.stoppedAt).toBe('step_start');
    expect(h.store.steps[0]!.stoppedAt).toBeUndefined();
  });

  it('wall-time abort mid-command: killedBy wall_time, rule 2 record, stopReason wall_time', async () => {
    const h = await build({
      turns: [turn({ kind: 'run', command: 'sleep 100' })],
      sandbox: createFakeSandbox(() => ({ hang: true })),
      limits: { maxWallMs: 250 },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('wall_time');
    expect(r.steps).toBe(1);
    const s1 = h.store.steps[0]!;
    expect(s1.outcome?.status).toBe('interrupted');
    expect(s1.outcome).toMatchObject({ exec: { killedBy: 'wall_time', signal: 'SIGTERM', exitCode: null } });
    expect(s1.interruptedAt).toEqual({ stage: 'execute', reason: 'wall_time' });
    expect(s1.judge).toBeNull();
    expect(s1.loopSignatures).toEqual([]);
    expect(h.sandbox.timeouts[0]).toBeLessThanOrEqual(250);
    expect(h.store.last()!.window[0]!.notes).toContain('stopped by wall-time budget');
    expect(h.store.last()!.stopReason).toBe('wall_time');
    expect(r.wallMs).toBeGreaterThanOrEqual(200);
  });

  it('command timeout is clamped to min(action, default, max, wall remaining)', async () => {
    const h = await build({
      turns: [turn({ kind: 'run', command: 'a' }), turn({ kind: 'run', command: 'b', timeoutMs: 5_000 }), turn({ kind: 'run', command: 'c', timeoutMs: 10_000_000 })],
      sandbox: createFakeSandbox(() => execResult({ stdout: 'ok' })),
      limits: { maxSteps: 3, commandTimeoutMs: 120_000, maxCommandTimeoutMs: 600_000 },
    });
    await h.engine.run();
    expect(h.sandbox.timeouts[0]).toBe(120_000);
    expect(h.sandbox.timeouts[1]).toBe(5_000);
    expect(h.sandbox.timeouts[2]).toBe(600_000);
  });

  it('a timeout is status executed with killedBy timeout and is judged normally', async () => {
    const h = await build({ turns: [turn({ kind: 'run', command: 'slow' })], sandbox: createFakeSandbox(() => execResult({ exitCode: null, killedBy: 'timeout', signal: 'SIGKILL' })), limits: { maxSteps: 1 } });
    await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.outcome?.status).toBe('executed');
    expect(s1.judge).not.toBeNull();
    expect((s1.outcome as { exec: { timedOut: boolean } }).exec.timedOut).toBe(true);
  });
});
