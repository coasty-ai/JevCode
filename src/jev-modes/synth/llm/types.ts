/**
 * Types local to the LLM candidate source (docs/LLM-JEV-DESIGN.md §4). The generator contract —
 * `SynthesisContext.generate`, `SampleOptions`, `GeneratePurpose`, `GenerateRequest.seed / reasoning /
 * providerPrefs`, `GenerateResult.generationId`, `TokenUsage.reasoningTokens / estimated` (§4.8, §4.12,
 * §9.3) — lives in src/core/types.ts and is imported from there; nothing here restates it. `'llm'` is a
 * `CandidateSourceName` and `Site.span?` the block-anchored span (src/jev-modes/synth/types.ts); `LlmCandidate` /
 * `LlmSite` are the narrowed forms the source produces.
 */
import type { GenerateReasoning, GenerateRequest, GenerateResult, SampleOptions } from '../../../core/types.js';
import type { Candidate, Site } from '../types.js';

/**
 * The options one sample is dispatched with. Both per-sample callbacks — the §4.8 / §4.13 cancellation facts
 * (`onCancelled`, so a sample aborted after its response headers is booked from what it streamed rather than from
 * `max_tokens`) and the §3.1 first byte (`onFirstByte`, the §3.2 hedge's only input) — are members of `SampleOptions`
 * itself as of contract 1.9 (Fastlane), and `src/loop/engine.ts` forwards both into `GenerateOptions`. The alias stays
 * because the source's own `GenerateFn` is narrower than the contract's (the function is required, not optional).
 */
export type SampleGenerateOptions = SampleOptions;

/** `SynthesisContext.generate` as the contract states it (per-sample signal; the engine meters and records), made required, with the cancellation facts. */
export type GenerateFn = (req: GenerateRequest, o: SampleGenerateOptions) => Promise<GenerateResult>;

/**
 * True when the request asks for reasoning tokens — the `max_tokens` cap then rises to `LLM_MAX_TOKENS_REASONING` (§4.5).
 * Every `GenerateReasoning` variant but `{enabled: false}` does: `{effort}` and the additive `{maxTokens}` (OpenRouter's
 * `reasoning.max_tokens`, a thinking budget) both have the model think before it answers, so both imply the reasoning-on
 * base; unsent (undefined) leaves the model's default and the plain base.
 */
export function reasoningEnabled(r: GenerateReasoning | undefined): boolean {
  return r !== undefined && !('enabled' in r);
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
