/**
 * Section validators (DESIGN.md §3): each throws ConfigError naming the setting and the
 * sources that were consulted, so the user learns both what is wrong and where to fix it.
 */
import { ConfigError } from '../errors.js';
import { parseDuration } from '../core/time.js';
import type { DeciderConfig, GeneratorConfig, Resolved, RunLimits } from '../core/types.js';
import type { SettingName } from './types.js';
import { BASE_URLS, DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, MAX_COMMAND_TIMEOUT_MS, lookupPricing } from './defaults.js';

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

export function validateGenerator(reader: SettingReader, warn: (msg: string) => void): GeneratorConfig {
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
  if (!looked.known && (!inR || !outR)) {
    warn(`generator.model "${model}" has no pricing entry; costs default to $0/M unless JEVCODE_PRICE_IN_PER_M and JEVCODE_PRICE_OUT_PER_M are set`);
  }

  return { provider, model, apiKey: keyR.value.trim(), baseUrl, temperature, maxTokens, pricing };
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

export function validateLimits(reader: SettingReader): RunLimits {
  const wallR = reader.get('limits.maxWall');
  if (!wallR) throw missing(reader, 'limits.maxWall', 'the wall-time limit');
  let maxWallMs: number;
  try {
    maxWallMs = parseDuration(wallR.value, 'limits.maxWall');
  } catch {
    throw invalid(reader, 'limits.maxWall', wallR, 'a duration such as 30m, 7h30m, 90s');
  }
  return {
    maxSteps: requireNumber(reader, 'limits.maxSteps', { integer: true, min: 1 }),
    maxWallMs,
    maxReplans: requireNumber(reader, 'limits.maxReplans', { integer: true, min: 0 }),
    completeThreshold: requireNumber(reader, 'limits.completeThreshold', { gt: 0, max: 1 }),
    impossibleThreshold: requireNumber(reader, 'limits.impossibleThreshold', { gt: 0, max: 1 }),
    commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    maxCommandTimeoutMs: MAX_COMMAND_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    spendCapUsd: requireNumber(reader, 'limits.spendCapUsd', { gt: 0 }),
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
