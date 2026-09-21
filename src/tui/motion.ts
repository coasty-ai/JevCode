/**
 * Motion over Ink's shared animation timer (TUI-DESIGN-2 §5.1, §5.3): `useMotion(active, durationMs)` reads the
 * elapsed time from `useAnimation({ interval: SPLASH_INTERVAL_MS })` — all animated components share one timer inside
 * Ink, coalesced by its render throttle — and reports `settled` once `time ≥ durationMs`. The subscriber deactivates
 * itself at `durationMs`, so nothing ticks after the splash (the App's settle effect dispatches `splash:done` in the
 * same commit, never the 1 Hz `tick`). The third module of `src/tui/**` allowed to drive time (with `spinner.ts` and
 * `retry.ts`; §14.2's grep test lists `useAnimation(` here).
 */
import { useRef } from 'react';
import { useAnimation } from 'ink';
import { SPLASH_INTERVAL_MS } from './splash.js';

export interface Motion {
  /** elapsed ms since the animation started (0 while inactive) */
  time: number;
  /** `time ≥ durationMs` — true in the commit where the splash settles and afterwards */
  settled: boolean;
}

/** TUI-DESIGN-2 §5.1: elapsed time from Ink's timer while `active`; the subscriber stops itself once `durationMs` is reached. */
export function useMotion(active: boolean, durationMs: number, intervalMs: number = SPLASH_INTERVAL_MS): Motion {
  const stoppedRef = useRef(false);
  const { time } = useAnimation({ interval: intervalMs, isActive: active && !stoppedRef.current });
  const settled = active && time >= durationMs;
  if (settled) stoppedRef.current = true;
  if (!active) stoppedRef.current = false;
  return { time: active ? time : 0, settled: active && (settled || stoppedRef.current) };
}
