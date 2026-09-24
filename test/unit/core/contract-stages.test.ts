/**
 * The stage guard (docs/ORCHESTRATION-DESIGN.md §8.2 D0 item 6, [G14] [D3], measurement M11).
 *
 * Four tables, each with its OWN explicit exclusion set, because the naive "every `StageName` appears in all five
 * TUI stage tables" is false at HEAD and cannot be made true (`TIMELINE_STAGES` deliberately omits `replan` and
 * `complete`; `defaultTab` is a two-condition expression nothing can "appear in"; `/why`'s registry row takes a
 * free-form `rest` argument, so there is no fifth table). Dropping a stage from any of the four, or adding a
 * `StageName` that reaches none of them, fails here instead of silently breaking `/why`, Ctrl+O, the status line
 * or the timeline strip — for the one decision that spawns three processes and holds real money.
 *
 * | table                                          | rule                                                             |
 * | `STAGES` (src/tui/why.ts:56)                   | ⊇ every `StageName`; exclusion set empty                         |
 * | `stepWhyBlocks`'s `order` (src/tui/why.ts:259) | EQUALS every `StageName`, in loop order; exclusion set empty     |
 * | `STEP_WORDS` (src/tui/status/lines.ts:159)     | ⊇ every `StageName`; exclusion set empty                         |
 * | `TIMELINE_STAGES` (src/tui/pane/timeline.ts:17)| its stages + `TIMELINE_EXCLUDED_STAGES` partition `StageName`    |
 *
 * Three of the four tables are module-private `const`s and `src/tui/**` is not this wave's to edit, so this file
 * READS THEIR SOURCE TEXT and parses the arrays out with a regex anchored on the declaration name. A changed
 * declaration shape throws with the file, the label and the regex, rather than silently asserting nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StageName } from '../../../src/core/types.js';
import { TIMELINE_EXCLUDED_STAGES, TIMELINE_STAGES } from '../../../src/tui/pane/timeline.js';

const ROOT = join(import.meta.dirname, '../../..');

/**
 * The runtime twin of `StageName`, in LOOP order (`decompose` runs before `replan`/`intent`, §8.2 D1 item 15).
 * `STAGE_TWIN` is the compile-time half: adding a member to `StageName` without adding it here is a tsc error,
 * and `ALL_STAGES` is checked against its keys below, so the list can never quietly fall behind the union.
 */
const STAGE_TWIN: Record<StageName, true> = {
  decompose: true,
  replan: true,
  intent: true,
  context: true,
  propose: true,
  risk: true,
  coordinate: true,
  execute: true,
  judge: true,
  complete: true,
  loop: true,
};
const ALL_STAGES: readonly StageName[] = ['decompose', 'replan', 'intent', 'context', 'propose', 'risk', 'coordinate', 'execute', 'judge', 'complete', 'loop'];

/**
 * docs/AGENT-LOOP-DESIGN.md §9.2 (slice S1): `loop` is a `StageName` — the stage of the agent's RA1/RA2 quick asks
 * (`jev:request` / `decision` rows), appended LAST above because it is agent-only and has no fixed place in the legacy loop
 * order. The four tables below live in `src/tui/**`, which the contract slice may not edit, so the TUI owes the one-word
 * additions, exactly as it did for `coordinate`: `'loop'` into `src/tui/why.ts` STAGES (:56) and `stepWhyBlocks`' order
 * array (where the agent's decisions should sort), into `src/tui/status/lines.ts` STEP_WORDS (:159), and a letter into
 * `src/tui/pane/timeline.ts` TIMELINE_STAGES (or `'loop'` into the exported TIMELINE_EXCLUDED_STAGES).
 * DELETE THIS CONSTANT (and this comment) in the same commit that adds the word — the guard then bites for real.
 */
const PENDING_TUI_STAGES = ['loop'] as const;
const pending: ReadonlySet<string> = new Set<string>(PENDING_TUI_STAGES);

/** Every `StageName` a table is held to: the union minus the words still owed, minus that table's explicit exclusion set. */
const expectedStages = (excluded: readonly StageName[] = []): StageName[] => ALL_STAGES.filter((s) => !pending.has(s) && !excluded.includes(s));

/** Read one file of `src/tui/**` once; these are sources, not modules, because the three tables are not exported. */
function source(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

/**
 * Pull the single-quoted strings out of the array literal `re` captures in group 1. The regex is anchored on the
 * declaration NAME so a moved declaration is still found; a changed SHAPE throws with everything needed to fix it.
 */
function parseStringList(file: string, label: string, re: RegExp): string[] {
  const text = source(file);
  const m = re.exec(text);
  const inner = m?.[1];
  if (inner === undefined) {
    throw new Error(`${file}: could not parse ${label} with ${String(re)} — the declaration's shape changed. Update this regex in the same commit, or the stage guard asserts nothing.`);
  }
  const items = [...inner.matchAll(/'([^']*)'/g)].map((x) => x[1] ?? '');
  if (items.length === 0) throw new Error(`${file}: ${label} parsed as an EMPTY list — the declaration's shape changed`);
  return items;
}

/** `const STAGES: ReadonlySet<string> = new Set<StageName>([ … ]);` — src/tui/why.ts:56 */
const STAGES_RE = /const STAGES\s*:[^=]*=\s*new Set<StageName>\(\[([^\]]*)\]\)/;
/** `const order: readonly StageName[] = [ … ];` inside `stepWhyBlocks` — src/tui/why.ts:259 */
const ORDER_RE = /const order\s*:\s*readonly StageName\[\]\s*=\s*\[([^\]]*)\]/;
/** `const STEP_WORDS: readonly string[] = [ … ];` — src/tui/status/lines.ts:159 */
const STEP_WORDS_RE = /const STEP_WORDS\s*:[^=]*=\s*\[([^\]]*)\]/;

// The exclusion sets [D3] requires, named and asserted rather than left implicit.
const STAGES_EXCLUDED: readonly StageName[] = [];
const ORDER_EXCLUDED: readonly StageName[] = [];
const STEP_WORDS_EXCLUDED: readonly StageName[] = [];

describe('the stage guard [G14] [D3] — four tables, four explicit exclusion sets', () => {
  it('ALL_STAGES is the runtime twin of StageName (the Record above is the compile-time half)', () => {
    expect(ALL_STAGES.length).toBe(Object.keys(STAGE_TWIN).length);
    expect([...ALL_STAGES].sort()).toEqual(Object.keys(STAGE_TWIN).sort());
    expect(new Set(ALL_STAGES).size).toBe(ALL_STAGES.length);
    // every word the allow-list forgives must still be a real stage, or the allow-list has outlived its comment
    for (const s of PENDING_TUI_STAGES) expect(ALL_STAGES).toContain(s);
  });

  it('STAGES (src/tui/why.ts:56) covers every StageName; its exclusion set is empty', () => {
    const stages = parseStringList('src/tui/why.ts', 'STAGES', STAGES_RE);
    expect(STAGES_EXCLUDED).toEqual([]);
    const missing = expectedStages(STAGES_EXCLUDED).filter((s) => !stages.includes(s));
    expect(missing).toEqual([]);
    // it holds nothing that is not a stage either, so `parseWhyRef` cannot accept a word the engine never emits
    expect(stages.filter((s) => !ALL_STAGES.includes(s as StageName))).toEqual([]);
  });

  it("stepWhyBlocks' order array (src/tui/why.ts:259) EQUALS every StageName in loop order; its exclusion set is empty", () => {
    const order = parseStringList('src/tui/why.ts', "stepWhyBlocks' order array", ORDER_RE);
    expect(ORDER_EXCLUDED).toEqual([]);
    expect(order).toEqual(expectedStages(ORDER_EXCLUDED));
  });

  it('STEP_WORDS (src/tui/status/lines.ts:159) covers every StageName; its exclusion set is empty', () => {
    const words = parseStringList('src/tui/status/lines.ts', 'STEP_WORDS', STEP_WORDS_RE);
    expect(STEP_WORDS_EXCLUDED).toEqual([]);
    const missing = expectedStages(STEP_WORDS_EXCLUDED).filter((s) => !words.includes(s));
    expect(missing).toEqual([]);
    expect(words.filter((s) => !ALL_STAGES.includes(s as StageName))).toEqual([]);
  });

  it('TIMELINE_STAGES plus TIMELINE_EXCLUDED_STAGES partition StageName exactly (TIMELINE_EXCLUDED_STAGES is the exported half)', () => {
    const strip = TIMELINE_STAGES.map((t) => t.stage);
    expect(new Set(strip).size).toBe(strip.length);
    expect(strip.filter((s) => !ALL_STAGES.includes(s))).toEqual([]);
    // the partition: nothing is in both halves, and together they are every StageName
    const impliedExcluded = ALL_STAGES.filter((s) => !strip.includes(s));
    expect(strip.filter((s) => impliedExcluded.includes(s))).toEqual([]);
    expect([...strip, ...impliedExcluded].sort()).toEqual([...ALL_STAGES].sort());
    // and the excluded half is exactly the exported, documented choice plus the words the TUI still owes — a
    // DIFFERENT stage going missing fails here
    expect(impliedExcluded.filter((s) => !pending.has(s))).toEqual([...TIMELINE_EXCLUDED_STAGES]);
    expect([...TIMELINE_EXCLUDED_STAGES]).toEqual(['replan', 'complete']);
    // the strip letters `decompose` as `D` (ORCHESTRATION-DESIGN §8.3 row 52)
    expect(TIMELINE_STAGES.find((x) => x.stage === 'decompose')?.letter).toBe('D');
    // and `coordinate` as `O` (COORDINATION-DESIGN §4.2), between R and X in loop order
    expect(TIMELINE_STAGES.map((x) => x.letter).join('')).toBe('DICPROXJ');
    // one letter per lettered stage, all distinct (the strip is read by letter)
    expect(new Set(TIMELINE_STAGES.map((t) => t.letter)).size).toBe(TIMELINE_STAGES.length);
  });
});
