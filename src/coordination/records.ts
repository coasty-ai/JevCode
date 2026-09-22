/**
 * Records (§3.3 heartbeat, §4.3 lease, §5.1 message / ack, §3.1 device): parse as untrusted input (§2.1 rule 6), checksum,
 * redact, the liveness rule of §3.4 and the path overlap of §4.3 step 2. Pure functions; no I/O.
 */
import { isJsonObject, parseJson } from '../core/json.js';
import { byteLength } from '../core/text.js';
import type { JsonObject } from '../core/types.js';
import { DIRECTIVE_MAX_CHARS } from '../core/types.js';
import { checksumOf, withChecksum } from './checksum.js';
import { isValidClaim } from './claims.js';
import { ACTOR8_RE, DEVICE_ID_RE, LANE_DIR_RE, LEASE_ID_RE, LEASE_PATHS_MAX, MSG_ID_RE, OID_RE, REPO_KEY_RE, RUN_ID_RE, SLUG_RE, TOUCHED_RECENT_MAX, isValidBranch, isValidRelPath, isValidTarget } from './ids.js';
import type { Ack, AnyRecord, DeviceRecord, Heartbeat, Lease, LivenessEnv, LivenessVerdict, Message, RecordKind, RecordOf, RecordOrigin, Stamp } from './types.js';

export { checksumOf, withChecksum } from './checksum.js';

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
/** §3.4: a stale run keeps its facts in the fold this long as `gone` */
export const GONE_KEEP_MS = 600_000;
/** §4.3 step 7: lease ttl; renewed every heartbeat while the owner beats */
export const LEASE_TTL_MS = 600_000;
/** §5.1: message expiry — 7 d, control types 10 min */
export const MESSAGE_TTL_MS = 7 * 86_400_000;
export const CONTROL_MESSAGE_TTL_MS = 600_000;
export const CONTROL_MESSAGE_TYPES: ReadonlySet<string> = new Set(['pause', 'abort', 'steer', 'resume', 'end']);
export const SUBWORK_MAX = 16;
/** review #35: the bound every integer field of a record must stay inside (a `stamp.n` of 2^60 poisons a Lamport clock for good) */
export const COUNTER_MAX = 1_000_000_000;
/** review #35: an observed Lamport `n` further than this above our own is a hostile value and is not adopted */
export const STAMP_ADOPT_MAX_DELTA = 1_000_000_000;
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
  return Number.isSafeInteger(observed) && observed >= 0 && observed <= COUNTER_MAX && observed - own < STAMP_ADOPT_MAX_DELTA;
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

export type ParseFailure = 'size' | 'json' | 'shape' | 'version' | 'id' | 'checksum';
export type ParseRecordResult<K extends RecordKind> = { ok: true; record: RecordOf<K> } | { ok: false; reason: ParseFailure };

type Bad = 'shape' | 'id';

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
function checkIdOrNull(v: unknown, re: RegExp): Bad | null {
  return v === null ? null : checkId(v, re);
}

function checkHeartbeat(o: JsonObject): Bad | null {
  if (o['kind'] !== 'heartbeat' && o['kind'] !== 'bench') return 'shape';
  let bad = checkId(o['deviceId'], DEVICE_ID_RE) ?? checkId(o['runId'], RUN_ID_RE) ?? checkId(o['sessionId'], RUN_ID_RE) ?? checkIdOrNull(o['parentSessionId'], RUN_ID_RE) ?? checkIdOrNull(o['parentRunId'], RUN_ID_RE);
  if (bad !== null) return bad;
  for (const k of ['label', 'host', 'user', 'jevcode', 'task60', 'startedAt', 'beatAt', 'bootAt', 'mode', 'stage'] as const) if (!isStr(o[k])) return 'shape';
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
  // + review blocker 3: the immutable claim the fork rule compares
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
  const bad = checkId(o['msgId'], MSG_ID_RE) ?? checkId(o['by'], RUN_ID_RE) ?? checkId(o['deviceId'], DEVICE_ID_RE);
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
    case 'lease':
      return o['deviceId'] === ctx.deviceId && stampDevice === ctx.deviceId;
    case 'message': {
      const from = o['from'];
      if (!isJsonObject(from) || from['deviceId'] !== ctx.deviceId || stampDevice !== ctx.deviceId) return false;
      return ctx.target === undefined || o['to'] === ctx.target;
    }
    case 'ack':
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
  const bad = CHECKERS[kind](o);
  if (bad !== null) return { ok: false, reason: bad };
  if (ctx !== undefined && !locationMatches(kind, o, ctx)) return { ok: false, reason: 'id' };
  if (o['checksum'] !== checksumOf(o)) return { ok: false, reason: 'checksum' };
  return { ok: true, record: o as unknown as RecordOf<K> };
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
 * Same device: `phase !== 'ended'` ∧ `isPidAlive(pid)` ∧ `startedAt ≥ bootAt` — beat age is a display flag (`hung`) only.
 * Other device: `phase !== 'ended'` ∧ `monoNow − arrivalMono < ttl + slack` from the RECEIVER's monotonic clock; wall `beatAt`
 * only feeds `skewed`. `arrival === null` (a listed file that could not be read this cycle) → `unknown`.
 *
 * + review blocker 6: "same device" is `origin.self` — the file was read from THIS process's own local subtree — never
 * `record.deviceId === env.deviceId`, which a file planted under my device id in a shared mirror satisfies (and would then
 * hand an attacker-chosen `pid` to `isPidAlive`). `origin` omitted defaults to FOREIGN: conservative, so a bare in-memory
 * record is judged by arrival time, never by a pid probe.
 */
export function isLive(record: Heartbeat, now: Now, arrival: { arrivalMono: number } | null, env: LivenessEnv, origin: RecordOrigin = { self: false, source: null, authenticated: false }): LivenessVerdict {
  const beatAt = parseIso(record.beatAt);
  const skewMs = Number.isFinite(beatAt) && beatAt - now.wallMs > SKEW_MS ? beatAt - now.wallMs : null;
  const skewed = skewMs !== null;
  if (origin.self) {
    if (record.phase === 'ended') return { liveness: 'stale', hung: false, skewed, skewMs };
    const started = parseIso(record.startedAt);
    const boot = parseIso(env.bootAt);
    if (Number.isFinite(started) && Number.isFinite(boot) && started < boot) return { liveness: 'stale-reused-pid', hung: false, skewed, skewMs };
    if (!env.isPidAlive(record.pid)) return { liveness: 'stale', hung: false, skewed, skewMs };
    const hung = Number.isFinite(beatAt) && now.wallMs - beatAt > record.ttlMs;
    return { liveness: 'live', hung, skewed, skewMs };
  }
  if (arrival === null) return { liveness: 'unknown', hung: false, skewed, skewMs };
  if (record.phase === 'ended') return { liveness: 'stale', hung: false, skewed, skewMs };
  const slack = env.syncSlackMs ?? SYNC_SLACK_SHARED_MS;
  const live = now.monoMs - arrival.arrivalMono < record.ttlMs + slack;
  return { liveness: live ? 'live' : 'stale', hung: false, skewed, skewMs };
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
