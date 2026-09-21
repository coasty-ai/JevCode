/**
 * Input filter applied before `insert` (TUI-DESIGN §4.4; A5, A88, A92; 08 §2.3, 07 §1.2). Pure, ink-free, no timers (C21).
 *
 * `useInput` hands the composer everything the terminal wrote that Ink did not resolve to a key: focus reports,
 * cursor-position replies, kitty/DA1 answers, SGR mouse noise and OSC fragments all arrive as text with the leading
 * ESC stripped. Bindings are resolved first (O3); what reaches this filter is either text to insert or garbage to drop.
 *
 * This module also owns the one normaliser every text path shares (`normaliseChunk`): the buffer (§4.1), the paste
 * store (§4.5 step 2, with `keepTabs`) and the history store (§4.6) all call it, so a rule change lands in one place.
 *
 * Split and concatenated CSI deliveries (A105) are pinned as follows, since C21 forbids the timer that would be needed
 * to join two reads: a chunk that is exactly the CSI introducer `ESC [` is dropped (`csi`); a chunk made only of
 * ESC-separated leak bodies (`ESC [ I ESC [ O`) is dropped whole; the ESC-less tail of a CSI split across two reads
 * (`24;80R`) is indistinguishable from typed text and is inserted — Ink's own parser keeps a pending escape across
 * reads, so this tail only reaches the filter when the terminal itself split the reply.
 */

/** The subset of Ink's `Key` the filter reads (TUI-DESIGN §4.4); every field optional so an Ink `Key` is assignable as is. */
export interface InputKeyFlags {
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly super?: boolean;
  readonly hyper?: boolean;
  readonly eventType?: 'press' | 'repeat' | 'release';
}

/** Why a chunk was dropped (TUI-DESIGN §4.4: a dropped body increments the `key filtered` trace category). */
export type FilterDropReason = 'modifier' | 'release' | 'repeat' | 'csi' | 'osc' | 'empty';

/** `ok` = insert `text` (already normalised for the buffer); otherwise the `key filtered` trace category to bump (TUI-DESIGN §4.4). */
export type FilterResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: FilterDropReason };

/**
 * CSI bodies that leak through Ink as text (TUI-DESIGN §4.4): focus `[I`/`[O`, kitty `[?0u`, DA1 `[?62;22c`, CPR `[24;80R`,
 * xterm `[27;2;13~`, SGR mouse `[<64;10;5M`; extended (A105, §19.1) with kitty CSI-u key bodies `[13;2u` / `[9;2u` /
 * `[57414;1:3u` and modified cursor/edit keys `[1;5A` / `[3~` that escape Ink's own key parser when the ESC is lost.
 */
export const CSI_LEAK_RE = /^\[(?:I|O|\?\d+[uc]|\d+;\d+R|27;\d+;\d+~|<\d+;\d+;\d+[Mm]|\?62;[\d;]*c|\d+(?:;[\d:]+)*u|\d+(?:;\d+)*[A-D~])$/;
/** OSC fragments: a terminal answering `]11;rgb:…` (or any `]N;`) unprompted, and the ST tail `\\` (TUI-DESIGN §4.4). */
export const OSC_LEAK_RE = /^\]\d+;/;
/** The string-terminator tail `\\` a terminal may emit after an OSC reply (TUI-DESIGN §4.4). */
export const OSC_ST_TAIL = '\\';

/** Tabs become this many spaces when text enters the buffer (TUI-DESIGN §4.1, §4.4); paste bodies keep theirs (§4.5 step 2). */
export const TAB_SPACES = 4;
const TAB = ' '.repeat(TAB_SPACES);
// Printable ASCII plus '\n': already in the buffer's alphabet, nothing to do.
const PLAIN_RE = /^[ -~\n]*$/;
// C0 (minus \t \n \r), DEL and C1 — sanitizeStream's alphabet (plain.ts); ESC is among them, so any escape sequence loses its lead byte.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/g;
const LINE_SEP_RE = /[\u2028\u2029]/g;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const ESC = '\u001b';

/** Options of `normaliseChunk` (TUI-DESIGN §4.5 step 2: paste bodies are `sanitizeStream` minus `\n\t`, tabs kept). */
export interface NormaliseOptions {
  /** keep `\t` verbatim instead of expanding it to `TAB_SPACES` spaces */
  readonly keepTabs?: boolean;
}

/** Expand every tab to `TAB_SPACES` spaces (TUI-DESIGN §4.1: the buffer holds only '\n' below 0x20). Pure. */
export function expandTabs(s: string): string {
  return s.includes('\t') ? s.replace(/\t/g, TAB) : s;
}

/**
 * Normalise a chunk (TUI-DESIGN §4.4, §4.5 step 2, §4.6): `\r\n` then `\r` → `\n`; U+2028/2029 → `\n`; tabs → spaces
 * unless `keepTabs`; C0/DEL/C1 dropped (`sanitizeStream` minus `\n\t`); bidi controls U+202A–202E / U+2066–2069 stripped;
 * lone surrogates dropped. Pure and idempotent.
 */
export function normaliseChunk(s: string, opts: NormaliseOptions = {}): string {
  if (PLAIN_RE.test(s)) return s;
  const out = s
    .replace(/\r\n?/g, '\n')
    .replace(LINE_SEP_RE, '\n')
    .replace(CONTROL_RE, '')
    .replace(BIDI_RE, '')
    .replace(LONE_SURROGATE_RE, '');
  return opts.keepTabs === true ? out : expandTabs(out);
}

/** True when `body` (one ESC-less sequence) is a CSI or OSC leak-through the design drops (TUI-DESIGN §4.4). */
function isLeakBody(body: string): boolean {
  return CSI_LEAK_RE.test(body) || OSC_LEAK_RE.test(body) || body === OSC_ST_TAIL;
}

/**
 * Decide whether a `useInput` chunk is text for the buffer (TUI-DESIGN §4.4). Drops every ctrl/meta/super/hyper modifier
 * (bindings were resolved first), release/repeat events, CSI-body and OSC leak-through (single, ESC-concatenated, or the
 * bare `ESC [` introducer of a split sequence), and chunks that are empty after normalisation. A multi-code-point chunk
 * without ESC is an IME commit or a paste-like burst and is inserted whole.
 */
export function filterInput(input: string, key: InputKeyFlags = {}): FilterResult {
  if (key.ctrl === true || key.meta === true || key.super === true || key.hyper === true) return { ok: false, reason: 'modifier' };
  if (key.eventType === 'release') return { ok: false, reason: 'release' };
  if (key.eventType === 'repeat') return { ok: false, reason: 'repeat' };
  if (input.length === 0) return { ok: false, reason: 'empty' };
  // leak-through checks run on the raw chunk (Ink already stripped the leading ESC)
  const raw = input.startsWith(ESC) ? input.slice(1) : input;
  if (raw === '[' && input.length === 2) return { ok: false, reason: 'csi' }; // a bare CSI introducer: the first half of a split reply
  if (CSI_LEAK_RE.test(raw)) return { ok: false, reason: 'csi' };
  if (OSC_LEAK_RE.test(raw) || raw === OSC_ST_TAIL || raw === ESC + OSC_ST_TAIL) return { ok: false, reason: 'osc' };
  if (raw.includes(ESC)) {
    // several sequences delivered in one read (`ESC [ I ESC [ O`): drop the chunk when every piece is a leak body
    const pieces = raw.split(ESC).filter((p) => p.length > 0);
    if (pieces.length > 0 && pieces.every(isLeakBody)) return { ok: false, reason: CSI_LEAK_RE.test(pieces[0] ?? '') ? 'csi' : 'osc' };
  }
  const text = normaliseChunk(input);
  if (text.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, text };
}
