/**
 * Public surface of `src/tui` (TUI-DESIGN §20 O9 exports): the Ink renderer and its App, the reducer / bus /
 * confirmer, the plain renderer and the shared line builders, plus the terminal hygiene the CLI wires.
 */
export { App, createTuiRenderer, liveLines, queueRows, splitInputChunk, builderFaultFor, RULE_CHAR, UNMOUNT_TIMEOUT_MS, GATE_ARM_MS, EXITED_CTRL_C, EXITED_CTRL_D, COALESCED_ENTER_TOAST, RECENT_WARNINGS_KEPT } from './App.js';
export type { AppProps, TuiRenderer, TuiRendererOptions, PickerOpen, Bridge, SplitChunk } from './App.js';
export { createBridge } from './App.js';
export { computeLayout, composerTop, CAP, MIN_ROWS, MIN_COLUMNS, isCollapsingOverlay } from './layout.js';
export type { Layout, LayoutInput, OverlayKind } from './layout.js';
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
export { Composer, useComposer, composerView, draftRows, placeholderFor, openExternalEditor, PLACEHOLDERS, PROMPT, NOTE_LABEL } from './composer/Composer.js';
export type { ComposerController, ComposerMode, ComposerView, HistorySearch } from './composer/Composer.js';
export { Overlay, overlayWant, overlayPreviewWant, EXIT_CONFIRM_ROW, minsizeNotice } from './Overlay.js';
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
export { THEMES, themeFor, textProps, itemRole, validateTheme } from './theme.js';
export type { Theme, ThemeName, ColorRole } from './theme.js';
export { colorEnabled, applyNoColorShim } from './color-shim.js';
export { RESTORE, DECSCUSR_BAR, restoreTerminal, processRestoreTerminal, rearmRestoreTerminal, createRestoreTerminal, installTerminalHygiene, createResizeDebounce, createSuspensionQueue, suspendProcess, writeCursorShape } from './terminal.js';
export { createNotifier, createNotifyTimers, notifySequence, notifyPayload, detectNotifyMethod, REVIEW_NOTIFY_MS, RUN_END_NOTIFY_MS } from './notify.js';
