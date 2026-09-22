/**
 * Records (§3.3 heartbeat, §4.3 lease, §5.1 message / ack, §3.1 device): parse as untrusted input (§2.1 rule 6), checksum,
 * redact, the liveness rule of §3.4 and the path overlap of §4.3 step 2. Pure functions; no I/O.
 */
import { isJsonObject, parseJson } from '../core/json.js';
import { byteLength, clip } from '../core/text.js';
import type { JsonObject } from '../core/types.js';
import { DIRECTIVE_MAX_CHARS } from '../core/types.js';
import { checksumOf, withChecksum } from './checksum.js';
import { MAX_CLAIM_EPOCH, hmacValid, isValidClaim } from './claims.js';
import { keyDir } from './paths.js';
import { ACTOR8_RE, CONSUMER_ID_RE, COUNTER_MAX, DEVICE_ID_RE, LANE_DIR_RE, LEASE_ID_RE, LEASE_PATHS_MAX, HOST_KEY_RE, MSG_ID_RE, OID_RE, REPO_KEY_RE, RUN_ID_RE, SLUG_RE, TOUCHED_RECENT_MAX, isValidBranch, isValidRelPath, isValidTarget } from './ids.js';
import type { Ack, AnyRecord, DeviceRecord, Heartbeat, Lease, LivenessEnv, LivenessVerdict, Message, RecordKind, RecordOf, RecordOrigin, Stamp } from './types.js';

export { checksumOf, withChecksum } from './checksum.js';

// ── errors (§12.0.4, design revision 4) ─────────────────────────────────────────────────────────────────────────────

/**
 * One error type for all thirteen write verbs. A write verb NEVER throws a bare errno and never rejects with a string.
 *
 * The rule, stated once: a REFUSAL the user can act on is a RESULT (`removeWorktree().refused`, `syncDisable()`), a
 * PRECONDITION the caller got wrong — or an environment that cannot serve the verb at all — is a `CoordinationError`,
 * and a PER-FILE failure inside a bulk verb (`gc`, `sweep`, `purgeInbox`) is COUNTED in that verb's report. An
 * unclassified errno surfaces as code `'io'` with the errno in `detail60`, so the surface never pattern-matches on
 * `err.code` from `node:fs`.
 */
export type CoordinationErrorCode =
  | 'dirty-base'
  | 'branch-exists'
  | 'slug-taken'
  | 'not-found'
  | 'not-ours'
  | 'label-too-long'
  | 'unknown-device'
  | 'ambiguous-device'
  // design revision 5, §12.0.4
  | 'self-device'
  | 'not-paired'
  | 'too-many-devices'
  | 'epoch-exhausted'
  | 'offline'
  | 'readonly'
  | 'no-space'
  | 'denied'
  | 'io';

export class CoordinationError extends Error {
  readonly code: CoordinationErrorCode;
  /** redacted, one line, ready to render */
  readonly detail60: string;
  /** `'ambiguous-device'` only (§5.3 listing) */
  readonly candidates?: readonly unknown[];
  constructor(code: CoordinationErrorCode, message: string, o: { detail60?: string; candidates?: readonly unknown[] } = {}) {
    super(message);
    this.name = 'CoordinationError';
    this.code = code;
    this.detail60 = oneLine(o.detail60 ?? message).slice(0, 60);
    if (o.candidates !== undefined) this.candidates = o.candidates;
  }
}

/** §11 row 13 → §12.0.4: the errno classes a write verb reports as a typed code rather than a raw `node:fs` error. */
export function coordinationCodeOf(errno: string | null): CoordinationErrorCode {
  switch (errno) {
    case 'EROFS':
      return 'readonly';
    case 'ENOSPC':
    case 'EDQUOT':
      return 'no-space';
    case 'EACCES':
    case 'EPERM':
      return 'denied';
    case 'ETIMEDOUT':
    case 'ESTALE':
    case 'ENOTCONN':
      return 'offline';
    default:
      return 'io';
  }
}

// ── bounds ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** §3.3 / §4.3 / §5.1: the on-disk size each record kind may reach — refused, never truncated. */
export const RECORD_MAX_BYTES: Readonly<Record<RecordKind, number>> = { heartbeat: 4096, lease: 8192, message: 2048, ack: 2048, device: 2048 };
/** §2.1 rule 6: no read pulls more than this into memory. */
export const READ_MAX_BYTES = 65_536;
/** §3.3: the heartbeat interval and the ttl (3 beats) */
export const HEARTBEAT_MS = 15_000;
export const HEARTBEAT_TTL_MS = 45_000;
/** §3.4: foreign staleness slack beyond the ttl */
export const SYNC_SLACK_SHARED_MS = 120_000;
export const SYNC_SLACK_GIT_MS = 180_000;
/** §3.4: `beatAt` this far ahead of the reader's wall clock is `skewed` (display only) */
export const SKEW_MS = 300_000;
/**
 * + re-check (5): the ttl a READER will honour, whatever a record claims. `ttlMs` is a writer-controlled number and
 * `isLive` adds it to the slack, so `ttlMs: 1e9` (≈ 11.6 days, inside `COUNTER_MAX`) kept a foreign heartbeat — and
 * therefore every `exclusive` lease it holds — `live` for a week and a half. B4 removed the `expiresAt` gate on the
 * lease precisely because a beating owner's lease never expires, so this clamp is the only bound left on the window.
 * A legitimate beat is 15 s with a 45 s ttl; four beats of slack is generous and still bounded.
 */
export const HONOURED_TTL_MAX_MS = 4 * HEARTBEAT_TTL_MS;
/** + re-check (5): the largest `ttlMs` a record may even CARRY; past this the record is a `bounds` rejection. */
export const RECORD_TTL_MAX_MS = 10 * HEARTBEAT_TTL_MS;
/** + re-check (5): the ttl `isLive` uses — never the raw field. */
export function honouredTtlMs(ttlMs: number): number {
  return Math.min(Number.isSafeInteger(ttlMs) && ttlMs > 0 ? ttlMs : HEARTBEAT_TTL_MS, HONOURED_TTL_MAX_MS);
}
/** §3.4: a stale run keeps its facts in the fold this long as `gone` */
export const GONE_KEEP_MS = 600_000;
/** §4.3 step 7: lease ttl; renewed every heartbeat while the owner beats */
export const LEASE_TTL_MS = 600_000;
/** §5.1: message expiry — 7 d, control types 10 min */
export const MESSAGE_TTL_MS = 7 * 86_400_000;
export const CONTROL_MESSAGE_TTL_MS = 600_000;
export const CONTROL_MESSAGE_TYPES: ReadonlySet<string> = new Set(['pause', 'abort', 'steer', 'resume', 'end']);
export const SUBWORK_MAX = 16;
/** review #35: the bound every integer field of a record must stay inside (declared in `ids.ts`; re-exported here) */
export { COUNTER_MAX };
/**
 * review #35 / + re-check (6): an observed Lamport `n` further than this above our own is a hostile value and is not
 * adopted. Revision 4's 1e9 was the whole counter range, so one observation could put a clock a thousand issues from
 * the saturation ceiling; 1e6 is ~30 years of one issue a second and cannot be reached by use.
 */
export const STAMP_ADOPT_MAX_DELTA = 1_000_000;
/**
 * + review major 16: the clock never ADOPTS a value inside this margin of `COUNTER_MAX`. `issue()` saturates at the cap
 * (ids.ts), so adopting the cap itself would leave every later stamp equal and the Lamport order flat; refusing the top
 * of the range keeps `issue()` strictly increasing for the life of a run.
 */
export const STAMP_ADOPT_MARGIN = 1_000;
export const STAMP_ADOPT_CEILING = COUNTER_MAX - STAMP_ADOPT_MARGIN;
export const NEXT3_MAX_CHARS = 80;
export const LEASES_IN_BEAT_MAX = 8;
export const MESSAGE_FILES_MAX = 32;

// ── stamps ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** §3.2: total order `(n, deviceId, runId)`; two processes on one device never tie (`runId` is unique). */
export function compareStamp(a: Stamp, b: Stamp): -1 | 0 | 1 {
  if (a.n !== b.n) return a.n < b.n ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1;
  return 0;
}

/** review #35: only adopt an observed Lamport `n` that is plausibly ours to follow; a hostile 1e9 jump is ignored. */
export function adoptableStampN(observed: number, own: number): boolean {
  return Number.isSafeInteger(observed) && observed >= 0 && observed < STAMP_ADOPT_CEILING && observed - own < STAMP_ADOPT_MAX_DELTA;
}

// ── text hygiene ──────────────────────────────────────────────────────────────────────────────────────────────────────

const C0_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const BIDI_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** `indexOneLine` (session/index.ts) re-stated here: newlines → ` ⏎ `, tabs → space, C0/DEL/C1 and bidi controls dropped, trimmed. */
export function oneLine(s: string): string {
  return s
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, ' ⏎ ')
    .replace(/\t/g, ' ')
    .replace(C0_RE, '')
    .replace(BIDI_RE, '')
    .trim();
}

const MAX_REDACT_DEPTH = 12;

function redactDeep(value: unknown, redact: (s: string) => string, depth: number): unknown {
  if (typeof value === 'string') return oneLine(redact(value));
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_REDACT_DEPTH) return '[redaction depth limit]';
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = redactDeep(v, redact, depth + 1);
  return out;
}

/** §10.2: every string leaf through `redact()` then `oneLine`; keys untouched; `undefined` members dropped. */
export function redactRecord<T extends object>(record: T, redact: (s: string) => string): T {
  return redactDeep(record, redact, 0) as T;
}

/** Redact, then checksum — the last two steps of every writer. */
export function finalizeRecord<T extends { checksum: string }>(record: T, redact: (s: string) => string): T {
  return withChecksum(redactRecord(record, redact));
}

/** `JSON.stringify(record) + '\n'` — the exact bytes on disk. */
export function serializeRecord(record: object): string {
  return `${JSON.stringify(record)}\n`;
}

export function recordBytes(record: object): number {
  return byteLength(serializeRecord(record));
}

/** True when the serialised record fits its kind's cap (§12.0.4 "refused, never truncated"). */
export function fitsRecordSize(kind: RecordKind, record: object): boolean {
  return recordBytes(record) <= RECORD_MAX_BYTES[kind];
}

// ── parsing ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** §12.0.4: `'bounds'` (design revision 4) is a counter outside its documented range — `claim.epoch > MAX_CLAIM_EPOCH`,
 *  a `stamp.n` of 1e300 — told apart from a mistyped field (`'shape'`) and a malformed id (`'id'`). */
export type ParseFailure = 'size' | 'json' | 'shape' | 'version' | 'id' | 'bounds' | 'checksum';
/**
 * §12.0.4 (design revision 4): `verified` is REPORTED, never a gate. A record that does not verify still parses — the
 * fold needs it for `⚠ forked`, for `who`'s `unverified` flag and for the `[y]` row — and it is the DECISION that
 * consults the authority, not the parser. `verified` is false whenever `ctx.trust` is absent (nothing to check with).
 */
export type ParseRecordResult<K extends RecordKind> = { ok: true; record: RecordOf<K>; verified: boolean } | { ok: false; reason: ParseFailure };

type Bad = 'shape' | 'id' | 'bounds';

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** §2.1 rule 6 / review #35: a counter from a hostile writer must be a real, bounded integer — `1e300` would freeze every reader's Lamport clock. */
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= COUNTER_MAX;
const isOidOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && OID_RE.test(v));
const isBranchOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && isValidBranch(v));
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const isStrArray = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(isStr);
const isRelPaths = (v: unknown, max: number): v is string[] => isStrArray(v, max) && v.every(isValidRelPath);
const oneOf =
  <T extends string>(set: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === 'string' && (set as readonly string[]).includes(v);

const PHASES = ['starting', 'running', 'pausing', 'paused', 'blocked', 'aborting', 'ended'] as const;
const SOURCES = ['cli', 'bench', 'perf'] as const;
const LEASE_TYPES = ['intent', 'exclusive', 'command', 'lane', 'worktree', 'takeover'] as const;
const LEASE_OUTCOMES = ['committed', 'discarded', 'expired', 'ended'] as const;
const MESSAGE_TYPES = ['heads-up', 'handoff', 'note', 'request-release', 'steer', 'pause', 'resume', 'end', 'abort', 'ack', 'who'] as const;
const ACK_OUTCOMES = ['delivered', 'applied', 'refused', 'expired'] as const;
const SUBWORK_KINDS = ['sample', 'lane', 'probe', 'child'] as const;

function checkStamp(v: unknown): Bad | null {
  if (!isJsonObject(v)) return 'shape';
  if (!isCount(v['n'])) return 'shape';
  if (!isStr(v['deviceId']) || !isStr(v['runId'])) return 'shape';
  if (!DEVICE_ID_RE.test(v['deviceId'])) return 'id';
  if (!RUN_ID_RE.test(v['runId']) && !ACTOR8_RE.test(v['runId'])) return 'id';
  return null;
}

function checkId(v: unknown, re: RegExp): Bad | null {
  return isStr(v) ? (re.test(v) ? null : 'id') : 'shape';
}
function checkConsumerId(v: unknown): Bad | null {
  if (!isStr(v)) return 'shape';
  return CONSUMER_ID_RE.test(v) || RUN_ID_RE.test(v) ? null : 'id';
}
function checkIdOrNull(v: unknown, re: RegExp): Bad | null {
  return v === null ? null : checkId(v, re);
}

/** §3.2: an opaque boot identity — absent, null, or a bounded printable string (a uuid on both platforms we read). */
const BOOT_ID_MAX_CHARS = 128;
function isBootId(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.length > 0 && v.length <= BOOT_ID_MAX_CHARS && !/[\u0000-\u001f\u007f]/.test(v));
}

function checkHeartbeat(o: JsonObject): Bad | null {
  if (o['kind'] !== 'heartbeat' && o['kind'] !== 'bench') return 'shape';
  let bad = checkId(o['deviceId'], DEVICE_ID_RE) ?? checkId(o['runId'], RUN_ID_RE) ?? checkId(o['sessionId'], RUN_ID_RE) ?? checkIdOrNull(o['parentSessionId'], RUN_ID_RE) ?? checkIdOrNull(o['parentRunId'], RUN_ID_RE);
  if (bad !== null) return bad;
  for (const k of ['label', 'host', 'user', 'jevcode', 'task60', 'startedAt', 'beatAt', 'bootAt', 'mode', 'stage'] as const) if (!isStr(o[k])) return 'shape';
  // §3.2: the machine the beat was written on; `isPidAlive` may only be asked about a pid from THIS machine
  if (o['hostKey'] !== undefined && (!isStr(o['hostKey']) || !HOST_KEY_RE.test(o['hostKey']))) return 'id';
  // §3.2 / §3.4 (revision 5): the boot session. Bounded like every other opaque id leaf; absent = an older build.
  if (!isBootId(o['bootId'])) return 'shape';
  if (o['truncated'] !== undefined && !isBool(o['truncated'])) return 'shape'; // + blocker 2: the degraded-beat marker
  if (!isCount(o['pid']) || o['pid'] <= 0) return 'shape';
  if (!oneOf(SOURCES)(o['source']) || !isStrOrNull(o['title60'])) return 'shape';
  const repo = o['repo'];
  if (!isJsonObject(repo)) return 'shape';
  bad = checkId(repo['wsKey'], REPO_KEY_RE) ?? checkIdOrNull(repo['repoKey'], REPO_KEY_RE) ?? checkIdOrNull(repo['remoteKey'], REPO_KEY_RE);
  if (bad !== null) return bad;
  if (repo['superKey'] !== undefined && checkId(repo['superKey'], REPO_KEY_RE) !== null) return 'id';
  if (!isStr(repo['basename']) || !isBool(repo['dirtyAtStart']) || !isBool(repo['linkedWorktree'])) return 'shape';
  // review #36: `head` and `branch` reach `git cat-file` / `merge-base`; a leading `-` or a `:` would be parsed as an option
  if (!isOidOrNull(repo['head']) || !isBranchOrNull(repo['branch'])) return 'id';
  if (repo['worktreeSlug'] !== null && checkId(repo['worktreeSlug'], SLUG_RE) !== null) return 'id';
  if (!oneOf(PHASES)(o['phase'])) return 'shape';
  if (!isCount(o['step']) || !isCount(o['maxSteps']) || !isStrOrNull(o['action80'])) return 'shape';
  if (!isBool(o['pausing']) || !isBool(o['pauseNow']) || !isStrOrNull(o['blocked']) || !isStrOrNull(o['stopReason'])) return 'shape';
  const retrying = o['retrying'];
  if (retrying !== null && !(isJsonObject(retrying) && (retrying['side'] === 'jev' || retrying['side'] === 'generator') && isNum(retrying['attempt']))) return 'shape';
  const plan = o['plan'];
  if (!isJsonObject(plan) || !isCount(plan['done']) || !isCount(plan['remaining']) || !isCount(plan['unverified']) || !isStrArray(plan['next3'], 3)) return 'shape';
  const declared = o['declared'];
  if (declared !== null) {
    if (!isJsonObject(declared) || !isCount(declared['step']) || !oneOf(LEASE_TYPES)(declared['type']) || !isBool(declared['truncated'])) return 'shape';
    if (!isStrArray(declared['paths'], LEASE_PATHS_MAX)) return 'shape';
    if (!isRelPaths(declared['paths'], LEASE_PATHS_MAX)) return 'id';
  }
  const touched = o['touched'];
  if (touched !== null) {
    if (!isJsonObject(touched) || !isCount(touched['step']) || !isStrArray(touched['files'], LEASE_PATHS_MAX)) return 'shape';
    if (!isRelPaths(touched['files'], LEASE_PATHS_MAX)) return 'id';
  }
  if (!isStrArray(o['touchedRecent'], TOUCHED_RECENT_MAX)) return 'shape';
  if (!isRelPaths(o['touchedRecent'], TOUCHED_RECENT_MAX)) return 'id';
  if (!isStrArray(o['leases'], LEASES_IN_BEAT_MAX)) return 'shape';
  if (!o['leases'].every((l) => LEASE_ID_RE.test(l))) return 'id';
  const subwork = o['subwork'];
  if (!Array.isArray(subwork) || subwork.length > SUBWORK_MAX) return 'shape';
  for (const s of subwork) {
    if (!isJsonObject(s) || !oneOf(SUBWORK_KINDS)(s['kind']) || !isStr(s['id']) || !isStr(s['since']) || !isStr(s['stage']) || !isStr(s['detail60'])) return 'shape';
    // review #37: `laneDir` names a directory the sweep may `rm -rf`; only the exact `tmp/synth/lane<k>` shape is accepted
    if (s['laneDir'] !== undefined && (!isStr(s['laneDir']) || !LANE_DIR_RE.test(s['laneDir']))) return 'id';
  }
  if (o['bench'] !== undefined) {
    const b = o['bench'];
    if (!isJsonObject(b) || !isStr(b['benchId']) || !isNum(b['lanes']) || !isNum(b['spendUsd'])) return 'shape';
    const t = b['tasks'];
    if (!isJsonObject(t) || !isNum(t['live']) || !isNum(t['done']) || !isNum(t['total'])) return 'shape';
  }
  const spend = o['spend'];
  if (!isJsonObject(spend) || !isNum(spend['generatorUsd']) || !isNum(spend['jevUsd']) || !isNumOrNull(spend['sessionUsd']) || !isNum(spend['capUsd'])) return 'shape';
  const tokens = o['tokens'];
  if (!isJsonObject(tokens) || !isNum(tokens['used']) || !isNumOrNull(tokens['cap'])) return 'shape';
  if (!isNum(o['wallMs']) || !isNum(o['maxWallMs'])) return 'shape';
  const ctx = o['context'];
  if (!isJsonObject(ctx) || !isNum(ctx['pct']) || !isNum(ctx['files']) || !isNum(ctx['historyEntries']) || !isNumOrNull(ctx['summaryAt']) || !isNum(ctx['tokensInWindow']) || !isNum(ctx['windowBudget']) || !isNum(ctx['compactions'])) return 'shape';
  if (o['lockHeld'] !== undefined && !isBool(o['lockHeld'])) return 'shape';
  if (o['pausePoint'] !== undefined && !isJsonObject(o['pausePoint'])) return 'shape';
  if (!isCount(o['beatSeq']) || !isCount(o['ttlMs'])) return 'shape';
  // + re-check (5): a writer-chosen liveness window. `COUNTER_MAX` let a record claim 11.6 days of freshness.
  if (o['ttlMs'] <= 0 || o['ttlMs'] > RECORD_TTL_MAX_MS) return 'bounds';
  // + review blocker 3: the immutable claim the fork rule compares
  if (isJsonObject(o['claim']) && typeof o['claim']['epoch'] === 'number' && !(Number.isSafeInteger(o['claim']['epoch']) && o['claim']['epoch'] >= 1 && o['claim']['epoch'] <= MAX_CLAIM_EPOCH)) return 'bounds';
  if (!isValidClaim(o['claim'])) return 'shape';
  const claim = o['claim'];
  if (claim.deviceId !== o['deviceId'] || claim.runId !== o['runId']) return 'id';
  return checkStamp(o['stamp']);
}

function checkLease(o: JsonObject): Bad | null {
  if (o['kind'] !== 'lease') return 'shape';
  let bad = checkId(o['leaseId'], LEASE_ID_RE) ?? checkId(o['runId'], RUN_ID_RE) ?? checkId(o['sessionId'], RUN_ID_RE) ?? checkId(o['deviceId'], DEVICE_ID_RE) ?? checkId(o['repoKey'], REPO_KEY_RE) ?? checkIdOrNull(o['remoteKey'], REPO_KEY_RE) ?? checkId(o['wsKey'], REPO_KEY_RE);
  if (bad !== null) return bad;
  if (!(o['leaseId'] as string).startsWith(`${o['runId'] as string}-`)) return 'id';
  for (const k of ['label', 'reason60', 'stage', 'issuedAt', 'expiresAt', 'renewedAt'] as const) if (!isStr(o[k])) return 'shape';
  if (!oneOf(LEASE_TYPES)(o['type']) || !isBool(o['truncated']) || !isCount(o['step'])) return 'shape';
  if (!isOidOrNull(o['head']) || !isBranchOrNull(o['branch'])) return 'id'; // review #36
  if (!isStrArray(o['paths'], LEASE_PATHS_MAX)) return 'shape';
  if (!isRelPaths(o['paths'], LEASE_PATHS_MAX)) return 'id';
  if (o['command60'] !== undefined && !isStr(o['command60'])) return 'shape';
  if (o['exclusiveTree'] !== undefined && !isBool(o['exclusiveTree'])) return 'shape';
  if (o['laneDir'] !== undefined && (!isStr(o['laneDir']) || !LANE_DIR_RE.test(o['laneDir']))) return 'id'; // review #37
  if (o['slug'] !== undefined && checkId(o['slug'], SLUG_RE) !== null) return 'id';
  if (o['claim'] !== undefined && !isValidClaim(o['claim'])) return 'shape';
  if (o['type'] === 'takeover' && !isValidClaim(o['claim'])) return 'shape'; // + blocker 3: a takeover always carries its claim
  // + re-review (3)/(6): `claim.deviceId` joins the id-vs-path binding list — a takeover claiming another device's id is 'id'
  if (isJsonObject(o['claim']) && o['claim']['deviceId'] !== o['deviceId']) return 'id';
  const rel = o['released'];
  if (rel !== undefined) {
    if (!isJsonObject(rel) || !isStr(rel['at']) || !oneOf(LEASE_OUTCOMES)(rel['outcome']) || !isJsonObject(rel['changed'])) return 'shape';
    if (rel['head'] !== undefined && !isOidOrNull(rel['head'])) return 'id';
    const changed = Object.entries(rel['changed']);
    if (changed.length > LEASE_PATHS_MAX) return 'shape';
    for (const [k, v] of changed) {
      if (!isStrOrNull(v)) return 'shape';
      if (!isValidRelPath(k)) return 'id';
    }
  }
  bad = checkStamp(o['stamp']);
  return bad;
}

function checkMessage(o: JsonObject): Bad | null {
  if (o['kind'] !== 'message') return 'shape';
  let bad = checkId(o['id'], MSG_ID_RE);
  if (bad !== null) return bad;
  const from = o['from'];
  if (!isJsonObject(from)) return 'shape';
  bad = checkId(from['deviceId'], DEVICE_ID_RE) ?? checkIdOrNull(from['sessionId'], RUN_ID_RE) ?? checkIdOrNull(from['runId'], RUN_ID_RE);
  if (bad !== null) return bad;
  if (!isStr(from['label']) || !isStr(from['user'])) return 'shape';
  // §5.1 / §5.4 rule 5 (revision 5): `pid` is display and audit only (never an isPidAlive input); `bootId` DENIES the
  // no-confirm same-device path for the control types. Both are additive, so absent is legal.
  if (from['pid'] !== undefined && (!isCount(from['pid']) || from['pid'] <= 0)) return 'shape';
  if (!isBootId(from['bootId'])) return 'shape';
  if (o['hostKey'] !== undefined && (!isStr(o['hostKey']) || !HOST_KEY_RE.test(o['hostKey']))) return 'id'; // §3.2
  if (!isStr(o['to'])) return 'shape';
  if (!isValidTarget(o['to'])) return 'id';
  if (!oneOf(MESSAGE_TYPES)(o['type']) || !isStr(o['text']) || !isStr(o['t']) || !isStr(o['expiresAt'])) return 'shape';
  if (o['text'].length > DIRECTIVE_MAX_CHARS) return 'shape';
  if (o['by'] !== undefined && o['by'] !== 'human' && o['by'] !== 'engine') return 'shape';
  const refs = o['refs'];
  if (!isJsonObject(refs)) return 'shape';
  if (refs['target'] !== undefined && !isStr(refs['target'])) return 'shape';
  if (refs['commit'] !== undefined && !isOidOrNull(refs['commit'])) return 'id'; // review #36
  if (refs['branch'] !== undefined && !isBranchOrNull(refs['branch'])) return 'id';
  if (refs['step'] !== undefined && !isCount(refs['step'])) return 'shape';
  if (refs['files'] !== undefined) {
    if (!isStrArray(refs['files'], MESSAGE_FILES_MAX)) return 'shape';
    if (!isRelPaths(refs['files'], MESSAGE_FILES_MAX)) return 'id';
  }
  if (refs['leaseId'] !== undefined && checkId(refs['leaseId'], LEASE_ID_RE) !== null) return 'id';
  if (refs['runId'] !== undefined && checkId(refs['runId'], RUN_ID_RE) !== null) return 'id';
  if (refs['msgId'] !== undefined && checkId(refs['msgId'], MSG_ID_RE) !== null) return 'id';
  return checkStamp(o['stamp']);
}

function checkAck(o: JsonObject): Bad | null {
  if (o['kind'] !== 'ack') return 'shape';
  // + review major 8: `by` is a CONSUMER id (`${sessionId ?? 'tui'}-${actor8}`); the bare run-id form of an older build still parses
  const bad = checkId(o['msgId'], MSG_ID_RE) ?? checkConsumerId(o['by']) ?? checkId(o['deviceId'], DEVICE_ID_RE);
  if (bad !== null) return bad;
  if (!isStr(o['at']) || !oneOf(ACK_OUTCOMES)(o['outcome'])) return 'shape';
  if (o['detail60'] !== undefined && !isStr(o['detail60'])) return 'shape';
  return checkStamp(o['stamp']);
}

function checkDevice(o: JsonObject): Bad | null {
  const bad = checkId(o['deviceId'], DEVICE_ID_RE);
  if (bad !== null) return bad;
  for (const k of ['label', 'host', 'user', 'jevcode', 'createdAt'] as const) if (!isStr(o[k])) return 'shape';
  if (o['syncMode'] !== 'off' && o['syncMode'] !== 'shared-dir' && o['syncMode'] !== 'git') return 'shape';
  return null;
}


/**
 * + re-check (lower 2): the top-level keys each kind may carry. `parseRecord` type-checked every field it KNEW and
 * ignored the rest, so a record could carry arbitrary extra JSON — which then rode into memory, into
 * `stableStringify`'s canonical text and therefore into the checksum and the HMAC a paired device signs. Nothing
 * downstream reads an unknown key and no prototype pollution was reachable (`parseJson` already drops `__proto__`),
 * but a record is a closed shape and a reader that says so is the cheap half of the rule. An unknown key is `'shape'`.
 */
const RECORD_KEYS: Readonly<Record<RecordKind, ReadonlySet<string>>> = {
  heartbeat: new Set(['v', 'kind', 'deviceId', 'label', 'host', 'user', 'pid', 'bootAt', 'bootId', 'hostKey', 'jevcode', 'runId', 'sessionId', 'parentSessionId', 'parentRunId', 'source', 'title60', 'task60', 'repo', 'mode', 'phase', 'step', 'maxSteps', 'stage', 'action80', 'pausing', 'pauseNow', 'blocked', 'retrying', 'stopReason', 'plan', 'declared', 'touched', 'touchedRecent', 'leases', 'subwork', 'bench', 'spend', 'tokens', 'wallMs', 'maxWallMs', 'context', 'pausePoint', 'lockHeld', 'startedAt', 'beatAt', 'beatSeq', 'ttlMs', 'stamp', 'claim', 'truncated', 'keyId', 'checksum', 'hmac']),
  lease: new Set(['v', 'kind', 'leaseId', 'runId', 'sessionId', 'deviceId', 'hostKey', 'label', 'repoKey', 'remoteKey', 'wsKey', 'branch', 'head', 'type', 'paths', 'truncated', 'command60', 'exclusiveTree', 'laneDir', 'slug', 'reason60', 'step', 'stage', 'stamp', 'issuedAt', 'expiresAt', 'renewedAt', 'released', 'claim', 'keyId', 'checksum', 'hmac']),
  message: new Set(['v', 'kind', 'id', 'from', 'hostKey', 'to', 'type', 'text', 'refs', 'by', 't', 'stamp', 'expiresAt', 'keyId', 'checksum', 'hmac']),
  ack: new Set(['v', 'kind', 'msgId', 'by', 'sessionId', 'deviceId', 'hostKey', 'at', 'outcome', 'detail60', 'stamp', 'keyId', 'checksum', 'hmac']),
  device: new Set(['v', 'kind', 'deviceId', 'hostKey', 'label', 'host', 'user', 'jevcode', 'createdAt', 'syncMode', 'keyId', 'checksum', 'hmac']),
};

/** Every top-level key of `o` is one this kind declares (`undefined` members are dropped before the write). */
function keysAllowed(kind: RecordKind, o: JsonObject): boolean {
  const allowed = RECORD_KEYS[kind];
  for (const k of Object.keys(o)) if (!allowed.has(k)) return false;
  return true;
}

const CHECKERS: Record<RecordKind, (o: JsonObject) => Bad | null> = { heartbeat: checkHeartbeat, lease: checkLease, message: checkMessage, ack: checkAck, device: checkDevice };

/**
 * + review blocker 6: a record must agree with the PATH it was read from. Nothing in a record binds its `deviceId` to the
 * `<deviceId>` directory it sits in, so without this a file planted under my own device id reads as same-device and its
 * `pid` is handed to `isPidAlive`, its `pause` auto-applies and its lease reads as mine.
 */
export interface ParseContext {
  /** the `<deviceId>` path component the file was read from */
  deviceId: string;
  /** for a message: the `<target>` directory component */
  target?: string;
  /** §3.1 / §4.3: for a lease, the `<keyDir>` directory component — `keyDir(repoKey)` OR `keyDir(wsKey)` must equal it */
  keyDir?: string;
  /** §5.1 / + re-check (lower 3): for an ack, the `<msgId>` directory component it was read from */
  msgId?: string;
  /** §9.3 (revision 5): for a `kind:'claims'` projection, the `<runId>` directory component it was read from */
  runId?: string;
  /**
   * §10.3 (revision 4): the verification key for the PATH's device, looked up by the reader. The record's own `keyId`
   * is display text and is never how a verifier finds a key. Absent → `verified: false`, which is a fact, not a failure.
   */
  trust?: (pathDeviceId: string) => string | null | undefined;
}

/** Every identity field a record carries must equal the path component it was read from. */
function locationMatches(kind: RecordKind, o: JsonObject, ctx: ParseContext): boolean {
  const stampDevice = isJsonObject(o['stamp']) ? o['stamp']['deviceId'] : undefined;
  switch (kind) {
    case 'heartbeat': {
      const claim = o['claim'];
      const claimDevice = isJsonObject(claim) ? claim['deviceId'] : undefined;
      return o['deviceId'] === ctx.deviceId && stampDevice === ctx.deviceId && claimDevice === ctx.deviceId;
    }
    case 'lease': {
      const claim = o['claim'];
      const claimDevice = isJsonObject(claim) ? claim['deviceId'] : ctx.deviceId; // + re-review (3): claim.deviceId is bound too
      if (o['deviceId'] !== ctx.deviceId || stampDevice !== ctx.deviceId || claimDevice !== ctx.deviceId) return false;
      // §4.3 (revision 4): the lease's own `keyDir(repoKey ?? wsKey)` must equal the directory it sits in, or a peer
      // could park a lease for MY repo under a key nobody folds — invisible to the fence that is supposed to see it.
      if (ctx.keyDir !== undefined) {
        const repoKey = o['repoKey'];
        return typeof repoKey === 'string' && keyDir(repoKey) === ctx.keyDir;
      }
      return true;
    }
    case 'message': {
      const from = o['from'];
      if (!isJsonObject(from) || from['deviceId'] !== ctx.deviceId || stampDevice !== ctx.deviceId) return false;
      return ctx.target === undefined || o['to'] === ctx.target;
    }
    case 'ack':
      // + re-check (lower 3): the `<msgId>` DIRECTORY is part of an ack's identity too. Without it a record acking
      // message X could be planted under `acks/<dev>/<Y>/…`, where `awaitAck(Y)` would read it as a receipt for Y.
      if (ctx.msgId !== undefined && o['msgId'] !== ctx.msgId) return false;
      return o['deviceId'] === ctx.deviceId && stampDevice === ctx.deviceId;
    case 'device':
      return o['deviceId'] === ctx.deviceId;
  }
}

/**
 * §12.0.4: `size | json | version | shape | id | checksum` — a failed parse is `fold.skipped++`, never an error. Ids are
 * regex-checked, paths relative / NFC / no `..`, counters safe integers, sizes refused per KIND (never the 64 KiB read
 * bound); the checksum is verified last so no hash is computed over junk. With `ctx` the record's own device / target must
 * match the path it was read from (review blocker 6) — a mismatch is `'id'`.
 */
export function parseRecord<K extends RecordKind>(text: string, kind: K, ctx?: ParseContext): ParseRecordResult<K> {
  if (byteLength(text) > RECORD_MAX_BYTES[kind]) return { ok: false, reason: 'size' };
  const parsed = parseJson(text);
  if (!parsed.ok || !isJsonObject(parsed.value)) return { ok: false, reason: 'json' };
  const o = parsed.value;
  if (o['v'] !== 1) return { ok: false, reason: 'version' };
  if (typeof o['checksum'] !== 'string') return { ok: false, reason: 'shape' };
  if (!keysAllowed(kind, o)) return { ok: false, reason: 'shape' }; // + re-check (lower 2): a record is a CLOSED shape
  const bad = CHECKERS[kind](o);
  if (bad !== null) return { ok: false, reason: bad };
  if (ctx !== undefined && !locationMatches(kind, o, ctx)) return { ok: false, reason: 'id' };
  if (o['checksum'] !== checksumOf(o)) return { ok: false, reason: 'checksum' };
  // §10.3: reported, never a gate — the key is found by the PATH's deviceId, never by a `keyId` the record carries
  const verified = ctx?.trust === undefined ? false : hmacValid(o, ctx.trust(ctx.deviceId), { deviceId: ctx.deviceId, hostKey: typeof o['hostKey'] === 'string' ? o['hostKey'] : undefined });
  return { ok: true, record: o as unknown as RecordOf<K>, verified };
}

/** The kind a parsed record claims (a `device.json` has no `kind`). */
export function recordKindOf(r: AnyRecord): RecordKind {
  if (!('kind' in r)) return 'device';
  switch (r.kind) {
    case 'heartbeat':
    case 'bench':
      return 'heartbeat';
    case 'lease':
      return 'lease';
    case 'message':
      return 'message';
    case 'ack':
      return 'ack';
  }
}

export function isHeartbeat(r: AnyRecord): r is Heartbeat {
  return 'kind' in r && (r.kind === 'heartbeat' || r.kind === 'bench');
}
export function isLease(r: AnyRecord): r is Lease {
  return 'kind' in r && r.kind === 'lease';
}
export function isMessage(r: AnyRecord): r is Message {
  return 'kind' in r && r.kind === 'message';
}
export function isAck(r: AnyRecord): r is Ack {
  return 'kind' in r && r.kind === 'ack';
}
export function isDeviceRecord(r: AnyRecord): r is DeviceRecord {
  return !('kind' in r);
}

// ── liveness (§3.4) ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface Now {
  wallMs: number;
  monoMs: number;
}

function parseIso(s: string): number {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : Number.NaN;
}

/**
 * §3.4 (design revision 5).
 *
 * Same device — the record was read from THIS process's own local subtree AND its `hostKey` is mine AND its `bootId` is
 * mine (or either side does not know one): `phase !== 'ended'` ∧ `isPidAlive(pid)`. Beat age is a display flag (`hung`)
 * only, so a live process on a pane, in a debugger or after a wall-clock jump is never read as crashed and its leases
 * are never ignored while its pid lives.
 *
 * The wall-arithmetic rule of revision 2 (`startedAt ≥ bootAt`) is WITHDRAWN: a forward clock step larger than the
 * process's age-since-boot (NTP after sleep, a VM snapshot restore, a manual set) made a LIVE process read
 * `stale-reused-pid`, after which `takeRunLock` replaced its `run.lock` and a second engine opened the same run dir —
 * the one-writer invariant of `state.json`, broken by a clock.
 *
 * `duplicate-identity` (§3.2, rewritten in revision 5 around beat FRESHNESS, because `isPidAlive` cannot separate two
 * clones: they run the same workload, allocate similar pids, and the foreign pid is alive in MY pid table). A record in
 * my own local subtree is FOREIGN when (i) its `hostKey` is not mine; or (ii) its `bootId` is not mine AND its beat is
 * fresh; or (iii) its `bootId` is not mine and `isPidAlive(pid)` is false. Clause (ii) is the discriminator a hash
 * cannot provide: *a previous boot of my own machine stops renewing; a live clone does not.* Hence `stale-reused-pid`
 * **only** when the `bootId` differs and no fresh beat exists — a differing `bootId` with a fresh beat is not a reused
 * pid at all, it is a clone, it folds as foreign, and it is live.
 *
 * A record with NO `bootId` (an older build) whose pid answers `kill(pid, 0)` stays live and is never auto-replaced.
 *
 * Other device: `phase !== 'ended'` ∧ `monoNow − arrivalMono < ttl + slack` from the RECEIVER's monotonic clock; wall
 * `beatAt` only feeds `skewed`. `arrival === null` (a listed file that could not be read this cycle) → `unknown`.
 *
 * + review blocker 6: "same device" is `origin.self` — never `record.deviceId === env.deviceId`, which a file planted
 * under my device id in a shared mirror satisfies. `origin` omitted defaults to FOREIGN: conservative, so a bare
 * in-memory record is judged by arrival time, never by a pid probe.
 */
export function isLive(record: Heartbeat, now: Now, arrival: { arrivalMono: number } | null, env: LivenessEnv, origin: RecordOrigin = { self: false, source: null, authenticated: false }): LivenessVerdict {
  const beatAt = parseIso(record.beatAt);
  const skewMs = Number.isFinite(beatAt) && beatAt - now.wallMs > SKEW_MS ? beatAt - now.wallMs : null;
  const skewed = skewMs !== null;
  const ttlMs = honouredTtlMs(record.ttlMs); // + re-check (5): never the raw, writer-controlled field
  const foreignRow = (): LivenessVerdict => {
    if (arrival === null) return { liveness: 'unknown', hung: false, skewed, skewMs };
    if (record.phase === 'ended') return { liveness: 'stale', hung: false, skewed, skewMs };
    const live = now.monoMs - arrival.arrivalMono < ttlMs + (env.syncSlackMs ?? SYNC_SLACK_SHARED_MS);
    return { liveness: live ? 'live' : 'stale', hung: false, skewed, skewMs };
  };
  // (i) `hostKey` DENIES same-device; it can never grant it (the local read location is still required). Such a record
  // is judged by ARRIVAL, never by a pid probe against a foreign pid table.
  if (origin.self && !sameHost(record.hostKey, env.hostKey)) return foreignRow();
  if (origin.self) {
    if (!sameBoot(record.bootId, env.bootId)) {
      if (record.phase === 'ended') return { liveness: 'stale', hung: false, skewed, skewMs };
      // (ii) a FRESH beat is a live clone, not a reboot: fold it as foreign and let arrival decide.
      if (arrival !== null && now.monoMs - arrival.arrivalMono <= ttlMs) return foreignRow();
      // (iii) a dead pid is simply gone; a LIVE pid with no fresh beat is the reused-pid case, and the only one.
      return { liveness: env.isPidAlive(record.pid) ? 'stale-reused-pid' : 'stale', hung: false, skewed, skewMs };
    }
    if (record.phase === 'ended') return { liveness: 'stale', hung: false, skewed, skewMs };
    if (!env.isPidAlive(record.pid)) return { liveness: 'stale', hung: false, skewed, skewMs };
    const hung = Number.isFinite(beatAt) && now.wallMs - beatAt > ttlMs;
    return { liveness: 'live', hung, skewed, skewMs };
  }
  return foreignRow();
}

/**
 * §3.2 / §3.4 (design revision 5): unknown on either side stays permissive — an older build wrote no `bootId`, and such
 * a record with a live pid is never auto-replaced (§3.4). Only a KNOWN difference denies same-device.
 */
export function sameBoot(a: string | null | undefined, b: string | null | undefined): boolean {
  return a === undefined || a === null || b === undefined || b === null || a === b;
}

/** §3.2 / §5.4 rule 4: unknown on either side stays permissive; only a KNOWN difference refuses same-device. */
export function sameHost(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

// ── overlap (§4.3 step 2, §11 rows 8 / 23 / 34) ───────────────────────────────────────────────────────────────────────

export interface OverlapOptions {
  /** the workspace volume folds case (probed per workspace, §3.2) */
  caseFold?: boolean;
}

function normPath(p: string, caseFold: boolean): string {
  let s = p.normalize('NFC');
  while (s.startsWith('./')) s = s.slice(2);
  return caseFold ? s.toLowerCase() : s;
}

/** `a` and `b` name the same file, or one is a subtree (`…/`) containing the other. */
export function pathsOverlap(a: string, b: string, o: OverlapOptions = {}): boolean {
  const fold = o.caseFold === true;
  const x = normPath(a, fold);
  const y = normPath(b, fold);
  if (x === y) return true;
  if (y.endsWith('/') && x.startsWith(y)) return true;
  if (x.endsWith('/') && y.startsWith(x)) return true;
  return false;
}

/** Every (mine, theirs) pair that overlaps — `O(|mine| × |theirs|)`; prefixes are conservative (more conflicts, never fewer). */
export function overlap(mine: readonly string[], theirs: readonly string[], o: OverlapOptions = {}): { path: string; with: string }[] {
  const out: { path: string; with: string }[] = [];
  for (const m of mine) for (const t of theirs) if (pathsOverlap(m, t, o)) out.push({ path: m, with: t });
  return out;
}

// ── run.lock replacement (§3.4, design revision 5) ────────────────────────────────────────────────────────────────────

/** The `run.lock` fields this verdict reads (`src/session/lock.ts` owns the file; `parseRunLock` already reads pid/host). */
export interface RunLockFacts {
  pid: number;
  host?: string;
  deviceId?: string;
  /** additive (§3.4): the boot session that took the lock; absent = an older build wrote it */
  bootId?: string | null;
}

/** What `foreignLive(fold, self, runId)` returned — a FOREIGN live heartbeat for this run, or null. */
export interface PeerLiveFacts {
  deviceId: string;
  label: string;
  step: number;
  beatAgeMs: number;
}

export type LockReplace =
  | { replace: true; reason: 'no-lock' | 'dead-pid' | 'other-boot' }
  | { replace: false; reason: 'peer-live' | 'boot-unknown' | 'held'; detail60: string };

/**
 * §3.2 / §3.4 (design revision 5), pure: may `takeRunLock` replace this `run.lock`?
 *
 * **A fresh heartbeat is never overridden.** `peerLive !== null` refuses whatever the pid verdict says — revision 4
 * protected only a *missing* `bootId`, so the moment a clone's pid happened to be alive locally the verdict was
 * `stale-reused-pid`, the LIVE `run.lock` was replaced and two engines co-wrote one `state.json`. Only
 * `peerLive === null` lets anything be replaced, and then:
 *   - no lock at all → replace;
 *   - a `bootId` that is known and differs from mine → replace (a previous boot of this machine; the pid, if alive, is
 *     a reused one);
 *   - a lock with NO `bootId` whose pid answers `kill(pid, 0)` → refuse `'boot-unknown'` and never guess (§3.4:
 *     `sessions who` prints `pid N alive, boot unknown — sessions unlock <id> if that process is gone`);
 *   - a dead pid → replace;
 *   - otherwise the lock is genuinely held by a live process of this boot → refuse.
 *
 * `--force` is the caller's own bypass and is deliberately not modelled here: this function answers the automatic
 * question only.
 */
export function lockReplaceVerdict(o: { lock: RunLockFacts | null; peerLive: PeerLiveFacts | null; self?: { bootId?: string | null; isPidAlive?: (pid: number) => boolean } }): LockReplace {
  if (o.peerLive !== null) {
    const p = o.peerLive;
    const ago = Math.max(0, Math.round(p.beatAgeMs / 1000));
    return { replace: false, reason: 'peer-live', detail60: clip(`live on ${p.label} (step ${p.step}, last beat ${ago}s ago)`, 60) };
  }
  if (o.lock === null) return { replace: true, reason: 'no-lock' };
  const alive = (o.self?.isPidAlive ?? (() => true))(o.lock.pid);
  const mine = o.self?.bootId;
  if (o.lock.bootId !== undefined && o.lock.bootId !== null && mine !== undefined && mine !== null && o.lock.bootId !== mine) return { replace: true, reason: 'other-boot' };
  if (!alive) return { replace: true, reason: 'dead-pid' };
  if (o.lock.bootId === undefined || o.lock.bootId === null) return { replace: false, reason: 'boot-unknown', detail60: clip(`pid ${o.lock.pid} alive, boot unknown`, 60) };
  return { replace: false, reason: 'held', detail60: clip(`pid ${o.lock.pid} is running this run`, 60) };
}
