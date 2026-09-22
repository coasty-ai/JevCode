/**
 * The console (TUI-DESIGN-2 §4.3, §4.4, §4.8, §10.3): the boxed tier's one rounded box around the composer and the
 * status bar — `╭─ <badge> ──…── <dir> ─╮` (or a hosted title: `setup · <step>`, `sessions · filter`), the hosted
 * secret-gate row, the composer rows (`› ` on row 0, two spaces on continuations; the wizard's rows when it owns the
 * input), the divider `├──┤`, `statusLineText(state, W)` and `╰──╯`, every row exactly `columns` cells and every
 * string the same as `consoleLines()` (console-lines.ts) draws — Ink only colours the parts (badge in the `badge` role,
 * edges `border`, `borderFocus` while a run is live or the `edgeRole` the App's run-end fade names (TUI-DESIGN-3 §5.2 A6),
 * the prompt `accent` at rest and `steer` while a run is live (D-O), the dim placeholder with its hint right-aligned at
 * ≥ 100 inner cells, the `secret` gate row, and the status row's spans — the spinner glyph, the done word, the meter words,
 * `⚠ secret?`, a toast (`statusSpans`, D-P: never the whole row). The cursor is the one formula of §4.2:
 * `{ x: 2 + view.cursor.x, y: composerTop(layout) + view.cursor.row }` — `top` here is the top-edge row, so the draft's
 * row 0 is `top + 1 + gate`. The flat tier renders `<Composer>` + `<StatusLine>` instead.
 *
 * TUI-DESIGN-4 §2.2 (P-R2): **one geometry per frame.** Every row of this box — the edges, the gate, the draft, the
 * divider and the status row — is derived from the one `columns` prop. Round 2's finding 6 kept the box and the body
 * in step by laying the draft out at the App's *debounced* `wrapColumns` and declaring a second `bodyColumns` prop;
 * A2 measured what that costs on the other side of the debounce (`out/tear`, 24 rows, 80→60→100→44→80): **4 of 24
 * frames** carry a box row whose right border is the truncation ellipsis, and one grow frame draws a stray `│`
 * mid-row with dead space after it. One value cannot skew, so `bodyColumns` is **gone** from `ConsoleProps` (§9.2's
 * `Console.tsx` row) together with `wrapColumns`, `createResizeDebounce` and `RESIZE_DEBOUNCE_MS`: leaving the prop
 * declared, even ignored, is the escape hatch that would let the skew back in.
 */
import { Box, Text } from 'ink';
import type { CursorPosition } from 'ink';
import type { TrustInputs } from '../config/trust.js';
import { FILTER_LABEL, composerView, placeholderRow, promptFor, type ComposerMode } from './composer/Composer.js';
import type { TextBuffer } from './composer/buffer.js';
import type { Span } from './composer/rows.js';
import { stringWidth } from './composer/width.js';
import { consoleBottom, consoleDivider, consoleInnerWidth, consoleTopEdgeParts } from './console-lines.js';
import { GLYPHS, fitCells, padEndCells, truncateCells, type GlyphSet } from './glyphs.js';
import type { PaletteGhost } from './commands/palette.js';
import { maskGlyphFor } from './Review.js';
import type { PickerKind } from './Picker.js';
import { wizardConsoleTitle as wizardStepTitle, wizardLines, type WizardView } from './onboarding/lines.js';
import { isFieldStep, type OnboardingState } from './onboarding/reducer.js';
import { statusSpans, type StatusLineOptions, type StatusLineState } from './status/lines.js';
import { spanPieces } from './StatusLine.js';
import { textProps, themeFor, type ColorOn, type ColorRole, type Theme } from './theme.js';

/**
 * TUI-DESIGN-2 §1.4 / §12 "Console", TUI-DESIGN-3 §1.4.2: the console title while the wizard owns the input — `setup · <step>`.
 * One source: `onboarding/lines.ts`'s `wizardConsoleTitle` (which knows every step, `key` and `options` included); this
 * wrapper only folds the `·` to the glyph set's dot and reads `setup` for a step without a title.
 */
export function wizardConsoleTitle(step: string, g: GlyphSet = GLYPHS.unicode): string {
  const title = wizardStepTitle({ step: step as OnboardingState['step'] });
  return title === null ? 'setup' : title.replaceAll(' · ', ` ${g.dot} `);
}

/**
 * TUI-DESIGN-3 §4.1 rule 3 / TUI-DESIGN-4 §4.3 P-P2: the palette ghost — the completion after the cursor, or the
 * ` → /owner` arrow of an alias or of a marked row that does not extend the token. Round 4's three-member union
 * (`PaletteGhost`, which carries `more` on the arrow shape too) and round 3's two-member shape are both accepted:
 * `App.tsx` passes the former since §9.2's `App.tsx` row landed, and the composer renders the same union.
 */
export type ConsoleGhost = { rest: string; more: number } | { arrow: string } | PaletteGhost;

/** TUI-DESIGN-3 §4.1 rule 3 / §4.3 P-P2: the ghost's text after the draft — `get +2` for a completion, ` → /status +2` (`-> ` ascii) for an arrow. */
export function ghostText(ghost: ConsoleGhost | null | undefined, g: GlyphSet = GLYPHS.unicode): string {
  if (!ghost) return '';
  if ('kind' in ghost) {
    const more = ghost.more > 0 ? ` +${ghost.more}` : '';
    return ghost.kind === 'arrow' ? ` ${g.arrow} ${ghost.target}${more}` : `${ghost.rest}${more}`;
  }
  if ('arrow' in ghost) return ` ${g.arrow} ${ghost.arrow}`;
  return `${ghost.rest}${ghost.more > 0 ? ` +${ghost.more}` : ''}`;
}

/**
 * TUI-DESIGN-2 §4.3 / §12 "Console": the console title while the picker filters — `sessions · filter` /
 * `rewind · filter`, and TUI-DESIGN-5 §6.4's `models · filter`. The kind IS the word: D-AQ puts the model picker
 * in the same pane slot with the same composer-as-filter contract, so it takes the same title by construction
 * rather than a third literal (§13.4).
 */
export function pickerConsoleTitle(kind: PickerKind, g: GlyphSet = GLYPHS.unicode): string {
  return `${kind} ${g.dot} filter`;
}

export interface ConsoleProps {
  buffer: TextBuffer;
  /** the terminal width; the edges, the gate row and the status row are drawn at `consoleInnerWidth(columns)` */
  columns: number;
  /** the composer rows granted (`layout.composer − layout.gate`); the wizard's rows when `wizard` is set */
  height: number;
  /** `consoleTop(layout)` — the top-edge row inside the dynamic region */
  top: number;
  scrollTop: number;
  cursor: (pos: CursorPosition | undefined) => void;
  active: boolean;
  mode: ComposerMode;
  /** the terminal height (placeholder form) */
  rows: number;
  live?: boolean;
  /** TUI-DESIGN-3 §5.2 A6: the App's run-end edge fade names the edge role for a frame (`borderFocus` → `accent2` → `border`); unset = `live` decides */
  edgeRole?: ColorRole;
  spans?: readonly Span[];
  ghost?: ConsoleGhost | null;
  searchRow?: string | null;
  /** `modeBadge(mode, pending)` */
  badge: string;
  /** the workspace basename ('' drops it) */
  dir: string;
  /** a hosted title replaces the badge (`setup · generator key`, `sessions · filter`) */
  title?: string | null;
  /** the hosted secret-gate row (TUI-DESIGN-2 §4.2) */
  gate?: string | null;
  status: StatusLineState;
  statusOptions: StatusLineOptions;
  /** the wizard owns the body rows (`wizardLines`), the masked field drawn as `› •••••` */
  wizard?: { state: OnboardingState; trust: TrustInputs | null; screenReader?: boolean } | null;
  glyphs?: GlyphSet;
  theme?: Theme;
  color?: ColorOn;
  onScroll?: (scrollTop: number) => void;
}

/** the strings of the console's rows (tests compare them with `consoleLines()`) */
export interface ConsoleRows {
  top: string;
  gate: string | null;
  body: string[];
  divider: string;
  status: string;
  bottom: string;
}

/** TUI-DESIGN-2 §4.3: the wizard's body rows at the inner width — the masked field row as `› ` + mask cells (`maskedFieldRow` with `glyphs.prompt`). */
export function wizardBodyRows(state: OnboardingState, rows: number, innerColumns: number, g: GlyphSet, trust: TrustInputs | null, screenReader: boolean): string[] {
  const view: WizardView = { rows, columns: innerColumns, ascii: g.mode === 'ascii', screenReader, prompt: promptFor(g), ...(trust ? { trust } : {}) };
  return wizardLines(state, view).slice(0, Math.max(0, rows));
}

/** TUI-DESIGN-2 §4.3: the console box. */
export function Console(p: ConsoleProps): React.JSX.Element {
  const g = p.glyphs ?? GLYPHS.unicode;
  const theme = p.theme ?? themeFor('dark');
  const color = p.color ?? true;
  const columns = Math.max(4, Math.floor(p.columns));
  const inner = consoleInnerWidth(columns);
  // TUI-DESIGN-4 §2.2 (P-R2): one geometry per frame — the draft wraps at `inner`, the width the edges are drawn at.
  // There is no second width to pass: edge 1's `draftRows` is re-run on every render at `wrapInner`, so the layout's
  // grant and the box's wrap are computed from this same `columns` in this same commit.
  const height = Math.max(1, Math.floor(p.height));
  const edges = textProps(theme, p.edgeRole ?? (p.live === true ? 'borderFocus' : 'border'), color);
  const head = p.title !== undefined && p.title !== null && p.title !== '' ? p.title : p.badge;
  const parts = consoleTopEdgeParts(head, p.dir, columns, g);
  const gateRows = p.gate !== undefined && p.gate !== null ? 1 : 0;
  const bodyTop = p.top + 1 + gateRows;
  const wrap = (body: React.ReactNode, key: string): React.JSX.Element => (
    <Box key={key} height={1} overflow="hidden">
      <Text wrap="truncate">
        <Text {...edges}>{`${g.boxVertical} `}</Text>
        {body}
        <Text {...edges}>{` ${g.boxVertical}`}</Text>
      </Text>
    </Box>
  );
  const bodyRows: React.JSX.Element[] = [];
  if (p.wizard) {
    const sr = p.wizard.screenReader === true;
    const lines = wizardBodyRows(p.wizard.state, height, inner, g, p.wizard.trust, sr);
    const step = p.wizard.state.step;
    // TUI-DESIGN-3 §1.4.1 / §1.4.3: one predicate for both renderers' masked row (`key` · `generatorKey` · `jevKey`; Wizard.tsx reads it too)
    const fieldRow = isFieldStep(step) && !sr ? 1 : -1;
    for (let i = 0; i < height; i++) {
      const line = fitCells(lines[i] ?? '', inner, g);
      if (i === fieldRow && p.active) p.cursor({ x: Math.min(columns - 3, 2 + stringWidth((lines[i] ?? '').trimEnd())), y: bodyTop + i });
      bodyRows.push(wrap(<Text {...(i === 0 ? { bold: true } : i === lines.length - 1 && p.wizard.state.hint !== null ? textProps(theme, 'warn', color) : textProps(theme, 'dim', color))}>{line}</Text>, `w${i}`));
    }
    if (fieldRow === -1 || !p.active) p.cursor(undefined);
  } else {
    const base = promptFor(g);
    const prompt = p.mode === 'filter' ? `${base}${FILTER_LABEL}` : base;
    const view = composerView({ text: p.buffer.text, cursor: p.buffer.cursor, chips: p.buffer.chips, columns: inner, height, scrollTop: p.scrollTop, spans: p.spans ?? [], prompt, glyphs: g, maskGlyph: maskGlyphFor(g) });
    if (view.scrollTop !== p.scrollTop) p.onScroll?.(view.scrollTop);
    const empty = p.buffer.text.length === 0;
    const placeholder = placeholderRow(p.mode, p.rows, inner, stringWidth(prompt), g);
    // TUI-DESIGN-3 §2.6 (D-O): the prompt is pink at rest and amber while a run is live (steering must not look like idle)
    const promptProps = p.live === true && p.active ? textProps(theme, 'steer', color) : p.active ? textProps(theme, 'accent', color) : {};
    if (p.active && view.cursor !== null && p.searchRow == null) p.cursor({ x: 2 + view.cursor.x, y: bodyTop + view.cursor.row });
    else if (p.active && p.searchRow != null) p.cursor({ x: Math.min(columns - 3, 2 + stringWidth(truncateCells(p.searchRow, inner, g))), y: bodyTop });
    else p.cursor(undefined);
    for (let i = 0; i < height; i++) {
      const r = view.rows[i] ?? '';
      const isPromptRow = view.scrollTop + i === 0 && r.startsWith(prompt);
      const body = isPromptRow ? r.slice(prompt.length) : r;
      const ghost = p.ghost && view.cursor !== null && view.cursor.row === i && p.buffer.cursor >= p.buffer.text.length ? p.ghost : null;
      const ghostStr = ghostText(ghost, g);
      const showPlaceholder = i === 0 && empty && p.searchRow == null && placeholder !== '';
      if (i === 0 && p.searchRow != null) {
        bodyRows.push(wrap(<Text>{fitCells(p.searchRow, inner, g)}</Text>, `c${i}`));
        continue;
      }
      const used = stringWidth(isPromptRow ? prompt : '') + stringWidth(body) + stringWidth(ghostStr);
      const ph = showPlaceholder ? truncateCells(placeholder, Math.max(0, inner - used), g) : '';
      const pad = ' '.repeat(Math.max(0, inner - used - stringWidth(ph)));
      bodyRows.push(
        wrap(
          <>
            {isPromptRow ? <Text {...promptProps}>{prompt}</Text> : null}
            <Text>{body}</Text>
            {ghostStr ? <Text {...textProps(theme, 'dim', color)}>{ghostStr}</Text> : null}
            {ph ? <Text {...textProps(theme, 'placeholder', color)}>{ph}</Text> : null}
            <Text>{pad}</Text>
          </>,
          `c${i}`,
        ),
      );
    }
  }
  const status = statusSpans(p.status, inner, p.statusOptions);
  return (
    <Box flexDirection="column" height={1 + gateRows + height + 3} overflow="hidden">
      <Box height={1} overflow="hidden">
        <Text wrap="truncate">
          <Text {...edges}>{parts.left}</Text>
          <Text {...(p.title ? textProps(theme, 'accent', color) : textProps(theme, 'badge', color))}>{parts.badge}</Text>
          <Text {...edges}>{parts.fill}</Text>
          <Text {...textProps(theme, 'dim', color)}>{parts.dir}</Text>
          <Text {...edges}>{parts.right}</Text>
        </Text>
      </Box>
      {gateRows === 1 ? wrap(<Text {...textProps(theme, 'secret', color)}>{fitCells(p.gate ?? '', inner, g)}</Text>, 'gate') : null}
      {bodyRows}
      <Box height={1} overflow="hidden">
        <Text wrap="truncate" {...edges}>
          {consoleDivider(columns, g)}
        </Text>
      </Box>
      {wrap(
        <Text>
          {spanPieces(status.text, status.spans, theme, color)}
          <Text>{padEndCells('', Math.max(0, inner - stringWidth(status.text)))}</Text>
        </Text>,
        'status',
      )}
      <Box height={1} overflow="hidden">
        <Text wrap="truncate" {...edges}>
          {consoleBottom(columns, g)}
        </Text>
      </Box>
    </Box>
  );
}
