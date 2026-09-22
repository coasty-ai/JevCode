/**
 * The coordination facade (§12.0.4): the ONLY import path for `src/session/**`, `src/cli/**`, `src/tui/**` and the engine.
 * Re-exports every §12.0 type (declared in `./types.ts` until they move to `core/types.ts` after the round-3 hash) and the
 * API exactly as built: identity (`ids.ts`), records (`records.ts`), the fold (`fold.ts`), the ledger (`ledger.ts`, the
 * watcher behind `Ledger.subscribe`), leases, the mailbox, the heartbeat writer, sub-work + the bench lock, the shared-dir
 * mirror. Nothing here imports `src/session/**`, `src/cli/**`, `src/tui/**` or `src/config/**` (§12.0.1 rule 1).
 */

// contract types (§12.0.4 shapes, structurally identical; see ./types.ts header for the `+` additions)
export type {
  Ack,
  AckOutcome,
  AnyRecord,
  Authority,
  Claim,
  CoordStageName,
  CoordinationFacts,
  DeviceRecord,
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
  Ledger,
  Liveness,
  LivenessEnv,
  LivenessVerdict,
  Message,
  MessageType,
  PausePoint,
  PausePointReason,
  RecordKind,
  RecordOf,
  RecordOrigin,
  RunPhase,
  SelfIdentity,
  SessionActivity,
  Stamp,
  StrictDeclaration,
  SubworkEntry,
  WorktreeRecord,
} from './types.js';

// claims.ts — the immutable fork fence and record authenticity (review blockers 3, 5, 6)
export {
  COMMONS_KEY_BYTES,
  COMMONS_KEY_RE,
  EPOCH_MAX,
  FIRST_EPOCH,
  FOREIGN_ORIGIN,
  SELF_ORIGIN,
  authorityOf,
  claimHolder,
  compareClaim,
  forkVerdict,
  hmacOf,
  hmacValid,
  isValidClaim,
  mintClaim,
  sameClaim,
  withHmac,
} from './claims.js';
export type { ForkRole, ForkVerdict } from './claims.js';

// ids.ts — identity facts and validators (§3.1, §3.2)
export {
  ACTOR8_RE,
  BRANCH_MAX_CHARS,
  BROADCAST_ALL,
  DEVICE_ID_RE,
  DEVICE_KEY_FILE,
  LABEL_MAX_CHARS,
  LANE_DIR_RE,
  LEASE_ID_RE,
  LEASE_PATHS_MAX,
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
  mintActor8,
  mintCommonsKey,
  mintBase32,
  mintDeviceId,
  normaliseOriginUrl,
  parseDeviceRecord,
  probeCaseInsensitive,
  readCommonsKey,
  readIgnoredDevices,
  readRepoKeyCache,
  readTrustKeys,
  readTrusted,
  repoKeyCachePath,
  repoKeyOf,
  sameRepo,
  trustDevice,
  writeCommonsKey,
  writeDeviceRecord,
  writeRepoKeyCache,
  writeTrusted,
  wsKeyOf,
} from './ids.js';
export type { DeviceIdentityOptions, DeviceIdentityResult, DeviceIdentityStatus, IgnoredDevice, RandomBytes, RepoFacts, RepoKeyCacheEntry, RepoKeys, StampClock, TrustedDevice } from './ids.js';

// records.ts — schemas, parse, checksum, liveness, overlap (§3.3, §3.4, §4.3)
export {
  CONTROL_MESSAGE_TTL_MS,
  CONTROL_MESSAGE_TYPES,
  GONE_KEEP_MS,
  HEARTBEAT_MS,
  HEARTBEAT_TTL_MS,
  LEASE_TTL_MS,
  MESSAGE_TTL_MS,
  READ_MAX_BYTES,
  RECORD_MAX_BYTES,
  SKEW_MS,
  SYNC_SLACK_GIT_MS,
  SYNC_SLACK_SHARED_MS,
  checksumOf,
  compareStamp,
  finalizeRecord,
  fitsRecordSize,
  isAck,
  isDeviceRecord,
  isHeartbeat,
  isLease,
  isLive,
  isMessage,
  oneLine,
  overlap,
  parseRecord,
  pathsOverlap,
  recordBytes,
  recordKindOf,
  redactRecord,
  serializeRecord,
  withChecksum,
  COUNTER_MAX,
  STAMP_ADOPT_MAX_DELTA,
  adoptableStampN,
} from './records.js';
export type { Now, OverlapOptions, ParseContext, ParseFailure, ParseRecordResult } from './records.js';
export { canonicalText, checksumValid } from './checksum.js';

// fold.ts — the pure reduction and listSessions (§3.5, §3.6)
export { FOLD_CAPS, buildFold, byRunId, childrenOf, emptyFold, emptyFoldState, leaseKeysOf, leaseOrigin, leaseOriginKey, listSessions, maxStampN, messageOrigin, messageOriginKey, originOf, seenEpochs, sessionTargets } from './fold.js';
export type { FoldEnv, FoldState, RecordEntry } from './fold.js';

// ledger.ts / paths.ts / watch.ts — the store, the handle, readFold, the watcher (§3.1, §3.5, §12.0.4)
export {
  GC_RETENTION_MS,
  LEDGER_OP_TIMEOUT_MS,
  MIRRORED_KINDS,
  READ_FOLD_BUDGET_MS,
  asHandle,
  defaultIsPidAlive,
  gc,
  ignoreDeviceOn,
  openLedger,
  readFold,
  setDeviceLabel,
  syncDisable,
  writeTakeoverLease,
} from './ledger.js';
export type { LedgerHandle, LedgerNotice, LedgerStatus, OpenLedgerOptions, PeerLive } from './ledger.js';
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
  isTargetDir,
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
export { FACTS_MAX, FACT_TEXT_MAX, STRICT_WAIT_MS, TREE_PATH, buildFacts, check, collapsePaths, coordRecordOf, declare, isExclusiveTreeCommand, leaseSnapshot, release, renew, requestedFor, shouldSkipInlineWait } from './leases.js';
export type { CheckOptions } from './leases.js';

// mailbox.ts — send / inbox / ack / awaitAck / resolveTarget and the permission boundary (§5, §10.3)
export { AWAIT_ACK_MS, MUTE_MS, MUTE_THRESHOLD_PER_MIN, SEEN_MAX, ack, awaitAck, classifyIncoming, consumerIdOf, inbox, loadSeen, resolveTarget, send } from './mailbox.js';
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
  LOCK_REASON_PREFIX,
  SYNCED_IGNORED_MAX,
  WORKTREE_RETENTION_MS,
  buildWorktreeRecord,
  createWorktree,
  listWorktrees,
  lockReasonFor,
  parseLockReason,
  parseWorktreeList,
  parseWorktreeRecord,
  removeWorktree,
  sweepWorktrees,
} from './worktree.js';
export type { CreateWorktreeInput, CreatedWorktree, GitWorktreeEntry, RemoveWorktreeInput, RemoveWorktreeResult, RunGit, SweepReport, WorktreeIo } from './worktree.js';
