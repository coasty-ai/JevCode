/**
 * Hand-written validation of a Jev response body against the request (DESIGN.md §5.2).
 *
 * Every failure is a JevResponseError with the offending path. `transient` is true only for
 * shape failures a retry could plausibly fix (not an object, missing answers/usage, non-finite
 * or out-of-range numbers, probabilities not summing to 1). Anything that contradicts the
 * request itself (ids, types, option keys, a `choice` that is not an argmax) is deterministic:
 * the same request would fail the same way, so the client throws it at once and bills once.
 */
import { JevResponseError } from '../errors.js';
import { isFiniteNumber, isJsonObject } from '../core/json.js';
import type { Answer, JevResponse, JevUsage, Json, JsonObject, Question } from '../core/types.js';
import type { ValidationClass } from './types.js';

/** Wire probabilities are two-decimal (REPORT §6); 0.05 leaves room for 255 rounded options. */
export const PROBABILITY_SUM_TOLERANCE = 0.05;
/** Float artefacts like 0.35000000000000003 sit far below this; ties are allowed. */
export const ARGMAX_TOLERANCE = 1e-6;

function fail(path: string, message: string, cls: ValidationClass): never {
  throw new JevResponseError(`Jev response invalid at ${path}: ${message}`, { path, transient: cls === 'transient' });
}

function unitInterval(v: unknown, path: string): number {
  if (!isFiniteNumber(v)) fail(path, 'expected a finite number', 'transient');
  if (v < 0 || v > 1) fail(path, `expected a value in [0, 1], got ${v}`, 'transient');
  return v;
}

/** Option keys for a Choice, "0".."n-1" for a Score. */
export function probabilityKeysFor(question: Question): string[] {
  if (question.type === 'choice') return Object.keys(question.criteria);
  if (question.type === 'score') return question.criteria.map((_, i) => String(i));
  return [];
}

function sameKeySet(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const set = new Set(expected);
  return actual.every((k) => set.has(k));
}

function validateProbabilities(raw: unknown, expectedKeys: string[], path: string): Record<string, number> {
  if (!isJsonObject(raw)) fail(path, 'expected an object', 'transient');
  const keys = Object.keys(raw);
  if (!sameKeySet(keys, expectedKeys)) {
    fail(path, `keys [${keys.join(', ')}] do not match the request's [${expectedKeys.join(', ')}]`, 'deterministic');
  }
  const out: Record<string, number> = {};
  let sum = 0;
  for (const k of expectedKeys) {
    const p = unitInterval(raw[k], `${path}.${JSON.stringify(k)}`);
    out[k] = p;
    sum += p;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) fail(path, `probabilities sum to ${sum.toFixed(4)}, expected 1 ± ${PROBABILITY_SUM_TOLERANCE}`, 'transient');
  return out;
}

function maxValue(probs: Record<string, number>): number {
  let m = -Infinity;
  for (const v of Object.values(probs)) if (v > m) m = v;
  return m;
}

function validateAnswer(raw: unknown, question: Question, path: string): Answer {
  if (!isJsonObject(raw)) fail(path, 'expected an object', 'transient');
  const type = raw['type'];
  if (typeof type !== 'string') fail(`${path}.type`, 'expected a string', 'transient');
  if (type !== question.type) fail(`${path}.type`, `expected "${question.type}", got "${type}"`, 'deterministic');

  switch (question.type) {
    case 'noul':
      return { type: 'noul', noul: unitInterval(raw['noul'], `${path}.noul`) };
    case 'choice': {
      const keys = probabilityKeysFor(question);
      const probabilities = validateProbabilities(raw['probabilities'], keys, `${path}.probabilities`);
      const choice = raw['choice'];
      if (typeof choice !== 'string') fail(`${path}.choice`, 'expected a string', 'transient');
      if (!(choice in probabilities)) fail(`${path}.choice`, `"${choice}" is not one of the request's options`, 'deterministic');
      const pChoice = probabilities[choice] ?? 0;
      const max = maxValue(probabilities);
      if (pChoice < max - ARGMAX_TOLERANCE) fail(`${path}.choice`, `"${choice}" (${pChoice}) is not an argmax of probabilities (max ${max})`, 'deterministic');
      const confidence = unitInterval(raw['confidence'], `${path}.confidence`);
      return { type: 'choice', choice, probabilities, confidence };
    }
    case 'score': {
      const n = question.criteria.length;
      const keys = probabilityKeysFor(question);
      const probabilities = validateProbabilities(raw['probabilities'], keys, `${path}.probabilities`);
      const score = raw['score'];
      if (!isFiniteNumber(score)) fail(`${path}.score`, 'expected a finite number', 'transient');
      if (score < 0 || score > n - 1) fail(`${path}.score`, `expected a value in [0, ${n - 1}], got ${score}`, 'transient');
      const confidence = unitInterval(raw['confidence'], `${path}.confidence`);
      // The wire legend echoes `criteria` keyed by index; rebuilding it from the request when
      // absent keeps the Answer shape total without making a cosmetic field a failure.
      const rawLegend = raw['legend'];
      let legend: Record<string, Json>;
      if (rawLegend === undefined) {
        legend = Object.fromEntries(question.criteria.map((c, i) => [String(i), c]));
      } else if (isJsonObject(rawLegend)) {
        legend = { ...rawLegend };
      } else {
        fail(`${path}.legend`, 'expected an object', 'transient');
      }
      return { type: 'score', score, legend, probabilities, confidence };
    }
  }
}

function validateUsage(raw: unknown, path: string): JevUsage {
  if (!isJsonObject(raw)) fail(path, 'expected an object', 'transient');
  const read = (k: keyof JevUsage): number => {
    const v = raw[k];
    if (!isFiniteNumber(v) || v < 0) fail(`${path}.${k}`, 'expected a finite non-negative number', 'transient');
    return v;
  };
  return { input_tokens: read('input_tokens'), output_tokens: read('output_tokens'), cost: read('cost') };
}

/**
 * Validate a parsed 200 body. Returns a fresh JevResponse holding only the fields the
 * contract names (unknown fields on the wire are dropped, never forwarded).
 */
export function validateJevResponse(body: unknown, questions: Record<string, Question>): JevResponse {
  if (!isJsonObject(body)) fail('$', 'expected a JSON object', 'transient');
  const obj: JsonObject = body;

  const model = obj['model'];
  if (typeof model !== 'string' || model.length === 0) fail('model', 'expected a non-empty string', 'transient');

  const rawAnswers = obj['answers'];
  if (!isJsonObject(rawAnswers)) fail('answers', 'expected an object', 'transient');
  const requested = Object.keys(questions);
  const got = Object.keys(rawAnswers);
  if (!sameKeySet(got, requested)) {
    const missing = requested.filter((id) => !(id in rawAnswers));
    const extra = got.filter((id) => !(id in questions));
    fail('answers', `ids do not match the request (missing: [${missing.join(', ')}], extra: [${extra.join(', ')}])`, 'deterministic');
  }

  const answers: Record<string, Answer> = {};
  for (const id of requested) {
    const question = questions[id];
    if (question === undefined) continue;
    answers[id] = validateAnswer(rawAnswers[id], question, `answers.${JSON.stringify(id)}`);
  }

  const usage = validateUsage(obj['usage'], 'usage');

  const out: JevResponse = { model, answers, usage };
  const id = obj['id'];
  if (typeof id === 'string' && id.length > 0) out.id = id;
  const provider = obj['provider'];
  if (typeof provider === 'string' && provider.length > 0) out.provider = provider;
  return out;
}
