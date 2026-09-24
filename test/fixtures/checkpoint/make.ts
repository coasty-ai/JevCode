/** In-memory factories for checkpoint tests; no other module is imported. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ActionOutcome,
  CheckpointState,
  Decision,
  ExecResult,
  Proposal,
  RunMeta,
  StepRecord,
  TokenUsage,
} from '../../../src/core/types.js';

export const FAKE_KEY = 'sk-ant-FAKEKEY0123456789abcdefghijklmnop';
export const REDACTED = '[REDACTED:test]';

/** Exact-string redactor standing in for core/redact.ts. */
export function fakeRedact(s: string): string {
  return s.split(FAKE_KEY).join(REDACTED);
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jevcode-ckpt-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
}

export function makeState(over: Partial<CheckpointState> = {}): CheckpointState {
  return {
    runId: '20260919-120000-abcdefgh',
    mode: 'jev-on',
    step: 0,
    plan: { done: [], remaining: ['do the thing'], unverified: [], openProblems: [], harnessProblems: [] },
    window: [],
    loopDetector: { counts: {}, lastSignature: null, tripped: false, replanCount: 0, tripsBySignature: {} },
    spend: { generator: zeroUsage(), jev: zeroUsage(), totalUsd: 0, capUsd: 1, exceeded: false },
    wallMsUsed: 0,
    timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 0 },
    jevLatencyMs: [],
    tokensPerStep: [],
    counters: { blocked: 0, reviews: 0, declined: 0, failed: 0, loops: 0, replans: 0, reads: 0 },
    directive: null,
    lastTestRun: null,
    lastChangeStep: null,
    createdThisRun: [],
    resolvedJevModel: null,
    jevModelDrift: null,
    stopReason: null,
    interrupted: null,
    consecutiveStageFailures: 0,
    resumes: 0,
    updatedAt: '2026-09-19T12:00:00.000Z',
    ...over,
  };
}

export function makeMeta(over: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: '20260919-120000-abcdefgh',
    task: 'fix the bug',
    workspace: '/tmp/ws',
    mode: 'jev-on',
    config: { model: { value: 'claude-sonnet-5', source: 'default' } },
    versions: { jevcode: '0.1.0', node: 'v22.23.2' },
    createdAt: '2026-09-19T12:00:00.000Z',
    overrides: [],
    resumes: [],
    resolvedJevModel: null,
    jevModelDrift: null,
    ...over,
  };
}

export function makeExec(over: Partial<ExecResult> = {}): ExecResult {
  return {
    ok: true,
    exitCode: 0,
    signal: null,
    stdout: 'ok\n',
    stderr: '',
    truncated: false,
    bytesSeen: 3,
    killedBy: null,
    timedOut: false,
    orphans: [],
    sandboxExecDenied: false,
    durationMs: 10,
    ...over,
  };
}

export function makeProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    goal: 'run the tests',
    action: { kind: 'run', command: 'pytest -q' },
    plan: { done: [], remaining: ['fix'], openProblems: [] },
    rawText: '{"kind":"run"}',
    ...over,
  };
}

export function makeStepRecord(step: number, over: Partial<StepRecord> = {}): StepRecord {
  const outcome: ActionOutcome = { status: 'executed', exec: makeExec(), summary: 'ran pytest', changedFiles: [] };
  return {
    step,
    startedAt: '2026-09-19T12:00:00.000Z',
    intent: 'verify',
    intentAnswer: 'verify',
    contextFiles: ['src/a.py'],
    proposal: makeProposal(),
    risk: null,
    outcome,
    judge: null,
    completion: null,
    decisions: [],
    jevRequests: [],
    usage: { generator: zeroUsage(), jev: zeroUsage() },
    timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 0 },
    loopSignatures: [],
    ...over,
  };
}

export function makeDecision(step: number, id: string): Decision {
  return {
    step,
    stage: 'intent',
    id,
    question: { type: 'noul', instructions: `q ${id}` },
    answer: { type: 'noul', noul: 0.9 },
    probability: 0.9,
    confidence: 0.8,
    latencyMs: 120,
    requestHash: 'abc123def456',
  };
}
