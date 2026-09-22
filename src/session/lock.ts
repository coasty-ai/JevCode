/**
 * `<runDir>/run.lock` (TUI-DESIGN §8.5, A55): `{ "pid", "startedAt", "host" }` written by `createEngine` after
 * `store.create` / the resume load, removed in `finish()` and by the `'exit'` handler. On resume a lock whose pid is
 * alive on the same host is a `ConfigError` (exit 2) with the §24 message; a dead pid or another host is replaced with
 * a warning. Everything is synchronous so the `'exit'` handler can release it.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { isJsonObject, parseJson } from '../core/json.js';
import { ConfigError } from '../errors.js';

export const RUN_LOCK_FILE = 'run.lock';

export interface RunLock {
  pid: number;
  startedAt: string;
  host: string;
  /**
   * TUI-DESIGN-5 §2.10: this machine's boot instant when the lock was written. OPTIONAL — every `run.lock` on disk
   * before round 5 lacks it, and that absence is exactly what `lockReplaceVerdict`'s `'boot-unknown'` reason
   * names: a pid that is alive on this host after an unknown boot may be this run or may be a number the kernel
   * handed out again, and the CLI refuses rather than guessing (`src/coordination/records.ts:807–809`).
   */
  bootAt?: string;
}

export type KillFn = (pid: number, signal: 0) => unknown;

function errnoCode(e: unknown): string | null {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : null;
}

/** TUI-DESIGN §8.5: `process.kill(pid, 0)` succeeds → alive; `ESRCH` → gone; `EPERM` → alive (someone else's process). */
export function isPidAlive(pid: number, kill: KillFn = (p, s) => process.kill(p, s)): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return errnoCode(e) === 'EPERM';
  }
}

/** Parse a lock file's text; null when it is not a `{ pid, startedAt, host }` object. */
export function parseRunLock(text: string): RunLock | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isJsonObject(parsed.value)) return null;
  const o = parsed.value;
  const pid = o['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  const bootAt = o['bootAt'];
  return {
    pid,
    startedAt: typeof o['startedAt'] === 'string' ? o['startedAt'] : '',
    host: typeof o['host'] === 'string' ? o['host'] : '',
    ...(typeof bootAt === 'string' && bootAt !== '' ? { bootAt } : {}),
  };
}

/** `Date.now() - uptime()` — this boot's instant, as both the lock writer and `sessions unlock` compute it. */
export function bootAtNow(now: () => number = Date.now, up: () => number = uptime): string {
  return new Date(now() - Math.round(up() * 1000)).toISOString();
}

/**
 * Two `bootAt` stamps name the same boot when they are within a minute: both sides derive the instant from
 * `Date.now() - os.uptime()`, whose two clocks drift by milliseconds, never by minutes.
 */
export const SAME_BOOT_TOLERANCE_MS = 60_000;

export function sameBoot(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= SAME_BOOT_TOLERANCE_MS;
}

/** `src/coordination/records.ts:807–809`'s `LockReplace['reason']`, re-declared for this module's own verdict. */
export type LockReplaceReason = 'no-lock' | 'dead-pid' | 'other-boot' | 'peer-live' | 'boot-unknown' | 'held';

/** The two arms of `LockReplace`: `detail60` exists on the REFUSING one only (§2.10, §12.1 S38a, §14.2 #26). */
export type LockReplaceVerdict = { replace: true; reason: 'no-lock' | 'dead-pid' | 'other-boot' } | { replace: false; reason: 'peer-live' | 'boot-unknown' | 'held'; detail60: string };

/**
 * TUI-DESIGN-5 §2.10: `lockReplaceVerdict`'s six-reason vocabulary over a `run.lock`, so `jevcode sessions unlock`
 * can PRODUCE all six rather than exporting three of them as unreachable constants.
 *
 * The ladder, in order:
 *   - no lock file at all            → `no-lock`      (replace)
 *   - the pid is gone                → `dead-pid`     (replace)
 *   - the pid is alive on ANOTHER host — a pid number from another machine means nothing in this pid table
 *                                    → `peer-live`    (refuse)
 *   - alive here, and the lock names a DIFFERENT boot — the kernel reused the number across a reboot
 *                                    → `other-boot`   (replace)
 *   - alive here, and the lock names no boot at all (written before round 5)
 *                                    → `boot-unknown` (refuse: it may be this run, and guessing costs a double writer)
 *   - alive here on THIS boot        → `held`         (refuse)
 *
 * Wiring the ENGINE's decision to the coordination verdict is harness work (§8.2 R6); this is the CLI explanation
 * §2.10 requires, and both must print the same six words so the text and the decision cannot drift.
 */
export function lockReplaceVerdict(lock: RunLock | null, o: { host: string; bootAt: string; isAlive: (pid: number) => boolean }): LockReplaceVerdict {
  if (lock === null) return { replace: true, reason: 'no-lock' };
  if (!o.isAlive(lock.pid)) return { replace: true, reason: 'dead-pid' };
  if (lock.host !== o.host) return { replace: false, reason: 'peer-live', detail60: `pid ${lock.pid} is alive on ${lock.host || 'an unknown host'}`.slice(0, 60) };
  if (lock.bootAt === undefined) return { replace: false, reason: 'boot-unknown', detail60: `pid ${lock.pid} is alive here; the lock names no boot`.slice(0, 60) };
  if (!sameBoot(lock.bootAt, o.bootAt)) return { replace: true, reason: 'other-boot' };
  return { replace: false, reason: 'held', detail60: `pid ${lock.pid} holds this run on this boot`.slice(0, 60) };
}

/** Read `<runDir>/run.lock`; null when absent, unreadable or malformed (a bad lock never blocks). */
export function readRunLock(runDir: string): RunLock | null {
  try {
    return parseRunLock(readFileSync(join(runDir, RUN_LOCK_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** TUI-DESIGN §8.5 (pure): a lock is live when it names this host and its pid is alive. */
export function lockIsLive(lock: RunLock, o: { host: string; isAlive: (pid: number) => boolean }): boolean {
  return lock.host === o.host && o.isAlive(lock.pid);
}

/** TUI-DESIGN §24: `run <id> is in use by pid 4242 since <t> (another jevcode?); run 'jevcode sessions unlock <id>' if that process is gone`. */
export function lockInUseMessage(runId: string, lock: RunLock): string {
  return `run ${runId} is in use by pid ${lock.pid} since ${lock.startedAt} (another jevcode?); run 'jevcode sessions unlock ${runId}' if that process is gone`;
}

export interface AcquireLockOptions {
  runId: string;
  pid: number;
  host: string;
  /** ISO timestamp for `startedAt` (passed in: no clock inside) */
  nowIso: string;
  /** §2.10: this boot's instant, written into the lock so `sessions unlock` can tell `other-boot` from `held` */
  bootAt?: string;
  /** liveness probe; `isPidAlive` by default */
  isAlive?: (pid: number) => boolean;
  /** receives the "replaced a stale lock" warning (jevcode.log) */
  warn?: (message: string) => void;
  /**
   * The initial read of the lock (default `readRunLock`); tests simulate two processes in the same race window with a
   * reader that returns null for both. The re-check after an `EEXIST` always reads the file that appeared.
   */
  readLock?: (runDir: string) => RunLock | null;
}

/**
 * TUI-DESIGN §8.5: take the lock. A live lock (same host, pid alive) throws `ConfigError` (exit 2) with the §24 message;
 * a stale one (dead pid or another host) is replaced and reported through `warn`. Two `jevcode` processes resuming the
 * same run in the same tick cannot both win: an empty slot is claimed with `O_EXCL` (`flag: 'wx'`) and an `EEXIST`
 * re-reads and re-evaluates the lock that appeared (live → ConfigError, untouched); a stale or unreadable lock is
 * replaced through write-to-temp + `renameSync`, so a concurrent reader never sees a torn file. Returns the lock that
 * was replaced.
 */
export function acquireRunLock(runDir: string, o: AcquireLockOptions): { replaced: RunLock | null } {
  const isAlive = o.isAlive ?? ((pid: number) => isPidAlive(pid));
  const read = o.readLock ?? readRunLock;
  const path = join(runDir, RUN_LOCK_FILE);
  const lock: RunLock = { pid: o.pid, startedAt: o.nowIso, host: o.host, bootAt: o.bootAt ?? bootAtNow() };
  const text = `${JSON.stringify(lock)}\n`;
  /** free (no lock) · ours (same pid) · stale (replaceable); a live foreign lock throws. */
  const evaluate = (existing: RunLock | null): 'free' | 'ours' | 'stale' => {
    if (existing === null) return 'free';
    if (existing.pid === o.pid) return 'ours';
    if (lockIsLive(existing, { host: o.host, isAlive })) throw new ConfigError(lockInUseMessage(o.runId, existing), { setting: 'resume' });
    return 'stale';
  };
  let existing = read(runDir);
  let verdict = evaluate(existing);
  if (verdict === 'free') {
    try {
      writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
      return { replaced: null };
    } catch (e) {
      if (errnoCode(e) !== 'EEXIST') throw e;
      // lost the race for the empty slot: judge the lock that won it
      existing = readRunLock(runDir);
      verdict = evaluate(existing);
    }
  }
  if (verdict === 'stale' && existing !== null) {
    const why = existing.host !== o.host ? `another host (${existing.host || 'unknown'})` : `pid ${existing.pid} is gone`;
    o.warn?.(`run ${o.runId}: replaced a stale run.lock from ${why}, started ${existing.startedAt || 'unknown'}`);
  }
  // ours, stale, or an unparsable file that appeared in the window: swap atomically
  const tmp = `${path}.${o.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  return { replaced: verdict === 'stale' ? existing : null };
}

/**
 * TUI-DESIGN §8.5: remove the lock. With `pid` given, only a lock this process wrote is removed (a newer holder's lock
 * survives). Never throws (an `'exit'` handler cannot recover); true when a file was removed.
 */
export function releaseRunLock(runDir: string, o: { pid?: number } = {}): boolean {
  const path = join(runDir, RUN_LOCK_FILE);
  try {
    if (o.pid !== undefined) {
      const existing = readRunLock(runDir);
      if (existing === null || existing.pid !== o.pid) return false;
    }
    rmSync(path, { force: false });
    return true;
  } catch {
    return false;
  }
}
