/**
 * TUI-DESIGN-5 §10 (R5-3) — the context meter's render path.
 *
 * What this file pins, row by row: `ctxText` over 200 random `ContextUsage` values against the harness's own
 * `formatMeter` (the TUI adds the glyph substitution and nothing else, §13.1); the three distinct empty states of
 * §7 rows 35–37 and their `--ascii` twins; the amber/red crossing firing at most once per threshold per process
 * over a 500-tick walk, with the highest crossed threshold always announced; a resume above an already-crossed
 * threshold re-announcing (§7 row 98); `/context`'s block at 40/80/84/120 with the three-source join, all five
 * `formatBudget` arms and the `outputEvicted` pointer that must not be printed again; the per-file table keeping
 * its reason column at the 80- and 100-column rungs against a 61-cell path (§3.7, §3.1.5); and `/compact`'s four
 * answers plus the run-ended fifth, `off` first (§3.3, §7 row 42a, §14.2 #15).
 */
import { describe, expect, it } from 'vitest';
import {
  COMPACTION_OFF,
  COMPACTION_RULE_CAPTION,
  COMPACTION_RULE_MIN_COLUMNS,
  COMPACT_RUN_ENDED,
  CONTEXT_ACTION,
  CONTEXT_FULL_COLUMNS,
  CONTEXT_MIN_COLUMNS,
  CONTEXT_NO_PROMPT,
  CONTEXT_NO_RUN,
  CONTEXT_THRESHOLDS,
  FILE_PATH_MIN_CELLS,
  NOTHING_TO_COMPACT,
  SUMMARY_EXCERPT_MAX,
  compactAnswer,
  compactionNoticeRows,
  compactionRule,
  contextBlock,
  contextHead,
  contextNoRelaxed,
  contextWarnLine,
  crossedContextThresholds,
  ctxText,
  fileReason,
  filesInViewText,
  nextContextWarn,
  outputsEvictedText,
  outputsOnDiskText,
  summaryExcerptText,
  type ContextBlockInput,
  type ContextPct,
} from '../../../../src/tui/context/lines.js';
import { BLOCK_LOG_MAX, blockTexts, blockWidth, type BlockRow } from '../../../../src/tui/block/lines.js';
import { GLYPHS } from '../../../../src/tui/glyphs.js';
import { METER_AMBER_PCT, METER_RED_PCT } from '../../../../src/core/limits.js';
import { computeContextUsage, formatBudget, formatMemory, formatMeter, formatRecentSteps, meterLevel } from '../../../../src/loop/context/meter.js';
import { OUTPUT_EVICTED, parseOutputRef } from '../../../../src/loop/context/history.js';
import type { ContextSummary } from '../../../../src/loop/context/types.js';
import type { ContextUsage, FileCacheEntry, FileMemory, HistoryEntry } from '../../../../src/core/types.js';

// A deterministic generator, so a failure is reproducible from the seed alone (never Math.random in a property test).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function usage(o: Partial<Parameters<typeof computeContextUsage>[0]> = {}): ContextUsage {
  return computeContextUsage({
    promptChars: 41_000,
    budgetChars: 70_000,
    files: 6,
    historyEntries: 12,
    summaryAt: 8,
    lastCompactionStep: 8,
    compactions: 3,
    lastCompactionAt: '2026-09-22T14:02:09.000Z',
    compaction: 'code',
    promptBuildMs: 41,
    refreshMs: 6,
    recentSteps: { chars: 71_000, allowanceChars: 71_000, whole: 2, clipped: 4, oneLine: 6, reads: 3 },
    ...o,
  });
}

/** A usage whose `pct` is exactly `pct` — `pct = round(100 × tokensInWindow / budgetTokens)`, so scale the chars. */
function usageAtPct(pct: number, o: Partial<Parameters<typeof computeContextUsage>[0]> = {}): ContextUsage {
  const budgetChars = 100_000;
  return usage({ budgetChars, promptChars: Math.round((budgetChars * pct) / 100), ...o });
}

const historyEntry = (step: number, o: Partial<HistoryEntry> = {}): HistoryEntry => ({
  step,
  intent: 'edit',
  action: `edit src/f${step}.ts`,
  outcome: 'executed',
  shownFiles: [],
  notes: [],
  ...o,
});

describe('§3.1 the `ctx` status cell — two rungs, the word, the glyph (D-AG, §12 S45/S46, §7 row 40)', () => {
  it('over 200 random usages the full rung IS `formatMeter` with the separator substituted, and no ascii frame ever sees a `·`', () => {
    const rnd = mulberry32(0x5e3d1);
    let ok = 0;
    let turned = 0;
    for (let i = 0; i < 200; i++) {
      const budgetChars = 1_000 + Math.floor(rnd() * 400_000);
      const u = usage({
        budgetChars,
        promptChars: Math.floor(rnd() * budgetChars * 1.3),
        files: Math.floor(rnd() * 17),
        historyEntries: Math.floor(rnd() * 40),
      });
      const wide = ctxText(u, 120);
      const wideAscii = ctxText(u, 120, GLYPHS.ascii);
      const short = ctxText(u, CONTEXT_MIN_COLUMNS);
      if (meterLevel(u.pct) === 'ok') {
        ok += 1;
        // §13.1: the harness's own function is the single source of truth for the text; the TUI adds the glyph only
        expect(wide).toBe(formatMeter(u));
        expect(wideAscii).toBe(formatMeter(u).replaceAll(' · ', ' - '));
        // §3.1: the short rung is built from `u.pct` DIRECTLY, never by truncating the long form
        expect(short).toBe(`ctx ${u.pct}%`);
      } else {
        turned += 1;
        // §12 S46 / §14.2 #57: amber and red REPLACE the cell at BOTH rungs — the counts are not the point at 87 %
        const word = u.pct >= METER_RED_PCT ? 'red' : 'amber';
        expect(wide).toBe(`ctx ${u.pct}% ${word} · ${CONTEXT_ACTION}`);
        expect(short).toBe(wide);
        expect(wide).not.toContain('files');
      }
      expect(wideAscii).not.toContain('·');
      expect(ctxText(u, CONTEXT_MIN_COLUMNS, GLYPHS.ascii)).not.toContain('·');
      // absent is absent below the short rung: no placeholder, no `ctx —%` (§7 row 35)
      expect(ctxText(u, CONTEXT_MIN_COLUMNS - 1)).toBe('');
      expect(ctxText(u, 40)).toBe('');
    }
    expect(ok).toBeGreaterThan(20);
    expect(turned).toBeGreaterThan(20);
  });

  it('the short rung fits at 80 beside the run meter, and the full rung is the long form only from 100', () => {
    const u = usageAtPct(41, { files: 6, historyEntries: 12 });
    expect(ctxText(u, 80)).toBe('ctx 41%');
    expect(ctxText(u, CONTEXT_FULL_COLUMNS - 1)).toBe('ctx 41%');
    expect(ctxText(u, CONTEXT_FULL_COLUMNS)).toBe('ctx 41% · 6 files · 12 steps');
    // §3.1: 7 cells at the short rung, 28 at the full one — the numbers the two rungs were chosen for
    expect(ctxText(u, 80)).toHaveLength(7);
    expect(ctxText(u, 120)).toHaveLength(28);
    // §12 S46's own pin, at both rungs
    expect(ctxText(usageAtPct(87), 80)).toBe('ctx 87% amber · /compact now');
    expect(ctxText(usageAtPct(96), 120)).toBe('ctx 96% red · /compact now');
    expect(ctxText(usageAtPct(87), 80, GLYPHS.ascii)).toBe('ctx 87% amber - /compact now');
    // §3.1's own claim about the amber cell's size: it still fits the 80-column right zone
    expect(ctxText(usageAtPct(87), 80)).toHaveLength(28);
  });

  it('the thresholds are the harness’s own, so the word and the number can never disagree', () => {
    expect(CONTEXT_THRESHOLDS).toEqual([85, 95]);
    expect([METER_AMBER_PCT, METER_RED_PCT]).toEqual([...CONTEXT_THRESHOLDS]);
    expect(crossedContextThresholds(84)).toEqual([]);
    expect(crossedContextThresholds(85)).toEqual([85]);
    expect(crossedContextThresholds(200)).toEqual([85, 95]);
    expect(crossedContextThresholds(Number.NaN)).toEqual([]);
  });
});

describe('§3.1 / §7 rows 41 and 98 — one notice per threshold per PROCESS, highest wins', () => {
  /**
   * §14.2 review finding 4: `nextContextWarn` mirrors `nextBudgetWarn` ("the highest only when one add crosses
   * two"), so "exactly once per threshold" is NOT the contract and a walk that jumps 84 → 96 never fires amber.
   * The invariant asserted here is the one the code can satisfy — at most once each, highest always announced —
   * and it is checked over 2,000 seeds rather than the one that happened to pass.
   */
  it('over 2,000 seeded 500-tick walks: at most one notice per threshold, always ascending, and the highest crossing always announces', () => {
    let sawDoubleJump = 0;
    for (let seed = 1; seed <= 2_000; seed++) {
      const rnd = mulberry32(seed);
      let announced: ReadonlySet<ContextPct> = new Set<ContextPct>();
      const fired: ContextPct[] = [];
      let pct = 0;
      let sawAmber = false;
      let sawRed = false;
      let firstCrossingWasDouble = false;
      for (let tick = 0; tick < 500; tick++) {
        // a random walk with compactions: pct falls back under the line and must NOT re-announce (the set is the arming state)
        const previous = pct;
        pct = Math.max(0, Math.min(100, pct + Math.round((rnd() - 0.42) * 25)));
        if (!sawAmber && !sawRed && previous < METER_AMBER_PCT && pct >= METER_RED_PCT) firstCrossingWasDouble = true;
        if (pct >= METER_AMBER_PCT) sawAmber = true;
        if (pct >= METER_RED_PCT) sawRed = true;
        const step = nextContextWarn(pct, announced);
        announced = step.announced;
        if (step.warn !== null) fired.push(step.warn.pct);
      }
      // at most once per threshold, ever
      expect(fired.filter((p) => p === 85).length, `seed ${seed}`).toBeLessThanOrEqual(1);
      expect(fired.filter((p) => p === 95).length, `seed ${seed}`).toBeLessThanOrEqual(1);
      // the highest threshold the walk ever reached is always announced
      if (sawRed) expect(fired, `seed ${seed}`).toContain(95);
      else if (sawAmber) expect(fired, `seed ${seed}`).toContain(85);
      else expect(fired, `seed ${seed}`).toHaveLength(0);
      // amber is skipped exactly when one tick crossed both: the double jump is the ONLY way to miss it
      if (sawAmber && !fired.includes(85)) {
        sawDoubleJump += 1;
        expect(firstCrossingWasDouble, `seed ${seed}`).toBe(true);
      }
      // ascending: 95 is never announced before 85
      expect([...fired], `seed ${seed}`).toEqual([...fired].sort((a, b) => a - b));
      // the arming set never shrinks and never holds a threshold the walk did not reach
      if (!sawAmber) expect([...announced]).toEqual([]);
    }
    // the case is not hypothetical — it is the majority behaviour of this walk, which is why the old assertion was luck
    expect(sawDoubleJump).toBeGreaterThan(0);
  });

  it('one tick that crosses both announces the HIGHER only, and both are then armed', () => {
    const step = nextContextWarn(97, new Set<ContextPct>());
    expect(step.warn?.pct).toBe(95);
    expect([...step.announced]).toEqual([85, 95]);
    expect(nextContextWarn(99, step.announced).warn).toBeNull();
    // and the amber sentence NEVER arrives for that run — the documented consequence of highest-wins
    expect(nextContextWarn(86, step.announced).warn).toBeNull();
  });

  it('a tick-by-tick climb announces each threshold once, in order', () => {
    let announced: ReadonlySet<ContextPct> = new Set<ContextPct>();
    const fired: ContextPct[] = [];
    for (const pct of [10, 50, 84, 85, 90, 94, 95, 99, 40, 96]) {
      const step = nextContextWarn(pct, announced);
      announced = step.announced;
      if (step.warn !== null) fired.push(step.warn.pct);
    }
    expect(fired).toEqual([85, 95]);
  });

  it('§7 row 98: a resume above an already-crossed threshold re-announces — the set is per process and never persisted', () => {
    // the process starts with an EMPTY set; `compactions` counts over the run’s whole life, all resumes
    const resumed = nextContextWarn(90, new Set<ContextPct>());
    expect(resumed.warn).toEqual({ pct: 85, text: contextWarnLine(85) });
    expect(resumed.warn?.text).toBe('context at 85 % of the budget (amber) — /compact folds the history now');
  });

  it('§12 S47: the notice names the level word and the action, and folds for --ascii', () => {
    expect(contextWarnLine(85)).toBe('context at 85 % of the budget (amber) — /compact folds the history now');
    expect(contextWarnLine(95)).toBe('context at 95 % of the budget (red) — /compact folds the history now');
    expect(contextWarnLine(85, GLYPHS.ascii)).toBe('context at 85 % of the budget (amber) - /compact folds the history now');
    expect(contextWarnLine(95, GLYPHS.ascii)).not.toContain('—');
  });

  it('§15.1 Q16: a `context:warn` event and the status tick share ONE set, so a crossing can never notice twice', () => {
    let announced: ReadonlySet<ContextPct> = new Set<ContextPct>();
    const onEvent = nextContextWarn(87, announced); // the harness event arrives first
    announced = onEvent.announced;
    const onTick = nextContextWarn(87, announced); // the status tick that follows it
    expect(onEvent.warn).not.toBeNull();
    expect(onTick.warn).toBeNull();
  });
});

describe('§3.2 / §7 rows 35–37 — three distinct empty states, not one', () => {
  const base: ContextBlockInput = { mode: 'llm-jev', live: true };
  const textsOf = (rows: readonly BlockRow[], columns = 120): string[] => blockTexts(rows, blockWidth(columns));

  it('no run is live (§7 row 36)', () => {
    const b = contextBlock({ ...base, live: false }, 120);
    expect(b.head).toBe('context');
    expect(textsOf(b.rows)).toEqual([CONTEXT_NO_RUN]);
    expect(CONTEXT_NO_RUN).toBe("no run is live — /context reports the run's prompt budget");
  });

  it('a mode that builds no relaxed context names the ESCAPE (§7 row 35, §12 S58, §14.2 #4)', () => {
    const b = contextBlock({ ...base, usage: null }, 120);
    expect(textsOf(b.rows)).toEqual(['this run does not build a relaxed context (llm-jev) — /mode jev-on builds one']);
    // the DEFAULT mode is the one a fresh install lands in, which is why the sentence must not merely say `empty`
    expect(contextNoRelaxed('llm-jev')).toContain('/mode jev-on builds one');
    expect(contextNoRelaxed('jev-only')).toBe('this run does not build a relaxed context (jev-only) — /mode jev-on builds one');
  });

  it('before the first prompt (§7 row 37)', () => {
    const b = contextBlock({ ...base, usage: usage({ promptChars: 0, summaryAt: null, compactions: 0, lastCompactionAt: null }) }, 120);
    expect(textsOf(b.rows)).toEqual([CONTEXT_NO_PROMPT]);
    expect(CONTEXT_NO_PROMPT).toBe('no prompt built yet — /context fills in at the first step');
  });

  it('the three sentences are distinct — one state can never be mistaken for another', () => {
    const three = new Set([CONTEXT_NO_RUN, contextNoRelaxed('llm-jev'), CONTEXT_NO_PROMPT]);
    expect(three.size).toBe(3);
  });

  /** §13.4: a two-glyph-set self-test per §12 string — the em dashes of S54/S56/S58 leaked into `--ascii` frames. */
  it('§13.4: all three empty states carry their `--ascii` twin, em dash included', () => {
    const ascii = (i: ContextBlockInput): string[] => blockTexts(contextBlock(i, 120, GLYPHS.ascii).rows, blockWidth(120), GLYPHS.ascii);
    expect(ascii({ ...base, live: false })).toEqual(["no run is live - /context reports the run's prompt budget"]);
    expect(ascii({ ...base, usage: null })).toEqual(['this run does not build a relaxed context (llm-jev) - /mode jev-on builds one']);
    expect(ascii({ ...base, usage: usage({ promptChars: 0, summaryAt: null, compactions: 0, lastCompactionAt: null }) })).toEqual([
      'no prompt built yet - /context fills in at the first step',
    ]);
    for (const i of [{ ...base, live: false }, { ...base, usage: null }, { ...base, usage: usage({ promptChars: 0, summaryAt: null }) }]) {
      for (const line of ascii(i)) {
        expect(line).not.toContain('—');
        expect(line).not.toContain('·');
      }
    }
    expect(contextNoRelaxed('jev-only', GLYPHS.ascii)).toBe('this run does not build a relaxed context (jev-only) - /mode jev-on builds one');
  });

  it('§7 row 37: the LIVE cell still shows `ctx 0%` before the first prompt — deliberately unlike the block', () => {
    expect(ctxText(usage({ promptChars: 0 }), 120)).toBe('ctx 0% · 6 files · 12 steps');
    expect(ctxText(usage({ promptChars: 0 }), 80)).toBe('ctx 0%');
  });
});

describe('§3.2 — `/context`, one block from three reads (D-AH)', () => {
  const files: readonly FileCacheEntry[] = [
    { rel: 'src/loop/engine.ts', pinnedBy: 'read', lastUsedStep: 6, bytesShown: 41_000 },
    { rel: 'src/tui/App.tsx', pinnedBy: 'human', lastUsedStep: 5, bytesShown: 12_000 },
    { rel: 'src/core/types.ts', pinnedBy: 'jev', lastUsedStep: 4, bytesShown: 800 },
  ];
  const fileMemory: FileMemory = {
    'src/loop/engine.ts': { sha12: 'a1b2c3d4e5f6', bytes: 41_000, readAt: 4, editedAt: 6 },
    'src/tui/App.tsx': { sha12: null, bytes: 12_000, readAt: null, editedAt: null },
  };
  const summary: ContextSummary = { v: 1, step: 8, at: '2026-09-22T14:02:09.000Z', by: 'code', sections: { Objective: [], Completed: [], Active: [], Blocked: [], Files: [], Tests: [], Notes: [] }, text: 'x' };
  const input: ContextBlockInput = { usage: usage(), step: 12, mode: 'jev-on', live: true, files, fileMemory, summary };

  it('§12 S48–S53: the head and every body row, verbatim, at 120', () => {
    const b = contextBlock(input, 120);
    expect(b.head).toBe('context · step 12 · relaxed · code compaction');
    const t = blockTexts(b.rows, blockWidth(120));
    // S49 is `formatBudget`'s own output, not the draft's `budget 70k of 128k window (55 %)` (§14.2 #37)
    expect(t[0]).toBe(formatBudget(usage()));
    expect(t[0]).toBe('budget 70k chars of the 128k-token window');
    // S50 is `formatRecentSteps`'s
    expect(t[1]).toBe(formatRecentSteps(usage()));
    expect(t[1]).toBe('recent steps 71k of 71k (2 whole, 4 clipped, 6 one-line)');
    // S51, S52 — S52 is UTC, so the literal is the same on every machine (§14.2 review finding 8)
    expect(t[2]).toBe('prompt build 41 ms · file refresh 6 ms');
    // §12 S51 is WHOLE milliseconds: the engine measures with `performance.now()`, so a real capture carries
    // `826.1` beside `825.65` — two precisions in one row. Rounded in the builder, total over the odd value.
    expect(blockTexts(contextBlock({ ...input, usage: usage({ promptBuildMs: 826.1, refreshMs: 825.65 }) }, 120).rows, blockWidth(120))[2]).toBe('prompt build 826 ms · file refresh 826 ms');
    expect(blockTexts(contextBlock({ ...input, usage: usage({ promptBuildMs: Number.NaN, refreshMs: -3 }) }, 120).rows, blockWidth(120))[2]).toBe('prompt build 0 ms · file refresh 0 ms');
    expect(t[3]).toBe('summary at step 8 · 3 compactions · last 14:02');
    // read 3's own payload, bounded (§14.2 review finding 13)
    expect(t[4]).toBe('summary · x');
    // S53: the count row, then one table row per file with the reason column
    expect(t).toContain('files in view · 6');
    expect(t.some((l) => /src\/loop\/engine\.ts\s+41k\s+read at step 4 · edited step 6/.test(l))).toBe(true);
    expect(t.some((l) => /src\/tui\/App\.tsx\s+12k\s+pinned by you/.test(l))).toBe(true);
    expect(t.some((l) => /src\/core\/types\.ts\s+800\s+pinned by jev/.test(l))).toBe(true);
  });

  /**
   * §14.2 review finding 8: `hhmm` used the LOCAL clock, so §12 S52's pinned `last 14:02` only held in a UTC
   * terminal and one run dir's `transcript.log` read differently on two machines. Asserted without touching
   * `process.env.TZ`: three spellings of the SAME instant, in three offsets, must all print the UTC reading.
   */
  it('S52 reads the instant in UTC, like every other timestamp helper on the tree', () => {
    for (const at of ['2026-09-22T14:02:09.000Z', '2026-09-22T16:02:09.000+02:00', '2026-09-22T07:02:09.000-07:00']) {
      const t = blockTexts(contextBlock({ ...input, usage: usage({ lastCompactionAt: at }) }, 120).rows, blockWidth(120));
      expect(t[3], at).toBe('summary at step 8 \u00b7 3 compactions \u00b7 last 14:02');
    }
    // a string that is not a time is printed back, never `Invalid Date` and never a throw
    const bad = blockTexts(contextBlock({ ...input, usage: usage({ lastCompactionAt: 'whenever' }) }, 120).rows, blockWidth(120));
    expect(bad[3]).toBe('summary at step 8 \u00b7 3 compactions \u00b7 last whenever');
  });

  it('the count comes from `ContextUsage.files`, never from the cache array (a truncated snapshot must not lie)', () => {
    const b = contextBlock({ ...input, usage: usage({ files: 16 }), files: files.slice(0, 1) }, 120);
    expect(blockTexts(b.rows, blockWidth(120))).toContain('files in view · 16');
    expect(filesInViewText(16)).toBe('files in view · 16');
    expect(filesInViewText(16, GLYPHS.ascii)).toBe('files in view - 16');
  });

  it('§3.7: at 40 the file section is the COUNT ONLY; at 80 and 120 the per-file rows are there', () => {
    const narrow = blockTexts(contextBlock(input, 40).rows, blockWidth(40));
    expect(narrow.some((l) => l.includes('files in view'))).toBe(true);
    expect(narrow.some((l) => l.includes('engine.ts'))).toBe(false);
    for (const cols of [CONTEXT_MIN_COLUMNS, 120]) {
      const wide = blockTexts(contextBlock(input, cols).rows, blockWidth(cols));
      expect(wide.some((l) => l.includes('engine.ts'))).toBe(true);
    }
  });

  /**
   * §14.2 review finding 2: `contextBlock`'s second argument is TERMINAL columns, not `bodyWidth()`. Every terminal
   * 80–89 columns wide is inside the rung, and it is the band §3.1 calls "the most common width".
   */
  it('the 80–89 band keeps the per-file table: the argument is terminal columns, never a block width', () => {
    for (let cols = CONTEXT_MIN_COLUMNS; cols <= 89; cols++) {
      const t = blockTexts(contextBlock(input, cols).rows, blockWidth(cols));
      expect(t.some((l) => l.includes('engine.ts')), `${cols} columns`).toBe(true);
    }
    // and one below the rung is empty of file rows, so the boundary is where the design puts it
    const below = blockTexts(contextBlock(input, CONTEXT_MIN_COLUMNS - 1).rows, blockWidth(CONTEXT_MIN_COLUMNS - 1));
    expect(below.some((l) => l.includes('engine.ts'))).toBe(false);
    // the block width at those columns really is the smaller number the hazard was about
    expect([blockWidth(80), blockWidth(84), blockWidth(89), blockWidth(90)]).toEqual([70, 74, 79, 80]);
  });

  /**
   * §3.7 ("header + reasons, paths shortened") and §3.1.5 ("a path elides LEFT"): `layoutTable` shrinks from the
   * RIGHT, so an unbudgeted 61-cell path used to keep all 61 cells and cut the reason to one (§14.2 finding 1).
   */
  it('a 61-cell path never starves the reason column at the 80- or 100-column rung, and elides LEFT', () => {
    const long = 'src/tui/onboarding/components/wizard/steps/ProviderKeyStep.tsx';
    const one: readonly FileCacheEntry[] = [{ rel: long, pinnedBy: 'read', lastUsedStep: 6, bytesShown: 41_000 }];
    const memory: FileMemory = { [long]: { sha12: null, bytes: 41_000, readAt: 4, editedAt: 6 } };
    const reason = 'read at step 4 · edited step 6';
    for (const cols of [80, 84, 100, 120]) {
      const t = blockTexts(contextBlock({ ...input, files: one, fileMemory: memory }, cols).rows, blockWidth(cols));
      const row = t.find((l) => l.includes('41k'));
      expect(row, `${cols} columns`).toBeDefined();
      // the reason survives whole — this is the cell §3.7 says the 80-column rung keeps
      expect(row, `${cols} columns`).toContain(reason);
      // the basename is always intact; the head is elided only where the row cannot hold the whole path
      expect(row, `${cols} columns`).toContain('ProviderKeyStep.tsx');
      expect(row!.startsWith(cols >= 120 ? 'src/tui/' : '…'), `${cols} columns`).toBe(true);
      expect(row!.length).toBeLessThanOrEqual(blockWidth(cols));
    }
    // §3.7's 120 column: `whole` — a 61-cell path and its reason both fit, so nothing is cut at all
    expect(blockTexts(contextBlock({ ...input, files: one, fileMemory: memory }, 120).rows, blockWidth(120)).some((l) => l.startsWith(long))).toBe(true);
    // at 120 the path gets more cells than at 80 — the budget grows with the terminal, it is not a fixed cap
    const at80 = blockTexts(contextBlock({ ...input, files: one, fileMemory: memory }, 80).rows, blockWidth(80)).find((l) => l.includes('41k'))!;
    const at120 = blockTexts(contextBlock({ ...input, files: one, fileMemory: memory }, 120).rows, blockWidth(120)).find((l) => l.includes('41k'))!;
    expect(at120.indexOf('41k')).toBeGreaterThan(at80.indexOf('41k'));
    expect(at80.indexOf('41k')).toBeGreaterThanOrEqual(FILE_PATH_MIN_CELLS);
  });

  it('no row at any width from 1 to 200 is wider than the block it was built for (G-R5-6, from column 1)', () => {
    const long = 'src/tui/onboarding/components/wizard/steps/ProviderKeyStep.tsx';
    const withLong: ContextBlockInput = { ...input, files: [...files, { rel: long, pinnedBy: 'edit', lastUsedStep: 7, bytesShown: 9_000 }] };
    for (let cols = 1; cols <= 200; cols += 1) {
      const w = blockWidth(cols);
      for (const i of [input, withLong]) {
        for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
          for (const line of blockTexts(contextBlock(i, cols, g).rows, w, g)) expect(line.length, `${cols} columns`).toBeLessThanOrEqual(w);
        }
      }
    }
  });

  it('read 3 (`readContextSummary`) answers `summary at step N` on a resume whose engine has not re-read it yet (§7 row 39)', () => {
    const notYetLoaded = usage({ summaryAt: null, lastCompactionAt: null, compactions: 0, promptChars: 0 });
    // with NO summary on disk this is the "before the first prompt" state …
    expect(blockTexts(contextBlock({ ...input, usage: notYetLoaded, summary: null }, 120).rows, blockWidth(120))).toEqual([CONTEXT_NO_PROMPT]);
    // … and with the file present the row is built from the FILE, not from a wait on the engine's lazy re-read
    const t = blockTexts(contextBlock({ ...input, usage: notYetLoaded, summary }, 120).rows, blockWidth(120));
    expect(t.some((l) => l === 'summary at step 8 · 0 compactions · last 14:02')).toBe(true);
  });

  it('read 3’s TEXT is shown, bounded, and the clip is named rather than silent', () => {
    expect(summaryExcerptText('')).toBeNull();
    expect(summaryExcerptText('   \n  ')).toBeNull();
    expect(summaryExcerptText('Objective: ship round 5.\n\nCompleted: the meter.')).toBe('summary · Objective: ship round 5. Completed: the meter.');
    const long = `${'word '.repeat(60)}end`;
    const clipped = summaryExcerptText(long)!;
    expect(clipped.startsWith('summary · word word')).toBe(true);
    expect(clipped).toMatch(/…\s\(\+\d+ chars in context\/summary\.json\)$/);
    expect(clipped).not.toContain('end (');
    // the bound is on the excerpt, not on the row: `summary · ` + at most SUMMARY_EXCERPT_MAX + the notice
    expect(clipped.length).toBeLessThanOrEqual('summary · '.length + SUMMARY_EXCERPT_MAX + 40);
    expect(summaryExcerptText(long, GLYPHS.ascii)!.startsWith('summary - ')).toBe(true);
    // and it reaches the block
    expect(blockTexts(contextBlock({ ...input, summary: { ...summary, text: 'Objective: ship it' } }, 120).rows, blockWidth(120))).toContain('summary · Objective: ship it');
  });

  it('§0.3 item 2 (contract 1.6): the memory row rides `formatMemory`, and is ABSENT on a run that never imported', () => {
    expect(blockTexts(contextBlock(input, 120).rows, blockWidth(120)).some((l) => l.startsWith('memory '))).toBe(false);
    const withMemory = usage({ memory: { indexChars: 512, rulesChars: 1_600, memoryChars: 500, rulesAllowanceChars: 10_000, memoryAllowanceChars: 4_000, rulesMatched: 4, rulesShown: 3, memoryMatched: 2, memoryShown: 1 } });
    const t = blockTexts(contextBlock({ ...input, usage: withMemory }, 120).rows, blockWidth(120));
    expect(t[2]).toBe(formatMemory(withMemory));
    expect(t[2]).toBe('memory 2.1k of 14k · 3 of 4 rules, 1 of 2 notes · index 512');
  });

  it('§7 row 43 sibling: a pointer is printed once, is RESOLVABLE, and is NEVER shown for an entry the 64 MiB bound evicted', () => {
    const history: HistoryEntry[] = [
      historyEntry(4, { outputRef: 'outputs/step-4.txt', fullOutputChars: 9_000 }),
      historyEntry(7, { outputRef: 'outputs/step-7.txt', fullOutputChars: 80_000, outputEvicted: true }),
      historyEntry(9, { outputRef: 'outputs/step-9.txt', fullOutputChars: 5_000 }),
      historyEntry(11),
    ];
    const t = blockTexts(contextBlock({ ...input, history }, 120).rows, blockWidth(120));
    expect(t).toContain('full output on disk · steps 4, 9 — read jevcode:outputs/step-4.txt (one file per step)');
    expect(t).toContain(`1 step: ${OUTPUT_EVICTED}`);
    // the evicted step's own pointer is gone from the block entirely — the whole point of row 43
    expect(t.join('\n')).not.toContain('step-7.txt');
    // CO §8.5: the pointer a user pastes into `read` actually resolves (the `<n>` template did not, finding 9)
    expect(parseOutputRef('jevcode:outputs/step-4.txt')).toBe(4);
    expect(parseOutputRef('jevcode:outputs/step-<n>.txt')).toBeNull();
    expect(outputsOnDiskText([4])).toBe('full output on disk · step 4 — read jevcode:outputs/step-4.txt');
    expect(outputsOnDiskText([4, 9], GLYPHS.ascii)).toBe('full output on disk - steps 4, 9 - read jevcode:outputs/step-4.txt (one file per step)');
    expect(outputsOnDiskText([4, 9], GLYPHS.ascii)).not.toContain('—');
    expect(outputsEvictedText(2)).toBe(`2 steps: ${OUTPUT_EVICTED}`);
    expect(outputsEvictedText(2, GLYPHS.ascii)).toBe(`2 steps: ${OUTPUT_EVICTED}`);
    // neither row is drawn when there is nothing to say
    const none = blockTexts(contextBlock({ ...input, history: [historyEntry(1)] }, 120).rows, blockWidth(120));
    expect(none.some((l) => l.includes('full output on disk') || l.includes(OUTPUT_EVICTED))).toBe(false);
    // and `history` absent is the same as `history: []` — the controller may simply not have it (finding 3)
    expect(blockTexts(contextBlock(input, 120).rows, blockWidth(120)).some((l) => l.includes('full output on disk'))).toBe(false);
  });

  it('the --ascii twin of the whole block carries no unicode separator', () => {
    const history: HistoryEntry[] = [historyEntry(4, { outputRef: 'outputs/step-4.txt', fullOutputChars: 9_000 }), historyEntry(7, { outputRef: 'outputs/step-7.txt', outputEvicted: true })];
    const b = contextBlock({ ...input, history, summary: { ...summary, text: `${'word '.repeat(60)}end` } }, 120, GLYPHS.ascii);
    expect(b.head).toBe('context - step 12 - relaxed - code compaction');
    for (const line of blockTexts(b.rows, blockWidth(120), GLYPHS.ascii)) {
      expect(line).not.toContain('·');
      expect(line).not.toContain('—');
    }
  });

  it('§12 S49: all five `formatBudget` arms reach the block unchanged, the money arm through `limits`', () => {
    const at = (u: ContextUsage, limits?: ContextBlockInput['limits']): string =>
      blockTexts(contextBlock({ ...input, usage: u, ...(limits ? { limits } : {}) }, 120).rows, blockWidth(120))[0]!;
    // 1 — the default arm
    expect(at(usage())).toBe('budget 70k chars of the 128k-token window');
    // 2 — the tiny model window
    const tiny = usage({ budgetChars: 8_000, budget: { chars: 8_000, windowTokens: 4_000, moneyChars: 8_000, boundBy: 'window', usdPerStep: null, windowTooSmall: true } });
    expect(at(tiny)).toBe('budget 8k chars — capped by the 4k-token model window');
    // 3 — the money arm, which needs BOTH `limits` members or `formatBudget` falls through to the default
    const money = usage({ budgetChars: 96_000, budget: { chars: 96_000, windowTokens: 128_000, moneyChars: 96_000, boundBy: 'money', usdPerStep: 0.014, windowTooSmall: false } });
    expect(at(money)).toBe('budget 96k chars of the 128k-token window (est. $0.014 per step)');
    expect(at(money, { maxSteps: 40, spendCapUsd: 2 })).toBe('budget 96k chars — capped by the $2.00 run cap at 40 steps (est. $0.014 per step)');
    // 4, 5 — the floor and the ceiling
    const floor = usage({ budgetChars: 60_000, budget: { chars: 60_000, windowTokens: 128_000, moneyChars: 20_000, boundBy: 'floor', usdPerStep: null, windowTooSmall: false } });
    expect(at(floor)).toBe('budget 60k chars — the floor');
    const ceiling = usage({ budgetChars: 200_000, budget: { chars: 200_000, windowTokens: 400_000, moneyChars: 900_000, boundBy: 'ceiling', usdPerStep: null, windowTooSmall: false } });
    expect(at(ceiling)).toBe('budget 200k chars — the ceiling');
    // every arm folds for --ascii
    expect(blockTexts(contextBlock({ ...input, usage: money, limits: { maxSteps: 40, spendCapUsd: 2 } }, 120, GLYPHS.ascii).rows, blockWidth(120), GLYPHS.ascii)[0]).toBe(
      'budget 96k chars - capped by the $2.00 run cap at 40 steps (est. $0.014 per step)',
    );
  });

  it('the head degrades honestly: no step, and the view word follows the resolved policy', () => {
    expect(contextHead({ usage: usage(), step: null })).toBe('context · relaxed · code compaction');
    expect(contextHead({ usage: usage({ compaction: 'off' }), step: 3, view: 'legacy' })).toBe('context · step 3 · legacy · off compaction');
  });

  it('§12 S53: the reason column joins `fileMemory` and `pinnedBy`, and never renders empty', () => {
    expect(fileReason({ rel: 'a.ts', pinnedBy: 'read', lastUsedStep: 1, bytesShown: 1 }, undefined)).toBe('read');
    expect(fileReason({ rel: 'a.ts', pinnedBy: 'edit', lastUsedStep: 1, bytesShown: 1 }, {})).toBe('edited');
    expect(fileReason({ rel: 'a.ts', pinnedBy: 'seed', lastUsedStep: 1, bytesShown: 1 }, {})).toBe('pinned at the start');
    expect(fileReason({ rel: 'a.ts', pinnedBy: 'human', lastUsedStep: 1, bytesShown: 1 }, { 'a.ts': { sha12: null, bytes: 2, readAt: 2, editedAt: null } })).toBe('read at step 2 · pinned by you');
    // §14.2 review finding 10: a memory clause only implies the pin word when it carries that half
    expect(fileReason({ rel: 'a.ts', pinnedBy: 'edit', lastUsedStep: 1, bytesShown: 1 }, { 'a.ts': { sha12: null, bytes: 2, readAt: 4, editedAt: null } })).toBe('read at step 4 · edited');
    expect(fileReason({ rel: 'a.ts', pinnedBy: 'read', lastUsedStep: 1, bytesShown: 1 }, { 'a.ts': { sha12: null, bytes: 2, readAt: null, editedAt: 6 } })).toBe('edited step 6 · read');
    // … and it does when it does: no duplicate word
    expect(fileReason({ rel: 'a.ts', pinnedBy: 'read', lastUsedStep: 1, bytesShown: 1 }, { 'a.ts': { sha12: null, bytes: 2, readAt: 4, editedAt: 6 } })).toBe('read at step 4 · edited step 6');
    expect(fileReason({ rel: 'a.ts', pinnedBy: 'edit', lastUsedStep: 1, bytesShown: 1 }, { 'a.ts': { sha12: null, bytes: 2, readAt: null, editedAt: 6 } }, GLYPHS.ascii)).toBe('edited step 6');
  });

  /**
   * §13.2 clause 3 / §11's line-identity gate: a `/context` block issued while a run is live writes at most
   * `BLOCK_LOG_MAX = 24` rows into `transcript.log` with a final `… +N more rows`. The cap is applied by
   * `src/cli/session.ts:1513` to the RENDERED rows; this asserts the clause against this surface's own block, which
   * is what "never skipped" means for R5-3 until `r5-identity.test.ts` exists (a request in this slot's report).
   */
  it('§13.2 clause 3: the block is capped at BLOCK_LOG_MAX rows plus a named tail, and both are asserted', () => {
    const many: FileCacheEntry[] = Array.from({ length: 40 }, (_, n) => ({ rel: `src/pkg/file-${n}.ts`, pinnedBy: 'read' as const, lastUsedStep: n, bytesShown: 1_000 + n }));
    const lines = blockTexts(contextBlock({ ...input, usage: usage({ files: many.length }), files: many, fileMemory: {} }, 120).rows, blockWidth(120));
    expect(lines.length).toBeGreaterThan(BLOCK_LOG_MAX);
    // the exact expression `src/cli/session.ts:1513` uses for `annotateBlock`
    const capped = lines.length > BLOCK_LOG_MAX ? [...lines.slice(0, BLOCK_LOG_MAX), `… +${lines.length - BLOCK_LOG_MAX} more rows`] : lines;
    expect(capped).toHaveLength(BLOCK_LOG_MAX + 1);
    expect(capped[BLOCK_LOG_MAX]).toBe(`… +${lines.length - BLOCK_LOG_MAX} more rows`);
    expect(capped[BLOCK_LOG_MAX]).toMatch(/^… \+\d+ more rows$/);
    // the cap never eats the head rows: S49 and the count row are inside it
    expect(capped[0]).toBe('budget 70k chars of the 128k-token window');
    expect(capped.some((l) => l === 'files in view · 40')).toBe(true);
  });

  it('the byte column spells `41k` exactly as `meter.ts` does, so two columns of one block can never drift', () => {
    // §14.2 review finding 14: the private `k()` is a second copy of `meter.ts`'s. Until §8.2 asks the harness to
    // export it, this pins the two spellings against each other for the numbers the block actually prints.
    for (const n of [0, 1, 999, 1_000, 1_500, 41_000, 800, 71_000]) {
      const mine = blockTexts(
        contextBlock({ ...input, usage: usage({ files: 1 }), files: [{ rel: 'a.ts', pinnedBy: 'seed', lastUsedStep: 1, bytesShown: n }], fileMemory: {} }, 120).rows,
        blockWidth(120),
      ).find((l) => l.startsWith('a.ts'))!;
      const theirs = formatRecentSteps(usage({ recentSteps: { chars: n, allowanceChars: n, whole: 0, clipped: 0, oneLine: 0, reads: 0 } })).split(' ')[2]!;
      expect(mine.split(/\s+/)[1], `${n}`).toBe(theirs);
    }
  });
});

describe('§3.4 — the `─ compaction ─` rule decorates, never replaces (D-AJ)', () => {
  it('is drawn from 80 TERMINAL columns and not below, and its caption is the only text it adds', () => {
    expect(compactionRule(40)).toEqual([]);
    expect(compactionRule(COMPACTION_RULE_MIN_COLUMNS - 1)).toEqual([]);
    expect(compactionRule(80)).toEqual([{ kind: 'rule', caption: COMPACTION_RULE_CAPTION }]);
    expect(blockTexts(compactionRule(120), blockWidth(120))).toEqual(['╶──── compaction']);
    expect(blockTexts(compactionRule(120), blockWidth(120), GLYPHS.ascii)).toEqual(['----- compaction']);
  });

  /**
   * §14.2 review finding 6: §3.4's whole TUI contribution is the rule ABOVE the engine's notice, so the composition
   * is a named function with a consumer test rather than a builder nobody calls. `notice` is `engine.ts:3567`'s own
   * line and passes through byte-for-byte — D-AJ's rule is "decorate, never replace".
   */
  it('`compactionNoticeRows` puts the rule above the engine’s own line and changes not one byte of it', () => {
    const notice = 'compaction: 41230 → 12840 prompt chars (code); 4 steps folded into the summary at step 8 (every 8 steps)';
    const wide = blockTexts(compactionNoticeRows(notice, 120), blockWidth(120));
    expect(wide[0]).toBe('╶──── compaction');
    expect(wide.slice(1).join('')).toContain('compaction: 41230');
    expect(wide.slice(1).join(' ')).toContain('(every 8 steps)');
    // below the rung the notice is alone — the decoration is optional, the line is not
    const narrow = blockTexts(compactionNoticeRows(notice, 40), blockWidth(40));
    expect(narrow[0]!.startsWith('compaction: 41230')).toBe(true);
    expect(narrow.some((l) => l.includes('compaction') && l.includes('╶'))).toBe(false);
  });
});

describe('§3.3 — `/compact`’s answers, with `off` checked FIRST (§7 row 42a, §14.2 #15)', () => {
  it('the `off` branch answers S58a and NEVER `nothing to compact`', () => {
    const off = usage({ compaction: 'off' });
    // `Engine.compact()` returns immediately under `off`: no status emit, so before and after are the same object
    const answer = compactAnswer(off, off, 'jev-on');
    expect(answer).toBe(COMPACTION_OFF);
    expect(answer).not.toBe(NOTHING_TO_COMPACT);
    expect(answer).toBe('compaction is off for this run (context.compaction) — jevcode config set context.compaction code turns it on');
    // forty foldable steps under `off` still answer S58a — this is exactly the falsehood the fourth row exists to stop
    expect(compactAnswer(usage({ compaction: 'off', historyEntries: 40 }), usage({ compaction: 'off', historyEntries: 40 }), 'jev-on')).toBe(COMPACTION_OFF);
    // `off` wins over a vanished `after`, too: the reason the call did nothing is the setting, not the run ending
    expect(compactAnswer(off, null, 'jev-on')).toBe(COMPACTION_OFF);
  });

  it('the count rose: SAY NOTHING — the engine’s own notice already reported it in all three sinks (D-AJ, S59)', () => {
    expect(compactAnswer(usage({ compactions: 3 }), usage({ compactions: 4 }), 'jev-on')).toBeNull();
  });

  it('the count did not rise with compaction ON: S57', () => {
    expect(compactAnswer(usage({ compactions: 3 }), usage({ compactions: 3 }), 'jev-on')).toBe(NOTHING_TO_COMPACT);
    expect(NOTHING_TO_COMPACT).toBe('nothing to compact — only the newest step is in history');
  });

  /** §14.2 review finding 11: `Engine.compact()`'s `isFinished()` guard returns with no emit, exactly like `off`. */
  it('the context vanished across the call: the run ended — never `nothing to compact`, which would be a falsehood', () => {
    expect(compactAnswer(usage({ compactions: 3, historyEntries: 40 }), null, 'jev-on')).toBe(COMPACT_RUN_ENDED);
    expect(compactAnswer(usage(), undefined, 'jev-on')).toBe(COMPACT_RUN_ENDED);
    expect(COMPACT_RUN_ENDED).toBe('the run is no longer live — /compact needs a live run');
    // the second clause is `availabilityError`'s own `'live'` sentence, so the user reads one vocabulary
    expect(COMPACT_RUN_ENDED.endsWith('/compact needs a live run')).toBe(true);
    expect(compactAnswer(usage(), null, 'jev-on')).not.toBe(NOTHING_TO_COMPACT);
  });

  it('no context at all: the same sentence `/context` gives, naming the mode and the escape', () => {
    expect(compactAnswer(null, null, 'llm-jev')).toBe(contextNoRelaxed('llm-jev'));
    expect(compactAnswer(undefined, undefined, 'jev-only')).toBe(contextNoRelaxed('jev-only'));
    // and an `after` alone is still an answer: the run gained a context during the call
    expect(compactAnswer(null, usage({ compactions: 3 }), 'jev-on')).toBe(NOTHING_TO_COMPACT);
  });

  it('the answers are distinct strings, and every one of them has an `--ascii` twin (§13.4)', () => {
    expect(new Set([COMPACTION_OFF, NOTHING_TO_COMPACT, COMPACT_RUN_ENDED, contextNoRelaxed('llm-jev')]).size).toBe(4);
    const off = usage({ compaction: 'off' });
    const answers = [
      compactAnswer(off, off, 'jev-on', GLYPHS.ascii),
      compactAnswer(usage(), usage(), 'jev-on', GLYPHS.ascii),
      compactAnswer(usage(), null, 'jev-on', GLYPHS.ascii),
      compactAnswer(null, null, 'llm-jev', GLYPHS.ascii),
    ];
    expect(answers).toEqual([
      'compaction is off for this run (context.compaction) - jevcode config set context.compaction code turns it on',
      'nothing to compact - only the newest step is in history',
      'the run is no longer live - /compact needs a live run',
      'this run does not build a relaxed context (llm-jev) - /mode jev-on builds one',
    ]);
    for (const a of answers) expect(a).not.toContain('—');
    // the unicode default is unchanged — the parameter is additive
    expect(compactAnswer(off, off, 'jev-on')).toBe(COMPACTION_OFF);
  });
});
