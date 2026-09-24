/**
 * One paid localisation of the QuixBugs `gcd` program (single-file path: one line Choice,
 * ~1,100 input tokens, < $0.0001). Skipped unless JEVCODE_LIVE=1 and a key is present. Run once:
 *   env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/vitest run --project live test/live/synth-localize.live.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DeciderConfig } from '../../src/core/types.js';
import { createJevDecider } from '../../src/jev/client.js';
import { JEV_PROVIDERS } from '../../src/jev/providers.js';
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL } from '../../src/jev/types.js';
import { createLocalizer } from '../../src/jev-modes/synth/localize/index.js';
import { analyse } from '../../src/jev-modes/synth/py/index.js';
import type { FailureView, JevAsk } from '../../src/jev-modes/synth/types.js';

const apiKey = process.env['JEV_API_KEY'] ?? process.env['OPENROUTER_API_KEY'] ?? '';
const live = process.env['JEVCODE_LIVE'] === '1';
const reason = !live ? 'JEVCODE_LIVE is not 1' : apiKey.length === 0 ? 'no JEV_API_KEY / OPENROUTER_API_KEY in the environment' : null;
const here = dirname(fileURLToPath(import.meta.url));

describe.skipIf(reason !== null)(`synth localize live (${reason ?? 'enabled'})`, () => {
  it('localises the gcd bug to line 5 with one request', async () => {
    const cfg: DeciderConfig = { provider: 'openrouter', baseUrl: process.env['JEV_BASE_URL'] ?? DEFAULT_JEV_BASE_URL, apiKey, model: DEFAULT_JEV_MODEL, pinned: true, pricing: JEV_PROVIDERS.openrouter.pricing, providerSource: 'default' };
    const redact = (s: string): string => s.split(apiKey).join('[KEY]');
    const decider = createJevDecider(cfg, { redact });
    const controller = new AbortController();
    let costUsd = 0;
    let tokens = 0;
    const ask: JevAsk = async (stage, state, questions) => {
      const r = await decider.ask(state, questions, { signal: controller.signal, stage, step: 1 });
      costUsd += r.usage.costUsd;
      tokens += r.usage.inputTokens;
      return { answers: r.answers, rows: [], latencyMs: r.latencyMs };
    };
    const src = readFileSync(join(here, '../fixtures/synth/localize/gcd.py'), 'utf8');
    const failures: FailureView[] = [
      { testId: 'gcd[1]', call: 'gcd(13, 13)', expected: '13', actual: 'RecursionError: maximum recursion depth exceeded' },
      { testId: 'gcd[2]', call: 'gcd(37, 600)', expected: '1', actual: 'RecursionError: maximum recursion depth exceeded' },
      { testId: 'gcd[3]', call: 'gcd(20, 100)', expected: '20', actual: 'RecursionError: maximum recursion depth exceeded' },
    ];
    const task = 'The Python function `gcd` has a single-line bug. `tests` give inputs and the expected output; at least one of them fails on the buggy program. Exactly one line of `program` must change to fix it.';
    const res = await createLocalizer().localize({ ask, task, files: new Map([['gcd.py', { path: 'gcd.py', src, mod: analyse(src) }]]), failures, signal: controller.signal, budget: { maxRequests: 2 } });
    expect(res.requests).toBe(1);
    expect(costUsd).toBeLessThan(0.001);
    const first = res.sites[0]!;
    process.stdout.write(`[localize live] tokens=${tokens} cost=$${costUsd.toFixed(6)} top=${res.sites.slice(0, 3).map((s) => `L${s.line}${s.kind === 'insert' ? '+' : ''}(${s.evidence.jevProbability?.toFixed(2) ?? '-'})`).join(' ')}\n`);
    // Measured D on gcd: line 5 at 0.86; Jev is a model, so assert the beam, not the exact pick.
    expect(res.sites.filter((s) => s.kind === 'replace').slice(0, 3).map((s) => s.line)).toContain(5);
    expect(first.block?.name).toBe('gcd');
  });
});
