/**
 * First-order mutation operators over the tokens of one Python line. Each operator is a pure
 * function (line, context) -> token lists; the source (index.ts) renders, filters, de-duplicates
 * and orders them. The operator set is the one measured in experiments/results/probe-selection.md
 * ("Operator library": gold fix reachable first-order on 38/40 QuixBugs lines) re-implemented
 * over the shared tokenizer instead of regexes, plus `boundary_shift` (relational swap and
 * literal shift together, the classic boundary-condition template that makes mergesort's
 * `== 0` -> `<= 1` first-order), `statement_template` for insert sites, and `argument_arity`
 * (drop or append one call argument: `split("-", 1)` -> `split("-")`, `enumerate(xs)` ->
 * `enumerate(xs, 1)`), added in review after the ladder tasks (bench/data/ladder) showed arity bugs
 * that no swap can reach, and `collapse_collection_to_element` (a bracketed tuple/list/set literal
 * or a bare tuple value of N elements collapses to each single element: `hash((a, b))` ->
 * `hash(a)`, `hash(b)`; django-15315's `return hash((...))` -> `return hash(self.creation_counter)`
 * at the statement-level site, experiments/results/swebench-reach-oracle-9.md capability 4; the
 * source enumerates it at statement-level sites and in WIDENED only, so the measured SEEDS sets
 * stay as they are). Declarations are never values: `def` names, parameters and annotations,
 * `lambda` parameters, `for`/`as` targets and keyword-argument names are protected so every
 * candidate still parses (checked with CPython `compile()` over all QuixBugs and ladder pools).
 */
import type { MutationContext } from './context.js';
import { lineIdentifiers, sharesStem, substitutesFor, substitutesForAttr, substitutesForCall } from './context.js';
import {
  ARITH_OPS, AUG_OPS, BITWISE_OPS, RELATIONAL_OPS, VALUE_KEYWORDS,
  binaryOps, clone, depthBefore, endsOperand, frag, isBalanced, isIdent, isKw, isOp, isOpen, matchClose, matchOpen, primaryEnd, primaryStart, render, splice, splitTopLevel, tokenKey,
} from './tokens.js';
import type { BinOp, Tok } from './tokens.js';

export const OPERATOR_NAMES = [
  'relational_swap', 'boundary_shift', 'off_by_one_literal', 'off_by_one_atom', 'argument_swap', 'argument_arity', 'index_flip', 'operand_swap',
  'arithmetic_swap', 'augassign_swap', 'boolean_swap', 'keyword_flip', 'negation',
  'identifier_substitution', 'call_substitution', 'attribute_substitution', 'constant_substitution', 'string_substitution',
  'slice_tweak', 'wrap_call', 'unwrap_call', 'drop_term', 'return_tweak', 'condition_extension',
  'drop_index', 'method_to_assign', 'binop_with_identifier', 'statement_template', 'collapse_collection_to_element',
] as const;
export type OperatorName = (typeof OPERATOR_NAMES)[number];

/**
 * Coarse priors (0..1): order enumeration only, never a Jev substitute. Operator swaps and
 * off-by-one edits are the most frequent one-line fixes in QuixBugs and Defects4J-style data;
 * open-ended rewrites (guards, return tweaks, templates) sit lower because they are many.
 */
export const OPERATOR_PRIORS: Readonly<Record<OperatorName, number>> = {
  relational_swap: 0.9,
  boundary_shift: 0.8,
  off_by_one_literal: 0.85,
  off_by_one_atom: 0.85,
  argument_swap: 0.85,
  argument_arity: 0.5,
  index_flip: 0.8,
  operand_swap: 0.7,
  arithmetic_swap: 0.75,
  augassign_swap: 0.75,
  boolean_swap: 0.75,
  keyword_flip: 0.7,
  negation: 0.7,
  identifier_substitution: 0.65,
  call_substitution: 0.6,
  attribute_substitution: 0.6,
  constant_substitution: 0.6,
  string_substitution: 0.55,
  slice_tweak: 0.55,
  wrap_call: 0.55,
  unwrap_call: 0.55,
  drop_term: 0.5,
  return_tweak: 0.5,
  condition_extension: 0.5,
  drop_index: 0.45,
  method_to_assign: 0.45,
  binop_with_identifier: 0.45,
  statement_template: 0.5,
  collapse_collection_to_element: 0.5,
};

/** Elements a collection literal may hold for `collapse_collection_to_element` (bounded: N variants per literal). */
const MAX_COLLAPSE_ELEMENTS = 6;

/** Cheap operators worth composing pairwise when the first-order set is small. */
export const SECOND_ORDER_OPERATORS: readonly OperatorName[] = ['relational_swap', 'arithmetic_swap', 'boolean_swap', 'off_by_one_literal', 'off_by_one_atom', 'index_flip', 'argument_swap', 'negation', 'keyword_flip'];

const HEAD_KEYWORDS: ReadonlySet<string> = new Set(['if', 'elif', 'while', 'for', 'return', 'yield', 'assert', 'with', 'def', 'class', 'else', 'try', 'except', 'finally', 'import', 'from', 'raise', 'del', 'global', 'nonlocal', 'pass', 'break', 'continue', 'lambda']);
const CONDITION_HEADS: ReadonlySet<string> = new Set(['if', 'elif', 'while']);
const NEGATABLE_HEADS: ReadonlySet<string> = new Set(['if', 'elif', 'while', 'return', 'yield', 'assert']);
const REL_SET: ReadonlySet<string> = new Set(RELATIONAL_OPS);
const ARITH_SET: ReadonlySet<string> = new Set(ARITH_OPS);
const BIT_SET: ReadonlySet<string> = new Set(BITWISE_OPS);
const AUG_SET: ReadonlySet<string> = new Set(AUG_OPS);
const COMPARISON_SET: ReadonlySet<string> = new Set([...RELATIONAL_OPS, 'is', 'is not', 'in', 'not in']);
const SWAPPABLE_SET: ReadonlySet<string> = new Set([...RELATIONAL_OPS, '+', '-', '*', 'and', 'or', 'in', 'not in', 'is']);
const BOOL_SET: ReadonlySet<string> = new Set(['and', 'or']);
const WRAPPERS: readonly string[] = ['abs', 'len', 'list', 'sorted', 'set'];
const METHOD_TEMPLATES: readonly string[] = ['append', 'add', 'update'];

/** Limits per anchor so one prolific operator cannot flood the pool. */
const MAX_VALUE_SUBS = 12;
const MAX_CALL_SUBS = 10;
const MAX_ATTR_SUBS = 10;
const MAX_SLICE_BOUNDS = 5;
const MAX_WRAP_IDS = 6;
const MAX_GUARD_IDS = 8;
const MAX_RETURN_IDS = 10;
const MAX_BINOP_IDS = 8;
const MAX_TEMPLATE_IDS = 8;
const MAX_RETARGET = 3;
const MAX_CONST_IDS = 6;
const MAX_ARITY_IDS = 6;
/** Operators that bind tighter than `+`/`-`: `x - 1` next to one of these needs parentheses to shift the atom. */
const TIGHT_OPS: ReadonlySet<string> = new Set(['*', '/', '//', '%', '**', '@']);
/** Small literals worth appending as an extra positional argument (`pop()` -> `pop(0)`, `enumerate(xs)` -> `enumerate(xs, 1)`). */
const ARITY_LITERALS: readonly string[] = ['0', '1', '-1'];

/** Structural facts about the line that most operators consult. */
export interface LineInfo {
  toks: readonly Tok[];
  /** leading keyword of the statement, if any (`if`, `return`, `for`, ...) */
  head: string | null;
  /** index of the depth-0 `=` / augmented assignment of a simple statement, or -1 */
  assignAt: number;
  /** does the line end with a depth-0 `:` (compound header)? */
  headerColon: boolean;
  /** token indices operators must not treat as values: def/class names, parameters, kwarg names, for/as/lambda targets, attribute names */
  protectedIdx: ReadonlySet<number>;
}

export interface Primary {
  start: number;
  end: number;
}

export function lineInfo(toks: readonly Tok[]): LineInfo {
  const first = toks[0];
  const head = first !== undefined && first.type === 'NAME' && HEAD_KEYWORDS.has(first.text) ? first.text : null;
  let assignAt = -1;
  if (head === null) {
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k]!;
      if (depthBefore(toks, k) !== 0) continue;
      if (t.type === 'OP' && (t.text === '=' || AUG_SET.has(t.text))) {
        assignAt = k;
        break;
      }
    }
  }
  const last = toks[toks.length - 1];
  const headerColon = last !== undefined && isOp(last, ':') && depthBefore(toks, toks.length - 1) === 0;
  const protectedIdx = new Set<number>();
  toks.forEach((t, k) => {
    const prev = toks[k - 1];
    const next = toks[k + 1];
    if (isKw(prev, 'def') || isKw(prev, 'class')) protectedIdx.add(k);
    if (isOp(prev, '.')) protectedIdx.add(k);
    // keyword argument name: `f(key=value)` (inside brackets, `=` not followed by `=`)
    if (t.type === 'NAME' && isOp(next, '=') && depthBefore(toks, k) > 0 && (isOp(prev, ',') || isOpen(prev))) protectedIdx.add(k);
    // loop targets: `for a, b in ...` (statement or comprehension)
    if (isKw(t, 'for')) {
      for (let j = k + 1; j < toks.length; j++) {
        const u = toks[j]!;
        if (isKw(u, 'in') && depthBefore(toks, j) === depthBefore(toks, k)) break;
        if (u.type === 'NAME') protectedIdx.add(j);
      }
    }
    // lambda parameters: every name between `lambda` and its `:` at the same depth (`lambda kv: kv[1]`)
    if (isKw(t, 'lambda')) {
      const d = depthBefore(toks, k);
      for (let j = k + 1; j < toks.length; j++) {
        const u = toks[j]!;
        if (isOp(u, ':') && depthBefore(toks, j) === d) break;
        if (u.type === 'NAME') protectedIdx.add(j);
      }
    }
    // `except E as name`, `with f() as name`, `import x as name`: the bound name is not a value
    if (isKw(prev, 'as') && t.type === 'NAME') protectedIdx.add(k);
  });
  // parameters of a `def` header (`def pad(text: str, width: int = 4)`): the parameter names and
  // their annotations are declarations, not values; only the defaults (after `=`) stay editable
  if (head === 'def') {
    const open = toks.findIndex((t) => isOp(t, '('));
    const close = open >= 0 ? matchClose(toks, open) : -1;
    if (open >= 0 && close > open) {
      let inDefault = false;
      for (let j = open + 1; j < close; j++) {
        const u = toks[j]!;
        const top = depthBefore(toks, j) === 1;
        if (top && isOp(u, ',')) inDefault = false;
        else if (top && isOp(u, '=')) inDefault = true;
        else if (!inDefault && u.type === 'NAME') protectedIdx.add(j);
      }
    }
  }
  return { toks, head, assignAt, headerColon, protectedIdx };
}

/** Every primary that starts at an unprotected identifier/literal/bracket group (nested ones included). */
export function primaries(info: LineInfo): Primary[] {
  const { toks } = info;
  const out: Primary[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (info.protectedIdx.has(i)) continue;
    const t = toks[i]!;
    const startsOperand = isIdent(t, true) || t.type === 'NUMBER' || t.type === 'STRING' || (isOpen(t) && !endsOperand(toks[i - 1]));
    if (!startsOperand) continue;
    if (isOp(toks[i - 1], '.')) continue;
    const end = primaryEnd(toks, i);
    if (end < 0) continue;
    out.push({ start: i, end });
  }
  return out;
}

/** Is the primary a value (not an assignment target, def name, kwarg name or the whole statement)? */
function isValuePosition(info: LineInfo, p: Primary): boolean {
  if (info.assignAt >= 0 && p.start < info.assignAt) return false;
  const next = info.toks[p.end];
  if (next !== undefined && next.type === 'OP' && (next.text === '=' || AUG_SET.has(next.text))) return false;
  return true;
}

function isIntToken(t: Tok | undefined): boolean {
  return t !== undefined && t.type === 'NUMBER' && /^\d+$/.test(t.text);
}

function replaceOp(toks: readonly Tok[], op: BinOp, text: string): Tok[] {
  return splice(toks, op.start, op.end, frag(text));
}

/** `toks[from, to)` rendered as source, for building fragments from existing pieces. */
function text(toks: readonly Tok[], from: number, to: number): string {
  return render(toks.slice(from, to));
}

type Operator = (info: LineInfo, ctx: MutationContext) => Tok[][];

// ---------------------------------------------------------------------------------------
// operator swaps
// ---------------------------------------------------------------------------------------

const relationalSwap: Operator = ({ toks }) => {
  const out: Tok[][] = [];
  for (const op of binaryOps(toks, COMPARISON_SET)) {
    const alts: string[] = [];
    if (REL_SET.has(op.text)) {
      alts.push(...RELATIONAL_OPS.filter((r) => r !== op.text));
      if (op.text === '==') alts.push('is');
      if (op.text === '!=') alts.push('is not');
    } else if (op.text === 'is') alts.push('is not', '==');
    else if (op.text === 'is not') alts.push('is', '!=');
    else if (op.text === 'in') alts.push('not in');
    else if (op.text === 'not in') alts.push('in');
    for (const a of alts) out.push(replaceOp(toks, op, a));
  }
  return out;
};

/** `x == 0` -> `x <= 1`: relational swap and literal shift in one step (boundary-condition template). */
const boundaryShift: Operator = ({ toks }) => {
  const out: Tok[][] = [];
  for (const op of binaryOps(toks, REL_SET)) {
    const right = toks[op.end];
    const left = toks[op.start - 1];
    const sides: { at: number; tok: Tok }[] = [];
    if (isIntToken(right) && !endsOperand(toks[op.end + 1]) && !isOp(toks[op.end + 1], '.')) sides.push({ at: op.end, tok: right! });
    if (isIntToken(left) && !isOp(toks[op.start - 2], '-')) sides.push({ at: op.start - 1, tok: left! });
    for (const side of sides) {
      const n = Number(side.tok.text);
      for (const rel of RELATIONAL_OPS) {
        for (const d of [1, -1]) {
          const v = n + d;
          const withOp = rel === op.text ? clone(toks) : replaceOp(toks, op, rel);
          out.push(splice(withOp, side.at, side.at + 1, frag(String(v))));
        }
      }
    }
  }
  return out;
};

const arithmeticSwap: Operator = ({ toks }) => {
  const out: Tok[][] = [];
  for (const op of binaryOps(toks, ARITH_SET)) for (const a of ARITH_OPS) if (a !== op.text) out.push(replaceOp(toks, op, a));
  for (const op of binaryOps(toks, BIT_SET)) for (const a of BITWISE_OPS) if (a !== op.text) out.push(replaceOp(toks, op, a));
  return out;
};

const augassignSwap: Operator = (info) => {
  const out: Tok[][] = [];
  const { toks, assignAt } = info;
  if (assignAt < 0) return out;
  const cur = toks[assignAt]!.text;
  if (cur === '=') {
    for (const a of ['+=', '-=']) out.push(splice(toks, assignAt, assignAt + 1, frag(a)));
    return out;
  }
  for (const a of [...AUG_OPS, '=']) if (a !== cur) out.push(splice(toks, assignAt, assignAt + 1, frag(a)));
  return out;
};

const booleanSwap: Operator = ({ toks }) => {
  const out: Tok[][] = [];
  for (const op of binaryOps(toks, BOOL_SET)) out.push(replaceOp(toks, op, op.text === 'and' ? 'or' : 'and'));
  return out;
};

const keywordFlip: Operator = ({ toks }) => {
  const out: Tok[][] = [];
  toks.forEach((t, k) => {
    if (isKw(t, 'True')) out.push(splice(toks, k, k + 1, frag('False')));
    else if (isKw(t, 'False')) out.push(splice(toks, k, k + 1, frag('True')));
  });
  return out;
};

// ---------------------------------------------------------------------------------------
// off-by-one, indices, slices, arguments
// ---------------------------------------------------------------------------------------

const offByOneLiteral: Operator = ({ toks }) => {
  const out: Tok[][] = [];
  toks.forEach((t, k) => {
    if (!isIntToken(t)) return;
    const n = Number(t.text);
    const unaryMinusBefore = isOp(toks[k - 1], '-') && !endsOperand(toks[k - 2]);
    for (const d of [1, -1]) {
      const v = n + d;
      if (v < 0 && unaryMinusBefore) continue; // `-(-1)` reads as noise
      out.push(splice(toks, k, k + 1, frag(String(v))));
    }
  });
  return out;
};

/** `f(mid, end)` -> `f(mid + 1, end)`; `dp[i - 1, j]` -> `dp[i - 1, j - 1]`; `len(x) - 1` -> `len(x)`. */
const offByOneAtom: Operator = (info) => {
  const out: Tok[][] = [];
  const { toks } = info;
  for (const p of primaries(info)) {
    const head = toks[p.start]!;
    if (head.type !== 'NAME' || VALUE_KEYWORDS.has(head.text)) continue;
    if (!isValuePosition(info, p)) continue;
    // the whole statement / the whole condition of a header is not an arithmetic operand
    if (p.start === 0 && p.end === toks.length) continue;
    if (info.head !== null && p.start === 1 && p.end === toks.length - (info.headerColon ? 1 : 0)) continue;
    const next = toks[p.end];
    const after = toks[p.end + 1];
    if (next !== undefined && (isOp(next, '+') || isOp(next, '-')) && after !== undefined && isIntToken(after) && after.text === '1' && !endsOperand(toks[p.end + 2]) && !isOp(toks[p.end + 2], '.')) {
      out.push(splice(toks, p.end, p.end + 2, []));
      continue;
    }
    out.push(splice(toks, p.end, p.end, frag('+ 1', ' '), false), splice(toks, p.end, p.end, frag('- 1', ' '), false));
    // `number * size` -> `(number - 1) * size`: a bare `- 1` would bind to the product instead
    const before = toks[p.start - 1];
    const tight = (next !== undefined && next.type === 'OP' && TIGHT_OPS.has(next.text)) || (before !== undefined && before.type === 'OP' && TIGHT_OPS.has(before.text) && endsOperand(toks[p.start - 2]));
    if (tight) {
      const atom = text(toks, p.start, p.end);
      out.push(splice(toks, p.start, p.end, frag(`(${atom} + 1)`)), splice(toks, p.start, p.end, frag(`(${atom} - 1)`)));
    }
  }
  return out;
};

interface Group {
  open: number;
  close: number;
  /** does an operand precede the bracket (call / subscript) rather than a literal or grouping? */
  trailer: boolean;
}

function groups(toks: readonly Tok[], kind: '(' | '['): Group[] {
  const out: Group[] = [];
  toks.forEach((t, k) => {
    if (!isOp(t, kind)) return;
    const close = matchClose(toks, k);
    if (close < 0) return;
    out.push({ open: k, close, trailer: endsOperand(toks[k - 1]) });
  });
  return out;
}

function replaceInner(toks: readonly Tok[], g: Group, inner: string): Tok[] {
  return splice(toks, g.open + 1, g.close, frag(inner), false);
}

const indexFlip: Operator = ({ toks }) => {
  const out: Tok[][] = [];
  const subs = groups(toks, '[').filter((g) => g.trailer);
  for (const g of subs) {
    const inner = text(toks, g.open + 1, g.close);
    if (inner === '0') out.push(replaceInner(toks, g, '-1'), replaceInner(toks, g, '1'));
    if (inner === '-1') out.push(replaceInner(toks, g, '0'));
    if (inner === '1') out.push(replaceInner(toks, g, '0'));
    const parts = splitTopLevel(toks, g.open + 1, g.close, ',');
    if (parts.length === 2 && parts.every(([a, b]) => b > a)) {
      const [p0, p1] = parts as [[number, number], [number, number]];
      out.push(replaceInner(toks, g, `${text(toks, p1[0], p1[1])}, ${text(toks, p0[0], p0[1])}`));
    }
    const colon = splitTopLevel(toks, g.open + 1, g.close, ':');
    if (colon.length === 2 && colon.every(([a, b]) => b > a)) {
      const [c0, c1] = colon as [[number, number], [number, number]];
      out.push(replaceInner(toks, g, `${text(toks, c1[0], c1[1])}:${text(toks, c0[0], c0[1])}`));
    }
  }
  // swap the contents of two subscripts on the line: `a[i] + b[j]` -> `a[j] + b[i]`
  for (let i = 0; i < subs.length; i++) {
    for (let j = i + 1; j < subs.length; j++) {
      const a = subs[i]!;
      const b = subs[j]!;
      if (a.close >= b.open) continue; // nested
      const ia = text(toks, a.open + 1, a.close);
      const ib = text(toks, b.open + 1, b.close);
      if (ia === ib || ia === '' || ib === '') continue;
      out.push(replaceInner(replaceInner(toks, b, ia), a, ib));
    }
  }
  return out;
};

/** `arr` -> `arr[1:]`, `arr[k:]`, `arr[:k]`; `a[1:]` -> `a`; slice bounds ±1; `[k:]` <-> `[:k]`. */
const sliceTweak: Operator = (info, ctx) => {
  const out: Tok[][] = [];
  const { toks } = info;
  for (const p of primaries(info)) {
    if (p.end !== p.start + 1 || !isIdent(toks[p.start]) || !isValuePosition(info, p)) continue;
    if (p.start === 0 && p.end === toks.length) continue;
    const name = toks[p.start]!.text;
    const bounds = ['1', '-1', ...substitutesFor(name, ctx.valueNames).slice(0, MAX_SLICE_BOUNDS)];
    for (const b of bounds) out.push(splice(toks, p.end, p.end, frag(`[${b}:]`), false), splice(toks, p.end, p.end, frag(`[:${b}]`), false));
  }
  for (const g of groups(toks, '[').filter((g) => g.trailer)) {
    const colon = splitTopLevel(toks, g.open + 1, g.close, ':');
    if (colon.length !== 2) continue;
    const [[a0, a1], [b0, b1]] = colon as [[number, number], [number, number]];
    const a = text(toks, a0, a1);
    const b = text(toks, b0, b1);
    const headStart = primaryStart(toks, g.open);
    if (headStart >= 0) out.push(splice(toks, g.open, g.close + 1, []));
    if (a !== '' && b === '') out.push(replaceInner(toks, g, `:${a}`));
    if (a === '' && b !== '') out.push(replaceInner(toks, g, `${b}:`));
    const shifted: [string, string][] = [
      [a === '' ? '1' : `${a} + 1`, b],
      [a === '' ? '-1' : `${a} - 1`, b],
      [a, b === '' ? '-1' : `${b} - 1`],
      [a, b === '' ? '1' : `${b} + 1`],
    ];
    for (const [na, nb] of shifted) out.push(replaceInner(toks, g, `${na}:${nb}`));
  }
  return out;
};

/** Is `toks[a, b)` a bare generator expression (`x for x in xs` at the argument's own depth)? */
function isGenexp(toks: readonly Tok[], [a, b]: [number, number]): boolean {
  const d = depthBefore(toks, a);
  for (let k = a; k < b; k++) if (isKw(toks[k], 'for') && depthBefore(toks, k) === d) return true;
  return false;
}

/** Argument kind: positional, `name=value`, `*args`, `**kwargs`; only like kinds may trade places. */
function argKind(toks: readonly Tok[], [a, b]: [number, number]): 'pos' | 'kw' | 'star' | 'dstar' {
  const first = toks[a];
  if (isOp(first, '**')) return 'dstar';
  if (isOp(first, '*')) return 'star';
  if (b - a >= 2 && first !== undefined && first.type === 'NAME' && isOp(toks[a + 1], '=')) return 'kw';
  return 'pos';
}

/** Every pairwise permutation of the comma-separated parts of a call, subscript, tuple or list (positional with positional, keyword with keyword). */
const argumentSwap: Operator = ({ toks }) => {
  const out: Tok[][] = [];
  for (const g of [...groups(toks, '('), ...groups(toks, '[')]) {
    const parts = splitTopLevel(toks, g.open + 1, g.close, ',');
    if (parts.length < 2 || parts.some(([a, b]) => b <= a)) continue;
    const kinds = parts.map((p) => argKind(toks, p));
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        // `sorted(key=f, xs)` is a syntax error; `f(**kw, x)` too
        if (kinds[i] !== kinds[j]) continue;
        const order = parts.map((_, k) => (k === i ? j : k === j ? i : k));
        const inner = order.map((k) => text(toks, parts[k]![0], parts[k]![1])).join(', ');
        out.push(replaceInner(toks, g, inner));
      }
    }
  }
  return out;
};

/**
 * Change a call's arity: drop one positional argument (`split("-", 1)` -> `split("-")`) or append
 * one (`pop()` -> `pop(0)`, `enumerate(xs)` -> `enumerate(xs, 1)`, `pad(cell, width)` ->
 * `pad(cell, width, fill)`) from the small literals and the in-scope names. The appended argument
 * goes before the first keyword argument so the line still parses.
 */
const argumentArity: Operator = (info, ctx) => {
  const out: Tok[][] = [];
  const { toks } = info;
  for (const g of groups(toks, '(')) {
    if (!g.trailer) continue;
    const headStart = primaryStart(toks, g.open);
    if (headStart < 0 || info.protectedIdx.has(headStart)) continue; // `def f(...)`, `class C(...)`
    const parts = g.close === g.open + 1 ? [] : splitTopLevel(toks, g.open + 1, g.close, ',');
    if (parts.some(([a, b]) => b <= a)) continue; // trailing comma or empty slot
    // `any(x for x in xs)`: a bare generator argument must stay the only argument
    if (parts.length === 1 && isGenexp(toks, parts[0]!)) continue;
    const kinds = parts.map((p) => argKind(toks, p));
    const positional = parts.filter((_, k) => kinds[k] === 'pos');
    if (positional.length >= 2) {
      for (let k = 0; k < parts.length; k++) {
        if (kinds[k] !== 'pos') continue;
        const rest = parts.filter((_, j) => j !== k).map(([a, b]) => text(toks, a, b));
        out.push(replaceInner(toks, g, rest.join(', ')));
      }
    }
    // the last argument on the line as the seed for a compatible extra name (`pad(cell, width)` -> `... fill`)
    const lastPos = positional[positional.length - 1];
    const seed = lastPos !== undefined && lastPos[1] === lastPos[0] + 1 && isIdent(toks[lastPos[0]]) ? toks[lastPos[0]]!.text : null;
    const names = (seed === null ? ctx.valueNames : substitutesFor(seed, ctx.valueNames)).slice(0, MAX_ARITY_IDS);
    const present = new Set(parts.map(([a, b]) => text(toks, a, b)));
    const extras = [...ARITY_LITERALS, ...names].filter((x) => !present.has(x));
    const firstKw = kinds.findIndex((k) => k !== 'pos');
    const before = firstKw < 0 ? parts : parts.slice(0, firstKw);
    const after = firstKw < 0 ? [] : parts.slice(firstKw);
    for (const extra of extras) {
      const inner = [...before.map(([a, b]) => text(toks, a, b)), extra, ...after.map(([a, b]) => text(toks, a, b))].join(', ');
      out.push(replaceInner(toks, g, inner));
    }
  }
  return out;
};

/** Swap the operands of a binary operator: `perm[j] < perm[i]` -> `perm[i] < perm[j]`, `a + b` -> `b + a`. */
const operandSwap: Operator = ({ toks }) => {
  const out: Tok[][] = [];
  for (const op of binaryOps(toks, SWAPPABLE_SET)) {
    const ls = primaryStart(toks, op.start);
    const re = primaryEnd(toks, op.end);
    if (ls < 0 || re < 0) continue;
    const left = toks.slice(ls, op.start);
    const right = toks.slice(op.end, re);
    if (tokenKey(left) === tokenKey(right)) continue;
    const swapped = splice(splice(toks, op.end, re, left), ls, op.start, right);
    out.push(swapped);
  }
  return out;
};

// ---------------------------------------------------------------------------------------
// negation and constants
// ---------------------------------------------------------------------------------------

const negation: Operator = (info) => {
  const out: Tok[][] = [];
  const { toks, head } = info;
  if (head !== null && NEGATABLE_HEADS.has(head) && toks.length > 1) {
    if (isKw(toks[1], 'not')) out.push(splice(toks, 1, 2, []));
    else out.push(splice(toks, 1, 1, frag('not', ' '), false));
  }
  toks.forEach((t, k) => {
    if (!isKw(t, 'not') || isKw(toks[k + 1], 'in') || isKw(toks[k - 1], 'is') || k === 1 && head !== null && NEGATABLE_HEADS.has(head)) return;
    out.push(splice(toks, k, k + 1, []));
  });
  for (const op of binaryOps(toks, BOOL_SET)) {
    if (isKw(toks[op.end], 'not')) continue;
    out.push(splice(toks, op.end, op.end, frag('not', ' '), false));
  }
  // unary minus toggles on numbers and on names inside brackets
  const negate = (k: number): Tok[] => {
    const res = splice(toks, k, k, frag('-', toks[k]!.pre), false);
    res[k + 1]!.pre = '';
    return res;
  };
  const unnegate = (k: number): Tok[] => {
    const res = splice(toks, k - 1, k, []);
    res[k - 1]!.pre = toks[k - 1]!.pre;
    return res;
  };
  toks.forEach((t, k) => {
    const unaryBefore = isOp(toks[k - 1], '-') && !endsOperand(toks[k - 2]);
    if (isIntToken(t)) {
      if (unaryBefore) out.push(unnegate(k));
      else if (t.text !== '0' && !isOp(toks[k - 1], '.') && !isOp(toks[k + 1], '.')) out.push(negate(k));
    } else if (isIdent(t) && depthBefore(toks, k) > 0 && !info.protectedIdx.has(k) && !isOp(toks[k - 1], '.')) {
      if (unaryBefore) out.push(unnegate(k));
      else out.push(negate(k));
    }
  });
  return out;
};

const constantSubstitution: Operator = (info, ctx) => {
  const out: Tok[][] = [];
  const { toks } = info;
  toks.forEach((t, k) => {
    if (isIntToken(t)) {
      const unaryBefore = isOp(toks[k - 1], '-') && !endsOperand(toks[k - 2]);
      for (const lit of ctx.intLiterals) {
        if (lit === t.text || (lit.startsWith('-') && unaryBefore)) continue;
        out.push(splice(toks, k, k + 1, frag(lit)));
      }
      // a constant that should have been a variable: `return 0` -> `return n`
      if (!unaryBefore && !info.protectedIdx.has(k)) for (const id of ctx.valueNames.slice(0, MAX_CONST_IDS)) out.push(splice(toks, k, k + 1, frag(id)));
      return;
    }
    if (t.type === 'NUMBER' && /^\d*\.\d*(?:[eE][+-]?\d+)?$/.test(t.text) && t.text !== '.') {
      // wrong magnitude is the usual float bug: pool literals, then one decade either way
      const n = Number(t.text);
      const shifted = Number.isFinite(n) && n !== 0 ? [String(n * 10), String(n / 10)].map((x) => (x.includes('.') || x.includes('e') ? x : `${x}.0`)) : [];
      for (const lit of [...ctx.floatLiterals, ...shifted]) if (lit !== t.text && !out.some((c) => c[k]?.text === lit)) out.push(splice(toks, k, k + 1, frag(lit)));
      return;
    }
    if (isKw(t, 'None') && !info.protectedIdx.has(k)) {
      for (const lit of ['0', '[]', 'False', "''"]) out.push(splice(toks, k, k + 1, frag(lit)));
      return;
    }
    if (isOp(t, '[') && isOp(toks[k + 1], ']') && !endsOperand(toks[k - 1])) {
      for (const lit of ['[[]]', 'None', '[0]', '()']) out.push(splice(toks, k, k + 2, frag(lit)));
      for (const id of ctx.valueNames.slice(0, MAX_VALUE_SUBS)) out.push(splice(toks, k, k + 2, frag(`[${id}]`)));
      return;
    }
    if (isOp(t, '[') && isOp(toks[k + 1], '[') && isOp(toks[k + 2], ']') && isOp(toks[k + 3], ']') && !endsOperand(toks[k - 1])) {
      out.push(splice(toks, k, k + 4, frag('[]')));
      return;
    }
    if (isOp(t, '(') && isOp(toks[k + 1], ')') && !endsOperand(toks[k - 1])) {
      for (const lit of ['[]', 'None']) out.push(splice(toks, k, k + 2, frag(lit)));
    }
  });
  return out;
};

const stringSubstitution: Operator = ({ toks }, ctx) => {
  const out: Tok[][] = [];
  toks.forEach((t, k) => {
    if (t.type !== 'STRING') return;
    for (const lit of ctx.strLiterals) if (lit !== t.text) out.push(splice(toks, k, k + 1, [{ type: 'STRING', text: lit, pre: t.pre }]));
  });
  return out;
};

// ---------------------------------------------------------------------------------------
// substitutions from scope
// ---------------------------------------------------------------------------------------

const identifierSubstitution: Operator = (info, ctx) => {
  const out: Tok[][] = [];
  const { toks } = info;
  toks.forEach((t, k) => {
    if (!isIdent(t, true) || info.protectedIdx.has(k) || isOp(toks[k + 1], '(')) return;
    const pool = VALUE_KEYWORDS.has(t.text) ? ctx.valueNames.slice(0, MAX_VALUE_SUBS) : substitutesFor(t.text, ctx.valueNames).slice(0, MAX_VALUE_SUBS);
    for (const other of pool) out.push(splice(toks, k, k + 1, frag(other)));
  });
  return out;
};

const callSubstitution: Operator = (info, ctx) => {
  const out: Tok[][] = [];
  const { toks } = info;
  toks.forEach((t, k) => {
    if (!isIdent(t) || info.protectedIdx.has(k) || !isOp(toks[k + 1], '(')) return;
    for (const other of substitutesForCall(t.text, ctx.callNames).slice(0, MAX_CALL_SUBS)) out.push(splice(toks, k, k + 1, frag(other)));
  });
  return out;
};

const attributeSubstitution: Operator = ({ toks }, ctx) => {
  const out: Tok[][] = [];
  toks.forEach((t, k) => {
    if (!isIdent(t) || !isOp(toks[k - 1], '.')) return;
    for (const other of substitutesForAttr(t.text, ctx, isOp(toks[k + 1], '(')).slice(0, MAX_ATTR_SUBS)) out.push(splice(toks, k, k + 1, frag(other)));
  });
  return out;
};

// ---------------------------------------------------------------------------------------
// expression-level rewrites
// ---------------------------------------------------------------------------------------

/** The right-hand side of an assignment or the expression after `return`/`yield`, as a token range. */
function valueExpr(info: LineInfo): [number, number] | null {
  const { toks, head, assignAt } = info;
  if (assignAt >= 0 && assignAt + 1 < toks.length && isBalanced(toks, assignAt + 1, toks.length)) return [assignAt + 1, toks.length];
  if ((head === 'return' || head === 'yield') && toks.length > 1 && isBalanced(toks, 1, toks.length)) return [1, toks.length];
  return null;
}

const wrapCall: Operator = (info, ctx) => {
  const out: Tok[][] = [];
  const { toks } = info;
  const expr = valueExpr(info);
  if (expr !== null) {
    const [s, e] = expr;
    const rhs = text(toks, s, e);
    const lhs = info.assignAt > 0 ? text(toks, 0, info.assignAt) : null;
    // a bracket or string literal value (`return []`) is not worth clamping or measuring
    const literalExpr = primaryEnd(toks, s) === e && (isOpen(toks[s]) || toks[s]!.type === 'STRING');
    if (!literalExpr) {
      const wraps: string[] = [`max(0, ${rhs})`, `min(0, ${rhs})`, `${rhs} ** 2`, ...WRAPPERS.map((w) => `${w}(${rhs})`)];
      if (lhs !== null) wraps.push(`max(${lhs}, ${rhs})`, `min(${lhs}, ${rhs})`);
      for (const id of ctx.valueNames.filter((n) => n !== lhs).slice(0, MAX_WRAP_IDS)) wraps.push(`max(${id}, ${rhs})`, `min(${id}, ${rhs})`);
      for (const w of wraps) out.push(splice(toks, s, e, frag(w)));
    }
  }
  // operands inside brackets: `abs(x - approx)` -> `abs(x - approx ** 2)`; `f(x)` -> `f(len(x))`
  for (const p of primaries(info)) {
    if (p.end !== p.start + 1 || !isIdent(toks[p.start]) || !isValuePosition(info, p) || depthBefore(toks, p.start) <= 0) continue;
    const name = toks[p.start]!.text;
    out.push(splice(toks, p.end, p.end, frag('** 2', ' '), false));
    for (const w of ['abs', 'len']) out.push(splice(toks, p.start, p.end, frag(`${w}(${name})`)));
  }
  return out;
};

/** `f(x)` -> `x`; `f(a, b)` -> in-scope name (`get(nodes, n) + d` -> `distance + d`). */
const unwrapCall: Operator = (info, ctx) => {
  const out: Tok[][] = [];
  const { toks } = info;
  for (const g of groups(toks, '(').filter((g) => g.trailer)) {
    const headStart = primaryStart(toks, g.open);
    if (headStart < 0 || info.protectedIdx.has(headStart)) continue; // never unwrap a `def`/`class` header
    const isWholeStatement = headStart === 0 && g.close === toks.length - 1;
    const parts = splitTopLevel(toks, g.open + 1, g.close, ',');
    const [a0, a1] = parts[0]!;
    if (parts.length === 1 && a1 > a0 && !isWholeStatement && !isGenexp(toks, [a0, a1])) out.push(splice(toks, headStart, g.close + 1, toks.slice(a0, a1)));
    if (isWholeStatement) continue;
    for (const id of ctx.valueNames.slice(0, MAX_VALUE_SUBS)) out.push(splice(toks, headStart, g.close + 1, frag(id)));
  }
  return out;
};

/** Remove one operand of a binary `+ - *` or `and`/`or`: `1 + f(x)` -> `f(x)`; `a and b` -> `a`. */
const dropTerm: Operator = ({ toks }) => {
  const out: Tok[][] = [];
  for (const op of binaryOps(toks, new Set(['+', '-', '*', 'and', 'or']))) {
    const ls = primaryStart(toks, op.start);
    const re = primaryEnd(toks, op.end);
    if (ls >= 0) out.push(splice(toks, ls, op.end, []));
    if (re >= 0) out.push(splice(toks, op.start, re, []));
  }
  return out;
};

const returnTweak: Operator = (info, ctx) => {
  const out: Tok[][] = [];
  const { toks, head } = info;
  if (head !== 'return' && head !== 'yield') return out;
  const kw = head;
  const expr = toks.length > 1 && isBalanced(toks, 1, toks.length) ? text(toks, 1, toks.length) : null;
  const push = (s: string): void => {
    out.push(frag(`${kw} ${s}`));
  };
  for (const id of ctx.valueNames.slice(0, MAX_RETURN_IDS)) {
    push(id);
    push(`[${id}]`);
    push(`${id} == 0`);
    push(`not ${id}`);
    if (expr !== null) {
      push(`${id} + ${expr}`);
      push(`${expr} + ${id}`);
    }
  }
  for (const lit of ['None', '[]', '[[]]', 'True', 'False', '0', '1']) push(lit);
  if (expr !== null) {
    push(`${expr} + 1`);
    push(`${expr} - 1`);
    push(`not ${expr}`);
    if (primaryEnd(toks, 1) === toks.length) {
      push(`${expr}[0]`);
      push(`${expr}[-1]`);
      push(`${expr}[1:]`);
    }
  }
  return out;
};

/** `if X:` -> `if X or G:`, `if G or X:`, `if X and G:` with guards from the line, the scope and sibling comparisons. */
const conditionExtension: Operator = (info, ctx) => {
  const out: Tok[][] = [];
  const { toks, head } = info;
  if (head === null || !CONDITION_HEADS.has(head) || !info.headerColon || toks.length < 3 || !isBalanced(toks, 1, toks.length - 1)) return out;
  const cond = text(toks, 1, toks.length - 1);
  const ids = [...new Set([...lineIdentifiers(toks.slice(1, -1)), ...ctx.valueNames])].slice(0, MAX_GUARD_IDS);
  const guards: string[] = [];
  for (const id of ids) guards.push(`not ${id}`, `${id} is None`, id);
  guards.push(...ctx.comparisons.filter((c) => c !== cond));
  for (const g of guards) {
    for (const s of [`${cond} or ${g}`, `${g} or ${cond}`, `${cond} and ${g}`]) out.push(frag(`${head} ${s}:`));
  }
  if (cond === 'True') for (const id of ctx.valueNames.slice(0, MAX_VALUE_SUBS)) out.push(frag(`${head} ${id}:`));
  return out;
};

// ---------------------------------------------------------------------------------------
// statement-shape rewrites
// ---------------------------------------------------------------------------------------

/**
 * `a[u, v]` -> `a[u]`, `a[v]`; `a[i]` -> `a`; and, when a sibling container shares the head's
 * stem, `weight_by_edge[u, v]` -> `weight_by_node[v]` (wrong container and wrong key arity
 * together: the one QuixBugs fix that is otherwise second-order).
 */
const dropIndex: Operator = ({ toks }, ctx) => {
  const out: Tok[][] = [];
  for (const g of groups(toks, '[').filter((g) => g.trailer)) {
    const parts = splitTopLevel(toks, g.open + 1, g.close, ',');
    const head = toks[g.open - 1];
    if (parts.length === 2 && parts.every(([a, b]) => b > a)) {
      for (const [a, b] of parts) {
        const dropped = replaceInner(toks, g, text(toks, a, b));
        out.push(dropped);
        if (head === undefined || !isIdent(head) || isOp(toks[g.open - 2], '.')) continue;
        for (const other of ctx.valueNames.filter((n) => sharesStem(head.text, n)).slice(0, MAX_RETARGET)) out.push(splice(dropped, g.open - 1, g.open, frag(other)));
      }
    }
    out.push(splice(toks, g.open, g.close + 1, []));
  }
  return out;
};

/** `x.update(y)` -> `x = y`, `x = [y]`, `x += y`; `x = y` -> `x.append(y)`, `x.add(y)`, `x.update(y)`. */
const methodToAssign: Operator = (info) => {
  const out: Tok[][] = [];
  const { toks, head, assignAt } = info;
  if (head !== null) return out;
  const last = toks.length - 1;
  if (assignAt < 0 && isOp(toks[last], ')')) {
    const open = matchOpen(toks, last);
    if (open >= 2 && isIdent(toks[open - 1]) && isOp(toks[open - 2], '.') && primaryStart(toks, open) === 0) {
      const recv = text(toks, 0, open - 2);
      const arg = text(toks, open + 1, last);
      if (arg !== '') out.push(frag(`${recv} = ${arg}`), frag(`${recv} = [${arg}]`), frag(`${recv} += ${arg}`));
    }
  }
  if (assignAt > 0 && isOp(toks[assignAt], '=') && assignAt + 1 < toks.length && isBalanced(toks, assignAt + 1, toks.length)) {
    const lhs = text(toks, 0, assignAt);
    const rhs = text(toks, assignAt + 1, toks.length);
    for (const m of METHOD_TEMPLATES) out.push(frag(`${lhs}.${m}(${rhs})`));
  }
  return out;
};

/** `k` -> `k - other`, `k + other` for a name in argument/index position or as the whole value. */
const binopWithIdentifier: Operator = (info, ctx) => {
  const out: Tok[][] = [];
  const { toks } = info;
  const expr = valueExpr(info);
  for (const p of primaries(info)) {
    if (p.end !== p.start + 1 || !isIdent(toks[p.start]) || !isValuePosition(info, p)) continue;
    const wholeValue = expr !== null && p.start === expr[0] && p.end === expr[1];
    if (depthBefore(toks, p.start) <= 0 && !wholeValue) continue;
    const name = toks[p.start]!.text;
    for (const other of substitutesFor(name, ctx.valueNames).slice(0, MAX_BINOP_IDS)) {
      out.push(splice(toks, p.end, p.end, frag(`- ${other}`, ' '), false), splice(toks, p.end, p.end, frag(`+ ${other}`, ' '), false));
    }
  }
  return out;
};

/** Insert-site statements over pairs of in-scope names (the missing-statement shapes QuixBugs and the ladder need). */
export function statementTemplates(ctx: MutationContext): Tok[][] {
  const out: Tok[][] = [];
  const ids = ctx.valueNames.slice(0, MAX_TEMPLATE_IDS);
  for (const tpl of ['A.append(B)', 'A.add(B)', 'A = B', 'A += B', 'A.remove(B)', 'A.extend(B)']) {
    for (const a of ids) for (const b of ids) if (a !== b) out.push(frag(tpl.replace('A', a).replace('B', b)));
  }
  for (const a of ids) for (const s of [`return ${a}`, `${a}.pop()`, `${a} += 1`, `${a} -= 1`]) out.push(frag(s));
  return out;
}

const statementTemplate: Operator = (info, ctx) => (info.toks.length === 0 ? statementTemplates(ctx) : []);

/**
 * A tuple / list / set literal of 2..MAX_COLLAPSE_ELEMENTS elements collapses to each single
 * element: a parenthesised tuple to the bare element (`hash((a, b))` -> `hash(a)`, `hash(b)`), a
 * list or set literal to the one-element literal (`[a, b]` -> `[a]`, `[b]`), and the bare tuple
 * value of an assignment or `return` to each element (`return a, b` -> `return a`). Never a call
 * or subscript (a trailer), a `def`/`class` header, a comprehension, a dict literal or a
 * literal holding a protected name (a `for` target, a keyword-argument name).
 */
const collapseCollectionToElement: Operator = (info) => {
  const out: Tok[][] = [];
  const { toks, head } = info;
  if (head === 'def' || head === 'class' || head === 'import' || head === 'from' || head === 'for' || head === 'with' || head === 'lambda') return out;
  const elementsOf = (from: number, to: number): [number, number][] | null => {
    const parts = splitTopLevel(toks, from, to, ',').filter(([a, b]) => b > a);
    if (parts.length < 2 || parts.length > MAX_COLLAPSE_ELEMENTS) return null;
    for (const p of parts) {
      if (isGenexp(toks, p)) return null;
      // declarations inside the literal (a `for` target, a lambda parameter) make it no value; an
      // attribute name after `.` is protected only against substitution and may stay in an element
      for (let k = p[0]; k < p[1]; k++) if (info.protectedIdx.has(k) && !isOp(toks[k - 1], '.')) return null;
      // a keyword argument or a dict entry is not an element
      if (isOp(toks[p[0] + 1], '=') || isOp(toks[p[0]], '**')) return null;
      for (let k = p[0]; k < p[1]; k++) if (isOp(toks[k], ':') && depthBefore(toks, k) === depthBefore(toks, p[0])) return null;
    }
    return parts;
  };
  for (const kind of ['(', '['] as const) {
    for (const g of groups(toks, kind).filter((g) => !g.trailer)) {
      const parts = elementsOf(g.open + 1, g.close);
      if (parts === null) continue;
      for (const [a, b] of parts) {
        const element = toks.slice(a, b);
        out.push(kind === '(' ? splice(toks, g.open, g.close + 1, element) : splice(toks, g.open + 1, g.close, element));
      }
    }
  }
  toks.forEach((t, k) => {
    if (!isOp(t, '{') || endsOperand(toks[k - 1])) return;
    const close = matchClose(toks, k);
    if (close < 0) return;
    const parts = elementsOf(k + 1, close);
    if (parts === null) return;
    for (const [a, b] of parts) out.push(splice(toks, k + 1, close, toks.slice(a, b)));
  });
  // the bare tuple value: `x = a, b`, `return a, b`
  const expr = valueExpr(info);
  if (expr !== null) {
    const parts = elementsOf(expr[0], expr[1]);
    if (parts !== null) for (const [a, b] of parts) out.push(splice(toks, expr[0], expr[1], toks.slice(a, b)));
  }
  return out;
};

export const OPERATORS: Readonly<Record<OperatorName, Operator>> = {
  relational_swap: relationalSwap,
  boundary_shift: boundaryShift,
  off_by_one_literal: offByOneLiteral,
  off_by_one_atom: offByOneAtom,
  argument_swap: argumentSwap,
  argument_arity: argumentArity,
  index_flip: indexFlip,
  operand_swap: operandSwap,
  arithmetic_swap: arithmeticSwap,
  augassign_swap: augassignSwap,
  boolean_swap: booleanSwap,
  keyword_flip: keywordFlip,
  negation,
  identifier_substitution: identifierSubstitution,
  call_substitution: callSubstitution,
  attribute_substitution: attributeSubstitution,
  constant_substitution: constantSubstitution,
  string_substitution: stringSubstitution,
  slice_tweak: sliceTweak,
  wrap_call: wrapCall,
  unwrap_call: unwrapCall,
  drop_term: dropTerm,
  return_tweak: returnTweak,
  condition_extension: conditionExtension,
  drop_index: dropIndex,
  method_to_assign: methodToAssign,
  binop_with_identifier: binopWithIdentifier,
  statement_template: statementTemplate,
  collapse_collection_to_element: collapseCollectionToElement,
};

/** Apply one operator to a line's tokens. */
export function applyOperator(op: OperatorName, toks: readonly Tok[], ctx: MutationContext): Tok[][] {
  return OPERATORS[op](lineInfo(toks), ctx);
}
