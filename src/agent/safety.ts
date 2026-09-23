/**
 * The agent's command classifier (docs/AGENT-LOOP-DESIGN.md §12, §A2, §A5): pure code, no Jev.
 *
 * A command is split into simple commands (and the contents of every substitution) by `shlex.ts`; each simple command
 * is classified, and the strictest decides:
 *
 *  - `readonly`    a strict allow-list (`ls`, `cat`, `rg`, `git diff`, …) with no output redirect but /dev/null — it runs
 *                  in the observe batch with no pre-images, so anything in doubt is NOT readonly;
 *  - `safe`        the detected test command and the usual build / lint / type-check commands;
 *  - `destructive` one of the rules below, with the rule id;
 *  - `unknown`     everything else.
 *
 * The verdict never blocks under full autonomy (§A2): a destructive command runs like an unknown one, sandboxed and
 * pre-imaged, and the step carries a truthful note (§A5) — whether the effect left the machine, whether /undo restores
 * it, or that /undo may not. Only `--autonomy review` asks, for destructive and unknown commands alike.
 */
import { resolve } from 'node:path';
import type { AgentGate, TestCommand } from '../core/types.js';
import { isTestCommand } from '../loop/stages/execute.js';
import { allCommands, parseShell, type ParsedShell, type Redirect, type SimpleCommand, type Word } from './shlex.js';
import { gitVerdict } from './safety-git.js';
import { READONLY, REMOTE_RULES, SAFE, UNKNOWN, destructive, isWithin, resolveWordPath, spellings, stricter, type ClassifyContext, type CommandVerdict, type DestructiveRule, type PathContext } from './safety-rules.js';

export { RULE_SENTENCES, REMOTE_RULES, isWithin, type ClassifyContext, type CommandClass, type CommandVerdict, type DestructiveRule } from './safety-rules.js';

const DEVICE_EXEMPT = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;
const RAW_DISK = /^\/dev\/(sd|disk|rdisk|nvme|hd|mmcblk)/;

type WriteVerdict = { kind: 'ok' | 'null' | 'workspace' | 'opaque' } | { kind: 'rule'; rule: DestructiveRule };

/** Where a write lands: /dev/null, inside the workspace, somewhere exempt, or a rule. `redirect` exempts /tmp (§12). */
function writeTarget(w: Word, p: PathContext, redirect: boolean): WriteVerdict {
  const abs = resolveWordPath(w, p);
  if (abs === null) return { kind: 'opaque' };
  if (abs === '/dev/null') return { kind: 'null' };
  if (RAW_DISK.test(abs)) return { kind: 'rule', rule: 'disk' };
  if (DEVICE_EXEMPT.test(abs)) return { kind: 'ok' };
  if (isWithin(resolve(p.root, '.git'), abs)) return { kind: 'rule', rule: 'git_internals' };
  if (isWithin(p.root, abs)) return { kind: 'workspace' };
  if (p.tmpdir !== null && isWithin(p.tmpdir, abs)) return { kind: 'ok' };
  if (redirect && (isWithin('/tmp', abs) || isWithin('/private/tmp', abs))) return { kind: 'ok' };
  return { kind: 'rule', rule: 'outside_write' };
}

const OUTPUT_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);

/**
 * The redirects of one command: a rule, whether any output goes anywhere but /dev/null (`writes`, which a read-only
 * command may not do), and whether it lands in the workspace or somewhere unknown (`workspace`, which a safe command may
 * not do — a log in /tmp or $TMPDIR is harmless).
 */
function redirectVerdict(redirects: readonly Redirect[], p: PathContext): { rule: DestructiveRule | null; writes: boolean; workspace: boolean } {
  let writes = false;
  let workspace = false;
  for (const r of redirects) {
    if (!OUTPUT_OPS.has(r.op) || r.target === null) continue;
    const v = writeTarget(r.target, p, true);
    if (v.kind === 'rule') return { rule: v.rule, writes: true, workspace: true };
    if (v.kind !== 'null') writes = true;
    if (v.kind === 'workspace' || v.kind === 'opaque') workspace = true;
  }
  return { rule: null, writes, workspace };
}

// ---------------------------------------------------------------------------------------
// Simple commands
// ---------------------------------------------------------------------------------------

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'fi', 'done', 'esac']);
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'time']);
const XARGS_ARG_FLAGS = new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a']);

/** Strip assignments, keywords and wrappers (`env`, `nohup`, `xargs …`) down to the program and its arguments. */
export function programWords(words: readonly Word[]): Word[] {
  let i = 0;
  const skipFlags = (argFlags: ReadonlySet<string>): void => {
    while (i < words.length && words[i]!.text.startsWith('-')) {
      const flag = words[i]!.text;
      i += argFlags.has(flag) ? 2 : 1;
    }
  };
  for (;;) {
    const w = words[i];
    if (w === undefined) return [];
    const t = w.text;
    if (!w.subst && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) i += 1;
    else if (!w.subst && KEYWORDS.has(t)) i += 1;
    else if (!w.subst && WRAPPERS.has(t)) {
      i += 1;
      skipFlags(new Set());
    } else if (!w.subst && t === 'env') {
      i += 1;
      skipFlags(new Set(['-u', '-C', '-S']));
    } else if (!w.subst && t === 'xargs') {
      i += 1;
      skipFlags(XARGS_ARG_FLAGS);
    } else return words.slice(i);
  }
}

function programName(w: Word): string {
  const t = w.text.toLowerCase();
  return t.slice(t.lastIndexOf('/') + 1);
}

const args = (ws: readonly Word[]): string[] => ws.slice(1).map((w) => w.text);
const hasFlag = (a: readonly string[], ...flags: string[]): boolean => a.some((x) => flags.includes(x));
/** a short flag letter inside combined flags (`-rf` has `r`), never inside a long flag */
const hasShort = (a: readonly string[], letter: string): boolean => a.some((x) => /^-[A-Za-z]+$/.test(x) && x.includes(letter));

function rmVerdict(ws: readonly Word[], p: PathContext): CommandVerdict | null {
  const a = args(ws);
  const recursive = hasShort(a, 'r') || hasShort(a, 'R') || hasFlag(a, '--recursive');
  if (!recursive) return null;
  const targets = ws.slice(1).filter((w) => !w.text.startsWith('-') || w.text === '-');
  for (const w of targets) {
    if (w.text.startsWith('..')) return destructive('rm_outside');
    const abs = resolveWordPath(w, p);
    if (abs === null) continue;
    if (p.tmpdir !== null && isWithin(p.tmpdir, abs)) continue;
    const globAtRoot = w.glob && (resolve(abs, '..') === '/' || resolve(abs, '..') === p.home);
    const gitDir = isWithin(resolve(p.root, '.git'), abs);
    const outside = !isWithin(p.root, abs) || abs === p.root || spellings(abs).includes(p.root);
    if (abs === '/' || abs === p.home || globAtRoot || gitDir || outside) return destructive('rm_outside');
  }
  return null;
}

const SED_ADDR = String.raw`(?:\d+|\$|\d+~\d+|/(?:[^/\\]|\\.)*/I?)`;
const SED_PRINT_PART = new RegExp(String.raw`^\s*(?:${SED_ADDR}(?:\s*,\s*${SED_ADDR})?)?\s*!?\s*[pq=l]?\s*$`);

/** `sed -n` with print-only scripts (`1,20p`, `/re/p`): no `-i`, no `w`/`W`, nothing that could write. */
function sedReadonly(a: readonly string[]): boolean {
  if (!(hasShort(a, 'n') || hasFlag(a, '--quiet', '--silent'))) return false;
  if (hasShort(a, 'i') || a.some((x) => x.startsWith('--in-place') || x.startsWith('-i'))) return false;
  const scripts: string[] = [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === '-e' || a[i] === '--expression') scripts.push(a[i + 1] ?? '');
    else if (a[i]!.startsWith('--expression=')) scripts.push(a[i]!.slice('--expression='.length));
  }
  if (scripts.length === 0) {
    const first = a.find((x) => !x.startsWith('-'));
    if (first === undefined) return false;
    scripts.push(first);
  }
  return scripts.every((s) => s.split(/[;\n]/).every((part) => SED_PRINT_PART.test(part)));
}

const PLAIN_READONLY = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'which', 'file', 'stat', 'diff', 'du', 'basename', 'dirname', 'realpath', 'jq']);
const FIND_WRITERS = /^-(delete|exec|execdir|ok|okdir|fprint.*|fls)$/;

function readonlyProgram(program: string, a: readonly string[]): boolean {
  if (PLAIN_READONLY.has(program)) return true;
  if (program === 'tree') return !hasFlag(a, '-o');
  if (program === 'grep' || program === 'rg' || program === 'ag' || program === 'egrep' || program === 'fgrep') return !a.some((x) => x === '--pre' || x.startsWith('--pre='));
  if (program === 'find') return !a.some((x) => FIND_WRITERS.test(x));
  if (program === 'sed') return sedReadonly(a);
  if (program === 'sort') return !hasFlag(a, '-o') && !a.some((x) => x.startsWith('--output') || /^-[A-Za-z]*o/.test(x));
  return false;
}

const SAFE_PATTERNS: readonly RegExp[] = [
  /^(npm|pnpm|yarn|bun)( run)? (build|lint|typecheck|test|check)(\s|$)/,
  /^(npx )?tsc(\s|$)/,
  /^(npx )?eslint(\s|$)(?!.*--fix)/,
  /^(npx )?prettier(?=.*\s--check(\s|$))(?!.*\s--write)/,
  /^cargo (build|check|test|clippy)(\s|$)/,
  /^cargo fmt\b.*\s--check(\s|$)/,
  /^go (build|test|vet)(\s|$)/,
  /^pytest(\s|$)/,
  /^python3? -m (pytest|unittest)(\s|$)/,
  /^make (test|check|build)(\s|$)/,
];

const SHELL_COMPOSITION = /[;&|<>`$(){}\\\n]/;

/** One plain invocation of the detected test command or a scoped form of it (`isVerificationRun`, src/loop/stages/risk.ts). */
export function isVerificationRun(command: string, test: TestCommand | null): boolean {
  return test !== null && !SHELL_COMPOSITION.test(command) && isTestCommand(command, test);
}

/** curl / wget flags that send a local file: `-d @f`, `--data-binary @f`, `-F x=@f`, `-T f`, `--upload-file`, `--post-file` */
function uploads(a: readonly string[]): boolean {
  return a.some((x, i) => {
    const next = a[i + 1] ?? '';
    if (/^(-d|--data|--data-binary|--data-urlencode)$/.test(x) && next.startsWith('@')) return true;
    if (/^-d@/.test(x) || /^--data(-binary|-urlencode)?=@/.test(x)) return true;
    if ((x === '-F' || x === '--form') && /=@/.test(next)) return true;
    if (/^-F.+=@/.test(x) || /^--form=.*=@/.test(x)) return true;
    return /^(-T|--upload-file|--post-file)(=|$)/.test(x) || /^-T./.test(x);
  });
}

const INTERPRETERS = /^(sh|bash|zsh|dash|ksh|fish|python\d*(\.\d+)?|node|perl|ruby|php)$/;
const DOWNLOADERS = new Set(['curl', 'wget']);

function simpleVerdict(cmd: SimpleCommand, p: PathContext, c: ClassifyContext, cdPrefix: boolean): CommandVerdict {
  const ws = programWords(cmd.words);
  const redirects = redirectVerdict(cmd.redirects, p);
  if (redirects.rule !== null) return destructive(redirects.rule);
  if (ws.length === 0) return redirects.writes ? UNKNOWN : READONLY;
  const first = ws[0]!;
  const opaque = first.subst || first.param;
  const program = programName(first);
  const a = args(ws);
  const line = ws.map((w) => w.text).join(' ');

  if (!opaque && ['sudo', 'doas', 'su'].includes(program)) return destructive('privilege');
  if (opaque || program === 'rm') {
    const v = rmVerdict(ws, p);
    if (v !== null) return v;
    if (opaque) return UNKNOWN;
  }
  if (program === 'git') return gitVerdict(a, p, c.dirtyAtStart, redirects.writes);
  if (/^mkfs/.test(program) || ['fdisk', 'wipefs', 'shred'].includes(program)) return destructive('disk');
  if (program === 'diskutil' && a.some((x) => /^erase/i.test(x))) return destructive('disk');
  if (program === 'dd' && a.some((x) => x.startsWith('of=/dev/') && x !== 'of=/dev/null')) return destructive('disk');
  if (['shutdown', 'reboot', 'halt', 'poweroff', 'killall'].includes(program)) return destructive('system_power');
  if (program === 'kill' && a.includes('-1') && a.some((x) => x === '-9' || x === '-KILL' || x === '-s')) return destructive('system_power');
  if (/^(npm|pnpm) publish\b|^yarn (npm )?publish\b|^cargo publish\b|^twine upload\b|^gem push\b|^docker push\b|^gh release create\b/.test(line)) return destructive('publish');
  if ((program === 'scp' || program === 'rsync') && a.some((x) => !x.startsWith('-') && /^[^/\s]+:/.test(x) && !/^[A-Za-z]:\\/.test(x))) return destructive('exfiltrate');
  if (DOWNLOADERS.has(program) && uploads(a)) return destructive('exfiltrate');
  if (program === 'tee') {
    let writes = redirects.writes;
    for (const w of ws.slice(1).filter((x) => !x.text.startsWith('-'))) {
      const v = writeTarget(w, p, true);
      if (v.kind === 'rule') return destructive(v.rule);
      if (v.kind !== 'null') writes = true;
    }
    return writes ? UNKNOWN : READONLY;
  }
  if ((program === 'chmod' || program === 'chown') && (hasShort(a, 'R') || hasFlag(a, '--recursive'))) {
    const targets = ws.slice(1).filter((w) => !w.text.startsWith('-')).slice(1);
    for (const w of targets) {
      const v = writeTarget(w, p, false);
      if (v.kind === 'rule') return destructive(v.rule);
    }
    return UNKNOWN;
  }
  if (program === 'cd') return cdPrefix && !redirects.writes ? READONLY : UNKNOWN;
  if (!redirects.writes && readonlyProgram(program, a)) return READONLY;
  if (SAFE_PATTERNS.some((re) => re.test(line))) return redirects.workspace ? UNKNOWN : SAFE;
  if (isVerificationRun(line, c.testCommand)) return SAFE;
  return UNKNOWN;
}

/** `curl … | sh`, `sh -c "$(curl …)"`, `bash <(wget -qO- …)`: a download handed to an interpreter (§12 remote_exec). */
function remoteExec(parsed: ParsedShell): boolean {
  const downloads = (p: ParsedShell): boolean => allCommands(p).some((cmd) => {
    const ws = programWords(cmd.words);
    return ws.length > 0 && DOWNLOADERS.has(programName(ws[0]!));
  });
  for (let i = 0; i < parsed.commands.length; i += 1) {
    const ws = programWords(parsed.commands[i]!.words);
    if (ws.length === 0) continue;
    const interpreter = INTERPRETERS.test(programName(ws[0]!));
    // a downloader earlier in the same pipeline
    if (interpreter) {
      for (let j = i - 1; j >= 0 && parsed.commands[j]!.next === '|'; j -= 1) {
        const up = programWords(parsed.commands[j]!.words);
        if (up.length > 0 && DOWNLOADERS.has(programName(up[0]!))) return true;
      }
      // a substitution in its words that downloads
      if (ws.some((w) => w.subst) && parsed.substitutions.some(downloads)) return true;
    }
  }
  return parsed.substitutions.some(remoteExec);
}

const FORK_BOMB = /:\s*\(\s*\)\s*\{/;

function classifyParsed(parsed: ParsedShell, c: ClassifyContext): CommandVerdict {
  let cwd = c.workdir === null ? c.root : resolve(c.root, c.workdir);
  let worst: CommandVerdict = READONLY;
  let prefix = true;
  parsed.commands.forEach((cmd, i) => {
    const ws = programWords(cmd.words);
    const isCd = ws.length > 0 && !ws[0]!.subst && ws[0]!.text === 'cd';
    const cdPrefix = isCd && prefix && i < parsed.commands.length - 1 && (cmd.next === '&&' || cmd.next === ';');
    if (!isCd) prefix = false;
    worst = stricter(worst, simpleVerdict(cmd, { root: c.root, cwd, home: c.home, tmpdir: c.tmpdir }, c, cdPrefix));
    if (isCd && ws[1] !== undefined) cwd = resolveWordPath(ws[1], { root: c.root, cwd, home: c.home, tmpdir: c.tmpdir }) ?? cwd;
  });
  for (const sub of parsed.substitutions) worst = stricter(worst, classifyParsed(sub, c));
  return worst;
}

/** Classify one `bash` command (§12). The strictest simple command decides. */
export function classifyCommand(command: string, c: ClassifyContext): CommandVerdict {
  if (FORK_BOMB.test(command)) return destructive('fork_bomb');
  if (isVerificationRun(command.trim(), c.testCommand)) return SAFE;
  const parsed = parseShell(command);
  if (remoteExec(parsed)) return destructive('remote_exec');
  return classifyParsed(parsed, c);
}

/** §A5: the one-line note of a destructive command that ran under full autonomy, truthful about what /undo can do. */
export function destructiveNote(command: string, rule: DestructiveRule, restorable: boolean): string {
  const cmd = command.replace(/\s+/g, ' ').trim();
  const shown = cmd.length > 80 ? `${cmd.slice(0, 79)}…` : cmd;
  const truth = REMOTE_RULES.has(rule) ? 'this left the machine; /undo cannot reverse it' : restorable ? '/undo restores the workspace' : '/undo may not restore this';
  return `ran ${shown} (rule ${rule}) — ${truth}`;
}

/**
 * The gate of one mutating command (§12, §A2). Full autonomy never asks and never refuses: a destructive verdict is `ok`
 * with its rule and the note. Review asks for destructive and unknown commands; readonly and safe ones never ask.
 */
export function commandGate(v: CommandVerdict, autonomy: 'full' | 'review', note: string | null): AgentGate {
  if (autonomy === 'review') {
    if (v.class === 'destructive') return { verdict: 'review', reason: v.reason, rule: v.rule };
    if (v.class === 'unknown') return { verdict: 'review', reason: v.reason, rule: null };
    return { verdict: 'ok', reason: '', rule: null };
  }
  if (v.class === 'destructive' && v.rule !== null) return { verdict: 'ok', reason: note ?? destructiveNote('', v.rule, false), rule: v.rule };
  return { verdict: 'ok', reason: '', rule: null };
}
