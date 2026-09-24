/**
 * QuixBugs task loader (docs/JEV-ONLY.md rung 1, DESIGN.md §13). One task per program; the
 * workspace holds the buggy `<name>.py` (+ node.py for the graph programs), a `tests/` dir
 * with a generated or copied pytest module, pytest.ini/conftest.py and one git commit.
 * `toBenchTask(...).task` is the only text the engine sees: it names the function and the
 * file and never carries the bug line or the fix. The fix (index buggyLine/fixedLine, or the
 * correct program for the four insertions) is read only for mocked benches and reaches only
 * the mocked provider's trajectory.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MockTurn } from '../../core/types.js';
import { ConfigError } from '../../errors.js';
import { countOccurrences } from '../../workspace/edit.js';
import { MOCK_RUN_TIMEOUT_MS, MOCK_TEST_COMMAND, extractPatchFromRootCommit, initGitRepo, linkVenv, writePytestLayout } from '../ladder/pyworkspace.js';
import { resolveLadderPython } from '../ladder/venv.js';
import { unifiedDiff } from '../ladder/udiff.js';
import { mockTurn } from '../swebench/loader.js';
import type { BenchEvaluateContext, BenchSetupTools, BenchTask, BenchTaskMeta, BenchTaskSource, BuildTaskOptions } from '../types.js';
import { EVAL_TIMEOUT_MS, evaluateQuixbugs } from './evaluator.js';
import { casesFileName, generatePytestModule, testFileName } from './pytest.js';
import { NODE_FILE, QUIXBUGS_DIR, correctPath, fileExists, loadCases, loadIndex, moduleTestPath, programPath, usesNode, type QuixbugsCase, type QuixbugsRecord } from './tasks.js';

export type FixAction = { kind: 'edit'; path: string; old: string; new: string } | { kind: 'patch'; diff: string };

/** Everything read from bench/data/quixbugs for one program. */
export interface QuixbugsProgram {
  record: QuixbugsRecord;
  /** programs/<name>.py */
  buggy: string;
  /** programs/node.py when the program or its test module imports it */
  node: string | null;
  /** tests/<name>.json (verbatim text + parsed cases) or tests/<name>_test.py */
  tests: { kind: 'json'; text: string; cases: QuixbugsCase[] } | { kind: 'module'; text: string };
  /** mocked benches only */
  fix: FixAction | null;
}

export function taskText(record: QuixbugsRecord): string {
  const base = `The function \`${record.name}\` in \`${record.name}.py\` has a bug that makes some tests in tests/ fail. Fix it without changing the tests.`;
  return record.description === null ? base : `${base}\n\n${record.description}`;
}

const MAX_CONTEXT_LINES = 3;

/**
 * The mocked fix: an `edit` replacing the buggy line (widened with preceding lines until the
 * `old` text is unique in the file, as the engine's edit action demands), or a `patch` with the
 * unified diff programs → correct for the insertion fixes and whenever no unique edit exists.
 */
export function fixActionFor(record: QuixbugsRecord, buggy: string, correct: string): FixAction {
  const path = `${record.name}.py`;
  const patch = (): FixAction => {
    const diff = unifiedDiff(path, buggy, correct);
    if (diff === '') throw new ConfigError(`quixbugs ${record.name}: programs/ and correct/ are identical`);
    return { kind: 'patch', diff };
  };
  if (record.buggyLine === null) return patch();
  const lines = buggy.split('\n');
  let idx = record.bugLine - 1;
  if (lines[idx]?.trim() !== record.buggyLine) idx = lines.findIndex((l) => l.trim() === record.buggyLine);
  if (idx < 0) return patch();
  const line = lines[idx]!;
  const indent = /^\s*/.exec(line)![0];
  const fixed = `${indent}${record.fixedLine}`;
  if (fixed === line) return patch();
  let old = line;
  let next = fixed;
  for (let k = 1; countOccurrences(buggy, old) !== 1; k++) {
    if (k > MAX_CONTEXT_LINES || idx - k < 0) return patch();
    old = `${lines[idx - k]!}\n${old}`;
    next = `${lines[idx - k]!}\n${next}`;
  }
  return { kind: 'edit', path, old, new: next };
}

/** read the program and its tests → apply the fix → run the tests → done. */
export function fixTrajectory(name: string, testFile: string, fix: FixAction): MockTurn[] {
  const remaining = ['inspect the program and its tests', 'apply the fix', 'run the tests', 'report'];
  return [
    mockTurn('Inspect the program and its tests', { kind: 'read', paths: [`${name}.py`, `tests/${testFile}`] }, { done: [], remaining, openProblems: [] }),
    mockTurn(`Fix \`${name}\``, fix, { done: [remaining[0]!], remaining: remaining.slice(1), openProblems: [] }),
    mockTurn('Run the tests', { kind: 'run', command: MOCK_TEST_COMMAND, timeoutMs: MOCK_RUN_TIMEOUT_MS }, { done: remaining.slice(0, 2), remaining: remaining.slice(2), openProblems: [] }),
    mockTurn('The fix is applied and the tests were run', { kind: 'done', summary: `Fixed ${name} and ran the tests.` }, { done: remaining.slice(0, 3), remaining: [], openProblems: [] }),
  ];
}

export function testFileFor(program: QuixbugsProgram): string {
  return program.tests.kind === 'json' ? testFileName(program.record.name) : `${program.record.name}_test.py`;
}

export interface QuixbugsTaskOptions extends BuildTaskOptions {
  /** bench/data/quixbugs */
  quixbugsDir: string;
  program: QuixbugsProgram;
  evalTimeoutMs?: number;
  /**
   * The interpreter the AGENT's `python3 -m pytest` should resolve to, exposed as <workspace>/.venv
   * (ladder/pyworkspace.ts linkVenv): undefined = the shared <runsDir>/ladder-venv (built on first
   * use), a path = that venv's interpreter, null = leave the sandbox's python3 alone (offline unit
   * tests). The evaluator is unaffected: run_tests.py needs only the stdlib.
   */
  python?: string | null;
}

export function toBenchTask(opts: QuixbugsTaskOptions): BenchTask {
  const { program, quixbugsDir } = opts;
  const { record } = program;
  const name = record.name;
  const meta: BenchTaskMeta = { kind: record.kind, category: record.kind };

  async function setup(workspaceDir: string, tools: BenchSetupTools): Promise<void> {
    await mkdir(join(workspaceDir, 'tests'), { recursive: true });
    await writeFile(join(workspaceDir, `${name}.py`), program.buggy, 'utf8');
    if (program.node !== null) await writeFile(join(workspaceDir, NODE_FILE), program.node, 'utf8');
    if (program.tests.kind === 'json') {
      await writeFile(join(workspaceDir, 'tests', casesFileName(name)), program.tests.text, 'utf8');
      await writeFile(join(workspaceDir, 'tests', testFileName(name)), generatePytestModule(name, program.tests.cases), 'utf8');
    } else {
      await writeFile(join(workspaceDir, 'tests', `${name}_test.py`), program.tests.text, 'utf8');
    }
    await writePytestLayout(workspaceDir);
    await initGitRepo(tools.run, `quixbugs ${name}: buggy program and tests`);
    // The evaluator needs only the stdlib (run_tests.py), but the agent's detected test command is
    // pytest: expose the bench's shared venv as <workspace>/.venv (linkVenv) so `python3 -m pytest`
    // imports pytest inside the sandbox. A missing venv is logged, not fatal: the evaluator still runs.
    const python =
      opts.python !== undefined
        ? opts.python
        : await resolveLadderPython(tools.runsDir, tools.makeRunner, tools.run, tools.log).catch((e: unknown) => {
            tools.log(`[quixbugs ${name}] pytest venv not available at setup (${e instanceof Error ? e.message.slice(0, 200) : String(e)}); the agent's pytest may not import`);
            return null;
          });
    if (python !== null) await linkVenv(workspaceDir, python);
  }

  return {
    suite: 'quixbugs',
    id: name,
    task: taskText(record),
    meta,
    setup,
    extractPatch: (ctx: BenchEvaluateContext) => extractPatchFromRootCommit(ctx),
    // live and mocked alike: run_tests.py on the workspace program is the oracle
    evaluate: (ctx) => evaluateQuixbugs({ quixbugsDir, name, workspaceDir: ctx.workspaceDir, run: ctx.run, timeoutMs: opts.evalTimeoutMs ?? EVAL_TIMEOUT_MS }),
    mockTrajectory: () =>
      program.fix === null
        ? [mockTurn('No fix available; stop', { kind: 'done', summary: 'no fix available' }, { done: [], remaining: [], openProblems: ['no fix available'] })]
        : fixTrajectory(name, testFileFor(program), program.fix),
  };
}

export interface LoadQuixbugsOptions {
  mocked: boolean;
  evalTimeoutMs?: number;
  /** see QuixbugsTaskOptions.python */
  python?: string | null;
}

export async function loadProgram(quixbugsDir: string, record: QuixbugsRecord, mocked: boolean): Promise<QuixbugsProgram> {
  const name = record.name;
  const buggyFile = programPath(quixbugsDir, name);
  const buggy = await readFile(buggyFile, 'utf8').catch((e: unknown) => {
    throw new ConfigError(`quixbugs ${name}: cannot read ${buggyFile}`, { cause: e });
  });
  if (!new RegExp(`^def ${name}\\(`, 'm').test(buggy)) throw new ConfigError(`quixbugs ${name}: programs/${name}.py does not define ${name}`);
  let tests: QuixbugsProgram['tests'];
  if (record.hasJsonTests) {
    const text = await readFile(join(quixbugsDir, 'tests', casesFileName(name)), 'utf8');
    tests = { kind: 'json', text, cases: await loadCases(quixbugsDir, name) };
  } else {
    const p = moduleTestPath(quixbugsDir, name);
    if (!(await fileExists(p))) throw new ConfigError(`quixbugs ${name}: missing ${p}`);
    tests = { kind: 'module', text: await readFile(p, 'utf8') };
  }
  // the graph programs take Node objects built by their test module; either side may import node
  const node = usesNode(buggy) || (tests.kind === 'module' && usesNode(tests.text)) ? await readFile(join(quixbugsDir, 'programs', NODE_FILE), 'utf8') : null;
  let fix: FixAction | null = null;
  if (mocked) {
    const correct = await readFile(correctPath(quixbugsDir, name), 'utf8').catch((e: unknown) => {
      throw new ConfigError(`quixbugs ${name}: cannot read correct/${name}.py`, { cause: e });
    });
    fix = fixActionFor(record, buggy, correct);
  }
  return { record, buggy, node, tests, fix };
}

/** Sources for the runner, in index order; the fix is loaded only for mocked benches. */
export async function loadQuixbugsSources(dataDir: string, opts: LoadQuixbugsOptions): Promise<BenchTaskSource[]> {
  const quixbugsDir = join(dataDir, QUIXBUGS_DIR);
  const records = await loadIndex(quixbugsDir);
  if (!(await fileExists(join(quixbugsDir, 'run_tests.py')))) throw new ConfigError(`quixbugs: ${join(quixbugsDir, 'run_tests.py')} not found`);
  const out: BenchTaskSource[] = [];
  for (const record of records) out.push(sourceFor(quixbugsDir, await loadProgram(quixbugsDir, record, opts.mocked), opts.evalTimeoutMs, opts.python));
  return out;
}

export function sourceFor(quixbugsDir: string, program: QuixbugsProgram, evalTimeoutMs?: number, python?: string | null): BenchTaskSource {
  return {
    suite: 'quixbugs',
    id: program.record.name,
    meta: { kind: program.record.kind, category: program.record.kind },
    build(b) {
      const o: QuixbugsTaskOptions = { ...b, quixbugsDir, program };
      if (evalTimeoutMs !== undefined) o.evalTimeoutMs = evalTimeoutMs;
      if (python !== undefined) o.python = python;
      return toBenchTask(o);
    },
  };
}
