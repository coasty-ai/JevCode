/**
 * TUI-DESIGN §13.4 / §19.0: `fatalExit` order (exit code → RESTORE → abort → unmount → epilogue → exit), a
 * canary in the thrown message is redacted, RESTORE is written before the epilogue (spy order), idempotence,
 * the debug stack, the unmount timeout, void / non-thenable / throwing unmounts, and the installed handlers incl.
 * EIO/EPIPE → 129.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { SerializedError, SignalName } from '../../../../src/core/types.js';
import { JevCodeError } from '../../../../src/errors.js';
import { FATAL_UNMOUNT_TIMEOUT_MS, HANGUP_EXIT_CODE, RESTORE, createFatalExit, fatalLines, installFatalHandlers, isHangupError, type FatalDeps } from '../../../../src/cli/fatal.js';

const CANARY = 'sk-ant-CANARY0123456789abcdefghijklmnop';
const redact = (s: string): string => s.split(CANARY).join('[REDACTED:test]');

interface Harness {
  deps: FatalDeps;
  calls: string[];
  written: { fd: number; text: string }[];
  abort: ReturnType<typeof vi.fn>;
  exitCodes: number[];
}

function harness(over: Partial<FatalDeps> = {}, opts: { unmountMs?: number | 'never' } = {}): Harness {
  const calls: string[] = [];
  const written: { fd: number; text: string }[] = [];
  const exitCodes: number[] = [];
  const abort = vi.fn((reason: string, o?: unknown) => {
    calls.push(`abort:${reason}:${JSON.stringify(o)}`);
  });
  const write = (fd: 1 | 2, text: string): void => {
    calls.push(`write:${fd}`);
    written.push({ fd, text });
  };
  const deps: FatalDeps = {
    write,
    exit: (code) => {
      calls.push(`exit:${code}`);
    },
    restore: () => {
      calls.push('restore');
      write(1, RESTORE);
    },
    redact,
    context: () => ({ runId: 'r1', runDir: '/tmp/runs/r1', resumable: true }),
    engine: () => ({ abort: abort as unknown as (reason: 'human_abort' | 'signal' | 'error', o?: { signal?: SignalName; error?: SerializedError }) => void }),
    unmount: () => {
      calls.push('unmount');
      if (opts.unmountMs === 'never') return new Promise<void>(() => undefined);
      const ms = typeof opts.unmountMs === 'number' ? opts.unmountMs : 0;
      return new Promise<void>((r) => setTimeout(() => r(), ms));
    },
    setExitCode: (code) => {
      calls.push(`exitCode:${code}`);
      exitCodes.push(code);
    },
    env: {},
    ...over,
  };
  return { deps, calls, written, abort, exitCodes };
}

describe('createFatalExit (§13.4)', () => {
  it('follows the fixed order and writes RESTORE before the epilogue', async () => {
    const h = harness();
    const fatalExit = createFatalExit(h.deps);
    const err = new JevCodeError('jev_http', `Jev HTTP 500: ${CANARY}`, { exitCode: 5 });
    await fatalExit(err);
    expect(h.calls).toEqual(['exitCode:5', 'restore', 'write:1', `abort:error:${JSON.stringify({ error: { name: 'JevCodeError', code: 'jev_http', message: 'Jev HTTP 500: [REDACTED:test]', exitCode: 5 } })}`, 'unmount', 'write:2', 'exit:5']);
    // spy order: the RESTORE bytes land on stdout before a single epilogue byte on stderr
    expect(h.written[0]).toEqual({ fd: 1, text: RESTORE });
    expect(h.written[1]?.fd).toBe(2);
    expect(h.written[1]?.text).toBe(['jevcode: stopped — jev_http: Jev HTTP 500: [REDACTED:test] (exit 5)', '  run       r1', '  files     /tmp/runs/r1/  (transcript.log, state.json, jevcode.log)', '  resume    jevcode run --resume r1', '  report    jevcode report r1   (redacted bundle written locally; nothing is sent)'].join('\n') + '\n');
    expect(h.written.map((w) => w.text).join('')).not.toContain(CANARY);
    expect(fatalExit.fired()).toBe(true);
  });

  it('never prints ESC c / ESC[2J / ESC[3J and RESTORE is the documented byte string', () => {
    expect(RESTORE).toBe('\x1b[?2004l\x1b[?2026l\x1b[0 q\x1b[?25h\x1b[0m');
    expect(RESTORE).not.toContain('\x1bc');
    expect(RESTORE).not.toContain('[2J');
    expect(RESTORE).not.toContain('[3J');
  });

  it('a non-JevCode error exits 1 with code `internal`; the engine abort carries the serialized error', async () => {
    const h = harness();
    await createFatalExit(h.deps)(new TypeError('x is not a function'));
    expect(h.exitCodes).toEqual([1]);
    expect(h.abort).toHaveBeenCalledWith('error', { error: { name: 'JevCodeError', code: 'internal', message: 'x is not a function', exitCode: 1 } });
    expect(h.calls.at(-1)).toBe('exit:1');
    // a thrown non-Error value works too
    const h2 = harness();
    await createFatalExit(h2.deps)('string reason');
    expect(h2.written[1]?.text).toContain('stopped — internal: string reason (exit 1)');
  });

  it('is idempotent: a second fault while the first is in flight is ignored', async () => {
    const h = harness({}, { unmountMs: 20 });
    const fatalExit = createFatalExit(h.deps);
    const p1 = fatalExit(new Error('first'));
    const p2 = fatalExit(new Error('second'));
    expect(p2).toBe(p1);
    await p1;
    expect(h.calls.filter((c) => c.startsWith('exit:'))).toEqual(['exit:1']);
    expect(h.written.filter((w) => w.fd === 2)).toHaveLength(1);
    expect(h.written[1]?.text).toContain('first');
  });

  it('a hanging unmount is bounded by the timeout and the exit still happens', async () => {
    const h = harness({ unmountTimeoutMs: 15 }, { unmountMs: 'never' });
    const t0 = performance.now();
    await createFatalExit(h.deps)(new Error('hang'));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(h.calls.at(-1)).toBe('exit:1');
    expect(FATAL_UNMOUNT_TIMEOUT_MS).toBe(2000);
  });

  it('works without an engine, renderer or exitCode setter, and survives throwing dependencies', async () => {
    const h = harness();
    delete (h.deps as Partial<FatalDeps>).engine;
    delete (h.deps as Partial<FatalDeps>).unmount;
    delete (h.deps as Partial<FatalDeps>).setExitCode;
    await createFatalExit(h.deps)(new Error('bare'));
    expect(h.calls).toEqual(['restore', 'write:1', 'write:2', 'exit:1']);
    const throwing = harness({
      restore: () => {
        throw new Error('tty gone');
      },
      unmount: () => Promise.reject(new Error('unmount failed')),
      write: () => {
        throw new Error('EPIPE');
      },
    });
    await createFatalExit(throwing.deps)(new Error('x'));
    expect(throwing.calls.at(-1)).toBe('exit:1');
  });

  it('JEVCODE_DEBUG=1 appends the redacted stack; otherwise no stack', async () => {
    const err = new Error(`boom ${CANARY}`);
    err.stack = `Error: boom ${CANARY}\n    at f (/x/${CANARY}.ts:1:1)\n    at g\u001b[2J (/y.ts:2:2)`;
    const off = harness();
    await createFatalExit(off.deps)(err);
    expect(off.written[1]?.text.split('\n').filter((l) => l.includes('    at'))).toEqual([]);
    const on = harness({ env: { JEVCODE_DEBUG: '1' } });
    await createFatalExit(on.deps)(err);
    const text = on.written[1]?.text ?? '';
    expect(text).toContain('  Error: boom [REDACTED:test]');
    expect(text).toContain('  at f (/x/[REDACTED:test].ts:1:1)');
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain('\u001b');
  });

  it('fatalLines is pure: epilogue + optional stack, blank stack lines dropped', () => {
    const e: SerializedError = { name: 'E', code: 'internal', message: 'm', exitCode: 1 };
    const ctx = { runId: null, runDir: null, resumable: false };
    expect(fatalLines(e, ctx, redact)).toEqual(['jevcode: stopped — internal: m (exit 1)']);
    // blank lines dropped, every kept line trimmed and re-indented by two spaces
    expect(fatalLines(e, ctx, redact, { stack: 'a\n\n b \n\t', debug: true })).toEqual(['jevcode: stopped — internal: m (exit 1)', '  a', '  b']);
    expect(fatalLines(e, ctx, redact, { stack: 'a', debug: false })).toHaveLength(1);
    expect(fatalLines(e, ctx, redact, { stack: null, debug: true })).toHaveLength(1);
  });

  it('an unmount that returns void (Ink `Instance.unmount(): void`) or a non-thenable still reaches the epilogue and the exit', async () => {
    const asVoid = harness({ unmount: (() => undefined) as unknown as () => Promise<void> });
    await createFatalExit(asVoid.deps)(new JevCodeError('sandbox', 'x', { exitCode: 6 }));
    expect(asVoid.calls.slice(-2)).toEqual(['write:2', 'exit:6']);
    expect(asVoid.written.at(-1)?.text).toContain('stopped — sandbox: x (exit 6)');
    const asNumber = harness({ unmount: (() => 42) as unknown as () => Promise<void> });
    await createFatalExit(asNumber.deps)(new Error('y'));
    expect(asNumber.calls.slice(-2)).toEqual(['write:2', 'exit:1']);
    const asThenable = harness({ unmount: (() => ({ then: (ok: () => void) => ok() })) as unknown as () => Promise<void> });
    await createFatalExit(asThenable.deps)(new Error('z'));
    expect(asThenable.calls.slice(-2)).toEqual(['write:2', 'exit:1']);
  });

  it('an unmount that throws synchronously or rejects asynchronously still ends with write:2 and exit:<code>', async () => {
    const sync = harness({
      unmount: () => {
        throw new Error('unmount threw');
      },
    });
    await createFatalExit(sync.deps)(new JevCodeError('jev_http', 'm', { exitCode: 5 }));
    expect(sync.calls.slice(-2)).toEqual(['write:2', 'exit:5']);
    const rejecting = harness({ unmount: () => Promise.reject(new Error('unmount failed')) });
    await createFatalExit(rejecting.deps)(new JevCodeError('jev_http', 'm', { exitCode: 5 }));
    expect(rejecting.calls.slice(-2)).toEqual(['write:2', 'exit:5']);
    const lateReject = harness({ unmount: () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('late')), 5)) });
    await createFatalExit(lateReject.deps)(new Error('w'));
    expect(lateReject.calls.slice(-2)).toEqual(['write:2', 'exit:1']);
    // a broken injected timer never blocks the exit either
    const badTimer = harness({
      setTimeout: () => {
        throw new Error('no timers');
      },
      clearTimeout: () => {
        throw new Error('no timers');
      },
    });
    await createFatalExit(badTimer.deps)(new Error('t'));
    expect(badTimer.calls.slice(-2)).toEqual(['write:2', 'exit:1']);
  });
});

describe('installFatalHandlers (§13.4)', () => {
  it('routes uncaughtException / unhandledRejection to the fatal path and uninstalls cleanly', async () => {
    const h = harness();
    const proc = new EventEmitter();
    const uninstall = installFatalHandlers(h.deps, proc);
    expect(proc.listenerCount('uncaughtException')).toBe(1);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
    proc.emit('unhandledRejection', new JevCodeError('sandbox', 'spawn failed', { exitCode: 6 }));
    await new Promise((r) => setTimeout(r, 5));
    expect(h.calls.at(-1)).toBe('exit:6');
    uninstall();
    expect(proc.listenerCount('uncaughtException')).toBe(0);
    expect(proc.listenerCount('unhandledRejection')).toBe(0);
  });

  it('stdio EIO / EPIPE → abort(signal SIGHUP), exit 129, no terminal writes, no epilogue', () => {
    const h = harness();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const uninstall = installFatalHandlers({ ...h.deps, streams: [stdout, stderr] }, new EventEmitter());
    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(h.calls).toEqual(['exitCode:129', `abort:signal:${JSON.stringify({ signal: 'SIGHUP' })}`, 'exit:129']);
    expect(h.written).toEqual([]);
    // a second stream error is ignored
    stderr.emit('error', Object.assign(new Error('EIO'), { code: 'EIO' }));
    expect(h.calls.filter((c) => c.startsWith('exit:'))).toEqual(['exit:129']);
    expect(HANGUP_EXIT_CODE).toBe(129);
    uninstall();
    expect(stdout.listenerCount('error')).toBe(0);
    expect(isHangupError(Object.assign(new Error(), { code: 'EIO' }))).toBe(true);
    expect(isHangupError(Object.assign(new Error(), { code: 'ENOSPC' }))).toBe(false);
    expect(isHangupError(null)).toBe(false);
  });

  it('a non-hang-up stream error is a fatal', async () => {
    const h = harness();
    const stdout = new EventEmitter();
    installFatalHandlers({ ...h.deps, streams: [stdout] }, new EventEmitter());
    stdout.emit('error', Object.assign(new Error('disk'), { code: 'ENOSPC' }));
    await new Promise((r) => setTimeout(r, 5));
    expect(h.calls).toContain('restore');
    expect(h.calls.at(-1)).toBe('exit:1');
  });
});
