/**
 * Bench runner (DESIGN.md §13): task units (every condition of one task) under bounded
 * concurrency, one root SpendMeter with a child per run, cap handling (abort siblings, not_run
 * records), per-task records copied from RunResult, tasks.jsonl / summary.json / comparison.md
 * / predictions files, and --resume from tasks.jsonl. Everything external arrives via BenchDeps.
 */
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import { isFiniteNumber, isJsonObject, isString, parseJson, toJson } from '../core/json.js';
import { percentile } from '../core/time.js';
import type { ActionOutcome, BenchSuite, BenchTaskRecord, Decider, Engine, EngineMode, Provider, RunResult, Sandbox, SandboxRunOptions, SpendMeter, Synthesizer } from '../core/types.js';
import { ConfigError, toJevCodeError } from '../errors.js';
import { createNullProvider } from '../provider/null.js';
import { CONDITION_ORDER, NULL_GENERATOR_MODEL, buildEngineOptions, conditionConfig, createEngineFor, isEngineMode, requiresGenerator } from './conditions.js';
import { computeSuiteMetrics, isNotRun, suitesIn, withPairComplete } from './metrics.js';
import { renderComparison } from './report.js';
import { loadLadderSources } from './ladder/loader.js';
import { LADDER_VENV_DIR } from './ladder/venv.js';
import { loadQuixbugsSources } from './quixbugs/loader.js';
import { BENCH_CACHE_DIR, loadSwebenchSources } from './swebench/loader.js';
import { modelNameOrPath, readSavedModelPatch, writePredictions, type PredictionEntry } from './swebench/predictions.js';
import { loadTerminalBenchSources } from './terminalbench/loader.js';
import { TB_VENV_DIR } from './terminalbench/shim.js';
import type { BenchDepsWithSynth, BenchOptions, BenchRecord, BenchRunOutput, BenchSetupTools, BenchTask, BenchTaskSource, CommandRunner, Evaluation, PatchExtraction, Summary, SuiteMetrics } from './types.js';

export const TASKS_FILE = 'tasks.jsonl';
export const SUMMARY_FILE = 'summary.json';
export const COMPARISON_FILE = 'comparison.md';
export const BENCH_WORK_DIR = 'bench-work';
/** marker line written when an engine starts, superseded by the final record (bench --resume uses its runId) */
export const IN_PROGRESS = 'in_progress';
export const NOT_RUN_BENCH_CAP = 'bench_spend_cap';
export const NOT_RUN_ABORTED = 'bench_aborted';
/** reason of a jev-only record whose RunResult shows generator usage (docs/JEV-ONLY.md non-negotiable) */
export const JEV_ONLY_GENERATOR_CALLED = 'generator called in jev-only';
const DEFAULT_SETUP_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;

export function newBenchId(now: Date, random: () => Buffer = () => randomBytes(3)): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}-${random().toString('hex').slice(0, 6)}`;
}

export const BENCH_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

export function validateOptions(opts: BenchOptions, deps: BenchDepsWithSynth): void {
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) throw new ConfigError('--concurrency must be a positive integer', { setting: 'concurrency' });
  if (opts.conditions.length === 0) throw new ConfigError('--conditions: at least one condition is required', { setting: 'conditions' });
  if (new Set(opts.conditions).size !== opts.conditions.length) throw new ConfigError('--conditions: duplicate condition', { setting: 'conditions' });
  if (!Number.isFinite(opts.spendCapUsd) || opts.spendCapUsd < 0) throw new ConfigError('--spend-cap must be a non-negative number', { setting: 'spend-cap' });
  if (!Number.isFinite(opts.taskSpendCapUsd) || opts.taskSpendCapUsd <= 0) throw new ConfigError('--task-spend-cap must be positive', { setting: 'task-spend-cap' });
  if (opts.live) {
    if (opts.spendCapUsd <= 0) throw new ConfigError('--live requires --spend-cap <usd> (bench total)', { setting: 'spend-cap' });
    // jev-only alone needs only the decider; jev-on/jev-off need the generator too
    if (requiresGenerator(opts.conditions) && !deps.liveProvider) throw new ConfigError('--live requires a live provider for jev-on/jev-off and a live decider', { setting: 'live' });
    if (!deps.liveDecider) throw new ConfigError('--live requires a live decider', { setting: 'live' });
  }
  if ((opts.conditions.includes('jev-only') || opts.conditions.includes('llm-jev')) && !deps.createSynthesizer) throw new ConfigError('condition jev-only requires a synthesizer (BenchDeps.createSynthesizer)', { setting: 'conditions' });
  if (opts.tasks !== undefined && opts.tasks !== null && (!Number.isInteger(opts.tasks) || opts.tasks < 1)) throw new ConfigError('--tasks must be a positive integer', { setting: 'tasks' });
  if (opts.resumeBenchId !== undefined && opts.resumeBenchId !== null && !BENCH_ID_RE.test(opts.resumeBenchId)) throw new ConfigError(`--resume: "${opts.resumeBenchId}" is not a bench id`, { setting: 'resume' });
}

export function selectSources(sources: readonly BenchTaskSource[], opts: Pick<BenchOptions, 'tasks' | 'taskIds'>): BenchTaskSource[] {
  if (opts.taskIds && opts.taskIds.length > 0) {
    const out: BenchTaskSource[] = [];
    for (const id of opts.taskIds) {
      const s = sources.find((x) => x.id === id);
      if (!s) throw new ConfigError(`--task-id: unknown task "${id}"`, { setting: 'task-id' });
      if (!out.includes(s)) out.push(s);
    }
    return out;
  }
  if (opts.tasks !== undefined && opts.tasks !== null) {
    const n = opts.tasks;
    const perSuite = new Map<BenchSuite, number>();
    return sources.filter((s) => {
      const seen = perSuite.get(s.suite) ?? 0;
      perSuite.set(s.suite, seen + 1);
      return seen < n;
    });
  }
  return [...sources];
}

export async function loadSources(opts: BenchOptions): Promise<BenchTaskSource[]> {
  const dataDir = opts.dataDir ?? join(process.cwd(), 'bench', 'data');
  const mocked = !opts.live;
  const out: BenchTaskSource[] = [];
  if (opts.suite === 'swebench' || opts.suite === 'all') {
    const o: { mocked: boolean; setupTimeoutMs?: number } = { mocked };
    if (opts.setupTimeoutMs !== undefined) o.setupTimeoutMs = opts.setupTimeoutMs;
    out.push(...(await loadSwebenchSources(dataDir, o)));
  }
  if (opts.suite === 'terminal-bench' || opts.suite === 'all') out.push(...(await loadTerminalBenchSources(dataDir, { mocked })));
  // the jev-only difficulty ladder (docs/JEV-ONLY.md): QuixBugs one-line bugs, then the hand-made multi-hunk tasks
  if (opts.suite === 'quixbugs' || opts.suite === 'all') out.push(...(await loadQuixbugsSources(dataDir, { mocked })));
  if (opts.suite === 'ladder' || opts.suite === 'all') out.push(...(await loadLadderSources(dataDir, { mocked })));
  return out;
}

// ---------------------------------------------------------------------------------------
// tasks.jsonl
// ---------------------------------------------------------------------------------------

const NUMERIC_FIELDS = ['steps', 'wallMs', 'jevRequests', 'jevQuestions', 'blocked', 'reviews', 'declined', 'loops', 'replans', 'reads'] as const;
const BENCH_SUITES: readonly string[] = ['swebench', 'terminal-bench', 'quixbugs', 'ladder'] satisfies readonly BenchSuite[];

/** Shape check for a tasks.jsonl line: everything --resume, the metrics and the report dereference. */
function isRecord(v: unknown): v is BenchTaskRecord {
  if (!isJsonObject(v)) return false;
  const pass = v['pass'];
  if (!(isString(v['suite']) && isString(v['task']) && isString(v['condition']) && (pass === null || typeof pass === 'boolean') && isString(v['stopReason']) && isString(v['evaluator']))) return false;
  if (!BENCH_SUITES.includes(v['suite'])) return false;
  const condition = v['condition'];
  if (!isString(condition) || !isEngineMode(condition)) return false;
  if (!NUMERIC_FIELDS.every((k) => isFiniteNumber(v[k]))) return false;
  const cost = v['cost'];
  if (!isJsonObject(cost) || !isFiniteNumber(cost['generator']) || !isFiniteNumber(cost['jev'])) return false;
  const lat = v['jevLatencyMs'];
  if (!isJsonObject(lat) || !Array.isArray(lat['raw']) || !lat['raw'].every(isFiniteNumber)) return false;
  const timing = v['timing'];
  if (!isJsonObject(timing) || !['generatorMs', 'jevMs', 'execMs', 'harnessMs'].every((k) => isFiniteNumber(timing[k]))) return false;
  const tps = v['tokensPerStep'];
  if (!Array.isArray(tps) || !tps.every(isFiniteNumber)) return false;
  // the per-source split is absent in tasks.jsonl written before it existed (filled with zeros on read)
  for (const k of ['generatorTokensPerStep', 'jevTokensPerStep'] as const) {
    const s = v[k];
    if (s !== undefined && (!Array.isArray(s) || !s.every(isFiniteNumber))) return false;
  }
  if (typeof v['modelDrift'] !== 'boolean') return false;
  const runId = v['runId'];
  return runId === null || isString(runId);
}

/** Every well-formed line; a torn last line (crash mid-append) is skipped, not fatal. */
export async function readTasksJsonl(path: string, log: (l: string) => void = () => undefined): Promise<BenchTaskRecord[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: BenchTaskRecord[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    const parsed = parseJson(line);
    if (!parsed.ok || !isRecord(parsed.value)) {
      log(`[bench] ${path}:${i + 1}: skipping malformed record`);
      continue;
    }
    out.push(withTokenSeries(parsed.value));
  }
  return out;
}

/** Older records carry only the combined series: the split reads as zeros of the same length. */
function withTokenSeries(r: BenchTaskRecord): BenchTaskRecord {
  const zeros = (s: number[] | undefined): number[] => (Array.isArray(s) ? s : r.tokensPerStep.map(() => 0));
  return { ...r, generatorTokensPerStep: zeros(r.generatorTokensPerStep), jevTokensPerStep: zeros(r.jevTokensPerStep) };
}

function pairKey(r: { suite: string; task: string; condition: string }): string {
  return `${r.suite}\u0000${r.task}\u0000${r.condition}`;
}

/** Last record per (suite, task, condition) wins. */
export function latestRecords(records: readonly BenchTaskRecord[]): Map<string, BenchTaskRecord> {
  const m = new Map<string, BenchTaskRecord>();
  for (const r of records) m.set(pairKey(r), r);
  return m;
}

// ---------------------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------------------

export interface RecordInput {
  source: BenchTaskSource;
  condition: EngineMode;
  result: RunResult;
  evaluation: Evaluation;
  patch: PatchExtraction | null;
  capFired: 'bench' | 'task' | null;
  /** cap-aborted siblings record spend_cap even when the engine reported the abort */
  stopReasonOverride?: 'spend_cap';
}

/**
 * Copy every RunResult field into the record shape of §13; pass/evaluator/patch fields come from
 * the evaluation. `generatorCalls` is copied for every condition; a jev-only record with any
 * generator usage (calls, tokens or cost) is invalidated rather than scored (docs/JEV-ONLY.md).
 */
/**
 * JSON for one tasks.jsonl line with every string leaf redacted (jev-only-audit.md §5: the bench
 * writer had no redaction pass of its own; `reason` carries `tail()` of evaluator subprocess output
 * and raw error messages). Keys are left alone, like the checkpoint store's redactDeep.
 */
export function serialiseRedacted(record: BenchRecord, redact: (s: string) => string): string {
  return JSON.stringify(record, (_key: string, value: unknown): unknown => (typeof value === 'string' ? redact(value) : value));
}

export function buildRecord(input: RecordInput): BenchRecord {
  const { result, evaluation } = input;
  const raw = [...result.jevLatencyMs];
  const rec: BenchRecord = {
    suite: input.source.suite,
    task: input.source.id,
    condition: input.condition,
    pass: evaluation.pass,
    evaluator: evaluation.evaluator,
    steps: result.steps,
    wallMs: result.wallMs,
    tokensPerStep: [...result.tokensPerStep],
    generatorTokensPerStep: [...result.generatorTokensPerStep],
    jevTokensPerStep: [...result.jevTokensPerStep],
    cost: { generator: result.usage.generator.costUsd, jev: result.usage.jev.costUsd },
    jevLatencyMs: { raw, p50: percentile(raw, 50), p95: percentile(raw, 95) },
    jevRequests: result.usage.jev.calls,
    jevQuestions: result.jevQuestions,
    timing: { generatorMs: result.timing.generatorMs, jevMs: result.timing.jevMs, execMs: result.timing.execMs, harnessMs: result.timing.harnessMs },
    stopReason: input.stopReasonOverride ?? result.stopReason,
    // §13: blocked = risk 'block' steps + declined steps (every review is declined in bench runs)
    blocked: result.counters.blocked + result.counters.declined,
    reviews: result.counters.reviews,
    declined: result.counters.declined,
    loops: result.counters.loops,
    replans: result.counters.replans,
    reads: result.counters.reads,
    modelDrift: result.jevModelDrift !== null,
    pairComplete: false,
    patchEmpty: input.patch ? input.patch.patchEmpty : null,
    patchApplied: evaluation.patchApplied ?? null,
    patchBytes: input.patch ? input.patch.patchBytes : null,
    runId: result.runId,
    capFired: input.capFired,
    generatorCalls: result.usage.generator.calls,
  };
  if (Object.keys(input.source.meta).length > 0) rec.meta = { ...input.source.meta };
  if (evaluation.reason !== undefined) rec.reason = evaluation.reason;
  else if (result.error) rec.reason = `${result.error.code}: ${result.error.message}`;
  if (evaluation.testsStatus) rec.testsStatus = evaluation.testsStatus;
  if (evaluation.evalExitCode !== undefined) rec.evalExitCode = evaluation.evalExitCode;
  const g = result.usage.generator;
  if (input.condition === 'jev-only' && (g.calls > 0 || g.costUsd > 0 || g.inputTokens + g.outputTokens > 0)) {
    rec.pass = null;
    rec.evaluator = 'invalid';
    rec.reason = JEV_ONLY_GENERATOR_CALLED;
  }
  return rec;
}

export function notRunRecord(source: BenchTaskSource, condition: EngineMode, reason: string, runId: string | null = null): BenchRecord {
  return {
    ...(Object.keys(source.meta).length > 0 ? { meta: { ...source.meta } } : {}),
    suite: source.suite,
    task: source.id,
    condition,
    pass: null,
    evaluator: 'none',
    reason,
    steps: 0,
    wallMs: 0,
    tokensPerStep: [],
    generatorTokensPerStep: [],
    jevTokensPerStep: [],
    cost: { generator: 0, jev: 0 },
    jevLatencyMs: { raw: [], p50: null, p95: null },
    jevRequests: 0,
    jevQuestions: 0,
    timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0 },
    stopReason: 'not_run',
    blocked: 0,
    reviews: 0,
    declined: 0,
    loops: 0,
    replans: 0,
    reads: 0,
    modelDrift: false,
    pairComplete: false,
    patchEmpty: null,
    patchApplied: null,
    patchBytes: null,
    runId,
    capFired: reason === NOT_RUN_BENCH_CAP ? 'bench' : null,
  };
}

/** A run whose engine never produced a RunResult (setup or createEngine failure). */
export function errorRecord(source: BenchTaskSource, condition: EngineMode, reason: string, runId: string | null = null): BenchRecord {
  return { ...notRunRecord(source, condition, reason, runId), stopReason: 'error', capFired: null };
}

// ---------------------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------------------

type PairMode = { kind: 'skip'; record: BenchTaskRecord } | { kind: 'fresh' } | { kind: 'resume'; runId: string };

interface PairPlan {
  source: BenchTaskSource;
  condition: EngineMode;
  mode: PairMode;
}

export function planPair(existing: BenchTaskRecord | undefined): PairMode {
  if (!existing) return { kind: 'fresh' };
  if (isNotRun(existing)) {
    if (existing.reason === IN_PROGRESS && existing.runId) return { kind: 'resume', runId: existing.runId };
    return { kind: 'fresh' };
  }
  // A setup failure (no engine run: zero steps, no evaluator, stopReason error) is infrastructure,
  // not a verdict: re-run it, so a fixed evaluator or a restored network completes the pair.
  if (existing.pass === null && existing.evaluator === 'none' && existing.steps === 0 && existing.stopReason === 'error') return { kind: 'fresh' };
  // finished records (pass true/false, or a terminal null verdict such as invalid/none/error) are kept
  return { kind: 'skip', record: existing };
}

function orderConditions(conds: readonly EngineMode[]): EngineMode[] {
  return [...conds].sort((a, b) => CONDITION_ORDER.indexOf(a) - CONDITION_ORDER.indexOf(b));
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function runBench(opts: BenchOptions, deps: BenchDepsWithSynth): Promise<BenchRunOutput> {
  validateOptions(opts, deps);
  const sources = selectSources(await loadSources(opts), opts);
  if (sources.length === 0) throw new ConfigError('no bench tasks selected');
  return runBenchWithSources(sources, opts, deps);
}

export async function runBenchWithSources(sources: readonly BenchTaskSource[], opts: BenchOptions, deps: BenchDepsWithSynth): Promise<BenchRunOutput> {
  validateOptions(opts, deps);
  const log = opts.log ?? ((): void => undefined);
  const now = opts.now ?? ((): Date => new Date());
  const mocked = !opts.live;
  const conditions = orderConditions(opts.conditions);
  const benchId = opts.resumeBenchId ?? newBenchId(now());
  const outDir = resolve(opts.outDir ?? join(process.cwd(), 'bench', 'results', benchId));
  await mkdir(outDir, { recursive: true });
  const tasksPath = join(outDir, TASKS_FILE);
  const createdAt = now().toISOString();

  // --resume: previous records seed the meter and decide which pairs still run
  const resumeId = opts.resumeBenchId ?? null;
  const previous = resumeId !== null ? await readTasksJsonl(tasksPath, log) : [];
  if (resumeId !== null && previous.length === 0 && !(await exists(tasksPath))) {
    throw new ConfigError(`--resume ${resumeId}: ${tasksPath} not found`, { setting: 'resume' });
  }
  const latest = latestRecords(previous);
  const root = deps.createSpendMeter(opts.spendCapUsd);
  if (previous.length > 0) {
    let gen = 0;
    let jev = 0;
    for (const r of latest.values()) {
      gen += r.cost.generator;
      jev += r.cost.jev;
    }
    root.restore({
      generator: { inputTokens: 0, outputTokens: 0, costUsd: gen, calls: 0 },
      jev: { inputTokens: 0, outputTokens: 0, costUsd: jev, calls: 0 },
      totalUsd: gen + jev,
      capUsd: opts.spendCapUsd,
      exceeded: gen + jev >= opts.spendCapUsd && opts.spendCapUsd > 0,
    });
  }

  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort(opts.signal?.reason ?? new Error('bench aborted'));
  if (opts.signal?.aborted) onExternalAbort();
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const active = new Set<Engine>();
  const capAborted = new Set<Engine>();
  let benchCapFired = false;
  const checkCap = (): void => {
    if (benchCapFired || !root.exceeded()) return;
    benchCapFired = true;
    log(`[bench] bench spend cap ${opts.spendCapUsd} USD reached; aborting ${active.size} running engine(s)`);
    for (const e of active) {
      capAborted.add(e);
      e.abort('human_abort');
    }
  };
  controller.signal.addEventListener('abort', () => {
    for (const e of active) e.abort('signal');
  });

  // append per record as it completes (crash safety); consolidated and rewritten at the end.
  // Every string leaf passes opts.redact first (`reason` carries evaluator output tails and error messages).
  const serialiseRecord = (r: BenchRecord): string => serialiseRedacted(r, opts.redact);
  let appendChain: Promise<void> = Promise.resolve();
  const newRecords: BenchRecord[] = [];
  const appendRecord = (r: BenchRecord): Promise<void> => {
    appendChain = appendChain.then(() => appendFile(tasksPath, `${serialiseRecord(r)}\n`, 'utf8'));
    return appendChain;
  };
  const modelPatches = new Map<string, string>();
  let generatorModel: string | null = deps.liveProvider?.model ?? null;

  /**
   * Runners for one pair. A runner asked for the agent workspace is rooted at the pair dir
   * (workspace + aux) with cwd = workspace, so setup can stage aux/ and collect hooks can write
   * there; `sandboxRunDir` is the sandbox's second writable root (pairDir/sandbox during setup,
   * the engine's run dir afterwards, where model_patch.diff and eval/ live). Any other root
   * (bare-clone cache, verifier venv, eval dir) is used as given.
   */
  const makeRunnerFactory = (pair: { pairDir: string; workspaceDir: string }, sandboxRunDir: string, signal: AbortSignal) => {
    const sandboxes = new Map<string, Promise<Sandbox>>();
    const get = (root: string): Promise<Sandbox> => {
      let p = sandboxes.get(root);
      if (!p) {
        p = (async () => {
          await mkdir(root, { recursive: true });
          await mkdir(sandboxRunDir, { recursive: true });
          // bench infrastructure (clone, pip) needs the network regardless of the agent's --no-network
          return deps.createSandbox({
            workspaceRoot: root,
            runDir: sandboxRunDir,
            profile: opts.sandboxProfile,
            noNetwork: false,
            secretReadDenies: opts.secretPaths,
            redact: opts.redact,
            // setup and evaluation clone from the bare cache and run the verifier venv; both live under the read-denied jevcode home
            extraReadable: [join(opts.runsDir, BENCH_CACHE_DIR), join(opts.runsDir, TB_VENV_DIR), join(opts.runsDir, LADDER_VENV_DIR)],
            // these sandboxes run only bench infrastructure (clone, venv, pip, verifier), which must create .git/hooks itself
            protectGit: false,
          });
        })();
        sandboxes.set(root, p);
      }
      return p;
    };
    return (workspaceRoot: string): CommandRunner => {
      const inWorkspace = workspaceRoot === pair.workspaceDir;
      const root = inWorkspace ? pair.pairDir : workspaceRoot;
      return async (command, o = {}) => {
        const sandbox = await get(root);
        const run: SandboxRunOptions = {
          timeoutMs: o.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          maxOutputBytes: o.maxOutputBytes ?? 200 * 1024,
          signal,
        };
        const cwd = o.cwd ?? (inWorkspace ? pair.workspaceDir : undefined);
        if (cwd !== undefined) run.cwd = cwd;
        if (o.env !== undefined) run.env = o.env;
        if (o.onOutput !== undefined) run.onOutput = o.onOutput;
        return sandbox.run(command, run);
      };
    };
  };

  async function runPair(plan: PairPlan): Promise<void> {
    const { source, condition } = plan;
    const pairDir = join(opts.runsDir, BENCH_WORK_DIR, benchId, safeName(source.id), condition);
    const workspaceDir = join(pairDir, 'workspace');
    const auxDir = join(pairDir, 'aux');
    const pair = { pairDir, workspaceDir };
    const task: BenchTask = source.build({ workspaceDir, auxDir, mocked });
    let resumeRunId: string | null = plan.mode.kind === 'resume' ? plan.mode.runId : null;
    if (resumeRunId !== null && !((await exists(workspaceDir)) && (await exists(join(opts.runsDir, resumeRunId))))) {
      log(`[bench] ${source.id}/${condition}: run ${resumeRunId} has no workspace or run dir; starting fresh`);
      resumeRunId = null;
    }
    if (resumeRunId === null) {
      await rm(pairDir, { recursive: true, force: true });
      await mkdir(workspaceDir, { recursive: true });
      await mkdir(auxDir, { recursive: true });
      const setupAbort = new AbortController();
      const linkAbort = (): void => setupAbort.abort(controller.signal.reason);
      if (controller.signal.aborted) linkAbort();
      controller.signal.addEventListener('abort', linkAbort, { once: true });
      const makeSetupRunner = makeRunnerFactory(pair, join(pairDir, 'sandbox'), setupAbort.signal);
      const tools: BenchSetupTools = { run: makeSetupRunner(workspaceDir), makeRunner: makeSetupRunner, mocked, runsDir: opts.runsDir, signal: setupAbort.signal, log };
      try {
        log(`[bench] ${source.id}/${condition}: setup`);
        const timeoutMs = opts.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
        await withTimeout(task.setup(workspaceDir, tools), timeoutMs, 'setup', () => setupAbort.abort(new Error(`setup exceeded ${timeoutMs} ms`)));
      } catch (e) {
        const msg = toJevCodeError(e).message;
        log(`[bench] ${source.id}/${condition}: setup failed: ${msg}`);
        const rec = errorRecord(source, condition, `setup_failed: ${msg}`);
        newRecords.push(rec);
        await appendRecord(rec);
        return;
      } finally {
        controller.signal.removeEventListener('abort', linkAbort);
      }
    }

    const jevOnly = condition === 'jev-only';
    // llm-jev (docs/LLM-JEV-DESIGN.md): the real (or mock) generator like jev-on AND the synthesizer like jev-only
    const withSynth = jevOnly || condition === 'llm-jev';
    const mockProvider = (): Provider => {
      const trajectory = task.mockTrajectory();
      // a function so an engine that asks again after the final `done` keeps receiving `done` instead of exhausting the script
      return deps.createMockProvider({ turns: (_req, i) => trajectory[Math.min(i, trajectory.length - 1)]! });
    };
    // jev-only: the generator slot is the NullProvider (throws if called; buildRecord invalidates the record on any generator usage)
    const provider: Provider = jevOnly ? createNullProvider() : mocked ? mockProvider() : deps.liveProvider!;
    const decider: Decider = mocked ? deps.createMockDecider() : deps.liveDecider!;
    if (!jevOnly) generatorModel ??= provider.model;
    const synthesizer: Synthesizer | undefined = withSynth ? deps.createSynthesizer?.({ decider, redact: opts.redact }) : undefined;
    if (withSynth && synthesizer === undefined) {
      const rec = errorRecord(source, condition, `engine_create_failed: condition ${condition} requires a synthesizer`);
      newRecords.push(rec);
      await appendRecord(rec);
      return;
    }
    const meter: SpendMeter = root.child(opts.taskSpendCapUsd);
    const engineOpts = buildEngineOptions(
      {
        mode: condition,
        task: task.task,
        workspace: workspaceDir,
        provider,
        decider,
        meter,
        ...(synthesizer ? { synthesizer } : {}),
        ...(resumeRunId !== null ? { resume: { runId: resumeRunId, force: false } } : {}),
        // §13: the shimmed instruction points at aux/output, aux/results, aux/logs; the sandbox must let the agent write there
        ...(source.suite === 'terminal-bench' ? { extraWritableRoots: [auxDir] } : {}),
        // the agent workspace is a `git clone --shared` of the bare cache: its objects live there (read-only for the agent)
        ...(source.suite === 'swebench' ? { extraReadableRoots: [join(opts.runsDir, BENCH_CACHE_DIR)] } : {}),
        // the agent's `python3 -m pytest` runs the shared venv linked at <workspace>/.venv (ladder/pyworkspace.ts linkVenv);
        // the venv lives beside the runs under the read-denied jevcode home, so it must be re-allowed for the agent's sandbox
        ...(source.suite === 'ladder' || source.suite === 'quixbugs' ? { extraReadableRoots: [join(opts.runsDir, LADDER_VENV_DIR)] } : {}),
      },
      opts,
    );
    let engine: Engine;
    try {
      engine = await createEngineFor(condition, engineOpts, deps);
    } catch (e) {
      const msg = toJevCodeError(e).message;
      const rec = errorRecord(source, condition, `engine_create_failed: ${msg}`, resumeRunId);
      newRecords.push(rec);
      await appendRecord(rec);
      return;
    }
    await appendRecord(notRunRecord(source, condition, IN_PROGRESS, engine.runId));
    const outcomes: ActionOutcome[] = [];
    engine.events.on('outcome', (e) => {
      if (outcomes.length < 10_000) outcomes.push(e.outcome);
    });
    engine.events.on('status', checkCap);
    active.add(engine);
    if (benchCapFired) {
      capAborted.add(engine);
      engine.abort('human_abort');
    }
    log(`[bench] ${source.id}/${condition}: run ${engine.runId} (${resumeRunId ? 'resumed' : 'fresh'})`);
    const result = await engine.run();
    active.delete(engine);
    checkCap();

    const runDir = join(opts.runsDir, result.runId);
    const makeRunner = makeRunnerFactory(pair, runDir, controller.signal);
    const ctxBase = { workspaceDir, runDir, runsDir: opts.runsDir, run: makeRunner(workspaceDir), makeRunner, mocked, condition, result, outcomes, signal: controller.signal, log };
    let patch: PatchExtraction | null = null;
    let patchError: string | null = null;
    if (task.extractPatch) {
      try {
        patch = await task.extractPatch({ ...ctxBase, patch: null });
        modelPatches.set(pairKey({ suite: source.suite, task: source.id, condition }), patch.modelPatch);
      } catch (e) {
        patchError = toJevCodeError(e).message;
        log(`[bench] ${source.id}/${condition}: model_patch extraction failed: ${patchError}`);
      }
    }
    let evaluation: Evaluation;
    try {
      evaluation = patchError !== null ? { pass: null, evaluator: 'none', reason: `patch_extraction_failed: ${patchError}` } : await task.evaluate({ ...ctxBase, patch });
    } catch (e) {
      evaluation = { pass: null, evaluator: 'none', reason: `evaluator_error: ${toJevCodeError(e).message}` };
    }
    const abortedForCap = capAborted.has(engine);
    // the child meter's own total decides task vs bench: a run stopped by the shared meter (parent exceeded) is a bench cap
    const childTripped = meter.snapshot().totalUsd >= opts.taskSpendCapUsd;
    const capFired: 'bench' | 'task' | null = abortedForCap || (result.stopReason === 'spend_cap' && (!childTripped || benchCapFired)) ? 'bench' : result.stopReason === 'spend_cap' ? 'task' : null;
    const rec = buildRecord({
      source,
      condition,
      result,
      evaluation,
      patch,
      capFired,
      ...(abortedForCap && result.stopReason === 'human_abort' ? { stopReasonOverride: 'spend_cap' as const } : {}),
    });
    newRecords.push(rec);
    await appendRecord(rec);
    log(`[bench] ${source.id}/${condition}: ${rec.stopReason} pass=${String(rec.pass)} (${rec.evaluator}) steps=${rec.steps}`);
  }

  // units: every condition of one task, in a fixed order, before the next task
  const units: PairPlan[][] = sources.map((source) => conditions.map((condition) => ({ source, condition, mode: planPair(latest.get(pairKey({ suite: source.suite, task: source.id, condition }))) })));
  const kept: BenchRecord[] = [];
  for (const unit of units) for (const p of unit) if (p.mode.kind === 'skip') kept.push(p.mode.record);
  // --resume with a narrower selection must not lose the other pairs' records (summary is regenerated from all of tasks.jsonl)
  const selected = new Set(units.flat().map((p) => pairKey({ suite: p.source.suite, task: p.source.id, condition: p.condition })));
  for (const [key, r] of latest) if (!selected.has(key) && r.reason !== IN_PROGRESS) kept.push(r);

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const unit = units[next++];
      if (!unit) return;
      for (const plan of unit) {
        if (plan.mode.kind === 'skip') continue;
        if (benchCapFired || controller.signal.aborted) {
          const rec = notRunRecord(plan.source, plan.condition, benchCapFired ? NOT_RUN_BENCH_CAP : NOT_RUN_ABORTED);
          newRecords.push(rec);
          await appendRecord(rec);
          continue;
        }
        try {
          await runPair(plan);
        } catch (e) {
          const rec = errorRecord(plan.source, plan.condition, `runner_error: ${toJevCodeError(e).message}`);
          newRecords.push(rec);
          await appendRecord(rec);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, units.length) }, worker));
  await appendChain;
  opts.signal?.removeEventListener('abort', onExternalAbort);

  // consolidate: previous kept records + new ones, markers dropped, pairComplete filled in
  const records = withPairComplete([...kept, ...newRecords].filter((r) => r.reason !== IN_PROGRESS), conditions);
  await writeFileAtomic(tasksPath, records.map(serialiseRecord).join('\n') + (records.length ? '\n' : ''));

  // a bench of jev-only alone has no generator model at all
  const model = generatorModel ?? (requiresGenerator(conditions) ? 'mock' : NULL_GENERATOR_MODEL);
  const perSuite: Record<string, SuiteMetrics> = {};
  const suites = suitesIn(records);
  const pairedTasks: Record<string, number> = {};
  for (const suite of suites) {
    perSuite[suite] = computeSuiteMetrics(records, suite, conditions, opts.limits.maxSteps);
    pairedTasks[suite] = perSuite[suite]!.comparison.pairedTasks.length;
  }
  const spend = root.snapshot();
  const notRunRecs = records.filter(isNotRun);
  const conditionsCfg: Summary['conditions'] = {};
  for (const c of conditions) conditionsCfg[c] = conditionConfig(c, opts, model);
  const summary: Summary = {
    benchId,
    createdAt,
    finishedAt: now().toISOString(),
    mocked,
    suites,
    conditions: conditionsCfg,
    conditionOrder: conditions,
    generatorModel: model,
    spendCapUsd: opts.spendCapUsd,
    taskSpendCapUsd: opts.taskSpendCapUsd,
    spentUsd: { generator: spend.generator.costUsd, jev: spend.jev.costUsd, total: spend.totalUsd },
    capFired: benchCapFired || records.some((r) => r.capFired === 'bench') ? 'bench' : null,
    notRun: { count: notRunRecs.length, tasks: notRunRecs.map((r) => `${r.task}/${r.condition}`) },
    pairedTasks,
    records: records.length,
    perSuite,
    resumed: resumeId !== null,
  };
  await writeFileAtomic(join(outDir, SUMMARY_FILE), `${JSON.stringify(toJson(summary), null, 2)}\n`);
  const comparisonMarkdown = renderComparison(summary, records);
  await writeFileAtomic(join(outDir, COMPARISON_FILE), comparisonMarkdown);

  if (suites.includes('swebench')) {
    for (const condition of conditions) {
      const entries: PredictionEntry[] = [];
      for (const r of records.filter((x) => x.suite === 'swebench' && x.condition === condition && x.runId !== null).sort((a, b) => a.task.localeCompare(b.task))) {
        const inMemory = modelPatches.get(pairKey(r));
        const saved = inMemory ?? (await readSavedModelPatch(join(opts.runsDir, r.runId!)));
        // model_name_or_path is a log directory name in the official harness: filesystem-safe, distinct per condition, 'none' for jev-only
        entries.push({ instance_id: r.task, model_name_or_path: modelNameOrPath(condition, condition === 'jev-only' ? 'none' : model), model_patch: saved ?? '' });
      }
      await writePredictions(outDir, condition, entries);
    }
  }
  log(`[bench] done: ${records.length} records in ${outDir}`);
  return { benchId, outDir, records, summary, comparisonMarkdown };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string, onTimeout: () => void): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => {
      onTimeout();
      rej(new Error(`${what} exceeded ${ms} ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        rej(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
