/**
 * `src/orchestrate/critic.ts` — the five §5.3 hard rules, the [G8] include/drop question and the
 * corner-row-41 flaky flag. Pure: no git, no clock, no I/O.
 *
 * Corner row 40 ("the diff deletes tests or drops the collected count") is asserted as a property
 * over generated test diffs with a seeded PRNG written inline.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { sha256Hex } from '../../../src/core/hash.js';
import { DEFAULT_SPLIT_POLICY } from '../../../src/orchestrate/types.js';
import type { SyncedDirtyEntry } from '../../../src/orchestrate/types.js';
import {
  BRANCH_MOVED,
  HARD_RULES,
  buildIncludeDropQuestion,
  checkHardRules,
  countAssertions,
  flakyFlag,
  hasConflictMarkers,
  matchesTestGlob,
  outsideOwn,
  parseVerifyCounts,
  tailLines,
  totalCount,
} from '../../../src/orchestrate/critic.js';
import type { DiffFile, HardRuleInput } from '../../../src/orchestrate/critic.js';

const TEST_GLOBS = DEFAULT_SPLIT_POLICY.testGlobs;

function input(over: Partial<HardRuleInput> = {}): HardRuleInput {
  return {
    files: [],
    testGlobs: TEST_GLOBS,
    forbidden: [],
    counts: { before: null, after: null },
    conflictMarkerPaths: [],
    pinned: 'a'.repeat(40),
    pinnedNow: 'a'.repeat(40),
    ...over,
  };
}

function file(path: string, over: Partial<DiffFile> = {}): DiffFile {
  return { path, status: 'M', from: null, added: [], removed: [], ...over };
}

/**
 * A throwaway directory standing in for the agent worktree `outsideOwn` hashes against. No git:
 * `carriedPaths` is fs only, and that is the whole point of the [D2] comparison.
 */
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() ?? '', { recursive: true, force: true });
});

function worktree(files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jev-critic-')));
  scratch.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/** The `syncedDirty` entry the [D2] sync would have written for `path` holding `syncedContent`. */
function syncedEntry(path: string, syncedContent: string): SyncedDirtyEntry {
  return { path, sha256: sha256Hex(Buffer.from(syncedContent)), mode: 0o644 };
}

function rules(res: ReturnType<typeof checkHardRules>): string[] {
  return res.ok ? [] : res.violations.map((v) => v.rule);
}

function reasons(res: ReturnType<typeof checkHardRules>): string[] {
  return res.ok ? [] : res.violations.map((v) => v.reason);
}

describe('the test-glob matcher (a broader language than `own`)', () => {
  it.each([
    ['test/unit/store.test.ts', true],
    ['tests/x.py', true],
    ['spec/a_spec.rb', true],
    ['store.test.ts', true],
    ['src/loop/engine_test.go', true],
    ['pkg/test_thing.py', true],
    ['conftest.py', true],
    ['src/loop/engine.ts', false],
    ['testing/notes.md', false],
  ])('%s -> %s', (path, expected) => {
    expect(matchesTestGlob(TEST_GLOBS, path)).toBe(expected);
  });

  it('a `*` never crosses a path separator', () => {
    expect(matchesTestGlob(['src/*.ts'], 'src/a.ts')).toBe(true);
    expect(matchesTestGlob(['src/*.ts'], 'src/sub/a.ts')).toBe(false);
    expect(matchesTestGlob(['dist/**'], 'dist/a/b/c.js')).toBe(true);
  });

  it('treats glob metacharacters in the pattern literally where they are not globs', () => {
    expect(matchesTestGlob(['pages/[slug].tsx'], 'pages/[slug].tsx')).toBe(true);
    expect(matchesTestGlob(['pages/[slug].tsx'], 'pages/s.tsx')).toBe(false);
  });
});

describe('rule 1 — tests are not removed or weakened', () => {
  it('names the file and the assertion delta (corner row 40)', () => {
    const res = checkHardRules(input({
      files: [file('test/unit/store.test.ts', { removed: ['expect(a).toBe(1)', 'expect(b).toBe(2)', 'assert x', 'it("should hold")'], added: [] })],
    }));
    expect(rules(res)).toEqual([HARD_RULES.tests]);
    expect(reasons(res)).toEqual(['removed 4 assertions in test/unit/store.test.ts']);
  });

  it('a deleted test file is a violation on its own', () => {
    const res = checkHardRules(input({ files: [file('test/unit/store.test.ts', { status: 'D', removed: ['expect(a).toBe(1)'] })] }));
    expect(rules(res)).toEqual([HARD_RULES.tests]);
    expect(reasons(res)[0]).toBe('deleted the test file test/unit/store.test.ts');
  });

  /**
   * Review finding 7. `git mv src/foo.test.ts src/foo.old.ts` is one `R` entry whose `path`
   * matches no test glob: without `from` the rule never runs and the file leaves the suite.
   */
  it('a rename OUT of the test globs is a deletion, named by its source', () => {
    const res = checkHardRules(input({ files: [file('src/foo.old.ts', { status: 'R', from: 'src/foo.test.ts' })] }));
    expect(rules(res)).toEqual([HARD_RULES.tests]);
    expect(reasons(res)).toEqual(['deleted the test file src/foo.test.ts']);
  });

  it('a rename BETWEEN test paths is not a deletion, and is still measured for assertions', () => {
    expect(checkHardRules(input({ files: [file('test/unit/b.test.ts', { status: 'R', from: 'test/unit/a.test.ts' })] }))).toEqual({ ok: true });
    const weakened = checkHardRules(input({ files: [file('test/unit/b.test.ts', { status: 'R', from: 'test/unit/a.test.ts', removed: ['expect(a).toBe(1)'] })] }));
    expect(reasons(weakened)).toEqual(['removed 1 assertion in test/unit/b.test.ts']);
  });

  it('a rename INTO the test globs from a non-test path is not a deletion', () => {
    expect(checkHardRules(input({ files: [file('test/unit/a.test.ts', { status: 'A', from: 'src/scratch.ts' })] }))).toEqual({ ok: true });
  });

  it('a deleted NON-test file, and a test file that gains assertions, are fine', () => {
    const res = checkHardRules(input({
      files: [
        file('src/old.ts', { status: 'D', removed: ['assert(false)'] }),
        file('test/unit/new.test.ts', { status: 'A', added: ['expect(a).toBe(1)', 'expect(b).toBe(2)'] }),
      ],
    }));
    expect(res).toEqual({ ok: true });
  });

  it('property: a net decrease in assertion-shaped lines always fails, a net increase never does (40 cases)', () => {
    let s = 0x5eed >>> 0;
    const rand = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
    const shapes = ['expect(x).toBe(1)', '  assert x == 1', 'it("should work", …)', 'if t.Error("no") {}', '#[test]'];
    const noise = ['const a = 1;', '// a comment', 'return null;', ''];

    for (let c = 0; c < 40; c++) {
      const removedN = Math.floor(rand() * 6);
      const addedN = Math.floor(rand() * 6);
      const pick = (n: number): string[] => Array.from({ length: n }, () => shapes[Math.floor(rand() * shapes.length)] ?? 'assert');
      const added = [...pick(addedN), ...noise];
      const removed = [...pick(removedN), ...noise];
      expect(countAssertions(added)).toBe(addedN); // no line of `noise` is assertion-shaped
      const res = checkHardRules(input({ files: [file('test/unit/gen.test.ts', { added, removed })] }));
      if (removedN > addedN) {
        expect(reasons(res)).toEqual([`removed ${removedN - addedN} assertion${removedN - addedN === 1 ? '' : 's'} in test/unit/gen.test.ts`]);
      } else {
        expect(res).toEqual({ ok: true });
      }
    }
  });
});

describe('rule 2 — the collected test count does not drop', () => {
  it('fails naming both counts', () => {
    const res = checkHardRules(input({ counts: { before: { passed: 410, failed: 0, errors: 0, skipped: 2 }, after: { passed: 405, failed: 0, errors: 0, skipped: 2 } } }));
    expect(rules(res)).toEqual([HARD_RULES.counts]);
    expect(reasons(res)[0]).toBe('the collected test count dropped from 412 to 407');
  });

  it('an unparsed count is not a violation, and a rise is not a violation', () => {
    const counts = { passed: 1, failed: 0, errors: 0, skipped: 0 };
    expect(checkHardRules(input({ counts: { before: counts, after: null } }))).toEqual({ ok: true });
    expect(checkHardRules(input({ counts: { before: null, after: counts } }))).toEqual({ ok: true });
    expect(checkHardRules(input({ counts: { before: counts, after: { ...counts, passed: 2 } } }))).toEqual({ ok: true });
    expect(totalCount({ passed: 1, failed: 2, errors: 3, skipped: 4 })).toBe(10);
  });
});

describe('rule 3 — no .git, no submodule, no secretPaths, no syncedIgnored file', () => {
  it.each([
    ['.git/config', []],
    ['vendor/sub/x.c', ['vendor/sub']],
    ['.env', ['.env']],
    ['secrets/key.pem', ['secrets/']],
  ])('%s is refused', (path, forbidden) => {
    const res = checkHardRules(input({ files: [file(path)], forbidden }));
    expect(rules(res)).toEqual([HARD_RULES.forbidden]);
    expect(reasons(res)[0]).toContain(path);
  });

  it('a path that merely starts with the same characters is not forbidden', () => {
    expect(checkHardRules(input({ files: [file('.envrc'), file('vendor/subtle.c')], forbidden: ['.env', 'vendor/sub'] }))).toEqual({ ok: true });
  });
});

describe('rule 4 — the merge introduces no conflict markers', () => {
  it('hasConflictMarkers wants both fences', () => {
    expect(hasConflictMarkers('a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> theirs\n')).toBe(true);
    expect(hasConflictMarkers('a\n<<<<<<< HEAD\n')).toBe(false);
    expect(hasConflictMarkers('no markers here <<<<<<< inline\n')).toBe(false);
  });

  /** Review finding 14b: `conflict-marker-size` is settable per path in `.gitattributes`. */
  it('any marker size of seven or more is found, and `=======` alone is not a conflict', () => {
    expect(hasConflictMarkers('a\n<<<<<<<<<<< HEAD\nx\n===========\ny\n>>>>>>>>>>> theirs\n')).toBe(true);
    expect(hasConflictMarkers(`${'<'.repeat(41)} HEAD\nx\n${'>'.repeat(41)} theirs\n`)).toBe(true);
    expect(hasConflictMarkers('a\n<<<<<<< HEAD\nx\n|||||||\nz\n=======\ny\n>>>>>>> theirs\n')).toBe(true); // diff3 style
    expect(hasConflictMarkers('Heading\n=======\n\nBody\n')).toBe(false); // a Markdown setext rule
    expect(hasConflictMarkers('a\n>>>>>>>>>>> theirs\n')).toBe(false); // a closing fence alone
    expect(hasConflictMarkers('a\n<<<<<< six\nx\n>>>>>> six\n')).toBe(false); // six is not a fence
  });

  it('reports the paths the caller found', () => {
    const res = checkHardRules(input({ conflictMarkerPaths: ['src/a.ts', 'src/b.ts'] }));
    expect(rules(res)).toEqual([HARD_RULES.conflicts]);
    expect(reasons(res)[0]).toContain('src/a.ts, src/b.ts');
  });
});

describe('rule 5 — [G3] the pinned sha still matches at merge time', () => {
  it('a moved branch is a hard fail with the design\'s words', () => {
    const res = checkHardRules(input({ pinned: 'a'.repeat(40), pinnedNow: 'b'.repeat(40) }));
    expect(rules(res)).toEqual([HARD_RULES.pinned]);
    expect(reasons(res)[0]).toBe(BRANCH_MOVED);
  });

  it('every violation is reported, not only the first', () => {
    const res = checkHardRules(input({
      files: [file('test/a.test.ts', { status: 'D' }), file('.git/config')],
      counts: { before: { passed: 2, failed: 0, errors: 0, skipped: 0 }, after: { passed: 1, failed: 0, errors: 0, skipped: 0 } },
      conflictMarkerPaths: ['src/x.ts'],
      pinned: 'a'.repeat(40),
      pinnedNow: 'c'.repeat(40),
    }));
    expect(rules(res)).toEqual([HARD_RULES.tests, HARD_RULES.counts, HARD_RULES.forbidden, HARD_RULES.conflicts, HARD_RULES.pinned]);
  });
});

describe('[G8] outsideOwn and the include/drop question', () => {
  it('is changed ∩ complement(own) ∖ carried ∖ incidentalGlobs', async () => {
    const dir = worktree({ 'src/loop/engine.ts': 'the parent was mid-edit\n' });
    expect(await outsideOwn(dir, {
      changed: ['src/tui/Pane.tsx', 'package-lock.json', 'dist/x.js', 'src/loop/engine.ts', 'docs/NOTES.md'],
      own: ['src/tui/**'],
      syncedDirty: [syncedEntry('src/loop/engine.ts', 'the parent was mid-edit\n')],
      incidentalGlobs: ['docs/**'],
      fold: false,
    })).toEqual(['dist/x.js', 'package-lock.json']);
  });

  it('[D2] a 200-entry synced-dirty set produces ZERO escape prompts (corner row 19)', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 200; i++) files[`parent/f${i}.txt`] = `parent ${i}\n`;
    const dir = worktree(files);
    const paths = Object.keys(files);
    const outside = await outsideOwn(dir, {
      changed: paths,
      own: ['src/tui/**'],
      syncedDirty: paths.map((p) => syncedEntry(p, files[p] ?? '')),
      incidentalGlobs: [],
      fold: false,
    });
    expect(outside).toEqual([]);
    expect(buildIncludeDropQuestion('fix-store', outside)).toBeNull();
  });

  /**
   * Review finding 1. `carried` is the STILL-BYTE-IDENTICAL subset [D2], never the raw
   * `syncedDirty` path list: a parent-dirty file the agent rewrote outside its slice is in the
   * §2.6 commit set and in the diff, so it is exactly what the question exists to ask about.
   */
  it('reports a parent-dirty path the agent REWROTE outside its slice, and stays silent while it is untouched', async () => {
    const dir = worktree({ 'src/shared.ts': 'the agent rewrote it\n' });
    const input = {
      changed: ['src/shared.ts'],
      own: ['src/a/**'],
      syncedDirty: [{ path: 'src/shared.ts', sha256: 'x', mode: 420 }],
      incidentalGlobs: [],
      fold: false,
    };
    expect(await outsideOwn(dir, input)).toEqual(['src/shared.ts']);

    const untouched = worktree({ 'src/shared.ts': 'the parent was mid-edit\n' });
    expect(await outsideOwn(untouched, { ...input, syncedDirty: [syncedEntry('src/shared.ts', 'the parent was mid-edit\n')] })).toEqual([]);
  });

  it('a carried path the agent DELETED, and one the sync deleted, are judged by the same [D2] rule', async () => {
    const dir = worktree({});
    // the sync deleted it and the agent left it deleted: still carried
    expect(await outsideOwn(dir, { changed: ['gone.txt'], own: ['src/**'], syncedDirty: [{ path: 'gone.txt', sha256: '', mode: 0 }], incidentalGlobs: [], fold: false })).toEqual([]);
    // the sync wrote it and the agent removed it: no longer carried, so it is outside the slice
    expect(await outsideOwn(dir, { changed: ['was-here.txt'], own: ['src/**'], syncedDirty: [syncedEntry('was-here.txt', 'parent\n')], incidentalGlobs: [], fold: false })).toEqual(['was-here.txt']);
  });

  it('[14c] on a folding volume SRC/Shared.ts and src/shared.ts are one file', async () => {
    const dir = worktree({ 'src/shared.ts': 'parent\n' });
    const input = { changed: ['SRC/Shared.ts'], own: ['src/**'], syncedDirty: [], incidentalGlobs: [], fold: true };
    expect(await outsideOwn(dir, input)).toEqual([]);
    expect(await outsideOwn(dir, { ...input, fold: false })).toEqual(['SRC/Shared.ts']);
    // and the carried subtraction folds with it
    const carried = { changed: ['SRC/Shared.ts'], own: ['src/a/**'], syncedDirty: [syncedEntry('src/shared.ts', 'parent\n')], incidentalGlobs: [], fold: true };
    expect(await outsideOwn(dir, carried)).toEqual([]);
    expect(await outsideOwn(dir, { ...carried, fold: false })).toEqual(['SRC/Shared.ts']);
  });

  it('builds §4.8\'s exact string', () => {
    const q = buildIncludeDropQuestion('fix-store', ['package-lock.json', 'dist/x.js']);
    expect(q?.prompt).toBe('fix-store touched 2 files outside its slice (dist/x.js, package-lock.json) — [a] include them · [d] drop them from the merge · [x] refuse');
    expect(q?.choices).toEqual(['a', 'd', 'x']);
    expect(q?.lines).toEqual(['dist/x.js', 'package-lock.json']);
    expect(buildIncludeDropQuestion('a', ['only/one.ts'])?.prompt).toContain('touched 1 file outside its slice');
  });

  it('bounds the inline list', () => {
    const q = buildIncludeDropQuestion('a', ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']);
    expect(q?.prompt).toContain('(a.ts, b.ts, c.ts, d.ts, +2 more)');
    expect(q?.lines).toHaveLength(6);
  });

  it('an unparsable own glob owns nothing (it never widens ownership)', async () => {
    expect(await outsideOwn(worktree(), { changed: ['src/a.ts'], own: ['!src/**'], syncedDirty: [], incidentalGlobs: [], fold: false })).toEqual(['src/a.ts']);
  });
});

describe('corner row 41 — the flaky flag is reported, never acted on', () => {
  const reads = (cmd: string): string[] => (cmd === 'npm test' ? ['src/store.ts'] : []);

  it('is true only when the same command passed on THIS dock head and the merge touched nothing it reads', () => {
    const history = [{ command: 'npm test', dockHead: 'head1', ok: true }];
    expect(flakyFlag(history, { command: 'npm test', dockHead: 'head1', touched: ['src/tui/Pane.tsx'] }, reads)).toBe(true);
    expect(flakyFlag(history, { command: 'npm test', dockHead: 'head1', touched: ['src/store.ts'] }, reads)).toBe(false);
    expect(flakyFlag(history, { command: 'npm test', dockHead: 'head2', touched: [] }, reads)).toBe(false);
    expect(flakyFlag([{ command: 'npm test', dockHead: 'head1', ok: false }], { command: 'npm test', dockHead: 'head1', touched: [] }, reads)).toBe(false);
    expect(flakyFlag([], { command: 'npm test', dockHead: 'head1', touched: [] }, reads)).toBe(false);
  });
});

describe('verify output', () => {
  it('parses the counts through workspace/tests.ts', () => {
    expect(parseVerifyCounts('npx vitest run', ' Tests  1 failed | 2 passed | 1 skipped (4)\n')).toEqual({ passed: 2, failed: 1, errors: 0, skipped: 1 });
    expect(parseVerifyCounts('python -m pytest', '===== 3 passed, 1 skipped in 0.12s =====\n')).toEqual({ passed: 3, failed: 0, errors: 0, skipped: 1 });
    expect(parseVerifyCounts('npm run typecheck', 'no test output at all\n')).toBeNull();
    expect(parseVerifyCounts('npm test', '')).toBeNull();
    // vitest colours into a pipe (TERM passed through): the summary parses once its sequences are gone (core/ansi.ts)
    const coloured = '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m2 passed\u001b[39m\u001b[22m\u001b[90m (3)\u001b[39m\n';
    expect(parseVerifyCounts('npx vitest run', coloured)).toEqual({ passed: 2, failed: 1, errors: 0, skipped: 0 });
  });

  it('tailLines keeps the last n lines and drops the trailing blank', () => {
    expect(tailLines('a\nb\nc\n', 2)).toEqual(['b', 'c']);
    expect(tailLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(tailLines('')).toEqual([]);
    expect(tailLines('a\nb', 0)).toEqual([]);
    expect(tailLines(Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'))).toHaveLength(40);
  });
});
