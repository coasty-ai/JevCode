/**
 * Checkpoint-side shapes of the context policy (docs/COORDINATION-DESIGN.md §8.3, §8.6, W2 item 20), declared locally until
 * `src/core/types.ts` is free after the TUI round-3 hash. The state additions live in `src/loop/context/types.ts` (one home
 * for the contract shapes) and are re-exported here for the store's callers; the store widening below is the harness's own
 * (`CheckpointStore.writeOutput` / `readOutput` / `writeContextSummary` on the per-file chains — W2 item 20).
 */
import { isFiniteNumber, isJsonArray, isJsonObject, isString } from '../core/json.js';
import { boundMemory } from '../loop/context/context-cache.js';
import { outputRefFor, parseOutputRef } from '../loop/context/history.js';
import {
  FILE_CACHE_MAX_ENTRIES,
  HISTORY_ACTION_CHARS,
  HISTORY_BODY_CHARS,
  HISTORY_NOTES_MAX,
  HISTORY_NOTE_CHARS,
  HISTORY_PATH_CHARS,
  HISTORY_REASON_CHARS,
  HISTORY_SHOWN_FILES_MAX,
  OUTPUT_FILE_MAX_CHARS,
} from '../core/limits.js';
import type { CheckpointState, CheckpointStore, FileCacheEntry, FileMemory, FilePin, HistoryEntry, WindowEntry } from '../core/types.js';
import { normaliseRelPath } from './images.js';

/**
 * The six optional `CheckpointState` members of §8.3 / §8.4 / §8.6, as one object — `readContextExtension` returns it and
 * `buildCheckpointState` spreads it. The members themselves are the contract's (core/types.ts, contract 1.4); this is the
 * Pick over them, not a second declaration.
 */
export type ContextCheckpointExtension = Pick<CheckpointState, 'history' | 'fileCache' | 'fileMemory' | 'summaryAt' | 'compactions' | 'lastCompactionAt'>;

/**
 * The four context artefacts as REQUIRED methods: `CheckpointStore` declares them optional (contract 1.4, so injected fakes
 * keep type-checking), and `hasContextStore` narrows a store to this shape before the context policy writes anything.
 */
export type ContextStoreExtension = Required<Pick<CheckpointStore, 'writeOutput' | 'readOutput' | 'writeContextSummary' | 'readContextSummary'>>;

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

const INTENTS: readonly string[] = ['investigate', 'edit', 'verify', 'fix_environment', 'finish'];
const OUTCOMES: readonly string[] = ['executed', 'noop', 'blocked', 'declined', 'failed', 'interrupted'];

/** A restored number that the prompt calls `.toFixed()` on: finite and in range, or the member is dropped (review D6). */
function ratio(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
}

/**
 * Free text from a checkpoint is rendered OUTSIDE a fence in `## Recent steps`. A restored `action` carrying newlines and
 * a `## Your reply` heading would forge prompt sections, so every restored string is collapsed to one line, stripped of
 * leading heading markers, defanged of code fences and clipped to its §8.3 bound (review D6).
 */
function plain(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const one = v
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[`]{3,}/g, '~~~')
    // `### step N: <action>` is one line, so an inline `## Task` cannot be a heading — but it reads like one, and a
    // renderer that re-wraps could make it one. One `#` survives so the text stays legible.
    .replace(/#{2,}/g, '#')
    .replace(/^[#>\s]+/, '')
    .trim();
  return one.length === 0 ? null : one.slice(0, max);
}

function plainList(v: unknown, maxItems: number, maxChars: number): string[] {
  if (!isJsonArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const t = plain(item, maxChars);
    if (t !== null) out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** `JudgeResult` member by member — the prompt calls `.toFixed()` on four of these (review D6). */
function readJudge(v: unknown): NonNullable<WindowEntry['judge']> | undefined {
  if (!isJsonObject(v)) return undefined;
  const succeeded = ratio(v['succeeded']);
  const errorPresent = ratio(v['errorPresent']);
  const newInfo = ratio(v['newInfo']);
  if (succeeded === null || errorPresent === null || newInfo === null) return undefined;
  const judge: Record<string, unknown> = { succeeded, errorPresent, newInfo, tests: null, doneClaims: [] };
  const tests = v['tests'];
  if (isJsonObject(tests)) {
    if (tests['source'] === 'parsed' && isFiniteNumber(tests['passed']) && isFiniteNumber(tests['failed']) && isFiniteNumber(tests['errors'])) {
      const passed = Math.max(0, Math.floor(tests['passed']));
      const failed = Math.max(0, Math.floor(tests['failed']));
      const errors = Math.max(0, Math.floor(tests['errors']));
      // `allPassed` is recomputed from the counts, never taken from the record (`JudgeTests` declares it)
      judge['tests'] = { source: 'parsed', allPassed: failed === 0 && errors === 0 && passed > 0, passed, failed, errors };
    } else {
      const allPassed = ratio(tests['allPassed']);
      if (allPassed !== null) judge['tests'] = { source: 'judged', allPassed };
    }
  }
  if (v['source'] === 'code' || v['source'] === 'jev') judge['source'] = v['source'];
  return judge as unknown as NonNullable<WindowEntry['judge']>;
}

/**
 * One restored history entry. Only the members the prompt builder dereferences are required, and every one of them is
 * checked against its own shape and bound — a mirrored `state.json` is untrusted input (§9.3, §10; review D6).
 */
function readHistoryEntry(v: unknown): HistoryEntry | null {
  if (!isJsonObject(v)) return null;
  const step = v['step'];
  const action = plain(v['action'], HISTORY_ACTION_CHARS);
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 1 || action === null) return null;
  const intent = v['intent'];
  const outcome = v['outcome'];
  const e: HistoryEntry = {
    step,
    action,
    intent: typeof intent === 'string' && INTENTS.includes(intent) ? (intent as WindowEntry['intent']) : null,
    outcome: typeof outcome === 'string' && OUTCOMES.includes(outcome) ? (outcome as WindowEntry['outcome']) : null,
    shownFiles: plainList(v['shownFiles'], HISTORY_SHOWN_FILES_MAX, HISTORY_PATH_CHARS),
    notes: plainList(v['notes'], HISTORY_NOTES_MAX, HISTORY_NOTE_CHARS),
  };
  const reason = plain(v['reason'], HISTORY_REASON_CHARS);
  if (reason !== null) e.reason = reason;
  // The body is shown INSIDE a fence (`prompts.ts` `tieredEntry`), so its newlines are kept — but a restored body that
  // carries its own fence would close that one and everything after it would be prompt, not data. Defang the fence and
  // any line-leading heading marker, then bound the length. (Only restored bodies pass through here: a live run's
  // output goes straight from `draft.output`, so a legitimate `# comment` in this run's output is untouched.)
  if (isString(v['output']) && v['output'].length > 0) {
    e.output = v['output']
      .replace(/[`]{3,}/g, '~~~')
      .replace(/^[ \t]*#+[ \t]*/gm, '')
      .slice(0, HISTORY_BODY_CHARS);
  }
  if (v['truncated'] === true) e.truncated = true;
  const completion = ratio(v['completion']);
  if (completion !== null) e.completion = completion;
  const judge = readJudge(v['judge']);
  if (judge !== undefined) e.judge = judge;
  // the pointer is accepted only in the `outputs/step-<n>.txt` form the run dir serves (never a path from the record)
  if (isString(v['outputRef']) && parseOutputRef(v['outputRef']) === step) e.outputRef = outputRefFor(step);
  if (isFiniteNumber(v['fullOutputChars']) && v['fullOutputChars'] >= 0) e.fullOutputChars = Math.min(OUTPUT_FILE_MAX_CHARS, Math.floor(v['fullOutputChars']));
  if (v['outputEvicted'] === true) e.outputEvicted = true;
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
