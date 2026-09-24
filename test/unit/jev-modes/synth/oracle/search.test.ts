/**
 * The oracle path's arithmetic (oracle/search.ts): repository detection, the package name, the
 * best-guess id, the regression command template and scope tiers, the merged baseline, the
 * traceback text for the localiser, and `findIssueOracle` end to end over a fake Jev and a fake
 * interpreter (every outcome class the controller reads).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Answer, Question } from '../../../../../src/core/types.js';
import { REPRO_ID_PREFIX } from '../../../../../src/jev-modes/synth/oracle/goal.js';
import { REPRO_SENTINEL } from '../../../../../src/jev-modes/synth/oracle/runner.js';
import { BEST_GUESS_ID_PREFIX, bestGuessFailure, bestGuessTestId, chooseRegressionScope, emptyScopedSummary, findIssueOracle, frameworkOf, isBestGuessTestId, isRepositoryWorkspace, isReproTestId, mergeSummaries, moduleStems, NETWORK_ORACLE_OPEN_PROBLEM, oracleNeedsArbitration, oracleYieldsGoal, packageNameOf, regressionCommandTemplate, scopeCommand, scopedPartOf, stemRelatedTestFiles, tracebackTextFor } from '../../../../../src/jev-modes/synth/oracle/search.js';
import type { OracleSearchInput } from '../../../../../src/jev-modes/synth/oracle/search.js';
import type { FrameJudgement, ReproRunResult, StatementResult } from '../../../../../src/jev-modes/synth/oracle/types.js';
import type { VerifyRunFn } from '../../../../../src/jev-modes/synth/verify/types.js';
import { choiceAnswer, summary } from '../verify/helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (id: string): string => readFileSync(join(here, `../../../../fixtures/synth/oracle/${id}.md`), 'utf8');

// ---------------------------------------------------------------------------------------
// Workspace shape
// ---------------------------------------------------------------------------------------

describe('isRepositoryWorkspace / packageNameOf', () => {
  const many = (n: number, prefix: string): string[] => Array.from({ length: n }, (_, i) => `${prefix}/m${i}.py`);
  it('a Django or sympy runner is a repository whatever the file count; otherwise many source or test files are', () => {
    expect(isRepositoryWorkspace({ runner: 'django' }, ['django/__init__.py'])).toBe(true);
    expect(isRepositoryWorkspace({ runner: 'sympy_bintest' }, [])).toBe(true);
    expect(isRepositoryWorkspace({ runner: 'pytest' }, ['gcd.py', 'tests/test_gcd.py'])).toBe(false);
    expect(isRepositoryWorkspace(null, ['gcd.py', 'node.py', 'tests/test_gcd.py'])).toBe(false);
    expect(isRepositoryWorkspace({ runner: 'pytest' }, [...many(40, 'requests'), 'test_requests.py'])).toBe(true);
    expect(isRepositoryWorkspace({ runner: 'pytest' }, [...many(5, 'src/_pytest'), ...many(30, 'testing').map((p) => p.replace(/m(\d+)\.py$/, 'test_$1.py'))])).toBe(true);
    // the ladder's tasks: a handful of source files and a few test modules
    expect(isRepositoryWorkspace({ runner: 'pytest' }, [...many(8, 'src'), 'tests/test_a.py', 'tests/test_b.py'])).toBe(false);
  });
  it('the package is the top-level (or src/) directory with an __init__.py and the most source files', () => {
    expect(packageNameOf(['sympy/__init__.py', 'sympy/core/add.py', 'sympy/core/tests/test_add.py', 'bin/test', 'setup.py'])).toBe('sympy');
    expect(packageNameOf(['src/_pytest/__init__.py', 'src/_pytest/main.py', 'src/_pytest/mark/expression.py', 'src/pytest/__init__.py', 'src/pytest/__main__.py', 'testing/test_main.py'])).toBe('_pytest');
    expect(packageNameOf(['django/__init__.py', 'django/db/models/query.py', 'tests/queries/tests.py', 'tests/__init__.py'])).toBe('django');
    expect(packageNameOf(['gcd.py', 'tests/test_gcd.py'])).toBeNull();
    expect(frameworkOf('django')).toBe('django');
    expect(frameworkOf('sympy')).toBeNull();
    expect(frameworkOf(null)).toBeNull();
  });
});

describe('best-guess ids', () => {
  it('issue::<sha8> over the task text; the failure view names the issue title and says nothing reproduces it', () => {
    const task = 'Max printed wrong\n\nSome text.\n';
    expect(bestGuessTestId(task)).toMatch(new RegExp(`^${BEST_GUESS_ID_PREFIX}[0-9a-f]{8}$`));
    expect(bestGuessTestId(task)).toBe(bestGuessTestId(`${task}\n`));
    expect(bestGuessTestId('other')).not.toBe(bestGuessTestId(task));
    expect(isBestGuessTestId(bestGuessTestId(task))).toBe(true);
    expect(isBestGuessTestId(`${REPRO_ID_PREFIX}abcd1234`)).toBe(false);
    expect(isReproTestId(`${REPRO_ID_PREFIX}abcd1234`)).toBe(true);
    const f = bestGuessFailure(task);
    expect(f).toMatchObject({ testId: bestGuessTestId(task), call: 'Max printed wrong', expected: 'the behaviour the issue reports is fixed' });
    expect(f.actual).toContain('no reproduction oracle');
  });
});

// ---------------------------------------------------------------------------------------
// Regression command and scope
// ---------------------------------------------------------------------------------------

describe('regressionCommandTemplate', () => {
  it('keeps the detector program (the engine parses runs of the same program) and adds the harness flags the base lacks', () => {
    const django = regressionCommandTemplate({ command: 'python tests/runtests.py --parallel 1', runner: 'django' }, './tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1');
    expect(django.command).toBe('python tests/runtests.py --parallel 1 --verbosity 2 --settings=test_sqlite');
    const sympy = regressionCommandTemplate({ command: 'python bin/test', runner: 'sympy_bintest' }, "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose");
    expect(sympy.command).toBe('python bin/test -C --verbose');
    const pytest = regressionCommandTemplate({ command: 'python -m pytest -q', runner: 'pytest' }, 'pytest -rA');
    expect(pytest.command).toBe('python -m pytest -q -rA');
    expect(regressionCommandTemplate({ command: 'python -m pytest -q', runner: 'pytest' }, null).command).toBe('python -m pytest -q');
    expect(regressionCommandTemplate({ command: 'python -m pytest -q', runner: 'pytest' }, 'python -m pytest -q').command).toBe('python -m pytest -q');
  });
  it('scopeCommand builds the runner-specific subset command (Django labels, sympy paths, pytest paths); null without files', () => {
    const django = regressionCommandTemplate({ command: 'python tests/runtests.py --parallel 1', runner: 'django' }, './tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1');
    expect(scopeCommand(django, ['tests/model_fields/tests.py', 'tests/queries/test_query.py'])).toBe('python tests/runtests.py --parallel 1 --verbosity 2 --settings=test_sqlite model_fields.tests queries.test_query');
    expect(scopeCommand({ command: 'python bin/test -C --verbose', runner: 'sympy_bintest' }, ['sympy/printing/tests/test_mathematica.py'])).toBe('python bin/test -C --verbose sympy/printing/tests/test_mathematica.py');
    expect(scopeCommand({ command: 'python -m pytest -q -rA', runner: 'pytest' }, ['testing/test_mark.py'])).toBe('python -m pytest -q -rA testing/test_mark.py');
    expect(scopeCommand({ command: 'python -m pytest -q', runner: 'pytest' }, [])).toBeNull();
  });
});

describe('chooseRegressionScope', () => {
  const django = [
    'django/__init__.py',
    'django/db/models/fields/__init__.py',
    'django/db/models/aggregates.py',
    'django/db/models/sql/query.py',
    'django/utils/decorators.py',
    'tests/model_fields/tests.py',
    'tests/model_fields/test_charfield.py',
    'tests/field_defaults/tests.py',
    'tests/aggregation/tests.py',
    'tests/aggregation_regress/tests.py',
    'tests/queries/tests.py',
    'tests/queries/test_query.py',
    'tests/decorators/tests.py',
    'tests/utils_tests/test_decorators.py',
    'tests/basic/tests.py',
    'tests/admin_views/tests.py',
    'tests/runtests.py',
    'tests/__init__.py',
  ];
  it('the related tier when imports or names find the module (decorators)', () => {
    const contents = (p: string): string | null => (p === 'tests/utils_tests/test_decorators.py' ? 'from django.utils.decorators import method_decorator\n' : p === 'tests/decorators/tests.py' ? 'from django.utils.decorators import method_decorator\n' : p === 'tests/basic/tests.py' ? 'from django.utils import decorators\n' : '');
    const s = chooseRegressionScope(django, ['django/utils/decorators.py'], { contents });
    expect(s.tier).toBe('related');
    expect(s.testFiles.slice(0, 2).sort()).toEqual(['tests/decorators/tests.py', 'tests/utils_tests/test_decorators.py']);
    expect(s.testFiles).toContain('tests/basic/tests.py');
    expect(s.testFiles.length).toBeLessThanOrEqual(6);
  });
  it('the stem tier fills in when the test apps are named by feature (model_fields, aggregation, queries)', () => {
    expect(moduleStems('django/db/models/fields/__init__.py')).toEqual(['field', 'model']);
    expect(moduleStems('django/db/models/aggregates.py')).toEqual(['aggregate', 'model']);
    expect(moduleStems('django/db/models/sql/query.py')).toEqual(['query']);
    expect(moduleStems('src/_pytest/mark/structures.py')).toEqual(['structure', 'mark']);
    const fields = chooseRegressionScope(django, ['django/db/models/fields/__init__.py']);
    expect(fields.tier).toBe('stem');
    expect(fields.testFiles[0]).toBe('tests/model_fields/tests.py');
    expect(fields.testFiles).toContain('tests/field_defaults/tests.py');
    const agg = stemRelatedTestFiles(django, ['django/db/models/aggregates.py'], 6);
    expect(agg.slice(0, 2).sort()).toEqual(['tests/aggregation/tests.py', 'tests/aggregation_regress/tests.py']);
    const query = stemRelatedTestFiles(django, ['django/db/models/sql/query.py'], 6);
    expect(query.slice(0, 2).sort()).toEqual(['tests/queries/test_query.py', 'tests/queries/tests.py']);
    expect(query).not.toContain('tests/runtests.py');
  });
  it('the fallback tier is a smoke check on the shortest test paths; none without any test file', () => {
    const fb = chooseRegressionScope(django, ['django/db/models/sql/compiler.py']);
    expect(fb.tier).toBe('fallback');
    expect(fb.testFiles).toHaveLength(2);
    expect(fb.note).toContain('smoke check');
    expect(chooseRegressionScope(['a.py', 'b.py'], ['a.py'])).toMatchObject({ tier: 'none', testFiles: [] });
  });
  it('honours max', () => {
    expect(chooseRegressionScope(django, ['django/db/models/fields/__init__.py'], { max: 2 }).testFiles).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------------------

describe('mergeSummaries / scopedPartOf', () => {
  const scoped = summary({ command: 'python tests/runtests.py model_fields.tests', passing: ['test_a (m.T)', 'test_b (m.T)'], failing: ['test_c (m.T)'], durationMs: 4200 });
  const repro = summary({ command: 'python <repro::abcd1234>', failing: ['repro::abcd1234'], durationMs: 900 });
  it('adds the reproduction as one more test and keeps the scoped run\'s command and duration', () => {
    const m = mergeSummaries(scoped, repro);
    expect(m).toMatchObject({ command: scoped.command, durationMs: 4200, passed: 2, failed: 2, total: 4, failing: ['test_c (m.T)', 'repro::abcd1234'], passing: ['test_a (m.T)', 'test_b (m.T)'] });
    expect(m.failures.map((f) => f.testId)).toEqual(['test_c (m.T)', 'repro::abcd1234']);
    expect(mergeSummaries(scoped, null)).toBe(scoped);
    expect(scopedPartOf(m)).toMatchObject({ passed: 2, failed: 1, total: 3, failing: ['test_c (m.T)'] });
    expect(scopedPartOf(scoped)).toBe(scoped);
    const green = mergeSummaries(scoped, summary({ passing: ['repro::abcd1234'] }));
    expect(green).toMatchObject({ passed: 3, failed: 1, passing: ['test_a (m.T)', 'test_b (m.T)', 'repro::abcd1234'] });
    expect(scopedPartOf(green)).toMatchObject({ passed: 2, total: 3 });
  });
  it('emptyScopedSummary is a zero run with the command', () => {
    expect(emptyScopedSummary('python -m pytest -q')).toMatchObject({ command: 'python -m pytest -q', total: 0, passed: 0, failed: 0, exitCode: 0 });
  });
});

describe('tracebackTextFor', () => {
  const frame = (file: string, line: number, fn: string | null, inFix: number): FrameJudgement => ({ index: 0, frame: { file, line, fn, code: null }, inFix });
  const stmt = (over: Partial<StatementResult>): StatementResult => ({ chunk: 0, stmt: 0, source: 'x', kind: 'expr', value: null, typeName: null, stdout: '', exception: null, fixup: null, environment: false, ms: 1, ...over });
  it('renders the anchors and the base run\'s raising frames as CPython lines, REPL frames dropped, duplicates folded', () => {
    const run: ReproRunResult = { status: 'ran', python: '3.9', statements: [stmt({ exception: { type: 'TypeError', message: 'x', frames: [{ file: '<repro>', line: 1, fn: '<module>', code: null }, { file: '/ws/sympy/simplify/fu.py', line: 504, fn: '_f', code: null }, { file: '/ws/sympy/simplify/fu.py', line: 504, fn: '_f', code: null }] } })], exitCode: 0, durationMs: 1, outputTail: '' };
    const text = tracebackTextFor([frame('sympy/simplify/fu.py', 500, '_TR56', 0.62), frame('<stdin>', 1, '<module>', 0.05)], run);
    expect(text).toBe('Traceback (most recent call last):\n  File "sympy/simplify/fu.py", line 500, in _TR56\n  File "/ws/sympy/simplify/fu.py", line 504, in _f');
    expect(tracebackTextFor([], null)).toBeNull();
    expect(tracebackTextFor([frame('<stdin>', 1, null, 0.9)], null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// findIssueOracle end to end (fake Jev, fake interpreter)
// ---------------------------------------------------------------------------------------

const TASK = ["mathematica_code gives wrong output with Max", '', '```python', 'from sympy import symbols, Max', 'from sympy.printing.mathematica import mathematica_code', "x = symbols('x')", 'mathematica_code(Max(x,2))', '```', '', "This returns `'Max(2, x)'` but should return `'Max[x,2]'`.", ''].join('\n');

function answersFor(questions: Record<string, Question>, kind: string, repro = 0.9): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') out[id] = { type: 'noul', noul: id.startsWith('is_reproduction_') ? repro : 0.1 };
    else if (q.type === 'choice') out[id] = choiceAnswer(q, { [kind]: 0.9 });
  }
  return out;
}

function sentinelRun(results: Record<string, unknown>[]): VerifyRunFn {
  return async () => ({ stdout: `${REPRO_SENTINEL}${JSON.stringify({ ok: true, python: '3.9.6', results })}\n`, stderr: '', exitCode: 0, durationMs: 610 });
}

const stmtOk = (chunk: number, source: string): Record<string, unknown> => ({ chunk, stmt: 0, source, kind: 'stmt', value: null, stdout: '', exception: null, fixup: null, environment: false, ms: 1 });
const stmtValue = (chunk: number, source: string, value: string): Record<string, unknown> => ({ chunk, stmt: 0, source, kind: 'expr', value, type_name: 'str', stdout: '', exception: null, fixup: null, environment: false, ms: 1 });

function input(over: Partial<OracleSearchInput> & { kind?: string; repro?: number } = {}): OracleSearchInput {
  const { kind, repro, ...rest } = over;
  const asked: string[] = [];
  return {
    task: TASK,
    repository: 'sympy',
    packageName: 'sympy',
    framework: null,
    workspace: '/work',
    ask: async (_stage, _state, questions) => {
      asked.push(...Object.keys(questions));
      return { answers: answersFor(questions, kind ?? 'wrong_value', repro ?? 0.9) };
    },
    run: sentinelRun([stmtOk(0, 'from sympy import symbols, Max'), stmtValue(0, 'mathematica_code(Max(x,2))', "'Max(2, x)'")]),
    ...rest,
  };
}

describe('findIssueOracle', () => {
  it('a valid strong oracle: one request, the criterion from the sentence, fails at base, the goal names the last statement', async () => {
    const seen: { cwd: string | undefined; command: string }[] = [];
    const run: VerifyRunFn = async (command, opts) => {
      seen.push({ cwd: opts.cwd, command });
      return sentinelRun([stmtOk(0, 'from sympy import symbols, Max'), stmtValue(0, 'mathematica_code(Max(x,2))', "'Max(2, x)'")])(command, opts);
    };
    const r = await findIssueOracle(input({ run, python: '/work/.venv/bin/python' }));
    expect(r.outcome).toBe('valid');
    expect(r.strength).toBe('strong');
    expect(r.requests).toBe(1);
    expect(r.goal?.spec.testId).toMatch(/^repro::[0-9a-f]{8}$/);
    expect(r.goal?.failure).toMatchObject({ call: 'mathematica_code(Max(x,2))', expected: "'Max[x,2]'", actual: "'Max(2, x)'" });
    expect(r.goal?.summary).toMatchObject({ failed: 1, passed: 0, total: 1 });
    expect(r.goal?.spec.options).toMatchObject({ packageName: 'sympy', framework: null });
    // the base run, then the confirmation run of the same script on the same commit
    expect(seen).toHaveLength(2);
    expect(seen[0]?.cwd).toBe('/work');
    expect(seen[0]?.command).toContain("'/work/.venv/bin/python' -c");
    expect(seen[1]?.command).toBe(seen[0]?.command);
    expect(r.note).toContain('strong oracle');
    expect(r.note).toContain('confirmed by a second run');
    expect(r.traceback).toBeNull();
  });
  it('unstable: a snippet that fails once and passes on the confirmation run is no oracle (its verdict is not a fact of the code)', async () => {
    let calls = 0;
    const flaky: VerifyRunFn = async (command, opts) => {
      calls += 1;
      const value = calls === 1 ? "'Max(2, x)'" : "'Max[x, 2]'";
      return sentinelRun([stmtOk(0, 'from sympy import symbols, Max'), stmtValue(0, 'mathematica_code(Max(x,2))', value)])(command, opts);
    };
    const r = await findIssueOracle(input({ run: flaky }));
    expect(r.outcome).toBe('unstable');
    expect(r.goal).toBeNull();
    expect(r.requests).toBe(1);
    expect(calls).toBe(2);
    expect(r.note).toContain('passed when run again');
    // a confirmation run that did not report keeps the first verdict and says so
    let n = 0;
    const thenBroken: VerifyRunFn = async (command, opts) => {
      n += 1;
      if (n === 1) return sentinelRun([stmtOk(0, 'from sympy import symbols, Max'), stmtValue(0, 'mathematica_code(Max(x,2))', "'Max(2, x)'")])(command, opts);
      return { stdout: '', stderr: 'killed', exitCode: 137, durationMs: 5 };
    };
    const kept = await findIssueOracle(input({ run: thenBroken }));
    expect(kept.outcome).toBe('valid');
    expect(kept.note).toContain('confirmation run did not report');
  });
  it('passes_on_base when the criterion already holds; no_blocks without code; no_pick below the threshold', async () => {
    let passRuns = 0;
    const passing: VerifyRunFn = async (command, opts) => {
      passRuns += 1;
      return sentinelRun([stmtOk(0, 'from sympy import symbols, Max'), stmtValue(0, 'mathematica_code(Max(x,2))', "'Max[x, 2]'")])(command, opts);
    };
    const passes = await findIssueOracle(input({ run: passing }));
    expect(passes.outcome).toBe('passes_on_base');
    expect(passes.goal).toBeNull();
    expect(passes.requests).toBe(1);
    // the pass side is confirmed too: a base that passes and then fails shows a pass rate above zero and below one
    expect(passRuns).toBe(2);
    expect(passes.note).toContain('(twice)');
    let n = 0;
    const coin: VerifyRunFn = async (command, opts) => {
      n += 1;
      return sentinelRun([stmtOk(0, 'from sympy import symbols, Max'), stmtValue(0, 'mathematica_code(Max(x,2))', n === 1 ? "'Max[x, 2]'" : "'Max(2, x)'")])(command, opts);
    };
    const flipped = await findIssueOracle(input({ run: coin }));
    expect(flipped.outcome).toBe('unstable');
    expect(flipped.goal).toBeNull();
    expect(flipped.note).toContain('passed once at the base commit');
    expect(n).toBe(2);
    const none = await findIssueOracle(input({ task: 'Please add a feature that prints things nicely.' }));
    expect(none).toMatchObject({ outcome: 'no_blocks', requests: 0, goal: null });
    const low = await findIssueOracle(input({ repro: 0.2 }));
    expect(low.outcome).toBe('no_pick');
    expect(low.note).toContain('0.20');
  });
  it('no_criterion for a feature request kind; incomplete_snippet when the snippet stops on an undefined name; env_error when nothing ran', async () => {
    const feature = await findIssueOracle(input({ kind: 'none_of_these' }));
    expect(feature.outcome).toBe('no_criterion');
    const nameError = await findIssueOracle(input({ run: sentinelRun([stmtOk(0, 'from sympy import symbols, Max'), { ...stmtValue(0, 'mathematica_code(Max(x,2))', ''), value: null, exception: { type: 'NameError', message: "name 'Book' is not defined", frames: [] } }]) }));
    expect(nameError.outcome).toBe('incomplete_snippet');
    expect(nameError.note).toContain('NameError');
    const broken: VerifyRunFn = async () => ({ stdout: '', stderr: 'python: command not found', exitCode: 127, durationMs: 5 });
    const env = await findIssueOracle(input({ run: broken }));
    expect(env.outcome).toBe('env_error');
    expect(env.note).toContain('command not found');
  });
  it('a raised exception at base with failure_kind exception_raised is a valid oracle and yields a traceback for the localiser', async () => {
    const task = fixture('sympy__sympy-17139');
    const run = sentinelRun([{ ...stmtOk(0, 'from sympy import *'), kind: 'stmt' }, { ...stmtOk(1, 'x = Symbol("x")') }, { ...stmtValue(2, 'print(simplify(cos(x)**I))', ''), value: null, exception: { type: 'TypeError', message: 'Invalid comparison of complex I', frames: [{ file: '/work/sympy/simplify/fu.py', line: 504, fn: '_f', code: 'if (rv.exp < 0) == True:' }] } }]);
    const r = await findIssueOracle(input({ task, kind: 'exception_raised', run }));
    expect(r.outcome).toBe('valid');
    expect(r.goal?.spec.criterion).toEqual({ form: 'no_exception' });
    expect(r.goal?.failure.actual).toContain('TypeError');
    expect(r.traceback).toContain('File "/work/sympy/simplify/fu.py", line 504, in _f');
  });
});

// ---------------------------------------------------------------------------------------
// Network-dependent reproductions (requests-2931, rung 3 §21.6 item 1)
// ---------------------------------------------------------------------------------------

describe('findIssueOracle on a reproduction that needs the network', () => {
  const REQUESTS_TASK = ['Request with binary payload fails due to calling to_native_string', '', '```python', 'import requests', 'requests.put("http://httpbin.org/put", data=u"ööö".encode("utf-8"))', '```', '', 'This raises `UnicodeDecodeError`.', ''].join('\n');
  const raising = sentinelRun([stmtOk(0, 'import requests'), { ...stmtValue(0, 'requests.put("http://httpbin.org/put", data=u"ööö".encode("utf-8"))', ''), value: null, exception: { type: 'UnicodeDecodeError', message: "'ascii' codec can't decode byte 0xc3 in position 0", frames: [] } }]);
  it('is an oracle, but weak_network: strength weak, the note names the open problem, passers need arbitration', async () => {
    const r = await findIssueOracle(input({ task: REQUESTS_TASK, repository: 'requests', packageName: 'requests', kind: 'exception_raised', run: raising }));
    expect(r.outcome).toBe('weak_network');
    expect(r.strength).toBe('weak');
    expect(r.goal).not.toBeNull();
    expect(r.goal?.spec.criterion).toEqual({ form: 'no_exception' });
    expect(r.network).toEqual({ kind: 'static', evidence: 'requests against httpbin.org' });
    expect(r.note).toContain('network-weak oracle');
    expect(r.note).toContain(NETWORK_ORACLE_OPEN_PROBLEM);
    expect(r.note).toContain("Jev's arbitration");
    expect(oracleYieldsGoal(r.outcome)).toBe(true);
    expect(oracleNeedsArbitration(r.outcome)).toBe(true);
    expect(oracleNeedsArbitration('valid')).toBe(false);
    expect(oracleNeedsArbitration('valid_weak')).toBe(false);
    expect(oracleYieldsGoal('unstable')).toBe(false);
    expect(NETWORK_ORACLE_OPEN_PROBLEM).toBe('network-dependent reproduction');
  });
  it('the sympy oracle (no network module, no URL) stays valid with network null', async () => {
    const r = await findIssueOracle(input({}));
    expect(r.outcome).toBe('valid');
    expect(r.network).toBeNull();
  });
  it('an env_error caused by a connection error names the network in its note', async () => {
    const offline = sentinelRun([stmtOk(0, 'import requests'), { ...stmtValue(0, 'requests.put("http://httpbin.org/put", data=b"x")', ''), value: null, exception: { type: 'ConnectionError', message: 'HTTPConnectionPool(host=\'httpbin.org\', port=80): Max retries exceeded', frames: [] }, environment: true }]);
    const r = await findIssueOracle(input({ task: REQUESTS_TASK, repository: 'requests', packageName: 'requests', kind: 'exception_raised', run: offline }));
    expect(r.outcome).toBe('env_error');
    expect(r.goal).toBeNull();
    expect(r.network?.kind).toBe('static');
    expect(r.note).toContain('network call failed');
    expect(r.note).toContain('ConnectionError');
  });
});
