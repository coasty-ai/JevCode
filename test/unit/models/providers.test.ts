/** The provider table: URLs, headers, key env names and the id heuristic. */
import { describe, expect, it } from 'vitest';
import { BASE_URLS } from '../../../src/config/defaults.js';
import {
  GENERATOR_PROVIDERS,
  PROVIDERS,
  PROVIDER_IDS,
  authHeaders,
  isGeneratorProvider,
  isProviderId,
  keyCheckUrl,
  keyEnvNames,
  keyFromEnv,
  keysFromEnv,
  listUrl,
  providerDisplayName,
  providerFromModelId,
  providerSpec,
  providersWithKeys,
  resolveBaseUrl,
} from '../../../src/models/providers.js';

describe('the table', () => {
  it('covers every id exactly once, in a stable display order', () => {
    expect([...PROVIDER_IDS].sort()).toEqual(Object.keys(PROVIDERS).sort());
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length);
    expect(PROVIDER_IDS.slice(0, 2)).toEqual(['anthropic', 'openrouter']);
  });

  it('names a key env var, a key URL and a display name for every provider', () => {
    for (const id of PROVIDER_IDS) {
      expect(keyEnvNames(id).length, id).toBeGreaterThan(0);
      expect(providerDisplayName(id).trim(), id).not.toBe('');
      expect(providerSpec(id).keyUrl.startsWith('https://'), id).toBe(true);
    }
  });

  it('knows which providers a run can generate with today', () => {
    expect(GENERATOR_PROVIDERS).toEqual(['anthropic', 'openrouter']);
    expect(isGeneratorProvider('anthropic')).toBe(true);
    expect(isGeneratorProvider('meta')).toBe(false);
  });

  it('isProviderId guards an untrusted string', () => {
    expect(isProviderId('openai')).toBe(true);
    expect(isProviderId('nope')).toBe(false);
    expect(isProviderId('toString')).toBe(false);
  });
});

describe('URLs', () => {
  it('builds the documented list URL for every provider', () => {
    expect(listUrl('anthropic')).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(listUrl('openai')).toBe('https://api.openai.com/v1/models');
    expect(listUrl('openrouter')).toBe('https://openrouter.ai/api/v1/models');
    expect(listUrl('gemini')).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
    expect(listUrl('xai')).toBe('https://api.x.ai/v1/models');
    expect(listUrl('fireworks')).toBe('https://api.fireworks.ai/inference/v1/models');
    expect(listUrl('meta')).toBe('https://api.meta.ai/v1/models');
  });

  it('accepts a base URL with or without the version segment (config/defaults.ts spells them differently)', () => {
    expect(resolveBaseUrl('anthropic', BASE_URLS.anthropic)).toBe('https://api.anthropic.com/v1');
    expect(resolveBaseUrl('openrouter', BASE_URLS.openrouter)).toBe('https://openrouter.ai/api/v1');
    expect(resolveBaseUrl('openai', 'https://gw.test/v1/')).toBe('https://gw.test/v1');
    expect(resolveBaseUrl('openai', 'https://gw.test')).toBe('https://gw.test/v1');
    expect(resolveBaseUrl('openai', '  ')).toBe('https://api.openai.com/v1');
  });

  it('adds pagination cursors to the query', () => {
    expect(listUrl('anthropic', undefined, { after_id: 'x' })).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=x');
    expect(listUrl('gemini', undefined, { pageToken: 'a b' })).toContain('pageToken=a+b');
  });

  it('only the providers with a public list have a key-check URL', () => {
    expect(keyCheckUrl('openrouter')).toBe('https://openrouter.ai/api/v1/key');
    expect(keyCheckUrl('xai')).toBe('https://api.x.ai/v1/api-key');
    expect(keyCheckUrl('openai')).toBeNull();
    expect(keyCheckUrl('anthropic')).toBeNull();
  });
});

describe('auth headers', () => {
  it('uses each provider scheme', () => {
    expect(authHeaders('anthropic', 'k')).toEqual({ accept: 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
    expect(authHeaders('gemini', 'k')).toEqual({ accept: 'application/json', 'x-goog-api-key': 'k' });
    expect(authHeaders('openai', 'k')['authorization']).toBe('Bearer k');
    expect(authHeaders('xai', 'k')['authorization']).toBe('Bearer k');
    expect(authHeaders('fireworks', 'k')['authorization']).toBe('Bearer k');
    expect(authHeaders('meta', 'k')['authorization']).toBe('Bearer k');
  });

  it('identifies the app to OpenRouter', () => {
    const h = authHeaders('openrouter', 'k');
    expect(h['authorization']).toBe('Bearer k');
    expect(h['http-referer']).toContain('jevcode');
    expect(h['x-title']).toBe('jevcode');
  });

  it('sends no auth header at all when there is no key', () => {
    expect(authHeaders('openai', null)['authorization']).toBeUndefined();
    expect(authHeaders('openai', '   ')['authorization']).toBeUndefined();
    // the version header is not auth and is always sent
    expect(authHeaders('anthropic', null)['anthropic-version']).toBe('2023-06-01');
  });
});

describe('keys from the environment', () => {
  it('reads the documented variable per provider', () => {
    const env = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', OPENROUTER_API_KEY: 'r', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x', FIREWORKS_API_KEY: 'f', META_API_KEY: 'm' };
    expect(keysFromEnv(env)).toEqual({ anthropic: 'a', openai: 'o', openrouter: 'r', gemini: 'g', xai: 'x', fireworks: 'f', meta: 'm' });
    expect(providersWithKeys(env)).toEqual(PROVIDER_IDS);
  });

  // provider/ids.ts owns the order and puts jevcode's name first, so GEMINI_API_KEY wins over the Google SDKs'
  // own precedence ("If both are set, GOOGLE_API_KEY takes precedence"); GOOGLE_API_KEY is still accepted alone.
  it("prefers jevcode's GEMINI_API_KEY over GOOGLE_API_KEY, and still reads GOOGLE_API_KEY", () => {
    expect(keyFromEnv('gemini', { GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'goog' })).toBe('g');
    expect(keyFromEnv('gemini', { GOOGLE_API_KEY: 'goog' })).toBe('goog');
    expect(keyFromEnv('gemini', { GEMINI_API_KEY: 'g' })).toBe('g');
  });

  it('accepts the Meta Model API name as a fallback', () => {
    expect(keyFromEnv('meta', { MODEL_API_KEY: 'llm|1|x' })).toBe('llm|1|x');
    expect(keyFromEnv('meta', { META_API_KEY: 'a', MODEL_API_KEY: 'b' })).toBe('a');
  });

  it('an empty or blank value counts as unset', () => {
    expect(keyFromEnv('openai', { OPENAI_API_KEY: '' })).toBeNull();
    expect(keyFromEnv('openai', { OPENAI_API_KEY: '   ' })).toBeNull();
    expect(keysFromEnv({})).toEqual({});
    expect(providersWithKeys({})).toEqual([]);
  });

  it('trims the value it returns', () => {
    expect(keyFromEnv('openai', { OPENAI_API_KEY: ' sk-x \n' })).toBe('sk-x');
  });
});

describe('providerFromModelId', () => {
  it('classifies the id shapes seen live', () => {
    expect(providerFromModelId('z-ai/glm-5.3-flash')).toBe('openrouter');
    expect(providerFromModelId('anthropic/claude-sonnet-5')).toBe('openrouter');
    expect(providerFromModelId('accounts/fireworks/models/kimi-k3')).toBe('fireworks');
    expect(providerFromModelId('claude-opus-5')).toBe('anthropic');
    expect(providerFromModelId('gemini-3.8-flash')).toBe('gemini');
    expect(providerFromModelId('grok-4.7')).toBe('xai');
    expect(providerFromModelId('muse-spark-1.3')).toBe('meta');
    expect(providerFromModelId('gpt-6-astra')).toBe('openai');
    expect(providerFromModelId('o4-mini')).toBe('openai');
    expect(providerFromModelId('o3')).toBe('openai');
    expect(providerFromModelId('chatgpt-image-latest')).toBe('openai');
  });

  it('says nothing rather than guessing', () => {
    expect(providerFromModelId('mystery-model')).toBeNull();
    expect(providerFromModelId('')).toBeNull();
    expect(providerFromModelId('   ')).toBeNull();
  });
});
