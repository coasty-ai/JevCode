/**
 * The agent's in-run Jev placements (docs/AGENT-LOOP-DESIGN.md §13, §A4): RA0 the first-turn effort hint, RA1 the
 * loop-nudge wording, RA2 the progress check. Each falls back to its code answer on a deadline, an error, a drift and an
 * absent decider, applies an in-time answer, and never rejects except on the run's own abort. This file is the fallback
 * test every `jev-contract` block in src/agent/jev.ts names.
 */
import { describe, expect, it } from 'vitest';
import type { Answer } from '../../../src/core/types.js';
import { AbortError, JevHttpError, JevModelDriftError } from '../../../src/errors.js';
import { QuestionBuildError } from '../../../src/jev/questions.js';
import { chooseLoopNudge, effortHint, progressCheck, type RunFacts } from '../../../src/agent/jev.js';
import { initialState, type AgentStateV1 } from '../../../src/agent/state.js';
import { createAgentContext, type AskCall, type FakeAgentOptions } from './helpers.js';

const facts: RunFacts = { recentSteps: ['act: bash npm test (exit 1)', 'act: bash npm test (exit 1)'], lastTests: { passed: 2, failed: 1, errors: 0 }, testTrend: ['2p/1f', '2p/1f'], changedFiles: 1, filesRead: 3, filesEdited: 1 };
const trip = { rule: 'repeat', tool: 'bash', count: 3 };

const noul = (p: number): Answer => ({ type: 'noul', noul: p });
const choice = (c: string): Answer => ({ type: 'choice', choice: c, probabilities: { [c]: 0.9 }, confidence: 0.8 });
const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

function setup(ask: FakeAgentOptions['ask'], o: Partial<FakeAgentOptions> = {}): { ctx: ReturnType<typeof createAgentContext>; state: AgentStateV1 } {
  return { ctx: createAgentContext({ jevAvailable: true, ...(ask !== undefined ? { ask } : {}), ...o }), state: initialState('h') };
}

describe('RA1 chooseLoopNudge', () => {
  it('applies an in-time answer, asking one choice over the four wordings with the escape, and no tool output', async () => {
    const { ctx, state } = setup(async () => ({ loop_nudge: choice('fix_environment') }));
    expect(await chooseLoopNudge(ctx, state, trip, facts)).toBe('fix_environment');
    expect(ctx.asks).toHaveLength(1);
    const q = ctx.asks[0]!.questions['loop_nudge']!;
    expect(q.type).toBe('choice');
    expect(Object.keys(q.type === 'choice' ? q.criteria : {})).toEqual(['change_approach', 'gather_context', 'fix_environment', 'revert_changes', 'none_of_these']);
    expect(ctx.asks[0]!.state).toEqual({ trip: { rule: 'repeat', tool: 'bash', count: 3 }, recent_steps: facts.recentSteps, last_tests: facts.lastTests, changed_files: 1 });
  });

  it('the escape option keeps change_approach', async () => {
    const { ctx, state } = setup(async () => ({ loop_nudge: choice('none_of_these') }));
    expect(await chooseLoopNudge(ctx, state, trip, facts)).toBe('change_approach');
  });

  it('falls back to change_approach past the 400 ms deadline', async () => {
    const { ctx, state } = setup(async (_c, signal) => {
      await wait(2_000, signal);
      return { loop_nudge: choice('gather_context') };
    });
    const t0 = Date.now();
    expect(await chooseLoopNudge(ctx, state, trip, facts)).toBe('change_approach');
    expect(Date.now() - t0).toBeLessThan(1_500);
  });

  it('falls back on a Jev error', async () => {
    const { ctx, state } = setup(async () => {
      throw new JevHttpError('Jev HTTP 503', { status: 503, retryable: true });
    });
    expect(await chooseLoopNudge(ctx, state, trip, facts)).toBe('change_approach');
    expect(state.jevDisabled).toBe(false);
  });

  it('a drift falls back, disables Jev for the run and says so once', async () => {
    const { ctx, state } = setup(async () => {
      throw new JevModelDriftError('typesafe/jev-1.13-20260917', 'typesafe/jev-1.14', { firstCall: false });
    });
    expect(await chooseLoopNudge(ctx, state, trip, facts)).toBe('change_approach');
    expect(state.jevDisabled).toBe(true);
    expect(ctx.eventsOf('transcript').map((e) => e.text)).toEqual(["Jev served typesafe/jev-1.14 instead of typesafe/jev-1.13-20260917; the agent's quick Jev hints (RA1) are off for the rest of this run"]);
    // disabled: no further ask
    expect(await chooseLoopNudge(ctx, state, trip, facts)).toBe('change_approach');
    expect(ctx.asks).toHaveLength(1);
  });

  it('a question-build error is treated like a drift', async () => {
    const { ctx, state } = setup(async () => {
      throw new QuestionBuildError('bad batch');
    });
    expect(await chooseLoopNudge(ctx, state, trip, facts)).toBe('change_approach');
    expect(state.jevDisabled).toBe(true);
  });

  it('asks nothing when Jev is absent', async () => {
    const { ctx, state } = setup(async () => ({ loop_nudge: choice('gather_context') }), { jevAvailable: false });
    expect(await chooseLoopNudge(ctx, state, trip, facts)).toBe('change_approach');
    expect(ctx.asks).toHaveLength(0);
  });

  it('the run’s own abort propagates', async () => {
    const { ctx, state } = setup(async (_c, signal) => {
      await wait(2_000, signal);
      return {};
    });
    const p = chooseLoopNudge(ctx, state, trip, facts);
    ctx.abort(new AbortError('human_pause'));
    await expect(p).rejects.toBeInstanceOf(AbortError);
  });
});

describe('RA2 progressCheck', () => {
  it('adds the hint at P(unproductive) ≥ 0.9 and not below', async () => {
    const hi = setup(async () => ({ unproductive: noul(0.95) }));
    expect(await progressCheck(hi.ctx, hi.state, facts)).toBe(true);
    const lo = setup(async () => ({ unproductive: noul(0.85) }));
    expect(await progressCheck(lo.ctx, lo.state, facts)).toBe(false);
    const q = hi.ctx.asks[0]!;
    expect(q.questions['unproductive']!.type).toBe('noul');
    expect(Object.keys(q.state)).toEqual(['task', 'recent_steps', 'files_read', 'files_edited', 'test_trend', 'todos']);
  });

  it('falls back to no hint on a deadline, an error, a drift and an absent decider', async () => {
    const slow = setup(async (_c, signal) => {
      await wait(2_000, signal);
      return { unproductive: noul(1) };
    });
    expect(await progressCheck(slow.ctx, slow.state, facts)).toBe(false);
    const error = setup(async () => {
      throw new JevHttpError('Jev HTTP 500', { status: 500, retryable: true });
    });
    expect(await progressCheck(error.ctx, error.state, facts)).toBe(false);
    const drift = setup(async () => {
      throw new JevModelDriftError('a', 'b', { firstCall: false });
    });
    expect(await progressCheck(drift.ctx, drift.state, facts)).toBe(false);
    expect(drift.state.jevDisabled).toBe(true);
    const absent = setup(undefined, { jevAvailable: false });
    expect(await progressCheck(absent.ctx, absent.state, facts)).toBe(false);
    expect(absent.ctx.asks).toHaveLength(0);
  });

  it('a malformed answer is no opinion', async () => {
    const { ctx, state } = setup(async () => ({ unproductive: choice('x') }));
    expect(await progressCheck(ctx, state, facts)).toBe(false);
  });
});

describe('what the placements send', () => {
  it('the task, the chat turns and the recent steps reach Jev redacted, as they reach the generator', async () => {
    const key = 'sk-secret-abc123';
    const withKey: RunFacts = { ...facts, recentSteps: [`act: bash curl -H "x: ${key}" (exit 0)`] };
    const { ctx, state } = setup(async () => ({ conversational: noul(0.1), unproductive: noul(0.1), loop_nudge: choice('change_approach') }), { task: `use ${key} to call the api`, conversation: { chat: [{ role: 'you', text: `my key is ${key}` }], parent: null } });
    await effortHint(ctx, state);
    await chooseLoopNudge(ctx, state, trip, withKey);
    await progressCheck(ctx, state, withKey);
    expect(ctx.asks).toHaveLength(3);
    for (const a of ctx.asks) expect(JSON.stringify(a.state)).not.toContain(key);
    expect(ctx.asks[0]!.state['message']).toBe('use [REDACTED] to call the api');
  });
});

describe('RA0 effortHint', () => {
  it('reads the message and the last two chat turns, and applies p ≥ 0.8', async () => {
    const { ctx, state } = setup(async (c: AskCall) => ({ conversational: noul(c.state['message'] === 'hi' ? 0.95 : 0.1) }), { task: 'hi', conversation: { chat: [{ role: 'you', text: 'a' }, { role: 'jevcode', text: 'b' }, { role: 'you', text: 'c' }], parent: null } });
    expect(await effortHint(ctx, state)).toBe(true);
    expect(ctx.asks[0]!.state).toEqual({ message: 'hi', recent_turns: ['jevcode: b', 'you: c'] });
    const task = setup(async () => ({ conversational: noul(0.79) }), { task: 'fix the failing tests' });
    expect(await effortHint(task.ctx, task.state)).toBe(false);
  });

  it('falls back to the default effort past the 300 ms deadline, on an error and without Jev', async () => {
    const slow = setup(async (_c, signal) => {
      await wait(350, signal);
      return { conversational: noul(1) };
    });
    expect(await effortHint(slow.ctx, slow.state)).toBe(false);
    const error = setup(async () => {
      throw new Error('boom');
    });
    expect(await effortHint(error.ctx, error.state)).toBe(false);
    const absent = setup(undefined, { jevAvailable: false });
    expect(await effortHint(absent.ctx, absent.state)).toBe(false);
    expect(absent.ctx.asks).toHaveLength(0);
  });

  it('a drift falls back to the default effort and disables Jev for the run', async () => {
    const { ctx, state } = setup(async () => {
      throw new JevModelDriftError('a', 'b', { firstCall: true });
    });
    expect(await effortHint(ctx, state)).toBe(false);
    expect(state.jevDisabled).toBe(true);
    expect(ctx.eventsOf('transcript')[0]!.text).toContain('(RA0) are off for the rest of this run');
  });
});
