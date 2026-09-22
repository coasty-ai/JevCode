/**
 * Git facts at run start (TUI-DESIGN §12.1, §12.2, D7).
 *
 * `probeGitState` runs the two unsandboxed spawns — `git rev-parse …` and `git --no-optional-locks
 * status --porcelain=v2 …` — through `child_process.execFile` before the sandbox exists, so the
 * seatbelt profile can learn `gitDir`/`gitCommonDir` and `createWorkspace` needs no spawn of its
 * own. Everything else here is pure or spawn-free: the parser of the five-line `rev-parse` probe, the
 * assembly of a `GitState` from the two outputs, the bounded `RunGitMeta` that `run.json` keeps, the
 * `[run] git …` banner text, and the in-process HEAD reader (`readHead`: `<gitDir>/HEAD` + loose ref
 * or `packed-refs`, never `git`) shared by the status zone (`src/tui/useGitHead.ts`) and the
 * per-command `headOid` refresh of `workspace.gitState()` (§12.3).
 */
import { execFile as nodeExecFile } from 'node:child_process';
import type { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';

import type { GitHead, GitState, RunGitMeta } from '../core/types.js';
import { GIT_BASE_FLAGS, GIT_ENV, statusPorcelainV2 } from './git.js';
import type { PorcelainV2 } from './git.js';

/** TUI-DESIGN §12.1: options of the probe (`execFile` injectable for the spawn-count test; default timeout 2 s). */
export interface ProbeGitOptions {
  timeoutMs?: number;
  execFile?: typeof execFile;
  /** per-spawn stdout cap (default PROBE_MAX_BUFFER); an overflow is a failed status, never a torn one. Tests shrink it. */
  maxBuffer?: number;
}

/** TUI-DESIGN §12.1: the five lines of `git rev-parse --is-inside-work-tree --show-prefix --absolute-git-dir --git-common-dir --show-toplevel`. */
export interface RevParseFacts {
  insideWorkTree: boolean;
  /** `sub/dir/` with a trailing slash, '' at the top level */
  prefix: string;
  gitDir: string;
  /** a relative `--git-common-dir` is joined onto the probed root (absolute whenever `root` is) */
  commonDir: string;
  topLevel: string;
  /** `gitDir !== commonDir`: a linked worktree of another checkout */
  linkedWorktree: boolean;
}

const PROBE_ARGS: readonly string[] = ['rev-parse', '--is-inside-work-tree', '--show-prefix', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'];
const STATUS_ARGS: readonly string[] = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'];

/** TUI-DESIGN §12.1: the exact argument vectors of the two spawns (shared with the wave-2 probe and its tests). */
export const GIT_PROBE_ARGS: Readonly<{ revParse: readonly string[]; status: readonly string[] }> = { revParse: PROBE_ARGS, status: STATUS_ARGS };

/** TUI-DESIGN §12.1: `probeGitState(root, { timeoutMs: 2000 })` — the default per-spawn timeout. */
export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
/**
 * TUI-DESIGN §12.1: the stdout cap of one spawn. A `status -z --untracked-files=all` listing beyond it (≈150k
 * untracked paths, e.g. an un-ignored `node_modules`) makes execFile fail the spawn with
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`; the WHOLE listing is then dropped and the probe reports the dirty snapshot as
 * unknown (`dirtyUnknownState`) — never as an empty, clean tree.
 */
export const PROBE_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * TUI-DESIGN §12.1: the argument vector of one probe spawn. The neutralising `-c` flags of
 * `workspace/git.ts` (DESIGN §8 defence 2) come first: these spawns are unsandboxed and `git status`
 * would otherwise run a `core.fsmonitor` or hook planted in the workspace's `.git/config` with the
 * harness's own environment.
 */
export function probeArgv(which: keyof typeof GIT_PROBE_ARGS): string[] {
  return [...GIT_BASE_FLAGS, ...GIT_PROBE_ARGS[which]];
}

/**
 * TUI-DESIGN §12.1: the child env of the two spawns — `GIT_ENV` (no system/global config, no prompts,
 * no optional locks, `LC_ALL=C`) plus the harness `PATH` so the user's git is found; nothing else of
 * `process.env` (keys included) reaches the child.
 */
export function probeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const path = env['PATH'];
  return { ...(typeof path === 'string' && path.length > 0 ? { PATH: path } : {}), ...GIT_ENV };
}

/** `overflow` = the stdout cap (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`); `spawn` = git could not be started at all. */
type SpawnFailure = 'none' | 'spawn' | 'timeout' | 'exit' | 'overflow';

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  failure: SpawnFailure;
}

function saneTimeout(ms: number | undefined): number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(Math.floor(ms), 2 ** 31 - 1) : DEFAULT_PROBE_TIMEOUT_MS;
}

function saneBuffer(bytes: number | undefined): number {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : PROBE_MAX_BUFFER;
}

function textOf(v: unknown): string {
  return typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString('utf8') : '';
}

/** One unsandboxed spawn; never rejects — every failure is classified for the `GitState.reason`. */
function spawnGit(impl: typeof execFile, cwd: string, args: readonly string[], timeoutMs: number, maxBuffer: number): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (o: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(o);
    };
    try {
      impl('git', [...args], { cwd, env: probeEnv(), timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
        const out = textOf(stdout);
        const errText = textOf(stderr);
        if (err === null) {
          done({ stdout: out, stderr: errText, exitCode: 0, failure: 'none' });
          return;
        }
        if (err.killed === true || (typeof err.signal === 'string' && err.signal.length > 0)) {
          done({ stdout: out, stderr: errText, exitCode: null, failure: 'timeout' });
          return;
        }
        if (typeof err.code === 'number') {
          done({ stdout: out, stderr: errText, exitCode: err.code, failure: 'exit' });
          return;
        }
        // Node reports the cap with `killed` undefined and a string code: the listing is incomplete, not absent
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          done({ stdout: out, stderr: errText, exitCode: null, failure: 'overflow' });
          return;
        }
        // 'ENOENT' / 'EACCES' from spawn itself (git not on PATH)
        done({ stdout: out, stderr: errText, exitCode: null, failure: 'spawn' });
      });
    } catch (e) {
      done({ stdout: '', stderr: e instanceof Error ? e.message : String(e), exitCode: null, failure: 'spawn' });
    }
  });
}

/**
 * TUI-DESIGN §12.1 (D7, A140): the two unsandboxed spawns, run concurrently so the probe costs
 * `max(a, b)` and the spawn count is exactly two for every repository shape — (a) `git rev-parse
 * --is-inside-work-tree --show-prefix --absolute-git-dir --git-common-dir --show-toplevel`, (b)
 * `git --no-optional-locks status --porcelain=v2 --branch --untracked-files=all -z`. The probe's cwd
 * is `realpath(root)` (git prints `--absolute-git-dir` realpath'd, so a relative `--git-common-dir`
 * must be joined onto the same canonical form or a main tree under a symlink — macOS's `/tmp` — reads
 * as a linked worktree). Reasons: `git-missing` when git cannot be spawned, `not-a-repo` when
 * `rev-parse` fails or prints garbage (a missing `root` too; the workspace error surfaces from
 * `createWorkspace`), `bare` when the repository has no work tree, `timeout` when `rev-parse` outlives
 * `timeoutMs`. With good `rev-parse` facts but a status that did not finish, failed, overflowed the
 * cap or came back torn the dirty snapshot is UNKNOWN: `dirtyUnknownState` keeps the facts (the
 * seatbelt still learns the git dirs) and fails closed (`repo: false`) — never an empty, clean-looking
 * dirty set. Never rejects.
 */
export async function probeGitState(root: string, o: ProbeGitOptions = {}): Promise<GitState> {
  const impl = o.execFile ?? nodeExecFile;
  const timeoutMs = saneTimeout(o.timeoutMs);
  const maxBuffer = saneBuffer(o.maxBuffer);
  const probedAt = new Date().toISOString();
  const t0 = performance.now();
  const at = (): { probedAt: string; probeMs: number } => ({ probedAt, probeMs: Math.round(performance.now() - t0) });
  let cwd: string;
  try {
    cwd = await realpath(root);
    if (!(await stat(cwd)).isDirectory()) return notRepoState('not-a-repo', at());
  } catch {
    return notRepoState('not-a-repo', at());
  }
  const [rev, st] = await Promise.all([spawnGit(impl, cwd, probeArgv('revParse'), timeoutMs, maxBuffer), spawnGit(impl, cwd, probeArgv('status'), timeoutMs, maxBuffer)]);
  if (rev.failure === 'spawn') return notRepoState('git-missing', at());
  if (rev.failure === 'timeout') return notRepoState('timeout', at());
  // a bare repository exits 128 (`--show-toplevel` fails) after printing four usable lines, so parse before judging the exit code
  const facts = parseRevParse(rev.stdout, cwd);
  if (facts === null) return notRepoState('not-a-repo', at());
  if (!facts.insideWorkTree) return notRepoState('bare', at());
  if (st.failure !== 'none') return dirtyUnknownState(facts, at());
  const status: PorcelainV2 = statusPorcelainV2(st.stdout);
  if (status.torn) return dirtyUnknownState(facts, at());
  return buildGitState(facts, status, at());
}

function cleanLine(s: string | undefined): string {
  return (s ?? '').replace(/\r$/, '').trim();
}

/**
 * TUI-DESIGN §12.1: parse the `rev-parse` probe's stdout. Returns null when the output is not the
 * five expected lines (git missing, not a repository, torn output): the caller records the reason.
 * A bare repository prints `false` on the first line (and `--show-toplevel` fails, so the fifth
 * line is absent) and is reported with `insideWorkTree: false`. `root` is the probe's `cwd`: a
 * relative `--git-common-dir` is joined onto it lexically (no `process.cwd()`), so the probe passes
 * the canonical (realpath'd) root — `--absolute-git-dir` is realpath'd by git, and the two must agree
 * for `linkedWorktree` to be meaningful — and a relative `root` yields a relative `commonDir`.
 */
export function parseRevParse(stdout: string, root: string): RevParseFacts | null {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  const lines = stdout.split('\n').map(cleanLine);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const inside = lines[0];
  if (inside !== 'true' && inside !== 'false') return null;
  if (inside === 'false') {
    // bare repository: `--show-prefix`/`--show-toplevel` print nothing useful
    const bareGitDir = cleanLine(lines[2] ?? lines[1]);
    if (bareGitDir.length === 0) return null;
    const bareCommon = cleanLine(lines[3] ?? '') || bareGitDir;
    return { insideWorkTree: false, prefix: '', gitDir: bareGitDir, commonDir: isAbsolute(bareCommon) ? normalize(bareCommon) : join(root, bareCommon), topLevel: '', linkedWorktree: false };
  }
  if (lines.length < 5) return null;
  const rawPrefix = lines[1]!;
  const gitDir = lines[2]!;
  const rawCommon = lines[3]!;
  const topLevel = lines[4]!;
  if (gitDir.length === 0 || topLevel.length === 0 || !isAbsolute(gitDir) || !isAbsolute(topLevel)) return null;
  if (rawPrefix.startsWith('/') || rawPrefix.split('/').includes('..')) return null;
  const prefix = rawPrefix.length === 0 ? '' : rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;
  const commonDir = rawCommon.length === 0 ? gitDir : isAbsolute(rawCommon) ? normalize(rawCommon) : join(root, rawCommon);
  return { insideWorkTree: true, prefix, gitDir, commonDir, topLevel, linkedWorktree: normalize(gitDir) !== commonDir };
}

/** TUI-DESIGN §12.1: the `GitState` of a directory that is not (usably) a repository. */
export function notRepoState(reason: NonNullable<GitState['reason']>, o: { probedAt: string; probeMs: number }): GitState {
  return {
    repo: false,
    reason,
    gitDir: null,
    commonDir: null,
    topLevel: null,
    prefix: '',
    linkedWorktree: false,
    head: null,
    upstream: null,
    ahead: null,
    behind: null,
    dirty: { modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] },
    probedAt: o.probedAt,
    probeMs: sane(o.probeMs),
  };
}

/**
 * TUI-DESIGN §12.1 (fix-pass findings 2–3): `rev-parse` succeeded but the status listing did not — it timed out,
 * exited non-zero (corrupt index, `bad object HEAD`), overflowed `PROBE_MAX_BUFFER` or came back torn. The dirty
 * snapshot is unknown, so the tree is reported as NOT recoverable (`repo: false`) rather than as clean: an empty
 * dirty set would attribute every pre-existing modification to the run, record `cleanAtStart: true` for files the
 * user had changed, print `git HEAD · clean` and disable the `--resume` drift warning. The rev-parse facts are kept
 * so `createEngine` still hands `gitDir`/`commonDir` to the seatbelt (a linked worktree keeps committing) while
 * `createWorkspace` treats the tree as non-git (file actions only). `reason: 'timeout'` is the closest member of
 * today's union for every such outcome; O1 has been asked for `'status-failed'` / `dirtyUnknown?: boolean` so the
 * banner and the undo planner can name the cause (see the O5 fix-pass report).
 */
export function dirtyUnknownState(rev: RevParseFacts, o: { probedAt: string; probeMs: number }): GitState {
  return { ...buildGitState(rev, null, o), repo: false, reason: 'timeout' };
}

function sane(ms: number): number {
  return Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

/**
 * TUI-DESIGN §12.1: assemble the run-start `GitState` from the two probe outputs. A bare repository
 * (`insideWorkTree: false`) is reported as `repo: false, reason: 'bare'` because nothing in it can be
 * edited or restored. A null `status` yields the facts with an empty dirty set — callers that mean
 * "the listing is unknown" use `dirtyUnknownState` instead.
 */
export function buildGitState(rev: RevParseFacts, status: PorcelainV2 | null, o: { probedAt: string; probeMs: number }): GitState {
  if (!rev.insideWorkTree) return notRepoState('bare', o);
  const dirty = status?.dirty ?? { modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] };
  return {
    repo: true,
    gitDir: rev.gitDir,
    commonDir: rev.commonDir,
    topLevel: rev.topLevel,
    prefix: rev.prefix,
    linkedWorktree: rev.linkedWorktree,
    head: status?.head ?? null,
    upstream: status?.upstream ?? null,
    ahead: status?.ahead ?? null,
    behind: status?.behind ?? null,
    dirty,
    probedAt: o.probedAt,
    probeMs: sane(o.probeMs),
  };
}

/**
 * TUI-DESIGN §12.1: what `run.json` keeps of the probe — no paths, no entries, the HEAD oid for §12.4's undo rule;
 * `ahead`/`behind` and `dirtyAtStart.unmerged` (§12.2, the additive wave-2 fields) so the `workspace` event alone
 * renders `↑2 ↓1` and the `warn` level.
 */
export function toRunGitMeta(g: GitState): RunGitMeta {
  return {
    repo: g.repo,
    ...(g.reason !== undefined ? { reason: g.reason } : {}),
    head: g.head,
    upstream: g.upstream,
    linkedWorktree: g.linkedWorktree,
    prefix: g.prefix,
    ahead: g.ahead,
    behind: g.behind,
    dirtyAtStart: { modified: g.dirty.modified, staged: g.dirty.staged, untracked: g.dirty.untracked, unmerged: g.dirty.unmerged },
  };
}

/** TUI-DESIGN §12.1 (P51): the `RunGitMeta.end` block of the run:end re-probe, persisted through `updateMeta({ git })`. */
export function toRunGitMetaEnd(g: GitState): NonNullable<RunGitMeta['end']> {
  return { head: g.head, upstream: g.upstream, ahead: g.ahead, behind: g.behind, dirty: { modified: g.dirty.modified, staged: g.dirty.staged, untracked: g.dirty.untracked } };
}

/** TUI-DESIGN §12.2: the 8-hex abbreviation used in every git line (`7d731c0e`). */
export function shortOid(oid: string): string {
  return oid.slice(0, 8);
}

/** TUI-DESIGN §12.2: the head as the banner and the `--resume` warning print it. */
export function headLabel(head: GitHead | null): string {
  if (head === null) return 'HEAD';
  if (head.kind === 'branch') return head.name;
  if (head.kind === 'detached') return shortOid(head.oid);
  return head.name;
}

/**
 * TUI-DESIGN §12.2: the banner's input is the `workspace` event's `RunGitMeta` (which now carries `ahead`/`behind`
 * and `dirtyAtStart.unmerged`); the optional extras are for a caller holding the full `GitState`: the worktree's
 * main checkout for the linked-worktree line, and `unmerged` overriding `dirtyAtStart.unmerged` (a `run.json`
 * written before the field existed has neither).
 */
export type GitBannerInput = RunGitMeta & { commonDir?: string | null; unmerged?: number };

/** TUI-DESIGN §12.2: `GitState` → banner input (adds ahead/behind, the worktree path and the unmerged count). */
export function bannerInput(g: GitState): GitBannerInput {
  return { ...toRunGitMeta(g), ahead: g.ahead, behind: g.behind, commonDir: g.commonDir, unmerged: g.dirty.unmerged };
}

/**
 * TUI-DESIGN §12.2: the tail of the `git none · …` banner per `GitState.reason`. §12.2 names the not-a-repo and
 * git-missing texts; a bare repository and an incomplete probe have their own (see the O5 report) so the cause is
 * never misreported as "not a git repository". `timeout` covers every `dirtyUnknownState` outcome — a status that
 * timed out, failed or overflowed — until O1 adds a distinct reason.
 */
/**
 * TUI-DESIGN-4 §3.6 (D-V, G6): ONE clause, not two saying the same thing. The old default row said both "changes
 * made by commands are not recoverable" and "/diff compares against step pre-images only" in two different
 * grammars; §12 fixes the wording.
 */
export function notRepoReason(reason: GitState['reason']): string {
  switch (reason) {
    case 'git-missing':
      return 'git not found on PATH — /diff <step> compares pre-images';
    case 'timeout':
      return 'git status failed or timed out — /diff <step> compares pre-images';
    case 'bare':
      return 'bare repository, no work tree — /diff <step> compares pre-images';
    default:
      return 'no repository — changes are not recoverable; /diff <step> compares pre-images';
  }
}

/** TUI-DESIGN §12.2: one `[run] git …` line (the label is added by the item formatter), `warn` only for unmerged paths. */
export function gitBannerLine(git: GitBannerInput, opts: { ascii?: boolean } = {}): { text: string; level: 'info' | 'warn' } {
  const ascii = opts.ascii === true;
  const sep = ascii ? ' - ' : ' · ';
  // §3.6 (G6): `git · no repository — changes are not recoverable; /diff <step> compares pre-images`
  if (!git.repo) return { text: `git${sep}${notRepoReason(git.reason)}`, level: 'info' };
  const head = git.head;
  let text = 'git ';
  if (head === null) text += 'HEAD';
  else if (head.kind === 'detached') text += `detached ${shortOid(head.oid)}`;
  else if (head.kind === 'unborn') text += `${head.name} (unborn, no commits yet)`;
  else text += head.name;
  if (git.linkedWorktree) {
    const common = typeof git.commonDir === 'string' && git.commonDir.length > 0 ? dirname(git.commonDir) : null;
    text += common === null ? ' (linked worktree)' : ` (linked worktree of ${common})`;
  }
  if (git.upstream !== null) {
    const ahead = git.ahead ?? 0;
    const behind = git.behind ?? 0;
    if (ahead > 0) text += ` ${ascii ? '^' : '↑'}${ahead}`;
    if (behind > 0) text += ` ${ascii ? 'v' : '↓'}${behind}`;
  }
  const d = git.dirtyAtStart;
  const parts: string[] = [];
  if (d.modified > 0) parts.push(`${d.modified} modified`);
  if (d.staged > 0) parts.push(`${d.staged} staged`);
  if (d.untracked > 0) parts.push(`${d.untracked} untracked`);
  const unmerged = git.unmerged ?? git.dirtyAtStart.unmerged ?? 0;
  const subdir = git.prefix.length > 0 ? `in subdirectory ${git.prefix} of the repository` : null;
  if (parts.length > 0) text += `${sep}${parts.join(sep)}`;
  else if (subdir === null && unmerged === 0) text += `${sep}clean`;
  if (subdir !== null) text += `${sep}${subdir}`;
  if (unmerged > 0) text += `${sep}working tree has unmerged paths (u) ${ascii ? '-' : '—'} commands may fail on conflict markers`;
  return { text, level: unmerged > 0 ? 'warn' : 'info' };
}

/** TUI-DESIGN §12.2 (P52): the `--resume` warning when HEAD moved since the run started. */
export function headDriftWarning(startedOn: GitHead | null, now: GitHead | null): string {
  return `warning: HEAD was ${headLabel(startedOn)} at run start, now ${headLabel(now)} — the plan may not apply`;
}

/** TUI-DESIGN §12.2: true when two heads name a different commit (or a different ref when no oid is known). */
export function headMoved(a: GitHead | null, b: GitHead | null): boolean {
  if (a === null || b === null) return a !== b;
  const oa = a.kind === 'unborn' ? null : a.oid;
  const ob = b.kind === 'unborn' ? null : b.oid;
  if (oa !== null && ob !== null) return oa !== ob;
  return a.kind !== b.kind || headLabel(a) !== headLabel(b);
}

// ---------------------------------------------------------------------------------------
// TUI-DESIGN §12.2: HEAD without a spawn — `<gitDir>/HEAD` plus the loose ref file or `packed-refs`,
// read in-process (0.0–0.1 ms). Used by the status zone's watcher (`src/tui/useGitHead.ts`) and by
// `workspace.gitState()` after every `run` outcome so §12.3's `headOid` follows a committing command.
// ---------------------------------------------------------------------------------------

/** A symbolic-ref chain deeper than this is treated as unborn rather than followed forever. */
export const MAX_SYMREF_DEPTH = 5;
/**
 * git ≥ 2.45 `--ref-format=reftable` repositories keep this constant in `HEAD`; their refs live in binary tables under
 * `<commonDir>/reftable` that no file read resolves, so `readHead` reports them as unknown (null) and callers keep
 * the probe's head (fix-pass finding 5).
 */
export const REFTABLE_HEAD_REF = 'refs/heads/.invalid';
const HEAD_OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HEADS_PREFIX = 'refs/heads/';
/** parsed `packed-refs` files kept by path; cleared wholesale beyond this many (a run watches one or two git dirs) */
const PACKED_CACHE_MAX = 8;

/** The file reads the head reader needs, injectable for tests; null = missing or unreadable. */
export interface HeadFs {
  readFile(path: string): string | null;
  /** size and mtime of a file (null = missing); lets `resolveRef` reuse a parsed `packed-refs` until the file changes */
  stat?(path: string): { mtimeMs: number; size: number } | null;
}

export const nodeHeadFs: HeadFs = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  stat(path) {
    try {
      const s = statSync(path);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  },
};

/** `ref: refs/heads/main` → `{ ref }`; a 40/64-hex oid → `{ oid }`; anything else (torn, empty) → null. */
export function parseHeadText(text: string | null): { ref: string } | { oid: string } | null {
  if (typeof text !== 'string') return null;
  const line = text.replace(/\r?\n[\s\S]*$/, '').trim();
  if (line.startsWith('ref:')) {
    const ref = line.slice(4).trim();
    return ref.length > 0 && !ref.includes('\0') ? { ref } : null;
  }
  return HEAD_OID_RE.test(line) ? { oid: line } : null;
}

/** `refs/heads/feature/x` → `feature/x`; any other full ref name is kept whole. */
export function branchName(ref: string): string {
  return ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;
}

/**
 * `packed-refs` → ref name → oid (null for a malformed oid; the first line of a name wins). Peeled `^…` lines and
 * `#` headers are skipped. One parse serves every lookup until the file changes (`nodeHeadFs.stat`), so a
 * repository with tens of thousands of tags costs one split per `packed-refs` rewrite, not per checkout (§18 lag gate).
 */
export function parsePackedRefs(packed: string | null): ReadonlyMap<string, string | null> {
  const refs = new Map<string, string | null>();
  if (typeof packed !== 'string' || packed.length === 0) return refs;
  for (const raw of packed.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length === 0 || line.startsWith('#') || line.startsWith('^')) continue;
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    const name = line.slice(sp + 1);
    if (refs.has(name)) continue;
    const oid = line.slice(0, sp);
    refs.set(name, HEAD_OID_RE.test(oid) ? oid : null);
  }
  return refs;
}

/** The oid `packed-refs` records for `ref` (peeled `^…` lines and `#` headers skipped); null when absent or malformed. */
export function packedRefOid(packed: string | null, ref: string): string | null {
  return parsePackedRefs(packed).get(ref) ?? null;
}

interface PackedCacheEntry {
  mtimeMs: number;
  size: number;
  refs: ReadonlyMap<string, string | null>;
}
const packedCache = new Map<string, PackedCacheEntry>();

/** Test hook: forget every cached `packed-refs` parse. */
export function resetPackedRefsCache(): void {
  packedCache.clear();
}

/** `<commonDir>/packed-refs` lookup through the (path, mtimeMs, size) cache when the fs can stat; a plain read otherwise. */
function packedLookup(commonDir: string, ref: string, fs: HeadFs): string | null {
  const path = join(commonDir, 'packed-refs');
  if (fs.stat === undefined) return packedRefOid(fs.readFile(path), ref);
  const st = fs.stat(path);
  if (st === null) {
    packedCache.delete(path);
    return null;
  }
  const hit = packedCache.get(path);
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.refs.get(ref) ?? null;
  const refs = parsePackedRefs(fs.readFile(path));
  if (packedCache.size >= PACKED_CACHE_MAX) packedCache.clear();
  packedCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, refs });
  return refs.get(ref) ?? null;
}

/**
 * TUI-DESIGN §12.2: resolve a full ref name to an oid — the loose file under `gitDir` (per-worktree
 * refs), then under `commonDir` (shared `refs/heads/*`), then `<commonDir>/packed-refs` (cached, see
 * `parsePackedRefs`); a loose symbolic ref is followed up to MAX_SYMREF_DEPTH. Null = unborn (no such ref anywhere).
 */
export function resolveRef(ref: string, gitDir: string, commonDir: string, fs: HeadFs = nodeHeadFs): string | null {
  let current = ref;
  for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth++) {
    if (current.length === 0 || current.includes('\0') || current.split('/').includes('..')) return null;
    const loose = fs.readFile(join(gitDir, current)) ?? (commonDir !== gitDir ? fs.readFile(join(commonDir, current)) : null);
    const parsed = parseHeadText(loose);
    if (parsed !== null && 'oid' in parsed) return parsed.oid;
    if (parsed !== null) {
      current = parsed.ref;
      continue;
    }
    return packedLookup(commonDir, current, fs);
  }
  return null;
}

/**
 * TUI-DESIGN §12.2: the head as `<gitDir>/HEAD` says it now — `branch` (with the oid the loose ref or
 * `packed-refs` records), `detached`, `unborn` (a symbolic ref no file resolves: fresh `git init`,
 * `checkout --orphan`); null when HEAD is missing or unparseable OR the repository uses the reftable
 * backend (`HEAD` = `ref: refs/heads/.invalid`, or `<commonDir>/reftable/tables.list` exists) — the
 * caller keeps its previous value, i.e. the probe's head. Never throws, never spawns.
 */
export function readHead(gitDir: string, commonDir: string | null = null, fs: HeadFs = nodeHeadFs): GitHead | null {
  const common = commonDir ?? gitDir;
  const parsed = parseHeadText(fs.readFile(join(gitDir, 'HEAD')));
  if (parsed === null) return null;
  if ('oid' in parsed) return { kind: 'detached', oid: parsed.oid };
  // fix-pass finding 5: a reftable repository would otherwise read as an unborn branch named `.invalid`
  if (parsed.ref === REFTABLE_HEAD_REF || fs.readFile(join(common, 'reftable', 'tables.list')) !== null) return null;
  const name = branchName(parsed.ref);
  const oid = resolveRef(parsed.ref, gitDir, common, fs);
  if (oid !== null) return { kind: 'branch', name, oid };
  return { kind: 'unborn', name };
}
