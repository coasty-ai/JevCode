/**
 * TUI-DESIGN §4.1, §4.6, §4.7, §19.0–19.1 (`buffer.test.ts`): A105 reducer vectors, grapheme-wise motion and deletion,
 * atomic chips, undo/redo coalescing rules, kill ring semantics, yank/yankPop, transpose, ↑/↓ with a sticky column,
 * word motions with `/ - _ .` separators, history navigation with a stashed draft, per-keystroke cost on a 12,000-char draft.
 */
import { describe, expect, it } from 'vitest';
import {
  COALESCE_IDLE_MS,
  RETIRED_MAX,
  TAB_SPACES,
  UNDO_MAX,
  bufferAtoms,
  chipSpans,
  createBuffer,
  defuseInserted,
  defusedLabel,
  graphemeBoundaries,
  isGraphemeBoundary,
  isLegalCursor,
  normaliseText,
  reduceBuffer,
  snapCursor,
  snapshotOf,
  wordBoundary,
  type BufferAction,
  type ChipRef,
  type Motion,
  type TextBuffer,
} from '../../../../src/tui/composer/buffer.js';
import { KILL_RING_MAX } from '../../../../src/tui/composer/killring.js';
import { filterInput, normaliseChunk } from '../../../../src/tui/composer/filter.js';
import { PasteStore } from '../../../../src/tui/composer/paste.js';
import { INSERT_POOL, bestMs, boundarySet, medianMs, mulberry32, pick } from './helpers.js';

const COLS = 80;
const ins = (text: string, paste = false): BufferAction => (paste ? { type: 'insert', text, paste: true } : { type: 'insert', text });
const mv = (to: Motion, columns = COLS): BufferAction => ({ type: 'move', to, columns });

function type(b: TextBuffer, s: string, nowMs = 0): TextBuffer {
  let cur = b;
  for (const g of Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment)) {
    cur = reduceBuffer(cur, ins(g), nowMs);
  }
  return cur;
}
function chip(n: number, lines = 5): ChipRef {
  return { n, lines, bytes: 100 * n, label: `[Pasted #${n}, ${lines} lines]` };
}

describe('createBuffer and normaliseText', () => {
  it('starts empty, or with normalised text and the cursor snapped to a legal position', () => {
    const b = createBuffer();
    expect(b).toMatchObject({ text: '', cursor: 0, preferredX: null, killRing: [], yankIndex: null, lastKill: null, undo: [], redo: [], coalescing: false, chips: [], retired: [] });
    expect(b.history).toEqual({ level: -1, stash: null, filter: 'workspace' });
    const c = createBuffer({ text: 'a\tb\r\nc\u0007', cursor: 99 });
    expect(c.text).toBe(`a${' '.repeat(TAB_SPACES)}b\nc`);
    expect(c.cursor).toBe(c.text.length);
    const d = createBuffer({ text: 'e\u0301x', cursor: 1 });
    expect(d.cursor).toBe(0); // inside the cluster → snapped back
    expect(createBuffer({ killRing: Array.from({ length: 30 }, (_, i) => `k${i}`) }).killRing.length).toBe(KILL_RING_MAX);
  });
  it('normaliseText strips C0/DEL/C1/bidi/lone surrogates, maps line separators, expands tabs — and IS filter.ts normaliseChunk (one normaliser)', () => {
    expect(normaliseText('plain\nok')).toBe('plain\nok');
    expect(normaliseText('a\u001ab\u007f\u0085')).toBe('ab');
    expect(normaliseText('\u202ex\u202c')).toBe('x');
    expect(normaliseText('a\u2028b\u2029c')).toBe('a\nb\nc');
    expect(normaliseText('\ud800a\udfff')).toBe('a');
    expect(normaliseText('👍')).toBe('👍');
    for (const s of ['a\tb', 'x\r\ny\rz', '\u0007\u009b', 'e\u0301', '\ud83d', 'a\u2028b']) expect(normaliseText(s)).toBe(normaliseChunk(s));
  });
});

describe('graphemeBoundaries / isGraphemeBoundary / snapCursor / wordBoundary', () => {
  it('lists every boundary across lines and matches the Intl.Segmenter oracle', () => {
    for (const s of ['', 'abc', 'a\nb', 'e\u0301\n👨\u200d👩\u200d👧\u200d👦x\n\n日本', '🇺🇸🇺🇸', '\n\n']) {
      expect([...graphemeBoundaries(s)]).toEqual([...boundarySet(s)].sort((x, y) => x - y));
      for (let i = 0; i <= s.length; i++) expect(isGraphemeBoundary(s, i)).toBe(boundarySet(s).has(i));
    }
  });
  it('snapCursor clamps and snaps in the requested direction, out of chips', () => {
    const t = 'ae\u0301b';
    expect(snapCursor(t, 2)).toBe(1);
    expect(snapCursor(t, 2, [], 1)).toBe(3);
    expect(snapCursor(t, -5)).toBe(0);
    expect(snapCursor(t, 50)).toBe(4);
    expect(snapCursor(t, Number.NaN)).toBe(4);
    const c = chip(1);
    const u = `x${c.label}y`;
    expect(snapCursor(u, 3, [c])).toBe(1);
    expect(snapCursor(u, 3, [c], 1)).toBe(1 + c.label.length);
  });
  it('wordBoundary uses isWordLike segments with / - _ . as separators and crosses lines', () => {
    const t = 'foo_bar baz-qux/quux.py\nnext';
    expect(wordBoundary(t, t.length, -1)).toBe(t.indexOf('next'));
    expect(wordBoundary(t, t.indexOf('next'), -1)).toBe(t.indexOf('py'));
    expect(wordBoundary(t, 7, -1)).toBe(4); // inside "foo_bar" from after "bar" → start of "bar"
    expect(wordBoundary(t, 4, -1)).toBe(0);
    expect(wordBoundary(t, 0, -1)).toBe(0);
    expect(wordBoundary(t, 0, 1)).toBe(3); // end of "foo"
    expect(wordBoundary(t, 3, 1)).toBe(7); // end of "bar"
    expect(wordBoundary(t, t.indexOf('py') + 2, 1)).toBe(t.length); // crosses to "next"
    expect(wordBoundary(t, t.length, 1)).toBe(t.length);
    expect(wordBoundary('', 0, -1)).toBe(0);
    expect(wordBoundary('\nab', 1, -1)).toBe(0); // a text starting with a newline (regression: infinite loop)
    expect(wordBoundary('\n\nab', 2, -1)).toBe(0);
    expect(wordBoundary('\nab', 0, 1)).toBe(3);
    expect(wordBoundary('   ', 3, -1)).toBe(0);
    expect(wordBoundary('日本語 テキスト', 7, -1)).toBe(4);
    expect(wordBoundary('a', Number.NaN, 1)).toBe(1);
    // ICU breaks words between an LV syllable and a trailing jamo; the motion still lands on a grapheme boundary
    const hangul = '中❤षר\ud55c\u11a8x';
    expect(boundarySet(hangul).has(wordBoundary(hangul, 6, -1))).toBe(true);
    expect(boundarySet(hangul).has(wordBoundary(hangul, 4, 1))).toBe(true);
  });
});

describe('insert, newline, backspace, delete', () => {
  it('types by grapheme, expands tabs, normalises pastes with \\r\\n\\t (A105)', () => {
    let b = type(createBuffer(), 'hi');
    expect(b.text).toBe('hi');
    expect(b.cursor).toBe(2);
    b = reduceBuffer(b, ins('\t'));
    expect(b.text).toBe('hi    ');
    b = reduceBuffer(b, ins('a\r\nb\tc', true));
    expect(b.text).toBe('hi    a\nb    c');
    expect(b.cursor).toBe(b.text.length);
    b = reduceBuffer(b, ins('\u001a')); // Ctrl+Z byte as text: nothing inserted, state unchanged
    expect(b.text).toBe('hi    a\nb    c');
    expect(reduceBuffer(createBuffer(), ins('')).text).toBe('');
  });
  it('a 64 KB paste is one undo step and one insert', () => {
    const big = 'line\r\n'.repeat(11000);
    const b = reduceBuffer(createBuffer({ text: 'pre' }), ins(big, true));
    expect(b.text).toBe('pre' + 'line\n'.repeat(11000));
    expect(b.undo.length).toBe(1);
    expect(reduceBuffer(b, { type: 'undo' }).text).toBe('pre');
  });
  it('keeps the cursor on a boundary when marks join neighbours', () => {
    let b = type(createBuffer(), 'e');
    b = reduceBuffer(b, ins('\u0301'));
    expect(b.text).toBe('e\u0301');
    expect(b.cursor).toBe(2);
    let c = createBuffer({ text: '\u0301', cursor: 0 });
    c = reduceBuffer(c, ins('a'));
    expect(c.text).toBe('a\u0301');
    expect(boundarySet(c.text).has(c.cursor)).toBe(true);
    let d = createBuffer({ text: '👩x', cursor: 2 });
    d = reduceBuffer(d, ins('\u200d'));
    expect(boundarySet(d.text).has(d.cursor)).toBe(true);
  });
  it('newline inserts \\n as its own step; backspace/delete remove whole graphemes and cross line breaks', () => {
    let b = type(createBuffer(), 'ab');
    b = reduceBuffer(b, { type: 'newline' });
    expect(b.text).toBe('ab\n');
    b = reduceBuffer(b, ins('👨\u200d👩\u200d👧\u200d👦'));
    b = reduceBuffer(b, ins('e\u0301'));
    expect(b.text).toBe('ab\n👨\u200d👩\u200d👧\u200d👦e\u0301');
    b = reduceBuffer(b, { type: 'backspace' });
    expect(b.text).toBe('ab\n👨\u200d👩\u200d👧\u200d👦');
    b = reduceBuffer(b, { type: 'backspace' });
    expect(b.text).toBe('ab\n');
    b = reduceBuffer(b, { type: 'backspace' });
    expect(b.text).toBe('ab');
    b = reduceBuffer(b, mv('start'));
    b = reduceBuffer(b, { type: 'delete' });
    expect(b.text).toBe('b');
    b = reduceBuffer(b, { type: 'delete' });
    expect(b.text).toBe('');
    const same = reduceBuffer(b, { type: 'delete' });
    expect(same.text).toBe('');
    expect(reduceBuffer(createBuffer(), { type: 'backspace' }).text).toBe('');
  });
  it('routes Ink leak-through through the filter, never into the text (A105: [I, [O, [?0u, [?62;22c, [24;80R, mouse, OSC 11)', () => {
    let b = createBuffer();
    for (const leak of ['[I', '[O', '[?0u', '[?62;22c', '[24;80R', '[27;2;13~', '[<64;10;5M', ']11;rgb:1e1e/1e1e/1e1e', ']11;rgb:1e/1e/1e', '\\']) {
      const f = filterInput(leak);
      if (f.ok) b = reduceBuffer(b, ins(f.text));
    }
    expect(b.text).toBe('');
    const ime = filterInput('日本語');
    if (ime.ok) b = reduceBuffer(b, ins(ime.text));
    expect(b.text).toBe('日本語');
    expect(b.undo.length).toBe(1); // an IME commit is one step
  });
});

describe('chips are atomic', () => {
  it('a chip inserts its label as one token; motions skip it; Backspace/Delete/kill remove it whole and drop the ChipRef', () => {
    const c = chip(1);
    let b = type(createBuffer(), 'a b');
    b = reduceBuffer(b, mv('left'));
    b = reduceBuffer(b, { type: 'chip', chip: c });
    expect(b.text).toBe(`a ${c.label}b`);
    expect(b.chips).toEqual([c]);
    expect(b.cursor).toBe(2 + c.label.length);
    expect(bufferAtoms(b)).toEqual([{ start: 2, end: 2 + c.label.length }]);
    b = reduceBuffer(b, mv('left'));
    expect(b.cursor).toBe(2);
    b = reduceBuffer(b, mv('right'));
    expect(b.cursor).toBe(2 + c.label.length);
    const bs = reduceBuffer(b, { type: 'backspace' });
    expect(bs.text).toBe('a b');
    expect(bs.chips).toEqual([]);
    expect(bs.retired).toEqual([c]); // parked, not lost: the label may come back
    const del = reduceBuffer(reduceBuffer(b, mv('left')), { type: 'delete' });
    expect(del.text).toBe('a b');
    expect(del.chips).toEqual([]);
    const killed = reduceBuffer(b, { type: 'kill', what: 'wordBack' });
    expect(killed.text).toBe('a b');
    expect(killed.killRing[0]).toBe(c.label);
    expect(killed.chips).toEqual([]);
    expect(killed.retired).toEqual([c]);
    const undone = reduceBuffer(bs, { type: 'undo' });
    expect(undone.text).toBe(`a ${c.label}b`);
    expect(undone.chips).toEqual([c]);
    expect(undone.retired).toEqual([]);
    const redone = reduceBuffer(undone, { type: 'redo' });
    expect(redone.chips).toEqual([]);
    expect(redone.retired).toEqual([c]);
  });

  it('kill + yank moves a chip: the ChipRef survives the round trip, the label stays atomic and still expands (finding 2)', () => {
    const store = new PasteStore();
    const r = store.accept('l1\nl2\nl3\nl4\nl5', { rows: 24 });
    if (r.kind !== 'chip') throw new Error('chip');
    const c = r.chip;
    let b = type(createBuffer(), 'see ');
    b = reduceBuffer(b, { type: 'chip', chip: c });
    b = type(b, ' now');
    // Ctrl-A, Ctrl-K: the whole line (chip included) goes to the kill ring
    b = reduceBuffer(b, mv('home'));
    b = reduceBuffer(b, { type: 'kill', what: 'toEnd' });
    expect(b.text).toBe('');
    expect(b.chips).toEqual([]);
    expect(b.retired).toEqual([c]);
    expect(b.killRing[0]).toBe(`see ${c.label} now`);
    // Ctrl-Y: the label returns and re-adopts its ChipRef
    b = reduceBuffer(b, { type: 'yank' });
    expect(b.text).toBe(`see ${c.label} now`);
    expect(b.chips).toEqual([c]);
    expect(b.retired).toEqual([]);
    expect(bufferAtoms(b).length).toBe(1);
    // motions skip the label
    b = reduceBuffer(b, mv('start'));
    for (let i = 0; i < 4; i++) b = reduceBuffer(b, mv('right'));
    expect(b.cursor).toBe(4);
    b = reduceBuffer(b, mv('right'));
    expect(b.cursor).toBe(4 + c.label.length); // one step over the whole chip, never into `[P|asted`
    for (let i = 0; i < 6; i++) b = reduceBuffer(b, mv('right'));
    expect(b.cursor).toBe(b.text.length);
    // and the body comes back at submit
    expect(store.expand(b.text, b.chips)).toEqual({ ok: true, text: 'see l1\nl2\nl3\nl4\nl5 now' });
    // the same through Ctrl-W (wordBack) on the label alone
    let w = reduceBuffer(createBuffer(), { type: 'chip', chip: c });
    w = reduceBuffer(w, { type: 'kill', what: 'wordBack' });
    expect(w.text).toBe('');
    expect(w.retired).toEqual([c]);
    w = reduceBuffer(w, { type: 'yank' });
    expect(w.chips).toEqual([c]);
    expect(bufferAtoms(w)).toEqual([{ start: 0, end: c.label.length }]);
  });

  it('yankPop rotating a chip label back in re-adopts it; rotating it out retires it again', () => {
    const c = chip(6, 3);
    let b = reduceBuffer(createBuffer({ text: 'plain words' }), mv('start'));
    b = reduceBuffer(b, { type: 'kill', what: 'wordForward' }); // ring: ['plain']
    b = reduceBuffer(b, mv('finish'));
    b = reduceBuffer(b, { type: 'chip', chip: c });
    b = reduceBuffer(b, { type: 'kill', what: 'wordBack' }); // ring: [label, 'plain']
    expect(b.killRing).toEqual([c.label, 'plain']);
    expect(b.retired).toEqual([c]);
    b = reduceBuffer(b, { type: 'yank' }); // label back
    expect(b.chips).toEqual([c]);
    b = reduceBuffer(b, { type: 'yankPop' }); // → 'plain'
    expect(b.text).toBe(' wordsplain');
    expect(b.chips).toEqual([]);
    expect(b.retired).toEqual([c]);
    b = reduceBuffer(b, { type: 'yankPop' }); // wraps → label
    expect(b.text).toBe(` words${c.label}`);
    expect(b.chips).toEqual([c]);
    expect(b.retired).toEqual([]);
    expect(bufferAtoms(b).length).toBe(1);
  });

  it('retired refs are bounded, carried by createBuffer across submit, dropped by clear, and re-adopted by setText (editor round trip)', () => {
    let b = createBuffer();
    for (let n = 1; n <= RETIRED_MAX + 5; n++) {
      b = reduceBuffer(b, { type: 'chip', chip: chip(n, 2) });
      b = reduceBuffer(b, { type: 'kill', what: 'wordBack' }); // the chip insert ends the kill chain, so each label is its own ring entry
    }
    expect(b.retired.length).toBe(RETIRED_MAX);
    expect(b.retired[0]?.n).toBe(RETIRED_MAX + 5); // newest first
    expect(b.killRing[0]).toBe(chip(RETIRED_MAX + 5, 2).label);
    expect(RETIRED_MAX).toBe(2 * KILL_RING_MAX);
    const carried = createBuffer({ killRing: b.killRing, retired: b.retired });
    expect(carried.retired).toEqual(b.retired);
    const yanked = reduceBuffer(carried, { type: 'yank' });
    expect(yanked.chips.map((c) => c.n)).toEqual([RETIRED_MAX + 5]);
    const cleared = reduceBuffer(yanked, { type: 'clear' });
    expect(cleared.chips).toEqual([]);
    expect(cleared.retired).toEqual([]);
    // external editor: the label was deleted in the editor, then a second round trip brings it back
    const c = chip(1, 4);
    let e = reduceBuffer(createBuffer(), { type: 'chip', chip: c });
    e = reduceBuffer(e, { type: 'setText', text: 'edited without the chip', pushUndo: true });
    expect(e.chips).toEqual([]);
    expect(e.retired).toEqual([c]);
    e = reduceBuffer(e, { type: 'setText', text: `back: ${c.label}`, pushUndo: true });
    expect(e.chips).toEqual([c]);
    expect(e.retired).toEqual([]);
  });

  it('typed or pasted plain text equal to a live (or retired) chip label is defused, so it can never alias the chip (finding 12)', () => {
    const c = chip(1, 5);
    let b = reduceBuffer(createBuffer(), { type: 'chip', chip: c });
    b = reduceBuffer(b, ins(` and again ${c.label}`, true));
    expect(b.text).toBe(`${c.label} and again [Pasted # 1, 5 lines]`);
    expect(bufferAtoms(b).length).toBe(1);
    expect(chipSpans(b.text, b.chips).length).toBe(1);
    expect(defusedLabel(c.label)).toBe('[Pasted # 1, 5 lines]');
    expect(defusedLabel('no-hash')).toBe('n o-hash');
    expect(defuseInserted('nothing here', 0, 12, [c])).toEqual({ text: 'nothing here', cursor: 12 });
    expect(defuseInserted(c.label, 0, c.label.length, [])).toEqual({ text: c.label, cursor: c.label.length });
    // an existing label touching the inserted range at either end is not a new occurrence and stays a chip
    expect(defuseInserted(`${c.label}x`, c.label.length, 1, [c])).toEqual({ text: `${c.label}x`, cursor: c.label.length + 1 });
    expect(defuseInserted(`x${c.label}`, 0, 1, [c])).toEqual({ text: `x${c.label}`, cursor: 1 });
    // typed grapheme by grapheme: the keystroke that completes the label is the one that defuses it, and the cursor follows
    let t = reduceBuffer(createBuffer(), { type: 'chip', chip: c });
    t = reduceBuffer(t, { type: 'newline' });
    t = type(t, c.label);
    expect(t.text).toBe(`${c.label}\n[Pasted # 1, 5 lines]`);
    expect(t.cursor).toBe(t.text.length);
    expect(chipSpans(t.text, t.chips).length).toBe(1);
    // typing the head in front of an existing tail: the space lands after the cursor, which stays put
    const tail = '1, 5 lines]';
    let h = reduceBuffer(createBuffer({ text: `${c.label}\n${tail}` }), { type: 'setText', text: `${c.label}\n${tail}`, cursor: c.label.length + 1, pushUndo: false });
    h = { ...h, chips: [c] };
    h = reduceBuffer(h, ins('[Pasted #', true));
    expect(h.text).toBe(`${c.label}\n[Pasted # ${tail}`);
    expect([c.label.length + 1 + '[Pasted #'.length, c.label.length + 1 + '[Pasted # '.length]).toContain(h.cursor);
    expect(chipSpans(h.text, h.chips).length).toBe(1);
    // a retired label typed back is defused too; only the kill ring may legitimately return it
    let r = reduceBuffer(createBuffer(), { type: 'chip', chip: c });
    r = reduceBuffer(r, { type: 'backspace' });
    r = reduceBuffer(r, ins(c.label, true));
    expect(r.chips).toEqual([]);
    expect(r.text).toBe('[Pasted # 1, 5 lines]');
    // the PasteStore never expands the defused form
    const store = new PasteStore();
    const real = store.accept('a\nb\nc\nd\ne', { rows: 24 });
    if (real.kind !== 'chip') throw new Error('chip');
    let d = reduceBuffer(createBuffer(), { type: 'chip', chip: real.chip });
    d = reduceBuffer(d, ins(` ${real.chip.label}`, true));
    expect(store.expand(d.text, d.chips)).toEqual({ ok: true, text: 'a\nb\nc\nd\ne [Pasted # 1, 5 lines]' });
  });
  it('a cursor can never rest inside a chip; setText re-derives chips from labels; a duplicated label keeps the ref', () => {
    const c = chip(2, 1);
    let b = reduceBuffer(createBuffer(), { type: 'chip', chip: c });
    b = reduceBuffer(b, { type: 'setText', text: `${c.label} and ${c.label}`, cursor: 3, pushUndo: true });
    expect(b.cursor).toBe(0);
    expect(b.chips).toEqual([c]);
    expect(chipSpans(b.text, b.chips).length).toBe(2);
    b = reduceBuffer(b, mv('finish'));
    b = reduceBuffer(b, { type: 'backspace' });
    expect(b.text).toBe(`${c.label} and `);
    expect(b.chips).toEqual([c]); // one occurrence remains
    b = reduceBuffer(b, { type: 'setText', text: 'gone', pushUndo: false });
    expect(b.chips).toEqual([]);
    expect(b.retired).toEqual([c]);
    expect(reduceBuffer(b, { type: 'chip', chip: { ...c, label: '' } })).toBe(b);
  });
  it('a combining mark typed right after a chip stands alone: the chip end stays a legal boundary and motions honour it', () => {
    const c = chip(4, 2);
    let b = reduceBuffer(createBuffer(), { type: 'chip', chip: c });
    b = reduceBuffer(b, ins('\u0301'));
    expect(b.text).toBe(`${c.label}\u0301`);
    expect(b.cursor).toBe(b.text.length);
    b = reduceBuffer(b, mv('left'));
    expect(b.cursor).toBe(c.label.length); // the mark is its own unit; the chip end is legal
    expect(isLegalCursor(b.text, c.label.length, b.chips)).toBe(true);
    expect(isLegalCursor(b.text, 3, b.chips)).toBe(false);
    expect(isLegalCursor(b.text, -1, b.chips)).toBe(false);
    b = reduceBuffer(b, mv('left'));
    expect(b.cursor).toBe(0);
    b = reduceBuffer(b, mv('right'));
    expect(b.cursor).toBe(c.label.length);
    b = reduceBuffer(b, { type: 'delete' });
    expect(b.text).toBe(c.label);
    expect(b.chips).toEqual([c]);
  });
  it('up/down and word motions land outside chips', () => {
    const c = chip(3, 4);
    let b = reduceBuffer(createBuffer({ text: 'short\n' }), { type: 'chip', chip: c });
    b = reduceBuffer(b, mv('up'));
    expect(b.cursor).toBe(5);
    b = reduceBuffer(b, mv('down'));
    expect([6, 6 + c.label.length]).toContain(b.cursor);
    b = reduceBuffer(b, { type: 'setText', text: `x ${c.label} y`, cursor: 2 + c.label.length + 1, pushUndo: false });
    b = reduceBuffer(b, mv('wordLeft'));
    expect(b.cursor).toBe(2);
  });
});

describe('motions', () => {
  it('left/right/home/end/start/finish by grapheme and line', () => {
    let b = createBuffer({ text: 'ab\n日e\u0301\nxyz', cursor: 0 });
    b = reduceBuffer(b, mv('right'));
    expect(b.cursor).toBe(1);
    b = reduceBuffer(b, mv('end'));
    expect(b.cursor).toBe(2);
    b = reduceBuffer(b, mv('right'));
    expect(b.cursor).toBe(3); // over the newline
    b = reduceBuffer(b, mv('right'));
    expect(b.cursor).toBe(4);
    b = reduceBuffer(b, mv('right'));
    expect(b.cursor).toBe(6); // over e + U+0301
    b = reduceBuffer(b, mv('left'));
    expect(b.cursor).toBe(4);
    b = reduceBuffer(b, mv('home'));
    expect(b.cursor).toBe(3);
    b = reduceBuffer(b, mv('finish'));
    expect(b.cursor).toBe(b.text.length);
    b = reduceBuffer(b, mv('start'));
    expect(b.cursor).toBe(0);
    expect(reduceBuffer(b, mv('left')).cursor).toBe(0);
    expect(reduceBuffer(reduceBuffer(b, mv('finish')), mv('right')).cursor).toBe(b.text.length);
  });
  it('word motions honour separators and cross lines', () => {
    let b = createBuffer({ text: 'src/tui/composer.ts is-good\nend', cursor: 0 });
    b = reduceBuffer(b, mv('wordRight'));
    expect(b.cursor).toBe(3);
    b = reduceBuffer(b, mv('wordRight'));
    expect(b.cursor).toBe(7);
    b = reduceBuffer(b, mv('finish'));
    b = reduceBuffer(b, mv('wordLeft'));
    expect(b.cursor).toBe(b.text.indexOf('end'));
    b = reduceBuffer(b, mv('wordLeft'));
    expect(b.cursor).toBe(b.text.indexOf('good'));
    b = reduceBuffer(b, mv('wordLeft'));
    expect(b.cursor).toBe(b.text.indexOf('is'));
  });
  it('up/down move by visual row with a sticky preferred column; first/last row are no-ops', () => {
    const text = 'abcdef\nxy\n12345';
    let b = createBuffer({ text, cursor: 5 });
    b = reduceBuffer(b, mv('down'));
    expect(b.cursor).toBe(9); // end of 'xy' (x = 2 < 5)
    expect(b.preferredX).toBe(5);
    b = reduceBuffer(b, mv('down'));
    expect(b.cursor).toBe(15); // '12345' col 5
    b = reduceBuffer(b, mv('up'));
    b = reduceBuffer(b, mv('up'));
    expect(b.cursor).toBe(5); // back to col 5 on the first line
    const top = reduceBuffer(b, mv('up'));
    expect(top.cursor).toBe(5);
    expect(top.preferredX).toBe(5);
    const bottom = reduceBuffer(createBuffer({ text, cursor: text.length }), mv('down'));
    expect(bottom.cursor).toBe(text.length);
    // a horizontal motion clears the sticky column
    expect(reduceBuffer(b, mv('left')).preferredX).toBeNull();
  });
  it('up/down across soft wraps and wide cells stay on grapheme boundaries', () => {
    const text = 'hello world foo bar日本語 tail';
    let b = createBuffer({ text, cursor: text.length });
    for (let i = 0; i < 6; i++) {
      b = reduceBuffer(b, mv('up', 12));
      expect(boundarySet(text).has(b.cursor)).toBe(true);
    }
    expect(b.cursor).toBeLessThan(12);
    for (let i = 0; i < 6; i++) {
      b = reduceBuffer(b, mv('down', 12));
      expect(boundarySet(text).has(b.cursor)).toBe(true);
    }
    const wide = createBuffer({ text: '日本語\nab', cursor: 2 });
    expect(reduceBuffer(wide, mv('down')).cursor).toBe(6); // col 4 → end of 'ab'
  });
});

describe('undo / redo / coalescing (§4.7)', () => {
  it('consecutive single-grapheme inserts share one step until whitespace, a motion or 2 s idle; paste is one step', () => {
    let b = type(createBuffer(), 'ab cd');
    expect(b.undo.length).toBe(2); // "ab " then "cd"
    b = reduceBuffer(b, { type: 'undo' });
    expect(b.text).toBe('ab ');
    b = reduceBuffer(b, { type: 'undo' });
    expect(b.text).toBe('');
    b = reduceBuffer(b, { type: 'redo' });
    expect(b.text).toBe('ab ');
    let m = type(createBuffer(), 'ab');
    m = reduceBuffer(m, mv('left'));
    m = type(m, 'x');
    expect(m.undo.length).toBe(2);
    let idle = reduceBuffer(createBuffer(), ins('a'), 1000);
    idle = reduceBuffer(idle, ins('b'), 1000 + COALESCE_IDLE_MS);
    expect(idle.undo.length).toBe(1);
    idle = reduceBuffer(idle, ins('c'), 1000 + COALESCE_IDLE_MS * 2 + 1);
    expect(idle.undo.length).toBe(2);
    let p = type(createBuffer(), 'x');
    p = reduceBuffer(p, ins('multi\nline', true));
    p = type(p, 'y');
    expect(p.undo.length).toBe(3);
    expect(reduceBuffer(p, { type: 'undo' }).text).toBe('xmulti\nline');
  });
  it('caps both stacks at 100, clears redo on a new edit and honours undo(redo(x)) == x', () => {
    let b = createBuffer();
    for (let i = 0; i < 150; i++) b = reduceBuffer(b, ins(`${i} `, true));
    expect(b.undo.length).toBe(UNDO_MAX);
    for (let i = 0; i < 150; i++) b = reduceBuffer(b, { type: 'undo' });
    expect(b.redo.length).toBe(UNDO_MAX);
    expect(b.undo.length).toBe(0);
    const x = reduceBuffer(b, { type: 'redo' });
    const y = reduceBuffer(x, { type: 'redo' });
    const back = reduceBuffer(y, { type: 'undo' });
    expect(snapshotOf(back)).toEqual(snapshotOf(x));
    expect(back.undo).toEqual(x.undo);
    expect(back.redo).toEqual(x.redo);
    const edited = reduceBuffer(x, ins('!'));
    expect(edited.redo).toEqual([]);
    expect(reduceBuffer(createBuffer(), { type: 'undo' }).text).toBe('');
    expect(reduceBuffer(createBuffer(), { type: 'redo' }).text).toBe('');
  });
  it('clear pushes one snapshot so Ctrl+_ restores; setText pushUndo true/false', () => {
    let b = type(createBuffer(), 'draft');
    b = reduceBuffer(b, { type: 'clear' });
    expect(b.text).toBe('');
    expect(b.cursor).toBe(0);
    expect(reduceBuffer(b, { type: 'undo' }).text).toBe('draft');
    expect(reduceBuffer(createBuffer(), { type: 'clear' }).undo.length).toBe(0); // empty: nothing to snapshot
    const s = reduceBuffer(b, { type: 'setText', text: 'from editor', pushUndo: true });
    expect(s.cursor).toBe('from editor'.length);
    expect(reduceBuffer(s, { type: 'undo' }).text).toBe('');
    const q = reduceBuffer(s, { type: 'setText', text: 'quiet', cursor: 2, pushUndo: false });
    expect(q.undo).toEqual(s.undo);
    expect(q.cursor).toBe(2);
  });
});

describe('kill ring, yank, yankPop, transpose', () => {
  it('kills to end/start/word and concatenates consecutive kills in reading order', () => {
    let b = createBuffer({ text: 'one two three', cursor: 4 });
    b = reduceBuffer(b, { type: 'kill', what: 'toEnd' });
    expect(b.text).toBe('one ');
    expect(b.killRing).toEqual(['two three']);
    expect(b.lastKill).toBe('append');
    b = reduceBuffer(b, { type: 'kill', what: 'wordBack' });
    expect(b.text).toBe('');
    expect(b.killRing).toEqual(['one two three']); // backward kill prepends
    expect(b.lastKill).toBe('prepend');
    let c = createBuffer({ text: 'alpha beta gamma', cursor: 0 });
    c = reduceBuffer(c, { type: 'kill', what: 'wordForward' });
    c = reduceBuffer(c, { type: 'kill', what: 'wordForward' });
    expect(c.killRing).toEqual(['alpha beta']);
    c = reduceBuffer(c, mv('right'));
    c = reduceBuffer(c, { type: 'kill', what: 'toEnd' });
    expect(c.killRing).toEqual(['gamma', 'alpha beta']); // a motion broke the chain
    let d = createBuffer({ text: 'ab\ncd', cursor: 2 });
    d = reduceBuffer(d, { type: 'kill', what: 'toEnd' }); // at EOL: kills the newline
    expect(d.text).toBe('abcd');
    let e = createBuffer({ text: 'xy z', cursor: 2 });
    e = reduceBuffer(e, { type: 'kill', what: 'toStart' });
    expect(e.text).toBe(' z');
    expect(e.cursor).toBe(0);
    expect(reduceBuffer(createBuffer(), { type: 'kill', what: 'toEnd' }).killRing).toEqual([]);
  });
  it('the ring holds 16 entries and survives clear/setText (submit)', () => {
    let b = createBuffer();
    for (let i = 0; i < 20; i++) {
      b = reduceBuffer(b, { type: 'setText', text: `k${i}`, pushUndo: false });
      b = reduceBuffer(b, mv('start'));
      b = reduceBuffer(b, { type: 'kill', what: 'toEnd' });
      b = reduceBuffer(b, mv('start')); // break the chain
    }
    expect(b.killRing.length).toBe(KILL_RING_MAX);
    expect(b.killRing[0]).toBe('k19');
    const after = createBuffer({ killRing: b.killRing });
    expect(after.killRing).toEqual(b.killRing);
  });
  it('yank inserts the newest kill; Alt+Y rotates through older entries; undo returns to the pre-yank text', () => {
    let b = createBuffer({ text: 'a b c', cursor: 5 });
    b = reduceBuffer(b, { type: 'kill', what: 'wordBack' });
    b = reduceBuffer(b, mv('start'));
    b = reduceBuffer(b, { type: 'kill', what: 'wordForward' });
    expect(b.killRing).toEqual(['a', 'c']);
    b = reduceBuffer(b, mv('finish'));
    const beforeYank = b.text;
    b = reduceBuffer(b, { type: 'yank' });
    expect(b.text).toBe(beforeYank + 'a');
    expect(b.yankIndex).toBe(0);
    b = reduceBuffer(b, { type: 'yankPop' });
    expect(b.text).toBe(beforeYank + 'c');
    expect(b.yankIndex).toBe(1);
    b = reduceBuffer(b, { type: 'yankPop' });
    expect(b.text).toBe(beforeYank + 'a');
    expect(reduceBuffer(b, { type: 'undo' }).text).toBe(beforeYank);
    const moved = reduceBuffer(b, mv('left'));
    expect(reduceBuffer(moved, { type: 'yankPop' })).toBe(moved); // not right after a yank
    expect(reduceBuffer(createBuffer(), { type: 'yank' }).text).toBe('');
  });
  it('transpose swaps graphemes, acts on the two preceding ones at a line end, and is inert without two units', () => {
    let b = createBuffer({ text: 'ab日', cursor: 1 });
    b = reduceBuffer(b, { type: 'transpose' });
    expect(b.text).toBe('ba日');
    expect(b.cursor).toBe(2);
    b = reduceBuffer(b, { type: 'transpose' });
    expect(b.text).toBe('b日a');
    expect(b.cursor).toBe(3);
    b = reduceBuffer(b, { type: 'transpose' }); // at line end: swap the two before
    expect(b.text).toBe('ba日');
    expect(b.cursor).toBe(3);
    const start = createBuffer({ text: 'ab', cursor: 0 });
    expect(reduceBuffer(start, { type: 'transpose' })).toBe(start);
    const one = createBuffer({ text: 'a', cursor: 1 });
    expect(reduceBuffer(one, { type: 'transpose' })).toBe(one);
    const lineStart = createBuffer({ text: 'ab\ncd', cursor: 3 });
    expect(reduceBuffer(lineStart, { type: 'transpose' })).toBe(lineStart);
    const combining = createBuffer({ text: 'e\u0301x', cursor: 2 });
    expect(reduceBuffer(combining, { type: 'transpose' }).text).toBe('xe\u0301');
  });
});

describe('history navigation (§4.6)', () => {
  const entries = ['oldest', 'middle', 'newest'];
  it('Up stashes the draft and walks older entries; Down returns; the cursor lands at the end', () => {
    let b = type(createBuffer(), 'draft');
    b = reduceBuffer(b, mv('start'));
    b = reduceBuffer(b, { type: 'history', dir: 1, entries });
    expect(b.text).toBe('newest');
    expect(b.cursor).toBe(6);
    expect(b.history.level).toBe(0);
    expect(b.history.stash).toEqual({ text: 'draft', cursor: 0, chips: [] });
    b = reduceBuffer(b, { type: 'history', dir: 1, entries });
    expect(b.text).toBe('middle');
    b = reduceBuffer(b, { type: 'history', dir: 1, entries });
    expect(b.text).toBe('oldest');
    expect(reduceBuffer(b, { type: 'history', dir: 1, entries })).toBe(b); // past the oldest: no-op
    b = reduceBuffer(b, { type: 'history', dir: -1, entries });
    b = reduceBuffer(b, { type: 'history', dir: -1, entries });
    b = reduceBuffer(b, { type: 'history', dir: -1, entries });
    expect(b.text).toBe('draft');
    expect(b.cursor).toBe(0);
    expect(b.history).toEqual({ level: -1, stash: null, filter: 'workspace' });
    expect(reduceBuffer(b, { type: 'history', dir: -1, entries })).toBe(b);
    expect(reduceBuffer(createBuffer(), { type: 'history', dir: 1, entries: [] })).toEqual(createBuffer());
  });
  it('a recall is one undo step; editing a recalled entry keeps the level and the stashed draft (readline), so Down still returns to the draft', () => {
    let b = type(createBuffer(), 'my draft');
    b = reduceBuffer(b, { type: 'history', dir: 1, entries });
    b = reduceBuffer(b, { type: 'history', dir: 1, entries });
    expect(reduceBuffer(b, { type: 'undo' }).text).toBe('my draft');
    const edited = type(b, '!');
    expect(edited.text).toBe('middle!');
    expect(edited.history.level).toBe(1);
    expect(edited.history.stash).toEqual({ text: 'my draft', cursor: 8, chips: [] });
    // Down, Down: back through 'newest' to the untouched draft
    let down = reduceBuffer(edited, { type: 'history', dir: -1, entries });
    expect(down.text).toBe('newest');
    expect(down.history.level).toBe(0);
    down = reduceBuffer(down, { type: 'history', dir: -1, entries });
    expect(down.text).toBe('my draft');
    expect(down.cursor).toBe(8);
    expect(down.history).toEqual({ level: -1, stash: null, filter: 'workspace' });
    // leaving an edited level pushed one undo snapshot, so Ctrl+_ brings the edit back
    const back = reduceBuffer(reduceBuffer(edited, { type: 'history', dir: -1, entries }), { type: 'undo' });
    expect(back.text).toBe('middle!');
    // leaving an untouched level pushes nothing
    const untouched = reduceBuffer(b, { type: 'history', dir: -1, entries });
    expect(untouched.undo.length).toBe(b.undo.length);
    // Up from the edited level walks on to the older entry
    const older = reduceBuffer(edited, { type: 'history', dir: 1, entries });
    expect(older.text).toBe('oldest');
    expect(older.history.stash?.text).toBe('my draft');
    // undo/redo while browsing keep the browsing state too
    const undone = reduceBuffer(edited, { type: 'undo' });
    expect(undone.history.level).toBe(1);
    expect(undone.history.stash?.text).toBe('my draft');
    // Ctrl-C abandons browsing: live draft, empty; the draft is two undos away
    const cleared = reduceBuffer(edited, { type: 'clear' });
    expect(cleared.text).toBe('');
    expect(cleared.history).toEqual({ level: -1, stash: null, filter: 'workspace' });
    expect(reduceBuffer(reduceBuffer(reduceBuffer(cleared, { type: 'undo' }), { type: 'undo' }), { type: 'undo' }).text).toBe('my draft');
    // the filter switch restores the stash
    const widened = reduceBuffer(b, { type: 'historyFilter', filter: 'all' });
    expect(widened.text).toBe('my draft');
    expect(widened.history).toEqual({ level: -1, stash: null, filter: 'all' });
    expect(reduceBuffer(widened, { type: 'historyFilter', filter: 'all' })).toBe(widened);
  });

  it('historyFilter on the live draft breaks the kill/yank/coalescing chains like every other action', () => {
    let b = createBuffer({ text: 'one two', cursor: 7 });
    b = reduceBuffer(b, { type: 'kill', what: 'wordBack' });
    expect(b.lastKill).toBe('prepend');
    const f = reduceBuffer(b, { type: 'historyFilter', filter: 'workspace' });
    expect(f).not.toBe(b);
    expect(f.lastKill).toBeNull();
    expect(f.text).toBe('one ');
    // a following kill starts a new ring entry instead of concatenating
    const k = reduceBuffer(reduceBuffer(f, mv('start')), { type: 'kill', what: 'wordForward' });
    expect(k.killRing).toEqual(['one', 'two']);
    let y = reduceBuffer(createBuffer({ killRing: ['a', 'b'] }), { type: 'yank' });
    expect(y.yankIndex).toBe(0);
    y = reduceBuffer(y, { type: 'historyFilter', filter: 'workspace' });
    expect(y.yankIndex).toBeNull();
    expect(reduceBuffer(y, { type: 'yankPop' })).toBe(y);
    const c = type(createBuffer(), 'ab');
    expect(c.coalescing).toBe(true);
    const cf = reduceBuffer(c, { type: 'historyFilter', filter: 'workspace' });
    expect(cf.coalescing).toBe(false);
    expect(type(cf, 'c').undo.length).toBe(2);
    // with nothing to break and the same filter, the buffer is returned as is
    const idle = reduceBuffer(createBuffer({ text: 'x' }), mv('start'));
    expect(reduceBuffer(idle, { type: 'historyFilter', filter: 'workspace' })).toBe(idle);
  });
});

describe('perf (TUI-DESIGN §4.1: a 12,000-char draft stays under 1 ms per keystroke; asserted at 3× = 3 ms)', () => {
  it('insert, backspace and move on a 12,000-char mixed multi-line draft', () => {
    const r = mulberry32(2026);
    let text = '';
    while (text.length < 12000) text += r() < 0.03 ? '\n' : pick(r, INSERT_POOL);
    const positions = [...boundarySet(text)];
    let b = createBuffer({ text, cursor: positions[Math.floor(positions.length / 2)] ?? 0 });
    const cases: [string, () => void][] = [
      ['insert', () => { b = reduceBuffer(b, ins('x'), 0); }],
      ['backspace', () => { b = reduceBuffer(b, { type: 'backspace' }); }],
      ['move right', () => { b = reduceBuffer(b, mv('right')); }],
      ['move down', () => { b = reduceBuffer(b, mv('down')); }],
      ['wordLeft', () => { b = reduceBuffer(b, mv('wordLeft')); }],
    ];
    for (const [name, fn] of cases) {
      const med = medianMs(fn, 7);
      const best = bestMs(fn, 7);
      process.stdout.write(`[measured] reduceBuffer ${name} on ${text.length} chars: best ${best.toFixed(3)} ms, median ${med.toFixed(3)} ms\n`);
      expect(best, name).toBeLessThan(3);
    }
  });
});

describe('unicode edge cases across the reducer', () => {
  it('flags, ZWJ families, Hangul jamo and Devanagari conjuncts move and delete as single units', () => {
    const t = '🇺🇸👨\u200d👩\u200d👧\u200d👦각क्षि';
    let b = createBuffer({ text: t, cursor: 0 });
    const steps: number[] = [];
    for (let i = 0; i < 4; i++) {
      b = reduceBuffer(b, mv('right'));
      steps.push(b.cursor);
    }
    expect(steps).toEqual([...boundarySet(t)].sort((x, y) => x - y).slice(1));
    b = reduceBuffer(b, { type: 'backspace' });
    expect(b.text).toBe('🇺🇸👨\u200d👩\u200d👧\u200d👦각');
    b = reduceBuffer(b, mv('start'));
    b = reduceBuffer(b, { type: 'delete' });
    expect(b.text).toBe('👨\u200d👩\u200d👧\u200d👦각');
  });
  it('an all-emoji 2,000-cluster draft is handled without breaking boundaries', () => {
    const t = '👍🏽'.repeat(2000);
    let b = createBuffer({ text: t, cursor: t.length });
    for (let i = 0; i < 50; i++) b = reduceBuffer(b, { type: 'backspace' });
    expect(b.text.length).toBe(t.length - 50 * '👍🏽'.length);
    for (let i = 0; i < 20; i++) b = reduceBuffer(b, mv('left'));
    expect(boundarySet(b.text).has(b.cursor)).toBe(true);
  });
});
