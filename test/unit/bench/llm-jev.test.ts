/**
 * The llm-jev bench condition (docs/LLM-JEV-DESIGN.md §10.1): the fourth condition, a real (or mock) provider AND the
 * synthesizer wired into the engine, generator calls recorded and never asserted zero (the jev-only invalidation stays
 * jev-only's), a synthesizer required by validateOptions.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IN_PROGRESS, JEV_ONLY_GENERATOR_CALLED, buildRecord, readTasksJsonl, runBenchWithSources, validateOptions } from '../../../src/bench/runner.js';
import { STEPS_FILE } from '../../../src/bench/step-records.js';
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
    expect(CONDITION_ORDER).toEqual(['jev-on', 'jev-off', 'jev-only', 'llm-jev', 'llm-sieve', 'jev-off-tuned', 'jev-on-next', 'jev-on-next-nofast']);
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

  it("the record's synth.verify sums the run's steps.jsonl — the engine's verify block, or an older row's evidence count — and the in-progress marker is gone from tasks.jsonl at the end", async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const runsDir = join(t.dir, 'runs');
    const { deps, captured } = createFakeDeps({
      script: (_task, _mode) => ({
        result: { steps: 3 },
        spendUsd: 0.01,
        // what the engine writes: one step with a verify block, one committed by an engine that wrote only the evidence, one `run` step
        effect: async () => {
          const runId = captured.engines.at(-1)!.runId;
          const rows = [
            { step: 1, proposer: 'synth', timing: { generatorMs: 1, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 1, synthMs: 4000 }, proposal: { action: { kind: 'patch', diff: '' }, evidence: { candidatesTested: 3 } }, verify: { samples: 3, distinct: 2, malformed: 0, timeouts: 1, cancelled: 1, misanchored: 0, candidatesTested: 640, passers: 1, partials: 0, graceMs: 250, localisationMissed: true } },
            { step: 2, proposer: 'synth', timing: { generatorMs: 1, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 1, synthMs: 1000 }, proposal: { action: { kind: 'patch', diff: '' }, evidence: { candidatesTested: 1445 } } },
            { step: 3, proposer: 'synth', timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 1, synthMs: 500 }, proposal: { action: { kind: 'run', command: 'pytest -q' } } },
          ];
          await writeFile(join(runsDir, runId, STEPS_FILE), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
        },
      }),
    });
    const out = await runBenchWithSources([syntheticSource({ id: 't1' })], baseOptions(runsDir, join(t.dir, 'out'), { conditions: ['llm-jev'] }), deps);
    expect(out.records).toHaveLength(1);
    const synth = out.records[0]!.synth;
    expect(synth).toBeDefined();
    expect(synth!.steps).toBe(3);
    expect(synth!.synthSteps).toBe(3);
    expect(synth!.synthMs).toBe(5500);
    expect(synth!.verify).toEqual({ samples: 3, distinct: 2, malformed: 0, timeouts: 1, cancelled: 1, misanchored: 0, candidatesTested: 640 + 1445, passers: 1, partials: 0, graceMs: 250, localisationMissed: 1 });
    // the `in_progress` placeholder written when the engine started is superseded and dropped by the end-of-bench rewrite
    const lines = (await readFile(join(out.outDir, 'tasks.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const onDisk = await readTasksJsonl(join(out.outDir, 'tasks.jsonl'));
    expect(onDisk.map((r) => [r.stopReason, r.reason === IN_PROGRESS])).toEqual([['complete', false]]);
    expect(out.summary.notRun.count).toBe(0);
  });
});
