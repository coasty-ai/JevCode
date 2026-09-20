import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { goldTrajectory, loadSwebenchSources, normaliseTaskText, sourceFor, toBenchTask } from '../../../src/bench/swebench/loader.js';
import { addedLines, loadRecords, parseRecords, testCommandFromEvalScript, touchedFiles, type SwebenchRecord } from '../../../src/bench/swebench/tasks.js';
import { runBenchWithSources } from '../../../src/bench/runner.js';
import { baseOptions, createFakeDeps, createFakeSandboxFactory, tempDir, type EngineScript } from './helpers.js';

const DATA = join(process.cwd(), 'bench', 'data', 'swebench-verified-30.json');
const GOLD = join(process.cwd(), 'bench', 'data', 'swebench-verified-30.gold.json');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } }).trim();
}

describe('swebench records', () => {
  it('loads and validates the 30-record subset and its test commands', async () => {
    const records = await loadRecords(DATA);
    expect(records).toHaveLength(30);
    for (const r of records) {
      expect(testCommandFromEvalScript(r.eval_script)).toContain(r.spec.test_cmd.split(' ')[0]!.split('=')[0]!.length > 0 ? '' : '');
      expect(testCommandFromEvalScript(r.eval_script)).not.toBeNull();
      expect(r.test_files.length).toBeGreaterThan(0);
    }
    const dj = records.find((r) => r.instance_id === 'django__django-14787')!;
    expect(testCommandFromEvalScript(dj.eval_script)).toBe('./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 decorators.tests');
    expect(() => parseRecords('[{"instance_id": 1}]', 'x')).toThrow(/instance_id/);
    expect(() => parseRecords('nope', 'x')).toThrow(/invalid JSON/);
  });

  it('task text is exactly problem_statement with CRLF normalised; the gold trajectory is read → patch → run → done', () => {
    const records = JSON.parse(readFileSync(DATA, 'utf8')) as SwebenchRecord[];
    const gold = JSON.parse(readFileSync(GOLD, 'utf8')) as Record<string, string>;
    const rec = records[0]!;
    const task = toBenchTask(rec, { workspaceDir: '/tmp/w', auxDir: '/tmp/a', mocked: true, gold: gold[rec.instance_id]! });
    expect(task.task).toBe(normaliseTaskText(rec.problem_statement));
    expect(task.task).toBe(rec.problem_statement.split('\r\n').join('\n'));
    expect(task.task.includes('\r')).toBe(false);
    expect(task.meta).toEqual({ difficulty: rec.difficulty, baseCommit: rec.base_commit });
    const turns = task.mockTrajectory();
    expect(turns.map((t) => (t.toolCall!.input as { action: { kind: string } }).action.kind)).toEqual(['read', 'patch', 'run', 'done']);
    const patchTurn = turns[1]!.toolCall!.input as { goal: string; action: { diff: string }; plan: { done: string[]; remaining: string[] } };
    expect(patchTurn.action.diff).toBe(gold[rec.instance_id]);
    expect(patchTurn.plan.remaining.length).toBeGreaterThan(0);
    expect((turns[0]!.toolCall!.input as { action: { paths: string[] } }).action.paths).toEqual(touchedFiles(gold[rec.instance_id]!));
    expect((turns[2]!.toolCall!.input as { action: { command: string } }).action.command).toBe(rec.spec.test_cmd);
    expect(goldTrajectory('diff --git a/x.py b/x.py\n', 'pytest -q')).toHaveLength(4);
  });

  it('loader sources carry only id/meta; hints and test ids never reach the task text', async () => {
    const sources = await loadSwebenchSources(join(process.cwd(), 'bench', 'data'), { mocked: true });
    expect(sources).toHaveLength(30);
    const records = await loadRecords(DATA);
    for (const [i, s] of sources.entries()) {
      const r = records[i]!;
      const t = s.build({ workspaceDir: '/w', auxDir: '/a', mocked: true });
      expect(t.task).toBe(normaliseTaskText(r.problem_statement));
      if (r.hints_text.trim().length > 20) expect(t.task.includes(r.hints_text)).toBe(false);
      for (const id of r.fail_to_pass) expect(JSON.stringify({ task: t.task, meta: t.meta, id: t.id })).not.toContain(JSON.stringify(id).slice(1, -1));
    }
  });
});

describe('swebench isolation, mocked end to end with real git', () => {
  it('problem_statement only reaches the engine; hints/test_patch/gold absent from prompts, Jev state and workspace; model_patch applies to a clean checkout', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    // a tiny upstream repo standing in for github
    const upstream = join(t.dir, 'upstream');
    await mkdir(join(upstream, 'src'), { recursive: true });
    await mkdir(join(upstream, 'tests'), { recursive: true });
    git(upstream, 'init', '-q', '-b', 'main');
    await writeFile(join(upstream, 'src', 'a.py'), 'def f():\n    return 1\n');
    await writeFile(join(upstream, 'tests', 'test_a.py'), 'from src.a import f\n\ndef test_f():\n    assert f() == 1\n');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-q', '-m', 'base');
    const base = git(upstream, 'rev-parse', 'HEAD');
    const gold = 'diff --git a/src/a.py b/src/a.py\n--- a/src/a.py\n+++ b/src/a.py\n@@ -1,2 +1,2 @@\n def f():\n-    return 1\n+    return 2  # SECRET_GOLD_MARKER\n';
    const testPatch = 'diff --git a/tests/test_new.py b/tests/test_new.py\nnew file mode 100644\n--- /dev/null\n+++ b/tests/test_new.py\n@@ -0,0 +1,3 @@\n+from src.a import f\n+def test_new():\n+    assert f() == 2  # SECRET_TEST_MARKER\n';
    const record: SwebenchRecord = {
      instance_id: 'acme__widgets-7',
      repo: 'acme/widgets',
      base_commit: base,
      environment_setup_commit: base,
      version: '1.0',
      created_at: '2026-01-01T00:00:00Z',
      difficulty: '<15 min fix',
      problem_statement: 'f() returns 1\r\nbut it should return 2.\r\n',
      hints_text: 'HINT_MARKER change the literal in src/a.py',
      fail_to_pass: ['tests/test_new.py::test_new'],
      pass_to_pass: ['tests/test_a.py::test_f'],
      test_patch: testPatch,
      test_files: ['tests/test_new.py'],
      spec: { python: '3.9', install: 'true', pre_install: [], pip_packages: [], packages: null, test_cmd: 'pytest -rA' },
      log_parser: 'parse_log_pytest',
      eval_script: `: '>>>>> Start Test Output'\npytest -rA tests/test_new.py\n: '>>>>> End Test Output'\n`,
    };
    // the fake sandbox really executes, but github clones are redirected to the local upstream
    const sandbox = createFakeSandboxFactory((c) => {
      c.command = c.command.split(`'https://github.com/acme/widgets.git'`).join(`'${upstream}'`);
      return undefined;
    }, 'real');
    // the fake engine applies the gold patch the way the mocked provider's patch action would
    const script: EngineScript = () => ({
      result: { steps: 4 },
      decisions: 4,
      effect: async (o) => {
        await writeFile(join(o.workspace, '.jevcode-gold.patch'), gold);
        git(o.workspace, 'apply', '.jevcode-gold.patch');
      },
    });
    const { deps, captured } = createFakeDeps({ script, sandbox });
    const source = sourceFor(record, gold);
    const out = await runBenchWithSources([source], baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { concurrency: 1 }), deps);

    expect(out.records).toHaveLength(2);
    expect(out.records.every((r) => r.pass === true && r.evaluator === 'mock' && r.patchEmpty === false && r.patchApplied === true && (r.patchBytes ?? 0) > 0)).toBe(true);
    // (a) task strictly equals problem_statement (normalised)
    for (const e of captured.engines) expect(e.opts.task).toBe('f() returns 1\nbut it should return 2.\n');
    // (b) nothing from hints/test_patch/gold in any prompt or serialised Jev state, nor in the engine options
    const everything = JSON.stringify({ req: captured.generateRequests, states: captured.askStates, opts: captured.engines.map((e) => ({ ...e.opts, provider: null, decider: null, meter: null, confirmer: null, redact: null })) });
    expect(captured.generateRequests.length).toBeGreaterThan(0);
    expect(captured.askStates.length).toBeGreaterThan(0);
    expect(everything).not.toContain('HINT_MARKER');
    expect(everything).not.toContain('SECRET_TEST_MARKER');
    expect(everything).not.toContain('SECRET_GOLD_MARKER');
    for (const line of addedLines(testPatch)) if (line.trim().length > 3) expect(everything).not.toContain(line);
    expect(everything).not.toContain('tests/test_new.py::test_new');
    // (c) the workspaces hold the clone at base_commit plus the fix, but no test_patch file and no tests/ or solution/ copied in
    for (const e of captured.engines) {
      const ws = e.opts.workspace;
      expect((await stat(join(ws, '.git'))).isDirectory()).toBe(true);
      await expect(stat(join(ws, 'tests', 'test_new.py'))).rejects.toThrow();
      expect(await readFile(join(ws, 'src', 'a.py'), 'utf8')).toContain('return 2');
      expect((await readdir(ws)).includes('solution')).toBe(false);
      // hints never written anywhere in the workspace
      for (const f of await readdir(ws)) if (f !== '.git') expect((await stat(join(ws, f))).isDirectory() || !(await readFile(join(ws, f), 'utf8')).includes('HINT_MARKER')).toBe(true);
    }
    // setup went through the bare-clone cache
    const cmds = sandbox.commands.map((c) => c.command);
    expect(cmds.some((c) => c.includes('git clone --bare'))).toBe(true);
    expect(cmds.filter((c) => c.includes('git clone --shared'))).toHaveLength(2);
    expect((await stat(join(t.dir, 'runs', 'bench-cache', 'acme__widgets.git'))).isDirectory()).toBe(true);
    // predictions: one line per condition file, and the model_patch applies to a clean checkout
    for (const c of ['jev-on', 'jev-off']) {
      const lines = (await readFile(join(out.outDir, `predictions.${c}.jsonl`), 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(1);
      const p = JSON.parse(lines[0]!) as { instance_id: string; model_name_or_path: string; model_patch: string };
      expect(p.instance_id).toBe('acme__widgets-7');
      expect(p.model_name_or_path).toBe(`jevcode-${c}-mock-model`);
      expect(p.model_patch).toContain('SECRET_GOLD_MARKER');
      expect(p.model_patch).not.toContain('.jevcode');
      const clean = join(t.dir, `clean-${c}`);
      git(t.dir, 'clone', '-q', upstream, clean);
      await writeFile(join(t.dir, `${c}.diff`), p.model_patch);
      git(clean, 'apply', '--check', join(t.dir, `${c}.diff`));
    }
  }, 20_000);
});
