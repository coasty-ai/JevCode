/**
 * The ledger (§3.5, §12.0.4 `Ledger`, W1 item 7): paths, `open()` (caller-side, after the first frame — zero I/O before it),
 * the incremental scanner (only changed files are re-parsed, by mtime + size), the fold rebuild, watchers + poll, the mirror,
 * the ledger promise chain with a per-op timeout and errno classification (`⇄ off (<code>)`, one notice per (file, code)),
 * tombstones, `gc()` of our own files only, `foreignLive` / `peerLive`, and the takeover lease. It never throws into a caller:
 * every write failure is bookkeeping (§11 row 13) and never reaches the checkpoint store's `noteDiskError`.
 */
import { dirname, join } from 'node:path';
import { ConfigError } from '../errors.js';
import { authorityOf, compareClaim, forkVerdict, hmacValid, mintClaim, sameClaim, withHmac, type ForkVerdict } from './claims.js';
import { buildFold, emptyFold, emptyFoldState, leaseKeysOf, maxStampN, seenEpochs, sessionTargets, type FoldState, type RecordEntry } from './fold.js';
import type { CoordFs } from './fs.js';
import { DIR_MODE, FILE_MODE, classifyLedgerError, nodeFs, withTimeout } from './fs.js';
import { DEVICE_ID_RE, LABEL_MAX_CHARS, actor8Of, buildDeviceRecord, createStampClock, parseDeviceRecord, readCommonsKey, readIgnoredDevices, readTrustKeys, writeDeviceRecord, ignoreDevice as writeIgnoreDevice, type RandomBytes, type StampClock } from './ids.js';
import { COMMONS_KINDS, DEVICE_FILE, FOLD_KINDS, commonsPaths, coordinationRoot, isDeviceIdDir, isTargetDir, parseAckName, parseHeartbeatName, parseLeaseName, parseMessageName, type Commons, type CommonsKind } from './paths.js';
import { LEASE_TTL_MS, MESSAGE_TTL_MS, READ_MAX_BYTES, SYNC_SLACK_SHARED_MS, adoptableStampN, parseRecord, serializeRecord, withChecksum, type Now, type ParseContext, type ParseRecordResult } from './records.js';
import { ICLOUD_PLACEHOLDER_RE, createMirror, type Mirror } from './sync-shared-dir.js';
import { createWatcher, nodeTimers, type Timers, type WatchFn, type Watcher } from './watch.js';
import type { Ack, Authority, Claim, DeviceRecord, Fold, FoldChange, GcReport, Heartbeat, IdentityPatch, Lease, Ledger, Message, RecordKind, RecordOrigin, SelfIdentity, Stamp } from './types.js';

export { COORDINATION_DIR, commonsPaths, coordinationRoot } from './paths.js';

/** §11 row 13: one notice per (file, code), then silence. */
export interface LedgerNotice {
  kind: 'coordination';
  level: 'warn' | 'info';
  code: string;
  file: string;
  message: string;
}

export interface LedgerStatus {
  /** the local ledger is failing: `⇄ off (<code>)` */
  offline: { code: string; file: string; sinceMono: number } | null;
  mirror: 'off' | 'unknown' | 'online' | 'offline';
  mirrorCode: string | null;
  syncLagMs: number | null;
  skipped: number;
  /** the last scan stopped at its time budget */
  partial: boolean;
}

export interface OpenLedgerOptions {
  home: string;
  self: SelfIdentity;
  /**
   * + review blocker 3: this process's immutable claim on `self.runId`. Omitted, the ledger mints `epoch 1` from
   * `self.runId` + `pid` at construction — good enough for a reader; a run passes the claim it minted at `createEngine`.
   */
  claim?: Claim;
  pid?: number;
  sharedDir?: string | null;
  now?: () => number;
  monotonicNow?: () => number;
  watch?: WatchFn;
  /** 15_000 */
  pollMs?: number;
  /** 100 */
  debounceMs?: number;
  // injected seams (tests; the engine passes the run's redactor)
  fs?: CoordFs;
  timers?: Timers;
  isPidAlive?: (pid: number) => boolean;
  redact?: (s: string) => string;
  syncSlackMs?: number;
  /** per-op timeout on the ledger chain and the mirror chain (5 s) */
  opTimeoutMs?: number;
  /** a scan stops reading past this (500 ms) */
  budgetMs?: number;
  onNotice?: (n: LedgerNotice) => void;
  random?: RandomBytes;
  /** `readFold`: scan once, no watchers, no poll */
  scanOnly?: boolean;
  /** §10.3: this device's commons key (records are signed with it); read from `coordination/device.key` at `open()` when absent */
  commonsKey?: string | null;
  /** §10.3: verification keys by paired deviceId; read from `trusted-devices.json` at `open()` when absent */
  trustKeys?: ReadonlyMap<string, string>;
}

export const LEDGER_OP_TIMEOUT_MS = 5_000;
export const READ_FOLD_BUDGET_MS = 500;
/** §3.1: ended heartbeats and released leases stay ≥ 24 h before our GC removes them */
export const GC_RETENTION_MS = 24 * 3_600_000;

export interface PeerLive {
  deviceId: string;
  label: string;
  step: number;
  beatAgeMs: number;
  stamp: Stamp;
  /** + review blocker 3: the immutable claim the fork rule compares */
  claim: Claim;
  /** + review blockers 5 / 6: where the record was read and whether its hmac verified */
  authority: Authority;
  /** `authority !== 'unverified'` — ONLY a verified foreign beat may stop a run (§10.3) */
  verified: boolean;
}

/** The full handle `openLedger` returns: the §12.0.4 `Ledger` plus what leases / mailbox / heartbeat need. */
export interface LedgerHandle extends Ledger {
  readonly paths: Commons;
  readonly fs: CoordFs;
  readonly now: () => number;
  readonly monotonicNow: () => number;
  readonly redact: (s: string) => string;
  readonly stamps: StampClock;
  readonly mirror: Mirror | null;
  readonly opened: boolean;
  /** the sender id of a CLI twin (the run id's tail for a run) */
  readonly actor8: string;
  /** the injected timers (`awaitAck`'s timeout, the heartbeat timer) */
  readonly timers: Timers;
  status(): LedgerStatus;
  clock(): Now;
  /** the ledger promise chain: serial, per-op timeout, errno → one notice; the returned promise never rejects */
  enqueue(label: string, op: () => Promise<void>): Promise<void>;
  /** write one of OUR records: local tmp (+fsync) + rename, our fold entry updated at once, then the mirror copy on its chain */
  writeOwn(kind: CommonsKind, relInDevice: string, record: object, o?: { fsync?: boolean }): Promise<void>;
  /** the `'exit'` handler's variant (§3.3 point 6): one bounded synchronous write, no mirror */
  writeOwnSync(kind: CommonsKind, relInDevice: string, record: object): void;
  removeOwn(kind: CommonsKind, relInDevice: string): Promise<void>;
  /** re-scan now; `'leases'` = the strict fence's one readdir of every peer's `leases/<repoKey>/` (§4.5) */
  refresh(scope?: 'all' | 'leases'): Promise<void>;
  /**
   * §3.4: a live heartbeat for `runId` read from ANOTHER device's subtree. `verifiedOnly` (the default for any decision
   * that STOPS a run — review blocker 5) skips records whose hmac does not verify under a paired key, so a planted
   * heartbeat can raise the `⚠ forked` flag and a notice but never exit(2) a run.
   */
  foreignLive(runId: string, o?: { verifiedOnly?: boolean }): PeerLive | null;
  /** any live heartbeat for `runId` that is not this process (same device: another pid) */
  peerLive(runId: string, o?: { excludePid?: number }): PeerLive | null;
  /** this process's immutable claim (review blocker 3) */
  readonly claim: Claim;
  /**
   * + review blocker 3: the fork decision for `runId` over the IMMUTABLE claims of every record the fold holds. Stable
   * under any arrival order, so both sides of a fork agree; `verified` says whether the verdict may stop the run (§10.3).
   */
  forkVerdict(runId: string): ForkVerdict;
  /** §9.3: `max(epoch seen for runId) + 1` — the epoch a resume / takeover / import must mint */
  nextEpoch(runId: string): number;
  /** §9.3 / §11 row 3: a `takeover` lease carrying a LATER claim than the origin's; awaited */
  takeoverLease(o: { runId: string; sessionId: string; reason60: string; claim?: Claim }): Promise<Lease>;
  /** §4.6 row 4: local tombstone; the subtree is skipped from the next rebuild */
  ignoreDevice(deviceId: string, label: string): Promise<void>;
  /** §3.2: rewrite both `device.json` files (the public subset — never the commons key) */
  setDeviceLabel(label: string): Promise<DeviceRecord>;
  /** §9.1: remove our own five subtrees from the mirror; a no-op without one */
  syncDisable(): Promise<{ removed: readonly CommonsKind[] }>;
  /** read acks/<*>/<msgId>/ for this id from now on (send() calls it) */
  trackAck(msgId: string): void;
  /** own files only: ended heartbeats / released leases > 24 h, acked targeted messages, expired broadcasts, old acks */
  gc(o?: { retentionMs?: number }): Promise<GcReport>;
  /** the local records of our own device currently in the fold set (GC and tests) */
  ownEntries(): RecordEntry[];
  /** §10.3: sign one of OUR records with the commons key (a no-op before pairing) */
  sign<T extends object>(record: T): T;
  /** §10.3: does this foreign record verify under the paired key of the subtree it came from? */
  verify(record: { hmac?: string }, deviceId: string): boolean;
}

interface Sig {
  mtimeMs: number;
  size: number;
}

const TMP_RE = /\.tmp-/;

/**
 * The record's own FILE-NAME stem must agree with the path it sits at; the device / target components are checked inside
 * `parseRecord(text, kind, ctx)` (review blocker 6), so a stray copy under another subtree is skipped, never trusted.
 */
function stemMatchesPath(kind: RecordKind, r: ParseRecordResult<RecordKind>, stem: string): boolean {
  if (!r.ok) return false;
  const rec = r.record;
  switch (kind) {
    case 'heartbeat':
      return (rec as Heartbeat).runId === stem;
    case 'lease':
      return (rec as Lease).leaseId === stem;
    case 'message':
      return true; // the name is `<t>-<seq>`, already parsed; `to` is checked against the target dir
    case 'ack':
      return (rec as Ack).by === stem;
    case 'device':
      return true; // the one fixed name in a registry subtree; the device id is the path component
  }
}

class LedgerImpl implements LedgerHandle {
  readonly root: string;
  /** + review blocker 1: mutable behind `setIdentity`; the object handed out is a frozen snapshot per read */
  self: SelfIdentity;
  readonly paths: Commons;
  readonly fs: CoordFs;
  readonly now: () => number;
  readonly monotonicNow: () => number;
  readonly redact: (s: string) => string;
  stamps: StampClock;
  readonly mirror: Mirror | null;
  readonly actor8: string;
  readonly timers: Timers;
  readonly claim: Claim;
  opened = false;
  fold: Fold;
  private commonsKey: string | null = null;
  private trustKeys: ReadonlyMap<string, string> = new Map();

  private readonly o: OpenLedgerOptions;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly opTimeoutMs: number;
  private readonly budgetMs: number;
  private readonly entries = new Map<string, RecordEntry>();
  private readonly sigs = new Map<string, Sig>();
  private readonly state: FoldState = emptyFoldState();
  private readonly subscribers = new Set<(fold: Readonly<Fold>, change: FoldChange) => void>();
  private readonly noticed = new Set<string>();
  private readonly trackedAcks = new Set<string>();
  private ignored = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private watcher: Watcher | null = null;
  private offline: LedgerStatus['offline'] = null;
  private skipped = 0;
  private partial = false;
  private scanning: Promise<void> | null = null;
  private closed = false;

  constructor(o: OpenLedgerOptions) {
    this.o = o;
    this.self = o.self;
    this.root = coordinationRoot(o.home);
    this.paths = commonsPaths(this.root);
    this.fs = o.fs ?? nodeFs;
    this.now = o.now ?? (() => Date.now());
    this.monotonicNow = o.monotonicNow ?? (() => performance.now());
    this.redact = o.redact ?? ((s) => s);
    this.timers = o.timers ?? nodeTimers;
    this.isPidAlive = o.isPidAlive ?? ((pid) => defaultIsPidAlive(pid));
    this.opTimeoutMs = o.opTimeoutMs ?? LEDGER_OP_TIMEOUT_MS;
    this.budgetMs = o.budgetMs ?? READ_FOLD_BUDGET_MS;
    this.actor8 = actor8Of(o.self.runId, o.random);
    this.stamps = createStampClock(o.self.deviceId, o.self.runId ?? this.actor8);
    this.claim = o.claim ?? mintClaim({ deviceId: o.self.deviceId, runId: o.self.runId ?? this.actor8, pid: o.pid ?? process.pid, startedAt: new Date(this.now()).toISOString() });
    this.commonsKey = o.commonsKey ?? null;
    if (o.trustKeys !== undefined) this.trustKeys = o.trustKeys;
    this.fold = emptyFold(this.clock());
    this.mirror =
      o.sharedDir !== undefined && o.sharedDir !== null && o.sharedDir !== ''
        ? createMirror({
            fs: this.fs,
            sharedDir: o.sharedDir,
            deviceId: o.self.deviceId,
            monotonicNow: this.monotonicNow,
            opTimeoutMs: this.opTimeoutMs,
            onState: (state, code) => {
              if (!this.opened) return;
              if (state === 'offline') this.emit({ kind: 'offline', code: code ?? 'EUNKNOWN' });
              else if (state === 'online') this.emit({ kind: 'online' });
            },
          })
        : null;
  }

  clock(): Now {
    return { wallMs: this.now(), monoMs: this.monotonicNow() };
  }

  status(): LedgerStatus {
    return {
      offline: this.offline,
      mirror: this.mirror === null ? 'off' : this.mirror.state,
      mirrorCode: this.mirror?.offlineCode ?? null,
      syncLagMs: this.mirror?.lagMs ?? null,
      skipped: this.fold.skipped,
      partial: this.partial,
    };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────────────────────────

  async open(): Promise<void> {
    if (this.opened) return;
    try {
      await this.fs.mkdir(this.root, DIR_MODE);
      for (const kind of FOLD_KINDS) await this.fs.mkdir(this.paths.deviceDir(kind, this.self.deviceId), DIR_MODE);
    } catch (e) {
      this.noteError(this.root, e);
    }
    this.ignored = new Set((await readIgnoredDevices(this.fs, this.root)).map((d) => d.deviceId));
    // §10.3: our signing key and the paired devices' verification keys — read once; a missing key file is "not paired yet"
    if (this.o.commonsKey === undefined) this.commonsKey = await readCommonsKey(this.fs, this.root);
    if (this.o.trustKeys === undefined) this.trustKeys = await readTrustKeys(this.fs, this.root);
    if (this.mirror !== null) await this.mirror.probe();
    await this.scan('all');
    this.rebuild();
    if (this.o.scanOnly !== true) {
      this.watcher = createWatcher({
        ...(this.o.watch !== undefined ? { watch: this.o.watch } : {}),
        timers: this.timers,
        ...(this.o.debounceMs !== undefined ? { debounceMs: this.o.debounceMs } : {}),
        ...(this.o.pollMs !== undefined ? { pollMs: this.o.pollMs } : {}),
        onChange: () => void this.onChange(),
        onPoll: () => void this.onPoll(),
        onError: (dir, e) => this.noteError(dir, e),
      });
      this.attachWatchers();
      this.watcher.start();
    }
    this.opened = true;
  }

  /**
   * + review blocker 1. Every fact the surface keys on moves during one process, and the watch roots, the fold's inbox
   * targets, the lease directory and the stamp's `runId` are all derived from it. Synchronous and idempotent: the fold is
   * rebuilt at once from the records already in memory (so a message to the new `sessionId` appears without I/O) and the
   * watchers for the newly reachable roots are attached; the next scan picks up their files.
   */
  setIdentity(patch: IdentityPatch): void {
    const next: SelfIdentity = {
      ...this.self,
      ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId } : {}),
      ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
      ...(patch.repoKey !== undefined ? { repoKey: patch.repoKey } : {}),
      ...(patch.remoteKey !== undefined ? { remoteKey: patch.remoteKey } : {}),
      ...(patch.branch !== undefined ? { branch: patch.branch } : {}),
      ...(patch.label !== undefined ? { label: patch.label.slice(0, LABEL_MAX_CHARS) } : {}),
    };
    const runIdMoved = next.runId !== this.self.runId;
    this.self = next;
    // the stamp clock is per RUN: a new runId needs a new tiebreak, seeded above everything this handle has observed
    if (runIdMoved) {
      const seed = this.stamps.current().n;
      this.stamps = createStampClock(next.deviceId, next.runId ?? this.actor8, seed);
    }
    this.rebuild();
    this.attachWatchers();
  }

  subscribe(cb: (fold: Readonly<Fold>, change: FoldChange) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    await this.chain;
    if (this.mirror !== null) await this.mirror.flush();
    this.subscribers.clear();
    this.opened = false;
  }

  private emit(change: FoldChange): void {
    for (const cb of [...this.subscribers]) {
      try {
        cb(this.fold, change);
      } catch {
        /* a subscriber's error never reaches the ledger */
      }
    }
  }

  private async onChange(): Promise<void> {
    if (this.closed) return;
    const changes = await this.scan('all');
    this.rebuild();
    for (const c of changes) this.emit(c);
  }

  private async onPoll(): Promise<void> {
    if (this.closed) return;
    if (this.mirror !== null) await this.mirror.retry();
    const changes = await this.scan('all');
    this.rebuild();
    this.attachWatchers();
    for (const c of changes) this.emit(c);
    this.emit({ kind: 'poll' });
  }

  async refresh(scope: 'all' | 'leases' = 'all'): Promise<void> {
    const changes = await this.scan(scope);
    this.rebuild();
    for (const c of changes) this.emit(c);
  }

  // ── watchers ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private attachWatchers(): void {
    const w = this.watcher;
    if (w === null) return;
    for (const kind of FOLD_KINDS) w.add(this.paths.kindRoot(kind));
    const targets = sessionTargets(this.self);
    const keys = leaseKeysOf(this.self);
    for (const deviceId of this.knownDevices()) {
      w.add(this.paths.deviceDir('registry', deviceId));
      w.add(this.paths.deviceDir('inbox', deviceId));
      w.add(this.paths.deviceDir('acks', deviceId));
      for (const k of keys) if (this.dirExists(this.paths.leaseDir(deviceId, k))) w.add(this.paths.leaseDir(deviceId, k));
      for (const t of targets) if (this.dirExists(this.paths.outboxDir(deviceId, t))) w.add(this.paths.outboxDir(deviceId, t));
    }
  }

  private readonly dirs = new Set<string>();
  private dirExists(dir: string): boolean {
    return this.dirs.has(dir);
  }
  private knownDevices(): string[] {
    const ids = new Set<string>([this.self.deviceId]);
    for (const e of this.entries.values()) if (e.source === null) ids.add(e.deviceId);
    return [...ids].sort();
  }

  // ── scanning ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private async listDir(dir: string): Promise<string[] | null> {
    try {
      const names = await withTimeout(this.fs.readdir(dir), this.opTimeoutMs, `readdir ${dir}`);
      this.dirs.add(dir);
      return names;
    } catch (e) {
      this.dirs.delete(dir);
      const code = classifyLedgerError(e);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') this.noteError(dir, e);
      return null;
    }
  }

  /** Scan every subtree (local, then mirror); returns the fold changes. Serialised: a second call joins the running scan. */
  private scan(scope: 'all' | 'leases'): Promise<FoldChange[]> {
    if (this.scanning !== null) return this.scanning.then(() => []);
    const run = this.scanOnce(scope);
    this.scanning = run.then(
      () => {
        this.scanning = null;
      },
      () => {
        this.scanning = null;
      },
    );
    return run;
  }

  private async scanOnce(scope: 'all' | 'leases'): Promise<FoldChange[]> {
    const start = this.monotonicNow();
    const changes: FoldChange[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    this.partial = false;
    const budgetLeft = (): boolean => {
      if (this.monotonicNow() - start <= this.budgetMs) return true;
      this.partial = true;
      return false;
    };
    const kinds: readonly CommonsKind[] = scope === 'leases' ? ['leases'] : FOLD_KINDS;
    const stores: { paths: Commons; source: string | null; devices: (kind: CommonsKind) => Promise<string[]> }[] = [
      {
        paths: this.paths,
        source: null,
        devices: async (kind) => ((await this.listDir(this.paths.kindRoot(kind))) ?? []).filter(isDeviceIdDir).sort(),
      },
    ];
    if (this.mirror !== null && this.mirror.state !== 'offline') {
      const m = this.mirror;
      stores.push({ paths: m.paths, source: m.root, devices: (kind) => m.listDevices(kind) });
    }
    const targets = [...sessionTargets(this.self)].sort();
    const keys = leaseKeysOf(this.self);
    const visit = async (kind: RecordKind, dir: string, deviceId: string, source: string | null, stemOf: (name: string) => string | null, target?: string): Promise<void> => {
      const names = await this.listDir(dir);
      if (names === null) return;
      for (const name of names.sort()) {
        if (!budgetLeft()) return;
        if (TMP_RE.test(name)) continue;
        // §11 row 5: an iCloud placeholder means the body is not on disk yet — `unknown` for this cycle, not a bad record
        if (ICLOUD_PLACEHOLDER_RE.test(name)) continue;
        const stem = stemOf(name);
        if (stem === null) {
          skipped++;
          continue;
        }
        const path = join(dir, name);
        seen.add(path);
        const r = await this.readEntry(kind, path, deviceId, source, stem, target);
        if (r === 'skipped') skipped++;
        else if (r !== 'unchanged') changes.push(r);
      }
    };
    for (const store of stores) {
      for (const kind of kinds) {
        if (!budgetLeft()) break;
        const devices = await store.devices(kind);
        for (const deviceId of devices) {
          if (!budgetLeft()) break;
          if (this.ignored.has(deviceId) && kind !== 'registry') continue;
          switch (kind) {
            case 'registry':
              await visit(this.ignored.has(deviceId) ? 'device' : 'heartbeat', store.paths.deviceDir('registry', deviceId), deviceId, store.source, (n) => (n === DEVICE_FILE ? deviceId : this.ignored.has(deviceId) ? null : parseHeartbeatName(n)));
              break;
            case 'leases':
              for (const k of keys) await visit('lease', store.paths.leaseDir(deviceId, k), deviceId, store.source, parseLeaseName);
              break;
            case 'inbox': {
              // OUR OWN outbox is listed in full: every target we ever sent to, because the SENDER owns the GC of those
              // files (§5.1 — a targeted message goes once its target acked). Foreign subtrees are read only for the
              // targets we consume, which is what keeps the fold's inbox bounded.
              const own = store.source === null && deviceId === this.self.deviceId;
              const dirs = own ? ((await this.listDir(store.paths.deviceDir('inbox', deviceId))) ?? []).filter(isTargetDir).sort() : targets;
              for (const t of dirs) await visit('message', store.paths.outboxDir(deviceId, t), deviceId, store.source, (n) => (parseMessageName(n) === null ? null : n.replace(/\.json$/, '')), t);
              break;
            }
            case 'acks':
              for (const msgId of this.trackedAcks) await visit('ack', store.paths.ackDir(deviceId, msgId), deviceId, store.source, parseAckName);
              break;
            case 'runs':
              break;
          }
        }
      }
    }
    if (!this.partial) {
      // files no longer listed are gone (GC, a released outbox file, a device that removed its mirror subtree)
      for (const path of [...this.entries.keys()]) {
        if (seen.has(path)) continue;
        const e = this.entries.get(path)!;
        if (scope === 'leases' && e.kind !== 'lease') continue;
        if (scope === 'leases' && e.source !== null && this.mirror?.state === 'offline') continue;
        if (e.source !== null && (this.mirror === null || this.mirror.state === 'offline')) continue; // an offline mirror keeps its last records until it returns
        this.entries.delete(path);
        this.sigs.delete(path);
        changes.push(changeOf(e));
      }
    }
    this.skipped = skipped;
    return changes;
  }

  /**
   * + review blockers 5 / 6: the origin of one file, decided from the PATH and the hmac. `self` requires the LOCAL store
   * (`source === null`) AND our own device subtree: a file under our device id in a shared mirror is foreign and unverified.
   */
  private originOf(deviceId: string, source: string | null, record: { hmac?: string }): RecordOrigin {
    const self = source === null && deviceId === this.self.deviceId;
    return { self, source, authenticated: self || this.verify(record, deviceId) };
  }

  /** bound: `h.sign` is passed as a callback (the heartbeat builder), so it may not depend on the call site's `this` */
  readonly sign = <T extends object>(record: T): T => withHmac(record, this.commonsKey);

  readonly verify = (record: { hmac?: string }, deviceId: string): boolean => hmacValid(record, this.trustKeys.get(deviceId));

  /** Re-parse one file only when its (mtime, size) signature moved. */
  private async readEntry(kind: RecordKind, path: string, deviceId: string, source: string | null, stem: string, target?: string): Promise<FoldChange | 'unchanged' | 'skipped'> {
    let sig: Sig;
    try {
      const s = await withTimeout(this.fs.stat(path), this.opTimeoutMs, `stat ${path}`);
      if (!s.isFile) return 'skipped';
      sig = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return this.entries.has(path) ? 'unchanged' : 'skipped'; // listed but unreadable: `unknown` for this cycle (§3.4)
    }
    const prev = this.sigs.get(path);
    if (prev !== undefined && prev.mtimeMs === sig.mtimeMs && prev.size === sig.size && this.entries.has(path)) return 'unchanged';
    let text: string;
    try {
      const r = await withTimeout(this.fs.readBounded(path, READ_MAX_BYTES), this.opTimeoutMs, `read ${path}`);
      if (r.overflow) {
        this.dropEntry(path);
        this.sigs.set(path, sig);
        return 'skipped';
      }
      text = r.text;
    } catch {
      return this.entries.has(path) ? 'unchanged' : 'skipped';
    }
    const parseKind: RecordKind = stem === deviceId && kind === 'heartbeat' ? 'device' : kind;
    const ctx: ParseContext = target === undefined ? { deviceId } : { deviceId, target };
    const parsed = parseRecord(text, parseKind, ctx);
    this.sigs.set(path, sig);
    if (!parsed.ok || !stemMatchesPath(parseKind, parsed, stem)) {
      this.dropEntry(path);
      return 'skipped';
    }
    const entry: RecordEntry = { kind: parseKind, record: parsed.record, deviceId, path, source, origin: this.originOf(deviceId, source, parsed.record as { hmac?: string }) };
    this.entries.set(path, entry);
    return changeOf(entry);
  }

  private dropEntry(path: string): void {
    this.entries.delete(path);
  }

  private rebuild(): void {
    this.fold = buildFold(this.entries.values(), this.state, {
      deviceId: this.self.deviceId,
      bootAt: this.self.bootAt,
      isPidAlive: this.isPidAlive,
      syncSlackMs: this.o.syncSlackMs ?? SYNC_SLACK_SHARED_MS,
      now: this.clock(),
      targets: sessionTargets(this.self),
      ignoredDevices: this.ignored,
      selfSyncLagMs: this.mirror?.lagMs ?? null,
      skipped: this.skipped,
    });
    const observed = maxStampN(this.fold);
    // review #35: a hostile `stamp.n` of 1e9 would freeze this clock for good; adopt only a plausible value
    if (adoptableStampN(observed, this.stamps.current().n)) this.stamps.observe(observed);
  }

  // ── writes (the ledger chain) ─────────────────────────────────────────────────────────────────────────────────────

  enqueue(label: string, op: () => Promise<void>): Promise<void> {
    const run = this.chain.then(() => withTimeout(op(), this.opTimeoutMs, label)).catch((e: unknown) => this.noteError(label, e));
    this.chain = run;
    return run;
  }

  async writeOwn(kind: CommonsKind, rel: string, record: object, o: { fsync?: boolean } = {}): Promise<void> {
    const path = join(this.paths.deviceDir(kind, this.self.deviceId), rel);
    const text = serializeRecord(record);
    await this.fs.mkdir(dirname(path), DIR_MODE);
    await this.fs.writeAtomic(path, text, { fsync: o.fsync ?? true, mode: FILE_MODE });
    if (this.offline !== null && this.offline.file === path) this.offline = null;
    this.adoptOwn(kind, path, record);
    this.mirror?.copy(kind, rel, text);
  }

  writeOwnSync(kind: CommonsKind, rel: string, record: object): void {
    const path = join(this.paths.deviceDir(kind, this.self.deviceId), rel);
    this.fs.mkdirSync(dirname(path), DIR_MODE);
    this.fs.writeAtomicSync(path, serializeRecord(record), { fsync: false, mode: FILE_MODE });
  }

  async removeOwn(kind: CommonsKind, rel: string): Promise<void> {
    const path = join(this.paths.deviceDir(kind, this.self.deviceId), rel);
    await this.fs.unlink(path).catch((e: unknown) => {
      if (classifyLedgerError(e) !== 'ENOENT') throw e;
    });
    this.entries.delete(path);
    this.sigs.delete(path);
    this.mirror?.remove(kind, rel);
  }

  /** Our own record enters the fold set at once (no scan needed); a later scan sees the same content by signature. */
  private adoptOwn(kind: CommonsKind, path: string, record: object): void {
    const recordKind: RecordKind = kind === 'registry' ? 'heartbeat' : kind === 'leases' ? 'lease' : kind === 'inbox' ? 'message' : kind === 'acks' ? 'ack' : 'heartbeat';
    if (kind === 'runs') return;
    const r = record as { stamp?: Stamp };
    if (r.stamp !== undefined) this.stamps.observe(r.stamp);
    this.entries.set(path, { kind: recordKind, record: record as RecordEntry['record'], deviceId: this.self.deviceId, path, source: null, origin: { self: true, source: null, authenticated: true } });
    this.sigs.delete(path); // force the next scan to take the on-disk signature
    this.rebuild();
  }

  private noteError(file: string, e: unknown): void {
    const code = classifyLedgerError(e);
    if (this.offline === null && code !== 'ENOENT') this.offline = { code, file, sinceMono: this.monotonicNow() };
    const key = `${file}|${code}`;
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    this.o.onNotice?.({ kind: 'coordination', level: 'warn', code, file, message: `coordination off (${code}) on ${file}` });
  }

  // ── reads over the fold ───────────────────────────────────────────────────────────────────────────────────────────

  private originFor(hb: Pick<Heartbeat, 'deviceId' | 'runId'>): RecordOrigin {
    return this.fold.origins.get(`${hb.deviceId}/${hb.runId}`) ?? { self: false, source: null, authenticated: false };
  }

  private peerOf(hb: Heartbeat): PeerLive {
    const beatAt = Date.parse(hb.beatAt);
    const authority = authorityOf(this.originFor(hb));
    return {
      deviceId: hb.deviceId,
      label: hb.label,
      step: hb.step,
      beatAgeMs: Number.isFinite(beatAt) ? Math.max(0, this.now() - beatAt) : 0,
      stamp: hb.stamp,
      claim: hb.claim,
      authority,
      verified: authority !== 'unverified',
    };
  }

  /** every live record for `runId`, holder (lowest claim) first */
  private liveFor(runId: string): (Heartbeat & { arrivalMono: number })[] {
    const out: (Heartbeat & { arrivalMono: number })[] = [];
    const live = this.fold.live.get(runId);
    if (live !== undefined) out.push(live);
    for (const f of this.fold.forks?.get(runId) ?? []) if (!out.some((o) => o.deviceId === f.deviceId && o.pid === f.pid)) out.push(f);
    return out.sort((a, b) => compareClaim(a.claim, b.claim));
  }

  foreignLive(runId: string, o: { verifiedOnly?: boolean } = {}): PeerLive | null {
    for (const hb of this.liveFor(runId)) {
      if (this.originFor(hb).self) continue; // blocker 6: "mine" is the read location, never the record's deviceId
      const peer = this.peerOf(hb);
      if (o.verifiedOnly === true && !peer.verified) continue;
      return peer;
    }
    return null;
  }

  peerLive(runId: string, o: { excludePid?: number } = {}): PeerLive | null {
    for (const hb of this.liveFor(runId)) {
      if (this.originFor(hb).self && o.excludePid !== undefined && hb.pid === o.excludePid) continue;
      return this.peerOf(hb);
    }
    return null;
  }

  forkVerdict(runId: string): ForkVerdict {
    const others: { claim: Claim; authority: Authority }[] = [];
    for (const hb of this.liveFor(runId)) {
      const origin = this.originFor(hb);
      // my own record: same local subtree AND the same process (claim identity, or the pid the claim was minted with)
      if (origin.self && (sameClaim(hb.claim, this.claim) || hb.pid === this.claim.pid)) continue;
      others.push({ claim: hb.claim, authority: authorityOf(origin) });
    }
    return forkVerdict(this.claim, others);
  }

  nextEpoch(runId: string): number {
    return mintClaim({ deviceId: this.self.deviceId, runId, pid: this.claim.pid, startedAt: this.claim.startedAt, seenEpochs: seenEpochs(this.fold, runId) }).epoch;
  }

  /** §9.3: the takeover carries a LATER claim than the origin's, so §9.3's fork rule and every later resume see it (blocker 3). */
  async takeoverLease(o: { runId: string; sessionId: string; reason60: string; claim?: Claim }): Promise<Lease> {
    const repoKey = this.self.repoKey ?? this.self.wsKey;
    const stamp = this.stamps.issue();
    const nowIso = new Date(this.now()).toISOString();
    const leaseId = `${o.runId}-${stamp.n}`;
    const claim =
      o.claim ?? mintClaim({ deviceId: this.self.deviceId, runId: o.runId, pid: this.claim.pid, startedAt: this.claim.startedAt, seenEpochs: seenEpochs(this.fold, o.runId) });
    const lease: Lease = this.sign(withChecksum({
      v: 1,
      kind: 'lease',
      leaseId,
      runId: o.runId,
      sessionId: o.sessionId,
      deviceId: this.self.deviceId,
      label: this.self.label,
      repoKey,
      remoteKey: this.self.remoteKey,
      wsKey: this.self.wsKey,
      branch: this.self.branch,
      head: null,
      type: 'takeover',
      paths: [],
      truncated: false,
      reason60: this.redact(o.reason60).slice(0, 60),
      step: 0,
      stage: 'coordinate',
      stamp,
      issuedAt: nowIso,
      expiresAt: new Date(this.now() + LEASE_TTL_MS).toISOString(),
      renewedAt: nowIso,
      claim,
      checksum: '',
    }));
    await this.writeOwn('leases', join(repoKey, `${leaseId}.json`), lease, { fsync: true });
    return lease;
  }

  /** §3.2 / blocker 2: `sessions label` — both `device.json` files, the PUBLIC subset only (never `device.key`). */
  async setDeviceLabel(label: string): Promise<DeviceRecord> {
    const clipped = this.redact(label).slice(0, LABEL_MAX_CHARS);
    if (clipped.trim() === '') throw new ConfigError('sessions label: the label cannot be empty', { setting: 'coordination' });
    let existing: DeviceRecord | null = null;
    try {
      const r = await this.fs.readBounded(this.paths.deviceFile, 2048);
      if (!r.overflow) existing = parseDeviceRecord(r.text);
    } catch {
      existing = null;
    }
    const nowIso = new Date(this.now()).toISOString();
    const rec = buildDeviceRecord({
      deviceId: this.self.deviceId,
      label: clipped,
      host: existing?.host ?? this.self.host,
      user: existing?.user ?? this.self.user,
      jevcode: existing?.jevcode ?? '',
      createdAt: existing?.createdAt ?? nowIso,
      syncMode: existing?.syncMode ?? (this.mirror === null ? 'off' : 'shared-dir'),
    });
    await writeDeviceRecord(this.fs, this.root, rec);
    this.self = { ...this.self, label: clipped };
    await this.refresh('all');
    return rec;
  }

  /** §9.1 / blocker 2: `sessions sync disable` — remove OUR five subtrees from the mirror; nothing foreign is ever touched. */
  async syncDisable(): Promise<{ removed: readonly CommonsKind[] }> {
    if (this.mirror === null) return { removed: [] };
    await this.mirror.disable();
    return { removed: COMMONS_KINDS };
  }

  async ignoreDevice(deviceId: string, label: string): Promise<void> {
    if (!DEVICE_ID_RE.test(deviceId)) throw new ConfigError(`ignore: '${deviceId}' is not a device id`, { setting: 'coordination' });
    const list = await writeIgnoreDevice(this.fs, this.root, { deviceId, label, at: new Date(this.now()).toISOString() });
    this.ignored = new Set(list.map((d) => d.deviceId));
    this.rebuild();
  }

  trackAck(msgId: string): void {
    this.trackedAcks.add(msgId);
  }

  ownEntries(): RecordEntry[] {
    return [...this.entries.values()].filter((e) => e.source === null && e.deviceId === this.self.deviceId);
  }

  /**
   * §4.6 / blocker 2: OUR OWN files only — ended heartbeats and closed leases past the retention, targeted messages whose
   * target acked, expired broadcasts, old acks. Nothing foreign is ever deleted (in `shared-dir` mode there is no local copy
   * to remove and a foreign delete is a second writer the sync client may resurrect). Reports the stale lane dirs it found
   * so the caller's sweep can prune them — the ledger never removes a workspace path itself.
   */
  async gc(o: { retentionMs?: number } = {}): Promise<GcReport> {
    const wall = this.now();
    const retention = o.retentionMs ?? GC_RETENTION_MS;
    const report: GcReport = { removed: 0, byKind: { heartbeat: 0, lease: 0, message: 0, ack: 0 }, staleLanes: [], failed: [] };
    const rm = async (kind: CommonsKind, path: string, counted: keyof GcReport['byKind']): Promise<void> => {
      const rel = path.slice(this.paths.deviceDir(kind, this.self.deviceId).length + 1);
      await this.removeOwn(kind, rel);
      report.removed++;
      report.byKind[counted]++;
    };
    const old = (iso: string, ttl: number): boolean => {
      const t = Date.parse(iso);
      return Number.isFinite(t) && wall - t > ttl;
    };
    for (const e of this.ownEntries()) {
      try {
        switch (e.kind) {
          case 'heartbeat': {
            const hb = e.record as Heartbeat;
            if (hb.phase === 'ended' && old(hb.beatAt, retention)) await rm('registry', e.path, 'heartbeat');
            break;
          }
          case 'lease': {
            const l = e.record as Lease;
            // §6.2 (a): a lane lease of a run that is no longer live names a lane dir the sweep may prune
            if (l.type === 'lane' && l.laneDir !== undefined && l.released === undefined && this.fold.live.get(l.runId) === undefined) report.staleLanes.push({ runId: l.runId, laneDir: l.laneDir });
            const closed = l.released !== undefined ? l.released.at : l.expiresAt;
            if (old(closed, retention)) await rm('leases', e.path, 'lease');
            break;
          }
          case 'message': {
            const m = e.record as Message;
            const expired = old(m.expiresAt, 0);
            // §5.1: a BROADCAST goes on expiry only — deleting it on the first ack would hide it from every other session
            const targeted = !m.to.startsWith('@');
            const acked = targeted && (this.fold.acks.get(m.id) ?? []).some((a) => a.by === m.to);
            if (expired || acked) await rm('inbox', e.path, 'message');
            break;
          }
          case 'ack': {
            const a = e.record as Ack;
            if (old(a.at, MESSAGE_TTL_MS)) await rm('acks', e.path, 'ack');
            break;
          }
          case 'device':
            break;
        }
      } catch (err) {
        report.failed.push({ path: e.path, code: classifyLedgerError(err) });
        this.noteError(e.path, err);
      }
    }
    this.rebuild();
    return report;
  }
}

function changeOf(e: RecordEntry): FoldChange {
  switch (e.kind) {
    case 'heartbeat':
      return { kind: 'heartbeat', deviceId: e.deviceId, id: (e.record as Heartbeat).runId };
    case 'lease':
      return { kind: 'lease', deviceId: e.deviceId, id: (e.record as Lease).leaseId };
    case 'message':
      return { kind: 'message', deviceId: e.deviceId, id: (e.record as Message).id };
    case 'ack':
      return { kind: 'ack', deviceId: e.deviceId, id: (e.record as Ack).msgId };
    case 'device':
      return { kind: 'device', deviceId: e.deviceId, id: e.deviceId };
  }
}

/** `process.kill(pid, 0)`: alive on success or EPERM (the `lock.ts:27-35` rule, restated so this module imports nothing from session/). */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return classifyLedgerError(e) === 'EPERM';
  }
}

/** §12.0.4: the ledger handle; created by the caller and opened after `renderer.firstFrame()` — the constructor does no I/O. */
export function openLedger(o: OpenLedgerOptions): LedgerHandle {
  return new LedgerImpl(o);
}

/** A `Ledger` passed to declare / send / ack must be one `openLedger` returned (TUI fakes stop here with a clear error). */
export function asHandle(ledger: Ledger): LedgerHandle {
  if (ledger instanceof LedgerImpl) return ledger;
  throw new ConfigError('coordination: this Ledger was not created by openLedger()', { setting: 'coordination' });
}

/** one bounded read (default ≤ 500 ms) of every subtree: the plain / headless `peerLive` fold (§3.4), `sessions who`, the resume card */
export async function readFold(o: { home: string; self: SelfIdentity; sharedDir?: string | null; budgetMs?: number; now?: () => number; monotonicNow?: () => number; fs?: CoordFs; isPidAlive?: (pid: number) => boolean; syncSlackMs?: number }): Promise<Fold> {
  const ledger = new LedgerImpl({ ...o, scanOnly: true });
  await ledger.open();
  const fold = ledger.fold;
  await ledger.close();
  return fold;
}

/** The kinds `sessions sync disable` removes from the mirror (re-exported for the CLI's text). */
export const MIRRORED_KINDS = COMMONS_KINDS;

// ── the write verbs the product surface owns (+ review blocker 2) ─────────────────────────────────────────────────────
//
// §12.0.4's facade exposed only `open/subscribe/close`, yet W1 item 15 / W2 item 22 / W3 item 31 assign `sessions gc`,
// `sessions unlock --device`, `sessions label`, `sessions sync disable` and `sessions gc --device` to the TUI. These are
// the exact signatures the surface calls; each is a thin wrapper over the handle, so the one-owner rule is unbroken:
// `src/coordination/**` is still the only writer of `~/.jevcode/coordination/**`.

/** `sessions gc [--lanes]` — our own files only; the report names the stale lane dirs for the caller's sweep. */
export function gc(ledger: Ledger, o?: { retentionMs?: number }): Promise<GcReport> {
  return asHandle(ledger).gc(o ?? {});
}

/** `sessions unlock <id> --device <label>` — a `takeover` lease carrying a LATER claim than the origin's (§9.3). */
export function writeTakeoverLease(ledger: Ledger, o: { runId: string; sessionId?: string; reason60?: string; claim?: Claim }): Promise<Lease> {
  const h = asHandle(ledger);
  return h.takeoverLease({
    runId: o.runId,
    sessionId: o.sessionId ?? o.runId,
    reason60: o.reason60 ?? 'sessions unlock --device',
    ...(o.claim !== undefined ? { claim: o.claim } : {}),
  });
}

/** `sessions label "mbp"` — both `device.json` files, the public subset only (§3.2). */
export function setDeviceLabel(ledger: Ledger, label: string): Promise<DeviceRecord> {
  return asHandle(ledger).setDeviceLabel(label);
}

/** `sessions gc --device <label> --i-know-it-is-gone` — a LOCAL tombstone; nothing foreign is ever deleted (§4.6 row 4). */
export function ignoreDeviceOn(ledger: Ledger, deviceId: string, label: string): Promise<void> {
  return asHandle(ledger).ignoreDevice(deviceId, label);
}

/** `sessions sync disable` — remove OUR five subtrees from the mirror (§9.1). */
export function syncDisable(ledger: Ledger): Promise<{ removed: readonly CommonsKind[] }> {
  return asHandle(ledger).syncDisable();
}
