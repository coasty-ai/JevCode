import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { TestCommand } from '../../../src/core/types.js';
import { detectTestCommand, parseCargo, parseGo, parseJest, parsePytest, parseTestOutput, parseVitest } from '../../../src/workspace/tests.js';
import type { ManifestReader } from '../../../src/workspace/tests.js';
import { FIXTURES } from './helpers.js';

const out = (name: string): string => readFileSync(join(FIXTURES, 'test-output', name), 'utf8');

function readerFor(dir: string): ManifestReader {
  return {
    async read(rel) {
      try {
        return readFileSync(join(dir, rel), 'utf8');
      } catch {
        return null;
      }
    },
    async list(rel) {
      try {
        return readdirSync(join(dir, rel));
      } catch {
        return null;
      }
    },
  };
}

describe('parsers from fixtures', () => {
  it('pytest mixed summary', () => {
    expect(parsePytest(out('pytest-mixed.txt'))).toEqual({ passed: 4, failed: 1, errors: 1, skipped: 1 });
    expect(parsePytest(out('pytest-pass.txt'))).toEqual({ passed: 5, failed: 0, errors: 0, skipped: 0 });
    expect(parsePytest(out('pytest-none.txt'))).toEqual({ passed: 0, failed: 0, errors: 0, skipped: 0 });
    expect(parsePytest('nothing here')).toBeNull();
    expect(parsePytest('===== 2 passed, 3 warnings in 1.00s (0:00:01) =====')).toEqual({ passed: 2, failed: 0, errors: 0, skipped: 0 });
  });

  it('jest / vitest / cargo / go', () => {
    expect(parseJest(out('jest.txt'))).toEqual({ passed: 7, failed: 1, errors: 0, skipped: 2 });
    expect(parseVitest(out('vitest.txt'))).toEqual({ passed: 3, failed: 1, errors: 0, skipped: 1 });
    expect(parseVitest(out('vitest-pass.txt'))).toEqual({ passed: 3, failed: 0, errors: 0, skipped: 0 });
    expect(parseCargo(out('cargo.txt'))).toEqual({ passed: 3, failed: 1, errors: 0, skipped: 1 });
    expect(parseGo(out('go.txt'))).toEqual({ passed: 1, failed: 1, errors: 0, skipped: 1 });
    expect(parseJest(out('vitest.txt'))).toBeNull();
  });

  it('parseTestOutput dispatches by runner, reads the tail, and falls back for npm/unknown', () => {
    const flood = 'x'.repeat(100_000) + '\n' + out('pytest-pass.txt');
    expect(parseTestOutput('pytest', flood)).toEqual({ passed: 5, failed: 0, errors: 0, skipped: 0 });
    expect(parseTestOutput('npm', out('jest.txt'))?.passed).toBe(7);
    expect(parseTestOutput('npm', out('vitest.txt'))?.passed).toBe(3);
    expect(parseTestOutput('unknown', out('cargo.txt'))?.failed).toBe(1);
    expect(parseTestOutput('jest', out('vitest.txt'))?.passed).toBe(3);
    expect(parseTestOutput('go', out('go.txt'))?.skipped).toBe(1);
    expect(parseTestOutput('pytest', '')).toBeNull();
    expect(parseTestOutput('cargo', out('pytest-pass.txt'))).toBeNull();
    // the last summary wins when a run prints several
    expect(parseTestOutput('pytest', '1 passed in 0.1s\n\n2 failed in 0.2s\n')).toEqual({ passed: 0, failed: 2, errors: 0, skipped: 0 });
  });
});

describe('detectTestCommand from manifests', () => {
  const cases: [string, TestCommand | null][] = [
    ['pytest-ini', { command: 'pytest -q', runner: 'pytest' }],
    ['pyproject', { command: 'pytest -q', runner: 'pytest' }],
    ['setup-cfg', { command: 'pytest -q', runner: 'pytest' }],
    ['tox', { command: 'pytest -q', runner: 'pytest' }],
    ['tests-dir', { command: 'pytest -q', runner: 'pytest' }],
    ['npm-jest', { command: 'npm test', runner: 'jest' }],
    ['npm-vitest', { command: 'npm test', runner: 'vitest' }],
    ['npm-plain', { command: 'npm test', runner: 'npm' }],
    ['npm-placeholder', null],
    ['cargo', { command: 'cargo test', runner: 'cargo' }],
    ['go', { command: 'go test ./...', runner: 'go' }],
    ['none', null],
  ];
  for (const [dir, expected] of cases) {
    it(dir, async () => {
      expect(await detectTestCommand(readerFor(join(FIXTURES, 'manifests', dir)))).toEqual(expected);
    });
  }
});
