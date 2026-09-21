/** TUI-DESIGN §12.6 / §19.0: pager selection (`GIT_PAGER=cat`, `LESS` untouched when set); openFullDiff is wave 2. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGER, INLINE_DIFF_MAX_LINES, openFullDiff, pagerArgv, selectPager } from '../../../src/undo/pager.js';

describe('selectPager (§12.6)', () => {
  it('$GIT_PAGER → $PAGER → less; core.pager is never consulted', () => {
    expect(selectPager({}, true)).toEqual({ command: 'less', env: { LESS: 'FRX', LESSCHARSET: 'utf-8' }, inline: false, source: 'default' });
    expect(selectPager({ PAGER: 'more' }, true)).toMatchObject({ command: 'more', source: 'PAGER', inline: false });
    expect(selectPager({ PAGER: 'more', GIT_PAGER: 'delta --dark' }, true)).toMatchObject({ command: 'delta --dark', source: 'GIT_PAGER', inline: false });
    // empty / blank values fall through
    expect(selectPager({ GIT_PAGER: '   ', PAGER: '' }, true)).toMatchObject({ command: DEFAULT_PAGER, source: 'default' });
  });

  it('GIT_PAGER=cat (or any cat) and a non-TTY stdout mean the inline block', () => {
    expect(selectPager({ GIT_PAGER: 'cat' }, true).inline).toBe(true);
    expect(selectPager({ PAGER: '/bin/cat' }, true).inline).toBe(true);
    expect(selectPager({ PAGER: 'cat -v' }, true).inline).toBe(true);
    expect(selectPager({ PAGER: 'concat' }, true).inline).toBe(false);
    expect(selectPager({}, false)).toMatchObject({ command: 'less', inline: true });
    expect(INLINE_DIFF_MAX_LINES).toBe(400);
  });

  it('LESS=FRX only when unset; LESSCHARSET=utf-8 only when unset', () => {
    expect(selectPager({ LESS: '-R' }, true).env).toEqual({ LESSCHARSET: 'utf-8' });
    expect(selectPager({ LESS: '' }, true).env).toEqual({ LESSCHARSET: 'utf-8' }); // set-but-empty is the user's choice
    expect(selectPager({ LESSCHARSET: 'latin1' }, true).env).toEqual({ LESS: 'FRX' });
    expect(selectPager({ LESS: 'X', LESSCHARSET: 'utf-8' }, true).env).toEqual({});
  });

  it('pagerArgv runs the command through /bin/sh -c with the file as $0 (never split)', () => {
    expect(pagerArgv(selectPager({ GIT_PAGER: 'delta --dark' }, true), '/tmp/run/tmp/diff-1.patch')).toEqual(['/bin/sh', '-c', 'delta --dark "$0"', '/tmp/run/tmp/diff-1.patch']);
    expect(pagerArgv(selectPager({}, true), '/a b/c.patch')[3]).toBe('/a b/c.patch');
  });

  it('openFullDiff throws `not wired in wave 1`', () => {
    expect(() => openFullDiff({ suspendTerminal: () => Promise.resolve(), env: {}, isTTY: true, patchFile: '/tmp/x' })).toThrow('not wired in wave 1');
  });
});
