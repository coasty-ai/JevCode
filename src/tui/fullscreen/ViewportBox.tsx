/**
 * TUI-DESIGN-4 §1.3.3 — `<Viewport>`: the fullscreen renderer's scrolled transcript.
 *
 * **Filename deviation:** the design calls this file `Viewport.tsx`, beside the pure `viewport.ts`. macOS/APFS is
 * case-insensitive by default and TypeScript refuses two modules in one program whose paths differ only in case
 * (TS1149), so the component lives in `ViewportBox.tsx` — it *is* the fixed-height overflow-hidden Box — and the
 * exported name `Viewport` is unchanged. A **fixed-height,
 * `overflow: hidden`** Box of `<Text wrap="truncate">` rows, because §1.3.2 edge 5 makes the rendered height equal
 * the allocated height the load-bearing invariant of the whole renderer: a single wrapped row breaks it, and one row
 * of error costs a full-screen clear **per keystroke** (audit A1 §3.2 measured 37 clears for 36 frames).
 *
 * It renders a **slice** of `src/tui/fullscreen/viewport.ts`'s index — the same rows `<Transcript>` commits to
 * `<Static>`, built by the same builders. Colours are applied here, at render, from the item (edge 7: a `/theme`
 * never rebuilds the index), through the same `labelProps` / `bodyRole` rules round 3 gave the classic transcript.
 */
import { Box, Text } from 'ink';
import { GLYPHS } from '../glyphs.js';
import { memo } from 'react';
import { PaneBoundary, type PaneFailure } from '../PaneBoundary.js';
import { bodyRole } from '../Transcript.js';
import { textProps, themeFor, type ColorOn, type Theme } from '../theme.js';
import { earlierRowsAbove } from './viewport.js';
import { resolveTop, sliceRows, type Scroll, type ViewportIndex } from './viewport.js';

export interface ViewportProps {
  index: ViewportIndex;
  /** the rows `computeFullLayout` granted — the rendered height is exactly this, always */
  height: number;
  scroll: Scroll;
  theme?: Theme;
  color?: ColorOn;
  /** §1.3.3 edge 1 / §12: draw `▲ <n> earlier rows · PgUp` as the viewport's first row while the user is scrolled up */
  showAbove?: boolean;
  onFail?: (failure: PaneFailure) => void;
  fault?: string | undefined;
  log?: string;
}

/** The pane name of the viewport's boundary (`JEVCODE_FAULT=render:viewport` throws once inside it). */
export const VIEWPORT_PANE = 'viewport';

function ViewportImpl({ index, height, scroll, theme = themeFor('dark'), color = true, showAbove = false, onFail, fault, log }: ViewportProps): React.JSX.Element {
  const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
  const top = resolveTop(index, scroll, h);
  const rows = sliceRows(index, top, h);
  // the `▲ n earlier rows · PgUp` marker replaces the slice's first row, so the total never changes (§1.3.2 edge 5)
  const marker = showAbove && top > 0 && h > 0 ? earlierRowsAbove(top, index.ascii ? GLYPHS.ascii : GLYPHS.unicode) : null;
  return (
    <PaneBoundary pane={VIEWPORT_PANE} {...(onFail === undefined ? {} : { onFail })} fault={fault} {...(log === undefined ? {} : { log })}>
      <Box flexDirection="column" height={h} overflow="hidden">
        {Array.from({ length: h }, (_unused, i) => {
          const row = rows[i];
          if (marker !== null && i === 0)
            return (
              <Text key={`v${i}`} wrap="truncate" {...textProps(theme, 'dim', color)}>
                {marker}
              </Text>
            );
          if (row === undefined || row.spacer || row.text === '') return <Text key={`v${i}`}> </Text>;
          const item = row.item >= 0 ? index.items[row.item] : undefined;
          const role = row.detail ? 'dim' : item === undefined ? null : bodyRole(item);
          return (
            <Text key={`v${i}`} wrap="truncate" {...(role === null ? {} : textProps(theme, role, color))}>
              {row.text}
            </Text>
          );
        })}
      </Box>
    </PaneBoundary>
  );
}

/** Memoised by value: a key frame re-renders the App, and the viewport's rows are unchanged unless the index, the anchor or the height moved. */
export const Viewport = memo(ViewportImpl);
