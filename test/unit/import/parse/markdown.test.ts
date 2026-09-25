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


/**
 * Wall-clock gates on a shared machine: take the BEST of three samples, so a noisy neighbour cannot fail the gate while
 * genuinely slow code (quadratic regions, the pre-fix 13.9 s) still fails every sample.
 */
function bestOfMs(run: () => void, samples = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

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
    // the shared grammar (core/ansi.ts ESC_SEQ_RE): an OSC 8 link, a charset switch and an 8-bit CSI go whole and are counted
    const osc = normaliseText('see \u001b]8;;https://x.test\u0007link\u001b]8;;\u0007 \u001b(Bok \u009b1mC1');
    expect(osc.text).toBe('see link ok C1');
    expect(osc.controlsRemoved).toBe('\u001b]8;;https://x.test\u0007'.length + '\u001b]8;;\u0007'.length + '\u001b(B'.length + '\u009b1m'.length);
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

  /**
   * The third quadratic in this module, found while measuring review defect 6 and worse than the
   * one the review named: the lazy `[\s\S]*?` of the original
   * `/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\r?\n|$)/gm` re-scanned to the end of the body for **every**
   * line-leading `<!--` whose `-->` candidates all fail the end-of-line tail. Measured 665 ms for
   * 400 KiB with no `-->` at all and 11.4 s for 400 KiB of `<!-- open` followed by `--> x`, which
   * at the 4 MiB `sourceReadCapBytes` is about twenty minutes on one file.
   */
  it('400 KiB of unclosable block comments is stripped in under 200 ms', () => {
    const rep = (line: string, bytes: number): string => {
      const out: string[] = [];
      let n = 0;
      while (n < bytes) {
        out.push(line);
        n += line.length + 1;
      }
      return out.join('\n');
    };
    for (const text of [rep('<!-- a note that never closes', 400 * 1024), `${rep('<!-- open', 200 * 1024)}\n${rep('--> x', 200 * 1024)}`]) {
      const out = stripBlockHtmlComments(text);
      const ms = bestOfMs(() => stripBlockHtmlComments(text));
      expect(out).toBe(text); // nothing is strippable in either body
      expect(ms, `stripBlockHtmlComments took ${ms.toFixed(0)} ms for ${text.length} chars`).toBeLessThan(200);
    }
  });

  it('matches the regex it replaces, character for character, on every awkward shape', () => {
    // the original implementation, kept here as the oracle for the index-based rewrite
    const oracle = (s: string): string => s.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\r?\n|$)/gm, '');
    const corpus = [
      '',
      'no comments at all\n',
      '<!--',
      '-->',
      '<!---->\nkept\n',
      '<!-->\nkept\n',
      '<!-- a -->',
      '<!-- a -->\n',
      '<!-- a -->   \n next',
      '<!-- a --> trailing text\nnext\n',
      '  \t<!-- indented -->\nnext\n',
      'a <!-- inline --> b\n',
      '<!-- one --><!-- two -->\nnext\n',
      '<!-- outer <!-- inner --> tail -->\nnext\n',
      '<!-- unterminated\nstill going\n',
      '<!-- x --> y\n<!-- z -->\n',
      '<!-- a -->\r\nnext\r\n',
      '<!-- a -->\rnext\r',
      '<!-- a --> next',
      '<!-- a --> next',
      '<!-- a -->\t \n<!-- b -->',
      'text\n<!-- tail with no newline -->',
      '<!-- a\n-->\n<!-- b\n-->\n',
      '\n\n<!-- after blank lines -->\n\n',
      '<!-- p --> q\n<!-- r -->\ns\n',
      '--> <!-- reversed -->\n',
      '<!-- --> --> -->\n',
    ];
    for (const s of corpus) expect(stripBlockHtmlComments(s), JSON.stringify(s)).toBe(oracle(s));

    // and 5,000 deterministic shuffles of the same fragments (400,000 were run off-line, all identical)
    const pieces = ['<!--', '-->', '\n', '\r\n', '\r', ' ', ' ', ' ', '\t', 'a', 'xy', '<!', '--', '>', '<!---->', ' <!-- ', ' --> '];
    let seed = 0x2f6e2b1;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 5_000; i++) {
      let s = '';
      for (let k = 1 + rnd(14); k > 0; k--) s += pieces[rnd(pieces.length)];
      expect(stripBlockHtmlComments(s), JSON.stringify(s)).toBe(oracle(s));
    }
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

/**
 * Review defect 6 (`docs/research/import/review-engine-2026-09-22.md`): `inRegion` was an
 * `Array.some` over every code region, evaluated once per line, once per `@ref` and once per
 * plain executable form. The heading loop's `headings.length < limit` short-circuit never fires
 * when the headings live inside fences, so a fence-heavy body cost O(lines x regions): measured
 * on this fixture at 313 ms for 62 KiB, 2.1 s for 195 KiB and 13.9 s for 400 KiB, against §1
 * property 14's 1.5 s budget for the *whole* discovery pass. The lookup must be O(log n) in the
 * number of regions.
 */
describe('§1 property 14 — parseMarkdown is not quadratic in the number of code regions', () => {
  /** A three-line fence (holding a heading, so the 5-heading short-circuit cannot fire) plus a prose line with two spans and an `@ref`. */
  function fenceHeavy(targetBytes: number): string {
    const block = ['```sh', '# rotated key note', '```', 'See `a` and `b` at @notes/x.md.'].join('\n');
    const out: string[] = [];
    let n = 0;
    while (n < targetBytes) {
      out.push(block);
      n += block.length + 1;
    }
    return out.join('\n');
  }

  it('a 400 KiB fence-heavy file parses in under 200 ms', () => {
    const text = fenceHeavy(400 * 1024);
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(400 * 1024);
    const doc = parseMarkdown(text);
    const ms = bestOfMs(() => parseMarkdown(text));
    // the body really is region-dense: ~6,700 fences, as many spans, and as many refs inside them
    expect(doc.fences).toBeGreaterThan(5_000);
    expect(doc.refs.length).toBeGreaterThan(5_000);
    expect(doc.headings).toEqual([]);
    expect(ms, `parseMarkdown took ${ms.toFixed(0)} ms for ${Buffer.byteLength(text, 'utf8')} bytes`).toBeLessThan(200);
  });

  it('the region lookup stays exact at every boundary', () => {
    const body = ['# one', '```', '# in a fence', '```', '# two', 'text `# in a span` text', '# three'].join('\n');
    const doc = parseMarkdown(body, { headingLimit: 10 });
    expect(doc.headings).toEqual(['one', 'two', 'three']);
  });

  it('an @ref after hundreds of fences is still found, and the ones inside them are not', () => {
    const fences = Array.from({ length: 300 }, () => '```\n@fenced.md\n```').join('\n');
    const doc = parseMarkdown(`${fences}\n\nsee @after.md\n`);
    expect(doc.refs.map((r) => r.target)).toEqual(['after.md']);
    expect(doc.fences).toBe(300);
  });

  /**
   * The sibling of defect 6, found while measuring it: `pushIfFree`'s containment test was an
   * `Array.some` over every segment recorded so far, so a body dense in **unfenced** executable
   * forms was quadratic in the same way — 1.8 s for 400 KiB, and minutes at the 4 MiB
   * `sourceReadCapBytes`. §2.6 may not answer this by dropping segments: an executable that is
   * not recorded is not fenced inert either.
   */
  it('400 KiB of unfenced executable forms parses in under 200 ms', () => {
    const line = 'run $(date) then $(whoami) now.';
    const lines: string[] = [];
    let n = 0;
    while (n < 400 * 1024) {
      lines.push(line);
      n += line.length + 1;
    }
    const text = lines.join('\n');
    const doc = parseMarkdown(text);
    const ms = bestOfMs(() => parseMarkdown(text));
    expect(doc.executables.length).toBeGreaterThan(20_000);
    expect(ms, `parseMarkdown took ${ms.toFixed(0)} ms for ${doc.executables.length} executables`).toBeLessThan(200);
  });

  it('the containment verdict is unchanged: a nested form is kept, one inside a span segment is not', () => {
    const nested = parseMarkdown('$(a!{b})\n').executables;
    expect(nested.map((e) => [e.form, e.start, e.end])).toEqual([
      ['dollar-paren', 0, 8],
      ['brace-bang', 3, 7],
    ]);
    const inSpan = parseMarkdown('!`$(date)`\n').executables;
    expect(inSpan.map((e) => [e.form, e.start, e.end])).toEqual([['backtick-bang', 0, 10]]);
  });
});

/**
 * Review defect 8: `parseMarkdown` defaulted `redact` to `patternRedact`, which masks only the
 * **six** redacting families, so a heading carrying one of the **nine warn-only** families
 * (`# rotated key AKIA…`) survived into `SourceItem.parse.headings` — and from there into
 * `sources.jsonl` and the group-II Jev request body. §1 property 4 counts all fifteen, so the
 * default has to be the pattern layer of §2.9: `redactSpans(s, detectSecrets(s, exact))`.
 */
const WARN_ONLY_NEEDLES: readonly { family: string; needle: string }[] = [
  { family: 'aws', needle: 'AKIAIOSFODNN7EXAMPLE' },
  { family: 'slack', needle: 'xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrSt' },
  { family: 'slack_webhook', needle: 'hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX' },
  { family: 'pem', needle: '-----BEGIN OPENSSH PRIVATE KEY-----' },
  { family: 'jwt', needle: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' },
  { family: 'stripe', needle: 'sk_live_4eC39HqLyjWDarjtT1zdp7dc' },
  { family: 'npm', needle: 'npm_abcdefghijklmnopqrstuvwxyz0123456789' },
  { family: 'huggingface', needle: 'hf_abcdefghijklmnopqrstuvwxyzABCDEFGH' },
  { family: 'gitlab', needle: 'glpat-abcdefghijklmnopqrstuvwxyz' },
];

describe('§1 property 4 — a heading is redacted against all fifteen families, not six', () => {
  it('a needle from each of the nine warn-only families is masked out of a heading by default', () => {
    for (const { family, needle } of WARN_ONLY_NEEDLES) {
      const doc = parseMarkdown(`# rotated key ${needle}\n\nbody\n`);
      expect(doc.headings, family).toHaveLength(1);
      expect(doc.headings[0], family).not.toContain(needle.slice(0, 12));
      expect(doc.headings[0], family).toContain('[REDACTED:pattern]');
    }
  });

  it('the six redacting families are still masked, and ordinary headings survive untouched', () => {
    expect(parseMarkdown(`# key sk-ant-${'a'.repeat(24)}\n`).headings[0]).toBe('key [REDACTED:pattern]');
    expect(parseMarkdown('# Conventions for this repo\n').headings[0]).toBe('Conventions for this repo');
  });

  it('an explicit redactor still wins — that is how the exact layer is threaded from planImport', () => {
    const doc = parseMarkdown('# hunter2-correct-horse\n', { redact: (s) => s.replace('hunter2-correct-horse', '[REDACTED:fixture]') });
    expect(doc.headings).toEqual(['[REDACTED:fixture]']);
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
