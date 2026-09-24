import { describe, expect, it } from 'vitest';
import { OPERATOR_NAMES, SECOND_ORDER_THRESHOLD, createMutationSource, enumerateMutations, lineToks, looksSyntactic, operatorsFor, orderMutants, tokenKey } from '../../../../../src/jev-modes/synth/mutate/index.js';
import type { Mutant } from '../../../../../src/jev-modes/synth/mutate/index.js';
import { options, quixbugsIndex, quixbugsSite, quixbugsTestLiterals, siteFor } from './helpers.js';

const key = (line: string): string => tokenKey(lineToks(line));

describe('createMutationSource on QuixBugs (bench/data/quixbugs, 40 programs)', () => {
  const source = createMutationSource();
  const records = quixbugsIndex();
  const results = records.map((r) => {
    const site = quixbugsSite(r);
    const cands = source.enumerate(site, options({ testLiterals: quixbugsTestLiterals(r) }));
    const target = key(r.fixedLine);
    const hit = cands.find((c) => key(c.text) === target);
    return { r, site, cands, hit };
  });

  it('has the source name of the contract', () => {
    expect(source.name).toBe('mutation');
  });

  // Coverage measured 2026-09-20 with this operator table: 40/40 (the measured library in
  // experiments/results/probe-selection.md reached 38/40 first-order; `boundary_shift` makes
  // mergesort `== 0` -> `<= 1` first-order and the stem-guided `drop_index` makes shortest_paths
  // `weight_by_edge[u, v]` -> `weight_by_node[v]` first-order; the 4 insertions come from
  // `statement_template` over in-scope names). Misses: none. The bar stays at 36 so that
  // operator-table tuning cannot silently regress below the brief.
  it('generates the gold fixed line as a first-order candidate for at least 36/40 programs', () => {
    const misses = results.filter((x) => x.hit === undefined).map((x) => x.r.name);
    expect(misses).toEqual([]);
    expect(results.length - misses.length).toBeGreaterThanOrEqual(36);
  });

  it('stays under 400 candidates per line and respects the cap', () => {
    for (const { cands } of results) expect(cands.length).toBeLessThan(400);
    const r = records.find((x) => x.name === 'topological_ordering')!;
    expect(enumerateMutations(quixbugsSite(r), options({ cap: 25 })).length).toBe(25);
    expect(enumerateMutations(quixbugsSite(r), options({ cap: 0 })).length).toBe(0);
  });

  it('never duplicates a candidate text or token sequence, and never returns the current line', () => {
    for (const { site, cands } of results) {
      const texts = cands.map((c) => c.text);
      expect(new Set(texts).size).toBe(texts.length);
      const keys = cands.map((c) => key(c.text));
      expect(new Set(keys).size).toBe(keys.length);
      if (site.kind === 'replace') for (const c of cands) expect(key(c.text)).not.toBe(key(site.currentLine));
      const ids = cands.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('keeps the site indent, source, op, prior and site reference on every candidate', () => {
    for (const { site, cands } of results) {
      for (const c of cands) {
        expect(c.text.startsWith(site.indent)).toBe(true);
        expect(c.text.slice(site.indent.length)).toBe(c.text.slice(site.indent.length).trim());
        expect(c.source).toBe('mutation');
        expect(c.op.length).toBeGreaterThan(0);
        expect(c.prior).toBeGreaterThan(0);
        expect(c.site).toBe(site);
        expect(c.id.startsWith(`mutation:${c.op}:`)).toBe(true);
      }
    }
  });

  it('is deterministic: a second enumeration gives identical ids, texts and order', () => {
    for (const { r, cands } of results) {
      const again = source.enumerate(quixbugsSite(r), options({ testLiterals: quixbugsTestLiterals(r) }));
      expect(again.map((c) => [c.id, c.text, c.op])).toEqual(cands.map((c) => [c.id, c.text, c.op]));
    }
  });

  it('puts the relational, off-by-one and argument-swap fixes near the front', () => {
    const rank = (name: string): number => {
      const x = results.find((y) => y.r.name === name)!;
      return x.cands.indexOf(x.hit!);
    };
    for (const name of ['find_first_in_sorted', 'knapsack', 'quicksort', 'gcd', 'rpn_eval', 'find_in_sorted', 'pascal', 'lcs_length']) expect(rank(name)).toBeLessThan(10);
  });

  it('keeps every candidate bracket-compatible with the line it replaces (continuation lines included)', () => {
    for (const { site, cands } of results) {
      if (site.kind !== 'replace') continue;
      const base = lineToks(site.currentLine);
      for (const c of cands) expect(looksSyntactic(lineToks(c.text), base)).toBe(true);
    }
  });
});

describe('enumerateMutations edge cases', () => {
  const src = 'def f(xs, k):\n    total = 0\n    for x in xs:\n        total += x\n    return total\n';
  it('returns nothing for a blank or comment-only replace line', () => {
    const blank = siteFor('def f():\n\n    return 1\n', 2);
    expect(enumerateMutations(blank, options())).toEqual([]);
    const comment = siteFor('def f():\n    # todo\n    return 1\n', 2);
    expect(enumerateMutations(comment, options())).toEqual([]);
  });
  it('adds second-order compositions only when the first-order set is small', () => {
    const small = enumerateMutations(siteFor('def f():\n    return []\n', 2), options());
    const first = small.filter((c) => !c.op.includes('+'));
    expect(first.length).toBeLessThan(SECOND_ORDER_THRESHOLD);
    expect(small.some((c) => c.op.includes('+'))).toBe(true);
    for (const c of small.filter((x) => x.op.includes('+'))) expect(c.prior).toBeLessThan(0.5);
    const big = enumerateMutations(siteFor(src, 4), options());
    expect(big.some((c) => c.op.includes('+'))).toBe(false);
  });
  it('uses test literals and task identifiers from the options', () => {
    const site = siteFor(src, 2);
    const cands = enumerateMutations(site, options({ testLiterals: ['42', "'abc'"], taskIdentifiers: ['k'] }));
    expect(cands.map((c) => c.text)).toContain('    total = 42');
    expect(cands.find((c) => c.text === '    total = k')?.op).toBe('constant_substitution');
    expect(cands.find((c) => c.text === '    k = 0')?.op).toBe('identifier_substitution');
  });
  it('insert sites get statement templates over in-scope names at the given indent', () => {
    const site = siteFor(src, 5, 'insert', '    ');
    const cands = enumerateMutations(site, options());
    expect(cands.every((c) => c.op === 'statement_template')).toBe(true);
    expect(cands.map((c) => c.text)).toContain('    total += k');
    expect(cands.map((c) => c.text)).toContain('    xs.append(x)');
  });
});

describe('looksSyntactic', () => {
  const ok = (cand: string, base = cand): boolean => looksSyntactic(lineToks(cand), lineToks(base));
  it('accepts well-formed lines and continuation lines with the same bracket signature', () => {
    expect(ok('return gcd(b, a % b)')).toBe(true);
    expect(ok('weight_by_node[v] = min(', 'weight_by_edge[u, v] = min(')).toBe(true);
    expect(ok('x = -1')).toBe(true);
    expect(ok("s = 'a' 'b'")).toBe(true);
  });
  it('rejects adjacent operands, adjacent operators, empty subscripts, dangling keywords and bracket changes', () => {
    expect(ok('return a b', 'return a')).toBe(false);
    expect(ok('x = = 1', 'x = 1')).toBe(false);
    expect(ok('x = a[]', 'x = a[0]')).toBe(false);
    expect(ok('if not :', 'if x:')).toBe(false);
    expect(ok('if x', 'if x:')).toBe(false);
    expect(ok('x = f(a', 'x = f(a)')).toBe(false);
    expect(ok('x = f(a]', 'x = f(a]')).toBe(false);
    expect(ok('x = a +', 'x = a')).toBe(false);
    expect(ok('x = a.', 'x = a')).toBe(false);
    expect(ok('', 'x')).toBe(false);
  });
});

describe('orderMutants', () => {
  const m = (op: string, prior: number, text: string): Mutant => ({ toks: lineToks(text), op, prior });
  it('round-robins across operators with high-prior operators emitting more per round, table order breaking ties', () => {
    const out = orderMutants([m('return_tweak', 0.5, 'r1'), m('return_tweak', 0.5, 'r2'), m('relational_swap', 0.9, 'a1'), m('relational_swap', 0.9, 'a2'), m('relational_swap', 0.9, 'a3'), m('relational_swap', 0.9, 'a4'), m('relational_swap', 0.9, 'a5'), m('index_flip', 0.8, 'i1')]);
    expect(out.map((x) => x.toks[0]!.text)).toEqual(['a1', 'a2', 'a3', 'a4', 'i1', 'r1', 'r2', 'a5']);
  });
  it('is stable for equal priors', () => {
    const out = orderMutants([m('b_op', 0.5, 'b'), m('a_op', 0.5, 'a')]);
    expect(out.map((x) => x.op)).toEqual(['a_op', 'b_op']);
  });
});

describe('collapse_collection_to_element is enumerated at statement-level sites and in WIDENED only', () => {
  const src = 'class F:\n    def __hash__(self):\n        return hash((\n            self.creation_counter,\n            self.model if x else None,\n        ))\n';
  const physical = siteFor(src, 3);
  const statement = { ...physical, currentLine: '        return hash((self.creation_counter, self.model if x else None))', endLine: 6 };

  it('operatorsFor drops the operator at a physical line in SEEDS and keeps the full table otherwise', () => {
    expect(operatorsFor(physical, {})).toEqual(OPERATOR_NAMES.filter((o) => o !== 'collapse_collection_to_element'));
    expect(operatorsFor(physical, { phase: 'SEEDS' })).not.toContain('collapse_collection_to_element');
    expect(operatorsFor(physical, { phase: 'WIDENED' })).toEqual(OPERATOR_NAMES);
    expect(operatorsFor(statement, {})).toEqual(OPERATOR_NAMES);
  });

  it('the joined statement yields `return hash(self.creation_counter)`; the physical first line cannot (its brackets stay open)', () => {
    const seeds = enumerateMutations(physical, options());
    expect(seeds.some((c) => c.op === 'collapse_collection_to_element')).toBe(false);
    const cands = enumerateMutations(statement, options());
    const hit = cands.find((c) => c.text.trim() === 'return hash(self.creation_counter)');
    expect(hit).toBeDefined();
    expect(hit!.op).toBe('collapse_collection_to_element');
    expect(hit!.site.endLine).toBe(6);
    // every candidate at the statement site is one balanced line replacing the whole span
    for (const c of cands) expect((c.text.match(/\(/g) ?? []).length).toBe((c.text.match(/\)/g) ?? []).length);
    // the WIDENED hint alone also enumerates the operator at a physical line
    const line = siteFor('def f(a, b):\n    return hash((a, b))\n', 2);
    const w = enumerateMutations(line, { ...options(), phase: 'WIDENED' });
    expect(w.some((c) => c.op === 'collapse_collection_to_element' && c.text.trim() === 'return hash(a)')).toBe(true);
    const s = enumerateMutations(line, options());
    expect(s.some((c) => c.op === 'collapse_collection_to_element' || c.text.trim() === 'return hash(a)')).toBe(false);
  });
});
