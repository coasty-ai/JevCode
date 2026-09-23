/** Shared fixtures for the round-5 model picker tests (TUI-DESIGN-5 §10 R5-6). Offline, no clock, no I/O. */
import * as models from '../../../../src/models/index.js';
import type { ListResult, ModelInfo, ModelsError, ProviderId } from '../../../../src/models/types.js';
import type { ModelsApi } from '../../../../src/tui/models/lines.js';

/**
 * §6.2 / §13.1: the compile-time proof that the seam and `src/models/index.ts` have not drifted. If
 * `modelSummary`, `sourceLabel`, `errorLabel`, `catalogueSummary`, `rankModels`… ever change shape this assignment
 * stops compiling, which is the whole reason the picker takes them as a value instead of importing them.
 */
export const API: ModelsApi = { ...models, rank: models.rankModels };

export function model(id: string, provider: ProviderId, over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    provider,
    displayName: id,
    contextLength: 1_310_720,
    maxOutput: 944_000,
    pricing: { inputPerM: 0.15, outputPerM: 0.5 },
    supports: { tools: true, structuredOutput: true, reasoning: true },
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...over,
  };
}

export function result(provider: ProviderId, rows: readonly ModelInfo[], over: Partial<ListResult> = {}): ListResult {
  return { provider, models: rows, source: 'network', fetchedAt: '2026-09-22T10:00:00.000Z', stale: false, ...over };
}

export function err(kind: ModelsError['kind'], status: number | null = null): ModelsError {
  return { kind, status, message: `${kind}`, retryable: kind === 'rate_limit' || kind === 'network' };
}
