/**
 * Sandboxed command execution (DESIGN.md §8).
 *
 * `run()` resolves for timeouts, wall-time kills and output caps (the result carries
 * `killedBy` / `truncated`) and rejects only for a spawn failure (SandboxError) or an engine
 * abort whose reason is an AbortError. Output is bounded by a shared byte counter: a head of
 * at most `maxOutputBytes` plus a rolling 16 KB tail per stream, so the final lines (test
 * summaries) survive a flood. Kills always go through the three-pass tree kill.
 *
 * The environment is the user's own minus secrets (`buildEnv`), the way the leading coding agents run commands: a
 * toolchain shim, a proxy or CA setting, `JAVA_HOME` or a `DATABASE_URL` works inside the sandbox as it does in the
 * user's shell. `HOME` and `TMPDIR` point into the run directory; the user's git identity is copied into that HOME
 * (`writeGitIdentity`) so a commit a command makes carries the user's name.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { ExecResult, KilledBy, Sandbox, SandboxCreateOptions, SandboxRunOptions } from '../core/types.js';
import { SandboxError, isAbortError, isBudgetError } from '../errors.js';
import { killTree } from './kill.js';
import type { KillTreeOptions, KillTreeResult } from './kill.js';
import { canonicalPath, canonicalPathSync, isWithin } from './paths.js';
import { commandLabel, stepTimeline } from '../perf/timeline.js';
import { SANDBOX_EXEC, buildProfile, detectSandboxLevel } from './seatbelt.js';

export const TAIL_BYTES = 16 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;
/** After the shell exits, how long to wait for a stray pipe holder before closing our ends. */
const PIPE_DRAIN_GRACE_MS = 1_000;
/** After SIGKILL, how long to wait for the root's exit before giving up on it. */
const EXIT_AFTER_KILL_GRACE_MS = 5_000;

/** A name that marks its value as a credential (Codex CLI's default policy drops *KEY*, *SECRET*, *TOKEN* the same way). */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW|PASSPHRASE|CREDENTIAL|COOKIE/i;
/** an `AUTH` name segment (`NODE_AUTH_TOKEN`, `SSH_AUTH_SOCK`, `BASIC_AUTH`); `GIT_AUTHOR_NAME` has none */
const AUTH_SEGMENT = /(^|_)AUTH(_|$)/i;
/**
 * JevCode's own switches, npm's per-script context (`npm_*`, and `INIT_CWD`, the directory jevcode was launched from),
 * and every `GIT_*`: an inherited `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE` would point the harness's own sandboxed
 * git (which sets only GIT_CONFIG_NOSYSTEM / GIT_CONFIG_GLOBAL through `extra`) and the model's commands at another tree.
 */
const DROPPED_PREFIX = /^(JEVCODE_|JEV_|npm_|GIT_)/i;
/** set by the sandbox itself (HOME, TMPDIR, VIRTUAL_ENV), the shell's own bookkeeping, and the per-user XDG dirs HOME's remap moves */
const DROPPED_NAMES: ReadonlySet<string> = new Set([
  'INIT_CWD',
  'VIRTUAL_ENV',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
]);

/** Does a variable of the harness's environment reach a command? Its name alone decides (see `buildEnv` for the value rule). */
export function inheritsEnvName(name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  if (SECRET_NAME.test(name) || AUTH_SEGMENT.test(name)) return false;
  if (DROPPED_PREFIX.test(name) || DROPPED_NAMES.has(name)) return false;
  return true;
}

/**
 * Version-manager homes that live under the real HOME and are read, not written, on an ordinary command: with HOME
 * remapped, a rustup / pyenv / rbenv / asdf / volta / nvm / sdkman shim would look for its home in the run directory and
 * find no toolchain. Each is set only when the user has not set it and the directory exists. Caches a build WRITES
 * (CARGO_HOME, GOPATH / GOMODCACHE, GRADLE_USER_HOME, ~/.m2, ~/.npm) are never pointed at the real home: the macOS
 * profile denies writes there, and a fresh cache in the run's HOME works everywhere.
 */
const TOOLCHAIN_HOMES: readonly (readonly [string, string])[] = [
  ['RUSTUP_HOME', '.rustup'],
  ['PYENV_ROOT', '.pyenv'],
  ['RBENV_ROOT', '.rbenv'],
  ['ASDF_DATA_DIR', '.asdf'],
  ['VOLTA_HOME', '.volta'],
  ['NVM_DIR', '.nvm'],
  ['SDKMAN_DIR', '.sdkman'],
];

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The toolchain homes that exist under `home`, as `[name, path]` (see TOOLCHAIN_HOMES). */
export function existingToolchainHomes(home: string, exists: (p: string) => boolean = isDirectory): [string, string][] {
  return TOOLCHAIN_HOMES.map(([name, dir]) => [name, join(home, dir)] as [string, string]).filter(([, p]) => exists(p));
}

/** The user's git identity from their global config. */
export interface GitIdentity {
  name: string | null;
  email: string | null;
}

/**
 * The user's `user.name` / `user.email`, asked of `git config --global` once per process, OUTSIDE the sandbox (3 s
 * timeout); null when neither is set or git is missing. `probe` is the test seam, as in resolvePythonUserBase.
 */
export function resolveGitIdentity(opts: { probe?: () => GitIdentity | null } = {}): GitIdentity | null {
  const id = (opts.probe ?? defaultGitIdentityProbe)();
  return id !== null && (id.name !== null || id.email !== null) ? id : null;
}

let probedGitIdentity: GitIdentity | null | undefined;
function defaultGitIdentityProbe(): GitIdentity | null {
  if (probedGitIdentity !== undefined) return probedGitIdentity;
  const get = (key: string): string | null => {
    try {
      // --includes: with --global git skips include/includeIf by default, and an identity kept in an included file is common
      const r = spawnSync('git', ['config', '--global', '--includes', '--get', key], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
      const v = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : '';
      return v === '' ? null : v;
    } catch {
      return null;
    }
  };
  probedGitIdentity = { name: get('user.name'), email: get('user.email') };
  return probedGitIdentity;
}

/** A git-config value, quoted so `#`, `;` and surrounding spaces survive. */
function gitConfigValue(v: string): string {
  return `"${v.replace(/[\r\n]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * `<runHome>/.gitconfig` with the user's identity and nothing else — no aliases, hooks, credential helpers or signing
 * setup — so `git commit` in a command does not stop at "Author identity unknown". Not the GIT_AUTHOR_* variables: those
 * would override the `-c user.name=` identity the harness's own commits pass (src/orchestrate/commit.ts). The harness's
 * git calls run with GIT_CONFIG_GLOBAL=/dev/null and never read this file. A file already there (the run's own `git
 * config --global` from an earlier sandbox of this run dir) is kept.
 */
export function writeGitIdentity(runHome: string, id: GitIdentity): void {
  const lines = ['# written by jevcode: your git identity, so a commit made by a command carries your name', '[user]'];
  if (id.name !== null) lines.push(`\tname = ${gitConfigValue(id.name)}`);
  if (id.email !== null) lines.push(`\temail = ${gitConfigValue(id.email)}`);
  try {
    writeFileSync(join(runHome, '.gitconfig'), `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    /* already there, or the run's HOME is not writable: a command simply has no identity, as before */
  }
}

/**
 * Python derives its user site-packages (`pip install --user pytest`) from HOME, and the sandbox remaps HOME, so a
 * pytest that lives there reads as `No module named pytest` inside the sandbox — the first live run on such a machine
 * then sees a baseline of errors and no failing test, and has nothing to fix. The real user base is passed through as
 * `PYTHONUSERBASE` (readable under the seatbelt, which allows reads by default; writes still land in the run's HOME).
 * The caller's own `PYTHONUSERBASE` wins; otherwise `python3 -c 'import site; print(site.USER_BASE)'` is asked once
 * per process and the answer is used only when it names an existing directory.
 */
export function resolvePythonUserBase(opts: { env?: NodeJS.ProcessEnv; probe?: () => string | null; exists?: (p: string) => boolean } = {}): string | null {
  const env = opts.env ?? process.env;
  const own = env['PYTHONUSERBASE'];
  if (typeof own === 'string' && own !== '') return own;
  const probe = opts.probe ?? defaultPythonUserBaseProbe;
  const exists = opts.exists ?? ((p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  const base = probe();
  return base !== null && base !== '' && exists(base) ? base : null;
}

let probedPythonUserBase: string | null | undefined;
function defaultPythonUserBaseProbe(): string | null {
  if (probedPythonUserBase !== undefined) return probedPythonUserBase;
  try {
    const r = spawnSync('python3', ['-c', 'import site; print(site.USER_BASE)'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    probedPythonUserBase = r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim() !== '' ? r.stdout.trim() : null;
  } catch {
    probedPythonUserBase = null;
  }
  return probedPythonUserBase;
}
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const SANDBOX_EXEC_DENIED = /sandbox-exec: .*execvp/;
/** setTimeout silently falls back to 1 ms above this; a larger timeout must not become an instant kill. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Test hooks; production callers pass nothing. */
export interface SandboxInternals {
  killTreeOptions?: KillTreeOptions;
  killTreeImpl?: typeof killTree;
  ttyPath?: string | null;
  platform?: NodeJS.Platform;
  /** the git identity copied into the run's HOME (default: `resolveGitIdentity()`, the user's global config) */
  gitIdentity?: () => GitIdentity | null;
  /** the real home the toolchain homes are looked up under (default `os.homedir()`) */
  homeDir?: string;
}

interface SharedCounter {
  bytesSeen: number;
  headBytes: number;
  truncated: boolean;
}

/** Head (shared cap) plus rolling tail for one stream. */
class StreamCollector {
  private readonly decoder = new StringDecoder('utf8');
  private head = '';
  private headBytes = 0;
  private tail: Buffer = Buffer.alloc(0);
  private seen = 0;
  private readonly shared: SharedCounter;
  private readonly cap: number;
  constructor(shared: SharedCounter, cap: number) {
    this.shared = shared;
    this.cap = cap;
  }

  /** Returns the decoded head portion of the chunk (what may be shown live), or '' once capped. */
  push(chunk: Buffer): string {
    this.seen += chunk.length;
    this.shared.bytesSeen += chunk.length;
    const room = Math.max(0, this.cap - this.shared.headBytes);
    let live = '';
    if (room >= chunk.length) {
      live = this.decoder.write(chunk);
      this.head += live;
      this.headBytes += chunk.length;
      this.shared.headBytes += chunk.length;
      return live;
    }
    if (room > 0) {
      live = this.decoder.write(chunk.subarray(0, room));
      this.head += live;
      this.headBytes += room;
      this.shared.headBytes += room;
    }
    this.shared.truncated = true;
    const rest = chunk.subarray(room);
    this.tail = rest.length >= TAIL_BYTES ? Buffer.from(rest.subarray(rest.length - TAIL_BYTES)) : Buffer.concat([this.tail, rest]).subarray(-TAIL_BYTES);
    return live;
  }

  finish(): string {
    this.head += this.decoder.end();
    if (this.tail.length === 0) return this.head;
    // The kept tail starts after its first newline, so it never begins mid-line — nor inside an escape sequence whose ESC
    // was cut off, which no stripper can recognise any more (a 600 KB SGR flood's tail began `m\u001b[39m test 19600
    // passes`). One long line with no newline to cut at keeps its tail whole, minus a leading partial UTF-8 sequence.
    let start = 0;
    const nl = this.tail.indexOf(0x0a);
    if (nl >= 0 && nl < this.tail.length - 1) start = nl + 1;
    else while (start < this.tail.length && start < 4 && (this.tail[start]! & 0xc0) === 0x80) start++;
    const kept = this.tail.subarray(start);
    const dropped = this.seen - this.headBytes - kept.length;
    return `${this.head}\n…[output truncated: ${dropped} bytes omitted]…\n${kept.toString('utf8')}`;
  }
}

/** `<workspaceRoot>/.venv` when it has a bin/ directory: live SWE-bench agents must use the repo's venv. */
function repoVenv(workspaceRoot: string): string | null {
  const venv = join(workspaceRoot, '.venv');
  try {
    return statSync(join(venv, 'bin')).isDirectory() ? venv : null;
  } catch {
    return null;
  }
}

/** Would the redactor mask this value? A throwing redactor counts as yes: the variable is dropped, not the command. */
function masked(redact: (s: string) => string, v: string): boolean {
  try {
    return redact(v) !== v;
  } catch {
    return true;
  }
}

/**
 * A command's environment: the harness's own, minus every variable whose name marks it as a secret or as JevCode's,
 * npm's or git's context (`inheritsEnvName`) and minus any value the redactor would mask (a key under an unusual
 * name); then HOME and TMPDIR in the run directory, the PATH fallback, the workspace venv, the Python user base, the
 * toolchain homes the user has not set, and `extra` last. Values are passed by name, so a password inside a
 * URL-valued variable such as DATABASE_URL is passed; that is the user's own configuration, as in their shell.
 */
function buildEnv(runTmp: string, runHome: string, extra: Record<string, string> | undefined, venv: string | null, redact: (s: string) => string, toolchainHomes: readonly (readonly [string, string])[]): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string' || !inheritsEnvName(k) || masked(redact, v)) continue;
    env[k] = v;
  }
  if (!env['PATH']) env['PATH'] = DEFAULT_PATH;
  if (venv !== null) {
    // Same effect as `source .venv/bin/activate`; `extra` (harness git, bench evaluators) may still override.
    env['PATH'] = `${join(venv, 'bin')}:${env['PATH']}`;
    env['VIRTUAL_ENV'] = venv;
  }
  env['TMPDIR'] = runTmp;
  env['HOME'] = runHome;
  // a user-site pytest stays importable although HOME is remapped (see resolvePythonUserBase)
  const userBase = resolvePythonUserBase();
  if (userBase !== null) env['PYTHONUSERBASE'] = userBase;
  for (const [name, path] of toolchainHomes) if (env[name] === undefined) env[name] = path;
  if (extra) for (const [k, v] of Object.entries(extra)) if (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = v;
  return env;
}

function abortRejects(reason: unknown): boolean {
  return isAbortError(reason) || (reason instanceof Error && reason.name === 'AbortError');
}

function killedByFor(reason: unknown, override: KilledBy | undefined): KilledBy {
  if (override) return override;
  if (isBudgetError(reason) && reason.reason === 'wall_time') return 'wall_time';
  return 'abort';
}

function detectTty(): string | null {
  if (!process.stdout.isTTY) return null;
  try {
    const p = realpathSync('/dev/fd/1');
    return p.startsWith('/dev/tty') ? p : null;
  } catch {
    return null;
  }
}

interface LiveChild {
  child: ChildProcess;
  kill: (reason: KilledBy) => void;
  done: Promise<void>;
}

export function createSandbox(opts: SandboxCreateOptions, internals: SandboxInternals = {}): Sandbox {
  let workspaceRoot: string;
  let runDir: string;
  /** canonical extra writable roots (SandboxCreateOptions.extraWritable); also accepted as cwd */
  const extraRoots: string[] = [];
  try {
    workspaceRoot = realpathSync(opts.workspaceRoot);
    mkdirSync(opts.runDir, { recursive: true });
    runDir = realpathSync(opts.runDir);
    mkdirSync(join(runDir, 'tmp'), { recursive: true });
    mkdirSync(join(runDir, 'home'), { recursive: true });
    for (const p of opts.extraWritable ?? []) {
      if (typeof p !== 'string' || p.length === 0) continue;
      const canon = canonicalPathSync(resolve(p));
      if (!extraRoots.includes(canon)) extraRoots.push(canon);
    }
  } catch (e) {
    throw new SandboxError(`cannot set up sandbox: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const runTmp = join(runDir, 'tmp');
  const runHome = join(runDir, 'home');
  /**
   * The run's HOME gets the user's git identity and the toolchain homes are looked up once, before the first command of
   * this sandbox — not in the constructor, so building an engine that never runs a command spawns no `git config`.
   */
  let toolchainHomes: [string, string][] | null = null;
  const homeFor = (): [string, string][] => {
    if (toolchainHomes !== null) return toolchainHomes;
    const identity = (internals.gitIdentity ?? resolveGitIdentity)();
    if (identity !== null) writeGitIdentity(runHome, identity);
    toolchainHomes = existingToolchainHomes(internals.homeDir ?? homedir());
    return toolchainHomes;
  };

  const level = detectSandboxLevel(opts.profile, internals.platform ?? process.platform);
  // TUI-DESIGN §12.7 / §15 item 18: the probe's git dirs and the resolved jevcode config dirs, forwarded
  // to buildProfile and folded into the profile-path hash (two sandboxes of one run dir that differ only
  // here must not share a file); absent → the hash input is exactly today's.
  const gitDir = typeof opts.gitDir === 'string' && opts.gitDir.length > 0 ? resolve(opts.gitDir) : null;
  const gitCommonDir = typeof opts.gitCommonDir === 'string' && opts.gitCommonDir.length > 0 ? resolve(opts.gitCommonDir) : null;
  const configDirs = (opts.configDirs ?? []).filter((p): p is string => typeof p === 'string' && p.length > 0).map((p) => resolve(p));
  // contract 1.5 (ORCHESTRATION-DESIGN §5.2 [G3]): the child's ref-deny list. Folded into the hash below for the
  // same reason the git dirs are — [D10] puts a depth-0 supervisor sandbox and a depth-1 child sandbox over the
  // SAME worktree in the SAME run dir, and an unhashed difference would make them share one `sandbox-<h>.sb`.
  const agentChild = opts.agentChild === true;
  let profilePath: string | null = null;
  if (level === 'seatbelt') {
    // One profile file per sandbox instance: several sandboxes can share a run dir (the bench
    // creates one per root: workspace, venv, bare-clone cache), and a fixed name let a later
    // sandbox overwrite an earlier one's profile mid-run, leaving its workspace unreadable.
    const hashInput = [workspaceRoot, extraRoots.join('\n'), opts.noNetwork ? '1' : '0'];
    if (gitDir !== null || gitCommonDir !== null || configDirs.length > 0) hashInput.push(gitDir ?? '', gitCommonDir ?? '', configDirs.join('\n'));
    if (agentChild) hashInput.push('agent-child');
    profilePath = join(runDir, `sandbox-${createHash('sha256').update(hashInput.join('\n')).digest('hex').slice(0, 12)}.sb`);
    const profile = buildProfile({
      ws: workspaceRoot,
      runTmp,
      runHome,
      ttyPath: internals.ttyPath === undefined ? detectTty() : internals.ttyPath,
      readDenies: opts.secretReadDenies,
      noNetwork: opts.noNetwork,
      extraWritable: extraRoots,
      extraReadable: (opts.extraReadable ?? []).filter((p): p is string => typeof p === 'string' && p.length > 0).map((p) => resolve(p)),
      ...(opts.protectGit === false ? { protectGit: false } : {}),
      ...(gitDir !== null ? { gitDir } : {}),
      ...(gitCommonDir !== null ? { gitCommonDir } : {}),
      ...(configDirs.length > 0 ? { configDirs } : {}),
      ...(agentChild ? { agentChild: true } : {}),
    });
    try {
      writeFileSync(profilePath, profile, { mode: 0o600 });
    } catch (e) {
      throw new SandboxError(`cannot write seatbelt profile: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }
  const redact = opts.redact;
  const live = new Set<LiveChild>();
  /** process groups whose shell exited while a background member still held our pipes */
  const strayGroups = new Set<number>();
  const killImpl = internals.killTreeImpl ?? killTree;

  async function resolveCwd(cwd: string | undefined): Promise<string> {
    if (cwd === undefined) return workspaceRoot;
    if (typeof cwd !== 'string' || cwd.length === 0) throw new SandboxError('cwd must be a non-empty path');
    const canon = (await canonicalPath(resolve(workspaceRoot, cwd))).path;
    if (!isWithin(workspaceRoot, canon) && !isWithin(runDir, canon) && !extraRoots.some((r) => isWithin(r, canon))) {
      throw new SandboxError(`cwd "${cwd}" is outside the workspace, the run dir and the extra writable roots`);
    }
    // a missing cwd makes spawn() fail as `spawn /usr/bin/sandbox-exec ENOENT`, which reads as a missing sandbox binary (the S6 live
    // run of 2026-09-23: the model then told the user the sandbox was not installed); say what is actually missing
    const st = await stat(canon).catch(() => null);
    if (st === null || !st.isDirectory()) throw new SandboxError(`cwd "${cwd}" is not a directory (it does not exist)`);
    return canon;
  }

  function validate(command: string, o: SandboxRunOptions): { timeoutMs: number; maxOutputBytes: number } {
    if (typeof command !== 'string' || command.length === 0) throw new SandboxError('command must be a non-empty string');
    if (command.includes('\0')) throw new SandboxError('command contains a NUL byte');
    const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? Math.min(Math.floor(o.timeoutMs), MAX_TIMER_MS) : NaN;
    if (Number.isNaN(timeoutMs)) throw new SandboxError(`timeoutMs must be a positive number (got ${String(o.timeoutMs)})`);
    const maxOutputBytes = Number.isFinite(o.maxOutputBytes) && o.maxOutputBytes > 0 ? Math.floor(o.maxOutputBytes) : DEFAULT_MAX_OUTPUT_BYTES;
    if (!(o.signal instanceof AbortSignal)) throw new SandboxError('signal must be an AbortSignal');
    return { timeoutMs, maxOutputBytes };
  }

  async function run(command: string, o: SandboxRunOptions): Promise<ExecResult> {
    const { timeoutMs, maxOutputBytes } = validate(command, o);
    const cwd = await resolveCwd(o.cwd);
    const started = performance.now();

    if (o.signal.aborted) {
      // Nothing to kill; mirror the post-kill contract without spawning.
      if (abortRejects(o.signal.reason)) throw o.signal.reason;
      return finish(killedByFor(o.signal.reason, o.abortKilledBy), null, null, '', '', { bytesSeen: 0, headBytes: 0, truncated: false }, [], started);
    }

    const env = buildEnv(runTmp, runHome, o.env, repoVenv(workspaceRoot), redact, homeFor());
    const [file, args] = profilePath ? [SANDBOX_EXEC, ['-f', profilePath, '/bin/sh', '-c', command]] : ['/bin/sh', ['-c', command]];

    return new Promise<ExecResult>((resolvePromise, rejectPromise) => {
      const shared: SharedCounter = { bytesSeen: 0, headBytes: 0, truncated: false };
      const out = new StreamCollector(shared, maxOutputBytes);
      const err = new StreamCollector(shared, maxOutputBytes);
      let killedBy: KilledBy = null;
      let killResult: Promise<KillTreeResult> | null = null;
      let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let settled = false;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let drainTimer: NodeJS.Timeout | null = null;
      let exitGuard: NodeJS.Timeout | null = null;
      let resolveDone: () => void = () => undefined;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });

      let child: ChildProcess;
      try {
        child = spawn(file, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
      } catch (e) {
        rejectPromise(new SandboxError(`cannot spawn /bin/sh: ${e instanceof Error ? e.message : String(e)}`, { cause: e }));
        return;
      }

      const cleanup = (): void => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (drainTimer) clearTimeout(drainTimer);
        if (exitGuard) clearTimeout(exitGuard);
        o.signal.removeEventListener('abort', onAbort);
        live.delete(entry);
        resolveDone();
      };

      const forward = (stream: 'stdout' | 'stderr', text: string): void => {
        if (!o.onOutput || text.length === 0) return;
        try {
          o.onOutput(stream, redact(text));
        } catch {
          /* a renderer bug must not kill the command */
        }
      };

      const startKill = (reason: KilledBy): void => {
        if (killedBy !== null || settled || child.pid === undefined) return;
        killedBy = reason;
        killResult = killImpl(child.pid, internals.killTreeOptions ?? {}).catch((): KillTreeResult => ({ tree: [], orphans: [], snapshotFailed: true }));
        // A root that survives SIGKILL (unkillable state) must not hang the run forever.
        void killResult.then(() => {
          if (exitInfo === null && !settled) {
            exitGuard = setTimeout(() => {
              if (settled) return;
              exitInfo = { code: null, signal: 'SIGKILL' };
              child.stdout?.destroy();
              child.stderr?.destroy();
              child.unref();
              void settle();
            }, EXIT_AFTER_KILL_GRACE_MS);
          }
        });
      };

      const onAbort = (): void => startKill(killedByFor(o.signal.reason, o.abortKilledBy));

      const settle = async (): Promise<void> => {
        if (settled) return;
        settled = true;
        const kr = killResult ? await killResult : null;
        cleanup();
        const info = exitInfo ?? { code: null, signal: null };
        let result: ExecResult;
        try {
          result = finish(killedBy, info.code, info.signal, out.finish(), err.finish(), shared, kr?.orphans ?? [], started);
        } catch (e) {
          // a throwing redact() must surface as a rejection, never as an unhandled promise
          rejectPromise(new SandboxError(`cannot build the exec result: ${e instanceof Error ? e.message : String(e)}`, { cause: e }));
          return;
        }
        if (killedBy !== null && o.signal.aborted && abortRejects(o.signal.reason)) {
          rejectPromise(o.signal.reason);
          return;
        }
        resolvePromise(result);
      };

      const entry: LiveChild = { child, kill: startKill, done };
      live.add(entry);

      child.stdout?.on('data', (chunk: Buffer) => forward('stdout', out.push(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => forward('stderr', err.push(chunk)));
      child.on('error', (e) => {
        if (settled) return;
        if (child.pid === undefined) {
          settled = true;
          cleanup();
          rejectPromise(new SandboxError(`cannot spawn ${file}: ${e.message}`, { cause: e }));
        }
      });
      child.on('exit', (code, signal) => {
        exitInfo = { code, signal };
        // The shell is gone; if a background holder keeps our pipes open, close them ourselves
        // and remember the group so killAll() can reap it at shutdown.
        drainTimer = setTimeout(() => {
          if (child.pid !== undefined && killedBy === null) strayGroups.add(child.pid);
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, PIPE_DRAIN_GRACE_MS);
      });
      child.on('close', (code, signal) => {
        if (exitInfo === null) exitInfo = { code, signal };
        void settle();
      });

      timeoutTimer = setTimeout(() => startKill('timeout'), timeoutMs);
      o.signal.addEventListener('abort', onAbort, { once: true });
      if (o.signal.aborted) onAbort();
    });
  }

  function finish(
    killedBy: KilledBy,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stdout: string,
    stderr: string,
    shared: SharedCounter,
    orphans: number[],
    started: number,
  ): ExecResult {
    const redOut = redact(stdout);
    const redErr = redact(stderr);
    return {
      ok: exitCode === 0 && killedBy === null,
      exitCode,
      signal,
      stdout: redOut,
      stderr: redErr,
      truncated: shared.truncated,
      bytesSeen: shared.bytesSeen,
      killedBy,
      timedOut: killedBy === 'timeout',
      orphans,
      sandboxExecDenied: exitCode === 71 && SANDBOX_EXEC_DENIED.test(stderr),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    };
  }

  async function killAll(): Promise<void> {
    const entries = [...live];
    for (const e of entries) e.kill('abort');
    const strays = [...strayGroups];
    strayGroups.clear();
    await Promise.allSettled([...entries.map((e) => e.done), ...strays.map((pgid) => killImpl(pgid, internals.killTreeOptions ?? {}))]);
  }

  /**
   * HARNESS-NEXT-DESIGN §4.1 queues 1 and 5 (wave S0): every sandboxed process run is the lane/candidate queue —
   * `exec` inside the agent's own execute stage, `lane` everywhere else (candidate runs, lane setup, the `git status`
   * refresh), labelled by argv0. Off unless `JEVCODE_TIMELINE` is set, where it is `run` itself with no wrapper.
   */
  const timedRun = (command: string, o: SandboxRunOptions): Promise<ExecResult> => {
    if (!stepTimeline.isEnabled()) return run(command, o);
    return stepTimeline.measure(stepTimeline.currentStage() === 'execute' ? 'exec' : 'lane', commandLabel(command), () => run(command, o));
  };

  return { level, run: timedRun, killAll };
}
