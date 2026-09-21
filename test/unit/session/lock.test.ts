import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/errors.js';
import { RUN_LOCK_FILE, acquireRunLock, isPidAlive, lockInUseMessage, lockIsLive, parseRunLock, readRunLock, releaseRunLock, type RunLock } from '../../../src/session/lock.js';
import { runId } from './helpers.js';

const ID = runId(1);
const NOW = '2026-09-20T14:02:11.123Z';
const errno = (code: string): Error => Object.assign(new Error(code), { code });

describe('isPidAlive (TUI-DESIGN §8.5)', () => {
  it('kill(pid, 0) success or EPERM = alive; ESRCH or any other failure = dead; invalid pids are dead', () => {
    expect(isPidAlive(4242, () => undefined)).toBe(true);
    expect(
      isPidAlive(4242, () => {
        throw errno('EPERM');
      }),
    ).toBe(true);
    expect(
      isPidAlive(4242, () => {
        throw errno('ESRCH');
      }),
    ).toBe(false);
    expect(
      isPidAlive(4242, () => {
        throw new Error('boom');
      }),
    ).toBe(false);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(isPidAlive(bad, () => undefined)).toBe(false);
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe('parseRunLock / lockIsLive / message', () => {
  it('parses { pid, startedAt, host }; rejects junk', () => {
    expect(parseRunLock('{"pid":4242,"startedAt":"t","host":"mac"}')).toEqual({ pid: 4242, startedAt: 't', host: 'mac' });
    expect(parseRunLock('{"pid":4242}')).toEqual({ pid: 4242, startedAt: '', host: '' });
    for (const junk of ['', 'nope', '[]', '{"pid":"4242"}', '{"pid":0}', '{"pid":-3}', '{"pid":1.5}']) expect(parseRunLock(junk)).toBeNull();
  });

  it('a lock is live only on the same host with a live pid', () => {
    const lock: RunLock = { pid: 4242, startedAt: NOW, host: 'mac' };
    expect(lockIsLive(lock, { host: 'mac', isAlive: () => true })).toBe(true);
    expect(lockIsLive(lock, { host: 'mac', isAlive: () => false })).toBe(false);
    expect(lockIsLive(lock, { host: 'other', isAlive: () => true })).toBe(false);
  });

  it('renders the §24 message verbatim', () => {
    expect(lockInUseMessage(ID, { pid: 4242, startedAt: NOW, host: 'mac' })).toBe(
      `run ${ID} is in use by pid 4242 since ${NOW} (another jevcode?); run 'jevcode sessions unlock ${ID}' if that process is gone`,
    );
  });
});

describe('acquireRunLock / releaseRunLock', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jevcode-lock-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a 0600 JSON lock and releases it', async () => {
    const res = acquireRunLock(dir, { runId: ID, pid: 4242, host: 'mac', nowIso: NOW });
    expect(res).toEqual({ replaced: null });
    const path = join(dir, RUN_LOCK_FILE);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ pid: 4242, startedAt: NOW, host: 'mac' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(readRunLock(dir)).toEqual({ pid: 4242, startedAt: NOW, host: 'mac' });
    expect(releaseRunLock(dir, { pid: 4242 })).toBe(true);
    expect(readRunLock(dir)).toBeNull();
    expect(releaseRunLock(dir)).toBe(false);
  });

  it('a live lock on the same host is a ConfigError (exit 2) with the §24 message', () => {
    acquireRunLock(dir, { runId: ID, pid: 4242, host: 'mac', nowIso: NOW });
    let err: unknown;
    try {
      acquireRunLock(dir, { runId: ID, pid: 5000, host: 'mac', nowIso: NOW, isAlive: () => true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).exitCode).toBe(2);
    expect((err as ConfigError).message).toBe(lockInUseMessage(ID, { pid: 4242, startedAt: NOW, host: 'mac' }));
    // the original lock is untouched
    expect(readRunLock(dir)?.pid).toBe(4242);
  });

  it('a dead pid or another host is replaced with a warning', () => {
    acquireRunLock(dir, { runId: ID, pid: 4242, host: 'mac', nowIso: NOW });
    const warnings: string[] = [];
    const dead = acquireRunLock(dir, { runId: ID, pid: 5000, host: 'mac', nowIso: '2026-09-20T15:00:00.000Z', isAlive: () => false, warn: (m) => warnings.push(m) });
    expect(dead.replaced).toEqual({ pid: 4242, startedAt: NOW, host: 'mac' });
    expect(warnings[0]).toMatch(/replaced a stale run\.lock from pid 4242 is gone/);
    expect(readRunLock(dir)).toEqual({ pid: 5000, startedAt: '2026-09-20T15:00:00.000Z', host: 'mac' });
    const other = acquireRunLock(dir, { runId: ID, pid: 6000, host: 'laptop', nowIso: NOW, isAlive: () => true, warn: (m) => warnings.push(m) });
    expect(other.replaced?.pid).toBe(5000);
    expect(warnings[1]).toMatch(/another host \(mac\)/);
  });

  it('two acquirers racing on an empty run dir: exactly one holds the lock, the loser gets the §24 ConfigError and touches nothing', async () => {
    // both processes read "no lock" in the same tick (the stubbed initial read); O_EXCL decides who wins
    const raceRead = (): RunLock | null => null;
    const first = acquireRunLock(dir, { runId: ID, pid: 4242, host: 'mac', nowIso: NOW, isAlive: () => true, readLock: raceRead });
    expect(first).toEqual({ replaced: null });
    const path = join(dir, RUN_LOCK_FILE);
    const before = await stat(path);
    const content = await readFile(path, 'utf8');
    let err: unknown;
    try {
      acquireRunLock(dir, { runId: ID, pid: 5000, host: 'mac', nowIso: '2026-09-20T15:00:00.000Z', isAlive: () => true, readLock: raceRead });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).exitCode).toBe(2);
    expect((err as ConfigError).message).toBe(lockInUseMessage(ID, { pid: 4242, startedAt: NOW, host: 'mac' }));
    const after = await stat(path);
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    // the loser left no temp file behind
    expect(await readdir(dir)).toEqual([RUN_LOCK_FILE]);
    // a stale lock that appears in the window is replaced atomically (the winner died): the swap goes through rename
    const replaced = acquireRunLock(dir, { runId: ID, pid: 6000, host: 'mac', nowIso: NOW, isAlive: () => false, readLock: raceRead });
    expect(replaced.replaced?.pid).toBe(4242);
    expect(readRunLock(dir)?.pid).toBe(6000);
    expect((await stat(path)).ino).not.toBe(before.ino);
    expect(await readdir(dir)).toEqual([RUN_LOCK_FILE]);
  });

  it('re-acquiring our own lock is silent; a malformed lock never blocks; release with a foreign pid keeps the file', async () => {
    acquireRunLock(dir, { runId: ID, pid: 4242, host: 'mac', nowIso: NOW });
    const warnings: string[] = [];
    expect(acquireRunLock(dir, { runId: ID, pid: 4242, host: 'mac', nowIso: NOW, isAlive: () => true, warn: (m) => warnings.push(m) })).toEqual({ replaced: null });
    expect(warnings).toEqual([]);
    expect(releaseRunLock(dir, { pid: 9999 })).toBe(false);
    expect(readRunLock(dir)?.pid).toBe(4242);
    await rm(join(dir, RUN_LOCK_FILE));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, RUN_LOCK_FILE), 'garbage');
    expect(readRunLock(dir)).toBeNull();
    expect(() => acquireRunLock(dir, { runId: ID, pid: 1, host: 'mac', nowIso: NOW, isAlive: () => true })).not.toThrow();
    expect(readRunLock(dir)).toEqual({ pid: 1, startedAt: NOW, host: 'mac' });
    expect(await readdir(dir)).toEqual([RUN_LOCK_FILE]);
    expect(readRunLock(join(dir, 'missing'))).toBeNull();
    expect(releaseRunLock(join(dir, 'missing'))).toBe(false);
  });
});
