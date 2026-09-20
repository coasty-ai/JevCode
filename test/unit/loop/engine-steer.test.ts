/**
 * contract 1.1 wave 0 (TUI-DESIGN §15 item 15): steer / unsteer / pause / retryNow / annotate and the widened
 * abort on the real engine over the fakes. Directive CONSUMPTION at step start is wave 2 and is not tested here;
 * what is tested is that the queue is emitted, checkpointed and restored, that pause ends the run at the next
 * loop top with a checkpoint, and that annotate lines ride the engine's transcript exactly once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, SerializedError } from '../../../src/core/types.js';
import { AbortError } from '../../../src/errors.js';
import { DIRECTIVE_MAX_CHARS, MAX_PENDING_DIRECTIVES } from '../../../src/loop/engine.js';
import { formatTranscriptItem, itemsFromEvent } from '../../../src/tui/plain.js';
import type { Harness } from './fakes.js';
import { createFakeProvider, createFakeSandbox, makeEngine, passingTests, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

const readTurns = (n: number) => Array.from({ length: n }, () => turn({ kind: 'read', paths: ['src/a.py'] }));

describe('steer / unsteer (§8.6 queue; consumption is wave 2)', () => {
  it('queues a trimmed directive, emits steer:queued with the next step, and the queue lands in the checkpoint', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    const r = h.engine.steer('  use pytest -x  ');
    expect(r).toEqual({ ok: true, index: 0, queued: 1 });
    const queued = h.of('steer:queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ step: 1, index: 0, text: 'use pytest -x', queued: 1 });
    // the queue is visible to the synchronous last-resort snapshot before the run starts
    expect(h.engine.snapshotState()?.pendingDirectives).toEqual([{ text: 'use pytest -x', at: expect.any(String), index: 0 }]);
    await h.engine.run();
    const last = h.store.last()!;
    expect(last.pendingDirectives).toEqual([{ text: 'use pytest -x', at: expect.any(String), index: 0 }]);
    // wave 0: nothing consumes the queue yet, so every checkpoint of the run carries it
    for (const st of h.store.states) expect(st.pendingDirectives).toHaveLength(1);
  });

  it('an empty directive is refused without an event; the text is clipped at 600 chars; the queue holds at most 8', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    expect(h.engine.steer('   \n ')).toEqual({ ok: false, reason: 'empty', queued: 0 });
    expect(h.of('steer:queued')).toHaveLength(0);
    const long = h.engine.steer('x'.repeat(DIRECTIVE_MAX_CHARS + 100));
    expect(long.ok).toBe(true);
    expect(h.of('steer:queued')[0]!.text).toHaveLength(DIRECTIVE_MAX_CHARS);
    for (let i = 1; i < MAX_PENDING_DIRECTIVES; i++) expect(h.engine.steer(`d${i}`)).toEqual({ ok: true, index: i, queued: i + 1 });
    expect(h.engine.steer('one too many')).toEqual({ ok: false, reason: 'full', queued: MAX_PENDING_DIRECTIVES });
    expect(h.of('steer:queued')).toHaveLength(MAX_PENDING_DIRECTIVES);
    expect(h.engine.snapshotState()?.pendingDirectives).toHaveLength(MAX_PENDING_DIRECTIVES);
  });

  it('after run() resolved a steer is refused with "finished"', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    await h.engine.run();
    expect(h.engine.steer('too late')).toEqual({ ok: false, reason: 'finished', queued: 0 });
    expect(h.of('steer:queued')).toHaveLength(0);
  });

  it('unsteer pops the newest directive, emits steer:withdrawn, and an emptied queue is absent from the checkpoint', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    expect(h.engine.unsteer()).toBeNull();
    h.engine.steer('first');
    h.engine.steer('second');
    const popped = h.engine.unsteer();
    expect(popped).toMatchObject({ text: 'second', index: 1 });
    expect(h.of('steer:withdrawn')).toEqual([{ type: 'steer:withdrawn', step: 1, index: 1 }]);
    expect(h.engine.unsteer()).toMatchObject({ text: 'first', index: 0 });
    expect(h.engine.unsteer()).toBeNull();
    expect(h.of('steer:withdrawn')).toHaveLength(2);
    await h.engine.run();
    expect(h.store.last()!.pendingDirectives).toBeUndefined();
    // indices are never reused within a run
    expect(h.engine.steer('third')).toEqual({ ok: false, reason: 'finished', queued: 0 });
  });

  it('a steer during the run is emitted with the step that will consume it', async () => {
    const h = await build({ turns: readTurns(2), limits: { maxSteps: 2 } });
    h.engine.events.on('step:end', (e) => {
      if (e.record.step === 1) h.engine.steer('after step one');
    });
    await h.engine.run();
    expect(h.of('steer:queued')).toEqual([{ type: 'steer:queued', step: 2, index: 0, text: 'after step one', queued: 1 }]);
    expect(h.store.last()!.pendingDirectives).toEqual([{ text: 'after step one', at: expect.any(String), index: 0 }]);
  });
});

describe('pause (§9.1 rule 1: only at the loop top)', () => {
  it('ends a run with human_pause after the in-flight step committed whole, with a checkpoint written', async () => {
    const h = await build({ turns: readTurns(5), limits: { maxSteps: 5 } });
    h.engine.events.on('step:start', (e) => {
      // requested mid-step: step 1 must still commit, and no step 2 may start
      if (e.step === 1) {
        h.engine.pause();
        h.engine.pause(); // idempotent
      }
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(1);
    expect(h.store.steps).toHaveLength(1);
    expect(h.provider.requests).toHaveLength(1);
    expect(h.of('pause:requested')).toEqual([{ type: 'pause:requested', step: 1 }]);
    expect(h.of('step:start').map((e) => e.step)).toEqual([1]);
    const last = h.store.last()!;
    expect(last.stopReason).toBe('human_pause');
    expect(last.step).toBe(1);
    expect(last.interrupted).toBeNull();
    // the stop and end lines go through the shared item model like every other stop
    expect(h.store.transcript.at(-2)).toBe('[run] warn: stop: human_pause at step 1');
    expect(h.store.transcript.at(-1)).toMatch(/^\[run\] end human_pause steps=1 /);
    expect(h.of('run:end')[0]!.result.stopReason).toBe('human_pause');
  });

  it('a pause requested before run() ends the run at the first loop top with zero steps', async () => {
    const h = await build({ turns: readTurns(2), limits: { maxSteps: 2 } });
    h.engine.pause();
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(r.steps).toBe(0);
    expect(h.provider.requests).toHaveLength(0);
    expect(h.store.last()!.stopReason).toBe('human_pause');
  });

  it('a paused run resumes without --force and the queued steers survive the checkpoint round trip', async () => {
    const h = await build({ turns: readTurns(3), limits: { maxSteps: 3 } });
    h.engine.events.on('step:end', () => {
      h.engine.steer('keep going with pytest');
      h.engine.pause();
    });
    const r1 = await h.engine.run();
    expect(r1.stopReason).toBe('human_pause');
    expect(r1.steps).toBe(1);
    expect(h.store.last()!.pendingDirectives).toEqual([{ text: 'keep going with pytest', at: expect.any(String), index: 0 }]);

    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: readTurns(3), limits: { maxSteps: 2 } });
    // restored before the run starts, indices continue after the restored ones
    expect(h2.engine.snapshotState()?.pendingDirectives).toEqual([{ text: 'keep going with pytest', at: expect.any(String), index: 0 }]);
    expect(h2.engine.steer('and lint')).toEqual({ ok: true, index: 1, queued: 2 });
    const r2 = await h2.engine.run();
    // human_pause is not a budget stop: the resume is not refused
    expect(r2.stopReason).toBe('max_steps');
    expect(r2.steps).toBe(2);
    expect(h2.of('run:ready')[0]!.resumed).toBe(true);
    expect(h.store.last()!.pendingDirectives?.map((d) => d.text)).toEqual(['keep going with pytest', 'and lint']);
  });

  it('pause after the run ended is a no-op', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    await h.engine.run();
    h.engine.pause();
    expect(h.of('pause:requested')).toHaveLength(0);
  });
});

describe('retryNow (wave 0: no wakeable retry sleep exists)', () => {
  it('returns false', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    expect(h.engine.retryNow()).toBe(false);
  });
});

describe('annotate (§15.1 three-way identity)', () => {
  it('while live: one notice event, exactly one transcript.log line identical to the plain renderer line; false before and after', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    expect(h.engine.annotate('too early')).toBe(false);
    let accepted: boolean | null = null;
    h.engine.events.on('step:start', () => {
      accepted = h.engine.annotate('/why: destructive dominated', { detail: 'destructive L2 p=0.80\nout_of_scope L0 p=0.05' });
    });
    await h.engine.run();
    expect(accepted).toBe(true);
    const notices = h.of('notice');
    expect(notices).toEqual([{ type: 'notice', step: 1, kind: 'ui', level: 'info', text: '/why: destructive dominated', label: '[ui]', detail: 'destructive L2 p=0.80\nout_of_scope L0 p=0.05' }]);
    const lines = h.store.transcript.filter((l) => l.includes('/why: destructive dominated'));
    expect(lines).toEqual(['[ui] /why: destructive dominated']);
    // the very line the plain renderer and the TUI print for that event (the detail never reaches the one-line form)
    const seq = h.store.transcript.indexOf(lines[0]!);
    const items = itemsFromEvent(notices[0]!, seq);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'notice', label: '[ui]', step: 1, seq, detail: 'destructive L2 p=0.80\nout_of_scope L0 p=0.05' });
    expect(formatTranscriptItem(items[0]!)).toBe(lines[0]);
    expect(h.engine.annotate('too late')).toBe(false);
    expect(h.of('notice')).toHaveLength(1);
  });

  it('label and level are honoured, and redaction applies to the line like every other event', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    h.engine.events.on('run:ready', () => {
      h.engine.annotate('key sk-or-v1-SECRETSECRETSECRETSECRET rejected', { label: '[config]', level: 'warn' });
    });
    await h.engine.run();
    const n = h.of('notice')[0]!;
    expect(n).toMatchObject({ step: null, kind: 'ui', level: 'warn', label: '[config]', text: 'key [REDACTED:test] rejected' });
    expect(h.store.transcript).toContain('[config] key [REDACTED:test] rejected');
    expect(h.store.transcript.filter((l) => l.includes('rejected'))).toHaveLength(1);
  });

  it('an unlabelled notice from the engine prints `notice <kind>: <text>` through the same item model', () => {
    const e: EngineEvent = { type: 'notice', step: null, kind: 'checkpoint:degraded', level: 'error', text: 'state.json: ENOSPC' };
    const items = itemsFromEvent(e, 7);
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBeUndefined();
    expect(formatTranscriptItem(items[0]!)).toBe('[run] notice checkpoint:degraded: state.json: ENOSPC');
  });
});

describe('abort(reason, opts) widened (§13.4, §13.5)', () => {
  it("abort('signal', { signal: 'SIGTERM' }) aborts with an AbortError carrying the signal name; the run stops with 'signal'", async () => {
    const provider = createFakeProvider([turn({ kind: 'run', command: 'ls' }, {}, { delayMs: 5_000 })]);
    const h = await build({ provider });
    const running = h.engine.run();
    await new Promise((r) => setTimeout(r, 30));
    h.engine.abort('signal', { signal: 'SIGTERM' });
    const reason = h.engine.signal.reason as unknown;
    expect(reason).toBeInstanceOf(AbortError);
    expect((reason as AbortError).signalName).toBe('SIGTERM');
    expect((reason as AbortError).exitCode).toBe(143);
    const r = await running;
    expect(r.stopReason).toBe('signal');
    expect(h.store.last()!.stopReason).toBe('signal');
  });

  it("abort('error', { error }) stores the fatal error: the run stops with 'error' and RunResult.error is that error", async () => {
    const provider = createFakeProvider([turn({ kind: 'run', command: 'ls' }, {}, { delayMs: 5_000 })]);
    const h = await build({ provider });
    const running = h.engine.run();
    await new Promise((r) => setTimeout(r, 30));
    const fatal: SerializedError = { name: 'JevHttpError', code: 'jev_http', message: 'Jev HTTP 401: key rejected', exitCode: 2, status: 401, retryable: false, side: 'jev' };
    h.engine.abort('error', { error: fatal });
    expect((h.engine.signal.reason as AbortError).reason).toBe('error');
    const r = await running;
    expect(r.stopReason).toBe('error');
    expect(r.error).toEqual(fatal);
    expect(h.of('run:end')[0]!.result.error).toEqual(fatal);
    expect(h.store.last()!.stopReason).toBe('error');
  });

  it('a second abort while shutting down force-exits with the signal-derived code through the injected exit', async () => {
    const exits: number[] = [];
    const exit = ((code: number) => {
      exits.push(code);
      throw new AbortError('signal');
    }) as (code: number) => never;
    const provider = createFakeProvider([turn({ kind: 'run', command: 'ls' }, {}, { delayMs: 5_000 })]);
    const h = await build({ provider, exit });
    const running = h.engine.run();
    await new Promise((r) => setTimeout(r, 20));
    h.engine.abort('signal', { signal: 'SIGTERM' });
    expect(() => h.engine.abort('signal', { signal: 'SIGTERM' })).toThrow(AbortError);
    expect(exits).toEqual([143]);
    expect(h.store.syncStates).toHaveLength(1);
    await running;
  });

  it('a plain abort keeps the old 130 second-press code', async () => {
    const exits: number[] = [];
    const exit = ((code: number) => {
      exits.push(code);
      throw new AbortError('signal');
    }) as (code: number) => never;
    const provider = createFakeProvider([turn({ kind: 'run', command: 'ls' }, {}, { delayMs: 5_000 })]);
    const h = await build({ provider, exit, sandbox: createFakeSandbox(() => passingTests) });
    const running = h.engine.run();
    await new Promise((r) => setTimeout(r, 20));
    h.engine.abort('human_abort');
    expect(() => h.engine.abort('human_abort')).toThrow(AbortError);
    expect(exits).toEqual([130]);
    await running;
  });
});
