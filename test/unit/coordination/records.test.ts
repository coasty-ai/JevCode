/**
 * §3.3 / §3.4 / §4.3 records: parse as untrusted input (§2.1 rule 6, §11 rows 12 / 14 / 26), liveness (§11 rows 1 / 2 / 6),
 * overlap (§11 rows 8 / 23 / 34), redaction (§11 row 12) and the two authenticity blockers of the review — a foreign record
 * bound to the path it was read from (blocker 6) and a forged foreign beat that may not stop a run (blocker 5).
 */
import { describe, expect, it } from 'vitest';
import { authorityOf, claimHolder, compareClaim, forkVerdict, hmacOf, hmacValid, isValidClaim, mintClaim, withHmac } from '../../../src/coordination/claims.js';
import {
  COUNTER_MAX,
  HEARTBEAT_TTL_MS,
  HONOURED_TTL_MAX_MS,
  RECORD_MAX_BYTES,
  RECORD_TTL_MAX_MS,
  SKEW_MS,
  SYNC_SLACK_SHARED_MS,
  adoptableStampN,
  checksumOf,
  finalizeRecord,
  fitsRecordSize,
  isLive,
  oneLine,
  overlap,
  parseRecord,
  pathsOverlap,
  recordBytes,
  recordKindOf,
  redactRecord,
  serializeRecord,
  withChecksum,
} from '../../../src/coordination/records.js';
import { isValidBranch, LANE_DIR_RE } from '../../../src/coordination/ids.js';
import { BOOT, DEV_A, DEV_B, KEY_A, KEY_B, REPO, SELF, T0, TRUSTED, UNVERIFIED, WS, claim, iso, makeAck, makeDevice, makeHeartbeat, makeLease, makeMessage, runId, stamp } from './helpers.js';

const now = { wallMs: T0, monoMs: 1_000_000 };
const env = { deviceId: DEV_A, bootAt: BOOT, isPidAlive: () => true };

describe('parse as untrusted input (§2.1 rule 6, §11 rows 14 / 26)', () => {
  it('round-trips every kind and reports the failure class', () => {
    for (const rec of [makeHeartbeat(), makeLease(), makeMessage(), makeAck(), makeDevice()]) {
      const kind = recordKindOf(rec);
      const r = parseRecord(serializeRecord(rec), kind);
      expect(r.ok, `${kind} should parse`).toBe(true);
    }
    expect(parseRecord('not json', 'heartbeat')).toEqual({ ok: false, reason: 'json' });
    expect(parseRecord('{"v":2,"checksum":"x"}', 'heartbeat')).toEqual({ ok: false, reason: 'version' });
    expect(parseRecord('{"v":1}', 'heartbeat')).toEqual({ ok: false, reason: 'shape' });
    // a torn file: valid JSON, wrong checksum
    const torn = { ...makeHeartbeat(), step: 999 };
    expect(parseRecord(serializeRecord(torn), 'heartbeat')).toEqual({ ok: false, reason: 'checksum' });
  });

  it('§11 row 26: refuses per KIND, not the 64 KiB read bound', () => {
    const big = withChecksum({ ...makeHeartbeat(), task60: 'x'.repeat(RECORD_MAX_BYTES.heartbeat) });
    expect(recordBytes(big)).toBeGreaterThan(RECORD_MAX_BYTES.heartbeat);
    expect(fitsRecordSize('heartbeat', big)).toBe(false);
    expect(parseRecord(serializeRecord(big), 'heartbeat')).toEqual({ ok: false, reason: 'size' });
    // a 2 KiB cap on messages holds even though the read bound is 64 KiB
    expect(parseRecord(serializeRecord(withChecksum({ ...makeMessage(), text: 'y'.repeat(3000) })), 'message')).toEqual({ ok: false, reason: 'size' });
  });

  it('§11 row 26: hostile paths, ids and counters are refused', () => {
    const bad = (patch: Partial<Parameters<typeof makeLease>[0]>): string => serializeRecord(makeLease(patch));
    expect(parseRecord(bad({ paths: ['../../etc/passwd'] }), 'lease').ok).toBe(false);
    expect(parseRecord(bad({ paths: ['/etc/passwd'] }), 'lease').ok).toBe(false);
    expect(parseRecord(bad({ deviceId: 'NOPE' }), 'lease')).toEqual({ ok: false, reason: 'id' });
    // review #35: a `stamp.n` of 1e300 would freeze every reader's Lamport counter for good
    expect(parseRecord(serializeRecord(withChecksum({ ...makeHeartbeat(), stamp: { n: 1e300, deviceId: DEV_A, runId: runId(1) } })), 'heartbeat')).toEqual({ ok: false, reason: 'shape' });
    expect(parseRecord(serializeRecord(withChecksum({ ...makeHeartbeat(), pid: -1 })), 'heartbeat')).toEqual({ ok: false, reason: 'shape' });
    expect(adoptableStampN(5, 1)).toBe(true);
    expect(adoptableStampN(COUNTER_MAX + 1, 1)).toBe(false);
  });

  it('review #36: an oid or branch that git would read as an option is refused; review #37 bounds laneDir', () => {
    expect(parseRecord(serializeRecord(makeLease({ head: '--upload-pack=evil' })), 'lease')).toEqual({ ok: false, reason: 'id' });
    expect(parseRecord(serializeRecord(makeLease({ branch: '--exec=rm -rf /' })), 'lease')).toEqual({ ok: false, reason: 'id' });
    expect(parseRecord(serializeRecord(makeLease({ head: 'a'.repeat(40) })), 'lease').ok).toBe(true);
    for (const b of ['-x', 'a..b', 'a@{1}', 'x.lock', 'a b', 'x~1']) expect(isValidBranch(b), b).toBe(false);
    for (const b of ['main', 'feature/x', 'jevcode/fix-tests']) expect(isValidBranch(b), b).toBe(true);
    expect(parseRecord(serializeRecord(makeLease({ type: 'lane', laneDir: 'post' })), 'lease')).toEqual({ ok: false, reason: 'id' });
    expect(LANE_DIR_RE.test('tmp/synth/lane2')).toBe(true);
    for (const d of ['.', 'post', 'tmp/../..', 'tmp/synth/lane'] as const) expect(LANE_DIR_RE.test(d), d).toBe(false);
  });

  it('review blocker 6: a record must agree with the PATH it was read from', () => {
    const hb = makeHeartbeat({ deviceId: DEV_B, runId: runId(4), sessionId: runId(4), stamp: stamp(3, DEV_B, runId(4)), claim: claim({ deviceId: DEV_B, runId: runId(4) }) });
    // read from B's subtree: fine
    expect(parseRecord(serializeRecord(hb), 'heartbeat', { deviceId: DEV_B }).ok).toBe(true);
    // the same bytes planted under MY device id: refused, so it can never read as same-device
    expect(parseRecord(serializeRecord(hb), 'heartbeat', { deviceId: DEV_A })).toEqual({ ok: false, reason: 'id' });
    // a message whose `to` disagrees with its target directory is refused too
    const msg = makeMessage({ to: runId(1) });
    expect(parseRecord(serializeRecord(msg), 'message', { deviceId: DEV_B, target: runId(1) }).ok).toBe(true);
    expect(parseRecord(serializeRecord(msg), 'message', { deviceId: DEV_B, target: '@all' })).toEqual({ ok: false, reason: 'id' });
  });
});

describe('secrets and text hygiene (§10.2, §11 row 12)', () => {
  it('every string leaf goes through redact() then oneLine; keys are untouched', () => {
    const redact = (s: string): string => s.replace(/sk-[a-z0-9]+/g, '[REDACTED:key]');
    const rec = redactRecord({ task60: 'use sk-abc123 for auth', nested: { note: 'line1\nline2\ttabbed' }, list: ['sk-deadbeef'], n: 7 }, redact);
    expect(rec.task60).toBe('use [REDACTED:key] for auth');
    expect(rec.nested.note).toBe('line1 ⏎ line2 tabbed');
    expect(rec.list[0]).toBe('[REDACTED:key]');
    expect(rec.n).toBe(7);
  });

  it('a terminal escape, a C1 CSI and a bidi override never survive oneLine', () => {
    expect(oneLine('a\u001b[31mred\u001b[0m')).not.toContain('\u001b[31m');
    expect(oneLine('task\u009b31m')).toBe('task31m');
    expect(oneLine('‮reversed‬')).toBe('reversed');
    expect(oneLine('a b c')).toBe('a ⏎ b ⏎ c');
  });

  it('finalizeRecord redacts THEN checksums, so the hash covers the redacted bytes', () => {
    const redact = (s: string): string => s.replace('hunter2', '[REDACTED:pw]');
    const rec = finalizeRecord({ ...makeMessage({ text: 'password hunter2' }), checksum: '' }, redact);
    expect(rec.text).toBe('password [REDACTED:pw]');
    expect(rec.checksum).toBe(checksumOf(rec));
    expect(serializeRecord(rec)).not.toContain('hunter2');
  });
});

describe('liveness (§3.4, §11 rows 1 / 2 / 6)', () => {
  it('§11 row 1: same device is pid-driven — a 5-min-old beat with a live pid is live and only `hung`', () => {
    const hb = makeHeartbeat({ beatAt: iso(T0 - 300_000) });
    const v = isLive(hb, now, null, env, SELF);
    expect(v.liveness).toBe('live');
    expect(v.hung).toBe(true);
    expect(isLive({ ...hb, phase: 'ended' }, now, null, env, SELF).liveness).toBe('stale');
    expect(isLive(hb, now, null, { ...env, isPidAlive: () => false }, SELF).liveness).toBe('stale');
  });

  it('§11 row 2 (design revision 5): the reused pid is decided by `bootId`, and the wall-arithmetic rule is WITHDRAWN', () => {
    // revision 2 read `startedAt < bootAt` as a reused pid. A forward clock step (NTP after sleep, a VM restore, a
    // manual set) larger than the process's age-since-boot then made a LIVE process stale, `takeRunLock` replaced its
    // run.lock and two engines co-wrote one state.json. A clock may never decide this.
    const clockJumped = makeHeartbeat({ startedAt: iso(Date.parse(BOOT) - 60_000) });
    expect(isLive(clockJumped, now, null, env, SELF).liveness).toBe('live');
    // a KNOWN, differing bootId with no fresh beat and a live pid IS the reused-pid case, and the only one
    const myBoot = { ...env, bootId: 'boot-now' };
    const previousBoot = makeHeartbeat({ bootId: 'boot-before' });
    expect(isLive(previousBoot, now, null, myBoot, SELF).liveness).toBe('stale-reused-pid');
    // ... with a DEAD pid it is simply gone
    expect(isLive(previousBoot, now, null, { ...myBoot, isPidAlive: () => false }, SELF).liveness).toBe('stale');
    // §3.2 duplicate-identity (ii): a differing bootId with a FRESH beat is a live CLONE, not a reboot — it folds as
    // foreign (judged by arrival) and is live. A previous boot of my machine stops renewing; a clone does not.
    expect(isLive(previousBoot, now, { arrivalMono: now.monoMs - 1_000 }, myBoot, SELF).liveness).toBe('live');
    // an older build wrote no bootId at all: a live pid is never auto-replaced
    expect(isLive(makeHeartbeat(), now, null, myBoot, SELF).liveness).toBe('live');
  });

  it('+ re-check (5): a hostile `ttlMs` cannot buy a peer 11 days of liveness', () => {
    const hostile = makeHeartbeat({ deviceId: DEV_B, ttlMs: HONOURED_TTL_MAX_MS * 100, claim: claim({ deviceId: DEV_B }) });
    // `isLive` honours min(ttlMs, 4 beats), so the window is bounded whatever the record claims
    const pastHonoured = now.monoMs - (HONOURED_TTL_MAX_MS + SYNC_SLACK_SHARED_MS + 1);
    expect(isLive(hostile, now, { arrivalMono: pastHonoured }, env, TRUSTED).liveness).toBe('stale');
    // and a record may not even CARRY more than ten beats of ttl
    expect(parseRecord(serializeRecord(makeHeartbeat({ ttlMs: RECORD_TTL_MAX_MS + 1 })), 'heartbeat')).toEqual({ ok: false, reason: 'bounds' });
    expect(parseRecord(serializeRecord(makeHeartbeat({ ttlMs: 0 })), 'heartbeat')).toEqual({ ok: false, reason: 'bounds' });
  });

  it('foreign liveness is the RECEIVER monotonic arrival time; a listed-but-unreadable file is `unknown`', () => {
    const hb = makeHeartbeat({ deviceId: DEV_B, claim: claim({ deviceId: DEV_B }) });
    expect(isLive(hb, now, { arrivalMono: now.monoMs - 1000 }, env, TRUSTED).liveness).toBe('live');
    const tooOld = now.monoMs - (HEARTBEAT_TTL_MS + SYNC_SLACK_SHARED_MS + 1);
    expect(isLive(hb, now, { arrivalMono: tooOld }, env, TRUSTED).liveness).toBe('stale');
    expect(isLive(hb, now, null, env, TRUSTED).liveness).toBe('unknown');
  });

  it('§11 row 6: a clock 7 min ahead is `skewed` but still live; wall time is never a liveness input', () => {
    const hb = makeHeartbeat({ deviceId: DEV_B, beatAt: iso(T0 + SKEW_MS + 120_000), claim: claim({ deviceId: DEV_B }) });
    const v = isLive(hb, now, { arrivalMono: now.monoMs }, env, TRUSTED);
    expect(v.liveness).toBe('live');
    expect(v.skewed).toBe(true);
    expect(v.skewMs).toBeGreaterThan(SKEW_MS);
  });

  it('review blocker 6: a record planted under my device id is judged FOREIGN, so no attacker pid is probed', () => {
    let probed = 0;
    const hostile = makeHeartbeat({ pid: 1 });
    const v = isLive(hostile, now, null, { ...env, isPidAlive: () => (probed++, true) }, UNVERIFIED);
    expect(v.liveness).toBe('unknown'); // foreign + no arrival
    expect(probed).toBe(0);
  });
});

describe('claims — the immutable fork fence (review blocker 3)', () => {
  it('the holder is the lowest claim and the verdict never depends on the order records arrived', () => {
    const a = claim({ epoch: 1, deviceId: DEV_A, pid: 10, startedAt: iso(T0 - 5000) });
    const b = claim({ epoch: 2, deviceId: DEV_B, pid: 11, startedAt: iso(T0 - 1000) });
    expect(compareClaim(a, b)).toBe(-1);
    expect(compareClaim(b, a)).toBe(1);
    expect(claimHolder([b, a])).toEqual(a);
    expect(claimHolder([a, b])).toEqual(a);
    expect(forkVerdict(a, [{ claim: b, authority: 'trusted' }]).role).toBe('holder');
    expect(forkVerdict(b, [{ claim: a, authority: 'trusted' }]).role).toBe('loser');
  });

  it('two processes that minted one epoch are ordered by startedAt, then deviceId, then pid — total and stable', () => {
    const base = { epoch: 3, runId: runId(1), startedAt: iso(T0) };
    const x = { ...base, deviceId: DEV_A, pid: 2 };
    const y = { ...base, deviceId: DEV_A, pid: 9 };
    expect(compareClaim(x, y)).toBe(-1);
    expect(compareClaim({ ...base, deviceId: 'aaaaaaaa', pid: 9 }, y)).toBe(-1);
    expect(compareClaim(x, { ...x })).toBe(0);
  });

  it('the review’s A:48 / B:50 interleaving: the FOLDING stamp flips, the claim does not', () => {
    // both engines claim one runId; A started first, so A holds — whatever each side last folded
    const aClaim = mintClaim({ deviceId: DEV_A, runId: runId(7), pid: 100, startedAt: iso(T0 - 10_000), seenEpochs: [] });
    const bClaim = mintClaim({ deviceId: DEV_B, runId: runId(7), pid: 200, startedAt: iso(T0 - 1_000), seenEpochs: [aClaim.epoch] });
    expect(aClaim.epoch).toBe(1);
    expect(bClaim.epoch).toBe(2);
    // A folds B first, then B folds A's LATER beat: both still agree A holds
    expect(forkVerdict(aClaim, [{ claim: bClaim, authority: 'trusted' }]).holder).toEqual(aClaim);
    expect(forkVerdict(bClaim, [{ claim: aClaim, authority: 'trusted' }]).holder).toEqual(aClaim);
    // exactly one loser
    const roles = [forkVerdict(aClaim, [{ claim: bClaim, authority: 'trusted' }]).role, forkVerdict(bClaim, [{ claim: aClaim, authority: 'trusted' }]).role];
    expect(roles.filter((r) => r === 'loser')).toHaveLength(1);
  });

  it('review blocker 5: a FORGED foreign claim can never make this process stop', () => {
    const mine = claim({ epoch: 2, deviceId: DEV_A, runId: runId(7), pid: 100, startedAt: iso(T0) });
    const forged = claim({ epoch: 1, deviceId: DEV_B, runId: runId(7), pid: 1, startedAt: iso(T0 - 99_999) });
    const unverified = forkVerdict(mine, [{ claim: forged, authority: 'unverified' }]);
    expect(unverified.role).toBe('loser'); // displayed as forked …
    expect(unverified.verified).toBe(false); // … but the stop is NOT authorised (§10.3)
    const paired = forkVerdict(mine, [{ claim: forged, authority: 'trusted' }]);
    expect(paired.verified).toBe(true);
  });

  it('a malformed or unbounded claim is refused', () => {
    expect(isValidClaim(claim())).toBe(true);
    for (const bad of [null, {}, { ...claim(), epoch: 0 }, { ...claim(), epoch: 1e300 }, { ...claim(), pid: 0 }, { ...claim(), deviceId: 1 }]) expect(isValidClaim(bad)).toBe(false);
  });
});

describe('authenticity (§10.3)', () => {
  it('the hmac covers the same canonical text as the checksum and a single edited byte breaks it', () => {
    const signedHb = withHmac(makeHeartbeat(), KEY_A, DEV_A);
    expect(hmacValid(signedHb, KEY_A, DEV_A)).toBe(true);
    expect(hmacValid(signedHb, KEY_B, DEV_A)).toBe(false);
    expect(hmacValid({ ...signedHb, step: 8 }, KEY_A, DEV_A)).toBe(false);
    expect(hmacValid(makeHeartbeat(), KEY_A, DEV_A)).toBe(false); // unsigned
    expect(hmacValid(signedHb, 'short', DEV_A)).toBe(false);
    expect(hmacOf(makeHeartbeat(), KEY_A, DEV_A)).toMatch(/^[0-9a-f]{64}$/);
    // + re-review (5): the same bytes under the same GROUP key do not verify for another device's subtree
    expect(hmacValid(signedHb, KEY_A, DEV_B)).toBe(false);
  });

  it('authority comes from the origin, never from the record', () => {
    expect(authorityOf(SELF)).toBe('self');
    expect(authorityOf(TRUSTED)).toBe('trusted');
    expect(authorityOf(UNVERIFIED)).toBe('unverified');
  });
});

describe('overlap (§4.3 step 2, §11 rows 8 / 23 / 34)', () => {
  it('exact, subtree and case-folded matches; NFC and ./ normalisation', () => {
    expect(pathsOverlap('src/x.ts', 'src/x.ts')).toBe(true);
    expect(pathsOverlap('src/tui/', 'src/tui/App.tsx')).toBe(true);
    expect(pathsOverlap('src/x.ts', 'src/y.ts')).toBe(false);
    expect(pathsOverlap('./src/x.ts', 'src/x.ts')).toBe(true);
    // §11 row 23: only when the volume folds case
    expect(pathsOverlap('Src/A.ts', 'src/a.ts')).toBe(false);
    expect(pathsOverlap('Src/A.ts', 'src/a.ts', { caseFold: true })).toBe(true);
  });

  it('every overlapping pair is reported, prefixes conservatively', () => {
    expect(overlap(['src/a.ts', 'docs/b.md'], ['src/'])).toEqual([{ path: 'src/a.ts', with: 'src/' }]);
    expect(overlap(['src/a.ts'], ['test/a.ts'])).toEqual([]);
  });
});

describe('§11 row 4: a stray record under our subtree is skipped, not trusted', () => {
  it('a heartbeat whose repo keys are malformed never enters the fold', () => {
    const hb = withChecksum({ ...makeHeartbeat(), repo: { ...makeHeartbeat().repo, wsKey: 'nope', repoKey: REPO, remoteKey: null } });
    expect(parseRecord(serializeRecord(hb), 'heartbeat')).toEqual({ ok: false, reason: 'id' });
    expect(WS).toMatch(/^ws:/);
  });
});
