/**
 * Argument-order route (pure, no Jev): permutations of call arguments and subscript indices
 * and swaps of the operands of non-commutative binary operators on the current line.
 * Argument order is a position judgement, Jev's measured weak spot (probe §7.3: the slot and
 * edit routes failed on `rpn_eval`, `next_permutation`, `shortest_path_lengths` for exactly
 * this reason), so code enumerates the orders and tests decide.
 */
import { sha12 } from '../../core/hash.js';
import type { Candidate, Site } from '../types.js';
import { CLOSERS, OPENERS, detokenize, isValueTok, sameTokens, toks } from './tokens.js';
import type { Tok } from './tokens.js';

/** All permutations up to this many arguments; longer lists get adjacent swaps only. */
export const FULL_PERMUTATION_MAX_ARGS = 4;
/** Operators whose operand order changes the value (commutative ones would be no-ops). */
export const NON_COMMUTATIVE: ReadonlySet<string> = new Set(['-', '/', '//', '%', '**', '<', '<=', '>', '>=', '<<', '>>']);

function matchClose(ts: readonly Tok[], open: number): number {
  let depth = 0;
  for (let k = open; k < ts.length; k++) {
    const t = ts[k]!;
    if (t.text in OPENERS) depth++;
    else if (CLOSERS.has(t.text)) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

function matchOpen(ts: readonly Tok[], close: number): number {
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    const t = ts[k]!;
    if (CLOSERS.has(t.text)) depth++;
    else if (t.text in OPENERS) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Index ranges [from, to) of the depth-0 comma-separated parts of ts[from..to). */
function splitParts(ts: readonly Tok[], from: number, to: number): [number, number][] {
  const parts: [number, number][] = [];
  let depth = 0;
  let start = from;
  for (let k = from; k < to; k++) {
    const t = ts[k]!;
    if (t.text in OPENERS) depth++;
    else if (CLOSERS.has(t.text)) depth--;
    else if (depth === 0 && t.text === ',') {
      parts.push([start, k]);
      start = k + 1;
    }
  }
  parts.push([start, to]);
  return parts;
}

function hasTopLevel(ts: readonly Tok[], from: number, to: number, texts: ReadonlySet<string>): boolean {
  let depth = 0;
  for (let k = from; k < to; k++) {
    const t = ts[k]!;
    if (t.text in OPENERS) depth++;
    else if (CLOSERS.has(t.text)) depth--;
    else if (depth === 0 && texts.has(t.text)) return true;
  }
  return false;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((x, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

/** Orders to try for n arguments: all of them for small n, adjacent swaps otherwise. Identity excluded. */
export function argumentOrders(n: number): number[][] {
  const identity = Array.from({ length: n }, (_, i) => i);
  if (n < 2) return [];
  if (n <= FULL_PERMUTATION_MAX_ARGS) return permutations(identity).filter((p) => p.some((v, i) => v !== i));
  const out: number[][] = [];
  for (let i = 0; i + 1 < n; i++) {
    const p = [...identity];
    [p[i], p[i + 1]] = [p[i + 1]!, p[i]!];
    out.push(p);
  }
  return out;
}

/** Start index of the primary (name, literal, call/subscript chain, parenthesised group) ending at `end`. */
export function primaryStart(ts: readonly Tok[], end: number): number | null {
  const t = ts[end];
  if (t === undefined) return null;
  let j = end;
  if (CLOSERS.has(t.text)) {
    j = matchOpen(ts, end);
    if (j < 0) return null;
  } else if (!isValueTok(t)) return null;
  for (;;) {
    const p = ts[j - 1];
    if (p === undefined) break;
    if (ts[j]!.text in OPENERS && (p.cls === 'identifier' || CLOSERS.has(p.text))) {
      j = CLOSERS.has(p.text) ? matchOpen(ts, j - 1) : j - 1;
      if (j < 0) return null;
      continue;
    }
    if (p.text === '.') {
      // `.attr` after a name or after a call/subscript result (`f(a)[0].b`)
      const receiver = ts[j - 2];
      if (receiver === undefined) break;
      if (receiver.cls === 'identifier') {
        j -= 2;
        continue;
      }
      if (CLOSERS.has(receiver.text)) {
        j = matchOpen(ts, j - 2);
        if (j < 0) return null;
        continue;
      }
    }
    break;
  }
  return j;
}

/** End index of the primary starting at `start` (with a leading unary `-`/`~`/`not` included). */
export function primaryEnd(ts: readonly Tok[], start: number): number | null {
  let j = start;
  const t0 = ts[j];
  if (t0 === undefined) return null;
  if (t0.text === '-' || t0.text === '~' || (t0.cls === 'keyword' && t0.text === 'not')) j++;
  const t = ts[j];
  if (t === undefined) return null;
  if (t.text in OPENERS) {
    j = matchClose(ts, j);
    if (j < 0) return null;
  } else if (!isValueTok(t) || CLOSERS.has(t.text)) return null;
  for (;;) {
    const n = ts[j + 1];
    if (n === undefined) break;
    if (n.text === '.' && ts[j + 2]?.cls === 'identifier') {
      j += 2;
      continue;
    }
    if (n.text === '(' || n.text === '[') {
      const c = matchClose(ts, j + 1);
      if (c < 0) return null;
      j = c;
      continue;
    }
    break;
  }
  return j;
}

export interface Permutation {
  toks: Tok[];
  op: 'argument_permutation' | 'subscript_permutation' | 'operand_swap';
}

/** Every reordering of the line's call arguments, subscript indices and non-commutative operands. */
export function permutationsOf(line: string): Permutation[] {
  const ts = toks(line);
  const out: Permutation[] = [];
  const kwargs: ReadonlySet<string> = new Set(['=']);
  const slice: ReadonlySet<string> = new Set([':']);

  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!;
    if (t.text !== '(' && t.text !== '[') continue;
    const prev = ts[i - 1];
    if (prev === undefined || !(prev.cls === 'identifier' || CLOSERS.has(prev.text) || (t.text === '[' && prev.cls === 'string'))) continue;
    const close = matchClose(ts, i);
    if (close < 0) continue;
    const parts = splitParts(ts, i + 1, close);
    if (parts.length < 2 || parts.some(([a, b]) => a === b)) continue;
    if (parts.some(([a, b]) => ts[a]!.text === '*' || ts[a]!.text === '**' || hasTopLevel(ts, a, b, kwargs) || hasTopLevel(ts, a, b, slice))) continue;
    for (const order of argumentOrders(parts.length)) {
      const inner: Tok[] = [];
      order.forEach((idx, k) => {
        const [a, b] = parts[idx]!;
        inner.push(...ts.slice(a, b));
        if (k < order.length - 1) inner.push({ text: ',', cls: 'punct' });
      });
      out.push({ toks: [...ts.slice(0, i + 1), ...inner, ...ts.slice(close)], op: t.text === '(' ? 'argument_permutation' : 'subscript_permutation' });
    }
  }

  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!;
    let opLen = 0;
    if (t.cls === 'operator' && NON_COMMUTATIVE.has(t.text)) opLen = 1;
    else if (t.cls === 'keyword' && t.text === 'in' && ts[i - 1]?.text !== 'not' && ts[i - 1]?.text !== 'for') opLen = 1;
    else if (t.cls === 'keyword' && t.text === 'not' && ts[i + 1]?.text === 'in') opLen = 2;
    if (opLen === 0) continue;
    // `in` after a `for` target is a loop clause, not a comparison
    if (t.text === 'in' || t.text === 'not') {
      let k = i - 1;
      while (k >= 0 && ts[k]!.text !== 'for') k--;
      if (k >= 0 && !hasTopLevel(ts, k, i, new Set(['in']))) continue;
    }
    const l = primaryStart(ts, i - 1);
    const r = primaryEnd(ts, i + opLen);
    if (l === null || r === null) continue;
    // an operand that is itself preceded by a unary minus stays with its sign
    const swapped: Tok[] = [...ts.slice(0, l), ...ts.slice(i + opLen, r + 1), ...ts.slice(i, i + opLen), ...ts.slice(l, i), ...ts.slice(r + 1)];
    out.push({ toks: swapped, op: 'operand_swap' });
  }
  return out;
}

/** Candidates for a replace site: distinct reorderings that differ from the current line, capped. */
export function permutationCandidates(site: Site, cap: number): Candidate[] {
  if (site.kind !== 'replace' || cap <= 0) return [];
  const current = toks(site.currentLine);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const p of permutationsOf(site.currentLine)) {
    if (sameTokens(p.toks, current)) continue;
    const body = detokenize(p.toks);
    if (seen.has(body)) continue;
    seen.add(body);
    const text = site.indent + body;
    out.push({
      id: `token_beam:${p.op}:${sha12(`${site.file.path}:${site.line}:${text}`)}`,
      site,
      text,
      source: 'token_beam',
      op: p.op,
      // ordering prior only: two-argument swaps are the measured common case (gcd, rpn_eval)
      prior: p.op === 'operand_swap' ? 0.4 : 0.5,
    });
    if (out.length >= cap) break;
  }
  return out;
}
