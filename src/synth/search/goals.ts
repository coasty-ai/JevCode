/**
 * The ledger of sub-goals (docs/JEV-ONLY-DESIGN.md §2.1–§2.2, §5.3): failing tests clustered
 * into goals, the status transitions (open → active → fixed / parked → open), and the one Jev
 * question of this module, Q1 `attack_first` (§2.7).
 *
 * Clustering is code: by the innermost traceback frame in a source file (file, function, ±3
 * lines) when the run printed one, else by the top-ranked SBFL line the tests share, else one
 * goal per test. Why frames first: on the ladder's multi-bug tasks every hunk fixes ≥ 1 test on
 * its own (bench/data/ladder/README.md), and the tests a hunk fixes raise or return from the
 * same function; on QuixBugs the runner reports no frames, so one goal per test reproduces the
 * measured attack-first setting (probe-progress-judgment.md Part 3, options = failing tests).
 *
 * Jev's job here is the one tests cannot do: which failing behaviour to attack first
 * (neutral wording 16/34 simplest-first vs 8/34 chance). Everything else is arithmetic.
 *
 * One traceback-derived hint rides on the goal: `missingNames`, the identifiers a NameError /
 * ImportError / ModuleNotFoundError line names (`missingNamesIn`). It is evidence for the site
 * list (search/sites.ts adds the module-level import gap), never a rule about a fix.
 */
import type { Json, Question, StageName, SynthesisContext } from '../../core/types.js';
import { choice } from '../../jev/questions.js';
import type { PerTestResult, RankedLine } from '../sbfl/types.js';
import type { CandidateSourceName, FailureView, JevAsk, SourceFile, TestRunSummary } from '../types.js';
import { DEFAULT_PICK_MAX, DEFAULT_TIE_MARGIN, failureStatus, inputSize, optionKeyFor, STATE_FAILURES_BOUND } from '../verify/questions.js';
import { RUN_FAILURE_ID } from '../verify/text.js';
import { attachPlanItems, memoryOfGoals, parseGoalItem, planItemFor } from './memory.js';
import type { SearchMemory } from './memory.js';
import type { Goal, GoalStatus, Phase } from './types.js';

// ---------------------------------------------------------------------------------------
// Constants (each with the measurement behind it)
// ---------------------------------------------------------------------------------------

/**
 * Two frames in the same function whose lines are this close belong to one goal. Jev's line
 * pick lands within ±3 of the gold line on 94 % of the SWE functions (probe-swebench-understanding.md
 * Q4) and the localiser's site windows are ±3 (localize/types.ts `window`), so tests that fail
 * within one window are one repair.
 */
export const FRAME_LINE_WINDOW = 3;
/**
 * SBFL lines considered for clustering when no frame exists: Ochiai's top-5 covers 34/38 QuixBugs
 * fixed lines while top-1 covers 7/38 (lit-search-based-repair.md §6); the design unions SBFL
 * top-5 on single-file workspaces (§2.5).
 */
export const SBFL_CLUSTER_TOP = 5;
/** §5.3: a goal is parked after this many searches without a commit. */
export const MAX_SEARCHES_WITHOUT_COMMIT = 3;
/** §5.3: a goal is parked after this many consecutive budget-hit steps (three identical subset runs would trip the loop detector). */
export const MAX_CONSECUTIVE_BUDGET_HITS = 2;
/** Failures kept per goal for Jev states; the measured programs had ≤ 14 (verify STATE_FAILURES_BOUND). */
export const GOAL_FAILURES_BOUND = STATE_FAILURES_BOUND;
/**
 * The task text appended to the Q1 state, bounded. The measured Q1 state was ≈ 1k tokens with
 * the failing tests alone; the task text is context, not evidence, and must not crowd them out.
 */
export const Q1_TASK_CHARS_MAX = 2000;
export const ATTACK_FIRST_ID = 'attack_first';
/** Measured neutral wording (probe-progress-judgment.md Part 3), verbatim. */
export const ATTACK_FIRST_INSTRUCTIONS = 'Which entry of `failing_tests` should the repair attack first?';

// ---------------------------------------------------------------------------------------
// Traceback-derived hints: the name a NameError / ImportError says is missing
// ---------------------------------------------------------------------------------------

/**
 * CPython's own wording for an unbound or unimportable name, as pytest prints it on an `E` line
 * and as the verifier keeps it in `FailureView.actual`. Only the interpreter's messages are read
 * (never an assertion's text): each one names exactly the identifier a missing import binds.
 */
const MISSING_NAME_PATTERNS: readonly RegExp[] = [
  /\bNameError: (?:global )?name '([A-Za-z_]\w*)' is not defined/g,
  /\bImportError: cannot import name '([A-Za-z_]\w*)'/g,
  /\bModuleNotFoundError: No module named '([A-Za-z_][\w.]*)'/g,
];

/** Identifiers the interpreter reported missing in `text` (traceback, `E` lines or a failure's `actual`), first seen first. */
export function missingNamesIn(text: string): string[] {
  const out: string[] = [];
  for (const re of MISSING_NAME_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const name = m[1] ?? '';
      if (name !== '' && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------------------

export interface ClusterOptions {
  /**
   * Full raw output of the baseline run. pytest's FAILURES sections carry the traceback frames.
   * When absent the summary's `outputTail` (last 4,000 chars, verify OUTPUT_TAIL_BOUND) is read
   * instead: index.ts only passes the file map, and a ladder-sized run (≤ 2 KB) fits the tail
   * whole; on a longer output the sections the cut removed simply yield one goal per test.
   */
  output?: string;
  /**
   * Workspace source paths (non-test) a frame may point into, relative to the workspace root.
   * When absent, any frame outside a test file, site-packages or the stdlib counts as source.
   */
  sourcePaths?: readonly string[];
  /** per-test coverage and the spectrum ranking from src/synth/sbfl, when coverage was collected */
  sbfl?: { ranked: readonly RankedLine[]; perTest: readonly PerTestResult[] };
  /** files to suspect when neither frames nor SBFL name one (the QuixBugs program under repair) */
  defaultFiles?: readonly string[];
}

/** One resolved traceback frame of a failing test. */
export interface Frame {
  path: string;
  line: number;
  fn: string | null;
  /** source: a workspace file under repair; test: the test module itself */
  kind: 'source' | 'test';
}

// pytest --tb=short/long frame: "src/account.py:37: in withdraw"
const PYTEST_FRAME = /^(\S+\.py):(\d+): in (\S+)\s*$/;
// pytest location line without a function: "test_sample.py:12: AssertionError", "test_sample.py:20: "
const PYTEST_LOCATION = /^(\S+\.py):(\d+):(?: \S.*)?\s*$/;
// Python's own traceback (pytest --tb=native, captured stderr): '  File "src/x.py", line 42, in f'
const NATIVE_FRAME = /^\s*File "([^"]+)", line (\d+)(?:, in (\S+))?/;
// bench/data/quixbugs/run_tests.py appends the failing test line: "(at gcd_test.py:47: path = ...)"
const ACTUAL_FRAME = /\(at (\S+\.py):(\d+): /;
const SECTION_HEADER = /^={3,} (.+?) ={3,}$/;
const TEST_HEADER = /^_{3,} (.+?) _{3,}$/;
const TEST_PATH = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$|(^|\/)tests?\//;
const FOREIGN_PATH = /site-packages\/|\/lib\/python\d|\/_pytest\/|^<|^\/usr\/|^\/opt\//;

function normalisePath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Resolve a printed path to a workspace source path (exact, or the print is absolute and ends with it). */
function resolveSource(raw: string, sourcePaths: readonly string[] | undefined): string | null {
  const path = normalisePath(raw);
  if (sourcePaths !== undefined) {
    if (sourcePaths.includes(path)) return path;
    let best: string | null = null;
    for (const p of sourcePaths) if (path.endsWith(`/${p}`) && (best === null || p.length > best.length)) best = p;
    return best;
  }
  if (FOREIGN_PATH.test(path) || TEST_PATH.test(path)) return null;
  return path;
}

function frameOf(raw: string, line: number, fn: string | null, sourcePaths: readonly string[] | undefined): Frame | null {
  const source = resolveSource(raw, sourcePaths);
  if (source !== null) return { path: source, line, fn, kind: 'source' };
  const path = normalisePath(raw);
  if (FOREIGN_PATH.test(path)) return null;
  // Not a known source file: a test module (or, with sourcePaths given, anything else in the
  // workspace, which a test that fails in its own body prints).
  return { path, line, fn, kind: 'test' };
}

/** Frames in a block of traceback text, outermost first (pytest and Python both print that way). */
export function framesIn(text: string, sourcePaths?: readonly string[]): Frame[] {
  const out: Frame[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    let m = PYTEST_FRAME.exec(line);
    if (m !== null) {
      const f = frameOf(m[1] ?? '', Number(m[2]), m[3] ?? null, sourcePaths);
      if (f !== null) out.push(f);
      continue;
    }
    m = NATIVE_FRAME.exec(line);
    if (m !== null) {
      const f = frameOf(m[1] ?? '', Number(m[2]), m[3] ?? null, sourcePaths);
      if (f !== null) out.push(f);
      continue;
    }
    m = PYTEST_LOCATION.exec(line);
    if (m !== null) {
      const f = frameOf(m[1] ?? '', Number(m[2]), null, sourcePaths);
      if (f !== null) out.push(f);
    }
  }
  return out;
}

/**
 * The FAILURES / ERRORS sections of a pytest run: header name → raw lines, in order. Starts
 * inside a failures section: pytest prints no `___ name ___` header before its first `=== … ===`
 * banner, so this only matters when the text is an `outputTail` whose head (banner included) was
 * cut, and then the sections that survived whole are still read.
 */
function pytestSections(output: string): { name: string; lines: string[] }[] {
  const sections: { name: string; lines: string[] }[] = [];
  let inFailures = true;
  let current: { name: string; lines: string[] } | null = null;
  for (const line of output.split(/\r?\n/)) {
    const header = SECTION_HEADER.exec(line);
    if (header !== null) {
      const name = header[1] ?? '';
      inFailures = name === 'FAILURES' || name === 'ERRORS';
      current = null;
      continue;
    }
    if (!inFailures) continue;
    const test = TEST_HEADER.exec(line);
    if (test !== null) {
      current = { name: (test[1] ?? '').replace(/^ERROR (?:at (?:setup|call|teardown) of|collecting) /, ''), lines: [] };
      sections.push(current);
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  return sections;
}

/** "path::TestGroup::test_x[1-2]" → "TestGroup.test_x[1-2]" (pytest's FAILURES header form). */
function sectionNameOf(testId: string): string {
  const parts = testId.split('::');
  return parts.length > 1 ? parts.slice(1).join('.') : testId;
}

/** "tests/test_x.py::TestA::test_b[1-2]" → "TestA.test_b"; a run_tests.py id is its own function. */
function testFunctionOf(testId: string): string {
  return sectionNameOf(testId).replace(/\[.*$/, '');
}

function testFileOfId(testId: string): string {
  const at = testId.indexOf('::');
  return at === -1 ? '' : testId.slice(0, at);
}

/** What one failing test's output says: its traceback frames and the names the interpreter reported missing. */
interface TestEvidence {
  frames: Frame[];
  missingNames: string[];
}

/**
 * Per failing test, the frames of its traceback section (same-named tests in two files are told
 * apart by the file the section prints) and the missing names read from that section and from
 * the failure's `actual` (the verifier keeps the exception line there even when the output tail
 * cut the section).
 */
function evidencePerTest(baseline: TestRunSummary, opts: ClusterOptions): Map<string, TestEvidence> {
  const out = new Map<string, TestEvidence>();
  const sections = opts.output === undefined ? [] : pytestSections(opts.output);
  for (const id of baseline.failing) {
    const name = sectionNameOf(id);
    const file = testFileOfId(id);
    const same = sections.filter((s) => s.name === name);
    let section = same[0];
    if (same.length > 1 && file !== '') {
      const own = same.find((s) => s.lines.some((l) => l.includes(file)));
      if (own !== undefined) section = own;
    }
    const sectionText = section === undefined ? '' : section.lines.join('\n');
    const frames = section === undefined ? [] : framesIn(sectionText, opts.sourcePaths);
    const failure = baseline.failures.find((f) => f.testId === id);
    if (frames.length === 0) {
      // The QuixBugs runner's "(at file.py:47: ...)" tail is the only frame it prints.
      const m = failure === undefined ? null : ACTUAL_FRAME.exec(failure.actual);
      if (m !== null) {
        const f = frameOf(m[1] ?? '', Number(m[2]), null, opts.sourcePaths);
        if (f !== null) frames.push(f);
      }
    }
    out.set(id, { frames, missingNames: missingNamesIn(`${sectionText}\n${failure?.actual ?? ''}`) });
  }
  return out;
}

/** The frame a test clusters on: its innermost source frame, else its innermost test-module frame. */
export function keyFrame(frames: readonly Frame[]): Frame | null {
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i]?.kind === 'source') return frames[i] ?? null;
  return frames[frames.length - 1] ?? null;
}

interface Cluster {
  /** why these tests are together, for the transcript: "frame src/x.py:f", "sbfl src/x.py:12", "test" */
  reason: string;
  /** indices into baseline.failing, ascending */
  members: number[];
  suspectedFiles: string[];
  /** union of the members' missing names, in member order */
  missingNames: string[];
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

interface FramedTest {
  index: number;
  frame: Frame;
  frames: Frame[];
  missingNames: string[];
}

/** Group tests with the same (file, function) key whose lines fall within FRAME_LINE_WINDOW of the group's first line. */
function clusterByFrames(entries: FramedTest[]): Cluster[] {
  const byFn = new Map<string, typeof entries>();
  for (const e of entries) {
    const key = `${e.frame.kind}|${e.frame.path}|${e.frame.fn ?? ''}`;
    const list = byFn.get(key);
    if (list === undefined) byFn.set(key, [e]);
    else list.push(e);
  }
  const clusters: Cluster[] = [];
  for (const list of byFn.values()) {
    list.sort((a, b) => a.frame.line - b.frame.line || a.index - b.index);
    let current: typeof entries = [];
    const flush = (): void => {
      if (current.length === 0) return;
      const first = current[0]!;
      const files = dedupe(current.flatMap((e) => e.frames.filter((f) => f.kind === 'source').map((f) => f.path).reverse()));
      const where = `${first.frame.path}:${first.frame.fn ?? first.frame.line}`;
      const members = current.map((e) => e.index).sort((a, b) => a - b);
      const missingNames = dedupe([...current].sort((a, b) => a.index - b.index).flatMap((e) => e.missingNames));
      clusters.push({ reason: `frame ${where}`, members, suspectedFiles: files, missingNames });
      current = [];
    };
    for (const e of list) {
      const start = current[0];
      if (start !== undefined && e.frame.line - start.frame.line > FRAME_LINE_WINDOW) flush();
      current.push(e);
    }
    flush();
  }
  return clusters;
}

/** The best-ranked SBFL line (rank ≤ SBFL_CLUSTER_TOP) a test executed, or null. */
function sbflKeyLine(testId: string, sbfl: NonNullable<ClusterOptions['sbfl']>): RankedLine | null {
  const per = sbfl.perTest.find((r) => r.id === testId);
  if (per === undefined) return null;
  let best: RankedLine | null = null;
  for (const r of sbfl.ranked) {
    if (r.rank > SBFL_CLUSTER_TOP) continue;
    if (!(per.lines[r.file] ?? []).includes(r.line)) continue;
    if (best === null || r.rank < best.rank) best = r;
  }
  return best;
}

function failureFor(baseline: TestRunSummary, testId: string): FailureView {
  return baseline.failures.find((f) => f.testId === testId) ?? { testId, call: testId, expected: '', actual: 'failed: no details in the output' };
}

export function newGoal(id: string, tests: string[], failures: FailureView[], suspectedFiles: string[], missingNames: readonly string[] = []): Goal {
  const goal: Goal = { id, tests, failures, suspectedFiles, status: 'open', attempts: 0, budgetHits: 0, exhausted: new Map(), phase: 'SEEDS', planItem: '' };
  if (missingNames.length > 0) goal.missingNames = [...missingNames];
  goal.planItem = planItemFor(goal);
  return goal;
}

/**
 * Cluster the baseline's failing tests into goals. Deterministic: ids g1..gn by cluster size
 * descending, then first test id ascending; members keep the runner's order. The synthetic
 * `<test run>` failure (timeout, crash) is not a test and is left to the caller (§4.1 parks the
 * run's goals with "suite too slow").
 */
export function clusterFailures(baseline: TestRunSummary, options: ClusterOptions | ReadonlyMap<string, SourceFile> = {}): Goal[] {
  const given = options instanceof Map ? optionsFromFiles(options) : (options as ClusterOptions);
  const opts: ClusterOptions = { ...given, output: given.output ?? baseline.outputTail };
  const failing = baseline.failing.filter((id) => id !== RUN_FAILURE_ID);
  const evidence = evidencePerTest({ ...baseline, failing }, opts);
  const framed: FramedTest[] = [];
  const unframed: number[] = [];
  const missingOf = (id: string): string[] => evidence.get(id)?.missingNames ?? [];
  failing.forEach((id, index) => {
    const fs = evidence.get(id)?.frames ?? [];
    let key = keyFrame(fs);
    // A test-module location without a function name ("test_x.py:12: AssertionError") is the
    // test's own body: key it by the test function, so parametrised cases of one test share a
    // goal while neighbouring tests at adjacent lines do not.
    if (key !== null && key.kind === 'test' && key.fn === null) key = { ...key, fn: testFunctionOf(id) };
    if (key === null) unframed.push(index);
    else framed.push({ index, frame: key, frames: fs, missingNames: missingOf(id) });
  });
  const clusters = clusterByFrames(framed);
  const bySbfl = new Map<string, Cluster>();
  for (const index of unframed) {
    const id = failing[index]!;
    const line = opts.sbfl === undefined ? null : sbflKeyLine(id, opts.sbfl);
    if (line === null) {
      clusters.push({ reason: 'test', members: [index], suspectedFiles: [], missingNames: missingOf(id) });
      continue;
    }
    const key = `${line.file}:${line.line}`;
    const existing = bySbfl.get(key);
    if (existing === undefined) {
      const c: Cluster = { reason: `sbfl ${key}`, members: [index], suspectedFiles: [line.file], missingNames: missingOf(id) };
      bySbfl.set(key, c);
      clusters.push(c);
    } else {
      existing.members.push(index);
      existing.missingNames = dedupe([...existing.missingNames, ...missingOf(id)]);
    }
  }
  const defaults = [...(opts.defaultFiles ?? [])];
  const withTests = clusters.map((c) => ({ c, tests: c.members.sort((a, b) => a - b).map((i) => failing[i]!) }));
  withTests.sort((a, b) => b.tests.length - a.tests.length || cmp(a.tests[0] ?? '', b.tests[0] ?? ''));
  return withTests.map(({ c, tests }, i) => {
    const files = c.suspectedFiles.length > 0 ? c.suspectedFiles : defaults;
    return newGoal(`g${i + 1}`, tests, tests.slice(0, GOAL_FAILURES_BOUND).map((t) => failureFor(baseline, t)), files, c.missingNames);
  });
}

/**
 * The workspace's Python files as clustering options: non-test files are the source paths frames
 * may resolve into; a single-file workspace (QuixBugs) suspects that file by default.
 */
export function optionsFromFiles(files: ReadonlyMap<string, SourceFile>): ClusterOptions {
  const sourcePaths = [...files.keys()].filter((p) => !TEST_PATH.test(normalisePath(p)));
  const opts: ClusterOptions = { sourcePaths };
  if (sourcePaths.length === 1) opts.defaultFiles = [sourcePaths[0]!];
  return opts;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------
// Reconciling a fresh clustering with the ledger (after every commit, and on resume)
// ---------------------------------------------------------------------------------------

/** What a previous goal contributes to a fresh one with overlapping tests. */
export interface PriorGoalState {
  id: string;
  tests: readonly string[];
  status: GoalStatus;
  attempts: number;
  budgetHits: number;
  phase: Phase;
  parkedReason?: string;
  planItem: string;
  exhausted?: Map<string, Set<CandidateSourceName>>;
  failures?: FailureView[];
  suspectedFiles?: string[];
}

function goalNumber(id: string): number {
  const m = /^g(\d+)$/.exec(id);
  return m === null ? 0 : Number(m[1]);
}

/**
 * Carry the ledger's state onto a fresh clustering by test-id overlap (largest overlap first,
 * each prior used once). A matched goal keeps the prior id (the localisation cache and WIDENED
 * cursor are keyed by it), its parked state and reason, attempts, budget hits, phase and
 * exhausted sources; `active` becomes `open` (the search that was running ended with the
 * workspace change that triggered the re-clustering). A prior goal none of whose tests fail any
 * more comes back as `fixed`. Unmatched fresh goals get ids above every id seen so far.
 */
export function inheritGoalState(fresh: readonly Goal[], prior: readonly PriorGoalState[]): Goal[] {
  const pairs: { i: number; j: number; overlap: number }[] = [];
  fresh.forEach((g, i) => {
    const tests = new Set(g.tests);
    prior.forEach((p, j) => {
      const overlap = p.tests.filter((t) => tests.has(t)).length;
      if (overlap > 0) pairs.push({ i, j, overlap });
    });
  });
  pairs.sort((a, b) => b.overlap - a.overlap || a.i - b.i || a.j - b.j);
  const freshTaken = new Set<number>();
  const priorTaken = new Set<number>();
  const match = new Map<number, number>();
  for (const { i, j } of pairs) {
    if (freshTaken.has(i) || priorTaken.has(j)) continue;
    freshTaken.add(i);
    priorTaken.add(j);
    match.set(i, j);
  }
  const takenIds = new Set(prior.map((p) => p.id));
  let next = Math.max(0, ...prior.map((p) => goalNumber(p.id)), ...fresh.map((g) => goalNumber(g.id))) + 1;
  const out: Goal[] = fresh.map((g, i) => {
    const j = match.get(i);
    if (j === undefined) {
      if (prior.length === 0 || !takenIds.has(g.id)) return g;
      const id = `g${next++}`;
      return { ...g, id };
    }
    const p = prior[j]!;
    const goal: Goal = { ...g, id: p.id, status: p.status === 'parked' ? 'parked' : 'open', attempts: p.attempts, budgetHits: p.budgetHits, phase: p.phase, exhausted: p.exhausted ?? new Map() };
    if (p.status === 'parked' && p.parkedReason !== undefined) goal.parkedReason = p.parkedReason;
    return goal;
  });
  const stillFailing = new Set(fresh.flatMap((g) => g.tests));
  prior.forEach((p, j) => {
    if (priorTaken.has(j) || p.tests.some((t) => stillFailing.has(t))) return;
    const parsed = parseGoalItem(p.planItem);
    const suspectedFiles = p.suspectedFiles ?? (parsed === null ? [] : [parsed.path]);
    out.push({ id: p.id, tests: [...p.tests], failures: p.failures ?? [], suspectedFiles, status: 'fixed', attempts: p.attempts, budgetHits: 0, exhausted: new Map(), phase: p.phase, planItem: p.planItem });
  });
  return out;
}

function priorOf(g: Goal): PriorGoalState {
  const p: PriorGoalState = { id: g.id, tests: g.tests, status: g.status, attempts: g.attempts, budgetHits: g.budgetHits, phase: g.phase, planItem: g.planItem, exhausted: g.exhausted, failures: g.failures, suspectedFiles: g.suspectedFiles };
  if (g.parkedReason !== undefined) p.parkedReason = g.parkedReason;
  return p;
}

/**
 * §2.2 `reconcile(mem.goals, clusterFailures(mem.baseline), ctx.plan)`: the fresh clustering
 * inherits the ledger's parked/attempt state and the engine's plan-item strings.
 */
export function reconcile(existing: readonly Goal[], fresh: readonly Goal[], plan: { remaining: readonly string[] }): Goal[] {
  const goals = inheritGoalState(fresh, existing.map(priorOf));
  attachPlanItems(goals, plan.remaining);
  return goals;
}

// ---------------------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------------------

export function isOpen(goal: Goal): boolean {
  return goal.status === 'open' || goal.status === 'active';
}

/**
 * The goal enters a search: `active`, one more attempt (§5.3 counts searches without a commit).
 * `pickGoal` calls this for the goal it returns, so the controller (search/index.ts) must not
 * count the attempt again: doing both would park after two searches, not three.
 */
export function beginAttempt(goal: Goal): void {
  goal.status = 'active';
  goal.attempts += 1;
}

export function park(goal: Goal, reason: string): void {
  goal.status = 'parked';
  goal.parkedReason = reason;
  goal.budgetHits = 0;
}

/** A commit for this goal: attempts restart; `fixed` when every goal test passed, else back to `open`. */
export function noteCommit(goal: Goal, allGoalTestsPass: boolean): void {
  goal.status = allGoalTestsPass ? 'fixed' : 'open';
  goal.attempts = 0;
  goal.budgetHits = 0;
  delete goal.parkedReason;
}

/** A step ended on the budget cap for this goal; parks at MAX_CONSECUTIVE_BUDGET_HITS. Returns the park reason when parked. */
export function noteBudgetHit(goal: Goal): string | null {
  goal.budgetHits += 1;
  if (goal.budgetHits >= MAX_CONSECUTIVE_BUDGET_HITS) {
    const reason = `${goal.budgetHits} consecutive budget-hit steps`;
    park(goal, reason);
    return reason;
  }
  return null;
}

/** The §5.3 park rule the counters alone can decide; null when the goal may be searched. */
export function parkReasonFor(goal: Pick<Goal, 'attempts' | 'budgetHits'>): string | null {
  if (goal.attempts >= MAX_SEARCHES_WITHOUT_COMMIT) return `${goal.attempts} searches without a commit`;
  if (goal.budgetHits >= MAX_CONSECUTIVE_BUDGET_HITS) return `${goal.budgetHits} consecutive budget-hit steps`;
  return null;
}

/**
 * A commit changed `changedFiles`: every goal that suspects one of them loses its localisation
 * cache, exhausted sets and WIDENED cursor (line numbers moved), and a parked one re-opens with
 * its attempts kept (§5.3). Returns the re-opened goals.
 */
export function reopenOnChange(memOrGoals: Pick<SearchMemory, 'goals' | 'localizeCache' | 'widenCursor'> | readonly Goal[], changedFiles: readonly string[]): Goal[] {
  // The bare-list form (search/index.ts passes `mem.goals`) still invalidates the caches when the
  // list is a registered run's ledger; a detached list has no caches to clear.
  const mem = Array.isArray(memOrGoals)
    ? (memoryOfGoals(memOrGoals as readonly Goal[]) ?? { goals: memOrGoals as readonly Goal[], localizeCache: new Map<string, never>(), widenCursor: new Map<string, number>() })
    : (memOrGoals as Pick<SearchMemory, 'goals' | 'localizeCache' | 'widenCursor'>);
  const changed = new Set(changedFiles.map(normalisePath));
  const reopened: Goal[] = [];
  for (const goal of mem.goals) {
    if (goal.status === 'fixed' || !goal.suspectedFiles.some((f) => changed.has(normalisePath(f)))) continue;
    mem.localizeCache.delete(goal.id);
    mem.widenCursor.delete(goal.id);
    goal.exhausted = new Map();
    if (goal.status === 'parked') {
      goal.status = 'open';
      goal.budgetHits = 0;
      delete goal.parkedReason;
      reopened.push(goal);
    }
  }
  return reopened;
}

/** The `synth` ledger line emitted every step: "fixed 2, open 1, parked 1". */
export function ledgerLine(goals: readonly Goal[]): string {
  const n = (s: GoalStatus): number => goals.filter((g) => g.status === s).length;
  return `fixed ${n('fixed')}, open ${n('open') + n('active')}, parked ${n('parked')}`;
}

// ---------------------------------------------------------------------------------------
// Q1 attack_first
// ---------------------------------------------------------------------------------------

/** The failure Jev sees for a goal: its first test's (the plan-item test). */
export function leadFailure(goal: Pick<Goal, 'tests' | 'failures'>): FailureView {
  const first = goal.tests[0] ?? '';
  return goal.failures.find((f) => f.testId === first) ?? goal.failures[0] ?? { testId: first, call: first, expected: '', actual: 'failed: no details in the output' };
}

/**
 * The code tiebreak of §2.7 Q1: fewest tests, shortest input, fewest attempts, then ledger order.
 * Fewest tests first because a one-test goal is the most local behaviour; shortest input is the
 * measured "simplest" proxy (probe-progress-judgment.md Part 3).
 */
export function codeOrder(a: Goal, b: Goal): number {
  return a.tests.length - b.tests.length || inputSize(leadFailure(a)) - inputSize(leadFailure(b)) || a.attempts - b.attempts || goalNumber(a.id) - goalNumber(b.id) || cmp(a.id, b.id);
}

function failureText(f: FailureView): string {
  return f.expected === '' ? `${f.call} -> ${f.actual}` : `${f.call} -> ${f.actual}, expected ${f.expected}`;
}

export interface AttackFirstBatch {
  offered: { key: string; goal: Goal }[];
  state: Json;
  question: Question;
}

export interface PickGoalOptions {
  /** goals offered (the measured Choice offered the first 10 failing tests) */
  max?: number;
  /** what fails, e.g. "the Python function `gcd`" (the measured wording); default "the program under repair" */
  subject?: string;
  /** probabilities within this margin of the top tie (Jev's noise band, DEFAULT_TIE_MARGIN 0.02) */
  tieMargin?: number;
  stage?: StageName;
}

/**
 * Q1: the measured neutral Choice over open goals, options keyed by the first test id
 * (`failing_<slug>`), description = the failure text, content under `failing_tests.<key>`
 * as `{ input, expected, actual, status }` (the measured state shape); escape appended by `choice()`.
 */
export function attackFirstQuestion(goals: readonly Goal[], task: string, opts: PickGoalOptions = {}): AttackFirstBatch {
  const max = opts.max ?? DEFAULT_PICK_MAX;
  const taken = new Set<string>();
  const offered: { key: string; goal: Goal }[] = [];
  for (const goal of goals.slice(0, max)) {
    const key = optionKeyFor(goal.tests[0] ?? goal.id, taken);
    taken.add(key);
    offered.push({ key, goal });
  }
  const entries: { [k: string]: Json } = {};
  const options: Record<string, Json | null> = {};
  for (const { key, goal } of offered) {
    const f = leadFailure(goal);
    entries[key] = { input: f.call, expected: f.expected, actual: f.actual, status: failureStatus(f) };
    options[key] = failureText(f);
  }
  const subject = opts.subject ?? 'the program under repair';
  const lead = `${subject.charAt(0).toUpperCase()}${subject.slice(1)} fails several tests. \`failing_tests\` lists them with input, expected output and actual result.`;
  const taskText = task.trim();
  const clipped = taskText.length > Q1_TASK_CHARS_MAX ? `${taskText.slice(0, Q1_TASK_CHARS_MAX)}…` : taskText;
  return {
    offered,
    state: { task: clipped === '' ? lead : `${lead}\nThe task: ${clipped}`, failing_tests: entries },
    question: choice(ATTACK_FIRST_INSTRUCTIONS, options),
  };
}

export interface GoalPick {
  goal: Goal | null;
  /**
   * none: no open goal; active: a search already in progress resumes; single: the only open
   * goal; jev: the Choice argmax beat the runner-up by more than the margin; tiebreak: the code
   * order decided (several options within the margin, or the escape option won)
   */
  method: 'none' | 'active' | 'single' | 'jev' | 'tiebreak';
  /** P(option) of the pick on the Choice; 1 without a request */
  probability: number;
  requests: number;
}

export class GoalPickError extends Error {
  constructor(message: string) {
    super(`GoalPickError: ${message}`);
    this.name = 'GoalPickError';
  }
}

export type PickGoalContext = Pick<SynthesisContext, 'task'> & Partial<Pick<SynthesisContext, 'ask'>>;

/**
 * §2.2 `pickGoal`: the goal to attack this step, or null when every goal is parked or fixed.
 * One `active` goal (a search a budget-hit step left in memory) resumes without a request; one
 * open goal is taken; two or more are put to Q1, argmax if it beats the runner-up by more than
 * `tieMargin`, else the code tiebreak. The picked goal becomes `active` and its attempt count
 * moves (`beginAttempt`; not when resuming an already active goal). `pickGoalDetailed` returns
 * the method and probability as well.
 */
export async function pickGoal(ctx: PickGoalContext, mem: Pick<SearchMemory, 'goals'>, ask: JevAsk | undefined = ctx.ask, opts: PickGoalOptions = {}): Promise<Goal | null> {
  return (await pickGoalDetailed(ctx, mem, ask, opts)).goal;
}

export async function pickGoalDetailed(ctx: PickGoalContext, mem: Pick<SearchMemory, 'goals'>, ask: JevAsk | undefined = ctx.ask, opts: PickGoalOptions = {}): Promise<GoalPick> {
  const active = mem.goals.filter((g) => g.status === 'active');
  if (active.length === 1) return { goal: active[0]!, method: 'active', probability: 1, requests: 0 };
  const open = mem.goals.filter(isOpen);
  if (open.length === 0) return { goal: null, method: 'none', probability: 1, requests: 0 };
  if (open.length === 1) {
    const goal = open[0]!;
    beginAttempt(goal);
    return { goal, method: 'single', probability: 1, requests: 0 };
  }
  if (ask === undefined) throw new GoalPickError('pickGoal needs a JevAsk (argument or ctx.ask) when two or more goals are open');
  const ordered = [...open].sort(codeOrder);
  const batch = attackFirstQuestion(ordered, ctx.task, opts);
  const res = await ask(opts.stage ?? 'propose', batch.state, { [ATTACK_FIRST_ID]: batch.question });
  const answer = res.answers[ATTACK_FIRST_ID];
  if (answer === undefined || answer.type !== 'choice') throw new GoalPickError('attack_first answer missing or not a choice');
  const margin = opts.tieMargin ?? DEFAULT_TIE_MARGIN;
  const p = (key: string): number => answer.probabilities[key] ?? 0;
  const top = batch.offered.reduce((m, it) => Math.max(m, p(it.key)), 0);
  const escape = answer.probabilities['none_of_these'] ?? 0;
  // The escape winning means "attack first" has no good answer: code decides among all offered.
  const tied = escape > top ? batch.offered : batch.offered.filter((it) => top - p(it.key) <= margin + 1e-9);
  // `offered` is already in code order, so the first tied entry is the tiebreak winner.
  const pick = tied[0] ?? batch.offered[0]!;
  beginAttempt(pick.goal);
  return { goal: pick.goal, method: tied.length > 1 || escape > top ? 'tiebreak' : 'jev', probability: p(pick.key), requests: 1 };
}
