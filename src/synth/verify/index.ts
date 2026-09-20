/**
 * Test oracle and progress for the Jev-only synthesizer (docs/JEV-ONLY.md; measurements in
 * experiments/results/probe-progress-judgment.md). Tests are the oracle: `runTests` turns a
 * runner's output into numbers and ids, `progress` and `route` decide in code, `applyCandidate`
 * is pure text, and the Jev questions here are consistency checks and heuristics only.
 */
import type { Json, Question, Sandbox, StageName, TestCommand } from '../../core/types.js';
import { scopeBuilderFor } from '../../workspace/tests.js';
import type { AppliedCandidate, Candidate, FailureView, JevAsk, Move, Progress, SourceFile, TestRunSummary } from '../types.js';
import { applyCandidate } from './apply.js';
import { progress, route } from './progress.js';
import { looksLikePytest, parsePytestOutput, summaryFromPytest } from './pytest.js';
import { judgeProgress, pickNextFailingTest, progressQuestions, progressState } from './questions.js';
import { parseRunTestsJson, summaryFromRunTests } from './quixbugs.js';
import { looksLikeSympy, looksLikeUnittest, parseSympyOutput, parseUnittestOutput, summaryFromSympy, summaryFromUnittest } from './runners.js';
import { RUN_FAILURE_ID, shellQuote, tail } from './text.js';
import type { PickedTest, PickOptions, ProgressJudgment, RunTestsOptions, SearchState, TestOutputFormat, VerifierDeps, VerifyRunFn, VerifyRunResult } from './types.js';

export { applyCandidate, indentedText } from './apply.js';
export { keepsCandidate, progress, REGRESSION_RULE, route } from './progress.js';
export { extractExpectation, looksLikePytest, parsePytestOutput, sectionFor, sectionNameOf, splitComparison, summaryFromPytest } from './pytest.js';
export type { PytestCounts, PytestParse, PytestSection, PytestStatus, PytestSummaryContext } from './pytest.js';
export {
  codeVerdicts,
  DEFAULT_PICK_MAX,
  DEFAULT_TIE_MARGIN,
  expectedLevel,
  failureStatus,
  inputSize,
  judgeProgress,
  optionKeyFor,
  pickNextFailingTest,
  pickQuestion,
  progressQuestions,
  progressState,
  STATE_FAILURES_BOUND,
  UNSURE_HIGH,
  UNSURE_LOW,
} from './questions.js';
export type { PickBatch, ProgressQuestionId, ProgressStateOptions } from './questions.js';
export { parseRunTestsJson, QUIXBUGS_MAX_FAILURES, quixbugsTestCommand, quixbugsTestId, summaryFromRunTests } from './quixbugs.js';
export type { RunTestsFailure, RunTestsReport, RunTestsSummaryContext } from './quixbugs.js';
export { expectationFromTraceback, isTestFile, looksLikeSympy, looksLikeUnittest, parseSympyOutput, parseUnittestOutput, RELATED_TESTS_MAX, relatedTestFiles, summaryFromSympy, summaryFromUnittest, unittestLabelOf } from './runners.js';
export type { RelatedTestsOptions, RunnerSummaryContext, SympyCounts, SympyParse, SympyStatus, UnittestCounts, UnittestParse, UnittestStatus } from './runners.js';
export { OUTPUT_TAIL_BOUND, RUN_FAILURE_ID, VALUE_BOUND } from './text.js';
export { VerifyError } from './types.js';
export type { PickedTest, PickOptions, ProgressJudgment, RunTestsOptions, SearchState, TestOutputFormat, VerifierDeps, VerifyRunFn, VerifyRunOptions, VerifyRunResult } from './types.js';

export const DEFAULT_TEST_TIMEOUT_MS = 120_000;
export const DEFAULT_TEST_OUTPUT_BYTES = 256 * 1024;

export interface Verifier {
  /** Run `command` (optionally restricted to `files`, appended shell-quoted) and summarise its output. */
  runTests(command: string, files?: readonly string[], opts?: RunTestsOptions): Promise<TestRunSummary>;
  progress(before: TestRunSummary, after: TestRunSummary): Progress;
  applyCandidate(candidate: Candidate, files?: ReadonlyMap<string, SourceFile>): AppliedCandidate;
  route(progress: Progress, search: SearchState): Move;
  progressQuestions(progress: Progress): Record<string, Question>;
  progressState(progress: Progress, opts?: { subject?: string }): Json;
  judgeProgress(progress: Progress, ask: JevAsk, opts?: { subject?: string; stage?: StageName }): Promise<ProgressJudgment>;
  pickNextFailingTest(failures: readonly FailureView[], ask: JevAsk, opts?: PickOptions & { stage?: StageName }): Promise<PickedTest>;
}

/**
 * Which parser the output is for: the runner's JSON line wins, then anything pytest-shaped, then
 * unittest's TextTestRunner (Django's runtests.py prints it), then sympy's bin/test.
 */
export function detectFormat(stdout: string, combined: string): TestOutputFormat {
  if (parseRunTestsJson(stdout) !== null) return 'quixbugs_json';
  if (looksLikePytest(parsePytestOutput(combined))) return 'pytest';
  if (looksLikeUnittest(parseUnittestOutput(combined))) return 'unittest';
  if (looksLikeSympy(parseSympyOutput(combined))) return 'sympy_bintest';
  return 'unknown';
}

/**
 * The detected command restricted to `targets` (test file paths, node ids or runner labels):
 * the command's own `scope` builder when detection attached one, else the builder for its runner
 * (src/workspace/tests.ts: pytest appends paths / node ids, Django's runtests.py takes dotted
 * labels derived from `tests/<app>/tests.py`, sympy's bin/test takes paths and `-k` names,
 * unittest takes module names), else the paths appended shell-quoted. No targets: the full command.
 */
export function scopedTestCommand(info: TestCommand, targets: readonly string[]): string {
  if (targets.length === 0) return info.command;
  if (info.scope !== undefined) return info.scope(targets);
  const builder = scopeBuilderFor(info.runner, info.command);
  return builder === null ? `${info.command} ${targets.map(shellQuote).join(' ')}` : builder(targets);
}

/**
 * ExecResult-like → TestRunSummary. Exported so bench evaluators and tests can summarise saved
 * output without a runner. A killed or result-less run gets a synthetic `<test run>` failure so
 * that progress() sees it as failing (and, if the baseline also had it, as unchanged).
 */
export function summarize(command: string, res: VerifyRunResult, durationMs: number): TestRunSummary {
  const stderr = res.stderr ?? '';
  const combined = stderr === '' ? res.stdout : `${res.stdout}\n${stderr}`;
  const timedOut = res.timedOut ?? res.killedBy === 'timeout';
  const ctx = { command, exitCode: res.exitCode, timedOut, durationMs, outputTail: tail(combined) };
  const format = detectFormat(res.stdout, combined);
  let summary: TestRunSummary;
  if (format === 'quixbugs_json') {
    const report = parseRunTestsJson(res.stdout);
    if (report !== null && !('error' in report)) summary = summaryFromRunTests(report, ctx);
    else summary = { command, passed: 0, failed: 0, errors: 0, skipped: 0, total: 0, failing: [], passing: [], failures: [], exitCode: res.exitCode, timedOut, durationMs, outputTail: ctx.outputTail };
    if (report !== null && 'error' in report) summary = withRunFailure(summary, `run_tests.py: ${report.error}`);
  } else if (format === 'pytest') {
    summary = summaryFromPytest(parsePytestOutput(combined), ctx);
  } else if (format === 'unittest') {
    summary = summaryFromUnittest(parseUnittestOutput(combined), ctx);
  } else if (format === 'sympy_bintest') {
    summary = summaryFromSympy(parseSympyOutput(combined), ctx);
  } else {
    summary = { command, passed: 0, failed: 0, errors: 0, skipped: 0, total: 0, failing: [], passing: [], failures: [], exitCode: res.exitCode, timedOut, durationMs, outputTail: ctx.outputTail };
  }
  if (timedOut) return withRunFailure(summary, `timeout after ${Math.round(durationMs / 100) / 10} s`);
  // The runner's exit status is part of the oracle (pytest, run_tests.py, unittest / Django's
  // runtests.py and sympy's bin/test all exit 0 iff nothing failed). A non-zero exit with no parsed
  // failure means the output was truncated, the run crashed or the format was not recognised; it
  // must never read as a pass. Exit 5 is pytest's "no tests collected": nothing failed, nothing
  // ran; the summary already says total 0.
  if (res.exitCode !== 0 && res.exitCode !== 5 && summary.failed + summary.errors === 0) {
    const lastLine = combined.trim().split('\n').pop() ?? '';
    const why = format === 'unknown' ? '' : ' with no failing test in the parsed output (truncated or crashed run)';
    return withRunFailure(summary, `exit ${res.exitCode ?? 'null'}${why}: ${lastLine}`.trim());
  }
  return summary;
}

function withRunFailure(s: TestRunSummary, actual: string): TestRunSummary {
  if (s.failing.includes(RUN_FAILURE_ID)) return s;
  const failure: FailureView = { testId: RUN_FAILURE_ID, call: s.command, expected: 'the test run completes and reports its results', actual };
  return { ...s, errors: s.errors + 1, total: s.total + 1, failing: [...s.failing, RUN_FAILURE_ID], failures: [...s.failures, failure] };
}

/** The engine's Sandbox as a VerifyRunFn (production wiring; unit tests script `run` directly). */
export function sandboxRunFn(sandbox: Sandbox, signal: AbortSignal): VerifyRunFn {
  return async (command, opts) => {
    const res = await sandbox.run(command, opts.cwd === undefined ? { timeoutMs: opts.timeoutMs, maxOutputBytes: opts.maxOutputBytes, signal } : { timeoutMs: opts.timeoutMs, maxOutputBytes: opts.maxOutputBytes, signal, cwd: opts.cwd });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode, timedOut: res.timedOut, killedBy: res.killedBy, durationMs: res.durationMs };
  };
}

export function createVerifier(deps: VerifierDeps): Verifier {
  const runTests = async (command: string, files?: readonly string[], opts: RunTestsOptions = {}): Promise<TestRunSummary> => {
    const cmd = files !== undefined && files.length > 0 ? `${command} ${files.map(shellQuote).join(' ')}` : command;
    const cwd = opts.cwd ?? deps.cwd;
    const runOpts = { timeoutMs: opts.timeoutMs ?? deps.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS, maxOutputBytes: opts.maxOutputBytes ?? deps.maxOutputBytes ?? DEFAULT_TEST_OUTPUT_BYTES };
    const started = Date.now();
    const res = await deps.run(cmd, cwd === undefined ? runOpts : { ...runOpts, cwd });
    return summarize(cmd, res, res.durationMs ?? Date.now() - started);
  };
  return { runTests, progress, applyCandidate, route, progressQuestions, progressState, judgeProgress, pickNextFailingTest };
}
