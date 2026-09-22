/**
 * docs/IMPORT-DESIGN.md §4.7.6 / §1 property 10 / §6 row 73 — SIGKILL mid-apply, then `--resume`.
 *
 * `apply.jsonl` is appended **after** each write, so the log is a prefix of what actually happened and
 * the last line may be torn. `resumeImport` re-reads the plan, skips every row already `ok: true`,
 * re-verifies each remaining source (§4.7.2) and continues. No row is applied twice: the property is
 * asserted on the log (one line per row) and on the destinations (an already-applied file is not
 * rewritten, so an append does not grow a second marker block).
 */
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../../../src/core/hash.js';
import { applyPlan, resumeImport } from '../../../src/import/apply.js';
import type { AppliedRow, ApplyOptions } from '../../../src/import/apply.js';
import type { ImportClock, ImportPlan, ImportWriteFs, PlanRow } from '../../../src/import/types.js';

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
const clock: ImportClock = { now: () => new Date('2026-09-21T12:00:00.000Z'), monotonicMs: () => 0 };

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Tree {
  ws: string;
  artifactDir: string;
  opts: ApplyOptions;
  ids: readonly string[];
}

/** Six rows: four topic files, an append and an index — enough to kill halfway through. */
async function tree(): Promise<Tree> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-resume-'));
  dirs.push(dir);
  const ws = join(dir, 'ws');
  await mkdir(ws, { recursive: true });
  const artifactDir = join(dir, 'imports', 'imp_20260921T120000Z_a1b2c3');
  const rows: PlanRow[] = [];
  for (let i = 0; i < 4; i++) {
    const src = join(dir, `t${i}.md`);
    const body = `topic ${i}\n`;
    await writeFile(src, body, { mode: 0o644 });
    const st = await stat(src);
    rows.push({
      id: `row00000000${i}`,
      source: { id: `s${i}`, display: `~/t${i}.md`, tools: ['claude-code'], sha256: sha256Hex(body), bytes: st.size, mtimeMs: st.mtimeMs },
      class: 'memory',
      dest: `.jevcode/memory/t${i}.md`,
      action: 'create',
      scope: 'project',
      bytes: body.length,
      why: 'test',
      warnings: [],
    });
  }
  const appendSrc = join(dir, 'agents.md');
  await writeFile(appendSrc, 'appended text\n', { mode: 0o644 });
  const ast = await stat(appendSrc);
  rows.push({
    id: 'row000000app',
    source: { id: 'sapp', display: '~/agents.md', tools: ['claude-code'], sha256: sha256Hex('appended text\n'), bytes: ast.size, mtimeMs: ast.mtimeMs },
    class: 'memory',
    dest: 'AGENTS.md',
    action: 'append',
    scope: 'project',
    bytes: 14,
    why: 'test',
    warnings: [],
  });
  await writeFile(join(ws, 'AGENTS.md'), '# repo\n', { mode: 0o644 });
  const plan: ImportPlan = {
    v: 1,
    importId: 'imp_20260921T120000Z_a1b2c3',
    at: '2026-09-21T12:00:00.000Z',
    jevcodeVersion: '0.3.0',
    workspace: ws,
    workspaceKey: ws,
    gitRoot: ws,
    trust: 'trust',
    roots: [],
    rows,
    budget: { memoryBytes: 0, memoryMax: 1, indexLines: 0, indexMax: 1 },
    jev: { requests: 0, questions: 0, usd: 0, fallbacks: 0 },
    cannotRead: [],
    notices: [],
  };
  return {
    ws,
    artifactDir,
    ids: rows.map((r) => r.id),
    opts: {
      plan,
      fs: nodeWriteFs(),
      clock,
      destRoots: { project: ws, projectLocal: ws, user: join(dir, 'cfg') },
      artifactDir,
      lockPath: join(dir, 'imports', '.lock'),
      manifest: null,
      consent: 'tty',
      approved: rows.map((r) => r.id),
      render: async (row, text) => ({ text: `${text.trim()} (${row.id})\n`, mode: 0o644, warnings: [] }),
      sourcePath: (row) => join(dir, `${row.source.display.slice(2)}`),
    },
  };
}

/** The tolerant reader `--resume` uses: a torn last line is simply not a record (§4.7.6). */
function logLines(artifactDir: string): readonly AppliedRow[] {
  const path = join(artifactDir, 'apply.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as AppliedRow];
      } catch {
        return [];
      }
    });
}

describe('resumeImport (§4.7.6, §1 property 10)', () => {
  it('a kill mid-apply leaves a truncated apply.jsonl; the resume finishes it and applies no row twice', async () => {
    const t = await tree();
    // ----- the "kill": apply only the first three rows, then simulate a torn final line -----
    const first = await applyPlan({ ...t.opts, approved: t.ids.slice(0, 3) });
    expect(first.exitCode).toBe(0);
    const logPath = join(t.artifactDir, 'apply.jsonl');
    const whole = readFileSync(logPath, 'utf8');
    const torn = `${whole}{"row":"row000000003","dest":"/ws/.jevcode/memo`;
    await writeFile(logPath, torn, { mode: 0o600 });

    // ----- --resume: re-read plan.json, parse the lines that survived, skip what is done -----
    const survived = torn
      .split('\n')
      .filter((l) => l.length > 0)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as AppliedRow];
        } catch {
          return []; // the torn line is simply not there — that is the whole point of append-after-write
        }
      });
    expect(survived).toHaveLength(3);

    const r = await resumeImport({ ...t.opts, applyLog: survived });
    expect(r.exitCode).toBe(0);
    expect(r.notices[0]).toBe('resumed imp_20260921T120000Z_a1b2c3: 3 rows were already applied');

    // every row appears exactly once in the result…
    expect(r.applied.map((a) => a.row).sort()).toEqual([...t.ids].sort());
    expect(new Set(r.applied.map((a) => a.row)).size).toBe(t.ids.length);
    // …and exactly once in the log: the three prior lines are not re-appended, and the torn line was
    // terminated before the first new append, so no record was lost to concatenation
    const after = logLines(t.artifactDir);
    expect(after.map((l) => l.row).sort()).toEqual([...t.ids].sort());
    expect(readFileSync(logPath, 'utf8')).toContain('{"row":"row000000003","dest":"/ws/.jevcode/memo\n');

    // no destination was written twice: the append grew exactly one marker block
    const agents = readFileSync(join(t.ws, 'AGENTS.md'), 'utf8');
    expect(agents.split('<!-- jevcode:import ').length - 1).toBe(1);
    expect(agents.startsWith('# repo\n')).toBe(true);
    for (let i = 0; i < 4; i++) expect(readFileSync(join(t.ws, '.jevcode', 'memory', `t${i}.md`), 'utf8')).toBe(`topic ${i} (row00000000${i})\n`);
  });

  it('every destination is either its pre-image or its final bytes — never a partial write (§6 row 73)', async () => {
    const t = await tree();
    const first = await applyPlan({ ...t.opts, approved: t.ids.slice(0, 2) });
    expect(first.exitCode).toBe(0);
    // rows 2..4 never ran: their destinations do not exist at all
    for (let i = 2; i < 4; i++) expect(existsSync(join(t.ws, '.jevcode', 'memory', `t${i}.md`))).toBe(false);
    expect(readFileSync(join(t.ws, 'AGENTS.md'), 'utf8')).toBe('# repo\n');
    // rows 0..1 are whole
    for (let i = 0; i < 2; i++) expect(readFileSync(join(t.ws, '.jevcode', 'memory', `t${i}.md`), 'utf8')).toBe(`topic ${i} (row00000000${i})\n`);
  });

  it('a resume re-verifies the remaining sources, so a race during the outage still demotes (§4.7.2)', async () => {
    const t = await tree();
    const first = await applyPlan({ ...t.opts, approved: t.ids.slice(0, 2) });
    const done = logLines(t.artifactDir);
    expect(done).toHaveLength(2);
    // the human edited t3.md while the import was dead
    await writeFile(join(dirname(t.opts.sourcePath(t.opts.plan.rows[3]!)), 't3.md'), 'rewritten while it was down\n', { mode: 0o644 });

    const r = await resumeImport({ ...t.opts, applyLog: done });
    expect(r.exitCode).toBe(2);
    expect(r.demoted.map((d) => d.row)).toEqual(['row000000003']);
    expect(existsSync(join(t.ws, '.jevcode', 'memory', 't3.md'))).toBe(false);
    // the rest of the run still completed
    expect(r.applied.map((a) => a.row).sort()).toEqual(['row000000000', 'row000000001', 'row000000002', 'row000000app']);
    expect(first.applied).toHaveLength(2);
  });

  it('a resume with an empty log is an ordinary apply', async () => {
    const t = await tree();
    const r = await resumeImport({ ...t.opts, applyLog: [] });
    expect(r.exitCode).toBe(0);
    expect(r.applied).toHaveLength(t.ids.length);
    expect(r.notices.some((n) => n.startsWith('resumed'))).toBe(false);
  });

  it('a failed row in the log is NOT treated as done — only `ok: true` skips', async () => {
    const t = await tree();
    const failed: AppliedRow = { row: 'row000000000', dest: null, sha256Before: null, sha256After: null, mode: 0, bytes: 0, at: '2026-09-21T12:00:00.000Z', ok: false, error: 'EACCES' };
    const r = await resumeImport({ ...t.opts, applyLog: [failed] });
    expect(r.applied.map((a) => a.row)).toContain('row000000000');
    expect(existsSync(join(t.ws, '.jevcode', 'memory', 't0.md'))).toBe(true);
  });
});
