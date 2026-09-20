/**
 * Shared pieces for the probe-tokens experiments: corpus loading, a small Python tokenizer and
 * detokenizer, the candidate-token set with semantic option keys, a Jev wrapper with cost and
 * latency accounting, and a test runner (python3 run_tests.py, no pytest needed).
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJevDecider } from '../../src/jev/client.ts';
import { choice } from '../../src/jev/questions.ts';
import type { Json, Question, Decider } from '../../src/core/types.ts';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const QB = '/tmp/quixbugs';
export const MARK = '<<<FIX THIS LINE>>>';

export interface Item {
  name: string; kind: 'replace' | 'insert'; indent: string; buggy_line: string | null; fix_line: string;
  marked_program: string; buggy_program: string; tests: Json[]; tests_kind: 'json' | 'pytest_source';
}
export function loadCorpus(): Item[] { return JSON.parse(readFileSync(join(HERE, 'out/corpus.json'), 'utf8')) as Item[]; }

// ---------------------------------------------------------------------------- tokenizer
export type TokClass = 'identifier' | 'keyword' | 'literal' | 'number' | 'string' | 'operator' | 'punct';
export interface Tok { text: string; cls: TokClass }
export const KEYWORDS = ['and', 'or', 'not', 'in', 'is', 'if', 'else', 'elif', 'for', 'while', 'return', 'yield', 'lambda', 'def', 'break', 'continue', 'pass', 'import', 'from', 'as', 'del', 'assert', 'with', 'class', 'try', 'except', 'raise', 'global'];
export const LITERAL_KW = ['True', 'False', 'None'];
export const METHODS = ['add', 'append', 'pop', 'extend', 'update', 'get', 'items', 'keys', 'values', 'remove', 'insert', 'join', 'split', 'sort', 'copy'];
export const BUILTINS = ['len', 'max', 'min', 'range', 'enumerate', 'list', 'set', 'dict', 'tuple', 'all', 'any', 'abs', 'sum', 'sorted', 'reversed', 'zip', 'map', 'str', 'int', 'float', 'isinstance', 'print', 'iter', 'next'];
const OPS = ['**=', '//=', '>>=', '<<=', '->', '**', '//', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '+', '-', '*', '/', '%', '<', '>', '=', '&', '|', '^', '~', '@'];
const PUNCT = ['(', ')', '[', ']', '{', '}', ',', ':', '.', ';'];
export const OP_NAMES: Record<string, [string, string]> = {
  '**=': ['op_power_assign', 'power and assign'], '//=': ['op_floordiv_assign', 'floor-divide and assign'], '>>=': ['op_rshift_assign', 'right-shift and assign'], '<<=': ['op_lshift_assign', 'left-shift and assign'], '->': ['op_arrow', 'return annotation arrow'],
  '**': ['op_power', 'exponentiation'], '//': ['op_floordiv', 'floor division'], '==': ['op_equal', 'equality comparison'], '!=': ['op_not_equal', 'inequality comparison'], '<=': ['op_less_equal', 'less than or equal'], '>=': ['op_greater_equal', 'greater than or equal'],
  '+=': ['op_plus_assign', 'add and assign'], '-=': ['op_minus_assign', 'subtract and assign'], '*=': ['op_times_assign', 'multiply and assign'], '/=': ['op_divide_assign', 'divide and assign'], '%=': ['op_modulo_assign', 'modulo and assign'], '&=': ['op_bitand_assign', 'bitwise-and and assign'], '|=': ['op_bitor_assign', 'bitwise-or and assign'], '^=': ['op_bitxor_assign', 'bitwise-xor and assign'],
  '<<': ['op_lshift', 'left shift'], '>>': ['op_rshift', 'right shift'], '+': ['op_plus', 'addition or concatenation'], '-': ['op_minus', 'subtraction or negation'], '*': ['op_star', 'multiplication or unpacking'], '/': ['op_divide', 'true division'], '%': ['op_modulo', 'modulo'], '<': ['op_less', 'less than'], '>': ['op_greater', 'greater than'], '=': ['op_assign', 'assignment'], '&': ['op_bitand', 'bitwise and'], '|': ['op_bitor', 'bitwise or'], '^': ['op_bitxor', 'bitwise xor'], '~': ['op_invert', 'bitwise not'], '@': ['op_matmul', 'matrix multiply'],
  '(': ['punct_open_paren', 'open parenthesis'], ')': ['punct_close_paren', 'close parenthesis'], '[': ['punct_open_bracket', 'open square bracket'], ']': ['punct_close_bracket', 'close square bracket'], '{': ['punct_open_brace', 'open curly brace'], '}': ['punct_close_brace', 'close curly brace'], ',': ['punct_comma', 'comma'], ':': ['punct_colon', 'colon'], '.': ['punct_dot', 'attribute access dot'], ';': ['punct_semicolon', 'semicolon'],
};
export function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  let s = line.replace(/#.*$/, '');
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; }
      out.push({ text: s.slice(i, j + 1), cls: 'string' }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      const m = /^(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?/.exec(s.slice(i))!; out.push({ text: m[0], cls: 'number' }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_]\w*/.exec(s.slice(i))!; const t = m[0];
      out.push({ text: t, cls: KEYWORDS.includes(t) ? 'keyword' : LITERAL_KW.includes(t) ? 'literal' : 'identifier' }); i += t.length; continue;
    }
    const op = OPS.find((o) => s.startsWith(o, i)); if (op) { out.push({ text: op, cls: 'operator' }); i += op.length; continue; }
    if (PUNCT.includes(c)) { out.push({ text: c, cls: 'punct' }); i++; continue; }
    throw new Error(`tokenize: unexpected char ${JSON.stringify(c)} in ${JSON.stringify(line)}`);
  }
  return out;
}
/** Join tokens into valid Python (spacing is cosmetic; equality is checked on token sequences). */
export function detokenize(toks: Tok[]): string {
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!, p = toks[i - 1];
    if (i === 0) { out += t.text; continue; }
    const noSpaceBefore = [')', ']', ',', ':', '.', ';'].includes(t.text) || (p && ['(', '[', '.', '{'].includes(p.text)) || (['(', '['].includes(t.text) && p && (p.cls === 'identifier' || p.cls === 'string' || [')', ']'].includes(p.text)));
    out += (noSpaceBefore ? '' : ' ') + t.text;
  }
  return out;
}
export function sameTokens(a: Tok[], b: Tok[]): boolean { return a.length === b.length && a.every((t, i) => t.text === b[i]!.text); }

// ---------------------------------------------------------------------------- candidate set
export interface Cand { key: string; tok: Tok; desc: Json }
function sanitize(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x'; }
/** Candidate tokens for a program: identifiers in the program, builtins, keywords, operators/punct, literals in program and tests, plus end_of_line. */
export function candidateSet(item: Item): { cands: Cand[]; byText: Map<string, Cand> } {
  const seen = new Map<string, Cand>(); const keys = new Set<string>();
  const add = (tok: Tok, key: string, desc: Json): void => {
    if (seen.has(tok.text)) return;
    let k = key, n = 2; while (keys.has(k)) k = `${key}_${n++}`;
    keys.add(k); seen.set(tok.text, { key: k, tok, desc });
  };
  const progToks = item.buggy_program.split('\n').flatMap((l) => { try { return tokenize(l); } catch { return []; } });
  const testText = item.tests_kind === 'json' ? JSON.stringify(item.tests) : (item.tests as string[]).join('\n');
  const testToks = (() => { try { return tokenize(testText.replace(/[^\x20-\x7e]/g, ' ')); } catch { return [] as Tok[]; } })();
  for (const t of progToks) if (t.cls === 'identifier') add(t, `name_${sanitize(t.text)}`, { kind: 'identifier', token: t.text });
  for (const b of BUILTINS) add({ text: b, cls: 'identifier' }, `name_${b}`, { kind: 'builtin', token: b });
  for (const m of METHODS) add({ text: m, cls: 'identifier' }, `name_${m}`, { kind: 'common method name', token: m });
  for (const k of KEYWORDS) add({ text: k, cls: 'keyword' }, `keyword_${k}`, { kind: 'keyword', token: k });
  for (const k of LITERAL_KW) add({ text: k, cls: 'literal' }, `literal_${k.toLowerCase()}`, { kind: 'literal', token: k });
  for (const o of [...OPS, ...PUNCT]) { const [key, meaning] = OP_NAMES[o]!; add({ text: o, cls: PUNCT.includes(o) ? 'punct' : 'operator' }, key, { kind: PUNCT.includes(o) ? 'punctuation' : 'operator', token: o, meaning }); }
  let lits = 0;
  for (const t of [...progToks, ...testToks]) {
    if (t.cls === 'number' && lits < 40) { add(t, `number_${sanitize(t.text)}`, { kind: 'number', token: t.text }); lits++; }
    else if (t.cls === 'string' && lits < 40 && t.text.length <= 20) { add(t, `string_${sanitize(t.text.slice(1, -1)) === 'x' && t.text.length === 2 ? 'empty' : sanitize(t.text.slice(1, -1))}`, { kind: 'string', token: t.text }); lits++; }
  }
  return { cands: [...seen.values()], byText: seen };
}
export const END_KEY = 'end_of_line';
export function tokenOptions(cands: Cand[]): Record<string, Json> {
  const o: Record<string, Json> = {};
  for (const c of cands) o[c.key] = c.desc;
  o[END_KEY] = { kind: 'end', meaning: 'the partial line is already the complete correct line; nothing more to add' };
  return o;
}

// ---------------------------------------------------------------------------- Jev
export function makeJev(): { jev: Decider; signal: AbortSignal; usage: { cost: number; calls: number; lat: number[]; inTok: number } ; capUsd: number } {
  const key = process.env['OPENROUTER_API_KEY'] ?? '';
  if (!key) throw new Error('OPENROUTER_API_KEY missing (run with --env-file=.env)');
  const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
  return { jev, signal: new AbortController().signal, usage: { cost: 0, calls: 0, lat: [], inTok: 0 }, capUsd: Number(process.env['JEV_CAP_USD'] ?? 0.9) };
}
export type J = ReturnType<typeof makeJev>;
export async function askChoice(j: J, state: Json, id: string, instructions: string, options: Record<string, Json>, stage: 'context' | 'risk' | 'judge' = 'risk'): Promise<{ probs: Record<string, number>; ranked: [string, number][]; latencyMs: number; cost: number }> {
  if (j.usage.cost > j.capUsd) throw new Error(`spend cap ${j.capUsd} reached (${j.usage.cost.toFixed(4)})`);
  const qs: Record<string, Question> = { [id]: choice(instructions, options) };
  const r = await j.jev.ask(state, qs, { signal: j.signal, stage, step: 1 });
  j.usage.cost += r.usage.costUsd; j.usage.calls++; j.usage.lat.push(r.latencyMs); j.usage.inTok += r.usage.inputTokens;
  const a = r.answers[id]!; if (a.type !== 'choice') throw new Error('not a choice answer');
  const ranked = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]) as [string, number][];
  return { probs: a.probabilities, ranked, latencyMs: r.latencyMs, cost: r.usage.costUsd };
}
export function p50(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; }

// ---------------------------------------------------------------------------- tests as oracle
export function runTests(item: Item, line: string): { pass: boolean; detail: string } {
  const prog = item.marked_program.replace(item.indent + MARK, item.indent + line);
  const dir = mkdtempSync('/tmp/jevonly/work/patch-'); const f = join(dir, `${item.name}.py`); writeFileSync(f, prog + '\n');
  try {
    const out = execFileSync('python3', [join(HERE, 'run_tests.py'), QB, item.name, f], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return { pass: out.startsWith('PASS'), detail: out.trim() };
  } catch (e) { const o = (e as { stdout?: string }).stdout ?? ''; return { pass: false, detail: (o || String(e)).trim().slice(0, 120) }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k]!, k); } }));
  return out;
}
export function stateFor(item: Item, partial: Tok[]): Json {
  return {
    task: `The Python function \`${item.name}\` has a one-line bug. In \`program\` the faulty position is marked \`${MARK}\` (the marker keeps the correct indentation). ${item.buggy_line === null ? 'No line existed there: a new line must be inserted.' : 'The original wrong line at that position is `buggy_line`; the correct line is usually a small edit of it.'} The corrected program must make every entry of \`tests\` pass.`,
    program: item.marked_program,
    buggy_line: item.buggy_line,
    tests: item.tests,
    partial_line: detokenize(partial),
    partial_tokens: partial.map((t) => t.text),
  };
}
export const NEXT_TOKEN_Q = `\`partial_line\` is the beginning of the correct replacement line for the \`${MARK}\` marker in \`program\` (its tokens so far, left to right, are \`partial_tokens\`). Which single Python token comes immediately next in the correct line? Choose \`${END_KEY}\` if \`partial_line\` is already the complete correct line. Choose \`none_of_these\` if the next token is not offered. Answer literally: exactly one token, not a whole expression.`;

// ---------------------------------------------------------------------------- grammar filter (code proposes: only syntactically possible next tokens)
const VALUE_START_KW = new Set(['not', 'lambda']);
const AFTER_VALUE_KW = new Set(['and', 'or', 'not', 'in', 'is', 'if', 'else', 'for']);
const STMT_KW = new Set(['return', 'yield', 'if', 'while', 'for', 'elif', 'else', 'pass', 'break', 'continue', 'del', 'assert', 'raise', 'not', 'lambda', 'import', 'from', 'global', 'with', 'try', 'except']);
const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
function isValueTok(t: Tok): boolean { return t.cls === 'identifier' || t.cls === 'number' || t.cls === 'string' || t.cls === 'literal' || t.text === ')' || t.text === ']' || t.text === '}'; }
/** Predicate over candidate tokens (and END via text '<END>') given the prefix so far. Conservative: allows a superset of legal Python. */
export function legalNext(prefix: Tok[]): (t: Tok | '<END>') => boolean {
  const stack: string[] = []; for (const t of prefix) { if (t.text in OPEN) stack.push(OPEN[t.text]!); else if ([')', ']', '}'].includes(t.text) && stack[stack.length - 1] === t.text) stack.pop(); }
  const balanced = stack.length === 0; const close = stack[stack.length - 1];
  const prev = prefix[prefix.length - 1];
  const valueStart = (t: Tok): boolean => t.cls === 'identifier' || t.cls === 'number' || t.cls === 'string' || t.cls === 'literal' || ['(', '[', '{', '-', '~', '*'].includes(t.text) || (t.cls === 'keyword' && VALUE_START_KW.has(t.text));
  return (t) => {
    if (t === '<END>') {
      if (!prev || !balanced) return false;
      if (isValueTok(prev) || prev.text === ':') return true;
      return prev.cls === 'keyword' && ['return', 'yield', 'pass', 'break', 'continue'].includes(prev.text);
    }
    if (!prev) return valueStart(t) || (t.cls === 'keyword' && STMT_KW.has(t.text));
    if ([')', ']', '}'].includes(t.text)) { if (t.text !== close) return false; return isValueTok(prev) || prev.text === ':' || (prev.text in OPEN) || prev.text === ','; }
    if (prev.text === '.') return t.cls === 'identifier';
    if (isValueTok(prev)) return t.cls === 'operator' || ['(', '[', ',', ':', '.'].includes(t.text) || (t.cls === 'keyword' && AFTER_VALUE_KW.has(t.text));
    if (prev.cls === 'operator' || prev.text in OPEN || prev.text === ',') return valueStart(t) || (prev.text in OPEN && t.text === ':') || (prev.text === '[' && t.text === ':');
    if (prev.text === ':') return valueStart(t) || (t.cls === 'keyword' && STMT_KW.has(t.text));
    if (prev.cls === 'keyword') {
      switch (prev.text) {
        case 'for': case 'lambda': case 'del': case 'global': case 'import': case 'from': case 'as': case 'def': case 'class': return t.cls === 'identifier' || t.text === '(' || t.text === ':';
        case 'else': return t.text === ':' || valueStart(t);
        case 'not': return valueStart(t) || t.text === 'in';
        case 'is': return valueStart(t) || t.text === 'not';
        case 'pass': case 'break': case 'continue': return false;
        default: return valueStart(t) || (t.cls === 'keyword' && (t.text === 'not' || t.text === 'lambda'));
      }
    }
    return true;
  };
}
export function filterOptions(cands: Cand[], prefix: Tok[]): Record<string, Json> {
  const ok = legalNext(prefix); const o: Record<string, Json> = {};
  for (const c of cands) if (ok(c.tok)) o[c.key] = c.desc;
  if (ok('<END>')) o[END_KEY] = { kind: 'end', meaning: 'the partial line is already the complete correct line; nothing more to add' };
  return o;
}
