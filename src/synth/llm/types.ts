/**
 * Types local to the LLM candidate source (docs/LLM-JEV-DESIGN.md §4). The generator contract —
 * `SynthesisContext.generate`, `SampleOptions`, `GeneratePurpose`, `GenerateRequest.seed / reasoning /
 * providerPrefs`, `GenerateResult.generationId`, `TokenUsage.reasoningTokens / estimated` (§4.8, §4.12,
 * §9.3) — lives in src/core/types.ts and is imported from there; nothing here restates it. `'llm'` is a
 * `CandidateSourceName` and `Site.span?` the block-anchored span (src/synth/types.ts); `LlmCandidate` /
 * `LlmSite` are the narrowed forms the source produces.
 */
import type { GenerateReasoning, SynthesisContext } from '../../core/types.js';
import type { Candidate, Site } from '../types.js';

/** `SynthesisContext.generate` as the contract states it (per-sample signal; the engine meters and records), made required. */
export type GenerateFn = NonNullable<SynthesisContext['generate']>;

/** True when the request asks for reasoning tokens — the `max_tokens` cap then rises to `LLM_MAX_TOKENS_REASONING` (§4.5). */
export function reasoningEnabled(r: GenerateReasoning | undefined): boolean {
  return r !== undefined && 'effort' in r;
}

/** The LLM's `CandidateSourceName`. */
export const LLM_SOURCE_NAME: Extract<Candidate['source'], 'llm'> = 'llm';
export type LlmSourceName = typeof LLM_SOURCE_NAME;

/** Block-anchored span of an LLM site (`Site.span`): validated by text hash, never by the one-statement tokenizer check (§4.7 step 3). */
export type LlmSpan = NonNullable<Site['span']>;

export type LlmSite = Site & { span: LlmSpan };

/** A `Candidate` whose source is the LLM and whose site carries a hashed span. */
export type LlmCandidate = Candidate & { source: LlmSourceName; site: LlmSite };

/** Oracle class the round schedule keys on (§4.6). */
export type OracleClass = 'quixbugs' | 'ladder' | 'repository';
