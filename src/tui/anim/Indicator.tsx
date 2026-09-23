/**
 * The interactive session's 3D indicator (TUI-DESIGN-3 §5.2 A3's motion slot, widened): the pure frame sets of
 * `frames.ts` mounted as Ink rows — a rotating donut while the session thinks, a spinning wireframe cube while a
 * command runs, a rotating globe while a model or Jev is called, a travelling wave while the work is weighed. Frames
 * are luminance-shaded into three theme roles (`dim` · `accent2` · `accent`, the top band bold), so the block reads as
 * lit geometry rather than a glyph soup, and plain text under `NO_COLOR`. Every frame set is computed lazily on first
 * use and memoised per (kind, width, height) — nothing is built at import or at startup — and the whole block is a
 * pure function of `tick`, so reduced motion is simply frame 0 and an idle session runs no timer at all.
 */
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { ANIM_FPS, LUMINANCE, animSize, indicatorFrames, type Frames, type IndicatorKind } from './frames.js';
import { startTicker } from '../retry.js';
import { runIsLive } from '../wordmark.js';
import { depthOf, textProps, type ColorOn, type ColorRole, type Theme } from '../theme.js';
import type { StageName } from '../../core/types.js';
import type { RunPhase } from '../useEngine.js';
import type { ThinkingPhase } from '../status/lines.js';

export type { IndicatorKind } from './frames.js';

/** Frames per cycle: 5 s of donut / cube / globe at 12 fps, 4 s of wave (its period is shorter). */
const FRAME_COUNT: Readonly<Record<IndicatorKind, number>> = { thinking: 60, running: 60, calling: 60, verifying: 48 };

/** The caption the mount may show under the block. */
export const INDICATOR_LABEL: Readonly<Record<IndicatorKind, string>> = {
  thinking: 'thinking',
  running: 'running',
  calling: 'calling Jev',
  verifying: 'verifying',
};

/** The tick interval of the block (12 fps). */
export const INDICATOR_TICK_MS = Math.round(1000 / ANIM_FPS);

/** Below this many terminal rows the block never renders (the status spinner carries the state instead). */
export const INDICATOR_MIN_ROWS = 16;

const CACHE = new Map<string, Frames>();

/** The memoised frame set for a kind at a cell size; computed on the first call for that key and never again. */
export function frameSet(kind: IndicatorKind, w: number, h: number): Frames {
  const key = `${kind}:${w}x${h}`;
  const hit = CACHE.get(key);
  if (hit !== undefined) return hit;
  const built = indicatorFrames(kind, w, h, FRAME_COUNT[kind]);
  CACHE.set(key, built);
  return built;
}

/** Live entries in the frame cache (tests; the App never calls it). */
export function frameCacheSize(): number {
  return CACHE.size;
}

/** Drop every memoised frame set (tests measuring a cold build). */
export function clearFrameCache(): void {
  CACHE.clear();
}

/** The three luminance bands: the dim tail of the ramp, the mid body, the highlights. */
function roleOf(ch: string): ColorRole | null {
  const i = LUMINANCE.indexOf(ch);
  if (i < 0) return null;
  return i <= 3 ? 'dim' : i <= 7 ? 'accent2' : 'accent';
}

interface Part {
  readonly text: string;
  readonly role: ColorRole | null;
}

/** A row split into coloured runs; blanks join the open run (a space carries no colour, and fewer nodes render faster). */
function parts(row: string): readonly Part[] {
  const out: Part[] = [];
  let role: ColorRole | null = null;
  let text = '';
  for (const ch of row) {
    const r: ColorRole | null = ch === ' ' ? role : roleOf(ch);
    if (text !== '' && r === role) text += ch;
    else {
      if (text !== '') out.push({ text, role });
      role = r;
      text = ch;
    }
  }
  if (text !== '') out.push({ text, role });
  return out;
}

export interface IndicatorProps {
  readonly kind: IndicatorKind;
  /** terminal columns (the block's size follows `animSize`) */
  readonly columns: number;
  /** terminal rows */
  readonly rows: number;
  /** the frame counter of `useIndicatorTick` */
  readonly tick: number;
  readonly theme: Theme;
  /** pins frame 0 (§14.2) */
  readonly reducedMotion: boolean;
  /** parity with the rest of the TUI: the frames are already ASCII, so nothing changes */
  readonly ascii: boolean;
  /** plain text, no ANSI */
  readonly noColor: boolean;
  /** the colour depth of `colorDepth()` when the mount has one; `true` (ANSI-16) otherwise */
  readonly color?: ColorOn;
  readonly marginLeft?: number;
}

/**
 * The block: `animSize(columns, rows).h` rows of exactly `w` cells, or nothing when the terminal is too small.
 * `frames[tick % n]`, frame 0 under reduced motion. The caller centres it (or passes `marginLeft`).
 */
export function Indicator(props: IndicatorProps): ReactElement | null {
  const size = animSize(props.columns, props.rows);
  if (size === null || props.rows < INDICATOR_MIN_ROWS) return null;
  const frames = frameSet(props.kind, size.w, size.h);
  const t = Number.isFinite(props.tick) ? Math.floor(props.tick) : 0;
  const i = props.reducedMotion ? 0 : ((t % frames.length) + frames.length) % frames.length;
  const frame = frames[i] ?? frames[0] ?? [];
  const on: ColorOn = props.noColor ? false : (props.color ?? true);
  const plain = depthOf(on) === 0;
  return (
    <Box flexDirection="column" {...(props.marginLeft !== undefined ? { marginLeft: props.marginLeft } : {})}>
      {frame.map((row, y) => (
        <Text key={`i${y}`} wrap="truncate">
          {plain
            ? row
            : parts(row).map((p, k) => (
                <Text key={`p${k}`} {...(p.role === null ? {} : { ...textProps(props.theme, p.role, on), ...(p.role === 'accent' ? { bold: true } : {}) })}>
                  {p.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}

/** The stages a model or Jev is being called in (`execute` runs the command, `judge` weighs the result). */
const CALLING_STAGES: ReadonlySet<string> = new Set<StageName>(['propose', 'intent', 'risk', 'replan', 'context', 'decompose', 'coordinate']);

/** The slice of `UiState` the kind is chosen from. */
export interface IndicatorInput {
  /** a submission between Enter and its reply (`intake` · `lookup` · `replying`) */
  readonly thinking: ThinkingPhase | null;
  readonly run: RunPhase;
  /** `EngineStatus.stage` (`'idle'` and `null` both mean "between stages") */
  readonly stage: StageName | 'idle' | null;
  /** a chat reply is streaming */
  readonly streaming: boolean;
}

/**
 * The indicator for a session state, or `null` when nothing is in flight. A submission in flight thinks; a live run
 * runs while the command runs (`execute`), verifies while the result is weighed (`judge` — the engine has no separate
 * verify stage: the tests run inside `execute` and their outcome is judged) and calls for every other stage.
 */
export function indicatorKindFor(i: IndicatorInput): IndicatorKind | null {
  if (i.thinking !== null) return 'thinking';
  if (i.run === 'starting') return 'thinking';
  if (runIsLive(i.run)) {
    if (i.stage === 'execute') return 'running';
    if (i.stage === 'judge') return 'verifying';
    if (i.stage !== null && CALLING_STAGES.has(i.stage)) return 'calling';
    return 'thinking';
  }
  return i.streaming ? 'thinking' : null;
}

/**
 * The frame counter: one unref'd 12 fps interval (`startTicker`, the module §14.2 allows a timer in) while the block
 * is up and motion is allowed; 0 and no timer at all otherwise, so an idle session writes no frames.
 */
export function useIndicatorTick(active: boolean, reducedMotion: boolean): number {
  const on = active && !reducedMotion;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    return startTicker(() => setTick((t) => (t + 1) % 100_000), INDICATOR_TICK_MS);
  }, [on]);
  return on ? tick : 0;
}
