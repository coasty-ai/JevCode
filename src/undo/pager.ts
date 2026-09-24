/**
 * `/diff --full` pager (TUI-DESIGN §12.6, D9). Selection (`$GIT_PAGER` → `$PAGER` → `less`, `core.pager` never
 * consulted, `LESS=FRX` only when unset, `LESSCHARSET=utf-8`) is pure; `openFullDiff` writes the unified text to
 * `<run>/tmp/diff-<seq>.patch` and shows it through the pager inside the caller's `suspendTerminal(fn)` — or, with
 * `cat` / no TTY, returns the inline block capped at 400 lines. The spawn is injectable; the default runs
 * `/bin/sh -c '<pager> "$0"' <file>` with the terminal inherited (the pager is the user's own program, so it runs
 * outside the sandbox and needs the real stdio).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import { DIFF_INLINE_MAX_LINES } from './diff.js';

export interface PagerSelection {
  /** the shell command run as `sh -c '<command> "$0"' <file>` (never `core.pager`) */
  command: string;
  /** environment additions: `LESS=FRX` only when unset, `LESSCHARSET=utf-8` only when unset */
  env: Record<string, string>;
  /** `cat` or no TTY: render inline instead, capped at DIFF_INLINE_MAX_LINES */
  inline: boolean;
  source: 'GIT_PAGER' | 'PAGER' | 'default';
}

export const DEFAULT_PAGER = 'less';
export const INLINE_DIFF_MAX_LINES = DIFF_INLINE_MAX_LINES;
/** TUI-DESIGN §12.6: the pager file lives under the run's `tmp/` (the sandbox's TMPDIR), mode 0600. */
export const DIFF_PATCH_DIR = 'tmp';
/** TUI-DESIGN §12.6: `diff-<seq>.patch` files kept under `<run>/tmp` — older ones go when a new one is written, so a long session never grows the run directory without bound. */
export const DIFF_PATCH_KEEP = 3;
/** `/bin/sh` exit codes for "found but not executable" and "command not found": the pager is unavailable, not the diff. */
export const SH_NOT_EXECUTABLE = 126;
export const SH_NOT_FOUND = 127;

/** TUI-DESIGN §12.6: the inline block's first line when the selected pager could not run (§24 names no text yet). */
export function pagerUnavailableNotice(command: string, detail: string): string {
  return `pager "${command}" unavailable (${detail}); showing the diff inline`;
}

/** TUI-DESIGN §12.6: the inline block's first line when `suspendTerminal` itself failed (Ink not mounted, App gone). */
export function suspendFailedNotice(detail: string): string {
  return `could not suspend the terminal (${detail}); showing the diff inline`;
}

function firstWordBase(command: string): string {
  const word = command.trim().split(/\s+/)[0] ?? '';
  const slash = word.lastIndexOf('/');
  return slash >= 0 ? word.slice(slash + 1) : word;
}

/**
 * TUI-DESIGN §12.6: `$GIT_PAGER` → `$PAGER` → `less`; `LESS=FRX` only when unset; `LESSCHARSET=utf-8`;
 * `core.pager` is never consulted; `cat` or a non-TTY stdout means the inline block. Pure over `env`.
 */
export function selectPager(env: Readonly<Record<string, string | undefined>>, isTTY: boolean): PagerSelection {
  const gitPager = env['GIT_PAGER']?.trim() ?? '';
  const pager = env['PAGER']?.trim() ?? '';
  let command = DEFAULT_PAGER;
  let source: PagerSelection['source'] = 'default';
  if (gitPager.length > 0) {
    command = gitPager;
    source = 'GIT_PAGER';
  } else if (pager.length > 0) {
    command = pager;
    source = 'PAGER';
  }
  const extra: Record<string, string> = {};
  if (env['LESS'] === undefined) extra['LESS'] = 'FRX';
  if (env['LESSCHARSET'] === undefined) extra['LESSCHARSET'] = 'utf-8';
  const inline = !isTTY || firstWordBase(command) === 'cat';
  return { command, env: extra, inline, source };
}

/** TUI-DESIGN §12.6: the `sh -c` argument list that shows `file` through the selected pager (`"$0"` keeps the path unsplit). */
export function pagerArgv(sel: PagerSelection, file: string): string[] {
  return ['/bin/sh', '-c', `${sel.command} "$0"`, file];
}

/** TUI-DESIGN §12.6: `<run>/tmp/diff-<seq>.patch`. */
export function diffPatchPath(runDir: string, seq: number): string {
  const n = Number.isSafeInteger(seq) && seq >= 0 ? seq : 0;
  return join(runDir, DIFF_PATCH_DIR, `diff-${n}.patch`);
}

/** SGR sequences only: the inline twin carries no colour (the renderer's sanitiser drops the rest). */
const SGR_RE = /\x1b\[[0-9;]*m/g;

export interface InlineDiff {
  lines: string[];
  /** lines beyond `max` were dropped; the last line says how many */
  truncated: boolean;
  /** lines in the whole text */
  total: number;
}

/** TUI-DESIGN §12.6: the inline `/diff --full` block — colour stripped, capped at 400 lines with a trailer naming the file. Pure. */
export function inlineDiffLines(text: string, file: string | null, max: number = DIFF_INLINE_MAX_LINES): InlineDiff {
  const cap = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : DIFF_INLINE_MAX_LINES;
  const plain = text.replace(SGR_RE, '');
  const all = plain.length === 0 ? [] : plain.split('\n');
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  if (all.length <= cap) return { lines: all, truncated: false, total: all.length };
  const shown = all.slice(0, cap);
  shown.push(`… ${all.length - cap} more lines${file !== null ? ` (full diff in ${file})` : ''}`);
  return { lines: shown, truncated: true, total: all.length };
}

/** What a pager spawn reports: the exit code, the signal that ended it (if any) and a spawn-level error text. */
export interface PagerOutcome {
  exitCode: number | null;
  /** the terminating signal when the pager was killed (`exitCode` is null then); absent or null otherwise */
  signal?: string | null;
  /** spawn failure or `killed by <signal>`; null on a normal exit */
  error: string | null;
}

/** The injectable spawn: run `argv` with `env` and the terminal inherited; resolves with the outcome (never rejects). */
export type PagerSpawn = (argv: readonly string[], env: Readonly<Record<string, string>>) => Promise<PagerOutcome>;

/** TUI-DESIGN §12.6: the default spawn — `/bin/sh -c '<pager> "$0"' <file>`, stdio inherited, the process env plus the selection's additions. */
export const defaultPagerSpawn: PagerSpawn = (argv, env) =>
  new Promise((resolve) => {
    const [file, ...args] = argv;
    if (file === undefined) {
      resolve({ exitCode: null, signal: null, error: 'empty argv' });
      return;
    }
    let settled = false;
    const done = (r: PagerOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      const child = nodeSpawn(file, args, { stdio: 'inherit', env: { ...env } });
      child.once('error', (e) => done({ exitCode: null, signal: null, error: e.message }));
      child.once('exit', (code, signal) => done({ exitCode: code, signal, error: signal !== null && code === null ? `killed by ${signal}` : null }));
    } catch (e) {
      done({ exitCode: null, signal: null, error: e instanceof Error ? e.message : String(e) });
    }
  });

/**
 * TUI-DESIGN §12.6: the pager never ran as a pager — `sh` reported it missing (127) or not executable (126), or the
 * spawn itself failed. A pager the user ended with a signal (Ctrl-C in `less`) did run and is not "unavailable".
 */
export function pagerUnavailable(o: PagerOutcome): boolean {
  if (o.exitCode === SH_NOT_FOUND || o.exitCode === SH_NOT_EXECUTABLE) return true;
  return o.exitCode === null && (o.signal ?? null) === null;
}

/** `exit 127` / `spawn less ENOENT` / `killed by SIGTERM` — the detail inside the unavailable notice. */
function outcomeDetail(o: PagerOutcome): string {
  if (o.exitCode !== null) return `exit ${o.exitCode}`;
  return o.error ?? 'did not run';
}

const PATCH_FILE_RE = /^diff-(\d+)\.patch$/;

/**
 * TUI-DESIGN §12.6: keep only the newest `keep` `diff-<seq>.patch` files in `dir` (by sequence number), never
 * removing `protect`. Errors are swallowed: pruning is housekeeping, never a reason to fail `/diff --full`.
 */
export async function prunePatchFiles(dir: string, keep: number = DIFF_PATCH_KEEP, protect: string | null = null): Promise<string[]> {
  const n = Number.isSafeInteger(keep) && keep >= 1 ? keep : DIFF_PATCH_KEEP;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const patches = names
    .map((name) => ({ name, m: PATCH_FILE_RE.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
    .map((x) => ({ name: x.name, seq: Number(x.m[1]) }))
    .sort((a, b) => b.seq - a.seq);
  const removed: string[] = [];
  for (const p of patches.slice(n)) {
    const abs = join(dir, p.name);
    if (protect !== null && abs === protect) continue;
    try {
      await unlink(abs);
      removed.push(abs);
    } catch {
      /* already gone or not ours */
    }
  }
  return removed;
}

export interface OpenFullDiffDeps {
  /** `useApp().suspendTerminal(fn)` from the mounted App (the `--plain` twin passes `(fn) => fn()`) */
  suspendTerminal: (run: () => Promise<void>) => Promise<void>;
  /** the process env: the pager selection reads GIT_PAGER / PAGER / LESS / LESSCHARSET from it and the child inherits it */
  env: Readonly<Record<string, string | undefined>>;
  isTTY: boolean;
  /** the unified diff text (`collectFullDiff().text`, already redacted) */
  text: string;
  /** `collectFullDiff().notice`: the inline block's first line when the text is incomplete */
  notice?: string | null;
  /** `<run>/tmp/diff-<seq>.patch` from these two, unless `patchFile` is given */
  runDir: string;
  seq: number;
  patchFile?: string;
  /** injectable spawn (default: node:child_process with stdio inherited) */
  spawn?: PagerSpawn;
  maxInlineLines?: number;
  /** `diff-<seq>.patch` files kept in the patch directory (default DIFF_PATCH_KEEP) */
  keepPatches?: number;
}

/** Why the inline block was shown although a pager was selected. */
export interface PagerFallback {
  command: string;
  source: PagerSelection['source'];
  exitCode: number | null;
  error: string | null;
}

export type OpenFullDiffResult =
  | { mode: 'pager'; file: string; command: string; source: PagerSelection['source']; exitCode: number | null; error: string | null }
  | {
      mode: 'inline';
      file: string;
      /** the block to print: the notices first (pager fallback, truncation), then the capped diff lines */
      lines: string[];
      truncated: boolean;
      total: number;
      /** set when a pager was selected but could not run (or the terminal could not be suspended) */
      fallback: PagerFallback | null;
    };

/**
 * TUI-DESIGN §12.6: write the diff to `<run>/tmp/diff-<seq>.patch` (0600, atomic; older `diff-*.patch` files past
 * `DIFF_PATCH_KEEP` are removed), then either return the inline block (`cat` or no TTY) or open the pager inside
 * `suspendTerminal` — `$GIT_PAGER` → `$PAGER` → `less`, `LESS=FRX` only when unset, `LESSCHARSET=utf-8`, the file
 * passed as `"$0"`. Resolves for every outcome: the pager's exit code is reported, never thrown; a pager that is
 * missing / not executable / failed to spawn, or a `suspendTerminal` that throws, falls back to the inline block
 * with a first line saying why, so `/diff --full` always shows something. Idle-only by the caller's contract.
 */
export async function openFullDiff(deps: OpenFullDiffDeps): Promise<OpenFullDiffResult> {
  const file = deps.patchFile ?? diffPatchPath(deps.runDir, deps.seq);
  await mkdir(join(deps.runDir, DIFF_PATCH_DIR), { recursive: true });
  await writeFileAtomic(file, deps.text, { mode: 0o600, mkdir: true });
  await prunePatchFiles(dirname(file), deps.keepPatches, file);
  const sel = selectPager(deps.env, deps.isTTY);
  const inlineResult = (fallback: PagerFallback | null, notice: string | null): OpenFullDiffResult => {
    const inline = inlineDiffLines(deps.text, file, deps.maxInlineLines);
    const head: string[] = [];
    if (notice !== null) head.push(notice);
    if (typeof deps.notice === 'string' && deps.notice.length > 0) head.push(deps.notice);
    return { mode: 'inline', file, lines: [...head, ...inline.lines], truncated: inline.truncated, total: inline.total, fallback };
  };
  if (sel.inline) return inlineResult(null, null);
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(deps.env)) if (typeof v === 'string') childEnv[k] = v;
  Object.assign(childEnv, sel.env);
  const spawn = deps.spawn ?? defaultPagerSpawn;
  let outcome: PagerOutcome = { exitCode: null, signal: null, error: 'pager did not run' };
  try {
    await deps.suspendTerminal(async () => {
      try {
        outcome = await spawn(pagerArgv(sel, file), childEnv);
      } catch (e) {
        outcome = { exitCode: null, signal: null, error: e instanceof Error ? e.message : String(e) };
      }
    });
  } catch (e) {
    // the caller's suspend failed (Ink not mounted, App unmounted mid-command): the diff is still shown, inline
    const detail = e instanceof Error ? e.message : String(e);
    return inlineResult({ command: sel.command, source: sel.source, exitCode: null, error: detail }, suspendFailedNotice(detail));
  }
  if (pagerUnavailable(outcome)) {
    return inlineResult({ command: sel.command, source: sel.source, exitCode: outcome.exitCode, error: outcome.error }, pagerUnavailableNotice(sel.command, outcomeDetail(outcome)));
  }
  return { mode: 'pager', file, command: sel.command, source: sel.source, exitCode: outcome.exitCode, error: outcome.error };
}
