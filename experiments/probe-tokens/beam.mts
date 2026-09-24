/** Experiment 2: free-running beam search (width W, <= 25 tokens) building each fix line from Choices. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, filterOptions, loadCorpus, tokenize, detokenize, sameTokens, candidateSet, tokenOptions, makeJev, askChoice, stateFor, NEXT_TOKEN_Q, END_KEY, pool, p50, runTests, type Tok, type Cand } from './common.mts';

const W = Number(process.argv[2] ?? 1); const GRAMMAR = process.argv[3] === 'grammar'; const MAXLEN = 25; const VERIFY_TOP = 3;
const j = makeJev(); const corpus = loadCorpus();
interface Beam { toks: Tok[]; logp: number; steps: number }
const rows = await pool(corpus, 6, async (item) => {
  const t0 = Date.now(); const target = tokenize(item.fix_line); const { cands } = candidateSet(item); const opts = tokenOptions(cands);
  const byKey = new Map<string, Cand>(cands.map((c) => [c.key, c]));
  let live: Beam[] = [{ toks: [], logp: 0, steps: 0 }]; const completed: Beam[] = []; let requests = 0, cost = 0; const lat: number[] = []; let truncated = 0;
  for (let step = 0; step < MAXLEN && live.length; step++) {
    // standard pruning: stop when W completed beams all beat every live beam (sum log p only decreases)
    if (completed.length >= W) { const topW = [...completed].sort((a, b) => b.logp - a.logp).slice(0, W); if (Math.max(...live.map((b) => b.logp)) < topW[topW.length - 1]!.logp) break; }
    const rs = await Promise.all(live.map((b) => askChoice(j, stateFor(item, b.toks), 'next_token', NEXT_TOKEN_Q, GRAMMAR ? filterOptions(cands, b.toks) : opts)));
    const exp: Beam[] = [];
    for (const [bi, r] of rs.entries()) {
      const b = live[bi]!; requests++; cost += r.cost; lat.push(r.latencyMs);
      let taken = 0;
      for (const [key, p] of r.ranked) {
        if (taken >= W) break; if (key === 'none_of_these' || p <= 0) continue; taken++;
        const nb = { toks: key === END_KEY ? b.toks : [...b.toks, byKey.get(key)!.tok], logp: b.logp + Math.log(p), steps: step + 1 };
        if (key === END_KEY) completed.push(nb); else exp.push(nb);
      }
    }
    exp.sort((a, b) => b.logp - a.logp); live = exp.slice(0, W);
    if (step === MAXLEN - 1) truncated = live.length;
  }
  completed.sort((a, b) => b.logp - a.logp);
  const uniq: Beam[] = []; for (const c of completed) if (!uniq.some((u) => sameTokens(u.toks, c.toks))) uniq.push(c);
  const byMean = [...uniq].sort((a, b) => b.logp / (b.toks.length + 1) - a.logp / (a.toks.length + 1));
  const verified = uniq.slice(0, VERIFY_TOP).map((b) => ({ line: detokenize(b.toks), logp: b.logp, exact: sameTokens(b.toks, target), pass: runTests(item, detokenize(b.toks)).pass }));
  const top = verified[0];
  const row = { name: item.name, W, n_target: target.length, target: item.fix_line, top_line: top?.line ?? null, top_logp: top?.logp ?? null, top_exact: top?.exact ?? false, top_pass: top?.pass ?? false, any_exact: verified.some((v) => v.exact), any_pass: verified.some((v) => v.pass), mean_rank_top_exact: byMean[0] ? sameTokens(byMean[0].toks, target) : false, completed: uniq.length, truncated, requests, cost, lat_p50: p50(lat), wall_ms: Date.now() - t0, verified };
  console.log(`${item.name.padEnd(27)} W=${W}${GRAMMAR ? 'g' : ''} req=${String(requests).padStart(2)} $${cost.toFixed(4)} ${(row.wall_ms / 1000).toFixed(1)}s | top: ${row.top_exact ? 'EXACT' : row.top_pass ? 'PASS ' : 'fail '} any(${verified.length}): ${row.any_exact ? 'EXACT' : row.any_pass ? 'PASS ' : 'fail '} | ${row.top_line ?? '<none>'}${row.top_exact ? '' : `   (target: ${item.fix_line})`}`);
  return row;
});
writeFileSync(join(HERE, `out/beam-w${W}${GRAMMAR ? '-grammar' : ''}.json`), JSON.stringify({ rows, usage: j.usage }, null, 1));
const c = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
console.log(`\nW=${W} lines=${rows.length} top_exact=${c((r) => r.top_exact)} top_pass=${c((r) => r.top_pass)} any_exact(top${VERIFY_TOP})=${c((r) => r.any_exact)} any_pass(top${VERIFY_TOP})=${c((r) => r.any_pass)} mean_rank_top_exact=${c((r) => r.mean_rank_top_exact)} truncated_lines=${c((r) => r.truncated > 0)}`);
console.log(`calls=${j.usage.calls} cost=$${j.usage.cost.toFixed(4)} per_line=$${(j.usage.cost / rows.length).toFixed(4)} req/line=${(j.usage.calls / rows.length).toFixed(1)} jev_p50=${p50(j.usage.lat).toFixed(0)}ms wall_p50=${p50(rows.map((r) => r.wall_ms))}ms`);
