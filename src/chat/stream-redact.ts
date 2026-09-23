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
 *    anchor whose value has not been terminated by whitespace yet is held from the anchor on. Whitespace can be eaten,
 *    though: an exact secret that begins with it or spans it becomes a marker glued onto the value, and the pattern's
 *    `\S+` then runs on to the next whitespace. So the value's end is read the way the redactor reads it (a probe
 *    character appended must not be swallowed), and while any exact secret is still pending the anchor holds too;
 *  - an exact secret is held from the earliest point where the tail is a proper prefix of one
 *    (`Redactor.pendingSecretStart`), since every occurrence a later append can complete starts at such a point. A tail
 *    that cannot become a secret is not held at all, whatever the secrets' lengths: a PEM key in the workspace .env
 *    holds back a trailing `-----BEGIN`, never the last 1.7 KB of every reply.
 *
 * Every cut is then checked against the redactor itself — `redact(head) + redact(tail) === redact(head + tail)` over the
 * text not yet emitted — and moved back to an earlier word boundary when a match would straddle it, so the emitted
 * chunks always concatenate to exactly `redact(sanitizeStream(all))`. The cost per delta is a few redactions of the
 * held-back text only, usually a word (one more while a header anchor is in it).
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
/** HEADER_PATTERN's anchors, case-insensitive as the pattern is. */
const HEADER_ANCHOR = /authorization:|x-api-key:/gi;
/** After `authorization:` — still open while `bearer` is being typed or its value has not been ended by whitespace. */
const BEARER_OPEN = /^\s*(?:b(?:e(?:a(?:r(?:e(?:r\s*\S*)?)?)?)?)?)?$/i;
/** After `x-api-key:` — still open until the value is followed by whitespace. */
const VALUE_OPEN = /^\s*\S*$/;
/** Not whitespace, not a key character, not `[`: appended, only an open header value can swallow it. */
const PROBE = '~';
/** How many earlier word boundaries a cut may fall back to before the delta simply waits for the next one. */
const CUT_RETRIES = 3;

/** Start of the maximal run of `re` characters that ends the string. */
function runStart(s: string, re: RegExp): number {
  let i = s.length;
  while (i > 0 && re.test(s[i - 1]!)) i--;
  return i;
}

/**
 * The start of the earliest header anchor whose value may still grow, or `s.length`. With `pending` (the earliest start
 * of an unfinished exact secret) inside the text, or a value that still runs to the end once the exact secrets are
 * markers (`redact` swallows a probe character), the EARLIEST anchor holds — conservative, and rare: it takes a header
 * line and a secret-shaped tail in the same held-back window.
 */
function openHeaderStart(s: string, pending: number, redact: (s: string) => string): number {
  const anchors = [...s.matchAll(HEADER_ANCHOR)];
  const first = anchors[0];
  if (first === undefined) return s.length;
  if (pending < s.length || redact(s + PROBE) !== redact(s) + PROBE) return first.index;
  for (const m of anchors) {
    const rest = s.slice(m.index + m[0].length);
    if (m[0].toLowerCase() === 'authorization:' ? BEARER_OPEN.test(rest) : VALUE_OPEN.test(rest)) return m.index;
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
 * @param pendingSecretStart the same redactor's `pendingSecretStart` — where an unfinished exact secret could start in the
 *   held-back text (`s.length` = nowhere; a redactor without exact secrets always answers that)
 */
export function createStreamRedactor(redact: (s: string) => string, pendingSecretStart: (s: string) => number): StreamRedactor {
  /** the sanitized text not emitted yet — nothing before it can still change, so only this window is ever redacted again */
  let held = '';
  let out = '';

  /** how much of `held` no later append can change, by the rules in the header comment */
  function safeCut(): number {
    const pending = pendingSecretStart(held);
    return Math.min(runStart(held, KEY_CHAR), pending, openHeaderStart(held, pending, redact));
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
