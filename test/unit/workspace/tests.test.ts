import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { TestCommand, TestRunner } from '../../../src/core/types.js';
import {
  detectTestCommand,
  djangoLabel,
  moduleOfPath,
  parseCargo,
  parseDjango,
  parseGo,
  parseJest,
  parsePytest,
  parseSympyBinTest,
  parseTestOutput,
  parseUnittest,
  parseVitest,
  runnerFromCommand,
  scopeBuilderFor,
  SPEC_FILE,
  sympyTarget,
  unittestLabel,
  unittestModuleLabel,
} from '../../../src/workspace/tests.js';
import type { ManifestReader } from '../../../src/workspace/tests.js';
import { FIXTURES } from './helpers.js';

const out = (name: string): string => readFileSync(join(FIXTURES, 'test-output', name), 'utf8');

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
        return readdirSync(join(dir, rel));
      } catch {
        return null;
      }
    },
  };
}

/** command + runner only: `scope` is a function and differs per call */
const shape = (tc: TestCommand | null): { command: string; runner: TestRunner } | null => (tc === null ? null : { command: tc.command, runner: tc.runner });

describe('parsers from fixtures', () => {
  it('pytest mixed summary', () => {
    expect(parsePytest(out('pytest-mixed.txt'))).toEqual({ passed: 4, failed: 1, errors: 1, skipped: 1 });
    expect(parsePytest(out('pytest-pass.txt'))).toEqual({ passed: 5, failed: 0, errors: 0, skipped: 0 });
    expect(parsePytest(out('pytest-none.txt'))).toEqual({ passed: 0, failed: 0, errors: 0, skipped: 0 });
    expect(parsePytest('nothing here')).toBeNull();
    expect(parsePytest('===== 2 passed, 3 warnings in 1.00s (0:00:01) =====')).toEqual({ passed: 2, failed: 0, errors: 0, skipped: 0 });
  });

  it('jest / vitest / cargo / go', () => {
    expect(parseJest(out('jest.txt'))).toEqual({ passed: 7, failed: 1, errors: 0, skipped: 2 });
    expect(parseVitest(out('vitest.txt'))).toEqual({ passed: 3, failed: 1, errors: 0, skipped: 1 });
    expect(parseVitest(out('vitest-pass.txt'))).toEqual({ passed: 3, failed: 0, errors: 0, skipped: 0 });
    expect(parseCargo(out('cargo.txt'))).toEqual({ passed: 3, failed: 1, errors: 0, skipped: 1 });
    expect(parseGo(out('go.txt'))).toEqual({ passed: 1, failed: 1, errors: 0, skipped: 1 });
    expect(parseJest(out('vitest.txt'))).toBeNull();
  });

  it('Django runtests.py (unittest TextTestRunner): `Ran 3 tests` + `FAILED (failures=1, errors=1)`', () => {
    expect(parseDjango(out('django.txt'))).toEqual({ passed: 1, failed: 1, errors: 1, skipped: 0 });
    expect(parseUnittest(out('unittest.txt'))).toEqual({ passed: 2, failed: 2, errors: 1, skipped: 2 });
    expect(parseUnittest('...\n----------------------------------------------------------------------\nRan 3 tests in 0.001s\n\nOK\n')).toEqual({ passed: 3, failed: 0, errors: 0, skipped: 0 });
    expect(parseUnittest('Ran 4 tests in 0.001s\n\nOK (skipped=1)\n')).toEqual({ passed: 3, failed: 0, errors: 0, skipped: 1 });
    // unexpected successes fail the run; expected failures are skipped
    expect(parseUnittest('Ran 5 tests in 0.001s\n\nFAILED (expected failures=1, unexpected successes=1)\n')).toEqual({ passed: 3, failed: 1, errors: 0, skipped: 1 });
    // killed before the summary: the verbose status lines, including a docstring's status on the next line and Django's glued `ok`
    const partial = 'test_a (m.C) ... ok\ntest_b (m.C)\nThe docstring. ... FAIL\ntest_c (m.C) ... Testing against Django installed in /x (0 silenced).\nok\ntest_d (m.C) ... skipped \'why\'\ntest_e (m.C) ... ERROR\n';
    expect(parseUnittest(partial)).toEqual({ passed: 2, failed: 1, errors: 1, skipped: 1 });
    expect(parseUnittest('random output\n')).toBeNull();
  });

  it('sympy bin/test: `tests finished: 88 passed, 1 failed, 1 skipped, 1 expected to fail, 1 exceptions` (wrapped)', () => {
    expect(parseSympyBinTest(out('sympy.txt'))).toEqual({ passed: 88, failed: 1, errors: 1, skipped: 2 });
    expect(parseSympyBinTest(out('sympy-pass.txt'))).toEqual({ passed: 24, failed: 0, errors: 0, skipped: 0 });
    expect(parseSympyBinTest('= tests finished: 4 passed, 1 expected to fail but passed, in 1.00 seconds =')).toEqual({ passed: 5, failed: 0, errors: 0, skipped: 0 });
    // killed before the summary: the status characters (quiet) or the --verbose lines, only under the banner
    const quiet = '===== test process starts =====\nexecutable: python\n\nsympy/a/tests/test_a.py[6] ..F.\nsE                    [FAIL]\n';
    expect(parseSympyBinTest(quiet)).toEqual({ passed: 3, failed: 1, errors: 1, skipped: 1 });
    const verbose = '===== test process starts =====\n\nsympy/a/tests/test_a.py[4]\ntest_one ok\ntest_two F\ntest_three Slow w\ntest_four \u001b[31mE\u001b[0m   [FAIL]\n';
    expect(parseSympyBinTest(verbose)).toEqual({ passed: 1, failed: 1, errors: 1, skipped: 1 });
    expect(parseSympyBinTest('sympy/a/tests/test_a.py[6] ..F.\n')).toBeNull();
    expect(parseSympyBinTest('...\n')).toBeNull();
  });

  it('parseTestOutput dispatches by runner, reads the tail, and falls back for npm/unknown', () => {
    const flood = 'x'.repeat(100_000) + '\n' + out('pytest-pass.txt');
    expect(parseTestOutput('pytest', flood)).toEqual({ passed: 5, failed: 0, errors: 0, skipped: 0 });
    expect(parseTestOutput('npm', out('jest.txt'))?.passed).toBe(7);
    expect(parseTestOutput('npm', out('vitest.txt'))?.passed).toBe(3);
    expect(parseTestOutput('unknown', out('cargo.txt'))?.failed).toBe(1);
    expect(parseTestOutput('jest', out('vitest.txt'))?.passed).toBe(3);
    expect(parseTestOutput('go', out('go.txt'))?.skipped).toBe(1);
    expect(parseTestOutput('django', out('django.txt'))).toEqual({ passed: 1, failed: 1, errors: 1, skipped: 0 });
    expect(parseTestOutput('unittest', out('unittest.txt'))?.failed).toBe(2);
    expect(parseTestOutput('sympy_bintest', out('sympy.txt'))?.passed).toBe(88);
    expect(parseTestOutput('unknown', out('django.txt'))?.errors).toBe(1);
    expect(parseTestOutput('unknown', out('sympy.txt'))?.passed).toBe(88);
    expect(parseTestOutput('pytest', out('django.txt'))).toBeNull();
    expect(parseTestOutput('django', out('pytest-pass.txt'))).toBeNull();
    expect(parseTestOutput('pytest', '')).toBeNull();
    expect(parseTestOutput('cargo', out('pytest-pass.txt'))).toBeNull();
    // the last summary wins when a run prints several
    expect(parseTestOutput('pytest', '1 passed in 0.1s\n\n2 failed in 0.2s\n')).toEqual({ passed: 0, failed: 2, errors: 0, skipped: 0 });
  });
});

describe('detectTestCommand from the repository shape', () => {
  const PYTEST = { command: 'python3 -m pytest -q', runner: 'pytest' as const };
  const cases: [string, { command: string; runner: TestRunner } | null][] = [
    ['pytest-ini', PYTEST],
    ['pyproject', PYTEST],
    ['setup-cfg', PYTEST],
    ['tox', PYTEST],
    ['tests-dir', PYTEST],
    // Django-style: tests/runtests.py wins over the tests/test_sqlite.py file that looks like a pytest module
    ['django-runtests', { command: 'python3 tests/runtests.py --parallel 1', runner: 'django' }],
    // sympy-style: bin/test with a python shebang, no pytest configuration
    ['sympy-bintest', { command: 'python3 bin/test', runner: 'sympy_bintest' }],
    // requests-style: test_requests.py at the root, setup.py, no configuration
    ['root-tests', PYTEST],
    ['unittest-pkg', { command: 'python3 -m unittest discover -v', runner: 'unittest' }],
    // setup.py declaring a test_suite is no longer a test command: setuptools 72 removed `setup.py test`
    ['setup-py-test', null],
    ['npm-jest', { command: 'npm test', runner: 'jest' }],
    ['npm-vitest', { command: 'npm test', runner: 'vitest' }],
    ['npm-plain', { command: 'npm test', runner: 'npm' }],
    ['npm-placeholder', null],
    ['cargo', { command: 'cargo test', runner: 'cargo' }],
    ['go', { command: 'go test ./...', runner: 'go' }],
    ['none', null],
  ];
  for (const [dir, expected] of cases) {
    it(dir, async () => {
      expect(shape(await detectTestCommand(readerFor(join(FIXTURES, 'manifests', dir))))).toEqual(expected);
    });
  }

  it('the detected command carries a scope builder for the Python runners', async () => {
    for (const dir of ['pytest-ini', 'django-runtests', 'sympy-bintest', 'unittest-pkg']) {
      const tc = await detectTestCommand(readerFor(join(FIXTURES, 'manifests', dir)));
      expect(typeof tc?.scope).toBe('function');
    }
    expect((await detectTestCommand(readerFor(join(FIXTURES, 'manifests', 'cargo'))))?.scope).toBeUndefined();
  });

  it('.jevcode-spec.json confirms a runner whose entry point exists; it never invents one and a malformed spec is ignored', async () => {
    // pytest.ini + tests/runtests.py: the files alone would say pytest; the spec names runtests.py, which exists
    expect(shape(await detectTestCommand(readerFor(join(FIXTURES, 'manifests', 'spec-django'))))).toEqual({ command: 'python3 tests/runtests.py --parallel 1', runner: 'django' });
    // the spec names bin/test but the tree has none: detection from the files stands
    expect(shape(await detectTestCommand(readerFor(join(FIXTURES, 'manifests', 'spec-missing-entry'))))).toEqual(PYTEST);
    expect(shape(await detectTestCommand(readerFor(join(FIXTURES, 'manifests', 'spec-malformed'))))).toEqual({ command: 'python3 tests/runtests.py --parallel 1', runner: 'django' });
  });

  describe('interpreter: python when the workspace has .venv/bin/python, python3 otherwise', () => {
    const dirs: string[] = [];
    afterEach(() => {
      while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    });
    const temp = (files: Record<string, string>): string => {
      const dir = mkdtempSync(join(tmpdir(), 'jev-detect-'));
      dirs.push(dir);
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), content);
      }
      return dir;
    };
    it('pytest / django / sympy / unittest with a venv', async () => {
      expect(shape(await detectTestCommand(readerFor(temp({ 'pytest.ini': '[pytest]\n', '.venv/bin/python': '' }))))).toEqual({ command: 'python -m pytest -q', runner: 'pytest' });
      expect(shape(await detectTestCommand(readerFor(temp({ 'tests/runtests.py': '#!/usr/bin/env python\n', '.venv/bin/python': '' }))))).toEqual({ command: 'python tests/runtests.py --parallel 1', runner: 'django' });
      expect(shape(await detectTestCommand(readerFor(temp({ 'bin/test': '#!/usr/bin/env python\n', '.venv/bin/python': '' }))))).toEqual({ command: 'python bin/test', runner: 'sympy_bintest' });
      expect(shape(await detectTestCommand(readerFor(temp({ 'tests/__init__.py': '', '.venv/bin/python': '' }))))).toEqual({ command: 'python -m unittest discover -v', runner: 'unittest' });
      // a venv without python (bin/ holds only activate scripts) does not count
      expect(shape(await detectTestCommand(readerFor(temp({ 'pytest.ini': '[pytest]\n', '.venv/bin/activate': '' }))))).toEqual({ command: 'python3 -m pytest -q', runner: 'pytest' });
    });
    it('bin/test without a python shebang is not the sympy runner; a spec naming pytest is confirmed without an entry point', async () => {
      expect(shape(await detectTestCommand(readerFor(temp({ 'bin/test': '#!/bin/sh\nexec ./run-tests\n' }))))).toBeNull();
      expect(shape(await detectTestCommand(readerFor(temp({ 'bin/test': '#!/bin/sh\n', [SPEC_FILE]: '{"test_cmd":"pytest -rA"}' }))))).toEqual({ command: 'python3 -m pytest -q', runner: 'pytest' });
    });
  });
});

describe('runnerFromCommand: the runner a harness test command names', () => {
  it('django / sympy / pytest / unittest, with env prefixes and interpreters skipped', () => {
    expect(runnerFromCommand('./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1')).toBe('django');
    expect(runnerFromCommand('python tests/runtests.py --parallel 1 decorators.tests')).toBe('django');
    expect(runnerFromCommand("PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose")).toBe('sympy_bintest');
    expect(runnerFromCommand('python3 bin/test sympy/utilities/tests/test_lambdify.py')).toBe('sympy_bintest');
    expect(runnerFromCommand('pytest -rA')).toBe('pytest');
    expect(runnerFromCommand('python -m pytest -q')).toBe('pytest');
    expect(runnerFromCommand('py.test')).toBe('pytest');
    expect(runnerFromCommand('python -m unittest discover -v')).toBe('unittest');
    expect(runnerFromCommand('python setup.py test')).toBe('unittest');
    expect(runnerFromCommand('tox -e py39')).toBeNull();
    expect(runnerFromCommand('python -m nose')).toBeNull();
    expect(runnerFromCommand('')).toBeNull();
  });
});

describe('scope builders', () => {
  it('django: dotted labels relative to tests/ (paths, node ids, unittest ids, labels), de-duplicated', () => {
    expect(djangoLabel('tests/decorators/tests.py')).toBe('decorators.tests');
    expect(djangoLabel('./tests/decorators/tests.py::DecoratorsTest::test_attributes')).toBe('decorators.tests.DecoratorsTest.test_attributes');
    expect(djangoLabel('test_attributes (decorators.tests.DecoratorsTest)')).toBe('decorators.tests.DecoratorsTest.test_attributes');
    expect(djangoLabel('test_attributes (decorators.tests.DecoratorsTest.test_attributes)')).toBe('decorators.tests.DecoratorsTest.test_attributes');
    expect(djangoLabel('decorators.tests.DecoratorsTest')).toBe('decorators.tests.DecoratorsTest');
    expect(djangoLabel('tests/decorators/')).toBe('decorators');
    expect(djangoLabel('tests/decorators/__init__.py')).toBe('decorators');
    expect(djangoLabel('tests/')).toBe('');
    const scope = scopeBuilderFor('django', 'python tests/runtests.py --parallel 1')!;
    expect(scope(['tests/decorators/tests.py'])).toBe('python tests/runtests.py --parallel 1 decorators.tests');
    expect(scope(['tests/decorators/tests.py::DecoratorsTest::test_attributes', 'test_attributes (decorators.tests.DecoratorsTest)', 'tests/utils_tests/test_functional.py'])).toBe(
      'python tests/runtests.py --parallel 1 decorators.tests.DecoratorsTest.test_attributes utils_tests.test_functional',
    );
    expect(scope([])).toBe('python tests/runtests.py --parallel 1');
    expect(scope(['tests/'])).toBe('python tests/runtests.py --parallel 1');
  });

  it('sympy: paths, then -k with the test names (which must come last)', () => {
    expect(sympyTarget('sympy/utilities/tests/test_lambdify.py:test_issue_12092')).toEqual({ path: 'sympy/utilities/tests/test_lambdify.py', name: 'test_issue_12092' });
    expect(sympyTarget('sympy/utilities/tests/test_lambdify.py::test_issue_12092')).toEqual({ path: 'sympy/utilities/tests/test_lambdify.py', name: 'test_issue_12092' });
    expect(sympyTarget('sympy/utilities/tests/test_lambdify.py')).toEqual({ path: 'sympy/utilities/tests/test_lambdify.py', name: null });
    expect(sympyTarget('test_issue_12092')).toEqual({ path: null, name: 'test_issue_12092' });
    const scope = scopeBuilderFor('sympy_bintest', 'python bin/test')!;
    expect(scope(['sympy/utilities/tests/test_lambdify.py'])).toBe('python bin/test sympy/utilities/tests/test_lambdify.py');
    expect(scope(['sympy/utilities/tests/test_lambdify.py:test_issue_12092', 'sympy/utilities/tests/test_lambdify.py:test_no_args', 'sympy/core/tests/test_basic.py'])).toBe(
      'python bin/test sympy/utilities/tests/test_lambdify.py sympy/core/tests/test_basic.py -k test_issue_12092 test_no_args',
    );
    expect(scope([])).toBe('python bin/test');
  });

  it('pytest: paths and node ids appended, quoted only when the shell needs it', () => {
    const scope = scopeBuilderFor('pytest', 'python3 -m pytest -q')!;
    expect(scope(['test_requests.py::RequestsTestCase::test_no_content_length'])).toBe('python3 -m pytest -q test_requests.py::RequestsTestCase::test_no_content_length');
    expect(scope(['tests/test a.py', 'tests/test_b.py::test_x[1-2]', 'tests/test_b.py::test_x[1-2]'])).toBe("python3 -m pytest -q 'tests/test a.py' 'tests/test_b.py::test_x[1-2]'");
    expect(scope([])).toBe('python3 -m pytest -q');
  });

  it('unittest: module names replace discovery', () => {
    expect(unittestLabel('test_pass (tests.test_sample.SampleTests)')).toBe('tests.test_sample.SampleTests.test_pass');
    expect(unittestLabel('tests/test_sample.py')).toBeNull();
    expect(moduleOfPath('tests/test_sample.py')).toBe('tests.test_sample');
    expect(moduleOfPath('pkg/__init__.py')).toBe('pkg');
    expect(unittestModuleLabel('tests/test_sample.py::SampleTests::test_pass')).toBe('tests.test_sample.SampleTests.test_pass');
    const scope = scopeBuilderFor('unittest', 'python3 -m unittest discover -v')!;
    expect(scope(['tests/test_sample.py', 'test_pass (tests.test_sample.SampleTests)'])).toBe('python3 -m unittest -v tests.test_sample tests.test_sample.SampleTests.test_pass');
    expect(scope([])).toBe('python3 -m unittest discover -v');
    expect(scopeBuilderFor('unittest', 'python setup.py test')!(['tests.suite'])).toBe('python -m unittest -v tests.suite');
  });

  it('runners without a subset syntax have no builder', () => {
    // jest/vitest/cargo/go gained builders in HARNESS-NEXT wave S1 (test/unit/workspace/tests-scope.test.ts)
    for (const r of ['npm', 'unknown'] as const) expect(scopeBuilderFor(r, 'x')).toBeNull();
  });
});
