import { describe, expect, it } from 'vitest';

import type { Answer, Json, Question } from '../../../../src/core/types.js';
import { ESCAPE_KEY } from '../../../../src/jev/questions.js';
import type { Progress } from '../../../../src/synth/types.js';
import { progress } from '../../../../src/synth/verify/progress.js';
import {
  codeVerdicts,
  expectedLevel,
  failureStatus,
  judgeProgress,
  optionKeyFor,
  pickNextFailingTest,
  pickQuestion,
  progressQuestions,
  progressState,
} from '../../../../src/synth/verify/questions.js';
import { VerifyError } from '../../../../src/synth/verify/types.js';
import { choiceAnswer, failure, noulAnswer, scoreAnswer, scriptedAsk, summary } from './helpers.js';

const before = summary({ failing: ['gcd(13, 13)', 'gcd(37, 600)', 'gcd(20, 100)'], passed: 1, failures: [failure('gcd(13, 13)', 'gcd(13, 13)', '13', 'RecursionError: maximum recursion depth exceeded'), failure('gcd(37, 600)', 'gcd(37, 600)', '1', 'RecursionError: maximum recursion depth exceeded'), failure('gcd(20, 100)', 'gcd(20, 100)', '20', 'TIMEOUT after 2s')] });
const partial = summary({ failing: ['gcd(20, 100)'], passed: 3, failures: [failure('gcd(20, 100)', 'gcd(20, 100)', '20', '10')] });
const fixed = summary({ failing: [], passed: 4 });

/** REPORT §7–§11 rules every verifier question must satisfy. */
function assertReportCompliant(id: string, q: Question): void {
  expect(id).toMatch(/^[a-z][a-z0-9_]+$/);
  if (q.type === 'noul') {
    expect(q.criteria).toBeDefined();
    for (const side of ['true', 'false'] as const) {
      const c = q.criteria?.[side];
      expect(c, `${id}.${side}`).toBeTypeOf('object');
      const o = c as { definition?: unknown; examples?: unknown };
      expect(typeof o.definition).toBe('string');
      expect(Array.isArray(o.examples) && o.examples.length >= 2).toBe(true);
    }
    // backticked paths, never a bare "before"/"after" reference
    expect(String(q.instructions)).toMatch(/`(before|after)/);
  } else if (q.type === 'choice') {
    const keys = Object.keys(q.criteria);
    expect(keys).toContain(ESCAPE_KEY);
    for (const k of keys) {
      expect(k).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
      expect(k).not.toMatch(/^([a-z]|alpha|beta|gamma|option_?[a-z0-9]+|\d+)$/i);
    }
    expect(keys.length).toBeLessThanOrEqual(255);
  } else {
    expect(q.criteria.length).toBeGreaterThanOrEqual(2);
    expect(q.criteria.length).toBeLessThanOrEqual(10);
    for (const level of q.criteria) expect(String(level)).toMatch(/[a-z]{3,}/); // situations, not numbers
  }
}

describe('progress questions: measured wording, REPORT-compliant', () => {
  const p = progress(before, partial);
  const qs = progressQuestions(p);
  it('three Nouls + the 5-level Score, ids as measured', () => {
    expect(Object.keys(qs).sort()).toEqual(['broke_something', 'closeness', 'made_progress', 'program_correct']);
    for (const [id, q] of Object.entries(qs)) assertReportCompliant(id, q);
    expect(qs['closeness']?.type).toBe('score');
    expect(qs['closeness']?.type === 'score' ? qs['closeness'].criteria.length : 0).toBe(5);
    expect(String(qs['made_progress']?.instructions)).toBe('Compared with `before`, did this edit make progress: does the program pass strictly more tests in `after` than in `before`?');
    expect(String(qs['broke_something']?.instructions)).toBe('Did the edit break something that worked: is there a test that passed in `before` but fails, errors or times out in `after`?');
    expect(String(qs['program_correct']?.instructions)).toBe('After the edit, does `after` show the program passing every test, so that the program is now correct?');
    expect(String(qs['closeness']?.instructions)).toBe('Judging from `after` only, how close is the program to correct?');
  });
  it('baseline-dependent Nouls are dropped without a baseline; the Score without an after-run', () => {
    const noBaseline = progressQuestions(progress(summary({ passed: 0, total: 0 }), partial));
    expect(Object.keys(noBaseline).sort()).toEqual(['closeness', 'program_correct']);
    const noAfter = progressQuestions(progress(before, summary({ passed: 0, total: 0 })));
    expect(Object.keys(noAfter).sort()).toEqual(['broke_something', 'made_progress', 'program_correct']);
  });
  it('the state is the measured `both` shape plus the code-computed newly_* numbers; failed folds errors and timeouts', () => {
    const state = progressState(p, { subject: 'the Python function `gcd`' }) as { [k: string]: Json };
    expect(String(state['task']).startsWith('A candidate edit was applied to the Python function `gcd`. `before` is the test result of the program before the edit;')).toBe(true);
    expect(state['before']).toEqual({
      passed: 1,
      failed: 3,
      total: 4,
      failing_tests: [
        { test: 'gcd(13, 13)', input: 'gcd(13, 13)', expected: '13', actual: 'RecursionError: maximum recursion depth exceeded', status: 'error' },
        { test: 'gcd(37, 600)', input: 'gcd(37, 600)', expected: '1', actual: 'RecursionError: maximum recursion depth exceeded', status: 'error' },
        { test: 'gcd(20, 100)', input: 'gcd(20, 100)', expected: '20', actual: 'TIMEOUT after 2s', status: 'timeout' },
      ],
    });
    expect(state['after']).toEqual({ passed: 3, failed: 1, total: 4, newly_passing_tests: 2, newly_failing_tests: 0, failing_tests: [{ test: 'gcd(20, 100)', input: 'gcd(20, 100)', expected: '20', actual: '10', status: 'fail' }] });
    const withErrors = progressState(progress(before, summary({ failing: ['a'], passed: 2, errors: 2 }))) as { [k: string]: { [k: string]: Json } };
    expect(withErrors['after']?.['failed']).toBe(3);
    expect(String((progressState(p) as { [k: string]: Json })['task'])).toContain('the program under repair');
  });
  it('failing_tests are bounded to 25 entries', () => {
    const many = summary({ failing: Array.from({ length: 40 }, (_, i) => `t${i}`), passed: 0 });
    const state = progressState(progress(many, many)) as { [k: string]: { failing_tests: Json[] } };
    expect(state['after']?.failing_tests).toHaveLength(25);
  });
  it('failureStatus and expectedLevel', () => {
    expect(failureStatus(failure('a', 'a', '1', 'assert 1 == 2'))).toBe('fail');
    expect(failureStatus(failure('a', 'a', '1', 'ZeroDivisionError: division by zero'))).toBe('error');
    expect(failureStatus(failure('a', 'a', '1', 'timeout after 2 s'))).toBe('timeout');
    expect(expectedLevel({ '0': 0.1, '1': 0.2, '2': 0.7 })).toBeCloseTo(1.6, 9);
  });
  it('codeVerdicts mirror the Progress flags', () => {
    expect(codeVerdicts(p)).toEqual({ program_correct: false, made_progress: true, broke_something: false });
    expect(codeVerdicts(progress(before, fixed))).toEqual({ program_correct: true, made_progress: true, broke_something: false });
  });
});

describe('judgeProgress: one request, consistency against the code verdicts', () => {
  const agree = (p: Progress) =>
    scriptedAsk((qs) => {
      const v = codeVerdicts(p);
      const out: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(qs)) {
        if (q.type === 'noul') out[id] = noulAnswer(v[id] === true ? 0.97 : 0.03);
        else if (q.type === 'score') out[id] = scoreAnswer(q, [0, 0, 0, 0.9, 0.1]);
      }
      return out;
    });
  it('agreement: no disagreements, expected closeness level computed in code', async () => {
    const p = progress(before, partial);
    const ask = agree(p);
    const j = await judgeProgress(p, ask, { subject: 'the Python function `gcd`' });
    expect(ask.calls).toHaveLength(1);
    expect(ask.calls[0]?.stage).toBe('judge');
    expect(Object.keys(ask.calls[0]?.questions ?? {}).sort()).toEqual(['broke_something', 'closeness', 'made_progress', 'program_correct']);
    expect(j.nouls).toEqual({ program_correct: 0.03, made_progress: 0.97, broke_something: 0.03 });
    expect(j.closenessExpected).toBeCloseTo(3.1, 9);
    expect(j.disagreements).toEqual([]);
    expect(j.unsure).toEqual([]);
    expect(j.requests).toBe(1);
  });
  it('a confident wrong answer is a disagreement; the 0.3–0.7 band is unsure, never a disagreement', async () => {
    const p = progress(before, partial);
    const ask = scriptedAsk((qs) => {
      const out: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(qs)) {
        if (id === 'made_progress') out[id] = noulAnswer(0.12); // code says true
        else if (id === 'broke_something') out[id] = noulAnswer(0.55); // hedged
        else if (q.type === 'noul') out[id] = noulAnswer(0.02);
        else if (q.type === 'score') out[id] = scoreAnswer(q, [1, 0, 0, 0, 0]);
      }
      return out;
    });
    const j = await judgeProgress(p, ask);
    expect(j.disagreements).toEqual(['made_progress']);
    expect(j.unsure).toEqual(['broke_something']);
    expect(j.closenessExpected).toBe(0);
  });
});

describe('pickNextFailingTest: neutral Choice with a code tiebreak on input size', () => {
  const failures = [
    failure('test_x.py::test_big[1-2-3-4-5-6]', 'test_x.py::test_big[1-2-3-4-5-6]', '1', '0'),
    failure('test_x.py::test_small[1]', 'test_x.py::test_small[1]', '1', '0'),
    failure('test_x.py::test_mid[1-2]', 'test_x.py::test_mid[1-2]', '1', '0'),
  ];
  it('the question and state have the measured shape and are REPORT-compliant', () => {
    const b = pickQuestion(failures);
    expect(b.question.type).toBe('choice');
    assertReportCompliant('attack_first', b.question);
    expect(String(b.question.instructions)).toBe('Which entry of `failing_tests` should the repair attack first?');
    const keys = b.offered.map((o) => o.key);
    expect(keys).toEqual(['failing_test_x_test_big_1_2_3_4_5_6', 'failing_test_x_test_small_1', 'failing_test_x_test_mid_1_2']);
    if (b.question.type === 'choice') {
      expect(Object.keys(b.question.criteria)).toEqual([...keys, ESCAPE_KEY]);
      for (const k of keys) expect(b.question.criteria[k]).toBeNull();
    }
    const state = b.state as { failing_tests: Record<string, Json> };
    expect(state.failing_tests['failing_test_x_test_small_1']).toEqual({ input: 'test_x.py::test_small[1]', expected: '1', actual: '0', status: 'fail' });
  });
  it('the task text is the measured one when the subject is given, and names the program otherwise', () => {
    const named = pickQuestion(failures, { subject: 'the Python function `gcd`' }).state as { task: string };
    expect(named.task).toBe('The Python function `gcd` fails several tests. `failing_tests` lists them with input, expected output and actual result.');
    const plain = pickQuestion(failures).state as { task: string };
    expect(plain.task).toBe('The program under repair fails several tests. `failing_tests` lists them with input, expected output and actual result.');
  });
  it('keys are unique, snake_case and never index-like', () => {
    const taken = new Set<string>();
    const a = optionKeyFor('t.py::test_a[1]', taken);
    taken.add(a);
    const b = optionKeyFor('t.py::test_a(1)', taken);
    expect(a).toBe('failing_t_test_a_1');
    expect(b).toBe('failing_t_test_a_1_2');
    expect(optionKeyFor('123', new Set())).toBe('failing_test_123');
    expect(optionKeyFor('x'.repeat(200), new Set()).length).toBeLessThanOrEqual(64);
  });
  it('a clear argmax is taken as Jev\'s pick', async () => {
    const ask = scriptedAsk((qs) => ({ attack_first: choiceAnswer(qs['attack_first']!, { failing_test_x_test_big_1_2_3_4_5_6: 0.8, failing_test_x_test_small_1: 0.15, failing_test_x_test_mid_1_2: 0.05 }) }));
    const r = await pickNextFailingTest(failures, ask);
    expect(r).toMatchObject({ testId: 'test_x.py::test_big[1-2-3-4-5-6]', method: 'jev', requests: 1, probability: 0.8 });
    expect(ask.calls[0]?.stage).toBe('propose');
  });
  it('options within the ±0.02 noise band tie and the smallest input wins', async () => {
    const ask = scriptedAsk((qs) => ({ attack_first: choiceAnswer(qs['attack_first']!, { failing_test_x_test_big_1_2_3_4_5_6: 0.46, failing_test_x_test_small_1: 0.44, failing_test_x_test_mid_1_2: 0.1 }) }));
    const r = await pickNextFailingTest(failures, ask);
    expect(r).toMatchObject({ testId: 'test_x.py::test_small[1]', method: 'tiebreak', probability: 0.44 });
  });
  it('the escape option winning hands the decision to the size tiebreak over every option', async () => {
    const ask = scriptedAsk((qs) => ({ attack_first: choiceAnswer(qs['attack_first']!, { none_of_these: 0.5, failing_test_x_test_big_1_2_3_4_5_6: 0.3, failing_test_x_test_small_1: 0.1, failing_test_x_test_mid_1_2: 0.1 }) }));
    const r = await pickNextFailingTest(failures, ask);
    expect(r).toMatchObject({ testId: 'test_x.py::test_small[1]', method: 'tiebreak' });
  });
  it('one failing test needs no request; none throws; at most `max` are offered', async () => {
    const ask = scriptedAsk(() => ({}));
    const one = await pickNextFailingTest([failures[0]!], ask);
    expect(one).toMatchObject({ testId: failures[0]!.testId, method: 'single', requests: 0, probability: 1 });
    expect(ask.calls).toHaveLength(0);
    await expect(pickNextFailingTest([], ask)).rejects.toThrow(VerifyError);
    const many = Array.from({ length: 30 }, (_, i) => failure(`t${i}`, `f(${i})`));
    expect(pickQuestion(many).offered).toHaveLength(10);
    expect(pickQuestion(many, { max: 3 }).offered).toHaveLength(3);
  });
});
