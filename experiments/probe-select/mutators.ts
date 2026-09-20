/**
 * Mutation-operator library for single Python lines (probe-select experiment).
 *
 * Every operator is a pure function `(stripped line, ctx) -> string[]` over the line with its
 * indentation removed; `mutateLine` re-attaches the indent, de-duplicates, and tags each mutant
 * with the operator that produced it. String-level (regex + bracket matching), no Python parser:
 * candidates are later filtered by `compile()` in Python (see filter_compilable.py).
 *
 * Operators (brief): relational swaps, arithmetic swaps, boolean swaps, off-by-one on integer
 * literals and on atoms in index/argument positions, index flips, argument-order swaps,
 * negation insertion/removal, constant substitution (literal pool from program + tests),
 * identifier substitution (in-scope names, call names, attribute names), return tweaks,
 * condition inversion (operand swap, guard extension), plus wrap/unwrap/slice/drop-index.
 */

export interface MutationContext {
  /** in-scope plain identifiers (params, assigned names, loop vars, function name) */
  identifiers: string[];
  /** names used as calls in the program (max, min, len, any, all, user functions) */
  calls: string[];
  /** attribute names used in the program (`.successors` -> `successors`) */
  attributes: string[];
  /** integer literals from program and tests (as strings) */
  intLiterals: string[];
  /** string literals from program and tests (with quotes) */
  strLiterals: string[];
}

export interface Mutant {
  text: string;
  op: string;
}

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'is', 'if', 'else', 'elif', 'while', 'for', 'return', 'yield', 'def', 'class', 'lambda', 'None', 'True', 'False', 'import', 'from', 'as', 'pass', 'break', 'continue', 'with', 'try', 'except', 'finally', 'raise', 'global', 'nonlocal', 'assert', 'del']);

export const OPERATOR_NAMES = [
  'relational_swap', 'arithmetic_swap', 'boolean_swap', 'off_by_one_literal', 'off_by_one_atom', 'index_flip', 'argument_swap',
  'negation', 'constant_substitution', 'identifier_substitution', 'call_substitution', 'attribute_substitution', 'return_tweak',
  'condition_inversion', 'guard_extension', 'wrap_unwrap', 'slice_tweak', 'drop_index', 'method_to_assign', 'binop_with_identifier',
] as const;
export type OperatorName = (typeof OPERATOR_NAMES)[number];

// ------------------------------------------------------------------------------------------
// string helpers
// ------------------------------------------------------------------------------------------

function splitIndent(line: string): [string, string] {
  const m = /^(\s*)(.*)$/s.exec(line)!;
  return [m[1]!, m[2]!];
}

/** Index of the bracket closing the one at `open`, or -1. Skips string literals. */
function matchClose(s: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c in pairs) stack.push(pairs[c]!);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Split at top-level `sep` (outside brackets and strings). */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | null = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** All bracket groups `(…)`, `[…]` with their positions (outermost and nested). */
function bracketGroups(s: string, kind: '(' | '['): { open: number; close: number; inner: string; head: string }[] {
  const out: { open: number; close: number; inner: string; head: string }[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== kind) continue;
    const close = matchClose(s, i);
    if (close < 0) continue;
    const headMatch = /([A-Za-z_][\w.]*(?:\[[^\]]*\])?)$/.exec(s.slice(0, i));
    out.push({ open: i, close, inner: s.slice(i + 1, close), head: headMatch ? headMatch[1]! : '' });
  }
  return out;
}

function splice(s: string, from: number, to: number, repl: string): string {
  return s.slice(0, from) + repl + s.slice(to);
}

function isInString(s: string, idx: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < idx; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
  }
  return quote !== null;
}

interface Ident { name: string; start: number; end: number; isCall: boolean; isAttr: boolean }
function identifiers(s: string): Ident[] {
  const out: Ident[] = [];
  const re = /[A-Za-z_]\w*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (isInString(s, m.index)) continue;
    const before = s[m.index - 1];
    const after = s.slice(m.index + m[0].length).match(/^\s*\(/) !== null;
    out.push({ name: m[0], start: m.index, end: m.index + m[0].length, isCall: after, isAttr: before === '.' });
  }
  return out;
}

const ARITH = ['+', '-', '*', '/', '//', '%', '**'];
const REL = ['<', '<=', '>', '>=', '==', '!='];
/** binary operators with surrounding spaces (QuixBugs style), not inside strings */
function binaryOps(s: string, ops: string[]): { op: string; start: number; end: number }[] {
  const out: { op: string; start: number; end: number }[] = [];
  const sorted = [...ops].sort((a, b) => b.length - a.length);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ') continue;
    for (const op of sorted) {
      if (s.startsWith(op + ' ', i + 1)) {
        // exclude `=`-family false positives like ` = ` and `->`
        const prev = s[i - 1] ?? '', next = s[i + 1 + op.length + 1] ?? '';
        if (op === '-' && (s.slice(i + 1, i + 3) === '->')) break;
        if (prev === '' || /[=<>!]/.test(prev) && op !== '-' ) break;
        if (next === '=') break;
        if (isInString(s, i)) break;
        out.push({ op, start: i + 1, end: i + 1 + op.length });
        i += op.length;
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// operators
// ------------------------------------------------------------------------------------------

type Op = (s: string, ctx: MutationContext) => string[];

const relationalSwap: Op = (s) => {
  const out: string[] = [];
  for (const o of binaryOps(s, REL)) for (const r of REL) if (r !== o.op) out.push(splice(s, o.start, o.end, r));
  return out;
};

const arithmeticSwap: Op = (s) => {
  const out: string[] = [];
  for (const o of binaryOps(s, ARITH)) for (const r of ARITH) if (r !== o.op) out.push(splice(s, o.start, o.end, r));
  // augmented assignment operators (`^=`, `&=`, `|=`, `+=`, `-=`)
  const aug = /(\^|&|\||\+|-|\*|\/)=/.exec(s);
  if (aug && !isInString(s, aug.index)) for (const r of ['^', '&', '|', '+', '-', '*']) if (r !== aug[1]) out.push(splice(s, aug.index, aug.index + 1, r));
  return out;
};

const booleanSwap: Op = (s) => {
  const out: string[] = [];
  const subs: [RegExp, string][] = [[/\band\b/g, 'or'], [/\bor\b/g, 'and'], [/\bTrue\b/g, 'False'], [/\bFalse\b/g, 'True'], [/\bnot in\b/g, 'in'], [/(?<!not )\bin\b(?! range)/g, 'not in'], [/\bis not\b/g, 'is'], [/\bis\b(?! not)/g, 'is not'], [/\bany\(/g, 'all('], [/\ball\(/g, 'any(']];
  for (const [re, rep] of subs) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(s))) if (!isInString(s, m.index)) out.push(splice(s, m.index, m.index + m[0].length, rep));
  }
  return out;
};

const offByOneLiteral: Op = (s) => {
  const out: string[] = [];
  const re = /(?<![\w.])(\d+)(?![\w.])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (isInString(s, m.index)) continue;
    const n = Number(m[1]);
    for (const d of [1, -1]) if (n + d >= 0 || true) out.push(splice(s, m.index, m.index + m[0].length, String(n + d)));
  }
  return out;
};

/** atoms (identifier, call, subscript) inside argument or index positions get ` + 1` / ` - 1`, or lose an existing one */
const offByOneAtom: Op = (s) => {
  const out: string[] = [];
  // pass 1: plain identifiers in bracketed positions (`f(mid, end)` -> `f(mid + 1, end)`, `dp[i - 1, j]` -> `dp[i - 1, j - 1]`)
  for (const id of identifiers(s)) {
    if (KEYWORDS.has(id.name) || id.isAttr || id.isCall || /def\s+$/.test(s.slice(0, id.start))) continue;
    const before = s.slice(0, id.start), after = s.slice(id.end);
    const depthOpen = (before.match(/[(\[]/g) ?? []).length - (before.match(/[)\]]/g) ?? []).length;
    if (depthOpen <= 0 || /^\s*[\[(.]/.test(after)) continue;
    if (/^\s*[+-] 1\b/.test(after)) {
      const k = after.match(/^\s*[+-] 1\b/)![0].length;
      out.push(splice(s, id.end, id.end + k, ''));
    } else out.push(splice(s, id.end, id.end, ' + 1'), splice(s, id.end, id.end, ' - 1'));
  }
  // pass 2: atoms with their call/subscript suffix (`len(x)` -> `len(x) - 1`)
  const atomRe = /\b([A-Za-z_]\w*)(\([^()]*\)|\[[^\[\]]*\])?(?![\w(\[])/g;
  let m: RegExpExecArray | null;
  while ((m = atomRe.exec(s))) {
    if (isInString(s, m.index) || KEYWORDS.has(m[1]!)) continue;
    const before = s.slice(0, m.index), after = s.slice(m.index + m[0].length);
    if (/def\s+$/.test(before) || /\.\s*$/.test(before)) continue;
    // only in a bracketed or right-hand-side position
    const depthOpen = (before.match(/[(\[]/g) ?? []).length - (before.match(/[)\]]/g) ?? []).length;
    const rhs = /(=|return|yield|in|:)\s*$/.test(before.replace(/\s+$/, ' ')) || /^\s*(:|,|\)|\])/.test(after) || after.trim() === '';
    if (depthOpen <= 0 && !rhs) continue;
    if (/^\s*[+-] 1\b/.test(after)) {
      const k = after.match(/^\s*[+-] 1\b/)![0].length;
      out.push(splice(s, m.index + m[0].length, m.index + m[0].length + k, ''));
      continue;
    }
    out.push(splice(s, m.index + m[0].length, m.index + m[0].length, ' + 1'));
    out.push(splice(s, m.index + m[0].length, m.index + m[0].length, ' - 1'));
  }
  return out;
};

const indexFlip: Op = (s) => {
  const out: string[] = [];
  for (const g of bracketGroups(s, '[')) {
    const inner = g.inner.trim();
    if (inner === '0') out.push(splice(s, g.open + 1, g.close, '-1'));
    if (inner === '-1') out.push(splice(s, g.open + 1, g.close, '0'));
    if (inner === '1') out.push(splice(s, g.open + 1, g.close, '0'));
    if (inner === '0') out.push(splice(s, g.open + 1, g.close, '1'));
    const parts = splitTopLevel(g.inner, ',');
    if (parts.length === 2) out.push(splice(s, g.open + 1, g.close, `${parts[1]!.trim()}, ${parts[0]!.trim()}`));
    if (inner.includes(':')) {
      const [a, b] = inner.split(':') as [string, string];
      out.push(splice(s, g.open + 1, g.close, `${b}:${a}`));
    }
  }
  // swap the contents of two subscripts on the same line: a[i] b[j] -> a[j] b[i]
  const groups = bracketGroups(s, '[');
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    const a = groups[i]!, b = groups[j]!;
    if (a.close < b.open && a.inner !== b.inner) out.push(splice(splice(s, b.open + 1, b.close, a.inner), a.open + 1, a.close, b.inner));
  }
  return out;
};

const argumentSwap: Op = (s) => {
  const out: string[] = [];
  for (const g of [...bracketGroups(s, '('), ...bracketGroups(s, '[')]) {
    const parts = splitTopLevel(g.inner, ',').map((p) => p.trim());
    if (parts.length < 2 || parts.some((p) => p === '')) continue;
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const q = [...parts];
      [q[i], q[j]] = [q[j]!, q[i]!];
      out.push(splice(s, g.open + 1, g.close, q.join(', ')));
    }
  }
  return out;
};

const negation: Op = (s) => {
  const out: string[] = [];
  const m = /^(if|elif|while|return|yield|assert)\s+(.*?)(:?)$/.exec(s);
  if (m) {
    const [, kw, cond, colon] = m as unknown as [string, string, string, string];
    if (cond.startsWith('not ')) out.push(`${kw} ${cond.slice(4)}${colon}`);
    else out.push(`${kw} not ${cond}${colon}`);
  }
  const re = /\bnot /g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(s))) if (!isInString(s, mm.index)) out.push(splice(s, mm.index, mm.index + 4, ''));
  // insert `not` before a bracketed or identifier operand of and/or
  for (const o of binaryOps(s, ['and', 'or'])) {
    const restRe = /^\s*/.exec(s.slice(o.end))!;
    out.push(splice(s, o.end + restRe[0].length, o.end + restRe[0].length, 'not '));
  }
  return out;
};

const constantSubstitution: Op = (s, ctx) => {
  const out: string[] = [];
  const re = /(?<![\w.])(-?\d+)(?![\w.])/g;
  let m: RegExpExecArray | null;
  const ints = [...new Set(['0', '1', '2', '-1', ...ctx.intLiterals])].slice(0, 10);
  while ((m = re.exec(s))) {
    if (isInString(s, m.index)) continue;
    for (const lit of ints) if (lit !== m[1]) out.push(splice(s, m.index, m.index + m[0].length, lit));
  }
  const strRe = /(["'])(?:\\.|(?!\1).)*\1/g;
  while ((m = strRe.exec(s))) for (const lit of ctx.strLiterals.slice(0, 8)) if (lit !== m[0]) out.push(splice(s, m.index, m.index + m[0].length, lit));
  // empty containers and None
  const lits: [RegExp, string[]][] = [[/\[\]/g, ['[[]]', 'None', '[0]', '()']], [/\[\[\]\]/g, ['[]']], [/\bNone\b/g, ['0', '[]', 'False', '""']], [/\(\)/g, ['[]', 'None']]];
  for (const [r, reps] of lits) {
    r.lastIndex = 0;
    while ((m = r.exec(s))) if (!isInString(s, m.index)) for (const rep of reps) out.push(splice(s, m.index, m.index + m[0].length, rep));
  }
  // `[]` -> `[ident]` for in-scope identifiers
  const empty = /\[\]/g;
  while ((m = empty.exec(s))) if (!isInString(s, m.index)) for (const id of ctx.identifiers) out.push(splice(s, m.index, m.index + 2, `[${id}]`));
  return out;
};

const identifierSubstitution: Op = (s, ctx) => {
  const out: string[] = [];
  for (const id of identifiers(s)) {
    if (KEYWORDS.has(id.name) && id.name !== 'True' && id.name !== 'False' && id.name !== 'None') continue;
    if (id.isAttr || id.isCall) continue;
    if (/def\s+$/.test(s.slice(0, id.start))) continue;
    for (const other of ctx.identifiers) if (other !== id.name) out.push(splice(s, id.start, id.end, other));
  }
  return out;
};

const callSubstitution: Op = (s, ctx) => {
  const out: string[] = [];
  for (const id of identifiers(s)) {
    if (!id.isCall || id.isAttr || /def\s+$/.test(s.slice(0, id.start))) continue;
    for (const other of ctx.calls) if (other !== id.name) out.push(splice(s, id.start, id.end, other));
  }
  return out;
};

const attributeSubstitution: Op = (s, ctx) => {
  const out: string[] = [];
  for (const id of identifiers(s)) {
    if (!id.isAttr) continue;
    for (const other of ctx.attributes) if (other !== id.name) out.push(splice(s, id.start, id.end, other));
  }
  return out;
};

const returnTweak: Op = (s, ctx) => {
  const out: string[] = [];
  const m = /^(return|yield)\s+(.*)$/.exec(s);
  if (!m) return out;
  const [, kw, expr] = m as unknown as [string, string, string];
  for (const id of ctx.identifiers) {
    out.push(`${kw} ${id}`, `${kw} [${id}]`, `${kw} ${id} == 0`, `${kw} ${id} != 0`, `${kw} not ${id}`, `${kw} len(${id})`);
  }
  for (const id of ctx.identifiers) out.push(`${kw} ${id} + ${expr}`, `${kw} ${expr} + ${id}`);
  out.push(`${kw} ${expr} + 1`, `${kw} ${expr} - 1`, `${kw} not ${expr}`, `${kw} None`, `${kw} []`, `${kw} [[]]`, `${kw} True`, `${kw} False`, `${kw} 0`, `${kw} 1`);
  // drop a leading additive term: `return 1 + f(x)` -> `return f(x)`
  const lead = /^([\w.\[\]]+ [+\-*] )(.+)$/.exec(expr);
  if (lead) out.push(`${kw} ${lead[2]}`);
  const trail = /^(.+)( [+\-*] [\w.\[\]]+)$/.exec(expr);
  if (trail) out.push(`${kw} ${trail[1]}`);
  return out;
};

/** swap the operands of a binary operator: `a < b` -> `b < a`, `x + y` -> `y + x` */
const conditionInversion: Op = (s) => {
  const out: string[] = [];
  for (const o of binaryOps(s, [...REL, '+', '-', 'and', 'or', 'in', '*'])) {
    const leftPart = s.slice(0, o.start - 1), rightPart = s.slice(o.end + 1);
    const lm = /([A-Za-z_][\w.]*(?:\[[^\]]*\]|\([^()]*\))*|-?\d+|\[[^\]]*\]|\([^()]*\))$/.exec(leftPart);
    const rm = /^([A-Za-z_][\w.]*(?:\[[^\]]*\]|\([^()]*\))*|-?\d+|\[[^\]]*\]|\([^()]*\))/.exec(rightPart);
    if (!lm || !rm) continue;
    const l = lm[1]!, r = rm[1]!;
    if (l === r) continue;
    out.push(leftPart.slice(0, leftPart.length - l.length) + r + ' ' + o.op + ' ' + l + rightPart.slice(r.length));
  }
  return out;
};

/** `if X:` -> `if X or <guard>:`, `if <guard> or X:`, `if X and <guard>:` */
const guardExtension: Op = (s, ctx) => {
  const out: string[] = [];
  const m = /^(if|elif|while)\s+(.*):$/.exec(s);
  if (!m) return out;
  const [, kw, cond] = m as unknown as [string, string, string];
  const lineIds = identifiers(cond).filter((i) => !KEYWORDS.has(i.name) && !i.isAttr).map((i) => i.name);
  const ids = [...new Set([...lineIds, ...ctx.identifiers])].slice(0, 12);
  const guards: string[] = [];
  for (const id of ids) guards.push(`not ${id}`, `${id} is None`, `${id} == 0`, `${id}`);
  for (const g of guards) {
    out.push(`${kw} ${cond} or ${g}:`, `${kw} ${g} or ${cond}:`, `${kw} ${cond} and ${g}:`);
  }
  if (cond === 'True') for (const id of ids) out.push(`${kw} ${id}:`, `${kw} len(${id}) > 0:`);
  return out;
};

/** wrap RHS in max/min, unwrap a call, square an identifier */
const wrapUnwrap: Op = (s, ctx) => {
  const out: string[] = [];
  const asg = /^([\w.\[\], ]+?)\s*=\s*(.+)$/.exec(s);
  if (asg && !/[=<>!]=/.test(s.slice(0, asg[1]!.length + 3))) {
    const [, lhs, rhs] = asg as unknown as [string, string, string];
    for (const f of ['max', 'min']) {
      out.push(`${lhs} = ${f}(0, ${rhs})`, `${lhs} = ${f}(${lhs}, ${rhs})`, `${lhs} = ${f}(1, ${rhs})`);
      for (const id of ctx.identifiers.slice(0, 10)) if (id !== lhs) out.push(`${lhs} = ${f}(${id}, ${rhs})`);
    }
    out.push(`${lhs} = ${rhs} ** 2`, `${lhs} = abs(${rhs})`, `${lhs} = len(${rhs})`, `${lhs} = list(${rhs})`);
  }
  // unwrap a call: f(x) -> x
  for (const g of bracketGroups(s, '(')) {
    if (!g.head || KEYWORDS.has(g.head)) continue;
    const parts = splitTopLevel(g.inner, ',');
    if (parts.length === 1 && g.inner.trim() !== '') out.push(splice(s, g.open - g.head.length, g.close + 1, g.inner.trim()));
    // call -> identifier
    for (const id of ctx.identifiers.slice(0, 12)) out.push(splice(s, g.open - g.head.length, g.close + 1, id));
  }
  // identifier -> identifier ** 2 / abs(identifier)
  for (const id of identifiers(s)) {
    if (KEYWORDS.has(id.name) || id.isAttr || id.isCall || /def\s+$/.test(s.slice(0, id.start))) continue;
    out.push(splice(s, id.end, id.end, ' ** 2'));
  }
  return out;
};

/** `arr` -> `arr[1:]`, `arr[k:]`, `arr[:-1]`; `a[1:]` -> `a`; slice bound ±1 */
const sliceTweak: Op = (s, ctx) => {
  const out: string[] = [];
  const ids = identifiers(s).filter((i) => !KEYWORDS.has(i.name) && !i.isAttr && !i.isCall && !/def\s+$/.test(s.slice(0, i.start)));
  const bounds = ['1', '-1', ...ctx.identifiers.slice(0, 8)];
  for (const id of ids) {
    const after = s.slice(id.end);
    if (/^\s*[\[(.]/.test(after)) continue;
    if (/^\s*=[^=]/.test(after) && s.indexOf('=') > id.start) continue; // assignment target
    for (const b of bounds) out.push(splice(s, id.end, id.end, `[${b}:]`), splice(s, id.end, id.end, `[:${b}]`));
  }
  for (const g of bracketGroups(s, '[')) {
    if (!g.inner.includes(':')) continue;
    out.push(splice(s, g.open - g.head.length, g.close + 1, g.head)); // drop the slice
    const [a, b] = g.inner.split(':') as [string, string];
    for (const [na, nb] of [[a === '' ? '1' : `${a} + 1`, b], [a === '' ? '-1' : `${a} - 1`, b], [a, b === '' ? '-1' : `${b} - 1`], [a, b === '' ? '1' : `${b} + 1`]] as [string, string][]) out.push(splice(s, g.open + 1, g.close, `${na}:${nb}`));
  }
  return out;
};

/** `a[u, v]` -> `a[u]`, `a[v]`; `a[i][j]` -> `a[i]` */
const dropIndex: Op = (s) => {
  const out: string[] = [];
  for (const g of bracketGroups(s, '[')) {
    const parts = splitTopLevel(g.inner, ',').map((p) => p.trim());
    if (parts.length === 2) out.push(splice(s, g.open + 1, g.close, parts[0]!), splice(s, g.open + 1, g.close, parts[1]!));
    out.push(splice(s, g.open, g.close + 1, ''));
  }
  return out;
};

/** `x.update(y)` -> `x = y`; `x.append(y)` -> `x = y`, `x = [y]`; `x = y` -> `x.update(y)` */
const methodToAssign: Op = (s) => {
  const out: string[] = [];
  const m = /^([\w\[\], .]+?)\.(\w+)\((.*)\)$/.exec(s);
  if (m) {
    const [, recv, , arg] = m as unknown as [string, string, string, string];
    out.push(`${recv} = ${arg}`, `${recv} = [${arg}]`, `${recv} += ${arg}`);
    for (const meth of ['append', 'update', 'add', 'extend', 'remove', 'pop', 'insert', 'appendleft', 'popleft']) if (meth !== m[2]) out.push(`${recv}.${meth}(${arg})`);
  }
  const asg = /^([\w\[\], .]+?)\s*=\s*(.+)$/.exec(s);
  if (asg && !/[=<>!]=/.test(s)) out.push(`${asg[1]}.update(${asg[2]})`, `${asg[1]}.append(${asg[2]})`, `${asg[1]} += ${asg[2]}`);
  return out;
};

/** `k` -> `k - <id>`, `k + <id>` for in-scope identifiers (argument and index positions) */
const binopWithIdentifier: Op = (s, ctx) => {
  const out: string[] = [];
  for (const id of identifiers(s)) {
    if (KEYWORDS.has(id.name) || id.isAttr || id.isCall || /def\s+$/.test(s.slice(0, id.start))) continue;
    const before = s.slice(0, id.start), after = s.slice(id.end);
    const depthOpen = (before.match(/[(\[]/g) ?? []).length - (before.match(/[)\]]/g) ?? []).length;
    if (depthOpen <= 0 && !/^\s*$/.test(after)) continue;
    if (/^\s*[\[(.]/.test(after)) continue;
    for (const other of ctx.identifiers.slice(0, 10)) if (other !== id.name) out.push(splice(s, id.end, id.end, ` - ${other}`), splice(s, id.end, id.end, ` + ${other}`));
  }
  return out;
};

/** Fix templates over pairs of in-scope identifiers (used for missing-statement candidates). */
export function statementTemplates(ctx: MutationContext, indent: string): Mutant[] {
  const out: Mutant[] = [];
  const ids = ctx.identifiers.slice(0, 14);
  for (const a of ids) {
    out.push({ text: `${indent}return ${a}`, op: 'statement_template' }, { text: `${indent}${a}.pop()`, op: 'statement_template' }, { text: `${indent}${a} += 1`, op: 'statement_template' }, { text: `${indent}${a} -= 1`, op: 'statement_template' });
    for (const b of ids) {
      if (a === b) continue;
      for (const t of [`${a}.add(${b})`, `${a}.append(${b})`, `${a} = ${b}`, `${a} += ${b}`, `${a}.remove(${b})`, `${a}.extend(${b})`]) out.push({ text: indent + t, op: 'statement_template' });
    }
  }
  return out;
}

export const OPERATORS: Record<OperatorName, Op> = {
  relational_swap: relationalSwap,
  arithmetic_swap: arithmeticSwap,
  boolean_swap: booleanSwap,
  off_by_one_literal: offByOneLiteral,
  off_by_one_atom: offByOneAtom,
  index_flip: indexFlip,
  argument_swap: argumentSwap,
  negation,
  constant_substitution: constantSubstitution,
  identifier_substitution: identifierSubstitution,
  call_substitution: callSubstitution,
  attribute_substitution: attributeSubstitution,
  return_tweak: returnTweak,
  condition_inversion: conditionInversion,
  guard_extension: guardExtension,
  wrap_unwrap: wrapUnwrap,
  slice_tweak: sliceTweak,
  drop_index: dropIndex,
  method_to_assign: methodToAssign,
  binop_with_identifier: binopWithIdentifier,
};

/** Normalise for comparison: collapse whitespace runs, strip trailing comment and spaces. */
export function normLine(s: string): string {
  return s.replace(/\s+#.*$/, '').replace(/\s+/g, ' ').trim();
}

/** First-order mutants of one line (indent preserved), deduplicated, excluding the line itself. */
export function mutateLine(line: string, ctx: MutationContext, ops: readonly OperatorName[] = OPERATOR_NAMES): Mutant[] {
  const [indent, body] = splitIndent(line.replace(/\s+#.*$/, ''));
  if (body.trim() === '' || body.startsWith('#')) return [];
  const seen = new Set<string>([normLine(body)]);
  const out: Mutant[] = [];
  for (const op of ops) {
    for (const m of OPERATORS[op](body, ctx)) {
      const key = normLine(m);
      if (seen.has(key) || key === '') continue;
      seen.add(key);
      out.push({ text: indent + m.replace(/\s+$/, ''), op });
    }
  }
  return out;
}

/** Second-order mutants: apply `ops` again to every first-order mutant (bounded). */
export function mutateLineSecondOrder(line: string, ctx: MutationContext, first: Mutant[], limit: number, ops: readonly OperatorName[] = ['relational_swap', 'arithmetic_swap', 'boolean_swap', 'off_by_one_literal', 'off_by_one_atom', 'index_flip', 'argument_swap', 'negation', 'identifier_substitution', 'constant_substitution']): Mutant[] {
  const seen = new Set<string>([normLine(line), ...first.map((m) => normLine(m.text))]);
  const out: Mutant[] = [];
  for (const f of first) {
    for (const m of mutateLine(f.text, ctx, ops)) {
      const key = normLine(m.text);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: m.text, op: `${f.op}+${m.op}` });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Build the mutation context from the program source (all lines) and test literals. */
export function buildContext(programLines: string[], testLiterals: { ints: string[]; strs: string[] }): MutationContext {
  const ids = new Set<string>(), calls = new Set<string>(), attrs = new Set<string>(), ints = new Set<string>(), strs = new Set<string>();
  for (const raw of programLines) {
    const line = raw.replace(/\s+#.*$/, '');
    const def = /^\s*def\s+(\w+)\s*\(([^)]*)\)/.exec(line);
    if (def) {
      ids.add(def[1]!);
      for (const p of def[2]!.split(',')) {
        const name = p.trim().split(/[=:]/)[0]!.replace(/^\*+/, '').trim();
        if (name && name !== 'self') ids.add(name);
      }
    }
    const asg = /^\s*([\w, *]+?)\s*(?:[-+*/%^&|]?=)(?!=)/.exec(line);
    if (asg && !/^\s*(if|while|elif|return|def|for)\b/.test(line)) for (const n of asg[1]!.split(',')) {
      const name = n.trim().replace(/^\*/, '');
      if (/^[A-Za-z_]\w*$/.test(name)) ids.add(name);
    }
    const forM = /^\s*for\s+(.+?)\s+in\b/.exec(line);
    if (forM) for (const n of forM[1]!.replace(/[()]/g, '').split(',')) if (/^[A-Za-z_]\w*$/.test(n.trim())) ids.add(n.trim());
    const imp = /^\s*from\s+\S+\s+import\s+(.+)$/.exec(line);
    if (imp) for (const n of imp[1]!.split(',')) { const parts = n.trim().split(/\s+as\s+/); const name = parts[parts.length - 1]!; if (/^[A-Za-z_]\w*$/.test(name)) calls.add(name); }
    for (const id of identifiers(line)) {
      if (id.isAttr) attrs.add(id.name);
      else if (id.isCall && !KEYWORDS.has(id.name)) calls.add(id.name);
    }
    let m: RegExpExecArray | null;
    const intRe = /(?<![\w.])(\d+)(?![\w.])/g;
    while ((m = intRe.exec(line))) if (!isInString(line, m.index)) ints.add(m[1]!);
    const strRe = /(["'])(?:\\.|(?!\1).)*\1/g;
    while ((m = strRe.exec(line))) strs.add(m[0]);
  }
  for (const i of testLiterals.ints) ints.add(i);
  for (const s of testLiterals.strs) strs.add(s);
  for (const b of ['len', 'max', 'min', 'abs', 'any', 'all', 'sum', 'range', 'list', 'set', 'sorted', 'reversed', 'enumerate', 'zip']) calls.add(b);
  const intList = [...ints].filter((x) => x.length <= 4).sort((a, b) => Number(a) - Number(b)).slice(0, 10);
  return { identifiers: [...ids].filter((x) => !KEYWORDS.has(x)), calls: [...calls], attributes: [...attrs], intLiterals: intList, strLiterals: [...strs].slice(0, 8) };
}
