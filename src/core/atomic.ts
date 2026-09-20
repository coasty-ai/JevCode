import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync, mkdirSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AtomicWriteOptions {
  /** fsync the temp file before rename (only the checkpoint store passes true) */
  fsync?: boolean;
  mode?: number;
  /** create parent directories */
  mkdir?: boolean;
}

function tmpName(path: string): string {
  return `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
}

/** Write `data` to `path` atomically: temp file in the same directory, then rename(2). */
export async function writeFileAtomic(path: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): Promise<void> {
  if (opts.mkdir) await mkdir(dirname(path), { recursive: true });
  const tmp = tmpName(path);
  const fh = await open(tmp, 'w', opts.mode ?? 0o644);
  try {
    await fh.writeFile(data);
    if (opts.fsync) await fh.sync();
  } catch (e) {
    await fh.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  await fh.close();
  try {
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** Synchronous variant for the shutdown last-resort path (§11). */
export function writeFileAtomicSync(path: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): void {
  if (opts.mkdir) mkdirSync(dirname(path), { recursive: true });
  const tmp = tmpName(path);
  const fd = openSync(tmp, 'w', opts.mode ?? 0o644);
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    if (opts.fsync) fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}
