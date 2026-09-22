/**
 * The bundled snapshot: enough catalogue to open a model picker with no network and no cache, and
 * the metadata overlay for the live lists that omit it (OpenAI ships ids and a shutdown date and
 * nothing else; Meta ships ids; Anthropic and Fireworks ship no prices; nobody but OpenRouter ships
 * prices at all).
 *
 * Provenance, all 2026-09-21:
 * - Anthropic ids, context and output caps: live `GET /v1/models` (11 models, `max_input_tokens` /
 *   `max_tokens` / `capabilities`). Prices: the Claude model table (Fable 5.1 and Fable 5 $10/$50,
 *   Opus 5/4.8/4.7/4.6 $5/$25, Sonnet 5 $2/$10, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5), with cache
 *   reads at 0.1x input except Fable 5.1's published $0.25/MTok (0.025x) and Fable 5's $1.00/MTok.
 *   Cross-checked against OpenRouter's mirror of the same models (`anthropic/claude-sonnet-5`
 *   $2/$10 cache $0.20, `anthropic/claude-opus-5` $5/$25 cache $0.50, `anthropic/claude-fable-5.1`
 *   $10/$50 cache $0.25) — exact agreement. The live list also serves `claude-opus-4-5-20251101`,
 *   `claude-sonnet-4-5-20250929` and `claude-haiku-4-5-20251001`; only the last resolves here (dated
 *   suffix of `claude-haiku-4-5`), so the two legacy 4.5 ids come back unpriced rather than guessed.
 * - OpenAI prices: the 2026-09 API research table (standard tier, input / cached input / output).
 *   Context and output caps: OpenRouter's mirror of the same ids (the OpenAI list endpoint exposes
 *   neither). NOTE: the mirror prices `openai/gpt-5.6-sol` at $2/$10 where the first-party table
 *   says $4/$20 — the two rows below (one per route) keep each source's own number; re-check both
 *   pages at the next refresh.
 * - Gemini: research table and OpenRouter's mirror agree on every price, context (1,048,576) and
 *   output cap (65,536). The live endpoint 403'd on this project's key (Gemini API not enabled), so
 *   ids here are from the documented model list, not observed.
 * - xAI: live `GET /v1/models` prices, decoded at 1e-10 USD/token and confirmed against
 *   docs.x.ai/developers/pricing to the cent.
 * - Fireworks: live ids from `GET /inference/v1/models`; prices from the 2026-09 research table for
 *   the six models it lists, with `fireworksBucketPricing` as the documented parameter-count
 *   fallback for the rest.
 * - Meta: live ids from `GET /v1/models`; prices and context from OpenRouter's mirror of the same
 *   models (`meta/muse-spark-1.3` $1.25/$4.25 cache $0.15, 1,048,576 context), corroborated by
 *   Meta's published $1.25/$4.25 and the $0.10/$0.20 contributor tier.
 * - OpenRouter: live `GET /api/v1/models`, verbatim.
 *
 * Refresh by hand: re-run the list endpoints, diff, and update `SNAPSHOT_DATE`.
 */
import type { ModelInfo, ModelPricing, ModelSupports, ProviderId } from './types.js';
import { PROVIDER_IDS } from './providers.js';

/** The date the snapshot below was taken; also the `updatedAt` of every model it produces. */
export const SNAPSHOT_DATE = '2026-09-21';
/** `SNAPSHOT_DATE` as an ISO instant: the `updatedAt` / `fetchedAt` of every bundled row. */
export const SNAPSHOT_AT = `${SNAPSHOT_DATE}T00:00:00.000Z`;

/** One snapshot row. `aliases` are alternative ids that resolve to this row (never listed as models). */
export interface StaticModel {
  id: string;
  displayName: string;
  aliases?: readonly string[];
  contextLength?: number;
  maxOutput?: number;
  pricing?: ModelPricing;
  supports: ModelSupports;
  deprecated?: boolean;
}

// Capability shorthands. Never handed out by reference — `enrich`/`staticModels` copy them.
const FULL: ModelSupports = { tools: true, structuredOutput: true, reasoning: true, vision: true };
const FULL_NO_REASONING: ModelSupports = { tools: true, structuredOutput: true, reasoning: false, vision: true };
const TEXT_FULL: ModelSupports = { tools: true, structuredOutput: true, reasoning: true };

function p(inputPerM: number, outputPerM: number, cacheReadPerM?: number): ModelPricing {
  return cacheReadPerM === undefined ? { inputPerM, outputPerM } : { inputPerM, outputPerM, cacheReadPerM };
}

const M = 1_048_576;

const ANTHROPIC: readonly StaticModel[] = [
  { id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', contextLength: 1_000_000, maxOutput: 128_000, pricing: p(10, 50, 0.25), supports: FULL },
  { id: 'claude-fable-5', displayName: 'Claude Fable 5', contextLength: 1_000_000, maxOutput: 128_000, pricing: p(10, 50, 1), supports: FULL },
  { id: 'claude-opus-5', displayName: 'Claude Opus 5', contextLength: 1_000_000, maxOutput: 128_000, pricing: p(5, 25, 0.5), supports: FULL },
  { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', contextLength: 1_000_000, maxOutput: 128_000, pricing: p(5, 25, 0.5), supports: FULL },
  { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', contextLength: 1_000_000, maxOutput: 128_000, pricing: p(5, 25, 0.5), supports: FULL },
  { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', contextLength: 1_000_000, maxOutput: 128_000, pricing: p(5, 25, 0.5), supports: FULL },
  { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', contextLength: 1_000_000, maxOutput: 128_000, pricing: p(2, 10, 0.2), supports: FULL },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', contextLength: 1_000_000, maxOutput: 128_000, pricing: p(3, 15, 0.3), supports: FULL },
  { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', contextLength: 200_000, maxOutput: 64_000, pricing: p(1, 5, 0.1), supports: FULL },
];

const OPENAI: readonly StaticModel[] = [
  { id: 'gpt-6-astra', displayName: 'GPT-6 Astra', contextLength: 1_050_000, maxOutput: 128_000, pricing: p(10, 50, 1), supports: FULL },
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', aliases: ['gpt-5.6'], contextLength: 1_050_000, maxOutput: 128_000, pricing: p(4, 20, 0.4), supports: FULL },
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', contextLength: 1_050_000, maxOutput: 128_000, pricing: p(2, 12, 0.2), supports: FULL },
  { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', contextLength: 1_050_000, maxOutput: 128_000, pricing: p(0.2, 1.2, 0.02), supports: FULL },
  { id: 'gpt-5.5', displayName: 'GPT-5.5', contextLength: 1_050_000, maxOutput: 128_000, pricing: p(5, 30, 0.5), supports: FULL },
  { id: 'gpt-5.5-pro', displayName: 'GPT-5.5 Pro', contextLength: 1_050_000, maxOutput: 128_000, pricing: p(30, 180), supports: FULL },
  { id: 'gpt-5.4', displayName: 'GPT-5.4', contextLength: 1_050_000, maxOutput: 128_000, pricing: p(2.5, 15, 0.25), supports: FULL },
  { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini', contextLength: 400_000, maxOutput: 128_000, pricing: p(0.75, 4.5, 0.075), supports: FULL },
  { id: 'gpt-5.4-nano', displayName: 'GPT-5.4 nano', contextLength: 400_000, maxOutput: 128_000, pricing: p(0.2, 1.25, 0.02), supports: FULL },
  { id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', contextLength: 400_000, maxOutput: 128_000, pricing: p(1.75, 14, 0.175), supports: FULL },
  { id: 'gpt-5', displayName: 'GPT-5', contextLength: 400_000, maxOutput: 128_000, pricing: p(1.25, 10, 0.125), supports: FULL },
  { id: 'gpt-5-mini', displayName: 'GPT-5 mini', contextLength: 400_000, maxOutput: 128_000, pricing: p(0.25, 2, 0.025), supports: FULL },
  { id: 'gpt-4.1', displayName: 'GPT-4.1', contextLength: 1_047_576, maxOutput: 32_768, pricing: p(2, 8, 0.5), supports: FULL_NO_REASONING },
  { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini', contextLength: 1_047_576, maxOutput: 32_768, pricing: p(0.4, 1.6, 0.1), supports: FULL_NO_REASONING },
  { id: 'gpt-4o', displayName: 'GPT-4o', contextLength: 128_000, maxOutput: 16_384, pricing: p(2.5, 10, 1.25), supports: FULL_NO_REASONING },
  { id: 'o3', displayName: 'o3', contextLength: 200_000, maxOutput: 100_000, pricing: p(2, 8, 0.5), supports: FULL },
  { id: 'o4-mini', displayName: 'o4-mini', contextLength: 200_000, maxOutput: 100_000, pricing: p(1.1, 4.4, 0.275), supports: FULL },
];

const GEMINI: readonly StaticModel[] = [
  { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', contextLength: M, maxOutput: 65_536, pricing: p(0.75, 3.75, 0.075), supports: FULL },
  { id: 'gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', contextLength: M, maxOutput: 65_536, pricing: p(0.75, 3.75, 0.075), supports: FULL },
  { id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', contextLength: M, maxOutput: 65_536, pricing: p(0.75, 3.75, 0.075), supports: FULL },
  { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', contextLength: M, maxOutput: 65_536, pricing: p(1.5, 9, 0.15), supports: FULL },
  { id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', contextLength: M, maxOutput: 65_536, pricing: p(0.3, 2.5, 0.03), supports: FULL },
  { id: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash-Lite', contextLength: M, maxOutput: 65_536, pricing: p(0.25, 1.5, 0.025), supports: FULL },
  { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro (preview)', contextLength: M, maxOutput: 65_536, pricing: p(2, 12, 0.2), supports: FULL },
  { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash (preview)', contextLength: M, maxOutput: 65_536, pricing: p(0.5, 3, 0.05), supports: FULL },
  { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', contextLength: M, maxOutput: 65_536, pricing: p(1.25, 10, 0.125), supports: FULL },
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', contextLength: M, maxOutput: 65_536, pricing: p(0.3, 2.5, 0.03), supports: FULL },
  { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', contextLength: M, maxOutput: 65_536, pricing: p(0.1, 0.4, 0.01), supports: FULL },
];

const XAI: readonly StaticModel[] = [
  { id: 'grok-4.7', displayName: 'Grok 4.7', contextLength: 500_000, pricing: p(2, 6, 0.5), supports: FULL },
  { id: 'grok-4.6', displayName: 'Grok 4.6', contextLength: 500_000, pricing: p(2, 6, 0.5), supports: FULL },
  { id: 'grok-4.5', displayName: 'Grok 4.5', contextLength: 500_000, pricing: p(2, 6, 0.3), supports: FULL },
  { id: 'grok-4.3', displayName: 'Grok 4.3', contextLength: 1_000_000, pricing: p(1.25, 2.5, 0.2), supports: FULL },
  { id: 'grok-4.20-0309-reasoning', displayName: 'Grok 4.20 (reasoning)', aliases: ['grok-4.20', 'grok-4.20-reasoning'], contextLength: 1_000_000, pricing: p(1.25, 2.5, 0.2), supports: FULL },
  { id: 'grok-4.20-0309-non-reasoning', displayName: 'Grok 4.20 (non-reasoning)', aliases: ['grok-4.20-non-reasoning'], contextLength: 1_000_000, pricing: p(1.25, 2.5, 0.2), supports: FULL_NO_REASONING },
  { id: 'grok-4.20-multi-agent-0309', displayName: 'Grok 4.20 (multi-agent)', aliases: ['grok-4.20-multi-agent'], contextLength: 1_000_000, pricing: p(1.25, 2.5, 0.2), supports: FULL },
  { id: 'grok-build-0.1', displayName: 'Grok Build 0.1', contextLength: 256_000, pricing: p(1, 2, 0.2), supports: FULL },
];

const FIREWORKS: readonly StaticModel[] = [
  { id: 'accounts/fireworks/models/kimi-k3', displayName: 'kimi-k3', contextLength: M, pricing: p(3, 15, 0.3), supports: FULL },
  { id: 'accounts/fireworks/models/deepseek-v4p1-flash', displayName: 'deepseek-v4.1-flash', contextLength: M, pricing: p(0.3, 1.2, 0.006), supports: FULL },
  { id: 'accounts/fireworks/models/deepseek-v4-pro', displayName: 'deepseek-v4-pro', contextLength: M, pricing: p(1.74, 3.48, 0.145), supports: TEXT_FULL },
  { id: 'accounts/fireworks/models/deepseek-v4-pro-0813', displayName: 'deepseek-v4-pro-0813', contextLength: M, pricing: p(1.74, 3.48, 0.145), supports: TEXT_FULL },
  { id: 'accounts/fireworks/models/glm-5p3-flash', displayName: 'glm-5.3-flash', contextLength: M, pricing: p(0.15, 0.5, 0.03), supports: FULL },
  { id: 'accounts/fireworks/models/qwen3p8-max', displayName: 'qwen3.8-max', pricing: p(2, 6, 0.25), supports: FULL },
  { id: 'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b', displayName: 'nemotron-lightning-3.5-30b-a3b', contextLength: 262_144, pricing: p(0.05, 0.2, 0.01), supports: TEXT_FULL },
];

const META: readonly StaticModel[] = [
  { id: 'muse-spark-1.3', displayName: 'Muse Spark 1.3', contextLength: M, pricing: p(1.25, 4.25, 0.15), supports: FULL },
  { id: 'muse-spark-1.2', displayName: 'Muse Spark 1.2', contextLength: M, pricing: p(1.25, 4.25, 0.15), supports: FULL },
  { id: 'muse-spark-1.1', displayName: 'Muse Spark 1.1', contextLength: M, pricing: p(1.25, 4.25, 0.15), supports: FULL },
  // the contributor tiers trade training rights for ~12x cheaper tokens
  { id: 'muse-spark-1.3-contributor', displayName: 'Muse Spark 1.3 Contributor', contextLength: M, pricing: p(0.1, 0.2, 0.002), supports: FULL },
  { id: 'muse-spark-1.2-contributor', displayName: 'Muse Spark 1.2 Contributor', contextLength: M, pricing: p(0.1, 0.2, 0.002), supports: FULL },
];

const OPENROUTER: readonly StaticModel[] = [
  // the default generator (config/defaults.ts DEFAULT_MODEL)
  { id: 'z-ai/glm-5.3-flash', displayName: 'Z.ai: GLM 5.3 Flash', contextLength: 1_310_720, maxOutput: 943_718, pricing: p(0.15, 0.5, 0.05), supports: FULL },
  { id: 'z-ai/glm-5.3', displayName: 'Z.ai: GLM 5.3', contextLength: 1_310_720, maxOutput: 131_072, pricing: p(0.84, 2.64, 0.156), supports: TEXT_FULL },
  { id: 'z-ai/glm-5.3-flashx', displayName: 'Z.ai: GLM 5.3 FlashX', contextLength: M, maxOutput: 131_072, pricing: p(0.37, 1.25, 0.075), supports: { tools: true, structuredOutput: false, reasoning: true, vision: true } },
  { id: 'anthropic/claude-sonnet-5', displayName: 'Anthropic: Claude Sonnet 5', contextLength: 1_000_000, maxOutput: 128_000, pricing: p(2, 10, 0.2), supports: FULL },
  { id: 'anthropic/claude-opus-5', displayName: 'Anthropic: Claude Opus 5', contextLength: 1_000_000, maxOutput: 128_000, pricing: p(5, 25, 0.5), supports: FULL },
  { id: 'anthropic/claude-fable-5.1', displayName: 'Anthropic: Claude Fable 5.1', contextLength: 1_000_000, maxOutput: 128_000, pricing: p(10, 50, 0.25), supports: FULL },
  { id: 'openai/gpt-6-astra', displayName: 'OpenAI: GPT-6 Astra', contextLength: 1_050_000, maxOutput: 128_000, pricing: p(10, 50, 1), supports: FULL },
  { id: 'openai/gpt-5.6-sol', displayName: 'OpenAI: GPT-5.6 Sol', contextLength: 1_050_000, maxOutput: 128_000, pricing: p(2, 10, 0.2), supports: FULL },
  { id: 'google/gemini-3.8-flash', displayName: 'Google: Gemini 3.8 Flash', contextLength: M, maxOutput: 65_536, pricing: p(0.75, 3.75, 0.075), supports: FULL },
  { id: 'x-ai/grok-4.7', displayName: 'SpaceXAI: Grok 4.7', contextLength: 500_000, maxOutput: 450_000, pricing: p(1.6, 4.8, 0.4), supports: FULL },
  { id: 'moonshotai/kimi-k3', displayName: 'MoonshotAI: Kimi K3', contextLength: M, maxOutput: 943_718, pricing: p(3, 15, 0.3), supports: FULL },
  { id: 'deepseek/deepseek-v4.1-flash', displayName: 'DeepSeek: DeepSeek V4.1 Flash', contextLength: M, maxOutput: 384_000, pricing: p(0.3, 1.2, 0.006), supports: FULL },
];

/** The bundled catalogue, by provider. */
export const SNAPSHOT: Readonly<Record<ProviderId, readonly StaticModel[]>> = {
  anthropic: ANTHROPIC,
  openai: OPENAI,
  openrouter: OPENROUTER,
  gemini: GEMINI,
  xai: XAI,
  fireworks: FIREWORKS,
  meta: META,
};

/** Total rows in the snapshot — asserted by a test so "small" stays true. */
export function snapshotSize(): number {
  return PROVIDER_IDS.reduce((n, id) => n + SNAPSHOT[id].length, 0);
}

/**
 * A dated snapshot of a known id: `claude-haiku-4-5-20251001` → `claude-haiku-4-5`,
 * `gpt-5.5-2026-04-23` → `gpt-5.5`, `z-ai/glm-5.3-flash-20260826` → `z-ai/glm-5.3-flash`.
 *
 * Only a date (or `latest`) may follow, which is what keeps `gpt-5-nano` from inheriting `gpt-5`'s
 * price — a plain prefix match would silently mis-price every family member.
 */
const DATED_SUFFIX = /^-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/;

export function isDatedVariant(base: string, id: string): boolean {
  return id.length > base.length && id.startsWith(base) && DATED_SUFFIX.test(id.slice(base.length));
}

/** The snapshot row for an id: exact, then alias, then longest dated-variant base. Null when unknown. */
export function resolveStatic(provider: ProviderId, id: string): StaticModel | null {
  const rows = SNAPSHOT[provider];
  const needle = id.trim();
  if (needle === '') return null;
  for (const row of rows) if (row.id === needle) return row;
  for (const row of rows) if (row.aliases?.includes(needle) === true) return row;
  let best: StaticModel | null = null;
  for (const row of rows) {
    if (!isDatedVariant(row.id, needle)) continue;
    if (best === null || row.id.length > best.id.length) best = row;
  }
  return best;
}

function toModelInfo(provider: ProviderId, row: StaticModel): ModelInfo {
  const info: ModelInfo = { id: row.id, provider, displayName: row.displayName, supports: { ...row.supports }, updatedAt: SNAPSHOT_AT };
  if (row.contextLength !== undefined) info.contextLength = row.contextLength;
  if (row.maxOutput !== undefined) info.maxOutput = row.maxOutput;
  if (row.pricing !== undefined) info.pricing = { ...row.pricing };
  if (row.deprecated === true) info.deprecated = true;
  return info;
}

/** The snapshot as `ModelInfo[]` — the offline fallback list for one provider. */
export function staticModels(provider: ProviderId): ModelInfo[] {
  return SNAPSHOT[provider].map((row) => toModelInfo(provider, row));
}

/** Every provider's snapshot, for an offline catalogue-wide search. */
export function allStaticModels(providers: readonly ProviderId[] = PROVIDER_IDS): ModelInfo[] {
  return providers.flatMap((id) => staticModels(id));
}

/**
 * Fireworks' documented fallback for models its price list does not name: one rate for input and
 * output, bucketed by parameter count (<4B $0.10, 4B–16B $0.20, >16B $0.90). The count is read from
 * the id (`gpt-oss-120b`, `muse-glimmer-30b`); an id without one gets no price.
 */
export function fireworksBucketPricing(id: string): ModelPricing | null {
  const matches = [...id.toLowerCase().matchAll(/(\d+(?:\.\d+)?)b(?![a-z0-9])/g)];
  const last = matches[matches.length - 1];
  if (last === undefined) return null;
  const raw = last[1];
  if (raw === undefined) return null;
  const billions = Number.parseFloat(raw);
  if (!Number.isFinite(billions) || billions <= 0) return null;
  const rate = billions < 4 ? 0.1 : billions <= 16 ? 0.2 : 0.9;
  return { inputPerM: rate, outputPerM: rate };
}

/**
 * Overlay the snapshot (and an optional external pricing source) onto a live list: the wire always
 * wins for a field it carried, and the snapshot fills the gaps — context window, output cap,
 * pricing, unstated capability flags, a real display name where the provider only gave an id, and
 * `deprecated` (OR'd, so a snapshot marking never un-deprecates a live shutdown date).
 */
export function enrich(provider: ProviderId, models: readonly ModelInfo[], lookup?: (provider: ProviderId, id: string) => ModelPricing | null): ModelInfo[] {
  return models.map((live) => {
    const row = resolveStatic(provider, live.id);
    const out: ModelInfo = { ...live, supports: { ...live.supports } };
    if (row !== null) {
      if (out.displayName === live.id && row.displayName !== '') out.displayName = row.displayName;
      if (out.contextLength === undefined && row.contextLength !== undefined) out.contextLength = row.contextLength;
      if (out.maxOutput === undefined && row.maxOutput !== undefined) out.maxOutput = row.maxOutput;
      if (out.pricing === undefined && row.pricing !== undefined) out.pricing = { ...row.pricing };
      if (out.supports.tools === undefined && row.supports.tools !== undefined) out.supports.tools = row.supports.tools;
      if (out.supports.structuredOutput === undefined && row.supports.structuredOutput !== undefined) out.supports.structuredOutput = row.supports.structuredOutput;
      if (out.supports.reasoning === undefined && row.supports.reasoning !== undefined) out.supports.reasoning = row.supports.reasoning;
      if (out.supports.vision === undefined && row.supports.vision !== undefined) out.supports.vision = row.supports.vision;
      if (row.deprecated === true) out.deprecated = true;
    }
    if (out.pricing === undefined && lookup !== undefined) {
      const external = lookup(provider, live.id);
      if (external !== null) out.pricing = { ...external };
    }
    if (out.pricing === undefined && provider === 'fireworks') {
      const bucket = fireworksBucketPricing(live.id);
      if (bucket !== null) out.pricing = bucket;
    }
    return out;
  });
}
