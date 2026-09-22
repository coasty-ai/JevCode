/**
 * `routeSpeculative` — the router primitive of docs/LLM-LOOP-DESIGN.md §2.1 (contract 1.9 "Fastlane" S4).
 *
 * The four invariants this file exists to pin:
 *   I1  a Jev failure is slower, never wrong: every failure mode is ONE branch, `dropped`, with the code order
 *       standing and nothing thrown;
 *   I3  `waitMs` is 0 — the router holds the step for nothing beyond the ask the step was making anyway, and it
 *       stops waiting at the deadline;
 *   I4  an answer that lands after step commit (an invalidated `StepToken`) is recorded dropped and applied to
 *       nothing;
 *   and the ordering rule: `dispatch(codeOrder[0])` runs before anything is awaited.
 */
import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AbortError, BudgetError, JevHttpError, JevModelDriftError } from '../../../src/errors.js';
import { QuestionBuildError } from '../../../src/jev/questions.js';
import { ROUTER_DEADLINE_MS, ROUTER_SETTLE_SLACK_MS, createStepToken, emptyRouterLedger, invalidateStepToken, noteRoute, routeSpeculative, routersEnabled } from '../../../src/jev/router.js';

const never = (): Promise<readonly string[]> => new Promise<readonly string[]>(() => undefined);
const after = <T>(ms: number, v: T): Promise<T> => new Promise<T>((r) => setTimeout(() => r(v), ms));

describe('routeSpeculative: the code order is the step', () => {
  it('dispatch(codeOrder[0]) runs in THIS tick, before the ask is awaited', async () => {
    const order: string[] = [];
    const p = routeSpeculative<string>({
      id: 'RL1',
      token: createStepToken(1),
      codeOrder: ['code'],
      dispatch: (item) => {
        order.push(`dispatch:${item}`);
      },
      ask: async () => {
        order.push('ask');
        return ['jev'];
      },
    });
    // both happened synchronously, in this tick, and the dispatch came first: the step is already running the
    // code order when the request leaves
    expect(order).toEqual(['dispatch:code', 'ask']);
    const r = await p;
    expect(r).toMatchObject({ source: 'jev', dropped: false, waitMs: 0, id: 'RL1', drop: null });
    expect(r.order).toEqual(['jev']);
  });

  it('an empty code order is a programming error, not a drop: the code order IS the step', async () => {
    await expect(routeSpeculative<string>({ id: 'RL1', token: createStepToken(1), codeOrder: [], ask: async () => ['jev'] })).rejects.toThrow(/codeOrder must be non-empty/);
  });
});

describe('the one failure branch (§2.1 clause 4)', () => {
  const cases: readonly [string, () => Promise<readonly string[] | null>, string][] = [
    ['a deadline', never, 'deadline'],
    ['a JevError', () => Promise.reject(new JevHttpError('no healthy upstream', { status: 503, retryable: true })), 'error'],
    ['a plain throw', () => Promise.reject(new Error('boom')), 'error'],
    ['no opinion (null)', async () => null, 'empty'],
    ['an empty answer', async () => [], 'empty'],
  ];
  for (const [name, ask, drop] of cases) {
    it(`${name} drops to the code order, throws nothing, and reports waitMs 0`, async () => {
      const r = await routeSpeculative<string>({ id: 'RL4', token: createStepToken(3), codeOrder: ['code', 'tail'], ask, deadlineMs: 10 });
      expect(r.order).toEqual(['code', 'tail']);
      expect(r).toMatchObject({ source: 'code', dropped: true, appliedAt: null, waitMs: 0, drop });
    });
  }

  it('an aborted step signal is NOT one of Jev\'s failures: it is rethrown, and the ask is aborted with the step', async () => {
    // review 2026-09-22 defect 5: a human pause, `/stop` and the wall-time BudgetError all abort the step signal.
    // Swallowing them into the drop branch is how an aborted run keeps running stages; with routers OFF the stage
    // rejects, so with routers ON it must too. Only JEV's own failures are the one drop branch.
    const step = new AbortController();
    let sawAbort = false;
    const p = routeSpeculative<string>({
      id: 'RL6',
      token: createStepToken(4),
      codeOrder: ['code'],
      signal: step.signal,
      deadlineMs: 5_000,
      ask: (signal) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
        });
        return never();
      },
    });
    step.abort(new AbortError('human_pause'));
    await expect(p).rejects.toBeInstanceOf(AbortError);
    await expect(p).rejects.toMatchObject({ reason: 'human_pause' });
    expect(sawAbort).toBe(true);
  });

  it('a signal aborted BEFORE the call is rethrown too, and the ask is never issued past the first tick', async () => {
    const step = new AbortController();
    step.abort(new AbortError('human_abort'));
    await expect(
      routeSpeculative<string>({ id: 'RL1', token: createStepToken(4), codeOrder: ['code'], signal: step.signal, ask: never }),
    ).rejects.toMatchObject({ reason: 'human_abort' });
  });

  it('the deadline is a ceiling on the wait, not on the request: the step moves on while the ask is still in flight', async () => {
    let settled = false;
    const t0 = Date.now();
    const r = await routeSpeculative<string>({
      id: 'RL1',
      token: createStepToken(5),
      codeOrder: ['code'],
      deadlineMs: 20,
      ask: async () => {
        await after(400, null);
        settled = true;
        return ['late'];
      },
    });
    expect(Date.now() - t0).toBeLessThan(300);
    expect(r).toMatchObject({ dropped: true, drop: 'deadline', waitMs: 0 });
    expect(settled).toBe(false);
  });
});

describe('I4: a step-scoped token', () => {
  it('an answer landing after step commit is recorded dropped and applied to nothing', async () => {
    const token = createStepToken(7);
    const applied: string[] = [];
    const p = routeSpeculative<string>({
      id: 'RL1',
      token,
      codeOrder: ['code'],
      deadlineMs: 5_000,
      ask: async () => {
        await after(20, null);
        return ['jev'];
      },
    });
    // the step commits while the ask is in flight
    invalidateStepToken(token);
    const r = await p;
    for (const item of r.order) if (r.source === 'jev') applied.push(item);
    expect(r).toMatchObject({ source: 'code', dropped: true, drop: 'committed', appliedAt: null });
    expect(r.order).toEqual(['code']);
    expect(applied).toEqual([]);
  });

  it('a valid token applies the answer and stamps appliedAt from the injected clock', async () => {
    const r = await routeSpeculative<string>({ id: 'RS2', token: createStepToken(8), codeOrder: ['code'], ask: async () => ['a', 'b'], now: () => 1234 });
    expect(r).toMatchObject({ source: 'jev', dropped: false, appliedAt: 1234 });
    expect(r.order).toEqual(['a', 'b']);
  });
});

describe('dispatched work ends the race (§2.1 clause 3)', () => {
  it('an answer that lands after the in-flight item settled is too late to re-order anything', async () => {
    const r = await routeSpeculative<string>({
      id: 'RS4',
      token: createStepToken(9),
      codeOrder: ['code'],
      deadlineMs: 5_000,
      dispatch: () => after(5, 'done'),
      ask: async () => {
        await after(60, null);
        return ['jev'];
      },
    });
    expect(r).toMatchObject({ source: 'code', dropped: true, drop: 'work_settled' });
  });
});

describe('the ledger and the switch', () => {
  it('noteRoute counts issued / applied / dropped and keeps waitMs at 0', async () => {
    const ledger = emptyRouterLedger();
    noteRoute(ledger, await routeSpeculative<string>({ id: 'RL1', token: createStepToken(1), codeOrder: ['c'], ask: async () => ['j'] }));
    noteRoute(ledger, await routeSpeculative<string>({ id: 'RL6', token: createStepToken(1), codeOrder: ['c'], ask: never, deadlineMs: 5 }));
    expect(ledger).toMatchObject({ issued: 2, applied: 1, dropped: 1, waitMs: 0 });
    expect(ledger.rows.map((r) => `${r.id}:${r.source}`)).toEqual(['RL1:jev', 'RL6:code']);
  });

  it('routersEnabled: off by default, on by option, and the env override wins both ways', () => {
    expect(routersEnabled(undefined, {})).toBe(false);
    expect(routersEnabled('off', {})).toBe(false);
    expect(routersEnabled('on', {})).toBe(true);
    expect(routersEnabled('off', { JEVCODE_ROUTERS: 'on' })).toBe(true);
    expect(routersEnabled('on', { JEVCODE_ROUTERS: 'off' })).toBe(false);
    expect(routersEnabled('on', { JEVCODE_ROUTERS: 'nonsense' })).toBe(true);
    expect(ROUTER_DEADLINE_MS).toBe(400);
  });
});

describe('the router leaks nothing, cancels what it drops, and measures what it held (review 2026-09-22)', () => {
  it('defect 1: a run-scoped step signal collects no listeners — 20 routed asks leave zero', async () => {
    const run = new AbortController();
    for (let i = 0; i < 20; i += 1) {
      const r = await routeSpeculative<string>({ id: 'RL1', token: createStepToken(i), codeOrder: ['code'], signal: run.signal, deadlineMs: 5_000, ask: async () => ['jev'] });
      expect(r.source).toBe('jev');
    }
    // one `abort` listener per routed ask, never removed, was the leak: a 40-step run put ~120 on this signal,
    // past Node's max-listeners warning, each retaining a never-settled race promise and its closure.
    expect(getEventListeners(run.signal, 'abort').length).toBe(0);
  });

  it('defect 1: the deadline drop removes its listeners too', async () => {
    const run = new AbortController();
    for (let i = 0; i < 5; i += 1) {
      const r = await routeSpeculative<string>({ id: 'RL4', token: createStepToken(i), codeOrder: ['code'], signal: run.signal, deadlineMs: 5, ask: never });
      expect(r.drop).toBe('deadline');
    }
    expect(getEventListeners(run.signal, 'abort').length).toBe(0);
  });

  it('defect 2: a dropped ask is CANCELLED — the router aborts the signal it handed the thunk', async () => {
    let handed: AbortSignal | null = null;
    const r = await routeSpeculative<string>({
      id: 'RL1',
      token: createStepToken(1),
      codeOrder: ['code'],
      deadlineMs: 10,
      ask: (signal) => {
        handed = signal;
        return never();
      },
    });
    expect(r.drop).toBe('deadline');
    const signal = handed as unknown as AbortSignal;
    // nothing cancelled the dropped ask before this: it ran to completion and kept writing (askRecorded mutates
    // the draft, the meter, jev.jsonl and decisions.jsonl) long after the step that issued it had committed
    expect(signal.aborted).toBe(true);
    expect(String((signal.reason as Error).message)).toContain('RL1');
  });

  it('defect 2: a committed token cancels the in-flight ask as well', async () => {
    const token = createStepToken(7);
    let handed: AbortSignal | null = null;
    const p = routeSpeculative<string>({
      id: 'RL6',
      token,
      codeOrder: ['code'],
      deadlineMs: 5_000,
      ask: (signal) => {
        handed = signal;
        return after(10, ['jev']);
      },
    });
    invalidateStepToken(token);
    const r = await p;
    expect(r.drop).toBe('committed');
    expect((handed as unknown as AbortSignal).aborted).toBe(true);
  });

  it('defect 2: an APPLIED answer is not cancelled', async () => {
    let handed: AbortSignal | null = null;
    const r = await routeSpeculative<string>({
      id: 'RL1',
      token: createStepToken(1),
      codeOrder: ['code'],
      ask: (signal) => {
        handed = signal;
        return Promise.resolve(['jev']);
      },
    });
    expect(r.source).toBe('jev');
    expect((handed as unknown as AbortSignal).aborted).toBe(false);
  });

  const fatals: readonly [string, () => unknown][] = [
    ['an AbortError (human pause, /stop)', () => new AbortError('human_pause')],
    ['a wall-time BudgetError', () => new BudgetError('wall_time')],
    ['a JevModelDriftError', () => new JevModelDriftError('jev-1.13', 'jev-1.12', { firstCall: false })],
    ['a QuestionBuildError', () => new QuestionBuildError('criteria.true.examples needs at least two examples')],
  ];
  for (const [name, make] of fatals) {
    it(`defect 5: ${name} is rethrown, not collapsed into drop:'error'`, async () => {
      const thrown = make();
      await expect(
        routeSpeculative<string>({ id: 'RL4', token: createStepToken(2), codeOrder: ['code'], deadlineMs: 5_000, ask: () => Promise.reject(thrown) }),
      ).rejects.toBe(thrown);
    });
  }

  it("defect 5: Jev's OWN failures stay one silent drop branch", async () => {
    for (const e of [new JevHttpError('no healthy upstream', { status: 503, retryable: true }), new Error('boom'), new TypeError('malformed')]) {
      const r = await routeSpeculative<string>({ id: 'RL4', token: createStepToken(2), codeOrder: ['code'], deadlineMs: 5_000, ask: () => Promise.reject(e) });
      expect(r).toMatchObject({ source: 'code', dropped: true, drop: 'error' });
    }
  });

  it('defect 7 (I3): waitMs is MEASURED — held wall minus the ask the step was making anyway', async () => {
    // an answer at ~40 ms: the router held the step for the ask and for nothing else
    const applied = await routeSpeculative<string>({ id: 'RL1', token: createStepToken(1), codeOrder: ['code'], deadlineMs: 5_000, ask: () => after(40, ['jev']) });
    expect(applied.source).toBe('jev');
    expect(applied.heldMs).toBeGreaterThanOrEqual(30);
    expect(applied.waitMs).toBe(0);
    // and a 300 ms ask behind a 20 ms deadline: the router held 20 ms, not 300 — the deadline is a CEILING on
    // the wall, which is the half of I3 a hard-coded `waitMs: 0` could never have shown
    const dropped = await routeSpeculative<string>({ id: 'RL1', token: createStepToken(2), codeOrder: ['code'], deadlineMs: 20, ask: () => after(300, ['late']) });
    expect(dropped.drop).toBe('deadline');
    expect(dropped.heldMs).toBeGreaterThanOrEqual(10);
    expect(dropped.heldMs).toBeLessThan(250);
    expect(dropped.waitMs).toBe(0);
  });

  it('defect 7 (I3): a router that waits PAST its own ask reports it — the assertion can fail', async () => {
    // the measurement is falsifiable by construction: `dispatch` work that settles after the answer keeps the
    // race open, and the wall past the answer is exactly what routerWaitMs is defined to count.
    const r = await routeSpeculative<string>({
      id: 'RS4',
      token: createStepToken(3),
      codeOrder: ['code'],
      deadlineMs: 5_000,
      now: (() => {
        let t = 0;
        // entry 0, ask settles at 10, route resolves at 60: 50 ms of wall the router held beyond the ask
        const stamps = [0, 10, 60, 60];
        return () => stamps[Math.min(t++, stamps.length - 1)]!;
      })(),
      ask: async () => ['jev'],
    });
    expect(r.waitMs).toBe(50 - ROUTER_SETTLE_SLACK_MS);
  });
});
