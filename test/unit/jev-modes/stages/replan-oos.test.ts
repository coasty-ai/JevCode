/**
 * Out-of-sample iteration 1, changes 6(a) and 7 (docs/research/llm-jev/oos-analysis-2026-09-22.md).
 *
 * 6(a) `replan|task_impossible`: 39 questions over the 44-run slice, ONE distinct answer. Not asked
 *      when the Synthesizer proposes; the jev-on wiring is byte-identical.
 * 7    `replan|next_move`: 33 of 39 answers were `gather_context` and the next step re-ran the same
 *      pytest with unchanged output every time — crossfile `20260922-054652-dcxbrltg` (steps 1-10,
 *      14-17) and six_hunks `20260922-061926-da3ho35c` (steps 1-7, 11-12), 20 and 12 steps in which
 *      no patch was ever proposed.
 */
import { describe, expect, it } from 'vitest';
import type { Answer, Decision, EngineEvent, JsonObject, Question, StageName } from '../../../../src/core/types.js';
import type { StageContext } from '../../../../src/loop/engine.js';
import { createLoopDetector } from '../../../../src/loop/loopdetect.js';
import {
  PHASE_ESCALATION,
  buildReplanQuestions,
  escalationDirectiveText,
  gatherContextEscalation,
  runReplanStage,
  synthProposes,
} from '../../../../src/jev-modes/stages/replan.js';
import { DEFAULT_LIMITS, choiceOver, createFakeSandbox, createFakeWorkspace, noulA } from '../../loop/fakes.js';

/** the shape loopdetect.ts computeSignatures writes for an executed `run`: command hash, then exitCode + output hash */
const PYTEST_SIG = 'run:aaaaaaaaaaaa:bbbbbbbbbbbb';
const REFUSED_SIG = 'run:aaaaaaaaaaaa:refused';
const DONE_SIG = 'done:cccccccccccc';
const REPLAN_KEYS = ['change_approach', 'gather_context', 'fix_environment', 'revert_changes', 'stop_and_report', 'none_of_these'];

interface Asked {
  ids: string[];
}

function stageCtx(opts: { mode: StageContext['mode']; asked: Asked[]; events: EngineEvent[]; move: string; taskImpossible?: number; impossibleThreshold?: number }): StageContext {
  return {
    runId: 'r-oos',
    step: 7,
    mode: opts.mode,
    task: 'fix the failing tests',
    limits: { ...DEFAULT_LIMITS, impossibleThreshold: opts.impossibleThreshold ?? DEFAULT_LIMITS.impossibleThreshold },
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
      opts.asked.push({ ids: Object.keys(questions) });
      const answers: Record<string, Answer> = { next_move: choiceOver(REPLAN_KEYS, opts.move, 0.72) };
      for (const id of Object.keys(questions)) {
        if (id.startsWith('can_')) answers[id] = noulA(id === `can_${opts.move}` ? 0.9 : 0.1);
        if (id === 'task_impossible') answers[id] = noulA(opts.taskImpossible ?? 0.05);
      }
      const rows: Decision[] = Object.keys(questions).map((id) => ({ step: 7, stage, id, question: questions[id]!, answer: answers[id] ?? noulA(0), probability: 0.72, confidence: 0.8, latencyMs: 1, requestHash: 'h' }));
      annotate?.(answers, rows);
      return { answers, rows, latencyMs: 1 };
    },
    generate: () => Promise.reject(new Error('the replan stage never generates')),
    noteMalformed: () => undefined,
    startCandidateRefresh: () => undefined,
  };
}

/** a detector already tripped on `sig`, with `directives` recorded against it by earlier replans */
function trippedOn(sig: string, directives: readonly { step: number; directive: string }[]): ReturnType<typeof createLoopDetector> {
  return createLoopDetector({
    counts: {},
    lastSignature: sig,
    tripped: true,
    replanCount: directives.length,
    tripsBySignature: { [sig]: { trips: directives.length + 1, directives: directives.map((d) => ({ ...d })) } },
  });
}

const GATHERED_AT_5 = { step: 5, directive: 'After repeating the same run command with the same result 3 times, Jev directs `gather_context` (p=0.71, task_impossible=0.08): read or search the code and its tests before acting again.' };

describe('change 6(a): replan|task_impossible is not asked on the synth path', () => {
  it('39 questions, 1 distinct answer over the OOS slice: llm-jev and jev-only drop it; jev-on and jev-off keep the §5.5 set byte-identical', () => {
    expect(synthProposes('llm-jev')).toBe(true);
    expect(synthProposes('jev-only')).toBe(true);
    expect(synthProposes('jev-on')).toBe(false);
    expect(synthProposes('jev-off')).toBe(false);
    // the default call site (jev-on) is unchanged, down to the question objects
    expect(Object.keys(buildReplanQuestions())).toEqual(['next_move', 'can_change_approach', 'can_gather_context', 'can_fix_environment', 'can_revert_changes', 'can_stop_and_report', 'task_impossible']);
    expect(buildReplanQuestions()).toEqual(buildReplanQuestions({ taskImpossible: true }));
    expect(Object.keys(buildReplanQuestions({ taskImpossible: false }))).toEqual(['next_move', 'can_change_approach', 'can_gather_context', 'can_fix_environment', 'can_revert_changes', 'can_stop_and_report']);
    const { task_impossible: _dropped, ...rest } = buildReplanQuestions();
    expect(buildReplanQuestions({ taskImpossible: false })).toEqual(rest);
  });

  it('with the Noul unasked the `impossible` stop cannot fire from the stage, even at impossibleThreshold 0', async () => {
    const asked: Asked[] = [];
    const events: EngineEvent[] = [];
    const ctx = stageCtx({ mode: 'llm-jev', asked, events, move: 'change_approach', taskImpossible: 1, impossibleThreshold: 0 });
    const r = await runReplanStage(ctx, {}, trippedOn(PYTEST_SIG, []), ['executed']);
    expect(asked[0]?.ids).not.toContain('task_impossible');
    expect(r.kind).toBe('directive');
    expect(r.directive.taskImpossible).toBe(0);
  });

  it('jev-on still asks it and still stops `impossible` above the threshold', async () => {
    const asked: Asked[] = [];
    const events: EngineEvent[] = [];
    const ctx = stageCtx({ mode: 'jev-on', asked, events, move: 'change_approach', taskImpossible: 0.9 });
    const r = await runReplanStage(ctx, {}, trippedOn(PYTEST_SIG, []), ['executed']);
    expect(asked[0]?.ids).toContain('task_impossible');
    expect(r).toMatchObject({ kind: 'stop', reason: 'impossible' });
    expect(r.directive.taskImpossible).toBe(0.9);
  });
});

describe('change 7: the gather_context replan loop on one `run:` signature', () => {
  it('crossfile 20260922-054652-dcxbrltg: a second gather_context for the same executed `run:` signature escalates instead of repeating', () => {
    expect(gatherContextEscalation({ signature: PYTEST_SIG, move: 'gather_context', priorDirectives: [GATHERED_AT_5], lastOutcomes: ['executed', 'executed'] })).toEqual({ kind: 'escalate' });
  });

  it('six_hunks 20260922-061926-da3ho35c: with the SEEDS → SKETCH/WIDENED rung already directed there is nothing left to escalate, so it stops with a named reason', () => {
    const escalated = { step: 9, directive: escalationDirectiveText(0.7, PYTEST_SIG, [5]) };
    const r = gatherContextEscalation({ signature: PYTEST_SIG, move: 'gather_context', priorDirectives: [GATHERED_AT_5, escalated], lastOutcomes: ['executed'] });
    expect(r?.kind).toBe('stop');
    if (r?.kind === 'stop') {
      expect(r.reason).toContain(PYTEST_SIG);
      expect(r.reason).toContain(PHASE_ESCALATION);
      expect(r.reason).toContain('no phase is left to escalate');
    }
  });

  it('the rule fires on nothing else: another move, a first trip, a refused run, a `done` signature (the engine owns that exit), a window with no executed step', () => {
    const prior = [GATHERED_AT_5];
    const win = ['executed'];
    expect(gatherContextEscalation({ signature: PYTEST_SIG, move: 'change_approach', priorDirectives: prior, lastOutcomes: win })).toBeNull();
    expect(gatherContextEscalation({ signature: PYTEST_SIG, move: 'gather_context', priorDirectives: [], lastOutcomes: win })).toBeNull();
    expect(gatherContextEscalation({ signature: REFUSED_SIG, move: 'gather_context', priorDirectives: prior, lastOutcomes: win })).toBeNull();
    expect(gatherContextEscalation({ signature: DONE_SIG, move: 'gather_context', priorDirectives: prior, lastOutcomes: win })).toBeNull();
    expect(gatherContextEscalation({ signature: PYTEST_SIG, move: 'gather_context', priorDirectives: prior, lastOutcomes: ['blocked', 'declined', null] })).toBeNull();
    // a prior directive for a DIFFERENT move does not count as having gathered
    const changed = { step: 5, directive: 'After repeating the same run command with the same result 3 times, Jev directs `change_approach` (p=0.61, task_impossible=0.05): keep the goal but reach it a different way.' };
    expect(gatherContextEscalation({ signature: PYTEST_SIG, move: 'gather_context', priorDirectives: [changed], lastOutcomes: win })).toBeNull();
  });

  it('the escalation directive is read back as `change_approach` by the search and by the detector, and names the phase escalation', async () => {
    const asked: Asked[] = [];
    const events: EngineEvent[] = [];
    const ctx = stageCtx({ mode: 'llm-jev', asked, events, move: 'gather_context' });
    const r = await runReplanStage(ctx, {}, trippedOn(PYTEST_SIG, [GATHERED_AT_5]), ['executed', 'executed']);
    expect(r.kind).toBe('directive');
    expect(r.directive.move).toBe('change_approach');
    expect(r.directive.text).toContain(PHASE_ESCALATION);
    const { directiveMove } = await import('../../../../src/loop/loopdetect.js');
    const { parseDirective } = await import('../../../../src/jev-modes/synth/search/directive.js');
    expect(directiveMove(r.directive.text)).toBe('change_approach');
    expect(parseDirective(r.directive.text)).toBe('change_approach');
    expect(events.some((e) => e.type === 'replan')).toBe(true);
  });

  it('invariant: one `run:` signature is never directed to gather context twice, so the same pytest is never re-run a third time with no patch proposed in between', async () => {
    const detector = createLoopDetector();
    const moves: string[] = [];
    // three successive trips of the SAME executed pytest signature; Jev answers gather_context every time,
    // as it did on 33 of 39 replans in the slice
    for (let trip = 0; trip < 3; trip++) {
      for (let i = 0; i < 3; i++) detector.observe(trip * 3 + i + 1, [PYTEST_SIG]);
      expect(detector.trippedSignature()).toBe(PYTEST_SIG);
      const asked: Asked[] = [];
      const events: EngineEvent[] = [];
      const ctx = stageCtx({ mode: 'llm-jev', asked, events, move: 'gather_context' });
      const r = await runReplanStage(ctx, {}, detector, ['executed', 'executed']);
      moves.push(r.kind === 'stop' ? `stop:${r.reason}` : r.directive.move);
      if (r.kind === 'stop') break;
      detector.onReplan(trip * 3 + 4, r.directive.text);
    }
    expect(moves).toEqual(['gather_context', 'change_approach', 'stop:replan_stop']);
  });

  it('jev-on is untouched: the same history still yields the plain gather_context directive', async () => {
    const asked: Asked[] = [];
    const events: EngineEvent[] = [];
    const ctx = stageCtx({ mode: 'jev-on', asked, events, move: 'gather_context' });
    const r = await runReplanStage(ctx, {}, trippedOn(PYTEST_SIG, [GATHERED_AT_5]), ['executed']);
    expect(r.kind).toBe('directive');
    expect(r.directive.move).toBe('gather_context');
    expect(r.directive.text).not.toContain(PHASE_ESCALATION);
  });
});
