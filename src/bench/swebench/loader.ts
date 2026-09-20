/**
 * SWE-bench task loader (DESIGN.md §13). `toBenchTask(record, opts).task` is exactly the
 * problem_statement (CRLF normalised) and is the only text handed to the engine; hints,
 * FAIL_TO_PASS/PASS_TO_PASS, test_patch and the gold patch stay inside closures reached only
 * by the evaluator and the mocked provider.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toJson } from '../../core/json.js';
import type { Json, MockTurn } from '../../core/types.js';
import { ConfigError } from '../../errors.js';
import type { BenchEvaluateContext, BenchSetupTools, BenchTask, BenchTaskSource, BuildTaskOptions, Evaluation } from '../types.js';
import { SETUP_TIMEOUT_MS, buildEnvironment, cloneAt, ensureBareClone, evaluateSwebenchLocal, shellQuote, tail } from './evaluator.js';
import { extractModelPatch } from './predictions.js';
import { loadGold, loadRecords, touchedFiles, type GoldPatches, type SwebenchRecord } from './tasks.js';

export const SWEBENCH_DATA_FILE = 'swebench-verified-30.json';
export const SWEBENCH_GOLD_FILE = 'swebench-verified-30.gold.json';
export const BENCH_CACHE_DIR = 'bench-cache';
export const PROPOSE_TOOL = 'propose_action';
/** the mocked test run must never dominate a mocked bench */
const MOCK_RUN_TIMEOUT_MS = 60_000;

export interface SwebenchTaskOptions extends BuildTaskOptions {
  /** gold patch, mocked mode only */
  gold?: string;
  setupTimeoutMs?: number;
}

export function normaliseTaskText(problemStatement: string): string {
  return problemStatement.split('\r\n').join('\n');
}

/** A propose_action tool call as the real provider would return it. */
export function mockTurn(goal: string, action: Json, plan: { done: string[]; remaining: string[]; openProblems: string[] }): MockTurn {
  const input = toJson({ goal, action, plan });
  return { text: goal, toolCall: { name: PROPOSE_TOOL, input, rawJson: JSON.stringify(input) } };
}

/** read touched files → apply the gold diff → run the tests → done. */
export function goldTrajectory(gold: string, testCmd: string): MockTurn[] {
  const files = touchedFiles(gold);
  const remaining = ['inspect the files involved', 'apply the fix', 'run the tests', 'report'];
  return [
    mockTurn('Inspect the files the fix will touch', { kind: 'read', paths: files.length > 0 ? files.slice(0, 12) : ['README.md'] }, { done: [], remaining, openProblems: [] }),
    mockTurn('Apply the fix as a unified diff', { kind: 'patch', diff: gold }, { done: [remaining[0]!], remaining: remaining.slice(1), openProblems: [] }),
    mockTurn('Run the test suite', { kind: 'run', command: testCmd, timeoutMs: MOCK_RUN_TIMEOUT_MS }, { done: remaining.slice(0, 2), remaining: remaining.slice(2), openProblems: [] }),
    mockTurn('The fix is applied and tests were run', { kind: 'done', summary: 'Applied the fix and ran the tests.' }, { done: remaining.slice(0, 3), remaining: [], openProblems: [] }),
  ];
}

export function toBenchTask(record: SwebenchRecord, opts: SwebenchTaskOptions): BenchTask {
  const task = normaliseTaskText(record.problem_statement);
  const gold = opts.gold;
  const setupTimeoutMs = opts.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
  const testCmd = record.spec.test_cmd.trim() !== '' ? record.spec.test_cmd : 'pytest -q';

  async function setup(workspaceDir: string, tools: BenchSetupTools): Promise<void> {
    const cacheRoot = join(tools.runsDir, BENCH_CACHE_DIR);
    const cacheDir = await ensureBareClone(cacheRoot, record.repo, record.base_commit, tools.makeRunner, setupTimeoutMs);
    if (tools.mocked) {
      // mocked runs replay the gold patch; no interpreter is needed, only the tree at base_commit
      await cloneAt(tools.run, { cacheDir, commit: record.base_commit, timeoutMs: setupTimeoutMs });
      return;
    }
    await buildEnvironment(record, { dir: workspaceDir, cacheDir, run: tools.run, timeoutMs: setupTimeoutMs, log: tools.log });
  }

  async function evaluateMock(ctx: BenchEvaluateContext): Promise<Evaluation> {
    if (gold === undefined) return { pass: null, evaluator: 'mock', reason: 'no gold patch for mocked evaluation' };
    if (ctx.patch === null || ctx.patch.patchEmpty) return { pass: false, evaluator: 'mock', patchApplied: false, reason: 'empty model_patch' };
    // The gold diff is present iff it reverses cleanly; the file lives in the run dir, never the workspace.
    const evalDir = join(ctx.runDir, 'eval', record.instance_id);
    await mkdir(evalDir, { recursive: true });
    const goldFile = join(evalDir, 'gold.patch');
    await writeFile(goldFile, gold, 'utf8');
    const res = await ctx.run(`git apply --check -R ${shellQuote(goldFile)}`, { timeoutMs: 60_000, maxOutputBytes: 32 * 1024 });
    if (res.killedBy !== null) return { pass: null, evaluator: 'mock', reason: `gold check killed: ${res.killedBy}` };
    return res.ok ? { pass: true, evaluator: 'mock', patchApplied: true } : { pass: false, evaluator: 'mock', patchApplied: false, reason: `gold patch not applied: ${tail(res, 300)}` };
  }

  return {
    suite: 'swebench',
    id: record.instance_id,
    task,
    meta: { difficulty: record.difficulty, baseCommit: record.base_commit },
    setup,
    extractPatch: (ctx) => extractModelPatch(ctx.run, record.base_commit, ctx.runDir),
    async evaluate(ctx) {
      if (ctx.mocked) return evaluateMock(ctx);
      return evaluateSwebenchLocal({
        record,
        modelPatch: ctx.patch?.modelPatch ?? '',
        evalDir: join(ctx.runDir, 'eval', record.instance_id),
        cacheRoot: join(ctx.runsDir, BENCH_CACHE_DIR),
        makeRunner: ctx.makeRunner,
        log: ctx.log,
        setupTimeoutMs,
      });
    },
    mockTrajectory: () => (gold === undefined ? [mockTurn('No gold patch available; stop', { kind: 'done', summary: 'no gold patch' }, { done: [], remaining: [], openProblems: ['no gold patch'] })] : goldTrajectory(gold, testCmd)),
  };
}

export interface LoadSwebenchOptions {
  mocked: boolean;
  setupTimeoutMs?: number;
}

/** Sources for the runner: gold is loaded only for mocked benches. */
export async function loadSwebenchSources(dataDir: string, opts: LoadSwebenchOptions): Promise<BenchTaskSource[]> {
  const records = await loadRecords(join(dataDir, SWEBENCH_DATA_FILE));
  const gold: GoldPatches = opts.mocked ? await loadGold(join(dataDir, SWEBENCH_GOLD_FILE)) : {};
  if (opts.mocked) {
    const missing = records.filter((r) => !(r.instance_id in gold)).map((r) => r.instance_id);
    if (missing.length > 0) throw new ConfigError(`gold patches missing for ${missing.length} instance(s): ${missing.slice(0, 5).join(', ')}`);
  }
  return records.map((record) => sourceFor(record, opts.mocked ? gold[record.instance_id] : undefined, opts.setupTimeoutMs));
}

export function sourceFor(record: SwebenchRecord, gold: string | undefined, setupTimeoutMs?: number): BenchTaskSource {
  return {
    suite: 'swebench',
    id: record.instance_id,
    meta: { difficulty: record.difficulty, baseCommit: record.base_commit },
    build(b) {
      const o: SwebenchTaskOptions = { ...b };
      if (gold !== undefined) o.gold = gold;
      if (setupTimeoutMs !== undefined) o.setupTimeoutMs = setupTimeoutMs;
      return toBenchTask(record, o);
    },
  };
}
