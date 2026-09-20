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
