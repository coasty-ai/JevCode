import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { abortingConfirmer, alwaysApprove, answer, choiceOver, createFakeSandbox, declineAsReviewer, intentIs, makeEngine, noulA, passingTests, riskAll, turn } from './fakes.js';
import { formatTranscriptItem, itemsFromEvent } from '../../../src/tui/plain.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

describe('engine happy path', () => {
  it('investigate/read -> edit -> run tests -> done ends with complete in the done step', async () => {
    const h = await build({
      turns: [
        turn({ kind: 'read', paths: ['src/a.py'] }, { remaining: ['fix f', 'run tests'] }),
        turn({ kind: 'edit', path: 'src/a.py', old: 'return 1', new: 'return 2' }, { remaining: ['run tests'], done: ['fix f'] }),
        turn({ kind: 'run', command: 'pytest -q' }, { done: ['fix f', 'run tests'], remaining: [] }),
        turn({ kind: 'done', summary: 'f fixed, 2 tests pass' }, { done: ['fix f', 'run tests'], remaining: [] }),
      ],
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: {
        rules: [
          intentIs('investigate', 1),
          intentIs('edit', 2),
          intentIs('verify', 3),
          intentIs('finish', 4),
          answer('judge', 'done_0', noulA(0.2), 2), // fix f not verified yet at step 2
          answer('judge', 'done_0', noulA(0.95), 3),
          answer('judge', 'done_1', noulA(0.95), 3),
          answer('judge', 'task_complete', noulA(0.92), 4),
        ],
      },
    });
    const result = await h.engine.run();
    expect(result.stopReason).toBe('complete');
    expect(result.steps).toBe(4);
    expect(h.store.steps).toHaveLength(4);
    const [s1, s2, s3, s4] = h.store.steps;
    expect(s1!.intent).toBe('investigate');
    expect(s1!.outcome?.status).toBe('executed');
    expect(s1!.judge?.succeeded).toBeGreaterThan(0.5);
    expect(s2!.outcome?.status).toBe('executed');
    expect(h.workspace.files.get('src/a.py')).toContain('return 2');
    // step 2 claim "fix f" was judged 0.2 -> rejected, retained in remaining
    expect(s2!.judge?.doneClaims).toEqual([{ text: 'fix f', judged: 0.2, accepted: false }]);
    expect(s3!.outcome?.status).toBe('executed');
    expect(s3!.judge?.tests).toEqual({ source: 'parsed', allPassed: true, passed: 2, failed: 0, errors: 0 });
    expect(s4!.outcome?.status).toBe('noop');
    expect(s4!.judge).toBeNull();
    expect(s4!.completion).toBe(0.92);
    expect(s4!.stoppedAt).toBe('complete');
    expect(result.finalPlan.done.map((d) => d.text).sort()).toEqual(['fix f', 'run tests']);
    expect(result.finalPlan.remaining).toEqual([]);
    // state persisted with the code-computed test facts
    const last = h.store.last()!;
    expect(last.stopReason).toBe('complete');
    expect(last.lastTestRun).toMatchObject({ step: 3, passed: 2, failed: 0, allPassed: true });
    expect(last.lastChangeStep).toBe(2);
    expect(last.step).toBe(4);
    // event order per step: stage:start/end pairs, status after every stage:end
    const types = h.events.map((e) => e.type);
    expect(types[0]).toBe('run:start');
    expect(types[1]).toBe('run:ready');
    expect(types.at(-1)).toBe('run:end');
    for (let i = 0; i < types.length; i++) if (types[i] === 'stage:end') expect(types[i + 1]).toBe('status');
    // the judge state for step 4 carried recent including the done step and testsCurrent true
    const judge4 = h.decider.callsAt('judge').find((c) => c.step === 4)!;
    const st = judge4.state as { recent: { step: number }[]; workspace: { testsCurrent: boolean; lastTestRun: { step: number } } };
    expect(st.recent.map((r) => r.step)).toEqual([1, 2, 3, 4]);
    expect(st.workspace.testsCurrent).toBe(true);
    expect(Object.keys(judge4.questions)).toEqual(['task_complete']);
    // §6 read row: the read step's judge asks succeeded + new_information (+ task_complete), never error_present
    const judge1 = h.decider.callsAt('judge').find((c) => c.step === 1)!;
    expect(Object.keys(judge1.questions)).toEqual(['succeeded', 'new_information', 'task_complete']);
    expect(s1!.judge?.errorPresent).toBe(0);
    const judge3 = h.decider.callsAt('judge').find((c) => c.step === 3)!;
    expect(Object.keys(judge3.questions)).toEqual(['succeeded', 'error_present', 'new_information', 'done_0', 'done_1', 'task_complete']);
    // counters
    expect(result.counters.reads).toBe(1);
    expect(result.counters.blocked).toBe(0);
    expect(result.tokensPerStep).toHaveLength(4);
    // §13: Σ decisions.length over committed steps, from the RunResult and the checkpoint
    const questions = h.store.steps.reduce((n, s) => n + s.decisions.length, 0);
    expect(questions).toBeGreaterThan(0);
    expect(result.jevQuestions).toBe(questions);
    expect(last.jevQuestions).toBe(questions);
    // the normal stop() path reaps stray process groups (§8)
    expect(h.sandbox.killAllCalls).toBe(1);
  });

  it('done judged below threshold is rejected with a window note and the run continues', async () => {
    const h = await build({
      turns: [turn({ kind: 'done', summary: 'all good' }), turn({ kind: 'run', command: 'pytest -q' })],
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [answer('judge', 'task_complete', noulA(0.41), 1), answer('judge', 'task_complete', noulA(0.9), 2)] },
    });
    const result = await h.engine.run();
    expect(result.stopReason).toBe('complete');
    expect(result.steps).toBe(2);
    const req2 = h.provider.requests[1]!;
    expect(req2.messages[0]!.content).toContain('done rejected: task_complete=0.41');
    expect(h.store.last()!.window[0]!.notes).toContain('done rejected: task_complete=0.41');
  });
});

describe('transcript.log (§10 shared item model)', () => {
  it('agrees line for line with itemsFromEvent over the emitted events, numbered from 0, ending with the stop and run:end lines', async () => {
    const h = await build({
      turns: [turn({ kind: 'read', paths: ['src/a.py'] }), turn({ kind: 'done', summary: 'looked' })],
      deciderOptions: { rules: [answer('judge', 'task_complete', noulA(0.9), 2)] },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    let seq = 0;
    const expected: string[] = [];
    for (const e of h.events) {
      for (const item of itemsFromEvent(e, seq)) {
        expect(item.seq).toBe(seq);
        expected.push(formatTranscriptItem(item));
        seq += 1;
      }
    }
    expect(h.store.transcript).toEqual(expected);
    expect(h.store.transcript[0]).toMatch(/^\[run\] start /);
    expect(h.store.transcript.some((l) => /^\[step 1\] intent=investigate p=0\.90 c=/.test(l))).toBe(true);
    expect(h.store.transcript.some((l) => /^\[step 1\] outcome executed: read 1 file\(s\)$/.test(l))).toBe(true);
    expect(h.store.transcript.at(-2)).toBe('[run] stop: complete at step 2');
    expect(h.store.transcript.at(-1)).toMatch(/^\[run\] end complete steps=2 wall=/);
    // pane-only events never produce a line
    expect(h.store.transcript.some((l) => /decision|status|stage:/.test(l))).toBe(false);
  });

  it('a resumed run continues the same file: resumed note, then the new steps, no hand-written step summary lines', async () => {
    const h = await build({ turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 1 } });
    await h.engine.run();
    const before = h.store.transcript.length;
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 2 } });
    const r2 = await h2.engine.run();
    expect(r2.steps).toBe(2);
    expect(r2.jevQuestions).toBe(h.store.steps.reduce((n, s) => n + s.decisions.length, 0));
    const added = h.store.transcript.slice(before);
    expect(added[0]).toMatch(/^\[run\] start .* resumed from step 1 /);
    expect(added).toContain('[run] resumed at step 2');
    expect(added.filter((l) => l.startsWith('[step 2] ')).length).toBeGreaterThan(0);
    expect(added.some((l) => l.startsWith('[step 1] '))).toBe(false);
  });

  it('a refused resume writes nothing to transcript.log', async () => {
    const h = await build({ turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 1 } });
    await h.engine.run();
    const before = [...h.store.transcript];
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, limits: { maxSteps: 1 } });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('max_steps');
    expect(h2.of('run:end')).toHaveLength(1);
    expect(h.store.transcript).toEqual(before);
  });
});

describe('tokens per step by source (§13)', () => {
  it('a 3-step run records generator and Jev series whose pointwise sum is tokensPerStep; the checkpoint carries both', async () => {
    const h = await build({
      turns: [turn({ kind: 'read', paths: ['src/a.py'] }), turn({ kind: 'run', command: 'pytest -q' }), turn({ kind: 'done', summary: 'ok' })],
      sandbox: createFakeSandbox(() => passingTests),
      deciderOptions: { rules: [answer('judge', 'task_complete', noulA(0.95), 3)] },
    });
    const r = await h.engine.run();
    expect(r.stopReason).toBe('complete');
    expect(r.steps).toBe(3);
    // fake provider: 1000 in + 200 out per generate call; fake decider: 300 in + 20 out per request
    expect(r.generatorTokensPerStep).toEqual([1200, 1200, 1200]);
    expect(r.jevTokensPerStep).toHaveLength(3);
    for (const [i, jev] of r.jevTokensPerStep.entries()) {
      expect(jev).toBeGreaterThan(0);
      expect(r.tokensPerStep[i]).toBe(r.generatorTokensPerStep[i]! + jev);
    }
    // per step, Jev tokens = 320 x the Jev requests recorded for that step
    for (const rec of h.store.steps) expect(r.jevTokensPerStep[rec.step - 1]).toBe(320 * rec.jevRequests.length);
    const last = h.store.last()!;
    expect(last.tokensPerStep).toEqual(r.tokensPerStep);
    expect(last.generatorTokensPerStep).toEqual(r.generatorTokensPerStep);
    expect(last.jevTokensPerStep).toEqual(r.jevTokensPerStep);
  });

  it('contract 1.4 (§12.0.3): the last prompt\'s chars are persisted at commit and restored on resume', async () => {
    const h = await build({ turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 1 } });
    await h.engine.run();
    const chars = h.store.last()!.lastPromptChars;
    expect(chars).toBeGreaterThan(0);
    // every committed checkpoint carries it, and the resumed process starts from the stored fact
    expect(h.store.states.every((st) => st.lastPromptChars === undefined || st.lastPromptChars === chars)).toBe(true);
    // a resume that runs no step of its own still carries the stored fact into its final state
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [turn({ kind: 'done', summary: 'ok' })], limits: { maxSteps: 1 } });
    const r2 = await h2.engine.run();
    expect(r2.stopReason).toBe('max_steps');
    expect(h2.provider.requests).toHaveLength(0);
    expect(h.store.last()!.lastPromptChars).toBe(chars);
  });

  it('resume restores both series; a checkpoint written before the split reads as zeros of the combined length', async () => {
    const h = await build({ turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 1 } });
    const r1 = await h.engine.run();
    expect(r1.steps).toBe(1);
    const h2 = await build({ store: h.store, runsDir: h.runsDir, resume: { runId: h.engine.runId, force: false }, turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 2 } });
    const r2 = await h2.engine.run();
    expect(r2.steps).toBe(2);
    expect(r2.generatorTokensPerStep).toEqual([r1.generatorTokensPerStep[0], 1200]);
    expect(r2.jevTokensPerStep[0]).toBe(r1.jevTokensPerStep[0]);
    expect(r2.jevTokensPerStep[1]).toBeGreaterThan(0);
    expect(r2.tokensPerStep).toEqual(r2.generatorTokensPerStep.map((g, i) => g + r2.jevTokensPerStep[i]!));

    // older checkpoint: only the combined series was persisted
    const h3 = await build({ turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 1 } });
    const r3 = await h3.engine.run();
    const stored = h3.store.last()!;
    delete stored.generatorTokensPerStep;
    delete stored.jevTokensPerStep;
    const h4 = await build({ store: h3.store, runsDir: h3.runsDir, resume: { runId: h3.engine.runId, force: false }, turns: [turn({ kind: 'read', paths: ['src/a.py'] })], limits: { maxSteps: 2 } });
    const r4 = await h4.engine.run();
    expect(r4.steps).toBe(2);
    expect(r4.tokensPerStep[0]).toBe(r3.tokensPerStep[0]);
    expect(r4.generatorTokensPerStep).toEqual([0, 1200]);
    expect(r4.jevTokensPerStep[0]).toBe(0);
    expect(r4.jevTokensPerStep[1]).toBeGreaterThan(0);
    expect(r4.tokensPerStep[1]).toBe(1200 + r4.jevTokensPerStep[1]!);
    // and the resumed checkpoint now carries the split for every step
    expect(h3.store.last()!.generatorTokensPerStep).toEqual([0, 1200]);
  });
});

describe('risk policy', () => {
  it('blocked action (risk >= 0.7): no execute, no judge request, reason reaches the next prompt', async () => {
    const h = await build({
      turns: [turn({ kind: 'run', command: 'rm -rf build' }), turn({ kind: 'done', summary: 'x' })],
      deciderOptions: { rules: [riskAll({ 3: 0.8, 0: 0.2 }, 1), answer('judge', 'task_complete', noulA(0.9), 2)] },
      limits: { maxSteps: 2 },
    });
    const result = await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.outcome?.status).toBe('blocked');
    expect(s1.risk?.verdict).toBe('block');
    expect(s1.risk?.risk).toBe(0.8);
    expect(s1.risk?.reason).toMatch(/destructive/);
    expect(s1.risk?.reason).toMatch(/0\.80 probability of level 3 or above/);
    expect(s1.judge).toBeNull();
    expect(s1.completion).toBeNull();
    expect(h.sandbox.commands).toHaveLength(0);
    // stages for step 1: intent, context, risk -> exactly 3 decider calls, none at judge
    expect(h.decider.calls.filter((c) => c.step === 1).map((c) => c.stage)).toEqual(['intent', 'context', 'risk']);
    expect(s1.decisions.some((d) => d.stage === 'judge' || d.stage === 'complete')).toBe(false);
    expect(s1.loopSignatures[0]).toMatch(/^run:/);
    expect(h.provider.requests[1]!.messages[0]!.content).toContain(s1.risk!.reason.slice(0, 80));
    expect(result.counters.blocked).toBe(1);
    expect(result.stopReason).toBe('complete');
  });

  it('review declined by the bench confirmer -> declined with the identity prefix, no execute', async () => {
    const h = await build({
      turns: [turn({ kind: 'run', command: 'pip install x' })],
      deciderOptions: { rules: [riskAll({ 2: 1 })] },
      limits: { maxSteps: 1 },
    });
    const result = await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.outcome?.status).toBe('declined');
    expect(s1.outcome).toMatchObject({ reason: expect.stringMatching(/^not approved \(no reviewer in bench runs\): risk 0\.50/) });
    expect(h.sandbox.commands).toHaveLength(0);
    expect(s1.judge).toBeNull();
    expect(result.counters.reviews).toBe(1);
    expect(result.counters.declined).toBe(1);
    expect(h.of('confirm:request')).toHaveLength(1);
    expect(h.of('confirm:resolved')[0]).toMatchObject({ step: 1, id: `${h.engine.runId}:1`, approved: false, aborted: false });
    expect(h.store.transcript).toContain(`[step 1] confirm ${h.engine.runId}:1 declined`);
    expect(result.stopReason).toBe('max_steps');
  });

  it('review declined by a human reviewer uses the "declined by reviewer" prefix', async () => {
    const h = await build({ turns: [turn({ kind: 'run', command: 'pip install x' })], deciderOptions: { rules: [riskAll({ 2: 1 })] }, confirmer: declineAsReviewer, limits: { maxSteps: 1 } });
    await h.engine.run();
    expect(h.store.steps[0]!.outcome).toMatchObject({ status: 'declined', reason: expect.stringMatching(/^declined by reviewer: /) });
  });

  it('review approved executes and is judged', async () => {
    const h = await build({ turns: [turn({ kind: 'run', command: 'pip install x' })], deciderOptions: { rules: [riskAll({ 2: 1 })] }, confirmer: alwaysApprove, limits: { maxSteps: 1 } });
    const result = await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.outcome?.status).toBe('executed');
    expect(h.sandbox.commands).toEqual(['pip install x']);
    expect(s1.judge).not.toBeNull();
    expect(result.counters.reviews).toBe(1);
    expect(result.counters.declined).toBe(0);
  });

  it('a Confirmer that rejects with AbortError applies §9.1 rule 1 and stops with human_abort', async () => {
    const h = await build({ turns: [turn({ kind: 'run', command: 'pip install x' })], deciderOptions: { rules: [riskAll({ 2: 1 })] }, confirmer: abortingConfirmer });
    const result = await h.engine.run();
    expect(result.stopReason).toBe('human_abort');
    expect(result.steps).toBe(0);
    expect(h.store.steps).toHaveLength(0);
    expect(h.sandbox.commands).toHaveLength(0);
    const last = h.store.last()!;
    expect(last.interrupted).toMatchObject({ step: 1, stage: 'risk' });
    expect(last.interrupted?.proposal?.action).toEqual({ kind: 'run', command: 'pip install x' });
    expect(last.spend.totalUsd).toBeGreaterThan(0);
    expect(h.of('confirm:resolved')[0]).toMatchObject({ step: 1, approved: false, aborted: true });
    expect(h.sandbox.killAllCalls).toBe(1); // abort() killed; stop() does not kill a second time
    // the discarded step counts no review: the resumed run will ask again
    expect(last.counters.reviews).toBe(0);
    expect(result.counters.reviews).toBe(0);
    // abort() after run() resolved is a no-op and installs no 'exit' writer
    const before = process.listenerCount('exit');
    h.engine.abort('signal');
    expect(process.listenerCount('exit')).toBe(before);
    expect(h.store.syncStates).toHaveLength(0);
  });

  it('intent finish adds the finish wording; a fallback that lands on Jev\'s own answer adds the no-fitting-intent wording but no intent:unresolved signature (Fix 3)', async () => {
    const h = await build({
      turns: [turn({ kind: 'done', summary: 's' }), turn({ kind: 'read', paths: ['src/a.py'] })],
      deciderOptions: {
        rules: [
          intentIs('finish', 1),
          answer('judge', 'task_complete', noulA(0.2), 1),
          (ctx) => (ctx.stage === 'intent' && ctx.step === 2 ? { can_investigate: noulA(0.1), can_edit: noulA(0.1), can_verify: noulA(0.1), can_fix_environment: noulA(0.1), can_finish: noulA(0.1) } : undefined),
        ],
      },
      limits: { maxSteps: 2 },
    });
    await h.engine.run();
    expect(h.provider.requests[0]!.messages[0]!.content).toContain('Jev judges nothing remains');
    expect(h.provider.requests[1]!.messages[0]!.content).toContain('Jev found no fitting intent');
    const s2 = h.store.steps[1]!;
    expect(s2.intent).toBe('investigate');
    expect(s2.intentAnswer).toBe('investigate'); // Jev chose investigate, its paired Noul was low
    // the effective intent equals Jev's argmax: the verdict is a fallback for the pane, not an unresolved intent for the loop detector
    expect(s2.loopSignatures).toEqual(['read:5ffbe7b0e832']);
    expect(s2.decisions.find((d) => d.id === 'intent')?.verdict).toBe('fallback');
    // the context and risk states carry the effective intent, which is what their questions name
    const ctx2 = h.decider.callsAt('context').find((c) => c.step === 2)!.state as { intent: { choice: string } };
    expect(ctx2.intent.choice).toBe('investigate');
    expect(String(Object.values(h.decider.callsAt('context')[1]!.questions)[0]!.instructions)).toContain('for an `investigate` step');
    const risk2 = h.decider.callsAt('risk').find((c) => c.step === 2)!.state as { intent: { choice: string } };
    expect(risk2.intent.choice).toBe('investigate');
  });

  it('an escape answer at intent resolves to the fallback and the Jev states never carry none_of_these as intent.choice', async () => {
    const h = await build({
      turns: [turn({ kind: 'read', paths: ['src/a.py'] })],
      deciderOptions: {
        rules: [
          (ctx) =>
            ctx.stage === 'intent'
              ? { intent: choiceOver(['investigate', 'edit', 'verify', 'fix_environment', 'finish', 'none_of_these'], 'none_of_these', 0.8), can_investigate: noulA(0.2), can_edit: noulA(0.1), can_verify: noulA(0.1), can_fix_environment: noulA(0.1), can_finish: noulA(0.1) }
              : undefined,
        ],
      },
      limits: { maxSteps: 1 },
    });
    await h.engine.run();
    const s1 = h.store.steps[0]!;
    expect(s1.intentAnswer).toBe('none_of_these');
    expect(s1.intent).toBe('investigate');
    for (const c of h.decider.calls.filter((c) => c.stage === 'context' || c.stage === 'risk')) {
      expect((c.state as { intent: { choice: string } }).intent.choice).toBe('investigate');
    }
    expect(h.provider.requests[0]!.messages[0]!.content).toContain('chose `none_of_these`');
  });
});
