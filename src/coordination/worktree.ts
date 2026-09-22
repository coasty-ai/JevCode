/**
 * Session worktrees (§6.5, §6.6 sweep, W3 item 27) and the metadata under `coordination/worktrees/<repoKey>/<slug>.json`.
 *
 * The product surface is assigned `/spawn`, `/worktree {list,take,back,fork}` and `sessions gc [--lanes]` (W1 item 15,
 * W2 item 22, W3 item 31), but the facade exposed only `open/subscribe/close` — the TUI could not do the work it owns
 * without writing coordination files itself and breaking the one-owner rule (review blocker 2). These are the write verbs,
 * with git behind an injected `RunGit` seam so the module spawns nothing of its own and a test needs no repository.
 *
 * `git worktree add --lock --reason 'jevcode:<runId>:<sessionId>'` — the lock IS the marker, created atomically with the
 * worktree, so no untracked file ever dirties the tree; the metadata lives outside the checkout and outside every
 * sandbox-writable root (§10.1). The sweep applies the four guards of §6.6 and refuses anything it cannot prove is ours.
 */
import { join } from 'node:path';
import { ConfigError } from '../errors.js';
import { withChecksum } from './checksum.js';
import type { CoordFs } from './fs.js';
import { DIR_MODE, FILE_MODE, errnoCode } from './fs.js';
import { isJsonObject, parseJson } from '../core/json.js';
import { REPO_KEY_RE, RUN_ID_RE, SLUG_RE } from './ids.js';
import { commonsPaths, isSlugName, sessionWorktreeDir } from './paths.js';
import { oneLine } from './records.js';
import type { WorktreeRecord } from './types.js';

/** The `--reason` prefix that marks a worktree as ours; the sweep NEVER touches a lock without it (§6.6 (a)). */
export const LOCK_REASON_PREFIX = 'jevcode:';
export const BRANCH_PREFIX = 'jevcode/';
export const WORKTREE_MAX_BYTES = 8192;
/** §6.5: the ignored files a parent's dirty-set sync may carry into a worktree (the `lanes.ts:45` rule) */
export const SYNCED_IGNORED_MAX = 64;
/** §6.6 (d) `coordination.worktreeRetentionDays` */
export const WORKTREE_RETENTION_MS = 30 * 86_400_000;

/** One `git` invocation. Injected: this module never spawns, so the sweep is unit-testable over a temp dir. */
export type RunGit = (args: readonly string[], o: { cwd: string }) => Promise<{ code: number; stdout: string; stderr: string }>;

export function lockReasonFor(runId: string, sessionId: string): string {
  return `${LOCK_REASON_PREFIX}${runId}:${sessionId}`;
}

/** `jevcode:<runId>:<sessionId>` → the two ids, or null for anything else (a user's own `--lock --reason`). */
export function parseLockReason(reason: string): { runId: string; sessionId: string } | null {
  if (!reason.startsWith(LOCK_REASON_PREFIX)) return null;
  const parts = reason.slice(LOCK_REASON_PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  const [runId, sessionId] = parts as [string, string];
  return RUN_ID_RE.test(runId) && RUN_ID_RE.test(sessionId) ? { runId, sessionId } : null;
}

// ── metadata (`coordination/worktrees/<repoKey>/<slug>.json`) ──────────────────────────────────────────────────────────

export function parseWorktreeRecord(text: string): WorktreeRecord | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isJsonObject(parsed.value) || parsed.value['v'] !== 1) return null;
  const o = parsed.value;
  for (const k of ['repoKey', 'slug', 'runId', 'sessionId', 'deviceId', 'dir60', 'branch', 'base', 'createdAt'] as const) if (typeof o[k] !== 'string') return null;
  if (!REPO_KEY_RE.test(o['repoKey'] as string) || !SLUG_RE.test(o['slug'] as string)) return null;
  if (!RUN_ID_RE.test(o['runId'] as string) || !RUN_ID_RE.test(o['sessionId'] as string)) return null;
  const ignored = o['syncedIgnored'];
  if (!Array.isArray(ignored) || ignored.length > SYNCED_IGNORED_MAX || !ignored.every((x) => typeof x === 'string')) return null;
  const rec: WorktreeRecord = {
    v: 1,
    repoKey: o['repoKey'] as string,
    slug: o['slug'] as string,
    runId: o['runId'] as string,
    sessionId: o['sessionId'] as string,
    deviceId: o['deviceId'] as string,
    dir60: o['dir60'] as string,
    branch: o['branch'] as string,
    base: o['base'] as string,
    createdAt: o['createdAt'] as string,
    syncedIgnored: ignored as string[],
    checksum: typeof o['checksum'] === 'string' ? o['checksum'] : '',
  };
  return rec.checksum === withChecksum({ ...rec, checksum: '' }).checksum ? rec : null;
}

export function buildWorktreeRecord(o: Omit<WorktreeRecord, 'v' | 'checksum'>): WorktreeRecord {
  return withChecksum({
    v: 1 as const,
    ...o,
    dir60: oneLine(o.dir60).slice(-60),
    syncedIgnored: o.syncedIgnored.slice(0, SYNCED_IGNORED_MAX),
  });
}

export interface WorktreeIo {
  fs: CoordFs;
  /** the coordination root (`coordinationRoot(home)`) */
  root: string;
  /** the jevcode home — `~/.jevcode/worktrees/<repoKey>/<slug>/` is a SIBLING of the coordination dir */
  home: string;
  git?: RunGit;
  nowIso?: string;
}

export interface CreateWorktreeInput {
  repoKey: string;
  slug: string;
  /** the commit or ref the branch starts from (`HEAD` for §6.5's recipe) */
  base: string;
  runId: string;
  sessionId: string;
  deviceId: string;
  /** the repository the worktree is added from */
  workspace: string;
  /** ignored files the parent's dirty-set sync copied in; listed in the metadata so `git status` stays clean */
  syncedIgnored?: readonly string[];
  branch?: string;
}

export interface CreatedWorktree {
  dir: string;
  branch: string;
  record: WorktreeRecord;
}

/**
 * §6.5: `git worktree add --lock --reason 'jevcode:<runId>:<sessionId>' -b jevcode/<slug> <dir> <base>`, then the metadata.
 * The lock is created atomically with the worktree, so a crash leaves either nothing or a half-registered worktree that
 * `git worktree prune` removes — never an unmarked directory the sweep might mistake for a user's.
 */
export async function createWorktree(io: WorktreeIo, input: CreateWorktreeInput): Promise<CreatedWorktree> {
  if (!REPO_KEY_RE.test(input.repoKey)) throw new ConfigError(`worktree: '${input.repoKey}' is not a repo key`, { setting: 'coordination' });
  if (!SLUG_RE.test(input.slug)) throw new ConfigError(`worktree: '${input.slug}' is not a slug (${SLUG_RE.source})`, { setting: 'coordination' });
  if (!RUN_ID_RE.test(input.runId) || !RUN_ID_RE.test(input.sessionId)) throw new ConfigError('worktree: runId and sessionId must be run-id shaped', { setting: 'coordination' });
  const paths = commonsPaths(io.root);
  const file = paths.worktreeFile(input.repoKey, input.slug);
  const dir = sessionWorktreeDir(io.home, input.repoKey, input.slug);
  const branch = input.branch ?? `${BRANCH_PREFIX}${input.slug}`;
  if (await exists(io.fs, file)) throw new ConfigError(`worktree ${input.slug} already exists for this repo; '/worktree take ${input.slug}' or pick another slug`, { setting: 'coordination' });
  const git = io.git;
  if (git !== undefined) {
    const r = await git(['worktree', 'add', '--lock', '--reason', lockReasonFor(input.runId, input.sessionId), '-b', branch, dir, input.base], { cwd: input.workspace });
    if (r.code !== 0) throw new ConfigError(`worktree ${input.slug}: git worktree add failed (${r.code}): ${oneLine(r.stderr).slice(0, 200)}`, { setting: 'coordination' });
  }
  const record = buildWorktreeRecord({
    repoKey: input.repoKey,
    slug: input.slug,
    runId: input.runId,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    dir60: dir,
    branch,
    base: input.base,
    createdAt: io.nowIso ?? new Date().toISOString(),
    syncedIgnored: [...(input.syncedIgnored ?? [])],
  });
  await io.fs.mkdir(join(paths.worktreesDir, input.repoKey), DIR_MODE);
  await io.fs.writeAtomic(file, `${JSON.stringify(record)}\n`, { fsync: true, mode: FILE_MODE });
  return { dir, branch, record };
}

async function exists(fs: CoordFs, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every valid metadata record for one repo, by slug; malformed and stray files are skipped, never joined into a path. */
export async function listWorktrees(io: Pick<WorktreeIo, 'fs' | 'root' | 'home'>, repoKey: string): Promise<(WorktreeRecord & { dir: string })[]> {
  if (!REPO_KEY_RE.test(repoKey)) return [];
  const paths = commonsPaths(io.root);
  const dir = join(paths.worktreesDir, repoKey);
  let names: string[];
  try {
    names = await io.fs.readdir(dir);
  } catch (e) {
    const code = errnoCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw e;
  }
  const out: (WorktreeRecord & { dir: string })[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const slug = name.slice(0, -5);
    if (!isSlugName(slug)) continue;
    try {
      const r = await io.fs.readBounded(join(dir, name), WORKTREE_MAX_BYTES);
      if (r.overflow) continue;
      const rec = parseWorktreeRecord(r.text);
      if (rec !== null && rec.slug === slug && rec.repoKey === repoKey) out.push({ ...rec, dir: sessionWorktreeDir(io.home, repoKey, slug) });
    } catch {
      continue;
    }
  }
  return out;
}

export interface RemoveWorktreeResult {
  removed: boolean;
  /** the reason the sweep refused, for `/worktree list`'s `[x] remove anyway (twice)` row */
  refused: 'unknown' | 'not-ours' | 'dirty' | 'unmerged' | 'live' | 'too-young' | 'git-failed' | null;
  detail: string;
}

export interface RemoveWorktreeInput {
  repoKey: string;
  slug: string;
  workspace: string;
  /** §6.6 (b): runIds / sessionIds a live heartbeat or lease still references */
  liveIds?: ReadonlySet<string>;
  /** skip guards (c) and (d) — `/worktree list`'s `[x] remove anyway (twice)` */
  force?: boolean;
  retentionMs?: number;
  nowMs?: number;
}

/**
 * §6.6: removes a session worktree only when (a) its lock reason starts `jevcode:`, (b) no live heartbeat or lease
 * references its runId or sessionId, (c) it is clean and merged (or `force`), (d) it is older than the retention (or
 * `force`). Dirty or unmerged worktrees are kept and listed. The lock is released only for our own reason (§6.6 last line).
 */
export async function removeWorktree(io: WorktreeIo, input: RemoveWorktreeInput): Promise<RemoveWorktreeResult> {
  const paths = commonsPaths(io.root);
  const rows = await listWorktrees(io, input.repoKey);
  const rec = rows.find((r) => r.slug === input.slug);
  if (rec === undefined) return { removed: false, refused: 'unknown', detail: `no worktree metadata for ${input.slug}` };
  const live = input.liveIds ?? new Set<string>();
  if (live.has(rec.runId) || live.has(rec.sessionId)) return { removed: false, refused: 'live', detail: `${input.slug} is still referenced by a live run` };
  const git = io.git;
  if (git !== undefined) {
    const listed = await git(['worktree', 'list', '--porcelain'], { cwd: input.workspace });
    if (listed.code !== 0) return { removed: false, refused: 'git-failed', detail: oneLine(listed.stderr).slice(0, 200) };
    const entry = parseWorktreeList(listed.stdout).find((w) => w.dir === rec.dir);
    // (a) a worktree git does not report as ours is never removed — a user's own worktree at that path, or already pruned
    if (entry !== undefined && (entry.lockReason === null || parseLockReason(entry.lockReason) === null)) {
      return { removed: false, refused: 'not-ours', detail: `${input.slug} is locked by someone else (${entry.lockReason ?? 'no reason'})` };
    }
    if (input.force !== true && entry !== undefined) {
      const status = await git(['status', '--porcelain', '--untracked-files=all'], { cwd: rec.dir });
      if (status.code === 0 && status.stdout.trim() !== '') return { removed: false, refused: 'dirty', detail: `${input.slug} has uncommitted changes` };
      const merged = await git(['merge-base', '--is-ancestor', rec.branch, rec.base], { cwd: input.workspace });
      if (merged.code !== 0) return { removed: false, refused: 'unmerged', detail: `${input.slug} has commits beyond ${rec.base}` };
    }
    if (entry !== undefined) {
      await git(['worktree', 'unlock', rec.dir], { cwd: input.workspace });
      const rm = await git(['worktree', 'remove', '--force', rec.dir], { cwd: input.workspace });
      if (rm.code !== 0) return { removed: false, refused: 'git-failed', detail: oneLine(rm.stderr).slice(0, 200) };
      await git(['worktree', 'prune'], { cwd: input.workspace });
    }
  }
  if (input.force !== true) {
    const created = Date.parse(rec.createdAt);
    const now = input.nowMs ?? Date.now();
    const retention = input.retentionMs ?? WORKTREE_RETENTION_MS;
    if (Number.isFinite(created) && now - created < retention) return { removed: false, refused: 'too-young', detail: `${input.slug} is newer than the retention` };
  }
  await io.fs.rmTree(rec.dir).catch(() => undefined);
  await io.fs.unlink(paths.worktreeFile(input.repoKey, input.slug)).catch(() => undefined);
  return { removed: true, refused: null, detail: `removed ${input.slug}` };
}

export interface GitWorktreeEntry {
  dir: string;
  head: string | null;
  branch: string | null;
  locked: boolean;
  lockReason: string | null;
}

/** `git worktree list --porcelain` — the only parser of git's output in this module. */
export function parseWorktreeList(stdout: string): GitWorktreeEntry[] {
  const out: GitWorktreeEntry[] = [];
  let cur: GitWorktreeEntry | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      if (cur !== null) out.push(cur);
      cur = { dir: line.slice('worktree '.length), head: null, branch: null, locked: false, lockReason: null };
      continue;
    }
    if (cur === null) continue;
    if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (line === 'locked') cur.locked = true;
    else if (line.startsWith('locked ')) {
      cur.locked = true;
      cur.lockReason = line.slice('locked '.length);
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

export interface SweepReport {
  removed: string[];
  kept: { slug: string; reason: NonNullable<RemoveWorktreeResult['refused']>; detail: string }[];
}

/** §6.6 / `sessions gc`: every metadata row for one repo through `removeWorktree`; the kept rows carry the reason. */
export async function sweepWorktrees(io: WorktreeIo, o: { repoKey: string; workspace: string; liveIds?: ReadonlySet<string>; retentionMs?: number; nowMs?: number }): Promise<SweepReport> {
  const report: SweepReport = { removed: [], kept: [] };
  for (const rec of await listWorktrees(io, o.repoKey)) {
    const r = await removeWorktree(io, {
      repoKey: o.repoKey,
      slug: rec.slug,
      workspace: o.workspace,
      ...(o.liveIds !== undefined ? { liveIds: o.liveIds } : {}),
      ...(o.retentionMs !== undefined ? { retentionMs: o.retentionMs } : {}),
      ...(o.nowMs !== undefined ? { nowMs: o.nowMs } : {}),
    });
    if (r.removed) report.removed.push(rec.slug);
    else if (r.refused !== null) report.kept.push({ slug: rec.slug, reason: r.refused, detail: r.detail });
  }
  return report;
}
