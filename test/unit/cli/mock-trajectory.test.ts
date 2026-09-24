/**
 * `src/cli/mock-trajectory.ts`: the `--mock` trajectory and its step-pacing knob `JEVCODE_MOCK_STEP_MS` (TUI-DESIGN
 * §18: the perf probes measure a live mocked run at a realistic step rate). Default 0 keeps the zero-latency turns
 * every existing test relies on; a value reaches every turn as `latencyMs`, which the mock provider awaits once per
 * `generate()`.
 */
import { describe, expect, it } from 'vitest';
import { mockBadPatch, mockPatchEnabled, mockStepMs, mockTrajectory, mockTwoFilePatch } from '../../../src/cli/mock-trajectory.js';
import { editSummary } from '../../../src/tui/diff/summary.js';
import { createMockProvider } from '../../../src/provider/mock.js';
import type { GenerateOptions } from '../../../src/core/types.js';

describe('mockStepMs (JEVCODE_MOCK_STEP_MS)', () => {
  it('reads a non-negative whole number of milliseconds and falls back to 0 for anything else', () => {
    expect(mockStepMs({})).toBe(0);
    expect(mockStepMs({ JEVCODE_MOCK_STEP_MS: '200' })).toBe(200);
    expect(mockStepMs({ JEVCODE_MOCK_STEP_MS: ' 50 ' })).toBe(50);
    expect(mockStepMs({ JEVCODE_MOCK_STEP_MS: '0' })).toBe(0);
    expect(mockStepMs({ JEVCODE_MOCK_STEP_MS: '' })).toBe(0);
    expect(mockStepMs({ JEVCODE_MOCK_STEP_MS: '-1' })).toBe(0);
    expect(mockStepMs({ JEVCODE_MOCK_STEP_MS: '1.5' })).toBe(0);
    expect(mockStepMs({ JEVCODE_MOCK_STEP_MS: 'fast' })).toBe(0);
  });
});

describe('mockTrajectory', () => {
  it('is the write → read → run → edit cycle ending in done, without latency by default', () => {
    const turns = mockTrajectory(6, 0);
    const kinds = turns.map((t) => (t.toolCall!.input as { action: { kind: string } }).action.kind);
    expect(kinds).toEqual(['write', 'read', 'run', 'edit', 'write', 'done']);
    for (const t of turns) expect(t).not.toHaveProperty('latencyMs');
    // the default argument reads the process env; the test runner does not set the knob
    expect(process.env['JEVCODE_MOCK_STEP_MS']).toBeUndefined();
    for (const t of mockTrajectory(3)) expect(t).not.toHaveProperty('latencyMs');
  });
  it('gives every turn, the done turn included, the requested latency', () => {
    const turns = mockTrajectory(5, 200);
    expect(turns).toHaveLength(5);
    for (const t of turns) expect(t.latencyMs).toBe(200);
    expect(mockTrajectory(2, mockStepMs({ JEVCODE_MOCK_STEP_MS: '75' })).map((t) => t.latencyMs)).toEqual([75, 75]);
  });
  it('the mock provider awaits the latency once per generate() and still returns the tool call', async () => {
    const slept: number[] = [];
    const provider = createMockProvider({ turns: mockTrajectory(2, 200) }, { sleep: (ms) => { slept.push(ms); return Promise.resolve(); }, now: () => 0 });
    const opts: GenerateOptions = { signal: new AbortController().signal };
    const first = await provider.generate({ system: '', messages: [], maxTokens: 1, temperature: null }, opts);
    expect(first.toolCalls[0]?.name).toBe('propose_action');
    expect(first.latencyMs).toBe(200);
    await provider.generate({ system: '', messages: [], maxTokens: 1, temperature: null }, opts);
    expect(slept).toEqual([200, 200]);
    // zero latency never sleeps
    const instant = createMockProvider({ turns: mockTrajectory(1, 0) }, { sleep: (ms) => { slept.push(ms); return Promise.resolve(); } });
    await instant.generate({ system: '', messages: [], maxTokens: 1, temperature: null }, opts);
    expect(slept).toEqual([200, 200]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// TUI-DESIGN-4 §6.9 (D-Z): the patch path is reachable in `--mock` — the patch card, the patch title and the patch
// failure text had ZERO pty coverage and no TUI unit test (A6-21). Behind `JEVCODE_MOCK_PATCH=1`, so every existing
// smoke and perf number is byte-unchanged (edge 1).
// ---------------------------------------------------------------------------------------------------------------

describe('mockPatchEnabled and the two patch turns (§6.9)', () => {
  it('edge 1: with the env unset the default trajectory is byte-identical to its golden', () => {
    expect(mockPatchEnabled({})).toBe(false);
    expect(mockPatchEnabled({ JEVCODE_MOCK_PATCH: '0' })).toBe(false);
    expect(mockPatchEnabled({ JEVCODE_MOCK_PATCH: 'yes' })).toBe(false);
    expect(mockPatchEnabled({ JEVCODE_MOCK_PATCH: '1' })).toBe(true);
    const golden = ['write', 'read', 'run', 'edit', 'write', 'read', 'run', 'edit', 'write', 'read', 'run', 'edit', 'write', 'read', 'run', 'edit', 'write', 'read', 'run', 'edit', 'write', 'read', 'run', 'edit', 'write', 'read', 'run', 'edit', 'write', 'read', 'run', 'edit', 'write', 'read', 'run', 'edit', 'write', 'read', 'run', 'done'];
    const kinds = mockTrajectory(40, 0, false).map((t) => (t.toolCall!.input as { action: { kind: string } }).action.kind);
    expect(kinds).toEqual(golden);
    expect(mockTrajectory(40, 0).map((t) => JSON.stringify(t.toolCall!.input))).toEqual(mockTrajectory(40, 0, false).map((t) => JSON.stringify(t.toolCall!.input)));
  });

  it('with the flag the cycle is six: a two-file patch and one that deliberately does not apply', () => {
    const turns = mockTrajectory(13, 0, true);
    const kinds = turns.map((t) => (t.toolCall!.input as { action: { kind: string } }).action.kind);
    expect(kinds.slice(0, 6)).toEqual(['write', 'read', 'run', 'edit', 'patch', 'patch']);
    expect(kinds.at(-1)).toBe('done');
    expect(kinds.filter((k) => k === 'patch').length).toBeGreaterThanOrEqual(2);
  });

  it('edge 2: the two-file patch targets the scratch files the trajectory itself created — no external fixture', () => {
    const diff = mockTwoFilePatch(0, 3, 4);
    expect(diff).toContain('--- a/scratch_0.py');
    expect(diff).toContain('+++ b/scratch_0.py');
    expect(diff).toContain('-VALUE_0 = 3');
    expect(diff).toContain('+VALUE_0 = 4');
    // the second file is a pure addition, so the card's summary block has two rows with different letters
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/notes_4.md');
    const s = editSummary({ kind: 'patch', diff })!;
    expect(s.files.map((f) => [f.letter, f.path])).toEqual([
      ['M', 'scratch_0.py'],
      ['A', 'notes_4.md'],
    ]);
    expect([s.added, s.deleted]).toEqual([2, 1]);
  });

  it('edge 3: the bad patch is well-formed (so it reaches `git apply --check`) but can never match', () => {
    const bad = mockBadPatch(1);
    expect(bad).toContain('--- a/scratch_1.py');
    expect(bad).toContain('-THIS LINE IS NOT IN THE FILE');
    const s = editSummary({ kind: 'patch', diff: bad })!;
    expect(s.files.map((f) => f.path)).toEqual(['scratch_1.py']);
  });
});
