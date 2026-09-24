/**
 * Synth stage (docs/JEV-ONLY.md): the jev-only replacement for the propose stage. The
 * Synthesizer produces one Proposal from code search and Jev decisions, never from a
 * generating LLM. The engine emits no `generator:*` events and writes no generator.jsonl row
 * for it; progress arrives as `synth` events through `ctx.emit` (one transcript line each).
 * A throw from `synthesize()` is a stage failure at 'propose' (§6 stage failure policy).
 */
import type { Proposal, SynthesisContext, Synthesizer } from '../../core/types.js';
import type { StageContext } from '../../loop/engine.js';

export interface SynthStageResult {
  proposal: Proposal;
  /** Synthesizer.name, for the step transcript and tests */
  synthesizer: string;
}

export async function runSynthStage(ctx: StageContext, synthesizer: Synthesizer, sctx: SynthesisContext): Promise<SynthStageResult> {
  const out = await synthesizer.synthesize(sctx);
  // Code-produced, so the shape is trusted; rawText is the only free text and is redacted like a generator reply.
  const proposal: Proposal = {
    goal: out.goal,
    action: out.action,
    plan: { done: [...out.plan.done], remaining: [...out.plan.remaining], openProblems: [...out.plan.openProblems] },
    rawText: ctx.redact(out.rawText),
  };
  // The synthesizer's code-computed shadow-run evidence (docs/JEV-ONLY-DESIGN.md §5.1) travels with
  // the proposal to the risk and judge states (loop/state.ts proposalJson); a generator never sets it.
  if (out.evidence !== undefined) proposal.evidence = out.evidence;
  ctx.emit({ type: 'proposal', step: ctx.step, proposal });
  return { proposal, synthesizer: synthesizer.name };
}
