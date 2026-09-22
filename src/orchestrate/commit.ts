/**
 * [G1] The harness commits — and [D2] the commit set is computed, not `-A`
 * (docs/ORCHESTRATION-DESIGN.md §2.6; §8.2 wave D2 item 18).
 *
 * Without this module every `git merge`, `git diff base..branch` and `rev-list --count` in §5
 * operates on an empty range: JevCode makes zero git mutations in the product path today, so every
 * agent would hit corner row 37 ("zero commits → lands trivially as a no-op") while its real work
 * sat uncommitted in a worktree. §2.6's arithmetic, reproduced exactly:
 *
 *   touched  = ⋃ over this agent's steps of ActionOutcome.changedFiles
 *   dirtyNow = statusPorcelain(<worktreeDir>).entries.paths     # --untracked-files=all; ignored files
 *                                                               # are never listed, so syncedIgnored
 *                                                               # (.env) can never appear
 *   carried  = { p ∈ syncedDirty : sha256(<worktreeDir>/p) === p.sha256 }
 *   addSet   = (dirtyNow \ carried) ∪ (touched ∩ dirtyNow)
 *
 * `carried` is the exact answer to "did this agent leave the parent's file alone?", and the sha
 * recheck is what makes it exact in the one case `Workspace.changedFiles()` cannot see: a `run`
 * command that rewrites a file that was already in `snapshotDirty` is filtered out of
 * `externalChanges()` (`src/workspace/files.ts:235`) and would otherwise be dropped from the
 * commit. The second union term is the belt for the reverse case (a file action on a carried
 * path, which `touched` records directly). It is computed by `worktree.ts carriedPaths`, never
 * re-derived here: one definition, or the sweep and the commit set disagree about one file.
 *
 * Every git call goes through the injected `RunGit` seam — which supplies `GIT_CONFIG_NOSYSTEM`,
 * `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_BASE_FLAGS`' `-c core.hooksPath=/dev/null`.
 */
import { sha256Hex } from '../core/hash.js';
import { ADD_SET_CHUNK } from '../core/limits.js';
import { LITERAL_PATHSPECS_FLAG } from '../workspace/git.js';
import type { CommitIdentity, RunGit, SyncedDirtyEntry } from './types.js';
import { carriedPaths, dirtyPaths } from './worktree.js';

/** §2.6: the `<summary60>` of the commit subject. */
export const SUMMARY_CHARS = 60;

export interface AddSetInput {
  /** ⋃ over this agent's steps of `ActionOutcome.changedFiles` — file actions AND post-`run` diffs */
  touched: readonly string[];
  /** [D2] `RunMeta.agent.syncedDirty`: what the worktree's dirty-set sync wrote */
  syncedDirty: readonly SyncedDirtyEntry[];
}

export interface AddSet {
  /** sorted, deduplicated; `git add` takes it in `ADD_SET_CHUNK`-sized chunks */
  addSet: string[];
  carried: string[];
  dirtyNow: string[];
}

/** A path git will read as a literal file name, inside the worktree. */
function stageable(p: string): boolean {
  if (p === '' || p.includes('\0') || p.startsWith('/')) return false;
  const segs = p.split('/');
  return !segs.includes('..') && !segs.includes('.git');
}

/** §2.6's four-line arithmetic, and nothing else. Pure over the two git reads it makes. */
export async function computeAddSet(runGit: RunGit, dir: string, input: AddSetInput): Promise<AddSet> {
  const { paths: dirtyNow } = await dirtyPaths(runGit, dir);
  const carried = await carriedPaths(dir, input.syncedDirty);
  const dirtySet = new Set(dirtyNow);
  const carriedSet = new Set(carried);
  const add = new Set<string>();
  for (const p of dirtyNow) if (!carriedSet.has(p) && stageable(p)) add.add(p);
  for (const p of input.touched) if (dirtySet.has(p) && stageable(p)) add.add(p);
  return { addSet: [...add].sort(), carried: [...carried].sort(), dirtyNow };
}

/** `jevcode <slug> step <n>: <summary60>` — one line, always. */
export function commitMessage(slug: string, step: number, summary: string): string {
  const oneLine = summary.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const clipped = oneLine.length > SUMMARY_CHARS ? oneLine.slice(0, SUMMARY_CHARS) : oneLine;
  return `jevcode ${slug} step ${step}: ${clipped}`;
}

function chunk(paths: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < paths.length; i += size) out.push([...paths.slice(i, i + size)]);
  return out;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return (line ?? '').trim().slice(0, 200);
}

/** git said the index held nothing — not an error, the same outcome as an empty `addSet`. */
function nothingToCommit(stdout: string, stderr: string): boolean {
  return /nothing (added )?to commit|no changes added to commit|nothing to commit, working tree clean/i.test(`${stdout}\n${stderr}`);
}

export interface CommitStepOptions {
  addSet: readonly string[];
  identity: CommitIdentity;
  slug: string;
  step: number;
  summary: string;
}

export type CommitStepResult = { ok: true; commit: string | null } | { ok: false; reason: string };

/**
 * Stage `addSet` and commit it under the harness's identity. `addSet` empty → no commit, no error.
 *
 * `--literal-pathspecs` is required for the same reason `restoreFromHead` uses it
 * (`src/workspace/git.ts:226-234`): a recorded path such as `pages/[slug].tsx` is a GLOB pathspec
 * otherwise and would stage `pages/s.tsx` instead. It goes before the subcommand, where git wants
 * it. `add -A -- <paths>` also stages deletions, which is intended.
 *
 * No `--no-verify`: `GIT_BASE_FLAGS` passes `-c core.hooksPath=/dev/null` on the command line,
 * which outranks every config file including a worktree-local `core.hooksPath`, so no hook of any
 * kind has a path to run from and the flag would skip nothing that is not already unreachable.
 * `orchestrate.commitNoVerify` was deliberately deleted from the design for exactly this reason.
 */
export async function commitStep(runGit: RunGit, dir: string, opts: CommitStepOptions): Promise<CommitStepResult> {
  const paths = [...new Set(opts.addSet)].filter(stageable).sort();
  if (paths.length === 0) return { ok: true, commit: null };

  for (const part of chunk(paths, ADD_SET_CHUNK)) {
    const add = await runGit(dir, [LITERAL_PATHSPECS_FLAG, 'add', '-A', '--', ...part]);
    if (!add.ok) return { ok: false, reason: `git add failed: ${firstLine(add.stderr) || firstLine(add.stdout) || `exit ${String(add.exitCode)}`}` };
  }

  const message = commitMessage(opts.slug, opts.step, opts.summary);
  const commit = await runGit(dir, [
    '-c', `user.name=${opts.identity.name}`,
    '-c', `user.email=${opts.identity.email}`,
    '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', message,
  ]);
  if (!commit.ok) {
    if (nothingToCommit(commit.stdout, commit.stderr)) return { ok: true, commit: null };
    return { ok: false, reason: `git commit failed: ${firstLine(commit.stderr) || firstLine(commit.stdout) || `exit ${String(commit.exitCode)}`}` };
  }

  const head = await runGit(dir, ['rev-parse', 'HEAD']);
  const sha = head.stdout.trim();
  return { ok: true, commit: head.ok && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null };
}

/**
 * `git reset --soft HEAD~1` — used ONLY by `[x] drop --uncommit` (§2.6). Never part of the normal
 * path: `/undo` inside a child works on the checkpoint store's pre/post images, not on git.
 */
export async function uncommitLast(runGit: RunGit, dir: string): Promise<{ ok: boolean; reason?: string }> {
  const count = await runGit(dir, ['rev-list', '--count', 'HEAD']);
  const n = Number.parseInt(count.stdout.trim(), 10);
  if (!count.ok || !Number.isFinite(n)) return { ok: false, reason: 'HEAD has no commits to undo' };
  if (n < 2) return { ok: false, reason: 'the branch has one commit: there is nothing to reset onto' };
  const res = await runGit(dir, ['reset', '--soft', 'HEAD~1']);
  if (!res.ok) return { ok: false, reason: `git reset --soft failed: ${firstLine(res.stderr) || `exit ${String(res.exitCode)}`}` };
  return { ok: true };
}

/** The sha256 of a `SyncedDirtyEntry`'s recorded bytes, for callers building a fixture or a manifest. */
export function syncedDirtyEntry(path: string, bytes: Buffer, mode: number): SyncedDirtyEntry {
  return { path, sha256: sha256Hex(bytes), mode: mode & 0o7777 };
}
