/**
 * Types local to the LLM candidate source (docs/LLM-JEV-DESIGN.md §4). The generator contract —
 * `SynthesisContext.generate`, `SampleOptions`, `GeneratePurpose`, `GenerateRequest.seed / reasoning /
 * providerPrefs`, `GenerateResult.generationId`, `TokenUsage.reasoningTokens / estimated` (§4.8, §4.12,
 * §9.3) — lives in src/core/types.ts and is imported from there; nothing here restates it.
 *
 * TODO(stage 4, src/synth/types.ts): `CandidateSourceName += 'llm'` and `Site.span?` — until then
 * `LlmCandidate` / `LlmSite` are the structural extensions below.
 */
import type { GenerateReasoning, SynthesisContext } from '../../core/types.js';
import type { Candidate, Site } from '../types.js';

/** `SynthesisContext.generate` as the contract states it (per-sample signal; the engine meters and records), made required. */
export type GenerateFn = NonNullable<SynthesisContext['generate']>;

/** True when the request asks for reasoning tokens — the `max_tokens` cap then rises to `LLM_MAX_TOKENS_REASONING` (§4.5). */
export function reasoningEnabled(r: GenerateReasoning | undefined): boolean {
  return r !== undefined && 'effort' in r;
}

/** The source name the wiring stage adds to `CandidateSourceName`. */
export const LLM_SOURCE_NAME = 'llm';
export type LlmSourceName = typeof LLM_SOURCE_NAME;

/** Block-anchored span of an LLM site: validated by text hash, never by the one-statement tokenizer check (§4.7 step 3). */
export interface LlmSpan {
  endLine: number;
  textSha: string;
}

export type LlmSite = Site & { span: LlmSpan };

/** A `Candidate` whose source is the LLM and whose site carries a hashed span. Assignable to `Candidate` once `'llm'` joins the union. */
export type LlmCandidate = Omit<Candidate, 'source' | 'site'> & { source: LlmSourceName; site: LlmSite };

/** Oracle class the round schedule keys on (§4.6). */
export type OracleClass = 'quixbugs' | 'ladder' | 'repository';
