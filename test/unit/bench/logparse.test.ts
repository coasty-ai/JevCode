import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTestsReport, evaluateLog, gradeLog, parseLogDjango, parseLogPytest, parseLogPytestOptions, parseLogSympy, parseTestExitCode, resolveCase, selectParser, testFailed, testMaintained, testPassed } from '../../../src/bench/swebench/logparse.js';

const fixture = (name: string): string => readFileSync(join(process.cwd(), 'test', 'fixtures', 'bench', 'logs', name), 'utf8');

describe('parse_log_pytest port', () => {
  const sm = parseLogPytest(fixture('pytest.txt'));
  it('maps status lines and strips the " - message" of FAILED', () => {
    expect(sm['testing/test_setuponly.py::test_show_only_active_fixtures[--setup-only]']).toBe('PASSED');
    expect(sm['testing/test_setuponly.py::test_show_nested_fixtures[--setup-only]']).toBe('FAILED');
    expect(sm['testing/test_setuponly.py::test_broken_fixture']).toBe('ERROR');
    expect(sm['testing/test_setuponly.py::test_expected_failure']).toBe('XFAIL');
    expect(sm['testing/test_setuponly.py::test_skipped_explicitly']).toBe('SKIPPED');
  });
  it('ignores the SKIPPED [N] summary line', () => {
    expect(Object.keys(sm).some((k) => k.startsWith('['))).toBe(false);
  });
  it('pytest_options reduces path parameters to their basename', () => {
    const o = parseLogPytestOptions(fixture('pytest_all_pass.txt'));
    expect(o['tests/test_functional.py::test_functional[/abstract_class.py]']).toBe('PASSED');
    expect(o['tests/checkers/unittest_variables.py::TestVariablesChecker::test_bitbucket_issue_78']).toBe('PASSED');
  });
});

describe('parse_log_django port', () => {
  const sm = parseLogDjango(fixture('django.txt'));
  it('handles docstring ids, ok/FAIL/ERROR/skipped and the split "ok" line', () => {
    expect(sm['@method_decorator preserves wrapper assignments.']).toBe('FAILED');
    expect(sm['test_bad_iterable (decorators.tests.DecoratorsTest)']).toBe('PASSED');
    expect(sm["test_deny_login_required (decorators.tests.DecoratorsTest)"]).toBe('SKIPPED');
    expect(sm['test_class_decoration (decorators.tests.MethodDecoratorTests)']).toBe('ERROR');
    expect(sm['test_new_attribute (decorators.tests.MethodDecoratorTests)']).toBe('PASSED');
    expect(sm['test_descriptors (decorators.tests.MethodDecoratorTests)']).toBe('PASSED');
    expect(sm['--version is equivalent to version']).toBe('PASSED');
    expect(sm['test_attributes']).toBe('FAILED');
  });
});

describe('parse_log_sympy port', () => {
  const sm = parseLogSympy(fixture('sympy.txt'));
  it('maps ok/F/E lines and the failure header', () => {
    expect(sm['test_no_args']).toBe('PASSED');
    expect(sm['test_issue_12092']).toBe('FAILED');
    expect(sm['test_docs']).toBe('ERROR');
    expect(sm['sympy/utilities/tests/test_lambdify.py:test_issue_12092']).toBe('FAILED');
    // upstream keys on the exact ' ok' suffix; a trailing '[FAIL]' marker is not a pass
    expect(sm['test_special_printers']).toBeUndefined();
  });
});

describe('grading', () => {
  it('prefix-matches truncated parametrized ids only when candidates agree', () => {
    const sm = { 'test_a[log(photon': 'PASSED', 'test_b[x-1]': 'PASSED', 'test_b[x-2]': 'FAILED', 'test_c[y-1]': 'XFAIL', 'test_c[y-2]': 'PASSED' } as const;
    expect(resolveCase('test_a[log(photon', sm)).toBe('test_a[log(photon');
    expect(resolveCase('test_b[x', sm)).toBeNull();
    expect(resolveCase('test_c[y', sm)).toBe('test_c[y-1]');
    expect(resolveCase('test_c', sm)).toBeNull();
    expect(testPassed('test_c[y', sm)).toBe(true);
  });
  it('SKIPPED F2P = fail, SKIPPED P2P = ok, missing = fail', () => {
    const sm = { t_skip: 'SKIPPED', t_pass: 'PASSED' } as const;
    expect(testFailed('t_skip', sm)).toBe(true);
    expect(testPassed('t_skip', sm)).toBe(false);
    expect(testMaintained('t_skip', sm)).toBe(true);
    expect(testFailed('t_missing', sm)).toBe(true);
    const rep = buildTestsReport(sm, { failToPass: ['t_skip', 't_pass'], passToPass: ['t_skip', 't_missing'] });
    expect(rep.testsStatus.FAIL_TO_PASS).toEqual({ success: ['t_pass'], failure: ['t_skip'] });
    expect(rep.testsStatus.PASS_TO_PASS).toEqual({ success: ['t_skip'], failure: ['t_missing'] });
    expect(rep.resolved).toBe(false);
    expect(buildTestsReport(sm, { failToPass: ['t_pass'], passToPass: ['t_skip'] }).resolved).toBe(true);
  });
  it('FULL rule on the fixture logs', () => {
    const py = gradeLog(fixture('pytest.txt'), parseLogPytest, { failToPass: ['testing/test_setuponly.py::test_show_only_active_fixtures[--setup-only]'], passToPass: ['testing/test_setuponly.py::test_skipped_explicitly'] });
    expect(py.valid && py.resolved).toBe(true);
    const py2 = gradeLog(fixture('pytest.txt'), parseLogPytest, { failToPass: ['testing/test_setuponly.py::test_show_nested_fixtures[--setup-only]'], passToPass: [] });
    expect(py2.valid && !py2.resolved).toBe(true);
    if (py2.valid) expect(py2.testsStatus.FAIL_TO_PASS.failure).toEqual(['testing/test_setuponly.py::test_show_nested_fixtures[--setup-only]']);
    const dj = gradeLog(fixture('django.txt'), parseLogDjango, { failToPass: ['@method_decorator preserves wrapper assignments.'], passToPass: ['test_bad_iterable (decorators.tests.DecoratorsTest)'] });
    expect(dj.valid && dj.resolved).toBe(false);
    const sy = gradeLog(fixture('sympy.txt'), parseLogSympy, { failToPass: ['test_no_args'], passToPass: ['test_math'] });
    expect(sy.valid && sy.resolved).toBe(true);
    expect(sy.exitCode).toBe(1);
  });
  it('non-zero exit with no FAILED/ERROR in the log invalidates the run (anti-spoofing)', () => {
    const ev = evaluateLog(fixture('pytest_spoofed.txt'), parseLogPytest);
    expect(ev.valid).toBe(false);
    if (!ev.valid) expect(ev.reason).toMatch(/exited 2/);
    expect(parseTestExitCode(fixture('pytest_spoofed.txt'))).toBe(2);
    const ok = evaluateLog(fixture('pytest_all_pass.txt'), parseLogPytestOptions);
    expect(ok.valid).toBe(true);
  });
  it('bad markers and missing output markers invalidate', () => {
    expect(evaluateLog(">>>>> Patch Apply Failed\n: '>>>>> Start Test Output'\nPASSED a::b\n: '>>>>> End Test Output'", parseLogPytest).valid).toBe(false);
    expect(evaluateLog('PASSED a::b\n', parseLogPytest).valid).toBe(false);
    expect(evaluateLog(">>>>> Start Test Output\nnothing here\n>>>>> End Test Output\n>>>>> Test Exit Code: 0", parseLogPytest).valid).toBe(false);
  });
  it('selects parsers by record name then repo', () => {
    expect(selectParser('parse_log_pylint', 'pylint-dev/pylint')).toBe(parseLogPytestOptions);
    expect(selectParser('unknown', 'django/django')).toBe(parseLogDjango);
    expect(selectParser(undefined, 'nobody/repo')).toBeNull();
  });
});
