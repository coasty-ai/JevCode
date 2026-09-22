/**
 * The async LLM candidate source (docs/LLM-JEV-DESIGN.md §4.2, §4.6, §4.8, §4.11):
 * `fire(input)` starts a round of N `propose_fix` samples — staggered on QuixBugs/ladder class
 * (sample 0 races the seeds; `release()` fires samples 1..N−1 when the top-site seed batch
 * returns without a passer), all at once on repository class — each with its own
 * AbortController linked to the parent signal and a deadline; every sample is parsed, anchored
 * and compile-checked on arrival and pushed into an awaitable queue (`collect()` yields the
 * next arrival, null at round end) so lanes start before the last sample lands; `cancel()`
 * aborts the losers and resolves once their accounting is complete. Dollars are **reserved at
 * fire**: every sample started holds its full estimated cost (`estimatedSampleUsage`: sibling
 * prompt tokens + `max_tokens` output at the served rate) against `budget.usdLeft` before the
 * request goes out — a round fires only as many samples as the counter covers beyond what every
 * sample still in flight holds (§4.11) — and the hold is released when the sample settles. The
 * hold is the source's own ledger (`reservedUsd` on the outcome and the round summary), never a
 * debit: the counter is charged at settle alone, for what the sample cost — the provider's price
 * for a result, or `unfinishedSampleUsage` for a sample the provider never priced (cancelled,
 * timed out, failed): what it streamed (the `onCancelled` facts, when the generator forwards them)
 * / 4 plus a fixed reasoning allowance — never `max_tokens`. Charging at settle keeps a step budget
 * re-installed mid-round (the repository step-1 overlap) whole: a sample lands on the counter that
 * is live when it settles, and until then its hold stands against that counter.
 * Every started sample settles exactly once (a rejecting compile check or a throwing callback
 * becomes an `error` arrival), so a round always closes. A sample the rate limiter refused — every
 * attempt of the provider's retry chain answered HTTP 429 (the chain gave up: a 429
 * `ProviderHttpError`), or the abort landed in a 429 backoff (the provider's
 * `CancelledGeneration.rateLimited` fact) — was never served: it is booked at $0 (its hold comes
 * back, the counter is not charged) and marked `rateLimited`; a round whose every fired sample
 * ended so reports `rateLimitedRound`, and the controller (search/llm.ts) refunds the round to the
 * step's counters — a rate-limited round is not an exhausted one. Rounds are cached in memory by (goal,
 * listing set, attempt ledger, round): a re-fire with the same key replays the cached patches
 * (converted and compile-checked against the current base) and skips generation when ≥ N
 * distinct untried candidates are already known. A `fire()` while a cancelled or fully-fired
 * round is still draining supersedes it (the old round keeps its accounting and cache write);
 * only a staggered round still awaiting `release()` is refused with `round_open`.
 *
 * `generateWithDeadline`, `estimatedSampleUsage` and `unfinishedSampleUsage` are the one place a
 * sample is started and priced; repro.ts reuses them for L2.
 */
import { sha12 } from '../../core/hash.js';
import { ProviderHttpError } from '../../errors.js';
import type { CancelledGeneration, GeneratePurpose, GenerateReasoning, GenerateRequest, GenerateResult, Json, SynthesizerGeneration, TokenUsage } from '../../core/types.js';
import { monotonicNow, percentile } from '../../core/time.js';
import { linkedAbort } from '../../provider/sse.js';
import type { SourceFile } from '../types.js';
import { convertSample, type CompileCheck, type DroppedPatch, type LlmApplied } from './candidates.js';
import { listingHash, type Listing } from './prompt.js';
import { PROPOSE_FIX_TOOL, PROPOSE_FIX_TOOL_NAME, isLengthStop, parseProposeFix, type PatchSpec } from './schema.js';
import { reasoningEnabled, type GenerateFn, type LlmCandidate, type OracleClass } from './types.js';

// ---------------------------------------------------------------------------------------
// Schedule constants (§4.6, §4.8)
// ---------------------------------------------------------------------------------------

export const LLM_SAMPLE_DEADLINE = { minMs: 10_000, maxMs: 20_000, repositoryMs: 30_000 } as const;
export const LLM_MAX_TOKENS = 1500;
export const LLM_MAX_TOKENS_REASONING = 3000;
export const SAMPLES_PER_ROUND: Readonly<Record<OracleClass, number>> = { quixbugs: 4, ladder: 3, repository: 6 };
/** repository class with `t_repro > 2 s` */
export const SAMPLES_REPOSITORY_SLOW = 4;
export const REPOSITORY_FAST_REPRO_MS = 2000;
export const SAMPLE_TEMPERATURE = { first: 0, rest: 0.8, feedbackFirst: 0.6, feedbackRest: 1.0 } as const;
/**
 * §4.12 / §10.2 finding (a): OpenRouter answers `reasoning: {enabled: false}` with HTTP 400 on z-ai/glm-5.3* ("Reasoning is
 * mandatory for this endpoint"), so every sample asks for the lowest effort and the max_tokens base is the reasoning-on one.
 */
export const LLM_DEFAULT_REASONING: GenerateReasoning = { effort: 'low' };
/** The max_tokens base a reasoning setting implies: 3,000 with reasoning on, 1,500 off or unsent (§4.5). */
export function maxTokensBase(reasoning: GenerateReasoning | null | undefined): number {
  return reasoningEnabled(reasoning ?? undefined) ? LLM_MAX_TOKENS_REASONING : LLM_MAX_TOKENS;
}
/**
 * What every sample sends unless the caller pins otherwise (`LlmSourceDeps.generation`): the one object the bench's llm-jev /
 * llm-sieve arms record in summary.json AND hand to the synthesizer, so the record and the requests cannot disagree.
 */
export const LLM_DEFAULT_GENERATION: SynthesizerGeneration = {
  reasoning: LLM_DEFAULT_REASONING,
  maxTokens: maxTokensBase(LLM_DEFAULT_REASONING),
  sampleDeadline: LLM_SAMPLE_DEADLINE,
  sampleTemperature: SAMPLE_TEMPERATURE,
};
/** persisted cache bound (§4.11) */
export const LLM_CACHE_PERSIST_BYTES = 4096;

export function samplesFor(klass: OracleClass, tReproMs: number | null = null): number {
  if (klass === 'repository') return tReproMs !== null && tReproMs > REPOSITORY_FAST_REPRO_MS ? SAMPLES_REPOSITORY_SLOW : SAMPLES_PER_ROUND.repository;
  return SAMPLES_PER_ROUND[klass];
}

/** Sample 0 races the seeds on the cheap-test classes; repository rounds fire whole (seeds are 0 % on new-logic hunks). */
export function staggered(klass: OracleClass): boolean {
  return klass !== 'repository';
}

/** `clamp(2 × running p50 of valid samples, minMs, maxMs)` on QuixBugs/ladder (the probe's p90 for the first round, else the cap), `repositoryMs` on repositories. */
export function sampleDeadlineMs(klass: OracleClass, p50ValidMs: number | null, probeP90Ms: number | null = null, deadline: SynthesizerGeneration['sampleDeadline'] = LLM_SAMPLE_DEADLINE): number {
  if (klass === 'repository') return deadline.repositoryMs;
  if (p50ValidMs === null) return probeP90Ms !== null ? Math.min(deadline.maxMs, Math.max(deadline.minMs, probeP90Ms)) : deadline.maxMs;
  return Math.min(deadline.maxMs, Math.max(deadline.minMs, 2 * p50ValidMs));
}

export function sampleSeed(step: number, k: number): number {
  return step * 100 + k;
}

/** Sample 0 at temperature 0 (0.6 in the feedback round), the rest at 0.8 (1.0) — or the pinned values. */
export function sampleTemperature(k: number, round: number, t: SynthesizerGeneration['sampleTemperature'] = SAMPLE_TEMPERATURE): number {
  if (round >= 2) return k === 0 ? t.feedbackFirst : t.feedbackRest;
  return k === 0 ? t.first : t.rest;
}

export function llmCacheKey(goalId: string, listingHashValue: string, attemptHash: string, round: number): string {
  return sha12([goalId, listingHashValue, attemptHash, round]);
}

// ---------------------------------------------------------------------------------------
// One sample with a deadline (§4.8)
// ---------------------------------------------------------------------------------------

export type CancelReason = 'commit' | 'budget' | 'abort';

/** The abort reason a deadline puts on a sample's controller. */
export class LlmSampleTimeout extends Error {
  readonly deadlineMs: number;
  constructor(deadlineMs: number) {
    super(`llm sample deadline ${deadlineMs} ms`);
    this.name = 'LlmSampleTimeout';
    this.deadlineMs = deadlineMs;
  }
}

/** The abort reason a loser cancellation puts on a sample's controller. */
export class LlmSampleCancelled extends Error {
  readonly why: CancelReason;
  constructor(why: CancelReason) {
    super(`llm sample cancelled: ${why}`);
    this.name = 'LlmSampleCancelled';
    this.why = why;
  }
}

export type SampleEnd = { kind: 'result'; result: GenerateResult; ms: number } | { kind: 'timeout' | 'cancelled' | 'error'; ms: number; error: unknown };

export interface SampleRun {
  promise: Promise<SampleEnd>;
  abort(reason: CancelReason): void;
}

export interface SampleRunOptions {
  sample: number;
  purpose: GeneratePurpose;
  /** the parent (step) signal; the sample's own controller is linked to it */
  signal: AbortSignal;
  /** contract 1.4 (COORDINATION-DESIGN §12.0.2 P3): the goal and round this sample is fired for — the engine records them on the pause cache and on `PausePoint.llm` */
  goalId?: string;
  goalRound?: number;
  deadlineMs: number;
  now?: () => number;
  /** §4.8 facts of a stream the abort cut after its headers (forwarded to the generator; the estimate is `unfinishedSampleUsage`'s) */
  onCancelled?: (partial: CancelledGeneration) => void;
}

/** Start one sample: a linked AbortController, a deadline timer, and an outcome that never rejects. */
export function generateWithDeadline(generate: GenerateFn, req: GenerateRequest, o: SampleRunOptions): SampleRun {
  const now = o.now ?? monotonicNow;
  const { controller, unlink } = linkedAbort(o.signal);
  const timeout = new LlmSampleTimeout(o.deadlineMs);
  const timer = setTimeout(() => controller.abort(timeout), Math.max(0, o.deadlineMs));
  const t0 = now();
  // the call starts synchronously so a caller can observe it right after `fire()` (and so the accounting sees one call per fired sample)
  let started: Promise<GenerateResult>;
  try {
    started = generate(req, { sample: o.sample, purpose: o.purpose, signal: controller.signal, ...(o.goalId === undefined ? {} : { goalId: o.goalId }), ...(o.goalRound === undefined ? {} : { goalRound: o.goalRound }), ...(o.onCancelled === undefined ? {} : { onCancelled: o.onCancelled }) });
  } catch (e) {
    started = Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  const promise: Promise<SampleEnd> = started
    .then(
      (result): SampleEnd => ({ kind: 'result', result, ms: Math.round(now() - t0) }),
      (error: unknown): SampleEnd => {
        const ms = Math.round(now() - t0);
        if (controller.signal.aborted) return { kind: controller.signal.reason === timeout ? 'timeout' : 'cancelled', ms, error };
        return { kind: 'error', ms, error };
      },
    )
    .finally(() => {
      clearTimeout(timer);
      unlink();
    });
  return { promise, abort: (reason) => controller.abort(new LlmSampleCancelled(reason)) };
}

// ---------------------------------------------------------------------------------------
// Awaitable queue
// ---------------------------------------------------------------------------------------

export class ArrivalQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((v: T | null) => void)[] = [];
  private closedFlag = false;

  get closed(): boolean {
    return this.closedFlag;
  }

  push(item: T): void {
    const w = this.waiters.shift();
    if (w !== undefined) w(item);
    else this.items.push(item);
  }

  close(): void {
    this.closedFlag = true;
    for (const w of this.waiters.splice(0)) w(null);
  }

  /** The next item; null once the queue is closed and drained. */
  next(): Promise<T | null> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closedFlag) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

// ---------------------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------------------

export type SampleStatus = 'valid' | 'empty' | 'malformed' | 'length' | 'timeout' | 'cancelled' | 'error' | 'cached';

export interface SampleArrival {
  /** −1 for the cache replay */
  sample: number;
  status: SampleStatus;
  ms: number;
  candidates: LlmCandidate[];
  applied: LlmApplied[];
  dropped: DroppedPatch[];
  need: { paths: string[]; symbols: string[] } | null;
  analysis: string | null;
  usage: TokenUsage | null;
  /** what this sample cost the step's LLM budget (an estimate when `estimated`) */
  usd: number;
  estimated: boolean;
  generationId: string | null;
  detail: string;
  /**
   * true when the sample met HTTP 429: it ended rate-limited without a result — a 429 `ProviderHttpError` (the retry chain
   * gave up) or the provider's `CancelledGeneration.rateLimited` fact (the abort landed in a 429 backoff); nothing was served,
   * so `usd` is 0 and the counter is not charged — or its result came through a 429 retry (`GenerateResult.rateLimited`; the
   * result stands, the flag is a fact for the round's classification). Every arrival states it (`emptyArrival`: false).
   */
  rateLimited: boolean;
}

/** The LLM counters of the StepBudget (§4.11); stage 4 adds them to `StepBudget` itself. */
export interface LlmBudget {
  roundsLeft: number;
  samplesLeft: number;
  usdLeft: number;
}

export interface LlmPricing {
  inputPerM: number;
  outputPerM: number;
}

export interface LlmFireInput {
  goalId: string;
  step: number;
  /** 1 = L1, 2 = the feedback round L1′ */
  round: number;
  klass: OracleClass;
  /** default `samplesFor(klass, tReproMs)` */
  n?: number;
  tReproMs?: number | null;
  /** default `staggered(klass)` */
  stagger?: boolean;
  system: string;
  /** the user message of sample k (the hint differs per sample) */
  userFor: (sample: number) => string;
  files: ReadonlyMap<string, SourceFile>;
  listings: readonly Listing[];
  tried?: ReadonlySet<string>;
  verdictOf?: (sha: string) => string | null;
  /** default `maxTokensFor(goalId, base)` — base = the pinned generation's (3,000 with reasoning on, 1,500 off), or the base `reasoning` implies when that is given; doubled once after a `length` drop (§4.5) */
  maxTokens?: number;
  /** default `sampleDeadlineMs(klass, running p50)` over the pinned generation's clamp */
  deadlineMs?: number;
  /** default the pinned generation's (`{effort: 'low'}` unless the caller pinned otherwise; `{enabled: false}` is HTTP 400 on GLM, §10.2 finding (a)) */
  reasoning?: GenerateReasoning;
  signal: AbortSignal;
  budget: LlmBudget;
  /** identity of the attempt ledger shown (candidates.ts attemptsHash); '' when none */
  attemptHash?: string;
  cacheKey?: string;
}

export type FireOutcome =
  | { fired: true; samples: number; cached: number; deadlineMs: number; key: string; /** dollars the fired samples hold against `budget.usdLeft` until they settle (the source's hold, not a debit: the counter is charged at settle) */ reservedUsd: number }
  | { fired: false; reason: 'no_rounds' | 'no_usd' | 'no_samples' | 'cached' | 'aborted' | 'round_open'; cached: number; key: string | null };

export interface LlmRoundSummary {
  goalId: string;
  round: number;
  klass: OracleClass;
  n: number;
  fired: number;
  valid: number;
  empty: number;
  malformed: number;
  length: number;
  timeouts: number;
  cancelled: number;
  errors: number;
  misanchored: number;
  syntaxErrors: number;
  /** patches whose compile check itself failed (sandbox abort / spawn failure) */
  compileFailed: number;
  duplicates: number;
  tried: number;
  /** distinct candidates the round produced (cache replay included) */
  distinct: number;
  needs: number;
  wallMs: number;
  usd: number;
  estimatedUsd: number;
  /** dollars the in-flight samples still hold against `budget.usdLeft` (their full estimates; 0 once the round closed): the source itself refuses a sample the counter cannot cover beyond it, and a caller reading the counter for headroom subtracts it. Optional so hand-built summaries (test fakes) need not state it; the source always does. */
  reservedUsd?: number;
  /** fired samples that ended rate-limited without a result (HTTP 429 on every attempt, or aborted in a 429 backoff): booked at $0, nothing served. Optional like `reservedUsd`; the source always states it. */
  rateLimited?: number;
  /**
   * true once the round closed with ≥ 1 fired sample and every fired sample ended rate-limited without a result: the round
   * produced nothing because the rate limiter refused it, not because the model had nothing — the controller (search/llm.ts)
   * refunds the round to the step's counters and the next step re-fires; such a round is NOT exhausted. A cache replay (sample
   * −1) does not count as fired; a sample whose result came through a 429 retry counts as served. Optional like `reservedUsd`.
   */
  rateLimitedRound?: boolean;
  deadlineMs: number;
  closed: boolean;
}

export interface LlmSource {
  /**
   * Start a round; synchronous — arrivals come through `collect()`. A cancelled or fully-fired round
   * that is still draining is superseded (it keeps its accounting); a staggered round still awaiting
   * `release()` is refused with `round_open`.
   */
  fire(input: LlmFireInput): FireOutcome;
  /** stagger: fire samples 1..N−1 now (the top-site seed batch returned without a passer, or the site set has no seeds); nothing fires once the dollar or sample counter is spent or the step signal is aborted */
  release(): void;
  /** the next arrival of the current round, or null when it has ended (every started sample settled and no more will fire) */
  collect(): Promise<SampleArrival | null>;
  /** every remaining arrival of the current round; only after `release()` or `cancel()` on a staggered round */
  collectAll(): Promise<SampleArrival[]>;
  /** abort every in-flight sample (a commit after the grace, the step budget, the step signal); resolves when the round has closed, i.e. every cancelled sample is metered */
  cancel(reason: CancelReason): Promise<void>;
  round(): LlmRoundSummary | null;
  inFlight(): number;
  /** `max_tokens` for the goal's next round: the pinned base (default `LLM_DEFAULT_GENERATION.maxTokens`), doubled once after a `length` drop (§4.5) */
  maxTokensFor(goalId: string, base?: number): number;
  /** running p50 of valid samples' latency this run, null before the first */
  p50ValidMs(): number | null;
  /** `{goalId: {round, sha12: [...]}}` ≤ 4 KB for `synthState` (§4.11) */
  exportCache(): Json;
}

export interface LlmSourceDeps {
  generate: GenerateFn;
  compile?: CompileCheck | null;
  /** served rate for estimates and for results without a cost; null → estimates cost 0 */
  pricing?: LlmPricing | null;
  /** `ctx.emit({type:'synth', phase, detail})` bound by the wiring */
  emit?: (phase: string, detail: string) => void;
  onSample?: (a: SampleArrival) => void;
  now?: () => number;
  /** the persisted cache of a resumed run (`exportCache()` shape); sample bodies are not persisted, so a resumed step re-asks */
  cache?: Json | null;
  /** the probe's p90, used as the first round's deadline (§4.8) */
  probeP90Ms?: number | null;
  /** what every sample sends (§10.1: pinned per bench arm and recorded verbatim); default `LLM_DEFAULT_GENERATION` */
  generation?: SynthesizerGeneration;
}

interface CachedRound {
  goalId: string;
  round: number;
  shas: string[];
  patches: PatchSpec[];
  /** write order, so `exportCache` keeps the freshest rounds under the 4 KB bound */
  seq: number;
}

interface RoundState {
  input: LlmFireInput;
  key: string;
  n: number;
  deadlineMs: number;
  maxTokens: number;
  queue: ArrivalQueue<SampleArrival>;
  runs: Map<number, SampleRun>;
  fired: Set<number>;
  pending: number;
  released: boolean;
  noMore: boolean;
  closed: boolean;
  /** resolves when the round closes */
  done: Promise<void>;
  resolveDone: () => void;
  startedMs: number;
  wallMs: number;
  siblingInput: number | null;
  seen: Map<string, LlmCandidate>;
  arrivals: SampleArrival[];
  /** sha → the patch that produced it, for the cache */
  patchOf: Map<string, PatchSpec>;
  /** sample → dollars held at its start (its full estimate), released when it settles */
  reserved: Map<number, number>;
  /** sample → the `onCancelled` facts, when its stream was cut after the headers */
  partials: Map<number, CancelledGeneration>;
}

/** The provider's cost when it gave one, else the served rate over the tokens; 0 without pricing. */
export function costOf(usage: TokenUsage, pricing: LlmPricing | null): number {
  if (Number.isFinite(usage.costUsd) && usage.costUsd > 0) return usage.costUsd;
  if (pricing === null) return 0;
  return (usage.inputTokens * pricing.inputPerM + usage.outputTokens * pricing.outputPerM) / 1e6;
}

export interface SampleEstimateInput {
  /** a sibling sample's `prompt_tokens` (same prefix); null before the first sibling lands → chars / 4 */
  siblingInputTokens: number | null;
  /** system + user message chars, for the fallback */
  promptChars: number;
  maxTokens: number;
  pricing: LlmPricing | null;
}

/** chars per token of every size estimate (§4.8: "streamed tool-argument chars / 4") */
export const CHARS_PER_TOKEN = 4;
/**
 * Output tokens booked for a sample that never returned, beyond what it streamed: GLM bills its reasoning (§4.13: it cannot
 * be disabled), and a stream cut before its answer has mostly spent that already. One fixed figure, exported with
 * `unfinishedSampleUsage` so the engine's ledger can book the same estimate.
 */
export const UNFINISHED_REASONING_ALLOWANCE_TOKENS = 1000;

/** The most a sample can cost — the reservation taken at fire (§4.11): sibling prompt tokens (else chars / 4) + `max_tokens` output at the served rate. */
export function estimatedSampleUsage(e: SampleEstimateInput): TokenUsage {
  const inputTokens = e.siblingInputTokens ?? Math.ceil(e.promptChars / CHARS_PER_TOKEN);
  const usage: TokenUsage = { inputTokens, outputTokens: e.maxTokens, costUsd: 0, calls: 1, estimated: true };
  usage.costUsd = costOf(usage, e.pricing);
  return usage;
}

export interface UnfinishedSampleInput {
  /** a sibling sample's `prompt_tokens` (same prefix); null before the first sibling lands → chars / 4 */
  siblingInputTokens: number | null;
  promptChars: number;
  /** the `onCancelled` facts, when the abort landed after the response headers; null when nothing is known about the stream */
  partial: CancelledGeneration | null;
  /** the request asked for reasoning tokens: the allowance applies */
  reasoning: boolean;
  pricing: LlmPricing | null;
}

/**
 * The one estimator here for a sample the provider never priced — cancelled, timed out or failed (§4.8, §4.13), exported so
 * the engine's ledger can book the same figure: a usage frame that had already arrived is priced like a completed call;
 * otherwise input = a sibling's prompt tokens (else chars / 4) and output = streamed answer chars / 4 plus the reasoning
 * allowance (the streamed reasoning when it is larger; nothing when reasoning was off), at the served rate. The stream's
 * facts are the `onCancelled` callback's, so a generator that does not forward it books the allowance alone. Never `max_tokens`.
 */
export function unfinishedSampleUsage(e: UnfinishedSampleInput): TokenUsage {
  const frame = e.partial?.usage;
  if (frame !== undefined) {
    const usage: TokenUsage = { ...frame, calls: 1 };
    if (!(Number.isFinite(usage.costUsd) && usage.costUsd > 0)) usage.costUsd = costOf({ ...usage, costUsd: 0 }, e.pricing);
    return usage;
  }
  const inputTokens = e.siblingInputTokens ?? Math.ceil(e.promptChars / CHARS_PER_TOKEN);
  const answerChars = e.partial === null ? 0 : e.partial.toolChars + e.partial.text.length;
  const reasoningTokens = e.partial === null ? 0 : Math.ceil(e.partial.reasoningChars / CHARS_PER_TOKEN);
  const allowance = e.reasoning ? Math.max(UNFINISHED_REASONING_ALLOWANCE_TOKENS, reasoningTokens) : reasoningTokens;
  const usage: TokenUsage = { inputTokens, outputTokens: Math.ceil(answerChars / CHARS_PER_TOKEN) + allowance, costUsd: 0, calls: 1, estimated: true };
  usage.costUsd = costOf(usage, e.pricing);
  return usage;
}

/** Whether `usdLeft` covers one more sample at `perSampleUsd` (a 0 estimate — no pricing — needs only a positive counter). */
export function coversSample(usdLeft: number, perSampleUsd: number): boolean {
  return usdLeft > 0 && usdLeft + 1e-9 >= perSampleUsd;
}

/** Samples `usdLeft` can cover at `perSampleUsd` (unbounded when the estimate is 0: no pricing; 0 when the counter is spent). */
export function affordableSamples(usdLeft: number, perSampleUsd: number): number {
  if (!(usdLeft > 0)) return 0;
  if (!(perSampleUsd > 0)) return Number.POSITIVE_INFINITY;
  return Math.floor(usdLeft / perSampleUsd + 1e-9);
}

function emptyArrival(sample: number, status: SampleStatus, ms: number, detail: string): SampleArrival {
  return { sample, status, ms, candidates: [], applied: [], dropped: [], need: null, analysis: null, usage: null, usd: 0, estimated: false, generationId: null, detail, rateLimited: false };
}

/**
 * Whether a sample that yielded no result ended rate-limited (core/types.ts `CancelledGeneration.rateLimited`, provider/sse.ts
 * `isRateLimit`): the error the chain gave up with is a 429 `ProviderHttpError`, or the provider delivered the rate-limited fact
 * through `onCancelled` (the abort landed in a 429 backoff; the error is then the abort reason). Nothing was served either way.
 */
export function endedRateLimited(error: unknown, partial: CancelledGeneration | null): boolean {
  return (error instanceof ProviderHttpError && error.status === 429) || partial?.rateLimited === true;
}

/** A sample that ended rate-limited without a result is served nothing and billed nothing (the engine's row says the same: `stopReason` 'rate_limited', zero usage). */
export function rateLimitedUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 1 };
}

/** The fired samples of a round that were never served: settled without a result and rate-limited (`SampleArrival.rateLimited`). */
export function unservedRateLimited(a: Pick<SampleArrival, 'sample' | 'status' | 'rateLimited'>): boolean {
  return a.sample >= 0 && a.rateLimited && (a.status === 'error' || a.status === 'cancelled' || a.status === 'timeout');
}

function readPersistedCache(json: Json | null | undefined): Map<string, { round: number; shas: string[] }> {
  const out = new Map<string, { round: number; shas: string[] }>();
  if (json === null || json === undefined || typeof json !== 'object' || Array.isArray(json)) return out;
  for (const [goalId, v] of Object.entries(json)) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) continue;
    const round = v['round'];
    const shas = v['sha12'];
    if (typeof round === 'number' && Array.isArray(shas)) out.set(goalId, { round, shas: shas.filter((s): s is string => typeof s === 'string') });
  }
  return out;
}

export function createLlmSource(deps: LlmSourceDeps): LlmSource {
  const now = deps.now ?? monotonicNow;
  const pricing = deps.pricing ?? null;
  const emit = deps.emit ?? ((): void => undefined);
  const gen = deps.generation ?? LLM_DEFAULT_GENERATION;
  const cache = new Map<string, CachedRound>();
  const persisted = readPersistedCache(deps.cache);
  const lengthGoals = new Set<string>();
  const validMs: number[] = [];
  let state: RoundState | null = null;
  /** every round not yet closed — the current one and any superseded round still draining with its holds */
  const live = new Set<RoundState>();
  let cacheSeq = 0;

  const maxTokensFor = (goalId: string, base = gen.maxTokens): number => (lengthGoals.has(goalId) ? base * 2 : base);
  const p50ValidMs = (): number | null => percentile(validMs, 50);
  const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const promptChars = (st: RoundState, k: number): number => st.input.system.length + st.input.userFor(k).length;

  /** The most sample k can cost: what `startSample` reserves. */
  function reservationUsage(st: RoundState, k: number): TokenUsage {
    return estimatedSampleUsage({ siblingInputTokens: st.siblingInput, promptChars: promptChars(st, k), maxTokens: st.maxTokens, pricing });
  }

  /** What a sample that never returned is booked at: the shared estimator over the facts its stream left (§4.8, §4.13). */
  function unfinishedUsage(st: RoundState, k: number): TokenUsage {
    const reasoning = st.input.reasoning ?? gen.reasoning;
    return unfinishedSampleUsage({ siblingInputTokens: st.siblingInput, promptChars: promptChars(st, k), partial: st.partials.get(k) ?? null, reasoning: reasoningEnabled(reasoning ?? undefined), pricing });
  }

  /**
   * Book a settled sample: its hold is released and what it cost comes off the counter that is live now (in flight a sample
   * holds its full estimate; settled it has cost its price). Nothing is ever credited to the counter, so a step budget
   * re-installed mid-round is charged the prices alone.
   */
  function chargeSettled(st: RoundState, k: number, usd: number): void {
    st.reserved.delete(k);
    if (Number.isFinite(usd) && usd > 0) st.input.budget.usdLeft -= usd;
  }

  const reservedUsd = (st: RoundState): number => [...st.reserved.values()].reduce((a, b) => a + b, 0);
  /** What every open round holds: a superseded round drains with its holds until it closes. */
  const heldUsd = (): number => [...live].reduce((s, st) => s + reservedUsd(st), 0);
  /** The counter's headroom for one more sample: what it reads minus what the samples in flight hold (§4.11). */
  const headroom = (b: LlmBudget): number => b.usdLeft - heldUsd();

  function summaryOf(st: RoundState): LlmRoundSummary {
    const count = (s: SampleStatus): number => st.arrivals.filter((a) => a.status === s).length;
    const drops = (r: DroppedPatch['reason']): number => st.arrivals.reduce((n, a) => n + a.dropped.filter((d) => d.reason === r).length, 0);
    // the fired samples that settled (the cache replay, sample −1, is not fired); the round is rate-limited when all of them were refused
    const settledFired = st.arrivals.filter((a) => a.sample >= 0);
    const rateLimited = settledFired.filter(unservedRateLimited).length;
    return {
      goalId: st.input.goalId,
      round: st.input.round,
      klass: st.input.klass,
      n: st.n,
      fired: st.fired.size,
      valid: count('valid'),
      empty: count('empty'),
      malformed: count('malformed'),
      length: count('length'),
      timeouts: count('timeout'),
      cancelled: count('cancelled'),
      errors: count('error'),
      misanchored: drops('misanchored'),
      syntaxErrors: drops('syntax_error'),
      compileFailed: drops('compile_failed'),
      duplicates: drops('duplicate'),
      tried: drops('tried'),
      distinct: st.seen.size,
      needs: st.arrivals.filter((a) => a.need !== null && (a.need.paths.length > 0 || a.need.symbols.length > 0)).length,
      wallMs: st.closed ? st.wallMs : Math.round(now() - st.startedMs),
      usd: st.arrivals.reduce((s, a) => s + a.usd, 0),
      estimatedUsd: st.arrivals.filter((a) => a.estimated).reduce((s, a) => s + a.usd, 0),
      reservedUsd: reservedUsd(st),
      rateLimited,
      rateLimitedRound: st.closed && st.fired.size > 0 && settledFired.length === st.fired.size && rateLimited === st.fired.size,
      deadlineMs: st.deadlineMs,
      closed: st.closed,
    };
  }

  function maybeClose(st: RoundState): void {
    if (st.closed || st.pending > 0 || !(st.released || st.noMore)) return;
    st.closed = true;
    live.delete(st);
    st.wallMs = Math.round(now() - st.startedMs);
    // the cache keeps every distinct patch ever seen under this key (tried ones included, so they are answered at once next time)
    const prev = cache.get(st.key);
    const shas = [...new Set([...(prev?.shas ?? []), ...st.seen.keys()])];
    const patchOf = (sha: string): PatchSpec | undefined => st.patchOf.get(sha) ?? prev?.patches[prev.shas.indexOf(sha)];
    const patches = shas.map(patchOf).filter((p): p is PatchSpec => p !== undefined);
    if (shas.length > 0 && patches.length === shas.length) cache.set(st.key, { goalId: st.input.goalId, round: st.input.round, shas, patches, seq: ++cacheSeq });
    st.queue.close();
    st.resolveDone();
    const s = summaryOf(st);
    emit('llm:round', `goal ${s.goalId} round ${s.round}: ${s.fired} fired, ${s.valid} valid, ${s.malformed} malformed, ${s.length} length, ${s.timeouts} timeout, ${s.cancelled} cancelled, ${s.errors} error${(s.rateLimited ?? 0) > 0 ? `, ${s.rateLimited} rate-limited (HTTP 429, nothing served)` : ''}, ${s.distinct} distinct candidates, ${s.wallMs} ms, $${s.usd.toFixed(4)}${s.estimatedUsd > 0 ? ` (est. $${s.estimatedUsd.toFixed(4)})` : ''}${s.rateLimitedRound === true ? '; every fired sample was rate-limited — the round is not exhausted' : ''}`);
  }

  /** Record one arrival. The queue push, the pending count and the close run in `finally`, so a throwing `emit`/`onSample` cannot leave the round open. */
  function settle(st: RoundState, a: SampleArrival): void {
    st.arrivals.push(a);
    try {
      const drops = a.dropped.length > 0 ? ` (${a.dropped.map((d) => d.reason).join(', ')})` : '';
      emit('llm:sample', `k=${a.sample} ${a.status} ${a.ms} ms: ${a.candidates.length} candidates${drops}${a.estimated ? `, est. $${a.usd.toFixed(4)}` : ''}${a.status === 'valid' || a.status === 'empty' || a.status === 'cached' ? '' : ` — ${a.detail}`}`);
      deps.onSample?.(a);
    } finally {
      st.queue.push(a);
      st.pending -= 1;
      maybeClose(st);
    }
  }

  /** The terminal handler of every sample chain: a callback that threw is reported, never left as an unhandled rejection. */
  function reportFailure(e: unknown): void {
    try {
      emit('llm:error', messageOf(e));
    } catch {
      // the emitter itself is broken; nothing else to do
    }
  }

  /** An arrival for a sample whose processing threw after its cost was booked (usd 0: nothing more to charge). */
  function internalFailure(k: number, ms: number, e: unknown): SampleArrival {
    return emptyArrival(k, 'error', ms, `internal: ${messageOf(e)}`);
  }

  async function convert(st: RoundState, sample: number, patches: readonly PatchSpec[], compile: CompileCheck | null): Promise<Pick<SampleArrival, 'candidates' | 'applied' | 'dropped'>> {
    const res = await convertSample({ sample, patches, files: st.input.files, listings: st.input.listings, seen: st.seen, compile, ...(st.input.tried !== undefined ? { tried: st.input.tried } : {}), ...(st.input.verdictOf !== undefined ? { verdictOf: st.input.verdictOf } : {}) });
    for (const c of res.candidates) {
      const j = Number(c.op.split('_')[2]);
      const p = patches[j];
      if (p !== undefined) st.patchOf.set(c.id.slice('llm:'.length), p);
    }
    return res;
  }

  async function handleEnd(st: RoundState, k: number, end: SampleEnd): Promise<SampleArrival> {
    if (end.kind !== 'result') {
      const detail = end.kind === 'timeout' ? `deadline ${st.deadlineMs} ms passed` : end.kind === 'cancelled' ? (end.error instanceof Error ? end.error.message : 'cancelled') : messageOf(end.error);
      if (endedRateLimited(end.error, st.partials.get(k) ?? null)) {
        // the rate limiter refused the sample (every attempt a 429, or the abort landed in a 429 backoff): nothing was served and
        // nothing is billed — the hold comes back, the counter is not charged, and the round's classification reads the flag
        chargeSettled(st, k, 0);
        return { ...emptyArrival(k, end.kind, end.ms, `rate-limited (HTTP 429), nothing served: ${detail}`), usage: rateLimitedUsage(), rateLimited: true };
      }
      // no priced result — a timeout, a cancellation or a provider error alike is booked from what its stream left (§4.8, §4.13: never
      // `max_tokens`); the reservation comes back and every accounting is complete
      const usage = unfinishedUsage(st, k);
      chargeSettled(st, k, usage.costUsd);
      return { ...emptyArrival(k, end.kind, end.ms, detail), usage, usd: usage.costUsd, estimated: usage.estimated === true };
    }
    const { result } = end;
    const usd = costOf(result.usage, pricing);
    chargeSettled(st, k, usd);
    if (st.siblingInput === null && result.usage.inputTokens > 0) st.siblingInput = result.usage.inputTokens;
    // a result reached through a 429 retry carries the fact (the result stands; the round's classification reads it)
    const base: SampleArrival = { ...emptyArrival(k, 'valid', end.ms, ''), usage: result.usage, usd, generationId: result.generationId ?? null, rateLimited: result.rateLimited === true };
    if (isLengthStop(result.stopReason)) {
      lengthGoals.add(st.input.goalId);
      return { ...base, status: 'length', detail: 'finish_reason length: the reply was cut off; the goal’s next round doubles max_tokens once' };
    }
    const parsed = parseProposeFix(result);
    if (!parsed.ok) return { ...base, status: 'malformed', detail: parsed.reason };
    validMs.push(end.ms);
    try {
      const conv = await convert(st, k, parsed.value.patches, deps.compile ?? null);
      return { ...base, ...conv, status: parsed.value.patches.length === 0 ? 'empty' : 'valid', need: parsed.value.need, analysis: parsed.value.analysis, detail: parsed.value.analysis };
    } catch (e) {
      // the conversion threw past convertSample's own drops: the sample stays booked, its patches are not passed on
      return { ...base, status: 'error', need: parsed.value.need, analysis: parsed.value.analysis, detail: `conversion failed: ${messageOf(e)}` };
    }
  }

  function startSample(st: RoundState, k: number): boolean {
    if (st.closed || st.noMore || st.fired.has(k)) return false;
    // the §4.2 skip conditions hold per sample, and the dollar counter must cover this sample's full estimate beyond what the
    // samples already in flight hold (§4.11): sample 0 may have taken the headroom, the step may have ended before release()
    const reservation = reservationUsage(st, k).costUsd;
    if (st.input.signal.aborted || st.input.budget.samplesLeft <= 0 || !coversSample(headroom(st.input.budget), reservation)) return false;
    st.input.budget.samplesLeft -= 1;
    st.reserved.set(k, reservation);
    st.fired.add(k);
    st.pending += 1;
    const req: GenerateRequest = {
      system: st.input.system,
      messages: [{ role: 'user', content: st.input.userFor(k) }],
      maxTokens: st.maxTokens,
      temperature: sampleTemperature(k, st.input.round, gen.sampleTemperature),
      tools: [PROPOSE_FIX_TOOL],
      toolChoice: { name: PROPOSE_FIX_TOOL_NAME },
      providerPrefs: { requireParameters: true },
    };
    // the pinned reasoning verbatim (null = not sent), unless the fire input overrides it
    const reasoning = st.input.reasoning ?? gen.reasoning;
    if (reasoning !== null) req.reasoning = reasoning;
    if (k > 0) req.seed = sampleSeed(st.input.step, k);
    const t0 = now();
    const run = generateWithDeadline(deps.generate, req, { sample: k, purpose: 'propose_fix', signal: st.input.signal, goalId: st.input.goalId, goalRound: st.input.round, deadlineMs: st.deadlineMs, now, onCancelled: (partial) => st.partials.set(k, partial) });
    st.runs.set(k, run);
    void run.promise
      .then((end) => handleEnd(st, k, end))
      .catch((e: unknown) => internalFailure(k, Math.round(now() - t0), e))
      .then((a) => settle(st, a))
      .catch(reportFailure);
    return true;
  }

  function newRound(input: LlmFireInput, key: string, n: number): RoundState {
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    return {
      input,
      key,
      n,
      deadlineMs: input.deadlineMs ?? sampleDeadlineMs(input.klass, p50ValidMs(), deps.probeP90Ms ?? null, gen.sampleDeadline),
      // the pinned base, or the base an overriding `reasoning` implies (3,000 on, 1,500 off); doubled once for a goal after a `length` drop
      maxTokens: input.maxTokens ?? maxTokensFor(input.goalId, input.reasoning === undefined ? gen.maxTokens : maxTokensBase(input.reasoning)),
      queue: new ArrivalQueue<SampleArrival>(),
      runs: new Map(),
      fired: new Set(),
      pending: 0,
      released: false,
      noMore: false,
      closed: false,
      done,
      resolveDone,
      startedMs: now(),
      wallMs: 0,
      siblingInput: null,
      seen: new Map(),
      arrivals: [],
      patchOf: new Map(),
      reserved: new Map(),
      partials: new Map(),
    };
  }

  function fire(input: LlmFireInput): FireOutcome {
    const cur = state;
    if (cur !== null && !cur.closed) {
      // a staggered round still awaiting release() is open; a cancelled or fully-fired round only drains — it keeps its accounting and cache write while the new round takes over
      if (!cur.noMore && !cur.released) return { fired: false, reason: 'round_open', cached: 0, key: null };
      emit('llm:fire', `goal ${cur.input.goalId} round ${cur.input.round}: superseded while ${cur.pending} samples drain`);
    }
    const n = input.n ?? samplesFor(input.klass, input.tReproMs ?? null);
    const key = input.cacheKey ?? llmCacheKey(input.goalId, listingHash(input.listings), input.attemptHash ?? '', input.round);
    const hit = cache.get(key);
    const cachedUntried = hit === undefined ? 0 : hit.shas.filter((s) => !input.tried?.has(s)).length;
    if (input.signal.aborted) return { fired: false, reason: 'aborted', cached: cachedUntried, key };
    if (input.budget.roundsLeft <= 0 && cachedUntried === 0) return { fired: false, reason: 'no_rounds', cached: 0, key };
    if (headroom(input.budget) <= 0 && cachedUntried === 0) return { fired: false, reason: 'no_usd', cached: 0, key };
    const st = newRound(input, key, n);
    state = st;
    live.add(st);
    if (hit !== undefined && hit.patches.length > 0) {
      st.pending += 1;
      const t0 = now();
      // replayed patches are re-anchored against the current base, so the post-image is compile-checked like a fresh sample (the checker caches by content hash)
      void convert(st, -1, hit.patches, deps.compile ?? null)
        .then(
          (conv): SampleArrival => ({ ...emptyArrival(-1, 'cached', Math.round(now() - t0), `replayed ${hit.patches.length} cached patches`), ...conv }),
          (e: unknown) => internalFailure(-1, Math.round(now() - t0), e),
        )
        .then((a) => settle(st, a))
        .catch(reportFailure);
    }
    if (cachedUntried >= n) {
      st.noMore = true;
      emit('llm:fire', `goal ${input.goalId} round ${input.round}: ${cachedUntried} cached untried candidates ≥ N=${n}; no generation`);
      maybeClose(st);
      return { fired: false, reason: 'cached', cached: cachedUntried, key };
    }
    // §4.11: a round fires only when the dollar counter covers one sample's full estimate beyond what the samples still in flight
    // hold (a few cents of headroom fire nothing); each further sample takes its own hold in `startSample`, so N is bounded by
    // `affordableSamples` as well as the class
    const perSample = reservationUsage(st, 0).costUsd;
    const room = headroom(input.budget);
    if (input.budget.roundsLeft <= 0 || !coversSample(room, perSample) || input.budget.samplesLeft <= 0) {
      st.noMore = true;
      maybeClose(st);
      return { fired: false, reason: input.budget.roundsLeft <= 0 ? 'no_rounds' : !coversSample(room, perSample) ? 'no_usd' : 'no_samples', cached: cachedUntried, key };
    }
    input.budget.roundsLeft -= 1;
    const stagger = input.stagger ?? staggered(input.klass);
    startSample(st, 0);
    if (!stagger) {
      for (let k = 1; k < n; k++) startSample(st, k);
      st.released = true;
    }
    const reserved = reservedUsd(st);
    emit('llm:fire', `goal ${input.goalId} round ${input.round} (${input.klass}): ${st.fired.size}/${n} samples fired${stagger ? ', staggered' : ''}, deadline ${st.deadlineMs} ms, max_tokens ${st.maxTokens}, $${reserved.toFixed(4)} reserved${cachedUntried > 0 ? `, ${cachedUntried} cached` : ''}`);
    return { fired: true, samples: st.fired.size, cached: cachedUntried, deadlineMs: st.deadlineMs, key, reservedUsd: reserved };
  }

  function release(): void {
    const st = state;
    if (st === null || st.closed || st.released) return;
    st.released = true;
    let fired = 0;
    for (let k = 1; k < st.n; k++) if (startSample(st, k)) fired += 1;
    if (fired > 0) emit('llm:fire', `goal ${st.input.goalId} round ${st.input.round}: released ${fired} more samples (top-site seeds returned no passer), $${reservedUsd(st).toFixed(4)} reserved`);
    else if (!st.noMore && st.n > 1) {
      const why = st.input.signal.aborted ? 'step aborted' : !coversSample(headroom(st.input.budget), reservationUsage(st, 1).costUsd) ? 'llm dollar counter cannot cover another sample' : st.input.budget.samplesLeft <= 0 ? 'no samples left' : 'all fired';
      emit('llm:fire', `goal ${st.input.goalId} round ${st.input.round}: release() fired nothing (${why})`);
    }
    maybeClose(st);
  }

  function cancel(reason: CancelReason): Promise<void> {
    const st = state;
    if (st === null || st.closed) return Promise.resolve();
    st.noMore = true;
    let aborted = 0;
    for (const [k, run] of st.runs) {
      if (st.arrivals.some((a) => a.sample === k)) continue;
      run.abort(reason);
      aborted += 1;
    }
    if (aborted > 0) emit('llm:cancel', `goal ${st.input.goalId} round ${st.input.round}: ${aborted} in-flight samples cancelled (${reason}), metered from what they streamed`);
    maybeClose(st);
    return st.done;
  }

  function exportCache(): Json {
    // priority order: this run's rounds newest first (the latest round per goal; they win over the persisted ones), then the
    // persisted rounds of goals not seen this run; the 4 KB trim drops from the tail, so a stale persisted sha never outlives a fresh round
    const latest = new Map<string, { round: number; shas: string[]; seq: number }>();
    for (const c of cache.values()) {
      const cur = latest.get(c.goalId);
      if (cur === undefined || c.round > cur.round || (c.round === cur.round && c.seq > cur.seq)) latest.set(c.goalId, { round: c.round, shas: c.shas, seq: c.seq });
    }
    const ordered: [string, { round: number; shas: string[] }][] = [...latest].sort((a, b) => b[1].seq - a[1].seq);
    for (const [g, v] of persisted) if (!latest.has(g)) ordered.push([g, v]);
    const out: Record<string, Json> = {};
    for (const [g, v] of ordered) {
      out[g] = { round: v.round, sha12: [...v.shas] };
      if (JSON.stringify(out).length > LLM_CACHE_PERSIST_BYTES) {
        delete out[g];
        break;
      }
    }
    return out;
  }

  return {
    fire,
    release,
    collect: () => (state === null ? Promise.resolve(null) : state.queue.next()),
    collectAll: async () => {
      const out: SampleArrival[] = [];
      const st = state;
      if (st === null) return out;
      for (;;) {
        const a = await st.queue.next();
        if (a === null) return out;
        out.push(a);
      }
    },
    cancel,
    round: () => (state === null ? null : summaryOf(state)),
    inFlight: () => (state === null ? 0 : state.pending),
    maxTokensFor,
    p50ValidMs,
    exportCache,
  };
}
