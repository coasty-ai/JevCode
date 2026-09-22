/**
 * TUI-DESIGN-5 §10 R5-6 `models/lines.test.ts`: the row's composed drop order at 40/80/120 (capabilities → output
 * → context → provider), asserting no row is ever cut mid-grapheme; every `ModelsError.kind` produces its
 * `errorLabel` row; the numbered `--plain` twin and its one-shot prompt; the SR line coalesced ≤ 1 per 400 ms.
 */
import { describe, expect, it } from 'vitest';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';
import { catalogueSummary, errorLabel, modelSummary, sourceLabel } from '../../../../src/models/format.js';
import {
  BROWSE_ONLY,
  MODELS_PLAIN_CAP,
  NO_PROVIDER_CONFIGURED,
  SR_COALESCE_MS,
  browseOnlyText,
  compactPrice,
  keyRateLimitedText,
  keyRejectedText,
  keyVerifiedText,
  modelCheck,
  modelPendingText,
  modelRow,
  modelRowRungs,
  modelsPickPrompt,
  modelsPlainLines,
  modelsRule,
  modelsShown,
  modelsSrLine,
  noModelMatchText,
  noModelNamedText,
  noProviderConfigured,
  provenanceCells,
  provenanceRow,
  srDue,
} from '../../../../src/tui/models/lines.js';
import type { ModelsError } from '../../../../src/models/types.js';
import { API, err, model, result } from './helpers.js';

const GLM = model('z-ai/glm-5.3-flash', 'openrouter');
const NOW = Date.parse('2026-09-22T13:00:00.000Z');

describe('the model row: composed, never truncated (§6.4, §6.8)', () => {
  it('rung 1 is `modelSummary` verbatim — the picker never re-declares the catalogue text (§13.1)', () => {
    expect(modelRowRungs(GLM, API)[0]).toBe(modelSummary(GLM));
    expect(modelRowRungs(GLM, API)[0]).toBe('z-ai/glm-5.3-flash · OpenRouter · 1.3M ctx → 944k out · $0.15/M in · $0.50/M out · tools · json · reasoning');
  });

  it('the drop order is capabilities → output window → context window → provider name', () => {
    const [r1, r2, r3, r4, r5] = modelRowRungs(GLM, API);
    expect(r1).toContain('tools · json · reasoning');
    expect(r2).toBe('z-ai/glm-5.3-flash · OpenRouter · 1.3M ctx → 944k out · $0.15/M in · $0.50/M out');
    expect(r3).toBe('z-ai/glm-5.3-flash · OpenRouter · 1.3M ctx · $0.15/M in · $0.50/M out');
    expect(r4).toBe('z-ai/glm-5.3-flash · OpenRouter · $0.15/M in · $0.50/M out');
    expect(r5).toBe('z-ai/glm-5.3-flash · $0.15/$0.50');
  });

  it('120 keeps the whole summary, 80 adds provider + context window, 40 leaves `id · $in/$out` (§6.8)', () => {
    expect(modelRow(GLM, 120, API)).toBe(modelSummary(GLM));
    const at80 = modelRow(GLM, 80, API);
    expect(at80).toContain('OpenRouter');
    expect(at80).toContain('ctx');
    expect(at80).not.toContain('reasoning');
    expect(modelRow(GLM, 40, API)).toBe('z-ai/glm-5.3-flash · $0.15/$0.50');
  });

  it('no row exceeds its width and none is ever cut mid-grapheme, at every column 1…200 (G-R5-6)', () => {
    const wide = model('家族/模型-5.3-flash🚀', 'anthropic', { displayName: '家族' });
    for (const m of [GLM, wide, model('m', 'meta', { pricing: undefined as never, contextLength: undefined as never, maxOutput: undefined as never, supports: {} })]) {
      for (let c = 1; c <= 200; c++) {
        const row = modelRow(m, c, API);
        expect(cellWidth(row)).toBeLessThanOrEqual(c);
        // grapheme-safe: every code point of the row appears in one of its rungs (nothing half-cut was invented)
        expect(row).not.toMatch(/�/);
        const body = row.endsWith('…') ? row.slice(0, -1) : row;
        if (body !== '') expect(modelRowRungs(m, API).some((r) => r.startsWith(body))).toBe(true);
      }
    }
  });

  it('`deprecated` rides every rung — a dead model at 40 columns needs the warning more, not less', () => {
    const dead = model('old/model', 'openrouter', { deprecated: true });
    for (const r of modelRowRungs(dead, API)) expect(r).toContain('deprecated');
    expect(modelRow(dead, 40, API)).toContain('deprecated');
  });

  it('an unpriced model keeps the catalogue word rather than inventing one', () => {
    const free = model('x/unpriced', 'xai', { pricing: undefined as never });
    expect(compactPrice(API, undefined)).toBe('unpriced');
    expect(modelRow(free, 40, API)).toContain('unpriced');
  });

  it('--ascii substitutes every glyph through the one twin map (§12.5 S100)', () => {
    const row = modelRow(GLM, 120, API, GLYPHS.ascii);
    expect(row).toBe('z-ai/glm-5.3-flash - OpenRouter - 1.3M ctx -> 944k out - $0.15/M in - $0.50/M out - tools - json - reasoning');
    expect(row).not.toMatch(/[·→]/);
  });

  it('--ascii has the SAME five distinct rungs as unicode — the ladder is not glyph-dependent', () => {
    const ascii = modelRowRungs(GLM, API, GLYPHS.ascii);
    const unicode = modelRowRungs(GLM, API, GLYPHS.unicode);
    expect(new Set(ascii).size).toBe(5);
    expect(new Set(unicode).size).toBe(5);
    /**
     * Rung 3 is rung 2 minus the output window, in BOTH glyph sets. `contextSummary` always writes the unicode
     * arrow (`src/models/format.ts:32`) whatever set the row will be drawn in — `modelRow` substitutes afterwards
     * — so splitting on `g.arrow` made rungs 2 and 3 byte-identical under ASCII and dropped `ctx` a rung early.
     * (`modelRowRungs` is pre-substitution, so the parts the catalogue wrote keep their own glyphs here.)
     */
    expect(ascii[1]).not.toBe(ascii[2]);
    expect(ascii[2]).toContain('1.3M ctx');
    expect(ascii[2]).not.toContain('944k out');
    expect(ascii.map((r) => cellWidth(r))).toEqual(unicode.map((r) => cellWidth(r)));
  });

  it('--ascii at 70 columns still shows the context window — rung 3, not rung 4 (§6.4 drop order)', () => {
    expect(modelRow(GLM, 70, API, GLYPHS.ascii)).toBe('z-ai/glm-5.3-flash - OpenRouter - 1.3M ctx - $0.15/M in - $0.50/M out');
    expect(modelRow(GLM, 70, API, GLYPHS.ascii)).toContain('ctx');
    expect(modelRow(GLM, 70, API, GLYPHS.unicode)).toContain('ctx');
  });

  it('§7 row 77: a model whose provider has no generator adapter is MARKED on every rung', () => {
    const gem = model('gemini-3-pro', 'gemini');
    for (const r of modelRowRungs(gem, API)) expect(r).toContain(BROWSE_ONLY);
    expect(modelRow(gem, 120, API)).toContain('browse only');
    expect(modelRow(gem, 40, API)).toContain('browse only');
    // and the marker is the head of S107's sentence, so one grep finds both (§13.4)
    expect(browseOnlyText('gemini-3-pro')).toContain(BROWSE_ONLY);
    // a provider that CAN generate is unmarked — rung 1 stays `modelSummary` verbatim
    expect(modelRowRungs(GLM, API)[0]).toBe(modelSummary(GLM));
    expect(modelRow(GLM, 120, API)).not.toContain(BROWSE_ONLY);
  });

  it('§7 row 65: a row never renders ModelsError.message, only errorLabel', () => {
    const leaked = { kind: 'auth', status: 401, message: 'Authorization: Bearer sk-secret-0123456789', retryable: false } as const;
    const row = provenanceRow([result('openai', [GLM], { error: leaked })], NOW, 120, API);
    expect(row).toBe(errorLabel('openai', leaked));
    expect(row).not.toContain('sk-secret-0123456789');
    expect(provenanceCells([result('openai', [GLM], { error: leaked })], NOW, API)[0]).not.toContain('Bearer');
  });
});

describe('the rule row (§12.5 S99, F-58, F-59)', () => {
  it('120 columns: the full form, padded to the width', () => {
    const r = modelsRule({ total: 512, providers: 7, columns: 120 });
    expect(r.startsWith('─── models · 512 of 7 providers · by relevance ─ ↑↓ Enter Tab Esc ')).toBe(true);
    expect(cellWidth(r)).toBe(120);
  });
  it('40 columns: the narrow form', () => {
    const r = modelsRule({ total: 512, providers: 7, columns: 40 });
    expect(r.startsWith('─── models · 512 ─ ↑↓ Enter Esc ')).toBe(true);
    expect(cellWidth(r)).toBe(40);
  });
  it('one provider is singular; --ascii swaps the fill and the arrows', () => {
    expect(modelsRule({ total: 3, providers: 1, columns: 120 })).toContain('of 1 provider ');
    expect(modelsRule({ total: 3, providers: 7, columns: 120, glyphs: GLYPHS.ascii }).startsWith('--- models - 3 of 7 providers - by relevance - ^v Enter Tab Esc ')).toBe(true);
  });
  it('the count is the CATALOGUE total, not the filtered row count (F-58 types `glm` and still reads 512)', () => {
    // F-58: `models · 512 of 7 providers` with `glm` in the composer and three rows drawn — the header counts
    // what the picker holds. `providers` is what the load COVERS, so it is never 0 on the first paint (§6.2).
    expect(modelsRule({ total: 512, providers: 7, columns: 120 })).toContain('models · 512 of 7 providers');
    expect(modelsRule({ total: 69, providers: 7, columns: 120 })).not.toContain('of 0 providers');
  });

  it('never exceeds the width at any column 1…200', () => {
    for (let c = 1; c <= 200; c++) expect(cellWidth(modelsRule({ total: 512, providers: 7, columns: c }))).toBeLessThanOrEqual(c);
  });
});

describe('provenance and failures are rows, never a blank state (§7 rows 70–74)', () => {
  const rows = [model('a/one', 'anthropic')];
  const results = [result('openrouter', rows), result('anthropic', rows, { source: 'cache', fetchedAt: '2026-09-22T10:00:00.000Z', stale: true }), result('gemini', [], { source: 'static', stale: true, error: err('no_key') })];

  it('every cell comes from sourceLabel / errorLabel, never from a second hand-written string (§13.1)', () => {
    expect(provenanceCells(results, NOW, API)).toEqual(['OpenRouter live', `Anthropic ${sourceLabel(results[1]!, NOW)}`, errorLabel('gemini', err('no_key'))]);
    expect(provenanceCells(results, NOW, API)[1]).toBe('Anthropic cached 3 h ago');
    expect(provenanceCells(results, NOW, API)[2]).toBe('Google Gemini: no API key — set GEMINI_API_KEY');
  });

  it('120 names every provider; 40 is the healthy head plus the count (F-59)', () => {
    expect(provenanceRow(results, NOW, 120, API)).toBe('OpenRouter live · Anthropic cached 3 h ago · Google Gemini: no API key — set GEMINI_API_KEY');
    expect(provenanceRow(results, NOW, 40, API)).toBe('OpenRouter live · 1 provider no key');
  });

  it('a mixed degradation says `unavailable`, the word catalogueSummary uses', () => {
    const mixed = [result('openrouter', rows), result('anthropic', [], { error: err('auth', 401) }), result('gemini', [], { error: err('no_key') })];
    expect(provenanceRow(mixed, NOW, 41, API)).toBe('OpenRouter live · 2 providers unavailable');
    // 40 no longer fits that rung, so the last one — S103's `catalogueSummary` — answers instead
    expect(provenanceRow(mixed, NOW, 40, API)).toBe(catalogueSummary(mixed));
    expect(cellWidth(provenanceRow(mixed, NOW, 12, API))).toBeLessThanOrEqual(12);
  });

  it('every ModelsError.kind produces its errorLabel row — six kinds, six rows', () => {
    const kinds: readonly ModelsError['kind'][] = ['no_key', 'auth', 'rate_limit', 'http', 'network', 'invalid'];
    for (const kind of kinds) {
      const r = [result('gemini', rows, { source: 'cache', stale: true, error: err(kind, kind === 'auth' ? 401 : kind === 'rate_limit' ? 429 : kind === 'http' ? 503 : null) })];
      expect(provenanceRow(r, NOW, 120, API)).toBe(errorLabel('gemini', err(kind, kind === 'auth' ? 401 : kind === 'rate_limit' ? 429 : kind === 'http' ? 503 : null)));
    }
    expect(errorLabel('anthropic', err('auth', 401))).toBe('Anthropic: key rejected (401)');
    expect(errorLabel('anthropic', err('rate_limit', 429))).toBe('Anthropic: rate limited — showing the last list');
    expect(errorLabel('anthropic', err('network'))).toBe('Anthropic: offline — showing the last list');
  });

  it('no results at all is an empty row, not the word "none"', () => {
    expect(provenanceRow([], NOW, 120, API)).toBe('');
  });

  it('never exceeds its width at any column 1…200 (G-R5-6)', () => {
    for (let c = 1; c <= 200; c++) expect(cellWidth(provenanceRow(results, NOW, c, API))).toBeLessThanOrEqual(c);
  });
});

describe('the --plain numbered twin (§13.2 clause 7)', () => {
  const pool = Array.from({ length: 512 }, (_, i) => model(`vendor/model-${i}`, 'openrouter'));

  it('prints the count, the "more" token and at most 40 rows', () => {
    const lines = modelsPlainLines({ models: pool, text: API });
    expect(lines[0]).toBe('models (1-40 of 512) — type a number, "more", or a query, then Enter');
    expect(lines).toHaveLength(1 + MODELS_PLAIN_CAP);
    expect(modelsShown(512)).toBe(40);
    expect(modelsShown(7)).toBe(7);
    expect(lines[1]).toBe(' 1 vendor/model-0 · OpenRouter · 1.3M ctx → 944k out · $0.15/M in · $0.50/M out · tools · json · reasoning');
  });

  it('the one-shot prompt names the range it armed, and arms no range when there is nothing to pick', () => {
    expect(modelsPickPrompt(40)).toBe('pick 1-40, or type a query > ');
    expect(modelsPickPrompt(modelsShown(7))).toBe('pick 1-7, or type a query > ');
    // `pick 1-0, or type a query > ` offers a range with no members — the ordinary bad-filter case
    expect(modelsPickPrompt(0)).toBe('type a query > ');
  });

  it('the cap is the PICKER’s viewport: an explicit cap prints every row, and `total` is the pre-cap count', () => {
    expect(modelsShown(512)).toBe(MODELS_PLAIN_CAP);
    expect(modelsShown(512, Number.POSITIVE_INFINITY)).toBe(512);
    const all = modelsPlainLines({ models: pool, text: API, cap: Number.POSITIVE_INFINITY, prompt: false });
    // §13.2 clause 6's rule, applied to the CLI twin: the row count equals `rows.length`, never a silent 40
    expect(all).toHaveLength(1 + 512);
    expect(all[0]).toBe('models (1-512 of 512)');
    expect(all[0]).not.toContain('type a number');
    expect(all[512]).toContain('vendor/model-511');
    // and the picker's own twin still reports the CATALOGUE total, not the viewport it printed
    expect(modelsPlainLines({ models: pool.slice(0, 40), text: API, total: 512 })[0]).toBe('models (1-40 of 512) — type a number, "more", or a query, then Enter');
  });

  it('zero hits is a sentence, not `models (1-0 of 0)` with a `pick 1-0` prompt', () => {
    const results = [result('openrouter', [])];
    expect(modelsPlainLines({ models: [], text: API, results, nowMs: NOW, query: 'zzz' })).toEqual([noModelMatchText('zzz'), 'OpenRouter live']);
    expect(noModelMatchText('zzz')).toBe('no model matches zzz — type a query, or Esc closes');
    expect(noModelMatchText('')).toBe('no models to show — type a query, or Esc closes');
    // and the twin never prints a numbered head it cannot number
    for (const l of modelsPlainLines({ models: [], text: API, results, query: 'zzz' })) expect(l).not.toContain('1-0');
    expect(modelsPlainLines({ models: [], text: API, results, query: 'zzz', glyphs: GLYPHS.ascii })[0]).toBe('no model matches zzz - type a query, or Esc closes');
  });

  it('a short list numbers exactly what it has, and the provenance row follows the rows', () => {
    const lines = modelsPlainLines({ models: pool.slice(0, 2), text: API, results: [result('openrouter', pool.slice(0, 2))], nowMs: NOW });
    expect(lines[0]).toBe('models (1-2 of 2) — type a number, "more", or a query, then Enter');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('OpenRouter live');
  });

  it('zero providers configured is S105 — on the condition the real loader can reach (§7 row 74)', () => {
    expect(modelsPlainLines({ models: [], text: API })).toEqual([NO_PROVIDER_CONFIGURED]);
    expect(NO_PROVIDER_CONFIGURED).toBe('no provider is configured — /login adds a key');
    /**
     * `loadCatalogue` returns exactly one `ListResult` per requested provider and never an empty list, so
     * `results: []` is a state it cannot produce. The reachable condition is "every provider answered `no_key`".
     */
    const noKeys = ['anthropic', 'gemini', 'openai'].map((id) => result(id as 'gemini', [], { source: 'static', stale: true, error: err('no_key') }));
    expect(noProviderConfigured(noKeys)).toBe(true);
    expect(noProviderConfigured([...noKeys, result('openrouter', [GLM])])).toBe(false);
    // and the sentence is printed ABOVE the snapshot rows, never instead of them (§7 row 71: never hidden)
    const lines = modelsPlainLines({ models: [GLM], text: API, results: noKeys, nowMs: NOW });
    expect(lines[0]).toBe(NO_PROVIDER_CONFIGURED);
    expect(lines[1]).toBe('models (1-1 of 1) — type a number, "more", or a query, then Enter');
    expect(lines[2]).toContain('z-ai/glm-5.3-flash');
    expect(lines.at(-1)).toContain('no API key');
  });

  it('under a pipe the twin renders the 120-column form (§13.2 clause 1)', () => {
    expect(modelsPlainLines({ models: [GLM], text: API })[1]).toBe(` 1 ${modelSummary(GLM)}`.replace(' 1 ', '1 '));
  });

  it('--ascii: the dash and every glyph substitute', () => {
    const lines = modelsPlainLines({ models: [GLM], text: API, glyphs: GLYPHS.ascii });
    expect(lines[0]).toBe('models (1-1 of 1) - type a number, "more", or a query, then Enter');
    expect(lines[1]).not.toMatch(/[·→]/);
  });
});

describe('the screen-reader line (§12.5 S99 SR, §7 row 82)', () => {
  it('is one sentence naming the position, the id, the provider, the price and the keys', () => {
    expect(modelsSrLine({ index: 2, count: 40, model: GLM, text: API })).toBe('models: 3 of 40 · z-ai/glm-5.3-flash · OpenRouter · $0.15/M in · Enter picks, Tab narrows, Esc closes');
  });
  it('--ascii wins over screen-reader: the separator substitutes too (§7 row 81, §14.2 #53)', () => {
    const line = modelsSrLine({ index: 2, count: 40, model: GLM, text: API, glyphs: GLYPHS.ascii });
    expect(line).toBe('models: 3 of 40 - z-ai/glm-5.3-flash - OpenRouter - $0.15/M in - Enter picks, Tab narrows, Esc closes');
    expect(line).not.toMatch(/[·→]/);
    expect(modelsSrLine({ index: 0, count: 0, model: null, text: API, glyphs: GLYPHS.ascii })).not.toMatch(/·/);
  });
  it('§7 row 77: the spoken row says a browse-only model is browse-only', () => {
    expect(modelsSrLine({ index: 0, count: 1, model: model('gemini-3-pro', 'gemini'), text: API })).toContain(BROWSE_ONLY);
  });
  it('an empty list still speaks the keys, never a glyph-only row', () => {
    expect(modelsSrLine({ index: 0, count: 0, model: null, text: API })).toBe('models: 0 of 0 · Enter picks, Tab narrows, Esc closes');
  });
  it('is coalesced to at most one per 400 ms', () => {
    expect(SR_COALESCE_MS).toBe(400);
    expect(srDue(null, 1_000)).toBe(true);
    expect(srDue(1_000, 1_399)).toBe(false);
    expect(srDue(1_000, 1_400)).toBe(true);
  });
});

describe('the §12.5 strings that are not catalogue text', () => {
  it('S104 is the refusal, with and without near misses', () => {
    expect(noModelNamedText('glm-6', ['z-ai/glm-5.3-flash', 'z-ai/glm-5.3', 'z-ai/glm-5.2-air'])).toBe('no model named glm-6 — did you mean z-ai/glm-5.3-flash, z-ai/glm-5.3 or z-ai/glm-5.2-air? (/model to browse)');
    expect(noModelNamedText('glm-6', ['z-ai/glm-5.3'])).toBe('no model named glm-6 — did you mean z-ai/glm-5.3? (/model to browse)');
    expect(noModelNamedText('zzz', [])).toBe('no model named zzz (/model to browse)');
  });
  it('S104a is the warning, and it names the snapshot', () => {
    expect(modelPendingText('glm-6')).toBe('model glm-6 pending (next run) — not in the catalogue yet (bundled snapshot); /model browses once it loads');
  });
  it('S106 is the three key-setup outcomes', () => {
    expect(keyVerifiedText('OpenAI', 84)).toBe('OpenAI key verified — 84 models');
    expect(keyVerifiedText('Meta', 1)).toBe('Meta key verified — 1 model');
    expect(keyRejectedText('OpenAI', 401)).toBe('OpenAI key rejected (401)');
    expect(keyRateLimitedText('xAI')).toBe('xAI: rate limited — try again');
  });
  it('S107 is one constant (§7 row 77)', () => {
    expect(browseOnlyText('openai/gpt-6')).toBe('openai/gpt-6 — browse only, generation not yet available');
    expect(BROWSE_ONLY).toBe('browse only');
  });
});

describe('/model <id> is a check, not a gate (§6.4, §7 row 100)', () => {
  const pool = [GLM, model('z-ai/glm-5.3', 'openrouter'), model('z-ai/glm-5.2-air', 'openrouter')];

  it('a hit resolves the row', () => {
    const c = modelCheck('z-ai/glm-5.3-flash', pool, true, API);
    expect(c.kind).toBe('ok');
    expect(c.kind === 'ok' && c.model.id).toBe('z-ai/glm-5.3-flash');
  });
  it('a miss while the catalogue has NOT settled is a warning and the value is set', () => {
    expect(modelCheck('z-ai/glm-6', pool, false, API)).toEqual({ kind: 'warn', text: modelPendingText('z-ai/glm-6') });
  });
  it('a miss with nothing close still refuses, dropping the empty question half', () => {
    expect(modelCheck('qqqqqqzz', pool, true, API)).toEqual({ kind: 'refuse', text: 'no model named qqqqqqzz (/model to browse)' });
  });
  it('a miss once every provider answered live/cached is the refusal with up to three near misses', () => {
    const c = modelCheck('glm-5.3-flash', pool, true, API);
    expect(c.kind).toBe('refuse');
    expect(c.kind === 'refuse' && c.text.startsWith('no model named glm-5.3-flash — did you mean z-ai/glm-5.3-flash')).toBe(true);
    expect(c.kind === 'refuse' && c.text.endsWith('? (/model to browse)')).toBe(true);
  });
  it('an alias resolves to its canonical row (never reported unknown)', () => {
    const aliased = [model('grok-4.20-0309-reasoning', 'openrouter', { aliases: ['grok-4.20'] })];
    expect(modelCheck('grok-4.20', aliased, true, API).kind).toBe('ok');
  });

  it('§7 row 77: a hit whose provider has no generator adapter is REFUSED as a pending value, with the reason', () => {
    const gem = model('gemini-3-pro', 'gemini');
    // it resolves — the id is real and the picker shows it — but it may not become `pending.model`
    expect(API.findModel('gemini-3-pro', [gem])).not.toBeNull();
    expect(modelCheck('gemini-3-pro', [gem], true, API)).toEqual({ kind: 'refuse', text: browseOnlyText('gemini-3-pro') });
    // still refused before the catalogue settles: the reason is the adapter, not the load
    expect(modelCheck('gemini-3-pro', [gem], false, API).kind).toBe('refuse');
    // and the two providers that CAN generate are untouched
    expect(modelCheck('z-ai/glm-5.3-flash', [GLM], true, API).kind).toBe('ok');
  });
});
