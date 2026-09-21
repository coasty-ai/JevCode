/**
 * Spinner rules (TUI-DESIGN §7.4 "Spinner", §6.2 A50, §14.2 reduced motion, F16): braille frames at 8 fps only
 * while a stage runs and no review is pending; `|/-\` under `--ascii`; a static `•` under reduced motion with a
 * 1 Hz functional tick (the wall clock still moves); `still waiting` after 45 s in one stage. This module and
 * `retry.ts` are the only two in `src/tui/**` allowed to call `setInterval` (§14.2's grep test).
 */
import { useEffect, useState } from 'react';
import type { ConfirmRequest, EngineStatus } from '../core/types.js';
import type { OverlayKind } from './layout.js';
import { GLYPHS, type GlyphSet } from './glyphs.js';
import { STILL_WAITING_MS } from './status/lines.js';

export { STILL_WAITING_MS };

/** 8 fps (§7.4). */
export const SPINNER_INTERVAL_MS = 125;
/** The functional tick under reduced motion (§14.2). */
export const REDUCED_MOTION_TICK_MS = 1000;
/** Braille frames, the Unicode set of `glyphs.ts` (kept from StatusLine.tsx). */
export const SPINNER_FRAMES: readonly string[] = GLYPHS.unicode.spinner;

/** The slice of `UiState` 1.1 the spinner rule reads. */
export interface SpinnerInput {
  readonly run: 'none' | 'starting' | 'live' | 'aborting' | 'pausing';
  readonly status: EngineStatus | null;
  readonly pendingReview: ConfirmRequest | null;
  readonly overlay: OverlayKind;
  readonly blocking: unknown | null;
}

/**
 * TUI-DESIGN §7.4 / §6.2 (A50): the spinner animates only while a run is live, a stage is running (the engine
 * reported one), no review is pending and no blocking pane is up. `starting` spins too (a stage is about to run).
 */
export function spinnerActive(s: SpinnerInput): boolean {
  if (s.run === 'none' || s.run === 'aborting') return false;
  if (s.pendingReview !== null || s.overlay === 'review') return false;
  if (s.blocking !== null || s.status?.blocked) return false;
  if (s.run === 'starting') return true;
  const stage = s.status?.stage ?? 'idle';
  return stage !== 'idle' && s.status?.stopReason == null;
}

/** The glyph for a frame: a braille frame (or `|/-\`), the static glyph under reduced motion. */
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
 */
export function useSpinner(active: boolean, reducedMotion = false): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const ms = reducedMotion ? REDUCED_MOTION_TICK_MS : SPINNER_INTERVAL_MS;
    const t = setInterval(() => setFrame((f) => (f + 1) % 100_000), ms);
    t.unref();
    return () => clearInterval(t);
  }, [active, reducedMotion]);
  return frame;
}
