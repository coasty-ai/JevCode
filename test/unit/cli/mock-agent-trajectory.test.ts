/**
 * `src/cli/mock-trajectory.ts`, agent mode (AGENT-LOOP-DESIGN §14.4, §15 S5, §A1): the `--mock` provider under `--mode agent` scripts
 * native multi-call turns and picks them per run from the message — a greeting or a question gets ONE prose-only turn (the run
 * ends `answered`), anything else the five task turns. With `JEVCODE_MOCK_CHAT_STREAM` set, the first prose turn streams the
 * preset, so the stream-latency probe measures the agent-mode reply. The shapes are asserted directly (the mock provider's
 * `toolCalls` streaming is slice S2's); `buildProvider` is asserted to select this trajectory by mode.
 */
import { describe, expect, it } from 'vitest';
import {
  MOCK_AGENT_CLOSING,
  MOCK_AGENT_FILE,
  MOCK_AGENT_OPENING,
  isMockConversational,
  mockAgentReplyTurn,
  mockAgentTaskTurns,
  mockAgentTurns,
  mockChatReplyFromEnv,
  mockTaskText,
} from '../../../src/cli/mock-trajectory.js';
import { buildProvider } from '../../../src/cli/session.js';
import { MOCK_CHAT_REPLY } from '../../../src/provider/mock.js';
import type { GenerateRequest, ToolSpec } from '../../../src/core/types.js';
import type { ResolvedConfigWithDiagnostics } from '../../../src/config/types.js';

const TOOLS: ToolSpec[] = [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }];
function agentReq(task: string, extra: GenerateRequest['messages'] = []): GenerateRequest {
  return {
    system: 'sys',
    messages: extra,
    maxTokens: 100,
    temperature: null,
    tools: TOOLS,
    agent: { messages: [{ role: 'user', content: [{ type: 'text', text: `# Task\n${task}\n\n# Workspace\nname: ws` }] }], parallelToolCalls: true, cacheKey: 's1', replayReasoning: true },
  };
}

describe('the agent task trajectory (§15 S5): five native turns', () => {
  it('prose + 2 read_file + todo_write; write_file; ls + a mutating bash; edit_file; prose', () => {
    const turns = mockAgentTaskTurns(0);
    expect(turns.map((t) => (t.toolCalls ?? []).map((c) => c.name))).toEqual([['read_file', 'read_file', 'todo_write'], ['write_file'], ['bash', 'bash'], ['edit_file'], []]);
    expect(turns[0]!.text).toBe(`${MOCK_AGENT_OPENING}\n`);
    expect(turns[4]!.text).toBe(`${MOCK_AGENT_CLOSING}\n`);
    expect(turns.map((t) => t.stopReason)).toEqual(['tool_use', 'tool_use', 'tool_use', 'tool_use', 'end_turn']);
    // unique ids across the run; every call's rawJson is its input
    const calls = turns.flatMap((t) => t.toolCalls ?? []);
    expect(new Set(calls.map((c) => c.id)).size).toBe(calls.length);
    for (const c of calls) expect(JSON.parse(c.rawJson ?? '')).toEqual(c.input);
    // bash: `ls` is read-only, the second call writes inside the workspace and exits 0; the edit targets the file turn 2 wrote
    expect(calls.filter((c) => c.name === 'bash').map((c) => (c.input as { command: string }).command)).toEqual(['ls', "printf 'ok\\n' > scratch_agent.log"]);
    expect(turns[1]!.toolCalls![0]!.input).toEqual({ path: MOCK_AGENT_FILE, content: 'VALUE = 1\n' });
    expect(turns[3]!.toolCalls![0]!.input).toEqual({ path: MOCK_AGENT_FILE, old_string: 'VALUE = 1', new_string: 'VALUE = 2' });
    // no latency by default; JEVCODE_MOCK_STEP_MS reaches every turn
    for (const t of turns) expect(t).not.toHaveProperty('latencyMs');
    for (const t of mockAgentTaskTurns(75)) expect(t.latencyMs).toBe(75);
  });

  it('the reply turn is prose only: the deterministic MOCK_CHAT_REPLY', () => {
    expect(mockAgentReplyTurn(0)).toMatchObject({ text: MOCK_CHAT_REPLY, stopReason: 'end_turn' });
    expect(mockAgentReplyTurn(0).toolCalls).toBeUndefined();
  });
});

describe('mockAgentTurns: one trajectory per run, picked from the message', () => {
  it('a greeting or a question → one prose turn, repeated past its end (a continuation never fails the run)', () => {
    for (const task of ['hi', 'hello there', 'thanks!', 'who made you', 'what does parse_date do?']) {
      const turns = mockAgentTurns(undefined, 0);
      const first = turns(agentReq(task));
      expect(first.toolCalls, task).toBeUndefined();
      expect(first.text).toBe(MOCK_CHAT_REPLY);
      expect(turns(agentReq(task)).text).toBe(MOCK_CHAT_REPLY);
    }
  });

  it('a task → the five turns in order, then the closing prose again', () => {
    const turns = mockAgentTurns(undefined, 0);
    const seen = Array.from({ length: 6 }, () => turns(agentReq('fix the failing test')));
    expect(seen.map((t) => (t.toolCalls ?? []).length)).toEqual([3, 1, 2, 1, 0, 0]);
    expect(seen[5]!.text).toBe(`${MOCK_AGENT_CLOSING}\n`);
  });

  it('a request with no tools (a compaction writer) gets prose and leaves the cursor', () => {
    const turns = mockAgentTurns(undefined, 0);
    expect(turns(agentReq('fix the failing test')).toolCalls).toHaveLength(3);
    expect(turns({ system: 's', messages: [{ role: 'user', content: 'summarise' }], maxTokens: 10, temperature: null }).text).toBe(MOCK_CHAT_REPLY);
    expect(turns(agentReq('fix the failing test')).toolCalls?.[0]?.name).toBe('write_file');
  });

  it('the task text is the last `# New task` / `# Task` section (a follow-up run carries the parent transcript first)', () => {
    const req = agentReq('ignored');
    req.agent!.messages = [
      { role: 'user', content: [{ type: 'text', text: '# Task\nfix the failing test' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'user', content: [{ type: 'text', text: '# Since the last run\n- it stopped: complete\n\n# New task\nthanks' }] },
    ];
    expect(mockTaskText(req)).toBe('thanks');
    expect(mockTaskText({ messages: [{ role: 'user', content: 'plain text' }] })).toBe('plain text');
    expect(isMockConversational('thanks')).toBe(true);
    expect(isMockConversational('fix the failing tests')).toBe(false);
    expect(isMockConversational('add a --dry-run flag')).toBe(false);
  });

  it('JEVCODE_MOCK_CHAT_STREAM: the first prose turn streams the preset (the reply, and the task opening)', () => {
    const chat = mockChatReplyFromEnv({ JEVCODE_MOCK_CHAT_STREAM: 'mixed', JEVCODE_MOCK_DELTA_MS: '5' });
    expect(chat.reply?.deltas?.length).toBeGreaterThan(1);
    const reply = mockAgentTurns(chat.reply, 0)(agentReq('hi'));
    expect(reply.deltas).toEqual(chat.reply!.deltas);
    expect(reply.deltaGapMs).toBe(5);
    const task = mockAgentTurns(chat.reply, 0)(agentReq('fix the failing test'));
    expect(task.deltas).toEqual(chat.reply!.deltas);
    expect(task.toolCalls).toHaveLength(3);
  });
});

describe('buildProvider selects the trajectory by mode', () => {
  const cfg = {} as ResolvedConfigWithDiagnostics;
  const opts = { signal: new AbortController().signal };
  it('agent: a greeting is answered in prose with no tool call; legacy modes keep the propose_action trajectory', async () => {
    const agent = await buildProvider(cfg, { command: 'chat', mock: true }, 'agent');
    const r = await agent.generate(agentReq('hi'), opts);
    expect(r.text).toBe(MOCK_CHAT_REPLY);
    expect(r.toolCalls).toEqual([]);
    expect(r.stopReason).toBe('end_turn');
    const legacy = await buildProvider(cfg, { command: 'chat', mock: true }, 'jev-on');
    const l = await legacy.generate({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10, temperature: null, tools: TOOLS }, opts);
    expect(l.toolCalls[0]?.name).toBe('propose_action');
  });
});
