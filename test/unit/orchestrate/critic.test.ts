/**
 * `src/orchestrate/critic.ts` — the five §5.3 hard rules, the [G8] include/drop question and the
 * corner-row-41 flaky flag. Pure: no git, no clock, no I/O.
 *
 * Corner row 40 ("the diff deletes tests or drops the collected count") is asserted as a property
 * over generated test diffs with a seeded PRNG written inline.
 */
import { describe, expect, it } from 'vitest';

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
  return { path, status: 'M', added: [], removed: [], ...over };
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
  const synced = (paths: readonly string[]): SyncedDirtyEntry[] => paths.map((p) => ({ path: p, sha256: 'f'.repeat(64), mode: 0o644 }));

  it('is changed ∩ complement(own) ∖ syncedDirty ∖ incidentalGlobs', () => {
    expect(outsideOwn({
      changed: ['src/tui/Pane.tsx', 'package-lock.json', 'dist/x.js', 'src/loop/engine.ts', 'docs/NOTES.md'],
      own: ['src/tui/**'],
      syncedDirty: synced(['src/loop/engine.ts']),
      incidentalGlobs: ['docs/**'],
    })).toEqual(['dist/x.js', 'package-lock.json']);
  });

  it('[D2] a 200-entry synced-dirty set produces ZERO escape prompts (corner row 19)', () => {
    const paths = Array.from({ length: 200 }, (_, i) => `parent/f${i}.txt`);
    const outside = outsideOwn({ changed: paths, own: ['src/tui/**'], syncedDirty: synced(paths), incidentalGlobs: [] });
    expect(outside).toEqual([]);
    expect(buildIncludeDropQuestion('fix-store', outside)).toBeNull();
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

  it('an unparsable own glob owns nothing (it never widens ownership)', () => {
    expect(outsideOwn({ changed: ['src/a.ts'], own: ['!src/**'], syncedDirty: [], incidentalGlobs: [] })).toEqual(['src/a.ts']);
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
  });

  it('tailLines keeps the last n lines and drops the trailing blank', () => {
    expect(tailLines('a\nb\nc\n', 2)).toEqual(['b', 'c']);
    expect(tailLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(tailLines('')).toEqual([]);
    expect(tailLines('a\nb', 0)).toEqual([]);
    expect(tailLines(Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'))).toHaveLength(40);
  });
});
