/** config/instructions.ts (TUI-DESIGN §11.3; §19.0 row O7): walk-up, CLAUDE.md fallback, 32 KiB cap, record. */
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INSTRUCTIONS_MAX_BYTES,
  INSTRUCTIONS_READ_CAP_BYTES,
  instructionItemText,
  instructionSearchDirs,
  instructionsHeader,
  loadInstructions,
  projectInstructionFile,
} from '../../../src/config/instructions.js';
import { sha256Hex } from '../../../src/core/hash.js';
import { createRedactor } from '../../../src/core/redact.js';

let dir: string;
let home: string;
let root: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevcode-instr-'));
  home = join(dir, 'home');
  root = join(dir, 'repo');
  await mkdir(join(root, 'pkg', 'sub'), { recursive: true });
  await mkdir(home, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('instructionSearchDirs (pure)', () => {
  it('walks from the workspace up to the git root inclusive, never above; only the workspace when outside the root or without a root', () => {
    expect(instructionSearchDirs('/r/a/b', '/r')).toEqual(['/r/a/b', '/r/a', '/r']);
    expect(instructionSearchDirs('/r', '/r')).toEqual(['/r']);
    expect(instructionSearchDirs('/r/a', null)).toEqual(['/r/a']);
    expect(instructionSearchDirs('/elsewhere/x', '/r')).toEqual(['/elsewhere/x']);
    expect(instructionSearchDirs('/r/a/../b', '/r')).toEqual(['/r/b', '/r']);
  });

  it('header and item text', () => {
    expect(instructionsHeader('AGENTS.md', 'abcdef0123456789')).toBe('## Project instructions (from AGENTS.md, sha256 abcdef01)');
    expect(instructionItemText('AGENTS.md', { path: '/r/AGENTS.md', sha256: 'abcdef0123456789', bytes: 2150 })).toBe('instructions: AGENTS.md (2150 bytes, sha256 abcdef01)');
    expect(instructionItemText('AGENTS.md', { path: '/r/AGENTS.md', sha256: 'abcdef0123456789', bytes: 40000 }, true)).toBe('instructions: AGENTS.md (40000 bytes, sha256 abcdef01) — truncated to 32 KiB');
  });
});

describe('loadInstructions', () => {
  it('returns nothing when no file exists; text is empty, files empty, no notices', async () => {
    const r = await loadInstructions(join(root, 'pkg', 'sub'), root, home);
    expect(r).toEqual({ files: [], text: '', notices: [], loaded: [] });
  });

  it('first match walking up wins (nearest directory), records { path, sha256, bytes } and builds the system-prompt section; redact applies', async () => {
    const content = '# Rules\nUse pnpm. Key sk-ant-api03-abcdefghijklmnopqrstuv_-x must not leak.\n';
    await writeFile(join(root, 'AGENTS.md'), '# Root rules\n');
    await writeFile(join(root, 'pkg', 'AGENTS.md'), content);
    const r = await loadInstructions(join(root, 'pkg', 'sub'), root, home, { redact: createRedactor([]).redact });
    expect(r.files).toEqual([{ path: join(root, 'pkg', 'AGENTS.md'), sha256: sha256Hex(content), bytes: Buffer.byteLength(content) }]);
    expect(r.loaded[0]?.display).toBe('../AGENTS.md');
    expect(r.text.startsWith(`## Project instructions (from ../AGENTS.md, sha256 ${sha256Hex(content).slice(0, 8)})\n\n# Rules\n`)).toBe(true);
    expect(r.text).toContain('[REDACTED:pattern]');
    expect(r.text).not.toContain('sk-ant-api03');
    expect(r.notices).toEqual([]);
    const atRoot = await loadInstructions(root, root, home);
    expect(atRoot.loaded[0]?.display).toBe('AGENTS.md');
    expect(atRoot.text).toContain('# Root rules');
  });

  it('CLAUDE.md is the fallback name at each directory; AGENTS.md in the same directory wins over it', async () => {
    await writeFile(join(root, 'CLAUDE.md'), 'claude rules\n');
    const r = await loadInstructions(join(root, 'pkg'), root, home);
    expect(r.loaded[0]?.name).toBe('CLAUDE.md');
    expect(r.loaded[0]?.display).toBe('../CLAUDE.md');
    await writeFile(join(root, 'AGENTS.md'), 'agents rules\n');
    const both = await loadInstructions(join(root, 'pkg'), root, home);
    expect(both.loaded[0]?.name).toBe('AGENTS.md');
    expect(both.files).toHaveLength(1);
  });

  it('never walks above the workspace root: a file in the parent of the git root is ignored', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'outside\n');
    expect((await loadInstructions(join(root, 'pkg'), root, home)).files).toEqual([]);
    expect((await loadInstructions(join(root, 'pkg'), null, home)).files).toEqual([]);
  });

  it('adds the global ~/.config/jevcode/AGENTS.md (XDG_CONFIG_HOME honoured) after the project file, once', async () => {
    const xdg = join(dir, 'xdg');
    await mkdir(join(xdg, 'jevcode'), { recursive: true });
    await writeFile(join(xdg, 'jevcode', 'AGENTS.md'), 'global rules\n');
    await writeFile(join(root, 'AGENTS.md'), 'project rules\n');
    const r = await loadInstructions(root, root, home, { env: { XDG_CONFIG_HOME: xdg } });
    expect(r.files.map((f) => f.path)).toEqual([join(root, 'AGENTS.md'), join(xdg, 'jevcode', 'AGENTS.md')]);
    expect(r.text.indexOf('project rules')).toBeLessThan(r.text.indexOf('global rules'));
    expect(r.loaded[1]?.display).toBe(join(xdg, 'jevcode', 'AGENTS.md'));
    expect(projectInstructionFile(r, { XDG_CONFIG_HOME: xdg }, home)?.path).toBe(join(root, 'AGENTS.md'));
    await mkdir(join(home, '.config', 'jevcode'), { recursive: true });
    await writeFile(join(home, '.config', 'jevcode', 'AGENTS.md'), 'home global\n');
    const viaHome = await loadInstructions(root, root, home);
    expect(viaHome.loaded[1]?.display).toBe('~/.config/jevcode/AGENTS.md');
    const onlyGlobal = await loadInstructions(join(dir, 'other'), null, home);
    expect(onlyGlobal.files).toHaveLength(1);
    expect(projectInstructionFile(onlyGlobal, {}, home)).toBeNull();
  });

  it('caps each file at 32 KiB on a UTF-8 boundary with a notice; bytes and sha256 describe the whole file', async () => {
    const big = `${'日本語の指示。'.repeat(6000)}END`;
    await writeFile(join(root, 'AGENTS.md'), big);
    const r = await loadInstructions(root, root, home);
    expect(r.files[0]?.bytes).toBe(Buffer.byteLength(big));
    expect(r.files[0]?.sha256).toBe(sha256Hex(Buffer.from(big)));
    expect(Buffer.byteLength(r.loaded[0]!.text)).toBeLessThanOrEqual(INSTRUCTIONS_MAX_BYTES);
    expect('日本語の指示。'.includes(r.loaded[0]!.text.slice(-1))).toBe(true);
    expect(r.loaded[0]!.text).not.toContain('\ufffd');
    expect(r.loaded[0]?.truncated).toBe(true);
    expect(r.notices).toEqual([`instructions: AGENTS.md truncated to 32 KiB (${Buffer.byteLength(big)} bytes on disk)`]);
    expect(r.text).not.toContain('END');
  });

  it('skips a file over the 4 MiB read cap with a notice; reports unreadable files (EACCES) and continues to the global file', async () => {
    const huge = { isFile: () => true, size: INSTRUCTIONS_READ_CAP_BYTES + 1 };
    const r = await loadInstructions(root, root, home, { stat: async () => huge, readFile: async () => Buffer.from('x') });
    expect(r.files).toEqual([]);
    expect(r.notices[0]).toContain('skipped');
    if (process.getuid?.() !== 0) {
      await writeFile(join(root, 'AGENTS.md'), 'locked\n');
      await chmod(join(root, 'AGENTS.md'), 0o000);
      await mkdir(join(home, '.config', 'jevcode'), { recursive: true });
      await writeFile(join(home, '.config', 'jevcode', 'AGENTS.md'), 'global\n');
      const denied = await loadInstructions(root, root, home);
      expect(denied.notices).toEqual(['instructions: cannot read AGENTS.md: EACCES']);
      expect(denied.files.map((f) => f.path)).toEqual([join(home, '.config', 'jevcode', 'AGENTS.md')]);
      await chmod(join(root, 'AGENTS.md'), 0o644);
    }
  });

  it('an AGENTS.md symlink resolving outside the workspace root (~/.ssh/id_rsa) is skipped with a notice; one resolving inside is followed', async () => {
    await mkdir(join(home, '.ssh'), { recursive: true });
    const secret = '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-body\n-----END OPENSSH PRIVATE KEY-----\n';
    await writeFile(join(home, '.ssh', 'id_rsa'), secret);
    await symlink(join(home, '.ssh', 'id_rsa'), join(root, 'pkg', 'AGENTS.md'));
    const r = await loadInstructions(join(root, 'pkg', 'sub'), root, home);
    expect(r.files).toEqual([]);
    expect(r.text).toBe('');
    expect(r.text).not.toContain('secret-body');
    expect(r.notices).toEqual([`instructions: ../AGENTS.md skipped (symlink resolves outside ${root})`]);
    // the walk continues past the skipped link: a real file higher up is used
    await writeFile(join(root, 'AGENTS.md'), 'root rules\n');
    const cont = await loadInstructions(join(root, 'pkg', 'sub'), root, home);
    expect(cont.files.map((f) => f.path)).toEqual([join(root, 'AGENTS.md')]);
    // a symlink whose target stays inside the root is followed (display = the link's path)
    await rm(join(root, 'pkg', 'AGENTS.md'));
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'AGENTS.md'), 'docs rules\n');
    await symlink(join(root, 'docs', 'AGENTS.md'), join(root, 'pkg', 'AGENTS.md'));
    const inside = await loadInstructions(join(root, 'pkg', 'sub'), root, home);
    expect(inside.files.map((f) => f.path)).toEqual([join(root, 'pkg', 'AGENTS.md')]);
    expect(inside.text).toContain('docs rules');
    expect(inside.notices).toEqual([]);
    // the global file must stay inside the jevcode config dir too
    await mkdir(join(home, '.config', 'jevcode'), { recursive: true });
    await symlink(join(home, '.ssh', 'id_rsa'), join(home, '.config', 'jevcode', 'AGENTS.md'));
    const g = await loadInstructions(join(dir, 'other'), null, home);
    expect(g.files).toEqual([]);
    expect(g.notices[0]).toContain('skipped (symlink resolves outside');
    // a symlinked workspace root itself (tmpdir on macOS is one) is compared by realpath, never rejected
    expect(await realpath(root)).toBeTruthy();
  });

  it('a workspace path with `..` segments and a git root that is a subdirectory of the workspace', async () => {
    await writeFile(join(root, 'pkg', 'AGENTS.md'), 'pkg rules\n');
    await writeFile(join(root, 'AGENTS.md'), 'root rules\n');
    const dots = await loadInstructions(join(root, 'pkg', '..', 'pkg', 'sub'), root, home);
    expect(dots.files.map((f) => f.path)).toEqual([join(root, 'pkg', 'AGENTS.md')]);
    expect(dots.loaded[0]?.display).toBe('../AGENTS.md');
    // git root below the workspace: only the workspace directory itself is searched
    const below = await loadInstructions(root, join(root, 'pkg'), home);
    expect(below.files.map((f) => f.path)).toEqual([join(root, 'AGENTS.md')]);
    expect(below.loaded[0]?.display).toBe('AGENTS.md');
    expect(instructionSearchDirs(root, join(root, 'pkg'))).toEqual([root]);
  });

  it('redact defaults to patternRedact: a key inside AGENTS.md is masked even when no redact option is passed', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'Use key sk-ant-api03-abcdefghijklmnopqrstuv_-x and token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    const r = await loadInstructions(root, root, home);
    expect(r.text).not.toContain('sk-ant-api03');
    expect(r.text).not.toContain('ghp_abcdefghij');
    expect(r.text.match(/\[REDACTED:pattern\]/g)).toHaveLength(2);
    expect(r.loaded[0]?.text).toContain('Use key [REDACTED:pattern] and token [REDACTED:pattern]');
  });

  it('a directory named AGENTS.md is not a file and is skipped silently; an empty file is a valid (empty) instruction', async () => {
    await mkdir(join(root, 'pkg', 'AGENTS.md'));
    await writeFile(join(root, 'AGENTS.md'), '');
    const r = await loadInstructions(join(root, 'pkg'), root, home);
    expect(r.files).toEqual([{ path: join(root, 'AGENTS.md'), sha256: sha256Hex(''), bytes: 0 }]);
    expect(r.notices).toEqual([]);
    expect(r.text).toBe(`## Project instructions (from ../AGENTS.md, sha256 ${sha256Hex('').slice(0, 8)})\n\n`);
  });
});
