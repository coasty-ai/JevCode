/**
 * Ladder evaluator: `<python> -m pytest tests` in the agent workspace through the sandbox
 * runner, pass iff exit 0 with no failed/error and at least one passed test, and tests/
 * untouched (`git status --porcelain -- tests/` empty: the README's grading rule). Tests are
 * the only oracle; live and mocked benches evaluate the same way.
 */
import type { TestCounts } from '../../core/types.js';
import { parsePytest } from '../../workspace/tests.js';
import { shellQuote, tail } from '../swebench/evaluator.js';
import type { CommandRunner, Evaluation } from '../types.js';

export const LADDER_EVAL_TIMEOUT_MS = 120_000;
const EVAL_OUTPUT_BYTES = 256 * 1024;

/**
 * No `-q` here: the tasks' own pytest.ini already carries `-q`, and `-qq` drops the summary
 * line the parser reads; both the `-q` form and the `=== N passed ===` form parse.
 */
export function pytestCommand(python: string): string {
  return `PYTHONDONTWRITEBYTECODE=1 ${python === 'python3' ? 'python3' : shellQuote(python)} -m pytest -p no:cacheprovider tests`;
}

export function describeCounts(c: TestCounts): string {
  return `passed ${c.passed}, failed ${c.failed}, errors ${c.errors}, skipped ${c.skipped}`;
}

/** pass iff exit 0 and failed == 0 and errors == 0 and passed > 0. */
export function verdict(exitCode: number | null, counts: TestCounts): boolean {
  return exitCode === 0 && counts.failed === 0 && counts.errors === 0 && counts.passed > 0;
}

export interface EvaluateLadderOptions {
  /** interpreter that imports pytest (venv python or `python3`) */
  python: string;
  /** cwd = workspace */
  run: CommandRunner;
  timeoutMs?: number;
}

export async function evaluateLadder(o: EvaluateLadderOptions): Promise<Evaluation> {
  const guard = await o.run('git status --porcelain -- tests/', { timeoutMs: 30_000, maxOutputBytes: 32 * 1024 });
  if (guard.ok && guard.stdout.trim() !== '') {
    return { pass: false, evaluator: 'local', reason: `tests/ was modified: ${guard.stdout.trim().split('\n').slice(0, 5).join('; ')}` };
  }
  const res = await o.run(pytestCommand(o.python), { timeoutMs: o.timeoutMs ?? LADDER_EVAL_TIMEOUT_MS, maxOutputBytes: EVAL_OUTPUT_BYTES });
  if (res.killedBy !== null) return { pass: null, evaluator: 'none', reason: `pytest killed: ${res.killedBy}`, evalExitCode: res.exitCode };
  const counts = parsePytest(`${res.stdout}\n${res.stderr}`);
  if (counts === null) return { pass: null, evaluator: 'none', reason: `pytest produced no summary (exit ${res.exitCode ?? 'null'}): ${tail(res, 300)}`, evalExitCode: res.exitCode };
  const pass = verdict(res.exitCode, counts);
  const out: Evaluation = { pass, evaluator: 'local', evalExitCode: res.exitCode };
  if (!pass) out.reason = `pytest: ${describeCounts(counts)} (exit ${res.exitCode ?? 'null'})`;
  return out;
}
