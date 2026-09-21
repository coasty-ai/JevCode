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
import { SPEC_FILE } from '../../workspace/tests.js';
import { harvestHistory } from '../history/index.js';
import type { HistoryFacts } from '../history/index.js';
import { introspectRepro, setRunFacts } from '../introspect/index.js';
import type { IntrospectedNames } from '../introspect/index.js';
import type { ReproSpec, VerifyReproResult } from '../oracle/goal.js';
import { BEST_GUESS_PARK_REASON, BEST_GUESS_REJECTED_REASON, bestGuessFailure, bestGuessTestId, chooseRegressionScope, emptyScopedSummary, findIssueOracle, frameworkOf, isBestGuessTestId, isRepositoryWorkspace, mergeSummaries, packageNameOf, regressionCommandTemplate, scopeCommand, scopedPartOf, venvPython, verifyRepro } from '../oracle/index.js';
import type { OracleSearch, OracleSearchInput, TracebackFrame } from '../oracle/index.js';
import { analyse } from '../py/structure.js';
import { forgetUnchangedTried, subsetCommand } from '../sieve/runner.js';
import type { RunnerMemory } from '../sieve/runner.js';
import type { AppliedCandidate, LocalizeResult, SourceFile, TestRunSummary } from '../types.js';
import { DEFAULT_TEST_OUTPUT_BYTES, isTestFile, sandboxRunFn, summarize } from '../verify/index.js';
import { PERSISTED_PARTIALS_KEY, forgetGoal, forgetHeld, freshPairsOfPartials, partialsFromPersisted, persistPartials, restorePartials } from './bases.js';
import { fitOracle, freshBudget, laneCount } from './budget.js';
import { defaultOverrides, handleDirective, invalidateStaleSites } from './directive.js';
import type { DirectiveMemory, DirectiveResult } from './directive.js';
import { MAX_BUDGET_HIT_STEPS, MAX_CONSECUTIVE_BUDGET_HITS, MAX_PROGRESS_COMMITS_PER_GOAL, clusterFailures, ledgerLine, newGoal, noteBudgetHit, noteCommit, park, parkReasonFor, pickGoalDetailed, reconcile, reopenOnChange } from './goals.js';
import { commitSuspect } from './guard.js';
import type { GoalPick } from './goals.js';
import { attachPlanItems, diffHash, getMemory, planItemFor, rebuildFromPlan, recordClaims, recordCommit, repositoryFromPersisted, resolveClaims, restoreMemory, toPersisted } from './memory.js';
import type { PersistedRepositoryState, RepositoryMode, RepositoryScope, SearchMemory } from './memory.js';
import { BEST_GUESS_NOTE, bestGuessGoalText, commitEvidence, goalTestsPassing, proposeDone, proposePatch, proposeRun, runEvidence, selectionFrom, withEvidence } from './proposal.js';
import { commitProgress, everySiteSeedsExhausted, isTestPath, newTrace, taskIdentifiers } from './subgoal.js';
import type { ProgressOptions, RegressionRun, SubGoalMemory, SubGoalResult } from './subgoal.js';
import type { Base, Goal, GoalSearchTrace, Lane, PersistedSearchState } from './types.js';
import { isPersistedSearchState } from './types.js';

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

/** Full-suite command when the workspace detector found none (the QuixBugs and ladder layouts are pytest modules under tests/). */
export const DEFAULT_TEST_COMMAND = 'python3 -m pytest -q';
/**
 * Workspace Python files loaded into the committed base (localisation and donor corpus). Django
 * has 858 non-test source files and sympy 746 (analysed in 0.3 s and 1.7 s); the repo-wide file
 * Nouls that found the gold file #1 on 23/30 SWE instances saw every source file, so the cap
 * sits above both. Files whose stem the task text names load first, so a cut keeps them.
 */
export const MAX_WORKSPACE_PY_FILES = 1200;
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
/** The same obligation on a repository workspace, where the suite is the regression scope (never the whole Django/sympy suite). */
export const ESTABLISH_GOAL_REPOSITORY = 'establish the baseline: run the regression scope before any change';
/**
 * Repository mode: the scoped baseline may take minutes (six sympy test files run 1–3 min), so it
 * gets the run's maximum command timeout up to this bound, and a scoped run that still times out
 * is retried once on its top REPO_SCOPE_RETRY_FILES files before the §4.1 park.
 */
export const REPO_BASELINE_TIMEOUT_MS = 300_000;
export const REPO_SCOPE_RETRY_FILES = 2;
/** Module files (top of the localiser's file beam) that bound the regression scope and name the goal's suspected files. */
export const REPO_MODULE_FILES_MAX = 3;
/** Test files whose contents are read for the regression scope's import check (Django has 1,185; reading them takes ≈ 130 ms). */
export const REPO_TEST_CONTENTS_MAX = 2000;

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
  /** search/subgoal.ts searchBestGuess: repository mode without a reproduction oracle (rank, regression scope only, one commit) */
  searchBestGuess(ctx: SynthesisContext, mem: RunMemory, goal: Goal): Promise<SubGoalResult>;
  /** the localiser's beam plus the goal sites for one goal (src/synth/index.ts locate); repository mode calls it at the establishing step so the module files bound the regression scope */
  locate(ctx: SynthesisContext, mem: RunMemory, goal: Goal): Promise<LocalizeResult>;
  /** oracle/search.ts findIssueOracle over the task text, run in the committed workspace; default below */
  findOracle(ctx: SynthesisContext, input: { packageName: string | null; framework: 'django' | null }): Promise<OracleSearch>;
  /** the regression scope for the localised module files (oracle/search.ts chooseRegressionScope + regressionCommandTemplate); default below */
  regressionScope(ctx: SynthesisContext, moduleFiles: readonly string[], paths: readonly string[], max?: number): Promise<RepositoryScope>;
  /** the reproduction re-run on the committed workspace with its venv (oracle/goal.ts verifyRepro); default below */
  verifyRepro(ctx: SynthesisContext, spec: ReproSpec): Promise<VerifyReproResult>;
  /**
   * The introspection pass over the reproduction in the committed workspace with its venv
   * (introspect/index.ts introspectRepro: the operands of the failing call, their MRO class names,
   * `is_*` predicates, the raising module's names); null when nothing was harvested. Default below.
   */
  introspect(ctx: SynthesisContext, spec: ReproSpec, anchors: readonly TracebackFrame[]): Promise<IntrospectedNames | null>;
  /** ≤ 8 read-only git commands over the localised module files (history/harvest.ts); null when nothing was harvested. Default below. */
  harvestHistory(ctx: SynthesisContext, moduleFiles: readonly string[], sources: readonly SourceFile[]): Promise<HistoryFacts | null>;
  /** the workspace's non-test Python files (path → analysed source); default reads through ctx.workspace */
  loadFiles(ctx: SynthesisContext): Promise<Map<string, SourceFile>>;
  /** one test command in the workspace root through ctx.sandbox, summarised; default below */
  runTests(ctx: SynthesisContext, command: string, timeoutMs: number): Promise<BaselineRun>;
  /** search/goals.ts pickGoal (Q1 when ≥ 2 open goals) */
  pickGoal(ctx: SynthesisContext, mem: RunMemory): Promise<GoalPick>;
  /** search/directive.ts handleDirective (§5.4) */
  handleDirective(ctx: SynthesisContext, mem: RunMemory): Promise<DirectiveResult>;
  /** the regression run of a progress commit the controller makes itself (subgoal.ts commitProgress); the runner's own when absent */
  regressionRun?: RegressionRun;
  now(): number;
}

/** The real collaborators for everything but the sub-goal searches and the localiser (src/synth/index.ts adds those). */
export function defaultSearchDeps(): Omit<SearchDeps, 'searchSubGoal' | 'searchBestGuess' | 'locate'> {
  return {
    loadFiles: loadPythonFiles,
    runTests: runTestsInSandbox,
    findOracle: findOracleInWorkspace,
    regressionScope: regressionScopeInWorkspace,
    verifyRepro: verifyReproInWorkspace,
    introspect: introspectInWorkspace,
    harvestHistory: harvestHistoryInWorkspace,
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

/** 1 when the task text names the file's stem (`mathematica`, `decorators`; a package's directory name for `__init__.py`), else 0. */
export function mentionedInTask(path: string, task: string): number {
  const segs = path.replace(/\.py$/, '').split('/');
  let stem = segs.pop() ?? '';
  if (stem === '__init__') stem = segs.pop() ?? '';
  return stem.length >= 3 && task.includes(stem) ? 1 : 0;
}

/**
 * Non-test Python files of the workspace, read and analysed; unparsable or truncated files are
 * skipped. Task-named files first, then alphabetical, cut at MAX_WORKSPACE_PY_FILES. Every file
 * is re-read on every call (a patch may have changed any of them), but a file whose text equals
 * the run's cached copy (`SearchMemory.fileCache`, memory.ts) is handed back as the same
 * `SourceFile` object instead of being analysed again: a re-baseline on Django re-analyses the
 * one or two files the commit touched, not 858, and the process holds one analysed corpus per
 * run, not one per re-baseline. The cache is the run memory's; `cache` overrides it (tests).
 */
export async function loadPythonFiles(ctx: SynthesisContext, cache: Map<string, SourceFile> = getMemory(ctx.runId).fileCache): Promise<Map<string, SourceFile>> {
  const started = Date.now();
  const out = new Map<string, SourceFile>();
  const paths = (await ctx.workspace.listCandidates())
    .map((c) => c.path)
    .filter((p) => p.endsWith('.py') && !isTestPath(p) && !p.includes('.jevcode-synth/'))
    .sort((a, b) => mentionedInTask(b, ctx.task) - mentionedInTask(a, ctx.task) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_WORKSPACE_PY_FILES);
  let reused = 0;
  let analysed = 0;
  for (const path of paths) {
    if (ctx.signal.aborted) throw new AbortError('signal');
    try {
      const view = await ctx.workspace.read(path, MAX_PY_FILE_BYTES);
      if (view.truncatedBytes > 0) continue;
      const cached = cache.get(path);
      if (cached !== undefined && cached.src === view.content) {
        out.set(path, cached);
        reused += 1;
        continue;
      }
      const file: SourceFile = { path, src: view.content, mod: analyse(view.content) };
      out.set(path, file);
      cache.set(path, file);
      analysed += 1;
    } catch (e) {
      if (e instanceof AbortError) throw e;
      // unreadable or unparsable: not a candidate file
    }
  }
  // a file that vanished (or is no longer listed, or failed to parse) leaves the cache with it
  for (const path of [...cache.keys()]) if (!out.has(path)) cache.delete(path);
  if (reused > 0) ctx.emit({ type: 'synth', step: ctx.step, phase: 'files', detail: `${out.size} Python files: ${reused} unchanged since the last load (reused), ${analysed} analysed (${Date.now() - started} ms)` });
  return out;
}

/** The engine's sandbox as the test runner of the baseline: workspace root, bounded output, summarised by the verifier's parsers. */
export async function runTestsInSandbox(ctx: SynthesisContext, command: string, timeoutMs: number): Promise<BaselineRun> {
  const started = Date.now();
  const res = await ctx.sandbox.run(command, { timeoutMs, maxOutputBytes: DEFAULT_TEST_OUTPUT_BYTES, signal: ctx.signal });
  const summary = summarize(command, res, res.durationMs > 0 ? res.durationMs : Date.now() - started);
  return { summary, output: res.stderr === '' ? res.stdout : `${res.stdout}\n${res.stderr}` };
}

/** The oracle from the issue, run in the committed workspace with its venv (oracle/search.ts findIssueOracle). */
export async function findOracleInWorkspace(ctx: SynthesisContext, input: { packageName: string | null; framework: 'django' | null }): Promise<OracleSearch> {
  const root = ctx.workspaceInfo.root;
  const python = await venvPython(root);
  const o: OracleSearchInput = {
    task: ctx.task,
    repository: input.packageName ?? 'the repository',
    packageName: input.packageName,
    framework: input.framework,
    workspace: root,
    ask: (stage, state, questions) => ctx.ask(stage, state, questions),
    run: sandboxRunFn(ctx.sandbox, ctx.signal),
    stage: 'propose',
  };
  if (python !== undefined) o.python = python;
  return findIssueOracle(o);
}

/** The harness's own test command from `.jevcode-spec.json` at the workspace root (bench loaders write it), or null. */
export async function readSpecTestCommand(ctx: SynthesisContext): Promise<string | null> {
  try {
    const view = await ctx.workspace.read(SPEC_FILE, 8192);
    const parsed: unknown = JSON.parse(view.content);
    if (typeof parsed === 'object' && parsed !== null && 'test_cmd' in parsed) {
      const cmd = (parsed as { test_cmd?: unknown }).test_cmd;
      if (typeof cmd === 'string' && cmd.trim() !== '') return cmd;
    }
  } catch {
    /* no spec, unreadable or malformed: the detector's command alone */
  }
  return null;
}

/** The regression scope for the localised module files: ≤ 6 test files (contents read for the import check) and the scoped command on the harness's template. */
export async function regressionScopeInWorkspace(ctx: SynthesisContext, moduleFiles: readonly string[], paths: readonly string[], max?: number): Promise<RepositoryScope> {
  const info = ctx.workspaceInfo.testCommand;
  const template = info === null ? { command: DEFAULT_TEST_COMMAND, runner: 'pytest' as const } : regressionCommandTemplate({ command: normaliseTestCommand(info.command), runner: info.runner }, await readSpecTestCommand(ctx));
  const contents = new Map<string, string>();
  for (const p of paths.filter(isTestFile).slice(0, REPO_TEST_CONTENTS_MAX)) {
    if (ctx.signal.aborted) throw new AbortError('signal');
    try {
      const v = await ctx.workspace.read(p, MAX_PY_FILE_BYTES);
      if (v.truncatedBytes === 0) contents.set(p, v.content);
    } catch (e) {
      if (e instanceof AbortError) throw e;
    }
  }
  const choice = chooseRegressionScope(paths, moduleFiles, { contents: (p) => contents.get(p) ?? null, ...(max === undefined ? {} : { max }) });
  return { ...choice, command: scopeCommand(template, choice.testFiles) };
}

/** The reproduction on the committed workspace itself (the post-patch re-check), with the workspace venv. */
export async function verifyReproInWorkspace(ctx: SynthesisContext, spec: ReproSpec): Promise<VerifyReproResult> {
  const root = ctx.workspaceInfo.root;
  return verifyRepro(sandboxRunFn(ctx.sandbox, ctx.signal), root, spec, await venvPython(root));
}

/** The introspection pass of the reproduction in the committed workspace with its venv (introspect/index.ts), through the engine's sandbox; ≤ 60 s. */
export async function introspectInWorkspace(ctx: SynthesisContext, spec: ReproSpec, anchors: readonly TracebackFrame[]): Promise<IntrospectedNames | null> {
  const root = ctx.workspaceInfo.root;
  const python = await venvPython(root);
  return introspectRepro(sandboxRunFn(ctx.sandbox, ctx.signal), spec, { workspace: root, anchors, ...(python === undefined ? {} : { python }) });
}

/** The git history of the localised module files (history/harvest.ts): the ticket / commit the issue names, `-S<identifier>` for its identifiers; read-only, ≤ 8 commands of 10 s. */
export async function harvestHistoryInWorkspace(ctx: SynthesisContext, moduleFiles: readonly string[], sources: readonly SourceFile[]): Promise<HistoryFacts | null> {
  if (moduleFiles.length === 0) return null;
  return harvestHistory(sandboxRunFn(ctx.sandbox, ctx.signal), { workspace: ctx.workspaceInfo.root, files: moduleFiles, task: ctx.task, identifiers: taskIdentifiers(ctx.task), sources });
}

/** The goal of a repository workspace is the oracle's reproduction or the one best guess; both are told apart by their synthetic test id. */
export function isBestGuessGoal(goal: Pick<Goal, 'tests'>): boolean {
  const first = goal.tests[0];
  return first !== undefined && isBestGuessTestId(first);
}

/** Notes the repository mode adds to a `done` (and to the transcript): the oracle's outcome, the scope, the known failures. */
export function repositoryNotes(repo: RepositoryMode): string[] {
  const notes = [`oracle from the issue: ${repo.oracleOutcome} (${repo.oracleNote})`, `regression scope: ${repo.scope.testFiles.length} test file${repo.scope.testFiles.length === 1 ? '' : 's'} (${repo.scope.tier}): ${repo.scope.note}`];
  if (repo.knownFailures > 0) notes.push(`${repo.knownFailures} scoped test${repo.knownFailures === 1 ? '' : 's'} fail at the base commit too (pre-existing, not goals)`);
  return notes;
}

/**
 * The module files a localisation names, non-test, top REPO_MODULE_FILES_MAX: the file beam in
 * order, else the files of the located sites, else the traceback anchors resolved to workspace paths.
 */
export function moduleFilesOf(loc: LocalizeResult | null, traceback: string | null, files: ReadonlyMap<string, SourceFile>): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    if (!isTestPath(p) && files.has(p) && !out.includes(p) && out.length < REPO_MODULE_FILES_MAX) out.push(p);
  };
  if (loc !== null) {
    for (const f of loc.files) push(f.path);
    if (out.length === 0) for (const s of loc.sites) push(s.file.path);
  }
  if (out.length === 0 && traceback !== null) {
    for (const m of traceback.matchAll(/File "([^"]+)"/g)) {
      const raw = (m[1] ?? '').replace(/^\.\//, '');
      if (files.has(raw)) push(raw);
      else for (const p of files.keys()) if (raw.endsWith(`/${p}`)) push(p);
    }
  }
  return out;
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
  /** repository mode: the reproduction the oracle search just ran on this workspace, reused by the baseline that follows it (one run, not two) */
  freshRepro: VerifyReproResult | null;
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
      s = { startedMs: this.deps.now(), baselineStep: null, lastCommit: null, previousBaseline: null, restored: false, rejected: new Map(), freshRepro: null };
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
      const goal = scratch.lastCommit === null ? undefined : mem.goals.find((g) => g.id === scratch.lastCommit?.goalId);
      // repository mode: the baseline's command is the regression scope, never the whole suite
      const command = mem.baseline?.command ?? baselineCommand(ctx);
      const repo = mem.repository;
      const changed = mem.lastChangeStep === null ? [] : (mem.committed.at(-1)?.files ?? []).map((f) => f.path);
      this.emit(ctx, 'verify', `${changed.length > 0 ? `${changed.join(', ')} changed since the engine's last test run` : 'the engine has not run the suite on this workspace'}: ${command}`);
      // §5.1 row 2: the run claims the fixed goals now, so the engine's done_<j> Noul judges them on this step's parsed output
      const run = proposeRun(ctx, command, 'full', goal, changed.length > 0, this.runTimeout(ctx, mem), undefined, mem);
      const shown = repo === undefined ? baseline : scopedPartOf(baseline);
      if (changed.length === 0) {
        if (!never) return run;
        if (repo !== undefined) {
          const repro = repo.repro === null ? 'no reproduction oracle from the issue text' : `the issue's reproduction ${repo.repro.spec.testId} ${repo.lastRepro?.verdict.pass === true ? 'passes' : 'fails'}`;
          const known = `${shown.failed + shown.errors} of ${shown.total} scoped tests fail at the base commit`;
          return { ...run, goal: clip(`${ESTABLISH_GOAL_REPOSITORY} (${known}; ${repro})`, PLAN_ITEM_MAX_CHARS) };
        }
        const failing = `${baseline.failed + baseline.errors} of ${baseline.total} fail${baseline.failed + baseline.errors === 1 ? 's' : ''} in the synthesizer's own run`;
        return { ...run, goal: clip(`${ESTABLISH_GOAL} (${failing})`, PLAN_ITEM_MAX_CHARS) };
      }
      // The goal text says why the same command runs again and what the synthesizer's own baseline
      // measured, so the risk stage can tell this from "repeats a step that already failed the same
      // way" (the reading that had the re-run reviewed in the first live runs). The evidence is
      // the same measurement as data: the run before the patch (`previousBaseline`) against the
      // fresh baseline on the patched workspace, which this `run` re-executes in the engine.
      const last = mem.lastEngineRun;
      const reproNow = repo !== undefined && repo.repro !== null && repo.lastRepro !== null ? ` and the reproduction to ${repo.lastRepro.verdict.pass ? 'pass' : 'still fail'}` : '';
      const expectation = `expect ${shown.passed} of ${shown.total} tests to pass${reproNow}${last === null ? '' : `, ${last.passed} passed in the last run`}`;
      const commit = scratch.lastCommit;
      const sel = commit?.evidence ? selectionFrom(commit.evidence) : { selection: 'sieve' as const, candidatesTested: 0, arbitrated: false };
      const evidence = scratch.previousBaseline === null || commit === null ? null : runEvidence(scratch.previousBaseline, baseline, goal, sel, command);
      return withEvidence({ ...run, goal: clip(`${run.goal} (${changed.join(', ')} changed since the last test run; ${expectation})`, PLAN_ITEM_MAX_CHARS) }, evidence);
    }

    // Repository mode: a green scoped run at the base commit is not a finished task (the goals come
    // from the oracle, not from the scoped run), so green means every goal fixed as well.
    if (allPass(baseline) && (mem.repository === undefined || (mem.goals.length > 0 && mem.goals.every((g) => g.status === 'fixed')))) {
      // proposeDone applies §5.5 itself: `done` as soon as the engine has executed the green run on this
      // workspace (read from the window, else from mem.lastEngineRun, which outlives it), never another run then.
      this.emit(ctx, 'done', `baseline green: ${baseline.passed} tests pass, ${mem.committed.length} fix${mem.committed.length === 1 ? '' : 'es'} committed`);
      return proposeDone(ctx, mem, 'green');
    }

    // No `read` under any intent: the synthesizer holds every source file (loadPythonFiles), and
    // the `investigate` reads it used to propose were declined at review-band risk 7–12 times per
    // miss in bench runs with no reviewer, tripping the loop detector into `max_replans`
    // (jev-only-rungs-1-2.md §19.7). A verified `patch` or a goal-subset `run` is what moves the
    // task, and its evidence is what the risk stage reads.
    const pick = await this.deps.pickGoal(ctx, mem);
    if (pick.requests > 0) mem.stepBudget.jevRequestsLeft = Math.max(0, mem.stepBudget.jevRequestsLeft - pick.requests);
    const goal = pick.goal;
    if (goal === null) {
      const reasons = mem.goals.filter((g) => g.status === 'parked').map((g) => g.parkedReason ?? 'parked');
      this.emit(ctx, 'done', `every goal parked: ${reasons.join('; ') || 'no goal'}`);
      return proposeDone(ctx, mem, 'partial', prior, mem.repository === undefined ? [] : repositoryNotes(mem.repository));
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
    } else if (isBestGuessGoal(goal)) {
      // one best guess per run (docs brief item 3): after its commit (or the engine's rejection of it) the goal parks
      if (mem.repository?.bestGuessCommitted === true) r = { kind: 'parked', reason: BEST_GUESS_REJECTED_REASON, trace: { ...newTrace(goal, mem.oracle), outcome: 'exhausted' } };
      else r = await this.deps.searchBestGuess(ctx, mem, goal);
      if (r.kind === 'commit') {
        const e = commitEvidence(mem, r, goal);
        // nothing verified the fix: the evidence names no goal test and says the top-k were ranked, not sieved
        evidence = e === null ? null : { ...e, goalTests: [], selection: 'rank' };
      }
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
      if (r.kind !== 'commit') {
        // The same guarantee for the held partial (subgoal.ts commitProgress: pairs first, its
        // regression run, the guard): a step that ends with a partial in hand commits it as a
        // partial fix rather than parking with nothing (§19.7); the search does this itself at
        // every budget exit and at exhaustion, so this is the controller's own check.
        const partial = await this.progressCommit(ctx, mem, goal);
        if (partial !== null) r = { ...partial, trace: { ...r.trace, outcome: 'partial', winner: partial.applied, testRuns: r.trace.testRuns } };
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
        if (!r.allGoalTestsPass) {
          // A progress commit: the goal stays open with its remaining tests; the next baseline re-clusters
          // them by their new frame (goals.ts reconcile). The goal's `unchanged` verdicts were taken under
          // the failure this commit removes, so they leave `tried` (sieve/runner.ts unchangedTried).
          const k = evidence === null ? null : goalTestsPassing(goal, evidence);
          const forgotten = forgetUnchangedTried(mem, goal.id);
          this.emit(ctx, 'progress', `${goal.id}: partial fix committed (progress commit ${goal.progressCommits ?? 1} of ${MAX_PROGRESS_COMMITS_PER_GOAL}${k === null ? '' : `; ${k} of ${goal.tests.length} goal tests pass, the remaining ${goal.tests.length - k} stay open`}); the goal stays open and is re-clustered from the next baseline${forgotten > 0 ? `; ${forgotten} unchanged verdict${forgotten === 1 ? '' : 's'} taken under the old failure forgotten (re-enumerable)` : ''}`);
        } else mem.unchangedTried?.delete(goal.id);
        const repo = mem.repository;
        if (repo !== undefined && isBestGuessGoal(goal)) {
          // the one unverified commit of the run: the goal parks with the reason, the plan says what was not verified
          repo.bestGuessCommitted = true;
          park(goal, BEST_GUESS_PARK_REASON);
          return proposePatch(ctx, r.applied, goal, mem, undefined, r.trace, evidence, { goalText: bestGuessGoalText(r.applied, evidence ?? undefined), notes: [BEST_GUESS_NOTE] });
        }
        const notes = repo?.repro?.strength === 'weak' ? [`weak reproduction oracle ${repo.repro.spec.testId}: the criterion only says the observed wrong value changed; the regression scope (${repo.scope.testFiles.length} files) is the other check`] : [];
        // §5.1 row 1 with evidence: the shadow run the commit rests on goes with the patch, so the
        // engine's risk and judge stages read a verified change (loop/state.ts proposal.evidence).
        return proposePatch(ctx, r.applied, goal, mem, r.note, r.trace, evidence, { notes });
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
        // §5.3: a budget-hit step that classified fresh candidates at ≥ 1 site no earlier step had
        // tested (and whose top sites are not all exhausted) is progress: it counts toward the hard
        // cap (4 budget-hit steps) but not toward the stagnation park (2) nor toward "3 searches
        // without a commit" — the search is the same one, continued. A step that tested nothing
        // new counts toward all three; the goal parks on the first rule that fires, else it stays
        // open and resumes next step.
        const loc = mem.localizeCache.get(goal.id);
        const progress = r.trace.candidatesTested > 0 && r.trace.newSitesTested > 0 && !(loc !== undefined && everySiteSeedsExhausted(goal, loc.sites));
        const hit = noteBudgetHit(goal, progress);
        const reason = hit ?? (progress ? null : parkReasonFor(goal));
        if (reason === null) {
          goal.status = 'open';
          this.emit(ctx, 'budget', `${goal.id}: budget-hit step ${goal.budgetSteps ?? 0} of ${MAX_BUDGET_HIT_STEPS} (${progress ? `progress: ${r.trace.newSitesTested} new site${r.trace.newSitesTested === 1 ? '' : 's'} of ${r.trace.sitesTested} tested` : `nothing new: ${goal.budgetHits} of ${MAX_CONSECUTIVE_BUDGET_HITS} stagnant`}); the goal stays open`);
        } else {
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
   * The controller's progress commit (subgoal.ts commitProgress) for a search that returned
   * without one: untested pairs first (the goal then stays open and runs them next step, see
   * `case 'budget'`), the regression run through `deps.regressionRun` when given, the guard.
   */
  private async progressCommit(ctx: SynthesisContext, mem: RunMemory, goal: Goal): Promise<Extract<SubGoalResult, { kind: 'commit' }> | null> {
    const opts: ProgressOptions = { pairsUntested: freshPairsOfPartials(mem, goal).length > 0, note: (phase, detail) => this.emit(ctx, phase, detail) };
    if (this.deps.regressionRun !== undefined) opts.regressionRun = this.deps.regressionRun;
    const r = await commitProgress(ctx, mem, goal, opts);
    if (r.requests > 0) mem.stepBudget.jevRequestsLeft = Math.max(0, mem.stepBudget.jevRequestsLeft - r.requests);
    if (r.decision === null || r.decision.kind !== 'commit') return null;
    const trace = { ...newTrace(goal, mem.oracle), outcome: 'partial' as const, winner: r.decision.applied, jevRequests: r.requests, testRuns: r.runs };
    return { ...r.decision, trace };
  }

  /** The cheap evidence step: a goal-subset `run` on the workspace; the search resumes from memory next step. The step's trace goes into `rawText` (§5.6: totals per record). */
  private subsetRun(ctx: SynthesisContext, mem: RunMemory, goal: Goal, trace: GoalSearchTrace): Proposal {
    // repository mode: the goal's synthetic test names no file the runner could scope to; the scoped command is the cheap run
    const command = mem.baseline === null ? baselineCommand(ctx) : mem.repository !== undefined ? mem.baseline.command : subsetCommand(mem.oracle, goal, workspaceLane(ctx.workspaceInfo.root), { command: mem.baseline.command, workspaceRoot: ctx.workspaceInfo.root });
    return proposeRun(ctx, command, 'subset', goal, false, this.runTimeout(ctx, mem), trace, mem);
  }

  /** §4.1 runTimeoutMs once the oracle is fitted, the engine's command timeout before; a repository's scoped run may use the run's maximum. */
  private runTimeout(ctx: SynthesisContext, mem: RunMemory): number {
    const cap = mem.repository === undefined ? Math.min(ctx.limits.commandTimeoutMs, ctx.limits.maxCommandTimeoutMs) : Math.min(ctx.limits.maxCommandTimeoutMs, REPO_BASELINE_TIMEOUT_MS);
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
      if (goal !== undefined && (goal.status === 'fixed' || (goal.status === 'parked' && goal.parkedReason === BEST_GUESS_PARK_REASON))) {
        // a best-guess goal parks at its commit; it re-opens for the one re-proposal and parks again after it (bestGuessCommitted stays)
        goal.status = 'open';
        delete goal.parkedReason;
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
    const paths = (await ctx.workspace.listCandidates()).map((c) => c.path);
    const layout = detectLayout([...files.keys(), ...paths]);
    if (layout !== 'quixbugs' && (mem.repository !== undefined || isRepositoryWorkspace(ctx.workspaceInfo.testCommand, paths))) return this.rebaselineRepository(ctx, mem, scratch, files, paths);
    const command = baselineCommand(ctx);
    const timeoutMs = Math.min(ctx.limits.commandTimeoutMs, ctx.limits.maxCommandTimeoutMs);
    const { summary: baseline, output } = await this.deps.runTests(ctx, command, timeoutMs);
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
      // the chain rule (goals.ts MAX_PROGRESS_COMMITS_PER_GOAL): a goal at the cap hands its remaining tests to a new id here
      const chained = mem.goals.filter((g) => g.status !== 'fixed' && (g.progressCommits ?? 0) >= MAX_PROGRESS_COMMITS_PER_GOAL).map((g) => g.id);
      mem.goals = reconcile(mem.goals, clusterFailures(baseline, clusterOpts), ctx.plan);
      const successors = mem.goals.filter((g) => g.status !== 'fixed' && !chained.includes(g.id) && (g.progressCommits ?? 0) === 0 && g.attempts === 0);
      if (chained.length > 0) this.emit(ctx, 'progress', `${chained.join(', ')} took ${MAX_PROGRESS_COMMITS_PER_GOAL} progress commits; the remaining tests continue as ${successors.map((g) => g.id).join(', ') || 'no goal (all pass)'}`);
    }
    return null;
  }

  /**
   * Repository mode (a Django/sympy suite or a large package: the whole suite is hours, and the
   * task's failing tests are not in the workspace). The ledger's baseline is a scoped regression
   * run (≤ 6 test files that import or are named after the localised modules) merged with the
   * issue's reproduction as one failing test; goals come from the oracle (`initRepository`, once
   * per run: one Jev request + one script run), or one best guess when there is none. Failures of
   * the scoped run at the base commit are known failures, never goals. After a patch the scoped
   * run and the reproduction are measured again on the workspace: the goal is fixed iff the
   * reproduction passes; a regression is a newly failing scoped test.
   */
  private async rebaselineRepository(ctx: SynthesisContext, mem: RunMemory, scratch: RunScratch, files: Map<string, SourceFile>, paths: string[]): Promise<Proposal | null> {
    const persisted: (PersistedSearchState & Partial<PersistedRepositoryState>) | null = isPersistedSearchState(ctx.synthState) ? ctx.synthState : null;
    if (!scratch.restored) {
      // §2.1 durability: tried hashes, commit hashes, claims and the goal placeholders come from the checkpoint
      rebuildFromPlan(mem, ctx.plan, persisted);
      scratch.restored = true;
    }
    const first = mem.repository === undefined;
    let repo = mem.repository;
    if (repo === undefined) {
      const restored = repositoryFromPersisted(persisted);
      if (restored !== null) {
        repo = restored;
        mem.repository = repo;
        if (!mem.goals.some((g) => g.id === repo?.goalId)) mem.goals.push(this.repositoryGoal(ctx, mem, repo.repro === null ? null : repo.repro.spec.testId, repo.moduleFiles));
        this.emit(ctx, 'oracle', `restored from the checkpoint: ${repo.oracleOutcome} (${repo.oracleNote}); regression scope ${repo.scope.testFiles.length} file${repo.scope.testFiles.length === 1 ? '' : 's'}`);
        // the harvested facts are not in the checkpoint: one interpreter run and a few git commands rebuild them (once per process)
        await this.harvestIntrospection(ctx, repo, framesOfTraceback(repo.traceback));
        await this.harvestHistoryFacts(ctx, repo, repo.moduleFiles, files);
      } else {
        repo = await this.initRepository(ctx, mem, scratch, files, paths);
      }
    }
    const timeoutMs = Math.min(ctx.limits.maxCommandTimeoutMs, REPO_BASELINE_TIMEOUT_MS);
    let scoped: TestRunSummary;
    if (repo.scope.command === null) {
      scoped = emptyScopedSummary(baselineCommand(ctx));
    } else {
      scoped = (await this.deps.runTests(ctx, repo.scope.command, timeoutMs)).summary;
      if (scoped.timedOut && repo.scope.testFiles.length > REPO_SCOPE_RETRY_FILES) {
        // §4.1 park is the last resort: first the scope shrinks to its best files and runs once more
        const smaller = await this.deps.regressionScope(ctx, repo.moduleFiles, paths, REPO_SCOPE_RETRY_FILES);
        if (smaller.command !== null) {
          this.emit(ctx, 'scope', `the scoped baseline timed out after ${timeoutMs} ms on ${repo.scope.testFiles.length} files; retrying on ${smaller.testFiles.join(', ')}`);
          repo.scope = smaller;
          scoped = (await this.deps.runTests(ctx, smaller.command, timeoutMs)).summary;
        }
      }
    }
    // the reproduction on the committed workspace: the oracle search's own run the first time, a re-run after every change
    let repro: VerifyReproResult | null = null;
    if (repo.repro !== null) {
      repro = scratch.freshRepro ?? (await this.deps.verifyRepro(ctx, repo.repro.spec));
      scratch.freshRepro = null;
    }
    const baseline = mergeSummaries(scoped, repro?.summary ?? null);
    scratch.previousBaseline = mem.baseline;
    mem.baseline = baseline;
    scratch.baselineStep = ctx.step;
    const wall = this.wallRemaining(ctx, scratch);
    // the oracle model: the scoped run is the full-suite scope, the reproduction the goal-subset one (§4.1 t_run per scope)
    const fitted = fitOracle(scoped, { commandTimeoutMs: ctx.limits.maxCommandTimeoutMs, wallRemainingMs: wall, workspace: { git: ctx.workspaceInfo.git } });
    const goalSubset = repro === null ? fitted.tRunMs.fullSuite : Math.max(1, Math.floor(repro.result.durationMs));
    mem.oracle = { ...fitted, perTestTimeoutMs: null, tRunMs: { goalSubset, fullSuite: fitted.tRunMs.fullSuite }, lanes: laneCount(goalSubset, { git: ctx.workspaceInfo.git }) };
    mem.stepBudget = freshBudget(ctx.limits, mem.oracle, wall, { now: this.deps.now });
    mem.bases = [committedBase(files, baseline)];
    // the establishing localisation was made on these very files; after a change the sites may have moved
    if (!first) mem.localizeCache.clear();
    mem.subsetBaselines = new Map();
    mem.deferred = new Map();
    scratch.rejected.clear();
    repo.knownFailures = scoped.failed + scoped.errors;
    repo.lastRepro = repro;
    const goal = mem.goals.find((g) => g.id === repo?.goalId);
    if (goal !== undefined && repro !== null) {
      goal.failures = [repro.failure];
      if (repro.verdict.pass) {
        if (goal.status !== 'fixed') noteCommit(goal, true);
      } else if (goal.status === 'fixed') goal.status = 'open';
    }
    attachPlanItems(mem.goals, ctx.plan.remaining);
    const reproText = repro === null ? 'no reproduction oracle' : `reproduction ${repo.repro?.spec.testId ?? ''} ${repro.verdict.pass ? 'PASSES' : 'fails'} (${repro.verdict.actual.slice(0, 80)}) in ${repro.result.durationMs} ms`;
    this.emit(ctx, 'baseline', `${scoped.passed}/${scoped.total} scoped tests pass, ${scoped.failed} failed, ${scoped.errors} errors in ${scoped.durationMs} ms; ${reproText} (repository, ${mem.oracle.runner}, ${repo.scope.command ?? 'no scoped command'})`);
    if (scoped.timedOut) {
      for (const g of mem.goals) if (g.status !== 'fixed') park(g, SUITE_TOO_SLOW);
      this.emit(ctx, 'verify', `${SUITE_TOO_SLOW}: the scoped baseline timed out after ${timeoutMs} ms; ${mem.goals.length} goal${mem.goals.length === 1 ? '' : 's'} parked`);
      return proposeRun(ctx, baseline.command, 'full', undefined, false, timeoutMs, undefined, mem);
    }
    return null;
  }

  /** The one goal of repository mode: the reproduction (its synthetic test id) or the best guess; a checkpoint placeholder with the same test keeps its id and state. */
  private repositoryGoal(ctx: SynthesisContext, mem: RunMemory, reproTestId: string | null, suspectedFiles: readonly string[]): Goal {
    const testId = reproTestId ?? bestGuessTestId(ctx.task);
    const prior = mem.goals.find((g) => g.tests.includes(testId));
    const next = Math.max(0, ...mem.goals.map((g) => Number(/^g(\d+)$/.exec(g.id)?.[1] ?? 0))) + 1;
    const goal = newGoal(prior?.id ?? `g${next}`, [testId], reproTestId === null ? [bestGuessFailure(ctx.task)] : [], [...suspectedFiles]);
    if (prior !== undefined) {
      goal.status = prior.status === 'active' ? 'open' : prior.status;
      goal.attempts = prior.attempts;
      goal.budgetHits = prior.budgetHits;
      goal.phase = prior.phase;
      if (prior.parkedReason !== undefined) goal.parkedReason = prior.parkedReason;
      if (prior.planItem !== '' && suspectedFiles.length === 0) goal.planItem = prior.planItem;
      mem.goals = mem.goals.filter((g) => g !== prior);
    }
    return goal;
  }

  /**
   * The establishing step of repository mode, once per run: the oracle from the issue (one Jev
   * request, one script run in the workspace), the goal it yields (or the best guess), one
   * localisation of that goal from the task text (its file beam names the module files; the
   * result is cached for the search), and the regression scope over those modules.
   */
  private async initRepository(ctx: SynthesisContext, mem: RunMemory, scratch: RunScratch, files: Map<string, SourceFile>, paths: string[]): Promise<RepositoryMode> {
    const packageName = packageNameOf(paths);
    const framework = frameworkOf(packageName);
    const found = await this.deps.findOracle(ctx, { packageName, framework });
    mem.stepBudget.jevRequestsLeft = Math.max(0, mem.stepBudget.jevRequestsLeft - found.requests);
    this.emit(ctx, 'oracle', `${found.outcome}: ${found.note} (${found.requests} request${found.requests === 1 ? '' : 's'}, ${found.durationMs} ms, package ${packageName ?? '?'})`);
    const goal = this.repositoryGoal(ctx, mem, found.goal?.spec.testId ?? null, []);
    if (found.goal !== null) goal.failures = [found.goal.failure];
    mem.goals = [...mem.goals.filter((g) => g.id !== goal.id), goal];
    const repo: RepositoryMode = {
      goalId: goal.id,
      moduleFiles: [],
      scope: { testFiles: [], command: null, tier: 'none', note: 'not chosen yet' },
      repro: found.goal === null || found.strength === null ? null : { spec: found.goal.spec, strength: found.strength },
      oracleOutcome: found.outcome,
      oracleNote: found.note,
      traceback: found.traceback,
      bestGuessCommitted: false,
      knownFailures: 0,
      lastRepro: null,
    };
    mem.repository = repo;
    scratch.freshRepro = found.goal === null ? null : { result: found.goal.result, verdict: found.goal.verdict, summary: found.goal.summary, failure: found.goal.failure };
    // the introspected names of the failing call come before the localisation: its site list adds the
    // class-body gap of a receiver's class (search/sites.ts introspectionSites) when the facts are known
    await this.harvestIntrospection(ctx, repo, found.anchors.map((a) => a.frame));
    // one localisation from the task text (and the oracle's anchors): the module files bound the scope, the sites serve the search
    mem.bases = [committedBase(files, emptyScopedSummary(baselineCommand(ctx)))];
    let loc: LocalizeResult | null = null;
    try {
      loc = await this.deps.locate(ctx, mem, goal);
    } catch (e) {
      if (e instanceof AbortError) throw e;
      this.emit(ctx, 'localize', `localisation failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (loc !== null) {
      mem.stepBudget.jevRequestsLeft = Math.max(0, mem.stepBudget.jevRequestsLeft - loc.requests);
      mem.localizeCache.set(goal.id, loc);
    }
    const moduleFiles = moduleFilesOf(loc, repo.traceback, files);
    goal.suspectedFiles = moduleFiles;
    goal.planItem = planItemFor(goal);
    attachPlanItems([goal], ctx.plan.remaining);
    repo.moduleFiles = moduleFiles;
    repo.scope = await this.deps.regressionScope(ctx, moduleFiles, paths);
    this.emit(ctx, 'localize', `${goal.id}: ${moduleFiles.length > 0 ? moduleFiles.join(', ') : 'no module file localised'} (${loc?.requests ?? 0} requests, ${loc?.sites.length ?? 0} sites)`);
    this.emit(ctx, 'scope', `${repo.scope.testFiles.length} test file${repo.scope.testFiles.length === 1 ? '' : 's'} (${repo.scope.tier}): ${repo.scope.testFiles.join(', ') || '-'}; ${repo.scope.note}; command: ${repo.scope.command ?? 'none'}`);
    // the git history of the module files the localisation named (the history source reads it)
    await this.harvestHistoryFacts(ctx, repo, moduleFiles, files);
    return repo;
  }

  /**
   * The introspected names of a run (src/synth/introspect; swebench-reach-oracle-9.md capability 2),
   * once per process at the establishing step and again on a resume: one introspection run of the
   * reproduction in the committed workspace with its venv (≤ 60 s; the operands of the failing
   * expression, their MRO class names, `is_*` predicates and attributes, the raising module's
   * names). Registered per run id (introspect/facts.ts); src/synth/index.ts hands them to the
   * template source as `EnumerateOptions.introspected` / `.extraNames`, to the queue's vocabulary
   * and to the site list (search/sites.ts introspectionSites). Never fatal: a failed pass leaves
   * the sources as they were.
   */
  private async harvestIntrospection(ctx: SynthesisContext, repo: RepositoryMode, anchors: readonly TracebackFrame[]): Promise<void> {
    let introspected: IntrospectedNames | null = null;
    if (repo.repro !== null) {
      try {
        introspected = await this.deps.introspect(ctx, repo.repro.spec, anchors);
        if (introspected !== null) {
          const ops = introspected.operands.slice(0, 4).map((o) => `${o.expr}: ${o.typeName} (${o.predicates.length} predicate${o.predicates.length === 1 ? '' : 's'}${o.raisingReceiver ? ', receiver' : ''})`).join(', ');
          this.emit(ctx, 'introspect', `${introspected.status} in ${introspected.durationMs} ms: ${introspected.note}${ops === '' ? '' : `; ${ops}`}`);
        }
      } catch (e) {
        if (e instanceof AbortError) throw e;
        this.emit(ctx, 'introspect', `introspection failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setRunFacts(ctx.runId, { introspected });
  }

  /**
   * The git history of the localised module files (src/synth/history; capability 3): ≤ 8 read-only
   * git commands (the ticket / commit the issue names, `-S<identifier>` for the issue's
   * identifiers). Registered with the run facts; src/synth/index.ts hands it to the history source
   * as `EnumerateOptions.history` (its reversals ride with the donor seed). Never fatal.
   */
  private async harvestHistoryFacts(ctx: SynthesisContext, _repo: RepositoryMode, moduleFiles: readonly string[], files: ReadonlyMap<string, SourceFile>): Promise<void> {
    let history: HistoryFacts | null = null;
    if (moduleFiles.length > 0) {
      try {
        const sources = moduleFiles.map((p) => files.get(p)).filter((f): f is SourceFile => f !== undefined);
        history = await this.deps.harvestHistory(ctx, moduleFiles, sources);
        if (history !== null) this.emit(ctx, 'history', `${history.note} (${history.durationMs} ms)`);
      } catch (e) {
        if (e instanceof AbortError) throw e;
        this.emit(ctx, 'history', `history harvest failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setRunFacts(ctx.runId, { history });
  }
}

/** The frames of a `RepositoryMode.traceback` text (oracle/search.ts tracebackTextFor renders them as CPython does), for the introspection anchors on a resume. */
export function framesOfTraceback(text: string | null): TracebackFrame[] {
  const out: TracebackFrame[] = [];
  if (text === null) return out;
  for (const m of text.matchAll(/File "([^"]+)", line (\d+), in (\S+)/g)) out.push({ file: m[1] ?? '', line: Number(m[2]), fn: m[3] ?? null, code: null });
  return out;
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
