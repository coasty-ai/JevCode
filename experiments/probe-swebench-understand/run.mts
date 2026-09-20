/**
 * Live probe: repository-scale understanding with Jev only, on the 30 SWE-bench Verified instances.
 * Input: prepared.json (from prepare.py). Output: results.json (every request: state size, tokens, cost,
 * latency, ranked answers) for report.py.
 *   env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/probe-swebench-understand/run.mts [--only Q1,Q2] [--limit n]
 * Q1 change kind (Choice + paired Nouls), Q2 function localisation (Choice), Q3 file Nouls, Q4 line localisation (Choice).
 * Variants: Q1/Q2 with and without hints_text; Q3 with and without symbol outlines; Q4 test names only vs + test code.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createJevDecider } from '../../src/jev/client.ts';
import { choice, noul } from '../../src/jev/questions.ts';
import type { Json, Question } from '../../src/core/types.ts';

const DIR = '/Users/prateekjannu/Documents/vscode/JevCode/experiments/probe-swebench-understand';
const args = process.argv.slice(2);
const only = new Set((args.includes('--only') ? args[args.indexOf('--only') + 1]! : 'Q1,Q2,Q3,Q4').split(','));
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 30;
const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;
const SPEND_CAP = 1.0;

interface Fn { qualname: string; lineno: number; end_lineno: number; first_line: string; kind: string }
interface Touched { qualname: string; changed_lines: number[]; anchors: number[] }
interface GoldFile { path: string; n_lines: number; n_functions: number; functions: Fn[]; touched: Touched[]; adjacent_functions: string[]; package_dir: string; package_files: { path: string; outline: string[]; is_gold: boolean }[]; source_lines: string[] }
interface Inst { instance_id: string; repo: string; difficulty: string; problem_statement: string; hints_text: string; fail_to_pass: string[]; test_source: string[]; gold_files: GoldFile[] }
const prepared = (JSON.parse(readFileSync(`${DIR}/prepared.json`, 'utf8')) as Inst[]).slice(0, limit);

interface Row { q: string; variant: string; instance_id: string; file?: string; fn?: string; state_chars: number; input_tokens: number; cost_usd: number; latency_ms: number; n_options?: number; answers: Json; truth: Json; metrics: Record<string, Json> }
const rows: Row[] = [];
let spent = 0; const lat: number[] = [];

async function ask(state: Json, qs: Record<string, Question>, meta: Omit<Row, 'state_chars' | 'input_tokens' | 'cost_usd' | 'latency_ms' | 'answers' | 'metrics'> & { metrics?: Record<string, Json> }, score: (answers: Record<string, Json>) => Record<string, Json>): Promise<void> {
  if (spent > SPEND_CAP) throw new Error(`spend cap ${SPEND_CAP} reached`);
  const r = await jev.ask(state, qs, { signal, stage: 'context', step: 1 });
  spent += r.usage.costUsd; lat.push(r.latencyMs);
  const answers = r.answers as unknown as Record<string, Json>;
  const metrics = score(answers);
  rows.push({ ...meta, state_chars: JSON.stringify(state).length, input_tokens: r.usage.inputTokens, cost_usd: r.usage.costUsd, latency_ms: r.latencyMs, answers, metrics });
  console.log(`${meta.q} ${meta.variant.padEnd(10)} ${meta.instance_id.padEnd(26)} ${(meta.file ?? '').padEnd(42)} tok=${String(r.usage.inputTokens).padStart(6)} ${r.latencyMs}ms ${JSON.stringify(metrics)}`);
}

const ranked = (probs: Record<string, number>): [string, number][] => Object.entries(probs).sort((a, b) => b[1] - a[1]);
const rankOf = (probs: Record<string, number>, truths: Set<string>): number => { const r = ranked(probs); const i = r.findIndex(([k]) => truths.has(k)); return i < 0 ? 0 : i + 1; };

function issueState(inst: Inst, hints: boolean): Json {
  const s: Record<string, Json> = { repository: inst.repo, problem_statement: inst.problem_statement };
  if (hints && inst.hints_text.trim()) s['discussion_hints'] = inst.hints_text.slice(0, 6000);
  return s;
}

// ---------------------------------------------------------------- Q1: kind of change
const KINDS: Record<string, string> = {
  fix_wrong_value: 'An existing expression, constant, operator, attribute name or return value is wrong and is replaced by the right one; no new control flow. Example: `range(n)` -> `range(n + 1)`, `x.name` -> `x.qualname`.',
  add_guard_or_check: 'A new condition makes some inputs be handled early or skipped: an `if ...: return`, an extra `and`/`or` clause, a filter in a comprehension. Example: `if value is None: return default`.',
  add_branch_or_case: 'A new alternative path is added for a case that was not handled before: a new `if/elif/else` body, a new `except` handler, a new entry in a dispatch table or mapping. Example: `elif isinstance(x, bytes): x = x.decode()`.',
  change_call_or_arguments: 'A call keeps its place but its target or its arguments change: a different function is called, an argument is wrapped, converted, added or removed. Example: `open(path)` -> `open(path, encoding="utf-8")`.',
  add_new_function_or_method: 'A new function or method is written and used by existing code. Example: adding `def normalize(items):` and calling it.',
  change_signature: 'A parameter is added, removed, renamed or given a default on an existing function; callers may be updated. Example: `def render(text)` -> `def render(text, escape=True)`.',
  change_message_or_formatting: 'Only text output changes: an error message, a repr, printed formatting or whitespace. Example: "Invalid input" -> "Invalid input: expected int".',
  config_or_metadata: 'Only configuration, option definitions, constants or metadata change: a settings table, CLI option declarations, version constants, packaging files.',
  refactor_without_behaviour_change: 'Code is moved or restructured and every input produces the same result as before.',
  none_of_these: 'The fix is none of the kinds above, for example wrapping code in a context manager or restructuring a loop.',
};
async function q1(inst: Inst, variant: 'ps' | 'ps_hints'): Promise<void> {
  const state: Json = { issue: issueState(inst, variant === 'ps_hints') };
  const qs: Record<string, Question> = {
    kind: choice('Read `issue.problem_statement`. Which single kind of code change is most likely needed in the library source code (not in tests) to fix the issue? Judge the fix that would be written, not the report. Answer carefully and literally.', KINDS),
  };
  for (const [k, d] of Object.entries(KINDS)) if (k !== 'none_of_these') qs[`needs_${k}`] = noul(`Would fixing \`issue\` require this kind of change in the library source: ${k.replace(/_/g, ' ')}? Definition: ${d}`, {
    true: { definition: `the fix would include a change of kind "${k.replace(/_/g, ' ')}" as defined`, examples: ['the report shows a wrong result that this kind of edit corrects', 'the report asks for exactly this kind of edit'] },
    false: { definition: 'the fix would not need this kind of change', examples: ['the report is about something else entirely', 'another kind of edit alone fixes it'] },
  });
  const labels = (JSON.parse(readFileSync(`${DIR}/labels.json`, 'utf8')) as Record<string, { primary: string; also_ok: string[] }>)[inst.instance_id]!;
  await ask(state, qs, { q: 'Q1', variant, instance_id: inst.instance_id, truth: labels as unknown as Json }, (a) => {
    const c = a['kind'] as { probabilities: Record<string, number> };
    const r = ranked(c.probabilities);
    const nouls = Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith('needs_')).map(([k, v]) => [k.slice(6), Number((v as { noul: number }).noul)]));
    const ok = new Set([labels.primary, ...labels.also_ok]);
    return { top1: r[0]![0], p_top1: r[0]![1], p_primary: c.probabilities[labels.primary] ?? 0, strict_hit: r[0]![0] === labels.primary, lenient_hit: ok.has(r[0]![0]), rank_primary: rankOf(c.probabilities, new Set([labels.primary])), noul_primary: nouls[labels.primary] ?? null, nouls_over_0_5: Object.entries(nouls).filter(([, v]) => v > 0.5).map(([k]) => k), nouls };
  });
}

// ---------------------------------------------------------------- Q2: function localisation in the gold file
const MODULE_KEY = 'module_level_code_outside_any_function';
function fnKey(qual: string, used: Set<string>): string {
  let k = qual.toLowerCase().replace(/\./g, '__').replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(k) || k.length < 2 || /^([a-z]|alpha|beta|gamma|option_?[a-z0-9]+|\d+)$/i.test(k)) k = `fn_${k}`;
  k = k.slice(0, 60); let base = k, i = 2; while (used.has(k)) k = `${base}_${i++}`; used.add(k); return k;
}
async function q2(inst: Inst, g: GoldFile, variant: 'ps' | 'ps_hints'): Promise<void> {
  const used = new Set<string>([MODULE_KEY, 'none_of_these']);
  const keyOf = new Map<string, string>();
  const opts: Record<string, Json> = {};
  for (const f of g.functions) { const k = fnKey(f.qualname, used); keyOf.set(f.qualname, k); opts[k] = `${f.kind} ${f.qualname}, line ${f.lineno}: ${f.first_line.slice(0, 160)}`; }
  opts[MODULE_KEY] = 'code at module level: imports, constants, tables, class attributes; not inside any function or method';
  const state: Json = { issue: issueState(inst, variant === 'ps_hints'), file: { path: g.path, functions: opts } };
  const qs = { where: choice(`\`file\` is the source file that must be edited to fix \`issue\`. Which entry of \`file.functions\` must be modified (its body changed, or new code inserted directly into it) to fix the issue? If the fix is code outside every function, pick \`${MODULE_KEY}\`.`, Object.fromEntries(Object.keys(opts).map((k) => [k, null])) as Record<string, Json | null>, ) };
  // no description duplication: descriptions are in the state, options are the keys (as in anchor probe)
  const truthAll = new Set(g.touched.map((t) => (t.qualname === '<module>' ? MODULE_KEY : keyOf.get(t.qualname) ?? MODULE_KEY)));
  for (const a of g.adjacent_functions) truthAll.add(keyOf.get(a)!);
  const primary = g.touched.slice().sort((a, b) => b.changed_lines.length - a.changed_lines.length)[0]!;
  const primaryKey = primary.qualname === '<module>' ? MODULE_KEY : keyOf.get(primary.qualname)!;
  await ask(state, qs, { q: 'Q2', variant, instance_id: inst.instance_id, file: g.path, n_options: Object.keys(opts).length + 1, truth: { touched: [...truthAll], primary: primaryKey } }, (a) => {
    const c = a['where'] as { probabilities: Record<string, number> };
    const r = ranked(c.probabilities); const rk = rankOf(c.probabilities, truthAll);
    return { top1: r[0]![0], p_top1: r[0]![1], rank: rk, top1_hit: rk === 1, top5_hit: rk >= 1 && rk <= 5, rank_primary: rankOf(c.probabilities, new Set([primaryKey])), p_primary: c.probabilities[primaryKey] ?? 0, n_options: Object.keys(c.probabilities).length, p_escape: c.probabilities['none_of_these'] ?? 0 };
  });
}

// ---------------------------------------------------------------- Q3: file Nouls over the package
async function q3(inst: Inst, g: GoldFile, variant: 'outline' | 'paths', goldPaths: Set<string>): Promise<void> {
  const files: Record<string, Json> = {};
  for (const f of g.package_files.slice(0, 100)) files[f.path] = variant === 'outline' ? { top_level_symbols: f.outline } : {};
  const state: Json = { issue: issueState(inst, false), package_directory: g.package_dir, files };
  const qs: Record<string, Question> = {};
  for (const p of Object.keys(files)) qs[p] = noul(`Must the file \`files["${p}"]\` be modified to fix \`issue\`? Answer yes only if the code change that fixes the issue lands in this file.`, {
    true: { definition: 'the fix edits code in this file', examples: ['the file defines the function whose wrong behaviour the report describes', 'the file holds the table or constant the fix must extend'] },
    false: { definition: 'the fix does not touch this file', examples: ['the file merely imports or calls the code that is fixed elsewhere', 'the file is unrelated to the symptoms in the report'] },
  });
  await ask(state, qs, { q: 'Q3', variant, instance_id: inst.instance_id, file: g.package_dir, n_options: Object.keys(files).length, truth: [...goldPaths].filter((p) => p in files) }, (a) => {
    const probs = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Number((v as { noul: number }).noul)]));
    const gold = new Set([...goldPaths].filter((p) => p in files));
    const pr = (t: number): Json => { const sel = Object.entries(probs).filter(([, v]) => v >= t).map(([k]) => k); const tp = sel.filter((k) => gold.has(k)).length; return { selected: sel.length, tp, precision: sel.length ? tp / sel.length : null, recall: gold.size ? tp / gold.size : null }; };
    const r = ranked(probs);
    return { n_files: Object.keys(probs).length, n_gold: gold.size, at_0_5: pr(0.5), at_0_7: pr(0.7), rank_first_gold: rankOf(probs, gold), top1: r[0]![0], p_top1: r[0]![1], p_gold: Object.fromEntries([...gold].map((k) => [k, probs[k] ?? null])), max_nongold: Math.max(0, ...Object.entries(probs).filter(([k]) => !gold.has(k)).map(([, v]) => v)) };
  });
}

// ---------------------------------------------------------------- Q4: line localisation inside the gold function
async function q4(inst: Inst, g: GoldFile, t: Touched, variant: 'names' | 'names_testcode'): Promise<void> {
  const fn = g.functions.find((f) => f.qualname === t.qualname)!;
  const lines: Record<string, string> = {}; const opts: Record<string, Json | null> = {};
  for (let ln = fn.lineno; ln <= fn.end_lineno; ln++) { const text = g.source_lines[ln - 1] ?? ''; if (text.trim() === '') continue; lines[`L${ln}`] = text; opts[`line_${ln}`] = null; }
  if (Object.keys(opts).length > 254) throw new Error(`function too long for one Choice: ${t.qualname}`);
  const state: Record<string, Json> = { issue: issueState(inst, false), failing_tests: inst.fail_to_pass.slice(0, 20), file: g.path, function: { name: fn.qualname, lines } };
  if (variant === 'names_testcode') state['failing_test_code'] = inst.test_source;
  const qs = { where: choice('`function.lines` is the function that must be edited to fix `issue`; `failing_tests` are the tests that must pass afterwards. Which line of `function.lines` does the fix go to: the line that must be changed, or the existing line directly before or after which new code must be inserted? Pick one line.', opts) };
  const targets = new Set([...t.changed_lines, ...t.anchors]);
  await ask(state, qs, { q: 'Q4', variant, instance_id: inst.instance_id, file: g.path, fn: t.qualname, n_options: Object.keys(opts).length + 1, truth: { targets: [...targets].sort((a, b) => a - b), fn_lines: [fn.lineno, fn.end_lineno] } }, (a) => {
    const c = a['where'] as { probabilities: Record<string, number> };
    const r = ranked(c.probabilities).filter(([k]) => k !== 'none_of_these');
    const lineNo = (k: string): number => Number(k.slice(5));
    const within = (k: string, tol: number): boolean => [...targets].some((x) => Math.abs(lineNo(k) - x) <= tol);
    const rankTol = (tol: number): number => { const i = r.findIndex(([k]) => within(k, tol)); return i < 0 ? 0 : i + 1; };
    return { top1: r[0]![0], p_top1: r[0]![1], n_lines: r.length, rank_exact: rankTol(0), rank_tol3: rankTol(3), top1_tol3: rankTol(3) === 1, top5_tol3: rankTol(3) >= 1 && rankTol(3) <= 5, top1_exact: rankTol(0) === 1, p_escape: c.probabilities['none_of_these'] ?? 0 };
  });
}

// ---------------------------------------------------------------- driver
const CONC = 6;
const jobs: (() => Promise<void>)[] = [];
for (const inst of prepared) {
  const goldPaths = new Set(inst.gold_files.map((g) => g.path));
  if (only.has('Q1')) { jobs.push(() => q1(inst, 'ps')); jobs.push(() => q1(inst, 'ps_hints')); }
  const seenPkg = new Set<string>();
  for (const g of inst.gold_files) {
    if (only.has('Q2')) { jobs.push(() => q2(inst, g, 'ps')); jobs.push(() => q2(inst, g, 'ps_hints')); }
    if (only.has('Q3') && !seenPkg.has(g.package_dir)) { seenPkg.add(g.package_dir); jobs.push(() => q3(inst, g, 'outline', goldPaths)); jobs.push(() => q3(inst, g, 'paths', goldPaths)); }
    if (only.has('Q4')) for (const t of g.touched) { if (t.qualname === '<module>') continue; if (!g.functions.some((f) => f.qualname === t.qualname)) continue; jobs.push(() => q4(inst, g, t, 'names')); jobs.push(() => q4(inst, g, t, 'names_testcode')); }
  }
}
console.log(`${jobs.length} requests queued`);
let next = 0; const errors: string[] = [];
await Promise.all(Array.from({ length: CONC }, async () => { while (next < jobs.length) { const j = jobs[next++]!; try { await j(); } catch (e) { errors.push(String(e)); console.error('ERR', String(e).slice(0, 300)); } } }));
lat.sort((a, b) => a - b);
const out = { run_at: new Date().toISOString(), model: 'typesafe/jev-1.13-20260917', requests: rows.length, cost_usd: spent, latency_p50_ms: lat[Math.floor(lat.length / 2)] ?? null, latency_p90_ms: lat[Math.floor(lat.length * 0.9)] ?? null, max_input_tokens: Math.max(0, ...rows.map((r) => r.input_tokens)), errors, rows };
const suffix = args.includes('--only') ? `-${[...only].join('')}` : '';
writeFileSync(`${DIR}/results${suffix}.json`, JSON.stringify(out, null, 1));
console.log(`\nrequests=${rows.length} cost=$${spent.toFixed(4)} p50=${out.latency_p50_ms}ms p90=${out.latency_p90_ms}ms max_input_tokens=${out.max_input_tokens} errors=${errors.length}`);
