/** Every default from the DESIGN.md §3 table, the generator pricing table and the provider base URLs. */
import type { Pricing, SettingSpec } from './types.js';

export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_MODEL = 'claude-sonnet-5';
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_JEV_BASE_URL = 'https://openrouter.ai/api/alpha/decisions';
/** Dated id (REPORT §16): reproducible thresholds. Aliases are accepted and resolved on the first call (§5.4 rule 7). */
export const DEFAULT_JEV_MODEL = 'typesafe/jev-1.13-20260917';
export const DEFAULT_SPEND_CAP_USD = 2;
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
  { name: 'noNetwork', env: [], fileKey: 'noNetwork', defaultValue: 'false', secret: false, description: 'deny network in the sandbox' },
  { name: 'plain', env: [], fileKey: 'plain', defaultValue: 'false', secret: false, description: 'plain renderer' },
];

export function settingSpec(name: SettingSpec['name']): SettingSpec {
  const s = SETTINGS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown setting ${name}`);
  return s;
}

export const SECRET_SETTINGS: readonly SettingSpec['name'][] = SETTINGS.filter((s) => s.secret).map((s) => s.name);
