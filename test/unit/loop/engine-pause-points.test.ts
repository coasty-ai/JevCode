/**
 * contract 1.4 (docs/COORDINATION-DESIGN.md §7.2–§7.4, §12.0.2): the pause points P1–P8 over the fakes — where each lands,
 * what is persisted, the `pause:point` event and its order, `EngineStatus.pausePoint` / `pauseNow`, the WAIT-never-kill
 * rule with an execute in flight, the exit-code table (a later abort wins over a pause-now), idempotency / upgrade, `end`
 * with its `--force` gate, and remote pause / end through `deliver()`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { BlockingAnswer, EngineEvent, PausePoint } from '../../../src/core/types.js';
import { ConfigError } from '../../../src/errors.js';
import type { Harness } from './fakes.js';
import { createFakeDecider, createFakeProvider, createFakeSandbox, createFakeStore, execResult, makeEngine, turn } from './fakes.js';

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
    expect(last.interruptedDetail).toEqual({ cache: 'cache/step-1.json', targetsSha: {}, replayable: false, partialChars: 0 });
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

  it('late sample-less rows: a pause-now-discarded step marks its generator rows discarded, so a replay attempt stays apart', async () => {
    // jev-off: the propose call completed before the pause (a delayed risk is not available without Jev); use a slow computeTargets-free read + pause at step start of step 2 to discard the second attempt's rows
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

describe('P7 — worktree relocation (data shape; the lease-conflict pane lands with the coordination branch)', () => {
  it('interruptedDetail.relocate and a PausePoint with reason worktree round-trip through the checkpoint state', async () => {
    const h = await build({ turns: [read()], limits: { maxSteps: 1 } });
    await h.engine.run();
    const base = h.store.last()!;
    const p: PausePoint = { step: 2, round: null, phase: 'pane', pane: 'jev-unreachable', reason: 'worktree', resumableAt: 'cache/step-2.json', replayable: true, by: 'self', end: false };
    const state = { ...base, interrupted: { step: 2, stage: 'risk' as const, proposal: null }, interruptedDetail: { cache: 'cache/step-2.json' as const, targetsSha: { 'src/a.py': null }, replayable: true, partialChars: 0, relocate: { slug: 'fix-store', reason: 'lease-conflict' as const } }, pausePoint: p };
    await h.store.writeState(state);
    expect(h.store.last()!.interruptedDetail?.relocate).toEqual({ slug: 'fix-store', reason: 'lease-conflict' });
    expect(h.store.last()!.pausePoint).toEqual(p);
    expect(execResult().ok).toBe(true);
  });
});
