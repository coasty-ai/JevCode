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
import { useMemo } from 'react';
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
  /** the quiet start: the workspace's most recent session title — the `task` placeholder becomes the resume offer */
  recent?: string | null;
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

/**
 * The memo keys of the Console's pure builders. A CPU profile of a streamed chat reply at 40×120 put the Console at 108
 * of the 202 ms React render phase — statusSpans 45, stringWidth 28.7, composerView 16.5, consoleTopEdgeParts 7.5 — all
 * rebuilt on every delta, spinner and indicator tick although none of their inputs had moved. The App hands the Console
 * fresh objects every render (`statusView(...)`, `statusOpts`, `hitSpans(...)`), so the memos are keyed on the VALUES
 * inside them, never on the objects. The Console itself is deliberately not `React.memo`: the App resets the cursor
 * before its children render (`setCursorPosition(undefined)`) and the Console places it again during every render, so a
 * skipped Console would hide it (`console-memo.test.tsx` in the tui unit tests pins both halves).
 */
const one = (v: unknown): readonly unknown[] => [v];
const NO_GIT: readonly unknown[] = [false, null, null, null, null, null, null];

/**
 * Everything `statusSpans` reads from `StatusLineState`, flattened to values `useMemo` compares with `Object.is`. The
 * mapped type lists every member, optional ones included, so a member added to `StatusLineState` is a type error here
 * until it is keyed — the memo cannot go stale by omission. `git` and `draft` are rebuilt by the App on every render
 * (`{ ...state.git, head, frozen }`, `{ secretHits }`), so they are flattened to their fields; every other member is a
 * reducer value (or a primitive the App derives, `wallMs` / `ctx` / `agents`) whose identity moves exactly when its
 * content does. `nowMs` is the reducer's 1 Hz clock, so the row is rebuilt once a second, not on every render. Each
 * entry returns a fixed number of values, so the deps array never changes length.
 */
const STATUS_KEY: { readonly [K in keyof StatusLineState]-?: (v: StatusLineState[K]) => readonly unknown[] } = {
  run: one,
  mode: one,
  status: one,
  ready: one,
  done: one,
  runId: one,
  overlay: one,
  pendingReview: one,
  retrying: one,
  blocking: one,
  errors: one,
  stageStartedAt: one,
  toasts: one,
  git: (z) => (z === null ? NO_GIT : [true, z.head, z.ahead, z.behind, z.dirty, z.linkedWorktree, z.frozen]),
  spend: one,
  draft: (d) => [d.secretHits],
  nowMs: one,
  title: one,
  sandbox: one,
  noNetwork: one,
  diskErrors: one,
  jevLatencies: one,
  picker: one,
  wallMs: one,
  doneExitCode: one,
  modeBadge: one,
  thinking: one,
  peers: one,
  fold: one,
  selfId: one,
  ctx: one,
  ctxShort: one,
  agents: one,
  // AGENT-LOOP-DESIGN §A5: the agent run's activity word (a primitive the App derives)
  agentWord: one,
};
const STATUS_KEYS = Object.keys(STATUS_KEY) as (keyof StatusLineState)[];
/** The `StatusLineOptions` members, same rule: a new option is a type error until it is keyed. */
// AGENT-LOOP-DESIGN §A3: the mini indicator's two frames are strings, so the status row re-renders exactly when a frame changes
const STATUS_OPTION_KEY: { readonly [K in keyof StatusLineOptions]-?: true } = { ascii: true, reducedMotion: true, spinnerFrame: true, mode: true, flatBadge: true, terminalColumns: true, indicatorWide: true, indicatorNarrow: true };
const STATUS_OPTION_KEYS = Object.keys(STATUS_OPTION_KEY) as (keyof StatusLineOptions)[];

function statusKeyOf<K extends keyof StatusLineState>(s: StatusLineState, k: K): readonly unknown[] {
  // `STATUS_KEY[k]` IS the entry for `k`; the checker only cannot narrow the table's union by a generic key
  return (STATUS_KEY[k] as (v: StatusLineState[K]) => readonly unknown[])(s[k]);
}

/** The status row's memo deps: the inner width, every `StatusLineState` value and every option (fixed length). */
export function statusMemoDeps(s: StatusLineState, inner: number, o: StatusLineOptions): unknown[] {
  const deps: unknown[] = [inner];
  for (const k of STATUS_KEYS) deps.push(...statusKeyOf(s, k));
  for (const k of STATUS_OPTION_KEYS) deps.push(o[k]);
  return deps;
}

/** The hit spans as one primitive (`start:end,…`): the App builds a new array every render, `composerView` reads only the offsets. */
function spansKey(spans: readonly Span[]): string {
  let key = '';
  for (const s of spans) key += `${s.start}:${s.end},`;
  return key;
}

const NO_SPANS: readonly Span[] = [];

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
  // the three edge strings depend on the geometry and the two words only
  const frame = useMemo(() => ({ parts: consoleTopEdgeParts(head, p.dir, columns, g), divider: consoleDivider(columns, g), bottom: consoleBottom(columns, g) }), [head, p.dir, columns, g]);
  const parts = frame.parts;
  const gateRows = p.gate !== undefined && p.gate !== null ? 1 : 0;
  const bodyTop = p.top + 1 + gateRows;
  // Every row box below wraps exactly one `wrap="truncate"` Text that Ink has already cut to the box's width, so the box
  // clips vertically only (`overflowY`): Ink's horizontal clip (`Output.get`: getWidestLine + sliceAnsi on every line of
  // every frame) could never remove a cell here, and it is most of Ink's per-frame cost with box glyphs (a 30×120 clip
  // bench: 5.34 → 3.03 ms, byte-identical output). `frame-identity.test.tsx` (tui unit tests) pins frames and rule.
  const wrap = (body: React.ReactNode, key: string): React.JSX.Element => (
    <Box key={key} height={1} overflowY="hidden">
      <Text wrap="truncate">
        <Text {...edges}>{`${g.boxVertical} `}</Text>
        {body}
        <Text {...edges}>{` ${g.boxVertical}`}</Text>
      </Text>
    </Box>
  );
  const base = promptFor(g);
  const prompt = p.mode === 'filter' ? `${base}${FILTER_LABEL}` : base;
  const wizardOn = Boolean(p.wizard);
  const spans = p.spans ?? NO_SPANS;
  const spanKey = spansKey(spans);
  const maskGlyph = maskGlyphFor(g);
  // the composer's rows and cursor: a pure function of the draft and the geometry (the wizard draws its own rows)
  const composed = useMemo(
    () => (wizardOn ? null : composerView({ text: p.buffer.text, cursor: p.buffer.cursor, chips: p.buffer.chips, columns: inner, height, scrollTop: p.scrollTop, spans, prompt, glyphs: g, maskGlyph })),
    // `spans` is read through its offsets (`spanKey`), the only part `composerView` uses
    [wizardOn, p.buffer.text, p.buffer.cursor, p.buffer.chips, inner, height, p.scrollTop, spanKey, prompt, g, maskGlyph],
  );
  const recent = p.recent ?? null;
  const placeholder = useMemo(() => (wizardOn ? '' : placeholderRow(p.mode, p.rows, inner, stringWidth(prompt), g, recent)), [wizardOn, p.mode, p.rows, inner, prompt, g, recent]);
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
  } else if (composed !== null) {
    // (`composed` is null exactly when the wizard owns the rows, the branch above)
    const view = composed;
    if (view.scrollTop !== p.scrollTop) p.onScroll?.(view.scrollTop);
    const empty = p.buffer.text.length === 0;
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
  // the status row's text, colour spans and right padding; keyed on every value the row reads (`statusMemoDeps`)
  const status = useMemo(() => {
    const s = statusSpans(p.status, inner, p.statusOptions);
    return { ...s, pad: padEndCells('', Math.max(0, inner - stringWidth(s.text))) };
  }, statusMemoDeps(p.status, inner, p.statusOptions));
  return (
    <Box flexDirection="column" height={1 + gateRows + height + 3} overflow="hidden">
      <Box height={1} overflowY="hidden">
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
      <Box height={1} overflowY="hidden">
        <Text wrap="truncate" {...edges}>
          {frame.divider}
        </Text>
      </Box>
      {wrap(
        <Text>
          {spanPieces(status.text, status.spans, theme, color)}
          <Text>{status.pad}</Text>
        </Text>,
        'status',
      )}
      <Box height={1} overflowY="hidden">
        <Text wrap="truncate" {...edges}>
          {frame.bottom}
        </Text>
      </Box>
    </Box>
  );
}
