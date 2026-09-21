/**
 * UI state for the TUI (TUI-DESIGN §15 item 20 — `UiState` 1.1, `UiAction` and the per-event transition table,
 * implemented row by row, plus the additive `run:idle` row for a submission that never became a run (§4.9: the
 * follow-up box answered `n`/Esc, a missing key, a trust refusal) and the additive `thresholds` row; §6.3 review
 * deferral (never over another open overlay); §7.5 toasts; §13.2 retry row; D12): a pure reducer over
 * `EngineEvent` plus the local actions, the ≤ 20 fps live-region coalescer (`LIVE_FLUSH_MS = 50`, kept), the
 * event bus that lets `attach(engine)` happen after the first frame (with the §4.8 suspension queue), and the
 * TUI Confirmer (`resolve`, `resolveDetailed`, `confirmDetailed`; "a second request declines the first" and the
 * signal `onAbort` rejection are kept — the latter is the S4 Ctrl-C path). Everything but the hook is pure and
 * unit-tested without Ink.
 */
import { useEffect, useReducer, useRef } from 'react';
import type {
  BlockingRequest,
  ConfirmOutcome,
  ConfirmRequest,
  Confirmer,
  Decision,
  EngineEvent,
  EngineMode,
  EngineStatus,
  GitHead,
  PendingDirective,
  RunResult,
  SandboxLevel,
  SpendSnapshot,
} from '../core/types.js';
import { AbortError } from '../errors.js';
import type { OverlayKind } from './layout.js';
import { emptyLoopFold, foldLoopPlan, foldLoopReplan, foldLoopSteer, foldLoopStep, loopView, type LoopBannerView, type LoopFold } from './pane/banner.js';
import { DEFAULT_COMPLETE_THRESHOLD, DEFAULT_IMPOSSIBLE_THRESHOLD } from '../config/defaults.js';
import { foldByStep, foldPlanRecord, foldStageEnd, foldStepEnd, toDecisionRow, type DecisionRow, type PaneTab, type PlanView, type SynthView, type TimelineStep } from './pane/model.js';
import { IDENTITY_REVIEWER, itemsFromEvent, localItem, sanitizeStream, synthText, type TranscriptItem, type TranscriptLevel } from './plain.js';
import { retryViewFrom, startTicker, type RetryView } from './retry.js';
import type { GitZone, ThinkingPhase } from './status/lines.js';
import { toastReducer, type Toast } from './toasts.js';

export type { RetryView } from './retry.js';
export type { GitZone } from './status/lines.js';
export type { Toast } from './toasts.js';

export const DECISIONS_KEPT = 12;
/** 50 ms = 20 fps: the only coalescing the TUI does (generator deltas and exec output share the buffer); 250 under reduced motion (§14.2). */
export const LIVE_FLUSH_MS = 50;
export const LIVE_FLUSH_REDUCED_MS = 250;
/** The live buffer keeps a tail only; the full proposal text is committed to <Static> at `proposal`. */
export const LIVE_BUFFER_MAX = 64 * 1024;
/** TUI-DESIGN §6.3: the review box renders only after this much composer idleness. */
export const REVIEW_DEFER_MS = 1000;
/** TUI-DESIGN §6.3: the deferral re-checks the input queue at this cadence. */
export const REVIEW_RECHECK_MS = 100;
/** TUI-DESIGN §14.1 (A28, C27): `<Static>` soft cap → keyed remount with a fresh array. */
export const STATIC_SOFT_CAP = 20_000;
/** Raw decisions kept per step for `/why` (the last 3 steps, §7.1). */
export const DECISION_STEPS_KEPT = 3;
/** The sparkline reads the last 12 Jev requests (§7.4). */
export const JEV_LATENCIES_KEPT = 12;
/** The 1 Hz tick (§15 item 20 `nowMs`). */
export const TICK_MS = 1000;
/** TUI-DESIGN-2 §3.11: the controller keeps the last three intakes' decision rows for the panel. */
export const CHAT_ROWS_KEPT = 3;

/** TUI-DESIGN-2 §4.5: the stage kinds the default `compact` transcript hides (they stay in transcript.log, `--plain` and the panel). */
export const COMPACT_HIDDEN_KINDS: ReadonlySet<string> = new Set(['intent', 'context', 'synth', 'proposal', 'risk', 'outcome', 'judge', 'plan', 'run:ready']);

/** TUI-DESIGN-2 §4.5: a transcript item stamped with the default filter's verdict at append time (`hidden` never changes afterwards). */
export type UiTranscriptItem = TranscriptItem & { readonly hidden?: boolean };

/** TUI-DESIGN-2 §4.5: true when the `compact` view hides an item of this kind. */
export function hiddenInCompact(kind: string): boolean {
  return COMPACT_HIDDEN_KINDS.has(kind);
}

/** TUI-DESIGN-2 §4.5: the items `<Static>` receives — the filtered array is append-only too (A25 holds). */
export function visibleItems(items: readonly UiTranscriptItem[]): readonly UiTranscriptItem[] {
  return items.filter((i) => i.hidden !== true);
}

/**
 * TUI-DESIGN-2 §4.5 / §13 finding 12: `visibleItems` with a stable reference — a hidden-only batch (the same visible rows, the
 * same epoch) hands `<Transcript>` the previous array, so the memoised component commits nothing and no `<Static>` subtree is
 * dirtied. Appends keep the array append-only; a soft-cap remount (`epoch`) starts a fresh one.
 */
export function useVisibleItems(items: readonly UiTranscriptItem[], epoch: number): readonly UiTranscriptItem[] {
  const ref = useRef<{ visible: readonly UiTranscriptItem[]; epoch: number }>({ visible: [], epoch });
  const filtered = visibleItems(items);
  const prev = ref.current;
  const same = prev.epoch === epoch && prev.visible.length === filtered.length && (filtered.length === 0 || prev.visible[filtered.length - 1]?.key === filtered[filtered.length - 1]?.key);
  const visible = same ? prev.visible : filtered;
  ref.current = { visible, epoch };
  return visible;
}

/** TUI-DESIGN-2 §4.6: the Jev panel's three sizes. */
export type PanelState = 'collapsed' | 'open' | 'full';
/** TUI-DESIGN-2 §4.5: the transcript's two views (`compact` = one `[step N]` line per step). */
export type TranscriptView = 'compact' | 'full';
/** TUI-DESIGN-2 §5: the splash runs from the first frame until a key, a run, an overlay or the 700 ms settle. */
export type SplashState = 'running' | 'done';

/** TUI-DESIGN §15 item 20 `RunPhase` — no 'paused': a blocking pause is overlay 'blocking' with run 'live'; human_pause ends the run. */
export type RunPhase = 'none' | 'starting' | 'live' | 'aborting' | 'pausing';

/** TUI-DESIGN §15 item 20 `LoopView`. */
export type LoopView = LoopBannerView;

/** TUI-DESIGN §15 item 20 `DraftMirror`: the TextBuffer lives in the composer's own reducer; the resolver and the layout need only this. */
export interface DraftMirror {
  empty: boolean;
  rows: number;
  cursorRow: 'first' | 'mid' | 'last';
  secretHits: number;
}

export const EMPTY_DRAFT: DraftMirror = { empty: true, rows: 1, cursorRow: 'first', secretHits: 0 };

/**
 * A queued steer as the queue rows print it (§24 "Queue rows"): `PendingDirective` plus the step the engine named in
 * `steer:queued` (`↑1 queued for step N` must agree with the engine's own `steer queued (N) for step S` item).
 */
export interface QueueEntry extends PendingDirective {
  readonly step?: number;
}

/** The completion / impossible thresholds the decision rows are judged against (`toDecisionRow`; §7.1). */
export interface Thresholds {
  readonly complete: number;
  readonly impossible: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { complete: DEFAULT_COMPLETE_THRESHOLD, impossible: DEFAULT_IMPOSSIBLE_THRESHOLD };

/** TUI-DESIGN §15 item 20 `UiState` 1.1 — today's fields kept, the design's additions, and the additive pane inputs the tab builders read. */
export interface UiState {
  readonly items: readonly UiTranscriptItem[];
  /** monotonic counter behind engine item keys */
  readonly seq: number;
  readonly live: string;
  /** cumulative streamed tool-argument chars of the current generator call (0 when none / after the proposal) */
  readonly toolChars: number;
  /** jev-only: the last `synth` line of the current step, shown in the live region while no generator stream is active */
  readonly synth: string | null;
  /** llm-jev (docs/LLM-JEV-DESIGN.md §9.3): `sample k/N` of the current step's generator round — set by `generator:start` carrying `samples > 1`, cleared at `proposal` / `step:end` / `run:end`; null in every other mode */
  readonly sampling: { k: number; n: number } | null;
  readonly mode: EngineMode | null;
  readonly decisions: readonly Decision[];
  readonly status: EngineStatus | null;
  readonly ready: { step: number; maxSteps: number } | null;
  readonly pendingConfirm: ConfirmRequest | null;
  readonly task: string;
  readonly resumeId: string | null;
  readonly runId: string | null;
  readonly done: RunResult | null;
  // ----- 1.1 (§15 item 20)
  readonly run: RunPhase;
  readonly draft: DraftMirror;
  /** ≤ 8 (entries carry the engine's target step, additive) */
  readonly queue: readonly QueueEntry[];
  readonly overlay: OverlayKind;
  /** drawn on a committed frame (§6.3; every y-gated overlay) */
  readonly overlayArmed: boolean;
  readonly pendingReview: ConfirmRequest | null;
  readonly visibleAt: number | null;
  readonly lastKeystrokeAt: number;
  /**
   * Count of `key` actions (TUI-DESIGN-2 §9 "keystroke → frame", decision D-F). The App hands it to the memoised
   * `<Transcript>`, whose `<Static>` gets a fresh `style` object per key: Ink 7.1.1 renders a commit that updated the
   * `<Static>` node immediately (`reconciler.js` `commitUpdate` → `isStaticDirty` → `onImmediateRender`), so a key's
   * frame never waits for the trailing edge of the 34 ms render throttle behind a spinner or 1 Hz tick frame.
   */
  readonly keySeq: number;
  readonly expanded: boolean;
  readonly noteMode: boolean;
  readonly retrying: RetryView | null;
  /** the `!n` badge */
  readonly errors: number;
  /** `still waiting` after 45 s */
  readonly stageStartedAt: number | null;
  /** last 12 rows (DECISIONS_KEPT); rows of the last 3 steps */
  readonly rows: readonly DecisionRow[];
  readonly byStep: ReadonlyMap<number, readonly DecisionRow[]>;
  readonly loop: LoopView | null;
  /** ≤ 4; an error toast pre-empts an info toast */
  readonly toasts: readonly Toast[];
  readonly tab: PaneTab;
  readonly git: GitZone | null;
  readonly paths: { runDir: string; transcript: string; log: string } | null;
  readonly blocking: BlockingRequest | null;
  readonly spend: { run: SpendSnapshot | null; session: { totalUsd: number; capUsd: number } | null };
  /** the 1 Hz tick: wall clock, toast expiry, retry countdown, review visibility re-check */
  readonly nowMs: number;
  // ----- additive inputs of the pure builders (pane tabs, status line, palette, dispatch context)
  readonly sessionMode: 'session' | 'one-shot';
  /** raw decisions of the last 3 steps for `/why <digit>` and Ctrl+O (never a disk read, §7.1) */
  readonly decisionsByStep: ReadonlyMap<number, readonly Decision[]>;
  readonly plan: PlanView | null;
  readonly timeline: readonly TimelineStep[];
  readonly synthView: SynthView | null;
  readonly loopFold: LoopFold;
  /** last 12 Jev request latencies (null = failed attempt) for the sparkline */
  readonly jevLatencies: readonly (number | null)[];
  readonly sandbox: SandboxLevel | null;
  readonly noNetwork: boolean;
  /** `notice checkpoint:degraded` count → `disk ×N` */
  readonly diskErrors: number;
  /** `/rename` title (status centre) */
  readonly title: string | null;
  /** the session / rewind picker is open in the pane slot */
  readonly picker: boolean;
  /** steps of the current or last run with `changedFiles` (from `step:end` records) */
  readonly changedSteps: readonly number[];
  /** the current or last run's committed step count */
  readonly step: number;
  /** a 401 pane was shown for the last run (palette Suggested `/login`) */
  readonly unauthorized: boolean;
  /** `run:end.exitCode` when carried */
  readonly doneExitCode: number | null;
  /** `nowMs` when the last `status` arrived (wall-clock extrapolation) */
  readonly statusAt: number | null;
  /** runs ended in this session */
  readonly runsEnded: number;
  /** `<Static>` remount generation (A28) */
  readonly staticEpoch: number;
  /** renderer-local item counter (`local:[ui]:n` keys) */
  readonly localSeq: number;
  /** the run's resolved completion / impossible thresholds (`thresholds` action from the controller; defaults until then) */
  readonly thresholds: Thresholds;
  // ----- TUI-DESIGN-2 §6 item 16 (round 2)
  /** §1.5: the badge — the live (or base) mode and the `/mode` pending for the next run */
  readonly modeBadge: { mode: EngineMode; pending: EngineMode | null };
  /** §4.8: between Enter and the reply */
  readonly thinking: ThinkingPhase | null;
  /** §3.11: the last intakes' `s0 intake …` rows */
  readonly chatRows: readonly DecisionRow[];
  /** §5: the startup splash */
  readonly splash: SplashState;
  /** §5.3: when the App mounted (`now()`), the splash's time origin */
  readonly mountedAt: number;
  /** §4.6: the Jev panel */
  readonly panel: PanelState;
  /** §4.5: the transcript filter for new items */
  readonly transcript: TranscriptView;
  /** §4.4: runs + chat replies — `followup` placeholder once > 0 */
  readonly turns: number;
  /** §4.6: the run's last risk assessment (`risk 0.44 [review]` on the panel strip) */
  readonly lastRisk: { risk: number; verdict: 'ok' | 'review' | 'block' } | null;
}

/** TUI-DESIGN §15 item 20 `UiAction` (today's four, the design's additions, and the additive `picker` / `title` / `spend:session` / `git:dirs`). */
export type UiAction =
  | { type: 'event'; event: EngineEvent; at?: number }
  | { type: 'live'; text: string; toolChars?: number }
  | { type: 'confirm:request'; request: ConfirmRequest; at?: number }
  | { type: 'confirm:settled'; id: string }
  | { type: 'key'; at: number }
  | { type: 'tick'; now: number }
  | { type: 'draft'; draft: DraftMirror }
  | { type: 'overlay'; overlay: OverlayKind }
  | { type: 'overlay:armed' }
  | { type: 'review:visible' }
  | { type: 'review:expand'; expanded: boolean }
  | { type: 'note'; on: boolean }
  | { type: 'run:starting' }
  /** §4.9: `host.submit()` resolved without a `run:start` (follow-up box `n`/Esc, missing key, trust refusal, any early return) */
  | { type: 'run:idle' }
  | { type: 'run:aborting' }
  | { type: 'run:pausing' }
  | { type: 'toast'; text: string; level: Toast['level']; ms: number }
  | { type: 'ack-errors' }
  | { type: 'tab'; tab: PaneTab }
  | { type: 'git'; zone: GitZone | null }
  | { type: 'local-item'; item: TranscriptItem }
  | { type: 'local'; text: string; label?: TranscriptItem['label']; level?: TranscriptLevel; detail?: string }
  | { type: 'picker'; open: boolean }
  | { type: 'title'; title: string | null }
  | { type: 'spend:session'; session: { totalUsd: number; capUsd: number } | null }
  /** the controller's resolved `--complete-threshold` / `--impossible-threshold` (after resolveConfig; §7.1 rows) */
  | { type: 'thresholds'; complete: number; impossible: number }
  // ----- TUI-DESIGN-2 §6 item 15 (round 2)
  /** §1.5: after `resolveConfig` and on every `/mode` — `run:start` promotes `pending` to `mode` */
  | { type: 'mode'; mode: EngineMode; pending: EngineMode | null }
  /** §4.8: the controller's conversational phase */
  | { type: 'thinking'; phase: ThinkingPhase | null }
  /** §3.11: the intake's decision rows (the controller keeps the last ≤ 3 intakes) */
  | { type: 'chat-decisions'; rows: readonly DecisionRow[] }
  /** §5.3: the splash ended (a key, the settle effect, a run, an overlay) */
  | { type: 'splash:done' }
  /** §4.6: `/panel`, Alt+J, `]` */
  | { type: 'panel'; panel: PanelState }
  /** §4.5: `/transcript compact|full` (new items only, R4) */
  | { type: 'transcript'; view: TranscriptView }
  /** §4.4: a chat reply counted as a turn (`SubmitOutcome.became === 'chat'`; a run counts at `run:start`) */
  | { type: 'turn' };

export interface InitialStateOptions {
  mode?: 'session' | 'one-shot';
  nowMs?: number;
  /** TUI-DESIGN-2 §1.5: `launch.modeHint` (`--mode` > `JEVCODE_MODE`), else `jev-only` */
  modeHint?: EngineMode;
  /** TUI-DESIGN-2 §5.3: `running` from the first frame (boxed, motion allowed), `done` under reduced motion / SR / --plain */
  splash?: SplashState;
}

export function initialUiState(task: string, resumeId: string | null, opts: InitialStateOptions = {}): UiState {
  return {
    items: [],
    seq: 0,
    live: '',
    toolChars: 0,
    synth: null,
    sampling: null,
    mode: null,
    decisions: [],
    status: null,
    ready: null,
    pendingConfirm: null,
    task,
    resumeId,
    runId: null,
    done: null,
    run: 'none',
    draft: EMPTY_DRAFT,
    queue: [],
    overlay: 'none',
    overlayArmed: false,
    pendingReview: null,
    visibleAt: null,
    lastKeystrokeAt: 0,
    keySeq: 0,
    expanded: false,
    noteMode: false,
    retrying: null,
    errors: 0,
    stageStartedAt: null,
    rows: [],
    byStep: new Map(),
    loop: null,
    toasts: [],
    tab: 'd',
    git: null,
    paths: null,
    blocking: null,
    spend: { run: null, session: null },
    nowMs: opts.nowMs ?? 0,
    sessionMode: opts.mode ?? 'one-shot',
    decisionsByStep: new Map(),
    plan: null,
    timeline: [],
    synthView: null,
    loopFold: emptyLoopFold(),
    jevLatencies: [],
    sandbox: null,
    noNetwork: false,
    diskErrors: 0,
    title: null,
    picker: false,
    changedSteps: [],
    step: 0,
    unauthorized: false,
    doneExitCode: null,
    statusAt: null,
    runsEnded: 0,
    staticEpoch: 0,
    localSeq: 0,
    thresholds: DEFAULT_THRESHOLDS,
    modeBadge: { mode: opts.modeHint ?? 'jev-only', pending: null },
    thinking: null,
    chatRows: [],
    splash: opts.splash ?? 'done',
    mountedAt: opts.nowMs ?? 0,
    panel: 'collapsed',
    transcript: 'compact',
    turns: 0,
    lastRisk: null,
  };
}

/** TUI-DESIGN-2 §5.3: the splash dies on a key, a run, a review, any overlay change or a blocking request. */
function endSplash(s: UiState): UiState {
  return s.splash === 'running' ? { ...s, splash: 'done' } : s;
}

function clearReview(s: UiState): UiState {
  return {
    ...s,
    pendingConfirm: null,
    pendingReview: null,
    visibleAt: null,
    overlay: s.overlay === 'review' ? 'none' : s.overlay,
    overlayArmed: s.overlay === 'review' ? false : s.overlayArmed,
    expanded: false,
    noteMode: false,
  };
}

/** Pure; one dispatch per event (live flushes come from the coalescer as their own action). */
export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'live': {
      const toolChars = action.toolChars ?? state.toolChars;
      return state.live === action.text && state.toolChars === toolChars ? state : { ...state, live: action.text, toolChars };
    }
    case 'confirm:request': {
      if (state.pendingConfirm?.id === action.request.id) return state;
      const now = action.at ?? state.nowMs;
      // §6.2: a second request declines the first (createTuiConfirmer) — its box, note field and expansion close and
      // the new request goes through the deferral again, so a key in flight never answers the replacement
      const base = endSplash(state.pendingReview !== null ? clearReview(state) : state);
      return { ...base, pendingConfirm: action.request, pendingReview: action.request, visibleAt: Math.max(now, base.lastKeystrokeAt + REVIEW_DEFER_MS) };
    }
    case 'confirm:settled':
      return state.pendingConfirm?.id === action.id ? clearReview(state) : state;
    case 'event':
      return applyEvent(state, action.event, action.at ?? state.nowMs);
    case 'key': {
      const s = endSplash(state);
      // always a new state: `keySeq` must advance for every key (two keys in one millisecond share `at`)
      return { ...s, lastKeystrokeAt: action.at, keySeq: s.keySeq + 1 };
    }
    case 'tick': {
      const toasts = toastReducer(state.toasts, { type: 'tick' }, action.now);
      return state.nowMs === action.now && toasts === state.toasts ? state : { ...state, nowMs: action.now, toasts };
    }
    case 'draft':
      return sameDraft(state.draft, action.draft) ? state : { ...state, draft: action.draft };
    case 'overlay':
      return state.overlay === action.overlay ? state : { ...endSplash(state), overlay: action.overlay, overlayArmed: false };
    case 'overlay:armed':
      return state.overlay === 'none' || state.overlayArmed ? state : { ...state, overlayArmed: true };
    case 'review:visible':
      // §6.3: the box never replaces another open overlay (exitConfirm / followup / undo / palette / secret / wizard /
      // blocking) — their pending resolvers would be orphaned and an armed `y` meant for them would approve the review.
      if (state.pendingReview === null || state.overlay !== 'none') return state;
      return { ...state, overlay: 'review', overlayArmed: false };
    case 'review:expand':
      return state.expanded === action.expanded ? state : { ...state, expanded: action.expanded };
    case 'note':
      return state.noteMode === action.on ? state : { ...state, noteMode: action.on };
    case 'run:starting':
      return state.run === 'none' ? { ...state, run: 'starting' } : state;
    case 'run:idle':
      // only a `starting` that never became a run returns to idle; a live / aborting / pausing run ends through run:end
      return state.run === 'starting' ? { ...state, run: 'none' } : state;
    case 'run:aborting':
      return state.run === 'none' || state.run === 'aborting' ? state : { ...state, run: 'aborting' };
    case 'run:pausing':
      return state.run === 'live' || state.run === 'starting' ? { ...state, run: 'pausing' } : state;
    case 'toast': {
      const toasts = toastReducer(state.toasts, { type: 'toast', text: action.text, level: action.level, ms: action.ms }, state.nowMs);
      return toasts === state.toasts ? state : { ...state, toasts };
    }
    case 'ack-errors':
      return state.errors === 0 ? state : { ...state, errors: 0 };
    case 'tab':
      return state.tab === action.tab ? state : { ...state, tab: action.tab };
    case 'git':
      return { ...state, git: action.zone };
    case 'local-item':
      return appendItems(state, [action.item]);
    case 'local': {
      const item = localItem(action.text, state.localSeq, {
        ...(action.label ? { label: action.label } : {}),
        ...(action.level ? { level: action.level } : {}),
        ...(action.detail ? { detail: action.detail } : {}),
      });
      return { ...appendItems(state, [item]), localSeq: state.localSeq + 1 };
    }
    case 'picker':
      return state.picker === action.open ? state : { ...state, picker: action.open };
    case 'title':
      return state.title === action.title ? state : { ...state, title: action.title };
    case 'spend:session':
      return { ...state, spend: { ...state.spend, session: action.session } };
    case 'thresholds': {
      const complete = Number.isFinite(action.complete) ? action.complete : state.thresholds.complete;
      const impossible = Number.isFinite(action.impossible) ? action.impossible : state.thresholds.impossible;
      return state.thresholds.complete === complete && state.thresholds.impossible === impossible ? state : { ...state, thresholds: { complete, impossible } };
    }
    // ----- TUI-DESIGN-2 §6 item 15
    case 'mode':
      return state.modeBadge.mode === action.mode && state.modeBadge.pending === action.pending ? state : { ...state, modeBadge: { mode: action.mode, pending: action.pending } };
    case 'thinking':
      return state.thinking === action.phase ? state : { ...state, thinking: action.phase };
    case 'chat-decisions':
      return { ...state, chatRows: [...action.rows] };
    case 'splash:done':
      return endSplash(state);
    case 'panel':
      return state.panel === action.panel ? state : { ...state, panel: action.panel };
    case 'transcript':
      return state.transcript === action.view ? state : { ...state, transcript: action.view };
    case 'turn':
      return { ...state, turns: state.turns + 1 };
  }
}

function sameDraft(a: DraftMirror, b: DraftMirror): boolean {
  return a.empty === b.empty && a.rows === b.rows && a.cursorRow === b.cursorRow && a.secretHits === b.secretHits;
}

/**
 * Append items; past the `<Static>` soft cap the array restarts with a new epoch (A28: a keyed remount, nothing re-printed).
 * TUI-DESIGN-2 §4.5: under the `compact` view the stage kinds are stamped `hidden: true` at append time (a later `/transcript
 * full` shows new items only, R4); `UiState.items` keeps every item for `/export`.
 */
function appendItems(state: UiState, items: readonly TranscriptItem[]): UiState {
  if (items.length === 0) return state;
  const stamped: UiTranscriptItem[] = state.transcript === 'compact' ? items.map((i) => (hiddenInCompact(i.kind) ? { ...i, hidden: true } : i)) : [...items];
  if (state.items.length + stamped.length > STATIC_SOFT_CAP) return { ...state, items: stamped, staticEpoch: state.staticEpoch + 1 };
  return { ...state, items: [...state.items, ...stamped] };
}

function pushLatency(list: readonly (number | null)[], ms: number | null): readonly (number | null)[] {
  const next = [...list, ms];
  return next.length > JEV_LATENCIES_KEPT ? next.slice(next.length - JEV_LATENCIES_KEPT) : next;
}

function keepSteps(map: ReadonlyMap<number, readonly Decision[]>, d: Decision): Map<number, readonly Decision[]> {
  const next = new Map(map);
  next.set(d.step, [...(next.get(d.step) ?? []), d]);
  const steps = [...next.keys()].sort((a, b) => b - a);
  for (const s of steps.slice(DECISION_STEPS_KEPT)) next.delete(s);
  return next;
}

/** The `run:start` reset row of the transition table (the fix for today's never-cleared `done`). */
function resetForRun(s: UiState, e: Extract<EngineEvent, { type: 'run:start' }>, now: number): UiState {
  return {
    ...s,
    runId: e.runId,
    mode: e.mode,
    done: null,
    doneExitCode: null,
    decisions: [],
    rows: [],
    byStep: new Map(),
    decisionsByStep: new Map(),
    ready: null,
    status: null,
    statusAt: null,
    live: '',
    toolChars: 0,
    synth: null,
    sampling: null,
    synthView: null,
    retrying: null,
    loop: null,
    loopFold: emptyLoopFold(s.loopFold.maxReplans),
    blocking: null,
    pendingConfirm: null,
    pendingReview: null,
    visibleAt: null,
    expanded: false,
    noteMode: false,
    overlay: s.overlay === 'wizard' ? s.overlay : 'none',
    overlayArmed: false,
    paths: null,
    stageStartedAt: now,
    run: 'live',
    queue: [],
    plan: null,
    timeline: [],
    changedSteps: [],
    step: e.resumedFromStep ?? 0,
    unauthorized: false,
    diskErrors: 0,
    errors: 0,
    jevLatencies: [],
    // TUI-DESIGN-2 §1.5 / §4.6 / §5.3 / §4.4: the run promotes the pending mode, collapses the panel, ends the splash and is a turn
    modeBadge: { mode: e.mode, pending: null },
    panel: 'collapsed',
    splash: 'done',
    turns: s.turns + 1,
    // TUI-DESIGN-2 §3.1 row 5: the intake settled (`thinking(null)`) before `startRun`; a run never shows a chat phase
    thinking: null,
    lastRisk: null,
  };
}

function applyEvent(state: UiState, e: EngineEvent, now: number): UiState {
  let next = appendItems(state, itemsFromEvent(e, state.seq));
  if (next !== state) next = { ...next, seq: state.seq + (next.items.length - (next.staticEpoch === state.staticEpoch ? state.items.length : 0)) };
  switch (e.type) {
    case 'run:start':
      return resetForRun(next, e, now);
    case 'run:ready':
      return {
        ...next,
        runId: e.runId,
        ready: { step: e.step, maxSteps: e.maxSteps },
        run: 'live',
        step: e.step,
        ...(e.sandbox !== undefined ? { sandbox: e.sandbox } : {}),
        ...(e.noNetwork !== undefined ? { noNetwork: e.noNetwork } : {}),
        loopFold: e.maxReplans !== undefined ? { ...next.loopFold, maxReplans: e.maxReplans } : next.loopFold,
      };
    case 'workspace': {
      const head: GitHead | null = e.git.head;
      const zone: GitZone = {
        head,
        ahead: e.git.ahead ?? null,
        behind: e.git.behind ?? null,
        dirty: { modified: e.git.dirtyAtStart.modified, staged: e.git.dirtyAtStart.staged, untracked: e.git.dirtyAtStart.untracked },
        linkedWorktree: e.git.linkedWorktree,
        frozen: false,
      };
      return { ...next, git: e.git.repo ? zone : null };
    }
    case 'decision': {
      const row = toDecisionRow(e.decision, next.thresholds.complete, next.thresholds.impossible);
      return {
        ...next,
        decisions: [...next.decisions.slice(-(DECISIONS_KEPT - 1)), e.decision],
        rows: [...next.rows.slice(-(DECISIONS_KEPT - 1)), row],
        byStep: foldByStep(next.byStep, row, DECISION_STEPS_KEPT),
        decisionsByStep: keepSteps(next.decisionsByStep, e.decision),
      };
    }
    case 'jev:request':
      return { ...next, jevLatencies: pushLatency(next.jevLatencies, Number.isFinite(e.record.latencyMs) ? e.record.latencyMs : null) };
    case 'risk':
      // TUI-DESIGN-2 §4.6: the strip's `risk <r> <verdict>` segment
      return { ...next, lastRisk: { risk: e.risk.risk, verdict: e.risk.verdict } };
    case 'status': {
      const stageChanged = next.status?.stage !== e.status.stage;
      const retrying = e.status.retrying && next.retrying ? { ...next.retrying, attempt: e.status.retrying.attempt, maxAttempts: e.status.retrying.maxAttempts, untilMs: e.status.retrying.untilMs } : next.retrying;
      return {
        ...next,
        status: e.status,
        statusAt: now,
        stageStartedAt: stageChanged ? now : next.stageStartedAt,
        retrying,
        spend: { ...next.spend, run: e.status.spend },
        step: Math.max(next.step, e.status.step),
        ...(e.status.stage === 'idle' ? {} : {}),
      };
    }
    case 'stage:start':
      return { ...next, stageStartedAt: now, step: Math.max(next.step, e.step - 1) };
    case 'stage:end':
      return { ...next, stageStartedAt: now, timeline: foldStageEnd(next.timeline, { step: e.step, stage: e.stage, ms: e.ms }) };
    case 'synth':
      return { ...next, synth: synthText(e), synthView: { step: e.step, phase: e.phase, detail: e.detail, ...(e.candidates !== undefined ? { candidates: e.candidates } : {}), ...(e.tested !== undefined ? { tested: e.tested } : {}) } };
    // A new stream (or a command) starts with an empty live region; `proposal` and `outcome`
    // end it in the same update that appends their item, so no frame shows text twice or not at all.
    // llm-jev (docs/LLM-JEV-DESIGN.md §9.3): a `generator:start` with `sample ≥ 1` runs beside sample 0 — it moves the
    // `sample k/N` counter and leaves sample 0's live buffer alone; `samples > 1` sets the counter, `proposal` clears it.
    case 'generator:start': {
      const sampling = e.samples === undefined ? next.sampling : e.samples > 1 ? { k: (e.sample ?? 0) + 1, n: e.samples } : null;
      const cleared = (e.sample ?? 0) >= 1 || (next.live === '' && next.toolChars === 0 && next.synth === null) ? next : { ...next, live: '', toolChars: 0, synth: null };
      return sampling === cleared.sampling || (sampling !== null && cleared.sampling !== null && sampling.k === cleared.sampling.k && sampling.n === cleared.sampling.n) ? cleared : { ...cleared, sampling };
    }
    case 'proposal':
      return next.live !== '' || next.toolChars !== 0 || next.synth !== null || next.sampling !== null ? { ...next, live: '', toolChars: 0, synth: null, sampling: null } : next;
    case 'exec:start':
    case 'outcome':
      return next.live !== '' || next.toolChars !== 0 || next.synth !== null ? { ...next, live: '', toolChars: 0, synth: null } : next;
    // Cumulative count from the engine; the live region shows `streaming action… N chars` while the text buffer is empty
    // (llm-jev: only sample 0's count reaches the live region).
    case 'generator:tool-delta':
      if ((e.sample ?? 0) >= 1) return next;
      return next.toolChars === e.chars ? next : { ...next, toolChars: e.chars };
    case 'step:end': {
      const fold = foldLoopStep(next.loopFold, e.record);
      const changed = e.record.outcome?.status === 'executed' && e.record.outcome.changedFiles.length > 0;
      return {
        ...next,
        sampling: null,
        loopFold: fold,
        loop: loopView(fold),
        timeline: foldStepEnd(next.timeline, e.record),
        plan: next.plan ? foldPlanRecord(next.plan, e.record) : next.plan,
        changedSteps: changed && !next.changedSteps.includes(e.record.step) ? [...next.changedSteps, e.record.step] : next.changedSteps,
        step: Math.max(next.step, e.record.step),
      };
    }
    case 'plan': {
      const fold = foldLoopPlan(next.loopFold, e.plan.harnessProblems.some((h) => h.kind === 'replan'));
      return { ...next, plan: { ...(next.plan ?? {}), step: e.step, plan: e.plan }, loopFold: fold, loop: loopView(fold) };
    }
    case 'replan': {
      const fold = foldLoopReplan(next.loopFold, e.step, e.directive);
      return { ...next, loopFold: fold, loop: loopView(fold) };
    }
    case 'steer:queued':
      return { ...next, queue: [...next.queue.filter((d) => d.index !== e.index), { text: e.text, at: new Date(now).toISOString(), index: e.index, step: e.step }].slice(-8) };
    case 'steer:withdrawn':
      return { ...next, queue: next.queue.filter((d) => d.index !== e.index) };
    case 'steer:applied': {
      const fold = foldLoopSteer(next.loopFold);
      return { ...next, queue: [], loopFold: fold, loop: null };
    }
    case 'pause:requested':
      return next.run === 'live' || next.run === 'starting' ? { ...next, run: 'pausing' } : next;
    case 'confirm:request': {
      if (next.pendingConfirm?.id === e.request.id) return next;
      const base = endSplash(next.pendingReview !== null ? clearReview(next) : next);
      return { ...base, pendingConfirm: e.request, pendingReview: e.request, visibleAt: Math.max(now, base.lastKeystrokeAt + REVIEW_DEFER_MS) };
    }
    case 'confirm:resolved':
      return next.pendingConfirm?.id === e.id || next.pendingReview?.id === e.id ? clearReview(next) : next;
    case 'retry':
      return { ...next, retrying: retryViewFrom(e, next.retrying, now) };
    case 'retry:settled':
      return { ...next, retrying: null };
    case 'budget:warn':
      return e.scope === 'session' ? { ...next, spend: { ...next.spend, session: { totalUsd: e.spentUsd, capUsd: e.capUsd } } } : next;
    case 'budget:stop':
      return e.scope === 'session' ? { ...next, spend: { ...next.spend, session: { totalUsd: e.spentUsd, capUsd: e.capUsd } } } : next;
    case 'budget:clamp':
      return { ...next, spend: { ...next.spend, session: { totalUsd: e.sessionSpentUsd, capUsd: e.sessionCapUsd } } };
    case 'blocking:request':
      return { ...endSplash(next), blocking: e.request, overlay: 'blocking', overlayArmed: false, unauthorized: next.unauthorized || e.request.kind === 'key-rejected' };
    case 'blocking:resolved':
      return next.blocking !== null && next.blocking.id === e.id ? { ...next, blocking: null, overlay: next.overlay === 'blocking' ? 'none' : next.overlay } : next;
    case 'notice':
      if (e.kind === 'checkpoint:degraded') return { ...next, errors: next.errors + 1, diskErrors: next.diskErrors + 1 };
      if (e.kind === 'checkpoint:restored') return { ...next, diskErrors: 0 };
      return next;
    case 'error':
      return e.fatal ? next : { ...next, errors: next.errors + 1 };
    case 'run:end':
      return {
        ...next,
        done: e.result,
        doneExitCode: e.exitCode ?? null,
        run: 'none',
        pendingConfirm: null,
        pendingReview: null,
        visibleAt: null,
        overlay: next.overlay === 'review' || next.overlay === 'blocking' || next.overlay === 'exitConfirm' ? 'none' : next.overlay,
        overlayArmed: next.overlay === 'review' || next.overlay === 'blocking' || next.overlay === 'exitConfirm' ? false : next.overlayArmed,
        expanded: false,
        noteMode: false,
        live: '',
        toolChars: 0,
        synth: null,
        sampling: null,
        retrying: null,
        blocking: null,
        queue: [],
        paths: e.paths ?? null,
        step: Math.max(next.step, e.result.steps),
        runsEnded: next.runsEnded + 1,
      };
    default:
      return next;
  }
}

// ---------------------------------------------------------------------------------------
// Event bus: attach(engine) may be called after render(); events before the App subscribes are replayed.
// TUI-DESIGN §4.8: `suspend()` buffers events while `suspendTerminal` is active; `resume()` flushes them in order.
// ---------------------------------------------------------------------------------------

export interface EventSource {
  subscribe(fn: (e: EngineEvent) => void): () => void;
}
export interface EventBus extends EventSource {
  emit(e: EngineEvent): void;
  /** §4.8: hold deliveries (an external editor / pager owns the terminal) */
  suspend(): void;
  /** deliver the held events in order */
  resume(): void;
  readonly suspended: boolean;
}

const BUS_REPLAY_MAX = 10_000;

export function createEventBus(): EventBus {
  const listeners = new Set<(e: EngineEvent) => void>();
  let backlog: EngineEvent[] = [];
  let suspended = false;
  const deliver = (e: EngineEvent): void => {
    for (const fn of [...listeners]) fn(e);
  };
  const push = (e: EngineEvent): void => {
    backlog.push(e);
    if (backlog.length > BUS_REPLAY_MAX) backlog.shift();
  };
  const flush = (): void => {
    if (listeners.size === 0 || suspended) return;
    const replay = backlog;
    backlog = [];
    for (const e of replay) deliver(e);
  };
  return {
    subscribe(fn) {
      listeners.add(fn);
      flush();
      return () => {
        listeners.delete(fn);
      };
    },
    emit(e) {
      if (listeners.size === 0 || suspended) {
        push(e);
        return;
      }
      deliver(e);
    },
    suspend() {
      suspended = true;
    },
    resume() {
      suspended = false;
      flush();
    },
    get suspended() {
      return suspended;
    },
  };
}

// ---------------------------------------------------------------------------------------
// TUI Confirmer (TUI-DESIGN §6.2, §6.4, §15 item 6)
// ---------------------------------------------------------------------------------------

export interface TuiConfirmer extends Confirmer {
  /** settle the pending request; false when no request with that id is pending */
  resolve(id: string, approved: boolean): boolean;
  /** §6.4: settle with a note (`d`); false when no request with that id is pending */
  resolveDetailed(id: string, outcome: ConfirmOutcome): boolean;
  confirmDetailed(req: ConfirmRequest, opts: { signal: AbortSignal }): Promise<ConfirmOutcome>;
  onRequest(fn: (req: ConfirmRequest) => void): () => void;
  pending(): ConfirmRequest | null;
}

export interface TuiConfirmerOptions {
  /** decline automatically after this many ms (stdin not a TTY); null = wait for y/n */
  autoDeclineMs?: number | null;
  /** shown in the declined reason; 'reviewer' on a TTY, 'no reviewer (stdin not a TTY)' on a pipe */
  identity?: string;
}

export function createTuiConfirmer(opts: TuiConfirmerOptions = {}): TuiConfirmer {
  const autoDecline = opts.autoDeclineMs ?? null;
  const listeners = new Set<(req: ConfirmRequest) => void>();
  let pending: { req: ConfirmRequest; settle: (outcome: ConfirmOutcome) => void } | null = null;

  const confirmDetailed = (req: ConfirmRequest, { signal }: { signal: AbortSignal }): Promise<ConfirmOutcome> => {
    if (signal.aborted) return Promise.reject(signal.reason instanceof AbortError ? signal.reason : new AbortError('signal'));
    // The engine is sequential; a second request while one is pending means the first can
    // no longer be answered by anyone, so it is declined (never approved) rather than left hanging.
    pending?.settle({ approved: false });
    return new Promise<ConfirmOutcome>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
        if (pending?.req.id === req.id) pending = null;
      };
      // The S4 Ctrl-C path (§3.3): the engine's signal rejects the pending confirm(); the rejected promise is the decline.
      const onAbort = (): void => {
        cleanup();
        reject(signal.reason instanceof AbortError ? signal.reason : new AbortError('signal'));
      };
      pending = {
        req,
        settle: (outcome) => {
          cleanup();
          resolve(outcome.note !== undefined && outcome.note !== '' ? { approved: outcome.approved, note: outcome.note } : { approved: outcome.approved });
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (autoDecline !== null) {
        timer = setTimeout(() => pending?.req.id === req.id && pending.settle({ approved: false }), Math.max(0, autoDecline));
        timer.unref();
      }
      for (const fn of [...listeners]) fn(req);
    });
  };

  return {
    identity: opts.identity ?? IDENTITY_REVIEWER,
    pending: () => pending?.req ?? null,
    onRequest(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    resolve(id, approved) {
      if (!pending || pending.req.id !== id) return false;
      pending.settle({ approved });
      return true;
    },
    resolveDetailed(id, outcome) {
      if (!pending || pending.req.id !== id) return false;
      // never an approval with a note, never a note that is not one clipped line (§6.4)
      const note = outcome.note === undefined ? undefined : sanitizeStream(outcome.note).replace(/\s*\n\s*/g, ' ').trim().slice(0, 600);
      pending.settle(note !== undefined && note !== '' ? { approved: outcome.approved, note } : { approved: outcome.approved });
      return true;
    },
    confirmDetailed,
    confirm(req, o) {
      return confirmDetailed(req, o).then((r) => r.approved);
    },
  };
}

// ---------------------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------------------

function appendTail(buf: string, text: string): string {
  // Command output and generator text are untrusted: strip escapes before they can reach the frame.
  const joined = buf + sanitizeStream(text);
  return joined.length > LIVE_BUFFER_MAX ? joined.slice(joined.length - LIVE_BUFFER_MAX) : joined;
}

export interface UseEngineOptions {
  mode?: 'session' | 'one-shot';
  /** injected clock (tests) */
  now?: () => number;
  /** 50 (default) or 250 under reduced motion (§14.2) */
  flushMs?: number;
  /** the 1 Hz tick; 0 disables it (tests drive `tick` themselves) */
  tickMs?: number;
  /** TUI-DESIGN-2 §1.5: `launch.modeHint` for the first frame's badge */
  modeHint?: EngineMode;
  /** TUI-DESIGN-2 §5.3: `running` in the boxed tier with motion allowed */
  splash?: SplashState;
}

/**
 * Feeds the reducer from an EventSource. `generator:delta` and `exec:output` accumulate in a closure buffer
 * (and `generator:tool-delta` in a counter) and reach React through one `live` dispatch per LIVE_FLUSH_MS at
 * most; every other event is one `event` dispatch stamped with the clock. Owns the 1 Hz `tick` (through
 * `retry.ts`'s ticker) and the §6.3 review deferral: `review:visible` fires once `now ≥ visibleAt` and no key
 * arrived for `REVIEW_RECHECK_MS`.
 */
export function useEngine(source: EventSource, confirmer: TuiConfirmer, task: string, resumeId: string | null, opts: UseEngineOptions = {}): { state: UiState; dispatch: (a: UiAction) => void } {
  const now = opts.now ?? Date.now;
  const [state, dispatch] = useReducer(uiReducer, null, () => initialUiState(task, resumeId, { ...(opts.mode ? { mode: opts.mode } : {}), nowMs: now(), ...(opts.modeHint ? { modeHint: opts.modeHint } : {}), ...(opts.splash ? { splash: opts.splash } : {}) }));
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    let buffer = '';
    let toolChars = 0;
    let timer: NodeJS.Timeout | null = null;
    const flushMs = opts.flushMs ?? LIVE_FLUSH_MS;
    const flush = (): void => {
      timer = null;
      dispatch({ type: 'live', text: buffer, toolChars });
    };
    const schedule = (): void => {
      if (timer === null) timer = setTimeout(flush, flushMs);
    };
    const clearLive = (): void => {
      buffer = '';
      toolChars = 0;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const unsubscribe = source.subscribe((e) => {
      switch (e.type) {
        // llm-jev (docs/LLM-JEV-DESIGN.md §9.3): only sample 0 (or an unsampled call) streams into the live region;
        // samples ≥ 1 are counted by the reducer's `sampling` and never touch the buffer
        case 'generator:delta':
          if ((e.sample ?? 0) >= 1) return;
          buffer = appendTail(buffer, e.text);
          schedule();
          return;
        case 'exec:output':
          buffer = appendTail(buffer, e.chunk);
          schedule();
          return;
        case 'generator:tool-delta':
          if ((e.sample ?? 0) >= 1) return;
          toolChars = e.chars;
          schedule();
          return;
        case 'generator:start':
          if ((e.sample ?? 0) >= 1) {
            dispatch({ type: 'event', event: e, at: nowRef.current() });
            return;
          }
          clearLive();
          dispatch({ type: 'event', event: e, at: nowRef.current() });
          return;
        case 'exec:start':
        case 'proposal':
        case 'outcome':
        case 'run:end':
          clearLive();
          dispatch({ type: 'event', event: e, at: nowRef.current() });
          return;
        default:
          dispatch({ type: 'event', event: e, at: nowRef.current() });
      }
    });
    const unsubscribeConfirm = confirmer.onRequest((request) => dispatch({ type: 'confirm:request', request, at: nowRef.current() }));
    return () => {
      unsubscribe();
      unsubscribeConfirm();
      if (timer !== null) clearTimeout(timer);
    };
  }, [source, confirmer, opts.flushMs]);

  // the 1 Hz tick (§15 item 20 `nowMs`): wall clock, toast expiry, retry countdown
  const tickMs = opts.tickMs ?? TICK_MS;
  useEffect(() => {
    if (tickMs <= 0) return undefined;
    return startTicker(() => dispatch({ type: 'tick', now: nowRef.current() }), tickMs);
  }, [tickMs]);

  // §6.3 deferral: the box renders once `now ≥ visibleAt`, the input queue is drained (no key for 100 ms) and no other
  // overlay is open (its resolver would be orphaned); the effect re-arms when the overlay closes.
  const pendingId = state.pendingReview?.id ?? null;
  const { visibleAt, lastKeystrokeAt, overlay } = state;
  useEffect(() => {
    if (pendingId === null || overlay !== 'none' || visibleAt === null) return undefined;
    const t = nowRef.current();
    const wait = Math.max(visibleAt - t, lastKeystrokeAt + REVIEW_RECHECK_MS - t, 0);
    const h = setTimeout(() => dispatch({ type: 'review:visible' }), wait);
    return () => clearTimeout(h);
  }, [pendingId, visibleAt, lastKeystrokeAt, overlay]);

  return { state, dispatch };
}
