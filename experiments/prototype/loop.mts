/**
 * Jev-only repair loop on QuixBugs (no generating LLM). Code proposes (mutation operators), Jev
 * decides (localisation Choice, per-line ranking Choice), tests verify. Progress is computed in
 * code (strictly more tests pass), never asked of Jev.
 *
 * Usage: env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/tsx experiments/prototype/loop.mts
 *          [--only a,b] [--limit n] [--concurrency 3] [--out experiments/results/prototype-baseline.jsonl] [--resume] [--cap 1.4]
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { choice } from '../../src/jev/questions.ts';
import type { Json } from '../../src/core/types.ts';
import { applyReplacement, isCodeLine, listPrograms, loadProgram, normLine, type QuixProgram } from './quixbugs.mts';
import { buildContext, enumerateCandidates, filterSyntactic, type Candidate } from './mutations.mts';
import { runTests, type TestRunResult } from './verify.mts';
import { createJev, SpendCapError, type Jev } from './jev.mts';

// ---------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------

export interface LoopConfig {
  topLines: number;      // lines ranked in the first beam (3)
  widenLines: number;    // lines ranked after the first k verifications fail (5)
  k: number;             // candidates verified before widening (5)
  candidateCap: number;  // per line (200)
  maxRounds: number;     // progress rounds (3)
  maxTestRuns: number;   // per program (40)
  maxJevRequests: number;// per program (30)
  wallMs: number;        // per program (180 s)
  stateTests: number;    // tests shown to Jev (3)
}
export const DEFAULT_CONFIG: LoopConfig = { topLines: 3, widenLines: 5, k: 5, candidateCap: 200, maxRounds: 3, maxTestRuns: 40, maxJevRequests: 30, wallMs: 180_000, stateTests: 3 };

export type FailureCategory = 'fix_not_in_candidates' | 'localisation_missed' | 'ranking_missed' | 'runner_issue';

export interface ProgramResult {
  name: string; kind: 'json' | 'pytest'; truthKind: string;
  repaired: boolean; round: number | null; roundsRun: number;
  winRankGlobal: number | null; winRankInLine: number | null; winLineRank: number | null; winProb: number | null; winningLine: string | null; winningText: string | null;
  winIsTruth: boolean | null;
  locRank: number | null; locProbTrue: number | null; locTop: [string, number][];
  coverage: boolean; nCandidatesTruthLine: number; fixEnumPos: number | null;
  truthLineRanked: boolean; fixJevRankInLine: number | null; fixJevProb: number | null; fixGlobalRank: number | null; fixVerified: boolean;
  nCandidates: number; nLines: number; totalTests: number; droppedTests: number; baselinePassed: number;
  testRuns: number; jevRequests: number; costUsd: number; wallMs: number; jevP50Ms: number;
  budgetStop: string | null; failure: FailureCategory | null; notes: string[];
}

interface Budget { testRuns: number; jev: number; t0: number; cost: number; lats: number[] }

function budgetStop(b: Budget, cfg: LoopConfig, needJev = 1, needTests = 1): string | null {
  if (performance.now() - b.t0 >= cfg.wallMs) return 'wall_time';
  if (b.jev + needJev > cfg.maxJevRequests) return 'jev_requests';
  if (b.testRuns + needTests > cfg.maxTestRuns) return 'test_runs';
  return null;
}

// ---------------------------------------------------------------------------------------
// State construction (what Jev sees)
// ---------------------------------------------------------------------------------------

function programView(lines: string[]): Record<string, Json> {
  const out: Record<string, Json> = {};
  lines.forEach((l, i) => { if (isCodeLine(l)) out[`L${i + 1}`] = l; });
  return out;
}

/** Split a pytest file into module preamble (setup code) and named test functions. */
function pytestParts(src: string): { setup: string; tests: { id: string; source: string }[] } {
  const body = src.replace(/^(import|from) .*\n/gm, '');
  const parts = body.split(/^(?=def test\w*\()/m);
  const setup = (parts[0] ?? '').trim();
  const tests = parts.slice(1).map((t) => ({ id: /^def (test\w*)\(/.exec(t)![1]!, source: t.trim() }));
  return { setup, tests };
}

function pickThree<T extends { id: string }>(all: T[], failingId: string | null, n: number): T[] {
  const fi = all.findIndex((t) => t.id === failingId);
  const chosen = new Set<number>();
  if (fi >= 0) chosen.add(fi);
  for (let i = 0; i < all.length && chosen.size < n; i++) chosen.add(i);
  return [...chosen].sort((a, b) => a - b).map((i) => all[i]!);
}

function buildState(p: QuixProgram, lines: string[], base: TestRunResult): Record<string, Json> {
  const task = `The Python function \`${p.name}\` in \`program\` has a single-line bug that makes some tests fail. Line ids (L1, L2, …) are the line numbers of the file.`;
  const state: Record<string, Json> = { task, program: programView(lines) };
  const failId = base.firstFailure?.id ?? null;
  if (p.kind === 'json' && p.tests) {
    const idx = p.tests.map((_, i) => i).filter((i) => !(p.testMeta?.[i]?.slow));
    const all = idx.map((i) => ({ id: `t${i}`, input: p.tests![i]![0], expected: p.tests![i]![1] }));
    state['tests'] = pickThree(all, failId, DEFAULT_CONFIG.stateTests).map((t) => ({ id: t.id, input: t.input, expected: t.expected }));
    const f = base.firstFailure;
    state['actual_output'] = f ? { test: f.id, input: f.input ?? null, expected: f.expected ?? null, actual: f.actual } : 'all tests pass';
  } else {
    const { setup, tests } = pytestParts(p.pytestSource);
    state['tests'] = pickThree(tests, failId, DEFAULT_CONFIG.stateTests).map((t) => ({ id: t.id, source: t.source }));
    if (setup) state['tests_setup'] = setup;
    if (p.nodeSource) state['node_class'] = p.nodeSource;
    const f = base.firstFailure;
    state['actual_output'] = f ? { test: f.id, detail: f.actual, pytest_summary: (base.rawSummary ?? '').slice(0, 800) } : 'all tests pass';
  }
  return state;
}

const LOC_Q = 'The function in `program` fails some of `tests`; `actual_output` is what the buggy program produced on the failing test. Which single line of `program` contains the bug? Pick the line whose text must change to make all tests pass. Pick `none_of_these` only if the fix requires adding a new line rather than changing an existing one.';
const RANK_Q = '`buggy_line` is the suspected faulty line of `program`. Each entry of `candidates` is a possible replacement for that line. Which candidate is the replacement that makes every test in `tests` pass, including the failing one shown in `actual_output`? Judge by the semantics of the program and the expected outputs. Pick `none_of_these` if no candidate is a correct fix.';

// ---------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------

interface RankedCandidate { lineIndex: number; lineRank: number; lineProb: number; cand: Candidate; prob: number; rankInLine: number; key: string }

function candKey(i: number): string { return `candidate_${String(i + 1).padStart(3, '0')}`; }

export async function repairProgram(p: QuixProgram, jev: Jev, cfg: LoopConfig = DEFAULT_CONFIG, log: (s: string) => void = () => undefined): Promise<ProgramResult> {
  const b: Budget = { testRuns: 0, jev: 0, t0: performance.now(), cost: 0, lats: [] };
  const notes: string[] = [];
  const truth = p.truth;
  const R: ProgramResult = {
    name: p.name, kind: p.kind, truthKind: truth.kind, repaired: false, round: null, roundsRun: 0,
    winRankGlobal: null, winRankInLine: null, winLineRank: null, winProb: null, winningLine: null, winningText: null, winIsTruth: null,
    locRank: null, locProbTrue: null, locTop: [], coverage: false, nCandidatesTruthLine: 0, fixEnumPos: null,
    truthLineRanked: false, fixJevRankInLine: null, fixJevProb: null, fixGlobalRank: null, fixVerified: false,
    nCandidates: 0, nLines: p.codeLineIndices.length, totalTests: 0, droppedTests: 0, baselinePassed: 0,
    testRuns: 0, jevRequests: 0, costUsd: 0, wallMs: 0, jevP50Ms: 0, budgetStop: null, failure: null, notes,
  };
  const fixNorm = truth.fixedLine !== null ? normLine(truth.fixedLine) : null;
  const isFix = (lineIndex: number, text: string): boolean => truth.kind === 'replace' && lineIndex === truth.buggyLineIndex && fixNorm !== null && normLine(text) === fixNorm;

  // Coverage (measurement only; Jev never sees the correct program).
  if (truth.kind === 'replace') {
    const ctx = buildContext(p, p.buggyLines, truth.buggyLineIndex);
    const cands = filterSyntactic(ctx, enumerateCandidates(ctx, cfg.candidateCap));
    R.nCandidatesTruthLine = cands.length;
    const pos = cands.findIndex((c) => normLine(c.text) === fixNorm);
    R.fixEnumPos = pos >= 0 ? pos + 1 : null;
    R.coverage = pos >= 0;
  }

  const src = (lines: string[]): string => lines.join('\n') + '\n';
  let lines = p.buggyLines.slice();
  const runOpts = {};
  let base = await runTests(p, src(lines), runOpts); b.testRuns += 1;
  R.totalTests = base.total; R.baselinePassed = base.passed; R.droppedTests = base.skipped;
  if (base.runnerError) { R.failure = 'runner_issue'; notes.push(`baseline runner error: ${base.runnerError.slice(0, 160)}`); return finish(); }
  if (base.passedAll) { R.failure = 'runner_issue'; notes.push('buggy program passes every test: nothing to repair'); return finish(); }
  const tried = new Set<string>([src(lines)]);

  function finish(): ProgramResult {
    R.testRuns = b.testRuns; R.jevRequests = b.jev; R.costUsd = b.cost; R.wallMs = Math.round(performance.now() - b.t0);
    R.jevP50Ms = b.lats.length ? [...b.lats].sort((x, y) => x - y)[Math.floor(b.lats.length / 2)]! : 0;
    if (!R.repaired && R.failure === null) {
      if (R.fixVerified) R.failure = 'runner_issue';
      else if (!R.coverage) R.failure = 'fix_not_in_candidates';
      else if (!R.truthLineRanked) R.failure = 'localisation_missed';
      else R.failure = 'ranking_missed';
    }
    return R;
  }

  const rankedTexts = new Set<string>();

  for (let round = 1; round <= cfg.maxRounds; round++) {
    R.roundsRun = round;
    let stop = budgetStop(b, cfg, 1, 1); if (stop) { R.budgetStop = stop; break; }
    // 1. Localise
    const state = buildState(p, lines, base);
    const lineOpts: Record<string, Json> = {};
    lines.forEach((l, i) => { if (isCodeLine(l)) lineOpts[`line_${i + 1}`] = l; });
    const r1 = await jev.ask(state, { buggy_line: choice(LOC_Q, lineOpts) }, 'context'); b.jev += 1; b.cost += r1.usage.costUsd; b.lats.push(r1.latencyMs);
    const a1 = r1.answers['buggy_line']!;
    if (a1.type !== 'choice') { notes.push('localisation answer not a choice'); break; }
    const ranking = Object.entries(a1.probabilities).filter(([k]) => k.startsWith('line_')).sort((x, y) => y[1] - x[1])
      .map(([k, prob], i) => ({ lineIndex: Number(k.slice(5)) - 1, prob, rank: i + 1 }));
    if (round === 1) {
      R.locTop = ranking.slice(0, 3).map((x) => [`L${x.lineIndex + 1}`, Number(x.prob.toFixed(3))]);
      const t = ranking.find((x) => x.lineIndex === truth.buggyLineIndex);
      R.locRank = t ? t.rank : null; R.locProbTrue = t ? Number(t.prob.toFixed(3)) : null;
      notes.push(`loc none_of_these=${(a1.probabilities['none_of_these'] ?? 0).toFixed(2)}`);
    }
    log(`${p.name} r${round}: loc top ${ranking.slice(0, 3).map((x) => `L${x.lineIndex + 1}=${x.prob.toFixed(2)}`).join(' ')} truth=L${truth.buggyLineIndex + 1}${round === 1 ? ` rank=${R.locRank}` : ''}`);

    // 2+3. Enumerate and rank candidates for a set of lines (one Choice per line, requests in parallel)
    const rankLines = async (ls: typeof ranking): Promise<RankedCandidate[]> => {
      const out: RankedCandidate[] = [];
      const results = await Promise.all(ls.map(async (ln) => {
        const ctx = buildContext(p, lines, ln.lineIndex);
        const cands = filterSyntactic(ctx, enumerateCandidates(ctx, cfg.candidateCap));
        if (cands.length === 0) return [] as RankedCandidate[];
        const candObj: Record<string, Json> = {}; cands.forEach((c, i) => { candObj[candKey(i)] = c.text; });
        const r = await jev.ask({ ...state, buggy_line: { id: `L${ln.lineIndex + 1}`, text: lines[ln.lineIndex]! }, candidates: candObj },
          { fix: choice(RANK_Q, Object.fromEntries(Object.keys(candObj).map((k) => [k, null]))) }, 'risk');
        b.jev += 1; b.cost += r.usage.costUsd; b.lats.push(r.latencyMs);
        const a = r.answers['fix']!; if (a.type !== 'choice') return [] as RankedCandidate[];
        const none = a.probabilities['none_of_these'] ?? 0;
        const ranked = cands.map((c, i) => ({ c, key: candKey(i), prob: a.probabilities[candKey(i)] ?? 0 })).sort((x, y) => y.prob - x.prob);
        cands.forEach((c) => rankedTexts.add(`${ln.lineIndex}:${normLine(c.text)}`));
        if (ln.lineIndex === truth.buggyLineIndex && truth.kind === 'replace') {
          R.truthLineRanked = true;
          const fi = ranked.findIndex((x) => normLine(x.c.text) === fixNorm);
          if (fi >= 0 && R.fixJevRankInLine === null) { R.fixJevRankInLine = fi + 1; R.fixJevProb = Number(ranked[fi]!.prob.toFixed(3)); }
        }
        log(`${p.name} r${round}: L${ln.lineIndex + 1} (rank ${ln.rank}) ${cands.length} cands; top ${ranked.slice(0, 2).map((x) => `${x.prob.toFixed(2)} ${JSON.stringify(x.c.text.trim())}`).join(' | ')} none=${none.toFixed(2)}`);
        return ranked.map((x, i) => ({ lineIndex: ln.lineIndex, lineRank: ln.rank, lineProb: ln.prob, cand: x.c, prob: x.prob, rankInLine: i + 1, key: x.key }));
      }));
      for (const r of results) out.push(...r);
      return out;
    };
    const byProb = (x: RankedCandidate, y: RankedCandidate): number => y.prob - x.prob || x.lineRank - y.lineRank || x.rankInLine - y.rankInLine;

    const beam = ranking.slice(0, cfg.topLines);
    stop = budgetStop(b, cfg, beam.length, 1); if (stop) { R.budgetStop = stop; break; }
    let queue = (await rankLines(beam)).sort(byProb);
    R.nCandidates = rankedTexts.size;
    let widened = false;
    let verified = 0;
    let idx = 0;
    let progressed = false;
    const widen = async (): Promise<void> => {
      widened = true;
      const extra = ranking.slice(cfg.topLines, cfg.widenLines);
      if (extra.length === 0 || budgetStop(b, cfg, extra.length, 1)) return;
      const more = await rankLines(extra);
      R.nCandidates = rankedTexts.size;
      queue = queue.slice(0, idx).concat(queue.slice(idx).concat(more).sort(byProb));
      log(`${p.name} r${round}: widened to ${cfg.widenLines} lines, queue ${queue.length - idx} left`);
    };
    // 4. Verify in probability order: first k from the beam, then widen and continue by probability
    for (;;) {
      if (!widened && (verified >= cfg.k || idx >= queue.length)) { await widen(); continue; }
      if (idx >= queue.length) break;
      stop = budgetStop(b, cfg, 0, 1); if (stop) { R.budgetStop = stop; break; }
      const item = queue[idx]!; idx += 1;
      const newLines = lines.slice(); newLines[item.lineIndex] = item.cand.text;
      const s = src(newLines);
      if (tried.has(s)) continue;
      tried.add(s);
      const res = await runTests(p, s, runOpts); b.testRuns += 1; verified += 1;
      const fix = isFix(item.lineIndex, item.cand.text);
      if (fix) { R.fixVerified = true; R.fixGlobalRank = idx; }
      const passedAll = res.passedAll && !res.runnerError;
      log(`${p.name} r${round}: verify #${idx} L${item.lineIndex + 1} p=${item.prob.toFixed(2)} ${JSON.stringify(item.cand.text.trim())} -> ${res.passed}/${res.total}${fix ? ' [TRUE FIX]' : ''}${passedAll ? ' REPAIRED' : ''}`);
      if (passedAll) {
        R.repaired = true; R.round = round; R.winRankGlobal = idx; R.winRankInLine = item.rankInLine; R.winLineRank = item.lineRank; R.winProb = Number(item.prob.toFixed(3));
        R.winningLine = `L${item.lineIndex + 1}`; R.winningText = item.cand.text; R.winIsTruth = fix;
        if (fix) R.fixVerified = false; // verified and accepted
        return finish();
      }
      if (fix) notes.push(`true fix verified but ${res.passed}/${res.total}: ${res.runnerError ?? res.firstFailure?.actual ?? ''}`.slice(0, 200));
      if (res.passed > base.passed) {
        notes.push(`r${round}: progress ${base.passed}->${res.passed} via L${item.lineIndex + 1} ${JSON.stringify(item.cand.text.trim())}`);
        lines = newLines; base = res; progressed = true; break;
      }
    }
    if (!progressed) break;
  }
  return finish();
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

function arg(name: string, def: string | null = null): string | null { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? (process.argv[i + 1] ?? def) : def; }
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

if (process.argv[1]?.endsWith('loop.mts')) {
  const out = arg('out', 'experiments/results/prototype-baseline.jsonl')!;
  const only = arg('only'); const limit = Number(arg('limit', '0'));
  const concurrency = Number(arg('concurrency', '3'));
  const cap = Number(arg('cap', '1.4'));
  const cfg: LoopConfig = { ...DEFAULT_CONFIG };
  const verbose = flag('verbose');
  let names = listPrograms();
  if (only) names = names.filter((n) => only.split(',').includes(n));
  if (limit > 0) names = names.slice(0, limit);
  const done = new Set<string>();
  if (flag('resume') && existsSync(out)) {
    for (const l of readFileSync(out, 'utf8').split('\n')) if (l.trim()) done.add((JSON.parse(l) as ProgramResult).name);
  } else {
    writeFileSync(out, ''); // a fresh run starts an empty jsonl
  }
  names = names.filter((n) => !done.has(n));
  const jev = createJev(cap);
  const t0 = performance.now();
  const queue = names.slice();
  const results: ProgramResult[] = [];
  const worker = async (): Promise<void> => {
    for (;;) {
      const n = queue.shift(); if (!n) return;
      const p = loadProgram(n);
      try {
        const r = await repairProgram(p, jev, cfg, verbose ? (s) => console.log('  ' + s) : () => undefined);
        results.push(r);
        appendFileSync(out, JSON.stringify(r) + '\n');
        console.log(`${n.padEnd(28)} ${r.repaired ? 'REPAIRED' : 'failed  '} round=${r.round ?? '-'} win=${r.winRankGlobal ?? '-'} loc=${r.locRank ?? '-'} cov=${r.coverage ? 'Y' : 'n'} cands=${r.nCandidates} runs=${r.testRuns} jev=${r.jevRequests} $${r.costUsd.toFixed(4)} ${(r.wallMs / 1000).toFixed(0)}s ${r.failure ?? ''} ${r.budgetStop ? `stop=${r.budgetStop}` : ''}`);
      } catch (e) {
        if (e instanceof SpendCapError) { console.error(e.message); queue.length = 0; return; }
        console.error(`${n}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        appendFileSync(out, JSON.stringify({ name: n, kind: p.kind, truthKind: p.truth.kind, repaired: false, failure: 'runner_issue', notes: [`exception: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)], testRuns: 0, jevRequests: 0, costUsd: 0, wallMs: 0 }) + '\n');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  const rep = results.filter((r) => r.repaired).length;
  console.log(`\n${results.length} programs: repaired ${rep} | coverage ${results.filter((r) => r.coverage).length} | jev requests ${jev.meter.requests} cost $${jev.meter.costUsd.toFixed(4)} | wall ${((performance.now() - t0) / 1000).toFixed(0)}s`);
}
