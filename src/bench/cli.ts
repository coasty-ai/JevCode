/**
 * `jevcode bench` wiring (DESIGN.md §13): maps CLI flags to BenchOptions, builds the real
 * BenchDeps (engines, mocks, meter, sandbox, the jev-only synthesizer, and the live
 * provider/decider when --live), and prints where the outputs went. Everything under bench/*
 * is dependency-injected so it can be tested without these modules; this file is the only
 * place the real ones meet.
 */
import { resolve } from 'node:path';
import type { ParsedFlags } from '../cli/args.js';
import type { Decider, Provider } from '../core/types.js';
import { UsageError } from '../errors.js';
import { ARCHIVE_DIR, archiveRunsDue } from './archive.js';
import { parseConditions, requiresGenerator } from './conditions.js';
import type { BenchDepsWithSynth, BenchOptions } from './types.js';

/**
 * `--archive-runs` and `--quick`. Both rows landed in cli/args.ts's flag table (`BOOLEAN_FLAGS` + `FLAGS`), so
 * `ParsedFlags` already types both keys and this alias widens nothing — it is kept as the name the bench wiring
 * reads its two own flags under. `test/unit/bench/quick-preset.test.ts` pins that `--quick` parses.
 */
export type BenchFlags = ParsedFlags & { archiveRuns?: boolean; quick?: boolean };

/**
 * contract 1.9 (Fastlane) §3.5 / HARNESS-NEXT-DESIGN.md §3 M16 and §5 Ring 2: `--quick` is the Ring-2 preset —
 * the five tasks JevCode already passes, at concurrency 3, replay by default, under a $0.05 global cap.
 *
 * The task list is §5's table rows 1–5 in its order: `gcd` (seeds win the race), `tagcloud` (the wall floor),
 * `units` (the LLM-decides path), `kth` (the sieve/confirm detector) and `mergesort` (the RANK and Jev-request
 * outlier). It is a MID-DIFFICULTY SUBSET, not a sample: every one of the five passes today, so a red row is
 * unambiguous, and the five between them touch every commit path the loop has (`sieve`, `llm`, `rank`).
 */
export const QUICK_TASK_IDS: readonly string[] = ['gcd', 'tagcloud', 'units', 'kth', 'mergesort'];
/** M16: the global cap `--quick` runs under when the caller named none — the whole preset is ≈ $0.01 live. */
export const QUICK_SPEND_CAP_USD = 0.05;
/** M16: `--quick` runs three tasks at a time (§5 Ring 2's own command line). */
export const QUICK_CONCURRENCY = 3;

/**
 * The preset applied as DEFAULTS, never as overrides: an explicit `--task-id`, `--concurrency`, `--spend-cap`
 * or `--suite` on the same command line wins, so `--quick --task-id mergesort` is one task and not five. It also
 * does not turn `--live` on — M16's "replay by default" is exactly the existing `live: Boolean(flags.live)`.
 */
export function withQuickPreset(flags: BenchFlags): BenchFlags {
  if (flags.quick !== true) return flags;
  return {
    ...flags,
    ...(flags.taskId === undefined ? { taskId: QUICK_TASK_IDS.join(',') } : {}),
    ...(flags.concurrency === undefined ? { concurrency: String(QUICK_CONCURRENCY) } : {}),
    ...(flags.spendCap === undefined ? { spendCap: String(QUICK_SPEND_CAP_USD) } : {}),
  };
}

export async function runBenchFromFlags(rawFlags: BenchFlags): Promise<number> {
  // §3.5 / M16: the preset fills the flags the caller left out, before any of them is validated or read
  const flags = withQuickPreset(rawFlags);
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
  process.stdout.write(`bench: ${result.records.length} records -> ${result.outDir}\n  tasks.jsonl, summary.json, comparison.md, predictions.<condition>.jsonl${archiveRunsDue(flags.archiveRuns, result.outDir) ? `, ${ARCHIVE_DIR}/<runId>/*.gz` : ''}\n`);
  return 0;
}
