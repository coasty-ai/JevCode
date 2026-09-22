/**
 * Fuzzy model search with a deterministic total order — the function a picker calls on every
 * keystroke.
 *
 * Ranking: exact > prefix > word-start > subsequence, each plus a closeness bonus so the shortest
 * id that matches wins its band ("gpt-5" puts `gpt-5` above `gpt-5.4-mini`). Ties are broken by
 * live-before-deprecated, tools-capable first, cheapest blended rate (unpriced last), provider
 * display order, then id — so the same query always produces the same list.
 *
 * Matching is done on a normalised form (lower case, non-alphanumerics dropped), which makes
 * "gpt6", "gpt-6" and "GPT 6" the same query and lets a provider-qualified query work against both
 * spellings of a namespaced id ("openai/gpt-6-astra" and OpenAI's own "gpt-6-astra").
 */
import { PROVIDER_IDS, providerDisplayName } from './providers.js';
import { modelBlendedPerM } from './pricing.js';
import { loadCatalogue } from './list.js';
import type { Capability, MatchKind, ModelInfo, RankOptions, SearchHit, SearchOptions } from './types.js';

const SCORE: Readonly<Record<MatchKind, number>> = { exact: 1000, prefix: 800, word: 600, fuzzy: 300 };
/** Ceiling on the "how much longer than the query is the match" bonus, in points. */
export const CLOSENESS_MAX = 50;

/** Lower case, alphanumerics only: "GPT-5.6 Sol" → "gpt56sol". */
export function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Word starts of a label, normalised: "Claude Sonnet 5" → ["claude", "sonnet", "5"]. */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

/** Every character of `q` appears in `hay`, in order (the classic fuzzy-finder test). */
export function isSubsequence(q: string, hay: string): boolean {
  if (q === '') return true;
  let i = 0;
  for (const ch of hay) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

function closeness(q: string, hay: string): number {
  return Math.max(0, CLOSENESS_MAX - Math.max(0, hay.length - q.length));
}

interface HaystackMatch {
  kind: MatchKind;
  score: number;
}

/** Best match of a normalised query against one haystack, or null. */
function matchHaystack(q: string, raw: string): HaystackMatch | null {
  const hay = normalise(raw);
  if (hay === '') return null;
  if (hay === q) return { kind: 'exact', score: SCORE.exact + CLOSENESS_MAX };
  if (hay.startsWith(q)) return { kind: 'prefix', score: SCORE.prefix + closeness(q, hay) };
  if (words(raw).some((w) => normalise(w).startsWith(q))) return { kind: 'word', score: SCORE.word + closeness(q, hay) };
  if (isSubsequence(q, hay)) return { kind: 'fuzzy', score: SCORE.fuzzy + closeness(q, hay) };
  return null;
}

/**
 * What a query is matched against:
 *  - the id, and its last path segment — "glm" should be a prefix hit on `z-ai/glm-5.3-flash` and
 *    on `accounts/fireworks/models/glm-5p3-flash`, not a weaker fuzzy one just because the vendor
 *    namespace comes first;
 *  - the label;
 *  - the provider-qualified id and the fully spelled-out "OpenRouter Z.ai: GLM 5.3 Flash", which
 *    are what make "openai gpt6" and "openrouter glm" work.
 */
function haystacks(model: ModelInfo): string[] {
  const hays = [model.id, model.displayName, `${model.provider}/${model.id}`, `${providerDisplayName(model.provider)} ${model.displayName}`];
  const slash = model.id.lastIndexOf('/');
  if (slash !== -1 && slash + 1 < model.id.length) hays.push(model.id.slice(slash + 1));
  return hays;
}

/** The best (kind, score) for a model, or null when nothing matched. */
export function matchModel(query: string, model: ModelInfo): HaystackMatch | null {
  const q = normalise(query);
  if (q === '') return { kind: 'prefix', score: 0 };
  let best: HaystackMatch | null = null;
  for (const hay of haystacks(model)) {
    const m = matchHaystack(q, hay);
    if (m === null) continue;
    if (best === null || m.score > best.score) best = m;
  }
  return best;
}

function capabilityList(c: RankOptions['capability']): readonly Capability[] {
  if (c === undefined) return [];
  return typeof c === 'string' ? [c] : c;
}

/** `providers` / `capability` / `includeDeprecated` applied, without ranking. */
export function filterModels(models: readonly ModelInfo[], opts: RankOptions = {}): ModelInfo[] {
  const providers = opts.providers;
  const caps = capabilityList(opts.capability);
  return models.filter((m) => {
    if (providers !== undefined && !providers.includes(m.provider)) return false;
    if (opts.includeDeprecated === false && m.deprecated === true) return false;
    for (const cap of caps) if (m.supports[cap] !== true) return false;
    return true;
  });
}

function providerOrder(model: ModelInfo): number {
  const i = PROVIDER_IDS.indexOf(model.provider);
  return i === -1 ? PROVIDER_IDS.length : i;
}

/** The deterministic tie-break chain, applied after `score`. Exported for the picker's own sorts. */
export function compareModels(a: ModelInfo, b: ModelInfo): number {
  const da = a.deprecated === true ? 1 : 0;
  const db = b.deprecated === true ? 1 : 0;
  if (da !== db) return da - db;
  const ta = a.supports.tools === true ? 0 : 1;
  const tb = b.supports.tools === true ? 0 : 1;
  if (ta !== tb) return ta - tb;
  const pa = modelBlendedPerM(a);
  const pb = modelBlendedPerM(b);
  if (pa !== pb) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa - pb;
  }
  const oa = providerOrder(a);
  const ob = providerOrder(b);
  if (oa !== ob) return oa - ob;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Rank `models` against `query`. Pure: no I/O, no clock — the same inputs always give the same
 * list, which is what makes the picker's behaviour testable keystroke by keystroke.
 *
 * An empty query ranks nothing and returns every model that passes the filters, in `compareModels`
 * order (the picker's default list).
 */
export function rankModels(query: string, models: readonly ModelInfo[], opts: RankOptions = {}): SearchHit[] {
  const pool = filterModels(models, opts);
  const hits: SearchHit[] = [];
  for (const model of pool) {
    const m = matchModel(query, model);
    if (m === null) continue;
    hits.push({ model, score: m.score, matched: m.kind });
  }
  hits.sort((x, y) => (y.score !== x.score ? y.score - x.score : compareModels(x.model, y.model)));
  return opts.limit !== undefined && opts.limit >= 0 ? hits.slice(0, opts.limit) : hits;
}

/**
 * Search the catalogue. With `models` it is the pure ranking above; without, it loads the requested
 * providers first (network → cache → snapshot, never throwing) and ranks what came back.
 */
export async function searchModels(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  if (opts.models !== undefined) return rankModels(query, opts.models, opts);
  const load = await loadCatalogue({
    ...(opts.providers === undefined ? {} : { providers: opts.providers }),
    ...(opts.keys === undefined ? {} : { keys: opts.keys }),
    ...(opts.deps === undefined ? {} : { deps: opts.deps }),
    ...(opts.offline === undefined ? {} : { offline: opts.offline }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  return rankModels(query, load.models, opts);
}

/** Exact id lookup across a loaded catalogue (`/model <id>` validation). */
export function findModel(id: string, models: readonly ModelInfo[]): ModelInfo | null {
  const needle = id.trim();
  return models.find((m) => m.id === needle) ?? null;
}

/**
 * The "did you mean" set for an id that matched nothing exactly: the same ranking, minus the id
 * itself, best match first.
 */
export function nearMisses(id: string, models: readonly ModelInfo[], limit = 3): ModelInfo[] {
  const needle = id.trim();
  if (normalise(needle) === '') return [];
  return rankModels(needle, models, { limit: limit + 1 })
    .map((h) => h.model)
    .filter((m) => m.id !== needle)
    .slice(0, limit);
}
