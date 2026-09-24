/**
 * TUI-DESIGN-2 §8.3 / §3.12 (S3): the real intake request (groups A + B + C, one `decider.ask`) over 14 messages per Jev
 * provider — expected kinds for the first twelve, `ambiguous`-or-a-question tolerated for the last two; asserts ≥ 11 of 12
 * match and that no unambiguous non-task message resolves `coding_task` (the one property a paid run depends on); prints
 * the confusion table, p50 / p95 latency and the cost per provider, plus one lookup round trip (§3.12 "lookup ≤ 600 ms p95").
 * Paid (≈ $0.002 per provider); skipped unless JEVCODE_LIVE=1 and the provider's key is present. Run once per provider:
 *   JEVCODE_LIVE=1 env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/vitest run --project live test/live/intake.live.test.ts
 */
import { describe, expect, it } from 'vitest';
import type { DeciderConfig, IntakeKind, JevProvider } from '../../src/core/types.js';
import { createJevDecider } from '../../src/jev/client.js';
import { JEV_PROVIDERS } from '../../src/jev/providers.js';
import { INTAKE_TOKEN_BUDGET, buildIntakeState, runIntake } from '../../src/chat/intake.js';
import { harnessFacts, type FactsInput } from '../../src/chat/facts.js';
import { lookupCode } from '../../src/jev-modes/chat/lookup.js';
import { pickReply } from '../../src/chat/replies.js';
import { notRepoState } from '../../src/workspace/gitstate.js';

const live = process.env['JEVCODE_LIVE'] === '1';
const env = process.env;

interface Case {
  provider: JevProvider;
  key: string;
}
const CASES: Case[] = [
  { provider: 'typesafe', key: env['TYPESAFE_API_KEY'] ?? '' },
  { provider: 'openrouter', key: env['OPENROUTER_API_KEY'] ?? env['JEV_API_KEY'] ?? '' },
];

/** the 14 messages of §8.3 and the kinds the first twelve must resolve to */
const MESSAGES: readonly { text: string; expect: IntakeKind | 'ambiguous-or-question' }[] = [
  { text: 'hi', expect: 'greeting_or_smalltalk' },
  { text: 'thanks, that worked', expect: 'greeting_or_smalltalk' },
  { text: 'you there?', expect: 'greeting_or_smalltalk' },
  { text: 'what can you do?', expect: 'question_about_this_tool' },
  { text: 'which mode is this?', expect: 'question_about_this_tool' },
  { text: 'how much has this cost?', expect: 'question_about_this_tool' },
  { text: 'where is the date parsing?', expect: 'question_about_the_code' },
  { text: 'why does test_parse_date fail?', expect: 'question_about_the_code' },
  { text: 'fix the failing test in utils/dates.py', expect: 'coding_task' },
  { text: 'add a --dry-run flag to the cli', expect: 'coding_task' },
  { text: 'run the tests', expect: 'coding_task' },
  { text: 'also update the CHANGELOG', expect: 'coding_task' },
  { text: 'the date parsing', expect: 'ambiguous-or-question' },
  { text: 'tests?', expect: 'ambiguous-or-question' },
];

function factsFixture(provider: JevProvider): FactsInput {
  const spec = JEV_PROVIDERS[provider];
  return {
    mode: 'jev-only',
    nextMode: 'jev-only',
    workspace: { root: '/Users/me/demo-py', git: notRepoState('not-a-repo', { probedAt: new Date().toISOString(), probeMs: 1 }), hasTests: true, testCommand: 'python -m pytest -q' },
    lastRun: null,
    lastTests: null,
    keys: { jev: { provider, source: `env ${spec.keyEnv}` }, generator: null },
    spend: { sessionUsd: 0, sessionCapUsd: 1.25, runs: 0, chats: 0 },
    sandbox: 'seatbelt',
    runsDir: '/Users/me/.jevcode/runs',
    provider: { name: provider, host: spec.displayHost, model: spec.defaultModel, p50Ms: null },
  };
}

function percentile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? 0;
}

for (const c of CASES) {
  const reason = !live ? 'JEVCODE_LIVE is not 1' : c.key.length === 0 ? `no ${JEV_PROVIDERS[c.provider].keyEnv} in the environment` : null;
  describe.skipIf(reason !== null)(`intake live — ${c.provider} (${reason ?? 'enabled'})`, () => {
    const spec = JEV_PROVIDERS[c.provider];
    const cfg: DeciderConfig = { provider: c.provider, baseUrl: spec.baseUrl, apiKey: c.key, model: spec.defaultModel, pinned: true, pricing: spec.pricing, providerSource: 'env' };
    const redact = (s: string): string => (c.key.length > 0 ? s.split(c.key).join('[KEY]') : s);
    const decider = createJevDecider(cfg, { redact });

    it('14 messages: ≥ 11 of 12 expected kinds, no unambiguous non-task message runs; confusion table, p50/p95, cost', async () => {
      const facts = harnessFacts(factsFixture(c.provider));
      const rows: { text: string; expect: string; got: IntakeKind; p: number; verdict: string; ms: number }[] = [];
      let cost = 0;
      let tokens = 0;
      for (const m of MESSAGES) {
        const state = buildIntakeState(
          {
            message: m.text,
            conversation: [],
            workspace: { name: 'demo-py', git: true, hasTests: true, testRunner: 'pytest', files: 'few' },
            session: { mode: 'jev-only', runs: 0, lastRun: null, pendingMode: null },
            mentions: [],
          },
          redact,
        );
        const r = await runIntake({ decider, state, facts, signal: new AbortController().signal, redact });
        rows.push({ text: m.text, expect: m.expect, got: r.intake.kind, p: r.intake.probability, verdict: r.intake.verdict, ms: r.latencyMs });
        cost += r.usage.costUsd;
        tokens += r.usage.inputTokens;
        expect(r.provider).toBe(c.provider);
        expect(r.rows.length).toBe(1 + 5 + 1 + 14);
      }
      const graded = rows.slice(0, 12);
      const matched = graded.filter((r) => r.got === r.expect).length;
      const nonTaskRan = graded.filter((r) => r.expect !== 'coding_task' && r.got === 'coding_task');
      const latencies = rows.map((r) => r.ms);
      const table = rows.map((r) => `  ${r.text.padEnd(42)} expected ${r.expect.padEnd(27)} got ${r.got.padEnd(26)} p=${r.p.toFixed(2)} ${r.verdict.padEnd(10)} ${Math.round(r.ms)} ms`).join('\n');
      process.stdout.write(
        `[intake live] ${c.provider} · model ${cfg.model} · ${matched}/12 expected kinds · non-task→run ${nonTaskRan.length} · p50 ${Math.round(percentile(latencies, 0.5))} ms · p95 ${Math.round(percentile(latencies, 0.95))} ms · ${Math.round(tokens / rows.length)} input tokens/msg · cost $${cost.toFixed(5)}\n${table}\n`,
      );
      expect(matched).toBeGreaterThanOrEqual(11);
      expect(nonTaskRan, 'an unambiguous non-task message resolved coding_task').toEqual([]);
      for (const r of rows.slice(12)) expect(['ambiguous', 'question_about_the_code', 'question_about_this_tool']).toContain(r.got);
      // §3.12 (finding 10): the wire figure against the calibrated budget the offline estimator is gated on (the design's ≈ 1,650 was an estimate; 4,249 measured before the Choice examples were trimmed)
      expect(tokens / rows.length, 'input tokens per message').toBeLessThanOrEqual(INTAKE_TOKEN_BUDGET);
    });

    it('a second greeting with a non-empty `conversation` picks `hello_again` from the catalogue (§3.4)', async () => {
      const facts = harnessFacts(factsFixture(c.provider));
      const at = new Date().toISOString();
      const state = buildIntakeState(
        {
          message: 'hi again',
          conversation: [
            { role: 'you', text: 'hi', at, kind: 'greeting_or_smalltalk' },
            { role: 'jevcode', text: "Hi. I'm ready when you are — describe a change you want in demo-py, or ask what I can do.", at },
          ],
          workspace: { name: 'demo-py', git: true, hasTests: true, testRunner: 'pytest', files: 'few' },
          session: { mode: 'jev-only', runs: 0, lastRun: null, pendingMode: null },
          mentions: [],
        },
        redact,
      );
      const r = await runIntake({ decider, state, facts, signal: new AbortController().signal, redact });
      const reply = pickReply(r.answers);
      process.stdout.write(`[intake live] ${c.provider} · "hi again" → ${r.intake.kind} p=${r.intake.probability.toFixed(2)} · reply ${reply.key} p=${reply.probability.toFixed(2)} · ${Math.round(r.latencyMs)} ms\n`);
      expect(r.intake.kind).toBe('greeting_or_smalltalk');
      expect(reply.key).toBe('hello_again');
    });

    it('one lookup round trip over 12 candidate paths (§3.12: ≤ 600 ms p95 native)', async () => {
      const candidates = ['utils/dates.py', 'utils/__init__.py', 'tests/test_dates.py', 'tests/conftest.py', 'cli/main.py', 'cli/args.py', 'README.md', 'pyproject.toml', 'docs/usage.md', 'utils/strings.py', 'tests/test_strings.py', 'CHANGELOG.md'].map((path) => ({ path, bytes: 1200 }));
      const r = await lookupCode({
        message: 'where is the date parsing?',
        mentions: [],
        candidates,
        read: async () => null,
        ask: (state, questions) => decider.ask(state, questions, { signal: new AbortController().signal, stage: 'context', step: 0 }),
        provider: c.provider,
        redact,
        signal: new AbortController().signal,
      });
      process.stdout.write(`[lookup live] ${c.provider} · considered ${r.considered} · hits ${r.hits.map((h) => `${h.path} p=${h.p.toFixed(2)}`).join(', ') || 'none'} · ${Math.round(r.latencyMs)} ms · cost $${r.usage.costUsd.toFixed(6)}\n`);
      expect(r.considered).toBeGreaterThan(0);
      expect(r.hits.length).toBeLessThanOrEqual(3);
      expect(r.latencyMs).toBeGreaterThan(0);
      expect(r.requestHash.length).toBeGreaterThan(0);
      // §3.12: the lookup gate is stated for the native endpoint (110–250 ms p50 → ≤ 600 ms p95); OpenRouter is printed, not gated
      if (c.provider === 'typesafe') expect(r.latencyMs, 'lookup round trip (native)').toBeLessThanOrEqual(600);
    });
  });
}
