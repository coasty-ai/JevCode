/**
 * In-memory fakes written against the interfaces in src/core/types.ts. Nothing here imports
 * another engineer's module (jev/mock.ts, provider/mock.ts, checkpoint/*, workspace/*).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Action,
  Answer,
  Candidate,
  CheckpointState,
  CheckpointStore,
  Confirmer,
  Decider,
  Decision,
  Engine,
  EngineEvent,
  EngineMode,
  EngineOptions,
  ExecResult,
  FileView,
  GenerateRequest,
  GenerateResult,
  GeneratorCallRecord,
  JevRequestRecord,
  PlanDraft,
  Provider,
  Question,
  RunLimits,
  RunMeta,
  Sandbox,
  SpendMeter,
  SpendSnapshot,
  StageName,
  StepRecord,
  Synthesizer,
  TargetInfo,
  TestCounts,
  TokenUsage,
  Workspace,
  WorkspaceInfo,
} from '../../../src/core/types.js';
import { AbortError, EditError, FileNotFoundError, JevHttpError, PatchError, PathEscapeError, ProviderHttpError } from '../../../src/errors.js';
import { createEngine, type EngineDeps } from '../../../src/loop/engine.js';

// ---------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------

export function noulA(p: number): Answer {
  return { type: 'noul', noul: p };
}

export function choiceA(choice: string, probabilities: Record<string, number>): Answer {
  const n = Object.keys(probabilities).length;
  const p = probabilities[choice] ?? 0;
  return { type: 'choice', choice, probabilities, confidence: n <= 1 ? 1 : (p - 1 / n) / (1 - 1 / n) };
}

/** Score answer from a sparse level map, e.g. { 1: 0.8, 2: 0.2 }. */
export function scoreA(levels: Record<number, number>, n = 5): Answer {
  const probabilities: Record<string, number> = {};
  const legend: Record<string, string> = {};
  let score = 0;
  for (let k = 0; k < n; k++) {
    const p = levels[k] ?? 0;
    probabilities[String(k)] = p;
    legend[String(k)] = `level ${k}`;
    score += k * p;
  }
  return { type: 'score', score, legend, probabilities, confidence: 0.9 };
}

/** Spread a Choice: `choice` gets p, the rest share 1-p. */
export function choiceOver(keys: readonly string[], choice: string, p = 0.9): Answer {
  const probs: Record<string, number> = {};
  const rest = keys.length > 1 ? (1 - p) / (keys.length - 1) : 0;
  for (const k of keys) probs[k] = k === choice ? p : Number(rest.toFixed(4));
  return choiceA(choice, probs);
}

// ---------------------------------------------------------------------------------------
// Decider
// ---------------------------------------------------------------------------------------

export interface DeciderCall {
  stage: StageName;
  step: number;
  state: unknown;
  questions: Record<string, Question>;
}

export type DeciderRule = (ctx: DeciderCall) => Partial<Record<string, Answer>> | undefined;

export interface FakeDeciderOptions {
  rules?: DeciderRule[];
  model?: string;
  /** every attempt at these stages throws JevHttpError(status) */
  failAt?: { stage: StageName; step?: number; status: number }[];
  latencyMs?: number;
  usage?: Partial<TokenUsage>;
  /** per-call usage override (e.g. to cross the spend cap at judge) */
  usageAt?: (ctx: DeciderCall) => Partial<TokenUsage> | undefined;
  /** real delay before answering; rejects with signal.reason on abort */
  delayMs?: (ctx: DeciderCall) => number;
}

export interface FakeDecider extends Decider {
  calls: DeciderCall[];
  callsAt(stage: StageName): DeciderCall[];
}

function defaultAnswer(id: string, q: Question, ctx: DeciderCall): Answer {
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria);
    const first = keys.find((k) => k !== 'none_of_these') ?? keys[0]!;
    return choiceOver(keys, first, 0.9);
  }
  if (q.type === 'score') return scoreA({ 0: 1 }, q.criteria.length);
  if (id === 'task_complete') return noulA(0.1);
  if (id === 'task_impossible') return noulA(0.05);
  if (id === 'error_present' || id === 'new_information') return noulA(0.1);
  if (id.startsWith('can_')) {
    // pair with the choice default: the first non-escape option is right, the rest are not
    const choiceQ = Object.values(ctx.questions).find((x) => x.type === 'choice');
    if (choiceQ && choiceQ.type === 'choice') {
      const keys = Object.keys(choiceQ.criteria);
      const first = keys.find((k) => k !== 'none_of_these');
      return noulA(id === `can_${first}` ? 0.9 : 0.1);
    }
    return noulA(0.9);
  }
  return noulA(0.9);
}

export function createFakeDecider(opts: FakeDeciderOptions = {}): FakeDecider {
  const calls: DeciderCall[] = [];
  const model = opts.model ?? 'typesafe/jev-1.13-20260917';
  return {
    model,
    calls,
    callsAt: (stage) => calls.filter((c) => c.stage === stage),
    async ask(state, questions, o) {
      const ctx: DeciderCall = { stage: o.stage, step: o.step, state, questions };
      calls.push(ctx);
      if (o.signal.aborted) throw o.signal.reason;
      const delay = opts.delayMs?.(ctx) ?? 0;
      if (delay > 0) await sleepAbortable(delay, o.signal);
      const f = opts.failAt?.find((x) => x.stage === o.stage && (x.step === undefined || x.step === o.step));
      if (f) throw new JevHttpError(`Jev HTTP ${f.status}`, { status: f.status, retryable: f.status >= 500, body: '' });
      const answers: Record<string, Answer> = {};
      const overrides: Partial<Record<string, Answer>> = {};
      for (const rule of opts.rules ?? []) Object.assign(overrides, rule(ctx) ?? {});
      for (const [id, q] of Object.entries(questions)) answers[id] = overrides[id] ?? defaultAnswer(id, q, ctx);
      const usage: TokenUsage = { inputTokens: 300, outputTokens: 20, costUsd: 0.0002, calls: 1, ...opts.usage, ...(opts.usageAt?.(ctx) ?? {}) };
      return { answers, usage, latencyMs: opts.latencyMs ?? 0, model, requestHash: `h${calls.length}`, attempts: 1, id: null };
    },
  };
}

export function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(t);
      reject(signal.reason);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------

export interface ProposalTurn {
  goal?: string;
  action: Action;
  plan?: Partial<PlanDraft>;
  usage?: Partial<TokenUsage>;
  text?: string;
  /** real delay before replying; rejects with signal.reason on abort */
  delayMs?: number;
}
export type RawTurn = { raw: string; usage?: Partial<TokenUsage> } | { rawInput: unknown; usage?: Partial<TokenUsage> } | { httpError: number };
export type Turn = ProposalTurn | RawTurn;

export interface FakeProvider extends Provider {
  requests: GenerateRequest[];
}

export function turn(action: Action, plan: Partial<PlanDraft> = {}, extra: Partial<ProposalTurn> = {}): ProposalTurn {
  return { action, plan, ...extra };
}

export function createFakeProvider(turns: Turn[] | ((req: GenerateRequest, index: number) => Turn), opts: { model?: string } = {}): FakeProvider {
  const requests: GenerateRequest[] = [];
  const model = opts.model ?? 'claude-sonnet-5';
  return {
    name: 'mock',
    model,
    requests,
    async generate(req, o) {
      const index = requests.length;
      requests.push(req);
      if (o.signal.aborted) throw o.signal.reason;
      const t = typeof turns === 'function' ? turns(req, index) : (turns[index] ?? turns[turns.length - 1]);
      if (!t) throw new Error('fake provider: no turn scripted');
      if ('httpError' in t) throw new ProviderHttpError(`HTTP ${t.httpError}`, { status: t.httpError, retryable: false });
      const usage: TokenUsage = { inputTokens: 1000, outputTokens: 200, costUsd: 0.004, calls: 1, ...('usage' in t ? t.usage : undefined) };
      const base: GenerateResult = { text: '', toolCalls: [], usage, model, stopReason: 'tool_use', latencyMs: 0 };
      if ('raw' in t) return { ...base, text: t.raw, stopReason: 'end_turn' };
      if ('rawInput' in t) return { ...base, toolCalls: [{ name: 'propose_action', input: t.rawInput as never, rawJson: JSON.stringify(t.rawInput) }] };
      if (t.delayMs) await sleepAbortable(t.delayMs, o.signal);
      const input = { goal: t.goal ?? `do ${t.action.kind}`, action: t.action, plan: { done: [], remaining: [], openProblems: [], ...t.plan } };
      const text = t.text ?? 'Working on it.';
      o.onDelta?.(text);
      return { ...base, text, toolCalls: [{ name: 'propose_action', input: input as never, rawJson: JSON.stringify(input) }] };
    },
  };
}

// ---------------------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------------------

export interface FakeWorkspaceOptions {
  files?: Record<string, string>;
  git?: boolean;
  testCommand?: { command: string; runner: 'pytest' | 'jest' | 'vitest' | 'npm' | 'cargo' | 'go' | 'unknown' } | null;
  root?: string;
}

export interface FakeWorkspace extends Workspace {
  files: Map<string, string>;
  invalidations: number;
  reads: string[];
}

export function createFakeWorkspace(opts: FakeWorkspaceOptions = {}): FakeWorkspace {
  const files = new Map<string, string>(Object.entries(opts.files ?? { 'src/a.py': 'def f():\n    return 1\n', 'tests/test_a.py': 'from src.a import f\n\ndef test_f():\n    assert f() == 2\n' }));
  const initial = new Set(files.keys());
  const changed = new Set<string>();
  const root = opts.root ?? '/ws';
  const git = opts.git ?? true;
  const testCommand = opts.testCommand === undefined ? { command: 'pytest -q', runner: 'pytest' as const } : opts.testCommand;
  const reads: string[] = [];
  const ws: FakeWorkspace = {
    root,
    files,
    invalidations: 0,
    reads,
    async info(): Promise<WorkspaceInfo> {
      return { root, git, hasTests: testCommand !== null, testCommand };
    },
    async listCandidates(): Promise<Candidate[]> {
      return [...files.entries()].map(([path, c]) => ({ path, bytes: Buffer.byteLength(c) })).sort((a, b) => a.path.localeCompare(b.path));
    },
    async invalidateCandidates() {
      ws.invalidations += 1;
    },
    async noteChanged() {
      /* cache bookkeeping only */
    },
    async read(path, maxBytes): Promise<FileView> {
      reads.push(path);
      if (path.startsWith('/') || path.startsWith('..')) throw new PathEscapeError('outside', path);
      if (path.endsWith('.env')) throw new PathEscapeError('secret', path);
      const c = files.get(path);
      if (c === undefined) throw new FileNotFoundError(path);
      const bytes = Buffer.byteLength(c);
      const content = c.length > maxBytes ? c.slice(0, maxBytes) : c;
      return { path, content, bytes, truncatedBytes: Math.max(0, bytes - Buffer.byteLength(content)) };
    },
    async applyEdit(a) {
      const c = files.get(a.path);
      if (c === undefined) throw new EditError(a.path, 0);
      const n = c.split(a.old).length - 1;
      if (n !== 1) throw new EditError(a.path, n);
      files.set(a.path, c.replace(a.old, a.new));
      changed.add(a.path);
      return { changedFiles: [a.path] };
    },
    async writeFile(a) {
      if (a.path.startsWith('/') || a.path.startsWith('..')) throw new PathEscapeError('outside', a.path);
      const created = !files.has(a.path);
      files.set(a.path, a.content);
      changed.add(a.path);
      return { changedFiles: [a.path], created };
    },
    async applyPatch(diff) {
      if (diff.includes('FAIL_HUNK')) throw new PatchError('patch does not apply', '@@ -1,1 +1,1 @@');
      const out: string[] = [];
      let cur: string | null = null;
      const lines: string[] = [];
      const flush = (): void => {
        if (cur !== null) {
          files.set(cur, lines.join('\n'));
          changed.add(cur);
          out.push(cur);
        }
      };
      for (const line of diff.split('\n')) {
        const m = /^\+\+\+ b\/(.+)$/.exec(line);
        if (m) {
          flush();
          cur = m[1]!;
          lines.length = 0;
        } else if (cur !== null && line.startsWith('+')) lines.push(line.slice(1));
      }
      flush();
      return { changedFiles: out };
    },
    parseTestOutput(_runner, output): TestCounts | null {
      const passed = /(\d+) passed/.exec(output);
      const failed = /(\d+) failed/.exec(output);
      const errors = /(\d+) errors?/.exec(output);
      if (!passed && !failed && !errors) return null;
      return { passed: Number(passed?.[1] ?? 0), failed: Number(failed?.[1] ?? 0), errors: Number(errors?.[1] ?? 0), skipped: 0 };
    },
    async changedFiles() {
      return [...changed].sort();
    },
    async target(path, created): Promise<TargetInfo> {
      if (path.startsWith('/') || path.startsWith('..')) throw new PathEscapeError('outside', path);
      const existsBefore = files.has(path);
      const tracked = git && initial.has(path);
      const c = created.has(path);
      return { path, existsBefore, tracked, createdThisRun: c, recoverable: tracked || c };
    },
  };
  return ws;
}

// ---------------------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------------------

export type ExecScript = Partial<ExecResult> | { hang: true } | { rejectOnAbort: true } | { delayMs: number; result: Partial<ExecResult> };

export interface FakeSandbox extends Sandbox {
  commands: string[];
  timeouts: number[];
  killAllCalls: number;
}

export function execResult(partial: Partial<ExecResult> = {}): ExecResult {
  const exitCode = partial.exitCode === undefined ? 0 : partial.exitCode;
  const killedBy = partial.killedBy ?? null;
  return {
    ok: exitCode === 0 && killedBy === null,
    exitCode,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    bytesSeen: (partial.stdout?.length ?? 0) + (partial.stderr?.length ?? 0),
    killedBy,
    timedOut: killedBy === 'timeout',
    orphans: [],
    sandboxExecDenied: false,
    durationMs: 1,
    ...partial,
  };
}

export function createFakeSandbox(script: (command: string, index: number) => ExecScript = () => ({ stdout: 'ok' })): FakeSandbox {
  const sb: FakeSandbox = {
    level: 'none',
    commands: [],
    timeouts: [],
    killAllCalls: 0,
    async run(command, o) {
      const index = sb.commands.length;
      sb.commands.push(command);
      sb.timeouts.push(o.timeoutMs);
      if (o.signal.aborted) throw new AbortError('human_abort');
      const s = script(command, index);
      if ('hang' in s) {
        await new Promise<void>((resolve) => o.signal.addEventListener('abort', () => resolve(), { once: true }));
        return execResult({ exitCode: null, signal: 'SIGTERM', killedBy: o.abortKilledBy ?? 'abort', stdout: 'partial output\n' });
      }
      if ('rejectOnAbort' in s) {
        await new Promise<void>((resolve) => o.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new AbortError('human_abort');
      }
      if ('delayMs' in s) {
        await new Promise((r) => setTimeout(r, s.delayMs));
        return execResult(s.result);
      }
      return execResult(s);
    },
    async killAll() {
      sb.killAllCalls += 1;
    },
  };
  return sb;
}

// ---------------------------------------------------------------------------------------
// Checkpoint store
// ---------------------------------------------------------------------------------------

export interface FakeStore extends CheckpointStore {
  meta: RunMeta | null;
  states: CheckpointState[];
  syncStates: CheckpointState[];
  steps: StepRecord[];
  decisions: Decision[];
  jevRequests: JevRequestRecord[];
  generator: GeneratorCallRecord[];
  transcript: string[];
  flushes: number;
  /** artificial delay for writeState (checkpoint overlap tests) */
  writeDelayMs: number;
  /** when set, writeState never resolves (forced-exit tests) */
  stallWrites: boolean;
  seed(meta: RunMeta, state: CheckpointState, extraSteps?: StepRecord[]): void;
  last(): CheckpointState | undefined;
}

export function createFakeStore(dir = '/runs/fake'): FakeStore {
  const st: FakeStore = {
    dir,
    meta: null,
    states: [],
    syncStates: [],
    steps: [],
    decisions: [],
    jevRequests: [],
    generator: [],
    transcript: [],
    flushes: 0,
    writeDelayMs: 0,
    stallWrites: false,
    seed(meta, state, extraSteps = []) {
      st.meta = meta;
      st.states.push(state);
      st.steps.push(...extraSteps);
    },
    last: () => st.states[st.states.length - 1],
    async create(meta) {
      st.meta = meta;
    },
    async load() {
      const state = st.last();
      if (!st.meta || !state) throw new Error('fake store: nothing to load');
      return { meta: st.meta, state, recoveredFrom: 'state' };
    },
    async updateMeta(patch) {
      if (!st.meta) return;
      if (patch.resumes) st.meta.resumes.push(...patch.resumes);
      if (patch.overrides) st.meta.overrides.push(...patch.overrides);
      if (patch.resolvedJevModel !== undefined) st.meta.resolvedJevModel = patch.resolvedJevModel;
      if (patch.jevModelDrift !== undefined) st.meta.jevModelDrift = patch.jevModelDrift;
    },
    async writeState(state) {
      if (st.stallWrites) await new Promise<void>(() => undefined);
      if (st.writeDelayMs > 0) await new Promise((r) => setTimeout(r, st.writeDelayMs));
      st.states.push(structuredClone(state));
    },
    writeStateSync(state) {
      st.syncStates.push(structuredClone(state));
    },
    async appendStep(r) {
      st.steps.push(structuredClone(r));
    },
    async appendDecisions(d) {
      st.decisions.push(...d.map((x) => structuredClone(x)));
    },
    async appendJevRequest(r) {
      st.jevRequests.push(r);
    },
    async appendGenerator(g) {
      st.generator.push(g);
    },
    async appendTranscript(line) {
      st.transcript.push(line);
    },
    async readStepsAfter(step) {
      return st.steps.filter((s) => s.step > step);
    },
    async flush() {
      st.flushes += 1;
    },
  };
  return st;
}

// ---------------------------------------------------------------------------------------
// Spend meter
// ---------------------------------------------------------------------------------------

export function createFakeMeter(capUsd: number): SpendMeter {
  const gen: TokenUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
  const jev: TokenUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
  const snapshot = (): SpendSnapshot => ({ generator: { ...gen }, jev: { ...jev }, totalUsd: gen.costUsd + jev.costUsd, capUsd, exceeded: gen.costUsd + jev.costUsd >= capUsd });
  const meter: SpendMeter = {
    add(source, u) {
      const t = source === 'generator' ? gen : jev;
      t.inputTokens += u.inputTokens;
      t.outputTokens += u.outputTokens;
      t.costUsd += u.costUsd;
      t.calls += u.calls;
      return snapshot();
    },
    exceeded: () => snapshot().exceeded,
    snapshot,
    restore(s) {
      Object.assign(gen, s.generator);
      Object.assign(jev, s.jev);
    },
    child: (c) => createFakeMeter(c),
  };
  return meter;
}

// ---------------------------------------------------------------------------------------
// Confirmers
// ---------------------------------------------------------------------------------------

export const alwaysDecline: Confirmer = { identity: 'no reviewer in bench runs', confirm: async () => false };
export const alwaysApprove: Confirmer = { identity: 'reviewer', confirm: async () => true };
export const declineAsReviewer: Confirmer = { identity: 'reviewer', confirm: async () => false };
/** Rejects with AbortError('human_abort') as the TUI confirmer does on Ctrl-C. */
export const abortingConfirmer: Confirmer = {
  identity: 'reviewer',
  confirm: () => Promise.reject(new AbortError('human_abort')),
};

// ---------------------------------------------------------------------------------------
// Engine harness
// ---------------------------------------------------------------------------------------

export const DEFAULT_LIMITS: RunLimits = {
  maxSteps: 40,
  maxWallMs: 30 * 60_000,
  maxReplans: 5,
  completeThreshold: 0.85,
  impossibleThreshold: 0.85,
  commandTimeoutMs: 120_000,
  maxCommandTimeoutMs: 600_000,
  maxOutputBytes: 200_000,
  spendCapUsd: 2,
};

export interface HarnessOptions {
  turns?: Turn[] | ((req: GenerateRequest, index: number) => Turn);
  provider?: FakeProvider;
  decider?: FakeDecider;
  deciderOptions?: FakeDeciderOptions;
  workspace?: FakeWorkspace;
  sandbox?: FakeSandbox;
  store?: FakeStore;
  meter?: SpendMeter;
  confirmer?: Confirmer;
  limits?: Partial<RunLimits>;
  mode?: EngineMode;
  /** jev-only: the propose stage */
  synthesizer?: Synthesizer;
  task?: string;
  resume?: { runId: string; force: boolean };
  now?: () => number;
  exit?: (code: number) => never;
  deciderModel?: { configured: string; pinned: boolean };
  /** reuse a runs dir (resume tests) */
  runsDir?: string;
}

export interface Harness {
  engine: Engine;
  events: EngineEvent[];
  provider: FakeProvider;
  decider: FakeDecider;
  workspace: FakeWorkspace;
  sandbox: FakeSandbox;
  store: FakeStore;
  meter: SpendMeter;
  runsDir: string;
  cleanup(): void;
  of<T extends EngineEvent['type']>(type: T): Extract<EngineEvent, { type: T }>[];
}

export const FIXED_RUN_ID = '20260919-120000-abcdefgh';

export async function makeEngine(h: HarnessOptions = {}): Promise<Harness> {
  const runsDir = h.runsDir ?? mkdtempSync(join(tmpdir(), 'jevcode-loop-'));
  const provider = h.provider ?? createFakeProvider(h.turns ?? [turn({ kind: 'done', summary: 'nothing to do' })]);
  const decider = h.decider ?? createFakeDecider(h.deciderOptions);
  const workspace = h.workspace ?? createFakeWorkspace({ root: runsDir });
  const sandbox = h.sandbox ?? createFakeSandbox();
  const store = h.store ?? createFakeStore(join(runsDir, FIXED_RUN_ID));
  const meter = h.meter ?? createFakeMeter(h.limits?.spendCapUsd ?? DEFAULT_LIMITS.spendCapUsd);
  const limits: RunLimits = { ...DEFAULT_LIMITS, ...h.limits };
  const opts: EngineOptions = {
    task: h.task ?? 'Fix f() in src/a.py so that tests/test_a.py passes',
    mode: h.mode ?? 'jev-on',
    workspace: runsDir,
    runsDir,
    provider,
    decider,
    confirmer: h.confirmer ?? alwaysDecline,
    meter,
    limits,
    sandboxProfile: 'none',
    noNetwork: false,
    configRecord: {},
    redact: (s) => s.replaceAll('sk-or-v1-SECRETSECRETSECRETSECRET', '[REDACTED:test]'),
    secretPaths: [],
    generation: { temperature: null, maxTokens: 4096 },
    deciderModel: h.deciderModel ?? { configured: 'typesafe/jev-1.13-20260917', pinned: true },
  };
  if (h.resume) opts.resume = h.resume;
  if (h.now) opts.now = h.now;
  if (h.exit) opts.exit = h.exit;
  if (h.synthesizer) opts.synthesizer = h.synthesizer;
  const deps: EngineDeps = {
    createCheckpointStore: () => store,
    createWorkspace: async () => workspace,
    createSandbox: () => sandbox,
    newRunId: () => FIXED_RUN_ID,
  };
  const engine = await createEngine(opts, deps);
  const events: EngineEvent[] = [];
  engine.events.onAny((e) => events.push(e));
  return {
    engine,
    events,
    provider,
    decider,
    workspace,
    sandbox,
    store,
    meter,
    runsDir,
    cleanup: () => {
      if (!h.runsDir) rmSync(runsDir, { recursive: true, force: true });
    },
    of: <T extends EngineEvent['type']>(type: T) => events.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type),
  };
}

/** A decider rule answering a fixed question id on a given stage (and optionally step). */
export function answer(stage: StageName, id: string, a: Answer, step?: number): DeciderRule {
  return (ctx) => (ctx.stage === stage && (step === undefined || ctx.step === step) ? { [id]: a } : undefined);
}

/** Rule: risk Scores all at one distribution on a given step. */
export function riskAll(levels: Record<number, number>, step?: number): DeciderRule {
  return (ctx) => (ctx.stage === 'risk' && (step === undefined || ctx.step === step) ? { destructive: scoreA(levels), out_of_scope: scoreA(levels), plan_mismatch: scoreA(levels), irreversible: scoreA(levels) } : undefined);
}

/** Rule: intent Choice = option with its paired Noul high. */
export function intentIs(option: string, step?: number, p = 0.9): DeciderRule {
  return (ctx) => {
    if (ctx.stage !== 'intent' || (step !== undefined && ctx.step !== step)) return undefined;
    const keys = Object.keys((ctx.questions['intent'] as { criteria: Record<string, unknown> }).criteria);
    const out: Record<string, Answer> = { intent: choiceOver(keys, option, p) };
    for (const k of keys) if (k !== 'none_of_these') out[`can_${k}`] = noulA(k === option ? 0.9 : 0.1);
    return out;
  };
}

export const passingTests = execResult({ exitCode: 0, stdout: '..\n2 passed in 0.10s\n' });
export const failingTests = execResult({ exitCode: 1, stdout: 'F.\nFAILED tests/test_a.py::test_f - assert 1 == 2\n1 failed, 1 passed in 0.10s\n', stderr: '' });
