/**
 * Fake agent-mode event streams for the TUI tests (AGENT-LOOP-DESIGN §9.2; slice S5a). The agent-mode factory in this
 * tree is a stub that throws, so every agent test drives the renderers with events built here: the S1 contract's
 * `assistant:text` / `assistant:reset` / `generator:reasoning` / `tool:call` / `tool:result` members, and step records
 * carrying `StepRecord.agent`.
 */
import type { Action, ActionOutcome, AgentCallSummary, EngineEvent, JudgeTests, RunResult, StepAgentSummary, StepRecord } from '../../../src/core/types.js';

const USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };

/** A committed agent step: its kind, calls, action and outcome, with a model turn when `turn` is set. */
export function agentStep(step: number, o: { kind: StepAgentSummary['kind']; calls?: AgentCallSummary[]; action?: Action | null; outcome?: ActionOutcome | null; tests?: JudgeTests; turn?: number | null; totalMs?: number; remaining?: string[] }): StepRecord {
  const action = o.action ?? null;
  return {
    step,
    startedAt: '2026-09-23T12:00:00.000Z',
    intent: null,
    intentAnswer: null,
    contextFiles: [],
    proposal: action === null ? null : { goal: '', action, plan: { done: [], remaining: o.remaining ?? [], openProblems: [] }, rawText: '' },
    risk: null,
    outcome: o.outcome ?? null,
    judge: o.tests === undefined ? null : { succeeded: 1, errorPresent: 0, newInfo: 0, tests: o.tests, doneClaims: [], source: 'code' },
    completion: null,
    decisions: [],
    jevRequests: [],
    usage: { generator: USAGE, jev: USAGE },
    timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: o.totalMs ?? 1200 },
    loopSignatures: [],
    proposer: 'agent',
    agent: { kind: o.kind, turn: o.turn === undefined ? 1 : o.turn, calls: o.calls ?? [], seqAfter: step * 2 },
  };
}

/** The run's end, with a stop reason. */
export function agentRunResult(stopReason: RunResult['stopReason'], steps = 1): RunResult {
  return {
    runId: 'a1',
    mode: 'agent',
    stopReason,
    steps,
    wallMs: 2_000,
    usage: { generator: { ...USAGE, costUsd: 0.002 }, jev: USAGE },
    timing: { generatorMs: 1, jevMs: 0, execMs: 0, harnessMs: 1, totalMs: 2 },
    tokensPerStep: [],
    generatorTokensPerStep: [],
    jevTokensPerStep: [],
    jevLatencyMs: [],
    jevQuestions: 0,
    counters: { blocked: 0, reviews: 0, declined: 0, failed: 0, loops: 0, replans: 0, reads: 0 },
    finalPlan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] },
    resolvedJevModel: 'none',
    jevModelDrift: null,
  };
}

/** The opening of an agent run: `run:start` (mode agent), `run:ready`, the workspace git row, `step:start`, the first turn. */
export function agentOpening(task = 'hi', runId = 'a1'): EngineEvent[] {
  return [
    { type: 'run:start', runId, task, mode: 'agent', resumedFromStep: null },
    { type: 'run:ready', runId, step: 0, maxSteps: 250, task, resumed: false },
    { type: 'step:start', step: 1, startedAt: '2026-09-23T12:00:00.000Z' },
    { type: 'stage:start', step: 1, stage: 'propose' },
    { type: 'generator:start', step: 1, attempt: 1 },
  ];
}

/**
 * What the engine's shaper emits for a stream of chunks (AGENT-LOOP-DESIGN §9.3, restated for the tests): every chunk as
 * `generator:delta`, then — when the chunk completed a line and no fence is open — an `assistant:text` with everything up
 * to the last newline; at the end the remainder as `final: true`. A fence holds its lines until it closes.
 */
export function shapedTurn(step: number, turn: number, chunks: readonly string[], attempt = 1): EngineEvent[] {
  const out: EngineEvent[] = [];
  let pending = '';
  const fenceOpen = (s: string): boolean => (s.split('\n').filter((l) => /^\s*```/.test(l)).length % 2) === 1;
  for (const c of chunks) {
    out.push({ type: 'generator:delta', step, text: c });
    pending += c;
    const cut = pending.lastIndexOf('\n');
    if (cut >= 0 && !fenceOpen(pending.slice(0, cut + 1))) {
      out.push({ type: 'assistant:text', step, turn, attempt, text: pending.slice(0, cut), final: false });
      pending = pending.slice(cut + 1);
    }
  }
  if (pending !== '') out.push({ type: 'assistant:text', step, turn, attempt, text: pending, final: true });
  return out;
}

/** Split a text into chunks of random sizes (1..max), deterministic for a seed. */
export function randomChunks(text: string, seed: number, max = 12): string[] {
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const n = 1 + Math.floor(rnd() * max);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}
