/**
 * The coordination facade (§12.0.4): the import path for every consumer of the coordination plane.
 *
 * WHO IMPORTS IT TODAY, as built rather than as planned: the engine imports it through `src/loop/coordination.ts`;
 * `src/session/**`, `src/cli/**` and `src/tui/**` have no importer yet. The header used to call this "the ONLY
 * import path for `src/session/**`, `src/cli/**`, `src/tui/**` and the engine", which read as a description of the
 * tree and was a plan: none of those three directories imports this file at all, so `/peers` still answers `the peer
 * registry is not available in this build` and nothing sets `EngineOptions.coordination`.
 *
 * THE FIRST SENTENCE IS THE TEST'S INPUT, not a comment beside it. `test/unit/coordination/facade.test.ts` parses
 * the directory list out of it and walks exactly the directories it names, so the day the TUI wires the facade up
 * you edit the sentence and the test follows — it is not a tripwire that fires on a correctly-documented importer,
 * which is what the earlier version of this paragraph wrongly claimed it was not. The walk resolves each relative
 * specifier instead of grepping for a path string, so a doc comment naming this file is not an importer and
 * `from '../coordination'` (extensionless) is.
 *
 * Re-exports every §12.0 type (declared in `./types.ts` until they move to `core/types.ts` after the round-3 hash) and the
 * API exactly as built: identity (`ids.ts`), this boot's identity (`boot.ts`), records (`records.ts`), the fold
 * (`fold.ts`), the ledger (`ledger.ts`, the watcher behind `Ledger.subscribe`), leases, the mailbox, the heartbeat
 * writer, sub-work + the bench lock, the shared-dir mirror — plus `openCoordination()` at the foot of this file, the
 * one entry point that composes them, so a consumer never assembles a `SelfIdentity` by hand.
 *
 * Nothing here imports `src/session/**`, `src/cli/**`, `src/tui/**` or `src/config/**` (§12.0.1 rule 1).
 */

import { hostname as osHostname, uptime as osUptime, userInfo as osUserInfo } from 'node:os';
import { bootIdOf, type BootProbe } from './boot.js';
import { nodeFs, type CoordFs } from './fs.js';
import { deviceIdentity, readRepoKeyCache, repoKeyOf, wsKeyOf, writeRepoKeyCache, type DeviceIdentityResult, type RepoFacts, type RepoKeys } from './ids.js';
import { openLedger, type LedgerHandle, type OpenLedgerOptions } from './ledger.js';
import { CoordinationError } from './records.js';
import { commonsPaths, coordinationRoot } from './paths.js';
import type { DeviceRecord, SelfIdentity } from './types.js';

/**
 * contract types (§12.0.4 shapes, structurally identical; see ./types.ts header for the `+` additions).
 *
 * ONE NAME PER CONCEPT, and the one a consumer wants is the default: **`Ledger` is what `openLedger()` returns** (the
 * ~50-member writer's handle, `LedgerHandle` in `ledger.ts`, what `EngineOptions.coordination.ledger` carries and
 * what `openCoordination()` hands back). The narrow 7-member reader's base is exported beside it as **`LedgerBase`**
 * and is what every write verb's parameter is typed as inside the module. Both names are below, in the `ledger.ts`
 * block. Type against `Ledger` unless you hold a reader and nothing else; a handle is a `LedgerBase` too, never the
 * other way round, and `asHandle()`'s runtime throw is the error a consumer used to meet for choosing wrong.
 */
export { HOLDING_LEASE_TYPES } from './types.js';
export type {
  Ack,
  AckOutcome,
  AnyRecord,
  Authority,
  Claim,
  ClaimsProjection,
  CoordStageName,
  CoordinationFacts,
  DeclaredFact,
  DeviceRecord,
  FenceYield,
  Fold,
  FoldChange,
  GcReport,
  Heartbeat,
  IdentityPatch,
  Lease,
  LeaseCheck,
  LeaseConflict,
  LeaseHandle,
  LeaseIntent,
  LeaseOutcome,
  Liveness,
  LivenessEnv,
  LivenessVerdict,
  Message,
  MessageType,
  PausePoint,
  PausePointReason,
  PublicMessage,
  PurgeReport,
  RecordKind,
  RecordOf,
  RecordOrigin,
  RunClaimMeta,
  RunPhase,
  SelfIdentity,
  SessionActivity,
  Stamp,
  LeaseSnapshot,
  StrictDeclare,
  SubworkEntry,
  SyncStatus,
  WorktreeInfo,
  WorktreeRecord,
} from './types.js';

// claims.ts — the immutable fork fence and record authenticity (review blockers 3, 5, 6)
export {
  CLAIMS_MAX,
  COMMONS_KEY_BYTES,
  COMMONS_KEY_RE,
  EPOCH_MAX,
  FIRST_EPOCH,
  MAX_CLAIMS_PER_RUN,
  MAX_CLAIM_EPOCH,
  FOREIGN_ORIGIN,
  SELF_ORIGIN,
  authorityOf,
  canMintAbove,
  capClaims,
  claimRefusal,
  forceTakebackEpoch,
  forceTakebackPlan,
  ordinaryMintEpoch,
  claimHolder,
  compareClaim,
  forkVerdict,
  highEpoch,
  hmacOf,
  hmacValid,
  isValidClaim,
  mintClaim,
  qualifiedEpochs,
  sameClaim,
  withHmac,
} from './claims.js';
export type { ForkRole, ForkVerdict, HmacWriter } from './claims.js';

// ids.ts — identity facts and validators (§3.1, §3.2)
export {
  ACTOR8_RE,
  BRANCH_MAX_CHARS,
  BROADCAST_ALL,
  CONSUMER_ID_RE,
  DEVICE_ID_RE,
  DEVICE_KEY_FILE,
  LABEL_MAX_CHARS,
  LANE_DIR_RE,
  LEASE_ID_RE,
  LEASE_PATHS_MAX,
  MACHINE_FILE,
  HOST_KEY_RE,
  MSG_ID_RE,
  MSG_T_RE,
  OID_RE,
  REL_PATH_MAX_CHARS,
  REPO_KEY_RE,
  RUN_ID_RE,
  SEQ_RE,
  SESSION_ID_RE,
  SLUG_RE,
  TOUCHED_RECENT_MAX,
  TRUSTED_FILE,
  actor8Of,
  adoptNewDevice,
  buildDeviceRecord,
  createStampClock,
  deviceIdentity,
  ignoreDevice,
  isValidBranch,
  isValidRelPath,
  isValidTarget,
  labelFor,
  hostKeyOf,
  mintActor8,
  mintCommonsKey,
  mintBase32,
  mintDeviceId,
  normaliseOriginUrl,
  parseDeviceRecord,
  probeCaseInsensitive,
  readCommonsKey,
  readIgnoredDevices,
  readMachineRecord,
  readRepoKeyCache,
  readTrustKeys,
  readTrusted,
  repoKeyCachePath,
  repoKeyOf,
  sameRepo,
  trustDevice,
  unignoreDevice,
  writeCommonsKey,
  writeMachineRecord,
  writeDeviceRecord,
  writeRepoKeyCache,
  writeTrusted,
  wsKeyOf,
} from './ids.js';
export type { DeviceIdentityOptions, DeviceIdentityResult, DeviceIdentityStatus, IgnoredDevice, MachineRecord, RandomBytes, RepoFacts, RepoKeyCacheEntry, RepoKeys, StampClock, TrustedDevice } from './ids.js';

// boot.ts — this boot's identity (§3.2, §3.4): the one producer of `SelfIdentity.bootId` in the tree
export { BOOT_ID_DEADLINE_MS, BOOT_ID_MAX_CHARS, BOOT_ID_PATH_LINUX, BOOT_ID_SYSCTL_ARGS, BOOT_ID_SYSCTL_CMD, bootIdOf, nodeBootProbe, normaliseBootId } from './boot.js';
export type { BootIdOptions, BootProbe } from './boot.js';

// records.ts — schemas, parse, checksum, liveness, overlap (§3.3, §3.4, §4.3)
export {
  CONTROL_MESSAGE_TTL_MS,
  CONTROL_MESSAGE_TYPES,
  GONE_KEEP_MS,
  CLAIM_IMPORTS_MAX,
  HEARTBEAT_MS,
  HEARTBEAT_TTL_MS,
  LEASE_TTL_MS,
  MESSAGE_TTL_MS,
  READ_MAX_BYTES,
  HONOURED_TTL_MAX_MS,
  RECORD_MAX_BYTES,
  RECORD_TTL_MAX_MS,
  SKEW_MS,
  SYNC_SLACK_GIT_MS,
  SYNC_SLACK_SHARED_MS,
  checksumOf,
  CoordinationError,
  compareStamp,
  coordinationCodeOf,
  DEVICE_ID8_CHARS,
  finalizeRecord,
  fitsRecordSize,
  honouredTtlMs,
  isAck,
  isClaimsProjection,
  isDeviceRecord,
  isHeartbeat,
  isLease,
  isLive,
  isMessage,
  lockReplaceVerdict,
  oneLine,
  overlap,
  parseRecord,
  pathsOverlap,
  publicMessage,
  recordBytes,
  recordKindOf,
  redactRecord,
  sameBoot,
  sameHost,
  serializeRecord,
  withChecksum,
  COUNTER_MAX,
  STAMP_ADOPT_CEILING,
  STAMP_ADOPT_MARGIN,
  STAMP_ADOPT_MAX_DELTA,
  adoptableStampN,
} from './records.js';
export type { CoordinationErrorCode, LockReplace, Now, OverlapOptions, ParseContext, ParseFailure, ParseRecordResult, PeerLiveFacts, RunLockFacts } from './records.js';
export { canonicalText, checksumValid } from './checksum.js';

// fold.ts — the pure reduction and listSessions (§3.5, §3.6)
export {
  FOLD_CAPS,
  ackOrigin,
  ackOriginKey,
  buildFold,
  byRunId,
  childrenOf,
  claimHolderOf,
  emptyFold,
  emptyFoldState,
  leaseKeysOf,
  leaseOrigin,
  leaseOriginKey,
  listSessions,
  maxStampN,
  messageOrigin,
  messageOriginKey,
  originOf,
  peerViewOf,
  recordKeyOf,
  seenEpochs,
  sessionDevices,
  sessionTargets,
} from './fold.js';
export type { FoldEnv, FoldState, RecordEntry } from './fold.js';

/**
 * ledger.ts / paths.ts / watch.ts — the store, the handle, readFold, the watcher (§3.1, §3.5, §12.0.4).
 *
 * contract 1.4 (W2b), the naming note the surface needs: §12.0.4 calls the opened object `Ledger`; as built the
 * implementation SPLITS it in two, and the FACADE names the two halves so the consumer's default is the right one.
 *
 *   facade `Ledger`      = `LedgerHandle` (`ledger.ts`) — the ~50 members a WRITER needs (`enqueue`, `writeOwn`,
 *                          `refreshFence`, `foreignLive`, `forkVerdict`, `claim`, `stamps`, `mirror`, …) on top of the
 *                          base. It is what `openLedger` returns, what `openCoordination()` hands back and what
 *                          `EngineOptions.coordination.ledger` carries, because the engine calls all of them.
 *   facade `LedgerBase`  = `Ledger` (`types.ts`) — the narrow base: `root`, `self`, `fold`, `open`, `setIdentity`,
 *                          `subscribe`, `close`. Every write verb (`declare`, `send`, `ack`, `gc`, …) takes THIS and
 *                          recovers the handle internally with `asHandle()`, so a READER can hold the small type.
 *   `LedgerHandle` is still exported under its own name: round 5 and the engine type against it and nothing moves.
 *
 * Why the rename is at the FACADE and not in `types.ts`: the module's own signatures in `leases.ts`, `mailbox.ts`,
 * `subwork.ts`, `heartbeat.ts` and `worktree.ts` all read `Ledger` for the base and are right to — inside the module
 * the base IS the ledger a verb takes. Outside it, two exported names for two shapes where one name is a subset of
 * the other is a trap with a RUNTIME punishment: a consumer who annotated a handle with the 7-member type and passed
 * it on met `asHandle()`'s throw. Under the facade's names that is a type error, and no signature in the module moved.
 * The design's `openLedger(opts): Ledger` line is correct again by construction.
 */
export {
  ACK_TRACK_MAX_MS,
  ENTRIES_MAX,
  GC_RETENTION_MS,
  LEDGER_OP_TIMEOUT_MS,
  MAX_DEVICES,
  MAX_FENCE_DEVICES,
  MAX_GC_DEVICES,
  STRICT_FENCE_MS,
  MIRRORED_KINDS,
  READ_FOLD_BUDGET_MS,
  TRACKED_ACKS_MAX,
  ackIsFrom,
  asHandle,
  defaultIsPidAlive,
  gc,
  ignoreDeviceOn,
  openLedger,
  readFold,
  setDeviceLabel,
  syncDisable,
  syncStatus,
  pairDeviceOn,
  unignoreDeviceOn,
  unpairDeviceOn,
  writeTakeoverLease,
} from './ledger.js';
export type { FenceScan, LedgerHandle, LedgerNotice, LedgerStatus, OpenLedgerOptions, PeerLive } from './ledger.js';
/** the facade's public name for the opened object: `Ledger` IS the handle `openLedger` returns (see the type-list note above) */
export type { LedgerHandle as Ledger } from './ledger.js';
/** the narrow reader's base (`types.ts`'s own `Ledger`): what every write verb takes and what `asHandle()` recovers a handle from */
export type { Ledger as LedgerBase } from './types.js';
export {
  COMMONS_KINDS,
  COORDINATION_DIR,
  DEVICE_FILE,
  FOLD_KINDS,
  MIRROR_DIR,
  commonsPaths,
  coordinationRoot,
  isDeviceIdDir,
  isMsgIdDir,
  isRepoKeyDir,
  isSlugName,
  KEY_DIR_RE,
  ackRel,
  decodeKeyComponent,
  deviceClaimFile,
  deviceClaimsDir,
  keyDir,
  keyOfDir,
  decodeTargetComponent,
  encodeKeyComponent,
  encodeTargetComponent,
  isTargetDir,
  leaseRel,
  messageRel,
  mirrorRoot,
  parseAckName,
  parseHeartbeatName,
  parseLeaseName,
  parseMessageName,
  sessionWorktreeDir,
  WORKTREES_DIR,
} from './paths.js';
export type { Commons, CommonsKind } from './paths.js';
export { POLL_MS, WATCH_DEBOUNCE_MS, createWatcher, nodeTimers } from './watch.js';
export type { Timers, WatchFn, Watcher, WatcherOptions } from './watch.js';
export { DIR_MODE, FILE_MODE, LEDGER_ERROR_CODES, OFFLINE_CODES, classifyLedgerError, errnoCode, nodeFs, withTimeout } from './fs.js';
export type { BoundedRead, CoordFs, FsStat, LedgerErrorCode } from './fs.js';

// leases.ts — declare / check / release / renew (§4.3, §4.5)
export { FACTS_MAX, FACT_TEXT_MAX, FENCE_WAIT_CAP_MS, STRICT_WAIT_MS, TREE_PATH, buildFacts, check, collapsePaths, coordRecordOf, declare, fenceWake, fenceYield, isExclusiveTreeCommand, leaseRels, leaseSnapshot, release, renew, requestedFor, shouldSkipInlineWait } from './leases.js';
export type { CheckOptions, FenceWait } from './leases.js';

// mailbox.ts — send / inbox / ack / awaitAck / resolveTarget and the permission boundary (§5, §10.3)
export { AWAIT_ACK_MS, MUTE_MS, MUTE_THRESHOLD_PER_MIN, SEEN_MAX, ack, awaitAck, classifyIncoming, consumerIdOf, inbox, loadSeen, purgeInbox, resolveTarget, send } from './mailbox.js';
export type { IncomingDisposition, RemoteControl, ResolveResult, SendInput } from './mailbox.js';

// heartbeat.ts — the record builder and the six-point writer (§3.3, §4.7 bench presence)
export { HEARTBEAT_COALESCE_MS, benchBase, benchDynamic, buildHeartbeat, createHeartbeatWriter, initialDynamic } from './heartbeat.js';
export type { BenchPresenceInput, BuildHeartbeatResult, HeartbeatBase, HeartbeatDynamic, HeartbeatWriter, HeartbeatWriterOptions } from './heartbeat.js';

// subwork.ts — lanes / worktrees as leases, subwork rows, the bench lock (§6, §4.7)
export { BENCH_LOCK_FILE, acquireBenchLock, benchLockInUseMessage, declareLane, declareWorktree, laneLeases, mergeSubwork, parseBenchLock, readBenchLock, releaseBenchLock, removeSubwork, staleLaneLeases, subworkEntry } from './subwork.js';
export type { AcquireBenchLockOptions, BenchLock, LaneLeaseInput, WorktreeLeaseInput } from './subwork.js';

// sync-shared-dir.ts — the mirror (§9.1, §9.2)
export { ICLOUD_PLACEHOLDER_RE, MIRROR_OFFLINE_NOTICE_MS, MIRROR_OP_TIMEOUT_MS, createMirror } from './sync-shared-dir.js';
export type { Mirror, MirrorOptions, MirrorState } from './sync-shared-dir.js';

/**
 * worktree.ts — the write verbs the product surface owns (+ review blocker 2). §12.0.4 listed `worktree.ts` as
 * engine-internal while W1 item 15 / W2 item 22 / W3 item 31 assigned `/spawn`, `/worktree {list,take,back,fork}` and
 * `sessions gc [--lanes]` to the TUI; these are the signatures the surface calls, with `git` behind an injected seam.
 */
export {
  BRANCH_PREFIX,
  END_OF_OPTIONS,
  LOCK_REASON_PREFIX,
  SYNCED_IGNORED_MAX,
  WORKTREE_RETENTION_MS,
  buildWorktreeRecord,
  createWorktree,
  isValidBase,
  listWorktreeInfo,
  listWorktrees,
  lockReasonFor,
  parseLockReason,
  parseWorktreeList,
  parseWorktreeRecord,
  removeWorktree,
  sweepWorktrees,
} from './worktree.js';
export type { CreateWorktreeInput, CreatedWorktree, GitWorktreeEntry, RemoveWorktreeInput, RemoveWorktreeResult, RunGit, SweepReport, WorktreeIo } from './worktree.js';

// ── openCoordination — the one entry point (§3.1, §3.2, §3.5, §12.0.4) ────────────────────────────────────────────────

/** every `openLedger` option a caller may still want to set; `home`, `self`, `hostKey` and `bootId` are composed here */
type LedgerPassThrough = Pick<
  OpenLedgerOptions,
  'sharedDir' | 'claim' | 'pid' | 'now' | 'monotonicNow' | 'watch' | 'pollMs' | 'debounceMs' | 'fs' | 'timers' | 'isPidAlive' | 'redact' | 'syncSlackMs' | 'opTimeoutMs' | 'budgetMs' | 'onNotice' | 'random' | 'scanOnly' | 'commonsKey' | 'trustKeys' | 'actor8'
>;

export interface OpenCoordinationOptions extends LedgerPassThrough {
  /** `jevcodeDir(env, home, cwd)` — the store is `<home>/coordination/` (§3.1); `JEVCODE_HOME` has already moved it */
  home: string;
  /** `realpath(git toplevel ?? workspace)`: `wsKey` is derived from it with zero spawns (§3.2) */
  workspaceRealpath: string;
  /** null for a TUI with no run yet; `Ledger.setIdentity({ sessionId })` moves it later (§3.5) */
  sessionId: string | null;
  runId: string | null;
  /** the running build's version string — `DeviceRecord.jevcode` */
  jevcodeVersion: string;
  /**
   * §3.2: what the repository probe learnt, spawned by the CALLER off the critical path (`src/coordination/**` runs no
   * git). Absent, the keys come from this host's `repokeys/` cache for this workspace, and are `null` when it has no
   * entry yet — exactly the state `setIdentity({ repoKey })` exists to leave behind after `run:ready`.
   *
   * PRESENT, this call FILLS that cache (one atomic write under `<hostDir>/repokeys/`, and only when the entry is
   * missing or has changed), so the fallback above is a real path and not a description of a cache with no producer:
   * nothing else in the tree ever called `writeRepoKeyCache`, so before this a caller without repo facts got
   * `repoKey: null` forever. A cache write that fails is swallowed — it is an optimisation for the NEXT open, never
   * a reason to refuse this one.
   */
  repo?: RepoFacts;
  /** `git rev-parse --git-common-dir` from the same caller probe; recorded in the `repokeys/` entry (60 chars), `''` = not recorded */
  commonDir?: string;
  branch?: string | null;
  /** the device label to create with; an existing `device.json` keeps its own (`setDeviceLabel` renames it) */
  label?: string;
  syncMode?: DeviceRecord['syncMode'];
  /** defaults to `os.hostname()` / `os.userInfo().username`; injected by tests and by a caller that already resolved them */
  hostname?: string;
  username?: string;
  /** §3.2: `IOPlatformUUID` / `/etc/machine-id`, probed by the caller; absent, `hostKey` is the two-input hash */
  machineId?: string;
  /** §3.4: injected boot probe (tests, and a caller with its own); absent, the memoised `nodeBootProbe` answers */
  bootProbe?: BootProbe;
  /** ms since the machine booted; defaults to `os.uptime() * 1000` (`bootAt = now − uptime`) */
  uptimeMs?: () => number;
  /**
   * §3.2 / §11 row 27: open anyway when `devices/<hostKey>/device.json` names ANOTHER host + user.
   *
   * Default `false`, and the refusal is a throw (`CoordinationError 'not-ours'`) rather than a field the caller may
   * forget to read. `'foreign'` used to be reported only in `OpenCoordinationResult.device`, while the `self` handed
   * back in the same object already carried the OTHER machine's `deviceId` and the ledger was ready to write records
   * as that device — so the one identity rule a consumer still had to know by hand was the one with a data-loss
   * consequence, in the entry point that exists to stop consumers knowing identity rules by hand. A surface that
   * wants to prompt (`Prompter.adoptDevice?`) passes `true` and branches on `result.device.status === 'foreign'`
   * before writing anything; nothing has been written yet and the ledger is unopened, so it can `close()` and call
   * `adoptNewDevice()` instead.
   */
  allowForeign?: boolean;
}

export interface OpenCoordinationResult {
  /** the writer's handle, NOT yet opened: call `ledger.open()` after `renderer.firstFrame()` (§3.5) */
  ledger: LedgerHandle;
  /** `ledger.self` — the composed identity, with `hostKey` and `bootId` already seated by the handle */
  self: SelfIdentity;
  /**
   * what `deviceIdentity()` decided. `'created'` / `'loaded'` / `'readopted'` need no attention; **`'foreign'` does**:
   * `devices/<hostKey>/device.json` names another host + user (§11 row 27), and the surface must ask
   * `adopt as a new device? [y]` before this process writes anything as that device. Nothing has been written for a
   * foreign identity and the ledger is unopened, so a caller that refuses can `close()` and call `adoptNewDevice()`.
   *
   * It can only READ `'foreign'` here after opting in with `allowForeign: true`: without it the open throws, because
   * a field the caller may forget to branch on is not a safeguard when the `self` beside it already carries the
   * other machine's `deviceId`.
   */
  device: DeviceIdentityResult;
  close(): Promise<void>;
}

/**
 * Open the coordination plane for this process: the ONE call a consumer needs (§12.0.4).
 *
 * The plane was fully built, contract-typed and unit-tested and still had no production caller, because reaching it
 * meant assembling eleven `SelfIdentity` fields by hand from four different modules and producing a `bootId` that
 * nothing in the tree produced. This composes exactly that: `deviceIdentity()` (§3.2) → `wsKeyOf` / `repoKeyOf`
 * (§3.2) → `bootIdOf()` (§3.4, `./boot.ts`) → `openLedger()` (§3.5).
 *
 * What it deliberately does NOT do:
 *   · it never opens the ledger. `open()` is the caller's, after `renderer.firstFrame()` — the §3.5 rule that there
 *     is zero scanning, watching and polling before the first frame is unchanged. Identity itself is two bounded
 *     awaited file operations (read `device.json`, write it when this host has none); a surface that wants literally
 *     no I/O before its first frame calls this after it too.
 *   · it never prompts and never adopts. `'foreign'` REFUSES by default (a `CoordinationError 'not-ours'`; see
 *     `allowForeign`) and is otherwise reported, never resolved: `Prompter.adoptDevice?` is the surface's and
 *     `adoptNewDevice()` is the explicit writer (§3.2).
 *   · it never spawns git and never mints a commons key. Repo facts arrive from the caller's own probe, and pairing
 *     (`mintCommonsKey` / `writeCommonsKey` / `trustDevice`, §10.3) is a surface verb with its own consent step.
 */
export async function openCoordination(o: OpenCoordinationOptions): Promise<OpenCoordinationResult> {
  const { home, workspaceRealpath, sessionId, runId, jevcodeVersion, repo, commonDir, branch, label, syncMode, hostname, username, machineId, bootProbe, uptimeMs, allowForeign, ...pass } = o;
  const fs = pass.fs ?? nodeFs;
  const nowMs = (pass.now ?? Date.now)();
  const root = coordinationRoot(home);
  const host = hostname ?? safeHostname();
  const user = username ?? safeUsername();

  const device = await deviceIdentity({
    root,
    fs,
    hostname: host,
    username: user,
    jevcode: jevcodeVersion,
    nowIso: new Date(nowMs).toISOString(),
    ...(label !== undefined ? { label } : {}),
    ...(syncMode !== undefined ? { syncMode } : {}),
    ...(machineId !== undefined ? { machineId } : {}),
    ...(pass.random !== undefined ? { random: pass.random } : {}),
  });
  // §11 row 27, before anything else can be composed from it: a foreign `device.json` is a REFUSAL by default.
  if (device.status === 'foreign' && allowForeign !== true) {
    const who = (pass.redact ?? ((x: string) => x))(`${device.device.host}/${device.device.user}`);
    throw new CoordinationError('not-ours', `devices/${device.hostKey}/device.json belongs to another host and user`, { detail60: who });
  }

  const hostDir = commonsPaths(root, device.hostKey).hostDir;
  const keys = repo !== undefined ? repoKeyOf(repo) : await readRepoKeyCache(fs, hostDir, workspaceRealpath);
  if (repo !== undefined && keys !== null) await cacheRepoKeys(fs, hostDir, workspaceRealpath, keys, commonDir ?? '', nowMs);
  const bootId = await bootIdOf(bootProbe === undefined ? {} : { probe: bootProbe });

  const self: SelfIdentity = {
    deviceId: device.device.deviceId,
    label: device.device.label,
    host,
    user,
    hostKey: device.hostKey,
    bootAt: bootAtOf(nowMs, uptimeMs),
    bootId,
    sessionId,
    runId,
    wsKey: wsKeyOf(workspaceRealpath),
    repoKey: keys?.repoKey ?? null,
    remoteKey: keys?.remoteKey ?? null,
    branch: branch ?? null,
  };
  const ledger = openLedger({ ...pass, home, self, hostKey: device.hostKey, bootId });
  return { ledger, self: ledger.self, device, close: () => ledger.close() };
}

/**
 * §3.2: fill this host's `repokeys/` entry for this workspace, so the no-repo-facts branch above has a producer.
 *
 * Reads before writing and writes only on a CHANGE: the steady state is one bounded read per process start, not a
 * write, and a workspace whose keys have not moved never touches the disk. Every failure is swallowed — a read-only
 * or full `~/.jevcode` must cost the next open its cached keys, never this open its ledger.
 */
async function cacheRepoKeys(fs: CoordFs, hostDir: string, wsRealpath: string, keys: RepoKeys, commonDir: string, nowMs: number): Promise<void> {
  try {
    const existing = await readRepoKeyCache(fs, hostDir, wsRealpath);
    if (existing !== null && existing.repoKey === keys.repoKey && existing.remoteKey === keys.remoteKey && existing.kind === keys.kind && existing.commonDir60 === commonDir.slice(0, 60)) return;
    await writeRepoKeyCache(fs, hostDir, wsRealpath, { ...keys, commonDir60: commonDir, at: new Date(nowMs).toISOString() });
  } catch {
    // the cache is an optimisation for the NEXT open; this one already has the keys in hand.
  }
}

/**
 * §3.4: the machine's boot wall time (`now − uptime`), display and `stale-reused-pid` only — never a liveness input.
 *
 * `os.uptime()` is wrapped for the same reason `os.hostname()` and `os.userInfo()` are: this function's documented
 * degradation is "a worse `bootAt`, never a crash", and an unwrapped throw here escapes `openCoordination` and takes
 * the surface's whole startup with it. An unreadable uptime falls through the `isFinite` guard to `bootAt = now`,
 * which is the same answer an uptime of 0 gives.
 */
function bootAtOf(nowMs: number, uptimeMs?: () => number): string {
  let up: number;
  try {
    up = (uptimeMs ?? (() => osUptime() * 1_000))();
  } catch {
    up = Number.NaN;
  }
  const at = Number.isFinite(up) && up >= 0 && up <= nowMs ? nowMs - up : nowMs;
  return new Date(at).toISOString();
}

/** `os.hostname()` throws on a host with no resolvable name; an unknown name is a worse `hostKey`, never a crash. */
function safeHostname(): string {
  try {
    const h = osHostname().trim();
    return h === '' ? 'unknown-host' : h;
  } catch {
    return 'unknown-host';
  }
}

/** `os.userInfo()` throws with no passwd entry (a container with a bare uid). */
function safeUsername(): string {
  try {
    const u = osUserInfo().username.trim();
    return u === '' ? 'unknown-user' : u;
  } catch {
    return 'unknown-user';
  }
}
