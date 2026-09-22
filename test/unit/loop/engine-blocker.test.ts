/**
 * TUI-DESIGN §13.2 (retry events, the waker lifecycle, `paused: jev unreachable`) and §13.3 (one blocking mechanism for
 * every kind: jev-unreachable, key-rejected, spend-limit, checkpoint-degraded, drift; retry / continue / stop / login /
 * pin; the no-blocker default 'stop'), §19.4.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockingAnswer, BlockingRequest } from '../../../src/core/types.js';
import { JEV_UNREACHABLE_RETRY_MS } from '../../../src/loop/engine.js';
import type { Harness } from './fakes.js';
import { createFakeDecider, createFakeProvider, createFakeStore, makeEngine, turn } from './fakes.js';
import { JevHttpError } from '../../../src/errors.js';

const harnesses: Harness[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}
const read = () => turn({ kind: 'read', paths: ['src/a.py'] });

/** A blocker that records the requests and answers from a script (the last answer repeats). */
function scriptedBlocker(answers: BlockingAnswer[]): { blocker: (req: BlockingRequest) => Promise<BlockingAnswer>; requests: BlockingRequest[] } {
  const requests: BlockingRequest[] = [];
  return {
    requests,
    blocker: async (req) => {
      requests.push(req);
      return answers[Math.min(requests.length - 1, answers.length - 1)] ?? 'stop';
    },
  };
}

describe('retry events and the waker (§13.2)', () => {
  it('a 3-attempt Jev chain forwards two retry events, status().retrying during the sleep, then retry:settled ok with the total wait', async () => {
    const h = await build({ turns: [read()], deciderOptions: { retryAt: (ctx) => (ctx.stage === 'intent' && ctx.step === 1 ? { count: 2, waitMs: 40, status: 503 } : undefined) }, limits: { maxSteps: 1 } });
    let seenRetrying: ReturnType<Harness['engine']['status']>['retrying'] = null;
    h.engine.events.on('retry', () => {
      seenRetrying ??= h.engine.status().retrying;
    });
    const t0 = performance.now();
    await h.engine.run();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(75);
    const retries = h.of('retry');
    expect(retries.map((r) => [r.side, r.step, r.stage, r.info.attempt, r.info.maxAttempts, r.info.waitMs])).toEqual([['jev', 1, 'intent', 1, 3, 40], ['jev', 1, 'intent', 2, 3, 40]]);
    expect(seenRetrying).toMatchObject({ side: 'jev', attempt: 1, maxAttempts: 3 });
    expect(h.of('retry:settled')).toEqual([{ type: 'retry:settled', side: 'jev', step: 1, attempts: 3, ok: true, totalWaitMs: 80 }]);
    expect(h.engine.status().retrying).toBeNull();
    // §15.1: retry is pane-only, a short successful chain writes no transcript line
    expect(h.store.transcript.some((l) => /retry/.test(l))).toBe(false);
  });

  it('two [r] presses in one 3-attempt generator chain each shorten exactly one sleep; no spin afterwards; retryNow() is false outside a sleep', async () => {
    const provider = createFakeProvider([turn({ kind: 'read', paths: ['src/a.py'] }, {}, { retries: { count: 2, waitMs: 5_000, status: 529 } })]);
    const h = await build({ provider, limits: { maxSteps: 1 } });
    const presses: boolean[] = [];
    h.engine.events.on('retry', () => {
      setTimeout(() => presses.push(h.engine.retryNow()), 5);
    });
    const t0 = performance.now();
    const r = await h.engine.run();
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(r.steps).toBe(1);
    expect(presses).toEqual([true, true]);
    expect(h.of('retry').map((e) => e.side)).toEqual(['generator', 'generator']);
    expect(h.of('retry:settled')).toEqual([{ type: 'retry:settled', side: 'generator', step: 1, attempts: 3, ok: true, totalWaitMs: 10_000 }]);
    expect(h.engine.retryNow()).toBe(false);
  });

  it('an exhausted chain settles with ok: false and, without a blocker, keeps today\'s stage-failure path', async () => {
    const h = await build({ turns: [read()], deciderOptions: { retryAt: (ctx) => (ctx.stage === 'risk' ? { count: 1, waitMs: 5, status: 503, exhausted: true } : undefined) }, limits: { maxSteps: 1 } });
    const r = await h.engine.run();
    expect(h.of('retry:settled')).toEqual([{ type: 'retry:settled', side: 'jev', step: 1, attempts: 2, ok: false, totalWaitMs: 5 }]);
    expect(h.of('blocking:request')).toEqual([]);
    expect(r.steps).toBe(1);
    expect(h.store.steps[0]!.error).toMatchObject({ stage: 'risk', code: 'jev_http' });
  });
});

describe('jev-unreachable (§13.2, §13.3)', () => {
  it('session mode: the exhausted chain with no action executed discards the step and pauses; `retry` re-runs the step; counters and resumes untouched', async () => {
    let failures = 0;
    const decider = createFakeDecider({ retryAt: (ctx) => (ctx.stage === 'intent' && failures++ < 1 ? { count: 0, waitMs: 0, status: 503, exhausted: true } : undefined) });
    const script = scriptedBlocker(['retry']);
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 1 }, engine: { blocker: script.blocker } });
    let blockedStatus: string | null | undefined;
    h.engine.events.on('blocking:request', () => {
      blockedStatus = h.engine.status().blocked;
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(r.steps).toBe(1);
    expect(script.requests).toHaveLength(1);
    expect(script.requests[0]).toMatchObject({ kind: 'jev-unreachable', side: 'jev', step: 1, retryInMs: JEV_UNREACHABLE_RETRY_MS, stop: 'error', exitCode: 5 });
    expect(blockedStatus).toBe('jev-unreachable');
    expect(h.of('blocking:request')).toHaveLength(1);
    expect(h.of('blocking:resolved')).toEqual([{ type: 'blocking:resolved', id: script.requests[0]!.id, answer: 'retry', auto: false }]);
    // rule-1 discard: no failed record, the counter untouched, the failure never counted as a stage failure
    expect(h.store.steps).toHaveLength(1);
    expect(r.counters.failed).toBe(0);
    expect(h.store.last()!.consecutiveStageFailures).toBe(0);
    expect(h.store.last()!.resumes).toBe(0);
    expect(h.of('transcript').some((t) => /step 1 interrupted during intent \(jev-unreachable\); discarded/.test(t.text))).toBe(true);
    expect(h.engine.status().blocked).toBeNull();
  });

  it('consecutive pauses double the auto-retry interval (30 s, 60 s, …) and a reachable Jev resets it', async () => {
    let failures = 0;
    const decider = createFakeDecider({ retryAt: (ctx) => (ctx.stage === 'intent' && failures++ < 2 ? { count: 0, waitMs: 0, status: 0, exhausted: true } : undefined) });
    const script = scriptedBlocker(['retry']);
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 1 }, engine: { blocker: script.blocker } });
    const r = await h.engine.run();
    expect(r.steps).toBe(1);
    expect(script.requests.map((q) => q.retryInMs)).toEqual([JEV_UNREACHABLE_RETRY_MS, JEV_UNREACHABLE_RETRY_MS * 2]);
  });

  it('the auto-retry timer answers `retry` with auto: true when the human does not; retryNow() during the wait is a human retry', async () => {
    let failures = 0;
    const decider = createFakeDecider({ retryAt: (ctx) => (ctx.stage === 'intent' && failures++ < 1 ? { count: 0, waitMs: 0, status: 503, exhausted: true } : undefined) });
    const never = (): Promise<BlockingAnswer> => new Promise<BlockingAnswer>(() => undefined);
    // human path: [r] now through Engine.retryNow() ends the 30 s wait
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 1 }, engine: { blocker: never } });
    h.engine.events.on('blocking:request', () => {
      setTimeout(() => expect(h.engine.retryNow()).toBe(true), 10);
    });
    const r = await h.engine.run();
    expect(r.steps).toBe(1);
    expect(h.of('blocking:resolved')[0]).toMatchObject({ answer: 'retry', auto: false });

    // timer path with fake timers
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    failures = 0;
    const h2 = await build({ decider, turns: [read()], limits: { maxSteps: 1 }, engine: { blocker: never } });
    const running = h2.engine.run();
    for (let i = 0; i < 50 && h2.of('blocking:request').length === 0; i++) await vi.advanceTimersByTimeAsync(0);
    expect(h2.of('blocking:request')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(JEV_UNREACHABLE_RETRY_MS);
    const r2 = await running;
    expect(r2.steps).toBe(1);
    expect(h2.of('blocking:resolved')[0]).toMatchObject({ answer: 'retry', auto: true });
  });

  it('without a blocker the pause never happens: three failures → exit 5 as today (A165)', async () => {
    const h = await build({ turns: [read()], deciderOptions: { failAt: [{ stage: 'intent', status: 503 }] }, limits: { maxSteps: 5 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('error');
    expect(r.steps).toBe(3);
    expect(h.of('blocking:request')).toEqual([]);
    expect(h.of('run:end')[0]!.exitCode).toBe(5);
  });
});

describe('key-rejected and spend-limit (§13.3)', () => {
  it('a first-call 401 without a blocker: blocking:request then the default `stop` → run:end error with exit 2, zero steps, the step discarded', async () => {
    const h = await build({ turns: [read()], deciderOptions: { failAt: [{ stage: 'intent', status: 401 }] } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('error');
    expect(r.steps).toBe(0);
    expect(h.store.steps).toHaveLength(0);
    expect(r.error).toMatchObject({ code: 'jev_http', exitCode: 2, status: 401, side: 'jev' });
    const req = h.of('blocking:request')[0]!.request;
    expect(req).toMatchObject({ kind: 'key-rejected', side: 'jev', step: 1, stop: 'error', exitCode: 2 });
    expect(req.detail).toBe('HTTP 401 — "Jev HTTP 401"');
    expect(h.of('blocking:resolved')).toEqual([{ type: 'blocking:resolved', id: req.id, answer: 'stop', auto: false }]);
    expect(h.of('run:end')[0]!.exitCode).toBe(2);
    expect(h.store.last()!.interrupted).toMatchObject({ step: 1, stage: 'intent' });
    expect(h.store.last()!.stopReason).toBe('error');
  });

  it('a later 401 (key revoked mid-run) is a blocking pause too, not three failed steps; `login` retries with the current decider', async () => {
    let calls = 0;
    const decider = createFakeDecider({ retryAt: (ctx) => (ctx.stage === 'intent' && ctx.step === 2 && calls++ === 0 ? { count: 0, waitMs: 0, status: 401, exhausted: true } : undefined) });
    const script = scriptedBlocker(['login']);
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 2 }, engine: { blocker: script.blocker } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(r.steps).toBe(2);
    expect(script.requests.map((q) => [q.kind, q.step])).toEqual([['key-rejected', 2]]);
    expect(h.of('blocking:resolved')[0]!.answer).toBe('login');
    expect(r.counters.failed).toBe(0);
  });

  it('a generator 403 with a blocker answering `stop` exits 2 on the generator side', async () => {
    const provider = createFakeProvider([{ httpError: 403 }]);
    const script = scriptedBlocker(['stop']);
    const h = await build({ provider, engine: { blocker: script.blocker } });
    const r = await h.engine.run();
    expect(script.requests[0]).toMatchObject({ kind: 'key-rejected', side: 'generator', exitCode: 2 });
    expect(r.error).toMatchObject({ code: 'provider_http', exitCode: 2, status: 403, side: 'generator' });
    expect(h.of('run:end')[0]!.exitCode).toBe(2);
  });

  it('OpenRouter 402 and a spend-worded Anthropic 429 are spend-limit pauses (exit 5, no auto-retry); a plain 429 without a blocker stays a stage failure', async () => {
    const h = await build({ turns: [{ httpError: 402 }] });
    const r = await h.engine.run();
    expect(h.of('blocking:request')[0]!.request).toMatchObject({ kind: 'spend-limit', side: 'generator', stop: 'error', exitCode: 5 });
    expect(h.of('blocking:request')[0]!.request.retryInMs).toBeUndefined();
    expect(r.error).toMatchObject({ exitCode: 5, status: 402 });
    const h2 = await build({ turns: [{ httpError: 429, body: '{"error":{"type":"enforced_spend_limit_reached","message":"Your credit balance is too low"}}' }] });
    await h2.engine.run();
    expect(h2.of('blocking:request')[0]!.request.kind).toBe('spend-limit');
    const h3 = await build({ turns: [{ httpError: 429 }, read()], limits: { maxSteps: 2 } });
    const r3 = await h3.engine.run();
    expect(h3.of('blocking:request')).toEqual([]);
    expect(r3.steps).toBe(2);
    expect(h3.store.steps[0]!.error).toMatchObject({ stage: 'propose', code: 'provider_http' });
  });
});

describe('checkpoint-degraded (§13.3)', () => {
  const enospc = (file: string) => Object.assign(new Error(`ENOSPC: no space left on device, write '/runs/x/${file}.tmp-1'`), { code: 'ENOSPC' });

  it('a disk-class failure of state.json: one notice per (file, code), the pause; `continue` marks the run degraded (exit 3 even for max_steps, not resumable) and never pauses again', async () => {
    const store = createFakeStore();
    let fail = true;
    const realWrite = store.writeState.bind(store);
    store.writeState = async (state) => {
      if (fail) throw enospc('state.json');
      return realWrite(state);
    };
    const script = scriptedBlocker(['continue']);
    const h = await build({ store, turns: [read()], limits: { maxSteps: 3 }, engine: { blocker: script.blocker } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(r.steps).toBe(3);
    // once per (file, code) although state.json failed at every commit and at the end
    expect(h.of('notice').filter((n) => n.kind === 'checkpoint:degraded')).toEqual([{ type: 'notice', step: 1, kind: 'checkpoint:degraded', level: 'error', text: 'checkpoint degraded: ENOSPC on state.json — the disk is full; this run cannot be resumed' }]);
    expect(script.requests).toHaveLength(1);
    expect(script.requests[0]).toMatchObject({ kind: 'checkpoint-degraded', detail: 'ENOSPC on state.json', stop: 'error', exitCode: 3, step: 1 });
    expect(h.of('blocking:resolved')).toEqual([{ type: 'blocking:resolved', id: script.requests[0]!.id, answer: 'continue', auto: false }]);
    const end = h.of('run:end')[0]!;
    expect(end.exitCode).toBe(3);
    expect(end.resumable).toBe(false);
    expect(h.engine.snapshotState()?.checkpointDegraded).toBe(true);
    fail = false;
  });

  it('`retry` re-attempts the write: success → checkpoint:restored; `stop` → error with exit 3', async () => {
    const store = createFakeStore();
    let failures = 1;
    const realWrite = store.writeState.bind(store);
    store.writeState = async (state) => {
      if (failures-- > 0) throw enospc('state.json');
      return realWrite(state);
    };
    const script = scriptedBlocker(['retry']);
    const h = await build({ store, turns: [read()], limits: { maxSteps: 2 }, engine: { blocker: script.blocker } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(r.steps).toBe(2);
    expect(h.of('notice').filter((n) => n.kind !== 'lock').map((n) => n.kind)).toEqual(['checkpoint:degraded', 'checkpoint:restored']);
    // the failure surfaced in the overlapped checkpoint of step 1: step 2 was discarded before execute (§13.3) and re-run after the answer
    expect(h.of('transcript').some((t) => /checkpoint-degraded before execute; step 2 discarded/.test(t.text))).toBe(true);
    expect(h.of('step:start').map((e) => e.step)).toEqual([1, 2, 2]);
    expect(script.requests).toHaveLength(1);
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
    expect(h.engine.snapshotState()?.checkpointDegraded).toBeUndefined();

    const store2 = createFakeStore();
    store2.writeState = async () => {
      throw enospc('state.json');
    };
    const stop = scriptedBlocker(['stop']);
    const h2 = await build({ store: store2, turns: [read()], limits: { maxSteps: 2 }, engine: { blocker: stop.blocker } });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('error');
    expect(r2.steps).toBe(1);
    expect(r2.error).toMatchObject({ code: 'checkpoint', exitCode: 3 });
    expect(h2.of('run:end')[0]).toMatchObject({ exitCode: 3, resumable: false });
    // every state.json write failed: the in-memory snapshot carries the rule-1 discard of step 2
    expect(h2.engine.snapshotState()!.interrupted).toMatchObject({ step: 2, stage: 'execute' });
    expect(h2.store.states).toEqual([]);
  });

  it('a disk-class failure of another artefact is a notice only, and a non-disk failure keeps today\'s error event without a pause', async () => {
    const store = createFakeStore();
    store.appendJevRequest = async () => {
      throw enospc('jev.jsonl');
    };
    const h = await build({ store, turns: [read()], limits: { maxSteps: 1 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    const degraded = h.of('notice').filter((n) => n.kind === 'checkpoint:degraded');
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.text).toBe('checkpoint degraded: ENOSPC on jev.jsonl — the disk is full; this run cannot be resumed');
    expect(h.of('blocking:request')).toEqual([]);
    expect(h.of('run:end')[0]!.exitCode).toBe(4);
    const store2 = createFakeStore();
    store2.writeState = async () => {
      throw new Error('boom');
    };
    const h2 = await build({ store: store2, turns: [read()], limits: { maxSteps: 1 } });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('max_steps');
    expect(h2.of('blocking:request')).toEqual([]);
    expect(h2.of('notice').filter((n) => n.kind !== 'lock')).toEqual([]);
    expect(h2.of('error').some((e) => e.error.message === 'boom')).toBe(true);
  });
});

describe('first-call drift (§13.3)', () => {
  it('with a blocker the first-call alias drift is a pane: `pin` records nothing here and stops with exit 2; without one today\'s abort stays', async () => {
    const script = scriptedBlocker(['pin']);
    const h = await build({ decider: createFakeDecider({ model: 'typesafe/jev-1.13-20270101' }), turns: [read()], engine: { blocker: script.blocker } });
    const r = await h.engine.run();
    expect(script.requests[0]).toMatchObject({ kind: 'drift', side: 'jev', step: 1, detail: 'typesafe/jev-1.13-20260917 → typesafe/jev-1.13-20270101', stop: 'error', exitCode: 2 });
    expect(h.of('blocking:resolved')[0]!.answer).toBe('pin');
    expect(r.stopReason).toBe('error');
    expect(r.steps).toBe(0);
    expect(r.error).toMatchObject({ code: 'jev_model_drift', exitCode: 2 });
    expect(h.of('run:end')[0]!.exitCode).toBe(2);
    expect(h.store.last()!.interrupted).toMatchObject({ step: 1, stage: 'intent' });
  });
});

describe('classifyBlocking is pure (§13.3): a discarded classification moves no counter', () => {
  it('an exhausted Jev chain in the judge stage (an action ran: no pause) does not advance the jev-unreachable backoff or the blocking sequence — the next real pause still waits 30 s and is block 1', async () => {
    let judgeFailed = false;
    let intentFailed = false;
    const decider = createFakeDecider({
      retryAt: (ctx) => {
        if (ctx.stage === 'judge' && ctx.step === 1 && !judgeFailed) {
          judgeFailed = true;
          return { count: 0, waitMs: 0, status: 503, exhausted: true };
        }
        if (ctx.stage === 'intent' && ctx.step === 2 && !intentFailed) {
          intentFailed = true;
          return { count: 0, waitMs: 0, status: 503, exhausted: true };
        }
        return undefined;
      },
    });
    const script = scriptedBlocker(['retry']);
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 2 }, engine: { blocker: script.blocker } });
    const r = await h.engine.run();
    expect(r.steps).toBe(2);
    // step 1 committed unjudged (rule 3 shape: the action ran), no pane
    expect(h.store.steps[0]!.error).toMatchObject({ stage: 'judge', code: 'jev_http' });
    expect(h.store.steps[0]!.outcome?.status).toBe('executed');
    // step 2's intent failure is the first pause: 30 s, id …:block:1 (nothing was allocated for the judge failure)
    expect(script.requests).toHaveLength(1);
    expect(script.requests[0]).toMatchObject({ kind: 'jev-unreachable', step: 2, retryInMs: JEV_UNREACHABLE_RETRY_MS, id: `${h.engine.runId}:block:1` });
    expect(h.of('blocking:request')).toHaveLength(1);
  });

  it('a second failure while a pane is already up (a disk failure of the overlapped checkpoint, then a Jev 503 in the next step) keeps the first pane and allocates no second id', async () => {
    const store = createFakeStore();
    let fail = 1;
    const realWrite = store.writeState.bind(store);
    store.writeState = async (state) => {
      if (fail-- > 0) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return realWrite(state);
    };
    let failures = 0;
    const decider = createFakeDecider({ retryAt: (ctx) => (ctx.stage === 'intent' && ctx.step === 2 && failures++ < 1 ? { count: 0, waitMs: 0, status: 503, exhausted: true } : undefined) });
    const script = scriptedBlocker(['retry']);
    const h = await build({ store, decider, turns: [read()], limits: { maxSteps: 2 }, engine: { blocker: script.blocker } });
    const r = await h.engine.run();
    expect(r.steps).toBe(2);
    expect(script.requests.map((q) => [q.kind, q.id])).toEqual([['checkpoint-degraded', `${h.engine.runId}:block:1`]]);
    // the 503 arrived while the checkpoint pane was pending → discarded without a second request; the retry re-ran step 2 cleanly
    expect(h.of('blocking:request')).toHaveLength(1);
    expect(h.of('step:start').map((e) => e.step)).toEqual([1, 2, 2]);
  });
});

describe('abort while a blocking pane is up (§13.3, §3.3)', () => {
  it('Ctrl-C / SIGTERM during the pane: blocking:resolved { answer: stop }, the run ends with the abort\'s reason (not error), and the blocker\'s later answer is ignored', async () => {
    let resolveBlocker: ((a: BlockingAnswer) => void) | null = null;
    const blocker = (): Promise<BlockingAnswer> => new Promise<BlockingAnswer>((resolve) => (resolveBlocker = resolve));
    let failures = 0;
    const decider = createFakeDecider({ retryAt: (ctx) => (ctx.stage === 'intent' && failures++ < 1 ? { count: 0, waitMs: 0, status: 503, exhausted: true } : undefined) });
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 2 }, engine: { blocker } });
    h.engine.events.on('blocking:request', () => {
      setTimeout(() => h.engine.abort('signal', { signal: 'SIGTERM' }), 10);
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('signal');
    expect(r.steps).toBe(0);
    expect(h.of('blocking:resolved')).toEqual([{ type: 'blocking:resolved', id: expect.any(String), answer: 'stop', auto: false }]);
    expect(h.of('run:end')[0]!.exitCode).toBe(143);
    expect(r.error).toBeUndefined();
    // a late human answer changes nothing
    resolveBlocker!('retry');
    await new Promise((res) => setTimeout(res, 20));
    expect(h.of('blocking:resolved')).toHaveLength(1);
    expect(h.of('step:start')).toHaveLength(1);
    expect(h.store.last()!.stopReason).toBe('signal');
    // human_abort variant
    failures = 0;
    const h2 = await build({ decider, turns: [read()], limits: { maxSteps: 2 }, engine: { blocker } });
    h2.engine.events.on('blocking:request', () => {
      setTimeout(() => h2.engine.abort('human_abort'), 10);
    });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('human_abort');
    expect(h2.of('run:end')[0]!.exitCode).toBe(130);
  });
});

describe('key-rejected and spend-limit on the Jev side (§13.3)', () => {
  it('first-call 401 with a blocker answering `retry` ([r] retry with the current key): the step re-runs from intent, resumes and counters unchanged', async () => {
    let calls = 0;
    const decider = createFakeDecider({ retryAt: (ctx) => (ctx.stage === 'intent' && calls++ === 0 ? { count: 0, waitMs: 0, status: 401, exhausted: true } : undefined) });
    const script = scriptedBlocker(['retry']);
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 1 }, engine: { blocker: script.blocker } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(r.steps).toBe(1);
    expect(script.requests.map((q) => [q.kind, q.side, q.step, q.exitCode])).toEqual([['key-rejected', 'jev', 1, 2]]);
    expect(h.of('step:start').map((e) => e.step)).toEqual([1, 1]);
    expect(h.of('stage:start').filter((e) => e.stage === 'intent')).toHaveLength(2);
    expect(r.counters.failed).toBe(0);
    expect(h.store.last()!.resumes).toBe(0);
    expect(h.store.last()!.consecutiveStageFailures).toBe(0);
    expect(h.of('run:end')[0]!.exitCode).toBe(4);
  });

  it('a Jev 402 is a spend-limit pause on the jev side (exit 5, no auto-retry); [q] stops with the http error as the fatal error', async () => {
    const decider = createFakeDecider({ failAt: [{ stage: 'intent', status: 402 }] });
    const script = scriptedBlocker(['stop']);
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 2 }, engine: { blocker: script.blocker } });
    const r = await h.engine.run();
    expect(script.requests[0]).toMatchObject({ kind: 'spend-limit', side: 'jev', step: 1, stop: 'error', exitCode: 5 });
    expect(script.requests[0]!.retryInMs).toBeUndefined();
    expect(r.stopReason).toBe('error');
    expect(r.error).toMatchObject({ code: 'jev_http', exitCode: 5, status: 402, side: 'jev' });
    expect(h.of('run:end')[0]!.exitCode).toBe(5);
    void JevHttpError;
  });
});

describe('retryNow() on the Jev side and during a pane wait (§13.2)', () => {
  it('[r] shortens exactly one Jev retry sleep per press', async () => {
    const h = await build({ turns: [read()], deciderOptions: { retryAt: (ctx) => (ctx.stage === 'intent' && ctx.step === 1 ? { count: 2, waitMs: 5_000, status: 503 } : undefined) }, limits: { maxSteps: 1 } });
    const presses: boolean[] = [];
    h.engine.events.on('retry', () => {
      setTimeout(() => presses.push(h.engine.retryNow()), 5);
    });
    const t0 = performance.now();
    const r = await h.engine.run();
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(r.steps).toBe(1);
    expect(presses).toEqual([true, true]);
    expect(h.of('retry').map((e) => [e.side, e.info.attempt])).toEqual([['jev', 1], ['jev', 2]]);
    expect(h.of('retry:settled')).toEqual([{ type: 'retry:settled', side: 'jev', step: 1, attempts: 3, ok: true, totalWaitMs: 10_000 }]);
    expect(h.engine.retryNow()).toBe(false);
  });

  it('an exhausted chain that ends in a jev-unreachable pane: [r] shortens the chain\'s sleeps, retry:settled ok: false, then [r] during the pane wait is a human retry and the step re-runs', async () => {
    let failures = 0;
    const decider = createFakeDecider({ retryAt: (ctx) => (ctx.stage === 'intent' && failures++ < 1 ? { count: 2, waitMs: 5_000, status: 503, exhausted: true } : undefined) });
    const never = (): Promise<BlockingAnswer> => new Promise<BlockingAnswer>(() => undefined);
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 1 }, engine: { blocker: never } });
    const presses: boolean[] = [];
    h.engine.events.on('retry', () => {
      setTimeout(() => presses.push(h.engine.retryNow()), 5);
    });
    h.engine.events.on('blocking:request', () => {
      setTimeout(() => presses.push(h.engine.retryNow()), 5);
    });
    const t0 = performance.now();
    const r = await h.engine.run();
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(r.steps).toBe(1);
    expect(presses).toEqual([true, true, true]);
    expect(h.of('retry:settled')).toEqual([{ type: 'retry:settled', side: 'jev', step: 1, attempts: 3, ok: false, totalWaitMs: 10_000 }]);
    expect(h.of('blocking:request')[0]!.request).toMatchObject({ kind: 'jev-unreachable', retryInMs: JEV_UNREACHABLE_RETRY_MS });
    expect(h.of('blocking:resolved')[0]).toMatchObject({ answer: 'retry', auto: false });
    expect(h.engine.retryNow()).toBe(false);
  });
});

describe('drift pane answers (§13.3)', () => {
  it('any answer other than [p]/[q] — `retry`, `login`, `continue` — ends the run with exit 2 too: the run never continues on the drifted model', async () => {
    for (const a of ['retry', 'login', 'continue'] as const) {
      const script = scriptedBlocker([a]);
      const h = await build({ decider: createFakeDecider({ model: 'typesafe/jev-1.13-20270101' }), turns: [read()], limits: { maxSteps: 2 }, engine: { blocker: script.blocker } });
      const r = await h.engine.run();
      expect(script.requests.map((q) => q.kind)).toEqual(['drift']);
      expect(h.of('blocking:resolved')[0]!.answer).toBe(a);
      expect(r.stopReason).toBe('error');
      expect(r.steps).toBe(0);
      expect(r.error).toMatchObject({ code: 'jev_model_drift', exitCode: 2 });
      expect(h.of('run:end')[0]!.exitCode).toBe(2);
      // a single intent call: nothing re-ran on the drifted model
      expect(h.decider.callsAt('intent')).toHaveLength(1);
      expect(h.store.meta!.resolvedJevModel).toBeNull();
    }
  });
});

describe('checkpoint-degraded at the end and across --resume (§13.3, §13.5)', () => {
  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write '/runs/x/state.json.tmp-1'"), { code: 'ENOSPC' });

  it('the FINAL state.json write failing with a disk-class error (no earlier failure, no blocker): checkpoint:degraded notice, run:end exitCode 3, resumable false, no pane requested', async () => {
    const store = createFakeStore();
    const realWrite = store.writeState.bind(store);
    store.writeState = async (state) => {
      if (state.stopReason !== null) throw enospc();
      return realWrite(state);
    };
    const h = await build({ store, turns: [read()], limits: { maxSteps: 2 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(r.steps).toBe(2);
    expect(h.of('notice').filter((n) => n.kind === 'checkpoint:degraded')).toEqual([{ type: 'notice', step: null, kind: 'checkpoint:degraded', level: 'error', text: 'checkpoint degraded: ENOSPC on state.json — the disk is full; this run cannot be resumed' }]);
    expect(h.of('blocking:request')).toEqual([]);
    expect(h.engine.status().blocked).toBeNull();
    const end = h.of('run:end')[0]!;
    expect(end.exitCode).toBe(3);
    expect(end.resumable).toBe(false);
    // the two per-step checkpoints landed; the final one did not
    expect(h.store.states.map((s) => s.stopReason)).toEqual([null, null]);
    expect(h.of('transcript').some((t) => t.text === 'final checkpoint write failed')).toBe(true);
    // the same with a blocker: the final write has no loop top left to pause at — still exit 3, still no pane
    const store2 = createFakeStore();
    const realWrite2 = store2.writeState.bind(store2);
    store2.writeState = async (state) => {
      if (state.stopReason !== null) throw enospc();
      return realWrite2(state);
    };
    const script = scriptedBlocker(['retry']);
    const h2 = await build({ store: store2, turns: [read()], limits: { maxSteps: 1 }, engine: { blocker: script.blocker } });
    await h2.engine.run();
    expect(script.requests).toEqual([]);
    expect(h2.of('run:end')[0]).toMatchObject({ exitCode: 3, resumable: false });
  });

  it('checkpointDegraded is not inherited by --resume: a run degraded by [c] continue resumes healthy (exit 4, resumable) when its writes succeed', async () => {
    const store = createFakeStore();
    let fail = true;
    const realWrite = store.writeState.bind(store);
    store.writeState = async (state) => {
      if (fail) throw enospc();
      return realWrite(state);
    };
    const script = scriptedBlocker(['continue']);
    const h = await build({ store, turns: [read()], limits: { maxSteps: 2 }, engine: { blocker: script.blocker } });
    // the run continues without checkpoints; the last write is allowed through so a state.json exists to resume from
    h.engine.events.on('step:end', (e) => {
      if (e.record.step === 2) fail = false;
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 3, resumable: false });
    expect(store.last()!.checkpointDegraded).toBe(true);
    const h2 = await build({ store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [read()], limits: { maxSteps: 3 }, engine: { blocker: script.blocker } });
    expect(h2.engine.snapshotState()!.checkpointDegraded).toBeUndefined();
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('max_steps');
    expect(r2.steps).toBe(3);
    expect(h2.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
    expect(store.last()!.checkpointDegraded).toBeUndefined();
    expect(h2.of('blocking:request')).toEqual([]);
  });
});

