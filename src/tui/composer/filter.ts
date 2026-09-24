/**
 * Input filter applied before `insert` (TUI-DESIGN §4.4; A5, A88, A92; 08 §2.3, 07 §1.2). Pure, ink-free, no timers (C21).
 *
 * `useInput` hands the composer everything the terminal wrote that Ink did not resolve to a key: focus reports,
 * cursor-position replies, kitty/DA1 answers, SGR mouse noise and OSC fragments all arrive as text with the leading
 * ESC stripped. Bindings are resolved first (O3); what reaches this filter is either text to insert or garbage to drop.
 *
 * **Correction, measured for TUI-DESIGN-4 §2.7 (D6, P-R8): for the FIRST OSC of a read Ink strips the `]` too.**
 * `OSC_LEAK_RE` requires the chunk to start with `]`, so an OSC 11 answer lands in the draft
 * (`│ › 11;rgb:0000/0000/0000`), two answers concatenate, and with a non-empty draft Ctrl-D ×2 stops exiting — the
 * session appears wedged (driver exit 124). jevcode never *sends* a query (`kittyKeyboard: {mode:'disabled'}`), but an
 * answer arrives anyway from a program that ran before it in the same pane (neovim queries OSC 11 at startup), from
 * tmux passthrough, or from a terminal that volunteers OSC 4/11 on focus. `OSC_ANSWER_RE` therefore makes the `]`
 * optional and matches the answer bodies a terminal actually sends; because a `]`-less body is indistinguishable
 * from typed text in the general case, the rule is gated four ways (§2.7 edge 1 plus the round-4 review's finding
 * 5): the body must look like an **answer** and not merely like printable text after a `<digits>;` (see
 * `OSC_ANSWER_RE`), the chunk must be **one** `useInput` text chunk of `OSC_ANSWER_MIN_CHARS` or more, it must not
 * have arrived as bracketed-paste content, and it must not follow a keystroke in the same tick — a human typing
 * `11;rgb:…` delivers one character per chunk, so the rule cannot fire on typing.
 * A split OSC's ESC-less, `;`-less tail stays a documented limit, exactly like the CSI tail below.
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
/**
 * TUI-DESIGN-4 §2.7 (P-R8): a whole OSC **answer** body, with the `]` optional because Ink strips it from the first
 * OSC of a read — `11;rgb:0000/0000/0000`, `52;c;<base64>`, `4;1;rgb:…`, with or without the BEL / `ESC \` terminator
 * (edge 3).
 *
 * **Narrower than §2.7's literal regex, deliberately (round-4 review, finding 5).** The design's third alternative
 * `[\x20-\x7e]{0,256}` makes *any* `<1–4 digits>;<printable>` chunk of ≥ 6 characters an "OSC answer", so
 * `2024;my notes here`, `80;this is a pasted line of text` and `1;a b c d e f g h` are all silently deleted from the
 * draft — and §2.7 edge 1's third gate (no keystroke earlier in the tick) is the composer's to pass, not this
 * module's, so a non-bracketed paste or an IME commit of that shape would reach it. The arms below are the shapes a
 * terminal actually answers with: a colour reply (`rgb:` / `rgba:` / `#rrggbb`, optionally behind a palette index),
 * an OSC 52 reply (a selection parameter, then base64 — the parameter is **required**, which is what keeps
 * `2024;summary` out), and a `?`-led answer body. The base64 arm is capped at `OSC_ANSWER_MAX_BODY` (edge 2).
 */
// eslint-disable-next-line no-control-regex
export const OSC_ANSWER_RE = /^\]?\d{1,4};(?:(?:\d{1,5};)?(?:rgba?|cmyk):[0-9a-f/]+|(?:\d{1,5};)?#[0-9a-f]{3,12}|[A-Za-z0-9]{0,8};[A-Za-z0-9+/=]{1,4096}|\?[\x20-\x7e]{0,64})(?:\x07|\x1b\\)?$/i;
/**
 * TUI-DESIGN-4 §2.7 edge 2: a **long** OSC 52 answer — `52;c;<base64>`, where the selection parameter (`c`, `p`, `s`…)
 * sits between the number and the payload, so neither of `OSC_ANSWER_RE`'s two long arms reaches it: the base64 arm
 * stops at the second `;` and the printable arm caps at 256. Any such answer above the printable cap is dropped,
 * whatever its length — "cap at 4096 and **drop the remainder rather than insert it**" means the chunk never becomes
 * draft text, not that a 5 KiB clipboard answer is typed in instead.
 */
// eslint-disable-next-line no-control-regex
export const OSC_ANSWER_LONG_RE = /^\]?\d{1,4};[A-Za-z0-9]{0,8};[A-Za-z0-9+/=]{257,}(?:\x07|\x1b\\)?$/;
/** TUI-DESIGN-4 §2.7 edge 2: the base64 body cap — the remainder is dropped with the answer, never inserted. */
export const OSC_ANSWER_MAX_BODY = 4096;
/**
 * TUI-DESIGN-4 §2.7 edge 1: the `]`-less answer rule only fires on a chunk of at least this many characters. A human
 * types one character per chunk, so no typed digit-semicolon string can reach it (asserted with 20 negatives).
 */
export const OSC_ANSWER_MIN_CHARS = 6;

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

/**
 * TUI-DESIGN-4 §2.7 (P-R8): one OSC answer body, `]` optional, terminator optional, base64 remainder dropped rather
 * than inserted (edge 2). Short chunks are excluded here so the fold below cannot fire on a typed fragment either.
 */
export function isOscAnswerBody(body: string): boolean {
  if (body.length < OSC_ANSWER_MIN_CHARS) return false;
  // A105 / §2.7 edge 4, which the §2.7 regex on its own would break: the ESC-less tail of a CSI split across two
  // reads (`24;80R`, `27;2;13~`) also matches `\d{1,4};<printable>`. That tail is pinned as **inserted** (the
  // module doc above and `filter.ts:14–16`), so a chunk that is a CSI leak body with its `[` missing is never an
  // OSC answer. `11;rgb:…`, `52;c;<base64>` and `4;1;rgb:…` are unaffected — none of them is a CSI body.
  if (CSI_LEAK_RE.test(`[${body}`)) return false;
  return OSC_ANSWER_RE.test(body) || OSC_ANSWER_LONG_RE.test(body);
}

/** True when `body` (one ESC-less sequence) is a CSI or OSC leak-through the design drops (TUI-DESIGN §4.4, §2.7). */
function isLeakBody(body: string): boolean {
  return CSI_LEAK_RE.test(body) || OSC_LEAK_RE.test(body) || body === OSC_ST_TAIL || isOscAnswerBody(body);
}

/**
 * TUI-DESIGN-4 §2.7: what the caller knows about *how* the chunk arrived. Both default to `false`, which is the
 * measured default a terminal answer arrives under; the composer sets them so a paste and a burst of typing are
 * never mistaken for an OSC reply (edge 1).
 */
export interface FilterContext {
  /** the chunk is bracketed-paste content (§4.5): user text, never a terminal answer */
  readonly paste?: boolean;
  /** a keystroke was already delivered in this tick: the human-typing case the `]`-less rule must not fire on */
  readonly typing?: boolean;
}

/**
 * Decide whether a `useInput` chunk is text for the buffer (TUI-DESIGN §4.4). Drops every ctrl/meta/super/hyper modifier
 * (bindings were resolved first), release/repeat events, CSI-body and OSC leak-through (single, ESC-concatenated,
 * `]`-concatenated, the bare `ESC [` introducer of a split sequence, or — TUI-DESIGN-4 §2.7 — a whole OSC answer whose
 * `]` Ink stripped), and chunks that are empty after normalisation. A multi-code-point chunk without ESC is an IME
 * commit or a paste-like burst and is inserted whole. `ctx.paste` / `ctx.typing` turn the §2.7 rule off for content the
 * caller already knows is the user's.
 */
export function filterInput(input: string, key: InputKeyFlags = {}, ctx: FilterContext = {}): FilterResult {
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
  // TUI-DESIGN-4 §2.7 (P-R8): the `]`-less answer Ink hands over for the first OSC of a read. Never on paste content,
  // never on a chunk that contains a newline, never when a keystroke already arrived in this tick (edge 1).
  if (ctx.paste !== true && ctx.typing !== true && !input.includes('\n')) {
    if (isOscAnswerBody(raw)) return { ok: false, reason: 'osc' };
    // two answers concatenated (the measured case): every `]`-separated piece must be an answer body
    if (raw.includes(']')) {
      const parts = raw.split(']').filter((p) => p.length > 0);
      if (parts.length > 1 && parts.every(isOscAnswerBody)) return { ok: false, reason: 'osc' };
    }
  }
  const text = normaliseChunk(input);
  if (text.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, text };
}
