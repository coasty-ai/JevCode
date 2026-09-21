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
import { type EpilogueContext, epilogueLines, terminalSafeLine } from './epilogue.js';

/**
 * TUI-DESIGN §14.2: bracketed paste off, synchronized output off, cursor shape reset (DECSCUSR 0), cursor shown,
 * attributes reset. Never `ESC c`, `ESC[2J` or `ESC[3J` (scrollback is the user's).
 */
export const RESTORE = '\x1b[?2004l\x1b[?2026l\x1b[0 q\x1b[?25h\x1b[0m';

/** Bound on `renderer.unmount()` inside fatalExit (mirrors UNMOUNT_TIMEOUT_MS in tui/App.tsx without importing Ink here). */
export const FATAL_UNMOUNT_TIMEOUT_MS = 2000;

/** The exit code of a stdout/stderr EIO/EPIPE or a hang-up (TUI-DESIGN §13.5: SIGHUP / EIO → 129). */
export const HANGUP_EXIT_CODE = 129;

/**
 * TUI-DESIGN §13.4 step 4: the epilogue plus, under `JEVCODE_DEBUG=1`, the stack — every line through `redact`,
 * control characters dropped. Pure.
 */
export function fatalLines(err: SerializedError, ctx: EpilogueContext, redact: (s: string) => string, opts: { stack?: string | null; debug?: boolean } = {}): string[] {
  const lines = epilogueLines(err, ctx, redact);
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
    const err = serializeError(e, deps.redact);
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
      deps.write(2, `${fatalLines(err, deps.context(), deps.redact, { stack, debug }).join('\n')}\n`);
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
  const hangup = (): void => {
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
    deps.exit(HANGUP_EXIT_CODE);
  };
  const onStreamError = (e: unknown): void => {
    if (!isHangupError(e)) {
      onFatal(e);
      return;
    }
    hangup();
  };
  const onSighup = (): void => hangup();
  const onStdinEnd = (): void => {
    let gate = false;
    try {
      gate = deps.hangupGate?.() === true;
    } catch {
      gate = false;
    }
    if (gate) hangup();
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
        writeSync(1, RESTORE);
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
  };
  const fatalExit = createFatalExit(deps);
  const uninstall = installFatalHandlers(deps, proc, fatalExit);
  return { fatalExit, restore, hangupGate, uninstall };
}
