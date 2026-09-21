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
  synthesizerGenerationOf,
  synthesizerModeOf,
  tunedParamsFor,
  usesStubDecider,
  usesSynthesizer,
  usesTunedProvider,
} from '../../../src/bench/conditions.js';
import { runBenchWithSources, synthesizerMismatch } from '../../../src/bench/runner.js';
import { STUB_DECIDER_MODEL } from '../../../src/bench/stub-decider.js';
import { planCapSentence } from '../../../src/bench/tuned-provider.js';
import type { Decider } from '../../../src/core/types.js';
import { createSynthesizer as createRealSynthesizer } from '../../../src/synth/index.js';
import { LLM_DEFAULT_GENERATION } from '../../../src/synth/llm/source.js';
import { baseOptions, createCaptured, createFakeDeps, createFakeMeter, createFakeProvider, createFakeSynthesizer, syntheticSource, tempDir, type EngineScript } from './helpers.js';

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
    // the flat fields are read off the ONE object the synthesizer receives (the LLM source's own defaults), never stated beside it
    expect(llm.synthesizer).toBe(LLM_DEFAULT_GENERATION);
    expect(LLM_DEFAULT_GENERATION).toEqual({ reasoning: { effort: 'low' }, maxTokens: 3000, sampleDeadline: { minMs: 10_000, maxMs: 20_000, repositoryMs: 30_000 }, sampleTemperature: { first: 0, rest: 0.8, feedbackFirst: 0.6, feedbackRest: 1 } });
    expect(synthesizerGenerationOf('llm-sieve', GLM)).toBe(LLM_DEFAULT_GENERATION);
    expect(synthesizerGenerationOf('jev-only', GLM)).toBeNull();
    expect(pinnedGeneration('jev-off-tuned', GLM).synthesizer).toBeUndefined();
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
    expect(captured.synthesizerGenerations).toEqual([LLM_DEFAULT_GENERATION]);
    expect(sieve!.opts.synthesizer).toMatchObject({ mode: 'llm-sieve', generation: LLM_DEFAULT_GENERATION });
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

  it('a synthesizer arm is refused — never run as another arm — when the synthesizer does not echo the mode or the pinned generation, or the factory throws', async () => {
    expect(synthesizerMismatch(createFakeSynthesizer('llm-sieve', LLM_DEFAULT_GENERATION), 'llm-sieve', LLM_DEFAULT_GENERATION)).toBeNull();
    expect(synthesizerMismatch(createFakeSynthesizer('jev-only'), 'jev-only', null)).toBeNull();
    expect(synthesizerMismatch(createFakeSynthesizer(), 'llm-sieve', LLM_DEFAULT_GENERATION)).toContain('acknowledges mode none; the arm needs "llm-sieve"');
    expect(synthesizerMismatch(createFakeSynthesizer('llm-jev', LLM_DEFAULT_GENERATION), 'llm-sieve', LLM_DEFAULT_GENERATION)).toContain('acknowledges mode "llm-jev"');
    expect(synthesizerMismatch(createFakeSynthesizer('llm-sieve'), 'llm-sieve', LLM_DEFAULT_GENERATION)).toContain('echoes no generation parameters');
    expect(synthesizerMismatch(createFakeSynthesizer('llm-sieve', { ...LLM_DEFAULT_GENERATION, maxTokens: 1500 }), 'llm-sieve', LLM_DEFAULT_GENERATION)).toContain('other generation parameters than the pinned ones');

    const t = await tempDir();
    cleanups.push(t.cleanup);
    const script: EngineScript = () => ({ result: { steps: 1 } });
    // src/synth's real factory: jev-only is echoed; the LLM arms are not wired until stage 4 and say so instead of running the jev-only search under their name
    const decider: Decider = { model: 'm', ask: () => Promise.reject(new Error('unused')) };
    expect(createRealSynthesizer({ decider, redact: (s) => s }).mode).toBe('jev-only');
    expect(createRealSynthesizer({ decider, redact: (s) => s, mode: 'jev-only' }).mode).toBe('jev-only');
    expect(() => createRealSynthesizer({ decider, redact: (s) => s, mode: 'llm-sieve', generation: LLM_DEFAULT_GENERATION })).toThrow('mode "llm-sieve" is not wired');
    const real = createFakeDeps({ script });
    real.deps.createSynthesizer = createRealSynthesizer;
    const out = await runBenchWithSources([syntheticSource({ id: 't1' })], baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { conditions: ['jev-only', 'llm-jev', 'llm-sieve'] }), real.deps);
    const rec = (c: string) => out.records.find((r) => r.condition === c)!;
    expect(rec('jev-only')).toMatchObject({ pass: true, stopReason: 'complete' });
    expect(rec('llm-jev')).toMatchObject({ pass: null, evaluator: 'none', stopReason: 'error' });
    expect(rec('llm-jev').reason).toContain('engine_create_failed: synthesizer: mode "llm-jev" is not wired');
    expect(rec('llm-sieve').reason).toContain('mode "llm-sieve" is not wired');
    expect(real.captured.engines.map((e) => e.opts.mode)).toEqual(['jev-only']);

    // a factory that returns a synthesizer without the echo: refused with the reason on the record, no engine created
    const silent = createFakeDeps({ script });
    silent.deps.createSynthesizer = () => createFakeSynthesizer();
    const out2 = await runBenchWithSources([syntheticSource({ id: 't1' })], baseOptions(join(t.dir, 'runs2'), join(t.dir, 'out2'), { conditions: ['llm-sieve'] }), silent.deps);
    expect(out2.records[0]).toMatchObject({ condition: 'llm-sieve', stopReason: 'error', pass: null });
    expect(out2.records[0]!.reason).toBe('engine_create_failed: synthesizer "fake-synth" acknowledges mode none; the arm needs "llm-sieve"');
    expect(silent.captured.engines).toEqual([]);
  });
});
