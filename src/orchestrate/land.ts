/**
 * The dock, the land attempt and the landing queue
 * (docs/ORCHESTRATION-DESIGN.md §5.2 [G3] [G18] [D14] and §5.4 [D8]; §8.2 wave D3 item 22).
 *
 * Two halves, and the split between them is the point:
 *
 *  (a) a PURE reducer over `{ agents, landed, head, attempts }` producing `LandStep`s — topological
 *      over `dependsOn` (prelude agents first), then by Jev's rank score descending, then by slug;
 *      at most `maxKicks` kicks per agent, then a park; `settle` when nothing is attemptable and
 *      nothing is in flight. No git at all, so the ordering, the kick bound and the settle are
 *      unit-testable without a repository.
 *
 *  (b) the effects, each a small function over the injected `RunGit` seam.
 *
 * Three normative details the effects exist to get right:
 *
 *  [G3] Verify and merge a PINNED SHA, never a ref. `<commonDir>` is a writable root for a linked
 *       worktree and the git denies do not cover `refs/**`, so a sibling's sandboxed command can
 *       move a branch between the verify and the merge. `pinBranch` resolves once; `recheckPin`
 *       hard-refuses with "the branch moved during verification"; `mergePinned` refuses anything
 *       that is not a hex object name before git ever sees it.
 *
 *  [D14] `reset --hard` does NOT restore the dock — it leaves exactly the untracked `dist/`,
 *       `.pytest_cache`, coverage and `*.tsbuildinfo` the verify commands just wrote, and the next
 *       agent's `git merge` can itself refuse on an untracked file it would overwrite.
 *       `restoreDock` is `reset --hard` THEN a scoped `clean -fdx -e …`, whose exclusions are
 *       `syncedIgnored ∪ dockCleanExclude` — or the clean would delete the dock's `.env` and
 *       re-cost every `node_modules` install.
 *
 *  [D8] No fetch, and no unnamespaced branch. An agent worktree shares the common dir with the
 *       dock worktree, so `jevcode/dock-<runId8>` is already visible there and the rebase names it
 *       directly. `rebaseOnDock` refuses any branch outside the `jevcode/` namespace, so a repo
 *       that already has a branch called `dock` is untouched (corner row 58).
 *
 * The non-obvious invariant: `land.jsonl` is append-only with ONE writer by construction, and the
 * thing that makes that true is `land.lock` (O_EXCL + pid liveness, the `acquireRunLock` recipe of
 * `src/session/lock.ts:91`, reimplemented here because §8.1 rule 1 forbids importing `src/session/**`).
 * A second acquirer refuses and names the holder; it never waits and never steals a live lock.
 */
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isJsonObject, parseJson } from '../core/json.js';
import { LAND_LOG_LINE_BYTES } from '../core/limits.js';
import type { AgentState, Clock, LandAttempt, RunGit, SplitPolicy } from './types.js';

// ---------------------------------------------------------------------------------------
// (a) The pure LandQueue reducer (§5.2)
// ---------------------------------------------------------------------------------------

export interface QueueAgent {
  slug: string;
  state: AgentState;
  dependsOn: readonly string[];
  branch: string | null;
  /** §5.5's Score; null when Jev was not asked (`critic: 'off'`, or every fallback path) */
  score: number | null;
  kicks: number;
}

export interface LandQueueState {
  agents: readonly QueueAgent[];
  landed: readonly string[];
  head: string;
  attempts: readonly LandAttempt[];
  /** the slug whose attempt is in flight (the lock holder's subject); null between attempts */
  holding: string | null;
}

export type LandStep =
  | { kind: 'attempt'; slug: string }
  | { kind: 'kick'; slug: string; reason: string }
  | { kind: 'park'; slug: string; reason: string }
  | { kind: 'settle'; landed: readonly string[]; parked: readonly string[]; dropped: readonly string[] };

/** An agent that has finished its work and has a branch to land. */
const ATTEMPTABLE: ReadonlySet<AgentState> = new Set<AgentState>(['done']);
/** A failed attempt that a kick may still rescue (§5.4). */
const RETRYABLE: ReadonlySet<AgentState> = new Set<AgentState>(['conflicted', 'failed-verify']);
/** States from which an agent will never land, so a dependant must stop waiting for it. */
const TERMINAL_UNLANDED: ReadonlySet<AgentState> = new Set<AgentState>(['parked', 'dropped', 'crashed', 'failed-start']);
/** The queue is settled only when every agent has reached one of these. */
const SETTLED: ReadonlySet<AgentState> = new Set<AgentState>(['landed', 'parked', 'dropped', 'crashed', 'failed-start']);

/** Longest dependency chain below `slug`, bounded so a cyclic `dependsOn` cannot hang the sort. */
function depthOf(slug: string, by: ReadonlyMap<string, QueueAgent>, seen: ReadonlySet<string> = new Set()): number {
  if (seen.has(slug)) return 0;
  const a = by.get(slug);
  if (a === undefined || a.dependsOn.length === 0) return 0;
  const next = new Set(seen);
  next.add(slug);
  let best = 0;
  for (const d of a.dependsOn) {
    const n = 1 + depthOf(d, by, next);
    if (n > best) best = n;
  }
  return best;
}

/** §5.2's order: topological (prelude agents first), then score descending, then slug. */
export function queueOrder(agents: readonly QueueAgent[]): QueueAgent[] {
  const by = new Map(agents.map((a) => [a.slug, a]));
  const depth = new Map(agents.map((a) => [a.slug, depthOf(a.slug, by)]));
  return [...agents].sort((x, y) => {
    const dx = depth.get(x.slug) ?? 0;
    const dy = depth.get(y.slug) ?? 0;
    if (dx !== dy) return dx - dy;
    const sx = x.score ?? Number.NEGATIVE_INFINITY;
    const sy = y.score ?? Number.NEGATIVE_INFINITY;
    if (sx !== sy) return sy - sx;
    return x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0;
  });
}

function lastAttempt(state: LandQueueState, slug: string): LandAttempt | null {
  for (let i = state.attempts.length - 1; i >= 0; i--) {
    const a = state.attempts[i];
    if (a !== undefined && a.slug === slug) return a;
  }
  return null;
}

/** Why this agent needs a kick, in the words §4.8 prints. */
function failureReason(state: LandQueueState, a: QueueAgent): string {
  const last = lastAttempt(state, a.slug);
  if (a.state === 'conflicted') {
    const paths = last?.conflicts ?? [];
    return paths.length === 0 ? 'the merge conflicted' : `conflicts with the dock in ${paths.slice(0, 3).join(', ')}`;
  }
  if (last?.rule !== undefined && last.rule !== '') return last.rule;
  return 'verification failed after a clean merge';
}

/**
 * The next step, or null when there is nothing to do YET — an attempt is in flight, or an agent
 * is still working, or a dependency may still land. One step at a time: the caller performs the
 * step, folds the outcome back in with `applyLandResult` (an attempt) or `applyLandStep` (a kick
 * or a park), and asks again. `settle` comes only when every agent has finished for good.
 */
export function nextLandStep(state: LandQueueState, policy: Pick<SplitPolicy, 'maxKicks'>): LandStep | null {
  if (state.holding !== null) return null;
  if (state.agents.some((a) => a.state === 'landing')) return null;

  const landed = new Set(state.landed);
  const by = new Map(state.agents.map((a) => [a.slug, a]));

  for (const a of queueOrder(state.agents)) {
    if (RETRYABLE.has(a.state)) {
      const reason = failureReason(state, a);
      if (a.kicks < policy.maxKicks) return { kind: 'kick', slug: a.slug, reason };
      return { kind: 'park', slug: a.slug, reason: `${reason} — no kicks left (${a.kicks} of ${policy.maxKicks})` };
    }
    if (!ATTEMPTABLE.has(a.state)) continue;
    const blocked = a.dependsOn.filter((d) => !landed.has(d));
    if (blocked.length === 0) return { kind: 'attempt', slug: a.slug };
    // A dependency that can never land would wedge the queue: park the dependant with the fact.
    const dead = blocked.find((d) => {
      const dep = by.get(d);
      return dep === undefined || TERMINAL_UNLANDED.has(dep.state);
    });
    if (dead !== undefined) return { kind: 'park', slug: a.slug, reason: `its dependency ${dead} did not land` };
  }

  // Nothing to do right now is NOT the same as settled: an agent still working (or still waiting
  // for a dependency that may yet land) keeps the queue open.
  if (state.agents.some((a) => !SETTLED.has(a.state))) return null;

  const parked: string[] = [];
  const dropped: string[] = [];
  for (const a of state.agents) {
    if (a.state === 'parked') parked.push(a.slug);
    else if (a.state === 'dropped' || a.state === 'crashed' || a.state === 'failed-start') dropped.push(a.slug);
  }
  return { kind: 'settle', landed: [...state.landed], parked, dropped };
}

function patchAgent(state: LandQueueState, slug: string, patch: (a: QueueAgent) => QueueAgent): QueueAgent[] {
  return state.agents.map((a) => (a.slug === slug ? patch(a) : a));
}

/**
 * Fold a non-attempt step back into the state: an `attempt` takes the queue's one in-flight slot,
 * a `kick` spends one of `maxKicks` and returns the agent to the engine, a `park` ends it.
 */
export function applyLandStep(state: LandQueueState, step: LandStep): LandQueueState {
  switch (step.kind) {
    case 'attempt':
      return { ...state, holding: step.slug, agents: patchAgent(state, step.slug, (a) => ({ ...a, state: 'landing' })) };
    case 'kick':
      return { ...state, agents: patchAgent(state, step.slug, (a) => ({ ...a, state: 'kicked', kicks: a.kicks + 1 })) };
    case 'park':
      return { ...state, agents: patchAgent(state, step.slug, (a) => ({ ...a, state: 'parked' })) };
    case 'settle':
      return state;
  }
}

/** The agent state one attempt outcome implies. A hard-rule refusal parks in `failed-verify`. */
function stateFor(outcome: LandAttempt['outcome']): AgentState {
  if (outcome === 'landed') return 'landed';
  if (outcome === 'conflicted') return 'conflicted';
  return 'failed-verify';
}

/** Append one attempt and release the in-flight slot. The head moves only on a landed merge. */
export function applyLandResult(state: LandQueueState, attempt: LandAttempt): LandQueueState {
  const next = stateFor(attempt.outcome);
  const landed = attempt.outcome === 'landed' && !state.landed.includes(attempt.slug) ? [...state.landed, attempt.slug] : [...state.landed];
  return {
    agents: patchAgent(state, attempt.slug, (a) => ({ ...a, state: next })),
    landed,
    head: attempt.outcome === 'landed' && attempt.commit !== undefined && attempt.commit !== '' ? attempt.commit : state.head,
    attempts: [...state.attempts, attempt],
    holding: state.holding === attempt.slug ? null : state.holding,
  };
}

// ---------------------------------------------------------------------------------------
// (b) The effects, behind the RunGit seam
// ---------------------------------------------------------------------------------------

/** A git object name. [G3]: everything below merges one of these and never a ref. */
const SHA_RE = /^[0-9a-f]{7,64}$/;
/** §2.2's slug shape — a ref component, never a path and never an option. */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A revision or range the harness itself built. */
const REV_RE = /^[A-Za-z0-9][A-Za-z0-9._/^~{}-]*$/;

function splitNul(out: string): string[] {
  return out.split('\0').filter((s) => s !== '');
}

/** [G3] Resolve `refs/heads/jevcode/<slug>` to an object name ONCE; null when there is no such branch. */
export async function pinBranch(runGit: RunGit, dockDir: string, slug: string): Promise<string | null> {
  if (!SLUG_RE.test(slug)) return null;
  const r = await runGit(dockDir, ['rev-parse', '--verify', `refs/heads/jevcode/${slug}^{commit}`]);
  const sha = r.stdout.trim();
  return r.ok && SHA_RE.test(sha) ? sha : null;
}

/**
 * [G3] The re-check immediately before the merge: the branch must still resolve to the sha that
 * was verified. A mismatch is a HARD refusal — the dock is left untouched and the agent is
 * `failed-verify` with this rule name.
 */
export async function recheckPin(runGit: RunGit, dockDir: string, slug: string, pinned: string): Promise<{ ok: true } | { ok: false; reason: string; now: string | null }> {
  const now = await pinBranch(runGit, dockDir, slug);
  if (now === pinned) return { ok: true };
  return { ok: false, reason: 'the branch moved during verification', now };
}

/**
 * `git merge --no-ff --no-edit <pinned>`; on conflict the conflicting paths are read from
 * `--diff-filter=U` and the merge is aborted, so the dock never keeps a failing merge. A `pinned`
 * that is not an object name is refused before git sees it (a ref here would reopen the [G3]
 * TOCTOU window).
 */
export async function mergePinned(runGit: RunGit, dockDir: string, pinned: string): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
  if (!SHA_RE.test(pinned)) return { ok: false, conflicts: [] };
  const merge = await runGit(dockDir, ['merge', '--no-ff', '--no-edit', pinned]);
  if (merge.ok) return { ok: true };
  const u = await runGit(dockDir, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const conflicts = u.ok ? splitNul(u.stdout).sort() : [];
  await runGit(dockDir, ['merge', '--abort']);
  return { ok: false, conflicts };
}

/**
 * [D14] Put the dock back exactly as it was: `reset --hard <previousDockHead>` AND a scoped
 * `clean -fdx`, whose `-e` patterns are `syncedIgnored ∪ orchestrate.dockCleanExclude`. The `-x`
 * is required (the artefacts are gitignored) and is exactly why the exclusions are.
 */
export async function restoreDock(runGit: RunGit, dockDir: string, previousHead: string, exclude: readonly string[]): Promise<void> {
  if (SHA_RE.test(previousHead)) await runGit(dockDir, ['reset', '--hard', previousHead]);
  const args = ['clean', '-fdx'];
  for (const e of exclude) {
    if (e === '' || e.includes('\0') || e.startsWith('-')) continue;
    args.push('-e', e);
  }
  await runGit(dockDir, args);
}

/**
 * [D8] The kick's rebase, performed from the AGENT worktree against the dock branch it already
 * sees through the shared common dir. Never `git fetch . …:refs/heads/dock` — that would mint a
 * repo-global `dock` branch, which §2.2 forbids as a slug for exactly this reason. Any branch
 * outside the `jevcode/` namespace is refused here rather than rebased onto.
 */
export async function rebaseOnDock(runGit: RunGit, agentDir: string, dockBranch: string): Promise<{ ok: boolean; conflicts: string[] }> {
  if (!dockBranch.startsWith('jevcode/') || !REV_RE.test(dockBranch)) return { ok: false, conflicts: [] };
  const r = await runGit(agentDir, ['rebase', dockBranch]);
  if (r.ok) return { ok: true, conflicts: [] };
  const u = await runGit(agentDir, ['diff', '--name-only', '--diff-filter=U', '-z']);
  const conflicts = u.ok ? splitNul(u.stdout).sort() : [];
  await runGit(agentDir, ['rebase', '--abort']);
  return { ok: false, conflicts };
}

/** `git diff --name-only <from>..<to>` — the §5.3 / §5.5 input. Empty when git refused. */
export async function diffNames(runGit: RunGit, dir: string, from: string, to: string): Promise<string[]> {
  if (!REV_RE.test(from) || !REV_RE.test(to)) return [];
  const r = await runGit(dir, ['diff', '--name-only', '-z', `${from}..${to}`, '--']);
  return r.ok ? splitNul(r.stdout).sort() : [];
}

/** `git rev-list --count <from>..<to>`; 0 both for corner row 37's empty branch and for a refusal. */
export async function revListCount(runGit: RunGit, dir: string, from: string, to: string): Promise<number> {
  if (!REV_RE.test(from) || !REV_RE.test(to)) return 0;
  const r = await runGit(dir, ['rev-list', '--count', `${from}..${to}`]);
  const n = Number.parseInt(r.stdout.trim(), 10);
  return r.ok && Number.isFinite(n) && n >= 0 ? n : 0;
}

// ---------------------------------------------------------------------------------------
// The land lock and the append-only log (§5.2, corner row 43)
// ---------------------------------------------------------------------------------------

export const ORCHESTRATE_SUBDIR = 'orchestrate';
export const LAND_LOCK_FILE = 'land.lock';
export const LAND_LOG_FILE = 'land.jsonl';

export interface LandLock {
  pid: number;
  startedAt: string;
  host: string;
}

export interface LandLockHandle {
  path: string;
  lock: LandLock;
}

export type AcquireLandLockResult =
  | { ok: true; handle: LandLockHandle; replaced: LandLock | null }
  | { ok: false; reason: string; holder: LandLock | null };

export interface AcquireLandLockOptions {
  pid?: number;
  /** the device label; '' means "this device", which is correct for a device-local run dir */
  host?: string;
  clock?: Clock;
  isAlive?: (pid: number) => boolean;
}

export function landLockPath(runDir: string): string {
  return join(runDir, ORCHESTRATE_SUBDIR, LAND_LOCK_FILE);
}

export function landLogPath(runDir: string): string {
  return join(runDir, ORCHESTRATE_SUBDIR, LAND_LOG_FILE);
}

function errnoCode(e: unknown): string | null {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : null;
}

/** `process.kill(pid, 0)`: success → alive; `ESRCH` → gone; `EPERM` → alive (someone else's process). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoCode(e) === 'EPERM';
  }
}

export function parseLandLock(text: string): LandLock | null {
  const parsed = parseJson(text);
  if (!parsed.ok || !isJsonObject(parsed.value)) return null;
  const pid = parsed.value['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  const startedAt = parsed.value['startedAt'];
  const host = parsed.value['host'];
  return { pid, startedAt: typeof startedAt === 'string' ? startedAt : '', host: typeof host === 'string' ? host : '' };
}

export async function readLandLock(runDir: string): Promise<LandLock | null> {
  try {
    return parseLandLock(await readFile(landLockPath(runDir), 'utf8'));
  } catch {
    return null;
  }
}

/** Corner row 43's message: the refusal names the holder, and nothing waits. */
export function landLockHeldMessage(lock: LandLock): string {
  return `the landing queue is held by pid ${lock.pid} since ${lock.startedAt || 'unknown'} (another jevcode?); it retries after the queue step`;
}

/**
 * O_EXCL + pid liveness — one writer by construction, which is what makes `land.jsonl`
 * append-only and auditable. A live foreign lock REFUSES (naming the holder); a stale one (dead
 * pid, or another host) is replaced through write-to-temp + rename, so a concurrent reader never
 * sees a torn file. Reimplemented from `src/session/lock.ts:91`, not imported: §8.1 rule 1.
 */
export async function acquireLandLock(runDir: string, opts: AcquireLandLockOptions = {}): Promise<AcquireLandLockResult> {
  const pid = opts.pid ?? process.pid;
  const host = opts.host ?? '';
  const clock = opts.clock ?? ((): number => Date.now());
  const isAlive = opts.isAlive ?? isPidAlive;
  const path = landLockPath(runDir);
  const lock: LandLock = { pid, startedAt: new Date(clock()).toISOString(), host };
  const text = `${JSON.stringify(lock)}\n`;

  await mkdir(join(runDir, ORCHESTRATE_SUBDIR), { recursive: true });
  try {
    await writeFile(path, text, { flag: 'wx', mode: 0o600 });
    return { ok: true, handle: { path, lock }, replaced: null };
  } catch (e) {
    if (errnoCode(e) !== 'EEXIST') throw e;
  }

  const existing = await readLandLock(runDir);
  if (existing !== null && existing.pid !== pid && existing.host === host && isAlive(existing.pid)) {
    return { ok: false, reason: landLockHeldMessage(existing), holder: existing };
  }
  const tmp = `${path}.${pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
  return { ok: true, handle: { path, lock }, replaced: existing !== null && existing.pid !== pid ? existing : null };
}

/** Remove the lock, but only when it is still the one this handle wrote. Never throws. */
export async function releaseLandLock(handle: LandLockHandle): Promise<boolean> {
  try {
    const current = parseLandLock(await readFile(handle.path, 'utf8'));
    if (current === null || current.pid !== handle.lock.pid) return false;
    await rm(handle.path, { force: true });
    return true;
  } catch {
    return false;
  }
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function head(attempt: LandAttempt): Record<string, unknown> {
  const o: Record<string, unknown> = {
    at: attempt.at,
    slug: clip(attempt.slug, 120),
    pinned: attempt.pinned,
    dockHead: attempt.dockHead,
    outcome: attempt.outcome,
    kick: attempt.kick,
  };
  if (attempt.commit !== undefined) o['commit'] = attempt.commit;
  if (attempt.rule !== undefined) o['rule'] = clip(attempt.rule, 200);
  return o;
}

/**
 * One `land.jsonl` line, bounded to `LAND_LOG_LINE_BYTES`. The line stays parseable JSON as long
 * as it can: first the verify tails are clipped, then the verify results are reduced to
 * command/ok, then everything but the header is dropped with a `truncated` marker. Only a slug or
 * rule pathologically longer than the whole budget can reach the final byte clip.
 */
export function landLogLine(attempt: LandAttempt, max: number = LAND_LOG_LINE_BYTES): string {
  const full = JSON.stringify(attempt);
  if (byteLen(full) <= max) return full;

  const conflicts = attempt.conflicts ?? [];
  const clipped: Record<string, unknown> = { ...head(attempt) };
  if (attempt.verify !== undefined) {
    clipped['verify'] = attempt.verify.map((v) => ({ command: clip(v.command, 200), ok: v.ok, exitCode: v.exitCode, durationMs: v.durationMs, counts: v.counts, killed: v.killed, tail: v.tail.slice(-3).map((l) => clip(l, 200)) }));
  }
  if (conflicts.length > 0) clipped['conflicts'] = conflicts.slice(0, 8);
  const level2 = JSON.stringify(clipped);
  if (byteLen(level2) <= max) return level2;

  const terse: Record<string, unknown> = { ...head(attempt), truncated: true };
  if (attempt.verify !== undefined) terse['verify'] = attempt.verify.map((v) => ({ command: clip(v.command, 120), ok: v.ok }));
  if (conflicts.length > 0) terse['conflicts'] = conflicts.length;
  const level3 = JSON.stringify(terse);
  if (byteLen(level3) <= max) return level3;

  const minimal = JSON.stringify({ ...head(attempt), truncated: true });
  return byteLen(minimal) <= max ? minimal : Buffer.from(minimal, 'utf8').subarray(0, max).toString('utf8');
}

/** Append one bounded line to `<runDir>/orchestrate/land.jsonl`. The lock holder is the only caller. */
export async function appendLandLog(runDir: string, attempt: LandAttempt, max: number = LAND_LOG_LINE_BYTES): Promise<void> {
  await mkdir(join(runDir, ORCHESTRATE_SUBDIR), { recursive: true });
  await appendFile(landLogPath(runDir), `${landLogLine(attempt, max)}\n`, { mode: 0o600 });
}
