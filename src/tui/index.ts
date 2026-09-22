/**
 * Public surface of `src/tui` (TUI-DESIGN §20 O9 exports): the Ink renderer and its App, the reducer / bus /
 * confirmer, the plain renderer and the shared line builders, plus the terminal hygiene the CLI wires.
 */
export { App, createTuiRenderer, liveLines, queueRows, splitInputChunk, builderFaultFor, RULE_CHAR, UNMOUNT_TIMEOUT_MS, GATE_ARM_MS, EXITED_CTRL_C, EXITED_CTRL_D, COALESCED_ENTER_TOAST, RECENT_WARNINGS_KEPT } from './App.js';
export type { AppProps, TuiRenderer, TuiRendererOptions, PickerOpen, Bridge, SplitChunk } from './App.js';
export { createBridge } from './App.js';
export { computeLayout, composerTop, consoleTop, chromeRows, CAP, MIN_ROWS, MIN_COLUMNS, BOXED_MIN_ROWS, WORDMARK_MIN_COLUMNS, isCollapsingOverlay } from './layout.js';
export type { Layout, LayoutInput, OverlayKind } from './layout.js';
// TUI-DESIGN-2 round 2 (S4): console, cards, splash, motion, panel
export { consoleLines, consoleTopEdge, consoleTopEdgeParts, consoleRow, consoleDivider, consoleBottom, consoleInnerWidth } from './console-lines.js';
export type { ConsoleInput, ConsoleTopEdgeParts } from './console-lines.js';
export { Console, wizardConsoleTitle, pickerConsoleTitle, wizardBodyRows } from './Console.js';
export type { ConsoleProps } from './Console.js';
export { cardTop, cardRow, cardBottom, cardLines } from './card.js';
export { splashFrame, splashPhase, revealedCells, sweepStart, wordmarkOffset, brandRow, brandSpan, brandText, brandGlyph, SPLASH_MS, SPLASH_INTERVAL_MS, WORDMARK, WORDMARK_CELLS, WORDMARK_ROWS } from './splash.js';
export type { SplashFrame, SplashPhase, SplashSpan } from './splash.js';
export { useMotion } from './motion.js';
export type { Motion } from './motion.js';
export { panelStrip, panelLines, panelMoreRow, planProgress, PANEL_WIDE_COLUMNS } from './pane/model.js';
export { parsePanelCommand, nextPanel } from './pane/commands.js';
export type { PanelCommand } from './pane/commands.js';
export { ruleRowText } from './Pane.js';
export type { RuleRowInput } from './Pane.js';
export { reviewCardLines, reviewCardTitle } from './review/lines.js';
export { reviewCardRows } from './Review.js';
export { modeBadge, modeBadgeWord, THINKING_WORDS, ASKING_WORD, flatBadgePrefix } from './status/lines.js';
export type { ModeBadge, ThinkingPhase } from './status/lines.js';
export { colorDepth } from './color-shim.js';
export type { ColorDepth } from './color-shim.js';
export { visibleItems, useVisibleItems, hiddenInCompact, COMPACT_HIDDEN_KINDS, CHAT_ROWS_KEPT } from './useEngine.js';
export type { PanelState, TranscriptView, SplashState, UiTranscriptItem } from './useEngine.js';
export { fenceRow, spacerAbove, itemLabel, FENCE_RE } from './Transcript.js';
export { intakeCardLines, CARD_TITLE_EXIT, CARD_TITLE_UNDO, CARD_TITLE_COMMANDS, CARD_TITLE_FILES } from './Overlay.js';
export type { IntakeOverlay } from './Overlay.js';
export { STILL_THINKING_TOAST, RuleRow, runIsLive, chatThinking } from './App.js';
export type { IntakeAnswer } from './App.js';
export {
  createPlainRenderer,
  createReadlineConfirmer,
  formatTranscriptItem,
  itemsFromEvent,
  localItem,
  confirmHeaderLines,
  confirmPreviewLines,
  describeAction,
  plainFirstLine,
  headerItem,
  sessionHeaderItem,
  sanitizeStream,
} from './plain.js';
export type { TranscriptItem, TranscriptKind, TranscriptLevel, ReadlineConfirmerOptions } from './plain.js';
export { createTuiConfirmer, uiReducer, initialUiState, createEventBus, useEngine, DECISIONS_KEPT, LIVE_FLUSH_MS, REVIEW_DEFER_MS, STATIC_SOFT_CAP, DEFAULT_THRESHOLDS } from './useEngine.js';
export type { UiState, UiAction, TuiConfirmer, EventSource, EventBus, RunPhase, DraftMirror, RetryView, GitZone, Toast, LoopView, QueueEntry, Thresholds } from './useEngine.js';
export { StatusLine, statusSentinel, statusView, SYNTH_MARKER } from './StatusLine.js';
export { Transcript, itemColor, itemLines, itemFailedRow, STATIC_ITEM_PANE } from './Transcript.js';
export { Composer, useComposer, composerView, draftRows, placeholderFor, placeholderParts, placeholderRow, promptFor, openExternalEditor, PLACEHOLDERS, PROMPT, PROMPT_UNICODE, PROMPT_ASCII, NOTE_LABEL } from './composer/Composer.js';
export type { ComposerController, ComposerMode, ComposerView, HistorySearch } from './composer/Composer.js';
export { Overlay, overlayWant, overlayPreviewWant, EXIT_CONFIRM_ROW, EXIT_CONFIRM_ROW_COMPACT, exitConfirmRow, minsizeNotice } from './Overlay.js';
export type { OverlayData } from './Overlay.js';
export { Review, reviewRows, reviewPreview, noteFieldRow, previewWant, maskHits, maskGlyphFor } from './Review.js';
export type { ReviewNote, Span } from './Review.js';
export { Pane, paneRule, plainRule, paneStateOf, paneRowRole } from './Pane.js';
export { pickerReducer, pickerLines, pickerRule, readPickerPreview, moveRunsToTrash, visibleSessions, selectedSession, INITIAL_PICKER, PICKER_HINT, PICKER_PANE_WANT } from './Picker.js';
export type { PickerState, PickerAction } from './Picker.js';
export { Wizard, useWizard } from './onboarding/Wizard.js';
export type { WizardHost, WizardDetect, WizardController, WizardSaveInput } from './onboarding/Wizard.js';
export { MaskedField, useMaskedBytes } from './onboarding/MaskedField.js';
export { useSpinner, spinnerActive, spinnerGlyph, SPINNER_INTERVAL_MS, SPINNER_FRAMES } from './spinner.js';
export { retryRow, retryLastRow, retryLiveLines, retryCauseText, retryViewFrom, startTicker, secondsLeft } from './retry.js';
export { THEMES, themeFor, textProps, itemRole, validateTheme, colorAt, depthOf } from './theme.js';
export type { Theme, ThemeName, ColorRole, ColorTriple, ColorOn } from './theme.js';
export { colorEnabled, applyNoColorShim } from './color-shim.js';
export { RESTORE, DECSCUSR_BAR, restoreTerminal, processRestoreTerminal, rearmRestoreTerminal, createRestoreTerminal, installTerminalHygiene, createSuspensionQueue, suspendProcess, writeCursorShape } from './terminal.js';
export { createNotifier, createNotifyTimers, notifySequence, notifyPayload, detectNotifyMethod, REVIEW_NOTIFY_MS, RUN_END_NOTIFY_MS } from './notify.js';
// TUI-DESIGN-4 round 4 (S1): the header, the scrollback guard, P-R1's clock and the opt-in fullscreen renderer
export { nowMs, SYNC_COMMIT_MIN_MS, shouldSyncCommit } from './App.js';
export { wordmarkFrame, wordmarkWanted, WORDMARK_MIN_ROWS, WORDMARK_POST_RUN_MIN_ROWS, WORDMARK_LIVE_MIN_ROWS } from './wordmark.js';
export type { WordmarkInput, WordmarkSetting } from './wordmark.js';
export { brandSegment } from './pane/model.js';
export type { StripOptions } from './pane/model.js';
export { guardStdout, isGuarded, isLogClearWrite, CLEAR_TERMINAL, CLEAR_SAFE } from './scrollback-guard.js';
export { computeFullLayout, fullscreenRefusal, FULL_MIN_ROWS, FULL_MIN_COLUMNS, FULL_HERO_MIN_ROWS, FULL_MIN_VIEWPORT_ROWS } from './fullscreen/layout.js';
export type { FullLayout, FullLayoutInput, FullscreenRefusalInput } from './fullscreen/layout.js';
export { buildIndex, appendItems, rebuildFor, emptyIndex, rowsFor, cutsFor, resolveTop, sliceRows, applyScroll, applyScrollAt, atBottom, positionRungs, positionRung, earlierRowsAbove, earlierRowsDropped, SCROLL_BOTTOM, VIEWPORT_ITEM_CAP } from './fullscreen/viewport.js';
export type { Scroll, ScrollKey, ViewportIndex, ViewportRow } from './fullscreen/viewport.js';
export { Viewport, VIEWPORT_PANE } from './fullscreen/ViewportBox.js';
export type { ViewportProps } from './fullscreen/ViewportBox.js';
export { FullApp } from './fullscreen/FullApp.js';
export type { FullAppProps } from './fullscreen/FullApp.js';
export { selectRenderer } from './fullscreen/select.js';
export type { RendererSelection, RendererSelectionInput } from './fullscreen/select.js';
export { fullLayoutAsLayout } from './App.js';
export { ALT_SCREEN_LEAVE, markAlternateScreen, alternateScreenEntered } from './terminal.js';
// TUI-DESIGN-4 §1.3.4: `/scrollback` and the on-exit dump
export { SCROLLBACK_RESUME_ROW, printToPrimaryScreen, waitForAnyKey, type PrimaryScreenDumpDeps } from './terminal.js';
export { SCROLLBACK_CHUNK_CHARS, transcriptDumpChunks } from './plain.js';
