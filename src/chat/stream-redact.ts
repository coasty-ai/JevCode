/**
 * The live region's view of a streamed chat reply: redacted, sanitized and APPEND-ONLY.
 *
 * Redacting the whole text on every delta (what the controller did) shows a secret's first characters until its last
 * one arrives — `sk-or-v1-12…` sits in the live region for as long as the key takes to stream — and a text that
 * rewrites its own past cannot be committed progressively. This redactor emits only the prefix that no later append can
 * change under redaction, and holds the rest back until it can no longer change or the stream ends:
 *
 *  - a format-pattern key (core/redact.ts FORMAT_PATTERNS) lives inside one run of `[A-Za-z0-9_-]`, so the trailing run
 *    is held while it may still grow into one — and a finished run is final, since the `(?<![A-Za-z0-9])` lookbehind
 *    only reads inside the run;
 *  - a header value (HEADER_PATTERN: `authorization: bearer <value>`, `x-api-key: <value>`) spans whitespace, so an
 *    anchor whose value has not been terminated by whitespace yet is held from the anchor on;
 *  - an exact secret without whitespace is confined to one word, so while the redactor holds any exact secret the
 *    trailing word is held (no further back than `maxLength - 1` characters); an exact secret WITH whitespace can reach
 *    back across words, so the last `maxSpacedLength - 1` characters are held too.
 *
 * Every cut is then checked against the redactor itself — `redact(head) + redact(tail) === redact(head + tail)` over the
 * text not yet emitted — and moved back to an earlier word boundary when a match would straddle it, so the emitted
 * chunks always concatenate to exactly `redact(sanitizeStream(all))`. The cost per delta is a few redactions of the
 * held-back text only, usually a word.
 *
 * Control characters are dropped from every delta BEFORE redaction (`sanitizeStream`, the O10 rule the engine path
 * applies in useEngine's appendTail): a BEL or an ESC can never reach the terminal, and one inside a key can never split
 * it past the pattern layer. A provider retry restarts the text (`reset`), so a retried stream is never shown twice.
 */
import { sanitizeStream } from '../tui/plain.js';

export interface StreamRedactor {
  /** One provider delta in; what became final out (often '' — the delta is still held back). */
  push(delta: string): string;
  /** The stream ended: everything held back is final now. Returns that last chunk. */
  end(): string;
  /** A provider retry: the reply restarts from nothing. */
  reset(): void;
  /** Everything final so far — always a prefix of what `end()` completes. */
  readonly text: string;
}

/** A character a format-pattern key can contain (every FORMAT_PATTERNS body and prefix is drawn from it). */
const KEY_CHAR = /[A-Za-z0-9_-]/;
const SPACE = /\s/;
const NON_SPACE = /\S/;
/** HEADER_PATTERN's anchors, case-insensitive as the pattern is. */
const HEADER_ANCHOR = /authorization:|x-api-key:/gi;
/** After `authorization:` — still open while `bearer` is being typed or its value has not been ended by whitespace. */
const BEARER_OPEN = /^\s*(?:b(?:e(?:a(?:r(?:e(?:r\s*\S*)?)?)?)?)?)?$/i;
/** After `x-api-key:` — still open until the value is followed by whitespace. */
const VALUE_OPEN = /^\s*\S*$/;
/** How many earlier word boundaries a cut may fall back to before the delta simply waits for the next one. */
const CUT_RETRIES = 3;

/** Start of the maximal run of `re` characters that ends the string. */
function runStart(s: string, re: RegExp): number {
  let i = s.length;
  while (i > 0 && re.test(s[i - 1]!)) i--;
  return i;
}

/** The start of the earliest header anchor whose value may still grow, or `s.length`. */
function openHeaderStart(s: string): number {
  HEADER_ANCHOR.lastIndex = 0;
  for (let m = HEADER_ANCHOR.exec(s); m !== null; m = HEADER_ANCHOR.exec(s)) {
    const rest = s.slice(m.index + m[0].length);
    const open = m[0].toLowerCase() === 'authorization:' ? BEARER_OPEN.test(rest) : VALUE_OPEN.test(rest);
    if (open) return m.index;
  }
  return s.length;
}

/** The last word boundary (just after whitespace) strictly before `cut`, else 0. */
function boundaryBefore(s: string, cut: number): number {
  for (let i = cut - 1; i > 0; i--) if (SPACE.test(s[i - 1]!)) return i;
  return 0;
}

/**
 * @param redact the session's redactor (exact secrets, then the format and header patterns)
 * @param maxLength `Redactor.maxLength` — the longest exact secret (0 = none: only the patterns can hold text back)
 * @param maxSpacedLength `Redactor.maxSpacedLength` — the longest exact secret containing whitespace; defaults to
 *   `maxLength`, the safe reading for a caller that cannot tell (every secret might contain whitespace)
 */
export function createStreamRedactor(redact: (s: string) => string, maxLength: number, maxSpacedLength: number = maxLength): StreamRedactor {
  /** the sanitized text not emitted yet — nothing before it can still change, so only this window is ever redacted again */
  let held = '';
  let out = '';

  /** how much of `held` no later append can change, by the rules in the header comment */
  function safeCut(): number {
    const n = held.length;
    let cut = runStart(held, KEY_CHAR);
    if (maxLength > 0) cut = Math.min(cut, Math.max(runStart(held, NON_SPACE), n - maxLength + 1));
    if (maxSpacedLength > 0) cut = Math.min(cut, n - maxSpacedLength + 1);
    return Math.min(cut, openHeaderStart(held));
  }

  function emit(cut: number, chunk: string): string {
    out += chunk;
    held = held.slice(cut);
    return chunk;
  }

  return {
    push(delta: string): string {
      const clean = sanitizeStream(delta);
      if (clean.length === 0) return '';
      held += clean;
      let cut = safeCut();
      if (cut <= 0) return '';
      const whole = redact(held);
      for (let tries = 0; tries < CUT_RETRIES && cut > 0; tries++) {
        // a match straddling the cut would redact differently in two pieces than in one: move back a word and look again
        const head = redact(held.slice(0, cut));
        if (head + redact(held.slice(cut)) === whole) return emit(cut, head);
        cut = boundaryBefore(held, cut);
      }
      return '';
    },
    end(): string {
      return held.length > 0 ? emit(held.length, redact(held)) : '';
    },
    reset(): void {
      held = '';
      out = '';
    },
    get text(): string {
      return out;
    },
  };
}
