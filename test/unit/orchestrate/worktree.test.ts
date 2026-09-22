/**
 * `src/orchestrate/worktree.ts` — the binary-safe dirty-set sync [G9] and the measured clean
 * probe [G10] (ORCHESTRATION-DESIGN §2.3, corner rows 16 and 17), against a real temp repository.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sha256Hex } from '../../../src/core/hash.js';
import { DIRTY_ENTRIES_MAX } from '../../../src/core/limits.js';
import { applyDirtySnapshot, carriedPaths, cleanProbe, dirtyPaths, dirtySnapshot, parseStatusZ } from '../../../src/orchestrate/worktree.js';
import { git, tempRepo, write } from './helpers.js';
import type { TempRepo } from './helpers.js';

const repos: TempRepo[] = [];

function repo(files?: Record<string, string>): TempRepo {
  const r = tempRepo(files);
  repos.push(r);
  return r;
}

afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
});

/** Every one of the 256 byte values, twice, so no `utf8` round trip can survive it. */
function allBytes(): Buffer {
  const a: number[] = [];
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 256; i++) a.push(i);
  return Buffer.from(a);
}

describe('parseStatusZ', () => {
  it('consumes a rename\'s original path instead of reading the next entry off by one', () => {
    const out = ' M src/a.ts\0R  new.ts\0old.ts\0?? untracked.ts\0 D gone.ts\0';
    expect(parseStatusZ(out)).toEqual([
      { path: 'src/a.ts', from: null, deleted: false, untracked: false },
      { path: 'new.ts', from: 'old.ts', deleted: false, untracked: false },
      { path: 'untracked.ts', from: null, deleted: false, untracked: true },
      { path: 'gone.ts', from: null, deleted: true, untracked: false },
    ]);
  });
});

describe('dirtySnapshot / applyDirtySnapshot', () => {
  it('[G9] corner row 17: a dirty binary file round-trips byte for byte, with its mode', async () => {
    const r = repo({ 'README.md': 'x\n', 'fixture/img.bin': 'placeholder\n' });
    const bytes = allBytes();
    write(r.ws, 'fixture/img.bin', bytes); // tracked, now modified with hostile bytes
    write(r.ws, 'tool.sh', Buffer.from('#!/bin/sh\nexit 0\n')); // untracked, executable
    chmodSync(join(r.ws, 'tool.sh'), 0o755);

    const snap = await dirtySnapshot(r.runGit, r.ws);
    expect(snap.dropped).toBe(0);
    const img = snap.files.find((f) => f.path === 'fixture/img.bin');
    const tool = snap.files.find((f) => f.path === 'tool.sh');
    expect(img?.bytes).toBeInstanceOf(Buffer);
    expect(tool?.mode).toBe(0o755);

    const dest = join(r.base, 'agent');
    mkdirSync(dest, { recursive: true });
    const entries = await applyDirtySnapshot(snap.files, dest);

    const applied = readFileSync(join(dest, 'fixture/img.bin'));
    expect(applied.equals(bytes)).toBe(true);
    expect(statSync(join(dest, 'tool.sh')).mode & 0o7777).toBe(0o755);

    // the `utf8` read of lanes.ts:171 would have corrupted exactly this file — assert it did not
    const mangled = Buffer.from(readFileSync(join(r.ws, 'fixture/img.bin'), 'utf8'), 'utf8');
    expect(mangled.equals(bytes)).toBe(false);
    expect(applied.equals(mangled)).toBe(false);

    // [D2] the recorded sha is of the bytes WRITTEN, which is what `carried` compares against
    const entry = entries.find((e) => e.path === 'fixture/img.bin');
    expect(entry?.sha256).toBe(sha256Hex(bytes));
    expect(entry?.mode).toBe(0o644);
    expect(await carriedPaths(dest, entries)).toEqual(expect.arrayContaining(['fixture/img.bin', 'tool.sh']));
  });

  it('corner row 16: above DIRTY_ENTRIES_MAX the untracked entries are dropped and counted', async () => {
    const r = repo();
    write(r.ws, 'README.md', 'modified\n');
    for (let i = 0; i < DIRTY_ENTRIES_MAX + 5; i++) write(r.ws, `junk/f${i}.txt`, `${i}\n`);

    const snap = await dirtySnapshot(r.runGit, r.ws);
    expect(snap.dropped).toBe(DIRTY_ENTRIES_MAX + 5);
    expect(snap.files.map((f) => f.path)).toEqual(['README.md']);
  });

  it('keeps every entry when the list fits, and honours an explicit max', async () => {
    const r = repo();
    for (let i = 0; i < 4; i++) write(r.ws, `j${i}.txt`, `${i}\n`);
    expect((await dirtySnapshot(r.runGit, r.ws)).files).toHaveLength(4);
    const small = await dirtySnapshot(r.runGit, r.ws, 2);
    expect(small.files).toHaveLength(0);
    expect(small.dropped).toBe(4);
  });

  it('a deleted file is carried as bytes:null, replayed as a deletion and recorded with sha256 \'\'', async () => {
    const r = repo({ 'README.md': 'x\n', 'gone.txt': 'bye\n' });
    rmSync(join(r.ws, 'gone.txt'));

    const snap = await dirtySnapshot(r.runGit, r.ws);
    expect(snap.files).toEqual([{ path: 'gone.txt', bytes: null, mode: 0 }]);

    const dest = join(r.base, 'agent');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'gone.txt'), 'still here\n');
    const entries = await applyDirtySnapshot(snap.files, dest);
    expect(existsSync(join(dest, 'gone.txt'))).toBe(false);
    expect(entries).toEqual([{ path: 'gone.txt', sha256: '', mode: 0 }]);

    // carried while still absent; recreating it is a change like any other
    expect(await carriedPaths(dest, entries)).toEqual(['gone.txt']);
    writeFileSync(join(dest, 'gone.txt'), 'the agent put it back\n');
    expect(await carriedPaths(dest, entries)).toEqual([]);
  });

  it('skips a path that is not a regular file', async () => {
    const r = repo();
    symlinkSync(join(r.ws, 'nowhere.txt'), join(r.ws, 'dangling.txt'));
    const snap = await dirtySnapshot(r.runGit, r.ws);
    expect(snap.files).toEqual([]);
  });

  it('dirtyPaths names a rename\'s source as well as its destination', async () => {
    const r = repo({ 'README.md': 'x\n', 'old.ts': 'content\n' });
    git(r.ws, 'mv', 'old.ts', 'new.ts');
    const { paths, ok } = await dirtyPaths(r.runGit, r.ws);
    expect(ok).toBe(true);
    expect(paths).toContain('new.ts');
    expect(paths).toContain('old.ts');
  });
});

describe('cleanProbe [G10]', () => {
  it('is dirty only outside carried ∪ syncedIgnored', async () => {
    const r = repo({ 'README.md': 'x\n', 'src/a.ts': 'a\n' });
    // the "sync" wrote these two into the agent worktree
    write(r.ws, 'src/a.ts', 'parent work\n');
    write(r.ws, 'config.local', 'KEY=redacted\n');
    const syncedDirty = await applyDirtySnapshot(
      [
        { path: 'src/a.ts', bytes: Buffer.from('parent work\n'), mode: 0o644 },
      ],
      r.ws,
    );
    const syncedIgnored = ['config.local'];

    // a locked worktree is NOT clean by construction, but it is clean by this measurement
    expect(await cleanProbe(r.runGit, r.ws, { syncedDirty, syncedIgnored })).toEqual({ clean: true, dirty: [] });

    write(r.ws, 'src/new.ts', 'the agent wrote this\n');
    const dirty = await cleanProbe(r.runGit, r.ws, { syncedDirty, syncedIgnored });
    expect(dirty).toEqual({ clean: false, dirty: ['src/new.ts'] });

    // a carried path the agent EDITS leaves `carried` and is real dirt (corner row 54)
    rmSync(join(r.ws, 'src/new.ts'));
    write(r.ws, 'src/a.ts', 'parent work\nagent work\n');
    const edited = await cleanProbe(r.runGit, r.ws, { syncedDirty, syncedIgnored });
    expect(edited).toEqual({ clean: false, dirty: ['src/a.ts'] });
  });

  it('a `dir/`-shaped syncedIgnored entry covers everything under it', async () => {
    const r = repo();
    write(r.ws, 'secrets/a.env', 'A=1\n');
    write(r.ws, 'secrets/b.env', 'B=2\n');
    expect(await cleanProbe(r.runGit, r.ws, { syncedDirty: [], syncedIgnored: ['secrets/'] })).toEqual({ clean: true, dirty: [] });
  });

  it('reports NOT clean when git itself refuses to answer', async () => {
    const r = repo();
    const probe = await cleanProbe(r.runGit, join(r.base, 'not-a-repo'), { syncedDirty: [], syncedIgnored: [] });
    expect(probe.clean).toBe(false);
  });
});
