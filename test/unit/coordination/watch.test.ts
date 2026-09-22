/**
 * §3.5 change detection without a daemon: one `fs.watch(dir, { persistent: false })` per watched root, a 100 ms debounce
 * exactly like `useGitHead`, plus a 15 s `setInterval(…).unref()` poll for the sync tools and network filesystems that
 * emit no events. Callbacks run on the debounce tick, never inside a watcher callback; a root whose watcher fails is
 * reported once and left poll-only.
 */
import { describe, expect, it } from 'vitest';
import { createWatcher, nodeTimers, POLL_MS, WATCH_DEBOUNCE_MS } from '../../../src/coordination/watch.js';
import type { WatchFn } from '../../../src/coordination/watch.js';
import { fakeTimers } from './helpers.js';

interface FakeWatcher {
  dir: string;
  fire(): void;
  error(e: unknown): void;
  closed: boolean;
}

function fakeWatch(): { watch: WatchFn; made: FakeWatcher[]; fail: Set<string> } {
  const made: FakeWatcher[] = [];
  const fail = new Set<string>();
  const watch = ((dir: string, _o: unknown, cb: () => void) => {
    if (fail.has(dir)) throw Object.assign(new Error('ENOSPC watchers'), { code: 'ENOSPC' });
    const handlers: ((e: unknown) => void)[] = [];
    const w: FakeWatcher = {
      dir,
      fire: cb,
      error: (e) => handlers.forEach((h) => h(e)),
      closed: false,
    };
    made.push(w);
    return {
      on: (_ev: string, h: (e: unknown) => void) => handlers.push(h),
      close: () => {
        w.closed = true;
      },
    };
  }) as unknown as WatchFn;
  return { watch, made, fail };
}

function harness(o: { debounceMs?: number; pollMs?: number } = {}) {
  const { watch, made, fail } = fakeWatch();
  const timers = fakeTimers();
  const bursts: string[][] = [];
  let polls = 0;
  const errors: { dir: string; code: string }[] = [];
  const w = createWatcher({
    watch,
    timers,
    ...(o.debounceMs !== undefined ? { debounceMs: o.debounceMs } : {}),
    ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
    onChange: (dirs) => bursts.push([...dirs].sort()),
    onPoll: () => polls++,
    onError: (dir, e) => errors.push({ dir, code: (e as { code?: string }).code ?? 'EUNKNOWN' }),
  });
  return { w, made, fail, timers, bursts, errors, polls: () => polls };
}

describe('the watcher (§3.5)', () => {
  it('a burst of events on several roots becomes ONE debounced callback naming every dir', () => {
    const h = harness();
    h.w.add('/c/registry');
    h.w.add('/c/leases');
    expect(h.w.dirs().sort()).toEqual(['/c/leases', '/c/registry']);
    for (const m of h.made) {
      m.fire();
      m.fire();
    }
    expect(h.bursts).toEqual([]); // nothing runs inside a watcher callback
    h.timers.tick(WATCH_DEBOUNCE_MS);
    expect(h.bursts).toEqual([['/c/leases', '/c/registry']]);
    // the set is cleared between bursts
    h.timers.tick(WATCH_DEBOUNCE_MS * 5);
    expect(h.bursts).toHaveLength(1);
  });

  it('the debounce restarts on every event, so a steady stream fires once at the end', () => {
    const h = harness({ debounceMs: 100 });
    h.w.add('/c/registry');
    const m = h.made[0]!;
    for (let i = 0; i < 5; i++) {
      m.fire();
      h.timers.tick(90);
    }
    expect(h.bursts).toEqual([]);
    h.timers.tick(100);
    expect(h.bursts).toEqual([['/c/registry']]);
  });

  it('the 15 s poll is armed by start(), not by creation, and repeats', () => {
    const h = harness();
    h.w.add('/c/registry');
    h.timers.tick(POLL_MS * 2);
    expect(h.polls()).toBe(0); // zero timers before start()
    h.w.start();
    h.timers.tick(POLL_MS * 3);
    expect(h.polls()).toBe(3);
  });

  it('a root whose fs.watch throws is reported once and simply not watched (poll-only)', () => {
    const h = harness();
    h.fail.add('/c/nfs');
    expect(h.w.add('/c/nfs')).toBe(false);
    expect(h.errors).toEqual([{ dir: '/c/nfs', code: 'ENOSPC' }]);
    expect(h.w.has('/c/nfs')).toBe(false);
    // the other roots still work
    h.w.add('/c/registry');
    h.made[0]!.fire();
    h.timers.tick(WATCH_DEBOUNCE_MS);
    expect(h.bursts).toEqual([['/c/registry']]);
  });

  it("a root that emits 'error' is dropped and reported, and can be re-added later", () => {
    const h = harness();
    h.w.add('/c/registry');
    h.made[0]!.error(Object.assign(new Error('gone'), { code: 'ESTALE' }));
    expect(h.errors).toEqual([{ dir: '/c/registry', code: 'ESTALE' }]);
    expect(h.w.has('/c/registry')).toBe(false);
    expect(h.w.add('/c/registry')).toBe(true);
    expect(h.w.has('/c/registry')).toBe(true);
  });

  it('add is idempotent and close() releases every watcher and timer', () => {
    const h = harness();
    h.w.add('/c/registry');
    h.w.add('/c/registry');
    expect(h.made).toHaveLength(1);
    h.w.start();
    h.w.close();
    expect(h.made[0]?.closed).toBe(true);
    expect(h.w.dirs()).toEqual([]);
    h.timers.tick(POLL_MS * 2);
    expect(h.polls()).toBe(0);
    // events after close are inert
    h.made[0]!.fire();
    h.timers.tick(WATCH_DEBOUNCE_MS);
    expect(h.bursts).toEqual([]);
    expect(h.w.add('/c/other')).toBe(false);
  });

  it('remove() stops one root without touching the others', () => {
    const h = harness();
    h.w.add('/a');
    h.w.add('/b');
    h.w.remove('/a');
    expect(h.w.dirs()).toEqual(['/b']);
    h.made[1]!.fire();
    h.timers.tick(WATCH_DEBOUNCE_MS);
    expect(h.bursts).toEqual([['/b']]);
  });

  it('the production timers unref the poll so it never holds the process open', () => {
    const handle = nodeTimers.setInterval(() => undefined, 60_000) as { hasRef?: () => boolean };
    expect(handle.hasRef?.()).toBe(false);
    nodeTimers.clearInterval(handle);
    const t = nodeTimers.setTimeout(() => undefined, 60_000);
    nodeTimers.clearTimeout(t);
    expect(WATCH_DEBOUNCE_MS).toBe(100);
    expect(POLL_MS).toBe(15_000);
  });
});
