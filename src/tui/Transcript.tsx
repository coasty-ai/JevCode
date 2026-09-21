/**
 * Committed transcript rows in `<Static>` (TUI-DESIGN §15.1, §14.1 A28, §13.4, DESIGN §10; TUI-DESIGN-2 §4.5): Ink
 * writes each item once and never re-lays it out, so the array is append-only and every row is keyed by the item's
 * immutable key. Every row is `formatTranscriptItem(item)` — label + one space + text — drawn as a dim label box and
 * a `flexGrow` body box, so a wrapped row hangs under the text column (the identity predicate of TUI-DESIGN-2 §9: in
 * `full` the TUI rows equal the item word-wrapped with a hanging indent of `label.length + 1`; `compact` receives the
 * declared subsequence through `visibleItems`). Decoration that never changes text: a spacer row above a `[you]` turn,
 * above the first `[jevcode]` item of a turn and above `[run] start` / `[run] end`; the `you` role on `[you]` bodies;
 * fence lines (`/^```\w*$/`) drawn as `╶──── <lang>` / `╶────` in the `code` role — the only text substitution beyond
 * `--ascii`. A multi-line `detail` body prints under its line, dimmed. Colours come from the theme (`/theme` changes
 * new items only, R4); the `epoch` key remounts `<Static>` with a fresh array past the 20,000-item soft cap (the header
 * is printed with epoch 0 only). Every item renders inside its own `PaneBoundary` (§13.4). The component is memoised:
 * a hidden-only batch changes no prop, so it dirties no `<Static>` subtree (§4.5).
 */
import { memo, useMemo, type ComponentProps } from 'react';
import { Box, Static, Text } from 'ink';
import { PaneBoundary, paneFailedLine, type PaneFailure } from './PaneBoundary.js';
import { formatTranscriptItem, stepLabel, type TranscriptItem } from './plain.js';
import { itemRole, textProps, themeFor, type ColorOn, type ColorRole, type Theme } from './theme.js';
import { GLYPHS, glyphTwin, type GlyphSet } from './glyphs.js';

/** The former `itemColor` rule, now theme-driven (kept as a named export for the tests). */
export function itemColor(item: TranscriptItem, theme: Theme = themeFor('dark'), enabled: ColorOn = true): { color?: string; dimColor?: boolean; bold?: boolean } {
  const role = itemRole(item);
  return role === null ? {} : textProps(theme, role, enabled);
}

/** The pane name of the per-item boundary (`JEVCODE_FAULT=render:static` throws once inside one item). */
export const STATIC_ITEM_PANE = 'static';

/** TUI-DESIGN-2 §4.5 / §9: the only text substitution beyond `--ascii` — a line that is exactly a code fence. */
export const FENCE_RE = /^```(\w*)$/;

export interface TranscriptProps {
  items: readonly TranscriptItem[];
  /** rendered once at the top of the scrollback (the task / session header, present from the first frame) */
  header?: TranscriptItem;
  theme?: Theme;
  /** colour on/off or the depth (`colorDepth()`); markers stay either way */
  color?: ColorOn;
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
  /**
   * The commit width (TUI-DESIGN-2 §3.10 / §9 identity predicate: rows are the item word-wrapped at the commit width with a
   * hanging indent of `label.length + 1`). Ink's `<Static>` box is `position: absolute` with no width, so Yoga sizes it
   * fit-content and never shrinks its flex items: without an exact width the body wraps at the full width and the row
   * overflows the terminal by the label (`[sandbox] …` measured 89 cells at 80 columns). Each item box is laid out at
   * exactly this width, so the body wraps at `columns − label − 1`.
   */
  columns?: number;
  /**
   * The App's `keySeq` (useEngine.tsx `UiState.keySeq`, TUI-DESIGN-2 §9 D-F): every key re-renders this memoised
   * component and hands `<Static>` a fresh `style` object, so Ink commits the key's frame on its immediate path
   * (`isStaticDirty` → `onImmediateRender`) instead of the 34 ms throttle's trailing edge. Nothing else re-renders it.
   */
  keySeq?: number;
}

/** `<Static>`'s `style` prop type (a fresh object per key; the content never changes). */
type StaticStyle = NonNullable<ComponentProps<typeof Static>['style']>;

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

/** TUI-DESIGN-2 §4.5: the label of a row — `item.label` (`[ui]`, `[you]`, `[jevcode]`, …) or `stepLabel(step)`. */
export function itemLabel(item: TranscriptItem): string {
  return item.label ?? stepLabel(item.step);
}

/** TUI-DESIGN-2 §4.5 / §9: a fence line becomes `╶──── <lang>` / `╶────`; anything else is returned unchanged. */
export function fenceRow(text: string, g: GlyphSet = GLYPHS.unicode): { text: string; fence: boolean } {
  const m = FENCE_RE.exec(text);
  if (m === null) return { text, fence: false };
  const lang = m[1] ?? '';
  return { text: `${g.fence}${g.rule.repeat(4)}${lang === '' ? '' : ` ${lang}`}`, fence: true };
}

/** TUI-DESIGN-2 §4.5: a spacer row above a `[you]` turn, above the first `[jevcode]` item of a turn and above `[run] start` / `[run] end`. */
export function spacerAbove(item: TranscriptItem, prev: TranscriptItem | null): boolean {
  if (prev === null) return false;
  if (item.label === '[you]') return true;
  if (item.label === '[jevcode]') return prev.label !== '[jevcode]';
  return item.kind === 'run:start' || item.kind === 'run:end';
}

/** the role of the body text: `you` for `[you]`, the item role otherwise (`dim` rows dim label and body alike) */
function bodyRole(item: TranscriptItem): ColorRole | null {
  return itemRole(item);
}

function TranscriptRow({ item, prev, theme, color, glyphs, columns }: { item: TranscriptItem; prev: TranscriptItem | null; theme: Theme; color: ColorOn; glyphs: GlyphSet; columns: number | undefined }): React.JSX.Element {
  const label = glyphTwin(itemLabel(item), glyphs);
  const fence = fenceRow(item.text, glyphs);
  const body = fence.fence ? fence.text : glyphTwin(item.text, glyphs);
  const role = bodyRole(item);
  const bodyProps = fence.fence ? textProps(theme, 'code', color) : role === null ? {} : textProps(theme, role, color);
  // a dim row (a `[ui]` note, a stage line) dims its label too; every other label is the dim marker beside a coloured or plain body
  const labelProps = textProps(theme, 'dim', color);
  const { detail } = itemLines(item, glyphs);
  return (
    <Box flexDirection="column" marginTop={spacerAbove(item, prev) ? 1 : 0} {...(columns !== undefined && columns > 0 ? { width: columns } : {})}>
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text {...labelProps}>{label}</Text>
        </Box>
        <Box flexGrow={1} marginLeft={1}>
          <Text {...bodyProps}>{body}</Text>
        </Box>
      </Box>
      {detail.map((d, i) => (
        <Text key={`${item.key}:d${i}`} {...textProps(theme, 'dim', color)}>
          {d}
        </Text>
      ))}
    </Box>
  );
}

function TranscriptImpl({ items, header, theme = themeFor('dark'), color = true, glyphs = GLYPHS.unicode, epoch = 0, onFail, fault, log, columns, keySeq = 0 }: TranscriptProps): React.JSX.Element {
  // a new (empty) style object per key → Ink's reconciler runs `commitUpdate` on the <Static> box → immediate render
  const staticStyle = useMemo<StaticStyle>(() => ({}), [keySeq]);
  // Prepending keeps the array append-only from <Static>'s point of view: index 0 never changes. After a soft-cap
  // remount (epoch > 0) the header is already in the scrollback and is never printed again.
  const all = useMemo(() => (header && epoch === 0 ? [header, ...items] : [...items]), [header, items, epoch]);
  return (
    <Static key={`static-${epoch}`} items={all} style={staticStyle}>
      {(item, index) => (
        // `render:static` targets the first item only: every item of one pass renders before any boundary's
        // componentDidCatch marks the fault as fired, so a fault on all of them would degrade the whole pass
        <PaneBoundary key={item.key} pane={STATIC_ITEM_PANE} fault={index === 0 ? fault : undefined} {...(onFail ? { onFail } : {})} {...(log !== undefined ? { log } : {})} fallback={(f) => <Text color="red" wrap="truncate">{itemFailedRow(f.error.name, log)}</Text>}>
          <TranscriptRow item={item} prev={index > 0 ? (all[index - 1] ?? null) : null} theme={theme} color={color} glyphs={glyphs} columns={columns} />
        </PaneBoundary>
      )}
    </Static>
  );
}

/** TUI-DESIGN-2 §4.5: memoised so a hidden-only batch (same `visibleItems` array) re-renders nothing under `<Static>`. */
export const Transcript = memo(TranscriptImpl);
