/** Fixture loading shared by the synth/py unit tests. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '../../../../fixtures/synth/py');

export const FIXTURE_NAMES = ['knapsack', 'levenshtein', 'topological_ordering', 'calc_core', 'tricky'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export function fixture(name: FixtureName): string {
  return readFileSync(join(FIXTURES, `${name}.py`), 'utf8');
}

/** [type, string, startLine, startCol, endLine, endCol] as written by gen_tokens.py (CPython tokenize). */
export type CPythonToken = [string, string, number, number, number, number];

export function cpythonTokens(name: FixtureName): CPythonToken[] {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.tokens.json`), 'utf8')) as CPythonToken[];
}

/** Deterministic PRNG for property-style tests (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
