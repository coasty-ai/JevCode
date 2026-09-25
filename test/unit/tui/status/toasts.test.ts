/**
 * TUI-DESIGN §19.0 (`toasts.test.ts`): queue ≤ 4, error pre-emption, 2 s / 4 s — each toast visible for its full
 * duration in sequence — plus the §19.2 property test over random action sequences.
 */
import { describe, expect, it } from 'vitest';

import { TOAST_ERROR_MS, TOAST_FADE_MS, TOAST_INFO_MS, TOAST_MAX, TOAST_TEXT_MAX, activeToast, asciiFold, nextToastExpiry, oneLineSafe, toastDurationMs, toastPhase, toastReducer, toastRole, toastText } from '../../../../src/tui/toasts.js';
import type { Toast, ToastAction } from '../../../../src/tui/toasts.js';
import { mulberry32, pick } from '../composer/helpers.js';

function push(q: readonly Toast[], text: string, level: Toast['level'] = 'info', now = 0, ms?: number): readonly Toast[] {
  return toastReducer(q, { type: 'toast', text, level, ...(ms !== undefined ? { ms } : {}) }, now);
}
const texts = (q: readonly Toast[]): string[] => q.map((t) => t.text);
const untils = (q: readonly Toast[]): number[] => q.map((t) => t.untilMs);

/** Sample the visible toast every `stepMs` from `from` to `to` (a tick before each sample): visible samples per text. */
function visibleFor(q0: readonly Toast[], from: number, to: number, stepMs = 100): Map<string, number> {
  const seen = new Map<string, number>();
  let q = q0;
  for (let t = from; t < to; t += stepMs) {
    q = toastReducer(q, { type: 'tick' }, t);
    const a = activeToast(q, t);
    if (a !== null) seen.set(a.text, (seen.get(a.text) ?? 0) + 1);
  }
  return seen;
}

const LONE_SURROGATE = /\p{Surrogate}/u;

describe('toastReducer (§7.5): durations, sequencing, pre-emption', () => {
  it('appends with the 2 s / 4 s durations chained after the toasts it displays behind, ids strictly increasing', () => {
    let q = push([], 'press Ctrl-C again to exit', 'info', 1000);
    expect(q.length).toBe(1);
    expect(q[0]).toMatchObject({ text: 'press Ctrl-C again to exit', level: 'info', untilMs: 1000 + TOAST_INFO_MS });
    q = push(q, 'jev back', 'ok', 1000);
    expect(q[1]!.untilMs).toBe(1000 + 2 * TOAST_INFO_MS);
    q = push(q, 'custom', 'info', 1000, 7000);
    expect(q[2]!.untilMs).toBe(1000 + 2 * TOAST_INFO_MS + 7000);
    expect(q[1]!.id).toBeGreaterThan(q[0]!.id);
    expect(q[2]!.id).toBeGreaterThan(q[1]!.id);
    expect(toastDurationMs('info')).toBe(2000);
    expect(toastDurationMs('ok')).toBe(2000);
    expect(toastDurationMs('error')).toBe(4000);
  });
  it('N toasts pushed in one tick are each visible for their full 2 s / 4 s, in order', () => {
    let q: readonly Toast[] = [];
    for (const t of ['a', 'b', 'c']) q = push(q, t, 'info', 0);
    expect(untils(q)).toEqual([2000, 4000, 6000]);
    const seen = visibleFor(q, 0, 8000);
    expect(seen.get('a')).toBe(20);
    expect(seen.get('b')).toBe(20);
    expect(seen.get('c')).toBe(20);
    // order: a first, then b, then c
    const at = (ms: number): string | undefined => activeToast(q, ms)?.text;
    expect([at(0), at(1999), at(2000), at(3999), at(4000), at(5999), at(6000)]).toEqual(['a', 'a', 'b', 'b', 'c', 'c', undefined]);
    let errs: readonly Toast[] = [];
    for (const t of ['e1', 'e2']) errs = push(errs, t, 'error', 500);
    expect(untils(errs)).toEqual([4500, 8500]);
    const seenErr = visibleFor(errs, 500, 9000);
    expect(seenErr.get('e1')).toBe(40);
    expect(seenErr.get('e2')).toBe(40);
  });
  it('an error pre-empts the visible info toast, which resumes afterwards for its remaining time', () => {
    const q0 = push([], 'a', 'info', 0);
    const before = visibleFor(q0, 0, 500);
    expect(before.get('a')).toBe(5);
    const q = push(q0, 'e', 'error', 500);
    expect(texts(q)).toEqual(['a', 'e']);
    expect(untils(q)).toEqual([6000, 4500]);
    const at = (ms: number): string | undefined => activeToast(q, ms)?.text;
    expect([at(500), at(4499), at(4500), at(5999), at(6000)]).toEqual(['e', 'e', 'a', 'a', undefined]);
    const after = visibleFor(q, 500, 7000);
    expect(after.get('e')).toBe(40);
    expect(after.get('a')).toBe(15); // 5 samples before the error + 15 after = its full 2 s
    expect(nextToastExpiry(q, 500)).toBe(4500);
    expect(nextToastExpiry(q, 4500)).toBe(6000);
    // a queued info behind an active info is shifted too
    const q1 = push(push([], 'a', 'info', 0), 'b', 'info', 0);
    expect(visibleFor(q1, 0, 1000).get('a')).toBe(10);
    const q2 = push(q1, 'e', 'error', 1000);
    expect(untils(q2)).toEqual([6000, 8000, 5000]);
    const seen2 = visibleFor(q2, 1000, 9000);
    expect(seen2.get('e')).toBe(40);
    expect(seen2.get('a')).toBe(10);
    expect(seen2.get('b')).toBe(20);
  });
  it('holds at most four; an info toast evicts the oldest info toast and its successors move forward', () => {
    let q: readonly Toast[] = [];
    for (let i = 1; i <= 4; i++) q = push(q, `t${i}`, 'info', 0);
    expect(untils(q)).toEqual([2000, 4000, 6000, 8000]);
    q = push(q, 't5', 'info', 0);
    expect(q.length).toBe(TOAST_MAX);
    expect(texts(q)).toEqual(['t2', 't3', 't4', 't5']);
    expect(untils(q)).toEqual([2000, 4000, 6000, 8000]);
    expect(new Set(q.map((t) => t.id)).size).toBe(4);
    const seen = visibleFor(q, 0, 9000);
    for (const t of ['t2', 't3', 't4', 't5']) expect(seen.get(t), t).toBe(20);
  });
  it('an error toast pre-empts an info toast; errors are never displaced by info', () => {
    let q: readonly Toast[] = [];
    for (let i = 1; i <= 4; i++) q = push(q, `info${i}`);
    q = push(q, 'boom', 'error');
    expect(texts(q)).toEqual(['info2', 'info3', 'info4', 'boom']);
    let errs: readonly Toast[] = [];
    for (let i = 1; i <= 4; i++) errs = push(errs, `err${i}`, 'error');
    const stillErrs = push(errs, 'late info');
    expect(stillErrs).toBe(errs);
    expect(texts(stillErrs)).toEqual(['err1', 'err2', 'err3', 'err4']);
    const fifthErr = push(errs, 'err5', 'error');
    expect(texts(fifthErr)).toEqual(['err2', 'err3', 'err4', 'err5']);
    expect(untils(fifthErr)).toEqual([4000, 8000, 12000, 16000]);
    // mixed: the oldest non-error goes first even when an error is older
    let mixed = push([], 'e1', 'error');
    mixed = push(mixed, 'i1');
    mixed = push(mixed, 'e2', 'error');
    mixed = push(mixed, 'i2');
    mixed = push(mixed, 'e3', 'error');
    expect(texts(mixed)).toEqual(['e1', 'e2', 'i2', 'e3']);
    const seen = visibleFor(mixed, 0, 16000);
    expect(seen.get('e1')).toBe(40);
    expect(seen.get('e2')).toBe(40);
    expect(seen.get('e3')).toBe(40);
    expect(seen.get('i2')).toBe(20);
  });
  it('a repeated text+level refreshes the visible toast (successors shift); a queued repeat is a no-op', () => {
    let q = push([], 'press Ctrl-C again to exit', 'info', 0);
    const id = q[0]!.id;
    q = push(q, 'later', 'info', 0);
    expect(untils(q)).toEqual([2000, 4000]);
    q = push(q, 'press Ctrl-C again to exit', 'info', 1500);
    expect(q.length).toBe(2);
    expect(q[0]!.id).toBe(id);
    expect(untils(q)).toEqual([3500, 5500]);
    const same = push(q, 'later', 'info', 1600);
    expect(same).toBe(q);
    // same text, different level = a different toast
    q = push(q, 'press Ctrl-C again to exit', 'error', 1500);
    expect(q.length).toBe(3);
    // a refresh that does not extend is a no-op
    const early = push([], 'x', 'info', 0, 5000);
    expect(push(early, 'x', 'info', 100)).toBe(early);
  });
  it('tick drops expired toasts and returns the same array when nothing changed', () => {
    const q = push(push([], 'a', 'info', 0), 'b', 'error', 0);
    expect(toastReducer(q, { type: 'tick' }, 3999)).toBe(q);
    expect(texts(toastReducer(q, { type: 'tick' }, 4000))).toEqual(['a']);
    expect(toastReducer(q, { type: 'tick' }, 6000)).toEqual([]);
    const empty: Toast[] = [];
    expect(toastReducer(empty, { type: 'tick' }, 5)).toBe(empty);
  });
  it('dismiss pulls the successors forward by the dismissed toast\'s remaining time; clear empties', () => {
    let q = push(push(push([], 'a'), 'b'), 'c');
    expect(untils(q)).toEqual([2000, 4000, 6000]);
    // the active toast at 500: b and c start 1500 ms earlier
    const noA = toastReducer(q, { type: 'dismiss', id: q[0]!.id }, 500);
    expect(texts(noA)).toEqual(['b', 'c']);
    expect(untils(noA)).toEqual([2500, 4500]);
    // a queued toast: its whole 2 s is handed to its successors
    const noB = toastReducer(q, { type: 'dismiss', id: q[1]!.id }, 500);
    expect(untils(noB)).toEqual([2000, 4000]);
    expect(toastReducer(q, { type: 'dismiss', id: -99 }, 0)).toBe(q);
    expect(toastReducer(q, { type: 'clear' }, 0)).toEqual([]);
    const empty: Toast[] = [];
    expect(toastReducer(empty, { type: 'clear' }, 0)).toBe(empty);
    // dismissing an active error hands its remaining time to the pre-empted info
    q = push(push([], 'a', 'info', 0), 'e', 'error', 500);
    const noE = toastReducer(q, { type: 'dismiss', id: q[1]!.id }, 1000);
    expect(untils(noE)).toEqual([2500]);
    expect(visibleFor(noE, 1000, 4000).get('a')).toBe(15);
  });
  it('ids are never reused: after dismiss, clear or a tick that dropped the highest id', () => {
    let q = push(push([], 'a'), 'b');
    const top = Math.max(...q.map((t) => t.id));
    q = toastReducer(q, { type: 'dismiss', id: top }, 0);
    q = push(q, 'c');
    expect(q[q.length - 1]!.id).toBeGreaterThan(top);
    const top2 = Math.max(...q.map((t) => t.id));
    q = toastReducer(q, { type: 'clear' }, 0);
    q = push(q, 'd');
    expect(q[0]!.id).toBeGreaterThan(top2);
    const top3 = q[0]!.id;
    q = toastReducer(q, { type: 'tick' }, 10_000);
    expect(q).toEqual([]);
    q = push(q, 'e', 'info', 10_000);
    expect(q[0]!.id).toBeGreaterThan(top3);
    // a caller-built array with a large id is respected
    const foreign: Toast[] = [{ id: 1_000_000, text: 'x', level: 'info', untilMs: 99_999 }];
    expect(push(foreign, 'y', 'info', 0)[1]!.id).toBeGreaterThan(1_000_000);
  });
  it('sanitises text: one line, no control bytes, no bidi/format characters, grapheme-safe bound; empty text is ignored', () => {
    const q = push([], '  line1\nline2\u001b[2J\ttab  ');
    expect(q[0]!.text).toBe('line1 ⏎ line2 tab');
    expect(push([], 'a\u202eb\u200bc\u2066d\u2069')[0]!.text).toBe('abcd');
    expect(push([], 'x\u2028y')[0]!.text).toBe('x ⏎ y');
    expect(push([], '👨\u200d👩\u200d👧 team')[0]!.text).toBe('👨\u200d👩\u200d👧 team');
    const empty: Toast[] = [];
    expect(push(empty, '   ')).toBe(empty);
    expect(push(empty, '\u0007\u001b')).toBe(empty);
    expect(push(empty, '\u202e\u200b')).toBe(empty);
    const huge = push([], 'x'.repeat(100_000));
    expect(huge[0]!.text.length).toBe(TOAST_TEXT_MAX);
    const split = push([], 'x'.repeat(TOAST_TEXT_MAX - 1) + '😀')[0]!.text;
    expect(split.length).toBe(TOAST_TEXT_MAX - 1);
    expect(LONE_SURROGATE.test(split)).toBe(false);
    const family = push([], 'x'.repeat(TOAST_TEXT_MAX - 3) + '👨\u200d👩\u200d👧')[0]!.text;
    expect(family).toBe('x'.repeat(TOAST_TEXT_MAX - 3));
    const emoji = push([], '😀'.repeat(300))[0]!.text;
    expect(emoji.length).toBe(TOAST_TEXT_MAX);
    expect(LONE_SURROGATE.test(emoji)).toBe(false);
    expect(push([], 42 as unknown as string)[0]!.text).toBe('42');
  });
  it('non-finite clocks and durations fall back safely', () => {
    const q = push([], 'a', 'info', Number.NaN);
    expect(q[0]!.untilMs).toBe(TOAST_INFO_MS);
    expect(push([], 'a', 'info', Number.NEGATIVE_INFINITY)[0]!.untilMs).toBe(TOAST_INFO_MS);
    expect(push([], 'a', 'info', 0, Number.NaN)[0]!.untilMs).toBe(TOAST_INFO_MS);
    expect(push([], 'a', 'error', 0, -5)[0]!.untilMs).toBe(TOAST_ERROR_MS);
    expect(push([], 'a', 'info', 0, Number.POSITIVE_INFINITY)[0]!.untilMs).toBe(TOAST_INFO_MS);
    expect(push([], 'a', 'weird' as Toast['level'], 0)[0]!.level).toBe('info');
    expect(toastReducer(q, { type: 'tick' }, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(activeToast(q, Number.POSITIVE_INFINITY)).toBeNull();
  });
  it('never mutates its input (frozen arrays and toasts)', () => {
    const frozen = Object.freeze([Object.freeze({ id: 1, text: 'a', level: 'info' as const, untilMs: 2000 }), Object.freeze({ id: 2, text: 'b', level: 'info' as const, untilMs: 4000 })]);
    const before = JSON.stringify(frozen);
    push(frozen, 'e', 'error', 100);
    push(frozen, 'a', 'info', 1500);
    toastReducer(frozen, { type: 'dismiss', id: 1 }, 100);
    toastReducer(frozen, { type: 'tick' }, 3000);
    toastReducer(frozen, { type: 'clear' }, 0);
    expect(JSON.stringify(frozen)).toBe(before);
  });
});

describe('§19.2 property: random action sequences', () => {
  const POOL = ['a', 'b', 'c', 'd', 'e', 'saved — applies', 'x\ny', '中文', '😀🚀', '\u202e rtl', 'jev back'];
  const LEVELS: Toast['level'][] = ['info', 'ok', 'error', 'info'];
  it.each([1, 2, 3, 4, 5])('seed %d: length ≤ 4, errors never evicted by info/ok, ids unique and monotonic, no lone surrogates, inputs untouched', (seed) => {
    const r = mulberry32(seed * 7919);
    let q: readonly Toast[] = [];
    let now = 0;
    let lastId = 0;
    for (let i = 0; i < 1500; i++) {
      const kind = r();
      let action: ToastAction;
      if (kind < 0.55) action = { type: 'toast', text: pick(r, POOL), level: pick(r, LEVELS), ...(r() < 0.2 ? { ms: Math.floor(r() * 5000) } : {}) };
      else if (kind < 0.85) {
        now += Math.floor(r() * 1500);
        action = { type: 'tick' };
      } else if (kind < 0.97) action = { type: 'dismiss', id: q.length > 0 ? pick(r, q).id : 1 };
      else action = { type: 'clear' };
      const frozen = Object.freeze(q.map((t) => Object.freeze({ ...t })));
      const before = JSON.stringify(frozen);
      const errorsBefore = new Set(frozen.filter((t) => t.level === 'error' && t.untilMs > now).map((t) => t.id));
      const next = toastReducer(frozen, action, now);
      expect(JSON.stringify(frozen)).toBe(before);
      expect(next.length).toBeLessThanOrEqual(TOAST_MAX);
      const ids = next.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const t of next) {
        expect(LONE_SURROGATE.test(t.text)).toBe(false);
        expect(t.text.length).toBeLessThanOrEqual(TOAST_TEXT_MAX);
        expect(t.text).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/);
        expect(Number.isFinite(t.untilMs)).toBe(true);
        expect(t.untilMs).toBeGreaterThan(now);
      }
      if (action.type === 'toast' && action.level !== 'error') for (const id of errorsBefore) expect(ids).toContain(id);
      if (action.type === 'toast') {
        const fresh = next.filter((t) => !frozen.some((f) => f.id === t.id));
        expect(fresh.length).toBeLessThanOrEqual(1);
        for (const f of fresh) {
          expect(f.id).toBeGreaterThan(lastId);
          lastId = f.id;
        }
      }
      // display order deadlines are non-decreasing: errors in queue order, then the rest
      const order = [...next.filter((t) => t.level === 'error'), ...next.filter((t) => t.level !== 'error')];
      for (let k = 1; k < order.length; k++) expect(order[k]!.untilMs).toBeGreaterThanOrEqual(order[k - 1]!.untilMs);
      q = next;
    }
  });
});

describe('activeToast, toastText, nextToastExpiry, text helpers', () => {
  it('the oldest unexpired error pre-empts older info toasts', () => {
    const q: Toast[] = [
      { id: 1, text: 'i1', level: 'info', untilMs: 2000 },
      { id: 2, text: 'e1', level: 'error', untilMs: 4000 },
      { id: 3, text: 'i2', level: 'ok', untilMs: 2000 },
      { id: 4, text: 'e2', level: 'error', untilMs: 4000 },
    ];
    expect(activeToast(q, 0)?.text).toBe('e1');
    expect(activeToast(q, 4000)).toBeNull();
    expect(activeToast(q.filter((t) => t.level !== 'error'), 0)?.text).toBe('i1');
    expect(activeToast(q.filter((t) => t.level !== 'error'), 2000)).toBeNull();
    expect(activeToast([], 0)).toBeNull();
    expect(activeToast(q, Number.NaN)?.text).toBe('e1');
    expect(nextToastExpiry(q, 0)).toBe(2000);
    expect(nextToastExpiry(q, 2000)).toBe(4000);
    expect(nextToastExpiry(q, 4000)).toBeNull();
    expect(nextToastExpiry([], 0)).toBeNull();
  });
  it('renders ! and ✓ (+ under --ascii) and folds the text to the §14.1 glyph table under --ascii', () => {
    expect(toastText({ text: 'E401: key rejected', level: 'error' })).toBe('! E401: key rejected');
    expect(toastText({ text: 'press Ctrl-C again to exit', level: 'info' })).toBe('! press Ctrl-C again to exit');
    expect(toastText({ text: 'jev back', level: 'ok' })).toBe('✓ jev back');
    expect(toastText({ text: 'jev back', level: 'ok' }, true)).toBe('+ jev back');
    expect(toastText({ text: 'x', level: 'error' }, true)).toBe('! x');
    expect(toastText({ text: 'line1 ⏎ line2', level: 'info' }, true)).toBe('! line1 | line2');
    expect(toastText({ text: 'saved — applies to the next run (this run keeps its key)', level: 'info' }, true)).toBe('! saved - applies to the next run (this run keeps its key)');
    const glossary = ['press Ctrl-C again to exit', 'run is live — Ctrl-D again to choose', 'Esc again clears the draft', 'jev back', 'network back', 'checkpoint restored', 'steer queue full (8)', 'paste of 2.3 MiB refused (limit 1 MiB); write it to a file and @-mention it', 'saved — applies to the next run (this run keeps its key)', 'calibration: scanning 12 runs…', 'copied with 2 secret(s) masked', 'review pending: y n d e w · Esc declines'];
    for (const text of glossary) expect(toastText({ text, level: 'ok' }, true), text).toMatch(/^[\x20-\x7e]*$/);
  });
  it('oneLineSafe and asciiFold', () => {
    expect(oneLineSafe('a\u202eb\u200bc\u200e\u200f')).toBe('abc');
    expect(oneLineSafe('a\r\nb\tc  d')).toBe('a ⏎ b c d');
    expect(oneLineSafe('👨\u200d👩\u200d👧')).toBe('👨\u200d👩\u200d👧');
    // ECMA-48: `ESC x` is one (Fs) sequence, so the byte after a lone ESC goes with it (core/ansi.ts)
    expect(oneLineSafe('\u0000\u009f\u001bx')).toBe('');
    expect(oneLineSafe('\u0000\u009fx\u001b[31m!')).toBe('x!');
    expect(asciiFold('plain')).toBe('plain');
    expect(asciiFold('→ ≥ ≤ × ⚠ Σ … † • · ─ │ ↑ ↓ ✓ ✗ ⎇ ▂▃ ▍ ⏎')).toBe('-> >= <= x ! sum ... + * - - | ^ v + x br 23 3 |');
    expect(asciiFold('中文 stays')).toBe('中文 stays');
  });
});

describe('toastPhase / toastRole (TUI-DESIGN-3 §5.2 A7: the last-second dim, the level colours)', () => {
  it('`fading` ⇔ untilMs − nowMs ≤ 1000; `visible` before that; a non-finite clock reads as 0', () => {
    expect(TOAST_FADE_MS).toBe(1000);
    const t = { untilMs: 5000 };
    expect(toastPhase(t, 0)).toBe('visible');
    expect(toastPhase(t, 3999)).toBe('visible');
    expect(toastPhase(t, 4000)).toBe('fading');
    expect(toastPhase(t, 4999)).toBe('fading');
    expect(toastPhase(t, 5000)).toBe('fading');
    expect(toastPhase(t, Number.NaN)).toBe('visible');
    expect(toastPhase({ untilMs: 900 }, Number.NaN)).toBe('fading');
    // an info toast is dim for exactly its last second, an error toast for the last of its four
    let q = push([], 'x', 'info', 1000);
    expect(toastPhase(q[0]!, 1000 + TOAST_INFO_MS - 1001)).toBe('visible');
    expect(toastPhase(q[0]!, 1000 + TOAST_INFO_MS - 1000)).toBe('fading');
    q = push([], 'y', 'error', 0);
    expect(toastPhase(q[0]!, TOAST_ERROR_MS - 1001)).toBe('visible');
    expect(toastPhase(q[0]!, TOAST_ERROR_MS - 1000)).toBe('fading');
  });
  it('roles: `!` info → accent, `✓` ok → ok, `!` error → error', () => {
    expect(toastRole('info')).toBe('accent');
    expect(toastRole('ok')).toBe('ok');
    expect(toastRole('error')).toBe('error');
    expect(toastText({ text: 'a', level: 'info' })).toBe('! a');
    expect(toastText({ text: 'a', level: 'error' })).toBe('! a');
    expect(toastText({ text: 'a', level: 'ok' })).toBe('✓ a');
  });
});

/**
 * TUI-DESIGN-5 §2.9 / §12 S31–S34, S6: which surface each cross-session verb takes, and the bodies themselves.
 * The rules are data (`MESSAGE_SURFACES`) so the App and `src/cli/sessions.ts` cannot re-derive them differently —
 * a `request` that arrived as a toast would expire before it was answered, which is the defect §2.9 forbids.
 */
describe('cross-session message surfaces (TUI-DESIGN-5 §2.9)', () => {
  it('headsup toasts, tell toasts and counts, request is a persistent row and never a toast', async () => {
    const { MESSAGE_SURFACES, messageSurface } = await import('../../../../src/tui/toasts.js');
    expect(messageSurface('headsup')).toEqual({ toast: true, persistentRow: false, mailCount: false, transcriptItem: true });
    expect(messageSurface('tell')).toEqual({ toast: true, persistentRow: false, mailCount: true, transcriptItem: true });
    expect(messageSurface('request')).toEqual({ toast: false, persistentRow: true, mailCount: false, transcriptItem: true });
    // "a toast is never the only record": every applied remote verb writes a `[session]` transcript item (§13.1)
    for (const v of ['tell', 'headsup', 'request'] as const) expect(MESSAGE_SURFACES[v].transcriptItem, v).toBe(true);
    // the one that needs an answer is the one that persists, and it is the only one
    expect(Object.entries(MESSAGE_SURFACES).filter(([, s]) => s.persistentRow).map(([k]) => k)).toEqual(['request']);
  });

  it('§12 S31–S34: the four bodies verbatim, one line, with the `(unverified)` suffix an unpaired sender earns', async () => {
    const { UNVERIFIED_SUFFIX, headsUpText, requestRowText, sessionMessageText, waitingForText } = await import('../../../../src/tui/toasts.js');
    expect(sessionMessageText('mbp', 'committed 3f9a2c1 on main — engine.ts, store.ts')).toBe('mbp: committed 3f9a2c1 on main — engine.ts, store.ts');
    // §12 S32 verbatim (pause) and its two new siblings, filed for §12.1 as S32a / S32b in the W5 docs PR
    expect(requestRowText('mbp', 'pause')).toBe('mbp asks to pause this run — [y] pause at step end  [Y] pause now  [n] ignore');
    // §2.7 makes `/end` a SESSION verb, so the row names the session — never "this run", which `/end` does not act on
    expect(requestRowText('mbp', 'end')).toBe('mbp asks to end this session — [y] end at step end  [Y] end now  [n] ignore');
    expect(requestRowText('mbp', 'steer')).toBe('mbp asks to take a steer — [y] take it  [n] ignore');
    expect(requestRowText('mbp', 'end')).not.toContain('this run');
    // the three rows are an anchor table, so nothing else may spell one of them (§13.4)
    const { REQUEST_ROW_ANCHORS } = await import('../../../../src/tui/toasts.js');
    for (const verb of ['pause', 'end', 'steer'] as const) {
      expect(requestRowText('mbp', verb), verb).toBe(REQUEST_ROW_ANCHORS[verb].replace('<from>', 'mbp'));
    }
    // every row offers `[n] ignore`, and the two that can act at once offer the same `[y]`/`[Y]` pair the local ladder does
    for (const verb of ['pause', 'end', 'steer'] as const) expect(requestRowText('mbp', verb), verb).toContain('[n] ignore');
    for (const verb of ['pause', 'end'] as const) expect(requestRowText('mbp', verb), verb).toContain('[Y] ');
    expect(headsUpText(['src/loop/engine.ts', 'src/loop/stop.ts'], 'make the pause exact')).toBe('heads-up: editing src/loop/engine.ts (+1) for: make the pause exact');
    expect(headsUpText(['src/loop/engine.ts'], 'make the pause exact')).toBe('heads-up: editing src/loop/engine.ts for: make the pause exact');
    expect(headsUpText([], '')).toBe('heads-up');
    expect(waitingForText('mbp', 'src/x.ts')).toBe('mbp is waiting for src/x.ts — commit and move on when you can');
    // §7 row 18: an unpaired sender's message is RENDERED, flagged, and never auto-applied
    expect(UNVERIFIED_SUFFIX).toBe(' (unverified)');
    expect(sessionMessageText('mbp', 'hello', false)).toBe('mbp: hello (unverified)');
    expect(requestRowText('mbp', 'end', false).endsWith(UNVERIFIED_SUFFIX)).toBe(true);
    // hostile sender text is one line and carries no control bytes (§14.1)
    expect(sessionMessageText('m\nbp', 'a\u001b[2Jb')).toBe('m ⏎ bp: ab');
  });

  it('§2.2 / §12 S6: the peer zone announces once on a 0 → ≥ 1 crossing and never again', async () => {
    const { unreadAnnounce } = await import('../../../../src/tui/toasts.js');
    expect(unreadAnnounce(0, 1, 'mbp')).toBe('1 message from mbp — /inbox reads it');
    expect(unreadAnnounce(0, 3, 'mbp')).toBe('3 messages from mbp — /inbox reads it');
    // not a crossing: already non-zero, or still zero
    expect(unreadAnnounce(1, 2, 'mbp')).toBeNull();
    expect(unreadAnnounce(2, 1, 'mbp')).toBeNull();
    expect(unreadAnnounce(0, 0, 'mbp')).toBeNull();
    expect(unreadAnnounce(3, 0, 'mbp')).toBeNull();
  });
});
