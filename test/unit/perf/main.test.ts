/**
 * `src/perf/main.ts`: `driverLines` keeps only real pty driver processes out of a `pgrep -fl` listing (the run records
 * other agents' drivers alive at its start), not processes whose argv merely mentions the driver names — and the two
 * refusals that come before any measurement:
 *
 *   * F02: `jevcode perf` is advertised in `--help`, the man page and all three completions, but its instruments
 *     (`bin/jevcode.js`, `scripts/pty/drive.exp`, `perf/drivers/pty_type.py`) are resolved from the CWD and the last
 *     two are not in the shipped package at all. A CWD that is not a checkout is a diagnosis, not a probe-by-probe
 *     failure cascade;
 *   * F15: the perf window. Two autonomous sessions share this machine, and the sentinel that says "a measurement is
 *     running" was, until now, a bullet in a design doc that no code read.
 *
 * The review's two follow-ons are here too: the window is taken with an **exclusive create** so the OS arbitrates
 * between two runs that start in the same instant rather than a `statSync` taken a moment earlier (C-04, asserted
 * with six real processes released from one barrier), and the static-append child inherits the run's injected
 * environment rather than `process.env` (C-05).
 *
 * Every `runPerf` case here points `JEVCODE_PERF_ONLY` at a probe name that does not exist, so a refusal that
 * failed to fire would be caught by the unknown-probe error rather than by a real probe starting: no test in this
 * file may ever spawn a pty, and the assertion on WHICH error comes back is also the assertion that no probe ran.
 * `JEVCODE_PERF_WINDOW` keeps every case off the machine's real `/tmp/jevcode-perf-window-open`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedFlags } from '../../../src/cli/args.js';
import { ConfigError } from '../../../src/errors.js';
import {
  PERF_NEEDS_CHECKOUT,
  PERF_WINDOW_TTL_FLOOR_MS,
  PERF_WINDOW_TTL_MAX_MS,
  driverLines,
  isPartial,
  measureStaticAppendInChild,
  openPerfWindow,
  parsePerfWindowHeader,
  perfWindowState,
  perfWindowTtlMs,
  runPerf,
  selectedProbes,
} from '../../../src/perf/main.js';

/** The protocol's line: `<iso-8601 created> <pid> <owner-label> <expected-minutes>`. */
const header = (agoMs: number, pid = 4242, owner = 'bench-arm', mins = 30): string => `${new Date(Date.now() - agoMs).toISOString()} ${pid} ${owner} ${mins}\n`;

const FLAGS = { command: 'perf' } as ParsedFlags;
/** a probe name `selectedProbes` rejects: the tripwire that proves the refusals happen before any measurement */
const NO_PROBE = 'no-such-probe';

const temps: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A CWD that passes the checkout guard: the perf binary is there and `package.json` is ours. */
function checkoutCwd(prefix = 'jevcode-perf-cwd-'): string {
  const root = tempDir(prefix);
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin/jevcode.js'), '#!/usr/bin/env node\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@coasty/jevcode', version: '0.0.0-test' }));
  return root;
}

interface Attempt {
  error: unknown;
  lines: string[];
  /** did the sentinel exist at the moment the run said it had taken it? */
  liveWhileTaken: boolean;
}

/** Run `runPerf` against an injected CWD, env and log, and report what came back. */
async function attempt(cwd: string, windowPath: string, only: string = NO_PROBE): Promise<Attempt> {
  const lines: string[] = [];
  let liveWhileTaken = false;
  const log = (s: string): void => {
    lines.push(s);
    if (s.includes('perf window taken')) liveWhileTaken = existsSync(windowPath);
  };
  let error: unknown = null;
  try {
    await runPerf(FLAGS, { cwd, env: { JEVCODE_PERF_ONLY: only, JEVCODE_PERF_WINDOW: windowPath }, log });
  } catch (e: unknown) {
    error = e;
  }
  return { error, lines, liveWhileTaken };
}

const PERF_MAIN = join(dirname(fileURLToPath(import.meta.url)), '../../../src/perf/main.js');

describe('selectedProbes: the release set and the opt-in probes', () => {
  it('a bare run measures the nine release probes; stream-latency (like lane-run) runs only when named, which makes the run partial', () => {
    const release = selectedProbes({});
    expect(release).toEqual(['first-frame', 'step-overhead', 'static-append', 'render-lag', 'composer-latency', 'intake-latency', 'idle-frames', 'states', 'scroll-latency']);
    expect(release).not.toContain('stream-latency');
    expect(selectedProbes({ JEVCODE_PERF_ONLY: 'stream-latency' })).toEqual(['stream-latency']);
    // named next to the whole release set it is still one more than the release set: `partial` (length ≠ release), never a release number
    const all = selectedProbes({ JEVCODE_PERF_ONLY: [...release, 'stream-latency'].join(',') });
    expect(all).toHaveLength(release.length + 1);
    expect(isPartial(all)).toBe(true);
    expect(() => selectedProbes({ JEVCODE_PERF_ONLY: 'stream-latancy' })).toThrow(/unknown probe\(s\) stream-latancy \(known: .*sandbox-spawn, stream-latency\)/);
  });

  it('partial means "not exactly the release set": an opt-in probe swapped in for a release probe keeps the count at nine and is still partial', () => {
    const release = selectedProbes({});
    expect(isPartial(release)).toBe(false);
    expect(isPartial(selectedProbes({ JEVCODE_PERF_ONLY: release.join(',') }))).toBe(false);
    expect(isPartial(selectedProbes({ JEVCODE_PERF_ONLY: 'states' }))).toBe(true);
    const eight = release.filter((p) => p !== 'scroll-latency');
    for (const optIn of ['stream-latency', 'lane-run', 'sandbox-spawn']) {
      const swapped = selectedProbes({ JEVCODE_PERF_ONLY: [...eight, optIn].join(',') });
      expect(swapped).toHaveLength(release.length);
      expect(isPartial(swapped)).toBe(true);
    }
  });
});

describe('driverLines', () => {
  it('keeps expect … drive.exp and python3 … pty_type.py processes, drops shells and editors that only mention them, truncates long lines', () => {
    const out = [
      '18589 expect scripts/pty/drive.exp /tmp/jevpty/chat1.steps /tmp/jevpty/chat1.cap /tmp/jevpty/chat1.timing 60 -- node bin/jevcode.js chat --mock',
      '21300 /usr/bin/expect -f scripts/pty/drive.exp .scratch/pty/run-review-y.steps .scratch/pty/out/run-review-y.cap 60 -- npx tsx .scratch/pty-session.tsx',
      '4242 /usr/bin/python3 /Users/x/JevCode/perf/drivers/pty_type.py /tmp/steps.json /tmp/cap.bin /tmp/t.jsonl -- node bin/jevcode.js chat --mock',
      '96817 /bin/zsh -c source snapshot.sh && python3 - <<EOF drive.exp pty_type.py',
      'new = "/** other pty drivers alive (`pgrep -fl drive.exp|pty_type.py`) */"',
      '7 vim src/perf/drive.exp.notes',
      '',
      `8 expect scripts/pty/drive.exp ${'x'.repeat(200)}`,
    ].join('\n');
    const lines = driverLines(out);
    expect(lines).toHaveLength(4);
    expect(lines[0]!.startsWith('18589 expect scripts/pty/drive.exp')).toBe(true);
    expect(lines[1]!.startsWith('21300 /usr/bin/expect -f scripts/pty/drive.exp')).toBe(true);
    expect(lines[2]!.startsWith('4242 /usr/bin/python3 ')).toBe(true);
    expect(lines[3]!).toHaveLength(160);
    expect(lines[3]!.endsWith('…')).toBe(true);
    expect(driverLines('')).toEqual([]);
  });
});

describe('runPerf refuses a working directory that is not a JevCode checkout (F02)', () => {
  it('rejects with ConfigError exit 2 and the checkout sentence, before any probe is selected', async () => {
    const cwd = tempDir('jevcode-perf-installed-');
    // what an installed package's user has: no bin/jevcode.js, no scripts/pty, no perf/drivers
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'someone-elses-project' }));
    const windowPath = join(tempDir('jevcode-perf-win-'), 'window');

    const { error, lines } = await attempt(cwd, windowPath);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toBe(PERF_NEEDS_CHECKOUT);
    expect((error as ConfigError).exitCode).toBe(2);
    // the unknown probe was never reached, so nothing measured and nothing was printed
    expect((error as ConfigError).message).not.toContain(NO_PROBE);
    expect(lines).toEqual([]);
    // and a refused run takes no window
    expect(existsSync(windowPath)).toBe(false);
  });

  it('gets past the checkout guard when bin/jevcode.js is there (the repo run the release gate uses)', async () => {
    const windowPath = join(tempDir('jevcode-perf-win-'), 'window');
    const { error } = await attempt(checkoutCwd(), windowPath);
    // not the checkout refusal: this CWD is a checkout, so the run reaches probe selection
    expect(error).not.toBeInstanceOf(ConfigError);
    expect(String(error)).toContain(NO_PROBE);
  });
});

describe('the perf window is a lock file, not a design-doc bullet (F15)', () => {
  it('refuses to start while another run holds the window, naming the file, its age and its owner — and runs no probe', async () => {
    const windowPath = join(tempDir('jevcode-perf-win-'), 'window');
    const line = header(90_000);
    writeFileSync(windowPath, line);

    const { error, lines } = await attempt(checkoutCwd(), windowPath);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).exitCode).toBe(2);
    const msg = (error as ConfigError).message;
    expect(msg).toContain('another perf window is open');
    expect(msg).toContain(windowPath);
    expect(msg).toContain('by bench-arm (pid 4242)');
    expect(msg).toMatch(/taken \d{4}-\d{2}-\d{2}T[\d:.]+Z, 1\.5 min ago, by bench-arm \(pid 4242\); it goes stale after 30\.0 min/);
    // the unknown-probe tripwire never fired: the refusal is ahead of probe selection
    expect(msg).not.toContain(NO_PROBE);
    expect(lines).toEqual([]);
    // the other run's window is left exactly as it was
    expect(readFileSync(windowPath, 'utf8')).toBe(line);
  });

  it('honours a bare `touch`ed sentinel too — the shape the agent prompts actually create', async () => {
    const windowPath = join(tempDir('jevcode-perf-win-'), 'window');
    writeFileSync(windowPath, '');

    const { error, lines } = await attempt(checkoutCwd(), windowPath);
    expect((error as ConfigError).message).toContain('by an unknown process');
    expect((error as ConfigError).exitCode).toBe(2);
    expect(lines).toEqual([]);
    expect(existsSync(windowPath)).toBe(true);
  });

  it('takes the window for the length of the run and removes it in the finally, including when the run throws', async () => {
    const windowPath = join(tempDir('jevcode-perf-win-'), 'window');
    expect(existsSync(windowPath)).toBe(false);

    const { error, lines, liveWhileTaken } = await attempt(checkoutCwd(), windowPath);
    // the run got past both guards and died on the unknown probe — i.e. inside the window
    expect(String(error)).toContain(NO_PROBE);
    expect(lines.join('')).toContain(`perf window taken: ${windowPath} (pid ${process.pid})`);
    expect(liveWhileTaken, 'the sentinel must exist on disk while the run holds it').toBe(true);
    expect(existsSync(windowPath), 'the finally must release the window even when the run throws').toBe(false);
  });

  it('writes the protocol header, and releases only a window that is still its own', async () => {
    const windowPath = join(tempDir('jevcode-perf-win-'), 'window');
    let taken = '';
    const log = (s: string): void => {
      if (s.includes('perf window taken')) taken = readFileSync(windowPath, 'utf8');
    };
    await runPerf(FLAGS, { cwd: checkoutCwd(), env: { JEVCODE_PERF_ONLY: NO_PROBE, JEVCODE_PERF_WINDOW: windowPath }, log }).catch(() => 0);
    const written = parsePerfWindowHeader(taken);
    expect(written, `sentinel line was ${JSON.stringify(taken)}`).not.toBeNull();
    expect(written!.pid).toBe(process.pid);
    expect(written!.owner).toBe('jevcode-perf');
    expect(written!.expectedMinutes).toBe(30);
    expect(Date.now() - written!.createdAt.getTime()).toBeLessThan(60_000);

    // a window that says someone else is not this run's to delete, whatever the finally thinks
    const other = header(0, 4242);
    writeFileSync(windowPath, other);
    const lines: string[] = [];
    const { closePerfWindow } = await import('../../../src/perf/main.js');
    closePerfWindow(windowPath, (s) => lines.push(s));
    expect(readFileSync(windowPath, 'utf8')).toBe(other);
    expect(lines.join('')).toContain('not this run');
  });

  it('replaces a sentinel older than its TTL rather than honouring it, and says so', async () => {
    const windowPath = join(tempDir('jevcode-perf-win-'), 'window');
    writeFileSync(windowPath, header(62 * 60_000, 4242, 'bench-arm', 30));
    expect(perfWindowState(windowPath).kind).toBe('stale');

    const { error, lines, liveWhileTaken } = await attempt(checkoutCwd(), windowPath);
    expect(String(error), 'a stale window must not refuse the run').toContain(NO_PROBE);
    const text = lines.join('');
    expect(text).toContain(`perf: ${windowPath} is 62.0 min old (stale after 30.0 min) and was taken by bench-arm (pid 4242)`);
    expect(text).toContain("treating it as a killed run's leftover and replacing it");
    expect(liveWhileTaken).toBe(true);
    expect(existsSync(windowPath)).toBe(false);
  });

  /**
   * C-04: "a lock file" has to mean the OS arbitrates, not that the run looked first. The window is taken right
   * before `awaitQuietMachine` — i.e. at the moment both sessions on this machine are MOST likely to start
   * together, having just finished waiting on the same sentinel — so the check-then-write shape (`perfWindowState`,
   * then an unconditional `writeFileSync`) let every run interleaved between those two calls read `free` and
   * measure. It also left the first run's `closePerfWindow` declining to unlink (the pid on disk is the last
   * writer's), so the leftover outlived every one of them.
   *
   * Six real processes, released from one barrier: exactly one may come back `TOOK`, and the sentinel on disk must
   * name that one. Before the fix all six took it, every run.
   */
  it('lets exactly one of six simultaneous runs take the window — the OS arbitrates, not a stat taken a moment earlier', async () => {
    const dir = tempDir('jevcode-perf-race-');
    const windowPath = join(dir, 'window');
    const readyPrefix = join(dir, 'ready');
    const go = join(dir, 'go');
    // each child: import the real module, report ready, spin on the barrier, then take the window
    const childPath = join(dir, 'child.mts');
    writeFileSync(
      childPath,
      [
        `import { openPerfWindow } from ${JSON.stringify(PERF_MAIN)};`,
        "import { existsSync, writeFileSync } from 'node:fs';",
        'const [path, ready, barrier] = process.argv.slice(2) as [string, string, string];',
        'writeFileSync(`${ready}.${process.pid}`, String(process.pid));',
        'while (!existsSync(barrier)) { /* released together, so the calls overlap */ }',
        'try {',
        '  openPerfWindow(path, () => undefined);',
        '  process.stdout.write(`TOOK ${process.pid}`);',
        '} catch {',
        '  process.stdout.write(`REFUSED ${process.pid}`);',
        '}',
        '',
      ].join('\n'),
    );

    const RUNS = 6;
    const said: string[] = [];
    const done: Promise<void>[] = [];
    for (let i = 0; i < RUNS; i++) {
      const c = spawn(process.execPath, ['--import', 'tsx', childPath, windowPath, readyPrefix, go], { stdio: ['ignore', 'pipe', 'inherit'] });
      let buf = '';
      c.stdout.on('data', (b: Buffer) => {
        buf += b.toString('utf8');
      });
      done.push(new Promise<void>((r) => c.on('close', () => { said.push(buf.trim()); r(); })));
    }
    const readyCount = (): number => readdirSync(dir).filter((f) => f.startsWith('ready.')).length;
    const deadline = Date.now() + 120_000;
    while (readyCount() < RUNS && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(readyCount(), 'every child must have imported the module before the barrier drops').toBe(RUNS);
    writeFileSync(go, '');
    await Promise.all(done);

    const took = said.filter((l) => l.startsWith('TOOK'));
    expect(took, `six runs answered: ${said.join(' | ')}`).toHaveLength(1);
    expect(said.filter((l) => l.startsWith('REFUSED'))).toHaveLength(RUNS - 1);
    // and the window on disk belongs to the one that took it, so ITS finally is the one that can release it
    const header = parsePerfWindowHeader(readFileSync(windowPath, 'utf8'));
    expect(header).not.toBeNull();
    expect(`TOOK ${header!.pid}`).toBe(took[0]);
  }, 180_000);

  /**
   * C-04, the same defect without the timing: a path that exists on disk while `perfWindowState` reads it as
   * `free`. A dangling symlink is the one such shape a test can build — `statSync` follows it and throws ENOENT,
   * so the state read says the window is free, while the file very much is not absent. Check-then-write reported
   * the window taken and wrote through the link; an exclusive create fails with EEXIST, which is the OS telling
   * this run that something is already there, and the run refuses instead of measuring.
   */
  it('does not write through a path that exists while the state read calls it free', () => {
    const dir = tempDir('jevcode-perf-symlink-');
    const windowPath = join(dir, 'window');
    const target = join(dir, 'gone');
    symlinkSync(target, windowPath);
    expect(perfWindowState(windowPath).kind, 'the state read cannot see it').toBe('free');

    const lines: string[] = [];
    expect(() => openPerfWindow(windowPath, (s) => lines.push(s))).toThrow(ConfigError);
    expect(existsSync(target), 'nothing may be created through the link').toBe(false);
    expect(lines.join('')).not.toContain('perf window taken');
  });

  it('reads a window that is there, one that is not, and one it cannot attribute', () => {
    const dir = tempDir('jevcode-perf-win-');
    expect(perfWindowState(join(dir, 'absent')).kind).toBe('free');

    // a bare touch: no header, so the floor TTL applies, measured from the file's mtime
    const bare = join(dir, 'bare');
    writeFileSync(bare, '');
    const w = perfWindowState(bare);
    expect(w.kind).toBe('held');
    expect(w.kind === 'free' ? '' : w.owner).toBe('an unknown process');
    expect(w.kind === 'free' ? 0 : w.ttlMs).toBe(PERF_WINDOW_TTL_FLOOR_MS);
    const old = (Date.now() - PERF_WINDOW_TTL_FLOOR_MS - 60_000) / 1000;
    utimesSync(bare, old, old);
    expect(perfWindowState(bare).kind).toBe('stale');

    // the header decides the age and the TTL; mtime is only the fallback
    const held = join(dir, 'held');
    writeFileSync(held, header(29 * 60_000, 17, 'perf', 10));
    const h = perfWindowState(held);
    expect(h.kind).toBe('held');
    expect(h.kind === 'free' ? '' : h.owner).toBe('perf (pid 17)');
    // a header may not ask for less than the floor, nor for more than the ceiling
    expect(perfWindowTtlMs({ createdAt: new Date(), pid: 1, owner: 'x', expectedMinutes: 10 })).toBe(PERF_WINDOW_TTL_FLOOR_MS);
    expect(perfWindowTtlMs({ createdAt: new Date(), pid: 1, owner: 'x', expectedMinutes: 45 })).toBe(45 * 60_000);
    expect(perfWindowTtlMs({ createdAt: new Date(), pid: 1, owner: 'x', expectedMinutes: 600 })).toBe(PERF_WINDOW_TTL_MAX_MS);
    expect(perfWindowTtlMs(null)).toBe(PERF_WINDOW_TTL_FLOOR_MS);

    // and the lines that are not a header at all
    expect(parsePerfWindowHeader('')).toBeNull();
    expect(parsePerfWindowHeader('4242\n')).toBeNull();
    expect(parsePerfWindowHeader('not-a-date 4242 perf 30')).toBeNull();
    expect(parsePerfWindowHeader('2026-09-22T10:00:00.000Z zero perf 30')).toBeNull();
    expect(parsePerfWindowHeader('2026-09-22T10:00:00.000Z 4242 perf soon')).toBeNull();
    expect(parsePerfWindowHeader('2026-09-22T10:00:00.000Z 4242 perf 30\nnotes')?.pid).toBe(4242);
  });
});

/**
 * C-05: `PerfRunOptions` says a run's root, environment and log are injected rather than read off the process.
 * The static-append child is the one place a perf run hands an environment to something ELSE, and it was building
 * that environment from `process.env` — so the contract was half true, and a test that injected an env to exercise
 * a probe would silently have got the process's own.
 */
describe('the injected environment reaches the static-append child (C-05)', () => {
  /** A stand-in for `bin/jevcode.js`: it writes what it was actually given into the `--out` file. */
  function echoBin(dir: string): string {
    const bin = join(dir, 'echo-bin.mjs');
    writeFileSync(
      bin,
      [
        "import { writeFileSync } from 'node:fs';",
        "const out = process.argv[process.argv.indexOf('--out') + 1];",
        "console.log('  echo child ran');",
        "writeFileSync(out, JSON.stringify({ staticAppend: { marker: process.env.PERF_TEST_MARKER ?? null, ci: process.env.CI ?? null, only: process.env.JEVCODE_PERF_ONLY ?? null, child: process.env.JEVCODE_PERF_CHILD ?? null, cwd: process.cwd() } }));",
        '',
      ].join('\n'),
    );
    return bin;
  }

  it('spreads the run\'s env, not the process\'s, and still sets the child switches and drops CI', async () => {
    const dir = tempDir('jevcode-perf-child-');
    const bin = echoBin(dir);
    const progress: string[] = [];
    const injected: NodeJS.ProcessEnv = { PATH: process.env['PATH'], PERF_TEST_MARKER: 'from-the-injected-env', CI: 'true' };

    const r = await measureStaticAppendInChild(bin, dir, injected, (l) => progress.push(l));
    expect(r, 'the echo child must have produced a result').not.toBeNull();
    const got = r as unknown as Record<string, unknown>;
    // the marker exists only in the injected env: reading process.env here would report null
    expect(got['marker']).toBe('from-the-injected-env');
    // and the three things the child path owns are still applied on top of it
    expect(got['only']).toBe('static-append');
    expect(got['child']).toBe('1');
    expect(got['ci']).toBeNull();
    expect(got['cwd']).toBe(realpathSync(dir));
    expect(progress).toContain('echo child ran');
  }, 60_000);

  it('does not leak the process environment into the child', async () => {
    const dir = tempDir('jevcode-perf-child-clean-');
    const bin = echoBin(dir);
    process.env['PERF_TEST_MARKER'] = 'from-the-process-env';
    try {
      const r = await measureStaticAppendInChild(bin, dir, { PATH: process.env['PATH'] }, () => undefined);
      expect((r as unknown as Record<string, unknown>)['marker']).toBeNull();
    } finally {
      delete process.env['PERF_TEST_MARKER'];
    }
  }, 60_000);
});
