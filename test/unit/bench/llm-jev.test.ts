/**
 * The llm-jev bench condition (docs/LLM-JEV-DESIGN.md §10.1): the fourth condition, a real (or mock) provider AND the
 * synthesizer wired into the engine, generator calls recorded and never asserted zero (the jev-only invalidation stays
 * jev-only's), a synthesizer required by validateOptions.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { JEV_ONLY_GENERATOR_CALLED, buildRecord, runBenchWithSources, validateOptions } from '../../../src/bench/runner.js';
import { CONDITION_ORDER, conditionConfig, isBenchCondition, parseConditions, requiresGenerator, requiresSynthesizer, usesSynthesizer } from '../../../src/bench/conditions.js';
import { baseOptions, createFakeDeps, fakeRunResult, syntheticSource, tempDir, type EngineScript } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const script: EngineScript = (_task, mode) => ({
  result: { steps: 2, tokensPerStep: [120, 80], generatorTokensPerStep: [100, 0], jevTokensPerStep: [20, 80], jevLatencyMs: [150, 170] },
  decisions: mode === 'jev-off' ? 0 : 3,
  spendUsd: 0.02,
});

describe('llm-jev condition', () => {
  it('is the fourth condition: parsed, generator AND synthesizer required, real generator model in the config', () => {
    expect(CONDITION_ORDER).toEqual(['jev-on', 'jev-off', 'jev-only', 'llm-jev', 'llm-sieve', 'jev-off-tuned']);
    expect(isBenchCondition('llm-jev')).toBe(true);
    expect(parseConditions('llm-jev,jev-off')).toEqual(['llm-jev', 'jev-off']);
    expect(requiresGenerator(['llm-jev'])).toBe(true);
    expect(usesSynthesizer('llm-jev')).toBe(true);
    expect(usesSynthesizer('jev-on')).toBe(false);
    expect(requiresSynthesizer(['jev-on', 'jev-off'])).toBe(false);
    expect(requiresSynthesizer(['jev-off', 'llm-jev'])).toBe(true);
    expect(conditionConfig('llm-jev', baseOptions('/r', '/o'), 'z-ai/glm-5.3-flash')).toMatchObject({ mode: 'llm-jev', generatorModel: 'z-ai/glm-5.3-flash', deciderModel: 'typesafe/jev-1.13-20260917' });
    const { deps } = createFakeDeps({ script, noSynthesizer: true });
    expect(() => validateOptions(baseOptions('/r', '/o', { conditions: ['llm-jev'] }), deps)).toThrow('condition llm-jev requires a synthesizer');
    expect(() => validateOptions(baseOptions('/r', '/o', { conditions: ['jev-only'] }), deps)).toThrow('condition jev-only requires a synthesizer');
    expect(() => validateOptions(baseOptions('/r', '/o', { conditions: ['jev-on'] }), deps)).not.toThrow();
  });

  it('a record with generator usage keeps its verdict in llm-jev (the zero-generator invalidation is jev-only\'s)', () => {
    const usage = { generator: { inputTokens: 900, outputTokens: 300, costUsd: 0.01, calls: 4 }, jev: { inputTokens: 50, outputTokens: 5, costUsd: 0.0001, calls: 2 } };
    const rec = buildRecord({ source: syntheticSource({ id: 'a' }), condition: 'llm-jev', result: fakeRunResult({ runId: 'r', mode: 'llm-jev', usage }), evaluation: { pass: true, evaluator: 'mock' }, patch: null, capFired: null });
    expect(rec).toMatchObject({ condition: 'llm-jev', pass: true, evaluator: 'mock', generatorCalls: 4 });
    expect(rec.reason).not.toBe(JEV_ONLY_GENERATOR_CALLED);
  });

  it('runBench wires the provider and the synthesizer into an llm-jev engine and records its generator calls', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const { deps, captured } = createFakeDeps({ script });
    const out = await runBenchWithSources([syntheticSource({ id: 't1' })], baseOptions(t.dir + '/runs', t.dir + '/out', { conditions: ['llm-jev'] }), deps);
    expect(captured.engines.map((e) => e.mode)).toEqual(['llm-jev']);
    const engine = captured.engines[0]!;
    expect(engine.opts.synthesizer?.name).toBe('fake-synth');
    expect(engine.opts.provider.model).toBe('mock-model');
    expect(captured.synthesizerDeciders).toHaveLength(1);
    // the scripted engine called the generator once and spent on it: recorded, not invalidated
    expect(captured.generateRequests).toHaveLength(1);
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({ condition: 'llm-jev', pass: true, evaluator: 'mock', generatorCalls: 1 });
    expect(out.records[0]!.reason).not.toBe(JEV_ONLY_GENERATOR_CALLED);
    expect(out.records[0]!.cost.generator).toBeCloseTo(0.02, 9);
  });
});
