/**
 * Contrarian measurement: what does exhaustive test verification cost on QuixBugs, and how many
 * test-passing ("plausible") candidates does each program admit? No Jev is called.
 *
 *   --scope truth   enumerate every compiling first-order mutant of the TRUE buggy line and run the
 *                   full test suite on each (ranking-free ceiling for a perfectly localised line)
 *   --scope all     the same for EVERY code line of the program except `def` lines (no localisation
 *                   at all: the brute-force baseline the design has to beat)
 *   --concurrency N candidates verified in parallel (default 8)
 *   --cap N         per-line candidate cap (default 100000 = uncapped)
 *   --only a,b      subset of programs
 *   --timeout S     per-test timeout in seconds handed to run_tests.py (default 2)
 *   --tag X         suffix for the output file name
 *
 * Output: one JSON line per program to experiments/results/contrarian-exhaustive.<scope>.jsonl
 * (plausible candidate texts included so a follow-up Jev probe can rank them).
 *
 * Run: node node_modules/.bin/tsx experiments/contrarian/exhaustive.mts --scope truth
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { applyReplacement, listPrograms, loadProgram, normLine, type QuixProgram } from '../prototype/quixbugs.mts';
import { buildContext, enumerateCandidates, filterSyntactic } from '../prototype/mutations.mts';
import { runTests, type TestRunResult } from '../prototype/verify.mts';

function arg(name: string, dflt: string): string { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : dflt; }
const SCOPE = arg('--scope', 'truth') as 'truth' | 'all';
const CONC = Number(arg('--concurrency', '8'));
const CAP = Number(arg('--cap', '100000'));
const TIMEOUT_S = Number(arg('--timeout', '2'));
const ONLY = arg('--only', '').split(',').filter(Boolean);
const TAG = arg('--tag', '');
const OUT = fileURLToPath(new URL(`../results/contrarian-exhaustive.${SCOPE}${TAG}.jsonl`, import.meta.url));
const RESUME = process.argv.includes('--resume');

interface CandRun { line: number; text: string; op: string; passed: number; total: number; passedAll: boolean; ms: number; runnerError: string | null; timedOut: boolean }
interface Row {
  name: string; kind: string; truthKind: string; scope: string; timeoutS: number; concurrency: number; cap: number;
  nLines: number; linesTried: number; baselinePassed: number; totalTests: number;
  nCandidates: number; nRuns: number; nPlausible: number; plausibleLines: number;
  goldInSet: boolean; goldPlausible: boolean; goldEnumPos: number | null;
  nPartial: number; nRegress: number; nNoChange: number; nRunnerError: number; nTimeout: number;
  wallMs: number; runMsP50: number; runMsMean: number; runMsMax: number; cpuSecondsEstimate: number;
  plausible: { line: number; text: string; op: string; isGold: boolean }[];
}

function p50(xs: number[]): number { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; }

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!, i); }
  }));
  return out;
}

async function measure(p: QuixProgram): Promise<Row> {
  const t0 = performance.now();
  const base: TestRunResult = await runTests(p, p.buggySource, { perTestTimeoutS: TIMEOUT_S, hardTimeoutMs: 30_000 });
  const truthIdx = p.truth.buggyLineIndex;
  const lineIdxs = SCOPE === 'truth'
    ? (p.truth.kind === 'replace' ? [truthIdx] : [])
    : p.codeLineIndices.filter((i) => !/^\s*def\s/.test(p.buggyLines[i]!));
  const fixNorm = p.truth.fixedLine ? normLine(p.truth.fixedLine) : null;
  const work: { line: number; text: string; op: string }[] = [];
  let goldEnumPos: number | null = null;
  for (const li of lineIdxs) {
    const ctx = buildContext(p, p.buggyLines, li);
    const cands = filterSyntactic(ctx, enumerateCandidates(ctx, CAP));
    const orig = normLine(p.buggyLines[li]!);
    for (const c of cands) {
      if (normLine(c.text) === orig) continue; // never re-test the unchanged line
      if (li === truthIdx && fixNorm !== null && goldEnumPos === null && normLine(c.text) === fixNorm) goldEnumPos = work.length + 1;
      work.push({ line: li, text: c.text, op: c.op });
    }
  }
  const runs: CandRun[] = await pool(work, CONC, async (w) => {
    const src = applyReplacement(p.buggyLines, w.line, w.text);
    let r: TestRunResult;
    try { r = await runTests(p, src, { perTestTimeoutS: TIMEOUT_S, hardTimeoutMs: 30_000 }); }
    catch (e) { r = { kind: p.kind, total: 0, passed: 0, skipped: 0, failures: [], firstFailure: null, passedAll: false, durationMs: 0, runnerError: `harness: ${(e as Error).message.slice(0, 120)}`, rawSummary: null }; }
    const timedOut = r.runnerError !== null && /killed/.test(r.runnerError);
    return { line: w.line, text: w.text, op: w.op, passed: r.passed, total: r.total, passedAll: r.passedAll && r.runnerError === null, ms: r.durationMs, runnerError: r.runnerError, timedOut };
  });
  const wallMs = Math.round(performance.now() - t0);
  const plausible = runs.filter((r) => r.passedAll);
  const goldPlausible = fixNorm !== null && plausible.some((r) => r.line === truthIdx && normLine(r.text) === fixNorm);
  const ms = runs.map((r) => r.ms);
  return {
    name: p.name, kind: p.kind, truthKind: p.truth.kind, scope: SCOPE, timeoutS: TIMEOUT_S, concurrency: CONC, cap: CAP,
    nLines: p.codeLineIndices.length, linesTried: lineIdxs.length, baselinePassed: base.passed, totalTests: base.total,
    nCandidates: work.length, nRuns: runs.length, nPlausible: plausible.length, plausibleLines: new Set(plausible.map((r) => r.line)).size,
    goldInSet: goldEnumPos !== null, goldPlausible, goldEnumPos,
    nPartial: runs.filter((r) => !r.passedAll && r.passed > base.passed).length,
    nRegress: runs.filter((r) => r.passed < base.passed).length,
    nNoChange: runs.filter((r) => !r.passedAll && r.passed === base.passed).length,
    nRunnerError: runs.filter((r) => r.runnerError !== null && !r.timedOut).length,
    nTimeout: runs.filter((r) => r.timedOut).length,
    wallMs, runMsP50: p50(ms), runMsMean: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0, runMsMax: Math.max(0, ...ms),
    cpuSecondsEstimate: Math.round(ms.reduce((a, b) => a + b, 0) / 1000),
    plausible: plausible.map((r) => ({ line: r.line, text: r.text, op: r.op, isGold: fixNorm !== null && r.line === truthIdx && normLine(r.text) === fixNorm })),
  };
}

async function main(): Promise<void> {
  mkdirSync(fileURLToPath(new URL('../results/', import.meta.url)), { recursive: true });
  const done = new Set<string>();
  if (RESUME && existsSync(OUT)) for (const l of readFileSync(OUT, 'utf8').split('\n').filter(Boolean)) done.add((JSON.parse(l) as Row).name);
  else if (!RESUME) writeFileSync(OUT, '');
  const names = listPrograms().filter((n) => (ONLY.length === 0 || ONLY.includes(n)) && !done.has(n));
  const T0 = performance.now();
  for (const name of names) {
    const p = loadProgram(name);
    const row = await measure(p);
    appendFileSync(OUT, JSON.stringify(row) + '\n');
    console.log(`${name.padEnd(28)} lines ${String(row.linesTried).padStart(2)} cands ${String(row.nCandidates).padStart(5)} plausible ${String(row.nPlausible).padStart(3)} (lines ${row.plausibleLines}) gold ${row.goldInSet ? (row.goldPlausible ? 'PASS' : 'in-set-FAIL') : 'absent'} partial ${row.nPartial} to ${row.nTimeout} wall ${(row.wallMs / 1000).toFixed(1)}s run p50 ${row.runMsP50}ms`);
  }
  console.log(`total wall ${((performance.now() - T0) / 1000).toFixed(0)} s -> ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
