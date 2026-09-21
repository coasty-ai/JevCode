import { describe, expect, it } from 'vitest';

import type { Json, Question } from '../../../../src/core/types.js';
import { ESCAPE_KEY } from '../../../../src/jev/questions.js';
import { failureStatus, optionKeyFor, pickNextFailingTest, pickQuestion } from '../../../../src/synth/verify/questions.js';
import { VerifyError } from '../../../../src/synth/verify/types.js';
import { choiceAnswer, failure, scriptedAsk } from './helpers.js';

/** REPORT §7–§11 rules the verifier's Choice must satisfy: snake_case ids, the escape option, semantic keys. */
function assertReportCompliant(id: string, q: Question): void {
  expect(id).toMatch(/^[a-z][a-z0-9_]+$/);
  expect(q.type).toBe('choice');
  if (q.type !== 'choice') return;
  const keys = Object.keys(q.criteria);
  expect(keys).toContain(ESCAPE_KEY);
  for (const k of keys) {
    expect(k).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
    expect(k).not.toMatch(/^([a-z]|alpha|beta|gamma|option_?[a-z0-9]+|\d+)$/i);
  }
  expect(keys.length).toBeLessThanOrEqual(255);
}

describe('failureStatus: the `status` label of a failure text', () => {
  it('fail, error (exception class) or timeout', () => {
    expect(failureStatus(failure('a', 'a', '1', 'assert 1 == 2'))).toBe('fail');
    expect(failureStatus(failure('a', 'a', '1', 'ZeroDivisionError: division by zero'))).toBe('error');
    expect(failureStatus(failure('a', 'a', '1', 'timeout after 2 s'))).toBe('timeout');
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
