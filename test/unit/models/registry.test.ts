/**
 * provider/registry.ts — completeness of the table and the three lookups, plus the two catalogue readers that live in
 * the registry (Anthropic and OpenRouter). Every catalogue fixture was recorded from the live endpoint on 2026-09-21.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, ProviderHttpError } from '../../../src/errors.js';
import { PROVIDERS, PROVIDER_IDS, anthropicModelInfo, createProvider, keyEnvFor, listAnthropicModels, listOpenRouterModels, openRouterModelInfo, providerFor, requireProvider } from '../../../src/provider/registry.js';
import { pricingFor, priceRowFor, isKnownPrice } from '../../../src/provider/pricing.js';
import type { GenerationProvider, ProviderConfig } from '../../../src/provider/types.js';
import type { GeneratorConfig, Provider } from '../../../src/core/types.js';
import { FAKE_KEYS, fixture, providerDeps, scriptedFetch } from '../provider/helpers.js';

const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  model: 'm',
  apiKey: 'k',
  baseUrl: 'https://example.invalid/v1',
  temperature: null,
  maxTokens: 64,
  pricing: { inputPerM: 1, outputPerM: 1, cacheReadPerM: 1, cacheWritePerM: 1 },
  ...over,
});

describe('PROVIDERS', () => {
  it('covers the seven generator surfaces with unique ids and key env vars', () => {
    // PROVIDER_IDS comes from provider/ids.ts (the importless source of truth), so it is that file's display
    // order rather than the order of the rows below — the set is what has to match, and it does.
    expect(PROVIDER_IDS).toEqual(['anthropic', 'openrouter', 'openai', 'gemini', 'xai', 'fireworks', 'meta']);
    expect([...PROVIDER_IDS].sort()).toEqual(PROVIDERS.map((p) => p.id).sort());
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
    expect(new Set(PROVIDERS.map((p) => p.keyEnv)).size).toBe(PROVIDERS.length);
    // typesafe is the decider endpoint (jev/providers.ts), not a generator: it must not appear here
    expect(PROVIDER_IDS).not.toContain('typesafe');
    expect(PROVIDER_IDS).not.toContain('mock');
  });

  it('every row is complete: a factory, a catalogue, a default model, a docs link and a plausible base URL', () => {
    for (const spec of PROVIDERS) {
      expect(typeof spec.create, spec.id).toBe('function');
      expect(typeof spec.listModels, spec.id).toBe('function');
      expect(spec.keyEnv, spec.id).toMatch(/^[A-Z][A-Z0-9_]*_API_KEY$/);
      expect(spec.baseUrl, spec.id).toMatch(/^https:\/\//);
      expect(spec.baseUrl.endsWith('/'), spec.id).toBe(false);
      expect(spec.defaultModel.length, spec.id).toBeGreaterThan(0);
      expect(spec.docsUrl, spec.id).toMatch(/^https:\/\//);
      expect(spec.displayName.length, spec.id).toBeGreaterThan(0);
      // the harness only works with a tool-calling generator
      expect(spec.supports.tools, spec.id).toBe(true);
    }
  });

  it('each factory returns a provider named after its row and carrying the configured model', () => {
    const deps = { redact: (s: string) => s };
    for (const spec of PROVIDERS) {
      const p = createProvider(spec, cfg({ model: spec.defaultModel, baseUrl: spec.baseUrl }), deps);
      expect(p.name, spec.id).toBe(spec.id);
      expect(p.model, spec.id).toBe(spec.defaultModel);
      expect(typeof p.generate, spec.id).toBe('function');
    }
  });

  it("every catalogue routes its error body through the caller's redactor — a gateway that echoes the key never reaches state.json", async () => {
    // `listModels` takes a REQUIRED deps bag for this reason: a proxy that quotes the Authorization header or a
    // `?key=` URL back in its 401 would otherwise put the key in `ProviderHttpError.body` / `.message`, and from
    // there into the epilogue and state.json (§10 F9) — which a default identity redactor would have allowed.
    const keys: Record<string, string> = { anthropic: 'sk-ant-test-key-000000000000000000000000', openrouter: 'sk-or-v1-testkey000000000000000000000000000000', ...FAKE_KEYS };
    for (const spec of PROVIDERS) {
      const key = keys[spec.id]!;
      const body = JSON.stringify({ error: { message: `Invalid API key ${key} (sent as ?key=${key})`, type: 'authentication_error', code: 'invalid_api_key' } });
      const f = scriptedFetch([{ status: 401, body }]);
      const { deps } = providerDeps(f.fetch);
      const err = await spec.listModels(key, deps).catch((e: unknown) => e);
      expect(err, spec.id).toBeInstanceOf(ProviderHttpError);
      const http = err as ProviderHttpError;
      const dumped = `${http.message}\n${http.body}\n${JSON.stringify(http.toJSON())}`;
      expect(dumped, spec.id).not.toContain(key);
      expect(dumped, spec.id).toContain('[REDACTED:pattern]');
      // and the key travelled in a header, never in the URL or the query
      expect(f.calls[0]!.url, spec.id).not.toContain(key);
    }
  });

  it('names the one provider that cannot be asked for a specific tool', () => {
    const limited = PROVIDERS.filter((p) => p.forcedToolLimitation !== undefined).map((p) => p.id);
    expect(limited).toEqual(['meta']);
    expect(providerFor('meta')!.forcedToolLimitation).toContain('tool_choice');
  });

  it('every default model is either priced or explicitly marked unpriced in the table', () => {
    for (const spec of PROVIDERS) {
      const row = priceRowFor(spec.id, spec.defaultModel);
      expect(row, `${spec.id} ${spec.defaultModel}`).not.toBeNull();
      if (isKnownPrice(row!)) expect(pricingFor(spec.id, spec.defaultModel)!.inputPerM).toBeGreaterThan(0);
      else expect(pricingFor(spec.id, spec.defaultModel)).toBeNull();
    }
    // every default model is priced (Meta's catalogue publishes the muse-spark rates since 2026-09-23), so a run under a spend cap never refuses a default
    expect(PROVIDERS.filter((p) => pricingFor(p.id, p.defaultModel) === null).map((p) => p.id)).toEqual([]);
  });
});

describe('the contract with core', () => {
  it('a core GeneratorConfig is a ProviderConfig, and a core Provider is a GenerationProvider (compile-time)', () => {
    // These two assignments are the whole bridge to src/core/types.ts: they must keep compiling, and when the core
    // owner widens `ProviderName` / `GeneratorConfig.provider` to `ProviderId` the reverse assignment compiles too.
    const generatorConfig: GeneratorConfig = { provider: 'openrouter', model: 'm', apiKey: 'k', baseUrl: 'https://x.invalid', temperature: null, maxTokens: 8, pricing: cfg().pricing, priced: true };
    const asProviderConfig: ProviderConfig = generatorConfig;
    expect(asProviderConfig.model).toBe('m');

    const coreProvider: Provider = { name: 'mock', model: 'm', generate: () => Promise.reject(new Error('unused')) };
    const asGeneration: GenerationProvider = coreProvider;
    expect(asGeneration.name).toBe('mock');
  });
});

describe('lookups', () => {
  it('providerFor / keyEnvFor answer for known ids and return null otherwise', () => {
    expect(providerFor('openai')!.displayName).toBe('OpenAI');
    expect(providerFor('  XAI ')!.id).toBe('xai');
    expect(providerFor('typesafe')).toBeNull();
    expect(providerFor('nope')).toBeNull();
    expect(keyEnvFor('gemini')).toBe('GEMINI_API_KEY');
    expect(keyEnvFor('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(keyEnvFor('mock')).toBeNull();
  });

  it('requireProvider throws a ConfigError that lists every id', () => {
    expect(requireProvider('fireworks').id).toBe('fireworks');
    let err: unknown;
    try {
      requireProvider('llama');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).setting).toBe('generator.provider');
    expect((err as Error).message).toContain('unknown provider "llama"');
    for (const id of PROVIDER_IDS) expect((err as Error).message).toContain(id);
  });
});

describe('the catalogues that live in the registry', () => {
  it('reads the Anthropic model list, including the capability flags', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('anthropic-models.json') }]);
    const { deps } = providerDeps(f.fetch);
    const models = await listAnthropicModels('sk-ant-test-key-000000000000000000000000', deps);
    expect(models.map((m) => m.id)).toEqual(['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5']);
    expect(models[0]).toMatchObject({ displayName: 'Claude Fable 5.1', contextTokens: 1_000_000, maxOutputTokens: 128_000, tools: true, reasoning: true, vision: true });
    expect(f.calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(f.calls[0]!.headers['x-api-key']).toBe('sk-ant-test-key-000000000000000000000000');
    expect(anthropicModelInfo({ id: 'x' })).toEqual({ id: 'x', tools: true });
    expect(anthropicModelInfo({ display_name: 'no id' })).toBeNull();
  });

  it('reads the OpenRouter catalogue, converting its per-token price strings to per-million', async () => {
    const f = scriptedFetch([{ status: 200, body: fixture('openrouter-models.json') }]);
    const { deps } = providerDeps(f.fetch);
    const models = await listOpenRouterModels('sk-or-v1-testkey000000000000000000000000000000', deps);
    const glm = models.find((m) => m.id === 'z-ai/glm-5.3-flash')!;
    expect(glm.displayName).toBe('Z.ai: GLM 5.3 Flash');
    expect(glm.contextTokens).toBe(1_310_720);
    expect(glm.tools).toBe(true);
    expect(glm.reasoning).toBe(true);
    expect(glm.vision).toBe(true);
    expect(glm.pricing!.inputPerM).toBeCloseTo(0.15, 12);
    expect(glm.pricing!.outputPerM).toBeCloseTo(0.5, 12);
    expect(glm.pricing!.cacheReadPerM).toBeCloseTo(0.05, 12);
    // OpenRouter lists no cache-write rate for this model: the 1.25x convention fills it in
    expect(glm.pricing!.cacheWritePerM).toBeCloseTo(0.15 * 1.25, 12);
    expect(f.calls[0]!.headers['http-referer']).toMatch(/coasty-ai\/JevCode|jevcode/i);
    // a model that cannot emit text is not a generator
    expect(openRouterModelInfo({ id: 'x/image', architecture: { output_modalities: ['image'] } })).toBeNull();
  });

  it('a catalogue GET that fails surfaces the typed provider error', async () => {
    const f = scriptedFetch([{ status: 401, body: '{"error":{"message":"invalid key","type":"authentication_error"}}' }]);
    const { deps } = providerDeps(f.fetch);
    await expect(listAnthropicModels('bad', deps)).rejects.toMatchObject({ status: 401, retryable: false });
  });
});
