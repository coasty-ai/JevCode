import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractModelPatch, formatPredictions, modelNameOrPath, modelPatchCommand, predictionsFileName, writePredictions } from '../../../src/bench/swebench/predictions.js';
import { applyWithFallbacks, evaluateSwebenchLocal, testScript } from '../../../src/bench/swebench/evaluator.js';
import { END_TEST_OUTPUT, START_TEST_OUTPUT, evaluateLog, gradeLog, parseLogPytest } from '../../../src/bench/swebench/logparse.js';
import { touchedFiles } from '../../../src/bench/swebench/tasks.js';
import type { SwebenchRecord } from '../../../src/bench/swebench/tasks.js';
import { createFakeSandboxFactory, failResult, okResult, realExec, tempDir } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } }).trim();
}

describe('predictions', () => {
  it('names files and models per condition, filesystem-safe', () => {
    expect(modelNameOrPath('jev-on', 'anthropic/claude-sonnet-5')).toBe('jevcode-jev-on-anthropic__claude-sonnet-5');
    expect(predictionsFileName('jev-off')).toBe('predictions.jev-off.jsonl');
    const text = formatPredictions([{ instance_id: 'a__b-1', model_name_or_path: 'm', model_patch: '' }]);
    expect(JSON.parse(text.trim())).toEqual({ instance_id: 'a__b-1', model_name_or_path: 'm', model_patch: '' });
    expect(modelPatchCommand('abc', '/tmp/x y.diff')).toBe(`git add -A -N && git diff --binary abc -- . ':(exclude).jevcode*' > '/tmp/x y.diff'`);
  });

  it('writes one file per condition with three keys per line', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const p = await writePredictions(t.dir, 'jev-on', [
      { instance_id: 'x__y-1', model_name_or_path: 'jevcode-jev-on-m', model_patch: 'diff' },
      { instance_id: 'x__y-2', model_name_or_path: 'jevcode-jev-on-m', model_patch: '' },
    ]);
    expect(p.endsWith('predictions.jev-on.jsonl')).toBe(true);
    const lines = (await readFile(p, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(Object.keys(JSON.parse(l) as object).sort()).toEqual(['instance_id', 'model_name_or_path', 'model_patch']);
  });

  it('extracts model_patch with intent-to-add, excludes .jevcode*, and the diff applies to a clean checkout', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const repo = join(t.dir, 'repo');
    await mkdir(repo);
    git(repo, 'init', '-q');
    await writeFile(join(repo, 'a.py'), 'x = 1\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'a.py'), 'x = 2\n');
    await writeFile(join(repo, 'new.py'), 'y = 3\n');
    await writeFile(join(repo, '.jevcode-mock-solve.sh'), 'echo hi\n');
    const runDir = join(t.dir, 'run');
    const sandbox = createFakeSandboxFactory(() => undefined, 'real');
    const sb = sandbox.create({ workspaceRoot: repo, runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s });
    const run = (cmd: string, o: { timeoutMs?: number; maxOutputBytes?: number } = {}) => sb.run(cmd, { timeoutMs: o.timeoutMs ?? 10_000, maxOutputBytes: o.maxOutputBytes ?? 65536, signal: new AbortController().signal });
    const patch = await extractModelPatch(run, base, runDir);
    expect(patch.patchEmpty).toBe(false);
    expect(patch.modelPatch).toContain('diff --git a/a.py b/a.py');
    expect(patch.modelPatch).toContain('diff --git a/new.py b/new.py');
    expect(patch.modelPatch).not.toContain('.jevcode-mock-solve.sh');
    expect(touchedFiles(patch.modelPatch)).toEqual(['a.py', 'new.py']);
    expect(await readFile(join(runDir, 'model_patch.diff'), 'utf8')).toBe(patch.modelPatch);
    // applies to a clean checkout
    const clean = join(t.dir, 'clean');
    git(t.dir, 'clone', '-q', repo, clean);
    git(clean, 'checkout', '-q', base);
    await writeFile(join(t.dir, 'p.diff'), patch.modelPatch);
    git(clean, 'apply', '--check', join(t.dir, 'p.diff'));
  });

  it('empty diff is written as "" with patchEmpty: true', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const repo = join(t.dir, 'repo');
    await mkdir(repo);
    git(repo, 'init', '-q');
    await writeFile(join(repo, 'a.py'), 'x = 1\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    const patch = await extractModelPatch((cmd, o) => realExec({ root: repo, command: cmd, cwd: undefined, env: undefined }, { timeoutMs: 10_000, maxOutputBytes: 65536, signal: new AbortController().signal, ...o }), base, join(t.dir, 'run'));
    expect(patch).toEqual({ modelPatch: '', patchBytes: 0, patchEmpty: true });
  });
});

const record: SwebenchRecord = {
  instance_id: 'pytest-dev__pytest-1',
  repo: 'pytest-dev/pytest',
  base_commit: 'a'.repeat(40),
  environment_setup_commit: 'b'.repeat(40),
  version: '7.2',
  created_at: '2020-01-01T00:00:00Z',
  difficulty: '<15 min fix',
  problem_statement: 'Fix it',
  hints_text: '',
  fail_to_pass: ['testing/test_setuponly.py::test_show_only_active_fixtures[--setup-only]'],
  pass_to_pass: ['testing/test_setuponly.py::test_skipped_explicitly', 'testing/test_setuponly.py::test_param[a-b'],
  test_patch: 'diff --git a/testing/test_setuponly.py b/testing/test_setuponly.py\n--- a/testing/test_setuponly.py\n+++ b/testing/test_setuponly.py\n@@ -1 +1,2 @@\n x\n+y\n',
  test_files: ['testing/test_setuponly.py'],
  spec: { python: '3.9', install: 'python -m pip install -e .', pre_install: [], pip_packages: ['py==1.11.0'], packages: null, test_cmd: 'pytest -rA' },
  log_parser: 'parse_log_pytest',
  eval_script: "#!/bin/bash\ngit checkout aaaa testing/test_setuponly.py\n: '>>>>> Start Test Output'\npytest -rA testing/test_setuponly.py\n: '>>>>> End Test Output'\n",
};

describe('local-venv evaluator paths (scripted sandbox)', () => {
  it('patch apply failure path: all four apply commands fail -> pass false, patchApplied false', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const applyCmds: string[] = [];
    const sandbox = createFakeSandboxFactory((c) => {
      if (/^(git apply|patch --batch)/.test(c.command)) {
        applyCmds.push(c.command);
        return failResult('error: patch failed');
      }
      return undefined;
    });
    const makeRunner = (root: string) => {
      const sb = sandbox.create({ workspaceRoot: root, runDir: t.dir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s });
      return (cmd: string, o: { timeoutMs?: number } = {}) => sb.run(cmd, { timeoutMs: o.timeoutMs ?? 1000, maxOutputBytes: 1000, signal: new AbortController().signal });
    };
    const ev = await evaluateSwebenchLocal({ record, modelPatch: 'diff --git a/x b/x\n', evalDir: join(t.dir, 'eval', record.instance_id), cacheRoot: join(t.dir, 'cache'), makeRunner, log: () => undefined });
    expect(ev).toMatchObject({ pass: false, evaluator: 'local-venv', patchApplied: false });
    expect(applyCmds.map((c) => c.split(' ').slice(0, 3).join(' '))).toEqual(['git apply --verbose', 'git apply --verbose', 'git apply --verbose', 'patch --batch --forward']);
    expect(applyCmds[1]).toContain('--3way');
    expect(applyCmds[2]).toContain('--reject');
    // the environment was built through the sandbox: bare clone cache, shared clone, venv, pip
    const cmds = sandbox.commands.map((c) => c.command);
    expect(cmds.some((c) => c.includes('git clone --bare') && c.includes('https://github.com/pytest-dev/pytest.git'))).toBe(true);
    expect(cmds.some((c) => c.includes('git clone --shared'))).toBe(true);
    expect(cmds.some((c) => c.includes('python3 -m venv .venv'))).toBe(true);
    expect(cmds.some((c) => c.includes("pip install -q 'py==1.11.0'"))).toBe(true);
  });

  it('applyWithFallbacks stops at the first success', async () => {
    const seen: string[] = [];
    const run = async (cmd: string) => {
      seen.push(cmd);
      return seen.length === 2 ? okResult() : failResult();
    };
    const r = await applyWithFallbacks(run, '/p.diff', 1000);
    expect(r.applied).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it('empty patch never runs anything; environment failure is unevaluated (evaluator none)', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const sandbox = createFakeSandboxFactory((c) => (c.command.includes('git clone --bare') ? failResult('network down') : undefined));
    const makeRunner = (root: string) => {
      const sb = sandbox.create({ workspaceRoot: root, runDir: t.dir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s });
      return (cmd: string) => sb.run(cmd, { timeoutMs: 1000, maxOutputBytes: 1000, signal: new AbortController().signal });
    };
    const empty = await evaluateSwebenchLocal({ record, modelPatch: '   \n', evalDir: join(t.dir, 'e1'), cacheRoot: join(t.dir, 'cache'), makeRunner, log: () => undefined });
    expect(empty).toMatchObject({ pass: false, patchApplied: false, evaluator: 'local-venv' });
    expect(sandbox.commands).toHaveLength(0);
    const env = await evaluateSwebenchLocal({ record, modelPatch: 'diff --git a/x b/x\n', evalDir: join(t.dir, 'e2'), cacheRoot: join(t.dir, 'cache2'), makeRunner, log: () => undefined });
    expect(env).toMatchObject({ pass: null, evaluator: 'none' });
    expect(env.reason).toMatch(/environment build failed/);
  });

  it('grades a full run from the test script output, with prefix matching and exit code (report.json shape)', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const log = await readFile(join(process.cwd(), 'test', 'fixtures', 'bench', 'logs', 'pytest.txt'), 'utf8');
    let testCmd = '';
    const sandbox = createFakeSandboxFactory((c) => {
      if (c.command.includes('>>>>> Start Test Output')) {
        testCmd = c.command;
        return okResult({ ok: false, exitCode: 1, stdout: log });
      }
      return undefined;
    });
    const makeRunner = (root: string) => {
      const sb = sandbox.create({ workspaceRoot: root, runDir: t.dir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s });
      return (cmd: string) => sb.run(cmd, { timeoutMs: 1000, maxOutputBytes: 1000, signal: new AbortController().signal });
    };
    const ev = await evaluateSwebenchLocal({ record, modelPatch: 'diff --git a/x b/x\n', evalDir: join(t.dir, 'eval'), cacheRoot: join(t.dir, 'cache'), makeRunner, log: () => undefined });
    expect(testCmd).toContain('pytest -rA testing/test_setuponly.py');
    expect(testCmd).toContain('.venv/bin');
    expect(ev.pass).toBe(true);
    expect(ev.evaluator).toBe('local-venv');
    expect(ev.patchApplied).toBe(true);
    expect(ev.evalExitCode).toBe(1);
    expect(ev.testsStatus).toEqual({
      FAIL_TO_PASS: { success: ['testing/test_setuponly.py::test_show_only_active_fixtures[--setup-only]'], failure: [] },
      PASS_TO_PASS: { success: ['testing/test_setuponly.py::test_skipped_explicitly', 'testing/test_setuponly.py::test_param[a-b'], failure: [] },
    });
    expect(await readFile(join(t.dir, 'eval', 'test_output.txt'), 'utf8')).toBe(log);
  });

  it('timeout during tests -> invalid', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const sandbox = createFakeSandboxFactory((c) => (c.command.includes('>>>>> Start Test Output') ? okResult({ ok: false, exitCode: null, killedBy: 'timeout', timedOut: true }) : undefined));
    const makeRunner = (root: string) => {
      const sb = sandbox.create({ workspaceRoot: root, runDir: t.dir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s });
      return (cmd: string) => sb.run(cmd, { timeoutMs: 1000, maxOutputBytes: 1000, signal: new AbortController().signal });
    };
    const ev = await evaluateSwebenchLocal({ record, modelPatch: 'diff --git a/x b/x\n', evalDir: join(t.dir, 'eval'), cacheRoot: join(t.dir, 'cache'), makeRunner, log: () => undefined, testTimeoutMs: 5 });
    expect(ev).toMatchObject({ pass: null, evaluator: 'invalid' });
    expect(ev.reason).toMatch(/timed out/);
  });
});

describe('test wrapper script', () => {
  it('emits the Start/End markers and the exit code on its own lines when run without set -x', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const rec: SwebenchRecord = { ...record, eval_script: ": '>>>>> Start Test Output'\necho 'PASSED testing/a.py::test_x'; echo 'FAILED testing/a.py::test_y - boom'; false\n: '>>>>> End Test Output'\n" };
    const script = testScript(rec, t.dir)!;
    expect(script).toContain(`echo '${START_TEST_OUTPUT}'`);
    expect(script).toContain(`echo '${END_TEST_OUTPUT}'`);
    const res = await realExec({ root: t.dir, command: script, cwd: undefined, env: undefined }, { timeoutMs: 10_000, maxOutputBytes: 65536, signal: new AbortController().signal });
    const log = `${res.stdout}${res.stderr}`;
    expect(log).toContain(`${START_TEST_OUTPUT}\n`);
    expect(log).toContain(`${END_TEST_OUTPUT}\n>>>>> Test Exit Code: 1`);
    const ev = evaluateLog(log, parseLogPytest);
    expect(ev.valid).toBe(true);
    const g = gradeLog(log, parseLogPytest, { failToPass: ['testing/a.py::test_x'], passToPass: [] });
    expect(g.valid && g.resolved && g.exitCode === 1).toBe(true);
    // a passing run exits 0 and stays valid
    const ok = await realExec({ root: t.dir, command: testScript({ ...record, eval_script: ": '>>>>> Start Test Output'\necho 'PASSED testing/a.py::test_x'\n: '>>>>> End Test Output'\n" }, t.dir)!, cwd: undefined, env: undefined }, { timeoutMs: 10_000, maxOutputBytes: 65536, signal: new AbortController().signal });
    expect(evaluateLog(ok.stdout, parseLogPytest)).toMatchObject({ valid: true, exitCode: 0 });
  });
});
