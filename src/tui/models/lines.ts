/**
 * The model picker's row text (TUI-DESIGN-5 §6.4, §6.5, §6.7, §6.8; strings S99–S108 of §12.5; the pin inventory
 * §13.1 row "S99–S108").
 *
 * **The rule this module obeys, stated once (§13.1):** every *word* a picker row shows comes from
 * `src/models/format.ts` — `modelSummary`, `sourceLabel`, `errorLabel`, `catalogueSummary` and the three part
 * formatters `modelSummary` is composed from. This module owns the **layout**: which parts a narrow row drops, the
 * rule row, the provenance row, the `--plain` numbered twin and the screen-reader sentence. It never re-declares a
 * string the catalogue already produces, which is what keeps the TUI row, the `--plain` row and `transcript.log`
 * equal under §5.3's normaliser.
 *
 * Like `./state.ts` it takes `src/models/**` by `import type` only and receives the functions through the
 * `ModelsText` seam — see that module's docblock for why `src/models/static.ts` is **not** the zero-import module
 * §6.2 claims it is, and why `src/cli/login.ts` (which is on the argv path through `src/cli/session.ts:194`) can
 * nonetheless import this file.
 */
import { GLYPHS, type GlyphSet, cellWidth, glyphTwin, truncateCells } from '../glyphs.js';
import { fitRung } from '../fit.js';
import type { ListResult, ModelInfo, ModelPricing, ModelSupports, ModelsError, ProviderId } from '../../models/types.js';
import type { ModelsSearch } from './state.js';

/**
 * The formatting half of the seam. Structurally satisfied by `src/models/index.ts`; the compile-time proof
 * (`const api: ModelsApi = models`) lives in `test/unit/tui/models/lines.test.ts`, so a signature change in
 * `src/models/format.ts` breaks the build rather than the picker.
 */
export interface ModelsText {
  modelSummary(model: ModelInfo): string;
  contextSummary(model: ModelInfo): string;
  capabilitySummary(supports: ModelSupports): string;
  formatPricing(pricing: ModelPricing | undefined): string;
  formatRate(perM: number): string;
  providerDisplayName(id: ProviderId): string;
  sourceLabel(result: ListResult, nowMs: number): string;
  errorLabel(provider: ProviderId, error: ModelsError): string;
  catalogueSummary(results: readonly ListResult[]): string;
  isGeneratorProvider(id: ProviderId): boolean;
}

/**
 * Both halves of the seam — what the `'models'` arm binds from one `await import('../models/index.js')`.
 *
 * The two **catalogue** members are optional and are the picker's first paint: `instantCatalogue()` is the
 * bundled snapshot (no I/O, no await) and `SNAPSHOT_AT` is the date its provenance row reports. They are here
 * rather than in a second seam because `src/models/index.ts` already exports both — binding the module gives the
 * App all four halves from ONE `await import()`, so `AppProps.models` alone really does mean "nothing is
 * imported at all" instead of quietly needing `instantModels` beside it to be true.
 */
export interface ModelsApi extends ModelsText, ModelsSearch {
  instantCatalogue?(): readonly ModelInfo[];
  SNAPSHOT_AT?: string;
}

// ---------------------------------------------------------------------------------------
// §12.5 strings. Every one is a named export so §13.4's pin test greps a constant, never a literal.
// ---------------------------------------------------------------------------------------

/** §12.5 S105 / §7 row 74: the zero-provider empty state. */
export const NO_PROVIDER_CONFIGURED = 'no provider is configured — /login adds a key';

/**
 * §12.5 S107 / §7 row 77: one constant, deleted in one place once the five adapters are wired as generators.
 * `BROWSE_ONLY` is the **row cell** — the marker that rides every rung of a model whose provider has no generator
 * adapter (`modelRowRungs`) — and `browseOnlyText` is the **sentence** `/model <id>` refuses with. The cell is a
 * substring of the sentence by construction, so §13.4's pin greps one word and finds both.
 */
export const BROWSE_ONLY = 'browse only';
export function browseOnlyText(id: string): string {
  return `${id} — ${BROWSE_ONLY}, generation not yet available`;
}

/**
 * §13.2 clause 7, the zero-hit case: the numbered twin has nothing to number, so it says so rather than printing
 * `models (1-0 of 0)` and arming `pick 1-0`. One sentence, the shape of S104's refusal (a new §12.5 row — see the
 * owner request in R5-6's report).
 */
/**
 * §6.2 / §7 row 71: the body row of a models picker whose **catalogue seam has not arrived yet**.
 *
 * `openModelsPicker` binds the seam before it opens the pane, so the mounted `/model` never shows this. An
 * external `Renderer.openPicker({ kind: 'models' })` can, and its first frame used to read `no model matches …`
 * beside a rule row already claiming `models · 512 of 7 providers` — a frame that contradicts itself, which is
 * the one thing §6.2 says frame 1 may never be. Zero hits because nothing is loaded and zero hits because the
 * query missed are different facts and now say different things.
 */
export const MODELS_LOADING = 'loading the catalogue …';

export function noModelMatchText(query: string): string {
  const q = query.trim();
  return q === '' ? 'no models to show — type a query, or Esc closes' : `no model matches ${q} — type a query, or Esc closes`;
}

/**
 * §12.5 S104 / §7 row 75: the **refusal**, used only once every configured provider's `sourceLabel` is `live` or
 * `cached …` (`catalogueSettled`). With no near misses the question half is dropped rather than left empty.
 */
export function noModelNamedText(id: string, misses: readonly string[]): string {
  const head = `no model named ${id}`;
  const tail = ' (/model to browse)';
  if (misses.length === 0) return `${head}${tail}`;
  const list = misses.length === 1 ? misses[0] : `${misses.slice(0, -1).join(', ')} or ${misses[misses.length - 1]}`;
  return `${head} — did you mean ${list}?${tail}`;
}

/**
 * §12.5 S104a / §7 row 100: the **warning**, and the value is set. Refusing a valid id offline, before the
 * catalogue settles, or for a model newer than the snapshot would be a regression on today's verbatim
 * `pending.model = id`.
 */
export function modelPendingText(id: string): string {
  return `model ${id} pending (next run) — not in the catalogue yet (bundled snapshot); /model browses once it loads`;
}

/**
 * §12.5 S106: `<provider> key verified — <n> models`. The count is **omitted, not zeroed**, when the check could
 * not produce one — OpenRouter's key check is `GET /key`, whose body is key metadata and carries no model list
 * (`src/models/verify.ts`'s endpoint table). `— 0 models` would read as "this key sees nothing", which is false;
 * the same omission rule §13.2 clauses 4 and 5 state for the resume card's `ctx` and `/cost`'s `held`.
 */
export function keyVerifiedText(provider: string, models?: number): string {
  if (models === undefined) return `${provider} key verified`;
  return `${provider} key verified — ${models} model${models === 1 ? '' : 's'}`;
}
/** §12.5 S106: `<provider> key rejected (401)`. */
export function keyRejectedText(provider: string, status: number): string {
  return `${provider} key rejected (${status})`;
}
/** §12.5 S106: `<provider>: rate limited — try again`. */
export function keyRateLimitedText(provider: string): string {
  return `${provider}: rate limited — try again`;
}

/** §13.2 clause 7: the `--plain` twin numbers at most this many rows, whatever the catalogue holds. */
export const MODELS_PLAIN_CAP = 40;
/** §12.5 S99 SR: at most one spoken line per this many ms. */
export const SR_COALESCE_MS = 400;

// ---------------------------------------------------------------------------------------
// The row: composed, never truncated (§6.4)
// ---------------------------------------------------------------------------------------

/** `$0.15/$0.50` — the 40-column price cell (F-59); `unpriced` keeps the catalogue's own word. */
export function compactPrice(text: ModelsText, pricing: ModelPricing | undefined): string {
  if (pricing === undefined) return text.formatPricing(undefined);
  return `${text.formatRate(pricing.inputPerM)}/${text.formatRate(pricing.outputPerM)}`;
}

/**
 * §6.4 / §6.8: the row's rungs, widest first. The drop order is **capabilities → output window → context window →
 * provider name**, leaving `id · $in/$out`. `deprecated` is carried on every rung: it is a warning about what the
 * row *is*, not decoration, and a user picking a dead model at 40 columns needs it more, not less.
 */
export function modelRowRungs(model: ModelInfo, text: ModelsText, g: GlyphSet = GLYPHS.unicode): string[] {
  const dot = ` ${g.dot} `;
  const id = model.id;
  const provider = text.providerDisplayName(model.provider);
  const price = text.formatPricing(model.pricing);
  const ctxFull = text.contextSummary(model);
  /**
   * `contextSummary` is `"1.3M ctx → 944k out"` and the arrow it writes is the **unicode** one
   * (`src/models/format.ts:32`), whatever glyph set the row will be drawn in — `glyphTwin` substitutes afterwards,
   * in `modelRow`. Splitting on `g.arrow` therefore never matched under `--ascii` (`'->'`), rungs 2 and 3 came out
   * byte-identical and the ASCII ladder dropped the context window a whole rung early.
   */
  const ctxOnly = ctxFull.includes(CONTEXT_ARROW) ? (ctxFull.split(CONTEXT_ARROW)[0] ?? '') : ctxFull;
  const dep = model.deprecated === true ? ['deprecated'] : [];
  // §7 row 77: a model whose provider has no generator adapter is MARKED, on every rung — at 40 columns a user
  // about to pick a model that cannot run needs the reason more, not less (the `deprecated` rule, reused)
  const browse = text.isGeneratorProvider(model.provider) ? [] : [BROWSE_ONLY];
  const marks = [...browse, ...dep];
  const join = (parts: readonly string[]): string => parts.filter((p) => p !== '').join(dot);
  return [
    // rung 1 is `modelSummary` verbatim — the string §12.5 S100 pins and `transcript.log` writes — plus the S107
    // marker, which `modelSummary` cannot carry (the catalogue does not know what this build can generate with)
    join([text.modelSummary(model), ...browse]),
    join([id, provider, ctxFull, price, ...marks]),
    join([id, provider, ctxOnly, price, ...marks]),
    join([id, provider, price, ...marks]),
    join([id, compactPrice(text, model.pricing), ...marks]),
  ];
}

/**
 * One picker row at `columns` cells. The widest rung that fits wins; `truncateCells` is the last resort and cuts on
 * grapheme boundaries, so no row is ever cut mid-grapheme (§10 `models/lines.test.ts`).
 */
export function modelRow(model: ModelInfo, columns: number, text: ModelsText, g: GlyphSet = GLYPHS.unicode): string {
  const width = Math.max(0, Math.floor(Number.isFinite(columns) ? columns : 0));
  const rungs = modelRowRungs(model, text, g).map((r) => glyphTwin(r, g));
  const picked = fitRung(rungs, width);
  return cellWidth(picked) <= width ? picked : truncateCells(picked, width, g);
}

// ---------------------------------------------------------------------------------------
// The rule row (S99) and the provenance row (S101–S103)
// ---------------------------------------------------------------------------------------

/** The shortest rule tail the header keeps to its right — `pickerHeader`'s own constant (`picker-lines.ts:254`). */
const HEADER_MIN_TAIL = 4;

/** What `contextSummary` puts between the context window and the output window — always this, never `g.arrow`. */
const CONTEXT_ARROW = ' \u2192 ';

export interface ModelsRuleOptions {
  /**
   * §12.5 S99 / F-58: the **catalogue** total, not the filtered row count. F-58 draws the header as
   * `models · 512 of 7 providers` with `glm` already typed in the composer and three rows on screen, so the number
   * is what the picker holds, not what the query left. `state.models.length`.
   */
  total: number;
  /**
   * Providers the load **covers** — `results.length + pending.length`, not the number that have answered. The
   * first synchronous paint of §6.2 has zero results by construction, and `models · 69 of 0 providers` is a lie
   * the user sees for as long as the network takes.
   */
  providers: number;
  columns: number;
  glyphs?: GlyphSet;
}

/**
 * §12.5 S99 / F-58 / F-59: `─── models · 512 of 7 providers · by relevance ─ ↑↓ Enter Tab Esc ────`, dropping to
 * `─── models · 512 ─ ↑↓ Enter Esc ────` when the full form does not fit. Built the way `pickerHeader` builds its
 * own (`src/session/picker-lines.ts:266`): the text, then `g.rule` padding to `columns`.
 */
export function modelsRule(o: ModelsRuleOptions): string {
  const g = o.glyphs ?? GLYPHS.unicode;
  const arrows = `${g.up}${g.down}`;
  const wide = `${g.rule.repeat(3)} models ${g.dot} ${o.total} of ${o.providers} provider${o.providers === 1 ? '' : 's'} ${g.dot} by relevance ${g.rule} ${arrows} Enter Tab Esc `;
  const narrow = `${g.rule.repeat(3)} models ${g.dot} ${o.total} ${g.rule} ${arrows} Enter Esc `;
  const columns = Math.max(0, Math.floor(Number.isFinite(o.columns) ? o.columns : 0));
  if (columns === 0) return wide + g.rule.repeat(HEADER_MIN_TAIL);
  const text = cellWidth(wide) + HEADER_MIN_TAIL <= columns ? wide : narrow;
  const pad = columns - cellWidth(text);
  return pad > 0 ? text + g.rule.repeat(pad) : truncateCells(text, columns, g);
}

/**
 * §12.5 S105 / §7 row 74: is there **no provider configured at all**? `loadCatalogue` returns exactly one
 * `ListResult` per requested provider and never an empty list, so `results.length === 0` — the condition the first
 * draft gated on — is a state the real loader cannot produce. The reachable one is "every provider answered
 * `no_key`": OpenRouter lists without a key, so a single unauthenticated provider makes this false.
 */
export function noProviderConfigured(results: readonly ListResult[]): boolean {
  return results.length > 0 && results.every((r) => r.error?.kind === 'no_key');
}

/** The same question for a caller that may hold nothing at all: no rows AND no answers is also "nothing here". */
export function noProviderAtAll(results: readonly ListResult[], models: readonly ModelInfo[]): boolean {
  return noProviderConfigured(results) || (results.length === 0 && models.length === 0);
}

/** One provenance cell per provider: `OpenRouter live`, `Anthropic cached 3 h ago`, or the whole `errorLabel`. */
export function provenanceCells(results: readonly ListResult[], nowMs: number, text: ModelsText): string[] {
  return results.map((r) => (r.error === undefined ? `${text.providerDisplayName(r.provider)} ${text.sourceLabel(r, nowMs)}` : text.errorLabel(r.provider, r.error)));
}

/**
 * §7 rows 70–73 / §12.5 S101–S103 / §6.8: the provenance row. Nothing is ever hidden — a provider with no key keeps
 * its rows and its reason. Three rungs: every provider named (120), two named plus the rest counted (80), and the
 * healthy head plus a count (40) — `OpenRouter live · 2 providers no key`, F-59 verbatim. The narrowest rung says
 * `no key` only when every degraded provider's error really is `no_key`; otherwise it says `unavailable`, the word
 * `catalogueSummary` uses.
 */
export function provenanceRow(results: readonly ListResult[], nowMs: number, columns: number, text: ModelsText, g: GlyphSet = GLYPHS.unicode): string {
  const width = Math.max(0, Math.floor(Number.isFinite(columns) ? columns : 0));
  if (results.length === 0) return '';
  const dot = ` ${g.dot} `;
  const cells = provenanceCells(results, nowMs, text);
  const degraded = results.filter((r) => r.error !== undefined);
  const healthy = results.filter((r) => r.error === undefined);
  const noKeyOnly = degraded.length > 0 && degraded.every((r) => r.error?.kind === 'no_key');
  const tail = degraded.length === 0 ? '' : `${degraded.length} provider${degraded.length === 1 ? '' : 's'} ${noKeyOnly ? 'no key' : 'unavailable'}`;
  const head = healthy[0] === undefined ? '' : `${text.providerDisplayName(healthy[0].provider)} ${text.sourceLabel(healthy[0], nowMs)}`;
  const rungs = [
    cells.join(dot),
    [...cells.slice(0, 2), ...(cells.length > 2 ? [`+${cells.length - 2} more`] : [])].join(dot),
    [head, tail].filter((s) => s !== '').join(dot),
    text.catalogueSummary(results),
  ].map((r) => glyphTwin(r, g));
  const picked = fitRung(rungs, width);
  return cellWidth(picked) <= width ? picked : truncateCells(picked, width, g);
}

// ---------------------------------------------------------------------------------------
// The `--plain` twin (§13.2 clause 7) and the screen-reader line (§12.5 S99 SR)
// ---------------------------------------------------------------------------------------

/** §13.2 clause 7: how many rows the numbered twin prints for `total` rows under `cap`. */
export function modelsShown(total: number, cap: number = MODELS_PLAIN_CAP): number {
  const n = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  return Number.isFinite(cap) ? Math.min(n, Math.max(0, Math.floor(cap))) : n;
}

/**
 * §13.2 clause 7: the one-shot prompt, `pick 1-40, or type a query > `, armed for exactly one turn. With nothing
 * numbered there is no range to arm, so the digit half is dropped rather than printed as `pick 1-0`.
 */
export function modelsPickPrompt(shown: number): string {
  return shown <= 0 ? 'type a query > ' : `pick 1-${shown}, or type a query > `;
}

export interface ModelsPlainOptions {
  /** the rows to number (the picker hands over the ranked window; the CLI verb hands over everything) */
  models: readonly ModelInfo[];
  text: ModelsText;
  results?: readonly ListResult[];
  nowMs?: number;
  /** `--plain` under a pipe has no TTY width; §13.2 clause 1's rule is 120 */
  columns?: number;
  glyphs?: GlyphSet;
  /**
   * How many rows may be numbered. `MODELS_PLAIN_CAP` (40) is the **picker's** viewport, which is what §13.2
   * clause 7 scopes its cap to; `jevcode models list --plain` passes `Infinity`, because §6.6's `list` prints
   * "one row per model" and §13.2 clause 6 states the same rule for the agents twin — a `--plain` twin's row
   * count equals `rows.length`, it is never a silent filter.
   */
  cap?: number;
  /**
   * The pre-cap row count the head reports (`state.models.length` for the picker). Defaults to `models.length`,
   * so the viewport cap can never become the number the UI calls the total.
   */
  total?: number;
  /**
   * Does the caller arm `modelsPickPrompt` for one turn? Only the picker does. A non-interactive CLI verb prints
   * no `type a number, "more", or a query, then Enter` sentence, because there is no turn in which to answer it.
   */
  prompt?: boolean;
  /** the live composer text, named by the zero-hit sentence */
  query?: string;
}

/**
 * §12.5 S99 `--plain` / §13.2 clause 7: `models (1-40 of 512) — type a number, "more", or a query, then Enter`,
 * then the numbered rows, then the provenance row. The caller arms `modelsPickPrompt(shown)` for one turn.
 * With nothing configured the whole block is S105's one sentence (§7 row 74).
 */
export function modelsPlainLines(o: ModelsPlainOptions): string[] {
  const g = o.glyphs ?? GLYPHS.unicode;
  const columns = o.columns ?? 120;
  const results = o.results ?? [];
  const total = o.total ?? o.models.length;
  const shown = modelsShown(o.models.length, o.cap ?? MODELS_PLAIN_CAP);
  const prompt = o.prompt !== false;
  // §7 rows 71 + 74 read together: the sentence is printed ABOVE the snapshot rows, never instead of them
  const head: string[] = noProviderAtAll(results, o.models) ? [NO_PROVIDER_CONFIGURED] : [];
  const tail = results.length === 0 ? [] : [provenanceRow(results, o.nowMs ?? 0, columns, o.text, g)].filter((r) => r !== '');
  if (shown === 0) {
    // nothing to number. With no provider at all that is S105's whole answer (§7 row 74); otherwise the query
    // simply matched nothing, which is the ordinary `models search zzz` / typed-a-bad-filter case.
    const body = head.length > 0 && total === 0 ? [] : [glyphTwin(noModelMatchText(o.query ?? ''), g)];
    return [...head, ...body].map((l) => truncateCells(l, columns, g)).concat(tail);
  }
  const counted = `models (1-${shown} of ${total})`;
  head.push(prompt ? `${counted} ${g.dash} type a number, "more", or a query, then Enter` : counted);
  const rows: string[] = [];
  for (let i = 0; i < shown; i++) {
    const m = o.models[i];
    if (m === undefined) continue;
    const n = `${i + 1}`.padStart(`${shown}`.length, ' ');
    rows.push(`${n} ${modelRow(m, Math.max(1, columns - `${n} `.length), o.text, g)}`);
  }
  return [...head.map((l) => truncateCells(l, columns, g)), ...rows, ...tail];
}

export interface ModelsSrOptions {
  index: number;
  count: number;
  model: ModelInfo | null;
  text: ModelsText;
  /** §14.2 #53 / §7 row 81: `ascii` wins over `screenReader`, so the SR sentence substitutes too */
  glyphs?: GlyphSet;
}

/**
 * §12.5 S99 SR: `models: 3 of 40 · z-ai/glm-5.3-flash · OpenRouter · $0.15/M in · Enter picks, Tab narrows, Esc
 * closes`. One sentence, no glyph-only row (§7 row 82).
 */
export function modelsSrLine(o: ModelsSrOptions): string {
  const g = o.glyphs ?? GLYPHS.unicode;
  const dot = ` ${g.dot} `;
  const keys = 'Enter picks, Tab narrows, Esc closes';
  if (o.model === null || o.count === 0) return glyphTwin(['models: 0 of 0', keys].join(dot), g);
  const price = o.model.pricing === undefined ? o.text.formatPricing(undefined) : `${o.text.formatRate(o.model.pricing.inputPerM)}/M in`;
  const browse = o.text.isGeneratorProvider(o.model.provider) ? [] : [BROWSE_ONLY];
  return glyphTwin([`models: ${o.index + 1} of ${o.count}`, o.model.id, o.text.providerDisplayName(o.model.provider), price, ...browse, keys].join(dot), g);
}

/**
 * §12.5 S99 SR: at most one spoken line per `SR_COALESCE_MS`. Pure — the caller keeps `lastAtMs` and passes the
 * clock, so nothing here is on a timer (gate G-R5-3's rule).
 */
export function srDue(lastAtMs: number | null, nowMs: number): boolean {
  return lastAtMs === null || nowMs - lastAtMs >= SR_COALESCE_MS;
}

// ---------------------------------------------------------------------------------------
// `/model <id>` — a check, not a gate (§6.4, §7 row 100)
// ---------------------------------------------------------------------------------------

/** What `/model <id>` should do with a typed id. `ok` carries the resolved row so the caller can name it. */
export type ModelCheck = { kind: 'ok'; model: ModelInfo } | { kind: 'warn'; text: string } | { kind: 'refuse'; text: string };

/**
 * §6.4 / §7 row 100: resolve `id` against the **union of the loaded catalogue and the bundled snapshot**. A miss is
 * a refusal only when `settled` (every configured provider answered `live` or `cached …`); otherwise it is a
 * warning and the caller sets the value, exactly as `src/cli/session.ts` does today.
 */
export function modelCheck(id: string, models: readonly ModelInfo[], settled: boolean, api: ModelsSearch & Pick<ModelsText, 'isGeneratorProvider'>): ModelCheck {
  const found = api.findModel(id, models);
  // §7 row 77: a hit whose provider has no generator adapter is REFUSED as a pending value, with the reason —
  // pending it would start a run that cannot run. This arm is deleted with `browseOnlyText` when D-AP's adapters land.
  if (found !== null && !api.isGeneratorProvider(found.provider)) return { kind: 'refuse', text: browseOnlyText(found.id) };
  if (found !== null) return { kind: 'ok', model: found };
  if (!settled) return { kind: 'warn', text: modelPendingText(id) };
  return { kind: 'refuse', text: noModelNamedText(id, api.nearMisses(id, models, 3).map((m) => m.id)) };
}
