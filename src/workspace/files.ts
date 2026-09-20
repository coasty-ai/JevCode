/**
 * The Workspace implementation (DESIGN.md §4, §8). Every path goes through resolveInside
 * and the secret-path rule; every write is atomic; changedFiles is computed against the
 * snapshot taken here so pre-existing dirty files are never attributed to the run.
 */
import { lstat, mkdir, open, readdir, stat } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

import { writeFileAtomic } from '../core/atomic.js';
import type { Action, Candidate, FileView, Sandbox, TargetInfo, TestCounts, TestRunner, Workspace, WorkspaceInfo } from '../core/types.js';
import { ConfigError, FileNotFoundError, JevCodeError } from '../errors.js';
import { assertNotSecret, canonicalPath, isSecretPath, resolveInside } from '../sandbox/paths.js';
import { createCandidateCache } from './candidates.js';
import { applyEditFile } from './edit.js';
import { gitDir, isRepo, lsFiles, lsFilesTracked, showPrefix, statusPorcelain } from './git.js';
import { applyPatch } from './patch.js';
import type { ManifestReader } from './tests.js';
import { detectTestCommand, parseTestOutput } from './tests.js';

export interface WorkspaceDeps {
  sandbox: Sandbox;
  /** absolute paths of the dotenv files and config file resolveConfig() consulted */
  secretPaths: readonly string[];
  redact: (s: string) => string;
  /** transcript warning sink (candidate cap); optional, not in the §4 contract */
  warn?: ((message: string) => void) | undefined;
}

const MANIFEST_MAX_BYTES = 256 * 1024;

function toPosix(rel: string): string {
  return sep === '/' ? rel : rel.split(sep).join(posix.sep);
}

function errCode(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code?: unknown }).code) : 'error';
}

/** Read at most `maxBytes` of a regular file without loading the rest. */
async function readHead(absPath: string, maxBytes: number): Promise<{ text: string; bytes: number; truncatedBytes: number }> {
  const fh = await open(absPath, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new JevCodeError('internal', `not a regular file`, { exitCode: 6 });
    const want = Math.min(st.size, maxBytes + 4);
    const buf = Buffer.alloc(want);
    let off = 0;
    while (off < want) {
      const { bytesRead } = await fh.read(buf, off, want - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    const data = buf.subarray(0, off);
    if (data.length <= maxBytes) return { text: data.toString('utf8'), bytes: st.size, truncatedBytes: Math.max(0, st.size - data.length) };
    let end = maxBytes;
    while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
    return { text: data.subarray(0, end).toString('utf8'), bytes: st.size, truncatedBytes: st.size - end };
  } finally {
    await fh.close();
  }
}

export async function createWorkspace(root: string, runDir: string, deps: WorkspaceDeps): Promise<Workspace> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
    if (!(await stat(realRoot)).isDirectory()) throw new ConfigError(`workspace "${root}" is not a directory`, { setting: 'workspace' });
  } catch (e) {
    if (e instanceof JevCodeError) throw e;
    throw new ConfigError(`workspace "${root}" is not accessible (${errCode(e)})`, { setting: 'workspace' });
  }
  await mkdir(join(runDir, 'tmp'), { recursive: true });

  // Secret paths are compared canonically so a symlinked dotenv is still refused.
  const secretCanon: string[] = [];
  for (const p of deps.secretPaths) {
    if (typeof p !== 'string' || p.length === 0) continue;
    secretCanon.push(resolve(p));
    try {
      secretCanon.push((await canonicalPath(resolve(p))).path);
    } catch {
      /* unreadable secret path: the lexical form still applies */
    }
  }
  const checkSecret = (rel: string, canonical: string): void => assertNotSecret(realRoot, rel, secretCanon, canonical);
  const isSecret = (rel: string, canonical: string): boolean => isSecretPath(realRoot, rel, secretCanon) || isSecretPath(realRoot, canonical, secretCanon);

  const relOf = (canonical: string): string => toPosix(relative(realRoot, canonical));

  async function resolveRel(p: string, mode: 'read' | 'write'): Promise<{ abs: string; rel: string }> {
    const abs = await resolveInside(realRoot, p, mode);
    const rel = relOf(abs);
    checkSecret(p, abs);
    if (rel.length > 0) checkSecret(rel, abs);
    return { abs, rel };
  }

  const git = await isRepo(deps.sandbox, realRoot);
  // A workspace that is a subdirectory of its repository: status paths come back relative to
  // the top level and cover the whole repository, so they are re-rooted here and anything
  // outside the workspace is dropped (it cannot have been the run's doing through us).
  const repoPrefix = git ? await showPrefix(deps.sandbox, realRoot) : '';
  const fromRepoPath = (p: string): string | null => (repoPrefix.length === 0 ? p : p.startsWith(repoPrefix) ? p.slice(repoPrefix.length) : null);
  // With a `gitdir:` pointer the real repository dir is an ordinary directory git lists as
  // untracked; it is never a candidate nor a change.
  let gitDirPrefix: string | null = null;
  if (git) {
    const gd = await gitDir(deps.sandbox, realRoot);
    if (gd !== null) {
      const rel = toPosix(relative(realRoot, resolve(realRoot, gd)));
      gitDirPrefix = rel.length > 0 && !rel.startsWith('..') ? rel : null;
    }
  }
  const inGitDir = (rel: string): boolean => rel === '.git' || rel.startsWith('.git/') || (gitDirPrefix !== null && (rel === gitDirPrefix || rel.startsWith(`${gitDirPrefix}/`)));

  // Snapshot for changedFiles(): what was already dirty before the run touched anything.
  const snapshotDirty = new Set<string>();
  if (git) {
    const s = await statusPorcelain(deps.sandbox, realRoot);
    for (const e of s.entries) {
      for (const raw of [e.path, e.from]) {
        const p = raw === undefined ? null : fromRepoPath(raw);
        if (p !== null && p.length > 0) snapshotDirty.add(p);
      }
    }
  }
  const externalChanges = async (): Promise<string[]> => {
    if (!git) return [];
    const s = await statusPorcelain(deps.sandbox, realRoot);
    const out: string[] = [];
    for (const e of s.entries) {
      for (const raw of [e.path, e.from]) {
        const p = raw === undefined ? null : fromRepoPath(raw);
        if (p !== null && p.length > 0 && !snapshotDirty.has(p) && !inGitDir(p)) out.push(p);
      }
    }
    return out;
  };
  /** paths written by file actions this run (the non-git source of truth) */
  const touched = new Set<string>();

  const candidates = createCandidateCache({
    root: realRoot,
    gitList: git
      ? async () => {
          const r = await lsFiles(deps.sandbox, realRoot);
          const paths = r.paths.filter((p) => !inGitDir(p));
          return paths.length > 0 || !r.truncated ? paths : null;
        }
      : null,
    resolveRead: async (rel) => {
      try {
        return await resolveInside(realRoot, rel, 'read');
      } catch {
        return null;
      }
    },
    isSecret,
    warn: deps.warn,
  });

  const manifests: ManifestReader = {
    async read(relPath) {
      try {
        const { abs } = await resolveRel(relPath, 'read');
        const st = await lstat(abs);
        if (!st.isFile()) return null;
        return (await readHead(abs, MANIFEST_MAX_BYTES)).text;
      } catch {
        return null;
      }
    },
    async list(relPath) {
      try {
        const { abs } = await resolveRel(relPath, 'read');
        return await readdir(abs);
      } catch {
        return null;
      }
    },
  };

  let infoCache: WorkspaceInfo | null = null;

  const workspace: Workspace = {
    root: realRoot,

    async info() {
      if (infoCache) return infoCache;
      const testCommand = await detectTestCommand(manifests);
      infoCache = { root: realRoot, git, hasTests: testCommand !== null, testCommand };
      return infoCache;
    },

    listCandidates(): Promise<Candidate[]> {
      return candidates.list();
    },

    invalidateCandidates(): Promise<void> {
      return candidates.invalidate();
    },

    async noteChanged(paths) {
      for (const p of paths) {
        const rel = toPosix(relative(realRoot, resolve(realRoot, p)));
        if (rel.length > 0 && !rel.startsWith('..')) touched.add(rel);
      }
      await candidates.noteChanged(paths);
    },

    async read(path, maxBytes): Promise<FileView> {
      const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 64 * 1024;
      const { abs, rel } = await resolveRel(path, 'read');
      try {
        const st = await lstat(abs);
        if (!st.isFile()) throw new JevCodeError('internal', `cannot read "${path}": not a regular file`, { exitCode: 6 });
        const head = await readHead(abs, limit);
        return { path: rel, content: deps.redact(head.text), bytes: head.bytes, truncatedBytes: head.truncatedBytes };
      } catch (e) {
        if (e instanceof JevCodeError) throw e;
        if (errCode(e) === 'ENOENT') throw new FileNotFoundError(path, { cause: e });
        throw new JevCodeError('internal', `cannot read "${path}" (${errCode(e)})`, { exitCode: 6, cause: e });
      }
    },

    async applyEdit(a: Extract<Action, { kind: 'edit' }>) {
      const { abs, rel } = await resolveRel(a.path, 'write');
      await applyEditFile(abs, { path: rel, old: a.old, new: a.new });
      await workspace.noteChanged([rel]);
      return { changedFiles: [rel] };
    },

    async writeFile(a: Extract<Action, { kind: 'write' }>) {
      if (typeof a.content !== 'string') throw new JevCodeError('internal', `write "${a.path}": content must be a string`, { exitCode: 6 });
      const { abs, rel } = await resolveRel(a.path, 'write');
      let created = true;
      try {
        const st = await lstat(abs);
        created = false;
        if (!st.isFile()) throw new JevCodeError('internal', `cannot write "${a.path}": not a regular file`, { exitCode: 6 });
      } catch (e) {
        if (e instanceof JevCodeError) throw e;
        if (errCode(e) !== 'ENOENT') throw new JevCodeError('internal', `cannot write "${a.path}" (${errCode(e)})`, { exitCode: 6, cause: e });
      }
      // Parent directories are inside the workspace by construction (abs passed resolveInside).
      await mkdir(dirname(abs), { recursive: true });
      await writeFileAtomic(abs, a.content);
      await workspace.noteChanged([rel]);
      return { changedFiles: [rel], created };
    },

    async applyPatch(diff) {
      const r = await applyPatch(diff, { sandbox: deps.sandbox, ws: realRoot, runDir, assertNotSecret: checkSecret, plainApply: repoPrefix.length > 0 });
      await workspace.noteChanged(r.changedFiles);
      return r;
    },

    parseTestOutput(runner: TestRunner, output: string): TestCounts | null {
      return parseTestOutput(runner, output);
    },

    async changedFiles() {
      const out = new Set<string>(touched);
      for (const p of await externalChanges()) out.add(p);
      return [...out].sort();
    },

    async target(path, createdThisRun): Promise<TargetInfo> {
      const { abs, rel } = await resolveRel(path, 'read');
      let existsBefore = false;
      try {
        existsBefore = (await lstat(abs)).isFile();
      } catch {
        existsBefore = false;
      }
      const tracked = git && existsBefore ? await lsFilesTracked(deps.sandbox, realRoot, rel) : false;
      const created = createdThisRun.has(rel) || createdThisRun.has(path);
      return { path: rel, existsBefore, tracked, createdThisRun: created, recoverable: tracked || created };
    },
  };
  return workspace;
}
