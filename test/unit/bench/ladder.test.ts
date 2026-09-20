/**
 * Ladder suite (docs/JEV-ONLY.md rung 2) on the synthetic fixture test/fixtures/bench/ladder
 * (same layout as bench/data/ladder): record validation, task-text isolation (meta.json's
 * description and gold/ never reach the task or the workspace), workspace setup, the pytest
 * evaluator, the shared venv resolution, a mocked end-to-end bench through the real runner, and
 * a guarded pass over the real data directory when it is present.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeCounts, evaluateLadder, pytestCommand, verdict } from '../../../src/bench/ladder/evaluator.js';
import { goldDiffFor, goldTrajectory, loadLadderSources, metaFor, sourceFor, toBenchTask } from '../../../src/bench/ladder/loader.js';
import { CONFTEST_PY, PYTEST_INI, gitInitCommand } from '../../../src/bench/ladder/pyworkspace.js';
import { loadLadderRecords, normaliseTaskText, parseIndex, validateMeta } from '../../../src/bench/ladder/tasks.js';
import { LADDER_VENV_DIR, ensureLadderVenv, resetLadderPythonCache, resolveLadderPython, systemPytestPython, venvPython } from '../../../src/bench/ladder/venv.js';
import { renderComparison, suiteTitle } from '../../../src/bench/report.js';
import { readTasksJsonl, runBenchWithSources } from '../../../src/bench/runner.js';
import type { BenchRecord, BenchSetupTools, CommandRunner } from '../../../src/bench/types.js';
import { baseOptions, createFakeDeps, createFakeSandboxFactory, failResult, okResult, tempDir, type EngineScript, type RecordedCommand } from './helpers.js';

const FIXTURE_DATA = join(process.cwd(), 'test', 'fixtures', 'bench');
const FIXTURE = join(FIXTURE_DATA, 'ladder');
const REAL_DATA = join(process.cwd(), 'bench', 'data');
const SYSTEM_PYTEST = spawnSync('python3', ['-c', 'import pytest'], { encoding: 'utf8' }).status === 0;
const REAL_LADDER = existsSync(join(REAL_DATA, 'ladder', 'index.json'));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  resetLadderPythonCache();
  while (cleanups.length) await cleanups.pop()!();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function realTools(ws: string, runDir: string): BenchSetupTools {
  const factory = createFakeSandboxFactory(undefined, 'real');
  const sandbox = factory.create({ workspaceRoot: ws, runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s });
  const run: CommandRunner = (command, o = {}) =>
    sandbox.run(command, { timeoutMs: o.timeoutMs ?? 60_000, maxOutputBytes: o.maxOutputBytes ?? 200_000, signal: new AbortController().signal, cwd: o.cwd ?? ws, ...(o.env ? { env: o.env } : {}) });
  return { run, makeRunner: () => run, mocked: true, runsDir: runDir, signal: new AbortController().signal, log: () => undefined };
}

async function readAll(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await readAll(p));
    else out[p] = await readFile(p, 'utf8');
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('ladder records and sources (fixture)', () => {
  it('loads and validates the fixture index; task text is task.md, the description never reaches it', async () => {
    const records = await loadLadderRecords(FIXTURE);
    expect(records.map((r) => r.meta.name)).toEqual(['ratio', 'greet']);
    const ratio = records[0]!;
    expect(ratio.meta).toEqual({ name: 'ratio', hunks: 2, kinds: ['operator', 'constant'], files: ['src/ratio.py'], difficulty: 2, description: expect.stringContaining('FIXTURE_SECRET'), path: 'tasks/ratio' });
    expect(ratio.task).toBe('Two ratio tests fail. Fix src/ratio.py so tests/test_ratio.py passes; the tests are correct and must not be edited.\n');
    expect(ratio.pytestIni).toContain('addopts = -q');
    expect(records[1]!.pytestIni).toBeNull();
    expect(normaliseTaskText('a\r\nb\r\n\n')).toBe('a\nb\n');
    expect(metaFor(ratio)).toEqual({ difficulty: '2', hunks: 2, kinds: ['operator', 'constant'] });
    const base = { name: 'x', hunks: 1, kinds: ['guard'], files: ['src/x.py'], difficulty: 1, description: 'd' };
    expect(validateMeta(base, 'w').path).toBe('tasks/x');
    expect(() => validateMeta({ ...base, kinds: ['nope'] }, 'w')).toThrow(/unknown kind/);
    expect(() => validateMeta({ ...base, difficulty: 7 }, 'w')).toThrow(/difficulty/);
    expect(() => validateMeta({ ...base, files: ['x.py'] }, 'w')).toThrow(/src\/<module>\.py/);
    expect(() => validateMeta({ ...base, path: '../x' }, 'w')).toThrow(/not relative/);
    expect(() => parseIndex('[1]', 'w')).toThrow(/not an object/);
    expect(() => parseIndex(JSON.stringify([base, base]), 'w')).toThrow(/duplicate/);
    await expect(loadLadderRecords(join(FIXTURE, 'nope'))).rejects.toThrow(/cannot read Ladder index/);
  });

  it('an index entry whose directory is incomplete fails loudly', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    await mkdir(join(t.dir, 'tasks', 'x', 'src'), { recursive: true });
    await writeFile(join(t.dir, 'index.json'), JSON.stringify([{ name: 'x', hunks: 1, kinds: ['guard'], files: ['src/x.py'], difficulty: 1, description: 'd', path: 'tasks/x' }]));
    await expect(loadLadderRecords(t.dir)).rejects.toThrow(/missing tests/);
  });

  it('sources: mocked carries the src → gold patch trajectory, live a bare done; meta has difficulty/hunks/kinds', async () => {
    const mocked = await loadLadderSources(FIXTURE_DATA, { mocked: true });
    const live = await loadLadderSources(FIXTURE_DATA, { mocked: false });
    expect(mocked.map((s) => [s.suite, s.id])).toEqual([['ladder', 'ratio'], ['ladder', 'greet']]);
    expect(mocked[0]!.meta).toEqual({ difficulty: '2', hunks: 2, kinds: ['operator', 'constant'] });
    const task = mocked[0]!.build({ workspaceDir: '/w', auxDir: '/a', mocked: true });
    expect(task.task).not.toContain('FIXTURE_SECRET');
    const turns = task.mockTrajectory();
    expect(turns.map((x) => (x.toolCall!.input as { action: { kind: string } }).action.kind)).toEqual(['read', 'patch', 'run', 'done']);
    expect((turns[0]!.toolCall!.input as { action: { paths: string[] } }).action.paths).toEqual(['src/ratio.py']);
    const diff = (turns[1]!.toolCall!.input as { action: { diff: string } }).action.diff;
    expect(diff).toContain('diff --git a/src/ratio.py b/src/ratio.py');
    expect(diff).toContain('-    return a - b\n+    return a / b');
    expect(diff).toContain('-    return round(100 * part / whole, 2)\n+    return round(100 * part / whole, 1)');
    expect(diff.match(/^@@/gm)).toHaveLength(1); // the two hunks are within 2×context of each other
    expect((turns[2]!.toolCall!.input as { action: { command: string } }).action.command).toBe('python3 -m pytest -q');
    expect(live[0]!.build({ workspaceDir: '/w', auxDir: '/a', mocked: false }).mockTrajectory().map((x) => (x.toolCall!.input as { action: { kind: string } }).action.kind)).toEqual(['done']);
    expect(goldTrajectory(['src/a.py'], 'd')).toHaveLength(4);
    // the gold diff applies to a copy of the task and yields gold
    const t = await tempDir();
    cleanups.push(t.cleanup);
    await cp(join(FIXTURE, 'tasks', 'ratio', 'src'), join(t.dir, 'src'), { recursive: true });
    await writeFile(join(t.dir, 'gold.diff'), diff);
    git(t.dir, 'apply', 'gold.diff');
    expect(await readFile(join(t.dir, 'src', 'ratio.py'), 'utf8')).toBe(await readFile(join(FIXTURE, 'tasks', 'ratio', 'gold', 'ratio.py'), 'utf8'));
  });
});

describe('ladder workspace setup (real fs and git)', () => {
  it('copies src/ and tests/, writes the task pytest.ini (or the default) and conftest.py, commits once; gold, meta and task.md stay out', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const records = await loadLadderRecords(FIXTURE);
    for (const record of records) {
      const ws = join(t.dir, record.meta.name, 'ws');
      await mkdir(ws, { recursive: true });
      const task = toBenchTask({ workspaceDir: ws, auxDir: join(t.dir, record.meta.name, 'aux'), mocked: true, record, python: 'python3' });
      await task.setup(ws, realTools(ws, join(t.dir, record.meta.name, 'run')));
      const files = await readAll(ws);
      const rel = Object.keys(files).map((p) => p.slice(ws.length + 1)).sort();
      expect(rel).toEqual(['conftest.py', 'pytest.ini', 'src/__init__.py', `src/${record.meta.name}.py`, `tests/test_${record.meta.name}.py`]);
      expect(files[join(ws, 'src', `${record.meta.name}.py`)]).toBe(await readFile(join(record.taskDir, 'src', `${record.meta.name}.py`), 'utf8'));
      expect(files[join(ws, 'pytest.ini')]).toBe(record.pytestIni ?? PYTEST_INI);
      expect(files[join(ws, 'conftest.py')]).toBe(CONFTEST_PY);
      for (const [p, text] of Object.entries(files)) expect(text.includes('FIXTURE_SECRET'), p).toBe(false);
      expect(await exists(join(ws, 'gold'))).toBe(false);
      expect(await exists(join(ws, 'task.md'))).toBe(false);
      expect(git(ws, 'rev-list', '--count', 'HEAD')).toBe('1');
      expect(git(ws, 'status', '--porcelain')).toBe('');
      expect(git(ws, 'log', '-1', '--format=%s')).toBe(`ladder ${record.meta.name}: buggy modules and tests`);
    }
    expect(gitInitCommand("it's")).toContain(`-m 'it'\\''s'`);
  }, 60_000);

  it('with the default interpreter, setup builds the shared venv before the first workspace command, and a failed build is logged, not fatal', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const ws = join(t.dir, 'ws');
    await mkdir(ws, { recursive: true });
    const record = (await loadLadderRecords(FIXTURE))[1]!;
    const real = realTools(ws, join(t.dir, 'run'));
    const order: string[] = [];
    const logs: string[] = [];
    const tools: BenchSetupTools = {
      ...real,
      runsDir: t.dir,
      log: (l) => logs.push(l),
      run: (cmd, o) => {
        order.push(`ws: ${cmd.slice(0, 40)}`);
        return real.run(cmd, o);
      },
      makeRunner: (root) => async (cmd) => {
        order.push(`${root === join(t.dir, LADDER_VENV_DIR) ? 'venv' : 'other'}: ${cmd.slice(0, 40)}`);
        return failResult('pip: no network', 1);
      },
    };
    await toBenchTask({ workspaceDir: ws, auxDir: join(t.dir, 'aux'), mocked: true, record }).setup(ws, tools);
    // venv build first (fails here), then the pytest probe through the workspace runner, then git init through it
    expect(order[0]).toMatch(/^venv: python3 -m venv/);
    expect(order[1]).toMatch(/^ws: python3 -c "import pytest/);
    expect(order[2]).toMatch(/^ws: git -c init.defaultBranch=main init/);
    expect(order).toHaveLength(3);
    expect(git(ws, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(logs.some((l) => l.includes('creating pytest venv'))).toBe(true);
    expect(logs.some((l) => /venv unavailable .*using the system python3|pytest venv not available at setup/.test(l))).toBe(true);
    // a task with an explicit interpreter never touches the venv
    order.length = 0;
    const ws2 = join(t.dir, 'ws2');
    await mkdir(ws2, { recursive: true });
    await toBenchTask({ workspaceDir: ws2, auxDir: join(t.dir, 'aux2'), mocked: true, record, python: 'python3' }).setup(ws2, { ...tools, run: (cmd, o) => real.run(cmd, { ...o, cwd: ws2 }) });
    expect(order).toEqual([]);
  }, 60_000);
});

describe('ladder evaluator', () => {
  const scripted = (results: Partial<Parameters<typeof okResult>[0]>[]): { run: CommandRunner; commands: string[] } => {
    const commands: string[] = [];
    let i = 0;
    const run: CommandRunner = async (command) => {
      commands.push(command);
      return okResult(results[Math.min(i++, results.length - 1)]);
    };
    return { run, commands };
  };

  it('verdict and reasons from pytest summaries; modified tests fail; killed or summary-less runs are unevaluated', async () => {
    expect(pytestCommand('python3')).toBe('PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -p no:cacheprovider tests');
    expect(pytestCommand('/r/ladder-venv/bin/python')).toBe("PYTHONDONTWRITEBYTECODE=1 '/r/ladder-venv/bin/python' -m pytest -p no:cacheprovider tests");
    expect(verdict(0, { passed: 5, failed: 0, errors: 0, skipped: 0 })).toBe(true);
    expect(verdict(0, { passed: 0, failed: 0, errors: 0, skipped: 0 })).toBe(false);
    expect(verdict(1, { passed: 5, failed: 0, errors: 0, skipped: 0 })).toBe(false);
    expect(describeCounts({ passed: 2, failed: 3, errors: 0, skipped: 1 })).toBe('passed 2, failed 3, errors 0, skipped 1');
    const pass = scripted([{ stdout: '' }, { stdout: '.....\n5 passed in 0.01s\n' }]);
    expect(await evaluateLadder({ python: 'python3', run: pass.run })).toEqual({ pass: true, evaluator: 'local', evalExitCode: 0 });
    expect(pass.commands[0]).toBe('git status --porcelain -- tests/');
    expect(pass.commands[1]).toBe(pytestCommand('python3'));
    const fail = scripted([{ stdout: '' }, { ok: false, exitCode: 1, stdout: 'FF...\n3 failed, 2 passed in 0.02s\n' }]);
    expect(await evaluateLadder({ python: 'python3', run: fail.run })).toEqual({ pass: false, evaluator: 'local', evalExitCode: 1, reason: 'pytest: passed 2, failed 3, errors 0, skipped 0 (exit 1)' });
    const modified = scripted([{ stdout: ' M tests/test_ratio.py\n?? tests/conftest.py\n' }]);
    const m = await evaluateLadder({ python: 'python3', run: modified.run });
    expect(m).toMatchObject({ pass: false, evaluator: 'local' });
    expect(m.reason).toBe('tests/ was modified: M tests/test_ratio.py; ?? tests/conftest.py');
    expect(modified.commands).toHaveLength(1);
    const killed = scripted([{ stdout: '' }, { ok: false, exitCode: null, killedBy: 'timeout', timedOut: true }]);
    expect(await evaluateLadder({ python: 'python3', run: killed.run })).toMatchObject({ pass: null, evaluator: 'none', reason: 'pytest killed: timeout' });
    const noSummary = scripted([{ stdout: '' }, { ok: false, exitCode: 2, stderr: 'ImportError: nope' }]);
    expect(await evaluateLadder({ python: 'python3', run: noSummary.run })).toMatchObject({ pass: null, evaluator: 'none', evalExitCode: 2 });
  });

  it.skipIf(!SYSTEM_PYTEST)('runs pytest for real on a set-up workspace: buggy fails with counts, gold passes, edited tests fail', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const ws = join(t.dir, 'ws');
    await mkdir(ws, { recursive: true });
    const record = (await loadLadderRecords(FIXTURE))[0]!;
    const tools = realTools(ws, join(t.dir, 'run'));
    await toBenchTask({ workspaceDir: ws, auxDir: join(t.dir, 'aux'), mocked: true, record, python: 'python3' }).setup(ws, tools);
    const buggy = await evaluateLadder({ python: 'python3', run: tools.run });
    expect(buggy).toMatchObject({ pass: false, evaluator: 'local', evalExitCode: 1, reason: 'pytest: passed 2, failed 3, errors 0, skipped 0 (exit 1)' });
    await cp(join(record.taskDir, 'gold', 'ratio.py'), join(ws, 'src', 'ratio.py'));
    expect(await evaluateLadder({ python: 'python3', run: tools.run })).toEqual({ pass: true, evaluator: 'local', evalExitCode: 0 });
    await writeFile(join(ws, 'tests', 'test_ratio.py'), 'def test_nothing():\n    pass\n');
    expect((await evaluateLadder({ python: 'python3', run: tools.run })).reason).toMatch(/^tests\/ was modified: M tests\/test_ratio.py/);
  }, 60_000);
});

describe('ladder pytest interpreter (shared venv)', () => {
  it('reuses a venv whose marker matches without running anything; creates it otherwise; falls back to the system python3 when creation fails', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const commands: RecordedCommand[] = [];
    const make = (result: Partial<ReturnType<typeof okResult>>) => (root: string): CommandRunner => async (command, o) => {
      commands.push({ root, command, cwd: o?.cwd, env: o?.env });
      return okResult(result);
    };
    // existing venv with the right marker: no command runs
    const venv = join(t.dir, LADDER_VENV_DIR);
    await mkdir(join(venv, 'bin'), { recursive: true });
    await writeFile(join(venv, 'bin', 'python'), '');
    await writeFile(join(venv, '.jevcode-packages.json'), JSON.stringify(['pytest==8.4.2']));
    expect(await ensureLadderVenv(t.dir, make({}), () => undefined)).toBe(venvPython(t.dir));
    expect(commands).toHaveLength(0);
    // stale marker: the venv is (re)created through a runner rooted at the venv dir
    await writeFile(join(venv, '.jevcode-packages.json'), '["old"]');
    const logs: string[] = [];
    await ensureLadderVenv(t.dir, make({}), (l) => logs.push(l));
    expect(commands).toHaveLength(1);
    expect(commands[0]!.root).toBe(venv);
    expect(commands[0]!.command).toContain(`python3 -m venv '${venv}'`);
    expect(commands[0]!.command).toContain("pip install -q 'pytest==8.4.2'");
    expect(logs[0]).toContain('creating pytest venv');
    expect(await readFile(join(venv, '.jevcode-packages.json'), 'utf8')).toBe(JSON.stringify(['pytest==8.4.2']));
    // creation failure + system pytest → python3 with a log line; without system pytest the error propagates
    await writeFile(join(venv, '.jevcode-packages.json'), '["old"]');
    const failing = (): CommandRunner => async () => failResult('No module named venv', 1);
    const probeOk: CommandRunner = async () => okResult({ stdout: '8.4.2' });
    const probeBad: CommandRunner = async () => failResult("No module named 'pytest'", 1);
    expect(await resolveLadderPython(t.dir, failing, probeOk, (l) => logs.push(l))).toBe('python3');
    expect(logs.at(-1)).toMatch(/venv unavailable .*using the system python3/);
    resetLadderPythonCache();
    await expect(resolveLadderPython(t.dir, failing, probeBad, () => undefined)).rejects.toThrow(/ladder venv creation failed/);
    expect(await systemPytestPython(probeOk)).toBe('python3');
    expect(await systemPytestPython(probeBad)).toBeNull();
    // the resolution is cached per runsDir
    resetLadderPythonCache();
    const a = resolveLadderPython(t.dir, failing, probeOk, () => undefined);
    const b = resolveLadderPython(t.dir, failing, probeOk, () => undefined);
    expect(a).toBe(b);
  });
});

describe('ladder mocked end to end (real runner, fake engine, real git and pytest)', () => {
  it.skipIf(!SYSTEM_PYTEST)('two tasks × two conditions: gold applied in jev-on passes, jev-off fails with counts; report breaks pass rates down by hunks and difficulty; records carry meta', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const records = await loadLadderRecords(FIXTURE);
    const diffs = new Map<string, string>();
    for (const r of records) diffs.set(r.meta.name, await goldDiffFor(r));
    const sources = records.map((r) => sourceFor(r, diffs.get(r.meta.name)!, 'python3'));
    const sandbox = createFakeSandboxFactory(undefined, 'real');
    const script: EngineScript = (task, mode) => ({
      result: { steps: 4 },
      decisions: mode === 'jev-on' ? 4 : 0,
      effect: async (o) => {
        if (mode !== 'jev-on') return;
        const name = task.startsWith('Two ratio') ? 'ratio' : 'greet';
        await writeFile(join(o.workspace, '.jevcode-gold.diff'), diffs.get(name)!);
        git(o.workspace, 'apply', '.jevcode-gold.diff');
      },
    });
    const { deps, captured } = createFakeDeps({ script, sandbox });
    const out = await runBenchWithSources(sources, baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { suite: 'ladder', concurrency: 2 }), deps);

    expect(out.records).toHaveLength(4);
    const byName = (a: BenchRecord, b: BenchRecord): number => a.task.localeCompare(b.task);
    const on = out.records.filter((r) => r.condition === 'jev-on').sort(byName);
    const off = out.records.filter((r) => r.condition === 'jev-off').sort(byName);
    expect(on.map((r) => [r.task, r.pass, r.evaluator, r.evalExitCode, r.patchEmpty])).toEqual([['greet', true, 'local', 0, false], ['ratio', true, 'local', 0, false]]);
    expect(off.map((r) => [r.task, r.pass, r.evalExitCode, r.patchEmpty])).toEqual([['greet', false, 1, true], ['ratio', false, 1, true]]);
    expect(off[0]!.reason).toBe('pytest: passed 1, failed 2, errors 0, skipped 0 (exit 1)');
    expect(off[1]!.reason).toBe('pytest: passed 2, failed 3, errors 0, skipped 0 (exit 1)');
    expect(out.records.find((r) => r.task === 'ratio')!.meta).toEqual({ difficulty: '2', hunks: 2, kinds: ['operator', 'constant'] });
    expect(out.records.find((r) => r.task === 'greet')!.meta).toEqual({ difficulty: '1', hunks: 1, kinds: ['guard'] });
    // the engine saw task.md only; the description marker is nowhere in prompts or Jev states
    for (const e of captured.engines) expect(['Two ratio tests fail.', 'greet(None) crashes.'].some((s) => e.opts.task.startsWith(s))).toBe(true);
    expect(JSON.stringify({ req: captured.generateRequests, states: captured.askStates })).not.toContain('FIXTURE_SECRET');
    // model patches
    for (const r of on) {
      const patch = await readFile(join(t.dir, 'runs', r.runId!, 'model_patch.diff'), 'utf8');
      expect(patch).toContain(`diff --git a/src/${r.task}.py b/src/${r.task}.py`);
      expect(patch).not.toContain('.jevcode');
    }
    // report
    const md = out.comparisonMarkdown;
    expect(md).toContain(`## ${suiteTitle('ladder')}`);
    expect(md).toContain('## Ladder (hand-made multi-hunk tasks)');
    expect(md).toContain('### Pass rate by hunks (all evaluated records)');
    expect(md).toContain('| hunks | tasks | jev-on | jev-off |');
    expect(md).toContain('| 1 | 1 | 1/1 100.0% | 0/1 0.0% |');
    expect(md).toContain('| 2 | 1 | 1/1 100.0% | 0/1 0.0% |');
    expect(md).toContain('### Pass rate by difficulty (all evaluated records)');
    expect(md).toContain('| difficulty | tasks | jev-on | jev-off |');
    expect(md).not.toContain('### Pass rate by bug kind');
    expect(out.summary.pairedTasks).toEqual({ ladder: 2 });
    expect((await readdir(out.outDir)).sort()).toEqual(['comparison.md', 'summary.json', 'tasks.jsonl']);
    const back = await readTasksJsonl(join(out.outDir, 'tasks.jsonl'));
    expect(back).toHaveLength(4);
    expect(back.every((r) => r.suite === 'ladder' && (r as BenchRecord).meta?.hunks !== undefined)).toBe(true);
    expect(renderComparison(out.summary, back)).toContain('| 2 | 1 | 1/1 100.0% | 0/1 0.0% |');
  }, 120_000);
});

describe('ladder real data directory (when present)', () => {
  it.skipIf(!REAL_LADDER)('loads every task; task text never carries the description; every gold diff applies to a copy and yields gold', async () => {
    const sources = await loadLadderSources(REAL_DATA, { mocked: true });
    const records = await loadLadderRecords(join(REAL_DATA, 'ladder'));
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.length).toBe(records.length);
    const t = await tempDir();
    cleanups.push(t.cleanup);
    for (const [i, s] of sources.entries()) {
      const r = records[i]!;
      const task = s.build({ workspaceDir: '/w', auxDir: '/a', mocked: true });
      expect(task.task).toBe(r.task);
      expect(task.task).not.toContain(r.meta.description.slice(0, 40));
      expect(task.meta).toEqual({ difficulty: String(r.meta.difficulty), hunks: r.meta.hunks, kinds: r.meta.kinds });
      const diff = (task.mockTrajectory()[1]!.toolCall!.input as { action: { diff: string } }).action.diff;
      const dir = join(t.dir, r.meta.name);
      await cp(join(r.taskDir, 'src'), join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'gold.diff'), diff);
      git(dir, 'apply', 'gold.diff');
      for (const f of r.meta.files) expect(await readFile(join(dir, f), 'utf8'), `${r.meta.name} ${f}`).toBe(await readFile(join(r.taskDir, 'gold', f.split('/').at(-1)!), 'utf8'));
    }
  }, 60_000);
});
