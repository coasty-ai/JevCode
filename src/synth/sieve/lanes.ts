/**
 * Shadow lanes (docs/JEV-ONLY-DESIGN.md §4.2): where candidates run so the synthesizer never
 * writes into the real workspace. Lanes live under `<ctx.runDir>/tmp/synth/lane<k>/`, inside the
 * sandbox's writable roots, in one of four modes:
 *
 * - `candidate_file` (QuixBugs runner): no copy; the candidate file is written into the lane and
 *   handed to `run_tests.py <name> <candidatePath>`.
 * - `worktree` (git workspaces): `git worktree add --detach lane<k> HEAD` once per run, reset with
 *   `git checkout -- . && git clean -fdq` between candidates; the workspace's uncommitted changes
 *   (earlier commits of this run are patches, not git commits) are re-synced after every reset.
 * - `copy` (non-git ≤ 50 MB): `cp -R` of the workspace once; touched files restored between candidates.
 * - `inplace` (non-git > 50 MB): one lane on the workspace itself, apply/revert with the revert in
 *   `finally`. `cp -al` is never used (BSD `cp` has no `-l`).
 *
 * Shell work (mkdir, git, cp, rm) goes through `ctx.sandbox.run(cmd, { cwd })`; file contents are
 * written with node:fs because the lane directory belongs to the run and a shell heredoc would
 * only add quoting hazards. Nothing here asks Jev anything.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';

import type { ExecResult, Sandbox, SandboxRunOptions } from '../../core/types.js';
import type { LaneMode, Lane, OracleModel } from '../search/types.js';
import { LARGE_WORKSPACE_BYTES } from '../search/budget.js';
import type { AppliedCandidate, SourceFile } from '../types.js';
import { shellQuote } from '../verify/text.js';

/**
 * Subdirectory of the run directory that holds the lanes. The design says `<runDir>/synth/`, but
 * the seatbelt profile (src/sandbox/seatbelt.ts) allows writes only under the workspace,
 * `<runDir>/tmp` and `<runDir>/home` (the run dir itself holds the checkpoints and stays
 * read-only for sandboxed commands): the first live run failed at `mkdir -p <runDir>/synth`
 * with "Operation not permitted". `tmp/synth` is the writable, readable, cwd-accepted spot.
 */
export const LANES_SUBDIR = 'tmp/synth';
/** Lane bookkeeping commands (mkdir, git worktree add/remove, cp -R of ≤ 50 MB, rm -rf) are bounded by this. */
export const LANE_COMMAND_TIMEOUT_MS = 120_000;
export const LANE_COMMAND_OUTPUT_BYTES = 256 * 1024;
/**
 * Dirty (uncommitted) workspace entries re-synced into a worktree lane after each reset. When
 * the list is longer than this the untracked entries are dropped (an un-ignored `.venv` would
 * list thousands of files); tracked modifications are always synced because they are the
 * earlier commits of this run.
 */
export const DIRTY_ENTRIES_MAX = 200;

export class LaneError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`LaneError: ${message}`, options);
    this.name = 'LaneError';
  }
}

/** What the lanes need from the SynthesisContext (a Pick, so tests build small objects). */
export interface LaneContext {
  runDir: string;
  sandbox: Pick<Sandbox, 'run'>;
  signal: AbortSignal;
  workspaceInfo: { root: string; git: boolean };
}

export interface CreateLanesOptions {
  /** workspace size when the caller knows it; otherwise `du -sk` is run for non-git workspaces */
  workspaceBytes?: number;
  /** lane count override (default oracle.lanes; `inplace` is always 1) */
  count?: number;
}

export interface LanePool {
  readonly mode: LaneMode;
  readonly lanes: readonly Lane[];
  readonly workspaceRoot: string;
  /** absolute path of a workspace-relative file inside the lane */
  pathInLane(lane: Lane, relPath: string): string;
  /** acquire a free lane (waiting when all are busy), run `fn`, then reset the lane in `finally` and release it */
  withLane<T>(fn: (lane: Lane) => Promise<T>): Promise<T>;
  /** write the base's files (when given) and the candidate's `after` contents into the lane */
  applyToLane(lane: Lane, applied: AppliedCandidate, baseFiles?: ReadonlyMap<string, SourceFile>): Promise<void>;
  /** undo the lane's changes (mode-specific, see the module header) */
  resetLane(lane: Lane): Promise<void>;
  /** remove worktrees / copies; restore the workspace in `inplace` mode; idempotent */
  disposeLanes(): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

async function sh(ctx: LaneContext, command: string, cwd: string, extra: Partial<Pick<SandboxRunOptions, 'timeoutMs'>> = {}): Promise<ExecResult> {
  return ctx.sandbox.run(command, { timeoutMs: extra.timeoutMs ?? LANE_COMMAND_TIMEOUT_MS, maxOutputBytes: LANE_COMMAND_OUTPUT_BYTES, signal: ctx.signal, cwd });
}

async function shOk(ctx: LaneContext, command: string, cwd: string): Promise<ExecResult> {
  const res = await sh(ctx, command, cwd);
  if (!res.ok) throw new LaneError(`\`${command}\` failed (exit ${res.exitCode ?? 'null'}${res.killedBy ? `, killed: ${res.killedBy}` : ''}): ${(res.stderr || res.stdout).trim().split('\n').pop() ?? ''}`);
  return res;
}

/** A lane-relative path must stay inside the lane: relative, no `..` segment, no NUL. */
export function safeRelativePath(relPath: string): string {
  if (relPath === '' || relPath.includes('\0') || isAbsolute(relPath)) throw new LaneError(`refusing to write outside the lane: ${JSON.stringify(relPath)}`);
  const norm = normalize(relPath);
  if (norm === '..' || norm.startsWith(`..${sep}`) || norm.split(sep).includes('..')) throw new LaneError(`refusing to write outside the lane: ${JSON.stringify(relPath)}`);
  return norm;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT') return null;
    throw e;
  }
}

async function writeContent(path: string, content: string | null): Promise<void> {
  if (content === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

/** `du -sk .` → bytes; null when it cannot be read (treated as large: the safest mode). */
export async function measureWorkspaceBytes(ctx: LaneContext): Promise<number | null> {
  const res = await sh(ctx, 'du -sk .', ctx.workspaceInfo.root);
  const m = /^\s*(\d+)/.exec(res.stdout);
  if (!res.ok || m === null) return null;
  return Number(m[1]) * 1024;
}

export interface DirtyEntry {
  path: string;
  /** null when the file is deleted in the workspace */
  content: string | null;
}

/**
 * Parse `git status --porcelain -z --untracked-files=all` (NUL-separated; a rename carries the
 * original path as an extra NUL-separated field) into the paths that differ from HEAD.
 */
export function parsePorcelainZ(out: string): { path: string; deleted: boolean; untracked: boolean }[] {
  const fields = out.split('\0').filter((f) => f !== '');
  const entries: { path: string; deleted: boolean; untracked: boolean }[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] ?? '';
    const xy = f.slice(0, 2);
    const path = f.slice(3);
    if (path === '') continue;
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i += 1; // skip the original path
    entries.push({ path, deleted: xy.includes('D'), untracked: xy === '??' });
  }
  return entries;
}

/** Snapshot of the workspace files that differ from HEAD, to be replayed into a fresh worktree. */
async function dirtySnapshot(ctx: LaneContext): Promise<DirtyEntry[]> {
  const res = await shOk(ctx, 'git status --porcelain -z --untracked-files=all', ctx.workspaceInfo.root);
  let entries = parsePorcelainZ(res.stdout);
  if (entries.length > DIRTY_ENTRIES_MAX) entries = entries.filter((e) => !e.untracked);
  const out: DirtyEntry[] = [];
  for (const e of entries) {
    const abs = join(ctx.workspaceInfo.root, e.path);
    if (e.deleted) {
      out.push({ path: e.path, content: null });
      continue;
    }
    const st = await stat(abs).catch(() => null);
    if (st === null || !st.isFile()) continue;
    out.push({ path: e.path, content: await readFile(abs, 'utf8') });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------------------

/** §4.2 mode selection: QuixBugs runner → candidate_file; git → worktree; small non-git → copy; else inplace. */
export function chooseLaneMode(oracle: Pick<OracleModel, 'runner'>, workspace: { git: boolean }, workspaceBytes: number | null): LaneMode {
  if (oracle.runner === 'quixbugs') return 'candidate_file';
  if (workspace.git) return 'worktree';
  if (workspaceBytes !== null && workspaceBytes <= LARGE_WORKSPACE_BYTES) return 'copy';
  return 'inplace';
}

export async function createLanes(ctx: LaneContext, oracle: OracleModel, opts: CreateLanesOptions = {}): Promise<LanePool> {
  const root = ctx.workspaceInfo.root;
  let bytes: number | null = opts.workspaceBytes ?? null;
  if (bytes === null && oracle.runner !== 'quixbugs' && !ctx.workspaceInfo.git) bytes = await measureWorkspaceBytes(ctx);
  const mode = chooseLaneMode(oracle, ctx.workspaceInfo, bytes);
  const count = mode === 'inplace' ? 1 : Math.max(1, Math.floor(opts.count ?? oracle.lanes));
  const lanesDir = join(ctx.runDir, LANES_SUBDIR);

  const lanes: Lane[] = [];
  /** per lane: files written since the last reset, with their pre-write content (copy / inplace restore) */
  const touched = new Map<number, Map<string, string | null>>();
  let dirty: DirtyEntry[] = [];
  let disposed = false;

  if (mode === 'inplace') {
    lanes.push({ index: 0, dir: root, mode, busy: false });
  } else {
    await shOk(ctx, `mkdir -p ${shellQuote(lanesDir)}`, root);
    if (mode === 'worktree') dirty = await dirtySnapshot(ctx);
    for (let k = 0; k < count; k++) {
      const dir = join(lanesDir, `lane${k}`);
      if (mode === 'worktree') {
        // the worktree command creates the directory itself and refuses an existing one; it also
        // refuses a path a previous process of this run (same runDir on --resume, or a crash before
        // disposeLanes) left registered, so stale registrations are pruned after the directory goes
        await sh(ctx, `rm -rf ${shellQuote(dir)} && git worktree prune`, root);
        await shOk(ctx, `git worktree add --detach ${shellQuote(dir)} HEAD`, root);
      } else {
        await shOk(ctx, `mkdir -p ${shellQuote(dir)}`, root);
        // A copy carries the workspace's `__pycache__` too; a stale .pyc there (same size, same
        // mtime second as a later candidate) would run the wrong code (runner.ts LANE_RUN_ENV).
        // Worktrees check out HEAD only and never contain ignored caches.
        if (mode === 'copy') await shOk(ctx, `cp -R ${shellQuote(`${root}/.`)} ${shellQuote(dir)} && find ${shellQuote(dir)} -name __pycache__ -type d -prune -exec rm -rf {} +`, root);
      }
      lanes.push({ index: k, dir, mode, busy: false });
    }
  }

  const replayDirty = async (lane: Lane): Promise<void> => {
    for (const e of dirty) await writeContent(join(lane.dir, safeRelativePath(e.path)), e.content);
  };
  for (const lane of lanes) if (mode === 'worktree') await replayDirty(lane);

  const pathInLane = (lane: Lane, relPath: string): string => join(lane.dir, safeRelativePath(relPath));

  const write = async (lane: Lane, relPath: string, content: string): Promise<void> => {
    const abs = pathInLane(lane, relPath);
    const current = await readIfExists(abs);
    if (current === content) return;
    if (mode === 'copy' || mode === 'inplace') {
      const m = touched.get(lane.index) ?? new Map<string, string | null>();
      if (!m.has(relPath)) m.set(relPath, current);
      touched.set(lane.index, m);
    }
    await writeContent(abs, content);
  };

  const applyToLane = async (lane: Lane, applied: AppliedCandidate, baseFiles?: ReadonlyMap<string, SourceFile>): Promise<void> => {
    if (disposed) throw new LaneError('lanes disposed');
    // base files first (an 'improved' base carries edits the workspace does not have), then the candidate
    if (baseFiles !== undefined) for (const [path, f] of baseFiles) await write(lane, path, f.src);
    for (const f of applied.files) await write(lane, f.path, f.after);
  };

  const resetLane = async (lane: Lane): Promise<void> => {
    switch (mode) {
      case 'candidate_file':
        return; // the next candidate overwrites its file; nothing else lives in the lane
      case 'worktree':
        await shOk(ctx, 'git checkout -- . && git clean -fdq', lane.dir);
        await replayDirty(lane);
        return;
      case 'copy':
      case 'inplace': {
        const m = touched.get(lane.index);
        if (m === undefined) return;
        touched.delete(lane.index);
        // restore in reverse write order so a file written twice ends at its original content
        for (const [relPath, content] of [...m.entries()].reverse()) await writeContent(pathInLane(lane, relPath), content);
        return;
      }
    }
  };

  // FIFO of waiters for a free lane
  const waiters: ((lane: Lane) => void)[] = [];
  const acquire = (): Promise<Lane> => {
    const free = lanes.find((l) => !l.busy);
    if (free !== undefined) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise<Lane>((resolve) => waiters.push(resolve));
  };
  const release = (lane: Lane): void => {
    const next = waiters.shift();
    if (next !== undefined) next(lane); // stays busy, handed over directly
    else lane.busy = false;
  };

  const withLane = async <T>(fn: (lane: Lane) => Promise<T>): Promise<T> => {
    if (disposed) throw new LaneError('lanes disposed');
    const lane = await acquire();
    try {
      return await fn(lane);
    } finally {
      try {
        await resetLane(lane);
      } finally {
        release(lane);
      }
    }
  };

  const disposeLanes = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    const problems: string[] = [];
    for (const lane of lanes) {
      try {
        if (mode === 'inplace') {
          await resetLane(lane);
        } else if (mode === 'worktree') {
          const res = await sh(ctx, `git worktree remove --force ${shellQuote(lane.dir)}`, root);
          if (!res.ok) await sh(ctx, `rm -rf ${shellQuote(lane.dir)} && git worktree prune`, root);
        } else {
          await sh(ctx, `rm -rf ${shellQuote(lane.dir)}`, root);
        }
      } catch (e: unknown) {
        problems.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (problems.length > 0) throw new LaneError(`dispose: ${problems.join('; ')}`);
  };

  return { mode, lanes, workspaceRoot: root, pathInLane, withLane, applyToLane, resetLane, disposeLanes };
}

// Design §6 names as free functions over a pool.
export function withLane<T>(pool: LanePool, fn: (lane: Lane) => Promise<T>): Promise<T> {
  return pool.withLane(fn);
}
export function applyToLane(pool: LanePool, lane: Lane, applied: AppliedCandidate, baseFiles?: ReadonlyMap<string, SourceFile>): Promise<void> {
  return pool.applyToLane(lane, applied, baseFiles);
}
export function disposeLanes(pool: LanePool): Promise<void> {
  return pool.disposeLanes();
}
