/**
 * §4.8 rev 4 — the zero-token-timeout back-off (ranked change 3 of
 * docs/research/llm-jev/oos-analysis-2026-09-22.md).
 *
 * Evidence, from the `generator.jsonl` of the archived OOS runs: 82 of 244 ladder `propose_fix`
 * calls and 51 of 130 SWE ones ended `stopReason:"timeout"` with `usage.outputTokens: 0` — 1,170 s
 * of 2,423 s of ladder generator sample-time and 1,532 s of 2,538 s of SWE's — every one of them
 * re-fired at the same ~10 s adaptive deadline because the served p90 (§4.8 rev 3) counts SERVED
 * samples only and these were never served. The records below are the exact shape those lines have
 * (`20260922-055835-jrb5hkbr` line 4: `{"stopReason":"timeout","usage":{"inputTokens":1268,
 * "outputTokens":0,"costUsd":0.000179…,"calls":1,"estimated":true},"latencyMs":10285.32,
 * "cancelled":true}`), reproduced through a generate that never answers.
 */
import { describe, expect, it } from 'vitest';

import type { CancelledGeneration } from '../../../../src/core/types.js';
import {
  pausedSampleCount,
  LLM_DEADLINE_ADAPT,
  LLM_TIMEOUT_BACKOFF,
  backedOffDeadlineMs,
  classDeadlineMs,
  createLlmSource,
  deadlineCeilingMs,
  isZeroTokenTimeout,
  type LlmBudget,
  type LlmFireInput,
  type LlmSource,
} from '../../../../src/synth/llm/source.js';
import { listingSet } from '../../../../src/synth/llm/prompt.js';
import type { GenerateFn } from '../../../../src/synth/llm/types.js';
import { calcFiles, proposeFixCall, scriptedGenerate } from './fixtures.js';

const files = calcFiles();
const listings = listingSet({ files, frames: [{ path: 'src/calc.py', line: 4 }], anchors: [] });
const PRICING = { inputPerM: 0.5, outputPerM: 2 };
/** the ~10 s adaptive deadline every one of the recorded zero-token timeouts fired at (`latencyMs` 10,283–10,285 ms) */
const RECORDED_DEADLINE_MS = 10_000;
/** the `n` every `fireInput` below uses unless it says otherwise */
const FIRE_SAMPLES = 1;
const FIX = [{ old: '    return a + b', new: '    return (a or 0) + b', near_line: 4 }];

function budget(over: Partial<LlmBudget> = {}): LlmBudget {
  return { roundsLeft: 6, samplesLeft: 12, usdLeft: 0.2, ...over };
}

function fireInput(b: LlmBudget, over: Partial<LlmFireInput> = {}): LlmFireInput {
  return { goalId: 'g1', step: 3, round: 1, klass: 'quixbugs', system: 'sys', userFor: (k) => `user ${k}`, files, listings, signal: new AbortController().signal, budget: b, deadlineMs: 40, stagger: false, n: 1, ...over };
}

/** A generate that never answers: the deadline aborts it, and `onCancelled` reports `partial` (null = no stream ever opened, the recorded shape). */
function hanging(partial: CancelledGeneration | null = null): GenerateFn {
  return (_req, o) =>
    new Promise((_resolve, reject) => {
      o.signal.addEventListener('abort', () => {
        if (partial !== null) o.onCancelled?.(partial);
        reject(o.signal.reason instanceof Error ? o.signal.reason : new Error('aborted'));
      });
    });
}

async function drain(src: LlmSource): Promise<void> {
  await src.collectAll();
}

describe('§4.8 rev 4: a zero-token timeout is what the served p90 cannot see', () => {
  it('reads the recorded record shape (generator.jsonl 20260922-055835-jrb5hkbr: 27 of 44 calls stopReason timeout, outputTokens 0)', () => {
    // no stream ever opened — the shape of every `cancelled: true` timeout row in the archive
    expect(isZeroTokenTimeout('timeout', null)).toBe(true);
    // the accounting frame arrived with nothing produced
    expect(isZeroTokenTimeout('timeout', { text: '', toolChars: 0, reasoningChars: 0, usage: { inputTokens: 1268, outputTokens: 0, costUsd: 0.000179366379258366, calls: 1, estimated: true } })).toBe(true);
    // partial output: the provider WAS answering, so the deadline is not what is wrong
    expect(isZeroTokenTimeout('timeout', { text: '', toolChars: 120, reasoningChars: 0 })).toBe(false);
    expect(isZeroTokenTimeout('timeout', { text: '', toolChars: 0, reasoningChars: 0, usage: { inputTokens: 1268, outputTokens: 42, costUsd: 0.0002, calls: 1 } })).toBe(false);
    // only a timeout backs the deadline off; a loser cancellation and a provider error say nothing about it
    expect(isZeroTokenTimeout('cancelled', null)).toBe(false);
    expect(isZeroTokenTimeout('error', null)).toBe(false);
    expect(isZeroTokenTimeout('result', null)).toBe(false);
  });

  it('back-off after a zero-token timeout: the deadline sequence is ×1.5 per growth and stops at the sampling class maximum (45 s cheap, 90 s repository)', () => {
    const cheap = [0, 1, 2, 3, 4].map((g) => backedOffDeadlineMs('quixbugs', RECORDED_DEADLINE_MS, g));
    expect(cheap).toEqual([10_000, 15_000, 22_500, 33_750, deadlineCeilingMs('quixbugs')]);
    expect(deadlineCeilingMs('quixbugs')).toBe(LLM_DEADLINE_ADAPT.cheapMaxMs);
    // from the class default the ceiling is three growths away on both classes — the constant's justification
    expect(backedOffDeadlineMs('quixbugs', classDeadlineMs('quixbugs'), 3)).toBe(deadlineCeilingMs('quixbugs'));
    expect(backedOffDeadlineMs('repository', classDeadlineMs('repository'), 3)).toBe(deadlineCeilingMs('repository'));
    expect(backedOffDeadlineMs('repository', 30_000, 4)).toBe(LLM_DEADLINE_ADAPT.repositoryMaxMs);
    // it never shortens a deadline and never keys on anything but the class
    expect(backedOffDeadlineMs('ladder', RECORDED_DEADLINE_MS, 0)).toBe(RECORDED_DEADLINE_MS);
    expect(LLM_TIMEOUT_BACKOFF.factor).toBe(1.5);
  });
});

describe('§4.8 rev 4: the source grows the goal\'s next deadline and pauses it after two consecutive zero-token timeouts', () => {
  it('the NEXT sample of the goal fires at ×1.5, the goal\'s counters are per goal, and a served sample clears the streak', async () => {
    const src = createLlmSource({ generate: hanging(), pricing: PRICING });
    const b = budget();
    expect(src.fire(fireInput(b))).toMatchObject({ fired: true, deadlineMs: 40 });
    await drain(src);
    expect(src.round()).toMatchObject({ timeouts: 1, closed: true });
    expect(src.timeoutBackoff('g1')).toEqual({ streak: 1, growths: 1, paused: false, bookedThisRound: true });
    // another goal is untouched: the back-off is per goal, never per run and never per task
    expect(src.timeoutBackoff('g2')).toEqual({ streak: 0, growths: 0, paused: false, bookedThisRound: false });
    // the goal's next round fires at 1.5 × its base, the other goal's at its base
    expect(src.fire(fireInput(b, { round: 2 }))).toMatchObject({ fired: true, deadlineMs: 60 });
    await drain(src);
    expect(src.fire(fireInput(b, { goalId: 'g2' }))).toMatchObject({ fired: true, deadlineMs: 40 });
    await drain(src);
  });

  it('two CONSECUTIVE zero-token timeouts pause the goal for exactly one round, and the pause clears itself', async () => {
    const events: string[] = [];
    const src = createLlmSource({ generate: hanging(), pricing: PRICING, emit: (phase, detail) => events.push(`${phase}: ${detail}`) });
    const b = budget();
    src.fire(fireInput(b));
    await drain(src);
    expect(src.timeoutBackoff('g1')).toMatchObject({ streak: 1, paused: false });
    src.fire(fireInput(b, { round: 2 }));
    await drain(src);
    // armed at exactly `pauseAfter`, and the streak restarts so the pause cannot repeat every round
    expect(LLM_TIMEOUT_BACKOFF.pauseAfter).toBe(2);
    expect(src.timeoutBackoff('g1')).toEqual({ streak: 0, growths: 2, paused: true, bookedThisRound: true });
    // review finding 10: the backed-off round still FIRES — half the samples, at the grown
    // deadline. `fire(round: 1)` is once per step per goal, so refusing it removed every LLM
    // candidate from the step, on exactly the tasks the back-off exists to rescue.
    const backedOff = src.fire(fireInput(b, { round: 2 }));
    expect(backedOff).toMatchObject({ fired: true, deadlineMs: 90 });
    expect(src.round()?.n).toBe(pausedSampleCount(FIRE_SAMPLES));
    await drain(src);
    expect(events.some((e) => e.startsWith('llm:fire') && /firing \d+ of \d+ samples/.test(e))).toBe(true);
    // ... and it lasted one round: the next round is the full count again
    expect(src.fire(fireInput(b, { round: 3 }))).toMatchObject({ fired: true });
    expect(src.round()?.n).toBe(FIRE_SAMPLES);
    await drain(src);
  });

  /**
   * Review finding 10, the shape that made the change dangerous: a round fires its samples in
   * PARALLEL, so a provider serving nothing returns all of them as zero-token timeouts at once.
   * Per-sample growth took the goal from 20 s to the ceiling on one round and armed the pause at
   * the same instant; per-round growth books one.
   */
  it('five parallel zero-token timeouts in ONE round are one growth, and the next round fires half the samples (review finding 10)', async () => {
    const src = createLlmSource({ generate: hanging(), pricing: PRICING });
    const b = budget();
    expect(src.fire(fireInput(b, { n: 5 }))).toMatchObject({ fired: true, deadlineMs: 40 });
    await drain(src);
    expect(src.round()?.timeouts).toBe(5);
    // five timeouts, ONE growth and ONE streak entry
    expect(src.timeoutBackoff('g1')).toMatchObject({ streak: 1, growths: 1, paused: false });
    // a second empty round arms the halving
    expect(src.fire(fireInput(b, { round: 2, n: 5 }))).toMatchObject({ fired: true, deadlineMs: 60 });
    await drain(src);
    expect(src.timeoutBackoff('g1')).toMatchObject({ streak: 0, growths: 2, paused: true });
    // and the next round fires ceil(5 / 2) = 3 samples — never zero
    expect(src.fire(fireInput(b, { round: 3, n: 5 }))).toMatchObject({ fired: true, deadlineMs: 90 });
    expect(src.round()?.n).toBe(3);
    expect(pausedSampleCount(5)).toBe(3);
    expect(pausedSampleCount(1)).toBe(1);
    expect(pausedSampleCount(0)).toBe(1);
    await drain(src);
  });

  it('a timeout with PARTIAL output does not count toward the pause, and a served sample clears the streak', async () => {
    const streamed: CancelledGeneration = { text: '', toolChars: 320, reasoningChars: 64 };
    const src = createLlmSource({ generate: hanging(streamed), pricing: PRICING });
    const b = budget();
    src.fire(fireInput(b));
    await drain(src);
    src.fire(fireInput(b, { round: 2 }));
    await drain(src);
    // two timeouts, both with output: nothing is paused and nothing is grown
    expect(src.round()).toMatchObject({ timeouts: 1 });
    expect(src.timeoutBackoff('g1')).toMatchObject({ streak: 0, growths: 0, paused: false });
    expect(src.fire(fireInput(b, { round: 2 }))).toMatchObject({ fired: true, deadlineMs: 40 });
    await drain(src);
  });

  it('a served sample between two zero-token timeouts clears the streak, so the pause needs two in a row', async () => {
    const served = scriptedGenerate(() => ({ toolCall: proposeFixCall([FIX]), usage: { inputTokens: 900, outputTokens: 120 } }));
    let hang = true;
    const generate: GenerateFn = (req, o) => (hang ? hanging()(req, o) : served.generate(req, o));
    const src = createLlmSource({ generate, pricing: PRICING });
    const b = budget();
    src.fire(fireInput(b));
    await drain(src);
    expect(src.timeoutBackoff('g1')).toMatchObject({ streak: 1, growths: 1 });
    hang = false;
    src.fire(fireInput(b, { round: 2 }));
    await drain(src);
    // the provider answered inside the deadline: the streak is over, the growth stands (one-way per goal, like the reasoning cap)
    expect(src.timeoutBackoff('g1')).toEqual({ streak: 0, growths: 1, paused: false, bookedThisRound: true });
    hang = true;
    // round 3: a re-fire at round 2 would replay the served round's cached patch instead of sampling
    expect(src.fire(fireInput(b, { round: 3 }))).toMatchObject({ fired: true, deadlineMs: 60 });
    await drain(src);
    expect(src.timeoutBackoff('g1')).toEqual({ streak: 1, growths: 2, paused: false, bookedThisRound: true });
  });
});
