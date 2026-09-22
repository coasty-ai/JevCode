/**
 * ORCHESTRATION-DESIGN §5.2 [G3] / §8.2 D2 item 20: `ProfileOptions.agentChild` — the child deny list.
 *
 * The landing layer pins `refs/heads/jevcode/<slug>` to a sha ONCE and re-checks that sha at merge time. A
 * child that could move the ref, rewrite the reflog, repack `packed-refs` or repoint another worktree's
 * `HEAD` between the pin and the merge would defeat the re-check, so a depth-1 profile denies all four —
 * and, because SBPL is "later rules win", the denies have to sit AFTER the workspace write-allow that made
 * the common dir writable in the first place. Every case below asserts the ORDER, not only the presence.
 *
 * The depth keying is itself an invariant (§5.2 [D10]): the supervisor's own per-worktree sandbox is built
 * from the PARENT's configuration and therefore never sets `agentChild`, which is what leaves [G1]'s
 * `git commit` able to write `refs/heads/jevcode/<slug>`. A profile without the flag must be byte-identical
 * to today's, and the two snapshots below are captured from the pre-[G3] code rather than re-derived.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildProfile, regexQuote, sbplRegex, sbplString } from '../../../src/sandbox/seatbelt.js';
import type { ProfileOptions } from '../../../src/sandbox/seatbelt.js';
import { canonicalPathSync } from '../../../src/sandbox/paths.js';
import { createSandbox } from '../../../src/sandbox/run.js';
import { FAST_KILL, makeTemp, never } from './helpers.js';

let cleanups: Array<() => void> = [];
function temp(prefix: string): string {
  const t = makeTemp(prefix);
  cleanups.push(t.cleanup);
  return t.dir;
}
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function fixture(dir: string, wsName = 'ws'): { base: ProfileOptions; ws: string; home: string } {
  const ws = join(dir, wsName);
  mkdirSync(join(ws, '.git', 'hooks'), { recursive: true });
  mkdirSync(join(dir, 'run', 'tmp'), { recursive: true });
  mkdirSync(join(dir, 'run', 'home'), { recursive: true });
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return { ws, home, base: { ws, runTmp: join(dir, 'run', 'tmp'), runHome: join(dir, 'run', 'home'), ttyPath: '/dev/ttys004', readDenies: [], noNetwork: false, home } };
}

const lines = (profile: string): string[] => profile.split('\n');
const indexOfLine = (profile: string, pred: (l: string) => boolean): number => lines(profile).findIndex(pred);
/** the workspace write-allow: the rule that makes the common dir writable at all */
const allowIndex = (profile: string): number => indexOfLine(profile, (l) => l.startsWith('(allow file-write*'));
/** the existing `.git` knob denies (`config`, `hooks`, `config.worktree`, `modules/*`) */
const gitDenyIndex = (profile: string): number => indexOfLine(profile, (l) => l.startsWith('(deny file-write* (literal'));
/** the [G3] line: the only write deny that opens with a `(subpath` */
const agentDenyIndex = (profile: string): number => indexOfLine(profile, (l) => l.startsWith('(deny file-write* (subpath'));
const agentDenyLine = (profile: string): string => {
  const i = agentDenyIndex(profile);
  expect(i, '[G3] child deny line present').toBeGreaterThanOrEqual(0);
  return lines(profile)[i]!;
};

/** the whole [G3] rule for a common dir, in EMISSION order (subpaths lead; see the seatbelt comment) */
function expectedAgentLine(commonDir: string): string {
  const w = expectedRules(commonDir);
  return `(deny file-write* ${w.refs} ${w.logs} ${w.reftable} ${w.sequencer} ${w.packed} ${w.head} ${w.index} ${w.orig} ${w.merge} ${w.heads})`;
}

/** the ten rules, as SBPL, for a given common dir */
function expectedRules(commonDir: string): { refs: string; packed: string; logs: string; heads: string; head: string; index: string; orig: string; merge: string; sequencer: string; reftable: string } {
  return {
    head: `(literal ${sbplString(join(commonDir, 'HEAD'))})`,
    index: `(literal ${sbplString(join(commonDir, 'index'))})`,
    orig: `(literal ${sbplString(join(commonDir, 'ORIG_HEAD'))})`,
    merge: `(literal ${sbplString(join(commonDir, 'MERGE_HEAD'))})`,
    sequencer: `(subpath ${sbplString(join(commonDir, 'sequencer'))})`,
    reftable: `(subpath ${sbplString(join(commonDir, 'reftable'))})`,
    refs: `(subpath ${sbplString(join(commonDir, 'refs'))})`,
    packed: `(literal ${sbplString(join(commonDir, 'packed-refs'))})`,
    logs: `(subpath ${sbplString(join(commonDir, 'logs'))})`,
    heads: `(regex ${sbplRegex(`^${regexQuote(join(commonDir, 'worktrees'))}/[^/]+/HEAD$`)})`,
  };
}

/**
 * There is deliberately NO frozen "pre-[G3]" profile capture here any more. One was tried, and main promptly added
 * the `.jevcode/{memory,rules,commands}` write-denies and the `memory-local` read-deny — another owner's change,
 * for every caller — which made the capture report THEIR edit as a [G3] regression. A snapshot of a file this
 * wave does not own is a tripwire on the wrong thing.
 *
 * What [G3] actually needs is asserted instead, and it is stronger: omitting `agentChild` (or passing false) yields
 * a profile byte-identical to the one the same options produce with the flag absent, and setting it adds EXACTLY
 * one line — the deny — in the right ordinal position. Those hold whatever else the profile grows.
 */

/** a linked-worktree fixture: `<dir>/main/.git` is the common dir, `<dir>/main/.git/worktrees/wt` the git dir */
function linked(dir: string): { commonDir: string; gitDir: string } {
  const commonDir = join(dir, 'main', '.git');
  const gitDir = join(commonDir, 'worktrees', 'wt');
  mkdirSync(gitDir, { recursive: true });
  return { commonDir, gitDir };
}

describe('buildProfile agentChild — the [G3] child deny list', () => {
  it('agentChild: true on a main tree denies refs, packed-refs, logs and worktrees/*/HEAD under <ws>/.git, all AFTER the workspace allow', () => {
    const { base, ws } = fixture(temp('jev-sba-'));
    const p = buildProfile({ ...base, gitCommonDir: join(base.ws, '.git'), agentChild: true });
    const commonDir = join(ws, '.git');
    const want = expectedRules(commonDir);

    const line = agentDenyLine(p);
    expect(line).toBe(expectedAgentLine(commonDir));

    // ordinal: SBPL is "later rules win", so the deny is only effective after the allow that opened the dir
    const allow = allowIndex(p);
    const deny = agentDenyIndex(p);
    expect(allow).toBeGreaterThanOrEqual(0);
    expect(deny).toBeGreaterThan(allow);
    // …and beside (immediately after) the existing `.git` knob denies
    expect(deny).toBe(gitDenyIndex(p) + 1);
    // each of the four, individually, lands after the allow
    for (const rule of [want.refs, want.packed, want.logs, want.heads]) {
      expect(p, rule).toContain(rule);
      expect(p.indexOf(rule)).toBeGreaterThan(p.indexOf('(allow file-write*'));
    }
    // the existing knob denies are untouched — asserted as MEMBERSHIP of that line, not as the whole line, because
    // the knob list is another owner's and grows (main has since added the `.jevcode/{memory,rules,commands}` entries)
    const knobs = lines(p)[gitDenyIndex(p)]!;
    expect(knobs.startsWith(`(deny file-write* (literal ${sbplString(join(commonDir, 'config'))}) (subpath ${sbplString(join(commonDir, 'hooks'))})`)).toBe(true);
    expect(knobs.endsWith('(literal "/dev/ttys004"))')).toBe(true);
    // and they are a DIFFERENT line from ours: [G3] never widens or narrows the knob deny
    expect(knobs).not.toContain('packed-refs');
  });

  it('a linked worktree (gitCommonDir ≠ <ws>/.git): every rule targets the COMMON dir, never the worktree git dir and never <ws>/.git', () => {
    const dir = temp('jev-sba-');
    const { base, ws } = fixture(dir);
    const { commonDir, gitDir } = linked(dir);
    const p = buildProfile({ ...base, gitDir, gitCommonDir: commonDir, agentChild: true });

    expect(agentDenyLine(p)).toBe(expectedAgentLine(commonDir));
    // the worktree's own git dir keeps its per-worktree refs/logs writable (git writes them on every commit)
    expect(agentDenyLine(p)).not.toContain(join(gitDir, 'refs'));
    expect(agentDenyLine(p)).not.toContain(join(gitDir, 'logs'));
    expect(agentDenyLine(p)).not.toContain(join(ws, '.git'));
    // the common dir is a WRITE ROOT for a linked worktree — that is exactly why these denies must follow it
    expect(lines(p)[allowIndex(p)]).toContain(`(subpath ${sbplString(commonDir)})`);
    expect(agentDenyIndex(p)).toBeGreaterThan(allowIndex(p));
    // gitCommonDir alone (no gitDir) resolves the same way
    expect(agentDenyLine(buildProfile({ ...base, gitCommonDir: commonDir, agentChild: true }))).toBe(agentDenyLine(p));
    // gitDir alone is REFUSED at depth 1 (review 2026-09-22 finding 7): in a linked agent worktree the git
    // dir is `<common>/worktrees/<wt>`, so defaulting the common dir to it aimed every rule one level too deep
    expect(() => buildProfile({ ...base, gitDir, agentChild: true })).toThrow(/gitCommonDir/);
  });

  it('the worktrees/*/HEAD regex matches exactly one segment (the JS twin of the SBPL pattern)', () => {
    const dir = temp('jev-sba-');
    const { base } = fixture(dir);
    const { commonDir, gitDir } = linked(dir);
    const p = buildProfile({ ...base, gitDir, gitCommonDir: commonDir, agentChild: true });
    const pattern = `^${regexQuote(join(commonDir, 'worktrees'))}/[^/]+/HEAD$`;
    expect(agentDenyLine(p)).toContain(sbplRegex(pattern));
    // one backslash per metacharacter, like the existing modules/* regexes: `\\.git` never matches
    expect(agentDenyLine(p)).toContain('/main/\\.git/worktrees/[^/]+/HEAD$');
    expect(agentDenyLine(p)).not.toContain('\\\\.git');
    const re = new RegExp(pattern);
    expect(re.test(join(commonDir, 'worktrees', 'wt', 'HEAD'))).toBe(true);
    expect(re.test(join(commonDir, 'worktrees', 'other', 'HEAD'))).toBe(true);
    expect(re.test(join(commonDir, 'worktrees', 'wt', 'HEADER'))).toBe(false);
    expect(re.test(join(commonDir, 'worktrees', 'wt', 'index'))).toBe(false);
    expect(re.test(join(commonDir, 'worktrees', 'a', 'b', 'HEAD'))).toBe(false);
  });

  it('agentChild absent or false: the profile is unchanged, and setting it adds EXACTLY one line (the §5.2 depth-0 supervisor case)', () => {
    const dir = temp('jev-sba-');
    const { base } = fixture(dir);
    // the [D10] pair over one worktree: the supervisor builds with the flag ABSENT, the child with it TRUE
    // both sides carry the same gitCommonDir, so the ONLY admissible difference is the [G3] line itself
    const mainCommon = join(base.ws, '.git');
    const supervisorMain = buildProfile({ ...base, gitCommonDir: mainCommon });
    // (`exactOptionalPropertyTypes` is on, so an explicit `undefined` is not a case the type admits)
    expect(buildProfile({ ...base, gitCommonDir: mainCommon, agentChild: false })).toBe(supervisorMain);
    expect(supervisorMain).not.toContain('packed-refs');
    expect(supervisorMain).not.toContain('/refs');
    expect(agentDenyIndex(supervisorMain)).toBe(-1);
    const childMain = buildProfile({ ...base, gitCommonDir: mainCommon, agentChild: true });
    expect(lines(childMain).length).toBe(lines(supervisorMain).length + 1);
    expect(lines(childMain).filter((l) => !lines(supervisorMain).includes(l))).toEqual([agentDenyLine(childMain)]);

    const { commonDir, gitDir } = linked(dir);
    const supervisorLinked = buildProfile({ ...base, gitDir, gitCommonDir: commonDir });
    expect(buildProfile({ ...base, gitDir, gitCommonDir: commonDir, agentChild: false })).toBe(supervisorLinked);
    expect(supervisorLinked).not.toContain('packed-refs');
    expect(agentDenyIndex(supervisorLinked)).toBe(-1);
    const child = buildProfile({ ...base, gitDir, gitCommonDir: commonDir, agentChild: true });
    expect(lines(child).length).toBe(lines(supervisorLinked).length + 1);
    expect(lines(child).filter((l) => !lines(supervisorLinked).includes(l))).toEqual([agentDenyLine(child)]);
  });

  it('review 2026-09-22 finding 3: <common>/HEAD, index, ORIG_HEAD, MERGE_HEAD and sequencer/ are denied too', () => {
    const { base, ws } = fixture(temp('jev-sba-'));
    const commonDir = join(ws, '.git');
    const p = buildProfile({ ...base, gitCommonDir: commonDir, agentChild: true });
    const want = expectedRules(commonDir);
    // HEAD and index were writable: under `orchestrate.land: 'step'` the user's own checkout is the merge
    // target, so a child that can rewrite the main worktree's HEAD or index moves what the merge merges INTO.
    for (const rule of [want.head, want.index, want.orig, want.merge, want.sequencer]) {
      expect(p, rule).toContain(rule);
      expect(p.indexOf(rule)).toBeGreaterThan(p.indexOf('(allow file-write*'));
    }
    // all of them on the ONE [G3] line, after the workspace allow and beside the knob denies
    const line = agentDenyLine(p);
    for (const rule of [want.head, want.index, want.orig, want.merge, want.sequencer, want.refs, want.packed, want.logs, want.heads]) expect(line).toContain(rule);
    expect(agentDenyIndex(p)).toBe(gitDenyIndex(p) + 1);
  });

  it('review 2026-09-22 finding 8: a reftable repo keeps its refs under <common>/reftable, which is denied as well', () => {
    const { base, ws } = fixture(temp('jev-sba-'));
    const commonDir = join(ws, '.git');
    const p = buildProfile({ ...base, gitCommonDir: commonDir, agentChild: true });
    // with `extensions.refStorage = reftable` the refs/ + packed-refs + logs denies are inert on their own
    expect(agentDenyLine(p)).toContain(expectedRules(commonDir).reftable);
  });

  it('review 2026-09-22 finding 7: at depth 1 with NO gitCommonDir the profile is REFUSED, never degraded', () => {
    const { base } = fixture(temp('jev-sba-'));
    // in an agent worktree `<ws>/.git` is a FILE, so the old `commonDir ?? join(ws, '.git')` fallback pointed
    // all the denies at paths that do not exist — the [G3] rule silently evaporated. Refuse instead.
    expect(() => buildProfile({ ...base, agentChild: true })).toThrow(/gitCommonDir/);
    expect(() => buildProfile({ ...base, agentChild: true, gitDir: join(base.ws, '.git') })).toThrow(/gitCommonDir/);
    // depth 0 is unaffected: the supervisor's own sandbox never sets the flag
    expect(() => buildProfile(base)).not.toThrow();
    expect(() => buildProfile({ ...base, agentChild: false })).not.toThrow();
    // and with a common dir it builds
    expect(() => buildProfile({ ...base, agentChild: true, gitCommonDir: join(base.ws, '.git') })).not.toThrow();
  });

  it('every path is escaped: a workspace with a space, a quote and regex metacharacters', () => {
    const dir = temp('jev-sba-');
    const { base, ws } = fixture(dir, 'w s"q+(a).git*');
    const p = buildProfile({ ...base, gitCommonDir: join(base.ws, '.git'), agentChild: true });
    const commonDir = join(ws, '.git');
    const want = expectedRules(commonDir);
    expect(agentDenyLine(p)).toBe(expectedAgentLine(commonDir));
    // the string literals: the quote is backslash-escaped, the space is not
    expect(want.refs).toContain('w s\\"q+(a).git*');
    expect(want.packed).toContain('\\"');
    // the regex literal: every metacharacter gets ONE backslash, and the quote is escaped for the reader
    expect(want.heads).toContain('w s\\"q\\+\\(a\\)\\.git\\*');
    expect(want.heads).not.toContain('\\\\+');
    // the JS twin still matches the real path, which is the point of regexQuote
    const pattern = `^${regexQuote(join(commonDir, 'worktrees'))}/[^/]+/HEAD$`;
    expect(new RegExp(pattern).test(join(commonDir, 'worktrees', 'wt', 'HEAD'))).toBe(true);
  });

  it('protectGit: false does not weaken [G3] — the child deny list is its own rule and survives', () => {
    const dir = temp('jev-sba-');
    const { base, ws } = fixture(dir);
    const p = buildProfile({ ...base, protectGit: false, gitCommonDir: join(ws, '.git'), agentChild: true });
    expect(p).not.toContain(`${join(ws, '.git', 'config')}"`);
    expect(agentDenyLine(p)).toBe(expectedAgentLine(join(ws, '.git')));
    expect(agentDenyIndex(p)).toBeGreaterThan(allowIndex(p));
  });
});

/**
 * The real thing. Everything above reasons about the SBPL text; this runs it. Finding 3 was only visible this
 * way: the four original denies were present and correct, and `<common>/HEAD` and `<common>/index` — which the
 * text never mentioned — were writable from a child, which under `orchestrate.land: 'step'` is the very tree the
 * launch merges into.
 */
describe.skipIf(!(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')))('[G3] under real sandbox-exec (darwin)', () => {
  it('a depth-1 child cannot write HEAD, index, ORIG_HEAD, MERGE_HEAD, sequencer/, refs/, packed-refs or logs/ — and can still write its own worktree', async () => {
    const dir = temp('jev-sbap-');
    const main = join(dir, 'main');
    mkdirSync(main, { recursive: true });
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
    g(main, 'worktree', 'add', '-q', wt, '-b', 'jevcode/agent-a');
    const gitDir = g(wt, 'rev-parse', '--absolute-git-dir').trim();
    const commonDir = canonicalPathSync(join(main, '.git'));
    mkdirSync(join(commonDir, 'sequencer'), { recursive: true });

    const child = createSandbox(
      { workspaceRoot: wt, runDir: join(dir, 'run-child'), profile: 'auto', noNetwork: false, secretReadDenies: [], redact: (x: string) => x, gitDir, gitCommonDir: commonDir, agentChild: true },
      FAST_KILL,
    );
    expect(child.level).toBe('seatbelt');
    const out = await child.run(
      [
        `echo x > "${commonDir}/HEAD" 2>&1; echo head=$?`,
        `echo x > "${commonDir}/index" 2>&1; echo index=$?`,
        `echo x > "${commonDir}/ORIG_HEAD" 2>&1; echo orig=$?`,
        `echo x > "${commonDir}/MERGE_HEAD" 2>&1; echo merge=$?`,
        `echo x > "${commonDir}/sequencer/todo" 2>&1; echo seq=$?`,
        `echo x > "${commonDir}/refs/heads/main" 2>&1; echo ref=$?`,
        `echo x > "${commonDir}/packed-refs" 2>&1; echo packed=$?`,
        `echo x > "${commonDir}/logs/HEAD" 2>&1; echo log=$?`,
        `echo x > "${commonDir}/worktrees/wt/HEAD" 2>&1; echo wthead=$?`,
        `echo x > "${wt}/mine.txt" 2>&1; echo mine=$?`,
      ].join('; '),
      { timeoutMs: 20_000, maxOutputBytes: 50_000, signal: never() },
    );
    // every guarded path is refused …
    for (const key of ['head', 'index', 'orig', 'merge', 'seq', 'ref', 'packed', 'log', 'wthead']) {
      expect(out.stdout, `${key} must be denied`).toMatch(new RegExp(`${key}=[1-9]`));
    }
    // … and the agent can still do its own work, which is the whole point of denying only these
    expect(out.stdout).toMatch(/mine=0/);
    expect(existsSync(join(wt, 'mine.txt'))).toBe(true);

    // the depth-0 supervisor sandbox over the SAME worktree keeps its [G1] commit ability
    const supervisor = createSandbox(
      { workspaceRoot: wt, runDir: join(dir, 'run-sup'), profile: 'auto', noNetwork: false, secretReadDenies: [], redact: (x: string) => x, gitDir, gitCommonDir: commonDir },
      FAST_KILL,
    );
    const sup = await supervisor.run(
      `echo y > b.txt && git add b.txt && git -c user.email=a@b -c user.name=n -c commit.gpgsign=false commit -q -m c 2>&1; echo committed=$?`,
      { timeoutMs: 20_000, maxOutputBytes: 50_000, signal: never() },
    );
    expect(sup.stdout).toMatch(/committed=0/);
  });
});
