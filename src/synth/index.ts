/**
 * Jev-only synthesizer entry point (docs/JEV-ONLY.md). In `jev-only` mode the engine's
 * propose stage calls `synthesize(ctx)` instead of the generator: `ctx.ask` / `ctx.decider`
 * route every Jev question through the engine (metered, jev.jsonl, decisions.jsonl, the
 * pane, the REPORT question rules) and `ctx.emit` reports progress as `synth` events (one
 * transcript line each). Tests, not Jev, are the oracle: the returned Proposal goes through
 * risk, execute and judge like any generator proposal.
 *
 * This is the placeholder that wires the mode end to end: it emits one `synth` event and
 * proposes `done`. The candidate sources and the search (mutation operators, fix templates,
 * donor code, test-derived values) replace it under this directory.
 */
import type { Decider, Proposal, SynthesisContext, Synthesizer } from '../core/types.js';

export const NOT_IMPLEMENTED_SUMMARY = 'jev-only synthesizer not implemented';

export interface SynthesizerOptions {
  /** the run's decider; prefer `ctx.ask` inside synthesize() so usage and decisions are recorded */
  decider: Decider;
  redact: (s: string) => string;
}

export function createSynthesizer(_opts: SynthesizerOptions): Synthesizer {
  return {
    name: 'placeholder',
    async synthesize(ctx: SynthesisContext): Promise<Proposal> {
      ctx.emit({ type: 'synth', step: ctx.step, phase: 'placeholder', detail: NOT_IMPLEMENTED_SUMMARY, candidates: 0, tested: 0 });
      return {
        goal: NOT_IMPLEMENTED_SUMMARY,
        action: { kind: 'done', summary: NOT_IMPLEMENTED_SUMMARY },
        plan: { done: [], remaining: [...ctx.plan.remaining], openProblems: [NOT_IMPLEMENTED_SUMMARY] },
        rawText: '',
      };
    },
  };
}
