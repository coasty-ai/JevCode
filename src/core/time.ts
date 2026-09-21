import { ConfigError } from '../errors.js';

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "30m", "7h30m", "90s", "1500ms", "2h" (also a bare number = milliseconds). */
export function parseDuration(text: string, setting = 'duration'): number {
  const t = text.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let total = 0;
  let consumed = 0;
  for (const m of t.matchAll(re)) {
    total += Number(m[1]) * UNIT_MS[m[2]!]!;
    consumed += m[0].length;
  }
  if (consumed === 0 || consumed !== t.length || !Number.isFinite(total) || total <= 0) {
    throw new ConfigError(`${setting}: cannot parse "${text}" as a duration (use e.g. 30m, 7h30m, 90s)`, { setting });
  }
  return Math.round(total);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h${rm}m` : `${h}h`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Monotonic clock in ms (injectable via EngineOptions.now). */
export function monotonicNow(): number {
  return performance.now();
}

/** Injectable sleep shape shared by the Jev client and the provider transport (TUI-DESIGN §15 item 5; §15.2 `core/time.ts`). */
export type SleepFn = (ms: number, signal?: AbortSignal, wake?: AbortSignal) => Promise<void>;

/**
 * Node caps a timer delay at 2^31 − 1 ms (larger values fire after 1 ms with a warning). `sleep` clamps to it:
 * Infinity and anything above the cap wait the full cap (a caller asking for "until woken" must never fire early);
 * NaN, negatives and zero run on the next tick.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Sleep that rejects with `signal.reason` when aborted and resolves early when `wake` aborts
 * (TUI-DESIGN §13.2: `[r] retry now` aborts the engine-owned waker, one AbortController per sleep;
 * §15.2 `core/time.ts`). `signal` wins when both are already aborted. Every settle path clears the
 * timer and removes both listeners, so a settled sleep holds nothing and a later abort of either
 * signal is a no-op. The timer stays ref'd on purpose: during a retry backoff in a headless run
 * (bench, `--plain` on a pipe) it can be the only live handle, and an unref'd timer lets Node exit
 * mid-run (measured 2026-09-20: exit 13 "unsettled top-level await" after a refused connection).
 */
export function sleep(ms: number, signal?: AbortSignal, wake?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    if (wake?.aborted) {
      resolve();
      return;
    }
    // NaN > 0 is false → next tick; Infinity → the cap (see MAX_TIMER_MS)
    const delay = ms > 0 ? Math.min(ms, MAX_TIMER_MS) : 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (fn: () => void): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener('abort', onAbort);
      wake?.removeEventListener('abort', onWake);
      fn();
    };
    const onAbort = (): void => settle(() => reject(signal?.reason));
    const onWake = (): void => settle(resolve);
    timer = setTimeout(() => settle(resolve), delay);
    signal?.addEventListener('abort', onAbort, { once: true });
    wake?.addEventListener('abort', onWake, { once: true });
  });
}

/** Nearest-rank percentile over a sample; null on empty. */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[rank]!;
}
