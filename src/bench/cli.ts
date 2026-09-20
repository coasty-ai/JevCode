/**
 * `jevcode bench` wiring (DESIGN.md §13): maps CLI flags to BenchOptions, builds the real
 * BenchDeps (engines, mocks, meter, sandbox, and the live provider/decider when --live), and
 * prints where the outputs went. Everything under bench/* is dependency-injected so it can
 * be tested without these modules; this file is the only place the real ones meet.
 */
import { resolve } from 'node:path';
import type { ParsedFlags } from '../cli/args.js';
import type { BenchDeps, Decider, Provider } from '../core/types.js';
import { UsageError } from '../errors.js';
import type { BenchOptions } from './types.js';

export async function runBenchFromFlags(flags: ParsedFlags): Promise<number> {
  const { resolveConfig } = await import('../config/resolve.js');
  const config = await resolveConfig(flags, process.env, process.cwd());
  const limits = config.limits();
  if (flags.live && flags.spendCap === undefined) throw new UsageError('--live requires --spend-cap <usd> (the bench-wide total)');

  const { createEngine } = await import('../loop/engine.js');
  const { createGeneratorOnlyEngine } = await import('../loop/generator-only.js');
  const { createMockProvider } = await import('../provider/mock.js');
  const { createMockDecider } = await import('../jev/mock.js');
  const { createSpendMeter } = await import('../spend/meter.js');
  const { createSandbox } = await import('../sandbox/run.js');

  let liveProvider: Provider | undefined;
  let liveDecider: Decider | undefined;
  let generation: { temperature: number | null; maxTokens: number } = { temperature: null, maxTokens: 4096 };
  let deciderModel: { configured: string; pinned: boolean } = { configured: 'typesafe/jev-1.13-20260917', pinned: true };
  if (flags.live) {
    const gen = config.generator();
    const dec = config.decider();
    if (!dec.pinned && !flags.allowModelAlias) {
      throw new UsageError(`--jev-model "${dec.model}" is an alias; the bench compares conditions on a fixed model. Pass the dated id or --allow-model-alias.`);
    }
    generation = { temperature: gen.temperature, maxTokens: gen.maxTokens };
    deciderModel = { configured: dec.model, pinned: dec.pinned };
    liveProvider = gen.provider === 'openrouter'
      ? (await import('../provider/openrouter.js')).createOpenRouterProvider(gen, { redact: config.redact })
      : (await import('../provider/anthropic.js')).createAnthropicProvider(gen, { redact: config.redact });
    const { createJevDecider } = await import('../jev/client.js');
    liveDecider = createJevDecider(dec, { redact: config.redact });
  }

  const deps: BenchDeps = {
    createEngine,
    createGeneratorOnlyEngine,
    createMockProvider,
    createMockDecider,
    createSpendMeter,
    createSandbox,
    ...(liveProvider ? { liveProvider } : {}),
    ...(liveDecider ? { liveDecider } : {}),
  };

  const conditions = (flags.conditions ?? 'jev-on,jev-off').split(',').map((s) => s.trim()).filter((s) => s === 'jev-on' || s === 'jev-off') as ('jev-on' | 'jev-off')[];
  if (conditions.length === 0) throw new UsageError('--conditions must list jev-on and/or jev-off');
  const suite = flags.suite ?? 'all';
  if (suite !== 'swebench' && suite !== 'terminal-bench' && suite !== 'all') throw new UsageError('--suite must be swebench, terminal-bench or all');

  const opts: BenchOptions = {
    suite,
    tasks: flags.tasks ?? null,
    taskIds: flags.taskId ? flags.taskId.split(',').map((s) => s.trim()).filter(Boolean) : null,
    conditions,
    concurrency: flags.concurrency ?? 3,
    live: Boolean(flags.live),
    spendCapUsd: flags.spendCap ?? (flags.live ? 0 : 1_000_000),
    taskSpendCapUsd: flags.taskSpendCap ?? limits.spendCapUsd,
    allowModelAlias: Boolean(flags.allowModelAlias),
    resumeBenchId: flags.resume ?? null,
    outDir: resolve(flags.out ?? `bench/results/${new Date().toISOString().replace(/[:.]/g, '-')}`),
    runsDir: config.runsDir,
    limits,
    sandboxProfile: config.sandbox,
    noNetwork: config.noNetwork,
    generation,
    deciderModel,
    configRecord: config.record(),
    redact: config.redact,
    secretPaths: config.secretPaths,
    dataDir: resolve('bench/data'),
  };
  const { runBench } = await import('./runner.js');
  const result = await runBench(opts, deps);
  process.stdout.write(`bench: ${result.records.length} records -> ${result.outDir}\n  tasks.jsonl, summary.json, comparison.md, predictions.<condition>.jsonl\n`);
  return 0;
}
