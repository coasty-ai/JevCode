/**
 * search/llm.ts over a scripted generator, the two behaviours llm-adapter.test.ts does not cover: a round the rate
 * limiter refused whole (`LlmRoundSummary.rateLimitedRound`) is refunded to the step's LLM counters at its end —
 * `llm:round … rate-limited, refunded` — and re-fires, i.e. it is not exhausted, while a round with one served sample is
 * not refunded; and the source's transcript lines (`llm:fire`, `llm:sample`, `llm:round`) are logged under the step that
 * is current when they are emitted (the source is built once per run), not under the step it was built in.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { EngineEvent } from '../../../../src/core/types.js';
import { ProviderHttpError } from '../../../../src/errors.js';
import type { GenerateFn } from '../../../../src/synth/llm/types.js';
import { LLM_SERVED_PRICING, createSearchLlm } from '../../../../src/synth/search/llm.js';
import type { LocalizeResult } from '../../../../src/synth/types.js';
import { fakeBudget, fakeCtx, fakeGoal, fakeMemory, fastOracle, siteAt, summary } from '../search/controller-fakes.js';
import { fakeSandbox } from '../sieve/helpers.js';
import { calcFiles, proposeFixCall, scriptedGenerate } from './fixtures.js';

const files = calcFiles();
const calc = files.get('src/calc.py')!;
const util = files.get('src/util.py')!;
const TEST = 'tests/test_calc.py::test_add_none';
const runDir = mkdtempSync(join(tmpdir(), 'llm-search-'));
afterAll(() => rmSync(runDir, { recursive: true, force: true }));

const FIX = [{ old: '    return a + b', new: '    return (a or 0) + b', near_line: 4 }];
type SynthEvent = Extract<EngineEvent, { type: 'synth' }>;

function loc(): LocalizeResult {
  const site = siteAt(calc, 4);
  site.evidence.jevProbability = 0.95;
  return { files: [{ path: 'src/calc.py', probability: 0.9 }], functions: [], sites: [site], requests: 0 };
}

function served(): ReturnType<typeof scriptedGenerate> {
  return scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX]), usage: { inputTokens: 3000, outputTokens: 200 } }));
}

/** Every attempt answered HTTP 429: the chain gives up with the 429 (provider/sse.ts withRetry rethrows the last ProviderHttpError). */
function refused(): { generate: GenerateFn; calls: () => number } {
  let n = 0;
  return {
    generate: () => {
      n += 1;
      return Promise.reject(new ProviderHttpError('HTTP 429: rate limited', { status: 429, retryable: true }));
    },
    calls: () => n,
  };
}

function setup(runId: string, generate: GenerateFn): { ctx: ReturnType<typeof fakeCtx>; mem: ReturnType<typeof fakeMemory>; goal: ReturnType<typeof fakeGoal> } {
  const base = fakeCtx({ runId, task: 'add(None, 2) should return 2' });
  const ctx = { ...base, runDir, generate, sandbox: fakeSandbox() };
  const mem = fakeMemory([calc, util], summary({ command: 'pytest -q', failing: [TEST], passing: [] }), { oracle: fastOracle(), stepBudget: fakeBudget({ llmRounds: 2, llmSamples: 8, llmUsd: 0.02 }) });
  const goal = fakeGoal({ tests: [TEST], failures: [{ testId: TEST, call: 'add(None, 2)', expected: '2', actual: "TypeError: unsupported operand type(s) for +: 'NoneType' and 'int'" }], suspectedFiles: ['src/calc.py'] });
  return { ctx, mem, goal };
}

const llmEvents = (events: readonly EngineEvent[]): SynthEvent[] => events.filter((e): e is SynthEvent => e.type === 'synth' && e.phase.startsWith('llm:'));

describe('a rate-limited round is refunded and is not exhausted (§4.13)', () => {
  it('every sample answered HTTP 429: at the round\'s end the round and its samples return to the step\'s counters, the dollars never moved, a `rate-limited, refunded` line is logged, and the same goal fires again', async () => {
    const gen = refused();
    const { ctx, mem, goal } = setup('search-429', gen.generate);
    const llm = createSearchLlm({ pricing: LLM_SERVED_PRICING });
    const round = llm.fire(ctx, mem, goal, loc(), { round: 1, stagger: false });
    expect(round).not.toBeNull();
    if (round === null) return;
    // taken at fire: the round and its four samples
    expect(gen.calls()).toBe(4);
    expect(mem.stepBudget.llmRoundsLeft).toBe(1);
    expect(mem.stepBudget.llmSamplesLeft).toBe(4);
    const arrivals = await round.rest();
    expect(arrivals.map((a) => [a.status, a.rateLimited, a.usd])).toEqual([
      ['error', true, 0],
      ['error', true, 0],
      ['error', true, 0],
      ['error', true, 0],
    ]);
    expect(round.closed()).toBe(true);
    expect(round.summary()).toMatchObject({ fired: 4, errors: 4, rateLimited: 4, rateLimitedRound: true, closed: true, usd: 0 });
    // refunded before the loop saw the end (`rest()` resolved after the hook): the counters read as before the fire
    expect(mem.stepBudget.llmRoundsLeft).toBe(2);
    expect(mem.stepBudget.llmSamplesLeft).toBe(8);
    expect(mem.stepBudget.llmUsdLeft).toBe(0.02);
    expect(llm.spentUsd('search-429')).toBe(0);
    const refunded = llmEvents(ctx.events).filter((e) => e.phase === 'llm:round' && /rate-limited, refunded/.test(e.detail));
    expect(refunded).toHaveLength(1);
    expect(refunded[0]!.detail).toMatch(/^g\d+ round 1: rate-limited, refunded — every fired sample \(4\) was answered HTTP 429 and nothing was served \(\$0 booked\); the round and its 4 samples return to the step's LLM counters \(2 rounds, 8 samples, \$0\.0200 left\); not exhausted — the next step re-fires$/);
    // not exhausted: nothing was cached (no candidate was seen), so the same goal generates again on the refunded counters
    expect(llm.exportCache('search-429')).toEqual({});
    const again = llm.fire(ctx, mem, goal, loc(), { round: 1, stagger: false });
    expect(again).not.toBeNull();
    if (again === null) return;
    expect(gen.calls()).toBe(8);
    await again.rest();
    expect(mem.stepBudget.llmRoundsLeft).toBe(2);
    expect(mem.stepBudget.llmSamplesLeft).toBe(8);
    await llm.stepEnd(ctx);
  });

  it('one served sample among three refused: the round did its work — no refund, no `refunded` line', async () => {
    const ok = served();
    const generate: GenerateFn = (req, o) => (o.sample === 0 ? ok.generate(req, o) : Promise.reject(new ProviderHttpError('HTTP 429: rate limited', { status: 429, retryable: true })));
    const { ctx, mem, goal } = setup('search-429-mixed', generate);
    const llm = createSearchLlm({ pricing: LLM_SERVED_PRICING });
    const round = llm.fire(ctx, mem, goal, loc(), { round: 1, stagger: false });
    expect(round).not.toBeNull();
    if (round === null) return;
    const arrivals = await round.rest();
    expect(arrivals.filter((a) => a.status === 'valid')).toHaveLength(1);
    expect(round.summary()).toMatchObject({ fired: 4, valid: 1, errors: 3, rateLimited: 3, rateLimitedRound: false, closed: true });
    expect(mem.stepBudget.llmRoundsLeft).toBe(1);
    expect(mem.stepBudget.llmSamplesLeft).toBe(4);
    // only the served sample was charged; the refused ones cost nothing
    expect(0.02 - mem.stepBudget.llmUsdLeft).toBeCloseTo((3000 * 0.15 + 200 * 0.5) / 1e6, 12);
    expect(llmEvents(ctx.events).some((e) => /refunded/.test(e.detail))).toBe(false);
    await llm.stepEnd(ctx);
  });
});

describe('the source outlives the step: transcript lines land under the current step', () => {
  it('a round fired from a later step logs its llm:fire / llm:sample / llm:round lines under that step, not under the step the source was built in', async () => {
    const gen = served();
    const { ctx: first, mem, goal } = setup('search-steps', gen.generate);
    const llm = createSearchLlm({ pricing: LLM_SERVED_PRICING });
    const r1 = llm.fire(first, mem, goal, loc(), { round: 1, stagger: false });
    expect(r1).not.toBeNull();
    if (r1 === null) return;
    await r1.rest();
    const step1 = llmEvents(first.events);
    expect(step1.map((e) => e.phase)).toEqual(expect.arrayContaining(['llm:fire', 'llm:sample', 'llm:round']));
    expect(new Set(step1.map((e) => e.step))).toEqual(new Set([first.step]));
    const before = first.events.length;
    // the next step: its own context (same run, same event sink) and a fresh step budget; the feedback round keys a new cache entry
    const second = { ...first, step: first.step + 2 };
    mem.stepBudget = fakeBudget({ llmRounds: 2, llmSamples: 8, llmUsd: 0.02 });
    const r2 = llm.fire(second, mem, goal, loc(), { round: 2, stagger: false });
    expect(r2).not.toBeNull();
    if (r2 === null) return;
    await r2.rest();
    const step2 = llmEvents(first.events.slice(before));
    expect(step2.map((e) => e.phase)).toEqual(expect.arrayContaining(['llm:fire', 'llm:sample', 'llm:round']));
    expect(step2.length).toBeGreaterThanOrEqual(6);
    expect(new Set(step2.map((e) => e.step))).toEqual(new Set([second.step]));
    // and the first step's lines were not relabelled
    expect(new Set(llmEvents(first.events.slice(0, before)).map((e) => e.step))).toEqual(new Set([first.step]));
    await llm.stepEnd(second);
  });
});

/**
 * contract 1.4 (COORDINATION-DESIGN §8.8 column 3) / TUI-DESIGN-5 §8.2 R13: the controller threads the engine's
 * relaxed view from `SynthesisContext.contextText` onto `LlmFireInput.contextText`, which is what puts it in every
 * sample's user message. Absent on the context = absent on the fire input = the message the round sent before.
 */
describe('§8.8 column 3: the relaxed view reaches the sample prompt', () => {
  it('ctx.contextText rides into every sample; without it the message is unchanged', async () => {
    const view = '# Step 3\n\n## Task\nadd(None, 2) should return 2\n\n## Recent steps (last 1, oldest first)\n### step 2: run pytest -q';
    const withView = served();
    const a = setup('search-ctx-on', withView.generate);
    const llmA = createSearchLlm({ pricing: LLM_SERVED_PRICING });
    const r1 = llmA.fire({ ...a.ctx, contextText: view }, a.mem, a.goal, loc(), { round: 1, stagger: false });
    expect(r1).not.toBeNull();
    if (r1 === null) return;
    await r1.rest();
    const sent = withView.requests();
    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent) {
      const content = req.messages[0]!.content;
      expect(content).toContain(view);
      expect(content.indexOf('## Code')).toBeLessThan(content.indexOf(view));
      expect(content.indexOf(view)).toBeLessThan(content.indexOf('## Reply'));
    }
    await llmA.stepEnd(a.ctx);

    const without = served();
    const b = setup('search-ctx-off', without.generate);
    const llmB = createSearchLlm({ pricing: LLM_SERVED_PRICING });
    const r2 = llmB.fire(b.ctx, b.mem, b.goal, loc(), { round: 1, stagger: false });
    expect(r2).not.toBeNull();
    if (r2 === null) return;
    await r2.rest();
    const plain = without.requests()[0]!.messages[0]!.content;
    expect(plain).not.toContain('Harness context');
    expect(plain.endsWith('## Reply\nCall `propose_fix`.')).toBe(true);
    await llmB.stepEnd(b.ctx);
  });
});
