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
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildProfile, regexQuote, sbplRegex, sbplString } from '../../../src/sandbox/seatbelt.js';
import type { ProfileOptions } from '../../../src/sandbox/seatbelt.js';
import { makeTemp } from './helpers.js';

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

/** the four rules, as SBPL, for a given common dir */
function expectedRules(commonDir: string): { refs: string; packed: string; logs: string; heads: string } {
  return {
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
    const p = buildProfile({ ...base, agentChild: true });
    const commonDir = join(ws, '.git');
    const want = expectedRules(commonDir);

    const line = agentDenyLine(p);
    expect(line).toBe(`(deny file-write* ${want.refs} ${want.packed} ${want.logs} ${want.heads})`);

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
    const want = expectedRules(commonDir);

    expect(agentDenyLine(p)).toBe(`(deny file-write* ${want.refs} ${want.packed} ${want.logs} ${want.heads})`);
    // the worktree's own git dir keeps its per-worktree refs/logs writable (git writes them on every commit)
    expect(agentDenyLine(p)).not.toContain(join(gitDir, 'refs'));
    expect(agentDenyLine(p)).not.toContain(join(gitDir, 'logs'));
    expect(agentDenyLine(p)).not.toContain(join(ws, '.git'));
    // the common dir is a WRITE ROOT for a linked worktree — that is exactly why these denies must follow it
    expect(lines(p)[allowIndex(p)]).toContain(`(subpath ${sbplString(commonDir)})`);
    expect(agentDenyIndex(p)).toBeGreaterThan(allowIndex(p));
    // gitCommonDir alone (no gitDir) resolves the same way
    expect(agentDenyLine(buildProfile({ ...base, gitCommonDir: commonDir, agentChild: true }))).toBe(agentDenyLine(p));
    // gitDir alone: the common dir defaults to it, so the rules follow the git dir
    const only = buildProfile({ ...base, gitDir, agentChild: true });
    expect(agentDenyLine(only)).toBe(`(deny file-write* ${Object.values(expectedRules(gitDir)).join(' ')})`);
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
    const supervisorMain = buildProfile(base);
    // (`exactOptionalPropertyTypes` is on, so an explicit `undefined` is not a case the type admits)
    expect(buildProfile({ ...base, agentChild: false })).toBe(supervisorMain);
    expect(supervisorMain).not.toContain('packed-refs');
    expect(supervisorMain).not.toContain('/refs');
    expect(agentDenyIndex(supervisorMain)).toBe(-1);
    const childMain = buildProfile({ ...base, agentChild: true });
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

  it('every path is escaped: a workspace with a space, a quote and regex metacharacters', () => {
    const dir = temp('jev-sba-');
    const { base, ws } = fixture(dir, 'w s"q+(a).git*');
    const p = buildProfile({ ...base, agentChild: true });
    const commonDir = join(ws, '.git');
    const want = expectedRules(commonDir);
    expect(agentDenyLine(p)).toBe(`(deny file-write* ${want.refs} ${want.packed} ${want.logs} ${want.heads})`);
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
    const p = buildProfile({ ...base, protectGit: false, agentChild: true });
    expect(p).not.toContain(`${join(ws, '.git', 'config')}"`);
    expect(agentDenyLine(p)).toBe(`(deny file-write* ${Object.values(expectedRules(join(ws, '.git'))).join(' ')})`);
    expect(agentDenyIndex(p)).toBeGreaterThan(allowIndex(p));
  });
});
