/**
 * Python 3 tokenizer faithful to CPython's `tokenize` module (3.9–3.11 token model) for the
 * common cases: NAME, NUMBER, STRING, OP, NEWLINE/NL, INDENT/DEDENT, COMMENT, ERRORTOKEN,
 * ENDMARKER, with the same positions (1-based line, 0-based column) and the same handling of
 * blank/comment lines, backslash continuations, brackets and tab stops of 8.
 *
 * Deliberate deviations, all documented in the tests:
 * - f-strings are one STRING token (the pre-3.12 model) but the scanner understands
 *   replacement fields, so 3.12-style same-quote nesting (`f"{d["k"]}"`) is one token too.
 * - an unterminated single-quoted string yields ERRORTOKEN for the quote only (CPython also
 *   emits one for the preceding whitespace character, a regex artefact).
 * - an unbalanced closing bracket never drives the bracket depth negative.
 *
 * Every token carries absolute offsets (`start`/`end`) into the source and `pre`, the exact
 * text between the previous token and this one, so `untokenize(tokens)` returns the source
 * unchanged and a token list with edited `text` fields renders back to source with the
 * original formatting intact.
 */
import { PyIndentationError, PyTokenizeError } from './errors.js';

export type TokenType =
  | 'NAME'
  | 'NUMBER'
  | 'STRING'
  | 'OP'
  | 'NEWLINE'
  | 'NL'
  | 'INDENT'
  | 'DEDENT'
  | 'COMMENT'
  | 'ERRORTOKEN'
  | 'ENDMARKER';

export interface Token {
  readonly type: TokenType;
  /** Exact source slice; '' for DEDENT, ENDMARKER and the synthetic NEWLINE/NL at end of input. */
  readonly text: string;
  /** 1-based line of the first character. */
  readonly line: number;
  /** 0-based column (UTF-16 units) of the first character. */
  readonly col: number;
  readonly endLine: number;
  readonly endCol: number;
  /** Absolute offsets into the source, `end` exclusive. */
  readonly start: number;
  readonly end: number;
  /** Source text between the previous token's end and this token's start. */
  readonly pre: string;
}

export const PY_KEYWORDS: ReadonlySet<string> = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

export function isKeyword(text: string): boolean {
  return PY_KEYWORDS.has(text);
}

/** CPython's EXACT_TOKEN_TYPES (3.9): every operator and delimiter, longest first. */
export const PY_OPERATORS: readonly string[] = [
  '**=', '//=', '>>=', '<<=', '...',
  '!=', '%=', '&=', '**', '*=', '+=', '-=', '->', '//', '/=', ':=', '<<', '<=', '==', '>=', '>>', '@=', '^=', '|=',
  '%', '&', '(', ')', '*', '+', ',', '-', '.', '/', ':', ';', '<', '=', '>', '@', '[', ']', '^', '{', '|', '}', '~',
];
const OPS3 = new Set(PY_OPERATORS.filter((o) => o.length === 3));
const OPS2 = new Set(PY_OPERATORS.filter((o) => o.length === 2));
const OPS1 = new Set(PY_OPERATORS.filter((o) => o.length === 1));

// Number grammar transcribed from Lib/tokenize.py (order matters: imaginary, float, int).
const HEX = '0[xX](?:_?[0-9a-fA-F])+';
const BIN = '0[bB](?:_?[01])+';
const OCT = '0[oO](?:_?[0-7])+';
const DEC = '(?:0(?:_?0)*|[1-9](?:_?[0-9])*)';
const EXP = '[eE][-+]?[0-9](?:_?[0-9])*';
const POINTFLOAT = `(?:[0-9](?:_?[0-9])*\\.(?:[0-9](?:_?[0-9])*)?|\\.[0-9](?:_?[0-9])*)(?:${EXP})?`;
const EXPFLOAT = `[0-9](?:_?[0-9])*${EXP}`;
const FLOAT = `(?:${POINTFLOAT}|${EXPFLOAT})`;
const IMAG = `(?:[0-9](?:_?[0-9])*[jJ]|${FLOAT}[jJ])`;
const NUMBER_RE = new RegExp(`(?:${IMAG}|${FLOAT}|${HEX}|${BIN}|${OCT}|${DEC})`, 'y');
const NAME_RE = /[\p{L}\p{Nl}_][\p{L}\p{N}\p{M}_]*/uy;
const STRING_PREFIXES = new Set(['', 'r', 'u', 'f', 'b', 'fr', 'rf', 'br', 'rb']);

const TABSIZE = 8;

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function isQuote(c: string | undefined): boolean {
  return c === '"' || c === "'";
}

/** Tab-expanded width of an indentation string, as CPython's tokenizer measures it. */
export function indentWidth(ws: string): number {
  let column = 0;
  for (const c of ws) {
    if (c === ' ') column++;
    else if (c === '\t') column = (Math.floor(column / TABSIZE) + 1) * TABSIZE;
    else if (c === '\f') column = 0;
    else break;
  }
  return column;
}

interface StringStart {
  prefixLen: number;
  quote: string;
  triple: boolean;
  isF: boolean;
}

/** If a string literal (with optional prefix) starts at `i`, describe it. */
function stringStart(src: string, i: number): StringStart | null {
  let p = 0;
  while (p < 2 && i + p < src.length && /[bBrRuUfF]/.test(src[i + p]!)) p++;
  // the prefix must be followed immediately by a quote; try the longest prefix first
  for (let len = p; len >= 0; len--) {
    const q = src[i + len];
    if (!isQuote(q)) continue;
    const prefix = src.slice(i, i + len).toLowerCase();
    if (!STRING_PREFIXES.has(prefix)) continue;
    const triple = src[i + len + 1] === q && src[i + len + 2] === q;
    return { prefixLen: len, quote: q!, triple, isF: prefix.includes('f') };
  }
  return null;
}

function closesAt(src: string, i: number, quote: string, triple: boolean): boolean {
  if (src[i] !== quote) return false;
  return !triple || (src[i + 1] === quote && src[i + 2] === quote);
}

/**
 * Scan a plain (non-f) string body starting after the opening quote(s). Returns the offset
 * after the closing quote(s), or -1 when a single-quoted literal hits a newline/end of input.
 * A triple-quoted literal that never closes throws `eof_in_string`, like CPython's TokenError.
 */
function scanPlainString(src: string, i: number, quote: string, triple: boolean, lineOf: (o: number) => [number, number]): number {
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === '\\') {
      // backslash escapes the next character; backslash-newline continues a single-quoted literal
      i += src[i + 1] === '\r' && src[i + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (closesAt(src, i, quote, triple)) return i + (triple ? 3 : 1);
    if (!triple && c === '\n') return -1;
    i++;
  }
  if (triple) {
    const [l, col] = lineOf(i);
    throw new PyTokenizeError('eof_in_string', l, col, `EOF in multi-line string (line ${l})`);
  }
  return -1;
}

type FMode = { kind: 'expr'; depth: number } | { kind: 'spec' };

/** Look back from a quote for an f/r/b/u prefix that is not part of a longer identifier. */
function prefixBefore(src: string, quotePos: number): string {
  let s = quotePos;
  while (s > 0 && /[bBrRuUfF]/.test(src[s - 1]!)) s--;
  if (s > 0 && /[\p{L}\p{N}_]/u.test(src[s - 1]!)) return '';
  const prefix = src.slice(s, quotePos).toLowerCase();
  return STRING_PREFIXES.has(prefix) ? prefix : '';
}

/**
 * Scan an f-string body: literal text with `{{`/`}}` escapes, replacement fields whose
 * expressions may contain nested string literals of any quote style, `!r`-style conversions
 * and format specs (`:` at expression depth 0) which may themselves contain nested fields.
 */
function scanFString(src: string, i: number, quote: string, triple: boolean, lineOf: (o: number) => [number, number]): number {
  const n = src.length;
  const modes: FMode[] = [];
  while (i < n) {
    const c = src[i]!;
    const top = modes[modes.length - 1];
    if (top === undefined) {
      if (c === '\\') {
        i += src[i + 1] === '\r' && src[i + 2] === '\n' ? 3 : 2;
        continue;
      }
      if (closesAt(src, i, quote, triple)) return i + (triple ? 3 : 1);
      if (!triple && c === '\n') return -1;
      if (c === '{') {
        if (src[i + 1] === '{') i += 2;
        else {
          modes.push({ kind: 'expr', depth: 0 });
          i++;
        }
        continue;
      }
      if (c === '}') {
        i += src[i + 1] === '}' ? 2 : 1;
        continue;
      }
      i++;
      continue;
    }
    if (top.kind === 'expr') {
      if (isQuote(c)) {
        const nestedTriple = src[i + 1] === c && src[i + 2] === c;
        const isNestedF = prefixBefore(src, i).includes('f');
        const body = i + (nestedTriple ? 3 : 1);
        const e = isNestedF ? scanFString(src, body, c, nestedTriple, lineOf) : scanPlainString(src, body, c, nestedTriple, lineOf);
        if (e < 0) return -1;
        i = e;
        continue;
      }
      if (!triple && c === '\n') return -1;
      if (c === '(' || c === '[' || c === '{') {
        top.depth++;
        i++;
        continue;
      }
      if (c === ')' || c === ']') {
        if (top.depth > 0) top.depth--;
        i++;
        continue;
      }
      if (c === '}') {
        if (top.depth === 0) modes.pop();
        else top.depth--;
        i++;
        continue;
      }
      if (c === ':' && top.depth === 0) {
        modes[modes.length - 1] = { kind: 'spec' };
        i++;
        continue;
      }
      i++;
      continue;
    }
    // format spec: literal text until the closing brace, with nested replacement fields
    if (c === '{') {
      modes.push({ kind: 'expr', depth: 0 });
      i++;
      continue;
    }
    if (c === '}') {
      modes.pop();
      i++;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (!triple && c === '\n') return -1;
    i++;
  }
  if (triple) {
    const [l, col] = lineOf(i);
    throw new PyTokenizeError('eof_in_string', l, col, `EOF in multi-line string (line ${l})`);
  }
  return -1;
}

function endOfComment(src: string, i: number): number {
  while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
  return i;
}

/** Length of the newline sequence at `i` (2 for CRLF, 1 for LF, 0 for none; a lone CR is not a newline). */
function newlineLen(src: string, i: number): number {
  if (src[i] === '\n') return 1;
  if (src[i] === '\r' && src[i + 1] === '\n') return 2;
  return 0;
}

interface Raw {
  type: TokenType;
  start: number;
  end: number;
}

interface Scan {
  toks: Raw[];
  end: number;
  /** A backslash-newline: nothing emitted, the logical line continues. */
  continuation: boolean;
}

/**
 * Scan one pseudo-token at `i` (no leading whitespace). Newlines come back as NEWLINE; the
 * caller relabels them NL inside brackets. Quote-prefixed unterminated strings come back as
 * NAME + ERRORTOKEN, as CPython yields them.
 */
function scanAt(src: string, i: number, lineOf: (o: number) => [number, number]): Scan {
  const c = src[i]!;
  const nl = newlineLen(src, i);
  if (nl > 0) return { toks: [{ type: 'NEWLINE', start: i, end: i + nl }], end: i + nl, continuation: false };
  if (c === '\\') {
    const after = newlineLen(src, i + 1);
    if (after > 0) return { toks: [], end: i + 1 + after, continuation: true };
    return { toks: [{ type: 'ERRORTOKEN', start: i, end: i + 1 }], end: i + 1, continuation: false };
  }
  if (c === '#') {
    const e = endOfComment(src, i);
    return { toks: [{ type: 'COMMENT', start: i, end: e }], end: e, continuation: false };
  }
  if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(src);
    if (m !== null && m[0].length > 0) {
      const e = i + m[0].length;
      return { toks: [{ type: 'NUMBER', start: i, end: e }], end: e, continuation: false };
    }
  }
  const s = stringStart(src, i);
  if (s !== null) {
    const body = i + s.prefixLen + (s.triple ? 3 : 1);
    const e = s.isF ? scanFString(src, body, s.quote, s.triple, lineOf) : scanPlainString(src, body, s.quote, s.triple, lineOf);
    if (e >= 0) return { toks: [{ type: 'STRING', start: i, end: e }], end: e, continuation: false };
    const toks: Raw[] = [];
    if (s.prefixLen > 0) toks.push({ type: 'NAME', start: i, end: i + s.prefixLen });
    toks.push({ type: 'ERRORTOKEN', start: i + s.prefixLen, end: i + s.prefixLen + 1 });
    return { toks, end: i + s.prefixLen + 1, continuation: false };
  }
  NAME_RE.lastIndex = i;
  const nm = NAME_RE.exec(src);
  if (nm !== null && nm[0].length > 0) {
    const e = i + nm[0].length;
    return { toks: [{ type: 'NAME', start: i, end: e }], end: e, continuation: false };
  }
  const three = src.slice(i, i + 3);
  if (OPS3.has(three)) return { toks: [{ type: 'OP', start: i, end: i + 3 }], end: i + 3, continuation: false };
  const two = src.slice(i, i + 2);
  if (OPS2.has(two)) return { toks: [{ type: 'OP', start: i, end: i + 2 }], end: i + 2, continuation: false };
  if (OPS1.has(c)) return { toks: [{ type: 'OP', start: i, end: i + 1 }], end: i + 1, continuation: false };
  return { toks: [{ type: 'ERRORTOKEN', start: i, end: i + 1 }], end: i + 1, continuation: false };
}

/** Offsets at which each physical line starts (index 0 = line 1). */
export function lineStartOffsets(src: string): number[] {
  const starts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') starts.push(k + 1);
  return starts;
}

function makeLineOf(starts: number[]): (offset: number) => [number, number] {
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return [lo + 1, offset - starts[lo]!];
  };
}

function isOpen(t: string): boolean {
  return t === '(' || t === '[' || t === '{';
}
function isClose(t: string): boolean {
  return t === ')' || t === ']' || t === '}';
}

/** Tokenize a whole module. Throws PyTokenizeError / PyIndentationError like CPython would. */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const n = src.length;
  const starts = lineStartOffsets(src);
  const lineOf = makeLineOf(starts);
  let i = 0;
  let lnum = 1;
  let lineStart = 0;
  let prevEnd = 0;
  let parenlev = 0;
  let continued = false;
  const indents = [0];
  let atLineStart = true;
  let endLine = 1;

  const emit = (type: TokenType, start: number, end: number): void => {
    let endLineNo = lnum;
    let endCol = end - lineStart;
    if (end > start) {
      const [el, ec] = lineOf(end - 1);
      endLineNo = el;
      endCol = ec + 1;
    }
    out.push({ type, text: src.slice(start, end), line: lnum, col: start - lineStart, endLine: endLineNo, endCol, start, end, pre: src.slice(prevEnd, start) });
    prevEnd = end;
    if (endLineNo !== lnum) {
      lnum = endLineNo;
      lineStart = starts[lnum - 1]!;
    }
  };
  const emitEmpty = (type: TokenType, at: number, line: number, col: number, endColOffset: number): void => {
    out.push({ type, text: '', line, col, endLine: line, endCol: col + endColOffset, start: at, end: at, pre: src.slice(prevEnd, at) });
    prevEnd = at;
  };

  for (;;) {
    if (atLineStart) {
      atLineStart = false;
      lineStart = i;
      if (parenlev === 0 && !continued) {
        if (i >= n) {
          endLine = lnum;
          break;
        }
        let column = 0;
        while (i < n) {
          const c = src[i]!;
          if (c === ' ') column++;
          else if (c === '\t') column = (Math.floor(column / TABSIZE) + 1) * TABSIZE;
          else if (c === '\f') column = 0;
          else break;
          i++;
        }
        if (i >= n) {
          // whitespace-only unterminated last line: CPython stops here without a NEWLINE
          endLine = lnum;
          break;
        }
        const c = src[i]!;
        if (c === '#') {
          const e = endOfComment(src, i);
          emit('COMMENT', i, e);
          i = e;
          const nl = newlineLen(src, i);
          if (nl === 0) {
            emitEmpty('NL', i, lnum, i - lineStart, 0);
            emitEmpty('NEWLINE', i, lnum, i - lineStart, 1);
            lnum++;
            endLine = lnum;
            break;
          }
          emit('NL', i, i + nl);
          i += nl;
          lnum++;
          atLineStart = true;
          continue;
        }
        const nl = newlineLen(src, i);
        if (nl > 0) {
          emit('NL', i, i + nl);
          i += nl;
          lnum++;
          atLineStart = true;
          continue;
        }
        const top = indents[indents.length - 1]!;
        if (column > top) {
          indents.push(column);
          emit('INDENT', lineStart, i);
        }
        while (column < indents[indents.length - 1]!) {
          if (!indents.includes(column)) throw new PyIndentationError(lnum, i - lineStart);
          indents.pop();
          emitEmpty('DEDENT', i, lnum, i - lineStart, 0);
        }
      } else {
        if (i >= n) throw new PyTokenizeError('eof_in_statement', lnum, 0, `EOF in multi-line statement (line ${lnum})`);
        continued = false;
      }
    }

    while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\f')) i++;
    if (i >= n) {
      // end of input in the middle of a logical line: CPython appends an empty NEWLINE
      if (parenlev === 0) emitEmpty('NEWLINE', i, lnum, i - lineStart, 1);
      lnum++;
      atLineStart = true;
      continue;
    }

    const scan = scanAt(src, i, lineOf);
    if (scan.continuation) {
      continued = true;
      i = scan.end;
      lnum++;
      atLineStart = true;
      continue;
    }
    for (const raw of scan.toks) {
      if (raw.type === 'NEWLINE') {
        emit(parenlev > 0 ? 'NL' : 'NEWLINE', raw.start, raw.end);
        i = raw.end;
        lnum++;
        atLineStart = true;
        break;
      }
      if (raw.type === 'OP') {
        const t = src.slice(raw.start, raw.end);
        if (isOpen(t)) parenlev++;
        else if (isClose(t) && parenlev > 0) parenlev--;
      }
      emit(raw.type, raw.start, raw.end);
      i = raw.end;
    }
  }

  for (let k = 1; k < indents.length; k++) emitEmpty('DEDENT', n, endLine, 0, 0);
  emitEmpty('ENDMARKER', n, endLine, 0, 0);
  return out;
}

/**
 * Lenient tokenizer for a fragment (one line or a few): no indentation tracking, no
 * INDENT/DEDENT/NEWLINE/ENDMARKER, unbalanced brackets allowed, newlines become NL and an
 * unterminated triple-quoted string becomes an ERRORTOKEN instead of an exception.
 */
export function tokenizeFragment(text: string): Token[] {
  const out: Token[] = [];
  const n = text.length;
  const starts = lineStartOffsets(text);
  const lineOf = makeLineOf(starts);
  let i = 0;
  let prevEnd = 0;
  const emit = (type: TokenType, start: number, end: number): void => {
    const [l, c] = lineOf(start);
    const [el, ec] = end > start ? lineOf(end - 1) : [l, c - 1];
    out.push({ type, text: text.slice(start, end), line: l, col: c, endLine: el, endCol: ec + 1, start, end, pre: text.slice(prevEnd, start) });
    prevEnd = end;
  };
  while (i < n) {
    const c = text[i]!;
    if (c === ' ' || c === '\t' || c === '\f') {
      i++;
      continue;
    }
    let scan: Scan;
    try {
      scan = scanAt(text, i, lineOf);
    } catch (e) {
      if (!(e instanceof PyTokenizeError)) throw e;
      scan = { toks: [{ type: 'ERRORTOKEN', start: i, end: i + 1 }], end: i + 1, continuation: false };
    }
    if (scan.continuation) {
      i = scan.end;
      continue;
    }
    for (const raw of scan.toks) emit(raw.type === 'NEWLINE' ? 'NL' : raw.type, raw.start, raw.end);
    i = scan.end;
  }
  return out;
}

/** Concatenate `pre + text` of every token: the exact source for an unedited token list. */
export function untokenize(tokens: readonly Token[]): string {
  let s = '';
  for (const t of tokens) s += t.pre + t.text;
  return s;
}

/** Tokens that carry code (drops NL, NEWLINE, INDENT, DEDENT, COMMENT, ENDMARKER). */
export function codeTokens(tokens: readonly Token[]): Token[] {
  return tokens.filter((t) => t.type === 'NAME' || t.type === 'NUMBER' || t.type === 'STRING' || t.type === 'OP' || t.type === 'ERRORTOKEN');
}

/**
 * Render a token span on one line: token texts joined by a single space wherever the source
 * had any whitespace or a line break between them (also when the NL token was filtered out).
 */
export function renderTokens(tokens: readonly Token[]): string {
  let s = '';
  tokens.forEach((t, k) => {
    const prev = tokens[k - 1];
    if (prev !== undefined && (t.pre.length > 0 || t.line !== prev.endLine)) s += ' ';
    s += t.text;
  });
  return s;
}
