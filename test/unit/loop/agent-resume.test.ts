/**
 * docs/AGENT-LOOP-DESIGN.md §10 / §2.2 / §15 S4 — checkpoint, resume and discard in agent mode:
 * - `agentState` round-trips through `state.json` and a resume hands it back as `AgentContext.state`;
 * - the resume fold raises `agentState.transcriptSeq` to the folded rows' `agent.seqAfter` (src/checkpoint/resume.ts, and the engine
 *   for a loader that did not fold), so a step `steps.jsonl` counted is never re-issued;
 * - a resume resets `counters.loopNudges`;
 * - an act step discarded through a blocking pane, answered, is issued again — the next request pairs every tool_use with a result;
 * - a pause-now mid-turn writes no replay cache (S4 item 10) and still leaves a `now` PausePoint; the resume re-derives the turn;
 * - a harness-seeded step (`seedStep`, `/land`) is refused in agent mode rather than accepted and never run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { foldStepsIntoState, raiseAgentTranscriptSeq } from '../../../src/checkpoint/resume.js';
import { createLoopDetector } from '../../../src/loop/loopdetect.js';
import type { CheckpointState, StepRecord } from '../../../src/core/types.js';
import type { AgentHarness, ToolTurn } from './fakes.js';
import { AGENT_SEEDED_STEP_REFUSED } from '../../../src/loop/stages/agent.js';
import { FIXED_RUN_ID, createFakeSandbox, createFakeStore, everyToolUsePaired, execResult, makeAgentEngine, passingTests } from './fakes.js';

const harnesses: AgentHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function agent(...args: Parameters<typeof makeAgentEngine>): Promise<AgentHarness> {
  const h = await makeAgentEngine(...args);
  harnesses.push(h);
  return h;
}

const read = (path: string): ToolTurn => ({ toolCalls: [{ name: 'read_file', input: { path } }] });
const bash = (command: string): ToolTurn => ({ toolCalls: [{ name: 'bash', input: { command } }] });

function row(step: number, seqAfter: number | null): StepRecord {
  return {
    step,
    startedAt: '2026-09-23T00:00:00.000Z',
    intent: null,
    intentAnswer: null,
    contextFiles: [],
    proposal: { goal: 'bash make', action: { kind: 'run', command: 'make' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' },
    risk: null,
    outcome: { status: 'executed', summary: 'exit 0', changedFiles: [] },
    judge: null,
    completion: null,
    decisions: [],
    jevRequests: [],
    usage: { generator: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 } },
    timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 0 },
    loopSignatures: [],
    proposer: 'agent',
    ...(seqAfter !== null ? { agent: { kind: 'act' as const, turn: step, calls: [], seqAfter } } : {}),
  };
}

describe('the resume fold raises agentState.transcriptSeq (src/checkpoint/resume.ts, §10)', () => {
  it('to the highest folded agent.seqAfter; lower or absent seqs leave it; a non-object or absent state is returned as is', () => {
    expect(raiseAgentTranscriptSeq({ v: 1, transcriptSeq: 4 }, [row(3, 7), row(4, 9), row(5, null)])).toEqual({ v: 1, transcriptSeq: 9 });
    const held = { v: 1, transcriptSeq: 12 };
    expect(raiseAgentTranscriptSeq(held, [row(3, 7)])).toBe(held);
    expect(raiseAgentTranscriptSeq({ v: 1 }, [row(3, 5)])).toEqual({ v: 1, transcriptSeq: 5 });
    expect(raiseAgentTranscriptSeq('opaque', [row(3, 5)])).toBe('opaque');
    expect(raiseAgentTranscriptSeq(null, [row(3, 5)])).toBeNull();
  });

  it('foldStepsIntoState applies it to the rows past the checkpoint only, and adds nothing to a legacy state', async () => {
    const base: CheckpointState = {
      runId: FIXED_RUN_ID, mode: 'agent', step: 2, plan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] }, window: [], loopDetector: createLoopDetector().toState(),
      spend: { generator: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, jev: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, totalUsd: 0, capUsd: 2, exceeded: false },
      wallMsUsed: 0, timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 0 }, jevLatencyMs: [], tokensPerStep: [], counters: { blocked: 0, reviews: 0, declined: 0, failed: 0, loops: 0, replans: 0, reads: 0 },
      directive: null, lastTestRun: null, lastChangeStep: null, createdThisRun: [], resolvedJevModel: null, jevModelDrift: null, stopReason: 'max_steps', interrupted: null, consecutiveStageFailures: 0, resumes: 0, updatedAt: '2026-09-23T00:00:00.000Z',
      agentState: { v: 1, transcriptSeq: 6 },
    };
    const folded = foldStepsIntoState(base, [row(2, 99), row(3, 11)]);
    expect(folded.step).toBe(3);
    // row 2 is at the checkpoint (already covered by state.json): its seq is not folded
    expect(folded.agentState).toEqual({ v: 1, transcriptSeq: 11 });
    const { agentState: _a, ...legacy } = base;
    void _a;
    expect('agentState' in foldStepsIntoState({ ...legacy, mode: 'jev-on' }, [row(3, 11)])).toBe(false);
  });
});

describe('resume in agent mode (§10)', () => {
  it('agentState round-trips: the resumed driver restores it, continues the same transcript, and a resume resets loopNudges', async () => {
    const turns: ToolTurn[] = [read('src/a.py'), bash('make'), bash('pytest -q'), { text: 'All green.' }];
    const first = await agent(turns, {
      limits: { maxSteps: 2 },
      sandbox: createFakeSandbox(() => execResult({ exitCode: 0 })),
      driver: { loopTripAt: (step) => (step === 2 ? { signature: 'sig', count: 3, rule: 'repeat', tool: 'bash' } : null) },
    });
    const r1 = await first.engine.run();
    expect(r1.stopReason).toBe('max_steps');
    const saved = first.store.last()!;
    expect(saved.counters.loopNudges).toBe(1);
    expect(saved.agentState).toMatchObject({ v: 1, transcriptSeq: first.store.steps[1]!.agent!.seqAfter });

    // the resumed process: a fresh driver, the same store and run dir
    const second = await agent(turns.slice(2), {
      runsDir: first.runsDir,
      store: first.store,
      resume: { runId: FIXED_RUN_ID, force: false },
      limits: { maxSteps: 10 },
      sandbox: createFakeSandbox(() => passingTests),
    });
    const r2 = await second.engine.run();
    expect(r2.stopReason).toBe('complete');
    expect(second.driver.restoredFrom).toEqual(saved.agentState);
    expect(second.driver.contexts[0]!.resumed).toBe(true);
    expect(second.driver.contexts[0]!.state).toEqual(saved.agentState);
    // the resumed request carries the whole earlier transcript, paired, and then continues it
    const req = second.tools.requests[0]!.agent!.messages;
    expect(req[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Fix f() in src/a.py so that tests/test_a.py passes' }] });
    expect(everyToolUsePaired(req)).toBe(true);
    expect(req.filter((m) => m.role === 'assistant')).toHaveLength(2);
    // steps continue from 3; the nudge count starts again (the human has looked at the run)
    expect(second.store.steps.slice(2).map((s) => s.step)).toEqual([3, 4]);
    expect(second.store.last()!.counters.loopNudges).toBe(0);
  });

  it('a step steps.jsonl counted after the last state.json raises transcriptSeq on resume (the engine folds for a store that did not)', async () => {
    const first = await agent([read('src/a.py'), bash('make')], { limits: { maxSteps: 1 }, sandbox: createFakeSandbox(() => execResult({ exitCode: 0 })) });
    await first.engine.run();
    const at = first.store.last()!;
    expect(at.step).toBe(1);
    // a crash between steps.jsonl and state.json of step 2: the row is on disk, the checkpoint is not
    first.store.steps.push(row(2, 42));
    const second = await agent([{ text: 'Done.' }], { runsDir: first.runsDir, store: first.store, resume: { runId: FIXED_RUN_ID, force: false }, limits: { maxSteps: 10 } });
    await second.engine.run();
    expect(second.driver.contexts[0]!.state).toMatchObject({ transcriptSeq: 42 });
    expect(second.store.steps.at(-1)!.step).toBe(3);
  });
});

describe('a discarded act step is issued again (§2.2 "discarded steps", §10)', () => {
  it('the checkpoint pane before execute discards the act; answered, the same call runs once and every tool_use is paired', async () => {
    const store = createFakeStore();
    let failures = 1;
    const write = store.writeState.bind(store);
    store.writeState = async (state) => {
      if (state.step === 1 && failures-- > 0) throw Object.assign(new Error("EACCES: permission denied, open '/runs/x/state.json.tmp-1'"), { code: 'EACCES' });
      return write(state);
    };
    const h = await agent([{ text: 'Reading, then building.\n', toolCalls: [{ name: 'read_file', input: { path: 'src/a.py' } }, { name: 'bash', input: { command: 'make' } }] }, { text: 'Built.' }], {
      store,
      sandbox: createFakeSandbox(() => execResult({ exitCode: 0, stdout: 'built' })),
      engine: { blocker: async () => 'retry' },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('generator_done');
    expect(h.of('blocking:request').map((b) => b.request.kind)).toEqual(['checkpoint-degraded']);
    expect(h.of('transcript').some((t) => t.text === 'checkpoint-degraded before execute; step 2 discarded')).toBe(true);
    // next() ran twice for step 2 (the discarded attempt and the replayed one) and returned the same call both times
    const step2 = h.driver.contexts.filter((c) => c.step === 2);
    expect(step2).toHaveLength(2);
    expect(h.store.steps.map((s) => s.agent?.kind)).toEqual(['observe', 'act', 'finish']);
    expect(h.store.steps[1]!.agent!.calls.map((c) => c.id)).toEqual(['call_1_1']);
    // the call ran once, observe() saw it once, and no request ever carried an unpaired tool_use
    expect(h.sandbox.commands).toEqual(['make']);
    expect(h.driver.observations.map((o) => o.step)).toEqual([2, 3]);
    expect(h.tools.requests).toHaveLength(2);
    for (const req of h.tools.requests) expect(everyToolUsePaired(req.agent!.messages)).toBe(true);
  });
});

describe('pause now in agent mode (§10 Pause, S4 item 10)', () => {
  it('mid-turn: human_pause, exit 4, resumable, no replay cache, a `now` point that is not replayable; the resume re-derives the turn, paired', async () => {
    const turns: ToolTurn[] = [read('src/a.py'), { text: 'never arrives', delayMs: 5_000 }];
    const first = await agent(turns, { limits: { maxSteps: 10 } });
    first.engine.events.on('generator:start', (e) => {
      if (e.step === 2) first.engine.pause({ at: 'now' });
    });
    const r1 = await first.engine.run();
    expect(r1.stopReason).toBe('human_pause');
    expect(r1.steps).toBe(1);
    expect(first.of('run:end')[0]).toMatchObject({ exitCode: 4, resumable: true });
    // no replay cache in agent mode: the transcript is the state, so nothing was snapshotted
    expect(first.store.cache.size).toBe(0);
    const saved = first.store.last()!;
    expect(saved.pausePoint).toMatchObject({ step: 2, phase: 'propose', reason: 'now', resumableAt: 'boundary', replayable: false });
    expect(saved.interruptedDetail).toBeUndefined();
    expect(first.store.steps.map((s) => s.agent?.kind)).toEqual(['observe']);

    const second = await agent([{ text: 'f() returns 1.' }], { runsDir: first.runsDir, store: first.store, resume: { runId: FIXED_RUN_ID, force: false }, limits: { maxSteps: 10 } });
    const r2 = await second.engine.run();
    expect(r2.stopReason).toBe('generator_done');
    expect(second.store.steps.map((s) => s.step)).toEqual([1, 2]);
    // the resumed turn carries the read and its result, and nothing unpaired
    const req = second.tools.requests[0]!.agent!.messages;
    expect(everyToolUsePaired(req)).toBe(true);
    expect(req.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(second.store.cache.size).toBe(0);
  });
});

describe('harness-seeded steps in agent mode (ORCHESTRATION-DESIGN §5.7)', () => {
  it('seedStep is refused (false, one transcript line) and /land refuses before any git read; the run is unaffected', async () => {
    const gitCalls: string[][] = [];
    const h = await agent([{ text: 'Hi.' }], {
      engine: {
        orchestration: {
          depth: 0,
          runGit: async (_cwd, args) => {
            gitCalls.push([...args]);
            return execResult({ exitCode: 0 });
          },
        },
      },
    });
    const merge = { goal: 'land', action: { kind: 'run' as const, command: 'git merge --no-ff --no-edit abc123' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: 'harness-seeded: land' };
    expect(h.engine.seedStep!(merge)).toBe(false);
    const landed = await h.engine.land!({ workspaceRoot: h.workspace.root, baseSha: 'a'.repeat(40), pinned: 'b'.repeat(40), agents: 2, dockBranch: 'jevcode/dock' });
    expect(landed).toEqual({ seeded: null, overlap: [] });
    expect(gitCalls).toEqual([]);
    expect(h.of('transcript').filter((t) => t.text === AGENT_SEEDED_STEP_REFUSED)).toHaveLength(2);
    const r = await h.engine.run();
    expect(r.stopReason).toBe('answered');
    expect(h.sandbox.commands).toEqual([]);
  });
});
