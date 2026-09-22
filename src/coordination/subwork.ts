/**
 * Sub-work (§6.1 `subwork` rows, §6.2 lanes as `type:'lane'` leases, §6.5 child worktrees) and the bench lock (§4.7,
 * §11 row 17). Lanes never claim workspace paths: a lane lease has `paths: []` and a run-relative `laneDir`; the sweep of
 * §6.6 asks `staleLaneLeases` which lane dirs belong to dead runs. `acquireBenchLock` is the `acquireRunLock` recipe
 * (O_EXCL, re-read on EEXIST, boot-time rule, tmp + rename replacement) over `~/.jevcode/bench/<benchId>/bench.lock`,
 * synchronous so the runner's `'exit'` handler can release it.
 */
import { join } from 'node:path';
import { isJsonObject, parseJson } from '../core/json.js';
import { ConfigError } from '../errors.js';
import type { CoordFs } from './fs.js';
import { FILE_MODE, errnoCode, nodeFs } from './fs.js';
import { LANE_DIR_RE, SLUG_RE } from './ids.js';
import { leaseOrigin } from './fold.js';
import { defaultIsPidAlive } from './ledger.js';
import { declare } from './leases.js';
import { SUBWORK_MAX, oneLine } from './records.js';
import type { CoordStageName, Fold, Lease, LeaseHandle, Ledger, SelfIdentity, SubworkEntry } from './types.js';

// ── subwork rows (§6.1) ───────────────────────────────────────────────────────────────────────────────────────────────

export function subworkEntry(e: { kind: SubworkEntry['kind']; id: string; since: string; stage: string; detail: string; laneDir?: string }): SubworkEntry {
  const row: SubworkEntry = { kind: e.kind, id: e.id.slice(0, 40), since: e.since, stage: e.stage.slice(0, 20), detail60: oneLine(e.detail).slice(0, 60) };
  // review #37: only the exact `tmp/synth/lane<k>` shape may travel in a record the sweep acts on
  if (e.laneDir !== undefined && LANE_DIR_RE.test(e.laneDir)) row.laneDir = e.laneDir;
  return row;
}

/** Upsert by (kind, id); ≤ 16 rows, the oldest `since` dropped first. */
export function mergeSubwork(current: readonly SubworkEntry[], entry: SubworkEntry): SubworkEntry[] {
  const rest = current.filter((s) => !(s.kind === entry.kind && s.id === entry.id));
  const next = [...rest, entry].sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0));
  return next.length > SUBWORK_MAX ? next.slice(next.length - SUBWORK_MAX) : next;
}

export function removeSubwork(current: readonly SubworkEntry[], kind: SubworkEntry['kind'], id: string): SubworkEntry[] {
  return current.filter((s) => !(s.kind === kind && s.id === id));
}

// ── lanes and worktrees as leases (§6.2, §6.5) ────────────────────────────────────────────────────────────────────────

export interface LaneLeaseInput {
  /** run-relative, e.g. `tmp/synth/lane2` — never absolute (§10.2) */
  laneDir: string;
  step: number;
  stage: CoordStageName;
  branch: string | null;
  head: string | null;
  reason60?: string;
}

/** `type:'lane'`, `paths: []`, advisory (a lane writes only under its own dir; the parent's apply is under the parent's lease). */
export function declareLane(ledger: Ledger, o: LaneLeaseInput): LeaseHandle {
  // review #37: `<runDir>/<laneDir>` is what `sessions gc` `rm -rf`s; `.`, `post` and `tmp/../..` must never reach it
  if (!LANE_DIR_RE.test(o.laneDir)) throw new ConfigError(`lane lease: laneDir must be 'tmp/synth/lane<k>' (got '${o.laneDir}')`, { setting: 'coordination' });
  return declare(ledger, { paths: [], type: 'lane', laneDir: o.laneDir, reason60: o.reason60 ?? `lane ${o.laneDir}`, step: o.step, stage: o.stage, branch: o.branch, head: o.head }, 'advisory');
}

export interface WorktreeLeaseInput {
  slug: string;
  step: number;
  stage: CoordStageName;
  branch: string | null;
  head: string | null;
  reason60?: string;
}

/** `type:'worktree'` for a session worktree (`~/.jevcode/worktrees/<repoKey>/<slug>/`, §6.5); the marker in git is the lock. */
export function declareWorktree(ledger: Ledger, o: WorktreeLeaseInput): LeaseHandle {
  if (!SLUG_RE.test(o.slug)) throw new ConfigError(`worktree lease: '${o.slug}' is not a slug (${SLUG_RE.source})`, { setting: 'coordination' });
  return declare(ledger, { paths: [], type: 'worktree', slug: o.slug, reason60: o.reason60 ?? `worktree ${o.slug}`, step: o.step, stage: o.stage, branch: o.branch, head: o.head }, 'advisory');
}

/** Every unreleased lane lease in the fold. */
export function laneLeases(fold: Fold): Lease[] {
  return [...fold.leases.values()].filter((l) => l.type === 'lane' && l.released === undefined);
}

/**
 * §6.2 (a) / §11 row 18: lane leases whose owner heartbeat is not live — the sweep may prune their worktrees. Only leases
 * read from the LOCAL subtree qualify (review #37): a lane dir is a path on ITS device, and a foreign lease naming a runId
 * that happens to exist here never owned that directory.
 */
export function staleLaneLeases(fold: Fold, self: Pick<SelfIdentity, 'deviceId'>): Lease[] {
  return laneLeases(fold).filter((l) => {
    if (l.deviceId !== self.deviceId) return false;
    if (!leaseOrigin(fold, l).self) return false;
    if (l.laneDir === undefined || !LANE_DIR_RE.test(l.laneDir)) return false;
    const hb = fold.live.get(l.runId);
    return hb === undefined || hb.deviceId !== l.deviceId;
  });
}

// ── bench lock (§4.7, §11 row 17) ─────────────────────────────────────────────────────────────────────────────────────

export const BENCH_LOCK_FILE = 'bench.lock';

export interface BenchLock {
  pid: number;
  startedAt: string;
  host: string;
  benchId: string;
}

export function parseBenchLock(text: string): BenchLock | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isJsonObject(parsed.value)) return null;
  const o = parsed.value;
  const pid = o['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  return { pid, startedAt: typeof o['startedAt'] === 'string' ? o['startedAt'] : '', host: typeof o['host'] === 'string' ? o['host'] : '', benchId: typeof o['benchId'] === 'string' ? o['benchId'] : '' };
}

export function readBenchLock(benchDir: string, fs: CoordFs = nodeFs): BenchLock | null {
  try {
    const r = fs.readFileSync(join(benchDir, BENCH_LOCK_FILE), 4096);
    return r.overflow ? null : parseBenchLock(r.text);
  } catch {
    return null;
  }
}

export function benchLockInUseMessage(benchId: string, lock: BenchLock): string {
  return `bench ${benchId} is in use by pid ${lock.pid} since ${lock.startedAt} (another 'jevcode bench --resume'?); remove ${BENCH_LOCK_FILE} if that process is gone`;
}

export interface AcquireBenchLockOptions {
  benchId: string;
  pid: number;
  host: string;
  nowIso: string;
  /** ISO boot time: a lock whose `startedAt` predates it is stale even when `kill(pid, 0)` succeeds (§11 row 2) */
  bootAt?: string;
  isAlive?: (pid: number) => boolean;
  fs?: CoordFs;
  warn?: (message: string) => void;
}

/** the bounded number of times the taker re-reads after losing an `O_EXCL` race */
const BENCH_LOCK_TRIES = 4;

/**
 * Take `<benchDir>/bench.lock`. A live lock (same host, pid alive, started after boot) throws `ConfigError` (exit 2)
 * naming the holder; a stale one is REPLACED and reported through `warn`.
 *
 * + review blocker 6: every path that creates the file is an `O_EXCL` create. The old code took the `O_EXCL` route only
 * when the slot was empty and replaced a STALE lock with an unguarded tmp + rename — so two runners that both read the
 * same stale lock both "won", both renamed over it, and both ran the same bench against one output directory. The
 * replacement now unlinks and re-creates exclusively; the loser gets `EEXIST`, re-reads the winner's lock and is
 * refused by the same live-holder test as anyone else.
 */
export function acquireBenchLock(benchDir: string, o: AcquireBenchLockOptions): { replaced: BenchLock | null } {
  const fs = o.fs ?? nodeFs;
  const isAlive = o.isAlive ?? defaultIsPidAlive;
  const path = join(benchDir, BENCH_LOCK_FILE);
  const lock: BenchLock = { pid: o.pid, startedAt: o.nowIso, host: o.host, benchId: o.benchId };
  const text = `${JSON.stringify(lock)}\n`;
  const live = (l: BenchLock): boolean => {
    if (l.host !== o.host) return false;
    if (o.bootAt !== undefined) {
      const started = Date.parse(l.startedAt);
      const boot = Date.parse(o.bootAt);
      if (Number.isFinite(started) && Number.isFinite(boot) && started < boot) return false;
    }
    return isAlive(l.pid);
  };
  const evaluate = (existing: BenchLock | null): 'free' | 'ours' | 'stale' => {
    if (existing === null) return 'free';
    if (existing.pid === o.pid) return 'ours';
    if (live(existing)) throw new ConfigError(benchLockInUseMessage(o.benchId, existing), { setting: 'bench' });
    return 'stale';
  };
  fs.mkdirSync(benchDir, 0o700);
  /**
   * + re-check (4): replacing a stale lock is a COMPARE-AND-SWAP, not an unconditional unlink.
   *
   * B6 added the O_EXCL create and a re-judge on `EEXIST`, but the unlink above it was unconditional — and after an
   * unlink `EEXIST` cannot happen, so the re-judge was unreachable on the path that mattered. The interleaving: A and
   * B both read the same stale lock L0; A unlinks L0 and creates LA; B, still holding its stale verdict, unlinks
   * **LA** and creates LB. Two runners, one `tasks.jsonl`.
   *
   * The fix is to unlink only after confirming the file STILL holds the exact record the verdict was formed about.
   * The window is then a re-read plus an unlink of a file whose contents we have just matched, and the loser's
   * `writeExclusiveSync` fails `EEXIST` and re-judges against the winner's live lock — which throws.
   */
  const sameLock = (a: BenchLock | null, b: BenchLock | null): boolean =>
    a !== null && b !== null && a.pid === b.pid && a.startedAt === b.startedAt && a.host === b.host && a.benchId === b.benchId;
  let existing = readBenchLock(benchDir, fs);
  let verdict = evaluate(existing);
  for (let attempt = 0; attempt < BENCH_LOCK_TRIES; attempt++) {
    if (verdict !== 'free') {
      // re-read and re-evaluate IMMEDIATELY before the unlink; anything else and we are deleting someone else's lock
      const now = readBenchLock(benchDir, fs);
      if (now !== null && !sameLock(now, existing)) {
        existing = now;
        verdict = evaluate(now); // throws when the new holder is live
        if (verdict === 'ours') return { replaced: null };
        continue;
      }
      if (now !== null) {
        try {
          fs.unlinkSync(path);
        } catch (e) {
          if (errnoCode(e) !== 'ENOENT') throw e;
        }
      }
    }
    try {
      fs.writeExclusiveSync(path, text, FILE_MODE);
      if (verdict === 'stale' && existing !== null) {
        const why = existing.host !== o.host ? `another host (${existing.host || 'unknown'})` : `pid ${existing.pid} is gone or predates boot`;
        o.warn?.(`bench ${o.benchId}: replaced a stale ${BENCH_LOCK_FILE} from ${why}, started ${existing.startedAt || 'unknown'}`);
        return { replaced: existing };
      }
      return { replaced: null };
    } catch (e) {
      if (errnoCode(e) !== 'EEXIST') throw e;
      // someone created it between our unlink and our create: re-read and re-judge (this throws when they are live)
      existing = readBenchLock(benchDir, fs);
      verdict = evaluate(existing);
      if (verdict === 'ours') return { replaced: null };
    }
  }
  throw new ConfigError(`bench ${o.benchId}: ${BENCH_LOCK_FILE} is contended — another 'jevcode bench --resume' is starting`, { setting: 'bench' });
}

/** Remove the lock; with `pid` given only a lock this process wrote. Never throws; true when a file was removed. */
export function releaseBenchLock(benchDir: string, o: { pid?: number; fs?: CoordFs } = {}): boolean {
  const fs = o.fs ?? nodeFs;
  const path = join(benchDir, BENCH_LOCK_FILE);
  try {
    if (o.pid !== undefined) {
      const existing = readBenchLock(benchDir, fs);
      if (existing === null || existing.pid !== o.pid) return false;
    }
    fs.unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
