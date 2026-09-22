/**
 * The fold (§3.5, §12.0.4 "Read API"): a pure reduction of the record SET into `Fold`. The ledger re-parses only changed
 * files, but the assembly is rebuilt from the whole set on every change — a few thousand map inserts, well under a
 * millisecond — so the result is a function of the records and the side state (first-arrival monotonic times, gone
 * times), never of the order files arrived in. `listSessions` and the target/inbox helpers are pure over the fold.
 */
import { authorityOf, compareClaim, FOREIGN_ORIGIN } from './claims.js';
import { compareStamp, GONE_KEEP_MS, isLive, SKEW_MS, type Now } from './records.js';
import { sameRepo } from './ids.js';
import type { Ack, AnyRecord, Authority, DeviceRecord, Fold, Heartbeat, Lease, Liveness, LivenessEnv, Message, RecordKind, RecordOrigin, SelfIdentity, SessionActivity } from './types.js';

/** §3.5 caps: overflow drops the oldest by stamp from memory (files untouched) and counts. */
export const FOLD_CAPS = { heartbeats: 512, leases: 2048, messagesPerTarget: 200 } as const;

export interface RecordEntry {
  kind: RecordKind;
  record: AnyRecord;
  /** the subtree the file was read from */
  deviceId: string;
  path: string;
  /** the mirror it came from, or null for the local store */
  source: string | null;
  /**
   * + review blockers 5 / 6: decided by the READER from the path and the hmac, never from the record. `self` is true only
   * for the local `<kind>/<myDeviceId>/` subtree — a file under my device id in a shared mirror is foreign.
   */
  origin: RecordOrigin;
}

/**
 * Side state the reduction needs beyond the records: first-arrival times per (device, run) and gone times. Arrival is keyed
 * by the record's CHECKSUM, not `beatSeq` (review #11): a resumed process restarts `beatSeq` below the previous process's
 * value, so a beatSeq comparison would never advance `arrivalMono` and a live resumed run would read `stale` after ttl+slack.
 */
export interface FoldState {
  arrivals: Map<string, { checksum: string; arrivalMono: number }>;
  goneAt: Map<string, number>;
}
export function emptyFoldState(): FoldState {
  return { arrivals: new Map(), goneAt: new Map() };
}

export interface FoldEnv extends LivenessEnv {
  now: Now;
  /** the message targets this reader consumes (`sessionTargets(self)`) */
  targets: ReadonlySet<string>;
  /** local tombstones (§4.6 row 4): the subtree is skipped except for its device record */
  ignoredDevices: ReadonlySet<string>;
  /** §9.2: our own measured lag, shown on our device row */
  selfSyncLagMs?: number | null;
  /** records that failed to parse in this cycle */
  skipped?: number;
}

export function emptyFold(now: Now): Fold {
  return { live: new Map(), gone: new Map(), leases: new Map(), byPath: new Map(), inbox: [], acks: new Map(), devices: new Map(), origins: new Map(), skipped: 0, at: { wallMs: now.wallMs, monoMs: now.monoMs } };
}

/** §5.1: a recipient's inbox is the union, over every device subtree, of the `<sessionId>`, `@<repoKey>`, `@<remoteKey>` and `@all` outbox dirs. */
export function sessionTargets(self: Pick<SelfIdentity, 'sessionId' | 'repoKey' | 'remoteKey'>): Set<string> {
  const t = new Set<string>(['@all']);
  if (self.sessionId !== null) t.add(self.sessionId);
  if (self.repoKey !== null) t.add(`@${self.repoKey}`);
  if (self.remoteKey !== null) t.add(`@${self.remoteKey}`);
  return t;
}

/** The lease directories a reader folds: its repoKey, remoteKey and wsKey (a non-git workspace leases under its wsKey). */
export function leaseKeysOf(self: Pick<SelfIdentity, 'repoKey' | 'remoteKey' | 'wsKey'>): string[] {
  const keys = [self.repoKey, self.remoteKey, self.wsKey].filter((k): k is string => k !== null);
  return [...new Set(keys)];
}

function byStampDesc<T extends { stamp: { n: number; deviceId: string; runId: string } }>(a: T, b: T): number {
  return compareStamp(b.stamp, a.stamp);
}

const hbKey = (hb: Heartbeat): string => `${hb.deviceId}/${hb.runId}`;
/** `Fold.origins` keys: a heartbeat is `<deviceId>/<runId>` (a deviceId is 8 base32 chars, so no prefix can collide). */
export const messageOriginKey = (id: string): string => `msg/${id}`;
export const leaseOriginKey = (leaseId: string): string => `lease/${leaseId}`;

/** Build the fold from the record set. Pure given `state` (which it updates: first arrivals, gone times). */
export function buildFold(entries: Iterable<RecordEntry>, state: FoldState, env: FoldEnv): Fold {
  const fold = emptyFold(env.now);
  fold.skipped = env.skipped ?? 0;
  const heartbeats: { hb: Heartbeat; origin: RecordOrigin }[] = [];
  const leases: Lease[] = [];
  const messages: Message[] = [];
  const acks: Ack[] = [];
  const devices: DeviceRecord[] = [];
  for (const e of entries) {
    if (e.kind === 'device') {
      devices.push(e.record as DeviceRecord);
      continue;
    }
    if (env.ignoredDevices.has(e.deviceId)) continue;
    switch (e.kind) {
      case 'heartbeat':
        heartbeats.push({ hb: e.record as Heartbeat, origin: e.origin });
        break;
      case 'lease': {
        const l = e.record as Lease;
        leases.push(l);
        fold.origins.set(leaseOriginKey(l.leaseId), e.origin);
        break;
      }
      case 'message': {
        const m = e.record as Message;
        messages.push(m);
        fold.origins.set(messageOriginKey(m.id), e.origin);
        break;
      }
      case 'ack':
        acks.push(e.record as Ack);
        break;
    }
  }

  // devices — deterministic: sorted by id; lastSeen from the newest beat of that device
  const lastSeen = new Map<string, string>();
  for (const { hb } of heartbeats) {
    const prev = lastSeen.get(hb.deviceId);
    if (prev === undefined || hb.beatAt > prev) lastSeen.set(hb.deviceId, hb.beatAt);
  }
  for (const d of [...devices].sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0))) {
    if (fold.devices.has(d.deviceId)) continue;
    fold.devices.set(d.deviceId, { ...d, lastSeen: lastSeen.get(d.deviceId) ?? d.createdAt, syncLagMs: d.deviceId === env.deviceId ? (env.selfSyncLagMs ?? null) : null, ignored: env.ignoredDevices.has(d.deviceId) });
  }

  // heartbeats — one per (device, run) file; several records for one runId = a fork (§9.3): the lowest CLAIM holds
  // (+ review blocker 3: the claim is immutable, so both sides of a fork reach the same verdict whatever the sync timing)
  heartbeats.sort((a, b) => byStampDesc(a.hb, b.hb));
  const kept = heartbeats.length > FOLD_CAPS.heartbeats ? heartbeats.slice(0, FOLD_CAPS.heartbeats) : heartbeats;
  fold.skipped += heartbeats.length - kept.length;
  const byRun = new Map<string, (Heartbeat & { arrivalMono: number })[]>();
  const seenKeys = new Set<string>();
  for (const { hb, origin } of kept) {
    const key = hbKey(hb);
    seenKeys.add(key);
    fold.origins.set(key, origin);
    const prev = state.arrivals.get(key);
    let arrivalMono: number;
    if (prev !== undefined && prev.checksum === hb.checksum) arrivalMono = prev.arrivalMono;
    else {
      arrivalMono = env.now.monoMs;
      state.arrivals.set(key, { checksum: hb.checksum, arrivalMono });
    }
    const list = byRun.get(hb.runId) ?? [];
    list.push({ ...hb, arrivalMono });
    byRun.set(hb.runId, list);
  }
  // only `state.arrivals` is carried between builds and needs pruning; `fold.origins` is rebuilt from the entries every time
  for (const k of [...state.arrivals.keys()]) if (!seenKeys.has(k)) state.arrivals.delete(k);
  for (const [runId, list] of byRun) {
    list.sort((a, b) => compareClaim(a.claim, b.claim) || compareStamp(a.stamp, b.stamp));
    const holder = list[0]!;
    if (list.length > 1) {
      fold.forks ??= new Map();
      fold.forks.set(runId, list.slice(1));
    }
    // a run whose CLAIM holder is stale but which has a live later incarnation (a takeover) is live under that one
    let shown = holder;
    let verdict = isLive(holder, env.now, { arrivalMono: holder.arrivalMono }, env, fold.origins.get(hbKey(holder)) ?? FOREIGN_ORIGIN);
    if (verdict.liveness !== 'live') {
      for (const cand of list.slice(1)) {
        const v = isLive(cand, env.now, { arrivalMono: cand.arrivalMono }, env, fold.origins.get(hbKey(cand)) ?? FOREIGN_ORIGIN);
        if (v.liveness === 'live') {
          shown = cand;
          verdict = v;
          break;
        }
      }
    }
    const key = hbKey(shown);
    if (verdict.liveness === 'live') {
      state.goneAt.delete(key);
      fold.live.set(runId, shown);
    } else {
      let goneAtMono = state.goneAt.get(key);
      if (goneAtMono === undefined) {
        goneAtMono = env.now.monoMs;
        state.goneAt.set(key, goneAtMono);
      }
      fold.gone.set(runId, { ...shown, goneAtMono });
    }
  }
  for (const k of [...state.goneAt.keys()]) if (!seenKeys.has(k)) state.goneAt.delete(k);

  // leases — by leaseId; cap by stamp
  leases.sort(byStampDesc);
  const keptLeases = leases.length > FOLD_CAPS.leases ? leases.slice(0, FOLD_CAPS.leases) : leases;
  fold.skipped += leases.length - keptLeases.length;
  for (const l of keptLeases.sort((a, b) => (a.leaseId < b.leaseId ? -1 : a.leaseId > b.leaseId ? 1 : 0))) {
    if (fold.leases.has(l.leaseId)) continue;
    fold.leases.set(l.leaseId, l);
    for (const p of l.paths) {
      const ids = fold.byPath.get(p) ?? [];
      ids.push(l.leaseId);
      fold.byPath.set(p, ids);
    }
  }

  // messages — those addressed to my targets; ≤ 200 per target by stamp; stamp order
  const perTarget = new Map<string, Message[]>();
  for (const m of messages) {
    if (!env.targets.has(m.to)) continue;
    const list = perTarget.get(m.to) ?? [];
    list.push(m);
    perTarget.set(m.to, list);
  }
  const seenIds = new Set<string>();
  for (const [, list] of perTarget) {
    list.sort(byStampDesc);
    const keptMsgs = list.length > FOLD_CAPS.messagesPerTarget ? list.slice(0, FOLD_CAPS.messagesPerTarget) : list;
    fold.skipped += list.length - keptMsgs.length;
    for (const m of keptMsgs) {
      if (seenIds.has(m.id)) continue;
      seenIds.add(m.id);
      fold.inbox.push(m);
    }
  }
  fold.inbox.sort((a, b) => compareStamp(a.stamp, b.stamp) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // acks — by msgId, stamp order
  for (const a of acks) {
    const list = fold.acks.get(a.msgId) ?? [];
    list.push(a);
    fold.acks.set(a.msgId, list);
  }
  for (const [, list] of fold.acks) list.sort((a, b) => compareStamp(a.stamp, b.stamp) || (a.by < b.by ? -1 : a.by > b.by ? 1 : 0));

  return fold;
}

/** The largest stamp `n` in the fold (own subtree, gone records and forks included) — the seed of a new run's clock (§3.2). */
export function maxStampN(fold: Fold): number {
  let n = 0;
  const bump = (s: { n: number }): void => {
    if (s.n > n) n = s.n;
  };
  for (const hb of fold.live.values()) bump(hb.stamp);
  for (const hb of fold.gone.values()) bump(hb.stamp);
  for (const list of fold.forks?.values() ?? []) for (const hb of list) bump(hb.stamp);
  for (const l of fold.leases.values()) bump(l.stamp);
  for (const m of fold.inbox) bump(m.stamp);
  for (const list of fold.acks.values()) for (const a of list) bump(a.stamp);
  return n;
}

// ── listSessions (§3.6, §12.0.4) ──────────────────────────────────────────────────────────────────────────────────────

const LIVENESS_RANK: Record<Liveness, number> = { live: 0, gone: 1, stale: 2, 'stale-reused-pid': 2, unknown: 3 };

function parseIso(s: string): number {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : Number.NaN;
}

/** leases by runId, built once per `listSessions` call — the row loop was `O(rows × leases)` (200 rows × 2,048 leases). */
function leasesByRun(fold: Fold): Map<string, Lease[]> {
  const out = new Map<string, Lease[]>();
  for (const l of fold.leases.values()) {
    const list = out.get(l.runId);
    if (list === undefined) out.set(l.runId, [l]);
    else list.push(l);
  }
  return out;
}

function activityOf(fold: Fold, self: SelfIdentity, hb: Heartbeat & { arrivalMono: number; goneAtMono?: number }, liveness: Liveness, byRun: Map<string, Lease[]>): SessionActivity {
  // + review blocker 6: same device is the READ LOCATION, never `hb.deviceId === self.deviceId`
  const origin = fold.origins.get(`${hb.deviceId}/${hb.runId}`) ?? FOREIGN_ORIGIN;
  const authority: Authority = authorityOf(origin);
  const sameDevice = origin.self;
  const beatAt = parseIso(hb.beatAt);
  const beatAgeMs = Number.isFinite(beatAt) ? Math.max(0, fold.at.wallMs - beatAt) : 0;
  const skewMs = Number.isFinite(beatAt) && beatAt - fold.at.wallMs > SKEW_MS ? beatAt - fold.at.wallMs : null;
  const hung = sameDevice && liveness === 'live' && Number.isFinite(beatAt) && fold.at.wallMs - beatAt > hb.ttlMs;
  const leases: Lease[] = [];
  let takenOver = false;
  for (const l of byRun.get(hb.runId) ?? []) {
    if (l.deviceId === hb.deviceId) leases.push(l);
    // + blocker 3: a takeover outranks a record by CLAIM (a later incarnation), never by the folding stamp
    else if (l.type === 'takeover' && l.claim !== undefined && compareClaim(l.claim, hb.claim) > 0) takenOver = true;
  }
  const device = fold.devices.get(hb.deviceId);
  return {
    runId: hb.runId,
    sessionId: hb.sessionId,
    parentSessionId: hb.parentSessionId,
    deviceId: hb.deviceId,
    label: hb.label,
    sameDevice,
    kind: hb.kind === 'bench' ? 'bench' : 'run',
    liveness,
    flags: {
      hung,
      skewed: skewMs !== null,
      forked: fold.forks?.has(hb.runId) === true,
      takenOver,
      noLock: hb.lockHeld === false,
      ignoredDevice: device?.ignored === true,
      unverified: authority === 'unverified',
    },
    authority,
    skewMs,
    beatAgeMs,
    arrivalAgeMs: sameDevice ? null : Math.max(0, fold.at.monoMs - hb.arrivalMono),
    syncLagMs: device?.syncLagMs ?? null,
    sameRepo: sameRepo(hb.repo, self),
    sameBranch: hb.repo.branch === null || self.branch === null ? null : hb.repo.branch === self.branch,
    heartbeat: hb,
    leases,
  };
}

/**
 * pure: one row per heartbeat in fold.live ∪ fold.gone; sorted live → gone → stale, then beatAt desc; `all` adds stale > 10 min
 * and rows from ignored devices. Liveness of a gone row: `gone` within 10 min, else `stale` (`stale-reused-pid` when the run
 * started before this device booted, §3.4).
 */
export function listSessions(fold: Fold, self: SelfIdentity, opts: { all?: boolean } = {}): SessionActivity[] {
  const all = opts.all === true;
  const rows: SessionActivity[] = [];
  const boot = parseIso(self.bootAt);
  const byRun = leasesByRun(fold);
  for (const hb of fold.live.values()) {
    if (!all && fold.devices.get(hb.deviceId)?.ignored === true) continue;
    rows.push(activityOf(fold, self, hb, 'live', byRun));
  }
  for (const hb of fold.gone.values()) {
    if (!all && fold.devices.get(hb.deviceId)?.ignored === true) continue;
    const within = fold.at.monoMs - hb.goneAtMono <= GONE_KEEP_MS;
    if (!within && !all) continue;
    let liveness: Liveness = within ? 'gone' : 'stale';
    if (!within && fold.origins.get(`${hb.deviceId}/${hb.runId}`)?.self === true && hb.phase !== 'ended') {
      const started = parseIso(hb.startedAt);
      if (Number.isFinite(started) && Number.isFinite(boot) && started < boot) liveness = 'stale-reused-pid';
    }
    rows.push(activityOf(fold, self, hb, liveness, byRun));
  }
  rows.sort((a, b) => {
    const r = LIVENESS_RANK[a.liveness] - LIVENESS_RANK[b.liveness];
    if (r !== 0) return r;
    if (a.heartbeat.beatAt !== b.heartbeat.beatAt) return a.heartbeat.beatAt < b.heartbeat.beatAt ? 1 : -1;
    return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
  });
  return rows;
}

/** + review blocker 3: every heartbeat the fold holds for one runId, holder first (the lowest claim). */
export function byRunId(fold: Fold, runId: string): (Heartbeat & { arrivalMono: number })[] {
  const out: (Heartbeat & { arrivalMono: number })[] = [];
  const live = fold.live.get(runId);
  if (live !== undefined) out.push(live);
  const gone = fold.gone.get(runId);
  if (gone !== undefined && (live === undefined || gone.deviceId !== live.deviceId)) out.push(gone);
  for (const f of fold.forks?.get(runId) ?? []) if (!out.some((o) => o.deviceId === f.deviceId)) out.push(f);
  return out.sort((a, b) => compareClaim(a.claim, b.claim));
}

/** The origin the fold recorded for one heartbeat — the only legitimate source of "is this mine?" (blocker 6). */
export function originOf(fold: Fold, hb: Pick<Heartbeat, 'deviceId' | 'runId'>): RecordOrigin {
  return fold.origins.get(`${hb.deviceId}/${hb.runId}`) ?? FOREIGN_ORIGIN;
}

/** The origin of one message — what `classifyIncoming` must be given (blockers 5 / 6). */
export function messageOrigin(fold: Fold, msg: Pick<Message, 'id'>): RecordOrigin {
  return fold.origins.get(messageOriginKey(msg.id)) ?? FOREIGN_ORIGIN;
}

/** The origin of one lease. */
export function leaseOrigin(fold: Fold, lease: Pick<Lease, 'leaseId'>): RecordOrigin {
  return fold.origins.get(leaseOriginKey(lease.leaseId)) ?? FOREIGN_ORIGIN;
}

/** Every epoch the fold has seen for one runId — the seed of `mintClaim` on a resume, takeover or import. */
export function seenEpochs(fold: Fold, runId: string): number[] {
  return byRunId(fold, runId).map((hb) => hb.claim.epoch);
}

/** §6.5: the child runs of a session (their heartbeats carry `parentSessionId`). */
export function childrenOf(fold: Fold, self: SelfIdentity, parentSessionId: string): SessionActivity[] {
  return listSessions(fold, self).filter((a) => a.parentSessionId === parentSessionId);
}
