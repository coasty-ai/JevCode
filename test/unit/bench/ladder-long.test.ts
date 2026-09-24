/**
 * The long tiers of the ladder (bench/data/ladder README "The long tier", tasks 13-20, and "The
 * long-2 tier", tasks 21-26): the fourteen long-horizon tasks load behind the original twelve
 * without disturbing them (`--tasks 12` still selects exactly the originals in the original
 * order, `--tasks 20` the originals plus the long tier), every meta declares its tier and the
 * buggy tree's exact failing set, every gold diff applies cleanly to a copy of its tree and
 * yields gold, and (when a pytest interpreter is available) a real pytest run of each buggy tree
 * fails exactly `expected_failing` while the gold tree is green.
 *
 * WHICH python grades the ladder is stated, never inferred from host state (F24a). In order:
 *   1. `$JEVCODE_LADDER_PYTHON` — a path OR a bare command name resolved on PATH (`python3.12`);
 *   2. `~/.jevcode/ladder-venv/bin/python` — a USER-BUILT venv, created by nothing in this repo; a
 *      developer who wants one interpreter to grade every ladder run makes it once by hand
 *      (`python3 -m venv ~/.jevcode/ladder-venv && ~/.jevcode/ladder-venv/bin/pip install
 *      pytest==8.4.2`, the version `src/bench/ladder/venv.ts` pins), and nothing prunes it;
 *   3. `~/.jevcode/runs/ladder-venv/bin/python` — the BENCH's own venv if a bench has built one;
 *   4. the system `python3`.
 * Each is accepted only if it imports pytest, and a PINNED interpreter that cannot grade is reported
 * rather than silently replaced. Probe 3 used to be the only default, i.e. the interpreter was read
 * from INSIDE the product's own runs directory, which jevcode creates and prunes and which the tests
 * point `JEVCODE_HOME` away from: whether the 26-task tier ran at all was a function of whether a
 * prune had happened to sweep it. It stays as a probe because a machine that has run the bench has a
 * pinned-pytest interpreter there and it is a better grader than an arbitrary system python3 — but it
 * is no longer the default, so a prune only demotes the run to probe 4. That venv stays where it is
 * for the BENCH — `src/bench/ladder/venv.ts` builds `<runsDir>/ladder-venv` deliberately, because
 * `pyworkspace.ts linkVenv` needs it on the sandbox's one allowed root.
 * The resolved interpreter is appended to the live case's name, so the report says which binary
 * graded the ladder and a skip is never silent.
 *
 * `existsSync` is deliberately NOT part of the test: it is false for every bare command name, so
 * gating the pinned value on it rejected `JEVCODE_LADDER_PYTHON=python3` — a working interpreter —
 * with "is missing or does not import pytest" and skipped all 26 tasks, while the fallback one line
 * below ran the identical binary and graded them in 8 s. The probe below spawns instead and tells the
 * two rejections apart: not runnable (ENOENT / no exit status) versus runnable without pytest.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { goldDiffFor, loadLadderSources } from '../../../src/bench/ladder/loader.js';
import { LADDER_TIERS, loadLadderRecords, orderByTier, parseIndex, tierRank, validateMeta, type LadderRecord } from '../../../src/bench/ladder/tasks.js';
import { selectSources } from '../../../src/bench/runner.js';
import { tempDir } from './helpers.js';

const REAL_DATA = join(process.cwd(), 'bench', 'data');
const LADDER = join(REAL_DATA, 'ladder');
const REAL_LADDER = existsSync(join(LADDER, 'index.json'));

/** The original twelve, in index (alphabetical) order: `--tasks 12` must select exactly these. */
const ORIGINAL_12 = ['account', 'calendar_utils', 'events', 'grades', 'inventory', 'profiles', 'shipping', 'stats', 'table', 'tagcloud', 'textstats', 'units'];
/** Tasks 13-20 (tier "long"), alphabetical within the tier. */
const LONG_8 = ['crossfile', 'import_and_guard', 'ledger5', 'long_chain', 'masked', 'regress_trap', 'shared_frame', 'six_hunks'];
/** Tasks 21-26 (tier "long-2", coupled defects across files), alphabetical within the tier. */
const LONG2_6 = ['csv_schema', 'deadline_queue', 'dep_order', 'hunk_merge', 'route_match', 'token_bucket'];
const ALL_26 = [...ORIGINAL_12, ...LONG_8, ...LONG2_6];

/**
 * Spawns the candidate. A bare command name is resolved on PATH by the spawn itself, which is why nothing here
 * stats the file: `existsSync('python3')` is false and would reject a perfectly good interpreter.
 *   'ok'           — it ran and imported pytest
 *   'no-pytest'    — it ran and could not import pytest (a python without the package)
 *   'not-runnable' — it never ran: not on PATH, not a file, not executable (ENOENT / killed / no status)
 */
type Probe = 'ok' | 'no-pytest' | 'not-runnable';
function probePytest(python: string): Probe {
  const r = spawnSync(python, ['-c', 'import pytest'], { encoding: 'utf8' });
  if (r.error !== undefined || r.status === null) return 'not-runnable';
  return r.status === 0 ? 'ok' : 'no-pytest';
}

/** The env override, so a run can STATE its interpreter instead of hoping the host has the right one. */
const LADDER_PYTHON_ENV = 'JEVCODE_LADDER_PYTHON';
/** The user-built venv, OUTSIDE `~/.jevcode/runs` — that directory is jevcode's own, created and pruned by it. */
const LADDER_VENV = join(homedir(), '.jevcode', 'ladder-venv', 'bin', 'python');
/** The bench's own venv (`src/bench/ladder/venv.ts` `<runsDir>/ladder-venv`): pinned pytest when a bench has run. */
const BENCH_VENV = join(homedir(), '.jevcode', 'runs', 'ladder-venv', 'bin', 'python');
/** The probes after the override, in preference order, each with the name the report uses. */
const PROBES: readonly { python: string; why: string }[] = [
  { python: LADDER_VENV, why: `the user-built venv ${LADDER_VENV}` },
  { python: BENCH_VENV, why: `the bench venv ${BENCH_VENV}` },
  { python: 'python3', why: 'the system python3' },
];

/** The resolved interpreter, or the reason there is none — both go into the live case's name. */
function pytestPython(): { python: string | null; why: string } {
  const pinned = process.env[LADDER_PYTHON_ENV]?.trim();
  if (pinned !== undefined && pinned !== '') {
    // a pinned interpreter that cannot grade is an error to report, never a silent fall back to another binary —
    // and the report distinguishes "I could not run it" from "it has no pytest", which are different mistakes
    const r = probePytest(pinned);
    if (r === 'ok') return { python: pinned, why: `$${LADDER_PYTHON_ENV}=${pinned}` };
    const why = r === 'not-runnable' ? (pinned.includes('/') ? 'is not an executable file' : 'is not on PATH') : 'does not import pytest';
    return { python: null, why: `$${LADDER_PYTHON_ENV}=${pinned} ${why}` };
  }
  for (const probe of PROBES) {
    if (probePytest(probe.python) === 'ok') return { python: probe.python, why: probe.why };
  }
  return { python: null, why: `no pytest: tried $${LADDER_PYTHON_ENV}, ${LADDER_VENV}, ${BENCH_VENV}, python3` };
}

const { python: PYTHON, why: GRADED_BY } = pytestPython();

/** the system interpreter's own state, so the cases below say what they measure instead of assuming a host */
const SYSTEM_PYTEST = probePytest('python3') === 'ok';

describe('which interpreter grades the ladder (F24a)', () => {
  const withPinned = <T>(value: string | undefined, fn: () => T): T => {
    const before = process.env[LADDER_PYTHON_ENV];
    if (value === undefined) delete process.env[LADDER_PYTHON_ENV];
    else process.env[LADDER_PYTHON_ENV] = value;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env[LADDER_PYTHON_ENV];
      else process.env[LADDER_PYTHON_ENV] = before;
    }
  };

  it.skipIf(!SYSTEM_PYTEST)('honours a PATH-relative pin: `python3` is resolved by the spawn, never stat()ed', () => {
    // failing-first: with the `existsSync(pinned) &&` conjunct this returned { python: null } and skipped all 26
    // tasks with "is missing or does not import pytest", while the very next probe ran the identical binary
    expect(withPinned('python3', pytestPython)).toEqual({ python: 'python3', why: `$${LADDER_PYTHON_ENV}=python3` });
    expect(withPinned('  python3  ', pytestPython).python).toBe('python3'); // trimmed, so a stray space is not a skip
  });

  it('tells the two rejections apart: not runnable vs. runnable without pytest', () => {
    const notOnPath = withPinned('jevcode-no-such-python', pytestPython);
    expect(notOnPath.python).toBeNull();
    expect(notOnPath.why).toBe(`$${LADDER_PYTHON_ENV}=jevcode-no-such-python is not on PATH`);

    const notAFile = withPinned('/nonexistent/bin/python', pytestPython);
    expect(notAFile.python).toBeNull();
    expect(notAFile.why).toBe(`$${LADDER_PYTHON_ENV}=/nonexistent/bin/python is not an executable file`);

    // a binary that runs and has no pytest: `/bin/echo` exits 0 on anything, so use `false`-like semantics —
    // `/usr/bin/true` runs and imports nothing, i.e. it exits 0; the honest probe is a python-less runnable file
    const noPytest = withPinned('/bin/ls', pytestPython);
    expect(noPytest.python).toBeNull();
    expect(noPytest.why).toBe(`$${LADDER_PYTHON_ENV}=/bin/ls does not import pytest`);
  });

  it('a pin is never silently replaced, and an absent pin walks the four probes in order', () => {
    // the pinned value is reported, not swapped for the fallback that would have worked
    expect(withPinned('jevcode-no-such-python', pytestPython).python).toBeNull();
    expect(PROBES.map((p) => p.python)).toEqual([LADDER_VENV, BENCH_VENV, 'python3']);
    // probe 2 is the user-built venv (nothing in this repo creates it) and probe 3 the bench's own, which a
    // `jevcode bench` run does create — F24a moved the DEFAULT out of runs/, it did not drop that venv as a probe
    expect(LADDER_VENV).toBe(join(homedir(), '.jevcode', 'ladder-venv', 'bin', 'python'));
    expect(BENCH_VENV).toBe(join(homedir(), '.jevcode', 'runs', 'ladder-venv', 'bin', 'python'));
    const resolved = withPinned(undefined, pytestPython);
    if (SYSTEM_PYTEST) expect(resolved.python).not.toBeNull();
    expect(GRADED_BY.length).toBeGreaterThan(0);
  });
});

interface PytestRun {
  status: number | null;
  failing: string[];
  passed: number;
  out: string;
}

function runPytest(python: string, cwd: string): PytestRun {
  const r = spawnSync(python, ['-m', 'pytest', '-p', 'no:cacheprovider', '--no-header', '-rfE'], { cwd, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 60_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const failing = [...out.matchAll(/^(?:FAILED|ERROR) (\S+)/gm)].map((m) => m[1]!).sort();
  const passed = Number(/(\d+) passed/.exec(out)?.[1] ?? 0);
  return { status: r.status, failing, passed, out };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('ladder meta: tier and expected_failing', () => {
  const base = { name: 'x', hunks: 1, kinds: ['guard'], files: ['src/x.py'], difficulty: 1, description: 'd' };

  it('defaults to tier short with no expected_failing; validates the long tier fields', () => {
    const short = validateMeta(base, 'w');
    expect(short.tier).toBe('short');
    expect(short.expectedFailing).toBeUndefined();
    expect('expectedFailing' in short).toBe(false);
    const long = validateMeta({ ...base, tier: 'long', expected_failing: ['tests/test_x.py::test_b[case-1]', 'tests/test_x.py::test_a'] }, 'w');
    expect(long.tier).toBe('long');
    expect(long.expectedFailing).toEqual(['tests/test_x.py::test_a', 'tests/test_x.py::test_b[case-1]']);
    expect(validateMeta({ ...base, tier: 'short', expected_failing: ['tests/test_x.py::test_a'] }, 'w').expectedFailing).toEqual(['tests/test_x.py::test_a']);
    const long2 = validateMeta({ ...base, tier: 'long-2', expected_failing: ['tests/test_x.py::test_a'] }, 'w');
    expect(long2.tier).toBe('long-2');
    expect(() => validateMeta({ ...base, tier: 'medium' }, 'w')).toThrow(/tier must be one of short, long, long-2/);
    expect(() => validateMeta({ ...base, tier: 'long' }, 'w')).toThrow(/tier long requires expected_failing/);
    expect(() => validateMeta({ ...base, tier: 'long-2' }, 'w')).toThrow(/tier long-2 requires expected_failing/);
    expect(() => validateMeta({ ...base, tier: 'long', expected_failing: [] }, 'w')).toThrow(/non-empty string array/);
    expect(() => validateMeta({ ...base, tier: 'long', expected_failing: ['src/x.py::test_a'] }, 'w')).toThrow(/not a pytest id under tests\//);
    expect(() => validateMeta({ ...base, tier: 'long', expected_failing: ['tests/test_x.py::test_a', 'tests/test_x.py::test_a'] }, 'w')).toThrow(/duplicates/);
    expect(LADDER_TIERS).toEqual(['short', 'long', 'long-2']);
    expect(tierRank('short')).toBeLessThan(tierRank('long'));
    expect(tierRank('long')).toBeLessThan(tierRank('long-2'));
  });

  it('parseIndex orders short before long before long-2, stably, whatever the file order', () => {
    const entries = [
      { ...base, name: 'l1', tier: 'long', expected_failing: ['tests/test_l1.py::test_a'] },
      { ...base, name: 'c1', tier: 'long-2', expected_failing: ['tests/test_c1.py::test_a'] },
      { ...base, name: 's1' },
      { ...base, name: 'l2', tier: 'long', expected_failing: ['tests/test_l2.py::test_a'] },
      { ...base, name: 's2', tier: 'short' },
      { ...base, name: 'c2', tier: 'long-2', expected_failing: ['tests/test_c2.py::test_a'] },
    ];
    expect(parseIndex(JSON.stringify(entries), 'w').map((m) => m.name)).toEqual(['s1', 's2', 'l1', 'l2', 'c1', 'c2']);
    expect(orderByTier([{ tier: 'long-2', n: 0 }, { tier: 'long', n: 1 }, { tier: 'short', n: 2 }, { tier: 'long', n: 3 }] as const).map((x) => x.n)).toEqual([2, 1, 3, 0]);
  });
});

describe.skipIf(!REAL_LADDER)('ladder real data: the long tiers behind the original twelve', () => {
  it('loads all 26; --tasks 12 selects exactly the original twelve in order; the long tiers follow and are selectable by id', async () => {
    const records = await loadLadderRecords(LADDER);
    expect(records.map((r) => r.meta.name)).toEqual(ALL_26);
    expect(records.slice(0, 12).every((r) => r.meta.tier === 'short' && r.meta.expectedFailing === undefined)).toBe(true);
    expect(records.slice(12, 20).every((r) => r.meta.tier === 'long')).toBe(true);
    expect(records.slice(20).every((r) => r.meta.tier === 'long-2')).toBe(true);
    const sources = await loadLadderSources(REAL_DATA, { mocked: false });
    expect(sources.map((s) => s.id)).toEqual(ALL_26);
    expect(selectSources(sources, { tasks: 12, taskIds: null }).map((s) => s.id)).toEqual(ORIGINAL_12);
    expect(selectSources(sources, { tasks: 20, taskIds: null }).map((s) => s.id)).toEqual([...ORIGINAL_12, ...LONG_8]);
    expect(selectSources(sources, { tasks: 26, taskIds: null }).map((s) => s.id)).toEqual(ALL_26);
    expect(selectSources(sources, { tasks: 13, taskIds: null }).map((s) => s.id)).toEqual([...ORIGINAL_12, 'crossfile']);
    // the long-2 tier is selected by id: `--task-id csv_schema,deadline_queue,dep_order,hunk_merge,route_match,token_bucket`
    expect(selectSources(sources, { tasks: null, taskIds: LONG2_6 }).map((s) => s.id)).toEqual(LONG2_6);
    expect(selectSources(sources, { tasks: null, taskIds: ['ledger5', 'masked', 'shared_frame', 'crossfile', 'import_and_guard', 'regress_trap', 'six_hunks', 'long_chain'] }).map((s) => s.id))
      .toEqual(['ledger5', 'masked', 'shared_frame', 'crossfile', 'import_and_guard', 'regress_trap', 'six_hunks', 'long_chain']);
  });

  it('every long-tier task: 2-6 modules, expected_failing ids under its own tests/, its own pytest.ini, and a task text without the description', async () => {
    const records = (await loadLadderRecords(LADDER)).filter((r) => r.meta.tier !== 'short');
    expect(records).toHaveLength(14);
    expect(records.filter((r) => r.meta.tier === 'long-2')).toHaveLength(6);
    for (const r of records) {
      const w = r.meta.name;
      expect(r.meta.files.length, w).toBeGreaterThanOrEqual(2);
      expect(r.meta.files.length, w).toBeLessThanOrEqual(6);
      expect(r.meta.hunks, w).toBeGreaterThanOrEqual(2);
      expect(r.meta.expectedFailing!.length, w).toBeGreaterThanOrEqual(2);
      for (const id of r.meta.expectedFailing!) expect(existsSync(join(r.taskDir, id.split('::')[0]!)), `${w} ${id}`).toBe(true);
      expect(r.pytestIni, w).toContain('testpaths = tests');
      expect(r.task, w).not.toContain(r.meta.description.slice(0, 40));
    }
  });

  it('every long-2 task couples at least two modules and keeps a regression suite of 12+ passing tests', async () => {
    const records = (await loadLadderRecords(LADDER)).filter((r) => r.meta.tier === 'long-2');
    expect(records.map((r) => r.meta.name)).toEqual(LONG2_6);
    for (const r of records) {
      const w = r.meta.name;
      // the tier's defining property: the fix is hunks in two or more files
      expect(r.meta.files.length, w).toBeGreaterThanOrEqual(2);
      expect(r.meta.hunks, w).toBeGreaterThanOrEqual(r.meta.files.length);
      expect(r.meta.kinds, w).toContain('two_files');
      // 4-8 failing tests, and the failing set never covers a whole test file's worth of the suite
      expect(r.meta.expectedFailing!.length, w).toBeGreaterThanOrEqual(4);
      expect(r.meta.expectedFailing!.length, w).toBeLessThanOrEqual(8);
      // the failing tests are spread over at least two test modules, so no one file is the whole goal
      expect(new Set(r.meta.expectedFailing!.map((id) => id.split('::')[0]!)).size, w).toBeGreaterThanOrEqual(2);
    }
  });

  it('every gold diff (all 26) applies cleanly to a copy of src/ and yields gold', async () => {
    const records = await loadLadderRecords(LADDER);
    expect(records).toHaveLength(26);
    const t = await tempDir();
    cleanups.push(t.cleanup);
    for (const r of records) {
      const diff = await goldDiffFor(r);
      const dir = join(t.dir, r.meta.name);
      await cp(join(r.taskDir, 'src'), join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'gold.diff'), diff);
      execFileSync('git', ['apply', '--check', 'gold.diff'], { cwd: dir, encoding: 'utf8' });
      execFileSync('git', ['apply', 'gold.diff'], { cwd: dir, encoding: 'utf8' });
      for (const f of r.meta.files) expect(await readFile(join(dir, f), 'utf8'), `${r.meta.name} ${f}`).toBe(await readFile(join(r.taskDir, 'gold', f.split('/').at(-1)!), 'utf8'));
      // one hunk per planted bug: the -U3 diff may merge close hunks, so it has at most `hunks` hunks and at least one per changed file
      expect((diff.match(/^@@/gm) ?? []).length, r.meta.name).toBeLessThanOrEqual(r.meta.hunks);
      expect((diff.match(/^diff --git/gm) ?? []).length, r.meta.name).toBe(r.meta.files.length);
    }
  }, 60_000);

  it.skipIf(PYTHON === null)(`pytest on every buggy tree fails exactly expected_failing (or fails at all, for the short tier) and every gold tree is green — graded by ${GRADED_BY}`, async () => {
    const records = await loadLadderRecords(LADDER);
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const copy = async (r: LadderRecord): Promise<string> => {
      const dir = join(t.dir, r.meta.name);
      await cp(r.taskDir, dir, { recursive: true });
      return dir;
    };
    for (const r of records) {
      const dir = await copy(r);
      const buggy = runPytest(PYTHON!, dir);
      expect(buggy.status, `${r.meta.name} buggy exit`).toBe(1);
      expect(buggy.failing.length, `${r.meta.name} buggy fails`).toBeGreaterThan(0);
      expect(buggy.passed, `${r.meta.name} pass-to-pass guard`).toBeGreaterThan(0);
      if (r.meta.expectedFailing !== undefined) expect(buggy.failing, r.meta.name).toEqual(r.meta.expectedFailing);
      for (const f of r.meta.files) await cp(join(r.taskDir, 'gold', f.split('/').at(-1)!), join(dir, f));
      const gold = runPytest(PYTHON!, dir);
      expect(gold.status, `${r.meta.name} gold: ${gold.out.slice(-400)}`).toBe(0);
      expect(gold.failing, r.meta.name).toEqual([]);
      expect(gold.passed, r.meta.name).toBe(buggy.passed + buggy.failing.length);
      if (r.meta.tier !== 'short') {
        expect(gold.passed, `${r.meta.name} tests`).toBeGreaterThanOrEqual(20);
        expect(gold.passed, `${r.meta.name} tests`).toBeLessThanOrEqual(60);
      }
    }
  }, 300_000);
});
