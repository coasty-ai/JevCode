/**
 * The one flag list (DESIGN.md §3.1). `parseCliArgs` turns argv into a typed `ParsedFlags`
 * that `resolveConfig` consumes; nothing here reads files, env or stdin, so the first TUI
 * frame can render before any of that happens (§12).
 */
import { parseArgs } from 'node:util';
import { ConfigError, UsageError } from '../errors.js';
import { parseDuration } from '../core/time.js';

export type Command = 'run' | 'config' | 'bench' | 'perf';
export const COMMANDS: readonly Command[] = ['run', 'config', 'bench', 'perf'];

/** Flags that take a value. Kept as strings: validation happens in config/validate.ts, where env and file sources share the same code path. */
export const STRING_FLAGS = [
  'provider',
  'model',
  'apiKey',
  'baseUrl',
  'temperature',
  'maxTokens',
  'jevBaseUrl',
  'jevApiKey',
  'jevModel',
  'spendCap',
  'maxSteps',
  'maxWall',
  'maxReplans',
  'completeThreshold',
  'impossibleThreshold',
  'workspace',
  'runsDir',
  'openAssistPath',
  'config',
  'sandbox',
  'taskFile',
  'resume',
  'mode',
  'condition',
  'suite',
  'tasks',
  'taskId',
  'conditions',
  'concurrency',
  'taskSpendCap',
  'out',
  'mockSteps',
] as const;

export const BOOLEAN_FLAGS = ['noNetwork', 'plain', 'force', 'perfExitAfterFirstFrame', 'json', 'live', 'allowModelAlias', 'help', 'version', 'mock', 'mockGenerator', 'perfLagProbe'] as const;

export type StringFlagKey = (typeof STRING_FLAGS)[number];
export type BooleanFlagKey = (typeof BOOLEAN_FLAGS)[number];

export interface ParsedFlags extends Partial<Record<StringFlagKey, string>>, Partial<Record<BooleanFlagKey, boolean>> {
  command: Command;
  /** `run` positional task text (all positionals after the command, space-joined). */
  task?: string;
  /** `--max-wall` parsed through core/time.ts at parse time so a typo fails before anything else runs. */
  maxWallMs?: number;
}

interface FlagSpec {
  key: StringFlagKey | BooleanFlagKey;
  name: string;
  type: 'string' | 'boolean';
  commands: readonly Command[];
  arg?: string;
  help: string;
  hidden?: boolean;
}

const ALL: readonly Command[] = COMMANDS;
const RUN: readonly Command[] = ['run'];
const BENCH: readonly Command[] = ['bench'];
const RUN_BENCH_PERF: readonly Command[] = ['run', 'bench', 'perf', 'config'];

/** Common flags are accepted by every command: `config` needs them to print what a run would resolve to. */
export const FLAGS: readonly FlagSpec[] = [
  { key: 'provider', name: 'provider', type: 'string', commands: RUN_BENCH_PERF, arg: 'anthropic|openrouter', help: 'generator provider' },
  { key: 'model', name: 'model', type: 'string', commands: RUN_BENCH_PERF, arg: '<id>', help: 'generator model id' },
  { key: 'apiKey', name: 'api-key', type: 'string', commands: RUN_BENCH_PERF, arg: '<key>', help: 'generator API key (prefer the env var)' },
  { key: 'baseUrl', name: 'base-url', type: 'string', commands: RUN_BENCH_PERF, arg: '<url>', help: 'generator base URL' },
  { key: 'temperature', name: 'temperature', type: 'string', commands: RUN_BENCH_PERF, arg: '<t>', help: 'generator temperature (unset = not sent)' },
  { key: 'maxTokens', name: 'max-tokens', type: 'string', commands: RUN_BENCH_PERF, arg: '<n>', help: 'generator max output tokens' },
  { key: 'jevBaseUrl', name: 'jev-base-url', type: 'string', commands: RUN_BENCH_PERF, arg: '<url>', help: 'decider (Jev) base URL' },
  { key: 'jevApiKey', name: 'jev-api-key', type: 'string', commands: RUN_BENCH_PERF, arg: '<key>', help: 'decider API key (prefer the env var)' },
  { key: 'jevModel', name: 'jev-model', type: 'string', commands: RUN_BENCH_PERF, arg: '<id>', help: 'decider model id (dated id pins it)' },
  { key: 'spendCap', name: 'spend-cap', type: 'string', commands: RUN_BENCH_PERF, arg: '<usd>', help: 'spend cap in USD (bench: total for the bench)' },
  { key: 'maxSteps', name: 'max-steps', type: 'string', commands: RUN_BENCH_PERF, arg: '<n>', help: 'max steps per run' },
  { key: 'maxWall', name: 'max-wall', type: 'string', commands: RUN_BENCH_PERF, arg: '<dur>', help: 'max wall time per run, e.g. 30m, 7h30m, 90s' },
  { key: 'maxReplans', name: 'max-replans', type: 'string', commands: RUN_BENCH_PERF, arg: '<n>', help: 'max replans per run' },
  { key: 'completeThreshold', name: 'complete-threshold', type: 'string', commands: RUN_BENCH_PERF, arg: '<p>', help: 'completion probability threshold' },
  { key: 'impossibleThreshold', name: 'impossible-threshold', type: 'string', commands: RUN_BENCH_PERF, arg: '<p>', help: 'task-impossible probability threshold' },
  { key: 'workspace', name: 'workspace', type: 'string', commands: RUN_BENCH_PERF, arg: '<dir>', help: 'workspace directory (default: cwd)' },
  { key: 'runsDir', name: 'runs-dir', type: 'string', commands: RUN_BENCH_PERF, arg: '<dir>', help: 'run directory root (default: ~/.jevcode/runs)' },
  { key: 'openAssistPath', name: 'open-assist-path', type: 'string', commands: RUN_BENCH_PERF, arg: '<dir>', help: 'Open Assist checkout whose .env is a fallback' },
  { key: 'config', name: 'config', type: 'string', commands: RUN_BENCH_PERF, arg: '<file>', help: 'config file (default: ./jevcode.json, else ~/.config/jevcode/config.json)' },
  { key: 'sandbox', name: 'sandbox', type: 'string', commands: RUN_BENCH_PERF, arg: 'auto|seatbelt|none', help: 'sandbox profile' },
  { key: 'noNetwork', name: 'no-network', type: 'boolean', commands: RUN_BENCH_PERF, help: 'deny network to sandboxed commands' },
  { key: 'plain', name: 'plain', type: 'boolean', commands: RUN_BENCH_PERF, help: 'plain line renderer instead of the TUI' },
  { key: 'taskFile', name: 'task-file', type: 'string', commands: RUN, arg: '<path>', help: 'read the task text from a file' },
  { key: 'resume', name: 'resume', type: 'string', commands: ['run', 'bench'], arg: '<id>', help: 'run: resume <run-id>; bench: resume <bench-id>' },
  { key: 'force', name: 'force', type: 'boolean', commands: RUN, help: 'with --resume: resume a run whose stopReason is complete' },
  { key: 'perfExitAfterFirstFrame', name: 'perf-exit-after-first-frame', type: 'boolean', commands: RUN, help: 'exit after the first frame (perf)', hidden: true },
  { key: 'mode', name: 'mode', type: 'string', commands: RUN, arg: 'jev-on|jev-off|jev-only', help: 'engine mode: jev-on (default), jev-off (generator only), jev-only (no generating LLM)' },
  { key: 'condition', name: 'condition', type: 'string', commands: RUN, arg: 'jev-on|jev-off|jev-only', help: 'alias of --mode (Harbor adapter)', hidden: true },
  // Hidden run flags used by the wiring code and perf/*: mocked provider+decider, no network.
  { key: 'mock', name: 'mock', type: 'boolean', commands: RUN, help: 'mocked generator and decider (perf, smoke)', hidden: true },
  { key: 'mockSteps', name: 'mock-steps', type: 'string', commands: RUN, arg: '<n>', help: 'steps in the mocked trajectory', hidden: true },
  { key: 'mockGenerator', name: 'mock-generator', type: 'boolean', commands: RUN, help: 'mocked generator with the live decider (debugging)', hidden: true },
  { key: 'perfLagProbe', name: 'perf-lag-probe', type: 'boolean', commands: RUN, help: 'record event-loop lag (perf)', hidden: true },
  { key: 'json', name: 'json', type: 'boolean', commands: ['config'], help: 'print the resolved table as JSON' },
  { key: 'suite', name: 'suite', type: 'string', commands: BENCH, arg: 'swebench|terminal-bench|quixbugs|ladder|all', help: 'benchmark suite (quixbugs/ladder: the jev-only difficulty ladder)' },
  { key: 'tasks', name: 'tasks', type: 'string', commands: BENCH, arg: '<n>', help: 'number of tasks' },
  { key: 'taskId', name: 'task-id', type: 'string', commands: BENCH, arg: '<id>[,<id>...]', help: 'specific task ids' },
  { key: 'conditions', name: 'conditions', type: 'string', commands: BENCH, arg: 'jev-on,jev-off[,jev-only]', help: 'conditions to run (default jev-on,jev-off)' },
  { key: 'concurrency', name: 'concurrency', type: 'string', commands: BENCH, arg: '<n>', help: 'parallel runs' },
  { key: 'live', name: 'live', type: 'boolean', commands: ['bench', 'perf'], help: 'use the real generator and Jev (requires --spend-cap)' },
  { key: 'taskSpendCap', name: 'task-spend-cap', type: 'string', commands: BENCH, arg: '<usd>', help: 'per-run spend cap (default 2.00)' },
  { key: 'allowModelAlias', name: 'allow-model-alias', type: 'boolean', commands: BENCH, help: 'allow an undated --jev-model' },
  { key: 'out', name: 'out', type: 'string', commands: ['bench', 'perf'], arg: '<path>', help: 'bench: results dir; perf: results file' },
  { key: 'help', name: 'help', type: 'boolean', commands: ALL, help: 'show usage' },
  { key: 'version', name: 'version', type: 'boolean', commands: ALL, help: 'print the version' },
];

export const RUN_ID_RE = /^\d{8}-\d{6}-[a-z2-7]{8}$/;
export const SANDBOX_PROFILES = ['auto', 'seatbelt', 'none'] as const;
export const CONDITIONS = ['jev-on', 'jev-off', 'jev-only'] as const;
export const SUITES = ['swebench', 'terminal-bench', 'quixbugs', 'ladder', 'all'] as const;

function isCommand(s: string): s is Command {
  return (COMMANDS as readonly string[]).includes(s);
}

function optionsFor(command: Command): Record<string, { type: 'string' | 'boolean'; short?: string }> {
  const out: Record<string, { type: 'string' | 'boolean'; short?: string }> = {};
  for (const f of FLAGS) {
    if (!f.commands.includes(command)) continue;
    out[f.name] = f.key === 'help' ? { type: 'boolean', short: 'h' } : f.key === 'version' ? { type: 'boolean', short: 'v' } : { type: f.type };
  }
  return out;
}

function usageHint(command: Command): string {
  return `Run 'jevcode ${command} --help' for usage.`;
}

function oneOf(command: Command, flag: string, value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) {
    throw new UsageError(`--${flag}: expected one of ${allowed.join('|')}, got "${value}". ${usageHint(command)}`);
  }
}

function positiveInteger(command: Command, flag: string, value: string): void {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new UsageError(`--${flag}: expected a positive integer, got "${value}". ${usageHint(command)}`);
  }
}

function positiveNumber(command: Command, flag: string, value: string): void {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || n <= 0) {
    throw new UsageError(`--${flag}: expected a positive number, got "${value}". ${usageHint(command)}`);
  }
}

/**
 * Parse argv (without the node and script entries). The first token must be the command; a
 * bare `--help`/`-h` is answered with `{ command: 'run', help: true }`.
 */
export function parseCliArgs(argv: readonly string[]): ParsedFlags {
  const first = argv[0];
  if (first === undefined) throw new UsageError(`missing command: expected one of ${COMMANDS.join('|')}.\n\n${usageText()}`);
  if (first === '--help' || first === '-h') return { command: 'run', help: true };
  if (first === '--version' || first === '-v') return { command: 'run', version: true };
  if (first.startsWith('-')) throw new UsageError(`the first argument must be a command (${COMMANDS.join('|')}), got "${first}". Run 'jevcode --help' for usage.`);
  if (!isCommand(first)) throw new UsageError(`unknown command "${first}": expected one of ${COMMANDS.join('|')}. Run 'jevcode --help' for usage.`);
  const command = first;

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv.slice(1), options: optionsFor(command), allowPositionals: true, strict: true });
  } catch (e) {
    // parseArgs reports unknown options, missing values and unexpected values as TypeErrors.
    const msg = e instanceof Error ? e.message : String(e);
    throw new UsageError(`${msg}. ${usageHint(command)}`);
  }

  const strings: Partial<Record<StringFlagKey, string>> = {};
  const booleans: Partial<Record<BooleanFlagKey, boolean>> = {};
  for (const f of FLAGS) {
    const v = parsed.values[f.name];
    if (v === undefined) continue;
    if (f.type === 'string' && typeof v === 'string') strings[f.key as StringFlagKey] = v;
    else if (f.type === 'boolean' && v === true) booleans[f.key as BooleanFlagKey] = true;
  }
  const flags: ParsedFlags = { command, ...strings, ...booleans };
  if (flags.help || flags.version) return flags;

  const positionals = parsed.positionals;
  if (command === 'run') {
    const task = positionals.join(' ').trim();
    if (task.length > 0) flags.task = task;
  } else if (positionals.length > 0) {
    throw new UsageError(`jevcode ${command} takes no positional arguments, got "${positionals.join(' ')}". ${usageHint(command)}`);
  }

  if (flags.maxWall !== undefined) {
    try {
      flags.maxWallMs = parseDuration(flags.maxWall, '--max-wall');
    } catch (e) {
      throw new UsageError(`${e instanceof ConfigError ? e.message : String(e)}. ${usageHint(command)}`);
    }
  }
  // Lowercased here so the args check and the config validator (which lowercases too) agree.
  if (flags.sandbox !== undefined) {
    flags.sandbox = flags.sandbox.trim().toLowerCase();
    oneOf(command, 'sandbox', flags.sandbox, SANDBOX_PROFILES);
  }
  if (flags.provider !== undefined) {
    flags.provider = flags.provider.trim().toLowerCase();
    oneOf(command, 'provider', flags.provider, ['anthropic', 'openrouter']);
  }

  if (command === 'run') {
    if (flags.task !== undefined && flags.taskFile !== undefined) {
      throw new UsageError(`give the task either as text or with --task-file, not both. ${usageHint(command)}`);
    }
    if (flags.resume !== undefined) {
      if (flags.task !== undefined || flags.taskFile !== undefined) {
        throw new UsageError(`--resume continues a stored run and takes no task text or --task-file. ${usageHint(command)}`);
      }
      if (!RUN_ID_RE.test(flags.resume)) {
        throw new UsageError(`--resume: "${flags.resume}" is not a run id (expected YYYYMMDD-HHMMSS-xxxxxxxx). ${usageHint(command)}`);
      }
    } else if (flags.force) {
      throw new UsageError(`--force only applies together with --resume. ${usageHint(command)}`);
    }
    if (flags.mode !== undefined) {
      flags.mode = flags.mode.trim().toLowerCase();
      oneOf(command, 'mode', flags.mode, CONDITIONS);
    }
    if (flags.condition !== undefined) {
      flags.condition = flags.condition.trim().toLowerCase();
      oneOf(command, 'condition', flags.condition, CONDITIONS);
      // --condition is the hidden alias the Harbor adapter uses; both flags resolve to `mode`.
      if (flags.mode !== undefined && flags.mode !== flags.condition) {
        throw new UsageError(`--mode ${flags.mode} and --condition ${flags.condition} disagree (--condition is an alias of --mode). ${usageHint(command)}`);
      }
      flags.mode = flags.condition;
    }
    if (flags.mockSteps !== undefined) positiveInteger(command, 'mock-steps', flags.mockSteps);
  }

  if (command === 'bench') {
    if (flags.suite !== undefined) oneOf(command, 'suite', flags.suite, SUITES);
    if (flags.tasks !== undefined) positiveInteger(command, 'tasks', flags.tasks);
    if (flags.concurrency !== undefined) positiveInteger(command, 'concurrency', flags.concurrency);
    if (flags.taskSpendCap !== undefined) positiveNumber(command, 'task-spend-cap', flags.taskSpendCap);
    if (flags.conditions !== undefined) {
      const parts = flags.conditions.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      if (parts.length === 0) throw new UsageError(`--conditions: expected a comma-separated subset of ${CONDITIONS.join(', ')}. ${usageHint(command)}`);
      for (const p of parts) oneOf(command, 'conditions', p, CONDITIONS);
    }
    if (flags.resume !== undefined && flags.resume.trim().length === 0) {
      throw new UsageError(`--resume: bench id is empty. ${usageHint(command)}`);
    }
  }

  if ((command === 'bench' || command === 'perf') && flags.live && flags.spendCap === undefined) {
    throw new UsageError(`--live spends real money and requires --spend-cap <usd>. ${usageHint(command)}`);
  }

  return flags;
}

function flagLine(f: FlagSpec): string {
  const head = `--${f.name}${f.arg ? ` ${f.arg}` : ''}`;
  return `  ${head.padEnd(40)} ${f.help}`;
}

/** Usage text for one command, or the overview when no command is given. */
export function usageText(command?: Command): string {
  const common = FLAGS.filter((f) => f.commands.length === RUN_BENCH_PERF.length && !f.hidden);
  const specific = (c: Command): FlagSpec[] => FLAGS.filter((f) => f.commands.includes(c) && f.commands.length < RUN_BENCH_PERF.length && !f.hidden && f.key !== 'help');
  const lines: string[] = [];
  if (command === undefined) {
    lines.push(
      'JevCode: Jev decides, Claude writes.',
      '',
      'Usage:',
      '  jevcode run  <task text> | --task-file <path> | (stdin when not a TTY)  [--mode jev-on|jev-off|jev-only]',
      '  jevcode run  --resume <run-id> [--force]',
      '  jevcode config [--json]',
      '  jevcode bench --suite swebench|terminal-bench|quixbugs|ladder|all [--tasks <n> | --task-id <id>,...] [--conditions jev-on,jev-off,jev-only]',
      '                [--concurrency <n>] [--live --spend-cap <usd>] [--task-spend-cap <usd>] [--allow-model-alias]',
      '                [--resume <bench-id>] [--out <dir>]',
      '  jevcode perf [--live --spend-cap <usd>] [--out <file>]',
      '',
      'Common flags (every command):',
      ...common.map(flagLine),
      '',
      "Run 'jevcode <command> --help' for the flags of one command.",
    );
    return lines.join('\n');
  }
  lines.push(`Usage: jevcode ${command}${command === 'run' ? ' <task text> | --task-file <path> | --resume <run-id>' : ''}`, '');
  const own = specific(command);
  if (own.length > 0) lines.push(`${command} flags:`, ...own.map(flagLine), '');
  lines.push('Common flags:', ...common.map(flagLine));
  return lines.join('\n');
}
