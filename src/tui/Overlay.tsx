/**
 * The one modal slot (TUI-DESIGN §0 thesis, §2.1 D1, §3.3 S5 rows, §4.10, §5.3, §6, §9.3, §11.1, §12.4, §13.3,
 * §24 "Overlays"): review, wizard, follow-up confirm, secret gate row, blocking pane, palette, undo prompt, exit
 * confirm and the minimum-size notice all render here, directly above the composer, so at most one exists at a
 * time and `computeLayout` has a single allocation order to prove. Every kind is a fixed-height overflow-hidden
 * box of `wrap="truncate"` rows built by the shared `lines()` functions (O3/O4/O6/O7/O8) — the `--plain`,
 * `--screen-reader` and `--ascii` twins read the same functions. `overlayWant()` is the rows the kind asks the
 * layout for; the y-gated kinds are armed one frame after they are drawn (`overlayArmed`, §6.3) by `<App>`.
 */
import { Box, Text } from 'ink';
import type { CursorPosition } from 'ink';
import type { BlockingRequest, ConfirmRequest, SecretHit } from '../core/types.js';
import { blockingLines } from './blocking/lines.js';
import { paletteRows, type PaletteRow, type PaletteState } from './commands/palette.js';
import { CAP, type OverlayKind } from './layout.js';
import { GLYPHS, type GlyphSet, truncateCells } from './glyphs.js';
import { Review, previewWant, type ReviewNote } from './Review.js';
import { followupLines, type FollowupInput } from './review/lines.js';
import { gateLines } from './secrets/gate-lines.js';
import { textProps, themeFor, type Theme } from './theme.js';
import { Wizard, type OnboardingState } from './onboarding/Wizard.js';
import { wizardRows } from './onboarding/reducer.js';
import type { TrustInputs } from '../config/trust.js';

/** §24: the exit confirm row. */
export const EXIT_CONFIRM_ROW = 'a run is live: [y] abort and exit   [n] stay              (Enter does nothing)';
/** §24 / §2.1: the minimum-size notice. */
export function minsizeNotice(columns: number, rows: number, g: GlyphSet = GLYPHS.unicode): string {
  const times = g.mode === 'ascii' ? 'x' : '×';
  const dash = g.mode === 'ascii' ? '-' : '—';
  return `terminal ${columns}${times}${rows} is below the 40${times}8 minimum ${dash} panes hidden, transcript above`;
}

/** The per-kind data the overlay draws from (everything optional: the App passes what the kind needs). */
export interface OverlayData {
  review?: { req: ConfirmRequest; note: ReviewNote | null } | null;
  wizard?: { state: OnboardingState; trust: TrustInputs | null } | null;
  followup?: FollowupInput | null;
  secret?: { hits: readonly SecretHit[] } | null;
  blocking?: BlockingRequest | null;
  palette?: { query: string; state: PaletteState; selected: number } | null;
  undo?: { row: string } | null;
  /** the `mention` popup reuses the palette slot: rows are already built */
  mention?: { rows: readonly string[]; selected: number } | null;
}

/** §2.1 `LayoutInput.overlayWant`: review 8 · wizard 2–4 · followup 5 · secret 1 · blocking 2–4 · palette 2–8 · undo 1 · exitConfirm 1. */
export function overlayWant(kind: OverlayKind, data: OverlayData, terminalRows: number, columns: number): number {
  switch (kind) {
    case 'none':
      return 0;
    case 'review':
      return CAP.reviewHeader;
    case 'wizard':
      return data.wizard ? wizardRows(data.wizard.state, terminalRows) : 0;
    case 'followup':
      return CAP.followup;
    case 'secret':
      return CAP.secret;
    case 'blocking':
      return data.blocking ? Math.min(CAP.blocking, Math.max(2, blockingLines(data.blocking, CAP.blocking, columns).length)) : 0;
    case 'palette': {
      if (data.mention) return Math.min(CAP.palette, Math.max(2, data.mention.rows.length + 1));
      if (!data.palette) return 2;
      const rows = paletteRows(data.palette.query, data.palette.state, data.palette.selected, CAP.palette, columns);
      return Math.min(CAP.palette, Math.max(2, rows.length));
    }
    case 'undo':
      return CAP.undo;
    case 'exitConfirm':
      return CAP.exitConfirm;
  }
}

/** §2.1 `LayoutInput.previewWant`: review only. */
export function overlayPreviewWant(kind: OverlayKind, data: OverlayData): number {
  return kind === 'review' && data.review ? previewWant(data.review.req) : 0;
}

export interface OverlayProps {
  kind: OverlayKind;
  /** rows granted (`layout.overlay`); the minimum-size notice arrives as `degraded` */
  rows: number;
  /** review only: `layout.preview` */
  previewRows: number;
  columns: number;
  /** the terminal size (minsize notice, wizard rows) */
  terminalRows: number;
  /** the row the slot starts on inside the dynamic region (cursor placement) */
  top: number;
  data: OverlayData;
  degraded?: 'none' | 'minsize' | 'static-only';
  cursor?: (pos: CursorPosition | undefined) => void;
  glyphs?: GlyphSet;
  theme?: Theme;
  color?: boolean;
  screenReader?: boolean;
}

function Rows({ lines, rows, columns, glyphs, role, theme, color }: { lines: readonly string[]; rows: number; columns: number; glyphs: GlyphSet; role?: 'warn' | 'error' | 'secret' | 'dim' | 'accent' | null; theme: Theme; color: boolean }): React.JSX.Element {
  const shown = lines.slice(0, rows).map((l) => truncateCells(l, columns, glyphs));
  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {shown.map((l, i) => (
        <Text key={`o${i}`} wrap="truncate" {...(role ? textProps(theme, role, color) : {})}>
          {l}
        </Text>
      ))}
    </Box>
  );
}

/** §5.3: one palette row — `▌ /name   title   hint`, matched graphemes bold, unavailable rows dim, the footer dim. */
function PaletteRowText({ row, theme, color }: { row: PaletteRow; theme: Theme; color: boolean }): React.JSX.Element {
  if (row.kind === 'footer') return <Text wrap="truncate" {...textProps(theme, 'dim', color)}>{row.text}</Text>;
  if (row.spans.length === 0 || !color) return <Text wrap="truncate" {...(row.dim ? textProps(theme, 'dim', color) : row.selected ? { bold: true } : {})}>{row.text}</Text>;
  const parts: React.JSX.Element[] = [];
  let at = 0;
  const sorted = [...row.spans].sort((a, b) => a[0] - b[0]);
  sorted.forEach(([s, e], i) => {
    if (s > at) parts.push(<Text key={`t${i}`}>{row.text.slice(at, s)}</Text>);
    parts.push(
      <Text key={`b${i}`} bold>
        {row.text.slice(s, e)}
      </Text>,
    );
    at = e;
  });
  if (at < row.text.length) parts.push(<Text key="tail">{row.text.slice(at)}</Text>);
  return (
    <Text wrap="truncate" {...(row.dim ? textProps(theme, 'dim', color) : {})}>
      {parts}
    </Text>
  );
}

/** §0: the one modal slot. Renders nothing when `rows` is 0 and the terminal is not degraded. */
export function Overlay(p: OverlayProps): React.JSX.Element | null {
  const g = p.glyphs ?? GLYPHS.unicode;
  const theme = p.theme ?? themeFor('dark');
  const color = p.color ?? true;
  const rows = Math.max(0, Math.floor(p.rows));
  if (p.degraded === 'minsize') {
    if (rows === 0) return null;
    return <Rows lines={[minsizeNotice(p.columns, p.terminalRows, g)]} rows={rows} columns={p.columns} glyphs={g} role="warn" theme={theme} color={color} />;
  }
  if (rows === 0 && p.kind !== 'review') return null;
  switch (p.kind) {
    case 'none':
      return null;
    case 'review': {
      const d = p.data.review;
      if (!d) return null;
      return <Review req={d.req} rows={rows} previewRows={p.previewRows} columns={p.columns} top={p.top} note={d.note} {...(p.cursor ? { cursor: p.cursor } : {})} glyphs={g} theme={theme} color={color} />;
    }
    case 'wizard': {
      const d = p.data.wizard;
      if (!d) return null;
      return <Wizard state={d.state} rows={rows} columns={p.columns} top={p.top} {...(p.cursor ? { cursor: p.cursor } : {})} ascii={g.mode === 'ascii'} {...(p.screenReader !== undefined ? { screenReader: p.screenReader } : {})} trust={d.trust} theme={theme} color={color} />;
    }
    case 'followup': {
      const d = p.data.followup;
      if (!d) return null;
      return <Rows lines={followupLines(d, rows, p.columns, g)} rows={rows} columns={p.columns} glyphs={g} role="warn" theme={theme} color={color} />;
    }
    case 'secret': {
      const d = p.data.secret;
      if (!d) return null;
      return <Rows lines={gateLines(d.hits, p.columns)} rows={rows} columns={p.columns} glyphs={g} role="secret" theme={theme} color={color} />;
    }
    case 'blocking': {
      const d = p.data.blocking;
      if (!d) return null;
      return <Rows lines={blockingLines(d, rows, p.columns)} rows={rows} columns={p.columns} glyphs={g} role="error" theme={theme} color={color} />;
    }
    case 'palette': {
      const m = p.data.mention;
      if (m) {
        const marker = g.mode === 'ascii' ? '> ' : '▌ ';
        const body = m.rows.slice(0, Math.max(0, rows - 1)).map((r, i) => `${i === m.selected ? marker : '  '}${r}`);
        const footer = `(${m.rows.length === 0 ? 0 : Math.min(m.selected + 1, m.rows.length)}/${m.rows.length})  Tab completes ${g.dot} Enter inserts @path ${g.dot} Esc closes`;
        return <Rows lines={[...body, footer]} rows={rows} columns={p.columns} glyphs={g} theme={theme} color={color} />;
      }
      const d = p.data.palette;
      if (!d) return null;
      const list = paletteRows(d.query, d.state, d.selected, rows, p.columns, g.mode === 'ascii');
      return (
        <Box flexDirection="column" height={rows} overflow="hidden">
          {list.map((row, i) => (
            <PaletteRowText key={`p${i}`} row={row} theme={theme} color={color} />
          ))}
        </Box>
      );
    }
    case 'undo': {
      const d = p.data.undo;
      if (!d) return null;
      return <Rows lines={[d.row]} rows={rows} columns={p.columns} glyphs={g} role="warn" theme={theme} color={color} />;
    }
    case 'exitConfirm':
      return <Rows lines={[EXIT_CONFIRM_ROW]} rows={rows} columns={p.columns} glyphs={g} role="warn" theme={theme} color={color} />;
  }
}
