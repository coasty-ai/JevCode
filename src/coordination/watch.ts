/**
 * Change detection without a daemon (§3.5, §12.0.4 "decided"): one `fs.watch(dir, { persistent: false })` per watched root,
 * a 100 ms debounce exactly like `useGitHead` (`src/tui/useGitHead.ts`), plus a 15 s `setInterval(…).unref()` poll for sync
 * tools and NFS that emit no events. The ledger owns what to scan; this module only says WHICH directories fired, on the
 * debounce tick, never inside a watcher callback. A watcher error on a root is reported once and that root is poll-only
 * until the ledger re-adds it. Timers and `fs.watch` are injected so tests never wait.
 */
import { watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';

export const WATCH_DEBOUNCE_MS = 100;
export const POLL_MS = 15_000;
/**
 * + re-check (lower 7): how long a root whose `fs.watch` failed is left alone before it is tried again. Longer than
 * the poll, so `attachWatchers()` does not re-attempt the same bad root every tick (an `EMFILE` storm); short enough
 * that a transient failure heals within a minute. The poll still READS the root, so only the event stream is lost.
 */
export const RETRY_WATCH_MS = 60_000;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const nodeTimers: Timers = {
  // + review minor 22: unref'd like the poll interval. A pending debounce (or an `awaitAck` timeout, which uses the
  // same seam) held the event loop open, so `jevcode sessions tell …` sat for up to 5 s after its work was done.
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export type WatchFn = typeof fsWatch;

export interface WatcherOptions {
  watch?: WatchFn;
  timers?: Timers;
  debounceMs?: number;
  pollMs?: number;
  /** injected wall clock for the failed-root backoff (+ re-check lower 7) */
  now?: () => number;
  /** the debounced burst: every directory that fired at least one event */
  onChange(dirs: ReadonlySet<string>): void;
  /** the poll tick */
  onPoll(): void;
  /** a root's watcher failed (creation or `'error'`); the root is dropped from the watch set */
  onError(dir: string, error: unknown): void;
}

export interface Watcher {
  /** start watching a directory; false when `fs.watch` refused (the root stays poll-only) */
  add(dir: string): boolean;
  remove(dir: string): void;
  has(dir: string): boolean;
  dirs(): string[];
  /** the poll interval is armed here, not at creation (zero I/O and zero timers before `open()`) */
  start(): void;
  close(): void;
}

export function createWatcher(o: WatcherOptions): Watcher {
  const watchImpl = o.watch ?? fsWatch;
  const timers = o.timers ?? nodeTimers;
  const debounceMs = o.debounceMs ?? WATCH_DEBOUNCE_MS;
  const pollMs = o.pollMs ?? POLL_MS;
  const watchers = new Map<string, FSWatcher>();
  /**
   * + re-check (lower 7): roots whose `fs.watch` FAILED. `attachWatchers()` runs on every 15 s poll and re-`add`ed
   * every failed root each time, so an `EMFILE` (or a directory the OS cannot watch at all) became a repeating
   * syscall storm plus one `onError` per root per tick for the life of the process. A failed root is remembered and
   * retried only after `RETRY_WATCH_MS`; the poll still reads it, so nothing is missed — only the event stream is.
   */
  const failed = new Map<string, number>();
  const fired = new Set<string>();
  let timer: unknown = null;
  let poll: unknown = null;
  let closed = false;

  const fire = (): void => {
    timer = null;
    if (closed) return;
    const dirs = new Set(fired);
    fired.clear();
    if (dirs.size > 0) o.onChange(dirs);
  };
  const schedule = (dir: string): void => {
    if (closed) return;
    fired.add(dir);
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(fire, debounceMs);
  };
  const drop = (dir: string): void => {
    const w = watchers.get(dir);
    watchers.delete(dir);
    if (w !== undefined) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
  };

  return {
    add(dir) {
      if (closed || watchers.has(dir)) return watchers.has(dir);
      const failedAt = failed.get(dir);
      // + re-check (lower 7): back off instead of re-trying a known-bad root on every 15 s `attachWatchers()`
      if (failedAt !== undefined && (o.now ?? Date.now)() - failedAt < RETRY_WATCH_MS) return false;
      let w: FSWatcher;
      try {
        w = watchImpl(dir, { persistent: false }, () => schedule(dir));
      } catch (e) {
        failed.set(dir, (o.now ?? Date.now)());
        o.onError(dir, e);
        return false;
      }
      failed.delete(dir);
      watchers.set(dir, w);
      w.on('error', (e) => {
        if (closed) return;
        drop(dir);
        failed.set(dir, (o.now ?? Date.now)());
        o.onError(dir, e);
      });
      return true;
    },
    remove: drop,
    has: (dir) => watchers.has(dir),
    dirs: () => [...watchers.keys()],
    start() {
      if (closed || poll !== null) return;
      poll = timers.setInterval(() => {
        if (!closed) o.onPoll();
      }, pollMs);
    },
    close() {
      closed = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      if (poll !== null) timers.clearInterval(poll);
      poll = null;
      for (const dir of [...watchers.keys()]) drop(dir);
      fired.clear();
    },
  };
}
