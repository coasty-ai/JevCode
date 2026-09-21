/**
 * The LLM candidate source of the llm-jev mode (docs/LLM-JEV-DESIGN.md §4): schema (the forced
 * tools), prompt (bounded sections, listing set, hints), candidates (anchoring, block-anchored
 * sites, dry-run apply, compile check, dedupe, attempt ledger), source (staggered rounds with
 * deadlines, per-sample cancellation, awaitable arrivals, accounting, cache), rank (Q17 order
 * only) and repro (the L2 reproduction writer). Wired into the search by stage 4 through
 * `SubGoalDeps.llm?` when `SynthesisContext.generate` exists.
 */
export * from './types.js';
export * from './schema.js';
export * from './prompt.js';
export * from './candidates.js';
export * from './source.js';
export * from './rank.js';
export * from './repro.js';
