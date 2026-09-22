/**
 * Price maths and formatting for the catalogue, plus the bridge to the run's pricing types.
 *
 * Two rate shapes exist in the tree and they are not the same thing:
 *  - `ModelPricing` (this module) is what a catalogue knows: input, output, and a cache-read rate
 *    when the provider publishes one.
 *  - `GeneratorConfig['pricing']` (core/types.ts) is what the engine bills with: four required
 *    rates, cache-write included. `generatorPricingOf` derives the missing two with the rule
 *    config/defaults.ts already uses (cache read 0.1x input, cache write 1.25x input, TUI-DESIGN
 *    §9.5), so a model chosen in the picker can be handed straight to a generator config.
 */
import { CACHE_READ_FACTOR, CACHE_WRITE_FACTOR } from '../config/defaults.js';
import type { GeneratorConfig } from '../core/types.js';
import { SNAPSHOT, resolveStatic } from './static.js';
import { PROVIDER_IDS } from './providers.js';
import type { ModelInfo, ModelPricing, PricingSource, ProviderId } from './types.js';

/**
 * An agent turn is prompt-heavy: a long system prompt and file context against a short action.
 * `blendedPerM` weights 80% input / 20% output so "which is cheaper" orders models the way a run
 * actually bills, instead of letting a cheap-input/expensive-output model look free.
 */
export const BLENDED_INPUT_SHARE = 0.8;

/** One comparable USD/M number for a model's rates; `null` when the model is unpriced. */
export function blendedPerM(pricing: ModelPricing | undefined): number | null {
  if (pricing === undefined) return null;
  return pricing.inputPerM * BLENDED_INPUT_SHARE + pricing.outputPerM * (1 - BLENDED_INPUT_SHARE);
}

/** `blendedPerM` of a model, or `null`. Unpriced models sort last everywhere. */
export function modelBlendedPerM(model: ModelInfo): number | null {
  return blendedPerM(model.pricing);
}

/**
 * The engine's four-rate pricing for a catalogue model. `cacheReadPerM` is the published rate when
 * there is one, else `CACHE_READ_FACTOR x input`; `cacheWritePerM` is always derived
 * (`CACHE_WRITE_FACTOR x input`) — no provider list publishes a cache-write rate.
 */
export function generatorPricingOf(pricing: ModelPricing): GeneratorConfig['pricing'] {
  return {
    inputPerM: pricing.inputPerM,
    outputPerM: pricing.outputPerM,
    cacheReadPerM: pricing.cacheReadPerM ?? pricing.inputPerM * CACHE_READ_FACTOR,
    cacheWritePerM: pricing.inputPerM * CACHE_WRITE_FACTOR,
  };
}

/** USD for a token count at these rates (uncached input, cache reads, output). */
export function estimateCostUsd(pricing: ModelPricing, tokens: { input?: number; cacheRead?: number; output?: number }): number {
  const input = tokens.input ?? 0;
  const cacheRead = tokens.cacheRead ?? 0;
  const output = tokens.output ?? 0;
  const cacheRate = pricing.cacheReadPerM ?? pricing.inputPerM * CACHE_READ_FACTOR;
  return (input * pricing.inputPerM + cacheRead * cacheRate + output * pricing.outputPerM) / 1e6;
}

/**
 * "$10", "$1.25", "$0.50", "$0.006" — a rate without its unit. Whole dollars lose their decimals;
 * everything else keeps at least two, so a column of rates lines up the way money should.
 */
export function formatRate(perM: number): string {
  if (!Number.isFinite(perM) || perM < 0) return '—';
  if (perM === 0) return '$0';
  if (perM >= 1) {
    const two = perM.toFixed(2);
    return `$${two.endsWith('.00') ? two.slice(0, -3) : two}`;
  }
  // sub-dollar: drop trailing zeros, then pad back to at least two decimals ($0.50, not $0.5)
  const trimmed = perM.toFixed(4).replace(/0+$/, '');
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return `$${whole}.${fraction.padEnd(2, '0')}`;
}

/** "$0.15/M in · $0.50/M out" (plus " · $0.05/M cached" when published); "unpriced" when absent. */
export function formatPricing(pricing: ModelPricing | undefined): string {
  if (pricing === undefined) return 'unpriced';
  const parts = [`${formatRate(pricing.inputPerM)}/M in`, `${formatRate(pricing.outputPerM)}/M out`];
  if (pricing.cacheReadPerM !== undefined) parts.push(`${formatRate(pricing.cacheReadPerM)}/M cached`);
  return parts.join(' · ');
}

/** "1.0M", "262k", "8192" — a token count for a narrow column. */
export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return '—';
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(tokens >= 1e7 ? 0 : 1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(Math.round(tokens));
}

/**
 * A `PricingSource` backed by the bundled snapshot (exact id, alias, or dated variant). This is the
 * catalogue's own fallback; `ModelsDeps.pricing` overrides it with `src/provider/pricing.ts` when
 * that module exists on the branch.
 */
export function snapshotPricingSource(): PricingSource {
  return {
    lookup(provider: ProviderId, model: string): ModelPricing | null {
      const row = resolveStatic(provider, model);
      return row?.pricing === undefined ? null : { ...row.pricing };
    },
  };
}

/**
 * Merge several pricing sources, first hit wins. The intended production order is
 * `mergePricingSources(providerPricing, snapshotPricingSource())` — the adapters group's table
 * first, the snapshot behind it.
 */
export function mergePricingSources(...sources: readonly (PricingSource | null | undefined)[]): PricingSource {
  const list = sources.filter((s): s is PricingSource => s !== null && s !== undefined);
  return {
    lookup(provider, model) {
      for (const s of list) {
        const hit = s.lookup(provider, model);
        if (hit !== null) return hit;
      }
      return null;
    },
  };
}

/**
 * Which provider (if any) prices `model` in the snapshot, when the caller has an id but not a
 * provider — `/model <id>` typed with no provider selected.
 */
export function findPricingByModelId(model: string): { provider: ProviderId; pricing: ModelPricing } | null {
  for (const provider of PROVIDER_IDS) {
    if (SNAPSHOT[provider].length === 0) continue;
    const row = resolveStatic(provider, model);
    if (row?.pricing !== undefined) return { provider, pricing: { ...row.pricing } };
  }
  return null;
}
