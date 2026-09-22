import { describe, expect, it } from 'vitest';

import type { GitState, RunGitMeta } from '../../../src/core/types.js';
import { statusPorcelainV2 } from '../../../src/workspace/git.js';
import {
  GIT_PROBE_ARGS,
  bannerInput,
  buildGitState,
  gitBannerLine,
  headDriftWarning,
  headLabel,
  headMoved,
  notRepoReason,
  notRepoState,
  parseRevParse,
  shortOid,
  toRunGitMeta,
  toRunGitMetaEnd,
} from '../../../src/workspace/gitstate.js';

const AT = { probedAt: '2026-09-20T10:00:00.000Z', probeMs: 14 };
const OID = '7d731c0e9f2a4b5c6d7e8f9a0b1c2d3e4f5a6b7c';

function state(over: Partial<GitState> = {}): GitState {
  return {
    repo: true,
    gitDir: '/r/.git',
    commonDir: '/r/.git',
    topLevel: '/r',
    prefix: '',
    linkedWorktree: false,
    head: { kind: 'branch', name: 'main', oid: OID },
    upstream: 'origin/main',
    ahead: 2,
    behind: 0,
    dirty: { modified: 3, staged: 1, untracked: 1, renamed: 0, unmerged: 0, submodules: 0, entries: [] },
    ...AT,
    ...over,
  };
}

describe('GIT_PROBE_ARGS (§12.1)', () => {
  it('the two argument vectors are fixed: no --abbrev-ref, status is read-only and lock-free', () => {
    expect(GIT_PROBE_ARGS.revParse).toEqual(['rev-parse', '--is-inside-work-tree', '--show-prefix', '--absolute-git-dir', '--git-common-dir', '--show-toplevel']);
    expect(GIT_PROBE_ARGS.status).toEqual(['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
    expect([...GIT_PROBE_ARGS.revParse, ...GIT_PROBE_ARGS.status].join(' ')).not.toContain('abbrev-ref');
  });
});

describe('parseRevParse (§12.1)', () => {
  it('main work tree at the top level', () => {
    expect(parseRevParse('true\n\n/r/.git\n/r/.git\n/r\n', '/r')).toEqual({ insideWorkTree: true, prefix: '', gitDir: '/r/.git', commonDir: '/r/.git', topLevel: '/r', linkedWorktree: false });
  });
  it('subdirectory workspace: prefix with a trailing slash, relative common dir resolved against the root', () => {
    expect(parseRevParse('true\npkg/api/\n/r/.git\n../../.git\n/r\n', '/r/pkg/api')).toEqual({ insideWorkTree: true, prefix: 'pkg/api/', gitDir: '/r/.git', commonDir: '/r/.git', topLevel: '/r', linkedWorktree: false });
    expect(parseRevParse('true\npkg/api\n/r/.git\n/r/.git\n/r\n', '/r/pkg/api')?.prefix).toBe('pkg/api/');
  });
  it('linked worktree: git dir under the main checkout', () => {
    const f = parseRevParse('true\n\n/main/.git/worktrees/wt\n/main/.git\n/wt\n', '/wt');
    expect(f?.linkedWorktree).toBe(true);
    expect(f?.commonDir).toBe('/main/.git');
  });
  it('bare repository: `false` first, no top level (real output: `--show-toplevel` fails with exit 128 after four lines)', () => {
    const f = parseRevParse('false\n\n/b\n/b\n', '/b');
    expect(f?.insideWorkTree).toBe(false);
    expect(f?.gitDir).toBe('/b');
    expect(f?.topLevel).toBe('');
    expect(parseRevParse('false\n', '/b')).toBeNull();
    // recorded in a bare repo (cwd = the bare dir): `--git-common-dir` prints `.`
    const real = parseRevParse('false\n\n/private/tmp/bare.git\n.\n', '/private/tmp/bare.git');
    expect(real).toEqual({ insideWorkTree: false, prefix: '', gitDir: '/private/tmp/bare.git', commonDir: '/private/tmp/bare.git', topLevel: '', linkedWorktree: false });
    expect(buildGitState(real!, null, AT).reason).toBe('bare');
  });
  it('real linked-worktree output: the git dir sits under the main checkout, the common dir is the main .git', () => {
    const f = parseRevParse('true\n\n/Users/me/proj/.git/worktrees/wt\n/Users/me/proj/.git\n/Users/me/wt\n', '/Users/me/wt');
    expect(f).toEqual({ insideWorkTree: true, prefix: '', gitDir: '/Users/me/proj/.git/worktrees/wt', commonDir: '/Users/me/proj/.git', topLevel: '/Users/me/wt', linkedWorktree: true });
    const g = buildGitState(f!, null, AT);
    expect(g.linkedWorktree).toBe(true);
    expect(gitBannerLine(bannerInput(g)).text).toBe('git HEAD (linked worktree of /Users/me/proj) · clean');
  });
  it('a relative root is joined lexically (no process.cwd()): the common dir stays relative and cwd-independent', () => {
    const f = parseRevParse('true\npkg/\n/r/.git\n../.git\n/r\n', 'rel/pkg');
    expect(f?.commonDir).toBe('rel/.git');
    expect(f?.commonDir.startsWith('/')).toBe(false);
    expect(f?.commonDir.includes(process.cwd())).toBe(false);
    expect(f?.linkedWorktree).toBe(true);
    // a `.`/`..`-laden absolute common dir is normalised before the worktree comparison
    expect(parseRevParse('true\n\n/r/.git\n/r/sub/../.git\n/r\n', '/r/sub')?.linkedWorktree).toBe(false);
    expect(parseRevParse('true\nsub/\n/r/.git\n../.git\n/r\n', '/r/sub')?.commonDir).toBe('/r/.git');
  });
  it('rejects garbage, torn and unsafe output; tolerates CRLF and a missing final newline', () => {
    expect(parseRevParse('', '/r')).toBeNull();
    expect(parseRevParse('fatal: not a git repository\n', '/r')).toBeNull();
    expect(parseRevParse('true\n\n/r/.git\n', '/r')).toBeNull();
    expect(parseRevParse('true\n\nrelative/.git\n.git\n/r\n', '/r')).toBeNull();
    expect(parseRevParse('true\n../x/\n/r/.git\n/r/.git\n/r\n', '/r')).toBeNull();
    expect(parseRevParse('true\n/abs/\n/r/.git\n/r/.git\n/r\n', '/r')).toBeNull();
    expect(parseRevParse('true\r\n\r\n/r/.git\r\n/r/.git\r\n/r', '/r')?.topLevel).toBe('/r');
    expect(parseRevParse(undefined as unknown as string, '/r')).toBeNull();
  });
});

describe('buildGitState / notRepoState / toRunGitMeta', () => {
  it('assembles the run-start state from both probes', () => {
    const rev = parseRevParse('true\n\n/r/.git\n/r/.git\n/r\n', '/r')!;
    const porcelain = statusPorcelainV2('# branch.oid ' + OID + '\u0000# branch.head main\u0000# branch.upstream origin/main\u0000# branch.ab +2 -1\u00001 .M N... 100644 100644 100644 ' + 'a'.repeat(40) + ' ' + 'a'.repeat(40) + ' a.txt\u0000? u.txt\u0000');
    const g = buildGitState(rev, porcelain, AT);
    expect(g.repo).toBe(true);
    expect('reason' in g).toBe(false);
    expect(g.head).toEqual({ kind: 'branch', name: 'main', oid: OID });
    expect(g.upstream).toBe('origin/main');
    expect(g.ahead).toBe(2);
    expect(g.behind).toBe(1);
    expect(g.dirty.modified).toBe(1);
    expect(g.dirty.untracked).toBe(1);
    expect(g.dirty.entries.length).toBe(2);
    expect(g.probedAt).toBe(AT.probedAt);
    expect(g.probeMs).toBe(14);
    const noStatus = buildGitState(rev, null, { probedAt: AT.probedAt, probeMs: Number.NaN });
    expect(noStatus.head).toBeNull();
    expect(noStatus.dirty.entries).toEqual([]);
    expect(noStatus.probeMs).toBe(0);
  });
  it('a bare repository is not a usable repo', () => {
    const g = buildGitState(parseRevParse('false\n\n/b\n/b\n', '/b')!, null, AT);
    expect(g.repo).toBe(false);
    expect(g.reason).toBe('bare');
    expect(g.gitDir).toBeNull();
  });
  it('notRepoState carries the reason and nothing else', () => {
    const g = notRepoState('git-missing', AT);
    expect(g).toMatchObject({ repo: false, reason: 'git-missing', gitDir: null, commonDir: null, topLevel: null, prefix: '', linkedWorktree: false, head: null, upstream: null, ahead: null, behind: null });
    expect(g.dirty.entries).toEqual([]);
    expect(notRepoState('timeout', { probedAt: AT.probedAt, probeMs: -3 }).probeMs).toBe(0);
  });
  it('toRunGitMeta is bounded: no paths, no entries, the HEAD oid kept, ahead/behind and unmerged carried, no undefined-valued keys', () => {
    const m = toRunGitMeta(state());
    expect(m).toEqual({ repo: true, head: { kind: 'branch', name: 'main', oid: OID }, upstream: 'origin/main', linkedWorktree: false, prefix: '', ahead: 2, behind: 0, dirtyAtStart: { modified: 3, staged: 1, untracked: 1, unmerged: 0 } });
    expect(Object.values(m).some((v) => v === undefined)).toBe(false);
    expect('reason' in m).toBe(false);
    expect(Object.keys(m)).not.toContain('gitDir');
    expect(Object.keys(m)).not.toContain('entries');
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    const none = toRunGitMeta(notRepoState('not-a-repo', AT));
    expect(none.reason).toBe('not-a-repo');
    expect(none.dirtyAtStart).toEqual({ modified: 0, staged: 0, untracked: 0, unmerged: 0 });
    expect(none.ahead).toBeNull();
    expect(none.behind).toBeNull();
    const end = toRunGitMetaEnd(state({ ahead: 0, behind: 4 }));
    expect(end).toEqual({ head: { kind: 'branch', name: 'main', oid: OID }, upstream: 'origin/main', ahead: 0, behind: 4, dirty: { modified: 3, staged: 1, untracked: 1 } });
    const meta: RunGitMeta = { ...m, end };
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta);
  });
});

describe('gitBannerLine (§12.2)', () => {
  it('renders every §12.2 variant verbatim', () => {
    expect(gitBannerLine(bannerInput(state()))).toEqual({ text: 'git main ↑2 · 3 modified · 1 staged · 1 untracked', level: 'info' });
    expect(gitBannerLine(bannerInput(state({ head: { kind: 'detached', oid: OID }, upstream: null, ahead: null, behind: null, dirty: { modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] } }))).text).toBe('git detached 7d731c0e · clean');
    expect(
      gitBannerLine(bannerInput(state({ head: { kind: 'branch', name: 'wtbranch', oid: OID }, linkedWorktree: true, gitDir: '/Users/me/proj/.git/worktrees/wt', commonDir: '/Users/me/proj/.git', upstream: null, ahead: null, behind: null, dirty: { modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] } }))).text,
    ).toBe('git wtbranch (linked worktree of /Users/me/proj) · clean');
    expect(gitBannerLine(bannerInput(state({ head: { kind: 'unborn', name: 'main' }, upstream: null, ahead: null, behind: null, dirty: { modified: 0, staged: 0, untracked: 2, renamed: 0, unmerged: 0, submodules: 0, entries: [] } }))).text).toBe('git main (unborn, no commits yet) · 2 untracked');
    expect(gitBannerLine(bannerInput(state({ prefix: 'pkg/api/', upstream: null, ahead: null, behind: null, dirty: { modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] } }))).text).toBe('git main · in subdirectory pkg/api/ of the repository');
    // TUI-DESIGN-4 §3.6 / §3.7 G6 (D-V): ONE clause, not two saying the same thing, and the `none` token goes
    expect(gitBannerLine(bannerInput(notRepoState('not-a-repo', AT))).text).toBe('git · no repository — changes are not recoverable; /diff <step> compares pre-images');
    expect(gitBannerLine(bannerInput(notRepoState('bare', AT))).text).toBe('git · bare repository, no work tree — /diff <step> compares pre-images');
    expect(gitBannerLine(bannerInput(notRepoState('bare', AT)), { ascii: true }).text).toBe('git - bare repository, no work tree — /diff <step> compares pre-images');
    expect(notRepoReason(undefined)).toBe(notRepoReason('not-a-repo'));
    expect(gitBannerLine(bannerInput(notRepoState('git-missing', AT))).text).toBe('git · git not found on PATH — /diff <step> compares pre-images');
    // `timeout` covers every "dirty snapshot unknown" outcome (a status that timed out, failed or overflowed) until O1 adds a distinct reason
    expect(gitBannerLine(bannerInput(notRepoState('timeout', AT))).text).toBe('git · git status failed or timed out — /diff <step> compares pre-images');
    const unmerged = gitBannerLine(bannerInput(state({ upstream: null, ahead: null, behind: null, dirty: { modified: 412, staged: 0, untracked: 0, renamed: 0, unmerged: 1, submodules: 0, entries: [] } })));
    expect(unmerged).toEqual({ text: 'git main · 412 modified · working tree has unmerged paths (u) — commands may fail on conflict markers', level: 'warn' });
  });
  it('ahead and behind, ASCII twin, dirty subdirectory, bounded meta only', () => {
    expect(gitBannerLine(bannerInput(state({ behind: 1 }))).text).toBe('git main ↑2 ↓1 · 3 modified · 1 staged · 1 untracked');
    expect(gitBannerLine(bannerInput(state({ behind: 1 })), { ascii: true }).text).toBe('git main ^2 v1 - 3 modified - 1 staged - 1 untracked');
    expect(gitBannerLine(bannerInput(state({ ahead: 0, behind: 0 }))).text).toBe('git main · 3 modified · 1 staged · 1 untracked');
    expect(gitBannerLine(bannerInput(state({ prefix: 'pkg/', ahead: 0 }))).text).toBe('git main · 3 modified · 1 staged · 1 untracked · in subdirectory pkg/ of the repository');
    // the workspace event carries RunGitMeta: ahead/behind and unmerged ride along, the worktree path does not
    expect(gitBannerLine(toRunGitMeta(state())).text).toBe('git main ↑2 · 3 modified · 1 staged · 1 untracked');
    expect(gitBannerLine(toRunGitMeta(state({ behind: 1 }))).text).toBe('git main ↑2 ↓1 · 3 modified · 1 staged · 1 untracked');
    expect(gitBannerLine(toRunGitMeta(state({ linkedWorktree: true, ahead: 0, dirty: { modified: 0, staged: 0, untracked: 0, renamed: 0, unmerged: 0, submodules: 0, entries: [] } }))).text).toBe('git main (linked worktree) · clean');
    expect(gitBannerLine(toRunGitMeta(state({ head: null }))).text).toBe('git HEAD ↑2 · 3 modified · 1 staged · 1 untracked');
    const fromMeta = gitBannerLine(toRunGitMeta(state({ upstream: null, dirty: { modified: 4, staged: 0, untracked: 0, renamed: 0, unmerged: 1, submodules: 0, entries: [] } })));
    expect(fromMeta).toEqual({ text: 'git main · 4 modified · working tree has unmerged paths (u) — commands may fail on conflict markers', level: 'warn' });
    // a run.json written before the additive fields existed: no ahead/behind, no unmerged → info, no arrows
    const legacy: RunGitMeta = { repo: true, head: { kind: 'branch', name: 'main', oid: OID }, upstream: 'origin/main', linkedWorktree: false, prefix: '', dirtyAtStart: { modified: 3, staged: 1, untracked: 1 } };
    expect(gitBannerLine(legacy)).toEqual({ text: 'git main · 3 modified · 1 staged · 1 untracked', level: 'info' });
    const unmergedAscii = gitBannerLine({ ...toRunGitMeta(state()), unmerged: 2 }, { ascii: true });
    expect(unmergedAscii.level).toBe('warn');
    expect(unmergedAscii.text).toContain('(u) - commands may fail');
  });
});

describe('head helpers', () => {
  it('shortOid, headLabel, the P52 drift warning and headMoved', () => {
    expect(shortOid(OID)).toBe('7d731c0e');
    expect(shortOid('abc')).toBe('abc');
    expect(headLabel(null)).toBe('HEAD');
    expect(headLabel({ kind: 'branch', name: 'main', oid: OID })).toBe('main');
    expect(headLabel({ kind: 'detached', oid: OID })).toBe('7d731c0e');
    expect(headLabel({ kind: 'unborn', name: 'main' })).toBe('main');
    expect(headDriftWarning({ kind: 'detached', oid: OID }, { kind: 'detached', oid: '91ab3c4d' + '0'.repeat(32) })).toBe('warning: HEAD was 7d731c0e at run start, now 91ab3c4d — the plan may not apply');
    const a = { kind: 'branch' as const, name: 'main', oid: OID };
    expect(headMoved(a, { ...a })).toBe(false);
    expect(headMoved(a, { ...a, oid: 'f'.repeat(40) })).toBe(true);
    expect(headMoved(a, { kind: 'detached', oid: OID })).toBe(false); // same commit, detached: nothing moved
    expect(headMoved(a, { kind: 'branch', name: 'other', oid: null })).toBe(true);
    // no oid on one side: the kind and label decide
    const unknownOid = { kind: 'branch' as const, name: 'main', oid: null };
    expect(headMoved(unknownOid, { kind: 'detached', oid: OID })).toBe(true);
    expect(headMoved({ kind: 'detached', oid: OID }, unknownOid)).toBe(true);
    expect(headMoved(unknownOid, { kind: 'branch', name: 'main', oid: OID })).toBe(false);
    expect(headMoved(unknownOid, { kind: 'branch', name: 'main', oid: null })).toBe(false);
    expect(headMoved(unknownOid, { kind: 'unborn', name: 'main' })).toBe(true);
    expect(headMoved({ kind: 'unborn', name: 'main' }, { kind: 'unborn', name: 'main' })).toBe(false);
    expect(headMoved({ kind: 'unborn', name: 'main' }, a)).toBe(true);
    expect(headMoved(null, null)).toBe(false);
    expect(headMoved(null, a)).toBe(true);
  });
});
