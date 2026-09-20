/**
 * Per-run memory of the Ledger + Sieve search (docs/JEV-ONLY-DESIGN.md §2.1, §5.2).
 *
 * The memory is the in-process state one `synthesize(ctx)` step leaves for the next: the
 * baseline run, the oracle model, the ledger of goals, the beam of bases, every diff ever run
 * (`tried`), the localisation cache and the WIDENED cursor. Its durable copy is deliberately
 * small: `plan.remaining` carries one item per open or parked goal in the fixed grammar
 * `fix <first_test_id>[, +N more] in <path>`, and `SynthesisContext.synthState` carries the
 * `PersistedSearchState` (tried hashes, goal statuses, cursors, claim records). On `--resume` the memory is
 * rebuilt from the baseline run, the plan items and that persisted state; anything lost costs
 * test time (a candidate is re-run), never a wrong commit.
 *
 * `memory.ts` and `goals.ts` import each other (goal construction needs the plan-item grammar,
 * rebuilding needs the clustering). Both sides only export function declarations and use the
 * other module inside function bodies, so the ESM cycle is safe.
 */
import { sha12 } from '../../core/hash.js';
import type { Plan, WindowEntry } from '../../core/types.js';
import type { AppliedCandidate, LocalizeResult, TestRunSummary } from '../types.js';
import { defaultOverrides } from './directive.js';
import type { SearchOverrides } from './directive.js';
import { clusterFailures, inheritGoalState } from './goals.js';
import type { ClusterOptions, PriorGoalState } from './goals.js';
import type { Base, Goal, OracleModel, PersistedSearchState, StepBudget } from './types.js';

// ---------------------------------------------------------------------------------------
// The memory record
// ---------------------------------------------------------------------------------------

export interface SearchMemory {
  readonly runId: string;
  /** full-suite run on the committed workspace (code); null until the first step ran it */
  baseline: TestRunSummary | null;
  /** §4.1: t_run per scope, per-test timeout, lane count; UNFITTED_ORACLE until budget.fitOracle ran */
  oracle: OracleModel;
  /** the ledger, one goal per failing-test cluster (open, active, parked or fixed) */
  goals: Goal[];
  /** ≤ 2: the committed workspace + at most one 'improved' partial */
  bases: Base[];
  /** sha12(diff) of every candidate ever run in this run */
  tried: Set<string>;
  /** per goal id; invalidated when a suspected file changes (reopenOnChange) */
  localizeCache: Map<string, LocalizeResult>;
  /** per goal id: how far the WIDENED all-lines phase got (§2.3 phase W) */
  widenCursor: Map<string, number>;
  /** commit order, for revert directives; lost on resume (only the hashes survive) */
  committed: AppliedCandidate[];
  /** sha12(diff) of every commit of this run, including those made before a resume */
  committedDiffHashes: string[];
  /** §4.3, installed fresh by index.ts at the start of every synthesize() call */
  stepBudget: StepBudget;
  /** §5.4 knobs the replan directives turn (directive.ts owns the shape; defaults until a directive arrives) */
  overrides: SearchOverrides;
  /** set by the controller while a batch with ≥ 2 plausible candidates awaits the §2.6 arbitration (proposal.ts reads it) */
  guardPending?: boolean;
  /**
   * The engine's last executed test run with parsed counts, and the step of the last executed
   * workspace-changing action, as seen in the windows of every step so far (index.ts
   * observeWindow). The window keeps only WINDOW_SIZE (4) entries, so a patch followed by a few
   * declined runs and reads scrolls out of it while the engine still has no run of the current
   * workspace; these outlive the window. Not persisted: a resumed run re-observes its window.
   */
  lastEngineRun: EngineRun | null;
  lastChangeStep: number | null;
  /**
   * Plan item → the executed `run` that claimed it in `plan.done` and the judge's verdict on that
   * claim (§5.1 row 2). A claim is judged once, on that run's parsed output; the record keeps the
   * next run from repeating a claim the judge did not accept until a new passing full-suite run
   * gives it fresh evidence (proposal.ts claimSplit). Persisted with the goal statuses.
   */
  claims: Map<string, ClaimRecord>;
}

/** One engine-executed `run` with parsed counts: its step and window label (`run <command>`) plus the counts. */
export interface EngineRun {
  step: number;
  action: string;
  passed: number;
  failed: number;
  errors: number;
}

/** A plan item claimed on an executed `run`: the step, and the judge's `done_<j>` probability (null until the next window shows the verdict). */
export interface ClaimRecord {
  step: number;
  judged: number | null;
}

/**
 * The oracle model before `fitOracle` has seen a baseline. Why these values: one lane and a
 * t_run equal to the verifier's default 120 s timeout (`verify.DEFAULT_TEST_TIMEOUT_MS`) make
 * `decideRunPlan` (§2.4) take RANK mode with the smallest K, so a step that somehow reaches the
 * search before the baseline was measured can never over-commit test runs.
 */
export const UNFITTED_ORACLE: Readonly<OracleModel> = {
  runner: 'other',
  lanes: 1,
  tRunMs: { goalSubset: 120_000, fullSuite: 120_000 },
  perTestTimeoutMs: null,
  runTimeoutMs: 120_000,
  baselineDurationMs: 0,
};

/** A budget with nothing left: the search cannot run until index.ts installs `freshBudget()`. */
export function emptyStepBudget(): StepBudget {
  return { jevRequestsLeft: 0, testRunsLeft: 0, testWallLeftMs: 0, startedMs: Date.now(), recursed: false, exhausted: () => true };
}

export function createMemory(runId: string): SearchMemory {
  return {
    runId,
    baseline: null,
    oracle: { ...UNFITTED_ORACLE, tRunMs: { ...UNFITTED_ORACLE.tRunMs } },
    goals: [],
    bases: [],
    tried: new Set(),
    localizeCache: new Map(),
    widenCursor: new Map(),
    committed: [],
    committedDiffHashes: [],
    stepBudget: emptyStepBudget(),
    overrides: defaultOverrides(),
    lastEngineRun: null,
    lastChangeStep: null,
    claims: new Map(),
  };
}

const memories = new Map<string, SearchMemory>();

/** The memory of a run, created on first use. One process may host several runs (bench). */
export function getMemory(runId: string): SearchMemory {
  let mem = memories.get(runId);
  if (mem === undefined) {
    mem = createMemory(runId);
    memories.set(runId, mem);
  }
  return mem;
}

/** Forget a run's memory (run end, tests). Returns whether there was one. */
export function dropMemory(runId: string): boolean {
  return memories.delete(runId);
}

/** The registered memory whose ledger is exactly this array (identity), for callers holding only `mem.goals`. */
export function memoryOfGoals(goals: readonly Goal[]): SearchMemory | null {
  for (const mem of memories.values()) if (mem.goals === goals) return mem;
  return null;
}

// ---------------------------------------------------------------------------------------
// tried / committed bookkeeping
// ---------------------------------------------------------------------------------------

/** The hash the engine's loop detector uses for a `patch` (`patch:<sha12(diff)>`, loop/loopdetect.ts). */
export function diffHash(diff: string): string {
  return sha12(diff);
}

/** Record a diff as run; false when it was already in `tried` (the caller skips it). */
export function markTried(mem: Pick<SearchMemory, 'tried'>, diff: string): boolean {
  const h = diffHash(diff);
  if (mem.tried.has(h)) return false;
  mem.tried.add(h);
  return true;
}

export function wasTried(mem: Pick<SearchMemory, 'tried'>, diff: string): boolean {
  return mem.tried.has(diffHash(diff));
}

/** Record a commit in both the in-memory list and the durable hash list. */
export function recordCommit(mem: Pick<SearchMemory, 'committed' | 'committedDiffHashes' | 'tried'>, applied: AppliedCandidate): void {
  mem.committed.push(applied);
  const h = diffHash(applied.diff);
  mem.tried.add(h);
  if (!mem.committedDiffHashes.includes(h)) mem.committedDiffHashes.push(h);
}

// ---------------------------------------------------------------------------------------
// Claim bookkeeping (§5.1 row 2: a plan item is claimed on an executed run, once per verdict)
// ---------------------------------------------------------------------------------------

/** The judged probability quoted by loop/plan.ts in a `rejected_claim` note: `'<item>' was not accepted as done: done_<j> = 0.12`. */
const REJECTED_CLAIM_P_RE = /done_\d+ = (\d(?:\.\d+)?)/;

/**
 * Record the items a `run` proposal claims this step (pending until the next window shows the
 * judge's verdict). A claim already resolved for the same item is replaced: the run re-claims it
 * only because a newer passing suite run allows it (proposal.ts), so this is a new claim.
 */
export function recordClaims(mem: Pick<SearchMemory, 'claims'>, items: readonly string[], step: number): void {
  for (const item of items) mem.claims.set(item, { step, judged: null });
}

/**
 * Settle the claim records against what the engine did with them, every step before proposing:
 *
 * - an item the accepted plan lists as done leaves the record (the claim landed);
 * - a pending claim whose run the window shows executed takes the judge's `done_<j>` from that
 *   entry's `judge.doneClaims`; a run the engine blocked, declined or failed never judged the
 *   claim, so the record is dropped and the item is free to be claimed again;
 * - a pending claim whose step is no longer in the window (resume) is read from the plan: the
 *   `unverified` list carries `judged` for a claim in [0.3, 0.7), a `rejected_claim` harness note
 *   quotes `done_<j> = p` for one below; neither means the claim was never judged → dropped.
 */
export function resolveClaims(mem: Pick<SearchMemory, 'claims'>, window: readonly WindowEntry[], plan: Pick<Plan, 'done' | 'unverified' | 'harnessProblems'>): void {
  const accepted = new Set(plan.done.map((d) => d.text));
  for (const [item, rec] of [...mem.claims]) {
    if (accepted.has(item)) {
      mem.claims.delete(item);
      continue;
    }
    if (rec.judged !== null) continue;
    const entry = window.find((e) => e.step === rec.step);
    if (entry !== undefined) {
      const verdict = entry.outcome === 'executed' ? entry.judge?.doneClaims.find((c) => c.text === item) : undefined;
      if (verdict === undefined) mem.claims.delete(item);
      else rec.judged = verdict.judged;
      continue;
    }
    const unverified = plan.unverified.find((u) => u.text === item);
    if (unverified !== undefined) {
      rec.judged = unverified.judged;
      continue;
    }
    const rejected = plan.harnessProblems.find((h) => h.kind === 'rejected_claim' && h.text.includes(`'${item}'`));
    const p = rejected === undefined ? null : REJECTED_CLAIM_P_RE.exec(rejected.text)?.[1];
    if (p === null || p === undefined) mem.claims.delete(item);
    else rec.judged = Number(p);
  }
}

// ---------------------------------------------------------------------------------------
// The plan-item grammar: `fix <first_test_id>[, +N more] in <path>`
// ---------------------------------------------------------------------------------------

/** Path used when a goal has no suspected file and its test id names none (never on QuixBugs or pytest ids). */
export const UNKNOWN_PLAN_PATH = 'the workspace';

export interface ParsedGoalItem {
  firstTestId: string;
  /** the `+N more` count; 0 when absent */
  more: number;
  path: string;
}

/** The file part of a pytest node id (`tests/test_x.py::test_y` → `tests/test_x.py`), or null. */
export function testFileOf(testId: string): string | null {
  const at = testId.indexOf('::');
  return at > 0 ? testId.slice(0, at) : null;
}

/** The `<path>` of a goal's plan item: its first suspected file, else the test file, else a placeholder. */
export function planItemPath(goal: Pick<Goal, 'tests' | 'suspectedFiles'>): string {
  const suspected = goal.suspectedFiles[0];
  if (suspected !== undefined && suspected !== '') return suspected;
  const first = goal.tests[0];
  const fromTest = first === undefined ? null : testFileOf(first);
  return fromTest ?? UNKNOWN_PLAN_PATH;
}

/**
 * `fix <first_test_id>[, +N more] in <path>`. Readable by the engine's Jev stages (intent
 * `plan_still_valid`, risk `plan_mismatch`, completion) and parseable back by `parseGoalItem`.
 */
export function planItemFor(goal: Pick<Goal, 'tests' | 'suspectedFiles'>): string {
  const first = goal.tests[0] ?? '<no test>';
  const more = Math.max(0, goal.tests.length - 1);
  const suffix = more > 0 ? `, +${more} more` : '';
  return `fix ${first}${suffix} in ${planItemPath(goal)}`;
}

// Greedy `(.+)` so the LAST " in " splits id from path: test ids may contain " in "
// (`test_in_list` does not, but a parametrised id could), paths never contain spaces.
const ITEM_RE = /^fix (.+) in (\S+)$/;
const MORE_RE = /^(.*), \+(\d+) more$/;

/**
 * Parse a plan item written by `planItemFor`; null for anything else (the engine may hold items
 * written by a generator run or by hand; those are simply not goals).
 */
export function parseGoalItem(item: string): ParsedGoalItem | null {
  const trimmed = item.trim();
  // The placeholder path has a space; every real path is a single token.
  const placeholderAt = trimmed.endsWith(` in ${UNKNOWN_PLAN_PATH}`) ? trimmed.length - ` in ${UNKNOWN_PLAN_PATH}`.length : -1;
  let head: string;
  let path: string;
  if (placeholderAt > 0) {
    if (!trimmed.startsWith('fix ')) return null;
    head = trimmed.slice(4, placeholderAt);
    path = UNKNOWN_PLAN_PATH;
  } else {
    const m = ITEM_RE.exec(trimmed);
    if (m === null || m[1] === undefined || m[2] === undefined) return null;
    head = m[1];
    path = m[2];
  }
  if (head === '') return null;
  const more = MORE_RE.exec(head);
  if (more !== null && more[1] !== undefined && more[2] !== undefined) {
    if (more[1] === '') return null;
    return { firstTestId: more[1], more: Number(more[2]), path };
  }
  return { firstTestId: head, more: 0, path };
}

// ---------------------------------------------------------------------------------------
// Persisted state (SynthesisContext.synthState) and rebuild on resume
// ---------------------------------------------------------------------------------------

/**
 * `setSynthState` keeps at most 64 KB after redaction (core/types.ts). A sha12 entry serialises
 * to 15 bytes (`"xxxxxxxxxxxx",`), so 3,000 entries are ≈ 45 KB and leave room for the goal
 * records; QuixBugs steps run ≤ 1,500 candidates (§4.3), so one step always fits. The newest
 * hashes are kept: they belong to the phase a resumed step would otherwise repeat first.
 */
export const TRIED_PERSIST_MAX = 3000;

/**
 * This module's addition to the checkpoint record: the claim records (`SearchMemory.claims`),
 * keyed by plan item. `PersistedSearchState` (types.ts) is the contract the other modules read;
 * the field is optional there by construction (an older checkpoint has none) and `toPersisted`
 * always writes it.
 */
export interface PersistedClaims {
  claims?: Record<string, ClaimRecord>;
}

export type PersistedMemoryState = PersistedSearchState & PersistedClaims;

/** The claim records of a checkpoint (an older one, or one written by hand, carries none). */
export function claimsFromPersisted(persisted: (PersistedSearchState & PersistedClaims) | null): Map<string, ClaimRecord> {
  const out = new Map<string, ClaimRecord>();
  const raw: unknown = persisted?.claims;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [item, rec] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof rec !== 'object' || rec === null) continue;
    const { step, judged } = rec as { step?: unknown; judged?: unknown };
    if (typeof step !== 'number' || !Number.isFinite(step)) continue;
    out.set(item, { step, judged: typeof judged === 'number' && Number.isFinite(judged) ? judged : null });
  }
  return out;
}

export function toPersisted(mem: Pick<SearchMemory, 'tried' | 'widenCursor' | 'goals' | 'committedDiffHashes' | 'claims'>): PersistedMemoryState {
  const all = [...mem.tried];
  const tried = all.length > TRIED_PERSIST_MAX ? all.slice(all.length - TRIED_PERSIST_MAX) : all;
  const widenCursor: Record<string, number> = {};
  for (const [goalId, cursor] of mem.widenCursor) widenCursor[goalId] = cursor;
  const goals: PersistedSearchState['goals'] = {};
  for (const g of mem.goals) {
    const rec: PersistedSearchState['goals'][string] = { status: g.status, attempts: g.attempts, budgetHits: g.budgetHits, phase: g.phase, tests: [...g.tests], planItem: g.planItem };
    if (g.parkedReason !== undefined) rec.parkedReason = g.parkedReason;
    goals[g.id] = rec;
  }
  const claims: Record<string, ClaimRecord> = {};
  for (const [item, rec] of mem.claims) claims[item] = { step: rec.step, judged: rec.judged };
  return { version: 1, tried, widenCursor, goals, committedDiffHashes: [...mem.committedDiffHashes], claims };
}

/** What `rebuildFromPlan` recovers; `restoreMemory` installs it. */
export interface RebuiltMemory {
  baseline: TestRunSummary;
  goals: Goal[];
  tried: Set<string>;
  widenCursor: Map<string, number>;
  committedDiffHashes: string[];
  claims: Map<string, ClaimRecord>;
}

function priorFromPersisted(persisted: PersistedSearchState): PriorGoalState[] {
  const out: PriorGoalState[] = [];
  for (const [id, rec] of Object.entries(persisted.goals)) {
    const prior: PriorGoalState = { id, tests: rec.tests, status: rec.status, attempts: rec.attempts, budgetHits: rec.budgetHits, phase: rec.phase, planItem: rec.planItem };
    if (rec.parkedReason !== undefined) prior.parkedReason = rec.parkedReason;
    out.push(prior);
  }
  return out;
}

/**
 * Resume (§2.1 durability rule). Two call shapes:
 *
 * - `rebuildFromPlan(plan, baseline, persisted, opts?)` → `RebuiltMemory`: re-derive the goals
 *   from the baseline's failing tests, re-attach them to `plan.remaining` items by first test id
 *   (so the plan strings the engine has judged stay stable), then restore statuses, attempts,
 *   phases, cursors and `tried` from the persisted state by test-id overlap. A goal whose
 *   persisted tests all pass now comes back as `fixed`. Install with `restoreMemory`.
 * - `rebuildFromPlan(mem, plan, persisted)` → void, before the baseline exists (index.ts's first
 *   step): `tried`, cursors and commit hashes are restored now and the persisted goal records
 *   (plus plan items without a record) become placeholder goals with their statuses, so the
 *   `reconcile(mem.goals, clusterFailures(baseline), plan)` that follows the baseline run
 *   inherits their state by test-id overlap.
 */
export function rebuildFromPlan(plan: Pick<Plan, 'remaining'>, baseline: TestRunSummary, persisted: PersistedSearchState | null, opts?: ClusterOptions): RebuiltMemory;
export function rebuildFromPlan(mem: SearchMemory, plan: Pick<Plan, 'remaining'>, persisted: PersistedSearchState | null): void;
export function rebuildFromPlan(first: Pick<Plan, 'remaining'> | SearchMemory, second: TestRunSummary | Pick<Plan, 'remaining'>, persisted: PersistedSearchState | null, opts: ClusterOptions = {}): RebuiltMemory | void {
  if ('tried' in first && 'remaining' in second) {
    rebuildPlaceholders(first, second, persisted);
    return;
  }
  if (!('remaining' in first) || !('failing' in second)) throw new TypeError('rebuildFromPlan: expected (plan, baseline, persisted) or (mem, plan, persisted)');
  return rebuildGoals(first, second, persisted, opts);
}

/** Placeholder goals from the persisted records and the plan items, for a later `reconcile`. */
function rebuildPlaceholders(mem: SearchMemory, plan: Pick<Plan, 'remaining'>, persisted: PersistedSearchState | null): void {
  const goals: Goal[] = [];
  const known = new Set<string>();
  if (persisted !== null) {
    for (const prior of priorFromPersisted(persisted)) {
      const parsed = parseGoalItem(prior.planItem);
      const goal: Goal = { id: prior.id, tests: [...prior.tests], failures: [], suspectedFiles: parsed === null || parsed.path === UNKNOWN_PLAN_PATH ? [] : [parsed.path], status: prior.status === 'active' ? 'open' : prior.status, attempts: prior.attempts, budgetHits: prior.budgetHits, exhausted: new Map(), phase: prior.phase, planItem: prior.planItem };
      if (goal.status === 'parked' && prior.parkedReason !== undefined) goal.parkedReason = prior.parkedReason;
      goals.push(goal);
      for (const t of prior.tests) known.add(t);
    }
  }
  let next = Math.max(0, ...goals.map((g) => Number(/^g(\d+)$/.exec(g.id)?.[1] ?? 0))) + 1;
  for (const item of plan.remaining) {
    const parsed = parseGoalItem(item);
    if (parsed === null || known.has(parsed.firstTestId)) continue;
    known.add(parsed.firstTestId);
    goals.push({ id: `g${next++}`, tests: [parsed.firstTestId], failures: [], suspectedFiles: parsed.path === UNKNOWN_PLAN_PATH ? [] : [parsed.path], status: 'open', attempts: 0, budgetHits: 0, exhausted: new Map(), phase: 'SEEDS', planItem: item.trim() });
  }
  mem.goals = goals;
  mem.tried = new Set(persisted?.tried ?? []);
  mem.widenCursor = new Map();
  for (const [goalId, cursor] of Object.entries(persisted?.widenCursor ?? {})) if (Number.isFinite(cursor)) mem.widenCursor.set(goalId, cursor);
  mem.committedDiffHashes = [...(persisted?.committedDiffHashes ?? [])];
  mem.claims = claimsFromPersisted(persisted);
}

function rebuildGoals(plan: Pick<Plan, 'remaining'>, baseline: TestRunSummary, persisted: PersistedSearchState | null, opts: ClusterOptions): RebuiltMemory {
  const fresh = clusterFailures(baseline, opts);
  const goals = persisted === null ? fresh : inheritGoalState(fresh, priorFromPersisted(persisted));
  attachPlanItems(goals, plan.remaining);
  const widenCursor = new Map<string, number>();
  if (persisted !== null) {
    const live = new Set(goals.map((g) => g.id));
    for (const [goalId, cursor] of Object.entries(persisted.widenCursor)) if (live.has(goalId) && Number.isFinite(cursor)) widenCursor.set(goalId, cursor);
  }
  return {
    baseline,
    goals,
    tried: new Set(persisted?.tried ?? []),
    widenCursor,
    committedDiffHashes: [...(persisted?.committedDiffHashes ?? [])],
    claims: claimsFromPersisted(persisted),
  };
}

/** Re-attach goals to the plan items the engine already holds, matching on the first test id. */
export function attachPlanItems(goals: readonly Goal[], remaining: readonly string[]): void {
  for (const item of remaining) {
    const parsed = parseGoalItem(item);
    if (parsed === null) continue;
    const goal = goals.find((g) => g.tests.includes(parsed.firstTestId));
    if (goal !== undefined && goal.status !== 'fixed') goal.planItem = item.trim();
  }
}

/** Install a rebuilt state into the run's memory (caches are empty: the workspace may have changed). */
export function restoreMemory(mem: SearchMemory, rebuilt: RebuiltMemory): void {
  mem.baseline = rebuilt.baseline;
  mem.goals = rebuilt.goals;
  mem.tried = rebuilt.tried;
  mem.widenCursor = rebuilt.widenCursor;
  mem.committedDiffHashes = rebuilt.committedDiffHashes;
  mem.claims = rebuilt.claims;
  mem.localizeCache.clear();
  mem.bases = [];
  mem.committed = [];
}
