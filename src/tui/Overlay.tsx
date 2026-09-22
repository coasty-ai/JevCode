/**
 * The one modal slot (TUI-DESIGN §0 thesis, §2.1 D1, §3.3 S5 rows, §4.10, §5.3, §6, §9.3, §11.1, §12.4, §13.3,
 * §24 "Overlays"; TUI-DESIGN-2 §3.7, §4.7): review, wizard, follow-up confirm, secret gate row, blocking pane,
 * palette, undo prompt, exit confirm, the intake card and the minimum-size notice all render here, directly above
 * the composer, so at most one exists at a time and `computeLayout` has a single allocation order to prove. Every
 * kind is a fixed-height overflow-hidden box of `wrap="truncate"` rows built by the shared `lines()` functions (TUI-DESIGN-3 §5.2
 * A8–A9: the review card's `armed` flag rides through to `Review`; the palette's selected `▌` takes `accent2`) —
 * the `--plain`, `--screen-reader` and `--ascii` twins read the same functions. In the boxed tier (`chrome === 3`)
 * every kind but the wizard (hosted by the console) and the secret gate (a console row) is a rounded card from
 * `cardLines` — edge colours follow the card's meaning (review `review`/`block`, follow-up · undo · exit confirm ·
 * intake `warn`, blocking `error`, palette `border`); the flat tier draws today's rows. `overlayWant()` is the rows
 * the kind asks the layout for; the y-gated kinds are armed one frame after they are drawn (`overlayArmed`, §6.3).
 */
import { Box, Text } from 'ink';
import type { CursorPosition } from 'ink';
import type { BlockingRequest, ConfirmRequest, SecretHit } from '../core/types.js';
import { blockingLines } from './blocking/lines.js';
import { cardBottom, cardLines, cardRow, cardTop } from './card.js';
import { paletteRows, type PaletteRow, type PaletteState } from './commands/palette.js';
import { CAP, MIN_COLUMNS, MIN_ROWS, type OverlayKind } from './layout.js';
import { fitRung, fitRungIn } from './fit.js';
import { wizardMinsizeRow } from './onboarding/lines.js';
import { GLYPHS, type GlyphSet, truncateCells } from './glyphs.js';
import { Review, previewWant, type ReviewNote } from './Review.js';
import { followupLines, type FollowupInput } from './review/lines.js';
import { gateLines } from './secrets/gate-lines.js';
import { textProps, themeFor, type ColorOn, type ColorRole, type Theme } from './theme.js';
import { Wizard, type OnboardingState } from './onboarding/Wizard.js';
import { wizardRows } from './onboarding/reducer.js';
import type { TrustInputs } from '../config/trust.js';

/** §24: the exit confirm row. */
export const EXIT_CONFIRM_ROW = 'a run is live: [y] abort and exit   [n] stay              (Enter does nothing)';
/**
 * TUI-DESIGN-2 §4.7 (finding 5): the same words with the 14-space run collapsed to three — the `exit?` card's 76 inner cells
 * at 80 columns would otherwise cut `(Enter does nothing)`, the statement that justifies the inert Enter.
 */
export const EXIT_CONFIRM_ROW_COMPACT = 'a run is live: [y] abort and exit   [n] stay   (Enter does nothing)';
/** TUI-DESIGN-4 §2.6 (P-R7): the two narrower rungs, so a 40-column card still names both keys and the inert Enter. */
export const EXIT_CONFIRM_ROW_NARROW = 'run live: [y] abort+exit  [n] stay  (Enter: no)';
export const EXIT_CONFIRM_ROW_TINY = '[y] abort+exit [n] stay';
/** TUI-DESIGN-2 §4.7 / TUI-DESIGN-4 §2.6: the ladder, widest first — `fitRung` picks against the card's inner width. */
export const EXIT_CONFIRM_RUNGS: readonly string[] = [EXIT_CONFIRM_ROW, EXIT_CONFIRM_ROW_COMPACT, EXIT_CONFIRM_ROW_NARROW, EXIT_CONFIRM_ROW_TINY];
/** TUI-DESIGN-2 §4.7 / TUI-DESIGN-4 §2.6 (P-R7): the exit-confirm row that fits `innerCells` whole — the widest rung of the ladder. */
export function exitConfirmRow(innerCells: number, g: GlyphSet = GLYPHS.unicode): string {
  return fitRungIn(EXIT_CONFIRM_RUNGS, innerCells, g);
}
/** TUI-DESIGN-2 §12 "Cards": the card titles of the boxed tier. */
export const CARD_TITLE_EXIT = 'exit?';
export const CARD_TITLE_UNDO = 'undo';
export const CARD_TITLE_COMMANDS = 'commands';
export const CARD_TITLE_FILES = 'files';
/** TUI-DESIGN-2 §4.2: the blocking card is at most six rows — its first row becomes the title edge, so `blockingLines` (≤ 4 rows) + the bottom edge. */
export const BLOCKING_CARD_MAX = 6;
/**
 * §24 / §2.1 + TUI-DESIGN-4 §2.5 (P-R4): the minimum-size notice, as a **ladder measured after substitution**.
 *
 * The top rung is 72 cells at `30×5` and is only ever shown when the terminal is smaller than 40×8, so it was
 * **always** truncated: PROBED `terminal 30×5 is below the 40…` at 5×30, and `terminal 30×40 is below the 4…`
 * mid-resize, which reads as if 40 rows were too few. The rung cannot be picked by a constant either — the builder
 * interpolates `${columns}${times}${rows}`, so the same sentence is 72 cells at `30×5`, **73** at `100×5` and **75**
 * at `100×120`. `fitRung` measures each formatted candidate and takes the widest that fits (§2.6).
 *
 * The middle of the ladder **names the short dimension**, which is the half the old sentence lost: below 8 rows it
 * says rows, below 40 columns it says columns, and when both are short it says both.
 */
export function minsizeRungs(columns: number, rows: number, g: GlyphSet = GLYPHS.unicode): string[] {
  const times = g.mode === 'ascii' ? 'x' : '×';
  const dash = g.mode === 'ascii' ? '-' : '—';
  const c = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  const r = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  const shortRows = r < MIN_ROWS;
  const shortCols = c < MIN_COLUMNS;
  const both = `${MIN_COLUMNS}${times}${MIN_ROWS}`;
  // Neither dimension short is unreachable from `computeLayout` (it sets `minsize` only below the minimum), and the
  // ladder has no true sentence for it — every other rung would claim a dimension that is fine. State the minimum and
  // nothing else rather than `too narrow: need 40 cols` at 100×120 (§12 already carries `40×8 min`).
  if (!shortRows && !shortCols) return [`${both} min`];
  const need = shortRows && shortCols ? `need ${both}` : shortRows ? `need ${MIN_ROWS} rows` : `need ${MIN_COLUMNS} cols`;
  const small = shortRows && shortCols ? `too small: ${need}` : shortRows ? `too short: ${need}` : `too narrow: ${need}`;
  return [
    `terminal ${c}${times}${r} is below the ${both} minimum ${dash} panes hidden, transcript above`,
    `${c}${times}${r} < ${both} minimum ${dash} panes hidden`,
    small,
    need,
    `${both} min`,
  ];
}

/** §24 / §2.1 / TUI-DESIGN-4 §2.5: the widest minsize rung that fits `columns` — never truncated, and the short dimension is named. */
export function minsizeNotice(columns: number, rows: number, g: GlyphSet = GLYPHS.unicode): string {
  const c = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  return truncateCells(fitRung(minsizeRungs(c, rows, g), c), c, g);
}

/** TUI-DESIGN-2 §3.7: the intake card's rows as `src/chat/lines.ts` builds them — the boxed title + body and the flat one-row form. */
export interface IntakeOverlay {
  /** the card title (`run this as a task?` / `"<message ≤ 40>" — run this as a task?`) */
  title: string;
  /** the card's body rows (`[y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)`) */
  body: readonly string[];
  /** the flat tier's rows (`intakeRowLines` at the terminal width) */
  flat: readonly string[];
}

/** The per-kind data the overlay draws from (everything optional: the App passes what the kind needs). */
export interface OverlayData {
  /** TUI-DESIGN-3 §5.2 A8: `armed` — the card was drawn on a committed frame and `y` is live (the keys row wakes up); `Review` draws it (S5) */
  review?: { req: ConfirmRequest; note: ReviewNote | null; armed?: boolean } | null;
  wizard?: { state: OnboardingState; trust: TrustInputs | null } | null;
  followup?: FollowupInput | null;
  secret?: { hits: readonly SecretHit[] } | null;
  blocking?: BlockingRequest | null;
  palette?: { query: string; state: PaletteState; selected: number } | null;
  undo?: { row: string } | null;
  /** the `mention` popup reuses the palette slot: rows are already built */
  mention?: { rows: readonly string[]; selected: number } | null;
  /** TUI-DESIGN-2 §3.7: the intake confirmation */
  intake?: IntakeOverlay | null;
}

/**
 * §2.1 `LayoutInput.overlayWant`: review 8 · wizard 2–4 · followup 5 · secret 1 · blocking 2–4 · palette 2–8 · undo 1 ·
 * exitConfirm 1 · intake 1. TUI-DESIGN-2 §4.2 boxed (`chrome === 3`): review 9, followup 5, blocking `min(6, rows + 2)`,
 * undo 3, exitConfirm 3, intake 3, palette ≤ 8 (its two edges replace the footer row and one list row), secret 0 (the
 * gate is a console row, `LayoutInput.gate`) and wizard `wizardRows` (inside the console).
 */
export function overlayWant(kind: OverlayKind, data: OverlayData, terminalRows: number, columns: number, chrome: 0 | 3 = 0): number {
  const boxed = chrome === CAP.chrome;
  switch (kind) {
    case 'none':
      return 0;
    case 'review':
      return boxed ? CAP.reviewCard : CAP.reviewHeader;
    case 'wizard':
      return data.wizard ? wizardRows(data.wizard.state, terminalRows) : 0;
    case 'followup':
      return CAP.followup;
    case 'secret':
      return boxed ? 0 : CAP.secret;
    case 'blocking': {
      if (!data.blocking) return 0;
      const rows = Math.min(CAP.blocking, Math.max(2, blockingLines(data.blocking, CAP.blocking, boxed ? columns - 4 : columns).length));
      // boxed: the first row is the card's title edge, so the card is the rows plus the bottom edge (≤ 6)
      return boxed ? Math.min(BLOCKING_CARD_MAX, rows + 1) : rows;
    }
    case 'palette': {
      const inner = boxed ? columns - 4 : columns;
      const listRows = boxed ? CAP.palette - CAP.card : CAP.palette;
      if (data.mention) {
        const rows = Math.min(listRows, Math.max(2, data.mention.rows.length + 1));
        return boxed ? Math.min(CAP.palette, rows + CAP.card) : rows;
      }
      if (!data.palette) return boxed ? 2 + CAP.card : 2;
      const rows = paletteRows(data.palette.query, data.palette.state, data.palette.selected, listRows, inner);
      const n = Math.min(listRows, Math.max(2, rows.length));
      return boxed ? Math.min(CAP.palette, n + CAP.card) : n;
    }
    case 'undo':
      return boxed ? CAP.undo + CAP.card : CAP.undo;
    case 'exitConfirm':
      return boxed ? CAP.exitConfirm + CAP.card : CAP.exitConfirm;
    case 'intake':
      return boxed ? CAP.intake + CAP.card : CAP.intake;
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
  color?: ColorOn;
  screenReader?: boolean;
  /** TUI-DESIGN-2 §4.1: `chromeRows(...)` — 3 draws the cards, 0 today's rows */
  chrome?: 0 | 3;
}

function Rows({ lines, rows, columns, glyphs, role, theme, color }: { lines: readonly string[]; rows: number; columns: number; glyphs: GlyphSet; role?: ColorRole | null; theme: Theme; color: ColorOn }): React.JSX.Element {
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

/** TUI-DESIGN-2 §4.7: a card whose edges take `edgeRole` and whose body rows take `bodyRole` (both default to the edge role). */
function Card({ title, body, rows, columns, glyphs, edgeRole, bodyRole, theme, color }: { title: string; body: readonly string[]; rows: number; columns: number; glyphs: GlyphSet; edgeRole: ColorRole; bodyRole?: ColorRole | null; theme: Theme; color: ColorOn }): React.JSX.Element {
  const inner = Math.max(0, rows - CAP.card);
  const lines = cardLines(title, body.slice(0, inner), columns, glyphs);
  const edges = textProps(theme, edgeRole, color);
  const bodyProps = bodyRole === undefined ? edges : bodyRole === null ? {} : textProps(theme, bodyRole, color);
  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {lines.slice(0, rows).map((l, i) => {
        if (i === 0 || i === lines.length - 1) {
          return (
            <Text key={`c${i}`} wrap="truncate" {...edges}>
              {l}
            </Text>
          );
        }
        const cells = [...l];
        return (
          <Text key={`c${i}`} wrap="truncate">
            <Text {...edges}>{cells.slice(0, 2).join('')}</Text>
            <Text {...bodyProps}>{cells.slice(2, -2).join('')}</Text>
            <Text {...edges}>{cells.slice(-2).join('')}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

/** TUI-DESIGN-3 §5.2 A9: the selected row's `▌ ` (`> ` ascii) marker takes `accent2`; the rest of the row keeps its own props. */
const MARKER_CELLS = 2;

/**
 * §5.3: one palette row — `▌ /name  a  title   tag`, matched graphemes bold, unavailable rows dim, the footer dim; TUI-DESIGN-3
 * §5.2 A9 / §4.1 rule 4: the selected marker in `accent2`, the alias column and the group tag dim.
 */
function PaletteRowText({ row, theme, color }: { row: PaletteRow; theme: Theme; color: ColorOn }): React.JSX.Element {
  if (row.kind === 'footer') return <Text wrap="truncate" {...textProps(theme, 'dim', color)}>{row.text}</Text>;
  const off = color === false || color === 0;
  const marker = row.kind === 'command' && row.selected && !off ? row.text.slice(0, MARKER_CELLS) : '';
  const body = marker === '' ? row.text : row.text.slice(MARKER_CELLS);
  const shift = marker.length;
  const rowProps = row.dim ? textProps(theme, 'dim', color) : row.selected && off ? { bold: true } : {};
  const markerEl = marker === '' ? null : <Text {...textProps(theme, 'accent2', color)}>{marker}</Text>;
  if (row.spans.length === 0 || off) {
    return (
      <Text wrap="truncate" {...rowProps}>
        {markerEl}
        {body}
      </Text>
    );
  }
  const parts: React.JSX.Element[] = [];
  let at = 0;
  const sorted = [...row.spans].map(([a, b]) => [Math.max(0, a - shift), Math.max(0, b - shift)] as [number, number]).sort((a, b) => a[0] - b[0]);
  sorted.forEach(([s, e], i) => {
    if (s > at) parts.push(<Text key={`t${i}`}>{body.slice(at, s)}</Text>);
    parts.push(
      <Text key={`b${i}`} bold>
        {body.slice(s, e)}
      </Text>,
    );
    at = e;
  });
  if (at < body.length) parts.push(<Text key="tail">{body.slice(at)}</Text>);
  return (
    <Text wrap="truncate" {...rowProps}>
      {markerEl}
      {parts}
    </Text>
  );
}

/** TUI-DESIGN-2 §4.7: the palette card — `commands` title, the list rows with their bold spans inside `│ … │`, the footer as the last inner row. */
function PaletteCard({ title, list, rows, columns, glyphs, theme, color }: { title: string; list: readonly PaletteRow[]; rows: number; columns: number; glyphs: GlyphSet; theme: Theme; color: ColorOn }): React.JSX.Element {
  const inner = Math.max(0, rows - CAP.card);
  const edges = textProps(theme, 'border', color);
  const w = Math.max(1, columns - 4);
  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      <Text wrap="truncate" {...edges}>
        {cardTop(title, columns, glyphs)}
      </Text>
      {list.slice(0, inner).map((row, i) => (
        <Box key={`p${i}`} height={1} overflow="hidden" flexDirection="row">
          <Text {...edges}>{`${glyphs.boxVertical} `}</Text>
          <Box width={w} height={1} overflow="hidden">
            <PaletteRowText row={row} theme={theme} color={color} />
          </Box>
          <Text {...edges}>{` ${glyphs.boxVertical}`}</Text>
        </Box>
      ))}
      <Text wrap="truncate" {...edges}>
        {cardBottom(columns, glyphs)}
      </Text>
    </Box>
  );
}

/** the mention popup's rows (`▌ ` marker on the selected row) and its footer, for both tiers */
function mentionRows(m: { rows: readonly string[]; selected: number }, listRows: number, g: GlyphSet): string[] {
  const marker = g.mode === 'ascii' ? '> ' : '▌ ';
  const body = m.rows.slice(0, Math.max(0, listRows - 1)).map((r, i) => `${i === m.selected ? marker : '  '}${r}`);
  const footer = `(${m.rows.length === 0 ? 0 : Math.min(m.selected + 1, m.rows.length)}/${m.rows.length})  Tab completes ${g.dot} Enter inserts @path ${g.dot} Esc closes`;
  return [...body, footer];
}

/** §0: the one modal slot. Renders nothing when `rows` is 0 and the terminal is not degraded. */
export function Overlay(p: OverlayProps): React.JSX.Element | null {
  const g = p.glyphs ?? GLYPHS.unicode;
  const theme = p.theme ?? themeFor('dark');
  const color = p.color ?? true;
  const rows = Math.max(0, Math.floor(p.rows));
  const boxed = (p.chrome ?? 0) === CAP.chrome;
  const inner = Math.max(1, p.columns - 4);
  if (p.degraded === 'minsize') {
    if (rows === 0) return null;
    // TUI-DESIGN-4 §2.5 (P-R6, D4): the wizard is the worst corner in the corpus — at minsize `computeLayout` grants
    // notice(1) · wizard(1) and **no composer**, so the first-run user is never invited to type into a composer whose
    // Enter cannot start anything. The wizard row is read-only and informational (§2.5, stated once): it never draws a
    // caret and never a key byte, keys produce one toast, and growing back to ≥ 40×8 restores the full wizard.
    const notice = minsizeNotice(p.columns, p.terminalRows, g);
    // The dispatch is keyed on the DATA, not on `kind`: `App.tsx:2248` passes `kind='none'` whenever
    // `layout.degraded === 'minsize'` (it is S1's file, §9.2), so a branch gated on `kind === 'wizard'` is dead code
    // as wired and D4 — the worst corner in the corpus — stays open. `overlayData.wizard` is non-null exactly when
    // `state.overlay === 'wizard'` (`App.tsx`'s builder), so this reaches a frame through the product path today.
    const w = p.data.wizard;
    if (w) {
      // With two rows the notice leads and the wizard's row sits under it (§2.5 P-R6's notice(1) · wizard(1)). With
      // ONE row — all `computeLayout`'s minsize branch grants until S1 lands P-R6 — the wizard's own row wins: it
      // names setup *and* the size (`setup · key — terminal too small; ≥ 40×8 to type`), where the generic notice
      // never says that a first run is waiting. `alone` asks `wizardMinsizeRow` for a rung that carries the size.
      const row = wizardMinsizeRow(w.state, p.columns, g.mode === 'ascii', { alone: rows < 2 });
      if (row !== '') return <Rows lines={rows < 2 ? [row] : [notice, row]} rows={rows} columns={p.columns} glyphs={g} role="warn" theme={theme} color={color} />;
    }
    return <Rows lines={[notice]} rows={rows} columns={p.columns} glyphs={g} role="warn" theme={theme} color={color} />;
  }
  if (rows === 0 && p.kind !== 'review') return null;
  switch (p.kind) {
    case 'none':
      return null;
    case 'review': {
      const d = p.data.review;
      if (!d) return null;
      // TUI-DESIGN-3 §5.2 A8: `armed` rides through to the card (drawing only — `resolveKey` keeps the review invariants)
      const armed: { armed?: boolean } = d.armed === undefined ? {} : { armed: d.armed };
      return <Review req={d.req} rows={rows} previewRows={p.previewRows} columns={p.columns} top={p.top} note={d.note} {...(p.cursor ? { cursor: p.cursor } : {})} glyphs={g} theme={theme} color={color} boxed={boxed} {...armed} />;
    }
    case 'wizard': {
      const d = p.data.wizard;
      if (!d) return null;
      return <Wizard state={d.state} rows={rows} columns={p.columns} top={p.top} {...(p.cursor ? { cursor: p.cursor } : {})} ascii={g.mode === 'ascii'} {...(p.screenReader !== undefined ? { screenReader: p.screenReader } : {})} trust={d.trust} theme={theme} color={color === true || color === false ? color : color !== 0} />;
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
      if (boxed && rows >= 3) {
        const lines = blockingLines(d, rows - 1, inner);
        return <Card title={lines[0] ?? ''} body={lines.slice(1)} rows={rows} columns={p.columns} glyphs={g} edgeRole="error" theme={theme} color={color} />;
      }
      return <Rows lines={blockingLines(d, rows, p.columns)} rows={rows} columns={p.columns} glyphs={g} role="error" theme={theme} color={color} />;
    }
    case 'palette': {
      const m = p.data.mention;
      if (m) {
        if (boxed && rows >= 3) return <PaletteCard title={CARD_TITLE_FILES} list={mentionRows(m, rows - CAP.card, g).map((text, i, all): PaletteRow => ({ kind: i === all.length - 1 ? 'footer' : 'value', text, selected: false, dim: false, spans: [], suggested: false, tag: null }))} rows={rows} columns={p.columns} glyphs={g} theme={theme} color={color} />;
        return <Rows lines={mentionRows(m, rows, g)} rows={rows} columns={p.columns} glyphs={g} theme={theme} color={color} />;
      }
      const d = p.data.palette;
      if (!d) return null;
      if (boxed && rows >= 3) {
        const list = paletteRows(d.query, d.state, d.selected, rows - CAP.card, inner, g.mode === 'ascii');
        return <PaletteCard title={CARD_TITLE_COMMANDS} list={list} rows={rows} columns={p.columns} glyphs={g} theme={theme} color={color} />;
      }
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
      if (boxed && rows >= 3) return <Card title={CARD_TITLE_UNDO} body={[d.row]} rows={rows} columns={p.columns} glyphs={g} edgeRole="warn" theme={theme} color={color} />;
      return <Rows lines={[d.row]} rows={rows} columns={p.columns} glyphs={g} role="warn" theme={theme} color={color} />;
    }
    case 'exitConfirm':
      // the card's body is `columns − 4` cells wide (`cardRow`): the row that fits it whole (finding 5)
      // §2.6 edge 2: the rung is measured in the glyph set it will be drawn in, so `g` goes to the builder too
      if (boxed && rows >= 3) return <Card title={CARD_TITLE_EXIT} body={[exitConfirmRow(Math.max(0, Math.floor(p.columns) - 4), g)]} rows={rows} columns={p.columns} glyphs={g} edgeRole="warn" theme={theme} color={color} />;
      return <Rows lines={[EXIT_CONFIRM_ROW]} rows={rows} columns={p.columns} glyphs={g} role="warn" theme={theme} color={color} />;
    case 'intake': {
      const d = p.data.intake;
      if (!d) return null;
      if (boxed && rows >= 3) return <Card title={d.title} body={d.body} rows={rows} columns={p.columns} glyphs={g} edgeRole="warn" bodyRole={null} theme={theme} color={color} />;
      return <Rows lines={d.flat.length > 0 ? d.flat : d.body} rows={rows} columns={p.columns} glyphs={g} role="warn" theme={theme} color={color} />;
    }
  }
}

/** TUI-DESIGN-2 §4.7: the intake card's rows as strings (for the frame tests and `--ascii`). */
export function intakeCardLines(intake: IntakeOverlay, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  return cardLines(intake.title, intake.body, columns, g);
}

export { cardRow };
