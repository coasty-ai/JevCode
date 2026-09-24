/**
 * TUI-DESIGN-2 §2.8 (S1): the OpenRouter decisions router, today's path, through the one Jev client. One paid decision (a
 * Noul and a Choice over a tiny state, < $0.0001; OpenRouter's body carries `usage.cost`, so the basis is the provider's).
 * Skipped — loudly, one stdout line — unless JEVCODE_LIVE=1 and OPENROUTER_API_KEY (or JEV_API_KEY) is set in the environment
 * or in `<cwd>/.env` (read with the harness's own dotenv parser, never printed):
 *   JEVCODE_LIVE=1 env -u ANTHROPIC_API_KEY npx vitest run --project live test/live/jev-openrouter.live.test.ts
 * Nothing here prints a key; every error string passes `redact`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDotenvText } from '../../src/config/env.js';
import type { DeciderConfig, Json } from '../../src/core/types.js';
import { checkServedModel, createJevDecider } from '../../src/jev/client.js';
import { JEV_PROVIDERS } from '../../src/jev/providers.js';
import { choice, noul } from '../../src/jev/questions.js';
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL, JEV_INPUT_USD_PER_TOKEN } from '../../src/jev/types.js';

/** the first set variable from the process environment, else from `<cwd>/.env` (the brief's `env -u ANTHROPIC_API_KEY npx vitest …` form loads no dotenv) */
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
const KEY = keyFrom('OPENROUTER_API_KEY', 'JEV_API_KEY');
const reason = !LIVE ? 'JEVCODE_LIVE is not 1' : KEY.length === 0 ? 'no OPENROUTER_API_KEY / JEV_API_KEY in the environment or in ./.env' : null;
if (reason !== null) process.stdout.write(`[jev-openrouter live] skipped: ${reason} — run with JEVCODE_LIVE=1 and the key exported or in ./.env\n`);
const redact = (s: string): string => (KEY.length >= 8 ? s.split(KEY).join('[REDACTED:key]') : s);

const cfg: DeciderConfig = { provider: 'openrouter', baseUrl: process.env['JEV_BASE_URL'] ?? DEFAULT_JEV_BASE_URL, apiKey: KEY, model: DEFAULT_JEV_MODEL, pinned: true, pricing: JEV_PROVIDERS.openrouter.pricing, providerSource: 'env' };

/** The same tiny intake-shaped state and questions as the TypeSafe suite, so the two providers are compared like for like. */
const state: Json = { message: 'fix the failing test in utils/dates.py', workspace: { git: true, hasTests: true, files: 42 } };
const questions = {
  is_task: noul('Is `message` an instruction to change, fix, run or check something in `workspace`?', {
    true: { definition: 'the message asks for work on the code: change, create, fix, refactor, test, run, install or check something', examples: ['fix the failing test', 'add a --dry-run flag'] },
    false: { definition: 'the message asks for no work: a greeting, thanks, a question about the tool, or small talk', examples: ['hi', 'what can you do?'] },
  }),
  intake: choice('What is `message`?', {
    coding_task: 'an instruction to change, create, fix, refactor, test, run, install or check something in `workspace`',
    question_about_the_code: 'a question about the code that wants an explanation, not a change',
    greeting_or_smalltalk: 'a greeting, thanks, goodbye or small talk that asks for no information and no work',
  }),
};

describe.skipIf(reason !== null)(`jev live: openrouter router (${reason ?? 'enabled'})`, () => {
  it('one decision: a Noul and a Choice; served typesafe/jev-1.13-20260917, provider-priced usage.cost, gen-dec id, latency recorded', async () => {
    const decider = createJevDecider(cfg, { redact });
    expect(decider.provider).toBe('openrouter');
    const res = await decider.ask(state, questions, { signal: new AbortController().signal, stage: 'intent', step: 0 });

    // §5.4 rule 7 / §2.5: the dated id is served verbatim
    expect(res.model).toBe(DEFAULT_JEV_MODEL);
    expect(checkServedModel({ model: cfg.model, pinned: true, provider: 'openrouter' }, res.model, null)).toEqual({ ok: true, resolved: DEFAULT_JEV_MODEL });

    expect(Object.keys(res.answers).sort()).toEqual(['intake', 'is_task']);
    const n = res.answers['is_task'];
    const c = res.answers['intake'];
    expect(n?.type).toBe('noul');
    expect(c?.type).toBe('choice');
    if (n?.type !== 'noul' || c?.type !== 'choice') return;
    expect(n.noul).toBeGreaterThanOrEqual(0.5);
    expect(Object.keys(c.probabilities).sort()).toEqual(['coding_task', 'greeting_or_smalltalk', 'none_of_these', 'question_about_the_code']);
    expect(c.choice).toBe('coding_task');

    // §2.4: OpenRouter sends usage.cost = input × 4.2e-8 exactly → costBasis provider, and the figure agrees with the table
    expect(res.usage.calls).toBe(1);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.costBasis).toBe('provider');
    expect(Math.abs(res.usage.costUsd - res.usage.inputTokens * JEV_INPUT_USD_PER_TOKEN)).toBeLessThanOrEqual(1e-9);
    expect(res.usage.costUsd).toBeLessThan(0.001);
    expect(res.attempts).toBe(1);
    expect(res.latencyMs).toBeGreaterThan(0);
    expect(res.id).toMatch(/^gen-dec-/);

    process.stdout.write(
      `[jev-openrouter live] model=${res.model} latency=${Math.round(res.latencyMs)}ms in=${res.usage.inputTokens} out=${res.usage.outputTokens} cost=$${res.usage.costUsd.toFixed(8)} (${res.costBasis}) id=${res.id} ` +
        `is_task=${n.noul} intake=${c.choice}(${c.probabilities[c.choice]}) confidence=${c.confidence}\n`,
    );
  });
});
