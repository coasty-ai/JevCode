/** contract 1.1 (TUI-DESIGN §15 item 19, §17): VERSION is package.json's version under tsx/vitest (no esbuild define) and never empty. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../../../src/version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('VERSION', () => {
  it('equals the version in package.json when the build-time define is absent', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
  it('is a non-empty semver-shaped string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
