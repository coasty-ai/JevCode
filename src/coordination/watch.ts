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

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const nodeTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
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
      let w: FSWatcher;
      try {
        w = watchImpl(dir, { persistent: false }, () => schedule(dir));
      } catch (e) {
        o.onError(dir, e);
        return false;
      }
      watchers.set(dir, w);
      w.on('error', (e) => {
        if (closed) return;
        drop(dir);
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
