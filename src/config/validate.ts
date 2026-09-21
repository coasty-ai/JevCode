/**
 * Section validators (DESIGN.md §3): each throws ConfigError naming the setting and the
 * sources that were consulted, so the user learns both what is wrong and where to fix it.
 */
import { ConfigError } from '../errors.js';
import { parseDuration } from '../core/time.js';
import type { DeciderConfig, GeneratorConfig, Resolved, RunLimits } from '../core/types.js';
import type { SettingName } from './types.js';
import { BASE_URLS, CACHE_READ_FACTOR, CACHE_WRITE_FACTOR, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_SPEND_CAP_USD, MAX_COMMAND_TIMEOUT_MS, UNPRICED_TOKENS_PER_USD, lookupPricing } from './defaults.js';

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

/** §5.4 rule 7: lowercase, strip a leading `typesafe/`; pinned iff the result ends in -YYYYMMDD. */
export function normaliseJevModelId(id: string): { normalised: string; pinned: boolean } {
  const normalised = id.trim().toLowerCase().replace(/^typesafe\//, '');
  return { normalised, pinned: DATED_RE.test(normalised) };
}

/** True when a served id is acceptable for a configured id: equal when pinned, prefix-extended when an alias. */
export function jevModelMatches(configured: string, served: string): boolean {
  const c = normaliseJevModelId(configured);
  const s = normaliseJevModelId(served);
  if (c.pinned) return c.normalised === s.normalised;
  return s.normalised === c.normalised || s.normalised.startsWith(`${c.normalised}-`);
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

export function validateDecider(reader: SettingReader): DeciderConfig {
  const baseR = reader.get('decider.baseUrl');
  if (!baseR) throw missing(reader, 'decider.baseUrl', 'the decider base URL');
  const baseUrl = parseUrlSetting(reader, 'decider.baseUrl', baseR);
  const keyR = reader.get('decider.apiKey');
  if (!keyR || keyR.value.trim().length === 0) throw missing(reader, 'decider.apiKey', 'the Jev API key');
  const modelR = reader.get('decider.model');
  if (!modelR || modelR.value.trim().length === 0) throw missing(reader, 'decider.model', 'the decider model id');
  const model = modelR.value.trim();
  const { normalised, pinned } = normaliseJevModelId(model);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalised)) throw invalid(reader, 'decider.model', modelR, 'a model id such as typesafe/jev-1.13-20260917');
  return { baseUrl, apiKey: keyR.value.trim(), model, pinned };
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
