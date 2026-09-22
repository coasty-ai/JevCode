/**
 * The stat gate on `noteChanged` (HARNESS-NEXT-DESIGN §3 M7 shape, landed in wave S0 for the harness-overhead gate).
 *
 * Every `run` outcome feeds the whole reported dirty set back through `inspect`, which stats, resolves, and reads the
 * first 8 KB of each file to decide `binary` — serially. On the `step-overhead` fixture that is 50 files of 300 KiB
 * that did not change, on every `run` step, inside the gated `harnessMs`. The gate skips the read when size, mtime
 * **and** ctime are unchanged, and the inspections now run at `STAT_CONCURRENCY`; both must be invisible in the result.
 *
 * mtime + size alone would be unsound, and not in a theoretical way: `tar -x`, `cp -p`, `rsync -t`, `unzip` and any
 * restored build cache set mtime from the archive, so a same-size file can gain new content under an unchanged (even
 * an older) mtime. ctime is the inode-change time — moved by every write and by `utimes`, never settable backwards —
 * so it is what makes the skip safe. The cases below are the predicate (`statGateHit`) directly plus the two
 * end-to-end paths: a restored-mtime rewrite must be caught, an untouched file must keep its verdict.
 */
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';


import { createCandidateCache, statGateHit } from '../../../src/workspace/candidates.js';
import { tempWs, write } from './helpers.js';
import type { TempWs } from './helpers.js';

let temps: TempWs[] = [];
function ws(): TempWs {
  const t = tempWs();
  temps.push(t);
  return t;
}
afterEach(() => {

  for (const t of temps) t.cleanup();
  temps = [];
});

function cacheFor(t: TempWs): ReturnType<typeof createCandidateCache> {
  return createCandidateCache({
    root: t.ws,
    gitList: null,
    resolveRead: async (rel) => join(t.ws, rel),
    isSecret: () => false,
  });
}

describe('candidate cache stat gate', () => {
  it('reuses the sniff only when size, mtime and ctime all match', () => {
    const prev = { bytes: 4, binary: false, touchedThisRun: false, excluded: false, mtimeMs: 1000, ctimeMs: 2000 };
    expect(statGateHit(prev, { size: 4, mtimeMs: 1000, ctimeMs: 2000 })).toBe(true);
    // a `tar -x` / `cp -p` / `rsync -t` restore: same size, mtime put back from the archive, ctime necessarily newer
    expect(statGateHit(prev, { size: 4, mtimeMs: 1000, ctimeMs: 9000 })).toBe(false);
    // the archive's mtime is usually OLDER than the entry's, which an mtime-only "is it newer" gate would also miss
    expect(statGateHit(prev, { size: 4, mtimeMs: 500, ctimeMs: 9000 })).toBe(false);
    expect(statGateHit(prev, { size: 5, mtimeMs: 1000, ctimeMs: 2000 })).toBe(false);
    // an entry from a cache written before the gate carries neither stamp: sniff once
    expect(statGateHit({ bytes: 4, binary: false, touchedThisRun: false, excluded: false }, { size: 4, mtimeMs: 1000, ctimeMs: 2000 })).toBe(false);
    expect(statGateHit(undefined, { size: 4, mtimeMs: 1000, ctimeMs: 2000 })).toBe(false);
  });

  it('notices a same-size rewrite that restored the mtime (the tar -x / cp -p case the mtime-only gate missed)', async () => {
    const t = ws();
    const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
    writeFileSync(join(t.ws, 'a.bin'), Buffer.from([1, 2, 3, 4]));
    utimesSync(join(t.ws, 'a.bin'), stamp, stamp);
    const cache = cacheFor(t);
    await cache.noteChanged(['a.bin']);
    const before = cache.entries().get('a.bin');
    expect(before?.binary).toBe(false);
    expect(before?.mtimeMs).toBe(stamp.getTime());
    // the content becomes binary and the mtime is put back exactly — what an archive extraction does. ctime moved,
    // so the sniff runs and the verdict flips; under the mtime-only gate this file stayed a listed text candidate.
    writeFileSync(join(t.ws, 'a.bin'), Buffer.from([1, 0, 3, 4]));
    utimesSync(join(t.ws, 'a.bin'), stamp, stamp);
    await cache.noteChanged(['a.bin']);
    expect(cache.entries().get('a.bin')?.mtimeMs).toBe(stamp.getTime());
    expect(cache.entries().get('a.bin')?.binary).toBe(true);
    expect(cache.entries().get('a.bin')?.excluded).toBe(true);
    expect(cache.entries().get('a.bin')?.touchedThisRun).toBe(true);
  });

  it('keeps the verdict and the stamps of a file nothing touched (the case the gate exists for)', async () => {
    const t = ws();
    write(t.ws, 'quiet.txt', 'unchanged\n');
    const cache = cacheFor(t);
    await cache.noteChanged(['quiet.txt']);
    const first = cache.entries().get('quiet.txt');
    expect(first?.binary).toBe(false);
    await cache.noteChanged(['quiet.txt']);
    const second = cache.entries().get('quiet.txt');
    expect(second?.mtimeMs).toBe(first?.mtimeMs);
    expect(second?.ctimeMs).toBe(first?.ctimeMs);
    expect(statGateHit(first, { size: second!.bytes, mtimeMs: second!.mtimeMs!, ctimeMs: second!.ctimeMs! })).toBe(true);
  });

  it('still notices a same-size rewrite that moved the mtime', async () => {
    const t = ws();
    writeFileSync(join(t.ws, 'c.bin'), Buffer.from([1, 2, 3, 4]));
    const cache = cacheFor(t);
    await cache.noteChanged(['c.bin']);
    expect(cache.entries().get('c.bin')?.binary).toBe(false);
    // same size, new content with a NUL, mtime pushed a second forward (an APFS-granularity rewrite)
    writeFileSync(join(t.ws, 'c.bin'), Buffer.from([1, 0, 3, 4]));
    const later = new Date(Date.now() + 1000);
    utimesSync(join(t.ws, 'c.bin'), later, later);
    await cache.noteChanged(['c.bin']);
    expect(cache.entries().get('c.bin')?.binary).toBe(true);
    expect(cache.entries().get('c.bin')?.excluded).toBe(true);
  });

  it('gives the same cache as the serial loop for a mixed batch: new, changed, deleted, escaping and repeated paths', async () => {
    const t = ws();
    write(t.ws, 'keep.txt', 'keep\n');
    write(t.ws, 'gone.txt', 'gone\n');
    const cache = cacheFor(t);
    await cache.list();
    expect([...cache.entries().keys()].sort()).toEqual(['gone.txt', 'keep.txt']);
    write(t.ws, 'new.txt', 'new\n');
    writeFileSync(join(t.ws, 'gone.txt'), '');
    const { rmSync } = await import('node:fs');
    rmSync(join(t.ws, 'gone.txt'));
    await cache.noteChanged(['new.txt', 'gone.txt', '../outside.txt', 'keep.txt', 'keep.txt']);
    expect([...cache.entries().keys()].sort()).toEqual(['keep.txt', 'new.txt']);
    expect(cache.entries().get('new.txt')?.touchedThisRun).toBe(true);
    expect((await cache.list()).map((c) => c.path)).toEqual(['keep.txt', 'new.txt']);
  });

  it('records both stamps it gated on, so a cache written before the gate simply sniffs once', async () => {
    const t = ws();
    write(t.ws, 'd.txt', 'd\n');
    const cache = cacheFor(t);
    await cache.noteChanged(['d.txt']);
    expect(typeof cache.entries().get('d.txt')?.mtimeMs).toBe('number');
    expect(typeof cache.entries().get('d.txt')?.ctimeMs).toBe('number');
  });
});
