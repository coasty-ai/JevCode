/**
 * CLI entry (DESIGN.md §3.1, §6 first line, §11, §12; TUI-DESIGN §1, §13.4, §15.2 `cli/main.tsx` row, §17).
 *
 * Ordering contract (§1, §12): for `chat` and `run` the renderer's first frame is committed from argv, env, `isTTY`
 * and `cwd` alone — `resolveConfig`, the task file, stdin, the runs dir and git are touched only after
 * `renderer.firstFrame()` resolves, inside the session controller (`cli/session.ts`). `render()`'s mount-time options
 * come from `resolveLaunchSettings(flags, process.env)` (flag > env > default, no file). SIGINT/SIGTERM handlers are
 * installed before the first frame (research 20 item 2): with a controller they become `abort('signal', { signal })`
 * or an idle exit 130/143; before one exists the process restores the terminal, prints the one-line epilogue and exits.
 * The fatal path is `cli/fatal.ts`'s `fatalExit` (redacted epilogue, terminal restored first). Heavy modules
 * (providers, Jev client, Ink, bench, perf, the new commands) are dynamic imports; `--help`, `--version [--json]` and
 * `completion` answer before any Ink import (§17 item 3; `src/tui/terminal.ts` is imported statically for the one
 * process-wide `restoreTerminal()` — it imports no Ink at runtime, only `node:fs` and a type).
 */
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_INPUT_NEEDS_TASK, parseCliArgs, usageText } from './args.js';
import type { Command, ParsedFlags } from './args.js';
import { EXIT_CODES, UsageError } from '../errors.js';
import type { Engine, Renderer, RendererOptions, SignalName } from '../core/types.js';
import { patternRedact } from '../core/redact.js';
import { exitCodeFor } from '../loop/stop.js';
import { resolveLaunchSettings } from '../config/launch.js';
import { SETTINGS, configDirsFor } from '../config/defaults.js';
import { VERSION } from '../version.js';
import { epilogueLines, type EpilogueContext } from './epilogue.js';
import { wireFatalHandlers, type FatalWiring } from './fatal.js';
import { INK_VERSION, REACT_VERSION } from './report.js';
import { restoreTerminal } from '../tui/terminal.js';
// TUI-DESIGN-5 §5.5 (R2): ONE `gitRootOf` for both import sinks — `/import` (src/tui/App.tsx) binds this module
// too, so the session and the CLI can never plan different project scopes. Pure, `existsSync` only, no spawn, so
// it stays legal on the argv path (gate G-R5-1).
import { gitRootOf } from '../tui/import/git-root.js';
/**
 * TUI-DESIGN-5 §2.1 rule 6 / gate G-R5-1: `src/session/coordination.ts` has **zero value imports** of its own
 * (`test/unit/cli/sessions.test.ts` pins that), so naming it here is a static edge to a leaf of pure strings and
 * predicates — it reaches nothing under `src/coordination/**`, which stays behind the one `await import()` in
 * `openCoordination()`.
 */
import { settingReader } from '../session/coordination.js';
import { createSessionController, isInCi, isInteractive, jevcodeDir, sessionsIndexPath, type Prompter, type PromptingRenderer, type RendererKind, type SessionController } from './session.js';
import type { JsonStream } from './json-stream.js';
import type { ReadlineComposer } from '../tui/plain-composer.js';
import type { TuiRenderer } from '../tui/index.js';
import { createTuiPrompter, type TuiPrompterBundle } from './tui-prompter.js';

/** the process facts the §1 rule reads; probed once in `main`, injected in tests */
export interface LaunchFacts {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  env: NodeJS.ProcessEnv;
}

/**
 * TUI-DESIGN-4 §2.8 (P-R10): **why** the §1 `interactive` rule said no. PROBED: `TERM=dumb jevcode chat` becomes
 * `jevcode: missing task text` (exit 2) and the word `TERM` never appears anywhere in the output, so the user is told
 * their command is malformed when in fact their terminal was refused. `'flag'` covers `--plain` / `--json` /
 * `--no-input`; `null` means the renderer is interactive and nothing was refused.
 */
export type RendererRefusal = 'dumb' | 'ci' | 'stdin-not-tty' | 'stdout-not-tty' | 'flag';

export interface RendererSelection {
  kind: RendererKind;
  /** TUI-DESIGN §1: `session` needs a composer (Ink or readline); everything else is one-shot */
  mode: 'session' | 'one-shot';
  /** a `--plain` TTY readline composer (it owns SIGINT, §14.2) */
  readline: boolean;
  /** the §1 `interactive` rule (an Ink composer) */
  interactive: boolean;
  /** TUI-DESIGN-4 §2.8 (P-R10): the first clause of the §1 rule that failed, in the rule's own order; `null` when interactive */
  reason: RendererRefusal | null;
}

/**
 * TUI-DESIGN-4 §1.3.1 / §8 item 6 — `wanted = launch.renderer ?? ui.renderer ?? 'classic'`, the file layer.
 *
 * `--fullscreen`, `--renderer` and `JEVCODE_RENDERER` reach `createTuiRenderer` through `LaunchSettings`, but
 * `ui.renderer` in the config file does not: `resolveUiConfig` runs long after `render()`, and Ink fixes
 * `alternateScreen` in its constructor. Without this, `/fullscreen` — which persists exactly that row and then
 * says "fullscreen is set for the next launch" — promised something the relaunch did not deliver.
 *
 * §1's "the first frame comes from argv, env, isTTY and cwd only" forbids `resolveConfig` here (network-free but
 * async, dotenv chains, the extra .env file). This is **one guarded synchronous read of one key** from the same candidate
 * files `resolveConfig` consults, in the same order, and it is skipped entirely when a flag or the environment
 * already named the renderer. Any error — missing file, bad JSON, wrong type, unreadable directory — is
 * `undefined`, i.e. classic: a broken config file must never stop the session from starting.
 */
export function rendererFromConfigFile(io: { env: NodeJS.ProcessEnv; home: string; cwd: string; configFlag?: string | null }): 'classic' | 'fullscreen' | undefined {
  const spec = SETTINGS.find((sp) => sp.name === 'ui.renderer');
  const key = spec?.fileKey;
  if (key === undefined) return undefined;
  const flag = io.configFlag?.trim();
  const envPath = io.env['JEVCODE_CONFIG']?.trim();
  const candidates = flag
    ? [resolvePath(io.cwd, flag)]
    : envPath
      ? [resolvePath(io.cwd, envPath)]
      : [resolvePath(io.cwd, 'jevcode.json'), ...configDirsFor(io.home, io.env).map((d) => resolvePath(d, 'config.json'))];
  for (const path of candidates) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue; // absent or unreadable: the next candidate, exactly as resolveConfig walks them
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
      const v = (parsed as Record<string, unknown>)[key];
      return v === 'fullscreen' || v === 'classic' ? v : undefined;
    } catch {
      return undefined; // a config file that does not parse is `resolveConfig`'s error to report, not the renderer's
    }
  }
  return undefined;
}

/**
 * TUI-DESIGN-4 §2.8 (P-R10): the first clause of the §1 `interactive` rule that is false, evaluated in the rule's
 * order (`stdin.isTTY && stdout.isTTY && !isInCi && TERM !== 'dumb' && !plain && !json && !noInput`), so the message
 * names the thing the user can most plausibly change. Pure.
 */
export function rendererRefusal(flags: ParsedFlags, facts: LaunchFacts): RendererRefusal | null {
  if (!facts.stdinIsTTY) return 'stdin-not-tty';
  if (!facts.stdoutIsTTY) return 'stdout-not-tty';
  if (isInCi(facts.env)) return 'ci';
  if (facts.env['TERM'] === 'dumb') return 'dumb';
  if (flags.plain === true || flags.json === true || flags.noInput === true) return 'flag';
  return null;
}

/** TUI-DESIGN-4 §2.8 / §12: the sentence that names the refusal, with `TERM` spelled out when that is the cause. */
export function rendererRefusalLine(reason: RendererRefusal, env: NodeJS.ProcessEnv = process.env): string {
  const head = 'jevcode: chat needs an interactive terminal';
  switch (reason) {
    case 'dumb':
      return `${head}; this one reports TERM=${env['TERM'] ?? 'dumb'}, so the plain renderer is used.`;
    case 'ci':
      return `${head}; CI is set, so the plain renderer is used.`;
    case 'stdin-not-tty':
      return `${head}; stdin is not a terminal, so the plain renderer is used.`;
    case 'stdout-not-tty':
      return `${head}; stdout is not a terminal, so the plain renderer is used.`;
    case 'flag':
      return `${head}; a flag asked for the plain renderer.`;
  }
}

/**
 * TUI-DESIGN-4 §2.8 / §12: the three ways out, printed under `rendererRefusalLine` by the usage error at
 * `src/cli/session.ts:325–327` (S3's file, §9.2). The `TERM` row is only offered when `TERM` is the cause.
 */
export function rendererRefusalFixes(reason: RendererRefusal): string[] {
  const rows = [`· run 'jevcode chat --plain' for the line renderer`, `· or 'jevcode run "<task>"' for a one-shot run`];
  if (reason === 'dumb') rows.push('· or set a real TERM (e.g. TERM=xterm-256color)');
  return rows;
}

/** TUI-DESIGN-4 §2.8 (P-R10): the whole refusal message — the sentence plus its ways out, one per row. */
export function rendererRefusalRows(reason: RendererRefusal, env: NodeJS.ProcessEnv = process.env): string[] {
  return [rendererRefusalLine(reason, env), ...rendererRefusalFixes(reason)];
}

/**
 * TUI-DESIGN §1 table: `--json` → the NDJSON renderer (non-interactive); the §1 `interactive` rule → Ink; else the
 * plain renderer, with a readline composer on a TTY that is neither `--no-input`, `CI` nor `TERM=dumb`. `chat` is a
 * session only when a composer exists; `chat` on a pipe reads its task like `run` and exits at `run:end`. Pure.
 */
export function selectRenderer(flags: ParsedFlags, command: 'chat' | 'run', facts: LaunchFacts): RendererSelection {
  const interactive = isInteractive({ stdinIsTTY: facts.stdinIsTTY, stdoutIsTTY: facts.stdoutIsTTY, env: facts.env, flags });
  const kind: RendererKind = flags.json === true ? 'json' : interactive ? 'tui' : 'plain';
  const readline = kind === 'plain' && facts.stdinIsTTY && facts.stdoutIsTTY && flags.noInput !== true && !isInCi(facts.env) && facts.env['TERM'] !== 'dumb';
  const mode: RendererSelection['mode'] = command === 'chat' && (interactive || readline) ? 'session' : 'one-shot';
  // TUI-DESIGN-4 §2.8 (P-R10): carry *why*, so `chat` on a refused terminal never reports `missing task text`
  return { kind, mode, readline, interactive, reason: interactive ? null : rendererRefusal(flags, facts) };
}

/** TUI-DESIGN §17 item 3: `--version --json` — `{ name, version, node, ink, react, bundle }` (the two inlined runtime deps are named, §17 item 1). */
export function versionJson(bundle: string = fileURLToPath(import.meta.url)): { name: string; version: string; node: string; ink: string; react: string; bundle: string } {
  return { name: 'jevcode', version: VERSION, node: process.version, ink: INK_VERSION, react: REACT_VERSION, bundle };
}

/**
 * The task of a one-shot run: argv, `--task-file`, or piped stdin (read after the first frame); null on a TTY with
 * nothing to read (the controller reports the usage error). An unreadable `--task-file` is a usage error (exit 2) with
 * the path and the `ENOENT`/`EACCES`/`EISDIR` code, never a raw exception.
 */
export async function readTask(flags: ParsedFlags, facts: Pick<LaunchFacts, 'stdinIsTTY'>, stdin: NodeJS.ReadableStream = process.stdin): Promise<string | null> {
  if (flags.task) return flags.task;
  if (flags.taskFile) {
    const path = resolvePath(flags.taskFile);
    try {
      return readFileSync(path, 'utf8').trim();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e));
      throw new UsageError(`--task-file: cannot read ${path}: ${code}`);
    }
  }
  if (!facts.stdinIsTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text) return text;
  }
  return null;
}

/**
 * TUI-DESIGN §24 header of the argv-only first frame: `jevcode task: <task>` from argv, `task from <file>` for
 * `--task-file` (the file is read only after `firstFrame()`, so its name stands in), `resuming <id>` for `--resume`,
 * and the session header (empty task) otherwise.
 */
export function firstFrameTask(flags: Pick<ParsedFlags, 'task' | 'taskFile' | 'resume'>): string {
  if (flags.task !== undefined && flags.task !== '') return flags.task;
  if (flags.taskFile !== undefined && flags.taskFile !== '') return `task from ${basename(flags.taskFile)}`;
  if (flags.resume !== undefined && flags.resume !== '') return `resuming ${flags.resume}`;
  return '';
}

/** `JEVCODE_TRACE=<file>`: launch checkpoints (never a key or a draft; §10.6) */
function trace(msg: string): void {
  const file = process.env['JEVCODE_TRACE'];
  if (file === undefined || file === '') return;
  try {
    appendFileSync(file, `${new Date().toISOString()} main.${msg} t=${performance.now().toFixed(1)}\n`);
  } catch {
    /* trace only */
  }
}

/** mutable references the fatal wiring reads at fault time (the controller and renderer exist only later) */
interface FatalRefs {
  engine: () => Engine | null;
  unmount: (() => Promise<void>) | null;
  context: () => EpilogueContext;
  redact: (s: string) => string;
}

const fatalRefs: FatalRefs = {
  engine: () => null,
  unmount: null,
  context: () => ({ runId: null, runDir: null, resumable: false }),
  redact: patternRedact,
};

let wiring: FatalWiring | null = null;

/**
 * install the fatal handlers once (idempotent). TUI-DESIGN §14.2: `restore` is the one process-wide `restoreTerminal()`
 * of `src/tui/terminal.ts` — the same instance the Ink mount's hygiene, `unmount()` and the `'exit'` hook use — so the exit
 * string (`RESTORE`, `CSI 0 SP q`) is written exactly once per exit whichever path runs first (fatalExit, the controller's
 * `finishSession`, the engine's forced exit, SIGTSTP). A second `createRestoreTerminal` here wrote it twice. Exported for
 * the wiring test (`main.test.ts` asserts the identity and the once-only write through `setProcessRestore`).
 */
export function ensureWiring(): FatalWiring {
  wiring ??= wireFatalHandlers({
    redact: (s) => fatalRefs.redact(s),
    context: () => fatalRefs.context(),
    engine: () => fatalRefs.engine(),
    unmount: () => fatalRefs.unmount?.() ?? Promise.resolve(),
    restore: restoreTerminal,
  });
  return wiring;
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

/**
 * TUI-DESIGN §1: `chat` and `run` share one controller (`createSessionController`, `mode` `session` | `one-shot`).
 * The renderer mounts first (argv-only frame); the signal handlers precede it; everything else happens inside
 * `controller.run()` after `firstFrame()` resolves.
 */
async function startSession(flags: ParsedFlags, command: 'chat' | 'run'): Promise<number> {
  const env = process.env;
  const cwd = process.cwd();
  const facts: LaunchFacts = { stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY), env };
  if (command === 'chat' && flags.noInput) throw new UsageError(NO_INPUT_NEEDS_TASK);
  const sel = selectRenderer(flags, command, facts);
  const launchBase = resolveLaunchSettings(flags, env);
  // §1.3.1: the config file's `ui.renderer` is the last layer of `wanted`, below the flag and the variable, and it
  // is read only when neither of those named one — otherwise `/fullscreen`'s "set for the next launch" is a lie.
  const fileRenderer = sel.kind === 'tui' && launchBase.renderer === undefined ? rendererFromConfigFile({ env, home: homedir(), cwd, configFlag: flags.config ?? null }) : undefined;
  const launch = fileRenderer === undefined ? launchBase : { ...launchBase, renderer: fileRenderer };
  const fatal = ensureWiring();

  // TUI-DESIGN §14.2 / research 20 item 2: SIGINT and SIGTERM are handled before the first frame
  let controller: SessionController | null = null;
  const earlyExit = (name: SignalName): void => {
    const code = exitCodeFor('signal', undefined, false, name);
    fatal.restore();
    process.stderr.write(`${epilogueLines(null, { runId: null, runDir: null, resumable: false, stopReason: 'signal', signal: name, exitCode: code }, patternRedact).join('\n')}\n`);
    process.exit(code);
  };
  const onSignal = (name: SignalName): void => {
    trace(`signal ${name} controller=${controller !== null}`);
    if (controller) controller.signal(name);
    else earlyExit(name);
  };
  const sigint = (): void => onSignal('SIGINT');
  const sigterm = (): void => onSignal('SIGTERM');
  // §14.2: on a --plain TTY the readline composer owns SIGINT (cooked mode delivers Ctrl-C as the signal)
  if (!sel.readline) process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);

  // the first frame comes from argv, env, isTTY and cwd only (§1)
  const rendererOpts: RendererOptions = {
    task: firstFrameTask(flags),
    resumeId: flags.resume ?? null,
    onAbort: (reason) => controller?.onAbort(reason),
    mode: sel.mode,
    launch,
  };
  let renderer: Renderer;
  let prompter: Prompter | null = null;
  let jsonStream: JsonStream | null = null;
  let tuiBundle: TuiPrompterBundle | null = null;
  if (sel.kind === 'json') {
    const { writeJsonStream, createJsonRenderer } = await import('./json-stream.js');
    jsonStream = writeJsonStream({ out: process.stdout, version: VERSION, verbose: flags.jsonVerbose === true, redact: (s) => controller?.redact(s) ?? patternRedact(s) });
    renderer = createJsonRenderer({ ...rendererOpts, stream: jsonStream });
  } else if (sel.kind === 'tui') {
    // the Ink renderer's modal prompts (wizard, trust, follow-up, undo, exit confirm, blocking pane, picker) as the controller's Prompter
    tuiBundle = createTuiPrompter();
    const dir = jevcodeDir(env, homedir(), cwd);
    const tui: TuiRenderer = (await import('../tui/App.js')).createTuiRenderer({ ...rendererOpts, cwd, env, home: homedir(), runsDir: flags.runsDir !== undefined ? resolvePath(cwd, flags.runsDir) : resolvePath(dir, 'runs'), wizardHost: tuiBundle.wizardHost });
    tuiBundle.attach(tui);
    renderer = tui;
    prompter = (tui as PromptingRenderer).prompts ?? tuiBundle.prompter;
  } else {
    const { createPlainRenderer } = await import('../tui/plain.js');
    renderer = createPlainRenderer({ ...rendererOpts, cwd, interactive: sel.readline });
  }
  fatalRefs.unmount = () => renderer.unmount();
  trace(`renderer ${sel.kind} mounted (mode ${sel.mode})`);

  if (flags.perfExitAfterFirstFrame) {
    await renderer.firstFrame();
    process.stderr.write(`FIRST_FRAME_MS=${performance.now().toFixed(1)}\n`);
    process.exit(0);
  }
  const lagProbe = flags.perfLagProbe ? startLagProbe() : null;

  controller = createSessionController({
    flags,
    env,
    cwd,
    mode: sel.mode,
    renderer,
    rendererKind: sel.kind,
    interactive: sel.interactive,
    // TUI-DESIGN-4 §2.8 (P-R10): `chat` refused a composer explains itself instead of reporting `missing task text`
    ...(command === 'chat' && sel.reason !== null ? { rendererRefusalRows: rendererRefusalRows(sel.reason, env) } : {}),
    launch,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    prompter,
    jsonStream,
    task: () => readTask(flags, facts),
    exit: (code) => process.exit(code),
    restoreTerminal: fatal.restore,
  });
  const c = controller;
  fatalRefs.engine = () => c.engine;
  fatalRefs.context = () => c.context();
  fatalRefs.redact = (s) => c.redact(s);
  tuiBundle?.control({
    persistCredentials: (patch, source, opts) => c.persistCredentials(patch, source, opts),
    mode: () => c.mode(),
    trustInputs: () => c.trustInputs(),
    sandboxLine: () => c.sandboxLine(),
    sandboxDetail: () => c.sandboxDetail(),
    runsDir: () => c.runsDir(),
    trashDir: () => resolvePath(jevcodeDir(env, homedir(), cwd), 'trash'),
    runLive: () => c.host.phase() !== 'none',
    // TUI-DESIGN-3 §1.5 / §1.4.3: the Ink wizard's `y` verifies through the controller; option `3 Jev only` persists / pends through it; the reuse Enter reads the resolved Jev key
    verifyKeys: (i) => c.verifyForWizard(i),
    applyMode: (mode, persist) => c.applyModeChoice(mode, persist),
    resolvedJevKey: () => c.resolvedJevKey(),
    resolvedJevSource: () => c.resolvedJevSource(),
  });

  // TUI-DESIGN §1: the --plain TTY readline composer over the same dispatchCommand(); its lines feed the confirmer and the prompts
  let composer: ReadlineComposer | null = null;
  if (sel.readline) {
    const { createReadlineComposer } = await import('../tui/plain-composer.js');
    const { createPlainPrompter } = await import('./session.js');
    composer = createReadlineComposer({
      input: process.stdin,
      output: process.stdout,
      stderr: process.stderr,
      host: c.host,
      phase: () => c.host.phase(),
      ranBefore: () => c.host.ranBefore(),
      dispatch: () => c.host.dispatchContext(),
      awaitRunEnd: () => c.host.awaitRunEnd(),
      // §1 session loop: the prompt returns after a run's post-run items; one-shot exits at run:end instead
      repromptAtRunEnd: sel.mode === 'session',
    });
    const plain = renderer as Renderer & { setLineSource?: (lines: ReadlineComposer['lines']) => void };
    plain.setLineSource?.(composer.lines);
    c.setPrompter(createPlainPrompter({ lines: composer.lines, stdout: process.stdout, stdin: process.stdin, ascii: launch.ascii }));
  }

  try {
    trace('controller.run');
    const code = await c.run();
    trace(`controller.run resolved ${code}`);
    if (lagProbe) process.stderr.write(`LAG_JSON=${JSON.stringify(lagProbe.stop())}\n`);
    return code;
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
    composer?.close();
  }
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
  const { configTableLines } = await import('./config-table.js');
  // TUI-DESIGN-3 §0.1 (D-Q): the `seen.*` bookkeeping rows print only under --all (`--json` above keeps the whole record)
  process.stdout.write(`${configTableLines(record, { sandboxLevel: level, ...(flags.all ? { all: true } : {}) }).join('\n')}\n`);
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

/** the resolved-config facts the maintenance commands need (runs dir, redactor, workspace); a broken config is exit 2 */
async function pathsFor(flags: ParsedFlags): Promise<{ runsDir: string; redact: (s: string) => string; workspace: string; record: () => unknown; sandbox: string; setting: (name: string) => string | undefined; secrets: () => Promise<ReadonlyMap<string, import('../core/types.js').Resolved<string>>> }> {
  const { resolveConfig } = await import('../config/resolve.js');
  const config = await resolveConfig(flags, process.env, process.cwd());
  let workspace = config.workspace;
  try {
    workspace = realpathSync(config.workspace);
  } catch {
    /* lexical */
  }
  return {
    runsDir: config.runsDir,
    redact: config.redact,
    workspace,
    record: () => config.record(),
    sandbox: config.sandbox,
    /**
     * TUI-DESIGN-5 §2.10 / §12.1: one non-secret setting through the whole config chain. `openCoordination` reads
     * `coordination.claims` (and `coordination.enabled`, the row a later build may add) through it to answer the
     * "off in this configuration" refusal by name. `settingReader` is that one reader (fix pass, finding 18): it
     * was exported and documented as this call site's, and both this file and `src/cli/session.ts` inlined the
     * lookup instead, so the `undefined`-is-on rule lived in three places and was pinned in none.
     */
    setting: settingReader(config.entries),
    // the two secrets, plus `decider.provider` (TUI-DESIGN-2 §2.3): `jevcode login` infers the Jev provider from the session's own
    // resolution (flag > JEV_PROVIDER > ./.env > <JEVCODE_EXTRA_ENV_FILE> > file > auto rules) so login and the session never disagree
    secrets: async () => {
      const m = new Map<string, import('../core/types.js').Resolved<string>>();
      for (const name of ['generator.apiKey', 'decider.apiKey', 'decider.provider'] as const) {
        const r = config.entries.get(name);
        if (r) m.set(name, r);
      }
      return m;
    },
  };
}

/** TUI-DESIGN §11.2 / TUI-DESIGN-2 §1.4 / TUI-DESIGN-3 §1.6: the `jevcode login` flags `commandLogin` receives — `--key-stdin` (one OpenRouter key for both), `--jev-provider typesafe|openrouter`, `--provider` and the two `--*-stdin` flags. Pure. */
export function loginFlagsFrom(flags: ParsedFlags): import('./login.js').LoginFlags {
  return {
    ...(flags.provider !== undefined ? { provider: flags.provider } : {}),
    ...(flags.jevProvider !== undefined ? { jevProvider: flags.jevProvider } : {}),
    ...(flags.keyStdin ? { keyStdin: true } : {}),
    ...(flags.generatorKeyStdin ? { generatorKeyStdin: true } : {}),
    ...(flags.jevKeyStdin ? { jevKeyStdin: true } : {}),
    ...(flags.status ? { status: true } : {}),
    ...(flags.verify ? { verify: true } : {}),
    ...(flags.config !== undefined ? { config: flags.config } : {}),
  };
}

/** the `login` / `logout` / `config set` I/O seam over the real process */
async function loginIo(flags: ParsedFlags): Promise<import('./login.js').CommandIo> {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    resolveSecrets: async () => {
      try {
        return await (await pathsFor(flags)).secrets();
      } catch {
        return new Map();
      }
    },
  };
}

/**
 * TUI-DESIGN-5 / round-5 item 8: `JEVCODE_JEV` is a BENCH AND PERF fault switch, not a product setting. Its one
 * production reader is `withJevOff` (`src/jev/off.ts`), wired at `src/bench/runner.ts` only, so setting it in a
 * shell and then running a product command changed nothing while reading as if it had — a keyed `jevcode run`
 * would make real Jev calls and spend real money under a variable the user believed had disabled them.
 *
 * The CLI therefore REFUSES to start, before any command runs and before any network, for every product command.
 * `bench` and `perf` are exempt: `npm run bench` / `npm run perf` set the variable themselves, which is the whole
 * supported way to use it.
 *
 * The value is echoed so the user can see WHICH stale export they are carrying, redacted to its first 16 code
 * points (`[...value]`, not `slice`, so an astral character is never cut in half). `--plain` and `--json` print
 * the identical two lines on stderr: a fatal that only the TUI renderer could show would be invisible in exactly
 * the pipes this switch gets set in.
 */
export const JEVCODE_JEV_ENV = 'JEVCODE_JEV';
export const JEVCODE_JEV_FIX = 'unset JEVCODE_JEV';
export function jevcodeJevRefusal(value: string): string {
  const shown = [...value].slice(0, 16).join('');
  return `JEVCODE_JEV is set ("${shown}") — it is a bench/perf fault switch, not a product setting; unset it, or run the bench and perf suites through npm run bench / npm run perf, which set it themselves`;
}
/** the two `[setup]` rows, in order, for the refusal block (one producer for the CLI and its tests). */
export function jevcodeJevRefusalRows(value: string): string[] {
  return [`[setup] ${jevcodeJevRefusal(value)}`, JEVCODE_JEV_FIX];
}
/** `null` when the command may run; the rows to print (exit 2) when it may not. */
export function jevcodeJevRefusalFor(command: Command, env: NodeJS.ProcessEnv): string[] | null {
  if (command === 'bench' || command === 'perf') return null;
  const value = env[JEVCODE_JEV_ENV];
  if (value === undefined) return null;
  return jevcodeJevRefusalRows(value);
}

export async function main(argv: string[]): Promise<number> {
  let flags: ParsedFlags;
  try {
    flags = parseCliArgs(argv, { stdinIsTTY: Boolean(process.stdin.isTTY) });
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${usageText()}\n`);
    return EXIT_CODES.config;
  }
  if (flags.help) {
    const first = argv[0];
    process.stdout.write(`${usageText(first !== undefined && !first.startsWith('-') ? flags.command : undefined)}\n`);
    return 0;
  }
  if (flags.version) {
    process.stdout.write(flags.json ? `${JSON.stringify(versionJson())}\n` : `jevcode ${VERSION}\n`);
    return 0;
  }
  // round-5 item 8: before any command runs and before any network (see `jevcodeJevRefusalFor`)
  const jevRefusal = jevcodeJevRefusalFor(flags.command, process.env);
  if (jevRefusal !== null) {
    process.stderr.write(`${jevRefusal.join('\n')}\n`);
    return EXIT_CODES.config;
  }
  switch (flags.command) {
    case 'chat':
      return startSession(flags, 'chat');
    case 'run':
      return startSession(flags, 'run');
    case 'config': {
      if (flags.configSet) {
        const { commandConfigSet } = await import('./login.js');
        return commandConfigSet(flags.configSet.setting, flags.configSet.value, await loginIo(flags), flags.config !== undefined ? { config: flags.config } : {});
      }
      return commandConfig(flags);
    }
    case 'bench':
      return commandBench(flags);
    case 'perf':
      return commandPerf(flags);
    case 'login': {
      const { commandLogin } = await import('./login.js');
      return commandLogin(loginFlagsFrom(flags), await loginIo(flags));
    }
    case 'logout': {
      const { commandLogout } = await import('./login.js');
      return commandLogout({ ...(flags.generator ? { generator: true } : {}), ...(flags.jev ? { jev: true } : {}), ...(flags.config !== undefined ? { config: flags.config } : {}) }, await loginIo(flags));
    }
    case 'sessions': {
      const { commandSessions, openCoordination, sessionsVerbNeedsCoordination, sessionsVerbOf } = await import('./sessions.js');
      const p = await pathsFor(flags);
      const launch = resolveLaunchSettings(flags, process.env);
      const home = jevcodeDir(process.env, homedir(), process.cwd());
      /**
       * TUI-DESIGN-5 §2.10, gap 1 (`docs/STATUS.md` "Not driven by a store in this build" item 1): the thirteen
       * coordination verbs get a **real** `SessionsCoordination` over the ledger under `JEVCODE_HOME`.
       *
       * Three properties of this call site, each load-bearing:
       *
       *  - `openCoordination` is reached through the SAME `await import('./sessions.js')` as `commandSessions`, and
       *    it loads `src/coordination/**` through one `await import()` of its own, so `main.tsx`'s static import
       *    list gains nothing and gate G-R5-1 holds (asserted by `test/unit/cli/sessions.test.ts`).
       *  - the four index verbs (`list`, `reindex`, `prune`, `unlock`) never open a ledger: they do not need one,
       *    and opening one would write this device's record for a verb that only reads `sessions/index.jsonl`.
       *  - a refusal is a **value**, never a throw: `off` carries the §12.1 sentence with the clause that names
       *    the cause, and `needCoord` prints it.
       */
      /**
       * Fix pass, finding 17: the gate and `commandSessions`' dispatch compute the verb with the SAME helper.
       * They used to disagree by an `?? io.verb` term — harmless today because nothing here sets `io.verb`, but
       * the seam is documented as the way the thirteen verbs are reached, and the first caller to use it would
       * have got a coordination verb with no ledger AND no reason string.
       */
      const verb = sessionsVerbOf(flags);
      const opened = sessionsVerbNeedsCoordination(verb) ? await openCoordination({ home, workspace: p.workspace, hostname: hostname(), username: userInfo().username, jevcode: VERSION, pid: process.pid, redact: p.redact, read: p.setting }) : null;
      return commandSessions(flags, {
        stdout: process.stdout,
        stderr: process.stderr,
        runsDir: p.runsDir,
        indexPath: sessionsIndexPath(home),
        workspace: p.workspace,
        redact: p.redact,
        ascii: launch.ascii,
        // §12.1's SR column: `sessions who` renders `whoSentence` per row in the screen-reader set
        screenReader: launch.screenReader,
        ...(opened?.kind === 'open' ? { coordination: opened.coordination } : {}),
        // §13.3 (fix pass, finding 14): the sentence AND its machine-readable reason, so `--json` can carry it
        ...(opened?.kind === 'off' ? { coordinationOff: opened.message, coordinationOffReason: opened.reason } : {}),
        // TUI-DESIGN-5 §2.10: the words after the verb (a target, a message, `now`, `status|disable`)
        ...(flags.sessionsArgs !== undefined ? { args: flags.sessionsArgs } : {}),
      });
    }
    /**
     * TUI-DESIGN-5 §6.6 / §9.2 `cli/main.tsx`: one `await import()` of `src/cli/models.ts`, which is the only way
     * `src/models/**` is ever reached — the static import list at the top of this file gains **nothing** (§2.1
     * rule 3a, gate G-R5-1). `case 'import':` (R5-5) and `case 'agents':` (R5-4) join it in the same shape.
     */
    case 'models': {
      const { commandModels } = await import('./models.js');
      return commandModels(flags, { stdout: process.stdout, stderr: process.stderr, env: process.env, ascii: resolveLaunchSettings(flags, process.env).ascii });
    }
    /**
     * TUI-DESIGN-5 §5.5 (R5-5) and §4.2 (R5-4): the two remaining `switch` arms of §9.2's `cli/main.tsx` row,
     * each an `await import()` of its own `src/cli/<verb>.ts` — the static import list at the top of this file
     * gains nothing, which is what keeps `src/import/**` and `src/orchestrate/**` off the argv path (G-R5-1).
     */
    case 'import': {
      const { commandImport } = await import('./import.js');
      const p = await pathsFor(flags);
      const launch = resolveLaunchSettings(flags, process.env);
      return commandImport(
        {
          ...(flags.dryRun === true ? { dryRun: true } : {}),
          ...(flags.yes === true ? { yes: true } : {}),
          ...(flags.scope !== undefined ? { scope: flags.scope } : {}),
          ...(flags.source !== undefined ? { source: flags.source } : {}),
          ...(flags.resume !== undefined ? { resume: flags.resume } : {}),
          ...(flags.undo !== undefined ? { undo: flags.undo } : {}),
          ...(flags.json === true ? { json: true } : {}),
          ...(flags.plain === true ? { plain: true } : {}),
          ...(launch.screenReader ? { screenReader: true } : {}),
          ...(launch.ascii ? { ascii: true } : {}),
          ...(flags.noInput === true ? { noInput: true } : {}),
        },
        {
          stdout: process.stdout,
          stderr: process.stderr,
          isTTY: process.stdout.isTTY === true,
          ...(typeof process.stdout.columns === 'number' ? { columns: process.stdout.columns } : {}),
          ascii: launch.ascii,
          screenReader: launch.screenReader,
          jevcodeDir: jevcodeDir(process.env, homedir(), process.cwd()),
          workspaceKey: p.workspace,
          /**
           * TUI-DESIGN-5 §5.5: what `planImport` needs beyond the flags, and the CALLER owns every one — the
           * engine reads no ambient state. `trust: 'none'` is the CLI's honest default (a run's trust decision
           * is the session's, not this verb's), `decider: null` disables the Jev grouping pass so
           * `jevcode import` is **free and offline**, and the code fallbacks still produce a complete plan
           * (§4.9). Without this the engine dereferences `opts.env.workspace` and the verb dies on its first
           * line, which is how the integration pass found it.
           */
          planOptions: {
            env: { home: homedir(), env: process.env, platform: process.platform, workspace: p.workspace, gitRoot: gitRootOf(p.workspace), extraRoots: [] },
            jevcodeVersion: VERSION,
            trust: 'none',
            decider: null,
            // TUI-DESIGN-5 §5.4 item 1 (R1): the CONFIGURED-secret layer. `planImport`'s default redactor is
            // `redactSecrets(s, undefined)` — the 15 pattern families only — so a `config.addSecret` value that
            // matches no family survives into `PlanRow.why`, the warnings and the report. `pathsFor` already
            // returns the session's redactor; the TUI twin passes exactly the same thing.
            redact: p.redact,
          },
        },
      );
    }
    case 'agents': {
      const { runAgents } = await import('./agents.js');
      const p = await pathsFor(flags);
      return runAgents(flags.sessionsArgs ?? [], {
        stdout: process.stdout,
        stderr: process.stderr,
        runsDir: p.runsDir,
        ascii: resolveLaunchSettings(flags, process.env).ascii,
      }, { ...(flags.json === true ? { json: true } : {}) });
    }
    case 'doctor': {
      const { commandDoctor, defaultDoctorIo } = await import('./doctor.js');
      return commandDoctor(flags, await defaultDoctorIo(flags));
    }
    case 'report': {
      const { commandReport, newestSessionLog } = await import('./report.js');
      const dir = jevcodeDir(process.env, homedir(), process.cwd());
      return commandReport(flags, {
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
        cwd: process.cwd(),
        resolveConfig: async (f) => {
          const p = await pathsFor(f);
          return { runsDir: p.runsDir, redact: p.redact, record: p.record, sandbox: p.sandbox };
        },
        reportsDir: resolvePath(dir, 'reports'),
        // §13.6: the session log stands in when the run directory has no jevcode.log
        sessionLog: () => newestSessionLog(resolvePath(dir, 'logs')),
      });
    }
    case 'why': {
      const { commandWhy } = await import('./inspect.js');
      const p = await pathsFor(flags);
      return commandWhy(flags, { stdout: process.stdout, stderr: process.stderr, runsDir: p.runsDir, ascii: resolveLaunchSettings(flags, process.env).ascii });
    }
    case 'calibration': {
      const { commandCalibration } = await import('./inspect.js');
      const p = await pathsFor(flags);
      return commandCalibration(flags, { stdout: process.stdout, stderr: process.stderr, runsDir: p.runsDir, ascii: resolveLaunchSettings(flags, process.env).ascii });
    }
    case 'completion': {
      const { commandCompletion } = await import('./completion.js');
      return commandCompletion(flags.shell ?? 'bash', process.stdout);
    }
    case 'upgrade': {
      const { commandUpgrade } = await import('./upgrade.js');
      let argv1 = process.argv[1] ?? '';
      try {
        argv1 = realpathSync(argv1);
      } catch {
        /* keep the raw path */
      }
      return commandUpgrade(flags, { stdout: process.stdout, stderr: process.stderr, env: process.env, home: homedir(), argv1 });
    }
  }
}

const isEntry = ((): boolean => {
  const arg1 = process.argv[1];
  if (arg1 === undefined) return false;
  try {
    return realpathSync(arg1) === fileURLToPath(import.meta.url) || /\/dist\/jevcode\.mjs$/.test(fileURLToPath(import.meta.url)) || /bin\/jevcode\.js$/.test(arg1);
  } catch {
    return /bin\/jevcode\.js$/.test(arg1) || /\/dist\/jevcode\.mjs$/.test(fileURLToPath(import.meta.url));
  }
})();

if (isEntry) {
  const fatal = ensureWiring();
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      void fatal.fatalExit(e);
    },
  );
}
