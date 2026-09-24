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
import type { Answer, AskOptions, AskResult, Decider, IntakeKind, JevRequest, Json, JsonObject, MockDeciderContext, MockDeciderOptions, Question, StageName } from '../core/types.js';
import { choiceConfidence, scoreConfidence } from './confidence.js';
import { DANGEROUS_COMMAND } from './danger.js';
import { ESCAPE_KEY, PAIRED_PREFIX, QuestionBuildError, assertQuestionBatch } from './questions.js';
import { isRetryableStatus } from './client.js';
import { DEFAULT_JEV_MODEL, JEV_INPUT_USD_PER_TOKEN, JEV_TOKENS_PER_CHAR, JEV_TOKEN_OVERHEAD } from './types.js';
import { validateJevResponse } from './validate.js';

/**
 * Commands the default risk heuristic treats as block-level (§5.5 destructive levels 3-4).
 *
 * contract 1.9 (Fastlane) §2.4: the list itself moved to `src/jev/danger.ts` as production code (with
 * `dangerousCommand()`, the reason-returning form the risk stage's code-first verdict uses). This is a
 * RE-EXPORT of the same object, so the mock decider's answers are byte-identical to before the move.
 */
export { DANGEROUS_COMMAND } from './danger.js';

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-2 §3.13: the intake heuristics (the mock's reading of a chat submission; never used outside --mock)
// ---------------------------------------------------------------------------------------

/** §3.13: a greeting, thanks, goodbye or acknowledgement — `greeting_or_smalltalk`. */
export const MOCK_GREETING_RE = /^\s*(hi|hello|hey|yo|thanks?|thank you|bye|ok(ay)?|good (morning|evening|afternoon))\b[!. ]*$/i;
/** §3.13: a `?` message naming the tool — `question_about_this_tool`; any other `?` is `question_about_the_code`. */
export const MOCK_TOOL_RE = /\b(you|jevcode|jev|mode|cost|key|command|run)\b/i;

const INTAKE_KINDS: readonly IntakeKind[] = ['greeting_or_smalltalk', 'question_about_this_tool', 'question_about_the_code', 'coding_task', 'ambiguous'];

/** `JEVCODE_MOCK_INTAKE=<kind>` (§3.13, dev-only): the forced `intake` reading, or null when unset or not a kind. */
export function mockIntakeOverride(env: Readonly<Record<string, string | undefined>>): IntakeKind | null {
  const v = env['JEVCODE_MOCK_INTAKE']?.trim();
  return INTAKE_KINDS.find((k) => k === v) ?? null;
}

/** `JEVCODE_MOCK_JEV_MS=<ms>` (§3.13, the latency probe): the mock's delay in ms, 0 when unset or malformed. */
export function mockJevLatencyMs(env: Readonly<Record<string, string | undefined>>): number {
  const v = env['JEVCODE_MOCK_JEV_MS'];
  return v !== undefined && /^\d+$/.test(v.trim()) ? Number(v.trim()) : 0;
}

/**
 * §3.13, verbatim: greeting regex → `greeting_or_smalltalk`; `?` + a tool word → `question_about_this_tool`; any other `?` →
 * `question_about_the_code`; ≤ 2 words without `?` → `ambiguous`; else `coding_task`.
 */
export function mockIntakeKind(message: string): IntakeKind {
  if (MOCK_GREETING_RE.test(message)) return 'greeting_or_smalltalk';
  if (message.includes('?')) return MOCK_TOOL_RE.test(message) ? 'question_about_this_tool' : 'question_about_the_code';
  return message.trim().split(/\s+/).filter((w) => w !== '').length <= 2 ? 'ambiguous' : 'coding_task';
}

/** §3.13: the reply catalogue key — `hello_first` (`hello_again` when `conversation` is non-empty), `thanks`, `bye`, `ok_ack`. */
export function mockReplyKey(message: string, conversationTurns: number): string {
  const m = message.trim();
  if (/^(thanks?|thank you)\b/i.test(m)) return 'thanks';
  if (/^bye\b/i.test(m)) return 'bye';
  if (/^ok(ay)?\b/i.test(m)) return 'ok_ack';
  return conversationTurns > 0 ? 'hello_again' : 'hello_first';
}

/** §3.13: `about_<key>` → 0.8 for `mode_now` on /mode/, `cost_so_far` on /cost|spent|money/, `what_it_is` on /what can you do|what are you/, else 0.1. */
export function mockFactProbability(key: string, message: string): number {
  const hit = (key === 'mode_now' && /mode/i.test(message)) || (key === 'cost_so_far' && /cost|spent|money/i.test(message)) || (key === 'what_it_is' && /what can you do|what are you/i.test(message));
  return hit ? 0.8 : 0.1;
}

/** §3.13: `file_<i>` → 0.7 when the path (from the question's backticked path) shares a keyword (≥ 3 chars) with the message, else 0.1. */
export function mockFileProbability(question: Question, message: string): number {
  const path = /`([^`]+)`/.exec(textOf(question.instructions))?.[1] ?? '';
  const lower = message.toLowerCase();
  const shares = path
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .some((tok) => tok.length >= 3 && lower.includes(tok));
  return shares ? 0.7 : 0.1;
}

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
/** §3.2 intake state: `message` (redacted head/tail) and `conversation` (the last turns). */
function messageOf(state: Json): string {
  const m = at(state, 'message');
  return typeof m === 'string' ? m : '';
}
function conversationTurns(state: Json): number {
  const c = at(state, 'conversation');
  return Array.isArray(c) ? c.length : 0;
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

/** The literal spellings a context Noul uses for its candidate (§5.5): `key` and ["key"]. */
function namesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) out.push(m[1]!);
  for (const m of text.matchAll(/\[("(?:[^"\\]|\\.)*")\]/g)) {
    try {
      const v: unknown = JSON.parse(m[1]!);
      if (typeof v === 'string') out.push(v);
    } catch {
      /* not a JSON string: not a candidate spelling */
    }
  }
  return out;
}

/**
 * Context Nouls name their candidate literally (§5.5); find which one this question is about — the longest candidate
 * key the instructions name as `key` or ["key"].
 *
 * HARNESS-NEXT-DESIGN §6 S0: the obvious shape (scan every candidate key for every question, with a `JSON.stringify`
 * and two `String.includes` per pair) is O(questions × candidates) and measured **12 ms of CPU per step** on the
 * `step-overhead` fixture (300 candidates × ~50 context Nouls). That CPU runs inside `decider.ask`, and a mock
 * reports `latencyMs: 0`, so all of it landed in the gated `harnessMs` — about a quarter of the 50 ms budget, spent
 * by the test double rather than by the harness. The lookup is inverted instead: the spellings are read off the
 * instructions once per question and probed against the candidate map, which is O(text) and gives the same key.
 */
function candidateFinder(state: Json): (question: Question) => JsonObject | null {
  const candidates = obj(at(state, 'candidates'));
  if (candidates === null) return () => null;
  return (question) => {
    let bestKey: string | null = null;
    for (const name of namesIn(textOf(question.instructions))) {
      if (!Object.hasOwn(candidates, name)) continue;
      if (bestKey === null || name.length > bestKey.length) bestKey = name;
    }
    return bestKey === null ? null : obj(candidates[bestKey]);
  };
}

function defaultNoul(id: string, question: Question, state: Json, chosen: ReadonlySet<string>, findCandidate: (q: Question) => JsonObject | null): Answer {
  if (id.startsWith(PAIRED_PREFIX)) return noulAnswer(chosen.has(id.slice(PAIRED_PREFIX.length)) ? 0.9 : 0.2);
  if (id === 'task_complete') {
    const testsCurrent = at(state, 'workspace', 'testsCurrent') === true;
    const allPassed = at(state, 'workspace', 'lastTestRun', 'allPassed') === true;
    // The accepted `plan` is empty on step 1; the generator's own claim (`proposal.planClaim`) is
    // what says whether anything remains after this step.
    const claim = at(state, 'proposal', 'planClaim', 'remaining');
    const remaining = claim !== undefined ? claim : at(state, 'plan', 'remaining');
    const nothingLeft = at(state, 'proposal', 'claimsDone') === true || (Array.isArray(remaining) && remaining.length === 0);
    // A workspace without a test suite (many Terminal-Bench tasks) cannot show a passing run;
    // the heuristic then accepts completion when the plan claims nothing remains.
    const hasTests = at(state, 'workspace', 'hasTests');
    if (hasTests === false) return noulAnswer(nothingLeft ? 0.95 : 0.05);
    // The mock exercises the pipeline, not judgment: a scripted `done` that claims nothing
    // remains is accepted even when the workspace has a test suite the mocked environment cannot run.
    if (at(state, 'proposal', 'action', 'kind') === 'done' && nothingLeft) return noulAnswer(0.95);
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
      const candidate = findCandidate(question);
      if (candidate !== null) {
        const mentions = candidate['mentionsInTask'];
        const relevant = (typeof mentions === 'number' && mentions > 0) || candidate['touchedThisRun'] === true;
        return noulAnswer(relevant ? 0.9 : 0.15);
      }
      return noulAnswer(0.5);
    }
  }
}

/**
 * TUI-DESIGN-2 §3.13: the intake request (an `intake` Choice over the five readings) is answered from the message heuristics —
 * `intake` at p 0.9 on the kind (`coding_task` keeps 0.05 when another reading wins, so the run floor is never met by accident),
 * `can_<kind>` 0.9 / others 0.1, `reply` from the catalogue key, `about_*` and `file_*` from their regexes. `forced` is
 * `MockDeciderOptions.intake` / `JEVCODE_MOCK_INTAKE`.
 */
function intakeAnswers(state: Json, questions: Record<string, Question>, forced: IntakeKind | null): Partial<Record<string, Answer>> {
  const intakeQ = questions['intake'];
  const message = messageOf(state);
  const out: Partial<Record<string, Answer>> = {};
  if (intakeQ === undefined || intakeQ.type !== 'choice') {
    // the lookup's context Nouls (§3.6) arrive in their own request
    for (const [id, q] of Object.entries(questions)) if (id.startsWith('file_') && q.type === 'noul') out[id] = noulAnswer(mockFileProbability(q, message));
    return out;
  }
  const kind = forced ?? mockIntakeKind(message);
  out['intake'] = choiceAnswer(intakeQ, { [kind]: 0.9, ...(kind === 'coding_task' ? {} : { coding_task: 0.05 }) });
  for (const id of Object.keys(questions)) if (id.startsWith('can_')) out[id] = noulAnswer(id === `can_${kind}` ? 0.9 : 0.1);
  const replyQ = questions['reply'];
  if (replyQ !== undefined && replyQ.type === 'choice') out['reply'] = choiceAnswer(replyQ, { [mockReplyKey(message, conversationTurns(state))]: 1 });
  for (const id of Object.keys(questions)) if (id.startsWith('about_')) out[id] = noulAnswer(mockFactProbability(id.slice('about_'.length), message));
  return out;
}

/** Answers for every question not covered by a rule: Choices first so paired Nouls can see them. */
export function defaultAnswers(state: Json, questions: Record<string, Question>, given: Partial<Record<string, Answer>>, opts: { intake?: IntakeKind | null } = {}): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  const chosen = new Set<string>();
  // §3.13: the intake heuristics fill what no rule answered (a scripted rule keeps precedence)
  const heuristics = intakeAnswers(state, questions, opts.intake ?? null);
  const answered = (id: string): Answer | undefined => given[id] ?? (Object.hasOwn(questions, id) ? heuristics[id] : undefined);
  for (const [id, q] of Object.entries(questions)) {
    const g = answered(id);
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
  // one candidate finder per request, not one full scan per question (see `candidateFinder`)
  const findCandidate = candidateFinder(state);
  for (const [id, q] of Object.entries(questions)) {
    if (out[id] !== undefined) continue;
    out[id] = q.type === 'score' ? defaultScore(q, state) : defaultNoul(id, q, state, chosen, findCandidate);
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
  // TUI-DESIGN-2 §3.13: `JEVCODE_MOCK_JEV_MS` delays the mock (the latency probe) and `JEVCODE_MOCK_INTAKE` forces the intake reading;
  // an explicit option wins over the variable
  const env = opts.env ?? process.env;
  const envLatency = mockJevLatencyMs(env);
  const latencyMs = opts.latencyMs !== undefined ? (Number.isFinite(opts.latencyMs) ? Math.max(0, opts.latencyMs) : 0) : envLatency;
  const forcedIntake: IntakeKind | null = opts.intake ?? mockIntakeOverride(env);
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
    const answers = defaultAnswers(state, questions, given, { intake: forcedIntake });

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
      // contract 1.2 (§6 item 5): the mock always sends `cost`; the fallback keeps the optional wire field honest
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, costUsd: response.usage.cost ?? response.usage.input_tokens * JEV_INPUT_USD_PER_TOKEN, calls: 1 },
      latencyMs,
      model: response.model,
      requestHash,
      attempts,
      id: response.id ?? null,
    };
  }

  // TUI-DESIGN-2 §6 item 7: the mock stands in for today's OpenRouter path ('openrouter')
  return { model, provider: 'openrouter', ask };
}
