/**
 * bench/data/quixbugs/run_tests.py JSON → TestRunSummary. The runner prints one JSON line
 * `{name, passed, failed, errors, timeouts, skipped, total, failures:[{input, expected, actual}]}`
 * and exits 0 iff nothing failed. Test ids are derived from the inputs (`gcd(13, 13)`), since
 * the runner has no node ids; passing ids are not available (only the count), which progress()
 * accounts for. The runner caps `failures` at --max-failures (default 5): use
 * `quixbugsTestCommand()` so the cap never hides a failing test from the id sets.
 */
import { isFiniteNumber, isJsonArray, isJsonObject, isString, parseJson } from '../../core/json.js';
import type { Json } from '../../core/types.js';
import type { FailureView, TestRunSummary } from '../types.js';
import { bound, shellQuote, tail, VALUE_BOUND } from './text.js';

export interface RunTestsFailure {
  input: Json;
  expected: Json;
  actual: string;
}

export interface RunTestsReport {
  name: string;
  passed: number;
  failed: number;
  errors: number;
  timeouts: number;
  skipped: number;
  total: number;
  failures: RunTestsFailure[];
}

/** Large enough that no QuixBugs program (≤ 20 cases) ever hits the cap. */
export const QUIXBUGS_MAX_FAILURES = 1000;

/**
 * Environment knobs of the bench's generated pytest module (src/bench/quixbugs/pytest.ts), set
 * by the sieve runner on its shadow lanes only: the per-case limit in milliseconds (the module's
 * default is 2 s, the same as run_tests.py's --timeout) and the number of case timeouts after
 * which the remaining cases of a run are reported "not run" instead of being called.
 */
export const CASE_TIMEOUT_ENV = 'JEVCODE_CASE_TIMEOUT_MS';
export const MAX_CASE_TIMEOUTS_ENV = 'JEVCODE_MAX_CASE_TIMEOUTS';

/**
 * What a per-case timeout leaves in a failure's `actual`: run_tests.py's "TIMEOUT after 2s", the
 * generated module's "test_x.CaseTimeout: no result after 2s", the design's "Timeout: the
 * program did not finish within N seconds" (docs/JEV-ONLY-DESIGN.md §4.1). The captured group
 * is the limit the case ran under, in seconds.
 */
export const CASE_TIMEOUT_PATTERN = /\bTIMEOUT after (\d+(?:\.\d+)?)s\b|\bCaseTimeout\b[^\n]*?\bno result after (\d+(?:\.\d+)?)s|\bTimeout: the program did not finish within (\d+(?:\.\d+)?) seconds/;
/** A case the generated module's stop rule did not call ("CaseNotRun: not run: 1 earlier case(s) timed out"). */
export const CASE_NOT_RUN_PATTERN = /\bCaseNotRun\b|\bnot run: \d+ earlier case\(s\) timed out/;

export function isCaseTimeout(actual: string): boolean {
  return CASE_TIMEOUT_PATTERN.test(actual);
}

export function isCaseNotRun(actual: string): boolean {
  return CASE_NOT_RUN_PATTERN.test(actual);
}

/** The per-case limit (ms) a timed-out case ran under, read from its failure text; null when the text is not a case timeout. */
export function caseTimeoutLimitMs(actual: string): number | null {
  const m = CASE_TIMEOUT_PATTERN.exec(actual);
  if (m === null) return null;
  const sec = Number(m[1] ?? m[2] ?? m[3]);
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null;
}

export interface CaseTimeoutCounts {
  /** failures that hit the per-case limit */
  timeouts: number;
  /** failures the stop rule did not run */
  notRun: number;
  /** the limit the timed-out cases ran under (ms; the largest seen), null when none is readable */
  limitMs: number | null;
}

/** Count the per-case timeouts (and stop-rule skips) among a run's failures. */
export function countCaseTimeouts(summary: Pick<TestRunSummary, 'failures'>): CaseTimeoutCounts {
  let timeouts = 0;
  let notRun = 0;
  let limitMs: number | null = null;
  for (const f of summary.failures) {
    if (isCaseTimeout(f.actual)) {
      timeouts += 1;
      const l = caseTimeoutLimitMs(f.actual);
      if (l !== null && (limitMs === null || l > limitMs)) limitMs = l;
    } else if (isCaseNotRun(f.actual)) {
      notRun += 1;
    }
  }
  return { timeouts, notRun, limitMs };
}

/**
 * The run hangs: at least one case hit the per-case limit and every failure is such a timeout
 * (or a case the stop rule did not run after one). §4.1: a probable infinite loop, classified
 * `timeout` by the sieve runner whatever the sandbox's own timeout did.
 */
export function hangsOnEveryFailure(summary: Pick<TestRunSummary, 'failures'>): boolean {
  if (summary.failures.length === 0) return false;
  const c = countCaseTimeouts(summary);
  return c.timeouts > 0 && c.timeouts + c.notRun === summary.failures.length;
}

/** The runner command with the failure cap lifted; `candidatePath` is the file under repair. */
export function quixbugsTestCommand(quixbugsDir: string, name: string, candidatePath: string, opts: { timeoutSec?: number; slow?: boolean } = {}): string {
  const parts = ['PYTHONDONTWRITEBYTECODE=1', 'python3', shellQuote(`${quixbugsDir}/run_tests.py`), shellQuote(name), shellQuote(candidatePath), '--max-failures', String(QUIXBUGS_MAX_FAILURES)];
  if (opts.timeoutSec !== undefined) parts.push('--timeout', String(opts.timeoutSec));
  if (opts.slow === true) parts.push('--slow');
  return parts.join(' ');
}

/** The last `{...}` line of stdout with the counts; `{error}` for the runner's own error line; null otherwise. */
export function parseRunTestsJson(stdout: string): RunTestsReport | { error: string } | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'));
  for (const line of lines.reverse()) {
    const parsed = parseJson(line);
    if (!parsed.ok || !isJsonObject(parsed.value)) continue;
    const o = parsed.value;
    const err = o['error'];
    if (isString(err)) return { error: err };
    const nums = ['passed', 'failed', 'errors', 'timeouts', 'skipped', 'total'] as const;
    const values: number[] = [];
    for (const k of nums) {
      const v = o[k];
      if (!isFiniteNumber(v)) break;
      values.push(v);
    }
    if (values.length !== nums.length) continue;
    const failures: RunTestsFailure[] = [];
    const raw = o['failures'];
    if (isJsonArray(raw)) {
      for (const f of raw) {
        if (!isJsonObject(f)) continue;
        const actual = f['actual'];
        failures.push({ input: f['input'] ?? null, expected: f['expected'] ?? null, actual: isString(actual) ? actual : JSON.stringify(actual ?? null) });
      }
    }
    const name = o['name'];
    return {
      name: isString(name) ? name : '',
      passed: values[0] ?? 0,
      failed: values[1] ?? 0,
      errors: values[2] ?? 0,
      timeouts: values[3] ?? 0,
      skipped: values[4] ?? 0,
      total: values[5] ?? 0,
      failures,
    };
  }
  return null;
}

/** `gcd(13, 13)` for JSON-tested programs; the runner's label ("test3: Case 3 ...") for module tests. */
export function quixbugsTestId(name: string, input: Json): string {
  if (isJsonArray(input)) return bound(`${name}(${input.map((v) => JSON.stringify(v)).join(', ')})`, VALUE_BOUND);
  if (isString(input)) return bound(input, VALUE_BOUND);
  return bound(`${name}(${JSON.stringify(input)})`, VALUE_BOUND);
}

export interface RunTestsSummaryContext {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

export function summaryFromRunTests(report: RunTestsReport, ctx: RunTestsSummaryContext): TestRunSummary {
  const failures: FailureView[] = report.failures.map((f) => {
    const id = quixbugsTestId(report.name, f.input);
    return { testId: id, call: id, expected: bound(isString(f.expected) ? f.expected : JSON.stringify(f.expected), VALUE_BOUND), actual: bound(f.actual, VALUE_BOUND) };
  });
  return {
    command: ctx.command,
    passed: report.passed,
    failed: report.failed,
    // the runner already folds timeouts into errors
    errors: report.errors,
    skipped: report.skipped,
    total: report.total,
    failing: failures.map((f) => f.testId),
    passing: [],
    failures,
    exitCode: ctx.exitCode,
    timedOut: ctx.timedOut,
    durationMs: ctx.durationMs,
    outputTail: tail(ctx.outputTail),
  };
}
