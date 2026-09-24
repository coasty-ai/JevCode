/**
 * Shared doubles for the slice-S2 agent adapter tests (AGENT-LOOP-DESIGN §6.2, §15 S2): the two-turn transcript every
 * adapter's golden body is built from — a task, an assistant turn with prose and two parallel `tool_use` blocks, then a
 * user turn with two `tool_result` blocks (one an error) and a text block — plus SSE helpers for hand-built streams.
 */
import type { AgentMessage, AgentRequest, GenerateRequest, ProviderReplayState, ToolCallDelta, ToolSpec } from '../../../src/core/types.js';

export const READ_TOOL: ToolSpec = {
  name: 'read_file',
  description: 'Read a file.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } },
};

export const TASK = 'Fix the failing test in src/a.ts.';
export const PROSE = 'Reading both files.';
export const RESULT_A = 'src/a.ts (lines 1-1 of 1)\n     1\texport const a = 1;';
export const RESULT_B = 'ERROR: test/a.test.ts: no such file';
export const NOTE = 'Note: keep the change small.';

/** The two-turn transcript; `state` goes on the assistant turn. */
export function transcript(state?: ProviderReplayState): AgentMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: TASK }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: PROSE },
        { type: 'tool_use', id: 'call_a', name: 'read_file', input: { path: 'src/a.ts' } },
        { type: 'tool_use', id: 'call_b', name: 'read_file', input: { path: 'test/a.test.ts' } },
      ],
      ...(state !== undefined ? { providerState: state } : {}),
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'call_a', name: 'read_file', content: RESULT_A },
        { type: 'tool_result', toolUseId: 'call_b', name: 'read_file', content: RESULT_B, isError: true },
        { type: 'text', text: NOTE },
      ],
    },
  ];
}

/** An agent request over `messages` (the caller sends `messages: []`, §6.1). */
export function agentReq(messages: AgentMessage[] = transcript(), over: Partial<AgentRequest> = {}, req: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    system: 'You are JevCode.',
    messages: [],
    maxTokens: 16384,
    temperature: null,
    tools: [READ_TOOL],
    toolChoice: 'auto',
    reasoning: { effort: 'low' },
    agent: { messages, parallelToolCalls: true, cacheKey: 'sess-1', replayReasoning: true, ...over },
    ...req,
  };
}

/** `data: <json>\n\n` per chunk, plus the terminator when given. */
export function sseData(chunks: readonly object[], done = '[DONE]'): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + (done.length > 0 ? `data: ${done}\n\n` : '');
}

/** `event: <type>\ndata: <json>\n\n` per event (the Anthropic / Responses framing). */
export function sseEvents(events: readonly ({ type: string } & Record<string, unknown>)[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** Records every hook the agent reads, in order. */
export function hooks(): { calls: ToolCallDelta[]; reasoning: string[]; toolDeltas: string[]; deltas: string[] } {
  return { calls: [], reasoning: [], toolDeltas: [], deltas: [] };
}
