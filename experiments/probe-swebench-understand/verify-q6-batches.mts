/**
 * Verification re-run (2026-09-20) of Q6 on a few instances, logging per-batch input tokens so the
 * "largest single request" claim can be measured (run-repo.mts only saved per-instance totals).
 *   env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/probe-swebench-understand/verify-q6-batches.mts sympy__sympy-20428 pytest-dev__pytest-10051
 * Same state, criteria, question text, batching (250 paths) and exclusions as run-repo.mts. Writes results-verify-q6.json.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createJevDecider } from '../../src/jev/client.ts';
import { contextNoul } from '../../src/jev/questions.ts';
import type { Json, Question } from '../../src/core/types.ts';

const DIR = '/Users/prateekjannu/Documents/vscode/JevCode/experiments/probe-swebench-understand';
const REPOS = '/tmp/jevonly/repos';
const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;
const EXCL = new Set(['tests', 'test', 'testing', 'migrations', 'locale', 'doc', 'docs', 'examples', 'benchmarks', 'bin', 'release', 'conf', 'scripts', 'extras', 'changelog', 'build', 'dist', 'bench', 'extra']);
interface Inst { instance_id: string; repo: string; problem_statement: string; gold_files: { path: string }[] }
const want = new Set(process.argv.slice(2));
const prepared = (JSON.parse(readFileSync(`${DIR}/prepared.json`, 'utf8')) as Inst[]).filter((p) => want.has(p.instance_id));
const saved = JSON.parse(readFileSync(`${DIR}/results-repo.json`, 'utf8')) as { rows: { q: string; instance_id: string; metrics: { rank_first_gold: number; p_gold: Record<string, number> } }[] };

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
  walk(root); return out;
}
const ranked = (p: Record<string, number>): [string, number][] => Object.entries(p).sort((a, b) => b[1] - a[1]);
const out: Json[] = []; let spent = 0;
for (const inst of prepared) {
  const tree = sourceTree(join(REPOS, inst.instance_id));
  const files = [...tree.entries()].sort().flatMap(([d, fs]) => fs.sort().map((f) => `${d}/${f}`));
  const gold = new Set(inst.gold_files.map((g) => g.path));
  const criteria = { yes_when: 'the code change that fixes the issue lands in this file: it defines the function, class, table or constant whose behaviour the report describes as wrong or missing', no_when: 'the file merely imports, calls or tests the code that is fixed elsewhere, or is unrelated to the symptoms' };
  const probs: Record<string, number> = {}; const batches: Json[] = [];
  for (let i = 0; i < files.length; i += 250) {
    const batch = files.slice(i, i + 250);
    const state: Json = { issue: { repository: inst.repo, problem_statement: inst.problem_statement }, criteria, files: batch };
    const qs: Record<string, Question> = {};
    for (const p of batch) qs[p] = contextNoul(`Must the file \`${p}\` (listed in \`files\`) be modified to fix \`issue\`? Apply \`criteria\`.`);
    const r = await jev.ask(state, qs, { signal, stage: 'context', step: 1 }); spent += r.usage.costUsd;
    batches.push({ files: batch.length, input_tokens: r.usage.inputTokens, cost_usd: r.usage.costUsd, latency_ms: Math.round(r.latencyMs) });
    for (const [k, v] of Object.entries(r.answers)) if (v.type === 'noul') probs[k] = v.noul;
  }
  const top = ranked(probs);
  const rankOf = (g: string): number => top.findIndex(([k]) => k === g) + 1;
  const prev = saved.rows.find((r) => r.q === 'Q6' && r.instance_id === inst.instance_id)!;
  const row = { instance_id: inst.instance_id, n_files: files.length, batches, gold: Object.fromEntries([...gold].map((g) => [g, { p: probs[g] ?? null, rank: rankOf(g), saved_p: prev.metrics.p_gold[g], saved_rank_first_gold: prev.metrics.rank_first_gold }])), top3: top.slice(0, 3), selected_at_0_5: top.filter(([, v]) => v >= 0.5).length };
  out.push(row); console.log(JSON.stringify(row));
}
writeFileSync(`${DIR}/results-verify-q6.json`, JSON.stringify({ run_at: new Date().toISOString(), cost_usd: spent, rows: out }, null, 1));
console.log(`cost=$${spent.toFixed(4)}`);
