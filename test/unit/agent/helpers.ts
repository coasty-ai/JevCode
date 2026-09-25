/**
 * Test doubles for the agent driver: a fake `AgentContext` over the unit fakes' workspace and sandbox, a scripted fake
 * `ctx.generate` (never the mock provider — S3 does not depend on S2), a fake Jev `ask`, and `step()`, a small stand-in
 * for the engine's shared tail that executes act / verify / finish proposals against the same fakes and calls
 * `observe()`, so the driver is proven on its own.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActionOutcome,
  AgentContext,
  AgentDriver,
  AgentGenerateHooks,
  AgentNext,
  AgentObserveResult,
  Answer,
  ContextUsage,
  ConversationCarry,
  Decision,
  EngineEvent,
  EngineSeed,
  ExecResult,
  GenerateRequest,
  GenerateResult,
  GitState,
  Json,
  JsonObject,
  LastTestRun,
  Question,
  TestCounts,
  TokenUsage,
} from '../../../src/core/types.js';
import { createStepToken, type StepToken } from '../../../src/jev/router.js';
import { isTestCommand } from '../../../src/workspace/tests.js';
import { DEFAULT_LIMITS, createFakeSandbox, createFakeWorkspace, execResult, type ExecScript, type FakeSandbox, type FakeWorkspace } from '../loop/fakes.js';

export interface ScriptedTurn {
  text?: string;
  /** streamed through onText in these pieces (default: the whole text in one chunk) */
  chunks?: string[];
  toolCalls?: { id?: string; name: string; input: Json | null; rawJson?: string }[];
  stopReason?: string;
  providerState?: Json;
  usage?: Partial<TokenUsage>;
  /** throw instead of answering */
  error?: Error;
  /** resolve after this many ms (abortable) */
  delayMs?: number;
}

export type TurnScript = ScriptedTurn[] | ((req: GenerateRequest, index: number) => ScriptedTurn);

export interface AskCall {
  state: JsonObject;
  questions: Record<string, Question>;
}

export interface FakeAgentOptions {
  files?: Record<string, string>;
  testCommand?: { command: string; runner: 'pytest' | 'jest' | 'vitest' | 'npm' | 'cargo' | 'go' | 'unknown' } | null;
  sandbox?: (command: string, index: number) => ExecScript;
  turns?: TurnScript;
  provider?: { name: AgentContext['provider']['name']; model: string };
  autonomy?: 'full' | 'review';
  /** the `agent.verify` setting (default off, the product's default) */
  verify?: 'off' | 'tests';
  jevAvailable?: boolean;
  /** answer (or throw from) a quick Jev ask */
  ask?: (call: AskCall, signal: AbortSignal) => Promise<Record<string, Answer>>;
  conversation?: ConversationCarry | null;
  seed?: EngineSeed | null;
  state?: Json | null;
  resumed?: boolean;
  runDir?: string;
  dirtyAtStart?: readonly string[];
  windowTokens?: number | null;
  compaction?: { mode: 'code' | 'llm' | 'off'; explicit: boolean };
  gitState?: GitState | null;
  task?: string;
  sessionId?: string;
  maxTokens?: number;
  wallRemainingMs?: number;
  /** the fake workspace's root (default `/ws`); a real directory when a test needs files on disk beside it */
  root?: string;
  /** the workspace's current dirty set (`Workspace.dirtySet()`); absent: the method is not offered */
  dirtySet?: readonly string[];
}

export interface FakeAgentContext extends AgentContext {
  step: number;
  state: Json | null;
  resumed: boolean;
  lastTestRun: LastTestRun | null;
  readonly fs: FakeWorkspace;
  readonly sb: FakeSandbox;
  readonly events: EngineEvent[];
  readonly requests: GenerateRequest[];
  readonly hooks: AgentGenerateHooks[];
  readonly asks: AskCall[];
  readonly usages: ContextUsage[];
  readonly steerQueue: string[];
  compactRequest: boolean;
  outputs: Map<string, string>;
  /** the JSON-stable copy of each generate request, as it was when sent (the driver keeps appending to its transcript) */
  readonly sent: GenerateRequest[];
  /** abort the run signal (a pause-now, `/stop`) */
  abort(reason: unknown): void;
  eventsOf<T extends EngineEvent['type']>(type: T): Extract<EngineEvent, { type: T }>[];
}

export function tempRunDir(): string {
  return mkdtempSync(join(tmpdir(), 'jevcode-agent-'));
}

const ZERO_USAGE: TokenUsage = { inputTokens: 1000, outputTokens: 50, costUsd: 0, calls: 1 };

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

export function createAgentContext(o: FakeAgentOptions = {}): FakeAgentContext {
  const fs = createFakeWorkspace({ ...(o.root !== undefined ? { root: o.root } : {}), ...(o.dirtySet !== undefined ? { dirtySet: new Set(o.dirtySet) } : {}), files: o.files ?? { 'src/a.py': 'def f():\n    return 1\n', 'tests/test_a.py': 'from src.a import f\n\ndef test_f():\n    assert f() == 2\n' }, testCommand: o.testCommand === undefined ? { command: 'pytest -q', runner: 'pytest' } : o.testCommand, ...(o.gitState !== undefined ? { gitState: o.gitState } : {}) });
  const sb = createFakeSandbox(o.sandbox ?? (() => ({ stdout: 'ok\n' })));
  const controller = new AbortController();
  const events: EngineEvent[] = [];
  const requests: GenerateRequest[] = [];
  const sent: GenerateRequest[] = [];
  const hooks: AgentGenerateHooks[] = [];
  const asks: AskCall[] = [];
  const usages: ContextUsage[] = [];
  const steerQueue: string[] = [];
  const outputs = new Map<string, string>();
  let calls = 0;
  let token: StepToken = createStepToken(1);
  const turnAt = (req: GenerateRequest, i: number): ScriptedTurn => {
    const t = o.turns;
    if (t === undefined) return { text: 'Done.' };
    if (typeof t === 'function') return t(req, i);
    return t[i] ?? { text: 'Done.' };
  };
  const ctx: FakeAgentContext = {
    runId: 'run-agent-test',
    runDir: o.runDir ?? tempRunDir(),
    sessionId: o.sessionId ?? 'session-1',
    step: 1,
    task: o.task ?? 'fix the failing test',
    resumed: o.resumed ?? false,
    workspace: fs,
    workspaceInfo: { root: fs.root, git: true, hasTests: o.testCommand !== null, testCommand: o.testCommand === undefined ? { command: 'pytest -q', runner: 'pytest' } : o.testCommand, ...(o.gitState ? { gitState: o.gitState } : {}) },
    sandbox: sb,
    limits: DEFAULT_LIMITS,
    signal: controller.signal,
    redact: (s) => s.replace(/sk-secret-[a-z0-9]+/g, '[REDACTED]'),
    autonomy: o.autonomy ?? 'full',
    verify: o.verify ?? 'off',
    provider: o.provider ?? { name: 'openrouter', model: 'z-ai/glm-5.3-flash' },
    generation: { temperature: 0.2, maxTokens: o.maxTokens ?? 4096 },
    windowTokens: o.windowTokens === undefined ? 200_000 : o.windowTokens,
    compaction: o.compaction ?? { mode: 'code', explicit: false },
    instructions: null,
    memoryIndex: null,
    seed: o.seed ?? null,
    conversation: o.conversation ?? null,
    plan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] },
    lastTestRun: null,
    testsCurrent: false,
    createdThisRun: new Set(),
    dirtyAtStart: new Set(o.dirtyAtStart ?? []),
    jevAvailable: o.jevAvailable ?? false,
    state: o.state ?? null,
    fs,
    sb,
    events,
    requests,
    sent,
    hooks,
    asks,
    usages,
    steerQueue,
    compactRequest: false,
    outputs,
    abort(reason) {
      controller.abort(reason);
    },
    setState(s) {
      ctx.state = s;
    },
    emit(e) {
      events.push(e);
    },
    async generate(req, h): Promise<GenerateResult> {
      requests.push(req);
      sent.push(JSON.parse(JSON.stringify(req)) as GenerateRequest);
      hooks.push(h);
      const i = calls;
      calls += 1;
      const t = turnAt(req, i);
      if (t.delayMs !== undefined) await abortableDelay(t.delayMs, controller.signal);
      if (t.error !== undefined) throw t.error;
      const text = t.text ?? '';
      for (const c of t.chunks ?? (text.length > 0 ? [text] : [])) h.onText?.(c);
      return {
        text,
        toolCalls: (t.toolCalls ?? []).map((c) => ({ name: c.name, input: c.input, rawJson: c.rawJson ?? JSON.stringify(c.input), ...(c.id !== undefined ? { id: c.id } : {}) })),
        usage: { ...ZERO_USAGE, ...t.usage },
        model: ctx.provider.model,
        stopReason: t.stopReason ?? (t.toolCalls !== undefined && t.toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        latencyMs: 1,
        ...(t.providerState !== undefined ? { providerState: { provider: ctx.provider.name, model: ctx.provider.model, data: t.providerState } } : {}),
      };
    },
    async ask(state, questions, signal) {
      const call = { state, questions };
      asks.push(call);
      if (o.ask === undefined) throw new Error('no fake ask configured');
      const answers = await o.ask(call, signal);
      const rows: Decision[] = [];
      return { answers, rows, latencyMs: 1 };
    },
    routeToken() {
      if (token.step !== ctx.step) token = createStepToken(ctx.step);
      return token;
    },
    async writeOutput(text, part) {
      const name = `outputs/step-${ctx.step}${part !== undefined ? `-${part}` : ''}.txt`;
      outputs.set(name, text);
      return `jevcode:${name}`;
    },
    takeSteers() {
      return steerQueue.splice(0);
    },
    takeCompactRequest() {
      const r = ctx.compactRequest;
      ctx.compactRequest = false;
      return r;
    },
    reportContext(u) {
      usages.push(u);
    },
    now: () => Date.now(),
    wallRemainingMs: () => o.wallRemainingMs ?? 30 * 60_000,
    eventsOf<T extends EngineEvent['type']>(type: T) {
      return events.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
    },
  };
  return ctx;
}

export interface StepOptions {
  /** the files a command changed (the per-step change set); default: none */
  changedFiles?: (command: string) => string[];
  /** review mode: approve (true) or decline (false) a `review` gate; default decline */
  approve?: boolean;
}

export interface StepRecordLite {
  next: AgentNext;
  observed: AgentObserveResult | null;
  outcome: ActionOutcome | null;
}

function testsOf(ctx: FakeAgentContext, command: string, exec: ExecResult): { command: string; parsed: TestCounts | null; allPassed: boolean | null } | null {
  const tc = ctx.workspaceInfo.testCommand;
  if (!isTestCommand(command, tc)) return null;
  const parsed = ctx.fs.parseTestOutput(tc!.runner, `${exec.stdout}\n${exec.stderr}`);
  return { command, parsed, allPassed: parsed === null ? null : parsed.failed === 0 && parsed.errors === 0 && exec.ok };
}

/**
 * One engine step, minus the engine: `next()`, then — for act / verify / finish — execute the proposal against the fakes
 * the way the shared tail would, and `observe()`. The step counter advances afterwards.
 */
export async function step(driver: AgentDriver, ctx: FakeAgentContext, so: StepOptions = {}): Promise<StepRecordLite> {
  const next = await driver.next(ctx);
  let outcome: ActionOutcome | null = null;
  let observed: AgentObserveResult | null = null;
  if (next.kind === 'observe') outcome = next.outcome;
  else {
    let output = '';
    let changed: string[] = [];
    let tests: { command: string; parsed: TestCounts | null; allPassed: boolean | null } | null = null;
    const a = next.proposal.action;
    const gate = next.kind === 'act' ? next.gate : { verdict: 'ok' as const, reason: '', rule: null };
    if (gate.verdict === 'block') outcome = { status: 'blocked', reason: gate.reason };
    else if (gate.verdict === 'review' && so.approve !== true) outcome = { status: 'declined', reason: 'declined (no reviewer)' };
    else if (a.kind === 'edit') {
      try {
        changed = (await ctx.fs.applyEdit(a)).changedFiles;
        outcome = { status: 'executed', summary: `edited ${a.path}`, changedFiles: changed };
      } catch (e) {
        outcome = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
      }
    } else if (a.kind === 'write') {
      changed = (await ctx.fs.writeFile(a)).changedFiles;
      outcome = { status: 'executed', summary: `wrote ${a.path}`, changedFiles: changed };
    } else if (a.kind === 'run') {
      const exec = await ctx.sb.run(a.command, { timeoutMs: a.timeoutMs ?? 120_000, maxOutputBytes: 200_000, signal: ctx.signal, ...(a.cwd !== undefined ? { cwd: a.cwd } : {}) });
      output = exec.stderr.length > 0 ? `${exec.stdout}\n[stderr]\n${exec.stderr}` : exec.stdout;
      changed = so.changedFiles?.(a.command) ?? [];
      tests = testsOf(ctx, a.command, exec);
      outcome = { status: 'executed', exec, summary: `exit ${exec.exitCode}`, changedFiles: changed };
      if (tests !== null && tests.parsed !== null) {
        ctx.lastTestRun = { step: ctx.step, command: a.command, passed: tests.parsed.passed, failed: tests.parsed.failed, errors: tests.parsed.errors, allPassed: tests.allPassed === true };
      }
    } else outcome = { status: 'noop', summary: 'done' };
    observed = await driver.observe(ctx, { step: ctx.step, outcome, output, changedFiles: changed, tests, error: outcome.status === 'failed' ? { code: 'edit', message: outcome.error } : null });
  }
  ctx.step += 1;
  return { next, observed, outcome };
}

/** Run steps until a finish step (or `max`), returning every step. */
export async function runUntilFinish(driver: AgentDriver, ctx: FakeAgentContext, so: StepOptions = {}, max = 30): Promise<StepRecordLite[]> {
  const out: StepRecordLite[] = [];
  for (let i = 0; i < max; i += 1) {
    const s = await step(driver, ctx, so);
    out.push(s);
    if (s.next.kind === 'finish') return out;
  }
  throw new Error(`no finish within ${max} steps: ${out.map((s) => s.next.kind).join(', ')}`);
}

export { execResult };

/** A tool call in a scripted turn. */
export function call(name: string, input: Json, id?: string): { id?: string; name: string; input: Json } {
  return { name, input, ...(id !== undefined ? { id } : {}) };
}

/** The agent messages of the n-th request, as sent. */
export function messagesOf(ctx: FakeAgentContext, n: number): NonNullable<GenerateRequest['agent']>['messages'] {
  return ctx.sent[n]?.agent?.messages ?? [];
}

/** Every text block of the user messages of a request, joined. */
export function userText(ctx: FakeAgentContext, n: number): string {
  return messagesOf(ctx, n)
    .filter((m) => m.role === 'user')
    .flatMap((m) => m.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : '')))
    .join('\n');
}
