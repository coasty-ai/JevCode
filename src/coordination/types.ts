/**
 * Coordination contract types — docs/COORDINATION-DESIGN.md §12.0.4 (and §12.0.2 for `PausePoint`).
 *
 * Revised for the four fencing / authenticity blockers of docs/research/coordination/review-2026-09-21.md: `Claim`
 * (blocker 3 — an IMMUTABLE per-process incarnation, never the folding Lamport counter), `RecordOrigin` (blockers 5 / 6 —
 * "self" and "authenticated" are decided by the path a record was read from and its HMAC, never by its content), and the
 * write API `LedgerWrites` the surface needs (blocker 2).
 *
 * Declared here, structurally identical to the §12.0 shapes, because `src/core/types.ts` is frozen until the TUI round-3
 * hash lands; every type in this file moves to `core/types.ts` under the `// contract 1.4` header afterwards (the facade
 * `index.ts` keeps re-exporting them, so no importer changes). Additions beyond §12.0 are marked `// +` and listed in the
 * hand-over: `Heartbeat.lockHeld?`, `Fold.forks?`, `CoordStageName`, `LivenessVerdict`, `LivenessEnv`, `SubworkEntry`,
 * `LeaseOutcome`, `RecordKind` / `RecordOf` / `AnyRecord`.
 */
import type { BlockingKind, EngineMode, RunSource, StageName, StopReason } from '../core/types.js';

/** `StageName` + `'coordinate'` (W0 item 1 adds the member to core/types.ts; a union here so this module compiles against HEAD). */
export type CoordStageName = StageName | 'coordinate'; // +

/** §3.2: the per-run Lamport stamp; total order = (n, deviceId, runId); `runId` is the run id, or the minted `actor8` of a CLI sender (§5.1) */
export interface Stamp {
  n: number;
  deviceId: string;
  runId: string;
}

/**
 * + review blocker 3: the fork / foreign-liveness fence. The Lamport `Stamp` folds (`max(n, observed) + 1` on every fold
 * AND every issue) and the heartbeat is one file per run overwritten every beat, so two engines comparing stamps can both
 * read themselves as the holder. A `Claim` is minted ONCE per process and never changes, so both sides compute the same
 * verdict from the same pair of records whatever the sync timing: the holder is the LOWEST claim (the first claimer keeps
 * the run; a newcomer yields), ordered `(epoch, startedAt, deviceId, pid)`.
 */
export interface Claim {
  /** the run incarnation: 1 for a fresh run, `max(every epoch seen for this runId) + 1` for a resume / takeover / import */
  epoch: number;
  deviceId: string;
  runId: string;
  pid: number;
  /** this process's start (ISO) — the tiebreak between two claims that minted the same epoch */
  startedAt: string;
}

/** + review blockers 5 / 6: where a record came from and whether it is authentic — decided by the reader, never by the record. */
export interface RecordOrigin {
  /**
   * true ONLY when the file was read from this reader's own local `~/.jevcode/coordination/<kind>/<myDeviceId>/` subtree.
   * A file under my device id in a shared mirror is never `self` (a forged `pause` there would otherwise auto-apply).
   */
  self: boolean;
  /** the mirror root the file came from, or null for the local store */
  source: string | null;
  /** the record carries an `hmac` that verifies under a paired device key (or it is `self`) — §10.3 */
  authenticated: boolean;
}

/** + §10.3: the verdict on one foreign record's authority; only `'trusted'` may stop a run or apply a control verb. */
export type Authority = 'self' | 'trusted' | 'unverified';

/** §7.1 */
export type RunPhase = 'starting' | 'running' | 'pausing' | 'paused' | 'blocked' | 'aborting' | 'ended';

/** §12.0.2 (a): where a run stopped, so that /resume can continue it; one per pause point, emitted before `run:end` */
export interface PausePoint {
  step: number;
  round: number | null;
  phase: CoordStageName | 'idle' | 'pane';
  reason: PausePointReason;
  resumableAt: 'boundary' | `cache/step-${number}.json`;
  replayable: boolean;
  pane?: BlockingKind;
  synthPhase?: string;
  by: 'self' | `peer:${string}` | `device:${string}`;
  end: boolean;
}
export type PausePointReason = 'step' | 'now' | 'now-after-execute' | 'pane' | 'worktree';

/** §6.1 one sub-work row of a heartbeat (≤ 16) */
export interface SubworkEntry {
  kind: 'sample' | 'lane' | 'probe' | 'child';
  id: string;
  since: string;
  stage: string;
  detail60: string;
  laneDir?: string;
}

/** registry/<deviceId>/<runId>.json — ≤ 4 KiB — §3.3, typed */
export interface Heartbeat {
  v: 1;
  kind: 'heartbeat' | 'bench';
  deviceId: string;
  label: string;
  host: string;
  user: string;
  pid: number;
  bootAt: string;
  /**
   * §3.2 / §3.4 (design revision 5): the OS boot identity. Like `hostKey` it can only DENY `sameDevice`, never grant
   * it: a record in my own local subtree whose `bootId` is not mine is by construction not this boot's process, so the
   * pane / debugger / clock case cannot apply to it and beat FRESHNESS decides instead — which is the one fact that
   * separates a previous boot of my machine (stopped renewing) from a live clone (still renewing). Absent = an older
   * build wrote it; such a record with a live pid is never auto-replaced (§3.4).
   */
  bootId?: string | null;
  /** §3.2: the writer's `hostKey` — binds the record to the MACHINE, so a beat under my own deviceId from another machine is never `sameDevice` */
  hostKey?: string;
  jevcode: string;
  runId: string;
  sessionId: string;
  parentSessionId: string | null;
  parentRunId: string | null;
  source: RunSource;
  title60: string | null;
  task60: string;
  repo: {
    wsKey: string;
    repoKey: string | null;
    remoteKey: string | null;
    superKey?: string;
    basename: string;
    branch: string | null;
    head: string | null;
    dirtyAtStart: boolean;
    linkedWorktree: boolean;
    worktreeSlug: string | null;
  };
  mode: EngineMode;
  phase: RunPhase;
  step: number;
  maxSteps: number;
  stage: CoordStageName | 'idle';
  action80: string | null;
  pausing: boolean;
  pauseNow: boolean;
  blocked: BlockingKind | null;
  retrying: { side: 'jev' | 'generator'; attempt: number } | null;
  stopReason: StopReason | null;
  plan: { done: number; remaining: number; unverified: number; next3: string[] };
  declared: { step: number; paths: string[]; type: Lease['type']; truncated: boolean } | null;
  touched: { step: number; files: string[] } | null;
  touchedRecent: string[];
  leases: string[];
  subwork: SubworkEntry[];
  bench?: { benchId: string; tasks: { live: number; done: number; total: number }; lanes: number; spendUsd: number };
  spend: { generatorUsd: number; jevUsd: number; sessionUsd: number | null; capUsd: number };
  tokens: { used: number; cap: number | null };
  wallMs: number;
  maxWallMs: number;
  context: { pct: number; files: number; historyEntries: number; summaryAt: number | null; tokensInWindow: number; windowBudget: number; compactions: number };
  /** §12.0.2: on the final phase:'ended' beat of a human_pause */
  pausePoint?: PausePoint;
  /** + §11 row 15: false when `takeRunLock` reported `held:false` (the heartbeat is the second liveness signal); absent = unknown */
  lockHeld?: boolean;
  startedAt: string;
  beatAt: string;
  beatSeq: number;
  ttlMs: number;
  stamp: Stamp;
  /** + review blocker 3: the immutable per-process claim the fork rule compares (never `stamp`) */
  claim: Claim;
  /**
   * + review blocker 2: the beat did not fit 4 KiB at full detail and the builder DEGRADED it (touchedRecent → subwork →
   * plan.next3 → the declared / touched path sets) rather than refuse to beat. A refused beat reads as stale to every peer,
   * which drops the run's leases — degrading is always the safer failure.
   */
  truncated?: boolean;
  checksum: string;
  hmac?: string;
}

export type LeaseOutcome = 'committed' | 'discarded' | 'expired' | 'ended';

/** leases/<deviceId>/<repoKey>/<runId>-<seq>.json — ≤ 8 KiB — §4.3, typed */
export interface Lease {
  v: 1;
  kind: 'lease';
  leaseId: string;
  runId: string;
  sessionId: string;
  deviceId: string;
  label: string;
  repoKey: string;
  remoteKey: string | null;
  wsKey: string;
  branch: string | null;
  head: string | null;
  type: 'intent' | 'exclusive' | 'command' | 'lane' | 'worktree' | 'takeover';
  paths: string[];
  truncated: boolean;
  command60?: string;
  exclusiveTree?: boolean;
  laneDir?: string;
  slug?: string;
  reason60: string;
  step: number;
  stage: CoordStageName;
  stamp: Stamp;
  issuedAt: string;
  expiresAt: string;
  renewedAt: string;
  released?: { at: string; outcome: LeaseOutcome; changed: Record<string, string | null>; head?: string };
  /** + review blocker 3: present on `type:'takeover'` — the claim of the process taking the run over */
  claim?: Claim;
  checksum: string;
  hmac?: string;
}

/** inbox/<deviceId>/<target>/<t>-<seq>.json — ≤ 2 KiB — §5.1, typed */
export type MessageType = 'heads-up' | 'handoff' | 'note' | 'request-release' | 'steer' | 'pause' | 'resume' | 'end' | 'abort' | 'ack' | 'who';
export interface Message {
  v: 1;
  kind: 'message';
  /** `<deviceId>-<actor8>-<seq>` (MSG_ID_RE) */
  id: string;
  /**
   * §5.1 / §5.4 rule 5 (design revision 5): `pid` is DISPLAY AND AUDIT ONLY — it is never an `isPidAlive` input, because
   * a sender's pid means nothing in the reader's pid table. `bootId` DENIES the no-confirm same-device path for the
   * control types: a `pause` that arrived in my own subtree from another boot session is not mine to apply silently.
   */
  from: { deviceId: string; label: string; sessionId: string | null; runId: string | null; user: string; pid?: number; bootId?: string | null };
  /** §3.2: the writer's `hostKey` — a `pause` from another machine under one shared `deviceId` is never `self` */
  hostKey?: string;
  /** '<sessionId>' | '@<repoKey>' | '@all' */
  to: string;
  type: MessageType;
  /** ≤ 600 (DIRECTIVE_MAX_CHARS) */
  text: string;
  refs: { commit?: string; branch?: string; files?: string[]; leaseId?: string; runId?: string; step?: number; msgId?: string; target?: string };
  by?: 'human' | 'engine';
  t: string;
  stamp: Stamp;
  expiresAt: string;
  checksum: string;
  hmac?: string;
}

/** acks/<deviceId>/<msgId>/<sessionId>.json — §5.1 */
export type AckOutcome = 'delivered' | 'applied' | 'refused' | 'expired';
export interface Ack {
  v: 1;
  kind: 'ack';
  msgId: string;
  /**
   * + review major 8: the CONSUMER id `${sessionId ?? 'tui'}-${actor8}`, not a session id. Two processes can hold one
   * session (`jevcode -c` twice on a paused session) and a TUI has no session before its first run, so a session-keyed
   * ack file has two writers.
   */
  by: string;
  deviceId: string;
  at: string;
  outcome: AckOutcome;
  detail60?: string;
  stamp: Stamp;
  checksum: string;
  hmac?: string;
}

/**
 * registry/<deviceId>/device.json and coordination/device.json — §3.1. The PUBLIC subset: the paired `commonsKey` of §10.3
 * is never a member of this record (it lives 0600 in `coordination/device.key`, which is never published or mirrored).
 */
export interface DeviceRecord {
  v: 1;
  deviceId: string;
  label: string;
  host: string;
  user: string;
  jevcode: string;
  createdAt: string;
  syncMode: 'off' | 'shared-dir' | 'git';
  checksum: string;
}

export type RecordKind = 'heartbeat' | 'lease' | 'message' | 'ack' | 'device';
export type RecordOf<K extends RecordKind> = K extends 'heartbeat' ? Heartbeat : K extends 'lease' ? Lease : K extends 'message' ? Message : K extends 'ack' ? Ack : DeviceRecord;
export type AnyRecord = Heartbeat | Lease | Message | Ack | DeviceRecord;

/** §3.5: the in-memory fold every reader uses (caps: ≤ 512 heartbeats, ≤ 2,048 leases, ≤ 200 messages per target) */
export interface Fold {
  /** by runId */
  live: Map<string, Heartbeat & { arrivalMono: number }>;
  /** stale ≤ 10 min, keeps stage/action80/touched (§3.4); older rows stay for `listSessions(…, { all: true })` */
  gone: Map<string, Heartbeat & { arrivalMono: number; goneAtMono: number }>;
  /** leaseId → lease */
  leases: Map<string, Lease>;
  /** toplevel-relative path → leaseIds */
  byPath: Map<string, string[]>;
  /** every message addressed to any of my targets */
  inbox: Message[];
  /** acks by msgId */
  acks: Map<string, Ack[]>;
  devices: Map<string, DeviceRecord & { lastSeen: string; syncLagMs: number | null; ignored: boolean; cloned: boolean }>;
  /**
   * §3.2 / §10.3 (design revision 5): every `deviceId` the fold saw TWO OR MORE live heartbeats for with DIFFERENT
   * `bootId`s — one `deviceKey` on two machines, which can therefore no longer speak for either. The write facade
   * suspends every gated action for such a device until it is re-paired; a peer never deletes or rewrites anything of
   * theirs. For MY OWN deviceId this is the `duplicate-identity` case and the later booter adopts a new id (§3.2).
   * A separate set because a clone may have no `device.json` in the fold at all.
   */
  cloned: Set<string>;
  /**
   * + review major 12: the liveness verdict of EVERY heartbeat the fold holds — the claim holder AND every fork — by
   * `${deviceId}/${runId}/${pid}`. `listSessions` shows one row per record; without this a fork row has no verdict.
   */
  liveness: Map<string, Liveness>;
  /**
   * + review minor 25: heartbeats read from a device this host has tombstoned (§4.6 row 4). They are kept OUT of
   * `live` / `gone` / `leases` / `inbox` — nothing they say may move a decision — and exist only so `sessions who --all`
   * can walk them and `unignoreDevice` has something to show.
   */
  ignored: Map<string, Heartbeat & { arrivalMono: number }>;
  skipped: number;
  at: { wallMs: number; monoMs: number };
  /** + §9.3 fork rule: every heartbeat for a runId beyond the holder (the lowest CLAIM), by runId; absent = none */
  forks?: Map<string, (Heartbeat & { arrivalMono: number })[]>;
  /** + review blockers 5 / 6: the origin of every heartbeat in `live` / `gone` / `forks`, by `${deviceId}/${runId}` */
  origins: Map<string, RecordOrigin>;
}

/** who is asking — everything liveness and matching need; computed by ids.ts; `runId`/`sessionId` null for a TUI without a run or a CLI twin */
export interface SelfIdentity {
  deviceId: string;
  label: string;
  host: string;
  user: string;
  /**
   * §3.2 (design revision 4): `hostKey = sha8(hostname(), userInfo().username, machineId)` — THREE inputs. The revision-3
   * two-input hash collided exactly in §11 row 3's supported case (two default-named Macs, cloned VMs, a corporate image
   * sharing one `~/.jevcode`): both machines adopted one `deviceId` and each read the other's records as `sameDevice`.
   * Absent = the machine identifier could not be read; the reader then stays permissive (hostKey DENIES, never grants).
   */
  hostKey?: string;
  bootAt: string;
  /**
   * §3.2 / §3.4 (design revision 5): this process's boot identity, resolved by the caller (one bounded local `sysctl` /
   * `/proc` read, cached per process). `null` = unknown, which stays permissive exactly as an unknown `hostKey` does.
   */
  bootId?: string | null;
  sessionId: string | null;
  runId: string | null;
  wsKey: string;
  repoKey: string | null;
  remoteKey: string | null;
  branch: string | null;
}

/**
 * + review blocker 1: every identity fact the surface keys on moves during one process — `sessionId` / `runId` are null for
 * a TUI without a run and change at the first submit and on `/resume`, `repoKey` arrives after `run:ready`, `branch` moves.
 * `Ledger.setIdentity(patch)` takes this and re-derives the watch roots, the inbox targets, the lease directory and the stamp.
 */
export type IdentityPatch = Partial<Pick<SelfIdentity, 'sessionId' | 'runId' | 'repoKey' | 'remoteKey' | 'branch' | 'label'>>;

/** §3.4 (`gone` = stale ≤ 10 min with facts kept) */
export type Liveness = 'live' | 'stale' | 'stale-reused-pid' | 'gone' | 'unknown';

/** + the full `isLive` answer: the class plus the display flags §3.4 derives beside it */
export interface LivenessVerdict {
  liveness: Liveness;
  hung: boolean;
  skewed: boolean;
  skewMs: number | null;
}

/** + what `isLive` needs from the reader: its own device, boot time, pid probe and the sync slack */
export interface LivenessEnv {
  deviceId: string;
  /** ISO: the reader's boot time (`os.uptime()`); a same-device record whose `startedAt` predates it is `stale-reused-pid` */
  bootAt: string;
  /** §3.2 / §5.4 rule 4: this reader's `hostKey`; a record carrying a DIFFERENT one is never same-device, whatever the path says */
  hostKey?: string;
  /**
   * §3.2 / §3.4 (design revision 5): this reader's `bootId`. A local-subtree record naming a DIFFERENT one is judged by
   * beat freshness (a live clone keeps renewing; a previous boot of this machine does not) and by pid death — never by
   * `startedAt ≥ bootAt`, the wall-arithmetic rule revision 5 withdraws (a forward clock step read a LIVE process as
   * `stale-reused-pid`, after which `takeRunLock` replaced its lock and two engines co-wrote one `state.json`).
   */
  bootId?: string | null;
  isPidAlive: (pid: number) => boolean;
  /** foreign staleness bound beyond `ttlMs` (120 s shared-dir, 180 s git) */
  syncSlackMs?: number;
  /** + review minor 26: the bound for a peer whose `device.json` says `syncMode:'git'` (180 s); defaults to `syncSlackMs` */
  gitSyncSlackMs?: number;
}

export interface SessionActivity {
  runId: string;
  sessionId: string;
  parentSessionId: string | null;
  deviceId: string;
  label: string;
  sameDevice: boolean;
  kind: 'run' | 'bench';
  liveness: Liveness;
  flags: { hung: boolean; skewed: boolean; forked: boolean; takenOver: boolean; noLock: boolean; ignoredDevice: boolean; unverified: boolean; cloned: boolean };
  /** + review blockers 5 / 6: `'self'` = read from my own local subtree; `'trusted'` = hmac-valid from a paired device */
  authority: Authority;
  /** beatAt − wall now when skewed (> 300 s); display only (§3.4) */
  skewMs: number | null;
  /** wall clock, display only — NEVER a liveness input */
  beatAgeMs: number;
  /** foreign: monotonic ms since the fold first saw this beatSeq — the liveness input */
  arrivalAgeMs: number | null;
  /** §9.2 */
  syncLagMs: number | null;
  sameRepo: boolean;
  sameBranch: boolean | null;
  heartbeat: Heartbeat;
  leases: Lease[];
}

export type FoldChange =
  | { kind: 'heartbeat' | 'lease' | 'message' | 'ack' | 'device'; deviceId: string; id: string }
  | { kind: 'poll' }
  | { kind: 'offline'; code: string }
  | { kind: 'online' };

export interface Ledger {
  readonly root: string;
  readonly self: SelfIdentity;
  readonly fold: Readonly<Fold>;
  /** after renderer.firstFrame() (§3.5): the initial fold + watchers; zero I/O before it is called */
  open(): Promise<void>;
  /**
   * + review blocker 1: adopt a moved identity fact and re-derive everything keyed on it — the watch roots
   * (the per-device `leases/<dev>/<repoKey>` and `inbox/<dev>` dirs), the fold's inbox targets, the lease directory and the stamp clock's `runId`.
   * The in-memory half is synchronous and idempotent (the fold is rebuilt from records already held, so a message to the
   * new `sessionId` appears with no I/O). The returned promise resolves after ONE BOUNDED WALK of every root the patch
   * ADDS (design revision 4, §3.5): `fs.watch` reports future changes only, so a newly reachable
   * `leases/<dev>/<keyDir>/` would stay invisible until the 15 s poll and the first `check()` after a `/resume` could
   * read `clear` by ignorance. The engine calls it once after `run:ready`, the host at `run:start`, `run:end` and `/resume`.
   */
  setIdentity(patch: IdentityPatch): Promise<void>;
  /** change notifications; the unsubscribe function; callbacks run on the debounce tick, never inside a watcher callback */
  subscribe(cb: (fold: Readonly<Fold>, change: FoldChange) => void): () => void;
  close(): Promise<void>;
}

/** §4.3 lifecycle, exact shapes */
export interface LeaseIntent {
  paths: string[];
  type: Lease['type'];
  command60?: string;
  exclusiveTree?: boolean;
  /** + `type:'lane'`: the run-relative lane dir (§6.2) */
  laneDir?: string;
  /** + `type:'worktree'`: the session-worktree slug (§6.5) */
  slug?: string;
  reason60: string;
  step: number;
  stage: CoordStageName;
  branch: string | null;
  head: string | null;
}
export interface LeaseConflict {
  leaseId: string;
  path: string;
  holder: { runId: string; sessionId: string; deviceId: string; label: string; sameDevice: boolean };
  holderStep: number;
  holderStage: string;
  holderPhase: RunPhase;
  agoMs: number;
  /** same branch or unknown → hard; different branches → soft (§4.3 step 2) */
  severity: 'hard' | 'soft';
  sameBranch: boolean | null;
  theyTouched: boolean;
  exclusiveCommand: string | null;
  expiresInMs: number;
  stamp: Stamp;
}
export type LeaseCheck =
  | { kind: 'clear'; /** + the lease ids the judgment was made over — the strict fence's "was it there before my write?" set */ snapshot: readonly string[] }
  | {
      kind: 'conflict';
      conflicts: LeaseConflict[];
      /**
       * an overlapping exclusive lease with a LOWER stamp exists (§4.5), OR — review blocker 4 — one appeared in the
       * write-then-read window that the judgment could not have seen. Either way the judgment re-runs NOW.
       */
      contested: boolean;
      requested: { path: string; by: string; agoMs: number }[];
      snapshot: readonly string[];
    };

/**
 * + review blocker 4: the strict write-then-read fence is SYMMETRIC. `refold` is the judgment re-run after my own rename
 * settled and every peer's lease dir was listed once; `appeared` holds the overlapping leases that were NOT in the snapshot
 * `check()` judged over — a lease the other side could not have seen either. Any non-empty `appeared` re-runs the judgment
 * regardless of stamp order (the stamp only decides who is DISPLAYED as holder), so of two racing writers at least one —
 * and never zero — yields.
 */
/**
 * §4.5 (design revision 4), the two outcomes of a strict declare, both explicit.
 *
 * `fence:'decided'` carries `appeared` — every overlapping exclusive lease present now that was ABSENT from the
 * snapshot `check()` judged over — and **F1: `proceed = appeared.length === 0`. Yield on sight, never proceed on
 * sight.** A local stamp test here is exactly what let both writers proceed in the one-sees interleaving (A renames
 * first, sees nothing, proceeds; B renames second with a LOWER stamp, sees A, and a local "lower stamp wins" test would
 * have B proceed too). Sight, not order, is what stops you; at most one overlapping writer gets `proceed: true` in ANY
 * interleaving, because two empty `appeared` sets would need each `readdir` to precede the other's rename.
 *
 * `proceed: false` means YIELD: `downgrade()` to `'intent'` and enter the §4.3 step-4 wait, whose F2 wake rule
 * (`f2Wake`) lets the LOWEST stamp among the mutually-yielded set re-declare — that is where "the lower stamp proceeds"
 * actually happens, and it happens ~2 ms later rather than after `strictWaitMs`.
 *
 * `fence:'blind'` is a bound reached before the enumeration finished (`MAX_FENCE_DEVICES` / `STRICT_FENCE_MS`): strict
 * refuses to guess and the caller takes the rule-1 discard + `lease-conflict` pane.
 *
 * Nothing on this path consults Jev, a pane, `theyTouched` or `coordination.default`, so `jev-on`, `jev-off`,
 * `--no-input`, a Jev outage and a bench machine all decide identically.
 */
export type StrictDeclare =
  | (LeaseHandle & { fence: 'decided'; refold: LeaseCheck; appeared: LeaseConflict[]; proceed: boolean })
  | (LeaseHandle & { fence: 'blind'; scanned: number; total: number });

/** §4.5: the overlapping exclusive lease ids a `check()` saw, so the re-fold can say which APPEARED afterwards. */
export type LeaseSnapshot = ReadonlySet<string> | readonly string[];
export interface LeaseHandle {
  leaseId: string;
  stamp: Stamp;
  renew(): void;
  /**
   * §4.5 F1 (design revision 4): `'exclusive'` → `'intent'` on a fence yield — same stamp, same leaseId, so every
   * observer keeps agreeing about the order while this side stops being a fence for anyone else. Awaited: the yield is
   * only real once the rename has landed.
   */
  downgrade(): Promise<void>;
  release(outcome: LeaseOutcome, changed?: Record<string, string | null>, head?: string): void;
}

// ── the write API the product surface needs (+ review blocker 2) ──────────────────────────────────────────────────────

/**
 * + review major 11 / re-review (5)(e) — NOTE FOR CORE: the field `src/checkpoint`'s `RunMeta` must carry, declared
 * here until `RunMeta` is unfrozen.
 *
 * The fold only knows the epochs of records it can still SEE. A run whose earlier incarnations have been GC'd (ended
 * heartbeats go after 24 h) or whose peer subtree has not synced yet would otherwise re-mint an epoch a previous
 * incarnation already used, and `compareClaim` would return 0 for two different processes — the one case §9.3's fork
 * rule cannot decide. `claimEpochHigh` is the monotonic high-water mark persisted beside the run and fed back through
 * `nextEpoch(runId, { epochHigh })`. `claims` is bounded by `CLAIMS_MAX` and each row carries the authority it was read
 * with, so an unverified foreign row never raises the bar (re-review (5)).
 */
export interface RunClaimMeta {
  /** `max(epoch)` this device has ever minted or accepted for the run */
  claimEpochHigh: number;
  /** append-only, newest last, ≤ CLAIMS_MAX rows */
  claims: { epoch: number; deviceId: string; startedAt: string; authority: Authority }[];
}

/** §6.5 worktree metadata — `coordination/worktrees/<repoKey>/<slug>.json`, outside every checkout and sandbox root */
export interface WorktreeRecord {
  v: 1;
  repoKey: string;
  slug: string;
  runId: string;
  sessionId: string;
  deviceId: string;
  /** the worktree directory, clipped to 60 chars for display; the full path is derived from `home` + repoKey + slug */
  dir60: string;
  branch: string;
  base: string;
  createdAt: string;
  /** the ignored files the parent's dirty-set sync copied in (≤ 64) */
  syncedIgnored: string[];
  checksum: string;
}

export interface GcReport {
  removed: number;
  /** by kind, for `sessions gc` output */
  byKind: Record<'heartbeat' | 'lease' | 'message' | 'ack', number>;
  /** lane dirs of dead runs the sweep may prune (§6.2 (a)) — paths are never removed by the ledger itself */
  staleLanes: { runId: string; laneDir: string }[];
  /** files that could not be removed, by errno — a GC never throws for a disk fault (§11 row 13) */
  failed: { path: string; code: string }[];
}

/** `sessions inbox --purge <device>` — our own outbox files are removed; a foreign message is only marked seen. */
export interface PurgeReport {
  /** our own outbox files removed */
  removed: number;
  /** foreign messages added to this consumer's `seen` set (nothing foreign is ever deleted — §4.6) */
  muted: number;
  failed: { path: string; code: string }[];
}
/**
 * + re-review (2): the shapes the product surface's verbs return, with their error semantics stated once.
 * Every verb REPORTS failure (an errno row) and never throws for a disk fault: a coordination write is bookkeeping
 * (§11 row 13). `ConfigError` is reserved for a caller mistake (a bad id, an empty label, an unknown slug).
 */
export interface WorktreeInfo {
  repoKey: string;
  slug: string;
  runId: string;
  sessionId: string;
  deviceId: string;
  branch: string;
  base: string;
  createdAt: string;
  /** the absolute worktree directory (derived from `home`, never read from the record) */
  dir: string;
  /** what the §6.6 guards say about it right now; `removable` means every guard passed */
  state: 'removable' | 'live' | 'dirty' | 'unmerged' | 'too-young' | 'not-ours' | 'unknown' | 'git-failed';
  detail: string;
}

/** §9.1 / §9.2: what `sessions sync` prints; `state: 'off'` when no shared dir is configured. */
export interface SyncStatus {
  mode: 'off' | 'shared-dir' | 'git';
  state: 'off' | 'unknown' | 'online' | 'offline';
  /** the errno that took the mirror offline, or null */
  code: string | null;
  /** §9.2: our own write → read-back lag */
  lagMs: number | null;
  /** copies queued behind an offline mirror */
  pending: number;
  /** monotonic ms the mirror has been offline; past `MIRROR_OFFLINE_NOTICE_MS` the status zone says `⇄ offline` */
  offlineForMs: number | null;
  /** the mirror root was refused (it resolves inside the coordination root — re-review (6)(ii)) */
  refused: string | null;
}

/** §4.1 advisory facts for one step */
export interface CoordinationFacts {
  step: number;
  /** ≤ 8 */
  conflicts: LeaseConflict[];
  /** ≤ 8 */
  requested: { path: string; by: string; agoMs: number }[];
  /** ≤ 8; text ≤ 300 */
  messages: { from: string; type: MessageType; text: string; at: string }[];
  others: number;
}
