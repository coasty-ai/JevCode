import { describe, expect, it } from 'vitest';

import type { VerifyRunFn } from '../../../../../src/jev-modes/synth/verify/types.js';
import { REPRO_ID_PREFIX, callOf, regressionScope, reproTestId, reproductionGoal, verifyRepro } from '../../../../../src/jev-modes/synth/oracle/goal.js';
import type { ReproSpec } from '../../../../../src/jev-modes/synth/oracle/goal.js';
import { REPRO_SENTINEL, evaluateCriterion } from '../../../../../src/jev-modes/synth/oracle/runner.js';
import type { BuiltCriterion } from '../../../../../src/jev-modes/synth/oracle/runner.js';
import type { CodeBlock, ReproRunResult, StatementResult } from '../../../../../src/jev-modes/synth/oracle/types.js';

const block: CodeBlock = { index: 0, kind: 'code', origin: 'fence', lang: null, text: "x = symbols('x')\nmathematica_code(Max(x,2))", startLine: 5, endLine: 6, tracebacks: [] };
const built: BuiltCriterion = { criterion: { form: 'values', expected: [{ chunk: 'last', text: "'Max[x,2]'" }] }, strength: 'strong', expectedText: "'Max[x,2]'", derivation: 'sentence' };
const stmt = (over: Partial<StatementResult>): StatementResult => ({ chunk: 0, stmt: 0, source: 'x', kind: 'expr', value: null, typeName: null, stdout: '', exception: null, fixup: null, environment: false, ms: 1, ...over });
const baseRun: ReproRunResult = {
  status: 'ran',
  python: '3.9.6',
  statements: [stmt({ kind: 'stmt', source: "x = symbols('x')", fixup: 'from sympy import symbols' }), stmt({ stmt: 1, source: 'mathematica_code(Max(x,2))', value: "'Max(2, x)'", typeName: 'str' })],
  exitCode: 0,
  durationMs: 710,
  outputTail: 'DeprecationWarning: …',
};
const options = { packageName: 'sympy', framework: null };

describe('reproductionGoal', () => {
  const goal = reproductionGoal({ block, chunks: [block.text], built, result: baseRun, options });

  it('one synthetic failing test repro::<sha8>, deterministic over chunks + criterion', () => {
    expect(goal.spec.testId).toMatch(/^repro::[0-9a-f]{8}$/);
    expect(goal.spec.testId).toBe(reproTestId([block.text], built.criterion));
    expect(reproTestId([block.text], { form: 'no_exception' })).not.toBe(goal.spec.testId);
    expect(goal.spec.testId.startsWith(REPRO_ID_PREFIX)).toBe(true);
  });

  it('the FailureView: call = the snippet\'s last statement, expected = the built text, actual = the observed value', () => {
    expect(goal.failure).toEqual({ testId: goal.spec.testId, call: 'mathematica_code(Max(x,2))', expected: "'Max[x,2]'", actual: "'Max(2, x)'" });
    expect(goal.verdict.pass).toBe(false);
  });

  it('the TestRunSummary reads as a one-test run with that test failing', () => {
    expect(goal.summary).toMatchObject({ passed: 0, failed: 1, errors: 0, skipped: 0, total: 1, failing: [goal.spec.testId], passing: [], exitCode: 0, timedOut: false, durationMs: 710 });
    expect(goal.summary.failures).toEqual([goal.failure]);
    expect(goal.summary.command).toContain(goal.spec.testId);
    expect(goal.summary.outputTail).toBe('DeprecationWarning: …');
  });

  it('a passing run gives a green summary (passes_on_base: not an oracle)', () => {
    const passing: ReproRunResult = { ...baseRun, statements: [stmt({ source: 'mathematica_code(Max(x,2))', value: "'Max[x, 2]'" })] };
    const g = reproductionGoal({ block, chunks: [block.text], built, result: passing, options });
    expect(g.verdict.pass).toBe(true);
    expect(g.summary).toMatchObject({ passed: 1, failed: 0, failing: [], passing: [g.spec.testId], failures: [] });
  });

  it('callOf falls back to the last statement that ran, then to <repro>', () => {
    const v = evaluateCriterion({ form: 'no_exception' }, baseRun);
    expect(callOf(baseRun, { ...v, statement: null })).toBe('mathematica_code(Max(x,2))');
    expect(callOf({ ...baseRun, statements: [] }, { ...v, statement: null })).toBe('<repro>');
  });
});

describe('verifyRepro', () => {
  it('re-runs the spec in a candidate workspace through the provided run and evaluates the same criterion', async () => {
    const spec: ReproSpec = { testId: 'repro::deadbeef', chunks: ["x = symbols('x')", 'mathematica_code(Max(x,2))'], criterion: built.criterion, expectedText: built.expectedText, blockIndex: 0, options };
    const seen: { command: string; cwd: string | undefined }[] = [];
    const run: VerifyRunFn = async (command, opts) => {
      seen.push({ command, cwd: opts.cwd });
      const results = [{ chunk: 0, stmt: 0, source: "x = symbols('x')", kind: 'stmt', value: null, stdout: '', exception: null, fixup: null, environment: false, ms: 0 }, { chunk: 1, stmt: 0, source: 'mathematica_code(Max(x,2))', kind: 'expr', value: "'Max[x, 2]'", type_name: 'str', stdout: '', exception: null, fixup: null, environment: false, ms: 1 }];
      return { stdout: `${REPRO_SENTINEL}${JSON.stringify({ ok: true, python: '3.9.6', results })}\n`, stderr: '', exitCode: 0 };
    };
    const v = await verifyRepro(run, '/lanes/lane1', spec, '/venv/bin/python');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cwd).toBe('/lanes/lane1');
    expect(seen[0]?.command).toContain("'/venv/bin/python' -c");
    expect(v.verdict.pass).toBe(true);
    expect(v.summary).toMatchObject({ passed: 1, failed: 0, passing: ['repro::deadbeef'] });
    expect(v.failure.actual).toBe("'Max[x, 2]'");
  });
});

describe('regressionScope', () => {
  const files = new Map<string, string>([
    ['sympy/printing/mathematica.py', 'class MCodePrinter: pass'],
    ['sympy/printing/tests/test_mathematica.py', 'from sympy.printing.mathematica import mathematica_code\n'],
    ['sympy/printing/tests/test_str.py', 'from sympy import mathematica\n'],
    ['sympy/printing/tests/test_latex.py', 'from sympy.printing.latex import latex\n'],
    ['sympy/core/tests/test_basic.py', 'import sympy.printing.mathematica\n'],
    ['sympy/utilities/tests/test_codegen.py', 'from sympy.printing import mathematica as m\n'],
    ['sympy/printing/tests/test_precedence.py', 'x = mathematica\n'],
    ['sympy/printing/tests/test_python.py', 'nothing\n'],
    ['docs/mathematica.py', 'from sympy.printing.mathematica import *\n'],
  ]);

  it('picks test files that import or name the localised module, best first, bounded to 6', () => {
    const scope = regressionScope(['sympy/printing/mathematica.py'], files);
    expect(scope.testFiles[0]).toBe('sympy/printing/tests/test_mathematica.py');
    expect(scope.testFiles).toContain('sympy/core/tests/test_basic.py');
    expect(scope.testFiles).toContain('sympy/utilities/tests/test_codegen.py');
    expect(scope.testFiles).toContain('sympy/printing/tests/test_precedence.py');
    expect(scope.testFiles).not.toContain('sympy/printing/tests/test_latex.py');
    expect(scope.testFiles).not.toContain('sympy/printing/tests/test_python.py');
    expect(scope.testFiles).not.toContain('docs/mathematica.py');
    expect(scope.testFiles.length).toBeLessThanOrEqual(6);
    expect(scope.reasons['sympy/printing/tests/test_mathematica.py']).toContain('test_mathematica.py beside');
    expect(scope.command).toBe(`python -m pytest -q ${scope.testFiles.map((f) => `'${f}'`).join(' ')}`);
  });

  it('applies the spec test_cmd template, honours max, and returns null without a match', () => {
    const scope = regressionScope(['sympy/printing/mathematica.py'], files, { testCmd: "PYTHONWARNINGS='ignore' bin/test -C --verbose", max: 2 });
    expect(scope.testFiles).toHaveLength(2);
    expect(scope.command?.startsWith("PYTHONWARNINGS='ignore' bin/test -C --verbose 'sympy/printing/tests/test_mathematica.py'")).toBe(true);
    const none = regressionScope(['sympy/nowhere/x.py'], files);
    expect(none).toEqual({ testFiles: [], command: null, reasons: {} });
  });

  it('src-layout modules: `src/_pytest/setuponly.py` is the module `_pytest.setuponly`', () => {
    const ws = new Map<string, string>([
      ['src/_pytest/setuponly.py', ''],
      ['testing/test_setuponly.py', 'import pytest\n'],
      ['testing/python/collect.py', 'from _pytest.setuponly import _show_fixture_action\n'],
    ]);
    const scope = regressionScope(['src/_pytest/setuponly.py'], ws);
    expect(scope.testFiles).toEqual(['testing/python/collect.py']);
  });
});
