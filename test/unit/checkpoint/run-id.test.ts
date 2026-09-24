import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CheckpointError, ConfigError, JevCodeError } from '../../../src/errors.js';
import { createRunDir, encodeBase32, isValidRunId, newRunId, resolveRunDir, RUN_ID_RE } from '../../../src/checkpoint/run-id.js';
import { withTempDir } from '../../fixtures/checkpoint/make.js';

const ZERO = (): Uint8Array => new Uint8Array([0, 0, 0, 0, 0]);
const ONES = (): Uint8Array => new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]);

/** Returns the queued byte arrays in order, then repeats the last one. */
function sequence(...bufs: Uint8Array[]): () => Uint8Array {
  let i = 0;
  return () => bufs[Math.min(i++, bufs.length - 1)]!;
}

describe('newRunId', () => {
  it('formats YYYYMMDD-HHMMSS-<8 base32> in UTC', () => {
    const id = newRunId(new Date('2026-09-19T23:59:58.999Z'), ZERO);
    expect(id).toBe('20260919-235958-aaaaaaaa');
    expect(RUN_ID_RE.test(id)).toBe(true);
  });

  it('uses UTC regardless of local offset (midnight rollover)', () => {
    // 2026-01-01T00:00:00Z is still 2025-12-31 in every western timezone
    expect(newRunId(new Date('2026-01-01T00:00:00Z'), ZERO).slice(0, 15)).toBe('20260101-000000');
  });

  it('encodes 5 random bytes as 8 lowercase a-z2-7 chars', () => {
    expect(encodeBase32(ONES(), 8)).toBe('77777777');
    // 00000 00001 00010 ... 00111 -> the first eight alphabet letters
    expect(encodeBase32(new Uint8Array([0x00, 0x44, 0x32, 0x14, 0xc7]), 8)).toBe('abcdefgh');
    const id = newRunId(new Date('2026-09-19T12:00:00Z'), ONES);
    expect(id.endsWith('-77777777')).toBe(true);
  });

  it('uses the crypto default when no random source is passed', () => {
    const a = newRunId(new Date('2026-09-19T12:00:00Z'));
    const b = newRunId(new Date('2026-09-19T12:00:00Z'));
    expect(isValidRunId(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('rejects a short random source and an invalid date', () => {
    expect(() => newRunId(new Date('2026-09-19T12:00:00Z'), () => new Uint8Array(3))).toThrow(JevCodeError);
    expect(() => newRunId(new Date('nope'), ZERO)).toThrow(JevCodeError);
  });
});

describe('isValidRunId', () => {
  it.each([
    // DESIGN.md §9's example `k7q2m9xa` contains a 9, which the a-z2-7 alphabet excludes
    ['20260919-142301-k7q2m6xa', true],
    ['20260919-142301-aaaaaaaa', true],
    ['20260919-142301-K7Q2M9XA', false], // uppercase
    ['20260919-142301-k7q2m9x1', false], // 1 is not in the alphabet
    ['20260919-142301-k7q2m9x', false], // 7 chars
    ['20260919-14230-k7q2m9xa', false],
    ['../20260919-142301-k7q2m9xa', false],
    ['20260919-142301-k7q2m9xa/..', false],
    ['', false],
  ])('%s -> %s', (id, ok) => {
    expect(isValidRunId(id)).toBe(ok);
  });
});

describe('createRunDir', () => {
  it('creates runsDir recursively and the run dir non-recursively', () =>
    withTempDir(async (tmp) => {
      const runsDir = join(tmp, 'nested', 'runs');
      const { runId, runDir } = await createRunDir(runsDir, new Date('2026-09-19T12:00:00Z'), ZERO);
      expect(runId).toBe('20260919-120000-aaaaaaaa');
      expect(runDir).toBe(await realpath(join(runsDir, runId)));
      await expect(realpath(runDir)).resolves.toBeTruthy();
    }));

  it('regenerates the suffix on EEXIST', () =>
    withTempDir(async (tmp) => {
      await mkdir(join(tmp, '20260919-120000-aaaaaaaa'));
      const rnd = sequence(ZERO(), ZERO(), ONES());
      const { runId } = await createRunDir(tmp, new Date('2026-09-19T12:00:00Z'), rnd);
      expect(runId).toBe('20260919-120000-77777777');
    }));

  it('gives up with CheckpointError after bounded attempts', () =>
    withTempDir(async (tmp) => {
      await mkdir(join(tmp, '20260919-120000-aaaaaaaa'));
      let calls = 0;
      const rnd = (): Uint8Array => {
        calls++;
        return ZERO();
      };
      await expect(createRunDir(tmp, new Date('2026-09-19T12:00:00Z'), rnd)).rejects.toBeInstanceOf(CheckpointError);
      expect(calls).toBeLessThanOrEqual(16);
    }));
});

describe('resolveRunDir', () => {
  it('returns the realpath of an existing run dir (runsDir itself may be a symlink)', () =>
    withTempDir(async (tmp) => {
      const runsDir = join(tmp, 'runs');
      const { runId, runDir } = await createRunDir(runsDir, new Date('2026-09-19T12:00:00Z'), ZERO);
      expect(await resolveRunDir(runsDir, runId)).toBe(await realpath(runDir));
    }));

  it('rejects a malformed id with ConfigError (exit 2) before touching the filesystem', async () => {
    const err = await resolveRunDir('/nonexistent/runs', '../etc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).exitCode).toBe(2);
    expect((err as ConfigError).setting).toBe('resume');
  });

  it('rejects a valid id whose directory is missing with CheckpointError (exit 3)', () =>
    withTempDir(async (tmp) => {
      const err = await resolveRunDir(tmp, '20260919-120000-aaaaaaaa').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CheckpointError);
      expect((err as CheckpointError).exitCode).toBe(3);
    }));

  it('rejects a missing runsDir with CheckpointError', () =>
    withTempDir(async (tmp) => {
      await expect(resolveRunDir(join(tmp, 'absent'), '20260919-120000-aaaaaaaa')).rejects.toBeInstanceOf(CheckpointError);
    }));

  it('rejects a valid id that is a symlink pointing outside runsDir with ConfigError', () =>
    withTempDir(async (tmp) => {
      const runsDir = join(tmp, 'runs');
      const outside = join(tmp, 'outside');
      await mkdir(runsDir);
      await mkdir(outside);
      await symlink(outside, join(runsDir, '20260919-120000-aaaaaaaa'));
      const err = await resolveRunDir(runsDir, '20260919-120000-aaaaaaaa').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).exitCode).toBe(2);
    }));

  it('rejects a valid id that is a regular file', () =>
    withTempDir(async (tmp) => {
      await writeFile(join(tmp, '20260919-120000-aaaaaaaa'), 'x');
      await expect(resolveRunDir(tmp, '20260919-120000-aaaaaaaa')).rejects.toBeInstanceOf(CheckpointError);
    }));
});
