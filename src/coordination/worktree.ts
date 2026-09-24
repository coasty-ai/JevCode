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
import { OID_RE, REPO_KEY_RE, RUN_ID_RE, SLUG_RE, isValidBranch } from './ids.js';
import { commonsPaths, isSlugName, keyDir, sessionWorktreeDir } from './paths.js';
import { oneLine } from './records.js';
import type { WorktreeInfo, WorktreeRecord } from './types.js';

/** The `--reason` prefix that marks a worktree as ours; the sweep NEVER touches a lock without it (§6.6 (a)). */
export const LOCK_REASON_PREFIX = 'jevcode:';
export const BRANCH_PREFIX = 'jevcode/';
export const WORKTREE_MAX_BYTES = 8192;
/** §6.5: the ignored files a parent's dirty-set sync may carry into a worktree (the `lanes.ts:45` rule) */
export const SYNCED_IGNORED_MAX = 64;
/** §6.6 (d) `coordination.worktreeRetentionDays` */
export const WORKTREE_RETENTION_MS = 30 * 86_400_000;

/**
 * + review major 18: `--end-of-options` goes before every argument that came out of a RECORD. `branch` and `base` are
 * parsed from `<slug>.json`, which lives in a folder a peer device writes to; a value beginning with `-` would be read
 * by git as an option (`--upload-pack=…`, `--exec=…`) on a command this module spawns. `isValidBranch` already refuses a
 * leading `-`, but the separator is what makes it structural rather than a validator we must never get wrong.
 */
export const END_OF_OPTIONS = '--end-of-options';

/** + review major 18: a `base` is a full oid or a ref name — the same rules `git check-ref-format` applies. */
export function isValidBase(base: string): boolean {
  return OID_RE.test(base) || isValidBranch(base);
}

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
  // + review major 18: both reach `git` (`merge-base --is-ancestor <branch> <base>`), so both are validated on the way in
  if (!isValidBranch(o['branch'] as string) || !isValidBase(o['base'] as string)) return null;
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
  /** §3.1 (revision 5): the per-host subtree that holds `worktrees/<keyDir>/<slug>.json` — local truth, never mirrored */
  hostKey?: string;
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
  const paths = commonsPaths(io.root, io.hostKey);
  const file = paths.worktreeFile(input.repoKey, input.slug);
  const dir = sessionWorktreeDir(io.home, input.repoKey, input.slug);
  const branch = input.branch ?? `${BRANCH_PREFIX}${input.slug}`;
  // + review major 18: both go to `git worktree add`; a `-`-leading or `..`-bearing value is refused before the spawn
  if (!isValidBranch(branch)) throw new ConfigError(`worktree: '${branch}' is not a valid branch name`, { setting: 'coordination' });
  if (!isValidBase(input.base)) throw new ConfigError(`worktree: '${input.base}' is not a commit or ref`, { setting: 'coordination' });
  if (await exists(io.fs, file)) throw new ConfigError(`worktree ${input.slug} already exists for this repo; '/worktree take ${input.slug}' or pick another slug`, { setting: 'coordination' });
  const git = io.git;
  if (git !== undefined) {
    const r = await git(['worktree', 'add', '--lock', '--reason', lockReasonFor(input.runId, input.sessionId), '-b', branch, END_OF_OPTIONS, dir, input.base], { cwd: input.workspace });
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
  // + re-check (7): the DIRECTORY component is `keyDir(repoKey)` — `paths.worktreeFile` already encodes it, so the raw
  // key here made `mkdir` create `worktrees/ws:…/` while the write targeted `worktrees/ws-…/` and ENOENT'd (M13 again).
  await io.fs.mkdir(join(paths.worktreesDir, keyDir(input.repoKey)), DIR_MODE);
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
export async function listWorktrees(io: Pick<WorktreeIo, 'fs' | 'root' | 'home' | 'hostKey'>, repoKey: string): Promise<(WorktreeRecord & { dir: string })[]> {
  if (!REPO_KEY_RE.test(repoKey)) return [];
  const paths = commonsPaths(io.root, io.hostKey);
  const dir = join(paths.worktreesDir, keyDir(repoKey));
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
 *
 * + review blocker 5: EVERY GUARD IS EVALUATED BEFORE ANY MUTATION. The old order ran
 * `git worktree unlock` + `git worktree remove --force` and only THEN checked the retention — so a worktree that the
 * function reported as `kept: too-young` had already been deleted. Worse, when git no longer listed the directory
 * (`entry === undefined`: a pruned registration, a `.git` file the user moved, a repository the sweep is not being run
 * from) the (a)/(c) guards were skipped altogether and `rmTree` deleted the directory unconditionally — a user's own
 * work at that path, with no lock reason of ours anywhere in sight.
 *
 * Now: gather the verdict first (`refuse` short-circuits), mutate only when nothing refused. An unlisted worktree whose
 * directory still exists is `'unknown'` and is never touched without `force`.
 */
export async function removeWorktree(io: WorktreeIo, input: RemoveWorktreeInput): Promise<RemoveWorktreeResult> {
  const paths = commonsPaths(io.root, io.hostKey);
  const verdict = await worktreeVerdict(io, input);
  if (verdict.refused !== null) return { removed: false, refused: verdict.refused, detail: verdict.detail };
  const { rec, listedEntry } = verdict;
  // ── mutation (nothing above refused) ────────────────────────────────────────────────────────────────────────────
  const git = io.git;
  if (git !== undefined && listedEntry !== undefined) {
    await git(['worktree', 'unlock', END_OF_OPTIONS, rec.dir], { cwd: input.workspace });
    const rm = await git(['worktree', 'remove', '--force', END_OF_OPTIONS, rec.dir], { cwd: input.workspace });
    if (rm.code !== 0) return { removed: false, refused: 'git-failed', detail: oneLine(rm.stderr).slice(0, 200) };
    await git(['worktree', 'prune'], { cwd: input.workspace });
  }
  await io.fs.rmTree(rec.dir).catch(() => undefined);
  await io.fs.unlink(paths.worktreeFile(input.repoKey, input.slug)).catch(() => undefined);
  return { removed: true, refused: null, detail: `removed ${input.slug}` };
}

type Verdict =
  | { refused: NonNullable<RemoveWorktreeResult['refused']>; detail: string }
  | { refused: null; detail: string; rec: WorktreeRecord & { dir: string }; listedEntry: GitWorktreeEntry | undefined };

/**
 * + review blocker 5: every §6.6 guard, and NOTHING that writes. `removeWorktree` mutates only after this returns
 * `refused: null`, and `listWorktreeInfo` renders the same verdict without touching the disk at all.
 */
async function worktreeVerdict(io: WorktreeIo, input: RemoveWorktreeInput): Promise<Verdict> {
  const rows = await listWorktrees(io, input.repoKey);
  const rec = rows.find((r) => r.slug === input.slug);
  if (rec === undefined) return { refused: 'unknown', detail: `no worktree metadata for ${input.slug}` };
  const live = input.liveIds ?? new Set<string>();
  if (live.has(rec.runId) || live.has(rec.sessionId)) return { refused: 'live', detail: `${input.slug} is still referenced by a live run` };
  const git = io.git;
  let listedEntry: GitWorktreeEntry | undefined;
  if (git !== undefined) {
    const listed = await git(['worktree', 'list', '--porcelain'], { cwd: input.workspace });
    if (listed.code !== 0) return { refused: 'git-failed', detail: oneLine(listed.stderr).slice(0, 200) };
    listedEntry = parseWorktreeList(listed.stdout).find((w) => w.dir === rec.dir);
    // (a) a worktree git does not report as ours is never removed — a user's own worktree at that path
    if (listedEntry !== undefined && (listedEntry.lockReason === null || parseLockReason(listedEntry.lockReason) === null)) {
      return { refused: 'not-ours', detail: `${input.slug} is locked by someone else (${listedEntry.lockReason ?? 'no reason'})` };
    }
    // git does not know this path. If the directory is gone the metadata is simply stale and may be cleaned up; if it
    // is still there we cannot prove it is ours, so we refuse rather than `rm -rf` a stranger's tree.
    if (listedEntry === undefined && input.force !== true && (await exists(io.fs, rec.dir))) {
      return { refused: 'unknown', detail: `${input.slug} is not a worktree git reports; refusing to remove ${rec.dir}` };
    }
    if (input.force !== true && listedEntry !== undefined) {
      const status = await git(['status', '--porcelain', '--untracked-files=all'], { cwd: rec.dir });
      if (status.code === 0 && status.stdout.trim() !== '') return { refused: 'dirty', detail: `${input.slug} has uncommitted changes` };
      // + review major 18: `branch` and `base` come out of the record, so the separator goes before them
      const merged = await git(['merge-base', '--is-ancestor', END_OF_OPTIONS, rec.branch, rec.base], { cwd: input.workspace });
      if (merged.code !== 0) return { refused: 'unmerged', detail: `${input.slug} has commits beyond ${rec.base}` };
    }
  }
  if (input.force !== true) {
    const created = Date.parse(rec.createdAt);
    const now = input.nowMs ?? Date.now();
    const retention = input.retentionMs ?? WORKTREE_RETENTION_MS;
    if (Number.isFinite(created) && now - created < retention) return { refused: 'too-young', detail: `${input.slug} is newer than the retention` };
  }
  return { refused: null, detail: `${input.slug} can be removed`, rec, listedEntry };
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
  /** + re-review (2): a sweep never throws for a disk or git fault; the row says which slug and why */
  failed: { slug: string; code: string }[];
}

/** §6.6 / `sessions gc`: every metadata row for one repo through `removeWorktree`; the kept rows carry the reason. */
export async function sweepWorktrees(io: WorktreeIo, o: { repoKey: string; workspace: string; liveIds?: ReadonlySet<string>; retentionMs?: number; nowMs?: number }): Promise<SweepReport> {
  const report: SweepReport = { removed: [], kept: [], failed: [] };
  for (const rec of await listWorktrees(io, o.repoKey)) {
    try {
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
    } catch (e) {
      report.failed.push({ slug: rec.slug, code: errnoCode(e) ?? 'EUNKNOWN' });
    }
  }
  return report;
}

/**
 * + re-review (2): `/worktree list` — every metadata row for one repo with the §6.6 verdict already applied, so the
 * surface renders `[x] remove anyway (twice)` from a state, not from a second round of guard logic of its own.
 */
export async function listWorktreeInfo(io: WorktreeIo, o: { repoKey: string; workspace: string; liveIds?: ReadonlySet<string>; retentionMs?: number; nowMs?: number }): Promise<WorktreeInfo[]> {
  const out: WorktreeInfo[] = [];
  for (const rec of await listWorktrees(io, o.repoKey)) {
    let state: WorktreeInfo['state'] = 'removable';
    let detail = `${rec.slug} can be removed`;
    try {
      const v = await worktreeVerdict(io, {
        repoKey: o.repoKey,
        slug: rec.slug,
        workspace: o.workspace,
        ...(o.liveIds !== undefined ? { liveIds: o.liveIds } : {}),
        ...(o.retentionMs !== undefined ? { retentionMs: o.retentionMs } : {}),
        ...(o.nowMs !== undefined ? { nowMs: o.nowMs } : {}),
      });
      if (v.refused !== null) {
        state = v.refused;
        detail = v.detail;
      }
    } catch (e) {
      state = 'git-failed';
      detail = errnoCode(e) ?? 'EUNKNOWN';
    }
    out.push({ repoKey: rec.repoKey, slug: rec.slug, runId: rec.runId, sessionId: rec.sessionId, deviceId: rec.deviceId, branch: rec.branch, base: rec.base, createdAt: rec.createdAt, dir: rec.dir, state, detail });
  }
  return out;
}
