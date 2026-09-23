/**
 * AGENT-LOOP-DESIGN §15 S2 live check: per provider with a key, a three-turn native tool conversation through the agent
 * wire (`GenerateRequest.agent`). The tool `get_file` returns canned text the model cannot guess; the model must call it
 * twice (in parallel or one after the other) and then answer using both values (the port plus 17). The answer turn is
 * appended and one follow-up question asked, and every assistant turn carries its `providerState`, so whatever reasoning
 * state any turn returned is replayed at least once — Anthropic under `strictReplay: true`, where any prefix edit is a
 * 400. A second Anthropic case forces a thinking turn (the round trip is too easy for adaptive thinking to engage).
 *
 * Skipped unless JEVCODE_LIVE=1 and the provider's key is present; gemini reports this project's known 403
 * (API_KEY_SERVICE_BLOCKED) and skips. Run (keys never printed — every line goes through the redactor):
 *   env -u ANTHROPIC_API_KEY JEVCODE_LIVE=1 node --env-file=<repo>/.env node_modules/vitest/vitest.mjs run --project live test/live/agent-tools.live.test.ts
 *
 * Spend: small prompts, low effort except Anthropic's §6.3 `high`; a few tenths of a cent per provider (the line printed
 * per provider carries the measured cost).
 */
import { describe, expect, it } from 'vitest';
import { ProviderHttpError } from '../../src/errors.js';
import { createProvider, providerFor } from '../../src/provider/registry.js';
import { pricingFor } from '../../src/provider/pricing.js';
import type { AgentAssistantBlock, AgentMessage, GenerateReasoning, GenerateRequest, Json, ToolSpec } from '../../src/core/types.js';
import type { ProviderConfig, ProviderId } from '../../src/provider/types.js';

const LIVE = process.env['JEVCODE_LIVE'] === '1';
const MAX_TURNS = 6;

const GET_FILE: ToolSpec = {
  name: 'get_file',
  description: 'Return the contents of one file of the workspace.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', description: 'workspace-relative path' } } },
};

const FILES: Readonly<Record<string, string>> = {
  'config/host.txt': 'host = kestrel-7.internal',
  'config/port.txt': 'port = 48213',
};

const SYSTEM = 'You are a coding agent. Use the tools you are given to read files; never guess file contents.';
const FOLLOW_UP = 'Now reply with only the host name, nothing else.';
const TASK =
  'Use get_file to read config/host.txt and config/port.txt (one get_file call per file). The service listens on the port from the file plus 17. Reply with the service URL in the form http://HOST:PORT and nothing else.';

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
    maxTokens: 4096,
    pricing: pricing ?? { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 },
    ...(pricing !== null ? { priced: true } : {}),
  };
}

function notEnabled(e: unknown): boolean {
  return e instanceof ProviderHttpError && e.status === 403 && /SERVICE_DISABLED|API_KEY_SERVICE_BLOCKED|not been used in project/.test(e.message);
}

function fileFor(input: Json): string {
  const path = typeof input === 'object' && input !== null && !Array.isArray(input) && typeof input['path'] === 'string' ? input['path'] : '';
  return FILES[path] ?? `ERROR: ${path}: no such file`;
}

/**
 * §6.3's per-provider effort for this check: the lowest each adapter maps, except Anthropic's `high` (so it thinks and the
 * replay is exercised). `JEVCODE_LIVE_AGENT_EFFORT=high` raises every case, which makes a low-effort model (GLM at `low`
 * often reasons zero tokens) return reasoning state, so its replay is exercised too.
 */
const EFFORT = process.env['JEVCODE_LIVE_AGENT_EFFORT'];
const override: GenerateReasoning | null = EFFORT === 'low' || EFFORT === 'medium' || EFFORT === 'high' ? { effort: EFFORT } : null;
const CASES: readonly { id: ProviderId; reasoning: GenerateReasoning; strictReplay?: true }[] = [
  { id: 'openrouter', reasoning: { effort: 'low' } },
  { id: 'anthropic', reasoning: { effort: 'high' }, strictReplay: true },
  { id: 'openai', reasoning: { effort: 'low' } },
  { id: 'xai', reasoning: { effort: 'low' } },
  { id: 'fireworks', reasoning: { effort: 'low' } },
  { id: 'meta', reasoning: { effort: 'low' } },
  { id: 'gemini', reasoning: { effort: 'low' } },
];

describe('live agent tool round trip (AGENT-LOOP-DESIGN §15 S2)', () => {
  for (const c of CASES) {
    const spec = providerFor(c.id)!;
    it(`${c.id}: get_file twice, then an answer that uses both results`, async ({ skip }) => {
      if (!LIVE) skip('JEVCODE_LIVE is not "1"');
      const key = process.env[spec.keyEnv] ?? '';
      if (!key) skip(`${spec.keyEnv} is empty`);
      const redact = redactor(key);
      const cfg = configFor(c.id, key);
      const provider = createProvider(spec, cfg, { redact });
      const cacheKey = `s2-live-${c.id}-${Date.now().toString(36)}`;
      const messages: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: TASK }] }];
      const ttfb: number[] = [];
      const perTurnCalls: number[] = [];
      const streamedIds = new Set<string>();
      let reasoningChars = 0;
      let calls = 0;
      let parsed = true;
      let stateTurns = 0;
      let replayedTurns = 0;
      let cost = 0;
      let answer: string | null = null;
      let followUp: string | null = null;
      const warnings: string[] = [];
      let served = '';
      for (let turn = 1; turn <= MAX_TURNS && followUp === null; turn++) {
        const replaying = messages.some((m) => m.role === 'assistant' && m.providerState !== undefined);
        const req: GenerateRequest = {
          system: SYSTEM,
          messages: [],
          maxTokens: cfg.maxTokens,
          temperature: null,
          tools: [GET_FILE],
          toolChoice: 'auto',
          reasoning: override ?? c.reasoning,
          agent: { messages: structuredClone(messages), parallelToolCalls: true, cacheKey, replayReasoning: true, ...(c.strictReplay ? { strictReplay: true } : {}) },
        };
        const res = await provider
          .generate(req, {
            signal: AbortSignal.timeout(180_000),
            onFirstByte: (ms) => ttfb.push(ms),
            onToolCall: (d) => {
              if (d.id !== undefined) streamedIds.add(d.id);
            },
            onReasoning: (r) => {
              reasoningChars += r.length;
            },
          })
          .catch((e: unknown) => {
            if (notEnabled(e)) {
              process.stdout.write(redact(`${c.id}: SKIPPED — ${(e as Error).message}\n`));
              skip(`${spec.keyEnv} exists but the API is not enabled for its project`);
            }
            throw e;
          });
        if (replaying) replayedTurns++;
        cost += Number.isNaN(res.usage.costUsd) ? 0 : res.usage.costUsd;
        served = res.servedProvider ?? res.model;
        warnings.push(...(res.warnings ?? []));
        if (res.providerState !== undefined) {
          stateTurns++;
          // the replay rule's key: the configured model, never the served id
          expect(res.providerState).toMatchObject({ provider: c.id, model: cfg.model });
        }
        perTurnCalls.push(res.toolCalls.length);
        const state = res.providerState !== undefined ? { providerState: res.providerState } : {};
        if (res.toolCalls.length === 0) {
          if (answer !== null) {
            followUp = res.text;
            break;
          }
          // the answer turn is appended with its state and one more question asked, so whatever reasoning state any
          // turn returned (the answer's included) is replayed at least once
          answer = res.text;
          messages.push({ role: 'assistant', content: [{ type: 'text', text: res.text.length > 0 ? res.text : '(no text)' }], ...state });
          messages.push({ role: 'user', content: [{ type: 'text', text: FOLLOW_UP }] });
          continue;
        }
        const content: AgentAssistantBlock[] = res.text.length > 0 ? [{ type: 'text', text: res.text }] : [];
        for (const call of res.toolCalls) {
          calls++;
          expect(call.id).toBeTruthy();
          if (call.name !== 'get_file' || call.input === null) parsed = false;
          content.push({ type: 'tool_use', id: call.id!, name: call.name, input: call.input ?? {} });
        }
        messages.push({ role: 'assistant', content, ...state });
        messages.push({ role: 'user', content: res.toolCalls.map((call) => ({ type: 'tool_result' as const, toolUseId: call.id!, name: call.name, content: fileFor(call.input) })) });
      }
      const replay = stateTurns === 0 ? 'no state returned' : replayedTurns > 0 ? `accepted on ${replayedTurns} turn(s)` : 'state returned, never replayed';
      process.stdout.write(
        redact(
          `${c.id}: model=${cfg.model} served=${served} turns=${perTurnCalls.length} calls/turn=[${perTurnCalls.join(',')}] parsed=${parsed} ` +
            `parallel=${perTurnCalls.some((n) => n >= 2)} state=${stateTurns} replay=${replay} reasoningChars=${reasoningChars} streamedIds=${streamedIds.size} ` +
            `ttfb=[${ttfb.map((ms) => `${ms}ms`).join(',')}] cost=$${cost.toFixed(5)} warnings=${warnings.length} answer=${JSON.stringify((answer ?? '').slice(0, 60))} ` +
            `followUp=${JSON.stringify((followUp ?? '').slice(0, 40))}\n`,
        ),
      );
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(parsed).toBe(true);
      expect(answer).not.toBeNull();
      expect(answer!).toContain('kestrel-7.internal');
      expect(answer!).toContain('48230');
      expect(followUp).not.toBeNull();
      expect(followUp!).toContain('kestrel-7');
      // every turn after the first that returned state replayed it; a replay the provider rejected would have thrown
      if (stateTurns > 0) expect(replayedTurns).toBeGreaterThan(0);
      if (c.id === 'anthropic') expect(warnings).toEqual([]);
      expect(cost).toBeLessThan(0.1);
    });
  }

  /**
   * The round trip above does not make Sonnet 5 think (adaptive thinking skips an easy turn), so the thinking replay is
   * pinned here: a turn that has to reason before its call, whose thinking blocks (summarized text + signature) are then
   * replayed under `prefix_mismatch_behavior: 'error'` — any prefix edit by the adapter would be a 400.
   */
  it('anthropic: a thinking turn replayed under strictReplay', async ({ skip }) => {
    if (!LIVE) skip('JEVCODE_LIVE is not "1"');
    const spec = providerFor('anthropic')!;
    const key = process.env[spec.keyEnv] ?? '';
    if (!key) skip(`${spec.keyEnv} is empty`);
    const redact = redactor(key);
    const cfg = configFor('anthropic', key);
    const provider = createProvider(spec, cfg, { redact });
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'First find the smallest prime n > 1 with n^2 ≡ 1 (mod 120); reason it through. Then call get_file on config/n-<n>.txt and report the secret it holds.' }] },
    ];
    const req = (): GenerateRequest => ({
      system: SYSTEM,
      messages: [],
      maxTokens: 8000,
      temperature: null,
      tools: [GET_FILE],
      toolChoice: 'auto',
      reasoning: { effort: 'high' },
      agent: { messages: structuredClone(messages), parallelToolCalls: true, cacheKey: `s2-live-strict-${Date.now().toString(36)}`, replayReasoning: true, strictReplay: true },
    });
    let summary = 0;
    const first = await provider.generate(req(), { signal: AbortSignal.timeout(180_000), onReasoning: (t) => (summary += t.length) });
    expect(first.toolCalls.length).toBeGreaterThan(0);
    const blocks = JSON.stringify(first.providerState?.data ?? null);
    expect(blocks).toMatch(/"type":"thinking"/);
    expect(blocks).toMatch(/"signature":"[^"]+"/);
    messages.push({
      role: 'assistant',
      content: [...(first.text.length > 0 ? [{ type: 'text' as const, text: first.text }] : []), ...first.toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id!, name: c.name, input: c.input ?? {} }))],
      providerState: first.providerState!,
    });
    messages.push({ role: 'user', content: first.toolCalls.map((c) => ({ type: 'tool_result' as const, toolUseId: c.id!, name: c.name, content: 'secret = zebra-41' })) });
    const second = await provider.generate(req(), { signal: AbortSignal.timeout(180_000) });
    const cost = first.usage.costUsd + second.usage.costUsd;
    process.stdout.write(
      redact(
        `anthropic strict replay: call=${first.toolCalls[0]!.rawJson} summaryChars=${summary} replay=accepted (error mode) warnings=${(second.warnings ?? []).length} ` +
          `cost=$${cost.toFixed(5)} answer=${JSON.stringify(second.text.slice(0, 60))}\n`,
      ),
    );
    expect(summary).toBeGreaterThan(0);
    expect(second.warnings).toBeUndefined();
    expect(second.text).toContain('zebra-41');
    expect(cost).toBeLessThan(0.1);
  });
});
