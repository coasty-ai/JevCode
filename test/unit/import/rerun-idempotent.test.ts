/**
 * §1 property 6 — **a second run writes 0 bytes.**
 *
 * Review follow-up D1: `rerunAction` required `markers.includes(entry.importId)` before it would
 * consider a destination unchanged. That is right for an *appendable* destination — `AGENTS.md`
 * and `MEMORY.md` carry a marker pair around the imported block — but a `create` writes the
 * whole file and puts no markers in it at all. So on the second run every `memory/<slug>.md`,
 * `rules/<slug>.md`, `commands/<n>.md` and every destination that did not exist before came back
 * `review — the block was edited or removed; nothing was written`.
 *
 * That is the **dominant** case, not a corner: on a first import nothing exists, so almost every
 * row is a `create`. §1 property 6 failed for all of them, and the report accused the human of
 * having edited files they had never touched.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { applicableRows, applyPlan, nodeImportFs, planImport, rerunAction } from '../../../src/import/index.js';
import type { ApplyOptions, ImportClock, ImportEnvironment, ImportManifest, ImportWriteFs, PlanRow } from '../../../src/import/index.js';

const clock: ImportClock = { now: () => new Date('2026-09-21T12:00:00.000Z'), monotonicMs: () => 0 };
const IMPORT_ID = 'imp_20260921T120000Z_a1b2c3';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function nodeWriteFs(): ImportWriteFs {
  return {
    ...nodeImportFs(),
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

interface Fixture {
  ws: string;
  home: string;
  userDir: string;
  artifactDir: string;
  env: ImportEnvironment;
}

/** A fresh repo with BOTH shapes: one appendable destination and several whole-file creates. */
async function fixture(): Promise<Fixture> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'jev-rerun-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ws = join(root, 'repo');
  const home = join(root, 'home');
  await mkdir(ws, { recursive: true });
  await mkdir(join(home, '.claude'), { recursive: true });

  // appendable: the destination already exists, so the row is an `append` behind a marker pair
  await writeFile(join(ws, 'AGENTS.md'), '# repo conventions\n\nRun the tests first.\n');
  await writeFile(join(ws, 'CLAUDE.md'), '# claude\n\nPrefer terse diffs.\n');
  // whole-file creates: a topic, a personal note, a rule and a command
  const mem = join(home, '.claude', 'projects', '-repo', 'memory');
  await mkdir(mem, { recursive: true });
  await writeFile(join(mem, 'a-note.md'), '---\nname: a-note\ndescription: sandbox seatbelt deny rules\nmetadata:\n  type: project\n---\n# Seatbelt\n\nDeny writes under the git hooks directory.\n');
  await writeFile(join(ws, 'CLAUDE.local.md'), '# personal\n\nMy own scratch notes about branch naming.\n');
  await mkdir(join(ws, '.cursor', 'rules'), { recursive: true });
  await writeFile(join(ws, '.cursor', 'rules', 'style.mdc'), '---\nglobs: "src/**/*.ts"\n---\n# Style\n\nKeep every patch small and explained.\n');
  await mkdir(join(home, '.claude', 'commands'), { recursive: true });
  await writeFile(join(home, '.claude', 'commands', 'ft.md'), '---\ndescription: run the failing test\nargument-hint: "<path>"\n---\nRun $1 and explain the first failure.\n');

  return {
    ws,
    home,
    userDir: join(home, '.config', 'jevcode'),
    artifactDir: join(home, '.jevcode', 'imports', IMPORT_ID),
    env: { home, env: {}, platform: process.platform, workspace: ws, gitRoot: ws, extraRoots: [] },
  };
}

const destinationsOf = (f: Fixture): readonly string[] => [join(f.ws, 'AGENTS.md'), join(f.ws, '.jevcode'), f.userDir];

const render: ApplyOptions['render'] = async (row: PlanRow, sourceText: string) => ({
  text: sourceText,
  mode: row.scope === 'project-local' ? 0o600 : 0o644,
  warnings: [],
});

async function planFor(f: Fixture, manifest: ImportManifest | null) {
  return planImport({
    env: f.env,
    fs: nodeWriteFs(),
    clock,
    jevcodeVersion: '0.3.0',
    trust: 'trust',
    importId: IMPORT_ID,
    decider: null,
    manifest,
    destinations: destinationsOf(f),
  });
}

async function applyFor(f: Fixture, plan: Awaited<ReturnType<typeof planFor>>, manifest: ImportManifest | null) {
  return applyPlan({
    plan,
    fs: nodeWriteFs(),
    clock,
    destRoots: { project: f.ws, projectLocal: f.ws, user: f.userDir },
    artifactDir: f.artifactDir,
    lockPath: join(f.home, '.jevcode', 'imports', '.lock'),
    manifest,
    consent: 'tty',
    approved: applicableRows(plan),
    render,
    sourcePath: (row) => (row.source.display.startsWith('~/') ? join(f.home, row.source.display.slice(2)) : join(f.ws, row.source.display)),
  });
}

describe('§1 property 6 — the second run writes nothing (review follow-up D1)', () => {
  it('every row of a fresh import comes back skip:unchanged, not review', async () => {
    const f = await fixture();
    const first = await planFor(f, null);
    // the fixture really does exercise both shapes, or the regression could hide
    expect(first.rows.some((r) => r.action === 'append'), 'an appendable destination').toBe(true);
    expect(first.rows.filter((r) => r.action === 'create').length, 'several whole-file creates').toBeGreaterThanOrEqual(3);

    const applied = await applyFor(f, first, null);
    expect(applied.failed.map((x) => x.error)).toEqual([]);
    expect(applied.demoted.map((x) => x.why)).toEqual([]);

    const second = await planFor(f, applied.manifest);
    const changed = second.rows.filter((r) => r.action !== 'skip:unchanged' && !r.action.startsWith('skip:'));
    expect(changed.map((r) => `${r.dest ?? '—'} ${r.action} — ${r.why}`), 'nothing should be re-written or reviewed').toEqual([]);
    for (const r of second.rows.filter((x) => x.dest !== null)) {
      expect(r.action, `${r.dest} on the second run`).toBe('skip:unchanged');
    }
  });

  it('a second apply writes zero bytes and leaves every destination byte-identical', async () => {
    const f = await fixture();
    const first = await planFor(f, null);
    const applied = await applyFor(f, first, null);

    const paths = applied.applied.filter((a) => a.ok && a.dest !== null).map((a) => a.dest!);
    expect(paths.length).toBeGreaterThanOrEqual(4);
    const before = new Map(paths.map((p) => [p, readFileSync(p)] as const));

    const second = await planFor(f, applied.manifest);
    expect(applicableRows(second), 'nothing is applicable on a re-run').toEqual([]);
    const again = await applyFor(f, second, applied.manifest);
    expect(again.applied.filter((a) => a.ok && a.bytes > 0), 'zero bytes written').toEqual([]);

    for (const [p, bytes] of before) {
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p).equals(bytes), `${p} changed on the second run`).toBe(true);
    }
    // the personal note kept its 0600 through the no-op run
    const local = paths.find((p) => p.includes('memory-local'));
    if (local !== undefined) expect(statSync(local).mode & 0o777).toBe(0o600);
  });

  it('rerunAction decides a whole-file destination on its own sha, not on markers', () => {
    const entry = { importId: IMPORT_ID, dest: '.jevcode/memory/a.md', sourceSha256: 'a'.repeat(64), destSha256: 'd'.repeat(64), scope: 'project' as const, at: '', by: 'tty' as const };
    const common = { manifestEntry: entry, destExists: true, markers: [] as readonly string[], markerInteriorChanged: false, appendable: false };

    expect(rerunAction({ ...common, sourceSha256: 'a'.repeat(64), destSha256: 'd'.repeat(64) }).action).toBe('skip:unchanged');
    expect(rerunAction({ ...common, sourceSha256: 'b'.repeat(64), destSha256: 'd'.repeat(64) }).action).toBe('update');
    // the human edited the file we wrote: never silently overwrite it
    const edited = rerunAction({ ...common, sourceSha256: 'a'.repeat(64), destSha256: 'e'.repeat(64) });
    expect(edited.action).toBe('review');
    expect(edited.why).toMatch(/changed since/);

    // …and an APPENDABLE destination still demands its marker, because that is the only way to
    // know which bytes in a shared file are ours
    expect(rerunAction({ ...common, appendable: true, sourceSha256: 'a'.repeat(64), destSha256: 'd'.repeat(64) }).action).toBe('review');
  });
});
