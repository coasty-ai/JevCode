/**
 * TUI-DESIGN-2 §2.8 (S1): TypeSafe's native decisions endpoint through the one Jev client. One paid decision (a Noul and a
 * Choice over a tiny state, ≈ $0.00002 at $0.042/M input; the wire carries no `usage.cost`, so the table prices it), the
 * free unknown-model 400 (`api_usage_error` → ConfigError exit 2, PROBE) and the `jev-latest` resolution over two paid Nouls
 * (alias on the first call, pinned to the resolution on the second). Skipped — loudly, one stdout line — unless JEVCODE_LIVE=1
 * and TYPESAFE_API_KEY is set in the environment or in `<cwd>/.env` (read with the harness's own dotenv parser, never printed):
 *   JEVCODE_LIVE=1 env -u ANTHROPIC_API_KEY npx vitest run --project live test/live/jev-typesafe.live.test.ts
 * Nothing here prints a key; every error string passes `redact`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDotenvText } from '../../src/config/env.js';
import type { DeciderConfig, Json } from '../../src/core/types.js';
import { ConfigError, JevHttpError } from '../../src/errors.js';
import { checkServedModel, createJevDecider } from '../../src/jev/client.js';
import { JEV_PROVIDERS } from '../../src/jev/providers.js';
import { choice, noul } from '../../src/jev/questions.js';
import { DEFAULT_TYPESAFE_BASE_URL, DEFAULT_TYPESAFE_MODEL, JEV_INPUT_USD_PER_TOKEN } from '../../src/jev/types.js';

/** the variable from the process environment, else from `<cwd>/.env` (the brief's `env -u ANTHROPIC_API_KEY npx vitest …` form loads no dotenv) */
function keyFrom(name: string): string {
  const fromEnv = process.env[name]?.trim() ?? '';
  if (fromEnv.length > 0) return fromEnv;
  try {
    return parseDotenvText(readFileSync(join(process.cwd(), '.env'), 'utf8')).get(name)?.trim() ?? '';
  } catch {
    return '';
  }
}

const LIVE = process.env['JEVCODE_LIVE'] === '1';
const KEY = keyFrom('TYPESAFE_API_KEY');
const reason = !LIVE ? 'JEVCODE_LIVE is not 1' : KEY.length === 0 ? 'no TYPESAFE_API_KEY in the environment or in ./.env' : null;
if (reason !== null) process.stdout.write(`[jev-typesafe live] skipped: ${reason} — run with JEVCODE_LIVE=1 and TYPESAFE_API_KEY exported or in ./.env\n`);
const redact = (s: string): string => (KEY.length >= 8 ? s.split(KEY).join('[REDACTED:key]') : s);

function cfg(model: string, pinned: boolean): DeciderConfig {
  return { provider: 'typesafe', baseUrl: process.env['JEV_TYPESAFE_BASE_URL'] ?? DEFAULT_TYPESAFE_BASE_URL, apiKey: KEY, model, pinned, pricing: JEV_PROVIDERS.typesafe.pricing, providerSource: 'env' };
}

/** A tiny intake-shaped state (§3.2): the message and what the workspace looks like. */
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

describe.skipIf(reason !== null)(`jev live: typesafe native (${reason ?? 'enabled'})`, () => {
  it('one decision: a Noul and a Choice; served jev-1.13.0, table-priced from input tokens, request id captured, latency recorded', async () => {
    const decider = createJevDecider(cfg(DEFAULT_TYPESAFE_MODEL, true), { redact });
    expect(decider.provider).toBe('typesafe');
    const res = await decider.ask(state, questions, { signal: new AbortController().signal, stage: 'intent', step: 0 });

    // §2.5: the pinned TypeSafe id is served verbatim
    expect(res.model).toBe('jev-1.13.0');
    expect(checkServedModel({ model: DEFAULT_TYPESAFE_MODEL, pinned: true, provider: 'typesafe' }, res.model, null)).toEqual({ ok: true, resolved: 'jev-1.13.0' });

    // answers: validated shapes; a plainly worded task reads as one
    expect(Object.keys(res.answers).sort()).toEqual(['intake', 'is_task']);
    const n = res.answers['is_task'];
    const c = res.answers['intake'];
    expect(n?.type).toBe('noul');
    expect(c?.type).toBe('choice');
    if (n?.type !== 'noul' || c?.type !== 'choice') return;
    expect(n.noul).toBeGreaterThanOrEqual(0.5);
    expect(Object.keys(c.probabilities).sort()).toEqual(['coding_task', 'greeting_or_smalltalk', 'none_of_these', 'question_about_the_code']);
    expect(c.choice).toBe('coding_task');

    // §2.4: no usage.cost on the wire → costBasis table, cost = input × 4.2e-8 exactly (output free)
    expect(res.usage.calls).toBe(1);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThanOrEqual(0);
    expect(res.costBasis).toBe('table');
    expect(Math.abs(res.usage.costUsd - res.usage.inputTokens * JEV_INPUT_USD_PER_TOKEN)).toBeLessThanOrEqual(1e-9);
    expect(res.usage.costUsd).toBeLessThan(0.001);
    expect(res.attempts).toBe(1);
    expect(res.latencyMs).toBeGreaterThan(0);
    // x-typesafe-request-id rides every response (PROBE) and becomes the result id when the body has none
    expect(res.id).toMatch(/.+/);
    expect(res.id).not.toContain(KEY);

    process.stdout.write(
      `[jev-typesafe live] model=${res.model} latency=${Math.round(res.latencyMs)}ms in=${res.usage.inputTokens} out=${res.usage.outputTokens} cost=$${res.usage.costUsd.toFixed(8)} (${res.costBasis}) id=${res.id} ` +
        `is_task=${n.noul} intake=${c.choice}(${c.probabilities[c.choice]}) confidence=${c.confidence}\n`,
    );
  });

  it('the dated OpenRouter id is 400 api_usage_error on the native API → ConfigError exit 2 on the first call, nothing billed (a 400 carries no usage)', async () => {
    const decider = createJevDecider(cfg('jev-1.13-20260917', false), { redact });
    const t0 = performance.now();
    let err: unknown;
    try {
      await decider.ask(state, { is_task: questions.is_task }, { signal: new AbortController().signal, stage: 'intent', step: 0 });
    } catch (e) {
      err = e;
    }
    const ms = Math.round(performance.now() - t0);
    expect(err).toBeInstanceOf(ConfigError);
    const ce = err as ConfigError;
    expect(ce.exitCode).toBe(2);
    expect(ce.setting).toBe('decider.model');
    expect(ce.message).toContain('--jev-model: "jev-1.13-20260917" is not served by api.typesafe.ai');
    expect(ce.message).toMatch(/unknown model/i);
    expect(ce.message).toContain('TypeSafe accepts jev-1.13.0 or jev-latest');
    expect(ce.message).not.toContain(KEY);
    // the 400's request id (x-typesafe-request-id, PROBE: on every response) rides the ConfigError's cause for a support report
    expect(ce.cause).toBeInstanceOf(JevHttpError);
    const cause = ce.cause as JevHttpError;
    expect(cause.status).toBe(400);
    expect(cause.requestId).toMatch(/.+/);
    expect(cause.requestId).not.toContain(KEY);
    process.stdout.write(`[jev-typesafe live] unknown-model 400 → ConfigError in ${ms}ms (request-id ${cause.requestId}): ${ce.message}\n`);
  });

  it('jev-latest resolves to a jev-1.13.x id through the alias path, then pins to that resolution on the second call (two Nouls, ≈ $0.00003)', async () => {
    const decider = createJevDecider(cfg('jev-latest', false), { redact });
    const res = await decider.ask({ message: 'hi' }, { is_task: questions.is_task }, { signal: new AbortController().signal, stage: 'intent', step: 0 });
    expect(res.model).toMatch(/^jev-1\.13\./);
    const check = checkServedModel({ model: 'jev-latest', pinned: false, provider: 'typesafe' }, res.model, null);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.resolved).toBe(res.model);
    expect(res.costBasis).toBe('table');
    expect(res.id).toMatch(/.+/);
    // the alias-then-pinned path over two real calls: the second served id must equal the first resolution
    const again = await decider.ask({ message: 'thanks' }, { is_task: questions.is_task }, { signal: new AbortController().signal, stage: 'intent', step: 0 });
    const second = checkServedModel({ model: 'jev-latest', pinned: false, provider: 'typesafe' }, again.model, res.model);
    expect(second).toEqual({ ok: true, resolved: res.model });
    const n = res.answers['is_task'];
    process.stdout.write(
      `[jev-typesafe live] jev-latest → ${res.model} latency=${Math.round(res.latencyMs)}ms in=${res.usage.inputTokens} cost=$${res.usage.costUsd.toFixed(8)} is_task(hi)=${n?.type === 'noul' ? n.noul : '?'}; second call ${again.model} latency=${Math.round(again.latencyMs)}ms cost=$${again.usage.costUsd.toFixed(8)}\n`,
    );
  });
});
