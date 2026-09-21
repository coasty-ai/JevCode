/**
 * TUI-DESIGN §12.3 / §19.0: pre/post layout; streamed hashing with the 16 MiB cap and `sha256: null`;
 * `imagesMs`; `dirs.json`; escapes, links, the default copy caps, same-step re-runs, EACCES, backslash names.
 */
import { chmod, link, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  POST_IMAGE_CHUNK_BYTES,
  POST_IMAGE_HASH_CAP_BYTES,
  PRE_DIRS_FILE,
  PRE_IMAGE_MAX_FILES,
  PRE_IMAGE_MAX_FILE_BYTES,
  PRE_IMAGE_MAX_TOTAL_BYTES,
  PRE_INDEX_FILE,
  hashFileStreaming,
  isPostImage,
  listPostImages,
  markPostImageUndone,
  normaliseRelPath,
  postImagePath,
  preImageDir,
  preImagePath,
  readPostImages,
  readPreDirs,
  readPreImage,
  readPreIndex,
  writePostImages,
  writePreImages,
} from '../../../src/checkpoint/images.js';
import { CHECKPOINT_FILES } from '../../../src/checkpoint/store.js';
import { sha256Hex } from '../../../src/core/hash.js';
import { CheckpointError } from '../../../src/errors.js';
import { planUndo } from '../../../src/undo/plan.js';
import { withTempDir } from '../../fixtures/checkpoint/make.js';

async function setup(dir: string): Promise<{ root: string; runDir: string }> {
  const root = join(dir, 'ws');
  const runDir = join(dir, 'run');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'build'), { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(join(root, 'src/a.py'), 'x = 1\n');
  await writeFile(join(root, 'build/out.txt'), 'old output\n');
  await writeFile(join(root, 'old.txt'), 'to be deleted\n');
  return { root, runDir };
}

const noYield = (): Promise<void> => Promise.resolve();
const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('layout (§12.3)', () => {
  it('pre/<step>/<sha256(relpath)>, dirs.json and post/<step>.json carry the documented fields', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      const targets = ['src/a.py', 'old.txt', 'src/new/deep/x.py'];
      const pre = await writePreImages(runDir, 7, targets, { root, source: 'edit' });
      // copies exist for the two existing targets only, under the hashed name
      const aCopy = await readFile(preImagePath(runDir, 7, 'src/a.py'), 'utf8');
      expect(aCopy).toBe('x = 1\n');
      expect(preImagePath(runDir, 7, 'src/a.py')).toBe(join(runDir, CHECKPOINT_FILES.pre, '7', sha256Hex('src/a.py')));
      await expect(stat(preImagePath(runDir, 7, 'src/new/deep/x.py'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(pre.entries.map((e) => [e.path, e.existed, e.copied])).toEqual([
        ['src/a.py', true, true],
        ['old.txt', true, true],
        ['src/new/deep/x.py', false, false],
      ]);
      // directories the step will create, deepest first, trailing slash
      expect(pre.dirs).toEqual(['src/new/deep/', 'src/new/']);
      expect(JSON.parse(await readFile(join(preImageDir(runDir, 7), PRE_DIRS_FILE), 'utf8'))).toEqual(['src/new/deep/', 'src/new/']);
      expect(await readPreDirs(runDir, 7)).toEqual(['src/new/deep/', 'src/new/']);
      const index = await readPreIndex(runDir, 7);
      expect(index?.source).toBe('edit');
      expect(index?.entries[0]?.mode).toBe((await stat(join(root, 'src/a.py'))).mode & 0o7777);

      // the step runs: edit a.py, delete old.txt, create x.py, a command rewrites build/out.txt
      await writeFile(join(root, 'src/a.py'), 'x = 2\n');
      await mkdir(join(root, 'src/new/deep'), { recursive: true });
      await writeFile(join(root, 'src/new/deep/x.py'), 'new\n');
      await writeFile(join(root, 'build/out.txt'), 'fresh output\n');
      const { unlink } = await import('node:fs/promises');
      await unlink(join(root, 'old.txt'));

      const post = await writePostImages(runDir, 7, ['src/a.py', 'old.txt', 'src/new/deep/x.py', 'build/out.txt'], {
        root,
        source: 'edit',
        headOid: '7d731c0e',
        cleanAtStart: (p) => p === 'src/a.py',
        pre,
        at: '2026-09-20T12:00:00.000Z',
        yieldBetweenChunks: noYield,
      });
      const img = post.image;
      expect(img.v).toBe(1);
      expect(img.step).toBe(7);
      expect(img.at).toBe('2026-09-20T12:00:00.000Z');
      expect(img.headOid).toBe('7d731c0e');
      expect(img.hashSkipped).toBe(false);
      expect(img.files['src/a.py']).toEqual({ sha256: sha256Hex('x = 2\n'), bytes: 6, mode: expect.any(Number), source: 'edit', preImage: true, cleanAtStart: true });
      // a deleted entry keeps `cleanAtStart` so /undo can bring a clean tracked file a command deleted back from HEAD (§12.4)
      expect(img.files['old.txt']).toEqual({ deleted: true, preImage: true, source: 'edit', cleanAtStart: false });
      expect(img.files['src/new/deep/x.py']).toEqual({ sha256: sha256Hex('new\n'), bytes: 4, mode: expect.any(Number), source: 'edit', created: true });
      expect(img.files['build/out.txt']).toEqual({ sha256: sha256Hex('fresh output\n'), bytes: 13, mode: expect.any(Number), source: 'edit', preImage: false, cleanAtStart: false });
      expect(img.skipped).toEqual([]);
      // on disk, readable back, shape-checked
      const onDisk = JSON.parse(await readFile(postImagePath(runDir, 7), 'utf8')) as unknown;
      expect(isPostImage(onDisk)).toBe(true);
      const read = await readPostImages(runDir, 7);
      expect(read).toEqual({ ok: true, image: img, undone: false });
    }));

  it('reads the pre index from disk when the result is not handed over, and readPreImage returns bytes + mode', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      await writePreImages(runDir, 3, ['src/a.py', 'ghost.py'], { root, source: 'write' });
      await writeFile(join(root, 'ghost.py'), 'g\n');
      await writeFile(join(root, 'src/a.py'), 'changed\n');
      const { image } = await writePostImages(runDir, 3, ['src/a.py', 'ghost.py'], { root, source: 'write', headOid: null, cleanAtStart: () => false, yieldBetweenChunks: noYield });
      expect(image.files['ghost.py']?.created).toBe(true);
      expect(image.files['src/a.py']?.preImage).toBe(true);
      const pre = await readPreImage(runDir, 3, 'src/a.py');
      expect(pre?.bytes.toString('utf8')).toBe('x = 1\n');
      expect(pre?.mode).toBe((await stat(join(root, 'src/a.py'))).mode & 0o7777);
      expect(await readPreImage(runDir, 3, 'ghost.py')).toBeNull();
      expect(await readPreImage(runDir, 3, '../escape')).toBeNull();
    }));

  it('unicode and emoji paths round-trip through the hashed copy name', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      const rel = 'src/日本語/émoji😀 file.py';
      await mkdir(join(root, 'src/日本語'), { recursive: true });
      await writeFile(join(root, rel), 'before\n');
      const pre = await writePreImages(runDir, 1, [rel], { root, source: 'patch' });
      expect(pre.entries[0]?.copied).toBe(true);
      await writeFile(join(root, rel), 'after\n');
      const { image } = await writePostImages(runDir, 1, [rel], { root, source: 'patch', headOid: null, cleanAtStart: () => false, pre, yieldBetweenChunks: noYield });
      expect(image.files[rel]?.sha256).toBe(sha256Hex('after\n'));
      expect((await readPreImage(runDir, 1, rel))?.bytes.toString()).toBe('before\n');
    }));

  it('empty targets still write an empty index and dirs.json; a step must be a positive integer', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      const pre = await writePreImages(runDir, 2, [], { root, source: 'run' });
      expect(pre.entries).toEqual([]);
      expect(await readPreDirs(runDir, 2)).toEqual([]);
      expect(JSON.parse(await readFile(join(preImageDir(runDir, 2), PRE_INDEX_FILE), 'utf8'))).toEqual({ v: 1, step: 2, source: 'run', entries: [] });
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => preImageDir(runDir, bad)).toThrow(RangeError);
        expect(() => postImagePath(runDir, bad)).toThrow(RangeError);
        await expect(writePreImages(runDir, bad, [], { root, source: 'run' })).rejects.toThrow(RangeError);
      }
    }));
});

describe('skips: size, cap, link, escape (§12.3, §12.4)', () => {
  it('files > 1 MiB are recorded as skipped `size` with their bytes and never copied; the post image still hashes them', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      const big = Buffer.alloc(PRE_IMAGE_MAX_FILE_BYTES + 1, 0x61);
      await writeFile(join(root, 'big.bin'), big);
      const pre = await writePreImages(runDir, 4, ['big.bin', 'src/a.py'], { root, source: 'run' });
      expect(pre.skipped).toEqual([{ path: 'big.bin', reason: 'size', bytes: PRE_IMAGE_MAX_FILE_BYTES + 1 }]);
      expect(pre.entries[0]).toMatchObject({ path: 'big.bin', existed: true, copied: false, skipped: 'size' });
      await expect(stat(preImagePath(runDir, 4, 'big.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
      const { image } = await writePostImages(runDir, 4, ['big.bin'], { root, source: 'run', headOid: 'h', cleanAtStart: () => false, pre, yieldBetweenChunks: noYield });
      expect(image.files['big.bin']).toMatchObject({ sha256: sha256Hex(big), preImage: false, cleanAtStart: false, source: 'run' });
      expect(image.skipped).toEqual([{ path: 'big.bin', reason: 'size', bytes: PRE_IMAGE_MAX_FILE_BYTES + 1 }]);
    }));

  it('the dirty-set copy cap (files and bytes) records overflow as `cap`', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      for (let i = 0; i < 5; i++) await writeFile(join(root, `f${i}.txt`), `file ${i}\n`);
      const byFiles = await writePreImages(runDir, 5, ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt'], { root, source: 'run', maxFiles: 2 });
      expect(byFiles.entries.filter((e) => e.copied).map((e) => e.path)).toEqual(['f0.txt', 'f1.txt']);
      expect(byFiles.skipped.map((s) => s.reason)).toEqual(['cap', 'cap', 'cap']);
      const byBytes = await writePreImages(runDir, 6, ['f0.txt', 'f1.txt', 'f2.txt'], { root, source: 'run', maxTotalBytes: 15 });
      expect(byBytes.copiedBytes).toBe(14);
      expect(byBytes.skipped).toEqual([{ path: 'f2.txt', reason: 'cap', bytes: 7 }]);
    }));

  it('symlinks, hard links and non-regular files are `link`; absolute, `..` and .git paths are `escape`', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      await symlink(join(root, 'src/a.py'), join(root, 'alias.py'));
      await link(join(root, 'src/a.py'), join(root, 'hard.py'));
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, '.git/config'), '[core]\n');
      const pre = await writePreImages(runDir, 8, ['alias.py', 'hard.py', 'src', '../outside.txt', '/etc/passwd', '.git/config', 'src/../.git/x', ''], { root, source: 'run' });
      const reasons = Object.fromEntries(pre.skipped.map((s) => [s.path, s.reason]));
      expect(reasons).toEqual({
        'alias.py': 'link',
        'hard.py': 'link',
        src: 'link',
        '../outside.txt': 'escape',
        '/etc/passwd': 'escape',
        '.git/config': 'escape',
        'src/../.git/x': 'escape',
        '': 'escape',
      });
      // the same paths are dropped from the post image with the same reasons (nothing is hashed through a link)
      const { image } = await writePostImages(runDir, 8, ['alias.py', 'hard.py', '../outside.txt'], { root, source: 'run', headOid: 'h', cleanAtStart: () => false, pre, yieldBetweenChunks: noYield });
      expect(Object.keys(image.files)).toEqual([]);
      expect(image.skipped.map((s) => s.reason).sort()).toEqual(['escape', 'link', 'link']);
    }));

  it('a symlinked parent directory that leaves the root is an escape', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      const outside = join(dir, 'outside');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'secret.txt'), 'nope\n');
      await symlink(outside, join(root, 'linkdir'));
      const pre = await writePreImages(runDir, 9, ['linkdir/secret.txt'], { root, source: 'edit' });
      expect(pre.skipped).toEqual([{ path: 'linkdir/secret.txt', reason: 'escape' }]);
    }));

  it('normaliseRelPath: `./` and `.` segments dropped, duplicates deduped, NUL and traversal rejected', () => {
    expect(normaliseRelPath('./src/./a.py')).toBe('src/a.py');
    expect(normaliseRelPath('src//a.py')).toBe('src/a.py');
    expect(normaliseRelPath('a/../b')).toBeNull();
    expect(normaliseRelPath('a\0b')).toBeNull();
    expect(normaliseRelPath('.')).toBeNull();
    expect(normaliseRelPath('.gitignore')).toBe('.gitignore');
    expect(normaliseRelPath('.git')).toBeNull();
  });
});

describe('streamed hashing and the per-step cap (§12.3)', () => {
  it('hashes in chunks with a yield between chunks and matches sha256 of the bytes', () =>
    withTempDir(async (dir) => {
      const content = Buffer.from('0123456789abcdef', 'utf8');
      await writeFile(join(dir, 'f'), content);
      let yields = 0;
      const sha = await hashFileStreaming(join(dir, 'f'), 4, () => {
        yields += 1;
        return Promise.resolve();
      });
      expect(sha).toBe(sha256Hex(content));
      expect(yields).toBe(3); // 4 chunks → 3 yields between them
      expect(POST_IMAGE_CHUNK_BYTES).toBe(4 * 1024 * 1024);
      expect(POST_IMAGE_HASH_CAP_BYTES).toBe(16 * 1024 * 1024);
    }));

  it('past the budget the first file that does not fit and each remaining file get sha256: null and hashSkipped: true (§12.3)', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      await writeFile(join(root, 'p.txt'), 'a'.repeat(10));
      await writeFile(join(root, 'q.txt'), 'b'.repeat(10));
      await writeFile(join(root, 'r.txt'), 'ccc');
      const { image } = await writePostImages(runDir, 2, ['p.txt', 'q.txt', 'r.txt'], { root, source: 'run', headOid: 'h', cleanAtStart: () => false, pre: null, hashCapBytes: 15, yieldBetweenChunks: noYield });
      expect(image.files['p.txt']?.sha256).toBe(sha256Hex('a'.repeat(10)));
      expect(image.files['q.txt']?.sha256).toBeNull();
      // r.txt would still fit the byte budget, but §12.3 records every remaining file unhashed once the cap fired
      expect(image.files['r.txt']?.sha256).toBeNull();
      expect(image.hashSkipped).toBe(true);
      expect(image.files['q.txt']?.bytes).toBe(10);
      expect(image.files['r.txt']?.bytes).toBe(3);
      // exactly at the budget everything is hashed
      const exact = await writePostImages(runDir, 3, ['p.txt', 'q.txt'], { root, source: 'run', headOid: 'h', cleanAtStart: () => false, pre: null, hashCapBytes: 20, yieldBetweenChunks: noYield });
      expect(exact.image.hashSkipped).toBe(false);
      expect(exact.image.files['q.txt']?.sha256).toBe(sha256Hex('b'.repeat(10)));
    }));

  it('a zero hashing budget records every file unhashed and a NaN cap falls back to the default', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      const zero = await writePostImages(runDir, 2, ['src/a.py'], { root, source: 'run', headOid: null, cleanAtStart: () => true, pre: null, hashCapBytes: 0, yieldBetweenChunks: noYield });
      expect(zero.image.files['src/a.py']?.sha256).toBeNull();
      expect(zero.image.hashSkipped).toBe(true);
      const nan = await writePostImages(runDir, 3, ['src/a.py'], { root, source: 'run', headOid: null, cleanAtStart: () => true, pre: null, hashCapBytes: Number.NaN, yieldBetweenChunks: noYield });
      // NaN comparisons are false: nothing fits, which is the conservative reading (recorded, unhashed, /undo asks)
      expect(nan.image.files['src/a.py']?.sha256).toBeNull();
    }));

  it('imagesMs: both calls report wall time from the injected clock', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      let t = 1000;
      const now = (): number => {
        t += 2.5;
        return t;
      };
      const pre = await writePreImages(runDir, 1, ['src/a.py'], { root, source: 'edit', now });
      expect(pre.ms).toBe(2.5);
      const post = await writePostImages(runDir, 1, ['src/a.py'], { root, source: 'edit', headOid: null, cleanAtStart: () => true, pre, now, yieldBetweenChunks: noYield });
      expect(post.ms).toBe(2.5);
    }));

  it('a 4 MiB file is hashed with three yields at the default chunk size and stays under a loaded-machine bound', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      const four = Buffer.alloc(4 * 1024 * 1024 + 1, 0x7a);
      await writeFile(join(root, 'four.bin'), four);
      let yields = 0;
      const t0 = performance.now();
      const { image } = await writePostImages(runDir, 1, ['four.bin'], {
        root,
        source: 'run',
        headOid: null,
        cleanAtStart: () => false,
        pre: null,
        yieldBetweenChunks: () => {
          yields += 1;
          return Promise.resolve();
        },
      });
      const ms = performance.now() - t0;
      expect(image.files['four.bin']?.sha256).toBe(sha256Hex(four));
      expect(yields).toBe(1); // two chunks (4 MiB + 1 byte) → one yield
      // §12.3: ≈ 0.6 ms/MiB of hashing; 3× headroom over a generous 60 ms for read + hash of 4 MiB
      expect(ms).toBeLessThan(180);
    }));

  it('the full 16 MiB hashing budget (four 4 MiB files) is hashed with one yield each and inside a loaded-machine bound', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      const four = Buffer.alloc(4 * 1024 * 1024, 0x51);
      const names = ['h0.bin', 'h1.bin', 'h2.bin', 'h3.bin'];
      for (const n of names) await writeFile(join(root, n), four);
      let yields = 0;
      const t0 = performance.now();
      const { image } = await writePostImages(runDir, 1, names, {
        root,
        source: 'run',
        headOid: null,
        cleanAtStart: () => false,
        pre: null,
        yieldBetweenChunks: () => {
          yields += 1;
          return Promise.resolve();
        },
      });
      const ms = performance.now() - t0;
      for (const n of names) expect(image.files[n]?.sha256).toBe(sha256Hex(four));
      expect(image.hashSkipped).toBe(false);
      // a 4 MiB file read with a 4 MiB highWaterMark arrives in one or two chunks (fs may split the read): at most one yield each
      expect(yields).toBeLessThanOrEqual(names.length);
      // §12.3: ≈ 10 ms of sha256 for 16 MiB; 3× headroom over a generous 150 ms for read + hash + write on a loaded machine
      expect(ms).toBeLessThan(450);
      // one more byte does not fit: recorded unhashed, hashSkipped
      await writeFile(join(root, 'h4.bin'), Buffer.alloc(1, 0x52));
      const over = await writePostImages(runDir, 2, [...names, 'h4.bin'], { root, source: 'run', headOid: null, cleanAtStart: () => false, pre: null, yieldBetweenChunks: noYield });
      expect(over.image.files['h4.bin']?.sha256).toBeNull();
      expect(over.image.hashSkipped).toBe(true);
    }));
});

describe('re-runs, caps by default, permissions, odd names (§12.3, DESIGN §9.1)', () => {
  it('a same-step re-run replaces the previous attempt: no stale copies, readPreImage is null for a path the new index did not copy', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      await writeFile(join(root, 'src/locked.py'), 'L\n');
      await writePreImages(runDir, 4, ['src/a.py'], { root, source: 'edit' });
      expect((await readPreImage(runDir, 4, 'src/a.py'))?.bytes.toString()).toBe('x = 1\n');
      await writePreImages(runDir, 4, ['src/locked.py'], { root, source: 'edit' });
      expect((await readPreIndex(runDir, 4))?.entries.map((e) => e.path)).toEqual(['src/locked.py']);
      expect(await readPreImage(runDir, 4, 'src/a.py')).toBeNull();
      expect((await readPreImage(runDir, 4, 'src/locked.py'))?.bytes.toString()).toBe('L\n');
      // the directory holds exactly the index, dirs.json and the one copy
      expect((await readdir(preImageDir(runDir, 4))).sort()).toEqual([PRE_DIRS_FILE, PRE_INDEX_FILE, sha256Hex('src/locked.py')].sort());
      // a stray copy without an index entry is never a restore source either
      await writeFile(preImagePath(runDir, 4, 'ghost.py'), 'stale');
      expect(await readPreImage(runDir, 4, 'ghost.py')).toBeNull();
      // an index entry that was not copied (size skip) reads as null too
      await writeFile(join(root, 'big.bin'), Buffer.alloc(PRE_IMAGE_MAX_FILE_BYTES + 1));
      await writePreImages(runDir, 5, ['big.bin'], { root, source: 'edit' });
      expect(await readPreImage(runDir, 5, 'big.bin')).toBeNull();
    }));

  it('the default caps apply to the `run` dirty set only: 200 files / 16 MiB, overflow `cap`; edit targets are uncapped', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      expect(PRE_IMAGE_MAX_FILES).toBe(200);
      expect(PRE_IMAGE_MAX_TOTAL_BYTES).toBe(16 * 1024 * 1024);
      await mkdir(join(root, 'many'), { recursive: true });
      const names: string[] = [];
      for (let i = 0; i < PRE_IMAGE_MAX_FILES + 1; i++) {
        names.push(`many/f${i}.txt`);
        await writeFile(join(root, names[i]!), `${i}\n`);
      }
      const run = await writePreImages(runDir, 1, names, { root, source: 'run' });
      expect(run.entries.filter((e) => e.copied)).toHaveLength(PRE_IMAGE_MAX_FILES);
      expect(run.skipped).toEqual([{ path: `many/f${PRE_IMAGE_MAX_FILES}.txt`, reason: 'cap', bytes: 4 }]);
      const edit = await writePreImages(runDir, 2, names, { root, source: 'edit' });
      expect(edit.entries.filter((e) => e.copied)).toHaveLength(PRE_IMAGE_MAX_FILES + 1);
      expect(edit.skipped).toEqual([]);
      // 17 × 1 MiB (each exactly at the per-file limit): 16 copied, the 17th is `cap` by bytes
      const mib = Buffer.alloc(PRE_IMAGE_MAX_FILE_BYTES, 0x4d);
      const big: string[] = [];
      for (let i = 0; i < 17; i++) {
        big.push(`many/m${i}.bin`);
        await writeFile(join(root, big[i]!), mib);
      }
      const bytes = await writePreImages(runDir, 3, big, { root, source: 'run' });
      expect(bytes.copiedBytes).toBe(PRE_IMAGE_MAX_TOTAL_BYTES);
      expect(bytes.entries.filter((e) => e.copied)).toHaveLength(16);
      expect(bytes.skipped).toEqual([{ path: 'many/m16.bin', reason: 'cap', bytes: PRE_IMAGE_MAX_FILE_BYTES }]);
      // an explicit cap still applies to an edit
      const capped = await writePreImages(runDir, 4, names.slice(0, 3), { root, source: 'patch', maxFiles: 1 });
      expect(capped.skipped.map((s) => s.reason)).toEqual(['cap', 'cap']);
    }));

  it.skipIf(isWin)('a POSIX file whose name contains a backslash round-trips (backslash is not a separator here)', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      const name = 'weird\\name.txt';
      await writeFile(join(root, name), 'before\n');
      expect(normaliseRelPath(name)).toBe(name);
      expect(normaliseRelPath('\\leading')).toBe('\\leading');
      const pre = await writePreImages(runDir, 2, [name], { root, source: 'edit' });
      expect(pre.entries).toEqual([{ path: name, existed: true, bytes: 7, mode: expect.any(Number), copied: true, skipped: null }]);
      await writeFile(join(root, name), 'after\n');
      const { image } = await writePostImages(runDir, 2, [name], { root, source: 'edit', headOid: null, cleanAtStart: () => false, pre, yieldBetweenChunks: noYield });
      expect(image.files[name]).toMatchObject({ sha256: sha256Hex('after\n'), preImage: true });
      expect(image.files['weird/name.txt']).toBeUndefined();
      expect((await readPreImage(runDir, 2, name))?.bytes.toString()).toBe('before\n');
      // a real `weird/name.txt` is a different file and is never aliased
      await mkdir(join(root, 'weird'), { recursive: true });
      await writeFile(join(root, 'weird/name.txt'), 'other\n');
      const both = await writePreImages(runDir, 3, [name, 'weird/name.txt'], { root, source: 'edit' });
      expect(both.entries.map((e) => e.path)).toEqual([name, 'weird/name.txt']);
      expect((await readPreImage(runDir, 3, 'weird/name.txt'))?.bytes.toString()).toBe('other\n');
      expect((await readPreImage(runDir, 3, name))?.bytes.toString()).toBe('after\n');
    }));

  it.skipIf(isWin || isRoot)('EACCES on the run directory surfaces as CheckpointError; an unreadable workspace file is `not-recoverable`', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      await writeFile(join(root, 'secret.txt'), 'shh\n');
      await chmod(join(root, 'secret.txt'), 0o000);
      try {
        const pre = await writePreImages(runDir, 1, ['secret.txt', 'src/a.py'], { root, source: 'edit' });
        expect(pre.entries[0]).toMatchObject({ path: 'secret.txt', existed: true, copied: false, skipped: 'not-recoverable' });
        expect(pre.skipped).toEqual([{ path: 'secret.txt', reason: 'not-recoverable' }]);
        expect(pre.entries[1]?.copied).toBe(true);
        const { image } = await writePostImages(runDir, 1, ['secret.txt', 'src/a.py'], { root, source: 'edit', headOid: null, cleanAtStart: () => false, pre, yieldBetweenChunks: noYield });
        expect(image.files['secret.txt']).toBeUndefined();
        expect(image.skipped).toEqual([{ path: 'secret.txt', reason: 'not-recoverable' }]);
      } finally {
        await chmod(join(root, 'secret.txt'), 0o644);
      }
      // a read-only run directory (no pre/ or post/ yet): creating them fails with EACCES → CheckpointError, exit 3
      const readOnly = join(dir, 'run-ro');
      await mkdir(readOnly, { recursive: true });
      await chmod(readOnly, 0o500);
      try {
        const err = await writePreImages(readOnly, 2, ['src/a.py'], { root, source: 'edit' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CheckpointError);
        expect((err as CheckpointError).exitCode).toBe(3);
        expect((err as { cause?: { code?: string } }).cause?.code).toBe('EACCES');
        const err2 = await writePostImages(readOnly, 2, ['src/a.py'], { root, source: 'edit', headOid: null, cleanAtStart: () => true, pre: null, yieldBetweenChunks: noYield }).catch((e: unknown) => e);
        expect(err2).toBeInstanceOf(CheckpointError);
        expect((err2 as { cause?: { code?: string } }).cause?.code).toBe('EACCES');
        expect(await markPostImageUndone(readOnly, 2)).toBe(false);
        // an existing pre/ that is itself read-only fails the same way on the step directory
        await chmod(join(runDir, CHECKPOINT_FILES.pre), 0o500);
        try {
          const err3 = await writePreImages(runDir, 9, ['src/a.py'], { root, source: 'edit' }).catch((e: unknown) => e);
          expect(err3).toBeInstanceOf(CheckpointError);
        } finally {
          await chmod(join(runDir, CHECKPOINT_FILES.pre), 0o755);
        }
      } finally {
        await chmod(readOnly, 0o755);
      }
    }));
});

describe('a `run` step deleting a clean tracked file (§12.3 deleted entries, §12.4 restore source 3)', () => {
  it('records `{ deleted: true, cleanAtStart: true, source: run }` and planUndo yields the git-restore row while HEAD is unchanged', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      // clean tracked files need no dirty-set copy (§12.3): the pre-image call carries no targets
      const pre = await writePreImages(runDir, 3, [], { root, source: 'run' });
      const { unlink } = await import('node:fs/promises');
      await unlink(join(root, 'src/a.py'));
      const post = await writePostImages(runDir, 3, ['src/a.py'], { root, source: 'run', headOid: 'h3', cleanAtStart: () => true, pre, at: '2026-09-20T12:00:00.000Z', yieldBetweenChunks: noYield });
      expect(post.image.files['src/a.py']).toEqual({ deleted: true, preImage: false, source: 'run', cleanAtStart: true });
      const same = planUndo({ step: 3, post: post.image, current: {}, later: [], headOid: 'h3', git: true });
      expect(same.decisions).toEqual([{ kind: 'restore', path: 'src/a.py', via: 'git-restore', expected: { exists: false, sha256: null } }]);
      // HEAD moved since: the E10 rule, not a restore
      const moved = planUndo({ step: 3, post: post.image, current: {}, later: [], headOid: 'h4', git: true });
      expect(moved.decisions).toEqual([{ kind: 'skip', path: 'src/a.py', reason: 'head-moved', message: 'not recoverable — HEAD moved since step 3' }]);
      // the same deletion of a file that was dirty (copied) restores from the pre-image whatever HEAD did
      await writeFile(join(root, 'src/a.py'), 'x = 1\n');
      const preDirty = await writePreImages(runDir, 4, ['src/a.py'], { root, source: 'run' });
      await unlink(join(root, 'src/a.py'));
      const postDirty = await writePostImages(runDir, 4, ['src/a.py'], { root, source: 'run', headOid: 'h3', cleanAtStart: () => false, pre: preDirty, yieldBetweenChunks: noYield });
      expect(postDirty.image.files['src/a.py']).toEqual({ deleted: true, preImage: true, source: 'run', cleanAtStart: false });
      expect(planUndo({ step: 4, post: postDirty.image, current: {}, later: [], headOid: 'other', git: true }).decisions[0]).toMatchObject({ kind: 'restore', via: 'pre-image' });
    }));
});

describe('readers and the undone rename (§12.4, §12.5)', () => {
  it('readPostImages: missing, corrupt, undone; listPostImages sorted with flags', () =>
    withTempDir(async (dir) => {
      const { root, runDir } = await setup(dir);
      expect(await readPostImages(runDir, 1)).toEqual({ ok: false, reason: 'missing', detail: 'missing' });
      expect(await listPostImages(runDir)).toEqual([]);
      await writePostImages(runDir, 2, ['src/a.py'], { root, source: 'edit', headOid: null, cleanAtStart: () => true, pre: null, yieldBetweenChunks: noYield });
      await writePostImages(runDir, 10, ['src/a.py'], { root, source: 'edit', headOid: null, cleanAtStart: () => true, pre: null, yieldBetweenChunks: noYield });
      await writePostImages(runDir, 3, ['src/a.py'], { root, source: 'edit', headOid: null, cleanAtStart: () => true, pre: null, yieldBetweenChunks: noYield });
      expect(await markPostImageUndone(runDir, 3)).toBe(true);
      expect(await markPostImageUndone(runDir, 3)).toBe(false);
      expect(await listPostImages(runDir)).toEqual([
        { step: 2, undone: false },
        { step: 3, undone: true },
        { step: 10, undone: false },
      ]);
      const undone = await readPostImages(runDir, 3);
      expect(undone.ok && undone.undone).toBe(true);
      await writeFile(postImagePath(runDir, 2), '{ not json');
      expect(await readPostImages(runDir, 2)).toMatchObject({ ok: false, reason: 'corrupt' });
      await writeFile(postImagePath(runDir, 2), JSON.stringify({ v: 1, step: 5, at: 'x', headOid: null, files: {}, skipped: [], hashSkipped: false }));
      expect(await readPostImages(runDir, 2)).toMatchObject({ ok: false, reason: 'corrupt', detail: 'step 5 does not match file 2' });
      await writeFile(join(runDir, CHECKPOINT_FILES.post, 'notes.txt'), 'ignored');
      expect((await listPostImages(runDir)).map((p) => p.step)).toEqual([2, 3, 10]);
    }));

  it('isPostImage rejects foreign shapes', () => {
    expect(isPostImage(null)).toBe(false);
    expect(isPostImage({ v: 2, step: 1, at: 'x', headOid: null, files: {}, skipped: [], hashSkipped: false })).toBe(false);
    expect(isPostImage({ v: 1, step: 1, at: 'x', headOid: null, files: { a: { source: 'zip' } }, skipped: [], hashSkipped: false })).toBe(false);
    expect(isPostImage({ v: 1, step: 1, at: 'x', headOid: null, files: { a: { source: 'run', sha256: null } }, skipped: [{ path: 'b', reason: 'size', bytes: 3 }], hashSkipped: true })).toBe(true);
  });

  it('an unwritable run directory surfaces as CheckpointError (exit 3), never a raw errno', () =>
    withTempDir(async (dir) => {
      const { root } = await setup(dir);
      const runDir = join(dir, 'not-a-dir');
      await writeFile(runDir, 'file');
      const err = await writePreImages(runDir, 1, ['src/a.py'], { root, source: 'edit' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CheckpointError);
      expect((err as CheckpointError).exitCode).toBe(3);
      const err2 = await writePostImages(runDir, 1, ['src/a.py'], { root, source: 'edit', headOid: null, cleanAtStart: () => true, pre: null, yieldBetweenChunks: noYield }).catch((e: unknown) => e);
      expect(err2).toBeInstanceOf(CheckpointError);
    }));
});
