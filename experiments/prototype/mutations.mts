/**
 * Mutation-operator candidate library (code proposes). Generic single-operator edits of one
 * line, built on a small tokenizer so brackets, strings and attribute names are respected.
 * No program-specific rules. Candidates are ordered cheap-and-likely first so that the cap
 * truncates the identifier-substitution tail, not the operator swaps.
 */
import { spawnSync } from 'node:child_process';
import type { QuixProgram } from './quixbugs.mts';
import { normLine, stripComment } from './quixbugs.mts';

export interface MutationContext { lines: string[]; lineIndex: number; testLiterals: string[] }
export interface Candidate { text: string; op: string }

// ---------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------

type TokType = 'id' | 'num' | 'str' | 'op' | 'br' | 'ws' | 'other';
interface Tok { t: TokType; s: string }

const KEYWORDS = new Set(['and', 'or', 'not', 'in', 'is', 'if', 'elif', 'else', 'while', 'for', 'return', 'yield', 'def', 'class', 'lambda', 'None', 'True', 'False', 'import', 'from', 'as', 'pass', 'break', 'continue', 'with', 'try', 'except', 'finally', 'raise', 'global', 'nonlocal', 'assert', 'del']);
const CONST_KW = new Set(['None', 'True', 'False']);
const OP_RE = /^(\*\*=|\/\/=|>>=|<<=|\*\*|\/\/|==|!=|<=|>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|->|<<|>>|[-+*/%<>=&|^~@!:;.,])/;
const STR_RE = /^(?:[rbuf]{0,2})(?:'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")/i;
const NUM_RE = /^(?:0[xX][0-9a-fA-F]+|\d+\.\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|\d+(?:[eE][+-]?\d+)?)j?/;

export function tokenize(body: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < body.length) {
    const rest = body.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = /^\s+/.exec(rest))) out.push({ t: 'ws', s: m[0] });
    else if ((m = STR_RE.exec(rest))) out.push({ t: 'str', s: m[0] });
    else if ((m = NUM_RE.exec(rest))) out.push({ t: 'num', s: m[0] });
    else if ((m = /^[A-Za-z_]\w*/.exec(rest))) out.push({ t: 'id', s: m[0] });
    else if ((m = /^[()[\]{}]/.exec(rest))) out.push({ t: 'br', s: m[0] });
    else if ((m = OP_RE.exec(rest))) out.push({ t: 'op', s: m[0] });
    else { m = [rest[0]!] as unknown as RegExpMatchArray; out.push({ t: 'other', s: rest[0]! }); }
    i += m[0].length;
  }
  return out;
}
const join = (toks: Tok[]): string => toks.map((t) => t.s).join('');
const isOpen = (s: string): boolean => s === '(' || s === '[' || s === '{';
const isClose = (s: string): boolean => s === ')' || s === ']' || s === '}';

/** index of the matching close bracket for the open bracket at i, or -1 */
function matchClose(toks: Tok[], i: number): number {
  let d = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j]!.t === 'br') { if (isOpen(toks[j]!.s)) d++; else if (isClose(toks[j]!.s) && --d === 0) return j; }
  }
  return -1;
}
/** significant (non-ws) token index before/after i, or -1 */
function prevSig(toks: Tok[], i: number): number { for (let j = i - 1; j >= 0; j--) if (toks[j]!.t !== 'ws') return j; return -1; }
function nextSig(toks: Tok[], i: number): number { for (let j = i + 1; j < toks.length; j++) if (toks[j]!.t !== 'ws') return j; return -1; }

/** Split the token range [from, to) at top-level separator tokens; returns ranges (trimmed of ws). */
function splitTop(toks: Tok[], from: number, to: number, sep: (t: Tok) => boolean): [number, number][] {
  const parts: [number, number][] = [];
  let d = 0, start = from;
  for (let i = from; i < to; i++) {
    const t = toks[i]!;
    if (t.t === 'br') { if (isOpen(t.s)) d++; else d--; }
    else if (d === 0 && sep(t)) { parts.push([start, i]); start = i + 1; }
  }
  parts.push([start, to]);
  return parts.map(([a, b]) => { while (a < b && toks[a]!.t === 'ws') a++; while (b > a && toks[b - 1]!.t === 'ws') b--; return [a, b]; });
}

interface Atom { from: number; to: number; kind: 'name' | 'call' | 'sub' | 'num' | 'str' | 'paren' | 'attr' }
/** Maximal primary expressions: name/number/string/paren group followed by .attr / (...) / [...] chains; nested operands are atoms too. */
function atoms(toks: Tok[]): Atom[] {
  const out: Atom[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i]!;
    const p = prevSig(toks, i);
    const afterDot = p >= 0 && toks[p]!.s === '.';
    let kind: Atom['kind'] | null = null;
    if (t.t === 'id' && !KEYWORDS.has(t.s) && !afterDot) kind = 'name';
    else if (t.t === 'num') kind = 'num';
    else if (t.t === 'str') kind = 'str';
    else if (t.t === 'br' && (t.s === '(' || t.s === '[') && !(p >= 0 && (toks[p]!.t === 'id' && !KEYWORDS.has(toks[p]!.s) || toks[p]!.s === ')' || toks[p]!.s === ']'))) kind = 'paren';
    if (kind === null) { i++; continue; }
    let j = i;
    if (kind === 'paren') { j = matchClose(toks, i); if (j < 0) { i++; continue; } }
    // extend the chain
    for (;;) {
      const n = nextSig(toks, j);
      if (n < 0) break;
      if (toks[n]!.s === '.' ) { const a = nextSig(toks, n); if (a >= 0 && toks[a]!.t === 'id') { j = a; kind = 'attr'; continue; } break; }
      if (toks[n]!.t === 'br' && toks[n]!.s === '(') { const c = matchClose(toks, n); if (c < 0) break; j = c; kind = 'call'; continue; }
      if (toks[n]!.t === 'br' && toks[n]!.s === '[') { const c = matchClose(toks, n); if (c < 0) break; j = c; kind = 'sub'; continue; }
      break;
    }
    out.push({ from: i, to: j + 1, kind });
    i += 1; // keep scanning inside the chain so nested operands (call arguments, index expressions) are atoms too
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Scope harvesting
// ---------------------------------------------------------------------------------------

const indentOf = (l: string): number => l.length - l.trimStart().length;

/** Identifiers in scope for the target line: enclosing def's parameters first, then names nearest to the line, then module-level names. */
function scopeIdentifiers(lines: string[], lineIndex: number): { ids: string[]; attrs: string[] } {
  const code = lines.map((l) => stripComment(l));
  const target = code[lineIndex] ?? '';
  const tIndent = indentOf(target);
  // enclosing def
  let defIdx = -1;
  for (let i = lineIndex; i >= 0; i--) { const l = code[i]!; if (l.trim() && indentOf(l) < (i === lineIndex ? tIndent + 1 : tIndent) && /^\s*def\s/.test(l)) { defIdx = i; break; } }
  let blockEnd = lines.length;
  if (defIdx >= 0) { const di = indentOf(code[defIdx]!); for (let i = defIdx + 1; i < code.length; i++) { const l = code[i]!; if (l.trim() && indentOf(l) <= di) { blockEnd = i; break; } } }
  const blockStart = defIdx >= 0 ? defIdx : 0;
  const score = new Map<string, number>();
  const add = (name: string, dist: number): void => { if (KEYWORDS.has(name)) return; const cur = score.get(name); if (cur === undefined || dist < cur) score.set(name, dist); };
  const harvest = (l: string, dist: number): void => {
    const toks = tokenize(l);
    toks.forEach((t, i) => { if (t.t === 'id' && !(prevSig(toks, i) >= 0 && toks[prevSig(toks, i)]!.s === '.')) add(t.s, dist); });
  };
  for (let i = blockStart; i < blockEnd; i++) harvest(code[i]!, i === defIdx ? -1 : Math.abs(i - lineIndex)); // the enclosing def's parameters come first: they are the likeliest donors
  // module-level names (defs, imports, assignments)
  code.forEach((l, i) => { if (indentOf(l) === 0 && /^(def |import |from |[A-Za-z_]\w*\s*=)/.test(l)) harvest(l, 1000 + Math.abs(i - lineIndex)); });
  const attrs = new Set<string>();
  for (const l of code) for (const m of l.matchAll(/\.([A-Za-z_]\w*)/g)) attrs.add(m[1]!);
  return { ids: [...score.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k), attrs: [...attrs] };
}

function harvestLiterals(src: string, cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokenize(src)) if ((t.t === 'num' || t.t === 'str') && !seen.has(t.s)) { seen.add(t.s); out.push(t.s); if (out.length >= cap) break; }
  return out;
}

export function buildContext(p: QuixProgram, lines: string[], lineIndex: number): MutationContext {
  const lits: string[] = [];
  const seen = new Set<string>();
  const push = (s: string): void => { if (!seen.has(s)) { seen.add(s); lits.push(s); } };
  for (const s of ['0', '1', '-1', '2']) push(s);
  const walk = (v: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof v === 'number') { if (Number.isInteger(v) && Math.abs(v) <= 1000) push(String(v)); }
    else if (typeof v === 'string') { if (v.length <= 8) push(JSON.stringify(v).replace(/^"(.*)"$/, "'$1'")); }
    else if (Array.isArray(v)) v.slice(0, 6).forEach((x) => walk(x, depth + 1));
  };
  if (p.tests) for (const [inp, exp] of p.tests.slice(0, 6)) { walk(inp, 0); walk(exp, 0); }
  else for (const s of harvestLiterals(p.pytestSource, 20)) push(s);
  return { lines, lineIndex, testLiterals: lits.slice(0, 30) };
}

// ---------------------------------------------------------------------------------------
// Operators (each works on the body tokens and returns replacement bodies)
// ---------------------------------------------------------------------------------------

type Gen = (toks: Tok[], env: Env) => string[];
interface Env { ids: string[]; attrs: string[]; literals: string[]; lineLiterals: string[]; body: string }

function replaceRange(toks: Tok[], from: number, to: number, text: string): string {
  return join(toks.slice(0, from)) + text + join(toks.slice(to));
}
function withTok(toks: Tok[], i: number, s: string): string { return replaceRange(toks, i, i + 1, s); }

const REL = ['<', '<=', '>', '>=', '==', '!='];
const ARITH = ['+', '-', '*', '/', '//', '%', '**'];
const AUG = ['+=', '-=', '*=', '//=', '/=', '%='];
const BIT = ['^', '&', '|'];
const BITAUG = ['^=', '&=', '|='];

const relSwap: Gen = (toks) => {
  const out: string[] = [];
  toks.forEach((t, i) => {
    if (t.t === 'op' && REL.includes(t.s)) for (const r of REL) if (r !== t.s) out.push(withTok(toks, i, r));
    if (t.t === 'op' && t.s === '==') out.push(withTok(toks, i, 'is'));
    if (t.t === 'op' && t.s === '!=') out.push(withTok(toks, i, 'is not'));
    if (t.t === 'id' && t.s === 'is') { const n = nextSig(toks, i); if (n >= 0 && toks[n]!.s === 'not') out.push(replaceRange(toks, i, n + 1, '!=')); else out.push(withTok(toks, i, '==')); }
    if (t.t === 'id' && t.s === 'in') { const p = prevSig(toks, i); if (p >= 0 && toks[p]!.s === 'not') out.push(replaceRange(toks, p, i + 1, 'in')); else if (!(p >= 0 && toks[p]!.t === 'id' && !KEYWORDS.has(toks[p]!.s) && /\bfor\b/.test(join(toks.slice(0, i))) && isForTarget(toks, i))) out.push(withTok(toks, i, 'not in')); }
  });
  return out;
};
/** `in` that belongs to a `for ... in` (not a membership test) */
function isForTarget(toks: Tok[], i: number): boolean {
  let d = 0;
  for (let j = i - 1; j >= 0; j--) { const t = toks[j]!; if (t.t === 'br') { if (isClose(t.s)) d++; else if (isOpen(t.s)) { if (d === 0) return false; d--; } } else if (d === 0 && t.t === 'id' && t.s === 'for') return true; else if (d === 0 && t.t === 'id' && (t.s === 'if' || t.s === 'while' || t.s === 'return' || t.s === 'and' || t.s === 'or')) return false; }
  return false;
}

const boolSwap: Gen = (toks) => {
  const out: string[] = [];
  toks.forEach((t, i) => {
    if (t.t !== 'id') return;
    if (t.s === 'and') out.push(withTok(toks, i, 'or'));
    if (t.s === 'or') out.push(withTok(toks, i, 'and'));
    if (t.s === 'True') out.push(withTok(toks, i, 'False'));
    if (t.s === 'False') out.push(withTok(toks, i, 'True'));
    if (t.s === 'any') out.push(withTok(toks, i, 'all'));
    if (t.s === 'all') out.push(withTok(toks, i, 'any'));
    if (t.s === 'max') out.push(withTok(toks, i, 'min'));
    if (t.s === 'min') out.push(withTok(toks, i, 'max'));
    if (t.s === 'not') { const n = i + 1 < toks.length && toks[i + 1]!.t === 'ws' ? i + 2 : i + 1; out.push(replaceRange(toks, i, n, '')); }
    // insert `not ` before the operand following a condition keyword or boolean operator
    if (['if', 'elif', 'while', 'and', 'or', 'return'].includes(t.s)) { const n = nextSig(toks, i); if (n >= 0 && toks[n]!.s !== 'not' && toks[n]!.s !== ':') out.push(replaceRange(toks, n, n, 'not ')); }
  });
  return out;
};

const arithSwap: Gen = (toks) => {
  const out: string[] = [];
  toks.forEach((t, i) => {
    if (t.t !== 'op') return;
    const p = prevSig(toks, i);
    const unary = p < 0 || (toks[p]!.t === 'op' && toks[p]!.s !== ')' ) || (toks[p]!.t === 'br' && isOpen(toks[p]!.s)) || (toks[p]!.t === 'id' && KEYWORDS.has(toks[p]!.s));
    if (ARITH.includes(t.s) && !unary) for (const r of ARITH) if (r !== t.s) out.push(withTok(toks, i, r));
    if (AUG.includes(t.s)) for (const r of AUG) if (r !== t.s) out.push(withTok(toks, i, r));
    if (BIT.includes(t.s)) for (const r of BIT) if (r !== t.s) out.push(withTok(toks, i, r));
    if (BITAUG.includes(t.s)) for (const r of BITAUG) if (r !== t.s) out.push(withTok(toks, i, r));
  });
  return out;
};

const literalOffByOne: Gen = (toks) => {
  const out: string[] = [];
  toks.forEach((t, i) => {
    if (t.t === 'num' && /^\d+$/.test(t.s)) { const n = Number(t.s); out.push(withTok(toks, i, String(n + 1))); out.push(withTok(toks, i, n - 1 < 0 ? `-${Math.abs(n - 1)}` : String(n - 1))); }
  });
  return out;
};

/** `[0]`<->`[-1]`, `[1]`<->`[0]`, `[-1]`->`[-2]`, `[1:]`<->`[:-1]`, `[1:]`<->`[:]` */
const indexFlip: Gen = (toks) => {
  const out: string[] = [];
  const s = join(toks);
  const subs: [RegExp, string][] = [[/\[0\]/g, '[-1]'], [/\[-1\]/g, '[0]'], [/\[1\]/g, '[0]'], [/\[0\]/g, '[1]'], [/\[-1\]/g, '[-2]'], [/\[1:\]/g, '[:-1]'], [/\[:-1\]/g, '[1:]'], [/\[1:\]/g, '[:]'], [/\[:\]/g, '[1:]']];
  for (const [re, rep] of subs) { let m: RegExpExecArray | null; re.lastIndex = 0; while ((m = re.exec(s))) { out.push(s.slice(0, m.index) + rep + s.slice(m.index + m[0].length)); } }
  return out;
};

/** off-by-one on atoms: atom -> atom + 1, atom - 1 (skip assignment targets, for targets, def names); remove `+ 1`, `- 1`, `1 + `; atom -> atom ** 2 / atom * 2 */
const atomOffByOne: Gen = (toks) => {
  const out: string[] = [];
  const eq = toks.findIndex((t) => t.t === 'op' && /^(=|\+=|-=|\*=|\/=|\/\/=|%=|&=|\|=|\^=)$/.test(t.s));
  for (const a of atoms(toks)) {
    if (a.kind === 'str') continue;
    if (eq >= 0 && a.to <= eq) continue; // assignment target
    const n = nextSig(toks, a.to - 1);
    if (n >= 0 && toks[n]!.t === 'br' && toks[n]!.s === '(') continue;
    const p = prevSig(toks, a.from);
    if (p >= 0 && toks[p]!.s === 'for') continue;
    if (p >= 0 && toks[p]!.s === 'def') continue;
    const text = join(toks.slice(a.from, a.to));
    if (a.kind === 'num' && /^\d+$/.test(text)) continue; // handled by literalOffByOne
    out.push(replaceRange(toks, a.from, a.to, `${text} + 1`));
    out.push(replaceRange(toks, a.from, a.to, `${text} - 1`));
    if (a.kind !== 'paren') { out.push(replaceRange(toks, a.from, a.to, `${text} ** 2`)); out.push(replaceRange(toks, a.from, a.to, `${text} * 2`)); }
  }
  const s = join(toks);
  for (const re of [/ \+ 1\b(?!\.)/g, / - 1\b(?!\.)/g, /\b1 \+ /g]) { let m: RegExpExecArray | null; re.lastIndex = 0; while ((m = re.exec(s))) out.push(s.slice(0, m.index) + s.slice(m.index + m[0].length)); }
  return out;
};

/** swap adjacent (and for <=4, all pairs of) top-level items in every bracket group; swap operands of every binary operator inside each group / at top level */
const swaps: Gen = (toks) => {
  const out: string[] = [];
  const groups: [number, number][] = [[0, toks.length]];
  toks.forEach((t, i) => { if (t.t === 'br' && isOpen(t.s)) { const c = matchClose(toks, i); if (c > i + 1) groups.push([i + 1, c]); } });
  for (const [from, to] of groups) {
    const items = splitTop(toks, from, to, (t) => t.t === 'op' && t.s === ',');
    if (items.length >= 2 && items.length <= 6) {
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        if (items.length > 4 && j !== i + 1) continue;
        const [a0, a1] = items[i]!, [b0, b1] = items[j]!;
        if (a0 >= a1 || b0 >= b1) continue;
        out.push(join(toks.slice(0, a0)) + join(toks.slice(b0, b1)) + join(toks.slice(a1, b0)) + join(toks.slice(a0, a1)) + join(toks.slice(b1)));
      }
    }
    // binary operator operand swaps within this group (per comma item)
    for (const [i0, i1] of items) {
      let d = 0;
      for (let k = i0; k < i1; k++) {
        const t = toks[k]!;
        if (t.t === 'br') { if (isOpen(t.s)) d++; else d--; continue; }
        if (d !== 0) continue;
        const bin = (t.t === 'op' && ['+', '-', '*', '/', '//', '%', ...REL].includes(t.s)) || (t.t === 'id' && ['and', 'or', 'in'].includes(t.s) && !(t.s === 'in' && isForTarget(toks, k)));
        if (!bin) continue;
        const p = prevSig(toks, k);
        if (p < i0 || (toks[p]!.t === 'op' && toks[p]!.s !== ')' ) || (toks[p]!.t === 'id' && KEYWORDS.has(toks[p]!.s) && toks[p]!.s !== 'None' && toks[p]!.s !== 'True' && toks[p]!.s !== 'False')) continue; // unary
        let l0 = i0; for (let q = k - 1; q >= i0; q--) { const u = toks[q]!; if (u.t === 'id' && ['return', 'yield', 'if', 'elif', 'while', 'in', 'for', 'not', 'and', 'or', 'else', 'lambda'].includes(u.s) && !(u.s === 'in' && q === k)) { l0 = q + 1; break; } if (u.t === 'op' && /^(=|\+=|-=|\*=|:)$/.test(u.s)) { l0 = q + 1; break; } }
        let r1 = i1; for (let q = k + 1; q < i1; q++) { const u = toks[q]!; if (u.t === 'id' && ['for', 'if', 'else', 'and', 'or'].includes(u.s)) { r1 = q; break; } if (u.t === 'op' && u.s === ':') { r1 = q; break; } }
        const L = splitTop(toks, l0, k, () => false)[0]!, R = splitTop(toks, k + 1, r1, () => false)[0]!;
        if (L[0] >= L[1] || R[0] >= R[1]) continue;
        const lt = join(toks.slice(L[0], L[1])), rt = join(toks.slice(R[0], R[1]));
        if (lt === rt) continue;
        out.push(join(toks.slice(0, L[0])) + rt + join(toks.slice(L[1], k)) + t.s + join(toks.slice(k + 1, R[0])) + lt + join(toks.slice(R[1])));
      }
    }
  }
  return out;
};

const constSubst: Gen = (toks, env) => {
  const out: string[] = [];
  const pool = [...new Set([...env.lineLiterals, ...env.literals])];
  toks.forEach((t, i) => {
    if (t.t === 'num' || t.t === 'str') for (const lit of pool) if (lit !== t.s && (t.t === 'num') === /^-?\d/.test(lit)) out.push(withTok(toks, i, lit));
    if (t.t === 'id' && CONST_KW.has(t.s)) for (const r of ['None', 'True', 'False', '0', '1', '-1']) if (r !== t.s) out.push(withTok(toks, i, r));
  });
  // empty collections
  const s = join(toks);
  for (const [re, reps] of [[/\[\]/g, ['[[]]', '[0]', '[1]', '[()]', '[None]']], [/\{\}/g, ['set()', '[]']], [/\(\)/g, ['[]']]] as [RegExp, string[]][]) {
    let m: RegExpExecArray | null; re.lastIndex = 0;
    while ((m = re.exec(s))) { const idx = m.index; for (const rep of reps) out.push(s.slice(0, idx) + rep + s.slice(idx + m[0].length)); for (const id of env.ids.slice(0, 12)) out.push(s.slice(0, idx) + `[${id}]` + s.slice(idx + m[0].length)); }
  }
  return out;
};

/** attribute name substitution `.foo` -> `.bar` */
const attrSubst: Gen = (toks, env) => {
  const out: string[] = [];
  toks.forEach((t, i) => { const p = prevSig(toks, i); if (t.t === 'id' && p >= 0 && toks[p]!.s === '.') for (const a of env.attrs) if (a !== t.s) out.push(withTok(toks, i, a)); });
  return out;
};

/** identifier substitution with in-scope identifiers (nearest first); skip def lines, attribute names, keywords */
const identSubst: Gen = (toks, env) => {
  const out: string[] = [];
  const isDef = toks.some((t) => t.s === 'def');
  toks.forEach((t, i) => {
    if (t.t !== 'id' || KEYWORDS.has(t.s)) return;
    const p = prevSig(toks, i);
    if (p >= 0 && (toks[p]!.s === '.' || toks[p]!.s === 'def')) return;
    if (isDef) return;
    for (const id of env.ids) if (id !== t.s && !KEYWORDS.has(id)) out.push(withTok(toks, i, id));
  });
  return out;
};

/** swap two distinct identifiers occurring in the line (all occurrences) */
const identSwap: Gen = (toks) => {
  const out: string[] = [];
  const names = [...new Set(toks.filter((t, i) => t.t === 'id' && !KEYWORDS.has(t.s) && !(prevSig(toks, i) >= 0 && toks[prevSig(toks, i)]!.s === '.')).map((t) => t.s))];
  for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) {
    out.push(join(toks.map((t, i) => (t.t === 'id' && !(prevSig(toks, i) >= 0 && toks[prevSig(toks, i)]!.s === '.') ? { ...t, s: t.s === names[a] ? names[b]! : t.s === names[b] ? names[a]! : t.s } : t))));
  }
  return out;
};

/** statement-shape templates: return/yield/assignment RHS, conditions, while True, for-iterable slices, method->assign */
const templates: Gen = (toks, env) => {
  const out: string[] = [];
  const s = join(toks);
  const ids = env.ids.slice(0, 14);
  let m: RegExpExecArray | null;
  // return / yield E
  if ((m = /^(return|yield)(\s+)(.+)$/.exec(s)) && m[3] !== '') {
    const kw = m[1]!, E = m[3]!;
    for (const id of ids) { out.push(`${kw} ${id}`); out.push(`${kw} ${id} + ${E}`); out.push(`${kw} ${E} + ${id}`); }
    for (const id of ids.slice(0, 8)) for (const c of ['== 0', '!= 0', '== 1', 'is None', 'is not None', '> 0']) out.push(`${kw} ${id} ${c}`);
    for (const id of ids.slice(0, 8)) out.push(`${kw} not ${id}`);
    out.push(`${kw} ${E} + 1`, `${kw} ${E} - 1`, `${kw} 1 + ${E}`, `${kw} not ${E}`, `${kw} -${E}`, `${kw} len(${E})`, `${kw} list(${E})`, `${kw} [${E}]`, `${kw} max(0, ${E})`);
    for (const id of ids.slice(0, 8)) { out.push(`${kw} max(${id}, ${E})`); out.push(`${kw} min(${id}, ${E})`); }
  } else if ((m = /^return$/.exec(s))) { for (const id of ids) out.push(`return ${id}`); out.push('return None', 'return True', 'return False', 'return 0', 'return []'); }
  // X = E / X op= E
  if ((m = /^([A-Za-z_][\w.\[\], ]*?)\s*(=|\+=|-=)\s*(.+)$/.exec(s)) && !/^(if|while|elif|for|return|yield)\b/.test(s) && !/[<>=!]=/.test(m[1]!)) {
    const X = m[1]!.trim(), op = m[2]!, E = m[3]!;
    out.push(`${X} ${op} max(0, ${E})`, `${X} ${op} min(0, ${E})`, `${X} ${op} ${E} + 1`, `${X} ${op} ${E} - 1`, `${X} ${op} 1 + ${E}`, `${X} ${op} not ${E}`, `${X} ${op} -${E}`, `${X} ${op} [${E}]`, `${X} ${op} list(${E})`, `${X} ${op} len(${E})`, `${X} ${op} ${X}`, `${X} ${op} ${E} + ${X}`, `${X} ${op} ${X} + ${E}`);
    for (const id of ids.slice(0, 10)) { out.push(`${X} ${op} max(${id}, ${E})`); out.push(`${X} ${op} min(${id}, ${E})`); out.push(`${X} ${op} ${id} + ${E}`); out.push(`${X} ${op} ${E} + ${id}`); out.push(`${X} ${op} ${E} - ${id}`); out.push(`${X} ${op} ${id}`); }
    if (op === '=') { out.push(`${X} += ${E}`, `${X} -= ${E}`); }
  }
  // if / elif / while C:
  if ((m = /^(if|elif|while)\s+(.+):$/.exec(s))) {
    const kw = m[1]!, C = m[2]!;
    if (C === 'True') for (const id of ids) { out.push(`${kw} ${id}:`, `${kw} len(${id}) > 0:`, `${kw} ${id} is not None:`, `${kw} not ${id}:`); }
    for (const id of ids.slice(0, 10)) {
      out.push(`${kw} ${C} or ${id} is None:`, `${kw} ${id} is None or ${C}:`, `${kw} ${C} or not ${id}:`, `${kw} not ${id} or ${C}:`, `${kw} ${C} and ${id} is not None:`, `${kw} ${id} is not None and ${C}:`, `${kw} ${C} and ${id}:`, `${kw} ${id} and ${C}:`, `${kw} ${C} or ${id}:`);
    }
    out.push(`${kw} not (${C}):`);
  }
  // for T in E:
  if ((m = /^for\s+(.+?)\s+in\s+(.+):$/.exec(s))) {
    const T = m[1]!, E = m[2]!;
    for (const id of ids.slice(0, 10)) { out.push(`for ${T} in ${E}[${id}:]:`, `for ${T} in ${E}[:${id}]:`, `for ${T} in ${id}:`); }
    out.push(`for ${T} in ${E}[1:]:`, `for ${T} in ${E}[:-1]:`, `for ${T} in reversed(${E}):`, `for ${T} in sorted(${E}):`, `for ${T} in enumerate(${E}):`, `for ${T} in range(${E}):`, `for ${T} in range(len(${E})):`);
  }
  // recv.method(arg) as a statement -> recv = arg ; recv.method(arg) -> recv.othermethod(arg)
  if ((m = /^([A-Za-z_][\w.\[\]]*)\.([A-Za-z_]\w*)\((.*)\)$/.exec(s))) {
    const recv = m[1]!, arg = m[3]!;
    out.push(`${recv} = ${arg}`, `${recv} += ${arg}`);
    for (const meth of ['append', 'extend', 'add', 'update', 'remove', 'discard', 'pop', 'insert', 'appendleft']) if (meth !== m[2]) out.push(`${recv}.${meth}(${arg})`);
  }
  return out;
};

/** strip one call layer around a single argument: f(x) -> x ; drop one argument; mirror a sibling's slice onto bare-identifier args; x[a, b] -> x[a] / x[b] */
const stripCall: Gen = (toks) => {
  const out: string[] = [];
  toks.forEach((t, i) => {
    if (t.t !== 'br' || t.s !== '(') return;
    const p = prevSig(toks, i);
    if (p < 0 || toks[p]!.t !== 'id' || KEYWORDS.has(toks[p]!.s)) return;
    const c = matchClose(toks, i); if (c < 0) return;
    const args = splitTop(toks, i + 1, c, (u) => u.t === 'op' && u.s === ',');
    if (args.length === 1 && args[0]![0] < args[0]![1]) {
      const pp = prevSig(toks, p); if (pp >= 0 && toks[pp]!.s === '.') { out.push(replaceRange(toks, pp, c + 1, join(toks.slice(args[0]![0], args[0]![1])))); }
      out.push(replaceRange(toks, p, c + 1, join(toks.slice(args[0]![0], args[0]![1]))));
    }
    if (args.length >= 2) {
      for (let k = 0; k < args.length; k++) { const rest = args.filter((_, j) => j !== k).map(([a, b]) => join(toks.slice(a, b))).join(', '); out.push(replaceRange(toks, i + 1, c, rest)); }
      for (const [a, b] of args) {
        const at = join(toks.slice(a, b)); const sm = /^([A-Za-z_]\w*)(\[[^\]]*:[^\]]*\])$/.exec(at); if (!sm) continue;
        for (const [a2, b2] of args) { if (a2 === a) continue; const t2 = join(toks.slice(a2, b2)); if (/^[A-Za-z_]\w*$/.test(t2)) out.push(replaceRange(toks, a2, b2, `${t2}${sm[2]}`)); }
      }
    }
  });
  toks.forEach((t, i) => {
    if (t.t !== 'br' || t.s !== '[') return;
    const c = matchClose(toks, i); if (c < 0) return;
    const parts = splitTop(toks, i + 1, c, (u) => u.t === 'op' && u.s === ',');
    if (parts.length === 2) for (const [a, b] of parts) out.push(replaceRange(toks, i + 1, c, join(toks.slice(a, b))));
  });
  return out;
};

/** call atom -> identifier ; atom -> atom ± identifier (call arguments and RHS only) */
const atomIdent: Gen = (toks, env) => {
  const out: string[] = [];
  const eq = toks.findIndex((t) => t.t === 'op' && /^(=|\+=|-=)$/.test(t.s));
  const ids = env.ids.slice(0, 16);
  for (const a of atoms(toks)) {
    if (eq >= 0 && a.to <= eq) continue;
    const p = prevSig(toks, a.from);
    if (p >= 0 && (toks[p]!.s === 'for' || toks[p]!.s === 'def')) continue;
    const text = join(toks.slice(a.from, a.to));
    if (a.kind === 'call') for (const id of ids) if (!text.startsWith(id + '(')) out.push(replaceRange(toks, a.from, a.to, id));
    if (a.kind === 'name' || a.kind === 'sub' || a.kind === 'attr') for (const id of ids) if (id !== text) { out.push(replaceRange(toks, a.from, a.to, `${text} - ${id}`)); out.push(replaceRange(toks, a.from, a.to, `${text} + ${id}`)); }
  }
  return out;
};

/** boundary: relational operator change together with ±1 on a literal operand (`== 0` -> `<= 1`) */
const boundary: Gen = (toks) => {
  const out: string[] = [];
  toks.forEach((t, i) => {
    if (t.t !== 'op' || !REL.includes(t.s)) return;
    const n = nextSig(toks, i);
    if (n < 0 || toks[n]!.t !== 'num' || !/^\d+$/.test(toks[n]!.s)) return;
    const v = Number(toks[n]!.s);
    for (const r of REL) for (const d of [1, -1]) { if (r === t.s) continue; const nv = v + d; out.push(replaceRange(toks, i, n + 1, `${r}${join(toks.slice(i + 1, n))}${nv < 0 ? `-${-nv}` : nv}`)); }
  });
  return out;
};

const OPERATORS: [string, Gen][] = [
  ['rel_swap', relSwap], ['bool_swap', boolSwap], ['arith_swap', arithSwap], ['literal_off_by_one', literalOffByOne], ['index_flip', indexFlip],
  ['boundary', boundary], ['swap', swaps], ['strip_call', stripCall], ['atom_off_by_one', atomOffByOne], ['attr_subst', attrSubst],
  ['template', templates], ['const_subst', constSubst], ['ident_swap', identSwap], ['ident_subst', identSubst], ['atom_ident', atomIdent],
];

export function enumerateCandidates(ctx: MutationContext, cap = 200): Candidate[] {
  const line = ctx.lines[ctx.lineIndex] ?? '';
  const indent = line.slice(0, indentOf(line));
  const body = stripComment(line).trim();
  if (!body) return [];
  const toks = tokenize(body);
  const { ids, attrs } = scopeIdentifiers(ctx.lines, ctx.lineIndex);
  const env: Env = { ids, attrs, literals: ctx.testLiterals, lineLiterals: harvestLiterals(body, 10), body };
  const seen = new Set<string>([normLine(body)]);
  const out: Candidate[] = [];
  for (const [op, gen] of OPERATORS) {
    let produced: string[] = [];
    try { produced = gen(toks, env); } catch { produced = []; }
    for (const text of produced) {
      const t = text.replace(/\s+$/, '');
      if (!t || /^\s*$/.test(t)) continue;
      const key = normLine(t);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: indent + t.trim(), op });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

const SYNTAX_PY = `
import sys, json
d = json.load(sys.stdin)
lines, idx, cands = d["lines"], d["lineIndex"], d["candidates"]
ok = []
for i, c in enumerate(cands):
    ls = list(lines); ls[idx] = c
    try:
        compile("\\n".join(ls) + "\\n", "<cand>", "exec"); ok.append(i)
    except (SyntaxError, ValueError, TypeError, RecursionError):
        pass
print(json.dumps(ok))
`;

/** Drop candidates whose substitution into the program does not compile (one python3 process per call). */
export function filterSyntactic(ctx: MutationContext, cands: Candidate[]): Candidate[] {
  if (cands.length === 0) return [];
  const r = spawnSync('python3', ['-c', SYNTAX_PY], { input: JSON.stringify({ lines: ctx.lines, lineIndex: ctx.lineIndex, candidates: cands.map((c) => c.text) }), encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0 || !r.stdout) return cands;
  const ok = new Set(JSON.parse(r.stdout.trim()) as number[]);
  return cands.filter((_, i) => ok.has(i));
}
