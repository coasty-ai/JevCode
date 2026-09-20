/**
 * The jev-only bench condition (docs/JEV-ONLY.md, DESIGN.md §13): NullProvider in the
 * generator slot, the synthesizer from BenchDeps, zero generator usage asserted per record,
 * and a third column wherever conditions are listed.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JEV_ONLY_GENERATOR_CALLED, buildRecord, readTasksJsonl, runBenchWithSources, validateOptions } from '../../../src/bench/runner.js';
import { CONDITION_ORDER, NULL_GENERATOR_MODEL, conditionConfig, createEngineFor, isEngineMode, parseConditions, requiresGenerator } from '../../../src/bench/conditions.js';
import type { BenchRecord } from '../../../src/bench/types.js';
import type { EngineOptions } from '../../../src/core/types.js';
import { baseOptions, createFakeDeps, fakeRunResult, syntheticSource, tempDir, type EngineScript } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const threeWay: EngineScript = (_task, mode) => ({
  result: {
    steps: mode === 'jev-on' ? 3 : mode === 'jev-off' ? 5 : 4,
    tokensPerStep: mode === 'jev-on' ? [100, 100, 100] : mode === 'jev-off' ? [50, 50, 50, 50, 50] : [80, 80, 80, 80],
    generatorTokensPerStep: mode === 'jev-on' ? [30, 30, 30] : mode === 'jev-off' ? [50, 50, 50, 50, 50] : [0, 0, 0, 0],
    jevTokensPerStep: mode === 'jev-on' ? [70, 70, 70] : mode === 'jev-off' ? [0, 0, 0, 0, 0] : [80, 80, 80, 80],
    jevLatencyMs: mode === 'jev-off' ? [] : [150, 170, 190],
    counters: { blocked: 0, reviews: 0, declined: 0, failed: 0, loops: 0, replans: 0, reads: mode === 'jev-off' ? 2 : 0 },
  },
  decisions: mode === 'jev-off' ? 0 : 12,
  spendUsd: 0.5,
});

describe('conditions helpers', () => {
  it('order, parsing, generator requirement and per-condition config know jev-only', () => {
    expect(CONDITION_ORDER).toEqual(['jev-on', 'jev-off', 'jev-only']);
    expect(isEngineMode('jev-only')).toBe(true);
    expect(isEngineMode('jev-maybe')).toBe(false);
    expect(parseConditions('jev-only, jev-on')).toEqual(['jev-only', 'jev-on']);
    expect(requiresGenerator(['jev-only'])).toBe(false);
    expect(requiresGenerator(['jev-only', 'jev-off'])).toBe(true);
    const opts = baseOptions('/r', '/o');
    expect(conditionConfig('jev-only', opts, 'mock')).toMatchObject({ mode: 'jev-only', generatorModel: NULL_GENERATOR_MODEL, deciderModel: 'typesafe/jev-1.13-20260917' });
    expect(conditionConfig('jev-on', opts, 'mock')).toMatchObject({ generatorModel: 'mock', deciderModel: 'typesafe/jev-1.13-20260917' });
    expect(conditionConfig('jev-off', opts, 'mock').deciderModel).toBeNull();
  });

  it('createEngineFor routes jev-only to the full engine factory', async () => {
    const { deps, captured } = createFakeDeps({ script: threeWay });
    const opts = { mode: 'jev-only', task: 't', limits: baseOptions('/r', '/o').limits, meter: deps.createSpendMeter(1), generation: { temperature: null, maxTokens: 1 }, runsDir: (await tempDir()).dir } as unknown as EngineOptions;
    await createEngineFor('jev-only', opts, deps);
    expect(captured.engines.map((e) => e.mode)).toEqual(['jev-only']);
  });
});

describe('buildRecord in jev-only', () => {
  it('copies generatorCalls and invalidates a jev-only record with any generator usage', () => {
    const clean = buildRecord({ source: syntheticSource({ id: 'a' }), condition: 'jev-only', result: fakeRunResult({ runId: 'r', mode: 'jev-only' }), evaluation: { pass: true, evaluator: 'mock' }, patch: null, capFired: null });
    expect(clean).toMatchObject({ pass: true, evaluator: 'mock', generatorCalls: 0 });
    for (const generator of [
      { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 1 },
      { inputTokens: 0, outputTokens: 0, costUsd: 0.01, calls: 0 },
      { inputTokens: 5, outputTokens: 0, costUsd: 0, calls: 0 },
    ]) {
      const bad = buildRecord({ source: syntheticSource({ id: 'a' }), condition: 'jev-only', result: fakeRunResult({ runId: 'r', mode: 'jev-only', usage: { generator, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 } } }), evaluation: { pass: true, evaluator: 'mock' }, patch: null, capFired: null });
      expect(bad).toMatchObject({ pass: null, evaluator: 'invalid', reason: JEV_ONLY_GENERATOR_CALLED, generatorCalls: generator.calls });
    }
    // the other conditions keep their verdict whatever the generator did
    const on = buildRecord({ source: syntheticSource({ id: 'a' }), condition: 'jev-on', result: fakeRunResult({ runId: 'r', mode: 'jev-on', usage: { generator: { inputTokens: 9, outputTokens: 9, costUsd: 0.1, calls: 3 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 } } }), evaluation: { pass: false, evaluator: 'mock' }, patch: null, capFired: null });
    expect(on).toMatchObject({ pass: false, evaluator: 'mock', generatorCalls: 3 });
  });
});

describe('runBench with jev-on, jev-off and jev-only', () => {
  it('2 tasks × 3 conditions -> 6 records, NullProvider + synthesizer for jev-only, 3-column comparison, 3 predictions files', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const { deps, captured } = createFakeDeps({ script: threeWay });
    const sources = ['t1', 't2'].map((id) => syntheticSource({ id, evaluate: ({ condition }) => ({ pass: condition !== 'jev-only' || id === 't1', evaluator: 'mock' }) }));
    const out = await runBenchWithSources(sources, baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { conditions: ['jev-only', 'jev-off', 'jev-on'], concurrency: 2 }), deps);

    expect(out.records).toHaveLength(6);
    expect(captured.engines).toHaveLength(6);
    const only = captured.engines.filter((e) => e.mode === 'jev-only');
    expect(only).toHaveLength(2);
    for (const e of only) {
      expect(e.opts.provider.model).toBe(NULL_GENERATOR_MODEL);
      expect(e.opts.synthesizer?.name).toBe('fake-synth');
      expect(e.opts.task).toMatch(/^Task text for t[12]$/);
    }
    for (const e of captured.engines.filter((x) => x.mode !== 'jev-only')) expect(e.opts.synthesizer).toBeUndefined();
    // the synthesizer was built with the run's decider; the mock provider only for the generator conditions
    expect(captured.synthesizerDeciders).toHaveLength(2);
    expect(captured.mockProviders).toHaveLength(4);
    expect(captured.generateRequests).toHaveLength(4);

    const recs = out.records.filter((r) => r.condition === 'jev-only');
    expect(recs).toHaveLength(2);
    expect(recs.every((r) => r.generatorCalls === 0 && r.cost.generator === 0 && r.generatorTokensPerStep.every((x) => x === 0) && r.pairComplete && r.jevQuestions === 12)).toBe(true);
    expect(recs.map((r) => [r.task, r.pass]).sort()).toEqual([['t1', true], ['t2', false]]);
    expect(out.records.filter((r) => r.condition !== 'jev-only').every((r) => r.generatorCalls === 1)).toBe(true);

    const s = out.summary;
    expect(s.conditionOrder).toEqual(['jev-on', 'jev-off', 'jev-only']);
    expect(s.conditions['jev-only']).toMatchObject({ mode: 'jev-only', generatorModel: NULL_GENERATOR_MODEL, deciderModel: 'typesafe/jev-1.13-20260917' });
    expect(s.generatorModel).toBe('mock-model');
    expect(s.spentUsd).toEqual({ generator: 2, jev: 1, total: 3 });
    expect(s.pairedTasks).toEqual({ swebench: 2 });
    const sw = s.perSuite['swebench']!;
    expect(sw.perCondition['jev-only']!.passRateText).toBe('1/2 (n=2)');
    expect(sw.perCondition['jev-only']!.generatorCalls).toBe(0);
    expect(sw.perCondition['jev-on']!.generatorCalls).toBe(2);
    expect(sw.comparison.conditions).toEqual(['jev-on', 'jev-off', 'jev-only']);
    expect(sw.comparison.pairedTasks).toEqual(['t1', 't2']);
    expect(sw.comparison.rows.map((r) => r.pass['jev-only'])).toEqual([true, false]);

    const md = out.comparisonMarkdown;
    expect(md).toContain('**jev-only** has no generating LLM');
    expect(md).toContain('| metric | jev-on | jev-off | jev-only |');
    expect(md).toContain('| generator calls (jev-only asserts 0) | 2 | 2 | 0 |');
    expect(md).toContain('| mean generator tokens/step (steps) | 30 (n=6) | 50 (n=10) | 0 (n=8) |');
    expect(md).toContain('| mean Jev tokens/step (steps) | 70 (n=6) | 0 (n=10) | 80 (n=8) |');
    expect(md).toContain('| task | jev-on pass | jev-on steps | jev-on reads | jev-on cost | jev-off pass | jev-off steps | jev-off reads | jev-off cost | jev-only pass | jev-only steps | jev-only reads | jev-only cost |');
    expect(md).toContain(`| jev-only | ${NULL_GENERATOR_MODEL} |`);

    const files = await Promise.all(['tasks.jsonl', 'predictions.jev-on.jsonl', 'predictions.jev-off.jsonl', 'predictions.jev-only.jsonl'].map((f) => readFile(join(out.outDir, f), 'utf8')));
    const lines = files[0]!.trim().split('\n');
    expect(lines).toHaveLength(6);
    expect(lines.filter((l) => l.includes('"condition":"jev-only"')).every((l) => l.includes('"generatorCalls":0'))).toBe(true);
    for (const pf of files.slice(1)) expect(pf.trim().split('\n')).toHaveLength(2);
    expect((JSON.parse(files[3]!.trim().split('\n')[0]!) as Record<string, string>)['model_name_or_path']).toBe('jevcode-jev-only-none');
    expect((JSON.parse(files[1]!.trim().split('\n')[0]!) as Record<string, string>)['model_name_or_path']).toBe('jevcode-jev-on-mock-model');
    // tasks.jsonl reads back with the condition accepted and the assertion field kept
    const back = await readTasksJsonl(join(out.outDir, 'tasks.jsonl'));
    expect(back).toHaveLength(6);
    expect(back.filter((r) => r.condition === 'jev-only').map((r: BenchRecord) => r.generatorCalls)).toEqual([0, 0]);
  });

  it('a jev-only record whose RunResult shows generator usage is written invalid and drops out of the paired set', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const leaky: EngineScript = (_task, mode) => ({
      result: { steps: 2, ...(mode === 'jev-only' ? { usage: { generator: { inputTokens: 10, outputTokens: 2, costUsd: 0.001, calls: 1 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 } } } : {}) },
    });
    const { deps } = createFakeDeps({ script: leaky });
    const out = await runBenchWithSources([syntheticSource({ id: 'a' })], baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { conditions: ['jev-on', 'jev-only'] }), deps);
    const bad = out.records.find((r) => r.condition === 'jev-only')!;
    expect(bad).toMatchObject({ pass: null, evaluator: 'invalid', reason: JEV_ONLY_GENERATOR_CALLED, generatorCalls: 1, stopReason: 'complete' });
    expect(out.records.find((r) => r.condition === 'jev-on')).toMatchObject({ pass: true, evaluator: 'mock' });
    const sw = out.summary.perSuite['swebench']!;
    expect(sw.perCondition['jev-only']!.unevaluated).toEqual(['a']);
    expect(sw.perCondition['jev-only']!.evaluated).toBe(0);
    expect(sw.comparison.pairedTasks).toEqual([]);
    expect(sw.comparison.incompletePairs).toEqual(['a']);
    expect(out.comparisonMarkdown).toContain(JEV_ONLY_GENERATOR_CALLED);
  });

  it('a jev-only-only bench records the null generator model and needs no live provider', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const { deps } = createFakeDeps({ script: threeWay, live: true, liveProviderless: true });
    const opts = baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { conditions: ['jev-only'], live: true, spendCapUsd: 10 });
    expect(() => validateOptions(opts, deps)).not.toThrow();
    const out = await runBenchWithSources([syntheticSource({ id: 'a' })], opts, deps);
    expect(out.records).toHaveLength(1);
    expect(out.summary.generatorModel).toBe(NULL_GENERATOR_MODEL);
    expect(out.summary.conditionOrder).toEqual(['jev-only']);
    expect(out.summary.mocked).toBe(false);
  });

  it('validateOptions: jev-only needs createSynthesizer; jev-on/jev-off with --live still need the live provider', async () => {
    const base = baseOptions('/r', '/o');
    const noSynth = createFakeDeps({ script: threeWay, noSynthesizer: true }).deps;
    expect(() => validateOptions({ ...base, conditions: ['jev-only'] }, noSynth)).toThrow(/synthesizer/);
    expect(() => validateOptions({ ...base, conditions: ['jev-on', 'jev-off'] }, noSynth)).not.toThrow();
    const providerless = createFakeDeps({ script: threeWay, live: true, liveProviderless: true }).deps;
    expect(() => validateOptions({ ...base, conditions: ['jev-on', 'jev-only'], live: true, spendCapUsd: 1 }, providerless)).toThrow(/live provider/);
    expect(() => validateOptions({ ...base, conditions: ['jev-only'], live: true, spendCapUsd: 1 }, providerless)).not.toThrow();
    const deciderless = createFakeDeps({ script: threeWay }).deps;
    expect(() => validateOptions({ ...base, conditions: ['jev-only'], live: true, spendCapUsd: 1 }, deciderless)).toThrow(/live decider/);
  });
});
