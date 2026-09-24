/**
 * TUI-DESIGN-4 §3.1 (D-U): the ONE command-output grammar. Every multi-row command answer is a list of `BlockRow`s
 * rendered once, by `renderBlock`, at the width `blockWidth(columns)` gives — and the SAME rendered rows go to the
 * TUI item's detail body, to `--plain`'s `[ui] <row>` lines and (through `Engine.annotateBlock`, §3.5) to
 * `transcript.log`. Pure and Ink-free: `src/cli/session.ts` reaches it on the first-frame path.
 *
 * Two axes that must never be confused (§3.1.2):
 *   - the terminal-width **rung** (`gutter` / `stacked` / `flush`, §2.3) decides how much room the body has;
 *   - the block **tier** (`tight` / `narrow` / `standard` / `wide`) decides how a row uses that room.
 * `renderBlock` receives the WIDTH; `TranscriptRow` receives the COLUMNS.
 *
 * All arithmetic goes through `glyphs.ts` `cellWidth` / `truncateCells`, never `String.length` (§3.3 edge 4).
 */
import { cellWidth, GLYPHS, padEndCells, padStartCells, truncateCells, type GlyphSet } from '../glyphs.js';
import { BLOCK_WIDTH_MAX, LABEL_GUTTER, gutterMode } from '../gutter.js';
import type { ColorRole } from '../theme.js';

// --- the rung (§2.3, §3.1.2) --------------------------------------------------------------------
// §3.1.2: the rung predicate and the gutter constant live in `src/tui/gutter.ts` (S2, new, ZERO imports) so this
// no-Ink module can reach them on the first-frame path without pulling `Transcript.tsx` (and Ink) in behind it.
// They are re-exported here because every existing importer of `block/lines.ts` reads them from this module, and
// `test/unit/tui/block/lines.test.ts` pins them against `Transcript.tsx`'s own `LABEL_GUTTER` so no copy can drift.
export { FLUSH_MIN_COLUMNS, LABEL_GUTTER, STACKED_MIN_COLUMNS, gutterMode, type GutterMode } from '../gutter.js';

// --- the width contract (§3.1.2) ----------------------------------------------------------------

/** §3.1.2: the identity pty run drives 640 columns; an unclamped block would emit 630-cell rows. */
export { BLOCK_WIDTH_MAX };

/**
 * §3.1.2: the width every body builder is given — a function of the RUNG, not of `columns` alone, because the row
 * the block is rendered into is exactly the rung's body width (`columns − LABEL_GUTTER` in `gutter`, `columns − 2`
 * in `stacked`, `columns` in `flush`). There is NO lower clamp above 1: a floor above the available width IS the
 * bug (an earlier draft floored at 28 and overflowed every terminal narrower than 38 columns).
 */
export function blockWidth(columns: number): number {
  const c = Number.isFinite(columns) ? Math.floor(columns) : 0;
  const mode = gutterMode(c);
  const body = mode === 'gutter' ? c - LABEL_GUTTER : mode === 'stacked' ? c - 2 : c;
  return Math.max(1, Math.min(BLOCK_WIDTH_MAX, body));
}

/**
 * §3.1.3: the kv key FIELD is 10 cells (`epilogue.ts`'s existing `padEnd(10)`); one separator space follows, so the
 * value column is 11 — which is what every F-B frame draws and what `test/unit/tui/block/lines.test.ts` reads back.
 */
export const KV_KEY_COL = 10;

/** §3.1.2: the four block tiers, all derived from the WIDTH (so 40/60/80/120 columns give 30/50/70/110). */
export type BlockTier = 'tight' | 'narrow' | 'standard' | 'wide';

export const TIER_NARROW_MIN = 34;
export const TIER_STANDARD_MIN = 60;
export const TIER_WIDE_MIN = 100;

export function blockTier(width: number): BlockTier {
  const w = Number.isFinite(width) ? Math.floor(width) : 0;
  if (w >= TIER_WIDE_MIN) return 'wide';
  if (w >= TIER_STANDARD_MIN) return 'standard';
  if (w >= TIER_NARROW_MIN) return 'narrow';
  return 'tight';
}

// --- the five row kinds plus `gap` (§3.1.3) -----------------------------------------------------

/**
 * §6.2 lands `'added' | 'removed' | 'hunk' | 'diffMeta'` on `ColorRole` (S5's `theme.ts`, W1). Until it does this
 * union widens `ColorRole` by exactly those four names; the day they land it COLLAPSES to `ColorRole` with no edit
 * here and no edit at any call site. `isColorRole` is the runtime narrowing every renderer uses meanwhile.
 */
export type BlockRole = ColorRole | 'added' | 'removed' | 'hunk' | 'diffMeta';

/** §3.1.6: is this role one `theme.ts` already knows (so `textProps` accepts it)? */
export function isColorRole(role: BlockRole, known: readonly string[]): role is ColorRole {
  return known.includes(role);
}

export type BlockRow =
  | {
      kind: 'kv';
      key: string;
      value: string;
      role?: BlockRole;
      /** §3.1.5: a path elides LEFT */ path?: true;
      /**
       * §3.1.5: the value carries an IDENTIFIER (a run id, a session id, a copy-pasteable `--resume` command), so
       * it is **never elided** — the row wraps instead, and in the `narrow` tier it falls back to the stacked
       * `tight` shape when that is what gives the token room. A hard split is the last resort at widths where the
       * token alone exceeds the whole row: it is lossless (every character is still on screen), an elision is not.
       */
      id?: true;
    }
  /**
   * `wrap: false` is the PRE-BUILT line form (`textRows`): one row per segment, elided right, never re-wrapped and
   * never ` · `-packed — a pane builder, `/help`, `/why` and `/diff <step>` already built their rows at the width,
   * and re-wrapping them destroys their alignment (a wrapped diff line is a lie, §3.3).
   */
  | {
      kind: 'facts';
      segments: readonly string[];
      role?: BlockRole;
      wrap?: false;
    }
  | {
      kind: 'table';
      cells: readonly string[];
      header?: true;
      align?: readonly ('l' | 'r')[];
      role?: BlockRole;
    }
  | { kind: 'rule'; caption?: string }
  /** `flush` is §3.1.5's footer shape — dim, but at the body column instead of indented 2 (F-B3, F-B4) */
  | { kind: 'note'; text: string; role?: BlockRole; flush?: true }
  | { kind: 'gap' };

/**
 * A rendered row: the text is final (already wrapped, already truncated) and `role` is its colour — `null` is
 * §3.1.6's "everything else: default", which is exactly what `Transcript.tsx` paints a detail row with no props.
 */
export interface RenderedRow {
  text: string;
  role: BlockRole | null;
}

export interface RenderBlockOptions {
  /**
   * §3.1.6: the block declares its syntax and ONLY then are raw rows classified — a `/why` body line that happens to
   * start with `+` is never painted green.
   */
  syntax?: 'diff';
  /** §3.1.5: rows beyond the cap are dropped and the footer names the command that shows them. */
  max?: number;
  /** the footer text when `max` elided rows — `… +<n> more · /diff --all`; `<n>` is substituted for `{n}`. */
  moreFooter?: string;
  /**
   * §3.3: a builder that sizes its own columns (`/config`: `setting` = min(28, longest)) pins the INNER widths
   * here; two cells of gap still separate them. Absent = the natural widths of the block's own table rows.
   */
  tableCols?: readonly number[];
  /**
   * §3.3 edge 4 (`/config`): the number of TRAILING `BlockRow`s the cap may never drop — `/config`'s
   * `rule`+`facts` sandbox footer is a security statement, and a cap that ate it (measured: the 40-column
   * snapshot ended `╶──── sandbox` with the facts row gone, and `--all` could not show it either) is a defect.
   */
  protectTail?: number;
}

// --- text helpers --------------------------------------------------------------------------------

/** §3.1.5: prose elides RIGHT with `…` (the glyph set's ellipsis under `--ascii`). */
export function elideRight(text: string, width: number, g: GlyphSet): string {
  if (width <= 0) return '';
  if (cellWidth(text) <= width) return text;
  return truncateCells(text, width, g);
}

/**
 * §3.3 edge 4: the iteration units of a reverse walk — grapheme clusters when a joiner is present (the rule
 * `glyphs.ts` `units` applies to `truncateCells`), code points otherwise. NEVER UTF-16 code units: a budget that
 * landed inside a surrogate pair used to emit a lone surrogate into stdout, `transcript.log` and `--json`.
 */
const JOINER_RE = /[\u200d\ufe0f\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}]/u;
function unitsOf(text: string): string[] {
  if (!JOINER_RE.test(text)) return [...text];
  try {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((x) => x.segment);
  } catch {
    return [...text];
  }
}

/**
 * §3.1.5: a path elides LEFT — `…/T/a3-ws/src/app.py` — so the leaf stays readable. §3.3 edge 4: the walk is by
 * GRAPHEME UNIT (`unitsOf`), and a kept tail never begins with a zero-width unit, so neither a lone surrogate nor
 * an orphan combining mark can reach a sink.
 */
export function elideLeft(text: string, width: number, g: GlyphSet): string {
  if (width <= 0) return '';
  if (cellWidth(text) <= width) return text;
  const mark = g.ellipsis;
  const room = width - cellWidth(mark);
  if (room <= 0) return truncateCells(text, width, g);
  // keep the LAST `room` cells, whole units only
  const units = unitsOf(text);
  const kept: string[] = [];
  let used = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i]!;
    const w = cellWidth(u);
    if (used + w > room) break;
    kept.unshift(u);
    used += w;
  }
  // a combining mark whose base was cut is an ORPHAN: drop every leading zero-width unit
  while (kept.length > 0 && cellWidth(kept[0]!) === 0) kept.shift();
  return `${mark}${kept.join('')}`;
}

/** §3.3 edge 5: a value carrying a newline or a control byte is one line before it is measured. */
export function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[\r\n\t]+/g, ' ');
}

/**
 * §3.1.6: the classifier for rows that arrive as raw strings. It runs ONLY when the block declared its syntax.
 * Returns null when the row has no role of its own (the caller keeps the default).
 */
export function detailRole(text: string, syntax: RenderBlockOptions['syntax']): BlockRole | null {
  if (syntax !== 'diff') return null;
  if (/^(diff --git |index |--- |\+\+\+ )/.test(text)) return 'diffMeta';
  if (text.startsWith('@@')) return 'hunk';
  if (text.startsWith('+')) return 'added';
  if (text.startsWith('-')) return 'removed';
  return null;
}

// --- wrapping ------------------------------------------------------------------------------------

/**
 * Hard-wrap on cell width at word boundaries, breaking a word only when it alone exceeds the width — and, with
 * `breakLong: false` (§3.1.5's identifier rule), not even then: the over-long token owns its row whole.
 */
function wrapCells(text: string, width: number, breakLong = true): string[] {
  if (width <= 0) return [''];
  // a row that already fits is returned VERBATIM — the column runs inside it (`<dir>  (files)`, `report <id>   (…)`)
  // are alignment, and collapsing them would silently re-format every row that did not need wrapping
  if (cellWidth(text) <= width) return [text];
  // split KEEPING the space runs, so an alignment gap inside a row that does wrap survives on its own row
  const parts = text.split(/( +)/).filter((p) => p !== '');
  const out: string[] = [];
  let line = '';
  let gap = '';
  const breakLine = (): void => {
    if (line !== '') out.push(line);
    line = '';
    gap = '';
  };
  for (const part of parts) {
    if (/^ +$/.test(part)) {
      if (line !== '') gap += part;
      continue;
    }
    const candidate = `${line}${gap}${part}`;
    if (cellWidth(candidate) <= width) {
      line = candidate;
      gap = '';
      continue;
    }
    breakLine();
    if (cellWidth(part) <= width || !breakLong) {
      // §3.1.5: an identifier is never cut — it owns its row even when it overflows, and the caller decides
      line = part;
      continue;
    }
    // one word longer than the whole width: cut it into width-sized pieces (never silently lost)
    let rest = part;
    while (cellWidth(rest) > width) {
      let piece = '';
      let i = 0;
      while (i < rest.length && cellWidth(piece + rest[i]!) <= width) piece += rest[i++]!;
      if (piece === '') break;
      out.push(piece);
      rest = rest.slice(piece.length);
    }
    line = rest;
  }
  breakLine();
  return out.length > 0 ? out : [''];
}

/**
 * §3.1.3 / TD3 rule 3: pack ` · `-separated segments into rows of at most `width`, with an optional continuation
 * prefix. A segment longer than the width is wrapped rather than dropped.
 */
function packSegments(segments: readonly string[], width: number, g: GlyphSet, contPrefix: string): string[] {
  const sep = ` ${g.dot} `;
  const out: string[] = [];
  let line = '';
  let first = true;
  const flush = (): void => {
    if (line !== '') out.push(line);
    line = '';
  };
  const prefixOf = (): string => (first ? '' : contPrefix);
  for (const raw of segments) {
    const seg = oneLine(raw);
    if (seg === '') continue;
    const candidate = line === '' ? `${prefixOf()}${seg}` : `${line}${sep}${seg}`;
    if (cellWidth(candidate) <= width) {
      line = candidate;
      continue;
    }
    flush();
    first = false;
    const head = `${contPrefix}${seg}`;
    if (cellWidth(head) <= width) {
      line = head;
      continue;
    }
    for (const piece of wrapCells(head, width)) out.push(piece);
    line = '';
  }
  flush();
  return out.length > 0 ? out : [''];
}

// --- the table pass -------------------------------------------------------------------------------

/** §3.1.2's tier table: how many columns a table keeps. */
function tableColumns(tier: BlockTier): number {
  if (tier === 'tight') return 1;
  if (tier === 'narrow') return 2;
  if (tier === 'standard') return 3;
  return 4;
}

interface TableLayout {
  widths: readonly number[];
  keep: number;
}

/** One layout for EVERY table row of the block — `renderBlock` never changes the key column inside one block. */
function layoutTable(rows: readonly BlockRow[], width: number, tier: BlockTier, pinned?: readonly number[]): TableLayout {
  if (pinned !== undefined && pinned.length > 0) return { widths: pinned, keep: pinned.length };
  const tables = rows.filter((r): r is Extract<BlockRow, { kind: 'table' }> => r.kind === 'table');
  const cols = Math.max(...tables.map((r) => r.cells.length), 0);
  const keep = Math.max(1, Math.min(cols, tableColumns(tier)));
  const natural: number[] = [];
  for (let c = 0; c < keep; c++) natural.push(Math.max(1, ...tables.map((r) => cellWidth(oneLine(r.cells[c] ?? '')))));
  // shrink from the right until the row fits: gaps are two cells between columns
  const gaps = 2 * Math.max(0, keep - 1);
  let total = natural.reduce((a, b) => a + b, 0) + gaps;
  for (let c = keep - 1; c >= 0 && total > width; c--) {
    const room = Math.max(1, natural[c]! - (total - width));
    total -= natural[c]! - room;
    natural[c] = room;
  }
  return { widths: natural, keep };
}

// --- renderBlock ------------------------------------------------------------------------------------

/**
 * §3.1.3: the one renderer. Pure — column arithmetic, the ` · ` / hanging-indent wrap of TD3 rule 3 and the
 * truncation of §3.1.5 — returning PRE-SPLIT rows, one `<Text>` per row (which also removes Ink's trailing-space
 * artefact). A `gap` as the first or last row is dropped; two consecutive gaps collapse to one.
 */
export function renderBlock(rows: readonly BlockRow[], width: number, g: GlyphSet = GLYPHS.unicode, opts: RenderBlockOptions = {}): RenderedRow[] {
  const w = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
  const tier = blockTier(w);
  const table = layoutTable(rows, w, tier, opts.tableCols);
  // §3.3 edge 4: the trailing rows a cap may never drop (`/config`'s sandbox statement) are rendered AFTER the cap
  const protect = Math.max(0, Math.min(rows.length, Math.floor(opts.protectTail ?? 0)));
  const out: RenderedRow[] = [];
  // §3.3 edge 6: a rendered row never ends in a space — trailing padding is not alignment, it is Ink's artefact
  // (and at width 1 an indented `note` would otherwise be a single space)
  const push = (text: string, role: BlockRole | null): void => {
    out.push({ text: elideRight(text, w, g).replace(/\s+$/, ''), role });
  };

  const render = (list: readonly BlockRow[]): void => {
    for (const row of list) {
      switch (row.kind) {
        case 'gap':
          // dropped at the head of a block, collapsed after another gap; the tail is trimmed below
          if (out.length > 0 && out[out.length - 1]!.text !== '') out.push({ text: '', role: null });
          break;
        case 'rule': {
          const caption = row.caption === undefined || row.caption === '' ? '' : ` ${oneLine(row.caption)}`;
          push(`${g.fence}${g.rule.repeat(4)}${caption}`, 'code');
          break;
        }
        case 'note': {
          const text = oneLine(row.text);
          const indent = row.flush === true ? '' : '  ';
          for (const line of wrapCells(text, Math.max(1, w - indent.length))) push(`${indent}${line}`, row.role ?? 'dim');
          break;
        }
        case 'kv': {
          const key = oneLine(row.key);
          const value = oneLine(row.value);
          const role = row.role ?? null;
          const keyCells = cellWidth(key);
          const isId = row.id === true;
          const col = KV_KEY_COL + 1;
          // §3.1.5: an identifier row falls back to the stacked shape as soon as the three-column value field cannot
          // hold its widest token — the 10-cell key field is exactly what makes a run id not fit at 34–59 cells
          const widestToken = isId ? Math.max(0, ...value.split(' ').map((t) => cellWidth(t))) : 0;
          const stack = tier === 'tight' || keyCells > KV_KEY_COL || (isId && widestToken > w - col);
          // §3.3 edge 3 / §3.1.2 tight tier: the key keeps its own dim row and the value is indented 2
          if (stack) {
            push(key, 'dim');
            const room = Math.max(1, w - 2);
            const lines = row.path === true ? [elideLeft(value, room, g)] : wrapCells(value, room, !isId);
            for (const line of lines) push(`  ${line}`, role);
            break;
          }
          // §3.1.3 `key.padEnd(10)` + a one-cell separator, so the value column is 11 — the column every F-B frame
          // draws (`run        20260922…`, `per step   p50 …`, `session    $0.04 …`, `workspace  ~/T/…`).
          const room = Math.max(1, w - col);
          if (row.path === true) {
            push(`${padEndCells(key, col)}${elideLeft(value, room, g)}`, role);
            break;
          }
          // §3.1.2: narrow elides; standard and wide wrap UNDER the value column, never to column 0.
          // §3.1.5: an IDENTIFIER is never elided — it wraps here too, under the value column.
          if (tier === 'narrow' && !isId) {
            push(`${padEndCells(key, col)}${elideRight(value, room, g)}`, role);
            break;
          }
          const lines = wrapCells(value, room, !isId);
          push(`${padEndCells(key, col)}${lines[0] ?? ''}`, role);
          for (const line of lines.slice(1)) push(`${' '.repeat(col)}${line}`, role);
          break;
        }
        case 'facts': {
          const role = row.role ?? null;
          if (row.wrap === false) {
            // §3.1.6: a row that arrived as a RAW STRING is classified here, and ONLY because the block DECLARED
            // its syntax — a `/why` body line that happens to start with `+` is never painted green
            for (const raw of row.segments) {
              const text = oneLine(raw);
              push(text, role ?? detailRole(text, opts.syntax));
            }
            break;
          }
          if (tier === 'tight') {
            for (const raw of row.segments) {
              const seg = oneLine(raw);
              if (seg === '') continue;
              // §3.3: wrap the SEGMENT and prefix the bullet onto the first produced row only — prefixing first left
              // a dangling `·` on a row of its own whenever the segment was one token wider than the body
              const [first, ...rest] = wrapCells(seg, Math.max(1, w - 2));
              push(`${g.dot} ${first ?? ''}`, role);
              for (const line of rest) push(`  ${line}`, role);
            }
            break;
          }
          const cont = tier === 'narrow' ? `${g.dot} ` : '';
          for (const line of packSegments(row.segments, w, g, cont)) push(line, role);
          break;
        }
        case 'table': {
          const cells = row.cells.map(oneLine);
          const role: BlockRole | null = row.role ?? (row.header === true ? 'dim' : null);
          if (tier === 'tight') {
            // the key row, then the value indented 2 (F-B4)
            push(cells[0] ?? '', row.header === true ? 'dim' : 'dim');
            const rest = cells
              .slice(1)
              .filter((c) => c !== '')
              .join('  ');
            if (rest !== '') for (const line of wrapCells(rest, Math.max(1, w - 2))) push(`  ${line}`, role);
            break;
          }
          const parts: string[] = [];
          for (let c = 0; c < table.keep; c++) {
            const cw = table.widths[c] ?? 1;
            const raw = cells[c] ?? '';
            const fitted = elideRight(raw, cw, g);
            const right = (row.align?.[c] ?? 'l') === 'r';
            parts.push(c === table.keep - 1 && !right ? fitted : right ? padStartCells(fitted, cw) : padEndCells(fitted, cw));
          }
          const dropped = cells.length - table.keep;
          const text = parts.join('  ').replace(/\s+$/, '');
          push(dropped > 0 && tier === 'narrow' && row.header === true ? text : text, role);
          break;
        }
        default: {
          // exhaustiveness: every BlockRow kind is handled above
          const never: never = row;
          throw new Error(`unhandled block row ${JSON.stringify(never)}`);
        }
      }
    }
  };
  const trimTail = (): void => {
    // a gap as the LAST row is dropped (the block has its own blanks)
    while (out.length > 0 && out[out.length - 1]!.text === '') out.pop();
  };

  render(protect > 0 ? rows.slice(0, rows.length - protect) : rows);
  trimTail();

  // §3.1.5: rows beyond the cap, and the one dim footer that names where the rest is
  const max = opts.max;
  if (typeof max === 'number' && max >= 0 && out.length > max) {
    const dropped = out.length - max;
    out.length = max;
    out.push({
      text: cappedFooter(opts.moreFooter, dropped, w, g),
      role: 'dim',
    });
  }
  if (protect > 0) {
    render(rows.slice(rows.length - protect));
    trimTail();
  }
  return out;
}

/**
 * §2.6's rung rule applied to §3.1.5's footer: the footer is the row that says where the rest of the block is, so
 * it is LADDERED down to something true rather than elided into `… +11 more rows (/config --al…` (measured, the
 * committed 40-column snapshot). The rungs are the caller's text, then the same text without its trailing clause,
 * then §12's bare `… +<n> more rows`, then `… +<n>`.
 */
export function cappedFooter(moreFooter: string | undefined, dropped: number, width: number, g: GlyphSet): string {
  const sub = (t: string): string => t.replaceAll('{n}', String(dropped));
  const rungs: string[] = [];
  if (moreFooter !== undefined && moreFooter !== '') {
    rungs.push(sub(moreFooter));
    // drop one trailing clause: ` (…)` or ` · …`
    const shorter = sub(moreFooter)
      .replace(/\s*\([^()]*\)\s*$/, '')
      .replace(/\s+[·]\s+[^·]*$/, '');
    if (shorter !== rungs[0]) rungs.push(shorter);
  }
  rungs.push(`${g.ellipsis} +${dropped} more rows`, `${g.ellipsis} +${dropped}`);
  for (const r of rungs) if (cellWidth(r) <= width) return r;
  return elideRight(rungs[rungs.length - 1]!, width, g);
}

/**
 * §3.3: adapt an ALREADY-BUILT line list (a pane builder, `/help`, `/why`, `/calibration`, `/diff <step>`) to rows
 * without reformatting it — each line is one flush, default-role row and a blank line is a `gap`. The lines must
 * already have been built at `blockWidth(columns)`; `renderBlock` only enforces the ceiling.
 */
export function textRows(lines: readonly string[]): BlockRow[] {
  return lines.map((l) => (l.trim() === '' ? { kind: 'gap' } : { kind: 'facts', segments: [l], wrap: false }));
}

/**
 * §3.1.5 "block caps": the row cap of each block that has one, in one table. `/decisions` is `n` (the user asks
 * for the count) and every other command is uncapped.
 */
export const BLOCK_CAPS = {
  config: 24,
  help: 60,
  plan: 40,
  diff: 42,
  /**
   * §3.1.5 names `WHY_MAX_LINES` as the source of truth for `/why`'s cap, and `WHY_MAX_LINES` is 60 — the earlier
   * `24` here contradicted the very constant the row cites, and `whyBlock` already emits its own
   * `…[<n> lines omitted]` marker at that bound. `test/unit/tui/why.test.ts` pins the two equal.
   */
  why: 60,
  calibration: 19,
  errors: 12,
} as const;

/** §3.5 edge 2: `transcript.log` is a support artefact, not a pager mirror — a live block logs at most this many rows. */
export const BLOCK_LOG_MAX = 24;

/** §3.5: the rendered row TEXTS — what `--plain`, `annotateBlock` and the TUI detail body all walk. */
export function blockTexts(rows: readonly BlockRow[], width: number, g: GlyphSet = GLYPHS.unicode, opts: RenderBlockOptions = {}): string[] {
  return renderBlock(rows, width, g, opts).map((r) => r.text);
}
