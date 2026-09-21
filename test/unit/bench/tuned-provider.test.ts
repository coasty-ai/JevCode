/**
 * The jev-off-tuned provider wrapper (docs/LLM-JEV-DESIGN.md §10.1): hygiene on every request, `length` → doubled once
 * with summed usage, the per-call deadline that drops the call into a metered `timeout` stand-in, and the caller's abort
 * passed through untouched.
 */
import { describe, expect, it } from 'vitest';
import { createTunedProvider, estimateDroppedUsage, planCapSentence, withPlanCap, type TunedProviderParams } from '../../../src/bench/tuned-provider.js';
import type { GenerateOptions, GenerateRequest, GenerateResult, Provider } from '../../../src/core/types.js';

const params: TunedProviderParams = { maxTokens: 1500, reasoning: { effort: 'low' }, deadlineMs: 20_000, lengthHandling: 'double-once', servedRate: { inputPerM: 0.15, outputPerM: 0.5 }, planCapChars: 200 };

const request = (): GenerateRequest => ({ system: 'You propose actions.', messages: [{ role: 'user', content: 'x'.repeat(400) }], maxTokens: 4096, temperature: null, tools: [{ name: 'propose_action', description: 'd', inputSchema: { type: 'object' } }], toolChoice: { name: 'propose_action' } });

const result = (over: Partial<GenerateResult>): GenerateResult => ({ text: '', toolCalls: [], usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0001, calls: 1 }, model: 'glm', stopReason: 'tool_calls', latencyMs: 5, ...over });

/** An inner provider answering from a script; a `null` turn hangs until the signal aborts (reporting 400 streamed tool chars). */
function scripted(turns: readonly (GenerateResult | null)[]): Provider & { requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = [];
  return {
    name: 'openrouter',
    model: 'glm',
    requests,
    generate(req: GenerateRequest, o: GenerateOptions): Promise<GenerateResult> {
      requests.push(req);
      const turn = turns[requests.length - 1] ?? null;
      if (turn !== null) return Promise.resolve(turn);
      return new Promise((_, reject) => {
        o.signal.addEventListener(
          'abort',
          () => {
            o.onCancelled?.({ text: '', toolChars: 400, reasoningChars: 0 });
            reject(o.signal.reason);
          },
          { once: true },
        );
      });
    },
  };
}

describe('tuned provider (jev-off-tuned)', () => {
  it('applies the hygiene to every request and passes the rest through', async () => {
    const inner = scripted([result({})]);
    const tuned = createTunedProvider(inner, params);
    const res = await tuned.generate(request(), { signal: new AbortController().signal });
    expect(res.stopReason).toBe('tool_calls');
    expect(inner.requests).toHaveLength(1);
    const sent = inner.requests[0]!;
    expect(sent).toMatchObject({ maxTokens: 1500, reasoning: { effort: 'low' }, temperature: null, toolChoice: { name: 'propose_action' } });
    expect(sent.system.startsWith('You propose actions.')).toBe(true);
    expect(sent.system).toContain(planCapSentence(200));
    expect(withPlanCap(sent.system, 200)).toBe(sent.system);
    expect(tuned.ledger()).toEqual({ calls: 1, timeouts: 0, doubled: 0, lengthStops: 0 });
    expect(tuned.model).toBe('glm');
  });

  it('a length stop re-issues the call once at double max_tokens and returns the summed usage', async () => {
    const inner = scripted([result({ stopReason: 'length', usage: { inputTokens: 100, outputTokens: 1500, costUsd: 0.001, calls: 1 } }), result({ usage: { inputTokens: 100, outputTokens: 200, costUsd: 0.0002, calls: 1, reasoningTokens: 30 } })]);
    const tuned = createTunedProvider(inner, params);
    const res = await tuned.generate(request(), { signal: new AbortController().signal });
    expect(inner.requests.map((r) => r.maxTokens)).toEqual([1500, 3000]);
    expect(res.stopReason).toBe('tool_calls');
    expect(res.usage).toMatchObject({ inputTokens: 200, outputTokens: 1700, calls: 2, reasoningTokens: 30 });
    expect(res.usage.costUsd).toBeCloseTo(0.0012, 12);
    expect(tuned.ledger()).toEqual({ calls: 2, timeouts: 0, doubled: 1, lengthStops: 1 });

    // a second length stop on the doubled call is returned as is: never a third call
    const twice = scripted([result({ stopReason: 'length' }), result({ stopReason: 'length' })]);
    const t2 = createTunedProvider(twice, params);
    const r2 = await t2.generate(request(), { signal: new AbortController().signal });
    expect(r2.stopReason).toBe('length');
    expect(twice.requests).toHaveLength(2);
    expect(t2.ledger()).toMatchObject({ doubled: 1, lengthStops: 2 });
  });

  it('the deadline drops the call into a metered timeout stand-in; the caller\'s abort is rethrown', async () => {
    const inner = scripted([null]);
    const tuned = createTunedProvider(inner, { ...params, deadlineMs: 20 });
    const req = request();
    const res = await tuned.generate(req, { signal: new AbortController().signal });
    expect(res.stopReason).toBe('timeout');
    expect(res.toolCalls).toEqual([]);
    const sent = inner.requests[0]!;
    const expected = estimateDroppedUsage(sent, { text: '', toolChars: 400, reasoningChars: 0 }, params.servedRate);
    expect(res.usage).toEqual(expected);
    expect(expected.estimated).toBe(true);
    expect(expected.outputTokens).toBe(100);
    expect(expected.inputTokens).toBeGreaterThanOrEqual(Math.ceil((sent.system.length + 400) / 4));
    expect(expected.costUsd).toBeCloseTo((expected.inputTokens * 0.15 + 100 * 0.5) / 1_000_000, 12);
    expect(tuned.ledger()).toEqual({ calls: 1, timeouts: 1, doubled: 0, lengthStops: 0 });

    const hang = scripted([null]);
    const t2 = createTunedProvider(hang, params);
    const ac = new AbortController();
    const p = t2.generate(request(), { signal: ac.signal });
    ac.abort(new Error('caller stopped'));
    await expect(p).rejects.toThrow('caller stopped');
    expect(t2.ledger().timeouts).toBe(0);
  });
});
