import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { TestCommand } from '../../../../src/core/types.js';
import { detectFormat, scopedTestCommand, summarize } from '../../../../src/synth/verify/index.js';
import { expectationFromTraceback, isTestFile, looksLikeSympy, looksLikeUnittest, parseSympyOutput, parseUnittestOutput, relatedTestFiles, summaryFromSympy, summaryFromUnittest } from '../../../../src/synth/verify/runners.js';
import { detectTestCommand } from '../../../../src/workspace/tests.js';
import type { ManifestReader } from '../../../../src/workspace/tests.js';
import { FIXTURES, fixture } from './helpers.js';

const ctx = { command: 'python tests/runtests.py --parallel 1 decorators', exitCode: 1, timedOut: false, durationMs: 20, outputTail: '' };
const WS_OUT = join(FIXTURES, '..', '..', 'workspace', 'test-output');
const wsOut = (name: string): string => readFileSync(join(WS_OUT, name), 'utf8');

describe('Django runtests.py --verbosity 2 (unittest TextTestRunner)', () => {
  const parse = parseUnittestOutput(fixture('django-v2.txt'));
  const s = summaryFromUnittest(parse, ctx);

  it('counts from `Ran 8 tests` + `FAILED (failures=1, errors=1, skipped=1, expected failures=1)`; expected failures are skipped', () => {
    expect(parse.counts).toEqual({ ran: 8, failures: 1, errors: 1, skipped: 1, expectedFailures: 1, unexpectedSuccesses: 0, found: true });
    expect({ passed: s.passed, failed: s.failed, errors: s.errors, skipped: s.skipped, total: s.total }).toEqual({ passed: 4, failed: 1, errors: 1, skipped: 2, total: 8 });
  });
  it('ids are dotted runtests.py labels; a docstring status on the next line and a glued `ok` are read', () => {
    expect(s.failing).toEqual(['decorators.tests.DecoratorsTest.test_attributes', 'decorators.tests.MethodDecoratorTests.test_class_decoration']);
    expect(s.passing).toEqual([
      'decorators.tests.DecoratorsTest.test_bad_iterable',
      'decorators.tests.DecoratorsTest.test_cache_page',
      'decorators.tests.MethodDecoratorTests.test_descriptors',
      'decorators.tests.MethodDecoratorTests.test_new_attribute',
    ]);
    expect(parse.statuses.get('decorators.tests.DecoratorsTest.test_deny_login_required')).toBe('skipped');
    expect(parse.statuses.get('decorators.tests.MethodDecoratorTests.test_wrapper_assignments')).toBe('expected failure');
  });
  it('expected / actual from the FAIL / ERROR sections', () => {
    expect(s.failures[0]).toEqual({ testId: 'decorators.tests.DecoratorsTest.test_attributes', call: 'decorators.tests.DecoratorsTest.test_attributes', expected: "'method'", actual: "'inner'" });
    expect(s.failures[1]).toMatchObject({ testId: 'decorators.tests.MethodDecoratorTests.test_class_decoration', expected: '', actual: "TypeError: 'NoneType' object is not callable" });
  });
  it('verbosity 1 (dots): ids come from the sections only, counts from the summary', () => {
    const q = summaryFromUnittest(parseUnittestOutput(wsOut('django.txt')), ctx);
    expect({ passed: q.passed, failed: q.failed, errors: q.errors, skipped: q.skipped, total: q.total }).toEqual({ passed: 1, failed: 1, errors: 1, skipped: 0, total: 3 });
    expect(q.failing).toEqual(['decorators.tests.MethodDecoratorTests.test_class_decoration', 'decorators.tests.DecoratorsTest.test_attributes']);
    expect(q.passing).toEqual([]);
  });
  it('summarize() recognises the format and keeps the exit status consistent', () => {
    expect(detectFormat('', fixture('django-v2.txt'))).toBe('unittest');
    expect(detectFormat('', wsOut('django.txt'))).toBe('unittest');
    const full = summarize(ctx.command, { stdout: fixture('django-v2.txt'), exitCode: 1 }, 30);
    expect(full.failing).toEqual(s.failing);
    expect(full.failing).not.toContain('<test run>');
    // `python -m pytest` in a Django checkout: exit 1 in 80 ms with no tests (the live run's failure mode)
    const wrongRunner = summarize('python3 -m pytest -q', { stdout: '', stderr: 'ERROR: usage: pytest [options]\nno tests ran\n', exitCode: 4 }, 84);
    expect(wrongRunner.failing).toEqual(['<test run>']);
    // a green run
    const ok = summarize(ctx.command, { stdout: 'test_a (m.C) ... ok\n\n----------------------------------------------------------------------\nRan 1 test in 0.001s\n\nOK\n', exitCode: 0 }, 5);
    expect(ok).toMatchObject({ passed: 1, failed: 0, errors: 0, total: 1, failing: [], passing: ['m.C.test_a'] });
  });
});

describe('python -m unittest -v', () => {
  const parse = parseUnittestOutput(fixture('unittest-v.txt'));
  const s = summaryFromUnittest(parse, { ...ctx, command: 'python3 -m unittest discover -v' });
  it('counts, ids and messages', () => {
    expect({ passed: s.passed, failed: s.failed, errors: s.errors, skipped: s.skipped, total: s.total }).toEqual({ passed: 2, failed: 2, errors: 1, skipped: 2, total: 7 });
    expect(s.failing).toEqual(['tests.test_sample.SampleTests.test_docstring', 'tests.test_sample.SampleTests.test_error', 'tests.test_sample.SampleTests.test_fail_eq']);
    expect(s.passing).toEqual(['tests.test_sample.OtherTests.test_other_pass', 'tests.test_sample.SampleTests.test_pass']);
    expect(s.failures.find((f) => f.testId.endsWith('test_fail_eq'))).toMatchObject({ expected: "'hello there'", actual: "'hello world'" });
    expect(s.failures.find((f) => f.testId.endsWith('test_docstring'))).toMatchObject({ expected: '', actual: 'False is not true' });
    expect(s.failures.find((f) => f.testId.endsWith('test_error'))).toMatchObject({ expected: '', actual: 'ValueError: boom 42' });
  });
  it('Python ≥ 3.11 ids `test_x (mod.C.test_x)`, unexpected successes, a killed run without the summary', () => {
    const p = parseUnittestOutput('test_a (m.C.test_a) ... ok\ntest_b (m.C.test_b) ... unexpected success\ntest_c (m.C.test_c) ... FAIL\n');
    expect([...p.statuses.keys()]).toEqual(['m.C.test_a', 'm.C.test_b', 'm.C.test_c']);
    expect(looksLikeUnittest(p)).toBe(true);
    const k = summaryFromUnittest(p, ctx);
    expect(k).toMatchObject({ passed: 1, failed: 2, errors: 0, total: 3, failing: ['m.C.test_b', 'm.C.test_c'] });
    expect(k.failures[0]).toMatchObject({ testId: 'm.C.test_b', actual: 'unexpected success' });
    expect(k.failures[1]).toMatchObject({ testId: 'm.C.test_c', actual: 'failed: no details in the output' });
    expect(looksLikeUnittest(parseUnittestOutput('nothing\n'))).toBe(false);
  });
  it('expectationFromTraceback reads the final exception of a chained traceback and custom messages', () => {
    expect(expectationFromTraceback(['Traceback (most recent call last):', '  File "x.py", line 1, in f', '    g()', 'KeyError: 1', '', 'During handling of the above exception, another exception occurred:', '', 'Traceback (most recent call last):', '  File "x.py", line 3, in f', '    raise ValueError("b")', 'ValueError: b'])).toEqual({ expected: '', actual: 'ValueError: b' });
    expect(expectationFromTraceback(['Traceback (most recent call last):', '  File "x.py", line 1, in f', "AssertionError: 1 != 2 : counts differ"])).toEqual({ expected: '2', actual: '1' });
    expect(expectationFromTraceback([])).toEqual({ expected: '', actual: '' });
  });
});

describe('sympy bin/test', () => {
  const sctx = { ...ctx, command: 'python bin/test sympy/utilities/tests/test_lambdify.py' };
  it('--verbose: one line per test; ids are `path.py:test_name` (the runner\'s own header form)', () => {
    const parse = parseSympyOutput(fixture('sympy-verbose.txt'));
    expect(parse.started).toBe(true);
    expect(parse.counts).toEqual({ passed: 4, failed: 1, skipped: 1, xfailed: 1, xpassed: 1, exceptions: 1, found: true });
    const s = summaryFromSympy(parse, sctx);
    expect({ passed: s.passed, failed: s.failed, errors: s.errors, skipped: s.skipped, total: s.total }).toEqual({ passed: 5, failed: 1, errors: 1, skipped: 2, total: 9 });
    expect(s.failing).toEqual(['sympy/utilities/tests/test_lambdify.py:test_issue_12092', 'sympy/utilities/tests/test_lambdify.py:test_tensorflow_basic']);
    expect(s.passing).toEqual([
      'sympy/utilities/tests/test_lambdify.py:test_no_args',
      'sympy/utilities/tests/test_lambdify.py:test_single_arg',
      'sympy/utilities/tests/test_lambdify.py:test_math',
      'sympy/utilities/tests/test_decorator.py:test_threaded',
      'sympy/utilities/tests/test_decorator.py:test_xthreaded',
    ]);
    expect(parse.statuses.get('sympy/utilities/tests/test_lambdify.py:test_numpy_old')).toBe('s');
    expect(parse.statuses.get('sympy/utilities/tests/test_lambdify.py:test_sympy_lambda')).toBe('f');
    expect(s.failures[0]).toEqual({ testId: 'sympy/utilities/tests/test_lambdify.py:test_issue_12092', call: 'sympy/utilities/tests/test_lambdify.py:test_issue_12092', expected: '', actual: 'AssertionError' });
    expect(s.failures[1]).toMatchObject({ testId: 'sympy/utilities/tests/test_lambdify.py:test_tensorflow_basic', actual: "ModuleNotFoundError: No module named 'tensorflow'" });
  });
  it('quiet: status characters carry the counts, the failure headers carry the ids', () => {
    const parse = parseSympyOutput(wsOut('sympy.txt'));
    expect(parse.anonymous).toEqual({ passed: 88, failed: 1, errors: 1, skipped: 2 });
    const s = summaryFromSympy(parse, sctx);
    expect({ passed: s.passed, failed: s.failed, errors: s.errors, skipped: s.skipped, total: s.total }).toEqual({ passed: 88, failed: 1, errors: 1, skipped: 2, total: 92 });
    expect(s.failing).toEqual(['sympy/utilities/tests/test_lambdify.py:test_issue_12092', 'sympy/utilities/tests/test_lambdify.py:test_tensorflow_basic']);
    expect(s.passing).toEqual([]);
    // without the summary line (killed run) the characters are all there is
    const killed = summaryFromSympy(parseSympyOutput(wsOut('sympy.txt').split('\n').slice(0, 12).join('\n')), sctx);
    expect(killed).toMatchObject({ passed: 88, failed: 1, errors: 1, skipped: 2, total: 92, failing: [] });
  });
  it('a file that fails to import is one exception keyed by its path', () => {
    const s = summaryFromSympy(parseSympyOutput(fixture('sympy-import-error.txt')), sctx);
    expect(s).toMatchObject({ passed: 0, failed: 0, errors: 1, total: 1, failing: ['sympy/utilities/tests/test_lambdify.py'], passing: [] });
    expect(s.failures[0]).toMatchObject({ expected: '', actual: "ImportError: cannot import name 'lambdastr'" });
  });
  it('ANSI colours are stripped; the all-pass shape; detectFormat and summarize agree', () => {
    const coloured = '===== test process starts =====\n\nsympy/a/tests/test_a.py[2]\ntest_one \u001b[32mok\u001b[0m\ntest_two \u001b[31mF\u001b[0m   \u001b[31m[FAIL]\u001b[0m\n\n____\n__ sympy/a/tests/test_a.py:test_two __\nTraceback (most recent call last):\n    assert 1 == 2\nAssertionError\n\n= tests finished: 1 passed, 1 failed, in 0.10 seconds =\nDO *NOT* COMMIT!\n';
    const s = summaryFromSympy(parseSympyOutput(coloured), sctx);
    expect(s).toMatchObject({ passed: 1, failed: 1, total: 2, failing: ['sympy/a/tests/test_a.py:test_two'], passing: ['sympy/a/tests/test_a.py:test_one'] });
    expect(summaryFromSympy(parseSympyOutput(wsOut('sympy-pass.txt')), sctx)).toMatchObject({ passed: 24, failed: 0, errors: 0, total: 24, failing: [] });
    expect(detectFormat('', fixture('sympy-verbose.txt'))).toBe('sympy_bintest');
    expect(detectFormat('', wsOut('sympy-pass.txt'))).toBe('sympy_bintest');
    expect(detectFormat('', fixture('pytest-rA.txt'))).toBe('pytest');
    expect(looksLikeSympy(parseSympyOutput('random text\n'))).toBe(false);
    const full = summarize(sctx.command, { stdout: fixture('sympy-verbose.txt'), exitCode: 1 }, 30);
    expect(full.failing).toHaveLength(2);
    expect(full.failing).not.toContain('<test run>');
    expect(summarize(sctx.command, { stdout: wsOut('sympy-pass.txt'), exitCode: 0 }, 30).failing).toEqual([]);
  });
});

describe('scopedTestCommand', () => {
  const MANIFESTS = join(FIXTURES, '..', '..', 'workspace', 'manifests');
  function readerFor(dir: string): ManifestReader {
    return {
      async read(rel) {
        try {
          return readFileSync(join(dir, rel), 'utf8');
        } catch {
          return null;
        }
      },
      async list(rel) {
        try {
          return (await import('node:fs')).readdirSync(join(dir, rel));
        } catch {
          return null;
        }
      },
    };
  }
  it('django: the detected command plus dotted labels', async () => {
    const info = (await detectTestCommand(readerFor(join(MANIFESTS, 'django-runtests'))))!;
    expect(scopedTestCommand(info, ['tests/decorators/tests.py'])).toBe('python3 tests/runtests.py --parallel 1 decorators.tests');
    expect(scopedTestCommand(info, ['tests/decorators/tests.py::DecoratorsTest::test_attributes'])).toBe('python3 tests/runtests.py --parallel 1 decorators.tests.DecoratorsTest.test_attributes');
    expect(scopedTestCommand(info, [])).toBe('python3 tests/runtests.py --parallel 1');
  });
  it('sympy: paths, and -k for test names', async () => {
    const info = (await detectTestCommand(readerFor(join(MANIFESTS, 'sympy-bintest'))))!;
    expect(scopedTestCommand(info, ['sympy/utilities/tests/test_lambdify.py'])).toBe('python3 bin/test sympy/utilities/tests/test_lambdify.py');
    expect(scopedTestCommand(info, ['sympy/utilities/tests/test_lambdify.py:test_issue_12092'])).toBe('python3 bin/test sympy/utilities/tests/test_lambdify.py -k test_issue_12092');
  });
  it('requests (pytest): the node id appended', async () => {
    const info = (await detectTestCommand(readerFor(join(MANIFESTS, 'root-tests'))))!;
    expect(scopedTestCommand(info, ['test_requests.py::RequestsTestCase::test_no_content_length'])).toBe('python3 -m pytest -q test_requests.py::RequestsTestCase::test_no_content_length');
  });
  it('a command without a scope builder falls back to its runner, then to quoted paths', () => {
    const django: TestCommand = { command: 'python tests/runtests.py --parallel 1', runner: 'django' };
    expect(scopedTestCommand(django, ['tests/decorators/tests.py'])).toBe('python tests/runtests.py --parallel 1 decorators.tests');
    const unknown: TestCommand = { command: 'make test', runner: 'unknown' };
    expect(scopedTestCommand(unknown, ['tests/a.py'])).toBe("make test 'tests/a.py'");
    const own: TestCommand = { command: 'x', runner: 'pytest', scope: (t) => `custom ${t.join('+')}` };
    expect(scopedTestCommand(own, ['a', 'b'])).toBe('custom a+b');
  });
});

describe('relatedTestFiles (code only, bounded)', () => {
  it('django: a directory named after the module, test_<module>.py files, and the import check', () => {
    const files = [
      'django/utils/decorators.py',
      'django/utils/functional.py',
      'tests/decorators/__init__.py',
      'tests/decorators/tests.py',
      'tests/decorators/models.py',
      'tests/utils_tests/test_decorators.py',
      'tests/utils_tests/test_functional.py',
      'tests/auth_tests/test_decorators.py',
      'tests/runtests.py',
      'tests/urls.py',
      'tests/test_sqlite.py',
      'tests/view_tests/tests/test_debug.py',
    ];
    const byPath = relatedTestFiles(files, ['django/utils/decorators.py']);
    expect(byPath).toEqual(['tests/auth_tests/test_decorators.py', 'tests/utils_tests/test_decorators.py', 'tests/decorators/tests.py']);
    const contents = new Map([
      ['tests/utils_tests/test_decorators.py', 'from django.utils.decorators import method_decorator\n'],
      ['tests/view_tests/tests/test_debug.py', 'from django.utils.decorators import classonlymethod\nimport sys\n'],
      ['tests/auth_tests/test_decorators.py', 'from django.contrib.auth.decorators import login_required\n'],
    ]);
    const withImports = relatedTestFiles(files, ['django/utils/decorators.py'], { contents: (p) => contents.get(p) });
    expect(withImports).toEqual(['tests/utils_tests/test_decorators.py', 'tests/auth_tests/test_decorators.py', 'tests/decorators/tests.py', 'tests/view_tests/tests/test_debug.py']);
  });
  it('sympy: test_<module>.py, then importers, then the package\'s own tests dir', () => {
    const files = ['sympy/utilities/lambdify.py', 'sympy/utilities/tests/__init__.py', 'sympy/utilities/tests/test_lambdify.py', 'sympy/utilities/tests/test_decorator.py', 'sympy/printing/tests/test_lambdarepr.py', 'sympy/core/tests/test_basic.py'];
    expect(relatedTestFiles(files, ['sympy/utilities/lambdify.py'])).toEqual(['sympy/utilities/tests/test_lambdify.py', 'sympy/utilities/tests/test_decorator.py']);
    const contents = (p: string): string | null => (p === 'sympy/printing/tests/test_lambdarepr.py' ? 'from sympy.utilities.lambdify import lambdify\n' : null);
    expect(relatedTestFiles(files, ['sympy/utilities/lambdify.py'], { contents })).toEqual(['sympy/utilities/tests/test_lambdify.py', 'sympy/printing/tests/test_lambdarepr.py', 'sympy/utilities/tests/test_decorator.py']);
  });
  it('requests: the root test module naming the package; QuixBugs: tests/test_<name>.py only', () => {
    expect(relatedTestFiles(['requests/models.py', 'requests/api.py', 'test_requests.py', 'setup.py', 'docs/conf.py'], ['requests/models.py'])).toEqual(['test_requests.py']);
    expect(relatedTestFiles([{ path: 'gcd.py' }, { path: 'tests/test_gcd.py' }, { path: 'tests/test_lcm.py' }, { path: 'node.py' }], ['gcd.py'])).toEqual(['tests/test_gcd.py']);
    expect(relatedTestFiles(['a.py', 'tests/test_b.py'], ['a.py'])).toEqual([]);
    expect(relatedTestFiles(['tests/test_a.py'], [])).toEqual([]);
  });
  it('bounded to 6 (or `max`), never the module files themselves, never __init__ / conftest / runtests', () => {
    const many = Array.from({ length: 12 }, (_, i) => `tests/test_mod_${i}.py`);
    const files = ['pkg/mod.py', 'tests/__init__.py', 'tests/conftest.py', 'tests/runtests.py', 'tests/test_mod.py', ...many];
    const got = relatedTestFiles(files, ['pkg/mod.py']);
    expect(got).toHaveLength(6);
    expect(got[0]).toBe('tests/test_mod.py');
    expect(relatedTestFiles(files, ['pkg/mod.py'], { max: 2 })).toEqual(['tests/test_mod.py', 'tests/test_mod_0.py']);
    expect(isTestFile('tests/__init__.py')).toBe(false);
    expect(isTestFile('tests/conftest.py')).toBe(false);
    expect(isTestFile('tests/decorators/tests.py')).toBe(true);
    expect(isTestFile('test_requests.py')).toBe(true);
    expect(isTestFile('sympy/utilities/lambdify.py')).toBe(false);
  });
});
