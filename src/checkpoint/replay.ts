/**
 * contract 1.4 (docs/COORDINATION-DESIGN.md §7.2–§7.4, §12.0.2): what a pause leaves on disk and what a resume reads back.
 *
 *   cache/step-<n>.json   the pause-now snapshot of the step in flight — the proposal (when one existed), its targets' hashes,
 *                         the partial generator text, the arrived LLM samples of the round (llm-jev) — written by the engine
 *                         through `store.writeCache()` the moment `pause({ at: 'now' })` is called (§7.2 step 1–2). A replay
 *                         (`EngineOptions.resume.replay`, §7.3 step 3) restores it behind the hash gate below: every target
 *                         must still hash as it did at the pause, else the step is fresh at intent.
 *
 * The resume card (§7.3 step 2) is DATA here — `buildResumeCard()` — the TUI renders it. Everything is pure except the two
 * hashing helpers, which stream files under a bounded budget (the images.ts rules: never a symlink, never past 16 MiB).
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha12 } from '../core/hash.js';
import { isJsonArray, isJsonObject, toJson } from '../core/json.js';
import type {
  Action,
  ChoiceVerdict,
  CheckpointState,
  GeneratePurpose,
  GenerateResult,
  Intent,
  IntentAnswer,
  Json,
  PausePoint,
  PausePointReason,
  Proposal,
  ReplanDirective,
  RiskAssessment,
  RunEnded,
  RunMeta,
  StageName,
  StepProposer,
  StopReason,
  TargetInfo,
} from '../core/types.js';
import { hashFileStreaming, normaliseRelPath, POST_IMAGE_HASH_CAP_BYTES } from './images.js';
import { summariseAction } from './resume.js';

// ---------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------

export const STEP_CACHE_VERSION = 1 as const;
/** §7.2: the partial generator text kept for the card (`the proposal was 62 % streamed: …`) */
export const PARTIAL_TEXT_MAX_CHARS = 32 * 1024;
/** §6.4: one cached sample body at most (redacted JSON of the GenerateResult) */
export const CACHED_SAMPLE_MAX_CHARS = 64 * 1024;
/** §6.4: cached samples per step */
export const CACHED_SAMPLES_MAX = 32;
/** §7.3 step 1(c): files hashed for the gate (the images.ts streaming budget applies on top) */
export const REPLAY_HASH_MAX_FILES = 64;
export const REPLAY_HASH_MAX_BYTES = POST_IMAGE_HASH_CAP_BYTES;

// ---------------------------------------------------------------------------------------
// The step cache
// ---------------------------------------------------------------------------------------

/** the run-relative path `PausePoint.resumableAt` / `InterruptedDetail.cache` name */
export function stepCacheRel(step: number): `cache/step-${number}.json` {
  return `cache/step-${step}.json`;
}

/** the same file relative to `cache/` — what `CheckpointStore.writeCache` / `readCache` take */
export function stepCacheName(step: number): string {
  return `step-${step}.json`;
}

/** one arrived llm-jev sample of the paused round; `result` is the GenerateResult as JSON (redacted by the store) */
export interface CachedSample {
  sample: number;
  purpose: GeneratePurpose;
  /** sha12 of { system, messages } — the row's promptHash; a replay serves the sample only for the same prompt */
  promptHash: string;
  result: GenerateResult;
}

/** the intent stage's result, enough to rebuild the risk stage's input on a replay */
export interface StepCacheIntent {
  intent: Intent;
  answer: IntentAnswer;
  verdict: ChoiceVerdict;
  probability: number;
  confidence: number;
  pairedNoul: number;
  planStillValid: number;
}

export interface StepCacheTarget {
  rel: string;
  /** null: missing at the pause, or past the hashing budget */
  sha256: string | null;
}

/** §7.2 step 1: the draft snapshot `pause({ at: 'now' })` writes */
export interface StepCache {
  v: typeof STEP_CACHE_VERSION;
  step: number;
  /** the stage in flight when the pause landed */
  stage: StageName | 'idle';
  proposal: Proposal | null;
  patchTargets: TargetInfo[];
  risk: RiskAssessment | null;
  matchesIntent: number | null;
  intent: StepCacheIntent | null;
  proposer: StepProposer | null;
  contextFiles: string[];
  directive: ReplanDirective | null;
  /** the proposal's targets and their hashes at the pause (the gate's reference) */
  targets: StepCacheTarget[];
  /** the partial generator text (≤ PARTIAL_TEXT_MAX_CHARS) and every streamed char; never replayed as a proposal */
  partial: { text: string; chars: number } | null;
  /** llm-jev: the 0-based sample batch of this step and the samples that arrived; the replay serves them without a generator call */
  llmRound: { round: number; arrived: CachedSample[] } | null;
  /** the last `synth` event's phase when the pause landed inside synthesize() */
  synthPhase: string | null;
  at: string;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNullableNumber(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}

const STAGE_NAMES: readonly string[] = ['replan', 'intent', 'context', 'propose', 'risk', 'execute', 'judge', 'complete', 'idle'];
const PURPOSES: readonly string[] = ['propose_fix', 'write_reproduction'];

function isCachedSample(v: Json): v is CachedSample & Json {
  if (!isJsonObject(v)) return false;
  const result = v['result'];
  return (
    typeof v['sample'] === 'number' &&
    Number.isInteger(v['sample']) &&
    isString(v['purpose']) &&
    PURPOSES.includes(v['purpose']) &&
    isString(v['promptHash']) &&
    isJsonObject(result) &&
    isString(result['text']) &&
    isJsonArray(result['toolCalls']) &&
    isJsonObject(result['usage']) &&
    isString(result['model']) &&
    isString(result['stopReason']) &&
    typeof result['latencyMs'] === 'number'
  );
}

/** the intent block a replay copies into the draft (and from there into state.json): every field the engine reads must be typed */
function isStepCacheIntent(v: Json): boolean {
  if (!isJsonObject(v)) return false;
  return (
    isString(v['intent']) &&
    isString(v['answer']) &&
    isString(v['verdict']) &&
    typeof v['probability'] === 'number' &&
    typeof v['confidence'] === 'number' &&
    typeof v['pairedNoul'] === 'number' &&
    typeof v['planStillValid'] === 'number'
  );
}

/**
 * Structural check of a cache file (ours, redacted, but a run dir is untrusted input like every record): the fields the engine
 * dereferences on a replay must have their shape; anything else makes the replay unavailable, never an error.
 */
export function parseStepCache(v: Json): StepCache | null {
  if (!isJsonObject(v)) return null;
  if (v['v'] !== STEP_CACHE_VERSION) return null;
  const step = v['step'];
  if (typeof step !== 'number' || !Number.isInteger(step) || step < 1) return null;
  const stage = v['stage'];
  if (!isString(stage) || !STAGE_NAMES.includes(stage)) return null;
  const proposal = v['proposal'];
  if (proposal !== null && !(isJsonObject(proposal) && isJsonObject(proposal['action']) && isString(proposal['action']['kind']) && isJsonObject(proposal['plan']) && isString(proposal['rawText']))) return null;
  if (!isJsonArray(v['patchTargets']) || !isJsonArray(v['contextFiles']) || !isJsonArray(v['targets'])) return null;
  if (!v['contextFiles'].every(isString)) return null;
  if (!v['targets'].every((t) => isJsonObject(t) && isString(t['rel']) && (t['sha256'] === null || isString(t['sha256'])))) return null;
  if (!isNullableNumber(v['matchesIntent'])) return null;
  const partial = v['partial'];
  if (partial !== null && !(isJsonObject(partial) && isString(partial['text']) && typeof partial['chars'] === 'number')) return null;
  const round = v['llmRound'];
  if (round !== null) {
    if (!isJsonObject(round) || typeof round['round'] !== 'number' || !isJsonArray(round['arrived'])) return null;
    if (!round['arrived'].every(isCachedSample)) return null;
  }
  const cachedIntent = v['intent'];
  if (cachedIntent !== null && (cachedIntent === undefined || !isStepCacheIntent(cachedIntent))) return null;
  if (!isString(v['at'])) return null;
  if (v['synthPhase'] !== null && !isString(v['synthPhase'])) return null;
  // the shape holds where the engine dereferences; the rest (risk, directive, proposer) is passed through as written
  return v as unknown as StepCache;
}

// ---------------------------------------------------------------------------------------
// Targets and the hash gate
// ---------------------------------------------------------------------------------------

/** the workspace paths a proposal's action would touch: edit / write → the path; patch → the `+++` / `---` headers; run / read / done → none */
export function proposalPaths(action: Action): string[] {
  if (action.kind === 'edit' || action.kind === 'write') return [action.path];
  if (action.kind !== 'patch') return [];
  const out: string[] = [];
  for (const line of action.diff.split('\n')) {
    const m = /^(?:\+\+\+|---) (?:"?)([^\t\n"]+)/.exec(line);
    if (!m || !m[1]) continue;
    let p = m[1].trim();
    if (p === '/dev/null') continue;
    if (/^[ab]\//.test(p)) p = p.slice(2);
    if (p.length > 0 && !out.includes(p)) out.push(p);
  }
  return out;
}

/** the prompt hash a generator.jsonl row carries; the replay key of a cached sample */
export function promptHashOf(req: { system: string; messages: readonly { role: string; content: string }[] }): string {
  return sha12(toJson({ system: req.system, messages: req.messages }));
}

/**
 * sha256 of each target as it is now (≤ REPLAY_HASH_MAX_FILES files, ≤ REPLAY_HASH_MAX_BYTES in total): null for a missing
 * path, a non-regular file (never a symlink), an escaping path or a file past the budget. Never throws.
 */
export async function hashTargets(root: string, rels: readonly string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  let budget = REPLAY_HASH_MAX_BYTES;
  for (const raw of rels.slice(0, REPLAY_HASH_MAX_FILES)) {
    const rel = normaliseRelPath(raw);
    if (rel === null) {
      out[raw] = null;
      continue;
    }
    const abs = join(root, ...rel.split('/'));
    try {
      const st = await lstat(abs);
      if (!st.isFile() || st.size > budget) {
        out[raw] = null;
        continue;
      }
      budget -= st.size;
      out[raw] = await hashFileStreaming(abs);
    } catch {
      out[raw] = null;
    }
  }
  return out;
}

export interface TargetsCheck {
  ok: boolean;
  /** targets whose current hash differs from the recorded one (a missing file that existed, a file that appeared, new bytes) */
  changed: string[];
}

/** §7.3 step 3 / §11 row 30: the gate — every recorded target must hash as it did at the pause; an empty record passes (a `run` or `read` has no targets). */
export async function verifyTargets(root: string, recorded: Readonly<Record<string, string | null>>): Promise<TargetsCheck> {
  const rels = Object.keys(recorded);
  if (rels.length === 0) return { ok: true, changed: [] };
  const now = await hashTargets(root, rels);
  const changed = rels.filter((r) => (now[r] ?? null) !== (recorded[r] ?? null));
  return { ok: changed.length === 0, changed };
}

// ---------------------------------------------------------------------------------------
// The resume card — data, not rendering (§7.3 step 2, G2(b))
// ---------------------------------------------------------------------------------------

export type ResumeCardKind = 'paused' | 'ended' | 'crashed' | 'stopped' | 'complete';

export interface ResumeCardInFlight {
  /** the step /resume starts at */
  step: number;
  /** where the run stopped */
  phase: StageName | 'idle' | 'pane';
  reason: PausePointReason | 'crash';
  /** the paused proposal, when one existed: its kind and one line */
  proposal: { kind: Action['kind']; summary: string } | null;
  /** streamed generator chars of a proposal that had not finished (0 when none) */
  partialChars: number;
  /** llm-jev: the 0-based round whose samples are cached, and how many arrived */
  round: number | null;
  arrivedSamples: number;
  synthPhase: string | null;
  pane: string | null;
}

export interface ResumeCardReplay {
  /** `[r]` is offered: the state says replayable AND every target still hashes as recorded (when the check was run) */
  possible: boolean;
  /** the cache file, when the state names one */
  cache: string | null;
  /** one line the TUI may print when `possible` is false */
  reason: string;
  /** targets that changed since the pause (from the check), for `targets changed since the proposal (a, b)` */
  changedTargets: string[];
}

export interface ResumeCard {
  runId: string;
  title: string | null;
  task: string;
  kind: ResumeCardKind;
  stopReason: StopReason | null;
  /** state.updatedAt — when the last write landed */
  stoppedAt: string;
  /** now − stoppedAt, when a clock was given */
  agoMs: number | null;
  ended: RunEnded | null;
  /** `--force` is required: ended, or complete */
  needsForce: boolean;
  step: { committed: number; next: number };
  point: PausePoint | null;
  inFlight: ResumeCardInFlight | null;
  replay: ResumeCardReplay;
  pendingSteers: number;
  spend: { totalUsd: number; capUsd: number };
  wall: { usedMs: number };
  resumes: number;
}

export interface ResumeCardInput {
  state: CheckpointState;
  meta: RunMeta;
  /** the parsed cache file when the caller read it (arrived samples, the proposal when the state carries none) */
  cache?: StepCache | null;
  /** the result of `verifyTargets(root, state.interruptedDetail.targetsSha)` when the caller ran it */
  targetsCheck?: TargetsCheck | null;
  /** epoch ms, for `agoMs`; absent → null */
  nowMs?: number;
}

function cardKind(state: CheckpointState, ended: RunEnded | null): ResumeCardKind {
  if (ended !== null) return 'ended';
  if (state.stopReason === 'human_pause') return 'paused';
  if (state.stopReason === 'complete') return 'complete';
  // a stop reason null with a discarded step means the process died before its final write
  if (state.stopReason === null) return 'crashed';
  return 'stopped';
}

/** pure: everything the card shows, from the loaded state and run.json (plus the optional cache and hash check) */
export function buildResumeCard(input: ResumeCardInput): ResumeCard {
  const { state, meta } = input;
  const ended = meta.ended ?? null;
  const kind = cardKind(state, ended);
  const point = state.pausePoint ?? null;
  const interrupted = state.interrupted;
  const detail = interrupted !== null ? (state.interruptedDetail ?? null) : null;
  const cache = input.cache ?? null;
  const proposal: Proposal | null = interrupted?.proposal ?? cache?.proposal ?? null;
  const nextStep = interrupted !== null ? interrupted.step : state.step + 1;
  let inFlight: ResumeCardInFlight | null = null;
  if (point !== null || interrupted !== null) {
    inFlight = {
      step: point?.step ?? nextStep,
      phase: point?.phase ?? interrupted?.stage ?? 'idle',
      reason: point?.reason ?? 'crash',
      proposal: proposal !== null ? { kind: proposal.action.kind, summary: summariseAction(proposal.action) } : null,
      partialChars: detail?.partialChars ?? cache?.partial?.chars ?? 0,
      round: point?.round ?? cache?.llmRound?.round ?? null,
      arrivedSamples: cache?.llmRound?.arrived.length ?? 0,
      synthPhase: point?.synthPhase ?? cache?.synthPhase ?? null,
      pane: point?.pane ?? null,
    };
  }
  const check = input.targetsCheck ?? null;
  let replay: ResumeCardReplay;
  if (detail === null) replay = { possible: false, cache: null, reason: 'nothing to replay: the resume is a fresh step at intent', changedTargets: [] };
  else if (!detail.replayable) replay = { possible: false, cache: detail.cache, reason: 'nothing to replay: no proposal or sample had arrived when the run paused', changedTargets: [] };
  else if (check !== null && !check.ok) replay = { possible: false, cache: detail.cache, reason: `targets changed since the proposal (${check.changed.join(', ')}) — replay unavailable`, changedTargets: check.changed };
  else if (check === null && Object.keys(detail.targetsSha).length > 0) replay = { possible: false, cache: detail.cache, reason: 'targets not verified yet', changedTargets: [] };
  else replay = { possible: true, cache: detail.cache, reason: '', changedTargets: [] };
  const stoppedMs = Date.parse(state.updatedAt);
  return {
    runId: state.runId,
    title: meta.title ?? null,
    task: meta.task,
    kind,
    stopReason: state.stopReason,
    stoppedAt: state.updatedAt,
    agoMs: input.nowMs !== undefined && Number.isFinite(stoppedMs) ? Math.max(0, input.nowMs - stoppedMs) : null,
    ended,
    needsForce: ended !== null || state.stopReason === 'complete',
    step: { committed: state.step, next: nextStep },
    point,
    inFlight,
    replay,
    pendingSteers: state.pendingDirectives?.length ?? 0,
    spend: { totalUsd: state.spend.totalUsd, capUsd: state.spend.capUsd },
    wall: { usedMs: state.wallMsUsed },
    resumes: state.resumes,
  };
}
