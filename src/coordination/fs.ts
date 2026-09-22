/**
 * The file-system seam of the ledger (§12.0.1 rule 1: the module receives `home`, clocks, `fs.watch` and the identity as
 * arguments and is unit-testable over a temp dir). Every ledger I/O goes through `CoordFs`, so tests inject faults (ENOSPC,
 * ETIMEDOUT, a vanished mirror root) and delays (a lagging shared dir) without touching the real disk. `nodeFs` is the
 * production implementation: atomic writes are `core/atomic.ts` (tmp + optional fsync + rename), reads are bounded
 * (`readBounded` never pulls more than `maxBytes + 1` into memory — §2.1 rule 6, ≤ 64 KiB).
 */
import { mkdirSync, openSync, readSync, closeSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, open, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { writeFileAtomic, writeFileAtomicSync } from '../core/atomic.js';

export interface FsStat {
  mtimeMs: number;
  size: number;
  isDirectory: boolean;
  isFile: boolean;
}

export interface BoundedRead {
  text: string;
  bytes: number;
  /** the file is larger than `maxBytes`: `text` holds the first `maxBytes` bytes and the caller refuses the record */
  overflow: boolean;
}

export interface CoordFs {
  mkdir(path: string, mode: number): Promise<void>;
  /** tmp + (fsync) + rename in `path`'s directory; the parent must exist */
  writeAtomic(path: string, data: string, o: { fsync: boolean; mode: number }): Promise<void>;
  /** O_EXCL create (`flag: 'wx'`); EEXIST when the file is there */
  writeExclusive(path: string, data: string, mode: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readBounded(path: string, maxBytes: number): Promise<BoundedRead>;
  stat(path: string): Promise<FsStat>;
  /** + re-review (6)(ii): symlinks resolved — the mirror root must not resolve INSIDE the coordination root */
  realpath(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
  rmTree(path: string): Promise<void>;
  // the synchronous subset: the `'exit'` handler's ended marker (§3.3 point 6) and the bench lock (§4.7)
  mkdirSync(path: string, mode: number): void;
  writeAtomicSync(path: string, data: string, o: { fsync: boolean; mode: number }): void;
  writeExclusiveSync(path: string, data: string, mode: number): void;
  readFileSync(path: string, maxBytes: number): BoundedRead;
  readdirSync(path: string): string[];
  statSync(path: string): FsStat;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

function toStat(s: { mtimeMs: number; size: number; isDirectory(): boolean; isFile(): boolean }): FsStat {
  return { mtimeMs: s.mtimeMs, size: s.size, isDirectory: s.isDirectory(), isFile: s.isFile() };
}

async function readBoundedAsync(path: string, maxBytes: number): Promise<BoundedRead> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    const overflow = off > maxBytes;
    return { text: buf.subarray(0, Math.min(off, maxBytes)).toString('utf8'), bytes: off, overflow };
  } finally {
    await fh.close();
  }
}

function readBoundedSync(path: string, maxBytes: number): BoundedRead {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    const overflow = off > maxBytes;
    return { text: buf.subarray(0, Math.min(off, maxBytes)).toString('utf8'), bytes: off, overflow };
  } finally {
    closeSync(fd);
  }
}

export const nodeFs: CoordFs = {
  async mkdir(path, mode) {
    await mkdir(path, { recursive: true, mode });
  },
  writeAtomic(path, data, o) {
    return writeFileAtomic(path, data, { fsync: o.fsync, mode: o.mode });
  },
  writeExclusive(path, data, mode) {
    return writeFile(path, data, { flag: 'wx', mode });
  },
  readdir(path) {
    return readdir(path);
  },
  readBounded: readBoundedAsync,
  async stat(path) {
    return toStat(await stat(path));
  },
  realpath(path) {
    return realpath(path);
  },
  unlink(path) {
    return unlink(path);
  },
  rmTree(path) {
    return rm(path, { recursive: true, force: true });
  },
  mkdirSync(path, mode) {
    mkdirSync(path, { recursive: true, mode });
  },
  writeAtomicSync(path, data, o) {
    writeFileAtomicSync(path, data, { fsync: o.fsync, mode: o.mode });
  },
  writeExclusiveSync(path, data, mode) {
    writeFileSync(path, data, { flag: 'wx', mode });
  },
  readFileSync: readBoundedSync,
  readdirSync(path) {
    return readdirSync(path);
  },
  statSync(path) {
    return toStat(statSync(path));
  },
  renameSync(from, to) {
    renameSync(from, to);
  },
  unlinkSync(path) {
    unlinkSync(path);
  },
};

/** The errno string of a thrown value, or null. */
export function errnoCode(e: unknown): string | null {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : null;
}

/** §11 row 13: the disk classes (`store.ts:60`) plus the network-FS classes; a ledger error of this class is bookkeeping, never fatal. */
export const LEDGER_ERROR_CODES = ['ENOSPC', 'EACCES', 'EROFS', 'EDQUOT', 'EIO', 'EMFILE', 'ESTALE', 'ETIMEDOUT', 'ENOTCONN', 'ENOENT', 'EPERM', 'ENOTDIR'] as const;
export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

/** §9.1: the codes that mark the mirror `offline` (retried on the 15 s tick). */
export const OFFLINE_CODES: ReadonlySet<string> = new Set(['ETIMEDOUT', 'ESTALE', 'ENOTCONN', 'EIO', 'ENOSPC', 'ENOENT', 'ENOTDIR']);

/** Read `code` from an error, or `'EUNKNOWN'` for anything else (a thrown non-errno is still one notice, never a crash). */
export function classifyLedgerError(e: unknown): string {
  return errnoCode(e) ?? 'EUNKNOWN';
}

/** `Promise.race` against a timer; the loser rejects with an `ETIMEDOUT` errno (§9.1 per-op timeout). The timer is unref'd. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`${label}: timed out after ${ms} ms`), { code: 'ETIMEDOUT' })), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
