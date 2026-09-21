/**
 * Terminal hygiene (TUI-DESIGN §14.2, §13.4, §14.1 "Sizes", A80, A81, A23, D13): the exit string `RESTORE`
 * (bracketed paste off, synchronized output off, DECSCUSR reset, cursor shown, attributes reset — never
 * `ESC c` / `ESC[2J` / `ESC[3J`) written once by an idempotent `restoreTerminal()`; the DECSCUSR steady bar at
 * mount; `installTerminalHygiene()` = `process.on('exit', restore)` + SIGTSTP + raw-mode-off; Ctrl+Z through
 * `suspendTerminal()` → self-sent SIGSTOP → SIGCONT re-raw + repaint (with the 100 ms fallback for an orphaned
 * session leader); SIGHUP gating (`stdin.isTTY && stdin.isRaw`); the 50 ms trailing resize debounce; and the
 * suspension queue that buffers `<Static>` items while `suspendTerminal` is active and flushes after resume
 * (08 §5: items appended during a suspension are dropped by Ink). Everything with I/O is injectable.
 */
import { writeSync as fsWriteSync } from 'node:fs';
import type { TerminalSuspension } from 'ink';
import { RESTORE } from '../cli/fatal.js';

export { RESTORE };

/** TUI-DESIGN §4.3 / §14.1: DECSCUSR steady bar, written once at mount (`CSI 6 SP q`); `RESTORE` resets it (`CSI 0 SP q`). */
export const DECSCUSR_BAR = '\x1b[6 q';
/** TUI-DESIGN §14.1: the composer re-wrap debounce on resize (Ink coalesces frames itself). */
export const RESIZE_DEBOUNCE_MS = 50;
/** TUI-DESIGN §14.2: a self-sent SIGTSTP/SIGSTOP that did not stop the process is detected after this long. */
export const SUSPEND_FALLBACK_MS = 100;
/** The suspension queue never grows past this many items (a runaway engine during a long editor session). */
export const SUSPENSION_QUEUE_MAX = 10_000;

export interface TerminalStdout {
  isTTY?: boolean | undefined;
  write(s: string): unknown;
}
export interface TerminalStdin {
  isTTY?: boolean | undefined;
  isRaw?: boolean | undefined;
  setRawMode?: ((mode: boolean) => unknown) | undefined;
  once?(event: 'readable' | 'data', fn: () => void): unknown;
}
export type SyncWriter = (fd: 1 | 2, text: string) => unknown;

export interface TerminalIo {
  stdout: TerminalStdout;
  stdin: TerminalStdin;
  /** default `fs.writeSync` (the exit hook must not go through the event loop) */
  writeSync?: SyncWriter;
}

export interface RestoreTerminal {
  (): void;
  /** true once the exit string was written */
  readonly written: boolean;
  /** a later mount re-arms the string (a second `render()` in the same process, tests) */
  rearm(): void;
}

/**
 * TUI-DESIGN §14.2: the idempotent restore — `RESTORE` once through `writeSync(1, …)` when stdout is a TTY (a
 * `\r\n` is not appended: Ink leaves the cursor at column 0 after unmount, and the fatal path writes its own
 * epilogue lines), then `stdin.setRawMode(false)` whenever stdin is still raw. Every call is guarded.
 */
export function createRestoreTerminal(io: TerminalIo): RestoreTerminal {
  const writeSync = io.writeSync ?? fsWriteSync;
  let written = false;
  const restore = (): void => {
    if (!written && io.stdout.isTTY === true) {
      written = true;
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
  return Object.defineProperties(restore, {
    written: { get: () => written },
    rearm: {
      value: () => {
        written = false;
      },
    },
  }) as RestoreTerminal;
}

let processRestore: RestoreTerminal | null = null;

/**
 * The one process-wide restore instance (TUI-DESIGN §14.2 "written once by an idempotent restoreTerminal()"): the
 * mount's hygiene, `unmount()`, the SIGTSTP path and the `'exit'` hook all share it, so `RESTORE` is written once
 * however many of them run. `cli/fatal.ts` / `cli/session.ts` should consume this same function (`wireFatalHandlers({
 * restore: restoreTerminal })`) rather than their own `createRestoreTerminal`, or the string is written twice at exit.
 */
export function processRestoreTerminal(): RestoreTerminal {
  processRestore ??= createRestoreTerminal({ stdout: process.stdout, stdin: process.stdin });
  return processRestore;
}

/** The process-wide `restoreTerminal()` (TUI-DESIGN §14.2): one string per process across `fatalExit`, `unmount()` and the `'exit'` hook. */
export function restoreTerminal(): void {
  processRestoreTerminal()();
}

/** Re-arm the process-wide exit string after a suspension consumed it (Ctrl+Z → fg; §14.2). */
export function rearmRestoreTerminal(): void {
  processRestoreTerminal().rearm();
}

/** Test seam: replace or reset the process-wide restore. */
export function setProcessRestore(r: RestoreTerminal | null): void {
  processRestore = r;
}

/** TUI-DESIGN §4.3: the DECSCUSR steady bar once at mount (a TTY only; never on a pipe). */
export function writeCursorShape(stdout: TerminalStdout): boolean {
  if (stdout.isTTY !== true) return false;
  try {
    stdout.write(DECSCUSR_BAR);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Resize debounce (§14.1 "Sizes")
// ---------------------------------------------------------------------------------------

export interface Debounced {
  trigger(): void;
  cancel(): void;
  readonly pending: boolean;
}

/** TUI-DESIGN §14.1: a trailing debounce — 30 SIGWINCH events → one call 50 ms after the last (§14.2 "SIGWINCH storms"). */
export function createResizeDebounce(fn: () => void, ms: number = RESIZE_DEBOUNCE_MS, timers: { setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (h: unknown) => void } = {}): Debounced {
  const set = timers.setTimeout ?? ((f, m) => setTimeout(f, m));
  const clear = timers.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  let handle: unknown = null;
  return {
    trigger() {
      if (handle !== null) clear(handle);
      handle = set(() => {
        handle = null;
        fn();
      }, ms);
    },
    cancel() {
      if (handle !== null) clear(handle);
      handle = null;
    },
    get pending() {
      return handle !== null;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Suspension queue (§4.8, §12.6, 08 §5)
// ---------------------------------------------------------------------------------------

export interface SuspensionQueue<T> {
  /** deliver now, or buffer while suspended */
  push(item: T): void;
  suspend(): void;
  /** deliver every buffered item in order, then deliver directly again */
  resume(): void;
  readonly suspended: boolean;
  readonly size: number;
}

/** TUI-DESIGN §4.8: items produced while `suspendTerminal` is active are queued and flushed after `resume()`, in order. */
export function createSuspensionQueue<T>(deliver: (item: T) => void, max: number = SUSPENSION_QUEUE_MAX): SuspensionQueue<T> {
  let suspended = false;
  let queue: T[] = [];
  return {
    push(item) {
      if (!suspended) {
        deliver(item);
        return;
      }
      queue.push(item);
      if (queue.length > max) queue.shift();
    },
    suspend() {
      suspended = true;
    },
    resume() {
      suspended = false;
      const pending = queue;
      queue = [];
      for (const item of pending) deliver(item);
    },
    get suspended() {
      return suspended;
    },
    get size() {
      return queue.length;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Ctrl+Z (§14.2)
// ---------------------------------------------------------------------------------------

export interface SuspendProcessDeps {
  /** `useApp().suspendTerminal` without a callback: Ink pauses input and restores its own state */
  suspendTerminal: () => Promise<TerminalSuspension>;
  /** `restoreTerminal()` — the exit string so the shell gets a cooked, visible cursor */
  restore: () => void;
  proc: { pid: number; kill: (pid: number, signal: NodeJS.Signals) => unknown; once: (event: 'SIGCONT', fn: () => void) => unknown; off: (event: 'SIGCONT', fn: () => void) => unknown };
  stdin: TerminalStdin;
  /** after resume: force one repaint (`useStdout().write('')`) */
  repaint: () => void;
  /** re-arm the exit string for the next exit (the restore above consumed it) */
  rearm?: () => void;
  onQueue?: { suspend(): void; resume(): void };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  fallbackMs?: number;
}

/**
 * TUI-DESIGN §14.2 Ctrl+Z: `suspendTerminal()` (Ink pauses raw mode and bracketed paste), the exit string, then a
 * self-sent SIGSTOP (uncatchable — the process really stops); on SIGCONT Ink resumes (raw + repaint), raw mode is
 * re-applied on the next stdin chunk (a job-control shell may restore cooked termios after CONT), and one repaint
 * is forced. A stop that did not happen (orphaned session leader) resumes after 100 ms. Resolves after resume.
 */
export async function suspendProcess(d: SuspendProcessDeps): Promise<void> {
  const set = d.setTimeout ?? ((f, m) => setTimeout(f, m));
  const clear = d.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  d.onQueue?.suspend();
  const s = await d.suspendTerminal();
  d.restore();
  await new Promise<void>((resolve) => {
    let done = false;
    let fallback: unknown = null;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (fallback !== null) clear(fallback);
      d.proc.off('SIGCONT', finish);
      resolve();
    };
    d.proc.once('SIGCONT', finish);
    fallback = set(finish, d.fallbackMs ?? SUSPEND_FALLBACK_MS);
    try {
      d.proc.kill(d.proc.pid, 'SIGSTOP');
    } catch {
      finish();
    }
  });
  d.rearm?.();
  await s.resume();
  // the job-control shell may have restored cooked termios after CONT: re-apply raw mode on the next chunk
  d.stdin.once?.('readable', () => {
    if (d.stdin.isRaw !== true) {
      try {
        d.stdin.setRawMode?.(true);
      } catch {
        /* not a tty */
      }
    }
  });
  d.onQueue?.resume();
  d.repaint();
}

// ---------------------------------------------------------------------------------------
// installTerminalHygiene (§13.4, §14.2)
// ---------------------------------------------------------------------------------------

export interface HygieneProcess {
  on(event: 'exit', fn: () => void): unknown;
  off(event: 'exit', fn: () => void): unknown;
  on(event: 'SIGTSTP' | 'SIGCONT', fn: () => void): unknown;
  off(event: 'SIGTSTP' | 'SIGCONT', fn: () => void): unknown;
}

export interface TerminalHygieneOptions {
  io: TerminalIo;
  proc?: HygieneProcess;
  /** the Ctrl+Z action (installed as the SIGTSTP listener so an external `kill -TSTP` restores the terminal too) */
  onSuspend?: () => void;
  restore?: RestoreTerminal;
}

export interface TerminalHygiene {
  restore: RestoreTerminal;
  /** `stdin.isTTY && stdin.isRaw` right now — the hang-up gate of §13.4 */
  hangupGate(): boolean;
  uninstall(): void;
}

/**
 * TUI-DESIGN §14.2: register `process.on('exit', restore)` (idempotent: `RESTORE` + `setRawMode(false)`), the
 * SIGTSTP listener (installing it removes the default stop action, which is why `suspendProcess` sends SIGSTOP
 * itself), and expose the SIGHUP gate. Returns the uninstaller (unmount / tests).
 */
export function installTerminalHygiene(o: TerminalHygieneOptions): TerminalHygiene {
  const proc: HygieneProcess = o.proc ?? process;
  const restore = o.restore ?? createRestoreTerminal(o.io);
  const onExit = (): void => restore();
  const onTstp = (): void => {
    if (o.onSuspend) o.onSuspend();
    else restore();
  };
  proc.on('exit', onExit);
  proc.on('SIGTSTP', onTstp);
  return {
    restore,
    hangupGate: () => o.io.stdin.isTTY === true && o.io.stdin.isRaw === true,
    uninstall() {
      proc.off('exit', onExit);
      proc.off('SIGTSTP', onTstp);
    },
  };
}
