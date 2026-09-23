/** Build experiments/results/probe-selection.md from probe-selection.raw.jsonl and /tmp/jevonly/pools.json. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RESULTS = fileURLToPath(new URL('../results', import.meta.url));
interface Rec { phase: string; program: string; mode: string; method: string; variant: string; order: string; size: number; options: number; withFix: boolean; fixKey: string | null; fixGenerated: string; top: [string, number][]; pTrue: number | null; pEscape: number | null; rankTrue: number | null; top1: string; top1IsFix: boolean; top1IsEscape: boolean; top1Text: string | null; top1Plausible: boolean | null; top3Plausible?: boolean; costUsd: number; latencyMs: number; inputTokens: number; sumP: number }
const recs: Rec[] = readFileSync(`${RESULTS}/probe-selection.raw.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Rec).map((r) => (r.method === 'nouls' && r.variant === 'state' ? { ...r, variant: 'full' } : r)); // the first Noul run predates the full/compact label
const pools = JSON.parse(readFileSync('/tmp/jevonly/pools.json', 'utf8')) as { program: { name: string; mode: string; buggyLine: string; fixLine: string; index: number; lines: string[] }; pool: { pool: { op: string }[]; firstOrder: number; neighbour: number; fixGenerated: string } }[];

const f2 = (x: number): string => x.toFixed(2);
const f3 = (x: number): string => x.toFixed(3);
const pct = (a: number, n: number): string => `${a}/${n} (${n ? Math.round((100 * a) / n) : 0}%)`;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const q = (xs: number[], p: number): number => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const mrr = (rs: Rec[]): number => mean(rs.map((r) => (r.rankTrue ? 1 / r.rankTrue : 0)));
const topK = (rs: Rec[], k: number): number => rs.filter((r) => r.rankTrue !== null && r.rankTrue <= k).length;
const maxNonEscape = (r: Rec): number => Math.max(0, ...r.top.filter(([k]) => k !== 'none_of_these').map(([, p]) => p));
const usd = (x: number): string => `$${x < 0.001 ? x.toFixed(5) : x.toFixed(4)}`;

const out: string[] = [];
const H = (s: string): void => { out.push('', s, ''); };
const T = (head: string[], rows: string[][]): void => { out.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`), ''); };

const totalCost = recs.reduce((s, r) => s + r.costUsd, 0);
const lat = recs.map((r) => r.latencyMs);
out.push(`# Probe: candidate selection at scale on QuixBugs (2026-09-20)`, '', `Scripts: \`experiments/probe-select/\` (\`mutators.ts\` operator library, \`candidates.ts\` set construction, \`quixbugs.ts\` + \`run_tests.py\` loader and oracle, \`run.mts\` live driver, \`report.mts\` this file). Model \`typesafe/jev-1.13-20260917\` via OpenRouter, pinned. All 40 QuixBugs Python programs (36 one-line replacements, 4 missing-statement insertions: depth_first_search, reverse_linked_list, shunting_yard, wrap). Raw records: \`experiments/results/probe-selection.raw.jsonl\` (${recs.length} Jev requests, total ${usd(totalCost)}, latency p50 ${Math.round(q(lat, 0.5))} ms, p95 ${Math.round(q(lat, 0.95))} ms).`);

// ---------------------------------------------------------------- summary (numbers pulled from the records below)
{
  const mainD = recs.filter((r) => r.phase === 'main' && r.variant === 'desc');
  const nf = recs.filter((r) => r.phase === 'nouls' && r.variant === 'full');
  const nc = recs.filter((r) => r.phase === 'nouls' && r.variant === 'compact');
  const rr = recs.filter((r) => r.phase === 'rerank');
  const row = (rs: Rec[], s: number, wf = true): Rec[] => rs.filter((r) => r.size === s && r.withFix === wf);
  const t1 = (rs: Rec[]): string => `${rs.filter((r) => r.top1IsFix).length}/${rs.length}`;
  const t3 = (rs: Rec[]): string => `${topK(rs, 3)}/${rs.length}`;
  const pl = (rs: Rec[]): string => `${rs.filter((r) => r.top1Plausible).length}/${rs.length}`;
  H('## Summary');
  T(['method (one request each)', 'N=10 top-1 / top-3', 'N=50 top-1 / top-3', 'N=150 top-1 / top-3', 'N=254 top-1 / top-3', 'N=254 top-1 plausible', 'N=254 tokens / cost / p50'], [
    ['Choice over candidates + `none_of_these`', `${t1(row(mainD, 10))} / ${t3(row(mainD, 10))}`, `${t1(row(mainD, 50))} / ${t3(row(mainD, 50))}`, `${t1(row(mainD, 150))} / ${t3(row(mainD, 150))}`, `${t1(row(mainD, 254))} / ${t3(row(mainD, 254))}`, pl(row(mainD, 254)), `${Math.round(mean(row(mainD, 254).map((r) => r.inputTokens)))} / ${usd(mean(row(mainD, 254).map((r) => r.costUsd)))} / ${Math.round(q(row(mainD, 254).map((r) => r.latencyMs), 0.5))} ms`],
    ['Batched Nouls, full criteria per Noul', `${t1(row(nf, 10))} / ${t3(row(nf, 10))}`, `${t1(row(nf, 50))} / ${t3(row(nf, 50))}`, `${t1(row(nf, 150))} / ${t3(row(nf, 150))}`, `${t1(row(nf, 254))} / ${t3(row(nf, 254))}`, pl(row(nf, 254)), `${Math.round(mean(row(nf, 254).map((r) => r.inputTokens)))} / ${usd(mean(row(nf, 254).map((r) => r.costUsd)))} / ${Math.round(q(row(nf, 254).map((r) => r.latencyMs), 0.5))} ms`],
    ['Batched Nouls, compact (criteria once in state)', `${t1(row(nc, 10))} / ${t3(row(nc, 10))}`, `${t1(row(nc, 50))} / ${t3(row(nc, 50))}`, `${t1(row(nc, 150))} / ${t3(row(nc, 150))}`, `${t1(row(nc, 254))} / ${t3(row(nc, 254))}`, pl(row(nc, 254)), `${Math.round(mean(row(nc, 254).map((r) => r.inputTokens)))} / ${usd(mean(row(nc, 254).map((r) => r.costUsd)))} / ${Math.round(q(row(nc, 254).map((r) => r.latencyMs), 0.5))} ms`],
    ['Two-stage: Nouls (254) then Choice over the Noul top-5', '-', '-', '-', `${t1(rr.filter((r) => r.withFix))} (fix shortlisted ${rr.filter((r) => r.withFix && r.fixKey !== null).length}/40)`, pl(rr.filter((r) => r.withFix)), 'two requests, about $0.0025, about 0.8 s'],
  ]);
  out.push(`Fix absent (no-fix sets): with Choice the escape wins ${row(mainD, 10, false).filter((r) => r.top1IsEscape).length}/40, ${row(mainD, 50, false).filter((r) => r.top1IsEscape).length}/40, ${row(mainD, 150, false).filter((r) => r.top1IsEscape).length}/40, ${row(mainD, 254, false).filter((r) => r.top1IsEscape).length}/40 at N = 10/50/150/254; the best single-request detector is \`P(escape) - p_max >= 0.10\` (AUROC 0.916, 82% detection, 13% false alarms pooled over sizes). With Nouls, \`max Noul < 0.5\` detects 71-75% with 16-21% false alarms (AUROC 0.85-0.86). At N >= 150, 13-23% of the "no-fix" sets in fact contained a different line that passes every test (Jev picked it), so the true detector ceiling is lower than 100%. Removing the escape option does not change Choice top-1 (identical at N = 10/50/150, 24 vs 26 at 254): the Choice degradation with N is intrinsic, not mass stolen by the escape. Option order flipped the argmax on 1/10 programs (a 0.29 vs 0.30 tie) with P(fix) spread up to 0.33 on borderline items against a repeat noise of 0.03 mean / 1 flip in 40; Noul repeat noise 0.036 mean / 2 flips in 40.`);
}

H('## Setup');
out.push(`**Candidate sets.** For each program the buggy line (the gold diff's replaced line; for insertions, the line before the insertion point) is mutated by 20 string-level operators (relational, arithmetic and boolean swaps; off-by-one on integer literals and on atoms in index/argument positions; index flips; argument-order swaps; negation insertion/removal; constant substitution from literals in the program and the first three tests; identifier, call-name and attribute substitution from in-scope names; return tweaks; operand swap / condition inversion; guard extension \`if X or not y:\`; wrap/unwrap in max/min/\`** 2\`; slice tweaks; drop-index; method-call to assignment; \`k\` to \`k - other\`). Mutants that do not \`compile()\` in place are dropped. The pool is ordered: the unchanged buggy line, first-order mutants of the buggy line (seeded shuffle), then mutants of neighbouring lines by distance (re-indented), then second-order mutants; for insertions, every program line re-indented as a donor plus its mutants plus \`a.add(b)\`/\`a.append(b)\`/\`a = b\` templates over in-scope names. Sets are nested prefixes of the pool of size 10, 50, 150 and 254 (+ \`none_of_these\` = 255 options), with the gold fix line inserted at a seeded position for the with-fix sets and omitted (next pool entry used) for the no-fix sets.`);
out.push('', `**State shape** (identical for every condition; the \`desc\` variant carries candidate text in the option descriptions, the \`state\` variant puts them under \`state.candidates\` with null descriptions):`, '', '```json', `{ "task": "The Python function \`gcd\` has a one-line bug. \`buggy_line\` (line \`buggy_line_number\` of \`program\`) is the faulty line. \`tests\` shows inputs, the expected output, and what the buggy program actually does.",`, `  "program": { "L1": "def gcd(a, b):", "L2": "    if b == 0:", ... },`, `  "buggy_line_number": "L5", "buggy_line": "        return gcd(a % b, b)",`, `  "tests": [ { "input": [13, 13], "expected": 13, "actual_with_bug": "RecursionError: maximum recursion depth exceeded (unbounded recursion)", "status_with_bug": "exception" }, ... up to 3, failing tests first ],`, `  "candidates": { "cand_aa": "...", ... }   // state variant and Nouls only`, '}', '```', '', `Node-based programs (the 9 graph programs) carry \`test_source\` (the pytest function text) instead of \`input\`, with \`expected\` = the assert lines and \`actual_with_bug\` = pass / AssertionError / exception / timeout. Tests: the first three tests with failing ones first; the oracle for "plausible" is every test the gold program passes within 2 s (QuixBugs' two slow tests excluded).`);
out.push('', `**Choice question** (options \`cand_aa\`..\`cand_jt\` = candidate text, plus \`none_of_these\` = "No option is a correct fix; every option leaves the tests failing or breaks the function."):`, '', `> Which option is the corrected line that, put in place of \`buggy_line\`, makes every test in \`tests\` pass, including the tests that currently fail? Read each option literally: most options are wrong mutations of the faulty line or copies of other lines. Choose \`none_of_these\` if no option is a correct fix.`, '', `(insert mode: "Which option is the missing statement that, inserted immediately after \`buggy_line\`, makes every test in \`tests\` pass ...".)`, '', `**Noul per candidate** (one request, one Noul per candidate, candidates in \`state.candidates\`):`, '', `> Is \`candidates.cand_xx\` the corrected line: put in place of \`buggy_line\`, does it make every test in \`tests\` pass?`, '', `true: "The candidate repairs the exact mistake so the function returns \`expected\` for every test input, including the tests that currently fail, and stays correct on the tests that already pass." (examples: the operator, index or argument the bug got wrong is corrected and nothing else changes; a line equivalent to the reference implementation of this algorithm). false: "The candidate leaves the bug in place, introduces a different bug, or changes something unrelated to the failure." (examples: the faulty line unchanged; a mutation that changes the wrong operator or the wrong variable; a copy or mutation of another line of the program).`);

// ---------------------------------------------------------------- library coverage
H('## Operator library: does it generate the gold fix? (offline, no Jev)');
const cov = { first: 0, second: 0, donor: 0, none: 0 } as Record<string, number>;
for (const p of pools) cov[p.pool.fixGenerated] = (cov[p.pool.fixGenerated] ?? 0) + 1;
out.push(`Gold fix produced as a first-order mutant of the buggy line (or, for insertions, a donor/template line): **${cov['first'] + cov['donor']}/40**; reachable with two operators: ${cov['second']}/40 (mergesort \`== 0\` to \`<= 1\`, shortest_paths \`weight_by_edge[u, v]\` to \`weight_by_node[v]\`); unreachable: ${cov['none']}/40. Pool sizes after the compile filter: first-order ${Math.min(...pools.map((p) => p.pool.firstOrder))}..${Math.max(...pools.map((p) => p.pool.firstOrder))} (median ${q(pools.map((p) => p.pool.firstOrder), 0.5)}), all pools padded to 254. The operator that produced each gold fix is in the table below (offline output of \`coverage.mts\`).`);
try {
  const covMd = readFileSync('/tmp/jevonly/coverage.md', 'utf8');
  out.push('', covMd.trim());
} catch { /* coverage table optional */ }

// ---------------------------------------------------------------- A/B state shape
const ab = recs.filter((r) => r.phase === 'ab');
if (ab.length) {
  H('## A/B: candidate text in option descriptions (`desc`) vs in `state.candidates` (`state`), Choice, 50 candidates + escape, fix present');
  T(['variant', 'n', 'top-1 = fix', 'top-1 plausible (passes all tests)', 'top-3', 'MRR', 'P(fix) mean / min', 'P(escape) mean', 'escape wins', 'tokens mean', 'cost total', 'latency p50 ms'], (['desc', 'state'] as const).map((v) => { const rs = ab.filter((r) => r.variant === v); return [v, String(rs.length), pct(rs.filter((r) => r.top1IsFix).length, rs.length), pct(rs.filter((r) => r.top1Plausible).length, rs.length), pct(topK(rs, 3), rs.length), f3(mrr(rs)), `${f2(mean(rs.map((r) => r.pTrue!)))} / ${f2(Math.min(...rs.map((r) => r.pTrue!)))}`, f2(mean(rs.map((r) => r.pEscape!))), String(rs.filter((r) => r.top1IsEscape).length), String(Math.round(mean(rs.map((r) => r.inputTokens)))), usd(rs.reduce((s, r) => s + r.costUsd, 0)), String(Math.round(q(rs.map((r) => r.latencyMs), 0.5)))]; }));
  const byProg = new Map<string, Rec[]>();
  for (const r of ab) byProg.set(r.program, [...(byProg.get(r.program) ?? []), r]);
  const disagreements = [...byProg.entries()].filter(([, rs]) => rs.length === 2 && rs[0]!.top1IsFix !== rs[1]!.top1IsFix);
  out.push(`Programs where the two shapes disagree on top-1: ${disagreements.length ? disagreements.map(([p, rs]) => `${p} (desc ${rs.find((r) => r.variant === 'desc')!.top1IsFix ? 'fix' : 'miss'}, state ${rs.find((r) => r.variant === 'state')!.top1IsFix ? 'fix' : 'miss'})`).join('; ') : 'none'}.`);
}

// ---------------------------------------------------------------- main: with fix by size
const main = recs.filter((r) => r.phase === 'main' && r.method === 'choice');
const sizes = [...new Set(main.map((r) => r.size))].sort((a, b) => a - b);
const variants = [...new Set(main.map((r) => r.variant))];
for (const v of variants) {
  H(`## Choice over N candidates + escape, fix present (variant \`${v}\`)`);
  const rows: string[][] = [];
  for (const s of sizes) {
    const rs = main.filter((r) => r.variant === v && r.withFix && r.size === s);
    if (!rs.length) continue;
    const pT = rs.map((r) => r.pTrue!);
    rows.push([String(s), String(rs.length), pct(rs.filter((r) => r.top1IsFix).length, rs.length), pct(rs.filter((r) => r.top1Plausible).length, rs.length), pct(topK(rs, 3), rs.length), pct(rs.filter((r) => r.top3Plausible).length, rs.length), f3(mrr(rs)), `${f2(q(pT, 0))} / ${f2(q(pT, 0.25))} / ${f2(q(pT, 0.5))} / ${f2(q(pT, 0.75))} / ${f2(q(pT, 1))}`, `${rs.filter((r) => r.pTrue! >= 0.5).length}`, f2(mean(rs.map((r) => r.pEscape!))), String(rs.filter((r) => r.top1IsEscape).length), String(Math.round(mean(rs.map((r) => r.inputTokens)))), usd(mean(rs.map((r) => r.costUsd))), usd(rs.reduce((a, r) => a + r.costUsd, 0)), String(Math.round(q(rs.map((r) => r.latencyMs), 0.5))), String(Math.round(q(rs.map((r) => r.latencyMs), 0.95)))]);
  }
  T(['N candidates', 'n programs', 'top-1 = fix', 'top-1 plausible', 'top-3 = fix', 'top-3 plausible', 'MRR', 'P(fix) min / p25 / median / p75 / max', 'P(fix) >= 0.5', 'P(escape) mean', 'escape wins', 'tokens mean', 'cost / request', 'cost total', 'latency p50 ms', 'p95 ms'], rows);
  // by mode
  const modeRows: string[][] = [];
  for (const m of ['replace', 'insert']) for (const s of sizes) { const rs = main.filter((r) => r.variant === v && r.withFix && r.size === s && r.mode === m); if (rs.length) modeRows.push([m, String(s), String(rs.length), pct(rs.filter((r) => r.top1IsFix).length, rs.length), pct(rs.filter((r) => r.top1Plausible).length, rs.length), f3(mrr(rs)), f2(mean(rs.map((r) => r.pTrue!)))]); }
  out.push('By bug kind:', '');
  T(['kind', 'N', 'n', 'top-1 = fix', 'top-1 plausible', 'MRR', 'P(fix) mean'], modeRows);

  // no fix
  H(`## Choice, fix absent (variant \`${v}\`): does \`none_of_these\` win, does the top probability stay low?`);
  const rows2: string[][] = [];
  for (const s of sizes) {
    const rs = main.filter((r) => r.variant === v && !r.withFix && r.size === s);
    if (!rs.length) continue;
    const pE = rs.map((r) => r.pEscape!), tp = rs.map(maxNonEscape);
    rows2.push([String(s), String(rs.length), pct(rs.filter((r) => r.top1IsEscape).length, rs.length), `${f2(q(pE, 0))} / ${f2(q(pE, 0.5))} / ${f2(mean(pE))}`, `${f2(q(tp, 0.5))} / ${f2(mean(tp))} / ${f2(q(tp, 1))}`, `${rs.filter((r) => maxNonEscape(r) >= 0.5).length}`, pct(rs.filter((r) => r.top1Plausible).length, rs.length), String(Math.round(mean(rs.map((r) => r.inputTokens)))), usd(mean(rs.map((r) => r.costUsd))), String(Math.round(q(rs.map((r) => r.latencyMs), 0.5)))]);
  }
  T(['N candidates', 'n', 'escape wins', 'P(escape) min / median / mean', 'max non-escape p median / mean / max', 'max non-escape p >= 0.5', 'top-1 plausible (accidental fix in set)', 'tokens mean', 'cost / request', 'latency p50 ms'], rows2);

  // detector
  H(`## "Fix not in set" detector (variant \`${v}\`)`);
  out.push('Signals per request: `P(escape)`, the top non-escape probability `p_max`, and their difference `P(escape) - p_max`. Positive class = fix absent. Thresholds swept on the pooled with-fix and no-fix requests over all sizes; per-size rows use the pooled best threshold.', '');
  const wf = main.filter((r) => r.variant === v && r.withFix), nf = main.filter((r) => r.variant === v && !r.withFix);
  const signals: [string, (r: Rec) => number][] = [['P(escape)', (r) => r.pEscape!], ['-p_max (low top probability)', (r) => -maxNonEscape(r)], ['P(escape) - p_max', (r) => r.pEscape! - maxNonEscape(r)]];
  const detRows: string[][] = [];
  const auroc = (pos: number[], neg: number[]): number => { let s = 0; for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0; return pos.length && neg.length ? s / (pos.length * neg.length) : NaN; };
  let bestSig: [string, (r: Rec) => number, number] | null = null, bestBA = -1;
  for (const [name, fn] of signals) {
    const pos = nf.map(fn), neg = wf.map(fn);
    const cands = [...new Set([...pos, ...neg])].sort((a, b) => a - b);
    let best = { t: 0, tpr: 0, fpr: 1, ba: -1 };
    for (let i = 0; i < cands.length; i++) { const t = cands[i]!; const tpr = pos.filter((x) => x >= t).length / pos.length, fpr = neg.filter((x) => x >= t).length / neg.length; const ba = (tpr + 1 - fpr) / 2; if (ba > best.ba) best = { t, tpr, fpr, ba }; }
    if (best.ba > bestBA) { bestBA = best.ba; bestSig = [name, fn, best.t]; }
    detRows.push([name, f3(auroc(pos, neg)), name.startsWith('-') ? `p_max <= ${f2(-best.t)}` : `>= ${f2(best.t)}`, `${f2(best.tpr)} (${Math.round(best.tpr * pos.length)}/${pos.length})`, `${f2(best.fpr)} (${Math.round(best.fpr * neg.length)}/${neg.length})`, f2(best.ba)]);
  }
  T(['signal', 'AUROC', 'best threshold (flag "fix absent" when)', 'detection rate on no-fix sets', 'false alarms on with-fix sets', 'balanced accuracy'], detRows);
  if (bestSig) {
    const [name, fn, t] = bestSig;
    const perSize: string[][] = [];
    for (const s of sizes) { const p = nf.filter((r) => r.size === s), n = wf.filter((r) => r.size === s); if (p.length) perSize.push([String(s), pct(p.filter((r) => fn(r) >= t).length, p.length), pct(n.filter((r) => fn(r) >= t).length, n.length), pct(n.filter((r) => fn(r) >= t && r.top1IsFix).length, n.filter((r) => fn(r) >= t).length)]); }
    out.push(`Best signal: **${name}** at threshold ${name.startsWith('-') ? `p_max <= ${f2(-t)}` : `>= ${f2(t)}`}. Per size:`, '');
    T(['N', 'no-fix sets flagged (correct)', 'with-fix sets flagged (false alarm)', 'of the false alarms, top-1 was still the fix'], perSize);
    // operating points for P(escape)
    const pe = (r: Rec): number => r.pEscape!;
    const ops: string[][] = [];
    for (const t2 of [0.3, 0.4, 0.5, 0.6, 0.7]) ops.push([`P(escape) >= ${t2}`, pct(nf.filter((r) => pe(r) >= t2).length, nf.length), pct(wf.filter((r) => pe(r) >= t2).length, wf.length), pct(wf.filter((r) => pe(r) < t2 && r.top1IsFix).length, wf.filter((r) => pe(r) < t2).length)]);
    out.push('Operating points on `P(escape)` alone (pooled sizes):', '');
    T(['rule', 'no-fix flagged', 'with-fix flagged (false alarm)', 'precision of top-1 = fix among un-flagged with-fix sets'], ops);
  }
}

// ---------------------------------------------------------------- choice without escape (control)
const ne = recs.filter((r) => r.phase === 'noescape');
if (ne.length) {
  H('## Control: Choice without any escape option, fix present (violates the REPORT rule on purpose, to measure what the escape costs)');
  const rows: string[][] = [];
  for (const s of sizes) {
    const rs = ne.filter((r) => r.size === s), ws = main.filter((r) => r.variant === 'desc' && r.withFix && r.size === s);
    if (!rs.length) continue;
    const pT = rs.map((r) => r.pTrue!);
    rows.push([String(s), String(rs.length), pct(rs.filter((r) => r.top1IsFix).length, rs.length), pct(ws.filter((r) => r.top1IsFix).length, ws.length), pct(rs.filter((r) => r.top1Plausible).length, rs.length), pct(topK(rs, 3), rs.length), f3(mrr(rs)), f3(mrr(ws)), `${f2(q(pT, 0))} / ${f2(q(pT, 0.5))} / ${f2(mean(pT))}`, f2(mean(ws.map((r) => r.pTrue!))), String(Math.round(q(rs.map((r) => r.latencyMs), 0.5)))]);
  }
  T(['N', 'n', 'top-1 = fix (no escape)', 'top-1 = fix (with escape)', 'top-1 plausible (no escape)', 'top-3 (no escape)', 'MRR (no escape)', 'MRR (with escape)', 'P(fix) min / median / mean (no escape)', 'P(fix) mean (with escape)', 'latency p50 ms'], rows);
}

// ---------------------------------------------------------------- nouls by size and style
const noulsAll = recs.filter((r) => r.phase === 'nouls');
if (noulsAll.some((r) => r.size !== 50)) {
  H('## Batched Nouls per candidate by set size: `full` (definition + examples criteria on every Noul) vs `compact` (criteria once in `state.correct_fix_criteria`, instructions-only Nouls)');
  const rows: string[][] = [];
  for (const st of ['full', 'compact']) for (const s of sizes) {
    const rs = noulsAll.filter((r) => r.variant === st && r.withFix && r.size === s), ns = noulsAll.filter((r) => r.variant === st && !r.withFix && r.size === s);
    if (!rs.length) continue;
    const pT = rs.map((r) => r.pTrue!);
    const mx = (r: Rec): number => r.top[0]![1];
    rows.push([st, String(s), String(rs.length), pct(rs.filter((r) => r.top1IsFix).length, rs.length), pct(rs.filter((r) => r.top1Plausible).length, rs.length), pct(topK(rs, 3), rs.length), f3(mrr(rs)), `${f2(q(pT, 0))} / ${f2(q(pT, 0.5))} / ${f2(mean(pT))}`, String(rs.filter((r) => r.pTrue! >= 0.5).length), ns.length ? `${f2(q(ns.map(mx), 0.5))} / ${f2(mean(ns.map(mx)))}` : '-', ns.length ? String(ns.filter((r) => mx(r) >= 0.5).length) : '-', ns.length ? pct(ns.filter((r) => r.top1Plausible).length, ns.length) : '-', String(Math.round(mean(rs.map((r) => r.inputTokens)))), usd(mean(rs.map((r) => r.costUsd))), String(Math.round(q(rs.map((r) => r.latencyMs), 0.5))), String(Math.round(q(rs.map((r) => r.latencyMs), 0.95)))]);
  }
  T(['style', 'N', 'n', 'top-1 = fix', 'top-1 plausible', 'top-3', 'MRR', 'P(fix) min / median / mean', 'P(fix) >= 0.5', 'no-fix: max Noul median / mean', 'no-fix: sets with max >= 0.5', 'no-fix: top-1 plausible', 'tokens mean', 'cost / request', 'latency p50 ms', 'p95 ms'], rows);
  // detector per style pooled over sizes
  const det: string[][] = [];
  for (const st of ['full', 'compact']) {
    const wf = noulsAll.filter((r) => r.variant === st && r.withFix), nf = noulsAll.filter((r) => r.variant === st && !r.withFix);
    if (!wf.length || !nf.length) continue;
    const mx = (r: Rec): number => -r.top[0]![1];
    const pos = nf.map(mx), neg = wf.map(mx);
    let best = { t: 0, tpr: 0, fpr: 1, ba: -1 };
    for (const t of [...new Set([...pos, ...neg])]) { const tpr = pos.filter((x) => x >= t).length / pos.length, fpr = neg.filter((x) => x >= t).length / neg.length; const ba = (tpr + 1 - fpr) / 2; if (ba > best.ba) best = { t, tpr, fpr, ba }; }
    let sc = 0; for (const p of pos) for (const n of neg) sc += p > n ? 1 : p === n ? 0.5 : 0;
    for (const t2 of [0.3, 0.4, 0.5, 0.6]) det.push([st, `max Noul < ${t2}`, pct(nf.filter((r) => r.top[0]![1] < t2).length, nf.length), pct(wf.filter((r) => r.top[0]![1] < t2).length, wf.length), pct(wf.filter((r) => r.top[0]![1] >= t2 && r.top1IsFix).length, wf.filter((r) => r.top[0]![1] >= t2).length), f3(sc / (pos.length * neg.length))]);
    det.push([st, `best: max Noul <= ${f2(-best.t)}`, f2(best.tpr), f2(best.fpr), '-', f3(sc / (pos.length * neg.length))]);
  }
  T(['style', 'rule (flag "fix absent")', 'no-fix sets flagged', 'with-fix sets flagged (false alarm)', 'top-1 = fix among un-flagged with-fix sets', 'AUROC'], det);
  const nr = recs.filter((r) => r.phase === 'nouls-repeat');
  if (nr.length) {
    const progs2 = [...new Set(nr.map((r) => r.program))];
    const ds: number[] = []; let flips = 0;
    for (const p of progs2) { const rs = nr.filter((r) => r.program === p); if (rs.length !== 2) continue; ds.push(Math.abs(rs[0]!.pTrue! - rs[1]!.pTrue!)); if (rs[0]!.top1 !== rs[1]!.top1) flips++; }
    out.push(`Noul repeat noise (same 50-candidate request twice, fix present, n = ${ds.length}): mean |dP(fix)| ${f3(mean(ds))}, max ${f2(Math.max(...ds))}, argmax flips ${flips}/${ds.length}.`);
  }
}

// ---------------------------------------------------------------- nouls vs choice at 50
const nouls = recs.filter((r) => r.phase === 'nouls' && r.size === 50 && r.variant === 'full');
if (nouls.length) {
  H('## Choice vs batched Nouls per candidate, 50 candidates');
  const c50 = main.filter((r) => r.size === 50 && r.variant === (variants.includes('desc') ? 'desc' : variants[0]!));
  const rows: string[][] = [];
  for (const [label, rs] of [['Choice (50 + escape), fix present', c50.filter((r) => r.withFix)], ['Nouls (50 in one request), fix present', nouls.filter((r) => r.withFix)]] as [string, Rec[]][]) {
    if (!rs.length) continue;
    const pT = rs.map((r) => r.pTrue!);
    rows.push([label, String(rs.length), pct(rs.filter((r) => r.top1IsFix).length, rs.length), pct(rs.filter((r) => r.top1Plausible).length, rs.length), pct(topK(rs, 3), rs.length), f3(mrr(rs)), `${f2(q(pT, 0))} / ${f2(q(pT, 0.5))} / ${f2(mean(pT))}`, String(rs.filter((r) => r.pTrue! >= 0.5).length), String(Math.round(mean(rs.map((r) => r.inputTokens)))), usd(mean(rs.map((r) => r.costUsd))), String(Math.round(q(rs.map((r) => r.latencyMs), 0.5)))]);
  }
  T(['method', 'n', 'top-1 = fix', 'top-1 plausible', 'top-3', 'MRR', 'P(fix) min / median / mean', 'P(fix) >= 0.5', 'tokens mean', 'cost / request', 'latency p50 ms'], rows);
  const nWith = nouls.filter((r) => r.withFix), nWithout = nouls.filter((r) => !r.withFix);
  const maxN = (r: Rec): number => r.top[0]![1];
  const above = (r: Rec, t: number): number => r.top.filter(([, p]) => p >= t).length; // only top-5 stored
  const rows2: string[][] = [];
  for (const [label, rs] of [['fix present', nWith], ['fix absent', nWithout]] as [string, Rec[]][]) rows2.push([label, String(rs.length), `${f2(q(rs.map(maxN), 0))} / ${f2(q(rs.map(maxN), 0.5))} / ${f2(mean(rs.map(maxN)))} / ${f2(q(rs.map(maxN), 1))}`, String(rs.filter((r) => maxN(r) >= 0.5).length), String(rs.filter((r) => maxN(r) >= 0.3).length), f2(mean(rs.map((r) => above(r, 0.5)))), pct(rs.filter((r) => r.top1Plausible).length, rs.length)]);
  T(['Nouls, 50 candidates', 'n', 'max Noul min / median / mean / max', 'sets with max >= 0.5', 'sets with max >= 0.3', 'mean #candidates >= 0.5 (of top 5)', 'top-1 plausible'], rows2);
  const pos = nWithout.map((r) => -maxN(r)), neg = nWith.map((r) => -maxN(r));
  let best = { t: 0, tpr: 0, fpr: 1, ba: -1 };
  for (const t of [...new Set([...pos, ...neg])]) { const tpr = pos.filter((x) => x >= t).length / pos.length, fpr = neg.filter((x) => x >= t).length / neg.length; const ba = (tpr + 1 - fpr) / 2; if (ba > best.ba) best = { t, tpr, fpr, ba }; }
  let s = 0; for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  out.push(`Noul detector "fix absent when max Noul <= ${f2(-best.t)}": detection ${f2(best.tpr)}, false alarm ${f2(best.fpr)}, balanced accuracy ${f2(best.ba)}, AUROC ${f3(s / (pos.length * neg.length))}.`);
  const disagree = nWith.filter((r) => { const c = c50.find((x) => x.program === r.program && x.withFix); return c && c.top1IsFix !== r.top1IsFix; });
  out.push('', `Programs where Choice and Nouls disagree on top-1 (fix present): ${disagree.length ? disagree.map((r) => `${r.program} (Nouls ${r.top1IsFix ? 'fix' : 'miss'})`).join(', ') : 'none'}.`);
}

// ---------------------------------------------------------------- shuffle
const sh = recs.filter((r) => r.phase === 'shuffle');
if (sh.length) {
  H('## Option order: original vs reversed vs seeded shuffle (Choice, 50 + escape, fix present, 10 programs)');
  const progs = [...new Set(sh.map((r) => r.program))];
  const rows: string[][] = [];
  let flips = 0, maxD = 0;
  for (const p of progs) {
    const rs = sh.filter((r) => r.program === p);
    const byOrder = (o: string): Rec | undefined => rs.find((r) => r.order === o);
    const o = byOrder('original'), rv = byOrder('reversed'), s = byOrder('shuffled');
    if (!o || !rv || !s) continue;
    const texts = [o, rv, s].map((r) => r.top1Text ?? (r.top1IsEscape ? 'none_of_these' : '?'));
    const same = new Set(texts).size === 1;
    if (!same) flips++;
    const ps = [o, rv, s].map((r) => r.pTrue!);
    const d = Math.max(...ps) - Math.min(...ps);
    maxD = Math.max(maxD, d);
    rows.push([p, `${o.top1IsFix ? 'fix' : o.top1IsEscape ? 'escape' : 'wrong'} / ${rv.top1IsFix ? 'fix' : rv.top1IsEscape ? 'escape' : 'wrong'} / ${s.top1IsFix ? 'fix' : s.top1IsEscape ? 'escape' : 'wrong'}`, same ? 'same' : 'DIFFERENT', ps.map(f2).join(' / '), f2(d), `${o.fixKey} / ${rv.fixKey} / ${s.fixKey}`]);
  }
  T(['program', 'top-1 (original / reversed / shuffled)', 'same pick', 'P(fix) original / reversed / shuffled', 'max |dP(fix)|', 'fix key (position) per order'], rows);
  out.push(`Argmax changed with order on ${flips}/${rows.length} programs; largest P(fix) spread ${f2(maxD)}.`);
}

// ---------------------------------------------------------------- repeat
const rp = recs.filter((r) => r.phase === 'repeat');
if (rp.length) {
  H('## Repeat noise (same request twice, Choice 50 + escape, fix present)');
  const progs = [...new Set(rp.map((r) => r.program))];
  const ds: number[] = []; let flips = 0;
  for (const p of progs) { const rs = rp.filter((r) => r.program === p); if (rs.length !== 2) continue; ds.push(Math.abs(rs[0]!.pTrue! - rs[1]!.pTrue!)); if (rs[0]!.top1 !== rs[1]!.top1) flips++; }
  out.push(`n = ${ds.length} programs: mean |dP(fix)| ${f3(mean(ds))}, max ${f2(Math.max(...ds))}, argmax flips ${flips}/${ds.length}.`);
}

// ---------------------------------------------------------------- per-item rows
const v0 = variants.includes('desc') ? 'desc' : variants[0]!;
H(`## Per-program rows (variant \`${v0}\`): P(fix) and rank per set size with the fix present; P(escape) with the fix absent`);
const progs = pools.map((p) => p.program.name);
const rows: string[][] = [];
for (const p of progs) {
  const pool = pools.find((x) => x.program.name === p)!;
  const cell = (s: number): string => { const r = main.find((x) => x.variant === v0 && x.program === p && x.withFix && x.size === s); return r ? `${f2(r.pTrue!)} r${r.rankTrue}${r.top1IsFix ? '' : r.top1IsEscape ? ' ESC' : r.top1Plausible ? ' plaus' : ' X'}` : '-'; };
  const cellN = (s: number): string => { const r = main.find((x) => x.variant === v0 && x.program === p && !x.withFix && x.size === s); return r ? `${f2(r.pEscape!)}${r.top1IsEscape ? '' : r.top1Plausible ? ' plaus' : ` (${f2(maxNonEscape(r))})`}` : '-'; };
  const nl = nouls.find((x) => x.program === p && x.withFix);
  const nl254 = noulsAll.find((x) => x.program === p && x.withFix && x.size === 254 && x.variant === 'full');
  rows.push([p, pool.program.mode, pool.pool.fixGenerated, ...sizes.map(cell), ...sizes.map(cellN), nl ? `${f2(nl.pTrue!)} r${nl.rankTrue} max ${f2(nl.top[0]![1])}` : '-', nl254 ? `${f2(nl254.pTrue!)} r${nl254.rankTrue} max ${f2(nl254.top[0]![1])}` : '-']);
}
T(['program', 'kind', 'fix generated', ...sizes.map((s) => `fix, N=${s}`), ...sizes.map((s) => `no fix, N=${s}: P(esc)`), 'Nouls N=50: P(fix), rank, max', 'Nouls N=254: P(fix), rank, max'], rows);
out.push('Cell legend: with fix, `P(fix) r<rank>` and a flag when top-1 is not the fix (`ESC` escape won, `plaus` a different candidate that passes every test won, `X` a wrong candidate won). Without fix, `P(escape)` and, when escape did not win, the winning probability in parentheses (`plaus` = the set accidentally contained another correct fix and Jev picked it).');

// ---------------------------------------------------------------- rerank
const rr = recs.filter((r) => r.phase === 'rerank');
if (rr.length) {
  H('## Two-stage: batched Nouls over 254, then Choice (+ escape) over the five highest Nouls');
  const wf = rr.filter((r) => r.withFix), nf = rr.filter((r) => !r.withFix);
  T(['condition', 'n', 'fix in shortlist', 'top-1 = fix', 'top-1 plausible', 'escape wins', 'P(fix) median (when shortlisted)', 'cost / request', 'latency p50 ms'], [
    ['fix present', String(wf.length), `${wf.filter((r) => r.fixKey !== null).length}/${wf.length}`, pct(wf.filter((r) => r.top1IsFix).length, wf.length), pct(wf.filter((r) => r.top1Plausible).length, wf.length), String(wf.filter((r) => r.top1IsEscape).length), f2(q(wf.filter((r) => r.pTrue !== null).map((r) => r.pTrue!), 0.5)), usd(mean(wf.map((r) => r.costUsd))), String(Math.round(q(wf.map((r) => r.latencyMs), 0.5)))],
    ['fix absent', String(nf.length), '-', '-', pct(nf.filter((r) => r.top1Plausible).length, nf.length) + ' (accidental fix in shortlist)', `${nf.filter((r) => r.top1IsEscape).length} (${Math.round((100 * nf.filter((r) => r.top1IsEscape).length) / nf.length)}%)`, '-', usd(mean(nf.map((r) => r.costUsd))), String(Math.round(q(nf.map((r) => r.latencyMs), 0.5)))],
  ]);
  const flat = recs.filter((r) => r.phase === 'nouls' && r.variant === 'full' && r.size === 254 && r.withFix);
  const choice254 = recs.filter((r) => r.phase === 'main' && r.variant === 'desc' && r.size === 254 && r.withFix);
  out.push(`Against the same 254-candidate sets: flat Nouls top-1 ${flat.filter((r) => r.top1IsFix).length}/40, flat Choice ${choice254.filter((r) => r.top1IsFix).length}/40, two-stage ${wf.filter((r) => r.top1IsFix).length}/40. Misses after the second stage: ${wf.filter((r) => !r.top1IsFix).map((r) => `${r.program}${r.fixKey === null ? ' (not shortlisted)' : r.top1Plausible ? ' (plausible alternative)' : ''}`).join(', ')}.`);
}

// ---------------------------------------------------------------- design
H('## What this means for the design');
out.push(
  '1. **Rank candidates with batched Nouls, not a flat Choice, once there are more than about 10 of them.** Choice top-1 falls 90% -> 65% from 10 to 254 candidates and the fall is not caused by the escape option (the no-escape control is identical). One request with one Noul per candidate holds 98% top-1 to 50 candidates and 78-88% at 150-254, with top-3 at 98%, because each Noul is an absolute judgment ("does this line make the tests pass") rather than a relative one over hundreds of near-duplicate lines. The whole 254-Noul request is one call, 0.55 s, $0.0024 (compact form: 0.33 s, $0.0008, same top-1 at 254, 2-5 points lower at 50-150).',
  '2. **Use the tests as the oracle on the Noul top-k, and expect about three test runs per fix.** Top-3 by Nouls contains the gold fix on 39/40 programs at every size, and the top-1 that is not the gold line is often another correct fix (top-1 plausible 85-100%). The repair loop is: enumerate (code) -> compile-filter (code) -> Nouls over up to 254 (one Jev call) -> run tests on the top 3 in order -> stop at the first pass. On QuixBugs that projects to roughly 36-38/40 repaired with the current operator library, under $0.01 and a few seconds per program, against the brief\'s >= 60% target.',
  '3. **A second Jev stage buys a little: Nouls (254) -> Choice over the Noul top-5 lifts top-1 from 31 to 33/40** at one extra $0.0001 request, and its escape option is a usable second-stage "none of the shortlisted" signal (escape wins 26/40 when the fix is absent, and 7 of the remaining 14 shortlists contained a different correct fix). Prefer spending the same 0.2 s on a test run of the next candidate unless tests are slow.',
  '4. **"Fix not in set" is detectable but not sharp; treat it as a routing signal, not a verdict.** Best single-request rules: Choice `P(escape) - p_max >= 0.10` (82% detection, 13% false alarm, AUROC 0.92; detection 98% at N = 10 falling to 73% at 254) and Nouls `max Noul < 0.5` (71-75% detection, 16-21% false alarm). Do not threshold `P(escape)` at 0.5 alone at large N (77% / 9%); `P(escape) >= 0.7` is almost never a false alarm (1%) but only catches half. Since a false alarm costs one wasted round of "widen the candidate source" and a miss costs three failed test runs, bias toward flagging; both are cheap. Note that at N >= 150 the label itself is noisy: 13-23% of sets built without the gold line still held another correct fix.',
  '5. **Keep the set small when you can.** Every method loses accuracy and P(fix) with N (Choice P(fix) median 0.93 -> 0.55; Nouls 0.82 -> 0.77 median but MRR 0.99 -> 0.86). Localisation to one line and operator priors (the gold fix is a first-order mutant on 38/40 programs, second-order on 40/40) should be used to stay near 50 candidates; when the pool is larger, batch it as several 50-Noul requests in parallel (Jev allows 128-way concurrency) rather than one 254-Choice.',
  '6. **Order effects are real only at ties.** Reversing or shuffling 50 options flipped the argmax on 1/10 programs (0.29 vs 0.30) and moved P(fix) by up to 0.33 where the answer was borderline, against a repeat noise of 0.03 mean; on confident items order changed nothing. When the top-2 margin is under 0.1, re-ask with a shuffled order (or fall through to the tests) instead of trusting the pick.',
  '7. **Missing-statement bugs need their own candidate source.** The four insertion programs are the weak spot for Choice (top-1 3/4, 3/4, 1/4, 2/4 across sizes) and Nouls at 254 (wrap 0.35, shunting_yard 0.33). Donor lines plus `a.add(b)` / `a.append(b)` / `a = b` templates did generate all four gold statements, but the sets are noisier; give insertions a smaller, template-first pool.',
  '8. **The hard programs are consistent across methods and sizes**: next_palindrome, topological_ordering, sqrt, minimum_spanning_tree, lcs_length, wrap (P(fix) <= 0.35 nearly everywhere). They share long lines with several plausible single-token variants (`- 1` placements, attribute names, `** 2`), where the three tests in the state do not discriminate visually. These are the cases for the test oracle, not for a sharper prompt; adding a fourth failing test whose expected/actual pair differs on the exact quantity the fix changes is the next thing to measure.',
  '9. **State shape**: candidate text in the option descriptions (`desc`) and in `state.candidates` with null descriptions (`state`) are equivalent (28 vs 29/40 at N = 50; 3 programs disagree in each direction); `desc` is 8% cheaper. For Nouls the candidates must live in the state and be referenced by path (`candidates.cand_xx`), which worked at 254 entries with no sign of reference drift.',
);

writeFileSync(`${RESULTS}/probe-selection.md`, out.join('\n') + '\n');
console.log(`wrote ${RESULTS}/probe-selection.md (${recs.length} records, ${usd(totalCost)})`);
