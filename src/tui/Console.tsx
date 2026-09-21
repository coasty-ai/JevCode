/**
 * The console (TUI-DESIGN-2 §4.3, §4.4, §4.8, §10.3): the boxed tier's one rounded box around the composer and the
 * status bar — `╭─ <badge> ──…── <dir> ─╮` (or a hosted title: `setup · <step>`, `sessions · filter`), the hosted
 * secret-gate row, the composer rows (`› ` on row 0, two spaces on continuations; the wizard's rows when it owns the
 * input), the divider `├──┤`, `statusLineText(state, W)` and `╰──╯`, every row exactly `columns` cells and every
 * string the same as `consoleLines()` (console-lines.ts) draws — Ink only colours the parts (badge in the `badge` role,
 * edges `border`, `borderFocus` while a run is live, the steer-coloured prompt, the dim placeholder with its hint
 * right-aligned at ≥ 100 inner cells, the `secret` gate row, the status row's own role). The cursor is the one
 * formula of §4.2: `{ x: 2 + view.cursor.x, y: composerTop(layout) + view.cursor.row }` — `top` here is the top-edge
 * row, so the draft's row 0 is `top + 1 + gate`. The flat tier renders `<Composer>` + `<StatusLine>` instead.
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
import { maskGlyphFor } from './Review.js';
import { wizardLines, type WizardView } from './onboarding/lines.js';
import type { OnboardingState } from './onboarding/reducer.js';
import { statusLineText, type StatusLineOptions, type StatusLineState } from './status/lines.js';
import { statusRole } from './StatusLine.js';
import { textProps, themeFor, type ColorOn, type Theme } from './theme.js';

/** TUI-DESIGN-2 §1.4 / §12 "Console": the console title while the wizard owns the input — `setup · <step>`. */
export function wizardConsoleTitle(step: string, g: GlyphSet = GLYPHS.unicode): string {
  const names: Readonly<Record<string, string>> = { jevProvider: 'jev provider', provider: 'provider', generatorKey: 'generator key', jevKey: 'jev key', verify: 'verify', trust: 'trust' };
  const name = names[step];
  return name === undefined ? 'setup' : `setup ${g.dot} ${name}`;
}

/** TUI-DESIGN-2 §4.3 / §12 "Console": the console title while the picker filters — `sessions · filter` / `rewind · filter`. */
export function pickerConsoleTitle(kind: 'sessions' | 'rewind', g: GlyphSet = GLYPHS.unicode): string {
  return `${kind} ${g.dot} filter`;
}

export interface ConsoleProps {
  buffer: TextBuffer;
  /** the terminal width; the edges, the gate row and the status row are drawn at `consoleInnerWidth(columns)` */
  columns: number;
  /**
   * TUI-DESIGN-2 §4.3 (finding 6): the width the draft is laid out at — the App's debounced `wrapColumns` (§14.1), the same
   * width `composerWant` and the draft mirror use, so the rows the layout grants and the rows the box wraps always agree
   * (for ≤ 50 ms after a resize the edges already follow the new width while the body still wraps at the old one).
   * Defaults to `columns`.
   */
  bodyColumns?: number;
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
  spans?: readonly Span[];
  ghost?: { rest: string; more: number } | null;
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
  // finding 6: the draft wraps at the debounced width; the edges never wait
  const bodyInner = p.bodyColumns !== undefined && Number.isFinite(p.bodyColumns) ? consoleInnerWidth(Math.max(4, Math.floor(p.bodyColumns))) : inner;
  const height = Math.max(1, Math.floor(p.height));
  const edges = textProps(theme, p.live === true ? 'borderFocus' : 'border', color);
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
    const fieldRow = (step === 'generatorKey' || step === 'jevKey') && !sr ? 1 : -1;
    for (let i = 0; i < height; i++) {
      const line = fitCells(lines[i] ?? '', inner, g);
      if (i === fieldRow && p.active) p.cursor({ x: Math.min(columns - 3, 2 + stringWidth((lines[i] ?? '').trimEnd())), y: bodyTop + i });
      bodyRows.push(wrap(<Text {...(i === 0 ? { bold: true } : i === lines.length - 1 && p.wizard.state.hint !== null ? textProps(theme, 'warn', color) : textProps(theme, 'dim', color))}>{line}</Text>, `w${i}`));
    }
    if (fieldRow === -1 || !p.active) p.cursor(undefined);
  } else {
    const base = promptFor(g);
    const prompt = p.mode === 'filter' ? `${base}${FILTER_LABEL}` : base;
    const view = composerView({ text: p.buffer.text, cursor: p.buffer.cursor, chips: p.buffer.chips, columns: bodyInner, height, scrollTop: p.scrollTop, spans: p.spans ?? [], prompt, glyphs: g, maskGlyph: maskGlyphFor(g) });
    if (view.scrollTop !== p.scrollTop) p.onScroll?.(view.scrollTop);
    const empty = p.buffer.text.length === 0;
    const placeholder = placeholderRow(p.mode, p.rows, bodyInner, stringWidth(prompt), g);
    const promptProps = p.live === true && p.active ? textProps(theme, 'steer', color) : {};
    if (p.active && view.cursor !== null && p.searchRow == null) p.cursor({ x: 2 + view.cursor.x, y: bodyTop + view.cursor.row });
    else if (p.active && p.searchRow != null) p.cursor({ x: Math.min(columns - 3, 2 + stringWidth(truncateCells(p.searchRow, inner, g))), y: bodyTop });
    else p.cursor(undefined);
    for (let i = 0; i < height; i++) {
      const r = view.rows[i] ?? '';
      const isPromptRow = view.scrollTop + i === 0 && r.startsWith(prompt);
      const body = isPromptRow ? r.slice(prompt.length) : r;
      const ghost = p.ghost && view.cursor !== null && view.cursor.row === i && p.buffer.cursor >= p.buffer.text.length ? p.ghost : null;
      const ghostText = ghost ? `${ghost.rest}${ghost.more > 0 ? ` +${ghost.more}` : ''}` : '';
      const showPlaceholder = i === 0 && empty && p.searchRow == null && placeholder !== '';
      if (i === 0 && p.searchRow != null) {
        bodyRows.push(wrap(<Text>{fitCells(p.searchRow, bodyInner, g)}</Text>, `c${i}`));
        continue;
      }
      const used = stringWidth(isPromptRow ? prompt : '') + stringWidth(body) + stringWidth(ghostText);
      const ph = showPlaceholder ? truncateCells(placeholder, Math.max(0, bodyInner - used), g) : '';
      const pad = ' '.repeat(Math.max(0, bodyInner - used - stringWidth(ph)));
      bodyRows.push(
        wrap(
          <>
            {isPromptRow ? <Text {...promptProps}>{prompt}</Text> : null}
            <Text>{body}</Text>
            {ghostText ? <Text {...textProps(theme, 'dim', color)}>{ghostText}</Text> : null}
            {ph ? <Text {...textProps(theme, 'placeholder', color)}>{ph}</Text> : null}
            <Text>{pad}</Text>
          </>,
          `c${i}`,
        ),
      );
    }
  }
  const statusText = statusLineText(p.status, inner, p.statusOptions);
  const sRole = statusRole(p.status);
  const done = p.status.done !== null && p.status.run === 'none';
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
        <Text bold={done} {...(sRole ? textProps(theme, sRole, color) : {})}>
          {padEndCells(statusText, inner)}
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
