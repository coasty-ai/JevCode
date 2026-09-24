/** Shared helpers for the composer unit tests (TUI-DESIGN §19.0–19.2). */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..', '..', '..');

/** Deterministic PRNG for property tests (mulberry32, A106). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(r: () => number, xs: readonly T[]): T {
  const v = xs[Math.floor(r() * xs.length)];
  if (v === undefined) throw new Error('pick from empty list');
  return v;
}

export type StringWidthFn = (s: string, opts?: { ambiguousIsNarrow?: boolean; countAnsiEscapeCodes?: boolean }) => number;

/**
 * Ink's `string-width` (a transitive dependency), resolved through `createRequire` from the repo root and imported from
 * the resolved path — never a runtime import of the package (F18). Null when the package is not installed.
 */
export async function loadStringWidth(): Promise<StringWidthFn | null> {
  try {
    const req = createRequire(join(REPO_ROOT, 'package.json'));
    const resolved = req.resolve('string-width');
    const mod = (await import(pathToFileURL(resolved).href)) as { default: StringWidthFn };
    return typeof mod.default === 'function' ? mod.default : null;
  } catch {
    return null;
  }
}

export interface WidthFixture {
  readonly generator: string;
  readonly count: number;
  readonly cases: readonly { readonly s: string; readonly w: number }[];
}

/** The checked-in corpus of 400+ strings with string-width@8.2.2 widths (research 07 §4 strings + rule probes + fuzz pool). */
export function loadWidthFixtures(): WidthFixture {
  return JSON.parse(readFileSync(join(here, 'fixtures', 'width-fixtures.json'), 'utf8')) as WidthFixture;
}

const oracle = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Grapheme clusters of `s` per the Intl.Segmenter oracle (A106). */
export function graphemes(s: string): string[] {
  return Array.from(oracle.segment(s), (x) => x.segment);
}

/** Grapheme boundary set of `s` per the oracle, 0 and `s.length` included. */
export function boundarySet(s: string): Set<number> {
  const out = new Set<number>([0, s.length]);
  for (const x of oracle.segment(s)) out.add(x.index + x.segment.length);
  return out;
}

/**
 * Legal cursor positions of a buffer per TUI-DESIGN §4.1's model: grapheme boundaries (Intl.Segmenter oracle) outside
 * every chip, plus both ends of every chip; a chip interior is never legal. With no chips this is exactly `boundarySet`.
 */
export function legalBoundaries(text: string, atoms: readonly { start: number; end: number }[]): Set<number> {
  const out = new Set<number>();
  for (const p of boundarySet(text)) {
    if (!atoms.some((a) => a.start < p && p < a.end)) out.add(p);
  }
  for (const a of atoms) {
    out.add(a.start);
    out.add(a.end);
  }
  return out;
}

/** Mixed-script insert pool for the fuzzers (ASCII, CJK, emoji, combining, ZWJ, wide forms). */
export const INSERT_POOL: readonly string[] = [
  'a', 'b', 'c', 'x', 'Z', '0', '7', ' ', ' ', ' ', '-', '_', '.', '/', ',', 'é', 'e\u0301', 'ü', 'ñ', 'ß',
  '日', '本', '語', '中', '文', '한', '글', 'ᄀ', 'ᅡ', 'ᆨ',
  '👍', '👍🏽', '👨\u200d👩\u200d👧\u200d👦', '❤\ufe0f', '❤', '☃\ufe0f', '1\ufe0f\u20e3', '🇺🇸', '🏳\ufe0f\u200d🌈', '🧑🏽\u200d🚀',
  '\u200b', '\u0301', '\u200d', '\ufe0f', 'Ａ', 'ｷ', 'ﾞ', 'क', 'ि', '्', 'ष', 'ท', 'ี', 'م', 'ר', '→', '─', '…',
];

/** Time `fn` once after a warm-up, in ms (performance.now). */
export function timeMs(fn: () => void, warmups = 2): number {
  for (let i = 0; i < warmups; i++) fn();
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

/** Best (minimum) of `n` timings, in ms — the code's cost with scheduler noise from parallel test workers removed. */
export function bestMs(fn: () => void, n = 7): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) best = Math.min(best, timeMs(fn, i === 0 ? 2 : 0));
  return best;
}

/** Median of `n` timings, in ms. */
export function medianMs(fn: () => void, n = 5): number {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(timeMs(fn, i === 0 ? 2 : 0));
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)] ?? 0;
}

// eslint-disable-next-line no-control-regex
export const CONTROL_OR_BIDI_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029]/;
