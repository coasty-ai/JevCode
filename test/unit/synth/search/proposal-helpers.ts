/**
 * Offline builders for the proposal / directive tests: a SynthesisContext with fake workspace
 * and sandbox (nothing runs, nothing is asked), Goal and AppliedCandidate fixtures, and window
 * entries shaped exactly as loop/window.ts + provider/actions.ts summariseAction write them.
 */
import type { Candidate as WorkspaceCandidate, EngineEvent, FileView, JudgeResult, OutcomeStatus, Plan, Sandbox, SynthesisContext, TestCommand, WindowEntry, Workspace, WorkspaceInfo, Intent } from '../../../../src/core/types.js';
import type { DirectiveMemory, SearchOverrides } from '../../../../src/synth/search/directive.js';
import { defaultOverrides } from '../../../../src/synth/search/directive.js';
import type { Goal, GoalSearchTrace } from '../../../../src/synth/search/types.js';
import type { AppliedCandidate, LocalizeResult } from '../../../../src/synth/types.js';
import { applyCandidate } from '../../../../src/synth/verify/apply.js';
import { candidate, site, sourceFile, summary } from '../verify/helpers.js';

export const TEST_COMMAND = 'pytest -q';

export function makeGoal(over: Partial<Goal> & { id: string }): Goal {
  const tests = over.tests ?? [`tests/test_${over.id}.py::test_${over.id}`];
  const suspectedFiles = over.suspectedFiles ?? [`src/${over.id}.py`];
  const first = tests[0] ?? '<no test>';
  const more = tests.length - 1;
  const goal: Goal = {
    id: over.id,
    tests,
    failures: over.failures ?? tests.map((t) => ({ testId: t, call: t, expected: '1', actual: '0' })),
    suspectedFiles,
    status: over.status ?? 'open',
    attempts: over.attempts ?? 0,
    budgetHits: over.budgetHits ?? 0,
    exhausted: over.exhausted ?? new Map(),
    phase: over.phase ?? 'SEEDS',
    planItem: over.planItem ?? `fix ${first}${more > 0 ? `, +${more} more` : ''} in ${suspectedFiles[0] ?? 'the workspace'}`,
  };
  if (over.parkedReason !== undefined) goal.parkedReason = over.parkedReason;
  return goal;
}

export const GCD_SRC = 'def gcd(a, b):\n    if b == 0:\n        return a\n    else:\n        return gcd(a % b, b)\n';

/** The gcd fix as an AppliedCandidate (one file, line 5). */
export function gcdApplied(path = 'src/gcd.py'): AppliedCandidate {
  const file = sourceFile(path, GCD_SRC);
  const s = site(file, 5);
  const c = { ...candidate(s, 'return gcd(b, a % b)'), source: 'mutation' as const, op: 'arg_swap' };
  return applyCandidate(c);
}

/** A candidate whose extraEdits touch a second file (the composite signature + call-site unit). */
export function twoFileApplied(): AppliedCandidate {
  const a = sourceFile('src/a.py', 'def f(x):\n    return x\n');
  const b = sourceFile('src/b.py', 'from a import f\nprint(f(1))\n');
  const s = site(a, 1);
  const c = { ...candidate(s, 'def f(x, y=0):', [{ path: 'src/b.py', line: 2, kind: 'replace' as const, text: 'print(f(1, y=2))' }]), source: 'composite' as const, op: 'add_parameter_default' };
  return applyCandidate(c, new Map([[a.path, a], [b.path, b]]));
}

export function makeTrace(over: Partial<GoalSearchTrace> & { goalId: string }): GoalSearchTrace {
  const bySource: GoalSearchTrace['bySource'] = {
    mutation: { enumerated: 120, tested: 120, passed: 1 },
    template: { enumerated: 0, tested: 0, passed: 0 },
    donor: { enumerated: 0, tested: 0, passed: 0 },
    token_beam: { enumerated: 0, tested: 0, passed: 0 },
    test_value: { enumerated: 0, tested: 0, passed: 0 },
    history: { enumerated: 0, tested: 0, passed: 0 },
    composite: { enumerated: 0, tested: 0, passed: 0 },
  };
  return {
    sitesConsidered: 3,
    candidatesEnumerated: 120,
    candidatesRanked: 0,
    candidatesTested: 120,
    jevRequests: 2,
    testRuns: 121,
    bySource,
    outcome: 'fixed',
    phase: 'SEEDS',
    runMode: 'SIEVE',
    plausible: 1,
    clusters: 1,
    arbitrated: false,
    tRunMs: 240,
    sitesTested: 3,
    newSitesTested: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------
// Window entries as the engine writes them
// ---------------------------------------------------------------------------------------

export function runEntry(over: { step: number; command?: string; passed?: number; failed?: number; errors?: number; outcome?: OutcomeStatus; parsed?: boolean }): WindowEntry {
  const command = over.command ?? TEST_COMMAND;
  const passed = over.passed ?? 0;
  const failed = over.failed ?? 0;
  const errors = over.errors ?? 0;
  const parsed = over.parsed ?? true;
  const judge: JudgeResult = {
    succeeded: 0.9,
    errorPresent: failed + errors > 0 ? 0.9 : 0.1,
    newInfo: 0.1,
    tests: parsed ? { source: 'parsed', allPassed: failed === 0 && errors === 0 && passed > 0, passed, failed, errors } : { source: 'judged', allPassed: 0.5 },
    doneClaims: [],
  };
  return { step: over.step, intent: 'verify', action: `run ${command}`, outcome: over.outcome ?? 'executed', judge, shownFiles: [], notes: [] };
}

export function patchEntry(over: { step: number; paths?: string[]; outcome?: OutcomeStatus; reason?: string }): WindowEntry {
  const paths = over.paths ?? ['src/gcd.py'];
  const e: WindowEntry = { step: over.step, intent: 'edit', action: paths.length > 0 ? `patch ${paths.join(' ')}` : 'patch', outcome: over.outcome ?? 'executed', shownFiles: [], notes: [] };
  if (over.reason !== undefined) e.reason = over.reason;
  return e;
}

// ---------------------------------------------------------------------------------------
// SynthesisContext with fakes
// ---------------------------------------------------------------------------------------

export interface CtxOptions {
  window?: WindowEntry[];
  /** the engine's effective intent for the step (default 'edit') */
  intent?: Intent;
  plan?: Partial<Plan>;
  directive?: string | null;
  contextFiles?: FileView[];
  testCommand?: TestCommand | null;
  /** workspace listing (paths) for the repository / single-file decision */
  files?: string[];
  step?: number;
}

function notUsed(what: string): never {
  throw new Error(`${what} is not used by the proposal builders`);
}

export function fakeWorkspace(files: readonly string[]): Workspace {
  const listing: WorkspaceCandidate[] = files.map((path) => ({ path, bytes: 100 }));
  return {
    root: '/work',
    info: () => notUsed('workspace.info'),
    listCandidates: async () => listing,
    invalidateCandidates: async () => undefined,
    noteChanged: async () => undefined,
    read: () => notUsed('workspace.read'),
    applyEdit: () => notUsed('workspace.applyEdit'),
    writeFile: () => notUsed('workspace.writeFile'),
    applyPatch: () => notUsed('workspace.applyPatch'),
    parseTestOutput: () => null,
    changedFiles: async () => [],
    target: () => notUsed('workspace.target'),
  };
}

export const fakeSandbox: Sandbox = {
  level: 'none',
  run: () => notUsed('sandbox.run'),
  killAll: async () => undefined,
};

export function fileView(path: string, content = '# shown\n'): FileView {
  return { path, content, bytes: content.length, truncatedBytes: 0 };
}

export function makeCtx(o: CtxOptions = {}): SynthesisContext & { events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  const testCommand = o.testCommand === undefined ? { command: TEST_COMMAND, runner: 'pytest' as const } : o.testCommand;
  const info: WorkspaceInfo = { root: '/work', git: true, hasTests: testCommand !== null, testCommand };
  const plan: Plan = { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [], ...o.plan };
  return {
    runId: 'run-test',
    runDir: '/runs/run-test',
    step: o.step ?? 3,
    task: 'fix the failing tests',
    plan,
    window: o.window ?? [],
    intent: o.intent ?? 'edit',
    contextFiles: o.contextFiles ?? [],
    workspace: fakeWorkspace(o.files ?? ['src/gcd.py', 'tests/test_gcd.py']),
    workspaceInfo: info,
    sandbox: fakeSandbox,
    decider: { model: 'fake', provider: 'openrouter', ask: () => notUsed('decider.ask') },
    signal: new AbortController().signal,
    limits: { maxSteps: 40, maxWallMs: 3_600_000, maxReplans: 5, completeThreshold: 0.85, impossibleThreshold: 0.9, commandTimeoutMs: 120_000, maxCommandTimeoutMs: 600_000, maxOutputBytes: 200_000, spendCapUsd: 1 },
    redact: (s) => s,
    emit: (e) => {
      events.push(e);
    },
    ask: () => notUsed('ctx.ask'),
    createdThisRun: new Set(),
    directive: o.directive ?? null,
    synthState: null,
    setSynthState: () => undefined,
    events,
  };
}

// ---------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------

export function makeMemory(over: Partial<DirectiveMemory> = {}): DirectiveMemory {
  const overrides: SearchOverrides = over.overrides ?? defaultOverrides();
  const mem: DirectiveMemory = {
    baseline: over.baseline === undefined ? summary({ command: TEST_COMMAND, failing: ['tests/test_gcd.py::test_gcd'], passing: ['tests/test_gcd.py::test_other'] }) : over.baseline,
    goals: over.goals ?? [],
    committed: over.committed ?? [],
    localizeCache: over.localizeCache ?? new Map<string, LocalizeResult>(),
    overrides,
  };
  if (over.guardPending !== undefined) mem.guardPending = over.guardPending;
  if (over.committedDiffHashes !== undefined) mem.committedDiffHashes = over.committedDiffHashes;
  return mem;
}

/** A LocalizeResult whose sites live in `paths` (only the file paths matter to the directives). */
export function cachedLocalize(paths: readonly string[]): LocalizeResult {
  const sites = paths.map((p) => site(sourceFile(p, 'x = 1\n'), 1));
  return { files: [], functions: [], sites, requests: 0 };
}
