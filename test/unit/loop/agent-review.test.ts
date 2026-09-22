/**
 * docs/ORCHESTRATION-DESIGN.md §2.5(c) (the parking confirmer), §4.2 **P10** and corner rows 28, 29.
 *
 * A child has no human to ask. Its `Confirmer` therefore writes the `ConfirmRequest` to
 * `<childRunDir>/orchestrate/review-<step>.json`, emits `agent:review`, and rejects with
 * `AbortError('human_pause')` → rule-1 discard → **P10**. On the next start it reads
 * `orchestration.reviewAnswerFile` — id-matched, single-use, renamed to `.used` on consumption —
 * and answers from it ONCE. Anything else parks again with `reason: 'answer not for this request'`:
 * nothing is ever auto-approved or auto-denied (row 29).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { alwaysApprove, makeEngine, riskAll, turn } from './fakes.js';
import { reviewCacheRel } from '../../../src/loop/engine.js';
import type { Json } from '../../../src/core/types.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

/** a proposal whose risk verdict is `review` */
const reviewTurn = turn({ kind: 'run', command: 'pip install x' });
const reviewRisk = { rules: [riskAll({ 2: 1 }, 1)] };

describe('§2.5(c) — the parking confirmer', () => {
  it('corner row 28: the request is written to orchestrate/review-<n>.json, agent:review is emitted, the step is a rule-1 discard', async () => {
    const h = await build({
      turns: [reviewTurn],
      deciderOptions: reviewRisk,
      // an approving confirmer is present and must NEVER be consulted in a child
      confirmer: alwaysApprove,
      engine: { orchestration: { depth: 1, slug: 'tui-rows' } },
    });
    const result = await h.engine.run();

    expect(result.stopReason).toBe('human_pause');
    expect(result.steps).toBe(0); // rule 1: the step is discarded, nothing committed
    expect(h.of('agent:review')).toHaveLength(1);
    expect(h.of('agent:review')[0]!.agent.slug).toBe('tui-rows');
    expect(h.of('agent:review')[0]!.request.id).toBe(`${h.engine.runId}:1`);

    const written = h.store.cache.get(reviewCacheRel(1));
    expect(reviewCacheRel(1)).toBe('orchestrate/review-1.json');
    expect(written).toBeDefined();
    const body = written as Record<string, Json>;
    expect(body['id']).toBe(`${h.engine.runId}:1`);
    expect(body['step']).toBe(1);
    expect(body['proposal']).toBeDefined();
    expect(body['risk']).toBeDefined();
    // the interactive confirmer was never asked, and nothing was auto-approved
    expect(h.of('confirm:resolved')[0]).toMatchObject({ approved: false, aborted: true });
    // nothing ran
    expect(h.sandbox.commands).toEqual([]);
  });

  it('P10: the PausePoint is exactly the §4.2 row', async () => {
    const h = await build({ turns: [reviewTurn], deciderOptions: reviewRisk, engine: { orchestration: { depth: 1, slug: 'tui-rows' } } });
    await h.engine.run();
    const point = h.of('pause:point')[0]?.point;
    expect(point).toEqual({
      step: 1,
      round: null,
      phase: 'risk',
      reason: 'review-needed',
      resumableAt: 'cache/step-1.json',
      replayable: true, // proposal !== null
      by: 'self',
      end: false,
    });
  });

  it('a depth-0 parent and a plain run are unaffected: the real confirmer answers', async () => {
    const h = await build({ turns: [reviewTurn], deciderOptions: reviewRisk, confirmer: alwaysApprove, limits: { maxSteps: 1 } });
    const result = await h.engine.run();
    expect(result.stopReason).not.toBe('human_pause');
    expect(h.of('agent:review')).toHaveLength(0);
    expect(h.store.cache.has(reviewCacheRel(1))).toBe(false);

    const parent = await build({ turns: [reviewTurn], deciderOptions: reviewRisk, confirmer: alwaysApprove, limits: { maxSteps: 1 }, engine: { orchestration: { depth: 0 } } });
    await parent.engine.run();
    expect(parent.of('agent:review')).toHaveLength(0);
  });
});

describe('§2.5(c) / corner row 29 — the answer file is id-matched, single-use and renamed', () => {
  const answerRel = 'orchestrate/review-answer.json';

  async function withAnswer(answer: Json | null, over: Record<string, unknown> = {}): Promise<Harness> {
    const h = await build({
      turns: [reviewTurn, turn({ kind: 'done', summary: 'after the review' })],
      deciderOptions: reviewRisk,
      limits: { maxSteps: 2 },
      engine: { orchestration: { depth: 1, slug: 'tui-rows', reviewAnswerFile: answerRel, ...over } },
    });
    if (answer !== null) h.store.cache.set(answerRel, answer);
    return h;
  }

  it('an id-matched approval answers the confirm ONCE and the file is renamed to .used', async () => {
    const h = await withAnswer(null);
    // the id the child will build for step 1
    h.store.cache.set(answerRel, { id: `${h.engine.runId}:1`, approved: true, by: 'prateek', at: '2026-09-22T00:00:00.000Z', note: 'go ahead' });
    const result = await h.engine.run();

    expect(h.of('agent:review')).toHaveLength(0);
    expect(h.of('confirm:resolved')[0]).toMatchObject({ approved: true, aborted: false, note: 'go ahead' });
    expect(h.store.steps[0]!.outcome?.status).toBe('executed');
    expect(result.stopReason).not.toBe('human_pause');
    // single-use: consumed and renamed
    expect(h.store.cache.has(answerRel)).toBe(false);
    expect(h.store.cache.has(`${answerRel}.used`)).toBe(true);
  });

  it('an id-matched DENIAL is honoured as a decline — never auto-approved', async () => {
    const h = await withAnswer(null);
    h.store.cache.set(answerRel, { id: `${h.engine.runId}:1`, approved: false, by: 'prateek', at: '2026-09-22T00:00:00.000Z' });
    await h.engine.run();
    expect(h.store.steps[0]!.outcome?.status).toBe('declined');
    expect(h.sandbox.commands).toEqual([]);
  });

  it('an id-MISMATCHED answer parks again with `answer not for this request` and is NOT consumed', async () => {
    const h = await withAnswer({ id: 'some-other-run:7', approved: true, by: 'x', at: 'y' });
    const result = await h.engine.run();
    expect(result.stopReason).toBe('human_pause');
    expect(h.of('agent:review')).toHaveLength(1);
    const body = h.store.cache.get(reviewCacheRel(1)) as Record<string, Json>;
    expect(body['reason']).toBe('answer not for this request');
    expect(h.store.cache.has(answerRel)).toBe(true); // a foreign answer is left alone
  });

  it('a MISSING or malformed answer file is row 29 too: `answer not for this request`, nothing auto-decided', async () => {
    const missing = await withAnswer(null);
    const r1 = await missing.engine.run();
    expect(r1.stopReason).toBe('human_pause');
    expect((missing.store.cache.get(reviewCacheRel(1)) as Record<string, Json>)['reason']).toBe('answer not for this request');

    const malformed = await withAnswer({ id: 42, approved: 'yes' });
    await malformed.engine.run();
    expect((malformed.store.cache.get(reviewCacheRel(1)) as Record<string, Json>)['reason']).toBe('answer not for this request');
    expect(malformed.sandbox.commands).toEqual([]);
  });

  it('no reviewAnswerFile at all parks with `no answer file: a human decision is needed`', async () => {
    const h = await build({ turns: [reviewTurn], deciderOptions: reviewRisk, engine: { orchestration: { depth: 1, slug: 's' } } });
    await h.engine.run();
    expect((h.store.cache.get(reviewCacheRel(1)) as Record<string, Json>)['reason']).toBe('no answer file: a human decision is needed');
  });
});

describe('[G7] — the engine side of the parking blocker', () => {
  it('a BlockingRequest in a child resolves to `pause` with an injected parking blocker (exit 4, resumable)', async () => {
    const seen: string[] = [];
    const h = await build({
      turns: [turn({ kind: 'done', summary: 'x' })],
      deciderOptions: { failAt: [{ stage: 'intent', status: 401 }] },
      engine: {
        orchestration: { depth: 1, slug: 'tui-rows' },
        // exactly the blocker §2.5(d) / [G7] asks `src/cli/session.ts` to install for a depth-1 run:
        // non-interactive, answers 'pause' for EVERY BlockingKind
        blocker: async (req) => {
          seen.push(req.kind);
          return 'pause';
        },
      },
    });
    const result = await h.engine.run();
    expect(seen.length).toBeGreaterThan(0);
    expect(h.of('blocking:resolved')[0]?.answer).toBe('pause');
    expect(result.stopReason).toBe('human_pause');
    const end = h.of('run:end')[0]!;
    expect(end.exitCode).toBe(4);
    expect(end.resumable).toBe(true);
  });

  it('WITHOUT a blocker the same child STOPS — this is the [G7] hole that `src/cli/session.ts` must close', async () => {
    const h = await build({
      turns: [turn({ kind: 'done', summary: 'x' })],
      deciderOptions: { failAt: [{ stage: 'intent', status: 401 }] },
      engine: { orchestration: { depth: 1, slug: 'tui-rows' } },
    });
    const result = await h.engine.run();
    expect(h.of('blocking:resolved')[0]?.answer).toBe('stop');
    expect(result.stopReason).not.toBe('human_pause');
  });
});
