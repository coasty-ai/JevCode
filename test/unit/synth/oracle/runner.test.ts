import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { VerifyRunFn } from '../../../../src/synth/verify/types.js';
import { extractBlocks } from '../../../../src/synth/oracle/extract.js';
import { REPRO_SENTINEL, boundNames, buildCriterion, buildReproScript, chunksOf, chunksWithContext, evaluateCriterion, normaliseValue, parseReproOutput, reproCommand, runRepro, valuesEqual, valuesEqualLoose } from '../../../../src/synth/oracle/runner.js';
import type { CodeBlock, Criterion, Extraction, ReproRunResult, StatementResult } from '../../../../src/synth/oracle/types.js';

const pythonAvailable = spawnSync('python3', ['--version']).status === 0;

function pyCompiles(script: string): boolean {
  const r = spawnSync('python3', ['-c', 'import sys, ast; ast.parse(sys.stdin.read())'], { input: script, encoding: 'utf8' });
  if (r.status !== 0) console.error(r.stderr);
  return r.status === 0;
}

const replBlock = (index: number, statements: { source: string; shown: string | null }[]): CodeBlock => ({
  index,
  kind: 'repl',
  origin: 'fence',
  lang: null,
  text: statements.map((s) => `>>> ${s.source}${s.shown === null ? '' : `\n${s.shown}`}`).join('\n'),
  startLine: 1,
  endLine: 1,
  tracebacks: [],
  repl: { prompt: 'python', statements: statements.map((s) => ({ ...s, traceback: null })) },
});
const codeBlock = (index: number, text: string): CodeBlock => ({ index, kind: 'code', origin: 'fence', lang: 'python', text, startLine: 1, endLine: 1, tracebacks: [] });

const stmt = (over: Partial<StatementResult>): StatementResult => ({ chunk: 0, stmt: 0, source: 'x', kind: 'expr', value: null, typeName: null, stdout: '', exception: null, fixup: null, environment: false, ms: 1, ...over });
const ran = (statements: StatementResult[]): ReproRunResult => ({ status: 'ran', python: '3.9.6', statements, exitCode: 0, durationMs: 10, outputTail: '' });

describe('script generation', () => {
  it.skipIf(!pythonAvailable)('the generated runner compiles under python3 (plain and django preamble)', () => {
    const plain = buildReproScript(['from m import f', 'f(1)'], { workspace: '/tmp/ws', packageName: 'm' });
    expect(pyCompiles(plain)).toBe(true);
    const django = buildReproScript(["class A(models.Model):\n\tx = models.IntegerField()\nA.objects.create(x=1)"], { workspace: "/tmp/it's ws", packageName: 'django', framework: 'django' });
    expect(pyCompiles(django)).toBe(true);
    expect(django).toContain('settings.configure(');
  });

  it('chunks are embedded as JSON (quotes, backslashes and newlines survive)', () => {
    const chunk = "s = 'it\\'s'\nprint(\"a\\\\b\")";
    const script = buildReproScript([chunk], { workspace: '/w', packageName: null });
    expect(script).toContain(JSON.stringify(JSON.stringify([chunk])));
    expect(script).toContain('sys.path.insert(0, p)');
    expect(script).toContain(REPRO_SENTINEL);
  });

  it('reproCommand picks .venv/bin/python when present else python3, and quotes an explicit interpreter', () => {
    const cmd = reproCommand('print(1)', { workspace: '/w s' });
    expect(cmd).toContain("if [ -x '/w s'/.venv/bin/python ]; then JEV_PY='/w s'/.venv/bin/python; else JEV_PY=python3; fi;");
    expect(cmd).toContain('PYTHONDONTWRITEBYTECODE=1');
    // one hash seed for the base run, the lanes and the workspace re-run: a hash-dependent verdict is otherwise a coin toss per process
    expect(cmd).toContain('PYTHONHASHSEED=0');
    expect(cmd).toContain(Buffer.from('print(1)').toString('base64'));
    const explicit = reproCommand('print(1)', { workspace: '/w', python: "/v/bin/py'thon", env: { A: 'b c' } });
    expect(explicit).toContain(`'/v/bin/py'\\''thon' -c`);
    expect(explicit).toContain("env A='b c' ");
    expect(explicit).not.toContain('JEV_PY');
  });
});

describe('output parsing and runRepro', () => {
  const payload = { ok: true, python: '3.9.6', results: [{ chunk: 0, stmt: 0, source: 'x = 1', kind: 'stmt', value: null, stdout: '', exception: null, fixup: null, environment: false, ms: 0 }, { chunk: 1, stmt: 0, source: 'x + 1', kind: 'expr', value: '2', type_name: 'int', stdout: '', exception: null, fixup: 'from m import x', environment: false, ms: 1 }] };

  it('parseReproOutput reads the sentinel line and maps statements; no sentinel gives null', () => {
    const parsed = parseReproOutput(`warning noise\n${REPRO_SENTINEL}${JSON.stringify(payload)}\n`)!;
    expect(parsed.python).toBe('3.9.6');
    expect(parsed.statements[1]).toMatchObject({ chunk: 1, kind: 'expr', value: '2', typeName: 'int', fixup: 'from m import x' });
    expect(parseReproOutput('nothing here')).toBeNull();
    expect(parseReproOutput(`${REPRO_SENTINEL}{not json`)).toBeNull();
  });

  it('runRepro with a fake run: ran / timeout / error statuses', async () => {
    const fake = (stdout: string, over: Partial<{ exitCode: number | null; timedOut: boolean }> = {}): VerifyRunFn => async () => ({ stdout, stderr: '', exitCode: 0, ...over });
    const ok = await runRepro(fake(`${REPRO_SENTINEL}${JSON.stringify(payload)}`), ['x = 1', 'x + 1'], { workspace: '/w', packageName: null });
    expect(ok.status).toBe('ran');
    expect(ok.statements).toHaveLength(2);
    const to = await runRepro(fake('', { timedOut: true, exitCode: null }), ['while True: pass'], { workspace: '/w', packageName: null });
    expect(to.status).toBe('timeout');
    const err = await runRepro(fake('Traceback…', { exitCode: 1 }), ['x'], { workspace: '/w', packageName: null });
    expect(err.status).toBe('error');
    expect(err.outputTail).toContain('Traceback');
  });

  it.skipIf(!pythonAvailable)('runs for real with python3: repr of expressions, stdout of prints, exceptions with frames, NameError fix-up of a stdlib module', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'jev-oracle-'));
    writeFileSync(join(ws, 'mylib.py'), 'def twice(x):\n    return 2 * x\n\ndef boom():\n    raise ValueError("bad " + "value")\n');
    const run: VerifyRunFn = async (command, opts) => {
      const r = spawnSync('/bin/sh', ['-c', command], { cwd: opts.cwd, encoding: 'utf8', timeout: opts.timeoutMs });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status };
    };
    const res = await runRepro(run, ['from mylib import twice, boom', 'twice(21)', 'print(twice(1), "x")', 'boom()', 'math.sqrt(4)'], { workspace: ws, packageName: 'mylib', python: 'python3' });
    expect(res.status).toBe('ran');
    const [imp, val, printed, exc, fixed] = res.statements;
    expect(imp?.kind).toBe('stmt');
    expect(val).toMatchObject({ kind: 'expr', value: '42', typeName: 'int' });
    expect(printed).toMatchObject({ value: null, stdout: '2 x\n' });
    expect(exc?.exception).toMatchObject({ type: 'ValueError', message: 'bad value' });
    expect(exc?.exception?.frames.at(-1)).toMatchObject({ fn: 'boom', line: 5 });
    expect(fixed).toMatchObject({ value: '2.0', fixup: 'import math' });
  });
});

describe('normaliseValue and valuesEqual', () => {
  it.each([
    ['whitespace', "'Max[x, 2]'", "'Max[x,2]'"],
    ['quote style', '"abc"', "'abc'"],
    ['trailing zeros', '4.00000000000000', '4.0'],
    ['trailing zeros keep digits', '1.50', '1.5'],
    ['dict key order', "{'b': 2, 'a': 1}", "{'a': 1, 'b': 2}"],
    ['memory address', '<Foo object at 0x7f3a2b1c>', '<Foo object>'],
    ['trailing comment', "'3 x' # I typed this", "'3 x'"],
    ['repr vs printed string', "'Max[x, 2]'", 'Max[x, 2]'],
    ['repr newline escapes vs pasted lines', "'def f(x):\\n    return x\\n'", 'def f(x):\n    return x'],
  ])('%s', (_name, a, b) => {
    expect(valuesEqual(a, b)).toBe(true);
  });

  it('loose equality: same tokens in another order, never different tokens', () => {
    expect(valuesEqualLoose("'Max[2, x]'", "'Max[x,2]'")).toBe(true);
    expect(valuesEqualLoose("'Max(2, x)'", "'Max[x,2]'")).toBe(false);
    expect(valuesEqualLoose('sqrt(5)', '1')).toBe(false);
    expect(valuesEqualLoose('', '')).toBe(false);
  });

  it('does not equate different values', () => {
    expect(valuesEqual('1', 'sqrt(5)')).toBe(false);
    expect(valuesEqual('100', '10')).toBe(false);
    expect(valuesEqual("'Max(2, x)'", "'Max[x,2]'")).toBe(false);
    expect(normaliseValue('100')).toBe('100');
    expect(normaliseValue('4.')).toBe('4.0');
  });
});

describe('buildCriterion (code, from the failure kind and the expected text)', () => {
  const repro = replBlock(0, [{ source: 'f(1)', shown: '2' }]);
  const noExp = { expectations: [] };

  it('exception_raised → no_exception naming the reported exception', () => {
    const b = buildCriterion({ failureKind: 'exception_raised', reproduction: repro, expected: null, actual: null, ...noExp }, [{ exceptionType: 'TypeError' }])!;
    expect(b.criterion).toEqual({ form: 'no_exception' });
    expect(b.strength).toBe('strong');
    expect(b.expectedText).toBe('completes without raising TypeError');
  });

  it('should_raise_but_does_not → raises <type> from a sentence; null without a type', () => {
    const b = buildCriterion({ failureKind: 'should_raise_but_does_not', reproduction: repro, expected: null, actual: null, expectations: [{ text: 'it should raise ValueError', pattern: 'should', values: [], line: 1 }] })!;
    expect(b.criterion).toEqual({ form: 'raises', exceptionType: 'ValueError' });
    expect(buildCriterion({ failureKind: 'should_raise_but_does_not', reproduction: repro, expected: null, actual: null, ...noExp })).toBeNull();
  });

  it('wrong_value with a separate expected block → the last shown value of that block, compared at the last statement', () => {
    const expected = replBlock(1, [{ source: 'g(1)', shown: 'DMP([], EX, None)' }]);
    const b = buildCriterion({ failureKind: 'wrong_value', reproduction: repro, expected, actual: repro, ...noExp })!;
    expect(b.criterion).toEqual({ form: 'values', expected: [{ chunk: 'last', text: 'DMP([], EX, None)' }], observedActual: '2' });
    expect(b.strength).toBe('strong');
  });

  it('wrong_value where the reproduction itself shows the expected values → per-statement values shifted by the context offset', () => {
    const both = replBlock(0, [{ source: 'a', shown: '1' }, { source: 'b', shown: null }, { source: 'c', shown: '3' }]);
    const b = buildCriterion({ failureKind: 'wrong_value', reproduction: both, expected: both, actual: null, chunkOffset: 2, ...noExp })!;
    expect(b.criterion).toEqual({ form: 'values', expected: [{ chunk: 2, text: '1' }, { chunk: 4, text: '3' }] });
  });

  it('wrong_value with a sentence → its expected value (and the wrong one it names); with nothing → weak differs_from_actual; performance → null', () => {
    const s = buildCriterion({ failureKind: 'wrong_value', reproduction: repro, expected: null, actual: null, expectations: [{ text: "I would expect the output `'Max[x,2]'` but instead I get `'Max(2, x)'`", pattern: 'but_got', values: ["'Max[x,2]'", "'Max(2, x)'"], line: 1 }] })!;
    expect(s.criterion).toEqual({ form: 'values', expected: [{ chunk: 'last', text: "'Max[x,2]'" }], observedActual: "'Max(2, x)'" });
    const w = buildCriterion({ failureKind: 'wrong_value', reproduction: repro, expected: null, actual: repro, ...noExp })!;
    expect(w.criterion).toEqual({ form: 'differs_from_actual', actual: '2' });
    expect(w.strength).toBe('weak');
    expect(buildCriterion({ failureKind: 'performance', reproduction: repro, expected: null, actual: null, ...noExp })).toBeNull();
    expect(buildCriterion({ failureKind: 'none_of_these', reproduction: repro, expected: null, actual: null, ...noExp })).toBeNull();
  });

  it('wrong_type → type_name from the sentence', () => {
    const b = buildCriterion({ failureKind: 'wrong_type', reproduction: repro, expected: null, actual: null, expectations: [{ text: 'the result should be a `tuple`', pattern: 'should', values: ['tuple'], line: 1 }] })!;
    expect(b.criterion).toEqual({ form: 'type_name', expected: 'tuple' });
  });
});

describe('evaluateCriterion', () => {
  const values: Criterion = { form: 'values', expected: [{ chunk: 'last', text: "'Max[x, 2]'" }] };

  it('no_exception: passes when nothing raised, fails at the first raising statement (environment statements ignored)', () => {
    const ok = evaluateCriterion({ form: 'no_exception' }, ran([stmt({ kind: 'stmt' }), stmt({ chunk: 1, value: '3' })]));
    expect(ok).toMatchObject({ pass: true, actual: '3' });
    const env = stmt({ exception: { type: 'ModuleNotFoundError', message: 'numpy', frames: [] }, environment: true });
    const bad = evaluateCriterion({ form: 'no_exception' }, ran([env, stmt({ chunk: 1, source: 'qs1 | qs2', exception: { type: 'AssertionError', message: '', frames: [] } })]));
    expect(bad.pass).toBe(false);
    expect(bad.actual).toBe('AssertionError: ');
    expect(bad.reason).toContain('qs1 | qs2');
  });

  it('raises: passes only when the named exception is raised', () => {
    expect(evaluateCriterion({ form: 'raises', exceptionType: 'ValueError' }, ran([stmt({ exception: { type: 'ValueError', message: 'x', frames: [] } })])).pass).toBe(true);
    expect(evaluateCriterion({ form: 'raises', exceptionType: 'ValueError' }, ran([stmt({ exception: { type: 'TypeError', message: 'x', frames: [] } })])).pass).toBe(false);
    expect(evaluateCriterion({ form: 'raises', exceptionType: 'ValueError' }, ran([stmt({ value: '1' })])).pass).toBe(false);
  });

  it('values: repr, stdout and normalisation; a raise is a mismatch; per-chunk targets', () => {
    expect(evaluateCriterion(values, ran([stmt({ value: "'Max[x,2]'" })])).pass).toBe(true);
    expect(evaluateCriterion(values, ran([stmt({ value: null, stdout: 'Max[x, 2]\n' })])).pass).toBe(true);
    expect(evaluateCriterion(values, ran([stmt({ value: "'Max(2, x)'" })])).pass).toBe(false);
    expect(evaluateCriterion(values, ran([stmt({ exception: { type: 'NameError', message: 'x', frames: [] } })])).pass).toBe(false);
    // loose tier: the printer's canonical argument order passes, the recorded wrong value never does
    const withActual: Criterion = { ...values, observedActual: "'Max(2, x)'" };
    const loose = evaluateCriterion(withActual, ran([stmt({ value: "'Max[2, x]'" })]));
    expect(loose.pass).toBe(true);
    expect(loose.reason).toContain('loose match');
    expect(evaluateCriterion(withActual, ran([stmt({ value: "'Max(2, x)'" })])).pass).toBe(false);
    expect(evaluateCriterion({ form: 'values', expected: [{ chunk: 0, text: "'Max[x,2]'" }] }, ran([stmt({ value: "'Max[2, x]'" })])).pass).toBe(false);
    const perChunk: Criterion = { form: 'values', expected: [{ chunk: 0, text: '1' }, { chunk: 2, text: '3' }] };
    expect(evaluateCriterion(perChunk, ran([stmt({ chunk: 0, value: '1' }), stmt({ chunk: 1, kind: 'stmt' }), stmt({ chunk: 2, value: '3' })])).pass).toBe(true);
    const miss = evaluateCriterion(perChunk, ran([stmt({ chunk: 0, value: '1' }), stmt({ chunk: 1, kind: 'stmt' }), stmt({ chunk: 2, value: '4' })]));
    expect(miss.pass).toBe(false);
    expect(miss.reason).toContain('"4" != "3"');
  });

  it('type_name and differs_from_actual', () => {
    expect(evaluateCriterion({ form: 'type_name', expected: 'tuple' }, ran([stmt({ value: '(1,)', typeName: 'tuple' })])).pass).toBe(true);
    expect(evaluateCriterion({ form: 'type_name', expected: 'tuple' }, ran([stmt({ value: '[1]', typeName: 'list' })])).pass).toBe(false);
    expect(evaluateCriterion({ form: 'differs_from_actual', actual: 'f(g(2))' }, ran([stmt({ stdout: 'f(g(2))\n' })])).pass).toBe(false);
    expect(evaluateCriterion({ form: 'differs_from_actual', actual: 'f(g(2))' }, ran([stmt({ stdout: '16.0000000000000\n' })])).pass).toBe(true);
    expect(evaluateCriterion({ form: 'differs_from_actual', actual: 'f(g(2))' }, ran([stmt({ exception: { type: 'TypeError', message: '', frames: [] } })])).pass).toBe(false);
  });

  it('a run that did not report results never passes', () => {
    const to: ReproRunResult = { status: 'timeout', python: null, statements: [], exitCode: null, durationMs: 30_000, outputTail: '' };
    expect(evaluateCriterion({ form: 'no_exception' }, to)).toMatchObject({ pass: false, actual: 'timeout after 30 s' });
    expect(evaluateCriterion({ form: 'no_exception' }, ran([stmt({ environment: true, exception: { type: 'ModuleNotFoundError', message: 'bug', frames: [] } })])).pass).toBe(false);
  });
});

describe('chunks and context', () => {
  it('chunksOf: one chunk per REPL statement, one for a code block; boundNames reads assignments, defs and imports', () => {
    expect(chunksOf(replBlock(0, [{ source: 'a = 1', shown: null }, { source: 'a', shown: '1' }]))).toEqual(['a = 1', 'a']);
    expect(chunksOf(codeBlock(0, 'x = 1\ny = x'))).toEqual(['x = 1\ny = x']);
    expect(boundNames('from sympy import Poly, symbols as sy\nimport numpy as np\ncoeff, bad_poly = f.clear_denoms()\ndef g(): pass\nclass C: pass').sort()).toEqual(['C', 'Poly', 'bad_poly', 'coeff', 'g', 'np', 'sy']);
  });

  it('chunksWithContext prepends the earlier blocks that bind the names a later block uses (transitively)', () => {
    const b0 = replBlock(0, [{ source: 'from sympy import *', shown: null }, { source: 'x = symbols("x")', shown: null }, { source: 'f = Poly(x)', shown: null }]);
    const b1 = replBlock(1, [{ source: 'coeff, bad_poly = f.clear_denoms()', shown: null }]);
    const b2 = codeBlock(2, 'unrelated = 1');
    const b3 = replBlock(3, [{ source: 'bad_poly.rep', shown: 'DMP([EX(0)], EX, None)' }]);
    const ex: Extraction = { blocks: [b0, b1, b2, b3], tracebacks: [], expectations: [] };
    const c = chunksWithContext(b3, ex);
    expect(c.contextBlocks).toEqual([0, 1]);
    expect(c.offset).toBe(4);
    expect(c.chunks).toEqual(['from sympy import *', 'x = symbols("x")', 'f = Poly(x)', 'coeff, bad_poly = f.clear_denoms()', 'bad_poly.rep']);
    expect(chunksWithContext(b0, ex)).toEqual({ chunks: chunksOf(b0), offset: 0, contextBlocks: [] });
  });

  it('a `from X import *` block is context when later names are still unresolved', () => {
    const star = replBlock(0, [{ source: 'from django.db.models import *', shown: null }]);
    const other = codeBlock(1, 'y = 2');
    const use = replBlock(2, [{ source: 'Book.objects.annotate(idx=F("id")).aggregate(Sum("id", default=0))', shown: null }]);
    const c = chunksWithContext(use, { blocks: [star, other, use], tracebacks: [], expectations: [] });
    expect(c.contextBlocks).toEqual([0]);
    expect(c.offset).toBe(1);
  });

  it('on the real sympy-12096 fixture the REPL block yields six chunks and no context', () => {
    const ex = extractBlocks(String(spawnSync('cat', [join(import.meta.dirname, '../../../fixtures/synth/oracle/sympy__sympy-12096.md')], { encoding: 'utf8' }).stdout));
    const c = chunksWithContext(ex.blocks[0]!, ex);
    expect(c.chunks).toHaveLength(6);
    expect(c.offset).toBe(0);
  });
});
