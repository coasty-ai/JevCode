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
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Text, render, useApp, useCursor, useInput, usePaste, useStdin, useStdout, useWindowSize } from 'ink';
import type { Key } from 'ink';
import type { BlockingAnswer, BlockingRequest, Engine, LaunchSettings, Renderer, RendererOptions, SecretHit, SessionHost, SessionRow, UiConfig, UiLabel } from '../core/types.js';
import { detectSecrets, patternRedact } from '../core/redact.js';
import { createLog, nullLog, type KeyClass, type Log } from '../core/log.js';
import { resolveLaunchSettings } from '../config/launch.js';
import type { TrustInputs } from '../config/trust.js';
import { REWIND_CHOICE, type RewindStep } from '../undo/plan.js';
import { bannerRow } from './pane/banner.js';
import { decisionRows } from './pane/decisions.js';
import { planRows } from './pane/plan.js';
import { defaultTab, cycleTab } from './pane/model.js';
import { helpLines, paletteGhost, paletteMatches, type PaletteState } from './commands/palette.js';
import type { CommandAction, DispatchContext } from './commands/dispatch.js';
import { rank } from './commands/fuzzy.js';
import { Composer, draftRows, hitSpans, openExternalEditor, useComposer, type ComposerMode } from './composer/Composer.js';
import { createBuffer, type Snapshot } from './composer/buffer.js';
import { routeSend, routeSubmit, type SubmitDecision } from './composer/submit.js';
import { stringWidth } from './composer/width.js';
import { colorEnabled } from './color-shim.js';
import { GLYPHS, glyphSet, type GlyphSet } from './glyphs.js';
import { DEFAULT_BINDINGS, type Bindings } from './keys/bindings.js';
import { interruptHint, type InterruptAction } from './keys/interrupts.js';
import { initialKeyState, resolveKey, type Armed, type KeyAction, type KeyEvent, type KeyState } from './keys/resolve.js';
import { CAP, computeLayout, composerTop, isCollapsingOverlay, type Layout, type LayoutInput, type OverlayKind } from './layout.js';
import { createNotifier, createNotifyTimers } from './notify.js';
import { Overlay, overlayPreviewWant, overlayWant, type OverlayData } from './Overlay.js';
import { Pane, paneRule, paneStateOf, plainRule } from './Pane.js';
import { PaneBoundary, RENDER_FAULTS_FIRED, renderFaultFor, type PaneFailure } from './PaneBoundary.js';
import { INITIAL_PICKER, PICKER_PANE_WANT, moveRunsToTrash, pickerLines, pickerReducer, pickerRule, readPickerPreview, selectedRewindStep, selectedSession, visibleRewindSteps, visibleSessions } from './Picker.js';
import { IDENTITY_NO_TTY, formatTranscriptItem, headerItem, sanitizeStream, sessionHeaderItem, type TranscriptItem, type TranscriptLevel } from './plain.js';
import { maskGlyphFor, maskHits, type ReviewNote } from './Review.js';
import type { FollowupInput } from './review/lines.js';
import { reviewRowForDigit } from './review/lines.js';
import { retryLiveLines } from './retry.js';
import { gateLines, GATE_DISMISS_TIP } from './secrets/gate-lines.js';
import { copyRedacted } from './secrets/clipboard.js';
import { spinnerActive, useSpinner } from './spinner.js';
import { kShort, statusLineText, type StatusLineOptions, type StatusLineState } from './status/lines.js';
import { StatusLine, statusView } from './StatusLine.js';
import { createResizeDebounce, installTerminalHygiene, processRestoreTerminal, rearmRestoreTerminal, restoreTerminal, suspendProcess, writeCursorShape, type TerminalHygiene } from './terminal.js';
import { themeFor, textProps, type Theme } from './theme.js';
import { TOAST_ERROR_MS, TOAST_INFO_MS } from './toasts.js';
import { Transcript } from './Transcript.js';
import { useGitHead } from './useGitHead.js';
import { createEventBus, createTuiConfirmer, useEngine, type EventBus, type EventSource, type QueueEntry, type TuiConfirmer, type UiAction, type UiState } from './useEngine.js';
import { useWizard, type WizardDetect, type WizardHost } from './onboarding/Wizard.js';
import { stepWhyBlocks, whyBlock } from './why.js';

export const DEFAULT_ROWS = 24;
export const DEFAULT_COLUMNS = 80;
export const LIVE_ROWS = CAP.live;
export const STATUS_ROWS = 1;
/** The rule separating scrollback (<Static>) from the live panes; also how tests find the dynamic region. */
export const RULE_ROWS = 1;
export const RULE_CHAR = '─';
export const UNMOUNT_TIMEOUT_MS = 2000;
/** §6.3: a `y` within this many ms of the Enter that opened a y-gated overlay is text. */
export const GATE_ARM_MS = 150;
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
 * stream: with an empty buffer the region shows the last `synth` line of the step (docs/JEV-ONLY.md).
 */
export function liveLines(live: string, rows: number, columns: number = DEFAULT_COLUMNS, toolChars = 0, synth: string | null = null): string[] {
  if (rows <= 0) return [];
  if (live === '') {
    if (toolChars > 0) return [`streaming action… ${kShort(toolChars)} chars`];
    return synth !== null ? [synth] : [];
  }
  if (!/[\r\n]/.test(live)) return [`streaming… ${kShort(live.length)} chars`];
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
  | { type: 'wizard:reopen'; at: 'provider' | 'generator.apiKey' | 'decider.apiKey'; runLive: boolean }
  | { type: 'picker'; open: PickerOpen }
  | { type: 'followup'; input: FollowupInput; resolve: (a: 'start' | 'raise' | 'cancel') => void }
  | { type: 'undo'; row: string; resolve: (a: 'yes' | 'no' | 'all' | 'skipRest' | 'abort') => void }
  | { type: 'exitConfirm'; resolve: (a: boolean) => void }
  | { type: 'blocking'; request: BlockingRequest; resolve: (a: BlockingAnswer) => void }
  | { type: 'suspend' }
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
   * §14.1 / §18 (finding 11): the geometry written by the renderer's own `resize` listener, registered before Ink's so
   * React's re-render is scheduled ahead of Ink's (deferred) repaint and reads the new numbers; `useWindowSize()` is
   * the source until the first resize and in tests that mount <App> directly.
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
  reopenWizard(at: 'provider' | 'generator.apiKey' | 'decider.apiKey', runLive: boolean): void;
  openPicker(open: PickerOpen): void;
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
}

interface PaletteUi {
  mode: 'command' | 'mention' | 'rewind';
  selected: number;
  /** Esc remembers the token so `/` stays closed while it is unchanged (§5.3) */
  candidates: readonly string[];
}

interface PendingGate {
  full: string;
  hits: readonly SecretHit[];
  openedAt: number;
  /** the history entry the send appends (a `/steer <text>` line is remembered as a command) */
  history?: { kind: 'prompt' | 'steer' | 'command'; text: string };
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
  const log = p.log ?? nullLog();
  const bridgeRef = useRef<Bridge | null>(null);
  bridgeRef.current ??= p.bridge ?? createBridge(null, null);
  const bridge = bridgeRef.current;
  useBridge(bridge);
  const launch = p.launch ?? resolveLaunchSettings({}, env);
  const ui = bridge.ui;
  const glyphs = glyphSet({ ascii: launch.ascii, screenReader: launch.screenReader });
  const theme: Theme = themeFor(ui?.theme);
  const { stdout, write } = useStdout();
  const color = colorEnabled({ noColor: launch.noColor || ui?.noColor === true, env, stream: stdout });
  const reducedMotion = ui?.reducedMotion ?? launch.screenReader;
  // §14.1: `useWindowSize()` is the geometry; after a SIGWINCH the renderer's early listener has already stored the same
  // numbers on the bridge, so the React task it scheduled (ahead of Ink's deferred repaint) renders the new budget
  const windowSize = useWindowSize();
  const rows = bridge.geometry?.rows ?? windowSize.rows;
  const columns = bridge.geometry?.columns ?? windowSize.columns;
  const { isRawModeSupported } = useStdin();
  const { suspendTerminal, waitUntilRenderFlush } = useApp();
  const { setCursorPosition } = useCursor();
  const bindings = p.bindings ?? DEFAULT_BINDINGS;

  const { state, dispatch } = useEngine(p.source, p.confirmer, p.task, p.resumeId, { mode, now, flushMs: reducedMotion ? 250 : 50, ...(p.tickMs !== undefined ? { tickMs: p.tickMs } : {}) });
  const stateRef = useRef(state);
  stateRef.current = state;
  bridge.stateReader = () => stateRef.current;

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
  const [wrapColumns, setWrapColumns] = useState(columns);
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

  // ----- resize debounce for the composer re-wrap (§14.1)
  useEffect(() => {
    const d = createResizeDebounce(() => setWrapColumns(columns));
    d.trigger();
    return () => d.cancel();
  }, [columns]);

  // ----- overlay arming (§6.3): every y-gated overlay arms after the first committed frame that shows it; the
  // secret / follow-up / undo / exit-confirm rows additionally never within 150 ms of the Enter that opened them
  // (both conditions chained, finding 15); the review arms on the committed frame alone (its deferral already
  // guarantees an idle second)
  const overlay = state.overlay;
  const overlayArmed = state.overlayArmed;
  useEffect(() => {
    if (overlay === 'none' || overlayArmed) return undefined;
    if (overlay === 'review') {
      notifyTimers.reviewShown();
      let alive = true;
      void waitUntilRenderFlush().then(() => {
        if (alive) dispatch({ type: 'overlay:armed' });
      });
      return () => {
        alive = false;
      };
    }
    if (overlay === 'secret' || overlay === 'followup' || overlay === 'undo' || overlay === 'exitConfirm') {
      const openedAt = now();
      let alive = true;
      let t: NodeJS.Timeout | null = null;
      void waitUntilRenderFlush().then(() => {
        if (!alive) return;
        t = setTimeout(() => {
          if (alive) dispatch({ type: 'overlay:armed' });
        }, Math.max(0, GATE_ARM_MS - (now() - openedAt)));
      });
      return () => {
        alive = false;
        if (t) clearTimeout(t);
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
  useEffect(() => {
    dispatch({ type: 'draft', draft: composer.mirror(wrapColumns) });
  }, [buffer, wrapColumns, composer, dispatch]);

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
  const currentStep = (): number => stateRef.current.step;
  const dispatchCtx = (): DispatchContext => ({
    run: stateRef.current.run,
    step: currentStep(),
    changedSteps: stateRef.current.changedSteps,
    ...(bridge.host ? { sessions: bridge.host.index().map((s) => ({ id: s.sessionId, title: s.title })) } : {}),
  });
  const paletteState = (): PaletteState => {
    const s = stateRef.current;
    return { lastStop: s.done?.stopReason ?? null, unauthorized: s.unauthorized, changedFiles: s.changedSteps.length > 0, rewindMenu: paletteRef.current?.mode === 'rewind', live: s.run !== 'none' };
  };
  const closeOverlay = (kind: OverlayKind = stateRef.current.overlay): void => {
    if (kind === 'palette') {
      rememberedToken.current = composer.buffer.text.trim();
      setPalette(null);
    }
    if (kind === 'secret') gateRef.current = null;
    if (stateRef.current.overlay === kind) dispatch({ type: 'overlay', overlay: 'none' });
  };
  const openPalette = (paletteMode: PaletteUi['mode']): void => {
    if (paletteMode === 'command' && rememberedToken.current !== null && rememberedToken.current === composer.buffer.text.trim()) return;
    rememberedToken.current = null;
    setPalette({ mode: paletteMode, selected: 0, candidates: [] });
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
        void h
          .submit(decision.full, { kind: decision.promptKind, secretSpans: decision.secretSpans, pinnedFiles: decision.pinnedFiles })
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
          noteLine(`error: /why: no decision ${ref} in the last ${3} steps`, { label: '[ui]', level: 'warn' });
          return;
        }
        const block = whyBlock(d, { siblings: all.filter((x) => x.step === d!.step), model: s.done?.resolvedJevModel ?? null }, glyphs);
        noteLine(block[0] ?? 'why', { label: '[ui]', detail: block.slice(1).join('\n') });
        composer.clear();
        return;
      }
      case 'decisions': {
        const lines = decisionRows(paneStateOf(s), action.n, columns, glyphs);
        noteLine(`decisions (last ${lines.length})`, { label: '[ui]', detail: lines.join('\n') });
        composer.clear();
        return;
      }
      case 'plan': {
        const lines = planRows(paneStateOf(s), 40, columns, glyphs);
        noteLine('plan', { label: '[ui]', detail: lines.join('\n') });
        composer.clear();
        return;
      }
      case 'theme': {
        if (bridge.ui) bridge.ui = { ...bridge.ui, theme: action.theme };
        else bridge.ui = { ...launch, theme: action.theme, title: false, reducedMotion: launch.screenReader, notify: launch.screenReader, osc52: false, history: true, noInput: false, trustWorkspace: false, budgetWarnings: true, allowSecretMention: false, exitCode: 'zero', logLevel: 'info', logFile: null, keybindingsFile: null };
        bridge.notify();
        composer.clear();
        return;
      }
      case 'editor':
        void startEditor();
        return;
      case 'exit':
        composer.clear();
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
      case 'copy': {
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

  const doSuspend = async (): Promise<void> => {
    if (process.stdout.isTTY !== true || stdout !== process.stdout) return;
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
      case 'CLOSE_OVERLAY': {
        const k = s.overlay;
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
      case 'paneTab':
        tabTouched.current = true;
        dispatch({ type: 'tab', tab: cycleTab(s.tab, action.dir) });
        return;
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
        const matches = paletteMatches(q, paletteState());
        const pick = matches[pal.selected]?.spec.name;
        if (pick !== undefined) composer.set(`/${pick} `);
        return;
      }
      case 'palette': {
        const pal = paletteRef.current;
        if (pal === null) return;
        switch (action.op) {
          case 'move':
          case 'page': {
            const count = pal.mode === 'mention' ? Math.min(8, pal.candidates.length) : paletteMatches(composer.buffer.text.trim(), paletteState()).length;
            const by = (action.by ?? 1) * (action.op === 'page' ? 7 : 1);
            setPalette({ ...pal, selected: count === 0 ? 0 : Math.min(Math.max(0, pal.selected + by), count - 1) });
            return;
          }
          case 'accept':
            execute({ type: 'complete', dir: 1 }, ks);
            return;
          case 'run':
            if (pal.mode === 'mention') {
              execute({ type: 'complete', dir: 1 }, ks);
              closeOverlay('palette');
              return;
            }
            onEnter();
            return;
          case 'close':
            closeOverlay('palette');
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
        const r = composer.apply(action, { columns: wrapColumns, rows });
        if (r.kind === 'toast') toastItem(r.text, r.level);
        else if (r.kind === 'submit') onEnter();
        else if (r.kind === 'ghost') {
          const pal = paletteRef.current;
          if (pal && pal.mode === 'command') {
            const ghost = paletteGhost(composer.buffer.text.trim(), paletteMatches(composer.buffer.text.trim(), paletteState()));
            if (ghost) composer.set(`${composer.buffer.text.trimEnd()}${ghost.rest}`);
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
  const keyState = (ev?: KeyEvent): KeyState => {
    const s = stateRef.current;
    const b = composer.buffer;
    const m = composer.mirror(wrapColumns);
    const n = noteRef.current;
    return {
      overlay: s.overlay,
      reviewArmed: s.overlay === 'review' && s.overlayArmed,
      // `starting` is a submit in flight with no engine yet (`run:start` flips it to live synchronously): the S0 rules
      // apply to Ctrl-C / Esc / Ctrl-D — an abort would land on nothing and wedge the session (finding 1)
      run: s.run === 'starting' ? 'none' : s.run,
      // while the `d` note field owns the composer row, F5's text rule reads the stashed human draft, not the note
      draftEmpty: s.noteMode && n !== null ? n.stash.text.length === 0 : b.text.length === 0,
      // §4.6: a one-row draft is both the first and the last visual row — Up recalls older, Down recalls newer — but
      // the mirror can name only one; Down on a single row is told `last` so the resolver's history rule applies
      cursorRow: m.rows <= 1 && ev?.key.downArrow === true ? 'last' : m.cursorRow,
      historySearch: composer.search !== null,
      queue: s.queue.length,
      mode,
      noteMode: s.noteMode,
      armed: armedRef.current,
      picker: pickerOpenRef.current !== null,
      overlayArmed: s.overlayArmed,
      minsize: layoutRef.current?.degraded === 'minsize',
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
    const ks = keyState(ev);
    // §13.2: a bare `r` on an empty draft while the retry row is up = `[r] retry now` (mirrors the `[`/`]` empty-draft
    // rule; the resolver has no row for it yet, so the App owns this one key)
    if (stateRef.current.retrying !== null && ks.overlay === 'none' && !ks.picker && !ks.historySearch && !ks.noteMode && !ks.minsize && ks.draftEmpty && ev.paste !== true && ev.escExpired !== true && ev.input === 'r' && !ev.key.ctrl && !ev.key.meta && !ev.key.shift) {
      retryNow();
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
          wizard.reopen(c.at, c.runLive);
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

  // ----- pane failures (§13.4)
  const onPaneFail = (f: PaneFailure): void => {
    log.error(`render fault pane=${f.pane} ${f.error.name}: ${redact(f.error.message)} ${redact(f.componentStack ?? '')}`.slice(0, 500));
    dispatch({ type: 'local', text: `ui: ${f.pane} pane failed to render (${f.error.name}) — run continues; details in ${log.file || 'jevcode.log'}`, label: '[ui]', level: 'error' });
    if (f.pane === 'overlay' && stateRef.current.pendingReview) {
      p.confirmer.resolveDetailed(stateRef.current.pendingReview.id, { approved: false });
      dispatch({ type: 'confirm:settled', id: stateRef.current.pendingReview.id });
    }
  };
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
  const overlayKind: OverlayKind = state.overlay;
  // §6.5: under a screen reader the review does not collapse the composer — the answer is a typed line
  const srReview = sr && overlayKind === 'review' && state.overlayArmed;
  const collapsing = (isCollapsingOverlay(overlayKind) || overlayKind === 'review') && !srReview;
  // §1 (one-shot: the composer is mounted for steering only) / §3.3 (one-shot has no idle states: the process exits at run:end):
  // once the run ended nothing can be steered or submitted, so the composer row is inert and shows no placeholder
  const oneShotDone = mode === 'one-shot' && state.run === 'none' && (state.done !== null || state.runsEnded > 0);
  const composerActive = !collapsing && !oneShotDone && (state.pendingReview === null || srReview) && overlayKind !== 'wizard' && overlayKind !== 'blocking';
  const composerWant = collapsing || state.noteMode ? 1 : guard('composer', () => draftRows(buffer.text, buffer.chips, wrapColumns, pickerOpen ? `> filter: ` : '> '), 1);
  const banner = guard('banner', () => bannerRow(state.loop, columns, glyphs), null);
  const liveRows = guard<string[]>('live', () => (state.retrying ? retryLiveLines(state.retrying, state.nowMs, CAP.live, columns, glyphs) : liveLines(state.live, CAP.live, columns, state.toolChars, state.synth)), []);
  const paneWant = pickerOpen ? PICKER_PANE_WANT : state.ready !== null || state.done !== null ? CAP.pane : 0;
  const layoutInput: LayoutInput = {
    rows,
    columns,
    overlay: overlayKind,
    // a failed overlay builder still gets one row: the boundary's fallback row needs it
    overlayWant: guard('overlay', () => overlayWant(overlayKind, overlayData, rows, columns), overlayKind === 'none' ? 0 : 1),
    previewWant: guard('overlay', () => overlayPreviewWant(overlayKind, overlayData), 0),
    expanded: state.expanded,
    composerWant,
    queueWant: state.queue.length,
    liveWant: liveRows.length,
    bannerWant: banner !== null ? 1 : 0,
    paneWant,
  };
  const layout = computeLayout(layoutInput);
  layoutRef.current = layout;
  const top = composerTop(layout);
  const overlayTop = layout.rule + layout.live + layout.banner + layout.pane + layout.queue;
  const header = useMemo(() => (mode === 'session' ? sessionHeaderItem(p.cwd ?? process.cwd()) : headerItem(p.task, p.resumeId)), [mode, p.cwd, p.task, p.resumeId]);
  const spinner = useSpinner(spinnerActive(state), reducedMotion);
  const statusOpts: StatusLineOptions = { ascii: glyphs.mode === 'ascii', reducedMotion, spinnerFrame: spinner, mode };
  const composerMode: ComposerMode = pickerOpen
    ? 'filter'
    : oneShotDone
      ? 'done'
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
            : state.run !== 'none'
              ? 'steer'
              : state.runsEnded > 0 || state.done !== null
                ? 'followup'
                : 'task';
  const paneState = guard('pane', () => paneStateOf(state), { tab: state.tab, step: state.step, rows: [], plan: null, timeline: [], synth: null, mode: state.mode });
  const pickerView = pickerOpen ? guard('pane', () => pickerLines(picker, { filter: picker.renaming ? '' : buffer.text, rows: layout.pane, columns, nowMs: state.nowMs, glyphs }), null) : null;
  const rule = guard('rule', () => paneRule(paneState, layout.pane, columns, overlayKind, rows, glyphs, pickerOpen ? pickerRule(picker, columns, glyphs) : null), plainRule(columns, glyphs));
  const statusState = guard<StatusLineState | null>('status', () => statusView({ ...state, git: state.git === null ? null : { ...state.git, head: gitHead.head ?? state.git.head, frozen: gitHead.frozen } }, { picker: pickerOpen }), null);
  const queueLines = guard<string[]>('queue', () => queueRows(state.queue, state.step + 1, layout.queue, columns, glyphs), []);
  const ghost = palette && palette.mode === 'command' ? guard('composer', () => paletteGhost(buffer.text.trim(), paletteMatches(buffer.text.trim(), paletteState())), null) : null;
  // the App owns the single cursor: hidden unless a child places it during its render
  setCursorPosition(undefined);
  const staticOnly = layout.degraded === 'static-only';
  const maskGlyph = maskGlyphFor(glyphs);
  const logName = log.file || 'jevcode.log';

  return (
    <Box flexDirection="column">
      {/* §13.4: each <Static> item has its own boundary inside <Transcript>; this outer one is the last resort and retries with the next item */}
      <PaneBoundary pane="transcript" onFail={onPaneFail} resetKey={state.items.length}>
        <Transcript items={state.items} header={header} theme={theme} color={color} glyphs={glyphs} epoch={state.staticEpoch} onFail={onPaneFail} fault={fault} log={logName} />
      </PaneBoundary>
      {!staticOnly && layout.rule > 0 ? (
        <Box height={layout.rule} overflow="hidden">
          <Text wrap="truncate" {...textProps(theme, 'rule', color)}>
            {rule}
          </Text>
        </Box>
      ) : null}
      {!staticOnly && layout.live > 0 ? (
        <PaneBoundary pane="live" onFail={onPaneFail} fault={fault} log={logName}>
          <Box flexDirection="column" height={layout.live} overflow="hidden">
            {liveRows.slice(0, layout.live).map((line, i) => (
              <Text key={`l${i}`} wrap="truncate" {...(state.retrying ? textProps(theme, 'warn', color) : {})}>
                {line}
              </Text>
            ))}
          </Box>
        </PaneBoundary>
      ) : null}
      {!staticOnly && layout.banner > 0 && banner !== null ? (
        <Box height={1} overflow="hidden">
          <Text wrap="truncate" {...textProps(theme, 'warn', color)}>
            {banner}
          </Text>
        </Box>
      ) : null}
      {!staticOnly && layout.pane > 0 ? (
        <PaneBoundary pane="pane" onFail={onPaneFail} fault={fault} log={logName} resetKey={state.runId ?? ''}>
          <Pane state={paneState} rows={layout.pane} columns={columns} overlay={overlayKind} terminalRows={rows} lines={pickerView?.lines ?? null} selected={pickerView?.selected ?? null} glyphs={glyphs} theme={theme} color={color} />
        </PaneBoundary>
      ) : null}
      {!staticOnly && layout.queue > 0 ? (
        <Box flexDirection="column" height={layout.queue} overflow="hidden">
          {queueLines.slice(0, layout.queue).map((line, i) => (
            <Text key={`q${i}`} wrap="truncate" {...textProps(theme, 'dim', color)}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      {!staticOnly && (layout.overlay > 0 || layout.preview > 0) ? (
        <PaneBoundary pane="overlay" onFail={onPaneFail} fault={fault} log={logName} resetKey={overlayKind}>
          <Overlay kind={layout.degraded === 'minsize' ? 'none' : overlayKind} rows={layout.overlay} previewRows={layout.preview} columns={columns} terminalRows={rows} top={overlayTop} data={overlayData} degraded={layout.degraded} cursor={setCursorPosition} glyphs={glyphs} theme={theme} color={color} screenReader={launch.screenReader} />
        </PaneBoundary>
      ) : null}
      {!staticOnly && layout.composer > 0 ? (
        <PaneBoundary
          pane="composer"
          onFail={onPaneFail}
          fault={fault}
          log={logName}
          fallback={() => (
            // §13.4: the single-row plain input — the draft's last line with its hit spans masked (§4.3 holds here too)
            <Box height={layout.composer} overflow="hidden">
              <Text wrap="truncate">{`> ${maskHits(buffer.text, hitSpans(composer.hits()), maskGlyph).split('\n').at(-1) ?? ''}`}</Text>
            </Box>
          )}
        >
          <Composer buffer={state.noteMode || collapsing ? EMPTY_BUFFER : buffer} columns={wrapColumns} height={layout.composer} top={top} scrollTop={composer.scrollTop} cursor={setCursorPosition} active={composerActive && !state.noteMode} mode={composerMode} rows={rows} live={state.run !== 'none'} spans={hitSpans(state.noteMode ? [] : composer.hits())} ghost={ghost} searchRow={composer.searchRow()} glyphs={glyphs} theme={theme} color={color} onScroll={(n) => composer.setScrollTop(n)} />
        </PaneBoundary>
      ) : null}
      {layout.status > 0 ? (
        <PaneBoundary pane="status" onFail={onPaneFail} fault={fault} log={logName} fallback={() => <Text wrap="truncate">{statusState ? statusLineText(statusState, columns, statusOpts) : `step ${state.step}/${state.status?.maxSteps ?? '–'}`}</Text>}>
          {statusState ? <StatusLine state={statusState} columns={columns} options={statusOpts} theme={theme} color={color} /> : <Text wrap="truncate">{`step ${state.step}/${state.status?.maxSteps ?? '–'}`}</Text>}
        </PaneBoundary>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------------------
// Renderer (§15 item 16)
// ---------------------------------------------------------------------------------------

/** Ink renderer: renders the first frame synchronously from argv-only props; `attach(engine)` / `setHost` later. */
export function createTuiRenderer(opts: TuiRendererOptions): TuiRenderer {
  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;
  const env = opts.env ?? process.env;
  const mode = opts.mode ?? 'one-shot';
  const launch = opts.launch ?? resolveLaunchSettings({}, env);
  const bus = createEventBus();
  // With a piped stdin nobody can press y/n, so the box renders and then declines (§10).
  const confirmer = stdin.isTTY ? createTuiConfirmer() : createTuiConfirmer({ autoDeclineMs: opts.confirmTimeoutMs ?? 0, identity: IDENTITY_NO_TTY });
  const bridge = createBridge(opts.host ?? null, opts.wizardHost ?? null);
  const trace = env['JEVCODE_TRACE'];
  const log = opts.log ?? (trace !== undefined && trace !== '' ? createLog({ file: trace, level: 'trace', exitHook: false }) : nullLog());
  let detach: (() => void) | null = null;
  let hygiene: TerminalHygiene | null = null;
  let offResize: (() => void) | null = null;
  if (stdout.isTTY === true && stdout === process.stdout) {
    // §14.2: the mount shares the one process-wide restore, so unmount / SIGTSTP / the 'exit' hook write RESTORE once
    hygiene = installTerminalHygiene({ io: { stdout, stdin }, onSuspend: () => bridge.command({ type: 'suspend' }), restore: processRestoreTerminal() });
    writeCursorShape(stdout);
  }
  // §14.1 / §18 (finding 11), half one: a `resize` listener registered before Ink's. It stores the new geometry on the
  // bridge and schedules React's re-render first (a state update from a listener is batched onto React's scheduler,
  // not flushed synchronously — measured on the legacy root Ink mounts), so the App's next render already uses the
  // new budget. Half two is `deferInkResize` below.
  const onEarlyResize = (): void => {
    const s = stdout as { rows?: number; columns?: number };
    bridge.geometry = { rows: s.rows || DEFAULT_ROWS, columns: s.columns || DEFAULT_COLUMNS };
    bridge.notify();
  };
  if (typeof stdout.on === 'function') stdout.on('resize', onEarlyResize);

  const instance = render(
    <App task={opts.task} resumeId={opts.resumeId} source={bus} confirmer={confirmer} onAbort={opts.onAbort} mode={mode} {...(opts.cwd !== undefined ? { cwd: opts.cwd } : {})} launch={launch} bridge={bridge} log={log} fault={opts.fault ?? env['JEVCODE_FAULT']} env={env} {...(opts.now ? { now: opts.now } : {})} {...(opts.home !== undefined ? { home: opts.home } : {})} {...(opts.runsDir !== undefined ? { runsDir: opts.runsDir } : {})} {...(opts.onExit ? { onExit: opts.onExit } : {})} {...(opts.bindings ? { bindings: opts.bindings } : {})} />,
    {
      stdout,
      stdin,
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: launch.fps,
      incrementalRendering: launch.renderMode === 'incremental',
      kittyKeyboard: { mode: 'disabled' },
      isScreenReaderEnabled: launch.screenReader,
      ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
    },
  );

  // §14.1 / §18 (finding 11), half two: Ink's `resized()` repaints the *current* tree synchronously on SIGWINCH, before
  // React has committed, so a shrink with a live pane repainted the stale, taller frame (one clear) and every frame
  // until the commit paid another (`lastOutputHeight` stayed above the viewport). Deferring Ink's handler by one
  // macrotask — queued after the React task the early listener scheduled — makes the committed tree the first thing
  // repainted; the only clear left is the one Ink needs for a previous frame taller than the new terminal (research 20 §1).
  const offInk = deferInkResize(stdout, [onEarlyResize]);
  offResize = () => {
    offInk();
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
    firstFrame: () => instance.waitUntilRenderFlush(),
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
      await Promise.race([instance.waitUntilRenderFlush().catch(() => undefined), flushBound]);
      if (flushTimer) clearTimeout(flushTimer);
      instance.unmount();
      let timer: NodeJS.Timeout | null = null;
      const bounded = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, UNMOUNT_TIMEOUT_MS);
        timer.unref();
      });
      await Promise.race([instance.waitUntilExit().catch(() => undefined), bounded]);
      if (timer) clearTimeout(timer);
      if (hygiene) hygiene.restore();
    },
    setHost(host) {
      bridge.host = host;
      bridge.notify();
    },
    setUi(ui) {
      bridge.ui = ui;
      bridge.notify();
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
    reopenWizard(at, runLive) {
      bridge.command({ type: 'wizard:reopen', at, runLive });
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
  };
  return renderer;
}

/**
 * §14.1 / §18 (finding 11): re-register every `resize` listener Ink installed at mount behind a one-macrotask deferral
 * (`setImmediate`, queued after the React scheduler task the same SIGWINCH produced through the early listener), so
 * Ink repaints the committed tree. Only the listeners present right after `render()` other than `except` (Ink's
 * `resized`; `useWindowSize` subscribes in an effect later and is left alone) are wrapped. Returns the uninstaller; a
 * no-op on streams without listeners (a pipe).
 */
export function deferInkResize(stdout: NodeJS.WriteStream, except: readonly ((...args: unknown[]) => void)[] = []): () => void {
  if (typeof stdout.listeners !== 'function') return () => undefined;
  const inks = (stdout.listeners('resize') as Array<(...args: unknown[]) => void>).filter((l) => !except.includes(l));
  if (inks.length === 0) return () => undefined;
  for (const fn of inks) stdout.off('resize', fn);
  const deferred = (): void => {
    setImmediate(() => {
      for (const fn of inks) fn();
    });
  };
  stdout.on('resize', deferred);
  return () => {
    stdout.off('resize', deferred);
    // hand Ink its listeners back so its own `unsubscribeResize` finds nothing surprising
    for (const fn of inks) stdout.on('resize', fn);
  };
}

/** `basename(cwd)` for the session header (`jevcode session · <dir> | step 0/– starting`). */
export function sessionDirName(cwd: string): string {
  return basename(cwd) || cwd;
}

/** The unmount fallback `RESTORE` path shared with the fatal handler (§14.2). */
export { restoreTerminal };
export { REWIND_CHOICE };
