/**
 * Contract shapes of the generator's context policy (docs/COORDINATION-DESIGN.md §8, §12.0.3), declared LOCALLY until
 * `src/core/types.ts` is free after the TUI round-3 hash. Every shape here is structurally identical to the design's; the
 * move to core/types.ts (under the `// contract 1.4` header) is a cut-and-paste with no renames. Nothing in this file is
 * runtime code.
 *
 *   ContextUsage, ContextCompactedEvent          §12.0.3 (b), §8.6 — the meter and the compaction event
 *   HistoryEntry                                 §8.3 — `CheckpointState.history?: HistoryEntry[]` ≤ 12
 *   FileCacheEntry, FileMemory                   §8.4 — `CheckpointState.fileCache?` ≤ 16, `.fileMemory?` ≤ 64
 *   ContextSummary                               §8.6 — `<runDir>/context/summary.json`; `CheckpointState.summaryAt?`
 *   ContextCheckpointExtension                   the six optional CheckpointState additions (incl. `compactions?`, `lastCompactionAt?`)
 *   ContextPolicyOptions                         §12.0.1 `EngineOptions.contextPolicy?`
 *   EngineStatusWithContext                      §12.0.3 `EngineStatus.context?: ContextUsage`
 */
import type { CheckpointState, EngineOptions, EngineStatus, WindowEntry } from '../../core/types.js';

/** §8.6: the compactor in force (`context.compaction`, default `code`). */
export type CompactionMode = 'code' | 'llm' | 'off';

/** §12.0.3 (b): `EngineStatus.context?` — the object the meter renders (`ctx 41% · 6 files · 12 steps`). */
export interface ContextUsage {
  // §8.7 (kept)
  promptChars: number;
  budgetChars: number;
  pct: number;
  files: number;
  historyEntries: number;
  summaryAt: number | null;
  lastCompactionStep: number | null;
  // agreed names (additive): the same facts in tokens, plus the counters the meter shows
  /** round(promptChars / CHARS_PER_TOKEN) with CHARS_PER_TOKEN = 3.4 (§8.2) — an estimate; the generator's tokenizer is never called */
  tokensInWindow: number;
  /**
   * The PROMPT BUDGET in tokens: round(budgetChars / CHARS_PER_TOKEN) = 0.55 × windowTokens (§8.2), so
   * pct === round(100 × tokensInWindow / budgetTokens). Review finding 51: the meter is a share of the budget, not of the
   * model's window, and the names now say so.
   */
  budgetTokens: number;
  /** the model's context window in tokens (`generatorContextTokens`, §8.2) — what `/context` shows beside the budget */
  windowTokens: number;
  /** compactions over the run's life, all resumes; persisted as CheckpointState.compactions? (additive) */
  compactions: number;
  /** ISO time of the last compaction, null before any; persisted as CheckpointState.lastCompactionAt? (additive) */
  lastCompactionAt: string | null;
  /** §8.6: the compactor in force */
  compaction: CompactionMode;
  /** §8.2: which term bound `budgetChars` — `/context` prints it (`budget 96k chars — capped by the $2.00 run cap …`) */
  budgetBoundBy: 'window' | 'money' | 'floor' | 'ceiling';
  /** §8.2: estimated generator input $ per step at this budget, null when the generator is unpriced */
  usdPerStep: number | null;
  /** §8.2 / review D8: the budget was clamped to the model's window because the window is smaller than the floor */
  windowTooSmall: boolean;
  /** §8.2(c): the `/context` recent-steps line — `recent steps 71k of 71k (2 whole, 4 clipped, 6 one-line)` */
  recentSteps: RecentStepsUsage;
  /** §8.9: how long the last prompt build took (ms), and the file refresh inside it — the `promptBuildMs` gate's source */
  promptBuildMs: number;
  refreshMs: number;
}

/** §8.2(c): what the tier ladder did to the history at the last build. */
export interface RecentStepsUsage {
  chars: number;
  allowanceChars: number;
  whole: number;
  clipped: number;
  oneLine: number;
  /** output files opened for this build (§8.3: ≤ 6, in practice 2–3 warm) */
  reads: number;
}

/** §8.6 / §12.0.4: `EngineEvent` member `context:compacted`; carried in a `notice` (kind `ui`, label `[jevcode]`, `detail` = this JSON) until the core union gains it. */
export interface ContextCompactedEvent {
  type: 'context:compacted';
  step: number;
  /** persisted history + summary chars before → after the fold */
  chars: { before: number; after: number };
  by: 'code' | 'llm';
}

/** §8.3: a WindowEntry (600-char body) plus the pointer to the whole output on disk. */
export interface HistoryEntry extends WindowEntry {
  /** `outputs/step-<n>.txt` under the run dir when the output was longer than the 600-char body */
  outputRef?: string;
  /** length of the whole output text (what the file holds, before its own 1 MiB cap) */
  fullOutputChars?: number;
  /** §8.5 / review D12: the per-run 64 MiB bound deleted `outputRef` mid-run — the pointer must not be printed again */
  outputEvicted?: boolean;
}

/** §8.4: why a path is in view; eviction keeps human > jev > seed > edit > read. */
export type FilePin = 'read' | 'edit' | 'human' | 'jev' | 'seed';

/** §8.4: one file the generator keeps in view (`CheckpointState.fileCache?` ≤ 16). */
export interface FileCacheEntry {
  rel: string;
  pinnedBy: FilePin;
  lastUsedStep: number;
  /** chars of the file shown at the last prompt build (0 before the first) */
  bytesShown: number;
}

/** §8.4: what the run knows about a path's content (`CheckpointState.fileMemory?` ≤ 64 entries). */
export interface FileMemoryEntry {
  /** first 12 hex of the file's sha256 (post-image hash for edits; the raw file hash at load for reads); null until hashed */
  sha12: string | null;
  bytes: number;
  readAt: number | null;
  editedAt: number | null;
}
export type FileMemory = Record<string, FileMemoryEntry>;

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

/** The optional CheckpointState fields of §8.3, §8.4, §8.6 and §12.0.3; absent on runs written before this landed. */
export interface ContextCheckpointExtension {
  history?: HistoryEntry[];
  fileCache?: FileCacheEntry[];
  fileMemory?: FileMemory;
  summaryAt?: number | null;
  compactions?: number;
  lastCompactionAt?: string | null;
}
export type CheckpointStateWithContext = CheckpointState & ContextCheckpointExtension;

/**
 * §12.0.1: `EngineOptions.contextPolicy?`.
 *
 * `view` is the one member the design does not list: review finding 28 ("everything degrades to today" is false for the
 * context policy — `compaction: 'off'` disables only compaction) asked for a setting that yields HEAD's prompt, which is
 * what the bench baselines were measured against. `'legacy'` sends no context view at all, so `buildPrompt` takes the
 * byte-identical pre-§8 path and no `outputs/` file, file cache or compaction runs.
 */
export interface ContextPolicyOptions {
  /** default `'relaxed'`; `'legacy'` is HEAD's prompt, byte for byte (review finding 28) */
  view?: 'relaxed' | 'legacy';
  /** §8.2: the model's context window in tokens; absent → the pricing table's `contextTokens` (§14 Q4), else 128k */
  windowTokens?: number;
  historySteps?: number;
  fileCacheBytes?: number;
  /** 0 disables the interval trigger */
  compactEvery?: number;
  compaction?: CompactionMode;
  budgetChars?: number;
}

/**
 * §12.0.1: `EngineOptions.contextPolicy?` — read through this subtype until `src/core/types.ts` gains the member, so a caller
 * that passes the option today (bench pins, the perf drivers) type-checks against the same shape the move will declare.
 */
export type EngineOptionsWithContextPolicy = EngineOptions & { contextPolicy?: ContextPolicyOptions };

/**
 * §12.0.3: `EngineStatus.context?: ContextUsage` — the engine returns this subtype from `status()`. Optional because the
 * modes that build no relaxed prompt (`jev-only`, and `llm-jev` until §8.8 column 3 exists) and the `view: 'legacy'` pin
 * carry no meter at all rather than one stuck at 0 % (review D5/D18).
 */
export type EngineStatusWithContext = EngineStatus & { context?: ContextUsage };

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
