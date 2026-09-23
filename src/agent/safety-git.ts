/**
 * The `git` half of the command classifier (docs/AGENT-LOOP-DESIGN.md §12): the read-only subcommands, and the three
 * git rules — `git_discard` (the user's uncommitted work at run start), `force_push` and `history_rewrite`.
 *
 * `git_discard` is judged against the run-start dirty set: a command that names paths matches when one of them (or a
 * directory holding one) was dirty; a path-less form (`reset --hard`, `checkout -f`, `clean -f`) matches whenever the
 * set is non-empty. `clean -x/-X` always matches (it deletes ignored files such as `.env` that no pre-image covers), and
 * so do the forms that destroy saved work outside the working tree (`stash drop|clear`, `branch -D`,
 * `worktree remove --force`).
 */
import { relative, resolve, sep } from 'node:path';
import { READONLY, UNKNOWN, destructive, isWithin, resolveWordPath, type CommandVerdict, type PathContext } from './safety-rules.js';

const READONLY_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'rev-parse', 'grep']);
const OUTPUT_FLAGS = /^(--output(=.*)?|-o|--ext-diff)$/;

/** a short flag letter inside combined flags (`-fdx` has `x`) */
const hasShort = (a: readonly string[], letter: string): boolean => a.some((x) => /^-[A-Za-z]+$/.test(x) && x.includes(letter));
const has = (a: readonly string[], ...flags: string[]): boolean => a.some((x) => flags.includes(x));

/** Global options before the subcommand: `-C <dir>` moves the cwd, `-c <k=v>` can run commands (never read-only). */
function splitGlobal(a: readonly string[], p: PathContext): { sub: string; rest: string[]; cwd: string; config: boolean } {
  let cwd = p.cwd;
  let config = false;
  let i = 0;
  while (i < a.length && a[i]!.startsWith('-')) {
    const x = a[i]!;
    if (x === '-C') {
      cwd = resolveWordPath({ text: a[i + 1] ?? '.', subst: false, param: false, glob: false }, p) ?? cwd;
      i += 2;
    } else if (x === '-c') {
      config = true;
      i += 2;
    } else {
      if (x.startsWith('-c') || x.startsWith('--config-env')) config = true;
      i += 1;
    }
  }
  return { sub: a[i] ?? '', rest: a.slice(i + 1), cwd, config };
}

/** Whether a path argument (relative to `cwd`) names or contains a run-start dirty path. */
function touchesDirty(arg: string, cwd: string, root: string, dirty: ReadonlySet<string>): boolean {
  if (dirty.size === 0) return false;
  if (/[*?[]/.test(arg)) return true; // a pathspec glob: judged like the path-less form
  const abs = resolve(cwd, arg);
  if (!isWithin(root, abs)) return false;
  const rel = relative(root, abs).split(sep).join('/');
  if (rel === '') return true;
  for (const d of dirty) if (d === rel || d.startsWith(`${rel}/`)) return true;
  return false;
}

function nonFlags(a: readonly string[]): string[] {
  return a.filter((x) => !x.startsWith('-'));
}

function discardVerdict(sub: string, rest: readonly string[], cwd: string, root: string, dirty: ReadonlySet<string>): CommandVerdict | null {
  const pathless = dirty.size > 0;
  switch (sub) {
    case 'reset':
      return has(rest, '--hard') && pathless ? destructive('git_discard', 'tracked') : null;
    case 'checkout': {
      if (has(rest, '-b', '-B', '--orphan')) return null;
      if ((has(rest, '-f', '--force') || hasShort(rest, 'f')) && pathless) return destructive('git_discard', 'tracked');
      const dash = rest.indexOf('--');
      const paths = dash >= 0 ? rest.slice(dash + 1) : nonFlags(rest);
      return paths.some((x) => touchesDirty(x, cwd, root, dirty)) ? destructive('git_discard', 'tracked') : null;
    }
    case 'restore': {
      const staged = has(rest, '--staged', '-S');
      const worktree = has(rest, '--worktree', '-W');
      if (staged && !worktree) return null;
      const flagsWithArg = new Set(['-s', '--source']);
      const paths: string[] = [];
      for (let i = 0; i < rest.length; i += 1) {
        const x = rest[i]!;
        if (flagsWithArg.has(x)) i += 1;
        else if (x !== '--' && !x.startsWith('-')) paths.push(x);
      }
      return paths.some((x) => touchesDirty(x, cwd, root, dirty)) ? destructive('git_discard', 'tracked') : null;
    }
    case 'switch':
      return (has(rest, '-f', '--force', '--discard-changes') || hasShort(rest, 'f')) && pathless ? destructive('git_discard', 'tracked') : null;
    case 'clean': {
      const force = has(rest, '--force') || hasShort(rest, 'f');
      if (!force) return null;
      if (hasShort(rest, 'x') || hasShort(rest, 'X')) return destructive('git_discard', 'clean');
      return pathless ? destructive('git_discard', 'clean') : null;
    }
    case 'stash':
      return rest[0] === 'drop' || rest[0] === 'clear' ? destructive('git_discard', 'refs') : null;
    case 'branch':
      return has(rest, '-D') || (has(rest, '-d', '--delete') && has(rest, '-f', '--force')) ? destructive('git_discard', 'refs') : null;
    case 'worktree':
      return rest[0] === 'remove' && has(rest, '-f', '--force') ? destructive('git_discard', 'refs') : null;
    default:
      return null;
  }
}

/** Classify `git <args>` (the program word already removed). `writes`: the command redirects output to a file. */
export function gitVerdict(a: readonly string[], p: PathContext, dirty: ReadonlySet<string>, writes: boolean): CommandVerdict {
  const { sub, rest, cwd, config } = splitGlobal(a, p);
  const discard = discardVerdict(sub, rest, cwd, p.root, dirty);
  if (discard !== null) return discard;
  if (sub === 'push' && (rest.some((x) => /^(--force(-with-lease|-if-includes)?(=.*)?|-f|--mirror|--delete|-d)$/.test(x) || /^-[A-Za-z]*f/.test(x)) || nonFlags(rest).slice(1).some((x) => x.startsWith('+') || x.startsWith(':')))) {
    return destructive('force_push');
  }
  if (sub === 'filter-branch' || sub === 'filter-repo') return destructive('history_rewrite');
  if (sub === 'reflog' && rest[0] === 'expire') return destructive('history_rewrite');
  if (sub === 'update-ref' && has(rest, '-d')) return destructive('history_rewrite');
  if (config || writes || rest.some((x) => OUTPUT_FLAGS.test(x))) return UNKNOWN;
  if (READONLY_SUBCOMMANDS.has(sub)) return READONLY;
  if (sub === 'branch' && has(rest, '--list')) return READONLY;
  return UNKNOWN;
}
