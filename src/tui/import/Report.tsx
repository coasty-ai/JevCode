/**
 * The import overlay's Ink component (TUI-DESIGN-5 §5.2, §5.7 F-56; IMPORT-DESIGN §5.2). It draws exactly the rows
 * `importLines` builds — the same rows `--plain` prints and `annotateBlock` logs (§13.1) — inside a fixed-height,
 * overflow-hidden box, boxed as a rounded card in the console tier and flat below it, the convention every other
 * overlay kind already follows.
 *
 * The component holds **no state and makes no decision**: the reducer (`./reducer.ts`) owns the selection and
 * `importLines` owns every string, so a frame test and a `--plain` test read the same function.
 */
import { Box, Text } from 'ink';
import { cardBottom, cardRow, cardTop } from '../card.js';
import { GLYPHS, truncateCells, type GlyphSet } from '../glyphs.js';
import { CAP } from '../layout.js';
import { textProps, themeFor, type ColorOn, type Theme } from '../theme.js';
import { importRendered } from './lines.js';
import type { ImportUiInput, ImportUiState } from './reducer.js';

/** TUI-DESIGN-2 §12 "Cards": the boxed tier's title for the import overlay. */
export const CARD_TITLE_IMPORT = 'import';

/** The card title for a state — `import` while planning and choosing, `import · applying` while phase 4 runs. */
export function importCardTitle(state: ImportUiState, g: GlyphSet = GLYPHS.unicode): string {
  if (state.step === 'scanning') return `${CARD_TITLE_IMPORT} ${g.dot} scanning`;
  if (state.step === 'applying') return `${CARD_TITLE_IMPORT} ${g.dot} applying`;
  if (state.step === 'review') return `${CARD_TITLE_IMPORT} ${g.dot} review`;
  return CARD_TITLE_IMPORT;
}

export interface ImportReportProps {
  state: ImportUiState;
  input: ImportUiInput;
  /** rows granted (`layout.overlay`) */
  rows: number;
  columns: number;
  glyphs?: GlyphSet;
  theme?: Theme;
  color?: ColorOn;
  /** TUI-DESIGN-2 §4.1: `chrome === 3` draws the rounded card */
  boxed?: boolean;
}

/** §5.2: the overlay. Never taller than `rows`; never a row wider than `columns`. */
export function ImportReport(p: ImportReportProps): React.JSX.Element | null {
  const g = p.glyphs ?? GLYPHS.unicode;
  const theme = p.theme ?? themeFor('dark');
  const color = p.color ?? true;
  const rows = Math.max(0, Math.floor(p.rows));
  if (rows === 0) return null;
  const boxed = p.boxed === true && rows >= 3;
  const inner = boxed ? Math.max(1, p.columns - 4) : p.columns;
  // §5.8 / finding 3: the component renders INSIDE the budget it was granted rather than slicing a longer block —
  // `importRendered` protects the keys / hint row and turns the overflow into one `… +N more rows` footer. The
  // slice that follows is belt and braces (a `kv` row that wraps cannot push the tail out of the frame).
  const budget = boxed ? Math.max(0, rows - CAP.card) : rows;
  const body = importRendered(p.state, p.input, inner, g, budget).slice(0, budget);
  const edges = textProps(theme, 'border', color);
  if (!boxed) {
    return (
      <Box flexDirection="column" height={rows} overflow="hidden">
        {body.map((r, i) => (
          <Text key={`i${i}`} wrap="truncate" {...(r.role === null ? {} : textProps(theme, r.role === 'added' || r.role === 'removed' || r.role === 'hunk' || r.role === 'diffMeta' ? 'dim' : r.role, color))}>
            {truncateCells(r.text, p.columns, g)}
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      <Text wrap="truncate" {...edges}>
        {cardTop(importCardTitle(p.state, g), p.columns, g)}
      </Text>
      {body.map((r, i) => (
        <Text key={`i${i}`} wrap="truncate" {...(r.role === null ? {} : textProps(theme, r.role === 'added' || r.role === 'removed' || r.role === 'hunk' || r.role === 'diffMeta' ? 'dim' : r.role, color))}>
          {cardRow(r.text, p.columns, g)}
        </Text>
      ))}
      <Text wrap="truncate" {...edges}>
        {cardBottom(p.columns, g)}
      </Text>
    </Box>
  );
}
