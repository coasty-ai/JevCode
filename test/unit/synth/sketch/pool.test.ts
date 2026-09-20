/** The sketch pool (src/synth/sketch/pool.ts): order, dedupe, cap, unchanged-line exclusion, hole indices. */
import { describe, expect, it } from 'vitest';
import { MAX_SKETCHES, hasChange, sketchKey, sketchPool, sketchText } from '../../../../src/synth/sketch/pool.js';
import { enumerateOptions, gcdSite, siteAt, sourceFile } from './helpers.js';

describe('sketchPool', () => {
  it('reproduces the measured gcd pool: 80 sketches, P1 first, every shape and key unique, hole indices right', () => {
    const { site } = gcdSite();
    const pool = sketchPool(site, enumerateOptions());
    // Appendix A.3 row `gcd`: pool 80, of which four were ungrammatical trailer spans (`return gcd _`)
    // the operand-span precondition now excludes; P13 finds no donor in a one-function file
    expect(pool).toHaveLength(76);
    expect(pool[0]).toMatchObject({ production: 'P1', toks: ['return', '_', '(', 'a', '%', 'b', ',', 'b', ')'], holes: [1], pSketch: 0, logP: 0 });
    expect(sketchText(pool[0]!)).toBe('return _(a % b, b)');
    expect(new Set(pool.map(sketchKey)).size).toBe(pool.length);
    expect(new Set(pool.map(sketchText)).size).toBe(pool.length);
    for (const h of pool) {
      expect(h.holes).toEqual(h.toks.map((t, i) => (t === '_' || t === '<op>' ? i : -1)).filter((i) => i >= 0));
      expect(h.site).toBe(site);
      expect(hasChange(h)).toBe(true);
    }
    const gold = pool.find((h) => sketchText(h) === 'return gcd(b, a % b)');
    expect(gold).toMatchObject({ production: 'P7', holes: [], change: 'swap two adjacent arguments or elements' });
    expect(pool.indexOf(gold!)).toBeLessThan(10);
  });

  it('is deterministic', () => {
    const { site } = gcdSite();
    const a = sketchPool(site, enumerateOptions()).map(sketchKey);
    const b = sketchPool(site, enumerateOptions()).map(sketchKey);
    expect(a).toEqual(b);
  });

  it('excludes the unchanged line when a production reproduces it hole-free, keeps holed copies', () => {
    const file = sourceFile('f.py', 'def f(a):\n    return g(a, a)\n');
    const pool = sketchPool(siteAt(file, 2), enumerateOptions());
    const texts = pool.map(sketchText);
    expect(texts).not.toContain('return g(a, a)');
    expect(texts).toContain('return g(_, a)');
    expect(texts).toContain('return _(a, a)');
  });

  it('caps a long line at 254 and keeps the priority order (P1 before P13)', () => {
    const terms = Array.from({ length: 30 }, (_, i) => `t${i}`).join(' + ');
    const file = sourceFile('long.py', `def f():\n    x = ${terms}\n    y = ${terms} + 1\n`);
    const pool = sketchPool(siteAt(file, 2), enumerateOptions());
    expect(pool).toHaveLength(MAX_SKETCHES);
    expect(pool[0]!.production).toBe('P1');
    const last1 = pool.map((h) => h.production).lastIndexOf('P1');
    const first13 = pool.map((h) => h.production).indexOf('P13');
    if (first13 >= 0) expect(first13).toBeGreaterThan(last1);
  });

  it('at an insert site: statement templates first, the two-line guards distinct from the plain header shape', () => {
    const { file } = gcdSite();
    const site = siteAt(file, 5, 'insert');
    const pool = sketchPool(site, enumerateOptions());
    expect(sketchText(pool[0]!)).toBe('_._(_)');
    expect(pool[0]).toMatchObject({ production: 'P11', holes: [0, 2, 4] });
    const guards = pool.filter((h) => h.production === 'P12');
    // two bodies at this gap (`return _`, `raise _`): it is not inside a loop, so no `continue` guard
    expect(guards).toHaveLength(2);
    expect(sketchText(guards[0]!)).toBe('if _ <op> _:\n    return _');
    expect(guards[0]!.extraEdits).toEqual([{ path: 'gcd.py', line: 5, kind: 'insert', text: '            return _' }]);
    // the own-line shape of `if b == 0:` survives beside the guards (different key)
    expect(pool.some((h) => h.production === 'P11' && sketchText(h) === 'if _ <op> _:')).toBe(true);
    expect(new Set(pool.map(sketchText)).size).toBe(pool.length);
  });
});
