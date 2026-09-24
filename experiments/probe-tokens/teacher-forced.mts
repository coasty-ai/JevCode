/** Experiment 1: teacher-forced next-token accuracy over the 40 QuixBugs fix lines. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, loadCorpus, tokenize, candidateSet, tokenOptions, makeJev, askChoice, stateFor, NEXT_TOKEN_Q, END_KEY, pool, p50 } from './common.mts';

const j = makeJev(); const corpus = loadCorpus();
const jobs: { item: (typeof corpus)[number]; pos: number }[] = [];
for (const item of corpus) { const n = tokenize(item.fix_line).length; for (let pos = 0; pos <= n; pos++) jobs.push({ item, pos }); }
console.log(`${jobs.length} positions over ${corpus.length} lines`);
const rows = await pool(jobs, 16, async ({ item, pos }) => {
  const toks = tokenize(item.fix_line); const { cands, byText } = candidateSet(item);
  const target = pos < toks.length ? toks[pos]! : null;
  const truthKey = target === null ? END_KEY : (byText.get(target.text)?.key ?? 'none_of_these');
  const r = await askChoice(j, stateFor(item, toks.slice(0, pos)), 'next_token', NEXT_TOKEN_Q, tokenOptions(cands));
  const keys = r.ranked.map(([k]) => k); const rank = keys.indexOf(truthKey) + 1;
  return { name: item.name, pos, n: toks.length, target: target?.text ?? '<EOL>', cls: target?.cls ?? 'end', truthKey, top1: keys[0], p_top: r.ranked[0]![1], p_truth: r.probs[truthKey] ?? 0, rank, options: Object.keys(tokenOptions(cands)).length + 1, latencyMs: r.latencyMs, cost: r.cost };
});
writeFileSync(join(HERE, 'out/teacher-forced.json'), JSON.stringify({ rows, usage: j.usage }, null, 1));
const acc = (rs: typeof rows, k: number) => rs.filter((r) => r.rank >= 1 && r.rank <= k).length;
const mrr = (rs: typeof rows) => rs.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rs.length;
console.log(`\nALL positions n=${rows.length} top1=${acc(rows, 1)} (${(100 * acc(rows, 1) / rows.length).toFixed(1)}%) top3=${acc(rows, 3)} (${(100 * acc(rows, 3) / rows.length).toFixed(1)}%) MRR=${mrr(rows).toFixed(3)}`);
for (const cls of ['identifier', 'keyword', 'operator', 'punct', 'number', 'literal', 'string', 'end']) { const rs = rows.filter((r) => r.cls === cls); if (rs.length) console.log(`  ${cls.padEnd(11)} n=${String(rs.length).padStart(3)} top1=${acc(rs, 1)} (${(100 * acc(rs, 1) / rs.length).toFixed(0)}%) top3=${acc(rs, 3)} (${(100 * acc(rs, 3) / rs.length).toFixed(0)}%) MRR=${mrr(rs).toFixed(2)} mean_p_truth=${(rs.reduce((s, r) => s + r.p_truth, 0) / rs.length).toFixed(2)}`); }
console.log('\nper line: name n top1/n top3/n min_rank worst_pos(target->top1)');
for (const item of corpus) { const rs = rows.filter((r) => r.name === item.name).sort((a, b) => a.pos - b.pos); const worst = rs.reduce((w, r) => (r.rank === 0 || r.rank > (w.rank || 999) ? r : w), rs[0]!); console.log(`  ${item.name.padEnd(27)} ${String(rs.length).padStart(2)} top1=${String(acc(rs, 1)).padStart(2)} top3=${String(acc(rs, 3)).padStart(2)} all_top1=${acc(rs, 1) === rs.length ? 'Y' : 'n'} worst@${worst.pos}:${worst.target}->${worst.top1}(rank ${worst.rank || '>all'})`); }
const cls0 = rows.filter((r) => r.pos === 0); console.log(`\nfirst token (pos 0): top1=${acc(cls0, 1)}/${cls0.length}`);
console.log(`\ncalls=${j.usage.calls} cost=$${j.usage.cost.toFixed(4)} input_tokens=${j.usage.inTok} p50=${p50(j.usage.lat)}ms mean_tokens/req=${Math.round(j.usage.inTok / j.usage.calls)}`);
