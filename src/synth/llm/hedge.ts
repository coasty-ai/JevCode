/**
 * The S2 generation mechanisms that are NOT the synthesizer's round (contract 1.9 "Fastlane" §3.1–§3.4,
 * docs/LLM-LOOP-DESIGN.md §3; F25 of the finishing pass).
 *
 * Every one of them lived inside `src/synth/llm/source.ts`, which `jev-on` never enters — so the `jev-on-next`
 * arm recorded `mechanisms.s2: true` while none of the four ran on its propose path. This module is the half
 * that is not a round: the threshold, the twin index, the provider-order rotation, the reasoning-cap
 * composition, the switch, and a **single-call hedge race** the loop can use where it has one call and no
 * sample ledger.
 *
 * `source.ts` imports and re-exports the decision functions unchanged, so its own behaviour is byte-identical
 * and its existing tests (`test/unit/synth/llm/hedge.test.ts`, `source.test.ts`,
 * `cache-and-reasoning-cap.test.ts`, `test/unit/provider/provider-order.test.ts`) keep importing from
 * `source.js` and keep passing. What it does NOT take from `source.ts` is the round's scheduling: the dollar
 * hold, `samplesLeft`, the heartbeat row and the arrival ledger are the round's own and belong with it. The
 * shared thing is the DECISION — when to fire, what the twin sends, what a cap composes to — and that is what
 * "used by both" means here.
 */
import { LLM_HEDGES_PER_ROUND, LLM_HEDGE_AFTER } from '../../core/limits.js';
import { linkedAbort } from '../../core/abort.js';
import type { EngineMode } from '../../core/types.js';

// ---------------------------------------------------------------------------------------
// §3.2 — the hedge's vocabulary
// ---------------------------------------------------------------------------------------

/** `JEVCODE_HEDGE=on` arms the §3.2 hedge where the caller pinned nothing; `off` disables it where the caller armed it. */
export const HEDGE_ENV_FLAG = 'JEVCODE_HEDGE';

/** `JEVCODE_S2=on` arms the whole §3 generation path on the `jev-on` propose call; `off`, and absent, leave it alone. */
export const S2_ENV_FLAG = 'JEVCODE_S2';

/**
 * The sample index a hedge twin takes: its origin's index plus this offset. A twin is a full sample in every
 * ledger the round keeps — it takes its own hold, its own `samplesLeft`, its own heartbeat row and its own
 * arrival — so it needs an index of its own, and one that can be read back as "the twin of k" without a second
 * map in the accounting. `SAMPLES_PER_ROUND` is single digits, so nothing can collide with the offset.
 */
export const HEDGE_TWIN_OFFSET = 1000;

/** Is this sample index a hedge twin, and of whom? */
export function hedgeOriginOf(sample: number): number | null {
  return sample >= HEDGE_TWIN_OFFSET ? sample - HEDGE_TWIN_OFFSET : null;
}

/**
 * §3.2: how long a sample may produce NO FIRST BYTE before its twin is fired —
 * `clamp(2 × the running TTFB p50, 3 s, 8 s)`.
 *
 * The input is time to first byte, not latency: a sample that has started streaming is being served and a
 * second copy of it buys nothing, so the timer is cancelled the moment its first byte lands
 * (`GenerateOptions.onFirstByte`, §3.1). Before a run has any TTFB at all the threshold is the CEILING, not
 * the floor: the first round of a run is also the round whose provider connection is coldest, and hedging it
 * at 3 s would double the spend of every run's first round on no evidence.
 */
export function hedgeAfterMs(ttfbP50Ms: number | null): number {
  if (ttfbP50Ms === null) return LLM_HEDGE_AFTER.maxMs;
  return Math.min(LLM_HEDGE_AFTER.maxMs, Math.max(LLM_HEDGE_AFTER.minMs, Math.round(LLM_HEDGE_AFTER.factor * ttfbP50Ms)));
}

/**
 * §3.2: the provider order a hedge twin sends — the caller's order rotated by one, so the upstream that is
 * currently silent (or rate-limiting) is the twin's LAST choice instead of its first. An order of fewer than
 * two entries cannot rotate: the twin then sends the caller's order unchanged and is a pure latency race.
 */
export function rotatedProviderOrder(order: readonly string[]): readonly string[] {
  if (order.length < 2) return order;
  return [...order.slice(1), ...order.slice(0, 1)];
}

/** §3.2: what one leg sends as its upstream order — the caller's, rotated for the twin. Empty stays empty. */
export function providerOrderFor(order: readonly string[], twin: boolean): readonly string[] {
  return twin ? rotatedProviderOrder(order) : order;
}

/** Is the §3.2 hedge armed? The caller's pin wins; `JEVCODE_HEDGE` decides when it pinned nothing; off is the default (§0.3's rule for a new mechanism). */
export function hedgeEnabled(pinned: boolean | undefined, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (pinned !== undefined) return pinned;
  return (env[HEDGE_ENV_FLAG] ?? '').trim().toLowerCase() === 'on';
}

// ---------------------------------------------------------------------------------------
// §3.4 — the reasoning cap, composed
// ---------------------------------------------------------------------------------------

/** The per-run cap the samples ask for once the serving provider is slow: `reasoning: {maxTokens}` (GLM bills its reasoning, §4.13). */
export const LLM_REASONING_CAP_TOKENS = 512;

/**
 * contract 1.9 (Fastlane) §3.4: the CHEAP classes (quixbugs, ladder — everything that is not `repository`) cap
 * their reasoning from the first round, not only after the provider has been measured slow.
 *
 * Why only the cheap classes, and why smaller than `LLM_REASONING_CAP_TOKENS`. A QuixBugs or ladder fix is a
 * one-line edit in a function the prompt already shows whole; the measured `reasoning_tokens` on those samples
 * is the bulk of their output and it buys nothing that the sieve's own test run does not buy. A repository task
 * is the opposite — the model is reasoning about where the bug is — so it keeps the reactive
 * 512-token cap. Off by default (`LlmSourceDeps.reasoningCapCheap`): it changes what every cheap sample asks
 * for, so it is a bench arm's choice, not a silent one.
 */
export const LLM_REASONING_CAP_CHEAP_TOKENS = 256;

/**
 * §3.4: the two caps compose by taking the SMALLER — the reactive one is evidence that the provider is slow,
 * the cheap-class one is a standing judgement about what the class needs, and neither may raise what the other
 * already lowered. `null` on both sides means the caller's pinned `reasoning` is sent unchanged.
 */
export function reasoningCapTokens(reactive: number | null, cheap: number | null): number | null {
  if (reactive === null) return cheap;
  return cheap === null ? reactive : Math.min(reactive, cheap);
}

// ---------------------------------------------------------------------------------------
// §3 — the switch
// ---------------------------------------------------------------------------------------

/**
 * contract 1.9 (Fastlane) §0.3 / §3: is the S2 generation path on for this run, and in full?
 *
 *   `'off'`     — every other mode, and `jev-on` without the switch. The propose call is the pre-1.9 call, byte
 *                 for byte: the legacy prefix order, no TTFB callback, no twin, no `StepRecord.verify`.
 *   `'on'`      — the prefix is pinned, TTFB is measured, the cache shares are recorded AND the §3.2 hedge is
 *                 armed.
 *   `'partial'` — the measurement half runs and the hedge does not, because `JEVCODE_HEDGE=off` turned it off
 *                 explicitly. A bench row that reads `partial` is telling the truth about an arm whose hedge
 *                 counters will be 0 for a reason other than "no sample was ever slow enough".
 *
 * `jev-on` first and unconditionally, exactly like `routersOn`: no env var may turn a control arm's generation
 * path into the treatment's. Default OFF (§0.3's rule for a new mechanism), which is what keeps
 * `test/unit/loop/router-golden.test.ts` and every `view: 'legacy'` prompt golden valid without a re-capture.
 */
export function s2Mode(mode: EngineMode, opt?: 'on' | 'off', env: Readonly<Record<string, string | undefined>> = process.env): 'on' | 'partial' | 'off' {
  if (mode !== 'jev-on') return 'off';
  if (!s2Enabled(opt, env)) return 'off';
  return (env[HEDGE_ENV_FLAG] ?? '').trim().toLowerCase() === 'off' ? 'partial' : 'on';
}

/**
 * F25's recorded gap, closed (review defect A5): **the explicit option wins; `JEVCODE_S2` only fills an ABSENT
 * option** — the same polarity `routersEnabled` and `resolveFastPathOption` were inverted to by the §7.5 seam,
 * and for the same reason. Without an option the bench could not pin S2 per arm at all: `armMechanisms` recorded
 * `s2: true` for `jev-on-next` while nothing set the variable (so the arm ran S2 OFF), and an exported
 * `JEVCODE_S2=on` armed the whole generation path on the plain `jev-on` CONTROL arm while `summary.json` recorded
 * `mechanisms.s2: false` — contamination in the direction that makes the wave look better, unobservably.
 * `MECHANISM_ENV_VARS` clears the variable as the belt; this is the option that makes the arm's row true.
 */
/**
 * Which engine modes HONOUR a pinned `EngineOptions.s2` — asked of the resolver above rather than kept as a second
 * list, because a second list is how the finishing pass's two slots came to name opposite modes.
 *
 * F05 (`src/bench/conditions.ts armMechanisms`) clamps an arm's pinned `s2` to `'off'` unless the arm's mode can
 * run it, and it was written when `ArmMechanisms.s2` had no reader at all: its clamp named `'llm-jev'`, the
 * synthesizer sample path where the §3 mechanisms first lived. F25 then built the reader HERE, on `jev-on`, and
 * `llm-jev` is fed by `LlmSourceDeps` — nothing threads `EngineOptions.s2` into the synthesizer — so the two
 * statements were exact opposites. This function is the single answer; `s2Mode` decides it and everything else
 * asks. The `{}` environment is deliberate: reachability is a property of the build, never of a shell.
 */
export function s2ReachableOn(mode: EngineMode): boolean {
  return s2Mode(mode, 'on', {}) !== 'off';
}

export function s2Enabled(opt?: 'on' | 'off', env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (opt !== undefined) return opt === 'on';
  return (env[S2_ENV_FLAG] ?? '').trim().toLowerCase() === 'on';
}

// ---------------------------------------------------------------------------------------
// §3.2 — the race, for a caller that has ONE call and no sample ledger
// ---------------------------------------------------------------------------------------

/** One leg of a hedged call. The origin is `sample: 0`; the twin is `HEDGE_TWIN_OFFSET`, which `hedgeOriginOf` reads back. */
export interface HedgeLeg {
  readonly sample: number;
  readonly twin: boolean;
  /** aborted when this leg loses the race, with an `Error` naming the hedge */
  readonly signal: AbortSignal;
  /** §3.1: call it with this leg's time to first byte; it cancels the hedge timer and feeds the run's p50 */
  onFirstByte(ms: number): void;
}

export interface HedgedCallInput<R> {
  /** run one leg; it must honour `leg.signal` and report `leg.onFirstByte` */
  run(leg: HedgeLeg): Promise<R>;
  /** the run's running TTFB p50, or null before there is enough of it to act on */
  p50TtfbMs(): number | null;
  /** arm the hedge; `undefined` leaves it to `JEVCODE_HEDGE` (default off) */
  hedge?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  /** the caller's signal: both legs are linked to it and neither outlives it */
  signal?: AbortSignal;
  /** one line per hedge event, for the transcript */
  onHedge?(text: string): void;
}

export interface HedgedCallResult<R> {
  result: R;
  /** twins fired (0 or `LLM_HEDGES_PER_ROUND`) */
  hedges: number;
  /** twins that answered before their origin — what the hedge actually bought */
  hedgeWins: number;
  wonBy: 'origin' | 'twin';
}

/**
 * §3.2 for a single call: fire the origin, and if it has produced NO FIRST BYTE for `hedgeAfterMs(p50)`, fire
 * one twin of it on the rotated upstream order. The first leg to SETTLE WITH A RESULT wins and the other is
 * aborted with `hedge` in its reason; the caller books the loser exactly as it books any cancelled call, so a
 * hedge makes the step faster and never free.
 *
 * Failure semantics, deliberately narrow: this races the SAME request twice, so a leg that rejects is not the
 * call's answer while the other leg is still live. The origin's error stands only if both rejected (or if no
 * twin was ever fired), which is what keeps a hedged call at least as reliable as an unhedged one and never
 * turns a retryable provider error into a step failure it would not have been.
 */
export async function hedgedCall<R>(input: HedgedCallInput<R>): Promise<HedgedCallResult<R>> {
  const armed = hedgeEnabled(input.hedge, input.env ?? process.env);
  const link = linkedAbort(input.signal ?? new AbortController().signal);
  const controllers = new Map<number, AbortController>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstByteSeen = false;
  let hedges = 0;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  type Settled = { sample: number; ok: true; result: R } | { sample: number; ok: false; error: unknown };
  /**
   * Review defect A1: a leg is identified by its `sample`, and it leaves `live` when the loop has OBSERVED its
   * event — never when it has merely settled. The two are not the same drain: `Promise.race` hands back one
   * event per turn, so a twin that resolved in the same microtask drain as the origin's rejection is settled
   * and unobserved at the moment the origin's rejection is consumed. Filtering on "settled" dropped it, left
   * `live` empty and threw the origin's error over a result that was already in hand — the exact opposite of
   * this module's "a hedged call is never less reliable than an unhedged one".
   */
  interface Tracked {
    readonly sample: number;
    readonly p: Promise<Settled>;
  }

  const start = (sample: number): Tracked => {
    const twin = sample !== 0;
    const legLink = linkedAbort(link.controller.signal);
    controllers.set(sample, legLink.controller);
    const leg: HedgeLeg = {
      sample,
      twin,
      signal: legLink.controller.signal,
      onFirstByte: () => {
        // §3.2: a stream that has started is being served, and a second copy of it buys nothing
        if (!twin) firstByteSeen = true;
        clearTimer();
      },
    };
    const raw = input
      .run(leg)
      .then(
        (result): Settled => ({ sample, ok: true, result }),
        (error: unknown): Settled => ({ sample, ok: false, error }),
      )
      .finally(() => legLink.unlink());
    return { sample, p: raw };
  };

  // The timer is a RACER, not a side effect: a twin started while the race is already awaiting would otherwise
  // not be in it, and a run whose origin never settles would hang on a leg nobody is watching.
  let openGate: (() => void) | null = null;
  const gate: Promise<'twin'> | null = armed
    ? new Promise<'twin'>((resolve) => {
        openGate = () => resolve('twin');
      })
    : null;
  const afterMs = Math.max(0, hedgeAfterMs(input.p50TtfbMs()));
  if (armed) {
    timer = setTimeout(() => {
      timer = null;
      if (firstByteSeen || hedges >= LLM_HEDGES_PER_ROUND || link.controller.signal.aborted) return;
      openGate?.();
    }, afterMs);
    // a hedge must never be the reason a process stays alive: the call owns the timer, the event loop does not
    timer.unref?.();
  }

  let live: Tracked[] = [start(0)];
  let waiting: Promise<'twin'> | null = gate;
  let originError: unknown = null;
  let lastError: unknown = null;
  try {
    for (;;) {
      const racers: Promise<Settled | 'twin'>[] = live.map((t) => t.p);
      if (waiting !== null) racers.push(waiting);
      if (racers.length === 0) break;
      const ev = await Promise.race(racers);
      if (ev === 'twin') {
        waiting = null;
        hedges += 1;
        input.onHedge?.(`the propose call produced no first byte in ${afterMs} ms — one hedge twin fired on the rotated provider order; the loser is cancelled at the first result`);
        live.push(start(HEDGE_TWIN_OFFSET));
        continue;
      }
      // A1: only the leg whose event was just consumed leaves the race. The other leg's `t.p` may already be
      // settled — the next `Promise.race` then picks it up in the very next turn, which is how a twin that
      // answered beside its origin's failure becomes the call's answer instead of being discarded with it.
      live = live.filter((t) => t.sample !== ev.sample);
      if (ev.ok) {
        clearTimer();
        const wonBy = ev.sample === 0 ? 'origin' : 'twin';
        if (wonBy === 'twin') input.onHedge?.('the hedge twin answered first; the original was cancelled (hedge), metered from what it streamed');
        controllers.get(ev.sample === 0 ? HEDGE_TWIN_OFFSET : 0)?.abort(new Error(`hedge: sample ${ev.sample} answered first`));
        return { result: ev.result, hedges, hedgeWins: wonBy === 'twin' ? 1 : 0, wonBy };
      }
      lastError = ev.error;
      if (ev.sample === 0) originError = ev.error;
      // a leg that rejected while the other is still live is not the call's answer; wait for the other one. With
      // nothing left in flight the call failed exactly as an unhedged one would, and the ORIGIN's error is the
      // one that travels (it is the error a caller without a hedge would have seen).
      if (live.length === 0) break;
    }
    clearTimer();
    throw originError ?? lastError ?? new Error('hedgedCall: no leg produced a result');
  } finally {
    clearTimer();
    link.unlink();
  }
}
