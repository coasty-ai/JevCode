/**
 * AGENT-LOOP-DESIGN §6.2 (Mock row): `MockTurn.toolCalls[]` with ids streamed per index through `onToolDelta` and
 * `onToolCall`, `MockTurn.reasoning` through `onReasoning`, the `providerState` echo, and the recorded requests — and a
 * legacy request against the same turn keeps no ids and no state.
 */
import { describe, expect, it } from 'vitest';
import type { CancelledGeneration } from '../../../src/core/types.js';
import { createMockProvider } from '../../../src/provider/mock.js';
import { agentReq, hooks } from './agent-helpers.js';
import { genOpts, request } from './helpers.js';

const TURN = {
  text: 'Reading.',
  reasoning: 'Plan it.',
  toolCalls: [
    { id: 'call_1', name: 'read_file', input: { path: 'a' } },
    { name: 'read_file', input: { path: 'b' }, rawJson: '{"path": "b"}' },
  ],
  providerState: { note: 'opaque' },
};

describe('mock agent turns (AGENT-LOOP-DESIGN §6.2)', () => {
  it('streams reasoning, then text, then each call per index; returns ids and echoes providerState; records the request', async () => {
    const p = createMockProvider({ turns: [TURN], model: 'mock-agent', deltaChunkSize: 6 });
    const h = hooks();
    const req = agentReq();
    const res = await p.generate(req, genOpts({ onToolCall: (d) => h.calls.push(d), onReasoning: (r) => h.reasoning.push(r), onToolDelta: (d) => h.toolDeltas.push(d), onDelta: (d) => h.deltas.push(d) }));
    expect(h.reasoning).toEqual(['Plan i', 't.']);
    expect(h.deltas).toEqual(['Readin', 'g.']);
    expect(h.calls).toEqual([
      { index: 0, id: 'call_1', name: 'read_file', fragment: '{"path' },
      { index: 0, id: 'call_1', name: 'read_file', fragment: '":"a"}' },
      { index: 1, id: 'mock_call_1_1', name: 'read_file', fragment: '{"path' },
      { index: 1, id: 'mock_call_1_1', name: 'read_file', fragment: '": "b"' },
      { index: 1, id: 'mock_call_1_1', name: 'read_file', fragment: '}' },
    ]);
    expect(h.toolDeltas.join('')).toBe('{"path":"a"}{"path": "b"}');
    expect(res.toolCalls).toEqual([
      { name: 'read_file', input: { path: 'a' }, rawJson: '{"path":"a"}', id: 'call_1' },
      { name: 'read_file', input: { path: 'b' }, rawJson: '{"path": "b"}', id: 'mock_call_1_1' },
    ]);
    expect(res.providerState).toEqual({ provider: 'mock', model: 'mock-agent', data: { note: 'opaque' } });
    expect(res.stopReason).toBe('tool_use');
    expect(p.requests).toEqual([req]);
  });

  it('a legacy request against the same turn gets the calls without ids and no providerState', async () => {
    const p = createMockProvider({ turns: [TURN] });
    const res = await p.generate(request(), genOpts());
    expect(res.toolCalls.every((c) => !('id' in c))).toBe(true);
    expect('providerState' in res).toBe(false);
    expect(p.requests.length).toBe(1);
  });

  it('an abort inside the calls reports the streamed tool characters once', async () => {
    const ac = new AbortController();
    const cancelled: CancelledGeneration[] = [];
    const p = createMockProvider({ turns: [TURN], deltaChunkSize: 4 });
    const pieces: string[] = [];
    await expect(
      p.generate(
        agentReq(),
        genOpts({
          signal: ac.signal,
          onToolDelta: (d) => {
            pieces.push(d);
            if (pieces.length === 2) ac.abort(new Error('stop'));
          },
          onCancelled: (c) => cancelled.push(c),
        }),
      ),
    ).rejects.toThrow('stop');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.toolChars).toBe(8);
  });
});
