/**
 * The one stream scheduler (TUI map top change 4; AGENT-LOOP-DESIGN §9.4): every streamed byte the TUI shows — generator
 * deltas, command output, the chat reply the controller hands `renderer.live()` — reaches React through one of these.
 *
 * - **Leading edge.** The first append after a quiet interval flushes synchronously, in the same tick it arrived, so the
 *   first token of a reply paints at once instead of waiting out a trailing timer (the 50 ms coalescer it replaces put
 *   37–58 ms between the first byte and its frame on the chat path, measured in the TUI map).
 * - **Fixed cadence.** Later appends coalesce into at most one flush per interval, measured from the LAST flush — never a
 *   timer re-armed by every append, which is what stretched today's frames to ~2× the interval under a steady stream.
 * - **Cadence.** `launch.fps` locally (33 ms at the default 30 fps), 67 ms over SSH (a 15 fps link budget), 250 ms under
 *   reduced motion — `streamIntervalMs`.
 * - **No clock when idle.** A timer exists only while an append is waiting for its flush; nothing ticks between streams,
 *   so the idle-frames gate is untouched. The timer is a `setTimeout` (§14.2 reserves `setInterval` for `spinner.ts` /
 *   `retry.ts`), unref'd so it never keeps the process alive.
 *
 * `flush(leading, quietMs)` tells the caller whether this flush is a leading edge and how long the stream was quiet. The
 * TUI stamps every flush: one that moved the streamed text bumps the paint sequence, which hands `<Static>` a fresh style
 * so Ink renders the frame on its immediate path (the same mechanism a keystroke uses, TUI-DESIGN-2 D-F) — this cadence
 * is then the stream's only throttle, never this one stacked on Ink's own 34 ms. While text flows the spinner's tick
 * renders nothing of its own (`useSpinner`'s `flowing`), so the two never add up past `launch.fps`.
 */

/** The cadence at the default 30 fps (`Math.round(1000 / 30)`). */
export const STREAM_LOCAL_MS = 33;
/** The cadence over SSH: a 15 fps budget, the SSH default of `launch.fps`. */
export const STREAM_SSH_MS = 67;
/** The cadence under reduced motion (§14.2): four flushes a second, the old reduced-motion coalescer's figure. */
export const STREAM_REDUCED_MS = 250;
/** Never flush faster than this, whatever `--fps` says (60 fps). */
export const STREAM_MIN_MS = 16;

/** The launch facts the cadence is chosen from. */
export interface StreamCadenceInput {
  readonly fps?: number;
  readonly ssh?: boolean;
  readonly reducedMotion?: boolean;
}

/** The flush interval for a launch: 250 ms under reduced motion, ≥ 67 ms over SSH, else `1000 / fps` (33 ms at 30 fps). */
export function streamIntervalMs(i: StreamCadenceInput): number {
  if (i.reducedMotion === true) return STREAM_REDUCED_MS;
  const fps = i.fps !== undefined && Number.isFinite(i.fps) && i.fps > 0 ? i.fps : 30;
  const local = Math.max(STREAM_MIN_MS, Math.round(1000 / fps));
  return i.ssh === true ? Math.max(STREAM_SSH_MS, local) : local;
}

/** The clock and timer the scheduler runs on (tests inject a fake one). */
export interface StreamClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** `performance.now()` and an unref'd `setTimeout`. */
export const REAL_STREAM_CLOCK: StreamClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface StreamScheduler {
  /** Something was appended: flush now when the stream was quiet for an interval, else once the interval since the last flush has passed. */
  poke(): void;
  /** Drop a pending flush without running it (unmount, a clear that dispatched its own state). */
  cancel(): void;
  /** A flush is waiting for its interval. */
  readonly pending: boolean;
  /** The cadence in ms. */
  readonly intervalMs: number;
}

/**
 * A leading-edge, fixed-cadence scheduler over `flush`. `flush(true, quietMs)` is a leading edge (the stream was quiet for
 * `quietMs`; `Infinity` for the very first flush), `flush(false, 0)` a cadence flush.
 */
export function createStreamScheduler(flush: (leading: boolean, quietMs: number) => void, intervalMs: number, clock: StreamClock = REAL_STREAM_CLOCK): StreamScheduler {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : STREAM_LOCAL_MS;
  let last = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  const run = (leading: boolean): void => {
    const t = clock.now();
    const quiet = leading ? t - last : 0;
    last = t;
    flush(leading, quiet);
  };
  const cancel = (): void => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  };
  return {
    poke() {
      if (timer !== null) return;
      const since = clock.now() - last;
      if (since >= interval) {
        run(true);
        return;
      }
      timer = clock.setTimeout(() => {
        timer = null;
        run(false);
      }, Math.max(0, interval - since));
    },
    cancel,
    get pending() {
      return timer !== null;
    },
    intervalMs: interval,
  };
}
