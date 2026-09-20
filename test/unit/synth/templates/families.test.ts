/**
 * Unit tests for the template helpers and the families that the QuixBugs / ladder suites do
 * not exercise directly: syntactic filter, unbound-name detection, import placement, identifier
 * substitution, call-site keyword edits for a parameter without a default, argument removal,
 * branch clones, and the enumeration invariants (cap, ordering, ids, no unchanged lines).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyse } from '../../../../src/synth/py/index.js';
import { FAMILY_PRIOR, TEMPLATE_FAMILIES, createTemplateSource, enumerateTemplates, familyOf, importInsertLine, isBalanced, substituteIdentifier, unboundNames } from '../../../../src/synth/templates/index.js';
import { FIXTURES, LADDER, QUIXBUGS, applyCandidate, compileFailures, insertSite, options, replaceSite, sourceFile, sourceFromText } from './helpers.js';

const source = createTemplateSource();

describe('helpers', () => {
  it('isBalanced accepts balanced lines and rejects unbalanced brackets or broken strings', () => {
    expect(isBalanced('x = max(0, a[1:]) + {1: 2}')).toBe(true);
    expect(isBalanced('if x is None:\n    return (a, b)')).toBe(true);
    expect(isBalanced('x = max(0, a[1:]')).toBe(false);
    expect(isBalanced('x = a)')).toBe(false);
    expect(isBalanced('x = "abc')).toBe(false);
  });

  it('unboundNames finds names nothing binds, ignoring attributes, keyword arguments and comprehension variables', () => {
    const mod = analyse(readFileSync(join(LADDER, 'tagcloud/src/tagcloud.py'), 'utf8')).moduleNames;
    expect(mod).toContain('Post');
    const names = unboundNames(analyse(readFileSync(join(LADDER, 'tagcloud/src/tagcloud.py'), 'utf8')));
    expect(names).toEqual(['Counter']);
    const small = analyse('import os\n\ndef f(xs, k=1):\n    ys = [g(x, key=k) for x in xs]\n    return os.path.join(ys, sep)\n');
    expect(unboundNames(small)).toEqual(['g', 'sep']);
  });

  it('importInsertLine goes after the last module import, else after the docstring, else to the top', () => {
    expect(importInsertLine(analyse(readFileSync(join(LADDER, 'tagcloud/src/tagcloud.py'), 'utf8')))).toBe(8);
    expect(importInsertLine(analyse('"""doc"""\n\nx = 1\n'))).toBe(2);
    expect(importInsertLine(analyse('x = 1\n'))).toBe(1);
    expect(importInsertLine(analyse('import os\nimport sys\n\ndef f():\n    import re\n'))).toBe(3);
  });

  it('substituteIdentifier renames whole identifiers only', () => {
    expect(substituteIdentifier('x = x.a + xx + obj.x + "x"', 'x', 'y')).toBe('y = y.a + xx + obj.x + "x"');
    expect(substituteIdentifier('    if size_unit in SIZE:', 'size_unit', 'time_unit')).toBe('    if time_unit in SIZE:');
  });

  it('familyOf maps op names to families and every family has a prior', () => {
    expect(familyOf('guard_none_return_before')).toBe('guard');
    expect(familyOf('insert_append_after_dedent')).toBe('statement');
    expect(familyOf('wrap_max_zero')).toBe('wrap');
    expect(familyOf('cond_or_first')).toBe('condition');
    expect(familyOf('return_condition')).toBe('condition');
    expect(familyOf('add_param_sibling_with_edits')).toBe('signature');
    expect(familyOf('call_add_arg')).toBe('signature');
    expect(familyOf('attr_subst')).toBe('attribute');
    expect(familyOf('import_insert_top')).toBe('import');
    expect(familyOf('branch_clone')).toBe('branch');
    for (const f of TEMPLATE_FAMILIES) expect(FAMILY_PRIOR[f]).toBeGreaterThan(0);
  });
});

describe('signature templates', () => {
  const file = sourceFile('sig.py', join(FIXTURES, 'sig.py'));

  it('adds a free body name as a parameter and passes it as a keyword at every same-file call site', () => {
    const cands = source.enumerate(replaceSite(file, 1), options());
    const hit = cands.find((c) => c.text === 'def helper(a, scale):' && c.op === 'add_param_free_name_with_edits');
    expect(hit).toBeDefined();
    expect(hit!.extraEdits).toEqual([
      { path: 'sig.py', line: 6, kind: 'replace', text: '    return helper(v, scale=scale) * 2' },
      { path: 'sig.py', line: 10, kind: 'replace', text: '    total = helper(v, 2, scale=scale)' },
    ]);
    expect(compileFailures([{ id: 'sig', src: applyCandidate(hit!) }])).toEqual([]);
  });

  it('adds a parameter named by the failing test with a None default, after the existing ones', () => {
    const cands = source.enumerate(replaceSite(file, 1), options({ taskIdentifiers: ['helper', 'offset'] }));
    expect(cands.some((c) => c.text === 'def helper(a, offset=None):' && c.op === 'add_param_from_test')).toBe(true);
  });

  it('removes an argument from a call and adds a nearby name', () => {
    const cands = source.enumerate(replaceSite(file, 10), options());
    expect(cands.some((c) => c.text === '    total = helper(v)' && c.op === 'call_remove_arg')).toBe(true);
    expect(cands.some((c) => c.text === '    total = helper(2)' && c.op === 'call_remove_arg')).toBe(true);
    // a name bound by this very line is not a value the call can take yet
    expect(cands.some((c) => c.text === '    total = helper(v, 2, total)')).toBe(false);
  });
});

describe('branch templates', () => {
  const file = sourceFile('branchy.py', join(FIXTURES, 'branchy.py'));

  it('clones the branch as an elif with one identifier substituted, after the branch, from the header site', () => {
    const cands = source.enumerate(replaceSite(file, 6), options());
    const hit = cands.find((c) => c.op === 'branch_clone_after' && c.extraEdits?.[0]?.text?.includes('elif time_unit in SIZE:'));
    expect(hit).toBeDefined();
    expect(hit!.text).toBe('    if size_unit in SIZE:');
    expect(hit!.extraEdits).toEqual([{ path: 'branchy.py', line: 9, kind: 'insert', text: '    elif time_unit in SIZE:\n        factor = SIZE[time_unit]\n        return value * factor' }]);
    expect(compileFailures([{ id: 'branchy', src: applyCandidate(hit!) }])).toEqual([]);
  });

  it('emits the clone as the inserted block at an insert site right after the branch', () => {
    const cands = source.enumerate(insertSite(file, 9, 4), options());
    const hit = cands.find((c) => c.op === 'branch_clone' && c.text.startsWith('    elif time_unit in SIZE:'));
    expect(hit).toBeDefined();
    expect(compileFailures([{ id: 'branchy', src: applyCandidate(hit!) }])).toEqual([]);
  });
});

describe('enumeration invariants', () => {
  it('respects the cap, never returns the unchanged line, keeps ids unique and priors sorted, and compiles', () => {
    const items: { id: string; src: string }[] = [];
    for (const name of ['lis', 'possible_change', 'reverse_linked_list']) {
      const file = sourceFile(`${name}.py`, join(QUIXBUGS, `${name}.py`));
      for (let line = 1; line <= file.mod.lines.length; line++) {
        const site = replaceSite(file, line);
        if (site.currentLine.trim() === '') continue;
        const cands = source.enumerate(site, options({ cap: 60 }));
        expect(cands.length).toBeLessThanOrEqual(60);
        expect(new Set(cands.map((c) => c.id)).size).toBe(cands.length);
        for (let k = 1; k < cands.length; k++) expect(cands[k - 1]!.prior!).toBeGreaterThanOrEqual(cands[k]!.prior!);
        for (const c of cands) {
          expect(c.text === site.currentLine && c.extraEdits === undefined).toBe(false);
          expect(isBalanced(c.text)).toBe(true);
          items.push({ id: `${name}:${line}:${c.id}`, src: applyCandidate(c) });
        }
      }
    }
    const failures = compileFailures(items);
    expect(failures, failures.map((f) => `${f.id}: ${f.error}`).join('\n')).toHaveLength(0);
  });

  it('a family subset can be enumerated on its own', () => {
    const file = sourceFile('lis.py', join(QUIXBUGS, 'lis.py'));
    const only = enumerateTemplates(replaceSite(file, 14), options(), ['wrap']);
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((c) => c.op.startsWith('wrap_'))).toBe(true);
    expect(only.some((c) => c.text === '            longest = max(longest, length + 1)')).toBe(true);
  });

  it('module-level and insert sites in a tiny module produce sane candidates', () => {
    const file = sourceFromText('tiny.py', 'def f(items, k):\n    out = []\n    for i in range(k):\n        out.append(items[i])\n    return out\n');
    const cands = source.enumerate(insertSite(file, 4, 8), options());
    expect(cands.some((c) => c.text === '        if i >= len(items):\n            break')).toBe(true);
    expect(cands.some((c) => c.text === '        if items is None:\n            continue')).toBe(true);
    const failures = compileFailures(cands.map((c) => ({ id: c.id, src: applyCandidate(c) })));
    expect(failures).toEqual([]);
  });
});

describe('statement insertion: receiver roles from usage', () => {
  it('a name used with `.pop()` is a list unless the code treats it as a set or dict; `.append` on it is enumerated, `.add` is not', () => {
    const file = sourceFromText('drain.py', 'def drain(q, x):\n    top = q.pop()\n    return top\n');
    const texts = source.enumerate(insertSite(file, 3, 4), options()).map((c) => c.text.trim());
    expect(texts).toContain('q.append(x)');
    expect(texts).toContain('q.append(top)');
    expect(texts.some((t) => t.startsWith('q.add('))).toBe(false);
    const asSet = sourceFromText('drain_set.py', 'def drain(q, x):\n    q.add(x)\n    top = q.pop()\n    return top\n');
    const setTexts = source.enumerate(insertSite(asSet, 4, 4), options()).map((c) => c.text.trim());
    expect(setTexts).toContain('q.add(top)');
    expect(setTexts.some((t) => t.startsWith('q.append('))).toBe(false);
  });

  it('shunting_yard: `opstack` is a list by `opstack = []` and `.pop()`; the loop variable outranks collection-typed elements', () => {
    const file = sourceFile('shunting_yard.py', join(QUIXBUGS, 'shunting_yard.py'));
    const stmts = source.enumerate(insertSite(file, 18, 12), options()).filter((c) => c.op === 'insert_append');
    const texts = stmts.map((c) => c.text.trim());
    expect(texts.slice(0, 2).sort()).toEqual(['opstack.append(token)', 'rpntokens.append(token)']);
    expect(texts).toContain('opstack.append(precedence)');
    expect(stmts.find((c) => c.text.trim() === 'opstack.append(token)')!.prior!).toBeGreaterThan(stmts.find((c) => c.text.trim() === 'opstack.append(precedence)')!.prior!);
  });
});
