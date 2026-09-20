/**
 * The generator that must never be called. In `jev-only` mode the engine's propose stage is a
 * Synthesizer (code proposes, Jev decides); this provider exists so the Provider slot is filled
 * and any accidental generate() call fails loudly and is counted by the bench as a violation.
 */
import type { GenerateOptions, GenerateRequest, GenerateResult, Provider } from '../core/types.js';
import { ProviderError } from '../errors.js';

export class NullProviderCalledError extends ProviderError {
  constructor() {
    super('provider_http', 'jev-only mode: the generating LLM was called; this is a bug in the synthesizer wiring');
  }
}

export function createNullProvider(): Provider & { readonly calls: number } {
  let calls = 0;
  return {
    name: 'mock',
    model: 'none (jev-only)',
    get calls() {
      return calls;
    },
    generate(_req: GenerateRequest, _opts: GenerateOptions): Promise<GenerateResult> {
      calls += 1;
      return Promise.reject(new NullProviderCalledError());
    },
  };
}
