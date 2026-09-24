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
 *
 * A third class, added by the review of the finishing pass (B1/B2/B3): **a claim about the tree that
 * a later change falsified, surviving in the copies nobody grepped.** F05 removed S2 from the
 * `jev-on-next` arms in `armMechanisms`, in `report.ts`'s conditions paragraph and in §8.1 of the
 * design, and left the same sentence standing in the `BenchCondition` declaration that DEFINES the
 * arm, in the `(f)` detail the §8.3 table renders at runtime, and in the §8.5 accept rule's escape.
 * The sweep below is over raw source, not over comments: two of the three survivors are string
 * literals a reader sees in `comparison.md`, not comments a reader sees in an editor.
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
  { marker: 'stage 4, src/jev-modes/synth/oracle/search.ts', owner: 'src/jev-modes/synth/oracle/search.ts', why: "LlmOracleOutcome's `llm_valid` / `llm_weak` live in synth/llm/repro.ts until the oracle search carries them (docs/LLM-JEV-DESIGN.md §9.2 stage 4)" },
  { marker: 'stage 4, src/jev-modes/synth/search/proposal.ts proposeRevert', owner: 'src/jev-modes/synth/search/proposal.ts', why: 'the revert marker is still the goal-text prefix `revert`; a typed member on the proposal is stage 4' },
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

/**
 * F05 / B1 / B2 / B3: S2 does not run on the `jev-on-next` arms, and no copy of the tree may say it does.
 *
 * `armMechanisms` clamps `s2` to `'off'` outside the `llm-jev` sample path, so the claim is false in three
 * separate registers and each was written by a different hand: a type's JSDoc ("the S2 generation mechanisms
 * on"), a confound list ("tuned generation + S2 + routers + the fast path") and a shipping instruction
 * ("ship S2 + routers alone", which after F05 authorises shipping a mechanism no arm measured). The phrases
 * are pinned literally because that is how they spread — by copy, not by call.
 */
describe('source hygiene: the S2 claim F05 removed stays removed (B1/B2/B3)', () => {
  const BANNED: readonly { re: RegExp; why: string }[] = [
    { re: /S2 generation mechanisms on/, why: 'the next arms run `jev-on`, where no S2 mechanism is reachable (F05)' },
    { re: /S2 \+ routers/, why: 'no arm in the plan measures S2, so "ship S2 + routers" ships an unmeasured mechanism (B3)' },
    { re: /generation \+ S2/, why: 'S2 is not one of the mechanisms a jev-on-next win confounds (B1)' },
    { re: /\+ S2 \+/, why: 'S2 is not one of the mechanisms a jev-on-next win confounds (B1/B2)' },
  ];

  it('no file under src/ and no line of docs/LLM-LOOP-DESIGN.md claims S2 is on these arms', () => {
    const scanned = [...walk(join(ROOT, 'src')), join(ROOT, 'docs/LLM-LOOP-DESIGN.md')];
    const hits: string[] = [];
    for (const f of scanned) {
      const lines = readFileSync(f, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        for (const b of BANNED) if (b.re.test(lines[i]!)) hits.push(`${relative(ROOT, f)}:${i + 1} — ${b.why}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the BenchCondition declaration agrees with armMechanisms, which is the reader\'s first stop', () => {
    const types = readFileSync(join(ROOT, 'src/core/types.ts'), 'utf8');
    const at = types.indexOf("export type BenchCondition = ");
    expect(at).toBeGreaterThan(0);
    const doc = types.slice(Math.max(0, at - 1400), at);
    expect(doc).toContain('contract 1.9 (Fastlane)');
    // the positive claim the block must carry instead of the struck one: where S2 actually lives, and who owns wiring it
    expect(doc).toContain('F17');
    expect(doc).toMatch(/tuned generation parameters/);
  });
});
