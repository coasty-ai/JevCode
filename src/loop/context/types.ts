/**
 * Module-internal shapes of the generator's context policy (docs/COORDINATION-DESIGN.md §8).
 *
 * The CONTRACT shapes — `ContextUsage`, `RecentStepsUsage`, `CompactionMode`, `HistoryEntry`, `FilePin`,
 * `FileCacheEntry`, `FileMemoryEntry`, `FileMemory`, `ContextPolicyOptions`, the `context:compacted` event and the
 * `CheckpointState` / `CheckpointStore` / `EngineOptions` / `EngineStatus` / `SynthesisContext` / `Engine` members —
 * moved to `src/core/types.ts` under the `// contract 1.4` header once the TUI round-3 line landed (that move was a
 * cut-and-paste with no renames). They are imported from there and declared nowhere else. What stays here is the
 * on-disk summary shape and the execute stage's read hooks, which no other owner consumes.
 */

export type SummarySection = 'Objective' | 'Completed' | 'Active' | 'Blocked' | 'Files' | 'Tests' | 'Notes';

/** §8.6: `<runDir>/context/summary.json` — the rolling summary; `text` is what the prompt shows (≤ 3 KiB). */
export interface ContextSummary {
  v: 1;
  /** the step whose commit produced it (`CheckpointState.summaryAt`) */
  step: number;
  at: string;
  by: 'code' | 'llm';
  sections: Record<SummarySection, string[]>;
  text: string;
}

/**
 * §8.3 / §8.4 (W2 item 21): what the execute stage asks the context policy before a `read` — `StageContext.contextReads?`
 * (optional, so fakes and the synth modes are untouched).
 */
export interface ContextReadHooks {
  /**
   * The §8.4 zero-cost read: the output line when `rel` was rendered WHOLE in the last prompt build and is unchanged
   * (one stat, no workspace read). Null in every other case — including a path the build omitted or showed as a window
   * — so the read runs normally (reviews D1/D2/D3).
   */
  unchanged(rel: string): Promise<string | null>;
  /**
   * §8.4 / review D1: `rel` is in view but shown as a `[lines a–b of N]` window — serve the NEXT window instead of the
   * same head again, so the tail of a big file is reachable. Null when the path is not in view or is shown whole.
   */
  nextWindow(rel: string): Promise<string | null>;
  /** the `jevcode:outputs/step-<n>.txt` pseudo-path: the stored whole output, or null when none is on disk */
  runOutput(pathOrRef: string): Promise<string | null>;
}
