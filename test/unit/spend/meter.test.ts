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

describe('session meter tree (TUI-DESIGN §9.1, §15 item 7)', () => {
  it('a root snapshot has no parent fields at all; a child carries parentExceeded and the parent totals', () => {
    const root = createSpendMeter(10);
    const child = root.child(2);
    const rs = root.snapshot();
    expect('parent' in rs).toBe(false);
    expect('parentExceeded' in rs).toBe(false);
    expect(Object.keys(rs).sort()).toEqual(['capUsd', 'exceeded', 'generator', 'jev', 'totalUsd']);
    child.add('jev', usage(0.5));
    expect(child.snapshot()).toMatchObject({ capUsd: 2, totalUsd: 0.5, exceeded: false, parentExceeded: false, parent: { totalUsd: 0.5, capUsd: 10 } });
    expect(JSON.stringify(root.snapshot())).not.toContain('parent');
  });

  it('setCap on the root is observed by a live child through parent.capUsd and exceeded(); the child cap is unchanged', () => {
    const root = createSpendMeter(10);
    root.add('generator', usage(9.5));
    const child = root.child(Math.min(2, 10 - root.snapshot().totalUsd));
    expect(child.snapshot().capUsd).toBeCloseTo(0.5, 12);
    const s = child.add('jev', usage(0.4));
    expect(s.exceeded).toBe(false);
    expect(s.parentExceeded).toBe(false);
    child.add('jev', usage(0.2));
    expect(child.exceeded()).toBe(true);
    expect(child.snapshot().parentExceeded).toBe(true);
    expect(root.exceeded()).toBe(true);
    expect(typeof root.setCap).toBe('function');
    root.setCap!(15);
    expect(root.snapshot().capUsd).toBe(15);
    expect(root.exceeded()).toBe(false);
    const after = child.snapshot();
    expect(after.capUsd).toBeCloseTo(0.5, 12);
    expect(after.parent).toEqual({ totalUsd: expect.closeTo(10.1, 9), capUsd: 15 });
    expect(after.parentExceeded).toBe(false);
    // the child is still over its own cap ($0.60 ≥ $0.50); a fresh child forwards to the same, raised root
    expect(child.exceeded()).toBe(true);
    const next = root.child(Math.min(2, 15 - root.snapshot().totalUsd));
    expect(next.snapshot().capUsd).toBe(2);
    next.add('generator', usage(0.1));
    expect(root.snapshot().totalUsd).toBeCloseTo(10.2, 9);
    // `none` = +Infinity; NaN fails closed to 0 like the constructor
    root.setCap!(Number.POSITIVE_INFINITY);
    expect(root.exceeded()).toBe(false);
    expect(next.snapshot().parent?.capUsd).toBe(Number.POSITIVE_INFINITY);
    root.setCap!(Number.NaN);
    expect(root.snapshot().capUsd).toBe(0);
    expect(next.exceeded()).toBe(true);
  });

  it('/resume child-cap order (§9.1): the child is created before the resumed spend is added', () => {
    // cap $10.00, earlier runs $8.00, the resumed run at $1.50 of its $2.00 cap
    const right = createSpendMeter(10);
    right.add('generator', usage(8));
    const remaining = 10 - right.snapshot().totalUsd;
    const child = right.child(Math.min(2, remaining));
    right.add('generator', usage(1.5));
    child.restore({ generator: { inputTokens: 0, outputTokens: 0, costUsd: 1.5, calls: 1 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, totalUsd: 1.5, capUsd: 2, exceeded: false });
    expect(child.snapshot().capUsd).toBe(2);
    expect(child.exceeded()).toBe(false);
    expect(right.snapshot().totalUsd).toBeCloseTo(9.5, 12);
    // the wrong order: adding first leaves remaining $0.50 → child cap $0.50 → restore($1.50) → exceeded at the first check
    const wrong = createSpendMeter(10);
    wrong.add('generator', usage(8));
    wrong.add('generator', usage(1.5));
    const badChild = wrong.child(Math.min(2, 10 - wrong.snapshot().totalUsd));
    badChild.restore({ generator: { inputTokens: 0, outputTokens: 0, costUsd: 1.5, calls: 1 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, totalUsd: 1.5, capUsd: 2, exceeded: false });
    expect(badChild.snapshot().capUsd).toBeCloseTo(0.5, 12);
    expect(badChild.exceeded()).toBe(true);
  });

  it('a parent whose snapshot throws yields a child snapshot without parent fields, never an exception', () => {
    const broken: SpendMeter = {
      add: () => {
        throw new Error('boom');
      },
      exceeded: () => false,
      snapshot: () => {
        throw new Error('boom');
      },
      restore: () => undefined,
      child: (cap) => createSpendMeter(cap),
    };
    const m = createSpendMeter(1, broken);
    const s = m.add('jev', usage(0.1));
    expect('parent' in s).toBe(false);
    expect(s.totalUsd).toBeCloseTo(0.1, 12);
  });
});
