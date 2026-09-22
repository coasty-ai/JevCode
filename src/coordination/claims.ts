/**
 * Claims (review blocker 3) and record authenticity (blockers 5 / 6) — `docs/research/coordination/review-2026-09-21.md`.
 *
 * The §9.3 fork rule and `foreignLive` may not compare the Lamport `Stamp`: it folds (`max(n, observed) + 1` on every fold
 * and every issue) and a heartbeat is ONE file per run overwritten every beat, so intermediate values are never seen and two
 * engines can both read themselves as the holder (the review's A:48 / B:50 interleaving). A `Claim` is minted once per
 * process and never changes, so the verdict is a function of the two records alone — stable whatever the sync timing.
 *
 * Authenticity is the second half: §10.3 says only hmac-valid records from a paired device may become `steer` / `pause` /
 * `resume` / `end`, and the review extends that to the exit-2 fork stop. `hmacOf` is HMAC-SHA256 over the same canonical
 * text the checksum covers, so a record's identity fields cannot be edited without the paired key.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalText } from './checksum.js';
import type { Authority, Claim, RecordOrigin } from './types.js';

// ── claims ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A fresh run's incarnation. */
export const FIRST_EPOCH = 1;
/** §2.1 rule 6: a hostile `epoch` may not poison the mint (`n + 1 === n` at 2^53). */
export const EPOCH_MAX = 1_000_000;

export function isValidClaim(c: unknown): c is Claim {
  if (typeof c !== 'object' || c === null) return false;
  const o = c as Record<string, unknown>;
  if (!Number.isSafeInteger(o['epoch']) || (o['epoch'] as number) < 1 || (o['epoch'] as number) > EPOCH_MAX) return false;
  if (!Number.isSafeInteger(o['pid']) || (o['pid'] as number) <= 0) return false;
  return typeof o['deviceId'] === 'string' && typeof o['runId'] === 'string' && typeof o['startedAt'] === 'string';
}

/**
 * Total order on claims. The HOLDER is the MINIMUM: the earliest incarnation keeps the run and a newcomer yields, which is
 * §9.3's "the lower stamp holds" made stable. Ties inside one epoch (two processes that folded the same set) fall to
 * `startedAt` — the process that started first claimed first — then `deviceId`, then `pid`.
 */
export function compareClaim(a: Claim, b: Claim): -1 | 0 | 1 {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.pid !== b.pid) return a.pid < b.pid ? -1 : 1;
  return 0;
}

export function sameClaim(a: Claim, b: Claim): boolean {
  return compareClaim(a, b) === 0;
}

/** The holder of a set of claims on one runId (the minimum), or null for an empty set. */
export function claimHolder(claims: readonly Claim[]): Claim | null {
  let best: Claim | null = null;
  for (const c of claims) if (best === null || compareClaim(c, best) < 0) best = c;
  return best;
}

/**
 * Mint this process's claim: `epoch = max(every epoch already seen for this runId) + 1`, so a resume, a takeover or an
 * import is always a LATER incarnation than the one it replaces and therefore yields to an origin that is still live.
 * Minted ONCE (at `createEngine`) and never touched again.
 */
export function mintClaim(o: { deviceId: string; runId: string; pid: number; startedAt: string; seenEpochs?: readonly number[] }): Claim {
  let max = 0;
  for (const e of o.seenEpochs ?? []) if (Number.isSafeInteger(e) && e > max && e <= EPOCH_MAX) max = e;
  return { epoch: Math.min(EPOCH_MAX, Math.max(FIRST_EPOCH, max + 1)), deviceId: o.deviceId, runId: o.runId, pid: o.pid, startedAt: o.startedAt };
}

export type ForkRole = 'alone' | 'holder' | 'loser';

export interface ForkVerdict {
  role: ForkRole;
  /** the winning claim among every record for this runId (mine included) */
  holder: Claim;
  /** the claims that lost, in order */
  losers: Claim[];
  /**
   * §10.3 + review blocker 5: true only when EVERY foreign claim that beats mine came from an authenticated record. A
   * forged heartbeat can therefore never make this process stop — it can only raise the `⚠ forked` flag and a notice.
   */
  verified: boolean;
}

/**
 * The fork decision for one runId (review blocker 3 / 5). `others` are the OTHER live records' claims with the authority
 * the reader derived from their origin. Symmetric: both sides compute the same `holder` from the same immutable claims.
 */
export function forkVerdict(mine: Claim, others: readonly { claim: Claim; authority: Authority }[]): ForkVerdict {
  const all = [mine, ...others.map((o) => o.claim)];
  const holder = claimHolder(all) ?? mine;
  const losers = all.filter((c) => !sameClaim(c, holder)).sort(compareClaim);
  if (others.length === 0) return { role: 'alone', holder, losers: [], verified: true };
  const beatsMe = others.filter((o) => compareClaim(o.claim, mine) < 0);
  const verified = beatsMe.length > 0 && beatsMe.every((o) => o.authority !== 'unverified');
  return { role: sameClaim(holder, mine) ? 'holder' : 'loser', holder, losers, verified };
}

// ── authenticity ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** §10.3: 32 bytes from the pairing phrase; hex on disk in `coordination/device.key` (0600), never in a published record. */
export const COMMONS_KEY_BYTES = 32;
export const COMMONS_KEY_RE = /^[0-9a-f]{64}$/;

/** `HMAC-SHA256(key, canonical)` over the exact text the checksum covers (record minus `{ checksum, hmac }`). */
export function hmacOf(record: object, keyHex: string): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(canonicalText(record)).digest('hex');
}

/** Constant-time compare of a record's `hmac` against the key; false for a missing, short or malformed value. */
export function hmacValid(record: object, keyHex: string | null | undefined): boolean {
  if (typeof keyHex !== 'string' || !COMMONS_KEY_RE.test(keyHex)) return false;
  const got = (record as { hmac?: unknown }).hmac;
  if (typeof got !== 'string' || got.length !== 64 || !/^[0-9a-f]{64}$/.test(got)) return false;
  const want = hmacOf(record, keyHex);
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));
}

/** `record` with its `hmac` set (after the checksum — both cover the same canonical text, so the order does not matter). */
export function withHmac<T extends object>(record: T, keyHex: string | null | undefined): T {
  if (typeof keyHex !== 'string' || !COMMONS_KEY_RE.test(keyHex)) return record;
  return { ...record, hmac: hmacOf(record, keyHex) };
}

/**
 * Review blocker 6: the authority of a record is a function of WHERE it was read and whether its hmac verifies — never of
 * `record.deviceId` or `from.deviceId`. A file planted at `<sharedDir>/jevcode-commons/inbox/<myDeviceId>/…` is
 * `'unverified'`, not `'self'`.
 */
export function authorityOf(origin: RecordOrigin): Authority {
  if (origin.self) return 'self';
  return origin.authenticated ? 'trusted' : 'unverified';
}

/** The origin of a record read from THIS process's own local subtree. */
export const SELF_ORIGIN: RecordOrigin = { self: true, source: null, authenticated: true };
/** The origin a bare in-memory fixture gets: foreign and unverified — the conservative default (blocker 6). */
export const FOREIGN_ORIGIN: RecordOrigin = { self: false, source: null, authenticated: false };
