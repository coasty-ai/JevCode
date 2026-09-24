import { describe, expect, it } from 'vitest';
import type { SpendMeter, SpendSnapshot, TokenUsage } from '../../../src/core/types.js';
import { RESTORED_HOLD_ID, createSpendMeter, sanitiseCap } from '../../../src/spend/meter.js';

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
      // contract 1.5 (ORCHESTRATION-DESIGN §6.2 [G6]): always written, 0 when nothing is held, so the disk store round-trips it
      heldUsd: 0,
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
    expect(Object.keys(rs).sort()).toEqual(['capUsd', 'exceeded', 'generator', 'heldUsd', 'jev', 'totalUsd']);
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

describe('hold / release (ORCHESTRATION-DESIGN §6.2 [G6] [D6])', () => {
  it('hold is keyed by agent: the sum is heldUsd() and snapshot().heldUsd, both starting at 0', () => {
    const m = createSpendMeter(2);
    expect(typeof m.hold).toBe('function');
    expect(typeof m.release).toBe('function');
    expect(typeof m.heldUsd).toBe('function');
    expect(m.heldUsd?.()).toBe(0);
    expect(m.snapshot().heldUsd).toBe(0);
    m.hold?.('fix-store', 0.9);
    expect(m.heldUsd?.()).toBeCloseTo(0.9, 12);
    m.hold?.('tui-rows', 0.3);
    expect(m.heldUsd?.()).toBeCloseTo(1.2, 12);
    // the accessor and the snapshot field are the same number, always
    expect(m.snapshot().heldUsd).toBe(m.heldUsd?.());
    // §6.5: re-holding one agent REPLACES its reserve (a raised cap), it does not accumulate
    m.hold?.('tui-rows', 0.5);
    expect(m.heldUsd?.()).toBeCloseTo(1.4, 12);
  });

  it('release drops one agent and is idempotent — a hold can never go negative', () => {
    const m = createSpendMeter(2);
    m.hold?.('a', 1);
    m.hold?.('b', 0.4);
    m.release?.('b');
    expect(m.heldUsd?.()).toBeCloseTo(1, 12);
    // a double release, and an unknown id, are both no-ops: there is no subtraction that could underflow
    m.release?.('b');
    m.release?.('never-held');
    expect(m.heldUsd?.()).toBeCloseTo(1, 12);
    m.release?.('a');
    expect(m.heldUsd?.()).toBe(0);
    m.release?.('a');
    expect(m.heldUsd?.()).toBe(0);
  });

  it('a negative, NaN or infinite amount, and an empty agent id, are ignored (the nonNegative discipline)', () => {
    const m = createSpendMeter(2);
    m.hold?.('a', Number.NaN);
    m.hold?.('b', -5);
    m.hold?.('c', Number.POSITIVE_INFINITY);
    expect(m.heldUsd?.()).toBe(0);
    m.hold?.('', 99);
    expect(m.heldUsd?.()).toBe(0);
    m.release?.('');
    m.hold?.('d', 0.5);
    expect(m.heldUsd?.()).toBeCloseTo(0.5, 12);
    // the sum is always finite and >= 0, whatever was pushed in
    expect(Number.isFinite(m.heldUsd?.() ?? Number.NaN)).toBe(true);
  });

  it('[G6] heldUsd survives restore under RESTORED_HOLD_ID, which adoption must release once it re-holds per agent', () => {
    const m = createSpendMeter(3);
    m.hold?.('fix-store', 0.75);
    const saved = m.snapshot();
    expect(saved.heldUsd).toBeCloseTo(0.75, 12);
    const fresh = createSpendMeter(3);
    fresh.restore(saved);
    expect(fresh.snapshot().heldUsd).toBeCloseTo(0.75, 12);
    // a SpendSnapshot carries no per-agent breakdown, so the total lands under one reserved id; §4.4's adoption
    // rebuilds the real holds from the manifest x the live run.locks and releases this one, or it double-counts
    fresh.hold?.('fix-store', 0.75);
    expect(fresh.heldUsd?.()).toBeCloseTo(1.5, 12);
    fresh.release?.(RESTORED_HOLD_ID);
    expect(fresh.heldUsd?.()).toBeCloseTo(0.75, 12);
    // a snapshot written before contract 1.5 carries no heldUsd: restore reads 0, never NaN
    fresh.restore({ generator: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, totalUsd: 0, capUsd: 3, exceeded: false });
    expect(fresh.snapshot().heldUsd).toBe(0);
    // and a corrupt one does not throw
    expect(() => fresh.restore({ heldUsd: 'lots' } as unknown as SpendSnapshot)).not.toThrow();
    expect(fresh.snapshot().heldUsd).toBe(0);
  });

  it('[D6] exceeded() is untouched by a hold: on a run meter it still means "this run spent its cap"', () => {
    const m = createSpendMeter(1);
    m.hold?.('a', 10);
    expect(m.exceeded()).toBe(false);
    expect(m.snapshot().exceeded).toBe(false);
    expect(m.snapshot().totalUsd).toBe(0);
    m.add('generator', usage(1));
    expect(m.exceeded()).toBe(true);
    m.release?.('a');
    expect(m.exceeded()).toBe(true);
  });

  it('a hold belongs to the meter that took it and never forwards to the parent', () => {
    const parent = createSpendMeter(10);
    const child = parent.child(2);
    child.hold?.('a', 0.5);
    expect(child.snapshot().heldUsd).toBeCloseTo(0.5, 12);
    expect(parent.snapshot().heldUsd).toBe(0);
    parent.hold?.('a', 0.9);
    expect(parent.snapshot().heldUsd).toBeCloseTo(0.9, 12);
    expect(child.snapshot().heldUsd).toBeCloseTo(0.5, 12);
    // the same id in two meters is two independent reserves: releasing one leaves the other alone
    child.release?.('a');
    expect(child.snapshot().heldUsd).toBe(0);
    expect(parent.snapshot().heldUsd).toBeCloseTo(0.9, 12);
    // a misbehaving parent is irrelevant: hold never touches it
    const brokenParent: SpendMeter = {
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
    const lone = createSpendMeter(1, brokenParent);
    expect(() => lone.hold?.('a', 0.2)).not.toThrow();
    expect(lone.snapshot().heldUsd).toBeCloseTo(0.2, 12);
    expect(lone.heldUsd?.()).toBeCloseTo(0.2, 12);
  });
});
