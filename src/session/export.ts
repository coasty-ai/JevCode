/**
 * `/export [file]` (TUI-DESIGN §8.7): concatenate every run's `transcript.log` verbatim (already redacted; renderer-local
 * `[ui]` items are not in it by construction, §15.1) under a `==== run <id> · <t> · <task60> · <stopReason> · $<cost> ====`
 * header, into `<file | ~/.jevcode/exports/<sessionId>.log>`, 64 MiB cap with a trailing `… truncated` line. Streams
 * in 1 MiB chunks so a large transcript never sits in memory whole.
 */
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StopReason } from '../core/types.js';

/** TUI-DESIGN §8.7: the export size cap. */
export const EXPORT_MAX_BYTES = 64 * 1024 * 1024;
export const EXPORT_TRUNCATED_LINE = '… truncated';
const CHUNK = 1024 * 1024;

export interface ExportRun {
  runId: string;
  /** `<runsDir>/<runId>`; its `transcript.log` is copied */
  runDir: string;
  /** ISO start time, shown as `<t>` */
  startedAt: string;
  task60: string;
  stopReason: StopReason | null;
  /** generator + jev; null when the run has no run:end yet */
  costUsd: number | null;
}

/** The output sink: `fs/promises` `FileHandle` in production; tests inject one whose `write` returns short counts. */
export interface ExportSink {
  write(buf: Uint8Array): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
}

export interface ExportOptions {
  /** TUI-DESIGN §8.7: the size cap (default 64 MiB) */
  maxBytes?: number;
  /** opens the output sink (default `open(path, 'w', 0o600)` after creating the parent dir) */
  openSink?: (path: string) => Promise<ExportSink>;
}

export interface ExportResult {
  path: string;
  runs: number;
  bytes: number;
  truncated: boolean;
  /** runs whose transcript.log could not be read (ENOENT / EACCES): header written, body skipped */
  missing: string[];
}

/** TUI-DESIGN §8.1: `~/.jevcode/exports/<sessionId>.log`. */
export function defaultExportPath(home: string, sessionId: string): string {
  return join(home, '.jevcode', 'exports', `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
}

/** TUI-DESIGN §8.7 header: `==== run <id> · <t> · <task60> · <stopReason> · $<cost> ====`. */
export function exportHeader(run: ExportRun): string {
  const cost = run.costUsd === null || !Number.isFinite(run.costUsd) ? '$?' : `$${run.costUsd.toFixed(3)}`;
  const task = run.task60.replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').slice(0, 60);
  return `==== run ${run.runId} · ${run.startedAt} · ${task} · ${run.stopReason ?? 'in progress'} · ${cost} ====`;
}

function errnoCode(e: unknown): string | null {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : null;
}

/**
 * Drain `buf` into the sink, looping on `bytesWritten` (a large buffer or a non-regular target may take several writes);
 * returns the byte count actually written, which is what the 64 MiB accounting adds. A write that makes no progress is an
 * `EIO` error rather than an infinite loop.
 */
export async function writeAll(sink: ExportSink, buf: Uint8Array, path: string): Promise<number> {
  let offset = 0;
  while (offset < buf.length) {
    const { bytesWritten } = await sink.write(buf.subarray(offset));
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) throw Object.assign(new Error(`could not write ${path}: short write (0 bytes)`), { code: 'EIO' });
    offset += bytesWritten;
  }
  return offset;
}

async function openFile(path: string): Promise<ExportSink> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return open(path, 'w', 0o600);
}

/**
 * TUI-DESIGN §8.7 `exportSession`: write the headers and transcripts of `runs` (in the given order) to `out`; stops at
 * `maxBytes` with the `… truncated` line. Missing or unreadable transcripts leave their header and are listed in
 * `missing`. Throws only for the output file itself (EACCES, ENOSPC …), so the caller can render `could not write <file>: <code>`.
 */
export async function exportSession(runs: readonly ExportRun[], out: string, opts: ExportOptions = {}): Promise<ExportResult> {
  const maxBytes = Math.max(0, Math.floor(Number.isFinite(opts.maxBytes ?? EXPORT_MAX_BYTES) ? (opts.maxBytes ?? EXPORT_MAX_BYTES) : EXPORT_MAX_BYTES));
  const fh = await (opts.openSink ?? openFile)(out);
  let bytes = 0;
  let truncated = false;
  const missing: string[] = [];
  const truncMarker = Buffer.from(`${EXPORT_TRUNCATED_LINE}\n`, 'utf8');
  // The marker must always fit: reserve its bytes from the budget.
  const budget = Math.max(0, maxBytes - truncMarker.length);

  async function write(buf: Buffer): Promise<boolean> {
    if (truncated) return false;
    const room = budget - bytes;
    if (buf.length <= room) {
      bytes += await writeAll(fh, buf, out);
      return true;
    }
    if (room > 0) {
      // cut on a UTF-8 boundary so the tail is still valid text
      let end = room;
      while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
      bytes += await writeAll(fh, buf.subarray(0, end), out);
    }
    truncated = true;
    bytes += await writeAll(fh, truncMarker, out);
    return false;
  }

  try {
    let lastEndedWithNewline = true;
    for (const run of runs) {
      if (truncated) break;
      const header = Buffer.from(`${lastEndedWithNewline ? '' : '\n'}${exportHeader(run)}\n`, 'utf8');
      if (!(await write(header))) break;
      lastEndedWithNewline = true;
      let src: Awaited<ReturnType<typeof open>> | null = null;
      try {
        src = await open(join(run.runDir, 'transcript.log'), 'r');
      } catch (e) {
        missing.push(`${run.runId}: ${errnoCode(e) ?? 'unreadable'}`);
        continue;
      }
      try {
        const chunk = Buffer.allocUnsafe(CHUNK);
        for (;;) {
          const { bytesRead } = await src.read(chunk, 0, CHUNK, null);
          if (bytesRead === 0) break;
          const part = chunk.subarray(0, bytesRead);
          lastEndedWithNewline = part[bytesRead - 1] === 0x0a;
          if (!(await write(Buffer.from(part)))) break;
        }
      } finally {
        await src.close();
      }
    }
    if (!truncated && !lastEndedWithNewline) bytes += await writeAll(fh, Buffer.from('\n', 'utf8'), out);
  } finally {
    await fh.close();
  }
  return { path: out, runs: runs.length, bytes, truncated, missing };
}
