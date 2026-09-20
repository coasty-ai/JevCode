/**
 * The two introspection-fed template productions (src/synth/templates/introspect.ts): inert
 * without `EnumerateOptions.introspected` (identical candidate sets on QuixBugs sites), the
 * attribute-predicate guard on a synthetic function (subject from the raising line, falsy
 * predicates first, sibling return bodies, `_before` form at a replace site), the MRO alias at a
 * class-body gap and appended after a method's last line, the caps, `familyOf`, and the leakage
 * guard: neither the module texts nor the examples quote a benchmark gold line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyIntrospection } from '../../../../src/synth/introspect/index.js';
import type { IntrospectOperand, IntrospectedNames } from '../../../../src/synth/introspect/index.js';
import { INTROSPECT_ALIAS_DRAFTS_MAX, INTROSPECT_EXAMPLES, INTROSPECT_GUARD_DRAFTS_MAX, TEMPLATE_FAMILIES, createTemplateSource, familyOf } from '../../../../src/synth/templates/index.js';
import { benchmarkCorpus, leaks } from '../sketch/no-benchmark-leakage.test.js';
import { QUIXBUGS, REPO, applyCandidate, compileFailures, insertSite, norm, options, replaceSite, sourceFile, sourceFromText } from './helpers.js';

const source = createTemplateSource();

function operand(over: Partial<IntrospectOperand> & Pick<IntrospectOperand, 'expr'>): IntrospectOperand {
  return { typeName: 'T', classes: [], predicates: [], falsyPredicates: [], attributes: [], frame: null, raisingReceiver: false, ...over };
}

function names(over: Partial<IntrospectedNames>): IntrospectedNames {
  return { ...emptyIntrospection('ran', 'test'), ...over };
}

const FN = ['def transform(rv, limit):', '    for item in rv.parts:', '        if not item.flag:', '            return rv', '        if (item.exp < 0) == True:', '            return limit', '    return None', ''].join('\n');

describe('inert without introspection', () => {
  it('produces the same candidate set as before on QuixBugs sites and the introspect family is registered', () => {
    expect(TEMPLATE_FAMILIES).toContain('introspect');
    for (const [name, line] of [['gcd', 6], ['detect_cycle', 5], ['lis', 14]] as const) {
      const file = sourceFile(`${name}.py`, join(QUIXBUGS, `${name}.py`));
      const cands = source.enumerate(replaceSite(file, line), options());
      expect(cands.some((c) => familyOf(c.op) === 'introspect')).toBe(false);
      const withEmpty = source.enumerate(replaceSite(file, line), options({ introspected: names({ operands: [], classes: [] }) }));
      expect(withEmpty.map((c) => c.text)).toEqual(cands.map((c) => c.text));
    }
  });

  it('familyOf maps both ops (and their statement forms) to the introspect family', () => {
    expect(familyOf('attribute_predicate_guard')).toBe('introspect');
    expect(familyOf('attribute_predicate_guard_before')).toBe('introspect');
    expect(familyOf('mro_method_alias')).toBe('introspect');
    expect(familyOf('mro_method_alias_after_dedent')).toBe('introspect');
  });
});

describe('attribute_predicate_guard', () => {
  const file = sourceFromText('t.py', FN);
  const introspected = names({
    operands: [
      operand({ expr: 'item.exp', typeName: 'Unit', classes: ['Unit', 'Atom'], predicates: ['is_whole', 'is_real', 'is_zero'], falsyPredicates: ['is_real'], frame: { path: 't.py', line: 5, fn: 'transform', code: 'if (item.exp < 0) == True:' }, raisingReceiver: true }),
      operand({ expr: 'item', typeName: 'Part', classes: ['Part'], predicates: ['is_leaf'], falsyPredicates: ['is_leaf'], frame: { path: 't.py', line: 5, fn: 'transform', code: 'if (item.exp < 0) == True:' } }),
      operand({ expr: 'ghost.value', typeName: 'X', classes: ['X'], predicates: ['is_x'], falsyPredicates: ['is_x'], frame: null }),
    ],
    classes: ['Unit', 'Atom', 'Part'],
    predicates: ['is_real', 'is_whole', 'is_zero', 'is_leaf', 'is_x'],
  });

  it('at the gap before the raising line: falsy predicate on the receiver first, positive form for truthy ones, sibling returns as bodies, unknown roots skipped', () => {
    const cands = source.enumerate(insertSite(file, 5, 8), options({ introspected })).filter((c) => familyOf(c.op) === 'introspect');
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.length).toBeLessThanOrEqual(INTROSPECT_GUARD_DRAFTS_MAX);
    expect(norm(cands[0]!.text)).toBe(norm('if not item.exp.is_real:\n    return rv'));
    const texts = cands.map((c) => norm(c.text));
    expect(texts).toContain(norm('if item.exp.is_whole:\n    return rv'));
    expect(texts).toContain(norm('if not item.is_leaf:\n    return rv'));
    expect(texts).toContain(norm('if not item.exp.is_real:\n    continue'));
    expect(texts.some((t) => t.includes('ghost'))).toBe(false);
    // the receiver's falsy predicate outranks the other operand's
    expect(texts.indexOf(norm('if not item.exp.is_real:\n    return rv'))).toBeLessThan(texts.indexOf(norm('if not item.is_leaf:\n    return rv')));
    expect(compileFailures(cands.slice(0, 20).map((c) => ({ id: c.id, src: applyCandidate(c) })))).toEqual([]);
  });

  it('at the raising line itself the guard goes before it (statementDrafts `_before`), and outside a function nothing is emitted', () => {
    const cands = source.enumerate(replaceSite(file, 5), options({ introspected })).filter((c) => familyOf(c.op) === 'introspect');
    const hit = cands.find((c) => norm(c.text) === norm('if not item.exp.is_real:\n    return rv\nif (item.exp < 0) == True:'));
    expect(hit).toBeDefined();
    expect(hit!.op).toBe('attribute_predicate_guard_before');
    const moduleFile = sourceFromText('m.py', 'x = compute(rv)\nprint(x)\n');
    expect(source.enumerate(replaceSite(moduleFile, 1), options({ introspected })).filter((c) => familyOf(c.op) === 'introspect')).toEqual([]);
  });
});

describe('mro_method_alias', () => {
  const CLS = ['class Printer(Base):', '    def _print_Foo(self, e):', '        return "foo"', '', '    def _print_Bar(self, e):', '        return "bar"', '', '    def helper(self):', '        return 1', '', 'def free():', '    return 2', ''].join('\n');
  const file = sourceFromText('p.py', CLS);
  const introspected = names({ operands: [operand({ expr: 'expr', classes: ['Baz', 'Qux', 'Foo'] })], classes: ['Baz', 'Qux', 'Foo'] });

  it('at a class-body gap: <prefix><Class> = <nearest method> first, classes already handled skipped, nothing at a def gap', () => {
    const cands = source.enumerate(insertSite(file, 7, 4), options({ introspected })).filter((c) => familyOf(c.op) === 'introspect');
    expect(cands.map((c) => norm(c.text))).toEqual(['_print_Baz = _print_Bar', '_print_Qux = _print_Bar', '_print_Baz = _print_Foo', '_print_Qux = _print_Foo']);
    expect(cands.every((c) => c.op === 'mro_method_alias')).toBe(true);
    expect(compileFailures(cands.map((c) => ({ id: c.id, src: applyCandidate(c) })))).toEqual([]);
    // a gap inside a method body (indent 8) is not the class body
    expect(source.enumerate(insertSite(file, 6, 8), options({ introspected })).filter((c) => familyOf(c.op) === 'introspect')).toEqual([]);
    // a class without a dispatch prefix offers nothing
    const plain = sourceFromText('q.py', 'class Q:\n    def a(self):\n        return 1\n\n    def b(self):\n        return 2\n');
    expect(source.enumerate(insertSite(plain, 4, 4), options({ introspected })).filter((c) => familyOf(c.op) === 'introspect')).toEqual([]);
  });

  it('at the last line of a method: appended at the class indent (after_dedent); not at an inner line', () => {
    const cands = source.enumerate(replaceSite(file, 6), options({ introspected })).filter((c) => familyOf(c.op) === 'introspect');
    expect(cands.length).toBeGreaterThan(0);
    expect(cands[0]!.op).toBe('mro_method_alias_after_dedent');
    expect(cands[0]!.text).toBe('        return "bar"\n    _print_Baz = _print_Bar');
    expect(compileFailures(cands.map((c) => ({ id: c.id, src: applyCandidate(c) })))).toEqual([]);
    expect(source.enumerate(replaceSite(file, 2), options({ introspected })).filter((c) => c.op.startsWith('mro_method_alias'))).toEqual([]);
  });

  it('caps the combinations at INTROSPECT_ALIAS_DRAFTS_MAX', () => {
    const many = names({ classes: Array.from({ length: 300 }, (_, i) => `Cls${i}`) });
    const cands = source.enumerate(insertSite(file, 7, 4), options({ introspected: many, cap: 1000 })).filter((c) => familyOf(c.op) === 'introspect');
    expect(cands).toHaveLength(INTROSPECT_ALIAS_DRAFTS_MAX);
  });
});

describe('no benchmark gold in the productions', () => {
  const corpus = benchmarkCorpus();
  /** the gold FIX lines only (SWE-bench added lines, ladder gold-only lines, QuixBugs fixed lines and fragments): whole benchmark programs hold generic Python (`return False`, `except Exception:`) that any module legitimately contains */
  const goldFixes = new Map([...corpus].filter(([, from]) => from.startsWith('swebench/') || from.startsWith('ladder/') || from.includes('.fixedLine') || from.includes('.fixedFragment')));

  it('the examples quote nothing of the whole benchmark corpus (the Jev-wording guard)', () => {
    expect(corpus.size).toBeGreaterThan(300);
    expect(leaks(INTROSPECT_EXAMPLES.map((e, i) => ({ origin: `INTROSPECT_EXAMPLES[${i}]`, text: e.replace(/\s+/g, ' ').trim() })), corpus)).toEqual([]);
  });

  it('the module texts of the new sources quote no gold fix line', () => {
    const files = ['src/synth/templates/introspect.ts', 'src/synth/introspect/index.ts', 'src/synth/introspect/script.ts', 'src/synth/introspect/prefixes.ts', 'src/synth/introspect/types.ts', 'src/synth/introspect/facts.ts', 'src/synth/history/harvest.ts', 'src/synth/history/source.ts', 'src/synth/history/types.ts'];
    const texts = files.flatMap((f) => readFileSync(join(REPO, f), 'utf8').split('\n').map((line, i) => ({ origin: `${f}:${i + 1}`, text: line.replace(/\s+/g, ' ').trim() })));
    expect(goldFixes.size).toBeGreaterThan(40);
    expect(leaks(texts, goldFixes)).toEqual([]);
  });
});
