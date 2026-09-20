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

/** Sleep that rejects with `signal.reason` when aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(t);
      reject(signal!.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Nearest-rank percentile over a sample; null on empty. */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[rank]!;
}
