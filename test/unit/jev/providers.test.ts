/**
 * TUI-DESIGN-2 §2.2 / §2.5 (S1, W0): the provider table, host recognition, provider-aware pinning and drift matching.
 * Offline; every row below is a fact from docs/research/tui/round-2/typesafe-native-probe.md or §2.1's table.
 */
import { describe, expect, it } from 'vitest';
import type { JevProvider } from '../../../src/core/types.js';
import { EQUIVALENT_IDS, JEV_PROVIDERS, aliasMatches, equivalentIdsRow, equivalentJevModel, isPinnedJevModel, jevModelMatches, normaliseModelId, providerForHost, sameJevWeights } from '../../../src/jev/providers.js';
import { APP_TITLE, DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL, DEFAULT_REFERER, DEFAULT_TYPESAFE_BASE_URL, DEFAULT_TYPESAFE_MODEL, JEV_INPUT_USD_PER_TOKEN } from '../../../src/jev/types.js';
import * as client from '../../../src/jev/client.js';

const KEY = 'sk-test-0123456789abcdef0123456789abcdef';

describe('JEV_PROVIDERS (§2.2): two rows, one shape', () => {
  it('names, endpoints and pinned defaults are the measured ones (§2.1, PROBE)', () => {
    expect(Object.keys(JEV_PROVIDERS).sort()).toEqual(['openrouter', 'typesafe']);
    for (const [name, spec] of Object.entries(JEV_PROVIDERS)) expect(spec.name).toBe(name);
    expect(JEV_PROVIDERS.openrouter.baseUrl).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(JEV_PROVIDERS.openrouter.baseUrl).toBe(DEFAULT_JEV_BASE_URL);
    expect(JEV_PROVIDERS.openrouter.defaultModel).toBe('typesafe/jev-1.13-20260917');
    expect(JEV_PROVIDERS.openrouter.defaultModel).toBe(DEFAULT_JEV_MODEL);
    expect(JEV_PROVIDERS.typesafe.baseUrl).toBe('https://api.typesafe.ai/v1/systemone');
    expect(JEV_PROVIDERS.typesafe.baseUrl).toBe(DEFAULT_TYPESAFE_BASE_URL);
    expect(JEV_PROVIDERS.typesafe.defaultModel).toBe('jev-1.13.0');
    expect(JEV_PROVIDERS.typesafe.defaultModel).toBe(DEFAULT_TYPESAFE_MODEL);
    // every default model is pinned under its own provider's naming
    for (const spec of Object.values(JEV_PROVIDERS)) expect(isPinnedJevModel(spec.defaultModel, spec.name)).toBe(true);
  });

  it('key variables, hosts and the `accepts` hints are verbatim (§2.2, §12)', () => {
    expect(JEV_PROVIDERS.openrouter.keyEnv).toBe('OPENROUTER_API_KEY');
    expect(JEV_PROVIDERS.typesafe.keyEnv).toBe('TYPESAFE_API_KEY');
    expect(JEV_PROVIDERS.openrouter.displayHost).toBe('openrouter.ai');
    expect(JEV_PROVIDERS.typesafe.displayHost).toBe('api.typesafe.ai');
    expect(JEV_PROVIDERS.openrouter.accepts).toBe('OpenRouter accepts typesafe/jev-1.13-20260917 or typesafe/jev-1.13');
    expect(JEV_PROVIDERS.typesafe.accepts).toBe('TypeSafe accepts jev-1.13.0 or jev-latest');
    expect(JEV_PROVIDERS.openrouter.aliases).toEqual(['jev-1.13', 'jev-latest']);
    // §13 finding 23: `jev-1.13` is 400 on TypeSafe, so it is not an alias there
    expect(JEV_PROVIDERS.typesafe.aliases).toEqual(['jev-latest']);
  });

  it('headers: OpenRouter carries the attribution pair, TypeSafe only the bearer + content type; the key appears once, verbatim', () => {
    const or = JEV_PROVIDERS.openrouter.headers(KEY, DEFAULT_REFERER);
    expect(or).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': DEFAULT_REFERER, 'X-Title': APP_TITLE });
    const ts = JEV_PROVIDERS.typesafe.headers(KEY, DEFAULT_REFERER);
    expect(ts).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    expect('HTTP-Referer' in ts).toBe(false);
    expect('X-Title' in ts).toBe(false);
    expect(APP_TITLE).toBe('jevcode');
  });

  it('request-id headers: the provider’s own id first, then the generic pair (§2.1 `x-generation-id` / `x-typesafe-request-id`)', () => {
    expect(JEV_PROVIDERS.openrouter.requestIdHeaders).toEqual(['request-id', 'x-request-id', 'x-generation-id']);
    expect(JEV_PROVIDERS.typesafe.requestIdHeaders).toEqual(['x-typesafe-request-id', 'request-id', 'x-request-id']);
  });

  it('pricing: $0.042 per million input tokens, output free, on both providers (§2.1)', () => {
    for (const spec of Object.values(JEV_PROVIDERS)) {
      expect(spec.pricing).toEqual({ inputUsdPerToken: 4.2e-8, outputUsdPerToken: 0 });
      expect(spec.pricing.inputUsdPerToken).toBe(JEV_INPUT_USD_PER_TOKEN);
      expect(spec.pricing.inputUsdPerToken * 1e6).toBeCloseTo(0.042, 12);
    }
    // PROBE: 319 input tokens without `usage.cost` → the table prices it
    expect(319 * JEV_PROVIDERS.typesafe.pricing.inputUsdPerToken).toBeCloseTo(0.000013398, 12);
  });

  it('the table is frozen in shape: readonly record keyed by JevProvider', () => {
    const names: JevProvider[] = ['typesafe', 'openrouter'];
    for (const n of names) expect(JEV_PROVIDERS[n].name).toBe(n);
  });
});

describe('normaliseModelId (moved from client.ts; client re-exports it)', () => {
  it('lowercases, trims and strips a leading typesafe/', () => {
    expect(normaliseModelId(' TypeSafe/Jev-1.13-20260917 ')).toBe('jev-1.13-20260917');
    expect(normaliseModelId('jev-1.13.0')).toBe('jev-1.13.0');
    expect(normaliseModelId('JEV-LATEST')).toBe('jev-latest');
    expect(client.normaliseModelId).toBe(normaliseModelId);
    expect(client.APP_TITLE).toBe(APP_TITLE);
    expect(client.DEFAULT_REFERER).toBe(DEFAULT_REFERER);
  });
});

describe('providerForHost (§2.2, §2.3 rule 2a)', () => {
  it('recognises the two hosts exactly, case-insensitively, with any path or port', () => {
    expect(providerForHost('https://api.typesafe.ai/v1/systemone')).toBe('typesafe');
    expect(providerForHost('https://API.TYPESAFE.AI/other')).toBe('typesafe');
    expect(providerForHost('https://openrouter.ai/api/alpha/decisions')).toBe('openrouter');
    expect(providerForHost('https://openrouter.ai:443/')).toBe('openrouter');
    expect(providerForHost(DEFAULT_JEV_BASE_URL)).toBe('openrouter');
    expect(providerForHost(DEFAULT_TYPESAFE_BASE_URL)).toBe('typesafe');
  });
  it('returns null for other hosts, subdomains it does not know and unparsable text — never throws', () => {
    expect(providerForHost('https://proxy.test/decisions')).toBeNull();
    expect(providerForHost('https://www.openrouter.ai/')).toBeNull();
    expect(providerForHost('https://typesafe.ai/')).toBeNull();
    expect(providerForHost('http://127.0.0.1:8080/decisions')).toBeNull();
    expect(providerForHost('not a url')).toBeNull();
    expect(providerForHost('')).toBeNull();
  });
});

describe('isPinnedJevModel (§2.5): pinned under the provider’s own naming', () => {
  it('openrouter: a dated suffix pins; aliases and TypeSafe’s patch id do not', () => {
    expect(isPinnedJevModel('typesafe/jev-1.13-20260917', 'openrouter')).toBe(true);
    expect(isPinnedJevModel('jev-1.13-20260917', 'openrouter')).toBe(true);
    expect(isPinnedJevModel('TypeSafe/Jev-1.13', 'openrouter')).toBe(false);
    expect(isPinnedJevModel('jev-latest', 'openrouter')).toBe(false);
    expect(isPinnedJevModel('jev-1.13-2026091', 'openrouter')).toBe(false);
    expect(isPinnedJevModel('jev-1.13.0', 'openrouter')).toBe(false);
  });
  it('typesafe: jev-<major>.<minor>.<patch> pins; jev-latest, jev-1.13 and the dated OpenRouter id do not', () => {
    expect(isPinnedJevModel('jev-1.13.0', 'typesafe')).toBe(true);
    expect(isPinnedJevModel('JEV-2.0.17', 'typesafe')).toBe(true);
    expect(isPinnedJevModel('jev-latest', 'typesafe')).toBe(false);
    expect(isPinnedJevModel('jev-1.13', 'typesafe')).toBe(false);
    expect(isPinnedJevModel('jev-1.13-20260917', 'typesafe')).toBe(false);
    expect(isPinnedJevModel('typesafe/jev-1.13.0', 'typesafe')).toBe(true);
  });
});

describe('jevModelMatches (§2.5)', () => {
  it('pinned: equality after normalisation, nothing else', () => {
    expect(jevModelMatches('typesafe/jev-1.13-20260917', 'typesafe/jev-1.13-20260917', 'openrouter')).toBe(true);
    expect(jevModelMatches('typesafe/jev-1.13-20260917', 'jev-1.13-20260917', 'openrouter')).toBe(true);
    expect(jevModelMatches('typesafe/jev-1.13-20260917', 'jev-1.13-20260918', 'openrouter')).toBe(false);
    expect(jevModelMatches('jev-1.13.0', 'jev-1.13.0', 'typesafe')).toBe(true);
    expect(jevModelMatches('jev-1.13.0', 'jev-1.13.1', 'typesafe')).toBe(false);
    expect(jevModelMatches('jev-1.13.0', 'jev-1.13', 'typesafe')).toBe(false);
  });
  it('jev-latest accepts any jev-* resolution on either provider (PROBE: jev-latest serves jev-1.13.0)', () => {
    expect(jevModelMatches('jev-latest', 'jev-1.13.0', 'typesafe')).toBe(true);
    expect(jevModelMatches('jev-latest', 'jev-1.13-20260917', 'openrouter')).toBe(true);
    expect(jevModelMatches('jev-latest', 'other-1.0', 'typesafe')).toBe(false);
  });
  it('an alias accepts itself or itself with a dated suffix — openrouter’s jev-1.13 → jev-1.13-20260917', () => {
    expect(jevModelMatches('typesafe/jev-1.13', 'typesafe/jev-1.13-20260917', 'openrouter')).toBe(true);
    expect(jevModelMatches('jev-1.13', 'jev-1.13', 'openrouter')).toBe(true);
    // a bare prefix must not let jev-1.1 accept jev-1.13-…
    expect(jevModelMatches('jev-1.1', 'jev-1.13-20260917', 'openrouter')).toBe(false);
  });
  it('no `.` branch (§13 finding 23): jev-1.13 never matches jev-1.13.0 — TypeSafe serves no unpatched alias', () => {
    expect(jevModelMatches('jev-1.13', 'jev-1.13.0', 'typesafe')).toBe(false);
    expect(jevModelMatches('jev-1.13', 'jev-1.13.0', 'openrouter')).toBe(false);
  });
});

describe('EQUIVALENT_IDS (§2.5 --resume reconciliation)', () => {
  it('maps the dated OpenRouter id to TypeSafe’s patch id, both pinned under their own provider', () => {
    expect(EQUIVALENT_IDS).toEqual([['jev-1.13-20260917', 'jev-1.13.0']]);
    for (const [or, ts] of EQUIVALENT_IDS) {
      expect(isPinnedJevModel(or, 'openrouter')).toBe(true);
      expect(isPinnedJevModel(ts, 'typesafe')).toBe(true);
      expect(normaliseModelId(JEV_PROVIDERS.openrouter.defaultModel)).toBe(or);
      expect(JEV_PROVIDERS.typesafe.defaultModel).toBe(ts);
    }
  });
});

describe('aliasMatches (§2.5): the alias half of jevModelMatches, shared by checkServedModel and checkModelDrift', () => {
  it('jev-latest accepts any jev-*; another alias accepts itself or a dated extension; no bare prefix, no `.` branch', () => {
    expect(aliasMatches('jev-latest', 'jev-1.13.0')).toBe(true);
    expect(aliasMatches('jev-latest', 'jev-1.13-20260917')).toBe(true);
    expect(aliasMatches('jev-latest', 'other-1.0')).toBe(false);
    expect(aliasMatches('jev-1.13', 'jev-1.13')).toBe(true);
    expect(aliasMatches('jev-1.13', 'jev-1.13-20260917')).toBe(true);
    expect(aliasMatches('jev-1.1', 'jev-1.13-20260917')).toBe(false);
    expect(aliasMatches('jev-1.13', 'jev-1.13.0')).toBe(false);
  });
});

describe('equivalentJevModel / sameJevWeights (§2.5 --resume reconciliation)', () => {
  it('equivalentJevModel maps across the naming schemes and only there', () => {
    expect(equivalentJevModel('typesafe/jev-1.13-20260917', 'typesafe')).toBe('jev-1.13.0');
    expect(equivalentJevModel('JEV-1.13.0', 'openrouter')).toBe('jev-1.13-20260917');
    expect(equivalentJevModel('jev-1.13.0', 'typesafe')).toBeNull();
    expect(equivalentJevModel('jev-1.13-20260917', 'openrouter')).toBeNull();
    expect(equivalentJevModel('jev-latest', 'typesafe')).toBeNull();
    expect(equivalentJevModel('jev-1.13', 'typesafe')).toBeNull();
  });
  it('equivalentIdsRow: the row an id belongs to under either naming (the §12 `same weights: <or> ≡ <ts>` text); null for aliases and unknown ids', () => {
    expect(equivalentIdsRow('typesafe/jev-1.13-20260917')).toEqual(['jev-1.13-20260917', 'jev-1.13.0']);
    expect(equivalentIdsRow('JEV-1.13.0')).toEqual(['jev-1.13-20260917', 'jev-1.13.0']);
    expect(equivalentIdsRow('jev-latest')).toBeNull();
    expect(equivalentIdsRow('jev-1.13')).toBeNull();
    expect(equivalentIdsRow('jev-2.0.0')).toBeNull();
  });
  it('sameJevWeights: equal after normalisation, or one EQUIVALENT_IDS row in either order', () => {
    expect(sameJevWeights('TypeSafe/Jev-1.13-20260917', 'jev-1.13-20260917')).toBe(true);
    expect(sameJevWeights('typesafe/jev-1.13-20260917', 'jev-1.13.0')).toBe(true);
    expect(sameJevWeights('jev-1.13.0', 'typesafe/jev-1.13-20260917')).toBe(true);
    expect(sameJevWeights('jev-1.13.0', 'jev-1.13.1')).toBe(false);
    expect(sameJevWeights('jev-1.13', 'jev-1.13.0')).toBe(false);
    expect(sameJevWeights('jev-latest', 'jev-1.13.0')).toBe(false);
  });
});
