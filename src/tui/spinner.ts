/**
 * Spinner rules (TUI-DESIGN §7.4 "Spinner", §6.2 A50, §14.2 reduced motion, F16; TUI-DESIGN-3 §5.2 A3, D-P): the
 * brand's shade pulse `░ ▒ ▓ █ ▓ ▒` at the existing 8 fps (a 750 ms cycle) only while a stage runs and no review is
 * pending; `. + # # + .` under `--ascii`; a static `◆` (`*`) under reduced motion with a 1 Hz functional tick (the wall
 * clock still moves); `still waiting` after 45 s in one stage. This module and `retry.ts` are the only two in
 * `src/tui/**` allowed to call `setInterval` (§14.2's grep test).
 */
import { useEffect, useRef, useState } from 'react';
import type { ConfirmRequest, EngineStatus } from '../core/types.js';
import type { OverlayKind } from './layout.js';
import { GLYPHS, type GlyphSet } from './glyphs.js';
import { STILL_WAITING_MS } from './status/lines.js';

export { STILL_WAITING_MS };

/** 8 fps (§7.4). */
export const SPINNER_INTERVAL_MS = 125;
/** The functional tick under reduced motion (§14.2). */
export const REDUCED_MOTION_TICK_MS = 1000;
/** TUI-DESIGN-3 §5.2 A3: the shade-pulse frames, the Unicode set of `glyphs.ts` (`░ ▒ ▓ █ ▓ ▒`). */
export const SPINNER_FRAMES: readonly string[] = GLYPHS.unicode.spinner;
/** TUI-DESIGN-3 §5.2 A3: the static glyph under reduced motion — `◆` (`*` under `--ascii`); the status spans colour it `accent` like a frame. */
export const SPINNER_STATIC: string = GLYPHS.unicode.spinnerStatic;

/** TUI-DESIGN-3 §5.2 A3: the static spinner glyph of a glyph set (`◆` / `*`) — the reduced-motion twin every status consumer draws. */
export function spinnerStatic(g: GlyphSet = GLYPHS.unicode): string {
  return g.spinnerStatic;
}

/** The slice of `UiState` 1.1 the spinner rule reads. */
export interface SpinnerInput {
  readonly run: 'none' | 'starting' | 'live' | 'aborting' | 'pausing';
  readonly status: EngineStatus | null;
  readonly pendingReview: ConfirmRequest | null;
  readonly overlay: OverlayKind;
  readonly blocking: unknown | null;
  /** TUI-DESIGN-2 §4.8: a submission is between Enter and its reply (`⠹ thinking` · `⠹ looking` · `⠹ replying`) */
  readonly thinking?: string | null;
}

/**
 * TUI-DESIGN §7.4 / §6.2 (A50): the spinner animates only while a run is live, a stage is running (the engine
 * reported one), no review is pending and no blocking pane is up. `starting` spins too (a stage is about to run).
 */
export function spinnerActive(s: SpinnerInput): boolean {
  if (s.thinking !== undefined && s.thinking !== null && s.run === 'none') return true;
  if (s.run === 'none' || s.run === 'aborting') return false;
  if (s.pendingReview !== null || s.overlay === 'review') return false;
  if (s.blocking !== null || s.status?.blocked) return false;
  if (s.run === 'starting') return true;
  const stage = s.status?.stage ?? 'idle';
  return stage !== 'idle' && s.status?.stopReason == null;
}

/** The glyph for a frame: a shade-pulse frame (or `. + # # + .`), the static glyph under reduced motion. */
export function spinnerGlyph(frame: number, g: GlyphSet = GLYPHS.unicode, reducedMotion = false): string {
  if (reducedMotion) return g.spinnerStatic;
  const frames = g.spinner;
  if (frames.length === 0) return g.spinnerStatic;
  const i = Number.isFinite(frame) ? Math.abs(Math.floor(frame)) % frames.length : 0;
  return frames[i] ?? g.spinnerStatic;
}

/** `still waiting` rule (§7.4): true once a stage has run for 45 s. */
export function stillWaiting(stageStartedAt: number | null, nowMs: number): boolean {
  return stageStartedAt !== null && Number.isFinite(nowMs) && nowMs - stageStartedAt >= STILL_WAITING_MS;
}

/** `1m02s`-style elapsed time of the current stage for the status line's 1 Hz redraw (§7.4). */
export function elapsedSeconds(stageStartedAt: number | null, nowMs: number): number {
  if (stageStartedAt === null || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.floor((nowMs - stageStartedAt) / 1000));
}

/**
 * The frame counter hook (§7.4, §14.2): 8 fps while `active` and motion is allowed, 1 Hz while `active` under
 * reduced motion (the tick is functional: the wall clock advances), no timer at all otherwise. `setInterval` is
 * allowed here and in `retry.ts` only.
 *
 * TUI map top change 4 — ONE clock while text flows: `flowing()` says a stream flush painted within the last tick. Then
 * the tick advances the frame WITHOUT a render of its own — the stream's flush frames (≤ `launch.fps`) carry the spinner,
 * the mini indicator and the caret forward — so a streaming frame and a tick frame never double the region's frame
 * rate. When the stream goes quiet the next tick renders as before.
 */
export function useSpinner(active: boolean, reducedMotion = false, flowing?: () => boolean): number {
  const [, render] = useState(0);
  const frame = useRef(0);
  const flowingRef = useRef(flowing);
  flowingRef.current = flowing;
  useEffect(() => {
    if (!active) return undefined;
    const ms = reducedMotion ? REDUCED_MOTION_TICK_MS : SPINNER_INTERVAL_MS;
    const t = setInterval(() => {
      frame.current = (frame.current + 1) % 100_000;
      if (flowingRef.current?.() === true) return;
      render((n) => (n + 1) % 100_000);
    }, ms);
    t.unref();
    return () => clearInterval(t);
  }, [active, reducedMotion]);
  return frame.current;
}
