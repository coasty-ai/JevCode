/**
 * `fatalExit` (TUI-DESIGN §13.4, A161, A162; DESIGN §11's single redacting `fatal()`).
 *
 * Order, fixed by the design: (1) `process.exitCode = err.exitCode` behind an idempotent guard; (2) synchronous
 * terminal restore before anything is printed (`RESTORE`, raw mode off; never `ESC c` / `ESC[2J`); (3)
 * `engine.abort('error', { error })` so the `'exit'` handler writes `state.json`, then `renderer.unmount()` raced
 * with the unmount timeout; (4) the redacted epilogue on stderr, then `process.exit(code)`.
 *
 * Wave 1 ships the pure part (`fatalLines`, `RESTORE`) and a fully injectable `createFatalExit(deps)` /
 * `installFatalHandlers(deps)`; cli/session.ts (wave 3) supplies the real `write` / `exit` / `restore`.
 */
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

export interface FatalHandlerDeps extends FatalDeps {
  /** stdin / stdout / stderr: EIO or EPIPE → checkpoint through abort('signal', { signal: 'SIGHUP' }), exit 129, no terminal writes */
  streams?: readonly FatalStream[];
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
 * TUI-DESIGN §13.4: route `uncaughtException` / `unhandledRejection` to the one fatal path and stdio EIO/EPIPE to
 * the hang-up exit (129, checkpoint, no terminal writes, no epilogue). Returns the uninstaller. Handlers are
 * installed on the injected process/streams, so this is unit-testable without touching the real process.
 */
export function installFatalHandlers(deps: FatalHandlerDeps, proc: FatalProcess = process): () => void {
  const fatalExit = createFatalExit(deps);
  const onFatal = (e: unknown): void => {
    void fatalExit(e);
  };
  let hungUp = false;
  const onStreamError = (e: unknown): void => {
    if (!isHangupError(e)) {
      onFatal(e);
      return;
    }
    if (hungUp || fatalExit.fired()) return;
    hungUp = true;
    const signal: SignalName = 'SIGHUP';
    try {
      deps.setExitCode?.(HANGUP_EXIT_CODE);
      deps.engine?.()?.abort('signal', { signal });
    } catch {
      /* nothing else to do on a dead terminal */
    }
    deps.exit(HANGUP_EXIT_CODE);
  };
  const streams = deps.streams ?? [];
  for (const s of streams) s.on('error', onStreamError);
  proc.on('uncaughtException', onFatal);
  proc.on('unhandledRejection', onFatal);
  return () => {
    for (const s of streams) s.off('error', onStreamError);
    proc.off('uncaughtException', onFatal);
    proc.off('unhandledRejection', onFatal);
  };
}
