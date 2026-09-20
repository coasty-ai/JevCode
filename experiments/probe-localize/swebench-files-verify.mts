/**
 * Live probe: FILE-level localisation on the 30 checked-in SWE-bench Verified instances from
 * the problem_statement alone. Two variants per instance:
 *   choice: Choice over <= 254 candidate files (.py files under the gold files' directories, capped,
 *           plus up to 200 random other .py files) + none_of_these; state = problem_statement + paths.
 *   noul:   one Noul per file over 60 files (gold + same-directory fill + random), ranked by p.
 * Repos are worktrees at base_commit under /tmp/jevonly/repos/<instance_id>.
 * Usage: env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/probe-localize/swebench-files.mts [instance_id...]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJevDecider } from '../../src/jev/client.ts';
import { choice, noul } from '../../src/jev/questions.ts';
import type { Json, Question } from '../../src/core/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = '/tmp/jevonly/repos';
const DATA = '/Users/prateekjannu/Documents/vscode/JevCode/bench/data';
const key = process.env['OPENROUTER_API_KEY'] ?? '';
if (!key) throw new Error('OPENROUTER_API_KEY missing');
const jev = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact: (s) => s });
const signal = new AbortController().signal;

type Inst = { instance_id: string; repo: string; base_commit: string; problem_statement: string };
const insts = JSON.parse(readFileSync(join(DATA, 'swebench-verified-30.json'), 'utf8')) as Inst[];
const gold = JSON.parse(readFileSync(join(DATA, 'swebench-verified-30.gold.json'), 'utf8')) as Record<string, string>;

/** Deterministic PRNG (mulberry32) so the random fill is reproducible per instance. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function seedOf(s: string): number { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function sample<T>(arr: T[], n: number, r: () => number): T[] { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a.slice(0, n); }
function keyFor(path: string, used: Set<string>): string {
  let k = path.replace(/\.py$/, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  if (!/^[a-z]/.test(k)) k = `f_${k}`;
  k = k.slice(0, 60); if (k.length < 2) k = `${k}_x`;
  let out = k, i = 2; while (used.has(out)) out = `${k.slice(0, 57)}_${i++}`;
  used.add(out); return out;
}
function goldFiles(id: string): string[] { return [...gold[id]!.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!); }

type Row = { instance: string; variant: string; nCandidates: number; gold: string[]; dirPool: number; top1: string; rank: number; pTop: number; pGold: number; costUsd: number; latencyMs: number; inputTokens: number; nAbove05?: number; top5: string[] };
const rows: Row[] = [];
const calib: { instance: string; path: string; p: number; isGold: boolean }[] = [];

async function probe(inst: Inst): Promise<void> {
  const dir = join(REPO_ROOT, inst.instance_id);
  const all = execFileSync('git', ['-C', dir, 'ls-files', '*.py', '**/*.py'], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
  const files = [...new Set(all)];
  const g = goldFiles(inst.instance_id).filter((f) => f.endsWith('.py'));
  const gset = new Set(g);
  const dirs = [...new Set(g.map((f) => dirname(f)))];
  const dirPool = files.filter((f) => !gset.has(f) && dirs.some((d) => f.startsWith(`${d}/`)));
  const others = files.filter((f) => !gset.has(f) && !dirPool.some((x) => x === f));
  const r = rng(seedOf(inst.instance_id));
  const dirTake = sample(dirPool, Math.min(dirPool.length, 254 - g.length - Math.min(200, others.length) > 0 ? 254 - g.length - 200 : 54), r);
  const otherTake = sample(others, Math.min(200, 254 - g.length - dirTake.length), r);
  const cands = sample([...g, ...dirTake, ...otherTake], Infinity, r);
  const used = new Set<string>(['none_of_these']);
  const opts: Record<string, Json> = {}; const keyOf = new Map<string, string>();
  for (const f of cands) { const k = keyFor(f, used); opts[k] = f; keyOf.set(f, k); }
  const state: Json = { problem_statement: inst.problem_statement, repository: inst.repo, candidate_files: cands };
  const q = choice('Which file in `candidate_files` must be edited to fix the problem described in `problem_statement`? Pick the file where the code change belongs, judging from the file path and the problem text. Choose `none_of_these` only if none of the listed files is the one to change.', opts);
  const r1 = await jev.ask(state, { fix_file: q }, { signal, stage: 'context', step: 1 });
  const a1 = r1.answers['fix_file']!; if (a1.type !== 'choice') throw new Error('not choice');
  const ranked = Object.entries(a1.probabilities).sort((x, y) => y[1] - x[1]);
  const rankedPaths = ranked.map(([k]) => (k === 'none_of_these' ? k : (opts[k] as string)));
  let rank = Infinity, pGold = 0; for (const f of g) { const i = rankedPaths.indexOf(f) + 1; if (i > 0 && i < rank) rank = i; pGold = Math.max(pGold, a1.probabilities[keyOf.get(f)!] ?? 0); }
  rows.push({ instance: inst.instance_id, variant: 'choice_files', nCandidates: cands.length, gold: g, dirPool: dirTake.length, top1: rankedPaths[0]!, rank, pTop: ranked[0]![1], pGold, costUsd: r1.usage.costUsd, latencyMs: r1.latencyMs, inputTokens: r1.usage.inputTokens, top5: rankedPaths.slice(0, 5) });

  // Noul per file over 60 files: gold + up to 19 same-directory + random fill
  const r2nd = rng(seedOf(inst.instance_id) ^ 0x9e3779b9);
  const dir60 = sample(dirPool, Math.min(19, dirPool.length), r2nd);
  const oth60 = sample(others, 60 - g.length - dir60.length, r2nd);
  const files60 = sample([...g, ...dir60, ...oth60], Infinity, r2nd);
  const crit = {
    true: { definition: 'The fix for the problem requires changing code in this file: it is where the misbehaving function, class, method or setting named or implied by the problem lives, or where a fix for it must be added.', examples: ['the problem reports a wrong result from a method that is defined in this file', 'the traceback in the problem ends in this file', 'the problem asks to change a default that this file sets'] },
    false: { definition: 'This file does not need to change: it is a test, a documentation or build file, an unrelated module or package, or it only calls the code that must change.', examples: ['a test file such as `tests/test_x.py` when the problem is about library behaviour', 'a module in an unrelated subpackage', 'a file that merely imports the buggy function'] },
  };
  const used2 = new Set<string>(); const qs: Record<string, Question> = {}; const pathOfKey = new Map<string, string>();
  for (const f of files60) { const k = keyFor(f, used2); pathOfKey.set(k, f); qs[k] = noul(`Must the file \`${f}\` be edited to fix the problem described in \`problem_statement\`? Judge this file on its own; other files are judged separately.`, crit); }
  const state2: Json = { problem_statement: inst.problem_statement, repository: inst.repo, candidate_files: files60 };
  const r2 = await jev.ask(state2, qs, { signal, stage: 'context', step: 1 });
  const probs = Object.entries(r2.answers).map(([k, a]) => [pathOfKey.get(k)!, a.type === 'noul' ? a.noul : 0] as const).sort((x, y) => y[1] - x[1]);
  for (const [path, p] of probs) calib.push({ instance: inst.instance_id, path, p, isGold: gset.has(path) });
  let rank2 = Infinity, pGold2 = 0; for (const f of g) { const i = probs.findIndex(([p]) => p === f) + 1; if (i > 0 && i < rank2) rank2 = i; pGold2 = Math.max(pGold2, probs.find(([p]) => p === f)?.[1] ?? 0); }
  rows.push({ instance: inst.instance_id, variant: 'noul_per_file_60', nCandidates: files60.length, gold: g, dirPool: dir60.length, top1: probs[0]![0], rank: rank2, pTop: probs[0]![1], pGold: pGold2, costUsd: r2.usage.costUsd, latencyMs: r2.latencyMs, inputTokens: r2.usage.inputTokens, nAbove05: probs.filter(([, p]) => p >= 0.5).length, top5: probs.slice(0, 5).map(([p]) => p) });
  console.log(`${inst.instance_id.padEnd(26)} cands=${cands.length} dir=${dirTake.length} gold=${g.join(',')} | choice rank=${rank} pTop=${ranked[0]![1].toFixed(2)} pGold=${pGold.toFixed(2)} top1=${rankedPaths[0]} | noul60 rank=${rank2} pGold=${pGold2.toFixed(2)} above0.5=${probs.filter(([, p]) => p >= 0.5).length} top1=${probs[0]![0]}`);
}

const wanted = process.argv.length > 2 ? insts.filter((i) => process.argv.slice(2).includes(i.instance_id)) : insts;
const queue = [...wanted]; const CONC = 5;
await Promise.all(Array.from({ length: CONC }, async () => { while (queue.length) { const i = queue.shift()!; try { await probe(i); } catch (e) { console.error(`FAIL ${i.instance_id}: ${(e as Error).message}`); } } }));
writeFileSync(join(HERE, 'swebench-files.verify.rows.json'), JSON.stringify({ rows, calib }, null, 1));
for (const v of ['choice_files', 'noul_per_file_60']) {
  const rs = rows.filter((r) => r.variant === v);
  const lat = rs.map((r) => r.latencyMs).sort((a, b) => a - b);
  console.log(`${v.padEnd(18)} n=${rs.length} top1=${rs.filter((r) => r.rank === 1).length} top5=${rs.filter((r) => r.rank <= 5).length} MRR=${(rs.reduce((s, r) => s + (isFinite(r.rank) ? 1 / r.rank : 0), 0) / rs.length).toFixed(3)} cost=$${rs.reduce((s, r) => s + r.costUsd, 0).toFixed(4)} p50=${lat[Math.floor(lat.length / 2)]}ms tokens=${rs.reduce((s, r) => s + r.inputTokens, 0)}`);
}
