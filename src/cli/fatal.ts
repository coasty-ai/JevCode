/**
 * `fatalExit` (TUI-DESIGN §13.4, A161, A162; DESIGN §11's single redacting `fatal()`).
 *
 * Order, fixed by the design: (1) `process.exitCode = err.exitCode` behind an idempotent guard; (2) synchronous
 * terminal restore before anything is printed (`RESTORE`, raw mode off; never `ESC c` / `ESC[2J`); (3)
 * `engine.abort('error', { error })` so the `'exit'` handler writes `state.json`, then `renderer.unmount()` raced
 * with the unmount timeout; (4) the redacted epilogue on stderr, then `process.exit(code)`.
 *
 * Wave 1 ships the pure part (`fatalLines`, `RESTORE`) and the fully injectable `createFatalExit(deps)` /
 * `installFatalHandlers(deps)`. Wave 2 adds the process wiring on top: `wireFatalHandlers(deps)` binds the real
 * `fs.writeSync`, `stdin.setRawMode(false)`, `process.exit`, the stdio `'error'` listeners (EIO/EPIPE, installed
 * before any SIGHUP logic), SIGHUP, and stdin `'end'` gated on `stdin.isTTY && stdin.isRaw` (Ink mounted) — the
 * hang-up path aborts with `signal: 'SIGHUP'`, writes nothing to the terminal and exits 129.
 */
import { writeSync as fsWriteSync } from 'node:fs';
import type { Engine, SerializedError, SignalName } from '../core/types.js';
import { serializeError } from '../loop/stop.js';
import { EXIT_CODES, type FsErrorContext, type FsExplanation, type FsOp, explainFsError, fsErrorToJevCodeError } from '../errors.js';
import { shortPath } from '../core/text.js';
import { type EpilogueContext, epilogueLines, terminalSafeLine } from './epilogue.js';

/**
 * TUI-DESIGN §14.2: bracketed paste off, synchronized output off, cursor shape reset (DECSCUSR 0), cursor shown,
 * attributes reset. Never `ESC c`, `ESC[2J` or `ESC[3J` (scrollback is the user's).
 */
export const RESTORE = '\x1b[?2004l\x1b[?2026l\x1b[0 q\x1b[?25h\x1b[0m';

/**
 * TUI-DESIGN-4 §1.3.1: leave the alternate screen (`ESC[?1049l`). It is **not** part of `RESTORE`, because a
 * classic-renderer session never entered it and must not have its screen swapped on the way out; it is written
 * only when the flag below says the mount entered it.
 *
 * The flag and the bytes live HERE rather than in `src/tui/terminal.ts` (where §1.3.1 first put them) for one
 * reason: `terminal.ts` already imports `RESTORE` from this module, so importing the flag back would close an
 * `cli/fatal ⇄ tui/terminal` cycle on the eager fatal path. `terminal.ts` re-exports all three, so
 * `markAlternateScreen` / `alternateScreenEntered` / `ALT_SCREEN_LEAVE` keep their §1.3.1 import sites.
 */
export const ALT_SCREEN_LEAVE = '\x1b[?1049l';

/** the module-level flag §1.3.1 names: set once by `createTuiRenderer` when it mounts Ink with `alternateScreen: true` */
let altScreenEntered = false;

/** TUI-DESIGN-4 §1.3.1: record that Ink entered the alternate screen, so every restore path leaves it first. */
export function markAlternateScreen(entered = true): void {
  altScreenEntered = entered;
}

/** true when a mount has declared the alternate screen entered (tests; every restore path reads the same flag). */
export function alternateScreenEntered(): boolean {
  return altScreenEntered;
}

/** Bound on `renderer.unmount()` inside fatalExit (mirrors UNMOUNT_TIMEOUT_MS in tui/App.tsx without importing Ink here). */
export const FATAL_UNMOUNT_TIMEOUT_MS = 2000;

/** The exit code of a stdout/stderr EIO/EPIPE or a hang-up (TUI-DESIGN §13.5: SIGHUP / EIO → 129). */
export const HANGUP_EXIT_CODE = 129;

/**
 * TUI-DESIGN-4 §2.8 P-R11 / §12: EPIPE on stdout used to exit 129 with an **empty** stderr, so a `| head` left no
 * trace of a run that had in fact been checkpointed. One line says where it is; the code stays 129 (§14.1 row 9:
 * `EXIT_CODE_TABLE` uses it for SIGHUP and changing it is a compatibility break for no gain). Returns `null` when
 * there is no directory to name — a launch-time hang-up has nothing to say.
 */
export function hangupStderrLine(runDir: string | null, runsDir: string | null, shorten: (p: string) => string = (p) => p): string | null {
  const dir = runDir ?? runsDir;
  if (typeof dir !== 'string' || dir.length === 0) return null;
  return `jevcode: stdout closed; run checkpointed at ${terminalSafeLine(shorten(dir))}`;
}

/** TUI-DESIGN-4 §7.4 row 2 / §7.7 edge: the errnos that mean "this run cannot be checkpointed" rather than "this path is wrong". */
const DISK_FULL_CODES: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT']);

/** TUI-DESIGN-4 §7.4 / §12: what an unclassified error adds to the `[ui] error: <raw errno>` fallback. */
export const DEBUG_STACK_HINT = 'run with JEVCODE_DEBUG=1 for the stack';

/**
 * TUI-DESIGN §13.4 step 4: the epilogue plus, under `JEVCODE_DEBUG=1`, the stack — every line through `redact`,
 * control characters dropped. Pure.
 */
export function fatalLines(
  err: SerializedError,
  ctx: EpilogueContext,
  redact: (s: string) => string,
  opts: { stack?: string | null; debug?: boolean; explain?: FsExplanation | null } = {},
): string[] {
  const lines = epilogueLines(err, ctx, redact);
  /**
   * TUI-DESIGN-4 §7.4 (P-D4): a classified file-system failure gets its fix block — at most two rows, so it fits
   * the flat tier. An **unclassified** error keeps today's epilogue; `DEBUG_STACK_HINT` is what the `[ui] error:`
   * fallback adds there (§7.4's last paragraph), and that row belongs to the renderer, not to the epilogue.
   */
  if (opts.explain !== undefined && opts.explain !== null) {
    for (const fix of opts.explain.fix) {
      const line = terminalSafeLine(redact(fix));
      if (line.length > 0) lines.push(`  ${line}`);
    }
  }
  if (opts.debug === true && typeof opts.stack === 'string' && opts.stack.length > 0) {
    for (const raw of opts.stack.split(/\r?\n/)) {
      const line = terminalSafeLine(redact(raw));
      if (line.length > 0) lines.push(`  ${line}`);
    }
  }
  return lines;
}

export interface FatalDeps {
  /** `fs.writeSync(fd, text)` stand-in; 2 = stderr (the epilogue), 1 = stdout (used by `restore`) */
  write: (fd: 1 | 2, text: string) => void;
  /** `process.exit`; may return (tests) — fatalExit does nothing after calling it */
  exit: (code: number) => void;
  /** `restoreTerminal()`: RESTORE + `setRawMode(false)`, idempotent; called synchronously before any print */
  restore: () => void;
  /** `config.redact` when a config exists, `patternRedact` otherwise */
  redact: (s: string) => string;
  /** the epilogue context at the time of the fault (run id, dir, resumable) */
  context: () => EpilogueContext;
  /**
   * TUI-DESIGN-4 §7.4: the directories an errno can name, read when the fault happens. Without them only a
   * `mkdir` of a path ending in `/runs` and the live `context().runDir` can be placed, and everything else keeps
   * the unclassified path (exit 1) rather than being mislabelled.
   */
  places?: () => FsErrorPlaces;
  /** TUI-DESIGN-4 §7.4 edge 2: the `~` abbreviation of the path in the sentence; default: `shortPath` against `context().home` */
  shorten?: (p: string) => string;
  /** the live engine, if any */
  engine?: () => Pick<Engine, 'abort'> | null;
  /** `renderer.unmount()` when a renderer is mounted; Ink's `Instance.unmount()` returns void, App's wrapper a promise — both are accepted */
  unmount?: () => void | Promise<void>;
  /** `(code) => { process.exitCode = code }` */
  setExitCode?: (code: number) => void;
  /** `process.env` for `JEVCODE_DEBUG` */
  env?: Readonly<Record<string, string | undefined>>;
  unmountTimeoutMs?: number;
  /** injectable timer for the unmount race */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface FatalExit {
  (e: unknown): Promise<void>;
  /** true once the first fault has been taken */
  fired(): boolean;
}

/**
 * `unmount()` raced with the timeout. The result is normalised through `Promise.resolve().then(...)`, so a
 * synchronous throw, a void return (Ink's `Instance.unmount()`), a non-thenable and a rejection all settle the
 * race the same way; the returned promise never rejects.
 */
function raceUnmount(deps: FatalDeps): Promise<void> {
  const unmount = deps.unmount;
  if (!unmount) return Promise.resolve();
  const ms = deps.unmountTimeoutMs ?? FATAL_UNMOUNT_TIMEOUT_MS;
  const setT = deps.setTimeout ?? ((fn: () => void, t: number) => setTimeout(fn, t));
  const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  return new Promise<void>((resolve) => {
    let done = false;
    let handle: unknown = null;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (handle !== null) {
        try {
          clearT(handle);
        } catch {
          /* an injected timer that cannot be cleared still resolves the race */
        }
      }
      resolve();
    };
    try {
      handle = setT(finish, ms);
    } catch {
      /* no timer: the unmount result alone settles the race */
    }
    if (done) handle = null;
    Promise.resolve()
      .then(() => unmount())
      .then(finish, finish);
  });
}

/**
 * TUI-DESIGN §13.4: build the one fatal path. The returned function is idempotent: a second fault while the
 * first is in flight is ignored (the first already owns the exit), and every step is guarded so a failing
 * dependency never prevents the exit.
 */
export function createFatalExit(deps: FatalDeps): FatalExit {
  let fired = false;
  let pending: Promise<void> | null = null;

  const run = async (e: unknown): Promise<void> => {
    /**
     * TUI-DESIGN-4 §7.4: "every launch-time failure routes through `fatalExit` so it gets the terminal restore,
     * **stderr**, the epilogue and a correct code (**2** for a configuration/permission problem, not 1)". A read-only
     * `$HOME` used to print `[ui] error: EACCES: permission denied, mkdir '<home>/runs'` on **stdout**, with an empty
     * stderr, no epilogue and exit 1. Anything already typed (a CheckpointError's 3) keeps its own code.
     */
    let epilogueCtx: EpilogueContext = { runId: null, runDir: null, resumable: false };
    try {
      epilogueCtx = deps.context();
    } catch {
      /* a broken context must not stop the exit; the epilogue below re-reads it under its own guard */
    }
    // §7.4 edge 2: `~` for the home prefix, through the ONE shortener (§3.4). `width: 0` disables the left
    // elision — an epilogue row may wrap, but a run id is never cut.
    const home = epilogueCtx.home;
    const shorten = deps.shorten ?? ((pth: string): string => shortPath(pth, { root: '', width: 0, ...(typeof home === 'string' && home !== '' ? { home } : {}) }));
    const places: FsErrorPlaces = { ...(deps.places?.() ?? {}) };
    if (places.runDir === undefined && epilogueCtx.runDir !== null) places.runDir = epilogueCtx.runDir;
    const fsCtx = fsErrorContext(e, deps.redact, places, shorten);
    const explain = fsCtx === null ? null : explainFsError(e, fsCtx);
    const base = serializeError((fsCtx === null ? null : fsErrorToJevCodeError(e, fsCtx)) ?? e, deps.redact);
    /**
     * TUI-DESIGN-4 §7.4 row 2: a full disk **inside a live run directory** means this run cannot be checkpointed
     * or its bundle finished — exit 3, the row `jevcode report` (§7.7's edge) and `checkpoint:degraded` both want.
     * The same errno while the LAUNCH creates the runs directory stays a configuration problem the user fixes
     * with `--runs-dir` (exit 2), so the split keys on `fsCtx.op`, not on the code alone.
     *
     * The design puts this in `explainFsError` (`src/errors.ts`); that file is the harness session's under the
     * 2026-09-22 ownership rule, so the hunk is OWED TO THE HARNESS SESSION (docs/STATUS.md 'Round 4') and the
     * split is made at this call site meanwhile. It is a no-op here once the hunk lands.
     */
    const runDirDiskFull = fsCtx?.op === 'run-dir' && DISK_FULL_CODES.has(errnoCode(e) ?? '');
    const err: SerializedError = runDirDiskFull ? { ...base, exitCode: EXIT_CODES.checkpoint } : base;
    // (1) the exit code first, so an 'exit' fired by anything below already carries it
    try {
      deps.setExitCode?.(err.exitCode);
    } catch {
      /* the guard below still exits with err.exitCode */
    }
    // (2) synchronous terminal restore before a single byte is printed
    try {
      deps.restore();
    } catch {
      /* a broken terminal must not stop the epilogue */
    }
    // (3) checkpoint through the engine, then unmount (bounded)
    try {
      deps.engine?.()?.abort('error', { error: err });
    } catch {
      /* the engine is already gone */
    }
    try {
      await raceUnmount(deps);
    } catch {
      /* raceUnmount never rejects; the guard keeps step (4) reachable whatever a dependency does */
    }
    // (4) the epilogue, redacted, then exit
    const stack = e instanceof Error && typeof e.stack === 'string' ? e.stack : null;
    const debug = (deps.env ?? {})['JEVCODE_DEBUG'] === '1';
    try {
      deps.write(2, `${fatalLines(err, deps.context(), deps.redact, { stack, debug, explain }).join('\n')}\n`);
    } catch {
      /* EPIPE on stderr: nothing left to say */
    }
    deps.exit(err.exitCode);
  };

  const fatalExit = ((e: unknown): Promise<void> => {
    if (fired && pending) return pending;
    fired = true;
    pending = run(e);
    return pending;
  }) as FatalExit;
  fatalExit.fired = () => fired;
  return fatalExit;
}

/** The process surface installFatalHandlers needs (injectable for tests). */
export interface FatalProcess {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown;
  off(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown;
}

/** A stdio stream's error surface: EIO / EPIPE listeners are installed before any SIGHUP logic (TUI-DESIGN §13.4). */
export interface FatalStream {
  on(event: 'error', listener: (e: unknown) => void): unknown;
  off(event: 'error', listener: (e: unknown) => void): unknown;
}

/** TUI-DESIGN §13.4: the SIGHUP source (`process`). */
export interface FatalSignalSource {
  on(event: 'SIGHUP', listener: () => void): unknown;
  off(event: 'SIGHUP', listener: () => void): unknown;
}

/** TUI-DESIGN §13.4: the stdin `'end'` source. */
export interface FatalEndSource {
  on(event: 'end', listener: () => void): unknown;
  off(event: 'end', listener: () => void): unknown;
}

export interface FatalHandlerDeps extends FatalDeps {
  /** stdin / stdout / stderr: EIO or EPIPE → checkpoint through abort('signal', { signal: 'SIGHUP' }), exit 129, no terminal writes */
  streams?: readonly FatalStream[];
  /** SIGHUP → the same hang-up path (installed after the stream listeners) */
  signals?: FatalSignalSource;
  /** stdin `'end'` → the hang-up path only while `hangupGate()` holds */
  stdinEnd?: FatalEndSource;
  /**
   * TUI-DESIGN §13.4: `stdin.isTTY && stdin.isRaw` (Ink mounted), read when the event fires. On a pipe stdin `'end'`
   * is the normal completion of `readTask()` and means nothing; default: never.
   */
  hangupGate?: () => boolean;
}

function errnoCode(e: unknown): string | null {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** Walk a bounded `cause` chain for a string member (a CheckpointError wraps the errno error). */
function chainString(e: unknown, key: 'code' | 'path' | 'syscall'): string | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 8 && typeof cur === 'object' && cur !== null; depth++) {
    const v = (cur as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) return v;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** `<dir>` or anything under it (never a sibling: `/a/runs2` is not inside `/a/runs`). */
function inside(path: string, dir: string | null | undefined): boolean {
  if (typeof dir !== 'string' || dir.length === 0) return false;
  const base = dir.length > 1 && dir.endsWith('/') ? dir.slice(0, -1) : dir;
  return path === base || path.startsWith(`${base}/`);
}

/** The places a launch- or run-time errno can come from, as the caller knows them. */
export interface FsErrorPlaces {
  /** `<JEVCODE_HOME>/runs` or `--runs-dir` (the directory the launch creates) */
  runsDir?: string | null;
  /** the live run's own directory (`<runsDir>/<id>`) */
  runDir?: string | null;
  /** the resolved config file */
  configPath?: string | null;
}

/**
 * TUI-DESIGN-4 §7.4: **which** of the four rows an errno belongs to. Round 4's first pass labelled every error
 * carrying a string `path` as `op: 'runs-dir'`, which broke three rows at once: a config-file EACCES printed
 * `cannot create the runs directory <config path>`, a mid-run ENOENT could never reach row 3 (`'runs-dir'` +
 * ENOENT falls through `explainFsError`'s switch), and an unrelated workspace-file errno was relabelled a
 * runs-dir failure with its exit code flipped from 1 to 2.
 *
 * `null` means "not one of the four rows" — the caller then keeps the unclassified path (exit 1), which is the
 * whole point: only an error we can *name* gets a sentence and a code.
 */
export function fsErrorOp(path: string, places: FsErrorPlaces, syscall: string | null = null): FsOp | null {
  if (inside(path, places.configPath) && path === (places.configPath ?? '')) return 'config';
  if (inside(path, places.runDir)) return 'run-dir';
  if (inside(path, places.runsDir)) return 'runs-dir';
  // the launch has no resolved runs dir yet when the mkdir of it is what failed
  if (syscall === 'mkdir' && /(?:^|\/)runs$/.test(path)) return 'runs-dir';
  return null;
}

/**
 * TUI-DESIGN-4 §7.4: the §7.4 rows are about the **file system**. A stream `'error'` (an ENOSPC on stdout, §13.4)
 * carries no `path` and keeps today's path: it is a broken terminal, not a misconfigured runs directory, and
 * re-labelling it would make the epilogue lie. `EMFILE`/`ENFILE` (row 5) name no path at all and are classified
 * on the code alone.
 */
function fsErrorContext(e: unknown, redact: (s: string) => string, places: FsErrorPlaces, shorten?: (p: string) => string): FsErrorContext | null {
  const code = chainString(e, 'code');
  const withShorten = shorten === undefined ? {} : { shorten };
  if (code === 'EMFILE' || code === 'ENFILE') return { op: 'other', redact, ...withShorten };
  const path = chainString(e, 'path');
  if (path === null) return null;
  const op = fsErrorOp(path, places, chainString(e, 'syscall'));
  if (op === null) return null;
  return { op, redact, path, ...withShorten };
}

/** The stream errors that mean "the terminal is gone" rather than "a bug" (TUI-DESIGN §13.4). */
export function isHangupError(e: unknown): boolean {
  const code = errnoCode(e);
  return code === 'EIO' || code === 'EPIPE';
}

/**
 * TUI-DESIGN §13.4: route `uncaughtException` / `unhandledRejection` to the one fatal path, stdio EIO/EPIPE to the
 * hang-up exit (129, checkpoint, no terminal writes, no epilogue), SIGHUP to the same, and stdin `'end'` to it
 * while the hang-up gate holds. Listener order is the design's: stream `'error'` first, then the process faults,
 * then SIGHUP and `'end'`. Returns the uninstaller. Handlers go on the injected process/streams, so this is
 * unit-testable without touching the real process; `fatalExit` may be shared with the caller (`wireFatalHandlers`).
 */
export function installFatalHandlers(deps: FatalHandlerDeps, proc: FatalProcess = process, fatalExit: FatalExit = createFatalExit(deps)): () => void {
  const onFatal = (e: unknown): void => {
    void fatalExit(e);
  };
  let hungUp = false;
  /**
   * `why: 'stream'` is a stdout/stderr/stdin EIO or EPIPE — §2.8 P-R11's line is about a CLOSED PIPE, so only that
   * path says it. A SIGHUP or a stdin `'end'` keeps the historical silence: the terminal is gone, and
   * `jevcode: stdout closed` would be the wrong sentence for it.
   */
  const hangup = (why: 'stream' | 'signal' = 'signal'): void => {
    if (hungUp || fatalExit.fired()) return;
    hungUp = true;
    const signal: SignalName = 'SIGHUP';
    try {
      deps.setExitCode?.(HANGUP_EXIT_CODE);
    } catch {
      /* the exit below still carries 129 */
    }
    try {
      deps.engine?.()?.abort('signal', { signal });
    } catch {
      /* nothing else to do on a dead terminal */
    }
    // §2.8 P-R11: one line to stderr before the exit, guarded — stderr may be closed too (and often is)
    if (why === 'stream') try {
      const ctx = deps.context();
      const home = ctx.home;
      const shorten = deps.shorten ?? ((pth: string): string => shortPath(pth, { root: '', width: 0, ...(typeof home === 'string' && home !== '' ? { home } : {}) }));
      const line = hangupStderrLine(ctx.runDir, deps.places?.().runsDir ?? null, shorten);
      if (line !== null) deps.write(2, `${deps.redact(line)}\n`);
    } catch {
      /* the other end is gone as well: 129 with an empty stderr is the historical behaviour */
    }
    deps.exit(HANGUP_EXIT_CODE);
  };
  const onStreamError = (e: unknown): void => {
    if (!isHangupError(e)) {
      onFatal(e);
      return;
    }
    hangup('stream');
  };
  const onSighup = (): void => hangup('signal');
  const onStdinEnd = (): void => {
    let gate = false;
    try {
      gate = deps.hangupGate?.() === true;
    } catch {
      gate = false;
    }
    if (gate) hangup('signal');
  };
  // (a) EIO/EPIPE before any SIGHUP logic
  const streams = deps.streams ?? [];
  for (const s of streams) s.on('error', onStreamError);
  // (b) the process faults
  proc.on('uncaughtException', onFatal);
  proc.on('unhandledRejection', onFatal);
  // (c) hang-up signals
  deps.signals?.on('SIGHUP', onSighup);
  deps.stdinEnd?.on('end', onStdinEnd);
  return () => {
    for (const s of streams) s.off('error', onStreamError);
    proc.off('uncaughtException', onFatal);
    proc.off('unhandledRejection', onFatal);
    deps.signals?.off('SIGHUP', onSighup);
    deps.stdinEnd?.off('end', onStdinEnd);
  };
}

// ---------------------------------------------------------------------------------------
// Wave 2: process wiring (TUI-DESIGN §13.4, §14.2)
// ---------------------------------------------------------------------------------------

/** `process.stdin` as the wiring sees it: raw-mode facts, `setRawMode`, the `'end'` and `'error'` events (overloads, so it satisfies FatalStream and FatalEndSource). */
export interface FatalStdin {
  /** `undefined` on a pipe at runtime, whatever `tty.ReadStream` declares */
  isTTY?: boolean | undefined;
  isRaw?: boolean | undefined;
  setRawMode?: ((mode: boolean) => unknown) | undefined;
  on(event: 'error', listener: (e: unknown) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  off(event: 'error', listener: (e: unknown) => void): unknown;
  off(event: 'end', listener: () => void): unknown;
}

/** `process.stdout` / `process.stderr` as the wiring sees them. */
export interface FatalStdout extends FatalStream {
  isTTY?: boolean | undefined;
}

/** The subset of `process` the wiring uses (`process` itself satisfies it; tests inject a fake). */
export interface FatalProcessLike {
  stdin: FatalStdin;
  stdout: FatalStdout;
  stderr: FatalStream;
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown;
  on(event: 'SIGHUP', listener: () => void): unknown;
  off(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown;
  off(event: 'SIGHUP', listener: () => void): unknown;
  exit(code?: number): void;
  exitCode?: number | string | null | undefined;
  env: Readonly<Record<string, string | undefined>>;
}

/** `fs.writeSync(fd, text)` as the wiring needs it. */
export type SyncWriter = (fd: 1 | 2, text: string) => unknown;

/**
 * TUI-DESIGN §13.4 step 2 / §14.2: the fatal path's own synchronous, idempotent terminal restore — `RESTORE` through
 * `fs.writeSync(1, …)` when stdout is a terminal (written once, whatever the number of calls), then
 * `stdin.setRawMode(false)` whenever stdin is observed raw — the restore is offered for reuse (`process.on('exit')`,
 * `EngineOptions.exit`), so a call after an earlier one that saw raw mode re-entered must still leave the shell
 * cooked. Every call is guarded (an EIO here must not stop the epilogue). O9's `restoreTerminal()` replaces it once
 * Ink is mounted.
 */
export function createRestoreTerminal(io: { stdin: Pick<FatalStdin, 'isRaw' | 'setRawMode'>; stdout: Pick<FatalStdout, 'isTTY'> }, writeSync: SyncWriter = fsWriteSync): () => void {
  let restoreWritten = false;
  return () => {
    if (!restoreWritten && io.stdout.isTTY === true) {
      restoreWritten = true;
      try {
        // §1.3.1: leave the alternate screen BEFORE the restore, and only when a mount entered it — a crash or a
        // SIGHUP must never strand the user looking at a blank alternate buffer
        writeSync(1, `${altScreenEntered ? ALT_SCREEN_LEAVE : ''}${RESTORE}`);
      } catch {
        /* the terminal is gone */
      }
    }
    if (io.stdin.isRaw === true) {
      try {
        io.stdin.setRawMode?.(false);
      } catch {
        /* not a tty any more */
      }
    }
  };
}

export interface FatalWiringDeps {
  redact: (s: string) => string;
  context: () => EpilogueContext;
  engine?: () => Pick<Engine, 'abort'> | null;
  unmount?: () => void | Promise<void>;
  unmountTimeoutMs?: number;
  /** TUI-DESIGN-4 §7.4: the runs dir / run dir / config path an errno can name */
  places?: () => FsErrorPlaces;
  /** TUI-DESIGN-4 §7.4 edge 2: override the `~` abbreviation */
  shorten?: (p: string) => string;
  /** default: `process` */
  proc?: FatalProcessLike;
  /** default: `fs.writeSync` */
  writeSync?: SyncWriter;
  /** O9's `restoreTerminal()` when mounted; default: `createRestoreTerminal(proc.stdin/stdout, writeSync)` */
  restore?: () => void;
  /** default: `proc.env` */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface FatalWiring {
  /** the one fatal path (`main().catch(fatalExit)`, the render fault escalation) */
  fatalExit: FatalExit;
  /** the synchronous restore the wiring uses (for `process.on('exit')` hooks and `EngineOptions.exit`) */
  restore: () => void;
  /** the hang-up path as the wiring sees it: `stdin.isTTY && stdin.isRaw` right now */
  hangupGate: () => boolean;
  uninstall: () => void;
}

/**
 * TUI-DESIGN §13.4: the process wiring on top of `installFatalHandlers` — real `fs.writeSync(1, RESTORE)` and
 * `stdin.setRawMode(false)` when raw, `engine.abort('error', { error })`, unmount raced with the 2 s bound, the
 * epilogue via `fs.writeSync(2, …)`, `process.exit`; stdio `'error'` listeners for EIO/EPIPE before any SIGHUP
 * logic; SIGHUP and stdin `'end'` (gated on `stdin.isTTY && stdin.isRaw`) → `abort('signal', { signal: 'SIGHUP' })`,
 * exit 129. Everything is injectable; the defaults are the real process.
 */
export function wireFatalHandlers(d: FatalWiringDeps): FatalWiring {
  const proc: FatalProcessLike = d.proc ?? process;
  const writeSync: SyncWriter = d.writeSync ?? fsWriteSync;
  const restore = d.restore ?? createRestoreTerminal({ stdin: proc.stdin, stdout: proc.stdout }, writeSync);
  const hangupGate = (): boolean => proc.stdin.isTTY === true && proc.stdin.isRaw === true;
  const deps: FatalHandlerDeps = {
    write: (fd, text) => {
      writeSync(fd, text);
    },
    exit: (code) => {
      proc.exit(code);
    },
    restore,
    redact: d.redact,
    context: d.context,
    setExitCode: (code) => {
      proc.exitCode = code;
    },
    env: d.env ?? proc.env,
    streams: [proc.stdin, proc.stdout, proc.stderr],
    signals: proc,
    stdinEnd: proc.stdin,
    hangupGate,
    ...(d.engine ? { engine: d.engine } : {}),
    ...(d.unmount ? { unmount: d.unmount } : {}),
    ...(d.unmountTimeoutMs !== undefined ? { unmountTimeoutMs: d.unmountTimeoutMs } : {}),
    ...(d.places ? { places: d.places } : {}),
    ...(d.shorten ? { shorten: d.shorten } : {}),
  };
  const fatalExit = createFatalExit(deps);
  const uninstall = installFatalHandlers(deps, proc, fatalExit);
  return { fatalExit, restore, hangupGate, uninstall };
}
