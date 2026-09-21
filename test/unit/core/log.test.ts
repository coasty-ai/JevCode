/** core/log.ts (TUI-DESIGN §13.6, §10.6; §19.0 row O7): levels; 250 ms buffer; warn+ synchronous; 8 MiB rotation; a key never appears; fallback dir; console.* routed. */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOG_FALLBACK_KEEP,
  LOG_LINE_MAX,
  LOG_MAX_BYTES,
  createLog,
  openLogCount,
  fallbackLogDir,
  fallbackLogPath,
  formatLogLine,
  keyTraceLine,
  logSettingsFromEnv,
  nullLog,
  parseLogLevel,
  pruneFallbackLogs,
  routeConsole,
  runLogPath,
} from '../../../src/core/log.js';
import { createRedactor } from '../../../src/core/redact.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevcode-log-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuv_-x';
const fixedNow = (): Date => new Date('2026-09-20T19:15:06.123Z');

describe('formatLogLine / keyTraceLine (pure)', () => {
  it('formats ISO time, padded level, one-line redacted message, clipped to 512 chars', () => {
    const r = createRedactor([{ name: 'decider.apiKey', value: 'exact-secret-value-1' }]);
    const line = formatLogLine('warn', `jev.retry key=${KEY} other=exact-secret-value-1\nsecond line\ttab`, fixedNow(), r.redact);
    expect(line).toBe('2026-09-20T19:15:06.123Z warn  jev.retry key=[REDACTED:pattern] other=[REDACTED:decider.apiKey] ⏎ second line\ttab\n');
    const long = formatLogLine('info', 'x'.repeat(2000), fixedNow());
    expect(long.length).toBeLessThanOrEqual(LOG_LINE_MAX + 1);
    expect(long.endsWith('…\n')).toBe(true);
    expect(formatLogLine('error', 'a\u0007b\u001b[2Jc', fixedNow())).toBe('2026-09-20T19:15:06.123Z error abc\n');
    expect(formatLogLine('trace', '', new Date(NaN))).toBe('0000-00-00T00:00:00.000Z trace \n');
  });

  it('strips escape sequences and control bytes BEFORE redacting, so a key split by a NUL or a CSI sequence never reaches the file', () => {
    const exact = 'exact-secret-value-1';
    const r = createRedactor([{ name: 'generator.apiKey', value: exact }]);
    const split = (k: string, sep: string): string => `${k.slice(0, 9)}${sep}${k.slice(9)}`;
    for (const sep of ['\u0000', '\u001b[0m', '\u001b[31;1m', '\u001b]0;title\u0007', '\u001bOA', '\u0007', '\u007f']) {
      const line = formatLogLine('info', `out: ${split(exact, sep)} and ${split(KEY, sep)}`, fixedNow(), r.redact);
      expect(line, JSON.stringify(sep)).not.toContain(exact);
      expect(line, JSON.stringify(sep)).not.toContain(KEY);
      for (let i = 0; i + 8 <= exact.length; i += 3) expect(line, JSON.stringify(sep)).not.toContain(exact.slice(i, i + 8));
      expect(line).toContain('[REDACTED:generator.apiKey]');
      expect(line).toContain('[REDACTED:pattern]');
    }
    // clipping happens after redaction: a marker is never split back into key bytes
    const long = formatLogLine('info', `${'x'.repeat(LOG_LINE_MAX - 60)} ${KEY}`, fixedNow(), r.redact);
    expect(long).not.toContain(KEY.slice(0, 12));
  });

  it('keyTraceLine carries the class and length only', () => {
    expect(keyTraceLine('text', 1, false)).toBe('key kind=text len=1 masked=false');
    expect(keyTraceLine('paste', 812, true)).toBe('key kind=paste len=812 masked=true');
    expect(keyTraceLine('ctrl', NaN, false)).toBe('key kind=ctrl len=0 masked=false');
    expect(keyTraceLine('return', -3, false)).toBe('key kind=return len=0 masked=false');
  });

  it('parseLogLevel and logSettingsFromEnv: JEVCODE_TRACE is an alias for JEVCODE_LOG at level trace; flags win', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel(' trace ')).toBe('trace');
    expect(parseLogLevel('loud')).toBeNull();
    expect(parseLogLevel(undefined)).toBeNull();
    expect(logSettingsFromEnv({})).toEqual({ file: null, level: 'info', source: 'default' });
    expect(logSettingsFromEnv({ JEVCODE_TRACE: '/tmp/t.log' })).toEqual({ file: '/tmp/t.log', level: 'trace', source: 'env' });
    expect(logSettingsFromEnv({ JEVCODE_LOG: '/tmp/l.log' })).toEqual({ file: '/tmp/l.log', level: 'info', source: 'env' });
    expect(logSettingsFromEnv({ JEVCODE_LOG: '/tmp/l.log', JEVCODE_TRACE: '/tmp/t.log' })).toEqual({ file: '/tmp/l.log', level: 'trace', source: 'env' });
    expect(logSettingsFromEnv({ JEVCODE_LOG_LEVEL: 'debug' })).toEqual({ file: null, level: 'debug', source: 'env' });
    expect(logSettingsFromEnv({ JEVCODE_LOG_LEVEL: 'warn', JEVCODE_TRACE: '/tmp/t.log' }).level).toBe('warn');
    expect(logSettingsFromEnv({ JEVCODE_LOG_LEVEL: 'warn' }, { verbose: true })).toEqual({ file: null, level: 'debug', source: 'flag' });
    expect(logSettingsFromEnv({ JEVCODE_LOG: '/e' }, { log: '/f', logLevel: 'error' })).toEqual({ file: '/f', level: 'error', source: 'flag' });
    expect(runLogPath('/runs/x')).toBe('/runs/x/jevcode.log');
    expect(fallbackLogDir('/home/u')).toBe('/home/u/.jevcode/logs');
    expect(fallbackLogPath('/home/u/.jevcode/logs', 4242, fixedNow())).toBe('/home/u/.jevcode/logs/jevcode-4242-20260920-191506.log');
  });
});

describe('createLog', () => {
  it('writes warn+ synchronously, respects the level, and never writes above it', () => {
    const file = join(dir, 'run', 'jevcode.log');
    const log = createLog({ file, level: 'info', now: fixedNow, exitHook: false });
    expect(log.file).toBe(file);
    expect(log.fellBack).toBe(false);
    log.warn('w1');
    log.error('e1');
    log.debug('d1');
    log.trace('t1');
    const text = readFileSync(file, 'utf8');
    expect(text).toBe('2026-09-20T19:15:06.123Z warn  w1\n2026-09-20T19:15:06.123Z error e1\n');
    expect(log.enabled('info')).toBe(true);
    expect(log.enabled('debug')).toBe(false);
    log.close();
    log.warn('after close');
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('buffers info− for 250 ms and flushes on the timer, on flush() and before a warn+ line (order kept)', () => {
    vi.useFakeTimers();
    const file = join(dir, 'jevcode.log');
    const log = createLog({ file, level: 'trace', now: fixedNow, exitHook: false });
    log.info('i1');
    log.debug('d1');
    expect(readFileSync(file, 'utf8')).toBe('');
    vi.advanceTimersByTime(249);
    expect(readFileSync(file, 'utf8')).toBe('');
    vi.advanceTimersByTime(1);
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    log.info('i2');
    log.warn('w1');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines.map((l) => l.slice(25))).toEqual(['info  i1', 'debug d1', 'info  i2', 'warn  w1']);
    log.trace('t1');
    log.flush();
    expect(readFileSync(file, 'utf8')).toContain('trace t1');
    log.close();
  });

  it('a key never appears: every line passes redact; key() and paste() log classes and lengths only', () => {
    const file = join(dir, 'jevcode.log');
    const r = createRedactor([{ name: 'generator.apiKey', value: 'exact-secret-value-1' }]);
    const log = createLog({ file, level: 'trace', redact: r.redact, now: fixedNow, exitHook: false });
    log.info(`request ${KEY} exact-secret-value-1`);
    log.key('text', KEY.length, true);
    log.key('paste', 108, false);
    log.paste(812);
    log.trace(`tui.useInput input=${JSON.stringify(KEY)}`);
    log.flush();
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('exact-secret-value-1');
    expect(text).toContain('[REDACTED:pattern]');
    expect(text).toContain('[REDACTED:generator.apiKey]');
    expect(text).toContain(`key kind=text len=${KEY.length} masked=true`);
    expect(text).toContain('key kind=paste len=108 masked=false');
    expect(text).toContain('paste len=812');
    log.close();
  });

  it('rotates once at the cap: the old file becomes .1 and writing continues', () => {
    const file = join(dir, 'jevcode.log');
    const log = createLog({ file, level: 'info', now: fixedNow, exitHook: false, maxBytes: 4096 });
    const msg = 'x'.repeat(300);
    for (let i = 0; i < 20; i++) log.warn(msg);
    log.flush();
    expect(existsSync(`${file}.1`)).toBe(true);
    const main = statSync(file).size;
    const rotated = statSync(`${file}.1`).size;
    expect(main).toBeLessThanOrEqual(4096);
    expect(rotated).toBeLessThanOrEqual(4096);
    expect(main + rotated).toBeGreaterThan(4096);
    for (let i = 0; i < 20; i++) log.warn(msg);
    expect(statSync(file).size).toBeLessThanOrEqual(4096);
    expect(LOG_MAX_BYTES).toBe(8 * 1024 * 1024);
    log.close();
  });

  it('falls back to ~/.jevcode/logs when the target is unwritable and prunes to the newest 10', () => {
    const fallback = join(dir, 'home', '.jevcode', 'logs');
    mkdirSync(fallback, { recursive: true });
    for (let i = 0; i < 12; i++) {
      const p = join(fallback, `jevcode-${1000 + i}-20260920-1900${String(i).padStart(2, '0')}.log`);
      writeFileSync(p, 'old\n');
      const t = new Date(2020, 0, 1, 12, 0, i);
      utimesSync(p, t, t);
    }
    writeFileSync(join(fallback, 'keep-me.txt'), 'not a log');
    const unwritable = join(dir, 'file-not-dir');
    writeFileSync(unwritable, 'x');
    const log = createLog({ file: join(unwritable, 'jevcode.log'), fallbackDir: fallback, now: fixedNow, pid: 4242, exitHook: false });
    expect(log.fellBack).toBe(true);
    expect(log.file).toBe(join(fallback, 'jevcode-4242-20260920-191506.log'));
    log.warn('hello');
    expect(readFileSync(log.file, 'utf8')).toContain('warn  hello');
    const logs = readdirSync(fallback).filter((n) => n.startsWith('jevcode-'));
    expect(logs).toHaveLength(LOG_FALLBACK_KEEP);
    expect(logs).toContain('jevcode-4242-20260920-191506.log');
    expect(existsSync(join(fallback, 'keep-me.txt'))).toBe(true);
    expect(existsSync(join(fallback, 'jevcode-1000-20260920-190000.log'))).toBe(false);
    expect(existsSync(join(fallback, 'jevcode-1002-20260920-190002.log'))).toBe(false);
    expect(existsSync(join(fallback, 'jevcode-1003-20260920-190003.log'))).toBe(true);
    log.close();
  });

  it('with no fallback an unwritable target disables the log without throwing; a null file is a null log', () => {
    const log = createLog({ file: join(dir, 'nope-file', 'x', 'jevcode.log'), exitHook: false, fs: { ...realFs(), mkdirSync: () => { throw new Error('EACCES'); } } });
    expect(log.enabled('error')).toBe(false);
    expect(() => log.error('x')).not.toThrow();
    const n = nullLog();
    expect(n.enabled('error')).toBe(false);
    expect(() => {
      n.error('x');
      n.flush();
      n.close();
    }).not.toThrow();
  });

  it('swallows write failures (a failing appendFileSync never throws out of the log)', () => {
    let calls = 0;
    const fs = realFs();
    const log = createLog({
      file: join(dir, 'jevcode.log'),
      exitHook: false,
      fs: {
        ...fs,
        appendFileSync: (p, d) => {
          calls++;
          if (calls > 1) throw new Error('ENOSPC');
          fs.appendFileSync(p, d);
        },
      },
    });
    expect(() => {
      log.error('one');
      log.error('two');
    }).not.toThrow();
  });

  it('registers and removes the exit hook so buffered lines are flushed synchronously on exit', () => {
    const file = join(dir, 'jevcode.log');
    const before = process.listenerCount('exit');
    const log = createLog({ file, level: 'info', now: fixedNow });
    expect(process.listenerCount('exit')).toBe(before + 1);
    log.info('buffered');
    const hooks = process.listeners('exit');
    const mine = hooks[hooks.length - 1] as (code: number) => void;
    mine(0);
    expect(readFileSync(file, 'utf8')).toContain('info  buffered');
    log.close();
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('12 logs opened without close() share one exit listener (no MaxListenersExceededWarning); the hook flushes every open log', () => {
    const before = process.listenerCount('exit');
    const baseOpen = openLogCount();
    const warnings: string[] = [];
    const onWarning = (w: Error): void => {
      warnings.push(w.name);
    };
    process.on('warning', onWarning);
    const logs = Array.from({ length: 12 }, (_, i) => createLog({ file: join(dir, `run-${i}`, 'jevcode.log'), level: 'info', now: fixedNow }));
    try {
      expect(process.listenerCount('exit')).toBe(before + 1);
      expect(openLogCount()).toBe(baseOpen + 12);
      for (const [i, log] of logs.entries()) log.info(`buffered-${i}`);
      const hooks = process.listeners('exit');
      (hooks[hooks.length - 1] as (code: number) => void)(0);
      for (const [i, log] of logs.entries()) expect(readFileSync(log.file, 'utf8')).toContain(`info  buffered-${i}`);
      logs.slice(0, 11).forEach((l) => l.close());
      expect(process.listenerCount('exit')).toBe(before + 1);
      logs[11]!.close();
      expect(process.listenerCount('exit')).toBe(before);
      expect(openLogCount()).toBe(baseOpen);
      expect(warnings.filter((w) => w === 'MaxListenersExceededWarning')).toEqual([]);
    } finally {
      process.removeListener('warning', onWarning);
      for (const l of logs) l.close();
    }
  });

  it('both the target and the fallback dir unwritable (EACCES): enabled() is false and nothing throws', () => {
    const fs = realFs();
    const log = createLog({
      file: join(dir, 'ro', 'jevcode.log'),
      fallbackDir: join(dir, 'ro-fallback'),
      exitHook: false,
      fs: {
        ...fs,
        mkdirSync: () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        },
      },
    });
    expect(log.enabled('error')).toBe(false);
    expect(log.fellBack).toBe(false);
    expect(() => {
      log.error('x');
      log.key('text', 1);
      log.flush();
      log.close();
    }).not.toThrow();
    expect(existsSync(join(dir, 'ro'))).toBe(false);
  });

  it('JEVCODE_LOG pointing at a file whose parent is a file falls back (ENOTDIR), or disables the log without a fallback dir', () => {
    const parentFile = join(dir, 'a-file');
    writeFileSync(parentFile, 'not a dir');
    const { file } = logSettingsFromEnv({ JEVCODE_LOG: join(parentFile, 'jevcode.log') });
    expect(file).toBe(join(parentFile, 'jevcode.log'));
    const fallback = join(dir, 'home', '.jevcode', 'logs');
    const log = createLog({ file, fallbackDir: fallback, now: fixedNow, pid: 7, exitHook: false });
    expect(log.fellBack).toBe(true);
    expect(log.file).toBe(join(fallback, 'jevcode-7-20260920-191506.log'));
    log.warn('ok');
    expect(readFileSync(log.file, 'utf8')).toContain('warn  ok');
    log.close();
    const none = createLog({ file, now: fixedNow, exitHook: false });
    expect(none.enabled('error')).toBe(false);
    expect(() => none.error('x')).not.toThrow();
    expect(readFileSync(parentFile, 'utf8')).toBe('not a dir');
  });

  it('routeConsole sends console.* to the log at the mapped levels and restores afterwards', () => {
    const file = join(dir, 'jevcode.log');
    const log = createLog({ file, level: 'trace', now: fixedNow, exitHook: false });
    const fake = { log: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() } as unknown as Console;
    const original = { ...fake };
    const restore = routeConsole(log, fake);
    fake.log('a', 1, { b: 2 });
    fake.warn(new Error('boom'));
    fake.error(KEY);
    restore();
    log.flush();
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('info  console.log a 1 {"b":2}');
    expect(text).toContain('warn  console.warn Error: boom');
    expect(text).toContain('error console.error [REDACTED:pattern]');
    expect(text).not.toContain(KEY);
    expect(fake.log).toBe(original.log);
    expect(fake.warn).toBe(original.warn);
    log.close();
  });

  it('pruneFallbackLogs tolerates a missing directory', () => {
    expect(pruneFallbackLogs(join(dir, 'missing'))).toBe(0);
  });
});

function realFs(): NonNullable<Parameters<typeof createLog>[0]['fs']> {
  return {
    appendFileSync: (p, d) => writeFileSync(p, d, { flag: 'a' }),
    writeFileSync: (p, d) => writeFileSync(p, d),
    mkdirSync: (p, o) => {
      mkdirSync(p, o);
    },
    statSync: (p) => {
      const st = statSync(p);
      return { size: st.size, mtimeMs: st.mtimeMs };
    },
    renameSync: () => undefined,
    unlinkSync: () => undefined,
    readdirSync: (p) => readdirSync(p),
  };
}
