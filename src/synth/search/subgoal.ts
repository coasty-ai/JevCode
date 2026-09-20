/**
 * The search for one sub-goal (docs/JEV-ONLY-DESIGN.md §2.3): the sieve-or-rank inner loop over
 * phases × bases × sites × sources. Code enumerates, `decideRunPlan` (§2.4) says whether the
 * tests can rank the whole candidate set (SIEVE) or Jev must order it first (RANK), the runner
 * verifies on shadow lanes, and the guard (§2.6) turns run results into a Decision. Jev is asked
 * exactly one question here: Q7 `edit_class`, a *soft* source-order prior (top-1 28–29/40, top-2
 * 35–36/40 over three runs, experiments/designs/grammar-synthesis.md Appendix A); it never
 * removes a source or a site.
 *
 * Pure collaborators (decideRunPlan, the site helpers, commitPartial, commitSuspect) are imported;
 * the ones that touch Jev, the workspace or the sandbox (localisation, the seed sources, the
 * sketch and beam rounds, the ranker, the queue, the runner, the guard, the pairs of partials)
 * are injected through `SubGoalDeps`, so the control flow is unit-tested with fakes and
 * src/synth/index.ts is the one place that names the real modules.
 */
import type { Json, Question, SynthesisContext } from '../../core/types.js';
import { AbortError } from '../../errors.js';
import { ESCAPE_KEY, choice } from '../../jev/questions.js';
import { baseState } from '../beam/state.js';
import { scopeAt } from '../py/structure.js';
import { EDIT_CLASS_IDS } from '../sketch/productions.js';
import type { EditClass } from '../sketch/productions.js';
import { EDIT_CLASSES, EDIT_CLASS_INSTRUCTIONS, EDIT_CLASS_QUESTION_ID } from '../sketch/questions.js';
import type { Candidate, CandidateSource, CandidateSourceName, EnumerateOptions, FailureView, LocalizeResult, RankResult, Site, SourceFile } from '../types.js';
import type { RunnerMemory } from '../sieve/runner.js';
import { applyCandidate } from '../verify/apply.js';
import { commitPartial } from './bases.js';
import type { GuardMemory } from './bases.js';
import { SIEVE_MAX_T_RUN_MS, decideRunPlan, runsLeft } from './budget.js';
import type { SearchOverrides } from './directive.js';
import { commitSuspect } from './guard.js';
import type { SearchMemory } from './memory.js';
import { wasTried } from './memory.js';
import { WIDENED_SITES_MAX, lineEvidenceOf, nextWidenChunk, orderWidenedSites, siteKey, widenedSites } from './sites.js';
import type { Base, Decision, Goal, GoalSearchTrace, OracleModel, Phase, VerifyJob, VerifyOutcome } from './types.js';
import { PHASES } from './types.js';

export { decideRunPlan } from './budget.js';
export { EDIT_CLASSES, EDIT_CLASS_INSTRUCTIONS, EDIT_CLASS_QUESTION_ID } from '../sketch/questions.js';
export type { EditClass } from '../sketch/productions.js';

// ---------------------------------------------------------------------------------------
// Constants (every threshold names its measurement)
// ---------------------------------------------------------------------------------------

/** Candidates per site per source per chunk (§3: "254 per site per chunk"; the 255-option Choice limit minus the escape). */
export const ENUMERATE_CAP = 254;
/** SKETCH runs at the top-3 sites (§2.3 phase table; Q5 top-3 covers 36/40, probe-localization.md). */
export const SKETCH_TOP_SITES = 3;
/** BEAM runs at the top-2 sites (§2.3 phase table: ≤ 48 requests per site, so two sites fit a 60-request step). */
export const BEAM_TOP_SITES = 2;
/** BEAM is entered only with this many Jev requests left (§2.3: "stepBudget.jevRequests ≥ 35 remain"; the beam spends ≤ 31 per line). */
export const BEAM_MIN_JEV_REQUESTS_LEFT = 35;
/** Pairs of partials tested after SEEDS (§2.3 / §4.3: "≤ 10 runs"). */
export const PAIRS_OF_PARTIALS_MAX = 10;
/**
 * The pairs reserve (jev-only-ladder-4-analysis.md §1.2, the `account` partial trap; the guard's
 * HOLD_RESERVE_* are its mirror): while the goal holds complementary partials whose pair is
 * untested, a source batch that would take the step inside this reserve is preceded by the pairs
 * (≤ PAIRS_OF_PARTIALS_MAX runs), and a step that ends on the budget runs them before it returns.
 * ~15 median QuixBugs runs per lane, two lanes' worth of SIEVE batches; on repository-class
 * budgets (16 runs a step) the reserve is the whole step, so the pairs run before the first
 * batch — they are the likeliest fix of a goal that already has two half-fixes.
 */
export const PAIRS_RESERVE_WALL_MS = 15_000;
export const PAIRS_RESERVE_RUNS = 16;
/** Q7 `insert_new_line` at or above this puts templates/donors and insert sites first (§2.7 Q7 consumer; insert_new_line top-1 4/4 in Appendix A). */
export const INSERT_FIRST_MIN_P = 0.5;
/**
 * Q7 is asked up front only when the oracle is slow enough that Jev, not the tests, orders the
 * queue (§2.4: SIEVE applies at t_run ≤ 2,000 ms = budget.SIEVE_MAX_T_RUN_MS, and in SIEVE mode
 * the whole set runs, so the order does not matter). On fast oracles the SKETCH phase asks Q7 in
 * the same request as Q12, at no extra cost.
 */
export const Q7_UPFRONT_MIN_T_RUN_MS = 2000;
/**
 * "Single-file workspace" for WIDENED (§2.3): at most this many non-test Python files. Two,
 * not one, because the QuixBugs graph programs ship `node.py` beside the program and the
 * WIDENED bound (median 23.8 s, max 119 s, contrarian-exhaustive.all.jsonl) was measured on them.
 */
export const SINGLE_FILE_MAX_PY_FILES = 2;
/**
 * WIDENED sites taken per chunk: one SEEDS-sized batch (§2.5 cuts SEEDS at 6 replace sites), so a
 * chunk costs about one SEEDS pass and the run-cost budget, not this number, bounds the step.
 * Implementation granularity, not a measured threshold.
 */
export const WIDEN_CHUNK_SITES = 6;
/** Mutation operators that permute tokens; put first when Q7 says `reorder_tokens` / `reshape_line` (§3 reordering rule). */
export const PERMUTATION_OPERATORS: readonly string[] = ['argument_swap', 'operand_swap', 'index_flip', 'keyword_flip'];
/** Tiny decrement that encodes list position in the queue key so a source's own order survives the (p desc) sort. */
const SIEVE_ORDER_EPSILON = 1e-4;
/**
 * Best-guess search (no reproduction oracle): sources 1–3 at the localiser's top sites, ranked by
 * Jev, the top-k run against the scoped regression suite only (§2.4 RANK; the oracle model classes
 * a repository step as expensive). Three sites is the SKETCH bound (Q5 top-3 covers 36/40).
 */
export const BEST_GUESS_TOP_SITES = 3;
/** Test-derived literals handed to the sources (§3 "test-derived values"); bounded so a long expected list does not flood the pool. */
const MAX_TEST_LITERALS = 40;
const MAX_TASK_IDENTIFIERS = 60;

// ---------------------------------------------------------------------------------------
// Q7 edit_class, standalone (the measured wording and options live in sketch/questions.ts)
// ---------------------------------------------------------------------------------------

export function editClassQuestion(): Question {
  const options: Record<string, Json> = {};
  for (const c of EDIT_CLASS_IDS) options[c] = EDIT_CLASSES[c];
  return choice(EDIT_CLASS_INSTRUCTIONS, options);
}

export interface EditClassPrior {
  probabilities: Readonly<Record<EditClass, number>>;
  escape: number;
  /** argmax over the six classes, or null when the escape wins */
  top: EditClass | null;
}

/** Turn a Q7 answer into a prior; null when the answer is missing or not a Choice. */
export function priorFromAnswer(answer: { type: string; probabilities?: Record<string, number> } | undefined): EditClassPrior | null {
  if (answer === undefined || answer.type !== 'choice' || answer.probabilities === undefined) return null;
  const probabilities = {} as Record<EditClass, number>;
  let top: EditClass | null = null;
  let best = -1;
  for (const k of EDIT_CLASS_IDS) {
    const p = answer.probabilities[k] ?? 0;
    probabilities[k] = p;
    if (p > best) {
      best = p;
      top = k;
    }
  }
  const escape = answer.probabilities[ESCAPE_KEY] ?? 0;
  return { probabilities, escape, top: escape > best ? null : top };
}

/** One Q7 request at `site` over the measured state (marked listing, buggy line, tests), through ctx.ask so it is recorded (§2.7). */
export async function askEditClassPrior(ctx: SynthesisContext, goal: Goal, site: Site): Promise<EditClassPrior | null> {
  const res = await ctx.ask('propose', baseState(site, ctx.task, goal.failures), { [EDIT_CLASS_QUESTION_ID]: editClassQuestion() });
  return priorFromAnswer(res.answers[EDIT_CLASS_QUESTION_ID]);
}

// ---------------------------------------------------------------------------------------
// Source order (§3 "Reordering by Q7 (soft)")
// ---------------------------------------------------------------------------------------

/** The three concrete seed sources (§3 rows 1–3); composite (row 4) is gated behind them. */
export const SEED_SOURCES: readonly CandidateSourceName[] = ['mutation', 'template', 'donor'];

function insertFirst(prior: EditClassPrior | null): boolean {
  return prior !== null && prior.probabilities.insert_new_line >= INSERT_FIRST_MIN_P;
}

function permutationFirst(prior: EditClassPrior | null): boolean {
  return prior !== null && (prior.top === 'reorder_tokens' || prior.top === 'reshape_line');
}

function rotate<T>(xs: readonly T[], n: number): T[] {
  if (xs.length === 0) return [];
  const k = ((n % xs.length) + xs.length) % xs.length;
  return [...xs.slice(k), ...xs.slice(0, k)];
}

/**
 * Sources to try at one site in one phase, in order, minus the ones already exhausted there.
 * SEEDS: 1 mutation, 2 templates, 3 donors, then 4 composite once 1–3 are exhausted at the site.
 * Q7 `insert_new_line` ≥ 0.5 → 2, 3, 1, 4; `reorder_tokens` / `reshape_line` → 1 (permutation
 * operators first, see orderCandidates) then 4 (depth-2 pairs of swaps, gated on 1 alone), then
 * 2, 3. `rotation` is the `change_approach` directive's left rotation of the seed order (§5.4).
 * Nothing is ever skipped: the prior only decides which source spends the budget first.
 * SKETCH and BEAM have one source each (their candidates are keyed `token_beam` here); WIDENED
 * re-runs 1–3 over every code line of the located functions.
 */
export function orderSources(phase: Phase, prior: EditClassPrior | null, exhausted: ReadonlySet<CandidateSourceName>, rotation = 0): CandidateSourceName[] {
  let order: CandidateSourceName[];
  switch (phase) {
    case 'SEEDS': {
      const seedsDone = SEED_SOURCES.every((s) => exhausted.has(s));
      if (insertFirst(prior)) order = [...rotate(['template', 'donor', 'mutation'] as const, rotation), ...(seedsDone ? (['composite'] as const) : [])];
      else if (permutationFirst(prior)) order = ['mutation', ...(exhausted.has('mutation') ? (['composite'] as const) : []), ...rotate(['template', 'donor'] as const, rotation)];
      else order = [...rotate(SEED_SOURCES, rotation), ...(seedsDone ? (['composite'] as const) : [])];
      break;
    }
    case 'WIDENED':
      order = rotate(insertFirst(prior) ? ['template', 'donor', 'mutation'] : [...SEED_SOURCES], rotation);
      break;
    case 'SKETCH':
    case 'BEAM':
      order = ['token_beam'];
      break;
  }
  return order.filter((s) => !exhausted.has(s));
}

/** Insert sites first when Q7 puts ≥ 0.5 on `insert_new_line` (§2.5 rule 2); otherwise the localiser's order stands. */
export function orderSites(sites: readonly Site[], prior: EditClassPrior | null): Site[] {
  if (!insertFirst(prior)) return [...sites];
  return [...sites.filter((s) => s.kind === 'insert'), ...sites.filter((s) => s.kind !== 'insert')];
}

/** Stable: permutation-operator mutants first when the prior says the fix reorders tokens; the source's own order otherwise. */
export function orderCandidates(cands: readonly Candidate[], prior: EditClassPrior | null): Candidate[] {
  if (!permutationFirst(prior)) return [...cands];
  return [...cands.filter((c) => PERMUTATION_OPERATORS.includes(c.op)), ...cands.filter((c) => !PERMUTATION_OPERATORS.includes(c.op))];
}

/** Position-derived prior of a source in the current order (ordering only, never a Jev substitute). */
export function sourcePriorAt(index: number): number {
  return Math.max(0.1, 1 - index / 10);
}

// ---------------------------------------------------------------------------------------
// Collaborator contracts (the §6 table, as this module consumes them)
// ---------------------------------------------------------------------------------------

/** The run memory this loop reads: the §2.1 record, the guard's beam of bases, the directive overrides and the runner's pending retries (drained at step end). */
export type SubGoalMemory = SearchMemory & GuardMemory & { overrides: SearchOverrides } & Partial<Pick<RunnerMemory, 'retryTimeouts'>>;

/** What a Jev-driven source (SKETCH: sketch Choice → slot fill; BEAM: token beam) returns for one site. */
export interface JevEnumeration {
  candidates: Candidate[];
  requests: number;
  /** Q7 answered in the same request as Q12 (SKETCH only), adopted when no prior was asked up front */
  editClass?: EditClassPrior;
}

export interface JevSourceInput {
  ctx: SynthesisContext;
  mem: SubGoalMemory;
  goal: Goal;
  site: Site;
  opts: EnumerateOptions;
  /** the prior already known; the SKETCH source's Q12 request carries Q7 regardless (one request) */
  prior: EditClassPrior | null;
}

export interface JevSource {
  enumerate(input: JevSourceInput): Promise<JevEnumeration>;
}

/**
 * The verification queue as this loop and the runner see it: sieve/queue.ts's VerifyQueue
 * (dedupe by text, unchanged-line removal, vocabulary check, `tried` exclusion; `addAll` reports
 * what was queued) with the runner's `pop(n)` (sieve/runner.ts JobQueue).
 */
export interface SearchQueue {
  readonly size: number;
  addAll(jobs: Iterable<VerifyJob>): { queued: readonly VerifyJob[] };
  pop(n: number): VerifyJob[];
}

/** The guard's Decision plus the bookkeeping guard.ts's GuardDecision carries (optional so a plain Decision fits). */
export type GuardVerdict = Decision & { plausible?: number; clusters?: number; arbitrated?: boolean; requests?: number };

export interface SubGoalDeps {
  /** §2.5 for one goal: the localizer's beam plus search/sites.ts buildGoalSites; `sites` in visiting order, `functions` for WIDENED, requests counted */
  locate(ctx: SynthesisContext, mem: SubGoalMemory, goal: Goal): Promise<LocalizeResult>;
  seeds: { mutation: CandidateSource; template: CandidateSource; donor: CandidateSource; composite: CandidateSource };
  sketch: JevSource;
  beam: JevSource;
  /** src/synth/rank over the goal's failures and the site's function listing (Q8/Q9/Q10 by N) */
  rank(ctx: SynthesisContext, mem: SubGoalMemory, cands: readonly Candidate[], site: Site, goal: Goal): Promise<RankResult>;
  createQueue(ctx: SynthesisContext, mem: SubGoalMemory, goal: Goal): SearchQueue;
  /** sieve/runner.ts runQueue: lanes, adaptive timeout, goal-subset then full-suite runs; charges the StepBudget and `tried` */
  runQueue(ctx: SynthesisContext, mem: SubGoalMemory, queue: SearchQueue, goal: Goal, runsAllowed: number): Promise<VerifyOutcome[]>;
  /** search/guard.ts decideForSearch (§2.6) */
  decide(ctx: SynthesisContext, mem: SubGoalMemory, goal: Goal, results: readonly VerifyOutcome[]): Promise<GuardVerdict>;
  /** search/bases.ts pairsOfPartials: ≤ 10 composite candidates joining two partials of different sites */
  pairsOfPartials(mem: SubGoalMemory, goal: Goal): Candidate[];
}

export type SubGoalResult = Decision & { trace: GoalSearchTrace };

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

/** Key of goal.exhausted for a site in a phase. SKETCH gets its own key because its candidates share the `token_beam` name with BEAM. */
export function exhaustedKey(site: Site, phase: Phase): string {
  return phase === 'SKETCH' ? `${siteKey(site)}#SKETCH` : siteKey(site);
}

function exhaustedAt(goal: Goal, site: Site, phase: Phase): Set<CandidateSourceName> {
  const key = exhaustedKey(site, phase);
  let set = goal.exhausted.get(key);
  if (set === undefined) {
    set = new Set();
    goal.exhausted.set(key, set);
  }
  return set;
}

export function seedsExhaustedAt(goal: Goal, site: Site): boolean {
  const set = goal.exhausted.get(siteKey(site));
  return set !== undefined && SEED_SOURCES.every((s) => set.has(s));
}

const TEST_PATH = /(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*\.py$|_tests?\.py$|(^|\/)conftest\.py$/;
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/** Single-file rule for WIDENED (§2.3): ≤ SINGLE_FILE_MAX_PY_FILES non-test Python files in the committed base. */
export function isSingleFileWorkspace(files: ReadonlyMap<string, SourceFile>): boolean {
  let n = 0;
  for (const path of files.keys()) if (path.endsWith('.py') && !isTestPath(path)) n += 1;
  return n <= SINGLE_FILE_MAX_PY_FILES;
}

/** Numbers, quoted strings and value keywords from the goal's failures (call, expected, actual), deduplicated and bounded. */
export function testLiterals(failures: readonly FailureView[]): string[] {
  const out = new Set<string>();
  const re = /-?\d+(?:\.\d+)?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\b(?:True|False|None)\b/g;
  for (const f of failures) {
    for (const text of [f.call, f.expected, f.actual]) {
      for (const m of text.matchAll(re)) {
        if (out.size >= MAX_TEST_LITERALS) return [...out];
        out.add(m[0]);
      }
    }
  }
  return [...out];
}

/** Backticked words and identifier-shaped tokens (with `_`, a digit or camelCase) from the task text. */
export function taskIdentifiers(task: string): string[] {
  const out = new Set<string>();
  for (const m of task.matchAll(/`([^`\n]+)`/g)) {
    const inner = m[1] ?? '';
    for (const id of inner.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) out.add(id[0]);
  }
  for (const m of task.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const id = m[0];
    if (/_|\d|[a-z][A-Z]/.test(id) && id.length >= 2) out.add(id);
  }
  return [...out].slice(0, MAX_TASK_IDENTIFIERS);
}

export function enumerateOptions(base: Base, goal: Goal, task: string): EnumerateOptions {
  return { cap: ENUMERATE_CAP, testLiterals: testLiterals(goal.failures), taskIdentifiers: taskIdentifiers(task), corpus: base.files };
}

/**
 * The site as seen on `base`: unchanged on the committed base; on an 'improved' base the file is
 * the base's copy, kept only when the line still reads `currentLine` (a partial that shifted the
 * line makes the site stale there; applyCandidate would refuse it anyway).
 */
export function siteOnBase(site: Site, base: Base): Site | null {
  if (base.origin === 'committed') return site;
  const f = base.files.get(site.file.path);
  if (f === undefined) return null;
  if (site.kind === 'replace' && (f.mod.lines[site.line - 1] ?? null) !== site.currentLine) return null;
  if (site.kind === 'insert' && site.line > f.mod.lines.length + 1) return null;
  return { ...site, file: f, scope: scopeAt(f.mod, site.line) };
}

/** True when the candidate's diff on `base` was already run this run (§2.3 `\ mem.tried`); a stale site counts as tried (nothing to run). */
export function alreadyTried(c: Candidate, base: Base, mem: Pick<SearchMemory, 'tried'>): boolean {
  try {
    return wasTried(mem, applyCandidate(c, base.files).diff);
  } catch {
    return true;
  }
}

function jobsFor(cands: readonly Candidate[], base: Base, sourcePrior: number, p: (c: Candidate, i: number) => number): VerifyJob[] {
  return cands.map((candidate, i) => {
    const pi = p(candidate, i);
    return { candidate, base, p: pi, sourcePrior, key: [base.summary.passed, pi, sourcePrior] };
  });
}

function emptyBySource(): GoalSearchTrace['bySource'] {
  const zero = (): { enumerated: number; tested: number; passed: number } => ({ enumerated: 0, tested: 0, passed: 0 });
  return { mutation: zero(), template: zero(), donor: zero(), token_beam: zero(), test_value: zero(), history: zero(), composite: zero() };
}

export function newTrace(goal: Goal, oracle: OracleModel): GoalSearchTrace {
  return {
    sitesConsidered: 0,
    candidatesEnumerated: 0,
    candidatesRanked: 0,
    candidatesTested: 0,
    jevRequests: 0,
    testRuns: 0,
    bySource: emptyBySource(),
    outcome: 'no_progress',
    goalId: goal.id,
    phase: goal.phase,
    runMode: 'SIEVE',
    plausible: 0,
    clusters: 0,
    arbitrated: false,
    tRunMs: oracle.tRunMs.goalSubset,
    sitesTested: 0,
    newSitesTested: 0,
  };
}

/** §5.3: every located site of the goal has its seed sources exhausted, so a budget-hit step could test nothing new at the top sites. */
export function everySiteSeedsExhausted(goal: Goal, sites: readonly Site[]): boolean {
  return sites.length > 0 && sites.every((s) => seedsExhaustedAt(goal, s));
}

/** Human-readable park reason (§2.3 `describe(goal.exhausted, sites)`), Jev-visible in openProblems, so no machine state. */
export function describeExhaustion(goal: Goal, sites: readonly Site[]): string {
  const sources = new Set<string>();
  for (const set of goal.exhausted.values()) for (const s of set) sources.add(s);
  const where = sites.slice(0, 4).map((s) => `${s.file.path}:${s.line}${s.kind === 'insert' ? ' (gap)' : ''}`);
  const more = sites.length > 4 ? `, +${sites.length - 4} more` : '';
  const list = sources.size > 0 ? [...sources].sort().join(', ') : 'every source';
  return `exhausted ${list} at ${sites.length} site${sites.length === 1 ? '' : 's'} (${where.join(', ')}${more}) for ${goal.tests[0] ?? goal.id}${goal.tests.length > 1 ? ` +${goal.tests.length - 1} more` : ''}`;
}

function spend(mem: SubGoalMemory, requests: number): void {
  mem.stepBudget.jevRequestsLeft = Math.max(0, mem.stepBudget.jevRequestsLeft - requests);
}

function checkAborted(ctx: SynthesisContext): void {
  if (ctx.signal.aborted) throw new AbortError('signal');
}

// ---------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------

interface LoopState {
  ctx: SynthesisContext;
  mem: SubGoalMemory;
  goal: Goal;
  deps: SubGoalDeps;
  trace: GoalSearchTrace;
  queue: SearchQueue;
  prior: EditClassPrior | null;
  rotation: number;
  /** a pairs batch is running (its own decision must not trigger another pairs batch) */
  pairing: boolean;
  /** siteKeys with ≥ 1 classified candidate in this step (trace.sitesTested / newSitesTested are counted once per site) */
  sitesThisStep: Set<string>;
}

/**
 * `continue` carries what the batch did: `queued` jobs passed the queue's free pre-checks,
 * `completed` came back classified. The runner stops short of `queued` when the step's wall or
 * run count is spent, the passer cap defers a full-suite run, or the signal fires; the rest is
 * not lost, but the source is not exhausted at the site either (it is enumerated again next step).
 */
type BatchOutcome = { kind: 'exit'; decision: Decision } | { kind: 'continue'; queued: number; completed: number };

const BUDGET_EXIT: BatchOutcome = { kind: 'exit', decision: { kind: 'budget' } };

function note(st: LoopState, phase: string, detail: string): void {
  st.ctx.emit({ type: 'synth', step: st.ctx.step, phase, detail });
}

/**
 * Record classified outcomes on the trace (tests, runs, per-source rows) and the sites they ran
 * at on the goal (`goal.testedSites`, across steps): a budget-hit step whose runs reached a site
 * no earlier step had tested is progress under §5.3, not stagnation. A candidate that did not
 * apply tested nothing.
 */
function recordResults(st: LoopState, results: readonly VerifyOutcome[]): void {
  const { trace, goal } = st;
  trace.candidatesTested += results.length;
  trace.testRuns += results.reduce((n, r) => n + 1 + (r.full === undefined ? 0 : 1), 0);
  const tested = (goal.testedSites ??= new Set<string>());
  for (const r of results) {
    const row = trace.bySource[r.applied.candidate.source];
    row.tested += 1;
    if (r.status === 'plausible') row.passed += 1;
    if (r.status === 'apply_failed') continue;
    const key = siteKey(r.job.candidate.site);
    if (!st.sitesThisStep.has(key)) {
      st.sitesThisStep.add(key);
      trace.sitesTested += 1;
      if (!tested.has(key)) trace.newSitesTested += 1;
    }
    tested.add(key);
  }
}

/** Queue `jobs` and run them (the runner charges the budget and `tried`); nothing is decided here. */
async function runJobs(st: LoopState, jobs: readonly VerifyJob[], runsAllowed: number): Promise<{ queued: readonly VerifyJob[]; results: VerifyOutcome[] }> {
  const { ctx, mem, goal, deps } = st;
  const { queued } = st.queue.addAll(jobs);
  if (queued.length === 0) return { queued, results: [] };
  const results = await deps.runQueue(ctx, mem, st.queue, goal, runsAllowed);
  recordResults(st, results);
  return { queued, results };
}

/** Queue `jobs`, run them, decide. Records tests/plausibles/clusters on the trace. */
async function runBatch(st: LoopState, jobs: readonly VerifyJob[], runsAllowed: number): Promise<BatchOutcome> {
  const { queued, results } = await runJobs(st, jobs, runsAllowed);
  if (queued.length === 0) return { kind: 'continue', queued: 0, completed: 0 };
  return decideBatch(st, results, queued.length);
}

/** The guard's decision on one batch (§2.6), recorded on the trace: one decision per batch, whatever it held. */
async function decideBatch(st: LoopState, results: readonly VerifyOutcome[], queued: number): Promise<BatchOutcome> {
  const { ctx, mem, goal, deps, trace } = st;
  const decision = await deps.decide(ctx, mem, goal, results);
  const plausible = decision.plausible ?? results.filter((r) => r.status === 'plausible').length;
  trace.plausible += plausible;
  trace.clusters += decision.clusters ?? 0;
  if (decision.arbitrated === true || plausible >= 2) trace.arbitrated = true;
  if (decision.requests !== undefined && decision.requests > 0) {
    spend(mem, decision.requests);
    trace.jevRequests += decision.requests;
  }
  if (decision.kind === 'commit') {
    trace.outcome = decision.allGoalTestsPass ? 'fixed' : 'partial';
    trace.winner = decision.applied;
    return { kind: 'exit', decision };
  }
  if (decision.kind === 'budget' || decision.kind === 'parked') return { kind: 'exit', decision };
  // 'continue': no passer, or every passer flagged (the guard keeps the smallest edit as the step's suspect).
  return { kind: 'continue', queued, completed: results.length };
}

// ---------------------------------------------------------------------------------------
// Pairs of partials and their reserve (§2.3 contrarian source 5; jev-only-ladder-4-analysis.md §1.2)
// ---------------------------------------------------------------------------------------

/** The untested pairs of complementary partials of the goal, ≤ PAIRS_OF_PARTIALS_MAX, on the committed base. */
function freshPairs(st: LoopState): { committed: Base; pairs: Candidate[] } | null {
  const committed = st.mem.bases.find((b) => b.origin === 'committed');
  if (committed === undefined) return null;
  const pairs = st.deps.pairsOfPartials(st.mem, st.goal).slice(0, PAIRS_OF_PARTIALS_MAX).filter((c) => !alreadyTried(c, committed, st.mem));
  return pairs.length === 0 ? null : { committed, pairs };
}

/** Runs the step can still spend before the pairs reserve (PAIRS_RESERVE_*) would be touched. */
export function runsBeforeReserve(mem: Pick<SubGoalMemory, 'oracle' | 'stepBudget'>): number {
  const b = mem.stepBudget;
  if (b.testWallLeftMs < PAIRS_RESERVE_WALL_MS || b.testRunsLeft < PAIRS_RESERVE_RUNS) return 0;
  const tRun = Math.max(1, mem.oracle.tRunMs.goalSubset);
  const reserveRuns = Math.max(PAIRS_RESERVE_RUNS, Math.ceil((PAIRS_RESERVE_WALL_MS * Math.max(1, mem.oracle.lanes)) / tRun));
  return Math.max(0, runsLeft(mem.oracle, b) - reserveRuns);
}

/** The pairs are due before a batch of `runs` when the goal holds untested pairs and the batch would take the step inside the reserve. */
function pairsDue(st: LoopState, runs: number): boolean {
  if (st.pairing || runs <= runsBeforeReserve(st.mem)) return false;
  return freshPairs(st) !== null;
}

/**
 * §2.3 line "if phase == SEEDS and pairsOfPartials nonEmpty: test ≤ 10 pairs; commit if one is
 * plausible" — also run before a batch that would spend the pairs reserve, at the start of a
 * step that resumes with remembered partials, and before every `budget` or `parked` exit.
 */
async function visitPairs(st: LoopState): Promise<BatchOutcome> {
  if (st.pairing) return CONTINUE;
  const fresh = freshPairs(st);
  if (fresh === null) return CONTINUE;
  st.pairing = true;
  try {
    st.trace.candidatesEnumerated += fresh.pairs.length;
    for (const c of fresh.pairs) st.trace.bySource[c.source].enumerated += 1;
    note(st, 'pairs', `${st.goal.id}: testing ${fresh.pairs.length} pair${fresh.pairs.length === 1 ? '' : 's'} of complementary partials (runs left ${st.mem.stepBudget.testRunsLeft}, test wall left ${Math.round(st.mem.stepBudget.testWallLeftMs / 1000)} s)`);
    const prior = sourcePriorAt(SEED_SOURCES.length);
    return await runBatch(st, jobsFor(fresh.pairs, fresh.committed, prior, (_c, i) => prior - i * SIEVE_ORDER_EPSILON), fresh.pairs.length);
  } finally {
    st.pairing = false;
  }
}

/**
 * In-flight timeouts the runner re-queued (sieve/runner.ts `mem.retryTimeouts`) run once more
 * before the goal is parked, when the step can still afford a run: a call with nothing new to
 * dispatch (`runsAllowed` 0) is the runner's retry phase alone.
 */
async function drainRetries(st: LoopState): Promise<BatchOutcome> {
  const { ctx, mem, goal, deps } = st;
  const pending = mem.retryTimeouts?.get(goal.id) ?? [];
  if (pending.length === 0 || mem.stepBudget.exhausted()) return CONTINUE;
  note(st, 'retry', `${goal.id}: ${pending.length} re-queued timeout${pending.length === 1 ? '' : 's'} retried before the step ends`);
  const results = await deps.runQueue(ctx, mem, st.queue, goal, 0);
  if (results.length === 0) return CONTINUE;
  recordResults(st, results);
  return decideBatch(st, results, results.length);
}

// ---------------------------------------------------------------------------------------
// Sources at a site
// ---------------------------------------------------------------------------------------

function seedSource(deps: SubGoalDeps, source: CandidateSourceName): CandidateSource {
  return source === 'composite' ? deps.seeds.composite : source === 'template' ? deps.seeds.template : source === 'donor' ? deps.seeds.donor : deps.seeds.mutation;
}

/** §2.3: `\ mem.tried \ {site.currentLine}` (the queue repeats both checks and adds the vocabulary filter), counted on the trace. */
function freshOf(st: LoopState, enumerated: readonly Candidate[], base: Base): Candidate[] {
  const fresh = orderCandidates(enumerated, st.prior).filter((c) => !(c.site.kind === 'replace' && c.text.trim() === c.site.currentLine.trim()) && !alreadyTried(c, base, st.mem));
  st.trace.candidatesEnumerated += fresh.length;
  for (const c of fresh) st.trace.bySource[c.source].enumerated += 1;
  return fresh;
}

/** Enumerate one seed source at one site on one base: its fresh candidates. */
function enumerateSeed(st: LoopState, base: Base, site: Site, source: CandidateSourceName): Candidate[] {
  return freshOf(st, seedSource(st.deps, source).enumerate(site, enumerateOptions(base, st.goal, st.ctx.task)), base);
}

/**
 * Enumerate one source at one site on one base and run what the plan allows. `sitesLeft` counts
 * the phase's sites still to visit, this one included (1 = the last site; §2.4 spreads a cheap
 * oracle's run budget over them). `preEnumerated` hands over candidates `visitSeedBatch` already
 * enumerated (and counted) when the site's union needs Jev's ranking source by source.
 */
async function visitSource(st: LoopState, phase: Phase, base: Base, site: Site, source: CandidateSourceName, position: number, sitesLeft: number, preEnumerated?: readonly Candidate[]): Promise<BatchOutcome> {
  const { ctx, mem, goal, deps, trace } = st;
  const isLastSite = sitesLeft <= 1;
  checkAborted(ctx);
  if (mem.stepBudget.exhausted()) return BUDGET_EXIT;
  const exhausted = exhaustedAt(goal, site, phase);
  let fresh: Candidate[];
  if (preEnumerated !== undefined) fresh = [...preEnumerated];
  else if (phase === 'SKETCH' || phase === 'BEAM') {
    if (mem.stepBudget.jevRequestsLeft <= 0) return BUDGET_EXIT;
    const jev = phase === 'SKETCH' ? deps.sketch : deps.beam;
    const r = await jev.enumerate({ ctx, mem, goal, site, opts: enumerateOptions(base, goal, ctx.task), prior: st.prior });
    spend(mem, r.requests);
    trace.jevRequests += r.requests;
    if (st.prior === null && r.editClass !== undefined) st.prior = r.editClass;
    fresh = freshOf(st, r.candidates, base);
  } else fresh = enumerateSeed(st, base, site, source);
  if (fresh.length === 0) {
    exhausted.add(source);
    return { kind: 'continue', queued: 0, completed: 0 };
  }
  const plan = decideRunPlan(fresh, site, mem.oracle, mem.stepBudget, { sitesLeft });
  trace.runMode = plan.mode;
  // §2.4 `runsLeft` is 0 (the wall left cannot fit one measured run, or no run is left): nothing
  // could be verified this step, so no ranking request is spent on it; the step ends here.
  if (plan.runsAllowed <= 0) return BUDGET_EXIT;
  // the pairs reserve: untested pairs of complementary partials run before a batch that would spend it
  if (pairsDue(st, plan.runsAllowed)) {
    const p = await visitPairs(st);
    if (p.kind === 'exit') return p;
  }
  const sourcePrior = sourcePriorAt(position);
  let jobs: VerifyJob[];
  let everythingQueued: boolean;
  if (plan.mode === 'SIEVE') {
    jobs = jobsFor(fresh, base, sourcePrior, (_c, i) => sourcePrior - i * SIEVE_ORDER_EPSILON);
    everythingQueued = true;
  } else {
    if (mem.stepBudget.jevRequestsLeft <= 0) return BUDGET_EXIT;
    const ranked = await deps.rank(ctx, mem, fresh, site, goal);
    spend(mem, ranked.requests);
    trace.jevRequests += ranked.requests;
    trace.candidatesRanked += ranked.ranked.length;
    // §2.3: switch sources before a run is spent, except at the last site and at gaps (insert sets sit at Noul 0.33–0.39, probe-selection.md).
    if (ranked.fixProbablyAbsent && !isLastSite && site.kind === 'replace') {
      exhausted.add(source);
      return { kind: 'continue', queued: 0, completed: 0 };
    }
    const top = ranked.ranked.slice(0, plan.k);
    jobs = top.map((r) => ({ candidate: r.candidate, base, p: r.probability, sourcePrior, key: [base.summary.passed, r.probability, sourcePrior] }));
    everythingQueued = top.length >= fresh.length;
  }
  const out = await runBatch(st, jobs, plan.runsAllowed);
  // Everything was queued AND ran → the source is exhausted at the site. A RANK cut leaves the
  // rest enumerable for the next step (§2.3); so does a batch the runner cut short (wall, run
  // count, deferred passers): the candidates it did not classify are not in `tried` and come back.
  // On an `exit` a commit means the tests decided (the rest of the set is moot for this goal);
  // a budget/parked exit means the runner may have stopped short, so the source stays open.
  const completed = out.kind === 'continue' ? out.completed >= out.queued : out.decision.kind === 'commit';
  if (everythingQueued && completed) exhausted.add(source);
  return out;
}

const CONTINUE: BatchOutcome = { kind: 'continue', queued: 0, completed: 0 };

/**
 * jev-only-rungs-1-2.md §13.4 (a), the controller-side form of "decide sees the whole site
 * batch": in SEEDS and WIDENED on a SIEVE oracle the seed sources still open at a site are
 * enumerated together and, when their union fits the run budget (§2.4 SIEVE), queued as ONE batch
 * and decided ONCE. The sources whose every queued candidate completed are marked exhausted
 * BEFORE the decision, so the guard's rule (a) (`sieveHoldApplies` reads `goal.exhausted`) sees
 * the site's seed batch as done and a lone passer is committed here rather than held for the next
 * site's decision (run 3 committed `detect_cycle`'s and `wrap`'s first lone passer while their
 * gold's site was unvisited; the guard's hold then waited on a `visitSource` that found nothing
 * fresh and made no decision). A site with nothing fresh consumes no decision. When the union
 * needs RANK (Jev orders each set), the sources are visited one by one from the same enumeration.
 */
async function visitSeedBatch(st: LoopState, phase: Phase, base: Base, site: Site, sitesLeft: number, exhausted: Set<CandidateSourceName>, visited: Set<CandidateSourceName>): Promise<BatchOutcome> {
  const { ctx, mem, trace } = st;
  checkAborted(ctx);
  if (mem.stepBudget.exhausted()) return BUDGET_EXIT;
  const order = orderSources(phase, st.prior, exhausted, st.rotation).filter((s) => SEED_SOURCES.includes(s));
  if (order.length === 0) return CONTINUE;
  const positions = orderSources(phase, st.prior, new Set(), st.rotation);
  const sets = order.map((source) => ({ source, position: Math.max(0, positions.indexOf(source)), fresh: enumerateSeed(st, base, site, source) }));
  for (const s of sets) visited.add(s.source);
  const union = sets.flatMap((s) => s.fresh);
  if (union.length === 0) {
    for (const s of sets) exhausted.add(s.source);
    return CONTINUE;
  }
  const plan = decideRunPlan(union, site, mem.oracle, mem.stepBudget);
  trace.runMode = plan.mode;
  if (plan.runsAllowed <= 0) return BUDGET_EXIT;
  if (plan.mode !== 'SIEVE') {
    for (const s of sets) {
      if (s.fresh.length === 0) {
        exhausted.add(s.source);
        continue;
      }
      const r = await visitSource(st, phase, base, site, s.source, s.position, sitesLeft, s.fresh);
      if (r.kind === 'exit') return r;
      if (mem.stepBudget.exhausted()) return BUDGET_EXIT;
    }
    return CONTINUE;
  }
  if (pairsDue(st, plan.runsAllowed)) {
    const p = await visitPairs(st);
    if (p.kind === 'exit') return p;
  }
  const jobs = sets.flatMap((s) => {
    const prior = sourcePriorAt(s.position);
    return jobsFor(s.fresh, base, prior, (_c, i) => prior - i * SIEVE_ORDER_EPSILON);
  });
  // the transcript names the site of every batch (the verify event only counts): what the run dissections read the search order from
  note(st, 'site', `${st.goal.id}: ${siteKey(site)}${site.kind === 'insert' ? ` (gap, indent ${site.indent.length})` : ''} on ${base.id}: ${sets.map((s) => `${s.source} ${s.fresh.length}`).join(', ')}${site.evidence.notes.length > 0 ? ` — ${site.evidence.notes.slice(0, 2).join('; ')}` : ''}`);
  const { queued, results } = await runJobs(st, jobs, plan.runsAllowed);
  const completed = new Set(results.map((r) => r.job.candidate.id));
  for (const s of sets) {
    const ids = new Set(s.fresh.map((c) => c.id));
    if (queued.filter((j) => ids.has(j.candidate.id)).every((j) => completed.has(j.candidate.id))) exhausted.add(s.source);
  }
  if (queued.length === 0) return CONTINUE;
  return decideBatch(st, results, queued.length);
}

/** Every source at one site on one base: the seed sources as one batch where SIEVE allows, then the rest (composite, or every source under RANK) one by one. `sitesLeft` as in `visitSource`. */
async function visitSite(st: LoopState, phase: Phase, base: Base, site: Site, sitesLeft: number): Promise<BatchOutcome> {
  const { mem, goal } = st;
  const exhausted = exhaustedAt(goal, site, phase);
  const visited = new Set<CandidateSourceName>();
  if ((phase === 'SEEDS' || phase === 'WIDENED') && mem.oracle.tRunMs.goalSubset <= SIEVE_MAX_T_RUN_MS) {
    const r = await visitSeedBatch(st, phase, base, site, sitesLeft, exhausted, visited);
    if (r.kind === 'exit') return r;
    if (mem.stepBudget.exhausted()) return BUDGET_EXIT;
  }
  // Re-derive the order after every source: composite unlocks as soon as 1–3 are exhausted here (§3 row 4).
  for (;;) {
    const source = orderSources(phase, st.prior, exhausted, st.rotation).find((s) => !visited.has(s));
    if (source === undefined) break;
    visited.add(source);
    const position = orderSources(phase, st.prior, new Set(), st.rotation).indexOf(source);
    const r = await visitSource(st, phase, base, site, source, Math.max(0, position), sitesLeft);
    if (r.kind === 'exit') return r;
    if (mem.stepBudget.exhausted()) return BUDGET_EXIT;
  }
  return CONTINUE;
}

async function visitPhase(st: LoopState, phase: Phase, sites: readonly Site[]): Promise<BatchOutcome> {
  const { mem, goal } = st;
  goal.phase = phase;
  st.trace.phase = phase;
  const bases = [...mem.bases.filter((b) => b.origin === 'committed'), ...mem.bases.filter((b) => b.origin !== 'committed')];
  for (const base of bases) {
    for (const [i, raw] of sites.entries()) {
      const site = siteOnBase(raw, base);
      if (site === null) continue;
      const r = await visitSite(st, phase, base, site, sites.length - i);
      if (r.kind === 'exit') return r;
    }
  }
  return CONTINUE;
}

function finish(st: LoopState, decision: Decision): SubGoalResult {
  if (decision.kind === 'commit') {
    st.trace.outcome = decision.allGoalTestsPass ? 'fixed' : 'partial';
    st.trace.winner = decision.applied;
  } else if (decision.kind === 'budget') st.trace.outcome = 'budget';
  else if (decision.kind === 'parked') st.trace.outcome = 'exhausted';
  return { ...decision, trace: st.trace };
}

/**
 * The step ends on its budget (§13.4 (b)): the pairs of partials get their reserve, a passer the
 * guard still holds (rule (a) pending, rule (b) suspect) is committed rather than dropped with
 * the goal's bookkeeping, and only then does the step return `budget`.
 */
async function exitOnBudget(st: LoopState): Promise<SubGoalResult> {
  const pairs = await visitPairs(st);
  if (pairs.kind === 'exit' && pairs.decision.kind === 'commit') return finish(st, pairs.decision);
  const held = commitSuspect(st.mem, st.goal);
  if (held !== null) {
    note(st, 'guard', `${st.goal.id}: the step ends on its budget; committing the held passer${held.kind === 'commit' && held.note !== undefined ? ` as ${held.note}` : ''}`);
    return finish(st, held);
  }
  return finish(st, { kind: 'budget' });
}

function exitOn(st: LoopState, decision: Decision): Promise<SubGoalResult> {
  return decision.kind === 'budget' ? exitOnBudget(st) : Promise.resolve(finish(st, decision));
}

/**
 * Search one sub-goal for one outer step (§2.3). Returns the guard's Decision plus the step's
 * GoalSearchTrace: `commit` (a plausible candidate, the guard's flagged suspect at step end, or
 * the held partial once everything is exhausted), `budget` (the step's caps hit; the search
 * resumes from memory next step), or `parked` with a human-readable reason.
 */
export async function searchSubGoal(ctx: SynthesisContext, mem: SubGoalMemory, goal: Goal, deps: SubGoalDeps): Promise<SubGoalResult> {
  goal.status = 'active';
  const trace = newTrace(goal, mem.oracle);
  checkAborted(ctx);

  // §2.5 sites, cached per goal until a suspected file changes (goals.reopenOnChange / the controller invalidate).
  let loc = mem.localizeCache.get(goal.id);
  if (loc === undefined) {
    loc = await deps.locate(ctx, mem, goal);
    spend(mem, loc.requests);
    trace.jevRequests += loc.requests;
    mem.localizeCache.set(goal.id, loc);
  }
  if (loc.sites.length === 0) {
    trace.outcome = 'exhausted';
    return { kind: 'parked', reason: `no site located for ${goal.tests[0] ?? goal.id}`, trace };
  }

  // Q7 up front only when Jev, not the tests, will order the queue (see Q7_UPFRONT_MIN_T_RUN_MS).
  let prior: EditClassPrior | null = null;
  const first = loc.sites[0];
  if (first !== undefined && mem.oracle.tRunMs.goalSubset > Q7_UPFRONT_MIN_T_RUN_MS && mem.stepBudget.jevRequestsLeft > 0) {
    prior = await askEditClassPrior(ctx, goal, first);
    spend(mem, 1);
    trace.jevRequests += 1;
  }

  const st: LoopState = { ctx, mem, goal, deps, trace, queue: deps.createQueue(ctx, mem, goal), prior, rotation: mem.overrides.sourceRotation[goal.id] ?? 0, pairing: false, sitesThisStep: new Set<string>() };
  const sites = orderSites(loc.sites, prior);
  trace.sitesConsidered = sites.length;
  const committed = mem.bases.find((b) => b.origin === 'committed');
  const singleFile = committed !== undefined && isSingleFileWorkspace(committed.files);

  // Partials remembered from earlier steps (kept across a park, restored from the checkpoint):
  // their untested pairs are the first batch of the step.
  const resumed = await visitPairs(st);
  if (resumed.kind === 'exit') return exitOn(st, resumed.decision);

  for (const phase of PHASES) {
    let r: BatchOutcome = CONTINUE;
    switch (phase) {
      case 'SEEDS': {
        r = await visitPhase(st, phase, orderSites(sites, st.prior));
        if (r.kind === 'continue') r = await visitPairs(st);
        break;
      }
      case 'SKETCH': {
        // Entered where SEEDS is exhausted (fixProbablyAbsent at every seed source counts, §2.3 phase table), top-3 sites only.
        const targets = sites.slice(0, SKETCH_TOP_SITES).filter((s) => seedsExhaustedAt(goal, s));
        if (targets.length > 0) r = await visitPhase(st, phase, targets);
        break;
      }
      case 'BEAM': {
        if (mem.stepBudget.jevRequestsLeft < BEAM_MIN_JEV_REQUESTS_LEFT) break;
        const targets = sites.slice(0, BEAM_TOP_SITES).filter((s) => goal.exhausted.get(exhaustedKey(s, 'SKETCH'))?.has('token_beam') === true);
        if (targets.length > 0) r = await visitPhase(st, phase, targets);
        break;
      }
      case 'WIDENED': {
        // Single-file workspaces only, or repositories under a `change_approach` directive (§2.3, §5.4).
        if (!(singleFile || mem.overrides.widenedOnRepos) || !sites.every((s) => seedsExhaustedAt(goal, s))) break;
        // Every code line and statement gap of the located functions the SEEDS list did not cover,
        // in the order of the localisation's line evidence (Q5 p, Q5n Noul; a gap scores its better
        // neighbour), then distance from the top-1 line, cut at WIDENED_SITES_MAX (sites.ts; `wrap`'s
        // gap before `return lines` sat last in line order and was never reached, §13.4).
        const top = loc.sites.find((s) => s.kind === 'replace') ?? null;
        const all = orderWidenedSites(widenedSites(loc.functions, new Set(sites.map(siteKey))), lineEvidenceOf(loc.sites), top, WIDENED_SITES_MAX);
        trace.sitesConsidered += all.length;
        const cursor0 = mem.widenCursor.get(goal.id) ?? 0;
        const before = { enumerated: trace.candidatesEnumerated, tested: trace.candidatesTested, runs: trace.testRuns };
        if (all.length > 0 && cursor0 < all.length) {
          const gaps = all.filter((s) => s.kind === 'insert').length;
          const head = all.slice(cursor0, cursor0 + 3).map((s) => `${s.file.path}:${s.line}${s.kind === 'insert' ? ` (gap, indent ${s.indent.length})` : ''}`);
          note(st, 'widened', `${goal.id}: ${all.length} sites (${gaps} gaps, ${all.length - gaps} lines) over ${loc.functions.length} function${loc.functions.length === 1 ? '' : 's'}, by line evidence then distance from ${top === null ? 'the top' : `L${top.line}`}, cut ${WIDENED_SITES_MAX}; resuming at ${cursor0}: ${head.join(', ')}`);
        }
        for (;;) {
          const chunk = nextWidenChunk(all, mem.widenCursor.get(goal.id) ?? 0, WIDEN_CHUNK_SITES);
          if (chunk.sites.length === 0) break;
          mem.widenCursor.set(goal.id, chunk.cursor);
          r = await visitPhase(st, phase, orderSites(chunk.sites, st.prior));
          if (r.kind === 'exit' || chunk.done) break;
        }
        const enumerated = trace.candidatesEnumerated - before.enumerated;
        if (enumerated > 0) note(st, 'widened', `${goal.id}: WIDENED cost ${enumerated} candidates enumerated, ${trace.candidatesTested - before.tested} tested, ${trace.testRuns - before.runs} runs; cursor ${mem.widenCursor.get(goal.id) ?? 0}/${all.length}`);
        break;
      }
    }
    if (r.kind === 'exit') return exitOn(st, r.decision);
    if (mem.stepBudget.exhausted()) return exitOnBudget(st);
  }

  // Step end (§2.3 tail): untested pairs of partials and re-queued timeouts first; then a flagged
  // passer beats nothing (the guard never overrides the tests); then the held partial; else park.
  const pairs = await visitPairs(st);
  if (pairs.kind === 'exit') return exitOn(st, pairs.decision);
  const retried = await drainRetries(st);
  if (retried.kind === 'exit') return exitOn(st, retried.decision);
  const suspect = commitSuspect(mem, goal);
  if (suspect !== null) return finish(st, suspect);
  const partial = commitPartial(mem, goal);
  if (partial !== null) return finish(st, partial);
  return finish(st, { kind: 'parked', reason: describeExhaustion(goal, sites) });
}

// ---------------------------------------------------------------------------------------
// Best guess (no reproduction oracle): rank, run the top-k against the regression scope, commit once
// ---------------------------------------------------------------------------------------

/**
 * The search for a goal that has no oracle (search/index.ts repository mode, best-guess path):
 * the issue text localised the sites (`deps.locate`, cached per goal), sources 1–3 are enumerated
 * at the top BEST_GUESS_TOP_SITES sites, Jev ranks each site's set (`deps.rank`: Choice ≤ 10,
 * hybrid ≤ 60, compact Nouls above), and the `decideRunPlan` top-k over the merged ranking run
 * against the scoped regression suite only (`deps.runQueue`, regression-only on a repository).
 * The commit is the highest-RANKED candidate whose run shows nothing newly failing, once per run
 * (the controller parks the goal afterwards); with none, the goal is parked with the reason.
 * `allGoalTestsPass` is false: nothing verified the fix, and the controller says so in the plan.
 */
export async function searchBestGuess(ctx: SynthesisContext, mem: SubGoalMemory, goal: Goal, deps: SubGoalDeps): Promise<SubGoalResult> {
  goal.status = 'active';
  const trace = newTrace(goal, mem.oracle);
  trace.runMode = 'RANK';
  checkAborted(ctx);
  let loc = mem.localizeCache.get(goal.id);
  if (loc === undefined) {
    loc = await deps.locate(ctx, mem, goal);
    spend(mem, loc.requests);
    trace.jevRequests += loc.requests;
    mem.localizeCache.set(goal.id, loc);
  }
  const committed = mem.bases.find((b) => b.origin === 'committed');
  if (committed === undefined) return finish({ ctx, mem, goal, deps, trace, queue: deps.createQueue(ctx, mem, goal), prior: null, rotation: 0, pairing: false, sitesThisStep: new Set<string>() }, { kind: 'parked', reason: 'no committed base to search from' });
  const sites = loc.sites.slice(0, BEST_GUESS_TOP_SITES);
  trace.sitesConsidered = sites.length;
  const st: LoopState = { ctx, mem, goal, deps, trace, queue: deps.createQueue(ctx, mem, goal), prior: null, rotation: 0, pairing: false, sitesThisStep: new Set<string>() };
  if (sites.length === 0) return finish(st, { kind: 'parked', reason: `no site located for ${goal.tests[0] ?? goal.id} from the issue text` });

  // sources 1–3 at each site, fresh (not tried, not the unchanged line)
  const opts = enumerateOptions(committed, goal, ctx.task);
  const perSite: { site: Site; cands: Candidate[] }[] = [];
  for (const site of sites) {
    checkAborted(ctx);
    const seen = new Set<string>();
    const cands: Candidate[] = [];
    for (const source of SEED_SOURCES) {
      const src = source === 'template' ? deps.seeds.template : source === 'donor' ? deps.seeds.donor : deps.seeds.mutation;
      for (const c of src.enumerate(site, opts)) {
        const key = `${c.site.line}|${c.site.kind}|${c.text}`;
        if (seen.has(key) || (c.site.kind === 'replace' && c.text.trim() === c.site.currentLine.trim()) || alreadyTried(c, committed, mem)) continue;
        seen.add(key);
        cands.push(c);
      }
    }
    trace.candidatesEnumerated += cands.length;
    for (const c of cands) trace.bySource[c.source].enumerated += 1;
    if (cands.length > 0) perSite.push({ site, cands });
  }
  const total = perSite.reduce((n, s) => n + s.cands.length, 0);
  if (total === 0) return finish(st, { kind: 'parked', reason: `no candidate enumerated by ${SEED_SOURCES.join(', ')} at ${sites.length} site${sites.length === 1 ? '' : 's'} for ${goal.tests[0] ?? goal.id}` });

  // Jev ranks each site's set; the sets merge by probability (§2.4: K is a budget, never a threshold)
  const ranked: { candidate: Candidate; probability: number; site: Site }[] = [];
  for (const { site, cands } of perSite) {
    if (mem.stepBudget.jevRequestsLeft <= 0) break;
    const r = await deps.rank(ctx, mem, cands, site, goal);
    spend(mem, r.requests);
    trace.jevRequests += r.requests;
    trace.candidatesRanked += r.ranked.length;
    for (const x of r.ranked) ranked.push({ candidate: x.candidate, probability: x.probability, site });
  }
  if (ranked.length === 0) return finish(st, { kind: 'budget' });
  ranked.sort((a, b) => b.probability - a.probability);
  const first = sites[0];
  const plan = decideRunPlan(ranked.length, first ?? { kind: 'replace' }, mem.oracle, mem.stepBudget);
  if (plan.runsAllowed <= 0) return finish(st, { kind: 'budget' });
  const k = Math.min(plan.mode === 'RANK' ? plan.k : ranked.length, plan.runsAllowed, ranked.length);
  const top = ranked.slice(0, k);
  const jobs: VerifyJob[] = top.map((r) => ({ candidate: r.candidate, base: committed, p: r.probability, sourcePrior: 1, key: [committed.summary.passed, r.probability, 1] }));
  const { queued } = st.queue.addAll(jobs);
  if (queued.length === 0) return finish(st, { kind: 'parked', reason: `every ranked candidate was already tried at ${sites.length} site${sites.length === 1 ? '' : 's'}` });
  const results = await deps.runQueue(ctx, mem, st.queue, goal, queued.length);
  trace.candidatesTested += results.length;
  trace.testRuns += results.reduce((n, r) => n + 1 + (r.full === undefined ? 0 : 1), 0);
  for (const r of results) {
    const row = trace.bySource[r.applied.candidate.source];
    row.tested += 1;
    if (r.status === 'plausible') row.passed += 1;
  }
  // the highest-ranked candidate whose scoped run shows nothing newly failing
  const order = new Map(top.map((r, i) => [r.candidate.id, i]));
  const ok = results
    .filter((o) => o.status === 'plausible' && !o.progress.regressed && (o.full === undefined || !o.full.timedOut) && !o.subset.timedOut)
    .sort((a, b) => (order.get(a.applied.candidate.id) ?? 1e9) - (order.get(b.applied.candidate.id) ?? 1e9));
  trace.plausible = ok.length;
  const pick = ok[0];
  if (pick === undefined) {
    if (results.length === 0) return finish(st, { kind: 'budget' });
    const scoped = committed.summary.total;
    return finish(st, { kind: 'parked', reason: `none of the ${results.length} ranked candidates keeps the ${scoped} scoped test${scoped === 1 ? '' : 's'} passing` });
  }
  return finish(st, { kind: 'commit', applied: pick.applied, allGoalTestsPass: false, outcome: pick });
}
