/**
 * F06 — `llm-sieve` is a user-typeable `--conditions` value that produced a run directory of errors.
 *
 * `src/cli/args.ts`'s `CONDITIONS` table accepts it, `parseConditions` accepts it, `CONDITION_ORDER`
 * lists it, `conditionConfig` pins its generation, the runner wires the stub decider into it and
 * `src/bench/headtohead.ts`'s criterion 5a is written against it — and then `createSynthesizer`
 * threw `mode "llm-sieve" is not wired in this build`, which the runner turns into one
 * `engine_create_failed` record PER TASK. So `jevcode bench --conditions llm-sieve` spent the walk
 * over the whole suite to write a directory of failures instead of failing in one line at argv time,
 * and criterion 5a ("attribution vs llm-sieve" — the control that says whether the Jev questions
 * earn their keep at all) was permanently `not_evaluable`.
 *
 * The audit offered two one-line answers: reject the arm at argv time, or construct it. This tree
 * takes the second, because the arm's definition IS the llm-jev search with the Jev slot stubbed:
 * `usesStubDecider('llm-sieve')` puts `src/bench/stub-decider.ts` in the decider slot, whose inert
 * answers (Noul 0.5 under every yes-cut and above every no-cut, all Choice mass on the first
 * non-escape option = arrival order, harm level 0) are precisely the "every Jev question replaced by
 * its code default" of docs/LLM-JEV-DESIGN.md §10.1, and they are COUNTED, so the record shows how
 * many requests the arm did not make. Nothing in the synthesizer's own `mode` was ever going to
 * issue a real Jev request that the stub did not already absorb.
 *
 * What this test pins, then: the arm parses, the factory constructs it, it echoes `llm-sieve` (the
 * runner refuses an arm whose synthesizer does not — an arm must never silently run as another one),
 * and no path reaches `engine_create_failed`.
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CONDITIONS } from '../../../src/cli/args.js';
import { CONDITION_ORDER, engineModeOf, parseConditions, synthesizerGenerationOf, synthesizerModeOf, usesStubDecider, usesSynthesizer } from '../../../src/bench/conditions.js';
import { runBenchWithSources } from '../../../src/bench/runner.js';
import { STUB_DECIDER_MODEL } from '../../../src/bench/stub-decider.js';
import { ConfigError } from '../../../src/errors.js';
import { LLM_DEFAULT_GENERATION } from '../../../src/synth/llm/source.js';
import { createSynthesizer } from '../../../src/synth/index.js';
import type { Decider } from '../../../src/core/types.js';
import { baseOptions, createFakeDeps, syntheticSource, tempDir, type EngineScript } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const decider: Decider = { model: 'm', provider: 'openrouter', ask: () => Promise.reject(new Error('unused')) };

describe('F06 — the llm-sieve arm is runnable, not a directory of engine_create_failed', () => {
  it('is typeable at argv and reaches a runnable config', () => {
    expect(CONDITIONS).toContain('llm-sieve');
    expect(CONDITION_ORDER).toContain('llm-sieve');
    expect(parseConditions('llm-sieve')).toEqual(['llm-sieve']);
    // it is a bench-side substitution on llm-jev, never an EngineMode of its own
    expect(engineModeOf('llm-sieve')).toBe('llm-jev');
    expect(usesSynthesizer('llm-sieve')).toBe(true);
    expect(usesStubDecider('llm-sieve')).toBe(true);
    expect(synthesizerModeOf('llm-sieve')).toBe('llm-sieve');
    expect(synthesizerGenerationOf('llm-sieve', 'z-ai/glm-5.3-flash')).toBe(LLM_DEFAULT_GENERATION);
  });

  it('constructs from the real factory and echoes its own mode with the pinned generation', () => {
    const pinned = synthesizerGenerationOf('llm-sieve', 'z-ai/glm-5.3-flash')!;
    const sieve = createSynthesizer({ decider, redact: (s) => s, mode: 'llm-sieve', generation: pinned });
    expect(sieve.mode).toBe('llm-sieve');
    // the same object, not a copy: summary.json records what the samples send (the runner's echo check)
    expect(sieve.generation).toBe(pinned);
    expect(typeof sieve.handles).toBe('function');
    // and it is the llm-jev search underneath, which is what makes criterion 5a a like-for-like contrast
    expect(sieve.name).toBe(createSynthesizer({ decider, redact: (s) => s, mode: 'llm-jev', generation: pinned }).name);
  });

  it('a whole bench arm runs: no engine_create_failed record, and the stub is the decider', async () => {
    const t = await tempDir();
    cleanups.push(t.cleanup);
    const script: EngineScript = () => ({ result: { steps: 1 } });
    const real = createFakeDeps({ script });
    // the REAL factory, with the mode recorded on the way through
    real.deps.createSynthesizer = (opts) => {
      real.captured.synthesizerModes.push(opts.mode);
      return createSynthesizer(opts);
    };
    const out = await runBenchWithSources([syntheticSource({ id: 't1' }), syntheticSource({ id: 't2' })], baseOptions(join(t.dir, 'runs'), join(t.dir, 'out'), { conditions: ['llm-sieve'] }), real.deps);
    expect(out.records).toHaveLength(2);
    for (const r of out.records) {
      expect(r.reason ?? '').not.toContain('engine_create_failed');
      expect(r).toMatchObject({ condition: 'llm-sieve', stopReason: 'complete', pass: true });
    }
    expect(real.captured.synthesizerModes).toEqual(['llm-sieve', 'llm-sieve']);
    expect(real.captured.engines.map((e) => e.opts.mode)).toEqual(['llm-jev', 'llm-jev']);
    expect(out.summary.conditions['llm-sieve']).toMatchObject({ mode: 'llm-jev', deciderModel: STUB_DECIDER_MODEL });
  });

  it('an unknown condition is still one ConfigError at argv time', () => {
    expect(() => parseConditions('llm-sieve,not-an-arm')).toThrow(ConfigError);
    expect(() => parseConditions('')).toThrow(ConfigError);
  });
});
