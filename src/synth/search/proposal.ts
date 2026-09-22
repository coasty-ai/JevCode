/**
 * Proposal builders of the Ledger + Sieve synthesizer (docs/JEV-ONLY-DESIGN.md §5.1, §5.2, §5.5).
 *
 * Everything the synthesizer hands back to the engine goes through here so the shape is the
 * same every step: the action is one of `patch`, `run` or `done` — never `read` (the synthesizer
 * holds every source file itself, search/index.ts loadPythonFiles, and a `read` it proposed was
 * declined at review-band risk 7–12 times per miss in bench runs with no reviewer, tripping the
 * loop detector into `max_replans`: jev-only-rungs-1-2.md §19.7), never `edit` or `write` (a
 * `patch` carries multi-line `extraEdits` atomically and the engine runs `git apply --check`);
 * the plan draft uses the fixed grammar `fix <first_test_id>[, +N more] in
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
import { ORACLE_OUTCOMES } from '../../core/types.js';
import type { CompletionEvidence, Json, JsonObject, OracleOutcome, PlanDraft, Proposal, ProposalEvidence, SynthesisContext, WindowEntry } from '../../core/types.js';
import { PLAN_ITEM_MAX_CHARS, PLAN_MAX_OPEN_PROBLEMS, normaliseItem } from '../../loop/plan.js';
import { patchTouchedPaths } from '../../provider/actions.js';
import { isReproTestId } from '../oracle/search.js';
import { unifiedDiff } from '../py/index.js';
import type { AppliedCandidate, TestRunSummary } from '../types.js';
import { progress } from '../verify/progress.js';
import type { ClaimRecord, EngineRun } from './memory.js';
import type { Base, Goal, GoalSearchTrace, VerifyOutcome } from './types.js';

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

/**
 * A committed candidate's diff touches at most this many files (§5.1): the site edit plus
 * `extraEdits` in the same file, or the composite signature + call-site unit across two files
 * (ladder `table`, bench/data/ladder/README.md). More files means a source violated the contract.
 */
export const MAX_PATCH_FILES = 2;
/**
 * docs/LLM-JEV-DESIGN.md §6.2: an `llm` winner is a verified multi-file repair (≤ 4 files, `FIX_LIMITS.files`); the
 * risk stage's `verifiedPatchOk` accepts the same bound. Code sources keep MAX_PATCH_FILES.
 */
export const VERIFIED_PATCH_MAX_FILES = 4;

/** The file bound of a committed candidate's patch by its source (§6.2). */
export function patchMaxFiles(applied: Pick<AppliedCandidate, 'candidate'>): number {
  return applied.candidate.source === 'llm' ? VERIFIED_PATCH_MAX_FILES : MAX_PATCH_FILES;
}

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

/** Test ids per list in `Proposal.evidence` (the contract's bound, src/core/types.ts ProposalEvidence). */
export const EVIDENCE_TESTS_MAX = 20;

export type CommitNote = 'possible overfit' | 'partial';

/** The note every best-guess patch carries in `openProblems` (no oracle verified it; the regression scope alone was checked). */
export const BEST_GUESS_NOTE = 'no reproduction oracle: best-guess fix, unverified';

/** Extra pieces of a `patch` proposal beyond the search's own note: a caller-supplied goal text and human-readable notes. */
export interface PatchOptions {
  /** replaces `patchGoalText` (the best-guess path states what it did not verify) */
  goalText?: string;
  /** appended to `openProblems` after the parked reasons and the commit note */
  notes?: readonly string[];
  /** files the diff may touch (default `patchMaxFiles(applied)`: 2 for code sources, 4 for an `llm` winner) */
  maxFiles?: number;
}
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
  /**
   * The engine's last executed test run with parsed counts and the step of its last executed
   * workspace change, as the controller observed them across every window so far (memory.ts).
   * They outlive the 4-entry window: `doneReadiness` falls back to them when the window has
   * scrolled past the green run, and the claim rule reads the last passing suite run from them.
   */
  lastEngineRun?: EngineRun | null;
  lastChangeStep?: number | null;
  /** plan item → the run that claimed it and the judge's verdict (memory.ts); absent means nothing was claimed yet */
  claims?: ReadonlyMap<string, ClaimRecord>;
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

/** How many of the goal's tests the evidence shows newly passing (other goals' tests the same edit fixed do not count here). */
export function goalTestsPassing(goal: Pick<Goal, 'tests'>, evidence: Pick<ProposalEvidence, 'newlyPassing'>): number {
  const passing = new Set(evidence.newlyPassing);
  return goal.tests.filter((t) => passing.has(t)).length;
}

/** `partial fix: k of n goal tests pass, no regressions; the remaining m stay open` — the summary of a progress commit, shared by the goal text and the note. */
export function partialFixSummary(goal: Pick<Goal, 'tests'>, evidence: Pick<ProposalEvidence, 'newlyPassing' | 'newlyFailing'>): string {
  const k = goalTestsPassing(goal, evidence);
  const n = goal.tests.length;
  const r = evidence.newlyFailing.length;
  const regressions = r === 0 ? 'no regressions' : `${r} regression${r === 1 ? '' : 's'}`;
  return `partial fix: ${k} of ${n} goal test${n === 1 ? '' : 's'} pass, ${regressions}; the remaining ${n - k} stay open`;
}

/**
 * The goal text of a `patch` (§5.1 row 1). With the shadow-run evidence it states what was
 * measured, so the risk stage's `plan_mismatch` and `out_of_scope` Scores read a verified change
 * and not a claim: `apply verified fix: <tests> now pass (N→M of T), no regressions; <source>/<op>
 * at <path>:<line>`; for a progress commit `apply partial fix: k of n goal tests pass (<tests>)
 * (N→M of T), no regressions; the remaining m stay open; <source>/<op> at <path>:<line>`. Without
 * evidence (a revert, a re-proposal whose evidence is gone) it is the plain `fix <tests> in
 * <path>:<line> (<source>/<op>)`.
 */
export function patchGoalText(applied: AppliedCandidate, goal: Goal, evidence?: ProposalEvidence): string {
  const c = applied.candidate;
  const where = `${c.site.file.path}:${c.site.line}`;
  if (evidence === undefined) return `fix ${testsLabel(goal)} in ${where} (${c.source}/${c.op})`;
  const k = goalTestsPassing(goal, evidence);
  const allGoalTestsPass = goal.tests.length > 0 && k === goal.tests.length;
  const counts = `(${evidence.before.passed}→${evidence.after.passed} of ${evidence.after.total})`;
  const n = evidence.newlyFailing.length;
  const regressions = n === 0 ? 'no regressions' : `${n} regression${n === 1 ? '' : 's'}`;
  if (allGoalTestsPass) return `apply verified fix: ${testsLabel(goal)} now ${goal.tests.length === 1 ? 'passes' : 'pass'} ${counts}, ${regressions}; ${c.source}/${c.op} at ${where}`;
  return `apply partial fix: ${k} of ${goal.tests.length} goal test${goal.tests.length === 1 ? '' : 's'} pass (${testsLabel(goal)}) ${counts}, ${regressions}; the remaining ${goal.tests.length - k} stay open; ${c.source}/${c.op} at ${where}`;
}

/**
 * The goal text of a best-guess `patch` (no reproduction oracle, docs brief item 3): it states
 * the one thing that was measured — the scoped regression run kept passing — and that the fix
 * itself is unverified, so the risk stage reads an honest claim rather than a verified one.
 */
export function bestGuessGoalText(applied: AppliedCandidate, evidence?: ProposalEvidence): string {
  const c = applied.candidate;
  const where = `${c.site.file.path}:${c.site.line}`;
  if (evidence === undefined) return `apply best-guess fix (no reproduction oracle; unverified): ${c.source}/${c.op} at ${where}`;
  const n = evidence.newlyFailing.length;
  const regressions = n === 0 ? `the ${evidence.after.total} scoped tests still pass as before (${evidence.before.passed}→${evidence.after.passed} of ${evidence.after.total}), no regressions` : `${n} regression${n === 1 ? '' : 's'} in the scoped run`;
  return `apply best-guess fix (no reproduction oracle; unverified): ${c.source}/${c.op} at ${where}; ${regressions}`;
}

// ---------------------------------------------------------------------------------------
// Evidence (Proposal.evidence, src/core/types.ts): the shadow test run behind a proposal
// ---------------------------------------------------------------------------------------

/** How the candidate was chosen, read from the step's trace (RANK mode ran a Jev-ranked top-k; SIEVE ran every candidate). */
export interface EvidenceSelection {
  selection: ProposalEvidence['selection'];
  candidatesTested: number;
  arbitrated: boolean;
}

export function selectionOf(trace: Pick<GoalSearchTrace, 'runMode' | 'candidatesTested' | 'arbitrated'>, winner?: Pick<AppliedCandidate, 'candidate'>): EvidenceSelection {
  // docs/LLM-JEV-DESIGN.md §6.2: an LLM sample that won is `llm`, whatever mode ordered the queue
  const selection: ProposalEvidence['selection'] = winner?.candidate.source === 'llm' ? 'llm' : trace.runMode === 'RANK' ? 'rank' : 'sieve';
  return { selection, candidatesTested: trace.candidatesTested, arbitrated: trace.arbitrated };
}

/** The selection an existing evidence record carries (a re-proposal or the post-patch run reuse the commit's). */
export function selectionFrom(e: Pick<ProposalEvidence, 'selection' | 'candidatesTested' | 'arbitrated'>): EvidenceSelection {
  return { selection: e.selection, candidatesTested: e.candidatesTested, arbitrated: e.arbitrated };
}

function counts(s: TestRunSummary): ProposalEvidence['before'] {
  return { passed: s.passed, failed: s.failed, errors: s.errors, total: s.total };
}

/**
 * Code-computed evidence from two runs of the same command: `before` on the workspace as the
 * engine has it, `after` with the change applied. `newlyPassing` / `newlyFailing` come from
 * verify/progress.ts (the same arithmetic the sieve classifies with), bounded to the contract.
 */
export function shadowEvidence(before: TestRunSummary, after: TestRunSummary, goal: Pick<Goal, 'tests'>, sel: EvidenceSelection, command: string = before.command): ProposalEvidence {
  const p = progress(before, after);
  return {
    kind: 'shadow_test_run',
    command,
    before: counts(before),
    after: counts(after),
    newlyPassing: p.newlyPassing.slice(0, EVIDENCE_TESTS_MAX),
    newlyFailing: p.newlyFailing.slice(0, EVIDENCE_TESTS_MAX),
    goalTests: goal.tests.slice(0, EVIDENCE_TESTS_MAX),
    ...sel,
  };
}

/** What `commitEvidence` reads from the run memory: the committed baseline and the held partial bases. */
export interface EvidenceMemory {
  baseline: TestRunSummary | null;
  bases?: readonly Base[];
}

/**
 * Evidence for a committed candidate (§5.1 row 1): the guard's outcome carries the full-suite run
 * made in the shadow lane (`full`; `subset` when the goal subset was the whole suite), compared
 * with the committed baseline the engine's workspace is at; a partial commit from bases.ts has no
 * outcome but carries its held base's summary as `after` (the base left the beam when it was
 * committed; a still-held base is found in `mem.bases` as a fallback). Null when nothing measured
 * the change against the suite (no baseline, or a subset-only run whose baseline is not the suite).
 */
export function commitEvidence(
  mem: EvidenceMemory,
  r: { applied: AppliedCandidate; outcome?: VerifyOutcome; after?: TestRunSummary; trace: Pick<GoalSearchTrace, 'runMode' | 'candidatesTested' | 'arbitrated'> },
  goal: Pick<Goal, 'tests'>,
): ProposalEvidence | null {
  const before = mem.baseline;
  if (before === null) return null;
  const sel = selectionOf(r.trace, r.applied);
  if (r.after !== undefined) return shadowEvidence(before, r.after, goal, sel, before.command);
  if (r.outcome !== undefined) {
    const o = r.outcome;
    if (o.full !== undefined) return shadowEvidence(before, o.full, goal, sel, before.command);
    // no full-suite run: the subset run is evidence only when its baseline was the suite itself
    if (o.progress.before.total === before.total) return shadowEvidence(before, o.subset, goal, sel, o.subset.command);
    return null;
  }
  const held = mem.bases?.find((b) => b.origin === 'improved' && b.candidate === r.applied);
  return held === undefined ? null : shadowEvidence(before, held.summary, goal, sel, before.command);
}

/**
 * Evidence for the standing post-patch `run` (§5.1 row 2): the synthesizer's own full-suite run
 * on the patched workspace (`current`, the fresh baseline) against the run before the patch
 * (`previous`); the proposed command re-executes exactly that measurement in the engine.
 */
export function runEvidence(previous: TestRunSummary, current: TestRunSummary, goal: Pick<Goal, 'tests'> | undefined, sel: EvidenceSelection, command: string): ProposalEvidence {
  return shadowEvidence(previous, current, goal ?? { tests: [] }, sel, command);
}

/** The proposal with `evidence` attached (unchanged when there is none). */
export function withEvidence(p: Proposal, evidence: ProposalEvidence | null | undefined): Proposal {
  return evidence === null || evidence === undefined ? p : { ...p, evidence };
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
// Claims (§5.1 row 2): each fixed item is claimed once per verdict
// ---------------------------------------------------------------------------------------

export interface ClaimSplit {
  /** items a `run` may claim now */
  claims: string[];
  /** items whose earlier claim the judge did not accept and no passing suite run has re-measured since */
  deferred: { item: string; claim: ClaimRecord }[];
}

/**
 * The items of `fixed` goals the engine has not accepted as done, split into those a `run` may
 * claim now and those it must not claim yet. A claim is judged on the claiming run's parsed
 * output (`done_<j>`); repeating it on the next run presents no new evidence and the risk stage
 * reads the twice-claimed item as a plan mismatch (the second ladder run declined `grades`'s
 * post-patch run eight times in a row at 0.32–0.40 with one such item, after the task was solved
 * at step 7). So an item the judge did not accept is claimed again only with fresh evidence:
 * a NEW passing full-suite run executed by the engine (`mem.lastEngineRun`, later than the
 * claim), or a run the synthesizer's own fresh baseline already measured all-green (the run about
 * to be proposed will show every test passing, so every claim on it is verifiable — the judge's
 * unsure verdicts, 0.33–0.67 live, all came on runs with other tests still failing, where parsed
 * counts cannot attribute a specific item). Without either, the item stays in `remaining` with a
 * note (`deferredClaimNotes`). The all-green case matters because a `done` claims nothing the
 * judge grades (no executed output): had the final run deferred the items, nothing after it could
 * ever get them accepted — the first live run of this rule solved `grades` at step 8 and then had
 * its `done` blocked eleven times over the two unaccepted items still in `plan.remaining`. An item
 * never claimed, or whose pending claim was never judged (memory.ts resolveClaims drops those), is
 * claimable.
 */
export function splitClaims(ctx: SynthesisContext, mem: ProposalMemory): ClaimSplit {
  const accepted = new Set(ctx.plan.done.map((d) => d.text));
  const green = passingFullSuiteRun(ctx, mem);
  const expectedGreen = mem.baseline !== null && mem.baseline.passed > 0 && mem.baseline.failed === 0 && mem.baseline.errors === 0 && !mem.baseline.timedOut;
  const out: ClaimSplit = { claims: [], deferred: [] };
  const seen = new Set<string>();
  for (const g of mem.goals) {
    if (g.status !== 'fixed') continue;
    const item = normaliseItem(g.planItem);
    if (accepted.has(item) || seen.has(item)) continue;
    seen.add(item);
    const claim = mem.claims?.get(item);
    if (claim === undefined || claim.judged === null || expectedGreen || (green !== null && green.step > claim.step)) out.claims.push(item);
    else out.deferred.push({ item, claim });
  }
  return out;
}

/**
 * The `openProblems` note of a deferred claim: `'<item>' claimed at step N, judge said p=0.68;
 * this test run re-verifies it before it is claimed again`. It says what the current action does
 * about the problem: the first live run of this rule had the bare `…; re-verify` read by the risk
 * stage as an open problem the run ignores (`plan_mismatch` level 3 rose from ≈0.10 to ≈0.27 of
 * the mass on ladder `grades`).
 */
export function claimNote(item: string, claim: ClaimRecord): string {
  return `'${item}' claimed at step ${claim.step}, judge said p=${(claim.judged ?? 0).toFixed(2)}; this test run re-verifies it before it is claimed again`;
}

/** One `claimNote` per deferred item of `splitClaims`. */
export function deferredClaimNotes(ctx: SynthesisContext, mem: ProposalMemory): string[] {
  return splitClaims(ctx, mem).deferred.map(({ item, claim }) => claimNote(item, claim));
}

/** Whether an `openProblems` note is one `deferredClaimNotes` wrote (it is recomputed every step, never carried over). */
export function isClaimNote(note: string): boolean {
  return /^'.*' claimed at step \d+, judge said p=\d(?:\.\d+)?; (?:re-verify|this test run re-verifies it before it is claimed again)$/.test(note);
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
  if (trace.unstable !== undefined) rec['unstable'] = trace.unstable;
  // llm-jev (docs/LLM-JEV-DESIGN.md §9.3 `StepRecord.verify`): the rounds' counts travel in the step's rawText
  if (trace.llm !== undefined) rec['llm'] = { ...trace.llm };
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

/**
 * A `run` entry counts as the full suite when its window label is the engine's test command
 * (provider/actions.ts summariseAction), or when its passed count equals the baseline's (a
 * goal-subset run of the same runner has fewer tests).
 */
export function isFullSuiteRun(ctx: SynthesisContext, mem: ProposalMemory, run: Pick<ExecutedTestRun, 'action' | 'passed'>): boolean {
  const command = engineTestCommand(ctx, mem);
  const labelled = command !== null && run.action === runActionLabel(command);
  // a repository baseline merges the issue's reproduction into its counts (oracle/search.ts mergeSummaries); the engine's run has only the scoped tests
  const reproPassing = mem.baseline?.passing.filter(isReproTestId).length ?? 0;
  const sameCount = mem.baseline !== null && (run.passed === mem.baseline.passed || run.passed === mem.baseline.passed - reproPassing);
  return labelled || sameCount;
}

/** The controller's record of the engine's last run as an `ExecutedTestRun`, provided no change was executed after it; else null. */
export function engineRunOnCurrentWorkspace(mem: ProposalMemory): ExecutedTestRun | null {
  const run = mem.lastEngineRun ?? null;
  if (run === null) return null;
  const change = mem.lastChangeStep ?? null;
  if (change !== null && run.step < change) return null;
  return { ...run, allPassed: run.failed === 0 && run.errors === 0 && run.passed > 0 };
}

/** The engine's last executed run when it is the full suite on the current workspace and everything passed; else null. */
export function passingFullSuiteRun(ctx: SynthesisContext, mem: ProposalMemory): ExecutedTestRun | null {
  const run = engineRunOnCurrentWorkspace(mem);
  return run !== null && run.allPassed && isFullSuiteRun(ctx, mem, run) ? run : null;
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
 * touched a test file; (3) the guard path ran where it applied. The run is read from the window
 * first, then from the controller's record (`mem.lastEngineRun`), which outlives the window:
 * once the engine has executed the green run, `done` is proposed, never another run
 * (`isFullSuiteRun` says what counts as the suite).
 */
export function doneReadiness(ctx: SynthesisContext, mem: ProposalMemory): DoneReadiness {
  const executedRun = lastExecutedTestRun(ctx.window) ?? engineRunOnCurrentWorkspace(mem);
  const testsChanged = testFilesChanged(mem.committed);
  const guardPending = mem.guardPending === true;
  const blockers: string[] = [];
  let fullSuite = false;
  if (executedRun === null) blockers.push(NOT_RUN_BLOCKER);
  else {
    fullSuite = isFullSuiteRun(ctx, mem, executedRun);
    if (!fullSuite) blockers.push(`the last executed run (${executedRun.action}) is not the full suite`);
    else if (!(executedRun.allPassed && executedRun.failed === 0 && executedRun.errors === 0 && executedRun.passed > 0)) {
      blockers.push(`the last executed run shows ${executedRun.passed} passed, ${executedRun.failed} failed, ${executedRun.errors} errors`);
    }
  }
  if (testsChanged.length > 0) blockers.push(testsChangedBlocker(testsChanged));
  if (guardPending) blockers.push('a batch with several test-passing candidates has not been arbitrated yet');
  return { green: blockers.length === 0, testsCurrent: executedRun !== null, executedRun, testsChanged, guardPending, blockers };
}

/** The repository facts `completionEvidence` reads (memory.ts RepositoryMode, structural). */
export interface CompletionRepository {
  oracleOutcome: string;
  lastRepro: { verdict: { pass: boolean } } | null;
}

/**
 * docs/LLM-JEV-DESIGN.md §6.6: the synthesizer's code facts on the claiming `run` proposal. `ledgerFixed` = every
 * ledger goal fixed (and at least one goal exists); `testsChanged` / `guardPending` as `doneReadiness` computes them;
 * `repro` = the reproduction's verdict on the committed workspace (the synthesizer's own re-run, §6.4), 'none' without
 * one; `oracle` = how the issue oracle was established (null off the repository class); `command` = the suite command
 * the run must execute for the fact to hold. The engine ANDs these with its own parsed run (`isCompleteByFact`).
 */
export function completionEvidence(ctx: SynthesisContext, mem: ProposalMemory, command: string, repo: CompletionRepository | null = null): CompletionEvidence {
  const ready = doneReadiness(ctx, mem);
  const oracle = repo === null ? null : isOracleOutcome(repo.oracleOutcome) ? repo.oracleOutcome : null;
  return {
    ledgerFixed: mem.goals.length > 0 && mem.goals.every((g) => g.status === 'fixed'),
    testsChanged: ready.testsChanged,
    guardPending: ready.guardPending,
    repro: repo === null || repo.lastRepro === null ? 'none' : repo.lastRepro.verdict.pass ? 'pass' : 'fail',
    oracle,
    command,
  };
}

function isOracleOutcome(s: string): s is OracleOutcome {
  return (ORACLE_OUTCOMES as readonly string[]).includes(s);
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
export function proposePatch(ctx: SynthesisContext, applied: AppliedCandidate, goal: Goal, mem: ProposalMemory, note?: CommitNote, trace?: GoalSearchTrace, evidence?: ProposalEvidence | null, opts: PatchOptions = {}): Proposal {
  if (applied.diff.trim().length === 0) throw new ProposalError(`empty diff for ${describeEdit(applied)}`);
  const paths = diffPaths(applied.diff);
  const maxFiles = opts.maxFiles ?? patchMaxFiles(applied);
  if (paths.length > maxFiles) throw new ProposalError(`diff touches ${paths.length} files (${paths.join(', ')}); a ${applied.candidate.source} candidate may touch at most ${maxFiles}`);
  const notes: string[] = [];
  const e = evidence ?? undefined;
  // two sources, both a lone passer Jev did not vouch for: the guard's vouch-bound hold (guard.ts rule (b): two or more structural
  // signals, general 0.3 ≤ p < 0.7, released on the budget reserve or at step end) and a network-dependent / LLM-written oracle's
  // lone passer with general < 0.3 (index.ts arbitrateNetworkPasser). The all-overfit set (rule (1)) is dropped and never carries it.
  // Kept short: openProblemNotes clips at PLAN_ITEM_MAX_CHARS, and describeEdit alone runs to ~60 chars on a repository path.
  if (note === 'possible overfit') notes.push(`possible overfit: ${describeEdit(applied)} passes every test, but Jev did not vouch for this lone passer as a general fix; review the change`);
  // a progress commit says so in the words the evidence measured (proposal + evidence agree: newlyPassing = its tests, goalTests = the goal's)
  if (note === 'partial') notes.push(e === undefined ? `partial fix: ${describeEdit(applied)} fixes some of ${testsLabel(goal)} without regressions; the rest stay open` : `${partialFixSummary(goal, e)} (${describeEdit(applied)})`);
  notes.push(...(opts.notes ?? []));
  const record: JsonObject = trace ? traceRecord(trace) : { kind: 'patch', goalId: goal.id, ledger: ledgerLine(mem.goals), edit: editRecord(applied) };
  if (note !== undefined) record['note'] = note;
  if (opts.notes !== undefined && opts.notes.length > 0) record['notes'] = [...opts.notes];
  if (e !== undefined) record['evidence'] = { before: e.before.passed, after: e.after.passed, total: e.after.total, newlyPassing: e.newlyPassing.length, newlyFailing: e.newlyFailing.length };
  return withEvidence(
    {
      goal: opts.goalText ?? patchGoalText(applied, goal, e),
      action: { kind: 'patch', diff: applied.diff },
      plan: draft([], remainingItems(ctx, mem), openProblemNotes(mem, notes)),
      rawText: rawText(record),
    },
    e,
  );
}

/**
 * A test run (§5.1 rows 2 and 3). `full` after a `patch` claims the goal's plan item NOW
 * (`claimDone`), so the engine's `done_<j>` Noul judges it on this step's parsed output;
 * `subset` records the failing behaviour when a step budget was hit and the search resumes
 * from memory. The plan is otherwise unchanged: the accepted `remaining` and `openProblems`.
 *
 * Only a `fixed` goal is ever claimed (§2.1: `plan.done` is one item per fixed goal). A
 * `partial` commit leaves its goal `open`, and claiming it would be a false claim the engine
 * rejects with a `rejected_claim` note; so `claimDone` on an unfixed goal claims nothing. With
 * the ledger at hand each item is claimed once per verdict (`splitClaims`): an item the judge
 * did not accept on an earlier run stays in `remaining` with a `deferredClaimNotes` note until a
 * new passing suite run re-measures it. `trace` (the search that led to this run, e.g. the
 * budget-hit step) goes into `rawText`.
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
  const split = claimDone && mem !== undefined ? splitClaims(ctx, mem) : null;
  const done = !claimDone ? [] : split !== null ? split.claims : goal && goal.status === 'fixed' ? [normaliseItem(goal.planItem)] : [];
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
  // The plan's notes are otherwise unchanged; a deferred claim adds its note (last step's claim notes are recomputed, not carried)
  let openProblems = [...ctx.plan.openProblems];
  if (split !== null && mem !== undefined && split.deferred.length > 0) {
    openProblems = openProblemNotes(mem, [...ctx.plan.openProblems.filter((n) => !isClaimNote(n)), ...split.deferred.map(({ item, claim }) => claimNote(item, claim))]);
    record['deferred'] = split.deferred.map((d) => d.item);
  }
  return { goal: goalText, action, plan: draft(done, remaining, openProblems), rawText: rawText(record) };
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
 * `notes` are carried in `openProblems` by every form of the `done` (the blocked run, the green
 * and the partial claim alike): a green repository run under a network-dependent oracle still
 * has the open problem its patches carried (search/index.ts networkOracleNote).
 */
export function proposeDone(ctx: SynthesisContext, mem: ProposalMemory, mode: DoneMode, trace?: GoalSearchTrace, notes: readonly string[] = []): Proposal {
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
    // The blockers are human-readable and belong in openProblems so the risk stage sees why the run repeats; a deferred claim keeps its note.
    return { ...run, plan: draft(run.plan.done, run.plan.remaining, openProblemNotes(mem, [...blockers, ...deferredClaimNotes(ctx, mem), ...notes])) };
  }
  const claims = unclaimedFixedItems(ctx, mem);
  // the green run the readiness check found is the evidence for the standing verification item
  if (mode === 'green' && !ctx.plan.done.some((d) => d.text === VERIFY_ITEM)) claims.push(VERIFY_ITEM);
  const total = mem.goals.reduce((n, g) => n + g.tests.length, 0);
  const fixed = mem.goals.filter((g) => g.status === 'fixed').reduce((n, g) => n + g.tests.length, 0);
  const commits = commitCount(mem);
  if (mode === 'green') {
    const n = ready.executedRun?.passed ?? mem.baseline?.passed ?? 0;
    // a repository baseline carries the issue's reproduction as one more test; the engine's run shows the scoped tests only
    const repros = mem.baseline?.passing.filter(isReproTestId) ?? [];
    const summary = `all ${n} tests pass${repros.length > 0 ? `; the reproduction ${repros.join(', ')} passes` : ''}; ${commits} ${commits === 1 ? 'fix' : 'fixes'} committed`;
    const record: JsonObject = { kind: 'done', mode, ledger: ledgerLine(mem.goals), passed: n, committed: commits, claimed: claims };
    if (trace) record['trace'] = traceRecord(trace);
    if (notes.length > 0) record['notes'] = [...notes];
    return { goal: summary, action: { kind: 'done', summary }, plan: draft(claims, [], notes.length === 0 ? [] : openProblemNotes(mem, notes)), rawText: rawText(record) };
  }
  const reasons = mem.goals.filter((g) => g.status === 'parked').map((g) => `${testsLabel(g)}: ${g.parkedReason ?? 'parked'}`);
  const summary = `partial: fixed ${fixed} of ${total} failing tests${reasons.length > 0 ? `; ${reasons.join('; ')}` : ''}${notes.length > 0 ? `; ${notes.join('; ')}` : ''}`;
  const record: JsonObject = { kind: 'done', mode, ledger: ledgerLine(mem.goals), fixedTests: fixed, totalTests: total, committed: commits, claimed: claims };
  if (trace) record['trace'] = traceRecord(trace);
  if (notes.length > 0) record['notes'] = [...notes];
  return {
    goal: clip(summary, PLAN_ITEM_MAX_CHARS),
    action: { kind: 'done', summary: clip(summary, 600) },
    plan: draft(claims, remainingItems(ctx, mem, new Set(claims)), openProblemNotes(mem, notes)),
    rawText: rawText(record),
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
