/**
 * Ladder task loader (docs/JEV-ONLY.md rung 2, DESIGN.md §13). One task per tasks/<name>; the
 * workspace holds copies of src/ and tests/, pytest.ini (the task's own when present) and
 * conftest.py, in one git commit. `task` is task.md and nothing else; meta.json's description
 * and gold/ never enter the workspace. gold/ is read only for mocked benches, where the
 * trajectory applies the unified diff src → gold as a `patch` action.
 */
import { cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MockTurn } from '../../core/types.js';
import { ConfigError } from '../../errors.js';
import { mockTurn } from '../swebench/loader.js';
import type { BenchEvaluateContext, BenchSetupTools, BenchTask, BenchTaskMeta, BenchTaskSource, BuildTaskOptions, Evaluation } from '../types.js';
import { LADDER_EVAL_TIMEOUT_MS, evaluateLadder } from './evaluator.js';
import { MOCK_RUN_TIMEOUT_MS, MOCK_TEST_COMMAND, extractPatchFromRootCommit, initGitRepo, writePytestLayout } from './pyworkspace.js';
import { LADDER_DIR, goldPathFor, loadLadderRecords, type LadderRecord } from './tasks.js';
import { unifiedDiffFiles } from './udiff.js';
import { resolveLadderPython } from './venv.js';

export function metaFor(record: LadderRecord): BenchTaskMeta {
  return { difficulty: String(record.meta.difficulty), hunks: record.meta.hunks, kinds: [...record.meta.kinds] };
}

/** read the listed files → apply the gold diff → run the tests → done. */
export function goldTrajectory(files: readonly string[], diff: string): MockTurn[] {
  const remaining = ['inspect the modules and their tests', 'apply the fix', 'run the tests', 'report'];
  return [
    mockTurn('Inspect the modules and their tests', { kind: 'read', paths: [...files] }, { done: [], remaining, openProblems: [] }),
    mockTurn('Apply the fix as a unified diff', { kind: 'patch', diff }, { done: [remaining[0]!], remaining: remaining.slice(1), openProblems: [] }),
    mockTurn('Run the tests', { kind: 'run', command: MOCK_TEST_COMMAND, timeoutMs: MOCK_RUN_TIMEOUT_MS }, { done: remaining.slice(0, 2), remaining: remaining.slice(2), openProblems: [] }),
    mockTurn('The fix is applied and the tests were run', { kind: 'done', summary: 'Applied the fix and ran the tests.' }, { done: remaining.slice(0, 3), remaining: [], openProblems: [] }),
  ];
}

export interface LadderTaskOptions extends BuildTaskOptions {
  record: LadderRecord;
  /** src → gold unified diff, mocked benches only */
  goldDiff?: string;
  /** undefined = shared <runsDir>/ladder-venv (system python3 fallback); a path = that interpreter; null = `python3` */
  python?: string | null;
  evalTimeoutMs?: number;
}

export function toBenchTask(opts: LadderTaskOptions): BenchTask {
  const { record } = opts;
  const name = record.meta.name;

  async function setup(workspaceDir: string, tools: BenchSetupTools): Promise<void> {
    // The shared venv is built here, BEFORE the first command through the workspace sandbox:
    // every sandbox of a pair writes its seatbelt profile to the same <runDir>/sandbox.sb, so a
    // venv sandbox created later (e.g. inside evaluate) would clobber the workspace sandbox's
    // profile and pytest would run with the workspace unreadable. A failed build is only logged;
    // evaluate() falls back to the system python3 when it imports pytest.
    if (opts.python === undefined) {
      await resolveLadderPython(tools.runsDir, tools.makeRunner, tools.run, tools.log).catch((e: unknown) => {
        tools.log(`[ladder ${name}] pytest venv not available at setup (${e instanceof Error ? e.message.slice(0, 200) : String(e)}); evaluation will retry`);
      });
    }
    await cp(join(record.taskDir, 'src'), join(workspaceDir, 'src'), { recursive: true, force: true, dereference: false });
    await cp(join(record.taskDir, 'tests'), join(workspaceDir, 'tests'), { recursive: true, force: true, dereference: false });
    await writePytestLayout(workspaceDir, record.pytestIni !== null ? { pytestIni: record.pytestIni } : {});
    await initGitRepo(tools.run, `ladder ${name}: buggy modules and tests`);
  }

  async function evaluate(ctx: BenchEvaluateContext): Promise<Evaluation> {
    const python = opts.python === undefined ? await resolveLadderPython(ctx.runsDir, ctx.makeRunner, ctx.run, ctx.log) : (opts.python ?? 'python3');
    return evaluateLadder({ python, run: ctx.run, timeoutMs: opts.evalTimeoutMs ?? LADDER_EVAL_TIMEOUT_MS });
  }

  return {
    suite: 'ladder',
    id: name,
    task: record.task,
    meta: metaFor(record),
    setup,
    extractPatch: (ctx) => extractPatchFromRootCommit(ctx),
    evaluate,
    mockTrajectory: () =>
      opts.goldDiff === undefined
        ? [mockTurn('No gold fix available; stop', { kind: 'done', summary: 'no gold fix' }, { done: [], remaining: [], openProblems: ['no gold fix'] })]
        : goldTrajectory(record.meta.files, opts.goldDiff),
  };
}

/** The `patch` diff of the mocked trajectory: src/<module>.py → gold/<module>.py for every listed file. */
export async function goldDiffFor(record: LadderRecord): Promise<string> {
  const files: { path: string; oldText: string; newText: string }[] = [];
  for (const f of record.meta.files) {
    files.push({ path: f, oldText: await readFile(join(record.taskDir, f), 'utf8'), newText: await readFile(goldPathFor(record.taskDir, f), 'utf8') });
  }
  const diff = unifiedDiffFiles(files);
  if (diff === '') throw new ConfigError(`ladder task ${record.meta.name}: src/ and gold/ are identical for ${record.meta.files.join(', ')}`);
  return diff;
}

export interface LoadLadderOptions {
  mocked: boolean;
  /** see LadderTaskOptions.python */
  python?: string | null;
  evalTimeoutMs?: number;
}

export async function loadLadderSources(dataDir: string, opts: LoadLadderOptions): Promise<BenchTaskSource[]> {
  const records = await loadLadderRecords(join(dataDir, LADDER_DIR));
  const out: BenchTaskSource[] = [];
  for (const record of records) out.push(sourceFor(record, opts.mocked ? await goldDiffFor(record) : undefined, opts.python, opts.evalTimeoutMs));
  return out;
}

export function sourceFor(record: LadderRecord, goldDiff: string | undefined, python: string | null | undefined, evalTimeoutMs?: number): BenchTaskSource {
  return {
    suite: 'ladder',
    id: record.meta.name,
    meta: metaFor(record),
    build(b) {
      const o: LadderTaskOptions = { ...b, record };
      if (goldDiff !== undefined) o.goldDiff = goldDiff;
      if (python !== undefined) o.python = python;
      if (evalTimeoutMs !== undefined) o.evalTimeoutMs = evalTimeoutMs;
      return toBenchTask(o);
    },
  };
}
