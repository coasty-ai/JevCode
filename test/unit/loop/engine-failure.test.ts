import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { createFakeDecider, createFakeProvider, createFakeSandbox, createFakeStore, makeEngine, passingTests, turn } from './fakes.js';
import { AbortError } from '../../../src/errors.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

describe('stage failure policy', () => {
  it('malformed generator twice -> stage-table record, signature fail:generator, no risk request, run continues', async () => {
    const provider = createFakeProvider([{ raw: 'no json here' }, { rawInput: { goal: 'g', action: { kind: 'jump' }, plan: { done: [], remaining: [], openProblems: [] } } }, turn({ kind: 'read', paths: ['src/a.py'] })]);
    const h = await build({ provider, limits: { maxSteps: 2 } });
    const r = await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.proposal).toBeNull();
    expect(s1.outcome).toEqual({ status: 'failed', error: 'propose: generator_response' });
    expect(s1.risk).toBeNull();
    expect(s1.judge).toBeNull();
    expect(s1.error).toMatchObject({ stage: 'propose', code: 'generator_response' });
    expect(s1.loopSignatures).toHaveLength(2);
    expect(s1.loopSignatures[0]).toMatch(/^fail:generator:/);
    expect(h.decider.calls.filter((c) => c.step === 1).map((c) => c.stage)).toEqual(['intent', 'context']);
    // the retry message carried the reason and the raw tail; both calls metered and recorded
    expect(provider.requests[1]!.messages).toHaveLength(3);
    expect(provider.requests[1]!.messages[2]!.content).toMatch(/no tool call and no fenced json block/);
    expect(provider.requests[1]!.messages[2]!.content).toContain('no json here');
    expect(h.store.generator.filter((g) => g.step === 1).map((g) => g.malformed)).toEqual([true, true]);
    expect(r.usage.generator.calls).toBe(3);
    expect(r.steps).toBe(2);
    expect(h.store.steps[1]!.outcome?.status).toBe('executed');
    expect(h.store.last()!.consecutiveStageFailures).toBe(0);
    expect(h.store.last()!.window[0]!.reason).toMatch(/propose: /);
  });

  it('provider 5xx at propose is a stage failure: failed outcome, no risk request, not observed by the loop detector', async () => {
    const provider = createFakeProvider([{ httpError: 529 }, turn({ kind: 'read', paths: ['src/a.py'] })]);
    const h = await build({ provider, limits: { maxSteps: 2 } });
    const r = await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.proposal).toBeNull();
    expect(s1.outcome).toEqual({ status: 'failed', error: 'propose: provider_http' });
    expect(s1.error).toMatchObject({ stage: 'propose', code: 'provider_http' });
    expect(s1.loopSignatures).toEqual([]);
    expect(h.decider.callsAt('risk').filter((c) => c.step === 1)).toHaveLength(0);
    expect(h.store.generator.filter((g) => g.step === 1)).toHaveLength(0); // no paid generator call to record
    expect(r.steps).toBe(2);
    expect(h.store.steps[1]!.outcome?.status).toBe('executed');
    expect(r.counters.failed).toBe(1);
  });

  it('Jev 5xx at risk: command never spawned, step recorded with error, fail closed', async () => {
    const h = await build({ turns: [turn({ kind: 'run', command: 'pytest -q' })], deciderOptions: { failAt: [{ stage: 'risk', status: 503 }] }, limits: { maxSteps: 1 } });
    const r = await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(h.sandbox.commands).toHaveLength(0);
    expect(s1.proposal?.action.kind).toBe('run');
    expect(s1.outcome).toEqual({ status: 'failed', error: 'risk: jev_http' });
    expect(s1.error).toMatchObject({ stage: 'risk', code: 'jev_http' });
    expect(s1.judge).toBeNull();
    expect(s1.loopSignatures).toEqual([]); // provider/Jev failures are not observed
    expect(r.stopReason).toBe('max_steps');
    expect(h.store.last()!.consecutiveStageFailures).toBe(1); // §6: only a step without a stage failure resets the counter
    expect(h.of('error').some((e) => !e.fatal && e.error.code === 'jev_http')).toBe(true);
  });

  it('Jev failure at judge: executed outcome kept, judge null, done claims rejected, unjudged note', async () => {
    const h = await build({
      turns: [turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' }, { done: ['fix f'], remaining: [] })],
      deciderOptions: { failAt: [{ stage: 'judge', status: 500 }] },
      limits: { maxSteps: 1 },
    });
    const r = await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.outcome?.status).toBe('executed');
    expect(h.workspace.files.get('src/a.py')).toContain('return 2');
    expect(s1.judge).toBeNull();
    expect(s1.completion).toBeNull();
    expect(s1.error).toMatchObject({ stage: 'judge', code: 'jev_http' });
    expect(r.finalPlan.done).toEqual([]);
    expect(r.finalPlan.remaining).toEqual(['fix f']);
    expect(r.finalPlan.harnessProblems.some((p) => p.kind === 'rejected_claim')).toBe(true);
    expect(h.store.last()!.window[0]!.notes).toContain('unjudged: jev_http');
    expect(s1.loopSignatures[0]).toMatch(/^patch:/); // the action itself is observed
  });

  it('three consecutive stage failures -> stopReason error with the error code in state; resume continues', async () => {
    const h = await build({ turns: [turn({ kind: 'run', command: 'ls' })], deciderOptions: { failAt: [{ stage: 'intent', status: 502 }] } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('error');
    expect(r.steps).toBe(3);
    expect(r.error?.code).toBe('jev_http');
    const st = h.store.last()!;
    expect(st.error).toEqual({ stage: 'intent', code: 'jev_http' });
    expect(st.consecutiveStageFailures).toBe(3);
    for (const s of h.store.steps) {
      expect(s.proposal).toBeNull();
      expect(s.outcome).toBeNull();
      expect(s.error?.stage).toBe('intent');
    }
    expect(h.decider.calls).toHaveLength(3);
    // resume continues from step 4
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [turn({ kind: 'run', command: 'ls' })], limits: { maxSteps: 4 } });
    const r2 = await h2.engine.run();
    expect(r2.steps).toBe(4);
    expect(r2.stopReason).toBe('max_steps');
    expect(h2.store.steps[3]!.outcome?.status).toBe('executed');
  });

  it('three consecutive steps each with a stage failure stop with error even though intent and context completed', async () => {
    const h = await build({ turns: [turn({ kind: 'run', command: 'ls' })], deciderOptions: { failAt: [{ stage: 'risk', status: 503 }] }, limits: { maxSteps: 10 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('error');
    expect(r.steps).toBe(3);
    expect(r.error?.code).toBe('jev_http');
    expect(r.error?.exitCode).toBe(5);
    expect(h.sandbox.commands).toHaveLength(0);
    const st = h.store.last()!;
    expect(st.error).toEqual({ stage: 'risk', code: 'jev_http' });
    expect(st.consecutiveStageFailures).toBe(3);
    expect(h.store.steps.map((s) => s.outcome)).toEqual(Array(3).fill({ status: 'failed', error: 'risk: jev_http' }));
  });

  it('a step without a stage failure resets the counter; failures on either side of it do not accumulate', async () => {
    const h = await build({
      turns: [turn({ kind: 'read', paths: ['src/a.py'] })],
      deciderOptions: { failAt: [{ stage: 'risk', step: 1, status: 503 }, { stage: 'risk', step: 2, status: 503 }, { stage: 'risk', step: 4, status: 503 }, { stage: 'risk', step: 5, status: 503 }] },
      limits: { maxSteps: 5 },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(r.steps).toBe(5);
    const counters = h.store.states.filter((s) => s.step >= 1).map((s) => [s.step, s.consecutiveStageFailures]);
    expect(counters).toEqual(expect.arrayContaining([[1, 1], [2, 2], [3, 0], [4, 1], [5, 2]]));
    expect(h.store.steps[2]!.outcome?.status).toBe('executed');
  });

  it('three twice-malformed generator steps stop with error carrying the provider exit code', async () => {
    const h = await build({ turns: [{ raw: 'not json' }], limits: { maxSteps: 10 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('error');
    expect(r.steps).toBe(3);
    expect(r.error).toMatchObject({ code: 'generator_response', exitCode: 5 });
    expect(h.store.last()!.error).toEqual({ stage: 'propose', code: 'generator_response' });
  });

  it('read of a missing file: FileNotFoundError is a failed outcome with a fail: signature, not a stage failure', async () => {
    const h = await build({ turns: [turn({ kind: 'read', paths: ['nope.py'] })], limits: { maxSteps: 1 } });
    const r = await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.outcome).toEqual({ status: 'failed', error: 'FileNotFoundError: no such file: nope.py' });
    expect(s1.error).toBeUndefined();
    expect(s1.judge).toBeNull();
    expect(s1.loopSignatures[0]).toMatch(/^read:/);
    expect(s1.loopSignatures.some((s) => s.startsWith('fail:'))).toBe(true);
    expect(h.store.last()!.consecutiveStageFailures).toBe(0);
    expect(h.store.last()!.window[0]!.reason).toBe('FileNotFoundError: no such file: nope.py');
    expect(r.counters.failed).toBe(1);
    expect(r.stopReason).toBe('max_steps');
    // and it reads as a failed outcome in transcript.log, like every other renderer
    expect(h.store.transcript).toContain('[step 1] outcome failed: FileNotFoundError: no such file: nope.py');
  });

  it('action errors are outcomes, not stage failures: EditError -> failed with a fail: signature', async () => {
    const h = await build({ turns: [turn({ kind: 'edit', path: 'src/a.py', old: 'nope', new: 'x' })], limits: { maxSteps: 1 } });
    const r = await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/EditError: no match/) });
    expect(s1.error).toBeUndefined();
    expect(s1.judge).toBeNull();
    expect(s1.loopSignatures.some((s) => s.startsWith('fail:'))).toBe(true);
    expect(r.counters.failed).toBe(1);
    expect(h.store.last()!.consecutiveStageFailures).toBe(0);
  });

  it('a plain fs error at execute (read of a missing path) is a failed outcome, not a stage failure', async () => {
    const h = await build({ turns: [turn({ kind: 'read', paths: ['nope.py'] })], limits: { maxSteps: 1 } });
    h.workspace.read = async (path) => {
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
    };
    const r = await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/ENOENT/) });
    expect(s1.error).toBeUndefined();
    expect(h.store.last()!.consecutiveStageFailures).toBe(0);
    expect(r.counters.failed).toBe(1);
  });

  it('PathEscapeError from target() at risk -> failed, no Jev risk request', async () => {
    const h = await build({ turns: [turn({ kind: 'write', path: '../evil.txt', content: 'x' })], limits: { maxSteps: 1 } });
    await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.outcome?.status).toBe('failed');
    expect(h.decider.callsAt('risk')).toHaveLength(0);
    expect(h.workspace.files.has('../evil.txt')).toBe(false);
  });

  it('model drift on the first call aborts the run with error (exit 2); later drift is recorded and continues', async () => {
    const h = await build({ decider: createFakeDecider({ model: 'typesafe/jev-1.13-20270101' }), turns: [turn({ kind: 'read', paths: ['src/a.py'] })] });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('error');
    expect(r.error?.code).toBe('jev_model_drift');
    expect(r.error?.exitCode).toBe(2);
    expect(r.steps).toBe(0);
    let n = 0;
    const drifting = createFakeDecider({ model: 'typesafe/jev-1.13-20260917' });
    const inner = drifting.ask.bind(drifting);
    drifting.ask = async (state, questions, o) => {
      const res = await inner(state, questions, o);
      n += 1;
      return n > 3 ? { ...res, model: 'typesafe/jev-1.13-20270101' } : res;
    };
    const h2 = await build({ decider: drifting, turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 2 } });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('max_steps');
    expect(r2.jevModelDrift).toMatchObject({ step: 1, served: 'typesafe/jev-1.13-20270101' });
    expect(h2.store.steps[0]!.decisions.some((d) => d.servedModel === 'typesafe/jev-1.13-20270101')).toBe(true);
    expect(h2.store.meta?.jevModelDrift).not.toBeNull();
  });

  it('an alias configured resolves on the first call and is persisted', async () => {
    const h = await build({ deciderModel: { configured: 'typesafe/jev-1.13', pinned: false }, turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 1 } });
    const r = await h.engine.run();
    expect(r.resolvedJevModel).toBe('typesafe/jev-1.13-20260917');
    expect(h.store.meta?.resolvedJevModel).toBe('typesafe/jev-1.13-20260917');
    expect(h.of('transcript').some((t) => /alias .* resolved to/.test(t.text))).toBe(true);
  });
});

describe('abort semantics (§9.1)', () => {
  it('abort during propose -> rule 1: no StepRecord, state.interrupted set, spend persisted', async () => {
    const provider = createFakeProvider([turn({ kind: 'run', command: 'ls' }, {}, { delayMs: 5_000 })]);
    const h = await build({ provider });
    const running = h.engine.run();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.engine.status().stage).toBe('propose');
    h.engine.abort('signal');
    const r = await running;
    expect(r.stopReason).toBe('signal');
    expect(h.store.steps).toHaveLength(0);
    const st = h.store.last()!;
    expect(st.interrupted).toMatchObject({ step: 1, stage: 'propose', proposal: null });
    expect(st.spend.jev.calls).toBe(2); // intent + context paid
    expect(st.stopReason).toBe('signal');
    expect(h.sandbox.killAllCalls).toBe(1);
    expect(h.of('run:end')).toHaveLength(1);
  });

  it('abort while the context stage reads a selected file -> rule 1 with stage context (the read error is not swallowed)', async () => {
    const h = await build({ turns: [turn({ kind: 'run', command: 'ls' })] });
    h.workspace.read = async () => {
      h.engine.abort('signal');
      throw new AbortError('signal');
    };
    const r = await h.engine.run();
    expect(r.stopReason).toBe('signal');
    expect(r.steps).toBe(0);
    expect(h.store.steps).toHaveLength(0);
    expect(h.provider.requests).toHaveLength(0); // never reached propose
    expect(h.store.last()!.interrupted).toMatchObject({ step: 1, stage: 'context', proposal: null });
  });

  it('abort during judge -> rule 3: outcome kept, judge null, interrupted before judge note', async () => {
    const decider = createFakeDecider({ delayMs: (ctx) => (ctx.stage === 'judge' ? 5_000 : 0) });
    const h = await build({ decider, turns: [turn({ kind: 'run', command: 'pytest -q' }, { done: ['tests'] })], sandbox: createFakeSandbox(() => passingTests) });
    const running = h.engine.run();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.engine.status().stage).toBe('judge');
    h.engine.abort('human_abort');
    const r = await running;
    expect(r.stopReason).toBe('human_abort');
    const s1 = h.store.steps[0]!;
    expect(s1.outcome?.status).toBe('executed');
    expect(s1.judge).toBeNull();
    expect(s1.completion).toBeNull();
    expect(s1.interruptedAt).toEqual({ stage: 'judge', reason: 'human_abort' });
    expect(s1.loopSignatures[0]).toMatch(/^run:/);
    expect(r.finalPlan.done).toEqual([]);
    expect(h.store.last()!.window[0]!.notes).toContain('interrupted before judge');
    expect(h.store.last()!.step).toBe(1);
  });

  it('abort during execute (sandbox rejects with AbortError) -> rule 2 without exec', async () => {
    const h = await build({ turns: [turn({ kind: 'run', command: 'sleep 9' })], sandbox: createFakeSandbox(() => ({ rejectOnAbort: true })) });
    const running = h.engine.run();
    await new Promise((r) => setTimeout(r, 30));
    h.engine.abort('signal');
    const r = await running;
    expect(r.stopReason).toBe('signal');
    const s1 = h.store.steps[0]!;
    expect(s1.outcome).toEqual({ status: 'interrupted' });
    expect(s1.interruptedAt).toEqual({ stage: 'execute', reason: 'signal' });
  });

  it('abort() is idempotent for the run, and a second call force-exits through the injected exit after the sync write', async () => {
    const store = createFakeStore();
    const exits: number[] = [];
    const exit = ((code: number) => {
      exits.push(code);
      throw new AbortError('signal');
    }) as (code: number) => never;
    const provider = createFakeProvider([turn({ kind: 'run', command: 'ls' }, {}, { delayMs: 5_000 })]);
    const h = await build({ provider, store, exit });
    const running = h.engine.run();
    await new Promise((r) => setTimeout(r, 20));
    h.engine.abort('human_abort');
    expect(() => h.engine.abort('human_abort')).toThrow(AbortError);
    expect(exits).toEqual([130]);
    expect(store.syncStates).toHaveLength(1);
    expect(store.syncStates[0]!.interrupted).toBeNull(); // snapshot before the step-level handling ran
    const r = await running;
    expect(r.stopReason).toBe('human_abort');
    h.engine.abort('human_abort'); // after the run ended: no-op
    expect(exits).toEqual([130]);
  });

  it('a stalled final checkpoint write force-exits after the bound (bounded by the injected exit)', { timeout: 15_000 }, async () => {
    // Exercise the bound path with a tiny timeout by racing on a store whose writeState never resolves.
    const store = createFakeStore();
    const exits: number[] = [];
    const exit = ((code: number) => {
      exits.push(code);
      throw new Error('exit');
    }) as (code: number) => never;
    const h = await build({ store, exit, turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 1 } });
    // Make only the final write stall: after the first step's checkpoint has been written.
    h.engine.events.on('checkpoint', () => {
      store.stallWrites = true;
    });
    const r = await h.engine.run();
    // finish() raced the stalled write against the 5 s bound and called exit; run() still resolves.
    expect(exits).toEqual([4]);
    expect(store.syncStates.length).toBeGreaterThanOrEqual(1);
    expect(store.syncStates.at(-1)!.stopReason).toBe('max_steps');
    expect(r.stopReason).toBe('max_steps');
  });
});
