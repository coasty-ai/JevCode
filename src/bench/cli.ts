/**
 * `jevcode bench` wiring (DESIGN.md §13): maps CLI flags to BenchOptions, builds the real
 * BenchDeps (engines, mocks, meter, sandbox, the jev-only synthesizer, and the live
 * provider/decider when --live), and prints where the outputs went. Everything under bench/*
 * is dependency-injected so it can be tested without these modules; this file is the only
 * place the real ones meet.
 */
import { join, resolve } from 'node:path';
import type { ParsedFlags } from '../cli/args.js';
import type { Decider, Provider } from '../core/types.js';
import { UsageError } from '../errors.js';
import { ARCHIVE_DIR, archiveRunsDue } from './archive.js';
import { parseConditions, requiresGenerator } from './conditions.js';
import type { BenchDepsWithSynth, BenchOptions } from './types.js';

/**
 * `--archive-runs`. cli/args.ts owns the flag table (`BOOLEAN_FLAGS` + `FLAGS`) and is not this
 * wave's to edit, so the parsed value is read through this widening: `ParsedFlags` is assignable to
 * it, and the key resolves once args.ts carries `'archiveRuns'` in `BOOLEAN_FLAGS`.
 */
type BenchFlags = ParsedFlags & { archiveRuns?: boolean };

export async function runBenchFromFlags(flags: BenchFlags): Promise<number> {
  const { resolveConfig } = await import('../config/resolve.js');
  const config = await resolveConfig(flags, process.env, process.cwd());
  const limits = config.limits();
  if (flags.live && flags.spendCap === undefined) throw new UsageError('--live requires --spend-cap <usd> (the bench-wide total)');
  for (const [name, v] of [['--tasks', flags.tasks], ['--concurrency', flags.concurrency], ['--spend-cap', flags.spendCap], ['--task-spend-cap', flags.taskSpendCap]] as const) {
    if (v !== undefined && !Number.isFinite(Number(v))) throw new UsageError(`${name} must be a number, got "${v}"`);
  }
  // args.ts already validated the names; parseConditions dedupes and keeps the order given
  const conditions = parseConditions(flags.conditions ?? 'jev-on,jev-off');

  const { createEngine } = await import('../loop/engine.js');
  const { createGeneratorOnlyEngine } = await import('../loop/generator-only.js');
  const { createMockProvider } = await import('../provider/mock.js');
  const { createMockDecider } = await import('../jev/mock.js');
  const { createSpendMeter } = await import('../spend/meter.js');
  const { createSandbox } = await import('../sandbox/run.js');
  const { createSynthesizer } = await import('../synth/index.js');

  let liveProvider: Provider | undefined;
  let liveDecider: Decider | undefined;
  // docs/LLM-JEV-DESIGN.md §10.1: recorded for the report only — every arm runs the PINNED parameters of
  // bench/conditions.ts `pinnedGeneration` (jev-off = the checked-in baseline's {null, 4096}), never the user's config
  let generation: { temperature: number | null; maxTokens: number } = { temperature: null, maxTokens: 4096 };
  let deciderModel: { configured: string; pinned: boolean } = { configured: 'typesafe/jev-1.13-20260917', pinned: true };
  if (flags.live) {
    const dec = config.decider();
    if (!dec.pinned && !flags.allowModelAlias) {
      throw new UsageError(`--jev-model "${dec.model}" is an alias; the bench compares conditions on a fixed model. Pass the dated id or --allow-model-alias.`);
    }
    deciderModel = { configured: dec.model, pinned: dec.pinned };
    const { createJevDecider } = await import('../jev/client.js');
    liveDecider = createJevDecider(dec, { redact: config.redact });
    // jev-only alone needs no generator: the generator section is not validated and no provider is built (docs/JEV-ONLY.md)
    if (requiresGenerator(conditions)) {
      const gen = config.generator();
      // the user's values, recorded as such; the arms' requests carry their pinned parameters (conditions.ts)
      generation = { temperature: gen.temperature, maxTokens: gen.maxTokens };
      liveProvider = gen.provider === 'openrouter'
        ? (await import('../provider/openrouter.js')).createOpenRouterProvider(gen, { redact: config.redact })
        : (await import('../provider/anthropic.js')).createAnthropicProvider(gen, { redact: config.redact });
    }
  }

  const deps: BenchDepsWithSynth = {
    createEngine,
    createGeneratorOnlyEngine,
    createMockProvider,
    createMockDecider,
    createSpendMeter,
    createSandbox,
    createSynthesizer,
    ...(liveProvider ? { liveProvider } : {}),
    ...(liveDecider ? { liveDecider } : {}),
  };

  const suite = flags.suite ?? 'all';
  if (suite !== 'swebench' && suite !== 'terminal-bench' && suite !== 'quixbugs' && suite !== 'ladder' && suite !== 'all') throw new UsageError('--suite must be swebench, terminal-bench, quixbugs, ladder or all');

  const opts: BenchOptions = {
    suite,
    tasks: flags.tasks !== undefined ? Number(flags.tasks) : null,
    taskIds: flags.taskId ? flags.taskId.split(',').map((s) => s.trim()).filter(Boolean) : null,
    conditions,
    concurrency: flags.concurrency !== undefined ? Number(flags.concurrency) : 3,
    live: Boolean(flags.live),
    spendCapUsd: flags.spendCap !== undefined ? Number(flags.spendCap) : flags.live ? 0 : 1_000_000,
    taskSpendCapUsd: flags.taskSpendCap !== undefined ? Number(flags.taskSpendCap) : limits.spendCapUsd,
    allowModelAlias: Boolean(flags.allowModelAlias),
    resumeBenchId: flags.resume ?? null,
    // undefined lets the runner derive bench/results/<benchId>, which is what `--resume <bench-id>` re-reads
    outDir: flags.out ? resolve(flags.out) : null,
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
    // undefined (no flag) lets the runner take the bench/results default (archive.ts archiveRunsDue)
    ...(flags.archiveRuns === undefined ? {} : { archiveRuns: flags.archiveRuns }),
  };
  const { runBench } = await import('./runner.js');
  const result = await runBench(opts, deps);
  process.stdout.write(`bench: ${result.records.length} records -> ${result.outDir}\n  tasks.jsonl, summary.json, comparison.md, predictions.<condition>.jsonl${archiveRunsDue(flags.archiveRuns, result.outDir, join(process.cwd(), 'bench', 'results')) ? `, ${ARCHIVE_DIR}/<runId>/*.gz` : ''}\n`);
  return 0;
}
