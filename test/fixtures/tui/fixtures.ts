/** Typed builders and an in-memory fake Engine for the TUI tests (no other module is imported). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmitter } from '../../../src/core/events.js';
import type {
  Action,
  CheckpointState,
  ConfirmRequest,
  Decision,
  Engine,
  EngineEvent,
  EngineStatus,
  Proposal,
  RiskAssessment,
  RunResult,
  SpendSnapshot,
  StageName,
  TokenUsage,
} from '../../../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));

export function mkUsage(input = 0, output = 0, cost = 0, calls = 0): TokenUsage {
  return { inputTokens: input, outputTokens: output, costUsd: cost, calls };
}

export function mkSpend(genCost = 0.12, jevCost = 0.01, cap = 2): SpendSnapshot {
  return { generator: mkUsage(10_000, 2_300, genCost, 3), jev: mkUsage(4_100, 0, jevCost, 9), totalUsd: genCost + jevCost, capUsd: cap, exceeded: genCost + jevCost >= cap };
}

export function mkStatus(step: number, stage: StageName | 'idle', maxSteps = 40): EngineStatus {
  return { step, maxSteps, wallMs: 72_000, maxWallMs: 1_800_000, stage, spend: mkSpend(), stopReason: null };
}

export function mkRisk(verdict: 'ok' | 'review' | 'block' = 'review'): RiskAssessment {
  const risk = verdict === 'ok' ? 0.25 : verdict === 'review' ? 0.5 : 0.8;
  const dim = (level: number, r: number): RiskAssessment['dims']['destructive'] => ({ risk: r, probability: 0.6, expected: r, tailMass: 0, bound: 'expected', confidence: 0.7, level });
  return {
    dims: { destructive: dim(2, risk), out_of_scope: dim(0, 0.05), plan_mismatch: dim(0, 0.05), irreversible: dim(1, 0.25) },
    risk,
    verdict,
    reason: `destructive: level 2 (${risk.toFixed(2)})`,
  };
}

export function mkProposal(action: Action = { kind: 'edit', path: 'src/a.py', old: 'x = 1\n', new: 'x = 2\n' }, goal = 'fix the off-by-one'): Proposal {
  return { goal, action, plan: { done: ['read a.py'], remaining: ['run tests', 'fix'], openProblems: [] }, rawText: JSON.stringify({ goal, action }) };
}

export function mkConfirmRequest(id = 'c1', step = 3, action?: Action): ConfirmRequest {
  return { id, step, proposal: mkProposal(action), risk: mkRisk('review') };
}

export function mkDecision(over: Partial<Decision> = {}): Decision {
  return {
    step: 3,
    stage: 'risk',
    id: 'destructive',
    question: { type: 'score', instructions: 'x', criteria: ['a', 'b', 'c', 'd', 'e'] },
    answer: { type: 'score', score: 1, legend: {}, probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 }, confidence: 0.8 },
    probability: 0.8,
    confidence: 0.83,
    latencyMs: 170,
    requestHash: 'abc123def456',
    ...over,
  };
}

export function mkRunResult(stopReason: RunResult['stopReason'] = 'complete'): RunResult {
  return {
    runId: 'r1',
    mode: 'jev-on',
    stopReason,
    steps: 4,
    wallMs: 95_000,
    usage: { generator: mkUsage(10_000, 2_300, 0.12, 4), jev: mkUsage(4_100, 0, 0.01, 12) },
    timing: { generatorMs: 1, jevMs: 2, execMs: 3, harnessMs: 4, totalMs: 10 },
    tokensPerStep: [1, 2, 3, 4],
    jevLatencyMs: [170, 160],
    jevQuestions: 12,
    counters: { blocked: 0, reviews: 1, declined: 0, failed: 0, loops: 0, replans: 0, reads: 1 },
    finalPlan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] },
    resolvedJevModel: 'jev-1.13-20260917',
    jevModelDrift: null,
  };
}

export interface FakeEngine {
  engine: Engine;
  emit(e: EngineEvent): void;
  aborted: Array<'human_abort' | 'signal'>;
}

export function fakeEngine(): FakeEngine {
  const events = createEmitter(() => undefined);
  const controller = new AbortController();
  const aborted: Array<'human_abort' | 'signal'> = [];
  const engine: Engine = {
    runId: 'r1',
    events,
    signal: controller.signal,
    run: () => Promise.resolve(mkRunResult()),
    abort: (reason) => {
      aborted.push(reason);
      controller.abort();
    },
    status: () => mkStatus(0, 'idle'),
    snapshotState: (): CheckpointState | null => null,
  };
  return { engine, emit: (e) => events.emit(e), aborted };
}

/** The scripted 2-step run in run-events.json. */
export function loadRunEvents(): EngineEvent[] {
  const raw: unknown = JSON.parse(readFileSync(join(here, 'run-events.json'), 'utf8'));
  if (!Array.isArray(raw)) throw new Error('run-events.json must be an array');
  return raw as EngineEvent[];
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
