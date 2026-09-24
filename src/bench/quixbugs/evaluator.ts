/**
 * QuixBugs evaluator: runs bench/data/quixbugs/run_tests.py (stdlib only, per-case subprocess
 * timeouts) on the workspace's `<name>.py` through the sandbox runner and parses its one JSON
 * line. Tests are the only oracle (docs/JEV-ONLY.md). Used for live and mocked benches alike,
 * so a mocked bench is a real end-to-end check of the pipeline.
 */
import { join } from 'node:path';
import { isFiniteNumber, isJsonArray, isJsonObject, isString, parseJson } from '../../core/json.js';
import type { Json } from '../../core/types.js';
import { shellQuote, tail } from '../swebench/evaluator.js';
import type { CommandRunner, Evaluation } from '../types.js';
import { RUN_TESTS_FILE } from './tasks.js';

export const EVAL_TIMEOUT_MS = 120_000;
const EVAL_OUTPUT_BYTES = 256 * 1024;

export interface RunTestsFailure {
  input: string;
  expected: string;
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

function short(v: Json | undefined, max = 80): string {
  const s = v === undefined ? '' : isString(v) ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The last `{...}` line of stdout; null when there is none or it lacks the counts. */
export function parseRunTestsOutput(stdout: string): RunTestsReport | { error: string } | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (const line of lines.reverse()) {
    const parsed = parseJson(line);
    if (!parsed.ok || !isJsonObject(parsed.value)) continue;
    const o = parsed.value;
    const err = o['error'];
    if (isString(err)) return { error: err };
    const nums = ['passed', 'failed', 'errors', 'timeouts', 'skipped', 'total'] as const;
    if (!nums.every((k) => isFiniteNumber(o[k]))) continue;
    const failuresJson = o['failures'];
    const failures: RunTestsFailure[] = [];
    if (isJsonArray(failuresJson)) {
      for (const f of failuresJson) {
        if (!isJsonObject(f)) continue;
        failures.push({ input: short(f['input']), expected: short(f['expected']), actual: short(f['actual'], 160) });
      }
    }
    const name = o['name'];
    return {
      name: isString(name) ? name : '',
      passed: o['passed'] as number,
      failed: o['failed'] as number,
      errors: o['errors'] as number,
      timeouts: o['timeouts'] as number,
      skipped: o['skipped'] as number,
      total: o['total'] as number,
      failures,
    };
  }
  return null;
}

/** `passed 1/6, failed 0, errors 5 (timeouts 0), skipped 0; first failure: ...` */
export function describeReport(r: RunTestsReport): string {
  const head = `passed ${r.passed}/${r.total}, failed ${r.failed}, errors ${r.errors} (timeouts ${r.timeouts}), skipped ${r.skipped}`;
  const f = r.failures[0];
  return f ? `${head}; first failure: input ${f.input} expected ${f.expected} actual ${f.actual}` : head;
}

/** pass iff exit 0 and failed == 0 and errors == 0 and passed > 0 (run_tests.py's own rule plus "something ran"). */
export function verdict(exitCode: number | null, r: RunTestsReport): boolean {
  return exitCode === 0 && r.failed === 0 && r.errors === 0 && r.passed > 0;
}

export function runTestsCommand(quixbugsDir: string, name: string, candidatePath: string): string {
  return `PYTHONDONTWRITEBYTECODE=1 python3 ${shellQuote(join(quixbugsDir, RUN_TESTS_FILE))} ${shellQuote(name)} ${shellQuote(candidatePath)}`;
}

export interface EvaluateQuixbugsOptions {
  quixbugsDir: string;
  name: string;
  workspaceDir: string;
  /** cwd = workspace */
  run: CommandRunner;
  timeoutMs?: number;
}

export async function evaluateQuixbugs(o: EvaluateQuixbugsOptions): Promise<Evaluation> {
  const candidate = join(o.workspaceDir, `${o.name}.py`);
  const res = await o.run(runTestsCommand(o.quixbugsDir, o.name, candidate), { timeoutMs: o.timeoutMs ?? EVAL_TIMEOUT_MS, maxOutputBytes: EVAL_OUTPUT_BYTES });
  if (res.killedBy !== null) return { pass: null, evaluator: 'none', reason: `run_tests.py killed: ${res.killedBy}`, evalExitCode: res.exitCode };
  const report = parseRunTestsOutput(res.stdout);
  if (report === null) return { pass: null, evaluator: 'none', reason: `run_tests.py produced no report (exit ${res.exitCode ?? 'null'}): ${tail(res, 300)}`, evalExitCode: res.exitCode };
  if ('error' in report) return { pass: null, evaluator: 'none', reason: `run_tests.py: ${report.error}`, evalExitCode: res.exitCode };
  const pass = verdict(res.exitCode, report);
  const out: Evaluation = { pass, evaluator: 'local', evalExitCode: res.exitCode };
  if (!pass) out.reason = `run_tests: ${describeReport(report)}`;
  return out;
}
