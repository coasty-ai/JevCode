/** Pool results-run*.jsonl: per variant, mean over runs of top-1, top-1-passes, top-3, MRR, P(truth); pooled latency/cost.
 * Usage: node_modules/.bin/tsx experiments/probe-questions/aggregate.mts */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
interface Row { variant: string; family: string; program: string; rep: number; nOptions: number; rank: number; pTruth: number; pTop: number; topIsTruth: boolean; topText?: string; topPasses?: boolean | null; nHigh?: number; pSecond?: number; escape: number | null; costUsd: number; latencyMs: number; inputTokens: number; error?: string }
const files = readdirSync(HERE).filter((f) => /^results-run\d+\.jsonl$/.test(f)).sort();
const rows: (Row & { run: string })[] = [];
for (const f of files) for (const l of readFileSync(join(HERE, f), 'utf8').split('\n')) if (l.trim()) rows.push({ ...(JSON.parse(l) as Row), run: f.replace(/results-|\.jsonl/g, '') });
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const med = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
const f2 = (x: number): string => x.toFixed(2);
const variants = [...new Set(rows.map((r) => r.variant))];
const out: string[] = [];
out.push(`Pooled over runs: ${files.join(', ')}`, '');
out.push('| Variant | runs | Top-1 per run | mean Top-1 | mean Top-1 passes tests | mean Top-3 | MRR | mean P(truth) | mean P(top) | mean P(2nd) | mean #opts>=0.5 | wrong at P(top)>=0.7 | tokens/req | latency p50 ms | cost $ (all runs) |');
out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
const summary: Record<string, unknown> = {};
for (const v of variants) {
  const rs = rows.filter((r) => r.variant === v && r.rep === 0 && !r.error);
  const runs = [...new Set(rs.map((r) => r.run))];
  const per = runs.map((run) => rs.filter((r) => r.run === run));
  const top1 = per.map((x) => x.filter((r) => r.rank === 1).length);
  const perWithOracle = per.filter((x) => x.some((r) => r.topPasses !== null && r.topPasses !== undefined));
  const pass = perWithOracle.map((x) => x.filter((r) => r.topPasses === true).length);
  const hasPass = perWithOracle.length > 0 && rs[0]!.family === 'sel';
  const top3 = mean(per.map((x) => x.filter((r) => r.rank >= 1 && r.rank <= 3).length));
  const wrongConfident = rs.filter((r) => r.rank !== 1 && r.pTop >= 0.7 && r.topPasses !== true).length;
  const s = { runs: runs.length, top1, meanTop1: mean(top1), meanPass: hasPass ? mean(pass) : null, passRuns: perWithOracle.length, top3, mrr: mean(rs.map((r) => (r.rank ? 1 / r.rank : 0))), pTruth: mean(rs.map((r) => r.pTruth)), pTop: mean(rs.map((r) => r.pTop)), pSecond: rs.some((r) => r.pSecond !== undefined) ? mean(rs.filter((r) => r.pSecond !== undefined).map((r) => r.pSecond!)) : null, nHigh: rs.some((r) => r.nHigh !== undefined) ? mean(rs.filter((r) => r.nHigh !== undefined).map((r) => r.nHigh!)) : null, wrongConfident, n: rs.length, tokens: Math.round(mean(rs.map((r) => r.inputTokens))), latP50: Math.round(med(rs.map((r) => r.latencyMs))), cost: rs.reduce((a, r) => a + r.costUsd, 0) };
  summary[v] = s;
  out.push(`| ${v} | ${s.runs} | ${top1.join(' / ')} | ${f2(s.meanTop1)}/20 | ${s.meanPass === null ? 'n/a' : `${f2(s.meanPass)}/20 (${s.passRuns} runs)`} | ${f2(s.top3)}/20 | ${f2(s.mrr)} | ${f2(s.pTruth)} | ${f2(s.pTop)} | ${s.pSecond === null ? 'n/a' : f2(s.pSecond)} | ${s.nHigh === null ? 'n/a' : s.nHigh.toFixed(1)} | ${wrongConfident}/${s.n} | ${s.tokens} | ${s.latP50} | ${s.cost.toFixed(4)} |`);
}
// per-program pooled: mean P(truth) and top-1 hits over runs for the base variants
for (const [v, label] of [['L0_base', 'localisation'], ['S0_base', 'selection']] as const) {
  const rs = rows.filter((r) => r.variant === v && r.rep === 0 && !r.error);
  const programs = [...new Set(rs.map((r) => r.program))].sort();
  out.push('', `Per-program pooled, ${v} (${label}): top-1 hits over runs, P(truth) per run`, '', '| program | options | top-1 hits | P(truth) per run | top pick when wrong |', '| --- | --- | --- | --- | --- |');
  for (const p of programs) {
    const x = rs.filter((r) => r.program === p);
    const wrong = x.find((r) => r.rank !== 1 && r.topText);
    out.push(`| ${p} | ${x[0]!.nOptions} | ${x.filter((r) => r.rank === 1).length}/${x.length} | ${x.map((r) => f2(r.pTruth)).join(', ')} | ${wrong ? `\`${(wrong.topText ?? '').trim()}\` (${f2(wrong.pTop)}${wrong.topPasses ? ', passes tests' : ''})` : ''} |`);
  }
}
// repeat stability pooled
const reps = rows.filter((r) => r.variant === 'L0_base' && !r.error);
const repProgs = [...new Set(reps.filter((r) => r.rep > 0).map((r) => r.program))];
if (repProgs.length) {
  out.push('', 'Repeat stability, L0_base: all samples across runs (rep 0..4 per run)', '', '| program | samples | P(truth) min..max | max spread | argmax flips |', '| --- | --- | --- | --- | --- |');
  for (const p of repProgs) { const x = reps.filter((r) => r.program === p); const pt = x.map((r) => r.pTruth); out.push(`| ${p} | ${x.length} | ${f2(Math.min(...pt))}..${f2(Math.max(...pt))} | ${f2(Math.max(...pt) - Math.min(...pt))} | ${new Set(x.map((r) => r.topIsTruth)).size - 1} |`); }
}
const total = { requests: rows.length, errors: rows.filter((r) => r.error).length, cost: rows.reduce((a, r) => a + r.costUsd, 0), tokens: rows.reduce((a, r) => a + r.inputTokens, 0), latP50: Math.round(med(rows.filter((r) => !r.error).map((r) => r.latencyMs))), latP95: (() => { const s = rows.filter((r) => !r.error).map((r) => r.latencyMs).sort((a, b) => a - b); return Math.round(s[Math.floor(s.length * 0.95)] ?? 0); })() };
out.push('', `Total across runs: ${total.requests} requests (${total.errors} rejected), ${total.tokens} input tokens, $${total.cost.toFixed(4)}, latency p50 ${total.latP50} ms, p95 ${total.latP95} ms`);
console.log(out.join('\n'));
writeFileSync(join(HERE, 'aggregate.md'), out.join('\n'));
writeFileSync(join(HERE, 'aggregate.json'), JSON.stringify({ summary, total }, null, 1));
