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
import { ALT_SCREEN_LEAVE, RESTORE, alternateScreenEntered, markAlternateScreen } from '../cli/fatal.js';

export { RESTORE, ALT_SCREEN_LEAVE, markAlternateScreen, alternateScreenEntered };

/** TUI-DESIGN §4.3 / §14.1: DECSCUSR steady bar, written once at mount (`CSI 6 SP q`); `RESTORE` resets it (`CSI 0 SP q`). */
export const DECSCUSR_BAR = '\x1b[6 q';

/**
 * §1.3.1's alternate-screen bytes and the module-level flag live in `src/cli/fatal.ts` beside `RESTORE` (which this
 * module already imports) and are re-exported above, so `fatalExit`'s own restore sees the same flag without
 * closing a `cli/fatal ⇄ tui/terminal` import cycle. The import sites §1.3.1 names are unchanged.
 */
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
        // TUI-DESIGN-4 §1.3.1: leave the alternate screen FIRST, and only when it was entered — without it a crash
        // or a SIGHUP strands the user on a blank alternate buffer with their shell invisible behind it. The flag is
        // set by `createTuiRenderer` when it mounts the `fullscreen` renderer, exactly as §1.3.1 specifies (the
        // design puts the same bytes on `fatal.ts`'s `RESTORE`, which is S6's file; this is the same guarantee on
        // the process-wide restore every exit path already shares — §14.2 "written once").
        writeSync(1, `${alternateScreenEntered() ? ALT_SCREEN_LEAVE : ''}${RESTORE}`);
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
// Resize debounce (§14.1 "Sizes") — RETIRED by TUI-DESIGN-4 §2.2 P-R2
//
// `createResizeDebounce` / `RESIZE_DEBOUNCE_MS` / `Debounced` are gone with their one consumer, `App.tsx`'s
// `wrapColumns`. The debounce kept the draft one width behind the box edges for up to 50 ms (≈ 130 ms at
// `--fps 15`): A2 measured 4 of 24 frames carrying a box row whose right border is the truncation ellipsis.
// The removal is a PUBLIC API change (`src/tui/index.ts:74`) and is recorded in CHANGELOG.md (S6, §9.2).
// ---------------------------------------------------------------------------------------

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
// /scrollback and the on-exit dump (TUI-DESIGN-4 §1.3.4)
// ---------------------------------------------------------------------------------------

/** §1.3.4: the row printed under the dump while `/scrollback` waits, so the user knows the session is still there. */
export const SCROLLBACK_RESUME_ROW = '-- end of transcript · press any key to return to jevcode --';

export interface PrimaryScreenDumpDeps {
  /** already-rendered chunks (`transcriptDumpChunks`) — the one formatter, so this is a `--plain` run's bytes */
  chunks: readonly string[];
  /** `useApp().suspendTerminal` without a callback: Ink pauses input and restores the terminal it found */
  suspendTerminal: () => Promise<TerminalSuspension>;
  /** the raw stdout write (never the guarded proxy's clear path — the dump is plain text) */
  write: (s: string) => void;
  /** `/scrollback` waits for a key here; the on-exit dump passes nothing and returns as soon as the bytes are out */
  waitForKey?: () => Promise<void>;
  /** the `<Static>` suspension queue, so items produced during the dump are delivered after the resume (§4.8) */
  onQueue?: { suspend(): void; resume(): void };
  /** force one repaint after the resume (`useStdout().write('')`) */
  repaint?: () => void;
}

/**
 * TUI-DESIGN-4 §1.3.4: hand the terminal back (which leaves the alternate screen, `ink.js:894–900`), write the
 * whole transcript to the PRIMARY screen so native copy and find work, optionally wait for a key, then resume.
 *
 * The suspension is resumed in a `finally`, so a write that throws (EPIPE on a closed pager, a terminal that went
 * away) can never strand the session outside Ink; the queue is resumed in the same place, so items an engine
 * produced during the dump are delivered in order rather than dropped (§4.8). An empty chunk list is a no-op —
 * §1.3.4 skips the dump for an empty transcript, and suspending for nothing would flash the screen.
 */
export async function printToPrimaryScreen(d: PrimaryScreenDumpDeps): Promise<void> {
  if (d.chunks.length === 0) return;
  d.onQueue?.suspend();
  const s = await d.suspendTerminal();
  try {
    for (const chunk of d.chunks) d.write(chunk);
    if (d.waitForKey) {
      d.write(`${SCROLLBACK_RESUME_ROW}\n`);
      await d.waitForKey();
    }
  } finally {
    await s.resume();
    d.onQueue?.resume();
    d.repaint?.();
  }
}

/**
 * §1.3.4: one keypress on the primary screen while Ink is suspended. Ink restored the termios it found, so raw
 * mode is entered for the read and left exactly as it was found. A stdin that is not a TTY (or cannot go raw)
 * resolves at once rather than hanging the session — the dump is already on screen either way.
 */
export function waitForAnyKey(stdin: TerminalStdin & { once?(event: 'readable' | 'data', fn: () => void): unknown; off?(event: 'data', fn: () => void): unknown; resume?(): unknown; pause?(): unknown }): Promise<void> {
  if (stdin.isTTY !== true || typeof stdin.once !== 'function') return Promise.resolve();
  const wasRaw = stdin.isRaw === true;
  try {
    if (!wasRaw) stdin.setRawMode?.(true);
  } catch {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      try {
        if (!wasRaw) stdin.setRawMode?.(false);
      } catch {
        /* the terminal went away: Ink's resume re-applies its own state */
      }
      resolve();
    };
    try {
      stdin.resume?.();
      stdin.once?.('data', finish);
    } catch {
      finish();
    }
  });
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
