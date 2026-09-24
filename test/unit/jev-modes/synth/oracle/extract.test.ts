import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { exceptionTypeIn, expectationsIn, expectedActualOf, extractBlocks, isTestModule, looksLikeCode, normaliseRepl, parseRepl, parseTraceback, stripTrailingComment, tracebacksIn } from '../../../../../src/jev-modes/synth/oracle/extract.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '../../../../fixtures/synth/oracle');
const fixture = (id: string): string => readFileSync(join(FIXTURES, `${id}.md`), 'utf8');

describe('extractBlocks on real problem statements', () => {
  it('django-15128: Trac strips the markdown; the tab-indented bare code is one block, tabs kept', () => {
    const ex = extractBlocks(fixture('django__django-15128'));
    expect(ex.blocks).toHaveLength(1);
    const b = ex.blocks[0]!;
    expect(b.kind).toBe('code');
    expect(b.origin).toBe('bare');
    expect(b.text.startsWith('from django.db import models\nclass Foo(models.Model):\n\tqux = models.ForeignKey(')).toBe(true);
    expect(b.text.trimEnd().endsWith('qs1 | qs2')).toBe(true);
    expect(b.text).toContain('# Failing tests');
    expect(b.text).not.toContain('Description');
    expect(ex.expectations.some((e) => e.pattern === 'raises' && exceptionTypeIn(e.text) === 'AssertionError')).toBe(true);
  });

  it('sympy-12096: a fenced `>>>` transcript becomes a REPL block with per-statement shown values', () => {
    const ex = extractBlocks(fixture('sympy__sympy-12096'));
    expect(ex.blocks).toHaveLength(1);
    const b = ex.blocks[0]!;
    expect(b.kind).toBe('repl');
    expect(b.origin).toBe('fence');
    expect(b.lang).toBeNull();
    expect(b.repl?.statements).toHaveLength(6);
    const n = normaliseRepl(b.repl!);
    expect(n.statements[0]).toBe('from sympy.utilities.lambdify import implemented_function');
    expect(n.script.split('\n')).toHaveLength(6);
    expect(n.shown).toEqual([
      { statement: 3, text: '4.00000000000000', traceback: null },
      { statement: 4, text: '4.00000000000000', traceback: null },
      { statement: 5, text: 'f(g(2))', traceback: null },
    ]);
    expect(ex.tracebacks).toHaveLength(0);
  });

  it('requests-1142: no snippet at all, but the "right behavior" sentence is an expectation', () => {
    const ex = extractBlocks(fixture('psf__requests-1142'));
    expect(ex.blocks).toHaveLength(0);
    expect(ex.expectations.length).toBeGreaterThanOrEqual(1);
  });

  it('pytest-7205: a python fence (the test file) and a pytest-style traceback block', () => {
    const ex = extractBlocks(fixture('pytest-dev__pytest-7205'));
    expect(ex.blocks.map((b) => b.kind)).toEqual(['code', 'traceback']);
    expect(ex.blocks[0]!.lang).toBe('python');
    expect(ex.blocks[0]!.text).toContain("@pytest.mark.parametrize('data', [b'Hello World'])");
    const tb = ex.blocks[1]!.tracebacks[0]!;
    expect(tb.style).toBe('pytest');
    expect(tb.exceptionType).toBe('BytesWarning');
    expect(tb.message).toBe('str() on a bytes instance');
    expect(tb.frames.length).toBeGreaterThanOrEqual(15);
    expect(tb.frames).toContainEqual({ file: 'src/_pytest/setuponly.py', line: 34, fn: 'pytest_fixture_setup', code: '_show_fixture_action(fixturedef, "SETUP")' });
    expect(tb.frames.at(-1)).toMatchObject({ file: 'src/_pytest/setuponly.py', line: 69 });
    expect(ex.tracebacks).toHaveLength(1);
  });

  it('sympy-17139: REPL whose last statement shows a Python traceback (16 frames, innermost __lt__)', () => {
    const ex = extractBlocks(fixture('sympy__sympy-17139'));
    const b = ex.blocks[0]!;
    expect(b.kind).toBe('repl');
    const last = b.repl!.statements[2]!;
    expect(last.source).toBe('print(simplify(cos(x)**I))');
    expect(last.traceback?.exceptionType).toBe('TypeError');
    expect(last.traceback?.message).toBe('Invalid comparison of complex I');
    expect(last.traceback?.frames).toHaveLength(16);
    expect(last.traceback?.frames.at(-1)).toEqual({ file: '/home/e/se/sympy/core/expr.py', line: 406, fn: '__lt__', code: 'raise TypeError("Invalid comparison of complex %s" % me)' });
    expect(last.traceback?.frames[0]).toMatchObject({ file: '<stdin>', line: 1, fn: '<module>' });
    // the REPL's shown values exclude the traceback from the normalised expected values
    expect(normaliseRepl(b.repl!).shown[0]?.traceback?.exceptionType).toBe('TypeError');
  });

  it('django-15375: bare IPython transcripts split at the prose line; Out[n] prefixes are stripped', () => {
    const ex = extractBlocks(fixture('django__django-15375'));
    expect(ex.blocks.length).toBeGreaterThanOrEqual(2);
    const first = ex.blocks[0]!;
    expect(first.kind).toBe('repl');
    expect(first.repl?.prompt).toBe('ipython');
    expect(first.repl?.statements[3]).toMatchObject({ source: 'Book.objects.count()', shown: '95' });
    expect(first.repl?.statements[4]?.shown).toBe("{'id__sum': 4560}");
  });

  it('sympy-15345: a fence without a tag holding two lines of code is a code block; the sentence names expected and actual', () => {
    const ex = extractBlocks(fixture('sympy__sympy-15345'));
    expect(ex.blocks).toHaveLength(1);
    expect(ex.blocks[0]!.kind).toBe('code');
    const e = ex.expectations.find((x) => x.pattern === 'but_got')!;
    expect(e.values).toEqual(["'Max[x,2]'", "'Max(2, x)'"]);
    expect(expectedActualOf(e)).toEqual({ expected: "'Max[x,2]'", actual: "'Max(2, x)'" });
  });

  it('sympy-11618: "instead of `sqrt(5)`" names the expected value; the REPL shows the actual 1', () => {
    const ex = extractBlocks(fixture('sympy__sympy-11618'));
    expect(ex.blocks[0]!.repl?.statements[0]).toMatchObject({ source: 'Point(2,0).distance(Point(1,0,2))', shown: '1' });
    const e = ex.expectations.find((x) => x.pattern === 'instead_of')!;
    expect(expectedActualOf(e).expected).toBe('sqrt(5)');
  });

  it('pytest-10081: `>>>>>>> traceback >>>>>>>` separators are not REPL prompts', () => {
    const ex = extractBlocks(fixture('pytest-dev__pytest-10081'));
    expect(ex.blocks.some((b) => b.kind === 'repl')).toBe(false);
    expect(ex.blocks[0]).toMatchObject({ kind: 'code', lang: 'python' });
    expect(ex.blocks[0]!.text).toContain('@unittest.skip("hello")');
    const tb = ex.tracebacks.find((t) => t.exceptionType === 'NameError');
    expect(tb?.message).toBe("name 'xxx' is not defined");
  });
});

describe('REPL normalisation', () => {
  it('joins `...` continuation lines, attaches output to the statement, skips a bare prompt', () => {
    const t = parseRepl(['>>> def f(x):', '...     return x + 1', '...', '>>> f(1)', '2', '>>> ', '>>> print("a")', 'a'].join('\n'))!;
    expect(t.prompt).toBe('python');
    expect(t.statements.map((s) => s.source)).toEqual(['def f(x):\n    return x + 1', 'f(1)', 'print("a")']);
    expect(t.statements.map((s) => s.shown)).toEqual([null, '2', 'a']);
    const n = normaliseRepl(t);
    expect(n.script).toBe('def f(x):\n    return x + 1\nf(1)\nprint("a")');
    expect(n.shown).toEqual([
      { statement: 1, text: '2', traceback: null },
      { statement: 2, text: 'a', traceback: null },
    ]);
  });

  it('returns null without prompts and strips a trailing `# comment` from a single shown line', () => {
    expect(parseRepl('x = 1\nprint(x)')).toBeNull();
    expect(stripTrailingComment("'3 \\\\, x^{2} \\\\, y' # I typed the thin spaces in after the fact")).toBe("'3 \\\\, x^{2} \\\\, y'");
    expect(stripTrailingComment('{"a": 1}')).toBe('{"a": 1}');
    expect(stripTrailingComment('line one\nline two # not a comment tail')).toBe('line one\nline two # not a comment tail');
  });

  it('IPython: In/Out prompts with `...:` continuation', () => {
    const t = parseRepl(['In [1]: x = (1 +', '   ...:      2)', 'In [2]: x', 'Out[2]: 3'].join('\n'))!;
    expect(t.prompt).toBe('ipython');
    expect(t.statements[0]?.source).toBe('x = (1 +\n     2)');
    expect(t.statements[1]).toMatchObject({ source: 'x', shown: '3' });
  });
});

describe('tracebacks', () => {
  it('Python style: frames with code lines, exception type and message', () => {
    const tb = parseTraceback(['Traceback (most recent call last):', '  File "/w/tests/t.py", line 7, in test_x', '    assert f(1) == 2', '  File "/w/pkg/m.py", line 3, in f', '    return 1 / 0', 'ZeroDivisionError: division by zero'].join('\n'))!;
    expect(tb.style).toBe('python');
    expect(tb.exceptionType).toBe('ZeroDivisionError');
    expect(tb.message).toBe('division by zero');
    expect(tb.frames).toEqual([
      { file: '/w/tests/t.py', line: 7, fn: 'test_x', code: 'assert f(1) == 2' },
      { file: '/w/pkg/m.py', line: 3, fn: 'f', code: 'return 1 / 0' },
    ]);
  });

  it('a bare `ExcType: message` line is a frameless traceback; a type name alone is not', () => {
    const tbs = tracebacksIn("This results in the following exception\nAttributeError: 'functools.partial' object has no attribute '__name__'\nAttributeError\n");
    expect(tbs).toHaveLength(1);
    expect(tbs[0]).toMatchObject({ style: 'line', exceptionType: 'AttributeError', frames: [] });
  });

  it('a traceback cut before its exception line still yields its frames', () => {
    const tb = parseTraceback(['Traceback (most recent call last):', '  File "a.py", line 1, in <module>', '    raise ValueError("x")', 'which was the cause of the error'].join('\n'))!;
    expect(tb.frames).toHaveLength(1);
    expect(tb.exceptionType).toBe('');
  });
});

describe('code-line heuristics and expectations', () => {
  it('looksLikeCode', () => {
    for (const l of ['from django.db import models', 'class Foo(models.Model):', '\tqux = models.ForeignKey("app.Qux")', 'qs1 | qs2', 'assert f in d', 'Test().test_method()', 'G = DihedralGroup(18)', 'f = models.CharField(max_length=200)', ')']) expect(looksLikeCode(l), l).toBe(true);
    for (const l of ['Description', 'I have encountered this bug during working on a project.', 'Python Version: 3.9.2', 'Code to Reproduce', 'The bug was introduced in #31750.', '']) expect(looksLikeCode(l), l).toBe(false);
  });

  it('expectationsIn finds the pattern and the values; expectedActualOf reads them by pattern', () => {
    const es = expectationsIn('This should of course return `1.0` but instead fails with:\n\nI would expect `foo` here. It returns `bar` which is wrong. The return of `_imp_` is ignored.');
    // "should … but instead fails" is read as but_got (the earlier pattern wins); the expected value still follows "should"
    const should = es.find((e) => e.text.startsWith('This should'))!;
    expect(should.pattern).toBe('but_got');
    expect(should.values).toEqual(['1.0']);
    expect(expectedActualOf(should)).toEqual({ expected: '1.0', actual: null });
    const exp = es.find((e) => e.pattern === 'expected')!;
    expect(expectedActualOf(exp).expected).toBe('foo');
    const ret = es.find((e) => e.text.startsWith('It returns'))!;
    expect(expectedActualOf(ret).expected).toBe('bar');
    // "the return of `_imp_`" names no returned value: the value does not follow the verb
    const noun = es.find((e) => e.text.startsWith('The return of'))!;
    expect(expectedActualOf(noun).expected).toBeNull();
  });

  it('isTestModule: test files and fixtures need a command oracle; plain snippets do not', () => {
    expect(isTestModule(extractBlocks(fixture('pytest-dev__pytest-7205')).blocks[0]!.text)).toBe(true);
    expect(isTestModule(extractBlocks(fixture('pytest-dev__pytest-10081')).blocks[0]!.text)).toBe(true);
    expect(isTestModule('import unittest\nclass T(unittest.TestCase): pass')).toBe(true);
    expect(isTestModule('import logging\n\ndef test(caplog) -> None:\n    pass')).toBe(true);
    expect(isTestModule(extractBlocks(fixture('django__django-15128')).blocks[0]!.text)).toBe(false);
    // a reporter's own class named Test is not a test module (django-14787)
    expect(isTestModule('class Test:\n\t@method_decorator(logger)\n\tdef hello_world(self):\n\t\treturn "hello"\nTest().test_method()')).toBe(false);
    expect(isTestModule("x = symbols('x')\nmathematica_code(Max(x,2))")).toBe(false);
  });

  it('exceptionTypeIn', () => {
    expect(exceptionTypeIn('Query.change_aliases raises an AssertionError')).toBe('AssertionError');
    expect(exceptionTypeIn('should return 1.0')).toBeNull();
  });
});
