import { describe, expect, it } from 'vitest';
import { DIRTY_ENTRIES_MAX } from '../../../src/core/limits.js';
import { gateReasonText, splitGate, type GateInput } from '../../../src/orchestrate/split/gate.js';
import { DEFAULT_SPLIT_POLICY, type GateReason } from '../../../src/orchestrate/types.js';

/** A gate input that is open on `disjoint_directories`; every case below breaks exactly one field. */
function base(over: Partial<GateInput> = {}): GateInput {
  return {
    policy: { ...DEFAULT_SPLIT_POLICY, split: 'auto' },
    depth: 0,
    hasLedger: true,
    git: { isRepo: true, headBorn: true, worktreeSupported: true },
    plan: { remaining: ['one', 'two', 'three'], unverified: [] },
    verificationResolvable: true,
    researchOnly: false,
    dirtyEntries: 3,
    liveChildren: 0,
    splits: 0,
    step: 20,
    lastSplitStep: null,
    availableParallelism: 8,
    freeMemBytes: 32 * 2 ** 30,
    agentMemBytes: 3 * 2 ** 30,
    freeDiskBytes: 200 * 2 ** 30,
    repoBytes: 200 * 2 ** 20,
    sessionRemainingUsd: 10,
    isReplanStep: false,
    orchestrationProblemAgeSteps: null,
    demand: { directories: ['src', 'test'], failingTestFiles: [], humanAsked: false },
    ...over,
  };
}

describe('splitGate (§3.1)', () => {
  it('opens on a healthy parent with two disjoint directories', () => {
    expect(splitGate(base())).toEqual({ open: true, demand: 'disjoint_directories' });
  });

  const cases: readonly [GateReason, Partial<GateInput>][] = [
    ['split_off', { policy: { ...DEFAULT_SPLIT_POLICY, split: 'off' } }],
    ['child_depth', { depth: 1 }],
    ['no_ledger', { hasLedger: false }],
    ['not_git', { git: { isRepo: false, headBorn: true, worktreeSupported: true } }],
    ['unborn_head', { git: { isRepo: true, headBorn: false, worktreeSupported: true } }],
    ['no_worktree_support', { git: { isRepo: true, headBorn: true, worktreeSupported: false } }],
    ['plan_too_small', { plan: { remaining: ['one', 'two'], unverified: [] } }],
    ['blocking_unverified', { plan: { remaining: ['one', 'two', 'three'], unverified: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] } }],
    ['no_verification', { verificationResolvable: false }],
    ['dirty_too_large', { dirtyEntries: DIRTY_ENTRIES_MAX + 1 }],
    ['children_live', { liveChildren: 1 }],
    ['max_splits', { splits: DEFAULT_SPLIT_POLICY.maxSplits }],
    ['cooldown', { step: 20, lastSplitStep: 15 }],
    ['resources', { availableParallelism: 2 }],
    ['money', { sessionRemainingUsd: 0.5 }],
    ['replan_step', { isReplanStep: true }],
    ['orchestration_problem', { orchestrationProblemAgeSteps: 2 }],
    ['no_demand', { demand: { directories: ['src'], failingTestFiles: ['a.test.ts'], humanAsked: false } }],
  ];

  it.each(cases)('shuts with %s', (why, patch) => {
    expect(splitGate(base(patch))).toEqual({ open: false, why });
  });

  it('returns the FIRST failing condition in table order, not the worst one', () => {
    // every reason below `child_depth` is also broken; the table order is what `decompose:skipped` prints
    expect(splitGate(base({ depth: 1, hasLedger: false, liveChildren: 4, sessionRemainingUsd: 0 }))).toEqual({ open: false, why: 'child_depth' });
    expect(splitGate(base({ policy: { ...DEFAULT_SPLIT_POLICY, split: 'off' }, depth: 1 }))).toEqual({ open: false, why: 'split_off' });
    expect(splitGate(base({ git: { isRepo: false, headBorn: false, worktreeSupported: false } }))).toEqual({ open: false, why: 'not_git' });
    expect(splitGate(base({ splits: 9, liveChildren: 2 }))).toEqual({ open: false, why: 'children_live' });
    expect(splitGate(base({ isReplanStep: true, orchestrationProblemAgeSteps: 0 }))).toEqual({ open: false, why: 'replan_step' });
  });

  it('a non-git workspace never opens, whatever else is true (corner row 14)', () => {
    const input = base({ git: { isRepo: false, headBorn: true, worktreeSupported: true }, demand: { directories: ['a', 'b'], failingTestFiles: ['x', 'y'], humanAsked: true } });
    expect(splitGate(input)).toEqual({ open: false, why: 'not_git' });
    expect(gateReasonText('not_git')).toBe('agents need a git worktree (git ≥ 2.5) and a committed HEAD');
    expect(gateReasonText('no_worktree_support')).toBe('agents need a git worktree (git ≥ 2.5) and a committed HEAD');
  });

  it('a dirty parent is normal: 200 tracked entries open, 201 shut (corner row 16, [D1])', () => {
    expect(splitGate(base({ dirtyEntries: 0 })).open).toBe(true);
    expect(splitGate(base({ dirtyEntries: DIRTY_ENTRIES_MAX })).open).toBe(true);
    expect(splitGate(base({ dirtyEntries: DIRTY_ENTRIES_MAX + 1 }))).toEqual({ open: false, why: 'dirty_too_large' });
  });

  it('a cooldown that has elapsed opens again', () => {
    expect(splitGate(base({ step: 20, lastSplitStep: 12 })).open).toBe(true);
    expect(splitGate(base({ step: 19, lastSplitStep: 12 }))).toEqual({ open: false, why: 'cooldown' });
  });

  it('takes the three demand reasons in order, and shuts with no_demand when none holds', () => {
    const none = { directories: [], failingTestFiles: [], humanAsked: false };
    expect(splitGate(base({ demand: { ...none, directories: ['src', 'test'], failingTestFiles: ['a', 'b'], humanAsked: true } }))).toEqual({ open: true, demand: 'disjoint_directories' });
    expect(splitGate(base({ demand: { ...none, failingTestFiles: ['a.test.ts', 'b.test.ts'], humanAsked: true } }))).toEqual({ open: true, demand: 'failing_tests' });
    expect(splitGate(base({ demand: { ...none, humanAsked: true } }))).toEqual({ open: true, demand: 'human' });
    expect(splitGate(base({ demand: none }))).toEqual({ open: false, why: 'no_demand' });
  });

  it('an unverified item that does not block EVERY remaining item leaves the gate open', () => {
    expect(splitGate(base({ plan: { remaining: ['one', 'two', 'three'], unverified: [{ text: 'one' }] } })).open).toBe(true);
  });

  it('research-only splits need no verification set', () => {
    expect(splitGate(base({ verificationResolvable: false, researchOnly: true })).open).toBe(true);
  });

  it('no session cap (POSITIVE_INFINITY remaining) passes the money gate; a zero remaining does not', () => {
    expect(splitGate(base({ sessionRemainingUsd: Number.POSITIVE_INFINITY })).open).toBe(true);
    expect(splitGate(base({ sessionRemainingUsd: 0 }))).toEqual({ open: false, why: 'money' });
    // 0.80 x 0.5 = 0.40 = 2 x minAgentUsd: exactly on the line passes
    expect(splitGate(base({ sessionRemainingUsd: 0.8 })).open).toBe(true);
  });

  it('an unmeasurable resource divisor does not shut the gate (§3.6 re-checks with real numbers)', () => {
    expect(splitGate(base({ agentMemBytes: 0, repoBytes: 0 })).open).toBe(true);
    expect(splitGate(base({ freeMemBytes: 1, agentMemBytes: 3 * 2 ** 30 }))).toEqual({ open: false, why: 'resources' });
  });

  it('every reason has one short lower-case sentence', () => {
    for (const [why] of cases) {
      const text = gateReasonText(why);
      expect(text.length).toBeGreaterThan(8);
      expect(text.length).toBeLessThan(80);
      expect(text[0]).toBe(text[0]?.toLowerCase());
      expect(text.endsWith('.')).toBe(false);
    }
  });
});
