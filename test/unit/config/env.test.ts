import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_DOTENV_BYTES, parseDotenvText, readDotenv } from '../../../src/config/env.js';
import { ConfigError } from '../../../src/errors.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jevcode-env-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readDotenv', () => {
  it('parses comments, quotes and empty values into an isolated map without touching process.env', async () => {
    const p = join(dir, '.env');
    await writeFile(p, '# c\nA=1\nB="two words"\nC=\nexport D=\'single\'\nE=with=equals\n');
    const before = { ...process.env };
    const loaded = await readDotenv(p);
    expect(loaded?.path).toBe(p);
    expect([...loaded!.vars]).toEqual([
      ['A', '1'],
      ['B', 'two words'],
      ['C', ''],
      ['D', 'single'],
      ['E', 'with=equals'],
    ]);
    expect(process.env).toEqual(before);
  });

  it('returns null for a missing file or a directory', async () => {
    expect(await readDotenv(join(dir, 'nope'))).toBeNull();
    await mkdir(join(dir, 'asdir'));
    expect(await readDotenv(join(dir, 'asdir'))).toBeNull();
    expect(await readDotenv(join(dir, 'asdir', 'x', '.env'))).toBeNull();
  });

  it('refuses an oversized file with a ConfigError naming the path', async () => {
    const p = join(dir, '.env');
    await writeFile(p, `BIG=${'x'.repeat(MAX_DOTENV_BYTES + 1)}\n`);
    await expect(readDotenv(p)).rejects.toBeInstanceOf(ConfigError);
    await expect(readDotenv(p)).rejects.toThrow(p);
  });

  it('parseDotenvText handles an empty document', () => {
    expect(parseDotenvText('').size).toBe(0);
  });
});
