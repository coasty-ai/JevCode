/**
 * Productions P1–P13 (src/jev-modes/synth/sketch/productions.ts). The corpus test re-runs the Appendix A
 * offline coverage measurement against the production code: the pool must hold a shape the gold
 * line instantiates on ≥ 36/40 QuixBugs programs (the pilot: 39/40, `shortest_paths` out).
 */
import { describe, expect, it } from 'vitest';
import { detokenize, toks } from '../../../../../src/jev-modes/synth/beam/tokens.js';
import { sketchPool } from '../../../../../src/jev-modes/synth/sketch/pool.js';
import { HOLE_TOK, OP_HOLE_TOK, donorShapes, editClassesOf, guardTemplates, holeIndices, hypothesisToks, inLoop, insertTemplates, instantiates, replaceProductions, tokOf } from '../../../../../src/jev-modes/synth/sketch/productions.js';
import type { ProductionId } from '../../../../../src/jev-modes/synth/sketch/productions.js';
import { HAS_CORPUS, corpusSite, enumerateOptions, gcdSite, loadCorpus, siteAt, sourceFile } from './helpers.js';

/** A function with a for-else, a nested if, a while and a `continue` line (line numbers in the tests). */
const LOOPS = ['def f(xs):', '    total = 0', '    for x in xs:', '        if x:', '            total += x', '    else:', '        total = -1', '    while total:', '        total -= 1', '    return total', '', 'def g(ys):', '    for y in ys:', '        continue', ''].join('\n');

/** Rendered shapes of a line's productions, optionally of one production only. */
function shapes(line: string, only?: ProductionId): string[] {
  return replaceProductions(toks(line))
    .filter((s) => only === undefined || s.production === only)
    .map((s) => detokenize(s.toks));
}

describe.skipIf(!HAS_CORPUS)('productions: gold-shape coverage on the 40 measured QuixBugs lines', () => {
  const corpus = loadCorpus();

  it('the pool contains a sketch the gold line instantiates on ≥ 36/40 programs (pilot: 39/40); misses listed', () => {
    const misses: string[] = [];
    const sizes: number[] = [];
    for (const item of corpus) {
      const { site, opts } = corpusSite(item);
      const pool = sketchPool(site, opts);
      sizes.push(pool.length);
      const fix = toks(item.fix_line);
      if (!pool.some((h) => instantiates(h.toks, fix))) misses.push(item.name);
    }
    expect(corpus).toHaveLength(40);
    expect(40 - misses.length).toBeGreaterThanOrEqual(36);
    // the one line that needs two edits (Appendix A.3): a miss by construction, never a regression
    expect(misses).toEqual(['shortest_paths']);
    // never capped on QuixBugs (median 64, max 138 measured)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(254);
    const sorted = [...sizes].sort((a, b) => a - b);
    expect(sorted[20]!).toBeLessThanOrEqual(70);
  });

  it('the four insertions are covered by the P11 statement templates, top of the pool', () => {
    for (const item of corpus.filter((i) => i.kind === 'insert')) {
      const { site, opts } = corpusSite(item);
      const pool = sketchPool(site, opts);
      const fix = toks(item.fix_line);
      const hit = pool.find((h) => instantiates(h.toks, fix));
      expect(hit?.production, item.name).toBe('P11');
      expect(pool.indexOf(hit!)).toBeLessThan(6);
    }
  });
});

describe('productions: P1–P10 on a replace line', () => {
  it('P1 holes one name/literal or one operator', () => {
    expect(shapes('return gcd(a % b, b)', 'P1')).toEqual(['return _(a % b, b)', 'return gcd(_ % b, b)', 'return gcd(a <op> b, b)', 'return gcd(a % _, b)', 'return gcd(a % b, _)']);
    expect(shapes('while True:', 'P1')).toEqual(['while _:']);
    expect(shapes('n ^= n - 1', 'P1')).toContain('n <op> n - 1');
  });
  it('P2 holes an operator and its right operand together', () => {
    expect(shapes('if len(arr) == 0:', 'P2')).toContain('if len(arr) <op> _:');
  });
  it('P3 adds fragments after a value with the grammar preconditions', () => {
    const s = shapes('for x in arr:', 'P3');
    expect(s).toContain('for x in arr[_:]:');
    expect(s).toContain('for x in arr[_]:');
    // boolean fragments only at depth 0 of a header or return
    expect(shapes('if total < 0:', 'P3')).toContain('if total < 0 or not _:');
    expect(shapes('x = f(a)', 'P3')).not.toContain('x = f(a or _)');
    // no subscript after a literal
    expect(shapes('return k + 1', 'P3')).not.toContain('return k + 1[_]');
    expect(shapes('return kth(above, k)', 'P3')).toContain('return kth(above, k <op> _)');
  });
  it('P4 adds fragments before an operand; None guards only in headers', () => {
    expect(shapes('if hare.successor is None:', 'P4')).toContain('if _ is None or hare.successor is None:');
    expect(shapes('return rest', 'P4')).toContain('return _ <op> rest');
    expect(shapes('return rest', 'P4')).not.toContain('return _ is None or rest');
    expect(shapes('while True:', 'P4')).toContain('while not True:');
  });
  it('P5 wraps operand spans and the whole right-hand side in a call', () => {
    const s = shapes('longest = length + 1', 'P5');
    expect(s).toContain('longest = _(_, length + 1)');
    expect(s).toContain('longest = _(length + 1)');
    expect(s).toContain('longest = _(length, _) + 1');
    expect(shapes('if all(n % p for p in primes):', 'P5')).toContain('if _(all(n % p for p in primes)):');
  });
  it('P6 deletes an operand+operator pair, unwraps a call, drops a negation or redundant parentheses', () => {
    expect(shapes('yield flatten(x)', 'P6')).toContain('yield x');
    expect(shapes('longest = length + 1', 'P6')).toContain('longest = length');
    expect(shapes('longest = length + 1', 'P6')).toContain('longest = 1');
    expect(shapes('if not x:', 'P6')).toContain('if x:');
    expect(shapes('return (a + b)', 'P6')).toContain('return a + b');
  });
  it('P7 swaps adjacent arguments and the operands of a binary operator', () => {
    expect(shapes('return gcd(a % b, b)', 'P7')).toEqual(['return gcd(b, a % b)', 'return gcd(b % a, b)']);
    expect(shapes('if perm[j] < perm[i]:', 'P7')).toContain('if perm[i] < perm[j]:');
    expect(shapes('result = result + alphabet[i]', 'P7')).toContain('result = alphabet[i] + result');
  });
  it('P8 replaces a multi-token operand by one hole; a call\'s bracket is a trailer, not an operand', () => {
    expect(shapes('return a + f(x)', 'P8')).toEqual(['return a + _']);
    expect(shapes('return a + (b * c)', 'P8')).toEqual(['return a + _']);
  });
  it('P9 turns a trailing method call into an assignment of its argument', () => {
    expect(shapes('xs[a].update(ys[b])', 'P9')).toEqual(['xs[a] = ys[b]']);
  });
  it('P10 offers the RHS templates for return/yield/assignment, keeping a header colon', () => {
    const s = shapes('return []', 'P10');
    expect(s).toContain('return [_]');
    expect(s).toContain('return [[]]');
    expect(s).toContain('return _ <op> _');
    expect(s).toContain('return None');
    expect(shapes('x = 1', 'P10')).toContain('x = _(_, _)');
    expect(shapes('if x:', 'P10')).toEqual([]);
  });
  it('an empty line has no productions', () => {
    expect(replaceProductions([])).toEqual([]);
  });
});

describe('productions: insert-site templates, guards and donors', () => {
  it('P11 puts the statement templates first, then the block\'s own line shapes fully abstracted', () => {
    const { file } = gcdSite();
    const site = siteAt(file, 5, 'insert');
    const s = insertTemplates(site).map((x) => [x.production, detokenize(x.toks), x.change] as const);
    expect(s[0]).toEqual(['P11', '_._(_)', 'call a method with one argument (e.g. `xs.append(x)`)']);
    expect(s[1]![1]).toBe('_ = _');
    expect(s.map((x) => x[1])).toContain('if _ <op> _:');
    expect(s.map((x) => x[1])).toContain('return _(_ <op> _, _)');
    expect(s.every((x) => x[0] === 'P11')).toBe(true);
  });
  it('P12 emits the two-line guard with the body as an insert extra edit one level deeper; `continue` only in a loop', () => {
    const { file } = gcdSite();
    const site = siteAt(file, 5, 'insert');
    const g = guardTemplates(site);
    // the gcd gap sits in an `else:` branch, not a loop: no `continue` body there
    expect(g.map((x) => detokenize(x.toks))).toEqual(['if _ <op> _:', 'if _ <op> _:']);
    expect(g.map((x) => x.extraEdits?.[0]?.text)).toEqual(['            return _', '            raise _']);
    expect(g[0]!.extraEdits?.[0]).toMatchObject({ path: 'gcd.py', line: 5, kind: 'insert' });
    expect(g.every((x) => x.production === 'P12')).toBe(true);
    const loops = sourceFile('loops.py', LOOPS);
    const inWhile = guardTemplates(siteAt(loops, 9, 'insert'));
    expect(inWhile.map((x) => x.extraEdits?.[0]?.text)).toEqual(['            return _', '            raise _', '            continue']);
  });
  it('inLoop: for/while bodies (nested too) are loop context; a for-else branch, the def body and a sibling of the loop are not', () => {
    const loops = sourceFile('loops.py', LOOPS);
    expect(inLoop(siteAt(loops, 5, 'insert'))).toBe(true); // inside `if` inside `for`
    expect(inLoop(siteAt(loops, 4, 'insert'))).toBe(true); // first line of the for body
    expect(inLoop(siteAt(loops, 7, 'insert'))).toBe(false); // for … else: branch
    expect(inLoop(siteAt(loops, 9, 'insert'))).toBe(true); // while body
    expect(inLoop(siteAt(loops, 10, 'insert'))).toBe(false); // after the loops, def level
    expect(inLoop(siteAt(loops, 2, 'insert'))).toBe(false);
    expect(inLoop(siteAt(loops, 9))).toBe(true); // a replace site inside the while
  });
  it('P11 offers `continue` / `break` (templates and own-line shapes) only inside a loop body', () => {
    const loops = sourceFile('loops.py', LOOPS);
    const inWhile = insertTemplates(siteAt(loops, 9, 'insert')).map((x) => detokenize(x.toks));
    expect(inWhile).toContain('continue');
    expect(inWhile).toContain('break');
    const afterLoops = insertTemplates(siteAt(loops, 10, 'insert')).map((x) => detokenize(x.toks));
    expect(afterLoops).not.toContain('continue');
    expect(afterLoops).not.toContain('break');
    // the block's own `continue` line is a shape only where it compiles
    expect(afterLoops).toContain('_ <op> _');
    const { file } = gcdSite();
    expect(insertTemplates(siteAt(file, 5, 'insert')).map((x) => detokenize(x.toks))).not.toContain('continue');
  });
  it('P13 abstracts near-duplicate lines of the corpus into donor shapes', () => {
    const { site } = gcdSite();
    const donor = sourceFile('other.py', 'def h(x, y):\n    if y == 0:\n        return x\n    return h(y, x % y)\n\n\ndef unrelated():\n    print("hello", 1, 2, 3)\n');
    const s = donorShapes(site, enumerateOptions({ corpus: new Map([['other.py', donor]]) }));
    expect(s.map((x) => detokenize(x.toks))).toContain('return _(_, _ % _)');
    expect(s.every((x) => x.production === 'P13')).toBe(true);
    expect(s.some((x) => detokenize(x.toks).startsWith('print'))).toBe(false);
    // the site's own line is never its own donor
    expect(s.map((x) => detokenize(x.toks))).not.toContain('return _(_ % _, _)');
  });
});

describe('productions: instantiation, holes, token round trip, edit classes', () => {
  it('instantiates: same length, literals equal, `_` over a value, `<op>` over an operator (symbolic or keyword)', () => {
    expect(instantiates(['while', '_', ':'], toks('while queue:'))).toBe(true);
    expect(instantiates(['while', '_', ':'], toks('while queue and x:'))).toBe(false);
    expect(instantiates(['while', 'lo', '<op>', 'hi', ':'], toks('while lo < hi:'))).toBe(true);
    expect(instantiates(['if', 'a', '<op>', 'b', ':'], toks('if a and b:'))).toBe(true);
    expect(instantiates(['if', 'a', '<op>', 'b', ':'], toks('if a x b:'))).toBe(false);
    expect(instantiates([HOLE_TOK, OP_HOLE_TOK, HOLE_TOK], toks('n - 1'))).toBe(true);
    expect(instantiates([HOLE_TOK], toks('f(x)'))).toBe(false);
  });
  it('holeIndices and tokOf round-trip the frozen string form', () => {
    expect(holeIndices(['_', '.', '_', '(', '_', ')'])).toEqual([0, 2, 4]);
    expect(holeIndices(['return', 'x'])).toEqual([]);
    expect(tokOf('_')).toBe(HOLE_TOK);
    expect(tokOf('<op>')).toBe(OP_HOLE_TOK);
    expect(tokOf('and').cls).toBe('keyword');
    expect(tokOf("'s'").cls).toBe('string');
    expect(tokOf('3').cls).toBe('number');
    expect(tokOf('None').cls).toBe('literal');
    expect(detokenize(hypothesisToks(['return', 'gcd', '(', '_', ',', '_', '%', '_', ')']))).toBe('return gcd(_, _ % _)');
  });
  it('editClassesOf maps productions to the Q7 classes (P13 depends on the site kind)', () => {
    expect(editClassesOf('P1', 'replace')).toEqual(['substitute_one_token']);
    expect(editClassesOf('P3', 'replace')).toEqual(['insert_fragment']);
    expect(editClassesOf('P6', 'replace')).toEqual(['delete_fragment']);
    expect(editClassesOf('P7', 'replace')).toEqual(['reorder_tokens']);
    expect(editClassesOf('P10', 'replace')).toEqual(['reshape_line', 'insert_fragment']);
    expect(editClassesOf('P11', 'insert')).toEqual(['insert_new_line']);
    expect(editClassesOf('P13', 'insert')).toEqual(['insert_new_line']);
    expect(editClassesOf('P13', 'replace')).toEqual(['reshape_line']);
  });
});
