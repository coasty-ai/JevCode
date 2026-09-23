/**
 * Fixtures for the session-controller tests (TUI-DESIGN §19.4, §19.7): a fake `Renderer` that records `setHost`,
 * `setUi`, `attach` and every `notify()` item, a scripted engine factory (records `EngineOptions`, emits the run
 * events, holds a run live until released, honours steer / pause / abort / annotate) and `makeController`, which wires
 * both into `createSessionController` over a temporary `JEVCODE_HOME` and workspace with the mock provider flags.
 */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmitter } from '../../../src/core/events.js';
import type {
  Answer,
  BlockingAnswer,
  CheckpointState,
  Confirmer,
  Decider,
  Engine,
  EngineEvent,
  EngineOptions,
  IntakeKind,
  LaunchSettings,
  PendingDirective,
  Renderer,
  RunMeta,
  RunResult,
  SessionHost,
  SignalName,
  StopReason,
  UiConfig,
  UiLabel,
} from '../../../src/core/types.js';
import type { ParsedFlags } from '../../../src/cli/args.js';
import { exitCodeFor } from '../../../src/loop/stop.js';
import { nullLog } from '../../../src/core/log.js';
import { notRepoState } from '../../../src/workspace/gitstate.js';
import { appendIndexLine, type IndexLine } from '../../../src/session/index.js';
import { createSessionController, sessionsIndexPath, type ChatUiAction, type ControllerHost, type LoadedRun, type Prompter, type SessionController, type SessionControllerOptions, type SessionDeps } from '../../../src/cli/session.js';
import { mkRunResult } from '../../fixtures/tui/fixtures.js';
import type { UiAction } from '../../../src/tui/useEngine.js';
import { makeMeta, makeState, spend } from '../session/helpers.js';
import { choiceOver, createFakeDecider, noulA, type DeciderCall, type DeciderRule, type FakeDecider, type FakeDeciderOptions } from '../loop/fakes.js';

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-2 §3: the harness's Jev — a scripted fake decider for the intake (the controller's `deps.buildDecider`)
// ---------------------------------------------------------------------------------------

/** the harness's reading of a submission: greetings and questions by shape, everything else a task (the engine tests submit `one`, `go`, `fix it`) */
export function harnessClassify(message: string): IntakeKind {
  const m = message.trim();
  if (/^(hi|hello|hey|thanks|thank you|bye|ok|okay|good morning|good evening)\b[!. ]*$/i.test(m)) return 'greeting_or_smalltalk';
  if (m.endsWith('?')) return /\b(you|jevcode|jev|mode|cost|key|command|run)\b/i.test(m) ? 'question_about_this_tool' : 'question_about_the_code';
  return 'coding_task';
}

export interface HarnessIntakeOptions {
  /** the intake reading per message (default `harnessClassify`) */
  classify?: (message: string) => IntakeKind;
  /** the `intake` Choice's probability of the chosen kind (default 0.9); the paired Noul follows (0.9 chosen / 0.1 others) */
  p?: number;
  /** the paired Noul of the chosen kind (default 0.9) */
  paired?: number;
  /** the `reply` row chosen for a greeting (default hello_first) */
  reply?: string;
  /** `about_<key>` Nouls ≥ 0.5 for a tool question (default: mode_now, what_it_is) */
  facts?: readonly string[];
  /** every `file_<i>` lookup Noul (default 0.7 for the first candidate, 0.1 for the rest) */
  fileP?: (index: number) => number;
}

function messageOf(state: unknown): string {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return '';
  const m = (state as Record<string, unknown>)['message'];
  return typeof m === 'string' ? m : '';
}

/** one rule answering the intake request (groups A, B, C) and the lookup's context Nouls */
export function harnessIntakeRule(o: HarnessIntakeOptions = {}): DeciderRule {
  const classify = o.classify ?? harnessClassify;
  return (ctx: DeciderCall) => {
    const out: Partial<Record<string, Answer>> = {};
    const intakeQ = ctx.questions['intake'];
    if (intakeQ === undefined || intakeQ.type !== 'choice') {
      let i = 0;
      for (const [id, q] of Object.entries(ctx.questions)) {
        if (!id.startsWith('file_') || q.type !== 'noul') continue;
        out[id] = noulA(o.fileP ? o.fileP(i) : i === 0 ? 0.7 : 0.1);
        i += 1;
      }
      return Object.keys(out).length > 0 ? out : undefined;
    }
    const kind = classify(messageOf(ctx.state));
    out['intake'] = choiceOver(Object.keys(intakeQ.criteria), kind, o.p ?? 0.9);
    for (const id of Object.keys(ctx.questions)) if (id.startsWith('can_')) out[id] = noulA(id === `can_${kind}` ? (o.paired ?? 0.9) : 0.1);
    const replyQ = ctx.questions['reply'];
    if (replyQ !== undefined && replyQ.type === 'choice') out['reply'] = choiceOver(Object.keys(replyQ.criteria), o.reply ?? 'hello_first', 0.9);
    const facts = new Set(o.facts ?? ['mode_now', 'what_it_is']);
    for (const id of Object.keys(ctx.questions)) if (id.startsWith('about_')) out[id] = noulA(facts.has(id.slice('about_'.length)) ? 0.8 : 0.1);
    return out;
  };
}

/** a decider whose `ask` calls are recorded (stage, step, state, questions) — what `Harness.decider` exposes whatever decider the test passed */
export type TrackedDecider = Decider & { readonly calls: DeciderCall[] };
export function trackDecider(d: Decider): TrackedDecider {
  const calls: DeciderCall[] = [];
  return {
    model: d.model,
    provider: d.provider,
    calls,
    ask(state, questions, o) {
      calls.push({ stage: o.stage, step: o.step, state, questions });
      return d.ask(state, questions, o);
    },
  };
}

/** the harness's default decider: `harnessIntakeRule` over a zero-cost fake (the existing money assertions of the engine tests hold); `usage`/`failAt`/`delayMs` override */
export function harnessDecider(o: HarnessIntakeOptions & Omit<FakeDeciderOptions, 'rules'> & { rules?: DeciderRule[] } = {}): FakeDecider {
  const { classify, p, paired, reply, facts, fileP, rules, ...rest } = o;
  // the harness rule first: a caller's `rules` run after it and override (createFakeDecider merges rules in order)
  return createFakeDecider({ usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 1 }, ...rest, rules: [harnessIntakeRule({ ...(classify ? { classify } : {}), ...(p !== undefined ? { p } : {}), ...(paired !== undefined ? { paired } : {}), ...(reply ? { reply } : {}), ...(facts ? { facts } : {}), ...(fileP ? { fileP } : {}) }), ...(rules ?? [])] });
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** poll until `cond` holds (≤ `ms`) */
export async function waitFor(cond: () => boolean, ms = 4000, label = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await tick(5);
  }
}

export interface Note {
  text: string;
  label: UiLabel | undefined;
  level: string | undefined;
  detail: string | undefined;
  /** contract 1.7 item 1 (TUI-DESIGN-4 §3.1.6): the pre-split body with a colour role per row */
  detailRows?: readonly { readonly text: string; readonly role: string | null }[];
  /** contract 1.7 item 1 (§6.4): `'diff'` routes the rows through the diff renderer, for colour only */
  detailKind?: 'diff' | 'table' | 'text';
}

export interface FakeRenderer extends Renderer {
  notes: Note[];
  hosts: SessionHost[];
  uis: UiConfig[];
  attached: Engine[];
  unmounted: number;
  firstFrameResolved: boolean;
  /** the renderer calls in order (`firstFrame`, `attach`, `unmount`) — finishSession must flush (`firstFrame`) before `unmount` */
  calls: string[];
  /** every engine event forwarded through attach() */
  events: EngineEvent[];
  /** every reducer action the controller dispatched (`thresholds`, §15 item 20; TUI-DESIGN-2 §6 item 15 `thinking` / `chat-decisions` / `mode` / `toast`) */
  dispatched: (UiAction | ChatUiAction)[];
  /** TUI-DESIGN-2 §3.6: every `live(text)` of a streamed LLM turn ('' empties) */
  liveTexts: string[];
  prompts?: Prompter;
  setHost(host: SessionHost): void;
  setUi(ui: UiConfig): void;
  notify(
    text: string,
    opts?: {
      level?: 'info' | 'warn' | 'error';
      detail?: string;
      label?: UiLabel;
      detailRows?: readonly { readonly text: string; readonly role: string | null }[];
      detailKind?: 'diff' | 'table' | 'text';
    },
  ): void;
  dispatch(action: UiAction | ChatUiAction): void;
  live(text: string): void;
}

const decline: Confirmer = { identity: 'test decliner', confirm: () => Promise.resolve(false) };

export function fakeRenderer(o: { prompts?: Prompter; firstFrameDelayMs?: number } = {}): FakeRenderer {
  let detach: (() => void) | null = null;
  const r: FakeRenderer = {
    confirmer: decline,
    notes: [],
    hosts: [],
    uis: [],
    attached: [],
    events: [],
    dispatched: [],
    liveTexts: [],
    unmounted: 0,
    firstFrameResolved: false,
    calls: [],
    ...(o.prompts ? { prompts: o.prompts } : {}),
    attach(engine) {
      detach?.();
      r.calls.push('attach');
      r.attached.push(engine);
      detach = engine.events.onAny((e) => r.events.push(e));
    },
    async firstFrame() {
      r.calls.push('firstFrame');
      if (o.firstFrameDelayMs) await tick(o.firstFrameDelayMs);
      r.firstFrameResolved = true;
    },
    async unmount() {
      r.calls.push('unmount');
      detach?.();
      detach = null;
      r.unmounted += 1;
    },
    setHost(host) {
      r.hosts.push(host);
    },
    setUi(ui) {
      r.uis.push(ui);
    },
    notify(text, opts = {}) {
      r.notes.push({
        text,
        label: opts.label,
        level: opts.level,
        detail: opts.detail,
        ...(opts.detailRows !== undefined ? { detailRows: opts.detailRows } : {}),
        ...(opts.detailKind !== undefined ? { detailKind: opts.detailKind } : {}),
      });
    },
    dispatch(action) {
      r.dispatched.push(action);
    },
    live(text) {
      r.liveTexts.push(text);
    },
  };
  return r;
}

/** one scripted run: the events between run:ready and run:end, how it stops, its usage */
export interface RunScript {
  /** hold the run live until `release()` (or steer/pause/abort) */
  hold?: boolean;
  events?: EngineEvent[];
  stop?: StopReason;
  steps?: number;
  cost?: { generator: number; jev: number };
  changedFiles?: string[];
  /** the run:end `exitCode` (default `exitCodeFor(stop)`) */
  exitCode?: number;
  resumable?: boolean;
  /** what `loadRun` returns for this run afterwards (default: derived from the script) */
  loaded?: Partial<LoadedRun>;
}

export interface ScriptedEngine extends Engine {
  readonly opts: EngineOptions;
  readonly emitted: EngineEvent[];
  readonly directives: PendingDirective[];
  readonly aborts: { reason: string; signal?: SignalName }[];
  readonly annotated: string[];
  release(): void;
  /** resolves once run() reached the hold point */
  live(): Promise<void>;
  pausing: boolean;
}

export interface ScriptedFactory {
  factory: (opts: EngineOptions) => Promise<ScriptedEngine>;
  calls: EngineOptions[];
  engines: ScriptedEngine[];
  loaded: Map<string, LoadedRun>;
  /** the newest engine */
  current(): ScriptedEngine;
  /** resolves when the next created engine reaches its hold point */
  nextLive(): Promise<ScriptedEngine>;
}

let runSeq = 0;
/** a syntactically valid run id (`\d{8}-\d{6}-[a-z2-7]{8}`) for the n-th scripted run */
export function scriptedRunId(n: number): string {
  const sec = String(n % 60).padStart(2, '0');
  const tail = `${n.toString(32)}`.replace(/[^a-z2-7]/g, 'a').padStart(8, 'a').slice(-8);
  return `20260920-1500${sec}-${tail}`;
}

export function scriptedEngineFactory(script: (opts: EngineOptions, n: number) => RunScript = () => ({})): ScriptedFactory {
  const calls: EngineOptions[] = [];
  const engines: ScriptedEngine[] = [];
  const loaded = new Map<string, LoadedRun>();
  const liveWaiters: ((e: ScriptedEngine) => void)[] = [];
  const factory = async (opts: EngineOptions): Promise<ScriptedEngine> => {
    calls.push(opts);
    const n = ++runSeq;
    const sc = script(opts, calls.length);
    const runId = opts.resume?.runId ?? scriptedRunId(n);
    const events = createEmitter(() => undefined);
    const controller = new AbortController();
    const emitted: EngineEvent[] = [];
    const directives: PendingDirective[] = [];
    const aborts: { reason: string; signal?: SignalName }[] = [];
    const annotated: string[] = [];
    let finished = false;
    let started = false;
    let stopOverride: StopReason | null = null;
    let signalName: SignalName | undefined;
    let releaseFn: (() => void) | null = null;
    let liveResolve: (() => void) | null = null;
    const liveP = new Promise<void>((r) => {
      liveResolve = r;
    });
    let steerSeq = 0;
    const emit = (e: EngineEvent): void => {
      emitted.push(e);
      events.emit(e);
    };
    const engine: ScriptedEngine = {
      runId,
      events,
      signal: controller.signal,
      opts,
      emitted,
      directives,
      aborts,
      annotated,
      pausing: false,
      release() {
        releaseFn?.();
      },
      live: () => liveP,
      async run() {
        started = true;
        const sessionId = opts.session?.sessionId ?? runId;
        const parentRunId = opts.session?.parentRunId ?? null;
        emit({ type: 'run:start', runId, task: opts.task, mode: opts.mode, resumedFromStep: opts.resume ? 3 : null });
        emit({ type: 'run:ready', runId, step: opts.resume ? 3 : 0, maxSteps: opts.limits.maxSteps, task: opts.task, resumed: Boolean(opts.resume), sessionId, parentRunId, sandbox: 'none', noNetwork: opts.noNetwork, maxReplans: opts.limits.maxReplans });
        if (opts.session?.clamp) emit({ type: 'budget:clamp', ...opts.session.clamp });
        for (const e of sc.events ?? []) emit(e);
        if (sc.hold) {
          liveResolve?.();
          for (const w of liveWaiters.splice(0)) w(engine);
          await new Promise<void>((r) => {
            releaseFn = r;
            if (controller.signal.aborted) r();
          });
        } else {
          liveResolve?.();
          for (const w of liveWaiters.splice(0)) w(engine);
        }
        finished = true;
        const stop: StopReason = stopOverride ?? sc.stop ?? 'complete';
        const steps = sc.steps ?? 3;
        const cost = sc.cost ?? { generator: 0.1, jev: 0.015 };
        const result: RunResult = { ...mkRunResult(stop), runId, mode: opts.mode, steps, usage: { generator: { inputTokens: 1000, outputTokens: 100, costUsd: cost.generator, calls: steps }, jev: { inputTokens: 500, outputTokens: 50, costUsd: cost.jev, calls: steps * 3 } } };
        if (stop === 'error') result.error = { name: 'JevHttpError', code: 'jev_http', message: 'Jev HTTP 401: User not found.', exitCode: 2 };
        // the session meter learns the cost through the child meter, like the real engine
        opts.meter.add('generator', result.usage.generator);
        opts.meter.add('jev', result.usage.jev);
        const exitCode = sc.exitCode ?? (stop === 'error' ? 2 : exitCodeFor(stop, result.error, false, signalName));
        const resumable = sc.resumable ?? (stop !== 'complete');
        const runDir = join(opts.runsDir, runId);
        loaded.set(runId, {
          meta: makeMeta({ runId, task: opts.task, workspace: opts.workspace, mode: opts.mode, config: opts.configRecord, sessionId, parentRunId, source: opts.session?.source ?? 'cli', ...(sc.loaded?.meta ?? {}) }),
          state:
            sc.loaded && 'state' in sc.loaded
              ? (sc.loaded.state ?? null)
              : makeState({
                  runId,
                  step: steps,
                  stopReason: stop,
                  spend: spend(cost.generator, cost.jev, opts.limits.spendCapUsd),
                  plan: { done: [{ text: `did ${opts.task}`, evidence: { step: 1, judged: 0.9 } }], remaining: ['next thing'], unverified: [], openProblems: [], harnessProblems: [] },
                  window: [{ step: steps, intent: 'edit', action: 'edit src/a.py', outcome: 'executed', shownFiles: [], notes: [] }],
                  pendingDirectives: [...directives],
                  ...(opts.undoLog ? { undoLog: opts.undoLog } : {}),
                }),
        });
        emit({ type: 'run:end', result, exitCode, resumable, paths: { runDir, transcript: join(runDir, 'transcript.log'), log: join(runDir, 'jevcode.log') } });
        return result;
      },
      abort(reason, o = {}) {
        aborts.push({ reason, ...(o.signal ? { signal: o.signal } : {}) });
        if (finished) return;
        stopOverride = reason === 'signal' ? 'signal' : reason === 'error' ? 'error' : 'human_abort';
        if (o.signal) signalName = o.signal;
        controller.abort();
        releaseFn?.();
      },
      status: () => ({ step: 1, maxSteps: opts.limits.maxSteps, wallMs: 1000, maxWallMs: opts.limits.maxWallMs, stage: 'propose', spend: opts.meter.snapshot(), stopReason: null }),
      snapshotState: (): CheckpointState | null => null,
      steer(text, so = {}) {
        if (finished) return { ok: false, reason: 'finished', queued: directives.length };
        if (text.trim() === '') return { ok: false, reason: 'empty', queued: directives.length };
        if (directives.length >= 8) return { ok: false, reason: 'full', queued: 8 };
        const d: PendingDirective = { text, at: '2026-09-20T15:00:00.000Z', index: ++steerSeq };
        directives.push(d);
        if (so.secretsAcked) emit({ type: 'secret-ack', step: 4, count: so.secretsAcked });
        emit({ type: 'steer:queued', step: 4, index: d.index, text, queued: directives.length });
        return { ok: true, index: d.index, queued: directives.length };
      },
      unsteer() {
        const d = directives.pop() ?? null;
        if (d) emit({ type: 'steer:withdrawn', step: 4, index: d.index });
        return d;
      },
      pause() {
        if (finished || engine.pausing) return;
        engine.pausing = true;
        stopOverride = 'human_pause';
        emit({ type: 'pause:requested', step: 5 });
        releaseFn?.();
      },
      retryNow: () => false,
      annotate(text, o = {}) {
        if (!started || finished) return false;
        annotated.push(text);
        emit({ type: 'notice', step: null, kind: 'ui', level: o.level === 'dim' ? 'info' : (o.level ?? 'info'), text, ...(o.detail ? { detail: o.detail } : {}), label: o.label ?? '[ui]' });
        return true;
      },
    };
    engines.push(engine);
    return engine;
  };
  return {
    factory,
    calls,
    engines,
    loaded,
    current: () => {
      const e = engines[engines.length - 1];
      if (!e) throw new Error('no engine yet');
      return e;
    },
    nextLive: () => new Promise<ScriptedEngine>((r) => liveWaiters.push(r)),
  };
}

export const LAUNCH: LaunchSettings = { fps: 30, renderMode: 'standard', screenReader: false, ascii: false, noColor: true, reducedMotion: false };

export interface Harness {
  controller: SessionController;
  host: ControllerHost;
  renderer: FakeRenderer;
  factory: ScriptedFactory;
  /** the decider the intake used, call-recording (`harnessDecider()` unless `HarnessOptions.decider` was given; an idle wrapper under `'controller'`) */
  decider: TrackedDecider;
  home: string;
  workspace: string;
  indexPath: string;
  stderr: string[];
  stdout: string[];
  exits: number[];
  restores: number;
  /** await the startup (the `[sandbox]` line marks its end) */
  ready(): Promise<void>;
  /** submit a prompt as the composer would and wait for the run to end */
  submit(text: string, o?: { secretSpans?: string[]; pinnedFiles?: string[] }): Promise<void>;
  command(line: string): Promise<void>;
  /** parsed index lines */
  index(): IndexLine[];
  cleanup(): void;
}

export interface HarnessOptions {
  mode?: 'session' | 'one-shot';
  flags?: Partial<ParsedFlags>;
  script?: (opts: EngineOptions, n: number) => RunScript;
  prompts?: Prompter;
  interactive?: boolean;
  rendererKind?: 'tui' | 'plain' | 'json';
  task?: string | null;
  env?: Record<string, string>;
  deps?: Partial<SessionDeps>;
  /** index lines written before the controller starts (a pre-existing session) */
  indexLines?: IndexLine[];
  /** TUI-DESIGN-2 §3: the Jev the intake talks to (default `harnessDecider()`: tasks unless the text is a greeting or a question, zero cost); `'controller'` = the controller's own `buildDecider` (the `--mock` bridge of §3.13) */
  decider?: Decider | 'controller';
  /** runs `loadRun` knows before the controller starts */
  loaded?: Record<string, LoadedRun>;
  options?: Partial<SessionControllerOptions>;
  /** reuse another harness's `JEVCODE_HOME` (its sessions index, credentials) — a second controller over the same session (`-c`, TUI-DESIGN-2 §3.9) */
  home?: string;
  /** reuse another harness's workspace (the index rows are keyed by it) */
  workspace?: string;
}

export async function makeController(o: HarnessOptions = {}): Promise<Harness> {
  const home = o.home ?? mkdtempSync(join(tmpdir(), 'jevcode-cli-home-'));
  // the engine stores the workspace realpath in run.json; the harness uses it everywhere so a --resume workspace check agrees
  const workspace = o.workspace ?? realpathSync(mkdtempSync(join(tmpdir(), 'jevcode-cli-ws-')));
  if (o.workspace === undefined) writeFileSync(join(workspace, 'README.md'), '# ws\n');
  const factory = scriptedEngineFactory(o.script);
  const decider: TrackedDecider = trackDecider(o.decider === 'controller' || o.decider === undefined ? harnessDecider() : o.decider);
  for (const [id, l] of Object.entries(o.loaded ?? {})) factory.loaded.set(id, l);
  const renderer = fakeRenderer({ ...(o.prompts ? { prompts: o.prompts } : {}) });
  const indexPath = sessionsIndexPath(home);
  mkdirSync(join(home, 'sessions'), { recursive: true });
  for (const l of o.indexLines ?? []) appendIndexLine(indexPath, l, (s) => s);
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '', HOME: home, JEVCODE_HOME: home, TERM: 'xterm-256color', ...(o.env ?? {}) };
  const flags: ParsedFlags = { command: o.mode === 'one-shot' ? 'run' : 'chat', mock: true, mockSteps: '3', workspace, ...(o.flags ?? {}) };
  const stderr: string[] = [];
  const stdout: string[] = [];
  /** `ready()`'s marker: startup lists the workspace once, where the (now renderer-dependent) `[sandbox]` item used to be */
  let listed = false;
  const exits: number[] = [];
  let restores = 0;
  const controller = createSessionController({
    flags,
    env,
    cwd: workspace,
    home,
    mode: o.mode ?? 'session',
    renderer,
    rendererKind: o.rendererKind ?? 'tui',
    interactive: o.interactive ?? true,
    launch: LAUNCH,
    stdout: { write: (s: string) => stdout.push(s), isTTY: false, columns: 80 },
    stderr: { write: (s: string) => stderr.push(s) },
    prompter: o.prompts ?? null,
    ...(o.task !== undefined ? { task: o.task } : {}),
    exit: (code: number): never => {
      exits.push(code);
      throw new Error(`process.exit(${code})`);
    },
    restoreTerminal: () => {
      restores += 1;
    },
    deps: {
      createEngine: factory.factory,
      ...(o.decider === 'controller' ? {} : { buildDecider: async () => decider }),
      probeGitState: async () => notRepoState('not-a-repo', { probedAt: '2026-09-20T15:00:00.000Z', probeMs: 1 }),
      loadRun: async (_runsDir, runId) => factory.loaded.get(runId) ?? null,
      loadForResume: async (_runsDir, runId) => {
        const l = factory.loaded.get(runId);
        if (!l || l.state === null) throw new Error(`no checkpoint for run ${runId}`);
        return { meta: l.meta, state: l.state, previousStopReason: l.state.stopReason, warnings: [] };
      },
      log: nullLog(),
      nowIso: () => new Date().toISOString(),
      writeStderrSync: (t) => {
        stderr.push(t);
      },
      ...(o.deps ?? {}),
      // the wrapper wins over a caller's own listing (it delegates to it)
      ...(() => {
        const list = o.deps?.listCandidates ?? (async (): Promise<never[]> => []);
        return {
          listCandidates: async (...args: Parameters<NonNullable<SessionDeps['listCandidates']>>) => {
            listed = true;
            return list(...args);
          },
        };
      })(),
    },
    ...(o.options ?? {}),
  });
  const host = controller.host;
  return {
    controller,
    host,
    renderer,
    factory,
    decider,
    home,
    workspace,
    indexPath,
    stderr,
    stdout,
    exits,
    get restores() {
      return restores;
    },
    ready: () => waitFor(() => listed || renderer.notes.some((n) => n.label === '[sandbox]') || stderr.length > 0, 8000, 'startup'),
    // `submit()` resolves once the run started (§4.9); the harness waits for its run:end so a test reads the finished record
    submit: async (text, so = {}) => {
      await host.submit(text, { kind: host.ranBefore() ? 'follow-up' : 'prompt', secretSpans: so.secretSpans ?? [], pinnedFiles: so.pinnedFiles ?? [] });
      await host.awaitRunEnd();
      await tick(0);
    },
    // a command that started a run (/resume) waits for its run:end; one issued while live returns at once
    command: async (line) => {
      const wasLive = host.phase() !== 'none';
      await host.command(line);
      if (!wasLive && host.phase() !== 'none') await host.awaitRunEnd();
      await tick(0);
    },
    index: () => {
      try {
        const text = readFileSync(indexPath, 'utf8');
        return text
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l) as IndexLine);
      } catch {
        return [];
      }
    },
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

/** a run:start + run:end pair for a pre-existing session in the index */
export function finishedRunLines(o: { sessionId: string; runId: string; workspace: string; task: string; cost: { generator: number; jev: number }; stop?: StopReason; t?: string; parentRunId?: string | null; title?: string }): IndexLine[] {
  const t = o.t ?? '2026-09-20T14:00:00.000Z';
  const stop = o.stop ?? 'complete';
  const lines: IndexLine[] = [
    { v: 1, t, kind: 'run:start', sessionId: o.sessionId, runId: o.runId, parentRunId: o.parentRunId ?? null, workspace: o.workspace, task60: o.task, mode: 'jev-on', source: 'cli', branch: null, resumeOf: null },
    { v: 1, t: `${t.slice(0, 17)}30.000Z`, kind: 'run:end', sessionId: o.sessionId, runId: o.runId, stopReason: stop, steps: 5, costUsd: o.cost, wallMs: 60_000, changedFiles: 2, exitCode: exitCodeFor(stop), resumable: stop !== 'complete', degraded: false },
  ];
  if (o.title !== undefined) lines.push({ v: 1, t: `${t.slice(0, 17)}31.000Z`, kind: 'rename', sessionId: o.sessionId, title60: o.title });
  return lines;
}

/** a LoadedRun for `loadRun` of a pre-existing run */
export function loadedRun(o: { runId: string; sessionId?: string; parentRunId?: string | null; task?: string; workspace: string; step?: number; stop?: StopReason; spend?: { generator: number; jev: number }; pendingDirectives?: PendingDirective[] }): LoadedRun {
  const meta: RunMeta = makeMeta({ runId: o.runId, task: o.task ?? 'task', workspace: o.workspace, sessionId: o.sessionId ?? o.runId, parentRunId: o.parentRunId ?? null, source: 'cli' });
  const state = makeState({
    runId: o.runId,
    step: o.step ?? 5,
    stopReason: o.stop ?? 'complete',
    spend: spend(o.spend?.generator ?? 0.1, o.spend?.jev ?? 0.01),
    plan: { done: [{ text: 'read the code', evidence: { step: 2, judged: 0.9 } }], remaining: ['fix f'], unverified: [], openProblems: [], harnessProblems: [] },
    window: [{ step: 5, intent: 'edit', action: 'edit src/a.py', outcome: 'executed', shownFiles: [], notes: [] }],
    ...(o.pendingDirectives ? { pendingDirectives: o.pendingDirectives } : {}),
  });
  return { meta, state };
}

/** a blocking-pane prompter answering with a fixed answer */
export function blockingPrompter(answer: BlockingAnswer): Prompter {
  return { blocking: async () => answer };
}
