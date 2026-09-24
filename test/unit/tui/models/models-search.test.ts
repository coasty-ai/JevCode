/**
 * TUI-DESIGN-5 §10 R5-6 `models-search.test.ts`: the did-you-mean list (§7 row 75); routing variants behind their
 * standard route on the empty query but findable by name (§7 row 76).
 *
 * The ranking itself is `src/models/search.ts`'s (harness-owned, already unit-tested there). What this file pins is
 * the **picker's** use of it: which rows the opened picker shows first, and what `/model <id>` says on a miss.
 */
import { describe, expect, it } from 'vitest';
import { instantCatalogue } from '../../../../src/models/list.js';
import { isRoutingVariant } from '../../../../src/models/search.js';
import { INITIAL_MODELS, modelsReducer, visibleModels } from '../../../../src/tui/models/state.js';
import { modelCheck, noModelNamedText } from '../../../../src/tui/models/lines.js';
import { API, model } from './helpers.js';

const VARIANTS = [
  model('z-ai/glm-5.3-flash', 'openrouter', { pricing: { inputPerM: 0.15, outputPerM: 0.5 } }),
  model('z-ai/glm-5.3-flash:free', 'openrouter', { pricing: { inputPerM: 0, outputPerM: 0 } }),
  model('z-ai/glm-5.3-flash:batch', 'openrouter', { pricing: { inputPerM: 0.07, outputPerM: 0.25 } }),
  model('z-ai/glm-5.3-flash:nitro', 'openrouter', { pricing: { inputPerM: 0.2, outputPerM: 0.6 } }),
];

describe('routing variants (§7 row 76)', () => {
  const open = modelsReducer(INITIAL_MODELS, { type: 'open', models: VARIANTS });

  it('the empty query puts the standard route first, even though :free prices at $0', () => {
    const ids = visibleModels(open, API, '').hits.map((h) => h.model.id);
    expect(ids[0]).toBe('z-ai/glm-5.3-flash');
    expect(ids.slice(1).every((id) => isRoutingVariant(id))).toBe(true);
  });

  it('every variant is still in the list — ranked behind, never hidden', () => {
    expect(visibleModels(open, API, '').hits).toHaveLength(4);
  });

  it('an explicit query finds the variant by name', () => {
    expect(visibleModels(open, API, 'glm-5.3-flash:free').hits[0]?.model.id).toBe('z-ai/glm-5.3-flash:free');
    expect(visibleModels(open, API, ':nitro').hits.some((h) => h.model.id === 'z-ai/glm-5.3-flash:nitro')).toBe(true);
  });

  it('`/model <variant>` resolves exactly, with no near-miss detour', () => {
    expect(modelCheck('z-ai/glm-5.3-flash:batch', VARIANTS, true, API).kind).toBe('ok');
  });
});

describe('the did-you-mean list (§7 row 75, §12.5 S104)', () => {
  const pool = instantCatalogue();

  it('names at most three ids, best match first, and never the id that was typed', () => {
    const c = modelCheck('claude-sonet-5', pool, true, API);
    expect(c.kind).toBe('refuse');
    if (c.kind !== 'refuse') return;
    const named = c.text.slice(c.text.indexOf('did you mean ') + 'did you mean '.length, c.text.indexOf('? (/model'));
    const ids = named.split(/, | or /);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids.length).toBeLessThanOrEqual(3);
    expect(ids).not.toContain('claude-sonet-5');
    expect(ids[0]).toContain('sonnet');
  });

  it('the sentence is exactly S104', () => {
    const misses = API.nearMisses('claude-sonet-5', pool, 3).map((m) => m.id);
    expect(modelCheck('claude-sonet-5', pool, true, API)).toEqual({ kind: 'refuse', text: noModelNamedText('claude-sonet-5', misses) });
  });

  it('an id the snapshot does know is never a near-miss question', () => {
    // a model from a provider that CAN generate — §7 row 77 refuses the other five with their own reason, and
    // `lines.test.ts` pins that arm; what this asserts is that a known id is never answered with `did you mean`
    const known = pool.find((m) => API.isGeneratorProvider(m.provider));
    expect(known).toBeDefined();
    expect(modelCheck(known!.id, pool, true, API).kind).toBe('ok');
  });

  it('a model newer than the snapshot is a WARNING while anything is still loading, never a refusal (§7 row 100)', () => {
    expect(modelCheck('anthropic/claude-opus-6', pool, false, API).kind).toBe('warn');
    expect(modelCheck('anthropic/claude-opus-6', pool, true, API).kind).toBe('refuse');
  });
});
