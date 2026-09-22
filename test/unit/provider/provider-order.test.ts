/**
 * contract 1.9 (Fastlane) §3.2 — `GenerateProviderPrefs.order` on the wire
 * (HARNESS-NEXT-DESIGN.md §6 S2: "widen `OpenRouterProviderPrefs`; `providerPrefsOf` maps verbatim";
 * its named test is `provider-prefs.test.ts`, "`only` is never emitted; `allow_fallbacks` defaults true").
 *
 * The hedge of §3.2 exists because one upstream can be silent while the rest of the router's pool is
 * healthy, and the twin is only worth its dollar if it is pointed somewhere else — so the order is the
 * whole mechanism, and `only` is the one thing it must never become: `only` turns a rotated twin into a
 * call that fails closed when that single upstream is the one that is down, which is the opposite of a hedge.
 */
import { describe, expect, it } from 'vitest';

import { buildOpenRouterBody } from '../../../src/provider/openrouter.js';
import { rotatedProviderOrder } from '../../../src/synth/llm/source.js';
import { openrouterCfg, request } from './helpers.js';

describe('§3.2 openrouter `provider.order`', () => {
  it('is absent unless the caller gave one, so today’s request body is unchanged', () => {
    expect(buildOpenRouterBody(openrouterCfg({ model: 'z-ai/glm-5.3-flash' }), request()).provider).toBeUndefined();
    expect(buildOpenRouterBody(openrouterCfg({ model: 'z-ai/glm-5.3-flash' }), request({ providerPrefs: { requireParameters: true } })).provider).toEqual({ require_parameters: true });
    // an empty list is "no preference", not "prefer nothing"
    expect(buildOpenRouterBody(openrouterCfg({ model: 'z-ai/glm-5.3-flash' }), request({ providerPrefs: { requireParameters: true, order: [] } })).provider).toEqual({ require_parameters: true });
  });

  it('maps a non-empty order verbatim and emits no `only` (allow_fallbacks stays at its default true)', () => {
    const body = buildOpenRouterBody(openrouterCfg({ model: 'z-ai/glm-5.3-flash' }), request({ providerPrefs: { requireParameters: true, order: ['Z.AI', 'Inceptron', 'Fireworks'] } }));
    expect(body.provider).toEqual({ require_parameters: true, order: ['Z.AI', 'Inceptron', 'Fireworks'] });
    const wire = JSON.stringify(body);
    expect(wire).not.toContain('"only"');
    expect(wire).not.toContain('allow_fallbacks');
  });

  it('rotates by one for the twin, and leaves a list it cannot rotate alone', () => {
    expect(rotatedProviderOrder(['Z.AI', 'Inceptron', 'Fireworks'])).toEqual(['Inceptron', 'Fireworks', 'Z.AI']);
    // a single upstream cannot be rotated away from: the twin is then a pure latency race on the same one
    expect(rotatedProviderOrder(['Z.AI'])).toEqual(['Z.AI']);
    expect(rotatedProviderOrder([])).toEqual([]);
  });
});
