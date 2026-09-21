/**
 * Scripted generator turns for offline runs (`--mock`, perf, tests): a cycle of
 * write -> read -> run -> edit that touches only files it created, ending with `done`.
 * Every turn is a tool call so the tool-calling path is what gets measured.
 *
 * Step pacing (TUI-DESIGN §18, `src/perf/render-lag.ts`): `JEVCODE_MOCK_STEP_MS=<ms>` gives every turn that
 * `latencyMs` (`MockTurn.latencyMs`, honoured by `src/provider/mock.ts` as one awaited sleep before the delta), so a
 * mocked run paces its steps — `200` is about 5 steps/s with the instant mock decider, still ten times faster than a
 * real run. Unset, empty or not a whole number → 0, today's zero-latency behaviour, so every existing test and smoke is
 * unchanged. Read here rather than in `buildProvider` (`src/cli/session.ts`) because this is the one seam every `--mock`
 * provider goes through; `mockTrajectory(steps, latencyMs)` takes the value explicitly for callers with their own env.
 */
import type { Action, MockTurn, PlanDraft } from '../core/types.js';

/** `JEVCODE_MOCK_STEP_MS` as a non-negative whole number of milliseconds; 0 when unset or malformed. */
export function mockStepMs(env: NodeJS.ProcessEnv): number {
  const v = env['JEVCODE_MOCK_STEP_MS'];
  if (v === undefined) return 0;
  const t = v.trim();
  if (!/^\d+$/.test(t)) return 0;
  return Number(t);
}

function turn(goal: string, action: Action, plan: PlanDraft, latencyMs: number): MockTurn {
  return {
    text: `${goal}\n`,
    toolCall: { name: 'propose_action', input: { goal, action: action as unknown as Record<string, string>, plan } as never, rawJson: JSON.stringify({ goal, action, plan }) },
    usage: { inputTokens: 1200, outputTokens: 150, costUsd: 0, calls: 1 },
    ...(latencyMs > 0 ? { latencyMs } : {}),
  };
}

export function mockTrajectory(steps: number, latencyMs: number = mockStepMs(process.env)): MockTurn[] {
  const turns: MockTurn[] = [];
  const remaining = ['create the scratch module', 'exercise it', 'verify with a command'];
  for (let i = 0; i < Math.max(1, steps - 1); i++) {
    const k = i % 4;
    const plan: PlanDraft = { done: [], remaining, openProblems: [] };
    if (k === 0) turns.push(turn(`Create scratch_${i}.py`, { kind: 'write', path: `scratch_${i}.py`, content: `VALUE_${i} = ${i}\n` }, plan, latencyMs));
    else if (k === 1) turns.push(turn(`Read scratch_${i - 1}.py`, { kind: 'read', paths: [`scratch_${i - 1}.py`] }, plan, latencyMs));
    else if (k === 2) turns.push(turn('Check the shell works', { kind: 'run', command: `printf 'ok %s\\n' ${i}` }, plan, latencyMs));
    else turns.push(turn(`Edit scratch_${i - 3}.py`, { kind: 'edit', path: `scratch_${i - 3}.py`, old: `VALUE_${i - 3} = ${i - 3}`, new: `VALUE_${i - 3} = ${i}` }, plan, latencyMs));
  }
  turns.push(turn('All done', { kind: 'done', summary: 'scratch work complete' }, { done: remaining, remaining: [], openProblems: [] }, latencyMs));
  return turns;
}
