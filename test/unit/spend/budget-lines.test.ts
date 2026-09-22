import { describe, expect, it } from 'vitest';
import {
  BUDGET_THRESHOLDS,
  budgetItems,
  budgetPct,
  childCapUsd,
  costBlock,
  eachUsdText,
  crossedThresholds,
  followUpBoxLines,
  followUpDecision,
  grouped,
  meterText,
  meterWord,
  nextBudgetWarn,
  pendingBudgetLine,
  raiseSessionCapCommand,
  restoredBudgetWarn,
  seedAnnounced,
  sessionCapChangedLine,
  sessionCapReachedItem,
  sessionRemainingUsd,
  spendCapEpilogueLines,
  spendCapRaiseError,
  stepsLeftEstimate,
  suggestedSpendCapUsd,
  usd2,
  usd3,
  type BudgetPct,
} from '../../../src/tui/budget/lines.js';

const INF = Number.POSITIVE_INFINITY;

describe('money formats', () => {
  it('usd3 / usd2 / grouped, with $? for non-finite and `none` for an uncapped cap', () => {
    expect(usd3(1.6)).toBe('$1.600');
    expect(usd3(0)).toBe('$0.000');
    expect(usd3(Number.NaN)).toBe('$?');
    expect(usd3(INF)).toBe('$?');
    expect(usd2(4.111)).toBe('$4.11');
    expect(usd2(INF)).toBe('none');
    expect(usd2(Number.NaN)).toBe('$?');
    expect(grouped(1204)).toBe('1,204');
    expect(grouped(Number.NaN)).toBe('?');
  });
});

describe('budgetPct / meterWord / meterText (§9.2, §24)', () => {
  it('floor(100 × spent / cap); null when uncapped; NaN / zero cap fails closed', () => {
    expect(budgetPct(1.6, 2)).toBe(80);
    expect(budgetPct(1.999, 2)).toBe(99);
    expect(budgetPct(0, 2)).toBe(0);
    expect(budgetPct(-1, 2)).toBe(0);
    expect(budgetPct(1, INF)).toBeNull();
    expect(budgetPct(0, 0)).toBe(0);
    expect(budgetPct(0.01, 0)).toBe(100);
    expect(budgetPct(0.5, Number.NaN)).toBe(100);
    expect(budgetPct(Number.NaN, 2)).toBe(0);
  });

  it('meter words at the boundaries', () => {
    const cases: [number, string][] = [
      [0.99, 'ok'],
      [1, 'half'],
      [1.59, 'half'],
      [1.6, 'high'],
      [1.89, 'high'],
      [1.9, 'critical'],
      [1.99, 'critical'],
      [2, 'over'],
      [3, 'over'],
    ];
    for (const [spent, word] of cases) expect(meterWord(spent, 2)).toBe(word);
    expect(meterWord(100, INF)).toBe('uncapped');
    expect(meterWord(0.1, Number.NaN)).toBe('over');
  });

  it('status meters', () => {
    expect(meterText('run', 1.6, 2)).toBe('run $1.60/2.00 high');
    expect(meterText('session', 4.11, 10)).toBe('sess $4.11/10.00 ok');
    expect(meterText('session', 4.11, INF)).toBe('sess $4.11/none uncapped');
    expect(meterText('run', Number.NaN, 2)).toBe('run $0.00/2.00 ok');
  });
});

describe('threshold crossings (§9.2)', () => {
  it('crossedThresholds lists every threshold at or below the pct, ascending; none when uncapped', () => {
    expect(BUDGET_THRESHOLDS).toEqual([50, 80, 95]);
    expect(crossedThresholds(0.99, 2)).toEqual([]);
    expect(crossedThresholds(1, 2)).toEqual([50]);
    expect(crossedThresholds(1.6, 2)).toEqual([50, 80]);
    expect(crossedThresholds(1.9, 2)).toEqual([50, 80, 95]);
    expect(crossedThresholds(5, 2)).toEqual([50, 80, 95]);
    expect(crossedThresholds(1e9, INF)).toEqual([]);
  });

  it('34 adds of $0.06 against a $2.00 cap announce 50, 80, 95 exactly once each, in order', () => {
    let announced: ReadonlySet<BudgetPct> = new Set();
    let spent = 0;
    const warns: { add: number; pct: BudgetPct }[] = [];
    for (let i = 1; i <= 34; i++) {
      spent += 0.06;
      const r = nextBudgetWarn(spent, 2, announced);
      announced = r.announced;
      if (r.warn) warns.push({ add: i, pct: r.warn.pct });
    }
    expect(warns).toEqual([
      { add: 17, pct: 50 },
      { add: 27, pct: 80 },
      { add: 32, pct: 95 },
    ]);
    expect([...announced].sort()).toEqual([50, 80, 95]);
    expect(nextBudgetWarn(3, 2, announced).warn).toBeNull();
  });

  it('one add crossing two thresholds announces the highest only and marks both', () => {
    const r = nextBudgetWarn(1.7, 2, new Set());
    expect(r.warn).toEqual({ pct: 80, restored: false });
    expect([...r.announced].sort()).toEqual([50, 80]);
    expect(nextBudgetWarn(1.75, 2, r.announced).warn).toBeNull();
    const all = nextBudgetWarn(2.5, 2, new Set());
    expect(all.warn?.pct).toBe(95);
    expect(all.announced.size).toBe(3);
  });

  it('restored: the re-announcement after a resume is decided from the restored spend, never from call order', () => {
    // restoredBudgetWarn is self-sufficient: the highest already-crossed threshold, flagged, with the set seeded
    const boot = restoredBudgetWarn(1.65, 2);
    expect(boot.warn).toEqual({ pct: 80, restored: true });
    expect([...boot.announced].sort()).toEqual([50, 80]);
    expect(restoredBudgetWarn(0.5, 2)).toEqual({ warn: null, announced: new Set() });
    expect(restoredBudgetWarn(1e6, INF)).toEqual({ warn: null, announced: new Set() });
    expect(restoredBudgetWarn(2.5, 2).warn).toEqual({ pct: 95, restored: true });
    // the same through nextBudgetWarn with the restored spend: the first add re-announces 80 as restored …
    const first = nextBudgetWarn(1.65, 2, new Set(), { restoredSpentUsd: 1.65 });
    expect(first.warn).toEqual({ pct: 80, restored: true });
    const second = nextBudgetWarn(1.66, 2, first.announced, { restoredSpentUsd: 1.65 });
    expect(second.warn).toBeNull();
    // … and a threshold first crossed by an add after the resume is a fresh crossing, not restored
    const later = nextBudgetWarn(1.95, 2, second.announced, { restoredSpentUsd: 1.65 });
    expect(later.warn).toEqual({ pct: 95, restored: false });
    // a fresh crossing on the very first add after a resume (restored spend below 50 %) is not flagged either
    expect(nextBudgetWarn(1.02, 2, new Set(), { restoredSpentUsd: 0.9 }).warn).toEqual({ pct: 50, restored: false });
    // one add crossing a restored and a fresh threshold announces the highest (fresh) one
    expect(nextBudgetWarn(1.95, 2, new Set(), { restoredSpentUsd: 1.65 }).warn).toEqual({ pct: 95, restored: false });
    // nothing crossed yet → no announcement at all; without the option nothing is ever restored
    expect(nextBudgetWarn(0.5, 2, new Set(), { restoredSpentUsd: 0.5 }).warn).toBeNull();
    expect(nextBudgetWarn(1.65, 2, new Set()).warn).toEqual({ pct: 80, restored: false });
  });

  it('never announces for +Infinity; the session set is seeded from earlier runs so nothing is re-announced', () => {
    expect(nextBudgetWarn(1e6, INF, new Set()).warn).toBeNull();
    expect(seedAnnounced(8, 10)).toEqual(new Set([50, 80]));
    expect(seedAnnounced(0, 10)).toEqual(new Set());
    expect(seedAnnounced(1, INF)).toEqual(new Set());
    const seeded = seedAnnounced(8, 10);
    expect(nextBudgetWarn(8.1, 10, seeded).warn).toBeNull();
    expect(nextBudgetWarn(9.5, 10, seeded).warn).toEqual({ pct: 95, restored: false });
    // the input set is never mutated
    expect(seeded.size).toBe(2);
  });

  it('stepsLeftEstimate', () => {
    expect(stepsLeftEstimate(1.6, 2, 0.04)).toBe(10);
    expect(stepsLeftEstimate(2.1, 2, 0.04)).toBe(0);
    expect(stepsLeftEstimate(1, 2, 0)).toBeNull();
    expect(stepsLeftEstimate(1, 2, null)).toBeNull();
    expect(stepsLeftEstimate(1, INF, 0.04)).toBeNull();
    expect(stepsLeftEstimate(1, 2, Number.NaN)).toBeNull();
  });
});

describe('budgetItems (§24 engine items)', () => {
  it('run and session warnings, with the Jev-share suffix; restored never changes the §24 text', () => {
    expect(budgetItems({ type: 'budget:warn', scope: 'run', pct: 80, spentUsd: 1.6, capUsd: 2, step: 12, stepsLeftEstimate: 10, restored: false, perStepUsd: 0.04 })).toEqual([
      'budget: run spend $1.600 is 80 % of the $2.000 run cap — about 10 steps left at $0.040/step',
    ]);
    // without a measured rate the item stops at the estimate (no back-derivation from the floored estimate)
    expect(budgetItems({ type: 'budget:warn', scope: 'run', pct: 80, spentUsd: 1.6, capUsd: 2, step: 12, stepsLeftEstimate: 10, restored: false })).toEqual([
      'budget: run spend $1.600 is 80 % of the $2.000 run cap — about 10 steps left',
    ]);
    expect(budgetItems({ type: 'budget:warn', scope: 'run', pct: 50, spentUsd: 1, capUsd: 2, step: 1, stepsLeftEstimate: null, restored: false })).toEqual(['budget: run spend $1.000 is 50 % of the $2.000 run cap']);
    expect(budgetItems({ type: 'budget:warn', scope: 'session', pct: 80, spentUsd: 8, capUsd: 10, step: 3, stepsLeftEstimate: null, restored: false })).toEqual([
      'budget: session spend $8.000 is 80 % of the $10.000 session cap — raise it with /budget session-spend-cap <usd>',
    ]);
    expect(budgetItems({ type: 'budget:warn', scope: 'run', pct: 50, spentUsd: 1, capUsd: 2, step: 1, stepsLeftEstimate: null, restored: true, jevShare: { jevUsd: 0.031, generatorUsd: 0.02 } })).toEqual([
      'budget: run spend $1.000 is 50 % of the $2.000 run cap — Jev is the larger share ($0.031 vs $0.020); see /jev',
    ]);
    // a generator-heavy share adds nothing
    expect(budgetItems({ type: 'budget:warn', scope: 'run', pct: 50, spentUsd: 1, capUsd: 2, step: 1, stepsLeftEstimate: null, restored: false, jevShare: { jevUsd: 0.01, generatorUsd: 0.02 } })[0]).not.toContain('Jev is');
  });

  it('the per-step rate is the measured one: a floored estimate would back-derive $0.050 for a real $0.045 rate', () => {
    // spent 1.6 of 2 at $0.045/step → 8.88 steps → estimate 8; (2 − 1.6) / 8 = 0.050 is wrong, 0.045 is right
    const e = { type: 'budget:warn', scope: 'run', pct: 80, spentUsd: 1.6, capUsd: 2, step: 20, stepsLeftEstimate: stepsLeftEstimate(1.6, 2, 0.045), restored: false } as const;
    expect(e.stepsLeftEstimate).toBe(8);
    expect(budgetItems({ ...e, perStepUsd: 0.045 })).toEqual(['budget: run spend $1.600 is 80 % of the $2.000 run cap — about 8 steps left at $0.045/step']);
    expect(budgetItems(e)).toEqual(['budget: run spend $1.600 is 80 % of the $2.000 run cap — about 8 steps left']);
    // a non-positive or non-finite rate is ignored; the rate never appears without the estimate
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(budgetItems({ ...e, perStepUsd: bad })[0]).not.toContain('/step');
    expect(budgetItems({ ...e, stepsLeftEstimate: null, perStepUsd: 0.045 })).toEqual(['budget: run spend $1.600 is 80 % of the $2.000 run cap']);
    expect(budgetItems({ ...e, stepsLeftEstimate: 0, perStepUsd: 0.045 })).toEqual(['budget: run spend $1.600 is 80 % of the $2.000 run cap — about 0 steps left at $0.045/step']);
  });

  it('stop, clamp, override, unpriced', () => {
    expect(budgetItems({ type: 'budget:stop', scope: 'run', by: 'run', spentUsd: 2.03, capUsd: 2, step: 23, at: 'step_start', raise: { command: '/budget spend-cap 3.00', flag: '--spend-cap', minimum: 2.03 } })).toEqual([
      'budget stop: run cap $2.000 reached at step start — raise: /budget spend-cap 3.00',
    ]);
    expect(budgetItems({ type: 'budget:stop', scope: 'run', by: 'tokens', spentUsd: 0, capUsd: 133333, step: 5, at: 'before_execute', raise: { command: '/budget max-generator-tokens 200000', flag: '--max-generator-tokens', minimum: 133334 } })).toEqual([
      'budget stop: tokens cap 133,333 tokens reached at before execute — raise: /budget max-generator-tokens 200000',
    ]);
    expect(budgetItems({ type: 'budget:clamp', runCapUsd: 2, clampedToUsd: 0.5, sessionSpentUsd: 9.5, sessionCapUsd: 10 })).toEqual(['budget: run cap clamped to $0.500 (session $9.500 of $10.000)']);
    expect(budgetItems({ type: 'budget:override', setting: 'limits.spendCapUsd', from: '2', to: '3', appliesTo: 'resume', source: '/budget' })).toEqual(['budget override: limits.spendCapUsd 2 → 3 (applies to this resume)']);
    expect(budgetItems({ type: 'budget:unpriced', side: 'generator', model: 'vendor/x', step: 4, tokens: { input: 10, output: 5 } })).toEqual(['budget: generator usage.cost missing for vendor/x — unpriced']);
  });
});

describe('follow-up confirm and refusal (§9.3)', () => {
  it('decision: remaining ≥ runCap start; 0 < remaining < runCap confirm; ≤ 0 refuse; uncapped always starts', () => {
    expect(followUpDecision(2, 10, 3.85)).toBe('start');
    expect(followUpDecision(2, 10, 8)).toBe('start');
    expect(followUpDecision(2, 10, 8.01)).toBe('confirm');
    expect(followUpDecision(2, 10, 9.99)).toBe('confirm');
    expect(followUpDecision(2, 10, 10)).toBe('refuse');
    expect(followUpDecision(2, 10, 10.31)).toBe('refuse');
    expect(followUpDecision(2, INF, 1e9)).toBe('start');
    expect(sessionRemainingUsd(INF, 5)).toBe(INF);
    expect(sessionRemainingUsd(10, Number.NaN)).toBe(10);
    // ORCHESTRATION-DESIGN [D6]: held reservations are subtracted like spend; negative or NaN holds count as 0
    expect(sessionRemainingUsd(10, 3, 2)).toBe(5);
    expect(sessionRemainingUsd(10, 3, Number.NaN)).toBe(7);
    expect(sessionRemainingUsd(10, 3, -1)).toBe(7);
    expect(sessionRemainingUsd(INF, 5, 100)).toBe(INF);
  });

  it('child cap = min(runCap, remaining), never negative', () => {
    expect(childCapUsd(2, 10, 0)).toBe(2);
    expect(childCapUsd(2, 10, 8)).toBe(2);
    expect(childCapUsd(2, 10, 9.5)).toBeCloseTo(0.5, 12);
    expect(childCapUsd(2, 10, 11)).toBe(0);
    expect(childCapUsd(2, INF, 100)).toBe(2);
    expect(childCapUsd(2, 15, 10)).toBe(2);
  });

  it('box rows verbatim, truncation to 3 / 2 / 1 / 0 rows', () => {
    const i = { runCapUsd: 2, sessionCapUsd: 10, sessionSpentUsd: 9.25, runs: 5, lastRunUsd: 1.3 };
    const rows = followUpBoxLines(i);
    expect(rows).toEqual([
      'follow-up would exceed the session cap',
      '[y] start, run cap clamped to $0.75   [r] raise session cap   [n]/Esc cancel',
      'session $9.25 of $10.00 (5 runs) · run cap $2.00 · last run $1.30',
      'Enter does nothing here. A clamped run stops at the session cap (spend_cap).',
    ]);
    expect(followUpBoxLines(i, 3)).toEqual(rows.slice(0, 3));
    expect(followUpBoxLines(i, 2)).toEqual(rows.slice(0, 2));
    expect(followUpBoxLines(i, 1)).toEqual(rows.slice(0, 1));
    expect(followUpBoxLines(i, 0)).toEqual([]);
    expect(followUpBoxLines(i, 99)).toHaveLength(4);
    expect(followUpBoxLines(i, Number.NaN)).toEqual([]);
    expect(followUpBoxLines({ ...i, runs: 1, lastRunUsd: null })[2]).toBe('session $9.25 of $10.00 (1 run) · run cap $2.00 · last run —');
  });

  it('refusal item, session-cap change line, r prefill, pending line, raise error', () => {
    expect(sessionCapReachedItem(10.31, 10)).toBe('session cap reached ($10.31 of $10.00). Raise it with /budget session-spend-cap <usd>, or /new for a fresh session with its own cap.');
    expect(sessionCapChangedLine(10, 15)).toBe('budget: session cap $10.00 → $15.00 (applies now)');
    expect(sessionCapChangedLine(10, INF)).toBe('budget: session cap $10.00 → none (applies now)');
    expect(raiseSessionCapCommand(10, 2)).toBe('/budget session-spend-cap 12.00');
    expect(pendingBudgetLine('spend-cap', '3.00')).toBe('budget: spend-cap 3.00 pending (next /resume or run)');
    expect(spendCapRaiseError(1.2, 1.532)).toBe("/budget spend-cap 1.20 is not above this run's spend $1.532; give a larger value");
    expect(spendCapRaiseError(3, 1.532)).toBeNull();
    expect(spendCapRaiseError(1.532, 1.532)).not.toBeNull();
  });
});

describe('spend-cap epilogue and /cost (§9.4, §9.6)', () => {
  it('run variant names /budget spend-cap <suggested> then /resume and the fresh cap', () => {
    expect(spendCapEpilogueLines({ by: 'run', spentUsd: 1.532, capUsd: 1.5, sessionSpentUsd: 4.11, sessionCapUsd: 10, lastCall: 'one judge call' })).toEqual([
      'stopped by the run spend cap: $1.532 of $1.500 (over by $0.032, one judge call). Session $4.11/$10.00 ok.',
      'continue this run: /budget spend-cap 3.00 then /resume',
      'or start a follow-up run with a fresh $1.500 cap',
    ]);
    expect(spendCapEpilogueLines({ by: 'run', spentUsd: 2.01, capUsd: 2, sessionSpentUsd: 9, sessionCapUsd: 10 })[1]).toBe('continue this run: /budget spend-cap 3.00 then /resume');
    expect(suggestedSpendCapUsd(2, 2.01)).toBe(3);
    expect(suggestedSpendCapUsd(1.5, 1.532)).toBe(3);
    expect(suggestedSpendCapUsd(2, 7.5)).toBe(8);
    expect(suggestedSpendCapUsd(2, 8)).toBe(9);
    expect(suggestedSpendCapUsd(Number.NaN, Number.NaN)).toBe(1);
  });
  it('session variant names /budget session-spend-cap and /new', () => {
    const lines = spendCapEpilogueLines({ by: 'session', spentUsd: 0.4, capUsd: 2, sessionSpentUsd: 10.02, sessionCapUsd: 10, lastCall: 'one judge call' });
    expect(lines).toEqual([
      'stopped by the session spend cap: $10.020 of $10.000 (over by $0.020, one judge call).',
      'raise it: /budget session-spend-cap 11.00 (or none), then type a follow-up',
      'or /new for a fresh session with its own cap',
    ]);
  });

  it('eachUsdText (TUI-DESIGN-3 §5.1 rule 6): `~$0.000006`, six decimals with the trailing zeros dropped, never `e-`', () => {
    expect(eachUsdText(0.000006)).toBe('~$0.000006');
    expect(eachUsdText(0.00002)).toBe('~$0.00002');
    expect(eachUsdText(0.029 / 1204)).toBe('~$0.000024');
    expect(eachUsdText(0.0000004)).toBe('~$0.0');
    expect(eachUsdText(0)).toBe('~$0.0');
    expect(eachUsdText(1.5)).toBe('~$1.5');
    expect(eachUsdText(Number.NaN)).toBe('~$?');
    for (const x of [1e-7, 6e-6, 2.4e-5, 0.00007, 0.5, 12]) expect(eachUsdText(x)).not.toMatch(/e[-+]/);
  });

  it('costBlock: ≤ 12 rows, the §9.6 rows, jev-only drops gen, unpriced renders $?', () => {
    const block = costBlock({
      mode: 'jev-on',
      run: { spentUsd: 0.31, capUsd: 2, perStepUsd: [0.02, 0.023, 0.04] },
      session: { spentUsd: 4.11, capUsd: 10, runs: 5 },
      gen: { usd: 0.281, tablePriced: true },
      jev: { usd: 0.029, questions: 1204, p50Ms: 237 },
      basis: { generator: 'table (z-ai/glm-5.3-flash)', jev: 'provider usage.cost' },
      pending: [{ setting: 'spend-cap', value: '3.00' }],
    });
    expect(block).toEqual([
      'run $0.310 of $2.000 (15 %)',
      'session $4.11 of $10.00 (41 %, 5 runs)',
      'per step p50 $0.023 · last $0.040 · about 42 steps left',
      // TUI-DESIGN-3 §5.1 rule 6: never scientific notation — six decimals, trailing zeros dropped
      'gen $0.281 (~ table-priced) · jev $0.029 for 1,204 questions (~$0.000024 each, p50 237 ms)',
      'basis: generator table (z-ai/glm-5.3-flash), jev provider usage.cost',
      'pending: spend-cap 3.00 (next /resume or run)',
      'raise: /budget spend-cap <usd> · /budget session-spend-cap <usd|none>',
    ]);
    const jevOnly = costBlock({ mode: 'jev-only', run: null, session: { spentUsd: 0, capUsd: INF, runs: 0 }, gen: { usd: 1, tablePriced: false }, jev: null, basis: { generator: 'x', jev: null }, pending: [] });
    expect(jevOnly).toEqual(['session $0.00 of none (uncapped, 0 runs)', 'raise: /budget spend-cap <usd> · /budget session-spend-cap <usd|none>']);
    const unpriced = costBlock({ mode: 'jev-on', run: { spentUsd: 0.3, capUsd: 2, perStepUsd: [0.1] }, session: { spentUsd: 1, capUsd: 10, runs: 1 }, gen: { usd: 0.2, tablePriced: false }, jev: null, basis: { generator: null, jev: null }, pending: [], unpriced: true });
    expect(unpriced[0]).toBe('run $? of $2.000 (15 %)');
    expect(unpriced[2]).toBe('per step p50 $? · last $? · about 17 steps left');
    expect(unpriced[3]).toBe('gen $?');
    const many = costBlock({ mode: 'jev-on', run: { spentUsd: 0.3, capUsd: 2, perStepUsd: [0.1] }, session: { spentUsd: 1, capUsd: 10, runs: 1 }, gen: { usd: 0.2, tablePriced: false }, jev: { usd: 0.1, questions: 0, p50Ms: null }, basis: { generator: 'a', jev: 'b' }, pending: Array.from({ length: 10 }, (_, i) => ({ setting: `s${i}`, value: 'v' })) });
    expect(many.length).toBeLessThanOrEqual(12);
    expect(many.some((l) => l === 'gen $0.200 · jev $0.100 for 0 questions')).toBe(true);
  });
});
