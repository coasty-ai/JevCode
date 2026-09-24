/**
 * `--jev off` (HARNESS-NEXT-DESIGN §1.2 last paragraph, §5 Ring 1): the switch that proves the degraded path exists.
 * The two doubles are the two fallback triggers of clause 3 that a test can drive — the escape option, and an
 * unreachable endpoint (the 503 of §8 R-9) — so a router tested against them has to take its code fallback.
 */
import { describe, expect, it } from 'vitest';

import { JEV_OFF_MODEL, JEV_OFF_NOUL, createJevOffDecider, jevOffAnswer, jevOffModeFrom, withJevOff } from '../../../src/jev/off.js';
import { ESCAPE_KEY, choice, noul, score } from '../../../src/jev/questions.js';
import { createMockDecider } from '../../../src/jev/mock.js';
import { HARM_DIMENSIONS, assessRisk, harmOnlyQuestions } from '../../../src/jev-modes/stages/risk.js';
import { JevHttpError } from '../../../src/errors.js';
import type { Answer, AskOptions } from '../../../src/core/types.js';

const side = (definition: string) => ({ definition, examples: ['one example', 'another example'] });
const opts = (): AskOptions => ({ signal: new AbortController().signal, stage: 'propose', step: 1 });

const runFirst = choice('which scope runs first?', { file_scope: 'the failing test file', module_scope: 'the module', full_suite: 'everything' });
const isFix = noul('is this a fix?', { true: side('it fixes the failure'), false: side('it does not') });
const harm = score('how much is lost?', ['nothing', 'recoverable', 'much of the workspace']);

describe('the --jev off switch', () => {
  it('answers a Choice with the escape option, which is what makes the call site take its code fallback', () => {
    const a = jevOffAnswer(runFirst);
    expect(a.type).toBe('choice');
    if (a.type !== 'choice') throw new Error('unreachable');
    expect(a.choice).toBe(ESCAPE_KEY);
    expect(a.probabilities[ESCAPE_KEY]).toBe(1);
  });

  it('answers a Noul with the inert 0.5 (under every yes-cut, above every no-cut)', () => {
    const n = jevOffAnswer(isFix);
    expect(n.type === 'noul' && n.noul).toBe(JEV_OFF_NOUL);
  });

  it('answers a Score at its TOP level: the inert answer may never be the permissive one (§1.2 clause 2)', () => {
    const s = jevOffAnswer(harm);
    expect(s.type).toBe('score');
    if (s.type !== 'score') throw new Error('unreachable');
    // 3 levels: "nothing" (0) … "much of the workspace" (2). Level 0 would read the proposal as harmless.
    expect(s.score).toBe(2);
    expect(s.probabilities['2']).toBe(1);
    const twoLevel = score('how hard to undo?', ['trivially', 'not at all']);
    const t = jevOffAnswer(twoLevel);
    expect(t.type === 'score' && t.probabilities['1']).toBe(1);
  });

  it('never lets the real harm gate read `ok`: assessRisk under the double is `block` on the harm dimensions', () => {
    // the actual Q20 batch the llm-jev risk stage asks (src/jev-modes/stages/risk.ts harmOnlyQuestions)
    const questions = harmOnlyQuestions();
    expect(Object.keys(questions).sort()).toEqual([...HARM_DIMENSIONS].sort());
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) answers[id] = jevOffAnswer(q);
    const risk = assessRisk(answers, 1, 'edit', { harmOnly: true });
    expect(risk.verdict).toBe('block');
    expect(risk.risk).toBe(1);
    for (const dim of HARM_DIMENSIONS) expect(risk.dims[dim].level).toBe(questions[dim]!.type === 'score' ? (questions[dim] as Extract<typeof questions[string], { type: 'score' }>).criteria.length - 1 : -1);
  });

  it('costs nothing, takes no time, makes no request, and counts what it answered', async () => {
    const d = createJevOffDecider('escape');
    const res = await d.ask({ any: 'state' }, { run_first: runFirst, is_fix: isFix }, opts());
    expect(res.model).toBe(JEV_OFF_MODEL);
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
    expect(res.latencyMs).toBe(0);
    expect(Object.keys(res.answers).sort()).toEqual(['is_fix', 'run_first']);
    expect(d.ledger()).toEqual({ requests: 1, questions: 2, byStage: { propose: 1 } });
  });

  it('rejects with the recorded outage shape in unreachable mode, so the fallback-on-error path is the one tested', async () => {
    const d = createJevOffDecider('unreachable');
    await expect(d.ask({}, { run_first: runFirst }, opts())).rejects.toBeInstanceOf(JevHttpError);
    await expect(d.ask({}, { run_first: runFirst }, opts())).rejects.toMatchObject({ status: 503, retryable: false });
    expect(d.ledger().requests).toBe(2);
  });

  it('honours an abort before it answers', async () => {
    const ctl = new AbortController();
    ctl.abort(new Error('stop'));
    await expect(createJevOffDecider('escape').ask({}, { run_first: runFirst }, { signal: ctl.signal, stage: 'propose', step: 1 })).rejects.toThrow('stop');
  });

  it('reads the environment switch, and leaves the decider alone when it is off', () => {
    expect(jevOffModeFrom({})).toBeNull();
    expect(jevOffModeFrom({ JEVCODE_JEV: 'on' })).toBeNull();
    expect(jevOffModeFrom({ JEVCODE_JEV: 'off' })).toBe('escape');
    expect(jevOffModeFrom({ JEVCODE_JEV: 'ESCAPE' })).toBe('escape');
    expect(jevOffModeFrom({ JEVCODE_JEV: 'unreachable' })).toBe('unreachable');
    const real = createMockDecider();
    expect(withJevOff(real, {})).toBe(real);
    expect(withJevOff(real, { JEVCODE_JEV: 'off' })).not.toBe(real);
    expect(withJevOff(real, { JEVCODE_JEV: 'off' }).model).toBe(JEV_OFF_MODEL);
  });
});
