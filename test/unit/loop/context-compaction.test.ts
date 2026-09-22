/**
 * Deterministic compaction (docs/COORDINATION-DESIGN.md §8.6) and the meter (§8.7, §12.0.3): the `'code'` compactor is pure
 * and free — the same (state, budget) yields the same summary text byte for byte — the folded entries leave one-line
 * pointers behind, and `ContextUsage` is a pure function of chars.
 */
import { describe, expect, it } from 'vitest';
import type { LastTestRun, Plan } from '../../../src/core/types.js';
import { SUMMARY_SECTIONS, compactCode, compactionDue, isContextSummary, renderSummary, type CompactionInput } from '../../../src/loop/context/compaction.js';
import { buildHistoryEntry, foldableCount, needsOutputFile, outputRefFor, pushHistory } from '../../../src/loop/context/history.js';
import { CHARS_PER_TOKEN, COMPACT_AT_PCT, COMPACT_EVERY, SUMMARY_TEXT_MAX_CHARS, contextBudget, resolveContextPolicy } from '../../../src/loop/context/limits.js';
import { computeContextUsage, formatBudget, formatMeter, formatRecentSteps, meterLevel, restoredContextUsage } from '../../../src/loop/context/meter.js';
import type { HistoryEntry } from '../../../src/core/types.js';
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
    // §8.6 fourth trigger: a resume that folded rows past the window
    expect(compactionDue({ ...base, step: 7, resume: true })).toBe('resume');
    expect(compactionDue({ ...base, step: 7, resume: true, mode: 'off' })).toBeNull();
    // review finding 53: nothing to fold → no compaction and no counter move, whatever the trigger
    expect(compactionDue({ ...base, foldable: 0 })).toBeNull();
    expect(compactionDue({ ...base, foldable: 0, manual: true })).toBeNull();
    expect(compactionDue({ ...base, foldable: 0, resume: true })).toBeNull();
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
    // review D15: a small window is reported as it is, never inflated to hide the budget
    const small = computeContextUsage({ ...base, budget: contextBudget({ windowTokens: 16_000 }) });
    expect(small.windowTokens).toBe(16_000);
    expect(small.windowTooSmall).toBe(true);
    expect(computeContextUsage({ ...base, promptChars: -5, budgetChars: 0 }).pct).toBe(0);
  });

  it('before the first prompt it is derived from the restored state (promptChars 0, counters as persisted)', () => {
    const budget = contextBudget();
    const u = restoredContextUsage({ history: [history(3)[0]!], fileCache: [{ rel: 'a', pinnedBy: 'read', lastUsedStep: 1, bytesShown: 0 }], summaryAt: 8, compactions: 2, lastCompactionAt: '2026-09-21T09:00:00.000Z' }, budget, 'code');
    expect(u).toMatchObject({ promptChars: 0, pct: 0, tokensInWindow: 0, files: 1, historyEntries: 1, summaryAt: 8, lastCompactionStep: 8, compactions: 2, lastCompactionAt: '2026-09-21T09:00:00.000Z', compaction: 'code', windowTokens: 128_000 });
    expect(u.recentSteps).toEqual({ chars: 0, allowanceChars: 0, whole: 0, clipped: 0, oneLine: 0, reads: 0 });
    const fresh = restoredContextUsage({}, budget, 'off');
    expect(fresh).toMatchObject({ files: 0, historyEntries: 0, summaryAt: null, compactions: 0, lastCompactionAt: null, compaction: 'off' });
  });

  it('amber at 85 %, red at 95 %, and the S5 zone text', () => {
    expect([0, 84, 85, 94, 95, 120].map(meterLevel)).toEqual(['ok', 'ok', 'amber', 'amber', 'red', 'red']);
    expect(formatMeter(computeContextUsage(base))).toBe('ctx 14% · 6 files · 12 steps');
    expect(formatMeter(computeContextUsage({ ...base, files: 1, historyEntries: 1 }))).toBe('ctx 14% · 1 file · 1 step');
  });

  it('§8.2(c): `/context` prints the recent-steps line the tier ladder produced', () => {
    const u = computeContextUsage({ ...base, recentSteps: { chars: 71_000, allowanceChars: 71_808, whole: 2, clipped: 4, oneLine: 6, reads: 3 } });
    expect(formatRecentSteps(u)).toBe('recent steps 71k of 72k (2 whole, 4 clipped, 6 one-line)');
  });
});

describe('§8.2 the budget (window AND money)', () => {
  it('is the min of the window term and the money term, clamped to [60k, 800k]', () => {
    // the window term alone: 128k × 3.4 × 0.55
    expect(contextBudget({ windowTokens: 128_000 })).toMatchObject({ chars: Math.round(128_000 * CHARS_PER_TOKEN * 0.55), boundBy: 'window' });
    // review D8: the money term binds at a ~$0.9/M model with the default $2.00 cap over 40 steps (§8.2's own example)
    const money = contextBudget({ windowTokens: 128_000, spendCapUsd: 2, maxSteps: 40, inputPerM: 0.9 });
    expect(money.boundBy).toBe('money');
    expect(money.chars).toBe(Math.round(((2 * 0.5) / (40 * 0.9)) * 1e6 * CHARS_PER_TOKEN));
    expect(money.chars).toBeLessThan(contextBudget({ windowTokens: 128_000 }).chars);
    expect(money.usdPerStep).toBeCloseTo((money.chars / CHARS_PER_TOKEN / 1e6) * 0.9, 6);
    // a cheap model does not bind: GLM-5.3-flash at $0.09/M leaves the window term in charge
    expect(contextBudget({ windowTokens: 128_000, spendCapUsd: 2, maxSteps: 40, inputPerM: 0.09 }).boundBy).toBe('window');
    // an expensive model is held at the 60k floor, not the old 120k
    expect(contextBudget({ windowTokens: 128_000, spendCapUsd: 2, maxSteps: 40, inputPerM: 2 })).toMatchObject({ chars: 60_000, boundBy: 'floor', moneyChars: 42_500 });
    expect(contextBudget({ windowTokens: 1_000_000 }).chars).toBe(800_000);
  });

  it('review D8: a window smaller than the floor caps the budget instead of being exceeded, and the run says so', () => {
    // 16k tokens ≈ 54k chars of window: the 60k floor would not fit in it, so the window wins
    const small = contextBudget({ windowTokens: 16_000 });
    expect(small.windowTooSmall).toBe(true);
    expect(small.chars).toBe(Math.floor(16_000 * CHARS_PER_TOKEN * 0.9));
    expect(small.chars).toBeLessThan(60_000);
    expect(small.chars / CHARS_PER_TOKEN).toBeLessThan(16_000);
    // a 32k window holds the 60k floor comfortably (17.6k tokens of 32k), so nothing is clamped
    expect(contextBudget({ windowTokens: 32_000 })).toMatchObject({ chars: 60_000, windowTooSmall: false });
    expect(contextBudget({ windowTokens: 128_000 }).windowTooSmall).toBe(false);
    const u = computeContextUsage({ promptChars: 1_000, budgetChars: small.chars, budget: small, files: 0, historyEntries: 0, summaryAt: null, lastCompactionStep: null, compactions: 0, lastCompactionAt: null, compaction: 'code' });
    expect(u.windowTokens).toBe(16_000);
    expect(formatBudget(u)).toContain('capped by the 16k-token model window');
  });

  it('§8.2: `/context` names the term that bound the budget', () => {
    const money = contextBudget({ windowTokens: 128_000, spendCapUsd: 2, maxSteps: 40, inputPerM: 0.9 });
    const u = computeContextUsage({ promptChars: 0, budgetChars: money.chars, budget: money, files: 0, historyEntries: 0, summaryAt: null, lastCompactionStep: null, compactions: 0, lastCompactionAt: null, compaction: 'code' });
    // §8.2: `budget 94k chars — capped by the $2.00 run cap at 40 steps (est. $0.025 per step)`
    expect(formatBudget(u, { spendCapUsd: 2, maxSteps: 40 })).toMatch(/^budget 94k chars — capped by the \$2\.00 run cap at 40 steps \(est\. \$0\.0\d\d per step\)$/);
  });

  it('review D9: `windowTokens` is a pass-through, not a hardcoded 128k', () => {
    expect(resolveContextPolicy({ windowTokens: 200_000 }).windowTokens).toBe(200_000);
    expect(resolveContextPolicy({ windowTokens: 200_000 }).budgetChars).toBe(Math.round(200_000 * CHARS_PER_TOKEN * 0.55));
    expect(resolveContextPolicy({ windowTokens: 16_000 }).budget.windowTooSmall).toBe(true);
    // and the money context reaches it from the engine's limits
    expect(resolveContextPolicy(undefined, { spendCapUsd: 2, maxSteps: 40, inputPerM: 0.9 }).budget.boundBy).toBe('money');
    expect(resolveContextPolicy(undefined, { spendCapUsd: 2, maxSteps: 40, inputPerM: 0.09 }).budget.boundBy).toBe('window');
  });

  it('the policy defaults are §8.2/§8.6, and every option is honoured', () => {
    const p = resolveContextPolicy();
    expect(p).toMatchObject({ view: 'relaxed', historySteps: 12, fileCacheBytes: 96 * 1024, compactEvery: 8, compaction: 'code', budgetChars: Math.round(128_000 * CHARS_PER_TOKEN * 0.55), windowTokens: 128_000 });
    expect(resolveContextPolicy({ compactEvery: 0 }).compactEvery).toBe(0);
    expect(resolveContextPolicy({ compaction: 'off', view: 'legacy' })).toMatchObject({ compaction: 'off', view: 'legacy' });
    expect(resolveContextPolicy({ budgetChars: 150_000 }).budgetChars).toBe(150_000);
    // even an explicit override never exceeds 90 % of the model window (review D8)
    expect(resolveContextPolicy({ budgetChars: 500_000 }).budgetChars).toBe(Math.floor(128_000 * CHARS_PER_TOKEN * 0.9));
    expect(resolveContextPolicy({ budgetChars: 500_000, windowTokens: 400_000 }).budgetChars).toBe(500_000);
    expect(resolveContextPolicy({ historySteps: -1 }).historySteps).toBe(12);
  });
});
