/**
 * One paid check of the verifier's Jev question (1 request, ≈ $0.0001): the attack-first Choice on
 * the buggy gcd run must return one of the offered failing tests. Skipped unless JEVCODE_LIVE=1
 * and a key are set. Run once:
 *   env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/vitest run --project live test/live/synth-verify.live.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { DeciderConfig } from '../../src/core/types.js';
import { createJevDecider } from '../../src/jev/client.js';
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL } from '../../src/jev/types.js';
import type { JevAsk } from '../../src/synth/types.js';
import { pickNextFailingTest, progress, summarize } from '../../src/synth/verify/index.js';

const apiKey = process.env['JEV_API_KEY'] ?? process.env['OPENROUTER_API_KEY'] ?? '';
const live = process.env['JEVCODE_LIVE'] === '1';
const reason = !live ? 'JEVCODE_LIVE is not 1' : apiKey.length === 0 ? 'no JEV_API_KEY / OPENROUTER_API_KEY in the environment' : null;
const FIXTURES = join(import.meta.dirname, '../fixtures/synth/verify');

describe.skipIf(reason !== null)(`synth/verify live (${reason ?? 'enabled'})`, () => {
  it('progress is code-computed on gcd buggy → correct; attack-first picks an offered test', async () => {
    const cfg: DeciderConfig = { baseUrl: process.env['JEV_BASE_URL'] ?? DEFAULT_JEV_BASE_URL, apiKey, model: DEFAULT_JEV_MODEL, pinned: true };
    const decider = createJevDecider(cfg, { redact: (s) => s.split(apiKey).join('[KEY]') });
    const signal = new AbortController().signal;
    let cost = 0;
    const ask: JevAsk = async (stage, state, questions) => {
      const r = await decider.ask(state, questions, { signal, stage, step: 1 });
      cost += r.usage.costUsd;
      return { answers: r.answers, rows: [], latencyMs: r.latencyMs };
    };

    const before = summarize('run_tests.py gcd', { stdout: readFileSync(join(FIXTURES, 'quixbugs-gcd-buggy.json'), 'utf8'), exitCode: 1 }, 300);
    const after = summarize('run_tests.py gcd', { stdout: readFileSync(join(FIXTURES, 'quixbugs-gcd-correct.json'), 'utf8'), exitCode: 0 }, 300);
    const p = progress(before, after);
    expect(p.allPass).toBe(true);
    expect(p.regressed).toBe(false);

    const pick = await pickNextFailingTest(before.failures, ask);
    expect(before.failing).toContain(pick.testId);
    expect(pick.requests).toBe(1);

    expect(cost).toBeLessThan(0.01);
    console.log(`synth-verify live: pick=${pick.testId} (${pick.method}, p=${pick.probability}) cost=$${cost.toFixed(5)}`);
  });
});
