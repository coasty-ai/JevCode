import { describe, expect, it } from 'vitest';
import type { StepRecord } from '../../../src/core/types.js';
import { WINDOW_SIZE, buildWindowEntry, foldStepRecord, pushWindow } from '../../../src/loop/window.js';
import { execResult } from './fakes.js';

describe('window bounds (§6)', () => {
  it('keeps the last 4 entries, output head 400 + tail 200, reason <= 600, notes and shown files bounded', () => {
    let w = pushWindow([], buildWindowEntry({ step: 1, intent: 'edit', action: 'edit a', outcome: { status: 'executed', summary: 's', changedFiles: ['a'] }, output: null, judge: null, completion: null, shownFiles: [], notes: [], error: null }));
    for (let i = 2; i <= 6; i++) {
      w = pushWindow(
        w,
        buildWindowEntry({
          step: i,
          intent: 'verify',
          action: 'run x',
          outcome: { status: 'executed', exec: execResult({ stdout: 'H'.repeat(1000) + 'T'.repeat(1000), truncated: true }), summary: 'exit 0', changedFiles: [] },
          output: 'H'.repeat(1000) + 'T'.repeat(1000),
          judge: null,
          completion: 0.3,
          shownFiles: Array.from({ length: 40 }, (_, k) => `f${k}`),
          notes: Array.from({ length: 20 }, (_, k) => `n${k}`),
          error: null,
        }),
      );
    }
    expect(w).toHaveLength(WINDOW_SIZE);
    expect(w.map((e) => e.step)).toEqual([3, 4, 5, 6]);
    const e = w[0]!;
    expect(e.output!.length).toBeLessThanOrEqual(600 + 40);
    expect(e.output!.startsWith('H'.repeat(400))).toBe(true);
    expect(e.output!.endsWith('T'.repeat(200))).toBe(true);
    expect(e.output).toContain('chars omitted');
    expect(e.truncated).toBe(true);
    expect(e.completion).toBe(0.3);
    expect(e.shownFiles).toHaveLength(24);
    expect(e.notes).toHaveLength(12);
  });
  it('blocked/declined/failed reasons are carried verbatim up to 600 chars; interrupted has no reason', () => {
    const long = 'r'.repeat(1000);
    const b = buildWindowEntry({ step: 1, intent: null, action: 'run x', outcome: { status: 'blocked', reason: long }, output: null, judge: null, completion: null, shownFiles: [], notes: [], error: null });
    expect(b.reason!.length).toBe(600);
    expect(b.outcome).toBe('blocked');
    const f = buildWindowEntry({ step: 1, intent: null, action: 'edit a', outcome: { status: 'failed', error: 'EditError: no match in a' }, output: null, judge: null, completion: null, shownFiles: [], notes: [], error: null });
    expect(f.reason).toBe('EditError: no match in a');
    const i = buildWindowEntry({ step: 1, intent: null, action: 'run x', outcome: { status: 'interrupted' }, output: null, judge: null, completion: null, shownFiles: [], notes: [], error: null });
    expect(i.reason).toBeUndefined();
    expect(i.outcome).toBe('interrupted');
  });
  it('foldStepRecord folds an uncheckpointed steps.jsonl record for --resume', () => {
    const rec: StepRecord = {
      step: 7,
      startedAt: 'now',
      intent: 'verify',
      intentAnswer: 'verify',
      contextFiles: ['src/a.py'],
      proposal: { goal: 'g', action: { kind: 'run', command: 'pytest -q' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' },
      risk: null,
      outcome: { status: 'executed', exec: execResult({ stdout: 'out' }), summary: 'exit 0', changedFiles: [] },
      judge: null,
      completion: null,
      decisions: [],
      jevRequests: [],
      usage: { generator: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 } },
      timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 0 },
      loopSignatures: [],
      interruptedAt: { stage: 'judge', reason: 'signal' },
    };
    const w = foldStepRecord([], rec);
    expect(w[0]).toMatchObject({ step: 7, action: 'run pytest -q', outcome: 'executed', output: 'out', shownFiles: ['src/a.py'], notes: ['interrupted before judge'] });
  });
});
