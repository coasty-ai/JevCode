/** Live Jev latency for representative stage requests (report only). */
import type { ParsedFlags } from '../cli/args.js';
import type { Question } from '../core/types.js';
import { percentile } from '../core/time.js';
import { noul, choice, score, pairedNouls } from '../jev/questions.js';

export interface JevLatencyResult {
  raw: number[];
  p50: number | null;
  p95: number | null;
  requests: number;
  costUsd: number;
}

export async function measureJevLatency(flags: ParsedFlags): Promise<JevLatencyResult> {
  const { resolveConfig } = await import('../config/resolve.js');
  const { createJevDecider } = await import('../jev/client.js');
  const config = await resolveConfig(flags, process.env, process.cwd());
  const decider = createJevDecider(config.decider(), { redact: config.redact });
  const crit = { true: { definition: 'yes', examples: ['a', 'b'] }, false: { definition: 'no', examples: ['c', 'd'] } };
  const intent: Record<string, Question> = {
    intent: choice('What should the next step be?', { investigate: 'read code', edit: 'change code', verify: 'run tests' }),
    ...pairedNouls({ investigate: 'read code', edit: 'change code', verify: 'run tests' }, (o, d) => ({ instructions: `Is ${o} (${d}) right now?`, criteria: crit })),
    plan_still_valid: noul('Is `plan` still valid?', crit),
  };
  const risk: Record<string, Question> = {
    destructive: score('How much is lost?', ['nothing', 'recoverable', 'untracked work', 'much of the workspace', 'outside the workspace']),
    out_of_scope: score('How far from `task`?', ['direct', 'needed setup', 'tangential', 'unrelated', 'contradicts']),
    plan_mismatch: score('How far from `plan`?', ['matches', 'different order', 'skips verification', 'ignores problems', 'contradicts']),
    irreversible: score('How hard to undo?', ['none', 'regenerate', 'untracked loss', 'network writes', 'cannot']),
    matches_intent: noul('Does `proposal.action` carry out `intent`?', crit),
  };
  const state = { task: 'fix the failing test', plan: { remaining: ['fix mean'] }, recent: [], proposal: { action: { kind: 'run', command: 'pytest -q' } } };
  const raw: number[] = [];
  let cost = 0;
  const ctl = new AbortController();
  for (let i = 0; i < 10; i++) {
    for (const [stage, qs] of [['intent', intent], ['risk', risk]] as const) {
      const r = await decider.ask(state, qs, { signal: ctl.signal, stage, step: i + 1 });
      raw.push(r.latencyMs);
      cost += r.usage.costUsd;
    }
  }
  return { raw, p50: percentile(raw, 50), p95: percentile(raw, 95), requests: raw.length, costUsd: cost };
}
