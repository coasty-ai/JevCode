/**
 * `recommend` — a short, ranked, explained shortlist for "which model should I use", so onboarding
 * and `/model` can offer three good answers instead of 443 rows.
 *
 * Pure and synchronous: it ranks the models it is given, defaulting to the bundled snapshot, so the
 * first frame of a wizard can show a recommendation before any network call settles.
 *
 * The two tasks weigh things differently:
 *  - `generator` writes the code. Tool calling is close to mandatory, structured outputs and a big
 *    context matter, and price is a tie-breaker.
 *  - `decider` answers structured questions on every step. Price and structured output dominate;
 *    context barely matters.
 */
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../config/defaults.js';
import { blendedPerM, formatPricing, formatTokens } from './pricing.js';
import { compareModels, filterModels, isRoutingVariant } from './search.js';
import { instantCatalogue } from './list.js';
import { isGeneratorProvider, providerDisplayName } from './providers.js';
import type { Budget, ModelInfo, ModelTask, RecommendOptions, Recommendation } from './types.js';

/** Blended USD/M ceilings for the named budgets (see `blendedPerM` for the 80/20 mix). */
export const BUDGET_CAPS: Readonly<Record<'cheap' | 'balanced' | 'premium', number>> = { cheap: 1, balanced: 6, premium: 30 };

/** The reference rate the price score is measured against when the budget sets no ceiling. */
export const PRICE_REFERENCE_PER_M = 20;

/** How many rows `recommend` returns unless asked otherwise. */
export const RECOMMEND_LIMIT = 5;

function capOf(budget: Budget | undefined): number | null {
  if (budget === undefined || budget === 'any') return null;
  if (typeof budget === 'number') return Number.isFinite(budget) && budget > 0 ? budget : null;
  return BUDGET_CAPS[budget];
}

function contextScore(model: ModelInfo, max: number): number {
  const ctx = model.contextLength;
  if (ctx === undefined) return 0;
  if (ctx >= 1_000_000) return max;
  if (ctx >= 400_000) return Math.round(max * 0.75);
  if (ctx >= 200_000) return Math.round(max * 0.5);
  if (ctx >= 128_000) return Math.round(max * 0.25);
  return 0;
}

/** Cheaper scores higher, linearly, from 0 at the reference rate to `max` at free. */
function priceScore(model: ModelInfo, reference: number, max: number): number {
  const blended = blendedPerM(model.pricing);
  if (blended === null) return 0;
  const ratio = Math.min(1, blended / reference);
  return Math.round(max * (1 - ratio));
}

interface Weights {
  tools: number;
  structured: number;
  reasoning: number;
  context: number;
  price: number;
  adapter: number;
}

const WEIGHTS: Readonly<Record<ModelTask, Weights>> = {
  generator: { tools: 40, structured: 25, reasoning: 15, context: 20, price: 20, adapter: 10 },
  decider: { tools: 15, structured: 40, reasoning: 5, context: 10, price: 40, adapter: 10 },
};

/** Penalty for a model the provider has announced a shutdown or expiry date for. */
export const DEPRECATED_PENALTY = 60;

/**
 * Score penalty for an OpenRouter routing variant (`:free`, `:batch`, `:nitro`, `:extended`). The
 * predicate itself lives in search.ts, where `compareModels` uses it as a tie-break so the ranking
 * and the recommendation agree that a serving term is not a distinct model; `:free` prices at zero,
 * which would otherwise win every budget comparison outright. Variants stay in both lists; they
 * just stop topping them.
 */
export const VARIANT_PENALTY = 25;

/**
 * A nudge towards the generator jevcode already ships with (config/defaults.ts `DEFAULT_MODEL` on
 * `DEFAULT_PROVIDER`). Small enough to lose to a materially better model and large enough to win a
 * near-tie, so onboarding recommends what the product actually defaults to instead of whichever
 * flash model happens to be a hundredth of a cent cheaper this week.
 */
export const DEFAULT_MODEL_BONUS = 8;

/** How many of the capability flags a model declares; the tie-break between a cheaper model and the project default. */
function capabilityCount(model: ModelInfo): number {
  // the three capabilities the generator score weighs; vision is not one a coding generator is chosen for
  return [model.supports.tools, model.supports.structuredOutput, model.supports.reasoning].filter((v) => v === true).length;
}

/** Meta's `*-contributor` ids and the like: a programme tier priced for its participants, not the general model. */
function isContributorTier(id: string): boolean {
  return /-contributor(?:[:@-]|$)/i.test(id);
}

function isProjectDefault(model: ModelInfo): boolean {
  return model.provider === DEFAULT_PROVIDER && model.id === DEFAULT_MODEL;
}

function scoreModel(model: ModelInfo, task: ModelTask, reference: number): { score: number; reasons: string[] } {
  const w = WEIGHTS[task];
  const reasons: string[] = [];
  let score = 0;

  const caps: string[] = [];
  if (model.supports.tools === true) {
    score += w.tools;
    caps.push('tools');
  }
  if (model.supports.structuredOutput === true) {
    score += w.structured;
    caps.push('structured outputs');
  }
  if (model.supports.reasoning === true) {
    score += w.reasoning;
    caps.push('reasoning');
  }
  if (caps.length > 0) reasons.push(caps.join(' + '));

  const ctx = contextScore(model, w.context);
  score += ctx;
  if (ctx > 0 && model.contextLength !== undefined) reasons.push(`${formatTokens(model.contextLength)} context`);

  const price = priceScore(model, reference, w.price);
  score += price;
  if (model.pricing !== undefined) reasons.push(formatPricing(model.pricing));

  if (isGeneratorProvider(model.provider)) {
    score += w.adapter;
    reasons.push(`${providerDisplayName(model.provider)} adapter ships today`);
  } else {
    reasons.push(providerDisplayName(model.provider));
  }

  if (task === 'generator' && isProjectDefault(model)) {
    score += DEFAULT_MODEL_BONUS;
    reasons.push("jevcode's default generator");
  }

  if (isRoutingVariant(model.id)) {
    score -= VARIANT_PENALTY;
    reasons.push('routing variant, not a distinct model');
  }
  if (isContributorTier(model.id)) {
    // a provider's contributor-programme tier (Meta's `-contributor` ids): priced for its participants, not a general
    // offer, so it must not outrank the general model it is a tier of — seven providers are generators now
    score -= VARIANT_PENALTY;
    reasons.push('contributor-programme tier, not the general offer');
  }

  if (model.deprecated === true) {
    score -= DEPRECATED_PENALTY;
    reasons.push('deprecated — a shutdown date is published');
  }
  return { score, reasons };
}

/**
 * A ranked shortlist with reasons. `budget` caps the blended rate: `cheap` ≤ $1/M, `balanced` ≤ $6/M,
 * `premium` ≤ $30/M, a number is its own ceiling, `any` (the default) does not filter. Under a
 * ceiling, unpriced models are dropped — an unknown price cannot be shown to respect a budget.
 */
export function recommend(opts: RecommendOptions): Recommendation[] {
  const providers = opts.providers;
  const pool = opts.models ?? instantCatalogue(providers ?? undefined);
  const cap = capOf(opts.budget);
  const reference = cap ?? PRICE_REFERENCE_PER_M;
  const filtered = filterModels(pool, {
    ...(providers === undefined ? {} : { providers }),
    includeDeprecated: false,
  }).filter((m) => {
    if (cap === null) return true;
    const blended = blendedPerM(m.pricing);
    return blended !== null && blended <= cap;
  });

  const scored = filtered.map((model) => {
    const { score, reasons } = scoreModel(model, opts.task, reference);
    return { model, score, reasons };
  });
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : compareModels(a.model, b.model)));
  // the project's default generator leads unless something MORE CAPABLE is eligible (generator-only, like the nudge): with seven generator providers a
  // cheaper model of equal capability would otherwise displace the model the product ships with and was measured with,
  // on price alone — the nudge (DEFAULT_MODEL_BONUS) still loses to a model that can do more
  if (opts.task === 'generator') {
    const i = scored.findIndex((r) => isProjectDefault(r.model));
    if (i > 0 && capabilityCount(scored[0]!.model) <= capabilityCount(scored[i]!.model)) scored.unshift(...scored.splice(i, 1));
  }
  const limit = opts.limit ?? RECOMMEND_LIMIT;
  return scored.slice(0, Math.max(0, limit));
}

/** The single best model for a task, or null when the filters left nothing. */
export function recommendOne(opts: RecommendOptions): Recommendation | null {
  return recommend({ ...opts, limit: 1 })[0] ?? null;
}
