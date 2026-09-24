/**
 * F19 — the §3.3 prefix-pinning measurement needs a DENOMINATOR at run level.
 *
 * `StepVerifySummary.cacheHitRate` is written per step (`src/jev-modes/synth/search/index.ts fastlaneCounts`:
 * `cacheRead / cacheInput`), but until this change `cacheInput` itself was computed, used once and
 * thrown away — it reached neither `StepRecord.verify` nor `StepsSummary.s2`. A run-level hit rate
 * was therefore unrecoverable: the only thing a reader could do with n per-step ratios is average
 * them, and averaging ratios is exactly the error the comment above `StepsSummary.s2` forbids for
 * `ttfbMs` ("a quantile over a merged run set is exact rather than an average of averages").
 *
 * The two are not the same number. A step that served 10 of 1,000 input tokens from cache and a
 * step that served 90 of 100 have a MEAN RATIO of 0.455 and a TRUE RATE of 100/1,100 = 0.0909 — a
 * 5× difference, in the direction that makes prefix pinning look like it worked.
 *
 * The three folds are pinned separately because they are three different code paths and the wave
 * has already lost a member at each: `summariseStepRows` (steps.jsonl -> the run), `withWaveMembers`
 * (the normaliser `--resume` and every merge rebuild the part from, which silently ERASES anything
 * it does not name) and `mergeStepsSummaries` (arm-wide).
 */
import { describe, expect, it } from 'vitest';
import { emptyStepsSummary, mergeStepsSummaries, summariseStepRows, withWaveMembers } from '../../../src/bench/step-records.js';
import type { StepsSummary } from '../../../src/bench/types.js';

const row = (verify: Record<string, unknown>): string => JSON.stringify({ step: 1, proposer: 'synth', verify });

/** the two steps of the worked example above: the mean of the ratios is 0.455, the true rate 0.0909 */
const TWO_STEPS = [row({ cacheRead: 10, cacheWrite: 0, cacheInput: 1_000, cacheHitRate: 0.01 }), row({ cacheRead: 90, cacheWrite: 5, cacheInput: 100, cacheHitRate: 0.9 })].join('\n');

const rate = (s: StepsSummary): number => s.s2.cacheRead / s.s2.cacheInput;

describe('§3.4 the cache hit rate folds as Σread / Σinput, never as the mean of the steps’ own rates', () => {
  it('summariseStepRows carries the denominator out of steps.jsonl', () => {
    const s = summariseStepRows(TWO_STEPS);
    expect(s.s2.cacheRead).toBe(100);
    expect(s.s2.cacheWrite).toBe(5);
    expect(s.s2.cacheInput).toBe(1_100);
    expect(rate(s)).toBeCloseTo(100 / 1_100, 12);
    // the error this member exists to prevent: (0.01 + 0.9) / 2 = 0.455, 5x the truth
    expect(rate(s)).not.toBeCloseTo((0.01 + 0.9) / 2, 3);
  });

  it('an empty summary starts the denominator at 0, and a step with no cache facts adds nothing', () => {
    expect(emptyStepsSummary().s2.cacheInput).toBe(0);
    expect(summariseStepRows(row({ samples: 2 })).s2.cacheInput).toBe(0);
  });

  it('withWaveMembers carries it through --resume rather than erasing it', () => {
    // the normaliser rebuilds the part from `emptyStepsSummary()`: a member it does not name is LOST
    expect(withWaveMembers(summariseStepRows(TWO_STEPS)).s2.cacheInput).toBe(1_100);
  });

  it('mergeStepsSummaries sums the denominators, so an arm-wide rate is Σread / Σinput over its runs', () => {
    const a = summariseStepRows(row({ cacheRead: 10, cacheInput: 1_000 }));
    const b = summariseStepRows(row({ cacheRead: 90, cacheInput: 100 }));
    const merged = mergeStepsSummaries([a, b]);
    expect(merged.s2.cacheInput).toBe(1_100);
    expect(rate(merged)).toBeCloseTo(100 / 1_100, 12);
    expect(rate(merged)).toBeCloseTo(rate(summariseStepRows(TWO_STEPS)), 12);
  });
});
