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
import { paneLines, paneRuleRow, type PaneState } from './pane/model.js';
import { textProps, themeFor, type ColorRole, type Theme } from './theme.js';
import type { UiState } from './useEngine.js';

/** §14.1: the rule is capped at `min(columns, 400)` cells. */
export const RULE_MAX_CELLS = 400;

/** §7.2: `UiState` 1.1 → the pane builders' input. */
export function paneStateOf(s: UiState): PaneState {
  return { tab: s.tab, step: s.step, rows: s.rows, plan: s.plan, timeline: s.timeline, synth: s.synthView, mode: s.mode };
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
  color?: boolean;
}

/** §7.2: the pane box — `rows` truncating rows of the active tab (or the picker's rows). */
export function Pane(p: PaneProps): React.JSX.Element | null {
  const rows = Math.max(0, Math.floor(p.rows));
  if (rows === 0) return null;
  const g = p.glyphs ?? GLYPHS.unicode;
  const theme = p.theme ?? themeFor('dark');
  const color = p.color ?? true;
  const lines = (p.lines ?? paneLines(p.state, rows, p.columns, p.overlay, { terminalRows: p.terminalRows, glyphs: g })).slice(0, rows);
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
