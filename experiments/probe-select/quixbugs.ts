/** QuixBugs loader for probe-select: programs, gold diff (replace or insert), tests via run_tests.py. */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext, normLine, type MutationContext } from './mutators.ts';

export const ROOT = '/tmp/quixbugs';
const HERE = dirname(fileURLToPath(import.meta.url));
const PY = '/usr/bin/python3';

export interface TestRow {
  kind: 'json' | 'pytest';
  input?: unknown;
  name?: string;
  source?: string;
  expected: unknown;
  actual: unknown;
  status: 'pass' | 'wrong_output' | 'exception' | 'timeout';
}
export interface Program {
  name: string;
  /** code lines with QuixBugs docstring and comment-only lines removed, blank lines removed */
  lines: string[];
  /** index into `lines` of the anchor: the replaced line, or (insert) the line before the insertion */
  index: number;
  mode: 'replace' | 'insert';
  buggyLine: string;
  fixLine: string;
  ctx: MutationContext;
  /** all tests run on the buggy program */
  buggyTests: TestRow[];
  /** indices of tests the gold program passes within the time limit (the oracle set) */
  oracle: number[];
}

export function codeLines(src: string): string[] {
  const i = src.indexOf('\n"""');
  const body = i > 0 ? src.slice(0, i) : src;
  return body.replace(/\s+$/, '').split('\n').map((l) => l.replace(/\s+#.*$/, '').replace(/\s+$/, '')).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
}

export function programNames(): string[] {
  return readdirSync(join(ROOT, 'python_programs')).filter((f) => f.endsWith('.py') && !f.endsWith('_test.py') && f !== 'node.py').map((f) => f.slice(0, -3)).sort();
}

export function runTests(name: string, source: string, maxTests = 1_000_000, timeoutS = 2): { tests: TestRow[]; all_pass: boolean } {
  mkdirSync('/tmp/jevonly/variants', { recursive: true });
  const file = `/tmp/jevonly/variants/${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.py`;
  writeFileSync(file, source);
  const out = execFileSync(PY, [join(HERE, 'run_tests.py'), name, file, String(maxTests), String(timeoutS)], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out) as { tests: TestRow[]; all_pass: boolean };
}

/** Program source with `lines[index]` replaced by (or, insert mode, followed by) `candidate`. */
export function applyCandidate(p: Program, candidate: string): string {
  const l = [...p.lines];
  if (p.mode === 'insert') l.splice(p.index + 1, 0, ...candidate.split('\n'));
  else l.splice(p.index, 1, ...candidate.split('\n'));
  return l.join('\n') + '\n';
}

export function compilable(p: Program, candidates: string[]): boolean[] {
  const out = execFileSync(PY, [join(HERE, 'filter_compilable.py')], { input: JSON.stringify({ lines: p.lines, index: p.index, candidates, mode: p.mode }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out) as boolean[];
}

function testLiterals(tests: TestRow[]): { ints: string[]; strs: string[] } {
  const ints = new Set<string>(), strs = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 1000) ints.add(String(v));
    else if (typeof v === 'string' && v.length <= 12) strs.add(JSON.stringify(v));
    else if (Array.isArray(v)) v.slice(0, 20).forEach(walk);
  };
  for (const t of tests.slice(0, 3)) { walk(t.input); walk(t.expected); }
  return { ints: [...ints].slice(0, 6), strs: [...strs].slice(0, 4) };
}

/** Load one program: gold diff -> anchor + fix, tests on buggy, oracle indices from gold. */
export function loadProgram(name: string): Program {
  const buggy = codeLines(readFileSync(join(ROOT, 'python_programs', `${name}.py`), 'utf8'));
  const fixed = codeLines(readFileSync(join(ROOT, 'correct_python_programs', `${name}.py`), 'utf8'));
  // longest common prefix / suffix -> the differing hunk
  let pre = 0;
  while (pre < buggy.length && pre < fixed.length && normLine(buggy[pre]!) === normLine(fixed[pre]!)) pre++;
  let suf = 0;
  while (suf < buggy.length - pre && suf < fixed.length - pre && normLine(buggy[buggy.length - 1 - suf]!) === normLine(fixed[fixed.length - 1 - suf]!)) suf++;
  const bHunk = buggy.slice(pre, buggy.length - suf), fHunk = fixed.slice(pre, fixed.length - suf);
  let mode: 'replace' | 'insert', index: number, buggyLine: string, fixLine: string;
  if (bHunk.length === 0 && fHunk.length >= 1) {
    mode = 'insert'; index = pre - 1; buggyLine = buggy[index]!; fixLine = fHunk.join('\n');
  } else if (bHunk.length === 1) {
    mode = 'replace'; index = pre; buggyLine = bHunk[0]!; fixLine = fHunk.join('\n');
  } else {
    throw new Error(`${name}: multi-line hunk ${JSON.stringify(bHunk)} -> ${JSON.stringify(fHunk)}`);
  }
  const buggyRun = runTests(name, buggy.join('\n') + '\n');
  const goldRun = runTests(name, fixed.join('\n') + '\n');
  const oracle = goldRun.tests.map((t, i) => (t.status === 'pass' ? i : -1)).filter((i) => i >= 0);
  const ctx = buildContext(buggy, testLiterals(buggyRun.tests));
  return { name, lines: buggy, index, mode, buggyLine, fixLine, ctx, buggyTests: buggyRun.tests, oracle };
}

/** Up to three tests for the state: failing ones first, then passing. */
export function pickStateTests(p: Program, k = 3): TestRow[] {
  const failing = p.buggyTests.filter((t, i) => t.status !== 'pass' && p.oracle.includes(i));
  const passing = p.buggyTests.filter((t, i) => t.status === 'pass' && p.oracle.includes(i));
  return [...failing, ...passing].slice(0, k);
}

/** Async variant (does not block the event loop while Jev requests are in flight). */
export async function runTestsAsync(name: string, source: string, maxTests = 1_000_000, timeoutS = 2): Promise<{ tests: TestRow[]; all_pass: boolean }> {
  mkdirSync('/tmp/jevonly/variants', { recursive: true });
  const file = `/tmp/jevonly/variants/${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.py`;
  writeFileSync(file, source);
  const { stdout } = await execFileP(PY, [join(HERE, 'run_tests.py'), name, file, String(maxTests), String(timeoutS)], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout) as { tests: TestRow[]; all_pass: boolean };
}

/** Does `candidate` pass every oracle test? */
export async function passesOracle(p: Program, candidate: string): Promise<boolean> {
  try {
    const r = await runTestsAsync(p.name, applyCandidate(p, candidate));
    return p.oracle.every((i) => r.tests[i]?.status === 'pass');
  } catch {
    return false;
  }
}
