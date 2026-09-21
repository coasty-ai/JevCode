/**
 * `/diff --full` pager (TUI-DESIGN §12.6, D9). The selection is pure and complete in wave 1; opening the pager
 * needs `useApp().suspendTerminal` and a sandbox spawn, so `openFullDiff` throws until wave 2.
 */
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

export interface OpenFullDiffDeps {
  /** `useApp().suspendTerminal(spawnFn)` from the mounted App */
  suspendTerminal: (run: () => Promise<void>) => Promise<void>;
  env: Readonly<Record<string, string | undefined>>;
  isTTY: boolean;
  /** `<run>/tmp/diff-<seq>.patch` */
  patchFile: string;
}

/** TUI-DESIGN §12.6: show the unified diff through the pager under `suspendTerminal`; wave 2 (idle-only, sandbox spawn). */
export function openFullDiff(_deps: OpenFullDiffDeps): Promise<void> {
  throw new Error('not wired in wave 1');
}
