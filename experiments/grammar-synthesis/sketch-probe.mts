/**
 * Sketch-Choice pilot (D3 of the grammar-synthesis design): can Jev pick the SHAPE of the fix
 * line among code-built sketches of the buggy line? A sketch keeps every token of the buggy line
 * literally except the ones a production changes: `_` = one identifier/number/string/literal
 * still to be chosen, `<op>` = one operator still to be chosen. Productions (code, no Jev):
 *   hole_at_token, operator_and_operand_hole, insert_fragment_at_gap (fragment table),
 *   wrap_span_in_call, delete_token / delete_pair / unwrap_call, swap_arguments / swap_operands,
 *   expression_to_hole, method_call_to_assignment, rhs_template, and for insertions the
 *   statement templates plus abstracted shapes of the program's own lines.
 * Gold sketch = fix line with the tokens not in the LCS with the buggy line abstracted the same way.
 * Also asks, in the same request, the edit-class Choice (D1) and reports both.
 *
 * Usage:
 *   node_modules/.bin/tsx experiments/grammar-synthesis/sketch-probe.mts offline        # pool coverage, no Jev
 *   env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/grammar-synthesis/sketch-probe.mts live [runTag]
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus, tokenize, detokenize, makeJev, pool, p50, MARK, type Item, type Tok } from '../probe-tokens/common.mts';
import { choice, contextNoul } from '../../src/jev/questions.ts';
import type { Json, Question } from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODE = process.argv[2] ?? 'offline'; // offline | live | live-nouls
const WITH_NOULS = MODE === 'live-nouls';
const TAG = process.argv[3] ?? 'run1';
const CAP = 254;

const HOLE: Tok = { text: '_', cls: 'identifier' };
const OPH: Tok = { text: '<op>', cls: 'identifier' };
const isValue = (t: Tok | undefined): boolean => !!t && (t.cls === 'identifier' || t.cls === 'number' || t.cls === 'string' || t.cls === 'literal' || t.text === ')' || t.text === ']' || t.text === '}');
const isHoleable = (t: Tok): boolean => t.cls === 'identifier' || t.cls === 'number' || t.cls === 'string' || t.cls === 'literal';
const isBinOp = (t: Tok | undefined): boolean => !!t && t.cls === 'operator' && !t.text.endsWith('=') && t.text !== '=' || !!t && ['==', '!=', '<=', '>='].includes(t.text);
const startsOperand = (prev: Tok | undefined): boolean => !prev || prev.cls === 'operator' || prev.cls === 'keyword' || ['(', '[', '{', ',', ':'].includes(prev.text);
const key = (toks: Tok[]): string => toks.map((t) => t.text).join(' ');

/** abstract changed tokens: names/literals -> `_`, operators -> `<op>`, punct/keywords literal */
function abstract(toks: Tok[], changed: Set<number>): Tok[] {
  return toks.map((t, i) => (changed.has(i) ? (t.cls === 'operator' && t.text !== '=' ? OPH : isHoleable(t) ? HOLE : t) : t));
}
function lcsPositionsInB(a: Tok[], b: Tok[]): Set<number> {
  const n = a.length, m = b.length; const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i]!.text === b[j]!.text ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const inB = new Set<number>(); let i = 0, j = 0;
  while (i < n && j < m) { if (a[i]!.text === b[j]!.text) { inB.add(j); i++; j++; } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++; else j++; }
  return inB;
}
function goldSketch(item: Item): { toks: Tok[]; editClass: string } {
  const fix = tokenize(item.fix_line);
  if (item.buggy_line === null) return { toks: abstract(fix, new Set(fix.map((_, i) => i))), editClass: 'insert_new_line' };
  const bug = tokenize(item.buggy_line);
  const keep = lcsPositionsInB(bug, fix); const changed = new Set(fix.map((_, i) => i).filter((i) => !keep.has(i)));
  const keepA = lcsPositionsInB(fix, bug); const removed = bug.length - keepA.size;
  const multiset = (ts: Tok[]) => ts.map((t) => t.text).sort().join('\u0000');
  let editClass = 'reshape_line';
  if (fix.length === bug.length && changed.size === 1) editClass = 'substitute_one_token';
  else if (fix.length === bug.length && changed.size === 2 && multiset(fix) !== multiset(bug) && [...changed].every((i) => i > 0 && changed.has(i - 1) || changed.has(i + 1)) && fix.some((t, i) => changed.has(i) && t.cls === 'operator')) editClass = 'substitute_one_token';
  else if (fix.length > bug.length && removed === 0) editClass = 'insert_fragment';
  else if (fix.length < bug.length && changed.size === 0) editClass = 'delete_fragment';
  else if (multiset(fix) === multiset(bug)) editClass = 'reorder_tokens';
  return { toks: abstract(fix, changed), editClass };
}

// -------------------------------------------------------------------------- productions
interface Sketch { toks: Tok[]; prod: string; prio: number }
const FRAGMENTS_AFTER_VALUE: [Tok[], string, number][] = [
  [[OPH, HOLE], 'add an operator and an operand after this token (e.g. `+ 1`, `- k`, `** 2`)', 1],
  [[{ text: '[', cls: 'punct' }, HOLE, { text: ':', cls: 'punct' }, { text: ']', cls: 'punct' }], 'add a slice from an index to the end', 2],
  [[{ text: '[', cls: 'punct' }, { text: ':', cls: 'punct' }, HOLE, { text: ']', cls: 'punct' }], 'add a slice from the start to an index', 3],
  [[{ text: '[', cls: 'punct' }, HOLE, { text: ']', cls: 'punct' }], 'add an index', 3],
  [[{ text: '[', cls: 'punct' }, HOLE, { text: ':', cls: 'punct' }, HOLE, { text: ']', cls: 'punct' }], 'add a slice with two bounds', 4],
  [[{ text: 'or', cls: 'keyword' }, HOLE], 'add an `or` condition', 2],
  [[{ text: 'or', cls: 'keyword' }, { text: 'not', cls: 'keyword' }, HOLE], 'add an `or not` condition', 2],
  [[{ text: 'and', cls: 'keyword' }, HOLE], 'add an `and` condition', 2],
  [[{ text: 'and', cls: 'keyword' }, { text: 'not', cls: 'keyword' }, HOLE], 'add an `and not` condition', 3],
  [[{ text: 'or', cls: 'keyword' }, HOLE, { text: 'is', cls: 'keyword' }, { text: 'None', cls: 'literal' }], 'add an `or x is None` condition', 3],
];
const FRAGMENTS_BEFORE_VALUE: [Tok[], string, number][] = [
  [[HOLE, OPH], 'put an operand and an operator in front of this expression (e.g. `rest +`)', 2],
  [[{ text: 'not', cls: 'keyword' }], 'negate this expression', 3],
  [[HOLE, { text: 'is', cls: 'keyword' }, { text: 'None', cls: 'literal' }, { text: 'or', cls: 'keyword' }], 'guard with `x is None or` in front of this condition', 2],
  [[HOLE, { text: 'is', cls: 'keyword' }, { text: 'not', cls: 'keyword' }, { text: 'None', cls: 'literal' }, { text: 'and', cls: 'keyword' }], 'guard with `x is not None and` in front of this condition', 3],
];
const RHS_TEMPLATES: [Tok[], string, number][] = [
  [[HOLE], 'replace the value by a single name or literal', 1],
  [[HOLE, OPH, HOLE], 'replace the value by a binary expression', 2],
  [[{ text: '[', cls: 'punct' }, HOLE, { text: ']', cls: 'punct' }], 'replace the value by a one-element list', 2],
  [[{ text: '[', cls: 'punct' }, { text: '[', cls: 'punct' }, { text: ']', cls: 'punct' }, { text: ']', cls: 'punct' }], 'replace the value by a list holding one empty list', 3],
  [[{ text: '[', cls: 'punct' }, { text: ']', cls: 'punct' }], 'replace the value by an empty list', 3],
  [[HOLE, { text: '(', cls: 'punct' }, HOLE, { text: ')', cls: 'punct' }], 'replace the value by a call with one argument', 3],
  [[HOLE, { text: '(', cls: 'punct' }, HOLE, { text: ',', cls: 'punct' }, HOLE, { text: ')', cls: 'punct' }], 'replace the value by a call with two arguments', 3],
  [[{ text: 'not', cls: 'keyword' }, HOLE], 'replace the value by a negation', 3],
  [[HOLE, { text: '[', cls: 'punct' }, HOLE, { text: ']', cls: 'punct' }], 'replace the value by an indexed name', 3],
  [[{ text: 'None', cls: 'literal' }], 'replace the value by None', 4],
];
const INSERT_TEMPLATES: [Tok[], string, number][] = [
  [[HOLE, { text: '.', cls: 'punct' }, HOLE, { text: '(', cls: 'punct' }, HOLE, { text: ')', cls: 'punct' }], 'call a method with one argument (e.g. `xs.append(x)`)', 1],
  [[HOLE, { text: '=', cls: 'operator' }, HOLE], 'assign one name to another', 1],
  [[HOLE, { text: '=', cls: 'operator' }, HOLE, OPH, HOLE], 'assign a binary expression', 2],
  [[HOLE, { text: '.', cls: 'punct' }, HOLE, { text: '(', cls: 'punct' }, { text: ')', cls: 'punct' }], 'call a method with no argument', 2],
  [[{ text: 'return', cls: 'keyword' }, HOLE], 'return a value', 2],
  [[HOLE, { text: '+=', cls: 'operator' }, HOLE], 'add to a counter', 3],
  [[{ text: 'if', cls: 'keyword' }, HOLE, { text: ':', cls: 'punct' }], 'open an if block', 3],
  [[{ text: 'continue', cls: 'keyword' }], 'continue the loop', 4],
  [[{ text: 'break', cls: 'keyword' }], 'break out of the loop', 4],
  [[HOLE, { text: '=', cls: 'operator' }, HOLE, { text: '.', cls: 'punct' }, HOLE], 'assign an attribute to a name', 3],
  [[HOLE, { text: '.', cls: 'punct' }, HOLE, { text: '=', cls: 'operator' }, HOLE], 'assign a name to an attribute', 3],
];

function matchClose(toks: Tok[], open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }; const want = pairs[toks[open]!.text]!; let depth = 0;
  for (let k = open; k < toks.length; k++) { if (toks[k]!.text === toks[open]!.text) depth++; else if (toks[k]!.text === want) { depth--; if (depth === 0) return k; } }
  return -1;
}
/** maximal operand spans: name, name[...], name(...), (...), name.attr... , literal */
function operandSpans(toks: Tok[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!; if (!(isHoleable(t) || ['(', '['].includes(t.text))) continue;
    if (i > 0 && toks[i - 1]!.text === '.') continue;
    let j = i;
    if (['(', '['].includes(t.text)) { const c = matchClose(toks, i); if (c < 0) continue; j = c; }
    for (;;) {
      const nx = toks[j + 1];
      if (nx && ['(', '['].includes(nx.text) && (isValue(toks[j]) )) { const c = matchClose(toks, j + 1); if (c < 0) break; j = c; continue; }
      if (nx && nx.text === '.' && toks[j + 2]?.cls === 'identifier') { j += 2; continue; }
      break;
    }
    if (j > i || isHoleable(t)) out.push([i, j]);
  }
  return out;
}
function statementRhsStart(toks: Tok[]): number {
  const k0 = toks[0]!;
  if (k0.cls === 'keyword' && ['return', 'yield'].includes(k0.text)) return 1;
  const eq = toks.findIndex((t, i) => t.cls === 'operator' && t.text.endsWith('=') && !['==', '!=', '<=', '>='].includes(t.text) && matchDepth(toks, i) === 0);
  return eq >= 0 ? eq + 1 : -1;
}
function matchDepth(toks: Tok[], upto: number): number { let d = 0; for (let k = 0; k < upto; k++) { if (['(', '[', '{'].includes(toks[k]!.text)) d++; else if ([')', ']', '}'].includes(toks[k]!.text)) d--; } return d; }
function isHeader(toks: Tok[]): boolean { return toks[toks.length - 1]?.text === ':' && toks[0]?.cls === 'keyword'; }

function buildPool(item: Item): Sketch[] {
  const sk: Sketch[] = [];
  const add = (toks: Tok[], prod: string, prio: number) => { if (toks.length) sk.push({ toks, prod, prio }); };
  if (item.buggy_line === null) {
    for (const [t, p, pr] of INSERT_TEMPLATES) add(t, p, pr);
    const seen = new Set<string>();
    for (const line of item.buggy_program.split('\n')) {
      const s = line.trim(); if (!s || s.startsWith('def ') || s.startsWith('#') || s.startsWith('return') && false) continue;
      let toks: Tok[]; try { toks = tokenize(s); } catch { continue; }
      if (!toks.length || toks[0]!.text === 'def' || toks[0]!.text === 'class') continue;
      const a = abstract(toks, new Set(toks.map((_, i) => i))); const k = key(a); if (seen.has(k)) continue; seen.add(k);
      add(a, 'the shape of an existing line of `program`, names and literals to be chosen', 3);
    }
    return dedupe(sk);
  }
  const B = tokenize(item.buggy_line); const n = B.length; const header = isHeader(B);
  // 1. one-token hole
  for (let i = 0; i < n; i++) if (isHoleable(B[i]!) || B[i]!.cls === 'operator') add(B.map((t, k) => (k === i ? (t.cls === 'operator' ? OPH : HOLE) : t)), B[i]!.cls === 'operator' ? 'change one operator' : 'change one name or literal', 1);
  // 2. operator + following operand as two holes
  for (let i = 0; i < n - 1; i++) if (isBinOp(B[i]) && isHoleable(B[i + 1]!)) add(B.map((t, k) => (k === i ? OPH : k === i + 1 ? HOLE : t)), 'change an operator and its right operand', 2);
  // 3. fragments after a value
  for (let g = 1; g <= n; g++) {
    const prev = B[g - 1]!; if (!isValue(prev)) continue;
    const atEnd = g === n || (header && g === n - 1); const depth0 = matchDepth(B, g) === 0;
    for (const [frag, p, pr] of FRAGMENTS_AFTER_VALUE) {
      const isBool = frag[0]!.cls === 'keyword';
      if (isBool && !(depth0 && (header || B[0]!.text === 'return'))) continue;
      if (frag[0]!.text === '[' && !(prev.cls === 'identifier' || [')', ']'].includes(prev.text))) continue;
      add([...B.slice(0, g), ...frag, ...B.slice(g)], p, pr + (atEnd ? 0 : 1));
    }
  }
  // 4. fragments before an operand start
  for (let g = 0; g < n; g++) {
    if (!startsOperand(B[g - 1]) || !(isHoleable(B[g]!) || ['(', '['].includes(B[g]!.text))) continue;
    if (B[g - 1]?.text === '.') continue;
    for (const [frag, p, pr] of FRAGMENTS_BEFORE_VALUE) {
      const guard = frag.length > 1 && frag[1]!.text === 'is'; if (guard && !(header && matchDepth(B, g) === 0)) continue;
      add([...B.slice(0, g), ...frag, ...B.slice(g)], p, pr);
    }
  }
  // 5. wrap an operand span in a call: _(span), _(_, span), _(span, _)
  const rhs = statementRhsStart(B);
  const spans = operandSpans(B); if (rhs >= 0 && rhs < n) spans.push([rhs, header ? n - 2 : n - 1]);
  const seenSpan = new Set<string>();
  for (const [i, j] of spans) {
    const k = `${i}-${j}`; if (seenSpan.has(k) || j < i) continue; seenSpan.add(k);
    const before = B.slice(0, i), inner = B.slice(i, j + 1), after = B.slice(j + 1);
    add([...before, HOLE, { text: '(', cls: 'punct' }, ...inner, { text: ')', cls: 'punct' }, ...after], 'wrap an expression in a call', 2);
    add([...before, HOLE, { text: '(', cls: 'punct' }, HOLE, { text: ',', cls: 'punct' }, ...inner, { text: ')', cls: 'punct' }, ...after], 'wrap an expression in a two-argument call with a new first argument (e.g. `max(0, x)`)', 2);
    add([...before, HOLE, { text: '(', cls: 'punct' }, ...inner, { text: ',', cls: 'punct' }, HOLE, { text: ')', cls: 'punct' }, ...after], 'wrap an expression in a two-argument call with a new second argument', 3);
  }
  // 6. deletions: single token (name/literal/operator where grammatical), `X op` / `op X` pairs, unwrap call f(x) -> x
  for (let i = 0; i < n - 1; i++) {
    if (isHoleable(B[i]!) && isBinOp(B[i + 1])) add([...B.slice(0, i), ...B.slice(i + 2)], 'delete an operand and the operator after it', 2);
    if (isBinOp(B[i]) && isHoleable(B[i + 1]!) && i > 0) add([...B.slice(0, i), ...B.slice(i + 2)], 'delete an operator and the operand after it', 2);
  }
  for (let i = 0; i < n; i++) {
    if (B[i]!.cls === 'identifier' && B[i + 1]?.text === '(' && B[i - 1]?.text !== '.') { const c = matchClose(B, i + 1); if (c > i + 2) add([...B.slice(0, i), ...B.slice(i + 2, c), ...B.slice(c + 1)], 'remove a call wrapper, keeping its argument', 2); }
    if (B[i]!.text === '(' && B[i - 1]?.text !== undefined && !isValue(B[i - 1]) ) { const c = matchClose(B, i); if (c > i + 1) add([...B.slice(0, i), ...B.slice(i + 1, c), ...B.slice(c + 1)], 'remove redundant parentheses', 4); }
    if (B[i]!.cls === 'keyword' && B[i]!.text === 'not') add([...B.slice(0, i), ...B.slice(i + 1)], 'remove a negation', 3);
  }
  // 7. swaps: adjacent arguments/elements inside brackets, operands around a binary operator (top-level of the enclosing bracket)
  for (let i = 0; i < n; i++) {
    if (!['(', '['].includes(B[i]!.text)) continue; const c = matchClose(B, i); if (c < 0) continue;
    const parts: [number, number][] = []; let s = i + 1, d = 0;
    for (let k = i + 1; k < c; k++) { const t = B[k]!.text; if (['(', '['].includes(t)) d++; else if ([')', ']'].includes(t)) d--; else if (t === ',' && d === 0) { parts.push([s, k - 1]); s = k + 1; } }
    parts.push([s, c - 1]);
    for (let a = 0; a + 1 < parts.length; a++) {
      const [a0, a1] = parts[a]!, [b0, b1] = parts[a + 1]!; if (a1 < a0 || b1 < b0) continue;
      add([...B.slice(0, a0), ...B.slice(b0, b1 + 1), B[a1 + 1]!, ...B.slice(a0, a1 + 1), ...B.slice(b1 + 1)], 'swap two adjacent arguments or elements', 1);
    }
  }
  for (let i = 1; i < n - 1; i++) {
    if (!isBinOp(B[i]) || B[i]!.text === '=' ) continue;
    const L = operandSpans(B).filter(([, j]) => j === i - 1).sort((x, y) => x[0] - y[0])[0]; const R = operandSpans(B).filter(([s0]) => s0 === i + 1).sort((x, y) => y[1] - x[1])[0];
    if (!L || !R) continue;
    add([...B.slice(0, L[0]), ...B.slice(R[0], R[1] + 1), B[i]!, ...B.slice(L[0], L[1] + 1), ...B.slice(R[1] + 1)], 'swap the two operands of an operator', 1);
  }
  // 8. expression to hole (a call or subscript span becomes one name)
  for (const [i, j] of operandSpans(B)) if (j > i) add([...B.slice(0, i), HOLE, ...B.slice(j + 1)], 'replace a whole sub-expression by one name', 2);
  // 9. method call -> assignment: X.m(Y) -> X = Y
  for (let i = 0; i < n; i++) if (B[i]!.text === '.' && B[i + 1]?.cls === 'identifier' && B[i + 2]?.text === '(') { const c = matchClose(B, i + 2); if (c === n - 1 && c > i + 3) add([...B.slice(0, i), { text: '=', cls: 'operator' }, ...B.slice(i + 3, c)], 'turn a method call into an assignment of its argument', 3); }
  // 10. RHS templates for return / assignment statements
  if (rhs >= 0 && rhs < n) for (const [t, p, pr] of RHS_TEMPLATES) add([...B.slice(0, rhs), ...t, ...(header ? [B[n - 1]!] : [])], p, pr);
  return dedupe(sk);
}
/** does the fix line instantiate the sketch: same length, literal tokens equal, `_` over a name/literal, `<op>` over an operator */
function instantiates(sketch: Tok[], fix: Tok[]): boolean {
  if (sketch.length !== fix.length) return false;
  return sketch.every((t, i) => (t === HOLE || t.text === '_') ? isHoleable(fix[i]!) : (t === OPH || t.text === '<op>') ? fix[i]!.cls === 'operator' : t.text === fix[i]!.text);
}
const holes = (toks: Tok[]): number => toks.filter((t) => t.text === '_' || t.text === '<op>').length;
function dedupe(sk: Sketch[]): Sketch[] {
  const seen = new Map<string, Sketch>();
  for (const s of sk) { const k = key(s.toks); const prev = seen.get(k); if (!prev || s.prio < prev.prio) seen.set(k, s); }
  return [...seen.values()].sort((a, b) => a.prio - b.prio);
}

// -------------------------------------------------------------------------- questions
const EDIT_CLASSES: Record<string, Json> = {
  substitute_one_token: 'one token of `buggy_line` is wrong and must be replaced by another of the same kind (a name, a literal or an operator); the line keeps its length. Example: `while lo <= hi` -> `while lo < hi`; `enumerate(arr)` -> `enumerate(counts)`',
  insert_fragment: 'every token of `buggy_line` stays and a fragment is added: an extra term, index, slice, argument or condition. Example: `mid` -> `mid + 1`; `arr` -> `arr[k:]`; `if total < 0` -> `if total < 0 or not coins`; `x + y` -> `max(0, x + y)`',
  delete_fragment: 'tokens are removed from `buggy_line` and nothing is added. Example: `return 1 + f(x)` -> `return f(x)`; `yield flatten(x)` -> `yield x`',
  reorder_tokens: 'the same tokens in a different order: swapped arguments, operands or indices. Example: `gcd(a % b, b)` -> `gcd(b, a % b)`; `perm[j] < perm[i]` -> `perm[i] < perm[j]`',
  reshape_line: 'the line is restructured in a way not covered above (several coordinated changes). Example: `xs[a].update(ys[b])` -> `xs[a] = ys[b]`',
  insert_new_line: '`buggy_line` is not wrong; a statement is missing and a new line must be inserted at the marker',
};
const SKETCH_Q = `Each option is a sketch of the corrected line for the \`${MARK}\` marker in \`program\`. In a sketch, \`_\` stands for one identifier, number, string or True/False/None still to be chosen, \`<op>\` stands for one operator still to be chosen, and every other token is shown literally. Which sketch is the shape of the correct replacement line, so that with the right tokens in its holes every entry of \`tests\` passes? Read the sketches literally and compare them with \`buggy_line\`. Choose \`none_of_these\` if no listed sketch fits the correct line.`;
const EDIT_Q = 'Which kind of edit turns `buggy_line` into the correct line for the `' + MARK + '` marker in `program`, so that every entry of `tests` passes? Judge the edit that would be written. Answer carefully and literally.';

function stateFor(item: Item): Json {
  return {
    task: `The Python function \`${item.name}\` has a one-line bug. In \`program\` the faulty position is marked \`${MARK}\` (the marker keeps the correct indentation). ${item.buggy_line === null ? 'No line existed there: a new line must be inserted.' : 'The original wrong line at that position is `buggy_line`; the correct line is usually a small edit of it.'} The corrected program must make every entry of \`tests\` pass.`,
    program: item.marked_program,
    buggy_line: item.buggy_line,
    tests: item.tests,
  };
}
const optKey = (i: number): string => `sketch_${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;

interface Row { name: string; kind: string; editClass: string; gold: string; matching: number; poolSize: number; poolBeforeCap: number; covered: boolean; cutByCap: boolean; goldProd: string | null; rank: number | null; pGold: number | null; pTop: number | null; top: string | null; pEscape: number | null; editTop: string | null; editP: number | null; editRank: number | null; noulRank?: number | null; noulPGold?: number | null; noulTop?: string | null; noulMax?: number | null; noulAbove05?: number; cost: number; latencyMs: number; tokens: number }

async function main(): Promise<void> {
  const items = loadCorpus();
  const rows: Row[] = [];
  const J = MODE.startsWith('live') ? makeJev() : null;
  await pool(items, 6, async (item) => {
    const gold = goldSketch(item); const fix = tokenize(item.fix_line);
    const full = buildPool(item); const poolBeforeCap = full.length; const capped = full.slice(0, CAP);
    const matchesFull = full.filter((s) => instantiates(s.toks, fix)); const matches = capped.filter((s) => instantiates(s.toks, fix)).sort((a, b) => holes(a.toks) - holes(b.toks));
    const best = matches[0]; const goldKey = best ? key(best.toks) : key(gold.toks);
    const row: Row = { name: item.name, kind: item.kind, editClass: gold.editClass, gold: best ? detokenize(best.toks) : detokenize(gold.toks), matching: matches.length, poolSize: capped.length, poolBeforeCap, covered: !!best, cutByCap: matchesFull.length > 0 && !best, goldProd: best?.prod ?? null, rank: null, pGold: null, pTop: null, top: null, pEscape: null, editTop: null, editP: null, editRank: null, cost: 0, latencyMs: 0, tokens: 0 };
    if (J) {
      const options: Record<string, Json> = {}; const keyOf = new Map<string, string>();
      capped.forEach((s, i) => { const k = optKey(i); options[k] = { shape: detokenize(s.toks), change: s.prod }; keyOf.set(key(s.toks), k); });
      const qs: Record<string, Question> = { sketch: choice(SKETCH_Q, options), edit_class: choice(EDIT_Q, EDIT_CLASSES) };
      const st = stateFor(item) as Record<string, Json>;
      if (WITH_NOULS) {
        st['sketches'] = options;
        st['sketch_criteria'] = { yes_when: 'the correct replacement line has exactly this shape: every literal token of the sketch appears in the correct line at that position and each hole (`_` or `<op>`) stands for exactly one token of the correct line; filling the holes with the right tokens makes every entry of `tests` pass', no_when: 'the correct line has a different shape: a different token sequence, a change at another position, a fragment this sketch lacks or one it adds where nothing is needed; or this sketch is just the shape of `buggy_line` with a hole that would be filled with the same wrong token' };
        for (const k of Object.keys(options)) qs[`is_${k}`] = contextNoul(`Is \`sketches.${k}\` the shape of the correct replacement line for the \`${MARK}\` marker in \`program\`, so that with the right tokens in its holes every entry of \`tests\` passes? Apply \`sketch_criteria\`. Judge this sketch on its own; other sketches are judged separately.`);
      }
      if (J.usage.cost > J.capUsd) throw new Error('cap');
      const r = await J.jev.ask(st, qs, { signal: J.signal, stage: 'propose', step: 1 });
      J.usage.cost += r.usage.costUsd; J.usage.calls++; J.usage.lat.push(r.latencyMs); J.usage.inTok += r.usage.inputTokens;
      row.cost = r.usage.costUsd; row.latencyMs = r.latencyMs; row.tokens = r.usage.inputTokens;
      const a = r.answers['sketch']!; if (a.type === 'choice') {
        const ranked = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
        row.pEscape = a.probabilities['none_of_these'] ?? 0;
        const nonEsc = ranked.filter(([k]) => k !== 'none_of_these');
        row.top = nonEsc[0] ? (options[nonEsc[0][0]] as { shape: string }).shape : null; row.pTop = nonEsc[0]?.[1] ?? null;
        const matchKeys = new Set(matches.map((m) => keyOf.get(key(m.toks))!));
        if (matchKeys.size) { const idx = nonEsc.findIndex(([k]) => matchKeys.has(k)); row.rank = idx + 1; row.pGold = idx >= 0 ? nonEsc[idx]![1] : 0; row.gold = (options[nonEsc[idx]![0]] as { shape: string }).shape; }
        if (WITH_NOULS) {
          const np: [string, number][] = Object.keys(options).map((k) => { const an = r.answers[`is_${k}`]!; return [k, an.type === 'noul' ? an.noul : 0]; });
          np.sort((x, y) => y[1] - x[1]);
          row.noulTop = (options[np[0]![0]] as { shape: string }).shape; row.noulMax = np[0]![1];
          if (matchKeys.size) { const idx = np.findIndex(([k]) => matchKeys.has(k)); row.noulRank = idx + 1; row.noulPGold = idx >= 0 ? np[idx]![1] : 0; }
          row.noulAbove05 = np.filter(([, p]) => p >= 0.5).length;
        }
      }
      const e = r.answers['edit_class']!; if (e.type === 'choice') {
        const ranked = Object.entries(e.probabilities).sort((x, y) => y[1] - x[1]);
        row.editTop = ranked[0]![0]; row.editP = e.probabilities[gold.editClass] ?? 0; row.editRank = ranked.findIndex(([k]) => k === gold.editClass) + 1;
      }
    }
    rows.push(row);
    console.log(`${item.name.padEnd(27)} ${item.kind.padEnd(7)} pool=${String(row.poolSize).padStart(3)}${row.cutByCap ? ' CUT' : ''} cov=${row.covered ? 'Y' : 'n'}(${row.matching}) gold=${row.gold}${J ? ` | rank=${row.rank ?? '-'} pGold=${row.pGold?.toFixed(2) ?? '-'} pTop=${row.pTop?.toFixed(2) ?? '-'} esc=${row.pEscape?.toFixed(2) ?? '-'} top=${row.top} | edit ${gold.editClass} -> ${row.editTop} (${row.editP?.toFixed(2)})` : ''}`);
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const n = rows.length, cov = rows.filter((r) => r.covered).length;
  const summary: Json = {
    mode: MODE, tag: TAG, n, covered: cov, cutByCap: rows.filter((r) => r.cutByCap).length,
    poolMedian: p50(rows.map((r) => r.poolSize)), poolMax: Math.max(...rows.map((r) => r.poolSize)),
    top1: rows.filter((r) => r.rank === 1).length, top3: rows.filter((r) => r.rank !== null && r.rank >= 1 && r.rank <= 3).length, top5: rows.filter((r) => r.rank !== null && r.rank >= 1 && r.rank <= 5).length,
    mrr: n ? rows.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / n : 0,
    escapeArgmax: rows.filter((r) => r.pEscape !== null && r.pTop !== null && r.pEscape > r.pTop).length,
    noulTop1: rows.filter((r) => r.noulRank === 1).length, noulTop3: rows.filter((r) => r.noulRank != null && r.noulRank >= 1 && r.noulRank <= 3).length, noulTop5: rows.filter((r) => r.noulRank != null && r.noulRank >= 1 && r.noulRank <= 5).length,
    noulMrr: n ? rows.reduce((a, r) => a + (r.noulRank ? 1 / r.noulRank : 0), 0) / n : 0,
    editTop1: rows.filter((r) => r.editRank === 1).length, editTop2: rows.filter((r) => r.editRank !== null && r.editRank >= 1 && r.editRank <= 2).length,
    costUsd: J ? J.usage.cost : 0, requests: J ? J.usage.calls : 0, latencyP50: J ? p50(J.usage.lat) : 0, inputTokensMean: J && J.usage.calls ? Math.round(J.usage.inTok / J.usage.calls) : 0,
  };
  console.log(JSON.stringify(summary));
  writeFileSync(join(HERE, 'out', `sketch-${MODE}-${TAG}.json`), JSON.stringify({ summary, rows }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
