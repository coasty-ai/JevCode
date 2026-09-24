/**
 * The `s` tab (TUI-DESIGN §7.2 "synth", §15.3): `synth  <phase>: <detail verbatim>` and
 * `candidates=… tested=…` when present — free text until the synth team's structured fields land
 * (A48, not in §15). Pure line builder; every row ≤ `columns`.
 */
import { GLYPHS, oneLineCells, truncateCells, type GlyphSet } from '../glyphs.js';
import type { PaneState, SynthView } from './model.js';

/** The empty synth tab (no `synth` event yet this step). */
export const NO_SYNTH_YET = '(no synth output yet)';

/** TUI-DESIGN §7.2: the `synth  <phase>: <detail>` row(s) of one event — a multi-line detail becomes one row per line, each verbatim. */
export function synthLines(view: SynthView): string[] {
  const detailLines = view.detail.replace(/\r\n|\r/g, '\n').split('\n').map(oneLineCells);
  const [first = '', ...rest] = detailLines;
  const out = [`synth  ${oneLineCells(view.phase)}: ${first}`.trimEnd(), ...rest.filter((l) => l.trim().length > 0).map((l) => `       ${l}`)];
  if (view.candidates !== undefined || view.tested !== undefined) {
    const parts: string[] = [];
    if (view.candidates !== undefined) parts.push(`candidates=${view.candidates}`);
    if (view.tested !== undefined) parts.push(`tested=${view.tested}`);
    out.push(`       ${parts.join(' ')}`);
  }
  return out;
}

/** TUI-DESIGN §7.2 `s` tab `lines(state, rows, columns)`: the last `synth` event's rows; `(no synth output yet)` when none. */
export function synthRows(state: PaneState, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  const n = Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  if (n === 0 || columns <= 0) return [];
  if (!state.synth) return [truncateCells(NO_SYNTH_YET, columns, g)];
  return synthLines(state.synth)
    .slice(0, n)
    .map((l) => truncateCells(l, columns, g));
}
