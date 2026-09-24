import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteLine, indentOf, insertLine, lineCount, reindent, replaceLine, unifiedDiff } from '../../../../../src/jev-modes/synth/py/edits.js';
import { PyEditError } from '../../../../../src/jev-modes/synth/py/errors.js';
import { fixture, rng } from './helpers.js';

describe('line edits', () => {
  const src = 'a = 1\nb = 2\nc = 3\n';
  it('replaceLine keeps the line ending and accepts multi-line replacements', () => {
    expect(replaceLine(src, 2, 'B = 22')).toBe('a = 1\nB = 22\nc = 3\n');
    expect(replaceLine(src, 2, 'if a:\n    b = 2')).toBe('a = 1\nif a:\n    b = 2\nc = 3\n');
    expect(replaceLine('a\r\nb\r\n', 1, 'x\ny')).toBe('x\r\ny\r\nb\r\n');
    expect(replaceLine('a\nb', 2, 'B')).toBe('a\nB');
  });
  it('insertLine after a line, at the top, at the end, with indentation', () => {
    expect(insertLine(src, 1, 'x = 0')).toBe('a = 1\nx = 0\nb = 2\nc = 3\n');
    expect(insertLine(src, 0, 'import os')).toBe('import os\na = 1\nb = 2\nc = 3\n');
    expect(insertLine(src, 3, 'd = 4')).toBe('a = 1\nb = 2\nc = 3\nd = 4\n');
    expect(insertLine(src, 1, 'if a:\n    pass', 4)).toBe('a = 1\n    if a:\n        pass\nb = 2\nc = 3\n');
    expect(insertLine(src, 1, '  y = 1', '\t')).toBe('a = 1\n\ty = 1\nb = 2\nc = 3\n');
    expect(insertLine('a\r\nb\r\n', 1, 'x')).toBe('a\r\nx\r\nb\r\n');
  });
  it('insertLine after a last line that has no trailing newline gives it one', () => {
    expect(insertLine('a\nb', 2, 'c')).toBe('a\nb\nc');
    expect(insertLine('', 0, 'c')).toBe('c\n');
  });
  it('deleteLine', () => {
    expect(deleteLine(src, 1)).toBe('b = 2\nc = 3\n');
    expect(deleteLine(src, 3)).toBe('a = 1\nb = 2\n');
    expect(deleteLine('a\nb', 2)).toBe('a\n');
  });
  it('out-of-range line numbers throw PyEditError', () => {
    for (const bad of [0, 4, -1, 1.5]) {
      expect(() => replaceLine(src, bad, 'x')).toThrow(PyEditError);
      expect(() => deleteLine(src, bad)).toThrow(PyEditError);
    }
    expect(() => insertLine(src, 4, 'x')).toThrow(PyEditError);
    expect(() => insertLine(src, -1, 'x')).toThrow(PyEditError);
    try {
      replaceLine(src, 9, 'x');
    } catch (e) {
      expect(e).toBeInstanceOf(PyEditError);
      expect((e as PyEditError).line).toBe(9);
      expect((e as PyEditError).lineCount).toBe(3);
    }
  });
  it('lineCount and indentOf', () => {
    expect(lineCount(src)).toBe(3);
    expect(lineCount('a\nb')).toBe(2);
    expect(lineCount('')).toBe(0);
    expect(indentOf('    x = 1')).toBe('    ');
    expect(indentOf('\t\tx')).toBe('\t\t');
    expect(indentOf('x')).toBe('');
    expect(indentOf('')).toBe('');
  });
  it('reindent strips the common indentation and keeps relative indentation and blank lines', () => {
    expect(reindent('        if a:\n            b = 1\n\n        c = 2', 4)).toBe('    if a:\n        b = 1\n\n    c = 2');
    expect(reindent('x = 1', '\t')).toBe('\tx = 1');
    expect(reindent('\t\tx\n\t\t\ty', '  ')).toBe('  x\n  \ty');
    expect(reindent('   ', 4)).toBe('');
    expect(reindent('', 4)).toBe('');
  });
});

describe('unifiedDiff', () => {
  const knapsack = fixture('knapsack');
  it('identical sources give an empty diff', () => {
    expect(unifiedDiff('k.py', knapsack, knapsack)).toBe('');
  });
  it('a one-line change produces one hunk with three lines of context and git headers', () => {
    const changed = replaceLine(knapsack, 12, '            if weight <= j:');
    expect(unifiedDiff('python_programs/knapsack.py', knapsack, changed)).toBe(
      [
        'diff --git a/python_programs/knapsack.py b/python_programs/knapsack.py',
        '--- a/python_programs/knapsack.py',
        '+++ b/python_programs/knapsack.py',
        '@@ -9,7 +9,7 @@',
        '         for j in range(1, capacity + 1):',
        '             memo[i, j] = memo[i - 1, j]',
        ' ',
        '-            if weight < j:',
        '+            if weight <= j:',
        '                 memo[i, j] = max(',
        '                     memo[i, j],',
        '                     value + memo[i - 1, j - weight]',
        '',
      ].join('\n'),
    );
  });
  it('changes far apart make separate hunks; changes within 2×context merge', () => {
    const two = replaceLine(replaceLine(knapsack, 3, '    from collections import defaultdict  # x'), 18, '    return memo[len(items), capacity]  # y');
    expect(unifiedDiff('k.py', knapsack, two).match(/^@@ /gm)).toHaveLength(2);
    const merged = replaceLine(replaceLine(knapsack, 10, '            memo[i, j] = memo[i - 1, j]  # a'), 13, '                memo[i, j] = max(  # b');
    expect(unifiedDiff('k.py', knapsack, merged).match(/^@@ /gm)).toHaveLength(1);
  });
  it('insertions, deletions, missing trailing newline markers, empty files', () => {
    expect(unifiedDiff('e.py', '', 'a\nb\n')).toBe('diff --git a/e.py b/e.py\n--- a/e.py\n+++ b/e.py\n@@ -0,0 +1,2 @@\n+a\n+b\n');
    expect(unifiedDiff('e.py', 'a\n', '')).toBe('diff --git a/e.py b/e.py\n--- a/e.py\n+++ b/e.py\n@@ -1,1 +0,0 @@\n-a\n');
    expect(unifiedDiff('n.py', 'a\nb', 'a\nb\n')).toBe('diff --git a/n.py b/n.py\n--- a/n.py\n+++ b/n.py\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n');
    expect(unifiedDiff('n.py', 'a\nb\n', 'a\nb')).toBe('diff --git a/n.py b/n.py\n--- a/n.py\n+++ b/n.py\n@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n');
  });
});

describe('unifiedDiff applies with git apply and round-trips', () => {
  let repo: string;
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'jevcode-py-diff-'));
    git('init', '-q');
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** Write `oldSrc` at `path`, apply the diff with git, return the file content afterwards. */
  const applyViaGit = (path: string, oldSrc: string, newSrc: string): string => {
    const abs = join(repo, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, oldSrc);
    const patch = unifiedDiff(path, oldSrc, newSrc);
    if (patch === '') return readFileSync(abs, 'utf8');
    const patchFile = join(repo, 'patch.diff');
    writeFileSync(patchFile, patch);
    git('apply', '--check', patchFile);
    git('apply', patchFile);
    return readFileSync(abs, 'utf8');
  };

  it('single-line fix in knapsack.py', () => {
    const src = fixture('knapsack');
    const fixed = replaceLine(src, 12, '            if weight <= j:');
    expect(applyViaGit('python_programs/knapsack.py', src, fixed)).toBe(fixed);
  });
  it('multiple hunks, insertions and deletions in core.py', () => {
    const src = fixture('calc_core');
    let out = replaceLine(src, 27, '    return sum(items) / len(items)');
    out = insertLine(out, 13, 'def sub(a: float, b: float) -> float:\n    return a - b\n', 0);
    out = deleteLine(out, 1);
    expect(applyViaGit('calc/core.py', src, out)).toBe(out);
  });
  it('files without trailing newline in either direction', () => {
    const src = fixture('levenshtein').replace(/\n$/, '');
    expect(applyViaGit('a/lev.py', src, `${src}\n`)).toBe(`${src}\n`);
    expect(applyViaGit('b/lev.py', `${src}\n`, src)).toBe(src);
    const changedLast = `${src.slice(0, src.lastIndexOf('\n'))}\n"""  # end`;
    expect(applyViaGit('c/lev.py', src, changedLast)).toBe(changedLast);
  });
  it('empty to content and content to empty', () => {
    expect(applyViaGit('d/empty.py', '', 'x = 1\n')).toBe('x = 1\n');
    expect(applyViaGit('d/full.py', 'x = 1\ny = 2\n', '')).toBe('');
  });
  it('random edit sequences on every fixture apply exactly', () => {
    const random = rng(42);
    const fixtures = ['knapsack', 'levenshtein', 'topological_ordering', 'calc_core', 'tricky'] as const;
    for (let round = 0; round < 25; round++) {
      const name = fixtures[round % fixtures.length]!;
      const src = fixture(name);
      let out = src;
      const edits = 1 + Math.floor(random() * 4);
      for (let e = 0; e < edits; e++) {
        const n = lineCount(out);
        const line = 1 + Math.floor(random() * n);
        const op = random();
        if (op < 0.4) out = replaceLine(out, line, `${indentOf(out.split('\n')[line - 1]!)}edited_${round}_${e} = ${e}`);
        else if (op < 0.7) out = insertLine(out, line, `inserted_${round}_${e} = None`, indentOf(out.split('\n')[line - 1]!));
        else if (n > 1) out = deleteLine(out, line);
      }
      if (random() < 0.2) out = out.replace(/\n$/, '');
      expect(applyViaGit(`r/${round}_${name}.py`, src, out)).toBe(out);
    }
  });
});
