/**
 * The one flag list (DESIGN.md §3.1, TUI-DESIGN §1, §16, §17; TUI-DESIGN-2 §1.2 `--mode`, §2.3 `--jev-provider`). `parseCliArgs` turns argv into a typed
 * `ParsedFlags` that `resolveConfig` consumes; nothing here reads files, env or stdin, so the first TUI
 * frame can render before any of that happens (§12). TUI-DESIGN §1: a bare argv or a leading flag is the
 * `chat` command; `jevcode run` with no task on a TTY is `chat` too (A101) — the TTY fact is passed in,
 * never probed here. `--resume <id|title>` accepts any non-empty value: the run-id check moved to the
 * session controller (`cli/session.ts`, after `firstFrame()`), which resolves id → exact title → unique
 * prefix through `resolveResumeTarget` (§15.2 `cli/args.ts` row).
 */
import { parseArgs } from 'node:util';
import { ConfigError, UsageError } from '../errors.js';
import { parseDuration } from '../core/time.js';
import { RUN_ID_RE } from '../checkpoint/run-id.js';
import { RENDER_MODES, parseFps } from '../config/launch.js';
import { RENDERERS } from '../config/ui.js';
import { AUTONOMY_SETTING_VALUES, DEFAULT_AUTONOMY, DEFAULT_MODE, DEFAULT_SPEND_CAP_USD, MAX_FPS, MIN_FPS, MODE_BADGE_WORD } from '../config/defaults.js';
import { THEMES } from '../tui/commands/registry.js';
// TUI-DESIGN-5 §6.3 row 6 / §6.1 (D-AP): the seven ids, from the ZERO-IMPORT module the argv path is allowed to
// read (`src/provider/ids.ts`'s own docblock). Never `models/providers.ts`, which would pull the whole catalogue
// and `provider/openrouter.js` onto this path and fail gate G-R5-1.
import { PROVIDER_IDS } from '../provider/ids.js';

// TUI-DESIGN §15.2 `cli/args.ts`: `COMMANDS += chat | login | logout | sessions | report | why | calibration | completion | upgrade`
// TUI-DESIGN-5 §6.6 / §9.2 `cli/args.ts`: `Command += 'models'` (R5-6). `'import'` (R5-5) and `'agents'` (R5-4)
// join it in the same W4 PR — each **together with its own `src/cli/<verb>.ts` and its `main.tsx` switch arm**,
// because the switch is exhaustive and a union member with no arm is a compile error, not a missing feature.
export type Command = 'chat' | 'run' | 'config' | 'bench' | 'perf' | 'login' | 'logout' | 'sessions' | 'models' | 'import' | 'agents' | 'doctor' | 'report' | 'why' | 'calibration' | 'completion' | 'upgrade';
export const COMMANDS: readonly Command[] = ['chat', 'run', 'config', 'bench', 'perf', 'login', 'logout', 'sessions', 'models', 'import', 'agents', 'doctor', 'report', 'why', 'calibration', 'completion', 'upgrade'];

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
  // TUI-DESIGN-2 §2.3: `--jev-provider auto|typesafe|openrouter` (login: typesafe|openrouter)
  'jevProvider',
  'spendCap',
  'maxSteps',
  'maxWall',
  'maxReplans',
  'completeThreshold',
  'impossibleThreshold',
  'workspace',
  'runsDir',
  'extraEnvFile',
  'config',
  'sandbox',
  'taskFile',
  'resume',
  'mode',
  'condition',
  // complete autonomy by default: `--autonomy full|review` — who approves a `review` risk verdict
  'autonomy',
  'suite',
  'tasks',
  'taskId',
  'conditions',
  'concurrency',
  'taskSpendCap',
  'out',
  'mockSteps',
  // TUI-DESIGN §16 value flags (keys match config/types.ts TuiStringFlagKey, read structurally by config/resolve.ts)
  'theme',
  'fps',
  'renderMode',
  // TUI-DESIGN-4 §1.3.1: `--renderer classic|fullscreen` — a LAUNCH setting (Ink fixes `alternateScreen` in its constructor)
  'renderer',
  'exitCode',
  'keybindings',
  'log',
  'logLevel',
  'sessionSpendCap',
  'maxGeneratorTokens',
  // TUI-DESIGN §15 item 11 / §15.2: hidden `--source perf` for the perf drivers (RunMeta.source)
  'source',
  // TUI-DESIGN §17 item 5: `jevcode upgrade --method <manager>`
  'method',
  // TUI-DESIGN-5 §2.10 / §2.8: the sessions verb surface and the claim fence
  'device',
  'parentSession',
  // TUI-DESIGN-5 §4.8: the orchestration flags that take a value
  'parent',
  'agent',
  'manifest',
  'own',
  'base',
  'split',
  'maxAgents',
  // TUI-DESIGN-5 §5.5: `jevcode import` (`--source`, `--resume` and `--json`/`--plain` already exist)
  'scope',
  'undo',
] as const;

export const BOOLEAN_FLAGS = [
  'noNetwork',
  'plain',
  'force',
  'perfExitAfterFirstFrame',
  'json',
  'live',
  'allowModelAlias',
  'archiveRuns',
  'quick',
  'help',
  'version',
  'mock',
  'mockGenerator',
  'perfLagProbe',
  // TUI-DESIGN §16 boolean flags (keys match config/types.ts TuiBooleanFlagKey)
  'ascii',
  'title',
  'screenReader',
  'noAnimation',
  'notify',
  'osc52',
  'noHistory',
  'noInput',
  'trustWorkspace',
  'noBudgetWarnings',
  'allowSecretMention',
  'noColor',
  'verbose',
  'allowUnpriced',
  'updateNotify',
  // TUI-DESIGN §1 / §8.4: `-c/--continue`, `--list-sessions`
  'continue',
  'listSessions',
  // TUI-DESIGN §11.2 `jevcode login` / `logout`; TUI-DESIGN-3 §1.6 `--key-stdin` (the one-OpenRouter-key form)
  'generatorKeyStdin',
  'jevKeyStdin',
  'keyStdin',
  'status',
  'verify',
  'generator',
  'jev',
  // TUI-DESIGN §13.6 `jevcode report --include-requests`; §17 `jevcode upgrade --check [--write-cache]`
  'includeRequests',
  'check',
  'writeCache',
  // TUI-DESIGN-3 §0.1 (D-Q): `jevcode config --all` shows the hidden bookkeeping rows (`seen.*`)
  'all',
  // TUI-DESIGN-4 §1.3.1: `--fullscreen` is the short form of `--renderer fullscreen` (the flag wins over the env)
  'fullscreen',
  // TUI-DESIGN-5 §2.10 / §2.8: the sessions verb surface and the epoch bump, which `--force` deliberately is not
  'rotate',
  'forceTakeback',
  // TUI-DESIGN-5 §4.8: the two boolean orchestration flags
  'yesSplit',
  'noWait',
  // TUI-DESIGN-5 §5.5: `jevcode import`, and the two negating switches of D-AP
  'dryRun',
  'yes',
  'noMemory',
  'noImport',
] as const;

export type StringFlagKey = (typeof STRING_FLAGS)[number];
export type BooleanFlagKey = (typeof BOOLEAN_FLAGS)[number];

/** TUI-DESIGN-5 §2.10: `jevcode sessions <verb> [words…]` — seventeen verbs, each a thin wrapper, none starting an engine. */
export type SessionsOp = 'list' | 'reindex' | 'prune' | 'unlock' | 'who' | 'pause' | 'resume' | 'end' | 'tell' | 'headsup' | 'request' | 'inbox' | 'label' | 'pair' | 'unpair' | 'gc' | 'sync';
export const SESSIONS_OPS: readonly SessionsOp[] = ['list', 'reindex', 'prune', 'unlock', 'who', 'pause', 'resume', 'end', 'tell', 'headsup', 'request', 'inbox', 'label', 'pair', 'unpair', 'gc', 'sync'];
/** TUI-DESIGN-5 §6.6: `jevcode models [list|search <query>|refresh]`. */
export type ModelsOp = 'list' | 'search' | 'refresh';
export const MODELS_OPS: readonly ModelsOp[] = ['list', 'search', 'refresh'];
/** TUI-DESIGN §17 item 4: `jevcode completion bash|zsh|fish`. */
export type CompletionShell = 'bash' | 'zsh' | 'fish';
export const COMPLETION_SHELLS: readonly CompletionShell[] = ['bash', 'zsh', 'fish'];

export interface ParsedFlags extends Partial<Record<StringFlagKey, string>>, Partial<Record<BooleanFlagKey, boolean>> {
  command: Command;
  /** `run` positional task text (all positionals after the command, space-joined). */
  task?: string;
  /** `--max-wall` parsed through core/time.ts at parse time so a typo fails before anything else runs. */
  maxWallMs?: number;
  /** TUI-DESIGN §8.9: `--json=verbose` — status events join the stream (`json` is set too). */
  jsonVerbose?: boolean;
  /** TUI-DESIGN §16: `jevcode config set <setting> <value>` (secret settings are refused by the handler, never here). */
  configSet?: { setting: string; value: string };
  /** TUI-DESIGN §1: `jevcode sessions [list|reindex|prune|unlock <id>]`; `list` when absent. */
  sessionsOp?: SessionsOp;
  /** TUI-DESIGN-5 §2.10: the words after `jevcode sessions <verb>` — a target, a message, `now`, `status|disable`. */
  sessionsArgs?: readonly string[];
  /** TUI-DESIGN-5 §6.6: `jevcode models [list|search <query>|refresh]`; `list` when absent. */
  modelsOp?: ModelsOp;
  /** TUI-DESIGN-5 §6.6: the `models search <query>` positional (space-joined, never a flag — it is free text). */
  query?: string;
  /** the run id of `sessions unlock <id>`, `report <id>` and `why <id> …` (RUN_ID_RE-checked: these are ids, never titles). */
  runId?: string;
  /** `jevcode why <id> <step> <ref>` */
  step?: number;
  ref?: string;
  /** `jevcode completion <shell>` */
  shell?: CompletionShell;
  /** `jevcode upgrade [<version>|latest|next]` */
  upgradeTarget?: string;
}

interface FlagSpec {
  key: StringFlagKey | BooleanFlagKey;
  name: string;
  type: 'string' | 'boolean';
  commands: readonly Command[];
  arg?: string;
  help: string;
  hidden?: boolean;
  /** one-letter short form (`-c`, `-h`, `-v`) */
  short?: string;
  /** alternative long names accepted for the same key (`--reduced-motion` for `--no-animation`); the man page and completions list `name` */
  aliases?: readonly string[];
  /** TUI-DESIGN-2 §1.4: a narrower value list on one command (`--jev-provider typesafe|openrouter` on login — `auto` is what an absent flag means there); `usageText(command)` and the zsh per-command completion use it */
  argFor?: Partial<Record<Command, string>>;
}

const ALL: readonly Command[] = COMMANDS;
const RUN: readonly Command[] = ['run'];
const BENCH: readonly Command[] = ['bench'];
/** the run-like commands that resolve the whole configuration (`config` prints what a run would resolve to) */
const COMMON: readonly Command[] = ['chat', 'run', 'config', 'bench', 'perf'];
/** TUI-DESIGN §1: the two commands that own a session (`-c`, `--resume`, `--list-sessions`, `--mode`, the mock and perf hooks) */
const SESSION: readonly Command[] = ['chat', 'run'];
/** TUI-DESIGN §16: the `ui.*`, `log.*` and `session.*` flags (`config` prints their rows) */
const UI: readonly Command[] = ['chat', 'run', 'config'];
/** commands that locate the runs dir / config file without running anything */
const PATHS: readonly Command[] = [...COMMON, 'login', 'logout', 'sessions', 'import', 'agents', 'doctor', 'report', 'why', 'calibration'];
const JSON_CMDS: readonly Command[] = ['chat', 'run', 'config', 'sessions', 'models', 'import', 'agents', 'doctor', 'why', 'calibration'];
/** TUI-DESIGN-5 §6.6: `jevcode models` takes the five flags it can act on and nothing else. */
const MODELS: readonly Command[] = ['models'];
/** TUI-DESIGN-5 §5.5: `jevcode import` takes the eight flags of its own row and nothing else. */
const IMPORT: readonly Command[] = ['import'];
/** TUI-DESIGN-5 §4.2 / §4.9: `jevcode agents list` is a read — it takes `--json` and the two twins. */
const AGENTS: readonly Command[] = ['agents'];

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export const EXIT_CODE_POLICIES = ['zero', 'last-run'] as const;
/** TUI-DESIGN §15 item 11: the sources a CLI invocation may claim (`bench` is set programmatically by bench/conditions.ts). */
export const CLI_SOURCES = ['cli', 'perf'] as const;

/** Common flags are accepted by every run-like command: `config` needs them to print what a run would resolve to. */
export const FLAGS: readonly FlagSpec[] = [
  // TUI-DESIGN-5 §6.1 (D-AP) / §6.3: seven ids, named from PROVIDER_IDS rather than re-declared here
  { key: 'provider', name: 'provider', type: 'string', commands: [...COMMON, 'login', ...MODELS], arg: PROVIDER_IDS.join('|'), help: 'generator provider (models: filter the catalogue to one provider)' },
  { key: 'model', name: 'model', type: 'string', commands: COMMON, arg: '<id>', help: 'generator model id' },
  { key: 'apiKey', name: 'api-key', type: 'string', commands: COMMON, arg: '<key>', help: 'generator API key (prefer the env var)' },
  { key: 'baseUrl', name: 'base-url', type: 'string', commands: COMMON, arg: '<url>', help: 'generator base URL' },
  { key: 'temperature', name: 'temperature', type: 'string', commands: COMMON, arg: '<t>', help: 'generator temperature (unset = not sent)' },
  { key: 'maxTokens', name: 'max-tokens', type: 'string', commands: COMMON, arg: '<n>', help: 'generator max output tokens' },
  { key: 'jevBaseUrl', name: 'jev-base-url', type: 'string', commands: COMMON, arg: '<url>', help: 'decider (Jev) base URL' },
  { key: 'jevApiKey', name: 'jev-api-key', type: 'string', commands: COMMON, arg: '<key>', help: 'decider API key (prefer the env var)' },
  { key: 'jevModel', name: 'jev-model', type: 'string', commands: COMMON, arg: '<id>', help: 'decider model id (dated id pins it)' },
  { key: 'jevProvider', name: 'jev-provider', type: 'string', commands: [...COMMON, 'login'], arg: 'auto|typesafe|openrouter', argFor: { login: 'typesafe|openrouter' }, help: 'Jev provider (default auto: typesafe when TYPESAFE_API_KEY is set, else openrouter)' },
  { key: 'spendCap', name: 'spend-cap', type: 'string', commands: COMMON, arg: '<usd>', help: 'run spend cap in USD (bench: total for the bench)' },
  { key: 'maxSteps', name: 'max-steps', type: 'string', commands: COMMON, arg: '<n>', help: 'max steps per run' },
  { key: 'maxWall', name: 'max-wall', type: 'string', commands: COMMON, arg: '<dur>', help: 'max wall time per run, e.g. 30m, 7h30m, 90s' },
  { key: 'maxReplans', name: 'max-replans', type: 'string', commands: COMMON, arg: '<n>', help: 'max replans per run' },
  { key: 'completeThreshold', name: 'complete-threshold', type: 'string', commands: COMMON, arg: '<p>', help: 'completion probability threshold' },
  { key: 'impossibleThreshold', name: 'impossible-threshold', type: 'string', commands: COMMON, arg: '<p>', help: 'task-impossible probability threshold' },
  { key: 'workspace', name: 'workspace', type: 'string', commands: PATHS, arg: '<dir>', help: 'workspace directory (default: cwd)' },
  { key: 'runsDir', name: 'runs-dir', type: 'string', commands: PATHS, arg: '<dir>', help: 'run directory root (default: ~/.jevcode/runs)' },
  { key: 'extraEnvFile', name: 'extra-env-file', type: 'string', commands: COMMON, arg: '<path>', help: 'an additional .env file whose keys are read as a fallback' },
  { key: 'config', name: 'config', type: 'string', commands: PATHS, arg: '<file>', help: 'config file (default: ./jevcode.json, else ${XDG_CONFIG_HOME:-~/.config}/jevcode/config.json)' },
  { key: 'sandbox', name: 'sandbox', type: 'string', commands: COMMON, arg: 'auto|seatbelt|none', help: 'sandbox profile' },
  { key: 'noNetwork', name: 'no-network', type: 'boolean', commands: COMMON, help: 'deny network to sandboxed commands' },
  { key: 'plain', name: 'plain', type: 'boolean', commands: [...COMMON, ...MODELS, ...IMPORT, ...AGENTS], help: 'plain line renderer instead of the TUI (readline composer on a TTY; models/import/agents: the numbered list)' },
  // --- TUI-DESIGN §16 ui.* / log.* / session.* rows (chat, run; config prints them) -------------------------------
  { key: 'theme', name: 'theme', type: 'string', commands: UI, arg: THEMES.join('|'), help: 'colour theme (no auto-detect)' },
  { key: 'fps', name: 'fps', type: 'string', commands: UI, arg: '<n>', help: 'render frames per second, 5..30 (default 30; 15 over SSH); fixed at launch' },
  { key: 'renderMode', name: 'render-mode', type: 'string', commands: UI, arg: RENDER_MODES.join('|'), help: 'Ink render mode (default standard); fixed at launch' },
  // TUI-DESIGN-4 §1.3.1 (D-S): the opt-in pinned-header renderer. Both are LAUNCH flags — Ink fixes `alternateScreen`
  // in its constructor, so the choice cannot be toggled in place; `/fullscreen` persists `ui.renderer` and offers a relaunch.
  { key: 'renderer', name: 'renderer', type: 'string', commands: UI, arg: RENDERERS.join('|'), help: 'renderer (default classic); fullscreen pins the header on the alternate screen (needs 18 rows / 40 cols); fixed at launch' },
  { key: 'fullscreen', name: 'fullscreen', type: 'boolean', commands: UI, help: 'shorthand for --renderer fullscreen' },
  { key: 'ascii', name: 'ascii', type: 'boolean', commands: [...UI, ...MODELS, ...IMPORT, ...AGENTS], help: 'ASCII glyphs (auto on TERM=dumb, TERM=linux, non-UTF-8 locale); fixed at launch' },
  { key: 'title', name: 'title', type: 'boolean', commands: UI, help: 'set the terminal title (OSC 2)' },
  { key: 'screenReader', name: 'screen-reader', type: 'boolean', commands: [...UI, ...MODELS, ...IMPORT], help: 'screen-reader mode (numbered prompts, no bars; implies --plain on a pipe); fixed at launch' },
  { key: 'noAnimation', name: 'no-animation', type: 'boolean', commands: UI, help: 'reduced motion: static spinner, 1 Hz clock (default on with --screen-reader)', aliases: ['reduced-motion'] },
  { key: 'notify', name: 'notify', type: 'boolean', commands: UI, help: 'terminal notification (BEL / OSC) when a review waits or a run ends' },
  { key: 'osc52', name: 'osc52', type: 'boolean', commands: UI, help: 'allow clipboard writes through OSC 52 (write only)' },
  { key: 'noHistory', name: 'no-history', type: 'boolean', commands: UI, help: 'do not persist composer history to ~/.jevcode/history.jsonl' },
  { key: 'noInput', name: 'no-input', type: 'boolean', commands: UI, help: 'no interactive renderer; every prompt takes its safe default (run only: needs a task)' },
  { key: 'trustWorkspace', name: 'trust-workspace', type: 'boolean', commands: UI, help: 'trust the workspace (AGENTS.md, ./.env, jevcode.json) without the prompt (scripts)' },
  { key: 'noBudgetWarnings', name: 'no-budget-warnings', type: 'boolean', commands: UI, help: 'mute budget toasts and the bell (items and JSON events stay)' },
  { key: 'allowSecretMention', name: 'allow-secret-mention', type: 'boolean', commands: UI, help: 'allow @-mentions of denylisted secret files after a per-mention y/N' },
  { key: 'noColor', name: 'no-color', type: 'boolean', commands: UI, help: 'disable colour (same as NO_COLOR)' },
  { key: 'exitCode', name: 'exit-code', type: 'string', commands: UI, arg: EXIT_CODE_POLICIES.join('|'), help: 'session exit code: always 0 (default) or the last run’s code' },
  { key: 'keybindings', name: 'keybindings', type: 'string', commands: UI, arg: '<file>', help: 'keybindings file (default ${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json)' },
  { key: 'log', name: 'log', type: 'string', commands: UI, arg: '<file>', help: 'log file (default <runDir>/jevcode.log; JEVCODE_TRACE=<file> is the same at level trace)' },
  { key: 'logLevel', name: 'log-level', type: 'string', commands: UI, arg: LOG_LEVELS.join('|'), help: 'log level (default info; file only, keys never appear in logs)' },
  { key: 'verbose', name: 'verbose', type: 'boolean', commands: UI, help: 'same as --log-level debug (decisions, hashes, latencies, checkpoint timings to the file only)' },
  { key: 'sessionSpendCap', name: 'session-spend-cap', type: 'string', commands: UI, arg: '<usd>|none', help: 'session spend cap in USD (default 5 × the run cap); none = uncapped' },
  { key: 'allowUnpriced', name: 'allow-unpriced', type: 'boolean', commands: UI, help: 'run an unpriced generator model under a token cap instead of refusing' },
  { key: 'maxGeneratorTokens', name: 'max-generator-tokens', type: 'string', commands: UI, arg: '<n>', help: 'generator token cap under --allow-unpriced (default spend cap / 15 × 1e6)' },
  { key: 'updateNotify', name: 'update-notify', type: 'boolean', commands: UI, help: 'post-run update check through a detached jevcode upgrade --check' },
  // --- TUI-DESIGN §1 / §8.4 session selection (chat and run) -----------------------------------------------------
  { key: 'continue', name: 'continue', type: 'boolean', commands: SESSION, short: 'c', help: 'continue the most recently used session in this workspace' },
  { key: 'resume', name: 'resume', type: 'string', commands: [...SESSION, 'bench', ...IMPORT], arg: '<id|title>', help: 'chat/run: continue a run by id, or a session by exact title or unique prefix; bench: resume <bench-id>; import: continue a partly-applied import by its id' },
  { key: 'force', name: 'force', type: 'boolean', commands: SESSION, help: 'with --resume/--continue: resume a run whose stopReason is complete instead of seeding a follow-up' },
  { key: 'listSessions', name: 'list-sessions', type: 'boolean', commands: SESSION, help: 'print the sessions of this workspace and exit' },
  { key: 'taskFile', name: 'task-file', type: 'string', commands: RUN, arg: '<path>', help: 'read the task text from a file' },
  { key: 'perfExitAfterFirstFrame', name: 'perf-exit-after-first-frame', type: 'boolean', commands: SESSION, help: 'exit after the first frame (perf)', hidden: true },
  // TUI-DESIGN-2 §1.2 / TUI-DESIGN-3 §1.1 (D-N): the enum reads jev-only|jev-on|jev-off|llm-jev; the default is named through DEFAULT_MODE, never a literal
  { key: 'mode', name: 'mode', type: 'string', commands: SESSION, arg: 'jev-only|jev-on|jev-off|llm-jev', help: `engine mode (default ${DEFAULT_MODE}): jev-only (Jev alone, no generating LLM), jev-on (Jev + the code model), jev-off (generator only), llm-jev (candidate patches, tests verify, Jev arbitrates)` },
  { key: 'condition', name: 'condition', type: 'string', commands: SESSION, arg: 'jev-only|jev-on|jev-off|llm-jev', help: 'alias of --mode (Harbor adapter)', hidden: true },
  // complete autonomy by default (`config` prints the row, so it takes the flag too); the default is named through DEFAULT_AUTONOMY, never a literal
  { key: 'autonomy', name: 'autonomy', type: 'string', commands: UI, arg: AUTONOMY_SETTING_VALUES.join('|'), help: `who approves review-flagged actions (default ${DEFAULT_AUTONOMY}): full auto-approves and logs them, review stops for y/n; a blocked action always stops` },
  { key: 'source', name: 'source', type: 'string', commands: SESSION, arg: CLI_SOURCES.join('|'), help: 'RunMeta.source for the perf drivers (perf never writes the session index or history)', hidden: true },
  // Hidden run flags used by the wiring code and perf/*: mocked provider+decider, no network.
  { key: 'mock', name: 'mock', type: 'boolean', commands: SESSION, help: 'mocked generator and decider (perf, smoke)', hidden: true },
  { key: 'mockSteps', name: 'mock-steps', type: 'string', commands: SESSION, arg: '<n>', help: 'steps in the mocked trajectory', hidden: true },
  { key: 'mockGenerator', name: 'mock-generator', type: 'boolean', commands: SESSION, help: 'mocked generator with the live decider (debugging)', hidden: true },
  { key: 'perfLagProbe', name: 'perf-lag-probe', type: 'boolean', commands: SESSION, help: 'record event-loop lag (perf)', hidden: true },
  // TUI-DESIGN §8.9 / §17: `--json[=verbose]` — the NDJSON event stream for chat/run, JSON tables for the others, `--version --json`
  { key: 'json', name: 'json', type: 'boolean', commands: JSON_CMDS, help: 'chat/run: NDJSON event stream on stdout (non-interactive; --json=verbose adds status events); config/sessions/models/import/agents/why/calibration: JSON output' },
  // --- bench / perf ------------------------------------------------------------------------------------------------
  { key: 'suite', name: 'suite', type: 'string', commands: BENCH, arg: 'swebench|terminal-bench|quixbugs|ladder|all', help: 'benchmark suite (quixbugs/ladder: the jev-only difficulty ladder)' },
  { key: 'tasks', name: 'tasks', type: 'string', commands: BENCH, arg: '<n>', help: 'number of tasks' },
  { key: 'taskId', name: 'task-id', type: 'string', commands: BENCH, arg: '<id>[,<id>...]', help: 'specific task ids' },
  { key: 'conditions', name: 'conditions', type: 'string', commands: BENCH, arg: 'jev-on,jev-off[,jev-only,llm-jev,llm-sieve,jev-off-tuned,jev-on-next,jev-on-next-nofast]', help: 'conditions to run (when omitted: the jev-on and jev-off arms)' },
  { key: 'concurrency', name: 'concurrency', type: 'string', commands: BENCH, arg: '<n>', help: 'parallel runs' },
  { key: 'live', name: 'live', type: 'boolean', commands: ['bench', 'perf'], help: 'use the real generator and Jev (requires --spend-cap)' },
  { key: 'taskSpendCap', name: 'task-spend-cap', type: 'string', commands: BENCH, arg: '<usd>', help: `per-run spend cap (default ${DEFAULT_SPEND_CAP_USD.toFixed(2)})` },
  { key: 'allowModelAlias', name: 'allow-model-alias', type: 'boolean', commands: BENCH, help: 'allow an undated --jev-model' },
  { key: 'archiveRuns', name: 'archive-runs', type: 'boolean', commands: BENCH, help: 'copy each run\'s records (steps/decisions/jev/generator.jsonl, run.json, state.json, patch) gzipped into <results>/runs/<runId>/' },
  { key: 'quick', name: 'quick', type: 'boolean', commands: BENCH, help: 'the M16 quick preset (docs/LLM-LOOP-DESIGN.md §3.5): the five Ring-2 tasks, --concurrency 3, replay by default and --spend-cap 0.05 as DEFAULTS that never override an explicit flag' },
  { key: 'out', name: 'out', type: 'string', commands: ['bench', 'perf', 'report'], arg: '<path>', help: 'bench: results dir; perf: results file; report: bundle dir (default ~/.jevcode/reports/<id>/)' },
  // --- TUI-DESIGN §11.2 login / logout -----------------------------------------------------------------------------
  // TUI-DESIGN-3 §1.6: `printenv OPENROUTER_API_KEY | jevcode login --key-stdin` — one line serves Jev and the code model
  { key: 'keyStdin', name: 'key-stdin', type: 'boolean', commands: ['login'], help: 'read one OpenRouter key from the first stdin line: it serves Jev and the code model (pipes)' },
  { key: 'generatorKeyStdin', name: 'generator-key-stdin', type: 'boolean', commands: ['login'], help: 'read the generator key from the first stdin line (pipes)' },
  { key: 'jevKeyStdin', name: 'jev-key-stdin', type: 'boolean', commands: ['login'], help: 'read the Jev key from stdin (the next line)' },
  { key: 'status', name: 'status', type: 'boolean', commands: ['login'], help: 'print which keys are set and where they come from (fingerprints only)' },
  { key: 'verify', name: 'verify', type: 'boolean', commands: ['login'], help: 'verify the saved keys: one priced Jev decision (~$0.00002), one 1-token code-model completion (~$0.000002), the key info ($0)' },
  { key: 'generator', name: 'generator', type: 'boolean', commands: ['logout'], help: 'remove the saved generator key' },
  { key: 'jev', name: 'jev', type: 'boolean', commands: ['logout'], help: 'remove the saved Jev key' },
  { key: 'all', name: 'all', type: 'boolean', commands: ['config', 'sessions'], help: 'config: include the hidden bookkeeping rows (seen.*); sessions who: include sessions gone more than 10 minutes and ignored devices' },
  // --- TUI-DESIGN-5 §2.10: the sessions verb surface -------------------------------------------------------------
  { key: 'device', name: 'device', type: 'string', commands: ['sessions'], arg: '<label>', help: 'with sessions gc: the device to remove, resolved by walking the disk to 1,024 devices (never through the 16-device fold cap)' },
  { key: 'rotate', name: 'rotate', type: 'boolean', commands: ['sessions'], help: 'with sessions pair: take a new device id and key, invalidating the old one everywhere' },
  // --- TUI-DESIGN-5 §2.8 / §7 row 26: the epoch bump is its OWN flag; --force is a different question ------------
  { key: 'forceTakeback', name: 'force-takeback', type: 'boolean', commands: SESSION, help: 'with --resume: re-take a run a peer claimed (bumps the claim epoch); an ordinary resume never does' },
  { key: 'parentSession', name: 'parent-session', type: 'string', commands: SESSION, arg: '<id>', help: 'the session that delegated this one (recorded on run:start; set by the agent tree)', hidden: true },
  // --- TUI-DESIGN-5 §4.8: the nine orchestration flags (R5-4). `--parent-session` is the SAME key as §2.8's, above.
  { key: 'parent', name: 'parent', type: 'string', commands: SESSION, arg: '<run-id>', help: 'the parent run this agent works for (set by the supervisor)', hidden: true },
  { key: 'agent', name: 'agent', type: 'string', commands: SESSION, arg: '<slug>', help: 'run as the named agent of the parent run (set by the supervisor)', hidden: true },
  { key: 'manifest', name: 'manifest', type: 'string', commands: SESSION, arg: '<file>', help: 'the agent manifest to run instead of deciding a split', hidden: true },
  { key: 'own', name: 'own', type: 'string', commands: SESSION, arg: '<glob>', help: 'the paths this agent owns (write-fenced to them)', hidden: true },
  { key: 'base', name: 'base', type: 'string', commands: SESSION, arg: '<ref>', help: 'the git ref agent worktrees branch from (default: HEAD)', hidden: true },
  { key: 'split', name: 'split', type: 'string', commands: SESSION, arg: 'off|auto|ask', help: 'split the task across agents (default off; orchestrate.split)' },
  { key: 'maxAgents', name: 'max-agents', type: 'string', commands: SESSION, arg: '<n>', help: 'the most agents one split may start (orchestrate.maxAgents)' },
  { key: 'yesSplit', name: 'yes-split', type: 'boolean', commands: SESSION, help: 'with --split ask: accept the proposed manifest without the confirm' },
  { key: 'noWait', name: 'no-wait', type: 'boolean', commands: SESSION, help: 'never wait for an agent slot: refuse rather than queue (orchestrate.agentWaitCeilingMs)' },
  // --- TUI-DESIGN-5 §5.5: `jevcode import` (R5-5). `--resume` and `--source` already exist as string flags -------
  { key: 'dryRun', name: 'dry-run', type: 'boolean', commands: IMPORT, help: 'plan and report only — nothing is written' },
  { key: 'yes', name: 'yes', type: 'boolean', commands: IMPORT, help: 'apply the non-credential rows without the review step (a credential row always needs a terminal)' },
  { key: 'scope', name: 'scope', type: 'string', commands: IMPORT, arg: 'user|project|both', help: 'where the imported rows are written (default both)' },
  { key: 'undo', name: 'undo', type: 'string', commands: IMPORT, arg: '<importId>', help: 'restore the files one earlier import replaced' },
  // TUI-DESIGN-5 §5.5 (D-AP): `memory.enabled` stays ONE switch, negated through the `negateEnv` idiom `ui.history`
  // already uses — JevCode writes memory ONCE, at apply, so there is no continuous writer to gate separately.
  { key: 'noMemory', name: 'no-memory', type: 'boolean', commands: UI, help: 'do not read the project and user memory files into the run' },
  { key: 'noImport', name: 'no-import', type: 'boolean', commands: UI, help: 'never offer to import from the other coding agents on this machine' },
  // --- TUI-DESIGN §13.6 report, §17 upgrade ------------------------------------------------------------------------
  { key: 'includeRequests', name: 'include-requests', type: 'boolean', commands: ['report'], help: 'include the redacted jev.jsonl request bodies in the bundle' },
  { key: 'check', name: 'check', type: 'boolean', commands: ['upgrade'], help: 'only report whether a newer version exists (2 s registry timeout)' },
  { key: 'method', name: 'method', type: 'string', commands: ['upgrade'], arg: 'npm|brew|bun|pnpm|yarn', help: 'package manager to upgrade with (default: detected from the install path)' },
  { key: 'writeCache', name: 'write-cache', type: 'boolean', commands: ['upgrade'], help: 'with --check: write the update-check cache (the post-run notifier)', hidden: true },
  { key: 'help', name: 'help', type: 'boolean', commands: ALL, short: 'h', help: 'show usage' },
  { key: 'version', name: 'version', type: 'boolean', commands: ALL, short: 'v', help: 'print the version (--json: name, version, node, ink, react, bundle)' },
];

/** Re-exported for callers that only need the id shape; the check itself lives in the controller (TUI-DESIGN §15.2). */
export { RUN_ID_RE };
export const SANDBOX_PROFILES = ['auto', 'seatbelt', 'none'] as const;
/** bench `--conditions` order (the bench default is `jev-on,jev-off`; TUI-DESIGN-2 §1.1 leaves bench unchanged) */
/**
 * Bench arms accepted by `--conditions`: every member of `CONDITION_ORDER` in src/bench/conditions.ts, listed literally
 * because that module imports the synthesizer's LLM source and args.ts runs before the first frame (test/unit/config/args.test.ts
 * asserts the two lists are identical). The four engine modes are `MODES` below; `llm-sieve` and `jev-off-tuned` are bench-only arms.
 */
export const CONDITIONS = ['jev-on', 'jev-off', 'jev-only', 'llm-jev', 'llm-sieve', 'jev-off-tuned', 'jev-on-next', 'jev-on-next-nofast'] as const;
/** TUI-DESIGN-2 §1.2: `--mode` / `--condition` values in the round-2 order; llm-jev last (docs/LLM-JEV-DESIGN.md); the default is `DEFAULT_MODE` (config/defaults.ts) */
export const MODES = ['jev-only', 'jev-on', 'jev-off', 'llm-jev', 'agent'] as const;
/** TUI-DESIGN-3 §1.9 (R3 F9): the usage tagline — generator-neutral, `package.json`'s description agrees */
export const TAGLINE = 'JevCode: Jev decides, the code model writes.';
/** TUI-DESIGN-3 §1.1 (D-N): the bare-`jevcode` usage sentence names the default through DEFAULT_MODE's badge word, never a literal */
export const BARE_JEVCODE_SENTENCE = `A bare \`jevcode\` opens the interactive session in ${MODE_BADGE_WORD[DEFAULT_MODE]} mode (one OpenRouter key serves Jev and the code model; /mode jev-only runs on Jev alone); \`/\` lists commands, \`?\` shows the keys.`;
/** TUI-DESIGN-2 §2.3: `--jev-provider` values (`auto` = rules 2a–2e in config/resolve.ts; login infers instead) */
export const JEV_PROVIDERS = ['auto', 'typesafe', 'openrouter'] as const;
/** TUI-DESIGN-2 §1.4: `jevcode login --jev-provider typesafe|openrouter` — `auto` is what an absent flag means there, so it is refused as a value */
export const LOGIN_JEV_PROVIDERS = ['typesafe', 'openrouter'] as const;
export const SUITES = ['swebench', 'terminal-bench', 'quixbugs', 'ladder', 'all'] as const;

/** TUI-DESIGN §24: the `--no-input` usage error for `chat`. */
export const NO_INPUT_NEEDS_TASK = '--no-input needs a task: use jevcode run';

/**
 * TUI-DESIGN §8.4 / §15.2: how the controller reads a `--resume` value — a run id (RUN_ID_RE) is resumed directly;
 * anything else is a session title (exact, then unique case-insensitive prefix) resolved against the index fold
 * with `resolveResumeTarget(fold, value)` (session/picker-lines.ts). Pure; the parser only guarantees non-emptiness.
 */
export function classifyResumeValue(value: string): { kind: 'run'; runId: string } | { kind: 'title'; title: string } {
  const v = value.trim();
  return RUN_ID_RE.test(v) ? { kind: 'run', runId: v } : { kind: 'title', title: v };
}

function isCommand(s: string): s is Command {
  return (COMMANDS as readonly string[]).includes(s);
}

function isSessionsOp(s: string): s is SessionsOp {
  return (SESSIONS_OPS as readonly string[]).includes(s);
}

function isModelsOp(s: string): s is ModelsOp {
  return (MODELS_OPS as readonly string[]).includes(s);
}

function isShell(s: string): s is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(s);
}

/** true when `--version`/`-v` (alone or inside a short group such as `-cv`) appears before any `--` terminator */
function hasVersionFlag(argv: readonly string[]): boolean {
  for (const tok of argv) {
    if (tok === '--') return false;
    if (tok === '--version' || /^-[a-zA-Z]*v[a-zA-Z]*$/.test(tok)) return true;
  }
  return false;
}

/**
 * parseArgs option table of one command: every flag name and alias it accepts; `--json` is a string option so `--json=verbose`
 * parses. TUI-DESIGN §1: `--version [--json]` is an any-command row, so `--json` joins the table of every command when
 * `--version` is present (`jevcode bench --version --json`); `bench --json` alone stays unknown.
 */
function optionsFor(command: Command, o: { version?: boolean } = {}): Record<string, { type: 'string' | 'boolean'; short?: string }> {
  const out: Record<string, { type: 'string' | 'boolean'; short?: string }> = {};
  for (const f of FLAGS) {
    if (!f.commands.includes(command) && !(o.version === true && f.key === 'json')) continue;
    const type: 'string' | 'boolean' = f.key === 'json' ? 'string' : f.type;
    for (const name of [f.name, ...(f.aliases ?? [])]) out[name] = f.short !== undefined && name === f.name ? { type, short: f.short } : { type };
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

/** `--json` alone is `--json=` for parseArgs (a string option would otherwise swallow the next token, e.g. the task text). */
function normaliseJsonTokens(argv: readonly string[]): string[] {
  const out: string[] = [];
  let optionsEnded = false;
  for (const tok of argv) {
    if (optionsEnded) {
      out.push(tok);
      continue;
    }
    if (tok === '--') optionsEnded = true;
    out.push(tok === '--json' ? '--json=' : tok);
  }
  return out;
}

/** the parsed value of a flag under its name or any alias (later tokens win in parseArgs; the first defined here is the flag's own name) */
function valueOf(values: Record<string, string | boolean | (string | boolean)[] | undefined>, f: FlagSpec): string | boolean | undefined {
  for (const name of [f.name, ...(f.aliases ?? [])]) {
    const v = values[name];
    if (v === undefined || Array.isArray(v)) continue;
    return v;
  }
  return undefined;
}

function requireRunId(command: Command, what: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') throw new UsageError(`jevcode ${command} needs ${what}. ${usageHint(command)}`);
  const v = value.trim();
  if (!RUN_ID_RE.test(v)) throw new UsageError(`jevcode ${command}: "${v}" is not a run id (expected YYYYMMDD-HHMMSS-xxxxxxxx). ${usageHint(command)}`);
  return v;
}

/** TUI-DESIGN §1: what the parser needs to know about the process to apply A101 (`jevcode run` with no task on a TTY → `chat`); nothing is probed here. */
export interface ParseOptions {
  stdinIsTTY?: boolean;
}

/**
 * TUI-DESIGN §1 (A101): a `run` with nothing to run — no task text, `--task-file`, `--resume`, `--continue` or
 * `--list-sessions` — on a TTY is the session TUI. Only `--json` and `--no-input` keep `run` (they read the task from
 * stdin or fail loudly). The perf and mock hooks (`--perf-exit-after-first-frame`, `--mock`, `--source perf`) do not:
 * a one-shot perf probe passes a task (the perf driver and the build smoke do), and a no-task probe measures the
 * `chat` first frame — keeping `run` there would block on a TTY stdin instead. Pure: the TTY fact is the caller's.
 */
export function promoteRunToChat(flags: ParsedFlags, io: ParseOptions): ParsedFlags {
  if (flags.command !== 'run' || io.stdinIsTTY !== true) return flags;
  if (flags.task !== undefined || flags.taskFile !== undefined || flags.resume !== undefined || flags.continue === true || flags.listSessions === true) return flags;
  if (flags.json === true || flags.noInput === true) return flags;
  return { ...flags, command: 'chat' };
}

/**
 * Parse argv (without the node and script entries). TUI-DESIGN §1: `[]` is `{ command: 'chat' }`; a first token
 * beginning with `-` parses as `chat` flags (`--help`/`-h` answer at once; `--version [--json]` parses like any flag);
 * a first token that is not a command is a usage error (a bare word is never a task: `jevcode run "<task>"`).
 */
export function parseCliArgs(argv: readonly string[], io: ParseOptions = {}): ParsedFlags {
  const first = argv[0];
  if (first === undefined) return { command: 'chat' };
  if (first === '--help' || first === '-h') return { command: 'chat', help: true };
  let command: Command;
  let rest: readonly string[];
  if (first.startsWith('-')) {
    command = 'chat';
    rest = argv;
  } else if (!isCommand(first)) {
    throw new UsageError(`unknown command "${first}": expected one of ${COMMANDS.join('|')} (a task is given as jevcode run "<task>"). Run 'jevcode --help' for usage.`);
  } else {
    command = first;
    rest = argv.slice(1);
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: normaliseJsonTokens(rest), options: optionsFor(command, { version: hasVersionFlag(rest) }), allowPositionals: true, strict: true });
  } catch (e) {
    // parseArgs reports unknown options, missing values and unexpected values as TypeErrors.
    const msg = e instanceof Error ? e.message : String(e);
    throw new UsageError(`${msg}. ${usageHint(command)}`);
  }

  const strings: Partial<Record<StringFlagKey, string>> = {};
  const booleans: Partial<Record<BooleanFlagKey, boolean>> = {};
  let jsonVerbose = false;
  for (const f of FLAGS) {
    const v = valueOf(parsed.values, f);
    if (v === undefined) continue;
    if (f.key === 'json') {
      // TUI-DESIGN §8.9: `--json` or `--json=verbose`; `status` events ride the stream only with verbose
      if (typeof v !== 'string') continue;
      if (v === '' || v === 'true') booleans.json = true;
      else if (v === 'verbose') {
        booleans.json = true;
        jsonVerbose = true;
      } else throw new UsageError(`--json: expected --json or --json=verbose, got "${v}". ${usageHint(command)}`);
      continue;
    }
    if (f.type === 'string' && typeof v === 'string') strings[f.key as StringFlagKey] = v;
    else if (f.type === 'boolean' && v === true) booleans[f.key as BooleanFlagKey] = true;
  }
  const flags: ParsedFlags = { command, ...strings, ...booleans, ...(jsonVerbose ? { jsonVerbose: true } : {}) };
  if (flags.help || flags.version) return flags;

  const positionals = parsed.positionals;
  const noPositionals = (): void => {
    if (positionals.length > 0) throw new UsageError(`jevcode ${command} takes no positional arguments, got "${positionals.join(' ')}". ${usageHint(command)}`);
  };
  switch (command) {
    case 'run': {
      const task = positionals.join(' ').trim();
      if (task.length > 0) flags.task = task;
      break;
    }
    case 'chat':
      if (positionals.length > 0) throw new UsageError(`jevcode chat takes no task text, got "${positionals.join(' ')}"; use jevcode run "<task>". ${usageHint(command)}`);
      break;
    case 'config': {
      // TUI-DESIGN §16: `jevcode config [--json]` or `jevcode config set <setting> <value>`
      if (positionals.length === 0) break;
      const [op, setting, value, ...extra] = positionals;
      if (op !== 'set' || setting === undefined || value === undefined || extra.length > 0) {
        throw new UsageError(`jevcode config takes no positional arguments except 'set <setting> <value>', got "${positionals.join(' ')}". ${usageHint(command)}`);
      }
      if (setting.trim() === '') throw new UsageError(`jevcode config set: the setting name is empty. ${usageHint(command)}`);
      flags.configSet = { setting: setting.trim(), value };
      break;
    }
    case 'sessions': {
      // TUI-DESIGN-5 §2.10: `jevcode sessions <verb> [words…]` — the words after the verb are the verb's own
      // arguments (a target, a message, `now`, `status|disable`) and reach `commandSessions` verbatim.
      const [op, ...rest] = positionals;
      const sop = op ?? 'list';
      if (!isSessionsOp(sop)) throw new UsageError(`jevcode sessions: expected one of ${SESSIONS_OPS.join('|')}, got "${sop}". ${usageHint(command)}`);
      flags.sessionsOp = sop;
      if (rest.length > 0) flags.sessionsArgs = rest;
      if (sop === 'unlock') {
        flags.runId = requireRunId(command, 'the run id to unlock (jevcode sessions unlock <id>)', rest[0]);
        if (rest.length > 1) throw new UsageError(`jevcode sessions unlock takes one run id, got "${rest.join(' ')}". ${usageHint(command)}`);
      } else if ((sop === 'list' || sop === 'reindex' || sop === 'prune') && rest.length > 0) {
        throw new UsageError(`jevcode sessions ${sop} takes no further arguments, got "${rest.join(' ')}". ${usageHint(command)}`);
      }
      break;
    }
    case 'models': {
      // TUI-DESIGN-5 §6.6: `jevcode models [list|search <query>|refresh]`
      const [op, ...rest] = positionals;
      const mop = op ?? 'list';
      if (!isModelsOp(mop)) throw new UsageError(`jevcode models: expected one of ${MODELS_OPS.join('|')}, got "${mop}". ${usageHint(command)}`);
      flags.modelsOp = mop;
      if (mop === 'search') {
        // the query is free text, space-joined like `run`'s task: `jevcode models search gpt 6` is one query
        const q = rest.join(' ').trim();
        if (q === '') throw new UsageError(`jevcode models search needs a query (jevcode models search <query>). ${usageHint(command)}`);
        flags.query = q;
      } else if (rest.length > 0) {
        throw new UsageError(`jevcode models ${mop} takes no further arguments, got "${rest.join(' ')}". ${usageHint(command)}`);
      }
      break;
    }
    case 'import': {
      /**
       * TUI-DESIGN-5 §5.5: one optional source id. The slash form is `/import [--dry-run] [<source>]` — a
       * POSITIONAL — and the CLI takes the same shape, because §5.5's `--source <id>` collides head-on with the
       * hidden perf flag of the same name whose value domain is `CLI_SOURCES` (`cli|perf`, validated at the
       * bottom of this function). One name cannot mean two things, so the twin that has no collision wins and
       * the clash is recorded for the owner rather than resolved by inventing a third name.
       */
      if (positionals.length > 1) throw new UsageError(`jevcode import takes one source id, got "${positionals.join(' ')}". ${usageHint(command)}`);
      const src = positionals[0];
      if (src !== undefined && src !== '') flags.source = src;
      break;
    }
    case 'agents': {
      // TUI-DESIGN-5 §4.2: `list` is the only verb round 5 builds; `src/cli/agents.ts` names the set, and the
      // words reach it verbatim so a future verb needs no edit here.
      if (positionals.length > 0) flags.sessionsArgs = positionals;
      break;
    }
    case 'report': {
      // TUI-DESIGN §13.6: `jevcode report <id>`
      if (positionals.length > 1) throw new UsageError(`jevcode report takes one run id, got "${positionals.join(' ')}". ${usageHint(command)}`);
      flags.runId = requireRunId(command, 'a run id (jevcode report <id>)', positionals[0]);
      break;
    }
    case 'why': {
      // TUI-DESIGN §7.6: `jevcode why <id> <step> <ref>`
      const [id, step, ...refParts] = positionals;
      flags.runId = requireRunId(command, 'a run id, a step and a decision ref (jevcode why <id> <step> <ref>)', id);
      if (step === undefined || !/^\d+$/.test(step) || Number(step) < 1) throw new UsageError(`jevcode why: expected a positive step number after the run id, got "${step ?? ''}". ${usageHint(command)}`);
      const ref = refParts.join(' ').trim();
      if (ref === '') throw new UsageError(`jevcode why: expected a decision ref such as risk.plan_mismatch after the step. ${usageHint(command)}`);
      flags.step = Number(step);
      flags.ref = ref;
      break;
    }
    case 'completion': {
      // TUI-DESIGN §17 item 4: `jevcode completion bash|zsh|fish`
      const [shell, ...extra] = positionals;
      if (shell === undefined || !isShell(shell) || extra.length > 0) {
        throw new UsageError(`jevcode completion: expected one of ${COMPLETION_SHELLS.join('|')}, got "${positionals.join(' ')}". ${usageHint(command)}`);
      }
      flags.shell = shell;
      break;
    }
    case 'upgrade': {
      // TUI-DESIGN §17 item 5: `jevcode upgrade [<version>|latest|next] [--check] [--method <m>]`
      if (positionals.length > 1) throw new UsageError(`jevcode upgrade takes at most one version, got "${positionals.join(' ')}". ${usageHint(command)}`);
      const target = positionals[0]?.trim();
      if (target !== undefined) {
        if (target === '' || !/^[A-Za-z0-9.+-]+$/.test(target)) throw new UsageError(`jevcode upgrade: "${target}" is not a version, latest or next. ${usageHint(command)}`);
        flags.upgradeTarget = target;
      }
      if (flags.writeCache && !flags.check) throw new UsageError(`--write-cache only applies together with --check. ${usageHint(command)}`);
      break;
    }
    default:
      noPositionals();
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
    // TUI-DESIGN-5 §6.1 (D-AP): the two-name wall was here too; `PROVIDER_IDS` is the one list
    oneOf(command, 'provider', flags.provider, PROVIDER_IDS);
  }
  // TUI-DESIGN-2 §2.3: lowercased here so the args check and the config validator agree; §1.4: login takes typesafe|openrouter only
  if (flags.jevProvider !== undefined) {
    flags.jevProvider = flags.jevProvider.trim().toLowerCase();
    oneOf(command, 'jev-provider', flags.jevProvider, command === 'login' ? LOGIN_JEV_PROVIDERS : JEV_PROVIDERS);
  }
  // TUI-DESIGN §16: the ui.* / log.* / session.* values a typo would otherwise carry to the config layer
  if (flags.theme !== undefined) {
    flags.theme = flags.theme.trim().toLowerCase();
    oneOf(command, 'theme', flags.theme, THEMES);
  }
  if (flags.renderer !== undefined) {
    flags.renderer = flags.renderer.trim().toLowerCase();
    oneOf(command, 'renderer', flags.renderer, RENDERERS);
    // TUI-DESIGN-4 §1.3.1: `--fullscreen` is the SHORT FORM of `--renderer fullscreen`, so the two must agree.
    // `resolveLaunchSettings` applies `--fullscreen` last and would otherwise silently override an explicit
    // `--renderer classic` on the same command line — a flag the user typed, ignored without a word.
    if (flags.fullscreen === true && flags.renderer !== 'fullscreen') {
      throw new UsageError(`--fullscreen and --renderer ${flags.renderer} disagree: --fullscreen is the short form of --renderer fullscreen. ${usageHint(command)}`);
    }
  }
  if (flags.renderMode !== undefined) {
    flags.renderMode = flags.renderMode.trim().toLowerCase();
    oneOf(command, 'render-mode', flags.renderMode, RENDER_MODES);
  }
  if (flags.fps !== undefined) {
    // TUI-DESIGN §16 (R14): the one launch flag that can never be re-resolved after mount — `parseFps` shape (digits, optional
    // fraction; no exponent) and the 5..30 range are checked here so `--fps 1e2`, `--fps 100` and `--fps 4` are usage errors,
    // not values silently ignored or clamped by config/launch.ts
    const t = flags.fps.trim();
    const n = Number(t);
    if (parseFps(t) === null || n < MIN_FPS || n > MAX_FPS) {
      throw new UsageError(`--fps: expected a number ${MIN_FPS}..${MAX_FPS}, got "${flags.fps}". ${usageHint(command)}`);
    }
    flags.fps = t;
  }
  if (flags.exitCode !== undefined) {
    flags.exitCode = flags.exitCode.trim().toLowerCase();
    oneOf(command, 'exit-code', flags.exitCode, EXIT_CODE_POLICIES);
  }
  if (flags.logLevel !== undefined) {
    flags.logLevel = flags.logLevel.trim().toLowerCase();
    oneOf(command, 'log-level', flags.logLevel, LOG_LEVELS);
  }
  if (flags.sessionSpendCap !== undefined) {
    const v = flags.sessionSpendCap.trim().toLowerCase();
    if (v === 'none') flags.sessionSpendCap = 'none';
    else {
      const n = Number(v);
      if (v === '' || !Number.isFinite(n) || n <= 0) throw new UsageError(`--session-spend-cap: expected a positive USD amount or none, got "${flags.sessionSpendCap}". ${usageHint(command)}`);
      // trimmed like `none`: the config layer reads the string as is (TUI-DESIGN §16 `session.spendCapUsd`)
      flags.sessionSpendCap = v;
    }
  }
  if (flags.maxGeneratorTokens !== undefined) positiveInteger(command, 'max-generator-tokens', flags.maxGeneratorTokens);
  if (flags.source !== undefined && command !== 'import') {
    // TUI-DESIGN-5 §5.5: on `import` this holds the source id positional, whose vocabulary is `src/import/**`'s
    // and is checked there against the known sources — never `CLI_SOURCES`, which is the perf driver's word.
    flags.source = flags.source.trim().toLowerCase();
    oneOf(command, 'source', flags.source, CLI_SOURCES);
  }
  for (const [name, value] of [
    ['keybindings', flags.keybindings],
    ['log', flags.log],
    ['config', flags.config],
    ['workspace', flags.workspace],
    ['runs-dir', flags.runsDir],
  ] as const) {
    if (value !== undefined && value.trim() === '') throw new UsageError(`--${name}: expected a path, got an empty string. ${usageHint(command)}`);
  }

  if (command === 'chat' || command === 'run') {
    if (command === 'run' && flags.task !== undefined && flags.taskFile !== undefined) {
      throw new UsageError(`give the task either as text or with --task-file, not both. ${usageHint(command)}`);
    }
    if (flags.resume !== undefined) {
      if (flags.task !== undefined || flags.taskFile !== undefined) {
        throw new UsageError(`--resume continues a stored run and takes no task text or --task-file. ${usageHint(command)}`);
      }
      if (flags.continue) throw new UsageError(`--resume and --continue name different runs; give one of them. ${usageHint(command)}`);
      // TUI-DESIGN §15.2: every non-empty value is accepted; run id vs title is the controller's decision after firstFrame()
      flags.resume = flags.resume.trim();
      if (flags.resume.length === 0) throw new UsageError(`--resume: expected a run id or a session title. ${usageHint(command)}`);
    } else if (flags.force && !flags.continue) {
      throw new UsageError(`--force only applies together with --resume or --continue. ${usageHint(command)}`);
    }
    if (flags.listSessions && (flags.task !== undefined || flags.taskFile !== undefined)) {
      throw new UsageError(`--list-sessions prints the sessions and exits; it takes no task. ${usageHint(command)}`);
    }
    // TUI-DESIGN §1 (C46): `--no-input` means no interactive renderer, and a session needs one
    if (command === 'chat' && flags.noInput) throw new UsageError(`${NO_INPUT_NEEDS_TASK}. ${usageHint(command)}`);
    if (flags.mode !== undefined) {
      flags.mode = flags.mode.trim().toLowerCase();
      oneOf(command, 'mode', flags.mode, MODES);
    }
    if (flags.condition !== undefined) {
      flags.condition = flags.condition.trim().toLowerCase();
      oneOf(command, 'condition', flags.condition, MODES);
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

  return promoteRunToChat(flags, io);
}

function flagLine(f: FlagSpec, command?: Command): string {
  const short = f.short !== undefined && f.key !== 'help' && f.key !== 'version' ? `-${f.short}, ` : '';
  const arg = (command !== undefined ? f.argFor?.[command] : undefined) ?? f.arg;
  const head = `${short}--${f.name}${arg ? ` ${arg}` : ''}`;
  const alias = f.aliases && f.aliases.length > 0 ? ` (also ${f.aliases.map((a) => `--${a}`).join(', ')})` : '';
  return `  ${head.padEnd(40)} ${f.help}${alias}`;
}

/** true when the flag belongs to every run-like command (the "Common flags" block) */
function isCommon(f: FlagSpec): boolean {
  return COMMON.every((c) => f.commands.includes(c));
}

/** TUI-DESIGN §1: one usage line per command, in COMMANDS order. */
const USAGE_LINES: Readonly<Record<Command, readonly string[]>> = {
  chat: [
    '  jevcode chat [-c | --resume <id|title> | --list-sessions] [--plain] [--theme dark|light|daltonized|ansi] [--mode jev-only|jev-on|jev-off|llm-jev]',
    '               (a bare `jevcode`, or a leading flag, is `jevcode chat`)',
  ],
  run: [
    '  jevcode run  <task text> | --task-file <path> | (stdin when not a TTY)  [--mode jev-only|jev-on|jev-off|llm-jev] [--plain | --json[=verbose] | --no-input]',
    '  jevcode run  --resume <id|title> [--force] | -c [--force]',
  ],
  config: ['  jevcode config [--json] [--all]', '  jevcode config set <setting> <value>'],
  bench: [
    '  jevcode bench --suite swebench|terminal-bench|quixbugs|ladder|all [--tasks <n> | --task-id <id>,...] [--conditions jev-on,jev-off,jev-only,llm-jev,llm-sieve,jev-off-tuned,jev-on-next,jev-on-next-nofast]',
    '                [--concurrency <n>] [--live --spend-cap <usd>] [--task-spend-cap <usd>] [--allow-model-alias]',
    '                [--resume <bench-id>] [--out <dir>]',
  ],
  perf: ['  jevcode perf [--live --spend-cap <usd>] [--out <file>]'],
  // TUI-DESIGN-5 §6.5: `login --provider` is the seven ids (the wizard stays binary, its CLI twin does not), so
  // the usage line reads them from the one table rather than re-declaring the pair the flag no longer accepts
  login: [`  jevcode login [--key-stdin | --generator-key-stdin --jev-key-stdin] [--provider ${PROVIDER_IDS.join('|')}]`, '                [--jev-provider typesafe|openrouter] [--status] [--verify]'],
  logout: ['  jevcode logout [--generator] [--jev]'],
  // TUI-DESIGN-5 §2.10: seventeen verbs, each a thin wrapper; none starts an engine.
  sessions: [
    '  jevcode sessions [list | reindex | prune | unlock <id>] [--json]',
    '  jevcode sessions who [--all] | inbox | label <text> | pair [--rotate] | unpair | gc [--device <label>] | sync',
    '  jevcode sessions pause|resume|end <target> [now] | tell <target> <text> | headsup <text> | request <target> pause|end|steer [<text>]',
  ],
  // TUI-DESIGN-5 §6.6: `refresh` is the only verb that goes to the network; `list`/`search` are snapshot-first
  models: [
    `  jevcode models [list | search <query> | refresh] [--provider ${PROVIDER_IDS.join('|')}] [--json | --plain]`,
    '                 (list and search read the disk cache and the bundled snapshot; refresh is the explicit fetch)',
  ],
  // TUI-DESIGN-5 §5.5: `jevcode import` — the CLI twin of `/import`. `--yes` never applies a credential row.
  import: [
    '  jevcode import [<source>] [--dry-run | --yes] [--scope user|project|both] [--resume <importId>] [--undo <importId>]',
    '                 (default: plan, review, then apply what you accept; a credential row always needs a terminal)',
  ],
  // TUI-DESIGN-5 §4.2: `jevcode agents list` reads the run's manifest; there is no supervisor in this build, so
  // every row is `planned` (§4.0) and the command never starts anything.
  agents: ['  jevcode agents [list] [--json | --plain]'],
  // round-5 item: `doctor` is a READ — free GETs only, 3 s each, and it prints a one-line fix per row
  doctor: ['  jevcode doctor [--json]', '                 (node, provider keys and reachability, sandbox, config modes, runs dir, terminal)'],
  report: ['  jevcode report <id> [--include-requests] [--out <dir>]'],
  why: ['  jevcode why <id> <step> <ref>'],
  calibration: ['  jevcode calibration [--json]'],
  completion: ['  jevcode completion bash|zsh|fish'],
  upgrade: ['  jevcode upgrade [<version>|latest|next] [--check] [--method npm|brew|bun|pnpm|yarn]'],
};

const POSITIONAL_SYNOPSIS: Readonly<Record<Command, string>> = {
  chat: '',
  run: ' <task text> | --task-file <path> | --resume <id|title> | -c',
  config: ' [set <setting> <value>]',
  bench: '',
  perf: '',
  login: '',
  logout: '',
  sessions: ' [list|reindex|prune|unlock <id>]',
  models: ' [list|search <query>|refresh]',
  import: ' [<source>]',
  agents: ' [list]',
  doctor: '',
  report: ' <id>',
  why: ' <id> <step> <ref>',
  calibration: '',
  completion: ' bash|zsh|fish',
  upgrade: ' [<version>|latest|next]',
};

/** Usage text for one command, or the overview when no command is given. */
export function usageText(command?: Command): string {
  const common = FLAGS.filter((f) => isCommon(f) && !f.hidden);
  const own = (c: Command): FlagSpec[] => FLAGS.filter((f) => f.commands.includes(c) && !isCommon(f) && !f.hidden && f.key !== 'help');
  const lines: string[] = [];
  if (command === undefined) {
    lines.push(TAGLINE, '', 'Usage:');
    for (const c of COMMANDS) lines.push(...USAGE_LINES[c]);
    lines.push(
      '  jevcode --version [--json] | --help',
      '',
      BARE_JEVCODE_SENTENCE,
      '',
      `Common flags (${COMMON.join(', ')}):`,
      ...common.map((f) => flagLine(f)),
      '',
      "Run 'jevcode <command> --help' for the flags of one command.",
    );
    return lines.join('\n');
  }
  lines.push(`Usage: jevcode ${command}${POSITIONAL_SYNOPSIS[command]}`, '');
  const specific = own(command);
  if (specific.length > 0) lines.push(`${command} flags:`, ...specific.map((f) => flagLine(f, command)), '');
  const shared = common.filter((f) => f.commands.includes(command));
  if (shared.length > 0) lines.push('Common flags:', ...shared.map((f) => flagLine(f, command)));
  return lines.join('\n').trimEnd();
}
