/**
 * The loop's router table under a FAILING decider (docs/LLM-LOOP-DESIGN.md §2.2 / §2.3, contract 1.9 "Fastlane").
 *
 * This file is what clause 3 of the Jev contract points at. Until contract 1.9 the five loop stages were
 * allow-listed in `scripts/jev-contract.mjs` and their fallbacks were asserted in prose in the allow-list `why`
 * and nowhere in code — so "a Jev outage is slower, never wrong" was a promise, not a property. Every routed
 * site now names a test here, and every test here drives the same outage: a decider that throws the 503 the
 * head-to-head actually recorded (`no healthy upstream`, which killed `sympy-17139`, `django-15128` and
 * `django-15315` in three dead runs).
 *
 * What each test asserts, in the same words the site's clause 3 uses:
 *   RL1 intent falls back to investigate when the decider throws
 *   RL2 context keeps the traceback frame when the decider throws
 *   RL4 judge outcome is the parsed counts when the decider throws
 *   RL5 completion is the engine's own run when the decider throws
 *   RL6 replan continues on the code directive when the decider throws
 *   RL3 risk yields the code verdict with jevUnavailable and riskSource 'code' when the decider throws
 * plus I3 (`routerWaitMs === 0` per routed site), I4 (a late answer is dropped), I5 (three consecutive failures
 * do not end a run) and I2's half of the switch: with `routers` off every stage throws exactly as it did before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Answer, Decision, EngineEvent, JsonObject, Proposal, Question, StageName } from '../../../src/core/types.js';
import { AbortError, BudgetError, JevHttpError, JevModelDriftError } from '../../../src/errors.js';
import { QuestionBuildError } from '../../../src/jev/questions.js';
import type { StageContext } from '../../../src/loop/engine.js';
import { createLoopDetector } from '../../../src/loop/loopdetect.js';
import { emptyPlan } from '../../../src/loop/plan.js';
import { buildCommonState, type ExecutedInfo } from '../../../src/loop/state.js';
import { RL2_CONTEXT_DEADLINE_MS, commitStepRouters, noteStepRoute, resetStepRouters, routersOn, stepTokenFor } from '../../../src/loop/routers.js';
import type { RouteResult } from '../../../src/jev/router.js';
import { INTENT_FALLBACK, codeIntentOrder, runIntentStage } from '../../../src/loop/stages/intent.js';
import { CONTEXT_MAX_CANDIDATES, buildContextQuestions, runContextStage, selectCandidatesCode } from '../../../src/loop/stages/context.js';
import { runJudgeStage } from '../../../src/loop/stages/judge.js';
import { completionDecision, type CompletionFactInput } from '../../../src/loop/stages/complete.js';
import { REPLAN_FALLBACK, runReplanStage } from '../../../src/loop/stages/replan.js';
import { codeRiskFloor, codeRiskVerdict, escalateVerdict, runRiskStage } from '../../../src/loop/stages/risk.js';
import { DEFAULT_LIMITS, choiceOver, createFakeSandbox, createFakeWorkspace, execResult, makeEngine, noulA, passingTests, scoreA, turn, type FakeWorkspace, type Harness } from './fakes.js';

/** the outage the head-to-head recorded */
const OUTAGE = (): Promise<never> => Promise.reject(new JevHttpError('no healthy upstream', { status: 503, retryable: true }));

type AskImpl = (stage: StageName, questions: Record<string, Question>) => Promise<Record<string, Answer>>;

interface CtxOptions {
  ask: AskImpl;
  mode?: StageContext['mode'];
  step?: number;
  events?: EngineEvent[];
  asked?: StageName[];
  /** every Decision row the engine would have recorded, AFTER the stage's annotate callback ran (or did not) */
  rows?: Decision[];
  /** RL2: the files this run has already touched — they are members of the code order whatever Jev answers */
  changedFiles?: readonly string[];
  workspace?: FakeWorkspace;
}

function stageCtx(o: CtxOptions): StageContext {
  const events = o.events ?? [];
  const step = o.step ?? 1;
  return {
    runId: 'r-router',
    step,
    mode: o.mode ?? 'jev-on',
    task: 'fix the failing test',
    limits: DEFAULT_LIMITS,
    signal: new AbortController().signal,
    redact: (s) => s,
    generation: { temperature: null, maxTokens: 1500 },
    workspace: o.workspace ?? createFakeWorkspace(),
    sandbox: createFakeSandbox(),
    workspaceInfo: { root: '/ws', git: true, hasTests: true, testCommand: { command: 'pytest -q', runner: 'pytest' } },
    changedFiles: o.changedFiles ?? [],
    createdThisRun: new Set<string>(),
    patchTargets: [],
    now: () => 0,
    wallRemainingMs: () => 1_000_000,
    emit: (e) => events.push(e),
    async ask(stage, _state, questions: Record<string, Question>, annotate) {
      o.asked?.push(stage);
      const answers = await o.ask(stage, questions);
      const rows: Decision[] = Object.keys(questions).map((id) => ({ step, stage, id, question: questions[id]!, answer: answers[id] ?? noulA(0), probability: 0.8, confidence: 0.9, latencyMs: 1, requestHash: 'h' }));
      annotate?.(answers, rows);
      o.rows?.push(...rows);
      return { answers, rows, latencyMs: 1 };
    },
    generate: () => Promise.reject(new Error('no generator on this path')),
    noteMalformed: () => undefined,
    startCandidateRefresh: () => undefined,
  };
}

const common = (): JsonObject =>
  buildCommonState({
    task: 'fix the failing test',
    plan: emptyPlan(),
    recent: [],
    workspace: { root: '/ws', git: true, hasTests: true, testCommand: 'pytest -q', changedFiles: [], createdThisRun: [], lastChangeStep: null, lastTestRun: null, sandbox: 'none' },
    budget: { stepsUsed: 0, stepsMax: 40, spentUsd: 0, capUsd: 2 },
    redact: (x) => x,
  });

const runProposal = (command: string): Proposal => ({ goal: 'run the suite', action: { kind: 'run', command }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' });

function executed(over: Partial<ExecutedInfo> = {}): ExecutedInfo {
  return {
    outcome: { status: 'executed', exec: execResult({ exitCode: 1 }), summary: 'ran', changedFiles: [] },
    output: '1 failed, 1 passed',
    changedFiles: [],
    tests: { command: 'pytest -q', parsed: { passed: 1, failed: 1, errors: 0, skipped: 0 }, allPassed: false },
    ...over,
  };
}

const TRIPPED = (): ReturnType<typeof createLoopDetector> =>
  createLoopDetector({ counts: {}, lastSignature: 'run:aaaaaaaaaaaa:bbbbbbbbbbbb', tripped: true, replanCount: 0, tripsBySignature: { 'run:aaaaaaaaaaaa:bbbbbbbbbbbb': { trips: 3, directives: [] } } });

describe('the router table with a decider that throws (routers: on)', () => {
  beforeEach(() => {
    process.env['JEVCODE_ROUTERS'] = 'on';
    resetStepRouters();
  });
  afterEach(() => {
    delete process.env['JEVCODE_ROUTERS'];
    resetStepRouters();
  });

  it('intent falls back to investigate when the decider throws', async () => {
    const ctx = stageCtx({ ask: OUTAGE });
    const r = await runIntentStage(ctx, common());
    expect(r.intent).toBe(INTENT_FALLBACK);
    expect(r.answer).toBe('none_of_these');
    expect(r.planStillValid).toBe(1);
    // the code order is the step: investigate leads, and `verify` leads instead when a change is unverified —
    // one fact, the only one the function reads (review 2026-09-22 defect 8: the unread `runGreen` is gone)
    expect(codeIntentOrder({ changeUnverified: false })).toEqual(['investigate', 'verify', 'edit', 'fix_environment', 'finish']);
    expect(codeIntentOrder({ changeUnverified: true })).toEqual(['verify', 'investigate', 'edit', 'fix_environment', 'finish']);
  });

  /**
   * F27 (finishing pass) — RL2, the LAST loop ask that could still end a `jev-on-next` run through a Jev outage.
   * Slot B converted RL1, RL4, RL5 and RL6 and left the context stage inline, so I1 ("Jev routes, never gates")
   * was not true end to end: a 503 at `stages/context.ts` rejected the stage and the run died there.
   */
  it('context keeps the traceback frame when the decider throws', async () => {
    const intent = { intent: 'investigate' as const, answer: 'investigate' as const, probability: 0.9 };
    const ctx = stageCtx({ ask: OUTAGE, step: 41, changedFiles: ['src/a.py'] });
    const r = await runContextStage(ctx, common(), intent);
    // the code order is the step: the file this run already touched leads, and nothing was withheld by the outage
    expect(r.files.map((f) => f.path)).toEqual(['src/a.py', 'tests/test_a.py']);
    expect(r.candidates).toBe(2);
    expect(r.bytes).toBeGreaterThan(0);
    // and the outage is a ROW, not a throw: issued 1, applied 0, dropped 1, and I3's measured wait is 0
    const ledger = commitStepRouters('r-router', 41);
    expect(ledger).toMatchObject({ issued: 1, applied: 0, dropped: 1, waitMs: 0 });
    expect(ledger?.rows[0]).toMatchObject({ id: 'RL2', source: 'code', dropped: true });
  });

  it('RL2: an answer that lands in time still selects, exactly as the inline ask did', async () => {
    const intent = { intent: 'investigate' as const, answer: 'investigate' as const, probability: 0.9 };
    const ctx = stageCtx({
      step: 42,
      ask: async (_stage, questions) => {
        const out: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) out[id] = noulA(id === 'show:tests/test_a.py' ? 0.95 : 0.05);
        return out;
      },
    });
    const r = await runContextStage(ctx, common(), intent);
    expect(r.files.map((f) => f.path)).toEqual(['tests/test_a.py']);
    expect(commitStepRouters('r-router', 42)).toMatchObject({ issued: 1, applied: 1, dropped: 0, waitMs: 0 });
  });

  it('RL2 I3: a 500 ms ask is held for the 400 ms deadline and the code selection stands', async () => {
    const intent = { intent: 'investigate' as const, answer: 'investigate' as const, probability: 0.9 };
    const ctx = stageCtx({
      step: 43,
      changedFiles: ['tests/test_a.py'],
      ask: async (_stage, questions) => {
        await new Promise((r) => setTimeout(r, 500));
        const out: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) out[id] = noulA(0.95);
        return out;
      },
    });
    const t0 = Date.now();
    const r = await runContextStage(ctx, common(), intent);
    const wall = Date.now() - t0;
    expect(wall).toBeLessThan(490);
    expect(wall).toBeGreaterThanOrEqual(300);
    // the touched file leads the code order, which is the whole of "changed files are always members"
    expect(r.files.map((f) => f.path)).toEqual(['tests/test_a.py', 'src/a.py']);
    const ledger = commitStepRouters('r-router', 43);
    expect(ledger).toMatchObject({ issued: 1, applied: 0, dropped: 1, waitMs: 0 });
  });

  it('RL2 I4: an answer landing after the step committed is dropped and selects nothing', async () => {
    const intent = { intent: 'investigate' as const, answer: 'investigate' as const, probability: 0.9 };
    const ctx = stageCtx({
      step: 44,
      ask: async (_stage, questions) => {
        await new Promise((r) => setTimeout(r, 30));
        const out: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) out[id] = noulA(id === 'show:tests/test_a.py' ? 0.95 : 0.05);
        return out;
      },
    });
    const pending = runContextStage(ctx, common(), intent);
    commitStepRouters('r-router', 44);
    const r = await pending;
    // the code order, not Jev's single file: the answer arrived for a step that no longer exists
    expect(r.files.map((f) => f.path)).toEqual(['src/a.py', 'tests/test_a.py']);
  });

  /**
   * Review defect **A7**, the half that is reachable without a live Jev. RL2 carries the LARGEST question batch
   * on the loop — one Noul per candidate, up to `CONTEXT_MAX_CANDIDATES` (300) — against a deadline
   * (`RL2_CONTEXT_DEADLINE_MS`, 400 ms) justified by a p50/p95 measured over the loop's asks IN GENERAL, none of
   * which is a 300-Noul batch. If that batch is routinely slower than the deadline, `jev-on-next` does not gain
   * a route at RL2: it silently LOSES Jev context selection and runs `selectCandidatesCode` every step.
   *
   * What can be fixed offline is the word "silently". The per-route drop REASON now rides the ledger row, so the
   * measurement the review asks for — "measure the context batch's own latency on a jev-on-next task before the
   * arm is run" — is a read of that arm's own `steps.jsonl` rather than a new experiment: `drop: 'deadline'` on
   * every RL2 row says the deadline is the binding constraint and must be resized; `drop: 'error'` says Jev was
   * down; no `drop` at all says the answer was applied. Sizing the constant itself still needs the measurement.
   */
  it('RL2 A7: the drop REASON is recorded, so a deadline-bound arm is visible in its own run directory', async () => {
    const intent = { intent: 'investigate' as const, answer: 'investigate' as const, probability: 0.9 };
    // the deadline, on the batch the site really sends
    const slow = stageCtx({
      step: 45,
      ask: async (_stage, questions) => {
        await new Promise((r) => setTimeout(r, RL2_CONTEXT_DEADLINE_MS + 120));
        const out: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) out[id] = noulA(0.95);
        return out;
      },
    });
    await runContextStage(slow, common(), intent);
    expect(commitStepRouters('r-router', 45)?.rows[0]).toMatchObject({ id: 'RL2', dropped: true, drop: 'deadline' });

    // an outage is a DIFFERENT reason, and a reader must be able to tell them apart — one says "resize the
    // deadline", the other says "Jev was down"; before this they were the same `dropped: true`
    const down = stageCtx({ ask: OUTAGE, step: 46 });
    await runContextStage(down, common(), intent);
    expect(commitStepRouters('r-router', 46)?.rows[0]).toMatchObject({ id: 'RL2', dropped: true, drop: 'error' });

    // and an applied answer carries no reason at all, so the member is absent on the row it cannot describe
    const fast = stageCtx({
      step: 47,
      ask: (_stage, questions) => {
        const out: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) out[id] = noulA(id === 'show:tests/test_a.py' ? 0.95 : 0.05);
        return Promise.resolve(out);
      },
    });
    await runContextStage(fast, common(), intent);
    const applied = commitStepRouters('r-router', 47)?.rows[0];
    expect(applied).toMatchObject({ id: 'RL2', dropped: false });
    expect(applied?.drop).toBeUndefined();
  });

  /**
   * A7's other half, as a fact rather than a worry: RL2's batch really is the loop's largest, so the generic
   * per-site deadline is being applied to the one site it was never measured on. `CONTEXT_MAX_CANDIDATES` Nouls
   * against RL1/RL4/RL6's single Choice.
   */
  it('RL2 A7: the batch is one Noul per candidate, up to CONTEXT_MAX_CANDIDATES — the largest ask on the loop', () => {
    const views = Array.from({ length: CONTEXT_MAX_CANDIDATES + 40 }, (_, i) => ({ path: `src/f${i}.py`, bytes: 100, mentionsInTask: 0, touchedThisRun: false }));
    const questions = buildContextQuestions(views.slice(0, CONTEXT_MAX_CANDIDATES), 'investigate');
    expect(Object.keys(questions)).toHaveLength(CONTEXT_MAX_CANDIDATES);
    for (const q of Object.values(questions)) expect(q.type).toBe('noul');
  });

  it('RL2 the code order: touched first, then mentions, then path, under the 12-file / 60 KB caps', () => {
    const view = (path: string, over: { bytes?: number; mentionsInTask?: number; touchedThisRun?: boolean } = {}) => ({ path, bytes: over.bytes ?? 100, mentionsInTask: over.mentionsInTask ?? 0, touchedThisRun: over.touchedThisRun ?? false });
    const order = selectCandidatesCode([view('c.py', { mentionsInTask: 2 }), view('a.py'), view('b.py', { touchedThisRun: true }), view('d.py', { mentionsInTask: 2 })]);
    expect(order.map((v) => v.path)).toEqual(['b.py', 'c.py', 'd.py', 'a.py']);
    // the caps are the code's and Jev cannot lift them: 20 candidates in, 12 out
    const many = Array.from({ length: 20 }, (_, i) => view(`f${String(i).padStart(2, '0')}.py`));
    expect(selectCandidatesCode(many)).toHaveLength(12);
  });

  it('judge outcome is the parsed counts when the decider throws', async () => {
    const ctx = stageCtx({ ask: OUTAGE });
    const r = await runJudgeStage(ctx, common(), runProposal('pytest -q'), executed(), []);
    // 1 failed of 2: the code comparison says the step did not succeed, and it says so without Jev
    expect(r.judge).toMatchObject({ succeeded: 0, source: 'code', tests: { source: 'parsed', passed: 1, failed: 1, errors: 0 } });
    // completion is NOT answered — `null`, which no stop rule can read as complete
    expect(r.completion).toBeNull();
  });

  it('judge: a green parsed run is judged by the code counts even when Jev answers (RL4 is recorded-only)', async () => {
    const ctx = stageCtx({
      ask: async (_stage, questions) => {
        const out: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) out[id] = noulA(0.99);
        return out;
      },
    });
    const green = executed({ output: '2 passed', tests: { command: 'pytest -q', parsed: { passed: 2, failed: 0, errors: 0, skipped: 0 }, allPassed: true }, outcome: { status: 'executed', exec: execResult({ exitCode: 0 }), summary: 'ran', changedFiles: [] } });
    const r = await runJudgeStage(ctx, common(), runProposal('pytest -q'), green, []);
    expect(r.judge).toMatchObject({ succeeded: 1, source: 'code' });
    // Jev's own Noul is still recorded — the answer is data, not the verdict
    expect(r.completion).toBe(0.99);
  });

  it('completion is the engine\'s own run when the decider throws', async () => {
    const fact: CompletionFactInput = {
      action: 'run',
      outcome: 'executed',
      tests: { command: 'pytest -q', parsed: { passed: 2, failed: 0, errors: 0, skipped: 0 }, allPassed: true },
      testsCurrent: true,
      completion: { ledgerFixed: true, testsChanged: [], guardPending: false, repro: 'none', oracle: null, command: 'pytest -q' },
      testsPassUnparsed: null,
      verifiedDone: false,
    };
    // with no answer at all (a dropped Q22) the evidence-bearing step still completes, on the engine's own run
    expect(completionDecision({ routers: true, hasEvidence: true, completion: null, threshold: 0.8, fact })).toEqual({ complete: true, source: 'code' });
    // and a Jev Noul of 1.00 cannot complete a step whose own run is red
    const red: CompletionFactInput = { ...fact, tests: { command: 'pytest -q', parsed: { passed: 1, failed: 1, errors: 0, skipped: 0 }, allPassed: false } };
    expect(completionDecision({ routers: true, hasEvidence: true, completion: 1, threshold: 0.8, fact: red })).toEqual({ complete: false, source: 'code' });
    // with routers off, or on a step with no evidence, the rule is exactly the pre-1.9 threshold rule
    expect(completionDecision({ routers: false, hasEvidence: true, completion: 1, threshold: 0.8, fact: red })).toEqual({ complete: true, source: 'jev' });
    expect(completionDecision({ routers: true, hasEvidence: false, completion: 0.5, threshold: 0.8, fact })).toEqual({ complete: false, source: 'jev' });
  });

  it('replan continues on the code directive when the decider throws', async () => {
    const events: EngineEvent[] = [];
    const ctx = stageCtx({ ask: OUTAGE, events });
    const r = await runReplanStage(ctx, common(), TRIPPED(), ['executed']);
    expect(r.kind).toBe('directive');
    expect(r.directive.move).toBe(REPLAN_FALLBACK);
    expect(events.some((e) => e.type === 'replan')).toBe(true);
  });

  it('replan: `stop_and_report` is recorded only — it can no longer end a run (§2.5 RL6)', async () => {
    const keys = ['change_approach', 'gather_context', 'fix_environment', 'revert_changes', 'stop_and_report', 'none_of_these'];
    const ctx = stageCtx({
      ask: async (_stage, questions) => {
        const out: Record<string, Answer> = { next_move: choiceOver(keys, 'stop_and_report', 0.9) };
        for (const id of Object.keys(questions)) {
          if (id.startsWith('can_')) out[id] = noulA(id === 'can_stop_and_report' ? 0.95 : 0.05);
          if (id === 'task_impossible') out[id] = noulA(0.99);
        }
        return out;
      },
    });
    const r = await runReplanStage(ctx, common(), TRIPPED(), ['executed']);
    expect(r.kind).toBe('directive');
    expect(r.directive.move).toBe(REPLAN_FALLBACK);
    // the answer is still in the record: the text names what Jev said and that it was recorded only
    expect(r.directive.text).toContain('stop_and_report');
    expect(r.directive.text).toContain('recorded only');
    expect(r.directive.taskImpossible).toBe(0.99);
  });

  it("risk yields the code verdict with jevUnavailable and riskSource 'code' when the decider throws", async () => {
    const ctx = stageCtx({ ask: OUTAGE });
    const intent = { intent: 'verify' as const, answer: 'verify' as const, probability: 1 };
    // the workspace test command: the ALLOW-list clears it, so an outage costs nothing at all
    const verification = await runRiskStage(ctx, common(), runProposal('pytest -q'), intent);
    expect(verification).toMatchObject({ riskSource: 'code', jevUnavailable: true });
    expect(verification.risk.verdict).toBe('ok');
    expect(verification.risk.reason).toContain('Jev unavailable, the code verdict stands');
    // an arbitrary `run` is not cleared by the allow-list: the code verdict is `review` — an ask, never an allow
    const arbitrary = await runRiskStage({ ...ctx, step: 2 }, common(), runProposal('pip install requests'), intent);
    expect(arbitrary.risk.verdict).toBe('review');
    expect(arbitrary).toMatchObject({ riskSource: 'code', jevUnavailable: true });
    // and a deny-listed command is reviewed on the deny-list's own reason, with no Jev answer at all
    const denied = await runRiskStage({ ...ctx, step: 3 }, common(), runProposal('rm -rf build/'), intent);
    expect(denied.risk.verdict).toBe('review');
    expect(denied.risk.reason).toContain('code deny-list');
  });

  it('§2.4: Jev may ESCALATE the code verdict and may never de-escalate it', async () => {
    const intent = { intent: 'verify' as const, answer: 'verify' as const, probability: 1 };
    // Jev at the top level of every Score (what src/jev/off.ts answers) escalates a code `ok` to `block`
    const escalating = stageCtx({
      ask: async (_stage, questions) => {
        const out: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) out[id] = id === 'matches_intent' ? noulA(1) : scoreA({ 4: 1 });
        return out;
      },
    });
    const escalated = await runRiskStage(escalating, common(), runProposal('pytest -q'), intent);
    expect(escalated.risk.verdict).toBe('block');
    expect(escalated).toMatchObject({ riskSource: 'jev', jevUnavailable: false });
    // Jev at level 0 cannot release a DENY-LISTED command: the floor holds it at review
    const permissive = stageCtx({
      ask: async (_stage, questions) => {
        const out: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) out[id] = id === 'matches_intent' ? noulA(1) : scoreA({ 0: 1 });
        return out;
      },
      step: 2,
    });
    const held = await runRiskStage(permissive, common(), runProposal('rm -rf build/'), intent);
    expect(held.risk.verdict).toBe('review');
    expect(held.risk.reason).toContain('the code floor raises');
    expect(held).toMatchObject({ riskSource: 'jev' });
    // and where no deny-list rule matches, an answered step is exactly the pre-1.9 step: Jev's verdict, unraised
    const ordinary = await runRiskStage({ ...permissive, step: 3 }, common(), runProposal('pip install requests'), intent);
    expect(ordinary.risk.verdict).toBe('ok');
    expect(ordinary.risk.reason).not.toContain('code floor');
    expect(escalateVerdict('review', 'ok')).toBe('review');
    expect(escalateVerdict('ok', 'block')).toBe('block');
    expect(escalateVerdict('block', 'ok')).toBe('block');
    // the two code halves: the deny-list floor, and the wider verdict used only when no answer arrived
    expect(codeRiskFloor(runProposal('rm -rf /')).verdict).toBe('review');
    expect(codeRiskFloor(runProposal('pip install requests')).verdict).toBe('ok');
    expect(codeRiskVerdict(runProposal('rm -rf /'), [], null, null).verdict).toBe('review');
    expect(codeRiskVerdict(runProposal('pytest -q'), [], { command: 'pytest -q', runner: 'pytest' }, null).verdict).toBe('ok');
    expect(codeRiskVerdict(runProposal('pip install requests'), [], null, null).verdict).toBe('review');
  });

  it('defect 5: the risk stage swallows an OUTAGE, never a stop — a pause, a budget, a drift and a bad batch all propagate', async () => {
    const intent = { intent: 'verify' as const, answer: 'verify' as const, probability: 1 };
    const fatals: readonly [string, unknown][] = [
      ['a human pause', new AbortError('human_pause')],
      ['a wall-time budget', new BudgetError('wall_time')],
      ['a served-model drift', new JevModelDriftError('jev-1.13', 'jev-1.12', { firstCall: false })],
      ['a malformed question batch', new QuestionBuildError('criteria.true.examples needs at least two examples')],
    ];
    let step = 40;
    for (const [, thrown] of fatals) {
      step += 1;
      const ctx = stageCtx({ step, ask: () => Promise.reject(thrown) });
      // `catch {}` turned every one of these into "Jev unavailable, the code verdict stands", and the engine then
      // walked into confirm() and takePreImages() on an already-aborted run before its own guard unwound it
      await expect(runRiskStage(ctx, common(), runProposal('pip install requests'), intent)).rejects.toBe(thrown);
    }
    // and Jev's OWN failure is still absorbed, with the code verdict and the audit trail
    const outage = stageCtx({ step: 50, ask: OUTAGE });
    const r = await runRiskStage(outage, common(), runProposal('pip install requests'), intent);
    expect(r).toMatchObject({ riskSource: 'code', jevUnavailable: true });
    expect(r.risk.verdict).toBe('review');
  });

  it('I3: every routed site reports waitMs 0, so the step-level routerWaitMs is 0', async () => {
    const ctx = stageCtx({ ask: OUTAGE, step: 11 });
    await runIntentStage(ctx, common());
    await runJudgeStage(ctx, common(), runProposal('pytest -q'), executed(), []);
    await runReplanStage(ctx, common(), TRIPPED(), ['executed']);
    const ledger = commitStepRouters('r-router', 11);
    expect(ledger).not.toBeNull();
    expect(ledger).toMatchObject({ issued: 3, applied: 0, dropped: 3, waitMs: 0 });
    expect(ledger?.rows.map((r) => r.id)).toEqual(['RL1', 'RL4', 'RL6']);
    for (const row of ledger?.rows ?? []) expect(row.appliedAt).toBeNull();
  });

  it('I3 against a SLOW decider: RL1 holds the step for its 250 ms deadline, not for the 500 ms ask', async () => {
    // review 2026-09-22 defect 7: `waitMs` used to be the type literal `0` written unconditionally, so the
    // assertion above held with every deadline and race mechanism deleted. Both numbers are measured now, and
    // this is the case that tells them apart: an ask the step would have waited 500 ms for inline.
    const slow = stageCtx({
      step: 12,
      ask: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { intent: choiceOver(['investigate', 'edit', 'verify', 'fix_environment', 'finish', 'none_of_these'], 'edit', 0.95), can_edit: noulA(0.95), can_investigate: noulA(0.05), can_verify: noulA(0.05), can_fix_environment: noulA(0.05), can_finish: noulA(0.05), plan_still_valid: noulA(0.9) };
      },
    });
    const t0 = Date.now();
    const r = await runIntentStage(slow, common());
    const wall = Date.now() - t0;
    // the stage returned on the code order at the deadline: the answer was never applied
    expect(r.intent).toBe(INTENT_FALLBACK);
    expect(wall).toBeLessThan(450);
    expect(wall).toBeGreaterThanOrEqual(200);
    const ledger = commitStepRouters('r-router', 12);
    expect(ledger).toMatchObject({ issued: 1, applied: 0, dropped: 1, waitMs: 0 });
    // heldMs is the measurement waitMs is derived from: ~250, bounded well below the ask it raced
    expect(ledger?.heldMs).toBeGreaterThanOrEqual(200);
    expect(ledger?.heldMs).toBeLessThan(450);
  });

  it('I4: a router answer landing after step commit is dropped, and the committed step cannot be resurrected', async () => {
    const slow = stageCtx({
      step: 21,
      ask: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { intent: choiceOver([...['investigate', 'edit', 'verify', 'fix_environment', 'finish'], 'none_of_these'], 'edit', 0.95), can_edit: noulA(0.95), can_investigate: noulA(0.05), can_verify: noulA(0.05), can_fix_environment: noulA(0.05), can_finish: noulA(0.05), plan_still_valid: noulA(0.9) };
      },
    });
    const pending = runIntentStage(slow, common());
    // the step commits while the ask is still in flight
    commitStepRouters('r-router', 21);
    const r = await pending;
    expect(r.intent).toBe(INTENT_FALLBACK);
    // review 2026-09-22 defect 6: `noteStepRoute` runs AFTER routeSpeculative resolves, and it used to re-create
    // the step's state — minting a FRESH VALID token for the step that had just committed, plus a ledger nobody
    // would ever commit. Step 21 is the same step number, not a fresh one: its token stays dead for good.
    expect(stepTokenFor('r-router', 21).valid).toBe(false);
    expect(commitStepRouters('r-router', 21)).toBeNull();
  });

  it('defect 6: a committed (runId, step) is closed — stepTokenFor and noteStepRoute cannot reopen it', () => {
    const late: RouteResult<string> = { order: ['code'], source: 'code', appliedAt: null, dropped: true, id: 'RL1', waitMs: 0, heldMs: 0, drop: 'committed' };
    expect(stepTokenFor('probe', 7).valid).toBe(true);
    const held = stepTokenFor('probe', 7);
    commitStepRouters('probe', 7);
    expect(held.valid).toBe(false);
    expect(stepTokenFor('probe', 7).valid).toBe(false);
    noteStepRoute('probe', 7, late);
    expect(commitStepRouters('probe', 7)).toBeNull();
    // a DIFFERENT step of the same run is untouched, and so is the same step number of a different run
    expect(stepTokenFor('probe', 8).valid).toBe(true);
    expect(stepTokenFor('probe-2', 7).valid).toBe(true);
  });

  it('defect 6: the live-step LRU closes what it evicts — an evicted step is superseded, not forgotten', () => {
    const evicted = stepTokenFor('lru', 1);
    stepTokenFor('lru', 2);
    stepTokenFor('lru', 3); // a third mint retires step 1
    expect(evicted.valid).toBe(false);
    expect(stepTokenFor('lru', 1).valid).toBe(false);
  });

  it('defect 2: a dropped ask is cancelled, and a cancelled answer annotates nothing', async () => {
    const answers = (): Record<string, Answer> => ({
      intent: choiceOver(['investigate', 'edit', 'verify', 'fix_environment', 'finish', 'none_of_these'], 'edit', 0.95),
      can_edit: noulA(0.95),
      can_investigate: noulA(0.05),
      can_verify: noulA(0.05),
      can_fix_environment: noulA(0.05),
      can_finish: noulA(0.05),
      plan_still_valid: noulA(0.9),
    });
    // the ask outlives its step: the router hands the thunk a signal, drops at commit, and aborts it
    const late: Decision[] = [];
    const slow = stageCtx({
      step: 31,
      rows: late,
      ask: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return answers();
      },
    });
    const pending = runIntentStage(slow, common());
    commitStepRouters('r-router', 31);
    expect(await pending).toMatchObject({ intent: INTENT_FALLBACK });
    // the continuation still ran (ctx.ask takes no per-call signal until the §7.5 engine seam), but the answer it
    // carries was DROPPED — so it annotates nothing: the row the engine records for a dropped answer must not say
    // Jev's option was chosen
    expect(late.find((d) => d.id === 'intent')?.verdict).toBeUndefined();

    // and an answer that lands in time annotates exactly as before
    const live: Decision[] = [];
    const fast = stageCtx({ step: 32, rows: live, ask: async () => answers() });
    expect(await runIntentStage(fast, common())).toMatchObject({ intent: 'edit', verdict: 'chosen' });
    expect(live.find((d) => d.id === 'intent')?.verdict).toBe('chosen');
  });

  it('defect 2: the judge stage drops the same way — a cancelled answer re-labels no row', async () => {
    const rows: Decision[] = [];
    const slow = stageCtx({
      step: 33,
      rows,
      ask: async (_stage, questions) => {
        await new Promise((r) => setTimeout(r, 30));
        const out: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) out[id] = noulA(0.99);
        return out;
      },
    });
    const pending = runJudgeStage(slow, common(), runProposal('pytest -q'), executed(), []);
    commitStepRouters('r-router', 33);
    expect((await pending).judge?.source).toBe('code');
    // annotate is what moves task_complete into the `complete` pane; a dropped answer moves nothing
    expect(rows.find((d) => d.id === 'task_complete')?.stage).toBe('judge');
  });

  it('I5: three consecutive Jev failures do not end a run — every stage returns a code answer and none throws', async () => {
    const asked: StageName[] = [];
    for (const step of [1, 2, 3]) {
      const ctx = stageCtx({ ask: OUTAGE, step, asked });
      const intent = await runIntentStage(ctx, common());
      const risk = await runRiskStage(ctx, common(), runProposal('pytest -q'), { intent: intent.intent, answer: 'none_of_these', probability: 0 });
      const judge = await runJudgeStage(ctx, common(), runProposal('pytest -q'), executed(), []);
      const replan = await runReplanStage(ctx, common(), TRIPPED(), ['executed']);
      expect(intent.intent).toBe(INTENT_FALLBACK);
      expect(risk.risk.verdict).toBe('ok');
      expect(judge.judge?.source).toBe('code');
      expect(replan.kind).toBe('directive');
    }
    expect(asked.length).toBe(12);
  });
});

describe('I2: with routers off every stage is the pre-1.9 stage', () => {
  beforeEach(() => {
    delete process.env['JEVCODE_ROUTERS'];
    resetStepRouters();
  });

  it('a throwing decider is a stage failure again — exactly what it was before contract 1.9', async () => {
    const ctx = stageCtx({ ask: OUTAGE });
    await expect(runIntentStage(ctx, common())).rejects.toThrow(/no healthy upstream/);
    await expect(runContextStage(ctx, common(), { intent: 'investigate', answer: 'investigate', probability: 0.9 })).rejects.toThrow(/no healthy upstream/);
    await expect(runJudgeStage(ctx, common(), runProposal('pytest -q'), executed(), [])).rejects.toThrow(/no healthy upstream/);
    await expect(runReplanStage(ctx, common(), TRIPPED(), ['executed'])).rejects.toThrow(/no healthy upstream/);
    await expect(runRiskStage(ctx, common(), runProposal('pytest -q'), { intent: 'verify', answer: 'verify', probability: 1 })).rejects.toThrow(/no healthy upstream/);
    expect(commitStepRouters('r-router', 1)).toBeNull();
  });

  it('RL2 with routers off: the answered selection is HEAD\'s, and no router key is opened', async () => {
    const ctx = stageCtx({
      step: 51,
      ask: async (_stage, questions) => {
        const out: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) out[id] = noulA(id === 'show:src/a.py' ? 0.9 : 0.2);
        return out;
      },
    });
    const r = await runContextStage(ctx, common(), { intent: 'investigate', answer: 'investigate', probability: 0.9 });
    expect(r.files.map((f) => f.path)).toEqual(['src/a.py']);
    // I2: a routers-off run must not close a (runId, step) key — that would disarm the next run reusing the id
    expect(commitStepRouters('r-router', 51)).toBeNull();
  });

  it('`stop_and_report` still ends the run, and the risk result carries no riskSource', async () => {
    const keys = ['change_approach', 'gather_context', 'fix_environment', 'revert_changes', 'stop_and_report', 'none_of_these'];
    const ctx = stageCtx({
      ask: async (_stage, questions) => {
        const out: Record<string, Answer> = { next_move: choiceOver(keys, 'stop_and_report', 0.9) };
        for (const id of Object.keys(questions)) {
          if (id.startsWith('can_')) out[id] = noulA(id === 'can_stop_and_report' ? 0.95 : 0.05);
          if (id === 'task_impossible') out[id] = noulA(0.05);
          if (id === 'matches_intent') out[id] = noulA(1);
          if (['destructive', 'irreversible', 'out_of_scope', 'plan_mismatch'].includes(id)) out[id] = scoreA({ 0: 1 });
        }
        return out;
      },
    });
    const r = await runReplanStage(ctx, common(), TRIPPED(), ['executed']);
    expect(r).toMatchObject({ kind: 'stop', reason: 'replan_stop' });
    const risk = await runRiskStage(ctx, common(), runProposal('pip install requests'), { intent: 'verify', answer: 'verify', probability: 1 });
    expect(risk.riskSource).toBeUndefined();
    expect(risk.jevUnavailable).toBeUndefined();
    expect(risk.risk.verdict).toBe('ok');
  });
});

describe('the switch is per MODE, not per process (review 2026-09-22, defects 3 and 4)', () => {
  beforeEach(() => {
    process.env['JEVCODE_ROUTERS'] = 'on';
    resetStepRouters();
  });
  afterEach(() => {
    delete process.env['JEVCODE_ROUTERS'];
    resetStepRouters();
  });

  it('routersOn is true for jev-on alone — the §8 head-to-head compares against the OTHER arms', () => {
    expect(routersOn('jev-on')).toBe(true);
    expect(routersOn('llm-jev')).toBe(false);
    expect(routersOn('jev-only')).toBe(false);
    expect(routersOn('jev-off')).toBe(false);
    // and the per-engine option is read where it is passed, still under the mode gate
    delete process.env['JEVCODE_ROUTERS'];
    expect(routersOn('jev-on', 'on')).toBe(true);
    expect(routersOn('llm-jev', 'on')).toBe(false);
    expect(routersOn('jev-on', 'off')).toBe(false);
    expect(routersOn('jev-on')).toBe(false);
  });

  for (const mode of ['llm-jev', 'jev-only', 'jev-off'] as const) {
    it(`${mode}: \`stop_and_report\` still ends the run with JEVCODE_ROUTERS=on in the process`, async () => {
      const keys = ['change_approach', 'gather_context', 'fix_environment', 'revert_changes', 'stop_and_report', 'none_of_these'];
      const ctx = stageCtx({
        mode,
        ask: async (_stage, questions) => {
          const out: Record<string, Answer> = { next_move: choiceOver(keys, 'stop_and_report', 0.9) };
          for (const id of Object.keys(questions)) {
            if (id.startsWith('can_')) out[id] = noulA(id === 'can_stop_and_report' ? 0.95 : 0.05);
            if (id === 'task_impossible') out[id] = noulA(0.05);
          }
          return out;
        },
      });
      const r = await runReplanStage(ctx, common(), TRIPPED(), ['executed']);
      // runReplanStage is the ONE replan site for every mode (engine.ts:3840 — unlike judge and risk it has no
      // per-mode variant), so a process-wide switch demoted the two Jev-decided run-enders in the arms the
      // head-to-head is meant to compare against.
      expect(r).toMatchObject({ kind: 'stop', reason: 'replan_stop' });
    });

    it(`${mode}: a throwing decider is a stage failure again — the routers are jev-on's`, async () => {
      const ctx = stageCtx({ ask: OUTAGE, mode });
      await expect(runIntentStage(ctx, common())).rejects.toThrow(/no healthy upstream/);
      expect(commitStepRouters('r-router', 1)).toBeNull();
    });
  }
});

/**
 * F27 end to end: the whole point of RL2. A Jev outage at the context stage must not be the end of a
 * `jev-on-next` run — `record.error` stays undefined, the step commits, the next step runs.
 */
describe('F27 end to end — a Jev outage at the context stage does not end the run', () => {
  const harnesses: Harness[] = [];
  afterEach(() => {
    for (const h of harnesses.splice(0)) h.cleanup();
    resetStepRouters();
  });

  it('routers on: the run survives a 503 at every context ask and the router row says `dropped`', async () => {
    const h: Harness = await makeEngine({
      mode: 'jev-on',
      turns: [turn({ kind: 'run', command: 'pytest -q' }, { remaining: ['keep going'] }), turn({ kind: 'done', summary: 'green' })],
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { failAt: [{ stage: 'context', status: 503 }] },
      limits: { maxSteps: 2 },
      engine: { routers: 'on' },
    });
    harnesses.push(h);
    const r = await h.engine.run();
    expect(r.steps).toBe(2);
    for (const rec of h.store.steps) expect(rec.error).toBeUndefined();
    // the first step really ran its command: the outage cost ordering quality and nothing else
    expect(h.store.steps[0]!.outcome?.status).toBe('executed');
    // the outage is recorded as a drop on the step that took it, and nothing was gated by it
    expect(h.store.steps[0]!.router).toMatchObject({ dropped: 1 });
    expect(h.store.steps[0]!.router?.rows.some((row) => row.id === 'RL2')).toBe(true);
    // the prompt still carried files: the code selection applied
    expect(h.of('context')[0]!.files.length).toBeGreaterThan(0);
  });

  it('routers off: the same 503 ends the run, exactly as it did before contract 1.9', async () => {
    const h: Harness = await makeEngine({
      mode: 'jev-on',
      turns: [turn({ kind: 'run', command: 'pytest -q' }, { remaining: ['keep going'] })],
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { failAt: [{ stage: 'context', status: 503 }] },
      limits: { maxSteps: 2 },
      engine: { routers: 'off' },
    });
    harnesses.push(h);
    const r = await h.engine.run();
    expect(r.steps).toBeGreaterThanOrEqual(1);
    expect(h.store.steps.some((rec) => rec.error !== undefined)).toBe(true);
    expect(h.store.steps.every((rec) => rec.router === undefined)).toBe(true);
  });
});
