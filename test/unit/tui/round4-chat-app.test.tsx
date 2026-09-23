/**
 * Slot S5's App-level cases (TUI-DESIGN-4 §9.1: a slot that needs an App-level test writes it in its **own**
 * `round4-<slot>-app.test.tsx` over the shared harness, never in `app.test.tsx`).
 *
 * It also carries the **one declared `app.test.tsx` carve-out** of §3.7 (W0): D-V deletes the `run:ready` item, so
 * the two assertions that stood at `app.test.tsx:158` and `:602` — `expect(f).toContain('[run] ready
 * 20260919-120000-ab12 step 0/40')` and `expect(all).toContain('[run] ready r1 step 0/40')` — moved here, re-pinned
 * to round 4's truth: the event still fires (`--json` and `useEngine` read it) and produces **no row at all**.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createTuiRenderer } from '../../../src/tui/index.js';
import { formatTranscriptItem, itemsFromEvent, plainFirstLine } from '../../../src/tui/plain.js';
import { bubbleLines, bubbleText, clipMarkerText } from '../../../src/chat/bubbles.js';
import { conversationText } from '../../../src/chat/store.js';
import { loadRunEvents } from '../../fixtures/tui/fixtures.js';
import { CTRL_C, fakeHost, mountApp, stripSgr } from './app-harness.js';
import { fenceRow, itemRenderRows } from '../../../src/tui/Transcript.js';
import { COLOR_ROLES } from '../../../src/tui/theme.js';
import type { TranscriptItem } from '../../../src/tui/plain.js';

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('§3.7 W0 carve-out: `run:ready` is no longer an item in any sink', () => {
  it('the scripted run in `full` renders every item and NOT a `[run] ready …` row (was app.test.tsx:158)', async () => {
    const m = mountApp({ mode: 'session' });
    m.dispatch({ type: 'transcript', view: 'full' });
    await tick(10);
    const events = loadRunEvents();
    for (const e of events) m.bus.emit(e);
    await tick(80);
    const f = m.lastFrame();
    // the event is still in the stream …
    expect(events.some((e) => e.type === 'run:ready')).toBe(true);
    // … and produces zero items, so no frame and no transcript.log line can carry it (§3.6, G1)
    for (const e of events.filter((x) => x.type === 'run:ready')) expect(itemsFromEvent(e, 0)).toEqual([]);
    expect(f).not.toContain('[run] ready');
    // OWNER ADDENDUM (2026-09): what replaced it, the `[run] started · <badge> · <task>` row, is itself no longer
    // printed in the interactive transcript — the status row carries the run state. `--plain` / `--json` keep it.
    expect(f).not.toContain('[run] started · jev+llm · Fix the failing test in src/a.py');
    expect(f).toContain('[run] finished');
  });

  it('a piped (non-TTY) renderer writes the run frame and no `[run] ready r1 step 0/40` (was app.test.tsx:602)', async () => {
    const out = { frames: [] as string[], write: (s: string): boolean => (out.frames.push(s), true), columns: 100, rows: 24, isTTY: false } as unknown as NodeJS.WriteStream & { frames: string[] };
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const r = createTuiRenderer({ task: 'piped task', resumeId: null, onAbort: () => undefined, stdout: out, stdin, confirmTimeoutMs: 5 });
    await r.firstFrame();
    r.dispatch({ type: 'transcript', view: 'full' });
    await tick(20);
    await r.unmount();
    const all = stripSgr(out.frames.join(''));
    expect(all).toContain(plainFirstLine('piped task', null));
    expect(all).not.toContain('[run] ready');
  });
});

describe('§5.2 (D-Y): the conversation text the App commits', () => {
  it('a three-line message is three items, the blank line survives, and an empty item has no trailing space', () => {
    const lines = bubbleLines('hello there\n\n\tindented\n', (s) => s);
    expect(lines).toEqual(['hello there', '', '    indented']);
    expect(lines.map((l) => bubbleText('you', l))).toEqual(['[you] hello there', '[you]', '[you]     indented']);
    // the stored row of the empty item is `[you]` with NO trailing space, in every sink
    expect(formatTranscriptItem({ key: 'k', seq: 0, step: null, kind: 'chat', level: 'info', text: '', label: '[you]' })).toBe('[you]');
  });

  it('a clipped message ends with the marker, and `/copy conversation` still has the whole thing', () => {
    const long = 'x'.repeat(2000);
    const lines = bubbleLines(long, (s) => s);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(clipMarkerText(1401));
    expect(lines[1]).toContain('/copy last copies the whole message');
    expect(conversationText([{ role: 'you', text: long, at: '' }])).toContain(long);
  });
});

describe('§5.1 P-C1 turn spacing — the App-level observable', () => {
  it('a three-line `[you]` turn keeps its label on every row (§5.9 "Identity note")', async () => {
    const m = mountApp({ mode: 'session' });
    m.dispatch({ type: 'transcript', view: 'full' });
    await tick(10);
    for (const line of bubbleLines('hello there\nindented second line\nthird', (s) => s)) {
      m.bus.emit({ type: 'notice', step: null, kind: 'ui', level: 'info', text: line, label: '[you]' });
    }
    await tick(60);
    const flat = m.lastFrame().replace(/\n\s*/g, '\n');
    for (const t of ['[you] hello there', '[you] indented second line', '[you] third']) expect(flat).toContain(t);
  });

  // PENDING S2's §9.2 `Transcript.tsx` row (P-C1, wave W3): `spacerAbove` still fires unconditionally for `[you]`
  // (`Transcript.tsx:213`), so a 3-line message is still 6 rows. Un-skip with that commit.
  it.skip('a three-line `[you]` turn commits three items with one leading blank row (4 rows, not 6)', async () => {
    const m = mountApp({ mode: 'session' });
    m.dispatch({ type: 'transcript', view: 'full' });
    await tick(10);
    for (const line of bubbleLines('hello there\nindented second line\nthird', (s) => s)) {
      m.bus.emit({ type: 'notice', step: null, kind: 'ui', level: 'info', text: line, label: '[you]' });
    }
    await tick(60);
    const rows = m.lastFrame().split('\n');
    const first = rows.findIndex((l) => l.includes('[you] hello there'));
    expect(first).toBeGreaterThan(0);
    // every row of the turn carries its label (§5.9 "Identity note": the normaliser is unchanged for chat turns)
    expect(rows[first]).toContain('[you] hello there');
    expect(rows[first + 1]).toContain('[you] indented second line');
    expect(rows[first + 2]).toContain('[you] third');
    // P-C1 (S2's `Transcript.tsx` row of §9.2, landed in W3): exactly ONE spacer, above the first item of the turn
    expect(rows[first - 1]!.trim()).toBe('');
    expect(rows[first + 1]!.trim()).not.toBe('');
    expect(rows[first + 2]!.trim()).not.toBe('');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// §10's remaining S5 App rows. Each one below that is `it.skip` names the §9.2 request it waits on: the behaviour
// is another slot's file (App.tsx is S1's, Transcript.tsx is S2's) and lands in W3. The rows are written now, at
// the shape the design specifies, so the owning slot's commit un-skips a test rather than inventing one.
// ---------------------------------------------------------------------------------------------------------------

describe('§5.1 P-C2: a fenced code block in a `[jevcode]` turn', () => {
  it('the fence LINE already renders as `╶──── <lang>` in the `code` role (the half that is on disk)', () => {
    expect(fenceRow('```python').text).toBe('╶──── python');
    expect(fenceRow('```').text).toBe('╶────');
    expect(fenceRow('```python').fence).toBe(true);
    expect(fenceRow('x = 1').fence).toBe(false);
    const item: TranscriptItem = { key: 'k', seq: 0, step: null, kind: 'chat', level: 'info', text: '```python', label: '[jevcode]' };
    expect(itemRenderRows(item, 80).fence).toBe(true);
    // `code` is a real role with a marker in every theme (theme.test.ts pins the table)
    expect(COLOR_ROLES).toContain('code');
  });

  // PENDING S2's §9.2 `Transcript.tsx` row (P-C2, wave W3): `fenceRow` is per ITEM, so only the two fence lines
  // take the `code` role today — the run BETWEEN them needs the fence-run state S2 lands. Un-skip with it.
  it.skip('the four rows of a fence run (open, two body rows, close) all take the `code` role', async () => {
    const m = mountApp({ mode: 'session' });
    m.dispatch({ type: 'transcript', view: 'full' });
    await tick(10);
    for (const line of ['```python', 'x = 1', 'y = 2', '```']) m.bus.emit({ type: 'notice', step: null, kind: 'ui', level: 'info', text: line, label: '[jevcode]' });
    await tick(60);
    const items = (m.state()?.items ?? []).filter((i) => i.label === '[jevcode]');
    expect(items).toHaveLength(4);
    for (const i of items) expect(itemRenderRows(i, 80).fence).toBe(true);
  });
});

describe('§5.3 P-C7: Enter while thinking queues instead of dropping', () => {
  // PENDING S1's §9.2 `App.tsx` row (the queued-submission slot, `:1058–1117`, wave W3) and S6's `useEngine.tsx`
  // `queued` state. Today the App toasts `one moment — still thinking`, keeps the draft and DROPS the submission.
  it.skip('queue · flush · Esc cancels and restores · cap 1 · Ctrl-C ×1 drops the queue', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await tick(10);
    m.dispatch({ type: 'thinking', phase: 'replying' });
    m.stdin.write('second message');
    m.stdin.write('\r');
    await tick(20);
    // (a) the composer clears, the status row says `1 queued`, and nothing was submitted yet
    expect(m.state()?.draft.empty).toBe(true);
    expect(m.lastFrame()).toContain('1 queued');
    expect(host.submitted).toHaveLength(0);
    // (a) edge: a second Enter while one is queued keeps the toast and does NOT queue a second (cap 1)
    m.stdin.write('third\r');
    await tick(20);
    expect(m.lastFrame()).toContain('one moment — still thinking');
    // the flush: `thinking → null` submits the queued text
    m.dispatch({ type: 'thinking', phase: null });
    await tick(30);
    expect(host.submitted.map((s) => s.text)).toEqual(['second message']);
    // (c) the money-adjacent case: Ctrl-C ×1 while thinking aborts the request AND drops the queue
    const m2 = mountApp({ mode: 'session', host: fakeHost() });
    m2.dispatch({ type: 'thinking', phase: 'replying' });
    m2.stdin.write('queued one\r');
    await tick(20);
    m2.stdin.write(CTRL_C);
    await tick(20);
    expect(m2.lastFrame()).toContain('queued message dropped');
    m2.dispatch({ type: 'thinking', phase: null });
    await tick(30);
    expect(m2.host?.submitted ?? []).toHaveLength(0);
  });
});

describe('§5.4 P-C9 / §10.4: an `@` mention on the secret denylist', () => {
  // PENDING S1's §9.2 `App.tsx` row (`dispatchCtx` merge, `:856`, wave W3): `routeSend` already drops a denied
  // mention from `pinnedFiles` and reports it in `droppedMentions` (submit.ts:202–203), and `App.tsx:979` already
  // prints the notice — but nothing supplies `dispatchCtx().isDeniedPath`, so the denylist is dead code in the TUI.
  it.skip('`@.env` yields the notice and never reaches `pinnedFiles`', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await tick(10);
    m.stdin.write('look at @.env and @src/a.py\r');
    await tick(40);
    expect(host.submitted).toHaveLength(1);
    expect(host.submitted[0]!.pinnedFiles).toEqual(['src/a.py']);
    expect(m.lastFrame()).toContain('.env is on the secret denylist; JevCode never reads it');
  });
});

describe('§5.5 P-C13: `/copy last` copies the turn, not the item', () => {
  // PENDING S1's §9.2 `App.tsx` row (`/copy last`, `:1039`, wave W3): the handler copies
  // `formatTranscriptItem(items.at(-1))` — the last ITEM — so a three-line reply copies one line, and a clipped
  // `[you]` line copies the clipped row rather than the source the ledger still holds (§5.2 P-C5).
  it.skip('a 3-line `[jevcode]` turn copies 3 lines; a clipped `[you]` turn copies the unclipped source', async () => {
    const m = mountApp({ mode: 'session', host: fakeHost() });
    m.dispatch({ type: 'transcript', view: 'full' });
    await tick(10);
    for (const line of bubbleLines('one\ntwo\nthree', (s) => s)) m.bus.emit({ type: 'notice', step: null, kind: 'ui', level: 'info', text: line, label: '[jevcode]' });
    await tick(40);
    m.stdin.write('/copy last\r');
    await tick(40);
    expect(m.lastFrame()).toContain('copied 3 lines');
  });

  it('the formatter halves `/copy last` and `/copy conversation` are built on ARE on disk and exact', () => {
    // §5.2 P-C5: the ledger keeps the whole message; the clipped ROW is only what the scrollback shows
    const long = 'y'.repeat(2000);
    const lines = bubbleLines(long, (s) => s);
    expect(lines[0]!.length).toBe(600);
    expect(lines[1]).toBe(clipMarkerText(1401));
    expect(conversationText([{ role: 'you', text: long, at: '' }])).toBe(`you: ${long}`);
    // §5.5 P-C13: `you: …` / `jevcode: …` blocks with ONE blank row between turns
    expect(conversationText([{ role: 'you', text: 'a\nb', at: '' }, { role: 'jevcode', text: 'c', at: '' }])).toBe('you: a\nb\n\njevcode: c');
  });
});
