/**
 * Seatbelt (sandbox-exec) profile generation (DESIGN.md §8, research 09 §3.2).
 *
 * Base is `(allow default)`: `(deny default)` breaks ordinary toolchains. Writes are then
 * denied everywhere except the workspace, the run's tmp/home and the tty devices; the
 * harness's own secret stores are unreadable. Every path is canonicalised first because
 * `subpath` matches kernel paths only (`/tmp` -> `/private/tmp`); a symlinked prefix would
 * silently deny everything under it. Later rules win, so the specific `.git` denials sit
 * after the workspace allow.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SandboxLevel, SandboxProfile } from '../core/types.js';
import { canonicalPathSync, isWithin } from './paths.js';

export interface ProfileOptions {
  ws: string;
  runTmp: string;
  runHome: string;
  /** realpath of the harness's stdout when it is a terminal; writes to it are denied */
  ttyPath: string | null;
  /** absolute paths (files or directories) the child must not read */
  readDenies: readonly string[];
  noNetwork: boolean;
  /** injectable for tests; default os.homedir() (the child's HOME is remapped, so never $HOME) */
  home?: string;
  /** further writable roots (bench stand-ins for /output, /results, /logs); canonicalised like every other path */
  extraWritable?: readonly string[];
  /** further read-only roots under a read-denied prefix (the bench's shared git object cache) */
  extraReadable?: readonly string[];
  /** emit the .git/config + .git/hooks write denials (default true) */
  protectGit?: boolean;
  /**
   * TUI-DESIGN §12.7 (A149): the probe's git dir (realpath'd here). Writes under it are allowed when it
   * lies outside `ws` (linked worktree, subdirectory workspace) and `<gitDir>/config.worktree` is denied.
   * Absent → today's `<ws>/.git` rules, byte for byte.
   */
  gitDir?: string;
  /** TUI-DESIGN §12.7: the probe's common dir; the `config`/`hooks` denies and the `modules/*` regexes live there. */
  gitCommonDir?: string;
  /** TUI-DESIGN §12.7: resolved `${XDG_CONFIG_HOME:-~/.config}/jevcode` + legacy dirs, appended to the `file-read*` denies. */
  configDirs?: readonly string[];
}

/** SBPL string literal: double-quoted with backslash and quote escaped. */
export function sbplString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * TUI-DESIGN §12.7: a path as a regex fragment. Metacharacters take ONE backslash: the profile reader
 * hands `\.` to the matcher as-is, while a doubled `\\.` compiles to a pattern that never matches and
 * the deny silently vanishes (verified with sandbox-exec on macOS 26 — see the O5 wave-2 report).
 */
export function regexQuote(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/** SBPL regex literal `#"…"`; only the quote is escaped (backslashes are regex escapes, see `regexQuote`). */
export function sbplRegex(pattern: string): string {
  return `#"${pattern.replace(/"/g, '\\"')}"`;
}

const HOME_SECRET_SUBPATHS = [join('.config', 'jevcode'), '.ssh', '.aws', join('.config', 'gh')];
const HOME_SECRET_LITERALS = ['.netrc'];

/**
 * IMPORT-DESIGN §2.11 [G2.1]: the workspace memory the importer writes. A run may **read** its own
 * memory — it is supposed to — but it must not rewrite the memory that steers the next run, so each
 * of these is denied as a literal + subpath pair beside the `.git` denies (the `addRead` idiom of
 * `:150-151` applied to writes). They ride `protectGit` for the same reason the `.git` denies do:
 * the bench's infrastructure sandbox is a fresh clone into the root and has no memory to protect.
 */
const WS_MEMORY_WRITE_DENIES = [join('.jevcode', 'memory'), join('.jevcode', 'rules'), join('.jevcode', 'commands')];

/**
 * IMPORT-DESIGN §2.2 / §2.11 [G2.1]: the 0600 personal-memory tree. Its deny is **not** routed through
 * `addRead`, because that lands in the `file-read*` deny at `:163` which the `:181`
 * `(allow file-read* (subpath <ws>) …)` then overrides — `<ws>` is a writable root and therefore in
 * `roots`, so the personal files would stay readable by any sandboxed command. It is emitted after the
 * allow instead, exactly as the `:170`/`:180` pair already does for `~/.jevcode`.
 */
const WS_MEMORY_LOCAL = join('.jevcode', 'memory-local');

function canonOption(p: string | undefined): string | null {
  return typeof p === 'string' && p.length > 0 ? canonicalPathSync(p) : null;
}

export function buildProfile(opts: ProfileOptions): string {
  const ws = canonicalPathSync(opts.ws);
  const runTmp = canonicalPathSync(opts.runTmp);
  const runHome = canonicalPathSync(opts.runHome);
  const home = canonicalPathSync(opts.home ?? homedir());

  const extra: string[] = [];
  for (const p of opts.extraWritable ?? []) {
    if (typeof p !== 'string' || p.length === 0) continue;
    const canon = canonicalPathSync(p);
    if (canon !== ws && canon !== runTmp && canon !== runHome && !extra.includes(canon)) extra.push(canon);
  }

  // TUI-DESIGN §12.7: the probe's dirs. One of the two given → the other defaults to it (a main tree
  // has gitDir === commonDir). Neither → the legacy `<ws>/.git` rules so today's snapshots hold.
  const gitDirOpt = canonOption(opts.gitDir);
  const commonOpt = canonOption(opts.gitCommonDir);
  const gitDir = gitDirOpt ?? commonOpt;
  const commonDir = commonOpt ?? gitDirOpt;
  // writable when outside the workspace (linked worktree: `<main>/.git/worktrees/<wt>` + `<main>/.git`;
  // subdirectory workspace: the repository's `.git` above it); the broader root first, nested ones dropped
  const gitRoots: string[] = [];
  for (const d of [commonDir, gitDir]) {
    if (d === null || isWithin(ws, d) || isWithin(runTmp, d) || isWithin(runHome, d)) continue;
    if (extra.some((r) => isWithin(r, d)) || gitRoots.some((r) => isWithin(r, d))) continue;
    gitRoots.push(d);
  }
  const writable = [...extra, ...gitRoots];

  const lines: string[] = ['(version 1)', '(allow default)', '(deny file-write*)'];
  lines.push(
    `(allow file-write* (subpath ${sbplString(ws)}) (subpath ${sbplString(runTmp)}) (subpath ${sbplString(runHome)})${writable.map((p) => ` (subpath ${sbplString(p)})`).join('')}`,
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty")',
    '  (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$") (subpath "/dev/fd"))',
  );
  const gitDenies: string[] = [];
  if (gitDir === null || commonDir === null) {
    gitDenies.push(`(literal ${sbplString(join(ws, '.git', 'config'))})`, `(subpath ${sbplString(join(ws, '.git', 'hooks'))})`);
  } else {
    // TUI-DESIGN §12.7: the executable knobs live in the common dir (`config`, `hooks`, every submodule's
    // `modules/<name>/{config,hooks}` — names may contain `/`), in the worktree's own `config.worktree` and
    // (fix-pass finding 4) in EVERY other linked worktree's `worktrees/<name>/config.worktree` under the common
    // dir, which the write allow above made reachable: a run in worktree A must not plant `core.fsmonitor` or
    // `core.hooksPath` into worktree B's per-worktree config (live once `extensions.worktreeConfig` is on —
    // sparse-checkout users have it — and executed by the user's own shell in B, not by the flag-neutralised harness).
    const modules = regexQuote(join(commonDir, 'modules'));
    const worktrees = regexQuote(join(commonDir, 'worktrees'));
    gitDenies.push(
      `(literal ${sbplString(join(commonDir, 'config'))})`,
      `(subpath ${sbplString(join(commonDir, 'hooks'))})`,
      `(literal ${sbplString(join(gitDir, 'config.worktree'))})`,
      `(regex ${sbplRegex(`^${worktrees}/[^/]+/config\\.worktree$`)})`,
      `(regex ${sbplRegex(`^${modules}/.+/config$`)})`,
      `(regex ${sbplRegex(`^${modules}/.+/hooks(/.*)?$`)})`,
    );
  }
  // IMPORT-DESIGN §2.11 [G2.1]: appended to `gitDenies`, so they land in the deny line emitted AFTER the
  // write allow above (which is exactly why the `.git` denies work) and are suppressed by `protectGit: false`.
  for (const rel of WS_MEMORY_WRITE_DENIES) {
    const canon = canonicalPathSync(join(ws, rel));
    gitDenies.push(`(literal ${sbplString(canon)})`, `(subpath ${sbplString(canon)})`);
  }
  const ttyDeny = opts.ttyPath && opts.ttyPath.startsWith('/dev/') ? [`(literal ${sbplString(canonicalPathSync(opts.ttyPath))})`] : [];
  if (opts.protectGit === false) {
    // infrastructure sandbox (fresh clone into the root): only the harness tty stays denied
    if (ttyDeny.length > 0) lines.push(`(deny file-write* ${ttyDeny.join(' ')})`);
  } else {
    lines.push(`(deny file-write* ${[...gitDenies, ...ttyDeny].join(' ')})`);
  }

  const reads: string[] = [];
  const seen = new Set<string>();
  const addRead = (rule: string): void => {
    if (!seen.has(rule)) {
      seen.add(rule);
      reads.push(rule);
    }
  };
  for (const p of opts.readDenies) {
    if (typeof p !== 'string' || p.length === 0) continue;
    const canon = canonicalPathSync(p);
    // A directory deny must cover its contents; a file deny is a literal. Unknown (not yet
    // existing) paths get both so a later mkdir cannot slip through.
    addRead(`(literal ${sbplString(canon)})`);
    addRead(`(subpath ${sbplString(canon)})`);
  }
  for (const rel of HOME_SECRET_SUBPATHS) addRead(`(subpath ${sbplString(canonicalPathSync(join(home, rel)))})`);
  for (const rel of HOME_SECRET_LITERALS) addRead(`(literal ${sbplString(canonicalPathSync(join(home, rel)))})`);
  // TUI-DESIGN §12.7: the resolved jevcode config dirs (XDG_CONFIG_HOME may point anywhere; the wizard's
  // key file would otherwise be readable unless it happened to be in readDenies); appended, deduplicated
  for (const p of opts.configDirs ?? []) {
    if (typeof p !== 'string' || p.length === 0) continue;
    const canon = canonicalPathSync(p);
    addRead(`(literal ${sbplString(canon)})`);
    addRead(`(subpath ${sbplString(canon)})`);
  }
  lines.push(`(deny file-read* ${reads.join(' ')})`);
  // The jevcode home holds every run's checkpoints and the bench work areas. Deny reading file
  // CONTENTS there (other runs' prompts and outputs stay private) but keep metadata readable, so
  // `mkdir -p`, `cd` and `git clone` can traverse into the roots this run may use; then re-allow
  // full reads under every writable root (later rules win in SBPL). The run's own checkpoints
  // (state.json, *.jsonl) sit outside runTmp/runHome and therefore stay unreadable.
  const jevHome = canonicalPathSync(join(home, '.jevcode'));
  lines.push(`(deny file-read-data (subpath ${sbplString(jevHome)}))`);
  // A deny on the specific operation outranks a later allow on the `file-read*` family, so the
  // re-allow names file-read-data explicitly (verified on macOS 26).
  const readable: string[] = [];
  for (const p of opts.extraReadable ?? []) {
    if (typeof p !== 'string' || p.length === 0) continue;
    const canon = canonicalPathSync(p);
    if (canon !== ws && canon !== runTmp && canon !== runHome && !writable.includes(canon) && !readable.includes(canon)) readable.push(canon);
  }
  const roots = `(subpath ${sbplString(ws)}) (subpath ${sbplString(runTmp)}) (subpath ${sbplString(runHome)})${[...writable, ...readable].map((p) => ` (subpath ${sbplString(p)})`).join('')}`;
  lines.push(`(allow file-read-data ${roots})`);
  lines.push(`(allow file-read* ${roots})`);
  // IMPORT-DESIGN §2.11 [G2.1]: after BOTH re-allows, never before them — a deny on a family emitted after
  // the allow wins (the macOS 26 behaviour recorded above), while the same rule routed through `addRead`
  // would sit at the `file-read*` deny the `<ws>` re-allow overrides. Not gated on `protectGit`: that flag
  // relaxes the git write knobs, not the confidentiality of the human's 0600 personal memory.
  const memoryLocal = canonicalPathSync(join(ws, WS_MEMORY_LOCAL));
  lines.push(`(deny file-read* (literal ${sbplString(memoryLocal)}) (subpath ${sbplString(memoryLocal)}))`);

  if (opts.noNetwork) lines.push('(deny network*)');
  return `${lines.join('\n')}\n`;
}

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export function detectSandboxLevel(profile: SandboxProfile, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): SandboxLevel {
  if (profile === 'none') return 'none';
  return platform === 'darwin' && exists(SANDBOX_EXEC) ? 'seatbelt' : 'none';
}
