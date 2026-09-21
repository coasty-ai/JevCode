/**
 * TUI-DESIGN §12.6 / §19.0: numstat parsing (`-\t-\t` binary, NUL renames), the inline block (letters, †, row
 * cap, path truncation by grapheme, rows ≤ columns at 20..120), the dependency-free line diff, `/diff <step>`,
 * and the cell-width helpers pinned against Ink's `string-width`.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DIFF_BAR_MIN_COLUMNS,
  DIFF_LEGEND,
  DIFF_PADDED_COUNTS_MIN_COLUMNS,
  DIFF_ROW_CAP,
  EMPTY_TREE_OID,
  diffBar,
  diffStatBlock,
  diffStatHeader,
  diffStatRows,
  diffStepLines,
  formatBytes,
  graphemeCells,
  graphemes,
  isBinary,
  lineDiff,
  lineDiffCounts,
  padEndCells,
  parseNumstatZ,
  splitLines,
  stringCells,
  truncateLeftCells,
  truncateRightCells,
  unifiedDiff,
} from '../../../src/undo/diff.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('parseNumstatZ (§12.6)', () => {
  it('plain rows, binary `-\\t-`, NUL-separated renames, torn tail', () => {
    const text = '120\t12\tsrc/a.py\x00-\t-\timg/logo.png\x003\t1\t\x00arch/i386/Makefile\x00arch/x86/Makefile\x000\t4\told.txt\x00';
    expect(parseNumstatZ(text)).toEqual([
      { path: 'src/a.py', from: null, added: 120, deleted: 12, binary: false },
      { path: 'img/logo.png', from: null, added: null, deleted: null, binary: true },
      { path: 'arch/x86/Makefile', from: 'arch/i386/Makefile', added: 3, deleted: 1, binary: false },
      { path: 'old.txt', from: null, added: 0, deleted: 4, binary: false },
    ]);
    expect(parseNumstatZ('')).toEqual([]);
    expect(parseNumstatZ('garbage\x00')).toEqual([]);
    expect(parseNumstatZ('1\t2\tok\x00garbage without tabs\x00x\ty\tbad counts\x00')).toEqual([{ path: 'ok', from: null, added: 1, deleted: 2, binary: false }]);
    // a rename record torn before its `to` token is dropped
    expect(parseNumstatZ('1\t1\t\x00from-only\x00')).toEqual([]);
    // paths with spaces, tabs are not separators inside the path, unicode
    expect(parseNumstatZ('1\t1\tdir with space/日本語.txt\x00')[0]?.path).toBe('dir with space/日本語.txt');
  });

  it('parses 5,000 rows well inside a keystroke', () => {
    const text = Array.from({ length: 5000 }, (_, i) => `${i}\t${i % 7}\tsrc/file${i}.ts\x00`).join('');
    const t0 = performance.now();
    const rows = parseNumstatZ(text);
    const ms = performance.now() - t0;
    expect(rows).toHaveLength(5000);
    expect(ms).toBeLessThan(150); // "the parse is µs" (§12.6); 3× a generous 50 ms bound for a loaded machine
  });
});

describe('diffStatBlock (§12.6, §24)', () => {
  const numstat = '120\t12\tsrc/a.py\x00-\t-\timg/logo.png\x003\t1\t\x00old/name.py\x00new/name.py\x000\t4\tgone.txt\x005\t0\tsrc/new.py\x001\t1\tvendor/lib\x00';
  const input = {
    runId: 'r1',
    numstat,
    untracked: [{ path: 'notes.txt', numstat: '7\t0\tnotes.txt\x00' }, { path: 'big.bin', bytes: 3 * 1024 * 1024 }],
    dirtyAtStart: new Set(['src/a.py']),
    created: new Set(['src/new.py']),
    deleted: new Set(['gone.txt']),
    submodules: new Set(['vendor/lib']),
    skipped: [{ path: 'huge.log', reason: 'size' }],
  };

  it('letters M/A/D/R/?/B/S, header counts, † legend, skipped rows', () => {
    const { rows, summary } = diffStatRows(input);
    expect(rows.map((r) => `${r.letter}${r.dirtyBefore ? '†' : ''} ${r.path}`)).toEqual(['M† src/a.py', 'B img/logo.png', 'R new/name.py', 'D gone.txt', 'A src/new.py', 'S vendor/lib', '? notes.txt', '? big.bin']);
    expect(summary).toEqual({ files: 8, added: 136, deleted: 18, untracked: 2, binary: 1, skipped: 1 });
    const lines = diffStatBlock(input, 80);
    expect(lines[0]).toBe('diff (run r1 · 8 files · +136 −18 · 2 untracked · 1 binary · 1 skipped)');
    expect(diffStatHeader('x', { files: 0, added: 0, deleted: 0, untracked: 0, binary: 0, skipped: 0 })).toBe('diff (run x · 0 files · +0 −0 · 0 untracked · 0 binary · 0 skipped)');
    expect(lines[1]).toMatch(/^ M src\/a\.py† +\+120 −12 +\++-+$/);
    expect(lines[2]).toMatch(/^ B img\/logo\.png +bin$/);
    expect(lines[3]).toMatch(/^ R old\/name\.py → new\/name\.py +\+3 −1 +\+-$/);
    expect(lines[4]).toMatch(/^ D gone\.txt +\+0 −4 +-$/);
    expect(lines[6]).toMatch(/^ S vendor\/lib +\+1 −1 +\+-$/);
    expect(lines[8]).toMatch(/^ \? big\.bin +3\.0 MiB$/);
    expect(lines).toContain(DIFF_LEGEND);
    expect(lines).toContain('   skipped huge.log: size');
    for (const l of lines) expect(stringCells(l)).toBeLessThanOrEqual(80);
  });

  it('row cap 40 with the --all lift; the legend only when a shown row carries †', () => {
    const many = Array.from({ length: 45 }, (_, i) => `${i + 1}\t0\tf${i}.py\x00`).join('');
    const capped = diffStatBlock({ runId: 'r', numstat: many, dirtyAtStart: new Set(['f44.py']) }, 100);
    expect(capped).toHaveLength(1 + DIFF_ROW_CAP + 1);
    expect(capped.at(-1)).toBe('… 5 more files (/diff --all)');
    expect(capped).not.toContain(DIFF_LEGEND);
    const all = diffStatBlock({ runId: 'r', numstat: many, dirtyAtStart: new Set(['f44.py']), all: true }, 100);
    expect(all).toHaveLength(1 + 45 + 1);
    expect(all.at(-1)).toBe(DIFF_LEGEND);
  });

  it('paths are left-truncated by grapheme to columns − 32, wide characters count two cells', () => {
    const long = `${'a/'.repeat(40)}日本語/ファイル😀.py`;
    const lines = diffStatBlock({ runId: 'r', numstat: `1\t0\t${long}\x00`, dirtyAtStart: new Set([long]) }, 60);
    const row = lines[1]!;
    expect(row.startsWith(' M …')).toBe(true);
    expect(row).toContain('ファイル😀.py†');
    expect(stringCells(row)).toBeLessThanOrEqual(60);
    // a narrow terminal still yields a row; NaN columns fall back to 80
    expect(diffStatBlock({ runId: 'r', numstat: '1\t0\tx\x00' }, 5)[1]).toMatch(/^ M x/);
    expect(diffStatBlock({ runId: 'r', numstat: '1\t0\tx\x00' }, Number.NaN)[1]).toMatch(/^ M x/);
  });

  it('every row is ≤ columns cells at 20 / 40 / 60 / 80 / 120 (bar dropped under 52, compact counts under 40)', () => {
    const long = `${'src/'.repeat(12)}a/very/long/path/name/file.py`;
    const wide = { ...input, numstat: `${numstat}120\t12\t${long}\x00` };
    for (const cols of [5, 20, 40, 51, 52, 60, 80, 120]) {
      const lines = diffStatBlock(wide, cols);
      expect(lines.length).toBeGreaterThan(8);
      for (const l of lines) expect(stringCells(l), `cols=${cols}: ${JSON.stringify(l)}`).toBeLessThanOrEqual(cols);
      if (cols < 20) continue; // below the 8-cell path floor plus counts nothing but the letter survives the cut
      const row = lines.find((l) => l.includes('file.py'));
      expect(row, `cols=${cols}`).toBeDefined();
      if (cols >= DIFF_BAR_MIN_COLUMNS) expect(row, `cols=${cols}`).toMatch(/\+120 −12 +\++-+$/);
      else if (cols >= DIFF_PADDED_COUNTS_MIN_COLUMNS) expect(row, `cols=${cols}`).toMatch(/\+120 −12$/);
      else expect(row, `cols=${cols}`).toMatch(/…$|\+120 −12$/);
    }
    // at 40 columns (padded counts, no bar) the row is exactly 40 cells; at 39 the counts are compact
    expect(diffStatBlock({ runId: 'r', numstat: `120\t12\t${long}\x00` }, 40)[1]).toBe(' M …ong/path/name/file.py    +120 −12');
    expect(diffStatBlock({ runId: 'r', numstat: `120\t12\t${long}\x00` }, 39)[1]).toBe(' M …ry/long/path/name/file.py  +120 −12');
    // 20 columns: the 8-cell path floor grows to fill the row (letter 3 + path 10 + gap 2 + counts 5 = 20)
    expect(diffStatBlock({ runId: 'r', numstat: `1\t0\tx\x00` }, 20)[1]).toBe(` M x${' '.repeat(11)}+1 −0`);
    // a CJK path at 40 columns: cells, not code points
    const cjk = diffStatBlock({ runId: 'r', numstat: `1\t0\t${'日本語/'.repeat(8)}f.py\x00` }, 40)[1]!;
    expect(stringCells(cjk)).toBeLessThanOrEqual(40);
    expect(cjk).toContain('f.py');
    expect(DIFF_BAR_MIN_COLUMNS).toBe(52);
    expect(DIFF_PADDED_COUNTS_MIN_COLUMNS).toBe(40);
  });

  it('empty input renders the header only; duplicate paths collapse; untracked wins nothing over a tracked twin', () => {
    expect(diffStatBlock({ runId: 'r', numstat: '' }, 80)).toEqual(['diff (run r · 0 files · +0 −0 · 0 untracked · 0 binary · 0 skipped)']);
    const { rows } = diffStatRows({ runId: 'r', numstat: '1\t0\tx\x001\t0\tx\x00', untracked: [{ path: 'x' }] });
    expect(rows).toHaveLength(1);
    expect(EMPTY_TREE_OID).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  });

  it('diffBar scales to the largest row, ≤ 10 cells, each non-zero side keeps a cell', () => {
    expect(diffBar(100, 0, 100)).toBe('++++++++++');
    expect(diffBar(50, 50, 100)).toBe('+++++-----');
    expect(diffBar(1, 0, 1000)).toBe('+');
    expect(diffBar(999, 1, 1000)).toBe('+++++++++-');
    expect(diffBar(0, 0, 10)).toBe('');
    expect(diffBar(3, 2, 0)).toBe('');
    expect(diffBar(3, 2, Number.POSITIVE_INFINITY)).toBe('');
    for (let a = 0; a < 30; a++) for (let d = 0; d < 30; d++) expect(diffBar(a, d, 30).length).toBeLessThanOrEqual(10);
    expect(diffBar(4, 4, 8, 0)).toBe('');
  });

  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MiB');
    expect(formatBytes(-1)).toBe('? B');
    expect(formatBytes(Number.NaN)).toBe('? B');
  });
});

/** Apply diff ops to `a`; must reproduce `b`. */
function apply(ops: ReturnType<typeof lineDiff>): string[] {
  return ops.filter((o) => o.op !== 'del').map((o) => o.line);
}
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('lineDiff (Myers) and unifiedDiff (§12.6)', () => {
  it('insert, delete, modify, identical, empty sides', () => {
    expect(lineDiff(['a', 'b'], ['a', 'x', 'b'])).toEqual([{ op: 'eq', line: 'a' }, { op: 'ins', line: 'x' }, { op: 'eq', line: 'b' }]);
    expect(lineDiff(['a', 'b', 'c'], ['a', 'c'])).toEqual([{ op: 'eq', line: 'a' }, { op: 'del', line: 'b' }, { op: 'eq', line: 'c' }]);
    expect(lineDiff(['a'], ['b'])).toEqual([{ op: 'del', line: 'a' }, { op: 'ins', line: 'b' }]);
    expect(lineDiff(['a'], ['a'])).toEqual([{ op: 'eq', line: 'a' }]);
    expect(lineDiff([], [])).toEqual([]);
    expect(lineDiff([], ['a'])).toEqual([{ op: 'ins', line: 'a' }]);
    expect(lineDiff(['a'], [])).toEqual([{ op: 'del', line: 'a' }]);
  });

  it('property: applying the ops to a yields b, for 300 seeded random pairs', () => {
    const rnd = mulberry32(20260920);
    for (let i = 0; i < 300; i++) {
      const n = Math.floor(rnd() * 40);
      const a = Array.from({ length: n }, () => String(Math.floor(rnd() * 6)));
      const b = a.filter(() => rnd() > 0.3).flatMap((l) => (rnd() > 0.8 ? [l, String(Math.floor(rnd() * 6))] : [l]));
      if (rnd() > 0.5) b.push('tail');
      const ops = lineDiff(a, b);
      expect(apply(ops)).toEqual(b);
      expect(ops.filter((o) => o.op !== 'ins').map((o) => o.line)).toEqual(a);
    }
  });

  it('past maxD the diff degrades to a whole-file replacement and stays correct', () => {
    const a = Array.from({ length: 200 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 200 }, (_, i) => `b${i}`);
    const ops = lineDiff(a, b, 10);
    expect(ops.filter((o) => o.op === 'eq')).toEqual([]);
    expect(apply(ops)).toEqual(b);
    // a large but similar pair is still a minimal diff
    const big = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const edited = [...big.slice(0, 10_000), 'inserted', ...big.slice(10_000)];
    const t0 = performance.now();
    const ops2 = lineDiff(big, edited);
    expect(performance.now() - t0).toBeLessThan(600);
    expect(ops2.filter((o) => o.op !== 'eq')).toEqual([{ op: 'ins', line: 'inserted' }]);
    expect(lineDiffCounts(big.join('\n'), edited.join('\n'))).toEqual({ added: 1, deleted: 0 });
  });

  it('splitLines keeps the no-EOL fact', () => {
    expect(splitLines('')).toEqual({ lines: [], noEol: false });
    expect(splitLines('a\nb\n')).toEqual({ lines: ['a', 'b'], noEol: false });
    expect(splitLines('a\nb')).toEqual({ lines: ['a', 'b'], noEol: true });
    expect(splitLines('\n')).toEqual({ lines: [''], noEol: false });
  });

  it('unified diff: headers, hunk ranges, context, `\\ No newline at end of file`', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n') + '\n';
    const b = ['1', '2', '3', '4', 'five', '6', '7', '8', '9', '10', '11'].join('\n') + '\n';
    expect(unifiedDiff(a, b, { aPath: 'a/f', bPath: 'b/f' })).toEqual([
      '--- a/f',
      '+++ b/f',
      '@@ -2,9 +2,10 @@',
      ' 2',
      ' 3',
      ' 4',
      '-5',
      '+five',
      ' 6',
      ' 7',
      ' 8',
      ' 9',
      ' 10',
      '+11',
    ]);
    // two hunks when the changes are far apart
    const far = unifiedDiff(a, a.replace('2\n', 'two\n').replace('10\n', 'ten\n'), { aPath: 'a/f', bPath: 'b/f' });
    expect(far.filter((l) => l.startsWith('@@'))).toEqual(['@@ -1,5 +1,5 @@', '@@ -7,4 +7,4 @@']);
    // identical texts → no output; a trailing-newline change alone is a change
    expect(unifiedDiff(a, a, { aPath: 'a/f', bPath: 'b/f' })).toEqual([]);
    expect(unifiedDiff('x\n', 'x', { aPath: 'a/f', bPath: 'b/f' })).toEqual(['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-x', '+x', '\\ No newline at end of file']);
    expect(unifiedDiff('x', 'x\ny\n', { aPath: 'a/f', bPath: 'b/f' })).toEqual(['--- a/f', '+++ b/f', '@@ -1 +1,2 @@', '-x', '\\ No newline at end of file', '+x', '+y']);
    // created / deleted
    expect(unifiedDiff('', 'new\n', { aPath: '/dev/null', bPath: 'b/n' })).toEqual(['--- /dev/null', '+++ b/n', '@@ -0,0 +1 @@', '+new']);
    expect(unifiedDiff('old\n', '', { aPath: 'a/o', bPath: '/dev/null' })).toEqual(['--- a/o', '+++ /dev/null', '@@ -1 +0,0 @@', '-old']);
    // context 0
    expect(unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', { aPath: 'a', bPath: 'b', context: 0 })).toEqual(['--- a', '+++ b', '@@ -2 +2 @@', '-b', '+B']);
  });

  it('isBinary: a NUL in the first 8000 bytes', () => {
    expect(isBinary(enc('plain text\n'))).toBe(false);
    expect(isBinary(new Uint8Array([0x50, 0x4b, 0x00, 0x01]))).toBe(true);
    const late = new Uint8Array(9000).fill(0x61);
    late[8500] = 0;
    expect(isBinary(late)).toBe(false);
    expect(isBinary(new Uint8Array(0))).toBe(false);
  });
});

describe('diffStepLines (§12.6 `/diff <step>`)', () => {
  it('per-file header with (changed since), unified body, /dev/null for created and deleted, binary and size notes', () => {
    const lines = diffStepLines(7, [
      { path: 'src/a.py', pre: enc('x = 1\n'), post: enc('x = 2\n'), changedSince: true },
      { path: 'new.py', pre: null, post: enc('n\n') },
      { path: 'old.txt', pre: enc('o\n'), post: null },
      { path: 'same.txt', pre: enc('s\n'), post: enc('s\n') },
      { path: 'logo.png', pre: new Uint8Array([0, 1, 2]), post: new Uint8Array([0, 1, 2, 3]) },
      { path: 'huge.log', pre: new Uint8Array(1024 * 1024 + 1), post: enc('small\n') },
      { path: 'nocopy.bin', pre: null, post: enc('after\n'), preUnavailable: true },
      { path: 'void', pre: null, post: null },
    ]);
    expect(lines).toEqual([
      'diff step 7 -- src/a.py (changed since)',
      '--- a/src/a.py',
      '+++ b/src/a.py',
      '@@ -1 +1 @@',
      '-x = 1',
      '+x = 2',
      'diff step 7 -- new.py',
      '--- /dev/null',
      '+++ b/new.py',
      '@@ -0,0 +1 @@',
      '+n',
      'diff step 7 -- old.txt',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-o',
      'diff step 7 -- same.txt',
      '(no changes)',
      'diff step 7 -- logo.png',
      'Binary files differ (before 3 B, after 4 B)',
      'diff step 7 -- huge.log',
      '(files > 1 MiB: before 1.0 MiB, after 6 B)',
      'diff step 7 -- nocopy.bin',
      '(no pre-image: file was not copied; after 6 B)',
      'diff step 7 -- void',
      '(no content recorded)',
    ]);
    expect(diffStepLines(3, [])).toEqual(['diff step 3: no files recorded']);
  });

  it('caps the output at maxLines with a trailer', () => {
    const a = Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n') + '\n';
    const b = Array.from({ length: 500 }, (_, i) => `L${i}`).join('\n') + '\n';
    const lines = diffStepLines(1, [{ path: 'f', pre: enc(a), post: enc(b) }], { maxLines: 50 });
    expect(lines).toHaveLength(50);
    expect(lines.at(-1)).toMatch(/^… \d+ more lines$/);
    const dflt = diffStepLines(1, [{ path: 'f', pre: enc(a), post: enc(b) }]);
    expect(dflt).toHaveLength(400);
  });
});

type StringWidthFn = (s: string) => number;

/** Ink's `string-width` (a transitive dependency) resolved from the repo root, never a runtime import (F18); null when absent. */
async function loadStringWidth(): Promise<StringWidthFn | null> {
  try {
    const req = createRequire(join(import.meta.dirname, '..', '..', '..', 'package.json'));
    const mod = (await import(pathToFileURL(req.resolve('string-width')).href)) as { default: StringWidthFn };
    return typeof mod.default === 'function' ? mod.default : null;
  } catch {
    return null;
  }
}

describe('cell widths (§4.2 over O2 width.ts)', () => {
  it('graphemes and widths: ASCII 1, CJK 2, emoji 2, combining 0, ZWJ sequences one grapheme', () => {
    expect(stringCells('abc')).toBe(3);
    expect(stringCells('日本語')).toBe(6);
    expect(stringCells('😀')).toBe(2);
    expect(stringCells('é')).toBe(1);
    expect(graphemes('👨‍👩‍👧')).toHaveLength(1);
    expect(stringCells('👨‍👩‍👧')).toBe(2);
    expect(stringCells('')).toBe(0);
    expect(stringCells('\x1b[31m')).toBe(4); // the ESC is zero, the four printable cells count
    expect(graphemes('')).toEqual([]);
    expect(graphemes('a日')).toEqual(['a', '日']);
    expect(graphemeCells('日')).toBe(2);
    expect(graphemeCells('')).toBe(0);
  });

  it('VS16 emoji, flags, keycaps, skin tones and ZWJ sequences measure 2 like string-width; lone regional indicators 1', async () => {
    const fixtures: [string, number][] = [
      ['⚠️', 2],
      ['🇯🇵', 2],
      ['1️⃣', 2],
      ['#️⃣', 2],
      ['❤️', 2],
      ['🏳️‍🌈', 2],
      ['👍🏽', 2],
      ['👨‍👩‍👧', 2],
      ['é', 1],
      ['a\u{0301}', 1],
      ['日', 2],
      ['한', 2],
      ['⚠', 1],
      ['🇯', 1],
      ['\u{200d}', 0],
      ['…', 1],
      ['·', 1],
      ['—', 1],
      ['⎇', 1],
      ['†', 1],
      ['✓', 1],
      ['日本語日本語日本語.py', 21],
    ];
    for (const [s, w] of fixtures) expect(stringCells(s), JSON.stringify(s)).toBe(w);
    const sw = await loadStringWidth();
    expect(sw, 'string-width is Ink’s dependency and must be resolvable from the repo root').not.toBeNull();
    for (const [s] of fixtures) expect(stringCells(s), `string-width disagrees on ${JSON.stringify(s)}`).toBe(sw!(s));
    for (const s of ['src/⚠️/🇯🇵 1️⃣.py', 'a日b😀ćd', 'x'.repeat(50) + '👨‍👩‍👧']) expect(stringCells(s)).toBe(sw!(s));
  });

  it('truncateLeftCells / truncateRightCells / padEndCells respect cell budgets', () => {
    expect(truncateLeftCells('abcdef', 4)).toBe('…def');
    expect(truncateLeftCells('abc', 4)).toBe('abc');
    expect(truncateLeftCells('日本語です', 5)).toBe('…です');
    expect(truncateLeftCells('abc', 1)).toBe('…');
    expect(truncateLeftCells('abc', 0)).toBe('');
    expect(truncateLeftCells('abc', Number.NaN)).toBe('');
    expect(truncateLeftCells('a/⚠️/🇯🇵.py', 6)).toBe('…🇯🇵.py');
    expect(truncateRightCells('abcdef', 4)).toBe('abc…');
    expect(truncateRightCells('日本語', 3)).toBe('日…');
    expect(truncateRightCells('abc', 1)).toBe('…');
    expect(truncateRightCells('abc', 0)).toBe('');
    expect(truncateRightCells('abc', Number.NaN)).toBe('');
    expect(truncateRightCells('', 5)).toBe('');
    expect(padEndCells('日', 4)).toBe('日  ');
    expect(padEndCells('toolong', 3)).toBe('toolong');
    for (let w = 0; w < 12; w++) {
      expect(stringCells(truncateLeftCells('a日b😀ćd⚠️🇯🇵', w))).toBeLessThanOrEqual(Math.max(w, 0));
      expect(stringCells(truncateRightCells('a日b😀ćd⚠️🇯🇵', w))).toBeLessThanOrEqual(Math.max(w, 0));
    }
  });
});
