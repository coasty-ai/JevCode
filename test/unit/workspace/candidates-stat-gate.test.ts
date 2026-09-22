/**
 * The stat gate on `noteChanged` (HARNESS-NEXT-DESIGN §3 M7 shape, landed in wave S0 for the harness-overhead gate).
 *
 * Every `run` outcome feeds the whole reported dirty set back through `inspect`, which stats, resolves, and reads the
 * first 8 KB of each file to decide `binary` — serially. On the `step-overhead` fixture that is 50 files of 300 KiB
 * that did not change, on every `run` step, inside the gated `harnessMs`. The gate skips the read when size and
 * mtime are unchanged, and the inspections now run at `STAT_CONCURRENCY`; both must be invisible in the result.
 */
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';


import { createCandidateCache } from '../../../src/workspace/candidates.js';
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
  it('does not re-read a file whose size and mtime are unchanged (the skip is observable as a kept verdict)', async () => {
    const t = ws();
    const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
    writeFileSync(join(t.ws, 'a.bin'), Buffer.from([1, 2, 3, 4]));
    utimesSync(join(t.ws, 'a.bin'), stamp, stamp);
    const cache = cacheFor(t);
    await cache.noteChanged(['a.bin']);
    const before = cache.entries().get('a.bin');
    expect(before?.binary).toBe(false);
    expect(before?.mtimeMs).toBe(stamp.getTime());
    // the content changes to something binary, but size and mtime are put back exactly: nothing the gate can see,
    // and nothing that can happen to a file a command actually wrote
    writeFileSync(join(t.ws, 'a.bin'), Buffer.from([1, 0, 3, 4]));
    utimesSync(join(t.ws, 'a.bin'), stamp, stamp);
    await cache.noteChanged(['a.bin']);
    expect(cache.entries().get('a.bin')?.binary).toBe(false); // the 8 KB read was skipped
    expect(cache.entries().get('a.bin')?.touchedThisRun).toBe(true); // everything else is still updated
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

  it('records the mtime it gated on, so a cache written before the gate simply sniffs once', async () => {
    const t = ws();
    write(t.ws, 'd.txt', 'd\n');
    const cache = cacheFor(t);
    await cache.noteChanged(['d.txt']);
    expect(typeof cache.entries().get('d.txt')?.mtimeMs).toBe('number');
  });
});
