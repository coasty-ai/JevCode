/**
 * Repo-scale extension of the understanding probe: from the problem statement alone,
 *   Q5: Choice over every source directory of the repository (tests/docs/migrations excluded) -> is the gold package top-1/top-5?
 *   Q6: Nouls "must this file change" over every source .py file of the repository (paths only, batched <=250 per request)
 *       -> rank of the gold file among all files, precision/recall at 0.5 and 0.7.
 *   env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/probe-swebench-understand/run-repo.mts
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { createJevDecider } from '../../src/jev/client.ts';
import { choice, contextNoul } from '../../src/jev/questions.ts';
import type { Json, Question } from '../../src/core/types.ts';

const DIR = '/Users/prateekjannu/Documents/vscode/JevCode/experiments/probe-swebench-understand';
const REPOS = '/tmp/jevonly/repos';
const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;
const EXCL = new Set(['tests', 'test', 'testing', 'migrations', 'locale', 'doc', 'docs', 'examples', 'benchmarks', 'bin', 'release', 'conf', 'scripts', 'extras', 'changelog', 'build', 'dist', 'bench', 'extra']);

interface Inst { instance_id: string; repo: string; problem_statement: string; gold_files: { path: string; package_dir: string }[] }
const prepared = JSON.parse(readFileSync(`${DIR}/prepared.json`, 'utf8')) as Inst[];

function sourceTree(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      if (e.startsWith('.') || EXCL.has(e)) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.py')) { const rel = relative(root, dir); if (rel === '') continue; const arr = out.get(rel) ?? []; arr.push(e); out.set(rel, arr); }
    }
  };
  walk(root);
  return out;
}

interface Row { q: string; instance_id: string; state_chars: number; input_tokens: number; cost_usd: number; latency_ms: number; n_options: number; truth: Json; metrics: Record<string, Json>; answers?: Json }
const rows: Row[] = []; let spent = 0; const lat: number[] = [];
const ranked = (p: Record<string, number>): [string, number][] => Object.entries(p).sort((a, b) => b[1] - a[1]);
const rankOf = (p: Record<string, number>, truths: Set<string>): number => { const i = ranked(p).findIndex(([k]) => truths.has(k)); return i < 0 ? 0 : i + 1; };
const dirKey = (d: string, used: Set<string>): string => { let k = d.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); if (!/^[a-z]/.test(k) || k.length < 2) k = `dir_${k}`; k = k.slice(0, 60); const b = k; let i = 2; while (used.has(k)) k = `${b}_${i++}`; used.add(k); return k; };

async function q5(inst: Inst, tree: Map<string, string[]>): Promise<void> {
  const used = new Set<string>(['none_of_these']); const keyOf = new Map<string, string>(); const dirs: Record<string, Json> = {};
  for (const [d, files] of [...tree.entries()].sort()) { const k = dirKey(d, used); keyOf.set(d, k); dirs[k] = { path: d, python_files: files.length > 15 ? [...files.slice(0, 15), `... ${files.length - 15} more`] : files }; }
  if (Object.keys(dirs).length > 254) throw new Error('too many dirs');
  const state: Json = { issue: { repository: inst.repo, problem_statement: inst.problem_statement }, directories: dirs };
  const qs = { where: choice('`directories` lists every source directory of the repository with its Python files. In which directory does the code that must be changed to fix `issue` live? Pick the single most likely directory.', Object.fromEntries(Object.keys(dirs).map((k) => [k, null]))) };
  const truth = new Set(inst.gold_files.map((g) => keyOf.get(g.package_dir)).filter((x): x is string => !!x));
  const t0 = Date.now(); const r = await jev.ask(state, qs, { signal, stage: 'context', step: 1 }); spent += r.usage.costUsd; lat.push(r.latencyMs);
  const a = r.answers['where']!; if (a.type !== 'choice') return;
  const rk = rankOf(a.probabilities, truth); const top = ranked(a.probabilities);
  const m = { top1: top[0]![0], p_top1: top[0]![1], rank: rk, top1_hit: rk === 1, top5_hit: rk >= 1 && rk <= 5, p_gold: Object.fromEntries([...truth].map((k) => [k, a.probabilities[k] ?? 0])), p_escape: a.probabilities['none_of_these'] ?? 0 };
  rows.push({ q: 'Q5', instance_id: inst.instance_id, state_chars: JSON.stringify(state).length, input_tokens: r.usage.inputTokens, cost_usd: r.usage.costUsd, latency_ms: r.latencyMs, n_options: Object.keys(dirs).length + 1, truth: [...truth], metrics: m });
  console.log(`Q5 ${inst.instance_id.padEnd(26)} dirs=${Object.keys(dirs).length} tok=${r.usage.inputTokens} ${r.latencyMs}ms ${JSON.stringify(m)} (${Date.now() - t0}ms)`);
}

async function q6(inst: Inst, tree: Map<string, string[]>): Promise<void> {
  const files = [...tree.entries()].sort().flatMap(([d, fs]) => fs.sort().map((f) => `${d}/${f}`));
  const gold = new Set(inst.gold_files.map((g) => g.path));
  const probs: Record<string, number> = {}; let tokens = 0, cost = 0, chars = 0, reqs = 0, latMax = 0;
  const criteria = { yes_when: 'the code change that fixes the issue lands in this file: it defines the function, class, table or constant whose behaviour the report describes as wrong or missing', no_when: 'the file merely imports, calls or tests the code that is fixed elsewhere, or is unrelated to the symptoms' };
  for (let i = 0; i < files.length; i += 250) {
    const batch = files.slice(i, i + 250);
    const state: Json = { issue: { repository: inst.repo, problem_statement: inst.problem_statement }, criteria, files: batch };
    const qs: Record<string, Question> = {};
    for (const p of batch) qs[p] = contextNoul(`Must the file \`${p}\` (listed in \`files\`) be modified to fix \`issue\`? Apply \`criteria\`.`);
    const r = await jev.ask(state, qs, { signal, stage: 'context', step: 1 }); spent += r.usage.costUsd; lat.push(r.latencyMs);
    tokens += r.usage.inputTokens; cost += r.usage.costUsd; chars += JSON.stringify(state).length; reqs++; latMax = Math.max(latMax, r.latencyMs);
    for (const [k, v] of Object.entries(r.answers)) if (v.type === 'noul') probs[k] = v.noul;
  }
  const pr = (t: number): Json => { const sel = Object.entries(probs).filter(([, v]) => v >= t).map(([k]) => k); const tp = sel.filter((k) => gold.has(k)).length; return { selected: sel.length, tp, precision: sel.length ? tp / sel.length : null, recall: gold.size ? tp / gold.size : null }; };
  const top = ranked(probs);
  const m = { n_files: files.length, requests: reqs, rank_first_gold: rankOf(probs, gold), ranks_gold: Object.fromEntries([...gold].map((g) => [g, rankOf(probs, new Set([g]))])), p_gold: Object.fromEntries([...gold].map((g) => [g, probs[g] ?? null])), top3: top.slice(0, 3), at_0_5: pr(0.5), at_0_7: pr(0.7), at_0_9: pr(0.9), max_nongold: Math.max(0, ...top.filter(([k]) => !gold.has(k)).map(([, v]) => v)), latency_max_ms: latMax };
  rows.push({ q: 'Q6', instance_id: inst.instance_id, state_chars: chars, input_tokens: tokens, cost_usd: cost, latency_ms: latMax, n_options: files.length, truth: [...gold], metrics: m, answers: probs });
  console.log(`Q6 ${inst.instance_id.padEnd(26)} files=${files.length} reqs=${reqs} tok=${tokens} ${JSON.stringify({ rank: m.rank_first_gold, p_gold: m.p_gold, at_0_5: m.at_0_5, at_0_7: m.at_0_7, top3: m.top3 })}`);
}

const trees = new Map<string, Map<string, string[]>>();
const CONC = 5; let next = 0; const errors: string[] = [];
const jobs = prepared.flatMap((inst) => [async () => { const t = trees.get(inst.instance_id) ?? sourceTree(join(REPOS, inst.instance_id)); trees.set(inst.instance_id, t); await q5(inst, t); }, async () => { const t = trees.get(inst.instance_id) ?? sourceTree(join(REPOS, inst.instance_id)); trees.set(inst.instance_id, t); await q6(inst, t); }]);
await Promise.all(Array.from({ length: CONC }, async () => { while (next < jobs.length) { const j = jobs[next++]!; try { if (spent > 1) throw new Error('spend cap'); await j(); } catch (e) { errors.push(String(e)); console.error('ERR', String(e).slice(0, 300)); } } }));
lat.sort((a, b) => a - b);
const out = { run_at: new Date().toISOString(), model: 'typesafe/jev-1.13-20260917', requests: lat.length, cost_usd: spent, latency_p50_ms: lat[Math.floor(lat.length / 2)], latency_p90_ms: lat[Math.floor(lat.length * 0.9)], max_input_tokens: Math.max(0, ...rows.filter((r) => r.q === 'Q5').map((r) => r.input_tokens)), errors, rows };
writeFileSync(`${DIR}/results-repo.json`, JSON.stringify(out, null, 1));
console.log(`\nrequests=${lat.length} cost=$${spent.toFixed(4)} p50=${out.latency_p50_ms}ms p90=${out.latency_p90_ms}ms errors=${errors.length}`);
