/**
 * TUI-DESIGN-5 §2.14 (slot R5-1) — **the write half**: what this session PUBLISHES.
 *
 * §2 is otherwise all reads. The review (§14.2 #3, N8) found that nothing in the design started a heartbeat, minted
 * a claim or wrote a lease, so in a real install the `Fold` would never contain this session, every §2 surface
 * would render its empty state forever, and requirement 1 would be reachable only under fixtures.
 * `createHeartbeatWriter` / `buildHeartbeat` / `HeartbeatWriter` are built and exported today
 * (`src/coordination/index.ts:326`) with zero callers; this module is the one caller, and `src/cli/session.ts`
 * drives it.
 *
 * Three invariants, each a test in `test/unit/session/publish.test.ts`:
 *
 *  1. **Nothing is written before the first frame.** `start()` awaits `deps.firstFrame()` and only then the one
 *     `await import('../coordination/index.js')` (§2.1 rule 3a) and `ledger.open()`. The heartbeat writer's FIRST
 *     write is therefore provably post-`firstFrame()`, which is what gate G-R5-1 asserts.
 *  2. **The claim is minted only after `claimRefusal` returns null.** Minting past a qualified foreign claim is the
 *     double-writer hole `compareClaim` exists to close (§2.8, §7 rows 15/27).
 *  3. **The writer is stopped in the same `finally` that releases the run lock.** A clean exit leaves no beating
 *     record; the writer must NEVER write a "clean" terminal beat it cannot guarantee, because the last beat on
 *     disk after a crash is exactly what makes §7 row 3's `crashed during step 8` row possible.
 *
 * No `setInterval` here: `createHeartbeatWriter`'s own coalescing (`HEARTBEAT_COALESCE_MS`) is the tick, so the
 * "`setInterval(` only in spinner.ts / retry.ts" rule (D-AA) holds. Nothing in this module imports
 * `src/coordination/**` as a value — `deps.open` is the seam, and the default one is the dynamic import.
 */
import type { LeaseIntent } from '../coordination/index.js';
import type { GitHead, GitState } from '../core/types.js';

/** §2.8: what `claimRefusal(readClaimEpochs(runId), foreignClaimsOf(fold, runId))` answers, as the session needs it. */
export interface PublishRefusal {
  /** §12.1 S11 / S15 — the sentence the caller prints; `claimRefusal` owns the wording, never this module */
  readonly message: string;
  /** `'taken-over'` (S11, `--force-takeback` re-takes it) or `'ceiling'` (S15, a permanent bound) */
  readonly kind: 'taken-over' | 'ceiling';
}

/** the heartbeat writer's two members this module uses (`HeartbeatWriter`, `src/coordination/heartbeat.ts`). */
export interface HeartbeatWriterLike {
  stop(): void | Promise<void>;
}

/** one advisory lease, as §2.14 row 3 needs it: written when a step declares targets, released at step commit. */
export interface LeaseHandleLike {
  release(outcome: 'committed' | 'discarded'): void | Promise<void>;
}

/**
 * §2.1 rule 1 / rule 3a: the NARROW coordination seam. The real one is built by the caller behind
 * `await import('../coordination/index.js')`; the tests inject a fake. Nothing here is a coordination *type* that
 * carries a secret: `SelfIdentity.hostKey` never crosses this boundary.
 */
export interface PublishLedger {
  open(): Promise<void>;
  close(): Promise<void>;
  /** §2.8: read BEFORE the mint, in the same pre-`createEngine` sequence */
  claimRefusal(): PublishRefusal | null;
  /** `nextEpoch` + `writeClaimsProjection` through the facade; once per run start, NEVER per step */
  mintClaim(opts: { forceTakeback: boolean }): Promise<void>;
  /** `createHeartbeatWriter(...)`; its own coalescing is the tick */
  startHeartbeat(): HeartbeatWriterLike;
  declare(intent: LeaseIntent): Promise<LeaseHandleLike>;
}

export interface PublishDeps {
  /**
   * resolves when the renderer has painted frame 1. §1.4 promise 1 and gate G-R5-1: every coordination write is
   * after it, and `--plain` / headless callers resolve it immediately.
   */
  firstFrame: () => Promise<void>;
  /** the one dynamic import; called only after `firstFrame()` resolves */
  open: () => Promise<PublishLedger>;
  /** `/resume --force-takeback` bumps the epoch; an ordinary `/resume` of an uncontested run does not (§7 row 26) */
  forceTakeback?: boolean;
  /** a `[ui]` line for a refusal or a failed open; the session never dies because coordination did */
  onNotice?: (text: string) => void;
}

/** what `start()` answers: the session is publishing, or it is not and the reason is a pinned sentence. */
export type PublishStart = { readonly kind: 'publishing' } | { readonly kind: 'refused'; readonly refusal: PublishRefusal } | { readonly kind: 'unavailable'; readonly reason: string };

export interface Publisher {
  /** idempotent: a second `start()` is a no-op that re-answers the first outcome */
  start(): Promise<PublishStart>;
  /** §2.14: per step, from the step's declared targets. A no-op when the ledger never opened. */
  declare(intent: LeaseIntent): Promise<LeaseHandleLike | null>;
  /**
   * §2.14 row 1: called from the SAME `finally` that releases the run lock. Never throws, never writes a terminal
   * beat, and is idempotent — an exit path that runs it twice must not fail the process.
   */
  stop(): Promise<void>;
  /** test/inspection only: has the heartbeat writer been started? */
  readonly beating: boolean;
}

export function createPublisher(deps: PublishDeps): Publisher {
  let ledger: PublishLedger | null = null;
  let writer: HeartbeatWriterLike | null = null;
  let started: Promise<PublishStart> | null = null;
  let stopped = false;

  const run = async (): Promise<PublishStart> => {
    // invariant 1: NOTHING before the first frame — not the import, not `open()`, not a beat
    await deps.firstFrame();
    let l: PublishLedger;
    try {
      l = await deps.open();
      await l.open();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      deps.onNotice?.(`the session ledger could not open (${reason}) — /who and /peers show their empty state`);
      return { kind: 'unavailable', reason };
    }
    if (stopped) {
      await l.close().catch(() => undefined);
      return { kind: 'unavailable', reason: 'the session exited before the ledger opened' };
    }
    ledger = l;
    // invariant 2: the refusal is READ before the mint. A refusal means no claim, no beat and no lease — a refused
    // session must not appear in the fold as a second writer of this run.
    const refusal = l.claimRefusal();
    if (refusal !== null) {
      deps.onNotice?.(refusal.message);
      return { kind: 'refused', refusal };
    }
    await l.mintClaim({ forceTakeback: deps.forceTakeback === true });
    /**
     * Invariant 3, the SECOND check. `stop()` can run at any await in this function — `src/cli/session.ts` fires
     * `void publisher.start()` and `finishSession`'s exit path calls `stopPublishing()` — and a check taken only
     * after `open()` left a short `--mock` run (or a Ctrl-C landing inside `mintClaim`) starting a heartbeat
     * writer on a ledger `stop()` had already closed: the beats outlived the session for the life of the process.
     * `stop()` also awaits this promise before tearing down, so the two orders are equivalent.
     */
    if (stopped) {
      await l.close().catch(() => undefined);
      ledger = null;
      return { kind: 'unavailable', reason: 'the session exited before the ledger opened' };
    }
    writer = l.startHeartbeat();
    return { kind: 'publishing' };
  };

  return {
    start(): Promise<PublishStart> {
      started ??= run();
      return started;
    },
    async declare(intent: LeaseIntent): Promise<LeaseHandleLike | null> {
      // a lease is ADVISORY this round: nothing in the local loop reads one, so §1.4 promise 2 is unchanged and a
      // failed declare is a missing row on a peer's `/who`, never a stalled step.
      if (ledger === null || writer === null) return null;
      try {
        return await ledger.declare(intent);
      } catch {
        return null;
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      /**
       * `stop()` deliberately does NOT await the in-flight `started`: `run()` begins with `await
       * deps.firstFrame()`, which under the Ink renderer resolves only when frame 1 paints, so awaiting it here
       * would make an exit before the first frame hang forever. The re-checks of `stopped` past every await in
       * `run()` are what close the race — a `start()` that resumes after this point closes its own ledger and
       * never reaches `startHeartbeat()`.
       */
      const w = writer;
      const l = ledger;
      writer = null;
      ledger = null;
      try {
        await w?.stop();
      } catch {
        /* the writer is bookkeeping; a failed stop must not fail the exit path */
      }
      try {
        await l?.close();
      } catch {
        /* same */
      }
    },
    get beating(): boolean {
      return writer !== null;
    },
  };
}

// ── the real seam: one dynamic import, one `openLedger`, one `close` (§2.1 rule 3a) ──────────────────────────────

/** What `src/cli/session.ts` knows about this run when it starts publishing (§2.14). */
export interface SessionLedgerInput {
  /** `~/.jevcode` */
  home: string;
  /** the workspace REALPATH (`wsKeyOf`'s input) */
  workspace: string;
  hostname: string;
  username: string;
  jevcode: string;
  pid: number;
  runId: string;
  sessionId: string;
  parentSessionId: string | null;
  parentRunId: string | null;
  source: 'cli' | 'bench' | 'perf';
  task60: string;
  title60: string | null;
  mode: string;
  maxSteps: number;
  maxWallMs: number;
  branch: string | null;
  head: string | null;
  /**
   * §3.2 / §7 rows 7–9: the repository identity. `repoKeyOf` derives it from the ROOT COMMITS (so two clones and
   * two linked worktrees of one repository meet) and from the origin URL; a session that leaves both `null`
   * degrades `sameRepo` to exact `wsKey` equality, and two worktrees of one repo never see each other.
   *
   * The caller may supply the keys directly (a test, or a build that probed already). Otherwise
   * `openSessionLedger` resolves them itself: the per-workspace cache first (`readRepoKeyCache`), then
   * `repoFacts()` — a bounded probe the caller injects — and writes the result back. Everything here is
   * post-first-frame and off the critical path (§1.4 promise 2).
   */
  repoKey?: string | null;
  remoteKey?: string | null;
  /** `git rev-list --max-parents=0 HEAD` + `--is-shallow-repository` + `remote.origin.url`, bounded; null = unknown */
  repoFacts?: () => Promise<{ rootOids: readonly string[]; shallow: boolean; originUrl: string | null } | null>;
  /** `--git-common-dir` — the cache entry records it so a moved checkout invalidates itself */
  commonDir?: string | null;
  dirtyAtStart: boolean;
  linkedWorktree: boolean;
  worktreeSlug: string | null;
  bootAt: string;
  label?: string;
  sharedDir?: string | null;
  redact?: (s: string) => string;
}

/** The opened ledger plus the two reads `/peers` and `/who` need (§2.3, §2.4); `close()` is the publisher's. */
export interface SessionLedger extends PublishLedger {
  /** the live fold — `peerViewOf`'s and `listSessions`' input; it is the ledger's own object, never a copy */
  readonly fold: import('../coordination/index.js').Fold;
  readonly self: import('../coordination/index.js').SelfIdentity;
  /** `listSessions(fold, self, opts)` through the facade, so `src/cli/session.ts` needs no coordination import */
  list(opts?: { all?: boolean }): readonly import('../coordination/index.js').SessionActivity[];
  /**
   * The claim the last `mintClaim()` decided — the SAME object the heartbeat base carries, which is what makes
   * `publish.test.ts` able to assert that the projection's epoch and the beat's epoch cannot diverge (§7 row 27).
   */
  mintedClaim(): import('../coordination/index.js').Claim;
  /** what `repoKeyOf` resolved for this workspace (cache hit or fresh probe), as the beat and `SelfIdentity` carry it */
  readonly repoKeys: { repoKey: string | null; remoteKey: string | null };
  /** re-render on every fold change (the zone re-renders on a change, never on a timer — gate G-R5-3) */
  subscribe(cb: () => void): () => void;
}

/**
 * §2.1 rule 3a / §2.14: the ONE place the coordination tree is loaded. Every import below is inside this function
 * body, so `src/cli/main.tsx`'s transitive STATIC graph never reaches `src/coordination/**` and gate G-R5-1 holds.
 * The caller only ever runs it after `renderer.firstFrame()` resolved (`createPublisher` enforces that).
 */
export async function openSessionLedger(input: SessionLedgerInput): Promise<SessionLedger> {
  const c = await import('../coordination/index.js');
  const root = c.coordinationRoot(input.home);
  const identity = await c.deviceIdentity({
    root,
    fs: c.nodeFs,
    hostname: input.hostname,
    username: input.username,
    jevcode: input.jevcode,
    nowIso: new Date().toISOString(),
    ...(input.label !== undefined ? { label: input.label } : {}),
  });
  const keys = await resolveRepoKeys(c, identity.hostKey, input);
  const self: import('../coordination/index.js').SelfIdentity = {
    deviceId: identity.device.deviceId,
    label: identity.device.label,
    host: input.hostname,
    user: input.username,
    hostKey: identity.hostKey,
    bootAt: input.bootAt,
    sessionId: input.sessionId,
    runId: input.runId,
    wsKey: c.wsKeyOf(input.workspace),
    repoKey: keys.repoKey,
    remoteKey: keys.remoteKey,
    branch: input.branch,
  };
  /**
   * The identity claim `openLedger` is seated with. Its epoch is provisional (`mintClaim([])` yields
   * `FIRST_EPOCH`); `mintClaim(opts)` below replaces `minted` with the real one **before** `startHeartbeat()` can
   * read it. Peers rank forks by the epoch **on the beat** (`compareClaim` is epoch-desc first,
   * `src/coordination/claims.ts:85`), so a heartbeat that kept epoch 1 after a `--force-takeback` broadcast a
   * claim this session had just beaten and lost every comparison it won (§7 rows 15/26/27, §2.8's fence).
   */
  const claim = c.mintClaim({ deviceId: self.deviceId, runId: input.runId, pid: input.pid, at: new Date().toISOString() });
  let minted: import('../coordination/index.js').Claim = claim;
  const handle = c.openLedger({
    home: input.home,
    self,
    claim,
    pid: input.pid,
    ...(input.sharedDir !== undefined ? { sharedDir: input.sharedDir } : {}),
    ...(input.redact !== undefined ? { redact: input.redact } : {}),
  });
  const repo: import('../coordination/index.js').Heartbeat['repo'] = {
    wsKey: self.wsKey,
    repoKey: keys.repoKey,
    remoteKey: keys.remoteKey,
    basename: input.workspace.split('/').filter((s) => s !== '').pop() ?? input.workspace,
    branch: input.branch,
    head: input.head,
    dirtyAtStart: input.dirtyAtStart,
    linkedWorktree: input.linkedWorktree,
    worktreeSlug: input.worktreeSlug,
  };
  return {
    fold: handle.fold,
    self,
    repoKeys: keys,
    open: () => handle.open(),
    close: () => handle.close(),
    list: (opts = {}) => c.listSessions(handle.fold, self, opts),
    subscribe: (cb) => handle.subscribe(() => cb()),
    /**
     * §2.8 / §7 rows 27–29: `claimRefusal(readClaimEpochs(runId), foreignClaimsOf(fold, runId))`. Unqualified
     * epochs are skipped by `claimRefusal` itself (`claims.ts:274`) and epochs outside `[FIRST_EPOCH,
     * MAX_CLAIM_EPOCH]` are dropped (`:275`), so a planted claim ANNOTATES the card and never refuses here.
     */
    claimRefusal(): PublishRefusal | null {
      const mine = c.seenEpochs(handle.fold, input.runId);
      // §9.3's qualifier: an UNVERIFIED origin is not qualified, so a planted beat annotates and never refuses
      const foreign = c
        .byRunId(handle.fold, input.runId)
        .filter((hb) => hb.deviceId !== self.deviceId)
        .map((hb) => ({ epoch: hb.claim.epoch, deviceId: hb.deviceId, at: hb.claim.at, label: hb.label, qualified: c.authorityOf(c.originOf(handle.fold, hb)) !== 'unverified' }));
      const refusal = c.claimRefusal(mine, foreign);
      if (refusal === null) return null;
      const holder = foreign.find((f) => f.epoch === refusal.epoch && f.deviceId === refusal.deviceId);
      if (refusal.epoch >= c.MAX_CLAIM_EPOCH) {
        return { kind: 'ceiling', message: 'claim epochs for this run reached the bound (1e9); nothing can take it over — start a new run from this state' };
      }
      const label = holder?.label ?? handle.fold.devices.get(refusal.deviceId)?.label ?? refusal.deviceId.slice(0, 8);
      const at = (holder?.at ?? '').slice(11, 16);
      return { kind: 'taken-over', message: `taken over by ${label} at ${at} (claim ${refusal.epoch}); /resume --force-takeback re-takes it` };
    },
    /** the ONE place the epoch is decided; the projection and the heartbeat base both read `minted` after it. */
    async mintClaim(opts): Promise<void> {
      const seen = c.seenEpochs(handle.fold, input.runId);
      const epoch = opts.forceTakeback ? c.forceTakebackEpoch(seen) : c.ordinaryMintEpoch(seen);
      minted = { ...claim, epoch };
      await handle.writeClaimsProjection({ runId: input.runId, sessionId: input.sessionId, claims: [minted] });
    },
    /** test/inspection only: the claim the last `mintClaim()` decided (the identity claim before the first one). */
    mintedClaim: () => minted,
    startHeartbeat(): HeartbeatWriterLike {
      const writer = c.createHeartbeatWriter({
        ledger: handle,
        base: {
          deviceId: self.deviceId,
          label: self.label,
          host: input.hostname,
          user: input.username,
          pid: input.pid,
          ...(identity.hostKey !== undefined ? { hostKey: identity.hostKey } : {}),
          bootAt: input.bootAt,
          jevcode: input.jevcode,
          runId: input.runId,
          sessionId: input.sessionId,
          parentSessionId: input.parentSessionId,
          parentRunId: input.parentRunId,
          source: input.source,
          title60: input.title60,
          task60: input.task60,
          // the MINTED claim, not the identity one: `createPublisher` always mints before it starts the writer
          claim: minted,
          repo,
          mode: input.mode as import('../core/types.js').EngineMode,
          maxSteps: input.maxSteps,
          maxWallMs: input.maxWallMs,
          startedAt: new Date().toISOString(),
        },
      });
      writer.start();
      return { stop: () => writer.stop() };
    },
    /**
     * §2.14 row 3: ADVISORY only this round. `declare(ledger, intent, 'advisory')` is synchronous by design — the
     * write is enqueued on the ledger chain — so nothing in the local loop waits on a peer and §1.4 promise 2 holds.
     */
    declare: (intent) => {
      const h = c.declare(handle, intent, 'advisory');
      return Promise.resolve({ release: (outcome: 'committed' | 'discarded') => c.release(h, outcome) });
    },
  };
}

/**
 * §3.2 / §7 rows 7–9: resolve this workspace's `repoKey` / `remoteKey`, cheapest source first.
 *
 *  1. what the caller already knows (a test, or a build that probed on its own path);
 *  2. `readRepoKeyCache` — one bounded 4 KiB read of `<hostDir>/repokeys/<sha16(ws)>.json`, valid while the
 *     checkout's `--git-common-dir` has not changed (that is what `commonDir60` on the entry is for);
 *  3. the injected `repoFacts()` probe, through `repoKeyOf`, written back to the cache.
 *
 * Every arm fails soft to `{ null, null }`: a session that cannot name its repository still publishes, it just
 * meets peers by `wsKey` alone. Nothing here runs before the first frame — `createPublisher` guarantees that.
 */
async function resolveRepoKeys(
  c: typeof import('../coordination/index.js'),
  hostKey: string | undefined,
  input: SessionLedgerInput,
): Promise<{ repoKey: string | null; remoteKey: string | null }> {
  if (input.repoKey !== undefined || input.remoteKey !== undefined) {
    return { repoKey: input.repoKey ?? null, remoteKey: input.remoteKey ?? null };
  }
  const paths = c.commonsPaths(c.coordinationRoot(input.home), hostKey);
  const commonDir60 = (input.commonDir ?? '').slice(0, 60);
  try {
    const cached = await c.readRepoKeyCache(c.nodeFs, paths.hostDir, input.workspace);
    if (cached !== null && (commonDir60 === '' || cached.commonDir60 === commonDir60)) {
      return { repoKey: cached.repoKey, remoteKey: cached.remoteKey };
    }
  } catch {
    /* an unreadable cache is a cache miss, never a failed open */
  }
  let facts: { rootOids: readonly string[]; shallow: boolean; originUrl: string | null } | null = null;
  try {
    facts = (await input.repoFacts?.()) ?? null;
  } catch {
    facts = null;
  }
  if (facts === null) return { repoKey: null, remoteKey: null };
  const resolved = c.repoKeyOf(facts);
  try {
    await c.writeRepoKeyCache(c.nodeFs, paths.hostDir, input.workspace, { repoKey: resolved.repoKey, remoteKey: resolved.remoteKey, kind: resolved.kind, commonDir60, at: new Date().toISOString() });
  } catch {
    /* the cache is an optimisation; a failed write costs one probe next time */
  }
  return { repoKey: resolved.repoKey, remoteKey: resolved.remoteKey };
}

/** what `repoKeyOf` needs, and what `probeRepoFacts` answers (`src/coordination/ids.ts:153`'s `RepoFacts`). */
export interface RepoFactsProbe {
  rootOids: readonly string[];
  shallow: boolean;
  originUrl: string | null;
}

/** the probe's per-spawn bound; three `git` reads, none of which touches the work tree. */
export const REPO_PROBE_TIMEOUT_MS = 2_000;
const REPO_PROBE_MAX_BUFFER = 256 * 1024;

/**
 * §3.2 / §7 rows 7–9: the three `git` reads `repoKeyOf` needs — the root commits, the shallow flag and the origin
 * URL. Bounded, hardened with `workspace/git.ts`'s own `GIT_BASE_FLAGS` / `GIT_ENV` (no system or global config,
 * no hooks, no credential helper, no pager), and **entirely dynamic**: every import below is inside this function
 * body, so `src/cli/main.tsx`'s static graph gains neither `node:child_process` nor `workspace/git.ts`.
 *
 * `null` on any failure — git missing, not a repository, a timeout. A session that cannot name its repository
 * still publishes; it just meets peers by `wsKey` alone. The result is cached per workspace by
 * `resolveRepoKeys`, so an install pays for this once.
 */
export async function probeRepoFacts(workspace: string, o: { exec?: (args: readonly string[]) => Promise<string | null>; timeoutMs?: number } = {}): Promise<RepoFactsProbe | null> {
  let run = o.exec;
  if (run === undefined) {
    const [{ execFile }, { GIT_BASE_FLAGS, GIT_ENV }] = await Promise.all([import('node:child_process'), import('../workspace/git.js')]);
    const path = process.env['PATH'];
    const env = { ...(typeof path === 'string' && path.length > 0 ? { PATH: path } : {}), ...GIT_ENV };
    run = (args: readonly string[]) =>
      new Promise<string | null>((resolve) => {
        execFile('git', [...GIT_BASE_FLAGS, ...args], { cwd: workspace, env, timeout: o.timeoutMs ?? REPO_PROBE_TIMEOUT_MS, maxBuffer: REPO_PROBE_MAX_BUFFER, windowsHide: true }, (err, stdout) => {
          resolve(err === null ? String(stdout) : null);
        });
      });
  }
  const [roots, shallow, origin] = await Promise.all([run(['rev-list', '--max-parents=0', 'HEAD']), run(['rev-parse', '--is-shallow-repository']), run(['config', '--get', 'remote.origin.url'])]);
  // a repository with an unborn HEAD answers nothing to `rev-list`; that is `{ rootOids: [] }`, not a failure
  if (roots === null && shallow === null && origin === null) return null;
  const rootOids = (roots ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const originUrl = (origin ?? '').trim();
  return { rootOids, shallow: (shallow ?? '').trim() === 'true', originUrl: originUrl === '' ? null : originUrl };
}

// ── the `GitState` → `SessionLedgerInput` mapping (§2.14), pure and testable on its own ──────────────────────────

/**
 * §12.1 S1's `main@3f9a2c1`: the oid of the head, whatever KIND it is. `GitHead`
 * (`src/core/types.ts:953`) is `{kind:'branch'; name; oid: string|null} | {kind:'detached'; oid} |
 * {kind:'unborn'; name}` — reading only the `detached` arm published `head: null` for every ordinary branch
 * checkout, so no peer ever saw a `@sha` (round-5 fix pass, finding 5).
 */
export function headOidOf(head: GitHead | null | undefined): string | null {
  if (head === null || head === undefined) return null;
  if (head.kind === 'branch') return head.oid;
  if (head.kind === 'detached') return head.oid;
  return null;
}

/** the branch NAME of a head, or null (a detached or unborn head has no branch to publish). */
export function branchNameOf(head: GitHead | null | undefined): string | null {
  return head !== null && head !== undefined && head.kind === 'branch' ? head.name : null;
}

/**
 * §2.14: every repository field of `SessionLedgerInput`, from the one `GitState` probe this session already ran.
 * `repoKey` / `remoteKey` are deliberately NOT here — they are `openSessionLedger`'s to resolve, cache and write
 * back (`resolveRepoKeys`), because they cost a probe the caller has not paid for.
 */
export function gitInputOf(git: GitState | null | undefined): Pick<SessionLedgerInput, 'branch' | 'head' | 'dirtyAtStart' | 'linkedWorktree' | 'commonDir'> {
  return {
    branch: branchNameOf(git?.head),
    head: headOidOf(git?.head),
    dirtyAtStart: (git?.dirty.modified ?? 0) + (git?.dirty.staged ?? 0) > 0,
    linkedWorktree: git?.linkedWorktree === true,
    commonDir: git?.commonDir ?? null,
  };
}

/**
 * §7 row 26 / §12.1 S11: the ONE input that may bump the claim epoch. `--force` is a different flag with a
 * different meaning ("resume a run whose stopReason is complete instead of seeding a follow-up",
 * `src/cli/args.ts:269`); reading it here bumped the epoch on every `--resume <id> --force` of a finished run,
 * which §2.14's own table forbids.
 */
export function forceTakebackOf(o: { resumed: boolean; force?: boolean; forceTakeback?: boolean }): boolean {
  return o.resumed && o.forceTakeback === true;
}
