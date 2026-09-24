/**
 * The Workspace implementation (DESIGN.md §4, §8). Every path goes through resolveInside
 * and the secret-path rule; every write is atomic; changedFiles is computed against the
 * snapshot taken here so pre-existing dirty files are never attributed to the run.
 *
 * TUI-DESIGN §12.1: given the run-start `GitState` (probed by `createEngine` before the sandbox
 * exists) the constructor performs zero spawns — the probe's `repo`/`prefix`/`gitDir`/`dirty.entries`
 * replace `isRepo`/`showPrefix`/`gitDir`/`statusPorcelain`. Without one it probes through the
 * sandbox exactly as before (bench and tests).
 */
import { lstat, mkdir, open, readdir, stat } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

import { writeFileAtomic } from '../core/atomic.js';
import type { Action, Candidate, FileView, GitState, Sandbox, TargetInfo, TestCounts, TestRunner, Workspace, WorkspaceInfo } from '../core/types.js';
import { ConfigError, FileNotFoundError, JevCodeError } from '../errors.js';
import { assertNotSecret, canonicalPath, isMentionDenied, isSecretPath, resolveInside } from '../sandbox/paths.js';
import { MAX_LIST_ENTRIES, createCandidateCache, underSkippedDir, walkTree } from './candidates.js';
import { applyEditFile } from './edit.js';
import { gitDir, isRepo, lsFiles, lsFilesTracked, showPrefix, statusPorcelain, statusV1ToDirty } from './git.js';
import type { StatusEntry } from './git.js';
import { readHead as readHeadFile } from './gitstate.js';
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
  /** TUI-DESIGN §12.1 / §15 item 8: the run-start probe; when given, createWorkspace performs zero spawns */
  gitState?: GitState;
}

/** TUI-DESIGN §5.4: options of the standalone pre-run walker. */
export interface ListCandidatesOptions {
  /** absolute paths of the dotenv files and config file resolveConfig() consulted */
  secretPaths: readonly string[];
  /** a path that the redactor would alter carries a secret in its name and is never offered */
  redact: (s: string) => string;
  /** walk cap (default MAX_LIST_ENTRIES); files beyond it are not offered */
  max?: number;
  warn?: ((message: string) => void) | undefined;
}

const MANIFEST_MAX_BYTES = 256 * 1024;
/** TUI-DESIGN §10.4: `workspace.readSecretForMention(rel, 16_384)` — the default and the ceiling of one attached secret file. */
export const MENTION_MAX_BYTES = 16 * 1024;

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

/** realpath(root), or ConfigError when it is missing or not a directory. */
async function realWorkspaceRoot(root: string): Promise<string> {
  try {
    const realRoot = await realpath(root);
    if (!(await stat(realRoot)).isDirectory()) throw new ConfigError(`workspace "${root}" is not a directory`, { setting: 'workspace' });
    return realRoot;
  } catch (e) {
    if (e instanceof JevCodeError) throw e;
    throw new ConfigError(`workspace "${root}" is not accessible (${errCode(e)})`, { setting: 'workspace' });
  }
}

/** Secret paths are compared canonically so a symlinked dotenv is still refused; the lexical form stays too. */
async function canonicalSecretPaths(secretPaths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of secretPaths) {
    if (typeof p !== 'string' || p.length === 0) continue;
    out.push(resolve(p));
    try {
      out.push((await canonicalPath(resolve(p))).path);
    } catch {
      /* unreadable secret path: the lexical form still applies */
    }
  }
  return out;
}

/**
 * TUI-DESIGN §5.4 (A35, A157): the `@` candidate list before the first run — the readdir walker alone,
 * without a run dir, a `Sandbox` or the git snapshot (none exist before `createEngine`). Same
 * exclusions as the in-run listing (symlinks, binaries, > 1 MiB, secret paths) plus the `@` denylist
 * (`isMentionDenied`: `/credential/i`, `.npmrc`, `.pypirc`, key stores, `.git/`) and any path the
 * redactor would alter. Sorted; ≤ `max` walked entries. Throws ConfigError for a missing root.
 */
export async function listCandidates(root: string, o: ListCandidatesOptions): Promise<readonly Candidate[]> {
  const realRoot = await realWorkspaceRoot(root);
  const secretCanon = await canonicalSecretPaths(o.secretPaths);
  const max = typeof o.max === 'number' && Number.isFinite(o.max) && o.max > 0 ? Math.floor(o.max) : MAX_LIST_ENTRIES;
  const warn = o.warn;
  const cache = createCandidateCache({
    root: realRoot,
    // the walk stands in for `git ls-files`; the cache's inspect() applies the symlink/size/binary rules
    gitList: async () => walkTree(realRoot, warn, max),
    resolveRead: async (rel) => {
      try {
        return await resolveInside(realRoot, rel, 'read');
      } catch {
        return null;
      }
    },
    isSecret: (rel, canonical) => isMentionDenied(realRoot, rel, secretCanon) || isSecretPath(realRoot, canonical, secretCanon),
    warn,
  });
  const listed = await cache.list();
  return listed.filter((c) => o.redact(c.path) === c.path);
}

export async function createWorkspace(root: string, runDir: string, deps: WorkspaceDeps): Promise<Workspace> {
  const realRoot = await realWorkspaceRoot(root);
  await mkdir(join(runDir, 'tmp'), { recursive: true });

  const secretCanon = await canonicalSecretPaths(deps.secretPaths);
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

  // TUI-DESIGN §12.1: the probe replaces the four run-start spawns below when it is given.
  const probe = deps.gitState ?? null;
  /** the probe with `dirty` refreshed by every invalidateCandidates() status refresh (§12.2: zero spawns to read) */
  let gitStateCurrent: GitState | null = probe;
  const git = probe !== null ? probe.repo : await isRepo(deps.sandbox, realRoot);
  // A workspace that is a subdirectory of its repository: status paths come back relative to
  // the top level and cover the whole repository, so they are re-rooted here and anything
  // outside the workspace is dropped (it cannot have been the run's doing through us).
  const repoPrefix = probe !== null ? probe.prefix : git ? await showPrefix(deps.sandbox, realRoot) : '';
  const fromRepoPath = (p: string): string | null => (repoPrefix.length === 0 ? p : p.startsWith(repoPrefix) ? p.slice(repoPrefix.length) : null);
  // With a `gitdir:` pointer the real repository dir is an ordinary directory git lists as
  // untracked; it is never a candidate nor a change.
  let gitDirPrefix: string | null = null;
  if (git) {
    const gd = probe !== null ? probe.gitDir : await gitDir(deps.sandbox, realRoot);
    if (gd !== null) {
      const rel = toPosix(relative(realRoot, resolve(realRoot, gd)));
      gitDirPrefix = rel.length > 0 && !rel.startsWith('..') ? rel : null;
    }
  }
  const inGitDir = (rel: string): boolean => rel === '.git' || rel.startsWith('.git/') || (gitDirPrefix !== null && (rel === gitDirPrefix || rel.startsWith(`${gitDirPrefix}/`)));

  // Snapshot for changedFiles(): what was already dirty before the run touched anything.
  const snapshotDirty = new Set<string>();
  const snapshotFrom = (entries: readonly { path: string; from?: string }[]): void => {
    snapshotDirty.clear();
    for (const e of entries) {
      for (const raw of [e.path, e.from]) {
        const p = raw === undefined ? null : fromRepoPath(raw);
        // the repository dir behind a `gitdir:` pointer is listed as untracked; it is never a dirty workspace file
        if (p !== null && p.length > 0 && !inGitDir(p)) snapshotDirty.add(p);
      }
    }
  };
  if (git) snapshotFrom(probe !== null ? probe.dirty.entries : (await statusPorcelain(deps.sandbox, realRoot)).entries);
  // One `git status` spawn per command run, not per call (DESIGN.md §12 harness budget): the
  // result is cached until invalidateCandidates() (a `run` outcome) marks it dirty; file
  // actions report their own paths through `touched`, so they never need a spawn.
  // TUI-DESIGN §12.1: with a probe the snapshot IS the current status — nothing can have changed through us yet,
  // so the first changedFiles() needs no spawn; the next `run` outcome (invalidateCandidates) marks it dirty
  let statusDirty = probe === null;
  let statusCache: string[] = [];
  let statusEntries: StatusEntry[] = [];
  /**
   * An UNTRACKED status entry under a walk-skipped directory (an un-ignored `.venv/`, `node_modules/`,
   * `__pycache__/`): never a candidate and never a change of the run's making, the same rule the listing
   * applies (git.ts `lsFiles`, candidates.ts `underSkippedDir`). Without it the per-command status refresh
   * fed 1,092 virtualenv files into the candidate cache at the first `run` outcome and a three-file demo
   * flipped to the repository class mid-run (20260923-072804-qnhwfzxq, step 4).
   */
  const skippedUntracked = (e: Pick<StatusEntry, 'code'>, p: string): boolean => e.code === '??' && underSkippedDir(p);
  let statusInflight: Promise<void> | null = null;
  const refreshStatus = (): Promise<void> => {
    if (!git) {
      statusDirty = false;
      return Promise.resolve();
    }
    // Concurrent callers (candidate refresh + changedFiles right after a command) share one spawn.
    if (statusInflight) return statusInflight;
    statusInflight = refreshStatusNow().finally(() => {
      statusInflight = null;
    });
    return statusInflight;
  };
  const refreshStatusNow = async (): Promise<void> => {
    const s = await statusPorcelain(deps.sandbox, realRoot);
    // A listing that FAILED (git exited non-zero, was killed, could not spawn) says nothing about the tree: the previous
    // entries, cache and counts stay and `statusDirty` stays set so the next reader retries once more — an empty result
    // would read as "nothing changed" and drop the run's own command changes from changedFiles()/dirtySet() (fix pass).
    if (!s.ok) return;
    statusEntries = s.entries;
    if (gitStateCurrent !== null && gitStateCurrent.repo) {
      // TUI-DESIGN §12.2: the zone's dirty counts follow the per-command refresh; upstream/ahead/behind stay from run
      // start (they need a spawn). §12.3/§12.4 (E10): `headOid` of every post image is read from gitState().head, so HEAD
      // follows a committing `run` action in-process (zero spawns, the zone's reader); an unreadable or reftable HEAD
      // keeps the run-start value.
      const head = gitStateCurrent.gitDir !== null ? (readHeadFile(gitStateCurrent.gitDir, gitStateCurrent.commonDir) ?? gitStateCurrent.head) : gitStateCurrent.head;
      gitStateCurrent = { ...gitStateCurrent, head, dirty: statusV1ToDirty(s.entries) };
    }
    const out: string[] = [];
    for (const e of s.entries) {
      for (const raw of [e.path, e.from]) {
        const p = raw === undefined ? null : fromRepoPath(raw);
        if (p !== null && p.length > 0 && !snapshotDirty.has(p) && !inGitDir(p) && !skippedUntracked(e, p)) out.push(p);
      }
    }
    statusCache = out;
    statusDirty = false;
  };
  const externalChanges = async (): Promise<string[]> => {
    if (!git) return [];
    if (statusDirty) await refreshStatus();
    return statusCache;
  };
  /** paths written by file actions this run (the non-git source of truth) */
  const touched = new Set<string>();
  /** workspace-relative paths of the latest status refresh (git-reported, outside-the-workspace and .git entries dropped) */
  const statusPaths = (): string[] => {
    const out: string[] = [];
    for (const e of statusEntries) {
      for (const raw of [e.path, e.from]) {
        const p = raw === undefined ? null : fromRepoPath(raw);
        if (p !== null && p.length > 0 && !inGitDir(p) && !skippedUntracked(e, p)) out.push(p);
      }
    }
    return out;
  };

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
      // TUI-DESIGN §15 item 12: the probe rides on WorkspaceInfo when one was handed in
      infoCache = { root: realRoot, git, hasTests: testCommand !== null, testCommand, ...(probe !== null ? { gitState: probe } : {}) };
      return infoCache;
    },

    listCandidates(): Promise<Candidate[]> {
      return candidates.list();
    },

    async invalidateCandidates(): Promise<void> {
      // A command ran: refresh git status once and feed every reported path (new untracked
      // files, deletions, modified sizes) into the candidate cache incrementally. Only a non-git
      // workspace needs a full re-walk.
      statusDirty = true;
      if (!git) return candidates.invalidate();
      await refreshStatus();
      const paths = statusPaths();
      if (paths.length > 0) await candidates.noteChanged(paths);
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

    // TUI-DESIGN §15 item 8 / §12.1: the run-start probe (null without one), dirty counts refreshed per command
    gitState(): GitState | null {
      return gitStateCurrent;
    },

    // AGENT-LOOP-DESIGN §A1: the fresher probe of the same repository becomes the run-start snapshot (nothing ran through us yet)
    adoptGitState(g: GitState): void {
      if (!git || !g.repo || g.prefix !== repoPrefix || touched.size > 0) return;
      gitStateCurrent = g;
      snapshotFrom(g.dirty.entries);
      statusEntries = [];
      statusCache = [];
      statusDirty = false;
    },

    // TUI-DESIGN §15 item 8 / §12.3: snapshotDirty ∪ statusEntries ∪ touched, in memory — the `run` pre-image set
    dirtySet(): ReadonlySet<string> {
      const out = new Set<string>(snapshotDirty);
      for (const p of statusPaths()) out.add(p);
      for (const p of touched) out.add(p);
      return out;
    },

    /**
     * TUI-DESIGN §10.4 (A157) / §15 item 8: the mention-only read of a denylisted file. The caller has
     * already shown `Attach anyway? y/N` under --allow-secret-mention and will `addSecret` every value
     * before the text leaves the process, so the content of a DENYLISTED path (`isMentionDenied` /
     * `isSecretPath`, lexical or canonical) is returned RAW (not through `redact`): a masked value could
     * not be registered. Any other path reads exactly like `read()` — redacted — so the method is never
     * a general unredacted read (fix pass, design mismatch on §10.4). Containment (`resolveInside`) still
     * applies; only the secret-path rule is lifted. The generator's own `read` keeps SecretPathError.
     */
    async readSecretForMention(path, maxBytes): Promise<FileView> {
      const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(Math.floor(maxBytes), MENTION_MAX_BYTES) : MENTION_MAX_BYTES;
      const abs = await resolveInside(realRoot, path, 'read');
      const rel = relOf(abs);
      const denied = isMentionDenied(realRoot, rel, secretCanon) || isMentionDenied(realRoot, path, secretCanon) || isSecret(rel, abs) || isSecret(path, abs);
      try {
        const st = await lstat(abs);
        if (!st.isFile()) throw new JevCodeError('internal', `cannot read "${path}": not a regular file`, { exitCode: 6 });
        const head = await readHead(abs, limit);
        return { path: rel, content: denied ? head.text : deps.redact(head.text), bytes: head.bytes, truncatedBytes: head.truncatedBytes };
      } catch (e) {
        if (e instanceof JevCodeError) throw e;
        if (errCode(e) === 'ENOENT') throw new FileNotFoundError(path, { cause: e });
        throw new JevCodeError('internal', `cannot read "${path}" (${errCode(e)})`, { exitCode: 6, cause: e });
      }
    },
  };
  return workspace;
}
