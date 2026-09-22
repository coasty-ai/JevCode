/**
 * TUI-DESIGN-3 §1.1 (D-N): no string anywhere hard-codes which engine mode is the default — `DEFAULT_MODE` (src/config/defaults.ts)
 * is the one constant and `MODE_BADGE_WORD` the one table; every `/mode` hint, usage line, man page row and fix block derives from
 * them, so the peer's later flip (`llm-jev`) moves nothing but the literal. This test reads every `.ts` / `.tsx` under `src/` and
 * `scripts/gen-docs.mjs` and the generated docs.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, MODE_SETTING_VALUES } from '../../../src/config/defaults.js';

const ROOT = join(import.meta.dirname, '../../..');
const DEFAULTS = 'src/config/defaults.ts';
/** the phrasings that name a default mode in prose; `default <mode>` computed from DEFAULT_MODE is the only allowed form */
const LITERAL_RE = /jev-only \(default|, the default\)|is the default|default mode is|default jev-only|default: jev-only|default jev-on\b|jev-on \(default|default llm-jev/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('TUI-DESIGN-3 §1.1 / D-N: no literal names the default mode outside defaults.ts', () => {
  it('src/** and scripts/gen-docs.mjs carry no `jev-only (default`, `, the default)`, `is the default`, `default mode is` naming a mode', () => {
    const files = [...walk(join(ROOT, 'src')), join(ROOT, 'scripts', 'gen-docs.mjs')];
    const hits: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f);
      if (rel === DEFAULTS) continue;
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (LITERAL_RE.test(l)) hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the generated docs name the default only as `default <DEFAULT_MODE>` (docs/COMMANDS.md, man/jevcode.1)', () => {
    for (const rel of ['docs/COMMANDS.md', 'man/jevcode.1']) {
      const text = readFileSync(join(ROOT, rel), 'utf8').replace(/\\-/g, '-');
      expect(text, rel).toContain(`default ${DEFAULT_MODE}`);
      for (const m of MODE_SETTING_VALUES) {
        if (m === DEFAULT_MODE) continue;
        expect(text, `${rel} names ${m} as a default`).not.toMatch(new RegExp(`default ${m}\\b`));
        expect(text, `${rel} names ${m} as the default`).not.toMatch(new RegExp(`${m} \\(default|${m}, the default`));
      }
    }
  });
});
