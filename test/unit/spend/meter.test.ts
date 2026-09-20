import { describe, expect, it } from 'vitest';
import type { SpendMeter, SpendSnapshot, TokenUsage } from '../../../src/core/types.js';
import { createSpendMeter, sanitiseCap } from '../../../src/spend/meter.js';

const usage = (costUsd: number, tokens = 100): TokenUsage => ({ inputTokens: tokens, outputTokens: tokens / 10, costUsd, calls: 1 });

describe('createSpendMeter', () => {
  it('starts at zero and reports the cap', () => {
    const m = createSpendMeter(2);
    expect(m.snapshot()).toEqual({
      generator: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
      jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
      totalUsd: 0,
      capUsd: 2,
      exceeded: false,
    });
    expect(m.exceeded()).toBe(false);
  });

  it('add records per source, returns the evaluated snapshot, and flips exceeded at >= cap', () => {
    const m = createSpendMeter(1);
    const s1 = m.add('generator', usage(0.4, 1000));
    expect(s1.generator).toEqual({ inputTokens: 1000, outputTokens: 100, costUsd: 0.4, calls: 1 });
    expect(s1.totalUsd).toBeCloseTo(0.4, 12);
    expect(s1.exceeded).toBe(false);
    const s2 = m.add('jev', usage(0.6, 50));
    expect(s2.jev.calls).toBe(1);
    expect(s2.totalUsd).toBeCloseTo(1, 12);
    expect(s2.exceeded).toBe(true);
    expect(m.exceeded()).toBe(true);
    const s3 = m.add('jev', usage(0.01));
    expect(s3.jev.calls).toBe(2);
    expect(s3.exceeded).toBe(true);
  });

  it('a cap of 0 is exceeded immediately after the first record; +Infinity never', () => {
    const zero = createSpendMeter(0);
    expect(zero.exceeded()).toBe(true);
    const none = createSpendMeter(Number.POSITIVE_INFINITY);
    none.add('generator', usage(1e6));
    expect(none.exceeded()).toBe(false);
    expect(sanitiseCap(Number.NaN)).toBe(0);
    expect(sanitiseCap(-1)).toBe(0);
    expect(sanitiseCap(2.5)).toBe(2.5);
  });

  it('snapshot returns copies; mutating them does not touch the meter', () => {
    const m = createSpendMeter(5);
    m.add('jev', usage(0.1));
    const s = m.snapshot();
    s.jev.costUsd = 99;
    s.totalUsd = 99;
    expect(m.snapshot().jev.costUsd).toBeCloseTo(0.1, 12);
    expect(m.snapshot().totalUsd).toBeCloseTo(0.1, 12);
  });

  it('never throws on malformed usage: non-finite and negative fields count as 0', () => {
    const m = createSpendMeter(1);
    const bad = { inputTokens: Number.NaN, outputTokens: -5, costUsd: Number.POSITIVE_INFINITY, calls: 1 } as TokenUsage;
    expect(() => m.add('generator', bad)).not.toThrow();
    expect(m.snapshot().generator).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 1 });
    expect(() => m.add('jev', undefined as unknown as TokenUsage)).not.toThrow();
    expect(() => m.add('jev', { costUsd: 'x' } as unknown as TokenUsage)).not.toThrow();
    expect(m.exceeded()).toBe(false);
  });

  it('child forwards every add to the parent and exceeded includes the parent', () => {
    const bench = createSpendMeter(1);
    const runA = bench.child(0.5);
    const runB = bench.child(0.5);
    runA.add('generator', usage(0.3));
    runB.add('jev', usage(0.3));
    expect(bench.snapshot().totalUsd).toBeCloseTo(0.6, 12);
    expect(bench.snapshot().generator.costUsd).toBeCloseTo(0.3, 12);
    expect(bench.snapshot().jev.costUsd).toBeCloseTo(0.3, 12);
    expect(runA.exceeded()).toBe(false);
    expect(runB.exceeded()).toBe(false);
    runA.add('generator', usage(0.4));
    expect(runA.snapshot().totalUsd).toBeCloseTo(0.7, 12);
    expect(runA.exceeded()).toBe(true);
    expect(bench.snapshot().totalUsd).toBeCloseTo(1, 12);
    expect(bench.exceeded()).toBe(true);
    // runB is under its own cap but the shared bench meter is exhausted
    expect(runB.snapshot().totalUsd).toBeCloseTo(0.3, 12);
    expect(runB.exceeded()).toBe(true);
    expect(runB.snapshot().exceeded).toBe(true);
    expect(runB.snapshot().capUsd).toBe(0.5);
  });

  it('createSpendMeter(cap, parent) is the same as parent.child(cap); grandchildren propagate to the root', () => {
    const root = createSpendMeter(10);
    const mid = createSpendMeter(5, root);
    const leaf = mid.child(1);
    leaf.add('jev', usage(0.25));
    expect(mid.snapshot().totalUsd).toBeCloseTo(0.25, 12);
    expect(root.snapshot().totalUsd).toBeCloseTo(0.25, 12);
  });

  it('restore replaces this meter only and does not re-add to the parent or change the cap', () => {
    const parent = createSpendMeter(10);
    const m = createSpendMeter(3, parent);
    m.add('jev', usage(0.1));
    const saved: SpendSnapshot = {
      generator: { inputTokens: 5000, outputTokens: 500, costUsd: 1.5, calls: 7 },
      jev: { inputTokens: 900, outputTokens: 90, costUsd: 0.2, calls: 3 },
      totalUsd: 1.7,
      capUsd: 1,
      exceeded: true,
    };
    m.restore(saved);
    const s = m.snapshot();
    expect(s.generator).toEqual(saved.generator);
    expect(s.jev).toEqual(saved.jev);
    expect(s.totalUsd).toBeCloseTo(1.7, 12);
    expect(s.capUsd).toBe(3);
    expect(s.exceeded).toBe(false);
    expect(parent.snapshot().totalUsd).toBeCloseTo(0.1, 12);
    saved.generator.costUsd = 0;
    expect(m.snapshot().generator.costUsd).toBeCloseTo(1.5, 12);
    m.add('generator', usage(1.3));
    expect(m.exceeded()).toBe(true);
  });

  it('restore sanitises a corrupt snapshot instead of throwing', () => {
    const m = createSpendMeter(1);
    expect(() => m.restore({ generator: { costUsd: Number.NaN } } as unknown as SpendSnapshot)).not.toThrow();
    expect(m.snapshot().totalUsd).toBe(0);
    m.add('jev', usage(0.2));
    expect(() => m.restore(undefined as unknown as SpendSnapshot)).not.toThrow();
    expect(() => m.restore(null as unknown as SpendSnapshot)).not.toThrow();
    expect(() => m.restore('garbage' as unknown as SpendSnapshot)).not.toThrow();
    expect(m.snapshot().totalUsd).toBe(0);
    expect(m.snapshot().jev.calls).toBe(0);
  });

  it('a misbehaving parent never breaks the child', () => {
    const broken: SpendMeter = {
      add: () => {
        throw new Error('parent boom');
      },
      exceeded: () => {
        throw new Error('parent boom');
      },
      snapshot: () => {
        throw new Error('parent boom');
      },
      restore: () => undefined,
      child: (cap) => createSpendMeter(cap),
    };
    const m = createSpendMeter(1, broken);
    expect(() => m.add('jev', usage(0.2))).not.toThrow();
    expect(m.snapshot().totalUsd).toBeCloseTo(0.2, 12);
    expect(m.exceeded()).toBe(false);
  });
});
