/**
 * Leases (§4.3 lifecycle declare → check → proceed | wait | worktree | change approach → release; §4.5 fencing; §12.0.4
 * "Lease API"). `check` is pure over the fold — `O(paths × liveLeases)` map work, no I/O — so the advisory gate costs no
 * file I/O on the step path. `declare` writes on the ledger chain (advisory, fire-and-forget) or awaits its own rename and
 * re-folds every peer's `leases/<repoKey>/` once (strict: the write-then-read fence). Prefix collapse keeps a lease ≤ 64
 * paths and ≤ 8 KiB — conservative, more conflicts never fewer.
 */
import { join } from 'node:path';
import { ConfigError } from '../errors.js';
import { asHandle, type LedgerHandle } from './ledger.js';
import { LEASE_PATHS_MAX, isValidRelPath, sameRepo } from './ids.js';
import { LEASE_TTL_MS, compareStamp, fitsRecordSize, finalizeRecord, oneLine, overlap, type Now } from './records.js';
import type { CoordinationFacts, Fold, Heartbeat, Lease, LeaseCheck, LeaseConflict, LeaseHandle, LeaseIntent, LeaseOutcome, Ledger, Message, SelfIdentity, Stamp, StrictDeclaration } from './types.js';

/** §4.1 / §4.3 step 4: the strict inline wait bound */
export const STRICT_WAIT_MS = 60_000;
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
  /** + review blocker 4: the `LeaseCheck.snapshot` the judgment being fenced was made over */
  snapshot?: readonly string[];
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

function leaseRepo(l: Lease): { repoKey: string | null; remoteKey: string | null; wsKey: string } {
  return { repoKey: l.repoKey.startsWith('ws:') ? null : l.repoKey, remoteKey: l.remoteKey, wsKey: l.wsKey };
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
    if (lease.type === 'takeover') continue;
    const holder = liveHolder(fold, lease);
    if (holder === null) continue;
    if (!sameRepo(leaseRepo(lease), self)) continue;
    const expiresAt = Date.parse(lease.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now.wallMs) continue;
    const treeLock = lease.exclusiveTree === true || mine.exclusiveTree === true;
    const pairs = treeLock ? (mine.paths.length > 0 ? mine.paths : [TREE_PATH]).map((p) => ({ path: p, with: TREE_PATH })) : overlap(mine.paths, lease.paths, { caseFold });
    if (pairs.length === 0) continue;
    const sameBranch = mine.branch === null || lease.branch === null ? null : mine.branch === lease.branch;
    const renewedAt = Date.parse(lease.renewedAt);
    const releasedChanged = releasedByRun.get(lease.runId) ?? new Map<string, string | null>();
    const touchedByThem = [...releasedChanged.keys(), ...holder.touchedRecent, ...(holder.touched?.files ?? [])];
    const exclusiveCommand = lease.type === 'command' && lease.exclusiveTree === true ? (lease.command60 ?? '') : null;
    if (lease.type === 'exclusive' && (opts.stamp === undefined || compareStamp(lease.stamp, opts.stamp) < 0)) contested = true;
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
        holder: { runId: lease.runId, sessionId: lease.sessionId, deviceId: lease.deviceId, label: holder.label, sameDevice: lease.deviceId === self.deviceId },
        holderStep: holder.step,
        holderStage: holder.stage,
        holderPhase: holder.phase,
        agoMs: Number.isFinite(renewedAt) ? Math.max(0, now.wallMs - renewedAt) : 0,
        severity: sameBranch === false ? 'soft' : 'hard',
        sameBranch,
        theyTouched,
        exclusiveCommand,
        expiresInMs: Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now.wallMs) : 0,
        stamp: lease.stamp,
      });
    }
  }
  conflicts.sort((a, b) => (a.severity !== b.severity ? (a.severity === 'hard' ? -1 : 1) : compareStamp(a.stamp, b.stamp) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
  const requested = requestedFor(fold, self, mine.paths, now, { caseFold });
  const snapshot = leaseSnapshot(fold);
  if (conflicts.length === 0 && requested.length === 0) return { kind: 'clear', snapshot };
  return { kind: 'conflict', conflicts, contested, requested, snapshot };
}

/**
 * + review blocker 4: the lease ids the fold held when a judgment was made. The strict fence compares the re-fold against
 * THIS set: an overlapping lease that was not in it appeared inside the write-then-read window, which means the other side
 * cannot have seen mine either — so the judgment re-runs whatever the stamp order says.
 */
export function leaseSnapshot(fold: Fold): readonly string[] {
  return [...fold.leases.keys()].sort();
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
    label: self.label,
    repoKey: self.repoKey ?? self.wsKey,
    remoteKey: self.remoteKey,
    wsKey: self.wsKey,
    branch: mine.branch,
    head: mine.head,
    type,
    paths: ps,
    truncated: tr,
    ...(mine.command60 !== undefined ? { command60: oneLine(h.redact(mine.command60)).slice(0, 60) } : {}),
    ...(mine.exclusiveTree !== undefined ? { exclusiveTree: mine.exclusiveTree } : {}),
    ...(mine.laneDir !== undefined && isValidRelPath(mine.laneDir) ? { laneDir: mine.laneDir } : {}),
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

function relOf(lease: Lease): string {
  return join(lease.repoKey, `${lease.leaseId}.json`);
}

function makeHandle(h: LedgerHandle, initial: Lease, awaitedWrites: boolean): LeaseHandle & { current(): Lease } {
  let current = initial;
  let released = false;
  const write = (next: Lease, fsync: boolean): void => {
    current = next;
    void h.enqueue(`lease ${next.leaseId}`, () => h.writeOwn('leases', relOf(next), next, { fsync }));
  };
  return {
    leaseId: initial.leaseId,
    stamp: initial.stamp,
    current: () => current,
    renew() {
      if (released) return;
      const at = nowIso(h);
      write(finalizeRecord({ ...current, renewedAt: at, expiresAt: new Date(h.now() + LEASE_TTL_MS).toISOString() }, h.redact), false);
    },
    release(outcome: LeaseOutcome, changed: Record<string, string | null> = {}, head?: string) {
      if (released) return;
      released = true;
      const entries = Object.entries(changed).filter(([k]) => isValidRelPath(k)).slice(0, LEASE_PATHS_MAX);
      const rel: NonNullable<Lease['released']> = { at: nowIso(h), outcome, changed: Object.fromEntries(entries), ...(head !== undefined ? { head } : {}) };
      let next = finalizeRecord({ ...current, released: rel }, h.redact);
      if (!fitsRecordSize('lease', next)) next = finalizeRecord({ ...current, released: { ...rel, changed: {} } }, h.redact);
      write(next, awaitedWrites);
    },
  };
}

/** advisory: one fire-and-forget write on the ledger chain (type as declared, usually 'intent'); nothing awaited */
export function declare(ledger: Ledger, mine: LeaseIntent, mode: 'advisory'): LeaseHandle;
/**
 * strict: type 'exclusive', the rename awaited (~1 ms, no fsync), then ONE readdir of every peer's leases/<repoKey>/ → the
 * re-fold result (§4.5). The fence is SYMMETRIC (review blocker 4): `appeared` holds every overlapping lease that was NOT
 * in the snapshot `check()` judged over, and any non-empty `appeared` sets `reJudge` — regardless of stamp order, because in
 * the one-sees interleaving the viewer can be the LOWER stamp and would otherwise proceed while the writer never saw it.
 * `opts.snapshot` is the `LeaseCheck.snapshot` of the judgment being fenced; without it the pre-write fold is used.
 */
export function declare(ledger: Ledger, mine: LeaseIntent, mode: 'strict', opts?: CheckOptions): Promise<LeaseHandle & StrictDeclaration>;
export function declare(ledger: Ledger, mine: LeaseIntent, mode: 'advisory' | 'strict', opts: CheckOptions = {}): LeaseHandle | Promise<LeaseHandle & StrictDeclaration> {
  const h = asHandle(ledger);
  const stamp = h.stamps.issue();
  if (mode === 'advisory') {
    const lease = buildLease(h, mine, mine.type, stamp);
    void h.enqueue(`lease ${lease.leaseId}`, () => h.writeOwn('leases', relOf(lease), lease, { fsync: false }));
    return makeHandle(h, lease, false);
  }
  const before = new Set(opts.snapshot ?? leaseSnapshot(h.fold));
  const lease = buildLease(h, mine, mine.type === 'intent' ? 'exclusive' : mine.type, stamp);
  return (async () => {
    await h.writeOwn('leases', relOf(lease), lease, { fsync: false });
    await h.refresh('leases');
    const judged = check(h.fold, h.self, mine, { ...opts, stamp });
    const conflicts = judged.kind === 'conflict' ? judged.conflicts : [];
    const appeared = conflicts.filter((c) => !before.has(c.leaseId));
    const reJudge = appeared.length > 0 || (judged.kind === 'conflict' && judged.contested);
    const refold: LeaseCheck = judged.kind === 'conflict' && appeared.length > 0 ? { ...judged, contested: true } : judged;
    return Object.assign(makeHandle(h, lease, true), { refold, appeared, reJudge });
  })();
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
