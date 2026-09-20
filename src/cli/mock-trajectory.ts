/**
 * Scripted generator turns for offline runs (`--mock`, perf, tests): a cycle of
 * write -> read -> run -> edit that touches only files it created, ending with `done`.
 * Every turn is a tool call so the tool-calling path is what gets measured.
 */
import type { Action, MockTurn, PlanDraft } from '../core/types.js';

function turn(goal: string, action: Action, plan: PlanDraft): MockTurn {
  return {
    text: `${goal}\n`,
    toolCall: { name: 'propose_action', input: { goal, action: action as unknown as Record<string, string>, plan } as never, rawJson: JSON.stringify({ goal, action, plan }) },
    usage: { inputTokens: 1200, outputTokens: 150, costUsd: 0, calls: 1 },
  };
}

export function mockTrajectory(steps: number): MockTurn[] {
  const turns: MockTurn[] = [];
  const remaining = ['create the scratch module', 'exercise it', 'verify with a command'];
  for (let i = 0; i < Math.max(1, steps - 1); i++) {
    const k = i % 4;
    const plan: PlanDraft = { done: [], remaining, openProblems: [] };
    if (k === 0) turns.push(turn(`Create scratch_${i}.py`, { kind: 'write', path: `scratch_${i}.py`, content: `VALUE_${i} = ${i}\n` }, plan));
    else if (k === 1) turns.push(turn(`Read scratch_${i - 1}.py`, { kind: 'read', paths: [`scratch_${i - 1}.py`] }, plan));
    else if (k === 2) turns.push(turn('Check the shell works', { kind: 'run', command: `printf 'ok %s\\n' ${i}` }, plan));
    else turns.push(turn(`Edit scratch_${i - 3}.py`, { kind: 'edit', path: `scratch_${i - 3}.py`, old: `VALUE_${i - 3} = ${i - 3}`, new: `VALUE_${i - 3} = ${i}` }, plan));
  }
  turns.push(turn('All done', { kind: 'done', summary: 'scratch work complete' }, { done: remaining, remaining: [], openProblems: [] }));
  return turns;
}
