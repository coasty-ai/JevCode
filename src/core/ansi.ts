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

/** A backspace erases the character before it (spinners `|\b/\b-`, man-page overstrike `_\bX`). */
function applyBackspaces(l: string): string {
  if (!l.includes('\b')) return l;
  const out: string[] = [];
  for (const ch of l) {
    if (ch === '\b') out.pop();
    else out.push(ch);
  }
  return out.join('');
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
  return applyBackspaces(l);
}

/**
 * What a TERMINAL leaves on each line: CRLF → LF, a bare CR keeps the last non-blank redraw, a backspace erases. The
 * TUI's live tail draws this; the model reads `cleanCommandOutput`, which keeps what only looks overwritten. Pure.
 */
export function resolveOverwrites(s: string): string {
  if (!s.includes('\r') && !s.includes('\b')) return s;
  return s.replace(/\r+\n/g, '\n').split('\n').map(resolveLine).join('\n');
}

/** Cursor to column 1 (`ESC[G`, `ESC[1G`): a carriage return in all but name (how yarn, npm and docker redraw). */
const COLUMN_ONE_RE = /\u001b\[[01]?G/g;
/** Erase in line at the start of a segment (`\r ESC[K`, cargo / ninja): the program erased what it returned over. */
const ERASE_AT_START_RE = /^\u001b\[[02]?K/;
/** Erase the whole line at the end of a segment (`ESC[2K \r`): the same, the other way round. */
const ERASE_ALL_AT_END_RE = /\u001b\[2K$/;
/** A word: 2+ letters not glued to a number — `kB` of `552kB` and `it` of `9.8it/s` or `?it/s` are units, not words. */
const WORD_RE = /(?<![\p{L}\d?])\p{L}{2,}/gu;

function wordsOf(s: string): string {
  return (s.match(WORD_RE) ?? []).join(' ');
}

/**
 * One raw line (no `\n`) as the model should read it. A bare CR (or a cursor-to-column-1) starts a new segment; a
 * segment is a REDRAW of the next non-blank one — dropped, counted — when the program erased the line between them
 * (`\r ESC[K`, `ESC[2K \r`) or when both have the same words and differ only in numbers, bars and punctuation (a
 * progress bar, a download meter, a spinner's status). Anything else is kept on its own line: a file with CR line
 * endings (`cat old-mac.csv`, a `git diff` of one) or a stray CR between two records is never reduced to its last part.
 * A blank segment (`\r` + spaces) hides nothing. Backspaces apply within each segment.
 */
function collapseLine(raw: string): { text: string; collapsed: number } {
  const parts = raw.replace(COLUMN_ONE_RE, '\r').split('\r');
  if (parts.length === 1) return { text: applyBackspaces(stripAnsi(raw)), collapsed: 0 };
  const kept: string[] = [];
  let collapsed = 0;
  let pending: { text: string; words: string } | null = null;
  let erased = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    const text = applyBackspaces(stripAnsi(part));
    if (text.trim() !== '') {
      const words = wordsOf(text);
      if (pending !== null) {
        if (erased || words === pending.words) collapsed++;
        else kept.push(pending.text);
      }
      pending = { text, words };
      erased = false;
    }
    if (i + 1 < parts.length && (ERASE_ALL_AT_END_RE.test(part) || ERASE_AT_START_RE.test(parts[i + 1] ?? ''))) erased = true;
  }
  if (pending !== null) kept.push(pending.text);
  return { text: kept.join('\n'), collapsed };
}

/** The line that tells the model redraws were collapsed, and how to see every one. Pure. */
export function redrawNote(n: number): string {
  return `(${n} carriage-return redraw${n === 1 ? '' : 's'} collapsed to the final state; pipe through cat -v to see each one)`;
}

/**
 * A command's output as the model (and the spill file, and the test-count parser) should read it: escape sequences
 * gone, progress redraws collapsed to their final state (`collapseLine`: only what the program erased or what repeats
 * the same words — CR-separated records are kept, one per line) with a closing `redrawNote` naming how many, backspaces
 * applied, a NUL read as a line break (`find -print0`, `git ls-files -z`, `git status -z` keep their separators), and
 * every other control byte gone (\t and \n kept). Run it BEFORE the redactor, so a secret an SGR split in two is
 * whole when the redactor looks. Pure.
 */
export function cleanCommandOutput(s: string): string {
  if (!/[\r\b\u0000]|\u001b\[[01]?G/.test(s)) return stripAnsi(s).replace(CONTROL_KEEP_TN_RE, '');
  let collapsed = 0;
  const lines = s
    .replace(/\u0000/g, '\n')
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map((line) => {
      const r = collapseLine(line);
      collapsed += r.collapsed;
      return r.text;
    });
  const out = lines.join('\n').replace(CONTROL_KEEP_TN_RE, '');
  if (collapsed === 0) return out;
  // the note closes the stream on its own line; the stream's own final line break stays last
  return out.endsWith('\n') ? `${out}${redrawNote(collapsed)}\n` : `${out}${out === '' ? '' : '\n'}${redrawNote(collapsed)}`;
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

// A sequence whose match could still change with more text, tested (sticky, through to the end of the text) at an
// introducer the whole-text scan reaches. ESC_SEQ_RE's alternatives, each with what is still to come:
//   ESC [ params intermediates    the final byte          ESC ] body [ESC]           a BEL, U+009C, or the `\` of ST
//   ESC P|X|^|_ body [ESC]        U+009C or the `\` of ST  ESC N|O                    SS2/SS3's byte
//   ESC intermediates*            a lone ESC, nF's final  U+009B [params+ inter*]    8-bit CSI's parameter and final
//   U+009D body                   its BEL / U+009C        U+0090 U+0098 U+009E U+009F body   its U+009C
// An ESC or a line break inside a body ends it, so an OSC/DCS body is open only while it holds neither.
const OPEN_Y = /(?:\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b\u009c\n]*\u001b?|[PX^_][^\u001b\u009c\n]*\u001b?|[NO]|[ -/]*)|\u009b(?:[0-?]+[ -/]*)?|\u009d[^\u0007\u001b\u009c\n]*|[\u0090\u0098\u009e\u009f][^\u001b\u009c\n]*)$/y;
/** ESC_SEQ_RE, sticky: the finished sequence (if any) at one introducer, so an introducer inside its body is skipped */
const SEQ_Y = new RegExp(ESC_SEQ_RE.source, 'y');
const INTRODUCER_RE = /[\u001b\u009b\u009d\u0090\u0098\u009e\u009f]/g;
const OPEN_STRING_RE = /^\u001b[\]PX^_]/;

/**
 * Where the text's open sequence starts: the EARLIEST open introducer the whole-text scan reaches, walking them in
 * order and skipping each finished sequence whole (an introducer inside its body starts nothing). Holding from the
 * last introducer instead cut a C1 introducer out of an open 8-bit OSC's body (`U+009D … U+0090 [[`), and the OSC's
 * body then showed as text once its BEL arrived. `discard`: an open OSC/DCS longer than STREAM_HOLD_MAX. Pure.
 */
function openSequenceStart(text: string): { at: number; discard: boolean } | null {
  INTRODUCER_RE.lastIndex = 0;
  for (let m = INTRODUCER_RE.exec(text); m !== null; m = INTRODUCER_RE.exec(text)) {
    const i = m.index;
    OPEN_Y.lastIndex = i;
    if (OPEN_Y.test(text)) {
      if (text.length - i <= STREAM_HOLD_MAX) return { at: i, discard: false };
      // an OSC / DCS longer than the hold (an OSC 52 clipboard payload): dropped, and the rest of it as it arrives
      if (OPEN_STRING_RE.test(text.slice(i, i + 2))) return { at: i, discard: true };
      // anything else that long is not a sequence a terminal would still be waiting on: it is sanitised as text
      continue;
    }
    SEQ_Y.lastIndex = i;
    const seq = SEQ_Y.exec(text);
    if (seq !== null) INTRODUCER_RE.lastIndex = i + Math.max(1, seq[0].length);
  }
  return null;
}

export interface TerminalStreamSanitizer {
  /** the display-safe text of `chunk`, minus a trailing sequence that is still open (held for the next chunk) */
  push(chunk: string): string;
  /** end of stream: whatever is held, sanitised (an unfinished sequence is dropped), and the state reset */
  flush(): string;
}

/**
 * `stripTerminalControls` for a stream that arrives in chunks: `push(a) + push(b) + flush()` equals
 * `stripTerminalControls(a + b)` for every split, 7-bit and 8-bit (C1) forms alike, because a sequence cut by a chunk
 * boundary (`ESC[3` | `3m✓`) is held — from its introducer, with any introducer inside its body — instead of being
 * half-stripped. Memory is bounded by STREAM_HOLD_MAX, and so is the equality: an open OSC/DCS string longer than that
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
      const open = openSequenceStart(text);
      if (open !== null) {
        if (open.discard) discarding = true;
        else held = text.slice(open.at);
        text = text.slice(0, open.at);
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
