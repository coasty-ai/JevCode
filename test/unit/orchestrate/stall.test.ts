/**
 * §7.1 / corner row 46: the watchdog over a fake clock.
 *
 * `T0` is the fake epoch and `HB` the heartbeat period; every sample is placed by hand so the arithmetic of
 * the assertions is visible. No real clock, no timers, no I/O.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_SPLIT_POLICY } from '../../../src/orchestrate/types.js';
import { detectStall, type HeartbeatSample } from '../../../src/orchestrate/stall.js';
import type { SplitPolicy } from '../../../src/orchestrate/types.js';

const T0 = 1_700_000_000_000;
const HB = 15_000;
const STALL = DEFAULT_SPLIT_POLICY.agentStallMs; // 10 min
const POLICY: Pick<SplitPolicy, 'agentStallMs' | 'onStall'> = { agentStallMs: STALL, onStall: 'notify' };

function sample(over: Partial<HeartbeatSample> & { at: number }): HeartbeatSample {
  return {
    step: 1,
    phase: 'running',
    changedFiles: 1,
    testCount: 10,
    touchedPaths: ['src/a.ts'],
    netLines: 0,
    lastJsonLineAt: over.at,
    ...over,
  };
}

/**
 * `count` samples one heartbeat apart, ending at `T0 + span`. `netLines` AND the cumulative `changedFiles`
 * both advance by default, so a series never churns and never looks file-frozen by accident: a test that
 * wants churn pins `netLines` itself, and one that wants `no_file_progress` pins `changedFiles` itself.
 */
function series(count: number, span: number, at: (i: number, t: number) => Partial<HeartbeatSample>): HeartbeatSample[] {
  const start = T0 + span - (count - 1) * HB;
  return Array.from({ length: count }, (_, i) => {
    const t = start + i * HB;
    return sample({ at: t, lastJsonLineAt: t, netLines: i * 10, changedFiles: i + 1, ...at(i, t) });
  });
}

describe('§7.1 detectStall — no step progress', () => {
  it('fires when the newest step has been unchanged for agentStallMs, in whole minutes', () => {
    const now = T0 + 11 * 60_000;
    const history = [sample({ at: T0, step: 4 }), sample({ at: T0 + 60_000, step: 4 }), sample({ at: now - HB, step: 4, lastJsonLineAt: now - 1 })];
    const v = detectStall(history, now, POLICY, HB);
    expect(v).toEqual({ signal: 'no_step_progress', message: 'no progress 11 m', action: 'notify', quiet: false });
  });

  it('does not fire one millisecond early, and measures from the first sample at that step', () => {
    const now = T0 + STALL;
    // the cumulative changedFiles advances, so only the step clock is under test here
    const history = [sample({ at: T0 - 60_000, step: 3, changedFiles: 1 }), sample({ at: T0, step: 4, changedFiles: 2 }), sample({ at: now - 1, step: 4, changedFiles: 3, lastJsonLineAt: now })];
    expect(detectStall(history, now - 1, POLICY, HB).signal).toBeNull();
    expect(detectStall(history, now, POLICY, HB).message).toBe('no progress 10 m');
  });

  it('honours onStall: notify, pause and kick all reach the verdict', () => {
    const now = T0 + STALL;
    const history = [sample({ at: T0, step: 4, lastJsonLineAt: now })];
    for (const onStall of ['notify', 'pause', 'kick'] as const) {
      expect(detectStall(history, now, { agentStallMs: STALL, onStall }, HB).action).toBe(onStall);
    }
  });

  it('an idle or ended agent is not stalled', () => {
    const now = T0 + STALL;
    for (const phase of ['idle', 'ended'] as const) {
      expect(detectStall([sample({ at: T0, step: 4, phase, lastJsonLineAt: now })], now, POLICY, HB).signal).toBeNull();
    }
  });
});

describe('§7.1 detectStall — no file progress', () => {
  it('fires when the last 3 samples changed no file and the test count did not move', () => {
    const history = series(4, 3 * HB, () => ({ changedFiles: 0, testCount: 10 }));
    const now = T0 + 3 * HB;
    expect(detectStall(history, now, POLICY, HB)).toEqual({ signal: 'no_file_progress', message: 'no files changed in 3 steps', action: 'notify', quiet: false });
  });

  it('does not fire on a moved test count, on a changed file, or on fewer than 3 samples', () => {
    const now = T0 + 3 * HB;
    expect(detectStall(series(4, 3 * HB, (i) => ({ changedFiles: 0, testCount: i === 0 ? 9 : 10 })), now, POLICY, HB).signal).toBeNull();
    expect(detectStall(series(4, 3 * HB, (i) => ({ changedFiles: 0, testCount: i === 3 ? 11 : 10 })), now, POLICY, HB).signal).toBeNull();
    // "a changed file" is a cumulative count that MOVED, not one nonzero sample: `changedFiles` is
    // measured against the base, so 0,1,2,3 is an agent changing a file a step and 2,2,2,2 is one that
    // changed two files once and has done nothing since (which is the signal, below).
    expect(detectStall(series(4, 3 * HB, (i) => ({ changedFiles: i, testCount: 10 })), now, POLICY, HB).signal).toBeNull();
    expect(detectStall(series(4, 3 * HB, (i) => ({ changedFiles: i === 3 ? 2 : 0, testCount: 10 })), now, POLICY, HB).signal).toBeNull();
    expect(detectStall(series(2, HB, () => ({ changedFiles: 0 })), now, POLICY, HB).signal).toBeNull();
  });

  it('fires on an agent that changed files early and then stopped: the count is cumulative', () => {
    // The case the row exists for, and the one a per-step reading of `changedFiles` could never see: 7
    // files changed against the base and not one more in three heartbeats.
    const history = series(4, 3 * HB, () => ({ changedFiles: 7, testCount: 10 }));
    expect(detectStall(history, T0 + 3 * HB, POLICY, HB)).toEqual({ signal: 'no_file_progress', message: 'no files changed in 3 steps', action: 'notify', quiet: false });
  });

  it('a null test count throughout is "unchanged", not "changed"', () => {
    const history = series(3, 2 * HB, () => ({ changedFiles: 0, testCount: null }));
    expect(detectStall(history, T0 + 2 * HB, POLICY, HB).signal).toBe('no_file_progress');
  });
});

describe('§7.1 detectStall — churn', () => {
  it('fires on the same file with no net change against 3 steps ago, and kicks whatever onStall says', () => {
    const history = series(4, 3 * HB, (i) => ({ step: 4 + i, netLines: 0, touchedPaths: ['src/a.ts', `src/b${i}.ts`] }));
    for (const onStall of ['notify', 'pause', 'kick'] as const) {
      const v = detectStall(history, T0 + 3 * HB, { agentStallMs: STALL, onStall }, HB);
      expect(v).toEqual({ signal: 'churn', message: 'no net change to src/a.ts in 3 steps', action: 'kick', quiet: false });
    }
  });

  it('does not fire when the net line count moved, when no file is shared, or with only 3 samples', () => {
    const now = T0 + 3 * HB;
    expect(detectStall(series(4, 3 * HB, (i) => ({ step: 4 + i, netLines: i === 3 ? 12 : 0 })), now, POLICY, HB).signal).toBeNull();
    expect(detectStall(series(4, 3 * HB, (i) => ({ step: 4 + i, netLines: 0, touchedPaths: [`src/${i}.ts`] })), now, POLICY, HB).signal).toBeNull();
    expect(detectStall(series(3, 2 * HB, (i) => ({ step: 4 + i, netLines: 0 })), now, POLICY, HB).signal).toBeNull();
  });
});

describe('§7.1 corner row 46 — a quiet pipe is not a stall', () => {
  it('no json line for 2 x heartbeat while the heartbeat is live: quiet, no signal, no action', () => {
    const now = T0 + 10 * HB;
    const history = series(4, 10 * HB, (i, t) => ({ step: 4 + i, at: t, lastJsonLineAt: T0 }));
    const v = detectStall(history, now, POLICY, HB);
    expect(v.signal).toBeNull();
    expect(v.action).toBe('none');
    expect(v.quiet).toBe(true);
    expect(v.message).toContain('heartbeat is live');
  });

  it('a silence shorter than 2 x heartbeat is not even quiet', () => {
    const now = T0 + 10 * HB;
    const history = series(4, 10 * HB, (i, t) => ({ step: 4 + i, at: t, lastJsonLineAt: now - (2 * HB - 1) }));
    expect(detectStall(history, now, POLICY, HB)).toEqual({ signal: null, message: '', action: 'none', quiet: false });
  });

  it('a dead heartbeat is not "quiet": quiet needs the heartbeat to be live', () => {
    const now = T0 + 10 * HB;
    const history = [sample({ at: now - 10 * HB, step: 4, lastJsonLineAt: T0 })];
    expect(detectStall(history, now, { agentStallMs: 10 * 60_000, onStall: 'notify' }, HB).quiet).toBe(false);
  });

  it('quiet NEVER masks a real stall: it is reported alongside the signal', () => {
    const now = T0 + STALL;
    const history = [sample({ at: T0, step: 4, lastJsonLineAt: T0 }), sample({ at: now - HB, step: 4, lastJsonLineAt: T0 })];
    const v = detectStall(history, now, POLICY, HB);
    expect(v.signal).toBe('no_step_progress');
    expect(v.quiet).toBe(true);
    expect(v.action).toBe('notify');
  });
});

describe('§7.1 precedence and a short history', () => {
  it('an empty history is no signal at all', () => {
    expect(detectStall([], T0, POLICY, HB)).toEqual({ signal: null, message: '', action: 'none', quiet: false });
  });

  it('a single sample can only ever be no_step_progress', () => {
    const now = T0 + STALL;
    expect(detectStall([sample({ at: T0, step: 4, changedFiles: 0, netLines: 0, lastJsonLineAt: now })], now, POLICY, HB).signal).toBe('no_step_progress');
    expect(detectStall([sample({ at: now - 1, step: 4, changedFiles: 0, netLines: 0, lastJsonLineAt: now })], now, POLICY, HB).signal).toBeNull();
  });

  it('all three at once resolves in the §7.1 table order: the frozen agent is frozen, not churning', () => {
    const now = T0 + 12 * 60_000;
    const history = Array.from({ length: 4 }, (_, i) =>
      sample({ at: T0 + i * HB, step: 4, changedFiles: 0, testCount: 10, netLines: 0, touchedPaths: ['src/a.ts'], lastJsonLineAt: now }),
    );
    const v = detectStall(history, now, { agentStallMs: STALL, onStall: 'pause' }, HB);
    expect(v.signal).toBe('no_step_progress');
    expect(v.action).toBe('pause');
  });

  it('no file progress outranks churn when both would hold', () => {
    const history = series(4, 3 * HB, (i) => ({ step: 4 + i, changedFiles: 0, testCount: 10, netLines: 0, touchedPaths: ['src/a.ts'] }));
    expect(detectStall(history, T0 + 3 * HB, POLICY, HB).signal).toBe('no_file_progress');
  });
});
