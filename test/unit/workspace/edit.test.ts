import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EditError, JevCodeError } from '../../../src/errors.js';
import { applyEditFile, applyEditToContent, countOccurrences } from '../../../src/workspace/edit.js';
import { tempWs } from './helpers.js';
import type { TempWs } from './helpers.js';

let temps: TempWs[] = [];
afterEach(() => {
  for (const t of temps) t.cleanup();
  temps = [];
});

describe('applyEditToContent', () => {
  it('replaces exactly one occurrence', () => {
    expect(applyEditToContent('a b c', { path: 'f', old: 'b', new: 'X' })).toBe('a X c');
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('abc', '')).toBe(0);
  });

  it('no match -> EditError(matches 0)', () => {
    let err: unknown;
    try {
      applyEditToContent('a b c', { path: 'src/f.py', old: 'zzz', new: 'X' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EditError);
    expect((err as EditError).matches).toBe(0);
    expect((err as EditError).path).toBe('src/f.py');
    expect((err as EditError).message).toContain('no match');
  });

  it('two matches -> EditError(matches 2)', () => {
    let err: unknown;
    try {
      applyEditToContent('x = 1\nx = 1\n', { path: 'f', old: 'x = 1', new: 'x = 2' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EditError);
    expect((err as EditError).matches).toBe(2);
    expect((err as EditError).message).toContain('2 matches');
  });

  it('empty old text is refused', () => {
    expect(() => applyEditToContent('abc', { path: 'f', old: '', new: 'x' })).toThrow(JevCodeError);
  });
});

describe('applyEditFile', () => {
  it('writes atomically (no temp file left) and preserves the mode', async () => {
    const t = tempWs();
    temps.push(t);
    const abs = join(t.ws, 'run.sh');
    writeFileSync(abs, '#!/bin/sh\necho one\n');
    chmodSync(abs, 0o755);
    await applyEditFile(abs, { path: 'run.sh', old: 'echo one', new: 'echo two' });
    expect(readFileSync(abs, 'utf8')).toBe('#!/bin/sh\necho two\n');
    expect(statSync(abs).mode & 0o777).toBe(0o755);
    expect(readdirSync(t.ws)).toEqual(['run.sh']);
  });

  it('a failing edit leaves the file untouched', async () => {
    const t = tempWs();
    temps.push(t);
    const abs = join(t.ws, 'a.txt');
    writeFileSync(abs, 'hello\n');
    await expect(applyEditFile(abs, { path: 'a.txt', old: 'nope', new: 'x' })).rejects.toBeInstanceOf(EditError);
    expect(readFileSync(abs, 'utf8')).toBe('hello\n');
    expect(readdirSync(t.ws)).toEqual(['a.txt']);
  });

  it('missing file -> typed edit error, not an fs exception', async () => {
    const t = tempWs();
    temps.push(t);
    await expect(applyEditFile(join(t.ws, 'missing.txt'), { path: 'missing.txt', old: 'a', new: 'b' })).rejects.toMatchObject({ code: 'edit' });
  });
});
