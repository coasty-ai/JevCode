/**
 * Sketch productions P1–P13 for the Jev-only synthesizer (docs/JEV-ONLY-DESIGN.md §3 source 5
 * and §6 `sketch/`; experiments/designs/grammar-synthesis.md §1.4 and Appendix A, pilot script
 * experiments/grammar-synthesis/sketch-probe.mts). A sketch keeps every token of the site line
 * literally except the ones a production changes: `_` stands for one identifier, number, string
 * or True/False/None still to be chosen, `<op>` for one operator. Code proposes the pool, the Q12
 * Choice picks a shape, the slot beam (../fill) fills the holes and the tests decide.
 *
 * Measured basis (Appendix A, offline over the 40 QuixBugs programs): a pool built from this table
 * holds a shape the gold line instantiates on 39/40 (median 64, max 138 sketches, never capped;
 * only the two-edit `shortest_paths` is out), the four insertions included. The table, the
 * grammar preconditions, the `change` descriptions and the priorities are the pilot's, ported
 * onto the shared tokenizer (../beam/tokens.ts classes tokens exactly as the pilot did) so the
 * pool this module builds is the pool that was measured. P12 (two-line guard) and P13 (donor
 * shapes) are additions the design asks for; they sit after the measured productions in the
 * order so they never displace a measured sketch under the cap.
 */
import { indentOf } from '../py/edits.js';
import { nearDuplicates } from '../py/similarity.js';
import type { PyModule } from '../py/structure.js';
import { toks } from '../beam/tokens.js';
import type { Tok } from '../beam/tokens.js';
import type { EnumerateOptions, LineEdit, Site } from '../types.js';

export const HOLE = '_';
export const OP_HOLE = '<op>';
export const HOLE_TOK: Tok = { text: HOLE, cls: 'identifier' };
export const OP_HOLE_TOK: Tok = { text: OP_HOLE, cls: 'operator' };

export type ProductionId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9' | 'P10' | 'P11' | 'P12' | 'P13';
export const PRODUCTION_IDS: readonly ProductionId[] = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12', 'P13'];

/** The six Q7 edit classes (measured wording in ./questions.ts). */
export type EditClass = 'substitute_one_token' | 'insert_fragment' | 'delete_fragment' | 'reorder_tokens' | 'reshape_line' | 'insert_new_line';
export const EDIT_CLASS_IDS: readonly EditClass[] = ['substitute_one_token', 'insert_fragment', 'delete_fragment', 'reorder_tokens', 'reshape_line', 'insert_new_line'];

/** Near-duplicate donors (P13) taken per site: the design's "≤ 20 nearest by normalised-token similarity". */
export const MAX_DONOR_SHAPES = 20;
/** Normalised-token similarity a donor line needs (beam/templates.ts DONOR_THRESHOLD; probe-donor: Jaccard ≥ 0.5 on 33/36 fixes). */
export const DONOR_SIMILARITY_THRESHOLD = 0.5;

export interface Sketch {
  toks: Tok[];
  production: ProductionId;
  /** the `change` field of the Q12 option description (measured wording) */
  change: string;
  /** pool order, lower first: the pilot's priorities (they only matter when the 254 cap bites) */
  prio: number;
  /** follow-up lines of a multi-line sketch (P12), holes included; line numbers are pre-edit (verify/apply.ts) */
  extraEdits?: LineEdit[];
}

// ---------------------------------------------------------------------------------------
// Token helpers (the pilot's predicates)
// ---------------------------------------------------------------------------------------

const p = (text: string): Tok => ({ text, cls: 'punct' });
const kw = (text: string): Tok => ({ text, cls: 'keyword' });
const op = (text: string): Tok => ({ text, cls: 'operator' });
const NONE: Tok = { text: 'None', cls: 'literal' };

export function isHoleText(text: string): boolean {
  return text === HOLE || text === OP_HOLE;
}
export function isHoleTok(t: Tok | undefined): boolean {
  return t !== undefined && isHoleText(t.text);
}
/** A token `_` may stand for: identifier, number, string, True/False/None. */
export function isHoleable(t: Tok | undefined): boolean {
  return t !== undefined && (t.cls === 'identifier' || t.cls === 'number' || t.cls === 'string' || t.cls === 'literal');
}
/** A token that ends a value: a holeable token or a closing bracket. */
function isValue(t: Tok | undefined): boolean {
  return isHoleable(t) || (t !== undefined && (t.text === ')' || t.text === ']' || t.text === '}'));
}
/** Binary operator (not `=`, not an augmented assignment; the four two-character comparisons count). */
function isBinOp(t: Tok | undefined): boolean {
  if (t === undefined || t.cls !== 'operator') return false;
  if (t.text === '==' || t.text === '!=' || t.text === '<=' || t.text === '>=') return true;
  return !t.text.endsWith('=');
}
function startsOperand(prev: Tok | undefined): boolean {
  return prev === undefined || prev.cls === 'operator' || prev.cls === 'keyword' || prev.text === '(' || prev.text === '[' || prev.text === '{' || prev.text === ',' || prev.text === ':';
}
function isOpen(t: Tok | undefined): boolean {
  return t !== undefined && (t.text === '(' || t.text === '[' || t.text === '{');
}
function isClose(t: Tok | undefined): boolean {
  return t !== undefined && (t.text === ')' || t.text === ']' || t.text === '}');
}
const CLOSER: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

/** Index of the bracket closing the open bracket at `open`, or -1. */
function matchClose(ts: readonly Tok[], open: number): number {
  const o = ts[open];
  if (o === undefined) return -1;
  const want = CLOSER[o.text];
  if (want === undefined) return -1;
  let depth = 0;
  for (let k = open; k < ts.length; k++) {
    const t = ts[k]!;
    if (t.text === o.text) depth++;
    else if (t.text === want) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}
/** Bracket depth before token `upto`. */
function depthBefore(ts: readonly Tok[], upto: number): number {
  let d = 0;
  for (let k = 0; k < upto; k++) {
    const t = ts[k]!;
    if (isOpen(t)) d++;
    else if (isClose(t)) d--;
  }
  return d;
}
/** A compound header: starts with a keyword and ends with `:`. */
function isHeader(ts: readonly Tok[]): boolean {
  const first = ts[0];
  const last = ts[ts.length - 1];
  return first !== undefined && last !== undefined && first.cls === 'keyword' && last.text === ':';
}
/** First token of a statement's right-hand side (`return X`, `yield X`, `lhs = X`, augmented too), or -1. */
function statementRhsStart(ts: readonly Tok[]): number {
  const first = ts[0];
  if (first === undefined) return -1;
  if (first.cls === 'keyword' && (first.text === 'return' || first.text === 'yield')) return 1;
  const eq = ts.findIndex((t, i) => t.cls === 'operator' && t.text.endsWith('=') && !isBinOp(t) && depthBefore(ts, i) === 0);
  return eq >= 0 ? eq + 1 : -1;
}

/**
 * Maximal operand spans `[i, j]` (inclusive): a name/literal with its trailers (`x[i]`, `f(a)`,
 * `a.b`), or a bracket group with trailers. Attribute names after `.` do not start a span.
 */
function operandSpans(ts: readonly Tok[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!;
    if (!(isHoleable(t) || t.text === '(' || t.text === '[')) continue;
    if (i > 0 && ts[i - 1]!.text === '.') continue;
    // a bracket right after a value is a call/subscript trailer of that value, not an operand of its own
    if ((t.text === '(' || t.text === '[') && isValue(ts[i - 1])) continue;
    let j = i;
    if (t.text === '(' || t.text === '[') {
      const c = matchClose(ts, i);
      if (c < 0) continue;
      j = c;
    }
    for (;;) {
      const nx = ts[j + 1];
      if (nx !== undefined && (nx.text === '(' || nx.text === '[') && isValue(ts[j])) {
        const c = matchClose(ts, j + 1);
        if (c < 0) break;
        j = c;
        continue;
      }
      if (nx !== undefined && nx.text === '.' && ts[j + 2]?.cls === 'identifier') {
        j += 2;
        continue;
      }
      break;
    }
    if (j > i || isHoleable(t)) out.push([i, j]);
  }
  return out;
}

/** Abstract the tokens at `changed`: names/literals → `_`, operators other than `=` → `<op>`. */
export function abstractTokens(ts: readonly Tok[], changed: ReadonlySet<number>): Tok[] {
  return ts.map((t, i) => {
    if (!changed.has(i)) return t;
    if (t.cls === 'operator' && t.text !== '=') return OP_HOLE_TOK;
    return isHoleable(t) ? HOLE_TOK : t;
  });
}
/** Every name and literal → `_`; operators stay (a donor's shape, beam/templates.ts style). */
export function shapeOf(ts: readonly Tok[]): Tok[] {
  return ts.map((t) => (isHoleable(t) ? HOLE_TOK : t));
}
/** Every name, literal and operator abstracted (the pilot's own-line shapes for insert sites). */
export function fullyAbstract(ts: readonly Tok[]): Tok[] {
  return abstractTokens(ts, new Set(ts.map((_, i) => i)));
}

// ---------------------------------------------------------------------------------------
// Fragment and template tables (pilot wording and priorities)
// ---------------------------------------------------------------------------------------

type Entry = readonly [toks: readonly Tok[], change: string, prio: number];

const FRAGMENTS_AFTER_VALUE: readonly Entry[] = [
  [[OP_HOLE_TOK, HOLE_TOK], 'add an operator and an operand after this token (e.g. `+ 1`, `- k`, `** 2`)', 1],
  [[p('['), HOLE_TOK, p(':'), p(']')], 'add a slice from an index to the end', 2],
  [[p('['), p(':'), HOLE_TOK, p(']')], 'add a slice from the start to an index', 3],
  [[p('['), HOLE_TOK, p(']')], 'add an index', 3],
  [[p('['), HOLE_TOK, p(':'), HOLE_TOK, p(']')], 'add a slice with two bounds', 4],
  [[kw('or'), HOLE_TOK], 'add an `or` condition', 2],
  [[kw('or'), kw('not'), HOLE_TOK], 'add an `or not` condition', 2],
  [[kw('and'), HOLE_TOK], 'add an `and` condition', 2],
  [[kw('and'), kw('not'), HOLE_TOK], 'add an `and not` condition', 3],
  [[kw('or'), HOLE_TOK, kw('is'), NONE], 'add an `or x is None` condition', 3],
];
const FRAGMENTS_BEFORE_VALUE: readonly Entry[] = [
  [[HOLE_TOK, OP_HOLE_TOK], 'put an operand and an operator in front of this expression (e.g. `rest +`)', 2],
  [[kw('not')], 'negate this expression', 3],
  [[HOLE_TOK, kw('is'), NONE, kw('or')], 'guard with `x is None or` in front of this condition', 2],
  [[HOLE_TOK, kw('is'), kw('not'), NONE, kw('and')], 'guard with `x is not None and` in front of this condition', 3],
];
const RHS_TEMPLATES: readonly Entry[] = [
  [[HOLE_TOK], 'replace the value by a single name or literal', 1],
  [[HOLE_TOK, OP_HOLE_TOK, HOLE_TOK], 'replace the value by a binary expression', 2],
  [[p('['), HOLE_TOK, p(']')], 'replace the value by a one-element list', 2],
  [[p('['), p('['), p(']'), p(']')], 'replace the value by a list holding one empty list', 3],
  [[p('['), p(']')], 'replace the value by an empty list', 3],
  [[HOLE_TOK, p('('), HOLE_TOK, p(')')], 'replace the value by a call with one argument', 3],
  [[HOLE_TOK, p('('), HOLE_TOK, p(','), HOLE_TOK, p(')')], 'replace the value by a call with two arguments', 3],
  [[kw('not'), HOLE_TOK], 'replace the value by a negation', 3],
  [[HOLE_TOK, p('['), HOLE_TOK, p(']')], 'replace the value by an indexed name', 3],
  [[NONE], 'replace the value by None', 4],
];
const INSERT_TEMPLATES: readonly Entry[] = [
  [[HOLE_TOK, p('.'), HOLE_TOK, p('('), HOLE_TOK, p(')')], 'call a method with one argument (e.g. `xs.append(x)`)', 1],
  [[HOLE_TOK, op('='), HOLE_TOK], 'assign one name to another', 1],
  [[HOLE_TOK, op('='), HOLE_TOK, OP_HOLE_TOK, HOLE_TOK], 'assign a binary expression', 2],
  [[HOLE_TOK, p('.'), HOLE_TOK, p('('), p(')')], 'call a method with no argument', 2],
  [[kw('return'), HOLE_TOK], 'return a value', 2],
  [[HOLE_TOK, op('+='), HOLE_TOK], 'add to a counter', 3],
  [[kw('if'), HOLE_TOK, p(':')], 'open an if block', 3],
  [[kw('continue')], 'continue the loop', 4],
  [[kw('break')], 'break out of the loop', 4],
  [[HOLE_TOK, op('='), HOLE_TOK, p('.'), HOLE_TOK], 'assign an attribute to a name', 3],
  [[HOLE_TOK, p('.'), HOLE_TOK, op('='), HOLE_TOK], 'assign a name to an attribute', 3],
];
/** P12 bodies under `if _ <op> _:` (TBar FP2/FP4; coverage-study `guard_insertion`: 3 SWE hunks). */
const GUARD_BODIES: readonly Entry[] = [
  [[kw('return'), HOLE_TOK], 'guard: open an if block and return a value from it', 2],
  [[kw('raise'), HOLE_TOK], 'guard: open an if block and raise an exception from it', 3],
  [[kw('continue')], 'guard: open an if block that skips the rest of the loop body', 3],
];
const OWN_LINE_CHANGE = 'the shape of an existing line of `program`, names and literals to be chosen';
const DONOR_CHANGE = 'the shape of a similar line elsewhere, names and literals to be chosen';

// ---------------------------------------------------------------------------------------
// Replace-site productions P1–P10 (the pilot's buildPool, one function per production)
// ---------------------------------------------------------------------------------------

type Emit = (toks: readonly Tok[], production: ProductionId, change: string, prio: number) => void;

function p1HoleAtToken(B: readonly Tok[], emit: Emit): void {
  for (let i = 0; i < B.length; i++) {
    const t = B[i]!;
    if (t.cls === 'operator') emit(B.map((x, k) => (k === i ? OP_HOLE_TOK : x)), 'P1', 'change one operator', 1);
    else if (isHoleable(t)) emit(B.map((x, k) => (k === i ? HOLE_TOK : x)), 'P1', 'change one name or literal', 1);
  }
}

function p2OperatorAndOperand(B: readonly Tok[], emit: Emit): void {
  for (let i = 0; i < B.length - 1; i++) {
    if (isBinOp(B[i]) && isHoleable(B[i + 1])) emit(B.map((x, k) => (k === i ? OP_HOLE_TOK : k === i + 1 ? HOLE_TOK : x)), 'P2', 'change an operator and its right operand', 2);
  }
}

function p3FragmentAfterValue(B: readonly Tok[], emit: Emit): void {
  const n = B.length;
  const header = isHeader(B);
  const isReturn = B[0]?.text === 'return';
  for (let g = 1; g <= n; g++) {
    const prev = B[g - 1]!;
    if (!isValue(prev)) continue;
    const atEnd = g === n || (header && g === n - 1);
    const depth0 = depthBefore(B, g) === 0;
    for (const [frag, change, prio] of FRAGMENTS_AFTER_VALUE) {
      const first = frag[0]!;
      // boolean fragments only at depth 0 of a header or a return (a condition, not an argument)
      if (first.cls === 'keyword' && !(depth0 && (header || isReturn))) continue;
      // subscripts only after a name or a closing bracket, never after a literal
      if (first.text === '[' && !(prev.cls === 'identifier' || prev.text === ')' || prev.text === ']')) continue;
      emit([...B.slice(0, g), ...frag, ...B.slice(g)], 'P3', change, prio + (atEnd ? 0 : 1));
    }
  }
}

function p4FragmentBeforeValue(B: readonly Tok[], emit: Emit): void {
  const header = isHeader(B);
  for (let g = 0; g < B.length; g++) {
    const t = B[g]!;
    if (!startsOperand(B[g - 1]) || !(isHoleable(t) || t.text === '(' || t.text === '[')) continue;
    if (B[g - 1]?.text === '.') continue;
    for (const [frag, change, prio] of FRAGMENTS_BEFORE_VALUE) {
      const guard = frag.length > 1 && frag[1]!.text === 'is';
      if (guard && !(header && depthBefore(B, g) === 0)) continue;
      emit([...B.slice(0, g), ...frag, ...B.slice(g)], 'P4', change, prio);
    }
  }
}

function p5WrapSpan(B: readonly Tok[], emit: Emit): void {
  const n = B.length;
  const header = isHeader(B);
  const rhs = statementRhsStart(B);
  const spans = operandSpans(B);
  if (rhs >= 0 && rhs < n) spans.push([rhs, header ? n - 2 : n - 1]);
  const seen = new Set<string>();
  for (const [i, j] of spans) {
    const k = `${i}-${j}`;
    if (seen.has(k) || j < i) continue;
    seen.add(k);
    const before = B.slice(0, i);
    const inner = B.slice(i, j + 1);
    const after = B.slice(j + 1);
    emit([...before, HOLE_TOK, p('('), ...inner, p(')'), ...after], 'P5', 'wrap an expression in a call', 2);
    emit([...before, HOLE_TOK, p('('), HOLE_TOK, p(','), ...inner, p(')'), ...after], 'P5', 'wrap an expression in a two-argument call with a new first argument (e.g. `max(0, x)`)', 2);
    emit([...before, HOLE_TOK, p('('), ...inner, p(','), HOLE_TOK, p(')'), ...after], 'P5', 'wrap an expression in a two-argument call with a new second argument', 3);
  }
}

function p6Deletions(B: readonly Tok[], emit: Emit): void {
  const n = B.length;
  for (let i = 0; i < n - 1; i++) {
    if (isHoleable(B[i]) && isBinOp(B[i + 1])) emit([...B.slice(0, i), ...B.slice(i + 2)], 'P6', 'delete an operand and the operator after it', 2);
    if (isBinOp(B[i]) && isHoleable(B[i + 1]) && i > 0) emit([...B.slice(0, i), ...B.slice(i + 2)], 'P6', 'delete an operator and the operand after it', 2);
  }
  for (let i = 0; i < n; i++) {
    const t = B[i]!;
    if (t.cls === 'identifier' && B[i + 1]?.text === '(' && B[i - 1]?.text !== '.') {
      const c = matchClose(B, i + 1);
      if (c > i + 2) emit([...B.slice(0, i), ...B.slice(i + 2, c), ...B.slice(c + 1)], 'P6', 'remove a call wrapper, keeping its argument', 2);
    }
    if (t.text === '(' && B[i - 1] !== undefined && !isValue(B[i - 1])) {
      const c = matchClose(B, i);
      if (c > i + 1) emit([...B.slice(0, i), ...B.slice(i + 1, c), ...B.slice(c + 1)], 'P6', 'remove redundant parentheses', 4);
    }
    if (t.cls === 'keyword' && t.text === 'not') emit([...B.slice(0, i), ...B.slice(i + 1)], 'P6', 'remove a negation', 3);
  }
}

function p7Swaps(B: readonly Tok[], emit: Emit): void {
  const n = B.length;
  // adjacent arguments / elements inside a bracket group
  for (let i = 0; i < n; i++) {
    if (!(B[i]!.text === '(' || B[i]!.text === '[')) continue;
    const c = matchClose(B, i);
    if (c < 0) continue;
    const parts: [number, number][] = [];
    let s = i + 1;
    let d = 0;
    for (let k = i + 1; k < c; k++) {
      const t = B[k]!.text;
      if (t === '(' || t === '[') d++;
      else if (t === ')' || t === ']') d--;
      else if (t === ',' && d === 0) {
        parts.push([s, k - 1]);
        s = k + 1;
      }
    }
    parts.push([s, c - 1]);
    for (let a = 0; a + 1 < parts.length; a++) {
      const [a0, a1] = parts[a]!;
      const [b0, b1] = parts[a + 1]!;
      if (a1 < a0 || b1 < b0) continue;
      emit([...B.slice(0, a0), ...B.slice(b0, b1 + 1), B[a1 + 1]!, ...B.slice(a0, a1 + 1), ...B.slice(b1 + 1)], 'P7', 'swap two adjacent arguments or elements', 1);
    }
  }
  // operands around a binary operator
  const spans = operandSpans(B);
  for (let i = 1; i < n - 1; i++) {
    if (!isBinOp(B[i])) continue;
    const L = spans.filter(([, j]) => j === i - 1).sort((x, y) => x[0] - y[0])[0];
    const R = spans.filter(([s0]) => s0 === i + 1).sort((x, y) => y[1] - x[1])[0];
    if (L === undefined || R === undefined) continue;
    emit([...B.slice(0, L[0]), ...B.slice(R[0], R[1] + 1), B[i]!, ...B.slice(L[0], L[1] + 1), ...B.slice(R[1] + 1)], 'P7', 'swap the two operands of an operator', 1);
  }
}

function p8ExpressionToHole(B: readonly Tok[], emit: Emit): void {
  for (const [i, j] of operandSpans(B)) if (j > i) emit([...B.slice(0, i), HOLE_TOK, ...B.slice(j + 1)], 'P8', 'replace a whole sub-expression by one name', 2);
}

function p9MethodCallToAssignment(B: readonly Tok[], emit: Emit): void {
  const n = B.length;
  for (let i = 0; i < n; i++) {
    if (B[i]!.text === '.' && B[i + 1]?.cls === 'identifier' && B[i + 2]?.text === '(') {
      const c = matchClose(B, i + 2);
      if (c === n - 1 && c > i + 3) emit([...B.slice(0, i), op('='), ...B.slice(i + 3, c)], 'P9', 'turn a method call into an assignment of its argument', 3);
    }
  }
}

function p10RhsTemplates(B: readonly Tok[], emit: Emit): void {
  const n = B.length;
  const rhs = statementRhsStart(B);
  if (rhs < 0 || rhs >= n) return;
  const header = isHeader(B);
  for (const [t, change, prio] of RHS_TEMPLATES) emit([...B.slice(0, rhs), ...t, ...(header ? [B[n - 1]!] : [])], 'P10', change, prio);
}

/** P1–P10 over the tokens of a replace site's current line. */
export function replaceProductions(B: readonly Tok[]): Sketch[] {
  const out: Sketch[] = [];
  const emit: Emit = (ts, production, change, prio) => {
    if (ts.length > 0) out.push({ toks: [...ts], production, change, prio });
  };
  if (B.length === 0) return out;
  p1HoleAtToken(B, emit);
  p2OperatorAndOperand(B, emit);
  p3FragmentAfterValue(B, emit);
  p4FragmentBeforeValue(B, emit);
  p5WrapSpan(B, emit);
  p6Deletions(B, emit);
  p7Swaps(B, emit);
  p8ExpressionToHole(B, emit);
  p9MethodCallToAssignment(B, emit);
  p10RhsTemplates(B, emit);
  return out;
}

// ---------------------------------------------------------------------------------------
// Insert-site productions P11, P12
// ---------------------------------------------------------------------------------------

/** Single-line statements of a module that can lend a shape (no def/class headers, decorators, docstrings). */
export function donorLines(mod: PyModule): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (const s of mod.statements) {
    if (s.startLine !== s.endLine || s.tokens.length === 0) continue;
    if (s.kind === 'def' || s.kind === 'class' || s.kind === 'decorator') continue;
    if (s.tokens.length === 1 && s.tokens[0]!.type === 'STRING') continue;
    out.push({ line: s.startLine, text: s.text.trim() });
  }
  return out;
}

/** One indentation level below `indent`, in the file's own style. */
function indentUnit(indent: string): string {
  return indent.includes('\t') ? '\t' : '    ';
}

/** Statements Python compiles only inside a loop body; a template emitting one is gated on `inLoop`. */
const LOOP_ONLY_STATEMENTS: ReadonlySet<string> = new Set(['continue', 'break']);

/**
 * Is the site inside a `for`/`while` body of its enclosing block? py/structure.ts models only
 * `def`/`class` blocks, so this walks the indentation upward: from the site to the nearest
 * less-indented header, then to the next, until a loop header (loop context) or the `def`/
 * `class` line (none) is met. A `for … else:` puts its `else` at the loop's own indentation, so
 * the walk skips the `for` and correctly reports no loop there. Why: §3 says every source is
 * compile-filtered, and `continue`/`break` outside a loop is a SyntaxError that would cost a test
 * run in SIEVE mode or a Choice option in RANK mode.
 */
export function inLoop(site: Site): boolean {
  const lines = site.file.mod.lines;
  const floor = site.block?.startLine ?? 1;
  let indent = site.indent.length;
  for (let l = site.line - 1; l >= floor; l--) {
    const text = lines[l - 1];
    if (text === undefined) continue;
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const ind = indentOf(text).length;
    if (ind >= indent) continue;
    indent = ind;
    const head = toks(trimmed)[0];
    if (head === undefined) continue;
    if (head.text === 'for' || head.text === 'while') return true;
    if (head.text === 'def' || head.text === 'class') return false;
  }
  return false;
}

/** A one-token `continue` / `break` statement. */
function isLoopOnly(ts: readonly Tok[]): boolean {
  return ts.length === 1 && LOOP_ONLY_STATEMENTS.has(ts[0]!.text);
}

/**
 * P11: statement templates, then the fully abstracted shapes of the enclosing block's own lines.
 * `continue` / `break` (as a template or as an own-line shape) only inside a loop body.
 */
export function insertTemplates(site: Site): Sketch[] {
  const out: Sketch[] = [];
  const loop = inLoop(site);
  for (const [t, change, prio] of INSERT_TEMPLATES) {
    if (!loop && isLoopOnly(t)) continue;
    out.push({ toks: [...t], production: 'P11', change, prio });
  }
  const lines = donorLines(site.file.mod).filter((d) => site.block === null || (d.line >= site.block.startLine && d.line <= site.block.endLine));
  for (const d of lines) {
    const ts = toks(d.text);
    if (ts.length === 0 || ts[0]!.text === 'def' || ts[0]!.text === 'class') continue;
    if (!loop && isLoopOnly(ts)) continue;
    out.push({ toks: fullyAbstract(ts), production: 'P11', change: OWN_LINE_CHANGE, prio: 3 });
  }
  return out;
}

/**
 * P12: two-line guard `if _ <op> _:` with a `return _` / `raise _` / `continue` body as an extra
 * insert; the `continue` body only inside a loop.
 */
export function guardTemplates(site: Site): Sketch[] {
  const header = [kw('if'), HOLE_TOK, OP_HOLE_TOK, HOLE_TOK, p(':')];
  const bodyIndent = site.indent + indentUnit(site.indent);
  const loop = inLoop(site);
  return GUARD_BODIES.filter(([body]) => loop || !isLoopOnly(body)).map(([body, change, prio]) => ({
    toks: header,
    production: 'P12',
    change,
    prio,
    // the body is inserted before the same original line; verify/apply.ts lands it below the header
    extraEdits: [{ path: site.file.path, line: site.line, kind: 'insert', text: bodyIndent + body.map((t) => t.text).join(' ') }],
  }));
}

// ---------------------------------------------------------------------------------------
// P13: donor shapes from the file and the corpus
// ---------------------------------------------------------------------------------------

/** The lines a donor is compared with: the current line, or the gap's neighbours at an insert site. */
function referenceLines(site: Site): string[] {
  if (site.kind === 'replace') return [site.currentLine.trim()];
  const lines = site.file.mod.lines;
  return [lines[site.line - 2], lines[site.line - 1]].filter((l): l is string => l !== undefined && l.trim().length > 0).map((l) => l.trim());
}

/**
 * P13: ≤ 20 near-duplicate lines of the file (site line excluded) and the corpus, best similarity
 * first, names and literals abstracted. Deterministic: file before corpus, corpus in map order.
 */
export function donorShapes(site: Site, opts: EnumerateOptions): Sketch[] {
  const refs = referenceLines(site);
  if (refs.length === 0) return [];
  const pool: { text: string; score: number; order: number }[] = [];
  let order = 0;
  const consider = (lines: readonly string[]): void => {
    for (const ref of refs) {
      for (const d of nearDuplicates(ref, lines, DONOR_SIMILARITY_THRESHOLD, { excludeExact: true })) pool.push({ text: d.line, score: d.score, order: order++ });
    }
  };
  consider(donorLines(site.file.mod).filter((d) => site.kind === 'insert' || d.line !== site.line).map((d) => d.text));
  for (const [path, file] of opts.corpus) {
    if (path === site.file.path) continue;
    consider(donorLines(file.mod).map((d) => d.text));
  }
  pool.sort((a, b) => b.score - a.score || a.order - b.order);
  const out: Sketch[] = [];
  const seen = new Set<string>();
  for (const d of pool) {
    if (out.length >= MAX_DONOR_SHAPES) break;
    const ts = toks(d.text);
    if (ts.length === 0 || ts[0]!.text === 'def' || ts[0]!.text === 'class') continue;
    const shape = shapeOf(ts);
    const key = shape.map((t) => t.text).join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ toks: shape, production: 'P13', change: DONOR_CHANGE, prio: 5 });
  }
  return out;
}

/** Every production applicable at the site, in production order (pool.ts orders, dedupes and caps). */
export function productionsFor(site: Site, opts: EnumerateOptions): Sketch[] {
  if (site.kind === 'insert') return [...insertTemplates(site), ...guardTemplates(site), ...donorShapes(site, opts)];
  return [...replaceProductions(toks(site.currentLine)), ...donorShapes(site, opts)];
}

// ---------------------------------------------------------------------------------------
// Shared helpers: hole indices, instantiation, string ↔ token round trip, edit classes
// ---------------------------------------------------------------------------------------

/** Indices of `_` and `<op>` tokens. */
export function holeIndices(ts: readonly (Tok | string)[]): number[] {
  const out: number[] = [];
  ts.forEach((t, i) => {
    if (isHoleText(typeof t === 'string' ? t : t.text)) out.push(i);
  });
  return out;
}

/** Keyword operators a `<op>` hole may take besides symbolic ones (the measured 24-operator slot set). */
const KEYWORD_OPERATORS: ReadonlySet<string> = new Set(['and', 'or', 'not', 'in', 'is']);

/**
 * Does `line` instantiate `sketch` (Appendix A's coverage definition): same length, literal tokens
 * equal, `_` over a name/literal, `<op>` over an operator (symbolic or `and`/`or`/`not`/`in`/`is`)?
 */
export function instantiates(sketch: readonly (Tok | string)[], line: readonly Tok[]): boolean {
  if (sketch.length !== line.length) return false;
  return sketch.every((s, i) => {
    const text = typeof s === 'string' ? s : s.text;
    const t = line[i]!;
    if (text === HOLE) return isHoleable(t);
    if (text === OP_HOLE) return t.cls === 'operator' || KEYWORD_OPERATORS.has(t.text);
    return text === t.text;
  });
}

/** A classified token for one token text (`_` and `<op>` are the hole tokens; anything else re-tokenizes). */
export function tokOf(text: string): Tok {
  if (text === HOLE) return HOLE_TOK;
  if (text === OP_HOLE) return OP_HOLE_TOK;
  if (KEYWORD_OPERATORS.has(text)) return kw(text);
  const ts = toks(text);
  const only = ts.length === 1 ? ts[0] : undefined;
  return only !== undefined ? only : { text, cls: 'identifier' };
}

/** Tokens of a hypothesis stored as strings (search/types.ts SketchHypothesis.toks). */
export function hypothesisToks(texts: readonly string[]): Tok[] {
  return texts.map(tokOf);
}

/**
 * Q7 edit classes a production's sketches belong to (grammar-synthesis.md §1.4 gold columns).
 * P10 is both a reshape (`return _ <op> _`) and an insertion (`return []` → `return [_]`); P13
 * is a new line at a gap and a reshape at a replace site.
 */
export function editClassesOf(production: ProductionId, siteKind: Site['kind']): EditClass[] {
  switch (production) {
    case 'P1':
    case 'P2':
      return ['substitute_one_token'];
    case 'P3':
    case 'P4':
    case 'P5':
      return ['insert_fragment'];
    case 'P6':
      return ['delete_fragment'];
    case 'P7':
      return ['reorder_tokens'];
    case 'P8':
    case 'P9':
      return ['reshape_line'];
    case 'P10':
      return ['reshape_line', 'insert_fragment'];
    case 'P11':
    case 'P12':
      return ['insert_new_line'];
    case 'P13':
      return siteKind === 'insert' ? ['insert_new_line'] : ['reshape_line'];
  }
}
