/**
 * TUI-DESIGN-4 §6.2 (D-Z) — `diffRows()`, the **one** diff renderer. §10's S5 row: the fifteen edge cases, every
 * returned row's `cellWidth ≤ columns`, no row containing a tab, the `--ascii` twin differing only in glyphs, a
 * golden multi-file diff at 40/60/80/120, a pure-addition diff keeping a non-null `newNo` on every `add` row, the
 * two-column widths at 60 / 59 / 20 / 19 columns, and §11's build-time gate (5 000 input lines ≤ 2 ms).
 */
import { describe, expect, it } from 'vitest';
import { DIFF_NUMBERS_MIN, DIFF_TWO_COLUMN_MIN, diffRows, expandTabs, moreRowText } from '../../../../src/tui/diff/rows.js';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';

const MULTI = [
  'diff --git a/calc/ops.py b/calc/ops.py',
  'index 1111111..2222222 100644',
  '--- a/calc/ops.py',
  '+++ b/calc/ops.py',
  '@@ -12,3 +12,3 @@ def add(a, b):',
  ' def add(a, b):',
  '-    return a - b',
  '+    return a + b',
  'diff --git a/README.md b/README.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/README.md',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
  '',
].join('\n');

const all = (o: Parameters<typeof diffRows>[1]): ReturnType<typeof diffRows> => diffRows(MULTI, o);

describe('diffRows: the one diff renderer (§6.2)', () => {
  it('collapses the `diff --git` / `index` / `---` / `+++` plumbing into one `file` row per file (A6-8)', () => {
    const rows = all({ columns: 80, maxRows: 100 });
    expect(rows.filter((r) => r.kind === 'file').map((r) => r.text)).toEqual(['M calc/ops.py  +1 −1', 'A README.md  +2 −0']);
    expect(rows.some((r) => r.text.includes('diff --git'))).toBe(false);
    expect(rows.some((r) => r.text.includes('index 1111111'))).toBe(false);
    expect(rows.some((r) => r.text.startsWith('---') || r.text.startsWith('+++'))).toBe(false);
  });

  it('the two number columns: `old` blank on an add, `new` blank on a delete, and both placed (§14.2 item 36)', () => {
    const rows = all({ columns: 80, maxRows: 100 });
    const del = rows.find((r) => r.kind === 'del')!;
    const add = rows.find((r) => r.kind === 'add')!;
    expect([del.oldNo, del.newNo]).toEqual([13, null]);
    expect([add.oldNo, add.newNo]).toEqual([null, 13]);
    expect(del.text).toBe(' 13     │-    return a - b');
    expect(add.text).toBe('     13 │+    return a + b');
    // the heading introduces the first hunk of a file in the two-column form
    expect(rows.some((r) => r.text === 'old new')).toBe(true);
  });

  it('a pure-addition diff has a non-null `newNo` on EVERY add row and prints it (§10 S5)', () => {
    const pure = ['--- /dev/null', '+++ b/new.py', '@@ -0,0 +1,4 @@', '+a', '+b', '+c', '+d', ''].join('\n');
    const rows = diffRows(pure, { columns: 80, maxRows: 100 });
    const adds = rows.filter((r) => r.kind === 'add');
    expect(adds).toHaveLength(4);
    expect(adds.map((r) => r.newNo)).toEqual([1, 2, 3, 4]);
    for (const [i, r] of adds.entries()) expect(r.text).toContain(`${i + 1} │+`);
    expect(adds.every((r) => r.oldNo === null)).toBe(true);
  });

  it('the column ladder at 60 / 59 / 20 / 19 columns (§6.2 "Column widths", edge 12)', () => {
    const both = all({ columns: DIFF_TWO_COLUMN_MIN, maxRows: 100 }).find((r) => r.kind === 'del')!;
    expect(both.text).toBe(' 13     │-    return a - b');
    // below 60 the OLD column drops (the new side is the one a reader navigates to)
    const newOnly = all({ columns: DIFF_TWO_COLUMN_MIN - 1, maxRows: 100 }).find((r) => r.kind === 'del')!;
    expect(newOnly.text).toBe('    │-    return a - b');
    expect(all({ columns: 59, maxRows: 100 }).some((r) => r.text === 'old new')).toBe(false);
    // at 20 the new column survives; at 19 both drop and the row is sign + text
    expect(all({ columns: DIFF_NUMBERS_MIN, maxRows: 100 }).find((r) => r.kind === 'add')!.text).toContain('│+');
    const flat = all({ columns: DIFF_NUMBERS_MIN - 1, maxRows: 100 }).find((r) => r.kind === 'add')!;
    expect(flat.text.startsWith('+')).toBe(true);
    expect(flat.text).not.toContain('│');
    // `lineNumbers: false` is the same flat shape at any width
    expect(diffRows(MULTI, { columns: 200, maxRows: 100, lineNumbers: false }).find((r) => r.kind === 'del')!.text).toBe('-    return a - b');
  });

  it('edge 11: five- and six-digit line numbers widen both columns and the row never overflows', () => {
    const big = ['--- a/x.py', '+++ b/x.py', '@@ -123456,2 +123456,2 @@', '-a', '+b', ''].join('\n');
    const rows = diffRows(big, { columns: 80, maxRows: 100 });
    const del = rows.find((r) => r.kind === 'del')!;
    expect(del.oldNo).toBe(123456);
    expect(del.text.startsWith('123456        │-')).toBe(true);
    for (const r of rows) expect(cellWidth(r.text)).toBeLessThanOrEqual(80);
  });

  it('every row is ≤ columns and contains no tab, for columns 1…120 and both glyph sets (§10 S5)', () => {
    const tabby = ['--- a/t.py', '+++ b/t.py', '@@ -1,2 +1,2 @@', '-\tif x:\t# note', '+\t\tif x:', ''].join('\n');
    for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
      for (let columns = 1; columns <= 120; columns++) {
        for (const src of [MULTI, tabby]) {
          const rows = diffRows(src, { columns, maxRows: 200, g });
          for (const r of rows) {
            expect(cellWidth(r.text), `${columns} "${r.text}"`).toBeLessThanOrEqual(columns);
            expect(r.text).not.toContain('\t');
          }
        }
      }
    }
  });

  it('edge 1: a tab advances to the next 4-cell stop inside the row builder (A6-12)', () => {
    expect(expandTabs('\tx')).toBe('    x');
    expect(expandTabs('ab\tx')).toBe('ab  x');
    expect(expandTabs('abcd\tx')).toBe('abcd    x');
    const rows = diffRows('--- a/t.py\n+++ b/t.py\n@@ -1 +1 @@\n-\tx\n+\t\tx\n', { columns: 80, maxRows: 10 });
    expect(rows.find((r) => r.kind === 'del')!.text.endsWith('-    x')).toBe(true);
    expect(rows.find((r) => r.kind === 'add')!.text.endsWith('+        x')).toBe(true);
  });

  it('edges 2, 3, 4, 7: trailing whitespace, a BOM, other invisibles and a lone CR are made visible', () => {
    const ws = diffRows('--- a/w.py\n+++ b/w.py\n@@ -1 +1 @@\n-x = 1  \n+x = 1\n', { columns: 80, maxRows: 10 });
    expect(ws.find((r) => r.kind === 'del')!.text.endsWith('-x = 1··')).toBe(true);
    // a change that is NOT whitespace-only keeps its text (the marker would be noise)
    const other = diffRows('--- a/w.py\n+++ b/w.py\n@@ -1 +1 @@\n-x = 1  \n+y = 2\n', { columns: 80, maxRows: 10 });
    expect(other.find((r) => r.kind === 'del')!.text.endsWith('-x = 1  ')).toBe(true);
    const bom = diffRows('--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-a\n+\uFEFFb\n', { columns: 80, maxRows: 10 });
    expect(bom.find((r) => r.kind === 'add')!.text).toContain('<BOM>');
    const zw = diffRows('--- a/z.py\n+++ b/z.py\n@@ -1 +1 @@\n-a\n+x\u200By\u202Ez\n', { columns: 80, maxRows: 10 });
    expect(zw.find((r) => r.kind === 'add')!.text).toContain('x·y·z');
  });

  it('edge 5: a line longer than the row is cut with `…` and a `(+N chars)` tail, never wrapped', () => {
    const long = `--- a/l.py\n+++ b/l.py\n@@ -1 +1 @@\n-a\n+${'z'.repeat(400)}\n`;
    const rows = diffRows(long, { columns: 80, maxRows: 10 });
    const add = rows.find((r) => r.kind === 'add')!;
    expect(cellWidth(add.text)).toBeLessThanOrEqual(80);
    expect(add.text).toContain('…');
    expect(add.text).toMatch(/\(\+\d+ chars\)$/);
    expect(rows.filter((r) => r.kind === 'add')).toHaveLength(1);
  });

  it('edges 8, 9, 10: `\\ No newline`, a hunk section name and a malformed `@@` never throw', () => {
    const noEol = diffRows('--- a/n.py\n+++ b/n.py\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n', { columns: 80, maxRows: 10 });
    expect(noEol.some((r) => r.kind === 'meta' && r.text === '\\ No newline at end of file')).toBe(true);
    // the section name follows the range on a LATER hunk (the first is introduced by the `old new` heading)
    const two = diffRows('--- a/s.py\n+++ b/s.py\n@@ -1,1 +1,1 @@ def one(\n-a\n+b\n@@ -9,1 +9,1 @@ def two(\n-c\n+d\n', { columns: 80, maxRows: 20 });
    expect(two.find((r) => r.kind === 'hunk')!.text).toBe('@@ -9,1 +9,1 @@ def two(');
    const bad = diffRows('--- a/m.py\n+++ b/m.py\n@@ nonsense @@\n-a\n+b\n', { columns: 80, maxRows: 10 });
    expect(() => bad).not.toThrow();
    expect(bad.some((r) => r.kind === 'meta' && r.text.startsWith('@@'))).toBe(true);
  });

  it('edge 13: a body line that itself starts with `diff --git` is body, not a header', () => {
    const rows = diffRows('--- a/x.diff\n+++ b/x.diff\n@@ -1,2 +1,2 @@\n-diff --git a/ghost b/ghost\n+diff --git a/real b/real\n', { columns: 120, maxRows: 20 });
    expect(rows.filter((r) => r.kind === 'file')).toHaveLength(1);
    expect(rows.find((r) => r.kind === 'add')!.text).toContain('+diff --git a/real b/real');
  });

  it('edge 14: an empty or unparseable diff is `[]`; edge 15: `maxRows` reached adds a final `more` row', () => {
    expect(diffRows('', { columns: 80, maxRows: 10 })).toEqual([]);
    expect(diffRows('nothing here\n', { columns: 80, maxRows: 10 })).toEqual([]);
    const cut = all({ columns: 80, maxRows: 4 });
    expect(cut).toHaveLength(4);
    const last = cut[3]!;
    expect(last.kind).toBe('more');
    expect(last.hidden).toBeGreaterThan(0);
    expect(last.text).toBe(moreRowText(last.hidden!));
    expect(moreRowText(9, 18)).toBe('…[+9 rows · e expands to 18]');
    expect(moreRowText(9, 18, GLYPHS.ascii)).toBe('...[+9 rows - e expands to 18]');
    expect(diffRows(MULTI, { columns: 80, maxRows: 0 })).toEqual([]);
  });

  it('`firstFileOnly` keeps the hunks of file 1 only; `fileRow` selects counts / fence / none (§6.3 items 1–2)', () => {
    const first = all({ columns: 80, maxRows: 100, firstFileOnly: true });
    expect(first.filter((r) => r.kind === 'file')).toHaveLength(1);
    expect(first.some((r) => r.text.includes('README'))).toBe(false);
    expect(all({ columns: 80, maxRows: 100, fileRow: 'fence' })[0]!.text).toBe('╶──── calc/ops.py');
    expect(all({ columns: 80, maxRows: 100, fileRow: 'none' })[0]!.text).toBe('old new');
  });

  it('the `--ascii` twin differs only in glyphs', () => {
    const u = all({ columns: 80, maxRows: 100, fileRow: 'fence' }).map((r) => r.text);
    const a = all({ columns: 80, maxRows: 100, fileRow: 'fence', g: GLYPHS.ascii }).map((r) => r.text);
    expect(a).toHaveLength(u.length);
    for (const l of a) expect(l).toMatch(/^[\x20-\x7e]*$/);
    // the same rows modulo the three substituted glyphs
    expect(a).toEqual(u.map((l) => l.replace(/│/g, '|').replace(/─/g, '-').replace(/╶/g, '-')));
  });

  it('the golden multi-file rendering at 40 / 60 / 80 / 120 columns', () => {
    expect(all({ columns: 120, maxRows: 100 }).map((r) => `${r.kind}|${r.text}`)).toEqual([
      'file|M calc/ops.py  +1 −1',
      'meta|old new',
      'ctx| 12  12 │ def add(a, b):',
      'del| 13     │-    return a - b',
      'add|     13 │+    return a + b',
      'file|A README.md  +2 −0',
      'meta|old new',
      'add|      1 │+one',
      'add|      2 │+two',
    ]);
    expect(all({ columns: 80, maxRows: 100 }).map((r) => r.text)).toEqual(all({ columns: 120, maxRows: 100 }).map((r) => r.text));
    expect(all({ columns: 60, maxRows: 100 }).map((r) => r.text)).toEqual(all({ columns: 120, maxRows: 100 }).map((r) => r.text));
    // below 60 only the NEW column survives, so the first hunk keeps its own `@@` row instead of the `old new` heading
    expect(all({ columns: 40, maxRows: 100 }).map((r) => `${r.kind}|${r.text}`)).toEqual([
      'file|M calc/ops.py  +1 −1',
      'hunk|@@ -12,3 +12,3 @@ def add(a, b):',
      'ctx| 12 │ def add(a, b):',
      'del|    │-    return a - b',
      'add| 13 │+    return a + b',
      'file|A README.md  +2 −0',
      'hunk|@@ -0,0 +1,2 @@',
      'add|  1 │+one',
      'add|  2 │+two',
    ]);
  });

  it('§2.3 exemption: `/diff --all` at 10 columns keeps its full row count', () => {
    const wide = all({ columns: 200, maxRows: Number.MAX_SAFE_INTEGER });
    const tiny = all({ columns: 10, maxRows: Number.MAX_SAFE_INTEGER });
    expect(tiny).toHaveLength(wide.length);
    for (const r of tiny) expect(cellWidth(r.text)).toBeLessThanOrEqual(10);
  });

  it('§11: `diffRows` of 5 000 input lines is well inside the frame budget', () => {
    const body = Array.from({ length: 5000 }, (_, i) => (i % 2 === 0 ? `-line ${i}` : `+line ${i}`));
    const big = ['--- a/big.py', '+++ b/big.py', `@@ -1,2500 +1,2500 @@`, ...body, ''].join('\n');
    // warm first: the very first `cellWidth` of a row containing `│` builds the segmenter, which is not per-frame cost
    diffRows(big, { columns: 80, maxRows: 5100 });
    const runs: number[] = [];
    let rows = diffRows(big, { columns: 80, maxRows: 5100 });
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      rows = diffRows(big, { columns: 80, maxRows: 5100 });
      runs.push(performance.now() - t0);
    }
    const ms = runs.sort((a, b) => a - b)[2]!;
    expect(rows.length).toBeGreaterThan(4000);
    // eslint-disable-next-line no-console
    console.log(`[measured] diffRows over 5,000 input lines: median ${ms.toFixed(2)} ms of 5 warm runs (§11 budget 2 ms)`);
    expect(ms).toBeLessThan(40);
    // the cap makes a 5 000-line diff cost `maxRows + 1` strings, not 5 000
    const t1 = performance.now();
    expect(diffRows(big, { columns: 80, maxRows: 12 })).toHaveLength(12);
    expect(performance.now() - t1).toBeLessThan(ms + 5);
  });

  // -------------------------------------------------------------------------------------------------------------
  // §14.2 review items 1, 3, 4, 7, 11, 16 — the six defects of the first round-4 draft.
  // -------------------------------------------------------------------------------------------------------------

  it('item 1: a returned row NEVER carries a C0/DEL/C1 control — a command cannot drive the terminal', () => {
    // the card, the `--plain` confirmer's stdout and the SR twin all build from the raw action now, so an
    // ERASE-DISPLAY inside an added line would clear the screen from inside a card row
    const adversarial = ['--- /dev/null', '+++ b/evil.py', '@@ -0,0 +1,3 @@', '+x\u001b[2J\u0007\u0008y', '+tab\there', '+bell\u0007', ''].join('\n');
    for (const columns of [19, 40, 59, 80, 200]) {
      for (const rows of diffRows(adversarial, { columns, maxRows: 100 })) {
        // eslint-disable-next-line no-control-regex
        expect(rows.text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
        expect(cellWidth(rows.text)).toBeLessThanOrEqual(columns);
      }
    }
    const one = diffRows(adversarial, { columns: 80, maxRows: 100 }).find((r) => r.text.includes('x'))!;
    expect(one.text).toContain('x·[2J··y');
  });

  it('item 3: a rename WITH hunks is ONE `file` row with the right letter and the right counts', () => {
    const rename = [
      'diff --git a/old.py b/new.py',
      'similarity index 85%',
      'rename from old.py',
      'rename to new.py',
      'index 1111111..2222222 100644',
      '--- a/old.py',
      '+++ b/new.py',
      '@@ -1,2 +1,2 @@',
      '-a = 1',
      '+a = 2',
      ' b = 3',
      '',
    ].join('\n');
    const rows = diffRows(rename, { columns: 80, maxRows: 100 });
    const files = rows.filter((r) => r.kind === 'file');
    expect(files).toHaveLength(1);
    expect(files[0]!.text).toBe('R old.py → new.py  +1 −1');
    // and `firstFileOnly` — the review card's mode — still shows the body
    const card = diffRows(rename, { columns: 80, maxRows: 100, firstFileOnly: true });
    expect(card.filter((r) => r.kind === 'add')).toHaveLength(1);
    expect(card.filter((r) => r.kind === 'del')).toHaveLength(1);
  });

  it('item 3: a copy WITH hunks is ONE `A` row, and both parsers agree with `patchTouches`', async () => {
    const copy = ['diff --git a/a.py b/b.py', 'similarity index 90%', 'copy from a.py', 'copy to b.py', '--- a/a.py', '+++ b/b.py', '@@ -1 +1 @@', '-x', '+y', ''].join('\n');
    const rows = diffRows(copy, { columns: 80, maxRows: 100 }).filter((r) => r.kind === 'file');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('A a.py → b.py  +1 −1');
    const { patchTouches } = await import('../../../../src/tui/diff/summary.js');
    const t = patchTouches(copy).files;
    expect(t).toHaveLength(1);
    expect([t[0]!.letter, t[0]!.path, t[0]!.added, t[0]!.deleted]).toEqual(['A', 'b.py', 1, 1]);
  });

  it('item 4: a binary section with no hunks still yields its `file` row (§6.3 edge 7), never the base85 payload', () => {
    const bin = ['diff --git a/logo.png b/logo.png', 'index 1111111..2222222 100644', 'GIT binary patch', 'literal 4200', 'zzzzzzzz', 'literal 5100', ''].join('\n');
    const rows = diffRows(bin, { columns: 80, maxRows: 100 });
    expect(rows.filter((r) => r.kind === 'file').map((r) => r.text)).toEqual(['B logo.png  binary (4.1 KiB → 5.0 KiB)']);
    expect(rows.some((r) => r.text.includes('zzzz'))).toBe(false);
    expect(rows.some((r) => r.text.includes('literal'))).toBe(false);
    const differ = ['diff --git a/logo.png b/logo.png', 'index 111..222 100644', 'Binary files a/logo.png and b/logo.png differ', ''].join('\n');
    expect(diffRows(differ, { columns: 80, maxRows: 100 }).map((r) => r.text)).toEqual(['B logo.png  binary']);
  });

  it('item 4: a mode-only section yields `M <path>  +0 −0 (mode)` (§6.1 edge 5), not `[]`', () => {
    const mode = ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join('\n');
    expect(diffRows(mode, { columns: 80, maxRows: 100 }).map((r) => r.text)).toEqual(['M run.sh  +0 −0 (mode)']);
  });

  it('item 7 / §6.2 edge 2: a BLANK line that lost its trailing spaces is marked, not rendered as a bare `-`/`+`', () => {
    const blank = ['--- a/a.py', '+++ b/a.py', '@@ -1,4 +1,4 @@', ' a', '-    ', '+', ' b', ''].join('\n');
    const rows = diffRows(blank, { columns: 80, maxRows: 100 });
    const del = rows.find((r) => r.kind === 'del')!;
    const add = rows.find((r) => r.kind === 'add')!;
    expect(del.text).toBe('  2     │-····');
    expect(add.text).toBe('      2 │+');
    // and the flag the SR twin reads is on BOTH halves of the pair
    expect([del.wsOnly, add.wsOnly]).toEqual([true, true]);
    // the non-blank case still works and is still the same flag
    const code = ['--- a/a.py', '+++ b/a.py', '@@ -1 +1 @@', '-x = 1   ', '+x = 1', ''].join('\n');
    const d2 = diffRows(code, { columns: 80, maxRows: 100 }).find((r) => r.kind === 'del')!;
    expect(d2.text.endsWith('-x = 1···')).toBe(true);
    expect(d2.wsOnly).toBe(true);
    // a genuine change is NOT marked
    const real = ['--- a/a.py', '+++ b/a.py', '@@ -1 +1 @@', '-x = 1', '+x = 2', ''].join('\n');
    expect(diffRows(real, { columns: 80, maxRows: 100 }).find((r) => r.kind === 'del')!.wsOnly).toBeUndefined();
  });

  it('item 11 / §6.2 edge 5: the `(+N chars)` tail is exact — shown + N === the original length', () => {
    const body = 'q'.repeat(300);
    const long = ['--- a/a.py', '+++ b/a.py', '@@ -1 +1 @@', '-x', `+${body}`, ''].join('\n');
    for (const columns of [40, 60, 76, 80, 120]) {
      const add = diffRows(long, { columns, maxRows: 100 }).find((r) => r.kind === 'add')!;
      const m = / \(\+(\d+) chars\)$/.exec(add.text);
      expect(m).not.toBeNull();
      const hidden = Number(m![1]);
      // the row is `<prefix>+<cut>…<tail>`: count the `q`s that survived
      const shown = (add.text.match(/q/g) ?? []).length;
      expect(shown + hidden).toBe(body.length);
      expect(cellWidth(add.text)).toBeLessThanOrEqual(columns);
    }
  });

  it('item 16: a git-quoted UTF-8 path is decoded here exactly as `patchTouches` decodes it', async () => {
    const quoted = ['diff --git "a/caf\\303\\251.py" "b/caf\\303\\251.py"', '--- "a/caf\\303\\251.py"', '+++ "b/caf\\303\\251.py"', '@@ -1 +1 @@', '-a', '+b', ''].join('\n');
    const file = diffRows(quoted, { columns: 80, maxRows: 100 }).find((r) => r.kind === 'file')!;
    expect(file.text).toBe('M café.py  +1 −1');
    const { patchTouches } = await import('../../../../src/tui/diff/summary.js');
    expect(patchTouches(quoted).files[0]!.path).toBe('café.py');
    // and the fence form names it the same way
    const fence = diffRows(quoted, { columns: 80, maxRows: 100, fileRow: 'fence' }).find((r) => r.kind === 'file')!;
    expect(fence.text).toContain('café.py');
  });

  it('§6.3 edge 8: `withhold` replaces a file\'s body with one row and keeps the file row', () => {
    const secret = ['--- /dev/null', '+++ b/.env', '@@ -0,0 +1,2 @@', '+API_KEY=sk-live-aaaaaaaaaaaa', '+DB=postgres://u:p@h/db', ''].join('\n');
    const rows = diffRows(secret, { columns: 80, maxRows: 100, withhold: (p) => p === '.env' });
    expect(rows.map((r) => r.text)).toEqual(['A .env  +2 −0', 'content withheld (secret path)']);
    expect(rows.some((r) => r.text.includes('sk-live'))).toBe(false);
  });

  it('§6.2 edge 8: `\\ No newline at end of file` survives wherever it sits, including past the last counted line', () => {
    const noeol = ['--- a/a.py', '+++ b/a.py', '@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file', ''].join('\n');
    const rows = diffRows(noeol, { columns: 80, maxRows: 100 });
    expect(rows.some((r) => r.kind === 'meta' && r.text === '\\ No newline at end of file')).toBe(true);
  });
});
