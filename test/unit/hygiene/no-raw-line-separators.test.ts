/**
 * Guard: no raw U+2028 / U+2029 anywhere under src/**, scripts/** or bin/**.
 *
 * The failure is narrower than it was first written (F24b): esbuild \u2014 vitest's transformer, and our bundler \u2014 rejects a raw
 * U+2028/U+2029 inside a REGEX LITERAL with "Unterminated regular expression", because it terminates the literal as a line
 * break; inside a string literal it is legal and esbuild accepts it. Two test fixtures rely on exactly that
 * (test/unit/import/parse/markdown.test.ts:132-145 and test/unit/coordination/records.test.ts:113 hold the raw characters in
 * strings and transform fine), which is why this walk covers shipped code and not test/**. One stray character in a regex
 * turned every importer's test file red on a clean checkout (2026-09-22, src/errors.ts:368, fixed 9f26fb6). The scan stays
 * blunt \u2014 any raw occurrence, regex or not \u2014 because the cost of writing `\u2028` / `\u2029` is nil and telling the two
 * contexts apart needs a parser.
 *
 * `bin/` is scanned because package.json `files` ships it VERBATIM (it is not bundled): a raw separator there reaches an
 * installed copy, where no test would see it. It is clean today and stays that way.
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

describe('source hygiene: no raw U+2028 / U+2029 in src/**, scripts/** or bin/**', () => {
  it('every file uses the escaped forms', () => {
    const hits: string[] = [];
    // files with a known raw separator; the allow-list shrinks as they escape their characters
    const PENDING_HARNESS_FILES = new Set<string>();
    for (const f of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'bin'))]) {
      if (PENDING_HARNESS_FILES.has(relative(ROOT, f))) continue;
      const text = readFileSync(f, 'utf8');
      const i = text.search(/[\u2028\u2029]/);
      if (i >= 0) hits.push(`${relative(ROOT, f)}: offset ${i}`);
    }
    expect(hits).toEqual([]);
  });
});
