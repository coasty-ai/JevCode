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

  it('a Latin-1 file is refused, and its bytes stay exactly as they were (a one-line edit used to turn every accented byte into EF BF BD)', async () => {
    const t = tempWs();
    temps.push(t);
    const abs = join(t.ws, 'legacy.py');
    const bytes = Buffer.from('# caf\xe9 cr\xe8me\nx = 1\nname = "na\xefve \xfcber"\n', 'latin1');
    writeFileSync(abs, bytes);
    const err = await applyEditFile(abs, { path: 'legacy.py', old: 'x = 1', new: 'x = 2' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JevCodeError);
    expect(err).toMatchObject({ code: 'edit', message: 'EditError: legacy.py is not UTF-8 text (probably Latin-1/Windows-1252); editing it would corrupt it — use a byte-safe command (e.g. iconv to convert it first)' });
    expect(readFileSync(abs).equals(bytes)).toBe(true);
    expect(readdirSync(t.ws)).toEqual(['legacy.py']);
  });

  it('a UTF-16 or binary file is refused untouched; a UTF-8 file with accents and a BOM is edited byte-exactly elsewhere', async () => {
    const t = tempWs();
    temps.push(t);
    const wide = join(t.ws, 'wide.txt');
    const wideBytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('x = 1\n', 'utf16le')]);
    writeFileSync(wide, wideBytes);
    await expect(applyEditFile(wide, { path: 'wide.txt', old: 'x', new: 'y' })).rejects.toThrow(/^EditError: wide\.txt is UTF-16 text/);
    expect(readFileSync(wide).equals(wideBytes)).toBe(true);
    const bin = join(t.ws, 'blob.bin');
    writeFileSync(bin, Buffer.from([0x61, 0x00, 0x62]));
    await expect(applyEditFile(bin, { path: 'blob.bin', old: 'a', new: 'c' })).rejects.toThrow('EditError: blob.bin is binary');
    const utf8 = join(t.ws, 'ok.py');
    writeFileSync(utf8, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# café\nx = 1\n', 'utf8')]));
    await applyEditFile(utf8, { path: 'ok.py', old: 'x = 1', new: 'x = 2' });
    expect(readFileSync(utf8).equals(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# café\nx = 2\n', 'utf8')]))).toBe(true);
  });

  it('missing file -> typed edit error, not an fs exception', async () => {
    const t = tempWs();
    temps.push(t);
    await expect(applyEditFile(join(t.ws, 'missing.txt'), { path: 'missing.txt', old: 'a', new: 'b' })).rejects.toMatchObject({ code: 'edit' });
  });
});
