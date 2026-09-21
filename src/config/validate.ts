/**
 * Section validators (DESIGN.md §3): each throws ConfigError naming the setting and the
 * sources that were consulted, so the user learns both what is wrong and where to fix it.
 */
import { ConfigError } from '../errors.js';
import { parseDuration } from '../core/time.js';
import type { DeciderConfig, EngineMode, GeneratorConfig, JevProvider, JevProviderSource, Resolved, RunLimits } from '../core/types.js';
import { JEV_PROVIDERS, isPinnedJevModel, jevModelMatches as providerJevModelMatches, normaliseModelId, providerForHost } from '../jev/providers.js';
import type { SettingName } from './types.js';
import { BASE_URLS, CACHE_READ_FACTOR, CACHE_WRITE_FACTOR, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_SPEND_CAP_USD, JEV_PROVIDER_SETTING_VALUES, MAX_COMMAND_TIMEOUT_MS, MODE_SETTING_VALUES, UNPRICED_TOKENS_PER_USD, lookupPricing } from './defaults.js';

/** How a validator reads settings: value + source, and the human list of places that were checked. */
export interface SettingReader {
  get(name: SettingName): Resolved<string> | undefined;
  sources(name: SettingName): readonly string[];
}

function consulted(reader: SettingReader, name: SettingName): string {
  const s = reader.sources(name);
  return s.length > 0 ? ` (consulted: ${s.join(', ')})` : '';
}

export function missing(reader: SettingReader, name: SettingName, what: string): ConfigError {
  return new ConfigError(`${name}: ${what} is not set${consulted(reader, name)}`, { setting: name });
}

export function invalid(reader: SettingReader, name: SettingName, r: Resolved<string>, expected: string): ConfigError {
  return new ConfigError(`${name}: "${r.value}" (from ${r.source}) is not ${expected}${consulted(reader, name)}`, { setting: name });
}

export interface NumberRule {
  integer?: boolean;
  /** inclusive lower bound */
  min?: number;
  /** exclusive lower bound */
  gt?: number;
  /** inclusive upper bound */
  max?: number;
}

function describeRule(rule: NumberRule): string {
  const parts: string[] = [rule.integer ? 'an integer' : 'a number'];
  if (rule.gt !== undefined) parts.push(`> ${rule.gt}`);
  if (rule.min !== undefined) parts.push(`>= ${rule.min}`);
  if (rule.max !== undefined) parts.push(`<= ${rule.max}`);
  return parts.join(' ');
}

export function parseNumberSetting(reader: SettingReader, name: SettingName, r: Resolved<string>, rule: NumberRule): number {
  const text = r.value.trim();
  const n = Number(text);
  const ok =
    text.length > 0 &&
    Number.isFinite(n) &&
    (!rule.integer || Number.isInteger(n)) &&
    (rule.min === undefined || n >= rule.min) &&
    (rule.gt === undefined || n > rule.gt) &&
    (rule.max === undefined || n <= rule.max);
  if (!ok) throw invalid(reader, name, r, describeRule(rule));
  return n;
}

export function requireNumber(reader: SettingReader, name: SettingName, rule: NumberRule): number {
  const r = reader.get(name);
  if (!r) throw missing(reader, name, 'a value');
  return parseNumberSetting(reader, name, r, rule);
}

/** http(s) URL; trailing slashes stripped so clients can append paths. */
export function parseUrlSetting(reader: SettingReader, name: SettingName, r: Resolved<string>): string {
  let u: URL;
  try {
    u = new URL(r.value.trim());
  } catch {
    throw invalid(reader, name, r, 'a URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw invalid(reader, name, r, 'an http(s) URL');
  return u.toString().replace(/\/+$/, '');
}

const DATED_RE = /-\d{8}$/;
/** TUI-DESIGN-2 §2.5: TypeSafe's own versioned id (`jev-1.13.0`) and the unpatched alias TypeSafe does not serve (`jev-1.13`, 400 per PROBE). */
const TYPESAFE_PINNED_RE = /^jev-\d+\.\d+\.\d+$/;
const UNPATCHED_ALIAS_RE = /^jev-\d+\.\d+$/;

/** §5.4 rule 7 under OpenRouter's naming: lowercase, strip a leading `typesafe/`; pinned iff the result ends in -YYYYMMDD (provider-aware callers use `isPinnedJevModel`). */
export function normaliseJevModelId(id: string): { normalised: string; pinned: boolean } {
  const normalised = normaliseModelId(id);
  return { normalised, pinned: DATED_RE.test(normalised) };
}

/** True when a served id is acceptable for a configured id under `provider`'s naming (TUI-DESIGN-2 §2.5; default openrouter, today's callers). */
export function jevModelMatches(configured: string, served: string, provider: JevProvider = 'openrouter'): boolean {
  return providerJevModelMatches(configured, served, provider);
}

/**
 * TUI-DESIGN-2 §1.2 / §12: the `mode` setting's value, or the ConfigError `mode: "<v>" (from <source>) is not one of
 * jev-only|jev-on|jev-off|llm-jev` (exit 2; the §12 text verbatim, so no consulted-sources suffix).
 */
export function parseModeSetting(r: Resolved<string>): EngineMode {
  const v = r.value.trim().toLowerCase();
  if (v === 'jev-only' || v === 'jev-on' || v === 'jev-off' || v === 'llm-jev') return v;
  throw new ConfigError(`mode: "${r.value}" (from ${r.source}) is not one of ${MODE_SETTING_VALUES.join('|')}`, { setting: 'mode' });
}

/** TUI-DESIGN-2 §2.3 rule 1: the `decider.provider` row's value, or a ConfigError naming the source. */
export function parseJevProviderSetting(reader: SettingReader, r: Resolved<string>): 'auto' | JevProvider {
  const v = r.value.trim().toLowerCase();
  if (v === 'auto' || v === 'typesafe' || v === 'openrouter') return v;
  throw invalid(reader, 'decider.provider', r, `one of ${JEV_PROVIDER_SETTING_VALUES.join('|')}`);
}

/** TUI-DESIGN-2 §2.5: the offline verdict on a configured model under `provider`'s naming — null when it belongs, else the other provider's name. */
export function foreignJevModelProvider(model: string, provider: JevProvider): JevProvider | null {
  const raw = model.trim().toLowerCase();
  const n = normaliseModelId(model);
  if (provider === 'typesafe') return raw.startsWith('typesafe/') || DATED_RE.test(n) || UNPATCHED_ALIAS_RE.test(n) ? 'openrouter' : null;
  return TYPESAFE_PINNED_RE.test(n) ? 'typesafe' : null;
}

/** TUI-DESIGN §9.5 (Q40): the generator token cap under --allow-unpriced, `spendCapUsd / 15 × 1e6` (≈ 133k for $2.00). */
export function deriveMaxGeneratorTokens(spendCapUsd: number): number {
  const cap = Number.isFinite(spendCapUsd) && spendCapUsd > 0 ? spendCapUsd : DEFAULT_SPEND_CAP_USD;
  return Math.max(1, Math.floor(cap * UNPRICED_TOKENS_PER_USD));
}

/** TUI-DESIGN §24: the fail-closed message for an unpriced Anthropic model (the flag is named). */
export function unpricedModelMessage(model: string, spendCapUsd: number): string {
  const cap = Number.isFinite(spendCapUsd) ? spendCapUsd : DEFAULT_SPEND_CAP_USD;
  return `generator.model "${model}" has no pricing entry, so the $${cap.toFixed(3)} spend cap could not be enforced. Set JEVCODE_PRICE_IN_PER_M and JEVCODE_PRICE_OUT_PER_M (USD per million tokens), or pass --allow-unpriced to run under a token cap instead.`;
}

/** `limits.allowUnpriced` through the reader; absent = false (A135). */
export function readAllowUnpriced(reader: SettingReader): boolean {
  const r = reader.get('limits.allowUnpriced');
  return r ? parseBooleanSetting(reader, 'limits.allowUnpriced', r) : false;
}

/** The configured run spend cap without the full limits validation (for messages); the default when absent or malformed. */
function spendCapForMessage(reader: SettingReader): number {
  const r = reader.get('limits.spendCapUsd');
  const n = r ? Number(r.value.trim()) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SPEND_CAP_USD;
}

export interface GeneratorValidateOptions {
  /** TUI-DESIGN §9.5: an unpriced Anthropic model is a ConfigError unless this is true (then it runs under a token cap) */
  allowUnpriced?: boolean;
}

/**
 * DESIGN §3 + TUI-DESIGN §9.5: `priced` = PRICING_TABLE hit or both per-M overrides; `provider === 'anthropic' && !priced
 * && !allowUnpriced` fails closed (exit 2, the flag named); cache rates derive as 0.1× / 1.25× input when the table has
 * no entry (`jevcode config` prints those rows as `derived`).
 */
export function validateGenerator(reader: SettingReader, warn: (msg: string) => void, opts: GeneratorValidateOptions = {}): GeneratorConfig {
  const providerR = reader.get('generator.provider');
  if (!providerR) throw missing(reader, 'generator.provider', 'the provider');
  const provider = providerR.value.trim().toLowerCase();
  if (provider !== 'anthropic' && provider !== 'openrouter') throw invalid(reader, 'generator.provider', providerR, 'one of anthropic|openrouter');

  const modelR = reader.get('generator.model');
  if (!modelR || modelR.value.trim().length === 0) throw missing(reader, 'generator.model', 'the model id');
  const model = modelR.value.trim();

  const keyR = reader.get('generator.apiKey');
  if (!keyR || keyR.value.trim().length === 0) throw missing(reader, 'generator.apiKey', `the ${provider} API key`);

  const baseR = reader.get('generator.baseUrl');
  const baseUrl = baseR ? parseUrlSetting(reader, 'generator.baseUrl', baseR) : BASE_URLS[provider];

  const tempR = reader.get('generator.temperature');
  const temperature = tempR ? parseNumberSetting(reader, 'generator.temperature', tempR, { min: 0, max: 2 }) : null;
  const maxTokens = requireNumber(reader, 'generator.maxTokens', { integer: true, min: 1 });

  const looked = lookupPricing(model);
  const pricing = looked.pricing;
  const inR = reader.get('generator.priceInPerM');
  const outR = reader.get('generator.priceOutPerM');
  if (inR) pricing.inputPerM = parseNumberSetting(reader, 'generator.priceInPerM', inR, { min: 0 });
  if (outR) pricing.outputPerM = parseNumberSetting(reader, 'generator.priceOutPerM', outR, { min: 0 });
  const cacheReadR = reader.get('generator.priceCacheReadPerM');
  const cacheWriteR = reader.get('generator.priceCacheWritePerM');
  if (!looked.known) {
    // TUI-DESIGN §9.5: no table entry → cache rates derive from the (possibly overridden) input rate
    pricing.cacheReadPerM = pricing.inputPerM * CACHE_READ_FACTOR;
    pricing.cacheWritePerM = pricing.inputPerM * CACHE_WRITE_FACTOR;
  }
  if (cacheReadR) pricing.cacheReadPerM = parseNumberSetting(reader, 'generator.priceCacheReadPerM', cacheReadR, { min: 0 });
  if (cacheWriteR) pricing.cacheWritePerM = parseNumberSetting(reader, 'generator.priceCacheWritePerM', cacheWriteR, { min: 0 });
  const priced = looked.known || (inR !== undefined && outR !== undefined);
  const allowUnpriced = opts.allowUnpriced ?? false;
  if (!priced) {
    if (provider === 'anthropic' && !allowUnpriced) {
      throw new ConfigError(unpricedModelMessage(model, spendCapForMessage(reader)), { setting: 'generator.model' });
    }
    if (allowUnpriced) {
      warn(`generator.model "${model}" has no pricing entry; running under a token cap of ${deriveMaxGeneratorTokens(spendCapForMessage(reader))} generator tokens (--allow-unpriced), figures render as $?`);
    } else {
      warn(`generator.model "${model}" has no pricing entry; costs default to $0/M unless JEVCODE_PRICE_IN_PER_M and JEVCODE_PRICE_OUT_PER_M are set`);
    }
  }

  return { provider, model, apiKey: keyR.value.trim(), baseUrl, temperature, maxTokens, pricing, priced };
}

export interface DeciderValidateOptions {
  /** TUI-DESIGN-2 §2.3: the provider resolveConfig chose (rules 1–2e) and why; absent = derive from the reader alone (bench, tests) */
  provider?: { name: JevProvider; source: JevProviderSource };
  /** the variable the decider key resolved from (`Hit.via`), null for a flag / file value; drives the §2.3 row 3 refusal */
  keyVia?: string | null;
}

function isExplicitProviderSource(s: string): s is 'flag' | 'env' | `dotenv:${string}` | `file:${string}` {
  return s === 'flag' || s === 'env' || s.startsWith('dotenv:') || s.startsWith('file:');
}

/** The reader-only provider derivation (no resolveConfig): the explicit row, else the base URL's host (rule 2a), else today's OpenRouter. */
function deriveProvider(reader: SettingReader, baseR: Resolved<string> | undefined): { name: JevProvider; source: JevProviderSource } {
  const providerR = reader.get('decider.provider');
  const explicit = providerR ? parseJevProviderSetting(reader, providerR) : 'auto';
  if (explicit !== 'auto' && providerR) return { name: explicit, source: isExplicitProviderSource(providerR.source) ? providerR.source : 'default' };
  const host = baseR && baseR.source !== 'default' ? providerForHost(baseR.value.trim()) : null;
  return host === null ? { name: 'openrouter', source: 'default' } : { name: host, source: 'auto:base-url' };
}

/**
 * DESIGN §3 + TUI-DESIGN-2 §2.3 rows 3–4, §2.5: the decider section under the resolved provider. Offline refusals, all exit 2:
 * a base URL of the other provider's host, a key resolved from OPENROUTER_API_KEY under typesafe, a model id of the other
 * provider's naming. `pinned` and `pricing` are provider-aware; an unset base URL / model takes the provider's own values.
 */
export function validateDecider(reader: SettingReader, opts: DeciderValidateOptions = {}): DeciderConfig {
  const providerR = reader.get('decider.provider');
  if (providerR) parseJevProviderSetting(reader, providerR); // rule 1: an unknown value is a ConfigError naming the source
  const baseR = reader.get('decider.baseUrl');
  const { name: provider, source: providerSource } = opts.provider ?? deriveProvider(reader, baseR);
  const spec = JEV_PROVIDERS[provider];
  // row 4: an unset (default-source) base URL is the provider's own endpoint, whatever the SETTINGS row's OpenRouter default says
  const configuredBase = baseR && baseR.source !== 'default' ? baseR : null;
  const baseUrl = configuredBase ? parseUrlSetting(reader, 'decider.baseUrl', configuredBase) : spec.baseUrl;
  const hostProvider = configuredBase ? providerForHost(baseUrl) : null;
  if (configuredBase && hostProvider !== null && hostProvider !== provider) {
    throw new ConfigError(
      `decider.baseUrl: "${configuredBase.value.trim()}" (from ${configuredBase.source}) is ${hostProvider}'s endpoint but decider.provider is ${provider} (from ${providerSource}); pass --jev-provider ${hostProvider} or drop --jev-base-url`,
      { setting: 'decider.baseUrl' },
    );
  }

  const keyR = reader.get('decider.apiKey');
  if (!keyR || keyR.value.trim().length === 0) throw missing(reader, 'decider.apiKey', 'the Jev API key');
  if (provider === 'typesafe' && opts.keyVia === 'OPENROUTER_API_KEY') {
    throw new ConfigError(`decider.apiKey: resolved from OPENROUTER_API_KEY but decider.provider is typesafe (from ${providerSource}); set TYPESAFE_API_KEY or pass --jev-provider openrouter`, { setting: 'decider.apiKey' });
  }

  const modelR = reader.get('decider.model');
  if (!modelR || modelR.value.trim().length === 0) throw missing(reader, 'decider.model', 'the decider model id');
  // row 4: an unset (default-source) model is the provider's pinned default (`jev-1.13.0` on typesafe)
  const model = modelR.source === 'default' ? spec.defaultModel : modelR.value.trim();
  const normalised = normaliseModelId(model);
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(normalised)) throw invalid(reader, 'decider.model', modelR, `a model id such as ${spec.defaultModel}`);
  const foreign = foreignJevModelProvider(model, provider);
  if (foreign !== null) {
    const label = foreign === 'openrouter' ? 'an OpenRouter id' : 'a TypeSafe id';
    throw new ConfigError(`decider.model: "${model}" (from ${modelR.source}) is ${label}; the ${provider} provider serves ${spec.defaultModel} (or pass --jev-provider ${foreign})`, { setting: 'decider.model' });
  }
  // §2.5: pinning is provider-aware (`-YYYYMMDD` on openrouter, `jev-<major>.<minor>.<patch>` on typesafe)
  const pinned = isPinnedJevModel(model, provider);
  return { provider, baseUrl, apiKey: keyR.value.trim(), model, pinned, pricing: spec.pricing, providerSource };
}

export interface LimitsValidateOptions {
  /** TUI-DESIGN §9.5: when true, `maxGeneratorTokens` is set (configured, else derived spendCapUsd / 15 × 1e6) */
  allowUnpriced?: boolean;
}

/** DESIGN §3 limits; TUI-DESIGN §15 item 11: `maxGeneratorTokens` is present only under allowUnpriced (conditional spread). */
export function validateLimits(reader: SettingReader, opts: LimitsValidateOptions = {}): RunLimits {
  const wallR = reader.get('limits.maxWall');
  if (!wallR) throw missing(reader, 'limits.maxWall', 'the wall-time limit');
  let maxWallMs: number;
  try {
    maxWallMs = parseDuration(wallR.value, 'limits.maxWall');
  } catch {
    throw invalid(reader, 'limits.maxWall', wallR, 'a duration such as 30m, 7h30m, 90s');
  }
  const spendCapUsd = requireNumber(reader, 'limits.spendCapUsd', { gt: 0 });
  const allowUnpriced = opts.allowUnpriced ?? readAllowUnpriced(reader);
  const tokensR = reader.get('limits.maxGeneratorTokens');
  const maxGeneratorTokens = tokensR ? parseNumberSetting(reader, 'limits.maxGeneratorTokens', tokensR, { integer: true, min: 1 }) : deriveMaxGeneratorTokens(spendCapUsd);
  return {
    maxSteps: requireNumber(reader, 'limits.maxSteps', { integer: true, min: 1 }),
    maxWallMs,
    maxReplans: requireNumber(reader, 'limits.maxReplans', { integer: true, min: 0 }),
    completeThreshold: requireNumber(reader, 'limits.completeThreshold', { gt: 0, max: 1 }),
    impossibleThreshold: requireNumber(reader, 'limits.impossibleThreshold', { gt: 0, max: 1 }),
    commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    maxCommandTimeoutMs: MAX_COMMAND_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    spendCapUsd,
    ...(allowUnpriced ? { maxGeneratorTokens } : {}),
  };
}

export const SANDBOX_VALUES = ['auto', 'seatbelt', 'none'] as const;
export type SandboxValue = (typeof SANDBOX_VALUES)[number];

export function validateSandbox(reader: SettingReader): SandboxValue {
  const r = reader.get('sandbox');
  if (!r) throw missing(reader, 'sandbox', 'the sandbox profile');
  const v = r.value.trim().toLowerCase();
  if (v === 'auto' || v === 'seatbelt' || v === 'none') return v;
  throw invalid(reader, 'sandbox', r, 'one of auto|seatbelt|none');
}

/** Booleans from the config file: true/false/1/0/yes/no; flags set `true` directly. */
export function parseBooleanSetting(reader: SettingReader, name: SettingName, r: Resolved<string>): boolean {
  const v = r.value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === '') return false;
  throw invalid(reader, name, r, 'a boolean (true|false)');
}
