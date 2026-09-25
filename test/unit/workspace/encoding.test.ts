/**
 * The text-encoding classification the file tools refuse on (src/workspace/encoding.ts): a Latin-1 file edited through a
 * UTF-8 decoder turned every accented byte into EF BF BD, and a UTF-16 file read as "binary".
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fileTextEncoding, notUtf8Refusal, textEncodingOf, utf16Refusal } from '../../../src/workspace/encoding.js';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('textEncodingOf', () => {
  it.each([
    ['ASCII', Buffer.from('x = 1\n'), 'utf8'],
    ['UTF-8 with accents', Buffer.from('café naïve ✓\n', 'utf8'), 'utf8'],
    ['UTF-8 with a byte-order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\n')]), 'utf8'],
    ['empty', Buffer.alloc(0), 'utf8'],
    ['Latin-1', Buffer.from('caf\xe9\n', 'latin1'), 'not-utf8'],
    ['Windows-1252 smart quotes', Buffer.from([0x93, 0x68, 0x69, 0x94, 0x0a]), 'not-utf8'],
    ['UTF-16 LE with a BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]), 'utf16'],
    ['UTF-16 BE with a BOM', Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]), 'utf16'],
    ['a NUL byte', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), 'binary'],
    ['UTF-16 without a BOM (NULs)', Buffer.from('hi', 'utf16le'), 'binary'],
  ] as const)('%s → %s', (_name, bytes, expected) => {
    expect(textEncodingOf(bytes)).toBe(expected);
  });

  it('a multi-byte sequence cut at the end of a HEAD is not evidence; at the end of a whole file it is', () => {
    const cut = Buffer.from('ab✓', 'utf8').subarray(0, 4); // 'ab' + the first two bytes of the three-byte check mark
    expect(textEncodingOf(cut, true)).toBe('utf8');
    expect(textEncodingOf(cut, false)).toBe('not-utf8');
  });
});

describe('fileTextEncoding', () => {
  it('reads at most maxBytes of the file, and answers null for what it cannot read', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevcode-enc-')));
    temps.push(dir);
    writeFileSync(join(dir, 'latin1.txt'), Buffer.from('caf\xe9\n', 'latin1'));
    // valid UTF-8 whose head (maxBytes) ends inside a multi-byte sequence: still utf8
    writeFileSync(join(dir, 'long.txt'), Buffer.from(`${'a'.repeat(9)}✓✓✓\n`, 'utf8'));
    mkdirSync(join(dir, 'sub'));
    expect(await fileTextEncoding(join(dir, 'latin1.txt'), 1024)).toBe('not-utf8');
    expect(await fileTextEncoding(join(dir, 'long.txt'), 10)).toBe('utf8');
    expect(await fileTextEncoding(join(dir, 'missing.txt'), 1024)).toBeNull();
    expect(await fileTextEncoding(join(dir, 'sub'), 1024)).toBeNull();
  });

  it('the refusals name the file and the byte-safe way out', () => {
    expect(notUtf8Refusal('legacy.py')).toBe('legacy.py is not UTF-8 text (probably Latin-1/Windows-1252); editing it would corrupt it — use a byte-safe command (e.g. iconv to convert it first)');
    expect(utf16Refusal('w.txt')).toContain('iconv -f UTF-16 -t UTF-8');
  });
});
