/**
 * Deterministic compaction (docs/COORDINATION-DESIGN.md §8.6) and the meter (§8.7, §12.0.3): the `'code'` compactor is pure
 * and free — the same (state, budget) yields the same summary text byte for byte — the folded entries leave one-line
 * pointers behind, and `ContextUsage` is a pure function of chars.
 */
import { describe, expect, it } from 'vitest';
import type { LastTestRun, Plan } from '../../../src/core/types.js';
import { SUMMARY_SECTIONS, compactCode, compactionDue, isContextSummary, renderSummary, type CompactionInput } from '../../../src/loop/context/compaction.js';
import { buildHistoryEntry, foldableCount, needsOutputFile, outputRefFor, pushHistory } from '../../../src/loop/context/history.js';
import { CHARS_PER_TOKEN, COMPACT_AT_PCT, COMPACT_EVERY, SUMMARY_TEXT_MAX_CHARS, contextBudgetChars, resolveContextPolicy } from '../../../src/loop/context/limits.js';
import { computeContextUsage, formatMeter, meterLevel, restoredContextUsage } from '../../../src/loop/context/meter.js';
import type { HistoryEntry } from '../../../src/loop/context/types.js';
import { buildWindowEntry } from '../../../src/loop/window.js';

function plan(): Plan {
  return {
    done: [
      { text: 'read the failing test', evidence: { step: 2, judged: 0.91, tests: [], verified: true } },
      { text: 'fix f()', evidence: { step: 6, judged: 0.88, tests: ['tests/test_a.py::test_f'], verified: true } },
    ],
    remaining: ['run the suite', 'update the changelog', 'c', 'd', 'e'],
    unverified: [],
    openProblems: [],
    harnessProblems: [{ kind: 'replan', text: 'the same edit three times', step: 5 }],
  } as unknown as Plan;
}

const tests: LastTestRun = { step: 6, command: 'pytest -q', passed: 12, failed: 1, errors: 0, allPassed: false };

function history(n: number): HistoryEntry[] {
  let h: HistoryEntry[] = [];
  for (let step = 1; step <= n; step++) {
    const out = `output of step ${step} `.padEnd(3_000, 'x');
    const entry = buildWindowEntry({ step, intent: 'edit', action: `edit src/f${step}.ts`, outcome: { status: 'executed', summary: 'ok', changedFiles: [] }, output: out, judge: null, completion: 0.5, shownFiles: [`src/f${step}.ts`], notes: [], error: null });
    h = pushHistory(h, buildHistoryEntry(entry, out, needsOutputFile(out) ? outputRefFor(step) : null));
  }
  return h;
}

function input(over: Partial<CompactionInput> = {}): CompactionInput {
  return {
    step: 8,
    at: '2026-09-21T10:00:00.000Z',
    task: 'Fix f() in src/a.ts so that tests/test_a.py passes',
    plan: plan(),
    history: history(8),
    fileMemory: { 'src/a.ts': { sha12: 'abcdef012345', bytes: 120, readAt: 2, editedAt: 6 }, 'tests/test_a.py': { sha12: null, bytes: 80, readAt: 1, editedAt: null } },
    lastTestRun: tests,
    previous: null,
    ...over,
  };
}

describe('§8.6 code compaction', () => {
  it('is deterministic: the same inputs give the same summary text, byte for byte', () => {
    const a = compactCode(input());
    const b = compactCode(input());
    expect(b.summary.text).toBe(a.summary.text);
    expect(JSON.stringify(b.summary)).toBe(JSON.stringify(a.summary));
    expect(JSON.stringify(b.history)).toBe(JSON.stringify(a.history));
    expect(b.chars).toEqual(a.chars);
    // the clock reaches the summary only through `at`, which is an input: `text` is unchanged by it
    const later = compactCode(input({ at: '2030-01-01T00:00:00.000Z' }));
    expect(later.summary.text).toBe(a.summary.text);
    expect(later.summary.at).toBe('2030-01-01T00:00:00.000Z');
    // the fold does not mutate its input
    const h = history(8);
    const frozen = JSON.stringify(h);
    compactCode(input({ history: h }));
    expect(JSON.stringify(h)).toBe(frozen);
  });

  it('writes the seven sections with the verifying step, the test counts and the files in memory', () => {
    const r = compactCode(input());
    expect(Object.keys(r.summary.sections)).toEqual([...SUMMARY_SECTIONS]);
    expect(r.summary.sections.Objective).toEqual(['Fix f() in src/a.ts so that tests/test_a.py passes']);
    expect(r.summary.sections.Completed[1]).toContain('fix f() (step 6, judged 0.88; tests 12 passed, 1 failed, 0 errors)');
    expect(r.summary.sections.Active).toEqual(['run the suite', 'update the changelog', 'c', 'd']);
    expect(r.summary.sections.Blocked).toEqual(['[replan, step 5] the same edit three times']);
    expect(r.summary.sections.Files[0]).toBe('src/a.ts — read at step 2, edited at step 6 (sha abcd…)');
    expect(r.summary.sections.Tests).toEqual(['pytest -q: 12 passed, 1 failed, 0 errors (step 6)']);
    expect(r.summary.sections.Notes).toHaveLength(6);
    expect(r.summary.text.length).toBeLessThanOrEqual(SUMMARY_TEXT_MAX_CHARS);
    expect(r.summary.by).toBe('code');
    expect(r.summary.step).toBe(8);
    expect(isContextSummary(JSON.parse(JSON.stringify(r.summary)))).toBe(true);
    expect(isContextSummary({ v: 2 })).toBe(false);
    expect(isContextSummary(null)).toBe(false);
  });

  it('keeps the newest 2 verbatim, folds the rest and hands back a pointer per dropped item', () => {
    const r = compactCode(input());
    expect(r.history).toHaveLength(8);
    expect(r.history.slice(-2).every((e) => (e.output ?? '').length > 0)).toBe(true);
    expect(r.history.slice(0, 6).every((e) => e.output === undefined)).toBe(true);
    expect(r.dropped.map((d) => d.step)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const d of r.dropped) {
      expect(d.ref).toBe(`outputs/step-${d.step}.txt`);
      expect(d.line).toContain(`full text: read jevcode:outputs/step-${d.step}.txt`);
    }
    expect(r.chars.after).toBeLessThan(r.chars.before);
  });

  it('the rolling Notes carry forward and stay bounded at 24', () => {
    const first = compactCode(input());
    const second = compactCode(input({ step: 16, history: history(12), previous: first.summary }));
    expect(second.summary.sections.Notes.slice(0, 6)).toEqual(first.summary.sections.Notes);
    let rolling = second.summary;
    for (let i = 0; i < 6; i++) rolling = compactCode(input({ step: 24 + i, history: history(12), previous: rolling })).summary;
    expect(rolling.sections.Notes).toHaveLength(24);
  });

  it('the summary text drops the oldest Notes before it clips anything', () => {
    const many = Array.from({ length: 24 }, (_, i) => `note ${i} ${'n'.repeat(300)}`);
    const sections = { Objective: ['o'], Completed: [], Active: [], Blocked: [], Files: ['f'], Tests: ['t'], Notes: many };
    const text = renderSummary(sections);
    expect(text.length).toBeLessThanOrEqual(SUMMARY_TEXT_MAX_CHARS);
    expect(text).toContain('note 23');
    expect(text).not.toContain('note 0 ');
    expect(text).toContain('Objective:');
    expect(text).toContain('Tests:');
  });

  it('triggers: every 8 steps, ≥ 85 % of the budget, or /compact — never under `off`, never with nothing to fold', () => {
    const base = { step: 8, compactEvery: COMPACT_EVERY, pct: 10, mode: 'code' as const, foldable: 6 };
    expect(compactionDue(base)).toBe('interval');
    expect(compactionDue({ ...base, step: 7 })).toBeNull();
    expect(compactionDue({ ...base, step: 7, pct: COMPACT_AT_PCT })).toBe('budget');
    expect(compactionDue({ ...base, step: 7, pct: COMPACT_AT_PCT - 1 })).toBeNull();
    expect(compactionDue({ ...base, step: 7, manual: true })).toBe('manual');
    expect(compactionDue({ ...base, mode: 'off' })).toBeNull();
    expect(compactionDue({ ...base, mode: 'off', manual: true })).toBeNull();
    expect(compactionDue({ ...base, compactEvery: 0 })).toBeNull();
    // review finding 53: nothing to fold → no compaction and no counter move, whatever the trigger
    expect(compactionDue({ ...base, foldable: 0 })).toBeNull();
    expect(compactionDue({ ...base, foldable: 0, manual: true })).toBeNull();
    expect(foldableCount(compactCode(input()).history)).toBe(0);
  });

  it('works with no plan progress, no tests and no files (jev-only, step 8 of a fresh run)', () => {
    const r = compactCode(input({ plan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] } as unknown as Plan, fileMemory: {}, lastTestRun: null }));
    expect(r.summary.sections.Tests).toEqual(['no parsed test run yet']);
    expect(r.summary.sections.Completed).toEqual([]);
    expect(r.summary.text).toContain('Objective:');
  });
});

describe('§12.0.3 ContextUsage', () => {
  const base = { promptChars: 34_000, budgetChars: 239_360, files: 6, historyEntries: 12, summaryAt: 8, lastCompactionStep: 8, compactions: 1, lastCompactionAt: '2026-09-21T10:00:00.000Z', compaction: 'code' as const };

  it('is chars / 3.4 in both members, pct is the share of the BUDGET, and the model window is reported beside it', () => {
    const u = computeContextUsage(base);
    expect(u.tokensInWindow).toBe(Math.round(34_000 / CHARS_PER_TOKEN));
    // review finding 51: `budgetTokens` is the prompt budget (0.55 × the window), `windowTokens` the model's window
    expect(u.budgetTokens).toBe(Math.round(239_360 / CHARS_PER_TOKEN));
    expect(u.windowTokens).toBe(128_000);
    expect(u.budgetTokens).toBeLessThan(u.windowTokens);
    expect(u.pct).toBe(Math.round((100 * u.tokensInWindow) / u.budgetTokens));
    expect(u.pct).toBe(14);
    expect(u).toEqual({ ...base, tokensInWindow: u.tokensInWindow, budgetTokens: u.budgetTokens, windowTokens: 128_000, pct: 14 });
    // a bigger model carries its own window; the budget stays 55 % of it
    const big = computeContextUsage({ ...base, budgetChars: contextBudgetChars(200_000), windowTokens: 200_000 });
    expect(big.windowTokens).toBe(200_000);
    expect(big.budgetTokens).toBe(Math.round(contextBudgetChars(200_000) / CHARS_PER_TOKEN));
    // never negative, never divides by zero, and the window is never below the budget
    expect(computeContextUsage({ ...base, promptChars: -5, budgetChars: 0 }).pct).toBe(0);
    expect(computeContextUsage({ ...base, budgetChars: 900_000, windowTokens: 1_000 }).windowTokens).toBeGreaterThanOrEqual(computeContextUsage({ ...base, budgetChars: 900_000, windowTokens: 1_000 }).budgetTokens);
  });

  it('before the first prompt it is derived from the restored state (promptChars 0, counters as persisted)', () => {
    const u = restoredContextUsage({ history: [history(3)[0]!], fileCache: [{ rel: 'a', pinnedBy: 'read', lastUsedStep: 1, bytesShown: 0 }], summaryAt: 8, compactions: 2, lastCompactionAt: '2026-09-21T09:00:00.000Z' }, 239_360, 'code');
    expect(u).toMatchObject({ promptChars: 0, pct: 0, tokensInWindow: 0, files: 1, historyEntries: 1, summaryAt: 8, lastCompactionStep: 8, compactions: 2, lastCompactionAt: '2026-09-21T09:00:00.000Z', compaction: 'code', windowTokens: 128_000 });
    const fresh = restoredContextUsage({}, 239_360, 'off');
    expect(fresh).toMatchObject({ files: 0, historyEntries: 0, summaryAt: null, compactions: 0, lastCompactionAt: null, compaction: 'off' });
  });

  it('amber at 85 %, red at 95 %, and the S5 zone text', () => {
    expect([0, 84, 85, 94, 95, 120].map(meterLevel)).toEqual(['ok', 'ok', 'amber', 'amber', 'red', 'red']);
    expect(formatMeter(computeContextUsage(base))).toBe('ctx 14% · 6 files · 12 steps');
    expect(formatMeter(computeContextUsage({ ...base, files: 1, historyEntries: 1 }))).toBe('ctx 14% · 1 file · 1 step');
  });

  it('the budget is model-aware and clamped, and the policy defaults are §8.2/§8.6', () => {
    const p = resolveContextPolicy();
    expect(p).toEqual({ view: 'relaxed', historySteps: 12, fileCacheBytes: 96 * 1024, compactEvery: 8, compaction: 'code', budgetChars: Math.round(128_000 * CHARS_PER_TOKEN * 0.55), windowTokens: 128_000 });
    expect(resolveContextPolicy(undefined, 200_000).windowTokens).toBe(200_000);
    expect(resolveContextPolicy({ compactEvery: 0 }).compactEvery).toBe(0);
    expect(resolveContextPolicy({ compaction: 'off', view: 'legacy' })).toMatchObject({ compaction: 'off', view: 'legacy' });
    expect(resolveContextPolicy({ budgetChars: 500_000 }).budgetChars).toBe(500_000);
    expect(resolveContextPolicy({ historySteps: -1 }).historySteps).toBe(12);
  });
});
