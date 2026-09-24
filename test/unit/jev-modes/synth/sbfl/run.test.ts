import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHILD_GRACE_SEC,
  CHILD_STARTUP_SEC,
  DEFAULT_SBFL_MAX_OUTPUT_BYTES,
  RUN_SLACK_MS,
  SbflError,
  buildTracerSpec,
  callSpecsFromJsonl,
  parsePerTest,
  parseTracerOutput,
  runSbfl,
  shellQuote,
  tracerTimeoutMs,
} from '../../../../../src/jev-modes/synth/sbfl/run.js';
import type { SbflRunFn, SbflRunOptions } from '../../../../../src/jev-modes/synth/sbfl/run.js';
import { TRACE_LINES_PY } from '../../../../../src/jev-modes/synth/sbfl/tracer.js';
import type { TestSpec } from '../../../../../src/jev-modes/synth/sbfl/types.js';
import { FIXTURES, PYTHON, childProcessRunner, havePython } from './helpers.js';

const PYPROJ = join(FIXTURES, 'pyproj');
const QUIXBUGS = join(FIXTURES, 'quixbugs');

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'jevcode-sbfl-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const pytestIds = (ids: string[]): TestSpec[] => ids.map((id) => ({ mode: 'pytest', id }));

const CALC_IDS = [
  'test_calc.py::test_mean',
  'test_calc.py::test_median_odd',
  'test_calc.py::test_median_even',
  'test_calc.py::test_median_empty',
  'test_calc.py::test_clamp',
  'test_calc.py::test_running_max',
  'test_calc.py::test_boom',
  'test_calc.py::TestMedian::test_single',
];

describe.skipIf(!havePython)('runSbfl end to end through a child_process runner', () => {
  it('pytest mode: ranks calc.py:18 first, lists failing/passing tests, warns about uncovered failures', async () => {
    const r = await runSbfl({
      run: childProcessRunner(),
      workspace: PYPROJ,
      tmpDir: tmp,
      python: PYTHON,
      files: ['calc.py'],
      tests: pytestIds(CALC_IDS),
      timeoutSec: 5,
    });
    expect(r.exitCode).toBe(0);
    expect(r.perTest.map((t) => t.id)).toEqual(CALC_IDS);
    expect(r.failingTests).toEqual(['test_calc.py::test_median_even', 'test_calc.py::test_boom']);
    expect(r.passingTests).toHaveLength(6);
    expect(r.suspicious[0]).toMatchObject({ rank: 1, file: 'calc.py', line: 18, ef: 1, ep: 0 });
    expect(r.suspicious[0]!.score).toBeCloseTo(1 / Math.sqrt(2), 12);
    expect(r.suspicious[0]!.scores.dstar).toBe(1); // ef 1, ep 0, nf 1 (test_boom fails without touching calc.py)
    expect(r.suspicious.slice(0, 3).map((l) => l.line)).toEqual([18, 13, 14]);
    expect(r.warnings).toEqual(['failing test test_calc.py::test_boom executed none of the traced files (RuntimeError: boom)']);
    // the tracer was written under tmpDir and the spec cleaned up
    expect(r.tracerPath).toBe(join(tmp, 'sbfl', 'trace_lines.py'));
    expect(readFileSync(r.tracerPath, 'utf8')).toBe(TRACE_LINES_PY);
    expect(readdirSync(join(tmp, 'sbfl'))).toEqual(['trace_lines.py']);
    expect(r.command.startsWith(`${shellQuote(PYTHON)} ${shellQuote(r.tracerPath)} < '`)).toBe(true);
  });

  it('call mode: QuixBugs gcd.json via callSpecsFromJsonl puts the bug at rank 1', async () => {
    const tests = callSpecsFromJsonl('gcd', 'gcd', readFileSync(join(QUIXBUGS, 'gcd.json'), 'utf8'));
    const r = await runSbfl({ run: childProcessRunner(), workspace: QUIXBUGS, tmpDir: tmp, python: PYTHON, files: ['gcd.py'], tests, timeoutSec: 5, formula: 'dstar' });
    expect(r.warnings).toEqual([]);
    expect(r.passingTests).toEqual(['gcd(17, 0)']);
    expect(r.failingTests).toHaveLength(5);
    expect(r.suspicious.map((l) => l.line)).toEqual([5, 2, 3]);
    expect(r.suspicious[0]!.score).toBe(Number.POSITIVE_INFINITY); // dstar: ef 5, ep 0, nf 0
    expect(r.suspicious[0]!.scores.ochiai).toBeCloseTo(1, 12);
    expect(r.suspicious[2]).toMatchObject({ line: 3, ef: 0, ep: 1, score: 0 });
  });
});

describe('runSbfl with a fake runner (no Python needed)', () => {
  const line = (id: string, outcome: string, lines: number[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ id, outcome, lines: { 'a.py': lines }, exception: null, durationMs: 1, ...extra });

  function fakeRunner(stdout: string, exitCode: number | null = 0, stderr?: string): { run: SbflRunFn; calls: { command: string; opts: SbflRunOptions }[] } {
    const calls: { command: string; opts: SbflRunOptions }[] = [];
    const run: SbflRunFn = async (command, opts) => {
      calls.push({ command, opts });
      return stderr === undefined ? { stdout, exitCode } : { stdout, exitCode, stderr };
    };
    return { run, calls };
  }

  it('passes cwd, the wall-clock budget and the output cap to the runner and writes the spec it will read', async () => {
    const stdoutLines = [line('t1', 'fail', [3, 4]), line('t2', 'pass', [3])].join('\n');
    const { run, calls } = fakeRunner(stdoutLines);
    const specSeen: unknown[] = [];
    const spyRun: SbflRunFn = async (command, opts) => {
      const specPath = command.slice(command.lastIndexOf('< ') + 2).replace(/^'|'$/g, '');
      specSeen.push(JSON.parse(readFileSync(specPath, 'utf8')));
      return run(command, opts);
    };
    const r = await runSbfl({ run: spyRun, workspace: '/ws', tmpDir: tmp, python: '/venv/bin/python', files: ['a.py'], tests: pytestIds(['t1', 't2']), timeoutSec: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toEqual({ timeoutMs: tracerTimeoutMs(3, 2), maxOutputBytes: DEFAULT_SBFL_MAX_OUTPUT_BYTES, cwd: '/ws' });
    expect(tracerTimeoutMs(3, 2)).toBe((3 + CHILD_GRACE_SEC + CHILD_STARTUP_SEC) * 1000 * 2 + RUN_SLACK_MS);
    expect(calls[0]!.command.startsWith(`'/venv/bin/python' '${join(tmp, 'sbfl', 'trace_lines.py')}' < '`)).toBe(true);
    expect(specSeen[0]).toEqual({ mode: 'pytest', cwd: '/ws', files: ['a.py'], tests: [{ id: 't1' }, { id: 't2' }], timeoutSec: 3 });
    expect(r.failingTests).toEqual(['t1']);
    expect(r.passingTests).toEqual(['t2']);
    expect(r.suspicious.map((l) => [l.line, l.score])).toEqual([
      [4, 1],
      [3, 1 / Math.sqrt(2)],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('uses the requested formula for `score`', async () => {
    const { run } = fakeRunner([line('t1', 'fail', [3, 4]), line('t2', 'pass', [3])].join('\n'));
    const r = await runSbfl({ run, workspace: '/ws', tmpDir: tmp, python: 'python3', files: ['a.py'], tests: pytestIds(['t1', 't2']), timeoutSec: 3, formula: 'tarantula' });
    expect(r.suspicious[0]!.score).toBe(r.suspicious[0]!.scores.tarantula);
    expect(r.suspicious.map((l) => [l.line, l.score])).toEqual([
      [4, 1],
      [3, 0.5],
    ]);
  });

  it('warns about unparseable, malformed, unexpected, duplicate and missing results and a non-zero exit', async () => {
    const stdout = [
      'Traceback (most recent call last):',
      line('t1', 'fail', [3]),
      JSON.stringify({ id: 't2', outcome: 'maybe' }),
      line('ghost', 'pass', [1]),
      line('t1', 'pass', [9]),
      '',
    ].join('\n');
    const { run } = fakeRunner(stdout, 1, 'boom\nlast line');
    const r = await runSbfl({ run, workspace: '/ws', tmpDir: tmp, python: 'python3', files: ['a.py'], tests: pytestIds(['t1', 't2', 't3']), timeoutSec: 3 });
    expect(r.perTest.map((t) => t.id)).toEqual(['t1']);
    expect(r.perTest[0]!.lines).toEqual({ 'a.py': [3] }); // the first result for t1 wins
    expect(r.warnings).toEqual([
      'unparseable tracer line: Traceback (most recent call last):',
      'malformed tracer result: {"id":"t2","outcome":"maybe"}',
      'unexpected test id in tracer output: ghost',
      'duplicate tracer result for t1; keeping the first',
      'no tracer result for t2',
      'no tracer result for t3',
      'tracer exited with code 1: boom\nlast line',
    ]);
    expect(r.exitCode).toBe(1);
  });

  it('reports a killed tracer (exitCode null) and keeps the partial results', async () => {
    const { run } = fakeRunner(line('t1', 'timeout', [3, 4]), null);
    const r = await runSbfl({ run, workspace: '/ws', tmpDir: tmp, python: 'python3', files: ['a.py'], tests: pytestIds(['t1', 't2']), timeoutSec: 3 });
    expect(r.failingTests).toEqual(['t1']);
    expect(r.warnings).toEqual(['no tracer result for t2', 'tracer exited with code null (killed)']);
  });

  it('removes the spec file even when the runner rejects, and propagates the error', async () => {
    const run: SbflRunFn = async () => {
      throw new Error('sandbox down');
    };
    await expect(runSbfl({ run, workspace: '/ws', tmpDir: tmp, python: 'python3', files: ['a.py'], tests: pytestIds(['t1']), timeoutSec: 3 })).rejects.toThrow('sandbox down');
    expect(readdirSync(join(tmp, 'sbfl'))).toEqual(['trace_lines.py']);
  });
});

describe('buildTracerSpec', () => {
  const call = (id: string, tolerance?: number): TestSpec => ({ mode: 'call', id, module: 'm', fn: 'f', args: [1, [2]], expected: { k: true }, ...(tolerance !== undefined ? { tolerance } : {}) });

  it('strips `mode` from tests and includes tolerance only when set', () => {
    const spec = buildTracerSpec({ workspace: '/ws', files: ['m.py'], tests: [call('a'), call('b', 0.5)], timeoutSec: 2 });
    expect(spec).toEqual({
      mode: 'call',
      cwd: '/ws',
      files: ['m.py'],
      tests: [
        { id: 'a', module: 'm', fn: 'f', args: [1, [2]], expected: { k: true } },
        { id: 'b', module: 'm', fn: 'f', args: [1, [2]], expected: { k: true }, tolerance: 0.5 },
      ],
      timeoutSec: 2,
    });
    expect(Object.hasOwn(spec.tests[0]!, 'tolerance')).toBe(false);
  });

  it('rejects empty tests, mixed modes, duplicate ids, empty files and a bad timeout', () => {
    expect(() => buildTracerSpec({ workspace: '/ws', files: ['m.py'], tests: [], timeoutSec: 2 })).toThrow(SbflError);
    expect(() => buildTracerSpec({ workspace: '/ws', files: ['m.py'], tests: [call('a'), { mode: 'pytest', id: 'p' }], timeoutSec: 2 })).toThrow(/share one mode/);
    expect(() => buildTracerSpec({ workspace: '/ws', files: ['m.py'], tests: [call('a'), call('a')], timeoutSec: 2 })).toThrow(/duplicate test id a/);
    expect(() => buildTracerSpec({ workspace: '/ws', files: [], tests: [call('a')], timeoutSec: 2 })).toThrow(/files must not be empty/);
    expect(() => buildTracerSpec({ workspace: '/ws', files: ['m.py'], tests: [call('a')], timeoutSec: 0 })).toThrow(/timeoutSec/);
    expect(() => buildTracerSpec({ workspace: '/ws', files: ['m.py'], tests: [call('a')], timeoutSec: Number.NaN })).toThrow(/timeoutSec/);
  });
});

describe('callSpecsFromJsonl', () => {
  it('turns QuixBugs JSON lines into call specs with the tracer default ids', () => {
    const specs = callSpecsFromJsonl('gcd', 'gcd', readFileSync(join(QUIXBUGS, 'gcd.json'), 'utf8'), { tolerance: 0.01 });
    expect(specs).toHaveLength(6);
    expect(specs[0]).toEqual({ mode: 'call', id: 'gcd(17, 0)', module: 'gcd', fn: 'gcd', args: [17, 0], expected: 17, tolerance: 0.01 });
    expect(specs[4]!.id).toBe('gcd(624129, 2061517)');
    expect(Object.hasOwn(callSpecsFromJsonl('m', 'f', '[[1], 2]\n')[0]!, 'tolerance')).toBe(false);
    expect(callSpecsFromJsonl('m', 'f', '[[1, [2, 3], {"k": true, "s": "x"}, null, 1.5], 0]\n')[0]!.id).toBe('f(1, [2, 3], {"k": true, "s": "x"}, null, 1.5)');
  });

  it('rejects malformed lines and empty input', () => {
    expect(() => callSpecsFromJsonl('m', 'f', '[[1], 2]\nnot json\n')).toThrow(/line 2: not JSON/);
    expect(() => callSpecsFromJsonl('m', 'f', '[1, 2]\n')).toThrow(/expected \[\[args\.\.\.\], expected\]/);
    expect(() => callSpecsFromJsonl('m', 'f', '\n\n')).toThrow(/no test cases/);
  });
});

describe('parsePerTest', () => {
  it('validates shape, fills missing files, sorts and de-noises lines, keeps optional fields', () => {
    const r = parsePerTest({ id: 'x', outcome: 'fail', lines: { 'a.py': [9, 3, 3.5, 'no', 1] }, exception: { type: 'E', message: 'm' }, durationMs: 4, actual: '1', log: 'l' }, ['a.py', 'b.py']);
    expect(r).toEqual({ id: 'x', outcome: 'fail', lines: { 'a.py': [1, 3, 9], 'b.py': [] }, exception: { type: 'E', message: 'm' }, durationMs: 4, actual: '1', log: 'l' });
    expect(parsePerTest({ id: 'x', outcome: 'pass' }, ['a.py'])).toEqual({ id: 'x', outcome: 'pass', lines: { 'a.py': [] }, exception: null, durationMs: 0 });
  });

  it('returns null for a bad outcome, a non-object, bad lines or a bad exception', () => {
    expect(parsePerTest({ id: 'x', outcome: 'maybe' }, [])).toBeNull();
    expect(parsePerTest('nope', [])).toBeNull();
    expect(parsePerTest({ id: 'x', outcome: 'pass', lines: { 'a.py': 'not-a-list' } }, [])).toBeNull();
    expect(parsePerTest({ id: 'x', outcome: 'pass', exception: { type: 1 } }, [])).toBeNull();
    expect(parsePerTest({ id: 'x', outcome: 'pass', exception: 'boom' }, [])).toBeNull();
  });
});

describe('parseTracerOutput', () => {
  it('orders results by the spec and excludes skipped tests from both lists downstream', () => {
    const stdout = [
      JSON.stringify({ id: 'b', outcome: 'skip', lines: {}, exception: null, durationMs: 0 }),
      JSON.stringify({ id: 'a', outcome: 'pass', lines: { 'a.py': [1] }, exception: null, durationMs: 0 }),
    ].join('\n');
    const { perTest, warnings } = parseTracerOutput(stdout, ['a', 'b'], ['a.py']);
    expect(perTest.map((t) => t.id)).toEqual(['a', 'b']);
    expect(warnings).toEqual([]);
  });
});

describe('shellQuote', () => {
  it('single-quotes and escapes embedded quotes so sh reproduces the string', () => {
    expect(shellQuote('plain')).toBe(`'plain'`);
    expect(shellQuote(`it's "here" $HOME \`x\``)).toBe(`'it'\\''s "here" $HOME \`x\`'`);
    const weird = `a b'c"d$e\`f\\g`;
    const echoed = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(weird)}`], { encoding: 'utf8' });
    expect(echoed).toBe(weird);
  });
});
