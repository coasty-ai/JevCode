/**
 * Context management through the driver (docs/AGENT-LOOP-DESIGN.md §7.3-§7.5): client masking at 50 %, Anthropic's
 * server-side clearing instead, no masking for Claude behind another adapter, and simple compaction at 85 % or on
 * `/compact` — one user message, no assistant turn, no reasoning state — with the llm writer and its code fallback.
 */
import { describe, expect, it } from 'vitest';
import type { GenerateRequest } from '../../../src/core/types.js';
import { createAgentDriver } from '../../../src/agent/index.js';
import { call, createAgentContext, step, type FakeAgentOptions, type ScriptedTurn } from './helpers.js';

const BIG = 'z'.repeat(12_000);

/** Turn 1 reads ten big outputs (reporting `inputTokens`), turn 2 is the reply; summary requests (no agent field) answer `summary`. */
function bigRun(inputTokens: number, o: Partial<FakeAgentOptions> = {}, summary: ScriptedTurn = { text: '# Context summary (compacted at step 2; earlier turns were removed)\n## Goal and constraints\nfix it' }): ReturnType<typeof createAgentContext> {
  let turn = 0;
  return createAgentContext({
    windowTokens: 100_000,
    testCommand: null,
    sandbox: () => ({ exitCode: 0, stdout: BIG }),
    turns: (req: GenerateRequest) => {
      if (req.agent === undefined) return summary;
      turn += 1;
      if (turn === 1) return { toolCalls: Array.from({ length: 10 }, (_v, i) => call('bash', { command: `cat big${i}.log` })), usage: { inputTokens }, providerState: { r: 1 } };
      return { text: 'done' };
    },
    ...o,
  });
}

async function twoSteps(ctx: ReturnType<typeof createAgentContext>): Promise<void> {
  const d = createAgentDriver();
  await step(d, ctx);
  await step(d, ctx);
}

const agentRequests = (ctx: ReturnType<typeof createAgentContext>): GenerateRequest[] => ctx.sent.filter((r) => r.agent !== undefined);

describe('masking', () => {
  it('client mode past 50 %: stale results become markers, calls and prose stay', async () => {
    const ctx = bigRun(15_000);
    await twoSteps(ctx);
    const second = agentRequests(ctx)[1]!;
    const results = second.agent!.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));
    expect(results.slice(0, 4).every((r) => r.startsWith('[elided: bash bash cat big') && r.endsWith('call it again if you need it]'))).toBe(true);
    expect(results.slice(4).every((r) => r.includes(BIG))).toBe(true);
    expect(second.agent!.messages[1]!.content.filter((b) => b.type === 'tool_use')).toHaveLength(10);
    expect(ctx.eventsOf('context:compacted')).toEqual([]);
  });

  it('no masking below 50 %', async () => {
    const ctx = bigRun(1_000);
    await twoSteps(ctx);
    const results = agentRequests(ctx)[1]!.agent!.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));
    expect(results.every((r) => r.includes(BIG))).toBe(true);
  });

  it('Anthropic masks server-side: the transcript is not rewritten and every request carries the clearing field', async () => {
    const ctx = bigRun(15_000, { provider: { name: 'anthropic', model: 'claude-sonnet-5' } });
    await twoSteps(ctx);
    for (const r of agentRequests(ctx)) expect(r.agent!.clearToolResults).toEqual({ triggerTokens: 45_000, keep: 6, clearAtLeastTokens: 5_000 });
    const results = agentRequests(ctx)[1]!.agent!.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));
    expect(results.every((r) => r.includes(BIG))).toBe(true);
  });

  it('a Claude model behind OpenRouter is never masked and gets no clearing field', async () => {
    const ctx = bigRun(15_000, { provider: { name: 'openrouter', model: 'anthropic/claude-sonnet-5' } });
    await twoSteps(ctx);
    const second = agentRequests(ctx)[1]!;
    expect(second.agent).not.toHaveProperty('clearToolResults');
    expect(second.agent!.messages.at(-1)!.content.every((b) => b.type !== 'tool_result' || b.content.includes(BIG))).toBe(true);
  });
});

describe('compaction', () => {
  it('past 85 %: the llm writer summarises silently and the next request is ONE user message with no assistant turn and no reasoning state', async () => {
    const ctx = bigRun(70_000);
    await twoSteps(ctx);
    const summaryCall = ctx.sent.find((r) => r.agent === undefined)!;
    expect(summaryCall.maxTokens).toBe(2_000);
    expect(summaryCall.messages[0]!.content).toContain('## Goal and constraints');
    expect(ctx.hooks.find((h) => h.silent === true)).toBeDefined();
    const next = agentRequests(ctx)[1]!;
    expect(next.agent!.messages).toHaveLength(1);
    const m = next.agent!.messages[0]!;
    expect(m.role).toBe('user');
    expect(m).not.toHaveProperty('providerState');
    const text = m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text.startsWith('# Task\nfix the failing test')).toBe(true);
    expect(text).toContain('# Context summary (compacted at step 2; earlier turns were removed)');
    expect(text).toContain('# Most recent tool results\n## bash cat big7.log (exit 0)');
    expect(text.endsWith('Continue with the task.')).toBe(true);
    expect(ctx.eventsOf('context:compacted')).toMatchObject([{ step: 2, by: 'llm' }]);
    const compacted = ctx.eventsOf('context:compacted')[0]!;
    expect(compacted.chars.after).toBeLessThan(compacted.chars.before);
    expect(ctx.state).toMatchObject({ compactions: 1, lastCompactionStep: 2 });
    expect(ctx.usages.at(-1)).toMatchObject({ compactions: 1, compaction: 'llm' });
  });

  it('the llm writer falls back to the code writer on any error', async () => {
    const ctx = bigRun(70_000, {}, { error: new Error('summary request failed') });
    await twoSteps(ctx);
    expect(ctx.eventsOf('context:compacted')).toMatchObject([{ by: 'code' }]);
    const text = agentRequests(ctx)[1]!.agent!.messages[0]!.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('## Commands run\n- `cat big0.log` → exit 0');
  });

  it('an explicit `code` setting uses the code writer without asking the model', async () => {
    const ctx = bigRun(70_000, { compaction: { mode: 'code', explicit: true } });
    await twoSteps(ctx);
    expect(ctx.sent.some((r) => r.agent === undefined)).toBe(false);
    expect(ctx.eventsOf('context:compacted')).toMatchObject([{ by: 'code' }]);
  });

  it('an explicit `off` never compacts on its own, but masking still runs', async () => {
    const ctx = bigRun(70_000, { compaction: { mode: 'off', explicit: true } });
    await twoSteps(ctx);
    expect(ctx.eventsOf('context:compacted')).toEqual([]);
    const results = agentRequests(ctx)[1]!.agent!.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));
    expect(results[0]!.startsWith('[elided:')).toBe(true);
  });

  it('/compact forces a compaction at the next turn build', async () => {
    const ctx = createAgentContext({ testCommand: null, compaction: { mode: 'code', explicit: true }, turns: [{ toolCalls: [call('glob', { pattern: '*' })] }, { text: 'ok' }] });
    const d = createAgentDriver();
    await step(d, ctx);
    ctx.compactRequest = true;
    await step(d, ctx);
    expect(ctx.eventsOf('context:compacted')).toHaveLength(1);
    expect(ctx.sent[1]!.agent!.messages).toHaveLength(1);
  });
});
