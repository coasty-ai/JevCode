/**
 * The coordination facade (§12.0.4): the ONLY import path for `src/session/**`, `src/cli/**`, `src/tui/**` and the engine.
 * Re-exports every §12.0 type (declared in `./types.ts` until they move to `core/types.ts` after the round-3 hash) and the
 * API exactly as built: identity (`ids.ts`), records (`records.ts`), the fold (`fold.ts`), the ledger (`ledger.ts`, the
 * watcher behind `Ledger.subscribe`), leases, the mailbox, the heartbeat writer, sub-work + the bench lock, the shared-dir
 * mirror. Nothing here imports `src/session/**`, `src/cli/**`, `src/tui/**` or `src/config/**` (§12.0.1 rule 1).
 */

// contract types (§12.0.4 shapes, structurally identical; see ./types.ts header for the `+` additions)
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
  Ledger,
  Liveness,
  LivenessEnv,
  LivenessVerdict,
  Message,
  MessageType,
  PausePoint,
  PausePointReason,
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
  recordKeyOf,
  seenEpochs,
  sessionDevices,
  sessionTargets,
} from './fold.js';
export type { FoldEnv, FoldState, RecordEntry } from './fold.js';

// ledger.ts / paths.ts / watch.ts — the store, the handle, readFold, the watcher (§3.1, §3.5, §12.0.4)
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
