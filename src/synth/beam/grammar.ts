/**
 * Grammar filter: which tokens may follow a prefix. Code owns syntax and position; Jev owns
 * content (probe-token-synthesis.md §7.3: 58/67 teacher-forced misses were "right token,
 * wrong position", and offering only legal tokens added +4 lines and cut cost 43 %).
 *
 * The filter is a conservative superset of legal Python: it never excludes a legal
 * continuation for the shapes fix lines take (checked at 425/426 measured positions; the one
 * exclusion is a line ending in `min(`, a multi-line fragment). It tracks bracket depth, the
 * statement kind of the line being replaced, unary versus binary operators, `lambda` colons
 * and header colons, and lets END_OF_LINE through only when brackets balance and the
 * statement is complete.
 */
import { CLOSERS, OPENERS, isValueTok, toks } from './tokens.js';
import type { Tok } from './tokens.js';

/** Sentinel offered as `end_of_line`. */
export const END = '<END>';
export type NextToken = Tok | typeof END;

/**
 * Kind of the line at the site. A compound header (`if …:`) must stay a header (its body
 * follows), a simple statement must stay simple (no body follows), an inserted line is
 * simple. `unknown` is the unconstrained measured behaviour.
 */
export type LineKind = 'header' | 'simple' | 'unknown';

const COMPOUND_KW: ReadonlySet<string> = new Set(['if', 'elif', 'else', 'for', 'while', 'with', 'try', 'except', 'finally', 'def', 'class']);
/** Compound keywords that can open a one-line statement (`if x: return y`) without a block. */
const ONE_LINER_KW: ReadonlySet<string> = new Set(['if', 'while', 'for', 'with']);
const SIMPLE_STMT_KW: ReadonlySet<string> = new Set(['return', 'yield', 'pass', 'break', 'continue', 'del', 'assert', 'raise', 'import', 'from', 'global', 'nonlocal', 'await']);
const VALUE_START_KW: ReadonlySet<string> = new Set(['not', 'lambda', 'await']);
const AFTER_VALUE_KW: ReadonlySet<string> = new Set(['and', 'or', 'not', 'in', 'is', 'if', 'else', 'for', 'as']);
/** Keywords after which a value expression starts. */
const VALUE_AFTER_KW: ReadonlySet<string> = new Set(['in', 'and', 'or', 'if', 'while', 'elif', 'return', 'yield', 'assert', 'raise', 'del', 'await', 'with', 'not', 'is', 'else', 'except']);
/** Keywords after which a bare name (target, module, alias) must come. */
const NAME_AFTER_KW: ReadonlySet<string> = new Set(['for', 'lambda', 'global', 'nonlocal', 'import', 'from', 'as', 'def', 'class']);
const END_AFTER_KW: ReadonlySet<string> = new Set(['return', 'yield', 'pass', 'break', 'continue', 'raise']);

export interface PrefixState {
  /** Expected closers, innermost last. */
  stack: string[];
  prev: Tok | undefined;
  prevPrev: Tok | undefined;
  first: Tok | undefined;
  /** A depth-0 colon that ends a compound header has been emitted. */
  headerColon: boolean;
  /** Bracket depths of `lambda`s whose body colon has not been emitted yet. */
  lambdaDepths: number[];
  /** Some lambda is still waiting for its colon (the line cannot end). */
  lambdaOpen: boolean;
  /** A lambda at the current depth is waiting for its colon (the next depth-level colon is its). */
  lambdaHere: boolean;
}

export function analysePrefix(prefix: readonly Tok[]): PrefixState {
  const stack: string[] = [];
  const lambdaDepths: number[] = [];
  let headerColon = false;
  const first = prefix[0];
  for (const t of prefix) {
    const closer = OPENERS[t.text];
    if (closer !== undefined) {
      stack.push(closer);
      continue;
    }
    if (CLOSERS.has(t.text)) {
      if (stack[stack.length - 1] === t.text) stack.pop();
      // a lambda left unclosed inside the bracket can no longer take a colon
      while (lambdaDepths.length > 0 && lambdaDepths[lambdaDepths.length - 1]! > stack.length) lambdaDepths.pop();
      continue;
    }
    if (t.cls === 'keyword' && t.text === 'lambda') lambdaDepths.push(stack.length);
    else if (t.text === ':') {
      if (lambdaDepths[lambdaDepths.length - 1] === stack.length) lambdaDepths.pop();
      else if (stack.length === 0 && first !== undefined && first.cls === 'keyword' && COMPOUND_KW.has(first.text)) headerColon = true;
    }
  }
  return {
    stack,
    prev: prefix[prefix.length - 1],
    prevPrev: prefix[prefix.length - 2],
    first,
    headerColon,
    lambdaDepths,
    lambdaOpen: lambdaDepths.length > 0,
    lambdaHere: lambdaDepths[lambdaDepths.length - 1] === stack.length,
  };
}

/** `-`/`~` that negates rather than subtracts: nothing that can end an operand precedes it. */
function isUnaryAt(prev: Tok | undefined, before: Tok | undefined): boolean {
  return prev !== undefined && (prev.text === '-' || prev.text === '~') && !isValueTok(before);
}

/** Line kind for a site's current line ('' means an insert: the new line must be simple). */
export function lineKindOf(currentLine: string): LineKind {
  const all = toks(currentLine);
  // `async def` / `async for` / `async with` headers are classified by the keyword after `async`
  const ts = all[0]?.text === 'async' ? all.slice(1) : all;
  const first = ts[0];
  if (first === undefined) return 'simple';
  if (first.cls === 'keyword' && COMPOUND_KW.has(first.text)) {
    // one-liner compound statements (`if x: return`) are simple lines: no body follows
    const st = analysePrefix(ts);
    return st.headerColon && ts[ts.length - 1]!.text === ':' ? 'header' : 'simple';
  }
  if (first.text === '@') return 'unknown';
  return 'simple';
}

/**
 * Predicate over the next token (or END) given the prefix and the line kind. Tokens marked
 * `attributeOnly` by the vocabulary are legal only right after a `.`.
 */
export function legalNext(prefix: readonly Tok[], kind: LineKind = 'unknown'): (t: NextToken, attributeOnly?: boolean) => boolean {
  const st = analysePrefix(prefix);
  const { prev, prevPrev, first } = st;
  const depth = st.stack.length;
  const close = st.stack[st.stack.length - 1];
  const inner = depth > 0 ? Object.keys(OPENERS).find((o) => OPENERS[o] === close) : undefined;

  const valueStart = (t: Tok, allowStar: boolean, allowUnary: boolean): boolean => {
    if (t.cls === 'identifier' || t.cls === 'number' || t.cls === 'string' || t.cls === 'literal') return true;
    if (t.text === '(' || t.text === '[' || t.text === '{') return true;
    if ((t.text === '-' || t.text === '~') && allowUnary) return true;
    if (t.text === '*' && allowStar) return true;
    return t.cls === 'keyword' && VALUE_START_KW.has(t.text);
  };
  const statementStart = (t: Tok): boolean => {
    if (kind === 'header') return t.cls === 'keyword' && COMPOUND_KW.has(t.text);
    if (valueStart(t, true, true)) return true;
    if (t.cls !== 'keyword') return false;
    if (SIMPLE_STMT_KW.has(t.text)) return true;
    if (kind === 'simple') return ONE_LINER_KW.has(t.text);
    return COMPOUND_KW.has(t.text);
  };

  return (t, attributeOnly = false) => {
    if (t === END) {
      if (prev === undefined || depth > 0 || st.lambdaOpen) return false;
      if (kind === 'header') return st.headerColon && prev.text === ':';
      if (prev.text === ':') return kind === 'unknown' && st.headerColon;
      if (isValueTok(prev)) return !(first !== undefined && first.cls === 'keyword' && COMPOUND_KW.has(first.text) && !st.headerColon && kind !== 'unknown');
      return prev.cls === 'keyword' && END_AFTER_KW.has(prev.text);
    }
    if (attributeOnly && (prev === undefined || prev.text !== '.')) return false;
    if (prev === undefined) return statementStart(t);
    // a header that has its colon is complete; only END may follow (kind header) or a one-liner body (others)
    if (st.headerColon && prev.text === ':' && depth === 0) {
      if (kind === 'header') return false;
      return valueStart(t, false, true) || (t.cls === 'keyword' && SIMPLE_STMT_KW.has(t.text));
    }
    if (CLOSERS.has(t.text)) {
      if (t.text !== close) return false;
      return isValueTok(prev) || prev.text === ':' || prev.text in OPENERS || prev.text === ',';
    }
    if (prev.text === '.') return t.cls === 'identifier';
    if (isValueTok(prev)) {
      if (t.cls === 'operator') return true;
      if (t.text === '(' || t.text === '[') return prev.cls === 'identifier' || prev.cls === 'string' || prev.text === ')' || prev.text === ']';
      if (t.text === ',' || t.text === '.') return true;
      if (t.text === ':') {
        if (st.lambdaHere) return true;
        if (depth > 0) return inner === '[' || inner === '{';
        return (first !== undefined && first.cls === 'keyword' && COMPOUND_KW.has(first.text) && !st.headerColon) || prefix.length === 1;
      }
      return t.cls === 'keyword' && AFTER_VALUE_KW.has(t.text);
    }
    if (prev.cls === 'operator') {
      // no two operators in a row; a unary minus may follow a binary operator but not another unary
      const unary = isUnaryAt(prev, prevPrev);
      return valueStart(t, false, !unary);
    }
    if (prev.text in OPENERS || prev.text === ',') {
      if (valueStart(t, true, true)) return true;
      if (t.text === '**') return inner === '(' || inner === '{';
      if (t.text === ':') return inner === '[';
      return false;
    }
    if (prev.text === ':') {
      if (depth > 0) return valueStart(t, false, true) || (inner === '[' && t.text === ':');
      // lambda body or annotation value
      return valueStart(t, false, true) || (t.cls === 'keyword' && (t.text === 'not' || t.text === 'lambda'));
    }
    if (prev.cls === 'keyword') {
      if (NAME_AFTER_KW.has(prev.text)) {
        if (t.cls === 'identifier') return true;
        if (prev.text === 'for' || prev.text === 'def') return t.text === '(';
        if (prev.text === 'lambda') return t.text === ':' || t.text === '*';
        if (prev.text === 'from') return t.text === '.';
        return false;
      }
      switch (prev.text) {
        case 'else':
          return t.text === ':' || valueStart(t, false, true);
        case 'not':
          return valueStart(t, false, true) || t.text === 'in';
        case 'is':
          return valueStart(t, false, true) || t.text === 'not';
        case 'try':
        case 'finally':
          return t.text === ':';
        case 'except':
          return t.text === ':' || valueStart(t, false, true);
        case 'pass':
        case 'break':
        case 'continue':
          return false;
        default:
          if (VALUE_AFTER_KW.has(prev.text)) return valueStart(t, false, true) || (t.cls === 'keyword' && (t.text === 'not' || t.text === 'lambda'));
          return valueStart(t, false, true);
      }
    }
    return true;
  };
}
