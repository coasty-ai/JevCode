/**
 * OOS iteration 2, question 2: the zero-token timeouts of iteration 1 and the two invariants the
 * back-off was missing.
 *
 * The records (`bench/results/iter1-<arm>/runs/<id>/generator.jsonl`, 2026-09-22). On the fresh
 * 18-task slice 135 of 290 `propose_fix` samples ended `stopReason:"timeout"` and they cost
 * 3,501 s of 5,506 sample-seconds. The timeout latencies fall in exactly three buckets — 68 at
 * ~20 s, 48 at ~30 s, 10 at ~45 s — the class default and its 1.5× growths; 61 of the 135 fired
 * at a GROWN deadline and cost 1,994 s, while the whole slice served only 11 samples slower than
 * 20 s. All four SWE runs served 0 samples of 7
 * (`iter1-fresh-llm-jev-swebench/runs/20260922-120656-xhmcqzon`: `generator.valid: 0`,
 * `timeouts: 7`, latencies 20/20/20/30/30/30/30 s).
 *
 * Two invariants follow, and neither was pinned:
 *
 *  (1) The served p90 — the adaptive deadline's only input — must never count a sample the
 *      provider did not serve. It does not today (`handleEnd` pushes `servedMs` on `result`
 *      alone), and this pins it so a later edit cannot quietly pollute it: a run of nothing but
 *      zero-token timeouts must leave the deadline at the class default, never below it.
 *
 *  (2) A zero-token timeout must never be followed by a SHORTER deadline for that goal. It can
 *      be today: `fire` recomputes the round's base from the running served p90 every time
 *      (`sampleDeadlineMs`), and the growth is a factor on that MOVING base — so a goal that has
 *      already proved a deadline too short drops back below it the moment the base falls (the
 *      served p90 falling as fast samples accumulate, or a caller that pinned a high round-1
 *      deadline and does not pin the next). The deadline a zero-token timeout fired at is a
 *      high-water mark for that goal.
 *
 * The deadlines here are scaled to milliseconds through the pinnable `sampleDeadline` object
 * (`LlmSourceDeps.generation`), which is what the bench arms pin too: the rule is a comparison
 * between deadlines, so the unit is free and the test does not wait 20 real seconds.
 */
import { describe, expect, it } from 'vitest';

import {
  LLM_DEADLINE_ADAPT,
  LLM_DEFAULT_GENERATION,
  LLM_SAMPLE_DEADLINE,
  LLM_TIMEOUT_BACKOFF,
  backedOffDeadlineMs,
  classDeadlineMs,
  createLlmSource,
  deadlineCeilingMs,
  type LlmBudget,
  type LlmFireInput,
  type LlmSource,
} from '../../../../../src/jev-modes/synth/llm/source.js';
import { listingSet } from '../../../../../src/jev-modes/synth/llm/prompt.js';
import type { SynthesizerGeneration } from '../../../../../src/core/types.js';
import type { GenerateFn } from '../../../../../src/jev-modes/synth/llm/types.js';
import { calcFiles, proposeFixCall, scriptedGenerate } from './fixtures.js';

const files = calcFiles();
const listings = listingSet({ files, frames: [{ path: 'src/calc.py', line: 4 }], anchors: [] });
const PRICING = { inputPerM: 0.5, outputPerM: 2 };
const FIX = [{ old: '    return a + b', new: '    return (a or 0) + b', near_line: 4 }];
/** the three recorded buckets (20 s / 30 s / 45 s) in milliseconds, so the run is a run and not a wait */
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

describe('question 2 (1): the served p90 counts served samples only', () => {
  it('a run of nothing but zero-token timeouts never pulls a deadline BELOW the class default', async () => {
    const src = createLlmSource({ generate: hanging, pricing: PRICING, generation: GEN });
    const b = budget();
    const fired: number[] = [];
    for (let round = 1; round <= 4; round++) {
      const r = src.fire(fireInput(b, { round }));
      if (r.fired) fired.push(r.deadlineMs);
      await drain(src);
    }
    expect(fired).toHaveLength(4);
    // a timeout is not evidence that the provider is fast: every fire is at or above the class default
    expect(fired.every((ms) => ms >= classDeadlineMs('quixbugs', SCALED))).toBe(true);
    expect(fired[0]).toBe(classDeadlineMs('quixbugs', SCALED));
    // the p90 input stayed empty because nothing was served
    expect(src.p90ServedMs()).toBeNull();
    // and the recorded default really is 20 s / 30 s, which is what makes a dead sample expensive
    expect(LLM_SAMPLE_DEADLINE).toEqual({ minMs: 10_000, maxMs: 20_000, repositoryMs: 30_000 });
  });

  it('a served sample IS counted, and `minSamples` of them are what the adaptation needs', async () => {
    const served = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX]), usage: { inputTokens: 900, outputTokens: 120 } }));
    const src = createLlmSource({ generate: served.generate, pricing: PRICING, generation: GEN });
    const b = budget();
    const r = src.fire(fireInput(b, { n: 3, deadlineMs: 5_000 }));
    expect(r).toMatchObject({ fired: true });
    const arrivals = await src.collectAll();
    expect(arrivals.filter((a) => a.status === 'valid' || a.status === 'empty' || a.status === 'malformed').length).toBeGreaterThanOrEqual(LLM_DEADLINE_ADAPT.minSamples);
    expect(LLM_DEADLINE_ADAPT.minSamples).toBe(2);
    expect(src.p90ServedMs()).not.toBeNull();
  });
});

describe('question 2 (2): a zero-token timeout is a high-water mark for that goal`s deadline', () => {
  it('a goal whose round timed out at the grown deadline never fires shorter again, however the base moves', async () => {
    const src = createLlmSource({ generate: hanging, pricing: PRICING, generation: GEN });
    const b = budget();
    // round 1 fires at the adaptive deadline of a slow start (the caller pins what `sampleDeadlineMs`
    // computed) and times out with nothing served
    const first = src.fire(fireInput(b, { deadlineMs: 400 }));
    expect(first).toMatchObject({ fired: true, deadlineMs: 400 });
    await drain(src);
    expect(src.timeoutBackoff('g1')).toMatchObject({ growths: 1 });
    // round 2 recomputes the base from a served p90 that is still empty: 20 × 1.5 = 30, far BELOW
    // the 400 this very goal has already proved too short
    expect(backedOffDeadlineMs('quixbugs', classDeadlineMs('quixbugs', SCALED), 1)).toBe(30);
    const second = src.fire(fireInput(b, { round: 2 }));
    expect(second.fired).toBe(true);
    if (second.fired) expect(second.deadlineMs).toBeGreaterThanOrEqual(400);
    await drain(src);
  });

  it('the mark is per goal: another goal of the same run still starts at its class default', async () => {
    const src = createLlmSource({ generate: hanging, pricing: PRICING, generation: GEN });
    const b = budget();
    src.fire(fireInput(b, { deadlineMs: 400 }));
    await drain(src);
    const other = src.fire(fireInput(b, { goalId: 'g2' }));
    expect(other).toMatchObject({ fired: true, deadlineMs: classDeadlineMs('quixbugs', SCALED) });
    await drain(src);
  });

  it('the mark never lifts a goal past its sampling class ceiling', async () => {
    const src = createLlmSource({ generate: hanging, pricing: PRICING, generation: GEN });
    const b = budget();
    // a pinned deadline already above the ceiling is clamped by it, and so is the mark it leaves
    const first = src.fire(fireInput(b, { deadlineMs: deadlineCeilingMs('quixbugs') * 2 }));
    expect(first).toMatchObject({ fired: true, deadlineMs: deadlineCeilingMs('quixbugs') });
    // nothing here waits for that deadline: the round is abandoned and a new goal is measured instead
    const other = src.fire(fireInput(b, { goalId: 'g3' }));
    expect(other).toMatchObject({ fired: true, deadlineMs: classDeadlineMs('quixbugs', SCALED) });
    await drain(src);
    expect(LLM_TIMEOUT_BACKOFF.factor).toBe(1.5);
  });
});
