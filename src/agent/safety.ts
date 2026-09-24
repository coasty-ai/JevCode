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
import { RISK_DIMENSIONS, type AgentGate, type RiskAssessment, type RiskDimension, type RiskDimensionResult, type TestCommand } from '../core/types.js';
import { isTestCommand } from '../loop/stages/execute.js';
import { isSecretBasename } from '../sandbox/paths.js';
import { allCommands, parseShell, type ParsedShell, type Redirect, type SimpleCommand, type Word } from './shlex.js';
import { gitVerdict } from './safety-git.js';
import { READONLY, REMOTE_RULES, SAFE, UNKNOWN, destructive, isWithin, resolveWordPath, rulesOf, spellings, stricter, type ClassifyContext, type CommandVerdict, type DestructiveRule, type PathContext } from './safety-rules.js';

export { RULE_SENTENCES, REMOTE_RULES, isWithin, rulesOf, type ClassifyContext, type CommandClass, type CommandVerdict, type DestructiveRule } from './safety-rules.js';

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

/** output redirects; `>&` counts only with a file target (`>&2` is an fd duplication and has none) */
const OUTPUT_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);

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
/** wrappers that run the rest of the line, with the flags that take an argument (`timeout` also takes its duration) */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['command', new Set<string>()],
  ['builtin', new Set<string>()],
  ['exec', new Set(['-a'])],
  ['nohup', new Set<string>()],
  ['time', new Set<string>()],
  ['env', new Set(['-u', '-C', '-P'])],
  ['xargs', new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a'])],
  ['nice', new Set(['-n'])],
  ['timeout', new Set(['-s', '-k'])],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
  ['ionice', new Set(['-c', '-n'])],
]);
/** `env -S 'cmd args'` / `--split-string`: the program is inside one argument, which this reader does not split */
const ENV_SPLIT = /^(-[A-Za-z]*S|--split-string(=|$))/;
const OPAQUE: Word = { text: '?', subst: true, param: false, glob: false };

/**
 * Strip assignments, keywords and wrappers (`env`, `nohup`, `timeout 5`, `xargs …`) down to the program and its
 * arguments. A wrapper whose program cannot be found (`env -S '…'`, flags and nothing after them) yields one opaque word.
 */
export function programWords(words: readonly Word[]): Word[] {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return [];
    const t = w.text;
    const argFlags = w.subst ? undefined : WRAPPERS.get(t);
    if (!w.subst && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || KEYWORDS.has(t))) i += 1;
    else if (argFlags !== undefined) {
      const start = (i += 1);
      for (let f = words[i]; f !== undefined && f.text.startsWith('-'); f = words[i]) {
        if (f.subst || (t === 'env' && ENV_SPLIT.test(f.text))) return [OPAQUE];
        i += argFlags.has(f.text) ? 2 : 1;
      }
      if (t === 'timeout') i += 1;
      if (i >= words.length && (i > start || t === 'timeout')) return [OPAQUE];
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

/** `sed -n` with print-only scripts (`1,20p`, `/re/p`): no `-i`, no `w`/`W`, no script file, nothing that could write. */
function sedReadonly(a: readonly string[]): boolean {
  if (!(hasShort(a, 'n') || hasFlag(a, '--quiet', '--silent'))) return false;
  if (hasShort(a, 'i') || a.some((x) => x.startsWith('--in-place') || x.startsWith('-i'))) return false;
  // a script read from a file cannot be checked here
  if (hasShort(a, 'f') || a.some((x) => x.startsWith('--file'))) return false;
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

const PLAIN_READONLY = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'which', 'stat', 'diff', 'du', 'basename', 'dirname', 'realpath', 'jq']);
const FIND_WRITERS = /^-(delete|exec|execdir|ok|okdir|fprint.*|fls)$/;

function readonlyProgram(program: string, a: readonly string[]): boolean {
  if (PLAIN_READONLY.has(program)) return true;
  // `tree -o FILE` (also inside a flag group, `-ao`) writes its listing; `file -C` compiles a magic file into the cwd
  // `tree -R` writes an HTML listing into every directory it visits
  if (program === 'tree') return !hasShort(a, 'o') && !hasShort(a, 'R') && !a.some((x) => x.startsWith('--output'));
  if (program === 'file') return !hasShort(a, 'C') && !hasFlag(a, '--compile');
  if (program === 'grep' || program === 'rg' || program === 'ag' || program === 'egrep' || program === 'fgrep') return !a.some((x) => x === '--pre' || x.startsWith('--pre='));
  if (program === 'find') return !a.some((x) => FIND_WRITERS.test(x));
  if (program === 'sed') return sedReadonly(a);
  // `sort --compress-program=PROG` runs a program
  if (program === 'sort') return !hasFlag(a, '-o') && !a.some((x) => x.startsWith('--output') || x.startsWith('--compress-program') || /^-[A-Za-z]*o/.test(x));
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

/** Whether an argument names a secret file by its basename (`.env`, `.env.local`, `id_rsa`, `*.pem`; `.env.example` is not one). */
function namesSecret(ws: readonly Word[]): boolean {
  return ws.slice(1).some((w) => {
    const t = w.text.includes('=') && w.text.startsWith('-') ? w.text.slice(w.text.indexOf('=') + 1) : w.text;
    if (t.startsWith('-') || t === '') return false;
    const base = t.slice(t.lastIndexOf('/') + 1);
    return isSecretBasename(base) || (w.glob && base.startsWith('.env') && base !== '.env.example');
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
  // a read-only program pointed at a secret (`cat .env`, `head id_rsa`, `jq --rawfile k .env`) is not read-only: it would run in
  // the ungated observe batch around read_file's secret-path refusal, even under --autonomy review (the S6 review)
  if (namesSecret(ws)) return UNKNOWN;
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
  const v = remoteExec(parsed) ? stricter(destructive('remote_exec'), classifyParsed(parsed, c)) : classifyParsed(parsed, c);
  // an open quote or substitution at the end: the reading above is a guess, and a guess is never read-only
  return parsed.incomplete ? stricter(v, UNKNOWN) : v;
}

/**
 * §A5: the one-line note of a destructive command that ran under full autonomy, truthful about what /undo can do for the
 * WHOLE command: any rule that leaves the machine says so; `restorable` (the pre-images cover it) counts only when every
 * rule is `git_discard`; anything else may not be restored. `rule` is one rule or a compound command's list.
 */
export function destructiveNote(command: string, rule: DestructiveRule | readonly DestructiveRule[], restorable: boolean): string {
  const rules: readonly DestructiveRule[] = typeof rule === 'string' ? [rule] : rule;
  const cmd = command.replace(/\s+/g, ' ').trim();
  const shown = cmd.length > 80 ? `${cmd.slice(0, 79)}…` : cmd;
  const truth = rules.some((r) => REMOTE_RULES.has(r)) ? 'this left the machine; /undo cannot reverse it' : restorable && rules.every((r) => r === 'git_discard') ? '/undo restores the workspace' : '/undo may not restore this';
  return `ran ${shown} (${rules.length > 1 ? 'rules' : 'rule'} ${rules.join(', ')}) — ${truth}`;
}

/**
 * The gate of one mutating command (§12, §A2). Full autonomy never asks and never refuses: a destructive verdict is `ok`
 * with its rule and the note. Review asks for destructive and unknown commands; readonly and safe ones never ask.
 */
export function commandGate(v: CommandVerdict, autonomy: 'full' | 'review', note: string | null): AgentGate {
  const rules = rulesOf(v);
  const all = rules.length > 1 ? { rules } : {};
  if (autonomy === 'review') {
    if (v.class === 'destructive') return { verdict: 'review', reason: v.reason, rule: v.rule, ...all };
    if (v.class === 'unknown') return { verdict: 'review', reason: v.reason, rule: null };
    return { verdict: 'ok', reason: '', rule: null };
  }
  if (v.class === 'destructive' && v.rule !== null) return { verdict: 'ok', reason: note ?? destructiveNote('', rules, false), rule: v.rule, ...all };
  return { verdict: 'ok', reason: '', rule: null };
}

/**
 * §9.4, §12: the step's `RiskAssessment` when a rule decided — the rule id in `rule`, its sentence (or the full-autonomy
 * note) as `reason`, risk 1, and zeroed dimensions that are never drawn. Null when no rule matched (nothing to record).
 */
export function ruleRiskAssessment(gate: AgentGate): RiskAssessment | null {
  if (gate.rule === null) return null;
  const zero: RiskDimensionResult = { risk: 0, probability: 0, expected: 0, tailMass: 0, bound: 'expected', confidence: 0, level: 0 };
  const dims = Object.fromEntries(RISK_DIMENSIONS.map((d) => [d, { ...zero }])) as Record<RiskDimension, RiskDimensionResult>;
  return { dims, risk: 1, verdict: gate.verdict, reason: gate.reason, rule: gate.rule };
}
