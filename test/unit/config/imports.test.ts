/**
 * TUI-DESIGN-5 §10 (R5-5 `config/imports.test.ts`): the tolerant `v: 0` reader upgrades **in memory** and does
 * not rewrite (§7 row 54's sibling, IMPORT-DESIGN row 70), plus the [G1.3] per-workspace keying, the [G1.4]
 * retention rule and the 0600 / 0700 write discipline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImportManifest, ImportManifestEntry } from '../../../src/core/types.js';
import {
  IMPORTS_KEEP,
  IMPORT_MANIFEST_FILE_NAME,
  emptyImportManifest,
  gcImportRecords,
  importArtifactDir,
  importDestinations,
  importManifestPath,
  importsRoot,
  listImportRecords,
  mergeManifestEntries,
  readImportManifest,
  referencedImportIds,
  retentionVictims,
  upgradeImportManifest,
  writeImportManifest,
} from '../../../src/config/imports.js';

const WS = '/ws';
let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevcode-imports-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(over: Partial<ImportManifestEntry> = {}): ImportManifestEntry {
  return { importId: 'imp_20260921T120000Z_a1b2c3', dest: '.jevcode/memory/MEMORY.md', sourceSha256: 'aa', destSha256: 'bb', scope: 'project', at: '2026-09-21T12:00:00.000Z', by: 'tty', ...over };
}

describe('paths', () => {
  it('are `<jevcodeDir>/imports/{manifest.json,<importId>}`', () => {
    expect(importsRoot('/h/.jevcode')).toBe('/h/.jevcode/imports');
    expect(importManifestPath('/h/.jevcode')).toBe(`/h/.jevcode/imports/${IMPORT_MANIFEST_FILE_NAME}`);
    expect(importArtifactDir('/h/.jevcode', 'imp_20260921T120000Z_a1b2c3')).toBe('/h/.jevcode/imports/imp_20260921T120000Z_a1b2c3');
  });
});

describe('the tolerant reader (IMPORT-DESIGN row 70)', () => {
  it('a missing file is an empty manifest, no error, nothing written', async () => {
    const path = importManifestPath(dir);
    const r = await readImportManifest(path, WS);
    expect(r.found).toBe(false);
    expect(r.error).toBeNull();
    expect(r.upgraded).toBe(false);
    expect(r.manifest).toEqual(emptyImportManifest());
    expect(existsSync(path)).toBe(false);
  });

  it('a `v: 0` manifest upgrades IN MEMORY — the file on disk is byte-identical afterwards', async () => {
    const path = importManifestPath(dir);
    await mkdir(importsRoot(dir), { recursive: true });
    // the pre-[G1.3] shape: one flat `entries` array against repo-relative destinations
    const before = JSON.stringify(
      {
        v: 0,
        entries: [
          { importId: 'imp_20260101T000000Z_aaaaaa', dest: '.jevcode/memory/MEMORY.md', sourceSha256: 'a1', destSha256: 'b1', scope: 'project', at: '2026-01-01T00:00:00.000Z', by: 'tty' },
          { importId: 'imp_20260101T000000Z_aaaaaa', dest: 'commands/x.md', sourceSha256: 'a2', destSha256: 'b2', scope: 'user', at: '2026-01-01T00:00:00.000Z', by: 'tty' },
        ],
      },
      null,
      2,
    );
    await writeFile(path, before, 'utf8');

    const r = await readImportManifest(path, WS);
    expect(r.found).toBe(true);
    expect(r.upgraded).toBe(true);
    expect(r.error).toBeNull();
    expect(r.manifest.v).toBe(1);
    expect(r.manifest.user.map((e) => e.dest)).toEqual(['commands/x.md']);
    expect(r.manifest.workspaces[WS]?.map((e) => e.dest)).toEqual(['.jevcode/memory/MEMORY.md']);
    // row 70: nothing is rewritten until the next successful apply
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('a `v: 1` manifest is read as-is and is not flagged as upgraded', async () => {
    const path = importManifestPath(dir);
    const m: ImportManifest = { v: 1, user: [entry({ scope: 'user', dest: 'u.md' })], workspaces: { [WS]: [entry()] }, lastRun: 'imp_20260921T120000Z_a1b2c3' };
    await mkdir(importsRoot(dir), { recursive: true });
    await writeFile(path, JSON.stringify(m), 'utf8');
    const r = await readImportManifest(path, WS);
    expect(r.upgraded).toBe(false);
    expect(r.manifest.user).toHaveLength(1);
    expect(r.manifest.workspaces[WS]).toHaveLength(1);
    expect(r.manifest.lastRun).toBe('imp_20260921T120000Z_a1b2c3');
  });

  it('a malformed file reads as empty with a reason — an import is never refused by a corrupt bookkeeping file', async () => {
    const path = importManifestPath(dir);
    await mkdir(importsRoot(dir), { recursive: true });
    await writeFile(path, '{ this is not json', 'utf8');
    const r = await readImportManifest(path, WS);
    expect(r.found).toBe(true);
    expect(r.error).not.toBeNull();
    expect(r.manifest).toEqual(emptyImportManifest());
  });

  it('drops rows that are not entries and coerces an unknown `scope` / `by` rather than throwing', () => {
    const { manifest, upgraded } = upgradeImportManifest({ v: 1, user: [{ importId: 'x', dest: 'd', scope: 'nonsense', by: 'nonsense' }, 7, { dest: 'no-id' }, null], workspaces: {} }, WS);
    expect(upgraded).toBe(false);
    expect(manifest.user).toHaveLength(1);
    expect(manifest.user[0]?.scope).toBe('project');
    expect(manifest.user[0]?.by).toBe('tty');
  });

  it('a non-object root, an array and a future `v` all read as empty', () => {
    expect(upgradeImportManifest(null, WS).manifest).toEqual(emptyImportManifest());
    expect(upgradeImportManifest([1, 2], WS).manifest).toEqual(emptyImportManifest());
    expect(upgradeImportManifest({ v: 99 }, WS).manifest).toEqual(emptyImportManifest());
  });

  it('an unknown FUTURE `v` is never flagged for rewrite — a newer client’s manifest is not ours to overwrite', () => {
    for (const v of [2, 99, '1', true]) {
      const r = upgradeImportManifest({ v, entries: [{ importId: 'imp_20260101T000000Z_aaaaaa', dest: 'x.md' }] } as never, WS);
      // `upgraded: true` means "write it back at the next successful apply", which would destroy the newer
      // client's record of what it wrote — and with it the only source its `--undo` can restore from
      expect(r.upgraded, String(v)).toBe(false);
      expect(r.future, String(v)).toBe(true);
      expect(r.manifest, String(v)).toEqual(emptyImportManifest());
    }
    // a `v: 0` / version-less document is still LIFTED (and flagged), which is what row 70 asks for
    expect(upgradeImportManifest({ v: 0, entries: [{ importId: 'imp_20260101T000000Z_aaaaaa', dest: 'x.md' }] }, WS).upgraded).toBe(true);
    expect(upgradeImportManifest({ v: 0 }, WS).future).toBe(false);
  });

  it('`readImportManifest` carries the same two flags', async () => {
    const path = importManifestPath(dir);
    await mkdir(importsRoot(dir), { recursive: true });
    await writeFile(path, JSON.stringify({ v: 99 }), 'utf8');
    const r = await readImportManifest(path, WS);
    expect(r.found).toBe(true);
    expect(r.upgraded).toBe(false);
    expect(r.future).toBe(true);
    expect(r.error).toBeNull();
  });
});

describe('merge and destinations ([G1.3])', () => {
  it('is keyed by workspace — a second clone of the same repo is not already-imported', () => {
    const a = mergeManifestEntries(emptyImportManifest(), '/clone-a', [entry({ dest: 'm.md' })]);
    expect(importDestinations(a, '/clone-a')).toEqual(['m.md']);
    expect(importDestinations(a, '/clone-b')).toEqual([]);
  });

  it('a second write to the same destination replaces the entry, never appends a second one', () => {
    const a = mergeManifestEntries(emptyImportManifest(), WS, [entry({ destSha256: 'first' })]);
    const b = mergeManifestEntries(a, WS, [entry({ destSha256: 'second', importId: 'imp_20260922T120000Z_bbbbbb' })]);
    expect(b.workspaces[WS]).toHaveLength(1);
    expect(b.workspaces[WS]?.[0]?.destSha256).toBe('second');
    expect(b.lastRun).toBe('imp_20260922T120000Z_bbbbbb');
  });

  it('a user-scope row goes to `user`, never to a workspace bucket', () => {
    const m = mergeManifestEntries(emptyImportManifest(), WS, [entry({ scope: 'user', dest: '~/x.md' }), entry({ dest: 'p.md' })]);
    expect(m.user.map((e) => e.dest)).toEqual(['~/x.md']);
    expect(m.workspaces[WS]?.map((e) => e.dest)).toEqual(['p.md']);
    expect([...importDestinations(m, WS)].sort()).toEqual(['p.md', '~/x.md']);
  });
});

describe('retention ([G1.4])', () => {
  it('keeps the newest `IMPORTS_KEEP` and never an id the manifest still references', () => {
    const ids = Array.from({ length: 14 }, (_, i) => `imp_202601${String(i + 1).padStart(2, '0')}T000000Z_aaaaaa`);
    const manifest = mergeManifestEntries(emptyImportManifest(), WS, [entry({ importId: ids[0]! })]);
    expect(referencedImportIds(manifest).has(ids[0]!)).toBe(true);
    const victims = retentionVictims(ids, manifest, IMPORTS_KEEP);
    // the survivor set is (the newest 10) ∪ (everything referenced); a referenced id does not consume a slot
    expect(victims).not.toContain(ids[0]); // referenced: its `pre/` is the undo source
    expect(victims).toEqual([ids[1], ids[2], ids[3]]);
    expect(ids.length - victims.length).toBe(IMPORTS_KEEP + 1);
  });

  it('removes nothing when there is room', () => {
    const ids = ['imp_20260101T000000Z_aaaaaa', 'imp_20260102T000000Z_aaaaaa'];
    expect(retentionVictims(ids, emptyImportManifest(), 10)).toEqual([]);
  });

  it('`gcImportRecords` removes exactly the victims and survives a missing root', async () => {
    const root = importsRoot(dir);
    const ids = Array.from({ length: 12 }, (_, i) => `imp_202601${String(i + 1).padStart(2, '0')}T000000Z_aaaaaa`);
    for (const id of ids) await mkdir(join(root, id), { recursive: true });
    await mkdir(join(root, 'not-an-import'), { recursive: true });
    expect(await listImportRecords(root)).toHaveLength(12);
    const gone = await gcImportRecords(root, emptyImportManifest(), IMPORTS_KEEP);
    expect(gone).toEqual([ids[0], ids[1]]);
    expect(await listImportRecords(root)).toHaveLength(10);
    expect(existsSync(join(root, 'not-an-import'))).toBe(true);
    expect(await gcImportRecords(join(dir, 'nope'), emptyImportManifest())).toEqual([]);
  });
});

describe('the write', () => {
  it('repairs a loose file (0644) and a loose dir (0755) it finds in place, and never lands a loose temp file', async () => {
    const path = importManifestPath(dir);
    const root = importsRoot(dir);
    await mkdir(root, { recursive: true, mode: 0o755 });
    await chmod(root, 0o755);
    await writeFile(path, '{}', { mode: 0o644 });
    await chmod(path, 0o644);
    const m = mergeManifestEntries(emptyImportManifest(), WS, [entry()]);
    await writeImportManifest(path, m);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    // the atomic write leaves nothing behind, at any mode
    const left = (await readdir(root)).filter((n) => n !== IMPORT_MANIFEST_FILE_NAME);
    expect(left).toEqual([]);
    expect((await readImportManifest(path, WS)).manifest).toEqual(m);
  });

  it('creates `imports/` at 0700, writes `manifest.json` at 0600 and round-trips', async () => {
    const path = importManifestPath(dir);
    const m = mergeManifestEntries(emptyImportManifest(), WS, [entry()]);
    await writeImportManifest(path, m);
    const fileMode = (await stat(path)).mode & 0o777;
    const dirMode = (await stat(importsRoot(dir))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
    const back = await readImportManifest(path, WS);
    expect(back.upgraded).toBe(false);
    expect(back.manifest).toEqual(m);
  });
});
