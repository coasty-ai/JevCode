/**
 * Out-of-sample iteration 2, change 9 (the repository regime of
 * `experiments/results/llm-jev-iter1.md` §4.2 and §5).
 *
 * The records. All four fresh SWE runs of `bench/results/iter1-fresh-llm-jev-swebench` end
 * `replan_stop` at step 5 of a 25-step budget. On `runs/20260922-120654-pwk7v3bn` the steps are:
 * 1 `patch` (executed, 5 candidates tested of 1,740 priced at the repository RANK site), 2 `run`
 * (the scoped pytest, executed), then 3, 4 and 5 the SAME `done` proposal — signature
 * `done:a38c40c21f99`, `outcome: "noop"`, `notes: ["done rejected: no passing, current run
 * verifies it"]`, `timing.synthMs` 0.28 ms. Three steps in which nothing ran, nothing was
 * proposed and nothing changed. The trip reaches the replan stage at step 6 and `next_move`
 * answers `stop_and_report` (p = 0.44 / 0.44 / 0.59 / 0.61 over the four runs), which ends the
 * run with 20 steps unspent, 1,735 priced candidates never run, and — `generator.jsonl` —
 * 0 samples served of 7 fired.
 *
 * `django__django-15128` (`bench/results/iter1-insample-llm-jev-swebench/runs/20260922-124457-mo7wd5un`)
 * is the same shape through the other door: steps 2–7 are one refused `done`
 * (`done:b8ee1f6c9667`), `next_move` answers `gather_context` twice (p = 0.39 then 0.98) and
 * engine.ts `repeatedGatherContextExit` turns the second one into `replan_stop` at 7 steps. It is
 * the only task the in-sample 28 lost against the frozen `066816f` reference.
 *
 * The rule under test: a `done:` signature is a completion claim the harness ITSELF refused (an
 * accepted one ends the run), so its repetition is evidence about the proposer/completion
 * handshake, not about the search being spent — and the search has exactly one rung above where
 * it stands (`PHASE_ESCALATION`). So the first trip that would END the run on such a signature
 * escalates onto that rung instead, and only once the rung has been directed for this very
 * signature is the stop the honest end. No constant, no threshold, no task name.
 */
import { describe, expect, it } from 'vitest';
import type { Answer, Decision, EngineEvent, JsonObject, Question, StageName } from '../../../../src/core/types.js';
import type { StageContext } from '../../../../src/loop/engine.js';
import { createLoopDetector } from '../../../../src/loop/loopdetect.js';
import { PHASE_ESCALATION, doneClaimEscalation, escalationDirectiveText, runReplanStage } from '../../../../src/jev-modes/stages/replan.js';
import { DEFAULT_LIMITS, choiceOver, createFakeSandbox, createFakeWorkspace, noulA } from '../../loop/fakes.js';

/** `done:a38c40c21f99` — the signature steps 3, 4 and 5 of 20260922-120654-pwk7v3bn all carry */
const DONE_SIG = 'done:a38c40c21f99';
/** `run:8819467523e1:8b08b4fd13a6` — step 1 of 20260922-124457-mo7wd5un, an executed command */
const RUN_SIG = 'run:8819467523e1:8b08b4fd13a6';
const REPLAN_KEYS = ['change_approach', 'gather_context', 'fix_environment', 'revert_changes', 'stop_and_report', 'none_of_these'];

const GATHERED = (step: number): { step: number; directive: string } => ({
  step,
  directive: `After repeating the same done proposal 3 times, Jev directs \`gather_context\` (p=0.39, task_impossible=0.00): read or search the code and its tests before acting again.`,
});
const ESCALATED = (step: number): { step: number; directive: string } => ({ step, directive: escalationDirectiveText(0.44, DONE_SIG, [step - 3]) });

function stageCtx(opts: { mode: StageContext['mode']; events: EngineEvent[]; move: string }): StageContext {
  return {
    runId: 'r-oos2',
    step: 6,
    mode: opts.mode,
    task: 'Add transaction handling to Changelist list_editable processing.',
    limits: DEFAULT_LIMITS,
    signal: new AbortController().signal,
    redact: (s) => s,
    generation: { temperature: null, maxTokens: 1500 },
    workspace: createFakeWorkspace(),
    sandbox: createFakeSandbox(),
    workspaceInfo: { root: '/ws', git: true, hasTests: true, testCommand: { command: 'pytest -q', runner: 'pytest' } },
    changedFiles: [],
    createdThisRun: new Set<string>(),
    patchTargets: [],
    now: () => 0,
    wallRemainingMs: () => 1_000_000,
    emit: (e) => opts.events.push(e),
    async ask(stage: StageName, _state: JsonObject, questions: Record<string, Question>, annotate) {
      const answers: Record<string, Answer> = { next_move: choiceOver(REPLAN_KEYS, opts.move, 0.44) };
      for (const id of Object.keys(questions)) {
        if (id.startsWith('can_')) answers[id] = noulA(id === `can_${opts.move}` ? 0.52 : 0.16);
        if (id === 'task_impossible') answers[id] = noulA(0.05);
      }
      const rows: Decision[] = Object.keys(questions).map((id) => ({ step: 6, stage, id, question: questions[id]!, answer: answers[id] ?? noulA(0), probability: 0.44, confidence: 0.32, latencyMs: 1, requestHash: 'h' }));
      annotate?.(answers, rows);
      return { answers, rows, latencyMs: 1 };
    },
    generate: () => Promise.reject(new Error('the replan stage never generates')),
    noteMalformed: () => undefined,
    startCandidateRefresh: () => undefined,
  };
}

function trippedOn(sig: string, directives: readonly { step: number; directive: string }[]): ReturnType<typeof createLoopDetector> {
  return createLoopDetector({
    counts: {},
    lastSignature: sig,
    tripped: true,
    replanCount: directives.length,
    tripsBySignature: { [sig]: { trips: directives.length + 1, directives: directives.map((d) => ({ ...d })) } },
  });
}

describe('change 9: a refused completion claim does not end the run before the search rung is climbed', () => {
  it('20260922-120654-pwk7v3bn: `stop_and_report` on the first trip of a `done:` signature escalates the search phase instead', () => {
    expect(doneClaimEscalation({ signature: DONE_SIG, move: 'stop_and_report', priorDirectives: [] })).toEqual({ kind: 'escalate' });
  });

  it('20260922-124457-mo7wd5un: a directive already given once for this `done:` signature escalates too (the engine`s repeatedGatherContextExit door)', () => {
    expect(doneClaimEscalation({ signature: DONE_SIG, move: 'gather_context', priorDirectives: [GATHERED(5)] })).toEqual({ kind: 'escalate' });
  });

  it('with the rung already directed for this signature the stop is the honest end, with a named reason', () => {
    const r = doneClaimEscalation({ signature: DONE_SIG, move: 'stop_and_report', priorDirectives: [ESCALATED(6)] });
    expect(r?.kind).toBe('stop');
    if (r?.kind === 'stop') {
      expect(r.reason).toContain(DONE_SIG);
      expect(r.reason).toContain(PHASE_ESCALATION);
    }
  });

  it('the rule fires on nothing else: a `run:` signature, a first trip whose move neither stops nor repeats', () => {
    expect(doneClaimEscalation({ signature: RUN_SIG, move: 'stop_and_report', priorDirectives: [] })).toBeNull();
    expect(doneClaimEscalation({ signature: DONE_SIG, move: 'gather_context', priorDirectives: [] })).toBeNull();
    expect(doneClaimEscalation({ signature: DONE_SIG, move: 'change_approach', priorDirectives: [GATHERED(5)] })).toBeNull();
  });

  it('through the stage: the four fresh SWE runs get the escalation, not `replan_stop`, on their one and only trip', async () => {
    const events: EngineEvent[] = [];
    const ctx = stageCtx({ mode: 'llm-jev', events, move: 'stop_and_report' });
    const r = await runReplanStage(ctx, {}, trippedOn(DONE_SIG, []), ['executed', 'noop', 'noop', 'noop']);
    expect(r.kind).toBe('directive');
    expect(r.directive.move).toBe('change_approach');
    expect(r.directive.text).toContain(PHASE_ESCALATION);
  });

  it('the ladder is finite: escalate, then stop — a refused `done` can never spin for ever', async () => {
    const detector = createLoopDetector();
    const moves: string[] = [];
    for (let trip = 0; trip < 4; trip++) {
      for (let i = 0; i < 3; i++) detector.observe(trip * 3 + i + 1, [DONE_SIG]);
      const events: EngineEvent[] = [];
      const ctx = stageCtx({ mode: 'llm-jev', events, move: 'stop_and_report' });
      const r = await runReplanStage(ctx, {}, detector, ['noop', 'noop', 'noop']);
      moves.push(r.kind === 'stop' ? `stop:${r.reason}` : r.directive.move);
      if (r.kind === 'stop') break;
      detector.onReplan(trip * 3 + 4, r.directive.text);
    }
    expect(moves).toEqual(['change_approach', 'stop:replan_stop']);
  });

  it('jev-on is untouched: `stop_and_report` on a `done:` signature still stops at once', async () => {
    const events: EngineEvent[] = [];
    const ctx = stageCtx({ mode: 'jev-on', events, move: 'stop_and_report' });
    const r = await runReplanStage(ctx, {}, trippedOn(DONE_SIG, []), ['noop', 'noop', 'noop']);
    expect(r).toMatchObject({ kind: 'stop', reason: 'replan_stop' });
  });

  it('a `run:` signature still stops on `stop_and_report` at the first trip (change 7 owns that ladder)', async () => {
    const events: EngineEvent[] = [];
    const ctx = stageCtx({ mode: 'llm-jev', events, move: 'stop_and_report' });
    const r = await runReplanStage(ctx, {}, trippedOn(RUN_SIG, []), ['executed']);
    expect(r).toMatchObject({ kind: 'stop', reason: 'replan_stop' });
  });
});
