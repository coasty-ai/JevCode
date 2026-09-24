import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSandbox } from '../../../src/sandbox/run.js';
import { buildProfile, detectSandboxLevel, sbplString } from '../../../src/sandbox/seatbelt.js';
import type { ProfileOptions } from '../../../src/sandbox/seatbelt.js';
import { FAST_KILL, makeSandbox, makeTemp, never } from './helpers.js';
import type { TempSandbox } from './helpers.js';

const darwin = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

describe('buildProfile', () => {
  it('canonicalises every path and emits the §8 rules', () => {
    const t = makeTemp('jev-sb-');
    try {
      const ws = join(t.dir, 'ws');
      mkdirSync(ws);
      const link = join(t.dir, 'ws-link');
      symlinkSync(ws, link);
      mkdirSync(join(t.dir, 'run', 'tmp'), { recursive: true });
      mkdirSync(join(t.dir, 'run', 'home'), { recursive: true });
      const home = join(t.dir, 'home');
      mkdirSync(join(home, '.ssh'), { recursive: true });
      const dotenv = join(t.dir, 'pkg', '.env');
      const aux = join(t.dir, 'aux');
      mkdirSync(aux);
      const auxLink = join(t.dir, 'aux-link');
      symlinkSync(aux, auxLink);
      const profile = buildProfile({
        ws: link,
        runTmp: join(t.dir, 'run', 'tmp'),
        runHome: join(t.dir, 'run', 'home'),
        ttyPath: '/dev/ttys004',
        readDenies: [dotenv, join(home, '.config', 'jevcode', 'config.json')],
        noNetwork: true,
        home,
        // symlinked, duplicated and already-covered roots collapse to one canonical subpath after the run dirs
        extraWritable: [auxLink, aux, ws],
      });
      const lines = profile.split('\n');
      expect(lines[0]).toBe('(version 1)');
      expect(lines[1]).toBe('(allow default)');
      expect(lines[2]).toBe('(deny file-write*)');
      expect(profile).toContain(`(allow file-write* (subpath "${ws}") (subpath "${join(t.dir, 'run', 'tmp')}") (subpath "${join(t.dir, 'run', 'home')}") (subpath "${aux}")`);
      expect(profile).not.toContain(link);
      expect(profile).not.toContain(auxLink);
      // the extra root appears in the write allow and in the two read re-allows (file-read-data, file-read*)
      expect(profile.split(`(subpath "${aux}")`).length - 1).toBe(3);
      expect(profile).toContain(`(deny file-read-data (subpath "${join(home, '.jevcode')}"))`);
      expect(profile.indexOf('(deny file-read-data')).toBeLessThan(profile.indexOf('(allow file-read-data'));
      // IMPORT-DESIGN §2.11 [G2.1] widened this line with the three workspace-memory write denies, between
      // the `.git` pair and the tty literal; everything else about it is unchanged.
      expect(profile).toContain(
        `(deny file-write* (literal "${join(ws, '.git', 'config')}") (subpath "${join(ws, '.git', 'hooks')}") ` +
          `(literal "${join(ws, '.jevcode', 'memory')}") (subpath "${join(ws, '.jevcode', 'memory')}") ` +
          `(literal "${join(ws, '.jevcode', 'rules')}") (subpath "${join(ws, '.jevcode', 'rules')}") ` +
          `(literal "${join(ws, '.jevcode', 'commands')}") (subpath "${join(ws, '.jevcode', 'commands')}") (literal "/dev/ttys004"))`,
      );
      expect(profile).toContain(`(literal "${dotenv}")`);
      expect(profile).toContain(`(subpath "${join(home, '.ssh')}")`);
      expect(profile).toContain(`(subpath "${join(home, '.aws')}")`);
      expect(profile).toContain(`(subpath "${join(home, '.config', 'gh')}")`);
      expect(profile).toContain(`(literal "${join(home, '.netrc')}")`);
      expect(profile).toContain(`(subpath "${join(home, '.jevcode')}")`);
      expect(profile).toContain(`(subpath "${join(home, '.config', 'jevcode')}")`);
      expect(profile.trimEnd().endsWith('(deny network*)')).toBe(true);
      // ordering: write allow precedes the .git deny (later rules win)
      expect(profile.indexOf('(allow file-write*')).toBeLessThan(profile.indexOf('.git/config'));
      const noNet = buildProfile({ ws, runTmp: join(t.dir, 'run', 'tmp'), runHome: join(t.dir, 'run', 'home'), ttyPath: null, readDenies: [], noNetwork: false, home });
      expect(noNet).not.toContain('network');
      expect(noNet).not.toContain('ttys004');
      expect(noNet).toContain(`(subpath "${join(t.dir, 'run', 'home')}")\n`);
    } finally {
      t.cleanup();
    }
  });

  it('quotes SBPL strings and detects the level', () => {
    expect(sbplString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(detectSandboxLevel('none', 'darwin', () => true)).toBe('none');
    expect(detectSandboxLevel('auto', 'linux', () => true)).toBe('none');
    expect(detectSandboxLevel('auto', 'darwin', () => false)).toBe('none');
    expect(detectSandboxLevel('auto', 'darwin', () => true)).toBe('seatbelt');
    expect(detectSandboxLevel('seatbelt', 'darwin', () => true)).toBe('seatbelt');
  });
});

describe.skipIf(!darwin)('seatbelt profile on darwin', () => {
  let t: TempSandbox;
  let secret: string;
  const CAP = 50_000;
  const run = (cmd: string): ReturnType<TempSandbox['sandbox']['run']> => t.sandbox.run(cmd, { timeoutMs: 15_000, maxOutputBytes: CAP, signal: never() });

  beforeAll(() => {
    const pkg = makeTemp('jev-pkg-');
    secret = join(pkg.dir, '.env');
    writeFileSync(secret, 'OPENROUTER_API_KEY=sk-or-v1-notreal\n');
    t = makeSandbox({ profile: 'auto', secretReadDenies: [secret] });
    expect(t.sandbox.level).toBe('seatbelt');
    expect(realpathSync(t.ws).startsWith(realpathSync(tmpdir()))).toBe(true);
    spawnSync('git', ['init', '-q', '.'], { cwd: t.ws });
  });
  afterAll(() => t.cleanup());

  it('writes inside the workspace succeed', async () => {
    const r = await run('echo hi > f.txt && cat f.txt');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hi');
    expect(readFileSync(join(t.ws, 'f.txt'), 'utf8')).toBe('hi\n');
  });

  it('writes to the real home and to $HOME/escape are denied', async () => {
    const realHome = homedir();
    const r = await run(`touch "${realHome}/jevcode-escape-test" 2>&1; echo "exit=$?"; touch "$HOME/escape" 2>&1; echo "exit=$?"`);
    expect(existsSync(join(realHome, 'jevcode-escape-test'))).toBe(false);
    expect(r.stdout).toMatch(/Operation not permitted/);
    // $HOME is the remapped run home, which is writable
    expect(r.stdout).toMatch(/exit=1\n.*exit=0/s);
    expect(existsSync(join(t.runDir, 'home', 'escape'))).toBe(true);
  });

  it('.git/config and .git/hooks writes are denied while git add works', async () => {
    const r = await run(
      'git -c user.email=a@b -c user.name=n config core.fsmonitor /bin/echo 2>&1; echo "cfg=$?"; echo x > .git/hooks/pre-commit 2>&1; echo "hook=$?"; echo a > a.txt; git add a.txt 2>&1; echo "add=$?"',
    );
    expect(r.stdout).toMatch(/cfg=[1-9]/);
    expect(r.stdout).toMatch(/hook=[1-9]/);
    expect(r.stdout).toMatch(/add=0/);
    expect(readFileSync(join(t.ws, '.git', 'config'), 'utf8')).not.toContain('fsmonitor');
    expect(existsSync(join(t.ws, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  it('reading a secret path is denied, also through a symlink in the workspace', async () => {
    symlinkSync(secret, join(t.ws, 'env-link'));
    const r = await run(`cat "${secret}" 2>&1; echo "exit=$?"; cat env-link 2>&1; echo "exit=$?"`);
    expect(r.stdout).not.toContain('notreal');
    expect(r.stdout).toMatch(/Operation not permitted/);
    expect(r.stdout.match(/exit=1/g)?.length).toBe(2);
  });

  it('/bin/ps under the profile either works or is flagged sandboxExecDenied', async () => {
    const r = await run('/bin/ps -axo pid | head -2');
    if (r.exitCode !== 0) {
      expect(r.exitCode).toBe(71);
      expect(r.sandboxExecDenied).toBe(true);
    } else {
      expect(r.sandboxExecDenied).toBe(false);
    }
  });

  it('extra writable roots are writable and accepted as cwd under the profile; a sibling dir stays read-only', async () => {
    const aux = join(dirname(t.ws), 'aux');
    const other = join(dirname(t.ws), 'other');
    mkdirSync(join(aux, 'output'), { recursive: true });
    mkdirSync(other, { recursive: true });
    // its own run dir: every sandbox writes <run>/sandbox.sb, and this suite's sandbox must keep its workspace-only profile
    const sb = createSandbox({ workspaceRoot: t.ws, runDir: join(dirname(t.ws), 'run-extra'), profile: 'auto', noNetwork: false, secretReadDenies: [secret], redact: (s) => s, extraWritable: [aux] }, FAST_KILL);
    expect(sb.level).toBe('seatbelt');
    const r = await sb.run(`echo out > "${aux}/output/result.txt" 2>&1; echo "aux=$?"; echo x > "${other}/f.txt" 2>&1; echo "other=$?"`, { timeoutMs: 15_000, maxOutputBytes: CAP, signal: never() });
    expect(r.stdout).toMatch(/aux=0/);
    expect(r.stdout).toMatch(/other=[1-9]/);
    expect(readFileSync(join(aux, 'output', 'result.txt'), 'utf8')).toBe('out\n');
    expect(existsSync(join(other, 'f.txt'))).toBe(false);
    const c = await sb.run('pwd', { timeoutMs: 15_000, maxOutputBytes: CAP, signal: never(), cwd: aux });
    expect(c.stdout.trim()).toBe(aux);
    // the workspace-only sandbox of this suite cannot write there
    const denied = await run(`echo x > "${aux}/denied.txt" 2>&1; echo "exit=$?"`);
    expect(denied.stdout).toMatch(/exit=[1-9]/);
    expect(existsSync(join(aux, 'denied.txt'))).toBe(false);
  });

  it('python3 and node run under the profile', async () => {
    const r = await run('python3 -c "print(6*7)" && node -e "console.log(1+1)"');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('42\n2\n');
  });
});

/**
 * IMPORT-DESIGN §2.11 [G2.1] / §1 property 16 / §8.3 (`seatbelt` ordinal). The whole seatbelt diff the
 * import design is allowed to make is asserted here: three workspace-memory write denies inside the
 * post-allow write-deny line, and one `memory-local` read deny whose **line ordinal** is greater than
 * both read re-allows. Ordinal, not presence — presence is what the spine asserted, and presence is not
 * the property that matters: routed through `addRead` the rule would be present and dead.
 */
describe('buildProfile — the import memory rules (§2.11 [G2.1])', () => {
  interface Fixture {
    ws: string;
    home: string;
    opts: ProfileOptions;
    cleanup: () => void;
  }
  function fixture(): Fixture {
    const t = makeTemp('jev-sb-imp-');
    const ws = join(t.dir, 'ws');
    mkdirSync(join(ws, '.jevcode', 'memory-local'), { recursive: true });
    mkdirSync(join(t.dir, 'run', 'tmp'), { recursive: true });
    mkdirSync(join(t.dir, 'run', 'home'), { recursive: true });
    const home = join(t.dir, 'home');
    mkdirSync(home);
    return {
      ws,
      home,
      cleanup: t.cleanup,
      opts: { ws, runTmp: join(t.dir, 'run', 'tmp'), runHome: join(t.dir, 'run', 'home'), ttyPath: '/dev/ttys004', readDenies: [], noNetwork: false, home },
    };
  }
  const jev = (f: Fixture, rel: string): string => join(f.ws, '.jevcode', rel);
  const writeDenyLine = (p: string): string => p.split('\n').find((l) => l.startsWith('(deny file-write* (literal')) ?? '';
  const ordinalOf = (p: string, prefix: string): number => p.split('\n').findIndex((l) => l.startsWith(prefix));

  it('(a) the three write denies are literal+subpath pairs inside the post-allow write-deny line', () => {
    const f = fixture();
    try {
      const p = buildProfile(f.opts);
      const line = writeDenyLine(p);
      for (const rel of ['memory', 'rules', 'commands']) {
        expect(line).toContain(`(literal ${sbplString(jev(f, rel))}) (subpath ${sbplString(jev(f, rel))})`);
      }
      // the `.git` pair still leads the line and the tty literal still closes it
      expect(line.startsWith(`(deny file-write* (literal ${sbplString(join(f.ws, '.git', 'config'))}) (subpath ${sbplString(join(f.ws, '.git', 'hooks'))}) `)).toBe(true);
      expect(line.endsWith(' (literal "/dev/ttys004"))')).toBe(true);
      // and the line is emitted AFTER the write allow — the only reason a later deny can win
      expect(ordinalOf(p, '(allow file-write*')).toBeLessThan(ordinalOf(p, '(deny file-write* (literal'));
      // `memory-local` is never a write deny: the importer writes there, the run just may not read it
      expect(line).not.toContain('memory-local');
    } finally {
      f.cleanup();
    }
  });

  it('(b) the memory-local read deny sits AFTER both read re-allows — ordinal, not presence', () => {
    const f = fixture();
    try {
      const p = buildProfile(f.opts);
      const abs = jev(f, 'memory-local');
      const expected = `(deny file-read* (literal ${sbplString(abs)}) (subpath ${sbplString(abs)}))`;
      const lines = p.split('\n');
      const deny = lines.indexOf(expected);
      expect(deny, 'the memory-local deny is emitted verbatim').toBeGreaterThan(-1);
      const allowData = ordinalOf(p, '(allow file-read-data ');
      const allowAll = ordinalOf(p, '(allow file-read* ');
      expect(allowData).toBeGreaterThan(-1);
      expect(allowAll).toBeGreaterThan(-1);
      expect(deny).toBeGreaterThan(allowData);
      expect(deny).toBeGreaterThan(allowAll);
      // exactly one line mentions it, so nothing routed it through addRead as well
      expect(lines.filter((l) => l.includes('memory-local'))).toHaveLength(1);
      // the failure mode the graft exists for, pinned: the addRead deny DOES sit before the re-allow,
      // so a rule placed there is silently overridden by the `<ws>` root in `roots`
      expect(ordinalOf(p, '(deny file-read* (subpath ')).toBeLessThan(allowAll);
      expect(ordinalOf(p, '(deny file-read-data ')).toBeLessThan(allowData);
    } finally {
      f.cleanup();
    }
  });

  it('(b2) the read deny survives noNetwork and stays the last rule before (deny network*)', () => {
    const f = fixture();
    try {
      const lines = buildProfile({ ...f.opts, noNetwork: true }).trimEnd().split('\n');
      expect(lines[lines.length - 1]).toBe('(deny network*)');
      expect(lines[lines.length - 2]).toContain(jev(f, 'memory-local'));
    } finally {
      f.cleanup();
    }
  });

  it('protectGit: false drops the three write denies (a fresh clone has no memory to protect) and keeps the read deny', () => {
    const f = fixture();
    try {
      const p = buildProfile({ ...f.opts, protectGit: false });
      expect(p).toContain('(deny file-write* (literal "/dev/ttys004"))');
      for (const rel of ['memory', 'rules', 'commands']) expect(p).not.toContain(`(subpath ${sbplString(jev(f, rel))})`);
      const noTty = buildProfile({ ...f.opts, ttyPath: null, protectGit: false });
      expect(noTty.split('\n').filter((l) => l.startsWith('(deny file-write* ('))).toEqual([]);
      // the read deny is a confidentiality rule, not a git-write rule: it is not gated on the flag
      const abs = jev(f, 'memory-local');
      expect(noTty).toContain(`(deny file-read* (literal ${sbplString(abs)}) (subpath ${sbplString(abs)}))`);
    } finally {
      f.cleanup();
    }
  });

  it('no other line changed: removing the four new fragments reproduces the pre-[G2.1] profile byte for byte', () => {
    const f = fixture();
    try {
      const abs = jev(f, 'memory-local');
      const memoryLocalDeny = `(deny file-read* (literal ${sbplString(abs)}) (subpath ${sbplString(abs)}))`;
      const before = buildProfile(f.opts)
        .split('\n')
        .filter((l) => l !== memoryLocalDeny)
        .map((l) =>
          l.startsWith('(deny file-write* (literal')
            ? ['memory', 'rules', 'commands'].reduce((acc, rel) => acc.replace(` (literal ${sbplString(jev(f, rel))}) (subpath ${sbplString(jev(f, rel))})`, ''), l)
            : l,
        );
      expect(before).toEqual([
        '(version 1)',
        '(allow default)',
        '(deny file-write*)',
        `(allow file-write* (subpath ${sbplString(f.ws)}) (subpath ${sbplString(f.opts.runTmp)}) (subpath ${sbplString(f.opts.runHome)})`,
        '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty")',
        '  (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$") (subpath "/dev/fd"))',
        `(deny file-write* (literal ${sbplString(join(f.ws, '.git', 'config'))}) (subpath ${sbplString(join(f.ws, '.git', 'hooks'))}) (literal "/dev/ttys004"))`,
        `(deny file-read* (subpath ${sbplString(join(f.home, '.config', 'jevcode'))}) (subpath ${sbplString(join(f.home, '.ssh'))}) ` +
          `(subpath ${sbplString(join(f.home, '.aws'))}) (subpath ${sbplString(join(f.home, '.config', 'gh'))}) (literal ${sbplString(join(f.home, '.netrc'))}))`,
        `(deny file-read-data (subpath ${sbplString(join(f.home, '.jevcode'))}))`,
        `(allow file-read-data (subpath ${sbplString(f.ws)}) (subpath ${sbplString(f.opts.runTmp)}) (subpath ${sbplString(f.opts.runHome)}))`,
        `(allow file-read* (subpath ${sbplString(f.ws)}) (subpath ${sbplString(f.opts.runTmp)}) (subpath ${sbplString(f.opts.runHome)}))`,
        '',
      ]);
    } finally {
      f.cleanup();
    }
  });
});
