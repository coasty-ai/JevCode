/**
 * Row and status text for a model picker: one formatter per thing the picker shows, so both
 * renderers (Ink and plain) print the same words and the words have tests.
 *
 * Nothing here decides layout or colour — it produces plain strings with `·` separators, the
 * separator the rest of the TUI already uses.
 */
import { keyEnvNames, providerDisplayName } from './providers.js';
import { formatPricing, formatTokens } from './pricing.js';
import type { Capability, ListResult, ModelInfo, ModelSupports, ModelsError, ProviderId } from './types.js';

/** Short badges for the capability flags. */
export const CAPABILITY_LABELS: Readonly<Record<Capability, string>> = {
  tools: 'tools',
  structuredOutput: 'json',
  reasoning: 'reasoning',
  vision: 'vision',
};

const CAPABILITY_ORDER: readonly Capability[] = ['tools', 'structuredOutput', 'reasoning', 'vision'];

/** "tools · json · reasoning" — only the flags known to be true; empty string when none are. */
export function capabilitySummary(supports: ModelSupports): string {
  return CAPABILITY_ORDER.filter((c) => supports[c] === true)
    .map((c) => CAPABILITY_LABELS[c])
    .join(' · ');
}

/** "1.3M ctx" / "1.3M ctx → 944k out" / "" when the window is unknown. */
export function contextSummary(model: ModelInfo): string {
  if (model.contextLength === undefined) return '';
  const ctx = `${formatTokens(model.contextLength)} ctx`;
  return model.maxOutput === undefined ? ctx : `${ctx} → ${formatTokens(model.maxOutput)} out`;
}

/**
 * One picker row: id, provider, window, price, capabilities — "z-ai/glm-5.3-flash · OpenRouter ·
 * 1.3M ctx → 944k out · $0.15/M in · $0.50/M out · tools · json · reasoning".
 */
export function modelSummary(model: ModelInfo): string {
  const parts = [model.id, providerDisplayName(model.provider)];
  const ctx = contextSummary(model);
  if (ctx !== '') parts.push(ctx);
  parts.push(formatPricing(model.pricing));
  const caps = capabilitySummary(model.supports);
  if (caps !== '') parts.push(caps);
  if (model.deprecated === true) parts.push('deprecated');
  return parts.join(' · ');
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now" / "12 min ago" / "3 h ago" / "2 d ago"; "unknown" for an unparseable stamp. */
export function relativeAge(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'unknown';
  const ms = Math.max(0, nowMs - at);
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min ago`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h ago`;
  return `${Math.round(ms / DAY)} d ago`;
}

/** "live" / "cached 3 h ago" / "bundled snapshot" — the picker's provenance hint. */
export function sourceLabel(result: ListResult, nowMs: number): string {
  switch (result.source) {
    case 'network':
      return 'live';
    case 'cache':
      return `cached ${relativeAge(result.fetchedAt, nowMs)}`;
    case 'static':
      return 'bundled snapshot';
  }
}

/**
 * One line of human copy for a catalogue failure, naming the env var when a key is missing. The
 * provider's own message is appended for the cases where it is the useful part.
 */
export function errorLabel(provider: ProviderId, error: ModelsError): string {
  const name = providerDisplayName(provider);
  switch (error.kind) {
    case 'no_key':
      return `${name}: no API key — set ${keyEnvNames(provider)[0] ?? 'the provider key'}`;
    case 'auth':
      return `${name}: key rejected (${error.status ?? 401})`;
    case 'rate_limit':
      return `${name}: rate limited — showing the last list`;
    case 'network':
      return `${name}: offline — showing the last list`;
    case 'invalid':
      return `${name}: unexpected catalogue response`;
    case 'http':
      return `${name}: catalogue request failed (HTTP ${error.status ?? 0})`;
  }
}

/** "7 providers · 512 models · 2 offline" for a picker header. */
export function catalogueSummary(results: readonly ListResult[]): string {
  const models = results.reduce((n, r) => n + r.models.length, 0);
  const degraded = results.filter((r) => r.error !== undefined).length;
  const parts = [`${results.length} provider${results.length === 1 ? '' : 's'}`, `${models} model${models === 1 ? '' : 's'}`];
  if (degraded > 0) parts.push(`${degraded} unavailable`);
  return parts.join(' · ');
}
