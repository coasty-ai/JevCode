/**
 * docs/IMPORT-DESIGN.md §4.7.3 **[G1.2]** / §1 property 8 / §6 row 72 / Appendix A.1 — destinations are confined.
 *
 * Destination names come from source-controlled frontmatter `name:` values and source filenames, so a
 * cloned hostile repository's `.cursor/rules/*.mdc` could otherwise land an executable file in
 * `.git/hooks`. Three steps hold the line: `slugOf` sanitises the basename (W2, `plan.ts`), then
 * `confineDestination` re-asserts `isInside` at the seam and refuses a symlinked final component.
 *
 * `slugOf` is asserted here on the four hostile names; `confineDestination` is asserted independently,
 * because the seam must refuse an escape even if a future caller forgets the slug; and an end-to-end
 * `applyPlan` over all five hostile rows asserts the thing that actually matters — `.git/hooks` is
 * untouched and every byte landed inside the destination tree.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { appendFile, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../../../src/core/hash.js';
import { applyPlan, confineDestination, joinDestination } from '../../../src/import/apply.js';
import type { ApplyOptions } from '../../../src/import/apply.js';
import { slugOf } from '../../../src/import/plan.js';
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
async function temp(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'jev-slug-')));
  dirs.push(d);
  return d;
}

/** §6 row 72, the five hostile destinations. */
const HOSTILE_NAMES = {
  traversal: '../../.git/hooks/pre-commit',
  dotdot: 'notes..md',
  overlong: `${'é'.repeat(200)}${'字'.repeat(200)}`,
  empty: '…·—/\\',
} as const;

describe('slugOf (§4.7.3 step 1, W2 plan.ts)', () => {
  it('sanitises every hostile name to a single confined basename', () => {
    for (const [label, name] of Object.entries(HOSTILE_NAMES)) {
      const slug = slugOf(name, `/seed/${label}`);
      expect(slug, label).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
      expect(slug.includes('/'), label).toBe(false);
      expect(slug.includes('\\'), label).toBe(false);
      expect(slug.includes('..'), label).toBe(false);
      expect(slug.length, label).toBeLessThanOrEqual(64);
    }
    // the two that cannot yield a name fall back to sha256(realpath)[0..8]
    expect(slugOf(HOSTILE_NAMES.empty, '/seed/empty')).toBe(sha256Hex('/seed/empty').slice(0, 8));
    expect(slugOf('..', '/seed/dd')).toBe(sha256Hex('/seed/dd').slice(0, 8));
    expect(slugOf('.', '/seed/d')).toBe(sha256Hex('/seed/d').slice(0, 8));
    expect(slugOf('', '/seed/blank')).toBe(sha256Hex('/seed/blank').slice(0, 8));
    // deterministic: the same seed yields the same slug on every platform (§8.2 R9's sibling property)
    expect(slugOf(HOSTILE_NAMES.empty, '/seed/empty')).toBe(slugOf(HOSTILE_NAMES.empty, '/seed/empty'));
  });
});

describe('confineDestination (§4.7.3 steps 2 and 3)', () => {
  it('refuses every escape, independently of the slug', async () => {
    const dir = await temp();
    const ws = join(dir, 'ws');
    await mkdir(join(ws, '.jevcode', 'memory'), { recursive: true });
    await mkdir(join(dir, 'outside'), { recursive: true });
    const fs = nodeWriteFs();

    const refuse = async (dest: string): Promise<string> => {
      const r = await confineDestination(fs, dest, ws);
      expect(r.ok, dest).toBe(false);
      return r.ok ? '' : r.why;
    };
    expect(await refuse(resolve(ws, '../../.git/hooks/pre-commit'))).toBe('destination escapes the destination tree');
    // the escape that stays lexically INSIDE the tree: the destination root of a project row is the
    // repository itself, so `.git` has to be refused by name, not by containment
    expect(await refuse(resolve(ws, '.jevcode/memory/../../.git/hooks/pre-commit'))).toBe('destination is inside .git and is never written by JevCode');
    expect(await refuse(join(ws, '.GIT', 'config'))).toBe('destination is inside .git and is never written by JevCode');
    expect(await refuse(join(dir, 'outside', 'x.md'))).toBe('destination escapes the destination tree');
    expect(await refuse(ws)).toBe('destination escapes the destination tree');
    expect(await refuse('relative/path.md')).toBe('destination is not an absolute path');
    expect(await refuse('')).toBe('destination is empty or malformed');
    expect(await refuse(`${ws}/a\0b.md`)).toBe('destination is empty or malformed');

    // an ordinary destination inside the tree is accepted, existing or not
    const ok = await confineDestination(fs, join(ws, '.jevcode', 'memory', 'fine.md'), ws);
    expect(ok).toEqual({ ok: true, path: join(ws, '.jevcode', 'memory', 'fine.md') });
    const deep = await confineDestination(fs, join(ws, '.jevcode', 'memory', 'not', 'yet', 'here.md'), ws);
    expect(deep.ok).toBe(true);
  });

  it('refuses a symlinked final component, and a symlinked PARENT that leaves the tree', async () => {
    const dir = await temp();
    const ws = join(dir, 'ws');
    const outside = join(dir, 'outside');
    await mkdir(join(ws, '.jevcode', 'memory'), { recursive: true });
    await mkdir(outside, { recursive: true });
    const fs = nodeWriteFs();

    // (a) the final component is a symlink — `writeFileAtomic` renames over it, so it must be refused
    const linked = join(ws, '.jevcode', 'memory', 'linked.md');
    await writeFile(join(outside, 'target.md'), 'somebody else\n', { mode: 0o644 });
    await symlink(join(outside, 'target.md'), linked);
    const leaf = await confineDestination(fs, linked, ws);
    expect(leaf).toEqual({ ok: false, why: 'destination is a symlink' });
    expect(readFileSync(join(outside, 'target.md'), 'utf8')).toBe('somebody else\n');

    // (b) a symlinked PARENT created by an earlier row — the real hazard the design names
    const escapeDir = join(ws, '.jevcode', 'memory', 'sub');
    await symlink(outside, escapeDir);
    const parent = await confineDestination(fs, join(escapeDir, 'x.md'), ws);
    expect(parent).toEqual({ ok: false, why: 'destination directory resolves outside the destination tree' });

    // (c) a symlink that stays inside the tree is still refused as a final component, but a symlinked
    //     parent pointing back inside is fine — confinement is about where it lands, not about links
    const inside = join(ws, '.jevcode', 'inside');
    await symlink(join(ws, '.jevcode', 'memory'), inside);
    const back = await confineDestination(fs, join(inside, 'ok.md'), ws);
    expect(back).toEqual({ ok: true, path: join(ws, '.jevcode', 'memory', 'ok.md') });
  });
});

describe('applyPlan with five hostile destinations (§1 property 8, §6 row 72)', () => {
  it('all five are confined, .git/hooks is untouched, and every byte landed inside the tree', async () => {
    const dir = await temp();
    const ws = join(dir, 'ws');
    const outside = join(dir, 'outside');
    await mkdir(join(ws, '.git', 'hooks'), { recursive: true });
    await mkdir(join(ws, '.jevcode', 'memory'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(ws, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(join(outside, 'target.md'), 'somebody else\n', { mode: 0o644 });
    await symlink(join(outside, 'target.md'), join(ws, '.jevcode', 'memory', 'symlinked.md'));

    const src = join(dir, 'hostile.md');
    await writeFile(src, 'BODY THAT MUST NOT ESCAPE\n', { mode: 0o644 });
    const st = await stat(src);
    const source = { id: 'h', display: '~/.cursor/rules/hostile.mdc', tools: ['cursor'] as const, sha256: sha256Hex('BODY THAT MUST NOT ESCAPE\n'), bytes: st.size, mtimeMs: st.mtimeMs };

    // the five: a raw traversal, a `..` inside the filename, the 400-char name, the empty-normalising
    // name (both slugged, as `plan.ts` would), and the symlinked destination
    const dests: { id: string; dest: string }[] = [
      { id: 'hostile00001', dest: '.jevcode/memory/../../.git/hooks/pre-commit' },
      { id: 'hostile00002', dest: `.jevcode/memory/${slugOf(HOSTILE_NAMES.dotdot, '/seed/dotdot')}.md` },
      { id: 'hostile00003', dest: `.jevcode/memory/${slugOf(HOSTILE_NAMES.overlong, '/seed/overlong')}.md` },
      { id: 'hostile00004', dest: `.jevcode/memory/${slugOf(HOSTILE_NAMES.empty, '/seed/empty')}.md` },
      { id: 'hostile00005', dest: '.jevcode/memory/symlinked.md' },
    ];
    const rows: PlanRow[] = dests.map((d) => ({
      id: d.id,
      source,
      class: 'rule',
      dest: d.dest,
      action: 'create',
      scope: 'project',
      bytes: 26,
      why: 'hostile fixture',
      warnings: [],
    }));
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
    const opts: ApplyOptions = {
      plan,
      fs: nodeWriteFs(),
      clock,
      destRoots: { project: ws, projectLocal: ws, user: join(dir, 'cfg') },
      artifactDir: join(dir, 'imports', plan.importId),
      lockPath: join(dir, 'imports', '.lock'),
      manifest: null,
      consent: 'tty',
      approved: rows.map((r) => r.id),
      render: async (_row, text) => ({ text, mode: 0o644, warnings: [] }),
      sourcePath: () => src,
    };

    const r = await applyPlan(opts);

    // the traversal and the symlink are refused as rows, with the reason the report prints
    expect(r.demoted).toEqual([
      { row: 'hostile00001', why: 'review — destination is inside .git and is never written by JevCode; nothing was written' },
      { row: 'hostile00005', why: 'review — destination is a symlink; nothing was written' },
    ]);
    expect(r.exitCode).toBe(2);

    // the three slugged names landed, each as one file directly under the memory dir
    expect(r.applied.map((a) => a.row).sort()).toEqual(['hostile00002', 'hostile00003', 'hostile00004']);
    for (const a of r.applied) expect(a.dest?.startsWith(join(ws, '.jevcode', 'memory'))).toBe(true);
    expect(readdirSync(join(ws, '.jevcode', 'memory')).sort()).toEqual([
      'symlinked.md',
      `${slugOf(HOSTILE_NAMES.dotdot, '/seed/dotdot')}.md`,
      `${slugOf(HOSTILE_NAMES.overlong, '/seed/overlong')}.md`,
      `${slugOf(HOSTILE_NAMES.empty, '/seed/empty')}.md`,
    ].sort());

    // `.git/hooks` is untouched; nothing outside the tree was written
    expect(readdirSync(join(ws, '.git', 'hooks'))).toEqual(['pre-commit.sample']);
    expect(existsSync(join(ws, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(readFileSync(join(outside, 'target.md'), 'utf8')).toBe('somebody else\n');
    expect(readdirSync(outside)).toEqual(['target.md']);
    // and the joined form of the traversal really did point at `.git/hooks` — INSIDE the destination
    // tree — so the `.git` refusal, not containment, is what kept the hook out
    expect(joinDestination(ws, '.jevcode/memory/../../.git/hooks/pre-commit')).toBe(join(ws, '.git', 'hooks', 'pre-commit'));
  });
});
