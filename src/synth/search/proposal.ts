/**
 * Proposal builders of the Ledger + Sieve synthesizer (docs/JEV-ONLY-DESIGN.md §5.1, §5.2, §5.5).
 *
 * Everything the synthesizer hands back to the engine goes through here so the shape is the
 * same every step: the action is one of `patch`, `run`, `done` or `read` (never `edit` or
 * `write`: a `patch` carries multi-line `extraEdits` atomically and the engine runs
 * `git apply --check`); the plan draft uses the fixed grammar `fix <first_test_id>[, +N more] in
 * <path>` so the engine's Jev stages can read it and `memory.ts parseGoalItem` can parse it back
 * on `--resume`; `openProblems` carries human-readable notes only (it is Jev-visible in the risk
 * stage's `plan_mismatch` level); `rawText` is the JSON of the step's `GoalSearchTrace` (or a
 * small JSON record for bookkeeping steps) so `steps.jsonl` keeps the search auditable.
 *
 * The `patch → run` alternation is deliberate: the `run` after every `patch` is how the engine's
 * own record (`lastTestRun`, `testsCurrent`, the `task_complete` Noul) sees the oracle, and its
 * parsed counts are the evidence the `done_<j>` Noul needs when the plan item is claimed.
 */
import { clip } from '../../core/text.js';
import type { Json, JsonObject, PlanDraft, Proposal, SynthesisContext, WindowEntry } from '../../core/types.js';
import { PLAN_ITEM_MAX_CHARS, PLAN_MAX_OPEN_PROBLEMS, normaliseItem } from '../../loop/plan.js';
import { patchTouchedPaths } from '../../provider/actions.js';
import { unifiedDiff } from '../py/index.js';
import type { AppliedCandidate, TestRunSummary } from '../types.js';
import type { Goal, GoalSearchTrace } from './types.js';

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

/**
 * A committed candidate's diff touches at most this many files (§5.1): the site edit plus
 * `extraEdits` in the same file, or the composite signature + call-site unit across two files
 * (ladder `table`, bench/data/ladder/README.md). More files means a source violated the contract.
 */
export const MAX_PATCH_FILES = 2;

/** The engine's `read` bound ("12 files, 16 KB each", provider/actions.ts tool schema). */
export const READ_MAX_PATHS = 12;

/** Test ids in goal texts are clipped so a long pytest node id cannot swallow the sentence. */
export const TEST_ID_MAX_CHARS = 80;

/**
 * Paths under a tests directory, test modules and pytest's conftest. A committed candidate
 * must never touch them (§5.5 condition 2; the ladder and QuixBugs evaluators check
 * `tests/` unchanged, §5.6).
 */
export const TEST_PATH_RE = /(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*\.py$|_tests?\.py$|(^|\/)conftest\.py$/;

/**
 * The fixed plan-item grammar of §5.2 (`fix <first_test_id>[, +N more] in <path>`); the path is
 * one token, or memory.ts's placeholder `the workspace` when a goal names no file.
 */
export const GOAL_ITEM_RE = /^fix .+ in (\S+|the workspace)$/;

/** How the engine's window labels a `run` / `patch` action (provider/actions.ts summariseAction). */
const RUN_ACTION_RE = /^run(\s|$)/;
const CHANGE_ACTION_RE = /^(patch|edit|write)(\s|$)/;

/**
 * The plan's standing last item. It keeps a claiming `run` from reading as a completion claim
 * (loop/state.ts derives `claimsDone` from an empty `planClaim.remaining`; the second QuixBugs
 * bench had every post-patch run that claimed its fix item blocked at 0.64–0.94 as "claims
 * completion with no verifying test run in `recent`"), it is the plan item the run carries out
 * (level 0 of `plan_mismatch`), and the final `done` claims it with the green run in `recent`,
 * which is the completion Noul's own true-example ("the plan's remaining item was that test run";
 * the first bench's `done` sat at 0.77–0.83 against the 0.85 threshold with the fix item still in
 * the accepted `plan.remaining`). Not in the goal grammar, so `memory.ts parseGoalItem` skips it on
 * resume.
 */
export const VERIFY_ITEM = 'verify the full test suite passes';

export type CommitNote = 'possible overfit' | 'partial';
export type RunScope = 'full' | 'subset';
export type DoneMode = 'green' | 'partial';

export class ProposalError extends Error {
  constructor(message: string) {
    super(`ProposalError: ${message}`);
    this.name = 'ProposalError';
  }
}

// ---------------------------------------------------------------------------------------
// What the builders read from the search memory (§2.1 SearchMemory, structural subset)
// ---------------------------------------------------------------------------------------

/**
 * The slice of `SearchMemory` (memory.ts) these builders read. Structural so the builders can
 * be tested with a plain object and so memory.ts may grow without touching this file.
 */
export interface ProposalMemory {
  /** full-suite run on the committed workspace, by the synthesizer's own sandbox lanes */
  baseline: TestRunSummary | null;
  /** the ledger, in ledger order */
  goals: readonly Goal[];
  /** committed candidates in commit order (lost on `--resume`; only the hashes survive) */
  committed: readonly AppliedCandidate[];
  /** sha12(diff) of every commit of the run, including those before a resume (memory.ts) */
  committedDiffHashes?: readonly string[];
  /**
   * set by the controller while a batch with ≥ 2 plausible candidates still awaits the §2.6
   * arbitration; `done` is never proposed over an unarbitrated batch (§5.5 condition 3).
   * Absent means the guard path ran wherever it applied.
   */
  guardPending?: boolean;
}

// ---------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------

/** `<first_test_id>[, +N more]`, the test label shared by goal texts and plan items. */
export function testsLabel(goal: Goal): string {
  const first = goal.tests[0];
  if (first === undefined) return goal.id;
  const rest = goal.tests.length - 1;
  return rest > 0 ? `${clip(first, TEST_ID_MAX_CHARS)}, +${rest} more` : clip(first, TEST_ID_MAX_CHARS);
}

/** `<op> at <path>:<line>`, how an edit is named in goal texts and notes. */
export function describeEdit(applied: AppliedCandidate): string {
  const c = applied.candidate;
  return `${c.op} at ${c.site.file.path}:${c.site.line}`;
}

/** `fix <tests> in <path>:<line> (<source>/<op>)` (§5.1 patch row). */
export function patchGoalText(applied: AppliedCandidate, goal: Goal): string {
  const c = applied.candidate;
  return `fix ${testsLabel(goal)} in ${c.site.file.path}:${c.site.line} (${c.source}/${c.op})`;
}

export function isGoalItem(text: string): boolean {
  return GOAL_ITEM_RE.test(text);
}

/** `fixed 2, open 1, parked 1`: the ledger line of the `synth` event (§5.2). */
export function ledgerLine(goals: readonly Goal[]): string {
  let fixed = 0;
  let open = 0;
  let parked = 0;
  for (const g of goals) {
    if (g.status === 'fixed') fixed += 1;
    else if (g.status === 'parked') parked += 1;
    else open += 1;
  }
  return `fixed ${fixed}, open ${open}, parked ${parked}`;
}

/** Paths a unified diff touches (`---`/`+++` headers, -p1 stripped). */
export function diffPaths(diff: string): string[] {
  return patchTouchedPaths(diff);
}

/** Files under the tests directory that any committed candidate touched (§5.5 condition 2). */
export function testFilesChanged(committed: readonly AppliedCandidate[]): string[] {
  const out: string[] = [];
  for (const a of committed) {
    for (const f of a.files) if (TEST_PATH_RE.test(f.path) && !out.includes(f.path)) out.push(f.path);
    for (const p of diffPaths(a.diff)) if (TEST_PATH_RE.test(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Plan draft pieces (§5.2 durability rule)
// ---------------------------------------------------------------------------------------

/**
 * One fixed-form item per goal that is not finished from the engine's point of view: every
 * open, active or parked goal, plus a `fixed` goal whose item the harness has not accepted as
 * done yet (it is claimed on the `run` step that shows its tests passing, never before). Items
 * in `claimed` are being claimed this step and leave `remaining`. Items already in the accepted
 * plan that are not in the goal grammar (foreign to the synthesizer) are kept so rule (b) of the
 * plan never has to retain them with a note.
 */
export function remainingItems(ctx: SynthesisContext, mem: ProposalMemory, claimed: ReadonlySet<string> = new Set()): string[] {
  const accepted = new Set(ctx.plan.done.map((d) => d.text));
  const out: string[] = [];
  const push = (item: string): void => {
    const text = normaliseItem(item);
    if (text.length > 0 && !out.includes(text) && !claimed.has(text)) out.push(text);
  };
  for (const g of mem.goals) {
    if (g.status === 'fixed' && accepted.has(normaliseItem(g.planItem))) continue;
    push(g.planItem);
  }
  for (const r of ctx.plan.remaining) if (!isGoalItem(r) && !accepted.has(r) && r !== VERIFY_ITEM) push(r);
  // the standing verification item closes every plan (see VERIFY_ITEM); the green `done` claims it
  if (!accepted.has(VERIFY_ITEM)) push(VERIFY_ITEM);
  return out;
}

/** Items of `fixed` goals the harness has not accepted as done (a claim that was unsure or rejected). */
export function unclaimedFixedItems(ctx: SynthesisContext, mem: ProposalMemory): string[] {
  const accepted = new Set(ctx.plan.done.map((d) => d.text));
  const out: string[] = [];
  for (const g of mem.goals) {
    const item = normaliseItem(g.planItem);
    if (g.status === 'fixed' && !accepted.has(item) && !out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Human-readable notes only (§5.2: machine state never goes here, the risk stage reads it):
 * parked goals with their reason, then the step's own notes. Deduplicated, clipped and capped
 * exactly as the plan rules will do, so what the synthesizer emits is what the plan keeps.
 */
export function openProblemNotes(mem: ProposalMemory, extra: readonly string[] = []): string[] {
  const out: string[] = [];
  const push = (note: string): void => {
    const text = clip(note.replace(/\s+/g, ' ').trim(), PLAN_ITEM_MAX_CHARS);
    if (text.length > 0 && !out.includes(text)) out.push(text);
  };
  for (const g of mem.goals) if (g.status === 'parked') push(`${g.planItem}: parked${g.parkedReason ? ` (${g.parkedReason})` : ''}`);
  for (const e of extra) push(e);
  return out.slice(0, PLAN_MAX_OPEN_PROBLEMS);
}

// ---------------------------------------------------------------------------------------
// rawText records (always JSON, always bounded)
// ---------------------------------------------------------------------------------------

/** A committed edit as a small JSON record: the site, the source and the touched paths, never file contents. */
export function editRecord(applied: AppliedCandidate): JsonObject {
  const c = applied.candidate;
  return {
    path: c.site.file.path,
    line: c.site.line,
    kind: c.site.kind,
    source: c.source,
    op: c.op,
    text: clip(c.text, PLAN_ITEM_MAX_CHARS),
    files: applied.files.map((f) => f.path),
  };
}

/**
 * The `GoalSearchTrace` as JSON for `rawText`. `winner` is compacted to `editRecord` (an
 * `AppliedCandidate` carries whole source files and their analysis, which would bloat
 * steps.jsonl and is already in the diff).
 */
export function traceRecord(trace: GoalSearchTrace): JsonObject {
  const bySource: JsonObject = {};
  for (const [name, v] of Object.entries(trace.bySource)) bySource[name] = { enumerated: v.enumerated, tested: v.tested, passed: v.passed };
  const rec: JsonObject = {
    kind: 'search',
    goalId: trace.goalId,
    phase: trace.phase,
    runMode: trace.runMode,
    outcome: trace.outcome,
    sitesConsidered: trace.sitesConsidered,
    candidatesEnumerated: trace.candidatesEnumerated,
    candidatesRanked: trace.candidatesRanked,
    candidatesTested: trace.candidatesTested,
    jevRequests: trace.jevRequests,
    testRuns: trace.testRuns,
    plausible: trace.plausible,
    clusters: trace.clusters,
    arbitrated: trace.arbitrated,
    tRunMs: trace.tRunMs,
    bySource,
  };
  if (trace.winner) rec['winner'] = editRecord(trace.winner);
  return rec;
}

function rawText(record: Json): string {
  return JSON.stringify(record);
}

/** Commits in this run: the durable hash list when memory carries it (it survives `--resume`), else the in-memory list. */
export function commitCount(mem: ProposalMemory): number {
  return Math.max(mem.committed.length, mem.committedDiffHashes?.length ?? 0);
}

// ---------------------------------------------------------------------------------------
// The engine's view of the oracle, read from the window (§5.5 condition 1)
// ---------------------------------------------------------------------------------------

export interface ExecutedTestRun {
  step: number;
  action: string;
  passed: number;
  failed: number;
  errors: number;
  allPassed: boolean;
}

/**
 * The last test run the ENGINE executed with parsed counts, provided no `patch`/`edit`/`write`
 * was executed after it (the workspace would have changed since). Null when the engine has not
 * seen the oracle on the current workspace: `done` is never proposed then, a full-suite `run` is.
 */
export function lastExecutedTestRun(window: readonly WindowEntry[]): ExecutedTestRun | null {
  for (let i = window.length - 1; i >= 0; i--) {
    const e = window[i]!;
    if (e.outcome !== 'executed') continue;
    if (CHANGE_ACTION_RE.test(e.action)) return null;
    if (!RUN_ACTION_RE.test(e.action)) continue;
    const tests = e.judge?.tests;
    if (!tests || tests.source !== 'parsed') continue;
    return { step: e.step, action: e.action, passed: tests.passed, failed: tests.failed, errors: tests.errors, allPassed: tests.allPassed };
  }
  return null;
}

/** The window's label for a `run` of `command` (provider/actions.ts shortCommand: one line, 80 chars). */
export function runActionLabel(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  return `run ${oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine}`;
}

/**
 * The test command the engine parses: the baseline's command first (it is the detector's
 * command normalised by search/index.ts `normaliseTestCommand`, `pytest -q` → `python3 -m pytest
 * -q`, because `pytest` is not guaranteed on PATH), the detector's when no baseline ran yet.
 * Both spell the same runner for the engine's `isTestCommand`, so the window label of an
 * executed `run` matches the command proposed here.
 */
export function engineTestCommand(ctx: SynthesisContext, mem: ProposalMemory): string | null {
  return mem.baseline?.command ?? ctx.workspaceInfo.testCommand?.command ?? null;
}

/** The two §5.5 blockers that also withhold a partial `done`. */
const NOT_RUN_BLOCKER = 'the engine has not run the test suite on the current workspace';
function testsChangedBlocker(paths: readonly string[]): string {
  return `a committed edit touched test file${paths.length > 1 ? 's' : ''} ${paths.join(', ')}; it must be reverted`;
}

export interface DoneReadiness {
  /** every §5.5 condition holds for a green `done` */
  green: boolean;
  /** the engine has executed a test run on the current workspace (any counts) */
  testsCurrent: boolean;
  executedRun: ExecutedTestRun | null;
  testsChanged: string[];
  guardPending: boolean;
  /** why `done` cannot be proposed yet, human-readable */
  blockers: string[];
}

/**
 * The §5.5 conditions, evaluated in code: (1) the last full-suite run on the committed
 * workspace has failed == errors == 0, passed > 0 and was executed by the engine (a `run` entry
 * in the window with parsed counts, no change executed after it); (2) no committed candidate
 * touched a test file; (3) the guard path ran where it applied. A `run` entry counts as the full
 * suite when its window label is the engine's test command, or when its passed count equals the
 * baseline's (a goal-subset run of the same runner has fewer tests).
 */
export function doneReadiness(ctx: SynthesisContext, mem: ProposalMemory): DoneReadiness {
  const executedRun = lastExecutedTestRun(ctx.window);
  const testsChanged = testFilesChanged(mem.committed);
  const guardPending = mem.guardPending === true;
  const blockers: string[] = [];
  const command = engineTestCommand(ctx, mem);
  let fullSuite = false;
  if (executedRun === null) blockers.push(NOT_RUN_BLOCKER);
  else {
    const labelled = command !== null && executedRun.action === runActionLabel(command);
    const sameCount = mem.baseline !== null && executedRun.passed === mem.baseline.passed;
    fullSuite = labelled || sameCount;
    if (!fullSuite) blockers.push(`the last executed run (${executedRun.action}) is not the full suite`);
    else if (!(executedRun.allPassed && executedRun.failed === 0 && executedRun.errors === 0 && executedRun.passed > 0)) {
      blockers.push(`the last executed run shows ${executedRun.passed} passed, ${executedRun.failed} failed, ${executedRun.errors} errors`);
    }
  }
  if (testsChanged.length > 0) blockers.push(testsChangedBlocker(testsChanged));
  if (guardPending) blockers.push('a batch with several test-passing candidates has not been arbitrated yet');
  return { green: blockers.length === 0, testsCurrent: executedRun !== null, executedRun, testsChanged, guardPending, blockers };
}

// ---------------------------------------------------------------------------------------
// The builders
// ---------------------------------------------------------------------------------------

function draft(done: string[], remaining: string[], openProblems: string[]): PlanDraft {
  return { done, remaining, openProblems };
}

/**
 * A candidate committed for `goal` (§5.1 row 1): `patch` with the candidate's diff, nothing
 * claimed yet (the next step's `run` claims the item on parsed test output), one item per
 * unfinished goal, notes for parked goals and for the commit's own caveat.
 */
export function proposePatch(ctx: SynthesisContext, applied: AppliedCandidate, goal: Goal, mem: ProposalMemory, note?: CommitNote, trace?: GoalSearchTrace): Proposal {
  if (applied.diff.trim().length === 0) throw new ProposalError(`empty diff for ${describeEdit(applied)}`);
  const paths = diffPaths(applied.diff);
  if (paths.length > MAX_PATCH_FILES) throw new ProposalError(`diff touches ${paths.length} files (${paths.join(', ')}); a candidate may touch at most ${MAX_PATCH_FILES}`);
  const notes: string[] = [];
  if (note === 'possible overfit') notes.push(`possible overfit: ${describeEdit(applied)} passes every test, but Jev rated no test-passing candidate a general fix; review the change`);
  if (note === 'partial') notes.push(`partial: ${describeEdit(applied)} fixes some of ${testsLabel(goal)} without regressions; the rest stay open`);
  const record: JsonObject = trace ? traceRecord(trace) : { kind: 'patch', goalId: goal.id, ledger: ledgerLine(mem.goals), edit: editRecord(applied) };
  if (note !== undefined) record['note'] = note;
  return {
    goal: patchGoalText(applied, goal),
    action: { kind: 'patch', diff: applied.diff },
    plan: draft([], remainingItems(ctx, mem), openProblemNotes(mem, notes)),
    rawText: rawText(record),
  };
}

/**
 * A test run (§5.1 rows 2 and 3). `full` after a `patch` claims the goal's plan item NOW
 * (`claimDone`), so the engine's `done_<j>` Noul judges it on this step's parsed output;
 * `subset` records the failing behaviour when a step budget was hit and the search resumes
 * from memory. The plan is otherwise unchanged: the accepted `remaining` and `openProblems`.
 *
 * Only a `fixed` goal is ever claimed (§2.1: `plan.done` is one item per fixed goal). A
 * `partial` commit leaves its goal `open`, and claiming it would be a false claim the engine
 * rejects with a `rejected_claim` note; so `claimDone` on an unfixed goal claims nothing.
 * `trace` (the search that led to this run, e.g. the budget-hit step) goes into `rawText`.
 */
export function proposeRun(ctx: SynthesisContext, command: string, kind: RunScope, goal?: Goal, claimDone = false, timeoutMs?: number, trace?: GoalSearchTrace, mem?: ProposalMemory): Proposal {
  if (command.trim().length === 0) throw new ProposalError('empty test command');
  if (claimDone && goal === undefined && mem === undefined) throw new ProposalError('claimDone needs the goal whose item is claimed, or the ledger');
  const label = goal ? testsLabel(goal) : null;
  const goalText = kind === 'full' ? (label ? `verify the suite after fixing ${label}` : 'run the full test suite') : label ? `record the failing behaviour of ${label}` : 'record the failing behaviour of the test suite';
  // `claimDone` claims every fixed goal whose item the engine has not accepted yet (with `mem`), or
  // the given goal's (without): the run's parsed output is the evidence the `done_<j>` Noul needs,
  // and a claim made on a `done` proposal is never judged (no executed output), so the accepted
  // `plan.remaining` would keep the item and the completion Noul would read "planClaim says
  // nothing remains, but plan.remaining still lists …" (0.77–0.83 against the 0.85 threshold in
  // the first QuixBugs bench: 8 of 14 repaired programs ran to max_steps).
  const accepted = new Set(ctx.plan.done.map((d) => d.text));
  const done = !claimDone ? [] : mem !== undefined ? mem.goals.filter((g) => g.status === 'fixed' && !accepted.has(normaliseItem(g.planItem))).map((g) => normaliseItem(g.planItem)) : goal && goal.status === 'fixed' ? [normaliseItem(goal.planItem)] : [];
  // With the ledger at hand, `remaining` is one item per open or parked goal (§2.1), as a `patch`
  // proposes it; copying the engine's plan alone leaves it empty on the first step, and the risk
  // state then reads `claimsDone: proposal.plan.remaining.length === 0` (loop/state.ts) on a `run`
  // that is only recording the failing tests — the first live run had that `run` sent to review.
  const remaining = mem === undefined ? ctx.plan.remaining.filter((r) => !done.includes(r)) : remainingItems(ctx, mem, new Set(done));
  const action: Proposal['action'] = timeoutMs === undefined ? { kind: 'run', command } : { kind: 'run', command, timeoutMs };
  const record: JsonObject = { kind: 'run', scope: kind, command, claimed: done };
  if (goal) record['goalId'] = goal.id;
  if (claimDone && goal && goal.status !== 'fixed' && mem === undefined) record['unclaimed'] = `${goal.id} is ${goal.status}, not fixed`;
  if (trace) record['trace'] = traceRecord(trace);
  return { goal: goalText, action, plan: draft(done, remaining, [...ctx.plan.openProblems]), rawText: rawText(record) };
}

/**
 * `done` (§5.5). `green`: only when every condition of `doneReadiness` holds; otherwise the
 * full-suite `run` that makes the engine see the oracle (the normal path right after the
 * synthesizer's own baseline turned green). `partial`: every goal parked, an honest summary
 * with the parked items still in `remaining` and their reasons in `openProblems`; it too waits
 * for an executed run so the completion stage judges current tests, and it too is withheld
 * while a committed edit touches a test file (§5.5 condition 2 applies to every `done`: the
 * evaluators check `tests/` unchanged, §5.6). Fixed goals whose claims were not accepted are
 * claimed again on the `done` step. `trace` (the step's search, if any) goes into `rawText`.
 */
export function proposeDone(ctx: SynthesisContext, mem: ProposalMemory, mode: DoneMode, trace?: GoalSearchTrace): Proposal {
  const ready = doneReadiness(ctx, mem);
  const command = engineTestCommand(ctx, mem);
  // A partial `done` waits only for an executed run and for test files to be untouched; the
  // full-suite and guard conditions concern a green claim.
  const partialBlockers = [...(ready.testsCurrent ? [] : [NOT_RUN_BLOCKER]), ...(ready.testsChanged.length > 0 ? [testsChangedBlocker(ready.testsChanged)] : [])];
  const blockers = mode === 'green' ? ready.blockers : partialBlockers;
  if (blockers.length > 0) {
    if (command === null) throw new ProposalError(`cannot verify the workspace: no test command is known (${blockers.join('; ')})`);
    // The run claims the fixed goals (§5.1 row 2): its parsed output is the evidence their claims need.
    const run = proposeRun(ctx, command, 'full', undefined, true, undefined, trace, mem);
    // The blockers are human-readable and belong in openProblems so the risk stage sees why the run repeats.
    return { ...run, plan: draft(run.plan.done, run.plan.remaining, openProblemNotes(mem, blockers)) };
  }
  const claims = unclaimedFixedItems(ctx, mem);
  // the green run the readiness check found is the evidence for the standing verification item
  if (mode === 'green' && !ctx.plan.done.some((d) => d.text === VERIFY_ITEM)) claims.push(VERIFY_ITEM);
  const total = mem.goals.reduce((n, g) => n + g.tests.length, 0);
  const fixed = mem.goals.filter((g) => g.status === 'fixed').reduce((n, g) => n + g.tests.length, 0);
  const commits = commitCount(mem);
  if (mode === 'green') {
    const n = ready.executedRun?.passed ?? mem.baseline?.passed ?? 0;
    const summary = `all ${n} tests pass; ${commits} ${commits === 1 ? 'fix' : 'fixes'} committed`;
    const record: JsonObject = { kind: 'done', mode, ledger: ledgerLine(mem.goals), passed: n, committed: commits, claimed: claims };
    if (trace) record['trace'] = traceRecord(trace);
    return { goal: summary, action: { kind: 'done', summary }, plan: draft(claims, [], []), rawText: rawText(record) };
  }
  const reasons = mem.goals.filter((g) => g.status === 'parked').map((g) => `${testsLabel(g)}: ${g.parkedReason ?? 'parked'}`);
  const summary = `partial: fixed ${fixed} of ${total} failing tests${reasons.length > 0 ? `; ${reasons.join('; ')}` : ''}`;
  const record: JsonObject = { kind: 'done', mode, ledger: ledgerLine(mem.goals), fixedTests: fixed, totalTests: total, committed: commits, claimed: claims };
  if (trace) record['trace'] = traceRecord(trace);
  return {
    goal: clip(summary, PLAN_ITEM_MAX_CHARS),
    action: { kind: 'done', summary: clip(summary, 600) },
    plan: draft(claims, remainingItems(ctx, mem, new Set(claims)), openProblemNotes(mem)),
    rawText: rawText(record),
  };
}

/** `read` of bounded workspace paths (§5.1 gather_context row); the plan is unchanged. */
export function proposeRead(ctx: SynthesisContext, paths: readonly string[], mem?: ProposalMemory): Proposal {
  const unique: string[] = [];
  for (const p of paths) if (p.trim().length > 0 && !unique.includes(p)) unique.push(p);
  if (unique.length === 0) throw new ProposalError('read needs at least one path');
  const bounded = unique.slice(0, READ_MAX_PATHS);
  return {
    goal: clip(`read ${bounded.join(', ')}`, PLAN_ITEM_MAX_CHARS),
    action: { kind: 'read', paths: bounded },
    plan: draft([], mem === undefined ? [...ctx.plan.remaining] : remainingItems(ctx, mem), [...ctx.plan.openProblems]),
    rawText: rawText({ kind: 'read', paths: bounded }),
  };
}

/** The unified diff that undoes `applied` (each touched file back from `after` to `before`). */
export function reverseDiff(applied: AppliedCandidate): string {
  let diff = '';
  for (const f of applied.files) {
    const d = unifiedDiff(f.path, f.after, f.before);
    if (d !== '') diff += d.endsWith('\n') ? d : `${d}\n`;
  }
  return diff;
}

/**
 * Reverse `patch` of a committed candidate (§5.1 revert_changes row). `goal` is the goal the
 * commit had fixed, already returned to `open` by the caller, so its item is in `remaining`.
 * Nothing is claimed; the reason is a note.
 */
export function proposeRevert(ctx: SynthesisContext, applied: AppliedCandidate, mem: ProposalMemory, opts: { goal: Goal | null; reason: string }): Proposal {
  const diff = reverseDiff(applied);
  if (diff.trim().length === 0) throw new ProposalError(`nothing to revert for ${describeEdit(applied)}`);
  const notes = [`reverted ${describeEdit(applied)}: ${opts.reason}${opts.goal ? `; '${opts.goal.planItem}' is open again` : ''}`];
  const record: JsonObject = { kind: 'revert', reason: opts.reason, edit: editRecord(applied), goalId: opts.goal?.id ?? null };
  return {
    goal: `revert ${describeEdit(applied)}`,
    action: { kind: 'patch', diff },
    plan: draft([], remainingItems(ctx, mem), openProblemNotes(mem, notes)),
    rawText: rawText(record),
  };
}
