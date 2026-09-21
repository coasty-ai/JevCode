/**
 * The intake (TUI-DESIGN-2 §3.2–3.3, D-C): every non-command submission passes ONE Jev request — group A, the
 * `intake` Choice over five readings with its paired Nouls (REPORT rules 3 and 4: definition + examples on every
 * option and on both sides of every Noul, an escape option, a paired `can_<option>` Noul), plus group B (the reply
 * Choice, `replies.ts`) and group C (the fact Nouls, `facts.ts`) folded into the same request. `resolveIntake`
 * applies the run floor: only `coding_task` chosen by Jev at p ≥ 0.6 with its paired Noul ≥ 0.5 starts a paid run;
 * anything weaker asks (§3.7). No keyword list ever starts a run (§11). Pure, ink-free, no I/O beyond `decider.ask`.
 */
import type { Answer, Decider, Decision, EngineMode, IntakeKind, Json, JsonObject, JevProvider, Question, StopReason, TestRunner, TokenUsage } from '../core/types.js';
import { choice, pairedNouls, ref } from '../jev/questions.js';
import { JEV_TOKEN_OVERHEAD } from '../jev/types.js';
import { PAIRED_NOUL_FLOOR, annotateChoiceRows, resolveChoice, type ChoiceVerdict } from '../loop/stages/choose.js';
import { clip, headTail } from '../core/text.js';
import type { Fact } from './facts.js';
import { buildFactQuestions } from './facts.js';
import type { ChatTurn } from './ledger.js';
import { buildReplyQuestion } from './replies.js';

export type { IntakeKind } from '../core/types.js';

// ---------------------------------------------------------------------------------------
// §3.3 Group A — the five readings, verbatim
// ---------------------------------------------------------------------------------------

export const INTAKE_KINDS = ['greeting_or_smalltalk', 'question_about_this_tool', 'question_about_the_code', 'coding_task', 'ambiguous'] as const satisfies readonly IntakeKind[];

/** one-line descriptions — they feed only the paired-Noul instructions (§3.3) */
export const INTAKE_OPTIONS: Readonly<Record<IntakeKind, string>> = {
  greeting_or_smalltalk: 'a greeting, thanks, goodbye, a check that someone is there, or small talk that asks for no information and no work',
  question_about_this_tool: 'a question about JevCode itself: what it can do, its mode, its keys or cost, its commands, what the last run did, how to use it',
  question_about_the_code: 'a question about the code in `workspace` (what a file or function does, where something lives, why a test fails) that wants an explanation, not a change',
  coding_task: 'an instruction to change, create, fix, refactor, test, run, install or check something in `workspace`',
  ambiguous: 'the message reads both as a request for work and as a question or remark, and the difference decides whether a paid run starts',
};

/** the `true` column of §3.3's table */
export const PAIRED_TRUE: Readonly<Record<IntakeKind, string>> = {
  greeting_or_smalltalk: '`message` opens, closes or keeps up a conversation and would be complete with a one-line friendly answer',
  question_about_this_tool: '`message` asks about JevCode, Jev, the mode, keys, cost, commands, the sandbox or the last run, and is answered from the session\'s own facts',
  question_about_the_code: '`message` asks how the code in `workspace` works or where something is, and an explanation would satisfy it',
  coding_task: '`message` tells the agent to make or check a change in `workspace`; carrying it out means editing, creating, running or installing something',
  ambiguous: '`message` can be read as work or as a question and `conversation` does not settle it',
};
export const PAIRED_TRUE_EXAMPLES: Readonly<Record<IntakeKind, readonly string[]>> = {
  greeting_or_smalltalk: ['hi', 'thanks, that worked', 'you still there?', 'good morning'],
  question_about_this_tool: ['what can you do?', 'which mode is this?', 'how much has this cost?', 'did the last run pass?'],
  question_about_the_code: ['where is the date parsing?', 'why does test_parse_date fail?', 'what does utils/dates.py export?'],
  coding_task: ['fix the failing test in utils/dates.py', 'add a --dry-run flag', 'run the tests', 'also update the CHANGELOG'],
  ambiguous: ['the date parsing', 'tests?', 'parse_date is wrong'],
};
/** the `false` column of §3.3's table */
export const PAIRED_FALSE: Readonly<Record<IntakeKind, string>> = {
  greeting_or_smalltalk: '`message` names a file, a test, an error or a change, or asks what something does',
  question_about_this_tool: '`message` asks about the project\'s code or asks for work',
  question_about_the_code: '`message` asks for a change, or asks about JevCode rather than the project',
  coding_task: '`message` only asks a question, greets, or comments on a result',
  ambiguous: 'one reading is clearly meant',
};
export const PAIRED_FALSE_EXAMPLES: Readonly<Record<IntakeKind, readonly string[]>> = {
  greeting_or_smalltalk: ['hi, can you fix the failing test', 'thanks — now run the suite'],
  question_about_this_tool: ['what does parse_date do?', 'add a test for parse_date'],
  question_about_the_code: ['fix the date parsing', 'what mode are you in?'],
  coding_task: ['looks good', 'what did you change?'],
  ambiguous: ['fix parse_date', 'what does parse_date do?'],
};

export interface CriteriaSide {
  readonly definition: string;
  readonly examples: readonly string[];
}
/**
 * the Choice option carries the first two examples of the table's column; the paired Noul `can_<kind>` carries them all,
 * so every example still reaches Jev once (the request measured 4,249 input tokens live — the duplicate examples were the
 * cheapest cut that keeps REPORT rule 4's `examples ≥ 2` on the Choice)
 */
export const INTAKE_CHOICE_EXAMPLES = 2;
function intakeCriteria(): Record<IntakeKind, CriteriaSide> {
  const out: Partial<Record<IntakeKind, CriteriaSide>> = {};
  for (const k of INTAKE_KINDS) out[k] = { definition: PAIRED_TRUE[k], examples: PAIRED_TRUE_EXAMPLES[k].slice(0, INTAKE_CHOICE_EXAMPLES) };
  return out as Record<IntakeKind, CriteriaSide>;
}
/** REPORT rule 4 (docs/RESEARCH.md:318, accuracy 0.55 → 0.80): every Choice option's criteria is definition + examples — the table's `true` column, reused */
export const INTAKE_CRITERIA: Readonly<Record<IntakeKind, CriteriaSide>> = intakeCriteria();

/** a criteria side as wire JSON (`readonly string[]` is not a `Json[]`) */
export function criteriaJson(side: CriteriaSide): JsonObject {
  return { definition: side.definition, examples: [...side.examples] };
}

const INTAKE_INSTRUCTIONS = `What is the human asking of this coding-agent session in ${ref('message')}, read with ${ref('conversation')}, ${ref('workspace')} and ${ref('session')}?`;

/** group A: the `intake` Choice (object criteria per option) and its five paired Nouls `can_<option>` */
export function buildIntakeQuestions(): Record<string, Question> {
  const options: Record<string, Json | null> = Object.fromEntries(INTAKE_KINDS.map((k) => [k, criteriaJson(INTAKE_CRITERIA[k])]));
  return {
    intake: choice(INTAKE_INSTRUCTIONS, options),
    ...pairedNouls(INTAKE_OPTIONS, (option, desc) => ({
      instructions: `Is \`${option}\` (${desc}) the right reading of ${ref('message')} given ${ref('conversation')}?`,
      criteria: {
        true: { definition: PAIRED_TRUE[option as IntakeKind], examples: [...PAIRED_TRUE_EXAMPLES[option as IntakeKind]] },
        false: { definition: PAIRED_FALSE[option as IntakeKind], examples: [...PAIRED_FALSE_EXAMPLES[option as IntakeKind]] },
      },
    })),
  };
}

// ---------------------------------------------------------------------------------------
// §3.2 the intake state (tiny, code-computed, redacted)
// ---------------------------------------------------------------------------------------

export interface IntakeStateInput {
  /** ≤ 1,200 chars (head 1,000 + marker + tail 200 via headTail) */
  message: string;
  /** last ≤ 6 turns { role, text ≤ 200, kind? } */
  conversation: readonly ChatTurn[];
  workspace: { name: string; git: boolean; hasTests: boolean; testRunner: TestRunner | null; files: FilesBucket };
  session: { mode: EngineMode; runs: number; lastRun: { task: string; stopReason: StopReason; steps: number; testsAllPassed: boolean | null } | null; pendingMode: EngineMode | null };
  /** `@path` mentions, ≤ 5, paths only */
  mentions: readonly string[];
}
/** bucket words instead of counts (§3.2: "No counts Jev would have to compute") */
export type FilesBucket = 'none' | 'few' | 'some' | 'many';
export const MESSAGE_HEAD = 1000;
export const MESSAGE_TAIL = 200;
export const CONVERSATION_TURNS = 6;
export const CONVERSATION_TEXT_MAX = 200;
export const LAST_TASK_MAX = 120;
export const MENTIONS_MAX = 5;

/** 0 / < 20 / < 500 / ≥ 500 candidates */
export function filesBucket(count: number): FilesBucket {
  if (count <= 0) return 'none';
  if (count < 20) return 'few';
  if (count < 500) return 'some';
  return 'many';
}
function runsBucket(n: number): 'none' | 'one' | 'several' {
  return n <= 0 ? 'none' : n === 1 ? 'one' : 'several';
}

export function buildIntakeState(i: IntakeStateInput, redact: (s: string) => string): JsonObject {
  const conversation: Json[] = i.conversation.slice(-CONVERSATION_TURNS).map((t) => ({
    role: t.role,
    text: redact(clip(t.text, CONVERSATION_TEXT_MAX)),
    ...(t.kind !== undefined ? { kind: t.kind } : {}),
  }));
  const last = i.session.lastRun;
  return {
    message: redact(headTail(i.message, MESSAGE_HEAD, MESSAGE_TAIL)),
    conversation,
    workspace: { name: redact(i.workspace.name), git: i.workspace.git, hasTests: i.workspace.hasTests, testRunner: i.workspace.testRunner, files: i.workspace.files },
    session: {
      mode: i.session.mode,
      runs: runsBucket(i.session.runs),
      lastRun: last === null ? null : { task: redact(clip(last.task, LAST_TASK_MAX)), stopReason: last.stopReason, steps: last.steps, testsAllPassed: last.testsAllPassed },
      pendingMode: i.session.pendingMode,
    },
    mentions: i.mentions.slice(0, MENTIONS_MAX).map((p) => `\`${redact(p)}\``),
  };
}

// ---------------------------------------------------------------------------------------
// §3.3 resolution — the run floor, the LLM floor, the routes
// ---------------------------------------------------------------------------------------

/** a paid run needs Jev's own `coding_task` at p ≥ 0.6 and its paired Noul ≥ 0.5 (PAIRED_NOUL_FLOOR); anything weaker asks */
export const INTAKE_RUN_FLOOR = 0.6;
/** `near` marks a probability within this of the floor (the pane's `!` marker, NEAR_THRESHOLD_DELTA) */
export const INTAKE_NEAR_DELTA = 0.03;

export interface IntakeResolution {
  kind: IntakeKind;
  verdict: ChoiceVerdict;
  /** Jev's raw Choice answer (escape option included) */
  answer: string;
  probability: number;
  pairedNoul: number;
  near: boolean;
}

export function resolveIntake(answers: Record<string, Answer>): IntakeResolution {
  const r = resolveChoice<IntakeKind>({ choiceId: 'intake', answers, options: INTAKE_KINDS, escape: 'none_of_these', fallback: 'ambiguous' });
  const near = Math.abs(r.probability - INTAKE_RUN_FLOOR) <= INTAKE_NEAR_DELTA + 1e-9; // float-safe at the 0.57 / 0.63 edges
  const base = { verdict: r.verdict, answer: r.answer, probability: r.probability, pairedNoul: r.pairedNoul, near };
  if (r.option === 'coding_task' && (r.verdict !== 'chosen' || r.probability < INTAKE_RUN_FLOOR)) return { ...base, kind: 'ambiguous' };
  return { ...base, kind: r.option };
}

/** the readings that answer without a run */
export type ChatKind = Exclude<IntakeKind, 'coding_task' | 'ambiguous'>;
export const CHAT_KINDS: readonly ChatKind[] = ['greeting_or_smalltalk', 'question_about_this_tool', 'question_about_the_code'];

/** the `n` of the ambiguity card (§3.7): argmax of the three non-run readings from the answers in hand; ties → question_about_this_tool */
export function chatKindAfterNo(res: Pick<IntakeResult, 'answers'>): ChatKind {
  const a = res.answers['intake'];
  if (!a || a.type !== 'choice') return 'question_about_this_tool';
  let best: ChatKind = 'question_about_this_tool';
  let bestP = -1;
  for (const k of CHAT_KINDS) {
    const p = a.probabilities[k];
    const v = typeof p === 'number' && Number.isFinite(p) ? p : 0;
    if (v > bestP + 1e-12) {
      best = k;
      bestP = v;
    }
  }
  const top = CHAT_KINDS.filter((k) => Math.abs((a.probabilities[k] ?? 0) - bestP) <= 1e-12);
  return top.length > 1 && top.includes('question_about_this_tool') ? 'question_about_this_tool' : best;
}

/** the LLM path has a floor too (a paid generator turn is neither cheap nor reversible): chosen at p ≥ 0.5, or the paired Noul ≥ 0.5 */
export const LLM_ANSWER_FLOOR = 0.5;
export function llmAnswerAllowed(r: IntakeResolution, mode: EngineMode): boolean {
  return mode !== 'jev-only' && r.kind === 'question_about_the_code' && ((r.verdict === 'chosen' && r.probability >= LLM_ANSWER_FLOOR) || r.pairedNoul >= PAIRED_NOUL_FLOOR);
}

export type ChatRoute = 'run' | 'asked' | 'reply' | 'facts' | 'lookup' | 'llm';
/** coding_task → run · ambiguous → asked · greeting → reply · tool → facts · code → llmAnswerAllowed ? llm : lookup */
export function routeOf(r: IntakeResolution, mode: EngineMode): ChatRoute {
  switch (r.kind) {
    case 'coding_task':
      return 'run';
    case 'ambiguous':
      return 'asked';
    case 'greeting_or_smalltalk':
      return 'reply';
    case 'question_about_this_tool':
      return 'facts';
    case 'question_about_the_code':
      return llmAnswerAllowed(r, mode) ? 'llm' : 'lookup';
  }
}
/**
 * the resolution seen through one non-run reading: Jev's own reading keeps its verdict and probability; another kind (the `n` of
 * the card) reads its probability and paired Noul from the answers in hand with verdict `fallback` — so the LLM floor of
 * `llmAnswerAllowed` applies to the kind actually answered, never to the `ambiguous` option's numbers
 */
export function resolutionForKind(res: Pick<IntakeResult, 'intake' | 'answers'>, kind: ChatKind): IntakeResolution {
  if (res.intake.kind === kind) return res.intake;
  const a = res.answers['intake'];
  const p = a && a.type === 'choice' ? a.probabilities[kind] : undefined;
  const paired = res.answers[`can_${kind}`];
  return {
    kind,
    verdict: 'fallback',
    answer: res.intake.answer,
    probability: typeof p === 'number' && Number.isFinite(p) ? p : 0,
    pairedNoul: paired && paired.type === 'noul' ? paired.noul : 0,
    near: false,
  };
}

/** the route a non-run reading takes (the `n` of the card and the default branch of §3.8 `reply`) */
export function routeOfKind(kind: ChatKind, res: Pick<IntakeResult, 'intake' | 'answers'>, mode: EngineMode): Exclude<ChatRoute, 'run' | 'asked'> {
  if (kind === 'greeting_or_smalltalk') return 'reply';
  if (kind === 'question_about_this_tool') return 'facts';
  return llmAnswerAllowed(resolutionForKind(res, kind), mode) ? 'llm' : 'lookup';
}

// ---------------------------------------------------------------------------------------
// §3.2 workspace facts from the candidate listing (no I/O; the engine detects the runner for real at run time)
// ---------------------------------------------------------------------------------------

/** a coarse test-runner guess over the listing's paths: enough for the intake state's `hasTests` / `testRunner` */
export function testsFromCandidates(paths: readonly string[]): { hasTests: boolean; testRunner: TestRunner | null } {
  let runner: TestRunner | null = null;
  /** a manifest-only guess (`package.json`, `pyproject.toml`) yields to a runner-specific file seen later */
  let weak = false;
  let hasTests = false;
  for (const p of paths) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (/^(test_.*\.py|.*_test\.py|conftest\.py|.*\.(test|spec)\.[cm]?[jt]sx?|.*_test\.go)$/.test(base) || /^tests?\//.test(p) || /\/tests?\//.test(p)) hasTests = true;
    if (runner !== null && !weak) continue;
    if (base === 'pytest.ini' || base === 'conftest.py' || base === 'tox.ini' || /^test_.*\.py$/.test(base)) [runner, weak] = ['pytest', false];
    else if (base === 'manage.py') [runner, weak] = ['django', false];
    else if (/^vitest\.config\.[cm]?[jt]s$/.test(base)) [runner, weak] = ['vitest', false];
    else if (/^jest\.config\.[cm]?[jt]s$/.test(base)) [runner, weak] = ['jest', false];
    else if (base === 'Cargo.toml') [runner, weak] = ['cargo', false];
    else if (base === 'go.mod') [runner, weak] = ['go', false];
    else if (runner === null && base === 'package.json') [runner, weak] = ['npm', true];
    else if (runner === null && (base === 'pyproject.toml' || base === 'setup.py')) [runner, weak] = ['pytest', true];
  }
  if (hasTests && runner === null) runner = 'unknown';
  return { hasTests, testRunner: hasTests ? runner : null };
}

// ---------------------------------------------------------------------------------------
// §3.3 one request, all three groups — the controller's only entry point (§3.8)
// ---------------------------------------------------------------------------------------

export interface IntakeResult {
  intake: IntakeResolution;
  answers: Record<string, Answer>;
  /** core `Decision` rows, step 0, stage `intent` (the App maps them with `toDecisionRow`, §3.11) */
  rows: readonly Decision[];
  usage: TokenUsage;
  latencyMs: number;
  requestHash: string;
  provider: JevProvider;
  /** the served model id (`/jev`) */
  model: string;
}

export interface RunIntakeInput {
  decider: Decider;
  /** `buildIntakeState(...)` — already redacted; `redact` is applied once more here (defence in depth for a caller-built state) */
  state: JsonObject;
  facts: readonly Fact[];
  signal: AbortSignal;
  redact: (s: string) => string;
}

/** every question of the one request: groups A (intake + paired Nouls), B (reply) and C (fact Nouls) */
export function buildAllIntakeQuestions(facts: readonly Fact[]): Record<string, Question> {
  return { ...buildIntakeQuestions(), reply: buildReplyQuestion(), ...buildFactQuestions(facts) };
}

export async function runIntake(i: RunIntakeInput): Promise<IntakeResult> {
  const questions = buildAllIntakeQuestions(i.facts);
  const state = redactJson(i.state, i.redact);
  const r = await i.decider.ask(state, questions, { signal: i.signal, stage: 'intent', step: 0 });
  const intake = resolveIntake(r.answers);
  const rows = decisionRows(questions, r.answers, r.latencyMs, r.requestHash, r.model, i.decider.model);
  annotateChoiceRows(rows, 'intake', { option: intake.kind, verdict: intake.verdict, answer: intake.answer, probability: intake.probability, pairedNoul: intake.pairedNoul });
  return { intake, answers: r.answers, rows, usage: r.usage, latencyMs: r.latencyMs, requestHash: r.requestHash, provider: i.decider.provider, model: r.model };
}

/** §3.11: the intake's answers as `Decision` rows (step 0, stage `intent`; ids `intake`, `can_*`, `reply`, `about_*`) */
export function decisionRows(questions: Record<string, Question>, answers: Record<string, Answer>, latencyMs: number, requestHash: string, servedModel: string, configuredModel: string): Decision[] {
  const rows: Decision[] = [];
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (answer === undefined) continue;
    const { probability, confidence } = probabilityOf(answer);
    rows.push({ step: 0, stage: 'intent', id, question, answer, probability, confidence, latencyMs, requestHash, ...(servedModel !== configuredModel ? { servedModel } : {}) });
  }
  return rows;
}

/** P(chosen) and the harness confidence: Nouls derive |2p − 1|; Choices and Scores carry the wire confidence */
export function probabilityOf(a: Answer): { probability: number; confidence: number } {
  switch (a.type) {
    case 'noul':
      return { probability: a.noul, confidence: Math.abs(2 * a.noul - 1) };
    case 'choice': {
      const p = a.probabilities[a.choice];
      return { probability: typeof p === 'number' && Number.isFinite(p) ? p : 0, confidence: a.confidence };
    }
    case 'score': {
      let best = 0;
      for (const v of Object.values(a.probabilities)) if (v > best) best = v;
      return { probability: best, confidence: a.confidence };
    }
  }
}

/** every string of a JSON value through `redact` (the state builder already did; a caller-built state gets the same guarantee) */
export function redactJson<T extends Json>(v: T, redact: (s: string) => string): T {
  const walk = (x: Json): Json => {
    if (typeof x === 'string') return redact(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x !== null && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v) as T;
}

// ---------------------------------------------------------------------------------------
// §3.12 latency and token budget helpers (tested offline)
// ---------------------------------------------------------------------------------------

/**
 * tokens per request char on the wire, calibrated live on both providers (2026-09-21: 4,249 input tokens per message for a
 * 12,895-char request → (4,249 − 271) / 12,895 ≈ 0.31; REPORT §4's 0.196 undercounted the JSON-heavy request by 1.5×)
 */
export const INTAKE_TOKENS_PER_CHAR = 0.31;
/** the live figure the calibration rests on (typesafe and openrouter agreed to the token): the design's ≈ 1,650 was an estimate */
export const INTAKE_TOKENS_MEASURED = 4249;
/** the estimate over the request the intake sends: 271 fixed + `INTAKE_TOKENS_PER_CHAR` per request char */
export function estimateIntakeTokens(state: JsonObject, questions: Record<string, Question>): number {
  return JEV_TOKEN_OVERHEAD + Math.ceil(JSON.stringify({ state, questions }).length * INTAKE_TOKENS_PER_CHAR);
}
/** `intake.test.ts` (estimate) and `intake.live.test.ts` (wire) fail above this (§3.12): ≈ 6 % over the calibrated request, so one added fact Noul passes and two fail */
export const INTAKE_TOKEN_BUDGET = 4500;

/** the answers of a set of `Decision` rows (the intake's `s0` rows) keyed by id — `resolveIntake(answersOfRows(rows))` re-derives the reading (`/why intake`, §3.11) */
export function answersOfRows(rows: readonly Decision[]): Record<string, Answer> {
  return Object.fromEntries(rows.map((d) => [d.id, d.answer]));
}
