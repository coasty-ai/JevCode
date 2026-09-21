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
import { appendFileSync, existsSync, writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve as resolvePath } from 'node:path';
import type {
  BlockingAnswer,
  BlockingRequest,
  Candidate,
  CheckpointState,
  Decider,
  Decision,
  Engine,
  EngineEvent,
  EngineMode,
  EngineOptions,
  EngineSeed,
  EngineStatus,
  GitState,
  HistoryStore,
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
  SessionHost,
  SessionRow,
  SignalName,
  SpendMeter,
  StepRecord,
  SteerResult,
  StopReason,
  Synthesizer,
  UiConfig,
  UiLabel,
  UndoLogEntry,
} from '../core/types.js';
import type { ParsedFlags } from './args.js';
import { classifyResumeValue } from './args.js';
import { ConfigError, EXIT_CODES, UsageError, isJevCodeError } from '../errors.js';
import { nowIso as defaultNowIso } from '../core/time.js';
import { createLog, fallbackLogPath, logSettingsFromEnv, nullLog, type Log } from '../core/log.js';
import { detectSecrets as detectSecretsByPattern, patternRedact, secretSpans as spansOf } from '../core/redact.js';
import { parseJson } from '../core/json.js';
import { exitCodeFor } from '../loop/stop.js';
import { createSpendMeter } from '../spend/meter.js';
import { resolveConfig as realResolveConfig, modeFromParsedFlags, reconcileResumeConfig, resumeIdentityFromRunMeta, resumeInputsFrom } from '../config/resolve.js';
import type { ResolvedConfigWithDiagnostics } from '../config/types.js';
import { credentialsPath, readCredentialsFile, shadowingLine, writeCredentials as realWriteCredentials, type CredentialsPatch } from '../config/credentials.js';
import { loadInstructions as realLoadInstructions, projectInstructionFile } from '../config/instructions.js';
import { createTrustStore as realCreateTrustStore, decisionFromOption, probeTrustInputs as realProbeTrustInputs, trustKey, trustWorkspaceFlag, type TrustDecision, type TrustInputs, type TrustOption } from '../config/trust.js';
import { PROVIDER_ENV } from '../tui/onboarding/lines.js';
import { INSTRUCTIONS_NOT_TRUSTED_LINE, dotenvSourceText, fixBlockLines, sandboxText, trustLines } from '../tui/onboarding/lines.js';
import type { WizardProvider } from '../tui/onboarding/reducer.js';
import { keyEnteredText } from '../config/credentials.js';
import { fingerprint } from '../core/hash.js';
import { detectSandboxLevel } from '../sandbox/seatbelt.js';
import { isMentionDenied } from '../sandbox/paths.js';
import { loadForResume as realLoadForResume } from '../checkpoint/resume.js';
import { CHECKPOINT_FILES, createCheckpointStore, isRunMeta } from '../checkpoint/store.js';
import { readPostImages, readPreImage } from '../checkpoint/images.js';
import { INDEX_FILE, appendIndexLine as realAppendIndexLine, readIndex as realReadIndex, sessionFieldsOf, text60, type IndexLine } from '../session/index.js';
import { buildSeed, carriedSteers, seedSource, type SeedParent } from '../session/seed.js';
import { defaultExportPath, exportSession as realExportSession, type ExportRun } from '../session/export.js';
import { ambiguousResumeMessage, noSessionMessage, pickerHeader, pickerRows, recentSessionHint, resolveResumeTarget } from '../session/picker-lines.js';
import { listCandidates as realListCandidates } from '../workspace/files.js';
import { probeGitState as realProbeGitState, readHead, toRunGitMetaEnd } from '../workspace/gitstate.js';
import { createSandbox as realCreateSandbox } from '../sandbox/run.js';
import { keybindingsPath, loadKeybindings as realLoadKeybindings, type KeybindingsLoad } from '../tui/keys/keybindings-file.js';
import { KEY_ACTIONS, KEY_CONTEXTS, displayKey } from '../tui/keys/bindings.js';
import type { KeyRunPhase } from '../tui/keys/resolve.js';
import { createHistoryStore as realCreateHistoryStore, type FileHistoryStore } from '../tui/composer/history.js';
import { COMMANDS } from '../tui/commands/registry.js';
import { dispatchCommand, type CommandAction, type DispatchContext } from '../tui/commands/dispatch.js';
import { formatTranscriptItem, itemsFromEvent, type LineSource } from '../tui/plain.js';
import { plainSupports } from '../tui/plain-composer.js';
import { blockingRowsFull } from '../tui/blocking/lines.js';
import { gatePlainPrompt, gateRefusalLine } from '../tui/secrets/gate-lines.js';
import { copyRedacted } from '../tui/secrets/clipboard.js';
import {
  childCapUsd,
  costBlock,
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
import { configTableLines } from './config-table.js';
import type { JsonStream } from './json-stream.js';
import { GLYPHS } from '../tui/glyphs.js';
import { findDecision, parseWhyRef, whyBlock } from '../tui/why.js';
import { calibrationBlock, calibrationStats, scanCalibration } from '../tui/calibration.js';
import { toDecisionRow, type DecisionRow } from '../tui/pane/model.js';
import { decisionRows } from '../tui/pane/decisions.js';
import { planRows } from '../tui/pane/plan.js';
import { applyUndo, prepareUndo, type ApplyUndoResult, type UndoAsk } from '../undo/apply.js';
import { REWIND_CHOICE, REWIND_PLAN_FALLBACK_NOTICE, planRewind, rewindCandidates, rewindPickerRows, type RewindStep } from '../undo/plan.js';
import { DIFF_INLINE_MAX_LINES, collectFullDiff, diffStatBlockFromGit, diffStepLines, type StepDiffFile } from '../undo/diff.js';
import { openFullDiff } from '../undo/pager.js';
import { commandLogout as realCommandLogout } from './login.js';
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
/** TUI-DESIGN §5.3 per-terminal notes of the help block (verbatim). */
export const HELP_TERMINAL_NOTES: readonly string[] = ['Shift+Enter needs a keyboard protocol: use Ctrl+J or \\ then Enter', 'macOS: turn on "Option as Meta" for Alt-b/Alt-f'];
/** TUI-DESIGN §5.3: the help block is at most this many lines. */
export const HELP_MAX_LINES = 60;
/** decisions kept for `/decisions`, `/why` and `/calibration` of the current run */
export const DECISIONS_KEPT_FOR_COMMANDS = 400;
/** recent warnings/errors kept for `/errors` */
export const ERRORS_KEPT = 50;
/** TUI-DESIGN §8.6: steers accepted while the engine is still being created (the same cap as the engine's queue) */
export const STARTING_STEER_CAP = 8;
/** §3.3: the bound on the render flush that commits the renderer's last item (`[ui] exited on Ctrl-C ×2`) before the unmount */
export const FINAL_FLUSH_BOUND_MS = 300;
/** §12.4 "all checks before the first write": the commands that run one at a time (files, credentials, the session's run list) */
export const EXCLUSIVE_COMMANDS: ReadonlySet<CommandAction['kind']> = new Set<CommandAction['kind']>(['undo', 'rewind', 'diff', 'export', 'report', 'login', 'logout', 'resume', 'new', 'trust', 'historyClear']);

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

/** TUI-DESIGN §11.1: what the wizard collected — the controller persists it (`addSecret` first, then the atomic 0600 write). */
export type WizardOutcome = { kind: 'saved'; patch: CredentialsPatch } | { kind: 'persisted' } | { kind: 'cancelled' };

/**
 * TUI-DESIGN §0 "one modal slot": the prompts a renderer may answer. Every member is optional; the controller takes
 * the C46 safe default for an absent one. The Ink renderer exposes its implementation as `prompts` (duck-typed by
 * `main.tsx`), the `--plain` TTY uses `createPlainPrompter` over the readline composer's line source.
 */
export interface Prompter {
  /** §11.1 wizard (`reason` `missing` at start, `login` for `/login`, `rejected` after a 401 pane) */
  wizard?(missing: readonly SecretSettingName[], o: { provider: WizardProvider | null; reason: 'missing' | 'login' | 'rejected' }): Promise<WizardOutcome>;
  /** §11.3 trust gate: 1 trust · 2 this session only · 3 don't trust; null = cancelled (= 3) */
  trust?(inputs: TrustInputs): Promise<TrustOption | null>;
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
  buildSynthesizer?: (config: ResolvedConfigWithDiagnostics, decider: Decider) => Promise<Synthesizer>;
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
  /** §11.1 save (the Ink wizard's host): addSecret first, the atomic 0600 write, the `[setup]` items, resolveConfig again */
  persistCredentials(patch: CredentialsPatch, source: 'wizard' | 'login'): Promise<{ ok: boolean; items: string[]; error?: string }>;
  /** the current workspace's trust inputs (null before the trust gate probed them) */
  trustInputs(): TrustInputs | null;
  /** the `[sandbox]` line for the wizard's sandbox step */
  sandboxLine(): string | null;
  /** the engine mode of the next run */
  mode(): EngineMode;
  /** `<runsDir>` once the configuration resolved */
  runsDir(): string | null;
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
// config.generator() never called under `--mode jev-only`)
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
    const { createMockProvider } = await import('../provider/mock.js');
    const { mockTrajectory } = await import('./mock-trajectory.js');
    return createMockProvider({ turns: mockTrajectory(Number(flags.mockSteps ?? 8)) });
  }
  const gen = config.generator();
  if (gen.provider === 'openrouter') {
    const { createOpenRouterProvider } = await import('../provider/openrouter.js');
    return createOpenRouterProvider(gen, { redact: config.redact });
  }
  const { createAnthropicProvider } = await import('../provider/anthropic.js');
  return createAnthropicProvider(gen, { redact: config.redact });
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

export async function buildDecider(config: ResolvedConfigWithDiagnostics, flags: ParsedFlags, env: NodeJS.ProcessEnv = process.env): Promise<Decider> {
  if (flags.mock) {
    const { createMockDecider, scoreAnswer } = await import('../jev/mock.js');
    const reviewAt = mockReviewStep(env);
    if (reviewAt === null) return createMockDecider({});
    return createMockDecider({
      rules: [
        (ctx) => {
          if (ctx.stage !== 'risk' || ctx.step !== reviewAt) return undefined;
          const q = ctx.questions['destructive'];
          if (q === undefined || q.type !== 'score') return undefined;
          return { destructive: scoreAnswer(q, { 2: 1 }) };
        },
      ],
    });
  }
  const { createJevDecider } = await import('../jev/client.js');
  return createJevDecider(config.decider(), { redact: config.redact });
}

/** jev-only: `createSynthesizer({ decider, redact })` unchanged (§15.3). */
export async function buildSynthesizer(config: ResolvedConfigWithDiagnostics, decider: Decider): Promise<Synthesizer> {
  const { createSynthesizer } = await import('../synth/index.js');
  return createSynthesizer({ decider, redact: config.redact });
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
  stdin?: { setRawMode?: ((mode: boolean) => unknown) | undefined; isRaw?: boolean | undefined } | undefined;
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

  /** one line from the shared source (null on EOF) */
  function ask(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (o.lines.closed) {
        resolve(null);
        return;
      }
      let done = false;
      let release: (() => void) | null = null;
      let unclose: (() => void) | null = null;
      const finish = (v: string | null): void => {
        if (done) return;
        done = true;
        release?.();
        unclose?.();
        resolve(v);
      };
      release = o.lines.onLine((line) => finish(line));
      unclose = o.lines.onClose(() => finish(null));
      write(prompt);
    });
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
      const line = await ask(prompt);
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
    async wizard(missing, w) {
      const patch: CredentialsPatch = {};
      let provider: WizardProvider | null = w.provider;
      if (missing.includes('generator.apiKey')) {
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
      if (missing.includes('decider.apiKey')) {
        const reuse = provider === 'openrouter' && patch.apiKey !== undefined;
        const k = await askMasked(`Jev API key (JEV_API_KEY; falls back to OPENROUTER_API_KEY)${reuse ? ' — Enter = reuse the OpenRouter key for Jev' : ''}: `);
        if (k === null) return { kind: 'cancelled' };
        if (k.length >= 8) patch.jevApiKey = k;
        else if (reuse && patch.apiKey !== undefined) patch.jevApiKey = patch.apiKey;
        else return { kind: 'cancelled' };
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

/** TUI-DESIGN §5.3: the help block — keys grouped by context, commands with one-liners, per-terminal notes; ≤ 60 lines. */
export function helpLines(topic: 'all' | 'keys' | 'commands', o: { live: boolean; ascii?: boolean } = { live: false }): string[] {
  const out: string[] = [];
  if (topic !== 'commands') {
    for (const ctx of KEY_CONTEXTS) {
      const rows = KEY_ACTIONS.filter((a) => a.context === ctx && a.keys.length > 0);
      if (rows.length === 0) continue;
      out.push(`keys · ${ctx}: ${rows.map((a) => `${a.keys.map((k) => displayKey(k, o.ascii === true)).join('/')} ${a.short}`).join(' · ')}`);
    }
  }
  if (topic !== 'keys') {
    for (const c of COMMANDS) {
      const avail = c.availableDuringTask === 'any' ? '' : c.availableDuringTask === 'idle' ? (o.live ? '  (idle only)' : '') : o.live ? '' : '  (live only)';
      out.push(`/${c.name}${c.usage === '—' ? '' : ` ${c.usage}`}  ${c.title}${avail}`);
    }
  }
  out.push(...HELP_TERMINAL_NOTES);
  return out.slice(0, HELP_MAX_LINES);
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
  const loadRunFn = deps.loadRun ?? loadRun;
  const loadForResumeFn = deps.loadForResume ?? ((runsDir: string, runId: string, opts: { redact: (s: string) => string }) => realLoadForResume(runsDir, runId, opts));
  const writeCredentialsFn = deps.writeCredentials ?? realWriteCredentials;
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
  /** resolves when startup finished (or failed): a line typed into the readline composer before resolveConfig waits here instead of failing */
  let startupSettled: (() => void) | null = null;
  const startupDone = new Promise<void>((r) => {
    startupSettled = r;
  });
  let deciderModelConfigured: string | null = null;
  let workspaceRoot = cwd;
  let diffSeq = 0;

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
  };
  const extras = renderer as RendererExtras;
  function pushSessionSpend(): void {
    try {
      const snap = sessionMeter.snapshot();
      extras.setSessionSpend?.({ totalUsd: snap.totalUsd, capUsd: snap.capUsd });
    } catch {
      /* the renderer is gone */
    }
  }
  let lastTrustInputs: TrustInputs | null = null;

  // --- renderer-originated lines (§15.1) ------------------------------------------------------
  function notifyLocal(text: string, opts: { detail?: string; label?: UiLabel; level?: 'info' | 'warn' | 'error' } = {}): void {
    const r = renderer as Renderer & { notify?: Renderer['notify'] };
    if (typeof r.notify === 'function') {
      r.notify(text, { ...(opts.level ? { level: opts.level } : {}), ...(opts.detail ? { detail: opts.detail } : {}), ...(opts.label ? { label: opts.label } : {}) });
    } else log.info(`[idle item] ${opts.label ?? '[ui]'} ${text}`);
  }

  /** §15.1: `engine.annotate()` while a run is live, else a local item (+ the `--json` `ui` line, written by the json renderer's notify) */
  function note(text: string, opts: { detail?: string; label?: UiLabel; level?: 'info' | 'warn' | 'error' } = {}): void {
    const e = engine;
    if (e !== null && live()) {
      try {
        if (e.annotate(text, opts)) return;
      } catch (err) {
        log.warn(`annotate failed: ${describe(err)}`);
      }
    }
    notifyLocal(text, opts);
  }

  /** a multi-line block: one labelled item with the body as its TUI detail; the line renderers print the body as lines (their items carry no body) */
  function block(head: string, lines: readonly string[], opts: { label?: UiLabel; level?: 'info' | 'warn' | 'error' } = {}): void {
    if (o.rendererKind === 'tui') {
      note(head, { ...opts, ...(lines.length > 0 ? { detail: lines.join('\n') } : {}) });
      return;
    }
    note(head, opts);
    for (const l of lines) note(l, opts);
  }

  function uiError(text: string): void {
    note(text.startsWith('error:') ? text : `error: ${text}`, { label: '[ui]', level: 'error' });
  }

  function warnLine(text: string): void {
    // §9.5 (A136): `jevcode: <warning>` on stderr for the line renderers (a --plain TTY, a pipe, --json), one `warning: …` item in the TUI
    if (o.rendererKind !== 'tui') stderr.write(`jevcode: ${text}\n`);
    else note(`warning: ${text}`, { level: 'warn' });
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
    if (r.error) log.warn(r.error);
  }
  function sessionRows(): SessionRow[] {
    return index;
  }

  // --- exit paths (§13.5) ----------------------------------------------------------------------
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
    };
  }

  const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms).unref());

  /** the one exit: json session:end, unmount, restore, (one-shot / signal) epilogue on stderr, resolve run() */
  function finishSession(code: number, why: 'exit' | 'error' | 'run-end'): void {
    if (exiting) return;
    exiting = true;
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
  async function persistCredentials(patch: CredentialsPatch, source: 'wizard' | 'login'): Promise<{ ok: boolean; items: string[]; error?: string }> {
    if (!config) return { ok: false, items: [], error: 'configuration not ready' };
    const items: string[] = [];
    const setup = (text: string): void => {
      items.push(text);
      note(text, { label: '[setup]' });
    };
    // §11.1 save: addSecret FIRST, then the items, then the atomic 0600 write
    if (patch.apiKey !== undefined) {
      config.addSecret('wizard:generator.apiKey', patch.apiKey);
      setup(keyEnteredText('generator', fingerprint(patch.apiKey), source));
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
      uiError(`/login: ${describe(e)}`);
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
    // §8.7: a `/theme` chosen in this session outlives every re-resolution (/login, /logout, a pending /model|/provider|/mode)
    uiConfig = { ...config.ui(o.launch), ...(themeOverride !== null ? { theme: themeOverride } : {}) };
    renderer.setUi?.(uiConfig);
    runCapUsd = config.limits().spendCapUsd;
  }

  /** the wizard (start or `/login`); true when a key was saved */
  async function runLogin(reason: 'missing' | 'login' | 'rejected'): Promise<boolean> {
    if (!config) return false;
    const mode = pending.mode ?? baseMode;
    const missing = reason === 'missing' ? config.missingSecrets(mode) : (['generator.apiKey', 'decider.apiKey'] as const).filter((n) => mode !== 'jev-only' || n !== 'generator.apiKey');
    if (missing.length === 0) {
      note('every key resolves already; use /logout to remove one', { label: '[setup]' });
      return false;
    }
    const providerEntry = config.entries.get('generator.provider')?.value;
    const provider: WizardProvider | null = providerEntry === 'anthropic' || providerEntry === 'openrouter' ? providerEntry : null;
    if (!prompter?.wizard) {
      block('no key found — set them in the environment or run jevcode login:', fixBlockLines(), { label: '[setup]', level: 'warn' });
      return false;
    }
    const outcome = await prompter.wizard(missing, { provider, reason });
    if (outcome.kind === 'cancelled') return false;
    // 'persisted': the Ink wizard's host already saved through persistCredentials (tui-prompter.ts)
    const saved = outcome.kind === 'persisted' ? true : (await persistCredentials(outcome.patch, reason === 'missing' ? 'wizard' : 'login')).ok;
    if (saved && reason !== 'missing') note(LOGIN_SAVED_TOAST, { label: '[setup]' });
    return saved;
  }

  /** §11.2 P43: the shadowing line when env/dotenv and the file disagree */
  async function shadowingLines(): Promise<void> {
    if (!config) return;
    try {
      const target = credentialsPath({ env, home, cwd, configFlag: flags.config ?? null });
      const file = await readCredentialsFile(target.path);
      if (!file.exists) return;
      const g = shadowingLine('generator.apiKey', config.entries.get('generator.apiKey'), 'ANTHROPIC_API_KEY', target.path, file.apiKey, home);
      const j = shadowingLine('decider.apiKey', config.entries.get('decider.apiKey'), 'JEV_API_KEY', target.path, file.jevApiKey, home);
      for (const l of [g, j]) if (l !== null) note(l, { label: '[config]' });
    } catch {
      /* no file */
    }
  }

  // --- trust gate and instruction files (§11.3) -------------------------------------------------
  async function trustGate(reopen = false): Promise<void> {
    if (!config) return;
    const gitRoot = gitAtStart?.topLevel ?? null;
    let loaded;
    try {
      loaded = await loadInstructionsFn(workspaceRoot, gitRoot, home, { env, redact: config.redact });
    } catch (e) {
      log.warn(`instructions: ${describe(e)}`);
      instructions = null;
      return;
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
      const option = prompter?.trust ? await prompter.trust(inputs) : null;
      if (exiting) return; // F3: the prompt was settled by finishSession — nothing is decided, nothing is stored
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
  }

  // --- session meter and follow-up gate (§9.1, §9.3) -----------------------------------------------
  function newSessionMeter(): void {
    if (!config) return;
    const cap = config.sessionSpendCap(pending.mode ?? baseMode);
    sessionCapUsd = cap.value;
    sessionMeter = createSpendMeter(sessionCapUsd);
    sessionCapExplicit = false;
    deferredBudgetLines = [];
  }

  /** §9.1 `/resume` of a run this controller did not run: fold the index excluding the resumed run, add every finished run's cost */
  function seedMeterFromIndex(sid: string, excludeRunId: string): void {
    const s = index.find((x) => x.sessionId === sid);
    if (!s) return;
    for (const r of s.runs) {
      if (r.runId === excludeRunId || r.costUsd === null) continue;
      sessionMeter.add('generator', { inputTokens: 0, outputTokens: 0, costUsd: r.costUsd.generator, calls: 0 });
      sessionMeter.add('jev', { inputTokens: 0, outputTokens: 0, costUsd: r.costUsd.jev, calls: 0 });
    }
  }

  // --- the run (§1 loop body) -------------------------------------------------------------------
  interface StartOptions {
    kind: 'prompt' | 'follow-up';
    pinnedFiles: readonly string[];
    secretsAcked: number;
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
    const cfg = config;
    const mode = pending.mode ?? baseMode;
    if (cfg.missingSecrets(mode).length > 0) {
      const saved = await runLogin('missing');
      if (!saved && config.missingSecrets(mode).length > 0) {
        uiError(`missing ${config.missingSecrets(mode).join(', ')}: run jevcode login or set the environment variable`);
        return;
      }
    }
    const limits = limitsWithPending(cfg.limits());
    runCapUsd = limits.spendCapUsd;
    // §9.4: the first run rebuilds the root meter from the config (the mode may have changed) unless `/budget session-spend-cap` set it
    if (runs.length === 0 && sessionId === null && !sessionCapExplicit) newSessionMeter();
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
      const decider = await deciderOf(cfg, flags);
      const remaining = sessionRemainingUsd(sessionCapOf(), sessionTotal());
      const childCap = Math.max(0, Math.min(limits.spendCapUsd, remaining));
      const meter = sessionMeter.child(childCap);
      // jev-only never validates the generator section (§15.3)
      const gen = mode === 'jev-only' || flags.mock || flags.mockGenerator ? { temperature: null, maxTokens: 4096 } : cfg.generator();
      const dec = flags.mock ? { model: 'typesafe/jev-1.13-20260917', pinned: true } : cfg.decider();
      deciderModelConfigured = dec.model;
      const synthesizer = mode === 'jev-only' ? await synthesizerOf(cfg, decider) : null;
      const source = flags.source === 'perf' ? 'perf' : 'cli';
      const opts: EngineOptions = {
        task: text,
        mode,
        workspace: cfg.workspace,
        runsDir: cfg.runsDir,
        provider,
        decider,
        confirmer: renderer.confirmer,
        meter,
        limits,
        sandboxProfile: cfg.sandbox,
        noNetwork: cfg.noNetwork,
        configRecord: cfg.record(),
        redact: cfg.redact,
        secretPaths: cfg.secretPaths,
        generation: { temperature: gen.temperature, maxTokens: gen.maxTokens },
        deciderModel: { configured: dec.model, pinned: dec.pinned },
        ...(synthesizer ? { synthesizer } : {}),
        exit: engineExit,
        configDirs: cfg.configDirs,
        session: {
          sessionId,
          parentRunId: seeded.parentRunId,
          source,
          ...(title !== null ? { title } : {}),
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
    runs.push(record);
    if (sessionId === null) sessionId = f.runId;
    const sid = sessionId;
    retargetLogToRun(f.runDir);
    renderer.attach(eng);
    const detach = eng.events.onAny(onEvent);
    // §8.2: run:start right after createEngine; §8.9: session:start once per session
    const branch = gitAtStart?.head?.kind === 'branch' ? gitAtStart.head.name : null;
    indexLine({ v: 1, t: f.startedAt, kind: 'run:start', sessionId: sid, runId: f.runId, parentRunId: f.parentRunId, workspace: workspaceRoot, task60: f.task, mode: f.mode, source: flags.source === 'perf' ? 'perf' : 'cli', branch, resumeOf: f.resumed ? f.runId : null });
    // §8.2 / §9.4: `/budget session-spend-cap` lines issued before the session had an id carry this session's id now
    for (const b of deferredBudgetLines.splice(0)) indexLine({ v: 1, t: b.t, kind: 'budget', sessionId: sid, runId: null, setting: 'session.spendCapUsd', from: b.from, to: b.to });
    if (!sessionStartAnnounced) {
      sessionStartAnnounced = true;
      json?.sessionStart({ sessionId: sid, runId: f.runId, parentRunId: f.parentRunId, workspace: workspaceRoot });
    }
    // §8.6: the steers typed while the engine was being created; the engine's own refusals are reported, never dropped
    for (const s of startingSteers.splice(0)) {
      const r = eng.steer(s);
      if (!r.ok) uiError(r.reason === 'full' ? 'steer queue full (8)' : r.reason === 'empty' ? '/steer: empty text' : '/steer needs a live run');
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
    if (cfg) candidates = listCandidatesFn(workspaceRoot, { secretPaths: cfg.secretPaths, redact: cfg.redact }).catch(() => []);
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
    const ctx: EpilogueContext = { runId: record.runId, runDir: record.runDir, resumable: epilogueResumable(record), stopReason: result.stopReason, exitCode: record.exitCode ?? 0, degraded: record.degraded, home };
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
    const { text, detail } = epilogueItemLines(result.error ?? null, ctx, redact);
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
      uiError('/resume runs when the run is idle; Esc pauses first');
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
      const remaining = sessionRemainingUsd(sessionCapOf(), sessionTotal() - (known ? resumedSpend : 0));
      const childCap = Math.max(0, Math.min(rec.limits.spendCapUsd, remaining));
      const meter = sessionMeter.child(childCap);
      if (!known) sessionMeter.add('generator', { inputTokens: 0, outputTokens: 0, costUsd: loaded.state.spend.generator.costUsd, calls: 0 });
      if (!known) sessionMeter.add('jev', { inputTokens: 0, outputTokens: 0, costUsd: loaded.state.spend.jev.costUsd, calls: 0 });
      const provider = await providerOf(rcfg, augmented, identity.mode);
      const decider = await deciderOf(rcfg, augmented);
      const gen = identity.mode === 'jev-only' || flags.mock || flags.mockGenerator ? { temperature: null, maxTokens: 4096 } : rcfg.generator();
      const dec = flags.mock ? { model: 'typesafe/jev-1.13-20260917', pinned: true } : rcfg.decider();
      deciderModelConfigured = dec.model;
      const synthesizer = identity.mode === 'jev-only' ? await synthesizerOf(rcfg, decider) : null;
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
        confirmer: renderer.confirmer,
        meter,
        limits: rec.limits,
        sandboxProfile: identity.sandbox ?? rcfg.sandbox,
        noNetwork: rcfg.noNetwork,
        configRecord: rcfg.record(),
        redact: rcfg.redact,
        secretPaths: rcfg.secretPaths,
        generation: { temperature: gen.temperature, maxTokens: gen.maxTokens },
        deciderModel: { configured: dec.model, pinned: dec.pinned },
        ...(synthesizer ? { synthesizer } : {}),
        exit: engineExit,
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
      uiError(`/resume: ${redact(describe(e))}`);
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
      else uiError(`/resume: session "${c.title}" has no run`);
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
      uiError('/undo: no finished run in this session yet');
      return;
    }
    const target = step ?? last.changedSteps.at(-1) ?? null;
    if (target === null) {
      uiError('/undo: no step of the last run changed files');
      return;
    }
    const git = await gitFacts();
    const prepared = await prepareUndo(last.runDir, target, { root: workspaceRoot, headOid: git.headOid, git: git.git });
    if (!prepared.ok) {
      uiError(`/undo: ${prepared.message}`);
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
      uiError('/rewind: no finished run in this session yet');
      return;
    }
    const steps = rewindSteps(last);
    const candidatesList = rewindCandidates(steps);
    if (candidatesList.length === 0) {
      uiError('/rewind: no step of the last run changed files');
      return;
    }
    let target = step;
    if (target === null) {
      if (prompter?.rewind) target = await prompter.rewind(steps);
      else {
        block('rewind · steps with changes', rewindPickerRows(steps, columns()));
        uiError('/rewind: pick a step with /rewind <step>');
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
        uiError(`/rewind: step ${s}: ${prepared.message}`);
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
      uiError('/diff: no run in this session yet');
      return;
    }
    const git = await gitFacts();
    if (a.step !== null) {
      const post = await readPostImages(run.runDir, a.step);
      if (!post.ok) {
        uiError(`/diff ${a.step}: ${post.detail}`);
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
      block(lines[0] ?? `diff step ${a.step}`, lines.slice(1));
      return;
    }
    if (!git.git) {
      uiError('/diff: not a git repository; /diff <step> compares against step pre-images');
      return;
    }
    const sandbox = makeSandbox(cfg, run.runDir, git);
    if (!sandbox) {
      uiError('/diff: no sandbox available for git');
      return;
    }
    const io = { sandbox, root: workspaceRoot, runId: run.runId, changedFiles: run.changedFiles, ...(git.unborn ? { unborn: true } : {}) };
    if (a.full) {
      if (live()) {
        uiError('/diff --full runs when the run is idle; Esc pauses first');
        return;
      }
      const collected = await collectFullDiff({ ...io, color: o.stdout.isTTY === true, secretPaths: cfg.secretPaths, redact: cfg.redact });
      const suspend = prompter?.suspendTerminal;
      const r = await openFullDiff({ suspendTerminal: suspend ?? ((run) => run()), env, isTTY: o.stdout.isTTY === true && suspend !== undefined, text: collected.text, notice: collected.notice, runDir: run.runDir, seq: ++diffSeq });
      if (r.mode === 'pager') note(`diff: ${r.command} showed ${r.file}${r.exitCode !== null && r.exitCode !== 0 ? ` (exit ${r.exitCode})` : ''}`);
      else block(r.lines[0] ?? 'diff', r.lines.slice(1));
      for (const err of collected.errors) warnLine(err);
      return;
    }
    const r = await diffStatBlockFromGit({ ...io, ...(a.all ? { all: true } : {}) }, columns());
    block(r.lines[0] ?? 'diff', r.lines.slice(1));
    for (const err of r.errors) warnLine(err);
  }

  // --- /export (§8.7) ---------------------------------------------------------------------------
  async function exportCommand(file: string | null): Promise<void> {
    const cfg = config;
    if (!cfg || sessionId === null) {
      uiError('/export: no session yet');
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
      note(`exported ${r.runs} run${r.runs === 1 ? '' : 's'} to ${r.path}${r.truncated ? ' (truncated at 64 MiB)' : ''}${r.missing.length > 0 ? ` · ${r.missing.length} transcript${r.missing.length === 1 ? '' : 's'} missing` : ''}`);
    } catch (e) {
      uiError(`/export: ${redact(describe(e))}`);
    }
  }

  // --- /budget (§9.4) ---------------------------------------------------------------------------
  function budgetCommand(a: Extract<CommandAction, { kind: 'budget' }>): void {
    if (a.set === null) {
      const run = current ?? lastFinishedRun();
      const spent = run ? (run.endedAt === null ? lastStatus?.spend.totalUsd ?? 0 : run.costUsd.generator + run.costUsd.jev) : 0;
      const lines = [`run cap ${usd3(runCapUsd)} · run spend ${usd3(spent)}`, `session cap ${usd2(sessionCapOf())} · session spend ${usd2(sessionTotal())} (${runs.filter((r) => r.endedAt !== null).length} runs)`];
      const pend = pendingLines();
      block('budget', [...lines, ...(pend.length > 0 ? pend : ['pending: none'])]);
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

  function pendingLines(): string[] {
    const out: string[] = [];
    if (pending.spendCapUsd !== undefined) out.push(`pending: spend-cap ${pending.spendCapUsd.toFixed(2)} (next /resume or run)`);
    if (pending.maxSteps !== undefined) out.push(`pending: max-steps ${pending.maxSteps} (next /resume or run)`);
    if (pending.maxWall !== undefined) out.push(`pending: max-wall ${pending.maxWall.text} (next /resume or run)`);
    if (pending.maxReplans !== undefined) out.push(`pending: max-replans ${pending.maxReplans} (next /resume or run)`);
    if (pending.maxGeneratorTokens !== undefined) out.push(`pending: max-generator-tokens ${pending.maxGeneratorTokens} (next /resume or run)`);
    if (pending.model !== undefined) out.push(`pending: model ${pending.model} (next run)`);
    if (pending.provider !== undefined) out.push(`pending: provider ${pending.provider} (next run)`);
    if (pending.mode !== undefined) out.push(`pending: mode ${pending.mode} (next run)`);
    return out;
  }

  function pendingBudgetPairs(): { setting: string; value: string }[] {
    const out: { setting: string; value: string }[] = [];
    if (pending.spendCapUsd !== undefined) out.push({ setting: 'spend-cap', value: pending.spendCapUsd.toFixed(2) });
    if (pending.maxSteps !== undefined) out.push({ setting: 'max-steps', value: String(pending.maxSteps) });
    if (pending.maxWall !== undefined) out.push({ setting: 'max-wall', value: pending.maxWall.text });
    if (pending.maxReplans !== undefined) out.push({ setting: 'max-replans', value: String(pending.maxReplans) });
    if (pending.maxGeneratorTokens !== undefined) out.push({ setting: 'max-generator-tokens', value: String(pending.maxGeneratorTokens) });
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
    const lines = costBlock({
      mode,
      run: run ? { spentUsd: spent, capUsd: runCapUsd, perStepUsd: records.map((r) => r.usage.generator.costUsd + r.usage.jev.costUsd) } : null,
      session: { spentUsd: sessionTotal(), capUsd: sessionCapOf(), runs: runs.filter((r) => r.endedAt !== null).length },
      gen: run ? { usd: genUsd, tablePriced } : null,
      jev: run ? { usd: jevUsd, questions, p50Ms: p50 } : null,
      basis: { generator: mode === 'jev-only' ? null : tablePriced ? 'table' : 'provider usage.cost', jev: 'provider usage.cost' },
      pending: pendingBudgetPairs(),
      ...(flags.allowUnpriced ? { unpriced: true } : {}),
    });
    block(lines[0] ?? 'cost', lines.slice(1));
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
    block('jev', [
      `decider ${configured}${resolved ? ` → resolved ${resolved}` : ''}${drift ? ` · drift@step ${drift.step} → ${drift.served}` : ''}`,
      `questions ${questions} · latency p50 ${p(50)} · p95 ${p(95)} · jev cost ${usd3(jevUsd)}`,
    ]);
  }

  function statusCommand(): void {
    const run = current ?? lastFinishedRun();
    const g = gitAtStart;
    const gitText = g === null ? 'unknown' : !g.repo ? 'none' : g.head === null ? 'no HEAD' : g.head.kind === 'branch' ? g.head.name : g.head.kind === 'detached' ? g.head.oid.slice(0, 8) : `${g.head.name} (unborn)`;
    const stage = live() ? lastStatus?.stage ?? phase : 'idle';
    block('status', [
      `run ${run?.runId ?? '—'} · session ${sessionId ?? '—'}${title !== null ? ` "${title}"` : ''}`,
      `step ${currentStep()}/${lastStatus?.maxSteps ?? config?.limits().maxSteps ?? '–'} · stage ${stage} · phase ${phase}`,
      `sandbox ${config ? detectSandboxLevel(config.sandbox) : '—'} · workspace ${workspaceRoot} · git ${gitText}`,
      `stop ${run?.stopReason ?? '—'}${run?.exitCode !== null && run?.exitCode !== undefined ? ` (exit ${run.exitCode})` : ''} · lock ${live() ? 'held' : 'released'} · runs ${runs.length}`,
    ]);
  }

  function decisionsCommand(n: number, stage: Decision['stage'] | null): void {
    const rows: DecisionRow[] = decisions
      .filter((d) => stage === null || d.stage === stage)
      .slice(-n)
      .map((d) => toDecisionRow(d, config?.limits().completeThreshold, config?.limits().impossibleThreshold));
    const lines = decisionRows({ tab: 'd', step: currentStep(), rows, plan: null, timeline: [], synth: null, mode: pending.mode ?? baseMode }, Math.max(1, rows.length), columns(), o.launch.ascii ? GLYPHS.ascii : GLYPHS.unicode);
    block(`decisions (last ${rows.length})`, lines);
  }

  function planCommand(): void {
    const plan = lastPlan ?? lastResult?.finalPlan ?? null;
    const lines = planRows({ tab: 'p', step: currentStep(), rows: [], plan: plan ? { step: currentStep(), plan } : null, timeline: [], synth: null }, 40, columns(), o.launch.ascii ? GLYPHS.ascii : GLYPHS.unicode);
    block('plan', lines);
  }

  function whyCommand(ref: string): void {
    const parsed = parseWhyRef(ref);
    if (parsed === null) {
      uiError(`/why: expected s7.risk.plan_mismatch, risk.plan_mismatch or a digit 1-5, got "${ref}"`);
      return;
    }
    const d = findDecision(decisions, parsed, currentStep() > 0 ? currentStep() : null);
    if (d === null) {
      uiError(`/why: no decision matches ${ref}`);
      return;
    }
    const lines = whyBlock(d, { siblings: decisions.filter((x) => x.step === d.step), model: lastResult?.resolvedJevModel ?? null }, o.launch.ascii ? GLYPHS.ascii : GLYPHS.unicode);
    block(lines[0] ?? 'why', lines.slice(1));
  }

  async function calibrationCommand(): Promise<void> {
    if (!config) return;
    const scan = await scanCalibration(config.runsDir);
    const lines = calibrationBlock(calibrationStats(scan.runs), o.launch.ascii ? GLYPHS.ascii : GLYPHS.unicode);
    block(lines[0] ?? 'calibration', lines.slice(1));
  }

  async function reportCommand(): Promise<void> {
    const cfg = config;
    const run = lastFinishedRun();
    if (!cfg || !run) {
      uiError('/report: no finished run in this session yet');
      return;
    }
    try {
      const r = await writeReportBundle({ runDir: run.runDir, runId: run.runId, out: join(jdir, 'reports', run.runId), redact: cfg.redact, configJson: { ...cfg.record(), sandboxLevel: { value: detectSandboxLevel(cfg.sandbox), source: 'derived' } }, term: env['TERM'] ?? null, termProgram: env['TERM_PROGRAM'] ?? null, columns: columns(), rows: null, fallbackLog: log.file !== '' ? log.file : null });
      note(`report written to ${r.dir} (${r.files.length} files; redacted bundle written locally; nothing is sent)`);
    } catch (e) {
      uiError(`/report: ${redact(describe(e))}`);
    }
  }

  async function logoutCommand(which: 'generator' | 'jev' | null): Promise<void> {
    const cfg = config;
    if (!cfg) return;
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
    const lines = pickerRows(rows, { workspace: workspaceRoot, widened: false, nowMs: now(), columns: columns(), sort, ascii: o.launch.ascii });
    if (lines.length === 0) {
      note(noSessionMessage(workspaceRoot));
      return;
    }
    block(pickerHeader({ workspace: workspaceRoot, widened: false, sort, columns: columns(), ascii: o.launch.ascii }), [...lines, 'continue one with /resume <id|title>']);
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
            note(`keybindings reloaded from ${p}${keybindings.found ? '' : ' (no file: defaults)'}${keybindings.warnings.length > 0 ? ` · ${keybindings.warnings.length} warning${keybindings.warnings.length === 1 ? '' : 's'} in jevcode.log` : ''}`);
          } catch (e) {
            uiError(`/help reload: ${describe(e)}`);
          }
          return;
        }
        block('help', helpLines(a.topic, { live: live(), ...(o.launch.ascii ? { ascii: true } : {}) }));
        return;
      case 'new': {
        const old = sessionId;
        if (old !== null) note(sessionEndedText(old, runs.length, sessionTotal()));
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
          if (id === null) uiError(`/continue: ${noSessionMessage(workspaceRoot)}`);
          else await resumeOrFollowUp(id, a.force);
        } else await resumeOrFollowUp(a.target.id, a.force);
        return;
      case 'rename': {
        title = text60(a.title, redact);
        extras.setTitle?.(title);
        if (sessionId) indexLine({ v: 1, t: nowIso(), kind: 'rename', sessionId, title60: title });
        note(`renamed the session to "${title}"`);
        return;
      }
      case 'steer': {
        const r = host.steer(a.text, { secretSpans: [] });
        if (!r.ok) uiError(r.reason === 'full' ? 'steer queue full (8)' : r.reason === 'finished' ? '/steer needs a live run' : '/steer: empty text');
        return;
      }
      case 'unsteer':
        if (host.unsteer() === null) uiError('/unsteer: nothing queued');
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
      case 'model':
        pending.model = a.id;
        note(`model ${a.id} pending (next run)`);
        return;
      case 'provider':
        pending.provider = a.provider;
        note(`provider ${a.provider} pending (next run)`);
        return;
      case 'mode':
        pending.mode = a.mode;
        note(`mode ${a.mode} pending (next run)`);
        return;
      case 'config': {
        if (!config) return;
        const lines = configTableLines(config.record(), { sandboxLevel: detectSandboxLevel(config.sandbox) });
        block('config', [...lines, `session.spendCapUsd effective ${usd2(sessionCapOf())}`]);
        return;
      }
      case 'login':
        await runLogin('login');
        return;
      case 'logout':
        await logoutCommand(a.which);
        return;
      case 'trust':
        await trustGate(true);
        note(trustDecision === 'none' ? 'workspace not trusted: instruction files are ignored' : `workspace trusted (${trustDecision})`, { label: '[config]' });
        return;
      case 'theme':
        themeOverride = a.theme;
        if (uiConfig) {
          uiConfig = { ...uiConfig, theme: a.theme };
          renderer.setUi?.(uiConfig);
        }
        note(`theme ${a.theme} (new items and the dynamic region only)`);
        return;
      case 'copy': {
        const text = a.what === 'last' ? lastItemText : a.what === 'proposal' ? lastProposalText : null;
        if (a.what === 'draft') {
          uiError('/copy draft is the composer\'s (TUI only)');
          return;
        }
        if (text === null) {
          uiError(`/copy: nothing to copy for ${a.what}`);
          return;
        }
        const r = await copyFn(text, redact, { ...(uiConfig?.osc52 ? { osc52: true } : {}) });
        note(r.toast, { level: r.ok ? 'info' : 'error' });
        return;
      }
      case 'export':
        await exportCommand(a.file);
        return;
      case 'status':
        statusCommand();
        return;
      case 'errors':
        block('errors', errors.length > 0 ? errors : ['(no warnings or errors yet)']);
        return;
      case 'report':
        await reportCommand();
        return;
      case 'historyClear': {
        const yes = prompter?.historyClear ? await prompter.historyClear() : !o.interactive;
        if (!yes) return;
        history?.clear();
        note('history cleared');
        return;
      }
      case 'editor':
        uiError('/editor: the external editor is Ctrl+G in the TUI composer');
        return;
      case 'exit':
        await exitCommand();
        return;
    }
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
        uiError(`/${r.spec.name}: another command is still running (/${busyCommand})`);
        return;
      }
      busyCommand = r.spec.name;
    }
    try {
      await execute(r.action);
    } catch (e) {
      uiError(`/${r.spec.name}: ${redact(describe(e))}`);
      log.error(`/${r.spec.name} failed: ${describe(e)}`);
    } finally {
      if (exclusive && busyCommand === r.spec.name) busyCommand = null;
    }
  }

  // --- the host (§15 item 16) --------------------------------------------------------------------
  const host: ControllerHost = {
    async submit(text, so) {
      await startupDone;
      // §10.2: addSecret('composer#n', span) per span BEFORE createEngine
      for (const span of so.secretSpans) config?.addSecret(`composer#${++secretSeq}`, span);
      await startRun(text, { kind: so.kind, pinnedFiles: so.pinnedFiles, secretsAcked: so.secretSpans.length });
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
    renderer.setHost?.(host);
    for (const w of config.warnings) warnLine(w);
    await shadowingLines();
    if (exiting) return;
    const mode = pending.mode ?? baseMode;
    if (config.missingSecrets(mode).length > 0) {
      const saved = prompter?.wizard ? await runLogin('missing') : false;
      if (exiting) return;
      if (!saved && config.missingSecrets(mode).length > 0) {
        if (!prompter?.wizard && (o.mode === 'one-shot' || !o.interactive)) {
          const names = config.missingSecrets(mode);
          throw new ConfigError(`missing ${names.join(', ')}: set the environment variable or run jevcode login`, { ...(names[0] !== undefined ? { setting: names[0] } : {}) });
        }
        block(`no key found for ${config.missingSecrets(mode).join(', ')}; a prompt will start once one is set:`, fixBlockLines(), { label: '[setup]', level: 'warn' });
      }
    }
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
    note(sandboxText(detectSandboxLevel(config.sandbox)), { label: '[sandbox]' });
    const cfg = config;
    candidates = listCandidatesFn(workspaceRoot, { secretPaths: cfg.secretPaths, redact: cfg.redact }).catch(() => []);
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
      if (recent) note(recentSessionHint(recent, now(), o.launch.ascii));
      return;
    }
    const task = await readTaskOption();
    if (exiting) return;
    if (task !== null) {
      await submitTask(task);
      return;
    }
    throw new UsageError('missing task text: pass it as a positional argument, --task-file <path>, or on stdin');
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

  const controller: SessionController = {
    host,
    setPrompter(p) {
      prompter = p;
    },
    persistCredentials,
    trustInputs: () => lastTrustInputs,
    sandboxLine: () => (config ? sandboxText(detectSandboxLevel(config.sandbox)) : null),
    mode: () => pending.mode ?? baseMode,
    runsDir: () => config?.runsDir ?? null,
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
        if (err instanceof ConfigError && /missing (generator|decider)\.apiKey/.test(err.message)) for (const l of fixBlockLines()) stderr.write(`${l}\n`);
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
