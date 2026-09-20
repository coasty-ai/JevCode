import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { rankLines, rankOf } from '../../../../src/synth/sbfl/ochiai.js';
import { buildTracerSpec, callSpecsFromJsonl, parsePerTest } from '../../../../src/synth/sbfl/run.js';
import { TRACE_LINES_PY } from '../../../../src/synth/sbfl/tracer.js';
import type { PerTestResult, TestSpec } from '../../../../src/synth/sbfl/types.js';
import { FIXTURES, TRACER, havePython, havePytest, jsonLines, runTracer } from './helpers.js';

const PYPROJ = join(FIXTURES, 'pyproj');
const QUIXBUGS = join(FIXTURES, 'quixbugs');
const TIMEOUT = join(FIXTURES, 'timeout');

function pytestIds(ids: string[]): TestSpec[] {
  return ids.map((id) => ({ mode: 'pytest', id }));
}

async function trace(workspace: string, files: string[], tests: TestSpec[], timeoutSec: number, env: Record<string, string> = {}): Promise<{ results: PerTestResult[]; raw: Awaited<ReturnType<typeof runTracer>> }> {
  const raw = await runTracer(buildTracerSpec({ workspace, files, tests, timeoutSec }), env);
  const results: PerTestResult[] = [];
  for (const v of jsonLines(raw.stdout)) {
    const r = parsePerTest(v, files);
    if (r === null) throw new Error(`tracer emitted a malformed result: ${JSON.stringify(v)}`);
    results.push(r);
  }
  return { results, raw };
}

const byId = (results: PerTestResult[]): Map<string, PerTestResult> => new Map(results.map((r) => [r.id, r]));

it('the embedded TRACE_LINES_PY equals trace_lines.py on disk', () => {
  expect(TRACE_LINES_PY).toBe(readFileSync(TRACER, 'utf8'));
  expect(TRACE_LINES_PY.startsWith('"""Per-test line coverage')).toBe(true);
});

describe.skipIf(!havePython)('call mode (QuixBugs-style JSON oracle)', () => {
  it('runs gcd.json against the buggy gcd and ranks the buggy line first', async () => {
    const tests = callSpecsFromJsonl('gcd', 'gcd', readFileSync(join(QUIXBUGS, 'gcd.json'), 'utf8'));
    expect(tests).toHaveLength(6);
    const { results, raw } = await trace(QUIXBUGS, ['gcd.py'], tests, 5);
    expect(raw.code).toBe(0);
    expect(results.map((r) => r.id)).toEqual(tests.map((t) => t.id));
    const m = byId(results);
    expect(m.get('gcd(17, 0)')).toMatchObject({ outcome: 'pass', exception: null, lines: { 'gcd.py': [2, 3] } });
    for (const id of ['gcd(13, 13)', 'gcd(37, 600)', 'gcd(20, 100)', 'gcd(624129, 2061517)', 'gcd(3, 12)']) {
      const r = m.get(id);
      expect(r?.outcome).toBe('error');
      expect(r?.exception?.type).toBe('RecursionError');
      expect(r?.lines['gcd.py']).toEqual([2, 5]);
    }
    const ranked = rankLines(results);
    expect(rankOf(ranked, 'gcd.py', 5)).toBe(1); // `return gcd(a % b, b)` is the QuixBugs bug
    expect(ranked[0]!.score).toBeCloseTo(1, 12);
    expect(rankOf(ranked, 'gcd.py', 2)).toBe(2);
  });

  it('drains generators, tolerates floats, equates tuples with lists and keeps bool apart from int', async () => {
    const call = (id: string, fn: string, args: unknown[], expected: unknown, extra: { module?: string; tolerance?: number } = {}): TestSpec => ({
      mode: 'call',
      id,
      module: extra.module ?? 'values',
      fn,
      args,
      expected,
      ...(extra.tolerance !== undefined ? { tolerance: extra.tolerance } : {}),
    });
    const tests: TestSpec[] = [
      call('gen', 'evens', [5], [0, 2, 4]),
      call('gen-wrong', 'evens', [5], [0, 2]),
      call('float', 'half', [3], 1.5),
      call('float-tol', 'half', [1], 0.51, { tolerance: 0.02 }),
      call('float-strict', 'half', [1], 0.51),
      call('tuples', 'pairs', [2], [[0, 0], [1, 1]]),
      call('bool-vs-int', 'is_positive', [1], 1),
      call('bool', 'is_positive', [1], true),
      call('by-path', 'half', [4], 2, { module: 'values.py' }),
      call('no-module', 'half', [4], 2, { module: 'nope' }),
      call('no-fn', 'nope', [], null),
    ];
    const { results } = await trace(PYPROJ, ['values.py'], tests, 5);
    const m = byId(results);
    expect(m.get('gen')?.outcome).toBe('pass');
    expect(m.get('gen')?.lines['values.py']).toEqual([5, 6, 7]);
    expect(m.get('gen-wrong')).toMatchObject({ outcome: 'fail', actual: '[0, 2, 4]' });
    expect(m.get('gen-wrong')?.exception).toEqual({ type: 'AssertionError', message: 'expected [0, 2], got [0, 2, 4]' });
    expect(m.get('float')?.outcome).toBe('pass');
    expect(m.get('float-tol')?.outcome).toBe('pass');
    expect(m.get('float-strict')).toMatchObject({ outcome: 'fail', actual: '0.5' });
    expect(m.get('tuples')?.outcome).toBe('pass');
    expect(m.get('bool-vs-int')?.outcome).toBe('fail');
    expect(m.get('bool')?.outcome).toBe('pass');
    expect(m.get('by-path')?.outcome).toBe('pass');
    expect(m.get('no-module')).toMatchObject({ outcome: 'error', exception: { type: 'ModuleNotFoundError' } });
    expect(m.get('no-fn')).toMatchObject({ outcome: 'error', exception: { type: 'AttributeError' } });
  });
});

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

/** What both runners must agree on for test_calc.py (calc.py line 18 is the bug). */
function expectCalcOutcomes(results: PerTestResult[]): void {
  const m = byId(results);
  expect(m.get('test_calc.py::test_mean')).toMatchObject({ outcome: 'pass', lines: { 'calc.py': [5, 7] } });
  expect(m.get('test_calc.py::test_median_odd')).toMatchObject({ outcome: 'pass', lines: { 'calc.py': [11, 13, 14, 15, 16, 17] } });
  expect(m.get('test_calc.py::test_median_even')).toMatchObject({ outcome: 'fail', lines: { 'calc.py': [11, 13, 14, 15, 16, 18] } });
  expect(m.get('test_calc.py::test_median_even')?.exception?.type).toBe('AssertionError');
  expect(m.get('test_calc.py::test_median_empty')).toMatchObject({ outcome: 'pass', lines: { 'calc.py': [11, 12] } });
  expect(m.get('test_calc.py::test_clamp')).toMatchObject({ outcome: 'pass', lines: { 'calc.py': [22, 23, 24, 25, 26] } });
  expect(m.get('test_calc.py::test_running_max')).toMatchObject({ outcome: 'pass', lines: { 'calc.py': [30, 31, 32, 33, 34, 35, 36] } });
  expect(m.get('test_calc.py::test_boom')).toMatchObject({ outcome: 'error', exception: { type: 'RuntimeError', message: 'boom' }, lines: { 'calc.py': [] } });
  expect(m.get('test_calc.py::TestMedian::test_single')).toMatchObject({ outcome: 'pass', lines: { 'calc.py': [11, 13, 14, 15, 16, 17] } });
  // the `def` lines (4, 10, 21, 29) are import-time and never part of a test's spectrum
  for (const r of results) expect(r.lines['calc.py']).not.toContain(10);
  const ranked = rankLines(results);
  expect(rankOf(ranked, 'calc.py', 18)).toBe(1);
  expect(rankOf(ranked, 'calc.py', 18)).toBeLessThanOrEqual(3);
  expect(ranked[0]!.score).toBeCloseTo(1 / Math.sqrt(2), 12); // ef 1, ep 0, F 2 (median_even, boom)
  expect(ranked[1]!.score).toBeCloseTo(1 / Math.sqrt(6), 12); // lines 13-16: ef 1, ep 2
}

describe.skipIf(!havePython)('pytest mode with the stdlib fallback runner (SBFL_NO_PYTEST=1)', () => {
  it('reports outcomes and per-test coverage; the buggy line ranks first', async () => {
    const { results, raw } = await trace(PYPROJ, ['calc.py'], pytestIds([...CALC_IDS, 'test_calc.py::test_missing']), 5, { SBFL_NO_PYTEST: '1' });
    expect(raw.code).toBe(0);
    expect(results.map((r) => r.id)).toEqual([...CALC_IDS, 'test_calc.py::test_missing']);
    expectCalcOutcomes(results.filter((r) => CALC_IDS.includes(r.id)));
    const missing = byId(results).get('test_calc.py::test_missing');
    expect(missing).toMatchObject({ outcome: 'error', exception: { type: 'AttributeError' }, lines: { 'calc.py': [] } });
    // the extra failing test with no coverage lowers every score uniformly but leaves the order intact
    expect(rankOf(rankLines(results), 'calc.py', 18)).toBe(1);
    // stdout noise from the test lands in the stderr log, never in the JSON stream
    expect(raw.stdout).not.toContain('noise on stdout');
  });

  it('cannot supply fixtures or parametrised ids and says so', async () => {
    const { results } = await trace(PYPROJ, ['calc.py'], pytestIds(['test_calc_pytest.py::test_median_param[xs0-1]']), 5, { SBFL_NO_PYTEST: '1' });
    expect(results[0]?.outcome).toBe('error');
    expect(results[0]?.exception?.type).toMatch(/ValueError|ImportError|ModuleNotFoundError/);
  });
});

describe.skipIf(!havePytest)('pytest mode with real pytest in-process', () => {
  it('honours node ids, parametrisation, skip and raises; the buggy line ranks first', async () => {
    const ids = [
      ...CALC_IDS,
      'test_calc_pytest.py::test_median_param[xs0-1]',
      'test_calc_pytest.py::test_median_param[xs1-1.5]',
      'test_calc_pytest.py::test_skipped',
      'test_calc_pytest.py::test_raises',
      'test_calc_pytest.py::nope',
    ];
    const { results, raw } = await trace(PYPROJ, ['calc.py'], pytestIds(ids), 10);
    expect(raw.code).toBe(0);
    expect(results.map((r) => r.id)).toEqual(ids);
    const m = byId(results);
    expect(m.get('test_calc_pytest.py::test_median_param[xs0-1]')).toMatchObject({ outcome: 'pass', lines: { 'calc.py': [11, 13, 14, 15, 16, 17] } });
    expect(m.get('test_calc_pytest.py::test_median_param[xs1-1.5]')).toMatchObject({ outcome: 'error', exception: { type: 'IndexError' }, lines: { 'calc.py': [11, 13, 14, 15, 16, 18] } });
    expect(m.get('test_calc_pytest.py::test_skipped')).toMatchObject({ outcome: 'skip', exception: { type: 'Skipped' }, lines: { 'calc.py': [] } });
    expect(m.get('test_calc_pytest.py::test_raises')).toMatchObject({ outcome: 'pass', lines: { 'calc.py': [11, 12] } });
    expect(m.get('test_calc_pytest.py::nope')).toMatchObject({ outcome: 'error', exception: { type: 'PytestError' } });
    expect(m.get('test_calc_pytest.py::nope')?.log).toContain('not found');
    expect(m.get('test_calc.py::test_median_even')?.exception?.message).toContain('assert 3.5 == 2.5');
    expect(m.get('test_calc.py::test_median_even')?.log).toContain('FAILURES');
    expect(m.get('test_calc.py::test_mean')?.log).toBeUndefined();
    // the same eight test_calc.py tests agree with the fallback runner
    expectCalcOutcomes(results.filter((r) => r.id.startsWith('test_calc.py::')));
    // with the extra failing parametrised case the bug is still rank 1
    expect(rankOf(rankLines(results), 'calc.py', 18)).toBe(1);
  });
});

describe.skipIf(!havePython)('timeouts', () => {
  it('call mode: an infinite loop is reported as timeout with the lines executed so far', async () => {
    const tests: TestSpec[] = [{ mode: 'call', id: 'spin', module: 'spin', fn: 'spin', args: [], expected: null }];
    const { results, raw } = await trace(TIMEOUT, ['spin.py'], tests, 0.5);
    expect(raw.code).toBe(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'timeout', exception: { type: 'Timeout', message: 'exceeded 0.5 s' } });
    expect(results[0]!.lines['spin.py']).toContain(7); // `n += 1` inside `while True` (3.9 emits no line event for the loop header)
    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(400);
    expect(results[0]!.durationMs).toBeLessThan(3000);
    expect(raw.durationMs).toBeLessThan(5000);
  });

  it('pytest mode: the alarm surfaces through the runner as timeout', async () => {
    const { results, raw } = await trace(TIMEOUT, ['spin.py'], pytestIds(['test_spin.py::test_spin']), 0.5);
    expect(results[0]).toMatchObject({ id: 'test_spin.py::test_spin', outcome: 'timeout', exception: { type: 'Timeout' } });
    expect(results[0]!.lines['spin.py']).toContain(7);
    expect(raw.durationMs).toBeLessThan(5000);
  });

  it('the parent kills a child whose alarm cannot fire (SIGALRM blocked) after timeout + grace', async () => {
    const tests: TestSpec[] = [{ mode: 'call', id: 'block', module: 'block', fn: 'block', args: [], expected: null }];
    const { results, raw } = await trace(TIMEOUT, ['block.py'], tests, 0.5);
    expect(raw.code).toBe(0);
    expect(results[0]).toMatchObject({ outcome: 'timeout', lines: { 'block.py': [] } });
    expect(results[0]!.exception?.message).toContain('killed by the parent');
    expect(raw.durationMs).toBeGreaterThanOrEqual(2000);
    expect(raw.durationMs).toBeLessThan(8000);
  });
});

describe.skipIf(!havePython)('spec validation', () => {
  it('rejects a bad mode with exit code 2 and a message on stderr', async () => {
    const raw = await runTracer({ mode: 'nope', cwd: PYPROJ, files: [], tests: [] });
    expect(raw.code).toBe(2);
    expect(raw.stderr).toContain('bad spec: mode must be "pytest" or "call"');
    expect(raw.stdout).toBe('');
  });

  it('rejects call tests without module/fn/expected and pytest ids that are not strings', async () => {
    const r1 = await runTracer({ mode: 'call', cwd: PYPROJ, files: ['calc.py'], tests: [{ id: 'x', module: 'calc' }], timeoutSec: 1 });
    expect(r1.code).toBe(2);
    expect(r1.stderr).toContain('tests[0].fn must be a string');
    const r2 = await runTracer({ mode: 'pytest', cwd: PYPROJ, files: ['calc.py'], tests: [{ id: 5 }], timeoutSec: 1 });
    expect(r2.code).toBe(2);
    expect(r2.stderr).toContain('tests[0].id must be a string');
    const r3 = await runTracer({ mode: 'pytest', cwd: PYPROJ, files: ['calc.py'], tests: [], timeoutSec: 0 });
    expect(r3.code).toBe(2);
    expect(r3.stderr).toContain('timeoutSec must be a positive number');
  });

  it('an empty test list is a valid spec that prints nothing', async () => {
    const raw = await runTracer({ mode: 'pytest', cwd: PYPROJ, files: ['calc.py'], tests: [], timeoutSec: 1 });
    expect(raw.code).toBe(0);
    expect(raw.stdout).toBe('');
  });
});
