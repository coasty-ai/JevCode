/**
 * AGENT-LOOP-DESIGN §6.2 (Anthropic row), §6.3, §6.5, §7.3: the agent wire of anthropic.ts — S2 tests (a) golden body,
 * (b) stream (thinking + signature, two calls, applied edits, input transformations), (c) replay filtering, (d) a new
 * block at a used index, (g) block_binding (drop_block / error with strictReplay), the beta header and context_management.
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage, GenerateRequest } from '../../../src/core/types.js';
import { ANTHROPIC_AGENT_BETA, anthropicAdaptiveThinking, buildAnthropicBody, createAnthropicProvider } from '../../../src/provider/anthropic.js';
import { anthropicInputSchema } from '../../../src/provider/anthropic-schema.js';
import type { AnthropicContentBlock } from '../../../src/provider/types.js';
import { NOTE, PROSE, READ_TOOL, RESULT_A, RESULT_B, TASK, agentReq, hooks, sseEvents, transcript } from './agent-helpers.js';
import { anthropicCfg, genOpts, providerDeps, request, scriptedFetch, splitEvery } from './helpers.js';

const cfg = anthropicCfg();
const THINK = { type: 'thinking' as const, thinking: 'Both files matter.', signature: 'sig-a' };
const STATE = {
  provider: 'anthropic' as const,
  model: 'claude-sonnet-5',
  data: { blocks: [THINK, { type: 'text', text: PROSE }, { type: 'tool_use', id: 'call_a' }, { type: 'tool_use', id: 'call_b' }] },
};
const CLEAR = { triggerTokens: 100_000, keep: 3, clearAtLeastTokens: 20_000 };
const USES: AnthropicContentBlock[] = [
  { type: 'tool_use', id: 'call_a', name: 'read_file', input: { path: 'src/a.ts' } },
  { type: 'tool_use', id: 'call_b', name: 'read_file', input: { path: 'test/a.test.ts' } },
];

function assistantOf(req: GenerateRequest): AnthropicContentBlock[] {
  const content = buildAnthropicBody(cfg, req).messages[1]!.content;
  if (typeof content === 'string') throw new Error('expected blocks');
  return content;
}

describe('anthropic agent wire (AGENT-LOOP-DESIGN §6.2, §6.5)', () => {
  it('(a)+(g) golden body: thinking replayed in place, results first in one user message, auto without disable_parallel, adaptive summarized thinking with drop_block, effort, context_management, top-level cache_control, no temperature', () => {
    const body = buildAnthropicBody(cfg, agentReq(transcript(STATE), { clearToolResults: CLEAR }, { reasoning: { effort: 'high' }, temperature: 0.2 }));
    const golden = {
      model: 'claude-sonnet-5',
      max_tokens: 16384,
      stream: true,
      messages: [
        { role: 'user', content: [{ type: 'text', text: TASK }] },
        { role: 'assistant', content: [THINK, { type: 'text', text: PROSE }, ...USES] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_a', content: RESULT_A },
            { type: 'tool_result', tool_use_id: 'call_b', content: RESULT_B, is_error: true },
            { type: 'text', text: NOTE },
          ],
        },
      ],
      system: [{ type: 'text', text: 'You are JevCode.', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'read_file', description: READ_TOOL.description, input_schema: anthropicInputSchema(READ_TOOL.inputSchema), strict: true, eager_input_streaming: true, cache_control: { type: 'ephemeral' } }],
      tool_choice: { type: 'auto' },
      thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      output_config: { effort: 'high' },
      context_management: {
        edits: [{ type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: 100_000 }, keep: { type: 'tool_uses', value: 3 }, clear_at_least: { type: 'input_tokens', value: 20_000 } }],
      },
      cache_control: { type: 'ephemeral' },
    };
    expect(JSON.stringify(body)).toBe(JSON.stringify(golden));
  });

  it('(g) strictReplay sends error; no clearToolResults sends no context_management; {enabled:false} maps to no effort; one call per turn disables parallel use', () => {
    const strict = buildAnthropicBody(cfg, agentReq(transcript(), { strictReplay: true }, { reasoning: { enabled: false } }));
    expect(strict.thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'error' } });
    expect('context_management' in strict).toBe(false);
    expect('output_config' in strict).toBe(false);
    expect(buildAnthropicBody(cfg, agentReq(transcript(), { parallelToolCalls: false })).tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });

  it('tool_choice: one call per turn disables parallel use even without a toolChoice; a forced choice goes out as auto (thinking is on)', () => {
    const withoutChoice = ({ toolChoice, ...rest }: GenerateRequest): GenerateRequest => (void toolChoice, rest);
    expect(buildAnthropicBody(cfg, withoutChoice(agentReq(transcript(), { parallelToolCalls: false }))).tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect('tool_choice' in buildAnthropicBody(cfg, withoutChoice(agentReq(transcript())))).toBe(false);
    expect(buildAnthropicBody(cfg, agentReq(transcript(), {}, { toolChoice: 'required' })).tool_choice).toEqual({ type: 'auto' });
    expect(buildAnthropicBody(cfg, agentReq(transcript(), { parallelToolCalls: false }, { toolChoice: { name: 'read_file' } })).tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });

  it('a pre-4.6 model (no adaptive thinking) gets no thinking, no output_config and only the context-editing beta; its forced choice is kept', async () => {
    for (const m of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5', 'claude-opus-4-1-20250805', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219']) {
      expect(anthropicAdaptiveThinking(m)).toBe(false);
    }
    for (const m of ['claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-5']) expect(anthropicAdaptiveThinking(m)).toBe(true);
    const old = anthropicCfg({ model: 'claude-haiku-4-5' });
    const body = buildAnthropicBody(old, agentReq(transcript(), { parallelToolCalls: false }, { toolChoice: 'required', reasoning: { effort: 'high' } }));
    expect('thinking' in body).toBe(false);
    expect('output_config' in body).toBe(false);
    expect(body.tool_choice).toEqual({ type: 'any', disable_parallel_tool_use: true });
    const stream = sseEvents([
      { type: 'message_start', message: { id: 'msg_h', model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]);
    const f = scriptedFetch([{ status: 200, body: stream }]);
    await createAnthropicProvider(old, providerDeps(f.fetch).deps).generate(agentReq(), genOpts());
    expect(f.calls[0]!.headers['anthropic-beta']).toBe('context-management-2025-06-27');
  });

  it('an assistant turn with nothing to send (an empty reply) goes out as a placeholder text, never as empty content', () => {
    const t: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: TASK }] },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: [{ type: 'text', text: NOTE }] },
    ];
    expect(buildAnthropicBody(cfg, agentReq(t)).messages[1]!.content).toEqual([{ type: 'text', text: '(no content)' }]);
  });

  it('a call id renamed for uniqueness is renamed in its tool_use replay marker too', async () => {
    const stream = sseEvents([
      { type: 'message_start', message: { id: 'msg_r', model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-r' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_a', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"c"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]);
    const f = scriptedFetch([{ status: 200, body: stream }]);
    const res = await createAnthropicProvider(cfg, providerDeps(f.fetch).deps).generate(agentReq(transcript(STATE)), genOpts());
    const id = res.toolCalls[0]!.id!;
    expect(id).toMatch(/^jc_/);
    expect(res.providerState!.data).toEqual({ blocks: [{ type: 'thinking', thinking: '', signature: 'sig-r' }, { type: 'tool_use', id }] });
  });

  it('(g) the agent request carries the beta header; a legacy request does not', async () => {
    const stream = sseEvents([
      { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]);
    const f = scriptedFetch([
      { status: 200, body: stream },
      { status: 200, body: stream },
    ]);
    const p = createAnthropicProvider(cfg, providerDeps(f.fetch).deps);
    await p.generate(agentReq(), genOpts());
    await p.generate(request(), genOpts());
    expect(f.calls[0]!.headers['anthropic-beta']).toBe(ANTHROPIC_AGENT_BETA);
    expect(ANTHROPIC_AGENT_BETA).toBe('context-management-2025-06-27,thinking-binding-controls-2026-08-01');
    expect('anthropic-beta' in f.calls[1]!.headers).toBe(false);
  });

  it('(b) stream: thinking text to onReasoning, signature captured, calls named then streamed, ids kept, applied_edits and input_transformations read', async () => {
    const stream = sseEvents([
      {
        type: 'message_start',
        message: {
          id: 'msg_agent',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 50, cache_read_input_tokens: 4000, output_tokens: 1 },
          input_transformations: [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }],
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'ENC==' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'Plan: ' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'read both.' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig-xyz' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Reading.' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
      { type: 'content_block_stop', index: 3 },
      { type: 'content_block_start', index: 4, content_block: { type: 'tool_use', id: 'toolu_b', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{"path":"b.ts"}' } },
      { type: 'content_block_stop', index: 4 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 80 },
        context_management: { applied_edits: [{ type: 'clear_tool_uses_20250919', cleared_tool_uses: 4, cleared_input_tokens: 12_000 }] },
      },
      { type: 'message_stop' },
    ]);
    const f = scriptedFetch([{ status: 200, body: splitEvery(stream, 23) }]);
    const h = hooks();
    const res = await createAnthropicProvider(cfg, providerDeps(f.fetch).deps).generate(
      agentReq(),
      genOpts({ onToolCall: (d) => h.calls.push(d), onReasoning: (r) => h.reasoning.push(r), onDelta: (d) => h.deltas.push(d) }),
    );
    expect(h.reasoning).toEqual(['Plan: ', 'read both.']);
    expect(h.deltas).toEqual(['Reading.']);
    expect(h.calls).toEqual([
      { index: 0, id: 'toolu_a', name: 'read_file', fragment: '' },
      { index: 0, id: 'toolu_a', name: 'read_file', fragment: '{"path":' },
      { index: 0, id: 'toolu_a', name: 'read_file', fragment: '"a.ts"}' },
      { index: 1, id: 'toolu_b', name: 'read_file', fragment: '' },
      { index: 1, id: 'toolu_b', name: 'read_file', fragment: '{"path":"b.ts"}' },
    ]);
    expect(res.toolCalls).toEqual([
      { name: 'read_file', input: { path: 'a.ts' }, rawJson: '{"path":"a.ts"}', id: 'toolu_a' },
      { name: 'read_file', input: { path: 'b.ts' }, rawJson: '{"path":"b.ts"}', id: 'toolu_b' },
    ]);
    expect(res.providerState).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      data: {
        blocks: [
          { type: 'redacted_thinking', data: 'ENC==' },
          { type: 'thinking', thinking: 'Plan: read both.', signature: 'sig-xyz' },
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'toolu_a' },
          { type: 'tool_use', id: 'toolu_b' },
        ],
      },
    });
    expect(res.contextEdits).toEqual({ clearedToolUses: 4, clearedInputTokens: 12_000 });
    expect(res.warnings).toEqual(['anthropic thinking_dropped: prefix_binding_mismatch at messages.1.content.0']);
    expect(res.stopReason).toBe('tool_use');

    // the captured state replays verbatim on the next turn: the assistant turn built from this result's own blocks
    const next: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: TASK }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: res.text }, ...res.toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id!, name: c.name, input: c.input }))],
        providerState: res.providerState!,
      },
      {
        role: 'user',
        content: res.toolCalls.map((c) => ({ type: 'tool_result' as const, toolUseId: c.id!, name: c.name, content: 'ok' })),
      },
    ];
    expect(assistantOf(agentReq(next))).toEqual([
      { type: 'redacted_thinking', data: 'ENC==' },
      { type: 'thinking', thinking: 'Plan: read both.', signature: 'sig-xyz' },
      { type: 'text', text: 'Reading.' },
      { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'tool_use', id: 'toolu_b', name: 'read_file', input: { path: 'b.ts' } },
    ]);
  });

  it('a legacy request records no thinking state, no edits, no warnings and no ids', async () => {
    const stream = sseEvents([
      { type: 'message_start', message: { id: 'msg_l', model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 1 }, input_transformations: [{ type: 'x', reason: 'y' }] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_l', name: 'propose_action', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 }, context_management: { applied_edits: [{ cleared_tool_uses: 1 }] } },
      { type: 'message_stop' },
    ]);
    const f = scriptedFetch([{ status: 200, body: stream }]);
    const res = await createAnthropicProvider(cfg, providerDeps(f.fetch).deps).generate(request(), genOpts());
    expect(res.toolCalls).toEqual([{ name: 'propose_action', input: {}, rawJson: '{}' }]);
    expect(Object.keys(res).sort()).toEqual(['generationId', 'latencyMs', 'model', 'stopReason', 'text', 'toolCalls', 'usage']);
  });

  it('(c) thinking from another provider, another configured model, or with replay off is not sent', () => {
    const plain = [{ type: 'text', text: PROSE }, ...USES];
    expect(assistantOf(agentReq(transcript(STATE)))[0]).toEqual(THINK);
    expect(assistantOf(agentReq(transcript({ ...STATE, model: 'claude-opus-5-5' })))).toEqual(plain);
    expect(assistantOf(agentReq(transcript({ ...STATE, provider: 'openrouter' })))).toEqual(plain);
    expect(assistantOf(agentReq(transcript(STATE), { replayReasoning: false }))).toEqual(plain);
  });

  it('replay keeps the wire segmentation when the prose matches, and puts the transcript prose at the first text position when it does not', () => {
    const split = { ...STATE, data: { blocks: [{ type: 'text', text: 'Reading ' }, THINK, { type: 'text', text: 'both files.' }, { type: 'tool_use', id: 'call_a' }, { type: 'tool_use', id: 'call_b' }] } };
    expect(assistantOf(agentReq(transcript(split)))).toEqual([{ type: 'text', text: 'Reading ' }, THINK, { type: 'text', text: 'both files.' }, ...USES]);
    const t = transcript(split);
    t[1] = { ...t[1]!, content: [{ type: 'text', text: 'Reading [REDACTED] files.' }, ...t[1]!.content.slice(1)] } as AgentMessage;
    expect(assistantOf(agentReq(t))).toEqual([{ type: 'text', text: 'Reading [REDACTED] files.' }, THINK, ...USES]);
  });

  it('(d) a second block started at a used index is a new call, not a duplicate', async () => {
    const stream = sseEvents([
      { type: 'message_start', message: { id: 'msg_d', model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_b', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"b"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]);
    const f = scriptedFetch([{ status: 200, body: stream }]);
    const res = await createAnthropicProvider(cfg, providerDeps(f.fetch).deps).generate(agentReq(), genOpts());
    expect(res.toolCalls.map((c) => [c.id, c.input])).toEqual([
      ['toolu_a', { path: 'a' }],
      ['toolu_b', { path: 'b' }],
    ]);
  });
});
