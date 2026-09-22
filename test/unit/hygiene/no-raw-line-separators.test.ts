/**
 * Guard: no raw U+2028 / U+2029 anywhere under src/** or scripts/**. TypeScript accepts them inside a regex or string literal, but
 * esbuild (vitest's transformer, and our bundler) rejects them ("Unterminated regular expression"), so a single stray character
 * turns every importer's test file red on a clean checkout (2026-09-22, src/errors.ts:368). Write `\u2028` / `\u2029` instead.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe('source hygiene: no raw U+2028 / U+2029 in src/** or scripts/**', () => {
  it('every file uses the escaped forms', () => {
    const hits: string[] = [];
    // files with a known raw separator; the allow-list shrinks as they escape their characters
    const PENDING_HARNESS_FILES = new Set<string>();
    for (const f of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))]) {
      if (PENDING_HARNESS_FILES.has(relative(ROOT, f))) continue;
      const text = readFileSync(f, 'utf8');
      const i = text.search(/[\u2028\u2029]/);
      if (i >= 0) hits.push(`${relative(ROOT, f)}: offset ${i}`);
    }
    expect(hits).toEqual([]);
  });
});
