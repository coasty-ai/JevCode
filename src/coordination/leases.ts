/**
 * Leases (§4.3 lifecycle declare → check → proceed | wait | worktree | change approach → release; §4.5 fencing; §12.0.4
 * "Lease API"). `check` is pure over the fold — `O(paths × liveLeases)` map work, no I/O — so the advisory gate costs no
 * file I/O on the step path. `declare` writes on the ledger chain (advisory, fire-and-forget) or awaits its own rename and
 * re-folds every peer's `leases/<repoKey>/` once (strict: the write-then-read fence). Prefix collapse keeps a lease ≤ 64
 * paths and ≤ 8 KiB — conservative, more conflicts never fewer.
 */
import { ConfigError } from '../errors.js';
import { leaseOrigin } from './fold.js';
import { asHandle, type LedgerHandle } from './ledger.js';
import { LANE_DIR_RE, LEASE_PATHS_MAX, isValidRelPath, sameRepo } from './ids.js';
import { leaseRel } from './paths.js';
import { HEARTBEAT_TTL_MS, LEASE_TTL_MS, SYNC_SLACK_SHARED_MS, compareStamp, fitsRecordSize, finalizeRecord, honouredTtlMs, oneLine, overlap, type Now } from './records.js';
import { HOLDING_LEASE_TYPES } from './types.js';
import type { CoordinationFacts, DeclaredFact, FenceYield, Fold, Heartbeat, Lease, LeaseCheck, LeaseConflict, LeaseHandle, LeaseIntent, LeaseOutcome, LeaseSnapshot, Ledger, Message, SelfIdentity, Stamp, StrictDeclare } from './types.js';

/** §4.1 / §4.3 step 4: the strict inline wait bound */
export const STRICT_WAIT_MS = 60_000;
/**
 * §4.3 step 4 (design revision 5): the cap on the post-yield wait — `ttlMs + syncSlackMs + 5 s` (170 s at the
 * defaults). A DERIVED bound, not a new tunable: it is the longest a cross-device peer's death can take to become
 * visible, plus a margin, and past it waiting can no longer be about detecting that death.
 */
export const FENCE_WAIT_CAP_MS = HEARTBEAT_TTL_MS + SYNC_SLACK_SHARED_MS + 5_000;
/** the display path of a whole-tree conflict (an `exclusiveTree` command on either side) */
export const TREE_PATH = '<tree>';
export const FACTS_MAX = 8;
export const FACT_TEXT_MAX = 300;

// ── the command class (§4.2, §11 row 47) ──────────────────────────────────────────────────────────────────────────────

const EXCLUSIVE_TREE_RES: readonly RegExp[] = [
  /(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(run\s+)?(build|perf|test:pty)\b/,
  /(^|[;&|]\s*)cargo\s+build\b/,
  /(^|[;&|]\s*)make(\s|$)/,
  /(^|[;&|]\s*)pytest\s*($|-(?!-?\w*\/)[^\s]*\s*)*$/,
  /(^|[;&|]\s*)git\s+(commit|checkout|switch|rebase|merge|stash|reset|pull|cherry-pick|worktree)\b/,
];

/**
 * `npm run build|perf|test:pty`, `cargo build`, `make`, `pytest` without a path and the git write verbs are `exclusiveTree`
 * commands (the r3 rule "never build/perf/pty while another slot may be"; git's own `index.lock` makes the second command fail).
 */
export function isExclusiveTreeCommand(command: string): boolean {
  const c = command.trim();
  if (/^pytest\b/.test(c)) return !/\s[^-\s][^\s]*/.test(c.slice(6)); // a positional path argument narrows it
  return EXCLUSIVE_TREE_RES.some((re) => re.test(c));
}

// ── prefix collapse (§4.3 step 1, §11 row 34) ─────────────────────────────────────────────────────────────────────────

function prefixAt(path: string, depth: number): string {
  const segs = path.replace(/\/$/, '').split('/');
  return segs.length <= depth ? path : `${segs.slice(0, depth).join('/')}/`;
}

/** > `max` paths collapse to directory prefixes, deepest common directories first, until ≤ `max` (`truncated: true`). */
export function collapsePaths(paths: readonly string[], max = LEASE_PATHS_MAX): { paths: string[]; truncated: boolean } {
  let current = [...new Set(paths.map((p) => p.normalize('NFC')))];
  if (current.length <= max) return { paths: current.sort(), truncated: false };
  let depth = Math.max(1, ...current.map((p) => p.replace(/\/$/, '').split('/').length)) - 1;
  while (current.length > max && depth >= 1) {
    current = [...new Set(current.map((p) => prefixAt(p, depth)))];
    depth--;
  }
  if (current.length > max) current = [...new Set(current.map((p) => prefixAt(p, 1)))].slice(0, max);
  return { paths: current.sort(), truncated: true };
}

// ── check (§4.3 step 2, pure) ─────────────────────────────────────────────────────────────────────────────────────────

export interface CheckOptions {
  /** §8.4: the content shas the proposal was built on — `theyTouched` needs a real difference, not just an intersection */
  fileMemory?: ReadonlyMap<string, string | null> | Readonly<Record<string, string | null>>;
  /** the workspace volume folds case (§11 row 23) */
  caseFold?: boolean;
  /** my own stamp once issued (the strict re-fold); absent = any overlapping exclusive lease is lower than the one I will mint */
  stamp?: Stamp;
  /** §4.5: the `LeaseCheck.snapshot` the judgment being fenced was made over (the design's `seen`) */
  snapshot?: LeaseSnapshot;
  /** defaults to `fold.at` */
  now?: Now;
}

function memoryOf(o: CheckOptions['fileMemory'], path: string): string | null | undefined {
  if (o === undefined) return undefined;
  if (o instanceof Map) return o.has(path) ? (o.get(path) as string | null) : undefined;
  return Object.prototype.hasOwnProperty.call(o, path) ? (o as Record<string, string | null>)[path] : undefined;
}

function liveHolder(fold: Fold, lease: Lease): (Heartbeat & { arrivalMono: number }) | null {
  const hb = fold.live.get(lease.runId);
  if (hb !== undefined && hb.deviceId === lease.deviceId) return hb;
  for (const f of fold.forks?.get(lease.runId) ?? []) if (f.deviceId === lease.deviceId) return f;
  return null;
}

/**
 * §4.3 (design revision 5): the lease's own keys, as `sameRepo` wants them. `repoKey` is now nullable on the record
 * (revision 4 back-filled it with `wsKey`, which this function then had to undo by sniffing the `ws:` prefix — and
 * which silently made a `wsKey`-only run look like a run with a repoKey to anything that read the field directly).
 */
function leaseRepo(l: Lease): { repoKey: string | null; remoteKey: string | null; wsKey: string } {
  const repoKey = l.repoKey !== null && l.repoKey.startsWith('ws:') ? null : l.repoKey;
  return { repoKey, remoteKey: l.remoteKey, wsKey: l.wsKey };
}

/** §5.4 / §11 row 43: `request-release` messages whose files overlap `paths` — a fact under advisory, a bounded hold under strict. */
export function requestedFor(fold: Fold, self: SelfIdentity, paths: readonly string[], now: Now = fold.at, o: { caseFold?: boolean } = {}): { path: string; by: string; agoMs: number }[] {
  const out: { path: string; by: string; agoMs: number }[] = [];
  for (const m of fold.inbox) {
    if (m.type !== 'request-release' || m.refs.files === undefined) continue;
    if (Date.parse(m.expiresAt) <= now.wallMs) continue;
    if (m.from.runId !== null && m.from.runId === self.runId) continue;
    const t = Date.parse(m.t);
    for (const pair of overlap(paths, m.refs.files, { caseFold: o.caseFold === true })) out.push({ path: pair.path, by: m.from.label, agoMs: Number.isFinite(t) ? Math.max(0, now.wallMs - t) : 0 });
  }
  return out;
}

/**
 * pure, O(paths × liveLeases): every live, unexpired, unreleased lease on my repoKey / remoteKey (or wsKey when both are
 * null) whose owner heartbeat is live. Same branch or either unknown → `hard`; different branches → `soft`. `theyTouched` =
 * the peer's `released.changed` / `touchedRecent` intersects my paths AND the sha differs from `fileMemory` (unknown → true).
 */
export function check(fold: Fold, self: SelfIdentity, mine: LeaseIntent, opts: CheckOptions = {}): LeaseCheck {
  const now = opts.now ?? fold.at;
  const caseFold = opts.caseFold === true;
  const conflicts: LeaseConflict[] = [];
  const declared: DeclaredFact[] = [];
  const snapshot = new Set<string>();
  let contested = false;
  // what each peer run released with a sha (its earlier leases' `released.changed`) — the post-hoc `theyTouched` input
  const releasedByRun = new Map<string, Map<string, string | null>>();
  for (const l of fold.leases.values()) {
    if (l.released === undefined) continue;
    const m = releasedByRun.get(l.runId) ?? new Map<string, string | null>();
    for (const [p, sha] of Object.entries(l.released.changed)) m.set(p, sha);
    releasedByRun.set(l.runId, m);
  }
  for (const lease of fold.leases.values()) {
    if (self.runId !== null && lease.runId === self.runId) continue;
    if (lease.released !== undefined) continue;
    const holder = liveHolder(fold, lease);
    if (holder === null) continue;
    if (!sameRepo(leaseRepo(lease), self)) continue;
    // + review blocker 4: `expiresAt` is a WRITER wall-clock stamp and this is the READER's clock. A reader 15 minutes
    // ahead (a VM that resumed, a laptop that woke, a machine with no NTP) judged every live peer lease expired and
    // cleared straight through it — the one case the fence exists for. Liveness of the OWNER is the gate, and §4.3
    // already says a beating owner's lease never expires: `liveHolder` above is that test. Expiry survives only as the
    // display number `expiresInMs`, and as the retention input the GC uses on OUR OWN files.
    const expiresAt = Date.parse(lease.expiresAt);
    const treeLock = lease.exclusiveTree === true || mine.exclusiveTree === true;
    const pairs = treeLock ? (mine.paths.length > 0 ? mine.paths : [TREE_PATH]).map((p) => ({ path: p, with: TREE_PATH })) : overlap(mine.paths, lease.paths, { caseFold });
    if (pairs.length === 0) continue;
    const renewedAt = Date.parse(lease.renewedAt);
    const agoMs = Number.isFinite(renewedAt) ? Math.max(0, now.wallMs - renewedAt) : 0;
    // §4.5 (revision 5): the snapshot is the overlapping leases that are EXCLUSIVE right now — not every leaseId in
    // the fold. A peer's `intent` must NOT be in it, or its rewrite to `exclusive` inside the write-then-read window
    // would never count as `appeared`, which is the whole race the fence exists for.
    if (lease.type === 'exclusive') snapshot.add(lease.leaseId);
    // §4.3 step 2 (revision 5): only a HOLDING lease is a conflict. An `intent` is what every writer writes at step 1
    // and what an F1 yield downgrades to, so it is reported as a `declared` FACT and never as a conflict. Revision 4's
    // "every live, unexpired lease" had the F2 re-declarer conflicting with the peer that had just yielded to it, and
    // every strict step conflicting with every peer's step-1 intent.
    if (!HOLDING_LEASE_TYPES.has(lease.type)) {
      const seenDeclared = new Set<string>();
      for (const pair of pairs) {
        if (seenDeclared.has(pair.path)) continue;
        seenDeclared.add(pair.path);
        declared.push({ path: pair.path, by: holder.label, leaseId: lease.leaseId, step: lease.step, agoMs });
      }
      continue;
    }
    const releasedChanged = releasedByRun.get(lease.runId) ?? new Map<string, string | null>();
    const touchedByThem = [...releasedChanged.keys(), ...holder.touchedRecent, ...(holder.touched?.files ?? [])];
    const exclusiveCommand = lease.type === 'command' && lease.exclusiveTree === true ? (lease.command60 ?? '') : null;
    if (lease.type === 'exclusive' && (opts.stamp === undefined || compareStamp(lease.stamp, opts.stamp) < 0)) contested = true;
    // §4.3 step 2 (revision 5): severity is about the WORKING TREE, not the branch. `hard` iff the peer's `wsKey`
    // equals mine or either is unknown — the same checkout is the only way two sessions can clobber each other's
    // bytes; a different `wsKey` is `soft` whatever the branch, because two clones on one branch cannot overwrite
    // each other's files any more than two branches can.
    const sameTree = lease.wsKey === '' || self.wsKey === '' ? true : lease.wsKey === self.wsKey;
    const sameBranch = mine.branch === null || lease.branch === null ? null : mine.branch === lease.branch;
    const seenPaths = new Set<string>();
    for (const pair of pairs) {
      if (seenPaths.has(pair.path)) continue;
      seenPaths.add(pair.path);
      const theirs = overlap([pair.path], touchedByThem, { caseFold });
      let theyTouched = false;
      for (const t of theirs) {
        const mem = memoryOf(opts.fileMemory, t.path);
        const changedSha = releasedChanged.get(t.with);
        theyTouched = mem === undefined || changedSha === undefined || changedSha !== mem;
        if (theyTouched) break;
      }
      conflicts.push({
        leaseId: lease.leaseId,
        path: pair.path,
        // + review minor 20: `sameDevice` is the READ LOCATION of the lease file, never `lease.deviceId === self.deviceId`
        // — a planted lease naming my own device id would otherwise render as mine and be dismissed.
        holder: { runId: lease.runId, sessionId: lease.sessionId, deviceId: lease.deviceId, label: holder.label, sameDevice: leaseOrigin(fold, lease).self },
        holderStep: holder.step,
        holderStage: holder.stage,
        holderPhase: holder.phase,
        agoMs,
        severity: sameTree ? 'hard' : 'soft',
        sameBranch,
        theyTouched,
        exclusiveCommand,
        expiresInMs: Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now.wallMs) : 0,
        stamp: lease.stamp,
      });
    }
  }
  conflicts.sort((a, b) => (a.severity !== b.severity ? (a.severity === 'hard' ? -1 : 1) : compareStamp(a.stamp, b.stamp) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
  declared.sort((a, b) => (a.leaseId < b.leaseId ? -1 : a.leaseId > b.leaseId ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const requested = requestedFor(fold, self, mine.paths, now, { caseFold });
  if (conflicts.length === 0 && requested.length === 0) return { kind: 'clear', declared, snapshot };
  return { kind: 'conflict', conflicts, contested, requested, declared, snapshot };
}

/**
 * §4.5: the overlapping EXCLUSIVE leaseIds one `check()` saw — its own `snapshot`, which is exactly the `seen` the
 * next `declare(…, 'strict', seen)` takes. Kept as a named function so callers read the contract rather than a field.
 */
export function leaseSnapshot(check: LeaseCheck): LeaseSnapshot {
  return check.snapshot;
}

/**
 * §4.3 step 4: the inline strict wait is skipped (straight to the judgment) when a holder is mid-`execute` on an
 * `exclusiveTree` command (a build of unknown length) or its phase is `blocked` / `pausing` (nobody is about to release) —
 * never because of `expiresAt`, which a beating owner keeps 10 min away. §11 row 45: a peer parked on a pane for a day.
 */
export function shouldSkipInlineWait(conflicts: readonly LeaseConflict[]): boolean {
  return conflicts.some((c) => (c.holderStage === 'execute' && c.exclusiveCommand !== null) || c.holderPhase === 'blocked' || c.holderPhase === 'pausing');
}

// ── declare / renew / release ─────────────────────────────────────────────────────────────────────────────────────────

function nowIso(h: LedgerHandle): string {
  return new Date(h.now()).toISOString();
}

function buildLease(h: LedgerHandle, mine: LeaseIntent, type: Lease['type'], stamp: Stamp): Lease {
  const self = h.self;
  if (self.runId === null) throw new ConfigError('coordination: a lease needs a run (SelfIdentity.runId is null)', { setting: 'coordination' });
  const valid = mine.paths.map((p) => p.normalize('NFC')).filter(isValidRelPath);
  let { paths, truncated } = collapsePaths(valid);
  if (valid.length !== mine.paths.length) truncated = true;
  const issuedAt = nowIso(h);
  const base = (ps: string[], tr: boolean): Lease => ({
    v: 1,
    kind: 'lease',
    leaseId: `${self.runId}-${stamp.n}`,
    runId: self.runId as string,
    sessionId: self.sessionId ?? (self.runId as string),
    deviceId: self.deviceId,
    ...(self.hostKey !== undefined ? { hostKey: self.hostKey } : {}), // §3.1/§3.2: binds the lease to the MACHINE
    label: self.label,
    repoKey: self.repoKey,
    remoteKey: self.remoteKey,
    wsKey: self.wsKey,
    branch: mine.branch,
    head: mine.head,
    type,
    paths: ps,
    truncated: tr,
    ...(mine.command60 !== undefined ? { command60: oneLine(h.redact(mine.command60)).slice(0, 60) } : {}),
    ...(mine.exclusiveTree !== undefined ? { exclusiveTree: mine.exclusiveTree } : {}),
    // + review major 15: `laneDir` names a directory `sessions gc --lanes` will `rm -rf`. `isValidRelPath` admitted
    // `post`, `src`, `tmp/x` — anything relative. Only the exact `tmp/synth/lane<k>` shape may travel in the record.
    ...(mine.laneDir !== undefined && LANE_DIR_RE.test(mine.laneDir) ? { laneDir: mine.laneDir } : {}),
    ...(mine.slug !== undefined ? { slug: mine.slug } : {}),
    reason60: oneLine(h.redact(mine.reason60)).slice(0, 60),
    step: mine.step,
    stage: mine.stage,
    stamp,
    issuedAt,
    expiresAt: new Date(h.now() + LEASE_TTL_MS).toISOString(),
    renewedAt: issuedAt,
    checksum: '',
  });
  let lease = finalizeRecord(base(paths, truncated), h.redact);
  // ≤ 8 KiB: collapse further rather than truncate (§12.0.4 "refused, never truncated")
  while (!fitsRecordSize('lease', lease) && paths.length > 1) {
    ({ paths } = collapsePaths(paths, Math.max(1, Math.ceil(paths.length / 2))));
    lease = finalizeRecord(base(paths, true), h.redact);
  }
  if (!fitsRecordSize('lease', lease)) throw new ConfigError('coordination: lease record exceeds 8 KiB', { setting: 'coordination' });
  return lease;
}

/**
 * §4.3 / §4.5 (design revision 5): **two directories, one lease.** Whenever `repoKey` is non-null and
 * `keyDir(repoKey) !== keyDir(wsKey)`, the SAME record is written under both — same `leaseId`, same stamp, byte
 * identical (it already carries `repoKey`, `remoteKey` and `wsKey`), and the fold is keyed by `leaseId`, so the two
 * copies fold to ONE lease and `byPath`, `check()` and `appeared` are unchanged.
 *
 * Why: two runs in ONE checkout can disagree about `repoKey` — a workspace with an unborn HEAD and no origin has
 * `repoKey: null` at run 1 and a real one at run 2 because the first commit landed in between, and a
 * `rev-list --max-parents=0` that fails on one side (a corrupt pack, a flaky mount, the 2 s timeout) produces the
 * same split. Under revision 4's single directory both leased, neither saw the other, and both proceeded under
 * `strict`. The safety proof of §4.5 then runs in the `keyDir(wsKey)` directory, which two runs in one checkout
 * share BY CONSTRUCTION (`wsKey` is known at startup with zero spawns and cannot fail) — and `hard` severity is
 * defined by exactly that key, so the directory that carries the proof is the one that carries every conflict the
 * fence has to decide.
 *
 * Order is fixed: `keyDir(repoKey)` first, `keyDir(wsKey)` second, for every rewrite as well as the declare.
 * (+ review major 13: `ws:`/`rm:` become `ws-`/`rm-` in the path; the record keeps the colon form.)
 */
export function leaseRels(lease: Pick<Lease, 'repoKey' | 'wsKey' | 'leaseId'>): string[] {
  const dirs = lease.repoKey === null ? [lease.wsKey] : [lease.repoKey, lease.wsKey];
  const out: string[] = [];
  for (const key of dirs) {
    const rel = leaseRel(key, lease.leaseId);
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

function makeHandle(h: LedgerHandle, initial: Lease, awaitedWrites: boolean): LeaseHandle & { current(): Lease; captureYield(appeared: readonly LeaseConflict[]): void } {
  let current = initial;
  let released = false;
  let appearedAt: readonly LeaseConflict[] = [];
  /** §4.3 (revision 5): every rewrite rewrites BOTH copies, in the same order as the declare. */
  const writeBoth = (next: Lease, fsync: boolean): void => {
    current = next;
    for (const rel of leaseRels(next)) void h.enqueue(`lease ${next.leaseId}`, () => h.writeOwn('leases', rel, next, { fsync }));
  };
  const awaitBoth = async (next: Lease): Promise<void> => {
    current = next;
    for (const rel of leaseRels(next)) await h.writeOwn('leases', rel, next, { fsync: false });
  };
  return {
    leaseId: initial.leaseId,
    stamp: initial.stamp,
    current: () => current,
    captureYield: (appeared) => {
      appearedAt = appeared;
    },
    /**
     * §4.5 F1: the yield. Same `leaseId`, same `stamp` (minted once at declare and kept through every rewrite,
     * §3.2), `type: 'intent'` — so the lease stops fencing anyone else while still announcing the intent, and F2's
     * wake condition on the other side ("everything I yielded to is now `intent`") can become true. Both copies.
     *
     * Revision 5: it CAPTURES what F2 will decide from, at this instant, from `appeared` — so the decision cannot
     * drift with the fold and both sides of a both-see race compute the same minimum from the same two records.
     */
    async downgrade(): Promise<FenceYield> {
      if (!released && current.type !== 'intent') {
        const next = finalizeRecord({ ...current, type: 'intent' as const, renewedAt: nowIso(h) }, h.redact);
        await awaitBoth(next);
      }
      return captureFenceYield(h, initial.stamp, appearedAt);
    },
    renew() {
      if (released) return;
      const at = nowIso(h);
      writeBoth(finalizeRecord({ ...current, renewedAt: at, expiresAt: new Date(h.now() + LEASE_TTL_MS).toISOString() }, h.redact), false);
    },
    release(outcome: LeaseOutcome, changed: Record<string, string | null> = {}, head?: string) {
      if (released) return;
      released = true;
      const entries = Object.entries(changed).filter(([k]) => isValidRelPath(k)).slice(0, LEASE_PATHS_MAX);
      const rel: NonNullable<Lease['released']> = { at: nowIso(h), outcome, changed: Object.fromEntries(entries), ...(head !== undefined ? { head } : {}) };
      let next = finalizeRecord({ ...current, released: rel }, h.redact);
      if (!fitsRecordSize('lease', next)) next = finalizeRecord({ ...current, released: { ...rel, changed: {} } }, h.redact);
      writeBoth(next, awaitedWrites);
    },
  };
}

/**
 * §4.5 F2 (design revision 5): the capture. `staleAtMono` is the instant THIS side will call that lease's owner
 * stale on its OWN monotonic clock (`arrivalMono + ttlMs + syncSlackMs`), and `null` for a same-device lease where pid
 * death is the event and staleness is immediate. `deadlineMono` extends the §4.3 step-4 wait to the latest of those,
 * capped at `ttlMs + syncSlackMs + 5 s`: a peer that crashes after this run yielded is only detectable at
 * `ttl + slack` (165 s), which is past `strictWaitMs` (60 s), so without the extension the survivor ALWAYS discarded
 * into the `lease-conflict` pane and F2's liveness was same-device only.
 */
function captureFenceYield(h: LedgerHandle, mine: Stamp, appeared: readonly LeaseConflict[]): FenceYield {
  const nowMono = h.clock().monoMs;
  const yieldedTo = appeared.map((c) => {
    const lease = h.fold.leases.get(c.leaseId);
    const holder = lease === undefined ? null : liveHolder(h.fold, lease);
    const staleAtMono = c.holder.sameDevice || holder === null ? null : holder.arrivalMono + honouredTtlMs(holder.ttlMs) + SYNC_SLACK_SHARED_MS;
    return { leaseId: c.leaseId, stamp: c.stamp, deviceId: c.holder.deviceId, sameDevice: c.holder.sameDevice, staleAtMono };
  });
  let latestStale = 0;
  for (const y of yieldedTo) if (y.staleAtMono !== null) latestStale = Math.max(latestStale, y.staleAtMono - nowMono);
  const waitMs = Math.min(Math.max(STRICT_WAIT_MS, latestStale), FENCE_WAIT_CAP_MS);
  return { mine, yieldedTo, deadlineMono: nowMono + waitMs };
}

/** advisory: one fire-and-forget write on the ledger chain (type as declared, usually 'intent'); nothing awaited */
export function declare(ledger: Ledger, mine: LeaseIntent, mode: 'advisory'): LeaseHandle;
/**
 * strict: type `'exclusive'` under `keyDir(repoKey)` AND under `keyDir(wsKey)` when the two differ (§4.3, revision 5),
 * BOTH renames awaited (~1–2 ms, no fsync), then ONE readdir of EVERY device's `leases/<keyDir>/` for BOTH of my key
 * directories — the fence is NOT bounded by `MAX_DEVICES`, only by `MAX_FENCE_DEVICES` (256, counted in SUBTREES) and
 * `STRICT_FENCE_MS` (250 ms), §4.5. Two outcomes, both explicit; see `StrictDeclare` for the F1 / F2 rules.
 *
 * `opts.snapshot` is the design's `seen` — the `LeaseCheck.snapshot` of the `check()` that preceded this declare IN
 * THIS STEP, which is the set of overlapping leases that were EXCLUSIVE there. On an F2 re-declare it is the snapshot
 * of the FRESH `check()` taken at the wake, never the first attempt's.
 */
export function declare(ledger: Ledger, mine: LeaseIntent, mode: 'strict', opts?: CheckOptions): Promise<StrictDeclare>;
export function declare(ledger: Ledger, mine: LeaseIntent, mode: 'advisory' | 'strict', opts: CheckOptions = {}): LeaseHandle | Promise<StrictDeclare> {
  const h = asHandle(ledger);
  const stamp = h.stamps.issue();
  if (mode === 'advisory') {
    const lease = buildLease(h, mine, mine.type, stamp);
    for (const rel of leaseRels(lease)) void h.enqueue(`lease ${lease.leaseId}`, () => h.writeOwn('leases', rel, lease, { fsync: false }));
    return makeHandle(h, lease, false);
  }
  const before = new Set(opts.snapshot ?? []);
  const lease = buildLease(h, mine, mine.type === 'intent' ? 'exclusive' : mine.type, stamp);
  return (async () => {
    // §4.3 / §4.5 (revision 5): BOTH renames are awaited before the re-fold. The safety proof runs in the
    // `keyDir(wsKey)` directory, which two runs in one checkout share by construction — so it is not enough for the
    // repoKey copy to have landed.
    for (const rel of leaseRels(lease)) await h.writeOwn('leases', rel, lease, { fsync: false });
    // + review blocker 1: `refreshFence` guarantees a readdir that STARTS after the renames above — the whole fence
    // is that ordering. It enumerates every device subtree for EVERY key of mine (`leaseKeysOf`), so a run whose
    // `repoKey` is still null (before `run:ready`, a shallow clone, a non-git workspace) and a run that has one meet
    // in the `wsKey` directory whatever their keys say.
    const scan = await h.refreshFence();
    const handle = makeHandle(h, lease, true);
    // §4.5: blind is REFUSED, not assumed. A bound reached before the enumeration finished means a peer beyond it may
    // hold an overlapping exclusive lease, and strict promises a decision it can no longer make.
    if (!scan.complete) return Object.assign(handle, { fence: 'blind' as const, scanned: scan.scanned, total: scan.total });
    const judged = check(h.fold, h.self, mine, { ...opts, stamp });
    const conflicts = judged.kind === 'conflict' ? judged.conflicts : [];
    // §4.5: `appeared` = the overlapping EXCLUSIVE leases in the post-rename readdir of both my key directories,
    // minus `seen`. A peer that was `intent` at my check and is `exclusive` now is therefore in it (revision 5's
    // snapshot holds only the exclusive ones), which is exactly the race the fence exists for. One entry per lease.
    const appeared: LeaseConflict[] = [];
    const seenAppeared = new Set<string>();
    for (const c of conflicts) {
      if (before.has(c.leaseId) || seenAppeared.has(c.leaseId)) continue;
      const l = h.fold.leases.get(c.leaseId);
      if (l !== undefined && l.type !== 'exclusive') continue; // only an exclusive lease can be a fence
      seenAppeared.add(c.leaseId);
      appeared.push(c);
    }
    // §4.5 F1: yield on SIGHT. Not the stamps — a local stamp test here is what let both writers proceed.
    const proceed = appeared.length === 0;
    handle.captureYield(appeared);
    const refold: LeaseCheck = judged.kind === 'conflict' && appeared.length > 0 ? { ...judged, contested: true } : judged;
    return Object.assign(handle, { fence: 'decided' as const, refold, appeared, proceed });
  })();
}

/**
 * §4.5 F2 (design revision 5), pure: the wake decision of the §4.3 step-4 wait, over the CURRENT fold and the
 * CAPTURED `FenceYield`.
 *
 *  - `'keep-waiting'` while any captured lease is still `exclusive` and not stale, or while a NEW overlapping
 *    exclusive lease that is not in the capture is live (a third writer arrived; re-declaring into it would only make
 *    me yield again);
 *  - `'redeclare'` when every captured lease is `intent`, released or stale AND `y.mine` is the minimum of
 *    `{ y.mine } ∪ { y.yieldedTo[].stamp }`;
 *  - `'deadline'` at `y.deadlineMono`.
 *
 * The minimum is taken over the CAPTURED stamps, never over the fold's current copies, so a lease a peer's GC has
 * already removed still counts and both sides of a both-see race compute the same minimum from the same two records.
 * A `'redeclare'` re-runs `check()` first — whose fresh `snapshot` is the `seen` of the second `declare` — and then
 * re-runs the fence exactly as the first time.
 *
 * In the ONE-sees case the winner still holds `exclusive`, so this stays `'keep-waiting'` and the yielder waits for a
 * real release, which is correct. In the BOTH-see case both are `intent` within a millisecond, both wakes fire, and
 * `compareStamp` (a strict total order) picks exactly one — so three or more racers terminate too: every round hands
 * the work to the current minimum, and a racer that crashed after yielding drops out through `staleAtMono`.
 */
export function fenceWake(fold: Fold, self: SelfIdentity, mine: LeaseIntent, y: FenceYield, nowMono: number): 'keep-waiting' | 'redeclare' | 'deadline' {
  const captured = new Set(y.yieldedTo.map((c) => c.leaseId));
  for (const c of y.yieldedTo) {
    const l = fold.leases.get(c.leaseId);
    if (l === undefined || l.released !== undefined) continue; // released or GC'd: no longer a fence
    if (l.type !== 'exclusive') continue; // downgraded to `intent`: no longer a fence
    if (liveHolder(fold, l) === null) continue; // its owner heartbeat is stale: no longer a fence
    if (c.staleAtMono !== null && nowMono >= c.staleAtMono) continue; // past the staleness instant I captured
    return nowMono >= y.deadlineMono ? 'deadline' : 'keep-waiting';
  }
  // a THIRD writer that arrived after the capture is live and exclusive: re-declaring into it would only yield again
  const fresh = check(fold, self, mine);
  if (fresh.kind === 'conflict') {
    for (const c of fresh.conflicts) {
      if (captured.has(c.leaseId)) continue;
      if (fold.leases.get(c.leaseId)?.type === 'exclusive') return nowMono >= y.deadlineMono ? 'deadline' : 'keep-waiting';
    }
  }
  // everything I yielded to has let go. The lowest CAPTURED stamp re-declares; the others keep waiting.
  for (const c of y.yieldedTo) if (compareStamp(c.stamp, y.mine) < 0) return nowMono >= y.deadlineMono ? 'deadline' : 'keep-waiting';
  return 'redeclare';
}

/**
 * §4.5 F1 + F2 as one object: the yield, what it captured, the wake decision and the re-declare. `leases.ts` owns
 * the capture so the engine's wait loop only has to ask `wake(fold, nowMono)` on each fold change and each armed timer.
 */
export interface FenceWait {
  /** the §4.5 capture: what F2 decides from, taken at the downgrade and never re-read from the fold */
  readonly captured: FenceYield;
  /** F2: `'keep-waiting'` | `'redeclare'` | `'deadline'` */
  wake(fold: Fold, nowMono: number): 'keep-waiting' | 'redeclare' | 'deadline';
  /** F2: re-run `check()` and pass ITS snapshot as the next declare's `seen` (§4.5, revision 5) */
  redeclare(): Promise<StrictDeclare>;
}

/**
 * §4.5 F1: perform the yield (both key directories) and hand back the F2 machinery built from what it captured.
 * `decided` is the `fence:'decided'` result whose `proceed` was false.
 */
export async function fenceYield(ledger: Ledger, mine: LeaseIntent, decided: LeaseHandle): Promise<FenceWait> {
  const h = asHandle(ledger);
  const captured = await decided.downgrade();
  return {
    captured,
    wake: (fold, nowMono) => fenceWake(fold, h.self, mine, captured, nowMono),
    redeclare: () => declare(h, mine, 'strict', { snapshot: check(h.fold, h.self, mine).snapshot }),
  };
}

export function release(handle: LeaseHandle, outcome: LeaseOutcome, changed?: Record<string, string | null>, head?: string): void {
  handle.release(outcome, changed, head);
}

export function renew(handle: LeaseHandle): void {
  handle.renew();
}

// ── facts (§4.1) ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** §4.1 advisory facts for one step; ≤ 8 conflicts, ≤ 8 requests, ≤ 8 messages × 300 chars. */
export function buildFacts(o: { step: number; check: LeaseCheck; messages?: readonly Message[]; others: number }): CoordinationFacts {
  const conflicts = o.check.kind === 'conflict' ? o.check.conflicts.slice(0, FACTS_MAX) : [];
  const requested = o.check.kind === 'conflict' ? o.check.requested.slice(0, FACTS_MAX) : [];
  const messages = (o.messages ?? []).slice(-FACTS_MAX).map((m) => ({ from: m.from.label, type: m.type, text: m.text.slice(0, FACT_TEXT_MAX), at: m.t }));
  return { step: o.step, conflicts, requested, messages, others: o.others };
}

/** `StepRecord.coord?` (§4.1): the reduced conflict rows the checkpoint keeps. */
export function coordRecordOf(facts: CoordinationFacts): { conflicts: { path: string; holder: string; holderStep: number; agoMs: number; sameBranch: boolean | null; theyTouched: boolean }[]; requested?: { path: string; by: string; agoMs: number }[] } {
  const conflicts = facts.conflicts.map((c) => ({ path: c.path, holder: c.holder.label, holderStep: c.holderStep, agoMs: c.agoMs, sameBranch: c.sameBranch, theyTouched: c.theyTouched }));
  return facts.requested.length > 0 ? { conflicts, requested: facts.requested } : { conflicts };
}
