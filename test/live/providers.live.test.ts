/**
 * Live smoke test for the registry providers (DESIGN.md §14 `test:live`). One tiny forced-tool request per provider
 * whose key is in the environment: `maxTokens` small, a two-property tool, reasoning at the lowest level each model
 * accepts — a few tenths of a cent in total. Skipped unless JEVCODE_LIVE=1 and the provider's key is present.
 *
 * Nothing here prints a key: every line goes through the provider's own redactor first.
 *
 * Provider notes the assertions encode (measured 2026-09-21):
 *  - meta cannot be asked for a specific tool (`tool_choice` must be `auto`), so its tool call is expected but not
 *    required, and it is the one provider with no published price (`priced: false` ⇒ `costUsd` NaN).
 *  - gemini answers 403 SERVICE_DISABLED for THIS project's key (the Gemini API is switched off for its Google Cloud
 *    project): the case calls the API, prints the reason and then skips, exactly as it would for an absent key, so the
 *    day the key is enabled the same assertions run for real.
 *  - openai runs on the Responses API, where a forced tool call is the only supported form on the current flagships.
 */
import { describe, expect, it } from 'vitest';
import { ProviderHttpError } from '../../src/errors.js';
import { PROPOSE_ACTION_TOOL } from '../../src/provider/actions.js';
import { createProvider, providerFor } from '../../src/provider/registry.js';
import { pricingFor } from '../../src/provider/pricing.js';
import type { GenerateRequest, ToolSpec } from '../../src/core/types.js';
import type { ProviderConfig, ProviderId } from '../../src/provider/types.js';

const LIVE = process.env['JEVCODE_LIVE'] === '1';

/** A propose_action-like tool kept tiny so the reply fits in a small budget; strict-mode compatible on purpose. */
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

const REQUEST: GenerateRequest = {
  system: 'You are a coding agent. Reply only by calling the propose_action tool. Keep goal under 8 words.',
  messages: [{ role: 'user', content: 'Task: list the files in the current directory. Propose the single command.' }],
  // the Responses API's budget includes hidden reasoning tokens, so it has to be more than a handful
  maxTokens: 1024,
  temperature: null,
  tools: [TOOL],
  toolChoice: { name: 'propose_action' },
  reasoning: { effort: 'low' },
};

function redactor(...keys: string[]): (s: string) => string {
  return (s) => {
    let out = s;
    for (const k of keys) if (k.length >= 8) out = out.split(k).join('[REDACTED:key]');
    return out
      .replace(/sk-(ant|or-v1|proj)-[A-Za-z0-9_-]{20,}/g, '[REDACTED:pattern]')
      .replace(/AIza[A-Za-z0-9_-]{20,}/g, '[REDACTED:pattern]')
      .replace(/fw_[A-Za-z0-9]{20,}/g, '[REDACTED:pattern]')
      .replace(/xai-[A-Za-z0-9]{20,}/g, '[REDACTED:pattern]')
      .replace(/LLM\|\d+\|[A-Za-z0-9_.-]{10,}/g, '[REDACTED:pattern]');
  };
}

function configFor(id: ProviderId, apiKey: string): ProviderConfig {
  const spec = providerFor(id)!;
  const model = process.env[`JEVCODE_LIVE_${id.toUpperCase()}_MODEL`] ?? spec.defaultModel;
  const pricing = pricingFor(id, model);
  return {
    model,
    apiKey,
    baseUrl: spec.baseUrl,
    temperature: null,
    maxTokens: REQUEST.maxTokens,
    pricing: pricing ?? { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 },
    ...(pricing !== null ? { priced: true } : {}),
  };
}

/**
 * "The key is valid but its project has this API disabled" — Google's 403 `SERVICE_DISABLED` / `API_KEY_SERVICE_BLOCKED`,
 * which is what this project's GEMINI_API_KEY answers today. Treated like a missing key, never like a client defect.
 */
function notEnabled(e: unknown): boolean {
  return e instanceof ProviderHttpError && e.status === 403 && /SERVICE_DISABLED|API_KEY_SERVICE_BLOCKED|not been used in project/.test(e.message);
}

/** anthropic is included so the whole registry is exercised in one report (its own suite covers it in more depth). */
const CASES: readonly { id: ProviderId; expectForcedTool: boolean; expectPriced: boolean }[] = [
  { id: 'openai', expectForcedTool: true, expectPriced: true },
  { id: 'gemini', expectForcedTool: true, expectPriced: true },
  { id: 'fireworks', expectForcedTool: true, expectPriced: true },
  { id: 'meta', expectForcedTool: false, expectPriced: false },
  { id: 'xai', expectForcedTool: true, expectPriced: true },
  { id: 'anthropic', expectForcedTool: true, expectPriced: true },
];

describe('live providers', () => {
  for (const c of CASES) {
    const spec = providerFor(c.id)!;
    it(`${c.id}: one forced tool call on ${spec.defaultModel}`, async ({ skip }) => {
      if (!LIVE) skip('JEVCODE_LIVE is not "1"');
      const key = process.env[spec.keyEnv] ?? '';
      if (!key) skip(`${spec.keyEnv} is empty`);
      const redact = redactor(key);
      const cfg = configFor(c.id, key);
      const provider = createProvider(spec, cfg, { redact });
      const toolDeltas: string[] = [];
      const res = await provider.generate(REQUEST, { signal: AbortSignal.timeout(180_000), onToolDelta: (f) => toolDeltas.push(f) }).catch((e: unknown) => {
        // A key whose project has the API switched off is a configuration fact about this machine, not a defect in the
        // client: report it and skip, exactly like an empty key. Any other failure is a real one and propagates.
        if (notEnabled(e)) {
          process.stdout.write(redact(`${c.id}: SKIPPED — ${(e as Error).message}\n`));
          skip(`${spec.keyEnv} exists but the API is not enabled for its project`);
        }
        throw e;
      });
      const cost = Number.isNaN(res.usage.costUsd) ? 'unpriced' : `$${res.usage.costUsd.toFixed(6)}`;
      const call = res.toolCalls[0];
      process.stdout.write(
        redact(
          `${c.id}: model=${res.model} stop=${res.stopReason} in=${res.usage.inputTokens} out=${res.usage.outputTokens} reasoning=${res.usage.reasoningTokens ?? '-'} ` +
            `cost=${cost} latency=${res.latencyMs}ms tools=${res.toolCalls.length} parsed=${call !== undefined && call.input !== null}\n`,
        ),
      );
      expect(res.usage.inputTokens).toBeGreaterThan(0);
      expect(res.model.length).toBeGreaterThan(0);
      if (c.expectPriced) {
        expect(res.usage.costUsd).toBeGreaterThan(0);
        expect(res.usage.costUsd).toBeLessThan(0.05);
      } else {
        // no published price: the engine must see NaN and report budget:unpriced rather than $0
        expect(Number.isNaN(res.usage.costUsd)).toBe(true);
      }
      if (c.expectForcedTool) {
        expect(res.toolCalls.length).toBeGreaterThanOrEqual(1);
        expect(call!.name).toBe('propose_action');
        expect(call!.input).not.toBeNull();
        expect(JSON.parse(call!.rawJson)).toEqual(call!.input);
        expect(call!.input).toMatchObject({ goal: expect.any(String), command: expect.any(String) });
        expect(toolDeltas.join('')).toBe(call!.rawJson);
      }
    });
  }

  it("openai accepts the harness's own propose_action schema without strict mode", async ({ skip }) => {
    if (!LIVE) skip('JEVCODE_LIVE is not "1"');
    const key = process.env['OPENAI_API_KEY'] ?? '';
    if (!key) skip('OPENAI_API_KEY is empty');
    const redact = redactor(key);
    const provider = createProvider(providerFor('openai')!, configFor('openai', key), { redact });
    const res = await provider.generate(
      {
        system: 'You are a coding agent. Reply only by calling the propose_action tool.',
        messages: [{ role: 'user', content: 'Task: list the files in the repository root. Propose exactly one action.' }],
        maxTokens: 1024,
        temperature: null,
        tools: [PROPOSE_ACTION_TOOL],
        toolChoice: { name: PROPOSE_ACTION_TOOL.name },
        reasoning: { effort: 'low' },
      },
      { signal: AbortSignal.timeout(180_000) },
    );
    process.stdout.write(redact(`openai propose_action: stop=${res.stopReason} tools=${res.toolCalls.length} cost=$${res.usage.costUsd.toFixed(6)} latency=${res.latencyMs}ms\n`));
    expect(res.toolCalls.length).toBe(1);
    const input = res.toolCalls[0]!.input as { action?: { kind?: string } } | null;
    expect(input).not.toBeNull();
    expect(typeof input!.action?.kind).toBe('string');
  });
});
