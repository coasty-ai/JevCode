/**
 * OOS iteration 3, item 3 — `JEVCODE_DEADLINE_GROWTH=served|always`, the A/B flag for iteration 2's
 * counter-hypothesis.
 *
 * The records (experiments/results/llm-jev-iter1.md §6 change 3, and the counts
 * docs/research/llm-jev's iteration-2 note took from the archived `generator.jsonl` of every
 * `bench/results/iter1-<arm>` run):
 * on the fresh 18-task slice 135 of 290 samples ended `stopReason:"timeout"` with
 * `usage.outputTokens: 0`, **61 of them fired at an ALREADY-GROWN deadline and cost 1,994 s**, and
 * over the whole slice **only 11 samples were ever SERVED slower than 20 s**. So the growth rule
 * shipped by iteration 2 — a timeout raises the goal's high-water mark — spent 1,994 s buying a
 * longer wait from a provider that was not answering, and the evidence that longer waits pay is
 * thin (11 samples).
 *
 * That is a hypothesis, not a finding, so it lands as a flag with today's behaviour as the DEFAULT:
 *
 *   - `always` (default, `JEVCODE_DEADLINE_GROWTH` unset): a zero-token timeout books a growth and
 *     raises the goal's floor — byte-identical to what iteration 2 shipped;
 *   - `served`: a timeout books neither; the ONLY thing that raises the goal's floor is a sample
 *     the provider actually served at a latency past the current floor.
 *
 * The streak and the round pause are the same in both, so an A/B moves the deadline and nothing
 * else. Deadlines are scaled to milliseconds through the pinnable `sampleDeadline` object, as in
 * source-deadline-floor.test.ts, so the test is a run and not a wait.
 */
import { describe, expect, it } from 'vitest';

import {
  DEADLINE_GROWTH_ENV_FLAG,
  DEFAULT_DEADLINE_GROWTH,
  LLM_DEFAULT_GENERATION,
  LLM_TIMEOUT_BACKOFF,
  createLlmSource,
  deadlineCeilingMs,
  deadlineGrowthFrom,
  type LlmBudget,
  type LlmFireInput,
  type LlmSource,
} from '../../../../src/synth/llm/source.js';
import { listingSet } from '../../../../src/synth/llm/prompt.js';
import type { SynthesizerGeneration } from '../../../../src/core/types.js';
import type { GenerateFn } from '../../../../src/synth/llm/types.js';
import { calcFiles, proposeFixCall, scriptedGenerate } from './fixtures.js';

const files = calcFiles();
const listings = listingSet({ files, frames: [{ path: 'src/calc.py', line: 4 }], anchors: [] });
const PRICING = { inputPerM: 0.5, outputPerM: 2 };
const FIX = [{ old: '    return a + b', new: '    return (a or 0) + b', near_line: 4 }];
/** the recorded 20 s / 30 s / 45 s buckets, in milliseconds */
const SCALED: SynthesizerGeneration['sampleDeadline'] = { minMs: 10, maxMs: 20, repositoryMs: 30 };
const GEN: SynthesizerGeneration = { ...LLM_DEFAULT_GENERATION, sampleDeadline: SCALED };

function budget(over: Partial<LlmBudget> = {}): LlmBudget {
  return { roundsLeft: 8, samplesLeft: 20, usdLeft: 0.4, ...over };
}

function fireInput(b: LlmBudget, over: Partial<LlmFireInput> = {}): LlmFireInput {
  return { goalId: 'g1', step: 3, round: 1, klass: 'quixbugs', system: 'sys', userFor: (k) => `user ${k}`, files, listings, signal: new AbortController().signal, budget: b, stagger: false, n: 1, ...over };
}

/** A generate that never answers: the deadline aborts it with nothing produced (the recorded `cancelled: true` shape). */
const hanging: GenerateFn = (_req, o) =>
  new Promise((_resolve, reject) => {
    o.signal.addEventListener('abort', () => reject(o.signal.reason instanceof Error ? o.signal.reason : new Error('aborted')));
  });

async function drain(src: LlmSource): Promise<void> {
  await src.collectAll();
}

/** A clock the test advances by hand, so a SERVED sample has an exact latency. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('the flag itself', () => {
  it('`JEVCODE_DEADLINE_GROWTH` defaults to `always`, reads `served`, and treats anything else as the default', () => {
    expect(DEADLINE_GROWTH_ENV_FLAG).toBe('JEVCODE_DEADLINE_GROWTH');
    expect(DEFAULT_DEADLINE_GROWTH).toBe('always');
    expect(deadlineGrowthFrom({})).toBe('always');
    expect(deadlineGrowthFrom({ [DEADLINE_GROWTH_ENV_FLAG]: 'served' })).toBe('served');
    expect(deadlineGrowthFrom({ [DEADLINE_GROWTH_ENV_FLAG]: 'always' })).toBe('always');
    // a typo is the default, never an error and never `served`: the A/B arm must be opted into explicitly
    expect(deadlineGrowthFrom({ [DEADLINE_GROWTH_ENV_FLAG]: 'Served' })).toBe('always');
    expect(deadlineGrowthFrom({ [DEADLINE_GROWTH_ENV_FLAG]: '' })).toBe('always');
    // the source echoes the arm it ran under, so a record can name it
    expect(createLlmSource({ generate: hanging, deadlineGrowth: 'served' }).deadlineGrowth()).toBe('served');
    expect(createLlmSource({ generate: hanging }).deadlineGrowth()).toBe('always');
  });
});

describe('`always` (the default) is iteration 2 unchanged', () => {
  it('a zero-token timeout books a growth and the goal floor; a second round of the goal waits ×1.5 and never falls back below what it proved', async () => {
    const src = createLlmSource({ generate: hanging, pricing: PRICING, generation: GEN, deadlineGrowth: 'always' });
    const b = budget();
    expect(src.fire(fireInput(b, { deadlineMs: 20 }))).toMatchObject({ fired: true, deadlineMs: 20 });
    await drain(src);
    expect(src.timeoutBackoff('g1')).toMatchObject({ growths: 1, floorMs: 20, streak: 1 });
    // the next round waits 1.5 × 20 = 30 ms even though the caller pins nothing and nothing was served
    expect(src.fire(fireInput(b, { round: 2 }))).toMatchObject({ fired: true, deadlineMs: 30 });
    await drain(src);
    expect(src.timeoutBackoff('g1')).toMatchObject({ growths: 2, floorMs: 30 });
  });
});

describe('`served`: only a sample the provider actually served grows the deadline', () => {
  it('a run of nothing but zero-token timeouts never grows anything — the 61 grown-deadline timeouts of the slice would have fired at the class default', async () => {
    const src = createLlmSource({ generate: hanging, pricing: PRICING, generation: GEN, deadlineGrowth: 'served' });
    const b = budget();
    expect(src.fire(fireInput(b, { deadlineMs: 20 }))).toMatchObject({ fired: true, deadlineMs: 20 });
    await drain(src);
    // no growth, no floor — the timeout served nothing, so it is evidence for nothing
    expect(src.timeoutBackoff('g1')).toMatchObject({ growths: 0, floorMs: 0 });
    // and the streak is untouched, so the A/B moves the deadline and nothing else
    expect(src.timeoutBackoff('g1').streak).toBe(1);
    expect(src.fire(fireInput(b, { round: 2 }))).toMatchObject({ fired: true, deadlineMs: SCALED.maxMs });
    await drain(src);
    expect(src.timeoutBackoff('g1')).toMatchObject({ growths: 0, floorMs: 0, streak: 0, paused: true });
    expect(LLM_TIMEOUT_BACKOFF.pauseAfter).toBe(2);
  });

  it('a SERVED sample past the current mark raises it, and a faster one never lowers it', async () => {
    const c = clock();
    let latency = 37;
    const scripted = scriptedGenerate(() => {
      c.advance(latency);
      return { toolCall: proposeFixCall([FIX]), usage: { inputTokens: 900, outputTokens: 120 } };
    });
    const src = createLlmSource({ generate: scripted.generate, pricing: PRICING, generation: GEN, now: c.now, deadlineGrowth: 'served' });
    const b = budget();
    src.fire(fireInput(b, { deadlineMs: 1_000 }));
    await drain(src);
    // served after 37 ms: a deadline below that would have killed a sample that was going to answer
    expect(src.timeoutBackoff('g1')).toMatchObject({ growths: 0, floorMs: 37 });
    latency = 5;
    src.fire(fireInput(b, { round: 2, deadlineMs: 1_000 }));
    await drain(src);
    // the mark is a HIGH-water mark: a fast sample is not evidence the goal can go back to being quick
    expect(src.timeoutBackoff('g1')).toMatchObject({ floorMs: 37 });
    // and it is per goal, like the growths
    expect(src.timeoutBackoff('g2')).toMatchObject({ floorMs: 0 });
  });

  it('the mark can never take a goal past its sampling class ceiling', async () => {
    const c = clock();
    const scripted = scriptedGenerate(() => {
      c.advance(deadlineCeilingMs('quixbugs') * 3);
      return { toolCall: proposeFixCall([FIX]), usage: { inputTokens: 900, outputTokens: 120 } };
    });
    const src = createLlmSource({ generate: scripted.generate, pricing: PRICING, generation: GEN, now: c.now, deadlineGrowth: 'served' });
    src.fire(fireInput(budget(), { deadlineMs: 10 ** 7 }));
    await drain(src);
    expect(src.timeoutBackoff('g1').floorMs).toBe(deadlineCeilingMs('quixbugs'));
  });

  it('under `always` a served sample changes no mark: the two arms read different evidence, which is what the A/B compares', async () => {
    const c = clock();
    const scripted = scriptedGenerate(() => {
      c.advance(37);
      return { toolCall: proposeFixCall([FIX]), usage: { inputTokens: 900, outputTokens: 120 } };
    });
    const src = createLlmSource({ generate: scripted.generate, pricing: PRICING, generation: GEN, now: c.now, deadlineGrowth: 'always' });
    src.fire(fireInput(budget(), { deadlineMs: 1_000 }));
    await drain(src);
    expect(src.timeoutBackoff('g1')).toMatchObject({ growths: 0, floorMs: 0 });
  });
});
