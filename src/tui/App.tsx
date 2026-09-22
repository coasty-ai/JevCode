/**
 * The one Ink render of JevCode (TUI-DESIGN §1 entry points, §2 layout, §3 keys, §4 composer, §5 palette, §6 review,
 * §7 pane / status, §8.4 picker, §11.1 wizard, §13.2–13.4 retry / blocking / PaneBoundary, §14 terminal hygiene,
 * §15 item 16 renderer wiring, §15.2 App.tsx row; DESIGN §10, §12): the first frame from argv / env / isTTY / cwd
 * only (no config or file read before `firstFrame()` resolves), panes under a `rows − 2` budget of fixed-height
 * overflow-hidden boxes allocated by `computeLayout`, `useWindowSize()` for the geometry, one `useInput` and one
 * `usePaste` routed through `resolveKey` / `reduceInterrupts` (never handler order), the Esc 30 ms re-buffer,
 * Ctrl+L = `useStdout().write('')` (erase-lines + repaint, never a clear), the key-class trace only, the real
 * cursor through the single `useCursor` (placed by the composer / note field / masked field during render), a
 * `PaneBoundary` around every pane, and zero terminal clears after the first frame. `createTuiRenderer(opts)`
 * returns the `Renderer` with `setHost` / `setUi` / `notify` and the session hooks the controller drives.
 *
 * FIX pass (review findings): a submission that never becomes a run returns to idle (`run:idle`) and `starting` follows
 * the S0 key rules; a coalesced `useInput` chunk is split into its keys (`splitInputChunk`); the pure line builders run
 * under `guard()` so a throw degrades one pane (§13.4 at the App level, `render:<pane>:lines`); the note field masks its
 * secret spans and Ctrl-C in it cancels the note (F5 reads the stashed draft); `[r] retry now` is wired; `/steer` passes
 * the gate; history entries follow `addSecret`; Ctrl+O appends the recent warnings/errors (§7.7); the screen-reader
 * review answers by typed line (§6.5); `unmount()` flushes the run:end frame; a shrink costs Ink's one clear only.
 */
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Text, render, useApp, useCursor, useInput, usePaste, useStdin, useStdout, useWindowSize } from 'ink';
import type { Instance, Key } from 'ink';
import type { BlockingAnswer, BlockingRequest, Engine, EngineMode, LaunchSettings, Renderer, RendererOptions, SecretHit, SessionHost, SessionRow, UiConfig, UiLabel } from '../core/types.js';
import { VERSION } from '../version.js';
import { detectSecrets, patternRedact } from '../core/redact.js';
import { createLog, nullLog, type KeyClass, type Log } from '../core/log.js';
import { resolveLaunchSettings } from '../config/launch.js';
import { DEFAULT_MODE } from '../config/defaults.js';
import type { TrustInputs } from '../config/trust.js';
import { REWIND_CHOICE, type RewindStep } from '../undo/plan.js';
import { bannerRow } from './pane/banner.js';
import { defaultTab, cycleTab } from './pane/model.js';
import { argTokenOf, argValues, helpLines, paletteGhostFor, paletteMatches, type PaletteState } from './commands/palette.js';
import type { CommandAction, DispatchContext } from './commands/dispatch.js';
import { completeDraft, dispatchCtxOf, recentCommands } from './commands/local.js';
import { rank } from './commands/fuzzy.js';
// TUI-DESIGN-4 §4.2 (D-X): the palette's Enter-cycling state machine, pure
import { PALETTE_PAGE, moveIndex, paletteNavState, paletteStep, type NavKey } from './commands/nav.js';
import { commandToken } from './commands/parse.js';
import { findCommand } from './commands/registry.js';
import { Composer, draftRows, hitSpans, openExternalEditor, promptFor, useComposer, type ComposerMode } from './composer/Composer.js';
import { Console, pickerConsoleTitle, wizardConsoleTitle } from './Console.js';
// TUI-DESIGN-4 §2.5 (P-R6): the read-only-wizard toast at minsize
import { WIZARD_MINSIZE_TOAST } from './onboarding/lines.js';
import { consoleInnerWidth } from './console-lines.js';
import { attentionAt, useIdleLoop, useMotion } from './motion.js';
import { SPLASH_MS, WORDMARK_MIN_COLUMNS, brandSpan, splashFrame, type GridBand, type SplashSpan } from './splash.js';
import { guardStdout, type GuardedStream } from './scrollback-guard.js';
import { computeFullLayout, type FullLayout } from './fullscreen/layout.js';
import { selectRenderer } from './fullscreen/select.js';
import { Viewport } from './fullscreen/ViewportBox.js';
import { applyScrollAt, emptyIndex, positionRungs, rebuildFor, resolveTop, type ScrollKey, type ViewportIndex } from './fullscreen/viewport.js';
import { wordmarkFrame, wordmarkWanted, type WordmarkSetting } from './wordmark.js';
import { nextPanel, parsePanelCommand } from './pane/commands.js';
import { createBuffer, type Snapshot } from './composer/buffer.js';
import { routeSend, routeSubmit, type SubmitDecision } from './composer/submit.js';
import { stringWidth } from './composer/width.js';
import { colorDepth, colorEnabled, type ColorDepth } from './color-shim.js';
import { GLYPHS, glyphSet, type GlyphSet } from './glyphs.js';
import { DEFAULT_BINDINGS, type Bindings } from './keys/bindings.js';
import { interruptHint, type InterruptAction } from './keys/interrupts.js';
import { initialKeyState, resolveKey, type Armed, type KeyAction, type KeyEvent, type KeyState } from './keys/resolve.js';
import { CAP, chromeRows, computeLayout, composerTop, consoleTop, isCollapsingOverlay, type Layout, type LayoutInput, type OverlayKind } from './layout.js';
import { createNotifier, createNotifyTimers } from './notify.js';
import { Overlay, overlayPreviewWant, overlayWant, type IntakeOverlay, type OverlayData } from './Overlay.js';
import { Pane, RULE_MAX_CELLS, paneStateOf, plainRule, ruleRowText } from './Pane.js';
import { PaneBoundary, RENDER_FAULTS_FIRED, renderFaultFor, type PaneFailure } from './PaneBoundary.js';
import { INITIAL_PICKER, PICKER_PANE_WANT, moveRunsToTrash, pickerLines, pickerReducer, pickerRule, readPickerPreview, selectedRewindStep, selectedSession, visibleRewindSteps, visibleSessions } from './Picker.js';
import { IDENTITY_NO_TTY, formatTranscriptItem, headerItem, sanitizeStream, sessionHeaderItem, transcriptDumpChunks, type TranscriptItem, type TranscriptLevel } from './plain.js';
import { maskGlyphFor, maskHits, type ReviewNote } from './Review.js';
import type { FollowupInput } from './review/lines.js';
import { reviewRowForDigit } from './review/lines.js';
import { retryLiveLines } from './retry.js';
import { gateLines, GATE_DISMISS_TIP } from './secrets/gate-lines.js';
import { copyRedacted } from './secrets/clipboard.js';
import { spinnerActive, useSpinner } from './spinner.js';
import { kShort, modeBadge, statusLineText, type StatusLineOptions, type StatusLineState } from './status/lines.js';
import { StatusLine, statusView } from './StatusLine.js';
import { installTerminalHygiene, markAlternateScreen, printToPrimaryScreen, processRestoreTerminal, rearmRestoreTerminal, restoreTerminal, suspendProcess, waitForAnyKey, writeCursorShape, type TerminalHygiene } from './terminal.js';
import { themeFor, textProps, type ColorRole, type Theme } from './theme.js';
import { TOAST_ERROR_MS, TOAST_INFO_MS } from './toasts.js';
import { Transcript } from './Transcript.js';
import { useGitHead } from './useGitHead.js';
import { createEventBus, createTuiConfirmer, useEngine, useVisibleItems, type EventBus, type EventSource, type QueueEntry, type RunPhase, type TuiConfirmer, type UiAction, type UiState } from './useEngine.js';
import { useWizard, type WizardDetect, type WizardHost, type WizardReopenOptions } from './onboarding/Wizard.js';
import { stepWhyBlocks, whyBlock, whyErrorText } from './why.js';

export const DEFAULT_ROWS = 24;
export const DEFAULT_COLUMNS = 80;

/**
 * TUI-DESIGN-4 §2.2 P-R1: **the** monotonic clock of this round, defined once and used by both timing sites —
 * P-R1's 8 ms synchronous-commit storm guard and §7.8's 45 s submission watchdog. It is deliberately NOT the
 * injectable `p.now ?? Date.now` of the App (a wall clock): §7.8 edge 4 forbids a wall clock for a deadline because
 * an NTP jump fires it early or late, and the same hazard would disable an 8 ms guard for the length of the jump.
 */
export function nowMs(): number {
  return performance.now();
}

/**
 * §2.2 P-R1: the storm guard. `instance.rerender` is a synchronous `updateContainerSync` + `flushSyncWork`, and §2.0
 * measured ~2 SIGWINCH events per driver resize, so 20 driver resizes are ~40 events; the debounce catches the tail
 * either way.
 */
export const SYNC_COMMIT_MIN_MS = 8;

/**
 * §2.2 P-R1: does this SIGWINCH get a synchronous commit? **Any shrinking dimension** (the stale, taller tree must
 * never be painted at the new viewport — that is the one clear per shrink the gate allows) **and every width
 * change** (P-R2 deleted `wrapColumns`, so the draft and the box edges follow the same `columns`; A2's `out/tear`
 * capture found the stray `│` with dead space after it on a width **grow**, which is why a grow counts too).
 * Rate-limited by `SYNC_COMMIT_MIN_MS`: `instance.rerender` is a synchronous `updateContainerSync` +
 * `flushSyncWork`, and §2.0 measured ~2 SIGWINCH events per driver resize, so a 20-resize drag is ~40 events.
 *
 * Exported because it IS the decision: the listener around it is three lines of plumbing.
 */
export function shouldSyncCommit(prev: { rows: number; columns: number }, next: { rows: number; columns: number }, now: number, lastSyncAt: number): boolean {
  const shrank = next.rows < prev.rows || next.columns < prev.columns;
  const widthChanged = next.columns !== prev.columns;
  return (shrank || widthChanged) && now - lastSyncAt >= SYNC_COMMIT_MIN_MS;
}
export const LIVE_ROWS = CAP.live;
export const STATUS_ROWS = 1;
/** The rule separating scrollback (<Static>) from the live panes; also how tests find the dynamic region. */
export const RULE_ROWS = 1;
export const RULE_CHAR = '─';
export const UNMOUNT_TIMEOUT_MS = 2000;
/** §6.3: a `y` within this many ms of the Enter that opened a y-gated overlay is text. */
export const GATE_ARM_MS = 150;
/** §6.3: the review box arms this long after the commit that drew it unless Ink reports the frame flushed earlier */
export const REVIEW_ARM_MS = 150;
/** §3.3: the Esc re-buffer. */
export const ESC_REBUFFER_MS = 30;
/** §24: the two exit items. */
export const EXITED_CTRL_C = 'exited on Ctrl-C ×2';
export const EXITED_CTRL_D = 'exited on Ctrl-D ×2';
/** §24 "Queue rows". */
export const TAKES_BACK = '[↑ takes back]';
/** §4.5 step 1 (amended): an unbracketed chunk with an interior newline is paste-like; its trailing CR became a newline, so nothing was sent. */
export const COALESCED_ENTER_TOAST = 'input arrived in one chunk; Enter kept as a newline — press Enter to send';
/** §7.7 Ctrl+O: the recent warnings / errors appended after the step's /why blocks (the `!n` badge clears). */
export const RECENT_WARNINGS_KEPT = 8;
/** §6.5 / §24 "Review box" SR: the numbered list and the prompt, appended as `<Static>` lines when the review arms. */
export const SR_REVIEW_MENU = '1 approve  2 decline  3 decline with a note';
export const SR_REVIEW_PROMPT = 'Enter selection (1-3):';
/** §14.2 screen reader: one BEL when the review opens. */
export const BEL = '\x07';
/** TUI-DESIGN-2 §3.1 row 11 / §12 "Status": Enter while a submission is still thinking. */
export const STILL_THINKING_TOAST = 'one moment — still thinking';
/** TUI-DESIGN-3 §5.2 A5: at `run:start` a 12-cell `borderFocus` band travels the rule row's `─` cells left → right for 300 ms (6 frames at 50 ms). */
export const RUN_START_SWEEP_MS = 300;
export const RUN_START_SWEEP_CELLS = 12;
/** TUI-DESIGN-3 §5.2 A6: at `run:end` the console edges fade `borderFocus` → `accent2` → `border` at 70 ms steps (3 frames). */
export const RUN_END_FADE_MS = 210;
export const RUN_END_FADE_STEP_MS = 70;
/** TUI-DESIGN-3 §5.2 A4: the streaming caret blinks at 1 Hz on the 8 fps spinner tick — on while `frame % 8 < 4`. */
export const STREAM_CARET_PERIOD = 8;

/** TUI-DESIGN-3 §5.2 A5: the `─` cells lit `borderFocus` at elapsed `t` of the run-start sweep — `[from, from + 12)` over the row's cells; null once settled. */
export function runStartBand(t: number, cells: number, durationMs: number = RUN_START_SWEEP_MS, width: number = RUN_START_SWEEP_CELLS): GridBand | null {
  if (!Number.isFinite(t) || t < 0 || t >= durationMs || cells <= 0) return null;
  const travel = Math.max(0, cells - width);
  const from = Math.round((travel * t) / durationMs);
  return { from, to: Math.min(cells, from + width) };
}

/** TUI-DESIGN-3 §5.2 A6: the console edge role at elapsed `t` of the run-end fade — `borderFocus` < 70 · `accent2` < 140 · `border`. */
export function runEndEdgeRole(t: number): ColorRole {
  if (!Number.isFinite(t) || t < RUN_END_FADE_STEP_MS) return 'borderFocus';
  if (t < 2 * RUN_END_FADE_STEP_MS) return 'accent2';
  return 'border';
}

/** TUI-DESIGN-3 §5.2 A4: the streaming caret is on for the first half of every 8-frame period (500 ms on / 500 ms off at 8 fps); always on under reduced motion. */
export function streamCaretOn(spinnerFrame: number, reducedMotion: boolean): boolean {
  if (reducedMotion) return true;
  const f = Number.isFinite(spinnerFrame) ? Math.abs(Math.floor(spinnerFrame)) : 0;
  return f % STREAM_CARET_PERIOD < STREAM_CARET_PERIOD / 2;
}
/**
 * TUI-DESIGN-2 §3.1 / §4.9: an engine run owns the session — `live`, `aborting`, `pausing`. `starting` is a submission in
 * flight with no engine yet (the intake, a lookup or a reply under `thinking`, or the window before `run:start`), so it
 * follows the idle rules: `thinking` wins the status word, the placeholder and Ctrl-C ×1; the console border stays `border`.
 */
export function runIsLive(run: RunPhase): boolean {
  return run === 'live' || run === 'aborting' || run === 'pausing';
}
/**
 * TUI-DESIGN-4 §1.3.2: the fullscreen allocator's slots as the classic `Layout` the rest of the tree reads.
 * `consoleTop` / `composerTop` / `overlayTop` sum only the rows ABOVE a slot, so the mapping is order-free: the
 * header rides in `pane` (it is the wordmark slot, one tier up) and the viewport in `queue`. `live` and `banner`
 * have no fullscreen tenant. `budget` is `rows` itself, not `rows − 2`: `total === rows` EXACTLY is the whole point.
 */
export function fullLayoutAsLayout(f: FullLayout, rows: number): Layout {
  return {
    budget: Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0,
    degraded: f.degraded === 'minsize' ? 'minsize' : 'none',
    status: f.status,
    rule: f.rule,
    live: 0,
    banner: 0,
    pane: f.header,
    queue: f.viewport,
    overlay: f.overlay,
    preview: f.preview,
    composer: f.composer,
    chrome: f.chrome,
    gate: f.gate,
    total: f.total,
  };
}

/** §3.1 rows 1, 10, 11: a chat request is in flight — the phase is set and no engine run owns the session. */
export function chatThinking(s: Pick<UiState, 'run' | 'thinking'>): boolean {
  return s.thinking !== null && !runIsLive(s.run);
}
/** TUI-DESIGN-2 §3.7 / §12 "Transcript": the bubble after Esc on the intake card is the controller's; the App only restores the draft. */
export type IntakeAnswer = 'run' | 'chat' | 'keep';

/**
 * TUI-DESIGN-2 §1.5 / §5.3; TUI-DESIGN-3 §3.8: the launch members `launch.ts` adds (`modeHint`, `reducedMotion`, `ssh`); read
 * structurally so the first frame follows argv + env as soon as they land and falls back to `DEFAULT_MODE` / `screenReader` until then.
 */
interface LaunchExtras {
  screenReader: boolean;
  modeHint?: EngineMode;
  reducedMotion?: boolean;
  /** TUI-DESIGN-3 §3.2 twins: the SSH launch source — `ui.wordmark` defaults to `static` under it */
  ssh?: boolean;
}

/** TUI-DESIGN-2 §5.3 (fallback while `launch.reducedMotion` is S1's request): `--no-animation` / `--reduced-motion` on argv, then `JEVCODE_REDUCED_MOTION`, then the screen reader. */
export function reducedMotionFallback(env: NodeJS.ProcessEnv, argv: readonly string[] = process.argv): boolean {
  if (argv.includes('--no-animation') || argv.includes('--reduced-motion')) return true;
  const v = env['JEVCODE_REDUCED_MOTION'];
  if (typeof v === 'string' && v.trim() !== '') {
    const t = v.trim().toLowerCase();
    return !(t === '0' || t === 'false' || t === 'no' || t === 'off');
  }
  const sr = env['JEVCODE_SCREEN_READER'] ?? env['INK_SCREEN_READER'];
  if (typeof sr === 'string' && sr.trim() !== '') {
    const t = sr.trim().toLowerCase();
    return !(t === '0' || t === 'false' || t === 'no' || t === 'off');
  }
  return false;
}

/**
 * §4.8: the external editor's draft dir — `<runDir>/drafts` while a run is live (the run dir is `<runsDir>/<runId>`
 * until `run:end` carries `paths`), else `~/.jevcode/drafts`; never `<runDir>/tmp`. Pure.
 */
export function draftsDirFor(s: Pick<UiState, 'run' | 'paths' | 'runId'>, o: { home: string; runsDir?: string }): string {
  if (s.run !== 'none') {
    if (s.paths) return join(s.paths.runDir, 'drafts');
    if (s.runId !== null) return join(o.runsDir ?? join(o.home, '.jevcode', 'runs'), s.runId, 'drafts');
  }
  return join(o.home, '.jevcode', 'drafts');
}

/** §6.5: the answer a screen-reader line gives, or null when the line is text / a steer (re-announce). */
export function srReviewAnswer(line: string): 'approve' | 'decline' | 'note' | null {
  const t = line.trim();
  if (t === '1' || t === 'y') return 'approve';
  if (t === '2' || t === 'n') return 'decline';
  if (t === '3') return 'note';
  return null;
}
/** `JEVCODE_FAULT=render:<pane>:lines` makes the pane's pure line builder throw once (the App-level guard of §13.4). */
export function builderFaultFor(pane: string): string {
  return `${renderFaultFor(pane)}:lines`;
}

/**
 * Last `rows` lines of the stream, or the bucketed char count while no line break has arrived yet (§7:
 * `streaming… 1.2k chars`). A lone `\r` counts as a line break so a progress bar shows its latest state. Lines
 * are cut to `columns + 1` characters before Ink measures them (the +1 keeps Ink's truncation ellipsis), so a
 * 64 KB unbroken tail never costs a 64 KB width measurement per frame. With an empty text buffer and
 * tool-argument chars streaming, the region reads `streaming action… N chars`. In jev-only there is no generator
 * stream: with an empty buffer the region shows the last `synth` line of the step (docs/JEV-ONLY.md). In llm-jev
 * (docs/LLM-JEV-DESIGN.md §9.3) the bucketed rows carry ` · sample k/N` while `sampling` is set (null elsewhere: every
 * other string is unchanged).
 */
export function liveLines(live: string, rows: number, columns: number = DEFAULT_COLUMNS, toolChars = 0, synth: string | null = null, sampling: { k: number; n: number } | null = null): string[] {
  if (rows <= 0) return [];
  const sample = sampling === null ? '' : ` · sample ${sampling.k}/${sampling.n}`;
  if (live === '') {
    if (toolChars > 0) return [`streaming action… ${kShort(toolChars)} chars${sample}`];
    return synth !== null ? [synth] : [];
  }
  if (!/[\r\n]/.test(live)) return [`streaming… ${kShort(live.length)} chars${sample}`];
  const parts = live.split(/\r\n|\r|\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  const max = Math.max(1, Math.floor(columns)) + 1;
  return parts.slice(-rows).map((l) => (l.length > max ? l.slice(0, max) : l));
}

/**
 * §24 "Queue rows": `↑1 queued for step N: <text>`, the newest with `[↑ takes back]` right-aligned. `N` is the step the
 * engine named in `steer:queued` (carried on the entry); `step` is the fallback for entries without one.
 */
export function queueRows(queue: readonly Pick<QueueEntry, 'text' | 'step'>[], step: number, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  const n = Math.max(0, Math.floor(rows));
  if (n === 0 || queue.length === 0) return [];
  const shown = queue.slice(-n);
  const first = queue.length - shown.length;
  return shown.map((d, i) => {
    const idx = first + i + 1;
    const text = `${g.up}${idx} queued for step ${d.step ?? step}: ${sanitizeStream(d.text).replace(/\s+/g, ' ')}`;
    if (first + i !== queue.length - 1) return text;
    const marker = g.mode === 'ascii' ? '[^ takes back]' : TAKES_BACK;
    const w = stringWidth(text);
    return w + 1 + marker.length <= columns ? `${text}${' '.repeat(columns - w - marker.length)}${marker}` : text;
  });
}

// ---------------------------------------------------------------------------------------
// Bridge: what the renderer hands the mounted App (host, ui, pending prompts, imperative commands)
// ---------------------------------------------------------------------------------------

export interface PickerOpen {
  kind: 'sessions' | 'rewind';
  sessions?: readonly SessionRow[];
  rewindSteps?: readonly RewindStep[];
  workspace: string;
  sort?: 'updated' | 'created';
  /** Enter on a session row (`how` = 'enter' continue/follow-up, 'accept' = Tab kept filtering) */
  onOpen?: (session: SessionRow) => void;
  onRewind?: (step: RewindStep) => void;
  onRename?: (session: SessionRow, title: string) => void;
  /** `x` then `y`; default: move the run dirs to `<trashDir>` */
  onDelete?: (session: SessionRow) => void;
  onClose?: () => void;
  runsDir?: string;
  trashDir?: string;
}

type BridgeCommand =
  | { type: 'wizard'; detect: WizardDetect }
  | { type: 'wizard:reopen'; at: 'provider' | 'generator.apiKey' | 'decider.apiKey'; runLive: boolean; opts?: WizardReopenOptions }
  /** TUI-DESIGN-2 §3.7: the intake card; resolves with the key pressed (`keep` on Esc / Ctrl-C) */
  | { type: 'intake'; card: IntakeOverlay; resolve: (a: IntakeAnswer) => void }
  /** TUI-DESIGN-2 §6 item 11: `Renderer.restoreDraft` — Esc on the intake card puts the text back */
  | { type: 'restoreDraft'; text: string }
  | { type: 'picker'; open: PickerOpen }
  | { type: 'followup'; input: FollowupInput; resolve: (a: 'start' | 'raise' | 'cancel') => void }
  | { type: 'undo'; row: string; resolve: (a: 'yes' | 'no' | 'all' | 'skipRest' | 'abort') => void }
  | { type: 'exitConfirm'; resolve: (a: boolean) => void }
  | { type: 'blocking'; request: BlockingRequest; resolve: (a: BlockingAnswer) => void }
  | { type: 'suspend' }
  /** §4.10 / §10.2: the gate row for a task gated outside the composer (argv, --task-file); `resolve(true)` only on an armed `y` */
  | { type: 'secretGate'; hits: readonly SecretHit[]; resolve: (send: boolean) => void }
  /** TUI-DESIGN-3 §4.4 F10: `Renderer.setBindings` — the effective key table (a `keybindings.json` load or `/help reload`) */
  | { type: 'bindings'; bindings: Bindings }
  | { type: 'dispatch'; action: UiAction };

/** The renderer ↔ App channel (exported for tests: `createBridge(host, wizardHost)`). */
export interface Bridge {
  host: SessionHost | null;
  ui: UiConfig | null;
  wizardHost: WizardHost | null;
  gitDirs: { gitDir: string | null; commonDir: string | null };
  engine: Engine | null;
  listeners: Set<() => void>;
  queue: BridgeCommand[];
  handler: ((c: BridgeCommand) => void) | null;
  stateReader: (() => UiState) | null;
  /**
   * §14.1 / §18: the geometry written by the renderer's own `resize` listener, registered before Ink's; on a shrink in
   * rows the listener also commits the tree synchronously (`instance.rerender`), so Ink's `resized` repaint never paints
   * the stale, taller tree at the new viewport (one clear per shrink, never two). `useWindowSize()` is the source until
   * the first resize and in tests that mount <App> directly.
   */
  geometry: { rows: number; columns: number } | null;
  notify(): void;
  command(c: BridgeCommand): void;
}

export function createBridge(host: SessionHost | null, wizardHost: WizardHost | null): Bridge {
  const b: Bridge = {
    host,
    ui: null,
    wizardHost,
    gitDirs: { gitDir: null, commonDir: null },
    engine: null,
    listeners: new Set(),
    queue: [],
    handler: null,
    stateReader: null,
    geometry: null,
    notify() {
      for (const fn of [...b.listeners]) fn();
    },
    command(c) {
      if (b.handler) b.handler(c);
      else b.queue.push(c);
    },
  };
  return b;
}

/** `RendererOptions` plus the TUI-only knobs (cwd for the session header, the log, `JEVCODE_FAULT`, the wizard host, the home / runs dirs). */
export interface TuiRendererOptions extends RendererOptions {
  /** the directory the `chat` header names (default `process.cwd()`) */
  cwd?: string;
  log?: Log;
  /** `process.env.JEVCODE_FAULT` (`render:<pane>` throws once) */
  fault?: string;
  home?: string;
  runsDir?: string;
  wizardHost?: WizardHost;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** exit with no session host (one-shot idle Ctrl-C ×2 / Ctrl-D ×2 before the run) */
  onExit?: (code: number) => void;
  /** Ink's `interactive` override (tests) */
  interactive?: boolean;
  bindings?: Bindings;
}

/** The TUI renderer: `Renderer` plus the session hooks the controller drives (TUI-DESIGN §15 item 16 and the overlays of §3.3). */
export interface TuiRenderer extends Renderer {
  setHost(host: SessionHost): void;
  setUi(ui: UiConfig): void;
  notify(text: string, opts?: { level?: TranscriptLevel; detail?: string; label?: UiLabel }): void;
  dispatch(action: UiAction): void;
  state(): UiState | null;
  openWizard(detect: WizardDetect): void;
  reopenWizard(at: 'provider' | 'generator.apiKey' | 'decider.apiKey', runLive: boolean, opts?: WizardReopenOptions): void;
  openPicker(open: PickerOpen): void;
  /** TUI-DESIGN-2 §3.7: the intake card `run this as a task?`; `y` → run, `n` → chat, Esc / Ctrl-C → keep */
  promptIntake(card: IntakeOverlay): Promise<IntakeAnswer>;
  /** TUI-DESIGN-2 §6 item 11: put a submission's text back into the composer */
  restoreDraft(text: string): void;
  /** TUI-DESIGN-2 §6 item 11: the LLM turn's streamed text for the live region */
  live(text: string): void;
  /** §9.3: the follow-up box; resolves with the key pressed */
  confirmFollowUp(input: FollowupInput): Promise<'start' | 'raise' | 'cancel'>;
  /** §12.4: the one-row undo ask */
  promptUndo(row: string): Promise<'yes' | 'no' | 'all' | 'skipRest' | 'abort'>;
  /** §3.3 `/exit` while live: `a run is live: [y] abort and exit  [n] stay` */
  confirmExit(): Promise<boolean>;
  /** §13.3: the blocking pane's answer (the controller's `EngineOptions.blocker`) */
  blocking(request: BlockingRequest): Promise<BlockingAnswer>;
  setSessionSpend(session: { totalUsd: number; capUsd: number } | null): void;
  setGitDirs(dirs: { gitDir: string | null; commonDir: string | null }): void;
  setTitle(title: string | null): void;
  /**
   * §4.10 / §10.2 / §19.5: the gate row for a task gated before `run:ready` (argv, `--task-file`; the controller's
   * `Prompter.secretGate`). Resolves true only on a `y` that arrives on a committed frame ≥ 150 ms after the row was
   * drawn (§6.3); Enter / Esc / `n` / any other key, Ctrl-C and the unmount refuse.
   */
  promptSecretGate(hits: readonly SecretHit[]): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------------

export interface AppProps {
  task: string;
  resumeId: string | null;
  source: EventSource;
  confirmer: TuiConfirmer;
  onAbort: (reason: 'human_abort') => void;
  mode?: 'one-shot' | 'session';
  cwd?: string;
  launch?: LaunchSettings;
  bridge?: Bridge;
  log?: Log;
  fault?: string | undefined;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  home?: string;
  runsDir?: string;
  onExit?: (code: number) => void;
  bindings?: Bindings;
  /** tests: disable the 1 Hz tick */
  tickMs?: number;
  /**
   * TUI-DESIGN-4 §1.3: the renderer. `classic` (the default) is byte-for-byte round 3's tree — §1.3.5's discipline
   * and the whole risk mitigation for the second renderer. `fullscreen` swaps `<Static>` for `<Viewport>` and
   * `computeLayout` for `computeFullLayout`, and nothing else: Console, Overlay, Review, Composer, StatusLine,
   * `<Transcript>`'s builders and the key resolver are the same objects. `createTuiRenderer` decides (§1.3.1) —
   * Ink fixes `alternateScreen` in its constructor, so this prop is fixed for the life of the mount.
   */
  renderer?: 'classic' | 'fullscreen';
}

interface PaletteUi {
  mode: 'command' | 'mention' | 'rewind';
  selected: number;
  /** Esc remembers the token so `/` stays closed while it is unchanged (§5.3) */
  candidates: readonly string[];
  /** TUI-DESIGN-3 §4.1 rule 6: the Recent group, computed once at palette open (`recentCommands`) */
  recent?: readonly string[];
  /** TUI-DESIGN-3 §4.3: the argument stem Tab is cycling over (`completeDraft`); cleared when a value is accepted */
  stem?: string;
}

interface PendingGate {
  full: string;
  hits: readonly SecretHit[];
  openedAt: number;
  /** the history entry the send appends (a `/steer <text>` line is remembered as a command) */
  history?: { kind: 'prompt' | 'steer' | 'command'; text: string };
  /** a controller prompt (`promptSecretGate`): the answer goes here instead of the composer's send path; every close path settles it */
  resolve?: (send: boolean) => void;
}

interface NoteUi {
  stash: Snapshot;
  gate: readonly SecretHit[] | null;
  /** the note text once it passed the gate */
  pendingText: string | null;
}

const NOKEY: Key = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false };

function keyClassOf(input: string, key: Key, paste: boolean): KeyClass {
  if (paste) return 'paste';
  if (key.return) return 'return';
  if (key.backspace || key.delete) return 'backspace';
  if (key.escape) return 'escape';
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.pageUp || key.pageDown || key.home || key.end || key.tab) return 'arrow';
  if (key.ctrl || key.meta || key.super || key.hyper || (input.length === 1 && input < ' ')) return 'ctrl';
  return 'text';
}

/** The Ink `Key` flags that name a key (a chunk carrying one was parsed as that key and is never split). */
function hasNamedFlag(k: Key): boolean {
  return k.upArrow || k.downArrow || k.leftArrow || k.rightArrow || k.pageUp || k.pageDown || k.home || k.end || k.return || k.escape || k.tab || k.backspace || k.delete;
}

function ctrlLetterEvent(byte: string): KeyEvent {
  const code = byte.charCodeAt(0);
  return { input: String.fromCharCode(code + 'a'.charCodeAt(0) - 1), key: { ...NOKEY, ctrl: true } };
}

/** one control byte (`< 0x20` or `0x7f`, never `\t`) → its key event */
function controlByteEvent(byte: string): KeyEvent {
  switch (byte) {
    case '\r':
    case '\n':
      return { input: '', key: { ...NOKEY, return: true } };
    case '\x1b':
      return { input: '', key: { ...NOKEY, escape: true } };
    case '\x7f':
    case '\b':
      return { input: '', key: { ...NOKEY, backspace: true } };
    default:
      return byte >= '\x01' && byte <= '\x1a' ? ctrlLetterEvent(byte) : { input: byte, key: NOKEY };
  }
}

const HARD_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const ONE_LINE_TRAILING_NEWLINE_RE = /^([^\r\n]*)(?:\r\n|\r|\n)$/;

/** What one `useInput` delivery really carried (§4.5 step 1, amended; research 20 §2 on stdout backpressure). */
export interface SplitChunk {
  events: KeyEvent[];
  /** the chunk was paste-like (interior newline) and ended with a CR that became a newline: toast it */
  foldedEnter: boolean;
}

/**
 * §4.5 step 1 amended (finding 2): with bracketed paste on, an unbracketed multi-byte `useInput` chunk is coalesced
 * keystrokes — Node's blocking TTY stdout holds the event loop while a terminal does not drain, and the bytes typed
 * meanwhile arrive as one read — not a paste. A chunk with a control byte other than `\t`/`\r`/`\n` is split into its
 * text runs and keys (`\x03` → Ctrl-C, `\x04` → Ctrl-D, `\x1b` → Esc, `\x7f` → Backspace, other `\x01`–`\x1a` → their
 * Ctrl letter, `\r`/`\n` → Enter); a one-line chunk whose only newline is trailing is text then Enter; a chunk with
 * an interior newline stays paste-like (a terminal without 2004 pastes this way) and `foldedEnter` is set when it
 * ended with a CR. A lone control byte with no flags is one whose ESC prefix Ink stripped (`\x1b\x03` parses to
 * `\x03` with `ctrl: false`) and becomes Esc then the key; Ink's `meta && ctrl && letter` likewise. Named keys,
 * modifiers, single graphemes and text without control bytes pass through unchanged. Pure.
 */
export function splitInputChunk(input: string, key: Key): SplitChunk {
  const one: SplitChunk = { events: [{ input, key }], foldedEnter: false };
  if (key.meta && key.ctrl && input.length === 1 && !hasNamedFlag(key)) {
    return { events: [{ input: '', key: { ...NOKEY, escape: true } }, { input, key: { ...key, meta: false } }], foldedEnter: false };
  }
  if (hasNamedFlag(key) || key.ctrl || key.meta || key.super || key.hyper) return one;
  if (input.length === 0) return one;
  if (input.length === 1) {
    if (input === '\t' || input >= ' ') return one;
    // Ink stripped the ESC of an unparsed two-byte sequence: `ESC` then the control byte
    return { events: [{ input: '', key: { ...NOKEY, escape: true } }, controlByteEvent(input)], foldedEnter: false };
  }
  if (!/[\x00-\x08\x0a-\x1f\x7f]/.test(input)) return one; // text (or a real paste-like chunk with no control bytes): unchanged
  if (!HARD_CONTROL_RE.test(input)) {
    const m = ONE_LINE_TRAILING_NEWLINE_RE.exec(input);
    if (m) {
      const text = m[1] ?? '';
      const events: KeyEvent[] = text.length > 0 ? [{ input: text, key: NOKEY }] : [];
      events.push({ input: '', key: { ...NOKEY, return: true } });
      return { events, foldedEnter: false };
    }
    // interior newline(s): paste-like (§4.5 step 1); a trailing CR was the Enter the typist meant
    return { events: [{ input, key }], foldedEnter: /(?:\r\n|\r|\n)$/.test(input) };
  }
  const events: KeyEvent[] = [];
  let run = '';
  for (const ch of input) {
    if (ch === '\t' || (ch >= ' ' && ch !== '\x7f')) {
      run += ch;
      continue;
    }
    if (run.length > 0) {
      events.push({ input: run, key: NOKEY });
      run = '';
    }
    events.push(controlByteEvent(ch));
  }
  if (run.length > 0) events.push({ input: run, key: NOKEY });
  return { events, foldedEnter: false };
}

const EMPTY_BUFFER = createBuffer();

function useBridge(bridge: Bridge): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const fn = (): void => setTick((n) => n + 1);
    bridge.listeners.add(fn);
    return () => {
      bridge.listeners.delete(fn);
    };
  }, [bridge]);
  return tick;
}

export function App(p: AppProps): React.JSX.Element {
  const mode = p.mode ?? 'one-shot';
  const env = p.env ?? process.env;
  const now = p.now ?? Date.now;
  // one log object per mount: `onPaneFail` (finding 3) and the effects below key on its identity
  const log = useMemo(() => p.log ?? nullLog(), [p.log]);
  const bridgeRef = useRef<Bridge | null>(null);
  bridgeRef.current ??= p.bridge ?? createBridge(null, null);
  const bridge = bridgeRef.current;
  useBridge(bridge);
  const launch = p.launch ?? resolveLaunchSettings({}, env);
  const lx: LaunchExtras = launch;
  const ui = bridge.ui;
  const glyphs = glyphSet({ ascii: launch.ascii, screenReader: launch.screenReader });
  // frame 0 honours `--theme` / `JEVCODE_THEME` / COLORFGBG through `launch.themeHint`; the resolved `ui.theme` takes over at setUi
  const theme: Theme = themeFor(ui?.theme ?? launch.themeHint);
  const { stdout, write } = useStdout();
  const color = colorEnabled({ noColor: launch.noColor || ui?.noColor === true, env, stream: stdout });
  // TUI-DESIGN-2 §4.9: the depth is computed at mount and at `setUi` for `ui.noColor`; Ink downsamples a wrong guess
  const depth: ColorDepth = color ? colorDepth({ noColor: launch.noColor || ui?.noColor === true, env, stream: stdout }) : 0;
  // TUI-DESIGN-2 §5.3: `--no-animation` > `JEVCODE_REDUCED_MOTION` > `screenReader` at launch; the file key follows at `setUi`.
  // Until S1's `launch.reducedMotion` lands, the same two argv + env sources are read here (no file, no I/O — §1 holds).
  const launchReducedMotion = lx.reducedMotion ?? reducedMotionFallback(env);
  const reducedMotion = ui?.reducedMotion ?? launchReducedMotion ?? launch.screenReader;
  // §14.1: `useWindowSize()` is the geometry; after a SIGWINCH the renderer's early listener has already stored the new
  // numbers on the bridge (and, on a shrink, re-rendered synchronously), so this render already uses the new budget
  const windowSize = useWindowSize();
  const rows = bridge.geometry?.rows ?? windowSize.rows;
  const columns = bridge.geometry?.columns ?? windowSize.columns;
  // TUI-DESIGN-4 §1.3: the opt-in renderer, fixed at mount (`createTuiRenderer` decided it, §1.3.1). Every fullscreen
  // branch below is gated on this one boolean, so with `classic` the tree is byte-for-byte round 3's (§1.3.5).
  const fullscreen = (p.renderer ?? 'classic') === 'fullscreen';
  // TUI-DESIGN-2 §4.1: the chrome tier is a function of geometry alone (boxed ≥ 16 rows and ≥ 40 columns, never under a screen reader)
  const chrome = chromeRows(rows, columns, launch.screenReader);
  const boxed = chrome === CAP.chrome;
  const { isRawModeSupported } = useStdin();
  const { suspendTerminal, waitUntilRenderFlush } = useApp();
  const { setCursorPosition } = useCursor();
  // TUI-DESIGN-3 §4.4 F10: the effective bindings — the mount prop, then every `setBindings` the controller sends (a `keybindings.json`
  // load, `/help reload`); `resolveKey` and `helpLines` read this value, so a rebinding is honoured live
  const [bindings, setBindingsState] = useState<Bindings>(p.bindings ?? DEFAULT_BINDINGS);
  const propBindings = p.bindings;
  useEffect(() => {
    if (propBindings) setBindingsState(propBindings);
  }, [propBindings]);

  const { state, dispatch } = useEngine(p.source, p.confirmer, p.task, p.resumeId, {
    mode,
    now,
    flushMs: reducedMotion ? 250 : 50,
    ...(p.tickMs !== undefined ? { tickMs: p.tickMs } : {}),
    modeHint: lx.modeHint ?? DEFAULT_MODE,
    // TUI-DESIGN-2 §5.3: the first frame is splash frame 0 in the boxed tier; reduced motion / a screen reader mount `done`
    splash: boxed && !launchReducedMotion && !launch.screenReader ? 'running' : 'done',
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  bridge.stateReader = () => stateRef.current;
  // TUI-DESIGN-2 §5.1–5.3: the splash's time comes from Ink's shared animation timer; the settle effect ends it in the same
  // commit `settled` first turns true (never the 1 Hz tick); the file-level reduced-motion key snaps it to `done` at setUi
  const splashRunning = state.splash === 'running';
  const motion = useMotion(splashRunning, SPLASH_MS);
  const settled = motion.settled;
  useEffect(() => {
    if (splashRunning && (settled || ui?.reducedMotion === true)) dispatch({ type: 'splash:done' });
  }, [splashRunning, settled, ui?.reducedMotion, dispatch]);

  const host = bridge.host;
  const detect = useCallback((s: string): readonly SecretHit[] => (bridge.host ? bridge.host.detectSecrets(s) : detectSecrets(s)), [bridge]);
  const redact = useCallback((s: string): string => (bridge.host ? bridge.host.redact(s) : patternRedact(s)), [bridge]);
  const composer = useComposer({ history: () => bridge.host?.history() ?? null, detect, now });
  const [picker, pickerDispatch] = useReducer(pickerReducer, INITIAL_PICKER);
  const pickerOpenRef = useRef<PickerOpen | null>(null);
  const [palette, setPalette] = useState<PaletteUi | null>(null);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const [note, setNote] = useState<NoteUi | null>(null);
  const noteRef = useRef(note);
  noteRef.current = note;
  const gateRef = useRef<PendingGate | null>(null);
  const heldRef = useRef(false);
  const submittingRef = useRef(false);
  const armedRef = useRef<Armed>(initialKeyState(mode).armed);
  const escTimer = useRef<NodeJS.Timeout | null>(null);
  const rememberedToken = useRef<string | null>(null);
  const exitAfterRunEnd = useRef<0 | 130 | null>(null);
  const editorSeq = useRef(0);
  const pendingFollowup = useRef<{ input: FollowupInput; resolve: (a: 'start' | 'raise' | 'cancel') => void } | null>(null);
  const pendingUndo = useRef<{ row: string; resolve: (a: 'yes' | 'no' | 'all' | 'skipRest' | 'abort') => void } | null>(null);
  const pendingExit = useRef<((a: boolean) => void) | null>(null);
  const pendingBlocking = useRef<((a: BlockingAnswer) => void) | null>(null);
  const pendingIntake = useRef<{ card: IntakeOverlay; resolve: (a: IntakeAnswer) => void } | null>(null);
  const gitHead = useGitHead(bridge.gitDirs.gitDir, bridge.gitDirs.commonDir, state.git?.head ?? null);

  // ----- toasts, items, exits
  const toast = useCallback((text: string, level: 'info' | 'error' | 'ok' = 'info'): void => dispatch({ type: 'toast', text, level, ms: level === 'error' ? TOAST_ERROR_MS : TOAST_INFO_MS }), [dispatch]);
  const noteLine = useCallback(
    (text: string, opts: { detail?: string; label?: UiLabel; level?: TranscriptLevel } = {}): void => {
      const h = bridge.host;
      if (h) {
        h.note(text, opts);
        return;
      }
      const e = bridge.engine;
      if (e && stateRef.current.run !== 'none' && e.annotate(text, opts)) return;
      dispatch({ type: 'local', text, ...(opts.label ? { label: opts.label } : {}), ...(opts.level ? { level: opts.level } : {}), ...(opts.detail ? { detail: opts.detail } : {}) });
    },
    [bridge, dispatch],
  );
  const toastItem = useCallback(
    (text: string, level: 'info' | 'error' | 'ok' = 'info'): void => {
      toast(text, level);
      noteLine(`${level === 'ok' ? glyphs.check : '!'} ${text}`, { level: level === 'error' ? 'warn' : 'info' });
    },
    [toast, noteLine, glyphs],
  );
  const exit = useCallback(
    (code: number): void => {
      if (bridge.host) bridge.host.exit(code);
      else if (p.onExit) p.onExit(code);
      else p.onAbort('human_abort');
    },
    [bridge, p],
  );
  const abortRun = useCallback((): void => {
    if (bridge.host) bridge.host.abort('human_abort');
    else p.onAbort('human_abort');
    dispatch({ type: 'run:aborting' });
  }, [bridge, p, dispatch]);

  // ----- wizard
  const wizard = useWizard({
    host: () => bridge.wizardHost,
    onItem: (text, label) => noteLine(text, { label }),
    onDone: () => {
      if (stateRef.current.overlay === 'wizard') dispatch({ type: 'overlay', overlay: 'none' });
    },
    onExit: (code) => exit(code),
    onMaskedKey: (len) => log.key('text', len, true),
  });
  const wizardActive = wizard.active;
  useEffect(() => {
    if (wizardActive && stateRef.current.overlay !== 'wizard') dispatch({ type: 'overlay', overlay: 'wizard' });
    if (!wizardActive && stateRef.current.overlay === 'wizard') dispatch({ type: 'overlay', overlay: 'none' });
  }, [wizardActive, dispatch]);

  // ----- notifications (§14.1)
  const notifier = useMemo(() => createNotifier({ write: (s) => stdout.write(s), env, enabled: () => bridge.ui?.notify ?? launch.screenReader, redact }), [stdout, env, bridge, launch.screenReader, redact]);
  const notifyTimers = useMemo(
    () =>
      createNotifyTimers({
        fire: (kind) => {
          const s = stateRef.current;
          notifier.notify(kind === 'review' ? `review pending: step ${s.pendingReview?.step ?? '?'}` : kind === 'run-end' ? `run ended: ${s.done?.stopReason ?? 'done'}` : 'budget threshold');
        },
      }),
    [notifier],
  );
  useEffect(() => () => notifyTimers.cancel(), [notifyTimers]);
  useEffect(() => {
    const off = p.source.subscribe((e) => {
      if (e.type === 'run:end') notifyTimers.runEnded();
      if ((e.type === 'budget:warn' && e.pct === 95) || e.type === 'budget:stop') notifyTimers.budget();
    });
    return off;
  }, [p.source, notifyTimers]);

  // TUI-DESIGN-4 §2.2 P-R2: the 50 ms `wrapColumns` debounce is GONE. It kept the draft one width behind the box
  // edges for up to 50 ms (≈ 130 ms at `--fps 15`), which A2 measured as 4 of 24 frames carrying a box row whose
  // right border is the truncation ellipsis. One value cannot skew, and the work the debounce was protecting
  // (`draftRows`) already runs on every render at `wrapInner`, so nothing new is paid per keystroke — it is paid on
  // the synchronous commits P-R1 already performs. `createResizeDebounce` / `RESIZE_DEBOUNCE_MS` retire with it.
  // TUI-DESIGN-3 §3.6 / §6 item 8: a geometry change is activity for the idle loop's attention clock (never at mount)
  const geometryRef = useRef({ rows, columns });
  useEffect(() => {
    if (geometryRef.current.rows === rows && geometryRef.current.columns === columns) return;
    geometryRef.current = { rows, columns };
    dispatch({ type: 'resize' });
  }, [rows, columns, dispatch]);

  // ----- overlay arming (§6.3): every y-gated overlay arms after the first committed frame that shows it; the
  // secret / follow-up / undo / exit-confirm rows additionally never within 150 ms of the Enter that opened them
  // (both conditions chained, finding 15); the review arms on the committed frame alone (its deferral already
  // guarantees an idle second)
  const overlay = state.overlay;
  const overlayArmed = state.overlayArmed;
  useEffect(() => {
    if (overlay === 'none' || overlayArmed) return undefined;
    // This effect runs after the commit that drew the overlay; Ink writes that frame inside its throttle window
    // (≤ 34 ms), so a timer measured from the commit is the arming floor. `waitUntilRenderFlush()` only accelerates
    // the review (it resolves after stdout's write callback) and is never waited on alone: in the first live session
    // (docs/live/tui attempt 2) the pty reader lagged and that promise took ~21 s, during which a typed `y` fell
    // through to the composer.
    if (overlay === 'review') {
      traceLine('tui.arm effect run overlay=review');
      notifyTimers.reviewShown();
      let alive = true;
      let armed = false;
      const arm = (why: string): void => {
        if (!alive || armed) return;
        armed = true;
        traceLine(`tui.arm dispatch overlay:armed via ${why}`);
        dispatch({ type: 'overlay:armed' });
      };
      const t = setTimeout(() => arm('timer'), REVIEW_ARM_MS);
      void waitUntilRenderFlush().then(() => arm('flush'), () => undefined);
      return () => {
        alive = false;
        clearTimeout(t);
        traceLine(`tui.arm effect cleanup armed=${armed}`);
      };
    }
    if (overlay === 'secret' || overlay === 'followup' || overlay === 'undo' || overlay === 'exitConfirm' || overlay === 'intake') {
      // never within GATE_ARM_MS of the Enter that opened the row (§4.10, §6.3), measured from the commit
      let alive = true;
      const t = setTimeout(() => {
        if (alive) dispatch({ type: 'overlay:armed' });
      }, GATE_ARM_MS);
      return () => {
        alive = false;
        clearTimeout(t);
      };
    }
    dispatch({ type: 'overlay:armed' });
    return undefined;
  }, [overlay, overlayArmed, dispatch, waitUntilRenderFlush, notifyTimers, now]);

  // ----- the `d` note field ends with the review (§6.2): a review settled from outside (a second request, run:end, an
  // abort) drops `noteMode`; the stashed human draft comes back here (finding 8)
  const noteMode = state.noteMode;
  useEffect(() => {
    if (!noteMode && note !== null) {
      composer.restore(note.stash);
      setNote(null);
    }
  }, [noteMode, note, composer]);

  // ----- §6.5 screen reader: when the review arms, the numbered list and the prompt are appended as <Static> lines,
  // the current draft is stashed (a line already begun can never become the answer) and one BEL sounds; the stash
  // comes back when the review ends. Only a line typed after arming that is exactly 1/2/3/y/n answers (handleKey).
  const sr = launch.screenReader;
  const srStash = useRef<Snapshot | null>(null);
  useEffect(() => {
    if (!sr) return;
    if (overlay === 'review' && overlayArmed) {
      if (srStash.current === null) {
        srStash.current = composer.stash();
        composer.set('', 0, false);
        noteLine(SR_REVIEW_MENU, { label: '[ui]' });
        noteLine(SR_REVIEW_PROMPT, { label: '[ui]' });
        stdout.write(BEL);
      }
    } else if (overlay !== 'review' && srStash.current !== null && !noteMode) {
      composer.restore(srStash.current);
      srStash.current = null;
    }
  }, [sr, overlay, overlayArmed, noteMode, composer, noteLine, stdout]);
  useEffect(() => {
    if (overlay !== 'review') notifyTimers.reviewGone();
  }, [overlay, notifyTimers]);

  // ----- TUI-DESIGN-4 §1.3.1: a refused `fullscreen` falls back to `classic` and appends exactly ONE `[ui]` note
  // naming the reason. `createTuiRenderer` decided it before `render()` and carried the sentence on
  // `launch.rendererRefusal` (contract 1.7 §8 item 6); this is the one place it becomes a transcript row.
  const rendererRefusalText = launch.rendererRefusal;
  const refusalSaid = useRef(false);
  useEffect(() => {
    if (rendererRefusalText === undefined || rendererRefusalText === '' || refusalSaid.current) return;
    refusalSaid.current = true;
    noteLine(rendererRefusalText, { label: '[ui]' });
  }, [rendererRefusalText, noteLine]);

  // ----- run:end exits (Ctrl-D ×2 `[y]`, `/exit` `[y]`): 0 always, the run:end item carries the run's code (§13.5)
  const runPhase = state.run;
  useEffect(() => {
    if (runPhase === 'none' && exitAfterRunEnd.current !== null) {
      const code = exitAfterRunEnd.current;
      exitAfterRunEnd.current = null;
      if (code === 0) exit(0);
    }
  }, [runPhase, exit]);

  // ----- the draft mirror (§15 item 20)
  const buffer = composer.buffer;
  // TUI-DESIGN-2 §4.3: the console lays the draft out at the inner width (`columns − 4`)
  const wrapInner = boxed ? consoleInnerWidth(columns) : columns;
  useEffect(() => {
    dispatch({ type: 'draft', draft: composer.mirror(wrapInner, promptFor(glyphs)) });
  }, [buffer, wrapInner, composer, dispatch, glyphs]);

  // ----- default tab (jev-only: `s` while propose runs, §7.2)
  const stage = state.status?.stage ?? null;
  const uiMode = state.mode;
  const tabTouched = useRef(false);
  useEffect(() => {
    if (tabTouched.current) return;
    const t = defaultTab(uiMode, stage);
    if (t !== stateRef.current.tab) dispatch({ type: 'tab', tab: t });
  }, [uiMode, stage, dispatch]);

  // ----- git zone from the watcher
  useEffect(() => {
    const cur = stateRef.current.git;
    if (cur === null) return;
    if (cur.head !== gitHead.head || cur.frozen !== gitHead.frozen) dispatch({ type: 'git', zone: { ...cur, head: gitHead.head, frozen: gitHead.frozen } });
  }, [gitHead, dispatch]);

  // ----- helpers over the current state
  // TUI-DESIGN-3 §4.4 F20 / F14: the host's dispatch context when it exposes one (denylist, `newestRunId ?? sessionId`), else the App's
  // fold; `run` reads `none` while a chat request is thinking (a chat request is not a run)
  const dispatchCtx = (): DispatchContext => dispatchCtxOf(bridge.host, stateRef.current);
  const paletteState = (): PaletteState => {
    const s = stateRef.current;
    const recent = paletteRef.current?.recent;
    return { lastStop: s.done?.stopReason ?? null, unauthorized: s.unauthorized, changedFiles: s.changedSteps.length > 0, rewindMenu: paletteRef.current?.mode === 'rewind', live: s.run !== 'none', ...(recent !== undefined ? { recent } : {}) };
  };
  const closeOverlay = (kind: OverlayKind = stateRef.current.overlay): void => {
    if (kind === 'palette') {
      rememberedToken.current = composer.buffer.text.trim();
      setPalette(null);
    }
    if (kind === 'secret') {
      const g = gateRef.current;
      gateRef.current = null;
      g?.resolve?.(false); // a dismissed / cancelled controller prompt refuses (§4.10: only an armed y sends)
    }
    if (stateRef.current.overlay === kind) dispatch({ type: 'overlay', overlay: 'none' });
  };
  const openPalette = (paletteMode: PaletteUi['mode']): void => {
    if (paletteMode === 'command' && rememberedToken.current !== null && rememberedToken.current === composer.buffer.text.trim()) return;
    rememberedToken.current = null;
    // TUI-DESIGN-3 §4.1 rule 6: the Recent group is read from the history once, at open (never per key)
    const recent = paletteMode === 'command' ? guard('overlay', () => recentCommands(bridge.host?.history()?.entries('workspace') ?? []), []) : undefined;
    setPalette({ mode: paletteMode, selected: 0, candidates: [], ...(recent !== undefined ? { recent } : {}) });
    dispatch({ type: 'overlay', overlay: 'palette' });
    if (paletteMode === 'mention') {
      void bridge.host?.workspaceCandidates().then((c) => setPalette((cur) => (cur && cur.mode === 'mention' ? { ...cur, candidates: c.map((x) => x.path) } : cur)));
    }
  };
  const appendHistory = (kind: 'prompt' | 'steer' | 'command', text: string): void => {
    try {
      bridge.host?.history()?.append(kind, text);
    } catch {
      /* the store reports its own write errors */
    }
  };
  const clearDraftToHistory = (): void => {
    const text = composer.buffer.text;
    if (text.length > 0) {
      const hits = detect(text);
      const store = bridge.host?.history();
      const masked = hits.length > 0 ? (text.split('').map((ch, i) => (hits.some((h) => i >= h.start && i < h.end) ? '' : ch)).join('') === text ? text : null) : text;
      try {
        if (store && 'appendCleared' in store && typeof (store as { appendCleared?: unknown }).appendCleared === 'function') (store as { appendCleared: (t: string, spans: readonly { start: number; end: number }[]) => void }).appendCleared(text, hits.map((h) => ({ start: h.start, end: h.end })));
        else if (store && masked !== null) store.append('prompt', composer.historyText(redact));
      } catch {
        /* never fatal */
      }
    }
    composer.clear();
    if (gateRef.current) closeOverlay('secret');
  };

  // ----- TUI-DESIGN-2 §4.6 / §4.5: the panel and transcript commands
  const applyPanelCommand = (c: ReturnType<typeof parsePanelCommand>): void => {
    if (c === null) return;
    const s = stateRef.current;
    if (c.kind === 'transcript') {
      if (c.view === null) {
        noteLine(`transcript ${s.transcript}`, { label: '[ui]' });
        return;
      }
      dispatch({ type: 'transcript', view: c.view });
      return;
    }
    const next = nextPanel({ panel: s.panel, tab: s.tab }, c.arg);
    if (next.tab !== s.tab) {
      tabTouched.current = true;
      dispatch({ type: 'tab', tab: next.tab });
    }
    if (next.panel !== s.panel) dispatch({ type: 'panel', panel: next.panel });
  };

  // ----- send paths (§4.9). History is appended after the host has `addSecret()`ed the spans (§10.7 / §4.6 ordering),
  // with the redacted text captured before the composer is cleared; `history` overrides the entry for a `/steer` line.
  const send = (decision: SubmitDecision, history?: { kind: 'prompt' | 'steer' | 'command'; text: string }): void => {
    switch (decision.kind) {
      case 'steer': {
        const h = bridge.host;
        const hist = history ?? { kind: 'steer' as const, text: composer.historyText(redact) };
        const r = h ? h.steer(decision.full, { secretSpans: decision.secretSpans }) : bridge.engine ? bridge.engine.steer(decision.full, decision.secretSpans.length > 0 ? { secretsAcked: decision.secretSpans.length } : {}) : null;
        if (r === null) {
          noteLine('error: no live run to steer', { label: '[ui]', level: 'warn' });
          return;
        }
        if (!r.ok) {
          toastItem(r.reason === 'full' ? 'steer queue full (8)' : r.reason === 'finished' ? 'run is ending; wait for run:end' : 'nothing to steer', 'error');
          return;
        }
        for (const m of decision.droppedMentions) noteLine(`${m} is on the secret denylist; JevCode never reads it. Start with --allow-secret-mention to override.`, { label: '[ui]' });
        if (decision.notice) noteLine(decision.notice, { label: '[ui]' });
        appendHistory(hist.kind, redact(hist.text));
        composer.clear();
        return;
      }
      case 'submit': {
        const h = bridge.host;
        if (!h) {
          noteLine('error: no session to submit to; start jevcode without a task to open a session', { label: '[ui]', level: 'warn' });
          return;
        }
        for (const m of decision.droppedMentions) noteLine(`${m} is on the secret denylist; JevCode never reads it. Start with --allow-secret-mention to override.`, { label: '[ui]' });
        if (decision.notice) noteLine(decision.notice, { label: '[ui]' });
        const hist = history ?? { kind: 'prompt' as const, text: composer.historyText(redact) };
        composer.clear();
        submittingRef.current = true;
        dispatch({ type: 'run:starting' });
        // TUI-DESIGN-3 §5.2 P7: a session submission enters the intake at once — the very first frame after Enter reads
        // `▓ thinking` / `(thinking…)`, never `starting` + the steer placeholder (the controller's own `thinking('intake')` is idempotent;
        // `run:start` and `run:idle` clear it). The one-shot argv path has no chat phase.
        if (mode === 'session') dispatch({ type: 'thinking', phase: 'intake' });
        void h
          .submit(decision.full, { kind: decision.promptKind, secretSpans: decision.secretSpans, pinnedFiles: decision.pinnedFiles })
          .then((outcome) => {
            // TUI-DESIGN-2 §4.4 / §3.8: a chat reply is a turn (a run counts at `run:start`) — the placeholder reads `followup` from here on
            if (outcome !== undefined && outcome !== null && typeof outcome === 'object' && outcome.became === 'chat') dispatch({ type: 'turn' });
          })
          .catch((e: unknown) => noteLine(`error: ${e instanceof Error ? e.message : String(e)}`, { label: '[ui]', level: 'error' }))
          .finally(() => {
            submittingRef.current = false;
            appendHistory(hist.kind, redact(hist.text));
            // §4.9: `submit()` resolves once the run started; still `starting` here means no `run:start` came (the
            // follow-up box answered n/Esc, a missing key, a trust refusal, any early return) → back to idle (S0 rules)
            if (stateRef.current.run === 'starting') dispatch({ type: 'run:idle' });
          });
        return;
      }
      default:
        return;
    }
  };

  const runCommand = (action: CommandAction, line: string): void => {
    const h = bridge.host;
    const s = stateRef.current;
    // §10.7: the history entry follows the action (after any addSecret the host does for it), redacted
    const remember = (): void => appendHistory('command', redact(line));
    switch (action.kind) {
      case 'help': {
        if (action.topic === 'reload') break;
        const lines = helpLines(columns, { bindings, ascii: glyphs.mode === 'ascii', topic: action.topic });
        noteLine(lines[0] ?? 'help', { label: '[ui]', detail: lines.slice(1).join('\n') });
        composer.clear();
        return;
      }
      case 'why': {
        const digit = /^[1-5]$/.test(action.ref.trim()) ? Number(action.ref.trim()) : null;
        const ref = action.ref.trim();
        // TUI-DESIGN-2 §3.11: `intake[.reply|.about_<key>|.can_<kind>]` addresses the last intake's step-0 rows, which belong to no run —
        // the controller keeps them (`chatIntakes`, full `Decision`s; the App's `chatRows` are panel projections), so its `/why` answers
        if (h && /^intake(?:\.[a-z_]+)?$/.test(ref)) break;
        const all = [...s.decisionsByStep.values()].flat();
        const step = s.pendingReview?.step ?? s.step;
        let d = null as (typeof all)[number] | null;
        if (digit !== null) {
          const key = reviewRowForDigit(digit);
          d = all.find((x) => x.step === step && x.stage === 'risk' && x.id === key) ?? null;
        } else {
          const m = /^(?:s(\d+)\.)?([a-z_]+)\.(.+)$/.exec(ref);
          if (m) {
            const st = m[1] !== undefined ? Number(m[1]) : s.step;
            d = all.find((x) => x.step === st && x.stage === m[2] && x.id === m[3]) ?? null;
          }
        }
        if (d === null) {
          // TUI-DESIGN-3 §4.4 F8: the App's pane projection is a fast path — a miss falls through to the host, which keeps every decision;
          // without a host the one shared text (`whyErrorText`) answers, and a failed /why leaves no command text behind (finding 16)
          if (h) break;
          noteLine(whyErrorText(ref, 'missing'), { label: '[ui]', level: 'warn' });
          composer.clear();
          return;
        }
        const block = whyBlock(d, { siblings: all.filter((x) => x.step === d!.step), model: s.done?.resolvedJevModel ?? null }, glyphs);
        noteLine(block[0] ?? 'why', { label: '[ui]', detail: block.slice(1).join('\n') });
        composer.clear();
        return;
      }
      // TUI-DESIGN-3 §4.4 F6 / F11: `/decisions` and `/plan` are the host's (one source, identity by construction) — no App case
      case 'theme': {
        // TUI-DESIGN-3 §4.4 F5: applied at once here (the dynamic region and new items), and forwarded so the host records the override
        // (`/config` reports it, the next `applyConfig` keeps it) and prints the `[ui]` item; no host yet → local only
        if (bridge.ui) bridge.ui = { ...bridge.ui, theme: action.theme };
        else bridge.ui = { ...launch, theme: action.theme, title: false, reducedMotion: launch.screenReader, notify: launch.screenReader, osc52: false, history: true, noInput: false, trustWorkspace: false, budgetWarnings: true, allowSecretMention: false, exitCode: 'zero', logLevel: 'info', logFile: null, keybindingsFile: null };
        bridge.notify();
        composer.clear();
        if (h) {
          void h
            .command(line)
            .catch((e: unknown) => noteLine(`error: /theme: ${e instanceof Error ? e.message : String(e)}`, { label: '[ui]', level: 'error' }))
            .finally(remember);
        }
        return;
      }
      case 'editor':
        void startEditor();
        return;
      case 'exit':
        composer.clear();
        // TUI-DESIGN-3 §4.4 F14: `/exit` while a chat request is thinking cancels the request and exits (no confirm: nothing is live)
        if (chatThinking(s)) {
          if (h) h.abort('human_abort');
          else p.onAbort('human_abort');
          exit(0);
          return;
        }
        if (s.run !== 'none') {
          pendingExit.current = (yes) => {
            if (yes) {
              exitAfterRunEnd.current = 0;
              abortRun();
            }
          };
          dispatch({ type: 'overlay', overlay: 'exitConfirm' });
          return;
        }
        exit(0);
        return;
      case 'pause':
        composer.clear();
        if (h) h.pause();
        else bridge.engine?.pause();
        dispatch({ type: 'run:pausing' });
        return;
      case 'abort':
        composer.clear();
        abortRun();
        return;
      case 'unsteer': {
        composer.clear();
        remember();
        const d = h ? h.unsteer() : (bridge.engine?.unsteer() ?? null);
        if (d) composer.set(d.text);
        return;
      }
      case 'steer': {
        // §10.2: a `/steer <text>` passes the same gate as a composer steer — the row opens, an armed `y` sends
        const hits = detect(action.text);
        if (hits.length > 0) {
          gateRef.current = { full: action.text, hits, openedAt: now(), history: { kind: 'command', text: line } };
          dispatch({ type: 'overlay', overlay: 'secret' });
          return;
        }
        send(routeSend(action.text, [], { run: s.run, ranBefore: s.runsEnded > 0 }), { kind: 'command', text: line });
        return;
      }
      case 'scrollback': {
        // §1.3.4: the fullscreen renderer prints to the primary screen here; `classic` falls through to the host,
        // which answers the §12 line (`your terminal's scrollback already has the transcript`)
        if (!fullscreen) break;
        composer.clear();
        remember();
        void doScrollback().catch((e: unknown) => noteLine(`error: /scrollback: ${e instanceof Error ? e.message : String(e)}`, { label: '[ui]', level: 'error' }));
        return;
      }
      case 'copy': {
        // TUI-DESIGN-3 §4.4 F7: `/copy diff` asks the host (it builds the diff exactly as `/diff` does, then `copyFn` + the toast)
        if (action.what === 'diff') {
          composer.clear();
          if (h) {
            void h
              .command(line)
              .catch((e: unknown) => noteLine(`error: /copy: ${e instanceof Error ? e.message : String(e)}`, { label: '[ui]', level: 'error' }))
              .finally(remember);
          } else toast('nothing to copy for diff', 'error');
          return;
        }
        const payload = action.what === 'draft' ? s.draft.empty ? '' : composer.buffer.text : action.what === 'proposal' ? (s.items.filter((i) => i.kind === 'proposal').at(-1)?.text ?? '') : (s.items.at(-1) ? formatTranscriptItem(s.items.at(-1) as TranscriptItem) : '');
        void copyRedacted(payload, action.what === 'draft' ? (x) => x : redact, { write: (x) => stdout.write(x), osc52: bridge.ui?.osc52 ?? false, env }).then((r) => toast(r.toast, r.ok ? 'ok' : 'error'));
        composer.clear();
        return;
      }
      default:
        break;
    }
    if (h) {
      composer.clear();
      void h
        .command(line)
        .catch((e: unknown) => noteLine(`error: ${line.split(/\s+/)[0]}: ${e instanceof Error ? e.message : String(e)}`, { label: '[ui]', level: 'error' }))
        .finally(remember);
      return;
    }
    noteLine(`error: ${line.split(/\s+/)[0]} needs a session; start jevcode without a task`, { label: '[ui]', level: 'warn' });
  };

  const onEnter = (): void => {
    const s = stateRef.current;
    if (picker.kind && pickerOpenRef.current !== null) return; // handled by the picker ops
    if (mode === 'one-shot' && s.run === 'none' && (s.done !== null || s.runsEnded > 0)) return; // §1 / §3.3: nothing to submit after a one-shot run:end
    const text = composer.buffer.text;
    // TUI-DESIGN-2 §4.6 / §4.5: `/panel …` and `/transcript …` are the App's own (the registry rows are S2's)
    const local = parsePanelCommand(text);
    if (local !== null && s.overlay !== 'wizard') {
      if (s.overlay === 'palette') closeOverlay('palette');
      applyPanelCommand(local);
      appendHistory('command', text.trim());
      composer.clear();
      return;
    }
    // TUI-DESIGN-2 §3.1 row 11: Enter while a submission is still thinking (`run: 'starting'` under a phase) is ignored with a
    // toast; the draft keeps accepting text
    if (chatThinking(s) && text.trim().length > 0 && !text.trimStart().startsWith('/')) {
      toast(STILL_THINKING_TOAST);
      return;
    }
    const decision = routeSubmit({
      text,
      submitting: submittingRef.current,
      overlay: s.overlay,
      run: s.run,
      host: bridge.host ?? (bridge.engine ? { detectSecrets: detect } : null),
      chips: new Map(),
      ranBefore: s.runsEnded > 0,
      dispatch: dispatchCtx(),
      expand: (t) => composer.expand(t),
      // TUI-DESIGN-3 §4.4 F14: `/` lines route while a chat request is thinking (the dispatch context reads `run: 'none'` then)
      allowCommandsWhileSubmitting: chatThinking(s),
    });
    switch (decision.kind) {
      case 'ignore':
        return;
      case 'newline':
        composer.set(decision.text);
        composer.dispatch({ type: 'newline' });
        return;
      case 'command':
        if (s.overlay === 'palette') closeOverlay('palette');
        runCommand(decision.action, decision.line);
        return;
      case 'error':
      case 'chip-missing':
        noteLine(decision.text, { label: decision.label, level: 'warn' });
        // TUI-DESIGN-3 §4.4 F21 (D-K): a fixable error keeps the draft for editing; an availability error clears it (and closes the palette)
        if (decision.kind === 'error' && !decision.keepDraft) {
          composer.clear();
          if (s.overlay === 'palette') closeOverlay('palette');
        }
        return;
      case 'hold':
        heldRef.current = true;
        toast(decision.toast);
        return;
      case 'gate':
        gateRef.current = { full: decision.full, hits: decision.hits, openedAt: now() };
        dispatch({ type: 'overlay', overlay: 'secret' });
        return;
      case 'steer':
      case 'submit':
        send(decision);
        return;
    }
  };

  // a held Enter flushes when the host attaches (§4.9)
  useEffect(() => {
    if (host !== null && heldRef.current) {
      heldRef.current = false;
      onEnter();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  const startEditor = async (): Promise<void> => {
    const s = stateRef.current;
    if (isCollapsingOverlay(s.overlay) || s.overlay === 'wizard') return;
    const dir = draftsDirFor(s, { home: p.home ?? homedir(), ...(p.runsDir !== undefined ? { runsDir: p.runsDir } : {}) });
    editorSeq.current += 1;
    const bus = p.source as Partial<EventBus>;
    bus.suspend?.();
    try {
      const r = await openExternalEditor(composer.buffer.text, { env, suspendTerminal: (cb) => suspendTerminal(cb), dir, seq: editorSeq.current, detect });
      if (r.kind === 'ok') composer.set(r.text);
      else toastItem(r.toast, 'error');
    } finally {
      bus.resume?.();
    }
  };

  /**
   * TUI-DESIGN-4 §1.3.4: `/scrollback` under the fullscreen renderer — `suspendTerminal()` (which leaves the
   * alternate screen), the whole transcript printed to the PRIMARY screen through the one formatter so native copy
   * and find work for as long as the user wants, a key, then resume. Under `classic` this is never called: the
   * command falls through to the host, whose §12 answer is that the terminal's own scrollback already has it.
   *
   * `/scrollback` while a run is live is allowed — the `<Static>` items an engine produces during the dump go
   * through the existing suspension queue and are delivered, in order, after the resume (§4.8).
   */
  const doScrollback = async (): Promise<void> => {
    const bus = p.source as Partial<EventBus>;
    const chunks = transcriptDumpChunks(stateRef.current.items, glyphs);
    if (chunks.length === 0) {
      toast('nothing in the transcript yet');
      return;
    }
    await printToPrimaryScreen({
      chunks,
      suspendTerminal: () => suspendTerminal(),
      // the SAME stream Ink renders to (`guardStdout`'s proxy forwards every non-clear write untouched), so the
      // dump lands on the primary screen in order with everything else Ink has already flushed
      write: (text) => stdout.write(text),
      waitForKey: () => waitForAnyKey(process.stdin),
      ...(bus.suspend && bus.resume ? { onQueue: { suspend: () => bus.suspend?.(), resume: () => bus.resume?.() } } : {}),
      repaint: () => {
        writeCursorShape(stdout);
        write('');
      },
    });
  };

  const doSuspend = async (): Promise<void> => {
    /**
     * Ctrl+Z is only ever driven against the REAL terminal: a test mount (`StubStdout`) or a piped stdout must
     * never SIGSTOP the process. TUI-DESIGN-4 §1.4 made the identity check subtler — `createTuiRenderer` hands
     * Ink `guardStdout(process.stdout)`, a Proxy, so `stdout === process.stdout` is false for the real terminal
     * too and this guard silently disabled Ctrl+Z for every user (measured: the pty leg's `ESC[?2004h` after
     * SIGCONT never came back, because `suspendProcess` was never called). `guardStdout` is memoised per
     * underlying stream, so `guardStdout(process.stdout)` IS the proxy Ink was given.
     */
    if (process.stdout.isTTY !== true || (stdout !== process.stdout && stdout !== guardStdout(process.stdout as unknown as GuardedStream))) return;
    const bus = p.source as Partial<EventBus>;
    // §14.2: the process-wide exit string is written for the shell, re-armed for the real exit, and the DECSCUSR bar
    // (reset by RESTORE) is re-applied with the one forced repaint after `fg`
    await suspendProcess({
      suspendTerminal: () => suspendTerminal(),
      restore: restoreTerminal,
      rearm: rearmRestoreTerminal,
      proc: process,
      stdin: process.stdin,
      repaint: () => {
        writeCursorShape(stdout);
        write('');
      },
      ...(bus.suspend && bus.resume ? { onQueue: { suspend: () => bus.suspend?.(), resume: () => bus.resume?.() } } : {}),
    });
  };

  const closePicker = (): void => {
    const o = pickerOpenRef.current;
    pickerOpenRef.current = null;
    dispatch({ type: 'picker', open: false });
    composer.clear();
    o?.onClose?.();
  };

  const interrupt = (action: InterruptAction, ks: KeyState): void => {
    const s = stateRef.current;
    // §6.2 / F5: while the `d` note field is open, Ctrl-C cancels the note (the stashed draft comes back, the box
    // stays) — it never aborts the run behind the box and never writes the note to history (finding 8)
    if (s.noteMode && noteRef.current !== null && (action === 'CLEAR_DRAFT' || action === 'ABORT_REVIEW')) {
      noteCancel();
      return;
    }
    switch (action) {
      case 'HINT_CTRL_C':
      case 'HINT_CTRL_D':
      case 'HINT_ESC': {
        const hint = interruptHint(action, ks);
        if (hint) toast(hint);
        return;
      }
      case 'EXIT_0':
        noteLine(ks.armed.ctrlDAt !== null ? EXITED_CTRL_D : EXITED_CTRL_C, { label: '[ui]' });
        exit(0);
        return;
      case 'ABORT_STAY':
        abortRun();
        return;
      case 'ABORT_EXIT_130':
        exitAfterRunEnd.current = 130;
        abortRun();
        return;
      case 'EXIT_NOW_130':
        // the engine's second abort() is forceExit through the injected exit hook (§13.4)
        if (bridge.host) bridge.host.abort('human_abort');
        else p.onAbort('human_abort');
        return;
      case 'CLEAR_DRAFT':
        clearDraftToHistory();
        return;
      case 'ABORT_REVIEW':
        // engine.abort('human_abort') only: the rejected confirm() is the decline (rule-1 discard, §3.3)
        abortRun();
        return;
      case 'DECLINE':
        if (s.pendingReview) {
          p.confirmer.resolve(s.pendingReview.id, false);
          dispatch({ type: 'confirm:settled', id: s.pendingReview.id });
        }
        return;
      case 'PAUSE': {
        if (bridge.host) bridge.host.pause();
        else bridge.engine?.pause();
        dispatch({ type: 'run:pausing' });
        const hint = interruptHint(action, ks);
        if (hint) toast(hint);
        return;
      }
      case 'ABORT':
        abortRun();
        return;
      case 'OPEN_REWIND_MENU':
        composer.set('/');
        openPalette('rewind');
        return;
      case 'OPEN_EXIT_CONFIRM':
        pendingExit.current = (yes) => {
          if (yes) {
            exitAfterRunEnd.current = 0;
            noteLine(EXITED_CTRL_D, { label: '[ui]' });
            abortRun();
          }
        };
        dispatch({ type: 'overlay', overlay: 'exitConfirm' });
        return;
      /**
       * TUI-DESIGN-4 §4.7 E12: Ctrl-C with the palette open and the whole draft a single `/token` closes the card
       * AND clears the draft — the measured trap is that closing alone leaves a half-typed `/budgett` behind with
       * no card and no placeholder, so the next Ctrl-C reads as "clear the draft" and the exit takes three keys.
       * A draft with an ARGUMENT keeps today's close-only behaviour, and Ctrl-C twice still exits 0.
       */
      case 'CLOSE_OVERLAY_AND_CLEAR':
      case 'CLOSE_OVERLAY': {
        const k = s.overlay;
        if (action === 'CLOSE_OVERLAY_AND_CLEAR') composer.clear();
        if (k === 'followup') {
          pendingFollowup.current?.resolve('cancel');
          pendingFollowup.current = null;
        }
        if (k === 'undo') {
          pendingUndo.current?.resolve('abort');
          pendingUndo.current = null;
        }
        if (k === 'exitConfirm') {
          pendingExit.current?.(false);
          pendingExit.current = null;
        }
        if (k === 'intake') {
          pendingIntake.current?.resolve('keep');
          pendingIntake.current = null;
        }
        if (k === 'wizard') wizard.cancel();
        if (k === 'secret') toast(GATE_DISMISS_TIP);
        closeOverlay(k);
        return;
      }
      case 'PANE_Q':
        pendingBlocking.current?.('stop');
        pendingBlocking.current = null;
        return;
      case 'WIZARD_EXIT_2':
        wizard.cancel();
        return;
      case 'DELETE_FORWARD':
      case 'NONE':
        return;
    }
  };

  const execute = (action: KeyAction, ks: KeyState): void => {
    const s = stateRef.current;
    switch (action.type) {
      case 'arm':
        armedRef.current = action.armed;
        return;
      case 'escBuffer':
        if (escTimer.current) clearTimeout(escTimer.current);
        escTimer.current = setTimeout(() => {
          escTimer.current = null;
          handleKey({ input: '', key: { ...NOKEY, escape: true }, escExpired: true });
        }, ESC_REBUFFER_MS);
        return;
      case 'interrupt':
        interrupt(action.action, ks);
        return;
      case 'filtered':
        log.key('filtered', 0, false);
        return;
      case 'toast':
        toast(action.text);
        return;
      case 'submit':
        if (pickerOpenRef.current !== null) return;
        onEnter();
        return;
      case 'repaint':
        write('');
        return;
      case 'suspend':
        void doSuspend();
        return;
      case 'help': {
        const lines = helpLines(columns, { bindings, ascii: glyphs.mode === 'ascii' });
        noteLine(lines[0] ?? 'help', { label: '[ui]', detail: lines.slice(1).join('\n') });
        return;
      }
      case 'detail': {
        // §7.7 Ctrl+O: the last step's decisions as /why blocks, then the recent warnings / errors; `!n` clears
        const step = s.step;
        const all = [...s.decisionsByStep.values()].flat();
        for (const block of stepWhyBlocks(all, step, glyphs)) noteLine(block[0] ?? 'why', { label: '[ui]', detail: block.slice(1).join('\n') });
        const recent = s.items.filter((i) => (i.level === 'warn' || i.level === 'error') && i.kind !== 'ui').slice(-RECENT_WARNINGS_KEPT);
        if (recent.length > 0) noteLine(`recent warnings/errors (${recent.length})`, { label: '[ui]', detail: recent.map((i) => formatTranscriptItem(i)).join('\n') });
        dispatch({ type: 'ack-errors' });
        return;
      }
      case 'editor':
        void startEditor();
        return;
      case 'retryNow':
        // §13.2 `[r] retry now`: resolved by resolveKey (a bare `r` on an empty draft while the retry row is up)
        retryNow();
        return;
      case 'paneTab':
        // TUI-DESIGN-2 §4.6: `]` / `[` on an empty draft open a collapsed panel first, then cycle the tabs
        if (s.panel === 'collapsed') {
          dispatch({ type: 'panel', panel: 'open' });
          return;
        }
        tabTouched.current = true;
        dispatch({ type: 'tab', tab: cycleTab(s.tab, action.dir) });
        return;
      case 'panel': {
        // TUI-DESIGN-2 §4.6: Alt+J toggles, Alt+Shift+J opens full, Alt+D/P/T/S open a tab (a second press on the same tab collapses)
        const next = nextPanel({ panel: s.panel, tab: s.tab }, action.op === 'toggle' ? null : action.op === 'full' ? 'full' : (action.tab ?? s.tab));
        if (next.tab !== s.tab) {
          tabTouched.current = true;
          dispatch({ type: 'tab', tab: next.tab });
        }
        if (next.panel !== s.panel) dispatch({ type: 'panel', panel: next.panel });
        return;
      }
      case 'intake': {
        // TUI-DESIGN-2 §3.7: y → run · n → chat (a reply from the answers in hand) · Esc / Ctrl-C → keep (the controller restores the draft)
        const i = pendingIntake.current;
        pendingIntake.current = null;
        closeOverlay('intake');
        i?.resolve(action.op);
        return;
      }
      case 'export':
        runCommand({ kind: 'export', file: null }, '/export');
        return;
      case 'unsteer': {
        const d = bridge.host ? bridge.host.unsteer() : (bridge.engine?.unsteer() ?? null);
        if (d) composer.set(d.text);
        return;
      }
      case 'openPalette':
        openPalette('command');
        return;
      case 'openMention':
        openPalette('mention');
        return;
      case 'complete': {
        const pal = paletteRef.current;
        if (pal === null) return;
        const q = composer.buffer.text.trim();
        if (pal.mode === 'mention') {
          const m = /@([^\s@]*)$/.exec(composer.buffer.text);
          const ranked = rank(m?.[1] ?? '', pal.candidates, 8);
          const pick = ranked[pal.selected]?.candidate;
          if (pick !== undefined && m) composer.set(`${composer.buffer.text.slice(0, m.index)}@${pick.replace(/ /g, '\\ ')} `);
          return;
        }
        // TUI-DESIGN-3 §4.3: Tab completes the command name or the argument under the cursor and never wipes a typed argument
        void q;
        const dir: 1 | -1 = action.dir === -1 ? -1 : 1;
        const r = completeDraft(composer.buffer.text, composer.buffer.cursor, dir, { dispatch: dispatchCtx(), palette: paletteState() }, pal.selected, pal.stem);
        const cycling = (selected: number, stem: string | null): PaletteUi => ({ mode: pal.mode, selected, candidates: pal.candidates, ...(pal.recent !== undefined ? { recent: pal.recent } : {}), ...(stem !== null ? { stem } : {}) });
        switch (r.kind) {
          case 'command':
            composer.set(r.text, r.cursor);
            setPalette(cycling(pal.selected, null));
            return;
          case 'argument':
            composer.set(r.text, r.cursor);
            setPalette(r.accepted ? cycling(0, null) : cycling(r.selected + dir, r.stem));
            return;
          case 'none':
            toast(r.toast);
            return;
          default:
            return;
        }
      }
      /**
       * TUI-DESIGN-4 §4.2 (D-X, P-P1) — **Tab goes deeper. Enter runs what is written. Enter with nothing written
       * yet walks the list.** Every palette key goes through the pure machine in `src/tui/commands/nav.ts`
       * (`paletteNavState` → `paletteStep` → `NavEffect`); this case only executes the effect. Cycling therefore
       * never calls `routeSubmit`, `parseCommand` or `dispatchCommand`, which is what keeps a held Enter inside
       * D-F's 16 ms budget, and §4.1's safety theorem holds structurally: from `/` the chain yields S-BROWSE,
       * whose Enter is `move`, so no sequence of Enter presses alone can run anything.
       *
       * Measured before this landed (perf `palette-cycle`): Enter SUBMITTED the draft `/`, so 200 Enters produced
       * `[ui] error: / — not a command` 200 times and 4 of 200 key frames — the series' p95 was 20 s.
       *
       * `@`-mentions keep round 3's behaviour: they are a file list, not the command machine.
       */
      case 'palette': {
        const pal = paletteRef.current;
        if (pal === null) return;
        if (pal.mode === 'mention') {
          switch (action.op) {
            case 'move':
            case 'page': {
              const count = Math.min(8, pal.candidates.length);
              const by = (action.by ?? 1) * (action.op === 'page' ? PALETTE_PAGE : 1);
              setPalette({ ...pal, selected: count === 0 ? 0 : Math.min(Math.max(0, pal.selected + by), count - 1) });
              return;
            }
            case 'accept':
              execute({ type: 'complete', dir: 1 }, ks);
              return;
            case 'enter':
            case 'run':
              execute({ type: 'complete', dir: 1 }, ks);
              closeOverlay('palette');
              return;
            case 'close':
              closeOverlay('palette');
              return;
          }
          return;
        }
        if (action.op === 'close') {
          closeOverlay('palette');
          return;
        }
        // §4.2's seven keys. Shift-Tab reaches the App as `move by -1` (`keys/resolve.ts:722`), which the machine
        // answers identically to `up` in every state but S-ONE — recorded as a deviation rather than widening the
        // resolver's op union, which every round-2/3 key fixture pins.
        const key: NavKey = action.op === 'accept' ? 'tab' : action.op === 'page' ? (action.by === -1 ? 'pageup' : 'pagedown') : action.op === 'move' ? (action.by === -1 ? 'up' : 'down') : 'enter';
        const draft = composer.buffer.text;
        const matches = paletteMatches(draft.trim(), paletteState());
        const navState = paletteNavState(draft, matches, pal.selected);
        const effect = paletteStep(navState, key, { draft, matches, selected: pal.selected });
        switch (effect.kind) {
          case 'move':
            if (effect.over === 'matches') {
              setPalette({ ...pal, selected: moveIndex(pal.selected, effect, matches.length) });
              return;
            }
            /**
             * §4.2 S-ARG / S-ARGDONE: `over: 'values'` moves the value cursor `j` and **never touches the draft**
             * — the same index `completeDraft` uses and `paletteGhostFor` previews, so the marked value shows as
             * the ghost after the cursor and Tab accepts exactly what is previewed. Writing it into the draft
             * instead would make the state S-ARGDONE, whose Enter is `run`: the measured consequence was the
             * SECOND Enter of a cycle executing `/mode jev-on` (perf `palette-arg`, 2 of 200 keys).
             */
            const tok = argTokenOf(draft);
            const spec = tok === null ? null : findCommand(commandToken(draft.trimStart()));
            const values = spec === null || tok === null ? [] : argValues(spec, tok);
            setPalette({ ...pal, selected: moveIndex(pal.selected, effect, values.length) });
            return;
          case 'accept':
            execute({ type: 'complete', dir: 1 }, ks);
            return;
          case 'run':
            onEnter();
            return;
          case 'appendSpace': {
            if (!/\s$/.test(draft)) composer.set(`${draft} `);
            return;
          }
          case 'toast':
            toast(effect.text);
            return;
          case 'none':
            return;
        }
        return;
      }
      case 'picker': {
        const o = pickerOpenRef.current;
        if (o === null) return;
        const filter = composer.buffer.text;
        const count = picker.kind === 'rewind' ? visibleRewindSteps(picker).length : visibleSessions(picker, filter).length;
        switch (action.op) {
          case 'move':
            pickerDispatch({ type: 'move', by: action.by ?? 1, count });
            return;
          case 'page':
            pickerDispatch({ type: 'page', by: action.by ?? 1, size: 6, count });
            return;
          case 'open': {
            if (picker.renaming) {
              const sess = selectedSession(picker, '');
              if (sess) o.onRename?.(sess, composer.buffer.text.trim().slice(0, 60));
              pickerDispatch({ type: 'rename', on: false });
              composer.clear();
              return;
            }
            if (picker.kind === 'rewind') {
              const st = selectedRewindStep(picker);
              if (st) o.onRewind?.(st);
              closePicker();
              return;
            }
            const sess = selectedSession(picker, filter);
            if (sess) o.onOpen?.(sess);
            closePicker();
            return;
          }
          case 'accept': {
            const sess = selectedSession(picker, filter);
            if (sess) composer.set(sess.title !== '' ? sess.title : sess.task60);
            return;
          }
          case 'preview': {
            const sess = selectedSession(picker, filter);
            const run = sess?.runs.at(-1);
            if (!sess || !run) return;
            if (picker.preview !== null) {
              pickerDispatch({ type: 'preview', lines: null });
              return;
            }
            const runsDir = o.runsDir ?? p.runsDir ?? join(p.home ?? homedir(), '.jevcode', 'runs');
            pickerDispatch({ type: 'preview', lines: readPickerPreview(runsDir, run.runId) });
            return;
          }
          case 'allWorkspaces':
            pickerDispatch({ type: 'widen' });
            return;
          case 'rename':
            pickerDispatch({ type: 'rename', on: !picker.renaming });
            composer.clear();
            return;
          case 'deleteArm':
            pickerDispatch({ type: 'deleteArm', on: true });
            return;
          case 'deleteConfirm': {
            const sess = selectedSession(picker, filter);
            pickerDispatch({ type: 'deleteArm', on: false });
            if (!sess) return;
            if (o.onDelete) o.onDelete(sess);
            else {
              const home = p.home ?? homedir();
              const runsDir = o.runsDir ?? p.runsDir ?? join(home, '.jevcode', 'runs');
              const trash = o.trashDir ?? join(home, '.jevcode', 'trash');
              const r = moveRunsToTrash(runsDir, trash, sess.runs.map((x) => x.runId));
              noteLine(r.ok ? `session ${sess.sessionId} moved to ${trash} (${r.moved.length} run${r.moved.length === 1 ? '' : 's'})` : `could not delete ${sess.sessionId}: ${r.failed.map((f) => `${f.runId} ${f.code}`).join(', ')}`, { label: '[ui]', level: r.ok ? 'info' : 'warn' });
              if (r.ok) pickerDispatch({ type: 'sessions', sessions: picker.sessions.filter((x) => x.sessionId !== sess.sessionId) });
            }
            return;
          }
          case 'close':
            closePicker();
            return;
        }
        return;
      }
      case 'review': {
        const req = s.pendingReview;
        if (!req) return;
        switch (action.op) {
          case 'approve':
            p.confirmer.resolve(req.id, true);
            dispatch({ type: 'confirm:settled', id: req.id });
            return;
          case 'decline':
            p.confirmer.resolve(req.id, false);
            dispatch({ type: 'confirm:settled', id: req.id });
            return;
          case 'note':
            setNote({ stash: composer.stash(), gate: null, pendingText: null });
            composer.set('', 0, false);
            dispatch({ type: 'note', on: true });
            return;
          case 'expand':
            dispatch({ type: 'review:expand', expanded: !s.expanded });
            return;
          case 'whyArm':
            return;
          case 'why': {
            const key = action.dim !== undefined ? reviewRowForDigit(action.dim) : null;
            const all = [...s.decisionsByStep.values()].flat();
            const d = key === null ? null : (all.find((x) => x.step === req.step && x.stage === 'risk' && x.id === key) ?? null);
            if (d === null) {
              toast(`no ${key ?? 'such'} decision for step ${req.step}`);
              return;
            }
            const block = whyBlock(d, { siblings: all.filter((x) => x.step === req.step) }, glyphs);
            noteLine(block[0] ?? 'why', { label: '[ui]', detail: block.slice(1).join('\n') });
            return;
          }
          case 'noteSubmit': {
            const n = noteRef.current;
            if (!n) return;
            const raw = sanitizeStream(composer.buffer.text).replace(/\s*\n\s*/g, ' ').trim();
            if (n.gate !== null) return; // the gate row owns `y`
            const hits = detect(raw);
            if (hits.length > 0 && raw.length > 0) {
              setNote({ ...n, gate: hits, pendingText: raw });
              return;
            }
            finishNote(raw);
            return;
          }
          case 'noteCancel':
            noteCancel();
            return;
        }
        return;
      }
      case 'gate': {
        const g = gateRef.current;
        if (action.op === 'dismiss') {
          if (g) toast(GATE_DISMISS_TIP);
          closeOverlay('secret');
          return;
        }
        if (!g) return;
        if (now() - g.openedAt < GATE_ARM_MS) return; // never within 150 ms of the Enter (§4.10)
        if (g.resolve) {
          // a controller prompt (argv task): the answer is the promise, not the composer's send path
          const answer = g.resolve;
          gateRef.current = null;
          closeOverlay('secret');
          answer(true);
          return;
        }
        closeOverlay('secret');
        send(routeSend(g.full, g.hits, { run: s.run, ranBefore: s.runsEnded > 0 }), g.history);
        return;
      }
      case 'followup': {
        const f = pendingFollowup.current;
        if (!f) return;
        if (action.op === 'raise') {
          composer.set(`/budget session-spend-cap ${(f.input.sessionCapUsd + f.input.runCapUsd).toFixed(2)}`);
          f.resolve('raise');
        } else f.resolve(action.op);
        pendingFollowup.current = null;
        closeOverlay('followup');
        return;
      }
      case 'undoPrompt': {
        const u = pendingUndo.current;
        if (!u) return;
        u.resolve(action.op);
        pendingUndo.current = null;
        closeOverlay('undo');
        return;
      }
      case 'exitConfirm': {
        const r = pendingExit.current;
        pendingExit.current = null;
        closeOverlay('exitConfirm');
        r?.(action.op === 'abortExit');
        return;
      }
      case 'wizard':
        /**
         * TUI-DESIGN-4 §2.5 (P-R6, D4) — "the one answer to 'can the user still type?', stated once": **no**, at
         * minsize the wizard is read-only. Every key is consumed and answers `WIZARD_MINSIZE_TOAST` with NO wizard
         * state change — an invisible masked field during API-key entry is its own hazard, and a numbered choice
         * whose options are off screen is not a choice. Esc and Ctrl-C are unchanged (they are `interrupt`
         * actions, not `wizard` ones), and growing back to ≥ 40×8 restores the wizard with the draft intact.
         */
        if (layoutRef.current?.degraded === 'minsize') {
          toast(WIZARD_MINSIZE_TOAST);
          return;
        }
        wizard.apply(action);
        return;
      case 'blocking': {
        const map: Record<typeof action.key, BlockingAnswer> = { r: 'retry', c: 'continue', q: 'stop', p: 'pin', l: 'login' };
        pendingBlocking.current?.(map[action.key]);
        pendingBlocking.current = null;
        return;
      }
      default: {
        // composer edits (§4)
        const r = composer.apply(action, { columns, rows });
        if (r.kind === 'toast') toastItem(r.text, r.level);
        else if (r.kind === 'submit') onEnter();
        else if (r.kind === 'ghost') {
          const pal = paletteRef.current;
          if (pal && pal.mode === 'command') {
            // §4.3 P-P2: the ghost the `→` key accepts is the MARKED row's, the same one the composer draws
            const ghost = paletteGhostFor(composer.buffer.text.trim(), paletteMatches(composer.buffer.text.trim(), paletteState()), pal.selected);
            // TUI-DESIGN-3 §4.1 rule 3: an alias ghost (` → /status`) accepts as `/status `; a prefix ghost appends its rest
            if (ghost) composer.set(ghost.kind === 'arrow' ? `${ghost.target} ` : `${composer.buffer.text.trimEnd()}${ghost.rest}`);
          }
        }
        // the palette closes when the `/` token is gone or a space follows the command (§5.3)
        if (paletteRef.current?.mode === 'command') {
          const t = composer.buffer.text;
          if (!t.trimStart().startsWith('/')) closeOverlay('palette');
        }
        if (paletteRef.current?.mode === 'mention' && !/@[^\s@]*$/.test(composer.buffer.text)) closeOverlay('palette');
      }
    }
  };

  const finishNote = (raw: string): void => {
    const n = noteRef.current;
    const req = stateRef.current.pendingReview;
    if (!n || !req) return;
    const note = redact(raw).slice(0, 600);
    p.confirmer.resolveDetailed(req.id, note.length > 0 ? { approved: false, note } : { approved: false });
    dispatch({ type: 'confirm:settled', id: req.id });
    composer.restore(n.stash);
    setNote(null);
    dispatch({ type: 'note', on: false });
  };

  /** §6.2 Esc (and Ctrl-C, F5) in the note field: the note's gate closes first; else the stashed draft comes back and the box stays. */
  const noteCancel = (): void => {
    const n = noteRef.current;
    if (!n) return;
    if (n.gate !== null) {
      setNote({ ...n, gate: null, pendingText: null });
      return;
    }
    composer.restore(n.stash);
    setNote(null);
    dispatch({ type: 'note', on: false });
  };

  const layoutRef = useRef<Layout | null>(null);
  // TUI-DESIGN-4 §1.3.3: what the scroll keys need from the last frame (null under the classic renderer)
  const scrollRef = useRef<{ rows: number; height: number } | null>(null);
  /**
   * §1.3.3: the scroll keys, handled **before** `resolveKey` and only under `fullscreen`, so the key resolver,
   * `docs/KEYS.md`, `completions/*` and `man/jevcode.1` are untouched (§1.3.5's discipline). `PgUp`/`PgDn` and
   * `Shift+↑`/`Shift+↓` are free in the `composer` context (`bindings.ts:129–130, 141–142` bind PgUp/PgDn in
   * `picker` and `palette` only); **`Home`/`End` are NOT** — `bindings.ts:92–93` give them to the composer — so the
   * ends are `Ctrl+Home` / `Ctrl+End`. Returns null when the event is not a scroll key.
   */
  const scrollKeyOf = (ev: KeyEvent): ScrollKey | null => {
    if (ev.paste === true) return null;
    const k = ev.key;
    if (k.home && k.ctrl) return 'top';
    if (k.end && k.ctrl) return 'bottom';
    if (k.pageUp) return 'pageUp';
    if (k.pageDown) return 'pageDown';
    if (k.shift && k.upArrow) return 'lineUp';
    if (k.shift && k.downArrow) return 'lineDown';
    return null;
  };
  const keyState = (): KeyState => {
    const s = stateRef.current;
    const b = composer.buffer;
    const m = composer.mirror(columns);
    const n = noteRef.current;
    traceLine(`tui.keystate overlay=${s.overlay} overlayArmed=${s.overlayArmed} pending=${s.pendingReview !== null}`);
    return {
      overlay: s.overlay,
      reviewArmed: s.overlay === 'review' && s.overlayArmed,
      // `starting` is a submit in flight with no engine yet (`run:start` flips it to live synchronously): the S0 rules
      // apply to Ctrl-C / Esc / Ctrl-D — an abort would land on nothing and wedge the session (finding 1)
      run: s.run === 'starting' ? 'none' : s.run,
      // while the `d` note field owns the composer row, F5's text rule reads the stashed human draft, not the note
      draftEmpty: s.noteMode && n !== null ? n.stash.text.length === 0 : b.text.length === 0,
      // §4.6: a one-row draft is both the first and the last visual row (`'only'`): the resolver applies the history rule to Up and Down
      cursorRow: m.rows <= 1 ? 'only' : m.cursorRow,
      historySearch: composer.search !== null,
      queue: s.queue.length,
      mode,
      noteMode: s.noteMode,
      armed: armedRef.current,
      picker: pickerOpenRef.current !== null,
      overlayArmed: s.overlayArmed,
      minsize: layoutRef.current?.degraded === 'minsize',
      retrying: s.retrying !== null,
      /**
       * TUI-DESIGN-4 §4.7 E12 / E13 (§9.2's `App.tsx` row): the whole draft is a single `/token`. Both rules are
       * inert until this is supplied — E12 makes Ctrl-C with the palette open `CLOSE_OVERLAY_AND_CLEAR` (today it
       * only closed the overlay, leaving the half-typed `/budgett` behind, which is the measured trap), and E13
       * lets `/` at the END of such a draft reopen the palette instead of inserting a second slash.
       * The note field's stashed human draft is the one E12 clears, exactly as `draftEmpty` above reads it.
       */
      draftTokenOnly: ((): boolean => {
        const text = (s.noteMode && n !== null ? n.stash.text : b.text).trim();
        return text.length > 0 && text === commandToken(text);
      })(),
      cursorAtEnd: b.cursor >= b.text.length,
    };
  };

  /** §13.2 `[r] retry now`: the host's `retryNow()` (the engine's waker); false when nothing was sleeping. */
  const retryNow = (): boolean => (bridge.host ? bridge.host.retryNow() : (bridge.engine?.retryNow() ?? false));

  const handleKey = (ev: KeyEvent): void => {
    const t = now();
    dispatch({ type: 'key', at: t });
    notifyTimers.keystroke();
    if (ev.escExpired !== true) log.key(keyClassOf(ev.input, ev.key as Key, ev.paste === true), ev.input.length, stateRef.current.overlay === 'wizard');
    if (ev.paste === true) log.paste(ev.input.length);
    const ks = keyState();
    const cur = stateRef.current;
    // TUI-DESIGN-2 §3.1 row 10: Ctrl-C ×1 while a submission is thinking (`run: 'starting'` under a phase, finding 1) aborts the
    // request (the controller's `chatSignal` → toast `stopped thinking`); no arm, no bubble, no exit — the S0 rules resume afterwards
    if (chatThinking(cur) && cur.overlay === 'none' && ev.key.ctrl && ev.input === 'c' && ev.paste !== true) {
      if (bridge.host) bridge.host.abort('human_abort');
      else p.onAbort('human_abort');
      return;
    }
    // TUI-DESIGN-2 §4.6: Esc on an empty idle draft collapses an open panel before arming Esc Esc (the buffered lone Esc)
    if (ev.escExpired === true && cur.overlay === 'none' && !runIsLive(cur.run) && cur.panel !== 'collapsed' && composer.buffer.text.length === 0 && pickerOpenRef.current === null && !cur.noteMode) {
      armedRef.current = { ...armedRef.current, escBufferAt: null };
      dispatch({ type: 'panel', panel: 'collapsed' });
      return;
    }
    // the note's own secret gate (§6.4): only `y` sends, anything else cancels the gate
    const n = noteRef.current;
    if (n && n.gate !== null && ks.overlay === 'review') {
      if (!ev.key.ctrl && !ev.key.meta && (ev.input === 'y' || ev.input === 'Y')) {
        const text = n.pendingText ?? '';
        for (const h of n.gate) {
          const span = text.slice(h.start, h.end);
          if (span.length >= 8) bridge.host?.addSecret(`note#${h.start}`, span);
        }
        finishNote(text);
      } else if (ev.key.escape || ev.key.return || ev.input.length > 0) setNote({ ...n, gate: null, pendingText: null });
      return;
    }
    // §6.5 screen reader: under an armed review the composer stays live; Enter on a line that is exactly 1/2/3/y/n and
    // was typed after arming (the stash emptied the draft then) answers, any other line is a steer and re-announces the
    // prompt; Esc / Ctrl-C / Ctrl-D keep the review's own meaning (decline / F5 rule / ignored)
    if (sr && ks.overlay === 'review' && ks.reviewArmed && !ks.noteMode && ev.paste !== true) {
      const composerKs: KeyState = { ...ks, overlay: 'none', reviewArmed: false };
      if (ev.key.return && !ev.key.shift && !ev.key.meta && !ev.key.ctrl) {
        const req = stateRef.current.pendingReview;
        const answer = srStash.current !== null && composer.buffer.text.length > 0 ? srReviewAnswer(composer.buffer.text) : null;
        if (req && answer !== null) {
          composer.clear();
          if (answer === 'note') execute({ type: 'review', op: 'note' }, ks);
          else {
            p.confirmer.resolve(req.id, answer === 'approve');
            dispatch({ type: 'confirm:settled', id: req.id });
          }
          return;
        }
        if (composer.buffer.text.trim().length > 0) onEnter();
        noteLine(SR_REVIEW_PROMPT, { label: '[ui]' });
        return;
      }
      const reviewKey = ev.key.escape || ev.escExpired === true || (ev.key.ctrl && (ev.input === 'c' || ev.input === 'd'));
      const actions = resolveKey(reviewKey ? ks : composerKs, ev, t, bindings);
      for (const a of actions) execute(a, composerKs);
      return;
    }
    // TUI-DESIGN-4 §1.3.3: the fullscreen viewport's scroll keys, ahead of the resolver and only while the composer
    // owns the keyboard (a picker, a palette or an armed review keeps PgUp/PgDn for itself, exactly as today)
    if (ks.overlay === 'none' && !ks.picker && !ks.noteMode) {
      const geom = scrollRef.current;
      const sk = geom === null ? null : scrollKeyOf(ev);
      if (sk !== null && geom !== null) {
        // §1.3.3: the anchor lives in `UiState.scroll` (contract 1.7) and moves through the one reducer
        dispatch({ type: 'scroll', scroll: applyScrollAt(stateRef.current.scroll, sk, geom.rows, geom.height) });
        return;
      }
    }
    const actions = resolveKey(ks, ev, t, bindings);
    for (const a of actions) execute(a, ks);
  };

  useInput(
    (input, key) => {
      // §4.5 step 1 amended: one delivery may carry several coalesced keys (finding 2)
      const split = splitInputChunk(input, key);
      for (const ev of split.events) handleKey(ev);
      if (split.foldedEnter) toast(COALESCED_ENTER_TOAST);
    },
    // `stdin.isTTY` is undefined (not false) on a pipe; Ink only skips raw mode for `=== false`.
    { isActive: Boolean(isRawModeSupported) },
  );
  usePaste((text) => handleKey({ input: text, key: NOKEY, paste: true }), { isActive: Boolean(isRawModeSupported) });

  // ----- bridge commands (the renderer's imperative hooks)
  useEffect(() => {
    bridge.handler = (c) => {
      switch (c.type) {
        case 'wizard':
          wizard.start(c.detect);
          return;
        case 'wizard:reopen':
          wizard.reopen(c.at, c.runLive, c.opts);
          return;
        case 'intake': {
          // TUI-DESIGN-2 §3.7: one card at a time — a previous card resolves `keep`
          pendingIntake.current?.resolve('keep');
          pendingIntake.current = { card: c.card, resolve: c.resolve };
          dispatch({ type: 'overlay', overlay: 'intake' });
          return;
        }
        case 'restoreDraft':
          composer.set(c.text);
          return;
        case 'bindings':
          // TUI-DESIGN-3 §4.4 F10: the table swaps live; a chord in flight resets (its first key belonged to the old table)
          setBindingsState(c.bindings);
          armedRef.current = { ...armedRef.current, chord: null };
          return;
        case 'picker':
          pickerOpenRef.current = c.open;
          pickerDispatch({ type: 'open', kind: c.open.kind, workspace: c.open.workspace, ...(c.open.sessions ? { sessions: c.open.sessions } : {}), ...(c.open.rewindSteps ? { rewindSteps: c.open.rewindSteps } : {}), ...(c.open.sort ? { sort: c.open.sort } : {}) });
          composer.clear();
          dispatch({ type: 'picker', open: true });
          return;
        case 'followup':
          pendingFollowup.current?.resolve('cancel');
          pendingFollowup.current = { input: c.input, resolve: c.resolve };
          dispatch({ type: 'overlay', overlay: 'followup' });
          return;
        case 'undo':
          pendingUndo.current?.resolve('abort');
          pendingUndo.current = { row: c.row, resolve: c.resolve };
          dispatch({ type: 'overlay', overlay: 'undo' });
          return;
        case 'exitConfirm':
          pendingExit.current?.(false);
          pendingExit.current = (yes) => {
            if (yes) exitAfterRunEnd.current = 0;
            c.resolve(yes);
          };
          if (stateRef.current.run === 'none') {
            pendingExit.current = null;
            c.resolve(true);
            return;
          }
          dispatch({ type: 'overlay', overlay: 'exitConfirm' });
          return;
        case 'blocking':
          pendingBlocking.current?.('stop');
          pendingBlocking.current = c.resolve;
          if (stateRef.current.blocking === null) dispatch({ type: 'event', event: { type: 'blocking:request', request: c.request }, at: now() });
          return;
        case 'suspend':
          void doSuspend();
          return;
        case 'secretGate': {
          // §4.10 / §10.2: one gate at a time — a composer gate already open is dismissed (its draft is kept), a previous prompt refuses
          const prev = gateRef.current;
          gateRef.current = null;
          prev?.resolve?.(false);
          gateRef.current = { full: '', hits: c.hits, openedAt: now(), resolve: c.resolve };
          dispatch({ type: 'overlay', overlay: 'secret' });
          return;
        }
        case 'dispatch':
          dispatch(c.action);
          return;
      }
    };
    const queued = bridge.queue.splice(0);
    for (const c of queued) bridge.handler(c);
    return () => {
      bridge.handler = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, wizard, dispatch]);

  // ----- pane failures (§13.4). Referentially stable (TUI-DESIGN-2 §4.5, finding 3): it is a prop of the memoised
  // <Transcript>, and a fresh arrow per render would re-render <Static> on every App commit — including a hidden-only
  // batch — and take Ink's `isStaticDirty → onImmediateRender` path; the state is read through `stateRef`
  const confirmer = p.confirmer;
  const onPaneFail = useCallback(
    (f: PaneFailure): void => {
      log.error(`render fault pane=${f.pane} ${f.error.name}: ${redact(f.error.message)} ${redact(f.componentStack ?? '')}`.slice(0, 500));
      dispatch({ type: 'local', text: `ui: ${f.pane} pane failed to render (${f.error.name}) — run continues; details in ${log.file || 'jevcode.log'}`, label: '[ui]', level: 'error' });
      const pending = stateRef.current.pendingReview;
      if (f.pane === 'overlay' && pending) {
        confirmer.resolveDetailed(pending.id, { approved: false });
        dispatch({ type: 'confirm:settled', id: pending.id });
      }
    },
    [log, redact, dispatch, confirmer],
  );
  const fault = p.fault ?? env['JEVCODE_FAULT'];
  // §13.4 at the App level: the pure line builders run in this render body, outside every <PaneBoundary>; a throw
  // there would reach Ink's InternalErrorBoundary. `guard()` degrades that one pane to its fallback instead and
  // reports the failure after commit (a render body must not dispatch). `render:<pane>:lines` throws once for the tests.
  const renderFaults = useRef<PaneFailure[]>([]);
  const guard = <T,>(pane: string, fn: () => T, fallback: T): T => {
    const injected = builderFaultFor(pane);
    if (fault === injected && !RENDER_FAULTS_FIRED.has(injected)) {
      RENDER_FAULTS_FIRED.add(injected);
      const err = new Error(`injected render fault (${injected})`);
      err.name = 'InjectedRenderFault';
      renderFaults.current.push({ pane, error: err, componentStack: null });
      return fallback;
    }
    try {
      return fn();
    } catch (e) {
      const error = e instanceof Error ? e : Object.assign(new Error(String(e)), { name: 'NonError' });
      renderFaults.current.push({ pane, error, componentStack: null });
      return fallback;
    }
  };
  useEffect(() => {
    const failed = renderFaults.current.splice(0);
    for (const f of failed) onPaneFail(f);
  });

  // ----- layout (§2.1)
  const pickerOpen = pickerOpenRef.current !== null;
  const noteView = (): ReviewNote | null => {
    if (!note) return null;
    if (note.gate) return { text: '', gate: gateLines(note.gate, columns)[0] ?? null };
    // §4.3 / §10.2: the note is typed live in the header row; its hit spans render as `•` cells like the composer's
    return { text: composer.buffer.text, gate: null, spans: hitSpans(composer.hits()) };
  };
  const overlayData: OverlayData = guard<OverlayData>(
    'overlay',
    () => ({
      intake: pendingIntake.current?.card ?? null,
      review: state.pendingReview && state.overlay === 'review' ? { req: state.pendingReview, note: noteView() } : null,
      wizard: state.overlay === 'wizard' ? { state: wizard.state, trust: (bridge.wizardHost?.trustInputs?.() ?? null) as TrustInputs | null } : null,
      followup: pendingFollowup.current?.input ?? null,
      secret: gateRef.current ? { hits: gateRef.current.hits } : null,
      blocking: state.blocking,
      palette: palette && palette.mode !== 'mention' ? { query: composer.buffer.text.trim(), state: paletteState(), selected: palette.selected } : null,
      mention: palette && palette.mode === 'mention' ? { rows: rank(/@([^\s@]*)$/.exec(composer.buffer.text)?.[1] ?? '', palette.candidates, 8).map((x) => x.candidate), selected: palette.selected } : null,
      undo: pendingUndo.current ? { row: pendingUndo.current.row } : null,
    }),
    {},
  );
  const visible = useVisibleItems(state.items, state.staticEpoch);
  const overlayKind: OverlayKind = state.overlay;
  // §6.5: under a screen reader the review does not collapse the composer — the answer is a typed line
  const srReview = sr && overlayKind === 'review' && state.overlayArmed;
  const collapsing = (isCollapsingOverlay(overlayKind) || overlayKind === 'review') && !srReview;
  // §1 (one-shot: the composer is mounted for steering only) / §3.3 (one-shot has no idle states: the process exits at run:end):
  // once the run ended nothing can be steered or submitted, so the composer row is inert and shows no placeholder
  const oneShotDone = mode === 'one-shot' && state.run === 'none' && (state.done !== null || state.runsEnded > 0);
  const composerActive = !collapsing && !oneShotDone && (state.pendingReview === null || srReview) && overlayKind !== 'wizard' && overlayKind !== 'blocking';
  const composerWant = collapsing || state.noteMode ? 1 : guard('composer', () => draftRows(buffer.text, buffer.chips, wrapInner, pickerOpen ? `${promptFor(glyphs)}filter: ` : promptFor(glyphs)), 1);
  const banner = guard('banner', () => bannerRow(state.loop, columns, glyphs), null);
  const liveRows = guard<string[]>('live', () => (state.retrying ? retryLiveLines(state.retrying, state.nowMs, CAP.live, columns, glyphs) : liveLines(state.live, CAP.live, columns, state.toolChars, state.synth, state.sampling)), []);
  // TUI-DESIGN-2 §5.4 (finding 2): the brand row is the idle rule row until the first `run:ready`; a submission in flight
  // (`starting`, the chat phase) never swaps it for the strip and back
  const ranBefore = state.ready !== null || state.done !== null || state.runsEnded > 0;
  // TUI-DESIGN-3 §3 (D-I): the wordmark is the pane slot's idle tenant. The reveal runs in every boxed frame ≥ 64 columns while the
  // splash is `running` (16–20 rows included); afterwards `wordmarkWanted` (§3.1) decides the WANT and the layout's whole-or-absent
  // grant (§3.7) the SHOW. `ui.wordmark` defaults to `static` under the SSH launch source (§3.2 twins).
  const wordmarkSetting: WordmarkSetting = ui?.wordmark ?? (lx.ssh === true ? 'static' : 'sweep');
  const splashOn = state.splash === 'running' && motion.time < SPLASH_MS && columns >= WORDMARK_MIN_COLUMNS && boxed && !launch.screenReader;
  const wanted = wordmarkWanted({ boxed, rows, postRun: ranBefore && !state.postRunKeySeen, columns, screenReader: launch.screenReader, run: state.run, panel: state.panel, pickerOpen, overlay: overlayKind, expanded: state.expanded, setting: wordmarkSetting });
  // the rows never depend on the band (§3.8 ordering): rows → layout → the loop → `spans(loop.band)` at render
  const mark: { rows: string[]; spans: (band: GridBand | null) => readonly SplashSpan[] } | null = splashOn
    ? guard(
        'pane',
        () => {
          const f = splashFrame(motion.time, columns, glyphs, VERSION);
          return { rows: f.rows, spans: () => f.spans };
        },
        null,
      )
    : // §1.3.2: in `fullscreen` the header slot IS the mark in the tall tier — `wordmarkWanted`'s pane rules (panel,
      // picker, review, the live run) are about the classic pane slot, which the fullscreen tree does not have; the
      // allocator has already decided whether five rows are affordable (`full.header === CAP.splash`).
      wanted || fullscreen
      ? guard('pane', () => wordmarkFrame({ columns, version: VERSION, glyphs }), null)
      : null;
  const wordmarkOn = mark !== null && mark.rows.length > 0;
  // TUI-DESIGN-2 §4.6: 0 (collapsed) · 6 (open) · 12 (full / picker) · 5 (the wordmark)
  const paneWant = pickerOpen ? PICKER_PANE_WANT : wordmarkOn ? CAP.splash : state.panel === 'open' ? CAP.panel : state.panel === 'full' ? CAP.pane : 0;
  // TUI-DESIGN-2 §4.2: in the boxed tier the secret gate is a console row, never the `secret` overlay
  const gateUp: 0 | 1 = boxed && overlayKind === 'secret' && gateRef.current !== null ? 1 : 0;
  const layoutInput: LayoutInput = {
    rows,
    columns,
    overlay: overlayKind,
    // a failed overlay builder still gets one row: the boundary's fallback row needs it
    overlayWant: guard('overlay', () => overlayWant(overlayKind, overlayData, rows, columns, chrome), overlayKind === 'none' || (boxed && overlayKind === 'secret') ? 0 : 1),
    previewWant: guard('overlay', () => overlayPreviewWant(overlayKind, overlayData), 0),
    expanded: state.expanded,
    composerWant,
    queueWant: state.queue.length,
    liveWant: liveRows.length,
    bannerWant: banner !== null ? 1 : 0,
    paneWant,
    chrome,
    gate: gateUp,
    // TUI-DESIGN-3 §3.7: the mark is granted whole or not at all (never its top rows)
    paneWhole: wordmarkOn,
  };
  // TUI-DESIGN-4 §1.3.2: the fullscreen renderer gets a SECOND allocator whose post-condition is `total === rows`
  // exactly (one row of error costs a full-screen clear per keystroke — A1 measured 37 clears for 36 frames). Its
  // slots are mapped onto the classic `Layout` so `consoleTop` / `composerTop` / `overlayTop` — which only ever sum
  // the rows ABOVE a slot — stay the one cursor arithmetic: `pane` carries the header and `queue` the viewport.
  const full: FullLayout | null = fullscreen
    ? computeFullLayout({ rows, columns, overlay: overlayKind, overlayWant: layoutInput.overlayWant, previewWant: layoutInput.previewWant, expanded: state.expanded, composerWant, gate: gateUp, screenReader: launch.screenReader })
    : null;
  const layout = full === null ? computeLayout(layoutInput) : fullLayoutAsLayout(full, rows);
  layoutRef.current = layout;
  // in fullscreen the header slot draws the 5-row mark only in the tall tier; the compact / narrow tiers draw the
  // 1-row brand strip there (§1.3.2's table), so the mark is never cut to its top rows
  const markShown = full === null ? wordmarkOn && layout.pane > 0 : wordmarkOn && full.header === CAP.splash;
  // TUI-DESIGN-3 §3.6: the idle sweep — active only while the mark has rows, after the settle, with motion allowed and attention awake;
  // the quiet-after-key rule lives inside the hook (never in `isActive`); the App renders `loop.band`, never `loopBand(loop.k)`
  const attention = attentionAt(state.nowMs, state.lastActivityAt);
  // TUI-DESIGN-4 §1.2 P-H2: the mark stays up during a run at >= WORDMARK_LIVE_MIN_ROWS rows, but the sweep is FROZEN while live —
  // a run still writes zero decoration frames, so the `dynamic <= maxFps + 1` and `idle-frames` gates are untouched
  const loop = useIdleLoop({ shown: markShown && !splashOn && !runIsLive(state.run), splashRunning: state.splash === 'running', enabled: wordmarkSetting === 'sweep' && !reducedMotion && depth > 0, attention, nowMs: state.nowMs, lastKeystrokeAt: state.lastKeystrokeAt });
  // Per-row span arrays, memoised on the mark and the band tick: a key frame re-renders the App but the five <SplashRow>s keep
  // their props (React skips them; Ink's Yoga cache keeps their layout), so the persistent mark costs a key frame nothing.
  // TUI-DESIGN-4 §1.2 P-H3 (= §7.3 P-P3 item 2): `mark.spans(...)` ran in the render body outside every boundary, so a
  // throw there reached Ink's InternalErrorBoundary and took the whole frame. It is guarded now, and the fallback is
  // BLANK rows of the same height — the idle tenant disappearing silently is the correct degradation; the `[ui]` item
  // the guard reports after commit carries the detail. The rows themselves render inside `<PaneBoundary pane="wordmark">`.
  const markView = useMemo((): { rows: readonly string[]; spans: readonly (readonly MarkSpan[])[] } => {
    if (mark === null) return { rows: [], spans: [] };
    const all = guard<readonly SplashSpan[] | null>('wordmark', () => mark.spans(loop.band), null);
    if (all === null) return { rows: mark.rows.map(() => ''), spans: mark.rows.map(() => NO_MARK_SPANS) };
    return { rows: mark.rows, spans: mark.rows.map((_row, i) => all.filter((sp) => sp.row === i)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mark, loop.phase, loop.k]);
  const top = composerTop(layout);
  // TUI-DESIGN-2 §4.3: the wizard's rows live inside the console (its top edge sits above the overlay allocation)
  const wizardHosted = boxed && overlayKind === 'wizard' && layout.chrome > 0;
  const cTop = consoleTop(layout) - (wizardHosted ? layout.overlay : 0);
  const overlayTop = layout.rule + layout.live + layout.banner + layout.pane + layout.queue;
  const header = useMemo(() => (mode === 'session' ? sessionHeaderItem(p.cwd ?? process.cwd()) : headerItem(p.task, p.resumeId)), [mode, p.cwd, p.task, p.resumeId]);
  const spinner = useSpinner(spinnerActive(state), reducedMotion);
  const statusOpts: StatusLineOptions = { ascii: glyphs.mode === 'ascii', reducedMotion, spinnerFrame: spinner, mode, flatBadge: !boxed };
  // TUI-DESIGN-2 §3.1 (finding 1): an engine run — never a submission in flight — colours the border `borderFocus` and the prompt `steer`
  const runLive = runIsLive(state.run);
  // TUI-DESIGN-3 §5.2 A4: the streaming caret `▍` on the last live row, a 1 Hz blink riding the spinner tick (steady under reduced motion)
  const streaming = runLive && state.live !== '' && state.retrying === null && liveRows.length > 0;
  const caret = streaming && streamCaretOn(spinner, reducedMotion) ? (glyphs.mode === 'ascii' ? '|' : (glyphs.eighths[3] ?? '')) : '';
  // TUI-DESIGN-3 §5.2 A5: the run-start sweep over the rule row's `─` cells (6 frames; none under reduced motion — the edges flip at once)
  const startSweep = useMotion(runLive && !reducedMotion, RUN_START_SWEEP_MS);
  const ruleBand = startSweep.settled || !runLive || reducedMotion ? null : runStartBand(startSweep.time, Math.min(columns, RULE_MAX_CELLS));
  // TUI-DESIGN-3 §5.2 A6: the run-end edge fade — three 70 ms frames after `run:end` (instant under reduced motion); one fade per ended run
  const fadedRuns = useRef(0);
  const fadeActive = state.run === 'none' && state.runsEnded > 0 && fadedRuns.current !== state.runsEnded && !reducedMotion;
  const endFade = useMotion(fadeActive, RUN_END_FADE_MS, RUN_END_FADE_STEP_MS);
  if (fadeActive && endFade.settled) fadedRuns.current = state.runsEnded;
  const edgeRole: ColorRole | null = runLive ? null : fadeActive && !endFade.settled ? runEndEdgeRole(endFade.time) : null;
  const consoleExtra: { edgeRole?: ColorRole } = edgeRole !== null ? { edgeRole } : {};
  const thinking = chatThinking(state);
  const composerMode: ComposerMode = pickerOpen
    ? 'filter'
    : oneShotDone
      ? 'done'
      : overlayKind === 'intake'
        ? 'intakeWait'
        : overlayKind === 'review' || (state.pendingReview !== null && state.run !== 'none' && overlayKind === 'none')
          ? state.pendingReview !== null && overlayKind === 'review'
            ? 'review'
            : state.run !== 'none'
              ? 'steer'
              : 'task'
          : overlayKind === 'followup'
            ? 'followupWait'
            : overlayKind === 'exitConfirm'
              ? 'exitWait'
              : overlayKind === 'blocking'
                ? 'blocked'
                : thinking
                  ? 'thinking' // §3.1 row 1 / §4.4: `(thinking…)` while the intake, lookup or reply is in flight (the run is `starting`)
                  : runLive
                    ? 'steer' // TUI-DESIGN-3 §5.2 P7: `starting` without a phase keeps the previous idle placeholder — never the steer one
                    : state.turns > 0 || state.runsEnded > 0 || state.done !== null
                      ? 'followup'
                      : 'task';
  const paneState = guard('pane', () => paneStateOf(state), { tab: state.tab, step: state.step, rows: [], plan: null, timeline: [], synth: null, mode: state.mode });
  const pickerView = pickerOpen ? guard('pane', () => pickerLines(picker, { filter: picker.renaming ? '' : buffer.text, rows: layout.pane, columns, nowMs: state.nowMs, glyphs }), null) : null;
  // TUI-DESIGN-4 §1.3.3: the wrapped-row index. `rebuildFor` appends incrementally, rebuilds on a width or glyph
  // change and returns the SAME object when neither moved (edge 7: a `/theme` never rebuilds it), so the ref keeps
  // one index for the life of the mount and the classic renderer never builds one at all.
  const viewportRef = useRef<ViewportIndex>(emptyIndex(columns, glyphs));
  if (full !== null) viewportRef.current = guard('viewport', () => rebuildFor(viewportRef.current, visible, columns, glyphs), viewportRef.current);
  const viewportIndex = viewportRef.current;
  const viewportTop = full === null ? 0 : resolveTop(viewportIndex, state.scroll, full.viewport);
  scrollRef.current = full === null ? null : { rows: viewportIndex.rows.length, height: full.viewport };
  // §1.3.2: the position segment's rung ladder, fed to `panelStrip` as its rightmost segment — dropped after the
  // brand and before any pane information, so a 40-column fullscreen strip still names where you are
  const position = full === null ? null : positionRungs(viewportTop, full.viewport, viewportIndex.rows.length);
  const rule = guard(
    'rule',
    () =>
      ruleRowText({
        state: paneState,
        latencies: state.jevLatencies,
        paneRows: layout.pane,
        columns,
        overlay: overlayKind,
        terminalRows: rows,
        panel: pickerOpen ? 'full' : state.panel,
        splash: state.splash,
        splashTime: state.splash === 'running' ? motion.time : null,
        // §1.3.2: the fullscreen rule row is the branded strip from frame 0 — it is the only place the position
        // segment can go, and the header above it is the mark, so there is no pre-run `brandRow` state to keep
        ranBefore: full === null ? ranBefore : true,
        // TUI-DESIGN-3 §3.3: the plain rule while the mark has rows (before the first run:ready); the strip keeps the row afterwards
        wordmark: full === null && markShown,
        version: VERSION,
        glyphs,
        pickerHeader: pickerOpen ? pickerRule(picker, columns, glyphs) : null,
        // §1.3.2: right-aligned, in place of the `[d] [p] [t] [s]` tail (classic passes nothing and keeps the tail)
        ...(position !== null && full !== null && full.header === CAP.splash ? { position } : {}),
      }),
    plainRule(columns, glyphs),
  );
  /**
   * §1.3.2: the `compact` / `narrow` fullscreen header row **is** P-H1's strip, verbatim — `panelStrip` with
   * `brand: true` and the right-aligned position ladder. In the `tall` tier the header is the 5-row mark and the
   * strip is the rule row below it (F-H3), so this is null there and the rule row carries the segment instead.
   */
  const fullHeaderRow: string | null =
    full === null || full.header !== 1
      ? null
      : guard(
          'rule',
          () =>
            ruleRowText({
              state: paneState,
              latencies: state.jevLatencies,
              paneRows: 0,
              columns,
              overlay: overlayKind,
              terminalRows: rows,
              panel: 'collapsed',
              splash: 'done',
              splashTime: null,
              ranBefore: true,
              version: VERSION,
              glyphs,
              pickerHeader: null,
              ...(position !== null ? { position } : {}),
            }),
          plainRule(columns, glyphs),
        );
  const statusState = guard<StatusLineState | null>('status', () => statusView({ ...state, git: state.git === null ? null : { ...state.git, head: gitHead.head ?? state.git.head, frozen: gitHead.frozen } }, { picker: pickerOpen }), null);
  const badge = modeBadge(state.modeBadge.mode, state.modeBadge.pending, glyphs);
  const consoleTitle = wizardHosted ? wizardConsoleTitle(wizard.state.step, glyphs) : pickerOpen && picker.kind ? pickerConsoleTitle(picker.kind, glyphs) : null;
  const gateRow = gateUp === 1 && gateRef.current ? (gateLines(gateRef.current.hits, consoleInnerWidth(columns))[0] ?? null) : null;
  const queueLines = guard<string[]>('queue', () => queueRows(state.queue, state.step + 1, full === null ? layout.queue : 0, columns, glyphs), []);
  // TUI-DESIGN-4 §4.3 P-P2 (§9.2's `App.tsx` row): "what will Tab give me" and "what is the marker on" are ONE
  // question, so the ghost reads `matches[selected]`, never `matches[0]` — A4 p5 captured a marker on `/llm` beside a
  // `/mode +5` ghost, and with §4.2's Enter cycling the ghost would otherwise never move at all.
  const ghost = palette && palette.mode === 'command' ? guard('composer', () => paletteGhostFor(buffer.text.trim(), paletteMatches(buffer.text.trim(), paletteState()), palette.selected), null) : null;
  // the App owns the single cursor: hidden unless a child places it during its render
  setCursorPosition(undefined);
  const staticOnly = layout.degraded === 'static-only';
  const maskGlyph = maskGlyphFor(glyphs);
  const logName = log.file || 'jevcode.log';

  return (
    <Box flexDirection="column">
      {/*
        TUI-DESIGN-4 §1.3: `classic` keeps `<Static>` — the terminal's own scrollback, wheel scrolling, find and
        whole-session copy. `fullscreen` replaces it with the header at the physical top and a keyboard-scrolled
        `<Viewport>`; Ink is mounted with `alternateScreen` + `incrementalRendering` forced, so nothing is written
        above row 1 at all. Everything below this block is the SAME tree in both renderers (§1.3.5).
      */}
      {full === null ? (
        /* §13.4: each <Static> item has its own boundary inside <Transcript>; this outer one is the last resort and retries with the next item */
        <PaneBoundary pane="transcript" onFail={onPaneFail} resetKey={visible.length}>
          <Transcript items={visible} header={header} theme={theme} color={depth} glyphs={glyphs} epoch={state.staticEpoch} onFail={onPaneFail} fault={fault} log={logName} columns={columns} keySeq={state.keySeq} />
        </PaneBoundary>
      ) : null}
      {full !== null && full.header > 0 ? (
        /* §1.3.2: the header — the 5-row mark in the `tall` tier, P-H1's 1-row brand strip in `compact` / `narrow` */
        <PaneBoundary
          pane="wordmark"
          onFail={onPaneFail}
          fault={fault}
          log={logName}
          resetKey={state.runId ?? ''}
          fallback={() => (
            <Box flexDirection="column" height={full.header} overflow="hidden">
              {Array.from({ length: full.header }, (_unused, i) => (
                <Text key={`fhf${i}`} wrap="truncate">
                  {' '}
                </Text>
              ))}
            </Box>
          )}
        >
          <Box flexDirection="column" height={full.header} overflow="hidden">
            {fullHeaderRow !== null ? (
              <RuleRow text={fullHeaderRow} theme={theme} color={depth} glyphs={glyphs} band={null} />
            ) : (
              markView.rows.slice(0, full.header).map((row, i) => <SplashRow key={`fh${i}`} row={row} spans={markView.spans[i] ?? NO_MARK_SPANS} theme={theme} color={depth} />)
            )}
          </Box>
        </PaneBoundary>
      ) : null}
      {!staticOnly && layout.rule > 0 ? (
        <Box height={layout.rule} overflow="hidden">
          <RuleRow text={rule} theme={theme} color={depth} glyphs={glyphs} band={ruleBand} />
        </Box>
      ) : null}
      {full !== null ? (
        <Viewport index={viewportIndex} height={full.viewport} scroll={state.scroll} theme={theme} color={depth} showAbove onFail={onPaneFail} fault={fault} log={logName} />
      ) : null}
      {full === null && !staticOnly && layout.live > 0 ? (
        <PaneBoundary pane="live" onFail={onPaneFail} fault={fault} log={logName}>
          <Box flexDirection="column" height={layout.live} overflow="hidden">
            {liveRows.slice(0, layout.live).map((line, i, shown) => (
              <Text key={`l${i}`} wrap="truncate" {...(state.retrying ? textProps(theme, 'warn', depth) : {})}>
                {line}
                {caret !== '' && i === shown.length - 1 ? <Text {...textProps(theme, 'sweep', depth)}>{caret}</Text> : null}
              </Text>
            ))}
          </Box>
        </PaneBoundary>
      ) : null}
      {full === null && !staticOnly && layout.banner > 0 && banner !== null ? (
        <Box height={1} overflow="hidden">
          <Text wrap="truncate" {...textProps(theme, 'warn', depth)}>
            {banner}
          </Text>
        </Box>
      ) : null}
      {full === null && !staticOnly && markShown && mark !== null ? (
        // P-H3 / §1.3.2 edge 5: the boundary's fallback is BLANK rows of the SAME height — the idle tenant
        // disappearing silently is the correct degradation, and the rendered height must keep equalling the height
        // `computeLayout` granted (the default one-row red notice would make the frame `layout.pane − 1` rows short
        // and would duplicate the `[ui]` item the App already appends). `resetKey` lets the next run try again.
        <PaneBoundary
          pane="wordmark"
          onFail={onPaneFail}
          fault={fault}
          log={logName}
          resetKey={state.runId ?? ''}
          fallback={() => (
            <Box flexDirection="column" height={layout.pane} overflow="hidden">
              {Array.from({ length: layout.pane }, (_unused, i) => (
                <Text key={`sf${i}`} wrap="truncate">
                  {' '}
                </Text>
              ))}
            </Box>
          )}
        >
          <Box flexDirection="column" height={layout.pane} overflow="hidden">
            {markView.rows.slice(0, layout.pane).map((row, i) => (
              <SplashRow key={`s${i}`} row={row} spans={markView.spans[i] ?? NO_MARK_SPANS} theme={theme} color={depth} />
            ))}
          </Box>
        </PaneBoundary>
      ) : full === null && !staticOnly && layout.pane > 0 ? (
        <PaneBoundary pane="pane" onFail={onPaneFail} fault={fault} log={logName} resetKey={state.runId ?? ''}>
          <Pane state={paneState} rows={layout.pane} columns={columns} overlay={overlayKind} terminalRows={rows} lines={pickerView?.lines ?? null} selected={pickerView?.selected ?? null} glyphs={glyphs} theme={theme} color={depth} {...(pickerOpen ? {} : { size: state.panel === 'open' ? 'open' : 'full' })} />
        </PaneBoundary>
      ) : null}
      {full === null && !staticOnly && layout.queue > 0 ? (
        <Box flexDirection="column" height={layout.queue} overflow="hidden">
          {queueLines.slice(0, layout.queue).map((line, i) => (
            <Text key={`q${i}`} wrap="truncate" {...textProps(theme, 'dim', depth)}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      {!staticOnly && (layout.overlay > 0 || layout.preview > 0) && !wizardHosted ? (
        <PaneBoundary pane="overlay" onFail={onPaneFail} fault={fault} log={logName} resetKey={overlayKind}>
          <Overlay kind={layout.degraded === 'minsize' ? 'none' : overlayKind} rows={layout.overlay} previewRows={layout.preview} columns={columns} terminalRows={rows} top={overlayTop} data={overlayData} degraded={layout.degraded} cursor={setCursorPosition} glyphs={glyphs} theme={theme} color={depth} screenReader={launch.screenReader} chrome={chrome} />
        </PaneBoundary>
      ) : null}
      {!staticOnly && layout.chrome > 0 && (layout.composer > 0 || wizardHosted) ? (
        // TUI-DESIGN-2 §4.3: the boxed tier — one console around the composer (or the wizard's rows) and the status bar
        <PaneBoundary
          pane="composer"
          onFail={onPaneFail}
          fault={fault}
          log={logName}
          fallback={() => (
            <Box flexDirection="column" height={layout.chrome + layout.composer + layout.status} overflow="hidden">
              <Text wrap="truncate">{`${promptFor(glyphs)}${maskHits(buffer.text, hitSpans(composer.hits()), maskGlyph).split('\n').at(-1) ?? ''}`}</Text>
              <Text wrap="truncate">{statusState ? statusLineText(statusState, columns, statusOpts) : `step ${state.step}/${state.status?.maxSteps ?? '–'}`}</Text>
            </Box>
          )}
        >
          <Console
            buffer={state.noteMode || collapsing ? EMPTY_BUFFER : buffer}
            columns={columns}
            height={wizardHosted ? layout.overlay : Math.max(1, layout.composer - layout.gate)}
            top={cTop}
            scrollTop={composer.scrollTop}
            cursor={setCursorPosition}
            active={wizardHosted ? true : composerActive && !state.noteMode}
            mode={composerMode}
            rows={rows}
            live={runLive}
            spans={hitSpans(state.noteMode ? [] : composer.hits())}
            ghost={ghost}
            searchRow={composer.searchRow()}
            badge={badge}
            dir={sessionDirName(p.cwd ?? process.cwd())}
            title={consoleTitle}
            gate={gateRow}
            status={statusState ?? statusView(state, { picker: pickerOpen })}
            statusOptions={statusOpts}
            wizard={wizardHosted ? { state: wizard.state, trust: (bridge.wizardHost?.trustInputs?.() ?? null) as TrustInputs | null, screenReader: launch.screenReader } : null}
            glyphs={glyphs}
            theme={theme}
            color={depth}
            onScroll={(n) => composer.setScrollTop(n)}
            {...consoleExtra}
          />
        </PaneBoundary>
      ) : null}
      {!staticOnly && layout.chrome === 0 && layout.composer > 0 ? (
        <PaneBoundary
          pane="composer"
          onFail={onPaneFail}
          fault={fault}
          log={logName}
          fallback={() => (
            // §13.4: the single-row plain input — the draft's last line with its hit spans masked (§4.3 holds here too)
            <Box height={layout.composer} overflow="hidden">
              <Text wrap="truncate">{`${promptFor(glyphs)}${maskHits(buffer.text, hitSpans(composer.hits()), maskGlyph).split('\n').at(-1) ?? ''}`}</Text>
            </Box>
          )}
        >
          <Composer buffer={state.noteMode || collapsing ? EMPTY_BUFFER : buffer} columns={columns} height={layout.composer} top={top} scrollTop={composer.scrollTop} cursor={setCursorPosition} active={composerActive && !state.noteMode} mode={composerMode} rows={rows} live={runLive} spans={hitSpans(state.noteMode ? [] : composer.hits())} ghost={ghost} searchRow={composer.searchRow()} glyphs={glyphs} theme={theme} color={depth} onScroll={(n) => composer.setScrollTop(n)} />
        </PaneBoundary>
      ) : null}
      {layout.status > 0 && layout.chrome === 0 ? (
        <PaneBoundary pane="status" onFail={onPaneFail} fault={fault} log={logName} fallback={() => <Text wrap="truncate">{statusState ? statusLineText(statusState, columns, statusOpts) : `step ${state.step}/${state.status?.maxSteps ?? '–'}`}</Text>}>
          {statusState ? <StatusLine state={statusState} columns={columns} options={statusOpts} theme={theme} color={depth} /> : <Text wrap="truncate">{`step ${state.step}/${state.status?.maxSteps ?? '–'}`}</Text>}
        </PaneBoundary>
      ) : null}
    </Box>
  );
}

/**
 * TUI-DESIGN-2 §5.4: the rule row — `◆ jevcode <version>` in `accent` on the brand row, the rest in `rule`. The span comes
 * from `brandSpan`, which accepts the four pulse glyphs (`░ ▒ ▓ ◆`), so the accent holds through the one-line splash
 * below 64 columns (finding 10). TUI-DESIGN-3 §5.2 A5: `band` lights the row's `─` cells inside `[from, to)` `borderFocus`
 * (the run-start sweep; colour only — the text never changes). Without a band the three-span form of round 2 is kept verbatim.
 */
export function RuleRow({ text, theme, color, glyphs, band = null }: { text: string; theme: Theme; color: ColorDepth; glyphs: GlyphSet; band?: GridBand | null }): React.JSX.Element {
  const span = brandSpan(text, glyphs);
  if (band === null) {
    if (span === null) {
      return (
        <Text wrap="truncate" {...textProps(theme, 'rule', color)}>
          {text}
        </Text>
      );
    }
    return (
      <Text wrap="truncate">
        <Text {...textProps(theme, 'rule', color)}>{text.slice(0, span.from)}</Text>
        <Text {...textProps(theme, 'accent', color)}>{text.slice(span.from, span.to)}</Text>
        <Text {...textProps(theme, 'rule', color)}>{text.slice(span.to)}</Text>
      </Text>
    );
  }
  const cells = [...text];
  const roleAt = (i: number): ColorRole => {
    if (span !== null && i >= span.from && i < span.to) return 'accent';
    return i >= band.from && i < band.to && cells[i] === glyphs.rule ? 'borderFocus' : 'rule';
  };
  const parts: React.JSX.Element[] = [];
  let at = 0;
  while (at < cells.length) {
    const role = roleAt(at);
    let end = at + 1;
    while (end < cells.length && roleAt(end) === role) end++;
    parts.push(
      <Text key={`r${at}`} {...textProps(theme, role, color)}>
        {cells.slice(at, end).join('')}
      </Text>,
    );
    at = end;
  }
  return <Text wrap="truncate">{parts}</Text>;
}

/** TUI-DESIGN-2 §5.1: one wordmark row — the text unchanged, its cells coloured by the frame's spans (`accent` JEV, `dim` CODE, `sweep` head / band). */
type MarkSpan = { readonly row: number; readonly from: number; readonly to: number; readonly role: import('./theme.js').ColorRole };
const NO_MARK_SPANS: readonly MarkSpan[] = [];

function SplashRowImpl({ row, spans, theme, color }: { row: string; spans: readonly { from: number; to: number; role: import('./theme.js').ColorRole }[]; theme: Theme; color: ColorDepth }): React.JSX.Element {
  const cells = [...row];
  const parts: React.JSX.Element[] = [];
  let at = 0;
  const sorted = [...spans].filter((s) => s.from < cells.length).sort((a, b) => a.from - b.from);
  // the sweep band paints over the letter roles: later spans win inside their range
  const roleAt = (i: number): import('./theme.js').ColorRole | null => {
    let role: import('./theme.js').ColorRole | null = null;
    for (const s of sorted) if (i >= s.from && i < s.to) role = s.role;
    return role;
  };
  // a run of blanks carries no visible colour: it joins the preceding coloured part instead of opening a part of its own
  const isBlank = (i: number): boolean => cells[i] === ' ';
  while (at < cells.length) {
    const role = roleAt(at);
    let end = at + 1;
    while (end < cells.length && (roleAt(end) === role || (isBlank(end) && role !== null))) end++;
    const text = cells.slice(at, end).join('');
    parts.push(
      <Text key={`p${at}`} {...(role === null ? {} : textProps(theme, role, color))}>
        {text}
      </Text>,
    );
    at = end;
  }
  return (
    <Box height={1} overflow="hidden">
      <Text wrap="truncate">{parts}</Text>
    </Box>
  );
}

/** TUI-DESIGN-3 §3 (integration): memoised by value so a key frame (which re-renders the App) leaves the five mark rows untouched. */
const SplashRow = memo(SplashRowImpl, (a, b) => a.row === b.row && a.theme === b.theme && a.color === b.color && a.spans.length === b.spans.length && a.spans.every((s, i) => s.from === b.spans[i]!.from && s.to === b.spans[i]!.to && s.role === b.spans[i]!.role));

// ---------------------------------------------------------------------------------------
// Renderer (§15 item 16)
// ---------------------------------------------------------------------------------------

/** Ink renderer: renders the first frame synchronously from argv-only props; `attach(engine)` / `setHost` later. */
/**
 * OSC 2 window title (TUI-DESIGN §14.1, C14: opt-in through `ui.title`, cleared on exit). Control characters and the
 * BEL/ST terminators are stripped and the text is clipped so a task cannot smuggle a sequence into the title.
 */
/** opt-in shutdown/keystroke trace (JEVCODE_TRACE): key classes and the review arming lifecycle, never key text */
function traceLine(text: string): void {
  const file = process.env['JEVCODE_TRACE'];
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch {
    // trace only
  }
}

export function terminalTitle(text: string | null): string {
  if (text === null) return '\u001b]2;\u0007';
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `\u001b]2;${clean}\u0007`;
}

export function createTuiRenderer(opts: TuiRendererOptions): TuiRenderer {
  const rawStdout = opts.stdout ?? process.stdout;
  // TUI-DESIGN-4 §1.4: every byte Ink writes goes through the scrollback guard, which rewrites `clearTerminal`'s
  // 11-character `ESC[2J ESC[3J ESC[H` to `ESC[2J ESC[H` (an `ESC[3J` erases the terminal's saved-lines buffer — the
  // user's whole history) and elides the duplicated `fullStaticOutput` prefix that follows it in the same chunk.
  // Ink keys its instance map by the stream object (`render.js:45–58`), so the SAME proxy goes everywhere: `render()`,
  // the `resize` listener's geometry reads, the title and the cursor-shape write. `installTerminalHygiene` and
  // `fatal.ts`'s `RESTORE` keep the raw stream (§1.4 edge 8) — neither ever writes `3J`.
  const stdout = guardStdout(rawStdout);
  const stdin = opts.stdin ?? process.stdin;
  const env = opts.env ?? process.env;
  const mode = opts.mode ?? 'one-shot';
  const launchBase = opts.launch ?? resolveLaunchSettings({}, env);
  // TUI-DESIGN-4 §1.3.1: the renderer is chosen HERE, once — Ink fixes `alternateScreen` in its constructor
  // (`ink.js:256`), so it cannot be toggled in place. A refused `fullscreen` falls back to `classic` and rides on
  // `launch.rendererRefusal` as one `[ui]` note; the non-TTY rows are silent (there is no frame to pin anything to).
  const selection = selectRenderer({
    wanted: launchBase.renderer,
    rows: rawStdout.rows ?? DEFAULT_ROWS,
    columns: rawStdout.columns ?? DEFAULT_COLUMNS,
    screenReader: launchBase.screenReader,
    term: env['TERM'],
    isTTY: rawStdout.isTTY === true,
    ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
  });
  const launch: LaunchSettings = selection.refusal === null ? launchBase : { ...launchBase, rendererRefusal: selection.refusal };
  const fullscreen = selection.renderer === 'fullscreen';
  const bus = createEventBus();
  // With a piped stdin nobody can press y/n, so the box renders and then declines (§10).
  const confirmer = stdin.isTTY ? createTuiConfirmer() : createTuiConfirmer({ autoDeclineMs: opts.confirmTimeoutMs ?? 0, identity: IDENTITY_NO_TTY });
  const bridge = createBridge(opts.host ?? null, opts.wizardHost ?? null);
  const trace = env['JEVCODE_TRACE'];
  const log = opts.log ?? (trace !== undefined && trace !== '' ? createLog({ file: trace, level: 'trace', exitHook: false }) : nullLog());
  let detach: (() => void) | null = null;
  let hygiene: TerminalHygiene | null = null;
  // TUI-DESIGN §14.1 / §16 `ui.title` (opt-in): one OSC 2 write at setUi, reset at unmount; never written unless enabled
  let titleSet = false;
  let offResize: (() => void) | null = null;
  if (rawStdout.isTTY === true && rawStdout === process.stdout) {
    // §14.2: the mount shares the one process-wide restore, so unmount / SIGTSTP / the 'exit' hook write RESTORE once
    hygiene = installTerminalHygiene({ io: { stdout: rawStdout, stdin }, onSuspend: () => bridge.command({ type: 'suspend' }), restore: processRestoreTerminal() });
    writeCursorShape(stdout);
  }
  // §14.1 / §18: a `resize` listener registered before Ink's. It stores the new geometry on the bridge and schedules
  // React's re-render (a state update from a Node listener lands on React's scheduler *after* the next `setImmediate`
  // — measured on the root Ink mounts, so a one-macrotask deferral of Ink's handler cannot win the race). When the rows
  // shrank, the tree is committed synchronously right here (`instance.rerender()` is `updateContainerSync` +
  // `flushSyncWork`), before Ink's own `resized` handler repaints: the stale, taller tree is never painted at the new
  // viewport, and the only clear left is the one Ink needs for a previous frame taller than the new terminal
  // (research 20 §1 — one per shrink segment, §18). Grows and width-only changes never clear and take the async path.
  let instance: Instance | null = null;
  const tree = (): React.JSX.Element => (
    <App task={opts.task} resumeId={opts.resumeId} source={bus} confirmer={confirmer} onAbort={opts.onAbort} mode={mode} {...(opts.cwd !== undefined ? { cwd: opts.cwd } : {})} launch={launch} bridge={bridge} log={log} fault={opts.fault ?? env['JEVCODE_FAULT']} env={env} renderer={selection.renderer} {...(opts.now ? { now: opts.now } : {})} {...(opts.home !== undefined ? { home: opts.home } : {})} {...(opts.runsDir !== undefined ? { runsDir: opts.runsDir } : {})} {...(opts.onExit ? { onExit: opts.onExit } : {})} {...(opts.bindings ? { bindings: opts.bindings } : {})} />
  );
  const geometryOf = (): { rows: number; columns: number } => {
    const s = stdout as { rows?: number; columns?: number };
    return { rows: s.rows || DEFAULT_ROWS, columns: s.columns || DEFAULT_COLUMNS };
  };
  // TUI-DESIGN-4 §2.2 P-R1: commit synchronously on **any** shrinking dimension and on **every** width change — a
  // width-only change never shrank the row count, so the old `g.rows < lastRows` test let the box edges follow the new
  // width while the body still wrapped at the old one (measured: 4 of 24 frames carry a truncation ellipsis as their
  // right border). `SYNC_COMMIT_MIN_MS` is the storm guard; the async debounce still catches the tail.
  let last = geometryOf();
  let lastSyncAt = 0;
  const onEarlyResize = (): void => {
    const g = geometryOf();
    bridge.geometry = g;
    bridge.notify();
    const now = nowMs();
    const commit = shouldSyncCommit(last, g, now, lastSyncAt);
    last = g;
    if (commit && instance !== null) {
      lastSyncAt = now;
      instance.rerender(tree());
    }
  };
  if (typeof stdout.on === 'function') stdout.on('resize', onEarlyResize);

  // §1.3: `fullscreen` FORCES the alternate screen and incremental rendering, never defaults them — A1 measured that
  // full-screen on the PRIMARY screen writes `ESC[2J ESC[3J` at unmount (the user's scrollback, gone) and that the
  // default renderer misses D-F's 16 ms key gate at 60×200 without incremental rendering.
  if (fullscreen) markAlternateScreen();
  const mounted = render(tree(), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: launch.fps,
    incrementalRendering: fullscreen || launch.renderMode === 'incremental',
    ...(fullscreen ? { alternateScreen: true } : {}),
    kittyKeyboard: { mode: 'disabled' },
    isScreenReaderEnabled: launch.screenReader,
    ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
  });
  instance = mounted;
  offResize = () => {
    if (typeof stdout.off === 'function') stdout.off('resize', onEarlyResize);
  };

  const renderer: TuiRenderer = {
    confirmer,
    attach(engine: Engine) {
      detach?.();
      bridge.engine = engine;
      detach = engine.events.onAny((e) => bus.emit(e));
      bridge.notify();
    },
    firstFrame: () => mounted.waitUntilRenderFlush(),
    async unmount() {
      detach?.();
      detach = null;
      offResize?.();
      offResize = null;
      hygiene?.uninstall();
      // finding 10: the controller unmounts right after `run:end`; let React commit that state and Ink flush the frame
      // (bounded), so the scrollback ends on `done <stop>` with the composer gone, not on a frozen spinner
      let flushTimer: NodeJS.Timeout | null = null;
      const flushBound = new Promise<void>((resolve) => {
        flushTimer = setTimeout(resolve, UNMOUNT_TIMEOUT_MS / 4);
        flushTimer.unref();
      });
      await Promise.race([mounted.waitUntilRenderFlush().catch(() => undefined), flushBound]);
      if (flushTimer) clearTimeout(flushTimer);
      mounted.unmount();
      let timer: NodeJS.Timeout | null = null;
      const bounded = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, UNMOUNT_TIMEOUT_MS);
        timer.unref();
      });
      await Promise.race([mounted.waitUntilExit().catch(() => undefined), bounded]);
      if (timer) clearTimeout(timer);
      instance = null;
      if (hygiene) hygiene.restore();
      if (titleSet) stdout.write(terminalTitle(null));
      /**
       * TUI-DESIGN-4 §1.3.4: **after** the restore (whose `ESC[?1049l` put us back on the primary screen) the
       * fullscreen session writes its whole transcript out, so it ends with the same scrollback classic would have
       * left. Produced by `transcriptDumpChunks` — the same `formatTranscriptItem` rows `createPlainRenderer`
       * writes — so the dump is byte-identical to a `--plain` run of the same script. Skipped for the classic
       * renderer (its scrollback already holds it), for `ui.fullscreenDump: false`, and for an empty transcript.
       * Written in bounded chunks so a slow link cannot push the exit past `UNMOUNT_TIMEOUT_MS`; a crash before
       * this point leaves no dump, and `transcript.log` stays the documented source of truth.
       */
      if (fullscreen && (bridge.ui?.fullscreenDump ?? true)) {
        const items = bridge.stateReader?.()?.items ?? [];
        for (const chunk of transcriptDumpChunks(items, glyphSet({ ascii: launch.ascii, screenReader: launch.screenReader }))) {
          try {
            rawStdout.write(chunk);
          } catch {
            // the other end is gone (EPIPE, a closed pager): the dump is best-effort, transcript.log is not
            break;
          }
        }
      }
    },
    setHost(host) {
      bridge.host = host;
      bridge.notify();
    },
    setBindings(b) {
      bridge.command({ type: 'bindings', bindings: b });
    },
    setUi(ui) {
      bridge.ui = ui;
      bridge.notify();
      if (ui.title && !titleSet && stdout.isTTY) {
        titleSet = true;
        stdout.write(terminalTitle(opts.task ? `jevcode · ${opts.task}` : 'jevcode session'));
      }
    },
    notify(text, o = {}) {
      bridge.command({ type: 'dispatch', action: { type: 'local', text, ...(o.label ? { label: o.label } : {}), ...(o.level ? { level: o.level } : {}), ...(o.detail ? { detail: o.detail } : {}) } });
    },
    dispatch(action) {
      bridge.command({ type: 'dispatch', action });
    },
    state: () => bridge.stateReader?.() ?? null,
    openWizard(detect) {
      bridge.command({ type: 'wizard', detect });
    },
    reopenWizard(at, runLive, opts) {
      bridge.command({ type: 'wizard:reopen', at, runLive, ...(opts ? { opts } : {}) });
    },
    promptIntake: (card) => new Promise((resolve) => bridge.command({ type: 'intake', card, resolve })),
    restoreDraft(text) {
      bridge.command({ type: 'restoreDraft', text });
    },
    live(text) {
      bridge.command({ type: 'dispatch', action: { type: 'live', text } });
    },
    openPicker(open) {
      bridge.command({ type: 'picker', open });
    },
    confirmFollowUp: (input) => new Promise((resolve) => bridge.command({ type: 'followup', input, resolve })),
    promptUndo: (row) => new Promise((resolve) => bridge.command({ type: 'undo', row, resolve })),
    confirmExit: () => new Promise((resolve) => bridge.command({ type: 'exitConfirm', resolve })),
    blocking: (request) => new Promise((resolve) => bridge.command({ type: 'blocking', request, resolve })),
    setSessionSpend(session) {
      bridge.command({ type: 'dispatch', action: { type: 'spend:session', session } });
    },
    setGitDirs(dirs) {
      bridge.gitDirs = dirs;
      bridge.notify();
    },
    setTitle(title) {
      bridge.command({ type: 'dispatch', action: { type: 'title', title } });
    },
    promptSecretGate: (hits) => new Promise((resolve) => bridge.command({ type: 'secretGate', hits, resolve })),
  };
  return renderer;
}

/** `basename(cwd)` for the session header (`jevcode session · <dir> | step 0/– starting`). */
export function sessionDirName(cwd: string): string {
  return basename(cwd) || cwd;
}

/** The unmount fallback `RESTORE` path shared with the fatal handler (§14.2). */
export { restoreTerminal };
export { REWIND_CHOICE };
