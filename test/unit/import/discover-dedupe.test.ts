/**
 * import/discover.ts realpath identity (IMPORT-DESIGN §4.2.3; §6 row 8).
 *
 * One `AGENTS.md` found by five detectors must be **one** `SourceItem` with five `tools`, not five
 * rows — the report line is `AGENTS.md · read by codex, opencode, copilot, cursor, claude-code`.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../src/core/hash.js';
import { discover, nodeImportFs } from '../../../src/import/discover.js';
import type { ImportClock, ImportEnvironment } from '../../../src/import/types.js';

let tmp: string;
let home: string;
let repo: string;

const clock: ImportClock = { now: () => new Date('2026-09-21T12:00:00.000Z'), monotonicMs: () => 0 };

function envOf(): ImportEnvironment {
  return { home, env: {}, platform: 'darwin', workspace: repo, gitRoot: repo, extraRoots: [] };
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'jevcode-dedupe-')));
  home = join(tmp, 'home');
  repo = join(tmp, 'repo');
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('§6 row 8 — five detectors, one row', () => {
  it('one AGENTS.md is one SourceItem with tools of length 5', async () => {
    await write(join(repo, 'AGENTS.md'), '# Conventions\n\nUse pnpm.\n');
    const r = await discover({ env: envOf(), fs: nodeImportFs(), clock });
    const rows = r.items.filter((i) => i.realpath === join(repo, 'AGENTS.md'));
    expect(rows).toHaveLength(1);
    expect([...(rows[0]?.tools ?? [])].sort()).toEqual(['claude-code', 'codex', 'copilot', 'cursor', 'opencode']);
    expect(rows[0]?.artefact).toBe('claude.agents-file');
    expect(rows[0]?.id).toBe(sha256Hex(join(repo, 'AGENTS.md')).slice(0, 12));
    expect(rows[0]?.sha256).toBe(sha256Hex('# Conventions\n\nUse pnpm.\n'));
  });

  it('the union is by realpath, so a symlinked second name is still one row', async () => {
    await write(join(repo, 'AGENTS.md'), '# shared\n');
    await symlink(join(repo, 'AGENTS.md'), join(repo, 'CLAUDE.md'));
    const r = await discover({ env: envOf(), fs: nodeImportFs(), clock });
    const rows = r.items.filter((i) => i.realpath === join(repo, 'AGENTS.md'));
    expect(rows).toHaveLength(1);
    expect(r.items.filter((i) => i.realpath.endsWith('CLAUDE.md'))).toEqual([]);
  });

  it('two different files are never merged, however similar their names', async () => {
    await write(join(repo, 'AGENTS.md'), '# one\n');
    await write(join(repo, 'pkg', 'AGENTS.md'), '# two\n');
    const r = await discover({ env: envOf(), fs: nodeImportFs(), clock });
    const rows = r.items.filter((i) => i.realpath.endsWith('AGENTS.md'));
    expect(rows.map((i) => i.realpath).sort()).toEqual([join(repo, 'AGENTS.md'), join(repo, 'pkg', 'AGENTS.md')].sort());
    expect(new Set(rows.map((i) => i.id)).size).toBe(2);
  });

  it('the same realpath reached from two roots (workspace and git root) is still one row', async () => {
    await write(join(repo, 'pkg', 'AGENTS.md'), '# shared\n');
    const r = await discover({ env: { ...envOf(), workspace: join(repo, 'pkg'), gitRoot: repo }, fs: nodeImportFs(), clock });
    expect(r.items.filter((i) => i.realpath === join(repo, 'pkg', 'AGENTS.md'))).toHaveLength(1);
  });
});
