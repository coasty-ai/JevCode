/**
 * One small paid check of the token-beam source against the pinned Jev model: the gcd
 * fix line through the template route (width 1) and a short beam, together ≤ 16 requests of
 * ~3,000 input tokens (≈ $0.002). Skipped unless JEVCODE_LIVE=1 and a key is present. Run once:
 *   env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/vitest run --project live test/live/synth-beam.live.test.ts
 * Nothing here prints a key.
 */
import { describe, expect, it } from 'vitest';
import type { Answer, DeciderConfig, Json, Question, StageName } from '../../src/core/types.js';
import { createJevDecider } from '../../src/jev/client.js';
import { JEV_PROVIDERS } from '../../src/jev/providers.js';
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL } from '../../src/jev/types.js';
import { createTokenBeamSource } from '../../src/jev-modes/synth/beam/index.js';
import { analyse, blockAt, scopeAt } from '../../src/jev-modes/synth/py/index.js';
import type { JevAsk, Site, SourceFile } from '../../src/jev-modes/synth/types.js';

const apiKey = process.env['JEV_API_KEY'] ?? process.env['OPENROUTER_API_KEY'] ?? '';
const live = process.env['JEVCODE_LIVE'] === '1';
const reason = !live ? 'JEVCODE_LIVE is not 1' : apiKey.length === 0 ? 'no JEV_API_KEY / OPENROUTER_API_KEY in the environment' : null;

const GCD = 'def gcd(a, b):\n    if b == 0:\n        return a\n    else:\n        return gcd(a % b, b)\n';

function gcdSite(): Site {
  const file: SourceFile = { path: 'gcd.py', src: GCD, mod: analyse(GCD) };
  const b = blockAt(file.mod, 5)!;
  return {
    file,
    line: 5,
    kind: 'replace',
    currentLine: file.mod.lines[4]!,
    indent: '        ',
    block: { name: b.name, startLine: b.startLine, endLine: b.endLine },
    scope: scopeAt(file.mod, 5),
    evidence: { notes: ['live check'] },
  };
}

describe.skipIf(reason !== null)(`synth-beam live (${reason ?? 'enabled'})`, () => {
  it('template route + short beam on gcd return a swapped-argument line among the candidates', async () => {
    const cfg: DeciderConfig = { provider: 'openrouter', baseUrl: process.env['JEV_BASE_URL'] ?? DEFAULT_JEV_BASE_URL, apiKey, model: DEFAULT_JEV_MODEL, pinned: true, pricing: JEV_PROVIDERS.openrouter.pricing, providerSource: 'default' };
    const redact = (s: string): string => s.split(apiKey).join('[KEY]');
    const decider = createJevDecider(cfg, { redact });
    const controller = new AbortController();
    let cost = 0;
    let inputTokens = 0;
    const ask: JevAsk = async (stage: StageName, state: Json, questions: Record<string, Question>): Promise<{ answers: Record<string, Answer>; rows: never[]; latencyMs: number }> => {
      const r = await decider.ask(state, questions, { signal: controller.signal, stage, step: 1 });
      cost += r.usage.costUsd;
      inputTokens += r.usage.inputTokens;
      return { answers: r.answers, rows: [], latencyMs: r.latencyMs };
    };

    const src = createTokenBeamSource(ask, { width: 2, maxTokens: 14, confidentExpandThreshold: 0.9, maxRequests: 16 });
    const res = await src.synthesizeLine(gcdSite(), {
      task: 'gcd(13, 13) recurses forever instead of returning 13',
      failures: [
        { testId: 'gcd[13,13]', call: 'gcd(13, 13)', expected: '13', actual: 'RecursionError: maximum recursion depth exceeded' },
        { testId: 'gcd[37,600]', call: 'gcd(37, 600)', expected: '1', actual: 'RecursionError: maximum recursion depth exceeded' },
      ],
      signal: controller.signal,
      enumerate: { cap: 50, testLiterals: ['13', '37', '600', '1'], taskIdentifiers: ['gcd'], corpus: new Map() },
    });

    process.stdout.write(
      redact(
        `synth-beam live: requests=${res.requests} cost=$${cost.toFixed(5)} inputTokens=${inputTokens} template=${JSON.stringify(res.byRoute.template?.lines.map((l) => l.text.trim()))} beam=${JSON.stringify(res.byRoute.beam?.lines.map((l) => l.text.trim()))} pCurrentCorrect=${res.byRoute.template?.currentLineCorrectProbability ?? 'n/a'}\n`,
      ),
    );
    expect(res.requests).toBeLessThanOrEqual(16);
    expect(cost).toBeLessThan(0.05);
    expect(res.lines.length).toBeGreaterThan(0);
    // the measured result: every route reconstructs `return gcd(b, a % b)` on gcd (probe §6 row gcd)
    expect(res.lines.map((l) => l.text.trim())).toContain('return gcd(b, a % b)');
  }, 240_000);
});
