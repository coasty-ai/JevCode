/**
 * Per-million-token prices for every provider in the registry, as a table the config layer merges into its own
 * (`src/config/defaults.ts` owns `PRICING_TABLE` and is NOT edited by this module — `pricingEntries()` returns rows in
 * exactly the `[modelId, Pricing]` shape that map takes, and `pricingFor` answers the same question for a prefix match).
 *
 * Why a table at all: only two of the seven providers return a price on the wire (OpenRouter's `usage.cost` and xAI's
 * `usage.cost_in_usd_ticks`). The other five return token counts only, and none of them has a machine-readable price
 * endpoint, so cost is computed client-side from these numbers — read from the published pages on 2026-09-21, each row
 * carrying its `source`. A model with no published price is present as an `unknown: true` row rather than missing:
 * `priced: false` then makes the engine emit `budget:unpriced` (TUI-DESIGN §9.5) instead of billing $0.
 *
 * Conventions, matching config/defaults.ts:
 *  - `cacheReadPerM` is the provider's published cached-input rate, or 0.1 × input when it publishes none.
 *  - `cacheWritePerM` is Anthropic-specific (1.25 × input there). On the OpenAI-shaped APIs a cache write is billed at
 *    the plain input rate — and only OpenAI even reports `cache_write_tokens` — so those rows set it equal to input.
 *  - `longContext` is a second tier that applies above `thresholdInputTokens` prompt tokens (xAI doubles its rates
 *    above 200k, and so do gemini-2.5-pro / gemini-3.1-pro). `effectivePricing` picks the tier; the four-number
 *    `Pricing` the clients carry cannot express it, so a caller that wants exact long-prompt costs asks here.
 */
import type { Pricing, ProviderId } from './types.js';

/** 0.1 × input: the cached-input discount every current OpenAI / Gemini / Fireworks model publishes. */
export const CACHE_READ_FACTOR = 0.1;

export interface PriceRowBase {
  provider: ProviderId;
  /** the model id, or the id prefix when `match` is 'prefix' (a family and its dated snapshots) */
  model: string;
  match: 'exact' | 'prefix';
  /** the page (or endpoint) the numbers were read from, with the date */
  source: string;
  notes?: string;
}
export interface KnownPriceRow extends PriceRowBase {
  pricing: Pricing;
  /** a second tier that applies above `thresholdInputTokens` prompt tokens */
  longContext?: { thresholdInputTokens: number; pricing: Pricing };
}
export interface UnknownPriceRow extends PriceRowBase {
  /** no published price: the caller must run the model unpriced (`priced: false` ⇒ `budget:unpriced`) */
  unknown: true;
}
export type ModelPrice = KnownPriceRow | UnknownPriceRow;

interface Rates {
  in: number;
  out: number;
  /** published cached-input rate; omitted ⇒ CACHE_READ_FACTOR × input */
  cached?: number;
  /** published cache-write rate; omitted ⇒ the input rate (no surcharge on the OpenAI-shaped APIs) */
  write?: number;
}

function p(r: Rates): Pricing {
  return { inputPerM: r.in, outputPerM: r.out, cacheReadPerM: r.cached ?? r.in * CACHE_READ_FACTOR, cacheWritePerM: r.write ?? r.in };
}

const OPENAI_SOURCE = 'developers.openai.com/api/docs/pricing (read 2026-09-21)';
const GEMINI_SOURCE = 'ai.google.dev/gemini-api/docs/pricing (read 2026-09-21)';
const FIREWORKS_SOURCE = 'docs.fireworks.ai/serverless/pricing (read 2026-09-21)';
const META_SOURCE = 'GET https://api.meta.ai/v1/models (read 2026-09-23; the catalogue publishes per-million prices for the muse-spark tiers)';
const XAI_SOURCE = 'GET https://api.x.ai/v1/models (read 2026-09-21; integer prices, 1e10 units = $1 ⇒ value/1e4 = USD per 1M)';
const OPENROUTER_SOURCE = 'GET https://openrouter.ai/api/v1/models (read 2026-09-21; the lowest-provider rate — usage.cost is authoritative)';
const ANTHROPIC_SOURCE = 'src/config/defaults.ts SONNET_5 (research 07 §1.2, 2026-09-19); cache write is the 5-minute rate';

/**
 * Every row, most specific first is NOT required — `priceRowFor` prefers an exact id and then the LONGEST matching
 * prefix, so `gpt-5.6-terra` never picks up `gpt-5.6-sol`'s rate and a dated snapshot inherits its family's.
 */
export const MODEL_PRICES: readonly ModelPrice[] = [
  // ---- OpenAI (developers.openai.com/api/docs/pricing; standard tier, reasoning tokens billed as output) ----
  { provider: 'openai', model: 'gpt-6-astra', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 10, out: 50, cached: 1 }) },
  { provider: 'openai', model: 'gpt-5.6-sol', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 4, out: 20, cached: 0.4 }), notes: 'the `gpt-5.6` alias resolves here' },
  { provider: 'openai', model: 'gpt-5.6-terra', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 2, out: 12, cached: 0.2 }) },
  { provider: 'openai', model: 'gpt-5.6-luna', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 0.2, out: 1.2, cached: 0.02 }) },
  { provider: 'openai', model: 'gpt-5.6', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 4, out: 20, cached: 0.4 }), notes: 'alias of gpt-5.6-sol' },
  { provider: 'openai', model: 'gpt-5.5-pro', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 30, out: 180, cached: 30 }), notes: 'no cached-input rate published: cached tokens priced as input' },
  { provider: 'openai', model: 'gpt-5.5', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 5, out: 30, cached: 0.5 }) },
  { provider: 'openai', model: 'gpt-5.4-mini', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 0.75, out: 4.5, cached: 0.075 }) },
  { provider: 'openai', model: 'gpt-5.4-nano', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 0.2, out: 1.25, cached: 0.02 }) },
  { provider: 'openai', model: 'gpt-5.4', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 2.5, out: 15, cached: 0.25 }) },
  { provider: 'openai', model: 'gpt-5.3-codex', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 1.75, out: 14, cached: 0.175 }) },
  { provider: 'openai', model: 'gpt-5-mini', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 0.25, out: 2, cached: 0.025 }) },
  { provider: 'openai', model: 'gpt-5', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 1.25, out: 10, cached: 0.125 }) },
  { provider: 'openai', model: 'gpt-4.1-mini', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 0.4, out: 1.6, cached: 0.1 }) },
  { provider: 'openai', model: 'gpt-4.1', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 2, out: 8, cached: 0.5 }) },
  { provider: 'openai', model: 'gpt-4o', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 2.5, out: 10, cached: 1.25 }), notes: 'the o-series/4.x cached discount is 0.5x, not 0.1x' },
  { provider: 'openai', model: 'o4-mini', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 1.1, out: 4.4, cached: 0.275 }) },
  { provider: 'openai', model: 'o3', match: 'prefix', source: OPENAI_SOURCE, pricing: p({ in: 2, out: 8, cached: 0.5 }) },

  // ---- Google Gemini (output prices include thinking tokens) ----
  {
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    match: 'prefix',
    source: GEMINI_SOURCE,
    pricing: p({ in: 0.75, out: 3.75, cached: 0.075 }),
    notes: 'promotional through 2026-12-31; $1.50/$7.50 from 2027-01-01',
  },
  { provider: 'gemini', model: 'gemini-3.7-flash', match: 'prefix', source: GEMINI_SOURCE, pricing: p({ in: 0.75, out: 3.75, cached: 0.075 }), notes: 'price step to $1.50/$7.50 on 2027-01-01' },
  { provider: 'gemini', model: 'gemini-3.6-flash', match: 'prefix', source: GEMINI_SOURCE, pricing: p({ in: 0.75, out: 3.75, cached: 0.075 }), notes: 'price step to $1.50/$7.50 on 2027-01-01' },
  { provider: 'gemini', model: 'gemini-3.5-flash-lite', match: 'prefix', source: GEMINI_SOURCE, pricing: p({ in: 0.3, out: 2.5, cached: 0.03 }) },
  { provider: 'gemini', model: 'gemini-3.5-flash', match: 'prefix', source: GEMINI_SOURCE, pricing: p({ in: 1.5, out: 9, cached: 0.15 }) },
  {
    provider: 'gemini',
    model: 'gemini-3.1-pro',
    match: 'prefix',
    source: GEMINI_SOURCE,
    pricing: p({ in: 2, out: 12, cached: 0.2 }),
    longContext: { thresholdInputTokens: 200_000, pricing: p({ in: 4, out: 18, cached: 0.4 }) },
  },
  { provider: 'gemini', model: 'gemini-3-flash-preview', match: 'prefix', source: GEMINI_SOURCE, pricing: p({ in: 0.5, out: 3, cached: 0.05 }) },
  {
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    match: 'prefix',
    source: GEMINI_SOURCE,
    pricing: p({ in: 1.25, out: 10, cached: 0.125 }),
    longContext: { thresholdInputTokens: 200_000, pricing: p({ in: 2.5, out: 15, cached: 0.25 }) },
  },
  { provider: 'gemini', model: 'gemini-2.5-flash-lite', match: 'prefix', source: GEMINI_SOURCE, pricing: p({ in: 0.1, out: 0.4, cached: 0.01 }) },
  { provider: 'gemini', model: 'gemini-2.5-flash', match: 'prefix', source: GEMINI_SOURCE, pricing: p({ in: 0.3, out: 2.5, cached: 0.03 }) },

  // ---- Fireworks (serverless, standard tier; `priority` is ~1.5x and US-only routes 1.5x) ----
  { provider: 'fireworks', model: 'accounts/fireworks/models/glm-5p3-flash', match: 'prefix', source: FIREWORKS_SOURCE, pricing: p({ in: 0.15, out: 0.5, cached: 0.03 }) },
  { provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k3', match: 'prefix', source: FIREWORKS_SOURCE, pricing: p({ in: 3, out: 15, cached: 0.3 }) },
  {
    provider: 'fireworks',
    model: 'accounts/fireworks/models/deepseek-v4p1-flash',
    match: 'prefix',
    source: FIREWORKS_SOURCE,
    pricing: p({ in: 0.3, out: 1.2, cached: 0.006 }),
    notes: 'the model-library page disagrees with the pricing page ($0.22/$0.66); the pricing page is used',
  },
  { provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4-pro', match: 'prefix', source: FIREWORKS_SOURCE, pricing: p({ in: 1.74, out: 3.48, cached: 0.145 }) },
  { provider: 'fireworks', model: 'accounts/fireworks/models/qwen3p8-max', match: 'prefix', source: FIREWORKS_SOURCE, pricing: p({ in: 2, out: 6, cached: 0.25 }) },
  { provider: 'fireworks', model: 'accounts/fireworks/models/nemotron-lightning-3p5-30b', match: 'prefix', source: FIREWORKS_SOURCE, pricing: p({ in: 0.05, out: 0.2, cached: 0.01 }) },
  // ---- Meta Model API (api.meta.ai/v1 catalogue, read live 2026-09-23: muse-spark-1.x $1.25/$4.25 cache $0.15; the contributor tier $0.10/$0.20 cache $0.002) ----
  { provider: 'meta', model: 'muse-spark-1.3', match: 'exact', source: META_SOURCE, pricing: p({ in: 1.25, out: 4.25, cached: 0.15 }) },
  { provider: 'meta', model: 'muse-spark-1.2', match: 'exact', source: META_SOURCE, pricing: p({ in: 1.25, out: 4.25, cached: 0.15 }) },
  { provider: 'meta', model: 'muse-spark-1.1', match: 'exact', source: META_SOURCE, pricing: p({ in: 1.25, out: 4.25, cached: 0.15 }) },
  { provider: 'meta', model: 'muse-spark-1.3-contributor', match: 'exact', source: META_SOURCE, pricing: p({ in: 0.1, out: 0.2, cached: 0.002 }) },
  { provider: 'meta', model: 'muse-spark-1.2-contributor', match: 'exact', source: META_SOURCE, pricing: p({ in: 0.1, out: 0.2, cached: 0.002 }) },
  {
    provider: 'fireworks',
    model: 'accounts/fireworks/',
    match: 'prefix',
    source: FIREWORKS_SOURCE,
    unknown: true,
    notes: 'every other Fireworks id: the published fallback is a parameter-count bucket (<4B $0.10, 4-16B $0.20, >16B $0.90) and the id does not carry the count',
  },

  // ---- Meta (api.meta.ai) ----
  {
    provider: 'meta',
    model: 'muse-',
    match: 'prefix',
    source: 'the Meta Model API catalogue prices the muse-spark tiers (exact rows above, read 2026-09-23); any other muse- id has no published price',
    unknown: true,
    notes: 'run with priced: false so the engine reports budget:unpriced instead of billing $0',
  },

  // ---- xAI (the catalogue itself carries these; long-context tier applies above 200k prompt tokens) ----
  {
    provider: 'xai',
    model: 'grok-4.7',
    match: 'prefix',
    source: XAI_SOURCE,
    pricing: p({ in: 2, out: 6, cached: 0.5 }),
    longContext: { thresholdInputTokens: 200_000, pricing: p({ in: 4, out: 12, cached: 1 }) },
  },
  {
    provider: 'xai',
    model: 'grok-4.6',
    match: 'prefix',
    source: XAI_SOURCE,
    pricing: p({ in: 2, out: 6, cached: 0.5 }),
    longContext: { thresholdInputTokens: 200_000, pricing: p({ in: 4, out: 12, cached: 1 }) },
  },
  {
    provider: 'xai',
    model: 'grok-4.5',
    match: 'prefix',
    source: XAI_SOURCE,
    pricing: p({ in: 2, out: 6, cached: 0.3 }),
    longContext: { thresholdInputTokens: 200_000, pricing: p({ in: 4, out: 12, cached: 0.6 }) },
  },
  {
    provider: 'xai',
    model: 'grok-4.3',
    match: 'prefix',
    source: XAI_SOURCE,
    pricing: p({ in: 1.25, out: 2.5, cached: 0.2 }),
    longContext: { thresholdInputTokens: 200_000, pricing: p({ in: 2.5, out: 5, cached: 0.4 }) },
  },
  {
    provider: 'xai',
    model: 'grok-4.20',
    match: 'prefix',
    source: XAI_SOURCE,
    pricing: p({ in: 1.25, out: 2.5, cached: 0.2 }),
    longContext: { thresholdInputTokens: 200_000, pricing: p({ in: 2.5, out: 5, cached: 0.4 }) },
  },
  {
    provider: 'xai',
    model: 'grok-build-0.1',
    match: 'prefix',
    source: XAI_SOURCE,
    pricing: p({ in: 1, out: 2, cached: 0.2 }),
    notes: 'also served as grok-code-fast-1',
    longContext: { thresholdInputTokens: 200_000, pricing: p({ in: 2, out: 4, cached: 0.4 }) },
  },
  { provider: 'xai', model: 'grok-code-fast', match: 'prefix', source: XAI_SOURCE, pricing: p({ in: 1, out: 2, cached: 0.2 }), notes: 'alias of grok-build-0.1' },

  // ---- Anthropic direct / OpenRouter: the two providers the tree already priced; repeated here so the table is complete ----
  { provider: 'anthropic', model: 'claude-sonnet-5', match: 'prefix', source: ANTHROPIC_SOURCE, pricing: p({ in: 2, out: 10, cached: 0.2, write: 2.5 }) },
  { provider: 'openrouter', model: 'z-ai/glm-5.3-flashx', match: 'prefix', source: OPENROUTER_SOURCE, pricing: p({ in: 0.37, out: 1.25, cached: 0.075, write: 0.37 * 1.25 }) },
  { provider: 'openrouter', model: 'z-ai/glm-5.3-flash', match: 'prefix', source: OPENROUTER_SOURCE, pricing: p({ in: 0.15, out: 0.5, cached: 0.05, write: 0.15 * 1.25 }) }, // re-fetched 2026-09-21 (evening)
  { provider: 'openrouter', model: 'z-ai/glm-5.3', match: 'prefix', source: OPENROUTER_SOURCE, pricing: p({ in: 0.84, out: 2.64, cached: 0.156, write: 0.84 * 1.25 }) }, // re-fetched 2026-09-21 (evening)
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-5', match: 'prefix', source: ANTHROPIC_SOURCE, pricing: p({ in: 2, out: 10, cached: 0.2, write: 2.5 }) },
];

export function isKnownPrice(row: ModelPrice): row is KnownPriceRow {
  return 'pricing' in row;
}

/** The row for a model id: an exact match first, then the longest matching prefix; null when the table says nothing. */
export function priceRowFor(provider: ProviderId, model: string): ModelPrice | null {
  const id = model.trim().toLowerCase();
  let best: ModelPrice | null = null;
  for (const row of MODEL_PRICES) {
    if (row.provider !== provider) continue;
    const key = row.model.toLowerCase();
    const hit = row.match === 'exact' ? id === key : id.startsWith(key);
    if (!hit) continue;
    if (best === null || key.length > best.model.length) best = row;
  }
  return best;
}

/**
 * The base-tier prices for a model, or null when the table has no published price (an unknown row or no row at all) —
 * the signal for `priced: false`.
 */
export function pricingFor(provider: ProviderId, model: string): Pricing | null {
  const row = priceRowFor(provider, model);
  return row !== null && isKnownPrice(row) ? { ...row.pricing } : null;
}

/** The tier that actually applies to a prompt of `inputTokens` (xAI / gemini-pro double their rates above the threshold). */
export function effectivePricing(row: ModelPrice, inputTokens: number): Pricing | null {
  if (!isKnownPrice(row)) return null;
  const long = row.longContext;
  if (long !== undefined && inputTokens > long.thresholdInputTokens) return { ...long.pricing };
  return { ...row.pricing };
}

/**
 * The known rows as `[modelId, Pricing]` pairs for `config/defaults.ts PRICING_TABLE` (which is an exact-match map of
 * lowercased ids): `new Map([...PRICING_TABLE, ...pricingEntries()])`. Prefix rows are included under their prefix,
 * which is the exact id for every current flagship (`gpt-6-astra`, `gemini-3.8-flash`, `grok-4.7`, …); a dated snapshot
 * still resolves through `pricingFor`, which is the API the config should prefer.
 */
export function pricingEntries(): [string, Pricing][] {
  const out: [string, Pricing][] = [];
  for (const row of MODEL_PRICES) if (isKnownPrice(row)) out.push([row.model.toLowerCase(), { ...row.pricing }]);
  return out;
}
