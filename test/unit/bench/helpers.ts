/**
 * Offline fakes for BenchDeps: a scripted engine (scripted RunResults, abortable, emits the
 * events the runner listens to), a sandbox that records every command and can either script
 * results or really execute them with /bin/sh (git is available locally), and a meter tree.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmitter } from '../../../src/core/events.js';
import type {
  ActionOutcome,
  AskResult,
  BenchCondition,
  BenchDeps,
  Decider,
  Engine,
  EngineMode,
  EngineOptions,
  ExecResult,
  GenerateRequest,
  Json,
  MockProviderOptions,
  Plan,
  Provider,
  RunResult,
  Sandbox,
  SandboxCreateOptions,
  SandboxRunOptions,
  SpendMeter,
  SpendSnapshot,
  StopReason,
  Synthesizer,
  SynthesizerArmMode,
  SynthesizerGeneration,
  TokenUsage,
} from '../../../src/core/types.js';
import type { BenchDepsWithSynth, BenchSetupTools, BenchTaskSource, BuildTaskOptions, BenchTask, Evaluation } from '../../../src/bench/types.js';

export const zeroUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });

export const emptyPlan = (): Plan => ({ done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] });

export function fakeRunResult(over: Partial<RunResult> & { runId: string; mode: EngineMode }): RunResult {
  const gen = over.usage?.generator ?? zeroUsage();
  const jev = over.usage?.jev ?? zeroUsage();
  return {
    stopReason: 'complete',
    steps: 3,
    wallMs: 1000,
    tokensPerStep: [100, 200, 300],
    generatorTokensPerStep: [60, 120, 180],
    jevTokensPerStep: [40, 80, 120],
    jevLatencyMs: [],
    jevQuestions: 0,
    counters: { blocked: 0, reviews: 0, declined: 0, failed: 0, loops: 0, replans: 0, reads: 0 },
    finalPlan: emptyPlan(),
    resolvedJevModel: null,
    jevModelDrift: null,
    timing: { generatorMs: 500, jevMs: 200, execMs: 200, harnessMs: 100, totalMs: 1000 },
    ...over,
    usage: { generator: gen, jev },
  };
}

// ---------------------------------------------------------------------------------------
// meter
// ---------------------------------------------------------------------------------------

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, costUsd: a.costUsd + b.costUsd, calls: a.calls + b.calls };
}

export function createFakeMeter(capUsd: number, parent?: SpendMeter): SpendMeter {
  let generator = zeroUsage();
  let jev = zeroUsage();
  const snapshot = (): SpendSnapshot => {
    const totalUsd = generator.costUsd + jev.costUsd;
    return { generator, jev, totalUsd, capUsd, exceeded: (capUsd > 0 && totalUsd >= capUsd) || (parent?.exceeded() ?? false) };
  };
  const meter: SpendMeter = {
    add(source, usage) {
      if (source === 'generator') generator = addUsage(generator, usage);
      else jev = addUsage(jev, usage);
      parent?.add(source, usage);
      return snapshot();
    },
    exceeded: () => snapshot().exceeded,
    snapshot,
    restore(s) {
      generator = { ...s.generator };
      jev = { ...s.jev };
    },
    child: (c) => createFakeMeter(c, meter),
  };
  return meter;
}

// ---------------------------------------------------------------------------------------
// sandbox
// ---------------------------------------------------------------------------------------

export interface RecordedCommand {
  root: string;
  command: string;
  cwd: string | undefined;
  env: Record<string, string> | undefined;
}

export type CommandHandler = (cmd: RecordedCommand, opts: SandboxRunOptions) => Partial<ExecResult> | Promise<Partial<ExecResult>> | undefined;

export function okResult(over: Partial<ExecResult> = {}): ExecResult {
  return { ok: true, exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, bytesSeen: 0, killedBy: null, timedOut: false, orphans: [], sandboxExecDenied: false, durationMs: 1, ...over };
}

export function failResult(stderr = 'failed', exitCode = 1): ExecResult {
  return okResult({ ok: false, exitCode, stderr });
}

/** Really run `sh -c` (used for git-backed tests); output capped and onOutput honoured. */
export function realExec(cmd: RecordedCommand, opts: SandboxRunOptions): Promise<ExecResult> {
  return new Promise((resolveP) => {
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', cmd.command], { cwd: cmd.cwd ?? cmd.root, env: { ...process.env, ...(cmd.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killedBy: ExecResult['killedBy'] = null;
    const timer = setTimeout(() => {
      killedBy = 'timeout';
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    const onAbort = (): void => {
      killedBy = 'abort';
      child.kill('SIGKILL');
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stdout += s;
      opts.onOutput?.('stdout', s);
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stderr += s;
      opts.onOutput?.('stderr', s);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      const bytes = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
      resolveP({
        ok: code === 0 && killedBy === null,
        exitCode: code,
        signal,
        stdout: stdout.slice(0, opts.maxOutputBytes),
        stderr: stderr.slice(0, opts.maxOutputBytes),
        truncated: bytes > opts.maxOutputBytes,
        bytesSeen: bytes,
        killedBy,
        timedOut: killedBy === 'timeout',
        orphans: [],
        sandboxExecDenied: false,
        durationMs: Date.now() - started,
      });
    });
  });
}

export interface FakeSandboxFactory {
  create: (opts: SandboxCreateOptions) => Sandbox;
  commands: RecordedCommand[];
  created: SandboxCreateOptions[];
}

/** `handler` may return a scripted result; undefined falls through to `fallback` ('ok' or 'real'). */
export function createFakeSandboxFactory(handler: CommandHandler = () => undefined, fallback: 'ok' | 'real' = 'ok'): FakeSandboxFactory {
  const commands: RecordedCommand[] = [];
  const created: SandboxCreateOptions[] = [];
  return {
    commands,
    created,
    create(opts) {
      created.push(opts);
      return {
        level: 'none',
        async run(command, runOpts) {
          const rec: RecordedCommand = { root: opts.workspaceRoot, command, cwd: runOpts.cwd, env: runOpts.env };
          commands.push(rec);
          const scripted = await handler(rec, runOpts);
          if (scripted !== undefined) return okResult(scripted);
          return fallback === 'real' ? realExec(rec, runOpts) : okResult();
        },
        killAll: async () => undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------------------

export interface ScriptedRun {
  result: Partial<RunResult>;
  /** wait this long (or until abort) before finishing */
  delayMs?: number;
  /** spend added to the meter (generator) before finishing */
  spendUsd?: number;
  decisions?: number;
  outcomes?: ActionOutcome[];
  /** run this against the workspace before returning (e.g. apply the trajectory) */
  effect?: (opts: EngineOptions) => Promise<void>;
}

export type EngineScript = (task: string, mode: EngineMode, opts: EngineOptions) => ScriptedRun;

export interface Captured {
  engines: { mode: EngineMode; opts: EngineOptions; runId: string; resumed: boolean }[];
  generateRequests: GenerateRequest[];
  askStates: Json[];
  mockProviders: MockProviderOptions[];
  /** deciders handed to createSynthesizer (jev-only pairs) */
  synthesizerDeciders: Decider[];
  /** the `mode` handed to createSynthesizer per synthesizer pair (docs/LLM-JEV-DESIGN.md §10.1) */
  synthesizerModes: SynthesizerArmMode[];
  /** the pinned `generation` handed to createSynthesizer per synthesizer pair (null for jev-only) */
  synthesizerGenerations: (SynthesizerGeneration | null)[];
}

let runCounter = 0;
export function createFakeEngineFactory(script: EngineScript, captured: Captured) {
  return (_label: EngineMode) =>
    async (opts: EngineOptions): Promise<Engine> => {
      // the mode is the one in the options: jev-on and jev-only both arrive through deps.createEngine
      const mode = opts.mode;
      const runId = opts.resume?.runId ?? `20260919-1200${String(++runCounter).padStart(2, '0')}-${(runCounter % 32).toString(32).padStart(8, 'a')}`;
      captured.engines.push({ mode, opts, runId, resumed: opts.resume !== undefined });
      await mkdir(join(opts.runsDir, runId), { recursive: true });
      const events = createEmitter(() => undefined);
      const controller = new AbortController();
      let abortReason: 'human_abort' | 'signal' | 'error' | null = null;
      const s = script(opts.task, mode, opts);
      const engine: Engine = {
        runId,
        events,
        signal: controller.signal,
        abort(reason) {
          if (abortReason !== null) return;
          abortReason = reason;
          controller.abort(new Error(reason));
        },
        // contract 1.1 (TUI-DESIGN §15 item 15): the bench never steers, pauses or annotates; no-ops keep the fake honest
        steer: () => ({ ok: false, reason: 'finished', queued: 0 }),
        unsteer: () => null,
        pause: () => undefined,
        retryNow: () => false,
        annotate: () => false,
        status: () => ({ step: 0, maxSteps: opts.limits.maxSteps, wallMs: 0, maxWallMs: opts.limits.maxWallMs, stage: 'idle', spend: opts.meter.snapshot(), stopReason: null }),
        snapshotState: () => null,
        async run() {
          // the engine's prompt and Jev state carry the task text and nothing else from the record
          const req: GenerateRequest = { system: 'system', messages: [{ role: 'user', content: `Task:\n${opts.task}` }], maxTokens: opts.generation.maxTokens, temperature: opts.generation.temperature };
          // jev-only never touches the generator slot (the runner puts the NullProvider there)
          if (mode !== 'jev-only') await opts.provider.generate(req, { signal: controller.signal }).catch(() => undefined);
          if (mode !== 'jev-off') await opts.decider.ask({ task: opts.task, plan: [] }, { q: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } }, { signal: controller.signal, stage: 'intent', step: 1 }).catch(() => undefined);
          if (s.spendUsd !== undefined) {
            opts.meter.add(mode === 'jev-only' ? 'jev' : 'generator', { inputTokens: 10, outputTokens: 10, costUsd: s.spendUsd, calls: 1 });
            events.emit({ type: 'status', status: engine.status() });
          }
          for (let i = 0; i < (s.decisions ?? 0); i++) {
            events.emit({ type: 'decision', decision: { step: 1, stage: 'intent', id: `q${i}`, question: { type: 'noul', instructions: 'x' }, answer: { type: 'noul', noul: 0.9 }, probability: 0.9, confidence: 0.8, latencyMs: 100, requestHash: 'h' } });
          }
          for (const [i, o] of (s.outcomes ?? []).entries()) events.emit({ type: 'outcome', step: i + 1, outcome: o });
          if (s.delayMs !== undefined && abortReason === null) {
            await new Promise<void>((res) => {
              const t = setTimeout(res, s.delayMs);
              controller.signal.addEventListener('abort', () => {
                clearTimeout(t);
                res();
              }, { once: true });
            });
          }
          if (s.effect && abortReason === null) await s.effect(opts);
          const stopReason: StopReason = abortReason !== null ? abortReason : opts.meter.exceeded() ? 'spend_cap' : (s.result.stopReason ?? 'complete');
          const snap = opts.meter.snapshot();
          // the runner reads jevQuestions from the RunResult (never from decision events): scripted `decisions` is the count
          const result = fakeRunResult({ ...s.result, runId, mode, stopReason, jevQuestions: s.result.jevQuestions ?? s.decisions ?? 0, usage: s.result.usage ?? { generator: snap.generator, jev: snap.jev } });
          events.emit({ type: 'run:end', result });
          return result;
        },
      };
      return engine;
    };
}

export function createCaptured(): Captured {
  return { engines: [], generateRequests: [], askStates: [], mockProviders: [], synthesizerDeciders: [], synthesizerModes: [], synthesizerGenerations: [] };
}

/**
 * A synthesizer that proposes `done` at once; the scripted engine never calls it, real engines would. It echoes the mode and
 * generation it was built with (docs/LLM-JEV-DESIGN.md §10.1: the runner refuses an arm without the echo); none when omitted.
 */
export function createFakeSynthesizer(mode?: SynthesizerArmMode, generation?: SynthesizerGeneration): Synthesizer {
  return {
    name: 'fake-synth',
    ...(mode !== undefined ? { mode } : {}),
    ...(generation !== undefined ? { generation } : {}),
    synthesize: async (ctx) => {
      ctx.emit({ type: 'synth', step: ctx.step, phase: 'fake', detail: 'fake synthesizer', candidates: 0, tested: 0 });
      return { goal: 'fake', action: { kind: 'done', summary: 'fake synthesizer' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' };
    },
  };
}

export function createFakeProvider(captured: Captured, model = 'mock-model'): Provider {
  return {
    name: 'mock',
    model,
    async generate(req) {
      captured.generateRequests.push(req);
      return { text: '', toolCalls: [], usage: zeroUsage(), model, stopReason: 'end_turn', latencyMs: 1 };
    },
  };
}

export function createFakeDecider(captured: Captured): Decider {
  return {
    model: 'mock-jev',
    async ask(state, questions): Promise<AskResult> {
      captured.askStates.push(state);
      const answers: AskResult['answers'] = {};
      for (const id of Object.keys(questions)) answers[id] = { type: 'noul', noul: 0.9 };
      return { answers, usage: zeroUsage(), latencyMs: 1, model: 'mock-jev', requestHash: 'h', attempts: 1, id: null };
    },
  };
}

export interface FakeDepsOptions {
  script: EngineScript;
  sandbox?: FakeSandboxFactory;
  live?: boolean;
  /** with --live: omit the live provider (a jev-only-only bench needs none) */
  liveProviderless?: boolean;
  /** omit createSynthesizer (default false: present, as bench/cli.ts always passes it) */
  noSynthesizer?: boolean;
}

export function createFakeDeps(o: FakeDepsOptions): { deps: BenchDepsWithSynth; captured: Captured; sandbox: FakeSandboxFactory } {
  const captured = createCaptured();
  const sandbox = o.sandbox ?? createFakeSandboxFactory();
  const factory = createFakeEngineFactory(o.script, captured);
  const base: BenchDeps = {
    createEngine: factory('jev-on'),
    createGeneratorOnlyEngine: factory('jev-off'),
    createMockProvider(opts) {
      captured.mockProviders.push(opts);
      return createFakeProvider(captured);
    },
    createMockDecider: () => createFakeDecider(captured),
    createSpendMeter: createFakeMeter,
    createSandbox: sandbox.create,
    ...(o.live && !o.liveProviderless ? { liveProvider: createFakeProvider(captured, 'z-ai/glm-5.3-flash') } : {}),
    ...(o.live ? { liveDecider: createFakeDecider(captured) } : {}),
  };
  const deps: BenchDepsWithSynth = o.noSynthesizer
    ? base
    : {
        ...base,
        createSynthesizer: ({ decider, mode, generation }) => {
          captured.synthesizerDeciders.push(decider);
          captured.synthesizerModes.push(mode);
          captured.synthesizerGenerations.push(generation ?? null);
          return createFakeSynthesizer(mode, generation);
        },
      };
  return { deps, captured, sandbox };
}

// ---------------------------------------------------------------------------------------
// synthetic tasks and options
// ---------------------------------------------------------------------------------------

export interface SyntheticTaskOptions {
  id: string;
  suite?: 'swebench' | 'terminal-bench';
  evaluate?: (ctx: { condition: BenchCondition; mocked: boolean }) => Evaluation;
  setup?: (workspaceDir: string, tools: BenchSetupTools) => Promise<void>;
}

export function syntheticSource(o: SyntheticTaskOptions): BenchTaskSource {
  const suite = o.suite ?? 'swebench';
  return {
    suite,
    id: o.id,
    meta: {},
    build(_b: BuildTaskOptions): BenchTask {
      return {
        suite,
        id: o.id,
        task: `Task text for ${o.id}`,
        meta: {},
        setup: async (w, tools) => (o.setup ? o.setup(w, tools) : undefined),
        evaluate: async (ctx) => (o.evaluate ? o.evaluate({ condition: ctx.condition, mocked: ctx.mocked }) : { pass: true, evaluator: 'mock' }),
        mockTrajectory: () => [{ text: `mock ${o.id}` }],
        ...(suite === 'swebench' ? { extractPatch: async () => ({ modelPatch: `diff --git a/${o.id}.txt b/${o.id}.txt\n`, patchBytes: 10, patchEmpty: false }) } : {}),
      };
    },
  };
}

export async function tempDir(prefix = 'jevbench-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function baseOptions(runsDir: string, outDir: string, over: Partial<import('../../../src/bench/types.js').BenchOptions> = {}): import('../../../src/bench/types.js').BenchOptions {
  return {
    suite: 'swebench',
    conditions: ['jev-on', 'jev-off'],
    concurrency: 2,
    live: false,
    spendCapUsd: 100,
    taskSpendCapUsd: 2,
    allowModelAlias: false,
    outDir,
    runsDir,
    limits: { maxSteps: 10, maxWallMs: 60_000, maxReplans: 5, completeThreshold: 0.85, impossibleThreshold: 0.85, commandTimeoutMs: 30_000, maxCommandTimeoutMs: 120_000, maxOutputBytes: 200_000, spendCapUsd: 2 },
    sandboxProfile: 'none',
    noNetwork: false,
    generation: { temperature: null, maxTokens: 4096 },
    deciderModel: { configured: 'typesafe/jev-1.13-20260917', pinned: true },
    configRecord: {},
    redact: (s) => s,
    secretPaths: [],
    now: () => new Date('2026-09-19T12:00:00Z'),
    ...over,
  };
}
