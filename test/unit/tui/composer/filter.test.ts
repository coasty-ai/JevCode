/**
 * TUI-DESIGN §4.4, §19.0–19.1 (`filter.test.ts`): the A105 leak-through vectors (focus, CPR, kitty/DA1 replies, xterm
 * modifyOtherKeys, SGR mouse, OSC 11 in both bit depths, OSC fragments), modifier/release/repeat drops, C0/DEL/C1 and bidi
 * stripping, tab expansion, CRLF pastes, IME commits inserted whole.
 */
import { describe, expect, it } from 'vitest';
import { CSI_LEAK_RE, OSC_ANSWER_MAX_BODY, OSC_ANSWER_MIN_CHARS, OSC_ANSWER_RE, OSC_LEAK_RE, TAB_SPACES, expandTabs, filterInput, isOscAnswerBody, normaliseChunk } from '../../../../src/tui/composer/filter.js';
import { CONTROL_OR_BIDI_RE } from './helpers.js';

const text = (s: string) => ({ ok: true as const, text: s });
const drop = (reason: 'modifier' | 'release' | 'repeat' | 'csi' | 'osc' | 'empty') => ({ ok: false as const, reason });

describe('filterInput: leak-through bodies (A105, 07 §1.2, 08 §2.3)', () => {
  it.each([
    ['focus in', '[I'],
    ['focus out', '[O'],
    ['cursor position report', '[24;80R'],
    ['xterm modifyOtherKeys Shift+Enter', '[27;2;13~'],
    ['kitty keyboard reply', '[?0u'],
    ['kitty flags reply', '[?1u'],
    ['DA1', '[?62;22c'],
    ['DA1 long', '[?62;1;2;6;9;15;22c'],
    ['DA1 short', '[?62c'],
    ['DA1 vt100', '[?6c'],
    ['SGR mouse press', '[<64;10;5M'],
    ['SGR mouse release', '[<0;10;5m'],
    ['kitty CSI-u Shift+Enter (protocol half negotiated)', '[13;2u'],
    ['kitty CSI-u Shift+Tab', '[9;2u'],
    ['kitty CSI-u with alternate key and event type', '[57414;1:3u'],
    ['kitty CSI-u plain', '[97u'],
    ['modified arrow Ctrl+Up', '[1;5A'],
    ['modified arrow Shift+Left', '[1;2D'],
    ['edit key Delete', '[3~'],
    ['edit key Shift+F5', '[15;2~'],
  ])('drops %s (%s)', (_name, body) => {
    expect(filterInput(body)).toEqual(drop('csi'));
    expect(filterInput('\u001b' + body)).toEqual(drop('csi'));
    expect(CSI_LEAK_RE.test(body)).toBe(true);
  });

  it('pins the split-CSI deliveries (A105; C21 forbids the timer that would join them)', () => {
    // half 1: the bare introducer is never text → dropped
    expect(filterInput('\u001b[')).toEqual(drop('csi'));
    // half 2: the ESC-less tail is indistinguishable from typed text → inserted (documented in filter.ts)
    expect(filterInput('24;80R')).toEqual(text('24;80R'));
    // a typed '[' (no ESC) is text
    expect(filterInput('[')).toEqual(text('['));
  });

  it('drops a chunk made only of ESC-concatenated leak bodies and keeps one that carries text', () => {
    expect(filterInput('\u001b[I\u001b[O')).toEqual(drop('csi'));
    expect(filterInput('[I\u001b[O')).toEqual(drop('csi'));
    expect(filterInput('\u001b[?0u\u001b[?62;22c')).toEqual(drop('csi'));
    expect(filterInput('\u001b]11;rgb:1e1e/1e1e/1e1e\u001b\\')).toEqual(drop('osc'));
    expect(filterInput('\u001b[Ihello')).toEqual(text('[Ihello'));
    expect(filterInput('a\u001b[I')).toEqual(text('a[I'));
  });

  it('drops OSC 11 replies in both bit depths, other OSC fragments and the ST tail', () => {
    expect(filterInput(']11;rgb:1e1e/1e1e/1e1e')).toEqual(drop('osc'));
    expect(filterInput(']11;rgb:1e/1e/1e')).toEqual(drop('osc'));
    expect(filterInput(']11;rgb:1e1e/1e1e/1e1e\u0007')).toEqual(drop('osc'));
    expect(filterInput(']10;rgb:ffff/ffff/ffff')).toEqual(drop('osc'));
    expect(filterInput(']52;c;aGVsbG8=')).toEqual(drop('osc'));
    expect(filterInput('\\')).toEqual(drop('osc'));
    expect(filterInput('\u001b\\')).toEqual(drop('osc'));
    expect(OSC_LEAK_RE.test(']11;')).toBe(true);
  });

  it('keeps text that merely resembles a CSI body when it carries a printable prefix', () => {
    expect(filterInput('a[I')).toEqual(text('a[I'));
    expect(filterInput('[Ia')).toEqual(text('[Ia'));
    expect(filterInput('[')).toEqual(text('['));
    expect(filterInput(']')).toEqual(text(']'));
    expect(filterInput('[1]')).toEqual(text('[1]'));
    expect(filterInput('[Pasted #1, 3 lines]')).toEqual(text('[Pasted #1, 3 lines]'));
    expect(filterInput('[1;5]')).toEqual(text('[1;5]'));
    expect(filterInput('[A')).toEqual(text('[A')); // a plain arrow body needs its ESC to be a key; without one it is prose
    expect(filterInput('[u')).toEqual(text('[u'));
    expect(filterInput('[13;2ux')).toEqual(text('[13;2ux'));
  });
});

describe('filterInput: modifiers and event types', () => {
  it('drops any ctrl/meta/super/hyper chunk (bindings were resolved first) and release/repeat events', () => {
    expect(filterInput('c', { ctrl: true })).toEqual(drop('modifier'));
    expect(filterInput('b', { meta: true })).toEqual(drop('modifier'));
    expect(filterInput('k', { super: true })).toEqual(drop('modifier'));
    expect(filterInput('k', { hyper: true })).toEqual(drop('modifier'));
    expect(filterInput('x', { eventType: 'release' })).toEqual(drop('release'));
    expect(filterInput('x', { eventType: 'repeat' })).toEqual(drop('repeat'));
    expect(filterInput('x', { eventType: 'press' })).toEqual(text('x'));
    expect(filterInput('x', { ctrl: false, meta: false })).toEqual(text('x'));
    // ESC + x arrives as meta+x whatever the gap (5 ms or 25 ms): the flag, not timing, decides (C21: no timers)
    expect(filterInput('x', { meta: true })).toEqual(drop('modifier'));
  });
});

describe('filterInput: control bytes, tabs, newlines, bidi', () => {
  it('drops C0 (except tab/newline), DEL and C1; keeps nothing when only controls arrive', () => {
    expect(filterInput('\u001a')).toEqual(drop('empty')); // Ctrl+Z byte delivered as text
    expect(filterInput('\u0000')).toEqual(drop('empty'));
    expect(filterInput('\u001f')).toEqual(drop('empty')); // Ctrl+/ arrives as raw 0x1f text
    expect(filterInput('\u007f')).toEqual(drop('empty'));
    expect(filterInput('\u0085\u009b')).toEqual(drop('empty'));
    expect(filterInput('')).toEqual(drop('empty'));
    expect(filterInput('a\u0007b')).toEqual(text('ab'));
    expect(filterInput('\u001b[31mred')).toEqual(text('[31mred')); // ESC dropped: a stray SGR cannot colour the buffer
  });
  it('expands tabs to spaces and normalises CRLF / CR / U+2028 / U+2029 to newlines', () => {
    expect(filterInput('\t')).toEqual(text(' '.repeat(TAB_SPACES)));
    expect(filterInput('a\tb')).toEqual(text('a    b'));
    expect(filterInput('x\r\ny\rz\nw')).toEqual(text('x\ny\nz\nw'));
    expect(filterInput('\r')).toEqual(text('\n'));
    expect(filterInput('\n')).toEqual(text('\n'));
    expect(filterInput('a\u2028b\u2029c')).toEqual(text('a\nb\nc'));
    expect(TAB_SPACES).toBe(4);
  });
  it('strips bidi controls and lone surrogates, keeps real pairs and combining marks', () => {
    expect(filterInput('\u202eevil\u202c')).toEqual(text('evil'));
    expect(filterInput('\u2066a\u2069')).toEqual(text('a'));
    expect(filterInput('\ud83d')).toEqual(drop('empty'));
    expect(filterInput('\udc00x')).toEqual(text('x'));
    expect(filterInput('👍')).toEqual(text('👍'));
    expect(filterInput('e\u0301')).toEqual(text('e\u0301'));
  });
  it('inserts a multi-code-point chunk without ESC whole (IME commit / paste-like burst)', () => {
    expect(filterInput('日本語')).toEqual(text('日本語'));
    expect(filterInput('ab')).toEqual(text('ab'));
    expect(filterInput('한글 입력')).toEqual(text('한글 입력'));
    const big = 'line\r\n'.repeat(10000); // ~64 KB paste-like chunk through useInput
    const r = filterInput(big);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe('line\n'.repeat(10000));
      expect(CONTROL_OR_BIDI_RE.test(r.text.replace(/\n/g, ''))).toBe(false);
    }
  });
});

describe('normaliseChunk', () => {
  it('is idempotent and leaves plain text untouched', () => {
    for (const s of ['plain', 'with spaces', 'a\nb', '日本', 'e\u0301', 'x\r\ny\tz\u202a']) {
      const once = normaliseChunk(s);
      expect(normaliseChunk(once)).toBe(once);
      const kept = normaliseChunk(s, { keepTabs: true });
      expect(normaliseChunk(kept, { keepTabs: true })).toBe(kept);
    }
    expect(normaliseChunk('plain text')).toBe('plain text');
    expect(normaliseChunk('a\nb')).toBe('a\nb');
  });
  it('keepTabs keeps \\t verbatim while every other rule still applies; expandTabs is the buffer form', () => {
    expect(normaliseChunk('a\tb', { keepTabs: true })).toBe('a\tb');
    expect(normaliseChunk('a\tb\r\n\u0007\u202e', { keepTabs: true })).toBe('a\tb\n');
    expect(normaliseChunk('a\tb')).toBe('a    b');
    expect(expandTabs('a\tb\t')).toBe('a    b    ');
    expect(expandTabs('none')).toBe('none');
    expect(expandTabs('')).toBe('');
  });
});

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-4 §2.7 (D6, P-R8) — an OSC answer whose `]` Ink stripped is not typed into the draft.
// ---------------------------------------------------------------------------------------
describe('P-R8: the `]`-less OSC answer (TUI-DESIGN-4 §2.7)', () => {
  it('§10 S2: the six OSC shapes are dropped with reason `osc`', () => {
    const shapes: [string, string][] = [
      ['OSC 11 answer, `]` stripped (the measured case: `│ › 11;rgb:0000/0000/0000`)', '11;rgb:0000/0000/0000'],
      ['OSC 11 answer with BEL', '11;rgb:1e1e/1e1e/1e1e\u0007'],
      ['OSC 11 answer with the ST tail', '11;rgb:ffff/ffff/ffff\u001b\\'],
      ['OSC 4 palette answer', '4;1;rgb:cc00/0000/0000'],
      ['OSC 52 clipboard answer (base64; privacy-correct to drop)', '52;c;aGVsbG8gd29ybGQ='],
      ['OSC 10 foreground answer, `]` intact (round 3 already dropped this one)', ']10;rgb:d0d0/d0d0/d0d0'],
    ];
    for (const [name, chunk] of shapes) expect(filterInput(chunk), name).toEqual(drop('osc'));
  });

  it('edge 5: two answers concatenated — the measured hang (`Ctrl-D ×2 stops exiting`, driver exit 124)', () => {
    expect(filterInput('11;rgb:0000/0000/0000\u0007]11;rgb:0000/0000/0000\u0007')).toEqual(drop('osc'));
    expect(filterInput(']11;rgb:0000/0000/0000\u0007]10;rgb:d0d0/d0d0/d0d0\u0007')).toEqual(drop('osc'));
    // ESC-separated too (the round-3 fold, now including answer bodies)
    expect(filterInput('\u001b]11;rgb:0000/0000/0000\u001b]10;rgb:0000/0000/0000')).toEqual(drop('osc'));
  });

  it('edge 2: an over-long OSC 52 body is dropped, never inserted as a remainder', () => {
    const long = `52;c;${'A'.repeat(OSC_ANSWER_MAX_BODY + 100)}`;
    expect(long.length).toBeGreaterThan(OSC_ANSWER_MAX_BODY);
    expect(filterInput(long)).toEqual(drop('osc'));
    expect(isOscAnswerBody(long)).toBe(true);
    // the band between the printable cap (256) and 4096 is the one the design's two long arms both miss, because the
    // OSC 52 selection parameter sits between the number and the payload — it is dropped too
    expect(filterInput(`52;c;${'A'.repeat(500)}\u0007`)).toEqual(drop('osc'));
    expect(filterInput(`52;c;${'A'.repeat(500)}`)).toEqual(drop('osc'));
  });

  it('edge 1: 20 "a human typed this" negatives — a typed digit-semicolon string arrives one keystroke at a time', () => {
    const typed = ['1', '1', ';', 'r', 'g', 'b', ':', '0', '0', '0', '0', 'a', 'Z', ' ', '/', '=', ';', '4', '2', '!'];
    expect(typed).toHaveLength(20);
    for (const ch of typed) expect(filterInput(ch), ch).toEqual(text(ch));
    // …and a multi-character chunk the caller knows is the user's is never an answer
    expect(filterInput('11;rgb:0000/0000/0000', {}, { paste: true })).toEqual(text('11;rgb:0000/0000/0000'));
    expect(filterInput('11;rgb:0000/0000/0000', {}, { typing: true })).toEqual(text('11;rgb:0000/0000/0000'));
    // a chunk with a newline is user text (an answer never carries one)
    expect(filterInput('11;rgb:0000\n0000')).toEqual(text('11;rgb:0000\n0000'));
    // below the minimum length the rule cannot fire at all
    expect(OSC_ANSWER_MIN_CHARS).toBe(6);
    expect(filterInput('1;ab')).toEqual(text('1;ab'));
    expect(isOscAnswerBody('1;ab')).toBe(false);
  });

  it('round-4 review finding 5: a MULTI-character human / IME chunk of the shape `<digits>;<printable>` is text, not an answer', () => {
    // the 20 negatives above are all single characters, so none of them exercises the shape the rule fires on; these
    // are the chunks a non-bracketed paste, an IME commit or a fast burst delivers whole, and §2.7 edge 1's
    // "no preceding keystroke in the tick" gate is the composer's to pass, not this module's
    const prose = [
      '2024;my notes here',
      '80;this is a pasted line of text',
      '1;a b c d e f g h',
      '12;TODO: fix the parser',
      '3;こんにちは世界', // an IME commit behind a numeric prefix
      '2024;summary', // one `;` only: an OSC 52 answer always carries its selection parameter
      '404;not found',
      '8080;localhost',
    ];
    for (const chunk of prose) {
      expect(isOscAnswerBody(chunk), chunk).toBe(false);
      expect(filterInput(chunk), chunk).toEqual(text(chunk));
    }
    // …while the real answers of the same length class are still dropped
    for (const answer of ['11;rgb:0000/0000/0000', '4;1;rgb:cc00/0000/0000', '52;c;aGVsbG8=', '11;#1e1e1e']) {
      expect(isOscAnswerBody(answer), answer).toBe(true);
    }
  });

  it('edge 4 / A105: the CSI tail stays a documented limit and is still INSERTED — the new rule must not swallow it', () => {
    for (const tail of ['24;80R', '27;2;13~', '13;2u', '57414;1:3u']) {
      expect(filterInput(tail), tail).toEqual(text(tail));
      expect(isOscAnswerBody(tail), tail).toBe(false);
    }
  });

  it('edge 6: the rule is a pure predicate — the review box swallowing printable keys is unaffected, and nothing is logged', () => {
    // `filterInput` never returns the dropped body, only the trace category, so an OSC 52 clipboard answer
    // (which may carry the user's clipboard) leaves no copy behind
    const r = filterInput('52;c;c2VjcmV0');
    expect(r).toEqual(drop('osc'));
    expect(JSON.stringify(r)).not.toContain('c2VjcmV0');
  });

  it('edge 7: the same chunk under a screen reader (the filter runs before any prompt reader) — identical answer', () => {
    expect(filterInput('11;rgb:0000/0000/0000', { eventType: 'press' })).toEqual(drop('osc'));
  });

  it('the regexes are exported and the module doc no longer claims only the ESC is stripped', () => {
    expect(OSC_ANSWER_RE.test('11;rgb:0000/0000/0000')).toBe(true);
    expect(OSC_ANSWER_RE.test(']11;rgb:0000/0000/0000')).toBe(true);
    expect(OSC_LEAK_RE.test('11;rgb:0000/0000/0000')).toBe(false); // the round-3 rule, which is what let it through
  });
});
