/**
 * The `jev-off-tuned` arm's provider (docs/LLM-JEV-DESIGN.md §10.1): the generator-only loop untouched
 * (`src/loop/generator-only.ts` must not move, §9.1), with the §4 generator hygiene applied at the provider boundary,
 * where the action grammar allows it:
 *
 *   - `max_tokens` 1,500 and `reasoning: {effort: 'low'}` on every call (§4.12 / §10.2 finding (a): `{enabled: false}`
 *     is a 400 on the GLM endpoint), whatever the request asked for;
 *   - a per-call deadline (20 s) that DROPS the call, never retries it: the stream is aborted, the sample is metered from
 *     an estimate (§4.8: prompt chars / 4 in, streamed chars / 4 out, at the served rate, `estimated: true`) and returned
 *     as a `GenerateResult` with `stopReason: 'timeout'` and no tool call — the propose stage reads it as malformed, so
 *     the row lands in generator.jsonl and the step proceeds under the loop's own rules. The CALLER's abort is not a
 *     deadline: it is rethrown untouched, exactly as the wrapped provider would;
 *   - `finish_reason: length` → the same request once more at double `max_tokens`; both calls' usage is summed into the
 *     one result the engine meters (§2 principle 8: every accounting is complete), the latency is the wall of both;
 *   - the plan section capped at 200 chars through one added system sentence (the §7.2 "plan re-emission" lever).
 *
 * The wrapper keeps a ledger (calls, timeouts, doublings, length stops) the runner copies onto the record.
 */
import type { CancelledGeneration, GenerateOptions, GenerateReasoning, GenerateRequest, GenerateResult, Provider, TokenUsage } from '../core/types.js';
import { monotonicNow } from '../core/time.js';
import { isLengthStop } from '../synth/llm/schema.js';
import type { LengthHandling, ServedRate } from './types.js';

export const PLAN_CAP_CHARS = 200;
export const CHARS_PER_TOKEN = 4;

export interface TunedProviderParams {
  maxTokens: number;
  reasoning: GenerateReasoning;
  deadlineMs: number;
  lengthHandling: LengthHandling;
  servedRate: ServedRate;
  /** 0 disables the sentence */
  planCapChars: number;
}

export interface TunedLedger {
  /** requests the wrapper issued to the wrapped provider (a doubled call counts as its own) */
  calls: number;
  /** calls the deadline dropped */
  timeouts: number;
  /** calls re-issued at double max_tokens */
  doubled: number;
  /** length stops seen (the doubled call's own length stop included) */
  lengthStops: number;
}

export interface TunedProvider extends Provider {
  ledger(): TunedLedger;
}

export class TunedDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(`tuned provider: call dropped at the ${deadlineMs} ms deadline`);
    this.name = 'TunedDeadlineError';
  }
}

/** The one sentence the arm adds to the system prompt (§10.1: "plan section capped at 200 chars"). */
export function planCapSentence(chars: number): string {
  return `Keep the plan short: the whole \`plan\` (done, remaining, unverified, openProblems together) must stay under ${chars} characters; list only what changed since the last step and never repeat finished items verbatim.`;
}

export function withPlanCap(system: string, chars: number): string {
  if (chars <= 0) return system;
  const sentence = planCapSentence(chars);
  return system.includes(sentence) ? system : `${system}\n\n${sentence}`;
}

/** §4.8 estimate of a dropped call: prompt chars / 4 in, streamed chars / 4 out (or the usage frame when it had arrived), at the served rate. */
export function estimateDroppedUsage(req: GenerateRequest, partial: CancelledGeneration | null, rate: ServedRate): TokenUsage {
  if (partial?.usage !== undefined) return { ...partial.usage, calls: 1, estimated: true };
  const promptChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0) + (req.tools ?? []).reduce((n, t) => n + JSON.stringify(t.inputSchema).length + t.description.length, 0);
  const streamedChars = partial === null ? 0 : partial.toolChars + partial.reasoningChars + partial.text.length;
  const inputTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const outputTokens = Math.ceil(streamedChars / CHARS_PER_TOKEN);
  const costUsd = (inputTokens * rate.inputPerM + outputTokens * rate.outputPerM) / 1_000_000;
  return { inputTokens, outputTokens, costUsd, calls: 1, estimated: true };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const out: TokenUsage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, costUsd: a.costUsd + b.costUsd, calls: a.calls + b.calls };
  const reasoning = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  if (a.reasoningTokens !== undefined || b.reasoningTokens !== undefined) out.reasoningTokens = reasoning;
  if (a.estimated === true || b.estimated === true) out.estimated = true;
  return out;
}

type CallOutcome = { kind: 'result'; res: GenerateResult } | { kind: 'timeout'; partial: CancelledGeneration | null };

export function createTunedProvider(inner: Provider, params: TunedProviderParams, deps: { now?: () => number } = {}): TunedProvider {
  const now = deps.now ?? monotonicNow;
  const ledger: TunedLedger = { calls: 0, timeouts: 0, doubled: 0, lengthStops: 0 };

  async function callWithDeadline(req: GenerateRequest, opts: GenerateOptions): Promise<CallOutcome> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(opts.signal.reason);
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    let partial: CancelledGeneration | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new TunedDeadlineError(params.deadlineMs));
    }, params.deadlineMs);
    try {
      ledger.calls += 1;
      const res = await inner.generate(req, {
        ...opts,
        signal: controller.signal,
        onCancelled: (p) => {
          partial = p;
          opts.onCancelled?.(p);
        },
      });
      return { kind: 'result', res };
    } catch (e) {
      // the caller's abort wins over the deadline: it is their reason that propagates
      if (timedOut && !opts.signal.aborted) return { kind: 'timeout', partial };
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    name: inner.name,
    model: inner.model,
    ledger: () => ({ ...ledger }),
    async generate(req: GenerateRequest, opts: GenerateOptions): Promise<GenerateResult> {
      const t0 = now();
      const system = withPlanCap(req.system, params.planCapChars);
      let maxTokens = params.maxTokens;
      let doubled = false;
      let usage: TokenUsage | null = null;
      for (;;) {
        const tuned: GenerateRequest = { ...req, system, maxTokens, reasoning: params.reasoning };
        const outcome = await callWithDeadline(tuned, opts);
        if (outcome.kind === 'timeout') {
          ledger.timeouts += 1;
          const estimate = estimateDroppedUsage(tuned, outcome.partial, params.servedRate);
          const total = usage === null ? estimate : addUsage(usage, estimate);
          const p = outcome.partial;
          return {
            text: p?.text ?? '',
            toolCalls: [],
            usage: total,
            model: p?.model ?? inner.model,
            stopReason: 'timeout',
            latencyMs: Math.max(0, Math.round(now() - t0)),
            ...(p?.generationId !== undefined ? { generationId: p.generationId } : {}),
            ...(p?.servedProvider !== undefined ? { servedProvider: p.servedProvider } : {}),
          };
        }
        const res = outcome.res;
        usage = usage === null ? res.usage : addUsage(usage, res.usage);
        if (isLengthStop(res.stopReason)) {
          ledger.lengthStops += 1;
          if (params.lengthHandling === 'double-once' && !doubled) {
            doubled = true;
            ledger.doubled += 1;
            maxTokens *= 2;
            continue;
          }
        }
        return { ...res, usage, latencyMs: Math.max(0, Math.round(now() - t0)) };
      }
    },
  };
}
