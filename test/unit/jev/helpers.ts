/** Shared offline helpers for the jev unit tests: fixtures, question sets, fake fetch. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Json, Question } from '../../../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface LiveProbeFixture {
  questions: Record<string, Question>;
  response: Json;
  errors: { zod400: Json; typesafe400: Json; cloudflare524: string };
}

export function loadLiveProbe(): LiveProbeFixture {
  return JSON.parse(readFileSync(join(here, '../../fixtures/jev/live-probe.json'), 'utf8')) as LiveProbeFixture;
}

export const FAKE_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
export const redact = (s: string): string => s.split(FAKE_KEY).join('[KEY]');

/** A response body for `questions` where every answer is valid. */
export function validBody(questions: Record<string, Question>, overrides: Partial<{ model: string; id: string; usage: Json }> = {}): Json {
  const answers: Record<string, Json> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.9 };
    else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const probabilities: Record<string, number> = {};
      keys.forEach((k, i) => {
        probabilities[k] = i === 0 ? 1 : 0;
      });
      answers[id] = { type: 'choice', choice: keys[0]!, probabilities, confidence: 1 };
    } else {
      const n = q.criteria.length;
      const probabilities: Record<string, number> = {};
      const legend: Record<string, Json> = {};
      for (let k = 0; k < n; k++) {
        probabilities[String(k)] = k === 0 ? 1 : 0;
        legend[String(k)] = q.criteria[k] ?? null;
      }
      answers[id] = { type: 'score', score: 0, legend, probabilities, confidence: 1 };
    }
  }
  const body: Record<string, Json> = {
    model: overrides.model ?? 'typesafe/jev-1.13-20260917',
    answers,
    usage: overrides.usage ?? { input_tokens: 100, output_tokens: 10, cost: 100 * 4.2e-8 },
  };
  if (overrides.id !== undefined) body['id'] = overrides.id;
  return body;
}

export interface FakeCall {
  url: string;
  init: RequestInit;
  bodyJson: Json;
  signal: AbortSignal | null | undefined;
}

export type Scripted =
  | { status: number; body: Json | string; headers?: Record<string, string> }
  | { throw: unknown }
  | { timeout: true }
  | { waitForAbort: true };

/**
 * A `typeof fetch` that plays a script. `timeout` rejects the way undici does when the
 * per-attempt AbortSignal.timeout fires; `waitForAbort` rejects with the signal's reason
 * once the caller aborts (engine abort path).
 */
export function fakeFetch(script: Scripted[]): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, init: init ?? {}, bodyJson: bodyText ? (JSON.parse(bodyText) as Json) : null, signal: init?.signal });
    const step = script[calls.length - 1];
    if (step === undefined) throw new Error(`fakeFetch: no script for call ${calls.length}`);
    if ('throw' in step) throw step.throw;
    if ('timeout' in step) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    if ('waitForAbort' in step) {
      const signal = init?.signal;
      if (!signal) throw new Error('fakeFetch: waitForAbort needs a signal');
      return new Promise<Response>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    const text = typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
    return new Response(text, { status: step.status, headers: step.headers ?? { 'content-type': 'application/json' } });
  };
  return { fetch: impl as typeof fetch, calls };
}

/** Records sleeps instead of waiting; still rejects with the reason when the signal is aborted. */
export function recordingSleep(): { sleep: (ms: number, signal: AbortSignal) => Promise<void>; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      if (signal.aborted) return Promise.reject(signal.reason);
      return Promise.resolve();
    },
  };
}

export const sampleQuestions: Record<string, Question> = {
  in_scope: {
    type: 'noul',
    instructions: 'Does `proposal` stay within the scope of `task`?',
    criteria: { true: { definition: 'edits only named files', examples: ['a', 'b'] }, false: { definition: 'touches unrelated files', examples: ['c', 'd'] } },
  },
  next_action: {
    type: 'choice',
    instructions: 'What next?',
    criteria: { apply_patch: 'apply', read_more_code: 'read', none_of_these: null },
  },
  destructive: {
    type: 'score',
    instructions: 'How much is lost?',
    criteria: ['nothing', 'recoverable', 'untracked work', 'much of the workspace', 'outside the workspace'],
  },
};
