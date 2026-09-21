/**
 * Local copy of the llm-jev contract this module codes against (docs/LLM-JEV-DESIGN.md §9.3).
 * Stage 1 adds the same shapes to src/core/types.ts (`SynthesisContext.generate`, the optional
 * `GenerateRequest` / `GenerateResult` / `TokenUsage` fields); until the merge they are declared
 * here structurally identical, so the wiring stage can swap the import without a code change.
 *
 * TODO(stage 4, src/synth/types.ts): `CandidateSourceName += 'llm'` and `Site.span?` — until then
 * `LlmCandidate` / `LlmSite` are the structural extensions below.
 */
import type { GenerateRequest, GenerateResult, TokenUsage } from '../../core/types.js';
import type { Candidate, Site } from '../types.js';

export type GeneratePurpose = 'propose_fix' | 'write_reproduction';

export interface SampleOptions {
  sample: number;
  purpose: GeneratePurpose;
  signal: AbortSignal;
}

/** `GenerateRequest.reasoning` exactly as §4.12 states it: off (the default), or on at a bounded effort (the §10.2 fallback). */
export type LlmReasoning = { enabled: false } | { effort: 'low' | 'medium' };

/** `GenerateRequest.providerPrefs` exactly as §4.12 states it (`provider: {require_parameters}`). */
export interface LlmProviderPrefs {
  requireParameters: boolean;
}

/** True when the request asks for reasoning tokens — the `max_tokens` cap then rises to `LLM_MAX_TOKENS_REASONING` (§4.5). */
export function reasoningEnabled(r: LlmReasoning | undefined): boolean {
  return r !== undefined && 'effort' in r;
}

/** `GenerateRequest` plus the fields §4.12 maps onto the OpenRouter body (`seed`, `reasoning`, `provider.require_parameters`). */
export interface LlmGenerateRequest extends GenerateRequest {
  seed?: number;
  reasoning?: LlmReasoning;
  providerPrefs?: LlmProviderPrefs;
}

/** `TokenUsage` plus the reasoning-token count and the "this is an estimate" flag of a cancelled sample (§4.8). */
export interface LlmTokenUsage extends TokenUsage {
  reasoningTokens?: number;
  estimated?: boolean;
}

export interface LlmGenerateResult extends GenerateResult {
  /** the provider's generation id, so a cancelled sample's estimate can be reconciled post hoc */
  generationId?: string;
}

/** `SynthesisContext.generate` as the contract states it (per-sample signal; the engine meters and records). */
export type GenerateFn = (req: LlmGenerateRequest, o: SampleOptions) => Promise<LlmGenerateResult>;

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
