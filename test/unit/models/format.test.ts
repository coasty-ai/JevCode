/** The strings a picker prints: rows, provenance and failure copy. */
import { describe, expect, it } from 'vitest';
import { capabilitySummary, catalogueSummary, contextSummary, errorLabel, modelSummary, relativeAge, sourceLabel } from '../../../src/models/format.js';
import { SNAPSHOT_AT } from '../../../src/models/static.js';
import type { ListResult } from '../../../src/models/types.js';
import { T0, model } from './helpers.js';

const GLM = model({
  id: 'z-ai/glm-5.3-flash',
  provider: 'openrouter',
  displayName: 'Z.ai: GLM 5.3 Flash',
  contextLength: 1_310_720,
  maxOutput: 943_718,
  pricing: { inputPerM: 0.15, outputPerM: 0.5, cacheReadPerM: 0.05 },
  supports: { tools: true, structuredOutput: true, reasoning: true, vision: true },
});

describe('row text', () => {
  it('summarises capabilities in a fixed order, true flags only', () => {
    expect(capabilitySummary(GLM.supports)).toBe('tools · json · reasoning · vision');
    expect(capabilitySummary({ vision: true, tools: true })).toBe('tools · vision');
    expect(capabilitySummary({ tools: false })).toBe('');
    expect(capabilitySummary({})).toBe('');
  });

  it('summarises the window', () => {
    expect(contextSummary(GLM)).toBe('1.3M ctx → 944k out');
    expect(contextSummary(model({ id: 'x', contextLength: 200_000 }))).toBe('200k ctx');
    expect(contextSummary(model({ id: 'x' }))).toBe('');
  });

  it('builds one picker row', () => {
    expect(modelSummary(GLM)).toBe('z-ai/glm-5.3-flash · OpenRouter · 1.3M ctx → 944k out · $0.15/M in · $0.50/M out · $0.05/M cached · tools · json · reasoning · vision');
  });

  it('degrades gracefully for a model the wire told us nothing about', () => {
    expect(modelSummary(model({ id: 'chat-latest', provider: 'openai' }))).toBe('chat-latest · OpenAI · unpriced');
  });

  it('flags a deprecated model', () => {
    expect(modelSummary(model({ id: 'gpt-3.5-turbo', provider: 'openai', deprecated: true }))).toContain('· deprecated');
  });
});

describe('provenance', () => {
  const at = (source: ListResult['source'], fetchedAt: string): ListResult => ({ provider: 'openai', models: [], source, fetchedAt, stale: source !== 'network' });

  it('names the source and the age', () => {
    expect(sourceLabel(at('network', new Date(T0).toISOString()), T0)).toBe('live');
    expect(sourceLabel(at('cache', new Date(T0 - 3 * 3600_000).toISOString()), T0)).toBe('cached 3 h ago');
    expect(sourceLabel(at('static', SNAPSHOT_AT), T0)).toBe('bundled snapshot');
  });

  it('spells ages in the unit a human would use', () => {
    expect(relativeAge(new Date(T0).toISOString(), T0)).toBe('just now');
    expect(relativeAge(new Date(T0 - 12 * 60_000).toISOString(), T0)).toBe('12 min ago');
    expect(relativeAge(new Date(T0 - 2 * 86_400_000).toISOString(), T0)).toBe('2 d ago');
    expect(relativeAge('not-a-date', T0)).toBe('unknown');
    // a clock that went backwards reads as "just now", never as a negative age
    expect(relativeAge(new Date(T0 + 60_000).toISOString(), T0)).toBe('just now');
  });

  it('summarises a whole load', () => {
    const results: ListResult[] = [
      { provider: 'openai', models: [GLM], source: 'network', fetchedAt: SNAPSHOT_AT, stale: false },
      { provider: 'meta', models: [], source: 'static', fetchedAt: SNAPSHOT_AT, stale: true, error: { kind: 'no_key', status: null, message: 'x', retryable: false } },
    ];
    expect(catalogueSummary(results)).toBe('2 providers · 1 model · 1 unavailable');
    expect(catalogueSummary([])).toBe('0 providers · 0 models');
  });
});

describe('error copy', () => {
  it('names the env var when a key is missing', () => {
    expect(errorLabel('openai', { kind: 'no_key', status: null, message: '', retryable: false })).toBe('OpenAI: no API key — set OPENAI_API_KEY');
    expect(errorLabel('gemini', { kind: 'no_key', status: null, message: '', retryable: false })).toContain('GEMINI_API_KEY');
  });

  it('has a line for every failure kind', () => {
    const kinds = ['auth', 'rate_limit', 'network', 'invalid', 'http'] as const;
    for (const kind of kinds) {
      const label = errorLabel('openrouter', { kind, status: 500, message: 'x', retryable: true });
      expect(label.startsWith('OpenRouter: '), kind).toBe(true);
      expect(label.length, kind).toBeGreaterThan('OpenRouter: '.length);
    }
    expect(errorLabel('openai', { kind: 'auth', status: 403, message: '', retryable: false })).toBe('OpenAI: key rejected (403)');
    expect(errorLabel('openai', { kind: 'http', status: null, message: '', retryable: false })).toBe('OpenAI: catalogue request failed (HTTP 0)');
  });
});
