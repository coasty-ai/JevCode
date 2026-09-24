import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../../src/errors.js';
import { RUN_LOCK_FILE, SAME_BOOT_TOLERANCE_MS, acquireRunLock, bootAtNow, isPidAlive, lockInUseMessage, lockIsLive, lockReplaceVerdict, parseRunLock, readRunLock, releaseRunLock, sameBoot, type RunLock } from '../../../src/session/lock.js';
import { runId } from './helpers.js';

const ID = runId(1);
const NOW = '2026-09-20T14:02:11.123Z';
/** TUI-DESIGN-5 §2.10: the boot instant the lock records, so `other-boot` and `held` are distinguishable. */
const BOOT = '2026-09-20T09:00:00.000Z';
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
    // TUI-DESIGN-5 §2.10: the lock now also records THIS BOOT, so `sessions unlock` can tell `other-boot` from `held`
    const res = acquireRunLock(dir, { runId: ID, pid: 4242, host: 'mac', nowIso: NOW, bootAt: BOOT });
    expect(res).toEqual({ replaced: null });
    const path = join(dir, RUN_LOCK_FILE);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ pid: 4242, startedAt: NOW, host: 'mac', bootAt: BOOT });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(readRunLock(dir)).toEqual({ pid: 4242, startedAt: NOW, host: 'mac', bootAt: BOOT });
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
    acquireRunLock(dir, { runId: ID, pid: 4242, host: 'mac', nowIso: NOW, bootAt: BOOT });
    const warnings: string[] = [];
    const dead = acquireRunLock(dir, { runId: ID, pid: 5000, host: 'mac', nowIso: '2026-09-20T15:00:00.000Z', bootAt: BOOT, isAlive: () => false, warn: (m) => warnings.push(m) });
    expect(dead.replaced).toEqual({ pid: 4242, startedAt: NOW, host: 'mac', bootAt: BOOT });
    expect(warnings[0]).toMatch(/replaced a stale run\.lock from pid 4242 is gone/);
    expect(readRunLock(dir)).toEqual({ pid: 5000, startedAt: '2026-09-20T15:00:00.000Z', host: 'mac', bootAt: BOOT });
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
    expect(() => acquireRunLock(dir, { runId: ID, pid: 1, host: 'mac', nowIso: NOW, bootAt: BOOT, isAlive: () => true })).not.toThrow();
    expect(readRunLock(dir)).toEqual({ pid: 1, startedAt: NOW, host: 'mac', bootAt: BOOT });
    expect(await readdir(dir)).toEqual([RUN_LOCK_FILE]);
    expect(readRunLock(join(dir, 'missing'))).toBeNull();
    expect(releaseRunLock(join(dir, 'missing'))).toBe(false);
  });
});

/**
 * TUI-DESIGN-5 §2.10 / §12.1 S38a / §14.2 #26: `lockReplaceVerdict`'s six-reason vocabulary. Three of the six
 * were exported constants with no producer before this round, so S38a's `the lock is from another boot — taking
 * it` was unreachable and §2.10's "the CLI must print the same six reasons" did not hold.
 */
describe('lockReplaceVerdict — the six `LockReplace` reasons (§2.10)', () => {
  const BOOT = '2026-09-20T09:00:00.000Z';
  const lock = (patch: Partial<RunLock> = {}): RunLock => ({ pid: 4242, startedAt: NOW, host: 'mac', ...patch });
  const here = { host: 'mac', bootAt: BOOT };

  it('no lock file, a dead pid and another boot are the three REPLACEABLE reasons — none carries a `detail60`', () => {
    expect(lockReplaceVerdict(null, { ...here, isAlive: () => true })).toEqual({ replace: true, reason: 'no-lock' });
    expect(lockReplaceVerdict(lock(), { ...here, isAlive: () => false })).toEqual({ replace: true, reason: 'dead-pid' });
    expect(lockReplaceVerdict(lock({ bootAt: '2026-09-19T09:00:00.000Z' }), { ...here, isAlive: () => true })).toEqual({ replace: true, reason: 'other-boot' });
  });

  it('a peer, an unknown boot and this boot are the three REFUSING reasons — each with a `detail60` ≤ 60 chars', () => {
    const peer = lockReplaceVerdict(lock({ host: 'laptop' }), { ...here, isAlive: () => true });
    expect(peer).toEqual({ replace: false, reason: 'peer-live', detail60: 'pid 4242 is alive on laptop' });
    // a lock written before round 5 has no `bootAt`: the CLI refuses rather than guessing which process this is
    const unknown = lockReplaceVerdict(lock(), { ...here, isAlive: () => true });
    expect(unknown.replace).toBe(false);
    expect(unknown.reason).toBe('boot-unknown');
    const held = lockReplaceVerdict(lock({ bootAt: BOOT }), { ...here, isAlive: () => true });
    expect(held).toEqual({ replace: false, reason: 'held', detail60: 'pid 4242 holds this run on this boot' });
    for (const v of [peer, unknown, held]) expect(v.replace === false ? v.detail60.length : 0).toBeLessThanOrEqual(60);
  });

  it('`sameBoot` tolerates the millisecond drift of two `Date.now() - uptime()` reads, not a real reboot', () => {
    expect(sameBoot(BOOT, BOOT)).toBe(true);
    expect(sameBoot(BOOT, new Date(Date.parse(BOOT) + SAME_BOOT_TOLERANCE_MS - 1).toISOString())).toBe(true);
    expect(sameBoot(BOOT, new Date(Date.parse(BOOT) + SAME_BOOT_TOLERANCE_MS + 1).toISOString())).toBe(false);
    expect(sameBoot('not a date', BOOT)).toBe(false);
    // `bootAtNow` is the same derivation both sides use
    expect(bootAtNow(() => Date.parse('2026-09-20T10:00:00.000Z'), () => 3600)).toBe('2026-09-20T09:00:00.000Z');
    expect(sameBoot(bootAtNow(() => 1_000_000, () => 10), bootAtNow(() => 1_000_020, () => 10))).toBe(true);
  });

  it('a pre-round-5 lock parses with NO `bootAt` key at all (absence is the state, not an empty string)', () => {
    const parsed = parseRunLock(JSON.stringify({ pid: 4242, startedAt: NOW, host: 'mac' }));
    expect(parsed).toEqual({ pid: 4242, startedAt: NOW, host: 'mac' });
    expect(parsed !== null && 'bootAt' in parsed).toBe(false);
    expect(parseRunLock(JSON.stringify({ pid: 4242, startedAt: NOW, host: 'mac', bootAt: '' }))?.bootAt).toBeUndefined();
  });
});
