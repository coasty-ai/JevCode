/**
 * `<runDir>/run.lock` (TUI-DESIGN §8.5, A55): `{ "pid", "startedAt", "host" }` written by `createEngine` after
 * `store.create` / the resume load, removed in `finish()` and by the `'exit'` handler. On resume a lock whose pid is
 * alive on the same host is a `ConfigError` (exit 2) with the §24 message; a dead pid or another host is replaced with
 * a warning. Everything is synchronous so the `'exit'` handler can release it.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isJsonObject, parseJson } from '../core/json.js';
import { ConfigError } from '../errors.js';

export const RUN_LOCK_FILE = 'run.lock';

export interface RunLock {
  pid: number;
  startedAt: string;
  host: string;
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
  return { pid, startedAt: typeof o['startedAt'] === 'string' ? o['startedAt'] : '', host: typeof o['host'] === 'string' ? o['host'] : '' };
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
  const lock: RunLock = { pid: o.pid, startedAt: o.nowIso, host: o.host };
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
