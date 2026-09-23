/**
 * TUI-DESIGN-5 §10 R5-6 `cli/models.test.ts`: `list`/`search`/`refresh` and their `--json` shapes, engine never
 * started (§6.6, §13.3).
 */
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../../src/cli/args.js';
import { commandModels, providersFor, withoutOfflineSentinel, type ModelsIo } from '../../../src/cli/models.js';
import { modelSummary } from '../../../src/models/format.js';
import { instantCatalogue } from '../../../src/models/list.js';
import { PROVIDER_IDS } from '../../../src/provider/ids.js';
import { EXIT_CODES } from '../../../src/errors.js';
import type { CatalogueLoad } from '../../../src/models/list.js';
import type { CacheEntry, ModelCache, ModelInfo, ProviderId } from '../../../src/models/types.js';
import { API, err, model, result } from '../tui/models/helpers.js';

const NOW = Date.parse('2026-09-22T13:00:00.000Z');

interface Harness {
  io: ModelsIo;
  out: string[];
  errs: string[];
  loads: { providers?: readonly ProviderId[]; offline: boolean; force: boolean }[];
}

function harness(rows: readonly ModelInfo[], results = [result('openrouter', rows)], columns = 120): Harness {
  const out: string[] = [];
  const errs: string[] = [];
  const loads: Harness['loads'] = [];
  const io: ModelsIo = {
    stdout: { write: (s) => out.push(s), columns },
    stderr: { write: (s) => errs.push(s) },
    env: {},
    now: () => NOW,
    api: API,
    load: async (o) => {
      loads.push(o);
      const load: CatalogueLoad = { results, models: rows };
      return load;
    },
  };
  return { io, out, errs, loads };
}

const GLM = model('z-ai/glm-5.3-flash', 'openrouter');
const GLM3 = model('z-ai/glm-5.3', 'openrouter');
const SONNET = model('claude-sonnet-5', 'anthropic');

describe('jevcode models (§6.6)', () => {
  it('list prints one modelSummary row per model, then the provenance row', async () => {
    const h = harness([GLM, SONNET]);
    expect(await commandModels(parseCliArgs(['models']), h.io)).toBe(EXIT_CODES.ok);
    expect(h.out.map((s) => s.trimEnd())).toEqual([modelSummary(GLM), modelSummary(SONNET), 'OpenRouter live']);
    expect(h.errs).toEqual([]);
  });

  it('list and search are SNAPSHOT-FIRST: neither ever asks for the network (§15 Q13)', async () => {
    const h = harness([GLM]);
    await commandModels(parseCliArgs(['models']), h.io);
    await commandModels(parseCliArgs(['models', 'search', 'glm']), h.io);
    expect(h.loads).toEqual([{ offline: true, force: false }, { offline: true, force: false }]);
  });

  it('refresh is the one verb that goes to the network, and it forces past the TTL', async () => {
    const h = harness([GLM]);
    expect(await commandModels(parseCliArgs(['models', 'refresh']), h.io)).toBe(EXIT_CODES.ok);
    expect(h.loads).toEqual([{ offline: false, force: true }]);
  });

  it('search ranks with rankModels and prints the hits in order', async () => {
    const h = harness([SONNET, GLM3, GLM]);
    expect(await commandModels(parseCliArgs(['models', 'search', 'glm-5.3-flash']), h.io)).toBe(EXIT_CODES.ok);
    expect(h.out[0]?.trimEnd()).toBe(modelSummary(GLM));
  });

  it('`models search` with no query is a usage error at parse time, and at the handler too', async () => {
    expect(() => parseCliArgs(['models', 'search'])).toThrow(/needs a query/);
    const h = harness([GLM]);
    expect(await commandModels({ command: 'models', modelsOp: 'search' }, h.io)).toBe(EXIT_CODES.config);
    expect(h.errs.join('')).toContain('jevcode models search needs a query');
  });

  it('--provider narrows the load; an unknown id is a usage error naming the seven', async () => {
    const h = harness([GLM]);
    await commandModels(parseCliArgs(['models', 'list', '--provider', 'gemini']), h.io);
    expect(h.loads[0]?.providers).toEqual(['gemini']);
    expect(providersFor({ command: 'models', provider: 'nope' }).error).toContain('anthropic|openrouter|openai|gemini|xai|fireworks|meta');
    // the flag parser refuses it first, so the handler's own check is belt and braces
    expect(() => parseCliArgs(['models', 'list', '--provider', 'nope'])).toThrow(/expected one of/);
  });

  it('an unknown verb is a usage error', () => {
    expect(() => parseCliArgs(['models', 'wat'])).toThrow(/expected one of list\|search\|refresh/);
    expect(() => parseCliArgs(['models', 'list', 'extra'])).toThrow(/takes no further arguments/);
  });

  it('--json is ListResult/CatalogueLoad as-is: { provider, models, source, fetchedAt, stale, error } per provider', async () => {
    const results = [result('openrouter', [GLM]), result('gemini', [], { source: 'static', stale: true, error: err('no_key') })];
    const h = harness([GLM], results);
    expect(await commandModels(parseCliArgs(['models', 'list', '--json']), h.io)).toBe(EXIT_CODES.ok);
    const parsed: unknown = JSON.parse(h.out.join(''));
    expect(parsed).toEqual({ models: [GLM], results });
    const first = (parsed as { results: unknown[] }).results[0] as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(['fetchedAt', 'models', 'provider', 'source', 'stale']);
    const second = (parsed as { results: unknown[] }).results[1] as Record<string, unknown>;
    expect(Object.keys(second).sort()).toEqual(['error', 'fetchedAt', 'models', 'provider', 'source', 'stale']);
  });

  it('search --json carries the query beside the same two arrays', async () => {
    const h = harness([GLM, GLM3]);
    await commandModels(parseCliArgs(['models', 'search', 'glm-5.3-flash', '--json']), h.io);
    const parsed = JSON.parse(h.out.join('')) as { query: string; models: ModelInfo[] };
    expect(parsed.query).toBe('glm-5.3-flash');
    expect(parsed.models[0]?.id).toBe('z-ai/glm-5.3-flash');
  });

  it('--plain is the numbered twin, with no one-shot prompt to arm in a non-interactive verb', async () => {
    const h = harness([GLM, GLM3]);
    await commandModels(parseCliArgs(['models', 'list', '--plain']), h.io);
    expect(h.out[0]?.trimEnd()).toBe('models (1-2 of 2)');
    // §13.2 clause 7's `type a number, "more", or a query, then Enter` belongs to the PICKER's one-shot prompt;
    // a CLI verb has no turn in which a number could be answered, so it does not print a sentence to nowhere
    expect(h.out[0]).not.toContain('type a number');
    expect(h.out[1]?.trimEnd()).toBe(`1 ${modelSummary(GLM)}`);
  });

  it('--plain prints EVERY row, never a silent 40: the CLI twin is not the picker viewport (§13.2 clause 6)', async () => {
    const many = Array.from({ length: 69 }, (_, i) => model(`vendor/model-${i}`, 'openrouter'));
    const h = harness(many, [result('openrouter', many)]);
    await commandModels(parseCliArgs(['models', 'list', '--plain']), h.io);
    const lines = h.out.map((l) => l.trimEnd());
    expect(lines[0]).toBe('models (1-69 of 69)');
    // 1 head + 69 rows + 1 provenance row; the 40-row cap dropped 29 models with no marker at all
    expect(lines).toHaveLength(71);
    expect(lines[69]).toContain('vendor/model-68');
    expect(lines.filter((l) => /^\s*\d+ /.test(l))).toHaveLength(69);
  });

  it('--screen-reader is the same twin (the numbered form), never a second hand-written block', async () => {
    const h = harness([GLM, GLM3]);
    await commandModels(parseCliArgs(['models', 'list', '--screen-reader']), h.io);
    expect(h.out[0]?.trimEnd()).toBe('models (1-2 of 2)');
    expect(h.out[1]?.trimEnd()).toBe(`1 ${modelSummary(GLM)}`);
  });

  it('a search that matches nothing says so, and arms no `pick 1-0` range (§13.2 clause 7)', async () => {
    const h = harness([GLM]);
    await commandModels(parseCliArgs(['models', 'search', 'zzzzzz', '--plain']), h.io);
    expect(h.out[0]?.trimEnd()).toBe('no model matches zzzzzz — type a query, or Esc closes');
    expect(h.out.join('')).not.toContain('1-0');
  });

  it('--ascii substitutes every glyph', async () => {
    const h = harness([GLM]);
    await commandModels({ ...parseCliArgs(['models', 'list']), ascii: true }, { ...h.io, ascii: true });
    expect(h.out[0]).not.toMatch(/[·→]/);
  });

  it('zero providers configured is S105 — on a fixture the real loader can actually produce (§7 row 74)', async () => {
    /**
     * `loadCatalogue` returns exactly one `ListResult` per requested provider and `listModels` never returns an
     * empty list for a known provider, so `results: []` is unreachable in production. The reachable state is
     * "every provider answered `no_key`", and the snapshot rows come back with it — §7 row 71's "never hidden".
     */
    const noKeys = PROVIDER_IDS.map((id) => result(id, [], { source: 'static', stale: true, error: err('no_key') }));
    const h = harness([GLM], noKeys);
    expect(await commandModels(parseCliArgs(['models']), h.io)).toBe(EXIT_CODES.ok);
    const lines = h.out.map((s) => s.trimEnd());
    expect(lines[0]).toBe('no provider is configured — /login adds a key');
    expect(lines[1]).toBe(modelSummary(GLM));
    expect(lines.at(-1)).toContain('no API key');
    // and the empty-everything case still answers with the one sentence and nothing else
    const bare = harness([], []);
    await commandModels(parseCliArgs(['models']), bare.io);
    expect(bare.out.map((s) => s.trimEnd())).toEqual(['no provider is configured — /login adds a key']);
  });

  it('a provider with no key keeps its rows AND its reason — never a blank state (§7 row 71)', async () => {
    const results = [result('openrouter', [GLM]), result('gemini', [SONNET], { source: 'static', stale: true, error: err('no_key') })];
    const h = harness([GLM], results);
    await commandModels(parseCliArgs(['models']), h.io);
    expect(h.out[h.out.length - 1]?.trimEnd()).toBe('OpenRouter live · Google Gemini: no API key — set GEMINI_API_KEY');
  });

  it('the narrow terminal drops row parts rather than cutting them', async () => {
    const h = harness([GLM], [result('openrouter', [GLM])], 40);
    await commandModels(parseCliArgs(['models']), h.io);
    expect(h.out[0]?.trimEnd()).toBe('z-ai/glm-5.3-flash · $0.15/$0.50');
  });

  it('starts no engine and resolves no run directory: the module imports neither', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/cli/models.ts', 'utf8'));
    for (const forbidden of ['createEngine', 'defaultEngineFactory', 'session.js', 'checkpoint/', 'runsDir']) expect(src).not.toContain(forbidden);
    // and no STATIC import of the catalogue — it is reached by `await import()` only (§6.2, gate G-R5-1)
    // `import type` erases under verbatimModuleSyntax; a VALUE import of the catalogue would not
    expect(src).not.toMatch(/^import (?!type )[^\n]*from '\.\.\/models\//m);
    expect(src).toMatch(/^import type \{ CatalogueLoad \} from '\.\.\/models\/list\.js';$/m);
    expect(src).toMatch(/await import\('\.\.\/models\/index\.js'\)/);
  });
});

describe('the REAL loader behind `list` — no `io.load` stub (§6.6, §7 row 70)', () => {
  /** an in-memory `ModelCache`, injected through `io.deps` so `defaultLoad` itself is what runs */
  function memoryCache(entries: readonly CacheEntry[]): ModelCache {
    const byProvider = new Map(entries.map((e) => [e.provider, e]));
    return {
      path: (provider) => `/dev/null/${provider}.json`,
      read: async (provider) => byProvider.get(provider) ?? null,
      write: async (entry) => void byProvider.set(entry.provider, entry),
    };
  }

  function realIo(deps: ModelsIo['deps'], columns = 120): { io: ModelsIo; out: string[] } {
    const out: string[] = [];
    const io: ModelsIo = {
      stdout: { write: (s) => out.push(s), columns },
      stderr: { write: () => undefined },
      // no keys: the five that need one answer `no_key`, and OpenRouter lists unauthenticated
      env: {},
      now: () => NOW,
      api: API,
      ...(deps === undefined ? {} : { deps }),
      // and no `fetch`: `JEVCODE_ASSERT_NO_NETWORK`'s rule, enforced by the deps below
      };
    return { io, out };
  }

  it('a FRESH cache is never labelled `offline`: the sentinel is dropped, not printed (§12.5 S102)', async () => {
    const cached = [model('z-ai/glm-9', 'openrouter')];
    const entry: CacheEntry = { version: 1, provider: 'openrouter', fetchedAt: new Date(NOW - 60_000).toISOString(), etag: null, models: cached };
    const { io, out } = realIo({ cache: memoryCache([entry]), now: () => NOW, fetch: (() => Promise.reject(new Error('the network must not be touched'))) as typeof fetch });
    expect(await commandModels(parseCliArgs(['models', 'list', '--provider', 'openrouter']), io)).toBe(EXIT_CODES.ok);
    const lines = out.map((l) => l.trimEnd());
    // the cached row is served, and its provenance says `cached …` — NOT `offline — showing the last list`
    expect(lines[0]).toContain('z-ai/glm-9');
    expect(lines.at(-1)).toMatch(/^OpenRouter cached /);
    expect(out.join('')).not.toContain('offline');
  });

  it('no cache at all is the bundled snapshot, and the reason is `no API key`, not `offline` (§7 row 71)', async () => {
    const { io, out } = realIo({ cache: null, now: () => NOW, fetch: (() => Promise.reject(new Error('no network'))) as typeof fetch });
    expect(await commandModels(parseCliArgs(['models', 'list']), io)).toBe(EXIT_CODES.ok);
    const text = out.join('');
    // every snapshot row is printed — nothing is hidden because a provider has no key
    expect(out.length).toBeGreaterThan(instantCatalogue().length - 1);
    expect(text).not.toContain('offline — showing the last list');
    // and the six key-needing providers say the one thing an offline load really does know
    expect(text).toContain('no API key');
    expect(out.at(-1)).toMatch(/no API key|providers no key/);
    expect(out.at(-1)).not.toContain('offline');
  });

  it('a keyed provider under offline says `bundled snapshot`, never `no API key`', async () => {
    const { io, out } = realIo({ cache: null, now: () => NOW });
    io.env = { GEMINI_API_KEY: 'gm-live-0123456789' };
    expect(await commandModels(parseCliArgs(['models', 'list', '--provider', 'gemini']), io)).toBe(EXIT_CODES.ok);
    expect(out.at(-1)?.trimEnd()).toBe('Google Gemini bundled snapshot');
  });

  it('§7 row 74: narrowed to one key-needing provider with no key, S105 sits ABOVE the snapshot rows', async () => {
    const { io, out } = realIo({ cache: null, now: () => NOW });
    expect(await commandModels(parseCliArgs(['models', 'list', '--provider', 'gemini']), io)).toBe(EXIT_CODES.ok);
    expect(out[0]?.trimEnd()).toBe('no provider is configured — /login adds a key');
    expect(out.length).toBeGreaterThan(2);
    expect(out.at(-1)?.trimEnd()).toBe('Google Gemini: no API key — set GEMINI_API_KEY');
  });

  it('withoutOfflineSentinel drops ONLY the synthetic row — a real network failure keeps its sentence', () => {
    const synthetic = result('openrouter', [GLM], { source: 'static', stale: true, error: { kind: 'network', status: null, message: 'openrouter: offline', retryable: true } });
    const real = result('gemini', [GLM], { source: 'cache', stale: true, error: { kind: 'network', status: null, message: 'gemini models: fetch failed (ECONNREFUSED)', retryable: true } });
    const [a, b] = withoutOfflineSentinel([synthetic, real]);
    expect(a?.error).toBeUndefined();
    expect(a?.models).toEqual([GLM]);
    expect(b?.error?.message).toContain('ECONNREFUSED');
    // and a `refresh` never filters at all: `offline` was not asked for, so an offline answer is news
    expect(withoutOfflineSentinel([real])[0]?.error).toBeDefined();
  });
});
