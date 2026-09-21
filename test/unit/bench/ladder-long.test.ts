/**
 * The long tier of the ladder (bench/data/ladder README "The long tier", tasks 13-20): the
 * eight long-horizon tasks load behind the original twelve without disturbing them (`--tasks 12`
 * still selects exactly the originals in the original order), every meta declares its tier and
 * the buggy tree's exact failing set, every gold diff applies cleanly to a copy of its tree and
 * yields gold, and (when a pytest interpreter is available) a real pytest run of each buggy tree
 * fails exactly `expected_failing` while the gold tree is green. The live part prefers the shared
 * bench venv `~/.jevcode/runs/ladder-venv` and falls back to the system python3; it is skipped
 * when neither imports pytest.
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

function importsPytest(python: string): boolean {
  return spawnSync(python, ['-c', 'import pytest'], { encoding: 'utf8' }).status === 0;
}

/** `~/.jevcode/runs/ladder-venv/bin/python` when it imports pytest, else `python3` when it does, else null. */
function pytestPython(): string | null {
  const venv = join(homedir(), '.jevcode', 'runs', 'ladder-venv', 'bin', 'python');
  if (existsSync(venv) && importsPytest(venv)) return venv;
  return importsPytest('python3') ? 'python3' : null;
}

const PYTHON = pytestPython();

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
    expect(() => validateMeta({ ...base, tier: 'medium' }, 'w')).toThrow(/tier must be one of short, long/);
    expect(() => validateMeta({ ...base, tier: 'long' }, 'w')).toThrow(/tier long requires expected_failing/);
    expect(() => validateMeta({ ...base, tier: 'long', expected_failing: [] }, 'w')).toThrow(/non-empty string array/);
    expect(() => validateMeta({ ...base, tier: 'long', expected_failing: ['src/x.py::test_a'] }, 'w')).toThrow(/not a pytest id under tests\//);
    expect(() => validateMeta({ ...base, tier: 'long', expected_failing: ['tests/test_x.py::test_a', 'tests/test_x.py::test_a'] }, 'w')).toThrow(/duplicates/);
    expect(LADDER_TIERS).toEqual(['short', 'long']);
    expect(tierRank('short')).toBeLessThan(tierRank('long'));
  });

  it('parseIndex orders short before long, stably, whatever the file order', () => {
    const entries = [
      { ...base, name: 'l1', tier: 'long', expected_failing: ['tests/test_l1.py::test_a'] },
      { ...base, name: 's1' },
      { ...base, name: 'l2', tier: 'long', expected_failing: ['tests/test_l2.py::test_a'] },
      { ...base, name: 's2', tier: 'short' },
    ];
    expect(parseIndex(JSON.stringify(entries), 'w').map((m) => m.name)).toEqual(['s1', 's2', 'l1', 'l2']);
    expect(orderByTier([{ tier: 'long', n: 1 }, { tier: 'short', n: 2 }, { tier: 'long', n: 3 }] as const).map((x) => x.n)).toEqual([2, 1, 3]);
  });
});

describe.skipIf(!REAL_LADDER)('ladder real data: the long tier behind the original twelve', () => {
  it('loads all 20; --tasks 12 selects exactly the original twelve in order; the long tasks follow and are selectable by id', async () => {
    const records = await loadLadderRecords(LADDER);
    expect(records.map((r) => r.meta.name)).toEqual([...ORIGINAL_12, ...LONG_8]);
    expect(records.slice(0, 12).every((r) => r.meta.tier === 'short' && r.meta.expectedFailing === undefined)).toBe(true);
    expect(records.slice(12).every((r) => r.meta.tier === 'long')).toBe(true);
    const sources = await loadLadderSources(REAL_DATA, { mocked: false });
    expect(sources.map((s) => s.id)).toEqual([...ORIGINAL_12, ...LONG_8]);
    expect(selectSources(sources, { tasks: 12, taskIds: null }).map((s) => s.id)).toEqual(ORIGINAL_12);
    expect(selectSources(sources, { tasks: 20, taskIds: null }).map((s) => s.id)).toEqual([...ORIGINAL_12, ...LONG_8]);
    expect(selectSources(sources, { tasks: 13, taskIds: null }).map((s) => s.id)).toEqual([...ORIGINAL_12, 'crossfile']);
    expect(selectSources(sources, { tasks: null, taskIds: ['ledger5', 'masked', 'shared_frame', 'crossfile', 'import_and_guard', 'regress_trap', 'six_hunks', 'long_chain'] }).map((s) => s.id))
      .toEqual(['ledger5', 'masked', 'shared_frame', 'crossfile', 'import_and_guard', 'regress_trap', 'six_hunks', 'long_chain']);
  });

  it('every long task: 3-6 modules, 20-60 tests worth of expected_failing ids under its own tests/, its own pytest.ini, and a task text without the description', async () => {
    const records = (await loadLadderRecords(LADDER)).filter((r) => r.meta.tier === 'long');
    expect(records).toHaveLength(8);
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

  it('every gold diff (all 20) applies cleanly to a copy of src/ and yields gold', async () => {
    const records = await loadLadderRecords(LADDER);
    expect(records).toHaveLength(20);
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

  it.skipIf(PYTHON === null)('pytest on every buggy tree fails exactly expected_failing (or fails at all, for the short tier) and every gold tree is green', async () => {
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
      if (r.meta.tier === 'long') {
        expect(gold.passed, `${r.meta.name} tests`).toBeGreaterThanOrEqual(20);
        expect(gold.passed, `${r.meta.name} tests`).toBeLessThanOrEqual(60);
      }
    }
  }, 180_000);
});
