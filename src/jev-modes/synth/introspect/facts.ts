/**
 * Per-run harvested facts shared between the controller (which computes them once at the
 * establishing step: search/index.ts initRepository) and the candidate sources wired in
 * src/jev-modes/synth/index.ts (which read them at enumeration time, where no run memory is in reach:
 * `CandidateSource.enumerate(site, opts)` carries only the site and the options). A registry
 * keyed by run id, like search/memory.ts `getMemory(runId)`; bounded, cleared per run.
 */
import type { HistoryFacts } from '../history/types.js';
import type { IntrospectedNames } from './types.js';

export interface RunFacts {
  introspected: IntrospectedNames | null;
  history: HistoryFacts | null;
}

/** Runs whose facts are kept at once (a bench process may drive several runs; an engine process one). */
export const RUN_FACTS_MAX = 8;

const registry = new Map<string, RunFacts>();

/** Record (or extend) the facts of a run; the oldest run's facts are dropped past RUN_FACTS_MAX. */
export function setRunFacts(runId: string, partial: Partial<RunFacts>): RunFacts {
  const cur = registry.get(runId) ?? { introspected: null, history: null };
  const next: RunFacts = { introspected: partial.introspected === undefined ? cur.introspected : partial.introspected, history: partial.history === undefined ? cur.history : partial.history };
  registry.delete(runId);
  registry.set(runId, next);
  while (registry.size > RUN_FACTS_MAX) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
  return next;
}

export function runFacts(runId: string): RunFacts | null {
  return registry.get(runId) ?? null;
}

export function clearRunFacts(runId: string): void {
  registry.delete(runId);
}
