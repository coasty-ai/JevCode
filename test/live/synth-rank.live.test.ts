/**
 * One live check of the ranker's request shapes against typesafe/jev-1.13 (two requests,
 * ~5k input tokens, < $0.001). Skipped unless JEVCODE_LIVE=1 and a key is present. Run once:
 *   env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/vitest run --project live test/live/synth-rank.live.test.ts
 */
import { describe, expect, it } from 'vitest';

import type { DeciderConfig } from '../../src/core/types.js';
import { createJevDecider } from '../../src/jev/client.js';
import { JEV_PROVIDERS } from '../../src/jev/providers.js';
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL } from '../../src/jev/types.js';
import { createRanker } from '../../src/synth/rank/index.js';
import type { Candidate, JevAsk } from '../../src/synth/types.js';
import { GCD_BUGGY_LINE, GCD_FILE, GCD_FIX, candidate, context, siteAt } from '../unit/synth/rank/helpers.js';

const apiKey = process.env['JEV_API_KEY'] ?? process.env['OPENROUTER_API_KEY'] ?? '';
const live = process.env['JEVCODE_LIVE'] === '1';
const reason = !live ? 'JEVCODE_LIVE is not 1' : apiKey.length === 0 ? 'no JEV_API_KEY / OPENROUTER_API_KEY in the environment' : null;

describe.skipIf(reason !== null)(`synth rank live (${reason ?? 'enabled'})`, () => {
  it('ranks the gcd fix first with a 5-way Choice and with a 20-way Choice + compact Nouls', async () => {
    const cfg: DeciderConfig = { provider: 'openrouter', baseUrl: process.env['JEV_BASE_URL'] ?? DEFAULT_JEV_BASE_URL, apiKey, model: DEFAULT_JEV_MODEL, pinned: true, pricing: JEV_PROVIDERS.openrouter.pricing, providerSource: 'default' };
    const decider = createJevDecider(cfg, { redact: (s) => s.split(apiKey).join('[KEY]') });
    const controller = new AbortController();
    let costUsd = 0;
    let tokens = 0;
    const ask: JevAsk = async (stage, state, questions) => {
      const r = await decider.ask(state, questions, { signal: controller.signal, stage, step: 1 });
      costUsd += r.usage.costUsd;
      tokens += r.usage.inputTokens;
      return { answers: r.answers, rows: [], latencyMs: r.latencyMs };
    };
    const site = siteAt(GCD_FILE, GCD_BUGGY_LINE);
    // Real first-order mutants of `return gcd(a % b, b)` (the probe's operator library shapes).
    const mutants = [
      '        return gcd(a % b, a)',
      '        return gcd(b % a, b)',
      '        return gcd(a // b, b)',
      '        return gcd(a % b, b - 1)',
      '        return gcd(a % b, b + 1)',
      '        return gcd(a, b)',
      '        return gcd(b, a)',
      '        return gcd(a % b, b) + 1',
      '        return gcd(a - b, b)',
      '        return gcd(a % b, a % b)',
      '        return gcd(b, b % a)',
      '        return gcd(a % b, 0)',
      '        return gcd(a % b, 1)',
      '        return a % b',
      '        return gcd(a * b, b)',
      '        return gcd(a % b, -b)',
      '        return gcd(-a % b, b)',
      '        return gcd(a % (b + 1), b)',
      '        return gcd(a % b, b) - 1',
    ];
    const withFix = (n: number, at: number): Candidate[] => {
      const cs = mutants.slice(0, n - 1).map((t, i) => candidate(site, t, { id: `m${i}` }));
      cs.splice(at, 0, candidate(site, GCD_FIX, { id: 'fix' }));
      return cs;
    };
    const ranker = createRanker();
    const ctx = context(ask, { task: 'Fix the bug in gcd.py so that the QuixBugs tests pass.', signal: controller.signal });

    const small = await ranker.rank(withFix(5, 2), ctx);
    expect(small.method).toBe('choice');
    expect(small.requests).toBe(1);
    expect(small.ranked).toHaveLength(5);

    const hybrid = await ranker.rank(withFix(20, 13), ctx);
    expect(hybrid.method).toBe('nouls');
    expect(hybrid.requests).toBe(1);
    expect(hybrid.ranked).toHaveLength(20);
    expect(hybrid.ranked[0]?.noulProbability).toBeDefined();
    expect(hybrid.ranked[0]?.choiceProbability).toBeDefined();

    process.stdout.write(
      `[rank live] tokens=${tokens} cost=$${costUsd.toFixed(6)}\n` +
        `  choice(5):  top=${small.ranked[0]?.candidate.id} p=${small.ranked[0]?.probability.toFixed(2)} pEscape=${small.escapeProbability.toFixed(2)} absent=${small.fixProbablyAbsent} fixRank=${small.ranked.find((r) => r.candidate.id === 'fix')?.rank}\n` +
        `  nouls(20):  top=${hybrid.ranked[0]?.candidate.id} noul=${hybrid.ranked[0]?.noulProbability?.toFixed(2)} choiceP=${hybrid.ranked[0]?.choiceProbability?.toFixed(2)} pEscape=${hybrid.escapeProbability.toFixed(2)} maxNoul=${hybrid.signals.maxNoul?.toFixed(2)} absent=${hybrid.fixProbablyAbsent} fixRank=${hybrid.ranked.find((r) => r.candidate.id === 'fix')?.rank}\n`,
    );
    expect(costUsd).toBeLessThan(0.01);
    // Jev is a model, so the assertion is the measured floor (top-3 40/40 at N ≤ 50), not top-1.
    expect(small.ranked.findIndex((r) => r.candidate.id === 'fix')).toBeLessThan(3);
    expect(hybrid.ranked.findIndex((r) => r.candidate.id === 'fix')).toBeLessThan(3);
  });
});
