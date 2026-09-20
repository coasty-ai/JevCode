/**
 * Mutation-operator candidate source for the Jev-only synthesizer (docs/JEV-ONLY.md). Code
 * proposes: the current line of a site is tokenized (`py/tokenize`), every operator in the
 * table produces token-level variants, and the variants are rendered, filtered for shape
 * (bracket/quote balance, adjacency sanity), de-duplicated, ordered deterministically and
 * capped. Nothing here calls Jev or Python; the ranker decides and the tests verify.
 *
 * Measured basis: experiments/results/probe-selection.md ("Operator library": gold fix is a
 * first-order mutant on 38/40 QuixBugs lines) and probe-donor-and-templates.md item 2
 * (Jaccard(fix, buggy) >= 0.5 for 33/36 replacements: the buggy line is the best donor).
 */
import type { Candidate, CandidateSource, EnumerateOptions, Site } from '../types.js';
import { buildContext } from './context.js';
import type { MutationContext } from './context.js';
import { OPERATORS, OPERATOR_NAMES, OPERATOR_PRIORS, SECOND_ORDER_OPERATORS, lineInfo } from './operators.js';
import type { OperatorName } from './operators.js';
import { ARITH_OPS, AUG_OPS, BITWISE_OPS, RELATIONAL_OPS, bracketSignature, endsOperand, isClose, isIdent, isOp, isOpen, lineToks, render, tokenKey } from './tokens.js';
import type { Tok } from './tokens.js';

export { OPERATORS, OPERATOR_NAMES, OPERATOR_PRIORS, SECOND_ORDER_OPERATORS, applyOperator, lineInfo, primaries, statementTemplates } from './operators.js';
export type { OperatorName, LineInfo, Primary } from './operators.js';
export { buildContext, familyOf, sharesStem, substitutesFor } from './context.js';
export type { MutationContext } from './context.js';
export { lineToks, render, tokenKey } from './tokens.js';
export type { Tok } from './tokens.js';

/** Below this many first-order candidates the cheap operators are composed pairwise. */
export const SECOND_ORDER_THRESHOLD = 40;
/** Second-order mutants added at most (they are many and rarely the fix; the cap still applies). */
export const SECOND_ORDER_LIMIT = 100;
const SECOND_ORDER_PRIOR = 0.3;

export interface Mutant {
  toks: Tok[];
  /** operator name; `a+b` for a second-order composition */
  op: string;
  prior: number;
}

// ---------------------------------------------------------------------------------------
// Shape filter: cheap, token-level, no Python process per candidate
// ---------------------------------------------------------------------------------------

const BINARYISH: ReadonlySet<string> = new Set([...ARITH_OPS, ...RELATIONAL_OPS, ...BITWISE_OPS, ...AUG_OPS, ',', '=', '<<', '>>', '@', '->', ':=']);
/** Operators that cannot follow another operator (unlike unary `-`, `~`, `*`/`**` in star-args, `not`). */
const NEVER_AFTER_OP: ReadonlySet<string> = new Set([...RELATIONAL_OPS, ...AUG_OPS, '=', ',', '/', '//', '%', '.', '+', '&', '|', '^', '<<', '>>', '@', '->', ':=']);
const OPERAND_KEYWORDS: ReadonlySet<string> = new Set(['not', 'and', 'or', 'in', 'is', 'if', 'elif', 'while', 'return', 'yield', 'assert', 'for', 'del', 'raise', 'await']);

function isOperandToken(t: Tok): boolean {
  return isIdent(t, true) || t.type === 'NUMBER' || t.type === 'STRING';
}

/**
 * Does the candidate have the shape of a line that could parse in place of `base`? Bracket and
 * quote balance must match the base line (a continuation line legitimately ends with `(`),
 * two operands may not touch, two binary operators may not touch, an empty subscript is out,
 * and a line that used to end in an operand/colon must still do so.
 */
export function looksSyntactic(cand: readonly Tok[], base: readonly Tok[]): boolean {
  if (cand.length === 0) return false;
  const sig = bracketSignature(cand);
  if (sig === '!' || sig !== bracketSignature(base)) return false;
  if (cand.some((t) => t.type === 'ERRORTOKEN') && !base.some((t) => t.type === 'ERRORTOKEN')) return false;
  for (let k = 1; k < cand.length; k++) {
    const a = cand[k - 1]!;
    const b = cand[k]!;
    if (isOperandToken(a) && isOperandToken(b) && !(a.type === 'STRING' && b.type === 'STRING')) return false;
    if (a.type === 'OP' && (BINARYISH.has(a.text) || isOpen(a)) && b.type === 'OP' && NEVER_AFTER_OP.has(b.text)) return false;
    if (a.type === 'OP' && BINARYISH.has(a.text) && isClose(b) && a.text !== ',') return false;
    if (isOp(a, '[') && isOp(b, ']') && k >= 2 && endsOperand(cand[k - 2])) return false;
    if (a.type === 'NAME' && OPERAND_KEYWORDS.has(a.text) && ((b.type === 'OP' && NEVER_AFTER_OP.has(b.text)) || isClose(b) || isOp(b, ':'))) return false;
    if (isOp(a, '.') && !isIdent(b)) return false;
  }
  const last = cand[cand.length - 1]!;
  const baseLast = base[base.length - 1];
  if (baseLast !== undefined) {
    const baseEndsClean = endsOperand(baseLast) || isOp(baseLast, ':');
    const candEndsClean = endsOperand(last) || isOp(last, ':');
    if (baseEndsClean && !candEndsClean) return false;
    if (isOp(baseLast, ':') && !isOp(last, ':')) return false;
  }
  if (last.type === 'NAME' && OPERAND_KEYWORDS.has(last.text) && last.text !== 'return' && last.text !== 'yield') return false;
  return true;
}

// ---------------------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------------------

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** First-order mutants of a token line, one entry per distinct token sequence (highest-prior operator wins). */
export function firstOrderMutants(toks: readonly Tok[], ctx: MutationContext, ops: readonly OperatorName[] = OPERATOR_NAMES): Mutant[] {
  const info = lineInfo(toks);
  const baseKey = tokenKey(toks);
  const byKey = new Map<string, Mutant>();
  for (const op of ops) {
    const prior = OPERATOR_PRIORS[op];
    for (const cand of OPERATORS[op](info, ctx)) {
      const key = tokenKey(cand);
      if (key === baseKey || key === '') continue;
      if (!looksSyntactic(cand, toks)) continue;
      const prev = byKey.get(key);
      if (prev === undefined || prev.prior < prior) byKey.set(key, { toks: cand, op, prior });
    }
  }
  return [...byKey.values()];
}

/** Compose the cheap operators on each first-order mutant; skips anything already present. */
export function secondOrderMutants(base: readonly Tok[], first: readonly Mutant[], ctx: MutationContext, limit: number): Mutant[] {
  const seen = new Set<string>([tokenKey(base), ...first.map((m) => tokenKey(m.toks))]);
  const out: Mutant[] = [];
  for (const f of first) {
    for (const m of firstOrderMutants(f.toks, ctx, SECOND_ORDER_OPERATORS)) {
      const key = tokenKey(m.toks);
      if (seen.has(key) || !looksSyntactic(m.toks, base)) continue;
      seen.add(key);
      out.push({ toks: m.toks, op: `${f.op}+${m.op}`, prior: SECOND_ORDER_PRIOR });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Deterministic order: operators sorted by prior (table order breaks ties), then round-robin
 * across operators with higher-prior operators emitting more per round, so a cap never lets one
 * prolific operator (identifier substitution, guards) starve the cheap ones and vice versa.
 */
export function orderMutants(mutants: readonly Mutant[]): Mutant[] {
  const groups = new Map<string, Mutant[]>();
  for (const m of mutants) {
    const g = groups.get(m.op);
    if (g === undefined) groups.set(m.op, [m]);
    else g.push(m);
  }
  const opIndex = (op: string): number => {
    const k = (OPERATOR_NAMES as readonly string[]).indexOf(op);
    return k < 0 ? OPERATOR_NAMES.length : k;
  };
  const ordered = [...groups.entries()].sort(([opA, a], [opB, b]) => b[0]!.prior - a[0]!.prior || opIndex(opA) - opIndex(opB) || (opA < opB ? -1 : 1));
  const cursors = ordered.map(() => 0);
  const out: Mutant[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    ordered.forEach(([, list], gi) => {
      const weight = 1 + Math.round(list[0]!.prior * 3);
      for (let n = 0; n < weight; n++) {
        const m = list[cursors[gi]!];
        if (m === undefined) return;
        cursors[gi]! += 1;
        out.push(m);
        progressed = true;
      }
    });
  }
  return out;
}

/** Enumerate candidates at a site: pure, deterministic, capped at `opts.cap`. */
export function enumerateMutations(site: Site, opts: EnumerateOptions): Candidate[] {
  const ctx = buildContext(site, opts);
  const base = site.kind === 'insert' ? [] : lineToks(site.currentLine);
  if (site.kind === 'replace' && base.length === 0) return [];
  let mutants = firstOrderMutants(base, ctx);
  if (site.kind === 'replace' && mutants.length < SECOND_ORDER_THRESHOLD) {
    mutants = [...mutants, ...secondOrderMutants(base, mutants, ctx, Math.max(0, Math.min(SECOND_ORDER_LIMIT, opts.cap - mutants.length)))];
  }
  const seenText = new Set<string>([site.currentLine.trim()]);
  const out: Candidate[] = [];
  for (const m of orderMutants(mutants)) {
    if (out.length >= opts.cap) break;
    const body = render(m.toks);
    if (seenText.has(body)) continue;
    seenText.add(body);
    const text = site.indent + body;
    out.push({
      id: `mutation:${m.op}:${fnv1a(`${site.file.path}:${site.line}:${site.kind}:${text}`)}`,
      site,
      text,
      source: 'mutation',
      op: m.op,
      prior: m.prior,
    });
  }
  return out;
}

export function createMutationSource(): CandidateSource {
  return { name: 'mutation', enumerate: enumerateMutations };
}
