/**
 * TUI-DESIGN §19.0 (`sandbox` row) / §12.7 (A149): `ProfileOptions.gitDir`/`gitCommonDir` — writes allowed under a
 * git dir outside the workspace, the `config`/`hooks`/`config.worktree`/`modules/*` denies at the common dir, the
 * main-tree snapshot byte-identical without the options, the profile-path hash extended only when they are given —
 * plus the real sandbox-exec behaviour on darwin (a linked worktree can commit; the knobs stay unwritable).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalPathSync } from '../../../src/sandbox/paths.js';
import { createSandbox } from '../../../src/sandbox/run.js';
import { buildProfile, regexQuote, sbplRegex, sbplString } from '../../../src/sandbox/seatbelt.js';
import type { ProfileOptions } from '../../../src/sandbox/seatbelt.js';
import { FAST_KILL, makeTemp, never } from './helpers.js';

const darwin = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const CAP = 50_000;

let cleanups: Array<() => void> = [];
function temp(prefix: string): string {
  const t = makeTemp(prefix);
  cleanups.push(t.cleanup);
  return t.dir;
}
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function fixture(dir: string): { base: ProfileOptions; ws: string; home: string } {
  const ws = join(dir, 'ws');
  mkdirSync(join(ws, '.git', 'hooks'), { recursive: true });
  mkdirSync(join(dir, 'run', 'tmp'), { recursive: true });
  mkdirSync(join(dir, 'run', 'home'), { recursive: true });
  const home = join(dir, 'home');
  mkdirSync(home);
  return { ws, home, base: { ws, runTmp: join(dir, 'run', 'tmp'), runHome: join(dir, 'run', 'home'), ttyPath: '/dev/ttys004', readDenies: [], noNetwork: false, home } };
}

function denyLine(profile: string): string {
  const line = profile.split('\n').find((l) => l.startsWith('(deny file-write* (literal'));
  expect(line, 'git deny line present').toBeDefined();
  return line!;
}
function allowLine(profile: string): string {
  return profile.split('\n').find((l) => l.startsWith('(allow file-write*'))!;
}

/**
 * IMPORT-DESIGN §2.11 [G2.1]: the three workspace-memory write denies are appended to `gitDenies`,
 * so in the emitted line they sit after the git fragments and before the tty literal. The §12.7
 * assertions below are exact-line, so they carry the fragment rather than loosening to `toContain`.
 */
function memoryDenies(ws: string): string {
  return ['memory', 'rules', 'commands']
    .map((n) => {
      const p = canonicalPathSync(join(ws, '.jevcode', n));
      return `(literal ${sbplString(p)}) (subpath ${sbplString(p)})`;
    })
    .join(' ');
}

describe('buildProfile gitDir / gitCommonDir (§12.7)', () => {
  it('no option → the main-tree snapshot is byte-identical to today: two denies, no config.worktree, no modules regex', () => {
    const { base, ws } = fixture(temp('jev-sbg-'));
    const p = buildProfile(base);
    expect(denyLine(p)).toBe(
      `(deny file-write* (literal ${sbplString(join(ws, '.git', 'config'))}) (subpath ${sbplString(join(ws, '.git', 'hooks'))}) ${memoryDenies(ws)} (literal "/dev/ttys004"))`,
    );
    expect(p).not.toContain('config.worktree');
    expect(p).not.toContain('modules');
    expect(p).not.toContain('worktrees');
    expect(p).not.toContain('(regex #"^/private') ;
    expect(allowLine(p)).toBe(`(allow file-write* (subpath ${sbplString(ws)}) (subpath ${sbplString(base.runTmp)}) (subpath ${sbplString(base.runHome)})`);
    // an explicitly empty option behaves like none
    expect(buildProfile({ ...base, gitDir: '', gitCommonDir: '' })).toBe(p);
  });

  it('main tree with gitDir = <ws>/.git: no extra write root, the denies move to the richer set with the modules regexes', () => {
    const { base, ws } = fixture(temp('jev-sbg-'));
    const gitDir = join(ws, '.git');
    const p = buildProfile({ ...base, gitDir, gitCommonDir: gitDir });
    expect(allowLine(p)).toBe(allowLine(buildProfile(base)));
    const modules = regexQuote(join(gitDir, 'modules'));
    const worktrees = regexQuote(join(gitDir, 'worktrees'));
    expect(denyLine(p)).toBe(
      `(deny file-write* (literal ${sbplString(join(gitDir, 'config'))}) (subpath ${sbplString(join(gitDir, 'hooks'))}) (literal ${sbplString(join(gitDir, 'config.worktree'))}) ` +
        `(regex #"^${worktrees}/[^/]+/config\\.worktree$") (regex #"^${modules}/.+/config$") (regex #"^${modules}/.+/hooks(/.*)?$") ` +
        `${memoryDenies(ws)} (literal "/dev/ttys004"))`,
    );
    // one backslash per metacharacter: `.git` → `\.git` (a doubled backslash would silently never match)
    expect(denyLine(p)).toContain('/\\.git/modules/.+/config$');
    expect(denyLine(p)).not.toContain('\\\\.git');
    // only gitDir or only gitCommonDir given: the other defaults to it
    expect(buildProfile({ ...base, gitDir })).toBe(p);
    expect(buildProfile({ ...base, gitCommonDir: gitDir })).toBe(p);
  });

  it('linked worktree: gitDir and commonDir outside the workspace become one write root (nested dropped), denies at the common dir', () => {
    const dir = temp('jev-sbg-');
    const { base, ws } = fixture(dir);
    const main = join(dir, 'main');
    const commonDir = join(main, '.git');
    const gitDir = join(commonDir, 'worktrees', 'wt');
    mkdirSync(gitDir, { recursive: true });
    const p = buildProfile({ ...base, gitDir, gitCommonDir: commonDir });
    expect(allowLine(p)).toBe(`(allow file-write* (subpath ${sbplString(ws)}) (subpath ${sbplString(base.runTmp)}) (subpath ${sbplString(base.runHome)}) (subpath ${sbplString(commonDir)})`);
    expect(p.split(`(subpath ${sbplString(gitDir)})`).length - 1).toBe(0);
    expect(denyLine(p)).toContain(`(literal ${sbplString(join(commonDir, 'config'))})`);
    expect(denyLine(p)).toContain(`(subpath ${sbplString(join(commonDir, 'hooks'))})`);
    expect(denyLine(p)).toContain(`(literal ${sbplString(join(gitDir, 'config.worktree'))})`);
    expect(denyLine(p)).toContain(`(regex ${sbplRegex(`^${regexQuote(join(commonDir, 'modules'))}/.+/config$`)})`);
    // fix-pass finding 4: every OTHER worktree's per-worktree config under the (writable) common dir is denied too
    expect(denyLine(p)).toContain(`(regex ${sbplRegex(`^${regexQuote(join(commonDir, 'worktrees'))}/[^/]+/config\\.worktree$`)})`);
    expect(denyLine(p)).not.toContain(join(ws, '.git'));
    // the common dir is also readable in full (a writable root re-allows file-read-data under the jevcode home deny)
    expect(p.split(`(subpath ${sbplString(commonDir)})`).length - 1).toBe(3);
    // ordering: the write allow precedes the denies (later rules win)
    expect(p.indexOf('(allow file-write*')).toBeLessThan(p.indexOf('config.worktree'));
  });

  it('subdirectory workspace: the repository .git above the workspace is a write root', () => {
    const dir = temp('jev-sbg-');
    const repo = join(dir, 'repo');
    const ws = join(repo, 'pkg', 'api');
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(dir, 'run', 'tmp'), { recursive: true });
    mkdirSync(join(dir, 'run', 'home'), { recursive: true });
    const home = join(dir, 'home');
    mkdirSync(home);
    const p = buildProfile({ ws, runTmp: join(dir, 'run', 'tmp'), runHome: join(dir, 'run', 'home'), ttyPath: null, readDenies: [], noNetwork: false, home, gitDir: join(repo, '.git'), gitCommonDir: join(repo, '.git') });
    expect(allowLine(p)).toContain(`(subpath ${sbplString(join(repo, '.git'))})`);
    expect(denyLine(p)).toBe(
      `(deny file-write* (literal ${sbplString(join(repo, '.git', 'config'))}) (subpath ${sbplString(join(repo, '.git', 'hooks'))}) (literal ${sbplString(join(repo, '.git', 'config.worktree'))}) ` +
        `(regex #"^${regexQuote(join(repo, '.git', 'worktrees'))}/[^/]+/config\\.worktree$") ` +
        `(regex #"^${regexQuote(join(repo, '.git', 'modules'))}/.+/config$") (regex #"^${regexQuote(join(repo, '.git', 'modules'))}/.+/hooks(/.*)?$") ` +
        `${memoryDenies(ws)})`,
    );
  });

  it('paths are canonicalised (a symlinked git dir appears by its realpath); a git dir under an extra root adds nothing', () => {
    const dir = temp('jev-sbg-');
    const { base } = fixture(dir);
    const realGit = join(dir, 'real-git');
    mkdirSync(realGit);
    symlinkSync(realGit, join(dir, 'git-link'));
    const p = buildProfile({ ...base, gitDir: join(dir, 'git-link') });
    expect(p).toContain(`(subpath ${sbplString(realGit)})`);
    expect(p).not.toContain('git-link');
    const aux = join(dir, 'aux');
    mkdirSync(join(aux, '.git'), { recursive: true });
    const q = buildProfile({ ...base, extraWritable: [aux], gitDir: join(aux, '.git') });
    expect(allowLine(q)).toBe(`(allow file-write* (subpath ${sbplString(base.ws)}) (subpath ${sbplString(base.runTmp)}) (subpath ${sbplString(base.runHome)}) (subpath ${sbplString(aux)})`);
  });

  it('other worktrees\' config.worktree: one regex under the common dir, also for a main tree (their git dirs live inside <ws>/.git)', () => {
    const dir = temp('jev-sbg-');
    const { base, ws } = fixture(dir);
    const gitDir = join(ws, '.git');
    const p = buildProfile({ ...base, gitDir, gitCommonDir: gitDir });
    const rule = `(regex ${sbplRegex(`^${regexQuote(join(gitDir, 'worktrees'))}/[^/]+/config\\.worktree$`)})`;
    expect(denyLine(p)).toContain(rule);
    expect(denyLine(p).split('config\\.worktree').length - 1).toBe(1);
    // one backslash before the dot, so the pattern compiles to a literal `.` (a doubled one never matches)
    expect(rule).toContain('/[^/]+/config\\.worktree$');
    expect(rule).not.toContain('\\\\.worktree');
    // the pattern matches exactly one path segment under worktrees/: the JS twin of the SBPL regex
    const re = new RegExp(`^${regexQuote(join(gitDir, 'worktrees'))}/[^/]+/config\\.worktree$`);
    expect(re.test(join(gitDir, 'worktrees', 'other', 'config.worktree'))).toBe(true);
    expect(re.test(join(gitDir, 'worktrees', 'other', 'configXworktree'))).toBe(false);
    expect(re.test(join(gitDir, 'worktrees', 'other', 'HEAD'))).toBe(false);
    expect(re.test(join(gitDir, 'worktrees', 'a', 'b', 'config.worktree'))).toBe(false);
    // in a linked worktree the rule sits at the common dir, never at the worktree's own git dir
    const main = join(dir, 'main');
    const commonDir = join(main, '.git');
    const wtGitDir = join(commonDir, 'worktrees', 'wt');
    mkdirSync(wtGitDir, { recursive: true });
    const q = buildProfile({ ...base, gitDir: wtGitDir, gitCommonDir: commonDir });
    expect(denyLine(q)).toContain(`(regex ${sbplRegex(`^${regexQuote(join(commonDir, 'worktrees'))}/[^/]+/config\\.worktree$`)})`);
    expect(denyLine(q)).not.toContain(regexQuote(join(wtGitDir, 'worktrees')));
  });

  it('protectGit: false drops every git deny (the tty deny stays) even with gitDir given', () => {
    const dir = temp('jev-sbg-');
    const { base, ws } = fixture(dir);
    const p = buildProfile({ ...base, protectGit: false, gitDir: join(ws, '.git') });
    expect(p).toContain('(deny file-write* (literal "/dev/ttys004"))');
    expect(p).not.toContain('.git/config');
    expect(p).not.toContain('modules');
    const noTty = buildProfile({ ...base, ttyPath: null, protectGit: false, gitDir: join(ws, '.git') });
    expect(noTty.split('\n').filter((l) => l.startsWith('(deny file-write* ('))).toEqual([]);
  });

  it('regexQuote escapes every metacharacter with one backslash; sbplRegex escapes only the quote', () => {
    expect(regexQuote('/a.b/c+d(e)[f]{g}|h^$*?\\')).toBe('/a\\.b/c\\+d\\(e\\)\\[f\\]\\{g\\}\\|h\\^\\$\\*\\?\\\\');
    expect(regexQuote('/plain/path')).toBe('/plain/path');
    expect(sbplRegex('^/x\\.git/.+$')).toBe('#"^/x\\.git/.+$"');
    expect(sbplRegex('a"b')).toBe('#"a\\"b"');
  });
});

describe.skipIf(!darwin)('createSandbox forwards the git options into the profile and its path hash (darwin)', () => {
  it('the profile file name is today\'s hash without options and a different one with them; two sandboxes coexist in one run dir', () => {
    const dir = temp('jev-sbg-');
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, '.git'), { recursive: true });
    const runDir = join(dir, 'run');
    const plain = createSandbox({ workspaceRoot: ws, runDir, profile: 'seatbelt', noNetwork: false, secretReadDenies: [], redact: (s) => s }, FAST_KILL);
    expect(plain.level).toBe('seatbelt');
    const legacyName = `sandbox-${createHash('sha256').update(`${ws}\n\n0`).digest('hex').slice(0, 12)}.sb`;
    expect(existsSync(join(runDir, legacyName))).toBe(true);
    const withGit = createSandbox({ workspaceRoot: ws, runDir, profile: 'seatbelt', noNetwork: false, secretReadDenies: [], redact: (s) => s, gitDir: join(ws, '.git'), gitCommonDir: join(ws, '.git') }, FAST_KILL);
    expect(withGit.level).toBe('seatbelt');
    const files = readdirSync(runDir).filter((f) => f.endsWith('.sb')).sort();
    expect(files.length).toBe(2);
    expect(files).toContain(legacyName);
    const other = files.find((f) => f !== legacyName)!;
    const profile = readFileSync(join(runDir, other), 'utf8');
    expect(profile).toContain('config.worktree');
    expect(readFileSync(join(runDir, legacyName), 'utf8')).not.toContain('config.worktree');
    // configDirs alone also changes the name
    createSandbox({ workspaceRoot: ws, runDir, profile: 'seatbelt', noNetwork: false, secretReadDenies: [], redact: (s) => s, configDirs: [join(dir, 'cfg', 'jevcode')] }, FAST_KILL);
    expect(readdirSync(runDir).filter((f) => f.endsWith('.sb')).length).toBe(3);
  });

  it('a linked worktree can `git commit` (writes into the main .git) while config, config.worktree, hooks and modules/*/config stay unwritable', async () => {
    const dir = temp('jev-sbg-');
    const main = join(dir, 'main');
    mkdirSync(main);
    const g = (cwd: string, ...args: string[]): string => {
      const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir } });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r.stdout;
    };
    g(main, 'init', '-q', '-b', 'main', '.');
    writeFileSync(join(main, 'a.txt'), 'a\n');
    g(main, 'add', '-A');
    g(main, 'commit', '-q', '-m', 'init');
    const wt = join(dir, 'wt');
    g(main, 'worktree', 'add', '-q', wt, '-b', 'wtb');
    const gitDir = g(wt, 'rev-parse', '--absolute-git-dir').trim();
    const commonDir = canonicalPathSync(join(main, '.git'));
    expect(gitDir).toBe(join(commonDir, 'worktrees', 'wt'));
    const opts = { timeoutMs: 15_000, maxOutputBytes: CAP, signal: never() };
    const commitCmd = 'echo x > f.txt && git add f.txt && git -c user.email=a@b -c user.name=n -c commit.gpgsign=false commit -q -m c 2>&1; echo committed=$?';

    // without the options the worktree sandbox cannot reach the main .git
    const plain = createSandbox({ workspaceRoot: wt, runDir: join(dir, 'run-plain'), profile: 'auto', noNetwork: false, secretReadDenies: [], redact: (s) => s }, FAST_KILL);
    expect(plain.level).toBe('seatbelt');
    const denied = await plain.run(commitCmd, opts);
    expect(denied.stdout).toMatch(/committed=[1-9]/);
    spawnSync('rm', ['-f', join(wt, 'f.txt')]);
    g(wt, 'reset', '-q', '--hard');

    const sb = createSandbox({ workspaceRoot: wt, runDir: join(dir, 'run-git'), profile: 'auto', noNetwork: false, secretReadDenies: [], redact: (s) => s, gitDir, gitCommonDir: commonDir }, FAST_KILL);
    expect(sb.level).toBe('seatbelt');
    const ok = await sb.run(commitCmd, opts);
    expect(ok.stdout).toMatch(/committed=0/);
    expect(g(wt, 'log', '--oneline').trim().split('\n').length).toBe(2);
    // a submodule git dir as git lays it out (created here, outside the sandbox: like today's `(subpath .git/hooks)`,
    // the `hooks(/.*)?$` regex denies creating the hooks directory itself as well as anything inside it)
    mkdirSync(join(commonDir, 'modules', 'lib', 'hooks'), { recursive: true });
    // a second linked worktree of the same repository: its `config.worktree` must stay unwritable from this sandbox
    // (fix-pass finding 4) while the rest of its git dir stays writable (git itself writes `HEAD`, `index` … there)
    const wt2 = join(dir, 'wt2');
    g(main, 'worktree', 'add', '-q', wt2, '-b', 'wtb2');
    const wt2GitDir = join(commonDir, 'worktrees', 'wt2');
    expect(existsSync(join(wt2GitDir, 'HEAD'))).toBe(true);
    const knobs = await sb.run(
      [
        `echo x >> "${commonDir}/config" 2>&1; echo cfg=$?`,
        `echo x > "${gitDir}/config.worktree" 2>&1; echo cw=$?`,
        `echo x > "${wt2GitDir}/config.worktree" 2>&1; echo wt2cw=$?`,
        `echo x > "${wt2GitDir}/scratch" 2>&1; echo wt2other=$?`,
        `echo x > "${commonDir}/hooks/pre-commit" 2>&1; echo hook=$?`,
        `mkdir -p "${commonDir}/modules/lib2/objects" 2>&1; echo mkmod=$?`,
        `mkdir "${commonDir}/modules/lib2/hooks" 2>&1; echo mkhooks=$?`,
        `echo x > "${commonDir}/modules/lib/config" 2>&1; echo modcfg=$?`,
        `echo x > "${commonDir}/modules/lib/hooks/post-checkout" 2>&1; echo modhook=$?`,
        `echo x > "${commonDir}/modules/lib/other" 2>&1; echo modother=$?`,
        `echo x > "${commonDir}/description" 2>&1; echo desc=$?`,
      ].join('; '),
      opts,
    );
    expect(knobs.stdout).toMatch(/cfg=[1-9]/);
    expect(knobs.stdout).toMatch(/cw=[1-9]/);
    expect(knobs.stdout).toMatch(/wt2cw=[1-9]/);
    expect(knobs.stdout).toMatch(/wt2other=0/);
    expect(existsSync(join(wt2GitDir, 'config.worktree'))).toBe(false);
    expect(existsSync(join(wt2GitDir, 'scratch'))).toBe(true);
    expect(knobs.stdout).toMatch(/hook=[1-9]/);
    expect(knobs.stdout).toMatch(/mkmod=0/);
    expect(knobs.stdout).toMatch(/mkhooks=[1-9]/);
    expect(knobs.stdout).toMatch(/modcfg=[1-9]/);
    expect(knobs.stdout).toMatch(/modhook=[1-9]/);
    expect(knobs.stdout).toMatch(/modother=0/);
    expect(knobs.stdout).toMatch(/desc=0/);
    expect(readFileSync(join(commonDir, 'config'), 'utf8')).not.toContain('\nx');
    expect(existsSync(join(gitDir, 'config.worktree'))).toBe(false);
    expect(existsSync(join(commonDir, 'hooks', 'pre-commit'))).toBe(false);
    expect(existsSync(join(commonDir, 'modules', 'lib', 'config'))).toBe(false);
    expect(existsSync(join(commonDir, 'modules', 'lib', 'hooks', 'post-checkout'))).toBe(false);
    expect(existsSync(join(commonDir, 'modules', 'lib', 'other'))).toBe(true);
    expect(existsSync(join(commonDir, 'modules', 'lib2', 'objects'))).toBe(true);
  });
});
