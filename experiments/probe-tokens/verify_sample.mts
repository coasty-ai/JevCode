/** Verification (2026-09-20): live re-run of a small sample (<= $0.10) and comparison with the saved rows.
 * Teacher-forced on 4 programs (every position) and beam W=3 + grammar on the same 4 programs. */
import { readFileSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
import { HERE, loadCorpus, tokenize, detokenize, sameTokens, candidateSet, tokenOptions, filterOptions, makeJev, askChoice, stateFor, NEXT_TOKEN_Q, END_KEY, pool, p50, runTests, type Tok, type Cand } from './common.mts';
const NAMES = ['gcd', 'kth', 'possible_change', 'bucketsort'];
const j = makeJev(); j.capUsd = 0.10; const corpus = loadCorpus().filter((c) => NAMES.includes(c.name));
const saved = JSON.parse(readFileSync(join(HERE, 'out/teacher-forced.json'), 'utf8')).rows as { name: string; pos: number; rank: number; p_top: number; top1: string }[];
const savedBeam = JSON.parse(readFileSync(join(HERE, 'out/beam-w3-grammar.json'), 'utf8')).rows as { name: string; top_line: string; any_pass: boolean; top_pass: boolean; requests: number }[];
// 1. teacher-forced
const jobs: { item: (typeof corpus)[number]; pos: number }[] = [];
for (const item of corpus) { const n = tokenize(item.fix_line).length; for (let pos = 0; pos <= n; pos++) jobs.push({ item, pos }); }
const tf = await pool(jobs, 8, async ({ item, pos }) => {
  const toks = tokenize(item.fix_line); const { cands, byText } = candidateSet(item); const target = pos < toks.length ? toks[pos]! : null;
  const truthKey = target === null ? END_KEY : (byText.get(target.text)?.key ?? 'none_of_these');
  const r = await askChoice(j, stateFor(item, toks.slice(0, pos)), 'next_token', NEXT_TOKEN_Q, tokenOptions(cands));
  const rank = r.ranked.map(([k]) => k).indexOf(truthKey) + 1; const s = saved.find((x) => x.name === item.name && x.pos === pos)!;
  return { name: item.name, pos, rank, p_top: r.ranked[0]![1], top1: r.ranked[0]![0], saved_rank: s.rank, saved_top1: s.top1, saved_p_top: s.p_top };
});
const c1 = (f: (r: (typeof tf)[number]) => boolean) => tf.filter(f).length;
console.log(`TF sample n=${tf.length}: top1 now ${c1((r) => r.rank === 1)} vs saved ${c1((r) => r.saved_rank === 1)}; top3 now ${c1((r) => r.rank >= 1 && r.rank <= 3)} vs saved ${c1((r) => r.saved_rank >= 1 && r.saved_rank <= 3)}; same top1 key ${c1((r) => r.top1 === r.saved_top1)}/${tf.length}; mean |dp_top| ${(tf.reduce((s, r) => s + Math.abs(r.p_top - r.saved_p_top), 0) / tf.length).toFixed(3)}`);
for (const r of tf.filter((r) => r.top1 !== r.saved_top1)) console.log(`  differs: ${r.name}@${r.pos} now ${r.top1} (rank ${r.rank}) saved ${r.saved_top1} (rank ${r.saved_rank})`);
const tfCost = j.usage.cost;
// 2. beam W=3 + grammar (same code path as beam.mts)
const W = 3, MAXLEN = 25; interface Beam { toks: Tok[]; logp: number }
const beam = await pool(corpus, 4, async (item) => {
  const target = tokenize(item.fix_line); const { cands } = candidateSet(item); const byKey = new Map<string, Cand>(cands.map((c) => [c.key, c]));
  let live: Beam[] = [{ toks: [], logp: 0 }]; const completed: Beam[] = []; let requests = 0;
  for (let step = 0; step < MAXLEN && live.length; step++) {
    if (completed.length >= W) { const topW = [...completed].sort((a, b) => b.logp - a.logp).slice(0, W); if (Math.max(...live.map((b) => b.logp)) < topW[topW.length - 1]!.logp) break; }
    const rs = await Promise.all(live.map((b) => askChoice(j, stateFor(item, b.toks), 'next_token', NEXT_TOKEN_Q, filterOptions(cands, b.toks))));
    const exp: Beam[] = [];
    for (const [bi, r] of rs.entries()) { const b = live[bi]!; requests++; let taken = 0; for (const [key, p] of r.ranked) { if (taken >= W) break; if (key === 'none_of_these' || p <= 0) continue; taken++; const nb = { toks: key === END_KEY ? b.toks : [...b.toks, byKey.get(key)!.tok], logp: b.logp + Math.log(p) }; if (key === END_KEY) completed.push(nb); else exp.push(nb); } }
    exp.sort((a, b) => b.logp - a.logp); live = exp.slice(0, W);
  }
  completed.sort((a, b) => b.logp - a.logp); const uniq: Beam[] = []; for (const c of completed) if (!uniq.some((u) => sameTokens(u.toks, c.toks))) uniq.push(c);
  const verified = uniq.slice(0, 3).map((b) => ({ line: detokenize(b.toks), exact: sameTokens(b.toks, target), pass: runTests(item, detokenize(b.toks)).pass }));
  const s = savedBeam.find((x) => x.name === item.name)!;
  console.log(`beam ${item.name}: req ${requests} (saved ${s.requests}) top "${verified[0]?.line}" pass=${verified[0]?.pass} any_pass=${verified.some((v) => v.pass)} | saved top "${s.top_line}" top_pass=${s.top_pass} any_pass=${s.any_pass}`);
  return { name: item.name, requests, top_line: verified[0]?.line ?? null, top_pass: verified[0]?.pass ?? false, any_pass: verified.some((v) => v.pass), saved: s };
});
console.log(`beam sample: any_pass now ${beam.filter((b) => b.any_pass).length}/4 vs saved ${beam.filter((b) => b.saved.any_pass).length}/4`);
console.log(`cost: teacher-forced $${tfCost.toFixed(4)} (${tf.length} req), beam $${(j.usage.cost - tfCost).toFixed(4)}; total $${j.usage.cost.toFixed(4)} over ${j.usage.calls} requests, Jev p50 ${p50(j.usage.lat).toFixed(0)} ms`);
writeFileSync(join(HERE, 'out/verify-sample.json'), JSON.stringify({ tf, beam, usage: j.usage }, null, 1));
