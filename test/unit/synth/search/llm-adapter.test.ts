/**
 * search/llm.ts: the adapter between the loop and llm/source.ts (docs/LLM-JEV-DESIGN.md §4.3–§4.6, §4.12,
 * §9.2 stage 4) over a scripted generator: the request shape of the §10.2 live findings, the listing set
 * from frames and anchors, a round whose arrivals are LLM candidates on the committed base, the step's
 * LLM counters charged, the skip when they are spent, the persisted cache, the step-end cleanup.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { LLM_SERVED_PRICING, attemptsFromArrival, createSearchLlm, listingsFor, llmMemory, needPathsOf, recordAttempts } from '../../../../src/synth/search/llm.js';
import type { LocalizeResult } from '../../../../src/synth/types.js';
import { calcFiles, proposeFixCall, scriptedGenerate } from '../llm/fixtures.js';
import { fakeSandbox } from '../sieve/helpers.js';
import { fakeBudget, fakeCtx, fakeGoal, fakeMemory, fastOracle, siteAt, summary } from './controller-fakes.js';

const files = calcFiles();
const calc = files.get('src/calc.py')!;
const util = files.get('src/util.py')!;
const TEST = 'tests/test_calc.py::test_add_none';
const runDir = mkdtempSync(join(tmpdir(), 'llm-adapter-'));
afterAll(() => rmSync(runDir, { recursive: true, force: true }));

const FIX = [{ old: '    return a + b', new: '    return (a or 0) + b', near_line: 4 }];

function loc(): LocalizeResult {
  const site = siteAt(calc, 4);
  site.evidence.jevProbability = 0.95;
  return { files: [{ path: 'src/calc.py', probability: 0.9 }], functions: [], sites: [site], requests: 0 };
}

function setup(runId: string, gen = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX]), usage: { inputTokens: 3000, outputTokens: 200 } }))): { ctx: ReturnType<typeof fakeCtx>; mem: ReturnType<typeof fakeMemory>; goal: ReturnType<typeof fakeGoal>; gen: typeof gen } {
  const base = fakeCtx({ runId, task: 'add(None, 2) should return 2' });
  const ctx = { ...base, runDir, generate: gen.generate, sandbox: fakeSandbox() };
  const mem = fakeMemory([calc, util], summary({ command: 'pytest -q', failing: [TEST], passing: [] }), { oracle: fastOracle(), stepBudget: fakeBudget({ llmRounds: 2, llmSamples: 8, llmUsd: 0.02 }) });
  const goal = fakeGoal({ tests: [TEST], failures: [{ testId: TEST, call: 'add(None, 2)', expected: '2', actual: "TypeError: unsupported operand type(s) for +: 'NoneType' and 'int'" }], suspectedFiles: ['src/calc.py'] });
  return { ctx, mem, goal, gen };
}

describe('listingsFor', () => {
  it('the traceback frames\' functions come first, then the Jev anchors, de-duplicated by span', () => {
    const tb = 'Traceback (most recent call last):\n  File "/ws/src/calc.py", line 4, in add\n    return a + b\nTypeError: x\n';
    const { listings, frames } = listingsFor(files, loc(), tb);
    expect(frames).toEqual([{ path: 'src/calc.py', line: 4, fn: 'add' }]);
    expect(listings.map((l) => [l.name, l.origin])).toEqual([['add', 'traceback']]);
    const widened = listingsFor(files, loc(), null, { needPaths: ['src/util.py'], widen: 2 });
    expect(widened.listings.map((l) => l.path)).toEqual(['src/util.py', 'src/calc.py']);
    expect(widened.listings[1]).toMatchObject({ name: 'add', origin: 'jev' });
  });
});

describe('createSearchLlm.fire', () => {
  it('fires a round with the live-finding request shape, charges the step counters, and lands LLM candidates anchored on the committed base', async () => {
    const { ctx, mem, goal, gen } = setup('adapter-fire');
    const llm = createSearchLlm({ pricing: LLM_SERVED_PRICING });
    const round = llm.fire(ctx, mem, goal, loc(), { round: 1, stagger: false });
    expect(round).not.toBeNull();
    if (round === null) return;
    expect(round).toMatchObject({ goalId: goal.id, round: 1, klass: 'quixbugs', n: 4, staggered: false });
    // §10.2 finding (a): reasoning at low effort (never `enabled: false`), the forced tool, N = 4 concurrent requests
    expect(gen.calls()).toBe(4);
    for (const req of gen.requests()) expect(req).toMatchObject({ reasoning: { effort: 'low' }, toolChoice: { name: 'propose_fix' }, providerPrefs: { requireParameters: true } });
    expect(gen.requests()[0]!.messages[0]!.content).toContain('## Localisation');
    expect(gen.requests()[0]!.messages[0]!.content).toContain('src/calc.py:L4');
    const arrivals = await round.rest();
    expect(arrivals).toHaveLength(4);
    const withCands = arrivals.filter((a) => a.candidates.length > 0);
    // the four samples returned the same patch: one candidate, three folded duplicates
    expect(withCands).toHaveLength(1);
    const c = withCands[0]!.candidates[0]!;
    expect(c.source).toBe('llm');
    expect(c.site.file).toBe(calc);
    expect(c.site.span).toBeDefined();
    expect(c.text.trim()).toBe('return (a or 0) + b');
    expect(round.closed()).toBe(true);
    expect(round.summary()).toMatchObject({ fired: 4, valid: 4, distinct: 1, duplicates: 3, closed: true });
    // the step's LLM counters were charged through the budget view; the run's spend is known to the controller
    expect(mem.stepBudget.llmRoundsLeft).toBe(1);
    expect(mem.stepBudget.llmSamplesLeft).toBe(4);
    expect(mem.stepBudget.llmUsdLeft).toBeLessThan(0.02);
    expect(llm.spentUsd('adapter-fire')).toBeCloseTo(4 * ((3000 * 0.15 + 200 * 0.5) / 1e6), 9);
    expect(llm.spentUsd('other-run')).toBe(0);
    expect(llm.exportCache('adapter-fire')).not.toBeNull();
    await llm.stepEnd(ctx);
    // the ledger helpers: arrivals without drops add nothing; `need` paths are collected in order
    expect(attemptsFromArrival(arrivals[0]!, 3)).toEqual([]);
    expect(needPathsOf(arrivals)).toEqual([]);
    recordAttempts(mem, goal.id, [{ op: 'sample_0_0', step: 3, diffHead: '+x', verdict: 'unchanged', sha: 'abc' }]);
    expect(llmMemory(mem).attempts.get(goal.id)).toHaveLength(1);
  });

  it('skips the round when the counters are spent or the context has no generator, with a transcript note', () => {
    const { ctx, mem, goal } = setup('adapter-skip');
    const llm = createSearchLlm();
    mem.stepBudget.llmRoundsLeft = 0;
    expect(llm.fire(ctx, mem, goal, loc(), { round: 1 })).toBeNull();
    const note = ctx.events.find((e) => e.type === 'synth' && e.phase === 'llm:fire');
    expect(note?.type === 'synth' ? note.detail : '').toMatch(/skipped \(LLM counters spent/);
    const { generate: _omitted, ...noGenerate } = ctx;
    expect(llm.fire(noGenerate, mem, goal, loc(), { round: 1 })).toBeNull();
    expect(llm.fire(ctx, { ...mem, bases: [] }, goal, loc(), { round: 1 })).toBeNull();
  });

  it('the budget view follows a budget re-installed within the step: samples landing after a re-baseline charge the fresh counters (§4.11 step cap)', async () => {
    const { ctx, mem, goal } = setup('adapter-rebudget');
    const llm = createSearchLlm({ pricing: LLM_SERVED_PRICING });
    const first = mem.stepBudget;
    const round = llm.fire(ctx, mem, goal, loc(), { round: 1, stagger: false });
    expect(round).not.toBeNull();
    if (round === null) return;
    // the round and its four samples are charged at fire time, on the budget installed then
    expect(first.llmRoundsLeft).toBe(1);
    expect(first.llmSamplesLeft).toBe(4);
    // a re-baseline (the repository step-1 overlap, §7.1) replaces the step budget while the samples are in flight
    const fresh = fakeBudget({ llmRounds: 1, llmSamples: 4, llmUsd: 0.02 });
    mem.stepBudget = fresh;
    await round.rest();
    expect(first.llmUsdLeft).toBe(0.02);
    expect(fresh.llmUsdLeft).toBeCloseTo(0.02 - 4 * ((3000 * 0.15 + 200 * 0.5) / 1e6), 9);
    await llm.stepEnd(ctx);
  });

  it('spent counters still replay the site cache (§4.2 "re-queued first"): a later fire for the same listing returns the cached untried candidates as a round of its own, without a generation', async () => {
    const { ctx, mem, goal, gen } = setup('adapter-replay');
    const llm = createSearchLlm({ pricing: LLM_SERVED_PRICING });
    const first = llm.fire(ctx, mem, goal, loc(), { round: 1, stagger: false });
    expect(first).not.toBeNull();
    if (first === null) return;
    expect((await first.rest()).flatMap((a) => a.candidates)).toHaveLength(1);
    // the next step: the round counter is spent, but the cache holds one untried candidate for this listing
    mem.stepBudget.llmRoundsLeft = 0;
    const replay = llm.fire(ctx, mem, goal, loc(), { round: 1, stagger: false });
    expect(replay).not.toBeNull();
    if (replay === null) return;
    expect(replay).toMatchObject({ round: 1, n: 1, staggered: false });
    expect(replay.deadlineLeftMs()).toBeGreaterThan(0);
    const arrivals = await replay.rest();
    expect(arrivals.map((a) => [a.sample, a.status])).toEqual([[-1, 'cached']]);
    expect(arrivals[0]!.candidates.map((c) => c.text.trim())).toEqual(['return (a or 0) + b']);
    expect(replay.closed()).toBe(true);
    expect(gen.calls()).toBe(4);
    await llm.stepEnd(ctx);
  });

  it('recordSpend adds an out-of-round spend (the L2 writer, §4.10) to the run total the step cap reads', () => {
    const { ctx } = setup('adapter-spend');
    const llm = createSearchLlm();
    expect(llm.spentUsd('adapter-spend')).toBe(0);
    llm.recordSpend(ctx, 0.004);
    llm.recordSpend(ctx, Number.NaN);
    expect(llm.spentUsd('adapter-spend')).toBeCloseTo(0.004, 12);
  });
});
