/**
 * TUI-DESIGN §19.0 (`terminal.test.ts`, §14.2): the `RESTORE` bytes (2004 off, 2026 off, DECSCUSR reset, cursor
 * show, SGR reset; never `ESC c` / `ESC[2J`), `restoreTerminal` written once across fatalExit + unmount + exit yet
 * always cooking a raw stdin, the DECSCUSR bar only on a TTY, the 50 ms trailing resize debounce (30 events → one
 * call), the suspension queue flush order, `installTerminalHygiene` registering exit + SIGTSTP, and `suspendProcess`
 * (SIGSTOP self-sent, resume on SIGCONT, the 100 ms fallback, raw re-applied on the next chunk, one repaint).
 */
import { describe, expect, it } from 'vitest';
import { RESTORE as FATAL_RESTORE } from '../../../src/cli/fatal.js';
import { EventEmitter } from 'node:events';
import { DECSCUSR_BAR, RESTORE, createRestoreTerminal, createSuspensionQueue, installTerminalHygiene, processRestoreTerminal, rearmRestoreTerminal, restoreTerminal, setProcessRestore, suspendProcess, writeCursorShape, type HygieneProcess } from '../../../src/tui/terminal.js';

describe('RESTORE (§14.2)', () => {
  it('is the fatal path\'s string: 2004l 2026l DECSCUSR 0 cursor-show SGR0; no clears', () => {
    expect(RESTORE).toBe(FATAL_RESTORE);
    expect(RESTORE).toBe('\x1b[?2004l\x1b[?2026l\x1b[0 q\x1b[?25h\x1b[0m');
    expect(RESTORE).not.toMatch(/\x1b\[[0-9;]*[23]J|\x1bc|\x1b\[\?1049/);
    expect(DECSCUSR_BAR).toBe('\x1b[6 q');
  });

  it('restoreTerminal writes the string once across every caller and cooks a raw stdin every time', () => {
    const writes: string[] = [];
    const stdin = { isTTY: true, isRaw: true, setRawMode: (m: boolean) => void (stdin.isRaw = m) };
    const restore = createRestoreTerminal({ stdout: { isTTY: true, write: () => true }, stdin, writeSync: (_fd, s) => writes.push(s) });
    restore(); // fatalExit
    restore(); // unmount
    restore(); // process.on('exit')
    expect(writes).toEqual([RESTORE]);
    expect(restore.written).toBe(true);
    expect(stdin.isRaw).toBe(false);
    stdin.isRaw = true; // re-entered raw mode (a SIGCONT termios race)
    restore();
    expect(stdin.isRaw).toBe(false);
    expect(writes).toHaveLength(1);
    restore.rearm();
    restore();
    expect(writes).toHaveLength(2);
    // a pipe never gets the string
    const pipe: string[] = [];
    createRestoreTerminal({ stdout: { isTTY: undefined, write: () => true }, stdin: { isRaw: false }, writeSync: (_fd, s) => pipe.push(s) })();
    expect(pipe).toEqual([]);
  });

  it('writeCursorShape writes DECSCUSR only on a TTY', () => {
    const out: string[] = [];
    expect(writeCursorShape({ isTTY: true, write: (s) => out.push(s) })).toBe(true);
    expect(out).toEqual([DECSCUSR_BAR]);
    expect(writeCursorShape({ isTTY: undefined, write: (s) => out.push(s) })).toBe(false);
    expect(out).toHaveLength(1);
  });
});

// `createResizeDebounce` and its two assertions are DELETED with the export (TUI-DESIGN-4 §2.2 P-R2, §9.2's
// `src/tui/index.ts` row): the debounce's one consumer, `App.tsx`'s `wrapColumns`, is gone.

describe('createSuspensionQueue (§4.8)', () => {
  it('delivers directly, buffers while suspended, flushes in order on resume, and bounds the buffer', () => {
    const seen: number[] = [];
    const q = createSuspensionQueue<number>((n) => seen.push(n), 3);
    q.push(1);
    q.suspend();
    q.push(2);
    q.push(3);
    q.push(4);
    q.push(5);
    expect(seen).toEqual([1]);
    expect(q.size).toBe(3);
    expect(q.suspended).toBe(true);
    q.resume();
    expect(seen).toEqual([1, 3, 4, 5]);
    q.push(6);
    expect(seen).toEqual([1, 3, 4, 5, 6]);
  });
});

describe('installTerminalHygiene / suspendProcess (§14.2)', () => {
  it('registers exit + SIGTSTP listeners, exposes the hang-up gate, and uninstalls both', () => {
    const listeners = new Map<string, Array<() => void>>();
    const proc = {
      on: (event: string, fn: () => void) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
      off: (event: string, fn: () => void) => listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn)),
    } as never;
    const writes: string[] = [];
    let suspended = 0;
    const stdin = { isTTY: true, isRaw: true, setRawMode: (m: boolean) => void (stdin.isRaw = m) };
    const h = installTerminalHygiene({ io: { stdout: { isTTY: true, write: () => true }, stdin, writeSync: (_fd, s) => writes.push(s) }, proc, onSuspend: () => (suspended += 1) });
    expect(listeners.get('exit')).toHaveLength(1);
    expect(listeners.get('SIGTSTP')).toHaveLength(1);
    expect(h.hangupGate()).toBe(true);
    stdin.isRaw = false;
    expect(h.hangupGate()).toBe(false);
    listeners.get('SIGTSTP')?.[0]?.();
    expect(suspended).toBe(1);
    listeners.get('exit')?.[0]?.();
    expect(writes).toEqual([RESTORE]);
    h.uninstall();
    expect(listeners.get('exit')).toHaveLength(0);
    expect(listeners.get('SIGTSTP')).toHaveLength(0);
  });

  it('suspendProcess: suspendTerminal → RESTORE → SIGSTOP; SIGCONT resumes Ink, re-raws on the next chunk, repaints once; the queue is held meanwhile', async () => {
    const log: string[] = [];
    const sigcont: Array<() => void> = [];
    let readableCb: (() => void) | null = null;
    const stdin = {
      isTTY: true,
      isRaw: false,
      setRawMode: (m: boolean) => {
        log.push(`raw ${m}`);
        stdin.isRaw = m;
      },
      once: (_e: 'readable' | 'data', fn: () => void) => {
        readableCb = fn;
      },
    };
    const q = { suspend: () => log.push('queue suspend'), resume: () => log.push('queue resume') };
    const p = suspendProcess({
      suspendTerminal: async () => {
        log.push('ink suspend');
        return { resume: async () => void log.push('ink resume'), [Symbol.asyncDispose]: async () => undefined };
      },
      restore: () => log.push('restore'),
      proc: {
        pid: 42,
        kill: (pid, sig) => log.push(`kill ${pid} ${sig}`),
        once: (_e, fn) => sigcont.push(fn),
        off: () => undefined,
      },
      stdin,
      repaint: () => log.push('repaint'),
      rearm: () => log.push('rearm'),
      onQueue: q,
      setTimeout: () => 'timer',
      clearTimeout: () => log.push('cleared fallback'),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['queue suspend', 'ink suspend', 'restore', 'kill 42 SIGSTOP']);
    sigcont[0]?.();
    await p;
    expect(log.slice(4)).toEqual(['cleared fallback', 'rearm', 'ink resume', 'queue resume', 'repaint']);
    // the job-control shell restored cooked termios after CONT: the next chunk re-applies raw mode
    (readableCb as (() => void) | null)?.();
    expect(log.at(-1)).toBe('raw true');
  });

  it('suspendProcess: a stop that did not happen resumes after the fallback timer', async () => {
    const log: string[] = [];
    let fallback: (() => void) | null = null;
    const p = suspendProcess({
      suspendTerminal: async () => ({ resume: async () => void log.push('ink resume'), [Symbol.asyncDispose]: async () => undefined }),
      restore: () => undefined,
      proc: { pid: 1, kill: () => undefined, once: () => undefined, off: () => undefined },
      stdin: { isRaw: true },
      repaint: () => log.push('repaint'),
      setTimeout: (fn) => {
        fallback = fn;
        return 'timer';
      },
      clearTimeout: () => undefined,
      fallbackMs: 100,
    });
    await new Promise((r) => setTimeout(r, 0));
    (fallback as (() => void) | null)?.();
    await p;
    expect(log).toEqual(['ink resume', 'repaint']);
  });
});

describe('the process-wide restore instance (§14.2, finding 13)', () => {
  it('processRestoreTerminal() is one instance: restoreTerminal(), the hygiene of a mount and a later caller write RESTORE once; rearmRestoreTerminal re-arms it after Ctrl+Z', () => {
    const writes: string[] = [];
    const stdin = { isTTY: true, isRaw: true, setRawMode: (m: boolean) => void (stdin.isRaw = m) };
    const shared = createRestoreTerminal({ stdout: { isTTY: true, write: () => true }, stdin, writeSync: (_fd, s) => writes.push(s) });
    setProcessRestore(shared);
    try {
      expect(processRestoreTerminal()).toBe(shared);
      const proc = new EventEmitter() as unknown as HygieneProcess;
      const h = installTerminalHygiene({ io: { stdout: { isTTY: true, write: () => true }, stdin }, proc, restore: processRestoreTerminal() });
      expect(h.restore).toBe(shared);
      h.restore(); // unmount()
      restoreTerminal(); // the controller after unmount
      (proc as unknown as EventEmitter).emit('exit'); // the 'exit' hook
      expect(writes).toEqual([RESTORE]);
      rearmRestoreTerminal(); // fg after Ctrl+Z
      restoreTerminal();
      expect(writes).toEqual([RESTORE, RESTORE]);
      h.uninstall();
    } finally {
      setProcessRestore(null);
    }
  });
});
