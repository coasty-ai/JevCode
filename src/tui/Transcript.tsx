/**
 * Committed transcript rows in `<Static>` (TUI-DESIGN §15.1, §14.1 A28, §13.4, DESIGN §10; TUI-DESIGN-2 §4.5; TUI-DESIGN-3 §5.1):
 * Ink writes each item once and never re-lays it out, so the array is append-only and every row is keyed by the item's
 * immutable key. Every item's **text** is still `formatTranscriptItem(item)` — label + one space + text; only spaces and
 * line breaks are added around it:
 *
 * - **the label gutter** (D-L, rule 1): a fixed 10-cell right-aligned label column — `[jevcode]` / `[sandbox]` sit flush, shorter
 *   labels are padded on the left, `[step 100]` touches the edge and longer labels push the body by the excess — so every body
 *   starts at column 10 (`LABEL_GUTTER`) and wrapped rows hang there;
 * - **the wrap** (rule 3): the body is pre-split by `wrapBody` (segment-aware at ` · `, the no-orphan rule) into one `<Text>` per
 *   row, which also removes Ink's trailing-space artefacts;
 * - **detail rows** (rule 4, TUI-only): indented under the body column; a `label  value` table row (`/^\S+\s{2,}/`, the epilogue)
 *   hangs its wrap under the value;
 * - **spacers** (rule 9): one blank row above a `[you]` turn, above the first `[jevcode]` of a turn, above `[run] start` / `end`
 *   and above a `[ui]` item that carries a detail body;
 * - **colour** (D-O, rule 2): the label is the speaker (`[jevcode]` `assistant`, `[you]` `you`, both bold; every other label `dim`),
 *   the body is the meaning (default for chat, steps, `[ui]` notes and detail rows; `warn` / `error` by level or verdict; `dim` only
 *   for `[run] git …`); fence lines (`/^```\w*$/`) draw as `╶──── <lang>` in the `code` role — the only text substitution beyond `--ascii`.
 *
 * Identity (§5.3): strip each row's leading spaces, join with one space, collapse space runs → `formatTranscriptItem(item)`
 * (`normaliseRows`). Colours come from the theme (`/theme` changes new items only, R4); the `epoch` key remounts `<Static>` with
 * a fresh array past the 20,000-item soft cap (the header is printed with epoch 0 only). Every item renders inside its own
 * `PaneBoundary` (§13.4). The component is memoised: a hidden-only batch changes no prop, so it dirties no `<Static>` subtree
 * (§4.5); the App's `keySeq` hands `<Static>` a fresh `style` per key so a key's frame takes Ink's immediate path (TD2 D-F).
 */
import { memo, useMemo, type ComponentProps } from 'react';
import { Box, Static, Text } from 'ink';
import { PaneBoundary, paneFailedLine, type PaneFailure } from './PaneBoundary.js';
import { stringWidth } from './composer/width.js';
import { formatTranscriptItem, stepLabel, type TranscriptItem } from './plain.js';
import { itemRole, labelRole, textProps, themeFor, type ColorOn, type ColorRole, type Theme } from './theme.js';
import { GLYPHS, glyphTwin, type GlyphSet } from './glyphs.js';
import { joinWrapped, wrapBody } from './transcript/wrap.js';

/** The former `itemColor` rule, now theme-driven (kept as a named export for the tests). */
export function itemColor(item: TranscriptItem, theme: Theme = themeFor('dark'), enabled: ColorOn = true): { color?: string; dimColor?: boolean; bold?: boolean } {
  const role = itemRole(item);
  return role === null ? {} : textProps(theme, role, enabled);
}

/** The pane name of the per-item boundary (`JEVCODE_FAULT=render:static` throws once inside one item). */
export const STATIC_ITEM_PANE = 'static';

/** TUI-DESIGN-2 §4.5 / §9: the only text substitution beyond `--ascii` — a line that is exactly a code fence. */
export const FENCE_RE = /^```(\w*)$/;

/** TUI-DESIGN-3 §5.1 rule 1 (D-L): bodies start at this column; labels are right-aligned in the `LABEL_GUTTER − 1` cells before the space. */
export const LABEL_GUTTER = 10;

/** TUI-DESIGN-3 §5.1 rule 4: a detail row shaped like the epilogue's `label     value` table hangs its wrap under the value. */
export const DETAIL_TABLE_RE = /^(\S+\s{2,})/;

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
   * The commit width (TUI-DESIGN-2 §3.10 / §9; TUI-DESIGN-3 §5.1 rule 3): the body is pre-split at `columns − max(9, label) − 1`
   * cells by `wrapBody`, and each item box is laid out at exactly this width. Ink's `<Static>` box is `position: absolute` with no
   * width, so Yoga sizes it fit-content and never shrinks its flex items: without an exact width the body would wrap at the full
   * width and overflow the terminal by the gutter. Without `columns` (a test without geometry) the body is one `<Text>` Ink wraps.
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

/** TUI-DESIGN-3 §5.1 rule 1: the label right-aligned in the gutter — `[jevcode]` flush, `     [ui]` padded, `[step 100]` and longer as they are. */
export function gutterLabel(label: string): string {
  const pad = LABEL_GUTTER - 1 - stringWidth(label);
  return pad > 0 ? `${' '.repeat(pad)}${label}` : label;
}

/** TUI-DESIGN-3 §5.1 rule 1: the body's width at a commit width — `columns − max(9, label cells) − 1`. */
export function bodyWidth(columns: number, label: string): number {
  return Math.max(1, Math.floor(columns) - Math.max(LABEL_GUTTER - 1, stringWidth(label)) - 1);
}

/** TUI-DESIGN-3 §5.1 rule 3: the body's rows at a commit width (`wrapBody`); one row without geometry. */
export function bodyRows(text: string, columns: number | undefined, label: string, g: GlyphSet = GLYPHS.unicode): string[] {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return [text];
  return wrapBody(text, bodyWidth(columns, label), g);
}

/**
 * TUI-DESIGN-3 §5.1 rule 4: a detail line's rows at the body width — a `label     value` row (`DETAIL_TABLE_RE`) wraps its value
 * and hangs the continuations under the value column; any other line wraps like a body. One row without geometry.
 */
export function detailRows(line: string, width: number | undefined, g: GlyphSet = GLYPHS.unicode): string[] {
  if (width === undefined || !Number.isFinite(width) || width <= 0) return [line];
  const m = DETAIL_TABLE_RE.exec(line);
  if (m === null) return wrapBody(line, width, g);
  const head = m[1]!;
  const hang = stringWidth(head);
  const value = line.slice(head.length);
  if (hang >= width - 4) return wrapBody(line, width, g);
  const rows = wrapBody(value, width - hang, g);
  return rows.map((r, i) => (i === 0 ? `${head}${r}` : `${' '.repeat(hang)}${r}`));
}

/**
 * TUI-DESIGN-3 §5.3: the identity normaliser over a rendered item's rows (the label row and its hanging continuations; detail
 * rows excluded by the caller) — strip leading spaces, join with one space, collapse runs → `formatTranscriptItem(item)`.
 */
export function normaliseRows(rows: readonly string[]): string {
  return joinWrapped(rows);
}

/** TUI-DESIGN-2 §4.5 / §9: a fence line becomes `╶──── <lang>` / `╶────`; anything else is returned unchanged. */
export function fenceRow(text: string, g: GlyphSet = GLYPHS.unicode): { text: string; fence: boolean } {
  const m = FENCE_RE.exec(text);
  if (m === null) return { text, fence: false };
  const lang = m[1] ?? '';
  return { text: `${g.fence}${g.rule.repeat(4)}${lang === '' ? '' : ` ${lang}`}`, fence: true };
}

/**
 * TUI-DESIGN-2 §4.5 / TUI-DESIGN-3 §5.1 rule 9: a spacer row above a `[you]` turn, above the first `[jevcode]` item of a turn,
 * above `[run] start` / `[run] end`, and above a `[ui]` item that carries a detail body (`/jev`, `/cost`, the epilogue, `/help`).
 */
export function spacerAbove(item: TranscriptItem, prev: TranscriptItem | null): boolean {
  if (prev === null) return false;
  if (item.label === '[you]') return true;
  if (item.label === '[jevcode]') return prev.label !== '[jevcode]';
  if (item.label === '[ui]' && item.detail !== undefined && item.detail !== '') return true;
  return item.kind === 'run:start' || item.kind === 'run:end';
}

/**
 * TUI-DESIGN-3 §5.1 rule 2 (D-O): the body's role — the meaning, never the speaker. `warn` / `error` by level or verdict (the
 * theme's `itemRole`), `dim` only for the `[run] git …` workspace rows; chat bodies, steps, `[ui]` notes and proposals stay default.
 */
export function bodyRole(item: TranscriptItem): ColorRole | null {
  const role = itemRole(item);
  if (role === 'you' || role === 'assistant') return null;
  if (role === 'dim') return item.kind === 'workspace' ? 'dim' : null;
  return role;
}

/** TUI-DESIGN-3 §5.1 rule 2 (D-O): the label's props — the two chat labels in their pinks, bold; every other label dim. */
export function labelProps(item: TranscriptItem, theme: Theme, color: ColorOn): { color?: string; dimColor?: boolean; bold?: boolean } {
  const role = labelRole(item);
  const props = textProps(theme, role, color);
  return role === 'dim' || Object.keys(props).length === 0 ? props : { ...props, bold: true };
}

function TranscriptRow({ item, prev, theme, color, glyphs, columns }: { item: TranscriptItem; prev: TranscriptItem | null; theme: Theme; color: ColorOn; glyphs: GlyphSet; columns: number | undefined }): React.JSX.Element {
  const label = glyphTwin(itemLabel(item), glyphs);
  const fence = fenceRow(item.text, glyphs);
  const body = fence.fence ? fence.text : glyphTwin(item.text, glyphs);
  const role = bodyRole(item);
  const bodyProps = fence.fence ? textProps(theme, 'code', color) : role === null ? {} : textProps(theme, role, color);
  const lProps = labelProps(item, theme, color);
  const { detail } = itemLines(item, glyphs);
  const hasWidth = columns !== undefined && Number.isFinite(columns) && columns > 0;
  const rows = bodyRows(body, hasWidth ? columns : undefined, label, glyphs);
  const width = hasWidth ? bodyWidth(columns, label) : undefined;
  const indent = Math.max(LABEL_GUTTER - 1, stringWidth(label)) + 1;
  return (
    <Box flexDirection="column" marginTop={spacerAbove(item, prev) ? 1 : 0} {...(hasWidth ? { width: columns } : {})}>
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text {...lProps}>{gutterLabel(label)}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} marginLeft={1}>
          {hasWidth ? (
            rows.map((r, i) => (
              <Text key={`${item.key}:b${i}`} wrap="truncate" {...bodyProps}>
                {r}
              </Text>
            ))
          ) : (
            <Text {...bodyProps}>{body}</Text>
          )}
        </Box>
      </Box>
      {detail.flatMap((d, i) => detailRows(d, width, glyphs).map((r, k) => (
        <Box key={`${item.key}:d${i}.${k}`} marginLeft={indent}>
          <Text wrap="truncate">{r}</Text>
        </Box>
      )))}
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
