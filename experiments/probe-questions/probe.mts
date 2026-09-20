/**
 * Probe-question design sensitivity (live Jev, ~$0.05): on 20 QuixBugs programs (alphabetical, those
 * with JSON test cases), vary one thing at a time on the localisation question ("which line is buggy")
 * and the selection question ("which candidate replacement is the fix") and measure top-1 / top-3 /
 * MRR / P(correct) / cost / latency. Also repeat stability (5 programs x 5 repeats of the base).
 *
 * Usage:
 *   env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/probe-questions/probe.mts [filterRegex]
 * Writes experiments/probe-questions/results.jsonl (one row per request/item) and summary.json, prints markdown.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJevDecider } from '../../src/jev/client.ts';
import { choice, noul, score } from '../../src/jev/questions.ts';
import type { Json, Question, Answer } from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = '/tmp/quixbugs';
const PROGRAMS = ['bitcount', 'bucketsort', 'find_first_in_sorted', 'find_in_sorted', 'flatten', 'gcd', 'get_factors', 'hanoi',
  'is_valid_parenthesization', 'kheapsort', 'knapsack', 'kth', 'lcs_length', 'levenshtein', 'lis', 'longest_common_subsequence',
  'max_sublist_sum', 'mergesort', 'next_palindrome', 'next_permutation'];
const N_TESTS = 3;
const MAX_CANDS = 60;
const SPEND_CAP = 1.0;
const CONCURRENCY = 6;
const filter = process.argv[2] && process.argv[2] !== '-' ? new RegExp(process.argv[2]) : null;
const RUN = process.argv[3] ?? 'run';
const DUMP = process.argv.includes('--dump');

const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;
const actualOutputs = JSON.parse(readFileSync(join(HERE, 'actual-outputs.json'), 'utf8')) as Record<string, { input: Json; expected: Json; actual: string }[]>;

// ------------------------------------------------------------------ program loading
interface Program {
  name: string;
  lines: { text: string; lineNo: number }[]; // non-blank code lines, original 1-based numbers
  truthIdx: number; // index into lines
  buggyLine: string;
  fixedLine: string;
  docstring: string;
  tests: { input: Json; expected: Json; actual: string }[];
  cands: string[]; // candidate replacements, includes fixedLine and buggyLine
  truthCand: number;
}
function splitSrc(src: string): { code: string[]; doc: string } {
  const i = src.indexOf('\n"""');
  const code = (i > 0 ? src.slice(0, i) : src).replace(/\s+$/, '').split('\n');
  const doc = i > 0 ? src.slice(i).replace(/^\s*"""|"""\s*$/g, '').trim() : '';
  return { code, doc };
}
const PY_KEYWORDS = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self'.split(' '));
const MUTATIONS: [RegExp, string][] = [
  [/<=/g, '<'], [/>=/g, '>'], [/(?<![<>=!])<(?!=)/g, '<='], [/(?<![<>=!])>(?!=)/g, '>='], [/(?<![<>=!])<(?!=)/g, '>'], [/(?<![<>=!])>(?!=)/g, '<'],
  [/==/g, '!='], [/!=/g, '=='], [/\+ 1\b/g, '- 1'], [/- 1\b/g, '+ 1'], [/\band\b/g, 'or'], [/\bor\b/g, 'and'], [/\+/g, '-'], [/(?<!\*)\*(?!\*)/g, '/'],
  [/\bTrue\b/g, 'False'], [/\bFalse\b/g, 'True'], [/\bnot /g, ''], [/\[0\]/g, '[-1]'], [/\[-1\]/g, '[0]'], [/\/\//g, '/'], [/(?<!\/)\/(?!\/)/g, '//'],
  [/\^=/g, '&='], [/&=/g, '|='], [/\[1:\]/g, '[:-1]'], [/\[k:\]/g, '[:k]'], [/\bmax\(/g, 'min('], [/\bmin\(/g, 'max('],
];
function mutants(line: string, idents: string[]): string[] {
  const out = new Set<string>();
  for (const [re, rep] of MUTATIONS) { const m = line.replace(re, rep); if (m !== line) out.add(m); }
  const sw = line.replace(/\(([^(),]+), ([^(),]+)\)/, '($2, $1)'); if (sw !== line) out.add(sw);
  // integer literal +-1
  for (const m of line.matchAll(/\b\d+\b/g)) { const v = Number(m[0]); for (const d of [v + 1, Math.max(0, v - 1)]) { const s = line.slice(0, m.index) + d + line.slice(m.index! + m[0].length); if (s !== line) out.add(s); } }
  // identifier substitution: each identifier occurrence -> each other program identifier
  for (const m of line.matchAll(/[A-Za-z_]\w*/g)) {
    if (PY_KEYWORDS.has(m[0])) continue;
    for (const id of idents) { if (id === m[0]) continue; out.add(line.slice(0, m.index) + id + line.slice(m.index! + m[0].length)); }
  }
  return [...out];
}
function loadProgram(name: string): Program {
  const b = splitSrc(readFileSync(join(ROOT, 'python_programs', `${name}.py`), 'utf8'));
  const f = splitSrc(readFileSync(join(ROOT, 'correct_python_programs', `${name}.py`), 'utf8'));
  const lines = b.code.map((text, i) => ({ text, lineNo: i + 1 })).filter((l) => l.text.trim() !== '');
  const fixedNb = f.code.filter((l) => l.trim() !== '');
  let truthIdx = -1;
  for (let i = 0; i < Math.max(lines.length, fixedNb.length); i++) if (lines[i]?.text !== fixedNb[i]) { truthIdx = i; break; }
  if (truthIdx < 0) throw new Error(`${name}: no diff`);
  const buggyLine = lines[truthIdx]!.text, fixedLine = fixedNb[truthIdx]!;
  const idents = [...new Set(b.code.join('\n').match(/[A-Za-z_]\w*/g) ?? [])].filter((x) => !PY_KEYWORDS.has(x));
  let cands = mutants(buggyLine, idents).filter((c) => c !== buggyLine);
  cands.sort();
  if (cands.length > MAX_CANDS - 2) {
    // deterministic thinning that keeps the fix if present: stride sample
    const keep = new Set<number>(); const stride = cands.length / (MAX_CANDS - 2);
    for (let i = 0; i < MAX_CANDS - 2; i++) keep.add(Math.floor(i * stride));
    cands = cands.filter((_, i) => keep.has(i));
  }
  if (!cands.includes(fixedLine)) cands.push(fixedLine);
  cands.push(buggyLine);
  cands.sort();
  const tests = actualOutputs[name]!.slice(0, N_TESTS);
  return { name, lines, truthIdx, buggyLine, fixedLine, docstring: b.doc, tests, cands, truthCand: cands.indexOf(fixedLine) };
}

// ------------------------------------------------------------------ state builders
interface StateOpts { actual?: boolean; docstring?: boolean; asString?: boolean; withCandidates?: boolean; candKeys?: string[] }
function taskText(p: Program): string { return `The Python function \`${p.name}\` has a single-line bug. \`tests\` give the input and the expected output.`; }
function buildState(p: Program, o: StateOpts): Json {
  const tests = p.tests.map((t) => (o.actual ? { input: t.input, expected: t.expected, actual_output_of_buggy_program: t.actual } : { input: t.input, expected: t.expected }));
  if (o.asString) {
    const parts = [`Task: ${taskText(p).replace(/`/g, '')}`];
    if (o.docstring) parts.push(`Description:\n${p.docstring}`);
    parts.push(`Program (line number: code):\n${p.lines.map((l) => `${l.lineNo}: ${l.text}`).join('\n')}`);
    parts.push(`Tests:\n${tests.map((t) => `- input: ${JSON.stringify(t.input)}; expected: ${JSON.stringify(t.expected)}${o.actual ? `; actual output of buggy program: ${(t as { actual_output_of_buggy_program?: string }).actual_output_of_buggy_program}` : ''}`).join('\n')}`);
    if (o.withCandidates) {
      parts.push(`Buggy line: ${p.buggyLine}`);
      parts.push(`Candidate replacements:\n${p.cands.map((c, i) => `${o.candKeys![i]}: ${c}`).join('\n')}`);
    }
    return parts.join('\n\n');
  }
  const st: Record<string, Json> = { task: taskText(p) };
  if (o.docstring) st['description'] = p.docstring;
  st['program'] = Object.fromEntries(p.lines.map((l) => [`L${l.lineNo}`, l.text]));
  st['tests'] = tests as Json;
  if (o.withCandidates) {
    st['buggy_line'] = p.buggyLine;
    st['candidates'] = Object.fromEntries(p.cands.map((c, i) => [o.candKeys![i]!, c]));
  }
  return st;
}
const opaque = (i: number): string => `${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'blank'; }
function uniqueKeys(keys: string[]): string[] { const seen = new Map<string, number>(); return keys.map((k) => { const n = (seen.get(k) ?? 0) + 1; seen.set(k, n); return n === 1 ? k : `${k}_${n}`; }); }
const rawKeys = (texts: string[]): string[] => uniqueKeys(texts.map((t) => t.trim()));
const semanticCandKeys = (p: Program): string[] => uniqueKeys(p.cands.map((c) => `replace_with_${slug(c)}`));
/** Raw Choice bypassing the builder's key checks (raw-text keys); escape appended like the builder does. */
function rawChoice(instructions: Json, criteria: Record<string, Json | null>): Question { return { type: 'choice', instructions, criteria: { ...criteria, none_of_these: null } }; }

const LOC_Q = 'Which line of `program` contains the bug that makes `tests` fail? Pick the single line that must change.';
const LOC_Q_STR = 'Which numbered line of the program contains the bug that makes the tests fail? Pick the single line that must change.';
const SEL_Q = '`buggy_line` is the faulty line. Which entry of `candidates` is the correct replacement that makes all `tests` pass?';
const SEL_Q_STR = 'The buggy line is given. Which of the candidate replacements is the correct one that makes all the tests pass?';
const LITERAL = ' Answer carefully and literally.';
const LOC_NOUL_CRIT = {
  true: { definition: 'This exact line is the one that must be changed to make every test pass: it holds the wrong operator, wrong variable, wrong index, wrong argument order, wrong condition or wrong return value.', examples: ['`if total > limit:` where the expected outputs require `>=`', '`return combine(second, first)` where the arguments are swapped', '`return []` where the tests expect a non-empty list'] },
  false: { definition: 'This line is correct as written; changing it is not needed to make the tests pass, even if a nearby line is wrong.', examples: ['a correct `def` line in a function whose bug is in its loop condition', 'a correct initialisation such as `total = 0`', 'a correct `return result` at the end of a function whose loop body is wrong'] },
};
const SEL_NOUL_CRIT = {
  true: { definition: 'Replacing `buggy_line` with this candidate makes every test produce its expected output, with no other change.', examples: ['`while lo < hi:` replacing `while lo <= hi:` when the tests show an index error at the boundary', '`return f(b, a)` replacing `return f(a, b)` when the expected outputs match the swapped argument order'] },
  false: { definition: 'This candidate leaves at least one test failing: it is the unchanged buggy line, a different wrong operator, an unrelated variable, or a change that breaks other cases.', examples: ['the buggy line itself, unchanged', 'a replacement that fixes one test but returns the wrong type for another', 'a variable renamed to one that is not in scope'] },
};
const LOC_SCORE_LEVELS = ['Certainly not the buggy line: it is correct and unrelated to the failing behaviour', 'Probably not the buggy line: it is correct, although near the failure', 'Unclear: the line could be involved in the failure', 'Probably the buggy line: it looks wrong given the expected outputs', 'Certainly the buggy line: changing this one line is what makes the tests pass'];
const SEL_SCORE_LEVELS = ['Certainly wrong: this replacement leaves tests failing or is the unchanged buggy line', 'Probably wrong: it changes the right place but not in the right way', 'Unclear: it might make some tests pass', 'Probably the fix: it matches what the expected outputs require', 'Certainly the fix: with this line every test passes'];

// ------------------------------------------------------------------ variants
interface Built { state: Json; questions: Record<string, Question>; rank: (a: Record<string, Answer>) => { scores: number[]; escape: number | null }; program?: Program }
interface Variant { id: string; family: 'loc' | 'sel'; axis: string; desc: string; build: (p: Program) => Built }
const fromChoice = (q: string, keys: string[]) => (a: Record<string, Answer>) => { const ans = a[q]!; if (ans.type !== 'choice') throw new Error('type'); return { scores: keys.map((k) => ans.probabilities[k] ?? 0), escape: ans.probabilities['none_of_these'] ?? null }; };
const fromNouls = (n: number) => (a: Record<string, Answer>) => ({ scores: Array.from({ length: n }, (_, i) => { const x = a[`q_${i}`]!; return x.type === 'noul' ? x.noul : 0; }), escape: null });
const fromScores = (n: number, levels: number) => (a: Record<string, Answer>) => ({ scores: Array.from({ length: n }, (_, i) => { const x = a[`q_${i}`]!; if (x.type !== 'score') return 0; let e = 0; for (const [k, v] of Object.entries(x.probabilities)) e += Number(k) * v; return e / (levels - 1); }), escape: null });

function locChoice(p: Program, o: { keys: 'semantic' | 'opaque' | 'raw'; descriptions: boolean; state: StateOpts; literal?: boolean }): Built {
  const keys = o.keys === 'semantic' ? p.lines.map((l) => `line_${l.lineNo}`) : o.keys === 'opaque' ? p.lines.map((_, i) => `opt_${opaque(i)}`) : rawKeys(p.lines.map((l) => l.text));
  const crit: Record<string, Json | null> = Object.fromEntries(keys.map((k, i) => [k, o.descriptions ? p.lines[i]!.text : null]));
  let instr = o.state.asString ? LOC_Q_STR : LOC_Q;
  if (!o.descriptions && o.keys === 'semantic') instr += ' Option `line_N` refers to `program.LN`.';
  if (!o.descriptions && o.keys === 'opaque') instr += ' Options are listed in the same order as the lines of `program`.';
  if (o.literal) instr += LITERAL;
  const q = o.keys === 'raw' ? rawChoice(instr, crit) : choice(instr, crit);
  return { state: buildState(p, o.state), questions: { buggy_line: q }, rank: fromChoice('buggy_line', keys) };
}
function locNouls(p: Program, criteria: boolean, literal = false, actual = false): Built {
  const qs: Record<string, Question> = {};
  p.lines.forEach((l, i) => {
    const instr = `Does line \`program.L${l.lineNo}\` (\`${l.text.trim()}\`) contain the bug that makes \`tests\` fail? Exactly one line of \`program\` does.${literal ? LITERAL : ''}`;
    qs[`q_${i}`] = criteria ? noul(instr, LOC_NOUL_CRIT) : { type: 'noul', instructions: instr };
  });
  return { state: buildState(p, { actual }), questions: qs, rank: fromNouls(p.lines.length) };
}
function locScores(p: Program): Built {
  const qs: Record<string, Question> = {};
  p.lines.forEach((l, i) => { qs[`q_${i}`] = score(`How likely is it that line \`program.L${l.lineNo}\` (\`${l.text.trim()}\`) is the line that contains the bug making \`tests\` fail? Exactly one line of \`program\` does.`, LOC_SCORE_LEVELS); });
  return { state: buildState(p, {}), questions: qs, rank: fromScores(p.lines.length, 5) };
}
function dropUnchanged(p: Program): Program { const cands = p.cands.filter((c) => c !== p.buggyLine); return { ...p, cands, truthCand: cands.indexOf(p.fixedLine) }; }
function selChoice(p: Program, o: { keys: 'semantic' | 'opaque' | 'raw'; descriptions: boolean; state: StateOpts; literal?: boolean; stateCands?: boolean }): Built {
  const keys = o.keys === 'semantic' ? semanticCandKeys(p) : o.keys === 'opaque' ? p.cands.map((_, i) => `candidate_${opaque(i)}`) : rawKeys(p.cands);
  const crit: Record<string, Json | null> = Object.fromEntries(keys.map((k, i) => [k, o.descriptions ? p.cands[i]! : null]));
  let instr = o.state.asString ? SEL_Q_STR : SEL_Q;
  if (o.stateCands === false) instr = '`buggy_line` is the faulty line. Which option is the correct replacement line that makes all `tests` pass?';
  if (o.literal) instr += LITERAL;
  const q = o.keys === 'raw' ? rawChoice(instr, crit) : choice(instr, crit);
  const st = buildState(p, { ...o.state, withCandidates: o.stateCands !== false, candKeys: keys });
  if (o.stateCands === false && typeof st === 'object' && st !== null && !Array.isArray(st)) (st as Record<string, Json>)['buggy_line'] = p.buggyLine;
  return { state: st, questions: { fix: q }, rank: fromChoice('fix', keys), program: p };
}
function selNouls(p: Program, criteria: boolean): Built {
  const keys = p.cands.map((_, i) => `candidate_${opaque(i)}`);
  const qs: Record<string, Question> = {};
  p.cands.forEach((c, i) => {
    const instr = `Is \`candidates.${keys[i]}\` (\`${c.trim()}\`) the correct replacement for \`buggy_line\` that makes all \`tests\` pass?`;
    qs[`q_${i}`] = criteria ? noul(instr, SEL_NOUL_CRIT) : { type: 'noul', instructions: instr };
  });
  return { state: buildState(p, { withCandidates: true, candKeys: keys }), questions: qs, rank: fromNouls(p.cands.length) };
}
function selScores(p: Program): Built {
  const keys = p.cands.map((_, i) => `candidate_${opaque(i)}`);
  const qs: Record<string, Question> = {};
  p.cands.forEach((c, i) => { qs[`q_${i}`] = score(`How likely is it that \`candidates.${keys[i]}\` (\`${c.trim()}\`) is the correct replacement for \`buggy_line\` that makes all \`tests\` pass?`, SEL_SCORE_LEVELS); });
  return { state: buildState(p, { withCandidates: true, candKeys: keys }), questions: qs, rank: fromScores(p.cands.length, 5) };
}

const VARIANTS: Variant[] = [
  { id: 'L0_base', family: 'loc', axis: 'base', desc: 'Choice, keys line_N, description = line text, JSON state {task, program{LN}, tests[{input, expected}]}', build: (p) => locChoice(p, { keys: 'semantic', descriptions: true, state: {} }) },
  { id: 'La_nodesc', family: 'loc', axis: 'a criteria', desc: 'as base but option descriptions null (line only in state)', build: (p) => locChoice(p, { keys: 'semantic', descriptions: false, state: {} }) },
  { id: 'Lb_opaque', family: 'loc', axis: 'b keys', desc: 'as base but keys opt_aa.. (descriptions = line text)', build: (p) => locChoice(p, { keys: 'opaque', descriptions: true, state: {} }) },
  { id: 'Lb_opaque_nodesc', family: 'loc', axis: 'b keys', desc: 'keys opt_aa.., descriptions null (order only)', build: (p) => locChoice(p, { keys: 'opaque', descriptions: false, state: {} }) },
  { id: 'Lb_rawkey', family: 'loc', axis: 'b keys', desc: 'as base but the raw line text is the option key, descriptions null', build: (p) => locChoice(p, { keys: 'raw', descriptions: false, state: {} }) },
  { id: 'Lc_string', family: 'loc', axis: 'c state', desc: 'as base but state is one string with numbered lines', build: (p) => locChoice(p, { keys: 'semantic', descriptions: true, state: { asString: true } }) },
  { id: 'Ld_actual', family: 'loc', axis: 'd actual', desc: 'as base plus actual output of the buggy program per test', build: (p) => locChoice(p, { keys: 'semantic', descriptions: true, state: { actual: true } }) },
  { id: 'Le_literal', family: 'loc', axis: 'e literal', desc: 'as base plus "Answer carefully and literally."', build: (p) => locChoice(p, { keys: 'semantic', descriptions: true, state: {}, literal: true }) },
  { id: 'Lf_docstring', family: 'loc', axis: 'f docstring', desc: 'as base plus the QuixBugs docstring as `description`', build: (p) => locChoice(p, { keys: 'semantic', descriptions: true, state: { docstring: true } }) },
  { id: 'Lg_noul_crit', family: 'loc', axis: 'g noul', desc: 'one Noul per line with definition+examples criteria, ranked by P(yes)', build: (p) => locNouls(p, true) },
  { id: 'Lg_noul_nocrit', family: 'loc', axis: 'g noul / a criteria', desc: 'one Noul per line, no criteria', build: (p) => locNouls(p, false) },
  { id: 'Lh_score5', family: 'loc', axis: 'h score', desc: 'one 5-level Score per line, ranked by expected level', build: (p) => locScores(p) },
  { id: 'L_combo', family: 'loc', axis: 'combo', desc: 'opaque keys + descriptions + actual output + literal', build: (p) => locChoice(p, { keys: 'opaque', descriptions: true, state: { actual: true }, literal: true }) },
  { id: 'Lg_noul_crit_actual', family: 'loc', axis: 'g noul + d actual', desc: 'Noul per line with criteria plus actual output', build: (p) => locNouls(p, true, false, true) },
  { id: 'S0_base', family: 'sel', axis: 'base', desc: 'Choice, keys candidate_aa.., descriptions null, candidates in state (anchor-probe shape)', build: (p) => selChoice(p, { keys: 'opaque', descriptions: false, state: {} }) },
  { id: 'Sa_desc', family: 'sel', axis: 'a criteria', desc: 'as base but description = candidate text', build: (p) => selChoice(p, { keys: 'opaque', descriptions: true, state: {} }) },
  { id: 'Sa_desc_only', family: 'sel', axis: 'a criteria', desc: 'description = candidate text, candidates NOT in state', build: (p) => selChoice(p, { keys: 'opaque', descriptions: true, state: {}, stateCands: false }) },
  { id: 'Sb_semantic', family: 'sel', axis: 'b keys', desc: 'keys replace_with_<slug of candidate>, descriptions null', build: (p) => selChoice(p, { keys: 'semantic', descriptions: false, state: {} }) },
  { id: 'Sb_rawkey', family: 'sel', axis: 'b keys', desc: 'raw candidate text as key, descriptions null', build: (p) => selChoice(p, { keys: 'raw', descriptions: false, state: {} }) },
  { id: 'Sc_string', family: 'sel', axis: 'c state', desc: 'as base but state is one string', build: (p) => selChoice(p, { keys: 'opaque', descriptions: false, state: { asString: true } }) },
  { id: 'Sd_actual', family: 'sel', axis: 'd actual', desc: 'as base plus actual output per test', build: (p) => selChoice(p, { keys: 'opaque', descriptions: false, state: { actual: true } }) },
  { id: 'Se_literal', family: 'sel', axis: 'e literal', desc: 'as base plus "Answer carefully and literally."', build: (p) => selChoice(p, { keys: 'opaque', descriptions: false, state: {}, literal: true }) },
  { id: 'Sf_docstring', family: 'sel', axis: 'f docstring', desc: 'as base plus docstring', build: (p) => selChoice(p, { keys: 'opaque', descriptions: false, state: { docstring: true } }) },
  { id: 'S_combo', family: 'sel', axis: 'combo', desc: 'descriptions only (no candidates in state) + literal', build: (p) => selChoice(p, { keys: 'opaque', descriptions: true, state: {}, stateCands: false, literal: true }) },
  { id: 'S_no_unchanged', family: 'sel', axis: 'candidate set', desc: 'as base but the unchanged buggy line is not a candidate (escape only)', build: (p) => selChoice(dropUnchanged(p), { keys: 'opaque', descriptions: false, state: {} }) },
  { id: 'S_combo_no_unchanged', family: 'sel', axis: 'combo', desc: 'descriptions only + literal, unchanged line not a candidate', build: (p) => selChoice(dropUnchanged(p), { keys: 'opaque', descriptions: true, state: {}, stateCands: false, literal: true }) },
  { id: 'Sg_noul_crit', family: 'sel', axis: 'g noul', desc: 'one Noul per candidate with criteria', build: (p) => selNouls(p, true) },
  { id: 'Sg_noul_nocrit', family: 'sel', axis: 'g noul / a criteria', desc: 'one Noul per candidate, no criteria', build: (p) => selNouls(p, false) },
  { id: 'Sh_score5', family: 'sel', axis: 'h score', desc: 'one 5-level Score per candidate', build: (p) => selScores(p) },
];

// ------------------------------------------------------------------ runner
interface Row { variant: string; family: string; program: string; rep: number; nOptions: number; rank: number; pTruth: number; pTop: number; topIsTruth: boolean; topText: string; topPasses: boolean | null; nHigh: number; pSecond: number; escape: number | null; costUsd: number; latencyMs: number; inputTokens: number; error?: string }
const programs = PROGRAMS.map(loadProgram);
let spent = 0;
const rows: Row[] = [];
const outJsonl = join(HERE, `results-${RUN}.jsonl`);
if (!filter && existsSync(outJsonl)) writeFileSync(outJsonl, '');
writeFileSync(join(HERE, 'candidates.json'), JSON.stringify(Object.fromEntries(programs.map((p) => [p.name, { buggyLine: p.buggyLine, fixedLine: p.fixedLine, cands: p.cands }])), null, 1));
if (DUMP) process.exit(0);
const passOracleRaw = existsSync(join(HERE, 'candidate-pass.json')) ? (JSON.parse(readFileSync(join(HERE, 'candidate-pass.json'), 'utf8')) as Record<string, boolean[]>) : null;
/** program -> candidate text -> passes all (gold-fast) tests; text-keyed so variants may reorder or drop candidates */
const passOracle: Record<string, Record<string, boolean>> | null = passOracleRaw ? Object.fromEntries(programs.map((p) => [p.name, Object.fromEntries(p.cands.map((c, i) => [c, passOracleRaw[p.name]?.[i] ?? false]))])) : null;

async function runOne(v: Variant, p0: Program, rep: number): Promise<void> {
  const b = v.build(p0);
  const p = b.program ?? p0;
  const truth = v.family === 'loc' ? p.truthIdx : p.truthCand;
  const n = v.family === 'loc' ? p.lines.length : p.cands.length;
  let row: Row;
  try {
    if (spent > SPEND_CAP) throw new Error('spend cap reached');
    const r = await jev.ask(b.state, b.questions, { signal, stage: 'context', step: 1 });
    spent += r.usage.costUsd;
    const { scores, escape } = b.rank(r.answers);
    const order = scores.map((s, i) => [s, i] as const).sort((x, y) => y[0] - x[0]);
    const rank = order.findIndex(([, i]) => i === truth) + 1;
    const topIdx = order[0]![1];
    const topText = v.family === 'loc' ? p.lines[topIdx]!.text : p.cands[topIdx]!;
    const topPasses = v.family === 'sel' && passOracle ? (passOracle[p.name]?.[topText] ?? null) : null;
    row = { variant: v.id, family: v.family, program: p.name, rep, nOptions: n, rank, pTruth: scores[truth]!, pTop: order[0]![0], topIsTruth: topIdx === truth, topText, topPasses, nHigh: scores.filter((x) => x >= 0.5).length, pSecond: order[1]?.[0] ?? 0, escape, costUsd: r.usage.costUsd, latencyMs: r.latencyMs, inputTokens: r.usage.inputTokens };
  } catch (e) {
    row = { variant: v.id, family: v.family, program: p.name, rep, nOptions: n, rank: 0, pTruth: 0, pTop: 0, topIsTruth: false, topText: '', topPasses: null, nHigh: 0, pSecond: 0, escape: null, costUsd: 0, latencyMs: 0, inputTokens: 0, error: (e as Error).message.slice(0, 200) };
  }
  rows.push(row);
  appendFileSync(outJsonl, JSON.stringify(row) + '\n');
}
async function pool<T>(items: T[], f: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (i < items.length) { const it = items[i++]!; await f(it); } }));
}
const jobs: { v: Variant; p: Program; rep: number }[] = [];
for (const v of VARIANTS) if (!filter || filter.test(v.id)) for (const p of programs) jobs.push({ v, p, rep: 0 });
// repeat stability: base localisation, 5 programs x 5 repeats (rep 1..5; rep 0 above is the first sample)
if (!filter || filter.test('L0_base')) for (const p of programs.slice(0, 5)) for (let rep = 1; rep <= 4; rep++) jobs.push({ v: VARIANTS[0]!, p, rep });
console.error(`programs=${programs.length} jobs=${jobs.length}`);
for (const p of programs) console.error(`  ${p.name.padEnd(28)} lines=${p.lines.length} truth=L${p.lines[p.truthIdx]!.lineNo} cands=${p.cands.length} truthCand=${p.truthCand}`);
await pool(jobs, ({ v, p, rep }) => runOne(v, p, rep));

// ------------------------------------------------------------------ summary
const med = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f2 = (x: number): string => x.toFixed(2);
const summary: Record<string, Json> = {};
const lines: string[] = [];
lines.push('| Variant | Axis | n | Top-1 | Top-1 passes tests | Top-3 | MRR | mean P(truth) | min P(truth) | mean P(top) | mean P(2nd) | mean #opts>=0.5 | P(escape) mean | tokens/req | latency p50 ms | cost $ |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const v of VARIANTS) {
  const rs = rows.filter((r) => r.variant === v.id && r.rep === 0);
  if (!rs.length) continue;
  const ok = rs.filter((r) => !r.error);
  const errs = rs.length - ok.length;
  if (!ok.length) { lines.push(`| ${v.id} | ${v.axis} | ${rs.length} | rejected: ${rs[0]!.error} | | | | | | | | | | | | |`); summary[v.id] = { error: rs[0]!.error ?? null }; continue; }
  const s = { n: ok.length, errors: errs, top1: ok.filter((r) => r.rank === 1).length, top3: ok.filter((r) => r.rank >= 1 && r.rank <= 3).length, topPass: v.family === 'sel' && passOracle ? ok.filter((r) => r.topPasses).length : null, mrr: mean(ok.map((r) => (r.rank ? 1 / r.rank : 0))), pTruth: mean(ok.map((r) => r.pTruth)), pTruthMin: Math.min(...ok.map((r) => r.pTruth)), pTop: mean(ok.map((r) => r.pTop)), pSecond: mean(ok.map((r) => r.pSecond)), nHigh: mean(ok.map((r) => r.nHigh)), escape: ok.some((r) => r.escape !== null) ? mean(ok.map((r) => r.escape ?? 0)) : null, tokens: Math.round(mean(ok.map((r) => r.inputTokens))), latP50: Math.round(med(ok.map((r) => r.latencyMs))), cost: ok.reduce((a, r) => a + r.costUsd, 0) };
  summary[v.id] = s;
  lines.push(`| ${v.id} | ${v.axis} | ${s.n}${errs ? ` (+${errs} err)` : ''} | ${s.top1}/${s.n} | ${s.topPass === null ? 'n/a' : `${s.topPass}/${s.n}`} | ${s.top3}/${s.n} | ${f2(s.mrr)} | ${f2(s.pTruth)} | ${f2(s.pTruthMin)} | ${f2(s.pTop)} | ${f2(s.pSecond)} | ${s.nHigh.toFixed(1)} | ${s.escape === null ? 'n/a' : f2(s.escape)} | ${s.tokens} | ${s.latP50} | ${s.cost.toFixed(4)} |`);
}
// per-program matrix: rank(pTruth)
for (const fam of ['loc', 'sel'] as const) {
  const vs = VARIANTS.filter((v) => v.family === fam && rows.some((r) => r.variant === v.id));
  if (!vs.length) continue;
  lines.push('', `Per-program, ${fam === 'loc' ? 'localisation' : 'selection'}: cell = rank of the true ${fam === 'loc' ? 'line' : 'candidate'} (P(truth)); "-" = request rejected`, '');
  lines.push(`| program | ${fam === 'loc' ? 'lines' : 'cands'} | ${vs.map((v) => v.id).join(' | ')} |`);
  lines.push(`| --- | --- | ${vs.map(() => '---').join(' | ')} |`);
  for (const p of programs) {
    const cells = vs.map((v) => { const r = rows.find((x) => x.variant === v.id && x.program === p.name && x.rep === 0); return !r || r.error ? '-' : `${r.rank}${r.topPasses && r.rank !== 1 ? '*' : ''} (${f2(r.pTruth)})`; });
    lines.push(`| ${p.name} | ${fam === 'loc' ? p.lines.length : p.cands.length} | ${cells.join(' | ')} |`);
  }
}
// wrong top picks
lines.push('', 'Wrong top-1 picks (rank != 1): variant, program, P(truth), top pick text, P(top), passes tests', '');
for (const r of rows.filter((x) => x.rep === 0 && !x.error && x.rank !== 1)) lines.push(`- ${r.variant} / ${r.program}: P(truth)=${f2(r.pTruth)}, top=\`${r.topText.trim()}\` P=${f2(r.pTop)}${r.topPasses === null ? '' : r.topPasses ? ' PASSES' : ' fails'}`);
// repeat stability
const reps = rows.filter((r) => r.variant === 'L0_base' && programs.slice(0, 5).some((p) => p.name === r.program) && !r.error);
if (reps.some((r) => r.rep > 0)) {
  lines.push('', 'Repeat stability, L0_base, 5 repeats per program', '', '| program | P(truth) samples | max spread P(truth) | max spread P(top) | argmax flips |', '| --- | --- | --- | --- | --- |');
  const spreads: number[] = [];
  for (const p of programs.slice(0, 5)) {
    const rs = reps.filter((r) => r.program === p.name);
    const pt = rs.map((r) => r.pTruth), tp = rs.map((r) => r.pTop);
    const spread = Math.max(...pt) - Math.min(...pt); spreads.push(spread);
    const flips = new Set(rs.map((r) => r.topIsTruth)).size - 1;
    lines.push(`| ${p.name} | ${pt.map(f2).join(', ')} | ${f2(spread)} | ${f2(Math.max(...tp) - Math.min(...tp))} | ${flips} |`);
  }
  summary['repeat_max_spread'] = Math.max(...spreads);
}
const total = { requests: rows.length, errors: rows.filter((r) => r.error).length, costUsd: rows.reduce((a, r) => a + r.costUsd, 0), latP50: Math.round(med(rows.filter((r) => !r.error).map((r) => r.latencyMs))), inputTokens: rows.reduce((a, r) => a + r.inputTokens, 0) };
summary['total'] = total;
lines.push('', `Total: ${total.requests} requests (${total.errors} rejected), ${total.inputTokens} input tokens, $${total.costUsd.toFixed(4)}, latency p50 ${total.latP50} ms`);
console.log(lines.join('\n'));
writeFileSync(join(HERE, `summary-${RUN}.json`), JSON.stringify(summary, null, 1));
writeFileSync(join(HERE, `summary-${RUN}.md`), lines.join('\n'));
