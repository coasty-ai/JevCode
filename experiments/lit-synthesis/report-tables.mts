/** Renders the Markdown tables for lit-guided-synthesis.md from results/slot-probe-b{1,3,5}.json. Usage: tsx report-tables.mts */
import { readFileSync, existsSync } from 'node:fs';
const DIR = '/Users/prateekjannu/Documents/vscode/JevCode/experiments/lit-synthesis/results';
type Beam = { holes: number; requests: number; beam: string[]; truthRank: number; passRank: number; logpTruth: number | null; testsGoldOk: boolean };
type Slot = { i: number; cls: string; truth: string; nOptions: number; covered: boolean; cloze: { top1: boolean; rank: number; p: number; escape: number }; prefix: { top1: boolean; rank: number; p: number; escape: number } };
type Prog = { program: string; lines: number; oracleTests: number; totalTests: number; goldPassesAll: boolean; buggy: string; fixed: string; kind: { truth: string; pick: string; p: number; ok: boolean }; wrongToken: { truth: string[]; pick: string; p: number; ok: boolean; nTokens: number }; shapeSame: boolean; slots: Slot[]; s2: Beam | null; s1: Beam | null; costUsd: number; requests: number };
type Run = { summary: { n: number; requests: number; retries?: number; costUsd: number; latencyP50: number; latencyP90: number; beam: number }; results: Prog[] };
const runs: Record<number, Run> = {};
for (const b of [1, 3, 5]) { const f = `${DIR}/slot-probe-b${b}.json`; if (existsSync(f)) runs[b] = JSON.parse(readFileSync(f, 'utf8')) as Run; }
const f2 = (x: number) => x.toFixed(2); const pct = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0} %)`;
const mrr = (ss: Slot[], m: 'cloze' | 'prefix') => f2(ss.reduce((a, s) => a + (s[m].rank ? 1 / s[m].rank : 0), 0) / Math.max(1, ss.length));
const lines: string[] = [];
// --- run summary
lines.push('| Beam B | Programs | Jev requests | Retries | Cost | Jev p50 | Jev p90 | Cost / request |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const [b, r] of Object.entries(runs)) lines.push(`| ${b} | ${r.summary.n} | ${r.summary.requests} | ${r.summary.retries ?? 0} | $${r.summary.costUsd.toFixed(4)} | ${Math.round(r.summary.latencyP50)} ms | ${Math.round(r.summary.latencyP90)} ms | $${(r.summary.costUsd / r.summary.requests).toFixed(5)} |`);
lines.push('');
// --- probe aggregates (from the B=3 run, the probe request is identical across runs; report all three for noise)
lines.push('| Run | `kind` top-1 | `wrong_token` top-1 | Slots | Covered | Cloze top-1 | Prefix top-1 | Cloze MRR | Prefix MRR |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const [b, r] of Object.entries(runs)) { const ss = r.results.flatMap((p) => p.slots); lines.push(`| B=${b} | ${pct(r.results.filter((p) => p.kind.ok).length, r.results.length)} | ${pct(r.results.filter((p) => p.wrongToken.ok).length, r.results.length)} | ${ss.length} | ${pct(ss.filter((s) => s.covered).length, ss.length)} | ${pct(ss.filter((s) => s.cloze.top1).length, ss.length)} | ${pct(ss.filter((s) => s.prefix.top1).length, ss.length)} | ${mrr(ss, 'cloze')} | ${mrr(ss, 'prefix')} |`); }
lines.push('');
// --- per slot class (B=3 run)
const main = runs[3] ?? Object.values(runs)[0]!;
const all = main.results.flatMap((p) => p.slots);
lines.push('| Slot class | n | Options per Choice (mean) | Covered | Cloze top-1 | Prefix top-1 | Prefix MRR | Mean P(truth) prefix | Mean P(escape) prefix |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const c of ['ident', 'attr', 'oper', 'num']) { const ss = all.filter((s) => s.cls === c); if (!ss.length) continue; lines.push(`| ${c} | ${ss.length} | ${(ss.reduce((a, s) => a + s.nOptions, 0) / ss.length).toFixed(1)} | ${pct(ss.filter((s) => s.covered).length, ss.length)} | ${pct(ss.filter((s) => s.cloze.top1).length, ss.length)} | ${pct(ss.filter((s) => s.prefix.top1).length, ss.length)} | ${mrr(ss, 'prefix')} | ${f2(ss.reduce((a, s) => a + s.prefix.p, 0) / ss.length)} | ${f2(ss.reduce((a, s) => a + s.prefix.escape, 0) / ss.length)} |`); }
lines.push('');
// --- beam results by width
lines.push('| Beam B | S2 diff-fill ran | S2 tests pass (any rank) | S2 pass at rank 1 | S2 truth in beam | S1 full-fill ran | S1 tests pass | S1 pass at rank 1 | S1 truth in beam | S1 mean holes | S1 requests / line |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const [b, r] of Object.entries(runs)) { const s2 = r.results.filter((p) => p.s2), s1 = r.results.filter((p) => p.s1); lines.push(`| ${b} | ${s2.length} | ${pct(s2.filter((p) => p.s2!.passRank > 0).length, s2.length)} | ${s2.filter((p) => p.s2!.passRank === 1).length} | ${pct(s2.filter((p) => p.s2!.truthRank > 0).length, s2.length)} | ${s1.length} | ${pct(s1.filter((p) => p.s1!.passRank > 0).length, s1.length)} | ${s1.filter((p) => p.s1!.passRank === 1).length} | ${pct(s1.filter((p) => p.s1!.truthRank > 0).length, s1.length)} | ${(s1.reduce((a, p) => a + p.s1!.holes, 0) / Math.max(1, s1.length)).toFixed(1)} | ${(s1.reduce((a, p) => a + p.s1!.requests, 0) / Math.max(1, s1.length)).toFixed(1)} |`); }
lines.push('');
// --- per-item rows (B=3)
lines.push(`Per-program rows, B=${main.summary.beam} run. "wrong" = which token of the buggy line is wrong (truth from an LCS token diff; "missing" when the fix only inserts). Slots = ident/oper/num tokens of the fixed line. S2 = beam over only the differing slots; S1 = beam over every slot. "pass@r" = rank of the first beam candidate that passes every oracle test (0 = none); "truth@r" = rank of the gold line in the beam.`, '');
lines.push('| Program | Buggy line → fixed line | Kind | Wrong token | Slots (cov / cloze / prefix) | S2 holes | S2 pass@ | S2 truth@ | S1 pass@ | S1 truth@ | Requests (1 + S1 + S2) | Cost (est.) |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
const perReq = main.summary.costUsd / main.summary.requests; // per-program `requests`/`costUsd` in the raw JSON are inflated by the 6-way concurrency (shared counters); derive from s1/s2 instead
const reqOf = (p: Prog) => 1 + (p.s1?.requests ?? 0) + (p.s2?.requests ?? 0);
for (const p of main.results) {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/`/g, '\u0060');
  lines.push(`| ${p.program} | \`${esc(p.buggy)}\` → \`${esc(p.fixed)}\` | ${p.kind.ok ? 'Y' : `n (${p.kind.pick})`} | ${p.wrongToken.ok ? 'Y' : `n (${p.wrongToken.pick})`} p=${f2(p.wrongToken.p)} | ${p.slots.length} (${p.slots.filter((s) => s.covered).length} / ${p.slots.filter((s) => s.cloze.top1).length} / ${p.slots.filter((s) => s.prefix.top1).length}) | ${p.s2?.holes ?? '–'} | ${p.s2 ? p.s2.passRank || 'none' : '–'} | ${p.s2 ? p.s2.truthRank || 'out' : '–'} | ${p.s1 ? p.s1.passRank || 'none' : '–'} | ${p.s1 ? p.s1.truthRank || 'out' : '–'} | ${reqOf(p)} | $${(reqOf(p) * perReq).toFixed(4)} |`);
}
lines.push('');
// --- slot failures (prefix mode) in B=3
lines.push('Prefix-mode slot misses (B=3 run): the token Jev ranked first versus the truth.', '', '| Program | Slot truth | Class | Rank of truth | P(truth) | P(escape) | Options |', '| --- | --- | --- | --- | --- | --- | --- |');
for (const p of main.results) for (const s of p.slots) if (!s.prefix.top1) lines.push(`| ${p.program} | \`${s.truth}\` | ${s.cls} | ${s.prefix.rank || "n/a"} | ${f2(s.prefix.p)} | ${f2(s.prefix.escape)} | ${s.nOptions} |`);
console.log(lines.join('\n'));
