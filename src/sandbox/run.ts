/**
 * Sandboxed command execution (DESIGN.md §8).
 *
 * `run()` resolves for timeouts, wall-time kills and output caps (the result carries
 * `killedBy` / `truncated`) and rejects only for a spawn failure (SandboxError) or an engine
 * abort whose reason is an AbortError. Output is bounded by a shared byte counter: a head of
 * at most `maxOutputBytes` plus a rolling 16 KB tail per stream, so the final lines (test
 * summaries) survive a flood. Kills always go through the three-pass tree kill.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { ExecResult, KilledBy, Sandbox, SandboxCreateOptions, SandboxRunOptions } from '../core/types.js';
import { SandboxError, isAbortError, isBudgetError } from '../errors.js';
import { killTree } from './kill.js';
import type { KillTreeOptions, KillTreeResult } from './kill.js';
import { canonicalPath, canonicalPathSync, isWithin } from './paths.js';
import { SANDBOX_EXEC, buildProfile, detectSandboxLevel } from './seatbelt.js';

export const TAIL_BYTES = 16 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;
/** After the shell exits, how long to wait for a stray pipe holder before closing our ends. */
const PIPE_DRAIN_GRACE_MS = 1_000;
/** After SIGKILL, how long to wait for the root's exit before giving up on it. */
const EXIT_AFTER_KILL_GRACE_MS = 5_000;
const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'TERM'] as const;
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
    // Drop a leading partial UTF-8 sequence so the tail decodes cleanly.
    let start = 0;
    while (start < this.tail.length && start < 4 && (this.tail[start]! & 0xc0) === 0x80) start++;
    const tailText = this.tail.subarray(start).toString('utf8');
    const dropped = this.seen - this.headBytes - this.tail.length;
    return `${this.head}\n…[output truncated: ${dropped} bytes omitted]…\n${tailText}`;
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

function buildEnv(runTmp: string, runHome: string, extra: Record<string, string> | undefined, venv: string | null): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = process.env[k];
    if (typeof v === 'string') env[k] = v;
  }
  if (!env['PATH']) env['PATH'] = DEFAULT_PATH;
  if (venv !== null) {
    // Same effect as `source .venv/bin/activate`; `extra` (harness git, bench evaluators) may still override.
    env['PATH'] = `${join(venv, 'bin')}:${env['PATH']}`;
    env['VIRTUAL_ENV'] = venv;
  }
  env['TMPDIR'] = runTmp;
  env['HOME'] = runHome;
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

  const level = detectSandboxLevel(opts.profile, internals.platform ?? process.platform);
  let profilePath: string | null = null;
  if (level === 'seatbelt') {
    profilePath = join(runDir, 'sandbox.sb');
    const profile = buildProfile({
      ws: workspaceRoot,
      runTmp,
      runHome,
      ttyPath: internals.ttyPath === undefined ? detectTty() : internals.ttyPath,
      readDenies: opts.secretReadDenies,
      noNetwork: opts.noNetwork,
      extraWritable: extraRoots,
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

    const env = buildEnv(runTmp, runHome, o.env, repoVenv(workspaceRoot));
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

  return { level, run, killAll };
}
