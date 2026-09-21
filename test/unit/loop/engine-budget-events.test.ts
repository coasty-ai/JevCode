/**
 * TUI-DESIGN §9.2 (thresholds), §9.5 (token cap, unpriced usage), §15 items 1 and 19 and §19.4: budget:warn once per
 * (scope, pct) per run with the highest only, the session scope through snapshot.parent, `restored` after a resume,
 * never for +Infinity; budget:stop before run:end; the generatorTokens counter, token_cap in checkBudgets and in
 * storedStopBlocks; budget:unpriced failing closed unless --allow-unpriced.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineEvent, TokenUsage } from '../../../src/core/types.js';
import { BUDGET_ORDER, checkBudgets } from '../../../src/loop/budget.js';
import { createSpendMeter } from '../../../src/spend/meter.js';
import type { Harness } from './fakes.js';
import { createFakeMeter, createFakeProvider, createFakeSandbox, makeEngine, passingTests, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

const usage = (costUsd: number): Partial<TokenUsage> => ({ costUsd });
const readWith = (costUsd: number) => turn({ kind: 'read', paths: ['src/a.py'] }, {}, { usage: usage(costUsd) });
type Warn = Extract<EngineEvent, { type: 'budget:warn' }>;
type Stop = Extract<EngineEvent, { type: 'budget:stop' }>;

describe('checkBudgets with token_cap (§9.5, §15 item 19)', () => {
  const base = { spendExceeded: false, wallMsUsed: 0, maxWallMs: 1000, steps: 0, maxSteps: 10, replans: 0, maxReplans: 2, replanPending: false };
  it('token_cap sits right after spend_cap and fires only with a cap', () => {
    expect(BUDGET_ORDER).toEqual(['spend_cap', 'token_cap', 'wall_time', 'max_steps', 'max_replans']);
    expect(checkBudgets({ ...base, generatorTokens: 5000 })).toBeNull();
    expect(checkBudgets({ ...base, generatorTokens: 5000, maxGeneratorTokens: 5000 })).toBe('token_cap');
    expect(checkBudgets({ ...base, generatorTokens: 4999, maxGeneratorTokens: 5000 })).toBeNull();
    expect(checkBudgets({ ...base, spendExceeded: true, generatorTokens: 5000, maxGeneratorTokens: 5000 })).toBe('spend_cap');
    expect(checkBudgets({ ...base, wallMsUsed: 1000, generatorTokens: 5000, maxGeneratorTokens: 5000 })).toBe('token_cap');
    expect(checkBudgets({ ...base, generatorTokens: 5000, maxGeneratorTokens: Number.NaN })).toBeNull();
    expect(checkBudgets({ ...base, generatorTokens: 5000, maxGeneratorTokens: 5000, only: ['spend_cap', 'wall_time'] })).toBeNull();
  });
});

describe('budget:warn (§9.2)', () => {
  it('run scope: 50, 80 and 95 once each, in order, with the per-step estimate after the first commit; nothing repeats', async () => {
    const h = await build({ turns: [readWith(0.55), readWith(0.3), readWith(0.11), readWith(0.2)], limits: { spendCapUsd: 1, maxSteps: 10 } });
    const r = await h.engine.run();
    const warns = h.of('budget:warn');
    expect(warns.map((w) => [w.scope, w.pct])).toEqual([['run', 50], ['run', 80], ['run', 95]]);
    expect(warns.every((w) => w.capUsd === 1 && w.restored === false)).toBe(true);
    // the first crossing happened during step 1: no committed step yet, so no estimate; later ones carry the p50 rate
    expect(warns[0]!.stepsLeftEstimate).toBeNull();
    expect(warns[0]!.perStepUsd).toBeUndefined();
    expect(warns[1]!.perStepUsd).toBeGreaterThan(0);
    expect(warns[1]!.stepsLeftEstimate).toBe(Math.floor((1 - warns[1]!.spentUsd) / warns[1]!.perStepUsd! + 1e-9));
    // Jev never outspent the generator here
    expect(warns.every((w) => w.jevShare === undefined)).toBe(true);
    expect(r.stopReason).toBe('spend_cap');
    // budget:stop precedes the stop and end lines
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('budget:stop')).toBeGreaterThan(-1);
    expect(types.indexOf('budget:stop')).toBeLessThan(types.indexOf('run:end'));
  });

  it('one add crossing two thresholds announces the highest only; a $+Infinity cap never warns', async () => {
    const h = await build({ turns: [readWith(0.96)], limits: { spendCapUsd: 1, maxSteps: 1 } });
    await h.engine.run();
    expect(h.of('budget:warn').map((w) => w.pct)).toEqual([95]);
    const h2 = await build({ turns: [readWith(0.96), readWith(5)], meter: createFakeMeter(Number.POSITIVE_INFINITY), limits: { spendCapUsd: Number.POSITIVE_INFINITY, maxSteps: 2 } });
    const r2 = await h2.engine.run();
    expect(r2.steps).toBe(2);
    expect(h2.of('budget:warn')).toEqual([]);
    expect(h2.of('budget:stop')).toEqual([]);
  });

  it('jevShare is attached when Jev is the larger share at the crossing', async () => {
    const h = await build({ turns: [readWith(0.001)], deciderOptions: { usage: { costUsd: 0.2 } }, limits: { spendCapUsd: 1, maxSteps: 1 } });
    await h.engine.run();
    const w = h.of('budget:warn');
    expect(w.length).toBeGreaterThan(0);
    expect(w[0]!.jevShare).toBeDefined();
    expect(w[0]!.jevShare!.jevUsd).toBeGreaterThan(w[0]!.jevShare!.generatorUsd);
  });

  it('session scope through snapshot.parent: seeded with what earlier runs crossed, then once per threshold; setCap on the root is observed live', async () => {
    const session = createSpendMeter(10);
    session.add('generator', { inputTokens: 0, outputTokens: 0, costUsd: 7.5, calls: 1 }); // 75 %: 50 already crossed by earlier runs
    const child = session.child(Math.min(2, 10 - session.snapshot().totalUsd));
    const h = await build({ meter: child, turns: [readWith(0.6), readWith(0.6)], limits: { spendCapUsd: 2, maxSteps: 2 } });
    await h.engine.run();
    const session80 = h.of('budget:warn').filter((w) => w.scope === 'session');
    expect(session80.map((w) => w.pct)).toEqual([80]); // 50 was seeded, 80 crossed at 8.1, 95 never reached (8.7)
    expect(session80[0]).toMatchObject({ capUsd: 10, restored: false, stepsLeftEstimate: null });
    expect(session80[0]!.spentUsd).toBeGreaterThan(8);
    // the run scope crossed 50 % of its $2 cap (1.2 + jev) and nothing else
    expect(h.of('budget:warn').filter((w) => w.scope === 'run').map((w) => w.pct)).toEqual([50]);
    // §9.1: a raise through the root reaches the live child's snapshot.parent
    session.setCap?.(15);
    expect(h.engine.status().spend.parent?.capUsd).toBe(15);
  });

  it('after a resume the highest threshold the restored spend had crossed is re-announced once with restored: true', async () => {
    const h = await build({ turns: [readWith(0.87)], limits: { spendCapUsd: 1, maxSteps: 1 } });
    await h.engine.run();
    expect(h.of('budget:warn').map((w) => [w.pct, w.restored])).toEqual([[80, false]]);
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [readWith(0.001)], limits: { spendCapUsd: 1, maxSteps: 2 } });
    await h2.engine.run();
    const w = h2.of('budget:warn');
    expect(w.map((x) => [x.pct, x.restored])).toEqual([[80, true]]);
    expect(w[0]!.step).toBe(2);
  });
});

describe('budget:stop (§9.2, §9.4) before run:end', () => {
  it('spend_cap by the run cap carries the raise the epilogue names', async () => {
    const provider = createFakeProvider([turn({ kind: 'run', command: 'pytest -q' }, {}, { usage: usage(1.532) })]);
    const h = await build({ provider, limits: { spendCapUsd: 1.5 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('spend_cap');
    const stop = h.of('budget:stop');
    expect(stop).toHaveLength(1);
    const s: Stop = stop[0]!;
    expect(s).toMatchObject({ scope: 'run', by: 'run', capUsd: 1.5, step: 0, at: 'before_execute', raise: { command: '/budget spend-cap 3.00', flag: '--spend-cap', minimum: 3 } });
    expect(s.spentUsd).toBeGreaterThanOrEqual(1.532);
    // ordering inside the transcript writer: the budget:stop event precedes the stop line and run:end
    const types = h.events.map((e) => e.type);
    const stopAt = types.indexOf('budget:stop');
    expect(types.slice(stopAt + 1)).toContain('run:end');
    expect(h.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
  });

  it('spend_cap by the session cap (the child is under its own cap, the parent exceeded) names /budget session-spend-cap', async () => {
    const session = createSpendMeter(10);
    session.add('generator', { inputTokens: 0, outputTokens: 0, costUsd: 9.9, calls: 1 });
    const child = session.child(Math.min(2, 10 - session.snapshot().totalUsd)); // 0.1 remaining → the child cap is 0.1... use a plain child cap to isolate the session branch
    void child;
    const wide = createSpendMeter(2, session);
    const h = await build({ meter: wide, turns: [readWith(0.2), readWith(0.2)], limits: { spendCapUsd: 2, maxSteps: 3 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('spend_cap');
    const s = h.of('budget:stop')[0]!;
    // the propose call pushed the session over: the before-execute check fires (§6), the session raise is named
    expect(s).toMatchObject({ scope: 'session', by: 'session', capUsd: 10, at: 'before_execute', raise: { command: '/budget session-spend-cap 11.00', flag: '--session-spend-cap', minimum: 11 } });
    expect(s.spentUsd).toBeGreaterThan(10);
    expect(r.steps).toBe(0);
  });
});

describe('token_cap (§9.5, §8.7)', () => {
  it('counts generator tokens, stops with token_cap at the step start, emits budget:stop by tokens, and the stored stop blocks a resume until the limit is raised', async () => {
    const h = await build({ turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 10, maxGeneratorTokens: 1500 }, engine: { allowUnpriced: true } });
    const r = await h.engine.run();
    // 1200 tokens per fake generate call: step 1 → 1200 (< 1500), step 2 → 2400 (≥ 1500) → stop at the start of step 3
    expect(r.stopReason).toBe('token_cap');
    expect(r.steps).toBe(2);
    expect(h.engine.status().generatorTokens).toEqual({ used: 2400, cap: 1500 });
    const s = h.of('budget:stop')[0]!;
    expect(s).toMatchObject({ scope: 'run', by: 'tokens', spentUsd: 2400, capUsd: 1500, step: 2, at: 'step_start', raise: { command: '/budget max-generator-tokens 10000', flag: '--max-generator-tokens', minimum: 10000 } });
    expect(h.of('run:end')[0]!.exitCode).toBe(4);
    expect(h.store.steps[1]!.stoppedAt).toBe('step_start');
    // resume with the same cap: refused like spend_cap, nothing written; the counter was rebuilt from generatorTokensPerStep
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 10, maxGeneratorTokens: 1500 }, engine: { allowUnpriced: true } });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('token_cap');
    expect(h2.provider.requests).toHaveLength(0);
    expect(h2.engine.status().generatorTokens).toEqual({ used: 2400, cap: 1500 });
    // raised: the run continues
    const h3 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 3, maxGeneratorTokens: 5000 }, engine: { allowUnpriced: true } });
    const r3 = await h3.engine.run();
    expect(r3.stopReason).toBe('max_steps');
    expect(r3.steps).toBe(3);
    expect(h3.engine.status().generatorTokens).toEqual({ used: 3600, cap: 5000 });
  });

  it('without a token cap the counter still runs and never stops the run', async () => {
    const h = await build({ turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 2 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(h.engine.status().generatorTokens).toEqual({ used: 2400, cap: null });
  });
});

describe('budget:unpriced (§9.5 A135–A137)', () => {
  it('a provider reporting no finite cost: the event, the step commits, then the run stops with error (exit 2, the flag is named)', async () => {
    const h = await build({ turns: [turn({ kind: 'read', paths: ['src/a.py'] }, {}, { usage: usage(Number.NaN) })], limits: { maxSteps: 3 } });
    const r = await h.engine.run();
    expect(h.of('budget:unpriced')).toEqual([{ type: 'budget:unpriced', side: 'generator', model: 'z-ai/glm-5.3-flash', step: 1, tokens: { input: 1000, output: 200 } }]);
    expect(r.stopReason).toBe('error');
    expect(r.steps).toBe(1); // the step committed first
    expect(r.error).toMatchObject({ code: 'config', exitCode: 2, message: expect.stringContaining('--allow-unpriced') });
    expect(h.store.transcript.at(-2)).toBe('[run] warn: stop: error at step 1 (unpriced_usage)');
    expect(h.of('run:end')[0]!.exitCode).toBe(2);
  });

  it('under --allow-unpriced the event is emitted once per (side, model) per run — not once per metered call — and the run continues (the token cap guards it)', async () => {
    const h = await build({ turns: [turn({ kind: 'read', paths: ['src/a.py'] }, {}, { usage: usage(Number.NaN) })], limits: { maxSteps: 3 }, engine: { allowUnpriced: true } });
    const r = await h.engine.run();
    // three unpriced generator calls (one per step): one item, at the first
    expect(h.of('budget:unpriced')).toEqual([{ type: 'budget:unpriced', side: 'generator', model: 'z-ai/glm-5.3-flash', step: 1, tokens: { input: 1000, output: 200 } }]);
    expect(h.store.transcript.filter((l) => /usage\.cost missing/.test(l))).toHaveLength(1);
    expect(r.stopReason).toBe('max_steps');
    expect(r.steps).toBe(3);
    // two unpriced sides: one item each (the decider makes several calls per step)
    const h2 = await build({ turns: [turn({ kind: 'read', paths: ['src/a.py'] }, {}, { usage: usage(Number.NaN) })], deciderOptions: { usage: { costUsd: Number.NaN } }, limits: { maxSteps: 2 }, engine: { allowUnpriced: true } });
    await h2.engine.run();
    expect(h2.decider.calls.length).toBeGreaterThan(2);
    expect(h2.of('budget:unpriced').map((e) => [e.side, e.model])).toEqual([['jev', 'typesafe/jev-1.13-20260917'], ['generator', 'z-ai/glm-5.3-flash']]);
  });

  it('a Jev usage without a finite cost is reported on the jev side', async () => {
    const h = await build({ turns: [turn({ kind: 'read', paths: ['src/a.py'] })], deciderOptions: { usage: { costUsd: Number.NaN } }, limits: { maxSteps: 2 } });
    const r = await h.engine.run();
    expect(h.of('budget:unpriced')[0]).toMatchObject({ side: 'jev', step: 1 });
    expect(r.stopReason).toBe('error');
    expect(r.error?.exitCode).toBe(2);
  });
});

describe('/resume meter order (§9.1, judge-safety E11)', () => {
  it('the child cap is computed before the resumed spend is added: cap $10, earlier runs $8.00, resumed $1.50 of $2.00 → child cap $2.00 and the run proceeds; the wrong order stops it', async () => {
    const first = await build({ turns: [turn({ kind: 'run', command: 'pytest -q' }, {}, { usage: usage(1.5) })], sandbox: createFakeSandbox(() => passingTests), meter: createSpendMeter(2), limits: { spendCapUsd: 2, maxSteps: 1 } });
    const r1 = await first.engine.run();
    expect(r1.stopReason).toBe('max_steps');
    const resumedSpend = first.store.last()!.spend;
    expect(resumedSpend.totalUsd).toBeGreaterThanOrEqual(1.5);
    // right order: fold the earlier runs (excluding the resumed one), create the child, then add the resumed spend
    const session = createSpendMeter(10);
    session.add('generator', { inputTokens: 0, outputTokens: 0, costUsd: 8, calls: 1 });
    const child = session.child(Math.min(2, 10 - session.snapshot().totalUsd));
    expect(child.snapshot().capUsd).toBe(2);
    session.add('generator', resumedSpend.generator);
    session.add('jev', resumedSpend.jev);
    const h = await build({ store: first.store, runsDir: first.runsDir, resume: { runId: first.engine.runId, force: false }, meter: child, turns: [readWith(0.001)], limits: { spendCapUsd: 2, maxSteps: 2 } });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('max_steps');
    expect(r.steps).toBe(2);
    const parentTotal = h.engine.status().spend.parent!.totalUsd;
    expect(parentTotal).toBeGreaterThan(9.5);
    expect(parentTotal).toBeLessThan(9.6);
    // wrong order: adding the resumed spend first leaves $0.50 → child cap $0.50 → exceeded at the first checkBudgets
    const session2 = createSpendMeter(10);
    session2.add('generator', { inputTokens: 0, outputTokens: 0, costUsd: 8, calls: 1 });
    session2.add('generator', resumedSpend.generator);
    const child2 = session2.child(Math.min(2, 10 - session2.snapshot().totalUsd));
    expect(child2.snapshot().capUsd).toBeCloseTo(0.5, 3);
    const h2 = await build({ store: first.store, runsDir: first.runsDir, resume: { runId: first.engine.runId, force: false }, meter: child2, turns: [readWith(0.001)], limits: { spendCapUsd: 2, maxSteps: 3 } });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('spend_cap');
    expect(r2.steps).toBe(2); // the two committed steps of the runs above; no new step started
    expect(h2.provider.requests).toHaveLength(0);
    const w: Warn[] = h2.of('budget:warn');
    void w;
  });
});

describe('token_cap counter across a rule-1 discard (§9.5, documented discrepancy)', () => {
  it('generator tokens of a discarded step count in-process but are not in generatorTokensPerStep, so the resumed counter is lower by that step — accepted: the design rebuilds the counter from the committed series', async () => {
    // step 1 commits (1200 tokens); step 2's propose runs (1200 more) and the step is discarded by an abort before execute
    const provider = createFakeProvider([turn({ kind: 'read', paths: ['src/a.py'] }), turn({ kind: 'run', command: 'ls' })]);
    // step 2 is held in the risk stage (after propose, before execute) so the abort discards it under rule 1
    const h = await build({ provider, deciderOptions: { delayMs: (ctx) => (ctx.stage === 'risk' && ctx.step === 2 ? 5_000 : 0) }, limits: { maxSteps: 5, maxGeneratorTokens: 10_000 }, engine: { allowUnpriced: true } });
    const running = h.engine.run();
    h.engine.events.on('generator:end', (e) => {
      if (e.step === 2) setTimeout(() => h.engine.abort('human_abort'), 5);
    });
    const r = await running;
    expect(r.stopReason).toBe('human_abort');
    expect(r.steps).toBe(1);
    expect(h.provider.requests).toHaveLength(2);
    // in-process: both propose calls are counted
    expect(h.engine.status().generatorTokens).toEqual({ used: 2400, cap: 10_000 });
    expect(h.store.last()!.generatorTokensPerStep).toEqual([1200]);
    // the resumed run rebuilds Σ generatorTokensPerStep: the discarded step's 1200 tokens are not carried
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 1, maxGeneratorTokens: 10_000 }, engine: { allowUnpriced: true } });
    expect(h2.engine.status().generatorTokens).toEqual({ used: 1200, cap: 10_000 });
  });
});

