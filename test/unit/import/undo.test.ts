/**
 * docs/IMPORT-DESIGN.md §4.7.6 / §1 property 9 / §8.2 R3 / §6 rows 77 and 82 — `jevcode import --undo <id>`.
 *
 * Byte-identical restore, modes included; a destination modified since the import is left alone and
 * reported; **a missing pre-image is a row outcome, not an exception** [G1.4]; manifest entries are
 * removed only for rows actually restored. A credential is never touched at all — nothing in the
 * apply log can name one, because a credential row is structurally unwritable (§4.8.1).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { appendFile, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../../../src/core/hash.js';
import { applyPlan, undoImport } from '../../../src/import/apply.js';
import type { AppliedRow, ApplyOptions } from '../../../src/import/apply.js';
import type { ImportClock, ImportManifest, ImportPlan, ImportWriteFs, PlanRow } from '../../../src/import/types.js';

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
const IMPORT_ID = 'imp_20260921T120000Z_a1b2c3';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Applied {
  ws: string;
  artifactDir: string;
  lockPath: string;
  opts: ApplyOptions;
  log: readonly AppliedRow[];
  manifest: ImportManifest;
  /** the pre-images, so a restore can be compared byte for byte and mode for mode */
  pre: ReadonlyMap<string, { text: string; mode: number }>;
}

/**
 * Three destinations with different histories: one created from nothing, one overwritten (0644) and
 * one personal file overwritten at 0600 — so the mode restore is a real assertion, not a tautology.
 */
async function applied(): Promise<Applied> {
  // realpath'd, because `apply.jsonl` records the canonical destination (`confineDestination` resolves
  // the parent) and `/var` is a symlink to `/private/var` on darwin — the assertions compare the strings
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'jev-undo-')));
  dirs.push(dir);
  const ws = join(dir, 'ws');
  await mkdir(join(ws, '.jevcode', 'memory'), { recursive: true });
  await mkdir(join(ws, '.jevcode', 'memory-local'), { recursive: true });

  const pre = new Map<string, { text: string; mode: number }>();
  const existing = join(ws, '.jevcode', 'memory', 'kept.md');
  await writeFile(existing, 'the original bytes\nwith two lines\n', { mode: 0o644 });
  await chmod(existing, 0o644);
  pre.set(existing, { text: 'the original bytes\nwith two lines\n', mode: 0o644 });
  const personal = join(ws, '.jevcode', 'memory-local', 'personal.md');
  await writeFile(personal, 'private notes\n', { mode: 0o600 });
  await chmod(personal, 0o600);
  pre.set(personal, { text: 'private notes\n', mode: 0o600 });

  const specs: { id: string; dest: string; scope: PlanRow['scope'] }[] = [
    { id: 'rowcreated001', dest: '.jevcode/memory/fresh.md', scope: 'project' },
    { id: 'rowkept000002', dest: '.jevcode/memory/kept.md', scope: 'project' },
    { id: 'rowlocal00003', dest: '.jevcode/memory-local/personal.md', scope: 'project-local' },
  ];
  const rows: PlanRow[] = [];
  for (const spec of specs) {
    const src = join(dir, `${spec.id}.md`);
    const body = `imported for ${spec.id}\n`;
    await writeFile(src, body, { mode: 0o644 });
    const st = await stat(src);
    rows.push({
      id: spec.id,
      source: { id: spec.id, display: `~/${spec.id}.md`, tools: ['claude-code'], sha256: sha256Hex(body), bytes: st.size, mtimeMs: st.mtimeMs },
      class: 'memory',
      dest: spec.dest,
      action: 'create',
      scope: spec.scope,
      bytes: body.length,
      why: 'test',
      warnings: [],
    });
  }
  const plan: ImportPlan = {
    v: 1,
    importId: IMPORT_ID,
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
  const artifactDir = join(dir, 'imports', IMPORT_ID);
  const lockPath = join(dir, 'imports', '.lock');
  const opts: ApplyOptions = {
    plan,
    fs: nodeWriteFs(),
    clock,
    destRoots: { project: ws, projectLocal: ws, user: join(dir, 'cfg') },
    artifactDir,
    lockPath,
    manifest: null,
    consent: 'tty',
    approved: rows.map((r) => r.id),
    render: async (_row, text) => ({ text, mode: 0o644, warnings: [] }),
    sourcePath: (row) => join(dir, `${row.id}.md`),
  };
  const result = await applyPlan(opts);
  expect(result.exitCode).toBe(0);
  return { ws, artifactDir, lockPath, opts, log: result.applied, manifest: result.manifest, pre };
}

function undoOptions(a: Applied, over: Partial<Parameters<typeof undoImport>[0]> = {}): Parameters<typeof undoImport>[0] {
  return {
    fs: a.opts.fs,
    clock,
    artifactDir: a.artifactDir,
    lockPath: a.lockPath,
    importId: IMPORT_ID,
    applyLog: a.log,
    manifest: a.manifest,
    workspaceKey: a.opts.plan.workspaceKey,
    ...over,
  };
}

describe('undoImport (§4.7.6, §1 property 9, §8.2 R3)', () => {
  it('restores every destination byte-identically, modes included, and deletes what it created', async () => {
    const a = await applied();
    // the import really did change things first
    expect(readFileSync(join(a.ws, '.jevcode', 'memory', 'kept.md'), 'utf8')).toBe('imported for rowkept000002\n');
    expect(existsSync(join(a.ws, '.jevcode', 'memory', 'fresh.md'))).toBe(true);

    const r = await undoImport(undoOptions(a));
    expect(r.exitCode).toBe(0);
    expect(r.left).toEqual([]);
    expect(r.restored).toHaveLength(3);

    expect(existsSync(join(a.ws, '.jevcode', 'memory', 'fresh.md'))).toBe(false);
    for (const [path, want] of a.pre) {
      expect(readFileSync(path, 'utf8')).toBe(want.text);
      expect(sha256Hex(readFileSync(path))).toBe(sha256Hex(want.text));
      expect(statSync(path).mode & 0o777).toBe(want.mode);
    }
    // §4.7.6: entries are removed for the rows that were restored
    expect(r.manifest.workspaces[a.opts.plan.workspaceKey]).toEqual([]);
  });

  it('row 82: a destination modified since the import is `review — modified since the import; left alone`', async () => {
    const a = await applied();
    const edited = join(a.ws, '.jevcode', 'memory', 'kept.md');
    await writeFile(edited, 'the human kept editing after the import\n', { mode: 0o644 });

    const r = await undoImport(undoOptions(a));
    expect(r.exitCode).toBe(2);
    expect(r.left).toEqual([{ dest: edited, why: 'review — modified since the import; left alone' }]);
    expect(readFileSync(edited, 'utf8')).toBe('the human kept editing after the import\n');
    // the other two still restored
    expect(r.restored).toHaveLength(2);
    expect(existsSync(join(a.ws, '.jevcode', 'memory', 'fresh.md'))).toBe(false);
    expect(readFileSync(join(a.ws, '.jevcode', 'memory-local', 'personal.md'), 'utf8')).toBe('private notes\n');

    // §4.7.6: manifest entries removed ONLY for rows actually restored
    const left = r.manifest.workspaces[a.opts.plan.workspaceKey] ?? [];
    expect(left.map((e) => e.dest)).toEqual(['.jevcode/memory/kept.md']);
  });

  it('row 77: a missing pre-image is a ROW OUTCOME, not an exception; the other rows restore', async () => {
    const a = await applied();
    await rm(join(a.artifactDir, 'pre'), { recursive: true, force: true });

    const r = await undoImport(undoOptions(a));
    expect(r.exitCode).toBe(2);
    // the two rows that had a pre-image are reported, not thrown
    const why = r.left.map((l) => l.why);
    expect(why).toHaveLength(2);
    for (const w of why) expect(w).toMatch(/^review — pre-image unavailable \(.*pre removed\); left alone$/);
    // the created row needs no pre-image and is still undone
    expect(r.restored).toEqual([join(a.ws, '.jevcode', 'memory', 'fresh.md')]);
    expect(existsSync(join(a.ws, '.jevcode', 'memory', 'fresh.md'))).toBe(false);
    // and the files whose pre-image is gone are untouched, not emptied
    expect(readFileSync(join(a.ws, '.jevcode', 'memory', 'kept.md'), 'utf8')).toBe('imported for rowkept000002\n');
  });

  it('a pre-image that does not match what was recorded is left alone too', async () => {
    const a = await applied();
    const row = a.log.find((l) => l.dest?.endsWith('kept.md'))!;
    await writeFile(join(a.artifactDir, 'pre', row.row), 'somebody rewrote the snapshot\n', { mode: 0o600 });
    const r = await undoImport(undoOptions(a));
    expect(r.left.map((l) => l.why)).toContain('review — the pre-image does not match what was recorded; left alone');
    expect(readFileSync(join(a.ws, '.jevcode', 'memory', 'kept.md'), 'utf8')).toBe('imported for rowkept000002\n');
  });

  it('a `create` row whose destination the human already deleted is simply already undone', async () => {
    const a = await applied();
    await rm(join(a.ws, '.jevcode', 'memory', 'fresh.md'));
    const r = await undoImport(undoOptions(a));
    expect(r.exitCode).toBe(0);
    expect(r.restored).toContain(join(a.ws, '.jevcode', 'memory', 'fresh.md'));
  });

  it('a second undo changes nothing: a restored destination no longer matches sha256After, so it is left alone', async () => {
    const a = await applied();
    const first = await undoImport(undoOptions(a));
    expect(first.exitCode).toBe(0);

    const second = await undoImport(undoOptions(a, { manifest: first.manifest }));
    // the pre-images are back, so they no longer hash to `sha256After` — the same guard that protects a
    // human's edit protects them here. Nothing is re-written, nothing is emptied.
    expect(second.left.map((l) => l.why)).toEqual(['review — modified since the import; left alone', 'review — modified since the import; left alone']);
    for (const [path, want] of a.pre) {
      expect(readFileSync(path, 'utf8')).toBe(want.text);
      expect(statSync(path).mode & 0o777).toBe(want.mode);
    }
    // the `create` row stays undone, and the manifest the first undo emptied stays empty
    expect(existsSync(join(a.ws, '.jevcode', 'memory', 'fresh.md'))).toBe(false);
    expect(second.manifest.workspaces[a.opts.plan.workspaceKey]).toEqual([]);
  });

  it('rows are unwound in reverse apply order, so AGENTS.md (written last) is undone first', async () => {
    const a = await applied();
    const r = await undoImport(undoOptions(a));
    expect(r.restored).toEqual([...a.log].reverse().map((l) => l.dest));
  });

  it('a log line that failed is skipped entirely — undo never touches a destination apply did not write', async () => {
    const a = await applied();
    const poisoned: AppliedRow[] = [
      ...a.log,
      { row: 'rowfailed0001', dest: join(a.ws, '.jevcode', 'memory', 'kept.md'), sha256Before: null, sha256After: null, mode: 0, bytes: 0, at: '2026-09-21T12:00:00.000Z', ok: false, error: 'EACCES' },
    ];
    const r = await undoImport(undoOptions(a, { applyLog: poisoned }));
    expect(r.restored).toHaveLength(3);
    expect(readFileSync(join(a.ws, '.jevcode', 'memory', 'kept.md'), 'utf8')).toBe('the original bytes\nwith two lines\n');
  });
});
