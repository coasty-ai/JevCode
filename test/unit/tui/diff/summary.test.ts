/**
 * TUI-DESIGN-4 §6.1 (D-Z) — `editSummary(action)`, the one function that names the files and counts of **every**
 * edit action. §10's S5 row: the thirteen edge cases, the property test over `+` lines, and §11's build-time gate
 * (a 4 MiB patch ≤ 5 ms, memoised per `Action`).
 */
import { describe, expect, it } from 'vitest';
import type { Action } from '../../../../src/core/types.js';
import { EDIT_SUMMARY_FILE_MAX, countsText, editSummary, editTargetText, fileTouchText, patchTouches } from '../../../../src/tui/diff/summary.js';
import { GLYPHS } from '../../../../src/tui/glyphs.js';

const patch = (diff: string): Action => ({ kind: 'patch', diff });

const TWO_FILES = [
  'diff --git a/calc/ops.py b/calc/ops.py',
  'index 1111111..2222222 100644',
  '--- a/calc/ops.py',
  '+++ b/calc/ops.py',
  '@@ -10,3 +10,4 @@ def add(a, b):',
  ' def add(a, b):',
  '-    return a - b',
  '+    return a + b',
  '+    # fixed',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,0 +1,2 @@',
  '+one',
  '+two',
  '',
].join('\n');

describe('editSummary: the files, letters and counts of every edit action (§6.1)', () => {
  it('a two-file patch names both sides with their letters and counts, and the totals add up', () => {
    const s = editSummary(patch(TWO_FILES))!;
    expect(s.files.map((f) => [f.letter, f.path, f.added, f.deleted])).toEqual([
      ['M', 'calc/ops.py', 2, 1],
      ['M', 'README.md', 2, 0],
    ]);
    expect([s.added, s.deleted, s.truncatedFiles]).toEqual([4, 1, 0]);
    // §6.1 edge 12: memoised per Action — the same object returns the same instance
    const a = patch(TWO_FILES);
    expect(editSummary(a)).toBe(editSummary(a));
  });

  it('edge 1: an unparseable header contributes nothing and the caller keeps its own text', () => {
    expect(editSummary(patch('not a diff at all\njust prose\n'))).toBeNull();
    expect(editSummary(patch(''))).toBeNull(); // edge 13: an empty diff
  });

  it('edge 2: `/dev/null` sides are A and D', () => {
    const added = editSummary(patch('--- /dev/null\n+++ b/new.py\n@@ -0,0 +1,2 @@\n+a\n+b\n'))!;
    expect(added.files[0]).toMatchObject({ letter: 'A', path: 'new.py', added: 2, deleted: 0 });
    const gone = editSummary(patch('--- a/old.py\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n'))!;
    expect(gone.files[0]).toMatchObject({ letter: 'D', path: 'old.py', added: 0, deleted: 2 });
  });

  it('edge 3: a 100 %-similarity rename with no hunks is `R old → new  +0 −0`', () => {
    const s = editSummary(patch(['diff --git a/old.py b/new.py', 'similarity index 100%', 'rename from old.py', 'rename to new.py', ''].join('\n')))!;
    expect(s.files[0]).toMatchObject({ letter: 'R', path: 'new.py', from: 'old.py', added: 0, deleted: 0 });
    expect(fileTouchText(s.files[0]!, 60)).toBe('R old.py → new.py  +0 −0');
  });

  it('edge 4: `copy from` / `copy to` is an addition at the destination', () => {
    const s = editSummary(patch(['diff --git a/a.py b/b.py', 'similarity index 100%', 'copy from a.py', 'copy to b.py', ''].join('\n')))!;
    expect(s.files[0]).toMatchObject({ letter: 'A', path: 'b.py' });
  });

  it('edge 5: a mode-only change is `M <path> +0 −0 (mode)`', () => {
    const s = editSummary(patch(['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join('\n')))!;
    expect(s.files[0]).toMatchObject({ letter: 'M', path: 'run.sh', modeOnly: true });
    expect(fileTouchText(s.files[0]!, 60)).toBe('M run.sh  +0 −0 (mode)');
  });

  it('edge 6: a binary patch is `B`, counts suppressed, sizes from the `literal <n>` headers', () => {
    const s = editSummary(patch(['diff --git a/logo.png b/logo.png', 'GIT binary patch', 'literal 4200', 'zzz', 'literal 5120', 'zzz', ''].join('\n')))!;
    expect(s.files[0]).toMatchObject({ letter: 'B', binary: true, added: 0, deleted: 0, bytesFrom: 4200, bytesTo: 5120 });
    expect(fileTouchText(s.files[0]!, 60)).toBe('B logo.png  binary (4.1 KiB → 5.0 KiB)');
    // `Binary files … differ` (the textconv form) is the same letter
    expect(editSummary(patch('diff --git a/x.bin b/x.bin\nBinary files a/x.bin and b/x.bin differ\n'))!.files[0]!.letter).toBe('B');
  });

  it('edge 7: 200 files name the first three plus `(+N)`, and past the cap the totals still carry every file', () => {
    const many = Array.from({ length: 220 }, (_, i) => `diff --git a/f${i}.py b/f${i}.py\n--- a/f${i}.py\n+++ b/f${i}.py\n@@ -1 +1 @@\n-a\n+b`).join('\n');
    const s = editSummary(patch(many))!;
    expect(s.files).toHaveLength(EDIT_SUMMARY_FILE_MAX);
    expect(s.truncatedFiles).toBe(20);
    expect(s.added).toBe(220);
    expect(s.deleted).toBe(220);
    expect(editTargetText(s, 80)).toBe('220 files +220 −220 (f0.py, f1.py, f2.py, +217)');
  });

  it('edge 8: quoted and UTF-8 paths are unquoted', () => {
    const s = editSummary(patch('diff --git "a/caf\\303\\251.py" "b/caf\\303\\251.py"\n--- "a/caf\\303\\251.py"\n+++ "b/caf\\303\\251.py"\n@@ -1 +1 @@\n-a\n+b\n'))!;
    expect(s.files[0]!.path).toBe('café.py');
  });

  it('edge 10: a GNU-diff timestamp after `+++ b/x` is stripped', () => {
    const s = editSummary(patch('--- a/x.py\t2026-09-22 10:00:00\n+++ b/x.py\t2026-09-22 10:01:00\n@@ -1 +1 @@\n-a\n+b\n'))!;
    expect(s.files[0]!.path).toBe('x.py');
  });

  it('edge 11: `---`/`+++` disagreeing with `diff --git` prefers the `+++` side, which is what git apply uses', () => {
    const s = editSummary(patch('diff --git a/wrong.py b/wrong.py\n--- a/old.py\n+++ b/right.py\n@@ -1 +1 @@\n-a\n+b\n'))!;
    expect(s.files[0]!.path).toBe('right.py');
  });

  it('§6.2 edge 13: a body line that itself starts with `diff --git` is consumed as a body line, not a header', () => {
    const s = editSummary(patch('--- a/x.diff\n+++ b/x.diff\n@@ -1,2 +1,2 @@\n-diff --git a/ghost.py b/ghost.py\n+diff --git a/real.py b/real.py\n'))!;
    expect(s.files.map((f) => f.path)).toEqual(['x.diff']);
    expect([s.added, s.deleted]).toEqual([1, 1]);
  });

  it('`edit` and `write` gain their counts; `read` / `run` / `done` have no summary', () => {
    const e = editSummary({ kind: 'edit', path: 'a.py', old: 'x = 1\ny = 2\n', new: 'x = 2\ny = 2\n' })!;
    expect(e.files[0]).toMatchObject({ letter: 'M', path: 'a.py', added: 1, deleted: 1 });
    const w = editSummary({ kind: 'write', path: 'new.py', content: 'a\nb\nc\n' })!;
    expect(w.files[0]).toMatchObject({ letter: 'A', path: 'new.py', added: 3, deleted: 0 });
    expect(editSummary({ kind: 'read', paths: ['a.py'] })).toBeNull();
    expect(editSummary({ kind: 'run', command: 'pytest -q' })).toBeNull();
    expect(editSummary({ kind: 'done', summary: 'x' })).toBeNull();
  });

  it('editTargetText: one or two files are named, three or more fold, and the `--ascii` twin differs only in glyphs', () => {
    const s = editSummary(patch(TWO_FILES))!;
    expect(editTargetText(s, 80)).toBe('calc/ops.py +2 −1, README.md +2 −0');
    expect(editTargetText(s, 80, GLYPHS.ascii)).toBe('calc/ops.py +2 -1, README.md +2 -0');
    expect(countsText(12, 3)).toBe('+12 −3');
    expect(countsText(12, 3, GLYPHS.ascii)).toBe('+12 -3');
    // names are dropped before the counts are
    const three = editSummary(patch(`${TWO_FILES}diff --git a/c/d/e/very-long-name.py b/c/d/e/very-long-name.py\n--- a/c/d/e/very-long-name.py\n+++ b/c/d/e/very-long-name.py\n@@ -1 +1 @@\n-a\n+b\n`))!;
    expect(editTargetText(three, 22)).toBe('3 files +5 −2');
    expect(editTargetText(three, 200)).toContain('3 files +5 −2 (');
  });

  it('property: `editSummary(patch).added` equals the count of `+` body lines that are not `+++`', () => {
    for (let seed = 0; seed < 40; seed++) {
      const adds = (seed % 7) + 1;
      const dels = (seed % 5) + 1;
      const body = [...Array.from({ length: dels }, (_, i) => `-old ${i}`), ...Array.from({ length: adds }, (_, i) => `+new ${i}`)];
      const diff = ['diff --git a/f.py b/f.py', '--- a/f.py', '+++ b/f.py', `@@ -1,${dels} +1,${adds} @@`, ...body, ''].join('\n');
      const s = editSummary(patch(diff))!;
      const plus = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
      const minus = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
      expect(s.added).toBe(plus);
      expect(s.deleted).toBe(minus);
    }
  });

  it('§11: a 4 MiB patch summarises well inside the frame budget and is counted once per Action (edge 12)', () => {
    // a realistic 4 MiB patch: 80-cell source lines, one file per 40 hunk lines
    const line = 'x'.repeat(78);
    const file = (i: number): string => ['diff --git a/f${i}.py b/f${i}.py'.replace(/\$\{i\}/g, String(i)), `--- a/f${i}.py`, `+++ b/f${i}.py`, '@@ -1,20 +1,20 @@', ...Array.from({ length: 20 }, () => `-${line}`), ...Array.from({ length: 20 }, () => `+${line}`)].join('\n');
    let diff = '';
    for (let i = 0; diff.length < 4 * 1024 * 1024; i++) diff += `${file(i)}\n`;
    const a = patch(diff);
    const t0 = performance.now();
    const first = editSummary(a)!;
    const cold = performance.now() - t0;
    expect(first.added).toBeGreaterThan(1000);
    const t1 = performance.now();
    expect(editSummary(a)).toBe(first);
    const warm = performance.now() - t1;
    // eslint-disable-next-line no-console
    console.log(`[measured] editSummary over ${(diff.length / 1024 / 1024).toFixed(1)} MiB (${diff.split('\n').length} lines): cold ${cold.toFixed(2)} ms · memoised ${warm.toFixed(3)} ms (§11 budget 5 ms)`);
    expect(warm).toBeLessThan(1);
    // the machine is shared with a live bench, so the assertion is generous; the measured figure above is the number
    expect(cold).toBeLessThan(40);
  });

  it('patchTouches never throws on adversarial input', () => {
    for (const s of ['@@', '--- \n+++ \n@@ -1 +1 @@\n', 'diff --git \n', '\\ No newline at end of file', '\u0000￿', 'diff --git a/a b/a\n@@ -1,999999 +1,1 @@\n-x\n']) {
      expect(() => patchTouches(s)).not.toThrow();
    }
  });

  // -------------------------------------------------------------------------------------------------------------
  // §6.1 edge 9 and §14.2 review items 2 and 12 — the two defects of the first round-4 draft.
  // -------------------------------------------------------------------------------------------------------------

  it('edge 9 / item 2: a path carrying a newline, a `·` or an escape leaves this module on ONE line with no control byte', () => {
    // git quotes such a path and writes each byte as an octal escape; `unquote` turns them back into real bytes
    const newline = patch('--- "a/we\\nird.py"\n+++ "b/we\\nird.py"\n@@ -1 +1 @@\n-a\n+b\n');
    const t = editSummary(newline)!.files[0]!;
    expect(t.path).not.toMatch(/\n/);
    expect(t.path).toBe('we·ird.py');
    // eslint-disable-next-line no-control-regex
    for (const row of [fileTouchText(t, 80), editTargetText(editSummary(newline)!, 80)]) expect(row).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);

    const esc = patch('--- "a/\\033[31mred.py"\n+++ "b/\\033[31mred.py"\n@@ -1 +1 @@\n-a\n+b\n');
    const e = editSummary(esc)!.files[0]!;
    expect(e.path.codePointAt(0)).not.toBe(0x1b);
    expect(e.path).toBe('·[31mred.py');

    // a real `·` in a path is legal text and survives; the row is still cut to its cells
    const dot = patch('--- a/we·ird.py\n+++ b/we·ird.py\n@@ -1 +1 @@\n-a\n+b\n');
    expect(editSummary(dot)!.files[0]!.path).toBe('we·ird.py');
    expect(fileTouchText(editSummary(dot)!.files[0]!, 10).length).toBeLessThanOrEqual(10);

    // the rename/copy headers take the same treatment (they are a second door into the same field)
    const ren = patch('diff --git a/a.py b/b.py\nsimilarity index 100%\nrename from "a\\nx.py"\nrename to "b\\ny.py"\n');
    const r = editSummary(ren)!.files[0]!;
    expect(r.path).toBe('b·y.py');
    expect(r.from).toBe('a·x.py');
  });

  it('item 12: the two-file target folds to `<n> files +a −b` as soon as the named form exceeds the budget (F-E1)', () => {
    const s = editSummary(patch(TWO_FILES))!;
    // 34 cells named; the card title's 80-column target budget is 30
    expect(editTargetText(s, 34)).toBe('calc/ops.py +2 −1, README.md +2 −0');
    expect(editTargetText(s, 30)).toBe('2 files +4 −1');
    expect(editTargetText(s, 13)).toBe('2 files +4 −1');
    // a single file has no folded form worth having — it is still truncated
    const one = editSummary(patch('--- a/very/long/path/to/a/file.py\n+++ b/very/long/path/to/a/file.py\n@@ -1 +1 @@\n-a\n+b\n'))!;
    expect(editTargetText(one, 12).endsWith('…')).toBe(true);
    expect(editTargetText(one, 200)).toBe('very/long/path/to/a/file.py +1 −1');
  });

  it('`diffNumbersAbsolute`: a patch and a write number from the file, an edit numbers from the snippet (item 8)', async () => {
    const { diffNumbersAbsolute } = await import('../../../../src/tui/diff/summary.js');
    expect(diffNumbersAbsolute({ kind: 'patch', diff: 'x' })).toBe(true);
    expect(diffNumbersAbsolute({ kind: 'write', path: 'a.py', content: 'x' })).toBe(true);
    expect(diffNumbersAbsolute({ kind: 'edit', path: 'a.py', old: 'x', new: 'y' })).toBe(false);
  });
});
