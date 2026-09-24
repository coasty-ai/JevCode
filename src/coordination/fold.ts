/**
 * The fold (§3.5, §12.0.4 "Read API"): a pure reduction of the record SET into `Fold`. The ledger re-parses only changed
 * files, but the assembly is rebuilt from the whole set on every change — a few thousand map inserts, well under a
 * millisecond — so the result is a function of the records and the side state (first-arrival monotonic times, gone
 * times), never of the order files arrived in. `listSessions` and the target/inbox helpers are pure over the fold.
 *
 * `peerViewOf` at the foot is pure over the fold's PROJECTION rather than over the fold: it is the one place
 * `CoordinationStatus` becomes `PeerView`, so the `⇄` zone and `/peers` cannot show different numbers (§3.6).
 */
import { authorityOf, compareClaim, FOREIGN_ORIGIN } from './claims.js';
import { compareStamp, GONE_KEEP_MS, honouredTtlMs, isLive, SKEW_MS, SYNC_SLACK_GIT_MS, type Now } from './records.js';
import { sameRepo } from './ids.js';
import type { CoordinationStatus, PeerView } from '../core/types.js';
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
  /**
   * + review minor 26: §9.2 for a FOREIGN device — `now − mtime of the newest file we read from that device's mirror
   * copy`, measured by the scanner. Absent for a device we have only local records of.
   */
  foreignSyncLagMs?: ReadonlyMap<string, number>;
  /** records that failed to parse in this cycle */
  skipped?: number;
}

export function emptyFold(now: Now): Fold {
  return { live: new Map(), gone: new Map(), leases: new Map(), byPath: new Map(), inbox: [], acks: new Map(), devices: new Map(), origins: new Map(), liveness: new Map(), ignored: new Map(), cloned: new Set(), skipped: 0, at: { wallMs: now.wallMs, monoMs: now.monoMs } };
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
/**
 * + review major 12: ONE heartbeat record, including two processes of one device on one runId. `Fold.liveness` and
 * `listSessions`'s row set are keyed by this; `origins` stays on `<deviceId>/<runId>` (the §12.0.4 shape).
 */
export const recordKeyOf = (hb: Pick<Heartbeat, 'deviceId' | 'runId' | 'pid'>): string => `${hb.deviceId}/${hb.runId}/${hb.pid}`;
/** `Fold.origins` keys: a heartbeat is `<deviceId>/<runId>` (a deviceId is 8 base32 chars, so no prefix can collide). */
export const messageOriginKey = (id: string): string => `msg/${id}`;
export const leaseOriginKey = (leaseId: string): string => `lease/${leaseId}`;
/**
 * + review blocker 3 (acks): an ack's origin is keyed by the subtree it was READ from as well as its content — two
 * devices can (and in the attack do) both publish `acks/<dev>/<msgId>/<by>.json` with the same `by`.
 */
export const ackOriginKey = (deviceId: string, msgId: string, by: string): string => `ack/${deviceId}/${msgId}/${by}`;

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
    if (env.ignoredDevices.has(e.deviceId)) {
      // + review minor 25: kept OUT of every decision path, but walkable by `sessions who --all`
      if (e.kind === 'heartbeat') {
        const hb = e.record as Heartbeat;
        fold.ignored.set(recordKeyOf(hb), { ...hb, arrivalMono: env.now.monoMs });
      }
      continue;
    }
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
      case 'ack': {
        const a = e.record as Ack;
        acks.push(a);
        fold.origins.set(ackOriginKey(e.deviceId, a.msgId, a.by), e.origin);
        break;
      }
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
    const syncLagMs = d.deviceId === env.deviceId ? (env.selfSyncLagMs ?? null) : (env.foreignSyncLagMs?.get(d.deviceId) ?? null);
    fold.devices.set(d.deviceId, { ...d, lastSeen: lastSeen.get(d.deviceId) ?? d.createdAt, syncLagMs, ignored: env.ignoredDevices.has(d.deviceId), cloned: false });
  }

  // heartbeats — one per (device, run) file; several records for one runId = a fork (§9.3): the HIGHEST claim epoch holds
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
  // + review minor 26: the 180 s git slack is a PER-DEVICE fact (`device.json.syncMode`), not one number for the fold
  const envFor = (deviceId: string): FoldEnv =>
    fold.devices.get(deviceId)?.syncMode === 'git' ? { ...env, syncSlackMs: env.gitSyncSlackMs ?? SYNC_SLACK_GIT_MS } : env;
  const verdictOf = (hb: Heartbeat & { arrivalMono: number }): Liveness => {
    const v = isLive(hb, env.now, { arrivalMono: hb.arrivalMono }, envFor(hb.deviceId), fold.origins.get(hbKey(hb)) ?? FOREIGN_ORIGIN);
    fold.liveness.set(recordKeyOf(hb), v.liveness);
    return v.liveness;
  };
  for (const [runId, list] of byRun) {
    list.sort((a, b) => compareClaim(a.claim, b.claim) || compareStamp(a.stamp, b.stamp));
    const holder = list[0]!;
    if (list.length > 1) {
      fold.forks ??= new Map();
      fold.forks.set(runId, list.slice(1));
    }
    // + review major 12: EVERY record gets a verdict, so `listSessions` can show a row per (deviceId, runId, pid)
    for (const hb of list) verdictOf(hb);
    // a run whose CLAIM holder is stale but which has a live later incarnation (a takeover) is live under that one
    let shown = holder;
    let verdict: Liveness = fold.liveness.get(recordKeyOf(holder)) ?? 'unknown';
    if (verdict !== 'live') {
      for (const cand of list.slice(1)) {
        if (fold.liveness.get(recordKeyOf(cand)) === 'live') {
          shown = cand;
          verdict = 'live';
          break;
        }
      }
    }
    const key = hbKey(shown);
    if (verdict === 'live') {
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

  // §3.2 / §10.3 (design revision 5): the CLONE flag. Two or more LIVE heartbeats from ONE deviceId carrying different
  // `bootId`s are one `deviceKey` on two machines, so that key can no longer speak for either of them: every gated
  // action is suspended for that device until it is re-paired. For a FOREIGN device this is all a peer can do (it must
  // not delete or rewrite anything of theirs); for MY OWN deviceId it is the `duplicate-identity` case of §3.2 and the
  // later booter adopts a new id. The flag is a fact about records, so it is computed here and never in a renderer.
  const bootsByDevice = new Map<string, Set<string>>();
  for (const { hb } of kept) {
    if (typeof hb.bootId !== 'string' || hb.bootId === '') continue;
    if (fold.liveness.get(recordKeyOf(hb)) !== 'live') continue;
    const set = bootsByDevice.get(hb.deviceId) ?? new Set<string>();
    set.add(hb.bootId);
    bootsByDevice.set(hb.deviceId, set);
  }
  for (const [deviceId, boots] of bootsByDevice) {
    if (boots.size < 2) continue;
    fold.cloned.add(deviceId);
    const d = fold.devices.get(deviceId);
    if (d !== undefined) fold.devices.set(deviceId, { ...d, cloned: true });
  }

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
  // + re-check (6): adoption is TRUST-QUALIFIED. A Lamport clock only has to follow writers whose order matters to it,
  // and `leaseId = <runId>-<n>` / `msgId = <deviceId>-<actor8>-<n>` are derived from it: an unverified writer that
  // published `n = 999_998_999` pushed every local clock to the saturation ceiling within a thousand issues, after
  // which every `declare` overwrote the previous lease FILE and every message after the first was dropped by the
  // `seenIds` dedupe. Only my own records and hmac-valid records from a paired device raise the bar; an unverified
  // peer's stamp still DISPLAYS and still orders that peer's own records, it just cannot move my counter.
  const bump = (s: { n: number }, origin: RecordOrigin | undefined): void => {
    if (origin === undefined || authorityOf(origin) === 'unverified') return;
    if (s.n > n) n = s.n;
  };
  for (const hb of fold.live.values()) bump(hb.stamp, fold.origins.get(`${hb.deviceId}/${hb.runId}`));
  for (const hb of fold.gone.values()) bump(hb.stamp, fold.origins.get(`${hb.deviceId}/${hb.runId}`));
  for (const list of fold.forks?.values() ?? []) for (const hb of list) bump(hb.stamp, fold.origins.get(`${hb.deviceId}/${hb.runId}`));
  for (const l of fold.leases.values()) bump(l.stamp, fold.origins.get(leaseOriginKey(l.leaseId)));
  for (const m of fold.inbox) bump(m.stamp, fold.origins.get(messageOriginKey(m.id)));
  for (const list of fold.acks.values()) for (const a of list) bump(a.stamp, fold.origins.get(ackOriginKey(a.deviceId, a.msgId, a.by)));
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
  const hung = sameDevice && liveness === 'live' && Number.isFinite(beatAt) && fold.at.wallMs - beatAt > honouredTtlMs(hb.ttlMs);
  const leases: Lease[] = [];
  let takenOver = false;
  for (const l of byRun.get(hb.runId) ?? []) {
    if (l.deviceId === hb.deviceId) leases.push(l);
    // + blocker 3: a takeover outranks a record by CLAIM (a later incarnation), never by the folding stamp
    else if (l.type === 'takeover' && l.claim !== undefined && compareClaim(l.claim, hb.claim) < 0) takenOver = true;
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
      // §3.2 / §10.3 (revision 5): one deviceKey on two machines — every gated action is suspended until re-pairing
      cloned: fold.cloned.has(hb.deviceId),
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
  const seen = new Set<string>();
  const push = (hb: Heartbeat & { arrivalMono: number; goneAtMono?: number }, liveness: Liveness): void => {
    const key = recordKeyOf(hb);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(activityOf(fold, self, hb, liveness, byRun));
  };
  for (const hb of fold.live.values()) {
    if (!all && fold.devices.get(hb.deviceId)?.ignored === true) continue;
    push(hb, 'live');
  }
  // + review major 12: one row per (deviceId, runId) — a FORK is a second record for one runId and had no row at all,
  // so `sessions who` hid exactly the case §9.3 exists for (and `/spawn`'s child runs on one device hid each other).
  for (const list of fold.forks?.values() ?? []) {
    for (const hb of list) {
      if (!all && fold.devices.get(hb.deviceId)?.ignored === true) continue;
      const verdict = fold.liveness.get(recordKeyOf(hb)) ?? 'unknown';
      if (verdict !== 'live' && !all) continue;
      push(hb, verdict);
    }
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
    push(hb, liveness);
  }
  // + review minor 25: an ignored device's rows exist only under `--all`, and every one carries `flags.ignoredDevice`
  if (all) for (const hb of fold.ignored.values()) push(hb, fold.liveness.get(recordKeyOf(hb)) ?? 'unknown');
  rows.sort((a, b) => {
    const r = LIVENESS_RANK[a.liveness] - LIVENESS_RANK[b.liveness];
    if (r !== 0) return r;
    if (a.heartbeat.beatAt !== b.heartbeat.beatAt) return a.heartbeat.beatAt < b.heartbeat.beatAt ? 1 : -1;
    if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1;
    if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
    return a.heartbeat.pid - b.heartbeat.pid;
  });
  return rows;
}

/**
 * + review blocker 3 / major 12: every heartbeat the fold holds for one runId, in **rank order** (`compareClaim`, which
 * is the ownership fence — never the folding stamp, never arrival order), so `[0]` carries the HIGHEST epoch (§3.2).
 * Records are deduplicated by (deviceId, pid), so two processes of one device on one runId are two rows, as §9.3 needs
 * them to be. Authority is NOT filtered here — `seenEpochs` and `claimHolderOf` apply the §9.3 qualifier themselves.
 */
export function byRunId(fold: Fold, runId: string): (Heartbeat & { arrivalMono: number })[] {
  const out: (Heartbeat & { arrivalMono: number })[] = [];
  const add = (hb: (Heartbeat & { arrivalMono: number }) | undefined): void => {
    if (hb === undefined) return;
    if (out.some((o) => o.deviceId === hb.deviceId && o.pid === hb.pid)) return;
    out.push(hb);
  };
  add(fold.live.get(runId));
  add(fold.gone.get(runId));
  for (const f of fold.forks?.get(runId) ?? []) add(f);
  return out.sort((a, b) => compareClaim(a.claim, b.claim) || compareStamp(a.stamp, b.stamp));
}

/**
 * §3.2 / §9.3: the claim holder for one runId — the record with the highest **QUALIFIED** epoch (mine, or a trust- and
 * hmac-qualified foreign one), or null when the fold holds no qualified record of it. `includeUnverified` is the
 * display opt-in, exactly as on `foreignLive` and `seenEpochs`: a planted beat must never be able to name itself the
 * holder on a path that gates anything (§11 row 51).
 */
export function claimHolderOf(fold: Fold, runId: string, o: { includeUnverified?: boolean } = {}): (Heartbeat & { arrivalMono: number }) | null {
  for (const hb of byRunId(fold, runId)) {
    if (o.includeUnverified !== true && authorityOf(originOf(fold, hb)) === 'unverified') continue;
    return hb;
  }
  return null;
}

/**
 * + review blocker 3 (acks): the devices a SESSION is — or was last — live on, by the fold's own read locations. An ack
 * counts against a pending targeted message only when it came from one of these subtrees (§5.1).
 */
export function sessionDevices(fold: Fold, sessionId: string): { deviceId: string; self: boolean }[] {
  const out = new Map<string, boolean>();
  const consider = (hb: Heartbeat): void => {
    if (hb.sessionId !== sessionId) return;
    const self = originOf(fold, hb).self;
    out.set(hb.deviceId, (out.get(hb.deviceId) ?? false) || self);
  };
  for (const hb of fold.live.values()) consider(hb);
  for (const hb of fold.gone.values()) consider(hb);
  for (const list of fold.forks?.values() ?? []) for (const hb of list) consider(hb);
  return [...out].map(([deviceId, self]) => ({ deviceId, self })).sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
}

/** The origin of one ack — where the FILE was read from (review blocker 3). */
export function ackOrigin(fold: Fold, ack: Pick<Ack, 'deviceId' | 'msgId' | 'by'>): RecordOrigin {
  return fold.origins.get(ackOriginKey(ack.deviceId, ack.msgId, ack.by)) ?? FOREIGN_ORIGIN;
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

/**
 * Every epoch the fold has seen for one runId — the seed of `mintClaim` on a resume, takeover or import.
 *
 * + review major 11 / re-review (5): an UNVERIFIED foreign record does not raise the bar. Without this, one planted beat
 * (or one planted `run.json` epoch) makes every later `/resume` mint above a number nobody owns, and at the ceiling the
 * run becomes unresumable on every device. `includeUnverified` exists for the display path only.
 */
export function seenEpochs(fold: Fold, runId: string, o: { includeUnverified?: boolean } = {}): number[] {
  const out: number[] = [];
  for (const hb of byRunId(fold, runId)) {
    if (o.includeUnverified !== true && authorityOf(originOf(fold, hb)) === 'unverified') continue;
    out.push(hb.claim.epoch);
  }
  return out;
}

/** §6.5: the child runs of a session (their heartbeats carry `parentSessionId`). */
export function childrenOf(fold: Fold, self: SelfIdentity, parentSessionId: string): SessionActivity[] {
  return listSessions(fold, self).filter((a) => a.parentSessionId === parentSessionId);
}

// ── the peer projection the two surfaces share (contract 1.6 item 9 / TUI-DESIGN-4 §7.10; §3.6) ───────────────────────

/**
 * ONE peer projection, so the two surfaces that show peers cannot disagree.
 *
 * Two shapes existed with no stated relationship: `EngineStatus.coordination` (`CoordinationStatus`, twelve fields per
 * peer — what the `⇄` zone, `/who` and `src/session/lock.ts` read) and `SessionHost.peers()` (`PeerView`, four scalars
 * — what `/peers`, the open notice and the peer blocking pane read). Nothing said how one becomes the other, so the
 * `⇄` zone and `/peers` could show different numbers for one fold, and `src/tui/status/lines.ts` had already had to
 * invent a reconciling rule of its own. This function is the relationship, and it is a projection of the SAME array
 * the zone counts.
 *
 * THE COUNTING CONVENTION, because the two shapes do not share it and the first cut of this function got it wrong:
 * `CoordinationStatus.peers` is "one row per peer run that is NOT this run" (§3.6), so `CoordinationStatus.live` is
 * self-EXCLUSIVE; **`PeerView.live` is self-INCLUSIVE** — it is the number of instances in this workspace, this one
 * included, and it is the number `peersText` renders as `<n> here`. Every consumer already reads it that way and
 * their tests pin it: `peersText` is empty at `live <= 1` ("Empty when this is the only instance",
 * `src/tui/status/lines.ts`), `peerOpenNotice` is null at `live <= 1`, and `peerLeaseRows` blocks only on
 * `exclusive && live > 1` (`src/tui/blocking/lines.ts`). So the relationship is
 * `peerViewOf(status).live === status.live + 1`, NOT equality: copying `status.live` through verbatim made one other
 * instance holding an exclusive lease render as nothing in the zone, a null open notice, and a blocking pane that
 * offers `[c] continue` — the exact case all three surfaces exist for.
 *
 * The four fields, and exactly what each means:
 *   · `live`   — live instances in this workspace INCLUDING this one: live peer rows + 1. A peer on THIS device
 *                counts exactly like one on another: two instances in one multiplexer is the common case the surface
 *                exists for (TUI-DESIGN-4 §7.10 edge 6), not a case to filter away. The floor is 1, never 0: this
 *                run is running, so `/peers`'s empty state is `live <= 1 && stale === 0`, not `live === 0`.
 *   · `stale`  — every other ROW: a peer the fold still lists whose heartbeat is no longer live (`gone`, `stale`,
 *                `stale-reused-pid`). Self is never stale, so this one stays a peer-only count, bounded by the
 *                producer's own cap of 16 rows.
 *   · `oldestStartedMsAgo` — how long the longest-running LIVE peer has been running, from `startedMsAgo` on the
 *                row (§3.6, the heartbeat's own `startedAt`). `null` when no live row carries one: a producer that
 *                does not report a start time gets `—` in `/peers` and no parenthetical in the open notice, because
 *                both consumers render this verbatim as a START age and `beatAgeMs` is not one. A live row's beat
 *                age is bounded ABOVE by the honoured heartbeat TTL (`4 × HEARTBEAT_TTL_MS`, `records.ts`), so
 *                substituting it reports an instance that has been working all day as "started 4s ago" — a number
 *                that is not a lower bound on anything. Declining is the only honest answer this projection has.
 *                A stale row is excluded either way: its age measures when a dead instance stopped.
 *   · `exclusive` — a peer lease is holding this step right now (`waiting !== null`, §4.3 step 4). That is the exact
 *                condition `peerLeaseRows` renders as "another jevcode holds this workspace"; a peer merely being
 *                live is never exclusivity.
 */
export function peerViewOf(status: CoordinationStatus): PeerView {
  let livePeers = 0;
  let oldest: number | null = null;
  for (const p of status.peers) {
    if (!p.live) continue;
    livePeers += 1;
    const started = p.startedMsAgo;
    const age = started !== undefined && Number.isFinite(started) ? Math.max(0, Math.floor(started)) : null;
    if (age !== null && (oldest === null || age > oldest)) oldest = age;
  }
  return { live: livePeers + 1, stale: Math.max(0, status.peers.length - livePeers), oldestStartedMsAgo: oldest, exclusive: status.waiting !== null };
}
