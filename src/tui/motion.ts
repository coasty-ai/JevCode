/**
 * Motion over Ink's shared animation timer (TUI-DESIGN-2 §5.1, §5.3; TUI-DESIGN-3 §3.6): `useMotion(active, durationMs)`
 * reads the elapsed time from `useAnimation({ interval })` — all animated components share one timer inside Ink,
 * coalesced by its render throttle — and reports `settled` once `time ≥ durationMs`; the subscriber deactivates itself
 * at `durationMs`, so nothing ticks after the splash (the App's settle effect dispatches `splash:done` in the same
 * commit, never the 1 Hz `tick`). `useIdleLoop` is the wordmark's two-phase idle sweep (rest → pass, §3.6): active only
 * while the mark has rows, after the settle, with motion allowed and attention awake; the quiet-after-key rule is read
 * once at the rest → pass transition, so a key never cuts a pass short. The one module of `src/tui/**` allowed to call
 * `useAnimation(` (§14.2's grep test; the interval timers stay with `spinner.ts` / `retry.ts`).
 */
import { useRef, useState } from 'react';
import { useAnimation } from 'ink';
import { SPLASH_INTERVAL_MS } from './splash.js';
import { LOOP_ATTENTIVE_MS, LOOP_INTERVAL_MS, LOOP_PASS_TICKS, LOOP_QUIET_AFTER_KEY_MS, LOOP_REST_CALM_MS, LOOP_REST_MS, LOOP_SLEEP_MS, loopBand, type GridBand } from './wordmark.js';

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

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-3 §3.6: the idle loop
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN-3 §3.6: `< 60 s` since the last activity → attentive · `< 10 min` → calm · else asleep (no subscriber). */
export type Attention = 'attentive' | 'calm' | 'asleep';
export type LoopPhase = 'rest' | 'pass';

/** TUI-DESIGN-3 §3.6: the attention tier for the clock `nowMs` and `UiState.lastActivityAt` (a key, `run:end`, `panel`, a resize — never a reply). */
export function attentionAt(nowMs: number, lastActivityAt: number): Attention {
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastActivityAt)) return 'attentive';
  const idle = nowMs - lastActivityAt;
  if (idle < LOOP_ATTENTIVE_MS) return 'attentive';
  if (idle < LOOP_SLEEP_MS) return 'calm';
  return 'asleep';
}

export interface IdleLoopInput {
  /** `wordmarkWanted(...) && layout.pane > 0` — the mark has rows this frame */
  shown: boolean;
  /** `state.splash === 'running'` — the hook never activates before the settle */
  splashRunning: boolean;
  /** `setting === 'sweep' && !reducedMotion && depth > 0` */
  enabled: boolean;
  /** `'asleep'` deactivates */
  attention: Attention;
  /** `state.nowMs` (the 1 Hz tick's clock) */
  nowMs: number;
  /** `state.lastKeystrokeAt` (initial 0; set by `key`) */
  lastKeystrokeAt: number;
  /** test override of `LOOP_INTERVAL_MS` (the pass tick) */
  intervalMs?: number;
  /** test override of `LOOP_REST_MS` / `LOOP_REST_CALM_MS` (both) */
  restMs?: number;
  /** test override of `LOOP_QUIET_AFTER_KEY_MS` */
  quietMs?: number;
}

export interface IdleLoop {
  phase: LoopPhase;
  /** the pass tick (0 in every rest render) */
  k: number;
  /** the cells to colour `sweep` this frame — null in every rest render, whatever `frame` says (the wake glitch, §3.6) */
  band: GridBand | null;
}

/**
 * TUI-DESIGN-3 §3.6: a two-phase state machine over one `useAnimation` subscriber, not a predicate.
 *
 * `isActive = shown && !splashRunning && enabled && attention !== 'asleep'` — nothing about keys. While inactive the
 * subscriber count is 0 and no timer is alive; the phase resets to `rest`, so every activation starts with a rest.
 * **Rest:** the interval is `LOOP_REST_MS` (`LOOP_REST_CALM_MS` when calm); at the first rest tick the quiet rule is
 * evaluated once — `nowMs − lastKeystrokeAt ≥ LOOP_QUIET_AFTER_KEY_MS` → `pass` (the interval switches to
 * `LOOP_INTERVAL_MS`; Ink resets `frame` on an interval change, so `k` counts from 0); not quiet → the interval becomes
 * the quiet window itself and the rule is re-evaluated at the next tick (a rest is never shorter than the quiet window
 * and never longer than `restMs + quiet`). **Pass:** `k = frame`, `band = loopBand(k)`; at `k ≥ LOOP_PASS_TICKS − 1`
 * (the band cleared) the phase returns to `rest`. A key during a pass changes nothing — `lastKeystrokeAt` is read only at
 * the rest → pass transition — so the pass finishes rather than leaving a half-lit band. Phase changes are render-phase
 * state updates of this hook's own state (React re-runs the render at once with the new interval, before any commit), so
 * no frame is written for the transition itself and `band` is null in every rest render.
 */
export function useIdleLoop(i: IdleLoopInput): IdleLoop {
  const isActive = i.shown && !i.splashRunning && i.enabled && i.attention !== 'asleep';
  const passMs = i.intervalMs ?? LOOP_INTERVAL_MS;
  const quietMs = i.quietMs ?? LOOP_QUIET_AFTER_KEY_MS;
  const restMs = i.restMs ?? (i.attention === 'calm' ? LOOP_REST_CALM_MS : LOOP_REST_MS);
  const [phase, setPhase] = useState<LoopPhase>('rest');
  // the rest interval is the quiet window while the last rest tick found a recent key
  const [quietWait, setQuietWait] = useState(false);
  if (!isActive && (phase !== 'rest' || quietWait)) {
    // deactivated: every activation starts with a full rest (render-phase update of this hook's own state)
    setPhase('rest');
    setQuietWait(false);
  }
  const interval = phase === 'pass' ? passMs : quietWait ? quietMs : restMs;
  const { frame } = useAnimation({ interval, isActive });
  if (isActive && phase === 'rest' && frame >= 1) {
    // the rest tick: the quiet rule, evaluated at the transition only (§3.6)
    if (i.nowMs - i.lastKeystrokeAt >= quietMs) {
      setPhase('pass');
      if (quietWait) setQuietWait(false);
    } else if (!quietWait) setQuietWait(true);
  }
  if (isActive && phase === 'pass' && frame >= LOOP_PASS_TICKS - 1) setPhase('rest');
  if (!isActive || phase !== 'pass') return { phase: 'rest', k: 0, band: null };
  const k = Math.min(frame, LOOP_PASS_TICKS - 1);
  return { phase: 'pass', k, band: loopBand(k) };
}
