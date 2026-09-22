/**
 * §3.5 the fold and §3.6 `listSessions`: a pure reduction of the record SET, so the result is a function of the records and
 * the side state and NEVER of the order files arrived in (§2.1 rule 1); the §3.5 caps; the §9.3 fork rule over immutable
 * claims (review blocker 3); `sameDevice` from the read location (review blocker 6); and the 200-record budget of §12.0.
 */
import { describe, expect, it } from 'vitest';
import { byRunId, childrenOf, emptyFoldState, leaseKeysOf, listSessions, maxStampN, messageOrigin, originOf, seenEpochs, sessionTargets, FOLD_CAPS } from '../../../src/coordination/fold.js';
import { GONE_KEEP_MS, HEARTBEAT_TTL_MS, SYNC_SLACK_SHARED_MS, lockReplaceVerdict } from '../../../src/coordination/records.js';
import { DEV_A, DEV_B, REPO, SELF, T0, TRUSTED, UNVERIFIED, WS, claim, entry, foldOf, iso, makeAck, makeDevice, makeHeartbeat, makeLease, makeMessage, makeSelf, runId, shuffled, stamp } from './helpers.js';
import type { RecordEntry } from '../../../src/coordination/fold.js';

const self = makeSelf();

function peerBeat(n: number, patch: Parameters<typeof makeHeartbeat>[0] = {}): RecordEntry {
  const rid = runId(n);
  return entry(
    makeHeartbeat({ deviceId: DEV_B, runId: rid, sessionId: rid, stamp: stamp(n, DEV_B, rid), claim: claim({ deviceId: DEV_B, runId: rid, pid: 5000 + n }), ...patch }),
    TRUSTED,
  );
}

describe('determinism (§2.1 rule 1, §3.5)', () => {
  it('the fold is identical for every arrival order of one record set', () => {
    const entries: RecordEntry[] = [
      entry(makeDevice()),
      entry(makeDevice({ deviceId: DEV_B, label: 'studio' }), TRUSTED),
      entry(makeHeartbeat()),
      peerBeat(9),
      peerBeat(11, { phase: 'blocked', blocked: 'spend-limit' }),
      entry(makeLease({ paths: ['src/a.ts'] })),
      entry(makeLease({ runId: runId(9), deviceId: DEV_B, stamp: stamp(9, DEV_B, runId(9)), leaseId: `${runId(9)}-9`, paths: ['src/b.ts'] }), TRUSTED),
      entry(makeMessage({ stamp: stamp(3, DEV_B, runId(9)) }), TRUSTED),
      entry(makeMessage({ id: `${DEV_B}-abcdefgh-4`, to: `@${REPO}`, stamp: stamp(4, DEV_B, runId(9)) }), TRUSTED),
      entry(makeAck(), SELF),
    ];
    const canonical = JSON.stringify(shape(foldOf(entries)));
    for (const seed of [1, 7, 99, 12345]) {
      expect(JSON.stringify(shape(foldOf(shuffled(entries, seed)))), `seed ${seed}`).toBe(canonical);
    }
  });

  it('arrivalMono is keyed by the record CHECKSUM, so a resumed run whose beatSeq restarts stays live (review #11)', () => {
    const state = emptyFoldState();
    const first = makeHeartbeat({ deviceId: DEV_B, beatSeq: 49, claim: claim({ deviceId: DEV_B }) });
    foldOf([entry(first, TRUSTED)], { now: { wallMs: T0, monoMs: 1_000 } }, state);
    // a new process of the same run: beatSeq restarts at 1 — the checksum moved, so the arrival is refreshed
    const resumed = makeHeartbeat({ deviceId: DEV_B, beatSeq: 1, beatAt: iso(T0 + 1000), claim: claim({ deviceId: DEV_B }) });
    const late = { wallMs: T0 + 100_000, monoMs: 1_000 + HEARTBEAT_TTL_MS + SYNC_SLACK_SHARED_MS + 5_000 };
    const fold = foldOf([entry(resumed, TRUSTED)], { now: late }, state);
    expect(fold.live.has(runId(1))).toBe(true);
  });
});

function shape(f: ReturnType<typeof foldOf>): unknown {
  return {
    live: [...f.live.keys()].sort(),
    gone: [...f.gone.keys()].sort(),
    leases: [...f.leases.keys()].sort(),
    byPath: [...f.byPath.entries()].map(([p, ids]) => [p, [...ids].sort()]).sort(),
    inbox: f.inbox.map((m) => m.id),
    acks: [...f.acks.keys()].sort(),
    devices: [...f.devices.keys()].sort(),
    forks: [...(f.forks?.keys() ?? [])].sort(),
    skipped: f.skipped,
  };
}

describe('the §9.3 fork rule over immutable claims (review blocker 3, §11 row 31)', () => {
  const rid = runId(7);
  const mineClaim = claim({ epoch: 1, deviceId: DEV_A, runId: rid, pid: 100, startedAt: iso(T0 - 10_000) });
  const theirClaim = claim({ epoch: 2, deviceId: DEV_B, runId: rid, pid: 200, startedAt: iso(T0 - 1_000) });
  const mine = makeHeartbeat({ runId: rid, sessionId: rid, stamp: stamp(51, DEV_A, rid), claim: mineClaim });
  // the peer's rolling stamp is LOWER, which the old rule would have made it the holder
  const theirs = makeHeartbeat({ deviceId: DEV_B, runId: rid, sessionId: rid, pid: 200, stamp: stamp(50, DEV_B, rid), claim: theirClaim });

  it('two records for one runId: the claim holder is `live`, the rest are `forks`, and the flag is raised', () => {
    const fold = foldOf([entry(mine, SELF), entry(theirs, TRUSTED)]);
    expect(fold.live.get(rid)?.deviceId).toBe(DEV_A); // the lower CLAIM, not the lower stamp
    expect(fold.forks?.get(rid)).toHaveLength(1);
    const row = listSessions(fold, self).find((a) => a.runId === rid);
    expect(row?.flags.forked).toBe(true);
    expect(byRunId(fold, rid).map((h) => h.deviceId)).toEqual([DEV_A, DEV_B]);
    expect(seenEpochs(fold, rid)).toEqual([1, 2]);
  });

  it('the verdict does not move when the arrival order is reversed', () => {
    const a = foldOf([entry(mine, SELF), entry(theirs, TRUSTED)]);
    const b = foldOf([entry(theirs, TRUSTED), entry(mine, SELF)]);
    expect(a.live.get(rid)?.deviceId).toBe(b.live.get(rid)?.deviceId);
  });

  it('a stale claim holder hands the live row to the next incarnation (a takeover)', () => {
    const dead = { ...mine, phase: 'ended' as const };
    const fold = foldOf([entry(dead, SELF), entry(theirs, TRUSTED)]);
    expect(fold.live.get(rid)?.deviceId).toBe(DEV_B);
  });

  it('a `takeover` lease with a LATER claim marks the row `→ taken over`', () => {
    const takeover = makeLease({
      runId: rid,
      sessionId: rid,
      leaseId: `${rid}-99`,
      deviceId: DEV_B,
      type: 'takeover',
      paths: [],
      stamp: stamp(99, DEV_B, rid),
      claim: claim({ epoch: 5, deviceId: DEV_B, runId: rid, pid: 200 }),
    });
    const fold = foldOf([entry(mine, SELF), entry(takeover, TRUSTED)]);
    expect(listSessions(fold, self).find((a) => a.runId === rid)?.flags.takenOver).toBe(true);
  });
});

describe('self is decided by the read location (review blocker 6)', () => {
  it('a heartbeat planted under my device id in a MIRROR is foreign and `unverified`', () => {
    const planted = makeHeartbeat({ pid: 1, runId: runId(3), sessionId: runId(3), stamp: stamp(2, DEV_A, runId(3)), claim: claim({ runId: runId(3), pid: 1 }) });
    const mirrorOrigin = { self: false, source: '/shared/jevcode-commons', authenticated: false };
    let probed = 0;
    const fold = foldOf([entry(planted, mirrorOrigin)], { isPidAlive: () => (probed++, true) });
    expect(probed).toBe(0); // no attacker pid is ever probed
    const row = listSessions(fold, self, { all: true }).find((a) => a.runId === runId(3));
    expect(row?.sameDevice).toBe(false);
    expect(row?.authority).toBe('unverified');
    expect(row?.flags.unverified).toBe(true);
    expect(originOf(fold, planted).self).toBe(false);
  });

  it('a record from my own local subtree is `self` and its pid decides liveness', () => {
    const fold = foldOf([entry(makeHeartbeat(), SELF)]);
    const row = listSessions(fold, self)[0];
    expect(row?.sameDevice).toBe(true);
    expect(row?.authority).toBe('self');
    expect(row?.arrivalAgeMs).toBeNull();
  });

  it('a message keeps its origin so classifyIncoming cannot be fooled by `from.deviceId`', () => {
    const forged = makeMessage({ from: { deviceId: DEV_A, label: 'mbp', sessionId: runId(1), runId: runId(1), user: 'p' }, type: 'pause', stamp: stamp(9, DEV_A, runId(1)) });
    const fold = foldOf([entry(forged, { self: false, source: '/shared/jevcode-commons', authenticated: false })], { targets: sessionTargets(self) });
    expect(messageOrigin(fold, forged).self).toBe(false);
  });
});

describe('listSessions (§3.6) and the caps (§3.5)', () => {
  it('sorts live → gone → stale, keeps gone facts 10 min and `all` widens it', () => {
    const state = emptyFoldState();
    const dead = peerBeat(21, { phase: 'ended' });
    foldOf([entry(makeHeartbeat(), SELF), dead], {}, state);
    const later = { wallMs: T0 + GONE_KEEP_MS + 60_000, monoMs: 1_000_000 + GONE_KEEP_MS + 60_000 };
    const fold = foldOf([entry(makeHeartbeat({ beatAt: iso(later.wallMs) }), SELF), dead], { now: later }, state);
    const rows = listSessions(fold, self);
    expect(rows[0]?.liveness).toBe('live');
    expect(rows.some((r) => r.runId === runId(21))).toBe(false); // past the 10 min window
    expect(listSessions(fold, self, { all: true }).some((r) => r.runId === runId(21))).toBe(true);
  });

  it('a tombstoned device is skipped except under `all`, and its rows carry `ignoredDevice`', () => {
    const entries = [entry(makeDevice({ deviceId: DEV_B, label: 'old-mac' }), TRUSTED), peerBeat(31)];
    const fold = foldOf(entries, { ignoredDevices: new Set([DEV_B]) });
    expect(fold.devices.get(DEV_B)?.ignored).toBe(true);
    expect(listSessions(fold, self).some((r) => r.deviceId === DEV_B)).toBe(false);
  });

  it('`noLock` comes from the heartbeat being the second liveness signal (§11 row 15)', () => {
    const fold = foldOf([entry(makeHeartbeat({ lockHeld: false }), SELF)]);
    expect(listSessions(fold, self)[0]?.flags.noLock).toBe(true);
  });

  it('§6.5: children are the rows carrying parentSessionId', () => {
    const child = makeHeartbeat({ runId: runId(5), sessionId: runId(5), parentSessionId: runId(1), parentRunId: runId(1), stamp: stamp(5, DEV_A, runId(5)), claim: claim({ runId: runId(5), pid: 77 }) });
    const fold = foldOf([entry(makeHeartbeat(), SELF), entry(child, SELF)]);
    expect(childrenOf(fold, self, runId(1)).map((a) => a.runId)).toEqual([runId(5)]);
  });

  it('overflow past the caps drops the oldest by stamp and counts it', () => {
    const entries = Array.from({ length: FOLD_CAPS.heartbeats + 12 }, (_, i) => peerBeat(i + 1));
    const fold = foldOf(entries);
    expect(fold.live.size + fold.gone.size).toBeLessThanOrEqual(FOLD_CAPS.heartbeats);
    expect(fold.skipped).toBeGreaterThanOrEqual(12);
  });

  it('listSessions over 200 records stays under 5 ms', () => {
    const entries: RecordEntry[] = [entry(makeDevice()), entry(makeDevice({ deviceId: DEV_B, label: 'studio' }), TRUSTED)];
    for (let i = 1; i <= 200; i++) {
      entries.push(peerBeat(i));
      const rid = runId(i);
      entries.push(entry(makeLease({ runId: rid, sessionId: rid, deviceId: DEV_B, leaseId: `${rid}-${i}`, stamp: stamp(i, DEV_B, rid), paths: [`src/f${i}.ts`] }), TRUSTED));
    }
    const fold = foldOf(entries);
    expect(fold.live.size).toBeGreaterThanOrEqual(200);
    listSessions(fold, self); // warm
    const start = performance.now();
    for (let i = 0; i < 5; i++) listSessions(fold, self);
    const perCall = (performance.now() - start) / 5;
    expect(perCall, `listSessions took ${perCall.toFixed(3)} ms`).toBeLessThan(5);
  });
});

describe('§11 row 46: a session killed mid-step', () => {
  it('the gone record keeps the stage, action80 and touched set the crash card prints, for 10 min', () => {
    const state = emptyFoldState();
    const killed = makeHeartbeat({
      phase: 'running', // SIGKILL runs no handler: the beat is frozen mid-step, never marked `ended`
      step: 8,
      stage: 'execute',
      action80: 'run npm test',
      declared: { step: 8, paths: ['src/checkpoint/store.ts'], type: 'exclusive', truncated: false },
      touchedRecent: ['src/checkpoint/store.ts'],
    });
    // the pid is gone the moment we look: same-device liveness is pid-driven, so the lease is ignored at once
    const fold = foldOf([entry(killed, SELF)], { isPidAlive: () => false }, state);
    const row = listSessions(fold, self)[0];
    expect(row?.liveness).toBe('gone');
    expect(row?.heartbeat.stage).toBe('execute');
    expect(row?.heartbeat.action80).toBe('run npm test');
    expect(row?.heartbeat.declared?.paths).toEqual(['src/checkpoint/store.ts']);
    // …and a live peer no longer treats its lease as held
    const withLease = foldOf([entry(killed, SELF), entry(makeLease({ runId: runId(1), sessionId: runId(1), leaseId: `${runId(1)}-3`, paths: ['src/checkpoint/store.ts'] }), SELF)], { isPidAlive: () => false }, state);
    expect(withLease.live.size).toBe(0);
  });
});

describe('§11 row 7: a resumed run whose workspace path changed', () => {
  it('relocation matches on repoKey / remoteKey / wsKey, so a moved checkout is the same session', () => {
    const moved = makeSelf({ wsKey: 'ws:9999999999999999' }); // same repo, new realpath
    const fold = foldOf([entry(makeHeartbeat(), SELF)]);
    expect(listSessions(fold, moved)[0]?.sameRepo).toBe(true);
    // a genuinely different repo does not match
    expect(listSessions(fold, makeSelf({ repoKey: 'ffffffffffffffff', remoteKey: null, wsKey: 'ws:8888888888888888' }))[0]?.sameRepo).toBe(false);
    // a non-git tree matches only on its own wsKey
    const nonGit = foldOf([entry(makeHeartbeat({ repo: { repoKey: null, remoteKey: null } }), SELF)]);
    expect(listSessions(nonGit, makeSelf({ repoKey: null, remoteKey: null }))[0]?.sameRepo).toBe(true);
    expect(listSessions(nonGit, makeSelf({ repoKey: null, remoteKey: null, wsKey: 'ws:7777777777777777' }))[0]?.sameRepo).toBe(false);
  });
});

describe('+ review major 12: one row per (deviceId, runId) — forks included', () => {
  const rid = runId(7);
  const forked = () => {
    // two live processes on ONE runId: the claim holder (epoch 1) and a later incarnation on another device
    const holder = makeHeartbeat({ runId: rid, sessionId: rid, pid: 111, claim: claim({ epoch: 1, runId: rid, pid: 111, startedAt: iso(T0 - 90_000) }), stamp: stamp(5, DEV_A, rid) });
    const later = makeHeartbeat({ deviceId: DEV_B, runId: rid, sessionId: rid, pid: 222, label: 'studio', claim: claim({ epoch: 2, deviceId: DEV_B, runId: rid, pid: 222 }), stamp: stamp(6, DEV_B, rid) });
    return foldOf([entry(holder, SELF), entry(later, TRUSTED)]);
  };

  it('a FORK gets its own row — the case §9.3 exists for was the one `sessions who` hid', () => {
    const fold = forked();
    expect(fold.forks?.get(rid)).toHaveLength(1);
    const rows = listSessions(fold, self).filter((a) => a.runId === rid);
    expect(rows).toHaveLength(2); // the holder AND the fork, both live
    expect(rows.map((a) => a.deviceId).sort()).toEqual([DEV_A, DEV_B].sort());
    expect(rows.every((a) => a.flags.forked)).toBe(true);
    // every record the fold holds has a verdict, keyed by (deviceId, runId, pid)
    expect(fold.liveness.get(`${DEV_A}/${rid}/111`)).toBe('live');
    expect(fold.liveness.get(`${DEV_B}/${rid}/222`)).toBe('live');
  });

  it('byRunId puts the CLAIM HOLDER first and keeps two processes of one device apart', () => {
    const fold = forked();
    const rows = byRunId(fold, rid);
    expect(rows[0]?.claim.epoch).toBe(1); // the holder is the LOWEST claim, never the newest stamp
    expect(rows).toHaveLength(2);
    expect(seenEpochs(fold, rid)).toEqual([1, 2]);
  });
});

describe('+ review minor 25: an ignored device is walkable by `who --all` and by nothing else', () => {
  const ignoredDevices = new Set([DEV_B]);
  const fold = () =>
    foldOf(
      [
        entry(makeHeartbeat(), SELF),
        entry(makeDevice({ deviceId: DEV_B, label: 'old-mac' }), TRUSTED),
        peerBeat(9),
        entry(makeLease({ runId: runId(9), sessionId: runId(9), deviceId: DEV_B, leaseId: `${runId(9)}-9`, stamp: stamp(9, DEV_B, runId(9)) }), TRUSTED),
        entry(makeMessage({ to: '@all', id: `${DEV_B}-abcdefgh-9`, stamp: stamp(9, DEV_B, runId(9)) }), TRUSTED),
      ],
      { ignoredDevices },
    );

  it('its records move nothing: no live row, no lease, no inbox message', () => {
    const f = fold();
    expect(f.live.has(runId(9))).toBe(false);
    expect(f.leases.size).toBe(0);
    expect(f.inbox).toHaveLength(0);
    expect(listSessions(f, self).map((a) => a.deviceId)).toEqual([DEV_A]);
  });

  it('…but `--all` walks it and flags it, which is what makes `gc --unignore` nameable', () => {
    const f = fold();
    expect(f.ignored.size).toBe(1);
    const rows = listSessions(f, self, { all: true });
    const row = rows.find((a) => a.deviceId === DEV_B);
    expect(row).toBeDefined();
    expect(row?.flags.ignoredDevice).toBe(true);
  });
});

describe('targets, lease keys and the stamp seed', () => {
  it('§5.1: my targets are my sessionId, @repoKey, @remoteKey and @all', () => {
    expect([...sessionTargets(makeSelf({ remoteKey: 'rm:0000000000000000' }))].sort()).toEqual(['@all', `@${REPO}`, '@rm:0000000000000000', runId(1)].sort());
    expect([...sessionTargets(makeSelf({ sessionId: null, repoKey: null }))]).toEqual(['@all']);
  });

  it('a non-git workspace leases under its wsKey', () => {
    expect(leaseKeysOf(makeSelf({ repoKey: null, remoteKey: null }))).toEqual([WS]);
    expect(leaseKeysOf(makeSelf())).toEqual([REPO, WS]);
  });

  it('§3.2: the stamp seed is the largest n in the whole fold, gone records and forks included', () => {
    const fold = foldOf([entry(makeHeartbeat(), SELF), peerBeat(120), entry(makeLease({ stamp: stamp(77) }), SELF), entry(makeMessage({ stamp: stamp(300, DEV_B, runId(9)) }), TRUSTED)]);
    expect(maxStampN(fold)).toBe(300);
    expect(UNVERIFIED.authenticated).toBe(false);
  });
});

describe('§3.2 / §10.3 (revision 5): the CLONED flag', () => {
  /**
   * ITEM 5 FIXTURE — two live beats under ONE deviceId with different `bootId`s.
   *
   * That is one `deviceKey` on two machines, so the key can no longer speak for either of them. A peer never
   * deletes or rewrites anything of theirs; it marks the device and suspends every gated action for it until it is
   * re-paired. For my OWN deviceId it is the `duplicate-identity` case and the later booter adopts a new id.
   *
   * Fails before the fix: `Heartbeat` has no `bootId`, `Fold.cloned` does not exist and `flags.cloned` is absent.
   */
  it('two live beats from one FOREIGN deviceId with different bootIds mark it cloned', () => {
    const a = makeHeartbeat({ deviceId: DEV_B, runId: runId(9), sessionId: runId(9), pid: 901, bootId: 'boot-1', claim: claim({ deviceId: DEV_B, runId: runId(9), pid: 901 }), stamp: stamp(9, DEV_B, runId(9)) });
    const b = makeHeartbeat({ deviceId: DEV_B, runId: runId(10), sessionId: runId(10), pid: 902, bootId: 'boot-2', claim: claim({ deviceId: DEV_B, runId: runId(10), pid: 902 }), stamp: stamp(10, DEV_B, runId(10)) });
    const fold = foldOf([entry(a, TRUSTED), entry(b, TRUSTED), entry(makeDevice({ deviceId: DEV_B, label: 'studio' }), TRUSTED)]);
    expect(fold.cloned.has(DEV_B)).toBe(true);
    expect(fold.devices.get(DEV_B)?.cloned).toBe(true);
    for (const row of listSessions(fold, makeSelf())) if (row.deviceId === DEV_B) expect(row.flags.cloned).toBe(true);
  });

  it('two live beats with the SAME bootId are just two runs, and one beat is never a clone', () => {
    const a = makeHeartbeat({ deviceId: DEV_B, runId: runId(9), sessionId: runId(9), pid: 901, bootId: 'boot-1', claim: claim({ deviceId: DEV_B, runId: runId(9), pid: 901 }), stamp: stamp(9, DEV_B, runId(9)) });
    const b = makeHeartbeat({ deviceId: DEV_B, runId: runId(10), sessionId: runId(10), pid: 902, bootId: 'boot-1', claim: claim({ deviceId: DEV_B, runId: runId(10), pid: 902 }), stamp: stamp(10, DEV_B, runId(10)) });
    expect(foldOf([entry(a, TRUSTED), entry(b, TRUSTED)]).cloned.has(DEV_B)).toBe(false);
    expect(foldOf([entry(a, TRUSTED)]).cloned.has(DEV_B)).toBe(false);
    // a record that carries NO bootId (an older build) can never make a device look cloned
    const legacy = makeHeartbeat({ deviceId: DEV_B, runId: runId(11), sessionId: runId(11), pid: 903, claim: claim({ deviceId: DEV_B, runId: runId(11), pid: 903 }), stamp: stamp(11, DEV_B, runId(11)) });
    expect(foldOf([entry(a, TRUSTED), entry(legacy, TRUSTED)]).cloned.has(DEV_B)).toBe(false);
  });

  it('§3.4 (revision 5): `lockReplaceVerdict` never overrides a FRESH peer beat, whatever the pid says', () => {
    const peerLive = { deviceId: DEV_B, label: 'studio', step: 7, beatAgeMs: 20_000 };
    // revision 4 protected only a MISSING bootId, so the moment a clone's pid happened to be alive locally the
    // verdict was `stale-reused-pid`, the live run.lock was replaced and two engines co-wrote one state.json
    const verdict = lockReplaceVerdict({ lock: { pid: 4242, bootId: 'boot-other' }, peerLive, self: { bootId: 'boot-mine', isPidAlive: () => false } });
    expect(verdict).toMatchObject({ replace: false, reason: 'peer-live' });
    expect(verdict.replace === false && verdict.detail60).toContain('studio');
    // only `peerLive === null` lets anything be replaced
    const self = { bootId: 'boot-mine', isPidAlive: () => true };
    expect(lockReplaceVerdict({ lock: null, peerLive: null, self })).toMatchObject({ replace: true, reason: 'no-lock' });
    expect(lockReplaceVerdict({ lock: { pid: 1, bootId: 'boot-other' }, peerLive: null, self })).toMatchObject({ replace: true, reason: 'other-boot' });
    expect(lockReplaceVerdict({ lock: { pid: 1, bootId: 'boot-mine' }, peerLive: null, self: { ...self, isPidAlive: () => false } })).toMatchObject({ replace: true, reason: 'dead-pid' });
    // a lock with NO bootId and a live pid is never auto-replaced — `sessions unlock` is the only way out (§3.4)
    expect(lockReplaceVerdict({ lock: { pid: 1 }, peerLive: null, self })).toMatchObject({ replace: false, reason: 'boot-unknown' });
    expect(lockReplaceVerdict({ lock: { pid: 1, bootId: 'boot-mine' }, peerLive: null, self })).toMatchObject({ replace: false, reason: 'held' });
  });
});
