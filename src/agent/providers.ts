/**
 * Per-provider capabilities of the agent loop (docs/AGENT-LOOP-DESIGN.md §6.3, §7.3, §A4): whether reasoning is bound to
 * the prompt prefix (and so which masking mode is safe), and the request settings that stay constant for the session.
 */
import type { GenerateReasoning, ProviderName } from '../core/types.js';
import { PROVIDER_DISPLAY_NAME, isProviderId } from '../provider/ids.js';

/**
 * §7.3: `client` masks stale tool results in the transcript; `server` asks Anthropic's API to clear them (context
 * editing does not count as a prefix edit); `off` leaves them — a Claude model behind another adapter binds its thinking to
 * the prefix, and no adapter but Anthropic's can send context editing.
 */
export type MaskingMode = 'client' | 'server' | 'off';

/** Claude models, whatever adapter serves them (`claude-sonnet-5`, `anthropic/claude-sonnet-5`). */
export function isClaudeModel(model: string): boolean {
  const id = model.toLowerCase();
  return id.startsWith('anthropic/') || id.slice(id.lastIndexOf('/') + 1).startsWith('claude');
}

export function maskingModeFor(provider: ProviderName, model: string): MaskingMode {
  if (provider === 'anthropic') return 'server';
  return isClaudeModel(model) ? 'off' : 'client';
}

/**
 * §6.3: the reasoning setting of every agent turn. Anthropic gets effort `high` (the Claude reference's minimum for
 * intelligence-sensitive work; thinking can never be disabled on Opus 5.5 / Fable 5.1). Every other provider gets `low`:
 * reasoning is mandatory on OpenRouter's GLM (`enabled:false` is a 400) and low keeps turns fast.
 */
export function agentReasoning(provider: ProviderName): GenerateReasoning {
  return provider === 'anthropic' ? { effort: 'high' } : { effort: 'low' };
}

/**
 * §A4: the effort a first turn is sent at when RA0 reads the message as conversational — the provider's low effort, or
 * null where the adapter has no effort control (the mock). RA0 is asked only when this differs from `agentReasoning`:
 * a hint that cannot change the request is not worth a paid ask in front of the first token.
 */
export function lowEffortReasoning(provider: ProviderName): GenerateReasoning | null {
  if (provider === 'mock') return null;
  return { effort: 'low' };
}

/** §6.3: the temperature sent. Anthropic takes none (non-default values are a 400); OpenAI's adapter drops it itself. */
export function agentTemperature(provider: ProviderName, configured: number | null): number | null {
  return provider === 'anthropic' ? null : configured;
}

/** The provider's display name for the identity header (`OpenRouter`); the mock names itself. */
export function providerLabel(provider: ProviderName): string {
  return isProviderId(provider) ? PROVIDER_DISPLAY_NAME[provider] : provider;
}

export function sameReasoning(a: GenerateReasoning, b: GenerateReasoning | null): boolean {
  return b !== null && JSON.stringify(a) === JSON.stringify(b);
}
