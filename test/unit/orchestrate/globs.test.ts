/**
 * The `own` sub-language (ORCHESTRATION-DESIGN §3.4 rule 2, §8.2 D1 item 7) and the disjointness
 * that rule 3 calls "the whole safety argument". Corner row 2's hostile fixtures live here.
 */
import { describe, expect, it } from 'vitest';

import {
  collapseOwn,
  containsGlob,
  dedupeContained,
  disjoint,
  matchesOwn,
  overlaps,
  ownStrings,
  ownsPath,
  parseOwnGlob,
  validateOwnList,
} from '../../../src/orchestrate/split/globs.js';
import type { OwnGlob } from '../../../src/orchestrate/split/globs.js';

function g(raw: string): OwnGlob {
  const r = parseOwnGlob(raw);
  if (!r.ok) throw new Error(`fixture "${raw}" did not parse: ${r.reason}`);
  return r.glob;
}

describe('parseOwnGlob: the four legal forms', () => {
  it.each([
    ['src/tui/Pane.tsx', 'file', 'src/tui/Pane.tsx', null],
    ['src/tui/', 'tree', 'src/tui', null],
    ['src/tui/**', 'tree', 'src/tui', null],
    ['src/tui/*.tsx', 'ext', 'src/tui', '.tsx'],
    ['*.md', 'ext', '', '.md'],
    ['src/a/b/c.test.ts', 'file', 'src/a/b/c.test.ts', null],
  ])('%s parses as %s', (raw, kind, dir, ext) => {
    const r = parseOwnGlob(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.glob.kind).toBe(kind);
    expect(r.glob.dir).toBe(dir);
    expect(r.glob.ext).toBe(ext);
    expect(r.glob.raw).toBe(raw);
  });
});

describe('parseOwnGlob: corner row 2 hostile fixtures', () => {
  it.each([
    ['../x', 'escapes the repo with ..'],
    ['src/../../etc/passwd', 'escapes the repo with ..'],
    ['/etc/passwd', 'absolute'],
    ['C:\\Windows\\x', 'absolute windows'],
    ['!src/a.ts', 'a negation'],
    ['src/{a,b}/**', 'a brace expansion'],
    ['src/?.ts', 'a character the sub-language does not allow'],
    ['src/[slug].tsx', 'a bracket'],
    ['**', 'the whole repository'],
    ['/**', 'the whole repository'],
    ['/', 'the whole repository'],
    ['src//a.ts', 'an empty path segment'],
    ['src/**/*.ts', 'a nested star'],
    ['src/*', 'a bare star'],
    ['', 'empty'],
    ['src', 'no extension and no trailing slash'],
    ['src/a.ts\0b', 'a NUL'],
    [`src/${'a'.repeat(300)}.ts`, 'too long'],
  ])('refuses %j', (raw) => {
    expect(parseOwnGlob(raw).ok).toBe(false);
  });

  it('gives a reason a human can read', () => {
    const r = parseOwnGlob('../x');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('..');
  });

  it('NFC-normalises, so two spellings of one name are one owner', () => {
    const composed = parseOwnGlob('src/caf\u00e9/');
    const decomposed = parseOwnGlob('src/cafe\u0301/');
    expect(composed.ok && decomposed.ok).toBe(true);
    if (!composed.ok || !decomposed.ok) return;
    expect(composed.glob.dir).toBe(decomposed.glob.dir);
    expect(overlaps(composed.glob, decomposed.glob)).toBe(true);
  });
});

describe('matchesOwn / ownsPath', () => {
  it('a tree owns everything under it, recursively, and not the directory entry itself', () => {
    expect(matchesOwn(g('src/tui/**'), 'src/tui/Pane.tsx')).toBe(true);
    expect(matchesOwn(g('src/tui/**'), 'src/tui/pane/model.ts')).toBe(true);
    expect(matchesOwn(g('src/tui/'), 'src/tui/pane/model.ts')).toBe(true);
    expect(matchesOwn(g('src/tui/**'), 'src/tuix/Pane.tsx')).toBe(false);
    expect(matchesOwn(g('src/tui/**'), 'src/tui')).toBe(false);
  });

  it('an ext glob is one directory level only', () => {
    expect(matchesOwn(g('src/tui/*.tsx'), 'src/tui/Pane.tsx')).toBe(true);
    expect(matchesOwn(g('src/tui/*.tsx'), 'src/tui/pane/Model.tsx')).toBe(false);
    expect(matchesOwn(g('src/tui/*.tsx'), 'src/tui/Pane.ts')).toBe(false);
    expect(matchesOwn(g('*.md'), 'README.md')).toBe(true);
    expect(matchesOwn(g('*.md'), 'docs/README.md')).toBe(false);
    expect(matchesOwn(g('src/*.ts'), 'src/.ts')).toBe(false);
  });

  it('a file glob is exactly one path', () => {
    expect(matchesOwn(g('src/a.ts'), 'src/a.ts')).toBe(true);
    expect(matchesOwn(g('src/a.ts'), 'src/a.ts.bak')).toBe(false);
  });

  it('folds case only when the volume folds', () => {
    expect(matchesOwn(g('src/Tui/**'), 'src/tui/a.ts')).toBe(false);
    expect(matchesOwn(g('src/Tui/**'), 'src/tui/a.ts', true)).toBe(true);
  });

  it('ownsPath is the disjunction over the list', () => {
    const own = [g('src/a/**'), g('test/b.test.ts')];
    expect(ownsPath(own, 'src/a/x.ts')).toBe(true);
    expect(ownsPath(own, 'test/b.test.ts')).toBe(true);
    expect(ownsPath(own, 'src/c/x.ts')).toBe(false);
  });
});

describe('containment and disjointness (rule 3)', () => {
  it('dir/** contains a file and a deeper tree', () => {
    expect(containsGlob(g('src/**'), g('src/a.ts'))).toBe(true);
    expect(containsGlob(g('src/**'), g('src/a/**'))).toBe(true);
    expect(containsGlob(g('src/**'), g('src/**'))).toBe(true);
    expect(containsGlob(g('src/a/**'), g('src/**'))).toBe(false);
  });

  it('dir/ and dir/** are the same tree written two ways', () => {
    expect(containsGlob(g('src/'), g('src/**'))).toBe(true);
    expect(containsGlob(g('src/**'), g('src/'))).toBe(true);
  });

  it('dir/*.ext contains the file it matches and nothing deeper', () => {
    expect(containsGlob(g('src/*.ts'), g('src/a.ts'))).toBe(true);
    expect(containsGlob(g('src/*.ts'), g('src/a/b.ts'))).toBe(false);
  });

  it('two disjoint slices are disjoint; one shared file is not', () => {
    expect(disjoint([g('src/tui/**')], [g('src/loop/**')])).toEqual({ ok: true });
    const clash = disjoint([g('src/tui/**')], [g('src/tui/Pane.tsx')]);
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.left).toBe('src/tui/**');
    expect(clash.right).toBe('src/tui/Pane.tsx');
  });

  it('two ext globs over one directory whose suffixes nest overlap', () => {
    expect(overlaps(g('src/*.ts'), g('src/*.test.ts'))).toBe(true);
    expect(overlaps(g('src/*.ts'), g('src/*.py'))).toBe(false);
    expect(overlaps(g('src/*.ts'), g('lib/*.test.ts'))).toBe(false);
  });

  it('on a folding volume src/A/** and src/a/** are the same slice', () => {
    expect(disjoint([g('src/A/**')], [g('src/a/**')]).ok).toBe(true);
    expect(disjoint([g('src/A/**')], [g('src/a/**')], true).ok).toBe(false);
  });
});

describe('prefix collapse', () => {
  it('drops what another glob already contains, keeping input order', () => {
    const out = dedupeContained([g('src/a.ts'), g('src/**'), g('test/b.ts')]);
    expect(ownStrings(out)).toEqual(['src/**', 'test/b.ts']);
  });

  it('collapses siblings into their parent tree to reach the cap', () => {
    const many = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((n) => g(`src/pane/${n}`));
    const out = collapseOwn(many, 2);
    expect(out.length).toBeLessThanOrEqual(2);
    expect(ownStrings(out)).toContain('src/pane/**');
    for (const n of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) expect(ownsPath(out, `src/pane/${n}`)).toBe(true);
  });

  it('never collapses to the repository root', () => {
    const out = collapseOwn([g('a.ts'), g('b.ts'), g('c.ts')], 1);
    expect(ownStrings(out)).not.toContain('**');
    expect(ownStrings(out)).not.toContain('/**');
  });

  it('is a no-op below the cap', () => {
    const input = [g('src/a/**'), g('src/b/**')];
    expect(ownStrings(collapseOwn(input, 32))).toEqual(['src/a/**', 'src/b/**']);
  });
});

describe('validateOwnList', () => {
  it('refuses an empty list: every agent must own something', () => {
    const r = validateOwnList([]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('own is empty');
  });

  it('refuses the git directory', () => {
    expect(validateOwnList(['.git/**']).ok).toBe(false);
    expect(validateOwnList(['.git/config']).ok).toBe(false);
  });

  it('refuses a denied prefix in either direction (submodule, secretPath)', () => {
    expect(validateOwnList(['vendor/sub/**'], { deny: ['vendor/sub'] }).ok).toBe(false);
    expect(validateOwnList(['vendor/**'], { deny: ['vendor/sub'] }).ok).toBe(false);
    expect(validateOwnList(['src/**'], { deny: ['vendor/sub'] }).ok).toBe(true);
  });

  it('collapses before applying the cap, and reports the count when it still does not fit', () => {
    const wide = Array.from({ length: 40 }, (_, i) => `d${i}/x.ts`);
    const r = validateOwnList(wide, { max: 4 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('after prefix-collapse');
  });

  it('propagates a parse reason verbatim', () => {
    const r = validateOwnList(['src/ok/**', '../escape.ts']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('..');
  });
});
