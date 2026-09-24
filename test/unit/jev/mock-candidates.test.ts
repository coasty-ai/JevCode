/**
 * The mock decider's context-Noul heuristic (§5.5: a context Noul names its candidate literally) — the same answers
 * as the readable O(questions × candidates) scan it replaced, and fast enough not to be measured as harness time.
 *
 * Why this has a test of its own (HARNESS-NEXT-DESIGN §6 S0): the scan ran inside `decider.ask`, and a mock reports
 * `latencyMs: 0`, so its CPU was charged to `StepTiming.harnessMs` — about 12 ms per step of the 50 ms
 * `step-overhead` gate was the test double, not the harness. The lookup is inverted now; the answers may not move.
 * The questions come from the real builder, so the two literal spellings under test are the ones the engine sends.
 */
import { describe, expect, it } from 'vitest';

import { createMockDecider } from '../../../src/jev/mock.js';
import { buildContextQuestions, contextQuestionId } from '../../../src/jev-modes/stages/context.js';
import type { AskOptions, Json, Question } from '../../../src/core/types.js';

const opts: AskOptions = { signal: new AbortController().signal, stage: 'context', step: 1 };

interface View {
  path: string;
  bytes: number;
  mentionsInTask: number;
  touchedThisRun: boolean;
}

function stateOf(views: readonly View[]): Json {
  const candidates: Record<string, Json> = {};
  for (const v of views) candidates[v.path] = { bytes: v.bytes, mentionsInTask: v.mentionsInTask, touchedThisRun: v.touchedThisRun };
  return { task: 'fix the failing test', candidates };
}

async function answers(s: Json, questions: Record<string, Question>): Promise<Record<string, number>> {
  const res = await createMockDecider().ask(s, questions, opts);
  const out: Record<string, number> = {};
  for (const [id, a] of Object.entries(res.answers)) out[id] = a.type === 'noul' ? a.noul : Number.NaN;
  return out;
}

describe('mock decider: the context candidate lookup', () => {
  it('reads the candidate off the instructions — mentioned or touched is relevant, everything else is not', async () => {
    const views: View[] = [
      { path: 'src/a.py', bytes: 100, mentionsInTask: 2, touchedThisRun: false },
      { path: 'src/b.py', bytes: 100, mentionsInTask: 0, touchedThisRun: true },
      { path: 'src/c.py', bytes: 100, mentionsInTask: 0, touchedThisRun: false },
    ];
    const a = await answers(stateOf(views), buildContextQuestions(views, 'edit'));
    expect(a[contextQuestionId('src/a.py')]).toBe(0.9);
    expect(a[contextQuestionId('src/b.py')]).toBe(0.9);
    expect(a[contextQuestionId('src/c.py')]).toBe(0.15);
  });

  it('falls back to 0.5 when the state knows nothing about the file the question names', async () => {
    const views: View[] = [{ path: 'src/absent.py', bytes: 10, mentionsInTask: 5, touchedThisRun: true }];
    const a = await answers({ task: 't', candidates: {} }, buildContextQuestions(views, 'edit'));
    expect(a[contextQuestionId('src/absent.py')]).toBe(0.5);
  });

  it('takes the longest candidate key the instructions name', async () => {
    const views: View[] = [
      { path: 'a.py', bytes: 10, mentionsInTask: 0, touchedThisRun: false },
      { path: 'pkg/a.py', bytes: 10, mentionsInTask: 3, touchedThisRun: false },
    ];
    // both spellings of the longer key appear in its own question (`pkg/a.py` and candidates["pkg/a.py"])
    const a = await answers(stateOf(views), buildContextQuestions(views, 'edit'));
    expect(a[contextQuestionId('pkg/a.py')]).toBe(0.9);
    expect(a[contextQuestionId('a.py')]).toBe(0.15);
  });

  it('answers a large context request in well under the harness budget (the old scan was O(questions × candidates))', async () => {
    const all: View[] = [];
    for (let i = 0; i < 1000; i++) all.push({ path: `src/pkg${i % 40}/module_${i}.py`, bytes: 512, mentionsInTask: i % 7 === 0 ? 1 : 0, touchedThisRun: false });
    const asked = all.slice(0, 200);
    const questions = buildContextQuestions(asked, 'edit');
    // docs/DECISIONS.md (2026-09-22, wall-clock gates on the shared machine): three calls, keep the BEST. `answers`
    // is pure — same state, same questions, same result — so repeating it costs nothing but a sample, and the
    // single 100 ms sample this replaces was the reported flake (102.68 ms under a peer's suite). The quadratic
    // scan this test exists to catch needs tens of times the budget, so it still fails EVERY sample.
    const state = stateOf(all);
    let best = Number.POSITIVE_INFINITY;
    let a: Record<string, number> = {};
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      a = await answers(state, questions);
      best = Math.min(best, performance.now() - t0);
    }
    expect(a[contextQuestionId('src/pkg0/module_0.py')]).toBe(0.9);
    expect(a[contextQuestionId('src/pkg1/module_1.py')]).toBe(0.15);
    expect(best, `best of 3 = ${best.toFixed(2)} ms`).toBeLessThan(100);
  });
});
