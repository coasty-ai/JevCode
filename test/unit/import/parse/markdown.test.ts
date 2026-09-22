/** import/parse/markdown.ts (IMPORT-DESIGN §4.3; §6 rows 24–25): normalisation, headings, fences, dedupe keys. */
import { describe, expect, it } from 'vitest';
import {
  fenceExecutables,
  jaccard,
  looksBinary,
  minhashBands,
  normaliseText,
  parseMarkdown,
  stripBlockHtmlComments,
} from '../../../../src/import/parse/markdown.js';

describe('normaliseText — §6 row 25 encodings', () => {
  it('strips a UTF-8 BOM and reports it', () => {
    const r = normaliseText(Buffer.from('﻿# hi\n', 'utf8'));
    expect(r.text).toBe('# hi\n');
    expect(r.bom).toBe(true);
  });

  it('decodes UTF-16LE and UTF-16BE with a BOM', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# hi\n', 'utf16le')]);
    const beBody = Buffer.from('# hi\n', 'utf16le');
    beBody.swap16();
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
    expect(normaliseText(le).text).toBe('# hi\n');
    expect(normaliseText(be).text).toBe('# hi\n');
  });

  it('CRLF and a lone CR both become LF, and crlf is reported', () => {
    const r = normaliseText('a\r\nb\rc\n');
    expect(r.text).toBe('a\nb\nc\n');
    expect(r.crlf).toBe(true);
    expect(normaliseText('a\nb\n').crlf).toBe(false);
  });

  it('bidi controls, ANSI escapes and U+2028/9 are removed and counted (§2.9)', () => {
    const r = normaliseText("a\u{202e}b\u{200f}c\u001b[31md\u{2028}e");
    expect(r.text).toBe('abcd\ne');
    expect(r.controlsRemoved).toBe(2 + '\u001b[31m'.length);
  });

  it('a string input is accepted as well as a Buffer', () => {
    expect(normaliseText('plain').text).toBe('plain');
  });
});

describe('looksBinary — §6 row 24', () => {
  it('a PNG named notes.md, a run of NULs and invalid UTF-8 are all not text', () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]))).toBe(true);
    expect(looksBinary(Buffer.alloc(4096))).toBe(true);
    expect(looksBinary(Buffer.from([0xc3, 0x28, 0x41]))).toBe(true);
  });

  it('ordinary UTF-8 markdown is text, and a multi-byte character cut by the sniff window is still text', () => {
    expect(looksBinary(Buffer.from('# hello — world\n', 'utf8'))).toBe(false);
    const cut = Buffer.from('aaa€', 'utf8').subarray(0, 4);
    expect(looksBinary(cut)).toBe(false);
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });
});

describe('stripBlockHtmlComments', () => {
  it('drops comments that own their lines and keeps inline ones', () => {
    expect(stripBlockHtmlComments('<!-- jevcode:memory-index v1 -->\n# Memory\n')).toBe('# Memory\n');
    expect(stripBlockHtmlComments('a <!-- inline --> b\n')).toBe('a <!-- inline --> b\n');
    expect(stripBlockHtmlComments('<!--\nmulti\nline\n-->\ntext\n')).toBe('text\n');
  });
});

describe('parseMarkdown', () => {
  it('collects at most 5 headings, clipped to 80 cells, outside fences, and counts fences and lines', () => {
    const text = ['# One', '', '```sh', '# not a heading', '```', '## Two', '### Three', '#### Four', '##### Five', '###### Six'].join('\n');
    const doc = parseMarkdown(text);
    expect(doc.headings).toEqual(['One', 'Two', 'Three', 'Four', 'Five']);
    expect(doc.fences).toBe(1);
    expect(doc.lines).toBe(10);
    const long = parseMarkdown(`# ${'x'.repeat(200)}`);
    expect(long.headings[0]?.length).toBe(80);
  });

  it('strips the block HTML comment before hashing, so a Claude index and a JevCode index dedupe', () => {
    const claude = '# Memory\n\n- [A](a.md) — x\n';
    const jevcode = `<!-- jevcode:memory-index v1 -->\n${claude}`;
    expect(parseMarkdown(jevcode).normalisedSha256).toBe(parseMarkdown(claude).normalisedSha256);
  });

  it('exposes frontmatter, tokens and bands; the token set ignores the frontmatter', () => {
    const doc = parseMarkdown('---\nname: secretly-named-topic\n---\nAlpha beta gamma.\n');
    expect(doc.frontmatter?.keys).toEqual(['name']);
    expect(doc.tokens).toEqual(['alpha', 'beta', 'gamma']);
    expect(doc.bands).toHaveLength(8);
    expect(doc.bands).toEqual(minhashBands(doc.tokens));
  });

  it('never throws on a malformed document', () => {
    expect(() => parseMarkdown('---\nbroken\n')).not.toThrow();
    expect(() => parseMarkdown('```\nunclosed fence\n')).not.toThrow();
    expect(parseMarkdown('').lines).toBe(0);
  });

  it('§6 row 35: an @path inside a fence or a code span is not a reference', () => {
    const doc = parseMarkdown('see @notes.md\n\n```\n@fenced.md\n```\n\nand `@spanned.md`\n');
    expect(doc.refs.map((r) => r.target)).toEqual(['notes.md']);
  });
});

describe('jaccard / minhashBands', () => {
  it('jaccard is the set ratio, and an empty side scores 0 (the conservative answer)', () => {
    expect(jaccard(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(['a'], [])).toBe(0);
  });

  it('bands are deterministic, order-independent and identical for identical token sets', () => {
    expect(minhashBands(['a', 'b', 'c'])).toEqual(minhashBands(['c', 'b', 'a']));
    expect(minhashBands([])).toEqual([]);
    expect(minhashBands(['a', 'b'], 3)).toHaveLength(3);
    expect(minhashBands(['a', 'b', 'c'])).not.toEqual(minhashBands(['x', 'y', 'z']));
  });
});

describe('fenceExecutables — §2.6', () => {
  it('finds the six forms and fences each one inert', () => {
    const body = ['Run !`npm test` now.', 'And !{ls} and @{file.txt} and $(date).', '', '```!', 'rm -rf /', '```', '', 'A `!inline-cmd` too.'].join('\n');
    const doc = parseMarkdown(body);
    expect([...new Set(doc.executables.map((e) => e.form))].sort()).toEqual(['at-brace', 'backtick-bang', 'backtick-cmd', 'brace-bang', 'dollar-paren', 'fence-bang']);
    const out = fenceExecutables(body, doc.executables);
    expect(out.stripped).toBe(doc.executables.length);
    expect(out.text).toContain('```text (not run)');
    expect(out.text).toContain('npm test');
    expect(out.text).not.toContain('!`npm test`');
  });

  it('a segment holding a fence gets a longer fence, and no segment leaves an executable form behind', () => {
    const seg = { form: 'fence-bang' as const, start: 0, end: 5, text: '```\nx\n```' };
    const out = fenceExecutables('abcde', [seg]);
    expect(out.text.startsWith('````text (not run)')).toBe(true);
    expect(out.stripped).toBe(1);
  });

  it('is a no-op when there is nothing executable', () => {
    expect(fenceExecutables('plain text\n', [])).toEqual({ text: 'plain text\n', stripped: 0 });
  });
});
