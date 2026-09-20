/**
 * Reviewer regression tests for sites the QuixBugs / ladder suites never reach: multi-line
 * statements (a gap inside `f(` ... `)`, the first, a middle and the last physical line of a
 * bracketed call), a def nested in a loop (`continue` there is a SyntaxError), predicates the
 * condition already contains, import slots eaten by unresolvable names, and a `currentLine`
 * handed over without its indentation. Every emitted candidate must still compile under CPython.
 */
import { describe, expect, it } from 'vitest';
import { balancedAs, continuesStatement, createTemplateSource, enumerateTemplates } from '../../../../src/synth/templates/index.js';
import type { Candidate } from '../../../../src/synth/types.js';
import { applyCandidate, compileFailures, insertSite, options, replaceSite, sourceFromText } from './helpers.js';

const source = createTemplateSource();

function expectCompiles(tag: string, cands: readonly Candidate[]): void {
  const failures = compileFailures(cands.map((c) => ({ id: `${tag}:${c.op}:${JSON.stringify(c.text)}`, src: applyCandidate(c) })));
  expect(failures, failures.map((f) => `${f.id}: ${f.error}`).join('\n')).toEqual([]);
}

const MULTILINE = 'def f(items, key):\n    out = []\n    for i in range(len(items)):\n        out.append(\n            transform(items[i],\n                      key)\n        )\n    return out\n';

describe('multi-line statements', () => {
  const file = sourceFromText('m.py', MULTILINE);

  it('a gap inside a bracketed statement takes no statement at all', () => {
    expect(continuesStatement(file.mod, 5)).toBe(true);
    expect(continuesStatement(file.mod, 4)).toBe(false);
    expect(source.enumerate(insertSite(file, 5, 12), options())).toEqual([]);
    expect(source.enumerate(insertSite(file, 7, 8), options())).toEqual([]);
    // gaps between statements are still served
    expect(source.enumerate(insertSite(file, 4, 8), options()).length).toBeGreaterThan(0);
  });

  it('the first line of a multi-line call gets guards before it and in-place substitutions, never a statement appended after it', () => {
    const cands = source.enumerate(replaceSite(file, 4), options());
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.some((c) => c.text === '        out.extend(' && c.op === 'method_subst')).toBe(true);
    expect(cands.some((c) => c.op.endsWith('_before'))).toBe(true);
    expect(cands.filter((c) => c.op.endsWith('_after') || c.op.endsWith('_after_dedent'))).toEqual([]);
    expectCompiles('first', cands);
  });

  it('a continuation line only takes in-place edits that close brackets the way it did', () => {
    const cands = source.enumerate(replaceSite(file, 5), options());
    expect(cands.every((c) => !/_(before|after|after_dedent)$/.test(c.op))).toBe(true);
    expect(cands.every((c) => balancedAs('            transform(items[i],', c.text))).toBe(true);
    expectCompiles('middle', cands);
  });

  it('the last line of a multi-line call only takes statements appended after it, aligned with the statement', () => {
    const cands = source.enumerate(replaceSite(file, 7), options());
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.every((c) => /_(after|after_dedent)$/.test(c.op))).toBe(true);
    expect(cands.find((c) => c.op === 'insert_return_after')?.text).toBe('        )\n        return i');
    expectCompiles('last', cands);
  });

  it('balancedAs compares bracket closure with the original line', () => {
    expect(balancedAs('out.append(', 'out.extend(')).toBe(true);
    expect(balancedAs('out.append(', 'out.extend(x)')).toBe(false);
    expect(balancedAs('x = 1', 'x = max(0, 1)')).toBe(true);
    expect(balancedAs('x = 1', 'x = max(0, 1')).toBe(false);
    expect(balancedAs('x = 1', 'x = "unterminated')).toBe(false);
    expect(balancedAs('    key)', '    key))')).toBe(false);
  });
});

describe('loop and scope boundaries', () => {
  it('never offers continue or break inside a def nested in a loop', () => {
    const file = sourceFromText('e.py', 'def outer(xs):\n    for x in xs:\n        def inner(y):\n            z = y\n            return z\n        print(inner(x))\n');
    const cands = source.enumerate(insertSite(file, 4, 12), options());
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.filter((c) => /\b(continue|break)\b/.test(c.text))).toEqual([]);
    expectCompiles('nested', cands);
    // in the loop body itself they are offered
    const inLoop = source.enumerate(insertSite(file, 6, 8), options());
    expect(inLoop.some((c) => c.text.includes('continue'))).toBe(true);
  });
});

describe('condition predicates', () => {
  it('skips a predicate only when the condition already states it as whole tokens', () => {
    const file = sourceFromText('f.py', 'def f(xs, s):\n    i = 0\n    if xs[i] > 0:\n        return s\n    return None\n');
    const cands = enumerateTemplates(replaceSite(file, 3), options({ cap: 10000 }), ['condition']);
    const texts = cands.map((c) => c.text.trim());
    // `s` is a letter of `xs` and `i` a subscript of it: neither is "already in" the condition
    expect(texts).toContain('if xs[i] > 0 or s:');
    expect(texts).toContain('if xs[i] > 0 and i:');
    expect(texts).toContain('if xs[i] > 0 or not s:');
    const guard = sourceFromText('g.py', 'def g(x, y):\n    if x is None:\n        return y\n    return x\n');
    const dup = enumerateTemplates(replaceSite(guard, 2), options({ cap: 10000 }), ['condition']).map((c) => c.text.trim());
    expect(dup.filter((t) => t.includes('x is None or x is None') || t.includes('x is None and x is None'))).toEqual([]);
    expect(dup).toContain('if x is None or y is None:');
  });
});

describe('imports', () => {
  it('unresolvable unbound names do not crowd out the one an import fixes', () => {
    const src = 'import os\n\n\ndef g():\n    return aaa + bbb + ccc + ddd + eee + fff + ggg + hhh + iii\n\n\ndef f(xs):\n    counts = Counter(xs)\n    return counts\n';
    const file = sourceFromText('d.py', src);
    const cands = source.enumerate(replaceSite(file, 9), options());
    const top = cands.find((c) => c.op === 'import_insert_top');
    expect(top?.extraEdits).toEqual([{ path: 'd.py', line: 2, kind: 'insert', text: 'from collections import Counter' }]);
    expect(cands.filter((c) => c.op.startsWith('import_')).every((c) => (c.extraEdits?.[0]?.text ?? c.text).includes('Counter'))).toBe(true);
    expectCompiles('imports', cands);
  });

  it('does not prepend a local import to a continuation line', () => {
    const file = sourceFromText('m.py', 'def f(xs):\n    return sorted(\n        Counter(xs),\n    )\n');
    const cands = source.enumerate(replaceSite(file, 3), options());
    expect(cands.filter((c) => c.op === 'import_insert_local')).toEqual([]);
    expect(cands.some((c) => c.op === 'import_insert_top')).toBe(true);
    expectCompiles('local-import', cands);
  });
});

describe('site shapes', () => {
  it('renders every candidate at the site indent even when currentLine arrives without its indentation', () => {
    const file = sourceFromText('h.py', 'def f(xs):\n    total = 0\n    for x in xs:\n        total += x\n    return total\n');
    const site = replaceSite(file, 4);
    const trimmed = { ...site, currentLine: site.currentLine.trim(), indent: '        ' };
    const cands = source.enumerate(trimmed, options());
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.filter((c) => !c.text.startsWith('        '))).toEqual([]);
  });

  it('a replace site inside a docstring and an insert site into it yield nothing', () => {
    const file = sourceFromText('i.py', 'def f(x):\n    """It\'s a doc\n    with "quotes" and (unbalanced\n    """\n    y = x + 1\n    return y\n');
    expect(source.enumerate(replaceSite(file, 3), options())).toEqual([]);
    expect(source.enumerate(insertSite(file, 3, 4), options())).toEqual([]);
    expectCompiles('after-docstring', source.enumerate(replaceSite(file, 5), options()));
  });
});
