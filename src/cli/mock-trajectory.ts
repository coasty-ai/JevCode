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

/**
 * TUI-DESIGN-4 §6.9: `JEVCODE_MOCK_PATCH=1` extends the cycle with two `patch` turns — one that edits two files at
 * once and one that is deliberately unappliable — so the patch card, the patch title and the patch failure text get
 * pty coverage. **Off by default**, so every existing smoke and perf number is byte-unchanged (edge 1).
 */
export function mockPatchEnabled(env: NodeJS.ProcessEnv): boolean {
  return env['JEVCODE_MOCK_PATCH'] === '1';
}

/** §6.9: the two-file patch of turn 5 — it modifies the scratch file turn 4 last edited and creates one new file. */
export function mockTwoFilePatch(target: number, from: number, to: number): string {
  return [
    `--- a/scratch_${target}.py`,
    `+++ b/scratch_${target}.py`,
    '@@ -1 +1 @@',
    `-VALUE_${target} = ${from}`,
    `+VALUE_${target} = ${to}`,
    '--- /dev/null',
    `+++ b/notes_${to}.md`,
    '@@ -0,0 +1 @@',
    `+patched at step ${to}`,
    '',
  ].join('\n');
}

/** §6.9: the patch that must fail at `git apply --check`, leaving the tree clean (edge 3). */
export function mockBadPatch(target: number): string {
  return [`--- a/scratch_${target}.py`, `+++ b/scratch_${target}.py`, '@@ -1 +1 @@', '-THIS LINE IS NOT IN THE FILE', '+nor is this one', ''].join('\n');
}

export function mockTrajectory(steps: number, latencyMs: number = mockStepMs(process.env), patch: boolean = mockPatchEnabled(process.env)): MockTurn[] {
  const turns: MockTurn[] = [];
  const remaining = ['create the scratch module', 'exercise it', 'verify with a command'];
  const cycle = patch ? 6 : 4;
  for (let i = 0; i < Math.max(1, steps - 1); i++) {
    const k = i % cycle;
    const plan: PlanDraft = { done: [], remaining, openProblems: [] };
    if (k === 0) turns.push(turn(`Create scratch_${i}.py`, { kind: 'write', path: `scratch_${i}.py`, content: `VALUE_${i} = ${i}\n` }, plan, latencyMs));
    else if (k === 1) turns.push(turn(`Read scratch_${i - 1}.py`, { kind: 'read', paths: [`scratch_${i - 1}.py`] }, plan, latencyMs));
    else if (k === 2) turns.push(turn('Check the shell works', { kind: 'run', command: `printf 'ok %s\\n' ${i}` }, plan, latencyMs));
    else if (k === 3) turns.push(turn(`Edit scratch_${i - 3}.py`, { kind: 'edit', path: `scratch_${i - 3}.py`, old: `VALUE_${i - 3} = ${i - 3}`, new: `VALUE_${i - 3} = ${i}` }, plan, latencyMs));
    else if (k === 4) turns.push(turn(`Patch scratch_${i - 4}.py and add notes_${i}.md`, { kind: 'patch', diff: mockTwoFilePatch(i - 4, i - 1, i) }, plan, latencyMs));
    else turns.push(turn(`Patch scratch_${i - 5}.py (this one does not apply)`, { kind: 'patch', diff: mockBadPatch(i - 5) }, plan, latencyMs));
  }
  turns.push(turn('All done', { kind: 'done', summary: 'scratch work complete' }, { done: remaining, remaining: [], openProblems: [] }, latencyMs));
  return turns;
}
