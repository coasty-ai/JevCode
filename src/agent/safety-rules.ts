/**
 * The vocabulary the command classifier's modules share (docs/AGENT-LOOP-DESIGN.md §12): the classes, the destructive
 * rule ids and their sentences, and the path helpers that resolve a word against the workspace, the home directory and
 * the run temp dir.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { TestCommand } from '../core/types.js';
import type { Word } from './shlex.js';

export type CommandClass = 'readonly' | 'safe' | 'unknown' | 'destructive';

export type DestructiveRule =
  | 'privilege'
  | 'rm_outside'
  | 'git_discard'
  | 'force_push'
  | 'history_rewrite'
  | 'disk'
  | 'fork_bomb'
  | 'remote_exec'
  | 'system_power'
  | 'publish'
  | 'exfiltrate'
  | 'outside_write'
  | 'git_internals';

/** The rule's sentence: the review card's title and the `reason` of the step's `RiskAssessment`. */
export const RULE_SENTENCES: Readonly<Record<DestructiveRule, string>> = {
  privilege: 'runs a command with elevated privileges (sudo, doas, su)',
  rm_outside: 'recursively deletes outside the workspace, the workspace itself, the home directory or .git',
  git_discard: 'discards uncommitted changes that were in the workspace when the run started',
  force_push: 'force-pushes or deletes remote git history',
  history_rewrite: 'rewrites git history',
  disk: 'writes to a raw disk or wipes a file system',
  fork_bomb: 'is a fork bomb',
  remote_exec: 'pipes downloaded content into a shell or interpreter',
  system_power: 'shuts down or reboots the machine, or kills every process',
  publish: 'publishes a package, image or release',
  exfiltrate: 'uploads local files to a remote host',
  outside_write: 'writes outside the workspace',
  git_internals: 'writes into .git',
};

/** Rules whose effect leaves the machine: no sandbox or pre-image can take them back (§A5). */
export const REMOTE_RULES: ReadonlySet<DestructiveRule> = new Set(['force_push', 'publish', 'exfiltrate', 'remote_exec']);

export interface CommandVerdict {
  class: CommandClass;
  /** the least restorable rule matched (`rules[0]`); null when none did */
  rule: DestructiveRule | null;
  reason: string;
  /** `git_discard` only: which form matched — only `tracked` discards can be covered by the dirty-set pre-images */
  discard?: 'tracked' | 'clean' | 'refs';
  /**
   * Every destructive rule a compound command matched, least restorable first (`git reset --hard && git push --force` is
   * `[force_push, git_discard]`), so the note and the review card say what the WHOLE command does. Absent = `[rule]`.
   */
  rules?: readonly DestructiveRule[];
}

export interface ClassifyContext {
  /** the workspace root (realpath) */
  root: string;
  /** the call's workspace-relative `workdir`, null for the root */
  workdir: string | null;
  /** `~`, `$HOME` and `${HOME}` expand to this */
  home: string;
  /** the run temp dir (`$TMPDIR` inside the sandbox): exempt from rm_outside and outside_write */
  tmpdir: string | null;
  /** the run-start dirty set, workspace-relative: the user's uncommitted work (`git_discard`) */
  dirtyAtStart: ReadonlySet<string>;
  testCommand: TestCommand | null;
}

const RANK: Readonly<Record<CommandClass, number>> = { readonly: 0, safe: 1, unknown: 2, destructive: 3 };
export const READONLY: CommandVerdict = { class: 'readonly', rule: null, reason: '' };
export const SAFE: CommandVerdict = { class: 'safe', rule: null, reason: '' };
export const UNKNOWN: CommandVerdict = { class: 'unknown', rule: null, reason: 'the command is not on the read-only or safe lists' };

export function destructive(rule: DestructiveRule, discard?: CommandVerdict['discard']): CommandVerdict {
  return { class: 'destructive', rule, reason: RULE_SENTENCES[rule], ...(discard !== undefined ? { discard } : {}) };
}

/**
 * The order rules are reported in, least restorable first: what left the machine, then what no pre-image holds, then the
 * one local rule the pre-images can cover (`git_discard`).
 */
const RULE_ORDER: readonly DestructiveRule[] = ['force_push', 'publish', 'exfiltrate', 'remote_exec', 'fork_bomb', 'system_power', 'disk', 'privilege', 'rm_outside', 'history_rewrite', 'outside_write', 'git_internals', 'git_discard'];
const DISCARD_ORDER = ['tracked', 'clean', 'refs'] as const;

/** Every destructive rule of a verdict, least restorable first ([] when none). */
export function rulesOf(v: CommandVerdict): readonly DestructiveRule[] {
  return v.rules ?? (v.rule !== null ? [v.rule] : []);
}

/**
 * The stricter of two verdicts; two destructive ones MERGE: every rule is kept (least restorable first, so `rule` is the
 * one the note must lead with), the reason names each, and a `git_discard` form is the less coverable of the two.
 */
export function stricter(a: CommandVerdict, b: CommandVerdict): CommandVerdict {
  if (a.class === 'destructive' && b.class === 'destructive') {
    const rules = [...new Set([...rulesOf(a), ...rulesOf(b)])].sort((x, y) => RULE_ORDER.indexOf(x) - RULE_ORDER.indexOf(y));
    if (rules.length === rulesOf(a).length && a.discard === (b.discard ?? a.discard)) return a;
    const forms = [a.discard, b.discard].filter((d): d is NonNullable<CommandVerdict['discard']> => d !== undefined);
    const discard = forms.length === 0 ? undefined : forms.reduce((x, y) => (DISCARD_ORDER.indexOf(y) > DISCARD_ORDER.indexOf(x) ? y : x));
    return { class: 'destructive', rule: rules[0] ?? null, reason: rules.map((r) => RULE_SENTENCES[r]).join('; '), ...(discard !== undefined ? { discard } : {}), ...(rules.length > 1 ? { rules } : {}) };
  }
  return RANK[b.class] > RANK[a.class] ? b : a;
}

// ---------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------

/** One path under several spellings: macOS `/tmp` and `/var` are symlinks into `/private`. */
export function spellings(p: string): string[] {
  if (p.startsWith('/private/')) return [p, p.slice('/private'.length)];
  if (p === '/tmp' || p.startsWith('/tmp/') || p === '/var' || p.startsWith('/var/')) return [p, `/private${p}`];
  return [p];
}

export function isWithin(parent: string, child: string): boolean {
  return spellings(parent).some((pa) =>
    spellings(child).some((ch) => {
      const rel = relative(pa, ch);
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
    }),
  );
}

export interface PathContext {
  root: string;
  cwd: string;
  home: string;
  tmpdir: string | null;
}

/** The absolute path a word names, or null when it depends on something unknown (a substitution, another variable). */
export function resolveWordPath(w: Word, p: PathContext): string | null {
  if (w.subst) return null;
  let t = w.text;
  if (t === '~' || t.startsWith('~/')) t = p.home + t.slice(1);
  t = t.replace(/\$\{HOME\}|\$HOME\b/g, p.home).replace(/\$\{PWD\}|\$PWD\b/g, p.cwd);
  if (p.tmpdir !== null) t = t.replace(/\$\{TMPDIR\}|\$TMPDIR\b/g, p.tmpdir);
  if (t.includes('$') || t === '') return null;
  return resolve(p.cwd, t);
}
