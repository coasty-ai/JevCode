/**
 * The two introspection-fed template productions (src/jev-modes/synth/templates/introspect.ts): inert
 * without `EnumerateOptions.introspected` (identical candidate sets on QuixBugs sites), the
 * attribute-predicate guard on a synthetic function (subject from the raising line, falsy
 * predicates first, sibling return bodies, `_before` form at a replace site) and its target — the
 * gap before the statement the operand's frame names, at that statement's indent, never the other
 * gaps of the file (jev-only-rungs-1-2.md §21.5 / §24, sympy-17139) — the MRO alias at a class-body
 * gap, at a located gap MARKED as the class-body gap (§24, sympy-15345) and appended after a
 * method's last line, the caps, `familyOf`, and the leakage guard: neither the module texts nor
 * the examples quote a benchmark gold line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyIntrospection } from '../../../../../src/jev-modes/synth/introspect/index.js';
import type { IntrospectOperand, IntrospectedNames } from '../../../../../src/jev-modes/synth/introspect/index.js';
import { INTROSPECT_ALIAS_DRAFTS_MAX, INTROSPECT_EXAMPLES, INTROSPECT_GUARD_DRAFTS_MAX, TEMPLATE_FAMILIES, createTemplateSource, familyOf } from '../../../../../src/jev-modes/synth/templates/index.js';
import { CLASS_BODY_GAP_NOTE, framePathMatches, guardTargetLine, isClassBodyGapSite } from '../../../../../src/jev-modes/synth/templates/introspect.js';
import type { Site } from '../../../../../src/jev-modes/synth/types.js';
import { applyCandidate as applyReal } from '../../../../../src/jev-modes/synth/verify/apply.js';
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
  it('targets the raising statement: at the gap before it the guard is written at that line\'s indent whatever the site\'s; nothing at the gaps inside the raising `if` or elsewhere in the file; only the `_before` form at the line itself', () => {
    const pick = (site: Site): ReturnType<typeof source.enumerate> => source.enumerate(site, options({ introspected })).filter((c) => familyOf(c.op) === 'introspect');
    // the gap inside the body of `if (item.exp < 0) == True:` — dead code for a guard of item.exp — gets nothing from the frame-bearing operands
    expect(pick(insertSite(file, 6, 12))).toEqual([]);
    // a gap before the loop (L2): item is visible there, the frame says L5, so nothing
    expect(pick(insertSite(file, 2, 4))).toEqual([]);
    // a gap at the raising line but at another indent (a colliding slot the introspection site was merged onto): written at the statement's indent (8)
    const off = pick(insertSite(file, 5, 12));
    expect(off.length).toBeGreaterThan(0);
    expect(off.every((c) => c.text.startsWith('        if ') && !c.text.startsWith('         '))).toBe(true);
    expect(norm(off[0]!.text)).toBe(norm('if not item.exp.is_real:\n    return rv'));
    // the production apply inserts the guard verbatim at the statement's indent (the test helper would re-indent to the site's)
    expect(compileFailures(off.slice(0, 6).map((c) => ({ id: c.id, src: applyReal(c).files[0]!.after })))).toEqual([]);
    expect(applyReal(off[0]!).files[0]!.after).toContain('            return rv\n        if not item.exp.is_real:\n            return rv\n        if (item.exp < 0) == True:');
    // at the raising line itself only `_before`: inside the header's body the guard would be dead
    const atLine = pick(replaceSite(file, 5));
    expect(atLine.length).toBeGreaterThan(0);
    expect(atLine.every((c) => c.op === 'attribute_predicate_guard_before')).toBe(true);
    // a continuation line of the raising statement is not the gap before it
    expect(guardTargetLine({ mod: file.mod, site: insertSite(file, 5, 8) }, { path: 't.py', line: 5, fn: 'transform', code: null })).toBe(5);
    expect(guardTargetLine({ mod: file.mod, site: insertSite(file, 5, 8) }, { path: 'pkg/other.py', line: 5, fn: null, code: null })).toBeNull();
    expect(guardTargetLine({ mod: file.mod, site: insertSite(file, 5, 8) }, null)).toBeNull();
  });

  it('falls back to every gap where the root is visible only when the operand has no frame in this file (none, or another file); an absolute frame path still targets', () => {
    const only = (n: IntrospectedNames, site: Site): string[] => source.enumerate(site, options({ introspected: n })).filter((c) => familyOf(c.op) === 'introspect').map((c) => norm(c.text));
    const noFrame = names({ operands: [operand({ expr: 'rv', typeName: 'R', predicates: ['is_ok'], falsyPredicates: ['is_ok'], frame: null })] });
    expect(only(noFrame, insertSite(file, 6, 12))).toContain(norm('if not rv.is_ok:\n    return rv'));
    const otherFile = names({ operands: [operand({ expr: 'rv', typeName: 'R', predicates: ['is_ok'], falsyPredicates: ['is_ok'], frame: { path: 'pkg/other.py', line: 3, fn: 'g', code: null } })] });
    expect(only(otherFile, insertSite(file, 6, 12))).toContain(norm('if not rv.is_ok:\n    return rv'));
    const abs = names({ operands: [operand({ expr: 'rv', typeName: 'R', predicates: ['is_ok'], falsyPredicates: ['is_ok'], frame: { path: '/work/t.py', line: 5, fn: 'transform', code: null } })] });
    expect(only(abs, insertSite(file, 6, 12))).toEqual([]);
    expect([...only(abs, insertSite(file, 5, 8))].sort()).toEqual([norm('if not rv.is_ok:\n    return rv'), norm('if not rv.is_ok:\n    return limit'), norm('if not rv.is_ok:\n    return None'), norm('if not rv.is_ok:\n    continue')].sort());
    expect(framePathMatches('/work/t.py', 't.py')).toBe(true);
    expect(framePathMatches('./t.py', 't.py')).toBe(true);
    expect(framePathMatches('/work/not.py', 't.py')).toBe(false);
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

  it('at a located gap MARKED as the class-body gap (search/sites.ts merged the introspection site onto it) the alias is written at the class indent whatever the gap\'s own indent; unmarked, the same gap is a method-body gap', () => {
    const marked: Site = { ...insertSite(file, 7, 8), evidence: { notes: ['insert after anchor L6', `${CLASS_BODY_GAP_NOTE} Printer after _print_Bar (L5-6)`] } };
    expect(isClassBodyGapSite(marked)).toBe(true);
    const cands = source.enumerate(marked, options({ introspected })).filter((c) => familyOf(c.op) === 'introspect');
    expect(cands.map((c) => c.text)).toEqual(['    _print_Baz = _print_Bar', '    _print_Qux = _print_Bar', '    _print_Baz = _print_Foo', '    _print_Qux = _print_Foo']);
    expect(cands.every((c) => c.op === 'mro_method_alias')).toBe(true);
    expect(compileFailures(cands.map((c) => ({ id: c.id, src: applyReal(c).files[0]!.after })))).toEqual([]);
    expect(applyReal(cands[0]!).files[0]!.after).toContain('        return "bar"\n    _print_Baz = _print_Bar\n');
    expect(source.enumerate(insertSite(file, 7, 8), options({ introspected })).filter((c) => familyOf(c.op) === 'introspect')).toEqual([]);
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
    const files = ['src/jev-modes/synth/templates/introspect.ts', 'src/jev-modes/synth/introspect/index.ts', 'src/jev-modes/synth/introspect/script.ts', 'src/jev-modes/synth/introspect/prefixes.ts', 'src/jev-modes/synth/introspect/types.ts', 'src/jev-modes/synth/introspect/facts.ts', 'src/jev-modes/synth/history/harvest.ts', 'src/jev-modes/synth/history/source.ts', 'src/jev-modes/synth/history/types.ts'];
    const texts = files.flatMap((f) => readFileSync(join(REPO, f), 'utf8').split('\n').map((line, i) => ({ origin: `${f}:${i + 1}`, text: line.replace(/\s+/g, ' ').trim() })));
    expect(goldFixes.size).toBeGreaterThan(40);
    expect(leaks(texts, goldFixes)).toEqual([]);
  });
});
