/**
 * Render experiments/results/prototype-baseline.jsonl into the generated section of
 * experiments/results/prototype-baseline.md (between the generated markers; hand-written text
 * outside the markers is preserved).
 * Usage: node node_modules/.bin/tsx experiments/prototype/report.mts [--in <jsonl>] [--out <md>]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ProgramResult } from './loop.mts';

function arg(name: string, def: string): string { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? (process.argv[i + 1] ?? def) : def; }
const inPath = arg('in', 'experiments/results/prototype-baseline.jsonl');
const outPath = arg('out', 'experiments/results/prototype-baseline.md');

const rows = readFileSync(inPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ProgramResult).sort((a, b) => a.name.localeCompare(b.name));
const n = rows.length;
const yn = (b: boolean | null | undefined): string => (b === null || b === undefined ? '-' : b ? 'Y' : 'n');
const num = (x: number | null | undefined, d = 0): string => (x === null || x === undefined ? '-' : x.toFixed(d));
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

const lines: string[] = [];
lines.push('### Per-program results', '');
lines.push('| program | tests | repaired | round | win rank (global / in line) | true line loc rank (p) | fix in cands (enum pos) | fix Jev rank in line (p) | cands ranked | test runs | Jev req | cost | wall | failure / notes |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  const win = r.repaired ? `${r.winRankGlobal} / ${r.winRankInLine}${r.winIsTruth === false ? ' (alt fix)' : ''}` : '-';
  const loc = r.locRank !== null && r.locRank !== undefined ? `${r.locRank} (${num(r.locProbTrue, 2)})` : (r.truthKind === 'replace' ? '-' : `n/a (${r.truthKind})`);
  const cov = r.truthKind === 'replace' ? `${yn(r.coverage)}${r.coverage ? ` (${r.fixEnumPos}/${r.nCandidatesTruthLine})` : ` (0/${r.nCandidatesTruthLine ?? 0})`}` : `n/a (${r.truthKind})`;
  const fj = r.fixJevRankInLine !== null && r.fixJevRankInLine !== undefined ? `${r.fixJevRankInLine} (${num(r.fixJevProb, 2)})` : (r.truthLineRanked ? 'not in set' : '-');
  const notes = [r.failure ?? '', r.budgetStop ? `stop=${r.budgetStop}` : '', ...(r.notes ?? []).filter((x) => x.startsWith('r') || x.startsWith('true fix') || x.startsWith('dropped') || x.startsWith('exception') || x.startsWith('baseline'))].filter(Boolean).join('; ').replace(/\|/g, '\\|');
  lines.push(`| ${r.name} | ${r.kind}${r.totalTests ? ` ${r.totalTests}` : ''} | ${r.repaired ? '**Y**' : 'n'} | ${r.round ?? '-'} | ${win} | ${loc} | ${cov} | ${fj} | ${r.nCandidates ?? '-'} | ${r.testRuns ?? '-'} | ${r.jevRequests ?? '-'} | $${num(r.costUsd, 4)} | ${num((r.wallMs ?? 0) / 1000, 0)} s | ${notes} |`);
}
lines.push('');

const rep = rows.filter((r) => r.repaired);
const replaceable = rows.filter((r) => r.truthKind === 'replace');
const covered = replaceable.filter((r) => r.coverage);
const withLoc = rows.filter((r) => r.locRank !== null && r.locRank !== undefined);
const locTop = (k: number): number => withLoc.filter((r) => (r.locRank ?? 99) <= k).length;
const ranked = rows.filter((r) => r.truthLineRanked && r.fixJevRankInLine !== null && r.fixJevRankInLine !== undefined);
const fixTop = (k: number): number => ranked.filter((r) => (r.fixJevRankInLine ?? 99) <= k).length;
const byRound: Record<string, number> = {};
for (const r of rep) byRound[String(r.round)] = (byRound[String(r.round)] ?? 0) + 1;
const fail: Record<string, number> = {};
for (const r of rows.filter((r) => !r.repaired)) fail[r.failure ?? 'unknown'] = (fail[r.failure ?? 'unknown'] ?? 0) + 1;
const budget: Record<string, number> = {};
for (const r of rows.filter((r) => r.budgetStop)) budget[r.budgetStop!] = (budget[r.budgetStop!] ?? 0) + 1;

lines.push('### Totals', '');
lines.push('| Measurement | Result |', '| --- | --- |');
lines.push(`| Programs | ${n} (${rows.filter((r) => r.kind === 'json').length} JSON-tested, ${rows.filter((r) => r.kind === 'pytest').length} pytest graph programs) |`);
lines.push(`| Repaired end to end (tests as the only oracle) | **${rep.length}/${n} = ${(100 * rep.length / n).toFixed(0)} %** |`);
lines.push(`| Repaired, by round | ${Object.entries(byRound).sort().map(([k, v]) => `round ${k}: ${v}`).join(', ') || '-'} |`);
lines.push(`| Repaired with a line other than the reference fix (tests pass anyway) | ${rep.filter((r) => r.winIsTruth === false).length} |`);
lines.push(`| Coverage: reference fix line in the candidate set of the true line (cap ${200}) | ${covered.length}/${replaceable.length} replaceable = ${(100 * covered.length / Math.max(1, replaceable.length)).toFixed(0)} %; ${covered.length}/${n} of all (${n - replaceable.length} need a line insertion) |`);
lines.push(`| Candidates at the true line, median (min–max) | ${median(replaceable.map((r) => r.nCandidatesTruthLine))} (${Math.min(...replaceable.map((r) => r.nCandidatesTruthLine))}–${Math.max(...replaceable.map((r) => r.nCandidatesTruthLine))}) |`);
lines.push(`| Localisation of the true line (Choice over lines, round 1): top-1 / top-3 / top-5 | ${locTop(1)} / ${locTop(3)} / ${locTop(5)} of ${withLoc.length} |`);
lines.push(`| Selection when the true line was ranked and the fix was in its set: fix at Jev rank 1 / ≤ 3 / ≤ 5 | ${fixTop(1)} / ${fixTop(3)} / ${fixTop(5)} of ${ranked.length} |`);
lines.push(`| Winning candidate global rank (repaired), median (max) | ${median(rep.map((r) => r.winRankGlobal ?? 0))} (${Math.max(0, ...rep.map((r) => r.winRankGlobal ?? 0))}) |`);
lines.push(`| Test runs per program, mean (max) | ${mean(rows.map((r) => r.testRuns ?? 0)).toFixed(1)} (${Math.max(...rows.map((r) => r.testRuns ?? 0))}) |`);
lines.push(`| Jev requests per program, mean (max) | ${mean(rows.map((r) => r.jevRequests ?? 0)).toFixed(1)} (${Math.max(...rows.map((r) => r.jevRequests ?? 0))}); total ${rows.reduce((a, r) => a + (r.jevRequests ?? 0), 0)} |`);
lines.push(`| Cost per program, mean (max); total | $${mean(rows.map((r) => r.costUsd ?? 0)).toFixed(5)} ($${Math.max(...rows.map((r) => r.costUsd ?? 0)).toFixed(5)}); $${rows.reduce((a, r) => a + (r.costUsd ?? 0), 0).toFixed(4)} |`);
lines.push(`| Wall time per program, mean / median (max) | ${(mean(rows.map((r) => r.wallMs ?? 0)) / 1000).toFixed(1)} s / ${(median(rows.map((r) => r.wallMs ?? 0)) / 1000).toFixed(1)} s (${(Math.max(...rows.map((r) => r.wallMs ?? 0)) / 1000).toFixed(0)} s) |`);
lines.push(`| Jev latency p50 (per-program medians, median) | ${median(rows.map((r) => r.jevP50Ms ?? 0)).toFixed(0)} ms |`);
lines.push(`| Budget stops | ${Object.entries(budget).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'} |`);
lines.push('');
lines.push('### Failure taxonomy (not repaired)', '');
lines.push('| Category | Count | Programs |', '| --- | --- | --- |');
for (const [k, v] of Object.entries(fail).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} | ${rows.filter((r) => !r.repaired && (r.failure ?? 'unknown') === k).map((r) => r.name).join(', ')} |`);
lines.push('');

const START = '<!-- generated:start -->', END = '<!-- generated:end -->';
const generated = `${START}\n${lines.join('\n')}\n${END}`;
let doc: string;
if (existsSync(outPath) && readFileSync(outPath, 'utf8').includes(START)) {
  const cur = readFileSync(outPath, 'utf8');
  doc = cur.slice(0, cur.indexOf(START)) + generated + cur.slice(cur.indexOf(END) + END.length);
} else {
  doc = `# Prototype baseline: Jev-only repair loop on QuixBugs Python\n\n${generated}\n`;
}
writeFileSync(outPath, doc);
console.log(`wrote ${outPath}: ${n} programs, ${rep.length} repaired`);
