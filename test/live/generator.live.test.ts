/**
 * Live generator smoke tests (DESIGN.md §14 `test:live`). Skipped unless JEVCODE_LIVE=1 and the
 * provider key is present. One call per provider, max_tokens 64, a tiny forced tool: total spend
 * is well under one cent. Nothing here prints a key; every error string passes `redact`.
 */
import { describe, expect, it } from 'vitest';
import type { GeneratorConfig, ToolSpec } from '../../src/core/types.js';
import { createAnthropicProvider } from '../../src/provider/anthropic.js';
import { createOpenRouterProvider } from '../../src/provider/openrouter.js';

const LIVE = process.env['JEVCODE_LIVE'] === '1';
const OPENROUTER_KEY = process.env['OPENROUTER_API_KEY'] ?? '';
const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'] ?? '';

const PRICING: GeneratorConfig['pricing'] = { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 };

function redactor(...keys: string[]): (s: string) => string {
  return (s) => {
    let out = s;
    for (const k of keys) if (k.length >= 8) out = out.split(k).join('[REDACTED:key]');
    return out.replace(/sk-or-v1-[A-Za-z0-9]{20,}/g, '[REDACTED:pattern]').replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED:pattern]');
  };
}

/** A propose_action-like tool kept tiny so the reply fits in 64 output tokens. */
const TOOL: ToolSpec = {
  name: 'propose_action',
  description: 'Propose exactly one shell command to run next.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['goal', 'command'],
    properties: {
      goal: { type: 'string', description: 'one short sentence' },
      command: { type: 'string', description: 'a non-interactive shell command' },
    },
  },
};

const REQUEST = {
  system: 'You are a coding agent. Reply only by calling the propose_action tool. Keep goal under 8 words.',
  messages: [{ role: 'user' as const, content: 'Task: list the files in the current directory. Propose the single command.' }],
  maxTokens: 64,
  temperature: null,
  tools: [TOOL],
  toolChoice: { name: 'propose_action' },
};

describe('live generator', () => {
  it('openrouter anthropic/claude-sonnet-5 returns a valid tool call with usage.cost', async ({ skip }) => {
    if (!LIVE) skip('JEVCODE_LIVE is not "1"');
    if (!OPENROUTER_KEY) skip('OPENROUTER_API_KEY is empty');
    const cfg: GeneratorConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-5', apiKey: OPENROUTER_KEY, baseUrl: 'https://openrouter.ai/api/v1', temperature: null, maxTokens: 64, pricing: PRICING };
    const redact = redactor(OPENROUTER_KEY);
    const p = createOpenRouterProvider(cfg, { redact });
    const toolDeltas: string[] = [];
    const res = await p.generate(REQUEST, { signal: AbortSignal.timeout(120_000), onToolDelta: (f) => toolDeltas.push(f) });
    process.stdout.write(
      redact(`openrouter: model=${res.model} stop=${res.stopReason} in=${res.usage.inputTokens} out=${res.usage.outputTokens} cost=$${res.usage.costUsd.toFixed(6)} latency=${res.latencyMs}ms tools=${res.toolCalls.length}\n`),
    );
    expect(res.model).toContain('claude-sonnet-5');
    expect(res.usage.costUsd).toBeGreaterThan(0);
    expect(res.usage.costUsd).toBeLessThan(0.02);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.toolCalls.length).toBeGreaterThanOrEqual(1);
    const tc = res.toolCalls[0]!;
    expect(tc.name).toBe('propose_action');
    expect(tc.input).not.toBeNull();
    expect(JSON.parse(tc.rawJson)).toEqual(tc.input);
    expect(tc.input).toMatchObject({ goal: expect.any(String), command: expect.any(String) });
    expect(toolDeltas.join('')).toBe(tc.rawJson);
  });

  it('anthropic direct claude-sonnet-5 returns a valid tool call', async ({ skip }) => {
    if (!LIVE) skip('JEVCODE_LIVE is not "1"');
    if (!ANTHROPIC_KEY) skip('ANTHROPIC_API_KEY is empty');
    const cfg: GeneratorConfig = { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: ANTHROPIC_KEY, baseUrl: 'https://api.anthropic.com', temperature: null, maxTokens: 64, pricing: PRICING };
    const redact = redactor(ANTHROPIC_KEY);
    const p = createAnthropicProvider(cfg, { redact });
    const res = await p.generate(REQUEST, { signal: AbortSignal.timeout(120_000) });
    process.stdout.write(redact(`anthropic: model=${res.model} stop=${res.stopReason} in=${res.usage.inputTokens} out=${res.usage.outputTokens} cost=$${res.usage.costUsd.toFixed(6)} latency=${res.latencyMs}ms\n`));
    expect(res.model).toBe('claude-sonnet-5');
    expect(res.usage.costUsd).toBeGreaterThan(0);
    expect(res.usage.costUsd).toBeLessThan(0.02);
    expect(res.toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(res.toolCalls[0]!.name).toBe('propose_action');
    expect(res.toolCalls[0]!.input).toMatchObject({ goal: expect.any(String), command: expect.any(String) });
  });
});
