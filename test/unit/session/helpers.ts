/** Fixtures for the session tests: minimal but shape-valid `RunMeta` / `CheckpointState` (they pass `isRunMeta` / `isCheckpointState`). */
import type { CheckpointState, RunMeta, SpendSnapshot, WindowEntry } from '../../../src/core/types.js';

/** A syntactically valid run id (`\d{8}-\d{6}-[a-z2-7]{8}`) for run n. */
export function runId(n: number): string {
  const day = String(10 + (n % 20)).padStart(2, '0');
  const sec = String(n % 60).padStart(2, '0');
  const tail = `r${n.toString(32).padStart(2, '0')}abcde`.replace(/[^a-z2-7]/g, 'a').slice(0, 8).padEnd(8, 'a');
  return `202609${day}-1402${sec}-${tail}`;
}

export function spend(generator: number, jev: number, capUsd = 2): SpendSnapshot {
  return {
    generator: { inputTokens: 1000, outputTokens: 100, costUsd: generator, calls: 1 },
    jev: { inputTokens: 500, outputTokens: 50, costUsd: jev, calls: 1 },
    totalUsd: generator + jev,
    capUsd,
    exceeded: generator + jev >= capUsd,
  };
}

export function makeMeta(patch: Partial<RunMeta> & { runId: string }): RunMeta {
  return {
    task: 'fix parse_date tz handling',
    workspace: '/Users/me/proj',
    mode: 'jev-on',
    config: {},
    versions: { jevcode: '0.1.0', node: '22.23.2' },
    createdAt: '2026-09-20T14:02:11.123Z',
    overrides: [],
    resumes: [],
    resolvedJevModel: null,
    jevModelDrift: null,
    ...patch,
  };
}

export function windowEntry(step: number, action = `edit src/f${step}.py`): WindowEntry {
  return { step, intent: null, action, outcome: null, shownFiles: [], notes: [`note ${step}`] };
}

export function makeState(patch: Partial<CheckpointState> & { runId: string }): CheckpointState {
  return {
    mode: 'jev-on',
    step: 0,
    plan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] },
    window: [],
    loopDetector: { counts: {}, lastSignature: null, tripped: false, replanCount: 0, tripsBySignature: {} },
    spend: spend(0, 0),
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
    updatedAt: '2026-09-20T14:05:00.000Z',
    ...patch,
  };
}
