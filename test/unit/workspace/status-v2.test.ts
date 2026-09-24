/**
 * TUI-DESIGN §19.0 (`status-v2.test.ts`): the ten porcelain-v2 line kinds, `(initial)`, `(detached)`, `S.M.`, torn output,
 * recorded fixtures (git 2.50.1) plus the hand-written grammar cases.
 */
import { describe, expect, it } from 'vitest';

import { UNTRACKED_XY, statusPorcelainV2 } from '../../../src/workspace/git.js';

// Recorded on 2026-09-20 with git 2.50.1: `git --no-optional-locks status --porcelain=v2 --branch --untracked-files=all -z`
const FIX = {
  unborn: '# branch.oid (initial)\u0000# branch.head main\u0000? new.txt\u0000',
  cleanAhead: '# branch.oid 0f83e1d4050d840005659d557d1dd1d227f6d595\u0000# branch.head main\u0000# branch.upstream origin/main\u0000# branch.ab +2 -0\u0000',
  dirtyMixed:
    '# branch.oid 0f83e1d4050d840005659d557d1dd1d227f6d595\u0000# branch.head main\u0000# branch.upstream origin/main\u0000# branch.ab +2 -0\u0000' +
    '1 .M N... 100644 100644 100644 78981922613b2afb6025042ff6bd878ac1994e85 78981922613b2afb6025042ff6bd878ac1994e85 a.txt\u0000' +
    '2 R. N... 100644 100644 100644 587be6b4c3f93f93c489c0111bba5596147a26cb 587be6b4c3f93f93c489c0111bba5596147a26cb R100 renamed.txt\u0000sp ace.txt\u0000' +
    '1 MM N... 100644 100644 100644 61780798228d17af2d34fce4cfbdf35556832472 089bb97f895a4112fab3f2d7746704c83cefca02 src/b.txt\u0000' +
    '? dir/inner.txt\u0000? untracked.txt\u0000',
  detached: '# branch.oid 574c5bf537df1e1d93cd291768ab33916bda77a4\u0000# branch.head (detached)\u0000',
  submodule:
    '# branch.oid eb007cb4e746e6c36f41ca717565109362998d3d\u0000# branch.head main\u0000' +
    '1 .M S.M. 160000 160000 160000 9b2bc11fd09c3db2b5d9576718421296f0567b77 9b2bc11fd09c3db2b5d9576718421296f0567b77 lib\u0000',
  unmerged:
    '# branch.oid 92cb06be77253f5745c781e6935cc28a73cfe97d\u0000# branch.head main\u0000' +
    'u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 ba2906d0666cf726c7eaadd2cd3db615dedfdf3a e45c9c2666d44e0327c1f9c239a74c508336053e f.txt\u0000',
  stash: '# branch.oid 0f83e1d4050d840005659d557d1dd1d227f6d595\u0000# branch.head main\u0000# branch.upstream origin/main\u0000# branch.ab +2 -0\u0000# stash 1\u0000? dir/inner.txt\u0000? untracked.txt\u0000',
  noBranch: '? dir/\u0000? untracked.txt\u0000',
  // hand-written from the documented grammar
  behind: '# branch.oid 0f83e1d4050d840005659d557d1dd1d227f6d595\u0000# branch.head main\u0000# branch.upstream origin/main\u0000# branch.ab +0 -3\u0000',
  ignored: '# branch.oid 0f83e1d4050d840005659d557d1dd1d227f6d595\u0000# branch.head main\u0000! build/out.o\u0000? a.txt\u0000',
};

describe('statusPorcelainV2 (§12.1): recorded fixtures', () => {
  it('unborn branch: (initial) oid, one untracked file', () => {
    const r = statusPorcelainV2(FIX.unborn);
    expect(r.head).toEqual({ kind: 'unborn', name: 'main' });
    expect(r.upstream).toBeNull();
    expect(r.ahead).toBeNull();
    expect(r.behind).toBeNull();
    expect(r.stash).toBeNull();
    expect(r.torn).toBe(false);
    expect(r.dirty).toEqual({ modified: 0, staged: 0, untracked: 1, renamed: 0, unmerged: 0, submodules: 0, entries: [{ xy: UNTRACKED_XY, sub: 'N...', path: 'new.txt' }] });
  });
  it('clean tree, 2 ahead of origin/main', () => {
    const r = statusPorcelainV2(FIX.cleanAhead);
    expect(r.head).toEqual({ kind: 'branch', name: 'main', oid: '0f83e1d4050d840005659d557d1dd1d227f6d595' });
    expect(r.upstream).toBe('origin/main');
    expect(r.ahead).toBe(2);
    expect(r.behind).toBe(0);
    expect(r.dirty.entries).toEqual([]);
    expect(r.dirty.modified + r.dirty.staged + r.dirty.untracked + r.dirty.renamed + r.dirty.unmerged + r.dirty.submodules).toBe(0);
    expect(r.torn).toBe(false);
  });
  it('mixed dirty tree: modified, staged+modified, rename with a space in the original path, untracked', () => {
    const r = statusPorcelainV2(FIX.dirtyMixed);
    expect(r.dirty.modified).toBe(2); // a.txt (.M) and src/b.txt (MM)
    expect(r.dirty.staged).toBe(2); // renamed.txt (R.) and src/b.txt (MM)
    expect(r.dirty.renamed).toBe(1);
    expect(r.dirty.untracked).toBe(2);
    expect(r.dirty.unmerged).toBe(0);
    expect(r.dirty.submodules).toBe(0);
    expect(r.dirty.entries.map((e) => e.path)).toEqual(['a.txt', 'renamed.txt', 'src/b.txt', 'dir/inner.txt', 'untracked.txt']);
    expect(r.dirty.entries[0]).toEqual({ xy: '.M', sub: 'N...', path: 'a.txt', hH: '78981922613b2afb6025042ff6bd878ac1994e85', hI: '78981922613b2afb6025042ff6bd878ac1994e85', mode: '100644' });
    expect(r.dirty.entries[1]).toEqual({ xy: 'R.', sub: 'N...', path: 'renamed.txt', from: 'sp ace.txt', hH: '587be6b4c3f93f93c489c0111bba5596147a26cb', hI: '587be6b4c3f93f93c489c0111bba5596147a26cb', mode: '100644' });
    expect(r.dirty.entries[2]!.xy).toBe('MM');
    expect(r.dirty.entries[2]!.hI).toBe('089bb97f895a4112fab3f2d7746704c83cefca02');
    expect(r.dirty.entries[3]).toEqual({ xy: '??', sub: 'N...', path: 'dir/inner.txt' });
    expect(r.torn).toBe(false);
  });
  it('detached HEAD', () => {
    const r = statusPorcelainV2(FIX.detached);
    expect(r.head).toEqual({ kind: 'detached', oid: '574c5bf537df1e1d93cd291768ab33916bda77a4' });
    expect(r.upstream).toBeNull();
    expect(r.dirty.entries).toEqual([]);
  });
  it('submodule with a modified work tree (S.M.)', () => {
    const r = statusPorcelainV2(FIX.submodule);
    expect(r.dirty.submodules).toBe(1);
    expect(r.dirty.modified).toBe(1);
    expect(r.dirty.staged).toBe(0);
    expect(r.dirty.entries[0]).toEqual({ xy: '.M', sub: 'S.M.', path: 'lib', hH: '9b2bc11fd09c3db2b5d9576718421296f0567b77', hI: '9b2bc11fd09c3db2b5d9576718421296f0567b77', mode: '160000' });
  });
  it('unmerged path (u UU) counts as unmerged only and carries no HEAD/index hashes', () => {
    const r = statusPorcelainV2(FIX.unmerged);
    expect(r.dirty.unmerged).toBe(1);
    expect(r.dirty.modified).toBe(0);
    expect(r.dirty.staged).toBe(0);
    expect(r.dirty.entries).toEqual([{ xy: 'UU', sub: 'N...', path: 'f.txt', mode: '100644' }]);
    expect('hH' in r.dirty.entries[0]!).toBe(false);
  });
  it('# stash header, behind count, ignored entries, output without --branch', () => {
    expect(statusPorcelainV2(FIX.stash).stash).toBe(1);
    expect(statusPorcelainV2(FIX.stash).dirty.untracked).toBe(2);
    const b = statusPorcelainV2(FIX.behind);
    expect(b.ahead).toBe(0);
    expect(b.behind).toBe(3);
    const ig = statusPorcelainV2(FIX.ignored);
    expect(ig.dirty.untracked).toBe(1);
    expect(ig.dirty.entries.map((e) => e.path)).toEqual(['a.txt']);
    expect(ig.torn).toBe(false);
    const nb = statusPorcelainV2(FIX.noBranch);
    expect(nb.head).toBeNull();
    expect(nb.upstream).toBeNull();
    expect(nb.dirty.untracked).toBe(2);
    expect(nb.dirty.entries[0]!.path).toBe('dir/');
  });
});

describe('statusPorcelainV2: edges and torn output', () => {
  it('empty and non-string input', () => {
    const r = statusPorcelainV2('');
    expect(r).toEqual({ head: null, upstream: null, ahead: null, behind: null, stash: null, dirty: { modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] }, torn: false });
    expect(statusPorcelainV2(undefined as unknown as string).torn).toBe(false);
  });
  it('a missing final NUL marks the listing torn but keeps the complete entries', () => {
    const cut = FIX.dirtyMixed.slice(0, FIX.dirtyMixed.lastIndexOf('? untracked') + 5);
    const r = statusPorcelainV2(cut);
    expect(r.torn).toBe(true);
    expect(r.dirty.entries.map((e) => e.path)).toEqual(['a.txt', 'renamed.txt', 'src/b.txt', 'dir/inner.txt']);
    expect(r.dirty.untracked).toBe(1);
    expect(r.head?.kind).toBe('branch');
  });
  it('a rename whose original path was cut off is dropped and reported torn', () => {
    const r = statusPorcelainV2('# branch.oid (initial)\u0000# branch.head main\u00002 R. N... 100644 100644 100644 ' + 'a'.repeat(40) + ' ' + 'a'.repeat(40) + ' R100 new.txt\u0000');
    expect(r.torn).toBe(true);
    expect(r.dirty.renamed).toBe(0);
    expect(r.dirty.entries).toEqual([]);
    expect(r.head).toEqual({ kind: 'unborn', name: 'main' });
  });
  it('garbage, unknown record kinds, malformed XY and unknown headers', () => {
    expect(statusPorcelainV2('hello').torn).toBe(true);
    const r = statusPorcelainV2('# branch.oid (initial)\u0000# branch.head main\u0000# future.header value\u0000x something\u00001 M N... 100644 100644 100644 h h p\u0000? ok.txt\u0000');
    expect(r.torn).toBe(true);
    expect(r.dirty.entries).toEqual([{ xy: '??', sub: 'N...', path: 'ok.txt' }]);
    expect(statusPorcelainV2('1 .M N... 100644\u0000').torn).toBe(true);
    expect(statusPorcelainV2('?\u0000').torn).toBe(true);
    expect(statusPorcelainV2('? \u0000').torn).toBe(true);
    expect(statusPorcelainV2('\u0000\u0000').torn).toBe(false);
  });
  it('non-numeric ahead/behind become null; odd head combinations degrade to unborn', () => {
    const r = statusPorcelainV2('# branch.oid abc\u0000# branch.head main\u0000# branch.upstream o/m\u0000# branch.ab +x -y\u0000');
    expect(r.ahead).toBeNull();
    expect(r.behind).toBeNull();
    expect(r.head).toEqual({ kind: 'branch', name: 'main', oid: null }); // a 3-char oid is not an oid
    expect(statusPorcelainV2('# branch.oid (initial)\u0000# branch.head (detached)\u0000').head).toEqual({ kind: 'unborn', name: 'HEAD' });
    expect(statusPorcelainV2('# branch.head (detached)\u0000').head).toEqual({ kind: 'unborn', name: 'HEAD' });
    expect(statusPorcelainV2('# branch.oid ' + 'c'.repeat(40) + '\u0000').head).toEqual({ kind: 'branch', name: 'HEAD', oid: 'c'.repeat(40) });
  });
  it('paths keep spaces, tabs, newlines and unicode verbatim under -z', () => {
    const weird = 'dir with spaces/ファイル\ttab\nline.txt';
    const r = statusPorcelainV2(`1 .M N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} ${weird}\u0000? ${weird}2\u0000`);
    expect(r.dirty.entries[0]!.path).toBe(weird);
    expect(r.dirty.entries[1]!.path).toBe(`${weird}2`);
    expect(r.torn).toBe(false);
  });
  it('a 20,000-entry listing parses quickly (lower-bound counts stay exact)', () => {
    let s = '# branch.oid ' + 'd'.repeat(40) + '\u0000# branch.head main\u0000';
    for (let i = 0; i < 10_000; i++) s += `1 .M N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} src/file-${i}.ts\u0000`;
    for (let i = 0; i < 10_000; i++) s += `? new/file-${i}.ts\u0000`;
    const t0 = performance.now();
    const r = statusPorcelainV2(s);
    const ms = performance.now() - t0;
    expect(r.dirty.modified).toBe(10_000);
    expect(r.dirty.untracked).toBe(10_000);
    expect(r.dirty.entries.length).toBe(20_000);
    expect(r.torn).toBe(false);
    process.stderr.write(`statusPorcelainV2: 20,000 entries in ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeLessThan(1500);
  });
});

describe('statusPorcelainV2: every XY kind and header shape (hand-written from the documented grammar)', () => {
  const H = 'a'.repeat(40);
  const Z = '0'.repeat(40);
  const HEAD = '# branch.oid ' + H + '\u0000# branch.head main\u0000';
  it('deletions: staged `D.` counts as staged, work-tree `.D` as modified', () => {
    const r = statusPorcelainV2(HEAD + `1 D. N... 100644 000000 000000 ${H} ${Z} gone.txt\u00001 .D N... 100644 100644 000000 ${H} ${H} lost.txt\u0000`);
    expect(r.dirty).toMatchObject({ staged: 1, modified: 1, untracked: 0, renamed: 0, unmerged: 0, submodules: 0 });
    expect(r.dirty.entries.map((e) => [e.xy, e.path])).toEqual([
      ['D.', 'gone.txt'],
      ['.D', 'lost.txt'],
    ]);
    expect(r.torn).toBe(false);
  });
  it('additions `A.` are staged; `AM` is staged and modified; `.T` (type change) is modified', () => {
    const r = statusPorcelainV2(HEAD + `1 A. N... 000000 100644 100644 ${Z} ${H} new.txt\u00001 AM N... 000000 100644 100644 ${Z} ${H} both.txt\u00001 .T N... 100644 100644 120000 ${H} ${H} link\u0000`);
    expect(r.dirty).toMatchObject({ staged: 2, modified: 2, untracked: 0 });
    expect(r.dirty.entries[2]).toEqual({ xy: '.T', sub: 'N...', path: 'link', hH: H, hI: H, mode: '120000' });
  });
  it('copies (`2 C.`) are `2` records like renames: counted in `renamed`, `from` carries the source', () => {
    const r = statusPorcelainV2(HEAD + `2 C. N... 100644 100644 100644 ${H} ${H} C100 copy.txt\u0000orig.txt\u0000`);
    expect(r.dirty).toMatchObject({ renamed: 1, staged: 1, modified: 0 });
    expect(r.dirty.entries[0]).toEqual({ xy: 'C.', sub: 'N...', path: 'copy.txt', from: 'orig.txt', hH: H, hI: H, mode: '100644' });
    expect(r.torn).toBe(false);
  });
  it('a submodule rename (`2 R. S...`) is a rename, staged and a submodule', () => {
    const r = statusPorcelainV2(HEAD + `2 R. S... 160000 160000 160000 ${H} ${H} R100 libs/new\u0000lib\u0000`);
    expect(r.dirty).toMatchObject({ renamed: 1, staged: 1, submodules: 1, modified: 0 });
    expect(r.dirty.entries[0]).toMatchObject({ xy: 'R.', sub: 'S...', path: 'libs/new', from: 'lib', mode: '160000' });
  });
  it('`# branch.upstream` without `# branch.ab` (upstream gone): the name is kept, ahead/behind unknown', () => {
    const r = statusPorcelainV2(HEAD + '# branch.upstream origin/feature\u0000');
    expect(r.upstream).toBe('origin/feature');
    expect(r.ahead).toBeNull();
    expect(r.behind).toBeNull();
    expect(r.torn).toBe(false);
  });
  it('`# branch.ab` with a missing second field: ahead parsed, behind null', () => {
    const r = statusPorcelainV2(HEAD + '# branch.upstream origin/main\u0000# branch.ab +2\u0000');
    expect(r.ahead).toBe(2);
    expect(r.behind).toBeNull();
    expect(statusPorcelainV2(HEAD + '# branch.ab \u0000').ahead).toBeNull();
    expect(statusPorcelainV2(HEAD + '# branch.ab\u0000').ahead).toBeNull();
  });
  it('a listing cut exactly at a NUL boundary is indistinguishable from a complete one (documented): counts are lower bounds, torn stays false', () => {
    const full = HEAD + `1 .M N... 100644 100644 100644 ${H} ${H} a.txt\u0000? b.txt\u0000? c.txt\u0000`;
    const cut = full.slice(0, full.lastIndexOf('? c.txt'));
    expect(cut.endsWith('\u0000')).toBe(true);
    const r = statusPorcelainV2(cut);
    expect(r.torn).toBe(false);
    expect(r.dirty.untracked).toBe(1);
    expect(r.dirty.modified).toBe(1);
    expect(statusPorcelainV2(full).dirty.untracked).toBe(2);
  });
  it('the ten line kinds in one listing', () => {
    const all =
      '# branch.oid ' + H + '\u0000# branch.head main\u0000# branch.upstream origin/main\u0000# branch.ab +1 -2\u0000# stash 3\u0000' +
      `1 .M N... 100644 100644 100644 ${H} ${H} a\u0000` +
      `2 R. N... 100644 100644 100644 ${H} ${H} R090 b\u0000b-old\u0000` +
      `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} c\u0000` +
      '? d\u0000! e\u0000';
    const r = statusPorcelainV2(all);
    expect(r).toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 2, stash: 3, torn: false });
    expect(r.head).toEqual({ kind: 'branch', name: 'main', oid: H });
    expect(r.dirty).toMatchObject({ modified: 1, staged: 1, renamed: 1, unmerged: 1, untracked: 1, submodules: 0 });
    expect(r.dirty.entries.map((e) => e.path)).toEqual(['a', 'b', 'c', 'd']);
  });
});
