/**
 * TUI-DESIGN §19.0 CI gate for slot O7 (§20): every `src/**` file O7 added or edited has a matching
 * `test/unit/**` file, and the design's §19.0 table names that test file. The two
 * `src/tui/secrets/*` modules are tested under `test/unit/tui/onboarding/` by design (§19.0 row
 * "src/tui/secrets/{gate-lines,clipboard}.ts"), which a purely name-based mapping must special-case.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');

/** src file → unit test file (§20 O7 row × §19.0 rows). */
export const O7_MODULES: readonly { src: string; test: string }[] = [
  { src: 'src/core/redact.ts', test: 'test/unit/core/redact.test.ts' },
  { src: 'src/core/log.ts', test: 'test/unit/core/log.test.ts' },
  { src: 'src/tui/onboarding/reducer.ts', test: 'test/unit/tui/onboarding/reducer.test.ts' },
  { src: 'src/tui/onboarding/lines.ts', test: 'test/unit/tui/onboarding/lines.test.ts' },
  { src: 'src/tui/secrets/gate-lines.ts', test: 'test/unit/tui/onboarding/gate-lines.test.ts' },
  { src: 'src/tui/secrets/clipboard.ts', test: 'test/unit/tui/onboarding/clipboard.test.ts' },
  { src: 'src/config/credentials.ts', test: 'test/unit/config/credentials.test.ts' },
  { src: 'src/config/trust.ts', test: 'test/unit/config/trust.test.ts' },
  { src: 'src/config/instructions.ts', test: 'test/unit/config/instructions.test.ts' },
  { src: 'src/cli/login.ts', test: 'test/unit/config/login.test.ts' },
];

/** The default name mapping (`src/a/b.ts` → `test/unit/a/b.test.ts`) with the §19.0 special case for `src/tui/secrets/*` and `src/cli/login.ts`. */
export function expectedTestFor(src: string): string {
  if (src.startsWith('src/tui/secrets/')) return `test/unit/tui/onboarding/${src.slice('src/tui/secrets/'.length).replace(/\.ts$/, '.test.ts')}`;
  if (src === 'src/cli/login.ts') return 'test/unit/config/login.test.ts';
  return `test/unit/${src.slice('src/'.length).replace(/\.ts$/, '.test.ts')}`;
}

describe('§19.0 module → test sync (O7)', () => {
  it('every O7 source file exists and has its unit test file', () => {
    for (const { src, test } of O7_MODULES) {
      expect(existsSync(join(ROOT, src)), src).toBe(true);
      expect(existsSync(join(ROOT, test)), `${src} → ${test}`).toBe(true);
      expect(expectedTestFor(src)).toBe(test);
    }
  });

  it('the design’s §19.0 table names each test file; the moved redact test no longer exists under test/unit/config/', () => {
    const design = readFileSync(join(ROOT, 'docs/TUI-DESIGN.md'), 'utf8');
    const table = design.slice(design.indexOf('### 19.0'), design.indexOf('### 19.1'));
    for (const { test } of O7_MODULES) {
      // rows use brace expansion: `test/unit/config/{credentials,trust,instructions}.test.ts`
      const dir = test.slice(0, test.lastIndexOf('/') + 1);
      const name = test.slice(dir.length).replace(/\.test\.ts$/, '');
      const named = table.includes(test) || new RegExp(`${dir.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\{[^}]*\\b${name}\\b[^}]*\\}\\.test\\.ts`).test(table);
      expect(named, test).toBe(true);
    }
    expect(existsSync(join(ROOT, 'test/unit/config/redact.test.ts'))).toBe(false);
  });

  it('each O7 test file imports the module it covers', () => {
    for (const { src, test } of O7_MODULES) {
      const text = readFileSync(join(ROOT, test), 'utf8');
      const spec = src.replace(/^src\//, '').replace(/\.ts$/, '.js');
      expect(text.includes(spec), `${test} imports ${spec}`).toBe(true);
    }
  });
});
