/**
 * The Ledger + Sieve synthesizer (docs/JEV-ONLY-DESIGN.md §2.2): one outer step = one verified
 * sub-goal attempt, or the bookkeeping `run` after a commit. The ledger of goals lives in the
 * per-run SearchMemory (rebuilt from `ctx.synthState` and `plan.remaining` on the first call
 * of a resumed run); the tests are the oracle; Jev is asked only through `ctx.ask` by the
 * modules this controller composes, so a synthesizer built with a throwing raw decider works.
 *
 * The pure ledger modules (memory, goals, budget, proposal, directive) are imported; what
 * touches Jev, the workspace or the sandbox (the sub-goal search, file loading, the baseline
 * run) plus the goal picker and the directive handler are injected through `SearchDeps`, so the
 * §2.2 control flow is unit-tested with fakes and src/synth/index.ts wires the real modules.
 */
import { toJson } from '../../core/json.js';
import { clip } from '../../core/text.js';
import { PLAN_ITEM_MAX_CHARS } from '../../loop/plan.js';
import type { Decider, EngineEvent, OutcomeStatus, Proposal, ProposalEvidence, SynthesisContext, Synthesizer, WindowEntry } from '../../core/types.js';
import { AbortError } from '../../errors.js';
import { analyse } from '../py/structure.js';
import { subsetCommand } from '../sieve/runner.js';
import type { RunnerMemory } from '../sieve/runner.js';
import type { AppliedCandidate, SourceFile, TestRunSummary } from '../types.js';
import { DEFAULT_TEST_OUTPUT_BYTES, summarize } from '../verify/index.js';
import { PERSISTED_PARTIALS_KEY, forgetGoal, forgetHeld, freshPairsOfPartials, partialsFromPersisted, persistPartials, restorePartials } from './bases.js';
import { fitOracle, freshBudget } from './budget.js';
import { defaultOverrides, handleDirective, invalidateStaleSites } from './directive.js';
import type { DirectiveMemory, DirectiveResult } from './directive.js';
import { clusterFailures, ledgerLine, newGoal, noteBudgetHit, noteCommit, park, parkReasonFor, pickGoalDetailed, reconcile, reopenOnChange } from './goals.js';
import { commitSuspect } from './guard.js';
import type { GoalPick } from './goals.js';
import { diffHash, getMemory, rebuildFromPlan, recordClaims, recordCommit, resolveClaims, restoreMemory, toPersisted } from './memory.js';
import type { SearchMemory } from './memory.js';
import { READ_MAX_PATHS, commitEvidence, proposeDone, proposePatch, proposeRead, proposeRun, runEvidence, selectionFrom, withEvidence } from './proposal.js';
import { isTestPath, newTrace } from './subgoal.js';
import type { SubGoalMemory, SubGoalResult } from './subgoal.js';
import type { Base, Goal, GoalSearchTrace, Lane } from './types.js';
import { isPersistedSearchState } from './types.js';

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

/** Full-suite command when the workspace detector found none (the QuixBugs and ladder layouts are pytest modules under tests/). */
export const DEFAULT_TEST_COMMAND = 'python3 -m pytest -q';
/** Workspace Python files loaded into the committed base (localisation and donor corpus); SWE repositories exceed this and are cut alphabetically. */
export const MAX_WORKSPACE_PY_FILES = 400;
/** Per-file read cap; the workspace listing already drops files over 1 MB. */
export const MAX_PY_FILE_BYTES = 512 * 1024;
/** §4.1: a timed-out baseline parks every goal with this reason and proposes the full command so the engine's judge sees it. */
export const SUITE_TOO_SLOW = 'suite too slow';
/** A rejected patch's reason is quoted in the `rollback` synth event up to this many characters (the window keeps ≤ 600). */
const ROLLBACK_REASON_CHARS = 160;
/**
 * A test-passing candidate the engine blocked or declined is proposed again this many times before
 * it is abandoned (it stays in `tried`; the search moves on). The rejection is about the plan or the
 * intent, not the code (the candidate passed the goal's tests on this very workspace), and the tenth
 * live run on ladder `inventory` spent ~750 test runs re-discovering the same passer after one
 * decline; three identical proposals would trip the engine's `patch:<sha12>` loop guard, so one.
 */
const REPROPOSE_MAX = 1;
/**
 * Consecutive executed `read`s the `investigate` compliance may propose before the search proceeds
 * regardless of the intent. Live run 10 (ladder `inventory`): after one read the intent stayed
 * `investigate` and the patch was reviewed at 0.30; after a second read it turned to `edit`. Three
 * identical reads would trip the engine's loop guard.
 */
const INVESTIGATE_READS_MAX = 2;
/** Proposal kinds whose execution changes the workspace (window action labels start with the kind, provider/actions.ts summariseAction). */
const CHANGING_ACTIONS: readonly string[] = ['patch', 'edit', 'write'];
/**
 * Goal text of the run's first proposal when the engine has never executed the test suite
 * (`engineNeedsRun` with no engine run at all): the full-suite `run`, whatever the intent. Until
 * the engine has an executed baseline, the plan's standing verification item has never run from
 * `recent`'s point of view and every verified `patch` scores as "skips a planned verification
 * step" (the second ladder run declined 5 of 6 such patches under `investigate`, `units` ×4).
 */
export const ESTABLISH_GOAL = 'establish the failing tests: run the full test suite before any change';

export type WorkspaceLayout = 'quixbugs' | 'pytest' | 'other';

/** The run's memory as the controller and its collaborators see it: the §2.1 record plus the directive knobs and the runner's caches. */
export type RunMemory = SearchMemory & DirectiveMemory & RunnerMemory & SubGoalMemory;

// ---------------------------------------------------------------------------------------
// Collaborator contracts
// ---------------------------------------------------------------------------------------

export interface BaselineRun {
  summary: TestRunSummary;
  /** the run's full stdout + stderr, for goals.clusterFailures (pytest tracebacks) */
  output: string;
}

export interface SearchDeps {
  /** search/subgoal.ts searchSubGoal with its own deps bound (§2.3) */
  searchSubGoal(ctx: SynthesisContext, mem: RunMemory, goal: Goal): Promise<SubGoalResult>;
  /** the workspace's non-test Python files (path → analysed source); default reads through ctx.workspace */
  loadFiles(ctx: SynthesisContext): Promise<Map<string, SourceFile>>;
  /** one test command in the workspace root through ctx.sandbox, summarised; default below */
  runTests(ctx: SynthesisContext, command: string, timeoutMs: number): Promise<BaselineRun>;
  /** search/goals.ts pickGoal (Q1 when ≥ 2 open goals) */
  pickGoal(ctx: SynthesisContext, mem: RunMemory): Promise<GoalPick>;
  /** search/directive.ts handleDirective (§5.4) */
  handleDirective(ctx: SynthesisContext, mem: RunMemory): Promise<DirectiveResult>;
  now(): number;
}

/** The real collaborators for everything but the sub-goal search (src/synth/index.ts adds that). */
export function defaultSearchDeps(): Omit<SearchDeps, 'searchSubGoal'> {
  return {
    loadFiles: loadPythonFiles,
    runTests: runTestsInSandbox,
    pickGoal: (ctx, mem) => pickGoalDetailed(ctx, mem, ctx.ask, { stage: 'propose' }),
    handleDirective,
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------------------
// Pure helpers (exported for the unit tests)
// ---------------------------------------------------------------------------------------

/** Kind of the previous step's action when it executed ('patch', 'run', ...), else null. */
export function lastExecutedActionKind(window: readonly WindowEntry[]): string | null {
  const e = window.at(-1);
  if (e === undefined || e.outcome !== 'executed') return null;
  return e.action.split(' ')[0] ?? null;
}

/**
 * The previous step's action was a `patch` the engine did not execute (blocked by the risk stage,
 * declined at review, failed to apply, interrupted, or the step errored before execute), else
 * null. The synthesizer records a commit when it proposes the patch; the workspace only changes
 * when the engine executes it, so every other outcome must undo that record (§5.1: the ledger
 * follows the workspace, never the other way round).
 */
export function patchNotExecutedLastStep(window: readonly WindowEntry[]): { step: number; outcome: OutcomeStatus | null; reason: string } | null {
  const e = window.at(-1);
  if (e === undefined || e.outcome === 'executed' || !/^patch(\s|$)/.test(e.action)) return null;
  return { step: e.step, outcome: e.outcome, reason: e.reason ?? '' };
}

/**
 * Source files (never test files) the open goals point at — their suspected files and the files
 * of their localised sites — that are not in this step's `contextFiles`, ≤ READ_MAX_PATHS.
 */
export function unseenSourceFiles(ctx: SynthesisContext, mem: Pick<RunMemory, 'goals' | 'localizeCache'>): string[] {
  const shown = new Set(ctx.contextFiles.map((f) => f.path));
  const out: string[] = [];
  const push = (p: string): void => {
    if (!shown.has(p) && !isTestPath(p) && !out.includes(p)) out.push(p);
  };
  for (const g of mem.goals) {
    if (g.status !== 'open' && g.status !== 'active') continue;
    for (const p of g.suspectedFiles) push(p);
    for (const site of mem.localizeCache.get(g.id)?.sites ?? []) push(site.file.path);
  }
  return out.slice(0, READ_MAX_PATHS);
}

/** Source files (never test files) the open goals point at: their localised sites' files, else their suspected files. */
export function relevantSourceFiles(mem: Pick<RunMemory, 'goals' | 'localizeCache'>): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    if (!isTestPath(p) && !out.includes(p)) out.push(p);
  };
  for (const g of mem.goals) {
    if (g.status !== 'open' && g.status !== 'active') continue;
    for (const site of mem.localizeCache.get(g.id)?.sites ?? []) push(site.file.path);
    for (const p of g.suspectedFiles) push(p);
  }
  return out;
}

/** The memory fields that record what the engine executed (memory.ts SearchMemory: they outlive the 4-entry window). */
export type EngineObservations = Pick<SearchMemory, 'lastEngineRun' | 'lastChangeStep'>;

/** Record the engine's executed test runs (parsed counts, window label) and executed workspace changes seen in this window. */
export function observeWindow(mem: EngineObservations, window: readonly WindowEntry[]): void {
  for (const e of window) {
    if (e.outcome !== 'executed') continue;
    const kind = e.action.split(' ')[0] ?? '';
    if (CHANGING_ACTIONS.includes(kind)) {
      if (mem.lastChangeStep === null || e.step > mem.lastChangeStep) mem.lastChangeStep = e.step;
    } else if (kind === 'run') {
      const tests = e.judge?.tests ?? null;
      if (tests !== null && tests.source === 'parsed' && (mem.lastEngineRun === null || e.step > mem.lastEngineRun.step)) {
        mem.lastEngineRun = { step: e.step, action: e.action, passed: tests.passed, failed: tests.failed, errors: tests.errors };
      }
    }
  }
}

/** The engine has no test run of the current workspace: a change was executed after its last parsed run (or it never ran one). */
export function engineNeedsRun(mem: EngineObservations): boolean {
  if (mem.lastChangeStep === null) return mem.lastEngineRun === null;
  return mem.lastEngineRun === null || mem.lastEngineRun.step < mem.lastChangeStep;
}

/** Step of the latest executed workspace-changing action in the window, or null. */
export function lastWorkspaceChangeStep(window: readonly WindowEntry[]): number | null {
  let step: number | null = null;
  for (const e of window) {
    const kind = e.action.split(' ')[0] ?? '';
    if (e.outcome === 'executed' && CHANGING_ACTIONS.includes(kind) && (step === null || e.step > step)) step = e.step;
  }
  return step;
}

/**
 * The workspace changed after the baseline was taken at `baselineStep` (§2.2 workspaceChangedSince).
 * A change executed in the baseline's own step counts: the baseline runs in the propose stage,
 * the patch it led to is applied by the execute stage of the same step.
 */
export function workspaceChangedSince(baselineStep: number, window: readonly WindowEntry[]): boolean {
  const change = lastWorkspaceChangeStep(window);
  return change !== null && change >= baselineStep;
}

/**
 * A bare `pytest …` command becomes `python3 -m pytest …`: `pytest` is not guaranteed on PATH
 * (the bench's mock trajectory runs the module form for the same reason,
 * src/bench/ladder/pyworkspace.ts MOCK_TEST_COMMAND; on the reference machine the bare command
 * fails in 15 ms with "command not found", which the first live run summarised as one error and
 * no failing tests, so no goal was ever formed). The module form runs wherever pytest is
 * importable, and the engine's execute stage (`isTestCommand`) treats both as the same runner,
 * so `lastTestRun` / `testsCurrent` still see the synthesizer's `run` proposals.
 */
export function normaliseTestCommand(command: string): string {
  return command.replace(/^(?:pytest|py\.test)(?=\s|$)/, 'python3 -m pytest');
}

/** The full-suite command: the workspace detector's (normalised, see above), else the pytest default. */
export function baselineCommand(ctx: SynthesisContext): string {
  return normaliseTestCommand(ctx.workspaceInfo.testCommand?.command ?? DEFAULT_TEST_COMMAND);
}

/**
 * bench/data/quixbugs-style layout: one `<name>.py` at the root (plus `node.py` for the graph
 * programs) with `tests/test_<name>.py` or `tests/<name>_test.py`.
 */
export function detectLayout(paths: readonly string[]): WorkspaceLayout {
  const py = [...new Set(paths)].filter((p) => p.endsWith('.py'));
  const programs = py.filter((p) => !p.includes('/') && !isTestPath(p) && p !== 'node.py');
  if (programs.length === 1) {
    const name = (programs[0] ?? '').slice(0, -3);
    if (paths.includes(`tests/test_${name}.py`) || paths.includes(`tests/${name}_test.py`)) return 'quixbugs';
  }
  if (py.some((p) => isTestPath(p))) return 'pytest';
  return 'other';
}

export function allPass(s: TestRunSummary): boolean {
  return s.passed > 0 && s.failed === 0 && s.errors === 0 && !s.timedOut;
}

export function committedBase(files: ReadonlyMap<string, SourceFile>, baseline: TestRunSummary): Base {
  return { id: 'committed', origin: 'committed', fromGoal: null, files, summary: baseline, depth: 0 };
}

/** The lane that is the workspace itself: the engine executes goal-subset runs there (§5.1 row 3). */
export function workspaceLane(root: string): Lane {
  return { index: 0, dir: root, mode: 'inplace', busy: false };
}

/** The run's memory with the directive overrides attached (memory.ts owns the §2.1 record; the knobs are the controller's). */
export function runMemory(runId: string): RunMemory {
  const mem = getMemory(runId) as SearchMemory & Partial<Pick<DirectiveMemory, 'overrides'>>;
  if (mem.overrides === undefined) mem.overrides = defaultOverrides();
  return mem as RunMemory;
}

// ---------------------------------------------------------------------------------------
// Default collaborators that belong to the controller
// ---------------------------------------------------------------------------------------

/** Non-test Python files of the workspace, read and analysed; unparsable or truncated files are skipped. */
export async function loadPythonFiles(ctx: SynthesisContext): Promise<Map<string, SourceFile>> {
  const out = new Map<string, SourceFile>();
  const paths = (await ctx.workspace.listCandidates())
    .map((c) => c.path)
    .filter((p) => p.endsWith('.py') && !isTestPath(p) && !p.includes('.jevcode-synth/'))
    .sort()
    .slice(0, MAX_WORKSPACE_PY_FILES);
  for (const path of paths) {
    if (ctx.signal.aborted) throw new AbortError('signal');
    try {
      const view = await ctx.workspace.read(path, MAX_PY_FILE_BYTES);
      if (view.truncatedBytes > 0) continue;
      out.set(path, { path, src: view.content, mod: analyse(view.content) });
    } catch (e) {
      if (e instanceof AbortError) throw e;
      // unreadable or unparsable: not a candidate file
    }
  }
  return out;
}

/** The engine's sandbox as the test runner of the baseline: workspace root, bounded output, summarised by the verifier's parsers. */
export async function runTestsInSandbox(ctx: SynthesisContext, command: string, timeoutMs: number): Promise<BaselineRun> {
  const started = Date.now();
  const res = await ctx.sandbox.run(command, { timeoutMs, maxOutputBytes: DEFAULT_TEST_OUTPUT_BYTES, signal: ctx.signal });
  const summary = summarize(command, res, res.durationMs > 0 ? res.durationMs : Date.now() - started);
  return { summary, output: res.stderr === '' ? res.stdout : `${res.stdout}\n${res.stderr}` };
}

// ---------------------------------------------------------------------------------------
// The synthesizer
// ---------------------------------------------------------------------------------------

/** Controller-private per-run facts that need no durability (a resume re-runs the baseline anyway). */
export interface RunScratch {
  /** wall clock of the first synthesize() call of this process for the run (wall remaining is approximated from it) */
  startedMs: number;
  baselineStep: number | null;
  /** the goal whose candidate the last `patch` carried (for the claim on the following `run` and a failed-apply rollback) and the evidence it was proposed with */
  lastCommit: { goalId: string; step: number; evidence: ProposalEvidence | null } | null;
  /** the baseline the last re-baseline replaced: `before` of the post-patch run's evidence (the fresh baseline is `after`) */
  previousBaseline: TestRunSummary | null;
  /** the checkpoint's synthState is consumed on the first baseline of the process */
  restored: boolean;
  /** goal id → the test-passing candidate the engine rejected: how often (same diff), whether a re-proposal is due (REPROPOSE_MAX), and its evidence */
  rejected: Map<string, { applied: AppliedCandidate; hash: string; times: number; pending: boolean; evidence: ProposalEvidence | null }>;
}

export class LedgerSieveSynthesizer implements Synthesizer {
  readonly name = 'ledger-sieve';
  private readonly deps: SearchDeps;
  private readonly scratch = new Map<string, RunScratch>();

  constructor(deps: SearchDeps) {
    this.deps = deps;
  }

  async synthesize(ctx: SynthesisContext): Promise<Proposal> {
    const mem = runMemory(ctx.runId);
    const scratch = this.scratchFor(ctx.runId);
    observeWindow(mem, ctx.window);
    // §5.1 row 2: last step's claims meet the judge's verdict before this step decides what to claim
    resolveClaims(mem, ctx.window, ctx.plan);
    mem.stepBudget = freshBudget(ctx.limits, mem.oracle, this.wallRemaining(ctx, scratch), { now: this.deps.now });
    try {
      const proposal = await this.step(ctx, mem, scratch, false);
      // only a `run` has its claims judged (on its parsed output); a `done` claims into the completion state and executes nothing
      if (proposal.action.kind === 'run' && proposal.plan.done.length > 0) recordClaims(mem, proposal.plan.done, ctx.step);
      return proposal;
    } finally {
      // §5.2: what survives a checkpoint, every step (the remembered partials beside memory.ts's record: bases.ts persistPartials); the ledger line every step.
      ctx.setSynthState(toJson({ ...toPersisted(mem), [PERSISTED_PARTIALS_KEY]: persistPartials(mem, mem.goals) }));
      this.emit(ctx, 'ledger', ledgerLine(mem.goals));
    }
  }

  private scratchFor(runId: string): RunScratch {
    let s = this.scratch.get(runId);
    if (s === undefined) {
      s = { startedMs: this.deps.now(), baselineStep: null, lastCommit: null, previousBaseline: null, restored: false, rejected: new Map() };
      this.scratch.set(runId, s);
    }
    return s;
  }

  /** Wall time the run has left, from this process's first call (SynthesisContext carries no elapsed wall time). */
  private wallRemaining(ctx: SynthesisContext, scratch: RunScratch): number {
    return Math.max(0, ctx.limits.maxWallMs - (this.deps.now() - scratch.startedMs));
  }

  private emit(ctx: SynthesisContext, phase: string, detail: string, counts: { candidates?: number; tested?: number } = {}): void {
    const e: EngineEvent = { type: 'synth', step: ctx.step, phase, detail, ...counts };
    ctx.emit(e);
  }

  /**
   * §2.2, one pass; `recursed` is the bounded second pass after a park, `prior` the trace of the
   * search that parked (so the step's `run` / partial `done` still records what was spent).
   */
  private async step(ctx: SynthesisContext, mem: RunMemory, scratch: RunScratch, recursed: boolean, prior?: GoalSearchTrace): Promise<Proposal> {
    if (ctx.signal.aborted) throw new AbortError('signal');
    if (!recursed) {
      if (ctx.directive !== null) {
        const d = await this.deps.handleDirective(ctx, mem);
        if (d.kind === 'proposal') return d.proposal;
      }
      const unexecuted = patchNotExecutedLastStep(ctx.window);
      if (unexecuted !== null) this.rollbackUnexecutedPatch(ctx, mem, scratch, unexecuted);
    }

    if (mem.baseline === null || scratch.baselineStep === null || workspaceChangedSince(scratch.baselineStep, ctx.window)) {
      const exit = await this.rebaseline(ctx, mem, scratch);
      if (exit !== null) return exit;
    }
    const baseline = mem.baseline;
    if (baseline === null) throw new Error('ledger-sieve: baseline missing after rebaseline');

    // §5.1: the full suite runs as an engine step so testsCurrent and lastTestRun see the oracle.
    // This is a standing obligation, not a one-step reflex: the engine has no test run of the
    // current workspace whenever a change was executed after its last run, or when it has never
    // executed the suite at all, and until it does every `patch` is scored against a plan whose
    // verification item never ran — "claims completion with no verifying test run in `recent`"
    // (level 4, blocked; the first live run lost a whole task to one declined run) or "skips a
    // planned verification step" (level 2; the second ladder run declined 5 verified patches
    // under `investigate` before any engine run). So the very first proposal of a run is that
    // `run`, whatever the intent (ESTABLISH_GOAL): the engine then has an executed baseline for
    // its `testsCurrent` and the plan_mismatch rubric. After a change the run claims the goals the
    // synthesizer's fresh baseline shows fixed (§5.1 row 2): its parsed output is the evidence
    // the `done_<j>` Noul verifies, and only accepted claims shrink the engine's `plan.remaining`,
    // which the completion Noul reads; each item is claimed once per verdict (proposal.ts
    // splitClaims). It is proposed only once the ledger exists (after the baseline above): a
    // `run` whose plan draft has no `remaining` reads as a completion claim (loop/state.ts
    // `claimsDone`; reviewed at 0.5–0.6 in the first live runs). It also precedes the green check
    // below: proposeDone's own fallback run carries the plain goal text, and the third QuixBugs
    // bench had that run reviewed at 0.33–0.58 as a repeat of the step-1 run that "failed", while
    // this path states the measured expectation.
    if (engineNeedsRun(mem)) {
      const never = mem.lastEngineRun === null;
      // the establishing run is not investigation the engine can decline in favour of a read: it is what makes the plan's first item real
      if (!never) {
        const read = this.investigateRead(ctx, mem);
        if (read !== null) return read;
      }
      const goal = scratch.lastCommit === null ? undefined : mem.goals.find((g) => g.id === scratch.lastCommit?.goalId);
      const command = baselineCommand(ctx);
      const changed = mem.lastChangeStep === null ? [] : (mem.committed.at(-1)?.files ?? []).map((f) => f.path);
      this.emit(ctx, 'verify', `${changed.length > 0 ? `${changed.join(', ')} changed since the engine's last test run` : 'the engine has not run the suite on this workspace'}: ${command}`);
      // §5.1 row 2: the run claims the fixed goals now, so the engine's done_<j> Noul judges them on this step's parsed output
      const run = proposeRun(ctx, command, 'full', goal, changed.length > 0, this.runTimeout(ctx, mem), undefined, mem);
      if (changed.length === 0) {
        if (!never) return run;
        const failing = `${baseline.failed + baseline.errors} of ${baseline.total} fail${baseline.failed + baseline.errors === 1 ? 's' : ''} in the synthesizer's own run`;
        return { ...run, goal: clip(`${ESTABLISH_GOAL} (${failing})`, PLAN_ITEM_MAX_CHARS) };
      }
      // The goal text says why the same command runs again and what the synthesizer's own baseline
      // measured, so the risk stage can tell this from "repeats a step that already failed the same
      // way" (the reading that had the re-run reviewed in the first live runs). The evidence is
      // the same measurement as data: the run before the patch (`previousBaseline`) against the
      // fresh baseline on the patched workspace, which this `run` re-executes in the engine.
      const last = mem.lastEngineRun;
      const expectation = `expect ${baseline.passed} of ${baseline.total} tests to pass${last === null ? '' : `, ${last.passed} passed in the last run`}`;
      const commit = scratch.lastCommit;
      const sel = commit?.evidence ? selectionFrom(commit.evidence) : { selection: 'sieve' as const, candidatesTested: 0, arbitrated: false };
      const evidence = scratch.previousBaseline === null || commit === null ? null : runEvidence(scratch.previousBaseline, baseline, goal, sel, command);
      return withEvidence({ ...run, goal: clip(`${run.goal} (${changed.join(', ')} changed since the last test run; ${expectation})`, PLAN_ITEM_MAX_CHARS) }, evidence);
    }

    if (allPass(baseline)) {
      // proposeDone applies §5.5 itself: `done` as soon as the engine has executed the green run on this
      // workspace (read from the window, else from mem.lastEngineRun, which outlives it), never another run then.
      this.emit(ctx, 'done', `baseline green: ${baseline.passed} tests pass, ${mem.committed.length} fix${mem.committed.length === 1 ? '' : 'es'} committed`);
      return proposeDone(ctx, mem, 'green');
    }

    // `investigate` is complied with once (a `read` of the files the ledger points at); the next
    // step proceeds to the search: a patch is what moves the task.
    const read = this.investigateRead(ctx, mem);
    if (read !== null) return read;

    const pick = await this.deps.pickGoal(ctx, mem);
    if (pick.requests > 0) mem.stepBudget.jevRequestsLeft = Math.max(0, mem.stepBudget.jevRequestsLeft - pick.requests);
    const goal = pick.goal;
    if (goal === null) {
      const reasons = mem.goals.filter((g) => g.status === 'parked').map((g) => g.parkedReason ?? 'parked');
      this.emit(ctx, 'done', `every goal parked: ${reasons.join('; ') || 'no goal'}`);
      return proposeDone(ctx, mem, 'partial', prior);
    }
    this.emit(ctx, 'goal', `${goal.id}: ${goal.planItem} (${goal.tests.length} test${goal.tests.length === 1 ? '' : 's'}, attempt ${goal.attempts}, picked by ${pick.method})`);
    const stash = scratch.rejected.get(goal.id);
    let r: SubGoalResult;
    // the shadow-run evidence the `patch` is proposed with: the search's outcome, or the stashed passer's own
    let evidence: ProposalEvidence | null = null;
    if (stash !== undefined && stash.pending) {
      // The engine rejected this passer for its plan or intent, not its content, and the workspace is
      // unchanged (a re-baseline clears the stash): propose it again instead of re-running the sieve.
      stash.pending = false;
      this.emit(ctx, 'repropose', `${goal.id}: proposing the rejected test-passing candidate again (${stash.times} of ${REPROPOSE_MAX} rejections)`);
      r = { kind: 'commit', applied: stash.applied, allGoalTestsPass: true, trace: { ...newTrace(goal, mem.oracle), outcome: 'fixed', winner: stash.applied } };
      evidence = stash.evidence;
    } else {
      r = await this.deps.searchSubGoal(ctx, mem, goal);
      if (r.kind !== 'commit') {
        // §13.4 (b): a passer the guard still holds for this goal is decided here — committed —
        // never dropped with the goal's bookkeeping on a park (the search drains it itself; this
        // is the controller's own guarantee).
        const held = commitSuspect(mem, goal);
        if (held !== null && held.kind === 'commit') {
          this.emit(ctx, 'guard', `${goal.id}: search ended ${r.kind} with a held passer; committing it${held.note === undefined ? '' : ` as ${held.note}`}`);
          r = { ...held, trace: { ...r.trace, outcome: 'fixed', winner: held.applied } };
        }
      }
      if (r.kind === 'commit') evidence = commitEvidence(mem, r, goal);
    }
    this.emit(ctx, 'search', `${goal.id} ${r.kind}${r.kind === 'parked' ? `: ${r.reason}` : ''} (phase ${r.trace.phase}, ${r.trace.runMode}, sites ${r.trace.sitesConsidered}, requests ${r.trace.jevRequests}, runs ${r.trace.testRuns}, plausible ${r.trace.plausible})`, {
      candidates: r.trace.candidatesEnumerated,
      tested: r.trace.candidatesTested,
    });

    switch (r.kind) {
      case 'commit': {
        recordCommit(mem, r.applied);
        noteCommit(goal, r.allGoalTestsPass);
        forgetGoal(mem, goal);
        scratch.lastCommit = { goalId: goal.id, step: ctx.step, evidence };
        // A commit changes the goal's files: it re-localises next time, and parked goals that suspected those files re-open (§5.3).
        mem.localizeCache.delete(goal.id);
        reopenOnChange(mem, r.applied.files.map((f) => f.path));
        // §5.1 row 1 with evidence: the shadow run the commit rests on goes with the patch, so the
        // engine's risk and judge stages read a verified change (loop/state.ts proposal.evidence).
        return proposePatch(ctx, r.applied, goal, mem, r.note, r.trace, evidence);
      }
      case 'parked': {
        // A park keeps the goal's remembered partials (bases.ts forgetHeld): they are the input of
        // the pairs a reopened search runs first, and they are persisted with the ledger.
        park(goal, r.reason);
        forgetHeld(mem, goal);
        if (!mem.stepBudget.recursed) {
          mem.stepBudget.recursed = true;
          return this.step(ctx, mem, scratch, true, r.trace);
        }
        return this.subsetRun(ctx, mem, goal, r.trace);
      }
      case 'budget': {
        // Untested pairs of complementary partials are progress the tests have not judged yet
        // (ladder `account`: both gold half-fixes found with 2 s of wall left, then parked and
        // forgotten): the goal stays open and the next step runs the pairs first.
        const pairs = freshPairsOfPartials(mem, goal);
        if (pairs.length > 0) {
          goal.status = 'open';
          this.emit(ctx, 'pairs', `${goal.id}: ${pairs.length} untested pair${pairs.length === 1 ? '' : 's'} of complementary partials; the goal stays open and resumes from them`);
          return this.subsetRun(ctx, mem, goal, r.trace);
        }
        // §5.3: two consecutive budget-hit steps or three searches without a commit park the goal; else it stays open and resumes next step.
        const hit = noteBudgetHit(goal);
        const reason = hit ?? parkReasonFor(goal);
        if (reason === null) goal.status = 'open';
        else {
          if (hit === null) park(goal, reason);
          forgetHeld(mem, goal);
        }
        return this.subsetRun(ctx, mem, goal, r.trace);
      }
      case 'continue':
        // The sub-goal search never returns 'continue' (it is the guard's per-batch verdict); treat it as a budget exit.
        goal.status = 'open';
        return this.subsetRun(ctx, mem, goal, r.trace);
    }
  }

  /**
   * Under an `investigate` intent a `patch` or a `run` scores as "does not carry out the intent"
   * (the first live run had every such proposal reviewed or blocked under a p ≈ 0.5 `investigate`).
   * Comply once: read the source files the ledger points at — those not yet in `contextFiles`
   * first, else the last patch's files, else the open goals' site or suspected source files — and
   * return null after INVESTIGATE_READS_MAX consecutive executed `read`s (the search proceeds) or
   * when no intent asks for it. Never test files; ≤ READ_MAX_PATHS.
   */
  private investigateRead(ctx: SynthesisContext, mem: RunMemory): Proposal | null {
    if (ctx.intent !== 'investigate') return null;
    // every trailing `read` proposal counts, executed or not: a declined or blocked read re-proposed
    // until the engine's loop guard trips is what the third QuixBugs bench did on depth_first_search
    let reads = 0;
    for (let i = ctx.window.length - 1; i >= 0; i--) {
      const e = ctx.window[i];
      if (e === undefined || !/^read(\s|$)/.test(e.action)) break;
      reads += 1;
    }
    if (reads >= INVESTIGATE_READS_MAX) return null;
    let paths = unseenSourceFiles(ctx, mem);
    if (paths.length === 0) paths = (mem.committed.at(-1)?.files ?? []).map((f) => f.path).filter((p) => !isTestPath(p));
    if (paths.length === 0) paths = relevantSourceFiles(mem);
    // pytest goals point at test files only (tracebacks show test frames, goals.ts): on a small
    // workspace the source files themselves are what there is to investigate
    if (paths.length === 0) {
      const source = [...(mem.bases.find((b) => b.origin === 'committed')?.files.keys() ?? [])].filter((p) => !isTestPath(p));
      if (source.length <= READ_MAX_PATHS) paths = source;
    }
    if (paths.length === 0) return null;
    const bounded = paths.slice(0, READ_MAX_PATHS);
    this.emit(ctx, 'read', `intent is investigate: reading ${bounded.join(', ')}`);
    return proposeRead(ctx, bounded, mem);
  }

  /** The cheap evidence step: a goal-subset `run` on the workspace; the search resumes from memory next step. The step's trace goes into `rawText` (§5.6: totals per record). */
  private subsetRun(ctx: SynthesisContext, mem: RunMemory, goal: Goal, trace: GoalSearchTrace): Proposal {
    const command = mem.baseline === null ? baselineCommand(ctx) : subsetCommand(mem.oracle, goal, workspaceLane(ctx.workspaceInfo.root), { command: mem.baseline.command, workspaceRoot: ctx.workspaceInfo.root });
    return proposeRun(ctx, command, 'subset', goal, false, this.runTimeout(ctx, mem), trace, mem);
  }

  /** §4.1 runTimeoutMs once the oracle is fitted, the engine's command timeout before. */
  private runTimeout(ctx: SynthesisContext, mem: RunMemory): number {
    const cap = Math.min(ctx.limits.commandTimeoutMs, ctx.limits.maxCommandTimeoutMs);
    return mem.baseline === null ? cap : Math.min(cap, Math.max(1, mem.oracle.runTimeoutMs));
  }

  /**
   * The previous step's `patch` was not executed, so the workspace is still the committed base and
   * the commit the synthesizer recorded for it is undone: the goal returns to `open` (its attempts
   * stand: §5.3 counts searches without a commit, and this was one), the candidate leaves
   * `committed` and, unless the patch failed to apply, is stashed to be proposed once more on the
   * goal's next turn (REPROPOSE_MAX; it passed the tests on this very workspace) — it stays in
   * `tried` either way, so the sieve never re-runs it. A `failed` outcome (did not apply) also
   * means the files the synthesizer holds are not the workspace's (the engine's `git apply --check`
   * compared them): the goal's sites are invalidated and the next step re-reads the workspace and
   * re-runs the baseline (§5.3). One test run is the price of a consistent base.
   */
  private rollbackUnexecutedPatch(ctx: SynthesisContext, mem: RunMemory, scratch: RunScratch, why: { outcome: OutcomeStatus | null; reason: string }): void {
    const applyFailed = why.outcome === 'failed';
    const stale = applyFailed ? invalidateStaleSites(ctx, mem) : [];
    const last = scratch.lastCommit;
    let undoneGoal = '';
    if (last !== null) {
      const goal = mem.goals.find((g) => g.id === last.goalId);
      if (goal !== undefined && goal.status === 'fixed') {
        goal.status = 'open';
        undoneGoal = goal.id;
      }
      const undone = mem.committed.pop();
      if (undone !== undefined) {
        const h = diffHash(undone.diff);
        const at = mem.committedDiffHashes.lastIndexOf(h);
        if (at !== -1) mem.committedDiffHashes.splice(at, 1);
        if (!applyFailed) {
          const prev = scratch.rejected.get(last.goalId);
          const times = (prev !== undefined && prev.hash === h ? prev.times : 0) + 1;
          scratch.rejected.set(last.goalId, { applied: undone, hash: h, times, pending: times <= REPROPOSE_MAX, evidence: last.evidence });
        }
      }
      scratch.lastCommit = null;
    }
    if (applyFailed) scratch.baselineStep = null;
    const what = why.outcome ?? 'not executed';
    const detail = applyFailed
      ? `patch did not apply; re-reading the workspace${stale.length > 0 ? `, re-localising ${stale.join(', ')}` : ''}`
      : `patch ${what}${why.reason.length > 0 ? ` (${clip(why.reason, ROLLBACK_REASON_CHARS)})` : ''}; commit undone${undoneGoal !== '' ? `, ${undoneGoal} open again` : ''}`;
    this.emit(ctx, 'rollback', detail);
  }

  /**
   * §2.2 lines 4–6: one full-suite run on the committed workspace, the oracle model from it, the
   * ledger reconciled with the fresh failure clusters (rebuilt from the checkpoint on the first
   * baseline of a resumed run). Returns a Proposal only for the §4.1 exit (timed-out baseline →
   * every goal parked, propose the full command so the judge sees it).
   */
  private async rebaseline(ctx: SynthesisContext, mem: RunMemory, scratch: RunScratch): Promise<Proposal | null> {
    const files = await this.deps.loadFiles(ctx);
    const command = baselineCommand(ctx);
    const timeoutMs = Math.min(ctx.limits.commandTimeoutMs, ctx.limits.maxCommandTimeoutMs);
    const { summary: baseline, output } = await this.deps.runTests(ctx, command, timeoutMs);
    const paths = (await ctx.workspace.listCandidates()).map((c) => c.path);
    const layout = detectLayout([...files.keys(), ...paths]);
    const sourcePaths = [...files.keys()];
    const clusterOpts = { output, sourcePaths, ...(layout === 'quixbugs' ? { defaultFiles: sourcePaths.filter((p) => p !== 'node.py') } : {}) };

    // the run before this one is `before` of the post-patch run's evidence (see step())
    scratch.previousBaseline = mem.baseline;
    mem.baseline = baseline;
    scratch.baselineStep = ctx.step;
    mem.oracle = fitOracle(baseline, { commandTimeoutMs: ctx.limits.commandTimeoutMs, wallRemainingMs: this.wallRemaining(ctx, scratch), workspace: { git: ctx.workspaceInfo.git } });
    mem.stepBudget = freshBudget(ctx.limits, mem.oracle, this.wallRemaining(ctx, scratch), { now: this.deps.now });
    // Partials held against the old workspace are stale; the committed base is the new workspace.
    mem.bases = [committedBase(files, baseline)];
    mem.localizeCache.clear();
    // The runner caches the goal-subset baseline per base id, and `committed` keeps its id across
    // workspaces: without this every candidate on the new workspace is compared with the old
    // subset (the first live run classified 48 no-op mutants as `partial` after a commit). Deferred
    // jobs reference the old base too.
    mem.subsetBaselines = new Map();
    mem.deferred = new Map();
    // a rejected candidate's diff was made against the previous workspace
    scratch.rejected.clear();
    this.emit(ctx, 'baseline', `${baseline.passed}/${baseline.total} pass, ${baseline.failed} failed, ${baseline.errors} errors in ${baseline.durationMs} ms (${layout}, ${mem.oracle.runner}, ${command})`);
    if (baseline.timedOut) {
      // §4.1: a timed-out baseline parks the run's goals. A timed-out summary names no test, so the
      // ledger is not reconciled from it (that would mark every persisted goal fixed): the goals
      // known so far are parked (on the first call of a process, those the checkpoint and the plan
      // carry), and a run that knows none yet gets one goal for the run itself, so the partial
      // `done` that follows names the reason instead of "0 of 0".
      if (!scratch.restored) {
        rebuildFromPlan(mem, ctx.plan, isPersistedSearchState(ctx.synthState) ? ctx.synthState : null);
        scratch.restored = true;
      }
      if (mem.goals.length === 0) mem.goals.push(newGoal('g1', [...baseline.failing], [...baseline.failures], sourcePaths.filter((p) => p !== 'node.py')));
      for (const g of mem.goals) if (g.status !== 'fixed') park(g, SUITE_TOO_SLOW);
      this.emit(ctx, 'verify', `${SUITE_TOO_SLOW}: baseline timed out after ${timeoutMs} ms; ${mem.goals.length} goal${mem.goals.length === 1 ? '' : 's'} parked`);
      return proposeRun(ctx, command, 'full', undefined, false, timeoutMs, undefined, mem);
    }
    if (!scratch.restored) {
      // §2.1 durability: goal state from the checkpoint's synthState, plan items from plan.remaining, both by test id.
      const persisted = isPersistedSearchState(ctx.synthState) ? ctx.synthState : null;
      const committed = mem.committed;
      restoreMemory(mem, rebuildFromPlan(ctx.plan, baseline, persisted, clusterOpts));
      mem.committed = committed;
      mem.bases = [committedBase(files, baseline)];
      // the checkpoint's remembered partials (bases.ts), where their edits still apply and their tests still fail
      const restored = restorePartials(mem, partialsFromPersisted(ctx.synthState), mem.goals);
      if (restored > 0) this.emit(ctx, 'pairs', `${restored} remembered partial${restored === 1 ? '' : 's'} restored from the checkpoint`);
      scratch.restored = true;
    } else {
      mem.goals = reconcile(mem.goals, clusterFailures(baseline, clusterOpts), ctx.plan);
    }
    return null;
  }
}

export interface SynthesizerOptions {
  /** the run's decider; not used directly (all Jev goes through ctx.ask) but kept for the wiring contract */
  decider: Decider;
  redact: (s: string) => string;
}

/** The §6 factory: `createSynthesizer(opts, deps)`; src/synth/index.ts supplies the real `deps`. */
export function createSynthesizer(_opts: SynthesizerOptions, deps: SearchDeps): Synthesizer {
  return new LedgerSieveSynthesizer(deps);
}
