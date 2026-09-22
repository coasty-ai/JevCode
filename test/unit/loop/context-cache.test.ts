/**
 * Files in view (docs/COORDINATION-DESIGN.md §8.4): the LRU-by-tokens cache with pin order, `fileMemory`, and the two
 * properties the round promised — every path read or edited stays in view until it is evicted, and a read of an unchanged
 * file already in view costs no generator tokens and no I/O beyond one stat.
 */
import { describe, expect, it } from 'vitest';
import type { FileView } from '../../../src/core/types.js';
import {
  FilesInView,
  PIN_RANK,
  boundMemory,
  dropFile,
  evictFiles,
  evictionOrder,
  forgetFile,
  noteShown,
  rememberFile,
  sameStat,
  touchFile,
  viewOrder,
  type FileStatInfo,
  type FilesInViewDeps,
} from '../../../src/loop/context/context-cache.js';
import { FILE_CACHE_MAX_ENTRIES, FILE_MEMORY_MAX_ENTRIES } from '../../../src/loop/context/limits.js';
import type { FileCacheEntry, FileMemory } from '../../../src/loop/context/types.js';

/** An in-memory disk: content by path, a stat that only moves when the content is replaced. */
function disk(files: Record<string, string>) {
  const content = new Map(Object.entries(files));
  const mtime = new Map<string, number>([...content.keys()].map((k) => [k, 1_000]));
  const counters = { stats: 0, reads: 0, hashes: 0 };
  const deps: FilesInViewDeps = {
    async stat(rel): Promise<FileStatInfo | null> {
      counters.stats += 1;
      const c = content.get(rel);
      return c === undefined ? null : { size: c.length, mtimeMs: mtime.get(rel) ?? 0 };
    },
    async read(rel, maxBytes): Promise<FileView> {
      counters.reads += 1;
      const c = content.get(rel);
      if (c === undefined) throw new Error(`no such file: ${rel}`);
      const shown = c.length > maxBytes ? c.slice(0, maxBytes) : c;
      return { path: rel, content: shown, bytes: c.length, truncatedBytes: c.length - shown.length };
    },
    async hash(rel) {
      counters.hashes += 1;
      const c = content.get(rel);
      return c === undefined ? null : `hash-${c.length}-${rel}`.slice(0, 12);
    },
  };
  return {
    deps,
    counters,
    /** replace a file's content and move its mtime, like a real editor would */
    write(rel: string, text: string) {
      content.set(rel, text);
      mtime.set(rel, (mtime.get(rel) ?? 1_000) + 1_000);
    },
    /** rewrite the same bytes: the stat moves, the content does not (the sha decides) */
    touch(rel: string) {
      mtime.set(rel, (mtime.get(rel) ?? 1_000) + 1_000);
    },
    remove(rel: string) {
      content.delete(rel);
      mtime.delete(rel);
    },
  };
}

function cache(...entries: [string, FileCacheEntry['pinnedBy'], number][]): FileCacheEntry[] {
  return entries.map(([rel, pinnedBy, lastUsedStep]) => ({ rel, pinnedBy, lastUsedStep, bytesShown: 0 }));
}

describe('§8.4 fileCache (pure)', () => {
  it('a path read or edited enters the cache and a stronger pin wins; lastUsedStep only moves forward', () => {
    let c = touchFile([], 'src/a.ts', 'read', 3);
    expect(c).toEqual([{ rel: 'src/a.ts', pinnedBy: 'read', lastUsedStep: 3, bytesShown: 0 }]);
    c = touchFile(c, 'src/a.ts', 'edit', 5);
    expect(c[0]).toMatchObject({ pinnedBy: 'edit', lastUsedStep: 5 });
    // a weaker pin at a later step keeps the pin and moves the step
    c = touchFile(c, 'src/a.ts', 'read', 7);
    expect(c[0]).toMatchObject({ pinnedBy: 'edit', lastUsedStep: 7 });
    // an older step never rewinds
    c = touchFile(c, 'src/a.ts', 'read', 2);
    expect(c[0]!.lastUsedStep).toBe(7);
    expect(dropFile(c, 'src/a.ts')).toEqual([]);
  });

  it('eviction is LRU by lastUsedStep with pins ordered human > jev > seed > edit > read', () => {
    expect(PIN_RANK.human).toBeGreaterThan(PIN_RANK.jev);
    expect(PIN_RANK.jev).toBeGreaterThan(PIN_RANK.seed);
    expect(PIN_RANK.seed).toBeGreaterThan(PIN_RANK.edit);
    expect(PIN_RANK.edit).toBeGreaterThan(PIN_RANK.read);
    const c = cache(['human.ts', 'human', 1], ['read-old.ts', 'read', 1], ['read-new.ts', 'read', 9], ['edit.ts', 'edit', 2]);
    expect(evictionOrder(c).map((e) => e.rel)).toEqual(['read-old.ts', 'read-new.ts', 'edit.ts', 'human.ts']);
    expect(viewOrder(c).map((e) => e.rel)).toEqual(['human.ts', 'edit.ts', 'read-new.ts', 'read-old.ts']);
    const { kept, evicted } = evictFiles(c, { maxEntries: 2, maxBytes: 1_000_000 });
    expect(evicted.map((e) => e.rel)).toEqual(['read-old.ts', 'read-new.ts']);
    expect(kept.map((e) => e.rel)).toEqual(['human.ts', 'edit.ts']);
  });

  it('eviction is by tokens as well: Σ bytesShown over the byte bound drops the least valuable first', () => {
    const c = noteShown(cache(['a.ts', 'read', 1], ['b.ts', 'read', 2], ['c.ts', 'human', 1]), new Map([['a.ts', 30_000], ['b.ts', 30_000], ['c.ts', 30_000]]));
    const { kept } = evictFiles(c, { maxEntries: 16, maxBytes: 96 * 1024 });
    expect(kept.map((e) => e.rel)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    const tight = evictFiles(c, { maxEntries: 16, maxBytes: 65_000 });
    expect(tight.evicted.map((e) => e.rel)).toEqual(['a.ts']);
    // the human pin is the last thing to go
    const tighter = evictFiles(c, { maxEntries: 16, maxBytes: 10 });
    expect(tighter.kept.map((e) => e.rel)).toEqual(['c.ts']);
  });

  it('the entry bound is the documented 16 and the memory bound 64, most recently touched kept', () => {
    let c: FileCacheEntry[] = [];
    for (let i = 0; i < 40; i++) c = touchFile(c, `f${i}.ts`, 'read', i);
    expect(evictFiles(c).kept).toHaveLength(FILE_CACHE_MAX_ENTRIES);
    expect(evictFiles(c).kept.map((e) => e.rel)).toContain('f39.ts');
    let m: FileMemory = {};
    for (let i = 0; i < 100; i++) m = rememberFile(m, `f${i}.ts`, { readAt: i });
    const bounded = boundMemory(m);
    expect(Object.keys(bounded)).toHaveLength(FILE_MEMORY_MAX_ENTRIES);
    expect(bounded['f99.ts']).toBeDefined();
    expect(bounded['f0.ts']).toBeUndefined();
  });

  it('fileMemory patches merge and forget removes', () => {
    let m = rememberFile({}, 'src/a.ts', { readAt: 2, bytes: 10 });
    expect(m['src/a.ts']).toEqual({ sha12: null, bytes: 10, readAt: 2, editedAt: null });
    m = rememberFile(m, 'src/a.ts', { editedAt: 4, sha12: 'abc123' });
    expect(m['src/a.ts']).toEqual({ sha12: 'abc123', bytes: 10, readAt: 2, editedAt: 4 });
    expect(forgetFile(m, 'src/a.ts')).toEqual({});
    expect(forgetFile(m, 'nope.ts')).toBe(m);
  });
});

describe('§8.4 FilesInView (content cache)', () => {
  const step = 7;

  it('an unchanged file costs one stat and no read; a changed one is re-read', async () => {
    const d = disk({ 'src/a.ts': 'A'.repeat(100), 'src/b.ts': 'B'.repeat(100) });
    const view = new FilesInView(d.deps);
    const c = cache(['src/a.ts', 'edit', 6], ['src/b.ts', 'read', 5]);
    const first = await view.refresh(c, step);
    expect(first.reads).toBe(2);
    expect(first.stats).toBe(2);
    expect(first.files.map((f) => f.rel)).toEqual(['src/a.ts', 'src/b.ts']);
    const second = await view.refresh(c, step + 1);
    expect(second.stats).toBe(2);
    expect(second.reads).toBe(0);
    expect(second.files[0]!.content).toBe('A'.repeat(100));
    d.write('src/b.ts', 'B'.repeat(200));
    const third = await view.refresh(c, step + 2);
    expect(third.reads).toBe(1);
    expect(third.files.find((f) => f.rel === 'src/b.ts')!.content).toHaveLength(200);
  });

  it('a read of an unchanged file in view returns the pointer line with no read at all', async () => {
    const d = disk({ 'src/a.ts': 'A'.repeat(100) });
    const view = new FilesInView(d.deps);
    const memory = rememberFile({}, 'src/a.ts', { readAt: 4 });
    await view.refresh(cache(['src/a.ts', 'read', 4]), step);
    const before = { ...d.counters };
    const r = await view.unchanged('src/a.ts', memory);
    expect(r?.text).toMatch(/^unchanged since step 4 \(sha [0-9a-z-]{4}…\); contents are under Files in view$/);
    expect(d.counters.stats - before.stats).toBe(1);
    expect(d.counters.reads - before.reads).toBe(0);
    expect(d.counters.hashes - before.hashes).toBe(0);
  });

  it('a stat mismatch falls back to the content hash: same bytes → still free, new bytes → the read runs', async () => {
    const d = disk({ 'src/a.ts': 'A'.repeat(100) });
    const view = new FilesInView(d.deps);
    await view.refresh(cache(['src/a.ts', 'read', 4]), step);
    d.touch('src/a.ts');
    expect(await view.unchanged('src/a.ts', {})).not.toBeNull();
    d.write('src/a.ts', 'A'.repeat(101));
    expect(await view.unchanged('src/a.ts', {})).toBeNull();
    // a path that was never in view, and one that is gone, are never free
    expect(await view.unchanged('src/other.ts', {})).toBeNull();
    d.remove('src/a.ts');
    expect(await view.unchanged('src/a.ts', {})).toBeNull();
  });

  it('invalidate() forces the next build to re-read (edit / write / patch / run targets)', async () => {
    const d = disk({ 'src/a.ts': 'A' });
    const view = new FilesInView(d.deps);
    const c = cache(['src/a.ts', 'edit', 1]);
    await view.refresh(c, 1);
    expect(view.has('src/a.ts')).toBe(true);
    view.invalidate(['src/a.ts']);
    expect(view.has('src/a.ts')).toBe(false);
    const after = await view.refresh(c, 2);
    expect(after.reads).toBe(1);
    // an invalidated path is never reported unchanged (a run that rewrote the same bytes still re-reads once)
    view.invalidate(['src/a.ts']);
    expect(await view.unchanged('src/a.ts', {})).toBeNull();
    view.clear();
    expect(view.size).toBe(0);
  });

  it('the byte budget lists the overflow by name instead of dropping it silently, and a gone file is reported', async () => {
    const d = disk({ 'big.ts': 'x'.repeat(20_000), 'small.ts': 'y'.repeat(10), 'gone.ts': 'z' });
    d.remove('gone.ts');
    const view = new FilesInView(d.deps);
    const r = await view.refresh(cache(['big.ts', 'human', 2], ['small.ts', 'read', 1], ['gone.ts', 'read', 1]), step, 25_000);
    expect(r.failed.map((f) => f.rel)).toEqual(['gone.ts']);
    const big = r.files.find((f) => f.rel === 'big.ts')!;
    const small = r.files.find((f) => f.rel === 'small.ts')!;
    expect(big.omitted).toBe(false);
    expect(small.omitted).toBe(false);
    const tight = await view.refresh(cache(['big.ts', 'human', 2], ['small.ts', 'read', 1]), step, 100);
    expect(tight.files.find((f) => f.rel === 'big.ts')!.omitted).toBe(true);
    expect(tight.files.find((f) => f.rel === 'big.ts')!.shownChars).toBe(0);
  });

  it('a file over the per-file bound is truncated with its byte count kept, and huge files are never hashed', async () => {
    const d = disk({ 'huge.ts': 'x'.repeat(200_000) });
    const view = new FilesInView({ ...d.deps, maxFileChars: 1_000, maxHashBytes: 1_000 });
    const r = await view.refresh(cache(['huge.ts', 'read', 1]), step);
    expect(r.files[0]!.content).toHaveLength(1_000);
    expect(r.files[0]!.bytes).toBe(200_000);
    expect(r.files[0]!.truncatedBytes).toBe(199_000);
    expect(r.hashes).toBe(0);
    expect(sameStat({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 2 })).toBe(true);
    expect(sameStat({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 3 })).toBe(false);
  });
});
