/**
 * Test verification: a thin wrapper over the committed stdlib runner bench/data/quixbugs/run_tests.py
 * (per-test 2 s subprocess timeouts, QuixBugs' leniency, upstream `slow` skips, in-order module
 * tests for the graph programs). One call = one test run of a whole candidate program.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Json } from '../../src/core/types.ts';
import { QUIX_ROOT, type QuixProgram } from './quixbugs.mts';

export interface TestFailure { id: string; input: Json; expected: Json; actual: string }
export interface TestRunResult {
  kind: 'json' | 'pytest';
  /** tests that can pass (skipped slow cases excluded) */
  total: number;
  passed: number;
  skipped: number;
  failures: TestFailure[];          // first few (max 5) non-passing tests, file order
  firstFailure: TestFailure | null;
  /** every non-skipped test passed (mirrors run_tests.py exit 0) */
  passedAll: boolean;
  durationMs: number;
  /** candidate does not import/compile, or the harness broke */
  runnerError: string | null;
  rawSummary: string | null;
}
export interface VerifyOptions { perTestTimeoutS?: number; jobs?: number; hardTimeoutMs?: number; workDir?: string }

const RUNNER = join(QUIX_ROOT, 'run_tests.py');

interface RunnerReport { name: string; passed: number; failed: number; errors: number; timeouts: number; skipped: number; total: number; failures: { input: Json; expected: Json; actual: string }[]; error?: string }

export async function runTests(p: QuixProgram, candidateSource: string, opts: VerifyOptions = {}): Promise<TestRunResult> {
  const t0 = performance.now();
  const ws = mkdtempSync(join(opts.workDir ?? tmpdir(), 'jev-proto-'));
  try {
    const path = join(ws, `${p.name}.py`);
    writeFileSync(path, candidateSource);
    const args = [RUNNER, p.name, path, '--timeout', String(opts.perTestTimeoutS ?? 2), '--jobs', String(opts.jobs ?? 4), '--max-failures', '5'];
    const { stdout, stderr, killed } = await new Promise<{ stdout: string; stderr: string; killed: boolean }>((resolve) => {
      const child = spawn('python3', args, { cwd: ws, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0' } });
      let out = '', err = '', k = false;
      child.stdout.on('data', (d: Buffer) => { if (out.length < 200_000) out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { if (err.length < 20_000) err += d.toString(); });
      const timer = setTimeout(() => { k = true; child.kill('SIGKILL'); }, opts.hardTimeoutMs ?? 90_000);
      child.on('close', () => { clearTimeout(timer); resolve({ stdout: out, stderr: err, killed: k }); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ stdout: out, stderr: `${err}\n${e.message}`, killed: k }); });
    });
    const durationMs = Math.round(performance.now() - t0);
    const line = stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    const nTests = p.kind === 'json' ? (p.tests?.length ?? 0) : (p.pytestSource.match(/^def test\w*\(/gm) ?? []).length;
    if (!line) {
      return { kind: p.kind, total: nTests, passed: 0, skipped: 0, failures: [], firstFailure: null, passedAll: false, durationMs, runnerError: killed ? `runner killed after ${opts.hardTimeoutMs ?? 90_000} ms` : `runner produced no report: ${stderr.slice(-300)}`, rawSummary: null };
    }
    const rep = JSON.parse(line) as RunnerReport;
    if (rep.error) return { kind: p.kind, total: nTests, passed: 0, skipped: 0, failures: [], firstFailure: null, passedAll: false, durationMs, runnerError: rep.error, rawSummary: null };
    const failures: TestFailure[] = rep.failures.map((f) => ({ id: testId(p, f.input), input: f.input, expected: f.expected, actual: f.actual }));
    const total = rep.total - rep.skipped;
    const passedAll = rep.total > 0 && rep.failed === 0 && rep.errors === 0;
    const importErr = failures.length > 0 && failures.every((f) => /^(SyntaxError|IndentationError|TabError|import error:|ImportError|NameError: name '\w+' is not defined$)/.test(f.actual)) && rep.passed === 0 ? failures[0]!.actual : null;
    return { kind: p.kind, total, passed: rep.passed, skipped: rep.skipped, failures, firstFailure: failures[0] ?? null, passedAll, durationMs, runnerError: importErr, rawSummary: p.kind === 'pytest' ? failures.map((f) => `${f.id}: ${f.actual}`).join('\n').slice(0, 2000) : null };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

function testId(p: QuixProgram, input: Json): string {
  if (p.kind === 'pytest') return String(input).split(':')[0]!;
  const key = JSON.stringify(input);
  const i = (p.tests ?? []).findIndex(([inp]) => JSON.stringify(inp) === key);
  return i >= 0 ? `t${i}` : 't?';
}

export function describeFailure(r: TestRunResult): string {
  const f = r.firstFailure;
  if (!f) return r.runnerError ?? 'all tests pass';
  if (r.kind === 'json') return `input=${JSON.stringify(f.input)} expected=${JSON.stringify(f.expected)} actual=${f.actual}`;
  return `${f.input}: ${f.actual}`;
}
