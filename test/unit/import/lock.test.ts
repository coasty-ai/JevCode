/**
 * docs/IMPORT-DESIGN.md §4.7.1 **[G1.4]** / §6 rows 74, 75, 76 — one lock over every mutating operation.
 *
 * The spine locked `apply`. The graft widens the lock to `--resume` and `--undo` too, because all three
 * rewrite `apply.jsonl` and the manifest. The three properties: a second mutator is refused with the
 * holder's pid and the lock's age; a lock whose pid is gone is taken over; a lock older than
 * `lockStaleMs` is taken over even when the pid is alive.
 */
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { IMPORT_LIMITS } from '../../../src/core/limits.js';
import { applyPlan, releaseLock, resumeImport, takeLock, undoImport } from '../../../src/import/apply.js';
import type { AppliedRow, ApplyOptions, LockInfo } from '../../../src/import/apply.js';
import type { ImportClock, ImportPlan, ImportWriteFs } from '../../../src/import/types.js';

function nodeWriteFs(): ImportWriteFs {
  return {
    async readdir(p) {
      return (await readdir(p, { withFileTypes: true })).map((d) => ({ name: d.name, isFile: () => d.isFile(), isDirectory: () => d.isDirectory(), isSymbolicLink: () => d.isSymbolicLink() }));
    },
    async stat(p) {
      const s = await stat(p);
      return { isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs, mode: s.mode, dev: s.dev, ino: s.ino };
    },
    async lstat(p) {
      const s = await lstat(p);
      return { isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), isSymbolicLink: () => s.isSymbolicLink(), size: s.size, mtimeMs: s.mtimeMs, mode: s.mode, dev: s.dev, ino: s.ino };
    },
    realpath: (p) => realpath(p),
    readFile: (p) => readFile(p),
    async readPrefix(p, bytes) {
      const fh = await open(p, 'r');
      try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
    async writeFile(p, data, o) {
      if (o.mkdir) await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data, { mode: o.mode });
    },
    async appendFile(p, data, o) {
      if (o.mkdir) await mkdir(dirname(p), { recursive: true });
      await appendFile(p, data, { mode: o.mode });
    },
    async mkdir(p, o) {
      await mkdir(p, o);
    },
    rm: (p) => rm(p, { force: true }),
    chmod: (p, m) => chmod(p, m),
    async createExclusive(p, data, mode) {
      try {
        await mkdir(dirname(p), { recursive: true });
        const fh = await open(p, 'wx', mode);
        await fh.writeFile(data);
        await fh.close();
        return true;
      } catch {
        return false;
      }
    },
  };
}

const NOW = '2026-09-21T12:00:00.000Z';
function clockAt(iso: string): ImportClock {
  return { now: () => new Date(iso), monotonicMs: () => Date.parse(iso) };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'jev-lock-'));
  dirs.push(d);
  return d;
}

const held = (over: Partial<LockInfo> = {}): LockInfo => ({ pid: 1234, importId: 'imp_20260921T110000Z_aaaaaa', op: 'apply', at: NOW, ...over });

describe('takeLock (§4.7.1 [G1.4])', () => {
  it('creates the lock O_EXCL at 0600 and releases it', async () => {
    const dir = await temp();
    const fs = nodeWriteFs();
    const path = join(dir, 'imports', '.lock');
    const first = await takeLock(fs, clockAt(NOW), path, held());
    expect(first).toEqual({ ok: true, tookOver: false });
    expect(JSON.parse(readFileSync(path, 'utf8')) as LockInfo).toEqual(held());
    await releaseLock(fs, path);
    expect(existsSync(path)).toBe(false);
    // releasing a lock nobody holds is the state we want, not an error
    await expect(releaseLock(fs, path)).resolves.toBeUndefined();
  });

  it('row 74: a second mutator is refused with the holder pid and the lock age', async () => {
    const dir = await temp();
    const fs = nodeWriteFs();
    const path = join(dir, '.lock');
    await takeLock(fs, clockAt(NOW), path, held({ pid: 1234 }));
    const later = new Date(Date.parse(NOW) + 14_000).toISOString();
    const second = await takeLock(fs, clockAt(later), path, held({ pid: 5678, op: 'undo' }), () => true);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.held.pid).toBe(1234);
    expect(Math.round(second.ageMs / 1000)).toBe(14);
    // the holder's entry is untouched
    expect((JSON.parse(readFileSync(path, 'utf8')) as LockInfo).pid).toBe(1234);
  });

  it('row 76: a stale lock is taken over — pid gone, or older than lockStaleMs with the pid alive', async () => {
    const dir = await temp();
    const fs = nodeWriteFs();
    const gone = join(dir, 'a.lock');
    await takeLock(fs, clockAt(NOW), gone, held({ pid: 1234 }));
    const overPidGone = await takeLock(fs, clockAt(NOW), gone, held({ pid: 5678 }), () => false);
    expect(overPidGone).toEqual({ ok: true, tookOver: true });
    expect((JSON.parse(readFileSync(gone, 'utf8')) as LockInfo).pid).toBe(5678);

    const old = join(dir, 'b.lock');
    await takeLock(fs, clockAt(NOW), old, held({ pid: 1234 }));
    const justInside = new Date(Date.parse(NOW) + IMPORT_LIMITS.lockStaleMs).toISOString();
    expect((await takeLock(fs, clockAt(justInside), old, held({ pid: 5678 }), () => true)).ok).toBe(false);
    const justOutside = new Date(Date.parse(NOW) + IMPORT_LIMITS.lockStaleMs + 1).toISOString();
    expect(await takeLock(fs, clockAt(justOutside), old, held({ pid: 5678 }), () => true)).toEqual({ ok: true, tookOver: true });
  });

  it('an unparseable or truncated lock file is stale, not a crash', async () => {
    const dir = await temp();
    const fs = nodeWriteFs();
    const path = join(dir, '.lock');
    await writeFile(path, '{"pid": 12', { mode: 0o600 });
    expect(await takeLock(fs, clockAt(NOW), path, held(), () => true)).toEqual({ ok: true, tookOver: true });
  });
});

// ---------------------------------------------------------------------------------------
// row 75: the lock covers apply, resume AND undo
// ---------------------------------------------------------------------------------------

async function scaffold(): Promise<{ opts: ApplyOptions; lockPath: string }> {
  const dir = await temp();
  const ws = join(dir, 'ws');
  await mkdir(ws, { recursive: true });
  const src = join(dir, 'a.md');
  await writeFile(src, 'hello\n', { mode: 0o644 });
  const st = await stat(src);
  const plan: ImportPlan = {
    v: 1,
    importId: 'imp_20260921T120000Z_a1b2c3',
    at: NOW,
    jevcodeVersion: '0.3.0',
    workspace: ws,
    workspaceKey: ws,
    gitRoot: ws,
    trust: 'trust',
    roots: [],
    rows: [
      {
        id: 'row000000001',
        source: { id: 'src1', display: '~/a.md', tools: ['claude-code'], sha256: '', bytes: st.size, mtimeMs: st.mtimeMs },
        class: 'memory',
        dest: '.jevcode/memory/a.md',
        action: 'create',
        scope: 'project',
        bytes: 6,
        why: 'test',
        warnings: [],
      },
    ],
    budget: { memoryBytes: 0, memoryMax: 1, indexLines: 0, indexMax: 1 },
    jev: { requests: 0, questions: 0, usd: 0, fallbacks: 0 },
    cannotRead: [],
    notices: [],
  };
  const lockPath = join(dir, '.lock');
  return {
    lockPath,
    opts: {
      plan,
      fs: nodeWriteFs(),
      clock: clockAt(NOW),
      destRoots: { project: ws, projectLocal: ws, user: join(dir, 'cfg') },
      artifactDir: join(dir, 'artifacts'),
      lockPath,
      manifest: null,
      consent: 'tty',
      approved: ['row000000001'],
      render: async (_r, text) => ({ text, mode: 0o644, warnings: [] }),
      sourcePath: () => src,
      pid: process.pid,
    },
  };
}

describe('the widened lock (§4.7.1 [G1.4], §6 row 75)', () => {
  it('apply, resume and undo each refuse while another mutator holds the lock', async () => {
    const { opts, lockPath } = await scaffold();
    // a live holder: this process's own pid, one second ago
    await takeLock(opts.fs, clockAt(NOW), lockPath, held({ pid: process.pid, op: 'apply', at: new Date(Date.parse(NOW) - 14_000).toISOString() }));

    const refusal = /^an import is applying \(pid \d+, 14 s ago\) — try again when it finishes$/;

    const a = await applyPlan(opts);
    expect(a.exitCode).toBe(2);
    expect(a.notices[0]).toMatch(refusal);
    expect(a.applied).toEqual([]);

    const r = await resumeImport({ ...opts, applyLog: [] });
    expect(r.exitCode).toBe(2);
    expect(r.notices[0]).toMatch(refusal);

    const u = await undoImport({
      fs: opts.fs,
      clock: opts.clock,
      artifactDir: opts.artifactDir,
      lockPath,
      importId: opts.plan.importId,
      applyLog: [],
      manifest: null,
      workspaceKey: opts.plan.workspaceKey,
    });
    expect(u.exitCode).toBe(2);
    expect(u.left[0]?.why).toMatch(refusal);
    expect(u.restored).toEqual([]);

    // nothing was written while the lock was held
    expect(existsSync(join(opts.destRoots.project, '.jevcode', 'memory', 'a.md'))).toBe(false);
    // and the holder's lock survived all three refusals
    expect((JSON.parse(readFileSync(lockPath, 'utf8')) as LockInfo).op).toBe('apply');
  });

  it('each operation releases the lock when it finishes, so the next one can take it', async () => {
    const { opts, lockPath } = await scaffold();
    expect((await applyPlan(opts)).exitCode).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    const log = readFileSync(join(opts.artifactDir, 'apply.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as AppliedRow);
    const u = await undoImport({
      fs: opts.fs,
      clock: opts.clock,
      artifactDir: opts.artifactDir,
      lockPath,
      importId: opts.plan.importId,
      applyLog: log,
      manifest: null,
      workspaceKey: opts.plan.workspaceKey,
    });
    expect(u.exitCode).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });
});
