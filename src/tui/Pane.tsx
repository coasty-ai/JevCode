/**
 * The Jev-native pane (TUI-DESIGN §7.2, §24 "Rule row" / "Pane rows", F16, A44): tabs d/p/t/s over the pure
 * builders of `src/tui/pane/*` (`paneLines(state, rows, columns, overlay)`), `[`/`]` cycle (resolved in `<App>`),
 * the tab header on the rule row (`paneRuleRow`), side by side only under §7.2's rule, and the session / rewind
 * picker rendered in this slot (`lines` override). Every row is `<Text wrap="truncate">` inside a fixed-height
 * overflow-hidden box, so the §2 budget holds whatever the builders return.
 */
import { Box, Text } from 'ink';
import type { OverlayKind } from './layout.js';
import { GLYPHS, type GlyphSet } from './glyphs.js';
import { panelLines, panelStrip, paneLines, paneRuleRow, type PaneState } from './pane/model.js';
import { brandRow, WORDMARK_MIN_COLUMNS } from './splash.js';
import { textProps, themeFor, type ColorOn, type ColorRole, type Theme } from './theme.js';
import type { PanelState, UiState } from './useEngine.js';

/** §14.1: the rule is capped at `min(columns, 400)` cells. */
export const RULE_MAX_CELLS = 400;

/** §7.2: `UiState` 1.1 → the pane builders' input (TUI-DESIGN-2 §3.11 / §4.6: the intakes' rows and the last risk assessment ride along). */
export function paneStateOf(s: UiState): PaneState {
  return { tab: s.tab, step: s.step, rows: s.rows, plan: s.plan, timeline: s.timeline, synth: s.synthView, mode: s.mode, chatRows: s.chatRows, lastRisk: s.lastRisk };
}

/** TUI-DESIGN-2 §4.6 / §5.4: everything the rule row depends on. */
export interface RuleRowInput {
  state: PaneState;
  /** the last Jev latencies (the strip's `jev <ms>ms` segment at ≥ 120) */
  latencies: readonly (number | null)[];
  /** rows granted to the pane slot (`layout.pane`) */
  paneRows: number;
  columns: number;
  overlay: OverlayKind;
  terminalRows: number;
  panel: PanelState;
  /** the splash is running (the pulsing brand row below 64 columns / while the mark has no rows) */
  splash: 'running' | 'done';
  /** elapsed splash ms (the brand glyph pulse) */
  splashTime: number | null;
  /** TUI-DESIGN-2 §5.4: `run:ready` has been seen (or a run ended) in this session — before it the brand row is the idle rule row */
  ranBefore: boolean;
  /**
   * TUI-DESIGN-3 §3.3: the wordmark has rows in the pane slot this frame (the splash's reveal or the resting mark) — the rule row is
   * the plain rule before the first `run:ready` and the strip afterwards (F-W5: the strip keeps its information, the mark sits under it).
   * Optional so the round-2 callers and fixtures keep compiling (false = today's rows).
   */
  wordmark?: boolean;
  version: string;
  glyphs?: GlyphSet;
  pickerHeader?: string | null;
}

/**
 * TUI-DESIGN-2 §4.6 / §5.3 / §5.4; TUI-DESIGN-3 §3.3: the rule row — the picker's header when the picker is open; the plain
 * rule while the wordmark rows sit above the console before the first `run:ready` (the reveal, then the resting mark);
 * the pulsing brand row while the splash runs without wordmark rows (below 64 columns); the open / full panel's tab header
 * with `▾ ` whenever the pane has rows (also before the first run: `]`, Alt+J or `/panel` on the idle frame open a headed
 * `(no decisions yet)` tab, never a headerless hole — §4.6's table, finding 4); else the brand row until the first
 * `run:ready`; then the collapsed panel's strip — with or without the mark under it (F-W5).
 */
export function ruleRowText(i: RuleRowInput): string {
  const g = i.glyphs ?? GLYPHS.unicode;
  const cols = Math.min(RULE_MAX_CELLS, Math.max(0, Math.floor(Number.isFinite(i.columns) ? i.columns : 0)));
  if (i.pickerHeader !== undefined && i.pickerHeader !== null) return i.pickerHeader;
  if (cols < 40) return plainRule(cols, g);
  const wordmark = i.wordmark === true || (i.splash === 'running' && cols >= WORDMARK_MIN_COLUMNS && i.paneRows > 0);
  if (wordmark && !i.ranBefore) return plainRule(cols, g);
  if (i.splash === 'running' && !wordmark) return brandRow(i.version, cols, i.splashTime, g);
  // the open (6-row) panel never goes side by side; `full` keeps TD §7.2's rule (columns ≥ 120 && rows ≥ 40 && overlay none)
  if (i.panel !== 'collapsed' && i.paneRows > 0) return paneRuleRow(i.state, i.paneRows, cols, i.overlay, { terminalRows: i.panel === 'full' ? i.terminalRows : 0, glyphs: g, chevron: true });
  if (!i.ranBefore) return brandRow(i.version, cols, null, g);
  return panelStrip({ ...i.state, latencies: i.latencies }, cols, g);
}

/** The plain rule (`─` × columns): before the first run, on tiny terminals, and whenever the pane has no rows. */
export function plainRule(columns: number, g: GlyphSet = GLYPHS.unicode): string {
  return g.rule.repeat(Math.max(0, Math.min(RULE_MAX_CELLS, Math.floor(Number.isFinite(columns) ? columns : 0))));
}

/**
 * §7.2 / §24: the rule row — the pane's tab header when the pane has rows (`─── decisions s7 … [d]ecisions …`),
 * else the plain rule; the picker's own header when the picker is open.
 */
export function paneRule(state: PaneState, paneRows: number, columns: number, overlay: OverlayKind, terminalRows: number, g: GlyphSet = GLYPHS.unicode, pickerHeader: string | null = null): string {
  const cols = Math.min(RULE_MAX_CELLS, Math.max(0, Math.floor(Number.isFinite(columns) ? columns : 0)));
  if (pickerHeader !== null) return pickerHeader;
  if (paneRows <= 0 || cols < 40) return plainRule(cols, g);
  return paneRuleRow(state, paneRows, cols, overlay, { terminalRows, glyphs: g });
}

/** The colour role of a pane row from the marker it carries (every colour is paired with the word, §14.1). */
export function paneRowRole(line: string): ColorRole | null {
  if (line.includes('[block]')) return 'block';
  if (line.includes('[review]')) return 'review';
  if (line.includes('[chosen]')) return 'chosen';
  if (line.startsWith('[!]')) return 'warn';
  if (line.startsWith('(no ')) return 'dim';
  if (/^\s+(…|\.\.\.) \d+ more row/.test(line)) return 'dim';
  return null;
}

export interface PaneProps {
  state: PaneState;
  /** rows granted (`layout.pane`) */
  rows: number;
  columns: number;
  overlay: OverlayKind;
  /** the terminal height (`useWindowSize().rows`) for the side-by-side rule */
  terminalRows: number;
  /** override rows (the picker renders in this slot, §8.4) */
  lines?: readonly string[] | null;
  /** the selected row of an override (picker) is highlighted */
  selected?: number | null;
  glyphs?: GlyphSet;
  theme?: Theme;
  color?: ColorOn;
  /** TUI-DESIGN-2 §4.6: `open` draws ≤ 6 rows with the `… n more rows` tail, `full` today's 12-row pane */
  size?: 'open' | 'full';
}

/** §7.2: the pane box — `rows` truncating rows of the active tab (or the picker's rows). */
export function Pane(p: PaneProps): React.JSX.Element | null {
  const rows = Math.max(0, Math.floor(p.rows));
  if (rows === 0) return null;
  const g = p.glyphs ?? GLYPHS.unicode;
  const theme = p.theme ?? themeFor('dark');
  const color = p.color ?? true;
  const built = p.size === undefined ? paneLines(p.state, rows, p.columns, p.overlay, { terminalRows: p.terminalRows, glyphs: g }) : panelLines(p.state, rows, p.columns, p.overlay, { terminalRows: p.terminalRows, glyphs: g, size: p.size });
  const lines = (p.lines ?? built).slice(0, rows);
  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {lines.map((line, i) => {
        const role = p.lines ? (p.selected === i ? 'accent' : null) : paneRowRole(line);
        return (
          <Text key={`r${i}`} wrap="truncate" {...(role ? textProps(theme, role, color) : {})} bold={p.lines !== undefined && p.lines !== null && p.selected === i}>
            {line}
          </Text>
        );
      })}
    </Box>
  );
}
