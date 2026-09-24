/**
 * The two productions of swebench-reach-oracle-9.md capabilities 5 and 6: a builtin callee
 * substituted by a standard-library sibling with the import carried as an extra edit
 * (templates/stdlib.ts), and depth-2 wraps composed from a whitelist in the WIDENED phase only
 * (templates/wrap2.ts); plus the template source at a statement-level site (Site.endLine).
 */
import { describe, expect, it } from 'vitest';
import { statementSiteAt } from '../../../../../src/jev-modes/synth/localize/sites.js';
import { DEPTH2_WRAPS, DEPTH2_WRAP_LIMIT, STDLIB_SIBLINGS, createTemplateSource, enumerateTemplates } from '../../../../../src/jev-modes/synth/templates/index.js';
import type { Candidate, EnumerateOptions } from '../../../../../src/jev-modes/synth/types.js';
import { applyCandidate as applySpan } from '../../../../../src/jev-modes/synth/verify/apply.js';
import { applyCandidate as applyToText, compileFailures, norm, options, replaceSite, sourceFromText } from './helpers.js';

const source = createTemplateSource();

const POINT = [
  'from __future__ import division',
  '',
  'from sympy.core import S',
  'from .entity import GeometryEntity',
  '',
  '',
  'class Point(GeometryEntity):',
  '    def distance(self, p):',
  '        return sqrt(sum([(a - b)**2 for a, b in zip(',
  '            self.args, p.args if isinstance(p, Point) else p)]))',
  '',
  '    def total(self, xs):',
  '        return sum(xs)',
  '',
  '    def table(self):',
  '        d = dict()',
  '        return round(self.x, 2)',
  '',
].join('\n');

function ops(cands: readonly Candidate[]): Set<string> {
  return new Set(cands.map((c) => c.op));
}

describe('stdlib-sibling callee substitution (templates/stdlib.ts)', () => {
  const file = sourceFromText('pkg/point.py', POINT);

  it('substitutes `zip` by `zip_longest`, with and without `fillvalue=0`, carrying the itertools import after the last import', () => {
    const site = statementSiteAt(file, 9, { notes: [] })!;
    const cands = source.enumerate(site, options());
    const kw = cands.find((c) => norm(c.text) === norm('return sqrt(sum([(a - b)**2 for a, b in zip_longest(self.args, p.args if isinstance(p, Point) else p, fillvalue=0)]))'));
    expect(kw).toBeDefined();
    expect(kw!.op).toBe('callee_stdlib_subst_kw');
    expect(kw!.extraEdits).toEqual([{ path: 'pkg/point.py', line: 5, kind: 'insert', text: 'from itertools import zip_longest' }]);
    const plain = cands.find((c) => c.op === 'callee_stdlib_subst' && c.text.includes('zip_longest('));
    expect(plain).toBeDefined();
    expect(plain!.extraEdits).toEqual(kw!.extraEdits);
    // `product` is the other zip sibling; both compile once applied (the span is replaced, the import inserted)
    expect(cands.some((c) => c.op === 'callee_stdlib_subst' && c.text.includes('product('))).toBe(true);
    const applied = cands.filter((c) => c.op.startsWith('callee_stdlib')).map((c) => ({ id: c.id, src: applySpan(c).files[0]!.after }));
    expect(compileFailures(applied)).toEqual([]);
  });

  it('a bound sibling needs no import; a rebound builtin is left alone; arity-restricted siblings only fit their arity', () => {
    const bound = sourceFromText('m.py', 'from itertools import zip_longest\n\ndef f(a, b):\n    return list(zip(a, b))\n');
    const cands = source.enumerate(replaceSite(bound, 4), options());
    const zl = cands.find((c) => c.op === 'callee_stdlib_subst' && c.text.includes('zip_longest('));
    expect(zl).toBeDefined();
    expect(zl!.extraEdits).toBeUndefined();
    // `list(` -> `deque(` carries `from collections import deque`
    expect(cands.find((c) => c.text.includes('deque('))?.extraEdits?.[0]?.text).toBe('from collections import deque');
    const rebound = sourceFromText('m.py', 'def zip(a, b):\n    return a\n\ndef f(a, b):\n    return zip(a, b)\n');
    expect(source.enumerate(replaceSite(rebound, 5), options()).some((c) => c.op.startsWith('callee_stdlib'))).toBe(false);
    // `round(x, 2)` has two positional arguments: no `floor`; `dict()` takes the factory drafts
    const table = source.enumerate(replaceSite(file, 17), options());
    expect(table.some((c) => c.text.includes('floor('))).toBe(false);
    const d = source.enumerate(replaceSite(file, 16), options());
    expect(d.some((c) => norm(c.text) === 'd = defaultdict(list)' && c.extraEdits?.[0]?.text === 'from collections import defaultdict')).toBe(true);
    expect(d.some((c) => norm(c.text) === 'd = OrderedDict()')).toBe(true);
    for (const [callee, sibs] of Object.entries(STDLIB_SIBLINGS)) for (const s of sibs) expect(s.name, `${callee} -> ${s.name}`).not.toBe(callee);
  });
});

describe('depth-2 wraps (templates/wrap2.ts), WIDENED only', () => {
  const perm = sourceFromText('perm.py', ['def minimal_blocks(rep_blocks, rep):', '    to_remove = []', '    for i, r in enumerate(rep_blocks):', '        if len(r) > len(rep):', '            del rep_blocks[i]', '    return to_remove', ''].join('\n'));
  const site = replaceSite(perm, 3);
  const seeds = options({ cap: 1000 });
  const widened: EnumerateOptions = { ...seeds, phase: 'WIDENED' };

  it('SEEDS enumerates no wrap2 / for-wrap candidate, with or without an explicit SEEDS phase', () => {
    const a = source.enumerate(site, seeds);
    const b = source.enumerate(site, { ...seeds, phase: 'SEEDS' });
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect([...ops(a)].some((o) => o.startsWith('wrap2_') || o.startsWith('wrap_for_'))).toBe(false);
  });

  it('WIDENED adds `reversed(list(enumerate(rep_blocks)))` at the for header, at most DEPTH2_WRAP_LIMIT pairs, nothing else new', () => {
    const a = source.enumerate(site, seeds);
    const w = source.enumerate(site, widened);
    const newOnes = w.filter((c) => !a.some((x) => x.text === c.text));
    expect(newOnes.length).toBeGreaterThan(0);
    expect(newOnes.every((c) => c.op.startsWith('wrap2_') || c.op.startsWith('wrap_for_'))).toBe(true);
    expect(newOnes.filter((c) => c.op.startsWith('wrap2_')).length).toBeLessThanOrEqual(DEPTH2_WRAP_LIMIT);
    const gold = w.find((c) => norm(c.text) === 'for i, r in reversed(list(enumerate(rep_blocks))):');
    expect(gold).toBeDefined();
    expect(gold!.op).toBe('wrap2_reversed_list');
    // the first pair sits at the wrap family's top so it lands under the 254 cap where it matters
    expect(gold!.prior).toBeGreaterThan(0.5);
    // `enumerate(enumerate(...))`: the inner wrap already present is never repeated
    expect(w.some((c) => c.op === 'wrap2_reversed_enumerate' || c.op === 'wrap_for_enumerate')).toBe(false);
    for (const wname of DEPTH2_WRAPS) if (wname !== 'enumerate') expect(w.some((c) => c.op === `wrap_for_${wname}`)).toBe(true);
    expect(compileFailures(newOnes.map((c) => ({ id: c.id, src: applyToText(c) })))).toEqual([]);
  });

  it('assign and return shapes get the pairs too; a bare literal does not', () => {
    const m = sourceFromText('m.py', 'def f(xs):\n    ys = xs\n    return 0\n');
    const assign = enumerateTemplates(replaceSite(m, 2), { ...options({ cap: 1000 }), phase: 'WIDENED' }, ['wrap']);
    expect(assign.some((c) => norm(c.text) === 'ys = sorted(set(xs))')).toBe(true);
    expect(assign.filter((c) => c.op.startsWith('wrap2_')).length).toBeLessThanOrEqual(DEPTH2_WRAP_LIMIT);
    expect(enumerateTemplates(replaceSite(m, 3), { ...options({ cap: 1000 }), phase: 'WIDENED' }, ['wrap']).some((c) => c.op.startsWith('wrap2_'))).toBe(false);
  });
});

describe('templates at a statement-level site', () => {
  const file = sourceFromText('pkg/point.py', POINT);
  const site = statementSiteAt(file, 10, { notes: [] })!;

  it('sees the joined statement, balances candidates against it and offers both prepend and append forms', () => {
    expect(site.line).toBe(9);
    expect(site.endLine).toBe(10);
    const cands = source.enumerate(site, options());
    expect(cands.length).toBeGreaterThan(0);
    // every replacement closes its brackets: the joined statement is balanced, so a candidate must be too
    for (const c of cands) for (const line of c.text.split('\n')) expect((line.match(/\(/g) ?? []).length, line).toBe((line.match(/\)/g) ?? []).length);
    expect(cands.some((c) => c.op.endsWith('_before'))).toBe(true);
    expect(cands.some((c) => c.op.endsWith('_after') || c.op.endsWith('_after_dedent'))).toBe(true);
    // no extra edit may address the continuation line the span replaces
    for (const c of cands) for (const e of c.extraEdits ?? []) expect(e.line === 10 && e.path === site.file.path).toBe(false);
  });
});
