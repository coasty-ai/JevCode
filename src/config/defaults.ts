/** Every default from the DESIGN.md §3 table and the TUI-DESIGN §16 table, the generator pricing table and the provider base URLs. */
import { join } from 'node:path';
import type { Pricing, SettingSpec } from './types.js';

export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_JEV_BASE_URL = 'https://openrouter.ai/api/alpha/decisions';
/** Dated id (REPORT §16): reproducible thresholds. Aliases are accepted and resolved on the first call (§5.4 rule 7). */
export const DEFAULT_JEV_MODEL = 'typesafe/jev-1.13-20260917';
export const DEFAULT_SPEND_CAP_USD = 2;
/** TUI-DESIGN §9.1 / §16 (P45): the run spend cap default under `--mode jev-only`, applied in resolveConfig once the mode is known. */
export const JEV_ONLY_DEFAULT_SPEND_CAP_USD = 0.25;
/** TUI-DESIGN §9.1: default session cap = 5 × the run cap ($10.00 for $2.00, $1.25 for jev-only's $0.25). */
export const SESSION_CAP_MULTIPLIER = 5;
/** TUI-DESIGN §9.5 (Q40): the token cap under --allow-unpriced = spendCapUsd / 15 × 1e6 generator tokens (≈ 133k for $2.00). */
export const UNPRICED_TOKENS_PER_USD = 1e6 / 15;
/** TUI-DESIGN §9.5: cache read / write rates derived from the input rate when the table has no entry. */
export const CACHE_READ_FACTOR = 0.1;
export const CACHE_WRITE_FACTOR = 1.25;
/** TUI-DESIGN §16 launch defaults: fps 30 (15 under SSH), clamped to 5..30 (R14). */
export const DEFAULT_FPS = 30;
export const SSH_FPS = 15;
export const MIN_FPS = 5;
export const MAX_FPS = 30;
export const DEFAULT_THEME = 'dark';
export const DEFAULT_LOG_LEVEL = 'info';
/** TUI-DESIGN §16: `JEVCODE_TRACE=<file>` is `JEVCODE_LOG=<file>` plus `log.level` `trace` (resolve.ts applies the level). */
export const TRACE_ENV = 'JEVCODE_TRACE';
export const TRACE_LOG_LEVEL = 'trace';
export const DEFAULT_MAX_STEPS = 40;
export const DEFAULT_MAX_WALL = '30m';
export const DEFAULT_MAX_REPLANS = 5;
export const DEFAULT_COMPLETE_THRESHOLD = 0.85;
export const DEFAULT_IMPOSSIBLE_THRESHOLD = 0.85;
export const DEFAULT_SANDBOX = 'auto';

/** RunLimits members that are not user-configurable (§8). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;

export const BASE_URLS: Readonly<Record<'anthropic' | 'openrouter', string>> = {
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * USD per million tokens (research 07 §1.2, §2.5, 2026-09-19). Used only when the API does
 * not return a cost. Cache write is the 5-minute rate.
 */
const SONNET_5: Pricing = { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 };
export const ZERO_PRICING: Pricing = { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 };

export const PRICING_TABLE: ReadonlyMap<string, Pricing> = new Map<string, Pricing>([
  ['claude-sonnet-5', SONNET_5],
  ['anthropic/claude-sonnet-5', SONNET_5],
  ['anthropic/claude-sonnet-5-20260630', SONNET_5],
]);

/** Unknown model: zeros plus a warning the caller surfaces once, so cost accounting is visibly off rather than silently wrong. */
export function lookupPricing(model: string): { pricing: Pricing; known: boolean } {
  const p = PRICING_TABLE.get(model.trim().toLowerCase());
  return p ? { pricing: { ...p }, known: true } : { pricing: { ...ZERO_PRICING }, known: false };
}

export const SETTINGS: readonly SettingSpec[] = [
  { name: 'generator.provider', flag: 'provider', env: ['JEVCODE_PROVIDER'], fileKey: 'provider', defaultValue: DEFAULT_PROVIDER, secret: false, description: 'generator provider' },
  { name: 'generator.model', flag: 'model', env: ['JEVCODE_MODEL'], fileKey: 'model', defaultValue: DEFAULT_MODEL, secret: false, description: 'generator model' },
  // The provider-specific env name (ANTHROPIC_API_KEY / OPENROUTER_API_KEY) is prepended by resolve.ts once the provider is known.
  { name: 'generator.apiKey', flag: 'apiKey', env: ['JEVCODE_API_KEY'], fileKey: 'apiKey', defaultValue: null, secret: true, description: 'generator API key' },
  { name: 'generator.baseUrl', flag: 'baseUrl', env: ['JEVCODE_BASE_URL'], fileKey: 'baseUrl', defaultValue: null, secret: false, description: 'generator base URL' },
  { name: 'generator.temperature', flag: 'temperature', env: ['JEVCODE_TEMPERATURE'], fileKey: 'temperature', defaultValue: null, secret: false, description: 'generator temperature' },
  { name: 'generator.maxTokens', flag: 'maxTokens', env: ['JEVCODE_MAX_TOKENS'], fileKey: 'maxTokens', defaultValue: String(DEFAULT_MAX_TOKENS), secret: false, description: 'generator max tokens' },
  { name: 'generator.priceInPerM', env: ['JEVCODE_PRICE_IN_PER_M'], fileKey: 'priceInPerM', defaultValue: null, secret: false, description: 'generator input price override (USD/M)' },
  { name: 'generator.priceOutPerM', env: ['JEVCODE_PRICE_OUT_PER_M'], fileKey: 'priceOutPerM', defaultValue: null, secret: false, description: 'generator output price override (USD/M)' },
  { name: 'decider.baseUrl', flag: 'jevBaseUrl', env: ['JEV_BASE_URL'], fileKey: 'jevBaseUrl', defaultValue: DEFAULT_JEV_BASE_URL, secret: false, description: 'decider base URL' },
  { name: 'decider.apiKey', flag: 'jevApiKey', env: ['JEV_API_KEY', 'OPENROUTER_API_KEY'], fileKey: 'jevApiKey', defaultValue: null, secret: true, description: 'decider API key' },
  { name: 'decider.model', flag: 'jevModel', env: ['JEV_MODEL'], fileKey: 'jevModel', defaultValue: DEFAULT_JEV_MODEL, secret: false, description: 'decider model' },
  { name: 'limits.spendCapUsd', flag: 'spendCap', env: ['JEVCODE_SPEND_CAP_USD'], fileKey: 'spendCapUsd', defaultValue: String(DEFAULT_SPEND_CAP_USD), secret: false, description: 'spend cap (USD)' },
  { name: 'limits.maxSteps', flag: 'maxSteps', env: ['JEVCODE_MAX_STEPS'], fileKey: 'maxSteps', defaultValue: String(DEFAULT_MAX_STEPS), secret: false, description: 'max steps' },
  { name: 'limits.maxWall', flag: 'maxWall', env: ['JEVCODE_MAX_WALL'], fileKey: 'maxWall', defaultValue: DEFAULT_MAX_WALL, secret: false, description: 'max wall time' },
  { name: 'limits.maxReplans', flag: 'maxReplans', env: ['JEVCODE_MAX_REPLANS'], fileKey: 'maxReplans', defaultValue: String(DEFAULT_MAX_REPLANS), secret: false, description: 'max replans' },
  { name: 'limits.completeThreshold', flag: 'completeThreshold', env: ['JEVCODE_COMPLETE_THRESHOLD'], fileKey: 'completeThreshold', defaultValue: String(DEFAULT_COMPLETE_THRESHOLD), secret: false, description: 'completion threshold' },
  { name: 'limits.impossibleThreshold', flag: 'impossibleThreshold', env: ['JEVCODE_IMPOSSIBLE_THRESHOLD'], fileKey: 'impossibleThreshold', defaultValue: String(DEFAULT_IMPOSSIBLE_THRESHOLD), secret: false, description: 'impossible threshold' },
  { name: 'workspace', flag: 'workspace', env: ['JEVCODE_WORKSPACE'], fileKey: 'workspace', defaultValue: null, secret: false, description: 'workspace directory' },
  // JEVCODE_HOME names the jevcode home; the runs dir is <home>/runs (resolve.ts). --runs-dir sets the runs dir directly.
  { name: 'runsDir', flag: 'runsDir', env: ['JEVCODE_HOME'], fileKey: 'runsDir', defaultValue: null, secret: false, description: 'runs directory' },
  { name: 'openAssistPath', flag: 'openAssistPath', env: ['OPEN_ASSIST_PATH'], fileKey: 'openAssistPath', defaultValue: null, secret: false, description: 'Open Assist path' },
  { name: 'configFile', flag: 'config', env: ['JEVCODE_CONFIG'], defaultValue: null, secret: false, description: 'config file' },
  { name: 'sandbox', flag: 'sandbox', env: ['JEVCODE_SANDBOX'], fileKey: 'sandbox', defaultValue: DEFAULT_SANDBOX, secret: false, description: 'sandbox profile' },
  { name: 'noNetwork', boolFlag: { key: 'noNetwork', negate: false }, env: [], fileKey: 'noNetwork', defaultValue: 'false', secret: false, description: 'deny network in the sandbox' },
  { name: 'plain', boolFlag: { key: 'plain', negate: false }, env: [], fileKey: 'plain', defaultValue: 'false', secret: false, description: 'plain renderer' },
  // --- TUI-DESIGN §16 rows ---------------------------------------------------------------------------------------
  { name: 'generator.priceCacheReadPerM', env: ['JEVCODE_PRICE_CACHE_READ_PER_M'], fileKey: 'priceCacheReadPerM', defaultValue: null, secret: false, description: 'generator cache-read price override (USD/M; derived 0.1 × input when absent)' },
  { name: 'generator.priceCacheWritePerM', env: ['JEVCODE_PRICE_CACHE_WRITE_PER_M'], fileKey: 'priceCacheWritePerM', defaultValue: null, secret: false, description: 'generator cache-write price override (USD/M; derived 1.25 × input when absent)' },
  { name: 'limits.allowUnpriced', boolFlag: { key: 'allowUnpriced', negate: false }, env: ['JEVCODE_ALLOW_UNPRICED'], fileKey: 'allowUnpriced', defaultValue: 'false', secret: false, description: 'run an unpriced generator model under a token cap (A135)' },
  { name: 'limits.maxGeneratorTokens', flag: 'maxGeneratorTokens', env: ['JEVCODE_MAX_GENERATOR_TOKENS'], fileKey: 'maxGeneratorTokens', defaultValue: null, secret: false, description: 'generator token cap under allowUnpriced (derived spendCapUsd / 15 × 1e6 when absent)' },
  { name: 'session.spendCapUsd', flag: 'sessionSpendCap', env: ['JEVCODE_SESSION_SPEND_CAP_USD'], fileKey: 'sessionSpendCapUsd', defaultValue: null, secret: false, description: 'session spend cap (USD or none; derived 5 × limits.spendCapUsd when absent)' },
  { name: 'ui.theme', flag: 'theme', env: ['JEVCODE_THEME'], fileKey: 'theme', defaultValue: DEFAULT_THEME, secret: false, description: 'colour theme (dark|light|daltonized|ansi)' },
  // Launch settings (flag > env > default, fixed at mount): the file key is recognised only to be reported as ignored:launch.
  { name: 'ui.fps', flag: 'fps', env: ['JEVCODE_FPS'], ignoredFileKey: 'fps', defaultValue: String(DEFAULT_FPS), secret: false, description: 'render frames per second (5..30; 15 under SSH)', launch: true },
  { name: 'ui.renderMode', flag: 'renderMode', env: ['JEVCODE_RENDER_MODE'], ignoredFileKey: 'renderMode', defaultValue: 'standard', secret: false, description: 'Ink render mode (standard|incremental)', launch: true },
  { name: 'ui.ascii', boolFlag: { key: 'ascii', negate: false }, env: ['JEVCODE_ASCII'], ignoredFileKey: 'ascii', defaultValue: null, secret: false, description: 'ASCII glyph table (auto on TERM=dumb, TERM=linux, non-UTF-8 locale)', launch: true },
  { name: 'ui.screenReader', boolFlag: { key: 'screenReader', negate: false }, env: ['JEVCODE_SCREEN_READER', 'INK_SCREEN_READER'], ignoredFileKey: 'screenReader', defaultValue: 'false', secret: false, description: 'screen-reader mode', launch: true },
  { name: 'ui.noColor', boolFlag: { key: 'noColor', negate: false }, env: ['NO_COLOR'], defaultValue: null, secret: false, description: 'disable colour (NO_COLOR)', launch: true },
  { name: 'ui.title', boolFlag: { key: 'title', negate: false }, env: ['JEVCODE_TITLE'], fileKey: 'title', defaultValue: 'false', secret: false, description: 'set the terminal title (OSC 2)' },
  { name: 'ui.reducedMotion', boolFlag: { key: 'noAnimation', negate: false }, env: ['JEVCODE_REDUCED_MOTION'], fileKey: 'reducedMotion', defaultValue: null, secret: false, description: 'no spinner animation (default true under screen-reader mode)' },
  { name: 'ui.notify', boolFlag: { key: 'notify', negate: false }, env: ['JEVCODE_NOTIFY'], fileKey: 'notify', defaultValue: null, secret: false, description: 'terminal notifications (BEL / OSC; default true under screen-reader mode)' },
  { name: 'ui.osc52', boolFlag: { key: 'osc52', negate: false }, env: ['JEVCODE_OSC52'], fileKey: 'osc52', defaultValue: 'false', secret: false, description: 'clipboard writes through OSC 52' },
  // Inverted-polarity variable (TUI-DESIGN §16): JEVCODE_NO_HISTORY=1 → ui.history false; resolve.ts flips the recognised boolean.
  { name: 'ui.history', boolFlag: { key: 'noHistory', negate: true }, env: [], negateEnv: ['JEVCODE_NO_HISTORY'], fileKey: 'history', defaultValue: 'true', secret: false, description: 'persist composer history (JEVCODE_NO_HISTORY=1 disables)' },
  { name: 'ui.noInput', boolFlag: { key: 'noInput', negate: false }, env: ['JEVCODE_NO_INPUT'], defaultValue: 'false', secret: false, description: 'no interactive renderer; prompts take their safe default' },
  { name: 'ui.trustWorkspace', boolFlag: { key: 'trustWorkspace', negate: false }, env: ['JEVCODE_TRUST_WORKSPACE'], defaultValue: 'false', secret: false, description: 'trust the workspace without the prompt (scripts)' },
  { name: 'ui.budgetWarnings', boolFlag: { key: 'noBudgetWarnings', negate: true }, env: ['JEVCODE_BUDGET_WARNINGS'], fileKey: 'budgetWarnings', defaultValue: 'true', secret: false, description: 'budget toasts and bell (the item and the JSON event are never muted)' },
  { name: 'ui.allowSecretMention', boolFlag: { key: 'allowSecretMention', negate: false }, env: ['JEVCODE_ALLOW_SECRET_MENTION'], defaultValue: 'false', secret: false, description: 'allow @-mentions of denylisted secret files (per-mention y/N)' },
  { name: 'ui.exitCode', flag: 'exitCode', env: ['JEVCODE_EXIT_CODE'], fileKey: 'exitCode', defaultValue: 'zero', secret: false, description: 'session exit code policy (zero|last-run)' },
  { name: 'ui.keybindings', flag: 'keybindings', env: ['JEVCODE_KEYBINDINGS'], fileKey: 'keybindings', defaultValue: null, secret: false, description: 'keybindings file (default ${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json)' },
  // JEVCODE_TRACE is the alias of JEVCODE_LOG at level trace (TUI-DESIGN §16): resolve.ts sets log.level when it is the one that matched.
  { name: 'log.file', flag: 'log', env: ['JEVCODE_LOG', TRACE_ENV], fileKey: 'log', defaultValue: null, secret: false, description: 'log file (default <runDir>/jevcode.log; JEVCODE_TRACE = the same at level trace)' },
  { name: 'log.level', flag: 'logLevel', env: ['JEVCODE_LOG_LEVEL'], fileKey: 'logLevel', defaultValue: DEFAULT_LOG_LEVEL, secret: false, description: 'log level (error|warn|info|debug|trace; --verbose = debug)' },
  { name: 'update.notify', boolFlag: { key: 'updateNotify', negate: false }, env: ['JEVCODE_UPDATE_NOTIFY'], negateEnv: ['NO_UPDATE_NOTIFIER'], fileKey: 'updateNotify', defaultValue: 'false', secret: false, description: 'post-run update notifier (A70; NO_UPDATE_NOTIFIER=1 disables)' },
];

/** TUI-DESIGN §16: the launch rows — resolved by `resolveLaunchSettings`, never from the file. */
export const LAUNCH_SETTINGS: readonly SettingSpec[] = SETTINGS.filter((s) => s.launch === true);

/** TUI-DESIGN §16: `${XDG_CONFIG_HOME:-~/.config}/jevcode` (an absolute XDG_CONFIG_HOME only, per the XDG spec). */
export function xdgConfigDir(home: string, env: NodeJS.ProcessEnv): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = typeof xdg === 'string' && xdg.trim() !== '' && xdg.startsWith('/') ? xdg : join(home, '.config');
  return join(base, 'jevcode');
}

/** TUI-DESIGN §16 (P30): the pre-XDG location `~/.config/jevcode`, still read when the XDG file is absent. */
export function legacyConfigDir(home: string): string {
  return join(home, '.config', 'jevcode');
}

/** TUI-DESIGN §12.7 / §15 item 17: the resolved XDG and legacy jevcode config dirs (deduplicated, XDG first). */
export function configDirsFor(home: string, env: NodeJS.ProcessEnv): readonly string[] {
  return [...new Set([xdgConfigDir(home, env), legacyConfigDir(home)])];
}

/** TUI-DESIGN §16: default `ui.keybindings` path. */
export function defaultKeybindingsPath(home: string, env: NodeJS.ProcessEnv): string {
  return join(xdgConfigDir(home, env), 'keybindings.json');
}

export function settingSpec(name: SettingSpec['name']): SettingSpec {
  const s = SETTINGS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown setting ${name}`);
  return s;
}

export const SECRET_SETTINGS: readonly SettingSpec['name'][] = SETTINGS.filter((s) => s.secret).map((s) => s.name);
