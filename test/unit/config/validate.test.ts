import { describe, expect, it } from 'vitest';
import type { Resolved } from '../../../src/core/types.js';
import { ConfigError } from '../../../src/errors.js';
import { deriveMaxGeneratorTokens, jevModelMatches, normaliseJevModelId, parseNumberSetting, parseUrlSetting, readAllowUnpriced, unpricedModelMessage, validateGenerator, validateLimits, type SettingReader } from '../../../src/config/validate.js';
import { fingerprint, formatRecordValue, maskEntries, renderConfigTable } from '../../../src/config/mask.js';
import { CACHE_WRITE_FACTOR, DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_SPEND_CAP_USD, lookupPricing, SETTINGS } from '../../../src/config/defaults.js';
import { costFromPricing } from '../../../src/provider/sse.js';
import { sha256Hex } from '../../../src/core/hash.js';

const reader: SettingReader = { get: () => undefined, sources: () => ['--x (flag)', 'X (env)'] };
const r = (value: string): Resolved<string> => ({ value, source: 'env' });

describe('normaliseJevModelId / jevModelMatches (§5.4 rule 7)', () => {
  it('lowercases, strips typesafe/, detects the date suffix', () => {
    expect(normaliseJevModelId('TypeSafe/Jev-1.13-20260917')).toEqual({ normalised: 'jev-1.13-20260917', pinned: true });
    expect(normaliseJevModelId('typesafe/jev-1.13')).toEqual({ normalised: 'jev-1.13', pinned: false });
    expect(normaliseJevModelId('jev-1.13')).toEqual({ normalised: 'jev-1.13', pinned: false });
    expect(normaliseJevModelId(' jev-1.13-2026091 ')).toEqual({ normalised: 'jev-1.13-2026091', pinned: false });
  });

  it('pinned requires equality; alias accepts a dated extension only', () => {
    expect(jevModelMatches('typesafe/jev-1.13-20260917', 'typesafe/jev-1.13-20260917')).toBe(true);
    expect(jevModelMatches('typesafe/jev-1.13-20260917', 'typesafe/jev-1.13-20261001')).toBe(false);
    expect(jevModelMatches('jev-1.13', 'typesafe/jev-1.13-20260917')).toBe(true);
    expect(jevModelMatches('jev-1.13', 'typesafe/jev-1.14-20260917')).toBe(false);
    expect(jevModelMatches('jev-1.1', 'typesafe/jev-1.13-20260917')).toBe(false);
  });
});

describe('number and URL parsing name the setting, value, source and consulted sources', () => {
  it('rejects non-numbers, non-integers and out-of-range values', () => {
    expect(parseNumberSetting(reader, 'limits.maxSteps', r('40'), { integer: true, min: 1 })).toBe(40);
    for (const v of ['', 'abc', '1.5', '0', 'Infinity', 'NaN']) {
      expect(() => parseNumberSetting(reader, 'limits.maxSteps', r(v), { integer: true, min: 1 })).toThrow(ConfigError);
    }
    let err: unknown;
    try {
      parseNumberSetting(reader, 'limits.completeThreshold', r('1.5'), { gt: 0, max: 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const ce = err as ConfigError;
    expect(ce.setting).toBe('limits.completeThreshold');
    expect(ce.message).toContain('"1.5"');
    expect(ce.message).toContain('from env');
    expect(ce.message).toContain('--x (flag)');
    expect(ce.exitCode).toBe(2);
  });

  it('accepts http(s) URLs, strips trailing slashes, rejects others', () => {
    expect(parseUrlSetting(reader, 'decider.baseUrl', r('https://openrouter.ai/api/alpha/decisions/'))).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(parseUrlSetting(reader, 'generator.baseUrl', r('http://localhost:8080'))).toBe('http://localhost:8080');
    expect(() => parseUrlSetting(reader, 'generator.baseUrl', r('ftp://x'))).toThrow(/http\(s\) URL/);
    expect(() => parseUrlSetting(reader, 'generator.baseUrl', r('not a url'))).toThrow(/a URL/);
  });
});

describe('defaults and pricing', () => {
  it('knows Sonnet 5 under both ids and returns zeros for unknown models', () => {
    for (const id of ['claude-sonnet-5', 'anthropic/claude-sonnet-5', 'Anthropic/Claude-Sonnet-5']) {
      expect(lookupPricing(id)).toEqual({ pricing: { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 }, known: true });
    }
    expect(lookupPricing('gpt-x')).toEqual({ pricing: { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 }, known: false });
    // copies, so a caller applying overrides cannot mutate the table
    lookupPricing('claude-sonnet-5').pricing.inputPerM = 99;
    expect(lookupPricing('claude-sonnet-5').pricing.inputPerM).toBe(2);
  });

  it('the default generator is OpenRouter z-ai/glm-5.3-flash, priced from the OpenRouter models API (2026-09-21)', () => {
    expect(DEFAULT_PROVIDER).toBe('openrouter');
    expect(DEFAULT_MODEL).toBe('z-ai/glm-5.3-flash');
    // $0.09/M prompt, $0.30/M completion, $0.018/M cache read; no cache-write rate listed, so 1.25 × input
    expect(lookupPricing('z-ai/glm-5.3-flash')).toEqual({ pricing: { inputPerM: 0.09, outputPerM: 0.3, cacheReadPerM: 0.018, cacheWritePerM: 0.09 * CACHE_WRITE_FACTOR }, known: true });
    expect(lookupPricing('Z-AI/GLM-5.3-Flash').known).toBe(true);
    expect(lookupPricing('z-ai/glm-5.3-flash').pricing.cacheWritePerM).toBeCloseTo(0.1125, 12);
    // the two siblings `--model` can switch to without the unpriced gate
    expect(lookupPricing('z-ai/glm-5.3-flashx')).toEqual({ pricing: { inputPerM: 0.37, outputPerM: 1.25, cacheReadPerM: 0.075, cacheWritePerM: 0.37 * CACHE_WRITE_FACTOR }, known: true });
    expect(lookupPricing('z-ai/glm-5.3')).toMatchObject({ pricing: { inputPerM: 0.91, outputPerM: 2.86 }, known: true });
    expect(lookupPricing('z-ai/glm-5.3').pricing.cacheReadPerM).toBeCloseTo(0.091, 12);
    expect(lookupPricing('z-ai/glm-5.3').pricing.cacheWritePerM).toBeCloseTo(1.1375, 12);
  });

  it('the $2.00 default spend cap buys 22,222,222 uncached input tokens or 6,666,666 output tokens of the default generator (Sonnet 5: 1,000,000 / 200,000)', () => {
    const glm = lookupPricing(DEFAULT_MODEL).pricing;
    const cap = DEFAULT_SPEND_CAP_USD;
    expect(cap).toBe(2);
    const inputTokens = Math.floor((cap / glm.inputPerM) * 1e6);
    const outputTokens = Math.floor((cap / glm.outputPerM) * 1e6);
    expect(inputTokens).toBe(22_222_222);
    expect(outputTokens).toBe(6_666_666);
    // the cost formula the providers fall back to agrees with the conversion (within one token's price)
    expect(costFromPricing(glm, { input: inputTokens, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeCloseTo(cap, 6);
    expect(costFromPricing(glm, { input: 0, cacheRead: 0, cacheWrite: 0, output: outputTokens })).toBeCloseTo(cap, 6);
    // a typical step (10k prompt of which 8k cached, 1k completion) costs well under a cent
    expect(costFromPricing(glm, { input: 2000, cacheRead: 8000, cacheWrite: 0, output: 1000 })).toBeCloseTo((2000 * 0.09 + 8000 * 0.018 + 1000 * 0.3) / 1e6, 12);
    const sonnet = lookupPricing('claude-sonnet-5').pricing;
    expect(Math.floor((cap / sonnet.inputPerM) * 1e6)).toBe(1_000_000);
    expect(Math.floor((cap / sonnet.outputPerM) * 1e6)).toBe(200_000);
    // ~22× cheaper on input, ~33× on output
    expect(sonnet.inputPerM / glm.inputPerM).toBeCloseTo(22.2, 1);
    expect(sonnet.outputPerM / glm.outputPerM).toBeCloseTo(33.3, 1);
  });

  it('the §3 table is complete: one spec per setting name, unique env names, secrets flagged', () => {
    const names = SETTINGS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(SETTINGS.filter((s) => s.secret).map((s) => s.name)).toEqual(['generator.apiKey', 'decider.apiKey']);
    const byName = new Map(SETTINGS.map((s) => [s.name, s]));
    expect(byName.get('generator.provider')?.defaultValue).toBe('openrouter');
    expect(byName.get('generator.model')?.defaultValue).toBe('z-ai/glm-5.3-flash');
    expect(byName.get('limits.spendCapUsd')?.defaultValue).toBe('2');
    expect(byName.get('limits.maxSteps')?.defaultValue).toBe('40');
    expect(byName.get('limits.maxWall')?.defaultValue).toBe('30m');
    expect(byName.get('limits.maxReplans')?.defaultValue).toBe('5');
    expect(byName.get('limits.completeThreshold')?.defaultValue).toBe('0.85');
    expect(byName.get('limits.impossibleThreshold')?.defaultValue).toBe('0.85');
    expect(byName.get('generator.maxTokens')?.defaultValue).toBe('4096');
    expect(byName.get('decider.model')?.defaultValue).toBe('typesafe/jev-1.13-20260917');
    expect(byName.get('decider.baseUrl')?.defaultValue).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(byName.get('decider.apiKey')?.env).toEqual(['JEV_API_KEY', 'OPENROUTER_API_KEY']);
  });
});

describe('mask', () => {
  it('fingerprint is the first 8 hex chars of SHA-256 and never part of the key', () => {
    const key = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789';
    expect(fingerprint(key)).toBe(sha256Hex(key).slice(0, 8));
    expect(fingerprint(key)).toMatch(/^[0-9a-f]{8}$/);
    expect(key).not.toContain(fingerprint(key));
  });

  it('maskEntries hides secrets as { source, fingerprint } and renders `<source> (sha256:...)`', () => {
    const entries = new Map<string, Resolved<string>>([
      ['generator.apiKey', { value: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789', source: 'flag' }],
      ['generator.model', { value: 'claude-sonnet-5', source: 'default' }],
    ]);
    const rec = maskEntries(entries, new Set(['generator.apiKey']));
    expect(rec['generator.apiKey']).toEqual({ value: { source: 'flag', fingerprint: fingerprint('sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789') }, source: 'flag' });
    expect(rec['generator.model']).toEqual({ value: 'claude-sonnet-5', source: 'default' });
    expect(formatRecordValue(rec['generator.apiKey']!)).toBe(`flag (sha256:${fingerprint('sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789')})`);
    const table = renderConfigTable(rec, { 'sandbox.level': 'seatbelt' });
    expect(table).not.toContain('sk-or-v1');
    expect(table).toContain('generator.apiKey');
    expect(table).toContain('sandbox.level');
    expect(table.split('\n')[0]).toMatch(/^setting\s+value\s+source$/);
  });
});

describe('priced / fail-closed / cache derivation / token cap (TUI-DESIGN §9.5, §16)', () => {
  type Name = Parameters<SettingReader['get']>[0];
  const mk = (values: Partial<Record<Name, string>>): SettingReader => ({
    get: (n) => (values[n] === undefined ? undefined : { value: values[n]!, source: 'env' }),
    sources: () => ['--x (flag)'],
  });
  const base: Partial<Record<Name, string>> = { 'generator.provider': 'anthropic', 'generator.model': 'claude-sonnet-5', 'generator.apiKey': 'anthropic-key-1234', 'generator.maxTokens': '4096', 'limits.spendCapUsd': '2' };

  it('deriveMaxGeneratorTokens = floor(spendCapUsd / 15 × 1e6); malformed caps use the $2.00 default', () => {
    expect(deriveMaxGeneratorTokens(2)).toBe(133_333);
    expect(deriveMaxGeneratorTokens(0.25)).toBe(16_666);
    expect(deriveMaxGeneratorTokens(Number.NaN)).toBe(133_333);
    expect(deriveMaxGeneratorTokens(-1)).toBe(133_333);
    expect(deriveMaxGeneratorTokens(1e-9)).toBe(1);
  });

  it('the §24 fail-closed message names both env vars and the flag', () => {
    expect(unpricedModelMessage('claude-x', 2)).toBe(
      'generator.model "claude-x" has no pricing entry, so the $2.000 spend cap could not be enforced. Set JEVCODE_PRICE_IN_PER_M and JEVCODE_PRICE_OUT_PER_M (USD per million tokens), or pass --allow-unpriced to run under a token cap instead.',
    );
    expect(unpricedModelMessage('m', Number.NaN)).toContain('$2.000');
  });

  it('a known model is priced with the table cache rates; both overrides make an unknown model priced', () => {
    const warns: string[] = [];
    const g = validateGenerator(mk(base), (m) => warns.push(m));
    expect(g.priced).toBe(true);
    expect(g.pricing).toEqual({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 });
    expect(warns).toEqual([]);
    const over = validateGenerator(mk({ ...base, 'generator.model': 'claude-next', 'generator.priceInPerM': '3', 'generator.priceOutPerM': '15' }), (m) => warns.push(m));
    expect(over.priced).toBe(true);
    expect(over.pricing).toEqual({ inputPerM: 3, outputPerM: 15, cacheReadPerM: expect.closeTo(0.3, 12), cacheWritePerM: 3.75 });
    expect(warns).toEqual([]);
    // explicit cache overrides win over the derivation
    const cache = validateGenerator(mk({ ...base, 'generator.model': 'claude-next', 'generator.priceInPerM': '3', 'generator.priceOutPerM': '15', 'generator.priceCacheReadPerM': '0.5', 'generator.priceCacheWritePerM': '4' }), () => undefined);
    expect(cache.pricing).toMatchObject({ cacheReadPerM: 0.5, cacheWritePerM: 4 });
  });

  it('an unpriced Anthropic model fails closed unless allowUnpriced; then it warns and runs under the token cap', () => {
    const reader = mk({ ...base, 'generator.model': 'claude-next' });
    let err: unknown;
    try {
      validateGenerator(reader, () => undefined);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).setting).toBe('generator.model');
    expect((err as ConfigError).exitCode).toBe(2);
    expect((err as ConfigError).message).toBe(unpricedModelMessage('claude-next', 2));
    const warns: string[] = [];
    const g = validateGenerator(reader, (m) => warns.push(m), { allowUnpriced: true });
    expect(g.priced).toBe(false);
    expect(g.pricing).toEqual({ inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 });
    expect(warns).toEqual(['generator.model "claude-next" has no pricing entry; running under a token cap of 133333 generator tokens (--allow-unpriced), figures render as $?']);
    // only one override → still unpriced
    expect(() => validateGenerator(mk({ ...base, 'generator.model': 'claude-next', 'generator.priceInPerM': '3' }), () => undefined)).toThrow(ConfigError);
  });

  it('OpenRouter keeps today\'s warning for an unpriced model (usage.cost prices it at run time)', () => {
    const warns: string[] = [];
    const g = validateGenerator(mk({ ...base, 'generator.provider': 'openrouter', 'generator.model': 'vendor/other' }), (m) => warns.push(m));
    expect(g.priced).toBe(false);
    expect(warns).toEqual(['generator.model "vendor/other" has no pricing entry; costs default to $0/M unless JEVCODE_PRICE_IN_PER_M and JEVCODE_PRICE_OUT_PER_M are set']);
  });

  it('validateLimits: maxGeneratorTokens only under allowUnpriced (configured, else derived); readAllowUnpriced parses booleans', () => {
    const lim: Partial<Record<Name, string>> = { 'limits.spendCapUsd': '2', 'limits.maxSteps': '40', 'limits.maxWall': '30m', 'limits.maxReplans': '5', 'limits.completeThreshold': '0.85', 'limits.impossibleThreshold': '0.85' };
    expect('maxGeneratorTokens' in validateLimits(mk(lim))).toBe(false);
    expect(validateLimits(mk({ ...lim, 'limits.allowUnpriced': 'true' })).maxGeneratorTokens).toBe(133_333);
    expect(validateLimits(mk(lim), { allowUnpriced: true }).maxGeneratorTokens).toBe(133_333);
    expect(validateLimits(mk({ ...lim, 'limits.allowUnpriced': 'yes', 'limits.maxGeneratorTokens': '200000' })).maxGeneratorTokens).toBe(200_000);
    expect(() => validateLimits(mk({ ...lim, 'limits.allowUnpriced': 'true', 'limits.maxGeneratorTokens': '0' }))).toThrow(/limits\.maxGeneratorTokens/);
    expect('maxGeneratorTokens' in validateLimits(mk({ ...lim, 'limits.maxGeneratorTokens': '200000' }))).toBe(false);
    expect(readAllowUnpriced(mk({}))).toBe(false);
    expect(readAllowUnpriced(mk({ 'limits.allowUnpriced': '1' }))).toBe(true);
    expect(() => readAllowUnpriced(mk({ 'limits.allowUnpriced': 'maybe' }))).toThrow(ConfigError);
  });
});
