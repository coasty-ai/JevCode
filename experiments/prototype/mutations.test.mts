/** Operator unit checks: node node_modules/.bin/tsx experiments/prototype/mutations.test.mts */
import assert from 'node:assert/strict';
import { enumerateCandidates, filterSyntactic, tokenize } from './mutations.mts';
import { normLine } from './quixbugs.mts';

function cands(lines: string[], i: number, lits: string[] = ['0', '1']): string[] {
  return enumerateCandidates({ lines, lineIndex: i, testLiterals: lits }, 100_000).map((c) => normLine(c.text));
}
const has = (xs: string[], s: string): boolean => xs.includes(normLine(s));

// tokenizer
assert.deepEqual(tokenize("a[i - 1, j] + 'x+y'").filter((t) => t.t !== 'ws').map((t) => t.s), ['a', '[', 'i', '-', '1', ',', 'j', ']', '+', "'x+y'"]);
assert.deepEqual(tokenize('x //= 2 ** 3 != y').filter((t) => t.t !== 'ws').map((t) => t.s), ['x', '//=', '2', '**', '3', '!=', 'y']);

const prog = ['def f(arr, k):', '    lo = 0', '    hi = len(arr)', '    while lo <= hi:', '        mid = (lo + hi) // 2', '        dp[i - 1, j] = dp[i - 1, j] + 1', "        s = 'a+b'", '        return g(mid, end)', '    return arr[0]'];
let c = cands(prog, 3);
assert.ok(has(c, 'while lo < hi:'), 'relational swap');
assert.ok(c[0]!.startsWith('while lo') && /while lo (<|>|>=|==|!=) hi:/.test(c[0]!), 'relational swaps come first');
assert.ok(!has(c, 'while lo <= hi:'), 'original excluded');
assert.equal(new Set(c).size, c.length, 'deduped');
assert.ok(has(c, 'while lo <= hi or arr is None:'), 'guard template with in-scope identifier');

c = cands(prog, 5);
assert.ok(has(c, 'dp[i - 1, j] = dp[i - 1, j - 1] + 1'), 'off-by-one on a nested index operand');
assert.ok(has(c, 'dp[i - 1, j] = dp[j, i - 1] + 1'), 'swap of index parts');
assert.ok(has(c, 'dp[i - 1, j] = dp[i - 1, j] - 1'), 'arith swap');
assert.ok(has(c, 'dp[i - 1, j] = dp[i - 1, j]'), 'remove + 1 term');

c = cands(prog, 6);
assert.ok(!c.some((l) => l.includes("'a-b'")), 'operators inside strings untouched');

c = cands(prog, 7);
assert.ok(has(c, 'return g(end, mid)'), 'argument swap');
assert.ok(has(c, 'return g(mid + 1, end)'), 'off-by-one on a call argument');
assert.ok(has(c, 'return g(mid, end - k)'), 'argument minus in-scope identifier');
assert.ok(has(c, 'return mid'), 'return other identifier');
assert.ok(has(c, 'return g(end)'), 'drop an argument');

c = cands(prog, 8);
assert.ok(has(c, 'return arr[-1]'), 'index flip');
assert.ok(has(c, 'return arr[k]') || has(c, 'return arr[1]'), 'index constant / identifier substitution');

// indentation preserved and cap respected
const raw = enumerateCandidates({ lines: prog, lineIndex: 4, testLiterals: ['0', '1', '2'] }, 7);
assert.equal(raw.length, 7, 'cap respected');
assert.ok(raw.every((x) => x.text.startsWith('        ') && !x.text.startsWith('         ')), 'indentation preserved');

// syntax filter drops the non-compiling ones and keeps the compiling ones
const ctx = { lines: ['def f(a, b):', '    return a + b'], lineIndex: 1, testLiterals: [] as string[] };
const filtered = filterSyntactic(ctx, [{ text: '    return a - b', op: 't' }, { text: '    return a +', op: 't' }, { text: '    return (a', op: 't' }]);
assert.deepEqual(filtered.map((x) => x.text.trim()), ['return a - b']);

// comprehension with a condition: relational swap inside the filter
c = cands(['def q(arr, pivot):', '    greater = quicksort([x for x in arr[1:] if x > pivot])'], 1);
assert.ok(has(c, 'greater = quicksort([x for x in arr[1:] if x >= pivot])'), 'swap inside comprehension filter');
assert.ok(has(c, 'greater = quicksort([x for x in arr[1:] if pivot > x])'), 'operand swap inside comprehension');

console.log('mutations.test.mts: all checks passed');
