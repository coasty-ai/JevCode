/**
 * TUI-DESIGN-3 §1.5 (S3): the wizard's `y` — one real Jev decision, one 1-token code-model completion, the key info — against the
 * live providers, once, paid (≈ $0.00002 + $0.000002 per provider). Skipped — loudly, one stdout line — unless JEVCODE_LIVE=1 and the
 * key is set in the environment or in `<cwd>/.env` (read with the harness's own dotenv parser, never printed):
 *   JEVCODE_LIVE=1 npx vitest run --project live test/live/verify.live.test.ts
 * Nothing here prints a key; every error string passes `redact`. The GLM 1-token latency is recorded (R3 F15: unmeasured before).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDotenvText } from '../../src/config/env.js';
import { DEFAULT_MODEL } from '../../src/config/defaults.js';
import { verifyKeys } from '../../src/cli/login.js';
import { JEV_PROVIDERS } from '../../src/jev/providers.js';
import { JEV_INPUT_USD_PER_TOKEN } from '../../src/jev/types.js';

function keyFrom(...names: string[]): string {
  for (const name of names) {
    const v = process.env[name]?.trim() ?? '';
    if (v.length > 0) return v;
  }
  try {
    const vars = parseDotenvText(readFileSync(join(process.cwd(), '.env'), 'utf8'));
    for (const name of names) {
      const v = vars.get(name)?.trim() ?? '';
      if (v.length > 0) return v;
    }
  } catch {
    /* no .env */
  }
  return '';
}

const LIVE = process.env['JEVCODE_LIVE'] === '1';
const OR_KEY = keyFrom('OPENROUTER_API_KEY', 'JEV_API_KEY');
const TS_KEY = keyFrom('TYPESAFE_API_KEY');
const redact = (s: string): string => [OR_KEY, TS_KEY].filter((k) => k.length >= 8).reduce((acc, k) => acc.split(k).join('[REDACTED:key]'), s);
const orReason = !LIVE ? 'JEVCODE_LIVE is not 1' : OR_KEY.length === 0 ? 'no OPENROUTER_API_KEY / JEV_API_KEY in the environment or in ./.env' : null;
const tsReason = !LIVE ? 'JEVCODE_LIVE is not 1' : TS_KEY.length === 0 ? 'no TYPESAFE_API_KEY in the environment or in ./.env' : null;
if (orReason !== null) process.stdout.write(`[verify live openrouter] skipped: ${orReason}\n`);
if (tsReason !== null) process.stdout.write(`[verify live typesafe] skipped: ${tsReason}\n`);

describe.skipIf(orReason !== null)(`verify live: one OpenRouter key (${orReason ?? 'enabled'})`, () => {
  it('one decision (~320 × 4.2e-8), one 1-token GLM completion (usage.cost < 1e-5, latency recorded), the key info; every item ok, no key in any text', async () => {
    const t0 = Date.now();
    const res = await verifyKeys({ provider: 'openrouter', jevProvider: 'openrouter', generatorKey: OR_KEY, jevKey: OR_KEY, mode: 'jev-on', generatorModel: DEFAULT_MODEL, jevBaseUrl: JEV_PROVIDERS.openrouter.baseUrl, jevModel: JEV_PROVIDERS.openrouter.defaultModel }, fetch, 20_000);
    const ms = Date.now() - t0;
    for (const r of res) {
      expect(redact(r.text)).toBe(r.text);
      expect(r.ok, redact(r.text)).toBe(true);
    }
    expect(res.map((r) => r.which)).toEqual(['jev', 'generator', 'jev']);
    const jev = res[0]!;
    expect(jev.usage?.inputTokens ?? 0).toBeGreaterThan(200);
    expect(jev.usage?.costUsd ?? 0).toBeCloseTo((jev.usage?.inputTokens ?? 0) * JEV_INPUT_USD_PER_TOKEN, 6);
    const gen = res[1]!;
    expect(gen.usage?.costUsd ?? 1).toBeLessThan(1e-5);
    expect(gen.text).toContain('ok (1 token');
    process.stdout.write(`[verify live openrouter] ${res.map((r) => redact(r.text)).join(' · ')} · wall ${ms} ms\n`);
  });
});

describe.skipIf(tsReason !== null)(`verify live: TypeSafe (${tsReason ?? 'enabled'})`, () => {
  it('one decision at api.typesafe.ai (~320 input tokens), ok, no key in the text', async () => {
    const res = await verifyKeys({ provider: 'openrouter', jevProvider: 'typesafe', generatorKey: null, jevKey: TS_KEY, mode: 'jev-only', jevBaseUrl: JEV_PROVIDERS.typesafe.baseUrl, jevModel: JEV_PROVIDERS.typesafe.defaultModel }, fetch, 20_000);
    expect(res).toHaveLength(1);
    expect(res[0]!.ok, redact(res[0]!.text)).toBe(true);
    expect(redact(res[0]!.text)).toBe(res[0]!.text);
    expect(res[0]!.usage?.inputTokens ?? 0).toBeGreaterThan(200);
    process.stdout.write(`[verify live typesafe] ${redact(res[0]!.text)}\n`);
  });
});
