/**
 * Guard: a source comment that points somewhere is checked against disk, so the pointer rots loudly
 * rather than silently.
 *
 * Two classes of rot, both found by the finishing-pass audit (F23) and both invisible to `tsc`, to
 * `no-any.mjs` and to every unit test, because a comment compiles to nothing:
 *
 *   1. **A cited test file that does not exist.** `src/core/limits.ts` said the
 *      `MAX_CLAIMS_PER_RUN` invariant was pinned by `test/unit/core/limits-claims.test.ts`; that
 *      file has never existed (the invariant is pinned at
 *      `test/unit/checkpoint/run-claims.test.ts`). The next reader who wants to change the cap
 *      greps for the named test, finds nothing, and concludes the number is unpinned.
 *   2. **A `TODO(owner)` whose owner already satisfies it.** `src/core/types.ts` carried
 *      `TODO(src/cli/session.ts): pass config.generator.pricing here` although both engine
 *      construction sites in `src/cli/session.ts` have passed `generatorPricing` since the
 *      models-catalogue wave — a standing invitation to do work that is already done.
 *
 * Only COMMENT text is scanned: `src/orchestrate/split/questions.ts` carries `test/unit/parse.test.ts`
 * and friends inside Jev question prose (worked examples of an owns list), and a path in a string
 * literal is data, not a pointer.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * The comment text of one file, line by line: a line whose first non-space character opens or
 * continues a comment, plus the tail of a trailing line comment on a code line — and only when the
 * `//` is not inside a quoted string, which an odd quote count before it is the cheap test for.
 */
export function commentLines(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      out.push({ line: i + 1, text: raw });
      continue;
    }
    const at = raw.indexOf('//');
    if (at < 0) continue;
    const before = raw.slice(0, at);
    const quotes = (before.match(/['"`]/g) ?? []).length;
    if (quotes % 2 === 0) out.push({ line: i + 1, text: raw.slice(at) });
  }
  return out;
}

const TEST_PATH_RE = /(?<![\w/.])test\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:ts|tsx|mts|mjs)/g;
const TODO_OWNER_RE = /TODO\(([^)]*)\)/g;

/**
 * The `TODO(owner)` markers that are still open, each with the reason it cannot be closed yet.
 * A marker missing from this list is either new and undeclared or — the case that started this
 * test — stale: its owner already does the thing, and the fix is to DELETE the marker, never to
 * add a row below.
 */
const OPEN_TODO_OWNERS: readonly { marker: string; owner: string; why: string }[] = [
  { marker: 'stage 4, src/synth/oracle/search.ts', owner: 'src/synth/oracle/search.ts', why: "LlmOracleOutcome's `llm_valid` / `llm_weak` live in synth/llm/repro.ts until the oracle search carries them (docs/LLM-JEV-DESIGN.md §9.2 stage 4)" },
  { marker: 'stage 4, src/synth/search/proposal.ts proposeRevert', owner: 'src/synth/search/proposal.ts', why: 'the revert marker is still the goal-text prefix `revert`; a typed member on the proposal is stage 4' },
];

describe('source hygiene: a comment that points somewhere points at something', () => {
  const files = walk(join(ROOT, 'src'));

  it('every test/… path cited in a src comment resolves on disk', () => {
    const missing: string[] = [];
    for (const f of files) {
      for (const c of commentLines(readFileSync(f, 'utf8'))) {
        for (const m of c.text.matchAll(TEST_PATH_RE)) {
          if (!existsSync(join(ROOT, m[0]))) missing.push(`${relative(ROOT, f)}:${c.line} cites ${m[0]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('only a string literal may carry a non-existent test path, and the extractor knows the difference', () => {
    // the guard above is only as good as this: questions.ts's worked examples are DATA, not pointers
    expect(commentLines("const a = 'owns test/unit/parse.test.ts';\n")).toEqual([]);
    expect(commentLines('// see test/unit/parse.test.ts\n')).toEqual([{ line: 1, text: '// see test/unit/parse.test.ts' }]);
    expect(commentLines(' * see test/unit/parse.test.ts\n')).toEqual([{ line: 1, text: ' * see test/unit/parse.test.ts' }]);
    expect(commentLines('const s = 1; // tail test/unit/parse.test.ts\n')).toEqual([{ line: 1, text: '// tail test/unit/parse.test.ts' }]);
    // `src/_pytest/_version.py` must not read as a `test/…` citation
    expect([...'/src/_pytest/_version.py'.matchAll(TEST_PATH_RE)]).toEqual([]);
  });

  it('every TODO(owner) in src is declared open, and its owner file exists', () => {
    const found: string[] = [];
    for (const f of files) {
      for (const c of commentLines(readFileSync(f, 'utf8'))) {
        for (const m of c.text.matchAll(TODO_OWNER_RE)) found.push(m[1]!);
      }
    }
    expect([...found].sort()).toEqual(OPEN_TODO_OWNERS.map((t) => t.marker).sort());
    for (const t of OPEN_TODO_OWNERS) expect(existsSync(join(ROOT, t.owner)), `${t.owner} (${t.why})`).toBe(true);
  });

  it('the generatorPricing note names its filler rather than asking for it: session.ts passes it at both engine sites', () => {
    const session = readFileSync(join(ROOT, 'src/cli/session.ts'), 'utf8');
    expect((session.match(/generatorPricing: genCfg\.pricing/g) ?? []).length).toBe(2);
    const types = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8');
    const at = types.indexOf('generatorPricing?: GeneratorConfig');
    const note = types.slice(Math.max(0, at - 700), at);
    expect(note).not.toContain('TODO');
    expect(note).toContain('src/cli/session.ts from config.generator.pricing');
  });
});
