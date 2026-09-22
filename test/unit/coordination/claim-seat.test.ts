/**
 * TUI round-5 request R5-H3 — the ledger handle's CLAIM SEAT and the beat's claim must name one epoch.
 *
 * §2.8's claim fence, §3.2 / §9.3 / §14 item 18: the holder of a run is the highest QUALIFIED epoch. A handle seated
 * with the identity claim (epoch 1) while its heartbeat published the minted one would make a reader that ranks by
 * `handle.claim` disagree with every reader that ranks by the beat — the one thing the fence cannot survive.
 *
 * Two routes are pinned here, and one refusal:
 *   (a) `openLedger({ claim })` — the minted claim seated at construction; the beat it writes carries the same epoch;
 *   (b) `reseatClaim(claim)` — for an epoch that only exists after the fold is readable (`nextEpoch` needs
 *       `seenEpochs`, which needs `open()`), guarded so it can only ever go UP, and only on this device and run;
 *   (c) compat — a caller that passes NO claim still opens on the epoch-1 identity claim, exactly as before.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHeartbeatWriter } from '../../../src/coordination/heartbeat.js';
import { openLedger } from '../../../src/coordination/ledger.js';
import { nodeFs } from '../../../src/coordination/fs.js';
import { commonsPaths } from '../../../src/coordination/paths.js';
import { CoordinationError } from '../../../src/coordination/records.js';
import { FIRST_EPOCH, mintClaim } from '../../../src/coordination/claims.js';
import type { Claim, HeartbeatBase, Heartbeat, LedgerHandle } from '../../../src/coordination/index.js';
import { DEV_A, DEV_B, REPO, T0, WS, claim, fakeClock, fakeTimers, iso, makeSelf, runId, tempHome } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const RID = runId(1);
/** what `src/session/**` would mint after reading the predecessor's state: epoch 4, not the identity claim */
const MINTED: Claim = mintClaim({ deviceId: DEV_A, runId: RID, pid: 4242, at: iso(T0 - 60_000), seenEpochs: [1, 2, 3] });

function base(patch: Partial<HeartbeatBase> = {}): HeartbeatBase {
  return {
    deviceId: DEV_A,
    label: 'mbp',
    host: 'mbp.local',
    user: 'p',
    pid: 4242,
    bootAt: iso(T0 - 6 * 3_600_000),
    jevcode: '0.3.0',
    runId: RID,
    sessionId: RID,
    parentSessionId: null,
    parentRunId: null,
    source: 'cli',
    title60: null,
    task60: 'fix store rotation',
    claim: MINTED,
    repo: { wsKey: WS, repoKey: REPO, remoteKey: null, basename: 'JevCode', branch: 'main', head: null, dirtyAtStart: false, linkedWorktree: false, worktreeSlug: null },
    mode: 'jev-on',
    maxSteps: 40,
    maxWallMs: 1_800_000,
    startedAt: iso(T0 - 60_000),
    ...patch,
  };
}

async function ledgerAt(o: { claim?: Claim } = {}): Promise<{ root: string; l: LedgerHandle }> {
  const t = await tempHome();
  cleanups.push(t.cleanup);
  const clock = fakeClock();
  const l: LedgerHandle = openLedger({
    home: t.home,
    self: makeSelf({ runId: RID, sessionId: RID }),
    now: clock.now,
    monotonicNow: clock.monotonicNow,
    timers: fakeTimers(clock),
    isPidAlive: () => true,
    pid: 4242,
    scanOnly: true,
    ...(o.claim !== undefined ? { claim: o.claim } : {}),
  });
  cleanups.push(() => l.close());
  await l.open();
  return { root: t.root, l };
}

const readBeat = async (root: string): Promise<Heartbeat> =>
  JSON.parse((await nodeFs.readBounded(commonsPaths(root).heartbeatFile(DEV_A, RID), 4096)).text) as Heartbeat;

describe('R5-H3 (a) openLedger seats the MINTED claim, and the beat publishes the same one', () => {
  it("the handle's seated claim IS the claim the caller minted", async () => {
    const { l } = await ledgerAt({ claim: MINTED });
    expect(l.claim).toEqual(MINTED);
    expect(l.claim.epoch).toBe(4);
  });

  it('the beat it writes carries that epoch, so seat and beat can never name two', async () => {
    const { root, l } = await ledgerAt({ claim: MINTED });
    const w = createHeartbeatWriter({ ledger: l, base: base() });
    w.start();
    w.stop();
    await l.close();
    const beat = await readBeat(root);
    expect(beat.claim).toEqual(l.claim);
    expect(beat.claim.epoch).toBe(l.claim.epoch);
  });

  it('WITHOUT the minted claim the two disagree — the state R5-H3 exists to end', async () => {
    const { root, l } = await ledgerAt();
    expect(l.claim.epoch).toBe(FIRST_EPOCH);
    const w = createHeartbeatWriter({ ledger: l, base: base() });
    w.start();
    w.stop();
    await l.close();
    const beat = await readBeat(root);
    expect(beat.claim.epoch).toBe(4);
    expect(beat.claim.epoch).not.toBe(l.claim.epoch);
  });
});

describe('R5-H3 (b) reseatClaim — the claim that is only readable after the fold', () => {
  it('seats an epoch minted after open(), and the next beat agrees with it', async () => {
    const { root, l } = await ledgerAt();
    expect(l.claim.epoch).toBe(FIRST_EPOCH);
    const afterFold = mintClaim({ deviceId: DEV_A, runId: RID, pid: l.claim.pid, at: l.claim.at, seenEpochs: [l.nextEpoch(RID) - 1] });
    l.reseatClaim(afterFold);
    expect(l.claim).toEqual(afterFold);
    const w = createHeartbeatWriter({ ledger: l, base: base({ claim: l.claim }) });
    w.start();
    w.stop();
    await l.close();
    expect((await readBeat(root)).claim).toEqual(l.claim);
  });

  it('is idempotent on the same claim and accepts an equal epoch', async () => {
    const { l } = await ledgerAt({ claim: MINTED });
    l.reseatClaim(MINTED);
    l.reseatClaim({ ...MINTED });
    expect(l.claim).toEqual(MINTED);
  });

  it('may only ever go UP: the holder is the HIGHEST qualified epoch (§14 item 18)', async () => {
    const { l } = await ledgerAt({ claim: MINTED });
    const lower: Claim = { ...MINTED, epoch: MINTED.epoch - 1 };
    expect(() => l.reseatClaim(lower)).toThrow(CoordinationError);
    expect(() => l.reseatClaim(lower)).toThrow(/lower the seated epoch from 4 to 3/);
    expect(l.claim).toEqual(MINTED);
    l.reseatClaim({ ...MINTED, epoch: MINTED.epoch + 1 });
    expect(l.claim.epoch).toBe(5);
  });

  it("refuses another device's or another run's claim — `parseRecord` binds `claim.runId` to the record", async () => {
    const { l } = await ledgerAt({ claim: MINTED });
    expect(() => l.reseatClaim({ ...MINTED, deviceId: DEV_B })).toThrow(/device 'zz5wq7cd'/);
    expect(() => l.reseatClaim({ ...MINTED, runId: runId(7) })).toThrow(/this handle's claim is on/);
    expect(l.claim).toEqual(MINTED);
  });

  it('refuses a malformed claim rather than seating it', async () => {
    const { l } = await ledgerAt({ claim: MINTED });
    for (const bad of [{ ...MINTED, epoch: 0 }, { ...MINTED, pid: 0 }, { ...MINTED, at: '' }]) {
      expect(() => l.reseatClaim(bad)).toThrow(/not well formed/);
    }
    expect(l.claim).toEqual(MINTED);
  });

  it('every refusal is a CoordinationError the surface can render, never a bare throw', async () => {
    const { l } = await ledgerAt({ claim: MINTED });
    try {
      l.reseatClaim({ ...MINTED, epoch: 1 });
      expect.unreachable('reseatClaim should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(CoordinationError);
      expect((e as CoordinationError).code).toBe('not-ours');
      expect((e as CoordinationError).detail60.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('R5-H3 (c) compat — the identity-claim caller', () => {
  it('opens with no claim at all and gets the epoch-1 identity claim, bound to this device and run', async () => {
    const { l } = await ledgerAt();
    expect(l.claim.epoch).toBe(FIRST_EPOCH);
    expect(l.claim.deviceId).toBe(DEV_A);
    expect(l.claim.runId).toBe(RID);
    expect(l.opened).toBe(true);
  });

  it('an older caller that passes the identity claim explicitly still opens, and can seat the mint later', async () => {
    const identity = claim({ runId: RID, pid: 4242 });
    const { l } = await ledgerAt({ claim: identity });
    expect(l.claim).toEqual(identity);
    l.reseatClaim(MINTED);
    expect(l.claim).toEqual(MINTED);
  });

  it('a sessionless reader (no runId) is seated on its own actor8 and still refuses a cross-run seat', async () => {
    const t = await tempHome();
    cleanups.push(t.cleanup);
    const clock = fakeClock();
    const l = openLedger({ home: t.home, self: makeSelf({ runId: null, sessionId: null }), now: clock.now, monotonicNow: clock.monotonicNow, timers: fakeTimers(clock), isPidAlive: () => true, scanOnly: true });
    cleanups.push(() => l.close());
    await l.open();
    expect(l.claim.runId).toBe(l.actor8);
    expect(l.claim.epoch).toBe(FIRST_EPOCH);
    expect(() => l.reseatClaim(MINTED)).toThrow(/this handle's claim is on/);
  });
});
