/**
 * The ledger (§3.5, §12.0.4 `Ledger`, W1 item 7): paths, `open()` (caller-side, after the first frame — zero I/O before it),
 * the incremental scanner (only changed files are re-parsed, by mtime + size), the fold rebuild, watchers + poll, the mirror,
 * the ledger promise chain with a per-op timeout and errno classification (`⇄ off (<code>)`, one notice per (file, code)),
 * tombstones, `gc()` of our own files only, `foreignLive` / `peerLive`, and the takeover lease. It never throws into a caller:
 * every write failure is bookkeeping (§11 row 13) and never reaches the checkpoint store's `noteDiskError`.
 */
import { basename, dirname, join } from 'node:path';
import { isJsonObject, parseJson } from '../core/json.js';
import { ConfigError } from '../errors.js';
import { authorityOf, compareClaim, forkVerdict, hmacValid, isValidClaim, mintClaim, sameClaim, withHmac, type ForkVerdict } from './claims.js';
import { ackOrigin, buildFold, emptyFold, emptyFoldState, leaseKeysOf, maxStampN, seenEpochs, sessionDevices, sessionTargets, type FoldState, type RecordEntry } from './fold.js';
import type { CoordFs } from './fs.js';
import { DIR_MODE, FILE_MODE, classifyLedgerError, nodeFs, withTimeout } from './fs.js';
import { DEVICE_ID_RE, LABEL_MAX_CHARS, LANE_DIR_RE, RUN_ID_RE, actor8Of, hostKeyOf, buildDeviceRecord, createStampClock, parseDeviceRecord, readCommonsKey, readIgnoredDevices, readMachineRecord, readTrustKeys, readTrusted, writeDeviceRecord, writeTrusted, ignoreDevice as writeIgnoreDevice, unignoreDevice as writeUnignoreDevice, type RandomBytes, type StampClock } from './ids.js';
import { COMMONS_KINDS, DEVICE_FILE, FOLD_KINDS, commonsPaths, coordinationRoot, decodeTargetComponent, deviceClaimFile, deviceClaimsDir, isDeviceIdDir, isTargetDir, leaseRel, parseAckName, parseHeartbeatName, parseLeaseName, parseMessageName, type Commons, type CommonsKind } from './paths.js';
import { CoordinationError, CONTROL_MESSAGE_TTL_MS, LEASE_TTL_MS, MESSAGE_TTL_MS, READ_MAX_BYTES, SYNC_SLACK_SHARED_MS, adoptableStampN, fitsRecordSize, finalizeRecord, parseRecord, sameHost, serializeRecord, type Now, type ParseContext, type ParseRecordResult } from './records.js';
import { ICLOUD_PLACEHOLDER_RE, MIRROR_OFFLINE_NOTICE_MS, createMirror, type Mirror } from './sync-shared-dir.js';
import { createWatcher, nodeTimers, type Timers, type WatchFn, type Watcher } from './watch.js';
import type { Ack, Authority, Claim, DeviceRecord, Fold, FoldChange, GcReport, Heartbeat, IdentityPatch, Lease, Ledger, Message, RecordKind, RecordOrigin, SelfIdentity, Stamp, SyncStatus } from './types.js';

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
  /**
   * the LOCAL store is failing: `⇄ off (<code>)`.
   * + review major 17: a mirror fault never sets this. The two are different failures with different remedies (a full
   * disk vs an unmounted share) and one notice was hiding the other; the mirror's health is `mirror` / `mirrorCode`.
   * Cleared by the first successful read of the same path.
   */
  offline: { code: string; file: string; sinceMono: number } | null;
  mirror: 'off' | 'unknown' | 'online' | 'offline';
  mirrorCode: string | null;
  /** + review major 17: the mirror's own last fault, independent of `offline` */
  mirrorOffline: { code: string; file: string; sinceMono: number } | null;
  /** + review minor 26: the mirror has been offline past `MIRROR_OFFLINE_NOTICE_MS` — the status zone says `⇄ offline` */
  mirrorOfflineNotice: boolean;
  syncLagMs: number | null;
  skipped: number;
  /** the last scan stopped at its time budget */
  partial: boolean;
  /** + review major 19: device subtrees this scan did not walk (also counted into `fold.skipped`) */
  devicesSkipped: number;
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
  /**
   * §3.2 (design revision 4): this machine's `hostKey` = `hostKeyOf(hostname, user, machineId)`. Omitted, it is read
   * from the private `coordination/machine.json` at `open()`; absent there too the reader stays machine-agnostic and
   * `self.hostKey` is undefined (hostKey DENIES same-device, it never grants it, so unknown is the permissive value).
   */
  hostKey?: string;
}

export const LEDGER_OP_TIMEOUT_MS = 5_000;
export const READ_FOLD_BUDGET_MS = 500;
/** §3.1: ended heartbeats and released leases stay ≥ 24 h before our GC removes them */
export const GC_RETENTION_MS = 24 * 3_600_000;
/**
 * + review major 19 / §10.9: the number of device subtrees one scan walks per kind. `trusted-devices.json` devices and
 * our own come first, then the most-recently-touched; the rest are counted into `fold.skipped` and the start of the
 * remainder ROTATES every scan, so no subtree can starve behind a busy neighbour.
 *
 * + re-review (4)(iii): the LEASE scan is exempt. The strict fence has to see every peer that could hold an overlapping
 * path, so `scan('leases')` walks all of them; only the general scan is capped.
 */
export const MAX_DEVICES = 16;
/**
 * §4.5 (design revision 4): the STRICT FENCE does not inherit `MAX_DEVICES` — the 17th subtree holding a live
 * overlapping lease would otherwise be invisible to the one mode that promises a decision. It reads every device's
 * `leases/<keyDir>/` under its own two bounds and, when either is reached first, refuses (`fence:'blind'`) rather than
 * guessing. Ignored devices (§4.6) are excluded from the count, so `sessions gc --device … --i-know-it-is-gone`
 * restores the fence on a junk-filled folder.
 */
export const MAX_FENCE_DEVICES = 256;
export const STRICT_FENCE_MS = 250;
/**
 * §4.6 / §12.0.4 (design revision 5): the bound on the enumeration `gc --device <label>` walks to turn a LABEL into a
 * device id. An id8 resolves by path with no enumeration at all; a label has to read one `device.json` per subtree,
 * and past this the verb refuses `'too-many-devices'` rather than walking a hostile folder.
 */
export const MAX_GC_DEVICES = 1_024;

/** §4.5: what one fence enumeration saw. `complete: false` is `fence:'blind'` at the call site. */
export interface FenceScan {
  complete: boolean;
  scanned: number;
  total: number;
}
/**
 * + review major 10: the parsed-record set is bounded. Over the cap the oldest FOREIGN entries by file mtime are dropped
 * (our own records are never evicted — the GC owns them) and counted into `fold.skipped`.
 */
export const ENTRIES_MAX = 4_096;
/**
 * + review major 9: the ids `scan('acks')` walks, and the ceiling on that set. Every tracked id costs ONE readdir per
 * device subtree per scan, so the real bound is `MAX_DEVICES × TRACKED_ACKS_MAX`; the typical set is the handful of
 * messages still awaiting an ack. The set used to grow for the life of the process.
 */
export const TRACKED_ACKS_MAX = 128;
/**
 * + review major 9: the longest a SENDER keeps walking ack directories for one message. A normal message lives 7 days
 * (§5.1) but nobody waits 7 days for its ack — past this the message is GC'd on expiry, which is the backstop the
 * design already relies on for a broadcast.
 */
export const ACK_TRACK_MAX_MS = 3_600_000;

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
  /** re-scan now; `'leases'` = one readdir of every peer's `leases/<keyDir>/` (§4.5) */
  refresh(scope?: 'all' | 'leases'): Promise<void>;
  /**
   * §4.5 (design revision 4): the strict fence's enumeration — every device subtree's `leases/<keyDir>/`, bounded by
   * `MAX_FENCE_DEVICES` and `STRICT_FENCE_MS`, guaranteed to START after this call (review blocker 1). `complete:false`
   * means a bound was reached before the enumeration finished and the caller must return `fence:'blind'`.
   */
  refreshFence(o?: { maxDevices?: number; budgetMs?: number }): Promise<FenceScan>;
  /**
   * §3.4: a live heartbeat for `runId` read from ANOTHER device's subtree.
   *
   * + review major 7: VERIFIED-ONLY IS THE DEFAULT. The old `verifiedOnly?: boolean` defaulted to false, so every
   * caller that forgot the flag — the exit-2 fork stop among them — accepted a planted beat. The flag is now
   * `includeUnverified`, which a display path opts into explicitly and no stop path can reach by omission.
   */
  foreignLive(runId: string, o?: { includeUnverified?: boolean }): PeerLive | null;
  /** any live heartbeat for `runId` that is not this process (same device: another pid) */
  peerLive(runId: string, o?: { excludePid?: number }): PeerLive | null;
  /** this process's immutable claim (review blocker 3) */
  readonly claim: Claim;
  /**
   * + review blocker 3: the fork decision for `runId` over the IMMUTABLE claims of every record the fold holds. Stable
   * under any arrival order, so both sides of a fork agree; `verified` says whether the verdict may stop the run (§10.3).
   */
  forkVerdict(runId: string): ForkVerdict;
  /**
   * §9.3: `max(epoch seen for runId) + 1` — the epoch a resume / takeover / import must mint.
   * + review major 11: `epochHigh` is the value persisted beside the run (`RunClaimMeta.claimEpochHigh` in `run.json`),
   * so a resume after a mirror gap never re-mints an epoch an earlier incarnation already used. Unverified foreign
   * epochs do not raise the bar (re-review (5)).
   */
  nextEpoch(runId: string, o?: { epochHigh?: number }): number;
  /** §9.3 / §11 row 3: a `takeover` lease carrying a LATER claim than the origin's; awaited */
  takeoverLease(o: { runId: string; sessionId: string; reason60: string; claim?: Claim; epochHigh?: number }): Promise<Lease>;
  /**
   * §9.3 (design revision 4): the claim this device last minted for a run it may have no local dir for, persisted at
   * `devices/<hostKey>/claims/<runId>.json` and read back by the NEXT mint. Without it `sessions unlock --device` on a
   * run with no local `run.json` re-issues the same epoch on the next attempt and `compareClaim` returns 0 for two
   * different processes — the one case the fork rule cannot decide. Local truth: never mirrored, never published.
   */
  readRunClaim(runId: string): Promise<Claim | null>;
  /** §4.6 row 4: local tombstone; the subtree is skipped from the next rebuild */
  ignoreDevice(deviceId: string, label: string): Promise<void>;
  /** + review minor 25: lift a tombstone (`sessions gc --device <label> --undo`) */
  unignoreDevice(deviceId: string): Promise<void>;
  /** + re-review (2): `gc --device` / `ignore` accept a label, a `label#id4`, an id8 or a full device id */
  resolveDeviceRef(ref: string, extra?: readonly string[]): string | null;
  /** every device subtree on disk, bounded by `MAX_GC_DEVICES` — what `gc --device` resolves against (+ re-check (4)) */
  allDeviceIds(): Promise<string[]>;
  /** §10.3 (revision 5): forget a paired device's key; its records fold on, unverified */
  unpairDevice(deviceId: string): Promise<void>;
  /** §9.1 / §9.2 / + re-review (2): what `sessions sync` prints */
  syncStatus(): SyncStatus;
  /** §3.2: rewrite both `device.json` files (the public subset — never the commons key) */
  setDeviceLabel(label: string): Promise<DeviceRecord>;
  /** §9.1: remove our own five subtrees from the mirror; a no-op without one */
  syncDisable(): Promise<{ removed: readonly CommonsKind[] }>;
  /**
   * read acks/<*>/<msgId>/ for this id from now on (send() calls it).
   * + review major 9: the set is BOUNDED — an entry lapses after `ttlMs` (the tracked message's own ttl, 10 min for a
   * control type) and the map is capped at `TRACKED_ACKS_MAX`, oldest first. It used to grow for the life of the process
   * and every scan walked one directory per entry.
   */
  trackAck(msgId: string, ttlMs?: number): void;
  /**
   * §5.1 / review blocker 3: the ack for `msgId` this reader BELIEVES — one read from the subtree of the device the
   * target session is (or was last) live on, authenticated for a foreign device and local-only for one of our own. An
   * ack from anywhere else is a hint, never an answer, and is not returned here.
   */
  believedAck(msgId: string): Ack | null;
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

/** per-scan bounds: the fence uses its own (§4.5), everything else the ledger's defaults. */
interface ScanBounds {
  budgetMs?: number;
  maxDevices?: number;
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
  /**
   * + review minor 24: NOT readonly on the implementation. The claim is minted once per (process, RUN); `parseRecord`
   * binds `claim.runId` to the record's `runId`, so a `setIdentity({ runId })` that left the old claim in place would
   * make every later beat fail its own validator. A runId move re-mints at `max(epoch seen for the NEW runId) + 1`,
   * keeping this process's `pid` and `startedAt` — the incarnation order §9.3 compares is preserved.
   */
  claim: Claim;
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
  /** msgId → the monotonic time the tracking lapses (review major 9) */
  private readonly trackedAcks = new Map<string, number>();
  private ignored = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private watcher: Watcher | null = null;
  private offline: LedgerStatus['offline'] = null;
  private mirrorOffline: LedgerStatus['offline'] = null;
  private skipped = 0;
  private devicesSkipped = 0;
  private partial = false;
  /** the tail of the scan chain: every scan runs after the previous one has settled (review blocker 1) */
  private scanTail: Promise<unknown> = Promise.resolve();
  private scanning: Promise<FoldChange[]> | null = null;
  /** review major 19: rotates the start of the uncapped remainder so no subtree starves */
  private scanRotation = 0;
  /** §4.5: what the last `scope:'leases'` pass enumerated */
  private fence: FenceScan = { complete: true, scanned: 0, total: 0 };
  /** §3.5: bumped by `setIdentity`, so a poll pass that straddles it re-walks with the new root list */
  private pollGeneration = 0;
  /** the last error booked against a FILE, so the chain does not book it a second time against its label */
  private lastNoted: unknown = null;
  /** review minor 26: the newest mirror-copy mtime per foreign device — §9.2's lag for a peer */
  private readonly mirrorMtime = new Map<string, number>();
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
    if (o.hostKey !== undefined) this.self = { ...this.self, hostKey: o.hostKey };
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
            // + re-review (6)(ii): the mirror root must resolve OUTSIDE the coordination root; one symlink there would
            // otherwise make every foreign file read as our own local subtree (`origin.self`) again.
            localRoot: this.root,
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
    const offlineSince = this.mirror?.offlineSinceMono ?? null;
    return {
      offline: this.offline,
      mirror: this.mirror === null ? 'off' : this.mirror.state,
      mirrorCode: this.mirror?.offlineCode ?? null,
      mirrorOffline: this.mirrorOffline,
      mirrorOfflineNotice: offlineSince !== null && this.monotonicNow() - offlineSince >= MIRROR_OFFLINE_NOTICE_MS,
      syncLagMs: this.mirror?.lagMs ?? null,
      skipped: this.fold.skipped,
      partial: this.partial,
      devicesSkipped: this.devicesSkipped,
    };
  }

  /** §9.1 / §9.2 / + re-review (2): the shape `sessions sync` prints, with the mirror's refusal reason. */
  syncStatus(): SyncStatus {
    const m = this.mirror;
    if (m === null) return { mode: 'off', state: 'off', code: null, lagMs: null, pending: 0, offlineForMs: null, refused: null };
    const since = m.offlineSinceMono;
    return {
      mode: 'shared-dir',
      state: m.state,
      code: m.offlineCode,
      lagMs: m.lagMs,
      pending: m.pending,
      offlineForMs: since === null ? null : Math.max(0, this.monotonicNow() - since),
      refused: m.refused,
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
    // §3.2: the machine identifier and the derived `hostKey` live in the PRIVATE `machine.json`, never in `device.json`.
    // Read here, on the `open()` path — asynchronously, once per process, never before the first frame.
    if (this.o.hostKey === undefined) {
      const machine = await readMachineRecord(this.fs, this.root);
      const hostKey = machine?.hostKey ?? (machine === null ? undefined : hostKeyOf(this.self.host, this.self.user, machine.machineId));
      if (hostKey !== undefined) this.self = { ...this.self, hostKey };
    }
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
        onError: (dir, e) => this.noteWatchError(dir, e),
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
  async setIdentity(patch: IdentityPatch): Promise<void> {
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
      const rid = next.runId ?? this.actor8;
      this.stamps = createStampClock(next.deviceId, rid, seed);
      // + review minor 24: the claim is per (process, RUN). `parseRecord` binds `claim.runId` to the record's `runId`,
      // so carrying the old claim onto the new run would make every beat fail its own validator; re-mint above every
      // epoch already seen for the NEW runId, keeping this process's pid and start time.
      this.claim = mintClaim({ deviceId: next.deviceId, runId: rid, pid: this.claim.pid, startedAt: this.claim.startedAt, seenEpochs: seenEpochs(this.fold, rid) });
    }
    this.rebuild();
    this.attachWatchers();
    // §3.5 (design revision 4): ONE bounded walk of the roots this patch made reachable, on the ledger's own chain,
    // before the promise resolves. `fs.watch` never reports what is already there, so without it a `/resume` that
    // gains a `repoKey` would fence against an empty `leases/<keyDir>/` until the 15 s poll — `clear` by ignorance.
    this.pollGeneration += 1;
    if (!this.opened) return;
    const changes = await this.enqueueScan('all');
    this.rebuild();
    for (const c of changes) this.emit(c);
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
    // §3.5 (design revision 4): a `setIdentity` that lands MID-PASS leaves the pass's root list and the new one
    // disagreeing for a tick. The generation counter catches exactly that and re-walks once with the new roots.
    const generation = this.pollGeneration;
    if (this.mirror !== null) await this.mirror.retry();
    let changes = await this.scan('all');
    this.rebuild();
    this.attachWatchers();
    if (this.pollGeneration !== generation && !this.closed) {
      changes = [...changes, ...(await this.enqueueScan('all'))];
      this.rebuild();
    }
    for (const c of changes) this.emit(c);
    this.emit({ kind: 'poll' });
  }

  /**
   * + review blocker 1: `refresh()` guarantees a scan that STARTS AFTER this call. `scan()` coalesces — a second caller
   * joins the running pass and gets `[]` — which is right for a watcher burst and catastrophically wrong for the strict
   * fence: `declare(…, 'strict')` writes its lease and then refreshes, and a scan that had already listed every peer's
   * `leases/<repoKey>/` BEFORE that write answers with a view in which nobody could have seen anybody. Both writers then
   * read `clear` and both hold the paths. The fresh pass is chained behind the in-flight one, never merged into it.
   */
  async refresh(scope: 'all' | 'leases' = 'all'): Promise<void> {
    const changes = await this.enqueueScan(scope);
    this.rebuild();
    for (const c of changes) this.emit(c);
  }

  async refreshFence(o: { maxDevices?: number; budgetMs?: number } = {}): Promise<FenceScan> {
    const changes = await this.enqueueScan('leases', { maxDevices: o.maxDevices ?? MAX_FENCE_DEVICES, budgetMs: o.budgetMs ?? STRICT_FENCE_MS });
    this.rebuild();
    for (const c of changes) this.emit(c);
    return { ...this.fence };
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
      this.clearFault(dir); // + review major 17: the first successful read of a path clears its `⇄ off`
      return names;
    } catch (e) {
      this.dirs.delete(dir);
      const code = classifyLedgerError(e);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') this.noteError(dir, e);
      return null;
    }
  }

  /**
   * Scan every subtree (local, then mirror); returns the fold changes. A watcher burst or a poll tick JOINS a running
   * scan (that is the whole point of the debounce) and gets `[]`; anything that must observe its own write goes through
   * `enqueueScan` (review blocker 1).
   */
  private scan(scope: 'all' | 'leases'): Promise<FoldChange[]> {
    const running = this.scanning;
    if (running !== null) return running.then(() => [], () => []);
    return this.enqueueScan(scope);
  }

  /** One scan, chained strictly behind every scan already queued — so it begins after this call, never before it. */
  private enqueueScan(scope: 'all' | 'leases', o: ScanBounds = {}): Promise<FoldChange[]> {
    const run = this.scanTail.then(
      () => this.scanOnce(scope, o),
      () => this.scanOnce(scope, o),
    );
    this.scanTail = run.then(
      () => undefined,
      () => undefined,
    );
    this.scanning = run;
    const clear = (): void => {
      if (this.scanning === run) this.scanning = null;
    };
    void run.then(clear, clear);
    return run;
  }

  private async scanOnce(scope: 'all' | 'leases', bounds: ScanBounds = {}): Promise<FoldChange[]> {
    const start = this.monotonicNow();
    const changes: FoldChange[] = [];
    const seen = new Set<string>();
    let skipped = 0;
    this.partial = false;
    const budget = bounds.budgetMs ?? this.budgetMs;
    const deviceCap = bounds.maxDevices ?? MAX_DEVICES;
    const fence: FenceScan = { complete: true, scanned: 0, total: 0 };
    const budgetLeft = (): boolean => {
      if (this.monotonicNow() - start <= budget) return true;
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
    // + review major 10: the directories this pass listed to the end. On a PARTIAL scan only their entries may be
    // swept — the rest were simply not reached, and dropping them would flap every peer's liveness at the budget edge.
    const completed = new Set<string>();
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
      completed.add(dir);
    };
    this.scanRotation += 1;
    let devicesSkipped = 0;
    for (const store of stores) {
      for (const kind of kinds) {
        if (!budgetLeft()) break;
        const all = await store.devices(kind);
        // §4.5: the LEASE scan takes `MAX_FENCE_DEVICES` (256 by default, not the 16-subtree fold cap), because a peer
        // beyond the fold's breadth can still hold an overlapping exclusive lease; every other kind takes MAX_DEVICES.
        const cap = kind === 'leases' ? deviceCap : MAX_DEVICES;
        const devices = await this.pickDevices(all, store.paths, kind, cap);
        devicesSkipped += all.length - devices.length;
        if (kind === 'leases') {
          fence.total += all.filter((d) => !this.ignored.has(d)).length;
          if (devices.length < all.length) fence.complete = false;
        }
        for (const deviceId of devices) {
          if (!budgetLeft()) {
            if (kind === 'leases') fence.complete = false;
            break;
          }
          if (this.ignored.has(deviceId) && kind !== 'registry') continue;
          if (kind === 'leases') fence.scanned += 1;
          switch (kind) {
            case 'registry':
              // + review minor 25: an ignored device's BEATS are read too, so `sessions who --all` has rows to show and
              // `unignoreDevice` something to name. `buildFold` keeps them out of every decision path.
              await visit('heartbeat', store.paths.deviceDir('registry', deviceId), deviceId, store.source, (n) => (n === DEVICE_FILE ? deviceId : parseHeartbeatName(n)));
              break;
            case 'leases':
              for (const k of keys) await visit('lease', store.paths.leaseDir(deviceId, k), deviceId, store.source, parseLeaseName);
              break;
            case 'inbox': {
              // OUR OWN outbox is listed in full: every target we ever sent to, because the SENDER owns the GC of those
              // files (§5.1 — a targeted message goes once its target acked). Foreign subtrees are read only for the
              // targets we consume, which is what keeps the fold's inbox bounded.
              const own = store.source === null && deviceId === this.self.deviceId;
              // + review major 13: the on-disk name is the ENCODED target (`@ws-…`); the record carries the colon form
              const dirs = own ? ((await this.listDir(store.paths.deviceDir('inbox', deviceId))) ?? []).filter(isTargetDir).map(decodeTargetComponent).sort() : targets;
              for (const t of dirs) await visit('message', store.paths.outboxDir(deviceId, t), deviceId, store.source, (n) => (parseMessageName(n) === null ? null : n.replace(/\.json$/, '')), t);
              break;
            }
            case 'acks':
              for (const msgId of this.trackedAcks.keys()) await visit('ack', store.paths.ackDir(deviceId, msgId), deviceId, store.source, parseAckName);
              break;
            case 'runs':
              break;
          }
        }
      }
    }
    this.devicesSkipped = devicesSkipped;
    skipped += devicesSkipped;
    if (scope === 'leases') {
      if (this.partial) fence.complete = false;
      this.fence = fence;
    }
    // files no longer listed are gone (GC, a released outbox file, a device that removed its mirror subtree).
    // + review major 10: a PARTIAL scan still prunes — but only inside the directories it listed to the end.
    for (const path of [...this.entries.keys()]) {
      if (seen.has(path)) continue;
      if (this.partial && !completed.has(dirname(path))) continue;
      const e = this.entries.get(path)!;
      if (scope === 'leases' && e.kind !== 'lease') continue;
      if (scope === 'leases' && e.source !== null && this.mirror?.state === 'offline') continue;
      if (e.source !== null && (this.mirror === null || this.mirror.state === 'offline')) continue; // an offline mirror keeps its last records until it returns
      this.entries.delete(path);
      this.sigs.delete(path);
      changes.push(changeOf(e));
    }
    this.skipped = skipped + this.pruneEntries();
    return changes;
  }

  /**
   * + review major 19: the subtrees one scan walks, in priority order — paired devices first, then our own, then the
   * most-recently-touched by directory mtime; the remainder is ROTATED by the scan counter before the cap bites, so a
   * subtree that lost the cut this pass is first in line the next one.
   */
  private async pickDevices(all: readonly string[], paths: Commons, kind: CommonsKind, cap: number): Promise<string[]> {
    if (all.length <= cap) return [...all];
    const head: string[] = [];
    const rest: { deviceId: string; mtimeMs: number }[] = [];
    for (const deviceId of all) {
      if (deviceId === this.self.deviceId || this.trustKeys.has(deviceId)) {
        head.push(deviceId);
        continue;
      }
      let mtimeMs = 0;
      try {
        mtimeMs = (await withTimeout(this.fs.stat(paths.deviceDir(kind, deviceId)), this.opTimeoutMs, `stat ${deviceId}`)).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      rest.push({ deviceId, mtimeMs });
    }
    rest.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.deviceId < b.deviceId ? -1 : 1));
    const slots = Math.max(0, cap - head.length);
    const offset = rest.length === 0 ? 0 : this.scanRotation % rest.length;
    const rotated = [...rest.slice(offset), ...rest.slice(0, offset)];
    return [...head.slice(0, cap), ...rotated.slice(0, slots).map((r) => r.deviceId)];
  }

  /**
   * + review major 10: bound the parsed-record set. Our own records are never evicted (the GC owns them and the fold
   * must always see them); foreign entries go oldest-file-first. Returns how many were dropped, for `fold.skipped`.
   */
  private pruneEntries(): number {
    if (this.entries.size <= ENTRIES_MAX) return 0;
    const evictable = [...this.entries.entries()]
      .filter(([, e]) => !e.origin.self)
      .sort((a, b) => (this.sigs.get(a[0])?.mtimeMs ?? 0) - (this.sigs.get(b[0])?.mtimeMs ?? 0));
    let over = this.entries.size - ENTRIES_MAX;
    let dropped = 0;
    for (const [path] of evictable) {
      if (over <= 0) break;
      this.entries.delete(path);
      this.sigs.delete(path);
      over -= 1;
      dropped += 1;
    }
    return dropped;
  }

  /**
   * + review blockers 5 / 6: the origin of one file, decided from the PATH and the hmac. `self` requires the LOCAL store
   * (`source === null`) AND our own device subtree: a file under our device id in a shared mirror is foreign and unverified.
   */
  private originOf(deviceId: string, source: string | null, record: { hmac?: string; hostKey?: string }, verified = false): RecordOrigin {
    // + re-review (6)(i): `deviceId` is `sha8(host, user)`-derived and COLLIDES on two default-named Macs or cloned VMs
    // sharing one `~/.jevcode`. Each then reads the other's records out of its own local root, and `self` would hand a
    // foreign pid to `isPidAlive` and auto-apply a foreign `pause`. A known machine mismatch is never `self`.
    const self = source === null && deviceId === this.self.deviceId && sameHost(record.hostKey, this.self.hostKey);
    return { self, source, authenticated: self || verified || this.verify(record, deviceId) };
  }

  /** bound: `h.sign` is passed as a callback (the heartbeat builder), so it may not depend on the call site's `this` */
  readonly sign = <T extends object>(record: T): T => withHmac(record, this.commonsKey, { deviceId: this.self.deviceId, hostKey: this.self.hostKey });

  /** + re-review (5): verified against the key of the SUBTREE the file came from, with that device id inside the mac. */
  readonly verify = (record: { hmac?: string }, deviceId: string): boolean => hmacValid(record, this.trustKeys.get(deviceId), deviceId);

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
    this.clearFault(path);
    // + review minor 26: §9.2 for a PEER — how old the newest file we can read from its mirror copy is
    if (source !== null && deviceId !== this.self.deviceId) this.mirrorMtime.set(deviceId, Math.max(this.mirrorMtime.get(deviceId) ?? 0, sig.mtimeMs));
    const parseKind: RecordKind = stem === deviceId && kind === 'heartbeat' ? 'device' : kind;
    const ctx: ParseContext = {
      deviceId,
      ...(target === undefined ? {} : { target }),
      // §4.3: a lease must agree with the `<keyDir>` directory it sits in, or the fence cannot see what it should
      ...(parseKind === 'lease' ? { keyDir: basename(dirname(path)) } : {}),
      // §10.3: the key is found by the PATH's deviceId; `verified` comes back as a fact, never as a gate
      trust: (pathDeviceId: string) => this.trustKeys.get(pathDeviceId) ?? null,
    };
    const parsed = parseRecord(text, parseKind, ctx);
    this.sigs.set(path, sig);
    if (!parsed.ok || !stemMatchesPath(parseKind, parsed, stem)) {
      this.dropEntry(path);
      return 'skipped';
    }
    const entry: RecordEntry = { kind: parseKind, record: parsed.record, deviceId, path, source, origin: this.originOf(deviceId, source, parsed.record as { hmac?: string; hostKey?: string }, parsed.verified) };
    this.entries.set(path, entry);
    return changeOf(entry);
  }

  private dropEntry(path: string): void {
    this.entries.delete(path);
  }

  private rebuild(): void {
    const wall = this.now();
    const foreignSyncLagMs = new Map<string, number>();
    for (const [deviceId, mtimeMs] of this.mirrorMtime) foreignSyncLagMs.set(deviceId, Math.max(0, wall - mtimeMs));
    this.fold = buildFold(this.entries.values(), this.state, {
      deviceId: this.self.deviceId,
      bootAt: this.self.bootAt,
      ...(this.self.hostKey !== undefined ? { hostKey: this.self.hostKey } : {}),
      isPidAlive: this.isPidAlive,
      syncSlackMs: this.o.syncSlackMs ?? SYNC_SLACK_SHARED_MS,
      now: this.clock(),
      targets: sessionTargets(this.self),
      ignoredDevices: this.ignored,
      selfSyncLagMs: this.mirror?.lagMs ?? null,
      foreignSyncLagMs,
      skipped: this.skipped,
    });
    const observed = maxStampN(this.fold);
    // review #35: a hostile `stamp.n` of 1e9 would freeze this clock for good; adopt only a plausible value
    if (adoptableStampN(observed, this.stamps.current().n)) this.stamps.observe(observed);
    this.pruneTrackedAcks();
  }

  /** + review major 9: lapsed ids go, then the map is capped oldest-first (`Map` iterates in insertion order). */
  private pruneTrackedAcks(): void {
    const mono = this.monotonicNow();
    for (const [id, until] of [...this.trackedAcks]) if (until <= mono) this.trackedAcks.delete(id);
    const over = this.trackedAcks.size - TRACKED_ACKS_MAX;
    if (over > 0) for (const id of [...this.trackedAcks.keys()].slice(0, over)) this.trackedAcks.delete(id);
  }

  // ── writes (the ledger chain) ─────────────────────────────────────────────────────────────────────────────────────

  enqueue(label: string, op: () => Promise<void>): Promise<void> {
    // + review major 17: an op that already booked the failure against its own FILE is not booked again against the
    // chain's label — a label is not a path, so `clearFault` could never clear it and `⇄ off` stuck for good.
    const run = this.chain.then(() => withTimeout(op(), this.opTimeoutMs, label)).catch((e: unknown) => {
      if (e !== this.lastNoted) this.noteError(label, e);
    });
    this.chain = run;
    return run;
  }

  /**
   * + review major 14: the I/O is inside `withTimeout(opTimeoutMs)` HERE, not only in `enqueue`. `declare(…, 'strict')`
   * and `send()` await `writeOwn` directly, off the chain, so on a wedged network share (`ESTALE`, an unmounted
   * `sharedDir`, an NFS server that never answers) the step path hung for as long as the kernel took. Every awaited
   * path now fails in 5 s with `ETIMEDOUT` and is bookkeeping, never fatal (§11 row 13).
   */
  async writeOwn(kind: CommonsKind, rel: string, record: object, o: { fsync?: boolean } = {}): Promise<void> {
    const path = join(this.paths.deviceDir(kind, this.self.deviceId), rel);
    const text = serializeRecord(record);
    const fsync = o.fsync ?? true;
    try {
      await withTimeout(
        (async () => {
          await this.fs.mkdir(dirname(path), DIR_MODE);
          await this.fs.writeAtomic(path, text, { fsync, mode: FILE_MODE });
        })(),
        this.opTimeoutMs,
        `writeOwn ${path}`,
      );
    } catch (e) {
      this.noteError(path, e); // booked against the FILE, so the next good write of it clears the fault
      throw e;
    }
    this.clearFault(path);
    this.adoptOwn(kind, path, record, text);
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

  /**
   * Our own record enters the fold set at once (no scan needed); a later scan sees the same content by signature.
   *
   * + review major 16: through the SAME validator a foreign record faces. A record this process writes but cannot parse
   * back (a moved `runId` whose claim was not re-minted, a `ws:`-keyed path component, a stamp at the counter cap) used
   * to be trusted in memory and skipped from disk — the fold then disagreed with the store for the life of the process,
   * which is exactly the state the fence cannot survive. A refusal is one notice and no fold entry; the file stays.
   */
  private adoptOwn(kind: CommonsKind, path: string, record: object, text: string): void {
    if (kind === 'runs') return;
    const recordKind: RecordKind = kind === 'leases' ? 'lease' : kind === 'inbox' ? 'message' : kind === 'acks' ? 'ack' : 'heartbeat';
    const to = (record as { to?: unknown }).to;
    const ctx: ParseContext = recordKind === 'message' && typeof to === 'string' ? { deviceId: this.self.deviceId, target: to } : { deviceId: this.self.deviceId };
    const parsed = parseRecord(text, recordKind, ctx);
    if (!parsed.ok) {
      this.notice('warn', `record-${parsed.reason}`, path, `coordination: our own ${recordKind} did not parse (${parsed.reason}) — not folded`);
      return;
    }
    const r = parsed.record as { stamp?: Stamp };
    if (r.stamp !== undefined) this.stamps.observe(r.stamp);
    this.entries.set(path, { kind: recordKind, record: parsed.record as RecordEntry['record'], deviceId: this.self.deviceId, path, source: null, origin: { self: true, source: null, authenticated: true } });
    this.sigs.delete(path); // force the next scan to take the on-disk signature
    this.rebuild();
  }

  /**
   * + review major 17: LOCAL and MIRROR health are tracked apart. An unmounted `sharedDir` used to set the same
   * `offline` a full local disk does, so `⇄ off (ENOENT)` claimed the ledger was dead while it was writing happily; and
   * once set, nothing ever cleared it. A mirror fault sets `mirrorOffline` only.
   */
  private noteError(file: string, e: unknown): void {
    this.lastNoted = e;
    const code = classifyLedgerError(e);
    const root = this.mirror?.root ?? null;
    const isMirror = root !== null && file.startsWith(root);
    if (code !== 'ENOENT') {
      if (isMirror) this.mirrorOffline ??= { code, file, sinceMono: this.monotonicNow() };
      else this.offline ??= { code, file, sinceMono: this.monotonicNow() };
    }
    this.notice('warn', code, file, `coordination off (${code}) on ${file}`);
  }

  /**
   * + review major 17 (same family): a `fs.watch` refusal is NOT a store failure. `ENOSYS` (a filesystem with no
   * change notification), `EMFILE` / `ENOSPC` (inotify watch exhaustion) and `EPERM` mean that ROOT is poll-only —
   * §3.5's stated fallback — while every read and write still works. Routing it through `noteError` put the ledger in
   * `⇄ off (ENOSYS)` for the life of the process on exactly the filesystems the 15 s poll exists for.
   */
  private noteWatchError(dir: string, e: unknown): void {
    const code = classifyLedgerError(e);
    this.notice('info', `watch-${code}`, dir, `coordination: no change notification on ${dir} (${code}) — polling every 15 s`);
  }

  /** + review major 17: the first successful read or write of a path clears the fault it raised. */
  private clearFault(path: string): void {
    if (this.offline !== null && this.offline.file === path) this.offline = null;
    if (this.mirrorOffline !== null && this.mirrorOffline.file === path) this.mirrorOffline = null;
  }

  /** §11 row 13: one notice per (file, code), then silence. */
  private notice(level: LedgerNotice['level'], code: string, file: string, message: string): void {
    const key = `${file}|${code}`;
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    this.o.onNotice?.({ kind: 'coordination', level, code, file, message });
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

  foreignLive(runId: string, o: { includeUnverified?: boolean } = {}): PeerLive | null {
    for (const hb of this.liveFor(runId)) {
      if (this.originFor(hb).self) continue; // blocker 6: "mine" is the read location, never the record's deviceId
      const peer = this.peerOf(hb);
      // + review major 7: verified is the DEFAULT; a display caller opts into a planted record on purpose
      if (o.includeUnverified !== true && !peer.verified) continue;
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

  nextEpoch(runId: string, o: { epochHigh?: number } = {}): number {
    return mintClaim({ deviceId: this.self.deviceId, runId, pid: this.claim.pid, startedAt: this.claim.startedAt, seenEpochs: this.epochsFor(runId, o.epochHigh) }).epoch;
  }

  /** §9.3: the fold's trust-qualified epochs plus the value persisted beside the run (review major 11). */
  private epochsFor(runId: string, epochHigh?: number): number[] {
    const seen = seenEpochs(this.fold, runId);
    return epochHigh === undefined ? seen : [...seen, epochHigh];
  }

  /** §9.3: the takeover carries a LATER claim than the origin's, so §9.3's fork rule and every later resume see it (blocker 3). */
  /** §9.3: `devices/<hostKey>/claims/<runId>.json` — this device's own record of what it last minted for a run. */
  async readRunClaim(runId: string): Promise<Claim | null> {
    const hostKey = this.self.hostKey;
    if (hostKey === undefined || !RUN_ID_RE.test(runId)) return null;
    try {
      const r = await this.fs.readBounded(deviceClaimFile(this.root, hostKey, runId), 2048);
      if (r.overflow) return null;
      const parsed = parseJson(r.text);
      if (!parsed.ok || !isJsonObject(parsed.value) || parsed.value['v'] !== 1) return null;
      const claim = parsed.value['claim'];
      return isValidClaim(claim) ? claim : null;
    } catch {
      return null;
    }
  }

  private async writeRunClaim(claim: Claim): Promise<void> {
    const hostKey = this.self.hostKey;
    if (hostKey === undefined) return; // no machine identity yet: the fold and `run.json` remain the only history
    try {
      await this.fs.mkdir(deviceClaimsDir(this.root, hostKey), DIR_MODE);
      await this.fs.writeAtomic(deviceClaimFile(this.root, hostKey, claim.runId), `${JSON.stringify({ v: 1, runId: claim.runId, claim, at: new Date(this.now()).toISOString() })}\n`, { fsync: true, mode: FILE_MODE });
    } catch (e) {
      this.noteError(deviceClaimFile(this.root, hostKey, claim.runId), e);
    }
  }

  async takeoverLease(o: { runId: string; sessionId: string; reason60: string; claim?: Claim; epochHigh?: number }): Promise<Lease> {
    const repoKey = this.self.repoKey ?? this.self.wsKey;
    const stamp = this.stamps.issue();
    const nowIso = new Date(this.now()).toISOString();
    const leaseId = `${o.runId}-${stamp.n}`;
    // §9.3: the persisted claim of an earlier takeback on THIS device counts as an epoch already spent
    const persisted = await this.readRunClaim(o.runId);
    const seen = this.epochsFor(o.runId, o.epochHigh);
    if (persisted !== null) seen.push(persisted.epoch);
    const claim = o.claim ?? mintClaim({ deviceId: this.self.deviceId, runId: o.runId, pid: this.claim.pid, startedAt: this.claim.startedAt, seenEpochs: seen });
    // + review minor 21: through `finalizeRecord` (redact → checksum) and the size gate, exactly like every other
    // writer — a takeover built with a raw `withChecksum` skipped redaction and could publish an over-size record.
    const lease: Lease = this.sign(finalizeRecord({
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
    }, this.redact));
    if (!fitsRecordSize('lease', lease)) throw new CoordinationError('io', 'coordination: takeover lease exceeds 8 KiB');
    await this.writeOwn('leases', leaseRel(repoKey, leaseId), lease, { fsync: true });
    await this.writeRunClaim(claim);
    return lease;
  }

  /** §3.2 / blocker 2: `sessions label` — both `device.json` files, the PUBLIC subset only (never `device.key`). */
  async setDeviceLabel(label: string): Promise<DeviceRecord> {
    const clipped = this.redact(label).slice(0, LABEL_MAX_CHARS);
    if (clipped.trim() === '') throw new CoordinationError('label-too-long', 'sessions label: the label cannot be empty');
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
    if (!DEVICE_ID_RE.test(deviceId)) throw new CoordinationError('unknown-device', `ignore: '${deviceId}' is not a device id`);
    // + re-check (4): tombstoning MY OWN subtree would drop my own heartbeats, leases and outbox from my own fold —
    // every peer would keep seeing me while I stopped seeing myself, and `sessions who` would lose the local rows.
    if (deviceId === this.self.deviceId) throw new CoordinationError('self-device', 'ignore: that is this device — a host cannot tombstone its own subtree');
    const list = await writeIgnoreDevice(this.fs, this.root, { deviceId, label, at: new Date(this.now()).toISOString() });
    this.ignored = new Set(list.map((d) => d.deviceId));
    this.rebuild();
  }

  /** + review minor 25: the tombstone lifts and the subtree folds again from the next scan. */
  async unignoreDevice(deviceId: string): Promise<void> {
    if (!DEVICE_ID_RE.test(deviceId)) throw new CoordinationError('unknown-device', `unignore: '${deviceId}' is not a device id`);
    const list = await writeUnignoreDevice(this.fs, this.root, deviceId);
    this.ignored = new Set(list.map((d) => d.deviceId));
    this.rebuild();
  }

  /**
   * + re-review (2): `sessions gc --device <ref>` takes what the user can see — a full device id, an `id8` prefix, a
   * label, or the disambiguated `label#id4` of §3.2. Ambiguous or unknown → null (the caller prints the candidates).
   */
  resolveDeviceRef(ref: string, extra: readonly string[] = []): string | null {
    const t = ref.trim();
    if (t === '') return null;
    if (DEVICE_ID_RE.test(t)) return t;
    // + re-check (4): a subtree beyond `MAX_DEVICES` is not in the fold, so an id8 prefix is matched against the
    // caller's uncapped listing too — otherwise the one verb that FIXES a too-wide folder cannot name what is in it.
    for (const id of extra) if (DEVICE_ID_RE.test(id) && id.startsWith(t)) return id;
    const hash = t.indexOf('#');
    const label = hash === -1 ? t : t.slice(0, hash);
    const id4 = hash === -1 ? null : t.slice(hash + 1);
    const hits = new Set<string>();
    for (const d of this.fold.devices.values()) {
      if (d.deviceId.startsWith(t)) hits.add(d.deviceId);
      if (d.label === label && (id4 === null || d.deviceId.startsWith(id4))) hits.add(d.deviceId);
    }
    return hits.size === 1 ? ([...hits][0] as string) : null;
  }

  believedAck(msgId: string): Ack | null {
    const list = this.fold.acks.get(msgId) ?? [];
    if (list.length === 0) return null;
    // the target is the `to` of OUR OWN outbox copy of the message; without one (a twin that did not send it) the
    // conservative answer is any authenticated ack, never an unverified one.
    let target: string | null = null;
    for (const e of this.ownEntries()) {
      if (e.kind !== 'message') continue;
      const m = e.record as Message;
      if (m.id === msgId) {
        target = m.to;
        break;
      }
    }
    if (target !== null && !target.startsWith('@')) return list.find((a) => this.ackCounts(a, target)) ?? null;
    return list.find((a) => authorityOf(ackOrigin(this.fold, a)) !== 'unverified') ?? null;
  }

  /** + re-check (4): the uncapped listing, so `gc --device` can name a subtree the fold's `MAX_DEVICES` cap left out. */
  async allDeviceIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const kind of FOLD_KINDS) for (const name of (await this.listDir(this.paths.kindRoot(kind))) ?? []) if (isDeviceIdDir(name)) ids.add(name);
    // §12.0.4 (revision 5): bounded — the verb that FIXES a hostile folder may not itself walk an unbounded one
    if (ids.size > MAX_GC_DEVICES) throw new CoordinationError('too-many-devices', `gc --device: ${ids.size} device subtrees is past the ${MAX_GC_DEVICES} this verb enumerates — name the device by its id8`);
    return [...ids].sort();
  }

  /**
   * §10.3 (design revision 5): forget a paired device's key. The subtree keeps folding (that is `ignoreDevice`'s job);
   * what goes is the authority — from the next scan its records are `unverified`, so they can raise a flag and never
   * stop a run or apply a control verb.
   */
  async unpairDevice(deviceId: string): Promise<void> {
    if (!DEVICE_ID_RE.test(deviceId)) throw new CoordinationError('unknown-device', `unpair: '${deviceId}' is not a device id`);
    const paired = await readTrusted(this.fs, this.root);
    const remaining = paired.filter((d) => d.deviceId !== deviceId);
    if (remaining.length === paired.length) throw new CoordinationError('not-paired', `unpair: '${deviceId}' is not a paired device`);
    await writeTrusted(this.fs, this.root, remaining);
    this.trustKeys = await readTrustKeys(this.fs, this.root);
    this.sigs.clear(); // every foreign record must be re-read: its authority has changed
    await this.refresh('all');
  }

  trackAck(msgId: string, ttlMs = CONTROL_MESSAGE_TTL_MS): void {
    this.trackedAcks.set(msgId, this.monotonicNow() + Math.max(0, ttlMs));
    this.pruneTrackedAcks();
  }

  ownEntries(): RecordEntry[] {
    return [...this.entries.values()].filter((e) => e.source === null && e.deviceId === this.self.deviceId);
  }

  /**
   * + review blocker 3: does this ack END a pending targeted message? Only when it came from the SUBTREE of a device
   * the target session is (or was last) live on, and — for a target on THIS machine — only from our own local subtree.
   *
   * Without the test, any file at `acks/<anyDevice>/<msgId>/<targetSessionId>.json` deleted the pending `pause` /
   * `abort` / `steer` before its target ever read it: a silent, unauthenticated cancel of every control message, from
   * any subtree in a shared folder. Pre-pairing (no key for the home device) nothing qualifies and the message goes on
   * expiry only, which for a control type is 10 minutes.
   */
  private ackCounts(a: Ack, target: string): boolean {
    if (!ackIsFrom(a.by, target)) return false;
    const homes = sessionDevices(this.fold, target);
    const home = homes.find((h) => h.deviceId === a.deviceId);
    if (home === undefined) return false;
    const origin = ackOrigin(this.fold, a);
    return home.self ? origin.self : origin.authenticated;
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
            // + review major 15: the sweep `rm -rf`s what this names, so the shape is re-tested HERE, at the point of
            // use, not only where the lease was built — a record that reached the store by any other route is refused.
            if (l.type === 'lane' && l.laneDir !== undefined && LANE_DIR_RE.test(l.laneDir) && l.released === undefined && this.fold.live.get(l.runId) === undefined)
              report.staleLanes.push({ runId: l.runId, laneDir: l.laneDir });
            const closed = l.released !== undefined ? l.released.at : l.expiresAt;
            if (old(closed, retention)) await rm('leases', e.path, 'lease');
            break;
          }
          case 'message': {
            const m = e.record as Message;
            const expired = old(m.expiresAt, 0);
            // §5.1: a BROADCAST goes on expiry only — deleting it on the first ack would hide it from every other session
            const targeted = !m.to.startsWith('@');
            const acked = targeted && (this.fold.acks.get(m.id) ?? []).some((a) => this.ackCounts(a, m.to));
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

/**
 * + review major 8: an ack's `by` is a CONSUMER id (`${sessionId ?? 'tui'}-${actor8}`). A message targeted at
 * `<sessionId>` is answered by any consumer process of that session; the bare run-id form of an older build still counts.
 */
export function ackIsFrom(by: string, sessionId: string): boolean {
  return by === sessionId || by.startsWith(`${sessionId}-`);
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

/**
 * `sessions gc --device <ref> --i-know-it-is-gone` — a LOCAL tombstone; nothing foreign is ever deleted (§4.6 row 4).
 * + re-review (2): `ref` is a device id, an `id8` prefix, a label or `label#id4`; ambiguous or unknown is a `ConfigError`.
 */
export async function ignoreDeviceOn(ledger: Ledger, ref: string, label: string): Promise<void> {
  const h = asHandle(ledger);
  const deviceId = DEVICE_ID_RE.test(ref) ? ref : h.resolveDeviceRef(ref, await h.allDeviceIds());
  if (deviceId === null) throw new CoordinationError('unknown-device', `gc --device: '${ref}' is not a device this host has seen (or names more than one)`);
  return h.ignoreDevice(deviceId, label);
}

/** `sessions gc --device <ref> --undo` — lift the tombstone (review minor 25). */
export async function unignoreDeviceOn(ledger: Ledger, ref: string): Promise<void> {
  const h = asHandle(ledger);
  const deviceId = DEVICE_ID_RE.test(ref) ? ref : h.resolveDeviceRef(ref, await h.allDeviceIds());
  if (deviceId === null) throw new CoordinationError('unknown-device', `gc --device --undo: '${ref}' is not a device this host has seen (or names more than one)`);
  return h.unignoreDevice(deviceId);
}

/** `sessions unpair <device>` — forget a paired key (§10.3, design revision 5). */
export async function unpairDeviceOn(ledger: Ledger, ref: string): Promise<void> {
  const h = asHandle(ledger);
  const deviceId = DEVICE_ID_RE.test(ref) ? ref : h.resolveDeviceRef(ref, await h.allDeviceIds());
  if (deviceId === null) throw new CoordinationError('unknown-device', `unpair: '${ref}' is not a device this host has seen (or names more than one)`);
  return h.unpairDevice(deviceId);
}

/** `sessions sync` — the mirror's mode, state, lag and refusal reason (§9.1 / §9.2). */
export function syncStatus(ledger: Ledger): SyncStatus {
  return asHandle(ledger).syncStatus();
}

/** `sessions sync disable` — remove OUR five subtrees from the mirror (§9.1). */
export function syncDisable(ledger: Ledger): Promise<{ removed: readonly CommonsKind[] }> {
  return asHandle(ledger).syncDisable();
}
