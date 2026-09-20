/**
 * Offline Decider (DESIGN.md §4 MockDeciderOptions) for unit tests, perf and the mocked bench.
 *
 * Every answer is built so that validateJevResponse() accepts it (all keys present, sum 1,
 * choice = argmax, score = Σ k·p, confidence from jev/confidence.ts), and the assembled body
 * is validated before it is returned, so a scripted rule that returns a malformed answer
 * fails loudly instead of leaking a shape the real client would reject. The default
 * heuristics read the §5.5 state defensively so an end-to-end run without a key behaves
 * plausibly: routine actions execute, dangerous commands block, completion fires only when
 * tests are current and passing.
 */
import { JevCodeError, JevHttpError, JevResponseError } from '../errors.js';
import { sha12 } from '../core/hash.js';
import { isJsonObject, toJson } from '../core/json.js';
import { sleep } from '../core/time.js';
import type { Answer, AskOptions, AskResult, Decider, JevRequest, Json, JsonObject, MockDeciderContext, MockDeciderOptions, Question, StageName } from '../core/types.js';
import { choiceConfidence, scoreConfidence } from './confidence.js';
import { ESCAPE_KEY, PAIRED_PREFIX, QuestionBuildError, assertQuestionBatch } from './questions.js';
import { isRetryableStatus } from './client.js';
import { DEFAULT_JEV_MODEL, JEV_INPUT_USD_PER_TOKEN, JEV_TOKENS_PER_CHAR, JEV_TOKEN_OVERHEAD } from './types.js';
import { validateJevResponse } from './validate.js';

/** Commands the default risk heuristic treats as block-level (§5.5 destructive levels 3-4). */
export const DANGEROUS_COMMAND = /rm -rf|git push --force|sudo|curl[^|]*\|\s*sh|mkfs|:\(\)\{/;

// ---------------------------------------------------------------------------------------
// Defensive state readers: the state is whatever the engine built; never assume a field
// ---------------------------------------------------------------------------------------

function obj(v: Json | undefined): JsonObject | null {
  return v !== undefined && isJsonObject(v) ? v : null;
}
function at(root: Json | undefined, ...path: string[]): Json | undefined {
  let cur: Json | undefined = root;
  for (const p of path) {
    const o = obj(cur);
    if (o === null) return undefined;
    cur = o[p];
  }
  return cur;
}
function isEscape(key: string): boolean {
  return key === ESCAPE_KEY || key.startsWith('none_of');
}
function textOf(v: Json): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// ---------------------------------------------------------------------------------------
// Answer builders (each produces a wire-valid Answer)
// ---------------------------------------------------------------------------------------

/** Nouls are clipped to [0.01, 0.99] on the wire (REPORT §6); mirror it so tests see realistic values. */
export function noulAnswer(p: number): Answer {
  const clipped = Math.min(0.99, Math.max(0.01, Number.isFinite(p) ? p : 0.5));
  return { type: 'noul', noul: clipped };
}

/** Choice answer from a partial mass map; missing options get 0, the mass is renormalised. */
export function choiceAnswer(question: Extract<Question, { type: 'choice' }>, mass: Record<string, number>): Answer {
  const keys = Object.keys(question.criteria);
  let total = 0;
  for (const k of keys) total += Math.max(0, mass[k] ?? 0);
  const probabilities: Record<string, number> = {};
  let choice = keys[0] ?? '';
  let best = -1;
  for (const k of keys) {
    const p = total > 0 ? Math.max(0, mass[k] ?? 0) / total : 1 / keys.length;
    probabilities[k] = p;
    if (p > best) {
      best = p;
      choice = k;
    }
  }
  return { type: 'choice', choice, probabilities, confidence: choiceConfidence(best, keys.length) };
}

/** Score answer from a partial level-mass map; score = Σ k·p_k, legend echoes criteria. */
export function scoreAnswer(question: Extract<Question, { type: 'score' }>, mass: Record<number, number>): Answer {
  const n = question.criteria.length;
  let total = 0;
  for (let k = 0; k < n; k++) total += Math.max(0, mass[k] ?? 0);
  const probabilities: Record<string, number> = {};
  const legend: Record<string, Json> = {};
  let score = 0;
  for (let k = 0; k < n; k++) {
    const p = total > 0 ? Math.max(0, mass[k] ?? 0) / total : 1 / n;
    probabilities[String(k)] = p;
    legend[String(k)] = question.criteria[k] ?? null;
    score += k * p;
  }
  return { type: 'score', score, legend, probabilities, confidence: scoreConfidence(probabilities, n) };
}

// ---------------------------------------------------------------------------------------
// Default heuristics
// ---------------------------------------------------------------------------------------

function exitCodeOf(state: Json): number | null | undefined {
  const executed = at(state, 'executed');
  if (executed === undefined) return undefined;
  const code = at(executed, 'exitCode');
  if (code === undefined || code === null) return null;
  return typeof code === 'number' ? code : undefined;
}
/** True when nothing executed or the exit code was 0. */
function execOk(state: Json): boolean {
  const code = exitCodeOf(state);
  return code === undefined || code === null || code === 0;
}

function defaultChoice(question: Extract<Question, { type: 'choice' }>): Answer {
  const keys = Object.keys(question.criteria);
  const real = keys.filter((k) => !isEscape(k));
  if (real.length === 0) return choiceAnswer(question, Object.fromEntries(keys.map((k) => [k, 1])));
  const mass: Record<string, number> = {};
  const [first, ...rest] = real;
  mass[first!] = rest.length === 0 ? 1 : 0.8;
  for (const k of rest) mass[k] = 0.2 / rest.length;
  return choiceAnswer(question, mass);
}

function defaultScore(question: Extract<Question, { type: 'score' }>, state: Json): Answer {
  const n = question.criteria.length;
  const command = at(state, 'proposal', 'action', 'command');
  const dangerous = typeof command === 'string' && DANGEROUS_COMMAND.test(command);
  if (n <= 1) return scoreAnswer(question, { 0: 1 });
  if (dangerous) return scoreAnswer(question, { [n - 2]: 0.2, [n - 1]: 0.8 });
  return scoreAnswer(question, { 0: 0.95, 1: 0.05 });
}

/** Context Nouls name their candidate literally (§5.5); find which one this question is about. */
function candidateFor(question: Question, state: Json): JsonObject | null {
  const candidates = obj(at(state, 'candidates'));
  if (candidates === null) return null;
  const text = textOf(question.instructions);
  let bestKey: string | null = null;
  for (const key of Object.keys(candidates)) {
    if (text.includes(`\`${key}\``) || text.includes(`[${JSON.stringify(key)}]`)) {
      if (bestKey === null || key.length > bestKey.length) bestKey = key;
    }
  }
  return bestKey === null ? null : obj(candidates[bestKey]);
}

function defaultNoul(id: string, question: Question, state: Json, chosen: ReadonlySet<string>): Answer {
  if (id.startsWith(PAIRED_PREFIX)) return noulAnswer(chosen.has(id.slice(PAIRED_PREFIX.length)) ? 0.9 : 0.2);
  if (id === 'task_complete') {
    const testsCurrent = at(state, 'workspace', 'testsCurrent') === true;
    const allPassed = at(state, 'workspace', 'lastTestRun', 'allPassed') === true;
    const remaining = at(state, 'plan', 'remaining');
    const nothingLeft = at(state, 'proposal', 'claimsDone') === true || (Array.isArray(remaining) && remaining.length === 0);
    // A workspace without a test suite (many Terminal-Bench tasks) cannot show a passing run;
    // the heuristic then accepts completion when the plan claims nothing remains.
    const hasTests = at(state, 'workspace', 'hasTests');
    if (hasTests === false) return noulAnswer(nothingLeft ? 0.95 : 0.05);
    return noulAnswer(testsCurrent && allPassed && nothingLeft ? 0.95 : 0.05);
  }
  if (id.startsWith('done_')) return noulAnswer(execOk(state) ? 0.9 : 0.1);
  switch (id) {
    case 'succeeded':
    case 'tests_pass_unparsed':
      return noulAnswer(execOk(state) ? 0.9 : 0.1);
    case 'error_present': {
      const code = exitCodeOf(state);
      return noulAnswer(typeof code === 'number' && code !== 0 ? 0.9 : 0.1);
    }
    case 'new_information':
      return noulAnswer(0.1);
    case 'plan_still_valid':
    case 'matches_intent':
      return noulAnswer(0.9);
    case 'task_impossible':
      return noulAnswer(0.05);
    default: {
      const candidate = candidateFor(question, state);
      if (candidate !== null) {
        const mentions = candidate['mentionsInTask'];
        const relevant = (typeof mentions === 'number' && mentions > 0) || candidate['touchedThisRun'] === true;
        return noulAnswer(relevant ? 0.9 : 0.15);
      }
      return noulAnswer(0.5);
    }
  }
}

/** Answers for every question not covered by a rule: Choices first so paired Nouls can see them. */
export function defaultAnswers(state: Json, questions: Record<string, Question>, given: Partial<Record<string, Answer>>): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  const chosen = new Set<string>();
  for (const [id, q] of Object.entries(questions)) {
    const g = given[id];
    if (g !== undefined) {
      out[id] = g;
      if (g.type === 'choice') chosen.add(g.choice);
      continue;
    }
    if (q.type === 'choice') {
      const a = defaultChoice(q);
      out[id] = a;
      if (a.type === 'choice') chosen.add(a.choice);
    }
  }
  for (const [id, q] of Object.entries(questions)) {
    if (out[id] !== undefined) continue;
    out[id] = q.type === 'score' ? defaultScore(q, state) : defaultNoul(id, q, state, chosen);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Decider
// ---------------------------------------------------------------------------------------

interface Trigger<T> {
  spec: T;
  remaining: number;
}

function matches(spec: { stage: StageName; step?: number }, opts: AskOptions): boolean {
  return spec.stage === opts.stage && (spec.step === undefined || spec.step === opts.step);
}

/** A body that fails validation the requested way; used by malformedAt. */
function malformedBody(model: string, questions: Record<string, Question>, transient: boolean): Json {
  if (transient) return { model, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } };
  const answers: Record<string, Json> = {};
  for (const id of Object.keys(questions)) answers[id] = { type: 'noul', noul: 0.5 };
  answers['__unrequested__'] = { type: 'noul', noul: 0.5 };
  return { model, answers, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } };
}

export function createMockDecider(opts: MockDeciderOptions = {}): Decider {
  const model = opts.model ?? DEFAULT_JEV_MODEL;
  const rules = opts.rules ?? [];
  const latencyMs = Number.isFinite(opts.latencyMs) ? Math.max(0, opts.latencyMs ?? 0) : 0;
  const failures: Trigger<NonNullable<MockDeciderOptions['failAt']>[number]>[] = (opts.failAt ?? []).map((spec) => ({
    spec,
    remaining: spec.times ?? Number.POSITIVE_INFINITY,
  }));
  const malformed: Trigger<NonNullable<MockDeciderOptions['malformedAt']>[number]>[] = (opts.malformedAt ?? []).map((spec) => ({ spec, remaining: 1 }));

  async function ask(state: Json, questions: Record<string, Question>, askOpts: AskOptions): Promise<AskResult> {
    // Same pre-flight as the real client, so engine tests see the same error for an empty batch.
    try {
      assertQuestionBatch(questions);
    } catch (e) {
      if (e instanceof QuestionBuildError) throw new JevCodeError('internal', e.message, { cause: e });
      throw e;
    }
    if (askOpts.signal.aborted) throw askOpts.signal.reason;
    if (latencyMs > 0) await sleep(latencyMs, askOpts.signal);

    const request: JevRequest = { model, state, questions };
    const requestJson = toJson(request);
    const requestHash = sha12(requestJson);

    const failure = failures.find((f) => f.remaining > 0 && matches(f.spec, askOpts));
    if (failure !== undefined) {
      failure.remaining -= 1;
      throw new JevHttpError(`Jev HTTP ${failure.spec.status} (mock failAt ${askOpts.stage}${failure.spec.step !== undefined ? ` step ${failure.spec.step}` : ''})`, {
        status: failure.spec.status,
        retryable: isRetryableStatus(failure.spec.status),
        body: '{"error":{"message":"mock failure"}}',
      });
    }

    // The real client retries a transient bad body once and surfaces a deterministic one at
    // once (§5.2); the mock reproduces both outcomes so engine tests see the same behaviour.
    let attempts = 1;
    const bad = malformed.find((m) => m.remaining > 0 && matches(m.spec, askOpts));
    if (bad !== undefined) {
      bad.remaining -= 1;
      try {
        validateJevResponse(malformedBody(model, questions, bad.spec.transient), questions);
      } catch (e) {
        if (!(e instanceof JevResponseError) || !e.transient) throw e;
        attempts += 1;
      }
    }

    const ctx: MockDeciderContext = { stage: askOpts.stage, step: askOpts.step, state, questions };
    const given: Partial<Record<string, Answer>> = {};
    for (const rule of rules) {
      const partial = rule(ctx);
      if (partial === undefined) continue;
      for (const [id, a] of Object.entries(partial)) if (a !== undefined && !Object.hasOwn(given, id) && Object.hasOwn(questions, id)) given[id] = a;
    }
    const answers = defaultAnswers(state, questions, given);

    const inputTokens = JEV_TOKEN_OVERHEAD + Math.ceil(JSON.stringify(requestJson).length * JEV_TOKENS_PER_CHAR);
    const outputTokens = Object.keys(questions).length * 10;
    const body: Json = {
      model,
      answers: toJson(answers),
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, cost: inputTokens * JEV_INPUT_USD_PER_TOKEN },
      id: `gen-dec-mock-${requestHash}`,
      provider: 'mock',
    };
    const response = validateJevResponse(body, questions);
    return {
      answers: response.answers,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, costUsd: response.usage.cost, calls: 1 },
      latencyMs,
      model: response.model,
      requestHash,
      attempts,
      id: response.id ?? null,
    };
  }

  return { model, ask };
}
