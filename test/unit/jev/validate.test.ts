import { describe, expect, it } from 'vitest';
import { JevResponseError } from '../../../src/errors.js';
import type { Json, Question } from '../../../src/core/types.js';
import { ARGMAX_TOLERANCE, PROBABILITY_SUM_TOLERANCE, probabilityKeysFor, validateJevResponse } from '../../../src/jev/validate.js';
import { loadLiveProbe, sampleQuestions, validBody } from './helpers.js';

function expectFailure(body: Json, questions: Record<string, Question>, pathPrefix: string, transient: boolean): JevResponseError {
  let caught: unknown;
  try {
    validateJevResponse(body, questions);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(JevResponseError);
  const err = caught as JevResponseError;
  expect(err.path.startsWith(pathPrefix), `path ${err.path} should start with ${pathPrefix}`).toBe(true);
  expect(err.transient).toBe(transient);
  expect(err.code).toBe('jev_response');
  return err;
}

/** Deep-clone a valid body then patch one answer field. */
function patched(questions: Record<string, Question>, id: string, patch: (answer: Record<string, Json>) => void): Json {
  const body = JSON.parse(JSON.stringify(validBody(questions))) as { answers: Record<string, Record<string, Json>> };
  patch(body.answers[id]!);
  return body as unknown as Json;
}

describe('validateJevResponse: accepted shapes', () => {
  it('accepts the verbatim live probe response and keeps only contract fields', () => {
    const fx = loadLiveProbe();
    const out = validateJevResponse(fx.response, fx.questions);
    expect(out.model).toBe('typesafe/jev-1.13-20260917');
    expect(out.id).toBe('gen-dec-1789872245-jPLW8jpgavaA4LAjkuAL');
    expect(out.provider).toBe('TypeSafe');
    expect(out.usage).toEqual({ input_tokens: 895, output_tokens: 82, cost: 0.00003759 });
    expect(out.answers['in_scope']).toEqual({ type: 'noul', noul: 0.98 });
    const choice = out.answers['next_action'];
    expect(choice?.type).toBe('choice');
    if (choice?.type === 'choice') {
      expect(choice.choice).toBe('apply_patch');
      expect(choice.probabilities).toEqual({ apply_patch: 0.99, read_more_code: 0.01, none_of_the_above: 0 });
    }
    const score = out.answers['destructive_risk'];
    if (score?.type === 'score') {
      expect(score.score).toBe(0);
      expect(Object.keys(score.legend)).toEqual(['0', '1', '2']);
    }
  });

  it('accepts a body with no id/provider and drops unknown fields', () => {
    const body = validBody(sampleQuestions) as Record<string, Json>;
    body['unknown_top_level'] = 1;
    (body['answers'] as Record<string, Record<string, Json>>)['in_scope']!['extra'] = true;
    const out = validateJevResponse(body, sampleQuestions);
    expect(out.id).toBeUndefined();
    expect(out.provider).toBeUndefined();
    expect(out.answers['in_scope']).toEqual({ type: 'noul', noul: 0.9 });
    expect('unknown_top_level' in out).toBe(false);
  });

  it('accepts a two-way tie {a: .5, b: .5} with choice b (wire rounding makes ties legitimate)', () => {
    const q: Record<string, Question> = { pick: { type: 'choice', instructions: 'x', criteria: { alpha_one: null, beta_two: null } } };
    const body: Json = {
      model: 'm',
      answers: { pick: { type: 'choice', choice: 'beta_two', probabilities: { alpha_one: 0.5, beta_two: 0.5 }, confidence: 0 } },
      usage: { input_tokens: 1, output_tokens: 0, cost: 0 },
    };
    const out = validateJevResponse(body, q);
    const a = out.answers['pick'];
    expect(a?.type === 'choice' && a.choice).toBe('beta_two');
  });

  it('accepts float artefacts within the argmax tolerance and a sum within 0.05', () => {
    const body = patched(sampleQuestions, 'next_action', (a) => {
      a['probabilities'] = { apply_patch: 0.35, read_more_code: 0.35000000000000003, none_of_these: 0.28 };
      a['choice'] = 'apply_patch';
    });
    expect(() => validateJevResponse(body, sampleQuestions)).not.toThrow();
    expect(ARGMAX_TOLERANCE).toBeGreaterThan(1e-12);
    expect(PROBABILITY_SUM_TOLERANCE).toBe(0.05);
  });

  it('rebuilds a missing score legend from the request criteria', () => {
    const body = patched(sampleQuestions, 'destructive', (a) => {
      delete a['legend'];
    });
    const out = validateJevResponse(body, sampleQuestions);
    const s = out.answers['destructive'];
    expect(s?.type === 'score' && s.legend['4']).toBe('outside the workspace');
  });

  it('the legend is always the request criteria, never wire text (bounds what reaches the decision rows)', () => {
    const body = patched(sampleQuestions, 'destructive', (a) => {
      a['legend'] = { '0': 'x'.repeat(100_000), '1': 'b', '2': 'c', '3': 'd', '4': 'e', '99': 'stray' };
    });
    const out = validateJevResponse(body, sampleQuestions);
    const s = out.answers['destructive'];
    if (s?.type !== 'score') throw new Error('expected score');
    expect(Object.keys(s.legend)).toEqual(['0', '1', '2', '3', '4']);
    expect(s.legend['0']).toBe('nothing');
  });

  it('clips oversize id/provider strings to 256 chars instead of forwarding them', () => {
    const body = validBody(sampleQuestions, { id: 'g'.repeat(1000) }) as Record<string, Json>;
    body['provider'] = 'p'.repeat(1000);
    const out = validateJevResponse(body, sampleQuestions);
    expect(out.id?.length).toBe(256);
    expect(out.provider?.length).toBe(256);
    expect(out.id?.startsWith('g'.repeat(200))).toBe(true);
  });

  it('probabilityKeysFor: option keys for choice, indices for score, none for noul', () => {
    expect(probabilityKeysFor(sampleQuestions['next_action']!)).toEqual(['apply_patch', 'read_more_code', 'none_of_these']);
    expect(probabilityKeysFor(sampleQuestions['destructive']!)).toEqual(['0', '1', '2', '3', '4']);
    expect(probabilityKeysFor(sampleQuestions['in_scope']!)).toEqual([]);
  });
});

describe('validateJevResponse: transient failures (retried once by the client)', () => {
  it('rejects a non-object body', () => {
    expectFailure('not json object', sampleQuestions, '$', true);
    expectFailure(null, sampleQuestions, '$', true);
    expectFailure([1, 2], sampleQuestions, '$', true);
  });
  it('rejects a missing, empty or oversize model', () => {
    const body = validBody(sampleQuestions) as Record<string, Json>;
    delete body['model'];
    expectFailure(body, sampleQuestions, 'model', true);
    body['model'] = '';
    expectFailure(body, sampleQuestions, 'model', true);
    body['model'] = 'm'.repeat(257);
    const err = expectFailure(body, sampleQuestions, 'model', true);
    expect(err.message.length).toBeLessThan(400);
    body['model'] = 'm'.repeat(256);
    expect(() => validateJevResponse(body, sampleQuestions)).not.toThrow();
  });
  it('rejects missing answers', () => {
    const body = validBody(sampleQuestions) as Record<string, Json>;
    delete body['answers'];
    expectFailure(body, sampleQuestions, 'answers', true);
  });
  it('rejects a non-object answer', () => {
    const body = validBody(sampleQuestions) as Record<string, Json>;
    (body['answers'] as Record<string, Json>)['in_scope'] = 'yes';
    expectFailure(body, sampleQuestions, 'answers."in_scope"', true);
  });
  it('rejects a noul outside [0,1] or non-finite', () => {
    expectFailure(patched(sampleQuestions, 'in_scope', (a) => { a['noul'] = 1.2; }), sampleQuestions, 'answers."in_scope".noul', true);
    expectFailure(patched(sampleQuestions, 'in_scope', (a) => { a['noul'] = -0.1; }), sampleQuestions, 'answers."in_scope".noul', true);
    expectFailure(patched(sampleQuestions, 'in_scope', (a) => { a['noul'] = 'high'; }), sampleQuestions, 'answers."in_scope".noul', true);
    expectFailure(patched(sampleQuestions, 'in_scope', (a) => { delete a['noul']; }), sampleQuestions, 'answers."in_scope".noul', true);
  });
  it('rejects probability values outside [0,1]', () => {
    const body = patched(sampleQuestions, 'next_action', (a) => {
      a['probabilities'] = { apply_patch: 1.5, read_more_code: -0.5, none_of_these: 0 };
    });
    expectFailure(body, sampleQuestions, 'answers."next_action".probabilities."apply_patch"', true);
  });
  it('rejects probabilities summing outside 1 ± 0.05', () => {
    const body = patched(sampleQuestions, 'next_action', (a) => {
      a['probabilities'] = { apply_patch: 0.5, read_more_code: 0.5, none_of_these: 0.5 };
    });
    expectFailure(body, sampleQuestions, 'answers."next_action".probabilities', true);
    const low = patched(sampleQuestions, 'destructive', (a) => {
      a['probabilities'] = { '0': 0.5, '1': 0.4, '2': 0, '3': 0, '4': 0 };
    });
    expectFailure(low, sampleQuestions, 'answers."destructive".probabilities', true);
  });
  it('rejects a non-object probabilities field', () => {
    expectFailure(patched(sampleQuestions, 'next_action', (a) => { a['probabilities'] = [1, 0, 0]; }), sampleQuestions, 'answers."next_action".probabilities', true);
  });
  it('rejects a non-string choice', () => {
    expectFailure(patched(sampleQuestions, 'next_action', (a) => { a['choice'] = 0; }), sampleQuestions, 'answers."next_action".choice', true);
  });
  it('rejects a score outside [0, n-1] or non-finite', () => {
    expectFailure(patched(sampleQuestions, 'destructive', (a) => { a['score'] = 4.5; }), sampleQuestions, 'answers."destructive".score', true);
    expectFailure(patched(sampleQuestions, 'destructive', (a) => { a['score'] = -1; }), sampleQuestions, 'answers."destructive".score', true);
    expectFailure(patched(sampleQuestions, 'destructive', (a) => { a['score'] = null; }), sampleQuestions, 'answers."destructive".score', true);
  });
  it('accepts a score at the upper bound n-1', () => {
    const body = patched(sampleQuestions, 'destructive', (a) => {
      a['score'] = 4;
      a['probabilities'] = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 };
    });
    expect(() => validateJevResponse(body, sampleQuestions)).not.toThrow();
  });
  it('rejects a confidence outside [0,1] or missing', () => {
    expectFailure(patched(sampleQuestions, 'next_action', (a) => { a['confidence'] = 1.01; }), sampleQuestions, 'answers."next_action".confidence', true);
    expectFailure(patched(sampleQuestions, 'destructive', (a) => { delete a['confidence']; }), sampleQuestions, 'answers."destructive".confidence', true);
  });
  it('rejects a non-object legend', () => {
    expectFailure(patched(sampleQuestions, 'destructive', (a) => { a['legend'] = 'x'; }), sampleQuestions, 'answers."destructive".legend', true);
  });
  it('rejects missing or non-finite usage', () => {
    const body = validBody(sampleQuestions) as Record<string, Json>;
    delete body['usage'];
    expectFailure(body, sampleQuestions, 'usage', true);
    expectFailure(validBody(sampleQuestions, { usage: { input_tokens: 'many', output_tokens: 1, cost: 0 } }), sampleQuestions, 'usage.input_tokens', true);
    expectFailure(validBody(sampleQuestions, { usage: { input_tokens: 1, output_tokens: 1, cost: -1 } }), sampleQuestions, 'usage.cost', true);
    // TUI-DESIGN-2 §2.4 / §6 item 5: TypeSafe's native response carries no `cost` (PROBE) — accepted, the field stays absent for the client to price
    expect(validateJevResponse(validBody(sampleQuestions, { usage: { input_tokens: 1, output_tokens: 1 } }), sampleQuestions).usage).toEqual({ input_tokens: 1, output_tokens: 1 });
    expectFailure(validBody(sampleQuestions, { usage: { input_tokens: 1, output_tokens: 1, cost: 'free' } }), sampleQuestions, 'usage.cost', true);
    expectFailure(validBody(sampleQuestions, { usage: { input_tokens: 1, output_tokens: 1, cost: Number.NaN } }), sampleQuestions, 'usage', true);
  });
  it('rejects a non-string answer type as transient', () => {
    expectFailure(patched(sampleQuestions, 'in_scope', (a) => { delete a['type']; }), sampleQuestions, 'answers."in_scope".type', true);
  });
});

describe('validateJevResponse: deterministic failures (never retried)', () => {
  it('rejects missing answer ids', () => {
    const body = validBody(sampleQuestions) as Record<string, Json>;
    delete (body['answers'] as Record<string, Json>)['in_scope'];
    const err = expectFailure(body, sampleQuestions, 'answers', false);
    expect(err.message).toContain('missing: [in_scope]');
  });
  it('rejects extra answer ids', () => {
    const body = validBody(sampleQuestions) as Record<string, Json>;
    (body['answers'] as Record<string, Json>)['surprise'] = { type: 'noul', noul: 0.5 };
    const err = expectFailure(body, sampleQuestions, 'answers', false);
    expect(err.message).toContain('extra: [surprise]');
  });
  it('rejects an answer whose type differs from the question', () => {
    expectFailure(patched(sampleQuestions, 'in_scope', (a) => { a['type'] = 'choice'; }), sampleQuestions, 'answers."in_scope".type', false);
  });
  it('rejects probability keys that are not the option keys', () => {
    const missingKey = patched(sampleQuestions, 'next_action', (a) => {
      a['probabilities'] = { apply_patch: 1, read_more_code: 0 };
    });
    expectFailure(missingKey, sampleQuestions, 'answers."next_action".probabilities', false);
    const extraKey = patched(sampleQuestions, 'next_action', (a) => {
      a['probabilities'] = { apply_patch: 1, read_more_code: 0, none_of_these: 0, bogus: 0 };
    });
    expectFailure(extraKey, sampleQuestions, 'answers."next_action".probabilities', false);
  });
  it('rejects score probability keys that are not 0..n-1', () => {
    const body = patched(sampleQuestions, 'destructive', (a) => {
      a['probabilities'] = { '1': 1, '2': 0, '3': 0, '4': 0, '5': 0 };
    });
    expectFailure(body, sampleQuestions, 'answers."destructive".probabilities', false);
  });
  it('rejects a choice that is not one of the options', () => {
    expectFailure(patched(sampleQuestions, 'next_action', (a) => { a['choice'] = 'bogus'; }), sampleQuestions, 'answers."next_action".choice', false);
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])('rejects the inherited property name %j as a choice (own keys only)', (name) => {
    const err = expectFailure(patched(sampleQuestions, 'next_action', (a) => { a['choice'] = name; }), sampleQuestions, 'answers."next_action".choice', false);
    expect(err.message).toContain('not one of the request');
  });

  it('bounds the wire strings quoted in error messages', () => {
    const longChoice = patched(sampleQuestions, 'next_action', (a) => { a['choice'] = 'z'.repeat(50_000); });
    const e1 = expectFailure(longChoice, sampleQuestions, 'answers."next_action".choice', false);
    expect(e1.message.length).toBeLessThan(400);

    const manyKeys = patched(sampleQuestions, 'next_action', (a) => {
      const probabilities: Record<string, number> = {};
      for (let i = 0; i < 5000; i++) probabilities[`k${i}_${'y'.repeat(300)}`] = 0;
      a['probabilities'] = probabilities;
    });
    const e2 = expectFailure(manyKeys, sampleQuestions, 'answers."next_action".probabilities', false);
    expect(e2.message.length).toBeLessThan(2000);
    expect(e2.message).toContain('+4990 more');

    const body = validBody(sampleQuestions) as Record<string, Json>;
    const answers = body['answers'] as Record<string, Json>;
    for (let i = 0; i < 1000; i++) answers[`extra_${i}`] = { type: 'noul', noul: 0.5 };
    const e3 = expectFailure(body, sampleQuestions, 'answers', false);
    expect(e3.message.length).toBeLessThan(1000);
  });
  it('rejects a choice that is not an argmax', () => {
    const body = patched(sampleQuestions, 'next_action', (a) => {
      a['choice'] = 'read_more_code';
      a['probabilities'] = { apply_patch: 0.7, read_more_code: 0.3, none_of_these: 0 };
    });
    const err = expectFailure(body, sampleQuestions, 'answers."next_action".choice', false);
    expect(err.message).toContain('not an argmax');
  });
});
