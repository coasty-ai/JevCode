/**
 * The bounded whole-string width cache behind `stringWidth`'s non-ASCII path (render cost outside the App): a hit is
 * the number the uncached measure returns — Σ `cellWidth` over the Intl.Segmenter clusters, and Ink's own
 * `string-width@8.2.2` when it resolves — over seeded strings drawn from ASCII, CJK, emoji / ZWJ / skin tones / keycaps,
 * flags, combining marks, box glyphs, Hangul jamo, Indic spacing marks and zero-width code points, measured cold,
 * warm, through an equal string built separately and through a slice of a longer string; the map never exceeds
 * `WIDTH_CACHE_MAX`, evicts oldest-first without changing any answer, and leaves printable ASCII and over-long strings out.
 */
import { describe, expect, it } from 'vitest';
import { WIDTH_CACHE_MAX, WIDTH_CACHE_MAX_LENGTH, cellWidth, stringWidth, stringWidthCacheSize } from '../../../../src/tui/composer/width.js';
import { graphemes, loadStringWidth, mulberry32, pick } from './helpers.js';

const live = await loadStringWidth();

/** The definition, uncached: Σ `cellWidth` over the grapheme clusters. */
const reference = (s: string): number => graphemes(s).reduce((w, g) => w + cellWidth(g), 0);

const POOLS: Readonly<Record<string, readonly string[]>> = {
  ascii: ['a', 'Z', '0', ' ', '-', '_', '/', '~', 'q', '9'],
  cjk: ['日', '本', '語', '中', '文', 'テ', 'キ', 'ス', 'ト', '한', '글', '　', 'Ａ', 'ｷ'],
  emoji: ['👍', '👍🏽', '👨‍👩‍👧‍👦', '🧑🏽‍🚀', '❤️', '❤', '☃️', '1️⃣', '#⃣', '🏳️‍🌈', '✅', '⌚'],
  flags: ['🇺🇸', '🇯🇵', '🇩🇪', '🇧🇷', '\u{1f1fa}', '\u{1f1f8}'],
  combining: ['é', 'à́', 'ö', '́', 'ñ', 'क', 'ि', '्', 'ष', 'ท', 'ี'],
  box: ['─', '│', '╭', '╮', '╰', '╯', '├', '┤', '┆', '▌', '█', '·', '…', '→', '◆', '▾', '⚠'],
  zeroWidth: ['​', '‍', '️', '­', '⁠'],
  hangul: ['ᄀ', 'ᅡ', 'ᆨ', 'ᄒ', 'ᅥ'],
};
const MIXED: readonly string[] = Object.values(POOLS).flat();

function sample(r: () => number, pool: readonly string[], n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += pick(r, pool);
  return s;
}

/** An equal string that shares nothing with `s` (built code unit by code unit). */
const rebuilt = (s: string): string => Array.from({ length: s.length }, (_u, i) => String.fromCharCode(s.charCodeAt(i))).join('');

describe('stringWidth cache: cached == uncached', () => {
  it.each(Object.keys(POOLS))('pool %s: cold, warm, rebuilt and sliced measures all equal the uncached width', (name) => {
    const r = mulberry32(name.length * 7919);
    const pool = POOLS[name] ?? [];
    for (let i = 0; i < 400; i++) {
      const s = sample(r, i % 2 === 0 ? pool : MIXED, 1 + Math.floor(r() * 24));
      const want = reference(s);
      expect(stringWidth(s), JSON.stringify(s)).toBe(want); // cold (or already cached by an earlier case)
      expect(stringWidth(s), JSON.stringify(s)).toBe(want); // warm
      expect(stringWidth(rebuilt(s)), JSON.stringify(s)).toBe(want); // an equal key built separately
      const host = `${'x'.repeat(20)}${s}${'日'.repeat(20)}`;
      const sliced = host.slice(20, 20 + s.length);
      expect(sliced).toBe(s);
      expect(stringWidth(sliced), JSON.stringify(s)).toBe(want); // a V8 slice of a longer string
      if (live !== null) expect(live(s), JSON.stringify(s)).toBe(want);
    }
  });

  it('an equal string is a hit (the map does not grow), a new one is a miss (it grows by one)', () => {
    const s = `hit ${'─'.repeat(40)} 日本語 ${Date.now()}`;
    const before = stringWidthCacheSize();
    const w = stringWidth(s);
    const after = stringWidthCacheSize();
    expect(after === before + 1 || after === WIDTH_CACHE_MAX).toBe(true);
    expect(stringWidth(rebuilt(s))).toBe(w);
    expect(stringWidthCacheSize()).toBe(after);
  });

  it('printable ASCII and strings longer than WIDTH_CACHE_MAX_LENGTH never enter the map, and still measure right', () => {
    const before = stringWidthCacheSize();
    expect(stringWidth('plain ascii row that repeats every frame')).toBe(40);
    const long = `${'日'.repeat(WIDTH_CACHE_MAX_LENGTH)}─`;
    expect(stringWidth(long)).toBe(2 * WIDTH_CACHE_MAX_LENGTH + 1);
    expect(stringWidth(long)).toBe(reference(long));
    expect(stringWidthCacheSize()).toBe(before);
  });
});

describe('stringWidth cache: bounded, oldest evicted first, answers unchanged', () => {
  it(`holds at most WIDTH_CACHE_MAX (${WIDTH_CACHE_MAX}) entries across ${WIDTH_CACHE_MAX * 2} distinct strings`, () => {
    const r = mulberry32(0xcafe);
    const seen: { s: string; w: number }[] = [];
    for (let i = 0; i < WIDTH_CACHE_MAX * 2; i++) {
      const s = `${i}:${sample(r, MIXED, 1 + (i % 9))}─`;
      const w = stringWidth(s);
      expect(w, JSON.stringify(s)).toBe(reference(s));
      expect(stringWidthCacheSize()).toBeLessThanOrEqual(WIDTH_CACHE_MAX);
      if (i % 97 === 0) seen.push({ s, w });
    }
    expect(stringWidthCacheSize()).toBe(WIDTH_CACHE_MAX);
    // the earliest entries were evicted; measuring them again gives the same answer (a miss, then cached again)
    for (const { s, w } of seen) expect(stringWidth(s), JSON.stringify(s)).toBe(w);
    expect(stringWidthCacheSize()).toBe(WIDTH_CACHE_MAX);
  });
});
