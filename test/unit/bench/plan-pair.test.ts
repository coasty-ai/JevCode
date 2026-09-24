import { describe, expect, it } from 'vitest';
import { planPair } from '../../../src/bench/runner.js';
import type { BenchTaskRecord } from '../../../src/core/types.js';

function record(over: Partial<BenchTaskRecord>): BenchTaskRecord {
  return {
    suite: 'swebench',
    task: 'x__y-1',
    condition: 'jev-on',
    pass: null,
    evaluator: 'none',
    steps: 0,
    wallMs: 0,
    tokensPerStep: [],
    generatorTokensPerStep: [],
    jevTokensPerStep: [],
    cost: { generator: 0, jev: 0 },
    jevLatencyMs: { raw: [], p50: null, p95: null },
    jevRequests: 0,
    jevQuestions: 0,
    timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0 },
    stopReason: 'error',
    blocked: 0,
    reviews: 0,
    declined: 0,
    loops: 0,
    replans: 0,
    reads: 0,
    modelDrift: false,
    pairComplete: false,
    patchEmpty: null,
    patchApplied: null,
    patchBytes: null,
    runId: null,
    capFired: null,
    ...over,
  };
}

describe('planPair: setup failures are re-run on --resume', () => {
  it('re-queues an unevaluated zero-step error record and keeps evaluated or engine-error records', () => {
    expect(planPair(record({ reason: 'setup_failed: pip' }))).toEqual({ kind: 'fresh' });
    expect(planPair(record({ steps: 7, runId: '20260919-000000-abcdefgh' })).kind).toBe('skip');
    expect(planPair(record({ pass: false, evaluator: 'local-venv', steps: 25, stopReason: 'max_steps' })).kind).toBe('skip');
    expect(planPair(undefined)).toEqual({ kind: 'fresh' });
  });
});
