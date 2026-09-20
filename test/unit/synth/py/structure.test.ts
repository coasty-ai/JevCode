import { describe, expect, it } from 'vitest';
import { PyIndentationError } from '../../../../src/synth/py/errors.js';
import { PY_BUILTINS, analyse, blockAt, functionAt, lineScopes, scopeAt, splitPhysicalLines, statementAt } from '../../../../src/synth/py/structure.js';
import type { PyModule, Statement } from '../../../../src/synth/py/structure.js';
import { fixture } from './helpers.js';

const kinds = (mod: PyModule): string[] => mod.statements.map((s) => `${s.startLine}:${s.kind}`);
const stmt = (mod: PyModule, line: number): Statement => {
  const s = statementAt(mod, line);
  if (s === undefined) throw new Error(`no statement at line ${line}`);
  return s;
};

describe('analyse: knapsack.py', () => {
  const mod = analyse(fixture('knapsack'));
  it('lines and logical statements with kinds and spans', () => {
    expect(mod.lines).toHaveLength(37);
    expect(kinds(mod)).toEqual(['2:def', '3:from_import', '4:assign', '6:for', '7:assign', '9:for', '10:assign', '12:if', '13:assign', '18:return', '20:expr']);
    const multi = stmt(mod, 14);
    expect([multi.startLine, multi.endLine, multi.indent]).toEqual([13, 16, 16]);
    expect(multi.text).toBe('memo[i, j] = max(\n                    memo[i, j],\n                    value + memo[i - 1, j - weight]\n                )');
    expect(stmt(mod, 12).header).toBe(true);
    expect(stmt(mod, 12).colonIndex).toBe(4);
    expect(stmt(mod, 10).binds).toEqual([]); // subscript target binds nothing
    expect(stmt(mod, 7).binds).toEqual(['weight', 'value']);
    expect(stmt(mod, 6).binds).toEqual(['i']);
    expect(stmt(mod, 20).kind).toBe('expr'); // trailing module docstring
  });
  it('the function block', () => {
    expect(mod.blocks).toHaveLength(1);
    const b = mod.blocks[0]!;
    expect(b).toMatchObject({ kind: 'def', name: 'knapsack', isAsync: false, headerLine: 2, bodyStart: 3, bodyEnd: 18, endLine: 18, indent: 0, bodyIndent: 4, depth: 0, parent: null, decorators: [], returns: null, docstring: null });
    expect(b.params.map((p) => p.name)).toEqual(['capacity', 'items']);
    expect(blockAt(mod, 10)?.name).toBe('knapsack');
    expect(blockAt(mod, 25)).toBeUndefined();
  });
  it('function facts', () => {
    const fn = mod.functions[0]!;
    expect(fn.name).toBe('knapsack');
    expect(fn.identifiers).toEqual(['collections', 'defaultdict', 'memo', 'int', 'i', 'range', 'len', 'items', 'weight', 'value', 'j', 'capacity', 'max']);
    expect(fn.literals).toEqual({ numbers: ['1'], strings: [] });
    expect(fn.calls).toEqual([
      { callee: 'defaultdict', argCount: 1, line: 4 },
      { callee: 'range', argCount: 2, line: 6 },
      { callee: 'len', argCount: 1, line: 6 },
      { callee: 'range', argCount: 2, line: 9 },
      { callee: 'max', argCount: 2, line: 13 },
      { callee: 'len', argCount: 1, line: 18 },
    ]);
    expect(fn.attributes).toEqual([]);
    expect(fn.comparisons).toEqual(['<']);
    expect(fn.operators).toContain('-');
    expect(fn.returns).toEqual([{ line: 18, expr: 'memo[len(items), capacity]' }]);
    expect(functionAt(mod, 12)).toBe(fn);
  });
  it('imports table and module names', () => {
    expect(mod.imports).toEqual([{ line: 3, kind: 'from', module: 'collections', name: 'defaultdict', alias: null, bound: 'defaultdict', level: 0, scope: 'local', statementIndex: 1 }]);
    expect(mod.moduleNames).toEqual(['knapsack']);
  });
  it('in-scope identifiers per line, checked by hand', () => {
    // line 1: blank, module level, nothing bound yet
    const l1 = scopeAt(mod, 1);
    expect([l1.params, l1.locals, l1.module, l1.imports]).toEqual([[], [], [], []]);
    expect(l1.builtins).toEqual([...PY_BUILTINS]);
    // line 3: inside knapsack, only the params and the import on this very line
    const l3 = scopeAt(mod, 3);
    expect(l3).toMatchObject({ params: ['capacity', 'items'], locals: [], module: ['knapsack'], imports: ['defaultdict'], classAttrs: [], selfName: null });
    // line 4: memo is bound on this line, so it is in scope from here on
    expect(scopeAt(mod, 4).locals).toEqual(['memo']);
    // line 6: the loop variable of the `for` on that line counts
    expect(scopeAt(mod, 6).locals).toEqual(['memo', 'i']);
    // line 8 (blank inside the loop): weight and value from line 7 are visible, j is not yet
    expect(scopeAt(mod, 8).locals).toEqual(['memo', 'i', 'weight', 'value']);
    // line 12: everything bound so far
    const l12 = scopeAt(mod, 12);
    expect(l12.locals).toEqual(['memo', 'i', 'weight', 'value', 'j']);
    expect(l12.all.slice(0, 9)).toEqual(['capacity', 'items', 'memo', 'i', 'weight', 'value', 'j', 'knapsack', 'defaultdict']);
    expect(l12.all).toContain('len');
    expect(new Set(l12.all).size).toBe(l12.all.length);
    // line 25 (module docstring): back at module level, knapsack is bound
    const l25 = scopeAt(mod, 25);
    expect([l25.params, l25.locals, l25.module]).toEqual([[], [], ['knapsack']]);
    expect(lineScopes(mod)).toHaveLength(37);
    expect(lineScopes(mod)[11]!.locals).toEqual(l12.locals);
  });
});

describe('analyse: levenshtein.py', () => {
  const mod = analyse(fixture('levenshtein'));
  it('statements, block and facts', () => {
    expect(kinds(mod)).toEqual(['1:def', '2:if', '3:return', '5:elif', '6:return', '8:else', '9:return', '15:expr']);
    expect(mod.blocks[0]).toMatchObject({ name: 'levenshtein', headerLine: 1, bodyStart: 2, bodyEnd: 13 });
    expect(mod.blocks[0]!.params.map((p) => p.name)).toEqual(['source', 'target']);
    const fn = mod.functions[0]!;
    expect(fn.comparisons).toEqual(['==']);
    expect(fn.literals).toEqual({ numbers: ['0', '1'], strings: ["''"] });
    expect(fn.calls.filter((c) => c.callee === 'levenshtein').map((c) => c.argCount)).toEqual([2, 2, 2, 2]);
    expect(fn.calls.find((c) => c.callee === 'min')).toEqual({ callee: 'min', argCount: 3, line: 9 });
    expect(fn.calls.filter((c) => c.callee === 'len')).toHaveLength(2);
    expect(fn.returns.map((r) => r.line)).toEqual([3, 6, 9]);
    expect(fn.returns[2]!.expr).toBe('1 + min( levenshtein(source, target[1:]), levenshtein(source[1:], target[1:]), levenshtein(source[1:], target) )');
    expect(fn.keywords).toEqual(['if', 'or', 'return', 'elif', 'else']);
    expect(stmt(mod, 9).endLine).toBe(13);
  });
});

describe('analyse: topological_ordering.py', () => {
  const mod = analyse(fixture('topological_ordering'));
  it('comprehension `in` is not a comparison; attribute accesses and method calls', () => {
    const fn = mod.functions[0]!;
    expect(fn.comparisons).toEqual(['not in']);
    expect(fn.attributes).toEqual([
      { receiver: 'node', attr: 'incoming_nodes', line: 2 },
      { receiver: 'node', attr: 'outgoing_nodes', line: 5 },
      { receiver: '<expr>', attr: 'issuperset', line: 6 },
      { receiver: 'nextnode', attr: 'outgoing_nodes', line: 6 },
      { receiver: 'ordered_nodes', attr: 'append', line: 7 },
    ]);
    expect(fn.calls).toEqual([
      { callee: 'set', argCount: 1, line: 6 },
      { callee: '<expr>.issuperset', argCount: 1, line: 6 },
      { callee: 'ordered_nodes.append', argCount: 1, line: 7 },
    ]);
    expect(fn.identifiers).toEqual(['ordered_nodes', 'node', 'nodes', 'nextnode', 'set']);
    expect(mod.statements.map((s) => s.binds)).toEqual([['topological_ordering'], ['ordered_nodes'], ['node'], ['nextnode'], [], [], [], []]);
    expect(scopeAt(mod, 6).locals).toEqual(['ordered_nodes', 'node', 'nextnode']);
  });
});

describe('analyse: examples/demo-py calc/core.py', () => {
  const mod = analyse(fixture('calc_core'));
  it('module docstring, imports, module names', () => {
    expect(stmt(mod, 1)).toMatchObject({ kind: 'expr', startLine: 1, endLine: 5, blockIndex: null });
    expect(mod.imports.map((i) => [i.kind, i.module, i.name, i.bound, i.scope])).toEqual([
      ['from', '__future__', 'annotations', 'annotations', 'module'],
      ['import', 're', null, 're', 'module'],
      ['from', 'typing', 'Iterable', 'Iterable', 'module'],
    ]);
    expect(mod.moduleNames).toEqual(['annotations', 're', 'Iterable', 'add', 'safe_divide', 'mean', '_EXPR', 'parse_expression']);
  });
  it('blocks with annotated params and return annotations', () => {
    expect(mod.blocks.map((b) => [b.name, b.headerLine, b.bodyStart, b.bodyEnd, b.returns])).toEqual([
      ['add', 13, 14, 14, 'float'],
      ['safe_divide', 17, 18, 20, 'float | None'],
      ['mean', 23, 24, 27, 'float'],
      ['parse_expression', 33, 34, 37, 'tuple[float, str, float]'],
    ]);
    expect(mod.blocks[2]!.params).toEqual([{ name: 'values', star: '', annotation: 'Iterable[float]', default: null, text: 'values: Iterable[float]' }]);
  });
  it('function facts for mean and parse_expression', () => {
    const mean = mod.functions.find((f) => f.name === 'mean')!;
    expect(mean.calls).toEqual([
      { callee: 'list', argCount: 1, line: 24 },
      { callee: 'ValueError', argCount: 1, line: 26 },
      { callee: 'sum', argCount: 1, line: 27 },
      { callee: 'len', argCount: 1, line: 27 },
    ]);
    expect(mean.literals).toEqual({ numbers: ['1'], strings: ['"mean of empty sequence"'] });
    expect(mean.returns).toEqual([{ line: 27, expr: 'sum(items) / (len(items) + 1)' }]);
    expect(mean.keywords).toEqual(['if', 'not', 'raise', 'return']);
    const parse = mod.functions.find((f) => f.name === 'parse_expression')!;
    expect(parse.attributes).toEqual([
      { receiver: '_EXPR', attr: 'match', line: 34 },
      { receiver: 'm', attr: 'group', line: 37 },
      { receiver: 'm', attr: 'group', line: 37 },
      { receiver: 'm', attr: 'group', line: 37 },
    ]);
    expect(parse.calls.map((c) => c.callee)).toEqual(['_EXPR.match', 'ValueError', 'float', 'm.group', 'm.group', 'float', 'm.group']);
    expect(parse.literals.strings).toEqual(['f"cannot parse expression: {text!r}"']);
    expect(mod.functions.find((f) => f.name === 'safe_divide')!.comparisons).toEqual(['==']);
  });
  it('scope inside mean sees module names defined later in the file', () => {
    const sc = scopeAt(mod, 25);
    expect(sc.params).toEqual(['values']);
    expect(sc.locals).toEqual(['items']);
    expect(sc.module).toEqual(['add', 'safe_divide', 'mean', '_EXPR', 'parse_expression']);
    expect(sc.imports).toEqual(['annotations', 're', 'Iterable']);
    // module level before _EXPR is bound: only what precedes line 29
    expect(scopeAt(mod, 29).module).toEqual(['add', 'safe_divide', 'mean']);
    expect(scopeAt(mod, 30).module).toEqual(['add', 'safe_divide', 'mean', '_EXPR']);
  });
});

describe('analyse: tricky.py', () => {
  const mod = analyse(fixture('tricky'));
  it('statement kinds cover every keyword form', () => {
    const byLine = new Map(mod.statements.map((s) => [s.startLine, s.kind]));
    expect(byLine.get(1)).toBe('import');
    expect(byLine.get(2)).toBe('from_import');
    expect(byLine.get(12)).toBe('decorator');
    expect(byLine.get(14)).toBe('def');
    expect(byLine.get(15)).toBe('expr');
    expect(byLine.get(17)).toBe('assign');
    expect(byLine.get(23)).toBe('if');
    expect(byLine.get(24)).toBe('augassign');
    expect(byLine.get(37)).toBe('return');
    expect(byLine.get(40)).toBe('class');
    expect(byLine.get(53)).toBe('def'); // async def
    expect(byLine.get(54)).toBe('with'); // async with
    expect(byLine.get(56)).toBe('for'); // async for
    expect(byLine.get(57)).toBe('other'); // yield
    expect(byLine.get(62)).toBe('if');
    expect(byLine.get(63)).toBe('else');
    expect(byLine.get(64)).toBe('break');
    expect(byLine.get(70)).toBe('global');
    expect(byLine.get(71)).toBe('try');
    expect(byLine.get(72)).toBe('pass');
    expect(byLine.get(73)).toBe('except');
    expect(byLine.get(74)).toBe('raise');
    expect(byLine.get(78)).toBe('other'); // del
    expect(byLine.get(79)).toBe('finally');
    expect(byLine.get(80)).toBe('assert');
    expect(byLine.get(83)).toBe('while');
    expect(byLine.get(87)).toBe('nonlocal');
    expect(mod.statements.filter((s) => s.startLine === 65).map((s) => s.binds)).toEqual([['naïve'], ['other']]); // `;`-separated
    expect(mod.statements.filter((s) => s.startLine === 62).map((s) => s.kind)).toEqual(['if']); // one-liner `if λ: continue`
  });
  it('bindings: walrus, tuple targets, with/except as, lambda defaults excluded, global/nonlocal', () => {
    expect(stmt(mod, 23).binds).toEqual(['m']);
    expect(stmt(mod, 27).binds).toEqual(['fn']);
    expect(stmt(mod, 54).binds).toEqual(['resp']);
    expect(stmt(mod, 73).binds).toEqual(['err']);
    expect(stmt(mod, 81).binds).toEqual(['fh', 'gh']);
    expect(stmt(mod, 70).binds).toEqual(['CONST']);
    expect(stmt(mod, 87).binds).toEqual(['x']);
    expect(stmt(mod, 41).binds).toEqual(['count']); // annotated assignment
    expect(stmt(mod, 45).attrAssigns).toEqual([{ receiver: 'self', attr: 'name', line: 45 }]);
    expect(stmt(mod, 47).attrAssigns).toEqual([{ receiver: 'Thing', attr: 'count', line: 47 }]);
    expect(stmt(mod, 5).binds).toEqual(['abc', 'd']);
    expect(stmt(mod, 4).binds).toEqual(['*']);
  });
  it('blocks: decorators, async, params with markers/annotations/defaults, bases, nesting, tabs', () => {
    const decorated = mod.blocks.find((b) => b.name === 'decorated')!;
    expect(decorated).toMatchObject({ startLine: 12, headerLine: 14, bodyStart: 15, bodyEnd: 37, returns: '"Opt[int]"', decorators: ['decorator', 'ns.deco(arg=1, *args, **kw)'] });
    expect(decorated.docstring).toBe(`"""Docstring with ''' triple quotes''' inside\n    and a second line."""`);
    expect(decorated.params).toEqual([
      { name: 'x', star: '', annotation: null, default: null, text: 'x' },
      { name: 'y', star: '', annotation: null, default: '2', text: 'y=2' },
      { name: 'rest', star: '*', annotation: null, default: null, text: '*rest' },
      { name: 'z', star: '', annotation: 'int', default: '3', text: 'z: int = 3' },
      { name: 'opts', star: '**', annotation: null, default: null, text: '**opts' },
    ]);
    const thing = mod.blocks.find((b) => b.name === 'Thing')!;
    expect(thing).toMatchObject({ kind: 'class', bases: ['Base', 'metaclass=Meta'], bodyStart: 41, bodyEnd: 57, depth: 0 });
    expect(mod.blocks.filter((b) => b.parent === thing.index).map((b) => [b.name, b.depth, b.isAsync, b.decorators])).toEqual([
      ['__init__', 1, false, []],
      ['size', 1, false, ['property']],
      ['fetch', 1, true, []],
    ]);
    const tabbed = mod.blocks.find((b) => b.name === 'tabbed')!;
    expect([tabbed.indent, tabbed.bodyIndent, tabbed.bodyStart, tabbed.bodyEnd]).toEqual([0, 8, 61, 66]);
    const inner = mod.blocks.find((b) => b.name === 'inner')!;
    expect([inner.parent, inner.depth, inner.bodyStart, inner.bodyEnd]).toEqual([mod.blocks.find((b) => b.name === 'control')!.index, 1, 87, 88]);
    expect(blockAt(mod, 13)?.name).toBe('decorated'); // between decorators
    expect(blockAt(mod, 88)?.name).toBe('inner');
    expect(functionAt(mod, 51)?.name).toBe('size');
  });
  it('imports table: aliases, relative levels, star', () => {
    expect(mod.imports.map((i) => [i.module, i.name, i.alias, i.bound, i.level])).toEqual([
      ['os', null, null, 'os', 0],
      ['typing', 'List', null, 'List', 0],
      ['typing', 'Optional', 'Opt', 'Opt', 0],
      ['.', 'sibling', null, 'sibling', 1],
      ['..pkg.mod', '*', null, '*', 2],
      ['a.b.c', null, 'abc', 'abc', 0],
      ['d.e', null, null, 'd', 0],
    ]);
    expect(mod.moduleNames).not.toContain('*');
  });
  it('scope inside a method: params, class attributes via self.x, selfName', () => {
    const sc = scopeAt(mod, 46);
    expect(sc.params).toEqual(['self', 'name', 'value']);
    expect(sc.selfName).toBe('self');
    expect(sc.classAttrs).toEqual(['count', '_cache', '__init__', 'size', 'fetch', 'name', 'value']);
    expect(sc.all).not.toContain('count'); // class attributes are reached through self, not bare names
    // class body itself: class-level names bound so far are locals, no self
    const body = scopeAt(mod, 42);
    expect(body.locals).toEqual(['count', '_cache']);
    expect(body.selfName).toBeNull();
    // nested function sees the enclosing function's params and every one of its locals
    const innerScope = scopeAt(mod, 88);
    expect(innerScope.params).toEqual(['x']);
    expect(innerScope.locals).toEqual(['CONST', 'err', 'fh', 'gh', 'nonlocal_dummy', 'x', 'inner']);
    // module level after everything
    expect(scopeAt(mod, 90).module).toEqual(['CONST', 'WEIRD', 'decorated', 'Thing', 'tabbed', 'control']);
    expect(scopeAt(mod, 90).imports).toEqual(['os', 'List', 'Opt', 'sibling', 'abc', 'd']);
  });
  it('function facts: string literals include every prefix form, operators, comparisons', () => {
    const fn = mod.functions.find((f) => f.name === 'decorated')!;
    expect(fn.literals.strings).toContain(`rb"\\x00"`);
    expect(fn.literals.strings).toContain(`FR"{x}\\n"`);
    expect(fn.literals.numbers).toEqual(['2', '0', '10', '100', '3', '1']);
    expect(fn.comparisons).toEqual(['==', '>', '<', '<=', 'is not']);
    expect(fn.calls).toEqual([
      { callee: 'range', argCount: 1, line: 21 },
      { callee: 'len', argCount: 1, line: 23 },
      { callee: 'print', argCount: 5, line: 36 },
    ]);
    const fetch = mod.functions.find((f) => f.name === 'fetch')!;
    expect(fetch.calls).toEqual([
      { callee: 'session.get', argCount: 1, line: 54 },
      { callee: 'resp.json', argCount: 0, line: 55 },
    ]);
    const control = mod.functions.find((f) => f.name === 'control')!;
    expect(control.operators).toEqual(expect.arrayContaining(['~', '@', '|', '&', '^', '<<', '>>']));
    expect(control.calls.find((c) => c.callee === 'inner')).toBeUndefined(); // nested def header is not a call
  });
});

describe('analyse: small hand-written cases', () => {
  it('one-liner compound statements bind their inline body and report inline returns', () => {
    const mod = analyse('def f(x):\n    if x: y = 1; z.k = 2\n    for a in x: total = a\n    else: return total\n');
    expect(stmt(mod, 2).binds).toEqual(['y']);
    expect(stmt(mod, 2).attrAssigns).toEqual([{ receiver: 'z', attr: 'k', line: 2 }]);
    expect(stmt(mod, 3).binds).toEqual(['a', 'total']);
    expect(mod.functions[0]!.returns).toEqual([{ line: 4, expr: 'total' }]);
    expect(mod.blocks[0]).toMatchObject({ bodyStart: 2, bodyEnd: 4 });
  });
  it('a one-liner def has its body on the header line', () => {
    const mod = analyse('def f(): return 1\nx = f()\n');
    expect(mod.blocks[0]).toMatchObject({ headerLine: 1, bodyStart: 1, bodyEnd: 1 });
    expect(mod.functions[0]!.returns).toEqual([{ line: 1, expr: '1' }]);
    expect(mod.functions[0]!.literals.numbers).toEqual(['1']);
  });
  it('multi-line def headers and class bodies with methods using cls', () => {
    const mod = analyse('class A:\n    @classmethod\n    def make(\n        cls,\n        n: int = 0,\n    ) -> "A":\n        cls.count = n\n        return cls()\n');
    const make = mod.blocks.find((b) => b.name === 'make')!;
    expect([make.startLine, make.headerLine, make.headerEndLine, make.bodyStart, make.bodyEnd]).toEqual([2, 3, 6, 7, 8]);
    expect(make.params.map((p) => p.text)).toEqual(['cls', 'n: int = 0']);
    const sc = scopeAt(mod, 7);
    expect(sc.selfName).toBe('cls');
    expect(sc.classAttrs).toEqual(['make', 'count']);
  });
  it('chained assignment, starred and parenthesised targets', () => {
    const mod = analyse('a = b = 1\n(c, d), [e, *f] = x\ng[0] = h.i = j\nk: int\n');
    expect(mod.statements.map((s) => s.binds)).toEqual([['a', 'b'], ['c', 'd', 'e', 'f'], [], ['k']]);
    expect(mod.statements[2]!.attrAssigns).toEqual([{ receiver: 'h', attr: 'i', line: 3 }]);
    expect(mod.statements[3]!.kind).toBe('other');
  });
  it('splitPhysicalLines and analyse on empty / no-trailing-newline input', () => {
    expect(splitPhysicalLines('')).toEqual([]);
    expect(splitPhysicalLines('a\nb')).toEqual(['a', 'b']);
    expect(splitPhysicalLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(analyse('').statements).toEqual([]);
    expect(analyse('x = 1').statements[0]).toMatchObject({ kind: 'assign', binds: ['x'] });
  });
  it('rethrows tokenizer errors', () => {
    expect(() => analyse('if x:\n    y = 1\n  z = 2\n')).toThrow(PyIndentationError);
  });
});
