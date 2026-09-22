/**
 * **The post-C engine seam of the router table** (docs/LLM-LOOP-DESIGN.md §7.5, contract 1.9 "Fastlane").
 *
 * Slot B landed `routeSpeculative`, the six stage conversions and the per-step token, and deferred five things
 * to a commit that could hold `src/loop/engine.ts` alone (§7.1: no two slots hold that file at once). Until they
 * landed, the wave's two headline promises were only half true:
 *
 *   (a) a dropped router ask was cancelled AT THE ROUTER and still ran to completion inside `askRecorded` —
 *       charging its metering, its `jev.jsonl` row, its `decision` events and its `draft` mutations to a step
 *       whose `StepRecord` had already been written (review 2026-09-22, defect 2; I4);
 *   (b) `EngineOptions.routers` was read by nobody, so the only switch was a process-wide env var, and the env
 *       BEAT an explicit option in both mechanisms (slot D's finding) — an arm's own row was not the truth;
 *   (c) `StepTiming.routerWaitMs`, `StepRecord.router`, `riskSource` and `jevUnavailable` had no writer, so I3
 *       and the §5.2 audit trail did not exist in any real run;
 *   (d) `completionDecision` (RL5) was written and unit-tested and no run reached it;
 *   (e) the shown retry waker was a single slot that any settling call cleared — and routers are the first thing
 *       that makes two Jev asks overlap.
 *
 * Every test below is named for its row. The engine is the unit: these are the assertions that can only be made
 * against a real `runStep` / `commit`, which is exactly why they waited for this commit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Answer, AskResult, GenerateRequest, Json, Proposal, Question, StageName, StepRecord, Synthesizer } from '../../../src/core/types.js';
import { HEDGE_TWIN_OFFSET, hedgeOriginOf } from '../../../src/synth/llm/source.js';
import { resetStepRouters } from '../../../src/loop/routers.js';
import { RL1_INTENT_DEADLINE_MS } from '../../../src/loop/routers.js';
import { choiceOver, createFakeDecider, createFakeWorkspace, makeEngine, noulA, repoState, scoreA, turn, type DeciderCall, type FakeDecider, type Harness } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
  delete process.env['JEVCODE_ROUTERS'];
  resetStepRouters();
});

async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

/** the fixture the I2 golden uses: a read, a test-command run and a `done` */
const TURNS = (): ReturnType<typeof turn>[] => [turn({ kind: 'read', paths: ['src/a.py'] }), turn({ kind: 'run', command: 'pytest -q' }), turn({ kind: 'done', summary: 'the suite passes' })];

function ws(): ReturnType<typeof createFakeWorkspace> {
  return createFakeWorkspace({ files: { 'src/a.py': 'def f():\n    return 1\n' }, gitState: repoState() });
}

/** every question answered the way `createFakeDecider` answers it, so a hand-written decider stays comparable */
function answersFor(questions: Record<string, Question>): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  const choice = Object.values(questions).find((q) => q.type === 'choice');
  const firstOption = choice !== undefined && choice.type === 'choice' ? Object.keys(choice.criteria).find((k) => k !== 'none_of_these') : undefined;
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      out[id] = choiceOver(keys, keys.find((k) => k !== 'none_of_these') ?? keys[0]!, 0.9);
    } else if (q.type === 'score') out[id] = scoreA({ 0: 1 }, q.criteria.length);
    else if (id === 'task_complete') out[id] = noulA(0.1);
    else if (id === 'task_impossible') out[id] = noulA(0.05);
    else if (id === 'error_present' || id === 'new_information') out[id] = noulA(0.1);
    else if (id.startsWith('can_')) out[id] = noulA(id === `can_${firstOption ?? ''}` ? 0.9 : 0.1);
    else out[id] = noulA(0.9);
  }
  return out;
}

/**
 * A decider that **ignores the signal it is handed**. This is the case the seam exists for: `routeSpeculative`
 * aborting the linked controller is a request, not a guarantee — an in-process decider, a client mid-parse or a
 * cached answer can all finish anyway, and what must not happen then is a write into a step that has moved on.
 */
function ignoresAbortDecider(o: { slowStage: StageName; slowMs: number; onSettled?: () => void }): FakeDecider & { asked: StageName[]; sawAbort: boolean[]; slowSettled: Promise<void> } {
  const asked: StageName[] = [];
  const sawAbort: boolean[] = [];
  const calls: DeciderCall[] = [];
  let resolveSlow = (): void => undefined;
  const slowSettled = new Promise<void>((r) => (resolveSlow = r));
  return {
    model: 'typesafe/jev-1.13-20260917',
    provider: 'openrouter',
    asked,
    sawAbort,
    slowSettled,
    calls,
    callsAt: (stage) => calls.filter((c) => c.stage === stage),
    async ask(_state: Json, questions: Record<string, Question>, opts): Promise<AskResult> {
      asked.push(opts.stage);
      calls.push({ stage: opts.stage, step: opts.step, state: _state, questions });
      if (opts.stage === o.slowStage) {
        // a plain timer, never linked to the signal: the point is a decider that does not stop when asked to
        await new Promise((r) => setTimeout(r, o.slowMs));
        sawAbort.push(opts.signal.aborted);
        o.onSettled?.();
        resolveSlow();
      }
      return { answers: answersFor(questions), usage: { inputTokens: 300, outputTokens: 20, costUsd: 0.0002, calls: 1 }, latencyMs: 0, model: 'typesafe/jev-1.13-20260917', requestHash: `h${asked.length}`, attempts: 1, id: null };
    },
  };
}

const rowsAt = (h: Harness, stage: StageName): unknown[] => h.store.jevRequests.filter((r) => r.stage === stage);

// ---------------------------------------------------------------------------------------
// (a) a per-call AbortSignal on ctx.ask / askRecorded
// ---------------------------------------------------------------------------------------

describe('(a) the per-call signal on ctx.ask / askRecorded', () => {
  it('a router ask past ROUTER_DEADLINE_MS is ABORTED: the decider is told, and the drop costs the step nothing', async () => {
    process.env['JEVCODE_ROUTERS'] = 'on';
    // RL1's deadline is 250 ms; this decider answers intent at 400 ms and ignores its signal entirely
    const decider = ignoresAbortDecider({ slowStage: 'intent', slowMs: RL1_INTENT_DEADLINE_MS + 150 });
    const h = await build({ mode: 'jev-on', decider, turns: TURNS(), workspace: ws(), probeGitState: repoState(), limits: { maxSteps: 1 } });
    await h.engine.run();
    // the run is over long before the abandoned ask is: wait for the answer nobody wanted
    await decider.slowSettled;
    // the seam reached the decider: by the time it answered, the signal it was handed was aborted
    expect(decider.sawAbort).toEqual([true]);
    // and NOTHING of that ask was charged or recorded — no jev.jsonl row, no decision row, no metered spend
    expect(rowsAt(h, 'intent')).toEqual([]);
    expect(h.store.decisions.filter((d) => d.stage === 'intent')).toEqual([]);
    expect(h.events.filter((e) => e.type === 'decision' && e.decision.stage === 'intent')).toEqual([]);
    // the step ran on the code order, which is the whole of I1: the outage is slower, never wrong
    const intent = h.of('intent');
    expect(intent).toHaveLength(1);
    expect(h.store.steps).toHaveLength(1);
    // the other stages of the same step are untouched — only the dropped ask lost its rows
    expect(rowsAt(h, 'risk').length).toBeGreaterThan(0);
  }, 30_000);

  it('the answer of a dropped ask can never write into the step: its `draft` mutations, its meter and its rows are all skipped', async () => {
    process.env['JEVCODE_ROUTERS'] = 'on';
    const decider = ignoresAbortDecider({ slowStage: 'intent', slowMs: RL1_INTENT_DEADLINE_MS + 150 });
    const h = await build({ mode: 'jev-on', decider, turns: TURNS(), workspace: ws(), probeGitState: repoState(), limits: { maxSteps: 1 } });
    await h.engine.run();
    // the decider has answered; give the continuation inside `askRecorded` every chance to write before reading
    await decider.slowSettled;
    await new Promise((r) => setTimeout(r, 50));
    const rec = h.store.steps[0] as StepRecord;
    // I4 in the record: the committed step carries no decision and no request from the ask it dropped
    expect(rec.decisions.some((d) => d.stage === 'intent')).toBe(false);
    expect(rec.jevRequests.some((r) => r.stage === 'intent')).toBe(false);
    // ... and the step's own `intentAnswer` is the code fallback, not the answer that arrived late
    expect(rec.intent).toBe('investigate');
    // the ask WAS made — the seam is about what it may write, not about not asking
    expect(decider.asked).toContain('intent');
    // nothing was charged that was not recorded, and the abandoned ask is in neither
    expect(h.store.jevRequests.map((r) => r.stage)).not.toContain('intent');
    expect(h.meter.snapshot().jev.calls).toBe(h.store.jevRequests.length);
    expect(rec.usage.jev.calls).toBe(rec.jevRequests.length);
  }, 30_000);

  it('with the routers OFF no ask carries a signal, and every ask is charged and recorded exactly as before (I2)', async () => {
    const decider = ignoresAbortDecider({ slowStage: 'intent', slowMs: 5 });
    const h = await build({ mode: 'jev-on', decider, turns: TURNS(), workspace: ws(), probeGitState: repoState(), limits: { maxSteps: 1 } });
    await h.engine.run();
    expect(decider.sawAbort).toEqual([false]);
    expect(rowsAt(h, 'intent')).toHaveLength(1);
    expect(h.store.steps[0]!.decisions.some((d) => d.stage === 'intent')).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------
// (b) EngineOptions.routers -> StageContext -> routersOn(ctx.mode, opt)
// ---------------------------------------------------------------------------------------

/** `StepRecord.router` exists on a step only when a router ran, which is the cleanest read of "the switch was on". */
const routed = (h: Harness): StepRecord | undefined => h.store.steps.find((r) => r.router !== undefined);

describe('(b) EngineOptions.routers reaches the stages, and the explicit option beats JEVCODE_ROUTERS', () => {
  it('`routers: "on"` alone arms them — no env var in sight', async () => {
    delete process.env['JEVCODE_ROUTERS'];
    const h = await build({ mode: 'jev-on', turns: TURNS(), workspace: ws(), probeGitState: repoState(), limits: { maxSteps: 1 }, engine: { routers: 'on' } });
    await h.engine.run();
    expect(routed(h)).toBeDefined();
  }, 30_000);

  it('`routers: "off"` DISARMS them under an exported JEVCODE_ROUTERS=on — the option wins, or an arm\'s own row is not the truth', async () => {
    process.env['JEVCODE_ROUTERS'] = 'on';
    const h = await build({ mode: 'jev-on', turns: TURNS(), workspace: ws(), probeGitState: repoState(), limits: { maxSteps: 1 }, engine: { routers: 'off' } });
    await h.engine.run();
    expect(routed(h)).toBeUndefined();
    for (const r of h.store.steps) {
      expect(r.router).toBeUndefined();
      expect(r.riskSource).toBeUndefined();
      expect(r.timing.routerWaitMs).toBeUndefined();
    }
  }, 30_000);

  it('an ABSENT option leaves the decision to the env, which is how a worker process and a bisect still express it', async () => {
    process.env['JEVCODE_ROUTERS'] = 'on';
    const h = await build({ mode: 'jev-on', turns: TURNS(), workspace: ws(), probeGitState: repoState(), limits: { maxSteps: 1 } });
    await h.engine.run();
    expect(routed(h)).toBeDefined();
  }, 30_000);

  it('the `jev-on` gate is still ahead of both: `routers: "on"` in llm-jev arms nothing (§8 control arms)', async () => {
    const h = await build({ mode: 'jev-off', turns: TURNS(), workspace: ws(), probeGitState: repoState(), limits: { maxSteps: 1 }, engine: { routers: 'on' } });
    await h.engine.run();
    expect(routed(h)).toBeUndefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------------------
// (c) commitStepRouters in the StepRecord path: the four members that had no writer, and I3
// ---------------------------------------------------------------------------------------

describe('(c) the step commit writes the router ledger, and I3 holds on a real step', () => {
  it('`StepRecord.router` and `StepTiming.routerWaitMs` are written, and `routerWaitMs` is 0 (I3)', async () => {
    const h = await build({ mode: 'jev-on', turns: TURNS(), workspace: ws(), probeGitState: repoState(), limits: { maxSteps: 2 }, engine: { routers: 'on' } });
    await h.engine.run();
    const rec = routed(h);
    expect(rec).toBeDefined();
    const router = rec!.router!;
    // a jev-on step routes RL1 (intent) and RL4 (judge); both are rows, both applied on an answering decider
    expect(router.issued).toBeGreaterThanOrEqual(2);
    expect(router.applied + router.dropped).toBe(router.issued);
    expect(router.rows.map((r) => r.id)).toContain('RL1');
    expect(router.rows.map((r) => r.id)).toContain('RL4');
    // I3, on a REAL step and not a hand-built ledger: a router contributes zero blocked wall
    expect(router.waitMs).toBe(0);
    expect(rec!.timing.routerWaitMs).toBe(0);
    // and every step that routed says so in its timing, never only in the record
    for (const r of h.store.steps) expect(r.timing.routerWaitMs === undefined).toBe(r.router === undefined);
  }, 30_000);

  it('the §2.4 audit trail is written: `riskSource` on every routed step, `jevUnavailable` when the harm ask failed', async () => {
    // Jev answers everything but `risk`, which 503s: the code verdict stands and the record says so (I1)
    const decider = createFakeDecider({ failAt: [{ stage: 'risk', status: 503 }] });
    const h = await build({ mode: 'jev-on', decider, turns: TURNS(), workspace: ws(), probeGitState: repoState(), limits: { maxSteps: 1 }, engine: { routers: 'on' } });
    await h.engine.run();
    const rec = h.store.steps[0]!;
    expect(rec.riskSource).toBe('code');
    expect(rec.jevUnavailable).toBe(true);
    // I5: a Jev outage at the gate is not a stage failure and does not end the run
    expect(rec.error).toBeUndefined();
  }, 30_000);

  it('a step that answered keeps `riskSource: "jev"` and writes no `jevUnavailable` (§5.2: absent = false)', async () => {
    const h = await build({ mode: 'jev-on', turns: TURNS(), workspace: ws(), probeGitState: repoState(), limits: { maxSteps: 1 }, engine: { routers: 'on' } });
    await h.engine.run();
    const rec = h.store.steps[0]!;
    expect(rec.riskSource).toBe('jev');
    expect(rec.jevUnavailable).toBeUndefined();
  }, 30_000);

  it('a committed step cannot be resurrected: the commit closes the step, so nothing arriving later is applied (I4)', async () => {
    process.env['JEVCODE_ROUTERS'] = 'on';
    const decider = ignoresAbortDecider({ slowStage: 'intent', slowMs: RL1_INTENT_DEADLINE_MS + 150 });
    const h = await build({ mode: 'jev-on', decider, turns: TURNS(), workspace: ws(), probeGitState: repoState(), limits: { maxSteps: 1 }, engine: { routers: 'on' } });
    await h.engine.run();
    const before = JSON.stringify(h.store.steps[0]);
    // let anything still in flight land; the written record must be the record
    await new Promise((r) => setTimeout(r, 300));
    expect(JSON.stringify(h.store.steps[0])).toBe(before);
    expect(h.store.steps[0]!.router!.dropped).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------
// (d) completionDecision at completeAfter (RL5)
// ---------------------------------------------------------------------------------------

describe('(d) RL5 — completionDecision is reached at completeAfter', () => {
  it('a step with NO evidence still completes on Jev\'s Noul, routers on or off — which is why I2 holds today (§2.5)', async () => {
    // `task_complete` above the threshold on the `done` step: in `jev-on` no proposal carries `ProposalEvidence`,
    // so `completionDecision` returns the Jev branch and the run stops `complete` exactly as it did before.
    const rule = (stage: StageName, id: string, a: Answer) => (ctx: { stage: StageName }) => (ctx.stage === stage ? { [id]: a } : undefined);
    const mk = async (routers: 'on' | 'off'): Promise<string> => {
      const h = await build({
        mode: 'jev-on',
        decider: createFakeDecider({ rules: [rule('judge', 'task_complete', noulA(0.99))] }),
        turns: TURNS(),
        workspace: ws(),
        probeGitState: repoState(),
        limits: { maxSteps: 6 },
        engine: { routers },
      });
      const r = await h.engine.run();
      return `${r.stopReason} @${h.store.steps.length}`;
    };
    const off = await mk('off');
    expect(off).toBe('complete @1');
    expect(await mk('on')).toBe(off);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------
// (e) the retry waker, keyed per in-flight request
// ---------------------------------------------------------------------------------------

describe('(e) the retry waker survives an abandoned router ask', () => {
  it('an abandoned ask settling mid-sleep does NOT clear the live call\'s waker or the shown `retrying`', async () => {
    process.env['JEVCODE_ROUTERS'] = 'on';
    let intentSettled = false;
    // intent is dropped by RL1's 250 ms deadline and answers at 450 ms anyway; context starts at ~250 ms and
    // sleeps 10 s between attempts — so the abandoned intent call settles WHILE the context call is sleeping.
    const calls: DeciderCall[] = [];
    const decider: FakeDecider & { asked: StageName[] } = {
      model: 'typesafe/jev-1.13-20260917',
      provider: 'openrouter',
      asked: [],
      calls,
      callsAt: (stage) => calls.filter((c) => c.stage === stage),
      async ask(_state: Json, questions: Record<string, Question>, opts): Promise<AskResult> {
        decider.asked.push(opts.stage);
        calls.push({ stage: opts.stage, step: opts.step, state: _state, questions });
        if (opts.stage === 'intent') {
          await new Promise((r) => setTimeout(r, RL1_INTENT_DEADLINE_MS + 200));
          intentSettled = true;
        } else if (opts.stage === 'context') {
          opts.onRetry?.({ attempt: 1, maxAttempts: 2, waitMs: 10_000, retryAfter: false, cause: { kind: 'http', status: 503, code: null, message: 'HTTP 503' } });
          await new Promise<void>((resolve) => {
            const wake = opts.wake?.();
            const t = setTimeout(resolve, 10_000);
            wake?.addEventListener('abort', () => {
              clearTimeout(t);
              resolve();
            });
          });
        }
        return { answers: answersFor(questions), usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, latencyMs: 0, model: 'typesafe/jev-1.13-20260917', requestHash: 'h', attempts: 1, id: null };
      },
    };
    const h = await build({ mode: 'jev-on', decider, turns: TURNS(), workspace: ws(), probeGitState: repoState(), limits: { maxSteps: 1 }, engine: { routers: 'on' } });
    const run = h.engine.run();
    const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
      for (let i = 0; i < ms && !cond(); i += 5) await new Promise((r) => setTimeout(r, 5));
      if (!cond()) throw new Error('condition not met');
    };
    // the context call is in its retry sleep: the shown slot is its waker
    await until(() => h.engine.status().retrying !== null);
    // ... and now the abandoned intent call settles on top of it
    await until(() => intentSettled);
    await new Promise((r) => setTimeout(r, 30));
    // the sleep the human can see is still the sleep the human can wake
    expect(h.engine.status().retrying).not.toBeNull();
    expect(h.engine.retryNow()).toBe(true);
    await run;
  }, 30_000);
});

// ---------------------------------------------------------------------------------------
// slot A's defect 11 — a hedge twin must not open a second round
// ---------------------------------------------------------------------------------------

const SAMPLE_REQ: GenerateRequest = { system: 'sys', messages: [{ role: 'user', content: 'propose' }], maxTokens: 256, temperature: 0.6 };
const SYNTH_PROPOSAL: Proposal = { goal: 'read after the round', action: { kind: 'read', paths: ['src/a.py'] }, plan: { done: [], remaining: ['fix f'], openProblems: [] }, rawText: '' };

/**
 * One sample of the round, **awaited to its end**, and then a HEDGE TWIN of it started in the window the
 * engine's own `finally` opens — the shape of slot A's defect 11. No `goalId`, so `PausePoint.llmRound.round`
 * falls back to `draft.llmRounds - 1` and the ROUND COUNTER is what the assertion reads.
 */
function twinAfterOriginSynth(latch: { ready: () => void; hold: Promise<void> }): Synthesizer {
  return {
    name: 'twin-after-origin',
    async synthesize(ctx) {
      const gen = ctx.generate;
      if (gen === undefined) throw new Error('llm-jev must expose SynthesisContext.generate');
      await gen({ ...SAMPLE_REQ, seed: 0 }, { sample: 0, purpose: 'propose_fix', signal: new AbortController().signal });
      // `generatorBatch.inFlight` is 0 on this line: the engine dropped it in `generate`'s finally, and the
      // source's `handleEnd` / `settle` — which is what marks the origin served and clears its hedge timer —
      // has not run yet. A twin fired here is the second copy of a sample of the round already open.
      await gen({ ...SAMPLE_REQ, seed: 0 }, { sample: HEDGE_TWIN_OFFSET, purpose: 'propose_fix', signal: new AbortController().signal });
      latch.ready();
      await latch.hold;
      return SYNTH_PROPOSAL;
    },
  };
}

describe("defect 11 — `noteSampleEnd` drops inFlight to 0 before the source's handleEnd", () => {
  it('a hedge twin is a second copy of a sample of the OPEN round, so its index is read back as its origin\'s', () => {
    // the structural fact the engine's guard rests on: a twin declares itself in its sample index
    expect(hedgeOriginOf(0)).toBeNull();
    expect(hedgeOriginOf(3)).toBeNull();
    expect(hedgeOriginOf(HEDGE_TWIN_OFFSET)).toBe(0);
    expect(hedgeOriginOf(HEDGE_TWIN_OFFSET + 3)).toBe(3);
  });

  it('a twin started while inFlight is 0 opens NO second round — one round per sample batch (contract 1.4 §12.0.2 P3)', async () => {
    let ready = (): void => undefined;
    let release = (): void => undefined;
    const latch = { ready: () => ready(), hold: new Promise<void>((r) => (release = r)) };
    const readyP = new Promise<void>((r) => (ready = r));
    const h = await build({
      mode: 'llm-jev',
      synthesizer: twinAfterOriginSynth(latch),
      turns: [turn({ kind: 'read', paths: ['src/a.py'] }), turn({ kind: 'read', paths: ['src/a.py'] })],
      workspace: ws(),
      probeGitState: repoState(),
      limits: { maxSteps: 1 },
    });
    const running = h.engine.run();
    await readyP;
    // the pause snapshot is taken synchronously inside pause(), while the step is still open
    h.engine.pause({ at: 'now' });
    release();
    await running;
    const cache = h.store.cache.get('step-1.json') as { llmRound: { goalId: string | null; round: number } | null };
    expect(cache.llmRound).not.toBeNull();
    // ONE round: the twin took the open batch's wall and not a round of its own. Before the guard this read 1,
    // naming a round the synthesizer never ran (and a `--replay` would resume into it).
    expect(cache.llmRound!.round).toBe(0);
  }, 30_000);
});
