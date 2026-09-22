/**
 * contract 1.9 (Fastlane) — the measurement side of the LLM-loop wave (docs/LLM-LOOP-DESIGN.md §8): the recorded
 * iteration-1 rows the new arms are read against, the five blocking rows R-a…R-e of §8.3, the pre-registered
 * predictions (a)…(f) of §8.4, and the accept rule of §8.5.
 *
 * Everything here is arithmetic over `BenchRecord`s that already exist — `BenchRecord.synth` (the `StepsSummary` the
 * §5.5 bridge fills from `steps.jsonl`) plus the frozen pass/wall/cost fields. Nothing calls a model, nothing reads a
 * run directory, and nothing here decides: each row carries its inputs and its pass condition so a null result is as
 * readable as a win. That is the §8.4 RETIRE rule's precondition — a row that only says "FAIL" is an invitation to
 * widen the gate until something fires.
 *
 * Two readings are pinned here because the design's prose leaves them open, and a measurement that picks one silently
 * is worse than one that argues for it:
 *
 *   - **R-a** is specified as "`routers.waitMs` p95 over every step = 0". A p95 of a quantity whose bar is exactly zero
 *     is the same gate as its maximum unless more than 5 % of steps blocked, and the max is the stricter, cheaper and
 *     un-gameable form: one blocked step is one router that gated the loop (I3), and it must not average away.
 *   - **R-c** is specified as "stage-1-fired / stage-2-declined ratio … ≤ 0.3; above that the predicate is wrong, not
 *     the budget". Read literally that ratio rises when the predicate works, so the gate is taken in the direction
 *     that makes the stated conclusion true: `stage2Declined / stage1Fired` — of the steps the STRUCTURAL stage let
 *     through, at most 30 % may be thrown out by the stage that costs real work.
 */
import { formatDuration } from '../core/time.js';
import type { BenchCondition, BenchSuite } from '../core/types.js';
import { isEvaluated, median } from './metrics.js';
import { emptyStepsSummary, mergeStepsSummaries } from './step-records.js';
import type { BenchRecord, StepsSummary } from './types.js';

// ---------------------------------------------------------------------------------------
// §8.1 the recorded arms
// ---------------------------------------------------------------------------------------

/** The build the recorded rows were taken at (§8.2 build-drift caveat). */
export const RECORDED_BUILD = '751e3bf';
export const RECORDED_SOURCE = 'experiments/results/llm-jev-iter1.md';

/**
 * §8.2: the recorded `llm-jev` and `jev-off-tuned` rows are NOT re-run — `experiments/llm-jev/results.ts` merges them by
 * `(suite, task, condition)` when their results dirs are passed, and these are the headline numbers the merged table is
 * checked against. They are a REFERENCE, not a baseline: they were taken at `751e3bf`, and `main` has since carried the
 * nine changes of `oos-iter-2`, none of them measured. Comparing `jev-on-next` to these rows confounds this wave with all
 * of iteration 2, which is why §8.5 clause 4 rests on the `jev-on-next-nofast` control — the only same-build contrast.
 */
export interface RecordedSlice {
  slice: 'fresh-18' | 'in-sample-28';
  condition: BenchCondition;
  solved: number;
  n: number;
  /** median wall over the tasks BOTH recorded arms solved (fresh slice: the 8 QuixBugs tasks), null where not recorded */
  bothSolvedMedianWallMs: number | null;
  costUsd: number | null;
  note: string;
}

export const RECORDED_ITER1: readonly RecordedSlice[] = [
  { slice: 'fresh-18', condition: 'llm-jev', solved: 12, n: 18, bothSolvedMedianWallMs: 26_000, costUsd: 0.2517, note: 'Wilson [44 %, 84 %]; the 4 wins are the whole ladder long-2 tier it solves' },
  { slice: 'fresh-18', condition: 'jev-off-tuned', solved: 9, n: 18, bothSolvedMedianWallMs: 19_700, costUsd: 0.2435, note: '0/6 on ladder long-2; discordance b = 4 / c = 1, one-sided exact sign test p = 0.1875' },
  { slice: 'in-sample-28', condition: 'llm-jev', solved: 27, n: 28, bothSolvedMedianWallMs: null, costUsd: 0.0783, note: 'against the frozen 066816f reference of 28/28; the loss is django__django-15128' },
];

export function recorded(slice: RecordedSlice['slice'], condition: BenchCondition): RecordedSlice | null {
  return RECORDED_ITER1.find((r) => r.slice === slice && r.condition === condition) ?? null;
}

/** §8.4 (b): `llm-jev` is already 1.32× slower than tuned on the 8 both-solved QuixBugs tasks. A losing fast path deepens exactly that shape. */
export const RECORDED_BOTH_SOLVED_RATIO = 26_000 / 19_700;

// ---------------------------------------------------------------------------------------
// §8.3 the five blocking rows
// ---------------------------------------------------------------------------------------

/**
 * §5.2: `FastPathReason` is a string union so the R-d histogram is exhaustive. The union itself lands in
 * `src/core/types.ts` with slot C (§7.1 writer order puts C after this slot), so the list is mirrored here and the
 * mirror is what R-d is checked against; `test/unit/bench/next-arms.test.ts` pins it, and once slot C has merged the
 * list should be replaced by `satisfies readonly FastPathReason[]` so the compiler owns the exhaustiveness instead.
 */
export const FASTPATH_REASONS: readonly string[] = [
  'off',
  'not_jev_on',
  'no_synthesizer',
  'no_parsed_run',
  'scope_unusable',
  'all_passing',
  'workspace_changed',
  't_run_too_slow',
  'multi_file',
  'too_many_failures',
  'repository_class',
  'no_wall',
  'fingerprint_seen',
  'attempts_exhausted',
  'disarmed',
  'loop_tripped',
  'pause_pending',
  'lease_conflict',
  'oracle_class',
  'too_many_sites',
  'pool_exceeds_run_budget',
  'no_sites',
  'empty_step_budget',
  'confirm_timeout',
  'held',
  'error',
];

/** §8.3 R-c: above this the PREDICATE is wrong, not the budget. */
export const STAGE2_DECLINE_BAR = 0.3;
/** §8.3 R-d: an `'error'` bucket above this share of declines is a fail — the histogram then names a defect, not a clause. */
export const ERROR_BUCKET_BAR = 0.05;

export type RowStatus = 'pass' | 'fail' | 'reported' | 'not_evaluable';

export interface MeasurementRow {
  id: 'R-a' | 'R-b' | 'R-c' | 'R-d' | 'R-e';
  title: string;
  /** false = reported, never gates (R-e is the only one) */
  gating: boolean;
  status: RowStatus;
  detail: string;
}

/** Every record of one arm, with the suite filter §8.3 R-c asks for. */
export function armSteps(records: readonly BenchRecord[], condition: BenchCondition, suite?: BenchSuite): StepsSummary {
  const mine = records.filter((r) => r.condition === condition && (suite === undefined || r.suite === suite));
  return mergeStepsSummaries(mine.map((r) => r.synth ?? emptyStepsSummary()));
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)} %`;
}

/** The R-d histogram, largest bucket first. */
export function declineHistogram(s: StepsSummary): { reason: string; n: number; share: number }[] {
  const total = Object.values(s.fastPath.reasons).reduce((a, b) => a + b, 0);
  return Object.entries(s.fastPath.reasons)
    .map(([reason, n]) => ({ reason, n, share: total === 0 ? 0 : n / total }))
    .sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason));
}

/**
 * §8.3: the five rows for one arm. `suites` is the set R-c is evaluated per — a ratio pooled over QuixBugs and SWE hides
 * exactly the miscalibration it exists to find, so the row fails if ANY suite is over the bar and says which.
 */
export function measurementRows(records: readonly BenchRecord[], condition: BenchCondition, suites: readonly BenchSuite[]): MeasurementRow[] {
  const all = armSteps(records, condition);
  const armed = all.fastPath.considered > 0;
  const out: MeasurementRow[] = [];

  out.push({
    id: 'R-a',
    title: 'routers.waitMs over every step = 0',
    gating: true,
    status: all.routers.issued === 0 ? 'not_evaluable' : all.routers.maxWaitMs === 0 ? 'pass' : 'fail',
    detail: all.routers.issued === 0 ? 'no router was issued in this arm (the table is off, or no step reached a routed site)' : `max ${all.routers.maxWaitMs} ms over ${all.routers.issued} issued (${all.routers.applied} applied, ${all.routers.dropped} dropped)`,
  });

  out.push({
    id: 'R-b',
    title: 'fastPath.wallMs <= budgetMs on every fired step',
    gating: true,
    status: all.fastPath.fired === 0 ? 'not_evaluable' : all.fastPath.budgetOverruns === 0 ? 'pass' : 'fail',
    detail: all.fastPath.fired === 0 ? 'no step fired' : `${all.fastPath.fired - all.fastPath.budgetOverruns}/${all.fastPath.fired} within budget, total ${formatDuration(all.fastPath.wallMs)}`,
  });

  const perSuite = suites.map((suite) => ({ suite, s: armSteps(records, condition, suite) })).filter((x) => x.s.fastPath.stage1Fired > 0 || x.s.fastPath.stage2Declined > 0);
  const ratios = perSuite.map((x) => ({ suite: x.suite, ratio: x.s.fastPath.stage1Fired === 0 ? null : x.s.fastPath.stage2Declined / x.s.fastPath.stage1Fired, s: x.s }));
  const over = ratios.filter((r) => r.ratio !== null && r.ratio > STAGE2_DECLINE_BAR);
  out.push({
    id: 'R-c',
    title: `stage-2 declines / stage-1 fired, per suite <= ${STAGE2_DECLINE_BAR}`,
    gating: true,
    status: ratios.length === 0 ? 'not_evaluable' : over.length === 0 ? 'pass' : 'fail',
    detail: ratios.length === 0 ? 'no step reached the predicate' : ratios.map((r) => `${r.suite} ${r.s.fastPath.stage2Declined}/${r.s.fastPath.stage1Fired} = ${r.ratio === null ? 'n/a' : r.ratio.toFixed(2)}`).join(', ') + (over.length === 0 ? '' : ` — over the bar on ${over.map((r) => r.suite).join(', ')}: the predicate is wrong, not the budget (R-d names the clause)`),
  });

  const hist = declineHistogram(all);
  const unknown = hist.filter((h) => !FASTPATH_REASONS.includes(h.reason)).map((h) => h.reason);
  const errorBucket = hist.find((h) => h.reason === 'error') ?? null;
  const errorOver = errorBucket !== null && errorBucket.share > ERROR_BUCKET_BAR;
  out.push({
    id: 'R-d',
    title: `per-reason decline histogram, exhaustive, no 'error' bucket > ${pct(ERROR_BUCKET_BAR)}`,
    gating: true,
    status: !armed ? 'not_evaluable' : hist.length === 0 ? 'not_evaluable' : errorOver || unknown.length > 0 ? 'fail' : 'pass',
    detail: hist.length === 0 ? 'no decline recorded' : `${hist.map((h) => `${h.reason} ${h.n} (${pct(h.share)})`).join(', ')}${unknown.length > 0 ? ` — NOT in FastPathReason: ${unknown.join(', ')}` : ''}${errorOver ? ' — the error bucket is over the bar' : ''}`,
  });

  out.push({
    id: 'R-e',
    title: "riskSource: 'code' and jevUnavailable counts",
    gating: false,
    status: 'reported',
    // §2.4: the ratification is reverted by a HARMFUL command allowed under a dropped ask. That judgement is made by
    // reading the steps, not by a counter, so the row reports the two counts and says what would revert it.
    detail: `code verdicts ${all.risk.codeVerdicts}, Jev unavailable ${all.risk.jevUnavailable} over ${all.steps} step(s) — any step where a HARMFUL command was allowed under a dropped ask reverts the §2.4 ratification`,
  });
  return out;
}

// ---------------------------------------------------------------------------------------
// §8.4 predictions
// ---------------------------------------------------------------------------------------

export interface PredictionResult {
  id: 'a' | 'b' | 'c' | 'd' | 'e' | 'f';
  title: string;
  status: RowStatus;
  detail: string;
  /** §8.4: (a) or (e) failing RETIRES route R9; it never loosens the predicate */
  retiresR9: boolean;
}

const solvedOf = (records: readonly BenchRecord[], condition: BenchCondition, suite?: BenchSuite): { solved: number; n: number } => {
  const mine = records.filter((r) => r.condition === condition && isEvaluated(r) && (suite === undefined || r.suite === suite));
  return { solved: mine.filter((r) => r.pass === true).length, n: mine.length };
};

/** Median wall over the tasks BOTH arms solved (the §8.4 (b) shape: a wall comparison over anything else is not one). */
export function bothSolvedMedianWallMs(records: readonly BenchRecord[], a: BenchCondition, b: BenchCondition): { n: number; a: number | null; b: number | null } {
  const byTask = new Map<string, Map<BenchCondition, BenchRecord>>();
  for (const r of records) {
    const key = `${r.suite}\u0000${r.task}`;
    const m = byTask.get(key) ?? new Map<BenchCondition, BenchRecord>();
    m.set(r.condition, r);
    byTask.set(key, m);
  }
  const wallsA: number[] = [];
  const wallsB: number[] = [];
  for (const m of byTask.values()) {
    const ra = m.get(a);
    const rb = m.get(b);
    if (ra?.pass !== true || rb?.pass !== true) continue;
    wallsA.push(ra.wallMs);
    wallsB.push(rb.wallMs);
  }
  return { n: wallsA.length, a: median(wallsA), b: median(wallsB) };
}

export interface PredictionInput {
  records: readonly BenchRecord[];
  /** the arm under test (`jev-on-next`) */
  arm: BenchCondition;
  /** the paired same-build control (`jev-on-next-nofast`) */
  control: BenchCondition;
  /** the ladder long-2 task ids of the fresh slice (§8.4 (c): >= 3/6) */
  ladderLong2?: readonly string[];
}

/** §8.4 (a)…(f) over the merged records. (b) is checked against the recorded rows, which is exactly the confounded comparison §8.2 warns about — the detail says so. */
export function evaluatePredictions(input: PredictionInput): PredictionResult[] {
  const { records, arm, control } = input;
  const out: PredictionResult[] = [];
  const mine = solvedOf(records, arm);
  const ref = recorded('fresh-18', 'llm-jev');

  const refSolved = ref?.solved ?? 12;
  const refN = ref?.n ?? 18;
  // A solve COUNT is only comparable over the same slice. A partial run of 5 of the 18 tasks would otherwise read
  // "4 < 12: FAIL", and (a) failing retires route R9 — a slice that was never finished must not retire a route.
  const sameSlice = mine.n === refN;
  out.push({
    id: 'a',
    title: `solved >= llm-jev's ${refSolved}/${refN} on the fresh slice`,
    status: mine.n === 0 || !sameSlice ? 'not_evaluable' : mine.solved >= refSolved ? 'pass' : 'fail',
    detail:
      mine.n === 0
        ? `no evaluated ${arm} record`
        : !sameSlice
          ? `${arm} ${mine.solved}/${mine.n}: NOT the recorded slice of ${refN} tasks, so a solve count is not comparable — run the fresh 18 (a partial slice must not retire route R9)`
          : `${arm} ${mine.solved}/${mine.n} against the recorded ${refSolved}/${refN} at ${RECORDED_BUILD} (${RECORDED_SOURCE}) — build-drift confounded, see §8.2`,
    retiresR9: true,
  });

  const wall = bothSolvedMedianWallMs(records, arm, 'jev-off-tuned');
  const tunedRef = recorded('fresh-18', 'jev-off-tuned');
  const llmRef = recorded('fresh-18', 'llm-jev');
  const withinTuned = wall.a !== null && tunedRef?.bothSolvedMedianWallMs != null ? wall.a <= tunedRef.bothSolvedMedianWallMs * 1.1 : null;
  const underLlmJev = wall.a !== null && llmRef?.bothSolvedMedianWallMs != null ? wall.a < llmRef.bothSolvedMedianWallMs : null;
  out.push({
    id: 'b',
    title: "median wall on the both-solved tasks below llm-jev's 26.0 s and within 10 % of tuned's 19.7 s",
    status: wall.a === null || withinTuned === null || underLlmJev === null ? 'not_evaluable' : withinTuned && underLlmJev ? 'pass' : 'fail',
    detail: wall.a === null ? 'no task solved by both the arm and jev-off-tuned in these records' : `${formatDuration(wall.a)} over ${wall.n} both-solved task(s) (paired tuned ${wall.b === null ? 'n/a' : formatDuration(wall.b)}); recorded llm-jev 26.0 s, tuned 19.7 s — a 45 s budget spent on a task the generator solves in 20 s is a 2× regression, not a footnote`,
    retiresR9: false,
  });

  const long2 = input.ladderLong2 ?? [];
  const long2Solved = records.filter((r) => r.condition === arm && long2.includes(r.task) && r.pass === true).length;
  out.push({
    id: 'c',
    title: 'the ladder long-2 tier keeps >= 3/6',
    status: long2.length === 0 ? 'not_evaluable' : long2Solved >= 3 ? 'pass' : 'fail',
    detail: long2.length === 0 ? 'the long-2 task ids were not given' : `${long2Solved}/${long2.length} (recorded llm-jev 4/6, jev-off-tuned 0/6)`,
    retiresR9: false,
  });

  const routers = armSteps(records, arm).routers;
  out.push({
    id: 'd',
    title: 'routerWaitMs p95 = 0 on every step',
    status: routers.issued === 0 ? 'not_evaluable' : routers.maxWaitMs === 0 ? 'pass' : 'fail',
    detail: routers.issued === 0 ? 'no router issued' : `max ${routers.maxWaitMs} ms over ${routers.issued} issued (R-a, same input)`,
    retiresR9: false,
  });

  const fp = armSteps(records, arm).fastPath;
  const firedShare = fp.stage1Fired === 0 ? null : fp.proposed / fp.stage1Fired;
  out.push({
    id: 'e',
    title: "fired AND proposed on >= 60 % of the QuixBugs steps where stage 1 held",
    status: firedShare === null ? 'not_evaluable' : firedShare >= 0.6 ? 'pass' : 'fail',
    detail: firedShare === null ? 'stage 1 held on no step' : `${fp.proposed}/${fp.stage1Fired} = ${pct(firedShare)}`,
    retiresR9: true,
  });

  const ctrl = solvedOf(records, control);
  out.push({
    id: 'f',
    title: `${arm} - ${control} on solve count > 0`,
    status: ctrl.n === 0 || mine.n === 0 ? 'not_evaluable' : mine.solved - ctrl.solved > 0 ? 'pass' : 'fail',
    detail: ctrl.n === 0 ? `the ${control} control has no evaluated record — without it a win confounds tuned generation + S2 + routers + the fast path` : `${mine.solved}/${mine.n} vs ${ctrl.solved}/${ctrl.n} (delta ${mine.solved - ctrl.solved})`,
    retiresR9: false,
  });
  return out;
}

// ---------------------------------------------------------------------------------------
// §8.5 the accept rule
// ---------------------------------------------------------------------------------------

export interface AcceptClause {
  n: 1 | 2 | 3 | 4 | 5;
  title: string;
  status: RowStatus;
  detail: string;
}

export interface AcceptVerdict {
  clauses: AcceptClause[];
  /** every clause passes; a `not_evaluable` clause is NOT an accept */
  accept: boolean;
  /** §8.4: (a) or (e) failed — route R9 is retired, the predicate is not loosened */
  retireR9: boolean;
}

export interface AcceptInput extends PredictionInput {
  rows: readonly MeasurementRow[];
  predictions: readonly PredictionResult[];
  /** clause 1 is a tree fact, not a number in these records: the §7 gates including Ring 1 under `--jev off` */
  gatesGreen: boolean | null;
}

/** §8.5: the wave is accepted when all five hold. Clause 4 has the documented escape — retire R9 and ship S2 + routers alone. */
export function evaluateAcceptRule(input: AcceptInput): AcceptVerdict {
  const row = (id: MeasurementRow['id']): MeasurementRow | undefined => input.rows.find((r) => r.id === id);
  const pred = (id: PredictionResult['id']): PredictionResult | undefined => input.predictions.find((p) => p.id === id);
  const worst = (xs: readonly { status: RowStatus }[]): RowStatus => (xs.some((x) => x.status === 'fail') ? 'fail' : xs.some((x) => x.status === 'not_evaluable') ? 'not_evaluable' : 'pass');

  const abc = [row('R-a'), row('R-b'), row('R-c')].filter((r): r is MeasurementRow => r !== undefined);
  const ab = [pred('a'), pred('b')].filter((p): p is PredictionResult => p !== undefined);
  const f = pred('f');
  const re = row('R-e');
  const retireR9 = input.predictions.some((p) => p.retiresR9 && p.status === 'fail');

  const clauses: AcceptClause[] = [
    { n: 1, title: 'every §7 gate green on the merged tree, including Ring 1 under `--jev off`', status: input.gatesGreen === null ? 'not_evaluable' : input.gatesGreen ? 'pass' : 'fail', detail: input.gatesGreen === null ? 'not measured here: a tree fact, taken from the gate run, not from these records' : input.gatesGreen ? 'reported green' : 'reported red' },
    { n: 2, title: 'R-a and R-b pass; R-c passes on every suite', status: abc.length < 3 ? 'not_evaluable' : worst(abc), detail: abc.map((r) => `${r.id} ${r.status}`).join(', ') + (abc.some((r) => r.id === 'R-c' && r.status === 'fail') ? ' — or the predicate is revised and the arms re-run' : '') },
    { n: 3, title: 'prediction (a) holds AND (b) holds', status: ab.length < 2 ? 'not_evaluable' : worst(ab), detail: ab.map((p) => `(${p.id}) ${p.status}`).join(', ') },
    {
      n: 4,
      title: 'the paired control attributes the win to the fast path — or R9 is retired and the wave ships as S2 + routers alone',
      status: f === undefined ? 'not_evaluable' : f.status === 'pass' ? 'pass' : retireR9 ? 'pass' : f.status,
      detail: f === undefined ? 'prediction (f) was not evaluated' : f.status === 'pass' ? f.detail : retireR9 ? `(f) ${f.status}, and (a)/(e) already retire route R9 — ship S2 + routers with fastPath defaulted 'off' in every mode` : f.detail,
    },
    { n: 5, title: 'R-e shows no allowed harmful command', status: re === undefined ? 'not_evaluable' : 'reported', detail: re === undefined ? 'R-e was not computed' : `${re.detail}; otherwise §2.4 is reverted and slot B's risk change is backed out independently of the rest` },
  ];
  const accept = clauses.every((c) => c.status === 'pass' || (c.n === 5 && c.status === 'reported'));
  return { clauses, accept, retireR9 };
}

// ---------------------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------------------

const mark = (s: RowStatus): string => (s === 'pass' ? 'pass' : s === 'fail' ? '**FAIL**' : s === 'reported' ? 'reported' : 'n/a');

export function measurementLines(rows: readonly MeasurementRow[]): string[] {
  const out = ['| row | pass condition | status | detail |', '|---|---|---|---|'];
  for (const r of rows) out.push(`| ${r.id} | ${r.title}${r.gating ? '' : ' (reported)'} | ${mark(r.status)} | ${r.detail} |`);
  return out;
}

export function predictionLines(results: readonly PredictionResult[]): string[] {
  const out = ['| prediction | registered before the arms ran | status | detail |', '|---|---|---|---|'];
  for (const p of results) out.push(`| (${p.id})${p.retiresR9 ? ' †' : ''} | ${p.title} | ${mark(p.status)} | ${p.detail} |`);
  out.push('', '† a failure RETIRES route R9 (§8.4); it does not loosen the predicate. A failure of (b) with (a) holding is the one case that permits a *narrowing* retune.');
  return out;
}

export function acceptLines(v: AcceptVerdict): string[] {
  const out = ['| clause | condition | status | detail |', '|---|---|---|---|'];
  for (const c of v.clauses) out.push(`| ${c.n} | ${c.title} | ${mark(c.status)} | ${c.detail} |`);
  out.push('', `**${v.accept ? 'ACCEPT' : 'NOT ACCEPTED'}**${v.retireR9 ? ' — and route R9 is retired under §8.4.' : '.'} The default-mode flip to \`jev-on\` is NOT part of this rule; it is a separate decision on these rows.`);
  return out;
}

/** The §8.2 header every table of this wave carries: what was recorded, at which build, and why the control is the real contrast. */
export function recordedReferenceLines(): string[] {
  const out = [`Recorded reference (${RECORDED_SOURCE}, build \`${RECORDED_BUILD}\`), merged by \`(suite, task, condition)\` and NOT re-run:`, '', '| slice | arm | solved | both-solved median wall | $ | note |', '|---|---|---|---|---|---|'];
  for (const r of RECORDED_ITER1) out.push(`| ${r.slice} | \`${r.condition}\` | ${r.solved}/${r.n} | ${r.bothSolvedMedianWallMs === null ? '—' : formatDuration(r.bothSolvedMedianWallMs)} | ${r.costUsd === null ? '—' : `$${r.costUsd.toFixed(4)}`} | ${r.note} |`);
  out.push(
    '',
    `Build drift, and it is not small: \`main\` carries \`oos-iter-2\` on top of \`${RECORDED_BUILD}\` — nine unmeasured changes. Every comparison against the rows above confounds this wave with all of iteration 2. The \`jev-on-next-nofast\` control and the plain \`jev-on\` arm are the only same-build contrasts, and §8.5 clause 4 rests on the control, not on these rows.`,
  );
  return out;
}
