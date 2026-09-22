/**
 * contract 1.4 (docs/COORDINATION-DESIGN.md §7.2–§7.4, §12.0.2): the pause points P1–P8 over the fakes — where each lands,
 * what is persisted, the `pause:point` event and its order, `EngineStatus.pausePoint` / `pauseNow`, the WAIT-never-kill
 * rule with an execute in flight, the exit-code table (a later abort wins over a pause-now), idempotency / upgrade, `end`
 * with its `--force` gate, and remote pause / end through `deliver()`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BlockingAnswer, BlockingRequest, EngineEvent, GenerateRequest, GenerateResult, PausePoint, Proposal, Synthesizer } from '../../../src/core/types.js';
import { ConfigError } from '../../../src/errors.js';
import type { FakeProvider, Harness } from './fakes.js';
import { createFakeDecider, createFakeProvider, createFakeSandbox, createFakeStore, makeEngine, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}
const read = () => turn({ kind: 'read', paths: ['src/a.py'] });
const never = (): Promise<BlockingAnswer> => new Promise<BlockingAnswer>(() => undefined);
const PEER = { deviceId: 'k3q7m2ab', label: 'mbp', sessionId: '20260921-234432-rpywkq2v', runId: null };

function point(h: Harness): PausePoint {
  const ev = h.of('pause:point');
  expect(ev).toHaveLength(1);
  return ev[0]!.point;
}

/** the index of the first event matching `pred` in the harness's event log */
function indexOf(h: Harness, pred: (e: EngineEvent) => boolean): number {
  return h.events.findIndex(pred);
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!cond()) throw new Error('condition not met');
}

// ---------------------------------------------------------------------------------------
// llm-jev helpers: a provider whose sample 0 ignores the abort (a late arrival), and the synthesizers that fire them
// ---------------------------------------------------------------------------------------

function result(k: number): GenerateResult {
  return { text: `sample ${k}`, toolCalls: [{ name: 'propose_action', input: { k }, rawJson: JSON.stringify({ k }) }], usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.004, calls: 1 }, model: 'z-ai/glm-5.3-flash', stopReason: 'tool_use', latencyMs: 100, generationId: `gen-${k}` };
}

interface LatchedProvider extends FakeProvider {
  /** one entry per dispatched sample, in order */
  pending: (number | undefined)[];
  /** settle the sample that ignores the abort */
  resolveSample0(r: GenerateResult): void;
}

/** sample 0 never reacts to the abort (it lands when the test says so); every other sample rejects with the signal's reason */
function latchedProvider(): LatchedProvider {
  const requests: GenerateRequest[] = [];
  const pending: (number | undefined)[] = [];
  let resolve0: ((r: GenerateResult) => void) | null = null;
  return {
    name: 'mock',
    model: 'z-ai/glm-5.3-flash',
    requests,
    pending,
    resolveSample0: (r) => resolve0?.(r),
    generate(req, o) {
      requests.push(req);
      pending.push(o.sample);
      if (o.sample === 0) return new Promise<GenerateResult>((res) => (resolve0 = res));
      return new Promise<GenerateResult>((_res, rej) => {
        if (o.signal.aborted) {
          rej(o.signal.reason);
          return;
        }
        o.signal.addEventListener('abort', () => rej(o.signal.reason), { once: true });
      });
    },
  };
}

const SAMPLE_REQ: GenerateRequest = { system: 'sys', messages: [{ role: 'user', content: 'fix f' }], maxTokens: 1500, temperature: 0.7 };
const PROPOSAL: Proposal = { goal: 'read after the round', action: { kind: 'read', paths: ['src/a.py'] }, plan: { done: [], remaining: ['fix f'], openProblems: [] }, rawText: '' };

/** fires sample 0 without awaiting it (it arrives after the discard) and awaits sample 1, which the abort cuts */
function lateSampleSynth(): Synthesizer {
  return {
    name: 'late-sample',
    async synthesize(ctx) {
      const gen = ctx.generate;
      if (gen === undefined) throw new Error('llm-jev must expose SynthesisContext.generate');
      void gen({ ...SAMPLE_REQ, seed: 0 }, { sample: 0, purpose: 'propose_fix', signal: new AbortController().signal, goalId: 'g1', goalRound: 1 }).catch(() => undefined);
      await gen({ ...SAMPLE_REQ, seed: 1 }, { sample: 1, purpose: 'propose_fix', signal: new AbortController().signal, goalId: 'g1', goalRound: 1 });
      return PROPOSAL;
    },
  };
}

/** one sample that ignores the abort: it arrives (and proposes) after the pause snapshot was taken */
function oneLateSampleSynth(): Synthesizer {
  return {
    name: 'one-late-sample',
    async synthesize(ctx) {
      const gen = ctx.generate;
      if (gen === undefined) throw new Error('llm-jev must expose SynthesisContext.generate');
      await gen({ ...SAMPLE_REQ, seed: 0 }, { sample: 0, purpose: 'propose_fix', signal: new AbortController().signal, goalId: 'g1', goalRound: 1 });
      return PROPOSAL;
    },
  };
}

describe('P1 — step boundary', () => {
  it('pause at step: the in-flight step commits, the point is the boundary, the event lands after status and before the stop line and run:end', async () => {
    const h = await build({ turns: [read(), read(), read()], limits: { maxSteps: 3 } });
    h.engine.events.on('step:start', (e) => {
      if (e.step === 1) h.engine.pause();
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(1);
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
    const p = point(h);
    expect(p).toEqual({ step: 2, round: null, phase: 'idle', reason: 'step', resumableAt: 'boundary', replayable: false, by: 'self', end: false });
    // order: … status → pause:point → transcript stop line → run:end
    const iPoint = indexOf(h, (e) => e.type === 'pause:point');
    const iStop = indexOf(h, (e) => e.type === 'transcript' && /^stop: human_pause/.test(e.text));
    const iEnd = indexOf(h, (e) => e.type === 'run:end');
    expect(iPoint).toBeGreaterThan(0);
    expect(iPoint).toBeLessThan(iStop);
    expect(iStop).toBeLessThan(iEnd);
    expect(h.events[iPoint - 1]?.type).toBe('status');
    // the state carries the same object; status() reads it until run:end; a fresh engine reads null
    expect(h.store.last()!.pausePoint).toEqual(p);
    expect(h.store.last()!.interruptedDetail).toBeUndefined();
    expect(h.engine.status().pausePoint).toEqual(p);
    expect(h.engine.status().pauseNow).toBe(false);
    // the transcript is unchanged by the event (pause:point yields no line)
    expect(h.store.transcript.at(-2)).toBe('[run] warn: stop: human_pause at step 1');
  });

  it('pause now between steps (before run) is the same as pause at step: nothing to interrupt, zero steps, exit 4', async () => {
    const h = await build({ turns: [read()], limits: { maxSteps: 2 } });
    h.engine.pause({ at: 'now' });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(0);
    expect(h.provider.requests).toHaveLength(0);
    expect(point(h)).toMatchObject({ step: 1, phase: 'idle', reason: 'step', resumableAt: 'boundary', replayable: false });
    expect(h.of('pause:requested')).toEqual([{ type: 'pause:requested', step: 1 }]);
    expect(h.store.cache.size).toBe(0);
  });

  it('a fresh and a resumed engine start with pausePoint null; the resumed run drops the stored point at its next checkpoint', async () => {
    const h = await build({ turns: [read(), read()], limits: { maxSteps: 2 } });
    expect(h.engine.status().pausePoint).toBeNull();
    h.engine.events.on('step:end', () => h.engine.pause());
    await h.engine.run();
    expect(h.store.last()!.pausePoint).toBeDefined();
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [read(), read()], limits: { maxSteps: 2 } });
    expect(h2.engine.status().pausePoint).toBeNull();
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('max_steps');
    expect(h.store.last()!.pausePoint).toBeUndefined();
    expect(h2.of('pause:point')).toEqual([]);
  });
});

describe('P2 — mid-stage, nothing executed', () => {
  it('pause now during propose (generator streaming): the step is discarded under rule 1, the cache file is written, run:end lands in < 500 ms', async () => {
    const provider = createFakeProvider([turn({ kind: 'read', paths: ['src/a.py'] }, {}, { delayMs: 5_000 })]);
    const h = await build({ provider, limits: { maxSteps: 3 } });
    let pausedAt = 0;
    h.engine.events.on('generator:start', () => {
      pausedAt = performance.now();
      h.engine.pause({ at: 'now' });
    });
    const r = await h.engine.run();
    const endedAt = performance.now();
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(0);
    expect(endedAt - pausedAt).toBeLessThan(500);
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
    expect(h.of('transcript').some((t) => /step 1 interrupted during propose \(human_pause\); discarded/.test(t.text))).toBe(true);
    // the point: the discarded step's own number, the stage in flight, the cache file; nothing arrived → not replayable
    const p = point(h);
    expect(p).toEqual({ step: 1, round: null, phase: 'propose', reason: 'now', resumableAt: 'cache/step-1.json', replayable: false, by: 'self', end: false });
    // persisted: cache/step-1.json, then state.json with interrupted + interruptedDetail
    const cache = h.store.cache.get('step-1.json');
    expect(cache).toMatchObject({ v: 1, step: 1, stage: 'propose', proposal: null, llmRound: null, targets: [] });
    const last = h.store.last()!;
    expect(last.interrupted).toEqual({ step: 1, stage: 'propose', proposal: null });
    expect(last.interruptedDetail).toEqual({ cache: 'cache/step-1.json', resumes: 1, at: expect.any(String), targetsSha: {}, replayable: false, partialChars: 0 });
    expect(last.pausePoint).toEqual(p);
    expect(h.store.steps).toHaveLength(0);
  });

  it('pause now during risk (a proposal exists): replayable, the proposal and its targets are cached; the event order holds', async () => {
    const decider = createFakeDecider({ delayMs: (ctx) => (ctx.stage === 'risk' ? 5_000 : 0) });
    const h = await build({ decider, turns: [turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' })], limits: { maxSteps: 2 } });
    h.engine.events.on('stage:start', (e) => {
      if (e.stage === 'risk') h.engine.pause({ at: 'now' });
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    const p = point(h);
    expect(p).toMatchObject({ step: 1, phase: 'risk', reason: 'now', resumableAt: 'cache/step-1.json', replayable: true });
    const last = h.store.last()!;
    expect(last.interrupted?.proposal?.action).toEqual({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' });
    // the edit's target is hashed (the fake workspace holds the file in memory, so on disk it is missing → null, a fact the gate re-checks)
    expect(last.interruptedDetail).toMatchObject({ cache: 'cache/step-1.json', replayable: true, targetsSha: { 'src/a.py': null } });
    expect(h.store.cache.get('step-1.json')).toMatchObject({ v: 1, step: 1, stage: 'risk', targets: [{ rel: 'src/a.py', sha256: null }], partial: { chars: expect.any(Number) } });
    // order: pause:requested → (transcript: discarded) → status → pause:point → stop line → run:end
    const types = h.events.map((e) => e.type);
    const iReq = types.indexOf('pause:requested');
    const iDisc = indexOf(h, (e) => e.type === 'transcript' && /discarded/.test(e.text));
    const iPoint = types.indexOf('pause:point');
    const iEnd = types.indexOf('run:end');
    expect(iReq).toBeLessThan(iDisc);
    expect(iDisc).toBeLessThan(iPoint);
    expect(iPoint).toBeLessThan(iEnd);
  });

  it('a cache write failure is a notice only: exit 4, resumable, the point says replayable false and resumableAt boundary', async () => {
    const decider = createFakeDecider({ delayMs: (ctx) => (ctx.stage === 'risk' ? 5_000 : 0) });
    const store = createFakeStore();
    store.failCache = Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
    const h = await build({ decider, store, turns: [read()], limits: { maxSteps: 2 } });
    h.engine.events.on('stage:start', (e) => {
      if (e.stage === 'risk') h.engine.pause({ at: 'now' });
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
    expect(point(h)).toMatchObject({ step: 1, phase: 'risk', reason: 'now', resumableAt: 'boundary', replayable: false });
    expect(h.store.last()!.interruptedDetail).toMatchObject({ replayable: false });
    expect(h.of('transcript').some((t) => /cache\/step-1\.json write failed/.test(t.text))).toBe(true);
    expect(h.of('notice').some((n) => n.kind === 'checkpoint:degraded' && /cache\/step-1\.json/.test(n.text))).toBe(true);
    expect(h.of('blocking:request')).toEqual([]);
  });
});

describe('P4 — mid-command: WAIT, never kill', () => {
  it('pause now during execute never aborts the controller: the command runs to its end, the judge is skipped, the step commits, then the run pauses', async () => {
    const sandbox = createFakeSandbox(() => ({ delayMs: 120, result: { exitCode: 0, stdout: '2 passed in 0.10s\n' } }));
    const h = await build({ sandbox, turns: [turn({ kind: 'run', command: 'pytest -q' }), read()], limits: { maxSteps: 3 } });
    let statusDuringExecute: ReturnType<Harness['engine']['status']> | null = null;
    let killsAtOutcome = -1;
    h.engine.events.on('exec:start', () => {
      h.engine.pause({ at: 'now' });
      statusDuringExecute = h.engine.status();
    });
    h.engine.events.on('outcome', () => {
      killsAtOutcome = h.sandbox.killAllCalls;
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(1);
    expect(killsAtOutcome).toBe(0);
    expect(statusDuringExecute).toMatchObject({ stage: 'execute', pausing: true, pauseNow: true });
    const rec = h.store.steps[0]!;
    expect(rec.outcome?.status).toBe('executed');
    expect(rec.judge).toBeNull();
    expect(rec.completion).toBeNull();
    expect(rec.interruptedAt).toEqual({ stage: 'judge', reason: 'human_pause' });
    expect(h.decider.callsAt('judge')).toEqual([]);
    expect(h.store.last()!.window.at(-1)?.notes).toContain('interrupted before judge');
    expect(point(h)).toEqual({ step: 2, round: null, phase: 'idle', reason: 'now-after-execute', resumableAt: 'boundary', replayable: false, by: 'self', end: false });
    expect(h.store.cache.size).toBe(0);
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
  });

  it('a true kill is still abort(): Esc Esc during execute commits the step as interrupted with exit 130', async () => {
    const sandbox = createFakeSandbox(() => ({ hang: true }));
    const h = await build({ sandbox, turns: [turn({ kind: 'run', command: 'sleep 100' })], limits: { maxSteps: 2 } });
    h.engine.events.on('exec:start', () => {
      h.engine.pause({ at: 'now' });
      setTimeout(() => h.engine.abort('human_abort'), 20);
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_abort');
    expect(r.steps).toBe(1);
    expect(h.store.steps[0]!.outcome?.status).toBe('interrupted');
    expect(h.store.steps[0]!.interruptedAt).toEqual({ stage: 'execute', reason: 'human_abort' });
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 130, resumable: true });
    expect(h.of('pause:point')).toEqual([]);
  });
});

describe('P5 — judge in flight', () => {
  it('pause now during judge aborts the Jev call; rule 3 commits the executed action with judge null; the point is the boundary', async () => {
    const decider = createFakeDecider({ delayMs: (ctx) => (ctx.stage === 'judge' ? 5_000 : 0) });
    const h = await build({ decider, turns: [read(), read()], limits: { maxSteps: 3 } });
    h.engine.events.on('stage:start', (e) => {
      if (e.stage === 'judge') h.engine.pause({ at: 'now' });
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(1);
    const rec = h.store.steps[0]!;
    expect(rec.outcome?.status).toBe('executed');
    expect(rec.judge).toBeNull();
    expect(rec.interruptedAt).toEqual({ stage: 'judge', reason: 'human_pause' });
    expect(point(h)).toMatchObject({ step: 2, phase: 'idle', reason: 'now-after-execute', resumableAt: 'boundary', replayable: false });
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
  });
});

describe('P6 — a blocking pane is open', () => {
  it('pause() while jev-unreachable is awaited wakes the blocker with `pause`: human_pause, exit 4, no adopted error, the pane named on the point', async () => {
    const decider = createFakeDecider({ retryAt: (ctx) => (ctx.stage === 'intent' ? { count: 0, waitMs: 0, status: 503, exhausted: true } : undefined) });
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 2 }, engine: { blocker: never } });
    h.engine.events.on('blocking:request', () => {
      setTimeout(() => h.engine.pause(), 5);
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(r.error).toBeUndefined();
    expect(r.steps).toBe(0);
    expect(h.of('blocking:resolved')).toEqual([{ type: 'blocking:resolved', id: h.of('blocking:request')[0]!.request.id, answer: 'pause', auto: false }]);
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
    expect(point(h)).toEqual({ step: 1, round: null, phase: 'pane', reason: 'pane', resumableAt: 'boundary', replayable: false, pane: 'jev-unreachable', by: 'self', end: false });
    expect(h.store.last()!.interrupted).toEqual({ step: 1, stage: 'intent', proposal: null });
    expect(h.engine.status().blocked).toBe('jev-unreachable');
  });

  it('pause now while a pane is open is identical (nothing is in flight)', async () => {
    const decider = createFakeDecider({ retryAt: (ctx) => (ctx.stage === 'intent' ? { count: 0, waitMs: 0, status: 503, exhausted: true } : undefined) });
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 2 }, engine: { blocker: never } });
    h.engine.events.on('blocking:request', () => {
      setTimeout(() => h.engine.pause({ at: 'now' }), 5);
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(h.of('blocking:resolved')[0]).toMatchObject({ answer: 'pause' });
    expect(point(h)).toMatchObject({ phase: 'pane', pane: 'jev-unreachable', reason: 'pane' });
    expect(h.store.cache.size).toBe(0);
  });

  it('checkpoint-degraded is the second exception (review #26): pause() there reads as [r] retry — the write lands, then the loop top pauses (exit 4)', async () => {
    const store = createFakeStore();
    let fail = true;
    const realWrite = store.writeState.bind(store);
    store.writeState = async (state) => {
      if (fail) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      return realWrite(state);
    };
    const h = await build({ store, turns: [read(), read()], limits: { maxSteps: 3 }, engine: { blocker: never } });
    h.engine.events.on('blocking:request', (e) => {
      expect(e.request.kind).toBe('checkpoint-degraded');
      fail = false; // the retry the pause triggers finds the disk healthy again
      setTimeout(() => h.engine.pause(), 5);
    });
    const r = await h.engine.run();
    expect(h.of('blocking:resolved')[0]).toMatchObject({ answer: 'pause' });
    // the retry ran and succeeded before the pause was taken
    expect(h.of('notice').some((n) => n.kind === 'checkpoint:restored')).toBe(true);
    expect(r.stopReason).toBe('human_pause');
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
    // the point is the boundary after the restored write, never a `pane` point that could not be written
    expect(point(h)).toEqual({ step: 2, round: null, phase: 'idle', reason: 'step', resumableAt: 'boundary', replayable: false, by: 'self', end: false });
  });

  it('checkpoint-degraded whose retry fails too: the pane re-arms, the run ends exit 3, not resumable, no pause:point', async () => {
    const store = createFakeStore();
    store.writeState = async () => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    };
    const h = await build({ store, turns: [read(), read()], limits: { maxSteps: 3 }, engine: { blocker: never } });
    h.engine.events.on('blocking:request', () => {
      setTimeout(() => h.engine.pause(), 5);
    });
    const r = await h.engine.run();
    expect(h.of('blocking:resolved')[0]).toMatchObject({ answer: 'pause' });
    expect(h.of('notice').some((n) => n.kind === 'checkpoint:restored')).toBe(false);
    expect(r.stopReason).toBe('human_pause');
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 3, resumable: false });
    expect(h.of('pause:point')).toEqual([]);
  });

  it('a degraded checkpoint keeps its exit: `[c] continue anyway` then a pause ends exit 3, not resumable, with no pause:point', async () => {
    const store = createFakeStore();
    let fail = true;
    const realWrite = store.writeState.bind(store);
    store.writeState = async (state) => {
      if (fail) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      return realWrite(state);
    };
    const blocker = async (): Promise<BlockingAnswer> => 'continue';
    const h = await build({ store, turns: [read(), read()], limits: { maxSteps: 3 }, engine: { blocker } });
    h.engine.events.on('blocking:resolved', () => {
      fail = false; // the final write lands, but the run is degraded from here on
      h.engine.pause();
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    // §12.0.2: a degraded checkpoint is exit 3 and not resumable — the point would promise a state the run cannot stand behind
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 3, resumable: false });
    expect(h.of('pause:point')).toEqual([]);
    expect(h.engine.status().pausePoint).toBeNull();
    expect(h.store.last()?.pausePoint).toBeUndefined();
  });

  it('drift is the exception: pause() during the drift pane reads as [q] stop — exit 2, no pause:point', async () => {
    const h = await build({ turns: [read()], limits: { maxSteps: 2 }, deciderModel: { configured: 'typesafe/jev-9.0-20990101', pinned: true }, engine: { blocker: never } });
    h.engine.events.on('blocking:request', (e) => {
      expect(e.request.kind).toBe('drift');
      setTimeout(() => h.engine.pause(), 5);
    });
    const r = await h.engine.run();
    expect(h.of('blocking:request')[0]!.request.kind).toBe('drift');
    expect(h.of('blocking:resolved')[0]).toMatchObject({ answer: 'pause' });
    expect(r.stopReason).toBe('error');
    expect(h.of('run:end')[0]!.exitCode).toBe(2);
    expect(h.of('pause:point')).toEqual([]);
  });
});

describe('the cached proposal is the pause\'s, never an earlier attempt\'s (§7.3 step 4)', () => {
  it('fresh resume → a second interruption → --replay: the rejected proposal is not resurrected; the cache file is superseded', async () => {
    // (1) pause now during risk: the proposal and its targets are cached, the detail stamped for the next resume
    const decider = createFakeDecider({ delayMs: (ctx) => (ctx.stage === 'risk' ? 5_000 : 0) });
    const h1 = await build({ decider, turns: [turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' })], limits: { maxSteps: 2 } });
    h1.engine.events.on('stage:start', (e) => {
      if (e.stage === 'risk') h1.engine.pause({ at: 'now' });
    });
    expect((await h1.engine.run()).stopReason).toBe('human_pause');
    expect(h1.store.last()!.interruptedDetail).toMatchObject({ cache: 'cache/step-1.json', resumes: 1, replayable: true });
    expect(h1.store.cache.has('step-1.json')).toBe(true);

    // (2) a FRESH resume (no --replay) runs step 1 again and is interrupted once more, this time with no cache of its own
    const h2 = await build({ store: h1.store, runsDir: h1.runsDir, resume: { runId: h1.engine.runId, force: false }, decider, turns: [read()], limits: { maxSteps: 2 } });
    h2.engine.events.on('stage:start', (e) => {
      if (e.stage === 'risk') h2.engine.abort('human_abort');
    });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('human_abort');
    const after = h1.store.last()!;
    expect(after.interrupted).toMatchObject({ step: 1 });
    // the stale detail did not survive the fresh attempt — and the file it named was renamed out of reach
    expect(after.interruptedDetail).toBeUndefined();
    expect(h1.store.cache.has('step-1.json')).toBe(false);
    expect(h1.store.cache.has('step-1.superseded.json')).toBe(true);

    // (3) --replay now: nothing to replay, a fresh step at intent, the generator asked again
    const h3 = await build({ store: h1.store, runsDir: h1.runsDir, resume: { runId: h1.engine.runId, force: false, replay: true }, turns: [read()], limits: { maxSteps: 1 } });
    const r3 = await h3.engine.run();
    expect(h3.of('transcript').some((t) => /^replay unavailable: no paused proposal for step 1; fresh step at intent$/.test(t.text))).toBe(true);
    expect(h3.of('proposal').every((e) => e.verdict === undefined)).toBe(true);
    expect(h3.provider.requests).toHaveLength(1);
    expect(r3.steps).toBe(1);
    // the committed step is the fresh read, never the cached edit
    expect(h1.store.steps.at(-1)!.proposal?.action).toMatchObject({ kind: 'read' });
  });

  it('a detail stamped for an earlier resume is refused by the engine too (the state survived, the stamp did not)', async () => {
    const decider = createFakeDecider({ delayMs: (ctx) => (ctx.stage === 'risk' ? 5_000 : 0) });
    const h1 = await build({ decider, turns: [turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' })], limits: { maxSteps: 2 } });
    h1.engine.events.on('stage:start', (e) => {
      if (e.stage === 'risk') h1.engine.pause({ at: 'now' });
    });
    await h1.engine.run();
    const last = h1.store.last()!;
    expect(last.interruptedDetail?.resumes).toBe(1);
    // a state that already went through one more resume keeps the detail but not its right to replay
    await h1.store.writeState({ ...last, resumes: last.resumes + 1 });
    const h2 = await build({ store: h1.store, runsDir: h1.runsDir, resume: { runId: h1.engine.runId, force: false, replay: true }, turns: [read()], limits: { maxSteps: 1 } });
    await h2.engine.run();
    expect(h2.of('transcript').some((t) => /^replay unavailable: the paused proposal for step 1 was already superseded by a fresh resume \(stamped for resume 1, this is 2\); fresh step at intent$/.test(t.text))).toBe(true);
    expect(h2.provider.requests).toHaveLength(1);
  });

  it('the cache file must be the one the state names: a different { resumes, at } pair is refused', async () => {
    const decider = createFakeDecider({ delayMs: (ctx) => (ctx.stage === 'risk' ? 5_000 : 0) });
    const h1 = await build({ decider, turns: [read()], limits: { maxSteps: 2 } });
    h1.engine.events.on('stage:start', (e) => {
      if (e.stage === 'risk') h1.engine.pause({ at: 'now' });
    });
    await h1.engine.run();
    // a file from another attempt under the same name (a restored backup, a synced copy)
    const written = h1.store.cache.get('step-1.json') as Record<string, unknown>;
    h1.store.cache.set('step-1.json', { ...written, at: '2026-09-21T10:00:00.000Z' });
    const h2 = await build({ store: h1.store, runsDir: h1.runsDir, resume: { runId: h1.engine.runId, force: false, replay: true }, turns: [read()], limits: { maxSteps: 1 } });
    await h2.engine.run();
    expect(h2.of('transcript').some((t) => t.level === 'warn' && /^replay unavailable: cache\/step-1\.json belongs to another attempt \(written 2026-09-21T10:00:00\.000Z, the state names .*\); fresh step 1 at intent$/.test(t.text))).toBe(true);
    expect(h2.provider.requests).toHaveLength(1);
  });

  it('a replayed step announces itself: the proposal event carries verdict replay', async () => {
    const decider = createFakeDecider({ delayMs: (ctx) => (ctx.stage === 'risk' && ctx.step === 1 ? 5_000 : 0) });
    const h1 = await build({ decider, turns: [read()], limits: { maxSteps: 2 } });
    h1.engine.events.on('stage:start', (e) => {
      if (e.stage === 'risk') h1.engine.pause({ at: 'now' });
    });
    await h1.engine.run();
    const h2 = await build({ store: h1.store, runsDir: h1.runsDir, resume: { runId: h1.engine.runId, force: false, replay: true }, turns: [read()], limits: { maxSteps: 1 } });
    await h2.engine.run();
    expect(h2.of('proposal').map((e) => e.verdict)).toEqual(['replay']);
    expect(h2.provider.requests).toHaveLength(0);
  });
});

describe('replayable is what the cache holds, not what the draft held a tick later (§12.0.2)', () => {
  it('a sample that arrives in the same tick as the pause: the cache is empty, so the point and the detail both say not replayable', async () => {
    const provider = latchedProvider();
    const h = await build({ mode: 'llm-jev', synthesizer: oneLateSampleSynth(), provider, limits: { maxSteps: 2 } });
    const running = h.engine.run();
    await until(() => provider.pending.length === 1);
    // the snapshot is taken synchronously inside pause(); the sample lands right after it, into the draft only
    h.engine.pause({ at: 'now' });
    provider.resolveSample0(result(0));
    const r = await running;
    expect(r.stopReason).toBe('human_pause');
    const cache = h.store.cache.get('step-1.json') as { proposal: Proposal | null; llmRound: { arrived: unknown[] } | null };
    // the file: no proposal, no arrived sample — and the detail and the point agree with it
    expect(cache.proposal).toBeNull();
    expect(cache.llmRound?.arrived ?? []).toEqual([]);
    const p = point(h);
    expect(p).toMatchObject({ step: 1, reason: 'now', resumableAt: 'cache/step-1.json', replayable: false });
    expect(h.store.last()!.interruptedDetail).toMatchObject({ cache: 'cache/step-1.json', replayable: false, partialChars: 0 });

    // --replay says why and buys the sample again: nothing was served from an empty cache
    const provider2 = latchedProvider();
    const h2 = await build({ mode: 'llm-jev', synthesizer: oneLateSampleSynth(), provider: provider2, store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false, replay: true }, limits: { maxSteps: 1 } });
    const running2 = h2.engine.run();
    await until(() => provider2.pending.length === 1);
    provider2.resolveSample0(result(0));
    await running2;
    expect(h2.of('transcript').some((t) => /^replay unavailable: nothing had arrived when step 1 paused; fresh step at intent$/.test(t.text))).toBe(true);
    expect(h2.of('transcript').filter((t) => /replayed from/.test(t.text))).toEqual([]);
    expect(provider2.requests).toHaveLength(1);
  });
});

describe('P8 — remote pause / end through deliver()', () => {
  it('a pause message applies as pause({ at, by: peer:<sid8> }); a repeat is delivered; after run:end it is expired; other types are refused', async () => {
    const provider = createFakeProvider([turn({ kind: 'read', paths: ['src/a.py'] }, {}, { delayMs: 5_000 })]);
    const h = await build({ provider, limits: { maxSteps: 2 } });
    const outcomes: string[] = [];
    h.engine.events.on('generator:start', () => {
      outcomes.push(h.engine.deliver!({ id: 'm1', type: 'pause', text: 'pause now please', from: PEER }));
      outcomes.push(h.engine.deliver!({ id: 'm2', type: 'pause', text: 'now', from: PEER }));
      outcomes.push(h.engine.deliver!({ id: 'm3', type: 'note', text: 'hi', from: PEER }));
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(outcomes).toEqual(['applied', 'delivered', 'refused']);
    expect(point(h)).toMatchObject({ step: 1, phase: 'propose', reason: 'now', by: 'peer:rpywkq2v', end: false });
    expect(h.engine.deliver!({ id: 'm4', type: 'pause', text: '', from: PEER })).toBe('expired');
  });

  it('a peer\'s label reaches `by` clamped to the id grammar: 32 chars of [A-Za-z0-9._-], never empty', async () => {
    const h = await build({ turns: [read(), read()], limits: { maxSteps: 3 } });
    h.engine.events.on('step:end', () => {
      h.engine.deliver!({ id: 'm1', type: 'pause', text: 'pause', from: { deviceId: 'k3q7m2ab', label: 'mbp\n[run] warn: forged — ' + 'x'.repeat(80), sessionId: null, runId: null } });
    });
    await h.engine.run();
    const by = point(h).by;
    expect(by.startsWith('device:')).toBe(true);
    expect(by.slice('device:'.length)).toBe('mbprunwarnforged' + 'x'.repeat(16));
    expect(by.slice('device:'.length)).toHaveLength(32);
  });

  it('an end message ends with by: remote — RunMeta.ended.by is remote and the point says end', async () => {
    const h = await build({ turns: [read(), read()], limits: { maxSteps: 3 } });
    h.engine.events.on('step:end', () => {
      expect(h.engine.deliver!({ id: 'm1', type: 'end', text: 'end at step', from: { ...PEER, sessionId: null, runId: null } })).toBe('applied');
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(h.store.meta?.ended).toEqual({ at: expect.any(String), by: 'remote' });
    expect(point(h)).toMatchObject({ step: 2, reason: 'step', by: 'device:mbp', end: true });
  });
});

describe('end (§7.4) — pause + RunMeta.ended, reversible with --force, never deletes', () => {
  it('end() at step: human_pause, exit 4, run.json.ended written with the final state, the point carries end: true', async () => {
    const h = await build({ turns: [read(), read()], limits: { maxSteps: 3 } });
    expect(h.engine.end).toBeDefined();
    h.engine.events.on('step:end', () => h.engine.end!());
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(1);
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
    expect(h.store.meta?.ended).toEqual({ at: expect.any(String), by: 'human' });
    expect(point(h)).toMatchObject({ step: 2, reason: 'step', end: true });
    expect(h.of('transcript').some((t) => /end requested \(human\)/.test(t.text) && /--force reopens/.test(t.text))).toBe(true);
    // the run dir is untouched: the fake store still holds every artefact
    expect(h.store.steps).toHaveLength(1);
    expect(h.store.states.length).toBeGreaterThan(0);
  });

  it('end({ at: now }) mid-stage discards under rule 1 and marks ended; end() after pause() adds the mark to a pending pause', async () => {
    const decider = createFakeDecider({ delayMs: (ctx) => (ctx.stage === 'risk' ? 5_000 : 0) });
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 2 } });
    h.engine.events.on('stage:start', (e) => {
      if (e.stage === 'risk') h.engine.end!({ at: 'now' });
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(point(h)).toMatchObject({ step: 1, phase: 'risk', reason: 'now', replayable: true, end: true });
    expect(h.store.meta?.ended?.by).toBe('human');

    const h2 = await build({ turns: [read(), read()], limits: { maxSteps: 2 } });
    h2.engine.events.on('step:start', () => {
      h2.engine.pause();
      h2.engine.end!();
      h2.engine.end!(); // idempotent: the first requester stays
    });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('human_pause');
    expect(h2.of('pause:requested')).toHaveLength(1);
    expect(h2.of('transcript').filter((t) => /end requested/.test(t.text))).toHaveLength(1);
    expect(point(h2)).toMatchObject({ reason: 'step', end: true });
  });

  it('the gate is in the engine: --resume of an ended run is a ConfigError without --force; --force reopens, records `reopened` and clears ended', async () => {
    const h = await build({ turns: [read(), read(), read()], limits: { maxSteps: 3 } });
    h.engine.events.on('step:end', () => h.engine.end!());
    await h.engine.run();
    await expect(makeEngine({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [read()] })).rejects.toThrow(ConfigError);
    await expect(makeEngine({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [read()] })).rejects.toThrow(/was ended by human at .*; pass --force to reopen/);
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: true }, turns: [read(), read()], limits: { maxSteps: 2 } });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('max_steps');
    expect(r2.steps).toBe(2);
    expect(h.store.meta?.ended).toBeNull();
    expect(h.store.meta?.resumes.at(-1)).toEqual({ resumedAt: expect.any(String), previousStopReason: 'human_pause', reopened: true });
    expect(h2.of('transcript').some((t) => /^reopened: run .* was ended; --force resumed it$/.test(t.text))).toBe(true);
    // reopened: a plain resume works again
    const h3 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [read()], limits: { maxSteps: 3 } });
    expect(h3.engine.runId).toBe(h.engine.runId);
  });
});

describe('idempotency and upgrade (§12.0.2)', () => {
  it('pause() twice is one request; now after step upgrades (the abort fires then); step after now is a no-op; nothing once finish() began', async () => {
    const decider = createFakeDecider({ delayMs: (ctx) => (ctx.stage === 'risk' ? 5_000 : 0) });
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 2 } });
    const statuses: boolean[] = [];
    h.engine.events.on('stage:start', (e) => {
      if (e.stage !== 'risk') return;
      h.engine.pause();
      h.engine.pause();
      expect(h.engine.status()).toMatchObject({ pausing: true, pauseNow: false });
      h.engine.pause({ at: 'now' }); // upgrade: the snapshot is taken and the controller aborts now
      h.engine.pause({ at: 'now' }); // no-op
      h.engine.pause(); // no-op
      statuses.push(h.engine.status().pauseNow === true);
    });
    h.engine.events.on('run:end', () => {
      h.engine.pause();
      h.engine.pause({ at: 'now' });
      h.engine.end!();
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(statuses).toEqual([true]);
    expect(h.of('pause:requested')).toEqual([{ type: 'pause:requested', step: 1 }]);
    // the upgrade landed as a pause-now: rule-1 discard during risk with the cache written
    expect(point(h)).toMatchObject({ step: 1, phase: 'risk', reason: 'now', resumableAt: 'cache/step-1.json', end: false });
    expect(h.store.meta?.ended).toBeUndefined();
    expect(h.of('transcript').filter((t) => /end requested/.test(t.text))).toEqual([]);
  });

  it('steer typed during pausing rides pendingDirectives into the final state', async () => {
    const provider = createFakeProvider([turn({ kind: 'read', paths: ['src/a.py'] }, {}, { delayMs: 5_000 })]);
    const h = await build({ provider, limits: { maxSteps: 2 } });
    h.engine.events.on('generator:start', () => {
      h.engine.pause({ at: 'now' });
      expect(h.engine.steer('then run the tests').ok).toBe(true);
    });
    await h.engine.run();
    expect(h.store.last()!.pendingDirectives?.map((d) => d.text)).toEqual(['then run the tests']);
  });
});

describe('the exit-code table (§12.0.2)', () => {
  it('Esc Esc after a pause-now wins: human_abort, exit 130, resumable, no pause:point, the cache file stays for the card', async () => {
    const decider = createFakeDecider({ delayMs: (ctx) => (ctx.stage === 'risk' ? 5_000 : 0) });
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 2 } });
    h.engine.events.on('stage:start', (e) => {
      if (e.stage !== 'risk') return;
      h.engine.pause({ at: 'now' });
      h.engine.abort('human_abort');
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_abort');
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 130, resumable: true });
    expect(h.of('pause:point')).toEqual([]);
    expect(h.store.cache.has('step-1.json')).toBe(true);
    const last = h.store.last()!;
    expect(last.stopReason).toBe('human_abort');
    expect(last.interrupted).toMatchObject({ step: 1, stage: 'risk' });
    expect(last.interruptedDetail).toMatchObject({ cache: 'cache/step-1.json', replayable: true });
    expect(last.pausePoint).toBeUndefined();
    expect(h.of('transcript').some((t) => /interrupted during risk \(human_abort\)/.test(t.text))).toBe(true);
  });

  it('SIGTERM after a pause-now: signal, exit 143', async () => {
    const provider = createFakeProvider([turn({ kind: 'read', paths: ['src/a.py'] }, {}, { delayMs: 5_000 })]);
    const h = await build({ provider, limits: { maxSteps: 2 } });
    h.engine.events.on('generator:start', () => {
      h.engine.pause({ at: 'now' });
      h.engine.abort('signal', { signal: 'SIGTERM' });
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('signal');
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 143, resumable: true });
    expect(h.of('pause:point')).toEqual([]);
  });

  it('a second Ctrl-C after pause-now + abort forces the last-resort write with the abort reason, never human_pause', async () => {
    const provider = createFakeProvider([turn({ kind: 'read', paths: ['src/a.py'] }, {}, { delayMs: 5_000 })]);
    const store = createFakeStore();
    const exits: number[] = [];
    const h = await build({ provider, store, limits: { maxSteps: 2 }, exit: ((code: number) => {
      exits.push(code);
      throw new Error(`exit ${code}`);
    }) as (code: number) => never });
    h.engine.events.on('generator:start', () => {
      h.engine.pause({ at: 'now' });
      h.engine.abort('human_abort');
      try {
        h.engine.abort('human_abort');
      } catch {
        /* the injected exit throws */
      }
    });
    const r = await h.engine.run();
    expect(exits).toEqual([130]);
    expect(store.syncStates.at(-1)).toMatchObject({ stopReason: 'human_abort', interrupted: { step: 1, stage: 'propose' } });
    expect(r.stopReason).toBe('human_abort');
  });

  it('a failed final state.json write: exit 3, resumable false, no pause:point', async () => {
    const store = createFakeStore();
    store.writeState = async () => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    };
    const h = await build({ store, turns: [read()], limits: { maxSteps: 2 } });
    h.engine.pause();
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 3, resumable: false });
    expect(h.of('pause:point')).toEqual([]);
    // status still knows the point that was decided; the event never fired because the write failed
    expect(h.engine.status().pausePoint).toMatchObject({ step: 1, reason: 'step' });
  });

  it('a late sample row of a pause-now-discarded step carries discarded: true (§11 row 41); the committed step\'s rows carry no mark', async () => {
    // llm-jev: sample 0 ignores the abort and lands long after the step was discarded — the row must still be marked, so the
    // replayed step's `verify.samples` and the cost audit keep the two attempts apart
    const late = latchedProvider();
    const h = await build({ mode: 'llm-jev', synthesizer: lateSampleSynth(), provider: late, limits: { maxSteps: 2 } });
    const running = h.engine.run();
    await until(() => late.pending.length === 2);
    // the row lands while the run is already shutting down: the pause point is decided, the state written
    h.engine.events.on('pause:point', () => late.resolveSample0(result(0)));
    h.engine.pause({ at: 'now' });
    const r = await running;
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(0);
    await until(() => h.store.generator.some((g) => g.sample === 0));
    const rows = h.store.generator.filter((g) => g.step === 1);
    expect(rows.map((g) => [g.sample, g.discarded])).toEqual([[1, true], [0, true]]);
    expect(point(h)).toMatchObject({ step: 1, phase: 'propose', reason: 'now' });
  });

  it('a committed step keeps its rows unmarked: only the discarded attempt is flagged', async () => {
    const provider = createFakeProvider((_req, i) => (i === 0 ? read() : turn({ kind: 'read', paths: ['src/a.py'] }, {}, { delayMs: 5_000 })));
    const h = await build({ provider, mode: 'jev-off', limits: { maxSteps: 3 } });
    h.engine.events.on('generator:start', (e) => {
      if (e.step === 2) h.engine.pause({ at: 'now' });
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(1);
    expect(h.store.generator.filter((g) => g.step === 1).every((g) => g.discarded === undefined)).toBe(true);
    expect(point(h)).toMatchObject({ step: 2, phase: 'propose', reason: 'now' });
  });
});

describe('P7 — the `worktree` answer at a pane (the relocation stop)', () => {
  it('`[t] worktree` is the resumable stop: human_pause, exit 4, the point reads reason worktree and names the pane', async () => {
    const decider = createFakeDecider({ retryAt: (ctx) => (ctx.stage === 'intent' ? { count: 0, waitMs: 0, status: 503, exhausted: true } : undefined) });
    const answers: BlockingRequest[] = [];
    const blocker = async (req: BlockingRequest): Promise<BlockingAnswer> => {
      answers.push(req);
      return 'worktree';
    };
    const h = await build({ decider, turns: [read()], limits: { maxSteps: 2 }, engine: { blocker } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    // the pane's own error is not this stop's error (like the `pause` answer, §11 row 37)
    expect(r.error).toBeUndefined();
    expect(h.of('blocking:resolved')[0]).toMatchObject({ answer: 'worktree' });
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
    expect(point(h)).toEqual({ step: 1, round: null, phase: 'pane', reason: 'worktree', resumableAt: 'boundary', replayable: false, pane: 'jev-unreachable', by: 'self', end: false });
    expect(answers).toHaveLength(1);
  });

  it('`[w] wait` is not a stop: the pane closes and the run goes on (the inline wait belongs to the coordinate stage)', async () => {
    let first = true;
    const decider = createFakeDecider({
      retryAt: (ctx) => {
        if (ctx.stage !== 'intent' || !first) return undefined;
        first = false;
        return { count: 0, waitMs: 0, status: 503, exhausted: true };
      },
    });
    const blocker = async (): Promise<BlockingAnswer> => 'wait';
    const h = await build({ decider, turns: [read(), read()], limits: { maxSteps: 2 }, engine: { blocker } });
    const r = await h.engine.run();
    expect(h.of('blocking:resolved')[0]).toMatchObject({ answer: 'wait' });
    expect(r.stopReason).toBe('max_steps');
    expect(h.of('pause:point')).toEqual([]);
    expect(h.engine.status().blocked).toBeNull();
  });
});
