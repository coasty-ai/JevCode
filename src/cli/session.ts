/**
 * The session controller (TUI-DESIGN §1 "Session loop", §8, §9, §10.2, §11, §12.4–§12.6, §13, §15 item 16, §15.1).
 *
 * `createSessionController` drives one process's worth of runs over a `Renderer` it never renders into directly:
 * after `renderer.firstFrame()` it reads `keybindings.json` and `history.jsonl` synchronously in the same tick,
 * resolves the configuration, hands the renderer a `SessionHost` (`setHost`) and the session settings (`setUi`),
 * prints the config warnings, probes the missing secrets (wizard), the trust gate, the sandbox line, the pre-run
 * `@` candidate list, folds `sessions/index.jsonl` once and creates the session `SpendMeter`. Every submission then
 * passes the follow-up gate (§9.3), is seeded from the session's parent run (§8.3) and becomes one engine
 * (`createEngine({ seed, session, instructions, blocker, exit, configDirs, secretsAcked })`); after `run:end` the
 * controller writes the index line, the epilogue item, re-probes git and reopens the composer (session mode) or
 * exits with `exitCodeFor` (one-shot mode: the same controller with `maxRuns = 1`).
 *
 * Renderer-originated lines travel `SessionHost.note()` → `Engine.annotate()` while a run is live (§15.1) and
 * `Renderer.notify()` while idle, so `transcript.log`, `--plain` and the TUI stay line-identical for the whole
 * run. The renderer talks to the engine only through the host (`steer`/`unsteer`/`pause`/`abort`/`retryNow`).
 *
 * Modal prompts (wizard, trust, follow-up box, exit confirm, blocking pane, undo ask, picker) are answered through
 * an optional `Prompter`: the Ink renderer may expose one (`prompts`), the `--plain` TTY gets the readline twin
 * (`createPlainPrompter`), and without one every prompt takes its safe default (C46, §1): the wizard prints the
 * fix block, the trust gate skips the instruction files, the follow-up clamps silently, the secret gate cancels,
 * a blocking pause answers `stop` (jev-unreachable keeps the engine's auto-retry).
 *
 * Exit discipline (§13.5, F3): `finishSession` is the one exit — it cancels every pending prompt (`Prompter.cancelAll`),
 * flushes one render so the renderer's last item commits, unmounts, restores the terminal, writes the lines that waited
 * for the unmount, and resolves `run()`; `run()` races `startup()` against it so a signal during startup never hangs.
 * Every leave request (`/exit`, Ctrl-C ×2, Ctrl-D ×2, `[y]`) goes through `host.exit()`, where `--exit-code=last-run`
 * is applied (`leaveExitCode`). While a run is live the controller's own lines go to `<runDir>/jevcode.log` (§13.6).
 */
import type { ProviderConfig } from '../provider/types.js';
import { accessSync, appendFileSync, constants as fsConstants, existsSync, realpathSync, writeSync } from 'node:fs';
import { open as openFile, readFile } from 'node:fs/promises';
import { homedir, hostname, uptime, userInfo } from 'node:os';
import { basename, join, resolve as resolvePath, sep } from 'node:path';
import type { SynthesizerOptions } from '../synth/index.js';
import type {
  Answer,
  BlockingAnswer,
  BlockingRequest,
  Candidate,
  CheckpointState,
  ConfirmOutcome,
  ConfirmRequest,
  Confirmer,
  Decider,
  Decision,
  Engine,
  EngineEvent,
  EngineMode,
  EngineOptions,
  EngineSeed,
  EngineStatus,
  FileView,
  GeneratorConfig,
  GitState,
  HistoryStore,
  IntakeKind,
  JevProvider,
  Json,
  JsonObject,
  LastTestRun,
  MockDeciderOptions,
  LaunchSettings,
  PendingDirective,
  Plan,
  PlanSnapshot,
  Provider,
  Renderer,
  RunLimits,
  RunMeta,
  RunResult,
  SecretHit,
  SecretSettingName,
  PeerView,
  SessionActivityView,
  SessionHost,
  SessionRow,
  SignalName,
  SpendMeter,
  StepRecord,
  SteerResult,
  StopReason,
  SubmitOutcome,
  Synthesizer,
  TokenUsage,
  UiConfig,
  UiLabel,
  UndoLogEntry,
  WindowEntry,
} from '../core/types.js';
import { PENDING_DIRECTIVES_MAX } from '../core/types.js';
import type { ParsedFlags } from './args.js';
import { classifyResumeValue } from './args.js';
import { AbortError, ConfigError, EXIT_CODES, JevHttpError, ProviderHttpError, UsageError, isAbortError, isJevCodeError } from '../errors.js';
import { formatDuration, nowIso as defaultNowIso } from '../core/time.js';
import { createLog, fallbackLogPath, logSettingsFromEnv, nullLog, type Log } from '../core/log.js';
import { detectSecrets as detectSecretsByPattern, patternRedact, secretSpans as spansOf } from '../core/redact.js';
import { parseJson } from '../core/json.js';
import { exitCodeFor } from '../loop/stop.js';
import { createSpendMeter } from '../spend/meter.js';
import { resolveConfig as realResolveConfig, isEngineMode, modeFromParsedFlags, reconcileResumeConfig, resumeIdentityFromRunMeta, resumeInputsFrom } from '../config/resolve.js';
import type { ResolvedConfigWithDiagnostics } from '../config/types.js';
import { credentialsPath, readCredentialsFile, shadowingLine, writeConfigValue as realWriteConfigValue, writeCredentials as realWriteCredentials, type CredentialsPatch } from '../config/credentials.js';
import { DEFAULT_MODE, JEV_ONLY_DEFAULT_SPEND_CAP_USD, MODE_BADGE_WORD, SETTINGS } from '../config/defaults.js';
import { PRODUCT_CONTEXT_ASK } from '../loop/stages/context.js';
import { parseModeHint } from '../config/launch.js';
import { loadInstructions as realLoadInstructions, projectInstructionFile } from '../config/instructions.js';
import { createTrustStore as realCreateTrustStore, decisionFromOption, probeTrustInputs as realProbeTrustInputs, trustKey, trustWorkspaceFlag, type TrustDecision, type TrustInputs, type TrustOption } from '../config/trust.js';
import { PROVIDER_ENV } from '../tui/onboarding/lines.js';
import {
  INSTRUCTIONS_NOT_TRUSTED_LINE,
  LOGIN_ONE_KEY_PROMPT,
  LOGIN_OTHER_WAYS_PROMPT,
  missingGeneratorOnly,
  MOCK_VERIFY_NOTE,
  PANEL_HANDLED_BY_TUI,
  TRANSCRIPT_ALWAYS_FULL,
  capsItem,
  defaultModeItem,
  dotenvSourceText,
  fixBlockLines,
  keyReusedText,
  modeSavedItem,
  sandboxDetail,
  sandboxText,
  trustLines,
  typesafeWinsText,
} from '../tui/onboarding/lines.js';
import { WIZARD_EXIT_CODE, type FoundKey, type FoundSource, type WizardProvider } from '../tui/onboarding/reducer.js';
import type { WizardVerifyInput, WizardVerifyResult } from '../tui/onboarding/Wizard.js';
import { keyEnteredText } from '../config/credentials.js';
import { fingerprint } from '../core/hash.js';
import { detectSandboxLevel } from '../sandbox/seatbelt.js';
// TUI-DESIGN-5 §6.3 / round-5 item 4: the zero-import id module — never `provider/registry.js` or `models/**`.
import { isProviderId, PROVIDER_DISPLAY_NAME, type ProviderId } from '../provider/ids.js';
import { isMentionDenied } from '../sandbox/paths.js';
import { loadForResume as realLoadForResume } from '../checkpoint/resume.js';
import { CHECKPOINT_FILES, createCheckpointStore, isRunMeta } from '../checkpoint/store.js';
import { readPostImages, readPreImage } from '../checkpoint/images.js';
import { INDEX_FILE, appendIndexLine as realAppendIndexLine, readIndex as realReadIndex, sessionFieldsOf, text60, type ChatSpendRow, type IndexLine } from '../session/index.js';
import { buildSeed, carriedSteers, seedSource, type SeedParent } from '../session/seed.js';
import { defaultExportPath, exportSession as realExportSession, type ExportRun } from '../session/export.js';
import { COORDINATION_IDLE_CLAUSE, COORDINATION_NOT_OPEN, COORDINATION_OFF_CLAUSE, coordinationAvailability, coordinationEnabledFrom, coordinationOffText, settingReader, type CoordinationOffReason } from '../session/coordination.js';
import { activityView, peerViewOf, selfView, WHO_EMPTY, whoHeader, whoRows } from '../session/peers.js';
import { ambiguousResumeMessage, noSessionMessage, pickerHeader, pickerRows, recentSessionHint, resolveResumeTarget, timeAgo } from '../session/picker-lines.js';
// TUI-DESIGN-5 §2.14 (R5-1): the WRITE half. `openSessionLedger` is the only place `src/coordination/**` is loaded,
// and it is behind an `await import()` INSIDE that function, so §2.1 rule 3a holds and gate G-R5-1 stays green.
import { createPublisher, forceTakebackOf, gitInputOf, openSessionLedger as realOpenSessionLedger, probeRepoFacts, type Publisher, type SessionLedger, type SessionLedgerInput } from '../session/publish.js';
import { VERSION } from '../version.js';
import { listCandidates as realListCandidates } from '../workspace/files.js';
import { probeGitState as realProbeGitState, readHead, toRunGitMetaEnd } from '../workspace/gitstate.js';
import { createSandbox as realCreateSandbox } from '../sandbox/run.js';
import { keybindingsPath, loadKeybindings as realLoadKeybindings, type KeybindingsLoad } from '../tui/keys/keybindings-file.js';
import type { KeyRunPhase } from '../tui/keys/resolve.js';
import type { UiAction } from '../tui/useEngine.js';
import { createHistoryStore as realCreateHistoryStore, type FileHistoryStore } from '../tui/composer/history.js';
import { dispatchCommand, type CommandAction, type DispatchContext } from '../tui/commands/dispatch.js';
import { helpLines as paletteHelpLines } from '../tui/commands/palette.js';
import { actionLabel, formatTranscriptItem, itemsFromEvent, stepCostText, type LineSource } from '../tui/plain.js';
import { plainSupports } from '../tui/plain-composer.js';
import { blockingRowsFull, peerOpenNotice } from '../tui/blocking/lines.js';
// TUI-DESIGN-5 §3.2 / §3.3 (R5-3): the ONE `/context` block builder and `/compact`'s four answers — the same
// module the status line's `ctx` cell reads, so the cell and the block can never disagree (§13.1).
import { compactAnswer, contextBlock, contextNoRelaxed } from '../tui/context/lines.js';
// TUI-DESIGN-5 §4.9 (D-AN, §12 S85): the one refusal sentence every unwired agent verb answers with.
import { notAvailableText } from '../tui/agents/lines.js';
import { gatePlainPrompt, gateRefusalLine } from '../tui/secrets/gate-lines.js';
import { copyRedacted } from '../tui/secrets/clipboard.js';
import {
  childCapUsd,
  costRows,
  followUpBoxLines,
  followUpDecision,
  pendingBudgetLine,
  raiseSessionCapCommand,
  sessionCapChangedLine,
  sessionCapReachedItem,
  sessionRemainingUsd,
  spendCapEpilogueLines,
  spendCapRaiseError,
  usd2,
  usd3,
  type FollowUpBoxInput,
} from '../tui/budget/lines.js';
import { epilogueItemLines, epilogueLines, type EpilogueContext } from './epilogue.js';
import { configBlock, configProblemLines } from './config-table.js';
import { BLOCK_CAPS, BLOCK_LOG_MAX, blockWidth, renderBlock, textRows, type BlockRow, type RenderedRow } from '../tui/block/lines.js';
import type { JsonStream, JsonStreamContext } from './json-stream.js';
import { GLYPHS, cellWidth, glyphSet, type GlyphSet } from '../tui/glyphs.js';
import { shortPath } from '../core/text.js';
import { findDecision, parseWhyRef, whyBlock, whyErrorText } from '../tui/why.js';
import { calibrationBlock, calibrationStats, scanCalibration } from '../tui/calibration.js';
import { panelLines, toDecisionRow, type DecisionRow, type PaneState } from '../tui/pane/model.js';
import { TOAST_INFO_MS } from '../tui/toasts.js';
import { modeBadgeWord } from '../tui/status/lines.js';
import { JEV_PROVIDERS } from '../jev/providers.js';
import { createCachingDecider } from '../jev/cache.js';
import { budgetItems, BUDGET_THRESHOLDS, type BudgetPct } from '../tui/budget/lines.js';
// TUI-DESIGN-2 §3 (D-C): the conversational intake — pure builders in src/chat/**, the state machine of §3.1 lives here (§3.8)
import { buildIntakeState, filesBucket, routeOf, runIntake, testsFromCandidates, type ChatRoute, type IntakeResult } from '../chat/intake.js';
import { REPLY_FALLBACK_KEY, fillReply, pickReply, replyByKey, type ReplyFacts } from '../chat/replies.js';
import { branchOf, harnessFacts, peersNotOpenText, PEERS_UNAVAILABLE_TEXT, selectFacts, type FactsInput } from '../chat/facts.js';
import { LOOKUP_READ_BYTES, lookupCode, lookupLines, type LookupInput } from '../chat/lookup.js';
import { CHAT_FILES_MAX, CHAT_FILE_BYTES, CHAT_FIXED_INPUT_TOKENS, chatMaxTokens, llmChatTurn, type ChatIdentity, type LlmTurnInput } from '../chat/llm-turn.js';
import { CHAT_LABELS, bubbleLines, type ChatRole } from '../chat/bubbles.js';
import { createChatLedger, type ChatTurn } from '../chat/ledger.js';
import { decisionRows } from '../tui/pane/decisions.js';
import { planRows } from '../tui/pane/plan.js';
import { applyUndo, prepareUndo, type ApplyUndoResult, type UndoAsk } from '../undo/apply.js';
import { REWIND_CHOICE, REWIND_PLAN_FALLBACK_NOTICE, planRewind, rewindCandidates, rewindPickerRows, type RewindStep } from '../undo/plan.js';
import { DIFF_INLINE_MAX_LINES, collectFullDiff, diffStatBlockFromGit, diffStepLines, type StepDiffFile } from '../undo/diff.js';
import { openFullDiff } from '../undo/pager.js';
import { commandLogout as realCommandLogout, verifyKeys as realVerifyKeys, type VerifyInput, type VerifyResult } from './login.js';
import { writeReportBundle } from './report.js';

// ---------------------------------------------------------------------------------------
// Constants and small helpers (§1, §8.1, §24)
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §24 overlays: the exit confirm row (`/exit` and Ctrl-D ×2 while a run is live). */
export const EXIT_CONFIRM_ROW = 'a run is live: [y] abort and exit   [n] stay              (Enter does nothing)';
/** TUI-DESIGN §24 toasts: after `/login` saved a key mid-session. */
export const LOGIN_SAVED_TOAST = 'saved — applies to the next run (this run keeps its key)';
/** TUI-DESIGN §24 renderer items: `paused after step N — /resume continues, or type a follow-up`. */
export function pausedItemText(step: number): string {
  return `paused after step ${step} — /resume continues, or type a follow-up`;
}
/** TUI-DESIGN §24: `session <id> ended: N runs, $x total` (`/new`). */
export function sessionEndedText(sessionId: string, runs: number, totalUsd: number): string {
  return `session ${sessionId} ended: ${runs} run${runs === 1 ? '' : 's'}, ${usd2(totalUsd)} total`;
}
/** decisions kept for `/decisions`, `/why` and `/calibration` of the current run */
export const DECISIONS_KEPT_FOR_COMMANDS = 400;
/** recent warnings/errors kept for `/errors` */
export const ERRORS_KEPT = 50;
/** TUI-DESIGN §8.6: steers accepted while the engine is still being created (the same cap as the engine's queue) */
export const STARTING_STEER_CAP: number = PENDING_DIRECTIVES_MAX;
/** §3.3: the bound on the render flush that commits the renderer's last item (`[ui] exited on Ctrl-C ×2`) before the unmount */
export const FINAL_FLUSH_BOUND_MS = 300;
/** §12.4 "all checks before the first write": the commands that run one at a time (files, credentials, the session's run list) */
// TUI-DESIGN-5 §4.9 (R5-4's §9.2 request on this file): `land` is the only one of the seven agent rows that
// MUTATES FILES, so it is the only one that joins this set — 11 members → 12. It is also the only one with
// `destructive: true`, which is a different gate (a confirm row whose Enter is inert, TD4 §4.5).
export const EXCLUSIVE_COMMANDS: ReadonlySet<CommandAction['kind']> = new Set<CommandAction['kind']>(['undo', 'rewind', 'diff', 'export', 'report', 'login', 'logout', 'resume', 'new', 'trust', 'historyClear', 'land']);

// --- TUI-DESIGN-2 §12 strings of the conversational intake (§3.1, §3.6–3.8) and the mode items (§1.3) ------------------------
/** §12 "Mode items": the `[ui] error:` text when no Jev key resolves for a chat submission */
export const MISSING_JEV_KEY = 'missing decider.apiKey: set TYPESAFE_API_KEY or OPENROUTER_API_KEY, or run jevcode login';
export const RUN_LIVE_ERROR = 'a run is live; Enter steers it (Esc pauses, Esc Esc aborts)';
export const CONFIG_NOT_READY = 'configuration not ready yet';

/** TUI-DESIGN-4 §7.2 item 4: the run-directory artefacts the epilogue's `files` row may name, in the order it names them. */
export const EPILOGUE_ARTEFACTS = ['transcript.log', 'state.json', 'jevcode.log'] as const;

/**
 * TUI-DESIGN-4 §3.1.6 / contract 1.7 item 1: what a renderer-local item may carry. `detail` is the joined body
 * every existing sink already reads (`--plain`, `--json`, `clipDetail`); `detailRows` is the TUI's pre-split form
 * WITH the colour role `renderBlock` computed for each row, and `detailKind` routes `/diff <step>` through the
 * diff renderer for colour only.
 */
export interface NoteOptions {
  detail?: string;
  label?: UiLabel;
  /** `dim` is the quiet startup grade: the TUI paints the body dim, `--plain` prints it unchanged, `--json` records it as `info` */
  level?: 'info' | 'warn' | 'error' | 'dim';
  detailRows?: readonly RenderedRow[];
  detailKind?: 'diff' | 'table' | 'text';
}

/** TUI-DESIGN-4 §3.1 (D-U): what a `block()` call may declare on top of `NoteOptions`. */
export interface BlockOptions extends NoteOptions {
  /** §3.1.5: the row cap of this block (`BLOCK_CAPS`) */
  max?: number;
  /** §3.1.5: the footer that names where the rest is; `{n}` is the dropped-row count, laddered down to fit */
  moreFooter?: string;
  /** §3.3: the INNER table widths the builder pinned, so the TUI and the CLI draw one geometry */
  tableCols?: readonly number[];
  /** §3.3 edge 4: trailing rows the cap may never drop (`/config`'s sandbox statement) */
  protectTail?: number;
  /** §3.1.6: the block's declared syntax — the ONLY thing that lets `detailRole` classify a raw row */
  syntax?: 'diff';
}

/**
 * TUI-DESIGN-4 §3.1.7 / §12: the fixed error shape — `error: /<command>[ <arg>] — <what went wrong> — <what to do
 * instead>`. `/steer` is the measured case: `‘/steer needs a live run’` says what is wrong and nothing about what to
 * do, and it was spelt two different ways at the two call sites. One table, both sites.
 */
export const STEER_ERRORS = {
  full: `/steer — the steer queue is full (${PENDING_DIRECTIVES_MAX} waiting) — let the run consume one first`,
  empty: '/steer — no text — type the message after the command',
  finished: '/steer — needs a live run; type the text and press Enter once one is running',
} as const;
/**
 * TUI-DESIGN-4 §3.1.7 / §12: every LITERAL command-refusal text of this module, in one table, so the shape
 * `error: /<command>[ <arg>] — <what went wrong> — <what to do instead>` is asserted once over all of them
 * (`test/unit/cli/session.test.ts`) instead of drifting per call site. A refusal whose body is a dynamic message
 * (`${describe(e)}`) keeps the `/<command> — <message>` prefix and is not in this table: there is no remedy to
 * name for an arbitrary failure. An EMPTY state is never here — §3.1.7 makes those info sentences.
 */
export const COMMAND_ERRORS = {
  rewindNoStep: '/rewind — no step given — pick one with /rewind <step>',
  diffNoRepo: '/diff — not a git repository — /diff <step> compares against the step pre-images instead',
  diffNoSandbox: '/diff — no sandbox is available for git — check the sandbox level with /config',
  diffFullLive: '/diff --full — a run is live — press Esc to pause it, then run /diff --full',
  exportNoSession: '/export — no session yet — type a task to start one',
  resumeLive: '/resume — a run is live — press Esc to pause it, then run /resume',
  unsteerEmpty: '/unsteer — nothing is queued — /steer <text> queues one while a run is live',
  copyDraft: "/copy draft — the draft lives in the TUI composer — run jevcode chat without --plain to use it",
  editor: '/editor — the external editor is Ctrl+G in the TUI composer — press Ctrl+G instead',
} as const;

/** the `[ui] error:` text when no generator key resolves for a chat submission in a generator mode */
export const MISSING_GENERATOR_KEY = 'missing generator.apiKey: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY, or run jevcode login';
/** the line appended to the reply when Jev read the submission as a task: the run starts right after it */
export const ON_IT_LINE = 'On it — starting the run.';
/** the line appended when Jev was unsure — the human turns the message into a task with `do it` (no second reading) */
export const DO_IT_OFFER = "Say `do it` and I'll make that a task.";
/** the offer is made only for an `ambiguous` reading of a message that is not a question — `who made you?` read `ambiguous` live and got an offer it did not want (2026-09-22 drive) */
export const QUESTION_OPENER_RE = /^\s*(?:who|whom|whose|what|which|why|how|when|where|can|could|is|are|am|was|were|do|does|did|should|would|will)\b/i;
/** a question by punctuation or by its opener — `who made you` (no `?`) got the offer live on 2026-09-22 */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return /\?\s*$/.test(t) || QUESTION_OPENER_RE.test(t);
}
export function offerWanted(text: string, res: Pick<IntakeResult, 'intake'>): boolean {
  return res.intake.kind === 'ambiguous' && !looksLikeQuestion(text);
}
/** the answers that accept `DO_IT_OFFER`; any other message drops the offer */
export const DO_IT_RE = /^\s*(do it|yes,? do it|go ahead|make it a task|run it|yes)\s*[.!]*\s*$/i;
/** how long the landed reply waits for Jev's background reading before it lands without it (Jev is normally done long before) */
export const INTAKE_GRACE_MS = 1500;
/** recent sessions of this workspace the chat system prompt names */
export const CHAT_RECENT_SESSIONS = 3;
/** §3.1 row 12: Jev unreachable / `JevHttpError` after the client's retries; `<short>` is the redacted message ≤ 80 chars */
export function INTAKE_UNREACHABLE(short: string): string {
  return `I couldn't reach Jev to read that (${short}). Press Enter to send it again.`;
}
/** §3.1 row 12′ */
export function LLM_UNREACHABLE(model: string, short: string): string {
  return `I couldn't get an answer from ${model} (${short}). Ask again, or /mode jev-only for the lookup.`;
}
/** a 401/403 from Jev on the intake or lookup is not "unreachable": the bubble names /login and the TUI opens the wizard (finding 12; the engine path's key-rejected pane, TD §13.3) */
export function JEV_KEY_REJECTED(status: number): string {
  return `Jev rejected the key (HTTP ${status}). /login saves a new one.`;
}
/** the generator's 401/403 during the LLM turn */
export function LLM_KEY_REJECTED(model: string, status: number): string {
  return `${model} rejected the key (HTTP ${status}). /login saves a new one.`;
}
/** §3.6: an unpriced generator refuses before sending unless --allow-unpriced */
export function LLM_UNPRICED_REFUSAL(model: string): string {
  return `I can't answer through the LLM: ${model} has no pricing entry and --allow-unpriced is off (jev-only lookup still works).`;
}
/** §3.1 row 3 / §3.9: at or over the session cap chat refuses too (no request) */
export function SESSION_CAP_CHAT_REFUSAL(capUsd: number): string {
  return `The session cap (${usd2(capUsd)}) is reached, so I'm not sending anything to Jev. Raise it with /budget session-spend-cap <usd>, or /new for a fresh session.`;
}
/** §12 "Status" toasts */
export const STOPPED_THINKING_TOAST = 'stopped thinking';
export const STILL_THINKING_TOAST = 'one moment — still thinking';
/**
 * §12 "Mode items" / TUI-DESIGN-3 §1.1, §1.9, §10 "Mode items": ONE table per mode (generator-neutral copy — "the code model", never a
 * vendor; R3 F9), read by `case 'mode'` through `modeSetItem`. The four round-2 names stay as aliases of its rows.
 */
export const MODE_SET_ITEM: Readonly<Record<EngineMode, string>> = {
  'jev-on': `mode ${MODE_BADGE_WORD['jev-on']} from the next run — the code model writes the code, Jev still decides every step (persist: jevcode config set mode jev-on)`,
  'jev-only': `mode ${MODE_BADGE_WORD['jev-only']} from the next run — no generating LLM; code proposes, Jev decides, tests verify (persist: jevcode config set mode jev-only)`,
  'jev-off': `mode ${MODE_BADGE_WORD['jev-off']} from the next run — the generator alone, no Jev (bench condition; reviews still ask)`,
  'llm-jev': `mode ${MODE_BADGE_WORD['llm-jev']} from the next run — the code model writes candidate patches, tests verify them, Jev arbitrates (persist: jevcode config set mode llm-jev)`,
};
export function modeSetItem(mode: EngineMode): string {
  return MODE_SET_ITEM[mode];
}
export const MODE_JEV_ON_SET = MODE_SET_ITEM['jev-on'];
export const MODE_JEV_ONLY_SET = MODE_SET_ITEM['jev-only'];
export const MODE_JEV_OFF_SET = MODE_SET_ITEM['jev-off'];
export const MODE_LLM_JEV_SET = MODE_SET_ITEM['llm-jev'];
/** TUI-DESIGN-3 §1.7 / §10 "Chat" (R3 F5/F10): a 402 from OpenRouter on the intake or the LLM turn is "no credits", not "unreachable" (144 cells ≤ REPLY_TEXT_MAX) */
export function CREDITS_EXHAUSTED(side: 'jev' | 'generator', status: number): string {
  void side; // both sides bill the same OpenRouter key; the text keys on the host, not the side
  return `OpenRouter says this key has no credits (HTTP ${status}). Add credits at openrouter.ai/credits, or /mode jev-only ($${JEV_ONLY_DEFAULT_SPEND_CAP_USD.toFixed(2)} cap; Jev bills the same key).`;
}
/** TUI-DESIGN-3 §4.4 F12: `/new` before any session */
export const NO_SESSION_YET = 'no session yet — the next prompt starts one';
/** TUI-DESIGN-3 §4.4 F13: `/rename` cut its title */
export const RENAME_CUT_NOTE = ' (cut to 60 chars)';
/** TUI-DESIGN-3 §4.4 F15: `/model` / `/provider` under a jev-only next mode */
export const GENERATOR_IGNORED_NOTE = ' — mode jev-only ignores the generator; /llm on to use it';
/** §3.11: intakes whose decision rows the panel keeps */
export const CHAT_INTAKES_KEPT = 3;
/** §3.6 `chatEstimateUsd`: input tokens per message char and per file byte */
export const CHAT_TOKENS_PER_CHAR = 0.25;
export const CHAT_TOKENS_PER_FILE_BYTE = 0.25;

/** TUI-DESIGN-2 §3.8 `thinking(phase)`: what the status row shows while a chat request is in flight */
export type ThinkingPhase = 'intake' | 'lookup' | 'replying';
/**
 * TUI-DESIGN-2 §6 item 15: the reducer actions the controller dispatches for the chat and the mode badge (S4 adds them to
 * `UiAction`; typed here so the controller compiles before that lands — the union collapses once it does).
 */
export type ChatUiAction =
  | { type: 'thinking'; phase: ThinkingPhase | null }
  | { type: 'chat-decisions'; rows: readonly DecisionRow[] }
  | { type: 'mode'; mode: EngineMode; pending: EngineMode | null };
/** §1.3 / §1.4: why the wizard opened (`mode` = `/mode jev-on` without a generator key; Ctrl-C then keeps the session) */
export type WizardReason = 'missing' | 'login' | 'rejected' | 'mode';

/** what the LLM chat turn reads of the generator section; `--mock` / `--mock-generator` never validate it (like startRun, §15.3) */
export type ChatGenerator = Pick<GeneratorConfig, 'model' | 'priced' | 'pricing' | 'maxTokens'>;
export const MOCK_CHAT_GENERATOR: ChatGenerator = { model: 'mock', priced: true, pricing: { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 }, maxTokens: 4096 };

/** what a chat reply said and cost; `usage === null` = nothing went out (a refusal) */
export interface ChatReply {
  lines: string[];
  usage: TokenUsage | null;
  latencyMs: number;
}
/** Jev's background reading of a submission: `res` is null when it was skipped, failed or aborted, and `error` says which */
export interface BackgroundIntake {
  res: IntakeResult | null;
  error: unknown;
}

// ---------------------------------------------------------------------------------------
// `autonomy full` — complete autonomy by default
// ---------------------------------------------------------------------------------------

/** the one-line `[review]` card is informational, so it is clipped hard — it never becomes a paragraph in the transcript */
export const AUTO_APPROVED_NOTE_MAX = 160;
/** the identity the engine records in a declined/approved reason when `autonomy full` answered instead of a human */
export const IDENTITY_AUTONOMY_FULL = 'autonomy full (auto-approved)';

/**
 * The INFORMATIONAL review card of `autonomy full`: what ran and why it was flagged, on one redacted line
 * (`[review] auto-approved (autonomy full): <action> — <risk reason>`). It never waits for anything.
 */
export function autoApprovedNote(req: ConfirmRequest, redact: (s: string) => string): string {
  const reason = req.risk.reason.trim() === '' ? `risk ${req.risk.verdict}` : req.risk.reason.trim();
  const line = redact(`auto-approved (autonomy full): ${actionLabel(req.proposal.action)} — ${reason}`).replace(/\s*\n\s*/g, ' ').trim();
  return line.length > AUTO_APPROVED_NOTE_MAX ? `${line.slice(0, AUTO_APPROVED_NOTE_MAX - 1)}…` : line;
}

/**
 * `autonomy full`: a `review` risk verdict is approved IMMEDIATELY and logged through `onAuto` — the inner
 * (human) confirmer is never consulted and nothing ever waits. An already-aborted signal still rejects with the
 * AbortError, exactly as `createTuiConfirmer` does, so a Ctrl-C mid-step is not turned into an approval.
 * `block` never reaches a confirmer: the engine stops on it under both autonomies.
 */
export function autonomousConfirmer(inner: Confirmer, onAuto: (req: ConfirmRequest) => void): Confirmer {
  const auto = (req: ConfirmRequest, { signal }: { signal: AbortSignal }): Promise<ConfirmOutcome> => {
    if (signal.aborted) return Promise.reject(signal.reason instanceof AbortError ? signal.reason : new AbortError('signal'));
    try {
      onAuto(req);
    } catch {
      // the card is a courtesy; a renderer that throws must never turn an approval into a hang
    }
    return Promise.resolve({ approved: true });
  };
  void inner; // deliberately unconsulted: the human confirmer is what `--autonomy review` selects instead of this one
  return {
    identity: IDENTITY_AUTONOMY_FULL,
    confirm: (req, o) => auto(req, o).then((r) => r.approved),
    confirmDetailed: auto,
  };
}

/** §3.6: the cost bound checked before an LLM chat turn — (1,200 + chars × 0.25 + file bytes × 0.25) × in-price + min(800, maxTokens) × out-price */
export function chatEstimateUsd(gen: Pick<GeneratorConfig, 'pricing' | 'maxTokens'>, text: string, fileBytes: number): number {
  const inputTokens = CHAT_FIXED_INPUT_TOKENS + text.length * CHAT_TOKENS_PER_CHAR + fileBytes * CHAT_TOKENS_PER_FILE_BYTE;
  return inputTokens * (gen.pricing.inputPerM / 1e6) + chatMaxTokens(gen.maxTokens) * (gen.pricing.outputPerM / 1e6);
}

/** TUI-DESIGN §1: `CI` / `CONTINUOUS_INTEGRATION` set and not `0`/`false`. */
export function isInCi(env: NodeJS.ProcessEnv): boolean {
  const v = env['CI'] ?? env['CONTINUOUS_INTEGRATION'];
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== '' && t !== '0' && t !== 'false';
}

/**
 * TUI-DESIGN §1 rule: `interactive = stdin.isTTY && stdout.isTTY && !isInCi && TERM !== 'dumb' && !plain && !json && !noInput`.
 * Pure over the facts the caller probed.
 */
export function isInteractive(o: { stdinIsTTY: boolean; stdoutIsTTY: boolean; env: NodeJS.ProcessEnv; flags: Pick<ParsedFlags, 'plain' | 'json' | 'noInput'> }): boolean {
  return o.stdinIsTTY && o.stdoutIsTTY && !isInCi(o.env) && o.env['TERM'] !== 'dumb' && o.flags.plain !== true && o.flags.json !== true && o.flags.noInput !== true;
}

/** `~/.jevcode` — or `JEVCODE_HOME` (the directory whose `runs/` is the runs dir, config/resolve.ts). */
export function jevcodeDir(env: NodeJS.ProcessEnv, home: string, cwd: string): string {
  const h = env['JEVCODE_HOME']?.trim();
  return h !== undefined && h !== '' ? resolvePath(cwd, h) : join(home, '.jevcode');
}

/** TUI-DESIGN §8.2: `<jevcodeDir>/sessions/index.jsonl`. */
export function sessionsIndexPath(dir: string): string {
  return join(dir, 'sessions', INDEX_FILE);
}

/** TUI-DESIGN §4.6: `<jevcodeDir>/history.jsonl`. */
export function historyFilePath(dir: string): string {
  return join(dir, 'history.jsonl');
}

/** TUI-DESIGN §8.1: `<jevcodeDir>/exports/<sessionId>.log` (the session/export.ts sanitiser). */
export function exportFilePath(dir: string, sessionId: string): string {
  return join(dir, 'exports', basename(defaultExportPath('/', sessionId)));
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** apply raw-mode editing bytes to a collected line: Backspace/DEL drop one code point, Ctrl-U clears, other C0 bytes are dropped */
export function applyRawEdits(raw: string): string {
  const out: string[] = [];
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x7f || c === 0x08) out.pop();
    else if (c === 0x15) out.length = 0;
    else if (c < 0x20 && ch !== '\t') continue;
    else out.push(ch);
  }
  return out.join('');
}

// ---------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------

export type RendererKind = 'tui' | 'plain' | 'json';

/**
 * TUI-DESIGN §11.1: what the wizard collected — the controller persists it (`addSecret` first, then the atomic 0600 write).
 * TUI-DESIGN-3 §6 item 2 / §1.4: `mode` — the options step's `3 Jev only` pends (`/login`) or persists (a startup wizard) a mode without saving a key.
 */
export type WizardOutcome = { kind: 'saved'; patch: CredentialsPatch; mode?: { mode: EngineMode; persist: boolean } } | { kind: 'persisted' } | { kind: 'cancelled' } | { kind: 'mode'; mode: EngineMode; persist: boolean };

/**
 * TUI-DESIGN §0 "one modal slot": the prompts a renderer may answer. Every member is optional; the controller takes
 * the C46 safe default for an absent one. The Ink renderer exposes its implementation as `prompts` (duck-typed by
 * `main.tsx`), the `--plain` TTY uses `createPlainPrompter` over the readline composer's line source.
 */
export interface Prompter {
  /**
   * §11.1 wizard (`reason` `missing` at start, `login` for `/login`, `rejected` after a 401 pane; TUI-DESIGN-2 §1.4: `mode` for
   * `/mode jev-on` without a generator key — `mode` is the target mode the keys are for). TUI-DESIGN-3 §6 item 3 / §1.4.3: `found` is the
   * detect-time hint of which key already resolves (a source, never a value) and `foundSource` the layer it came from — the `key` step's found-title.
   */
  wizard?(
    missing: readonly SecretSettingName[],
    o: {
      provider: WizardProvider | null;
      reason: WizardReason;
      mode?: EngineMode;
      found?: 'typesafe' | 'jev' | 'anthropic' | null;
      foundSource?: 'env' | 'dotenv' | 'file';
      /** TUI-DESIGN-3 §1.4.1 (edges 11, 17): the found Jev value is an OpenRouter key (a boolean, never the value) */
      foundReusable?: boolean;
      /** TUI-DESIGN-3 §1.3.2: the resolved Jev provider (a reopen with both sides openrouter takes the one-paste field) */
      jevProvider?: JevProvider | null;
    },
  ): Promise<WizardOutcome>;
  /** §11.3 trust gate: 1 trust · 2 this session only · 3 don't trust; null = cancelled (= 3). TUI-DESIGN-3 §4.4 F17: `reopen` marks the `/trust` card (Esc / Ctrl-C close it) */
  trust?(inputs: TrustInputs, o?: { reopen?: boolean }): Promise<TrustOption | null>;
  /** §9.3 follow-up box */
  followUp?(box: FollowUpBoxInput): Promise<'y' | 'r' | 'n'>;
  /** §3.3 exitConfirm: true = abort and exit */
  exitConfirm?(): Promise<boolean>;
  /** §13.3 blocking pane */
  blocking?(req: BlockingRequest): Promise<BlockingAnswer>;
  /** §12.4 undo ask row */
  undoAsk?: UndoAsk;
  /** §10.2 the F-V gate row for an argv task: true = send */
  secretGate?(hits: readonly SecretHit[]): Promise<boolean>;
  /** §8.4 picker: the run to continue, or null */
  picker?(sessions: readonly SessionRow[], o: { sort: 'updated' | 'created'; workspace: string }): Promise<{ runId: string } | null>;
  /** §12.5 rewind picker: the step, or null */
  rewind?(steps: readonly RewindStep[]): Promise<number | null>;
  /** §12.5 `files (done) · [p] plan+window · [b] both · Esc keep` */
  rewindChoice?(): Promise<'files' | 'plan' | 'both'>;
  /** §5.2 `/history clear` y/N */
  historyClear?(): Promise<boolean>;
  /** `useApp().suspendTerminal` for `/diff --full` (§12.6); absent → the diff is shown inline */
  suspendTerminal?(run: () => Promise<void>): Promise<void>;
  /** the renderer's current width for the blocks */
  columns?(): number;
  /** §13.5 / F3: settle every pending prompt with its safe default — the renderer is unmounting, no controller await may outlive it */
  cancelAll?(): void;
}

/** A renderer that also answers prompts (duck-typed lookup in main.tsx: `'prompts' in renderer`). */
export interface PromptingRenderer extends Renderer {
  prompts?: Prompter;
}

/** the fields of `checkpoint/resume.ts` `ResumeLoad` the controller reads */
export interface ResumeLoadLike {
  meta: RunMeta;
  state: CheckpointState;
  previousStopReason: StopReason | null;
  warnings: string[];
}

/** run.json + state.json of one finished (or stopped) run; `state` is null for a run that never reached a checkpoint (§8.3). */
export interface LoadedRun {
  meta: RunMeta;
  state: CheckpointState | null;
}

/** what the controller needs from the process: everything with I/O is injectable (tests) */
export interface SessionDeps {
  resolveConfig?: typeof realResolveConfig;
  createEngine?: (opts: EngineOptions) => Promise<Engine>;
  buildProvider?: (config: ResolvedConfigWithDiagnostics, flags: ParsedFlags, mode: EngineMode) => Promise<Provider>;
  buildDecider?: (config: ResolvedConfigWithDiagnostics, flags: ParsedFlags) => Promise<Decider>;
  buildSynthesizer?: (config: ResolvedConfigWithDiagnostics, decider: Decider, mode?: EngineMode) => Promise<Synthesizer>;
  listCandidates?: typeof realListCandidates;
  readIndex?: typeof realReadIndex;
  appendIndexLine?: typeof realAppendIndexLine;
  loadKeybindings?: (path: string) => KeybindingsLoad;
  createHistoryStore?: typeof realCreateHistoryStore;
  loadInstructions?: typeof realLoadInstructions;
  createTrustStore?: typeof realCreateTrustStore;
  probeTrustInputs?: typeof realProbeTrustInputs;
  probeGitState?: (root: string) => Promise<GitState>;
  loadRun?: (runsDir: string, runId: string, redact: (s: string) => string) => Promise<LoadedRun | null>;
  /** `checkpoint/resume.ts loadForResume` — the controller reads `meta`, `state`, `previousStopReason` and `warnings` only */
  loadForResume?: (runsDir: string, runId: string, opts: { redact: (s: string) => string }) => Promise<Pick<ResumeLoadLike, 'meta' | 'state' | 'previousStopReason' | 'warnings'>>;
  writeCredentials?: typeof realWriteCredentials;
  /** TUI-DESIGN-3 §1.4.3 / §1.7: the `mode` row (option `3`) and the `seen.defaultMode` row (D-Q) go through the config writer */
  writeConfigValue?: typeof realWriteConfigValue;
  /** TUI-DESIGN-3 §1.5: the wizard's `y` — injected in tests (never a network call there) */
  verifyKeys?: (input: VerifyInput) => Promise<VerifyResult[]>;
  createSandbox?: typeof realCreateSandbox;
  exportSession?: typeof realExportSession;
  commandLogout?: typeof realCommandLogout;
  /** clipboard for `/copy` */
  copy?: typeof copyRedacted;
  now?: () => number;
  nowIso?: () => string;
  pid?: number;
  /** the session log; default: `createLog` over the fallback dir (P63), retargeted to `<runDir>/jevcode.log` per run (§13.6) */
  log?: Log | undefined;
  /** `os.hostname()` (index rows) */
  hostname?: () => string;
  /**
   * TUI-DESIGN-5 §2.14: the ONE coordination open (`src/session/publish.ts`'s `openSessionLedger`). Injected in
   * tests so the write half, `/who --all` and the `peers` fact can be driven without a real ledger on disk; in
   * production this is the default, and it is still reached only through `createPublisher`, i.e. only after
   * `renderer.firstFrame()` resolved (gate G-R5-1).
   */
  openSessionLedger?: (input: SessionLedgerInput) => Promise<SessionLedger>;
  /** `fs.writeSync(2, …)` for the epilogue on the engine's forced exit path */
  writeStderrSync?: (text: string) => void;
}

export interface SessionControllerOptions {
  flags: ParsedFlags;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** os.homedir() when absent */
  home?: string;
  /** TUI-DESIGN §1: `session` (chat) or `one-shot` (run: exits at run:end) */
  mode: 'session' | 'one-shot';
  renderer: Renderer;
  rendererKind: RendererKind;
  /** an Ink composer is mounted (the §1 rule) */
  interactive: boolean;
  /**
   * TUI-DESIGN-4 §2.8 (P-R10): the refusal message `chat` gets instead of `missing task text` when it asked for an
   * Ink composer and the §1 rule said no — `rendererRefusalRows(sel.reason, env)` from `src/cli/main.tsx` (the §12
   * strings live there, beside the rule that produced the reason; passing ROWS rather than the reason keeps
   * `session.ts` off `main.tsx`, which imports it). Absent when a composer is mounted, and for `run`, whose empty
   * task really is a missing task. Measured case: `TERM=dumb jevcode chat` used to say `missing task text`.
   */
  rendererRefusalRows?: readonly string[] | null;
  launch: LaunchSettings;
  stdout: { write(s: string): unknown; isTTY?: boolean | undefined; columns?: number | undefined };
  stderr: { write(s: string): unknown };
  /** raw-mode capable stdin for the plain prompter's masked fields */
  stdin?: { isTTY?: boolean | undefined; isRaw?: boolean | undefined; setRawMode?: ((mode: boolean) => unknown) | undefined } | undefined;
  prompter?: Prompter | null;
  jsonStream?: JsonStream | null;
  /** one-shot: the task text, or a reader for it (argv / --task-file / piped stdin, read after the first frame); the controller gates it through detectSecrets (§10.2) */
  task?: string | null | (() => Promise<string | null>);
  /** `process.exit` */
  exit: (code: number) => never;
  /** the synchronous, idempotent terminal restore (fatal.ts / tui/terminal.ts) */
  restoreTerminal: () => void;
  deps?: SessionDeps;
}

/** the host plus what the controller and the readline composer need beyond the §15 contract */
export interface ControllerHost extends SessionHost {
  /** TUI-DESIGN §13.3: the renderer's answer to the pending blocking pane; false when none is pending */
  answerBlocking(id: string, answer: BlockingAnswer): boolean;
  /** TUI-DESIGN §15 item 20 `RunPhase` mirror */
  phase(): KeyRunPhase;
  /** true once a run ended in this session (a submission is a follow-up, §4.9) */
  ranBefore(): boolean;
  /** the dispatch context beyond the phase */
  dispatchContext(): Omit<DispatchContext, 'run'>;
  /** resolves at the next `run:end` (or at once when no run is live) */
  awaitRunEnd(): Promise<void>;
}

export interface SessionController {
  readonly host: ControllerHost;
  /** the modal-prompt channel may attach after construction (the `--plain` readline composer needs the host first) */
  setPrompter(p: Prompter | null): void;
  /** §11.1 save (the Ink wizard's host): addSecret first, the atomic 0600 write, the `[setup]` items, resolveConfig again; TUI-DESIGN-3 §1.4.2: `reusedFrom` names the layer a reused Jev key came from */
  persistCredentials(patch: CredentialsPatch, source: 'wizard' | 'login', opts?: { reusedFrom?: FoundSource }): Promise<{ ok: boolean; items: string[]; error?: string }>;
  /** the current workspace's trust inputs (null before the trust gate probed them) */
  trustInputs(): TrustInputs | null;
  /** the `[sandbox]` line for the wizard's sandbox step */
  sandboxLine(): string | null;
  /** the engine mode of the next run */
  mode(): EngineMode;
  /** `<runsDir>` once the configuration resolved */
  runsDir(): string | null;
  /** TUI-DESIGN-3 §1.5: the Ink wizard's `y` — one Jev decision, one 1-token completion, the key info (metered on the session meter, `meterVerify`) */
  verifyForWizard(input: WizardVerifyInput): Promise<WizardVerifyResult>;
  /** TUI-DESIGN-3 §1.4.3: option `3 Jev only` — persist the `mode` row (a startup wizard) or pend it (`/login`) */
  applyModeChoice(mode: EngineMode, persist: boolean): Promise<void>;
  /** TUI-DESIGN-3 §1.4.1 (edges 11, 17): the resolved Jev key's value for the reuse Enter (read at save time, never stored by the prompter) */
  resolvedJevKey(): string | null;
  /** the layer that key came from (`env` / `dotenv` / `file`), for the `reused from` item */
  resolvedJevSource(): FoundSource | null;
  /** TUI-DESIGN-3 §5.1 rule 13: the `[sandbox]` item's TUI-only detail */
  sandboxDetail(): string | null;
  /** the loop: resolves with the process exit code once the session ends */
  run(): Promise<number>;
  /** an external SIGINT / SIGTERM (TUI-DESIGN §14.2): abort the live run with `signal` or exit 130/143 at once */
  signal(name: SignalName): void;
  /** the renderer's `onAbort` (today's App.tsx Ctrl-C): a live run aborts; idle one-shot exits 130 */
  onAbort(reason: 'human_abort' | 'signal'): void;
  readonly engine: Engine | null;
  /** the epilogue context for fatalExit */
  context(): EpilogueContext;
  redact(s: string): string;
  /** read-only view for tests */
  readonly view: SessionView;
}

/** the pending memory-only values of `/budget`, `/model`, `/provider`, `/mode` (§9.4, §5.2) */
export interface PendingSettings {
  spendCapUsd?: number;
  maxSteps?: number;
  maxWall?: { ms: number; text: string };
  maxReplans?: number;
  maxGeneratorTokens?: number;
  model?: string;
  provider?: 'anthropic' | 'openrouter';
  mode?: EngineMode;
}

/** one run of this session as the controller saw it */
export interface RunRecord {
  runId: string;
  runDir: string;
  startedAt: string;
  endedAt: string | null;
  task: string;
  stopReason: StopReason | null;
  exitCode: number | null;
  steps: number;
  costUsd: { generator: number; jev: number };
  changedFiles: string[];
  changedSteps: number[];
  /** step records of the run (`planAfter` for `/rewind`, `changedFiles` for `/undo`) */
  records: StepRecord[];
  resumable: boolean;
  degraded: boolean;
}

export interface SessionView {
  readonly sessionId: string | null;
  readonly runs: readonly RunRecord[];
  readonly phase: KeyRunPhase;
  readonly sessionMeter: SpendMeter;
  readonly runCapUsd: number;
  readonly pending: Readonly<PendingSettings>;
  readonly title: string | null;
  readonly undoNotes: readonly string[];
  readonly undoLog: readonly UndoLogEntry[];
  readonly index: readonly SessionRow[];
  readonly firstFrameMs: number | null;
}

// ---------------------------------------------------------------------------------------
// Provider / decider / engine factories (§15.3: the jev-only branch is untouched — NullProvider, createSynthesizer,
// config.generator() never called under `--mode jev-only`; llm-jev (docs/LLM-JEV-DESIGN.md) takes the REAL generator
// provider like jev-on AND the synthesizer like jev-only)
// ---------------------------------------------------------------------------------------

/**
 * jev-only (docs/JEV-ONLY.md): the generator slot is the NullProvider, which throws if it is ever called, and the
 * generator section of the config is never validated (no key needed). `--mock` / `--mock-generator` use the scripted
 * provider; otherwise `config.generator()` validates the section and picks the client.
 */
export async function buildProvider(config: ResolvedConfigWithDiagnostics, flags: ParsedFlags, mode: EngineMode): Promise<Provider> {
  if (mode === 'jev-only') {
    const { createNullProvider } = await import('../provider/null.js');
    return createNullProvider();
  }
  if (flags.mock || flags.mockGenerator) {
    const { createMockProvider, withMockChat } = await import('../provider/mock.js');
    const { mockChatReplyFromEnv, mockTrajectory } = await import('./mock-trajectory.js');
    // `withMockChat`: a chat turn (no tools) gets the deterministic reply and leaves the trajectory for the run loop;
    // `mockChatReplyFromEnv`: the stream probe's knobs (JEVCODE_MOCK_CHAT_STREAM …) — `{}`, today's reply, when unset
    const chat = mockChatReplyFromEnv(process.env);
    return createMockProvider({ turns: withMockChat(mockTrajectory(Number(flags.mockSteps ?? 8)), chat.reply), ...(chat.onEmit !== undefined ? { onEmit: chat.onEmit } : {}) });
  }
  const gen = config.generator();
  // every provider through the registry, so each uses ITS OWN adapter — the two-client switch that stood here sent
  // openai / gemini / xai / fireworks / meta to the Anthropic client (live smoke on 4d49cca: `anthropic HTTP 404
  // Path not found: /v1/v1/messages`). `gen.baseUrl` is the user's override or the provider's own table entry.
  const { createProvider, requireProvider } = await import('../provider/registry.js');
  const cfg: ProviderConfig = { model: gen.model, apiKey: gen.apiKey, baseUrl: gen.baseUrl, temperature: gen.temperature, maxTokens: gen.maxTokens, pricing: gen.pricing, ...(gen.priced !== undefined ? { priced: gen.priced } : {}) };
  return createProvider(requireProvider(gen.provider), cfg, { redact: config.redact });
}

/**
 * `JEVCODE_MOCK_REVIEW_AT=<step>` (dev-only, `--mock` runs): the mock decider answers the risk stage of that step with
 * the `destructive` dimension concentrated on level 2 of 0–4 (E[k] = 2 → r100 200 of 400, inside the §6 review band
 * 30–70 %), so the review prompt of §6 can be driven in a real pty (§19.5) without a live Jev. Never set in production.
 */
export function mockReviewStep(env: NodeJS.ProcessEnv): number | null {
  const v = env['JEVCODE_MOCK_REVIEW_AT'];
  if (v === undefined || !/^\d+$/.test(v.trim())) return null;
  return Number(v.trim());
}

/** `JEVCODE_MOCK_INTAKE=<kind>` (TUI-DESIGN-2 §3.13, dev-only, `--mock`): forces the mock's `intake` answer (`chat-ambiguous.steps`). */
export function mockIntakeOverride(env: NodeJS.ProcessEnv): IntakeKind | null {
  const v = env['JEVCODE_MOCK_INTAKE']?.trim();
  return v === 'greeting_or_smalltalk' || v === 'question_about_this_tool' || v === 'question_about_the_code' || v === 'coding_task' || v === 'ambiguous' ? v : null;
}
/** `JEVCODE_MOCK_JEV_MS=<ms>` (§3.13): delays the mock (the latency probe). */
export function mockJevLatencyMs(env: NodeJS.ProcessEnv): number {
  const v = env['JEVCODE_MOCK_JEV_MS'];
  return v !== undefined && /^\d+$/.test(v.trim()) ? Number(v.trim()) : 0;
}

const MOCK_GREETING_RE = /^\s*(hi|hello|hey|yo|thanks?|thank you|bye|ok(ay)?|good (morning|evening|afternoon))\b[!. ]*$/i;
const MOCK_TOOL_RE = /\b(you|jevcode|jev|mode|cost|key|command|run)\b/i;

/**
 * TUI-DESIGN-2 §3.13 — the mock decider's intake heuristics, as rules over the mock's `MockDeciderRule` hook (the W2 bridge until
 * S1 lands them inside `src/jev/mock.ts`; the heuristics are the design's, verbatim): `intake` → greeting on the greeting regex,
 * `question_about_this_tool` on `?` + a tool word, `question_about_the_code` on any other `?`, `ambiguous` for ≤ 2 words
 * without `?`, else `coding_task` at p 0.9 with `can_coding_task` 0.9; `reply` → hello_first (hello_again with a conversation),
 * thanks, bye, ok_ack; `about_*` → 0.8 for mode_now on /mode/, cost_so_far on /cost|spent|money/, what_it_is on
 * /what can you do|what are you/, else 0.1; `file_<i>` → 0.7 when the path shares a keyword. Never used outside `--mock`.
 */
export async function mockIntakeRules(env: NodeJS.ProcessEnv): Promise<NonNullable<MockDeciderOptions['rules']>> {
  const { choiceAnswer, noulAnswer } = await import('../jev/mock.js');
  const forced = mockIntakeOverride(env);
  const messageOf = (state: Json): string => {
    const m = state !== null && typeof state === 'object' && !Array.isArray(state) ? state['message'] : undefined;
    return typeof m === 'string' ? m : '';
  };
  const conversationOf = (state: Json): number => {
    const c = state !== null && typeof state === 'object' && !Array.isArray(state) ? state['conversation'] : undefined;
    return Array.isArray(c) ? c.length : 0;
  };
  const kindOf = (message: string): IntakeKind => {
    if (forced !== null) return forced;
    if (MOCK_GREETING_RE.test(message)) return 'greeting_or_smalltalk';
    if (message.includes('?')) return MOCK_TOOL_RE.test(message) ? 'question_about_this_tool' : 'question_about_the_code';
    return message.trim().split(/\s+/).filter((w) => w !== '').length <= 2 ? 'ambiguous' : 'coding_task';
  };
  const replyOf = (message: string, turns: number): string => {
    const m = message.trim();
    if (/^(thanks?|thank you)\b/i.test(m)) return 'thanks';
    if (/^bye\b/i.test(m)) return 'bye';
    if (/^ok(ay)?\b/i.test(m)) return 'ok_ack';
    return turns > 0 ? 'hello_again' : 'hello_first';
  };
  const rule: NonNullable<MockDeciderOptions['rules']>[number] = (ctx) => {
    const intakeQ = ctx.questions['intake'];
    if (intakeQ === undefined || intakeQ.type !== 'choice') {
      // the lookup's context Nouls (§3.6): 0.7 when the path shares a keyword with the message
      const out: Partial<Record<string, Answer>> = {};
      const message = messageOf(ctx.state).toLowerCase();
      for (const [id, q] of Object.entries(ctx.questions)) {
        if (!id.startsWith('file_') || q.type !== 'noul') continue;
        const path = /`([^`]+)`/.exec(typeof q.instructions === 'string' ? q.instructions : '')?.[1] ?? '';
        const shares = path
          .toLowerCase()
          .split(/[^a-z0-9_]+/)
          .some((tok) => tok.length >= 3 && message.includes(tok));
        out[id] = noulAnswer(shares ? 0.7 : 0.1);
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }
    const message = messageOf(ctx.state);
    const kind = kindOf(message);
    const out: Partial<Record<string, Answer>> = { intake: choiceAnswer(intakeQ, { [kind]: 0.9, ...(kind === 'coding_task' ? {} : { coding_task: 0.05 }) }) };
    for (const id of Object.keys(ctx.questions)) if (id.startsWith('can_')) out[id] = noulAnswer(id === `can_${kind}` ? 0.9 : 0.1);
    const replyQ = ctx.questions['reply'];
    if (replyQ !== undefined && replyQ.type === 'choice') out['reply'] = choiceAnswer(replyQ, { [replyOf(message, conversationOf(ctx.state))]: 1 });
    for (const id of Object.keys(ctx.questions)) {
      if (!id.startsWith('about_')) continue;
      const key = id.slice('about_'.length);
      const hit = (key === 'mode_now' && /mode/i.test(message)) || (key === 'cost_so_far' && /cost|spent|money/i.test(message)) || (key === 'what_it_is' && /what can you do|what are you/i.test(message));
      out[id] = noulAnswer(hit ? 0.8 : 0.1);
    }
    return out;
  };
  return [rule];
}

export async function buildDecider(config: ResolvedConfigWithDiagnostics, flags: ParsedFlags, env: NodeJS.ProcessEnv = process.env): Promise<Decider> {
  if (flags.mock) {
    const { createMockDecider, scoreAnswer } = await import('../jev/mock.js');
    const reviewAt = mockReviewStep(env);
    const latencyMs = mockJevLatencyMs(env);
    const rules = await mockIntakeRules(env);
    if (reviewAt !== null) {
      rules.push((ctx) => {
        if (ctx.stage !== 'risk' || ctx.step !== reviewAt) return undefined;
        const q = ctx.questions['destructive'];
        if (q === undefined || q.type !== 'score') return undefined;
        return { destructive: scoreAnswer(q, { 2: 1 }) };
      });
    }
    return createMockDecider({ rules, ...(latencyMs > 0 ? { latencyMs } : {}) });
  }
  const { createJevDecider } = await import('../jev/client.js');
  return createJevDecider(config.decider(), { redact: config.redact });
}

/**
 * jev-only: `createSynthesizer({ decider, redact, mode: 'jev-only' })` — the unchanged Ledger + Sieve (§15.3). llm-jev
 * (docs/LLM-JEV-DESIGN.md §9.2 stage 4): `mode: 'llm-jev'` wires the LLM candidate source over the engine's generator
 * channel (`SynthesisContext.generate`, fed by the REAL provider buildProvider resolves for this mode), and `generation`
 * pins the parameters the source sends on every sample — `LLM_DEFAULT_GENERATION` (§4.6 / §4.8; the config carries no
 * llm-jev overrides, only the mode). Any other mode builds the jev-only synthesizer (the callers never ask for one).
 */
export async function buildSynthesizer(config: ResolvedConfigWithDiagnostics, decider: Decider, mode: EngineMode = 'jev-only'): Promise<Synthesizer> {
  const { createSynthesizer } = await import('../synth/index.js');
  const opts: SynthesizerOptions =
    mode === 'llm-jev'
      ? { decider, redact: config.redact, mode: 'llm-jev', generation: (await import('../synth/llm/source.js')).LLM_DEFAULT_GENERATION }
      : { decider, redact: config.redact, mode: 'jev-only' };
  return createSynthesizer(opts);
}

/** `jev-off` → the generator-only engine; everything else → `createEngine` (both dynamic imports: the first frame never pays for them). */
export async function defaultEngineFactory(opts: EngineOptions): Promise<Engine> {
  if (opts.mode === 'jev-off') return (await import('../loop/generator-only.js')).createGeneratorOnlyEngine(opts);
  return (await import('../loop/engine.js')).createEngine(opts);
}

/**
 * run.json + state.json of a run (`checkpoint/store.ts load()`); a run whose state.json never landed (config / 401 at
 * step 0) reads as `{ meta, state: null }` (§8.3 seed-source rule); a missing run dir is null.
 */
export async function loadRun(runsDir: string, runId: string, redact: (s: string) => string): Promise<LoadedRun | null> {
  const dir = join(runsDir, runId);
  if (!existsSync(join(dir, 'run.json'))) return null;
  try {
    const { meta, state } = await createCheckpointStore(dir, redact).load();
    return { meta, state };
  } catch {
    try {
      const parsed = parseJson(await readFile(join(dir, 'run.json'), 'utf8'));
      if (parsed.ok && isRunMeta(parsed.value)) return { meta: parsed.value, state: null };
    } catch {
      /* unreadable */
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// The --plain TTY prompter (§1 readline composer, §5.2 "plain" column, §6.5, §9.3, §11.2 `/login` raw-mode prompt)
// ---------------------------------------------------------------------------------------

export interface PlainPrompterOptions {
  /** the readline composer's shared line source (`composer.lines`) */
  lines: LineSource;
  stdout: { write(s: string): unknown; columns?: number | undefined };
  /** raw-mode capable stdin: the masked `/login` fields set raw mode so nothing echoes (§11.2 "raw-mode prompt") */
  stdin?: { isTTY?: boolean | undefined; setRawMode?: ((mode: boolean) => unknown) | undefined; isRaw?: boolean | undefined } | undefined;
  ascii?: boolean;
}

/**
 * TUI-DESIGN §1 / §5.2: the readline twins of the modal prompts — one question, one answer line, through the
 * composer's borrowed `LineSource` (no second readline over the same stdin, §6.5). EOF answers every question with
 * its safe default. The wizard fields are read under raw mode (no echo) and edited with Backspace / Ctrl-U; Ctrl-C
 * (byte 0x03 in raw mode) cancels.
 */
export function createPlainPrompter(o: PlainPrompterOptions): Prompter {
  const write = (s: string): void => {
    o.stdout.write(s);
  };
  const columns = (): number => (typeof o.stdout.columns === 'number' && o.stdout.columns > 0 ? o.stdout.columns : 80);

  /**
   * one line from the shared source (null on EOF, or when `watch` cancels the read — the raw-mode Ctrl-C of
   * TUI-DESIGN-3 §1.8 edge 24). `watch` receives the cancel and returns its own detach.
   */
  function ask(prompt: string, watch?: (cancel: () => void) => () => void): Promise<string | null> {
    return new Promise((resolve) => {
      if (o.lines.closed) {
        resolve(null);
        return;
      }
      let done = false;
      let release: (() => void) | null = null;
      let unclose: (() => void) | null = null;
      let unwatch: (() => void) | null = null;
      const finish = (v: string | null): void => {
        if (done) return;
        done = true;
        release?.();
        unclose?.();
        unwatch?.();
        resolve(v);
      };
      release = o.lines.onLine((line) => finish(line));
      unclose = o.lines.onClose(() => finish(null));
      unwatch = watch?.(() => finish(null)) ?? null;
      write(prompt);
    });
  }

  /**
   * TUI-DESIGN-3 §1.8 edge 24: the shared stdin as a byte stream, when the caller passed a real one. `node:readline`
   * runs with `terminal: false` and only ever reports whole lines, so a lone `\u0003` typed at a raw-mode field waited
   * for an Enter that never came (the `--plain` wizard hung on Ctrl-C). Watching the bytes cancels the read at once;
   * the listener is passive (a second `'data'` listener never takes a chunk from readline) and is detached with the read.
   */
  type ByteWatcher = { on(event: 'data', fn: (chunk: string | Uint8Array) => void): unknown; off(event: 'data', fn: (chunk: string | Uint8Array) => void): unknown };
  function byteWatcher(): ByteWatcher | null {
    const s: unknown = o.stdin;
    if (typeof s !== 'object' || s === null) return null;
    const c = s as Partial<ByteWatcher>;
    return typeof c.on === 'function' && typeof c.off === 'function' ? (c as ByteWatcher) : null;
  }
  const hasCtrlC = (chunk: string | Uint8Array): boolean => (typeof chunk === 'string' ? chunk.includes('\u0003') : chunk.includes(0x03));
  /** the `watch` of `ask`: cancel on a `\u0003` byte while the field is read in raw mode (nothing in cooked mode — the kernel keeps it) */
  function watchCtrlC(cancel: () => void): () => void {
    const src = byteWatcher();
    if (src === null) return (): void => undefined;
    const onData = (chunk: string | Uint8Array): void => {
      if (hasCtrlC(chunk)) cancel();
    };
    src.on('data', onData);
    return (): void => {
      src.off('data', onData);
    };
  }

  /** a masked line: raw mode off-echo when available; the terminal's own echo is the fallback (never our own bytes) */
  async function askMasked(prompt: string): Promise<string | null> {
    const raw = o.stdin?.setRawMode !== undefined;
    const wasRaw = o.stdin?.isRaw === true;
    if (raw && !wasRaw) {
      try {
        o.stdin?.setRawMode?.(true);
      } catch {
        /* not a tty */
      }
    }
    try {
      // §1.8 edge 24: in raw mode Ctrl-C is a byte on the stream, never SIGINT and never a line — cancel on it
      const line = await ask(prompt, raw ? watchCtrlC : undefined);
      write('\n');
      if (line === null || line.includes('\u0003')) return null;
      return applyRawEdits(line);
    } finally {
      if (raw && !wasRaw) {
        try {
          o.stdin?.setRawMode?.(false);
        } catch {
          /* not a tty */
        }
      }
    }
  }

  const lower = (s: string | null): string => (s ?? '').trim().toLowerCase();

  return {
    columns,
    async trust(inputs) {
      for (const l of trustLines(inputs, 24, columns(), o.ascii === true)) write(`${l}\n`);
      const a = lower(await ask('trust (1/2/3): '));
      return a === '1' ? 1 : a === '2' ? 2 : a === '3' ? 3 : null;
    },
    async followUp(box) {
      for (const l of followUpBoxLines(box)) write(`${l}\n`);
      const a = lower(await ask('y/r/n: '));
      return a === 'y' || a === 'yes' ? 'y' : a === 'r' ? 'r' : 'n';
    },
    async exitConfirm() {
      write(`${EXIT_CONFIRM_ROW}\n`);
      const a = lower(await ask('y/n: '));
      return a === 'y' || a === 'yes';
    },
    async blocking(req) {
      for (const l of blockingRowsFull(req)) write(`${l}\n`);
      const a = lower(await ask('answer: '));
      if (a === 'r') return 'retry';
      if (a === 'c') return 'continue';
      if (a === 'l') return 'login';
      if (a === 'p') return 'pin';
      return 'stop';
    },
    async undoAsk(askRow) {
      const a = lower(await ask(`${askRow.prompt} `));
      if (a === 'y' || a === 'yes') return 'y';
      if (a === 'a') return 'a';
      if (a === 's') return 's';
      if (a === '') return 'enter';
      return 'n';
    },
    async secretGate(hits) {
      const a = lower(await ask(`${gatePlainPrompt(hits)} `));
      return a === 'y' || a === 'yes';
    },
    // TUI-DESIGN-3 §1.4.3 / §1.3.3: the `--plain` twin of the wizard over the same strings — the other-ways line only when both keys are
    // missing, then the one masked OpenRouter key (`jevProvider` written on the one-key path ONLY — R3 F4 — never beside a resolving Jev key)
    async wizard(missing, w) {
      const patch: CredentialsPatch = {};
      let provider: WizardProvider | null = w.provider;
      const needGen = missing.includes('generator.apiKey');
      const needJev = missing.includes('decider.apiKey');
      const found = w.found ?? null;
      const mode = w.mode ?? DEFAULT_MODE;
      // the one-key path: both missing (nothing resolves) under provider null / openrouter, or the found-title path (Jev resolves, the generator is missing)
      const oneKeyPath = needGen && needJev && found === null && (provider === null || provider === 'openrouter');
      const foundPath = needGen && !needJev && (found === 'typesafe' || found === 'jev') && (provider === null || provider === 'openrouter');
      if (oneKeyPath || foundPath) {
        if (oneKeyPath) {
          // EOF (and a Ctrl-C the line carried) cancels: `lower()` would have turned both into '' and asked for the key anyway
          const otherLine = await ask(LOGIN_OTHER_WAYS_PROMPT);
          if (otherLine === null || otherLine.includes('\u0003')) return { kind: 'cancelled' };
          const other = lower(otherLine);
          if (other === 'j') {
            // `[j] Jev only`: the Jev provider question, the Jev key, and the mode (persisted at startup, pended from /login)
            write('Where do you reach Jev?  1 typesafe  2 openrouter\n');
            const p = lower(await ask('provider (1/2): '));
            const jp: JevProvider | null = p === '1' || p === 'typesafe' ? 'typesafe' : p === '2' || p === 'openrouter' ? 'openrouter' : null;
            if (jp === null) return { kind: 'cancelled' };
            const k = await askMasked(`Jev API key (${jp === 'typesafe' ? 'TYPESAFE_API_KEY' : 'JEV_API_KEY'}): `);
            if (k === null || k.length < 8) return { kind: 'cancelled' };
            return { kind: 'saved', patch: { jevApiKey: k, jevProvider: jp }, mode: { mode: 'jev-only', persist: w.reason === 'missing' } };
          }
          if (other === 't') {
            // `[t] TypeSafe Jev`: the TypeSafe key, then the optional OpenRouter generator key (Enter = skip, stays Jev-only)
            const ts = await askMasked('Jev API key (TYPESAFE_API_KEY): ');
            if (ts === null || ts.length < 8) return { kind: 'cancelled' };
            patch.jevApiKey = ts;
            patch.jevProvider = 'typesafe';
            const gen = await askMasked('OpenRouter API key (OPENROUTER_API_KEY) — Enter = skip (stay Jev-only): ');
            if (gen === null) return { kind: 'cancelled' };
            if (gen.length >= 8) {
              patch.apiKey = gen;
              patch.provider = 'openrouter';
              return { kind: 'saved', patch };
            }
            return { kind: 'saved', patch, mode: { mode: 'jev-only', persist: w.reason === 'missing' } };
          }
          if (other === 'a') provider = 'anthropic';
        }
        if (provider !== 'anthropic') {
          const k = await askMasked(oneKeyPath ? LOGIN_ONE_KEY_PROMPT : 'OpenRouter API key (OPENROUTER_API_KEY) — the code model: ');
          if (k === null || k.length < 8) return { kind: 'cancelled' };
          patch.apiKey = k;
          patch.provider = 'openrouter';
          if (oneKeyPath) {
            patch.jevApiKey = k;
            patch.jevProvider = 'openrouter';
          }
          return { kind: 'saved', patch };
        }
      }
      if (needGen && mode !== 'jev-only') {
        if (provider === null) {
          write('No API key found. Pick the generator provider:\n  1 anthropic (ANTHROPIC_API_KEY)   2 openrouter (OPENROUTER_API_KEY, also Jev)\n');
          const p = lower(await ask('provider (1/2): '));
          if (p === '1' || p === 'anthropic') provider = 'anthropic';
          else if (p === '2' || p === 'openrouter') provider = 'openrouter';
          else return { kind: 'cancelled' };
        }
        patch.provider = provider;
        const k = await askMasked(`${provider === 'anthropic' ? 'Anthropic' : 'OpenRouter'} API key (${PROVIDER_ENV[provider]}): `);
        if (k === null || k.length < 8) return { kind: 'cancelled' };
        patch.apiKey = k;
      }
      if (needJev) {
        const reuse = provider === 'openrouter' && patch.apiKey !== undefined;
        const k = await askMasked(`Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)${reuse ? ' — Enter = reuse the OpenRouter key for Jev' : ''}: `);
        if (k === null) return { kind: 'cancelled' };
        if (k.length >= 8) patch.jevApiKey = k;
        else if (reuse && patch.apiKey !== undefined) {
          patch.jevApiKey = patch.apiKey;
          patch.jevProvider = 'openrouter';
        } else return { kind: 'cancelled' };
      }
      return patch.apiKey !== undefined || patch.jevApiKey !== undefined ? { kind: 'saved', patch } : { kind: 'cancelled' };
    },
    async picker(sessions, p) {
      const g = o.ascii === true;
      write(`${pickerHeader({ workspace: p.workspace, widened: false, sort: p.sort, columns: columns(), ascii: g })}\n`);
      const rows = pickerRows(sessions, { workspace: p.workspace, widened: false, nowMs: Date.now(), columns: columns(), sort: p.sort, ascii: g });
      if (rows.length === 0) {
        write(`${noSessionMessage(p.workspace)}\n`);
        return null;
      }
      for (const r of rows) write(`${r}\n`);
      const a = (await ask('run id or title (Enter cancels): '))?.trim() ?? '';
      if (a === '') return null;
      const r = resolveResumeTarget(sessions, a);
      if (r.kind === 'run') return { runId: r.runId };
      if (r.kind === 'session') {
        const newest = r.session.runs[r.session.runs.length - 1];
        return newest ? { runId: newest.runId } : null;
      }
      return null;
    },
    async rewind(steps) {
      for (const l of rewindPickerRows(steps, columns())) write(`${l}\n`);
      const a = (await ask('step (Enter cancels): '))?.trim() ?? '';
      const n = Number(a);
      return /^\d+$/.test(a) && steps.some((s) => s.step === n) ? n : null;
    },
    async rewindChoice() {
      const a = lower(await ask(`${REWIND_CHOICE} `));
      return a === 'p' ? 'plan' : a === 'b' ? 'both' : 'files';
    },
    async historyClear() {
      const a = lower(await ask('clear the prompt history? y/N '));
      return a === 'y' || a === 'yes';
    },
    suspendTerminal: (run) => run(),
  };
}

// ---------------------------------------------------------------------------------------
// The controller (§1 session loop)
// ---------------------------------------------------------------------------------------

type RunEndEvent = Extract<EngineEvent, { type: 'run:end' }>;

/** TUI-DESIGN-3 §4.4 F3: the exhaustiveness guard of `execute()` — a dropped `CommandAction['kind']` fails tsc, never a user */
function assertNever(x: never): never {
  throw new Error(`unhandled command action ${JSON.stringify(x)}`);
}

/** the last N of an array, in place */
function keepLast<T>(xs: T[], n: number): void {
  if (xs.length > n) xs.splice(0, xs.length - n);
}

/** TUI-DESIGN §1: the "recent" hint takes the session with the greatest `lastUsed` in this workspace. */
export function mostRecentSession(sessions: readonly SessionRow[], workspace: string): SessionRow | null {
  let best: SessionRow | null = null;
  for (const s of sessions) {
    if (s.workspace !== workspace) continue;
    if (best === null || Date.parse(s.lastUsed) > Date.parse(best.lastUsed)) best = s;
  }
  return best;
}

/** the newest run of a session row (the fold keeps runs in start order) */
function newestRunId(s: SessionRow): string | null {
  const r = s.runs[s.runs.length - 1];
  return r ? r.runId : null;
}

/**
 * llm-jev iteration 1 (src/jev/cache.ts): requests a run served from its request-hash cache, Σ `StepRecord.jevCacheHits` over the
 * run's committed steps. Read from the explicit per-step field the engine derives from `jevRequests[].cached` — never from
 * `usage.calls === 0`, which the bench's stub decider reports on every request.
 */
export function jevCacheHitsOf(records: readonly Pick<StepRecord, 'jevCacheHits'>[]): number {
  let n = 0;
  for (const r of records) n += r.jevCacheHits ?? 0;
  return n;
}

/** The `/jev` block's `cost` value: `$0.007 · 1,787 questions` and, only when the run had any, `· 12 cache hits`. */
export function jevCostValue(jevUsdText: string, questions: number, cacheHits: number): string {
  const base = `${jevUsdText} · ${questions} question${questions === 1 ? '' : 's'}`;
  return cacheHits > 0 ? `${base} · ${cacheHits} cache hit${cacheHits === 1 ? '' : 's'}` : base;
}

export function createSessionController(o: SessionControllerOptions): SessionController {
  const deps = o.deps ?? {};
  const { env, cwd, flags } = o;
  const home = o.home ?? homedir();
  const now = deps.now ?? ((): number => Date.now());
  const nowIso = deps.nowIso ?? defaultNowIso;
  const pid = deps.pid ?? process.pid;
  const renderer = o.renderer;
  let prompter: Prompter | null = o.prompter ?? null;
  const json = o.jsonStream ?? null;
  const stderr = o.stderr;
  const jdir = jevcodeDir(env, home, cwd);
  const indexPath = sessionsIndexPath(jdir);
  const writeStderrSync = deps.writeStderrSync ?? ((text: string): void => {
    try {
      writeSync(2, text);
    } catch {
      /* EPIPE: nothing left to say */
    }
  });
  const resolveConfig = deps.resolveConfig ?? realResolveConfig;
  const createEngineFn = deps.createEngine ?? defaultEngineFactory;
  const providerOf = deps.buildProvider ?? buildProvider;
  const deciderOf = deps.buildDecider ?? ((c: ResolvedConfigWithDiagnostics, f: ParsedFlags): Promise<Decider> => buildDecider(c, f, env));
  const synthesizerOf = deps.buildSynthesizer ?? buildSynthesizer;
  const listCandidatesFn = deps.listCandidates ?? realListCandidates;
  const readIndexFn = deps.readIndex ?? realReadIndex;
  const appendIndex = deps.appendIndexLine ?? realAppendIndexLine;
  const loadKeybindingsFn = deps.loadKeybindings ?? ((p: string): KeybindingsLoad => realLoadKeybindings(p));
  const createHistory = deps.createHistoryStore ?? realCreateHistoryStore;
  const loadInstructionsFn = deps.loadInstructions ?? realLoadInstructions;
  const createTrust = deps.createTrustStore ?? realCreateTrustStore;
  const probeTrust = deps.probeTrustInputs ?? realProbeTrustInputs;
  const probeGit = deps.probeGitState ?? ((root: string): Promise<GitState> => realProbeGitState(root));
  const openLedgerFn = deps.openSessionLedger ?? realOpenSessionLedger;
  const loadRunFn = deps.loadRun ?? loadRun;
  const loadForResumeFn = deps.loadForResume ?? ((runsDir: string, runId: string, opts: { redact: (s: string) => string }) => realLoadForResume(runsDir, runId, opts));
  const writeCredentialsFn = deps.writeCredentials ?? realWriteCredentials;
  const writeConfigValueFn = deps.writeConfigValue ?? realWriteConfigValue;
  const verifyKeysFn = deps.verifyKeys ?? ((input: VerifyInput): Promise<VerifyResult[]> => realVerifyKeys(input));
  const createSandboxFn = deps.createSandbox ?? realCreateSandbox;
  const exportSessionFn = deps.exportSession ?? realExportSession;
  const logoutFn = deps.commandLogout ?? realCommandLogout;
  const copyFn = deps.copy ?? copyRedacted;

  // --- state ---------------------------------------------------------------------------------
  let config: ResolvedConfigWithDiagnostics | null = null;
  let log: Log = deps.log ?? nullLog();
  let uiConfig: UiConfig | null = null;
  let baseMode: EngineMode = modeFromParsedFlags(flags);
  let history: FileHistoryStore | null = null;
  let keybindings: KeybindingsLoad | null = null;
  let candidates: Promise<readonly Candidate[]> = Promise.resolve([]);
  let index: SessionRow[] = [];
  let gitAtStart: GitState | null = null;
  let instructions: EngineOptions['instructions'] | null = null;
  let trustDecision: TrustDecision | null = null;
  let sessionId: string | null = null;
  let sessionStartAnnounced = false;
  let runs: RunRecord[] = [];
  let sessionMeter: SpendMeter = createSpendMeter(Number.POSITIVE_INFINITY);
  let sessionCapUsd = Number.POSITIVE_INFINITY;
  let runCapUsd = 2;
  let phase: KeyRunPhase = 'none';
  let engine: Engine | null = null;
  let current: RunRecord | null = null;
  let endEvent: RunEndEvent | null = null;
  let lastResult: RunResult | null = null;
  const pending: PendingSettings = {};
  let title: string | null = null;
  let undoNotes: string[] = [];
  let undoLog: UndoLogEntry[] = [];
  let rewindSeed: { step: number; planAfter: PlanSnapshot | null } | null = null;
  let lastStatus: EngineStatus | null = null;
  let decisions: Decision[] = [];
  let lastPlan: Plan | null = null;
  const errors: string[] = [];
  let lastItemText: string | null = null;
  let lastProposalText: string | null = null;
  let signalExit: SignalName | null = null;
  /** the code a leave request asked for while a run was live; resolved through `leaveExitCode` at run:end (§13.5) */
  let exitAfterRunEnd: number | null = null;
  let exiting = false;
  /** §9.4: `/budget session-spend-cap` was issued for this session — the first run must not rebuild the root meter from the config */
  let sessionCapExplicit = false;
  /** index `budget` lines issued before the session had an id (§8.2: written with the first run's session id) */
  let deferredBudgetLines: { t: string; from: string; to: string }[] = [];
  /** §12.4: the exclusive command in flight (`EXCLUSIVE_COMMANDS`) */
  let busyCommand: string | null = null;
  /** §8.7: `/theme` outlives every re-resolution of the config in this session */
  let themeOverride: UiConfig['theme'] | null = null;
  /** §13.6: the per-run log while a run is live, and the session log it replaced */
  let runLog: Log | null = null;
  /** TUI-DESIGN-3 §0.1 (D-Q): the read-only-config-dir warning of the default-mode item is logged once per process */
  let seenWriteWarned = false;
  /**
   * §13.6 `EngineOptions.log`: the engine is created before its run dir exists, so it gets a handle that follows the
   * controller's current log — the session log until `retargetLogToRun` swaps in `<runDir>/jevcode.log`, that file for the
   * run, the session log again after `run:end`. Every method reads `log` at call time.
   */
  const engineLog: Log = {
    get level() {
      return log.level;
    },
    get file() {
      return log.file;
    },
    get fellBack() {
      return log.fellBack;
    },
    error: (m) => log.error(m),
    warn: (m) => log.warn(m),
    info: (m) => log.info(m),
    debug: (m) => log.debug(m),
    trace: (m) => log.trace(m),
    enabled: (l) => log.enabled(l),
    key: (kind, len, masked) => log.key(kind, len, masked),
    paste: (len) => log.paste(len),
    flush: () => log.flush(),
    // the engine never owns the file: close is the controller's (`restoreSessionLog`)
    close: () => log.flush(),
  };
  let sessionLog: Log | null = null;
  /** §13.6: lines for the process streams that wait for the unmount (never stdout/stderr while Ink is mounted) */
  const deferredOutput: { stream: 'stdout' | 'stderr'; text: string }[] = [];
  let resolveDone: ((code: number) => void) | null = null;
  const done = new Promise<number>((r) => {
    resolveDone = r;
  });
  let secretSeq = 0;
  let pendingBlocking: { req: BlockingRequest; resolve: (a: BlockingAnswer) => void } | null = null;
  let runEndWaiters: (() => void)[] = [];
  let startingSteers: string[] = [];
  let firstFrameMs: number | null = null;
  /**
   * TUI-DESIGN-5 §2.14 / §1.4 promise 1: the coordination half. Both stay null until `startup()` has awaited
   * `renderer.firstFrame()`, so every §2 surface renders its own empty state before then — never a spinner.
   */
  let sessionLedger: SessionLedger | null = null;
  let publisher: Publisher | null = null;
  /**
   * TUI-DESIGN-5 §2.10 / §12.1, gap 1: WHY there is no ledger, when there is none. `null` = coordination is on
   * (the ledger is simply not open yet, §1.4 promise 1); `'disabled'` / `'unwritable'` are the two real causes,
   * and `/who`, `/peers` and the chat `peers` fact all say which rather than repeating "not in this build" at a
   * user whose ledger would open fine. Resolved once, after `renderer.firstFrame()`, never before it.
   */
  let coordinationOff: CoordinationOffReason | null = null;
  let coordinationPreflight: Promise<CoordinationOffReason | null> | null = null;
  /** §15.2: the fold subscription of the ONE handle — dropped in the same `finally` that stops the writer. */
  let coordUnsubscribe: (() => void) | null = null;
  /** §2.4: armed while this session is alone, so the peer-arrival notice fires on the edge and never per beat. */
  let peerNoticeArmed = true;
  /** resolves when startup finished (or failed): a line typed into the readline composer before resolveConfig waits here instead of failing */
  let startupSettled: (() => void) | null = null;
  const startupDone = new Promise<void>((r) => {
    startupSettled = r;
  });
  let deciderModelConfigured: string | null = null;
  let workspaceRoot = cwd;
  let diffSeq = 0;
  // --- TUI-DESIGN-2 §3 conversational intake state ---------------------------------------------
  /** §3.9: the turns of this session's chat (≤ 200; the last 6 go to Jev) */
  const ledger = createChatLedger();
  /** §3.8 `chatSignal()`: one AbortController per submission — Ctrl-C ×1 while thinking, /exit, SIGINT/SIGTERM abort it */
  let chatAbort: AbortController | null = null;
  /** §3.1 rows 10–11: a chat request is in flight (`⠹ thinking` · `looking` · `replying`) */
  let thinkingPhase: ThinkingPhase | null = null;
  /** §3.11: the decision rows of the last ≤ 3 intakes (`s0 intake` rows of the panel) */
  let chatIntakes: readonly (readonly Decision[])[] = [];
  /** the last `ambiguous` reading, offered as `do it` — the next message either accepts it or drops it */
  let pendingOffer: { text: string; intake: IntakeResult } | null = null;
  /** §3.9: the session-cap thresholds chat spend already announced (once each, like the engine's) */
  const chatThresholdsSeen = new Set<BudgetPct>();
  /** §3.5 `last_tests`: the newest parsed test run of this session's runs */
  let lastTests: LastTestRun | null = null;
  /** the startup listing, resolved (the intake state's `files` bucket and the lookup's candidates) */
  let candidateList: readonly Candidate[] = [];
  /** the decider of the last chat request (`/jev`, the facts' provider line) */
  let lastDecider: Decider | null = null;
  /** the mode of the live run (§1.3 `/mode` shows it while live) */
  let currentRunMode: EngineMode = baseMode;
  /** §3.9: `chat` index lines issued before the session had an id — written with the first run's session id beside `deferredBudgetLines`; a session that never runs drops them */
  let deferredChatLines: { t: string; intake: IntakeKind; route: ChatRoute; costUsd: number; provider: JevProvider | 'generator' }[] = [];
  /** §3.9: the per-session chat spend folded from the index (`seedMeterFromIndex` restores it on /resume, -c, --resume <title>) */
  let indexChat: Map<string, ChatSpendRow> = new Map();
  const trackCandidates = (p: Promise<readonly Candidate[]>): Promise<readonly Candidate[]> => {
    void p.then(
      (l) => {
        candidateList = l;
      },
      () => undefined,
    );
    return p;
  };

  const columns = (): number => prompter?.columns?.() ?? (typeof o.stdout.columns === 'number' && o.stdout.columns > 0 ? o.stdout.columns : 80);
  /** `JEVCODE_TRACE=<file>`: startup and run-lifecycle checkpoints (never a key or a draft; §10.6) */
  const trace = (msg: string): void => {
    const file = env['JEVCODE_TRACE'];
    if (file === undefined || file === '') return;
    try {
      appendFileSync(file, `${new Date().toISOString()} session.${msg}\n`);
    } catch {
      /* trace only */
    }
  };
  const redact = (s: string): string => (config ? config.redact(s) : patternRedact(s));
  const live = (): boolean => phase !== 'none';
  const ranBefore = (): boolean => runs.some((r) => r.endedAt !== null);
  const sessionTotal = (): number => sessionMeter.snapshot().totalUsd;
  const sessionCapOf = (): number => sessionMeter.snapshot().capUsd;

  // --- optional renderer hooks beyond the §15 contract (O9's TuiRenderer: session spend, git dirs, title) -----------
  type RendererExtras = Renderer & {
    setSessionSpend?(session: { totalUsd: number; capUsd: number } | null): void;
    setGitDirs?(dirs: { gitDir: string | null; commonDir: string | null }): void;
    setTitle?(title: string | null): void;
    /** O9's reducer channel (`UiAction`): `thresholds`, `toast`; TUI-DESIGN-2 §6 item 15: `thinking`, `chat-decisions`, `mode` */
    dispatch?(action: UiAction | ChatUiAction): void;
  };
  const extras = renderer as RendererExtras;
  /** §9.6 / §7.4: the live root meter — `setCap` mutates it, so the cap read here is always the current one (`/budget session-spend-cap`) */
  function pushSessionSpend(): void {
    try {
      const snap = sessionMeter.snapshot();
      extras.setSessionSpend?.({ totalUsd: snap.totalUsd, capUsd: snap.capUsd });
    } catch {
      /* the renderer is gone */
    }
  }
  /** §7.1 / §15 item 20 `thresholds`: the decision rows' `!` near-threshold marker and `consumedBy` follow the resolved `--complete-threshold` / `--impossible-threshold` (after resolveConfig, and per run from the limits it starts with) */
  function pushThresholds(limits: Pick<RunLimits, 'completeThreshold' | 'impossibleThreshold'>): void {
    try {
      extras.dispatch?.({ type: 'thresholds', complete: limits.completeThreshold, impossible: limits.impossibleThreshold });
    } catch {
      /* the renderer is gone */
    }
  }
  let lastTrustInputs: TrustInputs | null = null;

  // --- renderer-originated lines (§15.1) ------------------------------------------------------
  function notifyLocal(text: string, opts: NoteOptions = {}): void {
    const r = renderer as Renderer & { notify?: Renderer['notify'] };
    if (typeof r.notify === 'function') {
      r.notify(text, {
        ...(opts.level ? { level: opts.level } : {}),
        ...(opts.detail ? { detail: opts.detail } : {}),
        ...(opts.label ? { label: opts.label } : {}),
        // contract 1.7 item 1 (§3.1.6): the pre-split body WITH its colour role per row — the TUI paints them,
        // `--plain` / `--json` keep using `detail`, which is why both travel together
        ...(opts.detailRows ? { detailRows: opts.detailRows } : {}),
        ...(opts.detailKind ? { detailKind: opts.detailKind } : {}),
      });
    } else log.info(`[idle item] ${opts.label ?? '[ui]'} ${text}`);
  }

  /**
   * §15.1: `engine.annotate()` while a run is live, else a local item (+ the `--json` `ui` line, written by the json
   * renderer's notify). Returns true when the engine took the line: it then rides the engine's transcript **and** its
   * `EngineOptions.log` (§13.6, `notice ui`), so a caller that also logs must not write the line a second time.
   */
  function note(text: string, opts: NoteOptions = {}): boolean {
    const e = engine;
    if (e !== null && live()) {
      try {
        if (e.annotate(text, opts)) return true;
      } catch (err) {
        log.warn(`annotate failed: ${describe(err)}`);
      }
    }
    notifyLocal(text, opts);
    return false;
  }

  /** TUI-DESIGN-4 §3.1.2: the block body width — the RUNG's body width at the current geometry, clamped to [1, 160]. */
  function bodyWidth(): number {
    return blockWidth(columns());
  }

  /** the session's glyph set (`--ascii` twins); every block row is rendered through it. */
  function glyphs(): GlyphSet {
    return o.launch.ascii ? GLYPHS.ascii : GLYPHS.unicode;
  }

  /**
   * §12.1 S1–S5's **SR** column (§14.2 #60, §7 row 82). `glyphs()` only knows the two visual twins, so the
   * screen-reader set had no sink at all and `whoSentence` had zero callers; `/who` is the one surface round 5
   * gives a spoken form of its own, and this is where it is chosen.
   */
  function whoGlyphSet(): GlyphSet {
    return glyphSet({ ascii: o.launch.ascii, screenReader: o.launch.screenReader });
  }

  /**
   * TUI-DESIGN-4 §3.1 (D-U): the ONE command-output grammar. `rows` are `BlockRow`s; `renderBlock` turns them into
   * the rendered row texts ONCE, at `blockWidth(columns())`, and both renderers walk the same list — the TUI as one
   * labelled item with the rows as its detail body, the line renderers as one `[ui] <row>` per row (today's
   * behaviour, `session.ts:1364-1371`, which is also what keeps `--plain`'s stdout and its `transcript.log` equal,
   * §14.1 row 6). While a run is live `Engine.annotateBlock` (contract 1.7 item 2, D-W) writes head + every row to
   * `transcript.log`; until `src/loop/engine.ts` implements it (S6, W2) the call falls back to today's single
   * `annotate(head)`, which is exactly today's behaviour.
   */
  function block(head: string, rows: readonly BlockRow[], opts: BlockOptions = {}): void {
    const { max, moreFooter, tableCols, protectTail, syntax, detailKind, ...noteOpts } = opts;
    const rendered = renderBlock(rows, bodyWidth(), glyphs(), {
      ...(max !== undefined ? { max } : {}),
      ...(moreFooter !== undefined ? { moreFooter } : {}),
      // §3.3: a builder that sized its own columns (`/config`) pins them, so the TUI block and `jevcode config`
      // draw ONE geometry for one record — re-deriving them from the shown rows made the two disagree
      ...(tableCols !== undefined ? { tableCols } : {}),
      ...(protectTail !== undefined ? { protectTail } : {}),
      ...(syntax !== undefined ? { syntax } : {}),
    });
    const lines = rendered.map((r) => r.text);
    // D-W, §3.5 item 2: while a run is LIVE the block goes through the engine in BOTH renderers — one `notice ui`
    // per row, head first — so the same command writes the same rows to `transcript.log` from the TUI as from
    // `--plain`. Measured today: 1 row from the TUI and 7 from `--plain`, and the logged row did not name the
    // command. `annotateBlock` returns false exactly when `annotate` does (no run live), and we fall through.
    const e = engine;
    if (e !== null && live() && typeof e.annotateBlock === 'function') {
      try {
        // §3.5 edge 2: `transcript.log` is a support artefact, not a pager mirror
        const capped = lines.length > BLOCK_LOG_MAX ? [...lines.slice(0, BLOCK_LOG_MAX), `${glyphs().ellipsis} +${lines.length - BLOCK_LOG_MAX} more rows`] : lines;
        if (e.annotateBlock(head, capped, noteOpts)) return;
      } catch (err) {
        log.warn(`annotateBlock failed: ${describe(err)}`);
      }
    }
    if (o.rendererKind === 'tui') {
      // idle: ONE labelled item whose detail is the pre-rendered body (§3.1.1's frame). §3.1.6 / contract 1.7
      // item 1: the rows travel WITH their colour roles as `detailRows`; `detail` stays for `--plain`, `--json`
      // and `clipDetail`, so nothing that reads the old member breaks.
      note(head, {
        ...noteOpts,
        ...(lines.length > 0 ? { detail: lines.join('\n'), detailRows: rendered } : {}),
        ...(detailKind !== undefined ? { detailKind } : {}),
      });
      return;
    }
    // §3.5 item 1: the line renderers walk the SAME rendered list through `Renderer.blockLines` (contract 1.7
    // item 3), whose default implementation is today's per-line `note` — so no renderer breaks and `--plain`'s
    // stdout and its `transcript.log` cannot disagree (§14.1 row 6).
    note(head, noteOpts);
    const r = renderer as Renderer & { blockLines?: Renderer['blockLines'] };
    if (typeof r.blockLines === 'function') r.blockLines(lines, noteOpts);
    else for (const l of lines) note(l, noteOpts);
  }

  /** TUI-DESIGN-4 §3.3: a block whose body is an already-built line list (a pane builder, `/help`, `/why`). */
  function textBlock(head: string, lines: readonly string[], opts: BlockOptions = {}): void {
    block(head, textRows(lines), opts);
  }

  function uiError(text: string): void {
    note(text.startsWith('error:') ? text : `error: ${text}`, { label: '[ui]', level: 'error' });
  }

  function warnLine(text: string): void {
    // §9.5 (A136): `jevcode: <warning>` on stderr for the line renderers (a --plain TTY, a pipe, --json), one `warning: …` item in the TUI
    if (o.rendererKind !== 'tui') stderr.write(`jevcode: ${text}\n`);
    // §13.6: while a run is live the engine's annotate() already writes the line to the run log (`notice ui`) — one line, not two
    else if (note(`warning: ${text}`, { level: 'warn' })) return;
    log.warn(text);
  }

  /** §13.6: a line for a process stream — written now by the line renderers, after the unmount while Ink is mounted */
  function emitAfterUnmount(stream: 'stdout' | 'stderr', text: string): void {
    if (o.rendererKind === 'tui') deferredOutput.push({ stream, text });
    else (stream === 'stdout' ? o.stdout : stderr).write(text);
  }

  // --- index bookkeeping (§8.2) ----------------------------------------------------------------
  function indexLine(line: IndexLine): void {
    if (!config) return;
    appendIndex(indexPath, line, config.redact, { warn: (m) => log.warn(m) });
  }
  async function refold(): Promise<void> {
    const r = await readIndexFn(indexPath);
    index = r.sessions;
    indexChat = r.chat;
    if (r.error) log.warn(r.error);
  }
  function sessionRows(): SessionRow[] {
    return index;
  }

  // --- exit paths (§13.5) ----------------------------------------------------------------------
  /**
   * TUI-DESIGN-4 §7.2 item 4 (P-D2): the run-directory artefacts that ACTUALLY exist, so the epilogue never
   * advertises a file that is not there. A directory that has vanished (deleted or chmod-ed mid-run — measured
   * silent today: `complete`, exit 0, and a `resume` row for a directory that is gone) replaces the whole row.
   * Sync and non-throwing: this runs on the exit path, after the renderer is down.
   */
  function runDirFiles(dir: string | null): { files?: readonly string[]; gone?: boolean } {
    if (dir === null) return {};
    try {
      if (!existsSync(dir)) return { gone: true };
      const files = EPILOGUE_ARTEFACTS.filter((f) => existsSync(join(dir, f)));
      // §7.2 item 4 / §12: a directory that answers `existsSync` but holds NOTHING the run wrote is the
      // `rundir:chmod` fault of §7.11 — chmod 000 answers true for the dir and false for every file inside it.
      // `gone` is the row §12 declares for it; there is no `(empty)` sentence anywhere in §12.
      if (files.length === 0) return { gone: true };
      // the directory may still be unwritable (the run's later writes failed): a write probe says so
      try {
        accessSync(dir, fsConstants.W_OK);
      } catch {
        return { gone: true };
      }
      return { files };
    } catch {
      return { gone: true };
    }
  }

  function context(): EpilogueContext {
    const r = current ?? runs[runs.length - 1] ?? null;
    // an external signal with no (finished) run: the first line reads `stopped — signal: <name> (exit 130|143)`
    const stopReason = r?.stopReason ?? (signalExit !== null ? 'signal' : undefined);
    const exitCode = r?.exitCode ?? (signalExit !== null ? exitCodeFor('signal', undefined, false, signalExit) : undefined);
    return {
      runId: r?.runId ?? null,
      runDir: r?.runDir ?? null,
      resumable: r !== null && epilogueResumable(r),
      ...(stopReason !== undefined ? { stopReason } : {}),
      ...(exitCode !== undefined && exitCode !== null ? { exitCode } : {}),
      ...(signalExit ? { signal: signalExit } : {}),
      degraded: r?.degraded ?? false,
      home,
      ...runDirFiles(r?.runDir ?? null),
    };
  }

  const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms).unref());

  /** the one exit: json session:end, unmount, restore, (one-shot / signal) epilogue on stderr, resolve run() */
  function finishSession(code: number, why: 'exit' | 'error' | 'run-end'): void {
    if (exiting) return;
    exiting = true;
    // TUI-DESIGN-2 §3.8 `chatSignal()`: /exit and a signal abort a chat request in flight
    abortChat();
    // §13.5 / F3: every pending prompt settles with its safe default now, so no controller await outlives the renderer
    try {
      prompter?.cancelAll?.();
    } catch (e) {
      log.warn(`cancelAll failed: ${describe(e)}`);
    }
    const runsCount = runs.length;
    const run = async (): Promise<void> => {
      try {
        json?.sessionEnd({ reason: why === 'error' ? 'error' : 'exit', runs: runsCount, exitCode: code }, { runId: current?.runId ?? null, sessionId });
      } catch {
        /* the stream is gone */
      }
      // §3.3: the item the renderer appended in the tick of the exit request (`[ui] exited on Ctrl-C ×2`) commits before the unmount
      try {
        await Promise.race([renderer.firstFrame(), sleep(FINAL_FLUSH_BOUND_MS)]);
      } catch {
        /* the renderer is gone */
      }
      try {
        await Promise.race([renderer.unmount(), sleep(2000)]);
      } catch {
        /* nothing to unmount */
      }
      try {
        o.restoreTerminal();
      } catch {
        /* not a tty */
      }
      // §13.6: the lines that waited for the unmount (a TUI never writes the process streams while Ink is mounted)
      for (const d of deferredOutput.splice(0)) {
        try {
          (d.stream === 'stdout' ? o.stdout : stderr).write(d.text);
        } catch {
          /* EPIPE */
        }
      }
      // §13.5: the epilogue reaches stderr in one-shot mode, and in session mode only when the process exits at a run's end
      if ((o.mode === 'one-shot' || why === 'run-end') && (lastResult !== null || signalExit !== null)) {
        const err = lastResult?.error ?? null;
        writeStderrSync(`${epilogueLines(err, context(), redact).join('\n')}\n`);
      }
      // TUI-DESIGN-5 §2.14 row 1: the heartbeat writer stops on the one exit path, so a clean exit leaves no beat
      await stopPublishing();
      restoreSessionLog();
      log.flush();
      resolveDone?.(code);
    };
    void run();
  }

  /**
   * §1 / §13.5: the code a leave request (`/exit`, Ctrl-C ×2 idle, Ctrl-D ×2, the `[y]` of the exit confirm) resolves to — 0,
   * or the last run's code under `--exit-code=last-run`; a non-zero request (the wizard's exit 2) is kept as it is.
   */
  function leaveExitCode(requested: number): number {
    if (requested !== 0) return requested;
    if (uiConfig?.exitCode === 'last-run') return runs[runs.length - 1]?.exitCode ?? 0;
    return 0;
  }

  /** TUI-DESIGN §13.4: `EngineOptions.exit` — restore, epilogue, exit; the engine's own forced paths go through it (`lastResult` is null while a run is live, so the epilogue names this run, never the previous one's error) */
  const engineExit = (code: number): never => {
    try {
      o.restoreTerminal();
    } catch {
      /* not a tty */
    }
    writeStderrSync(`${epilogueLines(lastResult?.error ?? null, { ...context(), exitCode: code }, redact).join('\n')}\n`);
    return o.exit(code);
  };

  // --- engine event bookkeeping ---------------------------------------------------------------
  function onEvent(e: EngineEvent): void {
    const items = itemsFromEvent(e, 0);
    if (items.length > 0) lastItemText = formatTranscriptItem(items[items.length - 1]!);
    switch (e.type) {
      case 'run:start':
        if (current) current.runId = e.runId;
        break;
      case 'run:ready':
        phase = phase === 'starting' ? 'live' : phase;
        if (e.sessionId !== undefined && sessionId === null) sessionId = e.sessionId;
        break;
      case 'status':
        lastStatus = e.status;
        break;
      case 'decision':
        decisions.push(e.decision);
        keepLast(decisions, DECISIONS_KEPT_FOR_COMMANDS);
        break;
      case 'plan':
        lastPlan = e.plan;
        break;
      case 'proposal':
        lastProposalText = e.proposal.rawText;
        break;
      case 'outcome':
        if (e.outcome.status === 'executed' && current) {
          for (const f of e.outcome.changedFiles) if (!current.changedFiles.includes(f)) current.changedFiles.push(f);
          if (e.outcome.changedFiles.length > 0 && !current.changedSteps.includes(e.step)) current.changedSteps.push(e.step);
        }
        break;
      case 'step:end':
        if (current) {
          current.records.push(e.record);
          current.steps = Math.max(current.steps, e.record.step);
        }
        // TUI-DESIGN-2 §3.5 `last_tests`: the newest parsed test run of the session
        if (e.record.judge?.tests && e.record.judge.tests.source === 'parsed') {
          const t = e.record.judge.tests;
          const action = e.record.proposal?.action;
          lastTests = { step: e.record.step, command: action?.kind === 'run' ? action.command : '', passed: t.passed, failed: t.failed, errors: t.errors, allPassed: t.allPassed };
        }
        break;
      case 'steer:queued':
        if (current && sessionId) indexLine({ v: 1, t: nowIso(), kind: 'steer', sessionId, runId: current.runId, step: e.step, text60: e.text });
        break;
      case 'pause:requested':
        phase = 'pausing';
        if (current && sessionId) indexLine({ v: 1, t: nowIso(), kind: 'pause', sessionId, runId: current.runId, step: e.step });
        break;
      case 'error':
        errors.push(`error ${e.error.code}: ${e.error.message}`);
        keepLast(errors, ERRORS_KEPT);
        break;
      case 'notice':
        if (e.level !== 'info') {
          errors.push(`${e.level}: ${e.text}`);
          keepLast(errors, ERRORS_KEPT);
        }
        break;
      case 'retry:settled':
        if (!e.ok) {
          errors.push(`warning: ${e.side} retry chain failed after ${e.attempts} attempts`);
          keepLast(errors, ERRORS_KEPT);
        }
        break;
      case 'blocking:resolved':
        if (pendingBlocking && pendingBlocking.req.id === e.id) pendingBlocking = null;
        break;
      case 'run:end':
        endEvent = e;
        break;
      default:
        break;
    }
  }

  // --- the blocker (§13.3) ---------------------------------------------------------------------
  const blocker = (req: BlockingRequest): Promise<BlockingAnswer> =>
    new Promise<BlockingAnswer>((resolve) => {
      pendingBlocking = { req, resolve };
      const answer = (a: BlockingAnswer): void => {
        if (pendingBlocking?.req.id !== req.id) return;
        pendingBlocking = null;
        if (a === 'login') {
          // §13.3: `login` → the controller opens /login, then answers retry (a key was saved) or stop; a closed or cancelled wizard is stop
          void runLogin('rejected').then(
            (saved) => resolve(saved ? 'retry' : 'stop'),
            () => resolve('stop'),
          );
          return;
        }
        resolve(a);
      };
      if (prompter?.blocking) prompter.blocking(req).then(answer, () => answer('stop'));
      else if (!o.interactive) answer('stop');
      // interactive without a prompt channel: the pane's keys arrive through host.answerBlocking (or Ctrl-C = [q])
    });

  // --- credentials (§11.1, §11.2) --------------------------------------------------------------
  async function persistCredentials(patch: CredentialsPatch, source: 'wizard' | 'login', opts: { reusedFrom?: FoundSource } = {}): Promise<{ ok: boolean; items: string[]; error?: string }> {
    if (!config) return { ok: false, items: [], error: 'configuration not ready' };
    const items: string[] = [];
    const setup = (text: string): void => {
      items.push(text);
      note(text, { label: '[setup]' });
    };
    // §11.1 save: addSecret FIRST, then the items, then the atomic 0600 write
    if (patch.apiKey !== undefined) {
      config.addSecret('wizard:generator.apiKey', patch.apiKey);
      // TUI-DESIGN-3 §1.4.2 (edges 11, 17): the reuse Enter copied a found Jev key — `reused from`, never `entered`
      setup(opts.reusedFrom !== undefined ? keyReusedText(opts.reusedFrom, fingerprint(patch.apiKey)) : keyEnteredText('generator', fingerprint(patch.apiKey), source));
    }
    if (patch.jevApiKey !== undefined) {
      config.addSecret('wizard:decider.apiKey', patch.jevApiKey);
      if (patch.jevApiKey !== patch.apiKey) setup(keyEnteredText('jev', fingerprint(patch.jevApiKey), source));
    }
    try {
      const r = await writeCredentialsFn(patch, { env, home, cwd, configFlag: flags.config ?? null }, source);
      for (const item of r.items) setup(item);
      for (const w of r.warnings) warnLine(w);
    } catch (e) {
      uiError(`/login — ${describe(e)}`);
      return { ok: false, items, error: describe(e) };
    }
    await reresolve();
    return { ok: true, items };
  }

  /** resolveConfig again after a save (§11.1 "→ resolveConfig again") */
  async function reresolve(): Promise<void> {
    try {
      config = await resolveConfig({ ...flags, ...pendingFlagOverrides() }, env, cwd, { homedir: home });
      applyConfig();
    } catch (e) {
      uiError(`config: ${describe(e)}`);
    }
  }

  function pendingFlagOverrides(): Partial<ParsedFlags> {
    return {
      ...(pending.model !== undefined ? { model: pending.model } : {}),
      ...(pending.provider !== undefined ? { provider: pending.provider } : {}),
      ...(pending.mode !== undefined ? { mode: pending.mode } : {}),
    };
  }

  function applyConfig(): void {
    if (!config) return;
    workspaceRoot = config.workspace;
    // TUI-DESIGN-3 §1.2 (R3 F1/F2): flag > JEVCODE_MODE > ./.env > <JEVCODE_EXTRA_ENV_FILE> > file `mode` > DEFAULT_MODE (resolve.ts). A pending
    // `/mode` re-enters the flag layer through pendingFlagOverrides(), so after a reresolve() config.mode equals the PENDING mode: the base
    // moves only while nothing is pending, and the badge action carries the pending mode separately (` · next run` survives a wizard save)
    if (pending.mode === undefined) baseMode = config.mode;
    try {
      extras.dispatch?.({ type: 'mode', mode: live() && current !== null ? currentRunMode : baseMode, pending: pending.mode ?? null });
    } catch {
      /* the renderer is gone */
    }
    // §8.7: a `/theme` chosen in this session outlives every re-resolution (/login, /logout, a pending /model|/provider|/mode)
    uiConfig = { ...config.ui(o.launch), ...(themeOverride !== null ? { theme: themeOverride } : {}) };
    renderer.setUi?.(uiConfig);
    runCapUsd = config.limits().spendCapUsd;
    pushThresholds(config.limits());
  }

  /**
   * the wizard (start, `/login`, a rejected key, or TUI-DESIGN-2 §1.3 `/mode <m>` without the keys `m` needs); true when a key was
   * saved. `target` is the mode the keys are for (§1.4: `missing = config.missingSecrets(mode)` for THAT mode; default: the next run's).
   */
  async function runLogin(reason: WizardReason, target?: EngineMode): Promise<boolean> {
    if (!config) return false;
    const mode = target ?? pending.mode ?? baseMode;
    const missing = reason === 'missing' || reason === 'mode' ? config.missingSecrets(mode) : (['generator.apiKey', 'decider.apiKey'] as const).filter((n) => mode !== 'jev-only' || n !== 'generator.apiKey');
    if (missing.length === 0) {
      note('every key resolves already; use /logout to remove one', { label: '[setup]' });
      return false;
    }
    const provider = providerOfConfig(config);
    if (!prompter?.wizard) {
      textBlock('no key found — set them in the environment or run jevcode login:', fixBlockLines(mode, provider), { label: '[setup]', level: 'warn' });
      return false;
    }
    // TUI-DESIGN-3 §1.4.3: `found` from the RESOLVED entries, whatever the layer (a round-2 user's saved Jev key counts); only for a startup wizard
    const f = reason === 'missing' ? foundKey(config) : null;
    const jevProvider = resolvedJevProviderOf(config);
    const outcome = await prompter.wizard(missing, {
      provider,
      reason,
      mode,
      found: f?.found ?? null,
      ...(f?.foundSource !== undefined ? { foundSource: f.foundSource } : {}),
      ...(f?.foundReusable !== undefined ? { foundReusable: f.foundReusable } : {}),
      jevProvider,
    });
    if (outcome.kind === 'cancelled') return false;
    // TUI-DESIGN-3 §1.4.3: option `3 Jev only` — persisted at startup (one `writeConfigValue`, reresolve, `modeSavedItem`), pended from /login; no key saved
    if (outcome.kind === 'mode') {
      await applyModeChoice(outcome.mode, outcome.persist);
      return false;
    }
    // 'persisted': the Ink wizard's host already saved through persistCredentials (tui-prompter.ts)
    const saved = outcome.kind === 'persisted' ? true : (await persistCredentials(outcome.patch, reason === 'missing' ? 'wizard' : 'login')).ok;
    if (saved && outcome.kind === 'saved' && outcome.mode !== undefined) await applyModeChoice(outcome.mode.mode, outcome.mode.persist);
    // §1.3: the `mode` wizard's own item is MODE_SET_ITEM (the caller's); the `/login` toast stays for `login` / `rejected`
    if (saved && reason !== 'missing' && reason !== 'mode') note(LOGIN_SAVED_TOAST, { label: '[setup]' });
    // TUI-DESIGN-3 §1.7: a wizard save on a first run names the caps of the mode it saved for (a keyed start prints `defaultModeItem` instead, D-Q)
    if (saved && reason === 'missing' && config) {
      const m = pending.mode ?? baseMode;
      note(capsItem(m, config.limits().spendCapUsd, config.sessionSpendCap(m).value), { label: '[setup]' });
    }
    return saved;
  }

  /**
   * Round-5 item 4: the resolved generator provider as one of the SEVEN ids, for the error that names its key
   * variable. `providerOfConfig` below narrows to the wizard's two and answers `null` for the other five, which is
   * right for the wizard and wrong for `missingGeneratorOnly` — `--provider anthropic` must not be told to export
   * `OPENROUTER_API_KEY`.
   */
  function providerIdOfConfig(cfg: ResolvedConfigWithDiagnostics): ProviderId | null {
    const v = cfg.entries.get('generator.provider')?.value.trim().toLowerCase();
    return v !== undefined && isProviderId(v) ? v : null;
  }
  /** the resolved generator provider (`anthropic` | `openrouter`), or null when the entry is unknown */
  function providerOfConfig(cfg: ResolvedConfigWithDiagnostics): WizardProvider | null {
    const v = cfg.entries.get('generator.provider')?.value;
    return v === 'anthropic' || v === 'openrouter' ? v : null;
  }
  /** the resolved Jev provider when a layer or rule chose it (rule 2e's `default` is nothing) */
  function resolvedJevProviderOf(cfg: ResolvedConfigWithDiagnostics): JevProvider | null {
    const r = cfg.entries.get('decider.provider');
    if (!r || r.source === 'default') return null;
    return r.value === 'typesafe' || r.value === 'openrouter' ? r.value : null;
  }
  /** `env` / `dotenv` / `file` from a resolved entry's source (`flag` counts as env: a process-level value) */
  function layerOf(source: string): FoundSource {
    return source.startsWith('file:') ? 'file' : source.startsWith('dotenv:') ? 'dotenv' : 'env';
  }
  /**
   * TUI-DESIGN-3 §1.4.3: what already resolves — `decider.apiKey` present → `typesafe` (the resolved Jev provider is typesafe) or `jev`, with the
   * entry's layer; no Jev key but `ANTHROPIC_API_KEY` in the env or a dotenv → `anthropic`; else null. `foundReusable`: the Jev value is an
   * OpenRouter key (edges 11, 17). A source, never a value.
   */
  function foundKey(cfg: ResolvedConfigWithDiagnostics): { found: FoundKey; foundSource?: FoundSource; foundReusable?: boolean } {
    const jev = cfg.entries.get('decider.apiKey');
    if (jev && jev.value.trim() !== '') {
      const found: FoundKey = resolvedJevProviderOf(cfg) === 'typesafe' ? 'typesafe' : 'jev';
      return { found, foundSource: layerOf(jev.source), foundReusable: found === 'jev' && jev.value.trim().startsWith('sk-or-') };
    }
    if ((env['ANTHROPIC_API_KEY'] ?? '').trim() !== '') return { found: 'anthropic', foundSource: 'env' };
    for (const d of cfg.dotenvFiles) {
      // the dotenv layer already resolved through the redactor's secret list; `readDotenv` again would be a second read of a secret file — the
      // consulted paths suffice for the title (`(dotenv)` names the layer, never the value)
      void d;
    }
    return { found: null };
  }

  /**
   * TUI-DESIGN-3 §1.4.3 (D-J ext., §0.1): option `3 Jev only` — a startup wizard PERSISTS `mode` (one `writeConfigValue`, then reresolve so
   * `applyConfig` moves `baseMode` with nothing pending: badge `jev-only`, no ` · next run`) and prints `modeSavedItem`; a `/login` wizard pends it
   * (`pending.mode` + the badge dispatch + `modeSetItem`). Both leave no key saved.
   */
  async function applyModeChoice(mode: EngineMode, persist: boolean): Promise<void> {
    if (persist) {
      try {
        const r = await writeConfigValueFn('mode', mode, { env, home, cwd, configFlag: flags.config ?? null });
        await reresolve();
        note(modeSavedItem(mode, r.displayPath), { label: '[setup]' });
        return;
      } catch (e) {
        warnLine(`could not save mode ${mode}: ${describe(e)} — it applies to this session only`);
      }
    }
    pending.mode = mode;
    try {
      extras.dispatch?.({ type: 'mode', mode: live() && current !== null ? currentRunMode : baseMode, pending: mode });
    } catch {
      /* the renderer is gone */
    }
    note(modeSetItem(mode));
  }

  /**
   * TUI-DESIGN-3 §1.5: the Ink wizard's `y` — the resolved keys (after the save) go to `verifyKeys`: one Jev decision, one 1-token completion
   * (when the target mode bills a generator and the provider is openrouter), the key info. The decision's usage lands on the session meter
   * (`meterVerify`), never in the chat ledger. `--mock` never reaches the network (edge 30). `rejected` names the field to return to.
   */
  async function verifyForWizard(input: WizardVerifyInput): Promise<WizardVerifyResult> {
    const cfg = config;
    if (!cfg) return { ok: true, rejected: null, items: [] };
    if (flags.mock) return { ok: true, rejected: null, items: [MOCK_VERIFY_NOTE] };
    const genKey = cfg.entries.get('generator.apiKey')?.value ?? null;
    const jevKey = cfg.entries.get('decider.apiKey')?.value ?? null;
    const jevProvider = input.jevProvider ?? resolvedJevProviderOf(cfg) ?? 'openrouter';
    const provider = input.provider ?? providerOfConfig(cfg) ?? 'openrouter';
    let generatorModel = '';
    try {
      generatorModel = input.mode === 'jev-only' ? '' : cfg.generator().model;
    } catch {
      generatorModel = cfg.entries.get('generator.model')?.value ?? '';
    }
    let jevBaseUrl = JEV_PROVIDERS[jevProvider].baseUrl;
    let jevModel = JEV_PROVIDERS[jevProvider].defaultModel;
    try {
      const d = cfg.decider();
      jevBaseUrl = d.baseUrl;
      jevModel = d.model;
    } catch {
      /* the entries' defaults stand */
    }
    const results = await verifyKeysFn({ provider, jevProvider, generatorKey: input.mode === 'jev-only' ? null : genKey, jevKey, mode: input.mode, generatorModel, jevBaseUrl, jevModel, ...(input.signal ? { signal: input.signal } : {}) });
    for (const r of results) if (r.usage) meterVerify(r.which === 'jev' ? 'jev' : 'generator', r.usage);
    const failed = results.filter((r) => !r.ok);
    const rejected = failed.find((r) => r.reason === 'rejected' || r.reason === undefined);
    return { ok: failed.length === 0, rejected: rejected ? (rejected.which === 'jev' ? 'decider.apiKey' : 'generator.apiKey') : null, items: results.map((r) => r.text) };
  }

  /** §11.2 P43: the shadowing line when env/dotenv and the file disagree */
  async function shadowingLines(): Promise<void> {
    if (!config) return;
    try {
      const target = credentialsPath({ env, home, cwd, configFlag: flags.config ?? null });
      const file = await readCredentialsFile(target.path);
      if (!file.exists) return;
      const g = shadowingLine('generator.apiKey', config.entries.get('generator.apiKey'), providerOfConfig(config) === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY', target.path, file.apiKey, home);
      // TUI-DESIGN-3 §1.8 edge 34: an env TypeSafe key wins over a saved Jev key — the line names the variable that actually won
      const jevR = config.entries.get('decider.apiKey');
      const j = jevR && jevR.source === 'env' && resolvedJevProviderOf(config) === 'typesafe' && file.jevApiKey !== null && file.jevApiKey.trim() !== jevR.value.trim() ? typesafeWinsText() : shadowingLine('decider.apiKey', jevR, 'JEV_API_KEY', target.path, file.jevApiKey, home);
      for (const l of [g, j]) if (l !== null) note(l, { label: '[config]' });
    } catch {
      /* no file */
    }
  }

  // --- trust gate and instruction files (§11.3) -------------------------------------------------
  async function trustGate(reopen = false): Promise<boolean> {
    if (!config) return false;
    const gitRoot = gitAtStart?.topLevel ?? null;
    let loaded;
    try {
      loaded = await loadInstructionsFn(workspaceRoot, gitRoot, home, { env, redact: config.redact });
    } catch (e) {
      log.warn(`instructions: ${describe(e)}`);
      instructions = null;
      return false;
    }
    for (const n of loaded.notices) warnLine(n);
    const project = projectInstructionFile(loaded, env, home);
    const agents = project ? { path: project.path, sha256: project.sha256 } : null;
    const key = trustKey(gitRoot, workspaceRoot);
    const store = createTrust(join(jdir, 'trust.json'));
    await store.load();
    const rec = store.get(key);
    const changed = rec?.agents && agents && rec.agents.sha256 !== agents.sha256 ? { from: rec.agents.sha256.slice(0, 8), to: agents.sha256.slice(0, 8) } : null;
    const inputs = await probeTrust(workspaceRoot, key, project ? { path: project.path, sha256: project.sha256, bytes: project.bytes } : null, project?.name ?? null, changed);
    lastTrustInputs = inputs;
    const canPrompt = prompter?.trust !== undefined;
    const status = reopen && canPrompt ? ({ kind: 'prompt', reason: 'none', changed } as const) : store.evaluate(key, { agents, hasUntrustedInputs: inputs.hasUntrustedInputs, interactive: canPrompt, trustWorkspace: trustWorkspaceFlag(env, flags.trustWorkspace) });
    let decision: TrustDecision;
    if (status.kind === 'trusted') decision = 'trust';
    else if (status.kind === 'untrusted') {
      decision = 'none';
      if (status.via === 'non-interactive' && agents) stderr.write(`jevcode: ${INSTRUCTIONS_NOT_TRUSTED_LINE}\n`);
    } else {
      // TUI-DESIGN-3 §4.4 F17: the `/trust` card (reopen) closes on Esc / Ctrl-C with null → nothing changes, the old decision stands
      const option = prompter?.trust ? await prompter.trust(inputs, { reopen }) : null;
      if (exiting) return false; // F3: the prompt was settled by finishSession — nothing is decided, nothing is stored
      if (reopen && option === null) return false;
      decision = option === null ? 'none' : decisionFromOption(option);
      await store.set(key, decision, agents, nowIso(), home);
    }
    trustDecision = decision;
    instructions = decision === 'none' ? null : { files: loaded.files, text: loaded.text };
    if (decision === 'none') {
      // §11.3 (P38): `3 don't trust` still reads ./.env for keys and says so
      const dotenv = config.dotenvFiles.find((p) => p === join(workspaceRoot, '.env') || p === join(cwd, '.env'));
      if (dotenv !== undefined) note(dotenvSourceText(dotenv), { label: '[config]' });
    }
    return true;
  }

  // --- session meter and follow-up gate (§9.1, §9.3) -----------------------------------------------
  function newSessionMeter(): void {
    if (!config) return;
    const cap = config.sessionSpendCap(pending.mode ?? baseMode);
    sessionCapUsd = cap.value;
    sessionMeter = createSpendMeter(sessionCapUsd);
    sessionCapExplicit = false;
    deferredBudgetLines = [];
    deferredChatLines = [];
  }

  /**
   * §9.1 `/resume` of a run this controller did not run: fold the index excluding the resumed run, add every finished run's cost;
   * TUI-DESIGN-2 §3.9: the session's chat spend (its `chat` index lines: intakes, lookups, LLM turns) comes back with it
   */
  function seedMeterFromIndex(sid: string, excludeRunId: string): void {
    const s = index.find((x) => x.sessionId === sid);
    if (!s) return;
    for (const r of s.runs) {
      if (r.runId === excludeRunId || r.costUsd === null) continue;
      sessionMeter.add('generator', { inputTokens: 0, outputTokens: 0, costUsd: r.costUsd.generator, calls: 0 });
      sessionMeter.add('jev', { inputTokens: 0, outputTokens: 0, costUsd: r.costUsd.jev, calls: 0 });
    }
    const chat = indexChat.get(sid);
    if (chat !== undefined) {
      if (chat.jev > 0) sessionMeter.add('jev', { inputTokens: 0, outputTokens: 0, costUsd: chat.jev, calls: 0 });
      if (chat.generator > 0) sessionMeter.add('generator', { inputTokens: 0, outputTokens: 0, costUsd: chat.generator, calls: 0 });
    }
  }

  // --- the run (§1 loop body) -------------------------------------------------------------------
  interface StartOptions {
    kind: 'prompt' | 'follow-up';
    pinnedFiles: readonly string[];
    secretsAcked: number;
    /** TUI-DESIGN-2 §6 item 13: why the run started (the intake's reading); absent for argv tasks */
    intake?: { kind: IntakeKind; probability: number; requestHash: string };
  }

  /** §9.3: start | confirm (y/r/n) | refuse; the `clamp` for EngineOptions.session */
  async function followUpGate(runCap: number): Promise<{ ok: true; clamp: number | null } | { ok: false }> {
    if (!ranBefore()) return { ok: true, clamp: null };
    const spent = sessionTotal();
    const cap = sessionCapOf();
    const decision = followUpDecision(runCap, cap, spent);
    if (decision === 'start') return { ok: true, clamp: null };
    if (decision === 'refuse') {
      note(sessionCapReachedItem(spent, cap), { level: 'error' });
      json?.sessionRefused({ reason: 'session-cap', spentUsd: spent, capUsd: cap, exitCode: EXIT_CODES.budget }, { runId: null, sessionId });
      return { ok: false };
    }
    const clamped = childCapUsd(runCap, cap, spent);
    if (!prompter?.followUp) return { ok: true, clamp: clamped }; // §9.3: --plain pipe / --json / --no-input clamp silently
    const last = runs.filter((r) => r.endedAt !== null).at(-1);
    const box: FollowUpBoxInput = { runCapUsd: runCap, sessionCapUsd: cap, sessionSpentUsd: spent, runs: runs.filter((r) => r.endedAt !== null).length, lastRunUsd: last ? last.costUsd.generator + last.costUsd.jev : null };
    const a = await prompter.followUp(box);
    if (a === 'y') return { ok: true, clamp: clamped };
    if (a === 'r') note(`type ${raiseSessionCapCommand(cap, runCap)} to raise the session cap, then submit again`);
    return { ok: false };
  }

  function limitsWithPending(base: RunLimits): RunLimits {
    return {
      ...base,
      ...(pending.spendCapUsd !== undefined ? { spendCapUsd: pending.spendCapUsd } : {}),
      ...(pending.maxSteps !== undefined ? { maxSteps: pending.maxSteps } : {}),
      ...(pending.maxWall !== undefined ? { maxWallMs: pending.maxWall.ms } : {}),
      ...(pending.maxReplans !== undefined ? { maxReplans: pending.maxReplans } : {}),
      ...(pending.maxGeneratorTokens !== undefined ? { maxGeneratorTokens: pending.maxGeneratorTokens } : {}),
    };
  }

  /** §8.3: the seed from the session's parent run (seed-source rule), the undo notes and the rewind snapshot */
  async function seedFor(pinnedFiles: readonly string[]): Promise<{ seed: EngineSeed | null; parentRunId: string | null }> {
    if (!config) return { seed: null, parentRunId: null };
    const parents: SeedParent[] = [];
    for (const r of runs) {
      if (r.endedAt === null) continue;
      const loaded = await loadRunFn(config.runsDir, r.runId, config.redact);
      if (loaded) parents.push({ meta: loaded.meta, state: loaded.state });
    }
    if (parents.length === 0 && sessionId !== null) {
      // a session continued with -c / --resume <title>: its runs come from the index
      const s = index.find((x) => x.sessionId === sessionId);
      for (const r of s?.runs ?? []) {
        const loaded = await loadRunFn(config.runsDir, r.runId, config.redact);
        if (loaded) parents.push({ meta: loaded.meta, state: loaded.state });
      }
    }
    const parent = seedSource(parents);
    if (parent === null) return { seed: null, parentRunId: null };
    const seed = buildSeed(parent, { humanNotes: undoNotes, pinnedFiles, ...(rewindSeed ? { rewind: rewindSeed } : {}) });
    const carried = carriedSteers(parent);
    const withLog: EngineSeed = { ...seed, undoLog: [...(seed.undoLog ?? []), ...undoLog].slice(-20), ...(carried > 0 ? { carriedDirectives: carried } : {}) };
    return { seed: withLog, parentRunId: parent.meta.runId };
  }

  async function startRun(text: string, so: StartOptions): Promise<void> {
    if (exiting) return;
    if (live()) {
      uiError('a run is live; Enter steers it (Esc pauses, Esc Esc aborts)');
      return;
    }
    if (!config) {
      uiError('configuration not ready yet');
      return;
    }
    if (pending.model !== undefined || pending.provider !== undefined || pending.mode !== undefined) await reresolve();
    const mode = pending.mode ?? baseMode;
    if (config.missingSecrets(mode).length > 0) {
      const saved = await runLogin('missing', mode);
      if (!saved && config.missingSecrets(mode).length > 0) {
        uiError(`missing ${config.missingSecrets(mode).join(', ')}: run jevcode login or set the environment variable`);
        return;
      }
    }
    // TUI-DESIGN-2 §3.8 (finding 26): read the config AFTER the wizard — persistCredentials → reresolve() replaced the object
    const cfg = config;
    if (!cfg) {
      uiError(CONFIG_NOT_READY);
      return;
    }
    const limits = limitsWithPending(cfg.limits());
    runCapUsd = limits.spendCapUsd;
    pushThresholds(limits);
    // §9.4 / TUI-DESIGN-2 §3.9 (finding 13): the first run re-derives the root cap from the config (the mode may have changed) unless
    // `/budget session-spend-cap` set it — on the SAME meter (`setCap`, "never recreate a meter"), so the intake / lookup spend, the
    // threshold state and the deferred index lines of the chat before it survive into the run
    if (runs.length === 0 && sessionId === null && !sessionCapExplicit) {
      const cap = cfg.sessionSpendCap(mode).value;
      if (typeof sessionMeter.setCap === 'function') {
        sessionMeter.setCap(cap);
        sessionCapUsd = cap;
      } else newSessionMeter();
    }
    const gate = await followUpGate(limits.spendCapUsd);
    if (!gate.ok) return;
    phase = 'starting';
    startingSteers = [];
    trace('startRun: seeding');
    const seeded = await seedFor(so.pinnedFiles);
    let eng: Engine;
    const started = nowIso();
    try {
      const provider = await providerOf(cfg, flags, mode);
      // llm-jev iteration 1 (168a599): a per-RUN request-hash cache — hits bill nothing (usage zeroed, calls 0); a fresh
      // wrapper per run IS the `clear()` at run start; the engine records StepRecord.jevCacheHits from the zero-call rows
      const decider = createCachingDecider(await deciderOf(cfg, flags));
      // ORCHESTRATION-DESIGN [D6]: money reserved for live agents gates a new run like spend (SpendMeter.heldUsd?() is OPTIONAL by design [G6] so every fake still satisfies the interface; the snapshot field is its twin)
      const remaining = sessionRemainingUsd(sessionCapOf(), sessionTotal(), (sessionMeter.heldUsd?.() ?? sessionMeter.snapshot().heldUsd ?? 0));
      const childCap = Math.max(0, Math.min(limits.spendCapUsd, remaining));
      const meter = sessionMeter.child(childCap);
      // jev-only never validates the generator section (§15.3); llm-jev validates it like jev-on AND takes the synthesizer (docs/LLM-JEV-DESIGN.md)
      const genCfg: GeneratorConfig | null = mode === 'jev-only' || flags.mock || flags.mockGenerator ? null : cfg.generator();
      const gen = genCfg ?? { temperature: null, maxTokens: 4096 };
      const dec = flags.mock ? { model: 'typesafe/jev-1.13-20260917', pinned: true } : cfg.decider();
      deciderModelConfigured = dec.model;
      const synthesizer = mode === 'jev-only' || mode === 'llm-jev' ? await synthesizerOf(cfg, decider, mode) : null;
      const source = flags.source === 'perf' ? 'perf' : 'cli';
      const opts: EngineOptions = {
        task: text,
        mode,
        workspace: cfg.workspace,
        runsDir: cfg.runsDir,
        provider,
        decider,
        // complete autonomy by default: under `full` a `review` verdict is approved at once and logged as one
        // informational `[review]` card; `--autonomy review` keeps the blocking y/n card. `block` stops either way.
        contextAsk: PRODUCT_CONTEXT_ASK, // the product asks Jev little in the context stage (main 1d3648a); the bench keeps the legacy policy
        autonomy: cfg.autonomy, // the engine approves a `review` verdict itself under `full`; under `review` it asks the confirmer (the y/n card)
        confirmer: cfg.autonomy === 'review' ? renderer.confirmer : autonomousConfirmer(renderer.confirmer, (req) => note(autoApprovedNote(req, cfg.redact), { label: '[review]' })),
        meter,
        limits,
        sandboxProfile: cfg.sandbox,
        noNetwork: cfg.noNetwork,
        configRecord: cfg.record(),
        redact: cfg.redact,
        secretPaths: cfg.secretPaths,
        generation: { temperature: gen.temperature, maxTokens: gen.maxTokens },
        // TUI-DESIGN-5 §3.6 / §9.3 constraint (c)'s carve-out (R5-3): the `context.*` chain's last layer. Without
        // this line the six schema rows, `resolveContextConfig` and `ResolvedConfig.context()` are all dead code —
        // `EngineOptions.contextPolicy` was referenced nowhere in this file. The spread keeps the property absent
        // when a `ResolvedConfig` fake predates the member (`exactOptionalPropertyTypes`).
        ...(cfg.context ? { contextPolicy: cfg.context() } : {}),
        // docs/LLM-JEV-DESIGN.md §4.8: the table the llm-jev sample-cost estimate falls back to when no call has been priced yet
        ...(genCfg !== null ? { generatorPricing: genCfg.pricing } : {}),
        deciderModel: { configured: dec.model, pinned: dec.pinned },
        ...(synthesizer ? { synthesizer } : {}),
        exit: engineExit,
        log: engineLog,
        configDirs: cfg.configDirs,
        session: {
          sessionId,
          parentRunId: seeded.parentRunId,
          source,
          ...(title !== null ? { title } : {}),
          ...(so.intake !== undefined ? { intake: so.intake } : {}),
          ...(gate.clamp !== null ? { clamp: { runCapUsd: limits.spendCapUsd, clampedToUsd: gate.clamp, sessionSpentUsd: sessionTotal(), sessionCapUsd: sessionCapOf() } } : {}),
        },
        ...(seeded.seed ? { seed: seeded.seed } : {}),
        ...(instructions ? { instructions } : {}),
        ...(so.secretsAcked > 0 ? { secretsAcked: so.secretsAcked } : {}),
        ...(flags.allowUnpriced ? { allowUnpriced: true } : {}),
        ...(o.interactive || prompter?.blocking ? { blocker } : {}),
      };
      trace('startRun: createEngine');
      eng = await createEngineFn(opts);
      trace(`startRun: engine ${eng.runId}`);
    } catch (e) {
      phase = 'none';
      startingSteers = [];
      trace(`startRun: createEngine failed: ${describe(e)}`);
      const err = isJevCodeError(e) ? e : null;
      uiError(`${err ? `${err.code}: ` : ''}${redact(describe(e))}`);
      log.error(`createEngine failed: ${describe(e)}`);
      if (o.mode === 'one-shot') finishSession(err?.exitCode ?? EXIT_CODES.unexpected, 'error');
      return;
    }
    undoNotes = [];
    undoLog = [];
    rewindSeed = null;
    // §9.4 "whichever comes first": the pending limit values were consumed by this run (as by a /resume)
    clearPendingLimits();
    // §4.9 / §15 item 16: `submit()` resolves once the run started (the composer's `submitting` guard covers the start,
    // not the run); the run itself is driven by runEngine, which never rejects
    void runEngine(eng, { runId: eng.runId, runDir: join(cfg.runsDir, eng.runId), startedAt: started, task: text, resumed: false, parentRunId: seeded.parentRunId, mode });
  }

  interface RunFacts {
    runId: string;
    runDir: string;
    startedAt: string;
    task: string;
    resumed: boolean;
    parentRunId: string | null;
    mode: EngineMode;
  }

  async function runEngine(eng: Engine, f: RunFacts): Promise<void> {
    try {
      await runEngineInner(eng, f);
    } catch (e) {
      // bookkeeping after run:end must never take the session down; the run's own result already landed
      log.error(`post-run bookkeeping failed: ${describe(e)}`);
      engine = null;
      phase = 'none';
      current = null;
      restoreSessionLog();
      for (const w of runEndWaiters.splice(0)) w();
      if (o.mode === 'one-shot') finishSession(EXIT_CODES.unexpected, 'error');
    }
  }

  /**
   * §9.2: `src/cli/args.ts` is **R5-6's** file this round. Two flags round 5 needs there have not landed —
   * `--force-takeback` (§12.1 S11's named escape, §7 row 26) and `--parent-session <id>` (§8.1 item 3's producer,
   * R5-4's agent tree needs the same one) — and R5-1's report carries the exact hunk. Reading them through this
   * widening means the day they land these two call sites pick them up with **no edit here**; until then they are
   * `undefined`, which is the honest "not asked for" and is exactly what §7 row 26 wants of a bare `--force`.
   */
  interface Round5Flags {
    forceTakeback?: boolean;
    parentSession?: string;
  }
  function round5Flags(): Round5Flags {
    return flags as ParsedFlags & Round5Flags;
  }

  /**
   * TUI-DESIGN-5 §2.14 — the WRITE half, started once per run.
   *
   * Fire-and-forget by design: `createPublisher` awaits `renderer.firstFrame()` itself before it reaches the one
   * `await import('../coordination/index.js')` inside `openSessionLedger`, so (a) the first coordination write is
   * provably post-first-frame (gate G-R5-1) and (b) a run never waits on the ledger to start stepping
   * (§1.4 promise 2). A ledger that cannot open is one `[ui]` notice and an empty `/who`, never a failed run.
   */
  /**
   * TUI-DESIGN-5 §2.10 / §12.1, gap 1 — the **configuration** half of the pre-flight, and it is deliberately
   * SYNCHRONOUS and exact: `ResolvedConfig.entries` is already in memory, so "the user turned coordination off"
   * is knowable at the instant `startPublishing` runs and must not depend on a promise having settled. The
   * asynchronous half (`checkHomeWritable`) only ever *adds* a reason the caller could not have known.
   */
  function coordinationDisabledByConfig(): boolean {
    const cfg = config;
    // fix pass, finding 18: `settingReader` is the ONE place the `undefined`-is-on rule lives; both this file and
    // `src/cli/main.tsx` inlined `entries.get(name)?.value` beside it, so the rule was written three times.
    return cfg !== null && !coordinationEnabledFrom(settingReader(cfg.entries));
  }

  /**
   * The disk half: can this home hold a ledger at all? Memoised, and it awaits `renderer.firstFrame()` before it
   * touches the filesystem exactly as `createPublisher` does, so the first frame pays for neither the `mkdir`
   * nor the `access(W_OK)` (gate G-R5-1). It is fire-and-forget on purpose — it **never gates the open**: making
   * `startPublishing` wait on it put two real I/O hops between a run's start and `sessionLedger`, and `/who`
   * typed straight after a run then read a ledger that had not been seated yet.
   */
  function checkHomeWritable(): Promise<CoordinationOffReason | null> {
    coordinationPreflight ??= (async (): Promise<CoordinationOffReason | null> => {
      await renderer.firstFrame();
      const a = await coordinationAvailability({ home: jdir, read: settingReader(config?.entries) });
      coordinationOff = a.kind === 'off' ? a.reason : null;
      return coordinationOff;
    })();
    return coordinationPreflight;
  }

  /**
   * §12.1: the reason `/who`, `/peers` and the chat `peers` fact print **right now** — `null` means "coordination
   * is on, the ledger is simply not open yet" (§1.4 promise 1), which is the landed sentence unchanged.
   */
  function coordinationReason(): CoordinationOffReason | null {
    if (coordinationDisabledByConfig()) return 'disabled';
    void checkHomeWritable();
    return coordinationOff;
  }

  /**
   * §8.1 item 10 / §12.1, gap 1 (fix pass, finding 7): the chat `peers` fact's two keys, decided in ONE place so
   * `/who`, `/peers` and the fact cannot answer three different things about the same session.
   *
   *  - a ledger → the real `PeerView`;
   *  - no ledger and no reason → `null`, which is `peersFactText`'s honest "not open yet";
   *  - no ledger and a reason → the key is OMITTED (`undefined`) **and** the clause rides along, so the fact
   *    reads `the peer registry is not available in this build — coordination is off in this configuration …`
   *    instead of the bare sentence the build makes false.
   */
  function peersFactFields(): Pick<FactsInput, 'peers' | 'peersOffClause'> {
    const led = sessionLedger;
    if (led !== null) return { peers: peerViewOf(led.fold, led.self) };
    const reason = coordinationReason();
    return reason === null ? { peers: null } : { peersOffClause: COORDINATION_OFF_CLAUSE[reason] };
  }

  function startPublishing(f: RunFacts, sid: string): void {
    const cfg = config;
    if (cfg === null || publisher !== null) return;
    // gap 1: coordination off by configuration opens NOTHING, and says so through `/who` and `/peers` rather than
    // through a notice per run — a user who turned it off does not need telling every time.
    if (coordinationDisabledByConfig()) {
      coordinationOff = 'disabled';
      return;
    }
    const p = createPublisher({
      firstFrame: () => renderer.firstFrame(),
      /**
       * §7 row 26 / §12.1 S11: an ordinary `/resume` of an uncontested run does NOT bump the epoch; only
       * `--force-takeback` does. `flags.force` is a DIFFERENT flag with a different meaning ("resume a run whose
       * stopReason is complete instead of seeding a follow-up", `src/cli/args.ts:269`), and reading it here bumped
       * the epoch on every `--resume <id> --force` of a finished run. `--force-takeback` is a §9.2 request to
       * R5-6 (`args.ts`); until it lands it reaches here on the raw tail, which is also how `session.test.ts`
       * drives it, and the day it lands this read picks it up with no edit.
       */
      forceTakeback: forceTakebackOf({ resumed: f.resumed, ...round5Flags() }),
      // gap 1: a ledger that is OFF is not a failure to report — the honest answer lives on `/who` and `/peers`
      onNotice: (text) => {
        if (coordinationOff === null) note(text, { label: '[session]' });
      },
      open: async () => {
        const led = await openLedgerFn({
          home: jdir,
          workspace: workspaceRoot,
          hostname: hostname(),
          username: userInfo().username,
          jevcode: VERSION,
          pid,
          runId: f.runId,
          sessionId: sid,
          parentSessionId: round5Flags().parentSession ?? null,
          parentRunId: f.parentRunId,
          source: flags.source === 'perf' ? 'perf' : 'cli',
          task60: text60(f.task, redact),
          title60: null,
          mode: f.mode,
          maxSteps: cfg.limits().maxSteps,
          maxWallMs: cfg.limits().maxWallMs,
          /**
           * §12.1 S1's `main@3f9a2c1` and §7 rows 7–9. One mapper (`gitInputOf`) owns branch / head oid / dirty /
           * linkedWorktree / commonDir, and `openSessionLedger` resolves `repoKey` / `remoteKey` itself — the
           * per-workspace cache first, then this bounded probe. The hand-written mapping this replaces read only
           * the DETACHED arm of `GitHead` (so an ordinary checkout published `head: null`) and hardcoded both
           * repo keys to `null`, which degraded `sameRepo` to exact `wsKey` equality: two worktrees or two clones
           * of one repository never saw each other and `/peers` counted 0.
           */
          ...gitInputOf(gitAtStart),
          repoFacts: () => probeRepoFacts(workspaceRoot),
          worktreeSlug: null,
          bootAt: new Date(Date.now() - Math.round(uptime() * 1000)).toISOString(),
          redact: (x) => redact(x),
        });
        sessionLedger = led;
        /**
         * TUI-DESIGN-5 §15.2, the ledger binding rule — **read `ledger.fold` on mount and after every
         * own write, then subscribe.** `adoptOwn` seats our own record in `ledger.fold` synchronously but does not
         * `emit()`, so a push-only view lags its own row by the 100 ms debounce (up to 15 s with no `fs.watch`).
         * `/who`, `/peers` and the chat `peers` fact read `sessionLedger.fold` **on demand** — that is the mount
         * read and the after-write read in one, and it is why this file needs no cached copy.
         *
         * The subscription below is the third clause, and it has exactly ONE consumer, deliberately: the 0 → ≥ 1
         * peer edge. The fold → frame PUSH is still not wired — `Renderer` has no repaint hook, and re-seating the
         * host on every beat would raise the idle frame rate, which gate G-R5-3 forbids ("two live peers beating
         * every 2 s must not raise the idle frame rate at all") — so the callback emits at most one line per
         * transition, never one per beat. `UiState.fold` (the `peers` status zone) is the remaining half and is a
         * §9.2 request to the shared-shell owner, recorded in this wave's report.
         */
        coordUnsubscribe?.();
        coordUnsubscribe = led.subscribe(() => {
          announcePeerEdge();
        });
        return led;
      },
    });
    publisher = p;
    void p
      .start()
      .then((r) => {
        /**
         * TUI-DESIGN-4 §7.10 item 2, finally reachable (§2.4: "round 5 changes only WHERE THE NUMBERS COME FROM").
         * `peerOpenNotice` was built in round 4 and had zero callers because `SessionHost.peers()` always answered
         * `null`; the fold is its first real source. The sentence itself is TD4's, unchanged (N6).
         */
        if (r.kind !== 'publishing' || sessionLedger === null) return;
        announcePeerEdge();
      })
      .catch((e: unknown) => log.warn(`coordination: ${describe(e)}`));
  }

  /**
   * TUI-DESIGN-4 §7.10 item 2 / TUI-DESIGN-5 §2.4: the peer line, on the **edge** only.
   *
   * `peerOpenNotice` was built in round 4 with zero callers because `SessionHost.peers()` always answered `null`;
   * the fold is its first real source. It is called from two places — once when the ledger finishes opening, and
   * again from the fold subscription — and `peerNoticeArmed` is what keeps the second from firing per beat: a
   * session that is alone stays armed, the first peer disarms it, and being alone again re-arms it. The sentence
   * itself is TD4's, unchanged (N6).
   */
  function announcePeerEdge(): void {
    const led = sessionLedger;
    if (led === null) return;
    const line = peerOpenNotice(peerViewOf(led.fold, led.self));
    if (line === null) {
      peerNoticeArmed = true;
      return;
    }
    if (!peerNoticeArmed) return;
    peerNoticeArmed = false;
    note(line, { label: '[session]' });
  }

  /**
   * §2.14 row 1: the writer is stopped in the same `finally` that ends the run, and again at session exit — both
   * idempotent. Nothing writes a "clean" terminal beat: a crash must leave the LAST beat on disk, which is what
   * makes §7 row 3's `crashed during step 8` row possible at all.
   */
  async function stopPublishing(): Promise<void> {
    const p = publisher;
    publisher = null;
    sessionLedger = null;
    // §15.2: the subscription is dropped with the handle it belongs to — one handle, one subscription, one close
    try {
      coordUnsubscribe?.();
    } catch {
      /* an unsubscribe that threw must not fail the exit path */
    }
    coordUnsubscribe = null;
    peerNoticeArmed = true;
    if (p === null) return;
    try {
      await p.stop();
    } catch (e) {
      log.warn(`coordination: ${describe(e)}`);
    }
  }

  /** §13.6: the controller's lines of a live run go to `<runDir>/jevcode.log` (the run dir exists once createEngine returned) */
  function retargetLogToRun(runDir: string): void {
    if (deps.log || !config) return;
    try {
      const next = createLog({ file: join(runDir, CHECKPOINT_FILES.log), level: log.level, redact: config.redact, fallbackDir: join(jdir, 'logs'), pid });
      sessionLog = log;
      runLog = next;
      log = next;
    } catch (e) {
      log.warn(`run log unavailable: ${describe(e)}`);
    }
  }

  /** back to the session log at run:end (the run log is flushed and closed) */
  function restoreSessionLog(): void {
    if (runLog === null) return;
    const closing = runLog;
    runLog = null;
    if (sessionLog !== null) log = sessionLog;
    sessionLog = null;
    try {
      closing.close();
    } catch {
      /* already closed */
    }
  }

  /** §9.4: the five limit pendings are one-shot values (`/model` `/provider` `/mode` stay pending per §5.2) */
  function clearPendingLimits(): void {
    delete pending.spendCapUsd;
    delete pending.maxSteps;
    delete pending.maxWall;
    delete pending.maxReplans;
    delete pending.maxGeneratorTokens;
  }

  async function runEngineInner(eng: Engine, f: RunFacts): Promise<void> {
    const cfg = config;
    engine = eng;
    endEvent = null;
    lastStatus = null;
    // the forced-exit epilogue (`engineExit`) and the inspect blocks describe this run, never the previous one's result
    lastResult = null;
    decisions = [];
    lastPlan = null;
    const record: RunRecord = { runId: f.runId, runDir: f.runDir, startedAt: f.startedAt, endedAt: null, task: f.task, stopReason: null, exitCode: null, steps: 0, costUsd: { generator: 0, jev: 0 }, changedFiles: [], changedSteps: [], records: [], resumable: false, degraded: false };
    current = record;
    currentRunMode = f.mode;
    runs.push(record);
    if (sessionId === null) sessionId = f.runId;
    const sid = sessionId;
    retargetLogToRun(f.runDir);
    renderer.attach(eng);
    const detach = eng.events.onAny(onEvent);
    // §8.2: run:start right after createEngine; §8.9: session:start once per session
    const branch = gitAtStart?.head?.kind === 'branch' ? gitAtStart.head.name : null;
    // contract 1.8 item 3 / §2.8: `parentSessionId` is written here (the arm's stated reader default is `null`), so
    // `foldIndex` has something to fold onto `SessionRow.parentSessionId` and the picker can indent a child row
    indexLine({ v: 1, t: f.startedAt, kind: 'run:start', sessionId: sid, runId: f.runId, parentRunId: f.parentRunId, workspace: workspaceRoot, task60: f.task, mode: f.mode, source: flags.source === 'perf' ? 'perf' : 'cli', branch, resumeOf: f.resumed ? f.runId : null, parentSessionId: round5Flags().parentSession ?? null });
    // TUI-DESIGN-5 §2.14 / N8: the run is now in the index; this is where it also becomes visible to every PEER
    startPublishing(f, sid);
    // §8.2 / §9.4: `/budget session-spend-cap` lines issued before the session had an id carry this session's id now
    for (const b of deferredBudgetLines.splice(0)) indexLine({ v: 1, t: b.t, kind: 'budget', sessionId: sid, runId: null, setting: 'session.spendCapUsd', from: b.from, to: b.to });
    // TUI-DESIGN-2 §3.9: the chat requests before the first run (intakes, lookups, LLM turns) carry this session's id now
    for (const c of deferredChatLines.splice(0)) indexLine({ v: 1, t: c.t, kind: 'chat', sessionId: sid, intake: c.intake, route: c.route, costUsd: c.costUsd, provider: c.provider });
    if (!sessionStartAnnounced) {
      sessionStartAnnounced = true;
      json?.sessionStart({ sessionId: sid, runId: f.runId, parentRunId: f.parentRunId, workspace: workspaceRoot });
    }
    // §8.6: the steers typed while the engine was being created; the engine's own refusals are reported, never dropped
    for (const s of startingSteers.splice(0)) {
      const r = eng.steer(s);
      if (!r.ok) uiError(STEER_ERRORS[r.reason === 'full' ? 'full' : r.reason === 'empty' ? 'empty' : 'finished']);
    }
    if (signalExit !== null) eng.abort('signal', { signal: signalExit });
    let result: RunResult;
    try {
      result = await eng.run();
    } catch (e) {
      // Engine.run never rejects by contract; a broken fake is treated as an error stop
      detach();
      engine = null;
      phase = 'none';
      current = null;
      record.endedAt = nowIso();
      record.stopReason = 'error';
      record.exitCode = EXIT_CODES.unexpected;
      uiError(redact(describe(e)));
      restoreSessionLog();
      if (o.mode === 'one-shot') finishSession(EXIT_CODES.unexpected, 'error');
      return;
    }
    detach();
    lastResult = result;
    const end = readEndEvent();
    const degraded = end?.exitCode === EXIT_CODES.checkpoint && result.stopReason !== 'error';
    const exitCode = end?.exitCode ?? exitCodeFor(result.stopReason, result.error, degraded, signalExit ?? undefined);
    record.endedAt = nowIso();
    record.stopReason = result.stopReason;
    record.exitCode = exitCode;
    record.steps = result.steps;
    record.costUsd = { generator: result.usage.generator.costUsd, jev: result.usage.jev.costUsd };
    record.resumable = end?.resumable ?? existsSync(join(f.runDir, 'state.json'));
    record.degraded = degraded;
    engine = null;
    phase = 'none';
    current = null;
    log.info(`run ${f.runId} ended: ${result.stopReason} exit ${exitCode} steps ${result.steps}`);
    restoreSessionLog();
    for (const w of runEndWaiters.splice(0)) w();
    pushSessionSpend();
    // §8.2: run:end after finish()'s final writeState
    indexLine({ v: 1, t: record.endedAt, kind: 'run:end', sessionId: sid, runId: f.runId, stopReason: result.stopReason, steps: result.steps, costUsd: record.costUsd, wallMs: result.wallMs, changedFiles: record.changedFiles.length, exitCode, resumable: record.resumable, degraded });
    if (o.mode === 'one-shot') {
      finishSession(exitCode, 'run-end');
      return;
    }
    // §13.5: an external signal ends the process at run:end; the composer does not reopen
    if (signalExit !== null || result.stopReason === 'signal') {
      finishSession(exitCodeFor('signal', undefined, false, signalExit ?? undefined), 'run-end');
      return;
    }
    // §13.5 / §24: the epilogue item (session mode) — human_pause and spend_cap have their own wording
    postRunItems(record, result);
    if (exitAfterRunEnd !== null) {
      finishSession(leaveExitCode(exitAfterRunEnd), 'exit');
      return;
    }
    void refold();
    void reprobeGit(cfg, record);
    if (cfg) candidates = trackCandidates(listCandidatesFn(workspaceRoot, { secretPaths: cfg.secretPaths, redact: cfg.redact }).catch(() => []));
  }

  /** the run:end event `onEvent` captured (read through a call so the closure assignment is visible to the type checker) */
  function readEndEvent(): RunEndEvent | null {
    return endEvent;
  }

  /**
   * TUI-DESIGN §13.5 `resume` row: `jevcode run --resume <id>` whenever state.json is loadable; the alternative
   * `state.json missing — not resumable` is for a missing or degraded checkpoint (the `[c]` case of §13.3). The engine's
   * `run:end.resumable` (kept as is on the index line, §8.2) also excludes `complete`/`generator_done` stops, whose
   * state.json seeds a follow-up through `--resume <id>` (`resumeOrFollowUp`, §5.2), so those consult the file.
   */
  function epilogueResumable(record: RunRecord): boolean {
    if (record.resumable) return true;
    if (record.degraded) return false;
    return (record.stopReason === 'complete' || record.stopReason === 'generator_done') && existsSync(join(record.runDir, 'state.json'));
  }

  function postRunItems(record: RunRecord, result: RunResult): void {
    // §7.2 item 4: the in-session epilogue probes the run directory exactly as the process-exit path does, so a
    // per-run `[ui] stopped — …` item can never advertise files that are no longer there
    const ctx: EpilogueContext = { runId: record.runId, runDir: record.runDir, resumable: epilogueResumable(record), stopReason: result.stopReason, exitCode: record.exitCode ?? 0, degraded: record.degraded, home, ...runDirFiles(record.runDir) };
    if (result.stopReason === 'human_pause') {
      notifyLocal(pausedItemText(result.steps));
      return;
    }
    if (result.stopReason === 'spend_cap') {
      const snap = result.usage;
      const spent = snap.generator.costUsd + snap.jev.costUsd;
      const lines = spendCapEpilogueLines({ by: 'run', spentUsd: spent, capUsd: runCapUsd, sessionSpentUsd: sessionTotal(), sessionCapUsd: sessionCapOf() });
      notifyLocal(lines[0] ?? '', { detail: lines.slice(1).join('\n') });
      if (o.rendererKind !== 'tui') for (const l of lines.slice(1)) notifyLocal(l);
      return;
    }
    // §3.3: the epilogue is built at THIS terminal's block width — the default 70 overflowed a 40-column body
    const { text, detail } = epilogueItemLines(result.error ?? null, ctx, redact, bodyWidth());
    notifyLocal(text, { level: result.stopReason === 'error' ? 'error' : 'info', ...(detail.length > 0 ? { detail: detail.join('\n') } : {}) });
  }

  /** §12.2 (P51): the run:end re-probe, persisted as `RunMeta.git.end` through `updateMeta({ git })` — off the loop, best effort */
  async function reprobeGit(cfg: ResolvedConfigWithDiagnostics | null, record: RunRecord): Promise<void> {
    if (!cfg) return;
    try {
      const g = await probeGit(workspaceRoot);
      gitAtStart = g;
      if (!g.repo) return;
      const store = createCheckpointStore(record.runDir, cfg.redact);
      const { meta } = await store.load();
      if (meta.git) await store.updateMeta({ git: { ...meta.git, end: toRunGitMetaEnd(g) } });
    } catch (e) {
      log.debug(`git re-probe skipped: ${describe(e)}`);
    }
  }

  // --- resume (§8.4, §9.1, §9.4, §12.4) -----------------------------------------------------------
  async function resumeRun(runId: string, force: boolean): Promise<void> {
    if (exiting) return;
    if (live()) {
      uiError(COMMAND_ERRORS.resumeLive);
      return;
    }
    if (!config) return;
    const cfg = config;
    phase = 'starting';
    try {
      const loaded = await loadForResumeFn(cfg.runsDir, runId, { redact: cfg.redact });
      const identity = resumeIdentityFromRunMeta(loaded.meta);
      const wsReal = flags.workspace ? await import('node:fs/promises').then((m) => m.realpath(resolvePath(flags.workspace as string))).catch(() => null) : null;
      // §9.4: pending /budget values ride as augmented flags so reconcileResumeConfig records them as overrides
      const augmented: ParsedFlags = {
        ...flags,
        ...(flags.provider === undefined && identity.provider ? { provider: identity.provider } : {}),
        ...(flags.model === undefined && identity.model ? { model: identity.model } : {}),
        ...(flags.baseUrl === undefined && identity.baseUrl ? { baseUrl: identity.baseUrl } : {}),
        ...(flags.jevModel === undefined && identity.jevModel ? { jevModel: identity.jevModel } : {}),
        ...(flags.jevBaseUrl === undefined && identity.jevBaseUrl ? { jevBaseUrl: identity.jevBaseUrl } : {}),
        ...(flags.sandbox === undefined && identity.sandbox ? { sandbox: identity.sandbox } : {}),
        ...(pending.spendCapUsd !== undefined ? { spendCap: String(pending.spendCapUsd) } : {}),
        ...(pending.maxSteps !== undefined ? { maxSteps: String(pending.maxSteps) } : {}),
        ...(pending.maxWall !== undefined ? { maxWall: pending.maxWall.text, maxWallMs: pending.maxWall.ms } : {}),
        ...(pending.maxReplans !== undefined ? { maxReplans: String(pending.maxReplans) } : {}),
        ...(pending.maxGeneratorTokens !== undefined ? { maxGeneratorTokens: String(pending.maxGeneratorTokens) } : {}),
        workspace: identity.workspace,
      };
      const rcfg = await resolveConfig(augmented, env, cwd, { homedir: home, mode: identity.mode, suppressLegacyWarning: true });
      const rec = reconcileResumeConfig(resumeInputsFrom(rcfg, { ...loaded.state, stopReason: loaded.previousStopReason }, wsReal), loaded.meta, augmented);
      if (rec.errors.length > 0) throw rec.errors[0];
      if (rec.immediateStop) {
        phase = 'none';
        note(`${rec.immediateStop.message} (exit ${EXIT_CODES.budget})`, { level: 'warn' });
        if (o.mode === 'one-shot') finishSession(EXIT_CODES.budget, 'exit');
        return;
      }
      for (const w of loaded.warnings) warnLine(w);
      const fields = sessionFieldsOf(loaded.meta);
      // §9.1: a run of another session switches the session: fold excluding the resumed run, then the child, then the resumed spend
      const known = runs.some((r) => r.runId === runId);
      if (sessionId !== fields.sessionId) {
        // §9.1: another session — its own root meter (an explicit cap of the previous session does not carry over)
        sessionId = fields.sessionId;
        runs = [];
        newSessionMeter();
        seedMeterFromIndex(fields.sessionId, runId);
        title = index.find((s) => s.sessionId === fields.sessionId)?.title ?? null;
      }
      const resumedSpend = loaded.state.spend.totalUsd;
      const remaining = sessionRemainingUsd(sessionCapOf(), sessionTotal() - (known ? resumedSpend : 0), (sessionMeter.heldUsd?.() ?? sessionMeter.snapshot().heldUsd ?? 0));
      const childCap = Math.max(0, Math.min(rec.limits.spendCapUsd, remaining));
      pushThresholds(rec.limits);
      const meter = sessionMeter.child(childCap);
      if (!known) sessionMeter.add('generator', { inputTokens: 0, outputTokens: 0, costUsd: loaded.state.spend.generator.costUsd, calls: 0 });
      if (!known) sessionMeter.add('jev', { inputTokens: 0, outputTokens: 0, costUsd: loaded.state.spend.jev.costUsd, calls: 0 });
      const provider = await providerOf(rcfg, augmented, identity.mode);
      const decider = createCachingDecider(await deciderOf(rcfg, augmented)); // per-run cache; a resumed run starts empty
      const genCfg: GeneratorConfig | null = identity.mode === 'jev-only' || flags.mock || flags.mockGenerator ? null : rcfg.generator();
      const gen = genCfg ?? { temperature: null, maxTokens: 4096 };
      const dec = flags.mock ? { model: 'typesafe/jev-1.13-20260917', pinned: true } : rcfg.decider();
      deciderModelConfigured = dec.model;
      const synthesizer = identity.mode === 'jev-only' || identity.mode === 'llm-jev' ? await synthesizerOf(rcfg, decider, identity.mode) : null;
      const undoNote = undoNotes.length > 0 ? undoNotes.join('\n') : null;
      const source = flags.source === 'perf' ? 'perf' : 'cli';
      const opts: EngineOptions = {
        task: identity.task,
        mode: identity.mode,
        workspace: identity.workspace,
        runsDir: rcfg.runsDir,
        resume: { runId, force },
        provider,
        decider,
        // complete autonomy by default: under `full` a `review` verdict is approved at once and logged as one
        // informational `[review]` card; `--autonomy review` keeps the blocking y/n card. `block` stops either way.
        contextAsk: PRODUCT_CONTEXT_ASK,
        autonomy: rcfg.autonomy,
        confirmer: rcfg.autonomy === 'review' ? renderer.confirmer : autonomousConfirmer(renderer.confirmer, (req) => note(autoApprovedNote(req, rcfg.redact), { label: '[review]' })),
        meter,
        limits: rec.limits,
        sandboxProfile: identity.sandbox ?? rcfg.sandbox,
        noNetwork: rcfg.noNetwork,
        configRecord: rcfg.record(),
        redact: rcfg.redact,
        secretPaths: rcfg.secretPaths,
        generation: { temperature: gen.temperature, maxTokens: gen.maxTokens },
        // TUI-DESIGN-5 §3.6 / §9.3 constraint (c)'s carve-out (R5-3): the resumed run reads the SAME chain — a
        // `context.compaction` the user changed between runs takes effect on the resume, like every other setting
        // `--resume` re-reads (§9 "Configuration on --resume").
        ...(rcfg.context ? { contextPolicy: rcfg.context() } : {}),
        ...(genCfg !== null ? { generatorPricing: genCfg.pricing } : {}),
        deciderModel: { configured: dec.model, pinned: dec.pinned },
        ...(synthesizer ? { synthesizer } : {}),
        exit: engineExit,
        log: engineLog,
        configDirs: rcfg.configDirs,
        session: { sessionId: fields.sessionId, parentRunId: fields.parentRunId, source, ...(title !== null ? { title } : {}), ...(childCap < rec.limits.spendCapUsd ? { clamp: { runCapUsd: rec.limits.spendCapUsd, clampedToUsd: childCap, sessionSpentUsd: sessionTotal(), sessionCapUsd: sessionCapOf() } } : {}) },
        ...(instructions ? { instructions } : {}),
        ...(undoNote !== null ? { humanDirective: undoNote } : {}),
        ...(undoLog.length > 0 ? { undoLog: [...undoLog] } : {}),
        ...(rec.overrides.length > 0 ? { resumeOverrides: rec.overrides.map((ov) => ({ ...ov, source: isPendingSetting(ov.setting) ? ('/budget' as const) : ('flag' as const) })) } : {}),
        ...(o.interactive || prompter?.blocking ? { blocker } : {}),
      };
      const eng = await createEngineFn(opts);
      // the pending values were consumed by this resume (§9.4: "whichever comes first")
      clearPendingLimits();
      undoNotes = [];
      undoLog = [];
      void runEngine(eng, { runId, runDir: join(rcfg.runsDir, runId), startedAt: nowIso(), task: identity.task, resumed: true, parentRunId: fields.parentRunId, mode: identity.mode });
    } catch (e) {
      phase = 'none';
      const err = isJevCodeError(e) ? e : null;
      uiError(`/resume — ${redact(describe(e))}`);
      log.error(`resume failed: ${describe(e)}`);
      if (o.mode === 'one-shot') finishSession(err?.exitCode ?? EXIT_CODES.unexpected, 'error');
    }
  }

  function isPendingSetting(setting: string): boolean {
    return (
      (pending.spendCapUsd !== undefined && setting === 'limits.spendCapUsd') ||
      (pending.maxSteps !== undefined && setting === 'limits.maxSteps') ||
      (pending.maxWall !== undefined && setting === 'limits.maxWallMs') ||
      (pending.maxReplans !== undefined && setting === 'limits.maxReplans') ||
      (pending.maxGeneratorTokens !== undefined && setting === 'limits.maxGeneratorTokens')
    );
  }

  /** `--resume <id|title>` / `/resume <x>`: run id → resume; title → the session's newest run (§8.4) */
  async function resumeTarget(value: string, force: boolean): Promise<void> {
    const c = classifyResumeValue(value);
    if (c.kind === 'run') {
      await resumeRun(c.runId, force);
      return;
    }
    const r = resolveResumeTarget(sessionRows(), c.title);
    if (r.kind === 'run') await resumeRun(r.runId, force);
    else if (r.kind === 'session') {
      const id = newestRunId(r.session);
      if (id) await resumeRun(id, force);
      else uiError(`/resume — session "${c.title}" has no run — pick another with /resume, or type a task`);
    } else if (r.kind === 'ambiguous') throw new ConfigError(ambiguousResumeMessage(value, r.candidates), { setting: 'resume' });
    else throw new UsageError(`--resume: no run or session matches "${value}"`);
  }

  // --- git facts and sandboxes for the idle commands (§12.4–§12.6) ------------------------------
  async function gitFacts(): Promise<{ git: boolean; headOid: string | null; gitDir: string | null; commonDir: string | null; unborn: boolean }> {
    let g = gitAtStart;
    if (g === null) {
      try {
        g = await probeGit(workspaceRoot);
        gitAtStart = g;
      } catch {
        g = null;
      }
    }
    if (g === null || !g.repo) return { git: false, headOid: null, gitDir: null, commonDir: null, unborn: false };
    const head = g.gitDir ? readHead(g.gitDir, g.commonDir) : g.head;
    const headOid = head === null || head.kind === 'unborn' ? null : head.oid;
    return { git: true, headOid, gitDir: g.gitDir, commonDir: g.commonDir, unborn: head?.kind === 'unborn' };
  }

  function makeSandbox(cfg: ResolvedConfigWithDiagnostics, runDir: string, git: { gitDir: string | null; commonDir: string | null }): ReturnType<typeof realCreateSandbox> | null {
    try {
      return createSandboxFn({
        workspaceRoot,
        runDir,
        profile: cfg.sandbox,
        noNetwork: cfg.noNetwork,
        secretReadDenies: cfg.secretPaths,
        redact: cfg.redact,
        ...(git.gitDir ? { gitDir: git.gitDir } : {}),
        ...(git.commonDir ? { gitCommonDir: git.commonDir } : {}),
        configDirs: cfg.configDirs,
      });
    } catch (e) {
      log.warn(`sandbox for the idle command unavailable: ${describe(e)}`);
      return null;
    }
  }

  function lastFinishedRun(): RunRecord | null {
    return runs.filter((r) => r.endedAt !== null).at(-1) ?? null;
  }

  async function undoCommand(step: number | null): Promise<void> {
    const cfg = config;
    const last = lastFinishedRun();
    if (!cfg || !last) {
      // TUI-DESIGN-4 §3.1.7: an empty state is never an error. Only a REFUSED or malformed request is, so these
      // two are plain `[ui]` info items — nothing was refused, there is simply nothing to undo yet.
      note('nothing to undo — no run has finished in this session');
      return;
    }
    const target = step ?? last.changedSteps.at(-1) ?? null;
    if (target === null) {
      note('nothing to undo — the last run changed no files');
      return;
    }
    const git = await gitFacts();
    const prepared = await prepareUndo(last.runDir, target, { root: workspaceRoot, headOid: git.headOid, git: git.git });
    if (!prepared.ok) {
      uiError(`/undo — ${prepared.message}`);
      return;
    }
    const sandbox = git.git ? makeSandbox(cfg, last.runDir, git) : null;
    const result = await applyUndo(prepared.plan, { runDir: last.runDir, runId: last.runId, root: workspaceRoot, nowIso, ...(sandbox ? { sandbox } : {}), ...(prompter?.undoAsk ? { ask: prompter.undoAsk } : {}) });
    recordUndo(result, 'undo', last);
  }

  function recordUndo(result: ApplyUndoResult, by: 'undo' | 'rewind', run: RunRecord): void {
    note(result.summary, { label: result.label });
    for (const w of result.warnings) warnLine(w);
    if (result.entry) {
      undoLog.push(result.entry);
      keepLast(undoLog, 20);
      if (result.note) undoNotes.push(result.note);
      if (sessionId) indexLine({ v: 1, t: nowIso(), kind: 'undo', sessionId, runId: run.runId, step: result.step, by, files: result.restored.length, skipped: result.skipped.length });
    }
  }

  function rewindSteps(run: RunRecord): RewindStep[] {
    return run.records.map((r) => ({ step: r.step, changedFiles: r.outcome?.status === 'executed' ? r.outcome.changedFiles : [], ...(r.planAfter ? { planAfter: r.planAfter } : {}) }));
  }

  async function rewindCommand(step: number | null): Promise<void> {
    const cfg = config;
    const last = lastFinishedRun();
    if (!cfg || !last) {
      // §3.1.7: `/rewind`'s two states are the SAME empty states `/undo`'s were — an info sentence, not an error
      note('nothing to rewind — no run has finished in this session');
      return;
    }
    const steps = rewindSteps(last);
    const candidatesList = rewindCandidates(steps);
    if (candidatesList.length === 0) {
      note('nothing to rewind — the last run changed no files');
      return;
    }
    let target = step;
    if (target === null) {
      if (prompter?.rewind) target = await prompter.rewind(steps);
      else {
        textBlock('rewind · steps with changes', rewindPickerRows(steps, bodyWidth()));
        uiError(COMMAND_ERRORS.rewindNoStep);
        return;
      }
    }
    if (target === null) return;
    const plan = planRewind(steps, target);
    const git = await gitFacts();
    const sandbox = git.git ? makeSandbox(cfg, last.runDir, git) : null;
    const deps = { runDir: last.runDir, runId: last.runId, root: workspaceRoot, nowIso, ...(sandbox ? { sandbox } : {}), ...(prompter?.undoAsk ? { ask: prompter.undoAsk } : {}) };
    for (const s of plan.order) {
      const prepared = await prepareUndo(last.runDir, s, { root: workspaceRoot, headOid: git.headOid, git: git.git });
      if (!prepared.ok) {
        uiError(`/rewind ${s} — ${prepared.message}`);
        break;
      }
      const r = await applyUndo(prepared.plan, deps);
      recordUndo(r, 'rewind', last);
      if (r.refused || r.aborted) break;
    }
    const choice = prompter?.rewindChoice ? await prompter.rewindChoice() : 'files';
    if (choice === 'plan' || choice === 'both') {
      const at = steps.find((s) => s.step === plan.target);
      rewindSeed = { step: plan.target, planAfter: at?.planAfter ?? null };
      if (!at?.planAfter) note(REWIND_PLAN_FALLBACK_NOTICE, { level: 'warn' });
      undoNotes.push(`/rewind plan+window to step ${plan.target}`);
      note(`rewind: the next run seeds from step ${plan.target}'s plan and the window up to it`);
    }
  }

  async function diffCommand(a: Extract<CommandAction, { kind: 'diff' }>): Promise<void> {
    const cfg = config;
    const run = current ?? lastFinishedRun();
    if (!cfg || !run) {
      // §3.1.7: an empty state is a sentence, not an error
      note('nothing to diff — no run in this session yet');
      return;
    }
    const git = await gitFacts();
    if (a.step !== null) {
      const post = await readPostImages(run.runDir, a.step);
      if (!post.ok) {
        uiError(`/diff ${a.step} — ${post.detail}`);
        return;
      }
      const files: StepDiffFile[] = [];
      for (const [path, f] of Object.entries(post.image.files)) {
        const pre = await readPreImage(run.runDir, a.step, path);
        let now: Uint8Array | null = null;
        try {
          now = await readFile(join(workspaceRoot, path));
        } catch {
          now = null;
        }
        const nowHash = now === null ? null : (await import('node:crypto')).createHash('sha256').update(now).digest('hex');
        files.push({ path, pre: pre?.bytes ?? null, post: f.deleted === true ? null : now, ...(f.sha256 !== undefined && f.sha256 !== null && nowHash !== null && nowHash !== f.sha256 ? { changedSince: true } : {}), ...(pre === null && f.preImage !== true ? { preUnavailable: true } : {}) });
      }
      const lines = diffStepLines(a.step, files, { maxLines: DIFF_INLINE_MAX_LINES });
      // §3.3: a diff source line is NEVER wrapped (a wrapped diff line is a lie) — `renderBlock` elides it right and
      // the footer names where the rest is. REQUEST to S5 (§9.2 `src/undo/diff.ts`): `diffStepLines` takes `width`.
      // §3.1.6 / §6.5 item 5: the block DECLARES its syntax, and only then are the raw rows classified — a `+`
      // row is `added`, `@@` is `hunk`, `diff --git` is `diffMeta`; the text itself stays git-shaped and pasteable
      textBlock(lines[0] ?? `diff step ${a.step}`, lines.slice(1), { max: BLOCK_CAPS.diff, moreFooter: `${glyphs().ellipsis} +{n} more lines (/diff --full)`, syntax: 'diff', detailKind: 'diff' });
      return;
    }
    if (!git.git) {
      uiError(COMMAND_ERRORS.diffNoRepo);
      return;
    }
    const sandbox = makeSandbox(cfg, run.runDir, git);
    if (!sandbox) {
      uiError(COMMAND_ERRORS.diffNoSandbox);
      return;
    }
    const io = { sandbox, root: workspaceRoot, runId: run.runId, changedFiles: run.changedFiles, ...(git.unborn ? { unborn: true } : {}) };
    if (a.full) {
      if (live()) {
        uiError(COMMAND_ERRORS.diffFullLive);
        return;
      }
      const collected = await collectFullDiff({ ...io, color: o.stdout.isTTY === true, secretPaths: cfg.secretPaths, redact: cfg.redact });
      const suspend = prompter?.suspendTerminal;
      const r = await openFullDiff({ suspendTerminal: suspend ?? ((run) => run()), env, isTTY: o.stdout.isTTY === true && suspend !== undefined, text: collected.text, notice: collected.notice, runDir: run.runDir, seq: ++diffSeq });
      if (r.mode === 'pager') note(`diff: ${r.command} showed ${r.file}${r.exitCode !== null && r.exitCode !== 0 ? ` (exit ${r.exitCode})` : ''}`);
      else textBlock(r.lines[0] ?? 'diff', r.lines.slice(1));
      for (const err of collected.errors) warnLine(err);
      return;
    }
    // TUI-DESIGN-4 §3.3 / §6.5: `diffStatBlock` is given the BLOCK BODY width, not the terminal width — round 3's
    // D-L moved detail rows to column 10, so passing `columns()` overflowed every row of this block by exactly 10
    const r = await diffStatBlockFromGit({ ...io, ...(a.all ? { all: true } : {}) }, bodyWidth());
    textBlock(r.lines[0] ?? 'diff', r.lines.slice(1));
    for (const err of r.errors) warnLine(err);
  }

  // --- /export (§8.7) ---------------------------------------------------------------------------
  async function exportCommand(file: string | null): Promise<void> {
    const cfg = config;
    if (!cfg || sessionId === null) {
      uiError(COMMAND_ERRORS.exportNoSession);
      return;
    }
    const row = index.find((s) => s.sessionId === sessionId);
    const list: ExportRun[] = [];
    const seen = new Set<string>();
    for (const r of row?.runs ?? []) {
      seen.add(r.runId);
      // §8.7: the header names the run's own task — from this process's record, else its run.json; the session's first task is the last resort
      const known = runs.find((k) => k.runId === r.runId);
      let task60 = known !== undefined ? text60(known.task, cfg.redact) : null;
      if (task60 === null) {
        const loaded = await loadRunFn(cfg.runsDir, r.runId, cfg.redact).catch(() => null);
        task60 = loaded !== null ? text60(loaded.meta.task, cfg.redact) : (row?.task60 ?? '');
      }
      list.push({ runId: r.runId, runDir: join(cfg.runsDir, r.runId), startedAt: r.startedAt, task60, stopReason: r.stopReason, costUsd: r.costUsd === null ? null : r.costUsd.generator + r.costUsd.jev });
    }
    for (const r of runs) {
      if (seen.has(r.runId)) continue;
      list.push({ runId: r.runId, runDir: r.runDir, startedAt: r.startedAt, task60: text60(r.task, cfg.redact), stopReason: r.stopReason, costUsd: r.endedAt === null ? null : r.costUsd.generator + r.costUsd.jev });
    }
    const out = file !== null ? resolvePath(workspaceRoot, file) : exportFilePath(jdir, sessionId);
    try {
      const r = await exportSessionFn(list, out);
      // TUI-DESIGN-4 §3.4: every path a command names goes through `shortPath`
      note(`exported ${r.runs} run${r.runs === 1 ? '' : 's'} to ${shortPath(r.path, { root: workspaceRoot, home, width: bodyWidth(), measure: cellWidth })}${r.truncated ? ' (truncated at 64 MiB)' : ''}${r.missing.length > 0 ? ` · ${r.missing.length} transcript${r.missing.length === 1 ? '' : 's'} missing` : ''}`);
    } catch (e) {
      uiError(`/export — ${redact(describe(e))}`);
    }
  }

  // --- /budget (§9.4) ---------------------------------------------------------------------------
  function budgetCommand(a: Extract<CommandAction, { kind: 'budget' }>): void {
    if (a.set === null) {
      const run = current ?? lastFinishedRun();
      const spent = run ? (run.endedAt === null ? lastStatus?.spend.totalUsd ?? 0 : run.costUsd.generator + run.costUsd.jev) : 0;
      // TUI-DESIGN-4 §3.3: kv `run` / `session`, then ONE `pending · next /resume or run` rule caption and one kv
      // row per pending value (today's parenthetical repeated on every row is gone); §3.1.7's empty state below
      const done = runs.filter((r) => r.endedAt !== null).length;
      const rows: BlockRow[] = [
        // §3.1.4: an amount SPENT is three decimals, a CAP is `usd2` — two cap forms in one block was the defect
        { kind: 'kv', key: 'run', value: `${usd3(spent)} of ${usd2(runCapUsd)}` },
        { kind: 'kv', key: 'session', value: `${usd2(sessionTotal())} of ${usd2(sessionCapOf())} · ${done} run${done === 1 ? '' : 's'}` },
      ];
      const pend = pendingBudgetPairs();
      if (pend.length === 0) rows.push({ kind: 'note', flush: true, text: 'nothing pending' });
      else {
        rows.push({ kind: 'rule', caption: `pending ${glyphs().dot} next /resume or run` });
        for (const pr of pend) rows.push({ kind: 'kv', key: pr.setting, value: pr.value, role: 'accent' });
      }
      block('budget', rows);
      return;
    }
    const set = a.set;
    const ctx = { runId: current?.runId ?? null, sessionId };
    switch (set.setting) {
      case 'session-spend-cap': {
        const from = sessionCapOf();
        const to = set.usd === 'none' ? Number.POSITIVE_INFINITY : set.usd;
        sessionMeter.setCap?.(to);
        sessionCapUsd = to;
        sessionCapExplicit = true;
        pushSessionSpend();
        // §8.2: the index line needs a session id — before the first run it waits for the run that creates the session
        if (sessionId) indexLine({ v: 1, t: nowIso(), kind: 'budget', sessionId, runId: current?.runId ?? null, setting: 'session.spendCapUsd', from: String(from), to: String(to) });
        else deferredBudgetLines.push({ t: nowIso(), from: String(from), to: String(to) });
        note(sessionCapChangedLine(from, to));
        json?.sessionBudget({ setting: 'session.spendCapUsd', from: String(from), to: String(to), appliesTo: 'now' }, ctx);
        return;
      }
      case 'spend-cap': {
        const run = current ?? lastFinishedRun();
        const spent = run ? (run.endedAt === null ? lastStatus?.spend.totalUsd ?? 0 : run.costUsd.generator + run.costUsd.jev) : 0;
        const err = spendCapRaiseError(set.usd, spent);
        if (err !== null) {
          uiError(err);
          return;
        }
        pending.spendCapUsd = set.usd;
        note(pendingBudgetLine('spend-cap', set.usd.toFixed(2)));
        json?.sessionBudget({ setting: 'limits.spendCapUsd', from: String(runCapUsd), to: String(set.usd), appliesTo: 'next' }, ctx);
        return;
      }
      case 'max-steps':
        pending.maxSteps = set.n;
        note(pendingBudgetLine('max-steps', String(set.n)));
        json?.sessionBudget({ setting: 'limits.maxSteps', from: String(config?.limits().maxSteps ?? ''), to: String(set.n), appliesTo: 'next' }, ctx);
        return;
      case 'max-replans':
        pending.maxReplans = set.n;
        note(pendingBudgetLine('max-replans', String(set.n)));
        json?.sessionBudget({ setting: 'limits.maxReplans', from: String(config?.limits().maxReplans ?? ''), to: String(set.n), appliesTo: 'next' }, ctx);
        return;
      case 'max-generator-tokens':
        pending.maxGeneratorTokens = set.n;
        note(pendingBudgetLine('max-generator-tokens', String(set.n)));
        json?.sessionBudget({ setting: 'limits.maxGeneratorTokens', from: String(config?.limits().maxGeneratorTokens ?? ''), to: String(set.n), appliesTo: 'next' }, ctx);
        return;
      case 'max-wall':
        pending.maxWall = { ms: set.ms, text: set.text };
        note(pendingBudgetLine('max-wall', set.text));
        json?.sessionBudget({ setting: 'limits.maxWallMs', from: String(config?.limits().maxWallMs ?? ''), to: String(set.ms), appliesTo: 'next' }, ctx);
        return;
    }
  }

  /**
   * TUI-DESIGN-4 §3.3: the ONE pending list — the `<set>` echo, `/budget`'s `pending` rule and `/cost`'s pending
   * rows read the same keys in the same order. (`pendingLines`, the repeated-parenthetical form, is gone: the
   * `(next /resume or run)` clause is the rule caption now, stated once.)
   */
  function pendingBudgetPairs(): { setting: string; value: string }[] {
    const out: { setting: string; value: string }[] = [];
    if (pending.spendCapUsd !== undefined) out.push({ setting: 'spend-cap', value: pending.spendCapUsd.toFixed(2) });
    if (pending.maxSteps !== undefined) out.push({ setting: 'max-steps', value: String(pending.maxSteps) });
    if (pending.maxWall !== undefined) out.push({ setting: 'max-wall', value: pending.maxWall.text });
    if (pending.maxReplans !== undefined) out.push({ setting: 'max-replans', value: String(pending.maxReplans) });
    if (pending.maxGeneratorTokens !== undefined) out.push({ setting: 'max-generator-tokens', value: String(pending.maxGeneratorTokens) });
    if (pending.model !== undefined) out.push({ setting: 'model', value: pending.model });
    if (pending.provider !== undefined) out.push({ setting: 'provider', value: pending.provider });
    if (pending.mode !== undefined) out.push({ setting: 'mode', value: pending.mode });
    return out;
  }

  // --- the inspect blocks (§5.2, §7.6, §9.6) ------------------------------------------------------
  function currentStep(): number {
    return current?.steps ?? lastFinishedRun()?.steps ?? 0;
  }

  function costCommand(): void {
    const cfg = config;
    const run = current ?? lastFinishedRun();
    const spent = run ? (run.endedAt === null ? lastStatus?.spend.totalUsd ?? 0 : run.costUsd.generator + run.costUsd.jev) : 0;
    const genUsd = run ? (run.endedAt === null ? lastStatus?.spend.generator.costUsd ?? 0 : run.costUsd.generator) : 0;
    const jevUsd = run ? (run.endedAt === null ? lastStatus?.spend.jev.costUsd ?? 0 : run.costUsd.jev) : 0;
    const records = run?.records ?? [];
    const questions = lastResult?.jevQuestions ?? decisions.length;
    const latencies = decisions.map((d) => d.latencyMs);
    const p50 = latencies.length > 0 ? [...latencies].sort((x, y) => x - y)[Math.floor(latencies.length / 2)] ?? null : null;
    let tablePriced = false;
    try {
      tablePriced = cfg?.generator().priced === true;
    } catch {
      tablePriced = false;
    }
    const mode = pending.mode ?? baseMode;
    const chatStats = ledger.stats();
    // TUI-DESIGN-4 §3.3 / F-B2: kv rows at the 10-cell key column; `1 run`, `$0.000006 each`, the §3.1.7 empty state
    const rows = costRows({
      mode,
      run: run ? { spentUsd: spent, capUsd: runCapUsd, perStepUsd: records.map((r) => r.usage.generator.costUsd + r.usage.jev.costUsd) } : null,
      session: { spentUsd: sessionTotal(), capUsd: sessionCapOf(), runs: runs.filter((r) => r.endedAt !== null).length },
      gen: run ? { usd: genUsd, tablePriced } : null,
      jev: run ? { usd: jevUsd, questions, p50Ms: p50 } : null,
      basis: { generator: mode === 'jev-only' ? null : tablePriced ? 'table' : 'provider usage.cost', jev: 'provider usage.cost' }, // llm-jev pays a generator: non-null like jev-on
      pending: pendingBudgetPairs(),
      ...(flags.allowUnpriced ? { unpriced: true } : {}),
    // TUI-DESIGN-2 §3.9 / §12: the intake ledger's own `chat` row rides the same builder
    }, { messages: chatStats.messages, costUsd: chatStats.costUsd, p50Ms: chatStats.p50Ms });
    // TUI-DESIGN-3 §5.1 rule 5 (R5 F6, S5's row): the head is the noun `cost`; every data row (the run line first) is the body
    block('cost', rows);
  }

  function jevCommand(): void {
    const resolved = lastResult?.resolvedJevModel ?? null;
    const drift = lastResult?.jevModelDrift ?? null;
    const configured = deciderModelConfigured ?? (() => {
      try {
        return config?.decider().model ?? '—';
      } catch {
        return '—';
      }
    })();
    const latencies = decisions.map((d) => d.latencyMs);
    const p = (q: number): string => {
      const s = [...latencies].sort((x, y) => x - y);
      const v = s.length === 0 ? null : s[Math.min(s.length - 1, Math.max(0, Math.ceil((q / 100) * s.length) - 1))];
      return v === null || v === undefined ? '—' : `${Math.round(v)} ms`;
    };
    const jevUsd = lastResult?.usage.jev.costUsd ?? lastStatus?.spend.jev.costUsd ?? 0;
    const questions = lastResult?.jevQuestions ?? decisions.length;
    const chat = ledger.stats();
    // TUI-DESIGN-2 §2.6 line 1: `<provider> · <host> · <model> (pinned|alias)` — the provider and the host the session reaches Jev
    // through; the mock decider and a keyless / invalid decider section fall back to today's `decider <configured id>`
    // TUI-DESIGN-4 §3.3: the row's KEY is `decider`, so the value never repeats the word
    const head = ((): string => {
      if (!config || flags.mock) return configured;
      try {
        const d = config.decider();
        return `${d.provider} · ${new URL(d.baseUrl).host} · ${d.model} (${d.pinned ? 'pinned' : 'alias'})`;
      } catch {
        return configured;
      }
    })();
    // TUI-DESIGN-4 §3.3: kv rows `decider` / `latency` / `cost` / `intake`; §3.1.7's sentence before any decision
    const jevRows: BlockRow[] = [];
    if (questions === 0 && decisions.length === 0 && chat.messages === 0) {
      // §3.1.7: an empty state REPLACES the data rows — printing `decider not resolved yet` above a resolved
      // `decider` row and a `p50 — · p95 —` latency row said both things at once
      block('jev', [{ kind: 'note', flush: true, text: 'decider not resolved yet — the first question resolves it' }]);
      return;
    }
    jevRows.push({ kind: 'kv', key: 'decider', value: `${head}${resolved ? ` ${glyphs().arrow} resolved ${resolved}` : ''}${drift ? ` · drift@step ${drift.step} ${glyphs().arrow} ${drift.served}` : ''}` });
    jevRows.push({ kind: 'kv', key: 'latency', value: `p50 ${p(50)} · p95 ${p(95)}` });
    jevRows.push({ kind: 'kv', key: 'cost', value: jevCostValue(usd3(jevUsd), questions, jevCacheHitsOf((current ?? lastFinishedRun())?.records ?? [])) });
    // TUI-DESIGN-2 §2.6 / §12: `intake: <n> messages · p50 <ms> ms · $<usd> · last: <kind> <p>`
    if (chat.messages > 0) {
      const segs = [`${chat.messages} message${chat.messages === 1 ? '' : 's'}`, `p50 ${chat.p50Ms === null ? '—' : `${Math.round(chat.p50Ms)} ms`}`, stepCostText(chat.costUsd)];
      // TUI-DESIGN-3 §10 (S5's row 3, D-M local text): the kind in words, the probability in parentheses
      if (chat.last) segs.push(`last ${chat.last.kind.replaceAll('_', ' ')} (${chat.last.probability.toFixed(2)})`);
      jevRows.push({ kind: 'kv', key: 'intake', value: segs.join(' · ') });
    }
    block('jev', jevRows);
  }

  function statusCommand(): void {
    const run = current ?? lastFinishedRun();
    const g = gitAtStart;
    const gitText = g === null ? 'unknown' : !g.repo ? 'none' : g.head === null ? 'no HEAD' : g.head.kind === 'branch' ? g.head.name : g.head.kind === 'detached' ? g.head.oid.slice(0, 8) : `${g.head.name} (unborn)`;
    const stage = live() ? lastStatus?.stage ?? phase : 'idle';
    // TUI-DESIGN-4 §3.3 / F-B1: kv rows `run` `session` `step` `workspace` `sandbox`, with `shortPath` on the path
    const stop = run?.stopReason ?? null;
    const exit = run?.exitCode !== null && run?.exitCode !== undefined ? ` (exit ${run.exitCode})` : '';
    // F-B1: `· no git repository` reads as a sentence where `· git none` read as a branch called `none`
    const gitSegment = g !== null && !g.repo ? 'no git repository' : `git ${gitText}`;
    block('status', [
      // §3.1.5: `run` and `session` carry IDENTIFIERS — they are never elided, the row wraps instead
      { kind: 'kv', key: 'run', value: `${run?.runId ?? '—'}${stop === null ? '' : ` · ${stop}${exit}`}`, id: true },
      { kind: 'kv', key: 'session', value: `${sessionId ?? '—'}${title !== null ? ` "${title}"` : ''} · ${runs.length} run${runs.length === 1 ? '' : 's'} · ${usd3(sessionTotal())}`, id: true },
      { kind: 'kv', key: 'step', value: `${currentStep()} of ${lastStatus?.maxSteps ?? config?.limits().maxSteps ?? '—'} · ${stage}` },
      { kind: 'kv', key: 'workspace', value: `${shortPath(workspaceRoot, { root: workspaceRoot, home, width: Math.max(1, bodyWidth() - 11), measure: cellWidth })} · ${gitSegment}` },
      { kind: 'kv', key: 'sandbox', value: `${config ? detectSandboxLevel(config.sandbox) : '—'} · lock ${live() ? 'held' : 'released'}` },
    ]);
  }

  function decisionsCommand(n: number, stage: Decision['stage'] | null): void {
    // TUI-DESIGN-3 §4.4 F6: before a run (step 0) the last intake's rows are the decisions (identity with the TUI's pane by construction)
    const pool: readonly Decision[] = currentStep() === 0 && decisions.length === 0 ? (chatIntakes.at(-1) ?? []) : decisions;
    const rows: DecisionRow[] = pool
      .filter((d) => stage === null || d.stage === stage)
      .slice(-n)
      .map((d) => toDecisionRow(d, config?.limits().completeThreshold, config?.limits().impossibleThreshold));
    const lines = decisionRows({ tab: 'd', step: currentStep(), rows, plan: null, timeline: [], synth: null, mode: pending.mode ?? baseMode }, Math.max(1, rows.length), bodyWidth(), glyphs());
    textBlock(rows.length === 0 ? 'decisions' : `decisions · last ${rows.length}`, rows.length === 0 ? ['no decisions yet — they appear from the first step'] : lines);
  }

  function planCommand(): void {
    const plan = lastPlan ?? lastResult?.finalPlan ?? null;
    const lines = planRows({ tab: 'p', step: currentStep(), rows: [], plan: plan ? { step: currentStep(), plan } : null, timeline: [], synth: null }, BLOCK_CAPS.plan, bodyWidth(), glyphs());
    textBlock('plan', plan === null ? ['no plan yet — Jev writes one at the first step'] : lines, { max: BLOCK_CAPS.plan });
  }

  function whyCommand(ref: string): void {
    const parsed = parseWhyRef(ref);
    if (parsed === null) {
      // TUI-DESIGN-3 §4.4 F8: one failure text for both renderers (`whyErrorText`, src/tui/why.ts)
      uiError(whyErrorText(ref, 'grammar'));
      return;
    }
    // TUI-DESIGN-2 §3.11: `intake[.<id>]` addresses the last intake's step-0 rows (they belong to no run, so never to `decisions`)
    const pool: readonly Decision[] = parsed.kind === 'intake' ? (chatIntakes.at(-1) ?? []) : decisions;
    const d = findDecision(pool, parsed, currentStep() > 0 ? currentStep() : null);
    if (d === null) {
      uiError(whyErrorText(ref, 'missing'));
      return;
    }
    const model = parsed.kind === 'intake' ? (lastDecider?.model ?? null) : (lastResult?.resolvedJevModel ?? null);
    const lines = whyBlock(d, { siblings: pool.filter((x) => x.step === d.step), model }, glyphs(), bodyWidth());
    // §3.1.5: `/why`'s cap IS `WHY_MAX_LINES`, which `whyBlock` already applied with its own omission marker —
    // and a footer pointing at the very command that produced the block is a dead end (§12 lists no such string)
    textBlock(lines[0] ?? 'why', lines.slice(1), { max: BLOCK_CAPS.why });
  }

  async function calibrationCommand(): Promise<void> {
    if (!config) return;
    const scan = await scanCalibration(config.runsDir);
    const lines = calibrationBlock(calibrationStats(scan.runs), glyphs(), bodyWidth());
    textBlock(lines[0] ?? 'calibration', lines.slice(1), { max: BLOCK_CAPS.calibration });
  }

  async function reportCommand(): Promise<void> {
    const cfg = config;
    const run = lastFinishedRun();
    if (!cfg || !run) {
      // §3.1.7: an empty state is a sentence, not an error
      note('nothing to report yet — a run has to finish first');
      return;
    }
    try {
      const r = await writeReportBundle({ runDir: run.runDir, runId: run.runId, out: join(jdir, 'reports', run.runId), redact: cfg.redact, configJson: { ...cfg.record(), sandboxLevel: { value: detectSandboxLevel(cfg.sandbox), source: 'derived' } }, term: env['TERM'] ?? null, termProgram: env['TERM_PROGRAM'] ?? null, columns: columns(), rows: null, fallbackLog: log.file !== '' ? log.file : null });
      // §3.4: the bundle directory is `~`-abbreviated and left-elided, never split mid-run-id
      note(`report written to ${shortPath(r.dir, { root: workspaceRoot, home, width: bodyWidth(), measure: cellWidth })} (${r.files.length} files; redacted bundle written locally; nothing is sent)`);
    } catch (e) {
      uiError(`/report — ${redact(describe(e))}`);
    }
  }

  async function logoutCommand(which: 'generator' | 'jev' | null): Promise<void> {
    const cfg = config;
    if (!cfg) return;
    // TUI-DESIGN-3 §4.4 F16: the session adds the `[setup]` label once — the command prints bare items
    const code = await logoutFn(
      { ...(which === 'generator' ? { generator: true } : {}), ...(which === 'jev' ? { jev: true } : {}), ...(flags.config !== undefined ? { config: flags.config } : {}) },
      {
        stdin: process.stdin,
        stdout: { write: (s: string) => note(String(s).trimEnd(), { label: '[setup]' }) },
        stderr: { write: (s: string) => warnLine(String(s).replace(/^jevcode: /, '').trimEnd()) },
        env,
        home,
        cwd,
        resolveSecrets: async () => {
          const m = new Map<string, { value: string; source: import('../core/types.js').ConfigSource }>();
          for (const name of ['generator.apiKey', 'decider.apiKey'] as const) {
            const r = cfg.entries.get(name);
            if (r) m.set(name, r);
          }
          return m;
        },
      },
      { labelled: false },
    );
    if (code === EXIT_CODES.ok) await reresolve();
  }

  async function resumeOrFollowUp(runId: string, force: boolean): Promise<void> {
    const row = index.find((s) => s.runs.some((r) => r.runId === runId));
    const run = row?.runs.find((r) => r.runId === runId) ?? null;
    const known = runs.find((r) => r.runId === runId) ?? null;
    const stop = known?.stopReason ?? run?.stopReason ?? null;
    if (stop === 'complete' && !force) {
      // §5.2: a complete run seeds a follow-up unless --force: adopt its session and let the next prompt seed from it
      const sid = row?.sessionId ?? known?.runId ?? runId;
      if (sessionId !== sid) {
        sessionId = sid;
        runs = [];
        title = row?.title ?? null;
        newSessionMeter();
        seedMeterFromIndex(sid, '');
      }
      note(`session ${sid} continues: run ${runId} is complete, so type a follow-up (/resume ${runId} --force resumes it)`);
      return;
    }
    await resumeRun(runId, force);
  }

  async function pickerCommand(sort: 'updated' | 'created', force: boolean): Promise<void> {
    const rows = sessionRows();
    if (prompter?.picker) {
      const picked = await prompter.picker(rows, { sort, workspace: workspaceRoot });
      if (picked) await resumeOrFollowUp(picked.runId, force);
      return;
    }
    const lines = pickerRows(rows, { workspace: workspaceRoot, widened: false, nowMs: now(), columns: bodyWidth(), sort, ascii: o.launch.ascii });
    if (lines.length === 0) {
      // §3.1.7: `noSessionMessage` is kept and gains the thing to do next
      note(`${noSessionMessage(workspaceRoot)} — start one by typing a task`);
      return;
    }
    textBlock(pickerHeader({ workspace: workspaceRoot, widened: false, sort, columns: bodyWidth(), ascii: o.launch.ascii }), [...lines, 'continue one with /resume <id|title>']);
  }

  async function exitCommand(): Promise<void> {
    if (!live()) {
      host.exit(0);
      return;
    }
    // §3.3 / §13.5: `/exit` while live confirms first; [y] aborts, waits for run:end and exits 0 (`--exit-code=last-run`: the aborted run's code)
    const yes = prompter?.exitConfirm ? await prompter.exitConfirm() : !o.interactive;
    if (!yes || exiting) return;
    host.exit(0);
  }

  async function execute(a: CommandAction): Promise<void> {
    switch (a.kind) {
      case 'help':
        if (a.topic === 'reload') {
          const p = keybindingsPath(env, flags.keybindings ?? null, home);
          try {
            keybindings = loadKeybindingsFn(p);
            for (const w of keybindings.warnings) log.warn(w);
            // TUI-DESIGN-3 §4.4 F10: the reloaded table reaches the App (its `resolveKey` and `helpLines` read it)
            renderer.setBindings?.(keybindings.bindings);
            note(`keybindings reloaded from ${p}${keybindings.found ? '' : ' (no file: defaults)'}${keybindings.warnings.length > 0 ? ` · ${keybindings.warnings.length} warning${keybindings.warnings.length === 1 ? '' : 's'} in jevcode.log` : ''}`);
          } catch (e) {
            uiError(`/help reload — ${describe(e)}`);
          }
          return;
        }
        // TUI-DESIGN-3 §4.4 F9: ONE help formatter (src/tui/commands/palette.ts) for the TUI, --plain and the log; `columns()` on a pipe = 80
        textBlock('help', paletteHelpLines(bodyWidth(), { topic: a.topic, live: live(), ...(o.launch.ascii ? { ascii: true } : {}), ...(keybindings ? { bindings: keybindings.bindings } : {}) }));
        return;
      case 'new': {
        const old = sessionId;
        // TUI-DESIGN-3 §4.4 F12: before any session there is nothing to end — say so instead of nothing
        if (old === null) {
          note(NO_SESSION_YET);
          return;
        }
        note(sessionEndedText(old, runs.length, sessionTotal()));
        sessionId = null;
        sessionStartAnnounced = false;
        runs = [];
        title = null;
        undoNotes = [];
        undoLog = [];
        rewindSeed = null;
        newSessionMeter();
        return;
      }
      case 'resume':
        if (a.target.kind === 'picker') await pickerCommand(a.sort, a.force);
        else if (a.target.kind === 'continue') {
          const s = mostRecentSession(sessionRows(), workspaceRoot);
          const id = s ? newestRunId(s) : null;
          if (id === null) uiError(`/continue — ${noSessionMessage(workspaceRoot)} — start one by typing a task`);
          else await resumeOrFollowUp(id, a.force);
        } else await resumeOrFollowUp(a.target.id, a.force);
        return;
      case 'rename': {
        title = text60(a.title, redact);
        extras.setTitle?.(title);
        if (sessionId) indexLine({ v: 1, t: nowIso(), kind: 'rename', sessionId, title60: title });
        // TUI-DESIGN-3 §4.4 F13: a cut title says so
        note(`renamed the session to "${title}"${a.title.length > 60 ? RENAME_CUT_NOTE : ''}`);
        return;
      }
      case 'steer': {
        const r = host.steer(a.text, { secretSpans: [] });
        if (!r.ok) uiError(STEER_ERRORS[r.reason === 'full' ? 'full' : r.reason === 'finished' ? 'finished' : 'empty']);
        return;
      }
      case 'unsteer':
        if (host.unsteer() === null) uiError(COMMAND_ERRORS.unsteerEmpty);
        return;
      case 'pause':
        host.pause();
        return;
      case 'abort':
        host.abort('human_abort');
        return;
      case 'undo':
        await undoCommand(a.step);
        return;
      case 'rewind':
        await rewindCommand(a.step);
        return;
      case 'diff':
        await diffCommand(a);
        return;
      case 'plan':
        planCommand();
        return;
      case 'decisions':
        decisionsCommand(a.n, a.stage);
        return;
      case 'why':
        whyCommand(a.ref);
        return;
      case 'calibration':
        await calibrationCommand();
        return;
      case 'jev':
        jevCommand();
        return;
      case 'cost':
        costCommand();
        return;
      case 'budget':
        budgetCommand(a);
        return;
      case 'model': {
        // TUI-DESIGN-3 §4.4 F15: the show form, the jev-only cross-check, and a soft warning when the id's shape does not fit the provider
        const id: string | null = a.id;
        const nextMode = pending.mode ?? baseMode;
        if (id === null || id.trim() === '') {
          const currentModel = generatorModelLabel();
          note(pending.model !== undefined && pending.model !== currentModel ? `model ${currentModel} (next run: ${pending.model})` : `model ${currentModel}`);
          /**
           * §6.4 D-AQ (R4b): the TUI opens the pane-slot picker here (`App.tsx`'s `case 'model'`), so this is its
           * `--plain` twin — the numbered one-shot list and its prompt, from the same producers the picker uses,
           * never a pane. Everything is bundled and offline: `instantCatalogue()` costs no I/O.
           */
          const models = await import('../models/index.js');
          const { MODELS_PLAIN_CAP, modelsPickPrompt, modelsPlainLines } = await import('../tui/models/lines.js');
          const { snapshotResults } = await import('../tui/models/state.js');
          const catalogue = models.instantCatalogue();
          const lines = modelsPlainLines({ models: catalogue, text: models, results: snapshotResults(catalogue, models.SNAPSHOT_AT), total: catalogue.length, columns: bodyWidth(), glyphs: glyphs(), prompt: false });
          textBlock(lines[0] ?? 'models', lines.slice(1));
          note(modelsPickPrompt(Math.min(catalogue.length, MODELS_PLAIN_CAP)), { label: '[ui]' });
          return;
        }
        pending.model = id;
        const provider = pending.provider ?? (config ? providerOfConfig(config) : null) ?? 'openrouter';
        const shape = provider === 'openrouter' && !id.includes('/') ? ' — OpenRouter ids read <vendor>/<model>' : provider === 'anthropic' && id.includes('/') ? ' — Anthropic ids carry no vendor prefix' : '';
        note(`model ${id} pending (next run)${nextMode === 'jev-only' ? GENERATOR_IGNORED_NOTE : shape}`);
        return;
      }
      case 'provider': {
        const provider: 'anthropic' | 'openrouter' | null = a.provider;
        const nextMode = pending.mode ?? baseMode;
        if (provider === null) {
          const currentProvider = (config ? providerOfConfig(config) : null) ?? 'openrouter';
          note(pending.provider !== undefined && pending.provider !== currentProvider ? `provider ${currentProvider} (next run: ${pending.provider})` : `provider ${currentProvider}`);
          return;
        }
        pending.provider = provider;
        note(`provider ${provider} pending (next run)${nextMode === 'jev-only' ? GENERATOR_IGNORED_NOTE : ''}`);
        return;
      }
      case 'mode': {
        // TUI-DESIGN-2 §1.3 / TUI-DESIGN-3 §4.4 F1: no argument shows the current and the next run's mode in two forms — one word when they agree
        // (` (default)` after the word equal to MODE_BADGE_WORD[DEFAULT_MODE], D-N), else `mode <cur> — next run: <next>`; with one, pends it
        const cur = live() && current !== null ? currentRunMode : baseMode;
        const next = pending.mode ?? baseMode;
        if (a.mode === null) {
          const dflt = (m: EngineMode): string => (m === DEFAULT_MODE ? ' (default)' : '');
          note(cur === next ? `mode ${modeBadgeWord(cur)}${dflt(cur)}` : `mode ${modeBadgeWord(cur)} — next run: ${modeBadgeWord(next)}${dflt(next)}`);
          return;
        }
        if (a.mode === next) {
          note(`mode ${modeBadgeWord(a.mode)} already`);
          return;
        }
        if (config && config.missingSecrets(a.mode).length > 0) {
          const saved = await runLogin('mode', a.mode);
          if (!saved) {
            note(`mode stays ${modeBadgeWord(next)} — no generator key was saved`, { level: 'warn' });
            return;
          }
        }
        pending.mode = a.mode;
        extras.dispatch?.({ type: 'mode', mode: live() && current !== null ? currentRunMode : baseMode, pending: a.mode });
        note(modeSetItem(a.mode));
        return;
      }
      case 'config': {
        if (!config) return;
        // TUI-DESIGN-4 §3.3: the three-column table at the block body width, the fold footer, the §7.5 problems,
        // and `session.spendCapUsd effective …` as a kv row INSIDE the table instead of a trailing line
        const rec = { ...config.record(), 'session.spendCapUsd.effective': { value: usd2(sessionCapOf()), source: 'derived' } };
        const cb = configBlock(rec, {
          sandboxLevel: detectSandboxLevel(config.sandbox),
          width: bodyWidth(),
          glyphs: glyphs(),
          // §3.4: `/config` is a `shortPath` consumer — `workspace` prints `~/T/a3-ws-eO2WYu` (F-B3)
          home,
          // REQUEST to S4 (§9.2 `registry.ts` row): `/config --all` needs the `--all` FLAG SPEC so `CommandAction`
          // carries it; `configTableRows`/`configBlock` already take `{ all }`. Until then the block folds.
          ...(config.unknownFileKeys !== undefined && config.unknownFileKeys.length > 0 ? { unknownFileKeys: config.unknownFileKeys } : {}),
        });
        // §3.3 / §3.1.5: the builder's pinned columns and its protected sandbox tail travel WITH the rows, so the
        // TUI block and `jevcode config` draw one geometry for one record and the cap can never eat §12's footer
        block(cb.head, cb.rows, { max: BLOCK_CAPS.config, moreFooter: `${glyphs().ellipsis} +{n} more rows (/config --all)`, tableCols: cb.tableCols, protectTail: cb.protectTail });
        return;
      }
      case 'login':
        await runLogin('login');
        return;
      case 'logout':
        await logoutCommand(a.which);
        return;
      case 'trust': {
        // TUI-DESIGN-3 §4.4 F17: Esc / Ctrl-C on the card close it — the old decision stands and is not printed as new
        const decided = await trustGate(true);
        if (!decided) {
          note(`trust unchanged (${trustDecision ?? 'none'})`, { label: '[config]' });
          return;
        }
        note(trustDecision === 'none' ? 'workspace not trusted: instruction files are ignored' : `workspace trusted (${trustDecision})`, { label: '[config]' });
        return;
      }
      case 'theme':
        themeOverride = a.theme;
        if (uiConfig) {
          uiConfig = { ...uiConfig, theme: a.theme };
          renderer.setUi?.(uiConfig);
        }
        note(`theme ${a.theme} (new items and the dynamic region only)`);
        return;
      case 'copy': {
        if (a.what === 'draft') {
          uiError(COMMAND_ERRORS.copyDraft);
          return;
        }
        // TUI-DESIGN-3 §4.4 F7: `/copy diff` copies the diff exactly as `/diff` builds it (the App asks the host), never the last item
        const text = a.what === 'last' ? lastItemText : a.what === 'proposal' ? lastProposalText : await diffTextForCopy();
        if (text === null) {
          uiError(`/copy ${a.what} — nothing to copy yet — run a step, or pick another /copy target`);
          return;
        }
        const r = await copyFn(text, redact, { ...(uiConfig?.osc52 ? { osc52: true } : {}) });
        note(r.toast, { level: r.ok ? 'info' : 'error' });
        return;
      }
      case 'panel': {
        // TUI-DESIGN-3 §4.4 F3: the TUI keeps every spelling App-local (only a line typed while the wizard owns the input reaches here);
        // `--plain` prints the rows of the requested tab
        if (o.rendererKind === 'tui') {
          note(PANEL_HANDLED_BY_TUI, { level: 'warn' });
          return;
        }
        const tab = a.panel === 'd' || a.panel === 'p' || a.panel === 't' || a.panel === 's' ? a.panel : 'd';
        const limits = config?.limits();
        const rows = decisions.map((d) => toDecisionRow(d, limits?.completeThreshold, limits?.impossibleThreshold));
        const chatRows = chatIntakes.flat().map((d) => toDecisionRow(d, limits?.completeThreshold, limits?.impossibleThreshold));
        const plan = lastPlan ?? lastResult?.finalPlan ?? null;
        const state: PaneState = { tab, step: currentStep(), rows, plan: plan ? { step: currentStep(), plan } : null, timeline: [], synth: null, mode: pending.mode ?? baseMode, chatRows };
        const size = a.panel === 'full' ? 'full' : 'open';
        const lines = panelLines(state, size === 'full' ? 12 : 6, bodyWidth(), 'none', { size, glyphs: glyphs() });
        textBlock(`panel · ${tab}`, lines.length > 0 && rows.length + chatRows.length > 0 ? lines : ['no decisions yet — they appear from the first step']);
        return;
      }
      case 'transcript':
        // TUI-DESIGN-3 §4.4 F3: the view is the App's; `--plain` is always full
        note(o.rendererKind === 'tui' ? PANEL_HANDLED_BY_TUI.replace('panel', 'transcript') : TRANSCRIPT_ALWAYS_FULL, o.rendererKind === 'tui' ? { level: 'warn' } : {});
        return;
      case 'export':
        await exportCommand(a.file);
        return;
      case 'status':
        statusCommand();
        return;
      case 'errors':
        // §3.1.7: an empty state is a SENTENCE in the body, never a parenthesis-only fragment; §3.1.5 caps /errors at 12
        block('errors', errors.length > 0 ? errors.map((e) => ({ kind: 'note' as const, flush: true as const, text: e })) : [{ kind: 'note', flush: true, text: 'nothing to report — no warnings or errors this session' }], { max: BLOCK_CAPS.errors });
        // TUI-DESIGN-3 §4.4 F18: reading the errors acknowledges the `!n` marker like Ctrl+O does
        try {
          extras.dispatch?.({ type: 'ack-errors' });
        } catch {
          /* the renderer is gone */
        }
        return;
      case 'report':
        await reportCommand();
        return;
      case 'historyClear': {
        const yes = prompter?.historyClear ? await prompter.historyClear() : !o.interactive;
        if (!yes) return;
        const kept = history?.entries('all').length ?? 0;
        history?.clear();
        // TUI-DESIGN-4 §3.1.7 / §12: an empty state says what happened, with the number
        note(`history cleared — ${kept === 0 ? '0 entries kept' : `${kept} entries dropped`}`);
        return;
      }
      // --- TUI-DESIGN-4: the four commands round 4 adds (37 → 41), §1.3.1, §1.3.4, §7.1, §7.10 -------------------
      case 'peers': {
        // §7.10 item 2: a block, never a pid and never a path. The registry is docs/COORDINATION-DESIGN.md's; until
        // `SessionHost.peers()` has one behind it this is the declared stub row, so `/peers` is never a dead command.
        // `SessionHost.peers()` (contract 1.7 item 9) is this controller's own hook; null until a registry drives it
        const view = host.peers?.() ?? null;
        const offReason = coordinationReason();
        if (view === null) {
          /**
           * gap 1 / §12.1 (fix pass, finding 8): **two different states, two different sentences.**
           *
           * `the peer registry is not available in this build` was the base of BOTH, so the commonest case of
           * all — coordination on, home writable, the ledger simply not open yet — told the user the feature was
           * missing from the build while `/who` two lines away answered the honest "not open yet". The build
           * sentence is now reserved for a reason that is genuinely true of it; `peersNotOpenText` is the same
           * string the chat `peers` fact prints for `view === null`, so the two cannot drift.
           */
          block(`peers ${glyphs().dot} unknown`, [{ kind: 'note', flush: true, text: offReason === null ? peersNotOpenText(o.launch.ascii) : coordinationOffText(PEERS_UNAVAILABLE_TEXT, offReason) }]);
          return;
        }
        if (view.live === 0 && view.stale === 0) {
          /**
           * §12.1 (fix pass, finding 5): the empty state carries the DOT like every other §12.1 head. Without it
           * `/peers` was the one block head in the file with no ` · ` in it, and the `r5-who` smoke scenario's
           * `expect peers [·-]` step could never match — the scenario hard-timed out at exit 124 and went out
           * unmeasured. The counts are the head, the sentence is the body, exactly as the non-empty branch.
           */
          block(`peers ${glyphs().dot} 0 here, 0 stale`, [{ kind: 'note', flush: true, text: 'no other jevcode is working in this workspace' }]);
          return;
        }
        /**
         * §2.4: TD4 §7.10's per-peer kv rows (`workspace`, `started <t> ago`, `<state>`) are **superseded, not
         * kept** — `PeerView`'s four scalars cannot produce them, `/who` (S1–S5) answers them instead, and the
         * `workspace` row was in any case always the literal `.` (`shortPath(p, { root: p })`,
         * `src/core/text.ts:95`). What survives is TD4's head, its empty state and the pointer at `/who`.
         */
        const ago = view.oldestStartedMsAgo === null ? '—' : formatDuration(view.oldestStartedMsAgo);
        const dot = glyphs().dot;
        const counts = [`${view.live} here`, `${view.stale} stale`];
        if (view.oldestStartedMsAgo !== null) counts.push(`the oldest started ${ago} ago`);
        if (view.exclusive) counts.push('one holds an exclusive lease');
        block(`peers ${dot} ${view.live} here, ${view.stale} stale`, [
          { kind: 'facts', segments: counts },
          { kind: 'note', flush: true, text: `/who shows what each is doing${view.stale > 0 ? ' — /who --all includes sessions gone more than 10 minutes' : ''}` },
        ]);
        return;
      }
      case 'uiReset': {
        // §7.1: clears every `guard()` pane latch. The latches live in `App.tsx` (S1/S6); the renderer answers with
        // the count it unlatched, and a renderer without the hook answers `nothing was latched`.
        // REQUEST to S1/S6 (§9.2 `App.tsx` row): `RendererDispatch` needs a `{ type: 'ui-reset' }` member that
        // clears every `guard()` pane latch and answers with the count. Until then this reports the honest zero.
        const unlatched = 0;
        note(unlatched > 0 ? `ui reset — ${unlatched} panes unlatched` : 'nothing was latched');
        return;
      }
      case 'fullscreen': {
        // §1.3.1 / §3.3: it never switches in place — `render()` is called once per stdout — so it PERSISTS
        // `ui.renderer` and only then offers the relaunch. Announcing a state change that did not happen is the
        // one thing this command may not do (its sibling `/ui reset` was made honest in the same round).
        const spec = SETTINGS.find((sp) => sp.name === 'ui.renderer');
        const fileKey = spec?.fileKey;
        if (fileKey === undefined) {
          uiError('/fullscreen — ui.renderer cannot be stored in the config file — pass --renderer fullscreen at launch');
          return;
        }
        try {
          const r = await writeConfigValueFn(fileKey, 'fullscreen', { env, home, cwd, configFlag: flags.config ?? null });
          note(`fullscreen is set for the next launch (file:${r.displayPath}) — run jevcode chat again (or jevcode config set ui.renderer classic to undo)`);
        } catch (e) {
          uiError(`/fullscreen — could not save ui.renderer: ${redact(describe(e))} — set it with jevcode config set ui.renderer fullscreen`);
        }
        return;
      }
      case 'scrollback': {
        // §1.3.4 / §12: under the classic renderer the terminal's own scrollback already holds the transcript
        note("/scrollback is a fullscreen command; your terminal's scrollback already has the transcript");
        return;
      }
      /**
       * TUI-DESIGN-5 §2.3 (R5-1): `/who` — the full activity view, one pure builder, four render targets. The rows
       * come from `SessionHost.who?()`, which is `null` until the ledger opens (§1.4 promise 1), so the empty state
       * is honest rather than a false zero.
       */
      case 'who': {
        const led = sessionLedger;
        /**
         * §2.3: `/who --all` adds the stale > 10-minute and ignored-device rows — the `opts.all` branch of
         * `listSessions` (`fold.ts:387`). `SessionHost.who?()` (§8.1 item 4, `src/core/types.ts:2381`, R5-2's
         * file) takes no argument, so it can only ever answer the `{ all: false }` list; the controller reads the
         * ledger it already holds when the flag is set, and falls back to the host hook otherwise. Without this
         * the `--all` branch was unreachable from the TUI by construction (round-5 fix pass, finding 6).
         */
        const rows = led !== null ? led.list({ all: a.all === true }).map(activityView) : (host.who?.() ?? null);
        if (rows === null) {
          // gap 1 / §12.1: `COORDINATION_NOT_OPEN` stays the PREFIX (round5.pty.test.ts pins it), and when the
          // ledger will never open in this configuration the clause says which of the two causes it is
          block(`who ${glyphs().dot} unknown`, [{ kind: 'note', flush: true, text: coordinationReason() === null ? `${COORDINATION_NOT_OPEN} — ${COORDINATION_IDLE_CLAUSE}` : coordinationOffText(COORDINATION_NOT_OPEN, coordinationReason()) }]);
          return;
        }
        // §12.1's SR column (S1–S5): `whoRowText` renders `whoSentence` in the screen-reader set (§14.2 #60)
        const g = whoGlyphSet();
        if (rows.length === 0) {
          block('who', [{ kind: 'note', flush: true, text: WHO_EMPTY }]);
          return;
        }
        const self = led === null ? { deviceId8: '', label: '', sameDeviceCount: 0 } : selfView(led.self, led.fold);
        const skipped = led?.fold.skipped ?? 0;
        block(whoHeader(rows, g), whoRows(rows, self, { all: a.all, width: bodyWidth(), g, skipped }));
        return;
      }
      /**
       * §2.9's four messaging verbs are R5-2's (`src/tui/commands/dispatch.ts` + the mailbox wiring). They are
       * REGISTERED from day one (D-AN: no dead pointers, no hidden rows) and answer honestly here until that wave
       * lands — the `/peers` precedent, and the reason `availabilityError` cannot express this refusal (§14.2 #16).
       */
      case 'inbox':
      case 'tell':
      case 'headsup':
      case 'request':
      case 'end':
        note(`/${a.kind} is not available in this build`, { label: '[session]', level: 'warn' });
        return;
      /**
       * TUI-DESIGN-5 §3.2 (D-AH): `/context` — ONE block from three reads that are already public. Reads 1 and 2
       * are `engine.status().context` and `engine.snapshotState()`; read 3 (the checkpoint store's
       * `readContextSummary()`) is omitted here and `contextBlock` degrades to `ContextUsage.summaryAt`, which is
       * the same row on every run whose engine has already re-read the file (§7 row 39 is the resume-timing edge
       * alone). Every empty state is `contextBlock`'s — §12 S54, S55 and S56, never a hand-written sentence.
       */
      case 'context': {
        const e = engine;
        const st = e?.status() ?? null;
        const snap = e?.snapshotState() ?? null;
        const b = contextBlock(
          {
            mode: pending.mode ?? baseMode,
            live: e !== null && live(),
            step: st?.step ?? null,
            ...(st?.context === undefined ? {} : { usage: st.context }),
            ...(snap?.fileCache === undefined ? {} : { files: snap.fileCache }),
            ...(snap?.fileMemory === undefined ? {} : { fileMemory: snap.fileMemory }),
            ...(snap?.history === undefined ? {} : { history: snap.history }),
          },
          columns(),
          glyphs(),
        );
        block(b.head, b.rows);
        return;
      }
      /**
       * TUI-DESIGN-5 §3.3: `/compact` — `Engine.compact()` returns `void` and emits its status synchronously, so
       * the answer is a before/after comparison of `status().context` across the call. `compactAnswer` returns
       * `null` for "say nothing": the count rose and the engine's own compaction notice (§3.4) already reported it
       * in all three sinks. `availabilityError` has already refused the no-run case (`availableDuringTask: 'live'`).
       */
      case 'compact': {
        const e = engine;
        if (e === null || typeof e.compact !== 'function') {
          note(contextNoRelaxed(pending.mode ?? baseMode, glyphs()), { label: '[ui]', level: 'warn' });
          return;
        }
        const before = e.status().context ?? null;
        e.compact();
        const answer = compactAnswer(before, e.status().context ?? null, pending.mode ?? baseMode, glyphs());
        if (answer !== null) note(answer, { label: '[ui]', level: 'warn' });
        return;
      }
      /**
       * TUI-DESIGN-5 §4.9 (D-AN): the agent tree's five rows are REGISTERED from day one — no dead pointers, no
       * hidden rows — and answer `notAvailableText` until `AgentSupervisor`'s store exists (§4.7). The refusal
       * names the USER-FACING verb, never an internal op name, and the dispatcher has already rejected a malformed
       * line, so a typo is a dispatch error here rather than a refusal that hides it.
       */
      case 'split':
      case 'agents':
      case 'agent':
      case 'land':
      case 'spawn':
        note(notAvailableText(`/${a.kind}`), { label: '[ui]', level: 'warn' });
        return;
      /**
       * TUI-DESIGN-5 §5.5: `/import` and `/memory` are registered with the same honesty rule. The import ENGINE is
       * built (`src/import/**`) and its CLI twin runs (`jevcode import`); what is not wired in this build is the
       * in-session review overlay, so the refusal points at the surface that works rather than denying the feature.
       */
      case 'import': {
        /**
         * TUI-DESIGN-5 §13.1 / §5.7 (R4a): ONE producer, two sinks. `App.tsx` intercepts `/import` and opens the
         * overlay, so this arm is the `--plain` (and `--screen-reader`) twin — the SAME `initImportUi` state,
         * printed as the numbered form. It must never be a second sentence.
         */
        const { planImport, summarisePlan, applicableRows } = await import('../import/index.js');
        const { initImportUi } = await import('../tui/import/reducer.js');
        const { IMPORT_DRY_RUN_REFUSAL, IMPORT_NOTHING_FOUND, importPlainLines, importScreenReaderLines } = await import('../tui/import/lines.js');
        const { gitRootOf } = await import('../tui/import/git-root.js');
        const plan = await planImport({
          env: { home, env, platform: process.platform, workspace: workspaceRoot, gitRoot: gitRootOf(workspaceRoot), extraRoots: [] },
          jevcodeVersion: VERSION,
          trust: 'session',
          decider: null,
          redact: config?.redact ?? patternRedact, // §5.4 item 1, exactly as the TUI twin passes it
          ...(a.source !== null ? { optIn: [a.source] } : {}),
        });
        if (plan.rows.length === 0) {
          note(IMPORT_NOTHING_FOUND, { label: '[ui]', level: 'warn' });
          return;
        }
        const input = { plan, summary: summarisePlan(plan), applicable: applicableRows(plan, { scope: 'both' }) };
        const ui = initImportUi(input);
        // §5.7: the prompt is printed only when something reads the answer, and nothing in this build does
        const rows = o.launch.screenReader === true ? importScreenReaderLines(ui, { prompt: false, input }) : importPlainLines(ui, input, bodyWidth(), glyphs(), { prompt: false });
        textBlock(rows[0] ?? 'Import', rows.slice(1));
        note(a.dryRun ? IMPORT_DRY_RUN_REFUSAL : 'jevcode import --yes applies this plan', { label: '[ui]' });
        return;
      }
      case 'memory':
        note('/memory is not available in this build — jevcode import brings memory in from the other agents', { label: '[ui]', level: 'warn' });
        return;
      case 'editor':
        uiError(COMMAND_ERRORS.editor);
        return;
      case 'exit':
        await exitCommand();
        return;
      default:
        // TUI-DESIGN-3 §4.4 F3: a `CommandAction['kind']` without a case is a type error, never a silent drop
        return assertNever(a);
    }
  }

  /** TUI-DESIGN-3 §4.4 F7: the diff text `/copy diff` copies — the stat block of the current or last run, exactly as `/diff` prints it; null with no run */
  async function diffTextForCopy(): Promise<string | null> {
    const cfg = config;
    const run = current ?? lastFinishedRun();
    if (!cfg || !run) return null;
    const git = await gitFacts();
    if (!git.git) return null;
    const sandbox = makeSandbox(cfg, run.runDir, git);
    if (!sandbox) return null;
    // §6.5: the SAME geometry `/diff` printed — `columns()` here made the copied text 10 cells wider than the
    // block on screen, and `DIFF_BAR_MIN_COLUMNS` / `DIFF_PADDED_COUNTS_MIN_COLUMNS` sit inside that 10-cell gap
    const r = await diffStatBlockFromGit({ sandbox, root: workspaceRoot, runId: run.runId, changedFiles: run.changedFiles, ...(git.unborn ? { unborn: true } : {}) }, bodyWidth());
    return r.lines.length > 0 ? r.lines.join('\n') : null;
  }

  async function runCommand(line: string): Promise<void> {
    const r = dispatchCommand(line, { ...host.dispatchContext(), run: phase });
    if (!r.ok) {
      note(r.text, { label: r.label, level: 'error' });
      return;
    }
    if (o.rendererKind !== 'tui') {
      const s = plainSupports(r.spec, r.action);
      if (!s.ok) {
        uiError(s.error);
        return;
      }
    }
    // §12.4 "all checks before the first write": a second mutating command while one is in flight is refused, never interleaved
    const exclusive = EXCLUSIVE_COMMANDS.has(r.action.kind);
    if (exclusive) {
      if (busyCommand !== null) {
        uiError(`/${r.spec.name} — another command is still running (/${busyCommand}) — wait for it to finish`);
        return;
      }
      busyCommand = r.spec.name;
    }
    try {
      await execute(r.action);
    } catch (e) {
      uiError(`/${r.spec.name} — ${redact(describe(e))}`);
      log.error(`/${r.spec.name} failed: ${describe(e)}`);
    } finally {
      if (exclusive && busyCommand === r.spec.name) busyCommand = null;
    }
  }

  // --- TUI-DESIGN-2 §3.8: the controller's submit path (the state machine of §3.1) ---------------------------------
  /** §3.10: one item per line through note() — `annotate()` while live, a renderer-local item while idle */
  function say(role: ChatRole, lines: readonly string[]): void {
    for (const l of lines) note(l, { label: CHAT_LABELS[role] });
  }
  /** §3.8 `thinking(phase)`: status `⠹ thinking` · `looking` · `replying`; null when the request settled */
  function thinking(phase: ThinkingPhase | null): void {
    if (phase === null && thinkingPhase === null) return; // nothing was in flight (a catalogue or facts reply): no dispatch
    thinkingPhase = phase;
    try {
      extras.dispatch?.({ type: 'thinking', phase });
    } catch {
      /* the renderer is gone */
    }
  }
  /** §3.8 `uiToast`: a toast in the TUI; the `--plain` renderer prints `(text)` as a bare line — never an item (TD §15.1) */
  function uiToast(text: string): void {
    if (o.rendererKind === 'tui') {
      try {
        extras.dispatch?.({ type: 'toast', text, level: 'info', ms: TOAST_INFO_MS });
      } catch {
        /* the renderer is gone */
      }
    } else if (o.rendererKind === 'plain') o.stdout.write(`(${text})\n`);
  }
  /** §3.8: the chat request in flight — one AbortController per submission (`converse` creates it); Ctrl-C ×1 while thinking, /exit, SIGINT/SIGTERM abort it */
  function abortChat(): void {
    const c = chatAbort;
    chatAbort = null;
    if (c !== null && !c.signal.aborted) c.abort(new AbortError('human_abort'));
  }
  /** an abort that landed while a pre-request step (`buildDecider`, `buildProvider`, the listing, a file read) was awaited: nothing paid goes out (finding 6) */
  function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new AbortError('human_abort');
  }
  const jsonCtx = (): JsonStreamContext => ({ runId: current?.runId ?? null, sessionId });

  /**
   * TUI-DESIGN-2 §3.8, conversational: every submission gets a STREAMED reply from the code model in JevCode's own
   * voice (`buildChatSystem`), and Jev's reading runs BESIDE it — in the background, never a card, never a block on
   * the composer. The reading only decides whether a run ALSO starts (`coding_task` → `ON_IT_LINE` + `startRun`),
   * whether the reply ends with the `do it` offer (`ambiguous`) or whether the reply is the whole answer. A reading
   * that fails or is still out after `INTAKE_GRACE_MS` is a log line: the reply already answered. `jev-only` has no
   * generator, so Jev's own answers (catalogue · facts · lookup) stand there — still without a card.
   */
  async function converse(text: string, so: { kind: 'prompt' | 'follow-up'; pinnedFiles: readonly string[]; secretSpans: readonly string[] }): Promise<SubmitOutcome> {
    if (exiting) return { became: 'nothing' };
    // §3.1 row 11: Enter while thinking is ignored with a toast; the draft keeps accepting text
    if (thinkingPhase !== null) {
      uiToast(STILL_THINKING_TOAST);
      return { became: 'nothing' };
    }
    if (live()) {
      uiError(RUN_LIVE_ERROR);
      return { became: 'nothing' };
    }
    if (!config) {
      uiError(CONFIG_NOT_READY);
      return { became: 'nothing' };
    }
    // the [you] bubble, always first: redacted at emission, one item per line (§3.10)
    say('you', bubbleLines(text, redact));
    // the offer left by the last `ambiguous` reading: `do it` starts that run with the reading already in hand — no request
    const offer = pendingOffer;
    pendingOffer = null;
    if (offer !== null && DO_IT_RE.test(text)) {
      say('jevcode', [ON_IT_LINE]);
      ledger.push({ role: 'jevcode', text: ON_IT_LINE, at: nowIso(), costUsd: 0 });
      thinking(null);
      return await startChatRun(offer.text, so, offer.intake);
    }
    const mode = pending.mode ?? baseMode;
    // the reply is the code model's in every mode but jev-only, where Jev answers alone
    const viaLlm = mode !== 'jev-only';
    // §3.1 row 2: the key the ANSWER needs (the generator's, or Jev's in jev-only) → the wizard once, then the error
    const needed: SecretSettingName = viaLlm ? 'generator.apiKey' : 'decider.apiKey';
    if (config.missingSecrets(mode).includes(needed)) {
      await runLogin('missing', mode);
      // read AFTER the wizard: persistCredentials → reresolve() replaced the object (finding 26)
      if (!config || config.missingSecrets(mode).includes(needed)) {
        uiError(viaLlm ? MISSING_GENERATOR_KEY : MISSING_JEV_KEY);
        return { became: 'nothing' };
      }
    }
    const cfg = config;
    if (!cfg) {
      uiError(CONFIG_NOT_READY);
      return { became: 'nothing' };
    }
    // §3.1 row 3 / §3.9: the root meter exists since startup; at or over the cap nothing is sent
    if (sessionMeter.exceeded()) {
      say('jevcode', [SESSION_CAP_CHAT_REFUSAL(sessionCapOf())]);
      return { became: 'chat' };
    }
    // §3.8 `chatSignal()`: ONE AbortController per submission — the reply, the background reading and every awaited
    // step between them share it, so a Ctrl-C that lands while `buildProvider` or a file read is pending stops both
    const ac = new AbortController();
    chatAbort = ac;
    const signal = ac.signal;
    try {
      // the reading needs Jev's key; without one the reply still goes out and nothing is said about it in the bubble
      const jevReady = cfg.missingSecrets('jev-only').length === 0;
      if (!jevReady) log.warn('chat: no Jev key resolves — the reply goes out, the reading is skipped');
      const intakeP: Promise<BackgroundIntake> = jevReady ? backgroundIntake(cfg, text, so.pinnedFiles, mode, signal) : Promise.resolve({ res: null, error: undefined });
      if (!viaLlm) return await jevOnlyTurn(text, so, intakeP, signal);
      thinking('replying');
      let reply: ChatReply;
      try {
        reply = await generatorTurn(cfg, text, so, mode, signal);
      } catch (e) {
        thinking(null);
        renderer.live?.('');
        await withinGrace(intakeP, INTAKE_GRACE_MS); // whatever Jev spent is still metered where it lands
        return chatFailure(e, 'generator');
      }
      // the reply is in; Jev is normally long done — give the reading the rest of its grace, then act on it
      const { res, error } = await withinGrace(intakeP, INTAKE_GRACE_MS);
      if (error !== undefined) log.warn(`chat: the background reading failed (${redact(describe(error))}) — the reply answered`);
      const kind: IntakeKind = res?.intake.kind ?? 'ambiguous';
      if (reply.usage !== null) {
        meterChat('generator', reply.usage, 'generator', 'llm', kind);
        // the code model's turn is no Jev request: no request hash
        json?.chat({ intake: kind, probability: res?.intake.probability ?? 0, route: 'llm', provider: 'generator', costUsd: reply.usage.costUsd, latencyMs: reply.latencyMs, requestHash: '' }, jsonCtx());
      }
      // Ctrl-C while the reading was still out: what was spent is metered above, but nothing lands (§3.1 row 10)
      if (signal.aborted) {
        thinking(null);
        renderer.live?.('');
        return chatFailure(signal.reason, 'generator');
      }
      // one bubble: the model's answer, then the one line the reading adds
      const offer = res !== null && offerWanted(text, res);
      const closing = res === null ? null : res.intake.kind === 'coding_task' ? ON_IT_LINE : offer ? DO_IT_OFFER : null;
      const lines = closing === null ? reply.lines : [...reply.lines, closing];
      thinking(null);
      renderer.live?.('');
      say('jevcode', lines);
      ledger.push(youTurn(text, res));
      ledger.push({ role: 'jevcode', text: lines.join('\n'), at: nowIso(), costUsd: reply.usage?.costUsd ?? 0, provider: 'generator' });
      if (res !== null && offer) pendingOffer = { text, intake: res };
      if (res !== null && res.intake.kind === 'coding_task') return await startChatRun(text, so, res);
      return { became: 'chat' };
    } finally {
      if (chatAbort === ac) chatAbort = null;
    }
  }

  /** §3.8: the run a reading (or an accepted offer) starts; the run owns the abort path from here (Esc Esc / Ctrl-C while live) */
  async function startChatRun(task: string, so: { kind: 'prompt' | 'follow-up'; pinnedFiles: readonly string[]; secretSpans: readonly string[] }, res: IntakeResult): Promise<SubmitOutcome> {
    chatAbort = null;
    const before = runs.length;
    await startRun(task, { kind: so.kind, pinnedFiles: so.pinnedFiles, secretsAcked: so.secretSpans.length, intake: { kind: res.intake.kind, probability: res.intake.probability, requestHash: res.requestHash } });
    // a run started when the record exists (a fast run may already have ended by the time startRun's caller resumes)
    return { became: live() || runs.length > before ? 'run' : 'nothing' };
  }

  /**
   * §3.3: Jev's ONE request per submission (groups A, B, C), running beside the reply. It is metered, written to the
   * `--json` stream and kept for the panel where it LANDS, so a slow reading still pays for itself; the controller
   * only waits `INTAKE_GRACE_MS` for the decision it carries.
   */
  async function backgroundIntake(cfg: ResolvedConfigWithDiagnostics, text: string, pinnedFiles: readonly string[], mode: EngineMode, signal: AbortSignal): Promise<BackgroundIntake> {
    let res: IntakeResult;
    try {
      const decider = await deciderOf(cfg, flags);
      lastDecider = decider;
      throwIfAborted(signal);
      const list = await candidates;
      throwIfAborted(signal);
      res = await runIntake({ decider, state: intakeState(text, pinnedFiles, list), facts: harnessFacts(factsInput()), signal, redact });
    } catch (e) {
      return { res: null, error: e };
    }
    const route = routeOf(res.intake, mode);
    meterChat('jev', res.usage, res.provider, route, res.intake.kind);
    chatDecisions(res.rows);
    // §3.8 / §6 item 17: the `chat` --json line of the reading — what it decided and what it cost; never the message
    json?.chat(chatLine(res, route), jsonCtx());
    // never the message (§3.9 "Redaction", §9 "keys never in logs")
    log.info(`intake ${res.intake.kind} p=${res.intake.probability.toFixed(2)} ${Math.round(res.latencyMs)}ms ${res.requestHash} → ${route}`);
    return { res, error: undefined };
  }

  /** the reading if it lands within `ms`, else nothing — the composer never waits on Jev */
  async function withinGrace(p: Promise<BackgroundIntake>, ms: number): Promise<BackgroundIntake> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<BackgroundIntake>((r) => {
      timer = setTimeout(() => r({ res: null, error: undefined }), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([p, late]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * network map P8b: the chat provider is built once per resolved config and mode, not on every turn — `reresolve()` and a
   * login replace the config object, which rebuilds it. The sockets are undici's global pool either way; what this saves
   * per turn is the rebuild (the generator section's validation, the registry lookup, the client's setup).
   */
  let chatProvider: { cfg: ResolvedConfigWithDiagnostics; mode: EngineMode; provider: Provider } | null = null;
  /** §3.6: the reply itself — one streamed generator turn, no tools; the price checks happen before anything is sent */
  async function generatorTurn(cfg: ResolvedConfigWithDiagnostics, text: string, so: { pinnedFiles: readonly string[] }, mode: EngineMode, signal: AbortSignal): Promise<ChatReply> {
    const gen: ChatGenerator = flags.mock || flags.mockGenerator ? MOCK_CHAT_GENERATOR : cfg.generator(); // ConfigError (invalid generator section) → chatFailure → [ui] error
    if (gen.priced !== true && flags.allowUnpriced !== true) return { lines: [LLM_UNPRICED_REFUSAL(gen.model)], usage: null, latencyMs: 0 };
    if (sessionMeter.exceeded() || sessionTotal() + chatEstimateUsd(gen, text, pinnedBytes(so.pinnedFiles)) > sessionCapOf()) return { lines: [SESSION_CAP_CHAT_REFUSAL(sessionCapOf())], usage: null, latencyMs: 0 };
    const cached = chatProvider;
    const provider = cached !== null && cached.cfg === cfg && cached.mode === mode ? cached.provider : await providerOf(cfg, flags, mode);
    chatProvider = { cfg, mode, provider };
    throwIfAborted(signal);
    const input = await llmInput(text, so.pinnedFiles, gen, provider, signal);
    throwIfAborted(signal);
    const r = await llmChatTurn(input);
    return { lines: r.text.split('\n').filter((l) => l.trim() !== ''), usage: r.usage, latencyMs: r.latencyMs };
  }

  /**
   * §3.4–§3.6 under `jev-only`, where there is no code model to answer: the catalogue reply, the session's own facts
   * or the lookup — and, for an `ambiguous` reading, the catalogue's fallback plus the `do it` offer instead of a card.
   */
  async function jevOnlyTurn(text: string, so: { kind: 'prompt' | 'follow-up'; pinnedFiles: readonly string[]; secretSpans: readonly string[] }, p: Promise<BackgroundIntake>, signal: AbortSignal): Promise<SubmitOutcome> {
    thinking('intake');
    const { res, error } = await p;
    thinking(null);
    if (res === null) return chatFailure(error, 'jev');
    ledger.push(youTurn(text, res));
    if (res.intake.kind === 'coding_task') return await startChatRun(text, so, res);
    const ambiguous = res.intake.kind === 'ambiguous';
    let lines: string[];
    let costUsd = 0;
    try {
      if (ambiguous) lines = [fillReply(replyByKey(REPLY_FALLBACK_KEY), replyFacts())];
      else if (res.intake.kind === 'greeting_or_smalltalk') lines = [fillReply(replyByKey(pickReply(res.answers).key), replyFacts())];
      else if (res.intake.kind === 'question_about_this_tool') lines = selectFacts(harnessFacts(factsInput()), res.answers).map((f) => f.text);
      else {
        thinking('lookup');
        const cfg = config;
        if (!cfg) throw new ConfigError(CONFIG_NOT_READY);
        const decider = lastDecider ?? (await deciderOf(cfg, flags));
        throwIfAborted(signal);
        const input = await lookupInput(text, so.pinnedFiles, decider, signal);
        throwIfAborted(signal);
        const r = await lookupCode(input);
        meterChat('jev', r.usage, r.provider, 'lookup', res.intake.kind);
        json?.chat({ intake: res.intake.kind, probability: res.intake.probability, route: 'lookup', provider: r.provider, costUsd: r.usage.costUsd, latencyMs: r.latencyMs, requestHash: r.requestHash }, jsonCtx());
        costUsd = r.usage.costUsd;
        lines = lookupLines(r, basename(workspaceRoot));
      }
    } catch (e) {
      thinking(null);
      return chatFailure(e, 'jev');
    }
    if (ambiguous && offerWanted(text, res)) {
      lines.push(DO_IT_OFFER);
      pendingOffer = { text, intake: res };
    }
    thinking(null);
    say('jevcode', lines);
    ledger.push({ role: 'jevcode', text: lines.join('\n'), at: nowIso(), costUsd, provider: lastDecider?.provider ?? 'openrouter' });
    return { became: 'chat' };
  }
  /** every failure of a chat request lands here (§3.1 rows 10, 12, 12′, 13); the meter is never touched (a failed request carries no usage) */
  function chatFailure(e: unknown, side: 'jev' | 'generator'): SubmitOutcome {
    // the client rethrows `signal.reason` (an AbortError), so the error itself says whether Ctrl-C landed — no stale-signal test (finding 5)
    if (isAbortError(e) || (e instanceof Error && e.name === 'AbortError')) {
      // Ctrl-C ×1 / exit: no bubble, the draft is not restored
      uiToast(STOPPED_THINKING_TOAST);
      return { became: 'nothing' };
    }
    if (e instanceof ConfigError) {
      uiError(`config: ${redact(e.message)}`);
      return { became: 'nothing' };
    }
    // TUI-DESIGN-3 §1.7 (R3 F5/F10): a 402 with no Retry-After is "no credits", never "unreachable" (an in-flight-budget 402 with Retry-After is retried by the provider first)
    if ((e instanceof JevHttpError || e instanceof ProviderHttpError) && e.status === 402 && e.retryAfterMs === null) {
      log.warn(`chat ${side} request: the key has no credits (HTTP 402)`);
      say('jevcode', [CREDITS_EXHAUSTED(side, 402)]);
      return { became: 'chat' };
    }
    // a 401/403 is a rejected key, not an unreachable host (finding 12): the bubble names /login; the TUI opens the wizard like the engine's key-rejected pane
    const rejected = (e instanceof JevHttpError || e instanceof ProviderHttpError) && (e.status === 401 || e.status === 403) ? e.status : null;
    if (rejected !== null) {
      log.warn(`chat ${side} request: the key was rejected (HTTP ${rejected})`);
      say('jevcode', [side === 'jev' ? JEV_KEY_REJECTED(rejected) : LLM_KEY_REJECTED(generatorModelLabel(), rejected)]);
      if (o.rendererKind === 'tui' && prompter?.wizard) void runLogin('rejected');
      return { became: 'chat' };
    }
    // JevHttpError · ProviderHttpError · network
    const short = redact(describe(e)).slice(0, 80);
    log.warn(`chat ${side} request failed: ${redact(describe(e))}`);
    say('jevcode', [side === 'jev' ? INTAKE_UNREACHABLE(short) : LLM_UNREACHABLE(generatorModelLabel(), short)]);
    return { became: 'chat' };
  }

  // --- the controller helpers of §3.8 (pure builders live in src/chat/**) -------------------------------------------
  function finishedRuns(): number {
    return runs.filter((r) => r.endedAt !== null).length;
  }
  function intakeState(text: string, pinned: readonly string[], list: readonly Candidate[]): JsonObject {
    const tests = testsFromCandidates(list.map((c) => c.path));
    const last = lastFinishedRun();
    return buildIntakeState(
      {
        message: text,
        conversation: ledger.recent(),
        workspace: { name: basename(workspaceRoot), git: gitAtStart?.repo === true, hasTests: tests.hasTests, testRunner: tests.testRunner, files: filesBucket(list.length) },
        session: {
          mode: pending.mode ?? baseMode,
          runs: finishedRuns(),
          lastRun: last !== null && last.stopReason !== null ? { task: last.task, stopReason: last.stopReason, steps: last.steps, testsAllPassed: lastTests?.allPassed ?? null } : null,
          pendingMode: pending.mode ?? null,
        },
        mentions: pinned,
      },
      redact,
    );
  }
  /**
   * §3.5 `(<ENV or file>, never printed)`: `env <NAME>` · `dotenv <path>` · `file <path>` · `flag` — never a value. The resolver
   * records `env` without the variable, so `envName` re-derives the one it consulted first (§2.3 step 3: the provider's own
   * variable when the provider was explicit or key-inferred, then the row's `JEV_API_KEY`, `OPENROUTER_API_KEY`).
   */
  function sourceText(source: string, envName: () => string): string {
    if (source === 'env') return `env ${envName()}`;
    if (source.startsWith('dotenv:')) return `dotenv ${source.slice('dotenv:'.length)}`;
    if (source.startsWith('file:')) return `file ${source.slice('file:'.length)}`;
    if (source === 'flag') return 'flag';
    if (source === 'wizard') return 'saved by the wizard';
    return source;
  }
  /** the environment variable the Jev key resolved from (`source: 'env'`): the provider's own first unless the provider itself was inferred from `JEV_API_KEY` / `OPENROUTER_API_KEY` (§2.3 rules 2b, 2d), then the row's two names */
  function jevKeyEnvName(cfg: ResolvedConfigWithDiagnostics): string {
    let provider: JevProvider = 'openrouter';
    let providerSource = 'default';
    try {
      const d = cfg.decider();
      provider = d.provider;
      providerSource = d.providerSource;
    } catch {
      const p = cfg.entries.get('decider.provider')?.value;
      if (p === 'typesafe' || p === 'openrouter') provider = p;
    }
    const own = JEV_PROVIDERS[provider].keyEnv;
    const order = providerSource === 'auto:openrouter-key' || providerSource === 'default' ? ['JEV_API_KEY', 'OPENROUTER_API_KEY'] : [own, 'JEV_API_KEY', 'OPENROUTER_API_KEY'];
    return order.find((n) => (env[n] ?? '') !== '') ?? own;
  }
  /** the environment variable the generator key resolved from: the provider's (`ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`, prepended by the resolver), else the row's `JEVCODE_API_KEY` */
  function generatorKeyEnvName(cfg: ResolvedConfigWithDiagnostics): string {
    const p = cfg.entries.get('generator.provider')?.value;
    const own = p === 'anthropic' || p === 'openrouter' ? PROVIDER_ENV[p] : null;
    const order = [...(own !== null ? [own] : []), 'JEVCODE_API_KEY'];
    return order.find((n) => (env[n] ?? '') !== '') ?? own ?? 'JEVCODE_API_KEY';
  }
  function chatP50Ms(): number | null {
    const fromChat = ledger.stats().p50Ms;
    if (fromChat !== null) return fromChat;
    const latencies = decisions.map((d) => d.latencyMs).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return latencies.length === 0 ? null : latencies[Math.floor((latencies.length - 1) / 2)] ?? null;
  }
  function deciderProviderInfo(cfg: ResolvedConfigWithDiagnostics | null): FactsInput['provider'] {
    if (!cfg) return null;
    const p50Ms = chatP50Ms();
    if (flags.mock) {
      const d = lastDecider;
      return { name: d?.provider ?? 'openrouter', host: 'mock', model: d?.model ?? JEV_PROVIDERS.openrouter.defaultModel, p50Ms };
    }
    try {
      const d = cfg.decider();
      let host = JEV_PROVIDERS[d.provider].displayHost;
      try {
        host = new URL(d.baseUrl).host;
      } catch {
        /* the table's host */
      }
      return { name: d.provider, host, model: d.model, p50Ms };
    } catch {
      return null;
    }
  }
  function factsInput(): FactsInput {
    const cfg = config;
    const last = lastFinishedRun();
    const tests = testsFromCandidates(candidateList.map((c) => c.path));
    const jevEntry = cfg?.entries.get('decider.apiKey');
    const genEntry = cfg?.entries.get('generator.apiKey');
    const genProvider = cfg?.entries.get('generator.provider')?.value ?? 'anthropic';
    const providerInfo = deciderProviderInfo(cfg);
    return {
      mode: baseMode,
      nextMode: pending.mode ?? baseMode,
      // the command a run parsed, else the listing's detected runner (`tests: pytest (detected)`) — the same fact the intake state carries (finding 9)
      workspace: { root: workspaceRoot, git: gitAtStart, hasTests: tests.hasTests, testCommand: lastTests !== null && lastTests.command !== '' ? lastTests.command : null, testRunner: tests.testRunner },
      lastRun: last !== null && last.stopReason !== null ? { runId: last.runId, task: last.task, stopReason: last.stopReason, steps: last.steps, costUsd: last.costUsd, paused: last.stopReason === 'human_pause' } : null,
      lastTests,
      keys: {
        jev: cfg && jevEntry !== undefined && providerInfo !== null ? { provider: providerInfo.name, source: sourceText(jevEntry.source, () => jevKeyEnvName(cfg)) } : null,
        generator: cfg && genEntry !== undefined ? { provider: genProvider, source: sourceText(genEntry.source, () => generatorKeyEnvName(cfg)) } : null,
      },
      spend: { sessionUsd: sessionTotal(), sessionCapUsd: sessionCapOf(), runs: finishedRuns(), chats: ledger.messages },
      sandbox: cfg ? detectSandboxLevel(cfg.sandbox) : 'none',
      // the `review` fact tells the truth about who approves: `full` (the default) auto-approves and logs
      autonomy: cfg?.autonomy ?? 'full',
      runsDir: cfg?.runsDir ?? join(jdir, 'runs'),
      provider: providerInfo,
      /**
       * §8.1 item 10 / §2.4: the 15th fact, wired. `undefined` (no `peers` key at all) is `peersFactText`'s
       * "not available in this build"; `null` is "the ledger is not open yet"; a `PeerView` is the real answer.
       * Leaving it unset cost ~140 intake tokens for a sentence that was permanently false (round-5 fix pass,
       * finding 9).
       */
      /**
       * gap 1 (fix pass, finding 7): `undefined` is "there will be no ledger" and `peersOffClause` says WHICH —
       * the brief's "say which in the string" applies to all three sinks, and omitting the key alone left the
       * fact printing the bare, now-false `the peer registry is not available in this build.` `null` is the
       * honest "not open yet"; a `PeerView` is the real answer.
       */
      ...peersFactFields(),
    };
  }
  function replyFacts(): ReplyFacts {
    const last = lastFinishedRun();
    const lastRun = last === null || last.stopReason === null ? null : last.stopReason === 'human_pause' ? `the last run is paused after step ${last.steps} (/resume continues)` : `the last run ended ${last.stopReason} after ${last.steps} step${last.steps === 1 ? '' : 's'}`;
    return { dir: basename(workspaceRoot), lastRun, mode: pending.mode ?? baseMode, runsDir: config?.runsDir ?? join(jdir, 'runs'), home };
  }
  /** a bounded, denylisted read inside the workspace (`isMentionDenied` first, realpath confined to the workspace); null = denied or unreadable */
  async function readWorkspaceFile(rel: string, maxBytes: number): Promise<FileView | null> {
    const cfg = config;
    if (!cfg || isMentionDenied(workspaceRoot, rel, cfg.secretPaths)) return null;
    try {
      const rootReal = realpathSync(workspaceRoot);
      const real = realpathSync(resolvePath(workspaceRoot, rel));
      if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
      const fh = await openFile(real, 'r');
      try {
        const size = (await fh.stat()).size;
        const buf = Buffer.alloc(Math.min(size, maxBytes));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return { path: rel, content: cfg.redact(buf.subarray(0, bytesRead).toString('utf8')), bytes: size, truncatedBytes: Math.max(0, size - bytesRead) };
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }
  async function lookupInput(text: string, pinned: readonly string[], decider: Decider, signal: AbortSignal): Promise<LookupInput> {
    const list = await candidates;
    return {
      message: text,
      mentions: pinned,
      candidates: list,
      read: (rel, maxBytes) => readWorkspaceFile(rel, Math.min(maxBytes, LOOKUP_READ_BYTES)),
      ask: (state, questions) => decider.ask(state, questions, { signal, stage: 'context', step: 0 }),
      provider: decider.provider,
      redact,
      signal,
    };
  }
  async function llmInput(text: string, pinned: readonly string[], gen: ChatGenerator, provider: Provider, signal: AbortSignal): Promise<LlmTurnInput> {
    const cfg = config;
    const files: FileView[] = [];
    for (const p of pinned.slice(0, CHAT_FILES_MAX)) {
      throwIfAborted(signal);
      const v = await readWorkspaceFile(p, CHAT_FILE_BYTES);
      if (v !== null) files.push(v);
    }
    const last = lastFinishedRun();
    let window: readonly WindowEntry[] = [];
    if (last !== null && cfg) {
      const loaded = await loadRunFn(cfg.runsDir, last.runId, cfg.redact).catch(() => null);
      window = loaded?.state?.window ?? [];
    }
    // the live region gets only the prefix no later delta can change under redaction (chat/stream-redact.ts): append-only,
    // control characters dropped, never the first characters of a secret; a provider retry restarts it
    // (no config yet = `redact` has no exact layer either, so nothing can be pending)
    const { createStreamRedactor } = await import('../chat/stream-redact.js');
    const shown = createStreamRedactor(redact, (s) => (config ? config.pendingSecretStart(s) : s.length));
    return {
      provider,
      message: text,
      identity: chatIdentity(gen.model, provider.name === 'mock' ? 'mock' : PROVIDER_DISPLAY_NAME[provider.name]),
      conversation: ledger.recent(),
      facts: harnessFacts(factsInput()),
      context: { plan: lastPlan ?? lastResult?.finalPlan ?? null, window, files },
      instructions: instructions?.text ?? null,
      generation: { maxTokens: chatMaxTokens(gen.maxTokens), temperature: null },
      signal,
      onDelta: (d) => {
        if (shown.push(d) !== '') renderer.live?.(shown.text);
      },
      onRetry: () => {
        shown.reset();
        renderer.live?.('');
      },
      onEnd: () => {
        if (shown.end() !== '') renderer.live?.(shown.text);
      },
      redact,
      warn: (m) => log.warn(m),
    };
  }
  /** the system prompt's workspace section: the directory, its git state and what this workspace was doing lately */
  function chatIdentity(model: string, providerName: string): ChatIdentity {
    const g = gitAtStart;
    const now = Date.parse(nowIso());
    const recentSessions = index
      .filter((r) => r.workspace === workspaceRoot)
      .slice()
      .sort((a, b) => (a.lastUsed < b.lastUsed ? 1 : a.lastUsed > b.lastUsed ? -1 : 0))
      .slice(0, CHAT_RECENT_SESSIONS)
      .map((r) => `"${r.title}" · ${timeAgo(r.lastUsed, now)}`);
    return {
      model,
      provider: providerName,
      workspace: basename(workspaceRoot),
      git: g !== null && g.repo ? `${branchOf(g)}, ${g.dirty.modified + g.dirty.staged} modified · ${g.dirty.untracked} untracked` : null,
      recentSessions,
    };
  }
  /** Σ bytes of the @-mentioned files (from the listing; nothing is read) */
  function pinnedBytes(pinned: readonly string[]): number {
    let n = 0;
    for (const c of candidateList) if (pinned.includes(c.path)) n += Math.min(c.bytes, CHAT_FILE_BYTES);
    return n;
  }
  /**
   * §3.9: `sessionMeter.add(source, usage)` → the 50/80/95 % session items (once each) → `pushSessionSpend()` → the `chat` index line
   * (§6 item 17; buffered with `deferredBudgetLines` before the first run and written with its session id, so `seedMeterFromIndex`
   * restores chat spend on /resume; a session that never runs drops them)
   */
  function meterChat(source: 'jev' | 'generator', usage: TokenUsage, provider: JevProvider | 'generator', route: ChatRoute, intake: IntakeKind): void {
    sessionMeter.add(source, usage);
    const snap = sessionMeter.snapshot();
    if (Number.isFinite(snap.capUsd) && snap.capUsd > 0) {
      const pct = (snap.totalUsd / snap.capUsd) * 100;
      for (const t of BUDGET_THRESHOLDS) {
        if (pct < t || chatThresholdsSeen.has(t)) continue;
        chatThresholdsSeen.add(t);
        for (const l of budgetItems({ type: 'budget:warn', scope: 'session', pct: t, spentUsd: snap.totalUsd, capUsd: snap.capUsd, step: 0, stepsLeftEstimate: null, restored: false })) note(l, { level: t >= 80 ? 'warn' : 'info' });
      }
    }
    pushSessionSpend();
    const line = { t: nowIso(), intake, route, costUsd: usage.costUsd, provider };
    if (sessionId !== null) indexLine({ v: 1, kind: 'chat', sessionId, ...line });
    else deferredChatLines.push(line);
  }
  /**
   * TUI-DESIGN-3 §1.5: the verification's priced calls land on the session meter directly — not through the chat ledger (a probe is no
   * message: `/cost`'s `chat $x for N messages` must not count it), so `/cost` shows it in the session total only
   */
  function meterVerify(source: 'jev' | 'generator', usage: TokenUsage): void {
    sessionMeter.add(source, usage);
    pushSessionSpend();
  }
  /** §3.8 / §6 item 17: the `--json` `chat` line of an intake */
  function chatLine(res: IntakeResult, route: ChatRoute): { intake: IntakeKind; probability: number; route: ChatRoute; provider: JevProvider | 'generator'; costUsd: number; latencyMs: number; requestHash: string } {
    return { intake: res.intake.kind, probability: res.intake.probability, route, provider: res.provider, costUsd: res.usage.costUsd, latencyMs: res.latencyMs, requestHash: res.requestHash };
  }
  /** §3.11: keeps the last ≤ 3 intakes; the panel's `s0 intake` rows */
  function chatDecisions(rows: readonly Decision[]): void {
    chatIntakes = [...chatIntakes, rows].slice(-CHAT_INTAKES_KEPT);
    const limits = config?.limits();
    try {
      extras.dispatch?.({ type: 'chat-decisions', rows: chatIntakes.flat().map((d) => toDecisionRow(d, limits?.completeThreshold, limits?.impossibleThreshold)) });
    } catch {
      /* the renderer is gone */
    }
  }
  /** the `[you]` turn of the ledger; a reading that never landed leaves the reading fields off (§3.9 stats skip them) */
  function youTurn(text: string, res: IntakeResult | null): ChatTurn {
    const base = { role: 'you' as const, text: redact(text), at: nowIso() };
    return res === null ? base : { ...base, kind: res.intake.kind, probability: res.intake.probability, requestHash: res.requestHash, latencyMs: res.latencyMs, costUsd: res.usage.costUsd, provider: res.provider };
  }
  /** `config.generator().model`, or `the LLM` — never throws (used inside chatFailure) */
  function generatorModelLabel(): string {
    if (flags.mock || flags.mockGenerator) return MOCK_CHAT_GENERATOR.model;
    try {
      return config?.generator().model ?? 'the LLM';
    } catch {
      return 'the LLM';
    }
  }

  // --- the host (§15 item 16) --------------------------------------------------------------------
  const host: ControllerHost = {
    // TUI-DESIGN-2 §3.8: every composer submission passes intake (`converse`); the one-shot argv task (`submitTask`) goes straight to startRun
    async submit(text, so): Promise<SubmitOutcome> {
      await startupDone;
      // §10.2: addSecret('composer#n', span) per span BEFORE createEngine
      for (const span of so.secretSpans) config?.addSecret(`composer#${++secretSeq}`, span);
      return converse(text, so);
    },
    async command(line) {
      await startupDone;
      await runCommand(line);
    },
    steer(text, so): SteerResult {
      for (const span of so.secretSpans) config?.addSecret(`composer#${++secretSeq}`, span);
      const e = engine;
      if (e !== null && live()) return e.steer(text, { ...(so.secretSpans.length > 0 ? { secretsAcked: so.secretSpans.length } : {}) });
      if (phase === 'starting') {
        // §8.6: the same cap as the engine's queue; the renderer shows `steer queue full (8)` for the refusal
        if (startingSteers.length >= STARTING_STEER_CAP) return { ok: false, reason: 'full', queued: STARTING_STEER_CAP };
        startingSteers.push(text);
        return { ok: true, index: startingSteers.length, queued: startingSteers.length };
      }
      return { ok: false, reason: 'finished', queued: 0 };
    },
    unsteer: (): PendingDirective | null => engine?.unsteer() ?? null,
    /**
     * contract 1.7 item 9 / TUI-DESIGN-5 §2.4: `/peers`' four scalars, folded by `peerViewOf` from the live fold.
     * `null` until the ledger is open (§1.4 promise 1), which is what makes `/peers` print TD4's
     * `the peer registry is not available in this build` rather than a false zero.
     */
    peers: (): PeerView | null => (sessionLedger === null ? null : peerViewOf(sessionLedger.fold, sessionLedger.self)),
    /**
     * contract 1.8 item 4 / TUI-DESIGN-5 §2.3: the FULL activity read. One row model — `listSessions` through the
     * facade, then `activityView` — so `/who`, the `--plain` twin and `sessions who --json` share one projection.
     */
    who: (): readonly SessionActivityView[] | null => (sessionLedger === null ? null : sessionLedger.list({ all: false }).map(activityView)),
    pause() {
      engine?.pause();
    },
    abort() {
      // §3.3: a blocking pane's Ctrl-C is that pane's [q]
      if (pendingBlocking !== null) {
        const b = pendingBlocking;
        pendingBlocking = null;
        b.resolve('stop');
        return;
      }
      // TUI-DESIGN-2 §3.1 row 10: Ctrl-C ×1 while a chat request is in flight aborts it (no bubble, a toast; the draft is not restored)
      if (!live() && thinkingPhase !== null) {
        abortChat();
        return;
      }
      if (engine !== null && live()) {
        engine.abort('human_abort');
        phase = 'aborting';
      }
    },
    retryNow: () => engine?.retryNow() ?? false,
    note,
    redact,
    addSecret: (name, value) => config?.addSecret(name, value) ?? false,
    detectSecrets: (s) => detectSecretsByPattern(s, config ? { redact: config.redact } : undefined),
    exit(code) {
      if (exiting) return;
      if (engine !== null && live()) {
        // §3.3 / §13.5: leaving while live aborts first and exits after run:end (Ctrl-D [y], /exit [y]); the policy is applied then
        exitAfterRunEnd = code;
        engine.abort('human_abort');
        phase = 'aborting';
        return;
      }
      // TUI-DESIGN-2 §1.4 / §12 "Wizard": Ctrl-C at the startup wizard (exit 2 with a key still missing) prints the fix block —
      // the two Jev variables and the piped `jevcode login --jev-provider … --jev-key-stdin` — as a [setup] item; it commits in
      // finishSession's final flush, before the unmount (the same lines the non-TTY paths print)
      if (code === WIZARD_EXIT_CODE && config !== null) {
        const mode = pending.mode ?? baseMode;
        // TUI-DESIGN-3 §1.8 edge 6: nothing missing (Ctrl-C at trust / sandbox) → no fix block
        if (config.missingSecrets(mode).length > 0) textBlock('no key found — set them in the environment or run jevcode login:', fixBlockLines(mode, providerOfConfig(config)), { label: '[setup]', level: 'warn' });
      }
      // §1: `/exit`, Ctrl-C ×2 idle and Ctrl-D ×2 → 0, or the last run's code under `--exit-code=last-run`
      finishSession(leaveExitCode(code), 'exit');
    },
    index: () => sessionRows(),
    history: (): HistoryStore | null => history,
    workspaceCandidates: () => candidates,
    answerBlocking(id, answer) {
      if (pendingBlocking === null || pendingBlocking.req.id !== id) return false;
      const b = pendingBlocking;
      pendingBlocking = null;
      if (answer === 'login') void runLogin('rejected').then((saved) => b.resolve(saved ? 'retry' : 'stop'));
      else b.resolve(answer);
      return true;
    },
    phase: () => phase,
    ranBefore,
    dispatchContext() {
      const run = current ?? lastFinishedRun();
      const cfg = config;
      return {
        step: run?.steps ?? 0,
        ...(run ? { changedSteps: run.changedSteps } : {}),
        sessions: index.map((s) => ({ id: newestRunId(s) ?? s.sessionId, title: s.title })),
        ...(cfg ? { isDeniedPath: (rel: string) => isMentionDenied(workspaceRoot, rel, cfg.secretPaths) } : {}),
      };
    },
    awaitRunEnd: () => (live() ? new Promise<void>((r) => runEndWaiters.push(r)) : Promise.resolve()),
  };

  // --- startup (§1 session loop, first half) -------------------------------------------------------
  async function gateTask(task: string): Promise<{ task: string; acked: number } | null> {
    const cfg = config;
    const hits = detectSecretsByPattern(task, cfg ? { redact: cfg.redact } : undefined);
    if (hits.length === 0) return { task, acked: 0 };
    if (prompter?.secretGate && cfg) {
      const send = await prompter.secretGate(hits);
      if (send) {
        const spans = spansOf(task, hits);
        for (const span of spans) cfg.addSecret(`composer#${++secretSeq}`, span);
        return { task, acked: spans.length };
      }
    }
    // §13.6: the refusal line reaches stderr after the unmount when Ink is mounted (a pipe / --json gets it at once)
    emitAfterUnmount('stderr', `${gateRefusalLine(hits)}\n`);
    json?.sessionRefused({ reason: 'secret', exitCode: EXIT_CODES.config }, { runId: null, sessionId });
    finishSession(EXIT_CODES.config, 'exit');
    return null;
  }

  async function startup(): Promise<void> {
    trace('startup: awaiting firstFrame');
    await renderer.firstFrame();
    if (exiting) return;
    firstFrameMs = performance.now();
    trace(`startup: firstFrame at ${firstFrameMs.toFixed(1)} ms`);
    // §1: keybindings.json and history.jsonl are read synchronously in the same tick, before Ink can dispatch a key
    const kbPath = keybindingsPath(env, flags.keybindings ?? null, home);
    try {
      keybindings = loadKeybindingsFn(kbPath);
    } catch (e) {
      log.warn(`keybindings: ${describe(e)}`);
    }
    const wsGuess = resolvePath(cwd, flags.workspace ?? '.');
    let wsReal = wsGuess;
    try {
      wsReal = (await import('node:fs')).realpathSync(wsGuess);
    } catch {
      wsReal = wsGuess;
    }
    const writes = flags.noHistory !== true && env['JEVCODE_NO_HISTORY'] !== '1' && flags.source !== 'perf';
    try {
      history = createHistory({ path: historyFilePath(jdir), workspace: wsReal, redact: (s) => redact(s), writes, now: nowIso, onWriteError: ({ file, code }) => log.warn(`could not write ${file}: ${code}`) });
    } catch (e) {
      log.warn(`history: ${describe(e)}`);
    }
    trace('startup: keybindings + history read');
    config = await resolveConfig({ ...flags, ...pendingFlagOverrides() }, env, cwd, { homedir: home });
    if (exiting) return;
    trace('startup: config resolved');
    if (!deps.log) {
      const ls = logSettingsFromEnv(env, { ...(flags.log !== undefined ? { log: flags.log } : {}), ...(flags.logLevel !== undefined ? { logLevel: flags.logLevel } : {}), ...(flags.verbose ? { verbose: true } : {}) });
      const logsDir = join(jdir, 'logs');
      try {
        log = createLog({ file: ls.file ?? fallbackLogPath(logsDir, pid, new Date()), level: ls.level, redact: config.redact, fallbackDir: logsDir, pid });
      } catch {
        log = nullLog();
      }
    }
    if (keybindings) for (const w of keybindings.warnings) log.warn(w);
    applyConfig();
    // TUI-DESIGN-3 §4.4 F10: the keybindings file reaches the App (before: loaded, reloaded, never passed)
    if (keybindings) renderer.setBindings?.(keybindings.bindings);
    renderer.setHost?.(host);
    for (const w of config.warnings) warnLine(w);
    // TUI-DESIGN-4 §7.5 item 5 (P-D5): the config problems are emitted ONCE at session start, after `firstFrame()`
    // resolved, so a TUI user sees a value the next run will reject without having to type `/config`.
    configProblemLines(config).forEach((l) => note(l, { label: '[setup]', level: 'warn' }));
    await shadowingLines();
    if (exiting) return;
    const mode = pending.mode ?? baseMode;
    if (config.missingSecrets(mode).length > 0) {
      const saved = prompter?.wizard ? await runLogin('missing') : false;
      if (exiting) return;
      // the wizard's `3 Jev only` may have moved the mode (persisted, reresolved): re-read it before judging what is still missing
      const after = pending.mode ?? baseMode;
      if (!saved && config.missingSecrets(after).length > 0) {
        const names = config.missingSecrets(after);
        if (!prompter?.wizard && (o.mode === 'one-shot' || !o.interactive)) {
          // TUI-DESIGN-3 §1.6: a pipe with a Jev key but no generator names the three ways out
          const text = names.length === 1 && names[0] === 'generator.apiKey' ? missingGeneratorOnly(providerIdOfConfig(config)) : `missing ${names.join(', ')}: set the environment variable or run jevcode login`;
          throw new ConfigError(text, { ...(names[0] !== undefined ? { setting: names[0] } : {}) });
        }
        // TUI-DESIGN-3 §1.8 edges 3 / 24: a startup wizard the user left (Ctrl-C) exits 2 with the §1.6 fix block. The Ink
        // wizard does it itself (`host.exit(WIZARD_EXIT_CODE)` — `exiting` is already set above); the `--plain` twin has no
        // renderer to call it, so the controller takes the same exit for the readline wizard it opened.
        // (`o.interactive` is false under `--plain`; a plain renderer HAS a wizard prompter only when the readline composer lent it its lines)
        if (prompter?.wizard && o.rendererKind === 'plain') {
          host.exit(WIZARD_EXIT_CODE);
          return;
        }
        textBlock(`no key found for ${names.join(', ')}; a prompt will start once one is set:`, fixBlockLines(after, providerOfConfig(config)), { label: '[setup]', level: 'warn' });
      }
    } else await defaultModeNotice();
    try {
      gitAtStart = await probeGit(workspaceRoot);
    } catch {
      gitAtStart = null;
    }
    if (exiting) return;
    extras.setGitDirs?.({ gitDir: gitAtStart?.gitDir ?? null, commonDir: gitAtStart?.commonDir ?? null });
    trace('startup: secrets + git probed');
    await trustGate();
    if (exiting) return;
    trace('startup: trust gate done');
    /**
     * TUI-DESIGN-3 §5.1 rule 13 + the QUIET START (2026-09, owner's directive "clean"): the boxed console opens with the
     * wordmark and the composer and nothing else, so the `[sandbox]` item is a LINE-RENDERER item now — `--plain` and
     * `--json` still carry it (one dim line, no detail). Interactively the same facts are one keystroke away: `/status`
     * (the `sandbox` row), `/config` (the sandbox footer, the full sentence) and `jevcode doctor`.
     */
    if (o.rendererKind !== 'tui') note(sandboxText(detectSandboxLevel(config.sandbox), config.sandbox), { label: '[sandbox]', level: 'dim' });
    const cfg = config;
    candidates = trackCandidates(listCandidatesFn(workspaceRoot, { secretPaths: cfg.secretPaths, redact: cfg.redact }).catch(() => []));
    // network map P5: ONE anonymous GET warms the generator's origin while the human reads the first frame — fire-and-forget,
    // never awaited, never logged; provider/net.ts skips it outside an interactive session (`--list-sessions`, one-shot, a
    // pipe), under --mock, --no-network, the no-network assertion and tests. The session's end aborts it: never outlives it.
    const prewarmWhen = { interactive: o.interactive && o.mode === 'session' && flags.listSessions !== true, mode: pending.mode ?? baseMode, mock: flags.mock === true || flags.mockGenerator === true, offline: env['JEVCODE_ASSERT_NO_NETWORK'] === '1' };
    const prewarmAbort = new AbortController();
    void done.then(() => prewarmAbort.abort());
    void import('../provider/net.js').then((net) => (exiting ? undefined : net.prewarmGenerator(cfg, prewarmWhen, { signal: prewarmAbort.signal }))).catch(() => undefined);
    await refold();
    if (exiting) return;
    newSessionMeter();
    pushSessionSpend();
    if (flags.listSessions) {
      // §13.6: the rows reach stdout after the unmount when Ink is mounted
      const lines = pickerRows(index, { workspace: workspaceRoot, widened: false, nowMs: now(), columns: columns(), ascii: o.launch.ascii });
      emitAfterUnmount('stdout', `${lines.length > 0 ? lines.join('\n') : noSessionMessage(workspaceRoot)}\n`);
      finishSession(0, 'exit');
      return;
    }
    if (flags.continue) {
      const s = mostRecentSession(index, workspaceRoot);
      const id = s ? newestRunId(s) : null;
      if (id === null) throw new UsageError(noSessionMessage(workspaceRoot));
      await resumeOrFollowUp(id, flags.force === true);
      if (o.mode === 'one-shot' && !live() && !exiting) {
        const task = await readTaskOption();
        if (task !== null && !exiting) await submitTask(task);
      }
      return;
    }
    if (flags.resume !== undefined) {
      await resumeTarget(flags.resume, flags.force === true);
      return;
    }
    if (o.mode === 'session') {
      const recent = mostRecentSession(index, workspaceRoot);
      // the quiet start: in the TUI the offer is the composer's own placeholder (`Say hi · /resume continues "<title>"`),
      // not an item above it; `--plain` / `--json` keep the line, dim
      if (recent && o.rendererKind !== 'tui') note(recentSessionHint(recent, now(), o.launch.ascii), { level: 'dim' });
      else if (recent) {
        try {
          extras.dispatch?.({ type: 'recent', title: recent.title });
        } catch {
          /* the renderer is gone */
        }
      }
      return;
    }
    const task = await readTaskOption();
    if (exiting) return;
    if (task !== null) {
      await submitTask(task);
      return;
    }
    /**
     * TUI-DESIGN-4 §2.8 (P-R10): `chat` that asked for a composer and was refused says WHY, with the three ways
     * out (`src/cli/main.tsx`'s `rendererRefusalRows`, the §12 strings). `run` — and a `chat` that simply had no
     * task on an interactive terminal — keeps today's sentence.
     */
    const refusal = o.rendererRefusalRows;
    if (refusal != null && refusal.length > 0) throw new UsageError(refusal.join('\n'));
    throw new UsageError('missing task text: pass it as a positional argument, --task-file <path>, or on stdin');
  }

  /**
   * TUI-DESIGN-3 §1.7 / §0.1 (D-Q, owner-ratified one-time rule): a keyed start whose `mode` resolves from `default` (no flag, variable or
   * file row) under a default that bills a generator prints ONE `[setup]` item naming the default, its caps and the two ways to keep or change
   * it — only while the config file's `seen.defaultMode` differs from `DEFAULT_MODE`; printing it writes the row (the trust gate's write
   * path). A read-only config directory degrades to printing at every start with one log warning. Never under `--mock` / `--json`.
   */
  async function defaultModeNotice(): Promise<void> {
    const cfg = config;
    if (!cfg || flags.mock || flags.json || o.rendererKind === 'json' || o.rendererKind === 'tui') return; // the TUI opens with the wordmark and the composer only; --plain / --json keep the one-time disclosure
    const modeR = cfg.entries.get('mode');
    if (!modeR || modeR.source !== 'default') return;
    const mode = cfg.mode;
    if (mode === 'jev-only') return; // a default that bills no generator changes nothing a round-2 user pays
    if (cfg.entries.get('seen.defaultMode')?.value === DEFAULT_MODE) return;
    note(defaultModeItem(mode, cfg.limits().spendCapUsd, cfg.sessionSpendCap(mode).value), { label: '[setup]', level: 'dim' });
    try {
      await writeConfigValueFn('seenDefaultMode', DEFAULT_MODE, { env, home, cwd, configFlag: flags.config ?? null });
    } catch (e) {
      if (!seenWriteWarned) {
        seenWriteWarned = true;
        log.warn(`could not record seen.defaultMode: ${describe(e)} — the default-mode item prints at every start`);
      }
    }
  }

  async function readTaskOption(): Promise<string | null> {
    if (o.task === undefined || o.task === null) return null;
    return typeof o.task === 'function' ? o.task() : o.task;
  }

  async function submitTask(task: string): Promise<void> {
    const gated = await gateTask(task);
    if (gated === null || exiting) return;
    await startRun(gated.task, { kind: ranBefore() ? 'follow-up' : 'prompt', pinnedFiles: [], secretsAcked: gated.acked });
  }

  /** the mode the fix block is printed for: the resolved config's, else the flag, else `JEVCODE_MODE`, else DEFAULT_MODE */
  function modeForFix(): EngineMode {
    if (config) return pending.mode ?? baseMode;
    const flag = modeFromParsedFlags(flags);
    if (isEngineMode(flags.mode ?? flags.condition)) return flag;
    const fromEnv = typeof env['JEVCODE_MODE'] === 'string' ? parseModeHint(env['JEVCODE_MODE']) : null;
    return fromEnv ?? DEFAULT_MODE;
  }

  const controller: SessionController = {
    host,
    setPrompter(p) {
      prompter = p;
    },
    persistCredentials,
    trustInputs: () => lastTrustInputs,
    sandboxLine: () => (config ? sandboxText(detectSandboxLevel(config.sandbox), config.sandbox) : null),
    sandboxDetail: () => (config ? sandboxDetail(detectSandboxLevel(config.sandbox), config.sandbox) : null),
    mode: () => pending.mode ?? baseMode,
    runsDir: () => config?.runsDir ?? null,
    verifyForWizard,
    applyModeChoice,
    resolvedJevKey: () => {
      const r = config?.entries.get('decider.apiKey');
      return r && r.value.trim() !== '' ? r.value.trim() : null;
    },
    resolvedJevSource: () => {
      const r = config?.entries.get('decider.apiKey');
      return r && r.value.trim() !== '' ? layerOf(r.source) : null;
    },
    async run() {
      // F3: a signal or exit request during startup ends the process even while startup awaits a prompt or a probe
      const started = startup().then(
        () => {
          startupSettled?.();
        },
        (e: unknown) => {
          startupSettled?.();
          throw e;
        },
      );
      try {
        await Promise.race([started, done]);
      } catch (e) {
        const err = isJevCodeError(e) ? e : null;
        const code = err?.exitCode ?? EXIT_CODES.unexpected;
        log.error(`startup failed: ${describe(e)}`);
        finishSession(code, 'error');
        await done;
        stderr.write(`jevcode: ${redact(describe(e))}\n`);
        // TUI-DESIGN-3 §1.6: the pipe's fix block names the mode's routes — the resolved mode when the config got that far, else argv / JEVCODE_MODE
        if (err instanceof ConfigError && /missing (generator|decider)\.apiKey/.test(err.message)) for (const l of fixBlockLines(modeForFix(), config ? providerOfConfig(config) : null)) stderr.write(`${l}\n`);
        return code;
      }
      return done;
    },
    signal(name) {
      if (exiting) return;
      signalExit = name;
      if (pendingBlocking !== null) {
        const b = pendingBlocking;
        pendingBlocking = null;
        b.resolve('stop');
      }
      if (engine !== null && live()) {
        engine.abort('signal', { signal: name });
        phase = 'aborting';
        return;
      }
      finishSession(exitCodeFor('signal', undefined, false, name), 'run-end');
    },
    onAbort(reason) {
      if (reason === 'signal') {
        controller.signal('SIGINT');
        return;
      }
      if (engine !== null && live()) {
        host.abort('human_abort');
        return;
      }
      if (o.mode === 'one-shot' && !exiting) {
        signalExit = 'SIGINT';
        finishSession(EXIT_CODES.sigint, 'run-end');
      }
    },
    get engine() {
      return engine;
    },
    context,
    redact,
    get view(): SessionView {
      return {
        sessionId,
        runs,
        phase,
        sessionMeter,
        runCapUsd,
        pending,
        title,
        undoNotes,
        undoLog,
        index,
        firstFrameMs,
      };
    },
  };
  return controller;
}
