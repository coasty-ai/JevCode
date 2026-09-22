/** Every default from the DESIGN.md §3 table and the TUI-DESIGN §16 table, the generator pricing table and the provider base URLs. */
import { join } from 'node:path';
import type { EngineMode } from '../core/types.js';
import type { Pricing, SettingProblem, SettingShape, SettingSpec } from './types.js';

/** DECISIONS 2026-09-21: the default generator is OpenRouter `z-ai/glm-5.3-flash` (13–20× cheaper than Sonnet 5, 1M context, tools + structured outputs). */
export const DEFAULT_PROVIDER = 'openrouter';
export const DEFAULT_MODEL = 'z-ai/glm-5.3-flash';
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

/**
 * TUI-DESIGN-4 §8 / docs/COORDINATION-DESIGN.md §8: the three relaxed-context defaults that have one. The values live
 * here (never in a literal at a call site) so `jevcode config`, the engine and the tests read one table.
 */
export const CONTEXT_VIEWS = ['relaxed', 'legacy'] as const;
export const CONTEXT_COMPACTIONS = ['code', 'llm', 'off'] as const;
export const DEFAULT_CONTEXT_VIEW = 'relaxed';
export const DEFAULT_CONTEXT_COMPACTION = 'code';
export const DEFAULT_CONTEXT_COMPACT_EVERY = 8;

/** TUI-DESIGN-2 §2.3: the `decider.provider` row's accepted values (`auto` resolves through rules 2a–2e). */
export const JEV_PROVIDER_SETTING_VALUES = ['auto', 'typesafe', 'openrouter'] as const;

/** TUI-DESIGN-2 §1.2: the `mode` setting's values in the round-2 order; the §12 error text joins them with `|`. */
export const MODE_SETTING_VALUES = ['jev-only', 'jev-on', 'jev-off', 'llm-jev'] as const;
/**
 * TUI-DESIGN-3 §1.1 (D-G): the ONE constant every fallback that names the default mode reads — `jev-on` (badge `jev+llm`: the code model
 * writes, Jev decides every step) since round 3; later: `llm-jev` (the peer's flip) — nothing else moves. No string outside this file
 * names which mode is the default (D-N; `/mode` computes ` (default)` from it).
 */
export const DEFAULT_MODE: EngineMode = 'llm-jev'; // flipped 2026-09-22 on the peer's verified head-to-head (docs/LLM-JEV.md; experiments/results/llm-jev-headtohead-v2.md)
/** D-N: the badge word per mode — the ONLY table that maps a mode to a word; `·` is folded to the glyph set's dot by `modeBadgeWord(mode, g)` */
export const MODE_BADGE_WORD: Readonly<Record<EngineMode, string>> = { 'jev-only': 'jev-only', 'jev-on': 'jev+llm', 'jev-off': 'llm-only', 'llm-jev': 'llm+jev · verified' };
/** the badge is capped so `<badge> · next run` fits the 60-column top edge (`consoleTopEdgeParts`, console-lines.ts:14 `TOP_EDGE_FIXED = 8`) */
export const MODE_BADGE_MAX_CELLS = 20;

/**
 * TUI-DESIGN-2 §2.3 Redaction: key variables whose process-environment values join the SecretSet whichever provider is
 * selected (a TYPESAFE_API_KEY exported in the shell while the session runs `--jev-provider openrouter` is still masked).
 */
export const KNOWN_KEY_ENV: readonly string[] = ['JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'];

/** RunLimits members that are not user-configurable (§8). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;

export const BASE_URLS: Readonly<Record<'anthropic' | 'openrouter', string>> = {
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * USD per million tokens. Used only when the API does not return a cost (OpenRouter's `usage.cost` wins when present).
 *
 * - Sonnet 5: research 07 §1.2, §2.5 (2026-09-19). Cache write is the 5-minute rate.
 * - GLM 5.3 (z-ai/*): the OpenRouter models API, re-fetched 2026-09-21 (evening; the morning figures were 67 % under for
 *   flash). `glm-5.3-flash` lists prompt $0.15/M, completion $0.50/M, input_cache_read $0.05/M; `glm-5.3-flashx` (the 200 tok/s
 *   variant) prompt $0.37/M, completion $1.25/M, cache read $0.075/M; `glm-5.3` prompt $0.84/M, completion $2.64/M, cache read $0.156/M with
 *   no cache-read rate listed (derived: CACHE_READ_FACTOR × input). None of the three lists a cache-write rate, so it is
 *   derived as CACHE_WRITE_FACTOR × input (TUI-DESIGN §9.5). Context 1,310,720 (top provider 1,048,576), max completion
 *   131,072 tokens; tools, tool_choice, parallel_tool_calls, structured_outputs, response_format, temperature, seed, stop,
 *   max_tokens and reasoning are supported parameters. These are the lowest-provider rates: the 2026-09-21 live check was
 *   billed at exactly 5/3× (a provider at $0.15/M / $0.50/M), so the fallback is optimistic when `usage.cost` is absent.
 */
const SONNET_5: Pricing = { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 };
const GLM_5_3_FLASH: Pricing = { inputPerM: 0.15, outputPerM: 0.5, cacheReadPerM: 0.05, cacheWritePerM: 0.15 * CACHE_WRITE_FACTOR };
const GLM_5_3_FLASHX: Pricing = { inputPerM: 0.37, outputPerM: 1.25, cacheReadPerM: 0.075, cacheWritePerM: 0.37 * CACHE_WRITE_FACTOR };
const GLM_5_3: Pricing = { inputPerM: 0.84, outputPerM: 2.64, cacheReadPerM: 0.156, cacheWritePerM: 0.84 * CACHE_WRITE_FACTOR };
export const ZERO_PRICING: Pricing = { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 };

export const PRICING_TABLE: ReadonlyMap<string, Pricing> = new Map<string, Pricing>([
  ['z-ai/glm-5.3-flash', GLM_5_3_FLASH],
  ['z-ai/glm-5.3-flashx', GLM_5_3_FLASHX],
  ['z-ai/glm-5.3', GLM_5_3],
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
  { name: 'generator.temperature', flag: 'temperature', env: ['JEVCODE_TEMPERATURE'], fileKey: 'temperature', defaultValue: null, secret: false, description: 'generator temperature', shape: { kind: 'number', min: 0, max: 2 } },
  { name: 'generator.maxTokens', flag: 'maxTokens', env: ['JEVCODE_MAX_TOKENS'], fileKey: 'maxTokens', defaultValue: String(DEFAULT_MAX_TOKENS), secret: false, description: 'generator max tokens', shape: { kind: 'int', min: 1 } },
  { name: 'generator.priceInPerM', env: ['JEVCODE_PRICE_IN_PER_M'], fileKey: 'priceInPerM', defaultValue: null, secret: false, description: 'generator input price override (USD/M)', shape: { kind: 'number', min: 0 } },
  { name: 'generator.priceOutPerM', env: ['JEVCODE_PRICE_OUT_PER_M'], fileKey: 'priceOutPerM', defaultValue: null, secret: false, description: 'generator output price override (USD/M)', shape: { kind: 'number', min: 0 } },
  // TUI-DESIGN-2 §2.3: resolved by resolve.ts before the key row (it prepends TYPESAFE_API_KEY when the provider is typesafe); `auto` follows rules 2a–2e
  { name: 'decider.provider', flag: 'jevProvider', env: ['JEV_PROVIDER'], fileKey: 'jevProvider', defaultValue: 'auto', secret: false, description: 'Jev provider (auto | typesafe | openrouter); auto = typesafe when TYPESAFE_API_KEY is set, else openrouter', shape: { kind: 'enum', values: JEV_PROVIDER_SETTING_VALUES } },
  // The provider-keyed defaults: resolve.ts replaces these with the typesafe endpoint / `jev-1.13.0` when decider.provider resolves to typesafe (TUI-DESIGN-2 §2.3 row 4)
  { name: 'decider.baseUrl', flag: 'jevBaseUrl', env: ['JEV_BASE_URL'], fileKey: 'jevBaseUrl', defaultValue: DEFAULT_JEV_BASE_URL, secret: false, description: 'decider base URL' },
  { name: 'decider.apiKey', flag: 'jevApiKey', env: ['JEV_API_KEY', 'OPENROUTER_API_KEY'], fileKey: 'jevApiKey', defaultValue: null, secret: true, description: 'decider API key' },
  { name: 'decider.model', flag: 'jevModel', env: ['JEV_MODEL'], fileKey: 'jevModel', defaultValue: DEFAULT_JEV_MODEL, secret: false, description: 'decider model' },
  // TUI-DESIGN-2 §1.2 (D-A): the engine mode is a setting — flag > JEVCODE_MODE > dotenv > file > DEFAULT_MODE; resolve.ts reads it before the mode-keyed cap default
  { name: 'mode', flag: 'mode', env: ['JEVCODE_MODE'], fileKey: 'mode', defaultValue: DEFAULT_MODE, secret: false, description: 'engine mode (jev-only | jev-on | jev-off | llm-jev); jev-only needs no generator key', shape: { kind: 'enum', values: MODE_SETTING_VALUES } },
  { name: 'limits.spendCapUsd', flag: 'spendCap', env: ['JEVCODE_SPEND_CAP_USD'], fileKey: 'spendCapUsd', defaultValue: String(DEFAULT_SPEND_CAP_USD), secret: false, description: 'spend cap (USD)', shape: { kind: 'usd' } },
  { name: 'limits.maxSteps', flag: 'maxSteps', env: ['JEVCODE_MAX_STEPS'], fileKey: 'maxSteps', defaultValue: String(DEFAULT_MAX_STEPS), secret: false, description: 'max steps', shape: { kind: 'int', min: 1 } },
  { name: 'limits.maxWall', flag: 'maxWall', env: ['JEVCODE_MAX_WALL'], fileKey: 'maxWall', defaultValue: DEFAULT_MAX_WALL, secret: false, description: 'max wall time', shape: { kind: 'duration' } },
  { name: 'limits.maxReplans', flag: 'maxReplans', env: ['JEVCODE_MAX_REPLANS'], fileKey: 'maxReplans', defaultValue: String(DEFAULT_MAX_REPLANS), secret: false, description: 'max replans', shape: { kind: 'int', min: 0 } },
  { name: 'limits.completeThreshold', flag: 'completeThreshold', env: ['JEVCODE_COMPLETE_THRESHOLD'], fileKey: 'completeThreshold', defaultValue: String(DEFAULT_COMPLETE_THRESHOLD), secret: false, description: 'completion threshold', shape: { kind: 'number', min: 0, max: 1 } },
  { name: 'limits.impossibleThreshold', flag: 'impossibleThreshold', env: ['JEVCODE_IMPOSSIBLE_THRESHOLD'], fileKey: 'impossibleThreshold', defaultValue: String(DEFAULT_IMPOSSIBLE_THRESHOLD), secret: false, description: 'impossible threshold', shape: { kind: 'number', min: 0, max: 1 } },
  { name: 'workspace', flag: 'workspace', env: ['JEVCODE_WORKSPACE'], fileKey: 'workspace', defaultValue: null, secret: false, description: 'workspace directory' },
  // JEVCODE_HOME names the jevcode home; the runs dir is <home>/runs (resolve.ts). --runs-dir sets the runs dir directly.
  { name: 'runsDir', flag: 'runsDir', env: ['JEVCODE_HOME'], fileKey: 'runsDir', defaultValue: null, secret: false, description: 'runs directory' },
  { name: 'openAssistPath', flag: 'openAssistPath', env: ['OPEN_ASSIST_PATH'], fileKey: 'openAssistPath', defaultValue: null, secret: false, description: 'Open Assist path' },
  { name: 'configFile', flag: 'config', env: ['JEVCODE_CONFIG'], defaultValue: null, secret: false, description: 'config file' },
  { name: 'sandbox', flag: 'sandbox', env: ['JEVCODE_SANDBOX'], fileKey: 'sandbox', defaultValue: DEFAULT_SANDBOX, secret: false, description: 'sandbox profile' },
  { name: 'noNetwork', boolFlag: { key: 'noNetwork', negate: false }, env: [], fileKey: 'noNetwork', defaultValue: 'false', secret: false, description: 'deny network in the sandbox', shape: { kind: 'boolean' } },
  { name: 'plain', boolFlag: { key: 'plain', negate: false }, env: [], fileKey: 'plain', defaultValue: 'false', secret: false, description: 'plain renderer', shape: { kind: 'boolean' } },
  // --- TUI-DESIGN §16 rows ---------------------------------------------------------------------------------------
  { name: 'generator.priceCacheReadPerM', env: ['JEVCODE_PRICE_CACHE_READ_PER_M'], fileKey: 'priceCacheReadPerM', defaultValue: null, secret: false, description: 'generator cache-read price override (USD/M; derived 0.1 × input when absent)', shape: { kind: 'number', min: 0 } },
  { name: 'generator.priceCacheWritePerM', env: ['JEVCODE_PRICE_CACHE_WRITE_PER_M'], fileKey: 'priceCacheWritePerM', defaultValue: null, secret: false, description: 'generator cache-write price override (USD/M; derived 1.25 × input when absent)', shape: { kind: 'number', min: 0 } },
  { name: 'limits.allowUnpriced', boolFlag: { key: 'allowUnpriced', negate: false }, env: ['JEVCODE_ALLOW_UNPRICED'], fileKey: 'allowUnpriced', defaultValue: 'false', secret: false, description: 'run an unpriced generator model under a token cap (A135)', shape: { kind: 'boolean' } },
  { name: 'limits.maxGeneratorTokens', flag: 'maxGeneratorTokens', env: ['JEVCODE_MAX_GENERATOR_TOKENS'], fileKey: 'maxGeneratorTokens', defaultValue: null, secret: false, description: 'generator token cap under allowUnpriced (derived spendCapUsd / 15 × 1e6 when absent)', shape: { kind: 'int', min: 1 } },
  { name: 'session.spendCapUsd', flag: 'sessionSpendCap', env: ['JEVCODE_SESSION_SPEND_CAP_USD'], fileKey: 'sessionSpendCapUsd', defaultValue: null, secret: false, description: 'session spend cap (USD or none; derived 5 × limits.spendCapUsd when absent)', shape: { kind: 'usd', none: true } },
  // TUI-DESIGN-4 §8 (the round-4 config rows) over docs/COORDINATION-DESIGN.md §8: the relaxed-context policy. RESOLVE
  // ONLY this round — `ResolvedConfig.context()` hands the engine a `ContextPolicyOptions` with just the members that
  // were set, and the engine reads it later; the three rows with a default are the ones §8 fixes (relaxed / code / 8),
  // the other three fall through to `src/core/limits.ts` (HISTORY_STEPS, FILE_CACHE_BYTES, the derived budget).
  // No flag: `src/cli/args.ts` is S1's file this round, so these are env + config-file keys only.
  { name: 'context.mode', env: ['JEVCODE_CONTEXT_MODE'], fileKey: 'contextMode', defaultValue: DEFAULT_CONTEXT_VIEW, secret: false, description: 'generator context view (relaxed|legacy)', shape: { kind: 'enum', values: CONTEXT_VIEWS } },
  { name: 'context.compaction', env: ['JEVCODE_CONTEXT_COMPACTION'], fileKey: 'contextCompaction', defaultValue: DEFAULT_CONTEXT_COMPACTION, secret: false, description: 'history compactor (code|llm|off)', shape: { kind: 'enum', values: CONTEXT_COMPACTIONS } },
  { name: 'context.compactEvery', env: ['JEVCODE_CONTEXT_COMPACT_EVERY'], fileKey: 'contextCompactEvery', defaultValue: String(DEFAULT_CONTEXT_COMPACT_EVERY), secret: false, description: 'compact every N steps (0 disables the interval trigger)', shape: { kind: 'int', min: 0 } },
  { name: 'context.historySteps', env: ['JEVCODE_CONTEXT_HISTORY_STEPS'], fileKey: 'contextHistorySteps', defaultValue: null, secret: false, description: 'recent steps the generator sees (default 12)', shape: { kind: 'int', min: 1 } },
  { name: 'context.fileCacheBytes', env: ['JEVCODE_CONTEXT_FILE_CACHE_BYTES'], fileKey: 'contextFileCacheBytes', defaultValue: null, secret: false, description: 'file content re-read per step in bytes (default 98304)', shape: { kind: 'int', min: 0 } },
  { name: 'context.budgetChars', env: ['JEVCODE_CONTEXT_BUDGET_CHARS'], fileKey: 'contextBudgetChars', defaultValue: null, secret: false, description: 'prompt budget in characters (default derived from the model window and the run cap)', shape: { kind: 'int', min: 1 } },
  { name: 'ui.theme', flag: 'theme', env: ['JEVCODE_THEME'], fileKey: 'theme', defaultValue: DEFAULT_THEME, secret: false, description: 'colour theme (dark|light|daltonized|ansi)', shape: { kind: 'enum', values: ['dark', 'light', 'daltonized', 'ansi'] } },
  // Launch settings (flag > env > default, fixed at mount): the file key is recognised only to be reported as ignored:launch.
  { name: 'ui.fps', flag: 'fps', env: ['JEVCODE_FPS'], ignoredFileKey: 'fps', defaultValue: String(DEFAULT_FPS), secret: false, description: 'render frames per second (5..30; 15 under SSH)', launch: true, shape: { kind: 'int', min: MIN_FPS, max: MAX_FPS, clamp: true } },
  { name: 'ui.renderMode', flag: 'renderMode', env: ['JEVCODE_RENDER_MODE'], ignoredFileKey: 'renderMode', defaultValue: 'standard', secret: false, description: 'Ink render mode (standard|incremental)', launch: true, shape: { kind: 'enum', values: ['standard', 'incremental'] } },
  { name: 'ui.ascii', boolFlag: { key: 'ascii', negate: false }, env: ['JEVCODE_ASCII'], ignoredFileKey: 'ascii', defaultValue: null, secret: false, description: 'ASCII glyph table (auto on TERM=dumb, TERM=linux, non-UTF-8 locale)', launch: true, shape: { kind: 'boolean' } },
  { name: 'ui.screenReader', boolFlag: { key: 'screenReader', negate: false }, env: ['JEVCODE_SCREEN_READER', 'INK_SCREEN_READER'], ignoredFileKey: 'screenReader', defaultValue: 'false', secret: false, description: 'screen-reader mode', launch: true, shape: { kind: 'boolean' } },
  { name: 'ui.noColor', boolFlag: { key: 'noColor', negate: false }, env: ['NO_COLOR'], defaultValue: null, secret: false, description: 'disable colour (NO_COLOR)', launch: true, shape: { kind: 'boolean' } },
  // TUI-DESIGN-3 §0.1 (D-Q) / §1.7: the `[setup]` default-mode item prints once per DEFAULT_MODE value — this file key remembers which value
  // was shown; written by the session when the item prints (the trust gate's write path), never by a flag or a variable; hidden from
  // `jevcode config` unless --all
  { name: 'seen.defaultMode', env: [], fileKey: 'seenDefaultMode', defaultValue: null, secret: false, description: 'the default mode the one-time [setup] item was shown for (bookkeeping)', hidden: true },
  { name: 'ui.title', boolFlag: { key: 'title', negate: false }, env: ['JEVCODE_TITLE'], fileKey: 'title', defaultValue: 'false', secret: false, description: 'set the terminal title (OSC 2)', shape: { kind: 'boolean' } },
  { name: 'ui.reducedMotion', boolFlag: { key: 'noAnimation', negate: false }, env: ['JEVCODE_REDUCED_MOTION'], fileKey: 'reducedMotion', defaultValue: null, secret: false, description: 'no spinner animation (default true under screen-reader mode)', shape: { kind: 'boolean' } },
  // TUI-DESIGN-3 §6 item 5 / §3.2: the wordmark's idle animation; no default row — config/ui.ts derives `static` under the SSH launch source, `sweep` otherwise
  { name: 'ui.wordmark', env: ['JEVCODE_WORDMARK'], fileKey: 'wordmark', defaultValue: null, secret: false, description: 'wordmark idle animation (sweep|static|off; default static under SSH)', shape: { kind: 'enum', values: ['sweep', 'static', 'off'] } },
  // contract 1.6 (TUI-DESIGN-4 §8 item 5 / §1.3.1): the opt-in pinned-header renderer. The value Ink mounts with is resolved by
  // `resolveLaunchSettings` (flag > env > default, zero file I/O — Ink fixes `alternateScreen` in its constructor); this row exists
  // so `jevcode config` prints it and `jevcode config set ui.renderer fullscreen` persists for the relaunch `/fullscreen` offers.
  { name: 'ui.renderer', flag: 'renderer', env: ['JEVCODE_RENDERER'], fileKey: 'renderer', defaultValue: 'classic', secret: false, description: 'renderer (classic|fullscreen); fullscreen pins the header on the alternate screen and needs 18 rows / 40 columns', shape: { kind: 'enum', values: ['classic', 'fullscreen'] } },
  // contract 1.6 (TUI-DESIGN-4 §8 item 5 / §1.3.4): the fullscreen renderer's on-exit transcript dump to the primary screen
  { name: 'ui.fullscreenDump', env: ['JEVCODE_FULLSCREEN_DUMP'], fileKey: 'fullscreenDump', defaultValue: 'true', secret: false, description: 'write the transcript to the primary screen when the fullscreen renderer exits', shape: { kind: 'boolean' } },
  { name: 'ui.notify', boolFlag: { key: 'notify', negate: false }, env: ['JEVCODE_NOTIFY'], fileKey: 'notify', defaultValue: null, secret: false, description: 'terminal notifications (BEL / OSC; default true under screen-reader mode)', shape: { kind: 'boolean' } },
  { name: 'ui.osc52', boolFlag: { key: 'osc52', negate: false }, env: ['JEVCODE_OSC52'], fileKey: 'osc52', defaultValue: 'false', secret: false, description: 'clipboard writes through OSC 52', shape: { kind: 'boolean' } },
  // Inverted-polarity variable (TUI-DESIGN §16): JEVCODE_NO_HISTORY=1 → ui.history false; resolve.ts flips the recognised boolean.
  { name: 'ui.history', boolFlag: { key: 'noHistory', negate: true }, env: [], negateEnv: ['JEVCODE_NO_HISTORY'], fileKey: 'history', defaultValue: 'true', secret: false, description: 'persist composer history (JEVCODE_NO_HISTORY=1 disables)', shape: { kind: 'boolean' } },
  { name: 'ui.noInput', boolFlag: { key: 'noInput', negate: false }, env: ['JEVCODE_NO_INPUT'], defaultValue: 'false', secret: false, description: 'no interactive renderer; prompts take their safe default', shape: { kind: 'boolean' } },
  { name: 'ui.trustWorkspace', boolFlag: { key: 'trustWorkspace', negate: false }, env: ['JEVCODE_TRUST_WORKSPACE'], defaultValue: 'false', secret: false, description: 'trust the workspace without the prompt (scripts)', shape: { kind: 'boolean' } },
  { name: 'ui.budgetWarnings', boolFlag: { key: 'noBudgetWarnings', negate: true }, env: ['JEVCODE_BUDGET_WARNINGS'], fileKey: 'budgetWarnings', defaultValue: 'true', secret: false, description: 'budget toasts and bell (the item and the JSON event are never muted)', shape: { kind: 'boolean' } },
  { name: 'ui.allowSecretMention', boolFlag: { key: 'allowSecretMention', negate: false }, env: ['JEVCODE_ALLOW_SECRET_MENTION'], defaultValue: 'false', secret: false, description: 'allow @-mentions of denylisted secret files (per-mention y/N)', shape: { kind: 'boolean' } },
  { name: 'ui.exitCode', flag: 'exitCode', env: ['JEVCODE_EXIT_CODE'], fileKey: 'exitCode', defaultValue: 'zero', secret: false, description: 'session exit code policy (zero|last-run)', shape: { kind: 'enum', values: ['zero', 'last-run'] } },
  { name: 'ui.keybindings', flag: 'keybindings', env: ['JEVCODE_KEYBINDINGS'], fileKey: 'keybindings', defaultValue: null, secret: false, description: 'keybindings file (default ${XDG_CONFIG_HOME:-~/.config}/jevcode/keybindings.json)' },
  // JEVCODE_TRACE is the alias of JEVCODE_LOG at level trace (TUI-DESIGN §16): resolve.ts sets log.level when it is the one that matched.
  { name: 'log.file', flag: 'log', env: ['JEVCODE_LOG', TRACE_ENV], fileKey: 'log', defaultValue: null, secret: false, description: 'log file (default <runDir>/jevcode.log; JEVCODE_TRACE = the same at level trace)' },
  { name: 'log.level', flag: 'logLevel', env: ['JEVCODE_LOG_LEVEL'], fileKey: 'logLevel', defaultValue: DEFAULT_LOG_LEVEL, secret: false, description: 'log level (error|warn|info|debug|trace; --verbose = debug)', shape: { kind: 'enum', values: ['error', 'warn', 'info', 'debug', 'trace'] } },
  { name: 'update.notify', boolFlag: { key: 'updateNotify', negate: false }, env: ['JEVCODE_UPDATE_NOTIFY'], negateEnv: ['NO_UPDATE_NOTIFIER'], fileKey: 'updateNotify', defaultValue: 'false', secret: false, description: 'post-run update notifier (A70; NO_UPDATE_NOTIFIER=1 disables)', shape: { kind: 'boolean' } },
];


// --- TUI-DESIGN-4 §7.5 (P-D5): `jevcode config` validates -----------------------------------------------------

/** §7.5 / §12: the sentence a `✗` row suffixes — `expected an integer ≥ 1`, `expected one of code|llm|off`. */
export function expectedText(shape: SettingShape): string {
  switch (shape.kind) {
    case 'int':
    case 'number': {
      const noun = shape.kind === 'int' ? 'an integer' : 'a number';
      if (shape.min !== undefined && shape.max !== undefined) return `${noun} between ${shape.min} and ${shape.max}`;
      if (shape.min !== undefined) return `${noun} ≥ ${shape.min}`;
      if (shape.max !== undefined) return `${noun} ≤ ${shape.max}`;
      return noun;
    }
    case 'boolean':
      return 'true or false';
    case 'enum':
      return `one of ${shape.values.join('|')}`;
    case 'usd':
      return shape.none === true ? 'a dollar amount or none' : 'a dollar amount';
    case 'duration':
      return 'a duration like 30m, 90s or 1h30m';
  }
}

/** The booleans every layer accepts (`resolve.ts` `negateBooleanText` uses the same set). */
const TRUE_WORDS: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);
const DURATION_RE = /^(\d+(\.\d+)?\s*(ms|s|m|h))+$/i;

/**
 * §7.5 item 1: why the value a layer produced cannot be used. `null` = the value is fine. A value that is merely
 * *dangerous* (`ui.fps: 240` against a `clamp` bound) yields `out-of-range` with `clamped to <v>`, which
 * `configTableLines` draws with `⚠`, not `✗` (§7.5 edge cases).
 */
export function settingProblem(spec: SettingSpec, value: string): SettingProblem | null {
  const shape = spec.shape;
  if (shape === undefined) return null;
  const v = value.trim();
  if (v === '') return null;
  const expected = expectedText(shape);
  switch (shape.kind) {
    case 'boolean':
      return TRUE_WORDS.has(v.toLowerCase()) || FALSE_WORDS.has(v.toLowerCase()) ? null : { kind: 'wrong-type', expected };
    case 'enum':
      return shape.values.some((x) => x === v.toLowerCase()) ? null : { kind: 'wrong-type', expected };
    case 'duration':
      return DURATION_RE.test(v.replace(/\s+/g, '')) ? null : { kind: 'wrong-type', expected };
    case 'usd': {
      if (shape.none === true && (v.toLowerCase() === 'none' || v === 'Infinity')) return null;
      const n = Number(v.replace(/^\$/, ''));
      if (!Number.isFinite(n)) return { kind: 'wrong-type', expected };
      return n < 0 ? { kind: 'out-of-range', expected } : null;
    }
    case 'int':
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) return { kind: 'wrong-type', expected };
      if (shape.kind === 'int' && !Number.isInteger(n)) return { kind: 'wrong-type', expected };
      const low = shape.min !== undefined && n < shape.min;
      const high = shape.max !== undefined && n > shape.max;
      if (!low && !high) return null;
      if (shape.clamp === true) return { kind: 'out-of-range', expected: `clamped to ${low ? shape.min : shape.max}` };
      return { kind: 'out-of-range', expected };
    }
  }
}

/** §7.5: a problem whose row reads `⚠ clamped to <v>` rather than `✗ expected <…>`. */
export function isClampProblem(problem: SettingProblem): boolean {
  return problem.kind === 'out-of-range' && problem.expected.startsWith('clamped to ');
}

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
