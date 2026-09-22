/**
 * contract 1.1 (TUI-DESIGN §15 item 15): steer / unsteer / pause / retryNow / annotate and the widened abort on the
 * real engine over the fakes: the queue is emitted, checkpointed and restored, pause ends the run at the next loop
 * top with a checkpoint, and annotate lines ride the engine's transcript exactly once. Directive CONSUMPTION at
 * step start (§8.6) is covered by engine-steering.test.ts; here a queued steer is consumed by the step it names.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, SerializedError } from '../../../src/core/types.js';
import { AbortError } from '../../../src/errors.js';
import { ANNOTATE_DETAIL_MAX_CHARS, ANNOTATE_TEXT_MAX_CHARS, DIRECTIVE_MAX_CHARS, MAX_PENDING_DIRECTIVES } from '../../../src/loop/engine.js';
import { formatTranscriptItem, itemsFromEvent } from '../../../src/tui/plain.js';
import type { Harness } from './fakes.js';
import { createFakeProvider, createFakeSandbox, createFakeStore, makeEngine, passingTests, turn } from './fakes.js';

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

describe('steer / unsteer (§8.6 queue)', () => {
  it('queues a trimmed directive, emits steer:queued (after run:ready for a pre-run steer) with the next step, and step 1 consumes it into plan.harnessProblems', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    const r = h.engine.steer('  use pytest -x  ');
    expect(r).toEqual({ ok: true, index: 0, queued: 1 });
    // §8.6 / §15.2: a steer before run() is queued at once but announced after run:ready, so every writer sees run:start first
    expect(h.of('steer:queued')).toHaveLength(0);
    expect(h.engine.status().pendingDirectives).toBe(1);
    // the queue is visible to the synchronous last-resort snapshot before the run starts
    expect(h.engine.snapshotState()?.pendingDirectives).toEqual([{ text: 'use pytest -x', at: expect.any(String), index: 0 }]);
    await h.engine.run();
    const queued = h.of('steer:queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ step: 1, index: 0, text: 'use pytest -x', queued: 1 });
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('steer:queued')).toBeGreaterThan(types.indexOf('run:ready'));
    expect(types.indexOf('steer:queued')).toBeLessThan(types.indexOf('step:start'));
    const last = h.store.last()!;
    // §8.6: applied at the step start — the queue is empty in every checkpoint and the directive lives on as a `human` problem of step 1
    expect(last.pendingDirectives).toBeUndefined();
    expect(last.plan.harnessProblems).toEqual([{ kind: 'human', text: 'use pytest -x', step: 1 }]);
    expect(h.of('steer:applied')).toEqual([{ type: 'steer:applied', step: 1, count: 1, superseded: [] }]);
    for (const st of h.store.states) expect(st.pendingDirectives).toBeUndefined();
  });

  it('an empty directive is refused without an event; the text is clipped at 600 chars with the truncation marker; the queue holds at most 8', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    expect(h.engine.steer('   \n ')).toEqual({ ok: false, reason: 'empty', queued: 0 });
    // a control-only text is empty too (sanitizeStream first, then trim)
    expect(h.engine.steer('\x07\x1b\x00 \x7f')).toEqual({ ok: false, reason: 'empty', queued: 0 });
    const long = h.engine.steer('x'.repeat(DIRECTIVE_MAX_CHARS + 100));
    expect(long.ok).toBe(true);
    const first = h.engine.snapshotState()!.pendingDirectives![0]!.text;
    // §8.6: clip(…, 600), not slice — the marker shows the human the text was cut
    expect(first).toHaveLength(DIRECTIVE_MAX_CHARS);
    expect(first.endsWith('…')).toBe(true);
    for (let i = 1; i < MAX_PENDING_DIRECTIVES; i++) expect(h.engine.steer(`d${i}`)).toEqual({ ok: true, index: i, queued: i + 1 });
    expect(h.engine.steer('one too many')).toEqual({ ok: false, reason: 'full', queued: MAX_PENDING_DIRECTIVES });
    expect(h.engine.snapshotState()?.pendingDirectives).toHaveLength(MAX_PENDING_DIRECTIVES);
    await h.engine.run();
    expect(h.of('steer:queued')).toHaveLength(MAX_PENDING_DIRECTIVES);
    expect(h.of('steer:queued')[0]!.text).toHaveLength(DIRECTIVE_MAX_CHARS);
    // a surrogate pair straddling the bound is not split: the clipped text is well-formed
    const h2 = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    const emoji = `${'a'.repeat(DIRECTIVE_MAX_CHARS - 2)}😀😀`;
    expect(h2.engine.steer(emoji).ok).toBe(true);
    const clipped = h2.engine.snapshotState()!.pendingDirectives![0]!.text;
    expect(clipped.length).toBeLessThanOrEqual(DIRECTIVE_MAX_CHARS);
    // a lone surrogate (an unpaired \uD800–\uDFFF code unit) would mean the pair was split
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(clipped)).toBe(false);
  });

  it('after run() resolved a steer is refused with "finished" — before the empty check (§8.6 order finished → empty → full)', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    await h.engine.run();
    expect(h.engine.steer('too late')).toEqual({ ok: false, reason: 'finished', queued: 0 });
    expect(h.engine.steer('')).toEqual({ ok: false, reason: 'finished', queued: 0 });
    expect(h.of('steer:queued')).toHaveLength(0);
  });

  it('unsteer pops the newest directive, emits steer:withdrawn (after run:ready for a pre-run withdrawal), and an emptied queue is absent from the checkpoint', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    expect(h.engine.unsteer()).toBeNull();
    h.engine.steer('first');
    h.engine.steer('second');
    const popped = h.engine.unsteer();
    expect(popped).toMatchObject({ text: 'second', index: 1 });
    expect(h.engine.status().pendingDirectives).toBe(1);
    expect(h.engine.unsteer()).toMatchObject({ text: 'first', index: 0 });
    expect(h.engine.unsteer()).toBeNull();
    // nothing announced before run(): the items are held for the run:ready flush, in the order they happened
    expect(h.of('steer:withdrawn')).toHaveLength(0);
    await h.engine.run();
    expect(h.of('steer:withdrawn')).toEqual([
      { type: 'steer:withdrawn', step: 1, index: 1 },
      { type: 'steer:withdrawn', step: 1, index: 0 },
    ]);
    const kinds = h.events.filter((e) => e.type === 'steer:queued' || e.type === 'steer:withdrawn').map((e) => `${e.type}:${e.index}`);
    expect(kinds).toEqual(['steer:queued:0', 'steer:queued:1', 'steer:withdrawn:1', 'steer:withdrawn:0']);
    expect(h.store.last()!.pendingDirectives).toBeUndefined();
    // indices are never reused within a run
    expect(h.engine.steer('third')).toEqual({ ok: false, reason: 'finished', queued: 0 });
  });

  it('unsteer after run:end returns null and emits nothing: the queue on disk and in memory stay identical, run:end stays the last line', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    h.engine.events.on('step:end', () => {
      h.engine.steer('one');
      h.engine.steer('two');
    });
    await h.engine.run();
    const before = h.events.length;
    expect(h.store.last()!.pendingDirectives?.map((d) => d.text)).toEqual(['one', 'two']);
    expect(h.engine.unsteer()).toBeNull();
    expect(h.of('steer:withdrawn')).toEqual([]);
    expect(h.events).toHaveLength(before);
    expect(h.engine.status().pendingDirectives).toBe(2);
    expect(h.store.transcript.at(-1)).toMatch(/^\[run\] finished [·-] /);
  });

  it('a steer during the run is emitted with the step that will consume it, and that step consumes it', async () => {
    const h = await build({ turns: readTurns(2), limits: { maxSteps: 2 } });
    h.engine.events.on('step:end', (e) => {
      if (e.record.step === 1) h.engine.steer('after step one');
    });
    await h.engine.run();
    expect(h.of('steer:queued')).toEqual([{ type: 'steer:queued', step: 2, index: 0, text: 'after step one', queued: 1 }]);
    expect(h.of('steer:applied')).toEqual([{ type: 'steer:applied', step: 2, count: 1, superseded: [] }]);
    expect(h.store.last()!.pendingDirectives).toBeUndefined();
    expect(h.store.last()!.plan.harnessProblems).toEqual([{ kind: 'human', text: 'after step one', step: 2 }]);
    // the second prompt carried the hint, the first did not
    expect(h.provider.requests[1]!.messages[0]!.content).toContain('Instruction from the human for this step (it takes precedence over the plan\'s order): after step one');
    expect(h.provider.requests[0]!.messages[0]!.content).not.toContain('Instruction from the human');
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
    // TUI-DESIGN-4 §3.7 G1 (D-V): the `stop:` line is deleted; `[run] finished` is the one row that says it
    expect(h.store.transcript.some((l) => l.includes('stop: human_pause'))).toBe(false);
    expect(h.store.transcript.at(-1)).toMatch(/^\[run\] finished [·-] human_pause [·-] 1 steps [·-] /);
    expect(h.store.transcript.filter((l) => /^\[run\] (?:warn: )?stop: /.test(l))).toEqual([]);
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
    // both directives were applied to step 2 of the resumed run (§8.6), so the final checkpoint carries them as human problems, not as a queue
    expect(h2.of('steer:applied')).toEqual([{ type: 'steer:applied', step: 2, count: 2, superseded: [] }]);
    expect(h.store.last()!.pendingDirectives).toBeUndefined();
    expect(h.store.last()!.plan.harnessProblems.filter((p) => p.kind === 'human').map((p) => [p.text, p.step])).toEqual([['keep going with pytest', 2], ['and lint', 2]]);
  });

  it('pause after the run ended is a no-op', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    await h.engine.run();
    h.engine.pause();
    expect(h.of('pause:requested')).toHaveLength(0);
  });
});

describe('retryNow outside a retry sleep', () => {
  it('returns false (the waker lifecycle itself is covered by engine-blocker.test.ts)', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    expect(h.engine.retryNow()).toBe(false);
    await h.engine.run();
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

  it('an unlabelled notice of a kind that does not describe itself prints `notice <kind>: <text>`; the engine\'s self-describing kinds print bare', () => {
    // an unlabelled `ui` notice (never produced by annotate(), which always labels) is the fallback shape
    const e: EngineEvent = { type: 'notice', step: null, kind: 'ui', level: 'error', text: 'state.json: ENOSPC' };
    const items = itemsFromEvent(e, 7);
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBeUndefined();
    expect(formatTranscriptItem(items[0]!)).toBe('[run] notice ui: state.json: ENOSPC');
    // `checkpoint degraded: …` already names itself (plain.ts BARE_NOTICE_KINDS)
    const bare: EngineEvent = { type: 'notice', step: null, kind: 'checkpoint:degraded', level: 'error', text: 'checkpoint degraded: ENOSPC on state.json' };
    expect(formatTranscriptItem(itemsFromEvent(bare, 8)[0]!)).toBe('[run] checkpoint degraded: ENOSPC on state.json');
  });

  it('text is clipped at 600 and detail at 12,000 through sanitizeStream before the event leaves the engine (§8.6): --json and every listener see the bounded form', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    let accepted = false;
    h.engine.events.on('step:start', () => {
      accepted = h.engine.annotate(`\x07red\x1b ${'t'.repeat(2_000)}`, { detail: `${'d'.repeat(20_000)}\x07\nlast line`, label: '[ui]' });
    });
    await h.engine.run();
    expect(accepted).toBe(true);
    const n = h.of('notice').find((x) => x.kind === 'ui')!;
    expect(n.text).toHaveLength(ANNOTATE_TEXT_MAX_CHARS);
    expect(n.text.startsWith('red ')).toBe(true);
    expect(n.text).not.toContain('\x1b');
    expect(n.text.endsWith('…')).toBe(true);
    expect(n.detail).toHaveLength(ANNOTATE_DETAIL_MAX_CHARS);
    expect(n.detail).not.toContain('\x07');
    expect(n.detail!.endsWith('…')).toBe(true);
    // the --json line of that event is bounded too
    expect(JSON.stringify(n).length).toBeLessThan(ANNOTATE_DETAIL_MAX_CHARS + ANNOTATE_TEXT_MAX_CHARS + 200);
    // a control-only detail reads as no detail
    let second = false;
    const h2 = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    h2.engine.events.on('step:start', () => {
      second = h2.engine.annotate('plain', { detail: '\x1b\x07' });
    });
    await h2.engine.run();
    expect(second).toBe(true);
    expect(h2.of('notice').find((x) => x.kind === 'ui')!.detail).toBeUndefined();
  });
});

describe('finish() in flight reads as finished (§8.6: a steer confirmed to the human is never dropped)', () => {
  /** A store whose state.json writes take `delayMs`, opening the window between the final snapshot and run:end. */
  function slowStore(delayMs: number) {
    const store = createFakeStore();
    store.writeDelayMs = delayMs;
    return store;
  }

  it('a steer that lands before finish() (at the budget line of the loop top) is accepted and persisted; one issued during the final write or at run:end is refused as finished', async () => {
    const store = slowStore(40);
    const h = await build({ store, turns: readTurns(1), limits: { maxSteps: 1 } });
    const results: Record<string, unknown> = {};
    h.engine.events.on('transcript', (e) => {
      if (/^budget max_steps reached at step start$/.test(e.text)) results['beforeFinish'] = h.engine.steer('survives the pause');
      // §3.7 G1: the stop EVENT still fires at the same point in the lifecycle — the deletion is in the item
      // formatter (`itemsFromEvent`), so no sink prints it, but the event is still the lifecycle anchor this
      // ordering test needs. `src/loop/stop.ts` is the harness session's, so the event text is unchanged.
      if (/^stop: [a-z_]+ at step \d+/.test(e.text) || e.text === '') {
        results['onStopLine'] = h.engine.steer('too late');
        results['unsteerOnStop'] = h.engine.unsteer();
        results['annotateOnStop'] = h.engine.annotate('late line');
        h.engine.pause();
      }
    });
    const realWrite = store.writeState.bind(store);
    store.writeState = async (state) => {
      // the FINAL write (the one with a stopReason): finish() is in flight, the snapshot is already built
      if (state.stopReason !== null && results['duringFinalWrite'] === undefined) {
        results['duringFinalWrite'] = h.engine.steer('during the write');
        results['unsteerDuringWrite'] = h.engine.unsteer();
        results['annotateDuringWrite'] = h.engine.annotate('during the write');
      }
      return realWrite(state);
    };
    await h.engine.run();
    expect(results['beforeFinish']).toEqual({ ok: true, index: 0, queued: 1 });
    expect(results['duringFinalWrite']).toEqual({ ok: false, reason: 'finished', queued: 1 });
    expect(results['onStopLine']).toEqual({ ok: false, reason: 'finished', queued: 1 });
    expect(results['unsteerDuringWrite']).toBeNull();
    expect(results['unsteerOnStop']).toBeNull();
    expect(results['annotateDuringWrite']).toBe(false);
    expect(results['annotateOnStop']).toBe(false);
    expect(h.of('pause:requested')).toEqual([]);
    // the accepted steer is in the final state.json; the refused ones nowhere
    expect(h.store.last()!.pendingDirectives?.map((d) => d.text)).toEqual(['survives the pause']);
    expect(h.of('steer:queued').map((q) => q.text)).toEqual(['survives the pause']);
    expect(h.of('steer:withdrawn')).toEqual([]);
    expect(h.of('notice').filter((n) => n.kind === 'ui')).toEqual([]);
    // the transcript ends with the run:end line: no steer or [ui] line after it
    expect(h.store.transcript.at(-1)).toMatch(/^\[run\] finished [·-] /);
    expect(h.store.transcript.filter((l) => /steer|late/.test(l))).toEqual(['[step 2] steer queued · step 2 · "survives the pause" · 1 waiting']);
    expect(h.engine.steer('after end')).toEqual({ ok: false, reason: 'finished', queued: 1 });
  });

  it('the pause case of §8.6: Esc then a typed steer while `pausing` — the steer issued before the loop top is persisted, the one issued while finish() writes is refused', async () => {
    const store = slowStore(40);
    const h = await build({ store, turns: readTurns(3), limits: { maxSteps: 3 } });
    let late: unknown;
    h.engine.events.on('step:end', (e) => {
      if (e.record.step === 1) {
        h.engine.pause();
        expect(h.engine.steer('typed while pausing').ok).toBe(true);
      }
    });
    const realWrite = store.writeState.bind(store);
    store.writeState = async (state) => {
      if (state.stopReason === 'human_pause' && late === undefined) late = h.engine.steer('Enter landed late');
      return realWrite(state);
    };
    const r = await h.engine.run();
    expect(r.stopReason).toBe('human_pause');
    expect(late).toEqual({ ok: false, reason: 'finished', queued: 1 });
    expect(h.store.last()!.pendingDirectives?.map((d) => d.text)).toEqual(['typed while pausing']);
    // --resume consumes exactly what was persisted
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: readTurns(3), limits: { maxSteps: 2 } });
    await h2.engine.run();
    expect(h2.of('steer:applied')).toEqual([{ type: 'steer:applied', step: 2, count: 1, superseded: [] }]);
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
