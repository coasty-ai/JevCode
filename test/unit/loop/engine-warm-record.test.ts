/**
 * F04 — `StepRecord.verify` is written for every step whose synthesizer REPORTED something, not only for
 * `mode === 'llm-jev' && proposer === 'synth'`.
 *
 * Two facts made the warm-plane recording of `warm-plane-fix-2` a silent no-op in `jev-only`:
 *
 *  1. `SynthesisContext.reportVerify` was spread away in jev-only (`engine.ts`, the
 *     `this.mode === 'jev-only' ? {} : {…}` block), so `ctx.reportVerify?.(…)` was `undefined?.(…)` — the
 *     synthesizer's counters went nowhere at all;
 *  2. even with the channel open, the record writer was gated on `llm-jev` + `proposer === 'synth'`, and
 *     jev-only leaves `proposer` null.
 *
 * So `JEVCODE_WARM=on --mode jev-only` reproduced exactly the silent no-op that `unsupported-runner` /
 * `unsupported-command` (src/synth/sieve/runner.ts, `warmPlaneFor`) exists to kill: the flag asked for a plane the
 * oracle has no shape for, the step recorded nothing, and no artefact said so.
 *
 * `generate` stays gated — jev-only has no LLM channel and must never acquire one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { createFakeSandbox, intentIs, makeEngine, passingTests } from './fakes.js';
import type { StepWarmSummary, SynthesisContext, Synthesizer } from '../../../src/core/types.js';
import { createNullProvider } from '../../../src/provider/null.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

/** What `warmPlaneFor` records when `JEVCODE_WARM=on` meets an oracle with no warm shape (`emptyStepWarm`). */
const UNSUPPORTED: StepWarmSummary = {
  mode: 'unsupported-runner',
  offered: 0,
  screened: 0,
  confirmed: 0,
  mismatches: 0,
  fallbacks: 0,
  restarts: 0,
  invalidations: 0,
  scopeUnusable: 0,
  deadlineRechecks: 0,
  screenMs: 0,
  confirmMs: 0,
};

/** A jev-only synthesizer that reports the warm summary and then finishes the run in one step. */
function reportingSynthesizer(counts: Parameters<NonNullable<SynthesisContext['reportVerify']>>[0]): Synthesizer & { contexts: SynthesisContext[] } {
  const contexts: SynthesisContext[] = [];
  return {
    name: 'warm-reporting',
    contexts,
    async synthesize(ctx) {
      contexts.push(ctx);
      ctx.reportVerify?.(counts);
      return { goal: 'finish', action: { kind: 'done', summary: 'nothing left' }, plan: { done: ['fix f'], remaining: [], openProblems: [] }, rawText: '' };
    },
  };
}

describe('F04 — the verify block is written wherever a synthesizer reported one', () => {
  it('jev-only: `reportVerify` is installed and a reported `warm.mode: unsupported-runner` reaches StepRecord.verify.warm', async () => {
    const synth = reportingSynthesizer({ warm: UNSUPPORTED });
    const h = await build({
      mode: 'jev-only',
      synthesizer: synth,
      provider: Object.assign(createNullProvider(), { requests: [] }),
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [intentIs('finish', 1)] },
      limits: { maxSteps: 1 },
    });
    await h.engine.run();

    // (a) the channel exists in jev-only — it is the ONE thing the mode gate must not take away
    expect(typeof synth.contexts[0]!.reportVerify).toBe('function');
    // and the LLM channel still does not: jev-only never reaches a generating model
    expect(synth.contexts[0]!.generate).toBeUndefined();

    // (b) the report reaches the record, so `--archive-runs` can count the tasks a warm A/B really covered
    const rec = h.store.steps[0]!;
    expect(rec.verify?.warm).toEqual(UNSUPPORTED);
    expect(rec.verify?.warm?.mode).toBe('unsupported-runner');
    // the engine's own tallies are there too, zeroed: jev-only fires no samples
    expect(rec.verify).toMatchObject({ samples: 0, malformed: 0, timeouts: 0, cancelled: 0 });
    // and the whole record still round-trips as JSON, which is what steps.jsonl is
    expect((JSON.parse(JSON.stringify(rec)) as { verify?: { warm?: unknown } }).verify?.warm).toEqual(UNSUPPORTED);
  });

  it('jev-only: a synthesizer that reports nothing writes no `verify` member at all (contract 1.9 optionality)', async () => {
    const quiet: Synthesizer = {
      name: 'quiet',
      async synthesize() {
        return { goal: 'finish', action: { kind: 'done', summary: 'nothing left' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' };
      },
    };
    const h = await build({
      mode: 'jev-only',
      synthesizer: quiet,
      provider: Object.assign(createNullProvider(), { requests: [] }),
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [intentIs('finish', 1)] },
      limits: { maxSteps: 1 },
    });
    await h.engine.run();
    expect('verify' in h.store.steps[0]!).toBe(false);
  });

  it('jev-only: an empty report still opens the block — `reportVerify({})` is a report', async () => {
    const synth = reportingSynthesizer({});
    const h = await build({
      mode: 'jev-only',
      synthesizer: synth,
      provider: Object.assign(createNullProvider(), { requests: [] }),
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [intentIs('finish', 1)] },
      limits: { maxSteps: 1 },
    });
    await h.engine.run();
    expect(h.store.steps[0]!.verify).toMatchObject({ samples: 0, distinct: 0, localisationMissed: false });
    expect(h.store.steps[0]!.verify?.warm).toBeUndefined();
  });
});
