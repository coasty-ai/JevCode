/**
 * Token model for the mutation operators: a mutable copy of the tokenizer's code tokens for
 * one physical line, with bracket matching, "primary" (operand) span detection, binary
 * operator detection and a renderer that keeps the original spacing. Everything works on
 * `tokenizeFragment` output so continuation lines of a multi-line statement (unbalanced
 * brackets) mutate like any other line.
 */
import { isKeyword, tokenizeFragment } from '../py/tokenize.js';
import type { Token, TokenType } from '../py/tokenize.js';

/** A token the operators may edit: `pre` is the whitespace that precedes it when rendered. */
export interface Tok {
  type: TokenType;
  text: string;
  pre: string;
}

export const RELATIONAL_OPS: readonly string[] = ['<', '<=', '>', '>=', '==', '!='];
export const ARITH_OPS: readonly string[] = ['+', '-', '*', '/', '//', '%', '**'];
export const BITWISE_OPS: readonly string[] = ['&', '|', '^'];
export const AUG_OPS: readonly string[] = ['+=', '-=', '*=', '/=', '//=', '%=', '**=', '&=', '|=', '^='];
/** Keyword literals that operators treat as substitutable values rather than syntax. */
export const VALUE_KEYWORDS: ReadonlySet<string> = new Set(['True', 'False', 'None']);

export function isOpen(t: Tok | undefined): boolean {
  return t !== undefined && t.type === 'OP' && (t.text === '(' || t.text === '[' || t.text === '{');
}
export function isClose(t: Tok | undefined): boolean {
  return t !== undefined && t.type === 'OP' && (t.text === ')' || t.text === ']' || t.text === '}');
}
export function isOp(t: Tok | undefined, text: string): boolean {
  return t !== undefined && t.type === 'OP' && t.text === text;
}
export function isKw(t: Tok | undefined, text: string): boolean {
  return t !== undefined && t.type === 'NAME' && t.text === text;
}
/** A plain identifier (not a keyword); `True`/`False`/`None` count when `allowValueKeywords`. */
export function isIdent(t: Tok | undefined, allowValueKeywords = false): boolean {
  if (t === undefined || t.type !== 'NAME') return false;
  if (!isKeyword(t.text)) return true;
  return allowValueKeywords && VALUE_KEYWORDS.has(t.text);
}
/** A token that can end an operand: identifier, literal or closing bracket. */
export function endsOperand(t: Tok | undefined): boolean {
  return t !== undefined && (isIdent(t, true) || t.type === 'NUMBER' || t.type === 'STRING' || isClose(t));
}

/** Copy the tokenizer output into editable tokens; comments and layout tokens are dropped, whitespace collapsed. */
export function toToks(tokens: readonly Token[]): Tok[] {
  const out: Tok[] = [];
  for (const t of tokens) {
    if (t.type !== 'NAME' && t.type !== 'NUMBER' && t.type !== 'STRING' && t.type !== 'OP' && t.type !== 'ERRORTOKEN') continue;
    out.push({ type: t.type, text: t.text, pre: t.pre.length > 0 ? ' ' : '' });
  }
  return out;
}

/** Tokenize one line (leniently) into editable tokens. */
export function lineToks(line: string): Tok[] {
  return toToks(tokenizeFragment(line));
}

/**
 * Tokens for a code fragment written by an operator (`' + 1'`, `'max(0, '`); the first token
 * takes `leadingPre` so the caller controls the spacing at the join.
 */
export function frag(text: string, leadingPre = ''): Tok[] {
  const toks = lineToks(text);
  const first = toks[0];
  if (first !== undefined) first.pre = leadingPre;
  return toks;
}

/** Render tokens back to one line (no leading whitespace). */
export function render(toks: readonly Tok[]): string {
  let s = '';
  toks.forEach((t, k) => {
    s += (k === 0 ? '' : t.pre) + t.text;
  });
  return s;
}

/** Dedupe key: the token texts alone, so `a+1` and `a + 1` are the same candidate. */
export function tokenKey(toks: readonly Tok[]): string {
  return toks.map((t) => t.text).join('\u0001');
}

export function clone(toks: readonly Tok[]): Tok[] {
  return toks.map((t) => ({ ...t }));
}

/** Replace `toks[from, to)` with `repl`; the replacement's first token inherits the old span's `pre` unless it sets its own. */
export function splice(toks: readonly Tok[], from: number, to: number, repl: readonly Tok[], keepPre = true): Tok[] {
  const out = clone(toks);
  const inserted = clone(repl);
  const old = toks[from];
  if (keepPre && inserted[0] !== undefined && old !== undefined) inserted[0].pre = old.pre;
  out.splice(from, to - from, ...inserted);
  return out;
}

/** Index of the bracket matching the open bracket at `open`, or -1 when the line does not close it. */
export function matchClose(toks: readonly Tok[], open: number): number {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    const t = toks[k];
    if (isOpen(t)) depth++;
    else if (isClose(t)) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Index of the bracket matching the close bracket at `close`, or -1. */
export function matchOpen(toks: readonly Tok[], close: number): number {
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    const t = toks[k];
    if (isClose(t)) depth++;
    else if (isOpen(t)) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Bracket depth before token `i` (unmatched closes on a continuation line count as negative depth). */
export function depthBefore(toks: readonly Tok[], i: number): number {
  let d = 0;
  for (let k = 0; k < i; k++) {
    const t = toks[k];
    if (isOpen(t)) d++;
    else if (isClose(t)) d--;
  }
  return d;
}

/** Split `toks[from, to)` at bracket-depth-0 occurrences of an operator into [start, end) ranges. */
export function splitTopLevel(toks: readonly Tok[], from: number, to: number, sep: string): [number, number][] {
  const parts: [number, number][] = [];
  let depth = 0;
  let start = from;
  for (let k = from; k < to; k++) {
    const t = toks[k];
    if (isOpen(t)) depth++;
    else if (isClose(t)) depth--;
    else if (depth === 0 && isOp(t, sep)) {
      parts.push([start, k]);
      start = k + 1;
    }
  }
  parts.push([start, to]);
  return parts;
}

/**
 * Start of the primary (operand with its trailers) that ends just before `end`, or -1.
 * `a.b[i](x)` before `end` gives the index of `a`; a leading unary minus is included.
 */
export function primaryStart(toks: readonly Tok[], end: number): number {
  let j = end - 1;
  if (j < 0) return -1;
  for (;;) {
    const t = toks[j];
    if (t === undefined) return -1;
    if (isClose(t)) {
      const open = matchOpen(toks, j);
      if (open < 0) return -1;
      j = open;
      const p = toks[j - 1];
      // `name(...)`, `name[...]`, `x[i](...)`: the group is a trailer of what precedes it
      if (isIdent(p) || isClose(p)) {
        j -= 1;
        continue;
      }
      break;
    }
    if (isIdent(t, true) || t.type === 'NUMBER' || t.type === 'STRING') {
      const dot = toks[j - 1];
      const owner = toks[j - 2];
      if (isOp(dot, '.') && (isIdent(owner) || isClose(owner))) {
        j -= 2;
        continue;
      }
      break;
    }
    return -1;
  }
  if (isOp(toks[j - 1], '-') && !endsOperand(toks[j - 2])) j -= 1;
  return j;
}

/** End (exclusive) of the primary starting at `start`, or -1 when no operand starts there. */
export function primaryEnd(toks: readonly Tok[], start: number): number {
  let j = start;
  if (isOp(toks[j], '-') && !endsOperand(toks[j - 1])) j++;
  const t = toks[j];
  if (t === undefined) return -1;
  if (isOpen(t)) {
    const close = matchClose(toks, j);
    if (close < 0) return -1;
    j = close + 1;
  } else if (isIdent(t, true) || t.type === 'NUMBER' || t.type === 'STRING') {
    j += 1;
  } else return -1;
  for (;;) {
    const n = toks[j];
    if (isOp(n, '.') && isIdent(toks[j + 1])) {
      j += 2;
      continue;
    }
    if (n !== undefined && isOpen(n) && (n.text === '(' || n.text === '[')) {
      const close = matchClose(toks, j);
      if (close < 0) return -1;
      j = close + 1;
      continue;
    }
    return j;
  }
}

export interface BinOp {
  /** token range of the operator itself (`not in` spans two tokens) */
  start: number;
  end: number;
  text: string;
}

/** `for x in xs` and comprehension `for ... in`: the `in` at `i` belongs to a `for`, not a comparison. */
function isForIn(toks: readonly Tok[], i: number): boolean {
  let depth = 0;
  for (let k = i - 1; k >= 0; k--) {
    const t = toks[k];
    if (isClose(t)) depth++;
    else if (isOpen(t)) {
      if (depth === 0) return false;
      depth--;
    } else if (depth === 0 && t !== undefined && t.type === 'NAME') {
      if (t.text === 'for') return true;
      if (t.text === 'in' || t.text === 'if' || t.text === 'and' || t.text === 'or' || t.text === 'not') return false;
    }
  }
  return false;
}

/** Is the OP token at `i` in binary position (has a left operand)? Excludes unary `-`, star-args, `**kwargs`. */
export function isBinaryPosition(toks: readonly Tok[], i: number): boolean {
  return endsOperand(toks[i - 1]);
}

/** Binary operators of the given set on the line, in source order (`in`, `not in`, `is`, `is not`, `and`, `or` included when asked). */
export function binaryOps(toks: readonly Tok[], ops: ReadonlySet<string>): BinOp[] {
  const out: BinOp[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.type === 'OP') {
      if (!ops.has(t.text) || !isBinaryPosition(toks, i)) continue;
      // `x = f(a=1)`: `=` and kwarg `=` are never binary operators here
      if (t.text === '=') continue;
      out.push({ start: i, end: i + 1, text: t.text });
      continue;
    }
    if (t.type !== 'NAME') continue;
    if (t.text === 'not' && isKw(toks[i + 1], 'in') && endsOperand(toks[i - 1])) {
      if (ops.has('not in')) out.push({ start: i, end: i + 2, text: 'not in' });
      i++;
      continue;
    }
    if (t.text === 'in' && !isForIn(toks, i) && endsOperand(toks[i - 1])) {
      if (ops.has('in')) out.push({ start: i, end: i + 1, text: 'in' });
      continue;
    }
    if (t.text === 'is' && endsOperand(toks[i - 1])) {
      if (isKw(toks[i + 1], 'not')) {
        if (ops.has('is not')) out.push({ start: i, end: i + 2, text: 'is not' });
        i++;
      } else if (ops.has('is')) out.push({ start: i, end: i + 1, text: 'is' });
      continue;
    }
    if ((t.text === 'and' || t.text === 'or') && ops.has(t.text)) out.push({ start: i, end: i + 1, text: t.text });
  }
  return out;
}

/** Unmatched-bracket signature of a line: closes with no open before them, then opens never closed. */
export function bracketSignature(toks: readonly Tok[]): string {
  const stack: string[] = [];
  let unmatchedCloses = '';
  for (const t of toks) {
    if (isOpen(t)) stack.push(t.text);
    else if (isClose(t)) {
      const expected = t.text === ')' ? '(' : t.text === ']' ? '[' : '{';
      if (stack.length > 0 && stack[stack.length - 1] === expected) stack.pop();
      else if (stack.length === 0) unmatchedCloses += t.text;
      else return '!'; // mismatched pair inside the line: never valid
    }
  }
  return unmatchedCloses + '|' + stack.join('');
}

/** Are the brackets of `toks[from, to)` balanced on their own (a complete expression)? */
export function isBalanced(toks: readonly Tok[], from: number, to: number): boolean {
  return bracketSignature(toks.slice(from, to)) === '|';
}
