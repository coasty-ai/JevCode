/**
 * TUI-DESIGN-5 §10 R5-6 `models/state.test.ts`: the picker reducer over `instantCatalogue()` — first paint is
 * synchronous and non-empty with zero awaits; rows replace in place as fixtures settle; a stale provider keeps its
 * rows.
 */
import { describe, expect, it } from 'vitest';
import { instantCatalogue } from '../../../../src/models/list.js';
import { rankModels } from '../../../../src/models/search.js';
import { INITIAL_MODELS, MODELS_RANK_LIMIT, catalogueSettled, modelsReducer, providersCovered, replaceProviderRows, selectedModel, visibleModels } from '../../../../src/tui/models/state.js';
import { modelRow } from '../../../../src/tui/models/lines.js';
import { API, err, model, result } from './helpers.js';
import type { ProviderId } from '../../../../src/models/types.js';

/** §10 R5-6 perf row / §7 row 89: `rankModels` + row build p95 < 16 ms at 120 columns over a 500-model pool. */
const PERF_P95_MS = 16;

describe('the model picker reducer (§6.2, §6.4)', () => {
  it('first paint is synchronous and non-empty over instantCatalogue() — zero awaits', () => {
    // no await anywhere in this test body: `instantCatalogue()` is the bundled snapshot and the reducer is pure
    const rows = instantCatalogue();
    // the bundled snapshot is 69 rows on this tree, not the 512 §6.7's frames illustrate — never empty is the contract
    expect(rows.length).toBeGreaterThan(40);
    const s = modelsReducer(INITIAL_MODELS, { type: 'open', models: rows, pending: ['anthropic', 'openrouter'] });
    expect(s.open).toBe(true);
    expect(s.models.length).toBe(rows.length);
    expect(visibleModels(s, API, '').hits.length).toBeGreaterThan(0);
    expect(selectedModel(s, visibleModels(s, API, '').hits)).not.toBeNull();
    // the rule row's provider count is what the load COVERS, so it is right on the frame before any answer
    expect(s.results).toEqual([]);
    expect(providersCovered(s)).toBe(2);
  });

  it('providersCovered counts pending + answered, so the count never dips as providers settle', () => {
    const open = modelsReducer(INITIAL_MODELS, { type: 'open', models: [], pending: ['anthropic', 'openrouter', 'gemini'] });
    expect(providersCovered(open)).toBe(3);
    const one = modelsReducer(open, { type: 'settled', result: result('anthropic', [model('a/one', 'anthropic')]) });
    expect(providersCovered(one)).toBe(3);
    const rest: readonly ProviderId[] = ['openrouter', 'gemini'];
    const all = rest.reduce((acc, id) => modelsReducer(acc, { type: 'settled', result: result(id, []) }), one);
    expect(providersCovered(all)).toBe(3);
    expect(all.pending).toEqual([]);
  });

  it('ranks the empty query over the whole pool and caps it at MODELS_RANK_LIMIT', () => {
    const s = modelsReducer(INITIAL_MODELS, { type: 'open', models: instantCatalogue() });
    expect(visibleModels(s, API, '').hits).toHaveLength(Math.min(MODELS_RANK_LIMIT, s.models.length));
    expect(visibleModels(s, API, '', 3).hits).toHaveLength(3);
  });

  it('the cap is a VIEWPORT, never the reported total: `total` is the pre-limit match count', () => {
    // 512 rows is what §6.7/§11 assume; MODELS_RANK_LIMIT is 200, so the old shape reported `of 200`
    const pool = Array.from({ length: 512 }, (_, i) => model(`vendor/model-${i}`, 'openrouter'));
    const s = modelsReducer(INITIAL_MODELS, { type: 'open', models: pool });
    const v = visibleModels(s, API, '');
    expect(v.hits).toHaveLength(MODELS_RANK_LIMIT);
    expect(v.total).toBe(512);
    // and a query that matches fewer than the cap reports exactly what it matched
    const narrowed = visibleModels(s, API, 'model-7');
    expect(narrowed.total).toBe(narrowed.hits.length);
    expect(narrowed.total).toBeLessThan(MODELS_RANK_LIMIT);
    // an infinite limit is the whole list, not zero rows
    expect(visibleModels(s, API, '', Number.POSITIVE_INFINITY).hits).toHaveLength(512);
  });

  it('`rank` is `rankModels` — the seam is the same function, not a re-implementation', () => {
    const rows = instantCatalogue();
    const s = modelsReducer(INITIAL_MODELS, { type: 'open', models: rows });
    expect(visibleModels(s, API, 'glm', 5).hits.map((h) => h.model.id)).toEqual(rankModels('glm', rows, { limit: 5 }).map((h) => h.model.id));
  });

  it('rows replace IN PLACE as each provider settles — the provider keeps its slot in the pool', () => {
    const pool = [model('a/one', 'anthropic'), model('o/one', 'openrouter'), model('a/two', 'anthropic'), model('x/one', 'xai')];
    const open = modelsReducer(INITIAL_MODELS, { type: 'open', models: pool, pending: ['anthropic', 'openrouter', 'xai'] });
    const s = modelsReducer(open, { type: 'settled', result: result('anthropic', [model('a/live-1', 'anthropic'), model('a/live-2', 'anthropic')]) });
    // the two anthropic rows are gone, the two live ones sit where the first one was, and the others never moved
    expect(s.models.map((m) => m.id)).toEqual(['a/live-1', 'a/live-2', 'o/one', 'x/one']);
    expect(s.pending).toEqual(['openrouter', 'xai']);
    expect(s.results.map((r) => r.provider)).toEqual(['anthropic']);
  });

  it('a provider absent from the pool appends rather than dropping its rows', () => {
    const open = modelsReducer(INITIAL_MODELS, { type: 'open', models: [model('a/one', 'anthropic')] });
    const s = modelsReducer(open, { type: 'settled', result: result('gemini', [model('g/one', 'gemini')]) });
    expect(s.models.map((m) => m.id)).toEqual(['a/one', 'g/one']);
  });

  it('a stale provider keeps its rows: an empty answer records the error and leaves the pool alone (§7 row 73)', () => {
    const pool = [model('a/one', 'anthropic'), model('o/one', 'openrouter')];
    const open = modelsReducer(INITIAL_MODELS, { type: 'open', models: pool, pending: ['anthropic', 'openrouter'] });
    const s = modelsReducer(open, { type: 'settled', result: result('anthropic', [], { source: 'cache', stale: true, error: err('rate_limit', 429) }) });
    expect(s.models.map((m) => m.id)).toEqual(['a/one', 'o/one']);
    expect(s.results[0]?.error?.kind).toBe('rate_limit');
    expect(s.pending).toEqual(['openrouter']);
  });

  it('a second answer for one provider replaces its result row, never appending a duplicate', () => {
    const open = modelsReducer(INITIAL_MODELS, { type: 'open', models: [model('a/one', 'anthropic')] });
    const once = modelsReducer(open, { type: 'settled', result: result('anthropic', [model('a/one', 'anthropic')], { source: 'cache', stale: true }) });
    const twice = modelsReducer(once, { type: 'settled', result: result('anthropic', [model('a/one', 'anthropic')]) });
    expect(twice.results).toHaveLength(1);
    expect(twice.results[0]?.source).toBe('network');
  });

  it('replaceProviderRows is a no-op for an empty replacement and for an unknown provider with rows', () => {
    const pool = [model('a/one', 'anthropic')];
    expect(replaceProviderRows(pool, 'anthropic', [])).toBe(pool);
    expect(replaceProviderRows(pool, 'meta', [model('m/one', 'meta')]).map((m) => m.id)).toEqual(['a/one', 'm/one']);
  });

  it('move / page / clamp keep the cursor inside the row list, never negative and never past the end', () => {
    const s0 = modelsReducer(INITIAL_MODELS, { type: 'open', models: [model('a', 'anthropic'), model('b', 'anthropic'), model('c', 'anthropic')] });
    expect(modelsReducer(s0, { type: 'move', by: -1, count: 3 }).selected).toBe(0);
    const s1 = modelsReducer(s0, { type: 'move', by: 2, count: 3 });
    expect(s1.selected).toBe(2);
    expect(modelsReducer(s1, { type: 'move', by: 5, count: 3 }).selected).toBe(2);
    expect(modelsReducer(s1, { type: 'page', by: -1, size: 10, count: 3 }).selected).toBe(0);
    expect(modelsReducer(s1, { type: 'page', by: 1, size: 10, count: 3 }).selected).toBe(2);
    // the query shrank the list under the cursor
    expect(modelsReducer(s1, { type: 'clamp', count: 1 }).selected).toBe(0);
    // an unchanged clamp returns the same object (no re-render)
    expect(modelsReducer(s1, { type: 'clamp', count: 3 })).toBe(s1);
    // an empty list parks at 0
    expect(modelsReducer(s1, { type: 'clamp', count: 0 }).selected).toBe(0);
  });

  it('close returns the initial state', () => {
    const s = modelsReducer(INITIAL_MODELS, { type: 'open', models: instantCatalogue() });
    expect(modelsReducer(s, { type: 'close' })).toEqual(INITIAL_MODELS);
  });

  it('catalogueSettled: only a live-or-cached answer from every configured provider, with none in flight (§6.4)', () => {
    const live = result('anthropic', [], { source: 'network' });
    const cached = result('openrouter', [], { source: 'cache', stale: true });
    const snap = result('gemini', [], { source: 'static', stale: true, error: err('no_key') });
    expect(catalogueSettled([], [])).toBe(false);
    expect(catalogueSettled([live, cached], [])).toBe(true);
    expect(catalogueSettled([live, cached], ['gemini'])).toBe(false);
    expect(catalogueSettled([live, snap], [])).toBe(false);
  });

  it('200 keystrokes over a 500-model catalogue rank AND build their rows inside the 16 ms budget (G-R5-5 shape)', () => {
    const pool = Array.from({ length: 500 }, (_, i) => model(`vendor/model-${i}-glm`, i % 2 === 0 ? 'openrouter' : 'anthropic'));
    const s = modelsReducer(INITIAL_MODELS, { type: 'open', models: pool });
    const query = 'z-ai/glm-5.3-flash';
    /** one round = §10's 200 keystrokes; returns this round's p50 and p95 in ms */
    const round = (): { p50: number; p95: number; max: number } => {
      const samples: number[] = [];
      for (let i = 0; i < 200; i++) {
        const q = query.slice(0, (i % query.length) + 1);
        const t0 = performance.now();
        // exactly what one keystroke costs the picker: rank the pool, then build the visible window's rows at 120
        for (const hit of visibleModels(s, API, q, 40).hits) modelRow(hit.model, 120, API);
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      return { p50: samples[100] ?? 0, p95: samples[189] ?? 0, max: samples[199] ?? 0 };
    };
    const rounds = [round(), round(), round()];
    const p95 = Math.min(...rounds.map((r) => r.p95));
    const p50 = Math.min(...rounds.map((r) => r.p50));
    if (process.env['R5_PERF_REPORT'] === '1') process.stderr.write(`model-picker ${rounds.map((r) => `p50=${r.p50.toFixed(3)} p95=${r.p95.toFixed(3)} max=${r.max.toFixed(3)}`).join(' | ')}\n`);
    /**
     * §10's number is the **p95**, and this asserts it — against `PERF_P95_MS`, the §10 figure itself, never a
     * padded one. The gate proper is the pty `composer-latency` `model-picker` series under a real terminal
     * (§11 G-R5-5; the request to R5-2/W5 is in R5-6's report), because only that measures a keystroke end to
     * end. What this probe adds is an **algorithmic** guard — an accidental O(n²) over the pool — in every
     * `vitest run`.
     *
     * **Three rounds, and the MINIMUM p95 of the three is the estimate.** Measured 2026-09-22 on a build machine
     * shared with a peer session's bounded test runs: the per-round p50 is 1.5–1.8 ms and stable, while a single
     * round's p95 swings 4–18 ms and its max 140–250 ms, entirely from scheduling and GC — a single-round p95
     * assertion measures the machine. An algorithmic regression raises every round, so the minimum still catches
     * it; noise raises some. Raising the round count is the fix if this ever flakes, never raising the budget.
     */
    expect(p50).toBeLessThan(PERF_P95_MS / 4);
    expect(p95).toBeLessThan(PERF_P95_MS);
  });
});
