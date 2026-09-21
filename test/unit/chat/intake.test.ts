/**
 * TUI-DESIGN-2 §3.2–3.3, §3.12 (S3, §8.1 row `test/unit/chat/intake.test.ts`): the question snapshot (every Choice has
 * `none_of_these`, every Choice option's criteria is `{ definition, examples ≥ 2 }`, every Noul has definition + ≥ 2 examples
 * on both sides, keys pass KEY_SHAPE), `llmAnswerAllowed`, `routeOf`, the state bounds, the `resolveIntake` table,
 * `chatKindAfterNo`, the `[measured]` harness budget (≤ 5 ms p95 over 1,000 builds) and the token estimate (< 3,000).
 */
import { describe, expect, it } from 'vitest';
import type { Answer, Decider, Question } from '../../../src/core/types.js';
import {
  CONVERSATION_TURNS,
  INTAKE_CHOICE_EXAMPLES,
  INTAKE_KINDS,
  INTAKE_NEAR_DELTA,
  INTAKE_OPTIONS,
  INTAKE_RUN_FLOOR,
  INTAKE_TOKENS_MEASURED,
  INTAKE_TOKENS_PER_CHAR,
  INTAKE_TOKEN_BUDGET,
  LLM_ANSWER_FLOOR,
  MENTIONS_MAX,
  MESSAGE_HEAD,
  MESSAGE_TAIL,
  PAIRED_TRUE_EXAMPLES,
  answersOfRows,
  buildAllIntakeQuestions,
  buildIntakeQuestions,
  buildIntakeState,
  chatKindAfterNo,
  decisionRows,
  estimateIntakeTokens,
  filesBucket,
  llmAnswerAllowed,
  probabilityOf,
  redactJson,
  resolutionForKind,
  resolveIntake,
  routeOf,
  routeOfKind,
  runIntake,
  testsFromCandidates,
  type IntakeResolution,
  type IntakeStateInput,
} from '../../../src/chat/intake.js';
import { harnessFacts, selectFacts } from '../../../src/chat/facts.js';
import { fillReply, pickReply, replyByKey } from '../../../src/chat/replies.js';
import { ESCAPE_KEY } from '../../../src/jev/questions.js';
import { JEV_TOKEN_OVERHEAD } from '../../../src/jev/types.js';
import { HEAD_TAIL_MARKER } from '../../../src/core/text.js';
import { keyedFixture } from './facts.test.js';

const KEY_SHAPE = /^[a-z][a-z0-9_]{1,63}$/;
const noul = (p: number): Answer => ({ type: 'noul', noul: p });
function choiceA(choice: string, probs: Record<string, number>): Answer {
  return { type: 'choice', choice, probabilities: probs, confidence: 0.8 };
}
/** the five-way intake answer with `chosen` at `p` and the rest of the mass spread over the others */
function intakeAnswer(chosen: string, p: number): Answer {
  const keys = [...INTAKE_KINDS, ESCAPE_KEY];
  const rest = (1 - p) / (keys.length - 1);
  return choiceA(chosen, Object.fromEntries(keys.map((k) => [k, k === chosen ? p : rest])));
}
function answersFor(chosen: string, p: number, paired: number, others = 0.1): Record<string, Answer> {
  const out: Record<string, Answer> = { intake: intakeAnswer(chosen, p) };
  for (const k of INTAKE_KINDS) out[`can_${k}`] = noul(k === chosen ? paired : others);
  return out;
}

const stateInput = (message: string): IntakeStateInput => ({
  message,
  conversation: [],
  workspace: { name: 'proj', git: true, hasTests: true, testRunner: 'pytest', files: 'some' },
  session: { mode: 'jev-only', runs: 0, lastRun: null, pendingMode: null },
  mentions: [],
});
const identity = (s: string): string => s;

describe('§3.3 group A — the intake Choice and its paired Nouls (REPORT rules 3 and 4)', () => {
  const questions = buildIntakeQuestions();

  it('the intake Choice carries the five readings with object criteria { definition, examples ≥ 2 } and the escape option', () => {
    const q = questions['intake'];
    expect(q?.type).toBe('choice');
    if (!q || q.type !== 'choice') return;
    expect(Object.keys(q.criteria)).toEqual([...INTAKE_KINDS, ESCAPE_KEY]);
    for (const k of INTAKE_KINDS) {
      const c = q.criteria[k];
      expect(c).toBeTypeOf('object');
      const side = c as { definition: string; examples: string[] };
      expect(side.definition.length).toBeGreaterThan(20);
      expect(side.examples.length).toBeGreaterThanOrEqual(2);
    }
    expect(q.criteria[ESCAPE_KEY]).toBeNull();
    expect(String(q.instructions)).toBe('What is the human asking of this coding-agent session in `message`, read with `conversation`, `workspace` and `session`?');
  });

  it('every reading has a paired Noul `can_<kind>` whose instructions quote the one-line description and whose criteria have ≥ 2 examples on both sides', () => {
    for (const k of INTAKE_KINDS) {
      const q = questions[`can_${k}`];
      expect(q?.type, k).toBe('noul');
      if (!q || q.type !== 'noul') continue;
      expect(String(q.instructions)).toContain(`\`${k}\` (${INTAKE_OPTIONS[k]})`);
      expect(q.criteria?.true).toBeDefined();
      const t = q.criteria?.true as { definition: string; examples: string[] };
      const f = q.criteria?.false as { definition: string; examples: string[] };
      expect(t.examples.length).toBeGreaterThanOrEqual(2);
      expect(f.examples.length).toBeGreaterThanOrEqual(2);
      expect(t.definition).not.toBe(f.definition);
    }
    expect(Object.keys(questions)).toHaveLength(1 + INTAKE_KINDS.length);
  });

  it('the whole request (groups A + B + C) has snake_case keys, an escape on every Choice and both-sided criteria on every Noul', () => {
    const all = buildAllIntakeQuestions(harnessFacts(keyedFixture()));
    expect(Object.keys(all)).toContain('reply');
    expect(Object.keys(all).filter((k) => k.startsWith('about_'))).toHaveLength(14);
    for (const [id, q] of Object.entries(all)) {
      expect(id, id).toMatch(KEY_SHAPE);
      if (q.type === 'choice') {
        expect(Object.keys(q.criteria), id).toContain(ESCAPE_KEY);
        for (const [k, c] of Object.entries(q.criteria)) {
          expect(k).toMatch(KEY_SHAPE);
          if (k === ESCAPE_KEY) continue;
          const side = c as { definition: string; examples: string[] };
          expect(side.definition.length, `${id}.${k}`).toBeGreaterThan(0);
          expect(side.examples.length, `${id}.${k}`).toBeGreaterThanOrEqual(2);
        }
      } else if (q.type === 'noul') {
        const t = q.criteria?.true as { definition: string; examples: string[] };
        const f = q.criteria?.false as { definition: string; examples: string[] };
        expect(t.examples.length, id).toBeGreaterThanOrEqual(2);
        expect(f.examples.length, id).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('§3.12 (finding 10): the estimator is calibrated to the wire — 0.31 tokens per request char from 4,249 live tokens over a 12,895-char request — and the request stays under a budget that bites (≈ 6 % headroom)', () => {
    expect(INTAKE_TOKENS_PER_CHAR).toBeCloseTo((INTAKE_TOKENS_MEASURED - JEV_TOKEN_OVERHEAD) / 12895, 2);
    const state = buildIntakeState(stateInput('where is the date parsing?'), identity);
    const all = buildAllIntakeQuestions(harnessFacts(keyedFixture()));
    const tokens = estimateIntakeTokens(state, all);
    expect(tokens).toBeLessThan(INTAKE_TOKEN_BUDGET);
    // the gate is close enough to fail when the request grows by two fact Nouls (≈ 140 tokens each), unlike the 3,000 budget the 0.196 estimator sailed under
    expect(tokens).toBeGreaterThan(INTAKE_TOKEN_BUDGET * 0.9);
    process.stdout.write(`[measured] intake request ≈ ${tokens} input tokens (budget ${INTAKE_TOKEN_BUDGET}; live ${INTAKE_TOKENS_MEASURED} before the Choice examples were trimmed)\n`);
  });

  it('finding 10: the intake Choice options carry the first two examples of the table, the paired Nouls all of them — every example still reaches Jev once', () => {
    const questions = buildIntakeQuestions();
    const q = questions['intake'];
    expect(q?.type).toBe('choice');
    if (!q || q.type !== 'choice') return;
    for (const k of INTAKE_KINDS) {
      expect((q.criteria[k] as { examples: string[] }).examples).toEqual(PAIRED_TRUE_EXAMPLES[k].slice(0, INTAKE_CHOICE_EXAMPLES));
      const paired = questions[`can_${k}`];
      expect(paired?.type).toBe('noul');
      if (paired?.type === 'noul') expect((paired.criteria?.true as { examples: string[] }).examples).toEqual([...PAIRED_TRUE_EXAMPLES[k]]);
    }
    expect(INTAKE_CHOICE_EXAMPLES).toBe(2);
  });

  it('answersOfRows keys the decision rows by id so /why intake can re-derive the reading', () => {
    const questions = buildAllIntakeQuestions(harnessFacts(keyedFixture()));
    const answers = answersFor('coding_task', 0.78, 0.9);
    const rows = decisionRows(questions, answers, 118, 'h1', 'jev-1.13.0', 'jev-1.13.0');
    expect(resolveIntake(answersOfRows(rows))).toMatchObject({ kind: 'coding_task', probability: 0.78 });
  });
});

describe('§3.2 the intake state — tiny, code-computed, redacted', () => {
  it('bounds the message (head 1,000 + marker + tail 200), the conversation (≤ 6 × 200 chars) and the mentions (≤ 5, back-ticked), and buckets counts', () => {
    const long = 'x'.repeat(5000);
    const conversation = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? ('you' as const) : ('jevcode' as const), text: `turn ${i} ${'y'.repeat(500)}`, at: 't' }));
    const s = buildIntakeState({ ...stateInput(long), conversation, mentions: ['a.py', 'b.py', 'c.py', 'd.py', 'e.py', 'f.py'], session: { mode: 'jev-on', runs: 3, lastRun: { task: 't'.repeat(300), stopReason: 'max_steps', steps: 7, testsAllPassed: false }, pendingMode: 'jev-only' } }, identity);
    const message = s['message'] as string;
    expect(message.length).toBe(MESSAGE_HEAD + MESSAGE_TAIL + HEAD_TAIL_MARKER(5000 - MESSAGE_HEAD - MESSAGE_TAIL).length);
    const conv = s['conversation'] as { role: string; text: string }[];
    expect(conv).toHaveLength(CONVERSATION_TURNS);
    expect(conv[0]?.text.startsWith('turn 4')).toBe(true);
    for (const t of conv) expect(t.text.length).toBeLessThanOrEqual(200);
    expect(s['mentions']).toEqual(['`a.py`', '`b.py`', '`c.py`', '`d.py`', '`e.py`'].slice(0, MENTIONS_MAX));
    const session = s['session'] as { runs: string; lastRun: { task: string; steps: number }; pendingMode: string };
    expect(session.runs).toBe('several');
    expect(session.lastRun.task.length).toBeLessThanOrEqual(120);
    expect(session.lastRun.steps).toBe(7);
    expect(session.pendingMode).toBe('jev-only');
    expect(s['workspace']).toEqual({ name: 'proj', git: true, hasTests: true, testRunner: 'pytest', files: 'some' });
  });

  it('passes every string through the redactor (message, conversation, workspace name, task, mentions); `redactJson` walks a caller-built state too', () => {
    const redact = (x: string): string => x.replaceAll('sk-secret', '[REDACTED]');
    const s = buildIntakeState({ ...stateInput('key sk-secret here'), conversation: [{ role: 'you', text: 'earlier sk-secret', at: 't' }], mentions: ['sk-secret.txt'], session: { mode: 'jev-only', runs: 1, lastRun: { task: 'use sk-secret', stopReason: 'complete', steps: 1, testsAllPassed: true }, pendingMode: null } }, redact);
    expect(JSON.stringify(s)).not.toContain('sk-secret');
    expect(JSON.stringify(redactJson({ a: ['sk-secret', { b: 'sk-secret' }] }, redact))).not.toContain('sk-secret');
  });

  it('filesBucket: none / few / some / many; testsFromCandidates reads the listing shape', () => {
    expect([filesBucket(0), filesBucket(5), filesBucket(19), filesBucket(20), filesBucket(499), filesBucket(500)]).toEqual(['none', 'few', 'few', 'some', 'some', 'many']);
    expect(testsFromCandidates(['README.md'])).toEqual({ hasTests: false, testRunner: null });
    expect(testsFromCandidates(['pyproject.toml', 'tests/test_dates.py', 'utils/dates.py'])).toEqual({ hasTests: true, testRunner: 'pytest' });
    expect(testsFromCandidates(['package.json', 'vitest.config.ts', 'src/a.test.ts'])).toEqual({ hasTests: true, testRunner: 'vitest' });
    expect(testsFromCandidates(['package.json', 'src/a.test.ts'])).toEqual({ hasTests: true, testRunner: 'npm' });
    expect(testsFromCandidates(['go.mod', 'a_test.go'])).toEqual({ hasTests: true, testRunner: 'go' });
    expect(testsFromCandidates(['spec/thing.rb', 'lib/thing.rb'])).toEqual({ hasTests: false, testRunner: null });
    expect(testsFromCandidates(['tests/fixtures/x.json'])).toEqual({ hasTests: true, testRunner: 'unknown' });
  });
});

describe('§3.3 resolveIntake — the run floor', () => {
  it('coding_task chosen at p 0.61 with its paired Noul ≥ 0.5 runs; 0.59 asks; `near` marks 0.57–0.63', () => {
    const run = resolveIntake(answersFor('coding_task', 0.61, 0.9));
    expect(run).toMatchObject({ kind: 'coding_task', verdict: 'chosen', probability: 0.61, pairedNoul: 0.9, near: true });
    expect(resolveIntake(answersFor('coding_task', 0.59, 0.9))).toMatchObject({ kind: 'ambiguous', verdict: 'chosen', probability: 0.59, near: true });
    expect(resolveIntake(answersFor('coding_task', 0.9, 0.9))).toMatchObject({ kind: 'coding_task', near: false });
    expect(resolveIntake(answersFor('coding_task', INTAKE_RUN_FLOOR - INTAKE_NEAR_DELTA - 0.01, 0.9)).near).toBe(false);
    expect(resolveIntake(answersFor('coding_task', INTAKE_RUN_FLOOR + INTAKE_NEAR_DELTA, 0.9)).near).toBe(true);
  });

  it('an overridden coding_task (its paired Noul < 0.5, another reading\'s ≥ 0.5) resolves to that reading; overridden onto coding_task asks', () => {
    const a = answersFor('coding_task', 0.7, 0.3);
    a['can_question_about_the_code'] = noul(0.8);
    expect(resolveIntake(a)).toMatchObject({ kind: 'question_about_the_code', verdict: 'overridden' });
    const b = answersFor('greeting_or_smalltalk', 0.7, 0.3);
    b['can_coding_task'] = noul(0.8);
    expect(resolveIntake(b)).toMatchObject({ kind: 'ambiguous', verdict: 'overridden' });
  });

  it('the escape option, a missing answer and a weak everything fall back to ambiguous', () => {
    expect(resolveIntake(answersFor(ESCAPE_KEY, 0.6, 0.9))).toMatchObject({ kind: 'ambiguous', verdict: 'fallback' });
    expect(resolveIntake({})).toMatchObject({ kind: 'ambiguous', verdict: 'fallback', probability: 0 });
    expect(resolveIntake(answersFor('coding_task', 0.9, 0.2))).toMatchObject({ kind: 'ambiguous', verdict: 'fallback' });
    expect(resolveIntake(answersFor('greeting_or_smalltalk', 0.9, 0.9))).toMatchObject({ kind: 'greeting_or_smalltalk', verdict: 'chosen' });
  });

  it('chatKindAfterNo takes the argmax of the three non-run readings from the answers in hand; ties and a missing answer go to question_about_this_tool', () => {
    expect(chatKindAfterNo({ answers: { intake: choiceA('ambiguous', { ambiguous: 0.4, coding_task: 0.3, question_about_the_code: 0.2, greeting_or_smalltalk: 0.05, question_about_this_tool: 0.05 }) } })).toBe('question_about_the_code');
    expect(chatKindAfterNo({ answers: { intake: choiceA('ambiguous', { ambiguous: 0.4, question_about_the_code: 0.2, greeting_or_smalltalk: 0.2, question_about_this_tool: 0.2 }) } })).toBe('question_about_this_tool');
    expect(chatKindAfterNo({ answers: { intake: choiceA('ambiguous', { ambiguous: 0.4, question_about_the_code: 0.25, greeting_or_smalltalk: 0.3, question_about_this_tool: 0.05 }) } })).toBe('greeting_or_smalltalk');
    expect(chatKindAfterNo({ answers: {} })).toBe('question_about_this_tool');
  });
});

describe('§3.3 the LLM floor and the routes', () => {
  const res = (kind: IntakeResolution['kind'], verdict: IntakeResolution['verdict'], p: number, paired: number): IntakeResolution => ({ kind, verdict, answer: kind, probability: p, pairedNoul: paired, near: false });

  it('llmAnswerAllowed: jev-only → false; chosen at 0.5 → true; fallback 0.7 with paired 0.4 → false; paired 0.6 → true; other kinds → false', () => {
    expect(llmAnswerAllowed(res('question_about_the_code', 'chosen', 0.9, 0.9), 'jev-only')).toBe(false);
    expect(llmAnswerAllowed(res('question_about_the_code', 'chosen', LLM_ANSWER_FLOOR, 0.4), 'jev-on')).toBe(true);
    expect(llmAnswerAllowed(res('question_about_the_code', 'fallback', 0.7, 0.4), 'jev-on')).toBe(false);
    expect(llmAnswerAllowed(res('question_about_the_code', 'fallback', 0.2, 0.6), 'jev-on')).toBe(true);
    expect(llmAnswerAllowed(res('greeting_or_smalltalk', 'chosen', 0.9, 0.9), 'jev-on')).toBe(false);
    expect(llmAnswerAllowed(res('question_about_the_code', 'chosen', 0.9, 0.9), 'jev-off')).toBe(true);
  });

  it('routeOf: coding_task → run · ambiguous → asked · greeting → reply · tool → facts · code → llm (allowed) or lookup', () => {
    expect(routeOf(res('coding_task', 'chosen', 0.9, 0.9), 'jev-only')).toBe('run');
    expect(routeOf(res('ambiguous', 'fallback', 0, 0), 'jev-only')).toBe('asked');
    expect(routeOf(res('greeting_or_smalltalk', 'chosen', 0.9, 0.9), 'jev-only')).toBe('reply');
    expect(routeOf(res('question_about_this_tool', 'chosen', 0.9, 0.9), 'jev-only')).toBe('facts');
    expect(routeOf(res('question_about_the_code', 'chosen', 0.9, 0.9), 'jev-only')).toBe('lookup');
    expect(routeOf(res('question_about_the_code', 'chosen', 0.9, 0.9), 'jev-on')).toBe('llm');
    expect(routeOf(res('question_about_the_code', 'chosen', 0.4, 0.4), 'jev-on')).toBe('lookup');
  });

  it('the `n` of the card reads the answered kind\'s own numbers (resolutionForKind), never the ambiguous option\'s', () => {
    const answers: Record<string, Answer> = { intake: choiceA('ambiguous', { ambiguous: 0.6, question_about_the_code: 0.3, coding_task: 0.1 }), can_ambiguous: noul(0.9), can_question_about_the_code: noul(0.4) };
    const intake = resolveIntake(answers);
    expect(intake.kind).toBe('ambiguous');
    const r = resolutionForKind({ intake, answers }, 'question_about_the_code');
    expect(r).toMatchObject({ kind: 'question_about_the_code', verdict: 'fallback', probability: 0.3, pairedNoul: 0.4 });
    expect(routeOfKind('question_about_the_code', { intake, answers }, 'jev-on')).toBe('lookup');
    answers['can_question_about_the_code'] = noul(0.7);
    expect(routeOfKind('question_about_the_code', { intake, answers }, 'jev-on')).toBe('llm');
    expect(routeOfKind('greeting_or_smalltalk', { intake, answers }, 'jev-on')).toBe('reply');
    expect(routeOfKind('question_about_this_tool', { intake, answers }, 'jev-on')).toBe('facts');
    // Jev's own reading keeps its verdict
    const own = resolveIntake(answersFor('question_about_the_code', 0.8, 0.9));
    expect(resolutionForKind({ intake: own, answers: answersFor('question_about_the_code', 0.8, 0.9) }, 'question_about_the_code')).toBe(own);
  });
});

describe('runIntake — one request, all three groups, Decision rows for the panel (§3.11)', () => {
  function fakeDecider(rule: (id: string, q: Question) => Answer): Decider & { calls: { stage: string; step: number; questions: number }[] } {
    const calls: { stage: string; step: number; questions: number }[] = [];
    return {
      model: 'jev-1.13.0',
      provider: 'typesafe',
      calls,
      async ask(_state, questions, o) {
        calls.push({ stage: o.stage, step: o.step, questions: Object.keys(questions).length });
        const answers: Record<string, Answer> = {};
        for (const [id, q] of Object.entries(questions)) answers[id] = rule(id, q);
        return { answers, usage: { inputTokens: 1500, outputTokens: 40, costUsd: 0.000063, calls: 1 }, latencyMs: 118, model: 'jev-1.13.0', requestHash: 'abc123def456', attempts: 1, id: null, costBasis: 'table' };
      },
    };
  }

  it('asks once at stage intent / step 0 with every group, resolves, and returns rows with the intake verdict annotated', async () => {
    const decider = fakeDecider((id, q) => {
      if (id === 'intake') return intakeAnswer('coding_task', 0.78);
      if (id === 'can_coding_task') return noul(0.9);
      if (q.type === 'choice') return choiceA('hello_first', { hello_first: 1 });
      return noul(0.1);
    });
    const facts = harnessFacts(keyedFixture());
    const r = await runIntake({ decider, state: buildIntakeState(stateInput('fix the failing test'), identity), facts, signal: new AbortController().signal, redact: identity });
    expect(decider.calls).toEqual([{ stage: 'intent', step: 0, questions: 1 + 5 + 1 + 14 }]);
    expect(r.intake).toMatchObject({ kind: 'coding_task', verdict: 'chosen', probability: 0.78 });
    expect(r).toMatchObject({ provider: 'typesafe', model: 'jev-1.13.0', latencyMs: 118, requestHash: 'abc123def456' });
    expect(r.usage.costUsd).toBeCloseTo(0.000063, 9);
    expect(r.rows).toHaveLength(21);
    for (const row of r.rows) expect(row).toMatchObject({ step: 0, stage: 'intent', latencyMs: 118, requestHash: 'abc123def456' });
    const intakeRow = r.rows.find((d) => d.id === 'intake');
    expect(intakeRow?.verdict).toBe('chosen');
    expect(intakeRow?.probability).toBeCloseTo(0.78, 9);
    expect(r.rows.map((d) => d.id)).toEqual(expect.arrayContaining(['can_coding_task', 'reply', 'about_mode_now']));
    // the same answers feed the reply catalogue and the facts without a second request
    expect(replyByKey(pickReply(r.answers).key).key).toBe('hello_first');
    expect(selectFacts(facts, r.answers)).toHaveLength(2);
  });

  it('probabilityOf: Nouls derive |2p − 1|; Choices carry the wire confidence; a served model that differs from the configured one is recorded', () => {
    expect(probabilityOf(noul(0.9))).toEqual({ probability: 0.9, confidence: expect.closeTo(0.8, 9) as number });
    expect(probabilityOf(choiceA('a', { a: 0.7, b: 0.3 }))).toEqual({ probability: 0.7, confidence: 0.8 });
    expect(probabilityOf({ type: 'score', score: 1.2, legend: {}, probabilities: { '0': 0.2, '1': 0.5, '2': 0.3 }, confidence: 0.4 })).toEqual({ probability: 0.5, confidence: 0.4 });
    const rows = decisionRows(buildIntakeQuestions(), answersFor('coding_task', 0.9, 0.9), 100, 'h', 'jev-1.13.0', 'jev-latest');
    expect(rows.every((d) => d.servedModel === 'jev-1.13.0')).toBe(true);
    expect(decisionRows(buildIntakeQuestions(), answersFor('coding_task', 0.9, 0.9), 100, 'h', 'jev-1.13.0', 'jev-1.13.0').every((d) => d.servedModel === undefined)).toBe(true);
  });

  it('[measured] §3.12: the harness work per intake excluding Jev (state + questions + resolution + reply/facts lines) stays ≤ 5 ms p95 over 1,000 builds', () => {
    const facts = harnessFacts(keyedFixture());
    const answers = answersFor('greeting_or_smalltalk', 0.9, 0.9);
    answers['reply'] = choiceA('hello_first', { hello_first: 1 });
    for (const f of facts) answers[`about_${f.key}`] = noul(0.1);
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now();
      const state = buildIntakeState(stateInput(`hi there ${i}`), identity);
      const qs = buildAllIntakeQuestions(facts);
      const res = resolveIntake(answers);
      const lines = res.kind === 'greeting_or_smalltalk' ? [fillReply(replyByKey(pickReply(answers).key), { dir: 'proj', lastRun: null, mode: 'jev-only', runsDir: '/tmp/runs' })] : selectFacts(facts, answers).map((f) => f.text);
      decisionRows(qs, answers, 1, 'h', 'm', 'm');
      if (Object.keys(state).length === 0 || lines.length === 0) throw new Error('unreachable');
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
    process.stdout.write(`[measured] intake harness work p50 ${p50.toFixed(3)} ms · p95 ${p95.toFixed(3)} ms over 1,000 builds (budget 5 ms p95)\n`);
    expect(p95).toBeLessThanOrEqual(5);
  });
});
