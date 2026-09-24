/**
 * Test-only fixtures for the undo / diff I/O tests (TUI-DESIGN §12.4, §12.6): a temp git repository with a real
 * `profile: 'none'` sandbox, and the engine's per-step image sequence (`writePreImages` → mutate → `writePostImages`).
 * No production module spawns git here except through `workspace/git.ts`; the fixture setup uses `spawnSync`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Sandbox } from '../../../src/core/types.js';
import { createSandbox } from '../../../src/sandbox/run.js';
import { writePostImages, writePreImages, type ImageSource, type PostImage } from '../../../src/checkpoint/images.js';

export interface TempRepo {
  base: string;
  /** realpath of the workspace */
  ws: string;
  runDir: string;
  sandbox: Sandbox;
  cleanup: () => void;
}

/** A temp directory with `ws/` (the workspace) and `run/` (the run dir) and a real, unsandboxed-profile sandbox over them. */
export function tempRepo(prefix = 'jev-undo-'): TempRepo {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const ws = join(base, 'ws');
  const runDir = join(base, 'run');
  mkdirSync(ws, { recursive: true });
  const sandbox = createSandbox({ workspaceRoot: ws, runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s }, { killTreeOptions: { graceMs: 300, pollMs: 25 }, ttyPath: null });
  return { base, ws, runDir, sandbox, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function write(root: string, rel: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** Fixture git (identity, no gpg, no global config); production git goes through workspace/git.ts only. */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: cwd, LC_ALL: 'C' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** `git init` + one commit of `files` on branch `main`. */
export function initRepo(ws: string, files: Record<string, string>): void {
  git(ws, 'init', '-q', '-b', 'main', '.');
  for (const [rel, c] of Object.entries(files)) write(ws, rel, c);
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'init');
}

export function headOid(ws: string): string {
  return git(ws, 'rev-parse', 'HEAD').trim();
}

export interface StepChangeOptions {
  source: ImageSource;
  /** tracked and unmodified at run start (default: every path) */
  cleanAtStart?: (rel: string) => boolean;
  /** the HEAD oid recorded on the post image (default: the repository's HEAD now; null for a non-git tree) */
  headOid?: string | null;
  at?: string;
}

/**
 * The engine's image sequence for one step (TUI-DESIGN §12.3): `writePreImages(targets)` → the step's own change
 * (`mutate`) → `writePostImages(changedFiles)`. Returns the post image as `/undo` will read it back.
 */
export async function stepChange(t: TempRepo, step: number, targets: readonly string[], mutate: () => void | Promise<void>, opts: StepChangeOptions, changedFiles: readonly string[] = targets): Promise<PostImage> {
  const pre = await writePreImages(t.runDir, step, targets, { root: t.ws, source: opts.source });
  await mutate();
  const head = opts.headOid === undefined ? tryHead(t.ws) : opts.headOid;
  const post = await writePostImages(t.runDir, step, changedFiles, {
    root: t.ws,
    source: opts.source,
    headOid: head,
    cleanAtStart: opts.cleanAtStart ?? (() => true),
    pre,
    at: opts.at ?? '2026-09-20T12:00:00.000Z',
    yieldBetweenChunks: () => Promise.resolve(),
  });
  return post.image;
}

function tryHead(ws: string): string | null {
  try {
    return headOid(ws);
  } catch {
    return null;
  }
}

/** A `Sandbox` that records every command it is asked to run and forwards to `inner`. */
export function recordingSandbox(inner: Sandbox): Sandbox & { commands: string[] } {
  const commands: string[] = [];
  return {
    level: inner.level,
    commands,
    run(command, o) {
      commands.push(command);
      return inner.run(command, o);
    },
    killAll: () => inner.killAll(),
  };
}
