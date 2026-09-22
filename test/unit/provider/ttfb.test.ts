/**
 * contract 1.9 (Fastlane) §3.1 — the first-byte callback (docs/LLM-LOOP-DESIGN.md §3.1,
 * HARNESS-NEXT-DESIGN.md §6 S2: "no TTFB callback on `src/provider/sse.ts`").
 *
 * Why the harness needs it at all. The exposed generator wait is 29–30 % of a step's wall
 * (HARNESS-NEXT-DESIGN.md §6 table) and the whole of §3.2's hedge turns on ONE distinction the
 * harness could not draw before this: a sample that is being SERVED SLOWLY versus a sample the
 * provider has not started answering. `latencyMs` on a finished `GenerateResult` answers neither,
 * because it only exists once the call is over. The recorded evidence is the same 135 zero-token
 * timeouts §4.8 rev 4 is built on (`generator.jsonl`: `stopReason:"timeout"`, `outputTokens: 0`,
 * `latencyMs` ≈ the deadline) — every one of those calls was silent from the first byte onward,
 * and nothing in the tree could see it while it was happening.
 *
 * What is asserted here: the callback fires ONCE, before the first record is parsed, with a
 * figure measured from the REQUEST going out (the header phase included) rather than from the
 * body's first read, and a throwing callback is a harness bug (typed, never a transport retry).
 */
import { describe, expect, it } from 'vitest';

import { JevCodeError } from '../../../src/errors.js';
import { parseSse, readStreamText } from '../../../src/provider/sse.js';
import { createOpenRouterProvider } from '../../../src/provider/openrouter.js';
import { createAnthropicProvider } from '../../../src/provider/anthropic.js';
import { createOpenAiProvider } from '../../../src/provider/openai.js';
import { anthropicCfg, bodyStream, fixture, genOpts, openrouterCfg, providerCfg, providerDeps, request, scriptedFetch, splitEvery, testDeps } from './helpers.js';

const sse = (name: string) => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: fixture(name) });

describe('§3.1 parseSse: onFirstByte', () => {
  it('fires exactly once, before the first record is yielded, and not at all on an empty body', async () => {
    const seen: number[] = [];
    const order: string[] = [];
    const { stream } = bodyStream(['data: a\n\n', 'data: b\n\n', 'data: c\n\n']);
    for await (const rec of parseSse(stream, {
      onFirstByte: (ms) => {
        seen.push(ms);
        order.push('ttfb');
      },
    })) {
      order.push(rec.data);
    }
    expect(order).toEqual(['ttfb', 'a', 'b', 'c']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThanOrEqual(0);

    const empty: number[] = [];
    const closed = bodyStream([]);
    for await (const _rec of parseSse(closed.stream, { onFirstByte: (ms) => empty.push(ms) })) {
      throw new Error('an empty body yields no record');
    }
    // a 200 whose body closed without a byte was never served: reporting a TTFB there would poison the p50
    expect(empty).toEqual([]);
  });

  it('fires once even when the first chunk is split across reads, and `readStreamText` reports it too', async () => {
    const seen: number[] = [];
    // every chunk is 4 bytes, so the first SSE event spans several reads
    const { stream } = bodyStream(splitEvery('data: hello world\n\ndata: again\n\n', 4));
    const records = [];
    for await (const rec of parseSse(stream, { onFirstByte: (ms) => seen.push(ms) })) records.push(rec.data);
    expect(records).toEqual(['hello world', 'again']);
    expect(seen).toHaveLength(1);

    const jsonSeen: number[] = [];
    const json = bodyStream(splitEvery('{"ok":true}', 3));
    expect(await readStreamText(json.stream, { onFirstByte: (ms) => jsonSeen.push(ms) })).toBe('{"ok":true}');
    expect(jsonSeen).toHaveLength(1);
  });

  it('treats a throwing callback as a harness bug (typed JevCodeError), exactly like a throwing onDelta', async () => {
    const { stream } = bodyStream(['data: a\n\n']);
    const it2 = parseSse(stream, {
      onFirstByte: () => {
        throw new Error('renderer bug');
      },
    });
    await expect(it2.next()).rejects.toBeInstanceOf(JevCodeError);
  });
});

describe('§3.1 the clients: TTFB is measured from the request going out', () => {
  it('openrouter reports one TTFB per generate, and none when the caller asked for none', async () => {
    const f = scriptedFetch([sse('openrouter-tool.sse')]);
    const { deps } = testDeps(f.fetch);
    const seen: number[] = [];
    await createOpenRouterProvider(openrouterCfg(), deps).generate(request(), genOpts({ onFirstByte: (ms) => seen.push(ms) }));
    expect(seen).toHaveLength(1);
    // testDeps' clock advances 7 ms per read, and the header phase is inside the figure: it is never 0
    expect(seen[0]).toBeGreaterThan(0);

    const f2 = scriptedFetch([sse('openrouter-tool.sse')]);
    const res = await createOpenRouterProvider(openrouterCfg(), testDeps(f2.fetch).deps).generate(request(), genOpts());
    expect(res.toolCalls).toHaveLength(1);
  });

  it('anthropic and the shared http caller report it too', async () => {
    const f = scriptedFetch([sse('anthropic-tool.sse')]);
    const { deps } = testDeps(f.fetch);
    const seen: number[] = [];
    await createAnthropicProvider(anthropicCfg(), deps).generate(request(), genOpts({ onFirstByte: (ms) => seen.push(ms) }));
    expect(seen).toHaveLength(1);

    const g = scriptedFetch([sse('openai-chat-tool.sse')]);
    const gd = providerDeps(g.fetch);
    const openaiSeen: number[] = [];
    await createOpenAiProvider(providerCfg({ model: 'gpt-5.6-terra', baseUrl: 'https://api.openai.com/v1' }), gd.deps, { api: 'chat' }).generate(request(), genOpts({ onFirstByte: (ms) => openaiSeen.push(ms) }));
    expect(openaiSeen).toHaveLength(1);
  });

  it('reports the attempt that actually streamed: a retried call reports once, not once per attempt', async () => {
    const f = scriptedFetch([{ status: 503, body: '{"error":{"message":"upstream"}}' }, sse('openrouter-tool.sse')]);
    const { deps } = testDeps(f.fetch);
    const seen: number[] = [];
    const res = await createOpenRouterProvider(openrouterCfg(), deps).generate(request(), genOpts({ onFirstByte: (ms) => seen.push(ms) }));
    expect(res.toolCalls).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
    // the 503 never opened a stream, so it reports nothing: the hedge threshold must not learn from a failed attempt
    expect(seen).toHaveLength(1);
  });
});
