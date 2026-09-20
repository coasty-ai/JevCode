import { describe, expect, it } from 'vitest';
import { createJevDecider } from '../../../src/jev/client.js';
import { noul } from '../../../src/jev/questions.js';
import { AbortError } from '../../../src/errors.js';
import type { DeciderConfig } from '../../../src/core/types.js';

const cfg: DeciderConfig = { baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: 'sk-or-v1-testkey-0123456789abcdef', model: 'typesafe/jev-1.13-20260917', pinned: true };
const crit = { true: { definition: 'yes', examples: ['a', 'b'] }, false: { definition: 'no', examples: ['c', 'd'] } };

describe('Jev client: abort after headers with a body that never arrives', () => {
  it('rejects with the engine abort reason instead of waiting on the body forever', async () => {
    // headers arrive, then the body stream stays open with no chunks (the undici stall shape)
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel: () => { cancelled = true; } });
    const fetchImpl: typeof fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    const decider = createJevDecider(cfg, { fetch: fetchImpl, redact: (s) => s });
    const controller = new AbortController();
    const p = decider.ask({ x: 1 }, { q: noul('Is `x` positive?', crit) }, { signal: controller.signal, stage: 'intent', step: 1 });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort(new AbortError('human_abort'));
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(cancelled).toBe(true);
  });
});
