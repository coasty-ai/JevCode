/**
 * Agent worktrees — the binary-safe dirty-set sync and the measured clean probe
 * (docs/ORCHESTRATION-DESIGN.md §2.3 [G9] [G10] [D2]; §8.2 wave D2 item 17).
 *
 * The worktree itself is created and removed by the coordination design's §12.0.4 write facade
 * [G16], which lives on the coordination branch; `WorktreeFacade` below is therefore the SEAM
 * only — declared here, implemented there. What this module owns are the two pieces around it:
 *
 *  - `dirtySnapshot` / `applyDirtySnapshot`, lifted from `src/synth/sieve/lanes.ts:158` and made
 *    binary-safe. The lane version reads `readFile(abs, 'utf8')`, which mangles a dirty `.png` or
 *    `.db`; on a synth lane that dies with the lane, but in an agent it can be committed and
 *    landed into the user's checkout (corner row 17). This copy moves `Buffer`s, preserves
 *    `st_mode & 0o7777`, and records the sha256 of the bytes it WROTE — which is exactly what
 *    §2.6's `carried` set compares against. `lanes.ts`'s `parsePorcelainZ` is not reusable from
 *    here (§8.1 rule 1 keeps `src/orchestrate/**` off `src/synth/**`), so the NUL parser is
 *    reimplemented below in ~15 lines.
 *
 *  - `cleanProbe`, because `git worktree lock` prevents only `prune` and `move` and is NOT a
 *    cleanliness guarantee [G10]: a working agent's tree is dirty by construction. Cleanliness is
 *    MEASURED — porcelain minus `syncedIgnored` minus `carried` — never assumed.
 *
 * The non-obvious invariant: `carriedPaths` is the ONE definition of "did this agent leave the
 * parent's file alone", and `commit.ts` imports it rather than recomputing it. Two definitions
 * would let the sweep and the commit set disagree about the same file.
 *
 * Every git call goes through the injected `RunGit` seam; `node:fs/promises` is used only to move
 * file bytes, which is the one thing git cannot do for us here.
 */
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { sha256Hex } from '../core/hash.js';
import { DIRTY_ENTRIES_MAX } from '../core/limits.js';
import type { RunGit, SyncedDirtyEntry } from './types.js';

/**
 * CD §12.0.4's write facade, as this module needs it. Implemented on the coordination branch; here
 * it is the seam, so the supervisor can be wired against it before that branch merges.
 */
export interface WorktreeFacade {
  createWorktree(opts: { repoKey: string | null; slug: string; base: string; runId: string; sessionId: string; dirtySync: boolean }):
    Promise<{ dir: string; branch: string; syncedIgnored: readonly string[]; syncedDirty: readonly SyncedDirtyEntry[] }>;
  removeWorktree(opts: { dir: string; force: boolean }): Promise<void>;
}

/** One file of the parent's uncommitted work. `bytes === null` = the file is deleted in the workspace. */
export interface DirtyFile {
  path: string;
  bytes: Buffer | null;
  /** `st_mode & 0o7777`; 0 for a deleted entry, which has no mode to preserve */
  mode: number;
}

/** One porcelain-z entry: the path, plus the three facts the sync and the commit set key on. */
export interface StatusZEntry {
  path: string;
  /** the rename/copy source, when the entry carried one */
  from: string | null;
  deleted: boolean;
  untracked: boolean;
}

const STATUS_ARGS: readonly string[] = ['status', '--porcelain', '-z', '--untracked-files=all'];

/**
 * `git status --porcelain -z --untracked-files=all`, parsed. NUL-separated; a rename or copy
 * carries its original path as one extra NUL-separated field, which must be consumed or every
 * following entry is read off by one. (A reimplementation of `lanes.ts parsePorcelainZ`, which
 * sits in `src/synth/**` and so out of reach of §8.1 rule 1; this version also keeps `from`,
 * because `commit.ts` must stage a rename's source to stage its deletion.)
 */
export function parseStatusZ(out: string): StatusZEntry[] {
  const fields = out.split('\0').filter((f) => f !== '');
  const entries: StatusZEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] ?? '';
    const xy = f.slice(0, 2);
    const path = f.slice(3);
    if (path === '') continue;
    let from: string | null = null;
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') from = fields[++i] ?? null;
    entries.push({ path, from, deleted: xy.includes('D'), untracked: xy === '??' });
  }
  return entries;
}

/** A repo-relative path that cannot escape the tree it is applied to; null when it can. */
function safeRelative(path: string): string | null {
  if (path === '' || path.includes('\0')) return null;
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return null;
  const segs = path.split('/');
  if (segs.includes('..') || segs.includes('.git')) return null;
  return path;
}

/** True when `p` is named by `list` exactly, or lies under a `dir/`-shaped entry of it. */
function excluded(list: readonly string[], p: string): boolean {
  for (const e of list) {
    if (e === '') continue;
    if (e === p) return true;
    const dir = e.endsWith('/') ? e : `${e}/`;
    if (p.startsWith(dir)) return true;
  }
  return false;
}

/** The porcelain listing of `dir`, or `ok: false` when git itself refused to answer. */
export async function statusEntries(runGit: RunGit, dir: string): Promise<{ entries: StatusZEntry[]; ok: boolean }> {
  const res = await runGit(dir, STATUS_ARGS);
  if (!res.ok) return { entries: [], ok: false };
  return { entries: parseStatusZ(res.stdout), ok: true };
}

/**
 * Every path the porcelain listing names, a rename's source included (staging a rename's new path
 * alone would leave its deletion unstaged). Sorted and deduplicated.
 */
export async function dirtyPaths(runGit: RunGit, dir: string): Promise<{ paths: string[]; ok: boolean }> {
  const { entries, ok } = await statusEntries(runGit, dir);
  const out = new Set<string>();
  for (const e of entries) {
    out.add(e.path);
    if (e.from !== null && e.from !== '') out.add(e.from);
  }
  return { paths: [...out].sort(), ok };
}

/**
 * [G9] The parent's uncommitted work, as BYTES. Above `max` entries the UNTRACKED ones are dropped
 * (the `lanes.ts:45` rule, corner row 16: an un-ignored `.venv` lists thousands of files) and
 * `dropped` counts them; tracked modifications are always carried, because they are the earlier
 * commits of this run. A path that is not a regular file (a directory, a symlink, a socket) is
 * skipped: the sync copies file contents, not the tree's shape.
 */
export async function dirtySnapshot(runGit: RunGit, root: string, max: number = DIRTY_ENTRIES_MAX): Promise<{ files: DirtyFile[]; dropped: number }> {
  const { entries, ok } = await statusEntries(runGit, root);
  if (!ok) return { files: [], dropped: 0 };
  let kept = entries;
  let dropped = 0;
  if (kept.length > max) {
    const tracked = kept.filter((e) => !e.untracked);
    dropped = kept.length - tracked.length;
    kept = tracked;
  }
  const files: DirtyFile[] = [];
  for (const e of kept) {
    const rel = safeRelative(e.path);
    if (rel === null) continue;
    if (e.deleted) {
      files.push({ path: rel, bytes: null, mode: 0 });
      continue;
    }
    const abs = join(root, rel);
    const st = await stat(abs).catch(() => null);
    if (st === null || !st.isFile()) continue;
    const bytes = await readFile(abs).catch(() => null);
    if (bytes === null) continue;
    files.push({ path: rel, bytes, mode: st.mode & 0o7777 });
  }
  return { files, dropped };
}

/**
 * [D2] Replay a snapshot into a fresh worktree and record what was written. The returned sha256 is
 * of the bytes THIS call wrote, so `carriedPaths` can later ask "is it still byte-identical?" and
 * get an exact answer even in the one case `Workspace.changedFiles()` cannot see (a `run` command
 * that rewrites a file that was already dirty). A deleted entry is recorded with `sha256: ''`.
 */
export async function applyDirtySnapshot(files: readonly DirtyFile[], dir: string): Promise<SyncedDirtyEntry[]> {
  const out: SyncedDirtyEntry[] = [];
  for (const f of files) {
    const rel = safeRelative(f.path);
    if (rel === null) continue;
    const abs = join(dir, rel);
    if (f.bytes === null) {
      await rm(abs, { force: true });
      out.push({ path: rel, sha256: '', mode: 0 });
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.bytes);
    const mode = f.mode & 0o7777;
    if (mode !== 0) await chmod(abs, mode);
    out.push({ path: rel, sha256: sha256Hex(f.bytes), mode });
  }
  return out;
}

/**
 * [D2] The subset of `syncedDirty` still byte-identical to what the sync wrote — the parent's files
 * this agent left alone. A deleted entry (`sha256: ''`) is carried while the file is still absent;
 * recreating it is a change like any other. An unreadable or non-regular path is NOT carried, so
 * the commit set errs towards committing the agent's own work rather than silently dropping it.
 */
export async function carriedPaths(dir: string, syncedDirty: readonly SyncedDirtyEntry[]): Promise<string[]> {
  const out: string[] = [];
  for (const e of syncedDirty) {
    const rel = safeRelative(e.path);
    if (rel === null) continue;
    const abs = join(dir, rel);
    const st = await stat(abs).catch(() => null);
    if (e.sha256 === '') {
      if (st === null) out.push(rel);
      continue;
    }
    if (st === null || !st.isFile()) continue;
    const bytes = await readFile(abs).catch(() => null);
    if (bytes !== null && sha256Hex(bytes) === e.sha256) out.push(rel);
  }
  return out;
}

/**
 * [G10] The sweep's own cleanliness measurement: porcelain minus `syncedIgnored` minus `carried`.
 * Anything left is real dirt — after [G1] a healthy agent commits at every step and once at
 * `run:end`, so a non-empty `dirty` at the end is corner row 36's crash case. A `syncedIgnored`
 * entry matches exactly or as a `dir/` prefix; ignored files are never listed by porcelain at all,
 * so that subtraction only matters for an entry that stopped being ignored. A git failure is
 * reported as NOT clean: this probe never assumes.
 */
export async function cleanProbe(
  runGit: RunGit,
  dir: string,
  opts: { syncedDirty: readonly SyncedDirtyEntry[]; syncedIgnored: readonly string[] },
): Promise<{ clean: boolean; dirty: string[] }> {
  const { entries, ok } = await statusEntries(runGit, dir);
  if (!ok) return { clean: false, dirty: [] };
  const carried = new Set(await carriedPaths(dir, opts.syncedDirty));
  const dirty = new Set<string>();
  for (const e of entries) {
    const paths = e.from === null || e.from === '' ? [e.path] : [e.path, e.from];
    for (const p of paths) {
      if (carried.has(p) || excluded(opts.syncedIgnored, p)) continue;
      dirty.add(p);
    }
  }
  const sorted = [...dirty].sort();
  return { clean: sorted.length === 0, dirty: sorted };
}
