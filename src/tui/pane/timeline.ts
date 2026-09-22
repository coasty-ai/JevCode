/**
 * The `t` tab (TUI-DESIGN §7.2 "timeline"): two rows per step at 80 columns, newest first —
 * `time  s7  intent .21s  ctx .24s  propose 6.1s  risk .23s  exec 1.2s  judge .19s` /
 * `      s7  ICPPPPRXXXJ…  total 8.2s  h 31ms` (letters D I C P R X J sized round(ms/total·40); `D` = the
 * orchestration `decompose` stage, present only when a step ran it — ORCHESTRATION-DESIGN §3, §8.3) — and
 * one row per step at ≥ 120 columns with 30 letters plus `gen 5.4k $0.032`. Pure; every row ≤ `columns`.
 */
import type { StageName } from '../../core/types.js';
import { formatDuration } from '../../core/time.js';
import { kTokens, usd } from '../plain.js';
import { GLYPHS, padEndCells, stepLabelCells, truncateCells, type GlyphSet } from '../glyphs.js';
import type { PaneState, TimelineStep } from './model.js';

/** The empty timeline tab (no `stage:end` yet this run). */
export const NO_TIMELINE_YET = '(no timeline yet)';

/**
 * The stages the strip does NOT letter, by design: `replan` (a decision that costs no stage time worth a letter) and
 * `complete` (the step is over). With `TIMELINE_STAGES` these partition `StageName` exactly — test/unit/core/contract-stages.test.ts
 * asserts it, so a stage added to the engine without a row here fails CI instead of silently vanishing from the strip.
 */
export const TIMELINE_EXCLUDED_STAGES: readonly StageName[] = ['replan', 'complete'];

/** The seven lettered stages of the strip, in loop order (§7.2 "letters I C P R X J" plus `D` for `decompose`). */
export const TIMELINE_STAGES: readonly { stage: StageName; letter: string; short: string }[] = [
  { stage: 'decompose', letter: 'D', short: 'decomp' },
  { stage: 'intent', letter: 'I', short: 'intent' },
  { stage: 'context', letter: 'C', short: 'ctx' },
  { stage: 'propose', letter: 'P', short: 'propose' },
  { stage: 'risk', letter: 'R', short: 'risk' },
  { stage: 'execute', letter: 'X', short: 'exec' },
  { stage: 'judge', letter: 'J', short: 'judge' },
];

/** `.21s` below one second, `6.1s` below ten, `41s` below a minute, then `formatDuration`; every rounding that would carry (995 ms → `1.0s`, 9,950 ms → `10s`) moves to the next form, so the width never grows. */
export function secs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?s';
  if (ms < 995) return `.${String(Math.round(ms / 10)).padStart(2, '0')}s`;
  if (ms < 9_950) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 59_500) return `${Math.round(ms / 1000)}s`;
  return formatDuration(ms);
}

/** The step's total for the letter strip: the committed `totalMs`, else the sum of the stage timings so far. */
export function timelineTotal(s: TimelineStep): number {
  if (s.totalMs !== null && s.totalMs > 0) return s.totalMs;
  let sum = 0;
  for (const v of Object.values(s.stages)) sum += v ?? 0;
  return sum;
}

/** TUI-DESIGN §7.2: the letter strip, each stage `round(ms/total·width)` letters (a stage that took time gets at least one letter; a 0 ms stage gets none), cut to `width`. */
export function letterStrip(s: TimelineStep, width: number): string {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return '';
  const total = timelineTotal(s);
  if (total <= 0) return '';
  let out = '';
  for (const { stage, letter } of TIMELINE_STAGES) {
    const ms = s.stages[stage];
    if (ms === undefined || !(ms > 0)) continue;
    const cells = Math.max(1, Math.round((ms / total) * w));
    out += letter.repeat(cells);
  }
  return out.length > w ? out.slice(0, w) : out;
}

function stageList(s: TimelineStep): string {
  return TIMELINE_STAGES.filter(({ stage }) => s.stages[stage] !== undefined)
    .map(({ stage, short }) => `${short} ${secs(s.stages[stage] ?? 0)}`)
    .join('  ');
}

function compactStageList(s: TimelineStep): string {
  return TIMELINE_STAGES.filter(({ stage }) => s.stages[stage] !== undefined)
    .map(({ stage, letter }) => `${letter}${secs(s.stages[stage] ?? 0).replace(/s$/, '')}`)
    .join(' ');
}

function totals(s: TimelineStep): string {
  const total = timelineTotal(s);
  const h = s.harnessMs !== null ? `  h ${formatDuration(s.harnessMs)}` : '';
  return `total ${secs(total)}${h}`;
}

/** TUI-DESIGN §7.2 / §24 `t` rows for one step at 80 columns: `time  s7  intent .21s  ctx .24s …` and `      s7  ICPP…  total 8.2s  h 31ms` (40 letters); `stepCells` is the `sN` width shared by the rows shown (2 up to s9, 3 from s10). */
export function timelineStepRows80(s: TimelineStep, columns: number, g: GlyphSet, stepCells = stepLabelCells([s.step])): string[] {
  const label = padEndCells(`s${s.step}`, stepCells);
  const first = `time  ${label}  ${stageList(s)}`;
  const second = `${' '.repeat(6)}${label}  ${letterStrip(s, 40)}  ${totals(s)}`;
  return [truncateCells(first, columns, g), truncateCells(second, columns, g)];
}

/** TUI-DESIGN §7.2 `t` row for one step at ≥ 120 columns: 30 letters, totals, `gen 5.4k $0.032`, and the compact stage timings `I.21 C.24 P6.1 …` (the design's one-row form with the full stage list is 148 cells and does not fit in 120 — reported for §22). */
export function timelineStepRow120(s: TimelineStep, columns: number, g: GlyphSet, stepCells = stepLabelCells([s.step])): string {
  const label = padEndCells(`s${s.step}`, stepCells);
  const gen = s.generatorTokens !== null && s.generatorTokens > 0 ? `  gen ${kTokens(s.generatorTokens)} ${usd(s.generatorUsd ?? 0)}` : '';
  const line = `time  ${label}  ${padEndCells(letterStrip(s, 30), 30)}  ${totals(s)}${gen}  ${compactStageList(s)}`;
  return truncateCells(line.trimEnd(), columns, g);
}

/** TUI-DESIGN §7.2 `t` tab `lines(state, rows, columns)`: newest step first; two rows per step at < 120 columns, one at ≥ 120; `(no timeline yet)` when empty. */
export function timelineRows(state: PaneState, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  const n = Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  if (n === 0 || columns <= 0) return [];
  if (state.timeline.length === 0) return [truncateCells(NO_TIMELINE_YET, columns, g)];
  const steps = [...state.timeline].sort((a, b) => b.step - a.step);
  const perStep = columns >= 120 ? 1 : 2;
  const shown = steps.slice(0, Math.ceil(n / perStep));
  const stepCells = stepLabelCells(shown.map((s) => s.step));
  const out: string[] = [];
  for (const s of shown) {
    if (out.length >= n) break;
    if (columns >= 120) out.push(timelineStepRow120(s, columns, g, stepCells));
    else out.push(...timelineStepRows80(s, columns, g, stepCells));
  }
  return out.slice(0, n);
}
