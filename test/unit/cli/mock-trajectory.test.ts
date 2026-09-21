/**
 * `src/cli/mock-trajectory.ts`: the `--mock` trajectory and its step-pacing knob `JEVCODE_MOCK_STEP_MS` (TUI-DESIGN
 * §18: the perf probes measure a live mocked run at a realistic step rate). Default 0 keeps the zero-latency turns
 * every existing test relies on; a value reaches every turn as `latencyMs`, which the mock provider awaits once per
 * `generate()`.
 */
import { describe, expect, it } from 'vitest';
import { mockStepMs, mockTrajectory } from '../../../src/cli/mock-trajectory.js';
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
