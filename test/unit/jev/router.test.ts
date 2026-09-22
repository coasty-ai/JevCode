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
import { describe, expect, it } from 'vitest';
import { JevHttpError } from '../../../src/errors.js';
import { ROUTER_DEADLINE_MS, createStepToken, emptyRouterLedger, invalidateStepToken, noteRoute, routeSpeculative, routersEnabled } from '../../../src/jev/router.js';

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

  it('an aborted step signal drops too, and the ask is aborted with the step', async () => {
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
    step.abort(new Error('step over'));
    const r = await p;
    expect(r).toMatchObject({ source: 'code', dropped: true, drop: 'aborted' });
    expect(sawAbort).toBe(true);
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
