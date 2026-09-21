/**
 * The attribution arms of docs/LLM-JEV-DESIGN.md §10.1 (stage 5): `llm-sieve` and `jev-off-tuned` parse, map onto their
 * engine modes, carry PINNED generation parameters (jev-off = the checked-in baseline's, never the user config), and the
 * runner wires the stub decider / the tuned provider and records what they counted.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONDITION_ORDER,
  GLM_FLASH_SERVED_RATE,
  buildEngineOptions,
  conditionConfig,
  engineModeOf,
  isBenchCondition,
  parseConditions,
  pinnedGeneration,
  requiresGenerator,
  servedRateFor,
  synthesizerModeOf,
  tunedParamsFor,
  usesStubDecider,
  usesSynthesizer,
  usesTunedProvider,
} from '../../../src/bench/conditions.js';
import { runBenchWithSources } from '../../../src/bench/runner.js';
import { STUB_DECIDER_MODEL } from '../../../src/bench/stub-decider.js';
import { planCapSentence } from '../../../src/bench/tuned-provider.js';
import type { Decider } from '../../../src/core/types.js';
import { baseOptions, createCaptured, createFakeDeps, createFakeMeter, createFakeProvider, syntheticSource, tempDir, type EngineScript } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const GLM = 'z-ai/glm-5.3-flash';

describe('arms (docs/LLM-JEV-DESIGN.md §10.1)', () => {
  it('order, parsing and the engine mode behind each arm', () => {
    expect(CONDITION_ORDER).toEqual(['jev-on', 'jev-off', 'jev-only', 'llm-jev', 'llm-sieve', 'jev-off-tuned']);
    expect(parseConditions('llm-sieve, jev-off-tuned,llm-jev')).toEqual(['llm-sieve', 'jev-off-tuned', 'llm-jev']);
    expect(isBenchCondition('llm-sieve')).toBe(true);
    expect(isBenchCondition('jev-tuned')).toBe(false);
    expect(engineModeOf('llm-sieve')).toBe('llm-jev');
    expect(engineModeOf('jev-off-tuned')).toBe('jev-off');
    expect(engineModeOf('jev-on')).toBe('jev-on');
    expect(usesSynthesizer('llm-sieve')).toBe(true);
    expect(usesSynthesizer('jev-off-tuned')).toBe(false);
    expect(synthesizerModeOf('llm-sieve')).toBe('llm-sieve');
    expect(synthesizerModeOf('llm-jev')).toBe('llm-jev');
    expect(synthesizerModeOf('jev-only')).toBe('jev-only');
    expect(synthesizerModeOf('jev-off')).toBeNull();
    expect(usesStubDecider('llm-sieve')).toBe(true);
    expect(usesStubDecider('llm-jev')).toBe(false);
    expect(usesTunedProvider('jev-off-tuned')).toBe(true);
    expect(usesTunedProvider('jev-off')).toBe(false);
    expect(requiresGenerator(['llm-sieve'])).toBe(true);
    expect(requiresGenerator(['jev-off-tuned'])).toBe(true);
  });

  it('pinned generation parameters per arm; the served GLM rate is 5/3× the table', () => {
    expect(pinnedGeneration('jev-off', GLM)).toEqual({ proposer: 'generator', temperature: null, maxTokens: 4096, reasoning: null, deadlineMs: null, lengthHandling: 'none', servedRate: { inputPerM: 0.15, outputPerM: 0.5 } });
    expect(pinnedGeneration('jev-off-tuned', GLM)).toMatchObject({ proposer: 'generator', temperature: null, maxTokens: 1500, reasoning: { effort: 'low' }, deadlineMs: 20_000, repositoryDeadlineMs: 30_000, lengthHandling: 'double-once' });
    expect(tunedParamsFor(GLM, 'quixbugs')).toMatchObject({ maxTokens: 1500, reasoning: { effort: 'low' }, deadlineMs: 20_000, lengthHandling: 'double-once', servedRate: GLM_FLASH_SERVED_RATE, planCapChars: 200 });
    expect(tunedParamsFor(GLM, 'swebench').deadlineMs).toBe(30_000);
    const llm = pinnedGeneration('llm-jev', GLM);
    expect(llm).toMatchObject({ proposer: 'synthesizer', temperature: null, sampleTemperatures: [0, 0.8], maxTokens: 3000, reasoning: { effort: 'low' }, deadlineMs: 20_000, repositoryDeadlineMs: 30_000, lengthHandling: 'double-once' });
    expect(pinnedGeneration('llm-sieve', GLM)).toEqual(llm);
    expect(servedRateFor(GLM)).toEqual(GLM_FLASH_SERVED_RATE);
    expect(servedRateFor('claude-sonnet-5')).toEqual({ inputPerM: 2, outputPerM: 10 });
    expect(servedRateFor('unknown/model')).toEqual({ inputPerM: 0, outputPerM: 0 });
  });

  it('conditionConfig and buildEngineOptions never take an arm\'s generation from the user config', () => {
    const opts = baseOptions('/r', '/o', { generation: { temperature: 0.7, maxTokens: 999 } });
    expect(conditionConfig('jev-off', opts, GLM)).toMatchObject({ condition: 'jev-off', mode: 'jev-off', temperature: null, maxTokens: 4096, deciderModel: null, generation: { reasoning: null, deadlineMs: null } });
    expect(conditionConfig('llm-sieve', opts, GLM)).toMatchObject({ condition: 'llm-sieve', mode: 'llm-jev', deciderModel: STUB_DECIDER_MODEL, generatorModel: GLM, maxTokens: 3000 });
    expect(conditionConfig('jev-off-tuned', opts, GLM)).toMatchObject({ condition: 'jev-off-tuned', mode: 'jev-off', deciderModel: null, maxTokens: 1500 });
    expect(conditionConfig('llm-jev', opts, GLM)).toMatchObject({ mode: 'llm-jev', deciderModel: 'typesafe/jev-1.13-20260917' });

    const provider = createFakeProvider(createCaptured(), GLM);
    const decider: Decider = { model: 'm', ask: () => Promise.reject(new Error('unused')) };
    const build = (condition: 'jev-off' | 'jev-off-tuned' | 'llm-sieve' | 'llm-jev') => buildEngineOptions({ condition, task: 't', workspace: '/ws', provider, decider, meter: createFakeMeter(1) }, opts);
    expect(build('jev-off')).toMatchObject({ mode: 'jev-off', generation: { temperature: null, maxTokens: 4096 } });
    expect(build('jev-off-tuned')).toMatchObject({ mode: 'jev-off', generation: { temperature: null, maxTokens: 1500 } });
    expect(build('llm-sieve')).toMatchObject({ mode: 'llm-jev', generation: { temperature: null, maxTokens: 3000 }, deciderModel: { configured: STUB_DECIDER_MODEL, pinned: true } });
    expect(build('llm-jev').deciderModel).toEqual(opts.deciderModel);
  });

  it('runBench wires the stub decider into llm-sieve and the tuned provider into jev-off-tuned, and records what they counted', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const script: EngineScript = () => ({ result: { steps: 1, tokensPerStep: [10], generatorTokensPerStep: [10], jevTokensPerStep: [0] }, spendUsd: 0.001 });
    const { deps, captured } = createFakeDeps({ script });
    const out = await runBenchWithSources([syntheticSource({ id: 't1' })], baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { conditions: ['jev-off-tuned', 'llm-sieve', 'jev-off'] }), deps);
    // CONDITION_ORDER: jev-off, llm-sieve, jev-off-tuned
    expect(captured.engines.map((e) => e.opts.mode)).toEqual(['jev-off', 'llm-jev', 'jev-off']);
    const [off, sieve, tuned] = captured.engines;
    expect(off!.opts.generation).toEqual({ temperature: null, maxTokens: 4096 });
    expect(sieve!.opts.decider.model).toBe(STUB_DECIDER_MODEL);
    expect(sieve!.opts.deciderModel).toEqual({ configured: STUB_DECIDER_MODEL, pinned: true });
    expect(sieve!.opts.synthesizer?.name).toBe('fake-synth');
    expect(captured.synthesizerModes).toEqual(['llm-sieve']);
    expect(captured.synthesizerDeciders[0]!.model).toBe(STUB_DECIDER_MODEL);
    expect(tuned!.opts.generation).toEqual({ temperature: null, maxTokens: 1500 });
    // the tuned engine's one generate call reached the inner (fake) provider rewritten by the wrapper; the others untouched
    const tunedReq = captured.generateRequests.filter((r) => r.reasoning !== undefined);
    expect(tunedReq).toHaveLength(1);
    expect(tunedReq[0]).toMatchObject({ maxTokens: 1500, reasoning: { effort: 'low' } });
    expect(tunedReq[0]!.system).toContain(planCapSentence(200));
    expect(captured.generateRequests.filter((r) => r.reasoning === undefined).map((r) => r.maxTokens)).toEqual([4096, 3000]);

    const rec = (c: string) => out.records.find((r) => r.condition === c)!;
    // the scripted engine asked the decider once: the stub counted it, and no Jev request was made
    expect(rec('llm-sieve')).toMatchObject({ stubbedJevRequests: 1, jevRequests: 0, pass: true });
    expect(rec('jev-off-tuned')).toMatchObject({ tuned: { timeouts: 0, doubled: 0 }, servedRate: { inputPerM: 0, outputPerM: 0 } });
    expect(rec('jev-off-tuned').generator?.calls).toBe(0);
    expect(rec('jev-off-tuned').loadavg).toHaveLength(3);
    expect(rec('jev-off').stubbedJevRequests).toBeUndefined();
    expect(rec('jev-off').tuned).toBeUndefined();
    expect(out.summary.conditionOrder).toEqual(['jev-off', 'llm-sieve', 'jev-off-tuned']);
    expect(out.summary.conditions['llm-sieve']).toMatchObject({ mode: 'llm-jev', deciderModel: STUB_DECIDER_MODEL });
    expect(out.summary.conditions['jev-off-tuned']!.generation).toMatchObject({ maxTokens: 1500, reasoning: { effort: 'low' }, deadlineMs: 20_000, lengthHandling: 'double-once' });
    expect(out.comparisonMarkdown).toContain('**llm-sieve**');
    expect(out.comparisonMarkdown).toContain('| jev-off-tuned | jev-off |');
    expect(out.comparisonMarkdown).toContain('## Head-to-head verdict');
  });
});
