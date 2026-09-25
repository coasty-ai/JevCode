/**
 * `AgentStateV1` (docs/AGENT-LOOP-DESIGN.md §10): the driver's counters, persisted opaquely in
 * `CheckpointState.agentState` (≤ 64 KiB) so they survive a resume. The transcript itself is on disk; this only says how
 * far the checkpoint covers it (`transcriptSeq`).
 */
import type { Json, JsonObject, LoopTrip } from '../core/types.js';
import { AGENT_LOOP_WINDOW, AGENT_STATE_MAX_BYTES } from './limits.js';
import type { Todo } from './tools/todo.js';

/** A failed run of the test command, as the failed-test nudge reports it (§5.4). */
export interface FailedTest {
  passed: number;
  failed: number;
  errors: number;
  /** the output was parsed into the counts; false = the counts are zeros and only the exit code says it failed */
  parsed: boolean;
  exitCode: number | null;
}

export interface AgentStateV1 {
  v: 1;
  /** model turns sampled in this run */
  turns: number;
  /** the last transcript record this checkpoint covers */
  transcriptSeq: number;
  verifyRuns: number;
  continueNudges: number;
  blocks: number;
  changedSinceVerify: boolean;
  todos: Todo[];
  /** the last ≤ 10 call signatures (§3.6) */
  loopWindow: string[];
  lastProgressTurn: number | null;
  /** set after a drift or question-build error (§13.1): no more Jev asks this run */
  jevDisabled: boolean;
  /** set after a rejected replay (§6.5): no more providerState is sent this run */
  replayDisabled: boolean;
  /** sha12 of the system prompt + tool list */
  systemHash: string;
  /** the parent run id when the head was carried (§7.6) */
  carriedFrom: string | null;
  compactions: number;
  lastCompactionAt: string | null;
  // --- additive, driver-private -------------------------------------------------------
  /** a loop trip whose nudge the next turn still has to send (RA1 picks its wording) */
  pendingLoop: (LoopTrip & { testCommand: string | null }) | null;
  /**
   * the model's own last unscoped run of the detected test command after its last change, when it failed: the counts when
   * the output was parsed (`parsed`), else only the exit code (null when the command was killed). A state written before
   * `parsed` / `exitCode` existed reads as parsed, with no exit code.
   */
  failedTest: FailedTest | null;
  /** the step of the last compaction (the meter's `summaryAt`) */
  lastCompactionStep: number | null;
}

export function initialState(systemHash: string): AgentStateV1 {
  return {
    v: 1,
    turns: 0,
    transcriptSeq: 0,
    verifyRuns: 0,
    continueNudges: 0,
    blocks: 0,
    changedSinceVerify: false,
    todos: [],
    loopWindow: [],
    lastProgressTurn: null,
    jevDisabled: false,
    replayDisabled: false,
    systemHash,
    carriedFrom: null,
    compactions: 0,
    lastCompactionAt: null,
    pendingLoop: null,
    failedTest: null,
    lastCompactionStep: null,
  };
}

function isObj(v: Json | undefined): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const num = (v: Json | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const numOrNull = (v: Json | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: Json | undefined, d: string): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: Json | undefined): string | null => (typeof v === 'string' ? v : null);
const bool = (v: Json | undefined): boolean => v === true;

function failedTest(v: Json | undefined): FailedTest | null {
  if (!isObj(v)) return null;
  // a state from before `parsed` existed only ever held parsed counts
  return { passed: num(v['passed'], 0), failed: num(v['failed'], 0), errors: num(v['errors'], 0), parsed: v['parsed'] !== false, exitCode: numOrNull(v['exitCode']) };
}

function loopTrip(v: Json | undefined): AgentStateV1['pendingLoop'] {
  if (!isObj(v) || typeof v['signature'] !== 'string') return null;
  const rule = v['rule'] === 'window' ? 'window' : 'repeat';
  const tool = typeof v['tool'] === 'string' ? v['tool'] : 'invalid';
  return { signature: v['signature'], count: num(v['count'], 3), rule, tool: tool as LoopTrip['tool'], testCommand: strOrNull(v['testCommand']) };
}

/** Read a persisted state; null when there is none or it is not ours (a fresh run). Unknown members are ignored. */
export function parseState(j: Json | null): AgentStateV1 | null {
  if (!isObj(j ?? undefined) || (j as JsonObject)['v'] !== 1) return null;
  const o = j as JsonObject;
  const todos = Array.isArray(o['todos'])
    ? o['todos'].flatMap((t): Todo[] => (isObj(t) && typeof t['content'] === 'string' && (t['status'] === 'pending' || t['status'] === 'in_progress' || t['status'] === 'completed') ? [{ content: t['content'], status: t['status'] }] : []))
    : [];
  return {
    v: 1,
    turns: num(o['turns'], 0),
    transcriptSeq: num(o['transcriptSeq'], 0),
    verifyRuns: num(o['verifyRuns'], 0),
    continueNudges: num(o['continueNudges'], 0),
    blocks: num(o['blocks'], 0),
    changedSinceVerify: bool(o['changedSinceVerify']),
    todos,
    loopWindow: Array.isArray(o['loopWindow']) ? o['loopWindow'].filter((s): s is string => typeof s === 'string').slice(-AGENT_LOOP_WINDOW) : [],
    lastProgressTurn: numOrNull(o['lastProgressTurn']),
    jevDisabled: bool(o['jevDisabled']),
    replayDisabled: bool(o['replayDisabled']),
    systemHash: str(o['systemHash'], ''),
    carriedFrom: strOrNull(o['carriedFrom']),
    compactions: num(o['compactions'], 0),
    lastCompactionAt: strOrNull(o['lastCompactionAt']),
    pendingLoop: loopTrip(o['pendingLoop']),
    failedTest: failedTest(o['failedTest']),
    lastCompactionStep: numOrNull(o['lastCompactionStep']),
  };
}

/** The state as checkpoint JSON, kept under AGENT_STATE_MAX_BYTES (todos are the only unbounded-ish member). */
export function stateJson(s: AgentStateV1): Json {
  const out = JSON.parse(JSON.stringify(s)) as JsonObject;
  while (Buffer.byteLength(JSON.stringify(out), 'utf8') > AGENT_STATE_MAX_BYTES && Array.isArray(out['todos']) && out['todos'].length > 0) out['todos'].pop();
  return out;
}
