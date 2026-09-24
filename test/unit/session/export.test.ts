import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPORT_MAX_BYTES, EXPORT_TRUNCATED_LINE, defaultExportPath, exportHeader, exportSession, writeAll, type ExportRun, type ExportSink } from '../../../src/session/export.js';
import { runId } from './helpers.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevcode-export-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(n: number, transcript: string | null, patch: Partial<ExportRun> = {}): Promise<ExportRun> {
  const id = runId(n);
  const runDir = join(dir, 'runs', id);
  await mkdir(runDir, { recursive: true });
  if (transcript !== null) await writeFile(join(runDir, 'transcript.log'), transcript);
  return { runId: id, runDir, startedAt: `2026-09-20T14:0${n}:00.000Z`, task60: `task ${n}`, stopReason: 'complete', costUsd: 0.115, ...patch };
}

describe('exportSession (TUI-DESIGN §8.7)', () => {
  it('writes one header per run followed by that run\'s transcript.log verbatim', async () => {
    const a = await run(1, '[run] start\n[step 1] intent=edit\n');
    const b = await run(2, '[run] start\n[run] end complete\n', { stopReason: 'human_pause', costUsd: 0.02 });
    const out = join(dir, 'exports', 'session.log');
    const res = await exportSession([a, b], out);
    expect(res).toEqual({ path: out, runs: 2, bytes: expect.any(Number), truncated: false, missing: [] });
    const text = await readFile(out, 'utf8');
    expect(text).toBe(
      `==== run ${a.runId} · 2026-09-20T14:01:00.000Z · task 1 · complete · $0.115 ====\n[run] start\n[step 1] intent=edit\n` +
        `==== run ${b.runId} · 2026-09-20T14:02:00.000Z · task 2 · human_pause · $0.020 ====\n[run] start\n[run] end complete\n`,
    );
    expect(res.bytes).toBe(Buffer.byteLength(text));
    expect((await stat(out)).mode & 0o777).toBe(0o600);
  });

  it('a transcript without a trailing newline still gets its own line before the next header; an empty run list gives an empty file', async () => {
    const a = await run(1, 'no newline at end');
    const b = await run(2, '');
    const out = join(dir, 'x.log');
    await exportSession([a, b], out);
    const text = await readFile(out, 'utf8');
    const lines = text.split('\n');
    expect(lines[1]).toBe('no newline at end');
    expect(lines[2]!.startsWith('==== run ')).toBe(true);
    expect(text.endsWith('====\n')).toBe(true);
    await exportSession([], out);
    expect(await readFile(out, 'utf8')).toBe('');
  });

  it('missing or unreadable transcripts keep their header and are listed in `missing`', async () => {
    const a = await run(1, null);
    const b = await run(2, 'ok\n');
    const out = join(dir, 'x.log');
    const res = await exportSession([a, b], out);
    expect(res.missing).toEqual([`${a.runId}: ENOENT`]);
    const text = await readFile(out, 'utf8');
    expect(text.split('\n').filter((l) => l.startsWith('==== run '))).toHaveLength(2);
    expect(text).toContain('ok\n');
  });

  it('caps at maxBytes with a trailing `… truncated` line, never splitting a UTF-8 sequence', async () => {
    const a = await run(1, `${'é日🙂'.repeat(2000)}\n`);
    const b = await run(2, 'never reached\n');
    const out = join(dir, 'x.log');
    const res = await exportSession([a, b], out, { maxBytes: 1000 });
    expect(res.truncated).toBe(true);
    expect(res.bytes).toBeLessThanOrEqual(1000);
    const buf = await readFile(out);
    expect(buf.length).toBe(res.bytes);
    const text = buf.toString('utf8');
    expect(text.endsWith(`${EXPORT_TRUNCATED_LINE}\n`)).toBe(true);
    expect(text).not.toContain('�');
    expect(text).not.toContain('never reached');
    expect(EXPORT_MAX_BYTES).toBe(64 * 1024 * 1024);
    // a cap smaller than the marker still writes only the marker
    const tiny = await exportSession([a], join(dir, 'tiny.log'), { maxBytes: 3 });
    expect(tiny.truncated).toBe(true);
    expect(await readFile(join(dir, 'tiny.log'), 'utf8')).toBe(`${EXPORT_TRUNCATED_LINE}\n`);
  });

  it('header: `==== run <id> · <t> · <task60> · <stopReason> · $<cost> ====`, with in-progress and unknown-cost forms, control chars stripped', () => {
    const r: ExportRun = { runId: 'X', runDir: '/r', startedAt: 't', task60: 'a\nb\tc', stopReason: null, costUsd: null };
    expect(exportHeader(r)).toBe('==== run X · t · a b c · in progress · $? ====');
    expect(exportHeader({ ...r, task60: 'x'.repeat(80), costUsd: Number.NaN })).toBe(`==== run X · t · ${'x'.repeat(60)} · in progress · $? ====`);
  });

  it('short writes: the byte accounting follows bytesWritten and the `… truncated` marker still lands within maxBytes', async () => {
    const a = await run(1, `${'é日🙂'.repeat(500)}\n`);
    const b = await run(2, 'tail\n');
    const full = join(dir, 'full.log');
    const reference = await exportSession([a, b], full, { maxBytes: 900 });
    const referenceText = await readFile(full);
    // a sink that writes at most half of every buffer (never less than one byte)
    const chunks: Buffer[] = [];
    let calls = 0;
    const shortSink = (): Promise<ExportSink> =>
      Promise.resolve({
        write: (buf: Uint8Array) => {
          calls++;
          const n = Math.max(1, Math.floor(buf.length / 2));
          chunks.push(Buffer.from(buf.subarray(0, n)));
          return Promise.resolve({ bytesWritten: n });
        },
        close: () => Promise.resolve(),
      });
    const res = await exportSession([a, b], join(dir, 'short.log'), { maxBytes: 900, openSink: shortSink });
    const written = Buffer.concat(chunks);
    expect(res.truncated).toBe(true);
    expect(res.bytes).toBe(written.length);
    expect(res.bytes).toBe(reference.bytes);
    expect(written.equals(referenceText)).toBe(true);
    expect(written.length).toBeLessThanOrEqual(900);
    expect(written.toString('utf8').endsWith(`${EXPORT_TRUNCATED_LINE}\n`)).toBe(true);
    expect(calls).toBeGreaterThan(3);
    // an untruncated export through the same sink is byte-identical to the file
    const okChunks: Buffer[] = [];
    const okSink = (): Promise<ExportSink> => Promise.resolve({ write: (buf: Uint8Array) => { const n = Math.max(1, Math.floor(buf.length / 3)); okChunks.push(Buffer.from(buf.subarray(0, n))); return Promise.resolve({ bytesWritten: n }); }, close: () => Promise.resolve() });
    const okRes = await exportSession([b, a], join(dir, 'ok.log'), { openSink: okSink });
    await exportSession([b, a], join(dir, 'ok-file.log'));
    expect(Buffer.concat(okChunks).equals(await readFile(join(dir, 'ok-file.log')))).toBe(true);
    expect(okRes.bytes).toBe(Buffer.concat(okChunks).length);
    // a sink that makes no progress is an EIO error, not an infinite loop
    const stuck: ExportSink = { write: () => Promise.resolve({ bytesWritten: 0 }), close: () => Promise.resolve() };
    await expect(writeAll(stuck, Buffer.from('x'), '/x')).rejects.toMatchObject({ code: 'EIO' });
    await expect(exportSession([a], join(dir, 'stuck.log'), { openSink: () => Promise.resolve(stuck) })).rejects.toMatchObject({ code: 'EIO' });
    expect(await writeAll(stuck, Buffer.alloc(0), '/x')).toBe(0);
  });

  it('throws for an unwritable target so the caller can render `could not write <file>: <code>`', async () => {
    const file = join(dir, 'f');
    await writeFile(file, 'x');
    await expect(exportSession([], join(file, 'out.log'))).rejects.toMatchObject({ code: expect.stringMatching(/ENOTDIR|EEXIST|ENOENT/) });
  });

  it('defaultExportPath is ~/.jevcode/exports/<sessionId>.log with unsafe characters replaced', () => {
    expect(defaultExportPath('/home/me', '20260920-140211-abcdefgh')).toBe('/home/me/.jevcode/exports/20260920-140211-abcdefgh.log');
    expect(defaultExportPath('/home/me', '../evil/../x')).toBe('/home/me/.jevcode/exports/.._evil_.._x.log');
  });
});
