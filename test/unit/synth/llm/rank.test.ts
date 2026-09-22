import { describe, expect, it } from 'vitest';

import { sha12 } from '../../../../src/core/hash.js';
import type { Answer } from '../../../../src/core/types.js';
import { ESCAPE_KEY } from '../../../../src/jev/questions.js';
import { llmSiteAt, type LlmApplied } from '../../../../src/synth/llm/candidates.js';
import { Q17_CHOICE_ID, Q17_CHOICE_MAX, Q17_NOUL_CHUNK, Q17_NOUL_PREFIX, buildQ17, fixAbsentSignals, hunksOf, orderByQ17, q17Needed, readQ17, type Q17Input } from '../../../../src/synth/llm/rank.js';
import type { FailureView } from '../../../../src/synth/types.js';
import { choiceAnswer, noulAnswer } from '../search/helpers.js';
import { CALC_SRC, calcFiles } from './fixtures.js';

const files = calcFiles();
const calc = files.get('src/calc.py')!;
const failures: FailureView[] = [{ testId: 't::test_add', call: 'add(None, 2)', expected: '2', actual: 'TypeError: bad operand' }];

/** A distinct LLM candidate replacing L4 with `text` (no dry run needed: the before-image is the file). */
function applied(i: number, text = `    return a + b + ${i}`): LlmApplied {
  const sha = sha12(text);
  const candidate: LlmApplied['candidate'] = { id: `llm:${sha}`, site: llmSiteAt(calc, 4, 4, ['test']), text, source: 'llm', op: `sample_${i}_0`, provenance: `variant ${i}` };
  if (i % 2 === 1) candidate.extraEdits = [{ path: 'src/util.py', line: 2, kind: 'replace', text: '    return x' }, { path: 'src/calc.py', line: 10, kind: 'delete' }];
  return { candidate, files: [{ path: 'src/calc.py', before: CALC_SRC, after: CALC_SRC }], diff: `+${text}\n` };
}

function input(n: number): Q17Input {
  return { task: 'add() must treat None as 0', failures, candidates: Array.from({ length: n }, (_, i) => applied(i)), files };
}

describe('Q17: order only, chunked Nouls', () => {
  // OOS 2026-09-22 ranked change 1 ("can I just run them all?"): the t_run clause is gone, because
  // `runsLeft` already prices t_run. Evidence: 707 requests / 64,961 `candidate_*` questions, 99 % of
  // the ladder's (393/397) and 100 % of SWE's (302/302) fired in `plausible = 0` steps, and of 65,076
  // answers 96.3 % fell in [0.0, 0.1) with 13 at or above 0.5.
  it('is asked only when the queue cannot run every distinct sample; a pool that fits the run budget is never ordered, however costly one run is (OOS 2026-09-22 ranked change 1)', () => {
    expect(q17Needed(3, 8, 300)).toBe(false);
    expect(q17Needed(9, 8, 300)).toBe(true);
    // the pool fits the runs left: the goal test decides it for free, so no request is spent on an order
    expect(q17Needed(2, 8, 2500)).toBe(false);
    expect(q17Needed(1, 0, 2500)).toBe(false);
    // a pool larger than the budget still ranks, at any t_run
    expect(q17Needed(9, 8, 2500)).toBe(true);
    expect(q17Needed(2, 1, 100)).toBe(true);
  });

  it('builds one Choice over ≤ 8 candidates plus full-criteria Nouls in chunks ≤ 50 with position-free keys', () => {
    const plan = buildQ17(input(60));
    expect(plan.requests).toHaveLength(2);
    const [first, second] = plan.requests;
    expect(first!.hasChoice).toBe(true);
    expect(first!.keys).toHaveLength(Q17_NOUL_CHUNK);
    const choice = first!.questions[Q17_CHOICE_ID]!;
    expect(choice.type).toBe('choice');
    if (choice.type === 'choice') {
      const keys = Object.keys(choice.criteria);
      expect(keys).toHaveLength(Q17_CHOICE_MAX + 1);
      expect(keys.at(-1)).toBe(ESCAPE_KEY);
      expect(keys.slice(0, -1).every((k) => /^patch_[0-9a-f]{4,}$/.test(k))).toBe(true);
    }
    expect(Object.keys(first!.questions).filter((k) => k.startsWith(Q17_NOUL_PREFIX))).toHaveLength(Q17_NOUL_CHUNK);
    expect(second!.hasChoice).toBe(false);
    expect(second!.keys).toHaveLength(10);
    expect(Object.keys(second!.questions)).toHaveLength(10);
    for (const r of plan.requests) for (const [id, q] of Object.entries(r.questions)) if (id !== Q17_CHOICE_ID) expect(q.type === 'noul' && q.criteria !== undefined).toBe(true);
    // every candidate has a unique key and the state names its hunks without position keys
    expect(new Set(plan.keyOf.values()).size).toBe(60);
    const state = first!.state as { candidates: Record<string, { hunks: { file: string; lines: string; replaces: string; with: string }[] }>; tests: unknown[]; program: Record<string, Record<string, string>> };
    const oddKey = plan.keyOf.get(applied(1).candidate.id)!;
    // the generator's own `rationale` (provenance 'variant i') reaches neither the state nor the option descriptions: Jev reads the hunks
    expect(Object.keys(state.candidates[oddKey]!)).toEqual(['hunks']);
    expect(JSON.stringify(first!.state)).not.toContain('variant ');
    expect(JSON.stringify(first!.state)).not.toContain('rationale');
    if (choice.type === 'choice') expect(JSON.stringify(choice.criteria)).not.toMatch(/variant |rationale/);
    expect(state.candidates[oddKey]!.hunks.map((h) => [h.file, h.lines])).toEqual([
      ['src/calc.py', 'L4'],
      ['src/util.py', 'L2'],
      ['src/calc.py', 'L10'],
    ]);
    expect(state.candidates[oddKey]!.hunks[0]!.replaces).toBe('    return a + b');
    expect(state.program['src/calc.py']!['L4']).toBe('    return a + b');
    expect(state.tests).toHaveLength(1);
    expect(hunksOf(applied(1))[2]).toMatchObject({ replaces: '    return a - b', with: '' });
  });

  it('orders by the Choice (Noul tie-break), then the rest by Noul, and records the fix-absent signals without gating', async () => {
    const q = input(10);
    const ids = q.candidates.map((a) => a.candidate.id);
    const plan = buildQ17(q);
    const keyOf = (i: number): string => plan.keyOf.get(ids[i]!)!;
    const answers = await orderByQ17(
      q,
      async (_stage, _state, questions) => {
        const out: Record<string, Answer> = {};
        const choice = questions[Q17_CHOICE_ID];
        if (choice !== undefined) out[Q17_CHOICE_ID] = choiceAnswer(choice, { [keyOf(2)]: 0.5, [keyOf(5)]: 0.3, [ESCAPE_KEY]: 0.2 });
        for (const id of Object.keys(questions)) {
          if (id === Q17_CHOICE_ID) continue;
          const key = id.slice(Q17_NOUL_PREFIX.length);
          out[id] = noulAnswer(key === keyOf(9) ? 0.9 : key === keyOf(8) ? 0.6 : key === keyOf(2) ? 0.8 : 0.1);
        }
        return { answers: out, rows: [], latencyMs: 1 };
      },
      new AbortController().signal,
    );
    expect(answers.requests).toBe(1);
    expect(answers.order.slice(0, 2)).toEqual([ids[2], ids[5]]);
    // beyond the Choice's 8: by Noul
    expect(answers.order.slice(8)).toEqual([ids[9], ids[8]]);
    expect(answers.pEscape).toBeCloseTo(0.2, 2);
    expect(answers.pMax).toBeCloseTo(0.5, 2);
    expect(answers.strong).toBe(false);
    expect(answers.weak).toBe(false);
    expect(fixAbsentSignals(0.6, 0.3, 0.2)).toEqual({ strong: true, weak: false });
    expect(fixAbsentSignals(0.6, 0.3, 0.8)).toEqual({ strong: false, weak: true });
    expect(fixAbsentSignals(0.1, 0.8, 0.2)).toEqual({ strong: false, weak: true });
    expect(readQ17(plan, []).order).toHaveLength(10);
  });
});
