/**
 * Checkpoint-side shapes of the context policy (docs/COORDINATION-DESIGN.md §8.3, §8.6, W2 item 20), declared locally until
 * `src/core/types.ts` is free after the TUI round-3 hash. The state additions live in `src/loop/context/types.ts` (one home
 * for the contract shapes) and are re-exported here for the store's callers; the store widening below is the harness's own
 * (`CheckpointStore.writeOutput` / `readOutput` / `writeContextSummary` on the per-file chains — W2 item 20).
 */
import { isFiniteNumber, isJsonArray, isJsonObject, isString, isStringArray } from '../core/json.js';
import { boundMemory } from '../loop/context/context-cache.js';
import { outputRefFor, parseOutputRef } from '../loop/context/history.js';
import { FILE_CACHE_MAX_ENTRIES } from '../loop/context/limits.js';
import type { CheckpointState, CheckpointStore, Json, WindowEntry } from '../core/types.js';
import type { ContextCheckpointExtension, FileCacheEntry, FileMemory, FilePin, HistoryEntry } from '../loop/context/types.js';
import { normaliseRelPath } from './images.js';

export type { CheckpointStateWithContext, ContextCheckpointExtension } from '../loop/context/types.js';

/** The store methods the context policy needs; optional on the contract so injected fakes keep type-checking (`hasContextStore`). */
export interface ContextStoreExtension {
  /** `<runDir>/outputs/step-<n>.txt`: the whole (redacted) output of a step, ≤ 1 MiB (head + tail with a marker), 64 MiB per run then oldest deleted */
  writeOutput(step: number, text: string): Promise<void>;
  /** the stored output of a step; null when none was written (or it was deleted by the per-run bound) */
  readOutput(step: number): Promise<string | null>;
  /** `<runDir>/context/summary.json`: the rolling summary, redacted, atomic */
  writeContextSummary(summary: Json): Promise<void>;
  /** the stored summary; null when absent or unusable */
  readContextSummary(): Promise<Json | null>;
}

export type CheckpointStoreWithContext = CheckpointStore & ContextStoreExtension;

/** True when the store carries the context-policy methods (the disk store does; in-memory fakes may not). */
export function hasContextStore(store: CheckpointStore): store is CheckpointStoreWithContext {
  const s = store as Partial<ContextStoreExtension>;
  return typeof s.writeOutput === 'function' && typeof s.readOutput === 'function' && typeof s.writeContextSummary === 'function' && typeof s.readContextSummary === 'function';
}

// ---------------------------------------------------------------------------------------
// Reading the additions back (§9.3, §10: a checkpoint is untrusted input — a mirrored or
// hand-edited state.json must not put a wrong shape into the prompt builder)
// ---------------------------------------------------------------------------------------

/** Only the members the prompt builder dereferences are required; the rest of a WindowEntry is carried as written. */
function readHistoryEntry(v: unknown): HistoryEntry | null {
  if (!isJsonObject(v)) return null;
  const step = v['step'];
  const action = v['action'];
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 1 || typeof action !== 'string') return null;
  const outcome = v['outcome'];
  const e: HistoryEntry = {
    step,
    action,
    intent: typeof v['intent'] === 'string' ? (v['intent'] as WindowEntry['intent']) : null,
    outcome: typeof outcome === 'string' ? (outcome as WindowEntry['outcome']) : null,
    shownFiles: isStringArray(v['shownFiles']) ? v['shownFiles'] : [],
    notes: isStringArray(v['notes']) ? v['notes'] : [],
  };
  if (isString(v['reason'])) e.reason = v['reason'];
  if (isString(v['output'])) e.output = v['output'];
  if (v['truncated'] === true) e.truncated = true;
  if (isFiniteNumber(v['completion'])) e.completion = v['completion'];
  const judge = v['judge'];
  if (isJsonObject(judge)) e.judge = judge as unknown as NonNullable<WindowEntry['judge']>;
  // the pointer is accepted only in the `outputs/step-<n>.txt` form the run dir serves (never a path from the record)
  if (isString(v['outputRef']) && parseOutputRef(v['outputRef']) === step) e.outputRef = outputRefFor(step);
  if (isFiniteNumber(v['fullOutputChars']) && v['fullOutputChars'] >= 0) e.fullOutputChars = Math.floor(v['fullOutputChars']);
  return e;
}

const PINS: readonly FilePin[] = ['read', 'edit', 'human', 'jev', 'seed'];

function readFileCacheEntry(v: unknown): FileCacheEntry | null {
  if (!isJsonObject(v)) return null;
  const rel = v['rel'];
  const pin = v['pinnedBy'];
  if (!isString(rel) || rel.length === 0 || normaliseRelPath(rel) === null) return null;
  if (!isString(pin) || !PINS.includes(pin as FilePin)) return null;
  const step = isFiniteNumber(v['lastUsedStep']) ? Math.max(0, Math.floor(v['lastUsedStep'])) : 0;
  const bytes = isFiniteNumber(v['bytesShown']) ? Math.max(0, Math.floor(v['bytesShown'])) : 0;
  return { rel, pinnedBy: pin as FilePin, lastUsedStep: step, bytesShown: bytes };
}

function readFileMemory(v: unknown): FileMemory {
  const out: FileMemory = {};
  if (!isJsonObject(v)) return out;
  for (const [rel, raw] of Object.entries(v)) {
    if (normaliseRelPath(rel) === null || !isJsonObject(raw)) continue;
    const sha = raw['sha12'];
    out[rel] = {
      sha12: isString(sha) && /^[0-9a-f]{1,64}$/.test(sha) ? sha.slice(0, 12) : null,
      bytes: isFiniteNumber(raw['bytes']) ? Math.max(0, Math.floor(raw['bytes'])) : 0,
      readAt: isFiniteNumber(raw['readAt']) ? Math.floor(raw['readAt']) : null,
      editedAt: isFiniteNumber(raw['editedAt']) ? Math.floor(raw['editedAt']) : null,
    };
  }
  return out;
}

/**
 * The §8 additions of a restored `state.json`, each validated and bounded. A state written before this landed (or by a
 * different version) yields an empty extension — the run starts with an empty view and fills it again, never with a
 * half-typed shape. `historySteps` bounds `history` to the newest N.
 */
export function readContextExtension(state: CheckpointState, historySteps = 12): ContextCheckpointExtension {
  const s = state as unknown as Record<string, unknown>;
  const ext: ContextCheckpointExtension = {};
  const history = isJsonArray(s['history']) ? s['history'].map(readHistoryEntry).filter((e): e is HistoryEntry => e !== null) : [];
  if (history.length > 0) {
    history.sort((a, b) => a.step - b.step);
    ext.history = history.length > historySteps ? history.slice(history.length - historySteps) : history;
  }
  const cache = isJsonArray(s['fileCache']) ? s['fileCache'].map(readFileCacheEntry).filter((e): e is FileCacheEntry => e !== null) : [];
  const deduped = cache.filter((e, i) => cache.findIndex((o) => o.rel === e.rel) === i);
  if (deduped.length > 0) ext.fileCache = deduped.slice(0, FILE_CACHE_MAX_ENTRIES);
  const memory = readFileMemory(s['fileMemory']);
  if (Object.keys(memory).length > 0) ext.fileMemory = boundMemory(memory);
  const summaryAt = s['summaryAt'];
  if (isFiniteNumber(summaryAt) && summaryAt >= 0) ext.summaryAt = Math.floor(summaryAt);
  const compactions = s['compactions'];
  if (isFiniteNumber(compactions) && compactions > 0) ext.compactions = Math.floor(compactions);
  const lastCompactionAt = s['lastCompactionAt'];
  if (isString(lastCompactionAt) && lastCompactionAt.length > 0) ext.lastCompactionAt = lastCompactionAt.slice(0, 40);
  return ext;
}
