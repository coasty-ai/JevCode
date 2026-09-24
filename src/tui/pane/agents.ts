/**
 * The `'a'` tab (TUI-DESIGN-5 §4.3, §4.11 F-54): the agent tree inside the pane slot.
 *
 * Every row string comes from `src/tui/agents/lines.ts` — this module owns the tab's **geometry** only (the
 * viewport, the keys row, the empty state), which is exactly §13.2 clause 6's declared difference between the
 * sinks: *the Ink tab's visible subset is a viewport, and the `--plain` twin's row count equals `rows.length`*.
 * A row is never hidden while the agent exists (§4.2): above `AGENTS_TAB_ROWS` the tab **scrolls**, it never
 * filters, and the scroll marker names how many rows are above and below.
 *
 * Pure: no Ink, no state, no I/O. `agentTabRows(state, rows, columns, g)` is the same shape every other tab has.
 */
import type { AgentRow } from '../../core/types.js';
import { AGENTS_EMPTY, AGENTS_KEYS_RUNGS, AGENTS_TAB_ROWS, agentCountCells, agentRowText, dockCell, tallyAgents } from '../agents/lines.js';
import { fitRungIn } from '../fit.js';
import { GLYPHS, cellWidth, glyphTwin, truncateCells, type GlyphSet } from '../glyphs.js';
import type { PaneState } from './model.js';

/** §4.11 F-54: the keys row is only reachable while the tab is FOCUSED (`Alt+A`); unfocused the letters are text. */
export function agentKeysRow(columns: number, g: GlyphSet = GLYPHS.unicode): string {
  return fitRungIn(AGENTS_KEYS_RUNGS, Math.max(0, Math.floor(Number.isFinite(columns) ? columns : 0)), g);
}

/** §4.2: the scroll marker above / below the viewport — the tab scrolls, it never filters. */
export function agentScrollRow(above: number, below: number, g: GlyphSet = GLYPHS.unicode): string {
  const parts: string[] = [];
  if (above > 0) parts.push(`${g.up}${above} above`);
  if (below > 0) parts.push(`${g.down}${below} below`);
  return parts.length === 0 ? '' : glyphTwin(`${g.ellipsis} ${parts.join(` ${g.dot} `)}`, g);
}

/**
 * §4.3 / §13.2 clause 6: the slice of `rows` a viewport of `want` rows shows around `cursor`. Never drops a row
 * silently — the caller draws `agentScrollRow(above, below)` whenever either is non-zero.
 */
export function agentViewport(total: number, want: number, cursor: number): { start: number; end: number; above: number; below: number } {
  const n = Math.max(0, Math.floor(total));
  const w = Math.max(1, Math.min(Math.floor(Number.isFinite(want) ? want : 1), Math.max(1, n)));
  if (n <= w) return { start: 0, end: n, above: 0, below: 0 };
  const c = Math.max(0, Math.min(n - 1, Math.floor(Number.isFinite(cursor) ? cursor : 0)));
  const start = Math.max(0, Math.min(n - w, c - Math.floor(w / 2)));
  const end = start + w;
  return { start, end, above: start, below: n - end };
}

/** what the tab needs beyond `PaneState.agents` — all optional, all absent in production until the supervisor exists. */
export interface AgentTabOptions {
  /** the highlighted row (the `Enter`/`p`/`t`/… verbs act on it); clamped into range */
  cursor?: number;
  /** draw the keys row (the tab is focused, §4.3) */
  focused?: boolean;
  /** `dock ✓` on the summary row; omitted, never zeroed, when unknown (§13.2 clause 5's rule) */
  dock?: boolean;
}

/**
 * §7.2's tab signature: the `'a'` tab's rows at a width. The row budget is spent **explicitly**, in this order,
 * because §13.2 clause 6 and §4.2 forbid the one thing a trailing `slice(0, n)` does — hiding a row with nothing
 * saying so:
 *
 * 1. the summary row (always; it names the total, so it is the row that keeps a one-row tab honest);
 * 2. the keys row (focused only, and the **first** thing dropped — it is a reminder, not information);
 * 3. the scroll marker, reserved whenever anything is off-screen;
 * 4. the viewport, which takes whatever is left.
 *
 * The invariant this buys, asserted in `pane/agents.test.ts` for every budget 2…20 and every row count:
 * `shown + above + below === rows.length`, and a marker is present whenever `shown < rows.length`. **n = 1** is the
 * one declared exception and it is not a filter: the single row is the summary, which names every agent
 * (`agents 6 · ● 1 ⏸2`) and claims to show none.
 */
export function agentTabRows(state: Pick<PaneState, 'agents' | 'paneFocus' | 'agentCursor'>, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode, opts: AgentTabOptions = {}): string[] {
  const n = Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  const w = Math.max(0, Math.floor(Number.isFinite(columns) ? columns : 0));
  if (n === 0 || w === 0) return [];
  const all: readonly AgentRow[] = state.agents ?? [];
  if (all.length === 0) return [truncateCells(AGENTS_EMPTY, w, g)];
  const cut = (l: string): string => truncateCells(l, w, g);
  const summary = agentSummaryRow(all, w, g, opts.dock);
  // 1. the summary always takes the first row: at n = 1 it is the whole tab, and it names the total
  const avail = n - 1;
  if (avail <= 0) return [cut(summary)];
  // 2. the keys row is the first thing dropped — below four rows the reminder costs a row of information
  const focused = opts.focused ?? state.paneFocus === true;
  const keys = focused && avail >= 3 ? agentKeysRow(w, g) : '';
  const body = avail - (keys === '' ? 0 : 1);
  // 3. the marker's row is RESERVED before the viewport is filled, whenever anything would be off-screen
  const fits = Math.min(AGENTS_TAB_ROWS, body);
  const want = all.length <= fits ? fits : Math.max(0, Math.min(AGENTS_TAB_ROWS, body - 1));
  const v = want === 0 ? { start: 0, end: 0, above: 0, below: all.length } : agentViewport(all.length, want, opts.cursor ?? state.agentCursor ?? 0);
  // 4. the viewport takes what is left
  const slugCells = all.reduce((m, r) => Math.max(m, cellWidth(r.slug)), 0);
  const shown = all.slice(v.start, v.end).map((r) => agentRowText(r, { width: w, g, slugCells }));
  const marker = agentScrollRow(v.above, v.below, g);
  const out = [summary, ...shown];
  if (marker !== '') out.push(marker);
  if (keys !== '') out.push(keys);
  return out.map(cut);
}

/**
 * §4.4 / F-54: the tab's own first row — **the same filtered tally the collapsed strip draws**, through the one
 * `agentCountCells`, so the two can never disagree. A zero count is omitted, never printed: the tab used to read
 * `agents 1 · ✓0 ● 1 ⏸0` beside a strip that read `agents 1 · ● 1`, and §13.2 clause 5 calls a zeroed cell a bug.
 */
export function agentSummaryRow(rows: readonly AgentRow[], columns: number, g: GlyphSet = GLYPHS.unicode, dock?: boolean): string {
  const t = tallyAgents(rows);
  const counts = agentCountCells(t, g);
  const d = dockCell(dock, g);
  const parts = [`agents ${t.total}`, ...(counts === '' ? [] : [counts]), ...(d === '' ? [] : [d])];
  return truncateCells(glyphTwin(parts.join(` ${g.dot} `), g), Math.max(0, Math.floor(columns)), g);
}
