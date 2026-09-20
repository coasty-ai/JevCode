import { describe, expect, it } from 'vitest';

import type { FailureView } from '../../../../src/synth/types.js';
import { extractExpectation, parsePytestOutput, sectionFor, sectionNameOf, splitComparison, summaryFromPytest } from '../../../../src/synth/verify/pytest.js';
import { summarize } from '../../../../src/synth/verify/index.js';
import { fixture } from './helpers.js';

const ctx = { command: 'pytest -rA', exitCode: 1, timedOut: false, durationMs: 20, outputTail: '' };
const byId = (s: { failures: FailureView[] }, id: string): FailureView | undefined => s.failures.find((f) => f.testId === `test_sample.py::${id}`);

describe('pytest -rA (16 tests: pass, fail, error, skip, xfail, xpass, class, params)', () => {
  const out = fixture('pytest-rA.txt');
  const parse = parsePytestOutput(out);
  const s = summaryFromPytest(parse, ctx);

  it('counts: xpassed counts as passed, xfailed as skipped; total is the sum', () => {
    expect(parse.counts).toEqual({ passed: 2, failed: 10, errors: 1, skipped: 1, xfailed: 1, xpassed: 1, deselected: 0, found: true });
    expect({ passed: s.passed, failed: s.failed, errors: s.errors, skipped: s.skipped, total: s.total }).toEqual({ passed: 3, failed: 10, errors: 1, skipped: 2, total: 16 });
  });
  it('ids: FAILED + ERROR are failing, PASSED + XPASS are passing, in output order', () => {
    expect(s.passing).toEqual(['test_sample.py::test_pass_one', 'test_sample.py::TestGroup::test_method', 'test_sample.py::test_xpass']);
    expect(s.failing).toHaveLength(11);
    expect(s.failing[0]).toBe('test_sample.py::test_error_fixture');
    expect(s.failing).toContain('test_sample.py::TestGroup::test_method_fail');
    expect(s.failing).toContain('test_sample.py::test_param[13-13-13]');
    expect(s.failures.map((f) => f.testId)).toEqual(s.failing);
  });
  it('expected / actual from assertion introspection', () => {
    expect(byId(s, 'test_fail_eq')).toMatchObject({ expected: '3', actual: '(1 + 1)' });
    expect(byId(s, 'test_fail_str')).toMatchObject({ expected: "'hello there'", actual: "'hello world'" });
    expect(byId(s, 'test_dict')).toMatchObject({ expected: "{'a': 1, 'b': [1, 3]}", actual: "{'a': 1, 'b': [1, 2]}" });
    expect(byId(s, 'test_in_list')).toMatchObject({ expected: 'in [1, 2]', actual: '3' });
    expect(byId(s, 'TestGroup::test_method_fail')).toMatchObject({ expected: '[1, 3]', actual: '[1, 2]' });
  });
  it('the bench modules\' "<call> -> <actual>, expected <expected>" message yields the call', () => {
    expect(byId(s, 'test_bench_style_message')).toEqual({ testId: 'test_sample.py::test_bench_style_message', call: 'gcd(13, 13)', expected: '13', actual: 'None' });
  });
  it('exceptions and fixture errors put the exception line in actual with an empty expected', () => {
    expect(byId(s, 'test_param[13-13-13]')).toMatchObject({ call: 'test_sample.py::test_param[13-13-13]', expected: '', actual: 'RecursionError: maximum recursion depth exceeded in comparison' });
    expect(byId(s, 'test_raises')).toMatchObject({ expected: '', actual: 'ValueError: boom 42' });
    expect(byId(s, 'test_error_fixture')).toMatchObject({ expected: '', actual: "fixture 'missing_fixture' not found" });
  });
  it('sections are keyed by the FAILURES header name, matched from node ids', () => {
    expect(sectionNameOf('test_sample.py::TestGroup::test_method_fail')).toBe('TestGroup.test_method_fail');
    expect(sectionNameOf('test_sample.py::test_param[13-13-13]')).toBe('test_param[13-13-13]');
    expect(sectionNameOf('test_broken.py')).toBe('test_broken.py');
    expect(parse.sections.has('TestGroup.test_method_fail')).toBe(true);
    expect(parse.sections.has('test_error_fixture')).toBe(true);
  });
});

describe('two files with a same-named test and status-shaped lines in captured stdout (-rA)', () => {
  const out = fixture('pytest-two-files.txt');
  const parse = parsePytestOutput(out);
  const s = summaryFromPytest(parse, ctx);

  it('counts: 19 collected, 12 failed, 3 passed (2 + xpass), 1 error, 2 skipped (1 + xfail)', () => {
    expect({ passed: s.passed, failed: s.failed, errors: s.errors, skipped: s.skipped, total: s.total }).toEqual({ passed: 4, failed: 12, errors: 1, skipped: 2, total: 19 });
  });
  it('lines a test printed under PASSES ("FAILED test_ghost.py::…", "… PASSED [ 50%]", "ERROR …") are not tests', () => {
    expect(s.failing.some((id) => id.includes('test_ghost'))).toBe(false);
    expect(s.passing.some((id) => id.includes('test_ghost'))).toBe(false);
    expect(s.failing).toHaveLength(13);
    expect(s.passing).toEqual(['test_sample.py::test_pass_one', 'test_sample.py::TestGroup::test_method', 'test_other.py::test_noisy_pass', 'test_sample.py::test_xpass']);
  });
  it('same-named tests in two files each get their own E lines (the section whose traceback names the file)', () => {
    expect(byId(s, 'test_fail_eq')).toMatchObject({ expected: '3', actual: '(1 + 1)' });
    expect(s.failures.find((f) => f.testId === 'test_other.py::test_fail_eq')).toMatchObject({ expected: '6', actual: '5' });
    expect(sectionFor(parse, 'test_sample.py::test_fail_eq')).toEqual(['assert (1 + 1) == 3']);
    expect(sectionFor(parse, 'test_other.py::test_fail_eq')).toEqual(['assert 5 == 6']);
    expect(parse.sectionList.filter((x) => x.name === 'test_fail_eq').map((x) => x.files)).toEqual([['test_sample.py'], ['test_other.py']]);
    // `sections` keeps the first section of a name; an unknown id falls back to nothing
    expect(parse.sections.get('test_fail_eq')).toEqual(['assert (1 + 1) == 3']);
    expect(sectionFor(parse, 'nope.py::test_nothing')).toEqual([]);
  });
  it('a message containing " - " keeps the id intact and extracts from the E lines', () => {
    expect(s.failures.find((f) => f.testId === 'test_other.py::test_msg_with_dash')).toMatchObject({ expected: "'a - c'", actual: "'a - b'" });
  });
  it('with -s, status-shaped stdout in the progress area is dropped when the summary reports that kind', () => {
    const interleaved = [
      '============================= test session starts ==============================',
      'collected 3 items',
      '',
      'test_a.py::test_one PASSED                                               [ 33%]',
      'FAILED test_ghost.py::test_phantom - assert 1 == 2',
      'test_ghost.py::test_phantom2 PASSED [ 50%]',
      'test_a.py::test_two FAILED                                               [ 66%]',
      'test_a.py::test_three PASSED                                             [100%]',
      '',
      '=========================== short test summary info ============================',
      'PASSED test_a.py::test_one',
      'PASSED test_a.py::test_three',
      'FAILED test_a.py::test_two - assert False',
      '========================= 1 failed, 2 passed in 0.01s ==========================',
    ].join('\n');
    const r = summaryFromPytest(parsePytestOutput(interleaved), ctx);
    expect(r.failing).toEqual(['test_a.py::test_two']);
    expect(r.passing).toEqual(['test_a.py::test_one', 'test_a.py::test_three']);
    // plain -v (summary lists only failures): passing ids still come from the progress lines
    const plainV = interleaved.split('\n').filter((l) => !l.startsWith('PASSED ')).join('\n');
    const r2 = summaryFromPytest(parsePytestOutput(plainV), ctx);
    expect(r2.passing).toEqual(['test_a.py::test_one', 'test_ghost.py::test_phantom2', 'test_a.py::test_three']); // the residual -v-only case, documented
    expect(r2.failing).toEqual(['test_a.py::test_two']);
  });
});

describe('other pytest shapes', () => {
  it('-q: same counts and failing ids, no passing ids, messages from the short summary', () => {
    const s = summaryFromPytest(parsePytestOutput(fixture('pytest-q.txt')), ctx);
    expect({ passed: s.passed, failed: s.failed, errors: s.errors, skipped: s.skipped, total: s.total }).toEqual({ passed: 3, failed: 10, errors: 1, skipped: 2, total: 16 });
    expect(s.passing).toEqual([]);
    expect(s.failing).toHaveLength(11);
    expect(byId(s, 'test_bench_style_message')).toMatchObject({ call: 'gcd(13, 13)', expected: '13', actual: 'None' });
  });
  it('-v --tb=no: ids from the progress lines; truncated short messages are the fallback', () => {
    const s = summaryFromPytest(parsePytestOutput(fixture('pytest-v-tbno.txt')), ctx);
    expect(s.passing).toEqual(['test_sample.py::test_pass_one', 'test_sample.py::test_xpass', 'test_sample.py::TestGroup::test_method']);
    expect(s.failing).toHaveLength(11);
    expect(byId(s, 'test_raises')).toMatchObject({ expected: '', actual: 'ValueError: boom 42' });
    expect(byId(s, 'test_in_list')).toMatchObject({ expected: 'in [1, 2]', actual: '3' });
    expect(byId(s, 'test_error_fixture')?.actual).toBe('error: no details in the output');
  });
  it('-q --tb=line: counts and ids still parse', () => {
    const s = summaryFromPytest(parsePytestOutput(fixture('pytest-q-tbline.txt')), ctx);
    expect(s.total).toBe(16);
    expect(s.failing).toHaveLength(11);
  });
  it('all pass', () => {
    const s = summaryFromPytest(parsePytestOutput(fixture('pytest-allpass.txt')), { ...ctx, exitCode: 0 });
    expect(s).toMatchObject({ passed: 2, failed: 0, errors: 0, skipped: 0, total: 2, failing: [], passing: ['test_ok.py::test_a', 'test_ok.py::test_b'] });
  });
  it('collection error: one error whose id is the module', () => {
    const s = summaryFromPytest(parsePytestOutput(fixture('pytest-collection-error.txt')), { ...ctx, exitCode: 2 });
    expect(s).toMatchObject({ passed: 0, failed: 0, errors: 1, total: 1, failing: ['test_broken.py'] });
    expect(s.failures[0]).toMatchObject({ testId: 'test_broken.py', expected: '', actual: "ModuleNotFoundError: No module named 'nonexistent_module_xyz'" });
  });
  it('pytest -qq (no counts line): the progress characters carry the counts, so a baseline reads its passes and a collection error reads as a loss', () => {
    // `-q` on the command line on top of `addopts = -q` (the ladder tasks' pytest.ini): no "N passed in" line at all
    const qq = ['....FF.FF.                                                               [100%]', '=================================== FAILURES ===================================', '_______________________________ test_total_value _______________________________', '', '    def test_total_value():', '>       assert inv.total_value() == 9.0', 'E       assert 8.5 == 9.0', '', 'tests/test_inventory.py:20: AssertionError', '=========================== short test summary info ============================', 'FAILED tests/test_inventory.py::test_total_value - assert 8.5 == 9.0', 'FAILED tests/test_inventory.py::test_total_value_single_item - assert 4.25 == 3.0', 'FAILED tests/test_inventory.py::test_page_first - AssertionError', 'FAILED tests/test_inventory.py::test_page_last_partial - AssertionError', ''].join('\n');
    const s = summaryFromPytest(parsePytestOutput(qq), { ...ctx, command: 'python3 -m pytest -q' });
    expect(s).toMatchObject({ passed: 6, failed: 4, errors: 0, total: 10 });
    expect(s.failing).toHaveLength(4);
    // several files, each with its own progress line; E, s, x and X are read as pytest prints them
    const multi = 'tests/test_a.py ..F.s  [ 71%]\ntests/test_b.py E.xX  [100%]\n';
    expect(parsePytestOutput(multi).counts).toMatchObject({ passed: 4, failed: 1, errors: 1, skipped: 1, xfailed: 1, xpassed: 1, found: true });
    // a counts line, when present, still wins over the progress characters
    expect(parsePytestOutput('..F  [100%]\n1 failed, 2 passed in 0.01s\n').counts).toMatchObject({ passed: 2, failed: 1, found: true });
    // no progress line and no counts line: nothing is invented
    expect(parsePytestOutput('Traceback (most recent call last):\n  boom\n').counts.found).toBe(false);
  });
  it('no tests ran: total 0, counts found', () => {
    const parse = parsePytestOutput(fixture('pytest-no-tests.txt'));
    expect(parse.counts.found).toBe(true);
    expect(summaryFromPytest(parse, { ...ctx, exitCode: 5 }).total).toBe(0);
  });
  it('a run killed before the session summary: counts fall back to the ids seen', () => {
    const partial = 'test_x.py::test_a PASSED [ 50%]\ntest_x.py::test_b FAILED [100%]\n';
    const s = summaryFromPytest(parsePytestOutput(partial), ctx);
    expect(s).toMatchObject({ passed: 1, failed: 1, errors: 0, total: 2, failing: ['test_x.py::test_b'], passing: ['test_x.py::test_a'] });
  });
  it('garbage is not pytest', () => {
    const parse = parsePytestOutput('hello\nworld\n');
    expect(parse.counts.found).toBe(false);
    expect(parse.statuses.size).toBe(0);
  });
});

describe('extraction helpers', () => {
  it('splitComparison', () => {
    expect(splitComparison('1 == 2')).toEqual({ actual: '1', expected: '2' });
    expect(splitComparison("'a' != 'a'")).toEqual({ actual: "'a'", expected: "!= 'a'" });
    expect(splitComparison('3 in [1, 2]')).toEqual({ actual: '3', expected: 'in [1, 2]' });
    expect(splitComparison('x is None')).toEqual({ actual: 'x', expected: 'is None' });
    expect(splitComparison('f(a == b) < 3')).toEqual({ actual: 'f(a', expected: 'b) < 3' }); // first operator wins; introspection lines are flat
    expect(splitComparison('False')).toEqual({ actual: 'False', expected: '' });
  });
  it('extractExpectation prefers the bench message, then assert, then the first line; bounded', () => {
    expect(extractExpectation(['AssertionError: custom', 'assert 1 == 2'])).toEqual({ call: null, actual: '1', expected: '2' });
    expect(extractExpectation(['AssertionError: sqrt(2, 0.01) -> 1.0, expected 1.4142 +/- 0.01', 'assert False'])).toEqual({ call: 'sqrt(2, 0.01)', actual: '1.0', expected: '1.4142 +/- 0.01' });
    expect(extractExpectation([], 'ValueError: boom')).toEqual({ call: null, actual: 'ValueError: boom', expected: '' });
    expect(extractExpectation([])).toEqual({ call: null, actual: '', expected: '' });
    const long = `assert ${'x'.repeat(500)} == 1`;
    const ex = extractExpectation([long]);
    expect(ex.actual.length).toBe(240);
    expect(ex.actual.endsWith('…')).toBe(true);
  });
});

describe('summarize() wraps the pytest path', () => {
  it('stdout + stderr are combined for parsing and the tail is bounded', () => {
    const s = summarize('pytest -q', { stdout: fixture('pytest-q.txt'), stderr: 'warning: something', exitCode: 1 }, 42);
    expect(s.total).toBe(16);
    expect(s.durationMs).toBe(42);
    expect(s.outputTail.endsWith('warning: something')).toBe(true);
    expect(s.outputTail.length).toBeLessThanOrEqual(4000);
    expect(s.command).toBe('pytest -q');
  });
});
