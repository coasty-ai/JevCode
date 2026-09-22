/**
 * Normalisation per provider, against list bodies recorded live on 2026-09-21 (test/fixtures/models;
 * the Gemini page is hand-built from the documented Model resource because that key's project has
 * the Gemini API disabled).
 */
import { describe, expect, it } from 'vitest';
import { fireworksLabel, isChatModelId, listArray, nextPageQuery, parseModelList, pricingOf, roundRate, sortModels, supportsOf, titleCaseId } from '../../../src/models/parse.js';
import type { ModelInfo, ProviderId } from '../../../src/models/types.js';
import { fixture, model } from './helpers.js';

const AT = '2026-09-21T12:00:00.000Z';

function parse(provider: ProviderId, file: string, includeNonChat = false): ModelInfo[] {
  return parseModelList(provider, fixture(file), includeNonChat ? { updatedAt: AT, includeNonChat: true } : { updatedAt: AT });
}

function byId(models: readonly ModelInfo[], id: string): ModelInfo {
  const m = models.find((x) => x.id === id);
  if (m === undefined) throw new Error(`${id} not in [${models.map((x) => x.id).join(', ')}]`);
  return m;
}

describe('parse: OpenAI', () => {
  const models = parse('openai', 'openai-models.json');

  it('keeps only chat families and drops embeddings, audio, images, video, moderation and search wrappers', () => {
    expect(models.map((m) => m.id)).toEqual([
      'gpt-3.5-turbo',
      'gpt-4o',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-codex',
      'gpt-5.4-nano',
      'gpt-5.4-2026-03-05',
      'gpt-5.6-sol',
      'gpt-6-astra',
      'o3',
      'o4-mini',
      'chat-latest',
    ]);
  });

  it('carries nothing but the id: no context, no pricing, no capability flags', () => {
    const astra = byId(models, 'gpt-6-astra');
    expect(astra).toEqual({ id: 'gpt-6-astra', provider: 'openai', displayName: 'gpt-6-astra', supports: {}, updatedAt: AT });
  });

  it('marks a published shutdown_date as deprecated', () => {
    expect(byId(models, 'o4-mini').deprecated).toBe(true);
    expect(byId(models, 'gpt-5-codex').deprecated).toBe(true);
    expect(byId(models, 'gpt-6-astra').deprecated).toBeUndefined();
  });

  it('includeNonChat keeps the whole list', () => {
    const all = parse('openai', 'openai-models.json', true);
    expect(all).toHaveLength(22);
    expect(all.map((m) => m.id)).toContain('text-embedding-3-small');
  });
});

describe('parse: Anthropic', () => {
  const models = parse('anthropic', 'anthropic-models.json');

  it('reads the label, both token limits and the capability tree', () => {
    expect(byId(models, 'claude-fable-5-1')).toEqual({
      id: 'claude-fable-5-1',
      provider: 'anthropic',
      displayName: 'Claude Fable 5.1',
      contextLength: 1_000_000,
      maxOutput: 128_000,
      supports: { tools: true, structuredOutput: true, reasoning: true, vision: true },
      updatedAt: AT,
    });
  });

  it('asserts tool use for every listed model (a property of the Messages API, not a capability flag)', () => {
    expect(models.every((m) => m.supports.tools === true)).toBe(true);
  });

  it('never invents a price', () => {
    expect(models.every((m) => m.pricing === undefined)).toBe(true);
  });

  it('pages on has_more + last_id', () => {
    expect(nextPageQuery('anthropic', fixture('anthropic-models-page1.json'))).toEqual({ after_id: 'claude-sonnet-5' });
    expect(nextPageQuery('anthropic', fixture('anthropic-models-page2.json'))).toBeNull();
    expect(nextPageQuery('anthropic', fixture('anthropic-models.json'))).toBeNull();
  });
});

describe('parse: OpenRouter', () => {
  const models = parse('openrouter', 'openrouter-models.json');

  it('reads context, output cap, per-token pricing and supported_parameters', () => {
    expect(byId(models, 'z-ai/glm-5.3-flash')).toEqual({
      id: 'z-ai/glm-5.3-flash',
      provider: 'openrouter',
      displayName: 'Z.ai: GLM 5.3 Flash',
      contextLength: 1_310_720,
      maxOutput: 943_718,
      pricing: { inputPerM: 0.15, outputPerM: 0.5, cacheReadPerM: 0.05 },
      supports: { tools: true, structuredOutput: true, reasoning: true, vision: true },
      updatedAt: AT,
    });
  });

  it('converts per-token decimal strings to USD per million without float noise', () => {
    expect(byId(models, 'anthropic/claude-sonnet-5').pricing).toEqual({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2 });
  });

  it('keeps a free model priced at zero rather than unpriced', () => {
    const free = models.find((m) => m.id.endsWith(':free'));
    expect(free?.pricing).toEqual({ inputPerM: 0, outputPerM: 0 });
  });

  it('marks expiration_date as deprecated', () => {
    expect(models.filter((m) => m.deprecated === true).map((m) => m.id)).toEqual(['nex-agi/nex-n2.5-mini:free']);
  });

  it('reads structured-output support per model, not per provider', () => {
    expect(byId(models, 'inclusionai/ling-3.0-flash-vl:free').supports.structuredOutput).toBe(false);
  });

  it('drops a model that cannot output text', () => {
    const body = {
      data: [
        { id: 'vendor/text-model', name: 'Text', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
        { id: 'vendor/image-model', name: 'Image', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
      ],
    };
    expect(parseModelList('openrouter', body, { updatedAt: AT }).map((m) => m.id)).toEqual(['vendor/text-model']);
    expect(parseModelList('openrouter', body, { updatedAt: AT, includeNonChat: true })).toHaveLength(2);
  });

  it('falls back to the reasoning block when supported_parameters is absent', () => {
    const body = { data: [{ id: 'vendor/m', name: 'M', reasoning: { mandatory: true, default_effort: 'max' } }] };
    expect(parseModelList('openrouter', body, { updatedAt: AT })[0]?.supports).toEqual({ reasoning: true });
  });
});

describe('parse: Gemini', () => {
  const models = parse('gemini', 'gemini-models.json');

  it('uses baseModelId, both token limits and the thinking flag', () => {
    expect(byId(models, 'gemini-3.8-flash')).toEqual({
      id: 'gemini-3.8-flash',
      provider: 'gemini',
      displayName: 'Gemini 3.8 Flash',
      contextLength: 1_048_576,
      maxOutput: 65_536,
      supports: { reasoning: true },
      updatedAt: AT,
    });
    expect(byId(models, 'gemini-2.5-flash-lite').supports).toEqual({ reasoning: false });
  });

  it('drops models without generateContent', () => {
    expect(models.map((m) => m.id)).not.toContain('text-embedding-004');
  });

  it('strips the models/ prefix when baseModelId is absent', () => {
    const body = { models: [{ name: 'models/gemini-x', displayName: 'X', supportedGenerationMethods: ['generateContent'] }] };
    expect(parseModelList('gemini', body, { updatedAt: AT })[0]?.id).toBe('gemini-x');
  });

  it('pages on nextPageToken', () => {
    expect(nextPageQuery('gemini', fixture('gemini-models.json'))).toEqual({ pageToken: 'page-2-token' });
    expect(nextPageQuery('gemini', fixture('gemini-models-page2.json'))).toBeNull();
  });
});

describe('parse: xAI', () => {
  it('decodes the 1e-10 USD per token price unit (grok-4.7 = $2.00 / $0.50 / $6.00 per M)', () => {
    const models = parse('xai', 'xai-models.json');
    expect(byId(models, 'grok-4.7').pricing).toEqual({ inputPerM: 2, outputPerM: 6, cacheReadPerM: 0.5 });
    expect(byId(models, 'grok-4.3').pricing).toEqual({ inputPerM: 1.25, outputPerM: 2.5, cacheReadPerM: 0.2 });
    expect(byId(models, 'grok-4.7').contextLength).toBe(500_000);
  });

  it('drops the image and video families', () => {
    expect(parse('xai', 'xai-models.json').map((m) => m.id)).toEqual(['grok-4.7', 'grok-4.3', 'grok-build-0.1']);
  });

  it('also parses the /v1/language-models shape, where modalities replace the context window', () => {
    const models = parse('xai', 'xai-language-models.json');
    expect(models.map((m) => m.id).sort()).toEqual(['grok-4.3', 'grok-4.7']);
    expect(byId(models, 'grok-4.7').supports).toEqual({ vision: true });
    expect(byId(models, 'grok-4.7').contextLength).toBeUndefined();
  });
});

describe('parse: Fireworks', () => {
  const models = parse('fireworks', 'fireworks-models.json');

  it('reads the explicit capability flags and the context window', () => {
    expect(byId(models, 'accounts/fireworks/models/kimi-k3')).toEqual({
      id: 'accounts/fireworks/models/kimi-k3',
      provider: 'fireworks',
      displayName: 'kimi-k3',
      contextLength: 1_048_576,
      supports: { tools: true, structuredOutput: true, vision: true },
      updatedAt: AT,
    });
  });

  it('drops embedding models and labels routers', () => {
    expect(models.map((m) => m.id)).not.toContain('accounts/fireworks/models/qwen3-embedding-8b');
    expect(byId(models, 'accounts/fireworks/routers/kimi-k3-fast').displayName).toBe('kimi-k3-fast (router)');
  });

  it('omits the context window when the wire has none', () => {
    expect(byId(models, 'accounts/fireworks/models/qwen3p8-max').contextLength).toBeUndefined();
  });
});

describe('parse: Meta', () => {
  const models = parse('meta', 'meta-models.json');

  it('keeps the text models and title-cases the ids', () => {
    expect(models.map((m) => m.id).sort()).toEqual(['muse-spark-1.1', 'muse-spark-1.2', 'muse-spark-1.2-contributor', 'muse-spark-1.3', 'muse-spark-1.3-contributor']);
    expect(byId(models, 'muse-spark-1.3-contributor').displayName).toBe('Muse Spark 1.3 Contributor');
  });

  it('drops the image, voice and segmentation models', () => {
    const ids = models.map((m) => m.id);
    expect(ids).not.toContain('muse-image-1.0');
    expect(ids).not.toContain('muse-voice-transcribe-1.0');
    expect(ids).not.toContain('sam-3.1');
  });
});

describe('parse: robustness', () => {
  it('a foreign body yields no models instead of throwing', () => {
    for (const provider of ['openai', 'anthropic', 'openrouter', 'gemini', 'xai', 'fireworks', 'meta'] as const) {
      expect(parseModelList(provider, { error: { message: 'nope' } }, { updatedAt: AT })).toEqual([]);
      expect(parseModelList(provider, { data: 'not-an-array' }, { updatedAt: AT })).toEqual([]);
      expect(parseModelList(provider, { data: [null, 7, 'x', {}] }, { updatedAt: AT })).toEqual([]);
    }
  });

  it('ignores wrong-typed fields rather than trusting them', () => {
    const body = { data: [{ id: 'z-ai/m', name: 42, context_length: 'huge', pricing: { prompt: 'free', completion: null }, supported_parameters: 'tools' }] };
    expect(parseModelList('openrouter', body, { updatedAt: AT })[0]).toEqual({ id: 'z-ai/m', provider: 'openrouter', displayName: 'z-ai/m', supports: {}, updatedAt: AT });
  });

  it('listArray finds the provider-specific list key', () => {
    expect(listArray('gemini', { models: [1, 2] })).toHaveLength(2);
    expect(listArray('xai', { models: [1] })).toHaveLength(1);
    expect(listArray('xai', { data: [1, 2, 3] })).toHaveLength(3);
    expect(listArray('openai', { models: [1] })).toHaveLength(0);
  });
});

describe('parse: helpers', () => {
  it('roundRate removes binary-float noise', () => {
    expect(roundRate(0.00000005 * 1e6)).toBe(0.05);
    expect(roundRate(1 / 3)).toBe(0.333333);
  });

  it('pricingOf rejects unusable rates', () => {
    expect(pricingOf(null, 1)).toBeUndefined();
    expect(pricingOf(1, -1)).toBeUndefined();
    expect(pricingOf(Number.NaN, 1)).toBeUndefined();
    expect(pricingOf(1, 2)).toEqual({ inputPerM: 1, outputPerM: 2 });
    expect(pricingOf(1, 2, null)).toEqual({ inputPerM: 1, outputPerM: 2 });
  });

  it('supportsOf omits unstated flags', () => {
    expect(supportsOf({})).toEqual({});
    expect(supportsOf({ tools: false })).toEqual({ tools: false });
  });

  it('fireworksLabel and titleCaseId', () => {
    expect(fireworksLabel('accounts/fireworks/models/glm-5p3-flash')).toBe('glm-5.3-flash');
    expect(fireworksLabel('accounts/fireworks/routers/glm-5p2-fast')).toBe('glm-5.2-fast (router)');
    expect(titleCaseId('muse-spark-1.3')).toBe('Muse Spark 1.3');
    expect(titleCaseId('muse_voice_transcribe-1.0')).toBe('Muse Voice Transcribe 1.0');
  });

  it('isChatModelId is provider-specific', () => {
    expect(isChatModelId('openai', 'gpt-5.6-sol')).toBe(true);
    expect(isChatModelId('openai', 'gpt-image-2')).toBe(false);
    expect(isChatModelId('openai', 'text-embedding-3-small')).toBe(false);
    expect(isChatModelId('xai', 'grok-imagine-video')).toBe(false);
    expect(isChatModelId('meta', 'sam-3.1')).toBe(false);
    expect(isChatModelId('anthropic', 'anything')).toBe(true);
  });

  it('sortModels dedupes and orders live-first, then provider, then id', () => {
    const sorted = sortModels([
      model({ id: 'b', provider: 'openai' }),
      model({ id: 'a', provider: 'openai', deprecated: true }),
      model({ id: 'a', provider: 'openai', deprecated: true }),
      model({ id: 'a', provider: 'anthropic' }),
    ]);
    expect(sorted.map((m) => `${m.provider}/${m.id}`)).toEqual(['anthropic/a', 'openai/b', 'openai/a']);
  });
});
