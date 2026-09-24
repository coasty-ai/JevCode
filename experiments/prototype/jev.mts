/**
 * Jev access for the prototype: the project client (src/jev/client.ts) behind a spend cap and
 * a request meter. Every response's costUsd and latency is recorded.
 */
import { createJevDecider } from '../../src/jev/client.ts';
import type { AskResult, Json, Question } from '../../src/core/types.ts';

export interface JevMeter { requests: number; costUsd: number; latenciesMs: number[]; inputTokens: number }

export class SpendCapError extends Error {
  constructor(spent: number, cap: number) { super(`Jev spend cap reached: $${spent.toFixed(4)} >= $${cap.toFixed(2)}`); this.name = 'SpendCapError'; }
}

export interface Jev {
  ask(state: Json, questions: Record<string, Question>, stage?: 'context' | 'risk' | 'judge'): Promise<AskResult>;
  meter: JevMeter;
  capUsd: number;
}

export const JEV_MODEL = 'typesafe/jev-1.13-20260917';

export function createJev(capUsd: number): Jev {
  const key = process.env['OPENROUTER_API_KEY'] ?? '';
  if (!key) throw new Error('OPENROUTER_API_KEY missing (run with node --env-file=.env)');
  const redact = (s: string): string => s.split(key).join('[redacted]');
  const decider = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey: key, model: JEV_MODEL, pinned: true }, { redact });
  const meter: JevMeter = { requests: 0, costUsd: 0, latenciesMs: [], inputTokens: 0 };
  const signal = new AbortController().signal;
  return {
    meter, capUsd,
    async ask(state, questions, stage = 'context') {
      if (meter.costUsd >= capUsd) throw new SpendCapError(meter.costUsd, capUsd);
      const r = await decider.ask(state, questions, { signal, stage, step: meter.requests + 1 });
      meter.requests += 1;
      meter.costUsd += r.usage.costUsd;
      meter.inputTokens += r.usage.inputTokens;
      meter.latenciesMs.push(r.latencyMs);
      return r;
    },
  };
}

export function p50(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
