import { describe, expect, it } from 'vitest';
import { argumentOrders, permutationCandidates, permutationsOf, primaryEnd, primaryStart } from '../../../../../src/jev-modes/synth/beam/permute.js';
import { detokenize, toks } from '../../../../../src/jev-modes/synth/beam/tokens.js';
import { enumerateOptions, gcdSite, knapsackSite, siteAt, sourceFile } from './helpers.js';

const lines = (line: string): string[] => permutationsOf(line).map((p) => detokenize(p.toks));

describe('permutations: argument orders', () => {
  it('enumerates every order for ≤ 4 arguments and adjacent swaps beyond, identity excluded', () => {
    expect(argumentOrders(1)).toEqual([]);
    expect(argumentOrders(2)).toEqual([[1, 0]]);
    expect(argumentOrders(3)).toHaveLength(5);
    expect(argumentOrders(4)).toHaveLength(23);
    expect(argumentOrders(5)).toEqual([[1, 0, 2, 3, 4], [0, 2, 1, 3, 4], [0, 1, 3, 2, 4], [0, 1, 2, 4, 3]]);
  });
});

describe('permutations: calls, subscripts, operands', () => {
  it('gcd: swaps the call arguments and the operands of `%`', () => {
    const out = lines('return gcd(a % b, b)');
    expect(out).toContain('return gcd(b, a % b)');
    expect(out).toContain('return gcd(b % a, b)');
    expect(permutationsOf('return gcd(a % b, b)').map((p) => p.op).sort()).toEqual(['argument_permutation', 'operand_swap']);
  });
  it('knapsack: permutes subscript indices and swaps `-` operands', () => {
    const out = lines('memo[i, j] = memo[i - 1, j]');
    expect(out).toContain('memo[j, i] = memo[i - 1, j]');
    expect(out).toContain('memo[i, j] = memo[j, i - 1]');
    expect(out).toContain('memo[i, j] = memo[1 - i, j]');
  });
  it('operands are whole primaries: calls, subscripts, attribute chains, parenthesised groups', () => {
    expect(lines('x = len(a) - b[0].size')).toContain('x = b[0].size - len(a)');
    expect(lines('x = (a + b) / c')).toContain('x = c / (a + b)');
    expect(lines('x = a ** -b')).toContain('x = -b ** a');
    expect(lines('if x in seen:')).toContain('if seen in x:');
    expect(lines('if x not in seen:')).toContain('if seen not in x:');
  });
  it('skips commutative operators, keyword arguments, unpacking, slices and `for … in` clauses', () => {
    expect(lines('x = a + b')).toEqual([]);
    expect(lines('x = a == b')).toEqual([]);
    expect(lines('f(a, b=1)')).toEqual([]);
    expect(lines('f(*args, b)')).toEqual([]);
    expect(lines('x = a[1:2, 3]')).toEqual([]);
    expect(lines('for i in range(n):')).toEqual([]);
    expect(lines('ys = [x for x in xs]')).toEqual([]);
    expect(lines('return [x for x in xs if x in seen]')).toContain('return [x for x in xs if seen in x]');
  });
  it('primaryStart / primaryEnd find operand spans', () => {
    const ts = toks('f(a)[0].b - c.d(e)');
    expect(primaryStart(ts, ts.findIndex((t) => t.text === '-') - 1)).toBe(0);
    expect(primaryEnd(ts, ts.findIndex((t) => t.text === '-') + 1)).toBe(ts.length - 1);
    expect(primaryStart(toks('a +'), 1)).toBeNull();
    expect(primaryEnd(toks('- +'), 0)).toBeNull();
  });
});

describe('permutations: candidates', () => {
  it('are pure, indented, distinct from the current line, stable in id and capped', () => {
    const { site } = gcdSite();
    const a = permutationCandidates(site, 50);
    const b = permutationCandidates(site, 50);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
    expect(a.every((c) => c.text.startsWith('        ') && c.source === 'token_beam' && c.site === site)).toBe(true);
    expect(a.some((c) => c.text === site.currentLine)).toBe(false);
    expect(a.map((c) => c.text.trim())).toContain('return gcd(b, a % b)');
    expect(permutationCandidates(site, 1)).toHaveLength(1);
    expect(permutationCandidates(site, 0)).toEqual([]);
  });
  it('knapsack site yields subscript permutations and operand swaps with distinct ops', () => {
    const { site } = knapsackSite();
    const cs = permutationCandidates(site, 50);
    // `if weight < j:` has one non-commutative comparison
    expect(cs.map((c) => c.text.trim())).toEqual(['if j < weight:']);
    expect(cs[0]!.op).toBe('operand_swap');
    const memoSite = siteAt(site.file, 10);
    const ops = new Set(permutationCandidates(memoSite, 50).map((c) => c.op));
    expect(ops.has('subscript_permutation')).toBe(true);
    expect(ops.has('operand_swap')).toBe(true);
  });
  it('insert sites and lines without reorderable parts yield nothing', () => {
    const { file } = gcdSite();
    expect(permutationCandidates(siteAt(file, 3, 'insert'), 50)).toEqual([]);
    expect(permutationCandidates(siteAt(file, 3), 50)).toEqual([]);
    const f = sourceFile('p.py', 'def f(a, b, c, d, e):\n    return g(a, b, c, d, e)\n');
    expect(permutationCandidates(siteAt(f, 2), 50)).toHaveLength(4);
    expect(enumerateOptions().cap).toBe(200);
  });
});
