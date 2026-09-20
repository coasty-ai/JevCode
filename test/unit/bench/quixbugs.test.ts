/**
 * QuixBugs suite (docs/JEV-ONLY.md rung 1): index loading, task-text isolation (no bug line, no
 * fix), workspace layout with a generated pytest module, run_tests.py parsing, the unified-diff
 * generator against git, and a mocked end-to-end bench of three programs through the real
 * runner with the fake engine and real python/git.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unifiedDiff, diffLines } from '../../../src/bench/ladder/udiff.js';
import { GIT_EXCLUDES } from '../../../src/bench/ladder/pyworkspace.js';
import { describeReport, evaluateQuixbugs, parseRunTestsOutput, runTestsCommand, verdict } from '../../../src/bench/quixbugs/evaluator.js';
import { fixActionFor, fixTrajectory, loadProgram, loadQuixbugsSources, sourceFor, taskText, toBenchTask, type QuixbugsProgram } from '../../../src/bench/quixbugs/loader.js';
import { generatePytestModule } from '../../../src/bench/quixbugs/pytest.js';
import { loadIndex, parseIndex, usesNode, validateCases, type QuixbugsRecord } from '../../../src/bench/quixbugs/tasks.js';
import { breakdownTable, renderComparison, suiteTitle } from '../../../src/bench/report.js';
import { readTasksJsonl, runBenchWithSources } from '../../../src/bench/runner.js';
import type { BenchRecord, BenchSetupTools, CommandRunner } from '../../../src/bench/types.js';
import { applyEditToContent } from '../../../src/workspace/edit.js';
import { baseOptions, createFakeDeps, createFakeSandboxFactory, okResult, tempDir, type EngineScript } from './helpers.js';

const DATA = join(process.cwd(), 'bench', 'data');
const QB = join(DATA, 'quixbugs');
const INSERTIONS = ['depth_first_search', 'reverse_linked_list', 'shunting_yard', 'wrap'];
const SYSTEM_PYTEST = spawnSync('python3', ['-c', 'import pytest'], { encoding: 'utf8' }).status === 0;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function py(cwd: string, args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const r = spawnSync('python3', args, { cwd, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env } });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** BenchSetupTools whose runner really executes in the workspace (git, python). */
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

describe('quixbugs index and sources', () => {
  it('loads the 40-record index; 31 JSON programs, 9 module programs, 4 insertion fixes', async () => {
    const records = await loadIndex(QB);
    expect(records).toHaveLength(40);
    expect(records.filter((r) => r.hasJsonTests)).toHaveLength(31);
    expect(records.filter((r) => r.buggyLine === null).map((r) => r.name).sort()).toEqual(INSERTIONS);
    expect(records.every((r) => r.testCount > 0 && r.fixedLine.trim() !== '')).toBe(true);
    expect(() => parseIndex('[{"name": "x", "bugLine": 1, "buggyLine": "a", "fixedLine": "b", "kind": "nope", "hasJsonTests": true, "testCount": 1}]', 'x')).toThrow(/unknown kind/);
    expect(() => parseIndex('[{"bugLine": 1}]', 'x')).toThrow(/malformed name/);
    expect(() => parseIndex('nope', 'x')).toThrow(/invalid JSON/);
    expect(() => validateCases([{ input: 1 }], 'x')).toThrow(/"input"/);
    expect(usesNode('from node import Node\n')).toBe(true);
    expect(usesNode('import node\n')).toBe(true);
    expect(usesNode('def node(): pass\n')).toBe(false);
  });

  it('task text names the function and file only; the bug line, the fix and the kind never reach it (live: no fix loaded)', async () => {
    const mocked = await loadQuixbugsSources(DATA, { mocked: true });
    const live = await loadQuixbugsSources(DATA, { mocked: false });
    expect(mocked).toHaveLength(40);
    expect(live.map((s) => s.id)).toEqual(mocked.map((s) => s.id));
    const records = await loadIndex(QB);
    for (const [i, s] of mocked.entries()) {
      const r = records[i]!;
      expect(s.suite).toBe('quixbugs');
      expect(s.id).toBe(r.name);
      expect(s.meta).toEqual({ kind: r.kind, category: r.kind });
      const t = s.build({ workspaceDir: '/w', auxDir: '/a', mocked: true });
      expect(t.task).toBe(`The function \`${r.name}\` in \`${r.name}.py\` has a bug that makes some tests in tests/ fail. Fix it without changing the tests.`);
      const visible = JSON.stringify({ task: t.task, id: t.id, meta: t.meta });
      expect(visible).not.toContain(r.fixedLine);
      if (r.buggyLine !== null) expect(visible).not.toContain(r.buggyLine);
      expect(visible).not.toContain(String(r.bugLine));
      // mocked trajectory: read → edit|patch → run → done
      const turns = t.mockTrajectory().map((x) => (x.toolCall!.input as { action: { kind: string } }).action.kind);
      expect(turns).toEqual(['read', INSERTIONS.includes(r.name) ? 'patch' : 'edit', 'run', 'done']);
      // live: the fix is never loaded, the trajectory is a bare `done`
      const lt = live[i]!.build({ workspaceDir: '/w', auxDir: '/a', mocked: false });
      expect(lt.task).toBe(t.task);
      expect(lt.mockTrajectory().map((x) => (x.toolCall!.input as { action: { kind: string } }).action.kind)).toEqual(['done']);
    }
    expect(taskText({ ...records[0]!, description: 'Counts the set bits.' })).toContain('\n\nCounts the set bits.');
  });

  it('fixActionFor: an edit unique in the file changing exactly the bug line to fixedLine, or a git-applicable patch for insertions', async () => {
    const records = await loadIndex(QB);
    const t = await tempDir();
    cleanups.push(t.cleanup);
    let edits = 0;
    for (const r of records) {
      const buggy = await readFile(join(QB, 'programs', `${r.name}.py`), 'utf8');
      const correct = await readFile(join(QB, 'correct', `${r.name}.py`), 'utf8');
      const fix = fixActionFor(r, buggy, correct);
      if (fix.kind === 'edit') {
        edits++;
        expect(fix.path).toBe(`${r.name}.py`);
        const after = applyEditToContent(buggy, fix);
        const before = buggy.split('\n');
        const changed = after.split('\n').filter((l, i) => l !== before[i]);
        expect(changed).toHaveLength(1);
        expect(changed[0]!.trim()).toBe(r.fixedLine);
        expect(after.split('\n')).toHaveLength(before.length);
      } else {
        expect(INSERTIONS).toContain(r.name);
        const dir = join(t.dir, r.name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${r.name}.py`), buggy);
        await writeFile(join(dir, 'fix.diff'), fix.diff);
        git(dir, 'apply', 'fix.diff');
        expect(await readFile(join(dir, `${r.name}.py`), 'utf8')).toBe(correct);
      }
    }
    expect(edits).toBe(36);
    // an ambiguous line is widened with the preceding line until unique (get_factors: `return []` twice)
    const gf = records.find((r) => r.name === 'get_factors')!;
    const fix = fixActionFor(gf, await readFile(join(QB, 'programs', 'get_factors.py'), 'utf8'), await readFile(join(QB, 'correct', 'get_factors.py'), 'utf8'));
    expect(fix.kind).toBe('edit');
    if (fix.kind === 'edit') {
      expect(fix.old).toBe('\n    return []');
      expect(fix.new).toBe('\n    return [n]');
    }
    // a record whose buggy line is not where the index says falls back to a patch
    const wrong: QuixbugsRecord = { ...gf, bugLine: 2, buggyLine: 'this line does not exist' };
    expect(fixActionFor(wrong, 'def get_factors(n):\n    return []\n', 'def get_factors(n):\n    return [n]\n').kind).toBe('patch');
    expect(fixTrajectory('gcd', 'test_gcd.py', { kind: 'edit', path: 'gcd.py', old: 'a', new: 'b' })).toHaveLength(4);
  });
});

describe('quixbugs workspace setup (real fs, git and python)', () => {
  it('JSON program: buggy file, tests/test_<name>.py + cases, pytest.ini, conftest.py, one commit; the generated module compiles, imports without pytest and runs standalone', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const ws = join(t.dir, 'ws');
    await mkdir(ws, { recursive: true });
    const records = await loadIndex(QB);
    const program = await loadProgram(QB, records.find((r) => r.name === 'gcd')!, true);
    // python: null keeps the unit test offline (no shared pytest venv is built or linked)
    const task = toBenchTask({ workspaceDir: ws, auxDir: join(t.dir, 'aux'), mocked: true, quixbugsDir: QB, program, python: null });
    await task.setup(ws, realTools(ws, join(t.dir, 'run')));

    const buggy = await readFile(join(QB, 'programs', 'gcd.py'), 'utf8');
    expect(await readFile(join(ws, 'gcd.py'), 'utf8')).toBe(buggy);
    expect(buggy).toContain('return gcd(a % b, b)');
    expect(await readFile(join(ws, 'tests', 'gcd.json'), 'utf8')).toBe(await readFile(join(QB, 'tests', 'gcd.json'), 'utf8'));
    const ini = await readFile(join(ws, 'pytest.ini'), 'utf8');
    expect(ini).toContain('testpaths = tests');
    expect(ini).toContain('pythonpath = .');
    expect(await readFile(join(ws, 'conftest.py'), 'utf8')).toContain('sys.path.insert(0, ROOT)');
    await expect(stat(join(ws, 'node.py'))).rejects.toThrow();
    // the fix is nowhere in the workspace
    for (const [p, text] of Object.entries(await readAll(ws))) expect(text.includes('return gcd(b, a % b)'), p).toBe(false);
    // one commit holding the tree, nothing dirty, bench excludes in place
    expect(git(ws, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(ws, 'status', '--porcelain')).toBe('');
    const exclude = await readFile(join(ws, '.git', 'info', 'exclude'), 'utf8');
    for (const e of GIT_EXCLUDES) expect(exclude).toContain(e);

    const test = await readFile(join(ws, 'tests', 'test_gcd.py'), 'utf8');
    expect(test).toBe(generatePytestModule('gcd', program.tests.kind === 'json' ? program.tests.cases : []));
    expect(test).toContain('from gcd import gcd');
    expect(test).not.toContain('a % b');
    expect(py(ws, ['-m', 'py_compile', 'tests/test_gcd.py']).status).toBe(0);
    // imports with pytest masked out (plain python), and runs the cases standalone: buggy fails, correct passes
    expect(py(ws, ['-c', "import sys; sys.modules['pytest'] = None; sys.path.insert(0, 'tests'); import test_gcd; print(len(test_gcd.CASES))"]).out.trim()).toBe('6');
    const buggyRun = py(ws, ['tests/test_gcd.py']);
    expect(buggyRun.status).toBe(1);
    expect(buggyRun.out).toMatch(/6 case\(s\), [1-6] failing/);
    await writeFile(join(ws, 'gcd.py'), await readFile(join(QB, 'correct', 'gcd.py'), 'utf8'));
    const fixedRun = py(ws, ['tests/test_gcd.py']);
    expect(fixedRun.status).toBe(0);
    expect(fixedRun.out).toContain('6 case(s), 0 failing');
    if (SYSTEM_PYTEST) {
      const r = py(ws, ['-m', 'pytest', '-q']);
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/6 passed/);
    }
  }, 60_000);

  it('graph program: node.py beside the program and the copied <name>_test.py; slow JSON cases are skip-marked; sqrt uses the tolerance rule', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const ws = join(t.dir, 'ws');
    await mkdir(ws, { recursive: true });
    const records = await loadIndex(QB);
    const bfs = await loadProgram(QB, records.find((r) => r.name === 'breadth_first_search')!, true);
    await toBenchTask({ workspaceDir: ws, auxDir: join(t.dir, 'aux'), mocked: true, quixbugsDir: QB, program: bfs, python: null }).setup(ws, realTools(ws, join(t.dir, 'run')));
    expect(await readFile(join(ws, 'node.py'), 'utf8')).toBe(await readFile(join(QB, 'programs', 'node.py'), 'utf8'));
    expect(await readFile(join(ws, 'tests', 'breadth_first_search_test.py'), 'utf8')).toBe(await readFile(join(QB, 'tests', 'breadth_first_search_test.py'), 'utf8'));
    await expect(stat(join(ws, 'tests', 'test_breadth_first_search.py'))).rejects.toThrow();
    if (SYSTEM_PYTEST) {
      const r = py(ws, ['-m', 'pytest', '-q']);
      expect(r.status).toBe(1);
      expect(r.out).toMatch(/4 passed/);
    }
    const knapsack = await loadProgram(QB, records.find((r) => r.name === 'knapsack')!, false);
    expect(knapsack.fix).toBeNull();
    const cases = knapsack.tests.kind === 'json' ? knapsack.tests.cases : [];
    expect(cases.some((c) => c.slow === true)).toBe(true);
    expect(generatePytestModule('knapsack', cases)).toContain('pytest.mark.skip(reason="slow case, skipped by QuixBugs too")');
    expect(generatePytestModule('sqrt', [])).toContain('ABS_TOLERANCE_FROM_LAST_ARG = True');
    expect(generatePytestModule('gcd', [])).toContain('ABS_TOLERANCE_FROM_LAST_ARG = False');
  }, 60_000);
});

describe('quixbugs evaluator', () => {
  it('parses run_tests.py output: counts, failures, error line, noise, garbage', () => {
    const line = '{"name": "gcd", "passed": 1, "failed": 0, "errors": 5, "timeouts": 0, "skipped": 0, "total": 6, "failures": [{"input": [13, 13], "expected": 13, "actual": "RecursionError: maximum recursion depth exceeded"}]}';
    const r = parseRunTestsOutput(`noise\n${line}\n`);
    expect(r).not.toBeNull();
    expect(r && !('error' in r) ? r : null).toMatchObject({ name: 'gcd', passed: 1, failed: 0, errors: 5, total: 6 });
    if (r && !('error' in r)) {
      expect(r.failures).toEqual([{ input: '[13,13]', expected: '13', actual: 'RecursionError: maximum recursion depth exceeded' }]);
      expect(describeReport(r)).toBe('passed 1/6, failed 0, errors 5 (timeouts 0), skipped 0; first failure: input [13,13] expected 13 actual RecursionError: maximum recursion depth exceeded');
      expect(verdict(1, r)).toBe(false);
      expect(verdict(0, { ...r, errors: 0 })).toBe(true);
      expect(verdict(0, { ...r, errors: 0, passed: 0 })).toBe(false);
      expect(verdict(null, { ...r, errors: 0 })).toBe(false);
    }
    expect(parseRunTestsOutput('{"name": "x", "error": "candidate not found: /x.py"}\n')).toEqual({ error: 'candidate not found: /x.py' });
    expect(parseRunTestsOutput('{"passed": 1}\n')).toBeNull();
    expect(parseRunTestsOutput('nothing here')).toBeNull();
    expect(runTestsCommand('/d/quixbugs', 'gcd', "/w/it's.py")).toBe(`PYTHONDONTWRITEBYTECODE=1 python3 '/d/quixbugs/run_tests.py' 'gcd' '/w/it'\\''s.py'`);
  });

  it('runs run_tests.py for real: buggy fails with counts in the reason, correct passes; a killed run is unevaluated', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const tools = realTools(t.dir, join(t.dir, 'run'));
    const buggy = await evaluateQuixbugs({ quixbugsDir: QB, name: 'gcd', workspaceDir: join(QB, 'programs'), run: tools.run });
    expect(buggy).toMatchObject({ pass: false, evaluator: 'local', evalExitCode: 1 });
    expect(buggy.reason).toMatch(/^run_tests: passed 1\/6, failed 0, errors 5/);
    const fixed = await evaluateQuixbugs({ quixbugsDir: QB, name: 'gcd', workspaceDir: join(QB, 'correct'), run: tools.run });
    expect(fixed).toEqual({ pass: true, evaluator: 'local', evalExitCode: 0 });
    const missing = await evaluateQuixbugs({ quixbugsDir: QB, name: 'gcd', workspaceDir: t.dir, run: tools.run });
    expect(missing.pass).toBeNull();
    expect(missing.reason).toMatch(/candidate not found/);
    const killed: CommandRunner = async () => okResult({ ok: false, exitCode: null, killedBy: 'timeout', timedOut: true });
    expect(await evaluateQuixbugs({ quixbugsDir: QB, name: 'gcd', workspaceDir: t.dir, run: killed })).toMatchObject({ pass: null, evaluator: 'none', reason: 'run_tests.py killed: timeout' });
  }, 60_000);
});

describe('unified diff generator', () => {
  it('matches git diff on every programs/ vs correct/ pair (hunk bodies), handles no-newline endings and equal inputs', async () => {
    const records = await loadIndex(QB);
    const body = (s: string): string =>
      s
        .split('\n')
        .filter((l) => l.startsWith('@@') || /^[ +-]/.test(l))
        .filter((l) => !l.startsWith('---') && !l.startsWith('+++'))
        .map((l) => (l.startsWith('@@') ? l.replace(/(@@ .*? @@).*$/, '$1') : l))
        .join('\n');
    for (const r of records) {
      const a = join(QB, 'programs', `${r.name}.py`);
      const b = join(QB, 'correct', `${r.name}.py`);
      const g = spawnSync('git', ['diff', '--no-index', '--no-color', a, b], { encoding: 'utf8' }).stdout;
      const mine = unifiedDiff(`${r.name}.py`, await readFile(a, 'utf8'), await readFile(b, 'utf8'));
      expect(mine.startsWith(`diff --git a/${r.name}.py b/${r.name}.py\n--- a/${r.name}.py\n+++ b/${r.name}.py\n@@ `)).toBe(true);
      expect(body(mine), r.name).toBe(body(g));
    }
    expect(unifiedDiff('x', 'same\n', 'same\n')).toBe('');
    expect(unifiedDiff('x.txt', 'a\nb', 'a\nb\n')).toBe('diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n');
    expect(unifiedDiff('x.txt', '', 'a\n')).toBe('diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -0,0 +1,1 @@\n+a\n');
    expect(diffLines(['a', 'b', 'c'], ['a', 'c']).map((o) => o.kind)).toEqual(['equal', 'delete', 'equal']);
    // two changes further apart than 2×context are separate hunks
    const far = unifiedDiff('f', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', 'A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n');
    expect(far.match(/^@@/gm)).toHaveLength(2);
  });
});

describe('quixbugs mocked end to end (real runner, fake engine, real git and python)', () => {
  it('three programs × two conditions: the fix applied in jev-on passes run_tests.py, the untouched jev-off fails with counts; report has the by-kind table; records carry meta and round-trip', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const records = await loadIndex(QB);
    const names = ['gcd', 'breadth_first_search', 'wrap'];
    const programs = new Map<string, QuixbugsProgram>();
    for (const n of names) programs.set(n, await loadProgram(QB, records.find((r) => r.name === n)!, true));
    const sources = names.map((n) => sourceFor(QB, programs.get(n)!, undefined, null));
    const sandbox = createFakeSandboxFactory(undefined, 'real');
    // jev-on applies the mocked trajectory's fix the way the engine's edit/patch action would; jev-off leaves the program alone
    const script: EngineScript = (task, mode) => ({
      result: { steps: 4 },
      decisions: mode === 'jev-on' ? 4 : 0,
      effect: async (o) => {
        if (mode !== 'jev-on') return;
        const name = /The function `(\w+)`/.exec(task)![1]!;
        const fix = programs.get(name)!.fix!;
        if (fix.kind === 'edit') await writeFile(join(o.workspace, fix.path), applyEditToContent(await readFile(join(o.workspace, fix.path), 'utf8'), fix));
        else {
          await writeFile(join(o.workspace, '.jevcode-fix.diff'), fix.diff);
          git(o.workspace, 'apply', '.jevcode-fix.diff');
        }
      },
    });
    const { deps, captured } = createFakeDeps({ script, sandbox });
    const out = await runBenchWithSources(sources, baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { suite: 'quixbugs', concurrency: 2 }), deps);

    expect(out.records).toHaveLength(6);
    const byName = (a: BenchRecord, b: BenchRecord): number => names.indexOf(a.task) - names.indexOf(b.task);
    const on = out.records.filter((r) => r.condition === 'jev-on').sort(byName);
    const off = out.records.filter((r) => r.condition === 'jev-off').sort(byName);
    expect(on.map((r) => [r.task, r.pass, r.evaluator, r.evalExitCode, r.patchEmpty, (r.patchBytes ?? 0) > 0])).toEqual(names.map((n) => [n, true, 'local', 0, false, true]));
    expect(off.every((r) => r.pass === false && r.evaluator === 'local' && r.evalExitCode === 1 && r.patchEmpty === true && r.patchBytes === 0)).toBe(true);
    expect(off.find((r) => r.task === 'gcd')!.reason).toMatch(/^run_tests: passed 1\/6, failed 0, errors 5/);
    expect(off.find((r) => r.task === 'wrap')!.reason).toMatch(/^run_tests: passed 0\/5, failed 5/);
    expect(out.records.every((r) => r.suite === 'quixbugs' && r.pairComplete && r.meta?.kind === records.find((x) => x.name === r.task)!.kind)).toBe(true);
    // the engine saw exactly the task text; no fix line in any prompt or Jev state
    for (const e of captured.engines) expect(e.opts.task).toMatch(/^The function `(gcd|breadth_first_search|wrap)` in `\1\.py` has a bug/);
    const everything = JSON.stringify({ req: captured.generateRequests, states: captured.askStates });
    for (const s of ['return gcd(b, a % b)', 'while queue:', 'lines.append(text)']) expect(everything).not.toContain(s);
    // model_patch saved per run: jev-on carries the fix and no bench files, jev-off is empty
    for (const r of on) {
      const patch = await readFile(join(t.dir, 'runs', r.runId!, 'model_patch.diff'), 'utf8');
      expect(patch).toContain(`diff --git a/${r.task}.py b/${r.task}.py`);
      expect(patch).not.toContain('.jevcode');
      expect(patch).not.toContain('__pycache__');
    }
    for (const r of off) expect(await readFile(join(t.dir, 'runs', r.runId!, 'model_patch.diff'), 'utf8')).toBe('');
    // workspaces: buggy program + tests + pytest.ini, a git repo; the wrap fix came through the patch path
    for (const e of captured.engines) {
      const ws = e.opts.workspace;
      expect((await stat(join(ws, '.git'))).isDirectory()).toBe(true);
      expect((await readdir(ws)).sort()).toEqual(expect.arrayContaining(['conftest.py', 'pytest.ini', 'tests']));
    }
    // summary + report
    expect(out.summary.suites).toEqual(['quixbugs']);
    expect(out.summary.pairedTasks).toEqual({ quixbugs: 3 });
    expect(out.summary.perSuite['quixbugs']!.perCondition['jev-on']!.passRateText).toBe('3/3 (n=3)');
    const md = out.comparisonMarkdown;
    expect(md).toContain(`## ${suiteTitle('quixbugs')}`);
    expect(md).toContain('## QuixBugs Python (40 one-line bugs)');
    expect(md).toContain('### Pass rate by bug kind (all evaluated records)');
    expect(md).toContain('| kind | tasks | jev-on | jev-off |');
    expect(md).toContain('| argument_swap | 1 | 1/1 100.0% | 0/1 0.0% |');
    expect(md).toContain('| control_flow | 1 | 1/1 100.0% | 0/1 0.0% |');
    expect(md).toContain('| other | 1 | 1/1 100.0% | 0/1 0.0% |');
    expect(md).not.toContain('### Pass rate by hunks');
    // no predictions files for this suite; tasks.jsonl round-trips with the suite accepted and meta kept
    expect((await readdir(out.outDir)).sort()).toEqual(['comparison.md', 'summary.json', 'tasks.jsonl']);
    const back = await readTasksJsonl(join(out.outDir, 'tasks.jsonl'));
    expect(back).toHaveLength(6);
    expect(back.every((r) => r.suite === 'quixbugs' && (r as BenchRecord).meta?.kind !== undefined)).toBe(true);
    expect(renderComparison(out.summary, back)).toContain('| argument_swap | 1 | 1/1 100.0% | 0/1 0.0% |');
  }, 120_000);

  it('breakdownTable groups by every key, counts tasks, and files records without the field under unknown', () => {
    const rec = (task: string, condition: 'jev-on' | 'jev-off', pass: boolean | null, meta?: BenchRecord['meta']): BenchRecord =>
      ({ suite: 'ladder', task, condition, pass, evaluator: 'local', steps: 1, wallMs: 1, tokensPerStep: [], generatorTokensPerStep: [], jevTokensPerStep: [], cost: { generator: 0, jev: 0 }, jevLatencyMs: { raw: [], p50: null, p95: null }, jevRequests: 0, jevQuestions: 0, timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0 }, stopReason: 'complete', blocked: 0, reviews: 0, declined: 0, loops: 0, replans: 0, reads: 0, modelDrift: false, pairComplete: true, patchEmpty: null, patchApplied: null, patchBytes: null, runId: null, capFired: null, ...(meta ? { meta } : {}) });
    const records = [
      rec('a', 'jev-on', true, { kinds: ['operator', 'guard'], hunks: 2 }),
      rec('a', 'jev-off', false, { kinds: ['operator', 'guard'], hunks: 2 }),
      rec('b', 'jev-on', null, { kinds: ['guard'], hunks: 10 }),
      rec('b', 'jev-off', true, { kinds: ['guard'], hunks: 10 }),
      rec('c', 'jev-on', true),
    ];
    const byKind = breakdownTable(records, ['jev-on', 'jev-off'], 'kind', (r) => r.meta?.kinds ?? []);
    expect(byKind).toBe(['| kind | tasks | jev-on | jev-off |', '| --- | --- | --- | --- |', '| guard | 2 | 1/1 100.0% | 1/2 50.0% |', '| operator | 1 | 1/1 100.0% | 0/1 0.0% |', '| unknown | 1 | 1/1 100.0% | 0/0 null |'].join('\n'));
    // numeric keys sort numerically (10 after 2)
    const byHunks = breakdownTable(records.slice(0, 4), ['jev-on'], 'hunks', (r) => (r.meta?.hunks === undefined ? [] : [String(r.meta.hunks)]));
    expect(byHunks.split('\n').slice(2)).toEqual(['| 2 | 1 | 1/1 100.0% |', '| 10 | 1 | 0/0 null |']);
    expect(breakdownTable([], ['jev-on'], 'x', () => [])).toBe('_no records_');
  });
});
