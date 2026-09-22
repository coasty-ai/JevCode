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
/**
 * §3.2 / §9.3 (design revision 4): `0 ≤ epoch ≤ MAX_CLAIM_EPOCH` or the record is a `bounds` rejection.
 * `Number.isSafeInteger` alone let a planted `9007199254740990` make every successor unmintable and the run permanently
 * unresumable on every device. At ~1 claim per resume, 1e9 is not reachable by use.
 */
export const MAX_CLAIM_EPOCH = 1_000_000_000;
/** the pre-revision-4 name, kept so nothing downstream breaks on the rename */
export const EPOCH_MAX = MAX_CLAIM_EPOCH;
/**
 * §3.2 (design revision 4): `RunMeta.claims[]` is capped at 64 — the FIRST entry (the origin incarnation, which is the
 * provenance) plus the newest 63. Only the origin and the maximum are ever read, so pruning the middle is lossless.
 */
export const MAX_CLAIMS_PER_RUN = 64;
/** the pre-revision-4 name */
export const CLAIMS_MAX = MAX_CLAIMS_PER_RUN;

/** §3.2: keep the first row and the newest `MAX_CLAIMS_PER_RUN - 1`. */
export function capClaims<T>(rows: readonly T[], max = MAX_CLAIMS_PER_RUN): T[] {
  // + re-check (lower 4): `max <= 0` must be the empty set. The old form fell through to `slice(-0)`, which is the
  // WHOLE array — a "keep nothing" bound that kept everything.
  if (max <= 0) return [];
  if (rows.length <= max) return [...rows];
  if (max === 1) return [rows[rows.length - 1] as T];
  return [rows[0] as T, ...rows.slice(rows.length - (max - 1))];
}

/** + re-check (lower 5): a parseable ISO-8601 instant, bounded — the shape `compareClaim` orders on. */
export function isIsoInstant(v: unknown): boolean {
  return typeof v === 'string' && v.length >= 20 && v.length <= 32 && Number.isFinite(Date.parse(v));
}

export function isValidClaim(c: unknown): c is Claim {
  if (typeof c !== 'object' || c === null) return false;
  const o = c as Record<string, unknown>;
  if (!Number.isSafeInteger(o['epoch']) || (o['epoch'] as number) < 1 || (o['epoch'] as number) > MAX_CLAIM_EPOCH) return false;
  if (!Number.isSafeInteger(o['pid']) || (o['pid'] as number) <= 0) return false;
  if (typeof o['deviceId'] !== 'string' || typeof o['runId'] !== 'string') return false;
  // + re-check (lower 5): `startedAt` is a TIEBREAK input of `compareClaim`, so its SHAPE is load-bearing: a forged
  // `''` sorts before every real instant and would take the tie. Only a parseable ISO instant counts.
  return isIsoInstant(o['startedAt']);
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
  return { epoch: Math.min(MAX_CLAIM_EPOCH, Math.max(FIRST_EPOCH, highEpoch(o.seenEpochs ?? []) + 1)), deviceId: o.deviceId, runId: o.runId, pid: o.pid, startedAt: o.startedAt };
}

/** The largest epoch worth following: a safe integer inside `[1, EPOCH_MAX]`; everything else is a hostile or torn value. */
export function highEpoch(epochs: readonly number[]): number {
  let max = 0;
  for (const e of epochs) if (Number.isSafeInteger(e) && e > max && e <= MAX_CLAIM_EPOCH) max = e;
  return max;
}

/**
 * + re-review (5): epochs read from a FOREIGN `runs/<dev>/<runId>/run.json` (`claims[]` / `imports[]`) count only when the
 * record they arrived with is trust-qualified. Without this, `runs/<anydev>/<myRunId>/run.json` with
 * `claims:[{ epoch: 9007199254740990 }]` makes every `/resume` on every device demand `--force-takeback` whose successor
 * epoch is unmintable — the run is permanently unresumable, and claims are never GC'd. Bounded to `MAX_CLAIMS_PER_RUN`.
 *
 * TODO(rev5) §7.3 1(a): `run.json` and the §9.3 essential-set projection carry no `hmac` / `keyId` yet, so no foreign
 * `claims[]` / `imports[]` row can be presented here as anything but `'unverified'` — the qualification path is
 * therefore FAIL-SAFE (a foreign epoch never raises the bar) and the legitimate M7 refusal is silently disabled until
 * those records are signed. The bound below applies whatever the authority, which is what stops a planted 1e9.
 */
export function qualifiedEpochs(rows: readonly { epoch: number; authority: Authority }[], o: { max?: number } = {}): number[] {
  const out: number[] = [];
  for (const r of rows.slice(-(o.max ?? CLAIMS_MAX))) {
    if (r.authority === 'unverified') continue;
    if (Number.isSafeInteger(r.epoch) && r.epoch >= FIRST_EPOCH && r.epoch <= MAX_CLAIM_EPOCH) out.push(r.epoch);
  }
  return out;
}

/**
 * `--force-takeback`'s gate: true when a fresh claim can still outrank everything seen. At the ceiling the mint returns
 * `EPOCH_MAX` again and `compareClaim` falls to `(startedAt, deviceId, pid)`, so the takeback is decided by those — the
 * caller must say so rather than claim a higher incarnation it cannot mint.
 */
export function canMintAbove(seenEpochs: readonly number[]): boolean {
  return highEpoch(seenEpochs) < MAX_CLAIM_EPOCH;
}

/**
 * `--force-takeback`'s epoch, CLAMPED: a planted `MAX_CLAIM_EPOCH` can never make a takeback mint `MAX_CLAIM_EPOCH + 1`
 * (which `isValidClaim` would then reject as out of bounds, leaving the run unresumable on every device — the very
 * outcome the bound exists to prevent). At the ceiling the takeback re-mints the ceiling and `compareClaim` decides on
 * `(startedAt, deviceId, pid)`; `canMintAbove` is how the caller knows to say so.
 */
export function forceTakebackEpoch(seenEpochs: readonly number[]): number {
  return Math.min(MAX_CLAIM_EPOCH, Math.max(FIRST_EPOCH, highEpoch(seenEpochs) + 1));
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

/**
 * `HMAC-SHA256(key, "<writerDeviceId>\n" + canonical)` over the exact text the checksum covers (record minus
 * `{ checksum, hmac }`).
 *
 * + re-review (5): the WRITER'S device id is bound INTO the signature, and the verifier only ever supplies the device id
 * of the subtree the file was read from. With one group `commonsKey` (the W5 sketch: phrase → scrypt → one key) an
 * unbound signature lets one paired device forge records under another paired device's id — auto-stop a run, poison a resume,
 * inject a `steer`, apply `pause`/`end` under `remoteControl:'allow'`. A per-device key still verifies here unchanged;
 * this is the minimum that holds while the group key exists.
 */
export function hmacOf(record: object, keyHex: string, writer: HmacWriter | string): string {
  const w: HmacWriter = typeof writer === 'string' ? { deviceId: writer, hostKey: (record as { hostKey?: string }).hostKey } : writer;
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(`${w.deviceId}\n${w.hostKey ?? ''}\n${canonicalText(record)}`).digest('hex');
}

/**
 * §10.3 (design revision 4): the canonical HMAC text starts with the writer's `deviceId` AND `hostKey`, and the verifier
 * supplies both from the PATH the file was read at (plus the record's own `hostKey`, which is bound by the id-vs-path
 * check). The key is found by that path `deviceId`, never by a `keyId` the record carries.
 */
export interface HmacWriter {
  deviceId: string;
  hostKey?: string | undefined;
}

/**
 * Constant-time compare of a record's `hmac` against the key of `deviceId`; false for a missing, short or malformed
 * value. `deviceId` is the PATH's device component (the subtree the file was read from), never the record's own field.
 */
export function hmacValid(record: object, keyHex: string | null | undefined, writer: HmacWriter | string): boolean {
  if (typeof keyHex !== 'string' || !COMMONS_KEY_RE.test(keyHex)) return false;
  const got = (record as { hmac?: unknown }).hmac;
  if (typeof got !== 'string' || got.length !== 64 || !/^[0-9a-f]{64}$/.test(got)) return false;
  const w: HmacWriter = typeof writer === 'string' ? { deviceId: writer, hostKey: (record as { hostKey?: string }).hostKey } : writer;
  const want = hmacOf(record, keyHex, w);
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));
}

/** `record` with its `hmac` set (after the checksum — both cover the same canonical text, so the order does not matter). */
export function withHmac<T extends object>(record: T, keyHex: string | null | undefined, writer: HmacWriter | string): T {
  if (typeof keyHex !== 'string' || !COMMONS_KEY_RE.test(keyHex)) return record;
  const w: HmacWriter = typeof writer === 'string' ? { deviceId: writer, hostKey: (record as { hostKey?: string }).hostKey } : writer;
  return { ...record, hmac: hmacOf(record, keyHex, w) };
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
