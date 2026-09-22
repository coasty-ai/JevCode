/**
 * Messaging (§5.1 record, §5.3 target grammar, §12.0.4 "Message primitives", §10.3 / §11 row 50 permission boundary).
 * `send` writes `inbox/<myDevice>/<target>/<t>-<seq>.json` (≤ 2 KiB after redaction or refused); `inbox` is pure over the
 * fold; `ack` writes the consuming SESSION's own ack file and appends the id to `seen/<sessionId>.json` (≤ 2,000, one
 * writer); `awaitAck` resolves through `subscribe`, never a busy loop; `resolveTarget` implements the grammar.
 * `classifyIncoming` is the boundary: a message can never widen a receiver's rights.
 */
import { join } from 'node:path';
import { isJsonObject, parseJson } from '../core/json.js';
import { DIRECTIVE_MAX_CHARS } from '../core/types.js';
import { ConfigError } from '../errors.js';
import { listSessions, sessionTargets } from './fold.js';
import { DIR_MODE, FILE_MODE } from './fs.js';
import { DEVICE_ID_RE, MSG_ID_RE, isValidRelPath, isValidTarget } from './ids.js';
import { asHandle, type LedgerHandle } from './ledger.js';
import { CONTROL_MESSAGE_TTL_MS, CONTROL_MESSAGE_TYPES, MESSAGE_FILES_MAX, MESSAGE_TTL_MS, READ_MAX_BYTES, compareStamp, finalizeRecord, fitsRecordSize, oneLine } from './records.js';
import type { Ack, AckOutcome, Authority, Fold, Ledger, Message, MessageType, RecordOrigin, SelfIdentity, SessionActivity } from './types.js';

/** §5.1: a device sending more than this per minute mutes itself for 10 min with one notice */
export const MUTE_THRESHOLD_PER_MIN = 60;
export const MUTE_MS = 600_000;
export const SEEN_MAX = 2_000;
export const AWAIT_ACK_MS = 5_000;

interface MailboxState {
  sentAt: number[];
  mutedUntil: number | null;
  seen: Set<string> | null;
  seenLoaded: Promise<Set<string>> | null;
}

/**
 * + review #13: the consumer of a message is a PROCESS, not a session. A TUI has no `sessionId` before its first run (and a
 * `sessions` twin never has one), and two processes can hold one `sessionId` (`jevcode -c` twice on a paused session), so
 * `acks/<dev>/<msgId>/<sessionId>.json` and `seen/<sessionId>.json` would have two writers. `consumerId` is
 * `<sessionId ?? 'tui'>-<actor8>` with `actor8` minted per process — run-id-shaped where a session exists, so the ack file
 * name stays parseable, and always unique per writer.
 */
export function consumerIdOf(self: Pick<SelfIdentity, 'sessionId'>, actor8: string): string {
  return self.sessionId ?? `tui-${actor8}`;
}
const states = new WeakMap<LedgerHandle, MailboxState>();
function stateOf(h: LedgerHandle): MailboxState {
  let s = states.get(h);
  if (s === undefined) {
    s = { sentAt: [], mutedUntil: null, seen: null, seenLoaded: null };
    states.set(h, s);
  }
  return s;
}

// ── send ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SendInput {
  to: string;
  type: MessageType;
  text: string;
  refs?: Message['refs'];
  by?: 'human' | 'engine';
}

function cleanRefs(refs: Message['refs'] | undefined): Message['refs'] {
  if (refs === undefined) return {};
  const out: Message['refs'] = {};
  if (refs.commit !== undefined) out.commit = refs.commit;
  if (refs.branch !== undefined) out.branch = refs.branch;
  if (refs.files !== undefined) out.files = refs.files.map((f) => f.normalize('NFC')).filter(isValidRelPath).slice(0, MESSAGE_FILES_MAX);
  if (refs.leaseId !== undefined) out.leaseId = refs.leaseId;
  if (refs.runId !== undefined) out.runId = refs.runId;
  if (refs.step !== undefined) out.step = refs.step;
  if (refs.msgId !== undefined) out.msgId = refs.msgId;
  if (refs.target !== undefined) out.target = refs.target;
  return out;
}

/**
 * ≤ 2 KiB after redaction or `ConfigError('message too large')` — refused, never truncated; > 60/min → the sender mutes
 * itself 10 min (`ConfigError` naming the mute). The message id is `<deviceId>-<actor8>-<seq>` with `seq` = the stamp's `n`,
 * so a resumed run (same actor8) never re-mints an id its earlier process published.
 */
export async function send(ledger: Ledger, m: SendInput): Promise<{ id: string; path: string }> {
  const h = asHandle(ledger);
  const st = stateOf(h);
  const wall = h.now();
  if (!isValidTarget(m.to)) throw new ConfigError(`tell: '${m.to}' is not a session id, @<repoKey> or @all`, { setting: 'coordination' });
  if (st.mutedUntil !== null && wall < st.mutedUntil) throw new ConfigError(`coordination: sender muted for ${Math.ceil((st.mutedUntil - wall) / 1000)} s (more than ${MUTE_THRESHOLD_PER_MIN} messages in a minute)`, { setting: 'coordination' });
  st.sentAt = st.sentAt.filter((t) => wall - t < 60_000);
  if (st.sentAt.length >= MUTE_THRESHOLD_PER_MIN) {
    st.mutedUntil = wall + MUTE_MS;
    throw new ConfigError(`coordination: more than ${MUTE_THRESHOLD_PER_MIN} messages in a minute — muted for 10 min`, { setting: 'coordination' });
  }
  const text = oneLine(h.redact(m.text));
  if (text.length > DIRECTIVE_MAX_CHARS) throw new ConfigError(`message too large (${text.length} > ${DIRECTIVE_MAX_CHARS} chars)`, { setting: 'coordination' });
  const stamp = h.stamps.issue();
  const id = `${h.self.deviceId}-${h.actor8}-${stamp.n}`;
  const ttl = CONTROL_MESSAGE_TYPES.has(m.type) ? CONTROL_MESSAGE_TTL_MS : MESSAGE_TTL_MS;
  const record: Message = finalizeRecord(
    {
      v: 1,
      kind: 'message',
      id,
      from: { deviceId: h.self.deviceId, label: h.self.label, sessionId: h.self.sessionId, runId: h.self.runId, user: h.self.user },
      to: m.to,
      type: m.type,
      text,
      refs: cleanRefs(m.refs),
      ...(m.by !== undefined ? { by: m.by } : {}),
      t: new Date(wall).toISOString(),
      stamp,
      expiresAt: new Date(wall + ttl).toISOString(),
      checksum: '',
    },
    h.redact,
  );
  const signed = h.sign(record);
  if (!fitsRecordSize('message', signed)) throw new ConfigError('message too large (record exceeds 2 KiB)', { setting: 'coordination' });
  const rel = join(m.to, `${wall}-${stamp.n}.json`);
  st.sentAt.push(wall);
  h.trackAck(id);
  await h.writeOwn('inbox', rel, signed, { fsync: true });
  return { id, path: join(h.paths.deviceDir('inbox', h.self.deviceId), rel) };
}

// ── inbox (pure) ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** pure: union over my targets minus expired, minus `seen`, minus my own; stamp order */
export function inbox(fold: Fold, self: SelfIdentity, seen: ReadonlySet<string>): Message[] {
  const targets = sessionTargets(self);
  const out: Message[] = [];
  for (const m of fold.inbox) {
    if (!targets.has(m.to)) continue;
    if (seen.has(m.id)) continue;
    const exp = Date.parse(m.expiresAt);
    if (Number.isFinite(exp) && exp <= fold.at.wallMs) continue;
    if (self.sessionId !== null && m.from.sessionId === self.sessionId) continue;
    if (self.runId !== null && m.from.runId === self.runId) continue;
    out.push(m);
  }
  return out.sort((a, b) => compareStamp(a.stamp, b.stamp));
}

// ── seen set (`coordination/seen/<sessionId>.json`) ───────────────────────────────────────────────────────────────────

async function readSeen(h: LedgerHandle, consumerId: string): Promise<Set<string>> {
  try {
    const r = await h.fs.readBounded(h.paths.seenFile(consumerId), READ_MAX_BYTES);
    if (r.overflow) return new Set();
    const parsed = parseJson(r.text);
    if (!parsed.ok || !isJsonObject(parsed.value) || parsed.value['v'] !== 1 || !Array.isArray(parsed.value['ids'])) return new Set();
    return new Set(parsed.value['ids'].filter((x): x is string => typeof x === 'string' && MSG_ID_RE.test(x)).slice(-SEEN_MAX));
  } catch {
    return new Set();
  }
}

/**
 * The consumer's dedupe set, loaded once per ledger (survives across the runs of one TUI session). A sessionless TUI keeps
 * its own `inbox/seen/tui-<actor8>.json`, so a restart does not re-toast every broadcast of the last 7 days (review #13).
 */
export function loadSeen(ledger: Ledger): Promise<ReadonlySet<string>> {
  const h = asHandle(ledger);
  const st = stateOf(h);
  if (st.seen !== null) return Promise.resolve(st.seen);
  st.seenLoaded ??= readSeen(h, consumerIdOf(h.self, h.actor8)).then((s) => {
    st.seen = s;
    return s;
  });
  return st.seenLoaded;
}

async function markSeen(h: LedgerHandle, id: string): Promise<void> {
  const seen = new Set(await loadSeen(h));
  seen.add(id);
  const ids = [...seen].slice(-SEEN_MAX);
  stateOf(h).seen = new Set(ids);
  await h.fs.mkdir(h.paths.seenDir, DIR_MODE);
  await h.fs.writeAtomic(h.paths.seenFile(consumerIdOf(h.self, h.actor8)), `${JSON.stringify({ v: 1, ids })}\n`, { fsync: false, mode: FILE_MODE });
}

// ── ack / awaitAck ────────────────────────────────────────────────────────────────────────────────────────────────────

/** writes acks/<myDeviceId>/<msgId>/<mySessionId>.json and appends the id to coordination/seen/<mySessionId>.json (≤ 2,000, one writer) */
export async function ack(ledger: Ledger, msgId: string, outcome: AckOutcome, detail60?: string): Promise<void> {
  const h = asHandle(ledger);
  if (!MSG_ID_RE.test(msgId)) throw new ConfigError(`ack: '${msgId}' is not a message id`, { setting: 'coordination' });
  if (h.self.sessionId === null) throw new ConfigError('ack: this process has no session id', { setting: 'coordination' });
  const record: Ack = finalizeRecord(
    {
      v: 1,
      kind: 'ack',
      msgId,
      by: h.self.sessionId,
      deviceId: h.self.deviceId,
      at: new Date(h.now()).toISOString(),
      outcome,
      ...(detail60 !== undefined ? { detail60: oneLine(h.redact(detail60)).slice(0, 60) } : {}),
      stamp: h.stamps.issue(),
      checksum: '',
    },
    h.redact,
  );
  await h.writeOwn('acks', join(msgId, `${h.self.sessionId}.json`), h.sign(record), { fsync: true });
  await markSeen(h, msgId);
}

/** the CLI twin's wait: resolves with the target's ack or null after `timeoutMs` (default 5_000), via subscribe — never a busy loop */
export function awaitAck(ledger: Ledger, msgId: string, timeoutMs = AWAIT_ACK_MS): Promise<Ack | null> {
  const h = asHandle(ledger);
  h.trackAck(msgId);
  const found = (): Ack | null => h.fold.acks.get(msgId)?.[0] ?? null;
  const now = found();
  if (now !== null) return Promise.resolve(now);
  return new Promise<Ack | null>((resolve) => {
    let done = false;
    const finish = (a: Ack | null): void => {
      if (done) return;
      done = true;
      unsubscribe();
      h.timers.clearTimeout(timer);
      resolve(a);
    };
    const unsubscribe = h.subscribe(() => {
      const a = found();
      if (a !== null) finish(a);
    });
    const timer = h.timers.setTimeout(() => finish(null), timeoutMs);
    void h.refresh('all').then(() => {
      const a = found();
      if (a !== null) finish(a);
    });
  });
}

// ── target grammar (§5.3) ─────────────────────────────────────────────────────────────────────────────────────────────

export type ResolveResult = { ok: true; to: string[] } | { ok: false; reason: 'ambiguous' | 'unknown'; candidates: SessionActivity[] };

/** `target := <id-suffix> | <title | unique prefix> | me | all | tree | repo | device:<label[#id4]|id8>` over the fold */
export function resolveTarget(fold: Fold, self: SelfIdentity, target: string): ResolveResult {
  const t = target.trim();
  const unknown: ResolveResult = { ok: false, reason: 'unknown', candidates: [] };
  if (t === '') return unknown;
  if (t === 'all') return { ok: true, to: ['@all'] };
  if (t === 'me') return self.sessionId === null ? unknown : { ok: true, to: [self.sessionId] };
  if (t === 'repo') {
    const key = self.repoKey ?? self.remoteKey;
    return key === null ? unknown : { ok: true, to: [`@${key}`] };
  }
  const rows = listSessions(fold, self, { all: true });
  const liveRows = rows.filter((a) => a.liveness === 'live' || a.liveness === 'gone');
  const sessionsOf = (xs: SessionActivity[]): string[] => [...new Set(xs.map((a) => a.sessionId))];
  if (t === 'tree') {
    const same = liveRows.filter((a) => a.heartbeat.repo.wsKey === self.wsKey && a.sessionId !== self.sessionId);
    return same.length === 0 ? unknown : { ok: true, to: sessionsOf(same) };
  }
  if (t.startsWith('device:')) {
    const spec = t.slice('device:'.length);
    const byId = DEVICE_ID_RE.test(spec) ? [spec] : [];
    const hash = spec.indexOf('#');
    const label = hash === -1 ? spec : spec.slice(0, hash);
    const id4 = hash === -1 ? null : spec.slice(hash + 1);
    const devices = new Set<string>(byId);
    for (const d of fold.devices.values()) if (d.label === label && (id4 === null || d.deviceId.startsWith(id4))) devices.add(d.deviceId);
    for (const a of liveRows) if (a.label === label && (id4 === null || a.deviceId.startsWith(id4))) devices.add(a.deviceId);
    if (devices.size === 0) return unknown;
    if (devices.size > 1) return { ok: false, reason: 'ambiguous', candidates: liveRows.filter((a) => devices.has(a.deviceId)) };
    const [deviceId] = devices;
    const on = liveRows.filter((a) => a.deviceId === deviceId);
    return on.length === 0 ? unknown : { ok: true, to: sessionsOf(on) };
  }
  // <id-suffix> — a suffix or unique substring of a run id or session id
  const byId = rows.filter((a) => a.runId.endsWith(t) || a.sessionId.endsWith(t) || a.runId.includes(t) || a.sessionId.includes(t));
  if (sessionsOf(byId).length === 1) return { ok: true, to: sessionsOf(byId) };
  if (sessionsOf(byId).length > 1) return { ok: false, reason: 'ambiguous', candidates: byId };
  // <title | unique prefix>
  const lower = t.toLowerCase();
  const byTitle = rows.filter((a) => (a.heartbeat.title60 ?? '').toLowerCase().startsWith(lower) || a.heartbeat.task60.toLowerCase().startsWith(lower));
  if (sessionsOf(byTitle).length === 1) return { ok: true, to: sessionsOf(byTitle) };
  if (sessionsOf(byTitle).length > 1) return { ok: false, reason: 'ambiguous', candidates: byTitle };
  return unknown;
}

// ── the permission boundary (§5.4, §10.3, §11 row 50) ─────────────────────────────────────────────────────────────────

export type RemoteControl = 'allow' | 'confirm' | 'never';

export interface IncomingDisposition {
  /** what the receiver may do with it — `steer` only from a trusted or same-device sender, else it is a `note` */
  action: 'note' | 'steer' | 'pause' | 'end' | 'resume' | 'abort' | 'request-release' | 'heads-up' | 'handoff' | 'who' | 'ack';
  /** the sender asked for more than its rights allow; `action` is what it was reduced to */
  downgraded: boolean;
  /** the local human must confirm before the action applies (`abort` always; `pause` / `end` / `resume` under 'confirm') */
  needsConfirm: boolean;
  /** `ack refused` with this detail when the message is dropped outright */
  refused: string | null;
  /** + review blockers 5 / 6: where the message was read and whether it is authentic — the basis of every decision above */
  authority: Authority;
}

/**
 * A message never widens a receiver's rights: `steer` is a directive only from this device or an hmac-valid paired device,
 * otherwise a `note`; `pause` / `end` / `resume` apply from this device, from a trusted device under
 * `remoteControl:'allow'`, need the local `[y]` under `'confirm'`, and are dropped under `'never'`; `abort` ALWAYS needs the
 * local `[y]`.
 *
 * + review blocker 6: "this device" is `origin.self` — the file was read from THIS process's own local
 * `inbox/<myDeviceId>/` subtree. A file planted at `<sharedDir>/jevcode-commons/inbox/<myDeviceId>/<mySessionId>/…` with
 * `from.deviceId = <myDeviceId>` passes any content test and would auto-apply `pause` / `end` under the DEFAULT
 * `remoteControl: 'confirm'` (and under `'allow'` a forged `resume` would spawn a headless run that spends money).
 * + review blocker 5: a trusted device must ALSO be hmac-valid (`origin.authenticated`), not merely listed.
 */
export function classifyIncoming(msg: Message, o: { self: Pick<SelfIdentity, 'deviceId'>; trusted: ReadonlySet<string>; remoteControl: RemoteControl; origin: RecordOrigin }): IncomingDisposition {
  const authority: Authority = o.origin.self ? 'self' : o.origin.authenticated && o.trusted.has(msg.from.deviceId) ? 'trusted' : 'unverified';
  const sameDevice = authority === 'self';
  const trusted = authority !== 'unverified';
  const plain = (action: IncomingDisposition['action']): IncomingDisposition => ({ action, downgraded: false, needsConfirm: false, refused: null, authority });
  switch (msg.type) {
    case 'note':
    case 'heads-up':
    case 'handoff':
    case 'who':
    case 'ack':
    case 'request-release':
      return plain(msg.type);
    case 'steer':
      return trusted ? plain('steer') : { action: 'note', downgraded: true, needsConfirm: false, refused: null, authority };
    case 'abort':
      return { action: 'abort', downgraded: false, needsConfirm: true, refused: null, authority };
    case 'pause':
    case 'end':
    case 'resume': {
      if (sameDevice) return plain(msg.type);
      if (o.remoteControl === 'never') return { action: 'note', downgraded: true, needsConfirm: false, refused: `remote ${msg.type} disabled (coordination.remoteControl: never)`, authority };
      if (trusted && o.remoteControl === 'allow') return plain(msg.type);
      return { action: msg.type, downgraded: false, needsConfirm: true, refused: null, authority };
    }
  }
}
