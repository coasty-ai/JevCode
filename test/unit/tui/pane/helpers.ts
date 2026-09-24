/** Shared fixtures for the O4 tests: the F-G/F-J review request, step 7's decisions and the frame-exact builders for F-B/F-D/F-J/F-Y (TUI-DESIGN §2.3 frames). */
import type { ConfirmRequest, Decision, DecisionVerdict, Plan, RiskDimensionResult, StageName } from '../../../../src/core/types.js';
import { mkConfirmRequest, mkDecision } from '../../../fixtures/tui/fixtures.js';
import { foldStageEnd, foldStepEnd, toDecisionRow, type PaneState, type PlanView, type TimelineStep } from '../../../../src/tui/pane/model.js';

export function dim(level: number, risk: number, probability: number, expected: number, tailMass: number, bound: 'expected' | 'tail', confidence: number): RiskDimensionResult {
  return { level, risk, probability, expected, tailMass, bound, confidence };
}

/** The F-G request: step 7, `edit src/a.py "make parse_date timezone-aware"`, plan_mismatch L2 0.44 tail dominant, matches_intent 0.88, jev 244 ms. */
export function workedRequest(over: Partial<ConfirmRequest> = {}): ConfirmRequest {
  const base = mkConfirmRequest('c1', 7, { kind: 'edit', path: 'src/a.py', old: 'return datetime.strptime(s, FMT)\n', new: 'return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)\n' });
  return {
    ...base,
    proposal: { ...base.proposal, goal: 'make parse_date timezone-aware' },
    risk: {
      dims: {
        destructive: dim(1, 0.25, 0.9, 0.25, 0, 'expected', 0.93),
        out_of_scope: dim(0, 0, 1, 0, 0, 'tail', 0.98),
        plan_mismatch: dim(2, 0.44, 0.61, 0.35, 0.44, 'tail', 0.61),
        irreversible: dim(0, 0, 0.95, 0.01, 0, 'expected', 0.96),
      },
      risk: 0.44,
      verdict: 'review',
      reason: 'plan_mismatch: 0.44 probability of level 3 or above',
    },
    matchesIntent: 0.88,
    jevLatencyMs: 244,
    ...over,
  };
}

export const PLAN_MISMATCH_LEVELS = [
  'matches `intent` and the plan',
  'matches the plan, different order',
  'skips a planned verification step',
  "ignores the plan's open problems, or claims completion…",
  'contradicts the plan, repeats a step `recent` shows…',
];

/** Step 7's decisions in stage order: the §7.6 worked plan_mismatch Score (0.62/0.24/0.10/0.04/0.00), an intent Choice with its paired Nouls, a near-threshold context Noul, matches_intent and task_complete. */
export function stepSevenDecisions(): Decision[] {
  const paired = (id: string, p: number, verdict?: Decision['verdict']): Decision =>
    mkDecision({
      step: 7,
      stage: 'intent',
      id,
      question: { type: 'noul', instructions: `Is ${id.slice(4)} the step that moves the task forward now?`, criteria: { true: { definition: `${id.slice(4)} is what plan.remaining calls for`, examples: ['tests still fail on the first remaining item'] }, false: { definition: `${id.slice(4)} would repeat work or skip a prerequisite`, examples: [] } } },
      answer: { type: 'noul', noul: p },
      probability: p,
      confidence: Math.abs(2 * p - 1),
      latencyMs: 231,
      requestHash: 'a1b2c3d4e5f6',
      ...(verdict ? { verdict } : {}),
    });
  return [
    mkDecision({
      step: 7,
      stage: 'intent',
      id: 'intent',
      question: { type: 'choice', instructions: 'Which kind of step comes next?', criteria: { investigate: 'look before changing', edit: 'change source', verify: 'run tests', fix_environment: 'repair tooling', finish: 'propose done', none_of_these: null } },
      answer: { type: 'choice', choice: 'edit', probabilities: { investigate: 0.2, edit: 0.64, verify: 0.1, fix_environment: 0.02, finish: 0.02, none_of_these: 0.02 }, confidence: 0.55 },
      probability: 0.64,
      confidence: 0.55,
      verdict: 'chosen',
      latencyMs: 231,
      requestHash: 'a1b2c3d4e5f6',
    }),
    paired('can_edit', 0.81),
    paired('can_verify', 0.31),
    mkDecision({ step: 7, stage: 'context', id: 'tests/test_a.py', question: { type: 'noul', instructions: 'Should the engineer be shown the file?' }, answer: { type: 'noul', noul: 0.52 }, probability: 0.52, confidence: 0.04, latencyMs: 198, requestHash: 'c0ffee00c0ffee' }),
    mkDecision({
      step: 7,
      stage: 'risk',
      id: 'plan_mismatch',
      question: { type: 'score', instructions: 'How far is `proposal.action` from `plan` and `intent`?', criteria: PLAN_MISMATCH_LEVELS },
      answer: { type: 'score', score: 0, legend: {}, probabilities: { '0': 0.62, '1': 0.24, '2': 0.1, '3': 0.04, '4': 0 }, confidence: 0.53 },
      probability: 0.62,
      confidence: 0.53,
      verdict: 'ok',
      latencyMs: 244,
      requestHash: 'a1b2c3d4ffff',
      servedModel: 'typesafe/jev-1.13-20260917',
    }),
    mkDecision({ step: 7, stage: 'risk', id: 'matches_intent', question: { type: 'noul', instructions: 'Does the action carry out the intent?', criteria: { true: 'an instance of the intent', false: 'not an instance' } }, answer: { type: 'noul', noul: 0.88 }, probability: 0.88, confidence: 0.76, latencyMs: 244, requestHash: 'a1b2c3d4ffff' }),
    mkDecision({ step: 7, stage: 'complete', id: 'task_complete', question: { type: 'noul', instructions: 'Is the task complete?', criteria: { true: 'implemented and verified', false: 'untested' } }, answer: { type: 'noul', noul: 0.68 }, probability: 0.68, confidence: 0.36, latencyMs: 198, requestHash: 'deadbeef0000' }),
  ];
}

/** The F-K / F-Z plan: two accepted items, `update CHANGELOG` unverified at s7 as the step's second claim (`done_1`), two `[ ]`, a replan and a rejected claim. */
export function planFixture(): Plan {
  return {
    done: [
      { text: 'add failing test for parse_date', evidence: { step: 4, judged: 0.91 } },
      { text: 'fix parse_date tz handling', evidence: { step: 6, judged: 0.78 } },
    ],
    remaining: ['update CHANGELOG', 'run full suite', 'remove debug print in utils.py'],
    unverified: [{ text: 'update CHANGELOG', step: 7, judged: 0.52 }],
    openProblems: ['test_parse_offsets is flaky'],
    harnessProblems: [
      { kind: 'replan', step: 6, text: 'change_approach: try tz-aware parsing instead of string ops' },
      { kind: 'rejected_claim', step: 5, text: '"tests pass" done_0 0.12' },
    ],
  };
}

/** The claims judged per step in `done_<j>` order behind `planFixture()` (what `step:end.record.judge.doneClaims` carried): `update CHANGELOG` is s7's second claim, so the ledger prints `done_1` (F-K). */
export function planClaims(): Map<number, readonly string[]> {
  return new Map<number, readonly string[]>([
    [4, ['add failing test for parse_date']],
    [5, ['tests pass']],
    [6, ['fix parse_date tz handling']],
    [7, ['fix parse_date tz handling', 'update CHANGELOG']],
  ]);
}

/** The F-K / F-Z plan view: the plan, the s4 and s6 parsed test counts (`evidence tests 41p/0f/0e`) and the claims. */
export function planViewFixture(): PlanView {
  return {
    step: 7,
    plan: planFixture(),
    testsByStep: new Map([
      [4, { passed: 41, failed: 0, errors: 0 }],
      [6, { passed: 41, failed: 0, errors: 0 }],
    ]),
    claimsByStep: planClaims(),
  };
}

interface RowSpec {
  step: number;
  stage: StageName;
  id: string;
  /** 'noul' | `L<k>` | a choice name */
  label: string;
  p: number;
  c: number;
  latencyMs: number;
  verdict?: DecisionVerdict;
}

/** One frame row as a `Decision`: a Noul (`c` = |2p−1| in the frames), a Score `L<k>` (its level carries `p`, a whisper of mass on the neighbour so harm dimensions bound on `expected`) or a Choice (`chosen`). */
export function frameDecision(r: RowSpec): Decision {
  const base = { step: r.step, stage: r.stage, id: r.id, probability: r.p, confidence: r.c, latencyMs: r.latencyMs, requestHash: 'a1b2c3d4e5f6', ...(r.verdict ? { verdict: r.verdict } : {}) };
  if (r.label === 'noul') return mkDecision({ ...base, question: { type: 'noul', instructions: 'q' }, answer: { type: 'noul', noul: r.p } });
  const level = /^L(\d)$/.exec(r.label);
  if (level) {
    const k = Number(level[1]);
    const rest = Math.max(0, 1 - r.p);
    const probs: Record<string, number> = { [String(k)]: r.p };
    if (rest > 0) probs[String(k === 0 ? 1 : k - 1)] = rest;
    return mkDecision({ ...base, question: { type: 'score', instructions: 'q', criteria: ['l0', 'l1', 'l2', 'l3', 'l4'] }, answer: { type: 'score', score: k, legend: {}, probabilities: probs, confidence: r.c } });
  }
  return mkDecision({ ...base, question: { type: 'choice', instructions: 'q', criteria: { [r.label]: 'x', none_of_these: null } }, answer: { type: 'choice', choice: r.label, probabilities: { [r.label]: r.p }, confidence: r.c }, verdict: r.verdict ?? 'chosen' });
}

/** F-B / F-P / F-AA: the twelve step-7 rows exactly as the frames print them (80 columns). */
export function frameBDecisions(): Decision[] {
  const rows: RowSpec[] = [
    { step: 7, stage: 'intent', id: 'intent', label: 'edit', p: 0.64, c: 0.55, latencyMs: 231, verdict: 'chosen' },
    { step: 7, stage: 'intent', id: 'can_edit', label: 'noul', p: 0.81, c: 0.62, latencyMs: 231 },
    { step: 7, stage: 'intent', id: 'plan_still_valid', label: 'noul', p: 0.88, c: 0.76, latencyMs: 231 },
    { step: 7, stage: 'context', id: 'src/a.py', label: 'noul', p: 0.78, c: 0.56, latencyMs: 198 },
    { step: 7, stage: 'context', id: 'tests/test_a.py', label: 'noul', p: 0.52, c: 0.04, latencyMs: 198 },
    { step: 7, stage: 'risk', id: 'destructive', label: 'L1', p: 0.9, c: 0.93, latencyMs: 244, verdict: 'ok' },
    { step: 7, stage: 'risk', id: 'out_of_scope', label: 'L0', p: 1, c: 1, latencyMs: 244, verdict: 'ok' },
    { step: 7, stage: 'risk', id: 'plan_mismatch', label: 'L2', p: 0.44, c: 0.61, latencyMs: 244, verdict: 'review' },
    { step: 7, stage: 'risk', id: 'irreversible', label: 'L0', p: 0.95, c: 0.96, latencyMs: 244, verdict: 'ok' },
    { step: 7, stage: 'risk', id: 'matches_intent', label: 'noul', p: 0.95, c: 0.9, latencyMs: 244 },
    { step: 7, stage: 'judge', id: 'succeeded', label: 'noul', p: 0.89, c: 0.78, latencyMs: 198 },
    { step: 7, stage: 'complete', id: 'task_complete', label: 'noul', p: 0.68, c: 0.36, latencyMs: 198 },
  ];
  return rows.map(frameDecision);
}

/** F-G: the seven-row pane above the review box. */
export function frameGDecisions(): Decision[] {
  const rows: RowSpec[] = [
    { step: 7, stage: 'intent', id: 'intent', label: 'edit', p: 0.64, c: 0.55, latencyMs: 231, verdict: 'chosen' },
    { step: 7, stage: 'context', id: 'src/a.py', label: 'noul', p: 0.78, c: 0.56, latencyMs: 198 },
    { step: 7, stage: 'risk', id: 'destructive', label: 'L1', p: 0.9, c: 0.93, latencyMs: 244, verdict: 'ok' },
    { step: 7, stage: 'risk', id: 'out_of_scope', label: 'L0', p: 1, c: 1, latencyMs: 244, verdict: 'ok' },
    { step: 7, stage: 'risk', id: 'plan_mismatch', label: 'L2', p: 0.44, c: 0.61, latencyMs: 244, verdict: 'review' },
    { step: 7, stage: 'risk', id: 'irreversible', label: 'L0', p: 0.95, c: 0.96, latencyMs: 244, verdict: 'ok' },
    { step: 7, stage: 'risk', id: 'matches_intent', label: 'noul', p: 0.88, c: 0.76, latencyMs: 244 },
  ];
  return rows.map(frameDecision);
}

/** F-J: the twelve-row wide tab at 120 columns (latency and `consumedBy` columns). */
export function frameJDecisions(): Decision[] {
  const rows: RowSpec[] = [
    { step: 7, stage: 'intent', id: 'intent', label: 'edit', p: 0.64, c: 0.55, latencyMs: 231, verdict: 'chosen' },
    { step: 7, stage: 'intent', id: 'can_edit', label: 'noul', p: 0.81, c: 0.62, latencyMs: 231 },
    { step: 7, stage: 'intent', id: 'can_verify', label: 'noul', p: 0.31, c: 0.38, latencyMs: 231 },
    { step: 7, stage: 'intent', id: 'plan_still_valid', label: 'noul', p: 0.88, c: 0.76, latencyMs: 231 },
    { step: 7, stage: 'context', id: 'src/a.py', label: 'noul', p: 0.78, c: 0.56, latencyMs: 198 },
    { step: 7, stage: 'context', id: 'tests/test_a.py', label: 'noul', p: 0.52, c: 0.04, latencyMs: 198 },
    { step: 7, stage: 'context', id: 'src/utils.py', label: 'noul', p: 0.24, c: 0.52, latencyMs: 198 },
    { step: 7, stage: 'risk', id: 'destructive', label: 'L1', p: 0.9, c: 0.93, latencyMs: 244, verdict: 'ok' },
    { step: 7, stage: 'risk', id: 'out_of_scope', label: 'L0', p: 1, c: 1, latencyMs: 244, verdict: 'ok' },
    { step: 7, stage: 'risk', id: 'plan_mismatch', label: 'L2', p: 0.44, c: 0.61, latencyMs: 244, verdict: 'review' },
    { step: 7, stage: 'risk', id: 'irreversible', label: 'L0', p: 0.95, c: 0.96, latencyMs: 244, verdict: 'ok' },
    { step: 7, stage: 'risk', id: 'matches_intent', label: 'noul', p: 0.88, c: 0.76, latencyMs: 244 },
  ];
  return rows.map(frameDecision);
}

/** F-Y: the five-row wide tab at 120 columns over two steps. */
export function frameYDecisions(): Decision[] {
  const rows: RowSpec[] = [
    { step: 3, stage: 'intent', id: 'intent', label: 'edit', p: 0.64, c: 0.55, latencyMs: 231, verdict: 'chosen' },
    { step: 3, stage: 'intent', id: 'can_edit', label: 'noul', p: 0.81, c: 0.62, latencyMs: 231 },
    { step: 3, stage: 'intent', id: 'plan_still_valid', label: 'noul', p: 0.88, c: 0.76, latencyMs: 231 },
    { step: 2, stage: 'judge', id: 'succeeded', label: 'noul', p: 0.89, c: 0.78, latencyMs: 198 },
    { step: 2, stage: 'complete', id: 'task_complete', label: 'noul', p: 0.68, c: 0.36, latencyMs: 198 },
  ];
  return rows.map(frameDecision);
}

/** F-D: the twelve narrow left-half rows (steps 3 and 2). */
export function frameDDecisions(): Decision[] {
  const rows: RowSpec[] = [
    { step: 3, stage: 'intent', id: 'intent', label: 'edit', p: 0.64, c: 0.55, latencyMs: 231, verdict: 'chosen' },
    { step: 3, stage: 'intent', id: 'can_edit', label: 'noul', p: 0.81, c: 0.62, latencyMs: 231 },
    { step: 3, stage: 'intent', id: 'can_verify', label: 'noul', p: 0.31, c: 0.38, latencyMs: 231 },
    { step: 3, stage: 'intent', id: 'plan_still_valid', label: 'noul', p: 0.88, c: 0.76, latencyMs: 231 },
    { step: 3, stage: 'context', id: 'src/a.py', label: 'noul', p: 0.78, c: 0.56, latencyMs: 198 },
    { step: 3, stage: 'context', id: 'tests/test_a.py', label: 'noul', p: 0.61, c: 0.22, latencyMs: 198 },
    { step: 3, stage: 'context', id: 'src/utils.py', label: 'noul', p: 0.24, c: 0.52, latencyMs: 198 },
    { step: 2, stage: 'judge', id: 'succeeded', label: 'noul', p: 0.9, c: 0.8, latencyMs: 198 },
    { step: 2, stage: 'judge', id: 'error_present', label: 'noul', p: 0.05, c: 0.9, latencyMs: 198 },
    { step: 2, stage: 'judge', id: 'new_information', label: 'noul', p: 0.62, c: 0.24, latencyMs: 198 },
    { step: 2, stage: 'judge', id: 'done_0', label: 'noul', p: 0.78, c: 0.56, latencyMs: 198 },
    { step: 2, stage: 'complete', id: 'task_complete', label: 'noul', p: 0.44, c: 0.12, latencyMs: 198 },
  ];
  return rows.map(frameDecision);
}

/** F-D: the right-half plan (two accepted, `update CHANGELOG` unverified as s2's second claim, three `[ ]`, one replan). */
export function frameDPlanView(): PlanView {
  return {
    step: 3,
    plan: {
      done: [
        { text: 'add failing test for parse_date', evidence: { step: 1, judged: 0.91 } },
        { text: 'locate the tz handling in parse_date', evidence: { step: 2, judged: 0.88 } },
      ],
      remaining: ['update CHANGELOG', 'make parse_date timezone-aware', 'run full suite', 'remove debug print in utils.py'],
      unverified: [{ text: 'update CHANGELOG', step: 2, judged: 0.52 }],
      openProblems: [],
      harnessProblems: [{ kind: 'replan', step: 2, text: 'change_approach: try tz-aware parsing' }],
    },
    claimsByStep: new Map<number, readonly string[]>([
      [1, ['add failing test for parse_date']],
      [2, ['locate the tz handling in parse_date', 'update CHANGELOG']],
    ]),
  };
}

export function timelineFixture(): TimelineStep[] {
  let t: TimelineStep[] = [];
  const stages: [number, 'intent' | 'context' | 'propose' | 'risk' | 'execute' | 'judge', number][] = [
    [7, 'intent', 210],
    [7, 'context', 240],
    [7, 'propose', 6100],
    [7, 'risk', 230],
    [7, 'execute', 1200],
    [7, 'judge', 190],
    [6, 'intent', 200],
    [6, 'context', 220],
    [6, 'propose', 4900],
    [6, 'risk', 220],
    [6, 'execute', 1600],
    [6, 'judge', 180],
  ];
  for (const [step, stage, ms] of stages) t = foldStageEnd(t, { step, stage, ms });
  t = foldStepEnd(t, { step: 7, timing: { generatorMs: 6100, jevMs: 900, execMs: 1200, harnessMs: 31, totalMs: 8200 }, usage: { generator: { inputTokens: 5000, outputTokens: 400, costUsd: 0.032, calls: 1 }, jev: { inputTokens: 4000, outputTokens: 0, costUsd: 0.001, calls: 6 } } });
  t = foldStepEnd(t, { step: 6, timing: { generatorMs: 4900, jevMs: 800, execMs: 1600, harnessMs: 24, totalMs: 7400 }, usage: { generator: { inputTokens: 4800, outputTokens: 300, costUsd: 0.03, calls: 1 }, jev: { inputTokens: 3900, outputTokens: 0, costUsd: 0.001, calls: 6 } } });
  return t;
}

export function paneState(over: Partial<PaneState> = {}): PaneState {
  return {
    tab: 'd',
    step: 7,
    rows: stepSevenDecisions().map((d) => toDecisionRow(d, 0.85)),
    plan: planViewFixture(),
    timeline: timelineFixture(),
    synth: { step: 7, phase: 'verify', detail: 'tested 37/137 candidates at kth.py:12', candidates: 137, tested: 37 },
    mode: 'jev-on',
    ...over,
  };
}

/** Every string is ≤ `columns` cells (the columns contract of every line builder). */
export function widths(lines: readonly string[], cellWidth: (s: string) => number): number[] {
  return lines.map((l) => cellWidth(l));
}
