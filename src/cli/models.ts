/**
 * `jevcode models [list|search <query>|refresh]` (TUI-DESIGN-5 §6.6, §13.3) — the CLI twin of the `/model` picker.
 *
 * Pure over an injected I/O seam, exactly like `src/cli/sessions.ts`: **nothing here starts an engine**, resolves a
 * run directory or touches the session index. The catalogue itself arrives through one `await import()` so that
 * `src/models/**` (and with it `provider/openrouter.js`) never joins `src/cli/main.tsx`'s static import graph —
 * §6.2's first-frame rule and gate G-R5-1.
 *
 * | verb | what it does |
 * | --- | --- |
 * | `list [--provider <id>]` | the catalogue, **snapshot-first**: disk cache → bundled snapshot, never the network |
 * | `search <query> [--provider <id>]` | `rankModels` over the same list — Aider's `--list-models <substring>` shape |
 * | `refresh [--provider <id>]` | the explicit, user-initiated fetch; **the only verb that goes to the network** |
 *
 * §15 Q13's rule, as code: `list` and `search` pass `offline: true`, so a `jevcode models list` in a script,
 * a shell completion or a prompt cannot fire seven provider requests. A refresh is something the user asked for.
 * `listModels`' offline branch attaches a **synthetic** `{ kind: 'network', message: '<provider>: offline' }` to
 * every provider it answers from cache or snapshot (`src/models/list.ts:218–221`), including one whose cache is a
 * minute old — so an unfiltered provenance row would tell a healthy, online machine `<Provider>: offline — showing
 * the last list` seven times (§12.5 S102, §7 row 70). That sentence is about a *failed fetch*; no fetch was
 * attempted here. `withoutOfflineSentinel` drops exactly that error and nothing else, so a real `network` failure
 * on a `refresh` still reads as one.
 *
 * `--json` serialises `CatalogueLoad` / `ListResult` **as they are** — `{ provider, models, source, fetchedAt,
 * stale, error }` per provider (§13.3) — never a second row model. The human form is one `modelSummary` per model
 * through `src/tui/models/lines.ts`'s layout, so the CLI row and the picker row are the same string at the same
 * width (§13.1).
 */
import { EXIT_CODES } from '../errors.js';
import { PROVIDER_IDS, isProviderId, keyEnvNames } from '../provider/ids.js';
import { modelRow, modelsPlainLines, noProviderAtAll, provenanceRow, NO_PROVIDER_CONFIGURED, type ModelsApi } from '../tui/models/lines.js';
import { glyphSet } from '../tui/glyphs.js';
import { MODELS_OPS, type ModelsOp, type ParsedFlags } from './args.js';
export { MODELS_OPS, type ModelsOp };
import type { ProviderId } from '../provider/ids.js';
import type { CatalogueLoad } from '../models/list.js';
import type { ListResult, ModelInfo, ModelsDeps } from '../models/types.js';

/** The `models` command's I/O seam — streams, env, clock and the catalogue loader. Nothing else. */
export interface ModelsIo {
  stdout: { write(s: string): unknown; columns?: number | undefined };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
  now?: () => number;
  ascii?: boolean;
  /**
   * the catalogue, loaded behind one `await import('../models/index.js')`. Injected in tests; the default is the
   * real one over the disk cache under `~/.jevcode/models` and the keys `env` holds.
   */
  load?: (o: { providers?: readonly ProviderId[]; offline: boolean; force: boolean }) => Promise<CatalogueLoad>;
  /** the pure text functions; the default is `src/models/index.js` itself */
  api?: ModelsApi;
  /**
   * Extra catalogue side effects for the real loader — the one seam that lets a test drive `defaultLoad` itself
   * (an in-memory `cache`) instead of replacing it. Absent in production: `catalogueFromEnv` wires the disk cache
   * under `~/.jevcode/models`, the snapshot pricing source and the redactor.
   */
  deps?: ModelsDeps;
}

/** Is this result's error the one `listModels` invents for `offline: true` rather than a fetch that failed? */
function isOfflineSentinel(r: ListResult): boolean {
  return r.error !== undefined && r.error.kind === 'network' && r.error.message === `${r.provider}: offline`;
}

/**
 * Drop the `offline: true` sentinel error — and only it. `listModels` attaches `{ kind: 'network', message:
 * '<provider>: offline' }` to every offline answer, fresh cache included; the caller never asked for a fetch, so
 * the row must not claim one failed. A `network` error with any other message (a real refresh that could not
 * reach the host) is left exactly where it is.
 */
export function withoutOfflineSentinel(results: readonly ListResult[]): ListResult[] {
  return results.map((r) => {
    if (!isOfflineSentinel(r)) return r;
    const { error: _sentinel, ...rest } = r;
    return rest;
  });
}

/** Does `env` hold a key for `id`, under any of its names? The table is `provider/ids.ts`'s, zero-import. */
function hasKey(id: ProviderId, env: NodeJS.ProcessEnv): boolean {
  return keyEnvNames(id).some((name) => (env[name] ?? '').trim() !== '');
}

/**
 * What an **offline** load's provenance should say. Two substitutions, both of them corrections of an ordering
 * inside `listModels` rather than new vocabulary:
 *
 *  - the sentinel is dropped (see `withoutOfflineSentinel`);
 *  - a provider that needs a key and has none is labelled `no_key` instead. `listModels` tests `offline` at
 *    `list.ts:217` **before** the `no key` branch at `:223`, so an offline load reports every provider as a
 *    network failure and never as "you have not configured this one" — which is the one thing it can know for
 *    certain without sending anything, and the reason §7 row 71 and §7 row 74 exist. The error object is
 *    `noKeyError`'s (`list.ts:88`) field for field; `errorLabel` builds the sentence from `kind` and the
 *    provider, never from `message`, so the string a user reads is still the catalogue's (§13.1).
 *
 * **Deleted when the harness reorders those two branches** — the request is in R5-6's report.
 */
export function offlineResults(results: readonly ListResult[], env: NodeJS.ProcessEnv): ListResult[] {
  return results.map((r) => {
    if (!isOfflineSentinel(r)) return r;
    // OpenRouter lists unauthenticated (`list.ts:194`), so a missing key there is not a reason
    if (r.provider !== 'openrouter' && !hasKey(r.provider, env)) return { ...r, error: { kind: 'no_key', status: null, message: `${r.provider}: no API key`, retryable: false } };
    const { error: _sentinel, ...rest } = r;
    return rest;
  });
}

async function modelsApi(): Promise<ModelsApi> {
  const m = await import('../models/index.js');
  return { ...m, rank: m.rankModels };
}

/**
 * The production load: `catalogueFromEnv` binds the **disk cache** under `~/.jevcode/models` plus the snapshot
 * pricing source and the redactor, which is what makes `list` "disk cache → bundled snapshot" (§6.6) rather than
 * "snapshot only" — `loadCatalogue` on its own defaults `deps.cache` to `NULL_CACHE` (`list.ts:59`).
 */
async function defaultLoad(io: ModelsIo, o: { providers?: readonly ProviderId[]; offline: boolean; force: boolean }): Promise<CatalogueLoad> {
  const { catalogueFromEnv } = await import('../models/index.js');
  const { catalogue, keys } = catalogueFromEnv(io.env, io.deps ?? {});
  return catalogue.load({
    ...(o.providers === undefined ? {} : { providers: o.providers }),
    keys,
    offline: o.offline,
    force: o.force,
  });
}

/** `--provider <id>`: one id, or every id. An unknown value is a usage error, never a silent empty list. */
export function providersFor(flags: ParsedFlags): { providers?: readonly ProviderId[]; error?: string } {
  const raw = flags.provider?.trim().toLowerCase();
  if (raw === undefined || raw === '') return {};
  if (!isProviderId(raw)) return { error: `jevcode models --provider: expected one of ${PROVIDER_IDS.join('|')}, got "${flags.provider ?? ''}"` };
  return { providers: [raw] };
}

function columnsOf(io: ModelsIo): number {
  return typeof io.stdout.columns === 'number' && io.stdout.columns > 0 ? io.stdout.columns : 120;
}

/**
 * One human block: the rows, then the provenance row. Failures are **rows, never a blank state** — a provider with
 * no key still shows its cached/snapshot rows and the reason (§7 rows 70–74).
 */
function writeHuman(io: ModelsIo, api: ModelsApi, load: CatalogueLoad, models: readonly ModelInfo[]): void {
  const g = glyphSet({ ascii: io.ascii === true });
  const columns = columnsOf(io);
  const now = io.now?.() ?? Date.now();
  // §7 rows 71 + 74: the sentence sits ABOVE the snapshot rows, never instead of them — nothing is ever hidden
  if (noProviderAtAll(load.results, models)) io.stdout.write(`${NO_PROVIDER_CONFIGURED}\n`);
  for (const m of models) io.stdout.write(`${modelRow(m, columns, api, g)}\n`);
  const prov = provenanceRow(load.results, now, columns, api, g);
  if (prov !== '') io.stdout.write(`${prov}\n`);
}

/** §13.3: the `--json` shape — `CatalogueLoad` as it is, one `ListResult` per provider. */
function writeJson(io: ModelsIo, load: CatalogueLoad, models: readonly ModelInfo[], query?: string): void {
  io.stdout.write(`${JSON.stringify({ ...(query === undefined ? {} : { query }), models, results: load.results }, null, 2)}\n`);
}

/** §6.6: `jevcode models [list|search <query>|refresh]`. Returns the exit code; no engine, no run directory. */
export async function commandModels(flags: ParsedFlags, io: ModelsIo): Promise<number> {
  const op: ModelsOp = flags.modelsOp ?? 'list';
  const { providers, error } = providersFor(flags);
  if (error !== undefined) {
    io.stderr.write(`${error}\n`);
    return EXIT_CODES.config;
  }
  if (op === 'search' && (flags.query ?? '').trim() === '') {
    io.stderr.write('jevcode models search needs a query (jevcode models search <query>)\n');
    return EXIT_CODES.config;
  }
  const api = io.api ?? (await modelsApi());
  const offline = op !== 'refresh';
  const request = { ...(providers === undefined ? {} : { providers }), offline, force: op === 'refresh' };
  const raw = io.load ? await io.load(request) : await defaultLoad(io, request);
  const load: CatalogueLoad = offline ? { ...raw, results: offlineResults(raw.results, io.env) } : raw;
  const models = op === 'search' ? api.rank(flags.query ?? '', load.models).map((h) => h.model) : load.models;
  if (flags.json) {
    writeJson(io, load, models, op === 'search' ? (flags.query ?? '') : undefined);
    return EXIT_CODES.ok;
  }
  if (flags.plain === true || flags.screenReader === true) {
    const g = glyphSet({ ascii: io.ascii === true, screenReader: flags.screenReader === true });
    /**
     * §13.2 clause 7's 40-row cap and its `type a number, "more", or a query, then Enter` sentence belong to the
     * **picker's** one-shot prompt. A CLI verb has no turn in which to answer a number, and §6.6 says `list`
     * prints one row per model — so the twin prints every row, the rule §13.2 clause 6 states for the agents tab.
     */
    const lines = modelsPlainLines({ models, text: api, results: load.results, nowMs: io.now?.() ?? Date.now(), columns: columnsOf(io), glyphs: g, cap: Number.POSITIVE_INFINITY, prompt: false, ...(op === 'search' ? { query: flags.query ?? '' } : {}) });
    for (const l of lines) io.stdout.write(`${l}\n`);
    return EXIT_CODES.ok;
  }
  writeHuman(io, api, load, models);
  return EXIT_CODES.ok;
}
