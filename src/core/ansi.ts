/**
 * Terminal-output hygiene — the ONE helper every place foreign text (a command's output, the model's own text) passes
 * through before it is drawn, logged or sent back to the model. Zero imports.
 *
 * Who uses what: `stripTerminalControls` is the TUI's `sanitizeStream` (live rows, `--plain`, transcript.log, clipboard);
 * `createTerminalStreamSanitizer` is the same for text that arrives in chunks (the execute stage's `exec:output`, the
 * model's streamed prose); `cleanCommandOutput` / `cleanCommandStreams` is what the model, the spill file, steps.jsonl
 * and the test-count parsers read; `ESC_SEQ_RE` / `stripAnsi` serve log lines, instruction-file import and runner
 * parsers. Never applied to file contents (an edit must match bytes) or to the harness's own git output.
 *
 * Escape sequences are removed WHOLE, then the remaining control bytes. Dropping only the ESC byte (the old
 * `sanitizeStream`) left the sequence body behind: vitest's slow-test tick `ESC[33mESC[2m✓ESC[22mESC[39m` reached the
 * live tail as `[33m[2m✓[22m[39m`.
 *
 * ECMA-48 / ISO 6429, 7-bit and 8-bit (C1) introducers:
 *   CSI  `ESC [` | U+009B, parameter bytes 0x30–0x3F, intermediates 0x20–0x2F, final 0x40–0x7E (optional: a sequence
 *        cut off by the end of the text or a line break is dropped, not half-kept)
 *   OSC  `ESC ]` | U+009D … BEL, `ESC \` or U+009C
 *   DCS / SOS / PM / APC  `ESC P` `ESC X` `ESC ^` `ESC _` | U+0090 U+0098 U+009E U+009F … `ESC \` or U+009C
 *   SS2 / SS3  `ESC N x`, `ESC O x`
 *   nF   `ESC` + intermediates 0x20–0x2F + final 0x30–0x7E (`ESC ( B`, tput sgr0's charset reset)
 *   Fp / Fe / Fs  `ESC` + one byte 0x30–0x7E (`ESC 7`, `ESC =`, `ESC c`, `ESC \`)
 * A control string's body never crosses a line break, so a stray introducer can hide at most the rest of its line.
 */

// 7-bit forms follow ECMA-48 exactly (what a terminal consumes). The 8-bit C1 forms are stripped as sequences only when
// well-formed (a CSI with a parameter and a final byte, a string with its terminator): a UTF-8 terminal does not act on
// U+0080–U+009F, so a stray C1 byte before prose loses only itself, never the letter after it.
const CSI = '\\u001b\\[[0-?]*[ -/]*[@-~]?|\\u009b[0-?]+[ -/]*[@-~]';
const OSC = '\\u001b\\][^\\u0007\\u001b\\u009c\\n]*(?:\\u0007|\\u001b\\\\|\\u009c)?|\\u009d[^\\u0007\\u001b\\u009c\\n]*(?:\\u0007|\\u009c)';
const STRING = '\\u001b[PX^_][^\\u001b\\u009c\\n]*(?:\\u001b\\\\|\\u009c)?|[\\u0090\\u0098\\u009e\\u009f][^\\u001b\\u009c\\n]*\\u009c';
const SS23 = '\\u001b[NO][@-~]';
const NF = '\\u001b[ -/]+[0-~]?';
const FS = '\\u001b[0-~]';

/** Every escape sequence, whole (global). */
export const ESC_SEQ_RE = new RegExp(`${CSI}|${OSC}|${STRING}|${SS23}|${NF}|${FS}`, 'g');
/** C0 minus \t \n \r, DEL, C1. */
const CONTROL_KEEP_TNR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** C0 minus \t \n, DEL, C1 (after overwrites are resolved no \r is left to keep). */
const CONTROL_KEEP_TN_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Remove escape sequences whole; every other character is kept. Pure. */
export function stripAnsi(s: string): string {
  return s.replace(ESC_SEQ_RE, '');
}

/**
 * Display-safe text with its line structure kept (\t \n \r survive): sequences whole, then every other control byte.
 * What `sanitizeStream` should be — for the TUI, `--plain`, transcript.log and the clipboard. Pure.
 */
export function stripTerminalControls(s: string): string {
  return s.replace(ESC_SEQ_RE, '').replace(CONTROL_KEEP_TNR_RE, '');
}

function resolveLine(line: string): string {
  let l = line;
  if (l.includes('\r')) {
    // a bare CR returns the cursor: what was drawn after the last one is what the line shows (a progress bar's
    // final state). A redraw that only blanks the line (`\r` + spaces) does not hide the state before it.
    const segs = l.split('\r');
    let last = '';
    for (let i = segs.length - 1; i >= 0; i--) {
      if ((segs[i] ?? '').trim() !== '') {
        last = segs[i] ?? '';
        break;
      }
    }
    l = last;
  }
  if (l.includes('\b')) {
    // a backspace erases the character before it (spinners `|\b/\b-`, man-page overstrike `_\bX`)
    const out: string[] = [];
    for (const ch of l) {
      if (ch === '\b') out.pop();
      else out.push(ch);
    }
    l = out.join('');
  }
  return l;
}

/** What a terminal leaves on each line: CRLF → LF, a bare CR keeps the last redraw, a backspace erases. Pure. */
export function resolveOverwrites(s: string): string {
  if (!s.includes('\r') && !s.includes('\b')) return s;
  return s.replace(/\r+\n/g, '\n').split('\n').map(resolveLine).join('\n');
}

/**
 * A command's output as the model (and the spill file, and the test-count parser) should read it: escape sequences
 * gone, progress redraws collapsed to their last state, backspaces applied, NUL and every other control byte gone
 * (\t and \n kept). Run it BEFORE the redactor, so a secret an SGR split in two is whole when the redactor looks. Pure.
 */
export function cleanCommandOutput(s: string): string {
  return resolveOverwrites(stripAnsi(s)).replace(CONTROL_KEEP_TN_RE, '');
}

/**
 * True when the text is binary rather than terminal output: at least 10 % of its first 8 KB is NUL, U+FFFD
 * (undecodable bytes) or a control character other than \t \n \r ESC. A stray NUL in real output is not enough;
 * `cat /bin/ls | head -c 60000` is 27 % NUL. Pure.
 */
export function looksBinary(s: string): boolean {
  const head = s.slice(0, 8192);
  if (head.length === 0) return false;
  const bad = head.match(/[\uFFFD\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g)?.length ?? 0;
  return bad / head.length >= 0.1;
}

/** UTF-8 length of a decoded string (an undecodable byte came back as U+FFFD, counted as the one byte it was). Pure. */
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80 || c === 0xfffd) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** What the model, the spill file and the TUI read in place of a binary stream: its size and how to look at it. Pure. */
export function binaryOutputNote(bytes: number): string {
  return `(binary output: ${bytes} bytes, not shown — write it to a file, or pipe it through xxd | head or file)`;
}

/**
 * A finished command's two streams as the model should read them: each one `cleanCommandOutput`, or `binaryOutputNote`
 * when it `looksBinary`. The size is the sandbox's own count when the other stream is empty (it counts every byte, the
 * cut middle included), else what was captured of this stream. Redact AFTER this, never before. Pure.
 */
export function cleanCommandStreams(exec: { stdout: string; stderr: string; bytesSeen: number }): { stdout: string; stderr: string } {
  const one = (raw: string, other: string): string => {
    if (!looksBinary(raw)) return cleanCommandOutput(raw);
    return binaryOutputNote(other.length === 0 && exec.bytesSeen > 0 ? exec.bytesSeen : utf8Bytes(raw));
  };
  return { stdout: one(exec.stdout, exec.stderr), stderr: one(exec.stderr, exec.stdout) };
}

/** Longest sequence ever held back across chunks; a longer open control string is discarded up to its end. */
export const STREAM_HOLD_MAX = 4096;

// a sequence that has started but not finished; tested on the text from the LAST introducer on, so no body holds ESC
const OPEN_RE = /^(?:\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u009c\n]*|[PX^_][^\u009c\n]*|[NO]|[ -/]*)|\u009b[0-?]*[ -/]*|\u009d[^\u0007\u009c\n]*|[\u0090\u0098\u009e\u009f][^\u009c\n]*)$/;
const INTRODUCER_RE = /[\u001b\u009b\u009d\u0090\u0098\u009e\u009f]/g;
const OPEN_STRING_RE = /^\u001b[\]PX^_]/;

export interface TerminalStreamSanitizer {
  /** the display-safe text of `chunk`, minus a trailing sequence that is still open (held for the next chunk) */
  push(chunk: string): string;
  /** end of stream: whatever is held, sanitised (an unfinished sequence is dropped), and the state reset */
  flush(): string;
}

/**
 * `stripTerminalControls` for a stream that arrives in chunks: `push(a) + push(b) + flush()` equals
 * `stripTerminalControls(a + b)` for every split, because a sequence cut by a chunk boundary (`ESC[3` | `3m✓`) is
 * held instead of being half-stripped. Memory is bounded by STREAM_HOLD_MAX: an open OSC/DCS string longer than that
 * is discarded and the rest of it is dropped as it arrives, up to its terminator or the end of its line.
 * One instance per stream (stdout and stderr each), reset per command.
 */
export function createTerminalStreamSanitizer(): TerminalStreamSanitizer {
  let held = '';
  let discarding = false;
  return {
    push(chunk: string): string {
      let text = chunk;
      if (discarding) {
        const end = text.search(/[\u0007\u009c\n]|\u001b/);
        if (end < 0) return '';
        discarding = false;
        // BEL / U+009C end the string and are consumed; an ESC or a line break is left for the next sequence / line
        const c = text[end];
        text = text.slice(c === '\u0007' || c === '\u009c' ? end + 1 : end);
      }
      text = held + text;
      held = '';
      let last = -1;
      for (const m of text.matchAll(INTRODUCER_RE)) last = m.index;
      if (last >= 0 && OPEN_RE.test(text.slice(last))) {
        const tail = text.slice(last);
        if (tail.length <= STREAM_HOLD_MAX) {
          held = tail;
          text = text.slice(0, last);
        } else if (OPEN_STRING_RE.test(tail)) {
          // an OSC / DCS longer than the hold (an OSC 52 clipboard payload): drop it and the rest of it as it arrives
          discarding = true;
          text = text.slice(0, last);
        }
        // anything else that long is not a sequence a terminal would still be waiting on: it is sanitised as text
      }
      return stripTerminalControls(text);
    },
    flush(): string {
      const out = stripTerminalControls(held);
      held = '';
      discarding = false;
      return out;
    },
  };
}
