/** Fake sandbox, Goal/Base/VerifyJob builders and a run_tests.py-shaped fake for the sieve unit tests. */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExecResult, Sandbox, SandboxRunOptions } from '../../../../src/core/types.js';
import { shellWords } from '../../../../src/synth/search/budget.js';
import type { Base, Goal, OracleModel, StepBudget, VerifyJob } from '../../../../src/synth/search/types.js';
import type { Candidate, SourceFile, TestRunSummary } from '../../../../src/synth/types.js';
import { summary as verifySummary } from '../verify/helpers.js';

export { candidate, GCD_BUGGY, site, sourceFile } from '../verify/helpers.js';

/** The verify helper's summary, plus `command` (that helper pins it to `pytest -q`; the runner reads the command). */
export function summary(over: Partial<TestRunSummary> & { failing?: string[]; passing?: string[] }): TestRunSummary {
  return { ...verifySummary(over), command: over.command ?? 'pytest -q' };
}

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '../../../..');
export const QUIXBUGS_DIR = join(REPO_ROOT, 'bench/data/quixbugs');
export const GCD_CORRECT = readFileSync(join(QUIXBUGS_DIR, 'correct/gcd.py'), 'utf8');

export function execResult(over: Partial<ExecResult> = {}): ExecResult {
  const exitCode = over.exitCode ?? 0;
  const killedBy = over.killedBy ?? null;
  return {
    ok: over.ok ?? (exitCode === 0 && killedBy === null),
    exitCode,
    signal: null,
    stdout: over.stdout ?? '',
    stderr: over.stderr ?? '',
    truncated: false,
    bytesSeen: 0,
    killedBy,
    timedOut: over.timedOut ?? killedBy === 'timeout',
    orphans: [],
    sandboxExecDenied: false,
    durationMs: over.durationMs ?? 3,
  };
}

export interface RecordedCall {
  command: string;
  cwd: string | undefined;
  timeoutMs: number;
  env?: Record<string, string>;
}

export type Script = (command: string, opts: SandboxRunOptions) => Partial<ExecResult> | Promise<Partial<ExecResult>>;

/**
 * A Sandbox whose `run` records every call and answers from `script`. Directory-creating
 * commands (`mkdir -p`, `git worktree add`) really create the directory so the lanes' node:fs
 * writes have somewhere to land; everything else is whatever the script says (default: ok).
 */
export function fakeSandbox(script: Script = () => ({})): Sandbox & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    level: 'none',
    calls,
    async run(command: string, opts: SandboxRunOptions): Promise<ExecResult> {
      calls.push({ command, cwd: opts.cwd, timeoutMs: opts.timeoutMs, ...(opts.env === undefined ? {} : { env: opts.env }) });
      const words = shellWords(command);
      if (words[0] === 'mkdir' && words[1] === '-p' && words[2] !== undefined) mkdirSync(words[2], { recursive: true });
      if (words[0] === 'git' && words[1] === 'worktree' && words[2] === 'add' && words[4] !== undefined) mkdirSync(words[4], { recursive: true });
      return execResult(await script(command, opts));
    },
    async killAll(): Promise<void> {},
  };
}

export function oracle(over: Partial<OracleModel> = {}): OracleModel {
  return {
    runner: 'quixbugs',
    lanes: 8,
    tRunMs: { goalSubset: 300, fullSuite: 300 },
    perTestTimeoutMs: 2000,
    runTimeoutMs: 10_000,
    baselineDurationMs: 300,
    ...over,
  };
}

export function budget(over: Partial<Omit<StepBudget, 'exhausted'>> = {}): StepBudget {
  const b: StepBudget = {
    jevRequestsLeft: 30,
    testRunsLeft: 1500,
    testWallLeftMs: 90_000,
    startedMs: 0,
    recursed: false,
    exhausted: () => b.testRunsLeft <= 0 || b.testWallLeftMs <= 0 || b.jevRequestsLeft <= 0,
    ...over,
  };
  return b;
}

export function goal(tests: string[], over: Partial<Goal> = {}): Goal {
  return {
    id: 'g1',
    tests,
    failures: tests.map((t) => ({ testId: t, call: t, expected: '1', actual: '0' })),
    suspectedFiles: ['gcd.py'],
    status: 'active',
    attempts: 0,
    budgetHits: 0,
    exhausted: new Map(),
    phase: 'SEEDS',
    planItem: `fix ${tests[0] ?? '?'} in gcd.py`,
    ...over,
  };
}

export function base(files: SourceFile[], s: TestRunSummary, over: Partial<Base> = {}): Base {
  return { id: 'b0', origin: 'committed', fromGoal: null, files: new Map(files.map((f) => [f.path, f])), summary: s, depth: 0, ...over };
}

export function job(c: Candidate, b: Base, p = 0.5): VerifyJob {
  return { candidate: c, base: b, p, sourcePrior: 0.5, key: [b.summary.passed, p, 0.5] };
}

/** A minimal VerifyQueue: FIFO `pop(n)` (the shape of sieve/queue.ts's VerifyQueue the runner consumes). */
export function fifoQueue(jobs: VerifyJob[]): { size: number; pop(n: number): VerifyJob[]; items: VerifyJob[] } {
  const items = [...jobs];
  return {
    items,
    get size() {
      return items.length;
    },
    pop: (n) => items.splice(0, n),
  };
}

// ---------------------------------------------------------------------------------------
// run_tests.py-shaped fakes
// ---------------------------------------------------------------------------------------

export const GCD_TESTS = ['gcd(13, 13)', 'gcd(37, 600)', 'gcd(20, 100)', 'gcd(624129, 2061517)', 'gcd(3, 12)'];

/** The runner's JSON line for `gcd` with the given failing inputs (of the 6-case suite). */
export function runTestsJson(failingInputs: number[][], over: { passedOverride?: number; timeouts?: number } = {}): string {
  const failed = failingInputs.length;
  const passed = over.passedOverride ?? 6 - failed;
  return JSON.stringify({
    name: 'gcd',
    passed,
    failed: 0,
    errors: failed,
    timeouts: over.timeouts ?? 0,
    skipped: 0,
    total: passed + failed,
    failures: failingInputs.map((input) => ({ input, expected: 1, actual: 'RecursionError: maximum recursion depth exceeded' })),
  });
}

export const GCD_BUGGY_INPUTS = [
  [13, 13],
  [37, 600],
  [20, 100],
  [624129, 2061517],
  [3, 12],
];

export const GCD_BASELINE: TestRunSummary = summary({
  command: `PYTHONDONTWRITEBYTECODE=1 python3 '${QUIXBUGS_DIR}/run_tests.py' 'gcd' 'gcd.py' --max-failures 1000`,
  passed: 1,
  failing: GCD_TESTS,
  errors: 5,
  failed: 0,
  total: 6,
  durationMs: 300,
  exitCode: 1,
});
