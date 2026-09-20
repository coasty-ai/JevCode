/**
 * CLI entry (DESIGN.md §3.1, §6 first line, §11, §12). Ordering contract: for `run`, the
 * renderer's first frame is committed before any config, .env, runs-dir or workspace read.
 * Heavy modules (providers, Jev client, bench, perf) are dynamic imports.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parseCliArgs, usageText } from './args.js';
import type { ParsedFlags } from './args.js';
import { EXIT_CODES, JevCodeError, UsageError, isJevCodeError } from '../errors.js';
import type { Decider, Engine, EngineOptions, Provider, Renderer, ResolvedConfig, RunResult, StopReason } from '../core/types.js';
import { fingerprint } from '../core/hash.js';

const VERSION = '0.1.0';

function exitCodeFor(stop: StopReason, result: RunResult): number {
  switch (stop) {
    case 'complete':
      return EXIT_CODES.ok;
    case 'human_abort':
    case 'signal':
      return EXIT_CODES.sigint;
    case 'error':
      return result.error?.exitCode ?? EXIT_CODES.api;
    case 'generator_done':
      return EXIT_CODES.ok;
    default:
      return EXIT_CODES.budget;
  }
}

async function readTask(flags: ParsedFlags): Promise<string> {
  if (flags.task) return flags.task;
  if (flags.taskFile) return readFileSync(resolvePath(flags.taskFile), 'utf8').trim();
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text) return text;
  }
  throw new UsageError('missing task text: pass it as a positional argument, --task-file <path>, or on stdin');
}

async function buildProvider(config: ResolvedConfig, flags: ParsedFlags): Promise<Provider> {
  if (flags.mock) {
    const { createMockProvider } = await import('../provider/mock.js');
    const { mockTrajectory } = await import('./mock-trajectory.js');
    return createMockProvider({ turns: mockTrajectory(flags.mockSteps ?? 8) });
  }
  const gen = config.generator();
  if (gen.provider === 'openrouter') {
    const { createOpenRouterProvider } = await import('../provider/openrouter.js');
    return createOpenRouterProvider(gen, { redact: config.redact });
  }
  const { createAnthropicProvider } = await import('../provider/anthropic.js');
  return createAnthropicProvider(gen, { redact: config.redact });
}

async function buildDecider(config: ResolvedConfig, flags: ParsedFlags): Promise<Decider> {
  if (flags.mock) {
    const { createMockDecider } = await import('../jev/mock.js');
    return createMockDecider({});
  }
  const { createJevDecider } = await import('../jev/client.js');
  return createJevDecider(config.decider(), { redact: config.redact });
}

async function commandRun(flags: ParsedFlags): Promise<number> {
  const interactive = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY) && !flags.plain;
  let engine: Engine | null = null;
  let abortRequested: 'human_abort' | 'signal' | null = null;
  const onAbort = (reason: 'human_abort' | 'signal'): void => {
    abortRequested = reason;
    if (engine) engine.abort(reason);
  };
  const rendererOpts = { task: flags.task ?? (flags.resume ? `resuming ${flags.resume}` : ''), resumeId: flags.resume ?? null, onAbort };
  const renderer: Renderer = interactive
    ? (await import('../tui/App.js')).createTuiRenderer(rendererOpts)
    : (await import('../tui/plain.js')).createPlainRenderer(rendererOpts);

  if (flags.perfExitAfterFirstFrame) {
    await renderer.firstFrame();
    process.stderr.write(`FIRST_FRAME_MS=${performance.now().toFixed(1)}\n`);
    process.exit(0);
  }

  const lagProbe = flags.perfLagProbe ? startLagProbe() : null;

  try {
    const { resolveConfig } = await import('../config/resolve.js');
    const config = await resolveConfig(flags, process.env, process.cwd());
    const limits = config.limits();

    let task: string;
    let resume: EngineOptions['resume'];
    if (flags.resume) {
      const { loadForResume } = await import('../checkpoint/resume.js');
      const { reconcileResumeConfig } = await import('../config/resolve.js');
      const loaded = await loadForResume(config.runsDir, flags.resume);
      const rec = reconcileResumeConfig(config, loaded.meta, flags);
      if (rec.errors.length > 0) throw rec.errors[0];
      if (rec.immediateStop) {
        await renderer.unmount();
        process.stderr.write(`${rec.immediateStop.message}\n`);
        return EXIT_CODES.budget;
      }
      task = loaded.meta.task;
      resume = { runId: flags.resume, force: Boolean(flags.force) };
    } else {
      task = await readTask(flags);
      resume = undefined;
    }

    const provider = await buildProvider(config, flags);
    const decider = await buildDecider(config, flags);
    const { createSpendMeter } = await import('../spend/meter.js');
    const meter = createSpendMeter(limits.spendCapUsd);
    const gen = flags.mock ? { temperature: null, maxTokens: 4096 } : config.generator();
    const dec = flags.mock ? { model: 'typesafe/jev-1.13-20260917', pinned: true } : config.decider();

    const opts: EngineOptions = {
      task,
      mode: flags.condition === 'jev-off' ? 'jev-off' : 'jev-on',
      workspace: config.workspace,
      runsDir: config.runsDir,
      ...(resume ? { resume } : {}),
      provider,
      decider,
      confirmer: renderer.confirmer,
      meter,
      limits,
      sandboxProfile: config.sandbox,
      noNetwork: config.noNetwork,
      configRecord: config.record(),
      redact: config.redact,
      secretPaths: config.secretPaths,
      generation: { temperature: gen.temperature, maxTokens: gen.maxTokens },
      deciderModel: { configured: dec.model, pinned: dec.pinned },
    };
    engine = opts.mode === 'jev-off'
      ? await (await import('../loop/generator-only.js')).createGeneratorOnlyEngine(opts)
      : await (await import('../loop/engine.js')).createEngine(opts);
    if (abortRequested) engine.abort(abortRequested);
    renderer.attach(engine);
    const sig = (): void => onAbort('signal');
    process.on('SIGINT', sig);
    process.on('SIGTERM', sig);
    const result = await engine.run();
    process.off('SIGINT', sig);
    process.off('SIGTERM', sig);
    await renderer.unmount();
    if (lagProbe) process.stderr.write(`LAG_JSON=${JSON.stringify(lagProbe.stop())}\n`);
    if (!interactive) process.stderr.write(`stop: ${result.stopReason} after ${result.steps} steps, $${result.usage.generator.costUsd.toFixed(4)} generator + $${result.usage.jev.costUsd.toFixed(4)} jev; run ${result.runId}\n`);
    return exitCodeFor(result.stopReason, result);
  } catch (e) {
    await renderer.unmount().catch(() => undefined);
    throw e;
  }
}

function startLagProbe(): { stop: () => { p50: number | null; p95: number | null; max: number; samples: number } } {
  const lags: number[] = [];
  const started = performance.now();
  let last = performance.now();
  const t = setInterval(() => {
    const now = performance.now();
    if (now - started > 500) lags.push(Math.max(0, now - last - 10));
    last = now;
  }, 10);
  return {
    stop: () => {
      clearInterval(t);
      const s = [...lags].sort((a, b) => a - b);
      const q = (p: number): number | null => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]! : null);
      return { p50: q(50), p95: q(95), max: s.length ? s[s.length - 1]! : 0, samples: s.length };
    },
  };
}

async function commandConfig(flags: ParsedFlags): Promise<number> {
  const { resolveConfig } = await import('../config/resolve.js');
  const config = await resolveConfig(flags, process.env, process.cwd());
  const { detectSandboxLevel } = await import('../sandbox/seatbelt.js');
  const level = detectSandboxLevel(config.sandbox);
  const record = config.record();
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...record, sandboxLevel: level }, null, 2)}\n`);
    return 0;
  }
  const rows = Object.entries(record).map(([k, v]) => [k, typeof v.value === 'string' ? v.value : `<${v.value.source}> (sha256:${v.value.fingerprint})`, v.source]);
  const w0 = Math.max(...rows.map((r) => r[0]!.length), 7);
  const w1 = Math.max(...rows.map((r) => r[1]!.length), 5);
  process.stdout.write(`${'setting'.padEnd(w0)}  ${'value'.padEnd(w1)}  source\n`);
  for (const r of rows) process.stdout.write(`${r[0]!.padEnd(w0)}  ${r[1]!.padEnd(w1)}  ${r[2]}\n`);
  process.stdout.write(`\nsandbox level: ${level}${level === 'none' ? ' (no sandbox-exec: cwd confinement, env scrubbing, timeout, output cap and tree kill only; .git/config and .git/hooks are writable by commands)' : ' (writes confined to the workspace and run dirs; harness secret files, ~/.ssh, ~/.aws unreadable; reads elsewhere and network allowed unless --no-network)'}\n`);
  return 0;
}

async function commandBench(flags: ParsedFlags): Promise<number> {
  const { runBenchFromFlags } = await import('../bench/cli.js');
  return runBenchFromFlags(flags);
}

async function commandPerf(flags: ParsedFlags): Promise<number> {
  const { runPerf } = await import('../perf/main.js');
  return runPerf(flags);
}

export async function main(argv: string[]): Promise<number> {
  let flags: ParsedFlags;
  try {
    flags = parseCliArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${usageText()}\n`);
    return EXIT_CODES.config;
  }
  if (flags.help) {
    process.stdout.write(`${usageText()}\n`);
    return 0;
  }
  if (flags.version) {
    process.stdout.write(`jevcode ${VERSION}\n`);
    return 0;
  }
  switch (flags.command) {
    case 'run':
      return commandRun(flags);
    case 'config':
      return commandConfig(flags);
    case 'bench':
      return commandBench(flags);
    case 'perf':
      return commandPerf(flags);
  }
}

function fatalExit(e: unknown): never {
  const err = isJevCodeError(e) ? e : new JevCodeError('internal', e instanceof Error ? e.message : String(e), { cause: e });
  process.stderr.write(`jevcode: ${err.message}\n`);
  if (process.env['JEVCODE_DEBUG'] === '1' && e instanceof Error && e.stack) process.stderr.write(`${e.stack}\n`);
  process.exit(err.exitCode);
}

process.on('unhandledRejection', fatalExit);
process.on('uncaughtException', fatalExit);

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => fatalExit(e),
);

export { fingerprint as _fingerprintForTests };
