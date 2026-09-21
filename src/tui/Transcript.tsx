/**
 * Committed transcript rows in `<Static>` (TUI-DESIGN §15.1, §14.1 A28, §13.4, DESIGN §10): Ink writes each item once
 * and never re-lays it out, so the array is append-only and every row is keyed by the item's immutable key.
 * Rows are label-aware (`formatTranscriptItem` prints `item.label` — `[ui]`, `[setup]`, `[config]`, `[sandbox]` —
 * instead of `stepLabel()`), renderer-local items render like engine items (they are the same shape), and a
 * multi-line `detail` body prints under its line, dimmed. Colours come from the theme (`/theme` changes new
 * items only, R4); the `epoch` key remounts `<Static>` with a fresh array past the 20,000-item soft cap (the header
 * is printed with epoch 0 only, never again on a remount). Every item renders inside its own `PaneBoundary`
 * (§13.4: "the `<Static>` child renderer separately"), so one throwing item costs one fallback row and every later
 * item keeps flowing into the scrollback.
 */
import { useMemo } from 'react';
import { Box, Static, Text } from 'ink';
import { PaneBoundary, paneFailedLine, type PaneFailure } from './PaneBoundary.js';
import { formatTranscriptItem, type TranscriptItem } from './plain.js';
import { itemRole, textProps, themeFor, type Theme } from './theme.js';
import { GLYPHS, glyphTwin, type GlyphSet } from './glyphs.js';

/** The former `itemColor` rule, now theme-driven (kept as a named export for the tests). */
export function itemColor(item: TranscriptItem, theme: Theme = themeFor('dark'), enabled = true): { color?: string; dimColor?: boolean; bold?: boolean } {
  const role = itemRole(item);
  return role === null ? {} : textProps(theme, role, enabled);
}

/** The pane name of the per-item boundary (`JEVCODE_FAULT=render:static` throws once inside one item). */
export const STATIC_ITEM_PANE = 'static';

export interface TranscriptProps {
  items: readonly TranscriptItem[];
  /** rendered once at the top of the scrollback (the task / session header, present from the first frame) */
  header?: TranscriptItem;
  theme?: Theme;
  /** colour on/off (`colorEnabled()`); markers stay either way */
  color?: boolean;
  /** `--ascii`: glyph twins on code-generated text (items stay canonical in transcript.log) */
  glyphs?: GlyphSet;
  /** `<Static>` remount generation (A28) */
  epoch?: number;
  /** §13.4: one failing item → one fallback row, reported here (the App logs and appends the `[ui]` item) */
  onFail?: (failure: PaneFailure) => void;
  /** `JEVCODE_FAULT` (`render:static` throws once inside one item) */
  fault?: string | undefined;
  /** the log name in the fallback row (default `jevcode.log`) */
  log?: string;
}

/** One item's lines: the formatted line, then its detail body split on '\n' (TUI-only, §15.1). */
export function itemLines(item: TranscriptItem, g: GlyphSet = GLYPHS.unicode): { line: string; detail: string[] } {
  const line = glyphTwin(formatTranscriptItem(item), g);
  const detail = item.detail === undefined || item.detail === '' ? [] : item.detail.split('\n').map((l) => glyphTwin(l, g));
  return { line, detail };
}

/** §13.4: the one-row fallback for an item that threw while rendering. */
export function itemFailedRow(errorName: string, log?: string): string {
  return paneFailedLine(STATIC_ITEM_PANE, errorName, log);
}

function TranscriptRow({ item, theme, color, glyphs }: { item: TranscriptItem; theme: Theme; color: boolean; glyphs: GlyphSet }): React.JSX.Element {
  const { line, detail } = itemLines(item, glyphs);
  return (
    <Box flexDirection="column">
      <Text {...itemColor(item, theme, color)}>{line}</Text>
      {detail.map((d, i) => (
        <Text key={`${item.key}:d${i}`} {...textProps(theme, 'dim', color)}>
          {d}
        </Text>
      ))}
    </Box>
  );
}

export function Transcript({ items, header, theme = themeFor('dark'), color = true, glyphs = GLYPHS.unicode, epoch = 0, onFail, fault, log }: TranscriptProps): React.JSX.Element {
  // Prepending keeps the array append-only from <Static>'s point of view: index 0 never changes. After a soft-cap
  // remount (epoch > 0) the header is already in the scrollback and is never printed again.
  const all = useMemo(() => (header && epoch === 0 ? [header, ...items] : [...items]), [header, items, epoch]);
  return (
    <Static key={`static-${epoch}`} items={all}>
      {(item, index) => (
        // `render:static` targets the first item only: every item of one pass renders before any boundary's
        // componentDidCatch marks the fault as fired, so a fault on all of them would degrade the whole pass
        <PaneBoundary key={item.key} pane={STATIC_ITEM_PANE} fault={index === 0 ? fault : undefined} {...(onFail ? { onFail } : {})} {...(log !== undefined ? { log } : {})} fallback={(f) => <Text color="red" wrap="truncate">{itemFailedRow(f.error.name, log)}</Text>}>
          <TranscriptRow item={item} theme={theme} color={color} glyphs={glyphs} />
        </PaneBoundary>
      )}
    </Static>
  );
}
