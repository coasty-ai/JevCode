/**
 * The head-to-head of docs/LLM-JEV-DESIGN.md §1.3 / §10.4 / §10.6: per-arm suite summaries (pass with Wilson interval,
 * correct-by-verdict, steps-to-solve, wall, $ per task and per solved, refused steps, patchEmpty, drift, generator and
 * Jev counts), paired arms over the tasks evaluated in both (discordant b / c with the one-sided exact sign test, the
 * median-wall ratio with the one-sided Wilcoxon signed-rank test, both-solved wall and steps, cost ratios), the
 * pre-registered criteria 1–4 per suite with the secondary gates, criterion 5 (attribution) across suites, and the
 * markdown that names every failed criterion first. Used by comparison.md (bench/report.ts, without verdicts) and by
 * `experiments/llm-jev/headtohead.mts` (several results dirs, verdict files).
 */
import { formatDuration } from '../core/time.js';
import type { BenchCondition, BenchSuite } from '../core/types.js';
import { emptyGeneratorSummary, mergeGeneratorSummaries } from './generator-records.js';
import { isEvaluated, isNotRun, mean, median } from './metrics.js';
import { discordantPairs, ratio, wilcoxonSignedRankOneSided, wilson, type DiscordantPairs, type WilcoxonResult } from './stats.js';
import type { BenchRecord, GeneratorCallsSummary } from './types.js';

// ---------------------------------------------------------------------------------------
// Verdicts (experiments/inspect/{quixbugs,ladder}-verdicts.mts output)
// ---------------------------------------------------------------------------------------

export const VERDICTS = ['gold-identical', 'equivalent', 'overfit', 'unverified', 'miss'] as const;
export type Verdict = (typeof VERDICTS)[number];
/** task id → verdict, for one arm */
export type VerdictMap = ReadonlyMap<string, Verdict>;
/** arm → its verdict map */
export type Verdicts = ReadonlyMap<BenchCondition, VerdictMap>;

export function isVerdict(s: string): s is Verdict {
  return (VERDICTS as readonly string[]).includes(s);
}

/** §1.3 criterion 2: correct-by-verdict = gold-identical ∨ equivalent. */
export function isCorrectVerdict(v: Verdict): boolean {
  return v === 'gold-identical' || v === 'equivalent';
}

/**
 * The per-task table of a verdicts.md (`| program | solved | verdict | evidence |` or `| task | tier | solved | verdict |
 * evidence |`): the first column is the task id, the `verdict` column the verdict (a `weak overfit` qualifier reads as
 * overfit). Rows outside the table and unknown verdict words are ignored.
 */
export function parseVerdictsMarkdown(text: string): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!.trim();
    if (!header.startsWith('|')) continue;
    const cols = header.split('|').map((c) => c.trim().toLowerCase());
    const verdictCol = cols.indexOf('verdict');
    if (verdictCol < 0 || !(cols[1] === 'program' || cols[1] === 'task')) continue;
    for (let j = i + 2; j < lines.length; j++) {
      const row = lines[j]!.trim();
      if (!row.startsWith('|')) break;
      const cells = row.split('|').map((c) => c.trim());
      const task = cells[1] ?? '';
      const word = (cells[verdictCol] ?? '').replace(/`/g, '').split(/\s+/).find((w) => isVerdict(w));
      if (task !== '' && word !== undefined && isVerdict(word)) out.set(task.replace(/`/g, ''), word);
    }
    i = lines.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Per-arm suite summary
// ---------------------------------------------------------------------------------------

export interface ArmSuiteSummary {
  condition: BenchCondition;
  tasks: number;
  evaluated: number;
  passed: number;
  passRate: number | null;
  wilson: { lo: number; hi: number } | null;
  /** correct-by-verdict over evaluated tasks (SWE: = passed); null when no verdicts were given for the arm */
  correct: number | null;
  overfit: number | null;
  stepsToSolve: { median: number | null; mean: number | null; n: number };
  wallMs: { median: number | null; mean: number | null };
  cost: { total: number; generator: number; jev: number; perTask: number | null; perSolved: number | null };
  /** §1.3 secondary gate: blocked + declined steps */
  refused: number;
  patchEmpty: number;
  modelDrift: number;
  jevRequests: number;
  jevQuestions: number;
  stubbedJevRequests: number;
  generator: GeneratorCallsSummary;
}

function correctnessOf(suite: BenchSuite, evaluated: readonly BenchRecord[], verdicts: VerdictMap | null | undefined): { correct: number | null; overfit: number | null } {
  if (suite === 'swebench') return { correct: evaluated.filter((r) => r.pass === true).length, overfit: 0 };
  if (!verdicts) return { correct: null, overfit: null };
  let correct = 0;
  let overfit = 0;
  for (const r of evaluated) {
    const v = verdicts.get(r.task);
    if (v === undefined) continue;
    if (isCorrectVerdict(v)) correct += 1;
    if (v === 'overfit') overfit += 1;
  }
  return { correct, overfit };
}

export function armSuiteSummary(suite: BenchSuite, records: readonly BenchRecord[], condition: BenchCondition, verdicts?: VerdictMap | null): ArmSuiteSummary {
  const own = records.filter((r) => r.suite === suite && r.condition === condition);
  const ran = own.filter((r) => !isNotRun(r));
  const evaluated = own.filter(isEvaluated);
  const passed = evaluated.filter((r) => r.pass === true);
  const generator = ran.reduce((s, r) => s + r.cost.generator, 0);
  const jev = ran.reduce((s, r) => s + r.cost.jev, 0);
  const total = generator + jev;
  const steps = passed.map((r) => r.steps);
  return {
    condition,
    tasks: own.length,
    evaluated: evaluated.length,
    passed: passed.length,
    passRate: evaluated.length === 0 ? null : passed.length / evaluated.length,
    wilson: wilson(passed.length, evaluated.length),
    ...correctnessOf(suite, evaluated, verdicts),
    stepsToSolve: { median: median(steps), mean: mean(steps), n: steps.length },
    wallMs: { median: median(ran.map((r) => r.wallMs)), mean: mean(ran.map((r) => r.wallMs)) },
    cost: { total, generator, jev, perTask: ran.length === 0 ? null : total / ran.length, perSolved: passed.length === 0 ? null : total / passed.length },
    refused: ran.reduce((s, r) => s + r.blocked, 0),
    patchEmpty: ran.filter((r) => r.patchEmpty === true).length,
    modelDrift: own.filter((r) => r.modelDrift).length,
    jevRequests: ran.reduce((s, r) => s + r.jevRequests, 0),
    jevQuestions: ran.reduce((s, r) => s + r.jevQuestions, 0),
    stubbedJevRequests: ran.reduce((s, r) => s + (r.stubbedJevRequests ?? 0), 0),
    generator: mergeGeneratorSummaries(ran.map((r) => r.generator ?? emptyGeneratorSummary())),
  };
}

// ---------------------------------------------------------------------------------------
// Paired arms
// ---------------------------------------------------------------------------------------

export interface PairRow {
  task: string;
  candidate: BenchRecord;
  baseline: BenchRecord;
}

export interface ArmPair {
  suite: BenchSuite;
  candidate: BenchCondition;
  baseline: BenchCondition;
  /** tasks evaluated in both arms, modelDrift excluded */
  rows: PairRow[];
  discordant: DiscordantPairs;
  passes: { candidate: number; baseline: number };
  /** over the paired tasks, when verdicts were given for both arms (SWE: = passes) */
  correct: { candidate: number | null; baseline: number | null; candidateOverfit: number | null; baselineOverfit: number | null };
  wall: { candidateMedianMs: number | null; baselineMedianMs: number | null; medianRatio: number | null; wilcoxon: WilcoxonResult };
  /** tasks both arms solved: mean wall and mean steps-to-solve, with ratios */
  bothSolved: { n: number; candidateWallMeanMs: number | null; baselineWallMeanMs: number | null; wallRatio: number | null; candidateStepsMean: number | null; baselineStepsMean: number | null; stepsRatio: number | null };
  cost: { candidatePerTask: number | null; baselinePerTask: number | null; perTaskRatio: number | null; candidatePerSolved: number | null; baselinePerSolved: number | null; perSolvedRatio: number | null };
  secondary: { candidateRefused: number; candidatePatchEmpty: number; baselinePatchEmpty: number; candidateDrift: number };
}

function latest(records: readonly BenchRecord[], suite: BenchSuite, condition: BenchCondition): Map<string, BenchRecord> {
  const m = new Map<string, BenchRecord>();
  for (const r of records) if (r.suite === suite && r.condition === condition) m.set(r.task, r);
  return m;
}

const totalCost = (r: BenchRecord): number => r.cost.generator + r.cost.jev;

export function pairArms(suite: BenchSuite, records: readonly BenchRecord[], candidate: BenchCondition, baseline: BenchCondition, verdicts?: Verdicts | null): ArmPair | null {
  const a = latest(records, suite, candidate);
  const b = latest(records, suite, baseline);
  const rows: PairRow[] = [];
  for (const [task, ca] of a) {
    const ba = b.get(task);
    if (ba === undefined || !isEvaluated(ca) || !isEvaluated(ba) || ca.modelDrift || ba.modelDrift) continue;
    rows.push({ task, candidate: ca, baseline: ba });
  }
  rows.sort((x, y) => x.task.localeCompare(y.task));
  if (rows.length === 0) return null;
  const cand = rows.map((r) => r.candidate);
  const base = rows.map((r) => r.baseline);
  const candPassed = cand.filter((r) => r.pass === true);
  const basePassed = base.filter((r) => r.pass === true);
  const vc = verdicts?.get(candidate) ?? null;
  const vb = verdicts?.get(baseline) ?? null;
  const cc = correctnessOf(suite, cand, vc);
  const cb = correctnessOf(suite, base, vb);
  const both = rows.filter((r) => r.candidate.pass === true && r.baseline.pass === true);
  const candWallMedian = median(cand.map((r) => r.wallMs));
  const baseWallMedian = median(base.map((r) => r.wallMs));
  const candCost = cand.reduce((s, r) => s + totalCost(r), 0);
  const baseCost = base.reduce((s, r) => s + totalCost(r), 0);
  const perTask = (usd: number): number | null => (rows.length === 0 ? null : usd / rows.length);
  const perSolved = (usd: number, solved: number): number | null => (solved === 0 ? null : usd / solved);
  const bothCandWall = mean(both.map((r) => r.candidate.wallMs));
  const bothBaseWall = mean(both.map((r) => r.baseline.wallMs));
  const bothCandSteps = mean(both.map((r) => r.candidate.steps));
  const bothBaseSteps = mean(both.map((r) => r.baseline.steps));
  return {
    suite,
    candidate,
    baseline,
    rows,
    discordant: discordantPairs(rows.map((r) => ({ candidate: r.candidate.pass === true, baseline: r.baseline.pass === true }))),
    passes: { candidate: candPassed.length, baseline: basePassed.length },
    correct: { candidate: cc.correct, baseline: cb.correct, candidateOverfit: cc.overfit, baselineOverfit: cb.overfit },
    wall: { candidateMedianMs: candWallMedian, baselineMedianMs: baseWallMedian, medianRatio: ratio(candWallMedian, baseWallMedian), wilcoxon: wilcoxonSignedRankOneSided(rows.map((r) => r.candidate.wallMs - r.baseline.wallMs)) },
    bothSolved: { n: both.length, candidateWallMeanMs: bothCandWall, baselineWallMeanMs: bothBaseWall, wallRatio: ratio(bothCandWall, bothBaseWall), candidateStepsMean: bothCandSteps, baselineStepsMean: bothBaseSteps, stepsRatio: ratio(bothCandSteps, bothBaseSteps) },
    cost: {
      candidatePerTask: perTask(candCost),
      baselinePerTask: perTask(baseCost),
      perTaskRatio: ratio(perTask(candCost), perTask(baseCost)),
      candidatePerSolved: perSolved(candCost, candPassed.length),
      baselinePerSolved: perSolved(baseCost, basePassed.length),
      perSolvedRatio: ratio(perSolved(candCost, candPassed.length), perSolved(baseCost, basePassed.length)),
    },
    secondary: { candidateRefused: cand.reduce((s, r) => s + r.blocked, 0), candidatePatchEmpty: cand.filter((r) => r.patchEmpty === true).length, baselinePatchEmpty: base.filter((r) => r.patchEmpty === true).length, candidateDrift: [...a.values()].filter((r) => r.modelDrift).length },
  };
}

// ---------------------------------------------------------------------------------------
// Criteria (§1.3, pre-registered)
// ---------------------------------------------------------------------------------------

export type CriterionStatus = 'pass' | 'fail' | 'reported' | 'not_evaluable';

export interface CriterionResult {
  id: string;
  title: string;
  /** false = reported, never gates */
  gating: boolean;
  status: CriterionStatus;
  detail: string;
}

interface PassBar {
  margin: number;
  maxLosses: number;
  /** gating: p < 0.05 required; reported: printed, not gating; none: no p-value is quoted (under-powered by design) */
  p: 'gating' | 'reported' | 'none';
}

export const PASS_BARS: Readonly<Partial<Record<BenchSuite, PassBar>>> = {
  quixbugs: { margin: 8, maxLosses: 2, p: 'gating' },
  ladder: { margin: 3, maxLosses: 1, p: 'none' },
  swebench: { margin: 4, maxLosses: 2, p: 'reported' },
};
export const COST_PER_SOLVED_BAR: Readonly<Partial<Record<BenchSuite, number>>> = { quixbugs: 0.75, ladder: 0.9, swebench: 0.75 };
export const COST_PER_TASK_BAR = 1.0;
export const WALL_MEDIAN_BAR = 0.5;
export const CORRECTNESS_MARGIN: Readonly<Partial<Record<BenchSuite, number>>> = { quixbugs: 8, ladder: 2 };
export const LADDER_MAX_OVERFITS = 1;
export const ALPHA = 0.05;

const fmtP = (p: number | null): string => (p === null ? 'p n/a' : `p = ${p.toFixed(3)}`);
const fmtRatio = (r: number | null): string => (r === null ? 'n/a' : `${r.toFixed(2)}×`);
const fmtMs = (ms: number | null): string => (ms === null ? 'n/a' : formatDuration(ms));
const fmtUsd = (x: number | null): string => (x === null ? 'n/a' : `$${x.toFixed(4)}`);
const status = (ok: boolean): CriterionStatus => (ok ? 'pass' : 'fail');

/** Criteria 1–4 and the secondary gates for one suite, candidate vs the jev-off baseline. */
export function evaluateCriteria(pair: ArmPair): CriterionResult[] {
  const out: CriterionResult[] = [];
  const { suite, discordant: d } = pair;
  const bar = PASS_BARS[suite];
  const n = pair.rows.length;
  // 1 — pass
  if (bar === undefined) {
    out.push({ id: '1', title: 'pass (discordant pairs)', gating: false, status: 'not_evaluable', detail: `${suite} has no pre-registered bar` });
  } else {
    const counts = d.b - d.c >= bar.margin && d.c <= bar.maxLosses;
    const pOk = bar.p !== 'gating' || (d.p !== null && d.p < ALPHA);
    const pText = bar.p === 'none' ? 'no p-value (under-powered by design)' : `sign test ${fmtP(d.p)}${bar.p === 'reported' ? ' (reported, not gating)' : ''}`;
    out.push({ id: '1', title: 'pass (discordant pairs)', gating: true, status: status(counts && pOk), detail: `n = ${n}: b = ${d.b} (${pair.candidate} wins), c = ${d.c} (${pair.baseline} wins), both ${d.both}, neither ${d.neither}; bar b − c ≥ ${bar.margin} ∧ c ≤ ${bar.maxLosses}; ${pText}` });
  }
  // 2 — correctness
  if (suite === 'swebench') {
    out.push({ id: '2', title: 'correctness', gating: false, status: 'reported', detail: 'SWE: correctness = evaluator pass (criterion 1)' });
  } else if (pair.correct.candidate === null || pair.correct.baseline === null) {
    out.push({ id: '2', title: 'correct-by-verdict', gating: true, status: 'not_evaluable', detail: 'no verdicts for one of the arms (experiments/inspect/*-verdicts.mts; pass --verdicts <arm>=<verdicts.md>)' });
  } else {
    const margin = CORRECTNESS_MARGIN[suite] ?? 0;
    const gained = pair.correct.candidate - pair.correct.baseline;
    const overfitOk = suite !== 'ladder' || (pair.correct.candidateOverfit ?? 0) <= LADDER_MAX_OVERFITS;
    out.push({ id: '2', title: 'correct-by-verdict', gating: true, status: status(gained >= margin && overfitOk), detail: `${pair.candidate} ${pair.correct.candidate} vs ${pair.baseline} ${pair.correct.baseline} correct of ${n} (Δ ${gained >= 0 ? '+' : ''}${gained}, bar ≥ +${margin})${suite === 'ladder' ? `; overfits ${pair.correct.candidateOverfit ?? 0} (bar ≤ ${LADDER_MAX_OVERFITS})` : ''}` });
  }
  // 3 — wall
  if (suite === 'swebench') {
    const b = pair.bothSolved;
    const ok = b.n > 0 && b.wallRatio !== null && b.wallRatio <= 1.0 && b.stepsRatio !== null && b.stepsRatio <= 0.5;
    out.push({ id: '3', title: 'wall (tasks solved by both)', gating: true, status: b.n === 0 ? 'not_evaluable' : status(ok), detail: `${b.n} tasks solved by both: mean wall ${fmtMs(b.candidateWallMeanMs)} vs ${fmtMs(b.baselineWallMeanMs)} (${fmtRatio(b.wallRatio)}, bar ≤ 1.0×); mean steps-to-solve ${b.candidateStepsMean?.toFixed(1) ?? 'n/a'} vs ${b.baselineStepsMean?.toFixed(1) ?? 'n/a'} (${fmtRatio(b.stepsRatio)}, bar ≤ 0.5×)` });
  } else {
    const w = pair.wall;
    const ok = w.medianRatio !== null && w.medianRatio <= WALL_MEDIAN_BAR && w.wilcoxon.p !== null && w.wilcoxon.p < ALPHA;
    out.push({ id: '3', title: 'wall (median per task)', gating: true, status: status(ok), detail: `median ${fmtMs(w.candidateMedianMs)} vs ${fmtMs(w.baselineMedianMs)} (${fmtRatio(w.medianRatio)}, bar ≤ ${WALL_MEDIAN_BAR}×); one-sided Wilcoxon signed-rank ${fmtP(w.wilcoxon.p)} over ${w.wilcoxon.n} non-tied pairs (bar < ${ALPHA})` });
  }
  // 4 — cost
  const solvedBar = COST_PER_SOLVED_BAR[suite];
  if (solvedBar === undefined) {
    out.push({ id: '4', title: 'cost', gating: false, status: 'not_evaluable', detail: `${suite} has no pre-registered cost bar` });
  } else {
    const c = pair.cost;
    const okSolved = c.perSolvedRatio !== null && c.perSolvedRatio <= solvedBar;
    const okTask = c.perTaskRatio !== null && c.perTaskRatio <= COST_PER_TASK_BAR;
    out.push({ id: '4', title: 'cost ($ per solved, $ per task)', gating: true, status: c.perSolvedRatio === null ? 'not_evaluable' : status(okSolved && okTask), detail: `$ per solved ${fmtUsd(c.candidatePerSolved)} vs ${fmtUsd(c.baselinePerSolved)} (${fmtRatio(c.perSolvedRatio)}, bar ≤ ${solvedBar}×); $ per task ${fmtUsd(c.candidatePerTask)} vs ${fmtUsd(c.baselinePerTask)} (${fmtRatio(c.perTaskRatio)}, bar ≤ ${COST_PER_TASK_BAR}×)` });
  }
  // secondary gates
  const s = pair.secondary;
  out.push({ id: 'S1', title: 'refused steps (blocked + declined) on the candidate', gating: true, status: status(s.candidateRefused === 0), detail: `${s.candidateRefused} (bar 0)` });
  out.push({ id: 'S2', title: 'patchEmpty ≤ baseline', gating: true, status: status(s.candidatePatchEmpty <= s.baselinePatchEmpty), detail: `${s.candidatePatchEmpty} vs ${s.baselinePatchEmpty}` });
  out.push({ id: 'S3', title: 'zero modelDrift on the candidate', gating: true, status: status(s.candidateDrift === 0), detail: `${s.candidateDrift} record(s) with drift (excluded from the pairs)` });
  return out;
}

export interface AttributionInput {
  suite: BenchSuite;
  vsSieve: ArmPair | null;
  vsTuned: ArmPair | null;
}

/**
 * Criterion 5 (secondary; gates the question set, not 1–4): against `llm-sieve` the candidate passes at least as many
 * tasks on every suite and is strictly better on ≥ 2 of {correct-by-verdict, $ per solved, median wall} on ≥ 2 suites;
 * against `jev-off-tuned` the comparison is reported in full, and a match on pass and correctness is said so.
 */
export function evaluateAttribution(suites: readonly AttributionInput[]): CriterionResult[] {
  const out: CriterionResult[] = [];
  const sieve = suites.filter((s) => s.vsSieve !== null);
  if (sieve.length === 0) {
    out.push({ id: '5a', title: 'attribution vs llm-sieve', gating: false, status: 'not_evaluable', detail: 'no paired llm-sieve records' });
  } else {
    let passesEverywhere = true;
    let suitesBetter = 0;
    const parts: string[] = [];
    for (const s of sieve) {
      const p = s.vsSieve!;
      const passOk = p.passes.candidate >= p.passes.baseline;
      passesEverywhere &&= passOk;
      const better: string[] = [];
      if (p.correct.candidate !== null && p.correct.baseline !== null && p.correct.candidate > p.correct.baseline) better.push('correct');
      if (p.cost.perSolvedRatio !== null && p.cost.perSolvedRatio < 1) better.push('$ per solved');
      if (p.wall.medianRatio !== null && p.wall.medianRatio < 1) better.push('median wall');
      if (better.length >= 2) suitesBetter += 1;
      parts.push(`${s.suite}: pass ${p.passes.candidate} vs ${p.passes.baseline} of ${p.rows.length}${passOk ? '' : ' (FAIL)'}; better on {${better.join(', ')}}`);
    }
    out.push({ id: '5a', title: 'attribution vs llm-sieve', gating: false, status: status(passesEverywhere && suitesBetter >= 2), detail: `${parts.join('; ')} — bar: ≥ passes on every suite ∧ strictly better on ≥ 2 of {correct, $ per solved, median wall} on ≥ 2 suites (${suitesBetter} suites qualify)` });
  }
  const tuned = suites.filter((s) => s.vsTuned !== null);
  if (tuned.length === 0) {
    out.push({ id: '5b', title: 'attribution vs jev-off-tuned', gating: false, status: 'not_evaluable', detail: 'no paired jev-off-tuned records' });
  } else {
    const parts: string[] = [];
    let matches = true;
    for (const s of tuned) {
      const p = s.vsTuned!;
      const samePass = p.passes.candidate === p.passes.baseline;
      const sameCorrect = p.correct.candidate === null || p.correct.baseline === null || p.correct.candidate === p.correct.baseline;
      matches &&= samePass && sameCorrect;
      parts.push(`${s.suite}: pass ${p.passes.candidate} vs ${p.passes.baseline} of ${p.rows.length}, correct ${p.correct.candidate ?? 'n/a'} vs ${p.correct.baseline ?? 'n/a'}, median wall ${fmtRatio(p.wall.medianRatio)}, $ per solved ${fmtRatio(p.cost.perSolvedRatio)}`);
    }
    out.push({ id: '5b', title: 'attribution vs jev-off-tuned', gating: false, status: 'reported', detail: `${matches ? 'jev-off-tuned MATCHES the candidate on pass and correctness — hygiene alone explains the pass rate. ' : ''}${parts.join('; ')}` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------

export function tableLines(header: string[], rows: string[][]): string[] {
  const line = (cells: string[]): string => `| ${cells.map((c) => c.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)];
}

const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const fmtWilson = (w: { lo: number; hi: number } | null): string => (w === null ? 'n/a' : `[${(w.lo * 100).toFixed(0)}%, ${(w.hi * 100).toFixed(0)}%]`);

export function armsTable(summaries: readonly ArmSuiteSummary[]): string[] {
  return tableLines(
    ['arm', 'pass', 'Wilson 95%', 'correct', 'overfit', 'steps-to-solve median', 'wall median / mean', '$ per task', '$ per solved', 'generator calls / valid / length / dropped', 'est. $', 'Jev requests (stubbed)', 'refused', 'patchEmpty', 'drift'],
    summaries.map((s) => [
      s.condition,
      `${s.passed}/${s.evaluated} ${pct(s.passRate)}`,
      fmtWilson(s.wilson),
      s.correct === null ? 'n/a' : String(s.correct),
      s.overfit === null ? 'n/a' : String(s.overfit),
      s.stepsToSolve.median === null ? 'n/a' : `${s.stepsToSolve.median} (n=${s.stepsToSolve.n})`,
      `${fmtMs(s.wallMs.median)} / ${fmtMs(s.wallMs.mean)}`,
      fmtUsd(s.cost.perTask),
      fmtUsd(s.cost.perSolved),
      `${s.generator.calls} / ${s.generator.valid} / ${s.generator.lengthStops} / ${s.generator.cancelled}`,
      fmtUsd(s.generator.estimatedUsd),
      `${s.jevRequests}${s.stubbedJevRequests > 0 ? ` (${s.stubbedJevRequests})` : ''}`,
      String(s.refused),
      String(s.patchEmpty),
      String(s.modelDrift),
    ]),
  );
}

export function pairsTable(pairs: readonly ArmPair[]): string[] {
  return tableLines(
    ['arm vs baseline', 'n', 'b (arm wins)', 'c (baseline wins)', 'both', 'neither', 'sign test p', 'median wall', 'Wilcoxon p', '$ per task', '$ per solved', 'correct'],
    pairs.map((p) => [
      `${p.candidate} vs ${p.baseline}`,
      String(p.rows.length),
      String(p.discordant.b),
      String(p.discordant.c),
      String(p.discordant.both),
      String(p.discordant.neither),
      p.discordant.p === null ? 'n/a' : p.discordant.p.toFixed(3),
      `${fmtMs(p.wall.candidateMedianMs)} vs ${fmtMs(p.wall.baselineMedianMs)} (${fmtRatio(p.wall.medianRatio)})`,
      p.wall.wilcoxon.p === null ? 'n/a' : p.wall.wilcoxon.p.toFixed(3),
      fmtRatio(p.cost.perTaskRatio),
      fmtRatio(p.cost.perSolvedRatio),
      p.correct.candidate === null || p.correct.baseline === null ? 'n/a' : `${p.correct.candidate} vs ${p.correct.baseline}`,
    ]),
  );
}

export function criteriaLines(results: readonly CriterionResult[]): string[] {
  const mark = (s: CriterionStatus): string => (s === 'pass' ? '**pass**' : s === 'fail' ? '**FAIL**' : s === 'reported' ? 'reported' : 'not evaluable');
  return results.map((r) => `- criterion ${r.id} — ${r.title}: ${mark(r.status)}${r.gating ? '' : ' (not gating)'} — ${r.detail}`);
}

export function perTaskTable(suite: BenchSuite, records: readonly BenchRecord[], arms: readonly BenchCondition[]): string[] {
  const byArm = new Map(arms.map((a) => [a, latest(records, suite, a)] as const));
  const tasks = [...new Set(records.filter((r) => r.suite === suite && arms.includes(r.condition)).map((r) => r.task))].sort();
  const cell = (r: BenchRecord | undefined): string[] => {
    if (r === undefined) return ['—', '', '', ''];
    const pass = r.pass === true ? 'pass' : r.pass === false ? 'fail' : isNotRun(r) ? 'not run' : 'null';
    return [pass, String(r.steps), formatDuration(r.wallMs), fmtUsd(totalCost(r))];
  };
  return tableLines(['task', ...arms.flatMap((a) => [`${a}`, 'steps', 'wall', '$'])], tasks.map((t) => [t, ...arms.flatMap((a) => cell(byArm.get(a)?.get(t)))]));
}

export interface SuiteHeadToHead {
  suite: BenchSuite;
  arms: BenchCondition[];
  summaries: ArmSuiteSummary[];
  /** every present non-baseline arm vs the baseline */
  pairs: ArmPair[];
  /** criteria 1–4 (+ secondary) for the candidate vs the baseline; empty when either arm is missing */
  criteria: CriterionResult[];
  attribution: AttributionInput;
}

export interface HeadToHeadOptions {
  candidate?: BenchCondition;
  baseline?: BenchCondition;
  verdicts?: Verdicts | null;
}

/** Everything the markdown of one suite needs, computed once (report.ts and the CLI both consume it). */
export function suiteHeadToHead(suite: BenchSuite, records: readonly BenchRecord[], arms: readonly BenchCondition[], opts: HeadToHeadOptions = {}): SuiteHeadToHead {
  const candidate = opts.candidate ?? 'llm-jev';
  const baseline = opts.baseline ?? 'jev-off';
  const verdicts = opts.verdicts ?? null;
  const present = arms.filter((a) => records.some((r) => r.suite === suite && r.condition === a));
  const summaries = present.map((a) => armSuiteSummary(suite, records, a, verdicts?.get(a) ?? null));
  const pairs = present.filter((a) => a !== baseline && present.includes(baseline)).map((a) => pairArms(suite, records, a, baseline, verdicts)).filter((p): p is ArmPair => p !== null);
  const main = pairs.find((p) => p.candidate === candidate) ?? null;
  const vs = (arm: BenchCondition): ArmPair | null => (present.includes(arm) && present.includes(candidate) ? pairArms(suite, records, candidate, arm, verdicts) : null);
  return {
    suite,
    arms: present,
    summaries,
    pairs,
    criteria: main === null ? [] : evaluateCriteria(main),
    attribution: { suite, vsSieve: vs('llm-sieve'), vsTuned: vs('jev-off-tuned') },
  };
}

/** The markdown block of one suite (arms, pairs, criteria, per-task rows). */
export function suiteHeadToHeadLines(h: SuiteHeadToHead, records: readonly BenchRecord[], opts: { perTask?: boolean } = {}): string[] {
  const out: string[] = [];
  out.push('#### Arms (all evaluated records of the suite)', '', ...armsTable(h.summaries), '');
  if (h.pairs.length > 0) out.push('#### Paired vs baseline (tasks evaluated in both, drift excluded)', '', ...pairsTable(h.pairs), '');
  if (h.criteria.length > 0) out.push('#### Pre-registered criteria (§1.3)', '', ...criteriaLines(h.criteria), '');
  else out.push('_criteria 1–4 need both the candidate and the baseline arm with paired evaluated tasks_', '');
  if (opts.perTask !== false) out.push('#### Per task', '', ...perTaskTable(h.suite, records, h.arms), '');
  return out;
}

/** The first paragraph §10.6 asks for: the failed gating criteria by suite, and the tuned-matches sentence when it applies. */
export function verdictParagraph(suites: readonly SuiteHeadToHead[], attribution: readonly CriterionResult[]): string {
  const failed: string[] = [];
  const open: string[] = [];
  for (const s of suites) {
    for (const c of s.criteria) {
      if (!c.gating) continue;
      if (c.status === 'fail') failed.push(`${s.suite} criterion ${c.id} (${c.title})`);
      else if (c.status === 'not_evaluable') open.push(`${s.suite} criterion ${c.id}`);
    }
  }
  const evaluated = suites.filter((s) => s.criteria.length > 0);
  const parts: string[] = [];
  if (evaluated.length === 0) parts.push('No suite has both the candidate and the baseline arm paired, so criteria 1–4 are not evaluated.');
  else if (failed.length === 0) parts.push(`Every evaluable gating criterion holds on ${evaluated.map((s) => s.suite).join(', ')}.`);
  else parts.push(`Failed: ${failed.join('; ')}.`);
  if (open.length > 0) parts.push(`Not evaluable: ${open.join(', ')}.`);
  const tuned = attribution.find((a) => a.id === '5b');
  if (tuned !== undefined && tuned.detail.startsWith('jev-off-tuned MATCHES')) parts.push('jev-off-tuned matches llm-jev on pass and correctness: the pass-rate gain is generator hygiene, not Jev.');
  const sieve = attribution.find((a) => a.id === '5a');
  if (sieve !== undefined && sieve.status !== 'not_evaluable') parts.push(`Attribution vs llm-sieve: ${sieve.status === 'pass' ? 'holds' : 'does not hold'}.`);
  return parts.join(' ');
}
