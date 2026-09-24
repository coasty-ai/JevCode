/**
 * runSbfl: write the embedded tracer into the run's tmp dir, execute it through the caller's
 * command runner, parse one JSON line per test and rank lines with Ochiai (default), Tarantula
 * or DStar.
 *
 * The runner is injected so production goes through the engine's Sandbox:
 *   (cmd, o) => sandbox.run(cmd, { ...o, signal })
 * and tests can use node:child_process. `tmpDir` must be inside the run dir (or the workspace)
 * because the sandbox only accepts a cwd / reads there; the tracer's cwd is the workspace, so
 * `files` and pytest node ids are workspace-relative.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isFailing, rankLines } from './ochiai.js';
import { TRACER_FILENAME, TRACE_LINES_PY } from './tracer.js';
import type { CallTestSpec, Formula, PerTestResult, RankedLine, TestOutcome, TestSpec } from './types.js';

/** Mirrors CHILD_GRACE_SEC in trace_lines.py: the parent's backstop over the per-test alarm. */
export const CHILD_GRACE_SEC = 2;
/** Python + pytest start-up per child, on top of timeoutSec + grace. */
export const CHILD_STARTUP_SEC = 1;
export const RUN_SLACK_MS = 15_000;
export const DEFAULT_SBFL_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const STDERR_TAIL_CHARS = 1000;

export interface SbflRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  cwd?: string;
}

export interface SbflRunResult {
  stdout: string;
  exitCode: number | null;
  stderr?: string;
}

export type SbflRunFn = (command: string, opts: SbflRunOptions) => Promise<SbflRunResult>;

export interface RunSbflOptions {
  run: SbflRunFn;
  /** absolute workspace path: the tracer's cwd and the base for `files` and node ids */
  workspace: string;
  /** directory the tracer and spec are written to (under the run dir); created if missing */
  tmpDir: string;
  /** interpreter to run the tracer with, e.g. `python3` or a venv's absolute path */
  python: string;
  /** workspace-relative Python files whose lines are traced */
  files: readonly string[];
  /** all of one mode; pytest node ids or call oracles */
  tests: readonly TestSpec[];
  /** per-test budget enforced in the child (alarm) and by the parent (kill) */
  timeoutSec: number;
  /** ranking formula for `suspicious[].score` (default ochiai) */
  formula?: Formula;
  maxOutputBytes?: number;
}

export interface SbflResult {
  /** in spec order; tests whose line never arrived are missing (see warnings) */
  perTest: PerTestResult[];
  /** every executed line, ranked; `scores` carries all three formulas */
  suspicious: RankedLine[];
  /** ids with outcome fail | error | timeout */
  failingTests: string[];
  /** ids with outcome pass */
  passingTests: string[];
  warnings: string[];
  command: string;
  exitCode: number | null;
  tracerPath: string;
}

export class SbflError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SbflError';
  }
}

/** POSIX single-quote quoting for `sh -c`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function specMode(tests: readonly TestSpec[]): TestSpec['mode'] {
  const first = tests[0];
  if (first === undefined) throw new SbflError('tests must not be empty');
  for (const t of tests) {
    if (t.mode !== first.mode) throw new SbflError(`tests must share one mode; got ${first.mode} and ${t.mode}`);
  }
  return first.mode;
}

type SpecTest = { id: string } | Omit<CallTestSpec, 'mode'>;

/** The JSON the tracer reads on stdin. */
export function buildTracerSpec(opts: Pick<RunSbflOptions, 'workspace' | 'files' | 'tests' | 'timeoutSec'>): {
  mode: TestSpec['mode'];
  cwd: string;
  files: string[];
  tests: SpecTest[];
  timeoutSec: number;
} {
  const mode = specMode(opts.tests);
  if (opts.files.length === 0) throw new SbflError('files must not be empty');
  if (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec <= 0) throw new SbflError('timeoutSec must be a positive number');
  const seen = new Set<string>();
  const tests = opts.tests.map((t): SpecTest => {
    if (seen.has(t.id)) throw new SbflError(`duplicate test id ${t.id}`);
    seen.add(t.id);
    if (t.mode === 'pytest') return { id: t.id };
    const call: Omit<CallTestSpec, 'mode'> = { id: t.id, module: t.module, fn: t.fn, args: [...t.args], expected: t.expected };
    if (t.tolerance !== undefined) call.tolerance = t.tolerance;
    return call;
  });
  return { mode, cwd: opts.workspace, files: [...opts.files], tests, timeoutSec: opts.timeoutSec };
}

/** Wall-clock budget for the whole tracer run: every child may use its alarm plus the grace. */
export function tracerTimeoutMs(timeoutSec: number, testCount: number): number {
  return Math.ceil((timeoutSec + CHILD_GRACE_SEC + CHILD_STARTUP_SEC) * 1000) * testCount + RUN_SLACK_MS;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const OUTCOMES: ReadonlySet<string> = new Set<TestOutcome>(['pass', 'fail', 'error', 'timeout', 'skip']);

function isOutcome(v: unknown): v is TestOutcome {
  return typeof v === 'string' && OUTCOMES.has(v);
}

/** Validate one parsed tracer line; null when it is not a per-test result. */
export function parsePerTest(v: unknown, files: readonly string[]): PerTestResult | null {
  if (!isRecord(v)) return null;
  const id = v['id'];
  const outcome = v['outcome'];
  if (typeof id !== 'string' || !isOutcome(outcome)) return null;
  const lines: Record<string, number[]> = {};
  const rawLines = v['lines'];
  if (rawLines !== undefined) {
    if (!isRecord(rawLines)) return null;
    for (const [file, arr] of Object.entries(rawLines)) {
      if (!Array.isArray(arr)) return null;
      lines[file] = arr.filter((n): n is number => typeof n === 'number' && Number.isInteger(n)).sort((a, b) => a - b);
    }
  }
  for (const f of files) lines[f] ??= [];
  const rawExc = v['exception'];
  let exception: PerTestResult['exception'] = null;
  if (isRecord(rawExc)) {
    const type = rawExc['type'];
    const message = rawExc['message'];
    if (typeof type !== 'string' || typeof message !== 'string') return null;
    exception = { type, message };
  } else if (rawExc !== null && rawExc !== undefined) {
    return null;
  }
  const durationMs = typeof v['durationMs'] === 'number' && Number.isFinite(v['durationMs']) ? v['durationMs'] : 0;
  const out: PerTestResult = { id, outcome, lines, exception, durationMs };
  if (typeof v['actual'] === 'string') out.actual = v['actual'];
  if (typeof v['log'] === 'string') out.log = v['log'];
  return out;
}

/** Parse the tracer's stdout (one JSON object per line) against the expected ids. */
export function parseTracerOutput(
  stdout: string,
  expectedIds: readonly string[],
  files: readonly string[],
): { perTest: PerTestResult[]; warnings: string[] } {
  const warnings: string[] = [];
  const byId = new Map<string, PerTestResult>();
  const expected = new Set(expectedIds);
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(`unparseable tracer line: ${line.slice(0, 200)}`);
      continue;
    }
    const result = parsePerTest(parsed, files);
    if (result === null) {
      warnings.push(`malformed tracer result: ${line.slice(0, 200)}`);
      continue;
    }
    if (!expected.has(result.id)) {
      warnings.push(`unexpected test id in tracer output: ${result.id}`);
      continue;
    }
    if (byId.has(result.id)) {
      warnings.push(`duplicate tracer result for ${result.id}; keeping the first`);
      continue;
    }
    byId.set(result.id, result);
  }
  const perTest: PerTestResult[] = [];
  for (const id of expectedIds) {
    const r = byId.get(id);
    if (r === undefined) warnings.push(`no tracer result for ${id}`);
    else perTest.push(r);
  }
  for (const r of perTest) {
    const covered = Object.values(r.lines).some((ls) => ls.length > 0);
    if (isFailing(r.outcome) && !covered) {
      const why = r.exception === null ? '' : ` (${r.exception.type}: ${r.exception.message.slice(0, 120)})`;
      warnings.push(`failing test ${r.id} executed none of the traced files${why}`);
    }
  }
  return { perTest, warnings };
}

export async function runSbfl(opts: RunSbflOptions): Promise<SbflResult> {
  const spec = buildTracerSpec(opts);
  const dir = join(opts.tmpDir, 'sbfl');
  await mkdir(dir, { recursive: true });
  const tracerPath = join(dir, TRACER_FILENAME);
  await writeFile(tracerPath, TRACE_LINES_PY, 'utf8');
  const specPath = join(dir, `spec-${randomUUID()}.json`);
  await writeFile(specPath, JSON.stringify(spec), 'utf8');
  const command = `${shellQuote(opts.python)} ${shellQuote(tracerPath)} < ${shellQuote(specPath)}`;
  let res: SbflRunResult;
  try {
    res = await opts.run(command, {
      timeoutMs: tracerTimeoutMs(opts.timeoutSec, opts.tests.length),
      maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_SBFL_MAX_OUTPUT_BYTES,
      cwd: opts.workspace,
    });
  } finally {
    await rm(specPath, { force: true });
  }
  const expectedIds = opts.tests.map((t) => t.id);
  const { perTest, warnings } = parseTracerOutput(res.stdout, expectedIds, opts.files);
  if (res.exitCode !== 0) {
    const tail = res.stderr === undefined || res.stderr.length === 0 ? '' : `: ${res.stderr.slice(-STDERR_TAIL_CHARS).trim()}`;
    warnings.push(`tracer exited with code ${res.exitCode ?? 'null (killed)'}${tail}`);
  }
  return {
    perTest,
    suspicious: rankLines(perTest, opts.formula ?? 'ochiai'),
    failingTests: perTest.filter((t) => isFailing(t.outcome)).map((t) => t.id),
    passingTests: perTest.filter((t) => t.outcome === 'pass').map((t) => t.id),
    warnings,
    command,
    exitCode: res.exitCode,
    tracerPath,
  };
}

/** json.dumps default formatting (", " and ": " separators) so ids match the tracer's own default. */
function pyJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pyJson).join(', ')}]`;
  if (isRecord(v)) return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`).join(', ')}}`;
  return v === undefined ? 'null' : JSON.stringify(v);
}

/**
 * QuixBugs-style JSON-lines test cases (`[[args...], expected]` per line) to call specs. Ids
 * match the tracer's default: `fn(arg1, arg2)` with json.dumps formatting.
 */
export function callSpecsFromJsonl(module: string, fn: string, jsonl: string, opts: { tolerance?: number } = {}): CallTestSpec[] {
  const out: CallTestSpec[] = [];
  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? '';
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new SbflError(`${fn}.json line ${i + 1}: not JSON`);
    }
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Array.isArray(parsed[0])) {
      throw new SbflError(`${fn}.json line ${i + 1}: expected [[args...], expected]`);
    }
    const args: unknown[] = parsed[0];
    const spec: CallTestSpec = { mode: 'call', id: `${fn}(${args.map(pyJson).join(', ')})`, module, fn, args, expected: parsed[1] };
    if (opts.tolerance !== undefined) spec.tolerance = opts.tolerance;
    out.push(spec);
  }
  if (out.length === 0) throw new SbflError(`${fn}.json has no test cases`);
  return out;
}
