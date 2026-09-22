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
import { FATAL_UNMOUNT_TIMEOUT_MS, HANGUP_EXIT_CODE, RESTORE, createFatalExit, fatalLines, hangupStderrLine, installFatalHandlers, isHangupError, type FatalDeps } from '../../../../src/cli/fatal.js';

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
    // the epilogue body is `epilogueLines`' (S3 owns its column widths, TUI-DESIGN-4 §3.1): pin the rows, not the padding
    const epilogue = h.written[1]?.text ?? '';
    expect(epilogue.split('\n')[0]).toBe('jevcode: stopped — jev_http: Jev HTTP 500: [REDACTED:test] (exit 5)');
    expect(epilogue).toMatch(/\n {2}run +r1\n/);
    expect(epilogue).toMatch(/\n {2}files +\/tmp\/runs\/r1\/ {2}\(transcript\.log, state\.json, jevcode\.log\)\n/);
    expect(epilogue).toMatch(/\n {2}resume +jevcode run --resume r1\n/);
    expect(epilogue).toContain('jevcode report r1');
    expect(epilogue.endsWith('\n')).toBe(true);
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

  it('stdio EIO / EPIPE → abort(signal SIGHUP), exit 129, P-R11\'s one stderr line, no terminal writes, no epilogue', () => {
    const h = harness();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const uninstall = installFatalHandlers({ ...h.deps, streams: [stdout, stderr] }, new EventEmitter());
    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    // TUI-DESIGN-4 §2.8 P-R11 / §12: the empty stderr is the measured defect — one line names the checkpoint and
    // the code stays 129. Nothing goes to fd 1 and there is still no epilogue.
    expect(h.calls).toEqual(['exitCode:129', `abort:signal:${JSON.stringify({ signal: 'SIGHUP' })}`, 'write:2', 'exit:129']);
    expect(h.written.map((w) => w.fd)).toEqual([2]);
    expect(h.written[0]?.text).toBe('jevcode: stdout closed; run checkpointed at /tmp/runs/r1\n');
    expect(hangupStderrLine(null, null)).toBeNull();
    expect(hangupStderrLine(null, '/tmp/runs')).toBe('jevcode: stdout closed; run checkpointed at /tmp/runs');
    h.written.length = 0;
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

/**
 * TUI-DESIGN-4 §7.4 (P-D4) / §10 (S6 `cli/fatal.test.ts`): a thrown EACCES → exit 2, stderr carries the epilogue
 * **and** the fix block, stdout empty.
 *
 * Measured before round 4: a read-only `$HOME` gave `[ui] error: EACCES: permission denied, mkdir '<home>/runs'`
 * on **stdout**, an empty stderr, no epilogue and exit **1**.
 */
describe('fatalExit routes a file-system failure through §7.4 (P-D4)', () => {
  const errno = (code: string, path: string, syscall = 'mkdir'): Error => Object.assign(new Error(`${code}: permission denied, ${syscall} '${path}'`), { code, path, syscall });

  it('EACCES on mkdir of the runs dir: exit 2, the sentence and the fix on stderr, nothing on stdout', async () => {
    const h = harness();
    await createFatalExit(h.deps)(errno('EACCES', '/home/u/.jevcode/runs'));
    expect(h.exitCodes).toEqual([2]);
    expect(h.calls).toContain('exit:2');
    const err = h.written.filter((w) => w.fd === 2).map((w) => w.text).join('');
    expect(err).toContain('cannot create the runs directory /home/u/.jevcode/runs: permission denied');
    expect(err).toContain('set JEVCODE_HOME to a writable directory, or pass --runs-dir <dir>');
    // the raw errno text never reaches the user
    expect(err).not.toContain("mkdir '/home/u/.jevcode/runs'");
    // stdout carries only the RESTORE bytes: the message itself never goes there (the measured defect)
    expect(h.written.filter((w) => w.fd === 1)).toEqual([{ fd: 1, text: RESTORE }]);
  });

  it('ENOSPC inside the live run dir is exit 3 with the volume fix; at launch it is 2; an unclassified error keeps today\'s epilogue and exit 1', async () => {
    // §7.4 row 2: the harness's `context().runDir` is `/tmp/runs/r1`, so a write INSIDE it means this run cannot be
    // checkpointed. The design puts the split in `explainFsError`; that file is the harness session's under the
    // 2026-09-22 ownership rule, so it is made at this call site and the `src/errors.ts` hunk is owed (STATUS.md).
    const full = harness();
    await createFatalExit(full.deps)(errno('ENOSPC', '/tmp/runs/r1/state.json', 'write'));
    expect(full.exitCodes).toEqual([3]);
    expect(full.written.map((w) => w.text).join('')).toContain('free space, or pass --runs-dir <dir> on another volume');
    // the same code while the LAUNCH creates the runs directory is a configuration problem: exit 2
    const launch = harness({ places: () => ({ runsDir: '/tmp/runs' }) });
    await createFatalExit(launch.deps)(errno('ENOSPC', '/tmp/runs', 'mkdir'));
    expect(launch.exitCodes).toEqual([2]);
    const plain = harness();
    await createFatalExit(plain.deps)(new Error('a plain bug'));
    expect(plain.exitCodes).toEqual([1]);
    expect(plain.written.map((w) => w.text).join('')).not.toContain('--runs-dir');
    // a stream ENOSPC carries no `path`: a broken terminal is not a misconfigured runs dir, so it keeps exit 1
    const stream = harness();
    await createFatalExit(stream.deps)(Object.assign(new Error('disk'), { code: 'ENOSPC' }));
    expect(stream.exitCodes).toEqual([1]);
  });

  /**
   * TUI-DESIGN-4 §7.4 (review finding 3): the first pass labelled EVERY error carrying a string `path` as
   * `op: 'runs-dir'`, which broke three rows at once. One case per branch.
   */
  it('the op is derived from the path: config, run-dir, runs-dir — and anything else stays unclassified at exit 1', async () => {
    const places = (): { runsDir: string; runDir: string; configPath: string } => ({ runsDir: '/tmp/runs', runDir: '/tmp/runs/r1', configPath: '/home/u/.config/jevcode/config.json' });
    // (a) §7.4 row 4: an EACCES on the CONFIG FILE is `cannot read <path>` with `chmod u+r`, never a runs-dir line
    const cfg = harness({ places });
    await createFatalExit(cfg.deps)(errno('EACCES', '/home/u/.config/jevcode/config.json', 'open'));
    const cfgErr = cfg.written.filter((w) => w.fd === 2).map((w) => w.text).join('');
    expect(cfg.exitCodes).toEqual([2]);
    expect(cfgErr).toContain('cannot read /home/u/.config/jevcode/config.json: permission denied');
    expect(cfgErr).toContain('chmod u+r /home/u/.config/jevcode/config.json, or pass --config <path>');
    expect(cfgErr).not.toContain('cannot create the runs directory');

    // (b) §7.4 row 3: a mid-run ENOENT inside the run dir — exit 3, "cannot be resumed"
    const gone = harness({ places });
    await createFatalExit(gone.deps)(errno('ENOENT', '/tmp/runs/r1/state.json', 'open'));
    expect(gone.exitCodes).toEqual([3]);
    expect(gone.written.filter((w) => w.fd === 2).map((w) => w.text).join('')).toContain('disappeared during the run');

    // (c) an unrelated workspace file keeps exit 1 and is NOT relabelled a runs-dir failure
    const ws = harness({ places });
    await createFatalExit(ws.deps)(errno('EACCES', '/work/src/app.ts', 'open'));
    expect(ws.exitCodes).toEqual([1]);
    expect(ws.written.map((w) => w.text).join('')).not.toContain('cannot create the runs directory');

    // (d) a sibling of the runs dir is not inside it
    const sib = harness({ places });
    await createFatalExit(sib.deps)(errno('EACCES', '/tmp/runs2/x', 'open'));
    expect(sib.exitCodes).toEqual([1]);
  });

  /** TUI-DESIGN-4 §7.4 edge 2: the path in the epilogue is `~`-abbreviated through the injected `shorten`. */
  it('the path is `~`-abbreviated against the epilogue context home', async () => {
    const h = harness({ context: () => ({ runId: null, runDir: null, resumable: false, home: '/home/u' }) });
    await createFatalExit(h.deps)(errno('EACCES', '/home/u/.jevcode/runs'));
    const err = h.written.filter((w) => w.fd === 2).map((w) => w.text).join('');
    expect(err).toContain('cannot create the runs directory ~/.jevcode/runs: permission denied');
    expect(err).not.toContain('/home/u/.jevcode/runs');
  });

  /** §7.4 row 5: EMFILE / ENFILE name no path at all and are classified on the code alone. */
  it('EMFILE is `too many open files` with the ulimit fix and exit 2, without a path', async () => {
    const h = harness();
    await createFatalExit(h.deps)(Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }));
    expect(h.exitCodes).toEqual([2]);
    const err = h.written.filter((w) => w.fd === 2).map((w) => w.text).join('');
    expect(err).toContain('too many open files');
    expect(err).toContain('raise the file-descriptor limit (ulimit -n)');
  });

  it('an already-typed error keeps its own exit code (a CheckpointError stays 3)', async () => {
    const h = harness();
    await createFatalExit(h.deps)(new JevCodeError('checkpoint', 'no usable checkpoint', { exitCode: 3 }));
    expect(h.exitCodes).toEqual([3]);
  });

  it('fatalLines appends at most the explanation`s two rows, indented, redacted', () => {
    const err: SerializedError = { name: 'ConfigError', code: 'config', message: 'cannot read /x: permission denied', exitCode: 2 };
    const withFix = fatalLines(err, { runId: null, runDir: null, resumable: false }, redact, {
      explain: { line: 'cannot read /x: permission denied', fix: [`chmod u+r /x/${CANARY}`], code: 'EACCES', exitCode: 2 },
    });
    expect(withFix.at(-1)).toBe('  chmod u+r /x/[REDACTED:test]');
    // no explanation → the epilogue is byte-identical to today's
    expect(fatalLines(err, { runId: null, runDir: null, resumable: false }, redact)).toEqual(fatalLines(err, { runId: null, runDir: null, resumable: false }, redact, { explain: null }));
  });
});
