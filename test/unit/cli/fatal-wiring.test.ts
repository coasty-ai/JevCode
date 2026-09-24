/**
 * TUI-DESIGN §13.4 / §14.2 / §19.0: the process wiring on top of `installFatalHandlers` with injected deps — the
 * fixed order (exit code → `fs.writeSync(1, RESTORE)` → `setRawMode(false)` → `abort('error', { error })` → unmount
 * raced with the bound → epilogue on fd 2 → `process.exit`), a canary in the thrown message redacted everywhere,
 * stdio EIO/EPIPE listeners installed before any SIGHUP logic, SIGHUP → `abort('signal', { signal: 'SIGHUP' })` +
 * exit 129 with no terminal writes, stdin `'end'` gated on `isTTY && isRaw`, the restore's idempotence and its
 * stdout-TTY gate, and a clean uninstall.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { SerializedError, SignalName } from '../../../src/core/types.js';
import { JevCodeError } from '../../../src/errors.js';
import { ALT_SCREEN_LEAVE, HANGUP_EXIT_CODE, RESTORE, alternateScreenEntered, createRestoreTerminal, markAlternateScreen, wireFatalHandlers, type FatalProcessLike, type FatalStdin, type FatalWiringDeps } from '../../../src/cli/fatal.js';

const CANARY = 'sk-ant-CANARY0123456789abcdefghijklmnop';
const redact = (s: string): string => s.split(CANARY).join('[REDACTED:test]');

class FakeStream extends EventEmitter {
  isTTY: boolean | undefined;
  isRaw: boolean | undefined;
  setRawModeCalls: boolean[] = [];
  constructor(o: { isTTY?: boolean; isRaw?: boolean } = {}) {
    super();
    this.isTTY = o.isTTY;
    this.isRaw = o.isRaw;
  }
  setRawMode(mode: boolean): this {
    this.setRawModeCalls.push(mode);
    this.isRaw = mode;
    return this;
  }
}

class FakeProcess extends EventEmitter implements FatalProcessLike {
  stdin: FakeStream;
  stdout: FakeStream;
  stderr: FakeStream;
  exitCode: number | string | null | undefined = undefined;
  env: Record<string, string | undefined> = {};
  exits: number[] = [];
  /** every listener registration in order: `<target>:<event>` */
  registrations: string[] = [];
  constructor(o: { stdinTTY?: boolean; raw?: boolean; stdoutTTY?: boolean } = {}) {
    super();
    this.stdin = new FakeStream({ isTTY: o.stdinTTY ?? true, isRaw: o.raw ?? true });
    this.stdout = new FakeStream({ isTTY: o.stdoutTTY ?? true });
    this.stderr = new FakeStream({ isTTY: o.stdoutTTY ?? true });
    for (const [name, s] of [['stdin', this.stdin], ['stdout', this.stdout], ['stderr', this.stderr]] as const) {
      const on = s.on.bind(s);
      s.on = ((event: string, listener: (...a: unknown[]) => void) => {
        this.registrations.push(`${name}:${event}`);
        return on(event, listener);
      }) as typeof s.on;
    }
  }
  override on(event: string, listener: (...args: unknown[]) => void): this {
    this.registrations.push(`process:${event}`);
    return super.on(event, listener);
  }
  exit(code?: number): void {
    this.exits.push(code ?? -1);
  }
}

interface Harness {
  proc: FakeProcess;
  writes: { fd: number; text: string }[];
  abort: ReturnType<typeof vi.fn>;
  deps: FatalWiringDeps;
}

function harness(o: { stdinTTY?: boolean; raw?: boolean; stdoutTTY?: boolean; unmountMs?: number | 'never'; over?: Partial<FatalWiringDeps> } = {}): Harness {
  const proc = new FakeProcess(o);
  const writes: { fd: number; text: string }[] = [];
  const abort = vi.fn((_reason: string, _o?: unknown) => undefined);
  const deps: FatalWiringDeps = {
    proc,
    writeSync: (fd, text) => {
      writes.push({ fd, text });
    },
    redact,
    context: () => ({ runId: 'r1', runDir: '/tmp/runs/r1', resumable: true }),
    engine: () => ({ abort: abort as unknown as (reason: 'human_abort' | 'signal' | 'error', x?: { signal?: SignalName; error?: SerializedError }) => void }),
    unmount: () => {
      writes.push({ fd: 0, text: 'unmount' });
      if (o.unmountMs === 'never') return new Promise<void>(() => undefined);
      const ms = typeof o.unmountMs === 'number' ? o.unmountMs : 0;
      return new Promise<void>((r) => setTimeout(() => r(), ms));
    },
    ...o.over,
  };
  return { proc, writes, abort, deps };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('wireFatalHandlers: the fatal path over the real process surface (§13.4)', () => {
  it('uncaughtException with a canary: exit code, RESTORE on fd 1, raw mode off, abort(error) with the redacted error, unmount, redacted epilogue on fd 2, process.exit', async () => {
    const h = harness();
    const w = wireFatalHandlers(h.deps);
    h.proc.emit('uncaughtException', new JevCodeError('jev_http', `Jev HTTP 500: ${CANARY}`, { exitCode: 5 }));
    await tick();
    expect(h.proc.exitCode).toBe(5);
    expect(h.proc.exits).toEqual([5]);
    // order: RESTORE (fd 1) before setRawMode(false) before unmount before the epilogue (fd 2)
    expect(h.writes.map((x) => x.fd)).toEqual([1, 0, 2]);
    expect(h.writes[0]?.text).toBe(RESTORE);
    expect(h.proc.stdin.setRawModeCalls).toEqual([false]);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.abort).toHaveBeenCalledWith('error', { error: { name: 'JevCodeError', code: 'jev_http', message: 'Jev HTTP 500: [REDACTED:test]', exitCode: 5 } });
    const epilogue = h.writes[2]?.text ?? '';
    expect(epilogue.split('\n')[0]).toBe('jevcode: stopped — jev_http: Jev HTTP 500: [REDACTED:test] (exit 5)');
    // TUI-DESIGN-4 §3.1: the epilogue's rows are `kv` block rows now, so the key column's width is derived from
    // the longest key rather than hard-coded — the assertion is on the row, not on the padding
    expect(epilogue).toMatch(/^ {2}resume {2,}jevcode run --resume r1$/m);
    expect(JSON.stringify(h.writes) + JSON.stringify(h.abort.mock.calls)).not.toContain(CANARY);
    expect(w.fatalExit.fired()).toBe(true);
    w.uninstall();
  });

  it('unhandledRejection and main().catch(fatalExit) share one idempotent path; JEVCODE_DEBUG=1 appends the redacted stack', async () => {
    const h = harness({ over: { env: { JEVCODE_DEBUG: '1' } } });
    const w = wireFatalHandlers(h.deps);
    const err = new Error(`boom ${CANARY}`);
    err.stack = `Error: boom ${CANARY}\n    at f (/x/${CANARY}.ts:1:1)`;
    const p1 = w.fatalExit(err);
    h.proc.emit('unhandledRejection', new Error('second'));
    await p1;
    await tick();
    expect(h.proc.exits).toEqual([1]);
    const epilogue = h.writes.filter((x) => x.fd === 2).map((x) => x.text).join('');
    expect(epilogue).toContain('stopped — internal: boom [REDACTED:test] (exit 1)');
    expect(epilogue).toContain('  at f (/x/[REDACTED:test].ts:1:1)');
    expect(epilogue).not.toContain('second');
    expect(epilogue).not.toContain(CANARY);
    w.uninstall();
  });

  it('a hanging unmount is bounded by unmountTimeoutMs and the exit still happens', async () => {
    const h = harness({ unmountMs: 'never', over: { unmountTimeoutMs: 20 } });
    const w = wireFatalHandlers(h.deps);
    const t0 = performance.now();
    await w.fatalExit(new Error('hang'));
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(h.proc.exits).toEqual([1]);
  });

  it('installs the stdio error listeners before any SIGHUP logic, then uninstalls everything', () => {
    const h = harness();
    const w = wireFatalHandlers(h.deps);
    const regs = h.proc.registrations;
    const firstSighup = regs.indexOf('process:SIGHUP');
    const lastStreamError = Math.max(regs.indexOf('stdin:error'), regs.indexOf('stdout:error'), regs.indexOf('stderr:error'));
    expect(lastStreamError).toBeGreaterThanOrEqual(0);
    expect(firstSighup).toBeGreaterThan(lastStreamError);
    expect(regs.indexOf('stdin:end')).toBeGreaterThan(lastStreamError);
    expect(regs.indexOf('process:uncaughtException')).toBeGreaterThan(lastStreamError);
    for (const [target, ev] of [[h.proc.stdin, 'error'], [h.proc.stdout, 'error'], [h.proc.stderr, 'error'], [h.proc.stdin, 'end'], [h.proc, 'SIGHUP'], [h.proc, 'uncaughtException'], [h.proc, 'unhandledRejection']] as const) expect(target.listenerCount(ev)).toBe(1);
    w.uninstall();
    for (const [target, ev] of [[h.proc.stdin, 'error'], [h.proc.stdout, 'error'], [h.proc.stderr, 'error'], [h.proc.stdin, 'end'], [h.proc, 'SIGHUP'], [h.proc, 'uncaughtException'], [h.proc, 'unhandledRejection']] as const) expect(target.listenerCount(ev)).toBe(0);
  });
});

describe('wireFatalHandlers: the hang-up path (§13.4, §13.5 → 129)', () => {
  it('SIGHUP with a raw TTY: abort(signal SIGHUP), exit 129, no terminal writes, no epilogue; a later fault is ignored', async () => {
    const h = harness();
    const w = wireFatalHandlers(h.deps);
    h.proc.emit('SIGHUP');
    expect(h.abort).toHaveBeenCalledWith('signal', { signal: 'SIGHUP' });
    expect(h.proc.exitCode).toBe(HANGUP_EXIT_CODE);
    expect(h.proc.exits).toEqual([129]);
    expect(h.writes).toEqual([]);
    expect(h.proc.stdin.setRawModeCalls).toEqual([]);
    h.proc.emit('SIGHUP');
    h.proc.emit('uncaughtException', new Error('after hangup'));
    await tick();
    expect(h.proc.exits).toEqual([129, 1]); // the fatal path is separate and still exits; the hang-up itself fired once
    expect(h.abort).toHaveBeenCalledTimes(2);
    w.uninstall();
  });

  it('stdin end is a hang-up only while stdin.isTTY && stdin.isRaw; on a pipe it means nothing', () => {
    const raw = harness({ stdinTTY: true, raw: true });
    wireFatalHandlers(raw.deps);
    raw.proc.stdin.emit('end');
    expect(raw.abort).toHaveBeenCalledWith('signal', { signal: 'SIGHUP' });
    expect(raw.proc.exits).toEqual([129]);
    expect(raw.writes).toEqual([]);
    const pipe = harness({ stdinTTY: false, raw: false });
    const w = wireFatalHandlers(pipe.deps);
    expect(w.hangupGate()).toBe(false);
    pipe.proc.stdin.emit('end');
    expect(pipe.abort).not.toHaveBeenCalled();
    expect(pipe.proc.exits).toEqual([]);
    // cooked TTY (--plain): EOF is readline's business, not a hang-up
    const cooked = harness({ stdinTTY: true, raw: false });
    wireFatalHandlers(cooked.deps);
    cooked.proc.stdin.emit('end');
    expect(cooked.proc.exits).toEqual([]);
    // the gate is read when the event fires: raw mode entered later counts
    cooked.proc.stdin.setRawMode(true);
    cooked.proc.stdin.emit('end');
    expect(cooked.proc.exits).toEqual([129]);
  });

  it('EPIPE on stdout and EIO on stdin are hang-ups even on a pipe; any other stream error is a fatal', async () => {
    const h = harness({ stdinTTY: false, raw: false, stdoutTTY: false });
    wireFatalHandlers(h.deps);
    h.proc.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(h.abort).toHaveBeenCalledWith('signal', { signal: 'SIGHUP' });
    expect(h.proc.exits).toEqual([129]);
    // TUI-DESIGN-4 §2.8 P-R11: nothing on fd 1 (the terminal is a pipe and may be closed), one line on fd 2
    expect(h.writes.map((x) => x.fd)).toEqual([2]);
    expect(h.writes[0]?.text).toMatch(/^jevcode: stdout closed; run checkpointed at \S/);
    const other = harness({ stdoutTTY: false });
    wireFatalHandlers(other.deps);
    other.proc.stderr.emit('error', Object.assign(new Error(`ENOSPC ${CANARY}`), { code: 'ENOSPC' }));
    await tick();
    expect(other.proc.exits).toEqual([1]);
    // stdout is not a TTY: no RESTORE bytes on a pipe, but the epilogue still goes to fd 2
    expect(other.writes.map((x) => x.fd)).toEqual([0, 2]);
    expect(other.writes[1]?.text).toContain('[REDACTED:test]');
    expect(other.writes[1]?.text).not.toContain(CANARY);
  });
});

describe('createRestoreTerminal (§13.4 step 2, §14.2)', () => {
  it('writes RESTORE once when stdout is a TTY, turns raw mode off once when raw, and swallows write failures', () => {
    const writes: { fd: number; text: string }[] = [];
    const stdin = new FakeStream({ isRaw: true });
    const restore = createRestoreTerminal({ stdin, stdout: { isTTY: true } }, (fd, text) => writes.push({ fd, text }));
    restore();
    restore();
    expect(writes).toEqual([{ fd: 1, text: RESTORE }]);
    expect(stdin.setRawModeCalls).toEqual([false]);
    const cooked = new FakeStream({ isRaw: false });
    const w2: number[] = [];
    createRestoreTerminal({ stdin: cooked, stdout: { isTTY: false } }, (fd) => w2.push(fd))();
    expect(w2).toEqual([]);
    expect(cooked.setRawModeCalls).toEqual([]);
    const broken: Pick<FatalStdin, 'isRaw' | 'setRawMode'> = {
      isRaw: true,
      setRawMode: () => {
        throw new Error('ENOTTY');
      },
    };
    expect(() =>
      createRestoreTerminal({ stdin: broken, stdout: { isTTY: true } }, () => {
        throw new Error('EIO');
      })(),
    ).not.toThrow();
  });

  /**
   * TUI-DESIGN-4 §1.3.1: a fullscreen mount must never strand the user on a blank alternate buffer. The flag is
   * set by `createTuiRenderer` through `markAlternateScreen()`; the classic renderer never sets it, and a classic
   * session's restore must not swap the screen out from under it.
   */
  it('writes ESC[?1049l before RESTORE only when the alternate screen was entered (§1.3.1)', () => {
    try {
      expect(alternateScreenEntered()).toBe(false);
      const classic: { fd: number; text: string }[] = [];
      createRestoreTerminal({ stdin: new FakeStream({ isRaw: false }), stdout: { isTTY: true } }, (fd, text) => classic.push({ fd, text }))();
      expect(classic).toEqual([{ fd: 1, text: RESTORE }]);
      markAlternateScreen();
      expect(alternateScreenEntered()).toBe(true);
      const full: { fd: number; text: string }[] = [];
      createRestoreTerminal({ stdin: new FakeStream({ isRaw: false }), stdout: { isTTY: true } }, (fd, text) => full.push({ fd, text }))();
      expect(full).toEqual([{ fd: 1, text: `${ALT_SCREEN_LEAVE}${RESTORE}` }]);
      expect(ALT_SCREEN_LEAVE).toBe('\x1b[?1049l');
      // never ESC[2J / ESC[3J: the scrollback is the user's (§14.2)
      expect(full[0]?.text).not.toContain('\x1b[2J');
      expect(full[0]?.text).not.toContain('\x1b[3J');
    } finally {
      markAlternateScreen(false);
    }
  });

  it('an injected restore (O9 restoreTerminal) replaces the default and runs before the epilogue', async () => {
    const order: string[] = [];
    const h = harness({
      over: {
        restore: () => order.push('restore'),
        writeSync: (fd) => {
          order.push(`write:${fd}`);
        },
      },
    });
    const w = wireFatalHandlers(h.deps);
    expect(w.restore).toBe(h.deps.restore);
    await w.fatalExit(new Error('x'));
    expect(order).toEqual(['restore', 'write:2']);
    expect(h.proc.stdin.setRawModeCalls).toEqual([]);
  });

  it('defaults compile against the real process surface without touching it', () => {
    // `process` satisfies FatalProcessLike (the type-level contract of the default); nothing is installed here
    const p: FatalProcessLike = process;
    expect(typeof p.exit).toBe('function');
    expect(typeof p.stdin.on).toBe('function');
  });

  it('reused after an early call: raw mode re-entered later is turned off again by fatalExit; RESTORE is still written once', async () => {
    const h = harness();
    const w = wireFatalHandlers(h.deps);
    // an engine `exit` path (or the process 'exit' hook) ran the restore first…
    w.restore();
    expect(h.writes).toEqual([{ fd: 1, text: RESTORE }]);
    expect(h.proc.stdin.setRawModeCalls).toEqual([false]);
    // …then Ink re-entered raw mode, and a fault follows
    h.proc.stdin.setRawMode(true);
    await w.fatalExit(new Error('late'));
    expect(h.proc.stdin.setRawModeCalls).toEqual([false, true, false]);
    expect(h.proc.stdin.isRaw).toBe(false);
    expect(h.writes.filter((x) => x.fd === 1)).toEqual([{ fd: 1, text: RESTORE }]);
    expect(h.proc.exits).toEqual([1]);
    // the standalone restore behaves the same
    const stdin = new FakeStream({ isRaw: true });
    const writes: number[] = [];
    const restore = createRestoreTerminal({ stdin, stdout: { isTTY: true } }, (fd) => writes.push(fd));
    restore();
    stdin.setRawMode(true);
    restore();
    expect(stdin.setRawModeCalls).toEqual([false, true, false]);
    expect(writes).toEqual([1]);
  });
});

describe('wireFatalHandlers: hang-up without an engine or a renderer, and the real process', () => {
  it('hangup when engine() returns null and unmount is absent: exit 129, nothing thrown, no writes', () => {
    const h = harness({ over: { engine: () => null } });
    delete h.deps.unmount;
    const w = wireFatalHandlers(h.deps);
    expect(() => h.proc.emit('SIGHUP')).not.toThrow();
    expect(h.proc.exitCode).toBe(HANGUP_EXIT_CODE);
    expect(h.proc.exits).toEqual([129]);
    expect(h.writes).toEqual([]);
    expect(h.abort).not.toHaveBeenCalled();
    w.uninstall();
    // without any engine accessor at all
    const bare = harness();
    delete bare.deps.engine;
    delete bare.deps.unmount;
    wireFatalHandlers(bare.deps);
    bare.proc.stdout.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
    expect(bare.proc.exits).toEqual([129]);
  });

  it('installs and uninstalls against the real process without side effects', () => {
    const events = ['uncaughtException', 'unhandledRejection', 'SIGHUP'] as const;
    const before = events.map((e) => process.listenerCount(e));
    const stdinBefore = [process.stdin.listenerCount('error'), process.stdin.listenerCount('end')];
    const stdoutBefore = process.stdout.listenerCount('error');
    const stderrBefore = process.stderr.listenerCount('error');
    const exitCodeBefore = process.exitCode;
    const writes: number[] = [];
    const w = wireFatalHandlers({ proc: process, writeSync: (fd) => writes.push(fd), redact: (s) => s, context: () => ({ runId: null, runDir: null, resumable: false }) });
    expect(events.map((e) => process.listenerCount(e))).toEqual(before.map((n) => n + 1));
    expect([process.stdin.listenerCount('error'), process.stdin.listenerCount('end')]).toEqual(stdinBefore.map((n) => n + 1));
    expect(process.stdout.listenerCount('error')).toBe(stdoutBefore + 1);
    expect(process.stderr.listenerCount('error')).toBe(stderrBefore + 1);
    expect(typeof w.hangupGate()).toBe('boolean');
    expect(w.fatalExit.fired()).toBe(false);
    w.uninstall();
    expect(events.map((e) => process.listenerCount(e))).toEqual(before);
    expect([process.stdin.listenerCount('error'), process.stdin.listenerCount('end')]).toEqual(stdinBefore);
    expect(process.stdout.listenerCount('error')).toBe(stdoutBefore);
    expect(process.stderr.listenerCount('error')).toBe(stderrBefore);
    expect(process.exitCode).toBe(exitCodeBefore);
    expect(writes).toEqual([]);
  });
});
