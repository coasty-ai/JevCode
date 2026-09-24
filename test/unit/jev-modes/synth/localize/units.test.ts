import { describe, expect, it } from 'vitest';
import { QuestionBuildError, choice } from '../../../../../src/jev/questions.js';
import { clip, clipTail, codeLines, confirmStage, entryAt, fileStage, functionEntries, functionKey, functionStage, lineKey, lineOfKey, lineStage, moduleCodeLines, moduleEntry, outline, pathKey, tracebackFrames } from '../../../../../src/jev-modes/synth/localize/index.js';
import { GEOMETRY_FAILURE, fixture, sf, twoFileWorkspace } from './helpers.js';

const geometry = sf('pkg/geometry.py', fixture('pkg/geometry.py'));

describe('keys', () => {
  it('derives descriptive snake_case keys that the choice builder accepts', () => {
    const used = new Set<string>();
    expect(functionKey('Point.distance', used)).toBe('point_distance');
    expect(functionKey('Point.distance', used)).toBe('point_distance_2');
    expect(functionKey('a', used)).toBe('fn_a'); // single letters carry a name prior
    expect(functionKey('_ArgumentsManager._add_parser_option', used)).toBe('argumentsmanager_add_parser_option');
    expect(pathKey('django/forms/models.py', new Set())).toBe('django_forms_models_py');
    expect(pathKey('1.py', new Set())).toBe('file_1_py');
    expect(lineOfKey(lineKey(42))).toBe(42);
    expect(lineOfKey('none_of_these')).toBeNull();
    for (const k of ['point_distance', 'fn_a', 'argumentsmanager_add_parser_option', 'django_forms_models_py', 'file_1_py']) expect(() => choice('q', { [k]: null })).not.toThrow();
    expect(() => choice('q', { a: null })).toThrow(QuestionBuildError);
  });
});

describe('outline and function enumeration', () => {
  it('lists depth-0 symbols and flattens nested classes into qualnames', () => {
    expect(outline(geometry.mod)).toEqual(['class Point', 'midpoint()', 'clamp_point()']);
    const entries = functionEntries(geometry);
    expect(entries.map((e) => [e.qualname, e.kind, e.headerLine, e.startLine, e.endLine])).toEqual([
      ['Point.__init__', 'method', 10, 10, 12],
      ['Point.distance', 'method', 14, 14, 17],
      ['Point.Meta.describe', 'method', 20, 20, 21],
      ['midpoint', 'function', 24, 24, 26],
      ['clamp_point', 'function', 29, 29, 31],
    ]);
    expect(entryAt(entries, 17)!.qualname).toBe('Point.distance');
    expect(entryAt(entries, 4)).toBeUndefined();
    expect(moduleEntry(geometry)).toMatchObject({ qualname: '<module>', kind: 'module', startLine: 1, endLine: 31, blockIndex: null });
  });

  it('folds defs nested in defs into the enclosing def and caps the outline', () => {
    const f = sf('n.py', 'def outer(x):\n    def inner(y):\n        return y\n    return inner(x)\n' + Array.from({ length: 45 }, (_, i) => `def f${i}():\n    pass\n`).join(''));
    expect(functionEntries(f).map((e) => e.qualname)).not.toContain('outer.inner');
    expect(functionEntries(f)[0]!.qualname).toBe('outer');
    const o = outline(f.mod);
    expect(o).toHaveLength(41);
    expect(o[40]).toBe('... 6 more');
  });

  it('code lines drop blanks, comments and docstrings; module lines exclude def bodies', () => {
    expect(codeLines(geometry.mod, 1, 12).map((c) => c.line)).toEqual([2, 4, 7, 10, 11, 12]); // module docstring (1) and class docstring (8) excluded
    expect(codeLines(geometry.mod, 29, 31).map((c) => c.line)).toEqual([29, 31]);
    expect(moduleCodeLines(geometry.mod).map((c) => c.line)).toEqual([2, 4, 7, 19]);
    const gcd = sf('gcd.py', fixture('gcd.py'));
    expect(codeLines(gcd.mod, 1, gcd.mod.lines.length).map((c) => c.line)).toEqual([1, 2, 3, 4, 5]); // trailing QuixBugs docstring stripped
  });

  it('resolves traceback frames to workspace paths by suffix', () => {
    const files = twoFileWorkspace();
    const tb = 'Traceback (most recent call last):\n  File "/w/tests/test_g.py", line 7, in test_distance\n  File "/w/pkg/geometry.py", line 17, in distance\n  File "pkg/utils.py", line 5, in clamp\n  File "C:\\w\\pkg\\utils.py", line 6, in clamp\nValueError';
    expect(tracebackFrames(tb, files)).toEqual([
      { path: 'pkg/geometry.py', line: 17, fn: 'distance' },
      { path: 'pkg/utils.py', line: 5, fn: 'clamp' },
      { path: 'pkg/utils.py', line: 6, fn: 'clamp' },
    ]);
    expect(tracebackFrames(undefined, files)).toEqual([]);
    expect(tracebackFrames('no frames here', files)).toEqual([]);
  });
});

describe('question builders', () => {
  it('file stage: context Nouls with criteria once in the state', () => {
    const r = fileStage('do it', [GEOMETRY_FAILURE], undefined, ['a/b.py', 'c.py'], 3);
    expect(r.state).toEqual({
      task: 'do it',
      failing_tests: [{ test: GEOMETRY_FAILURE.testId, call: GEOMETRY_FAILURE.call, expected: '5.0', actual: 'ValueError: math domain error' }],
      criteria: { yes_when: expect.stringContaining('lands in this file'), no_when: expect.stringContaining('merely imports') },
      files: ['a/b.py', 'c.py'],
    });
    expect(r.questions['c.py']).toEqual({ type: 'noul', instructions: 'Must the file `c.py` (listed in `files`) be modified to accomplish `task`? Apply `criteria`.' });
  });

  it('confirm stage: criteria carry definition + examples on both sides', () => {
    const r = confirmStage('do it', [], 'tb', new Map([['x.py', ['f()']]]), 3);
    const q = r.questions['x.py']!;
    expect(q.type).toBe('noul');
    if (q.type === 'noul') {
      expect(q.criteria!.true).toMatchObject({ definition: expect.any(String), examples: expect.arrayContaining([expect.any(String)]) });
      expect(q.criteria!.false).toMatchObject({ definition: expect.any(String), examples: expect.arrayContaining([expect.any(String)]) });
    }
    expect(r.state).toEqual({ task: 'do it', traceback: 'tb', files: { 'x.py': { top_level_symbols: ['f()'] } } });
  });

  it('function stage: Choice keys with null descriptions, module-level option and escape', () => {
    const r = functionStage('t', [], undefined, 'x.py', [{ key: 'fn_f', description: 'function f, line 1: def f():' }], 3);
    const q = r.questions['where']!;
    expect(q.type).toBe('choice');
    if (q.type === 'choice') expect(Object.keys(q.criteria)).toEqual(['fn_f', 'module_level_code_outside_any_function', 'none_of_these']);
    expect(q.instructions).toContain('`file.functions`');
    expect(q.instructions).toContain('pick `module_level_code_outside_any_function`');
  });

  it('line stage: levels drop the traceback and then the extra tests; long lines are clipped', () => {
    const lines = [{ line: 3, text: `    x = ${'y'.repeat(500)}` }];
    const failures = [GEOMETRY_FAILURE, { ...GEOMETRY_FAILURE, testId: 'b', call: 'b()' }];
    const l0 = lineStage({ task: 't', failures, traceback: 'tb', lines, where: { file: 'x.py', function: 'f' }, maxTests: 3 });
    const s0 = l0.state as Record<string, unknown>;
    expect(Object.keys(s0)).toEqual(['task', 'program', 'file', 'function', 'tests', 'failing_test_run', 'traceback']);
    expect((s0['program'] as Record<string, string>)['L3']!.length).toBeLessThan(260);
    expect((s0['tests'] as unknown[]).length).toBe(2);
    const s1 = lineStage({ task: 't', failures, traceback: 'tb', lines, maxTests: 3 }, 1).state as Record<string, unknown>;
    expect('traceback' in s1).toBe(false);
    expect('file' in s1).toBe(false);
    const s2 = lineStage({ task: 't', failures, traceback: 'tb', lines, maxTests: 3 }, 2).state as Record<string, unknown>;
    expect((s2['tests'] as unknown[]).length).toBe(1);
  });

  it('clip helpers mark what was dropped', () => {
    expect(clip('abc', 5)).toBe('abc');
    expect(clip('abcdefgh', 5)).toBe('abcde… [3 more characters]');
    expect(clipTail('abcdefgh', 3)).toBe('[5 earlier characters omitted] …fgh');
  });
});
