/**
 * `diffRows()` — the **one** diff renderer (TUI-DESIGN-4 §6.2, D-Z). The review card, the `<Static>` detail body
 * (`detailKind: 'diff'`) and `/diff <step>` all come through here, so a removed and an added line can never look
 * identical again (A6-3) and the `diff --git` / `index` / `---` / `+++` plumbing can never eat 6 of a card's 8
 * preview rows again (A6-8).
 *
 * Every row carries its kind, so the renderer maps it to one of §6.2's four colour roles (`added` / `removed` /
 * `hunk` / `diffMeta`) — and **every role's marker is already in the text** (`+`, `-`, `@@`, `···`), so `NO_COLOR`,
 * `--no-color` and `TERM=dumb` lose nothing. Pure and ink-free; no row is ever wrapped and no row is ever wider
 * than `columns`.
 *
 * Two safety rules this module owns, because a diff is **model-authored text** on its way to a terminal and the
 * card, the `--plain` confirmer's stdout and the screen reader all build from the raw action now:
 * every cell passes `sanitiseCell` (C0/DEL/C1 → `·`, so `\u001b[2J` can never clear the screen from inside a card
 * row — the invariant `plain.test.ts` pins as "a command cannot drive the terminal"), and every path passes
 * `safePath` inside the **shared** header parser of `./text.ts`, so `diffRows` and `patchTouches` can never name
 * the same file two different ways (§14.2 review items 1, 2, 16).
 */
import { GLYPHS, cellWidth, padStartCells, truncateCells, type GlyphSet } from '../glyphs.js';
import { fileTouchText, finishTouch, newTouchDraft, type FileTouch, type TouchDraft } from './summary.js';
import { NO_EOL_TEXT, expandTabs, headerPath, parseDiffGitLine, sanitiseCell, sectionPath } from './text.js';

export { expandTabs };

export type DiffRowKind = 'file' | 'hunk' | 'add' | 'del' | 'ctx' | 'meta' | 'more';

export interface DiffRow {
  kind: DiffRowKind;
  /** the finished row, already cut to `columns` cells and free of tabs and control characters */
  text: string;
  /** the line number on the old side, or null where that side has no line */
  oldNo: number | null;
  newNo: number | null;
  /** only on a `more` row: how many rows were not produced (§6.2 edge 15) */
  hidden?: number;
  /**
   * §6.2 edge 2 / §6.10: this row is one half of a `-`/`+` pair that differs **only** in trailing whitespace. The
   * flag is decided on the *parsed* bodies and exposed because the screen-reader twin has to speak one sentence
   * (`line 13 changed: trailing whitespace removed`) instead of two identical ones — and it cannot re-derive it
   * from `text`, which already carries `markTrailing`'s `·` cells (§14.2 review item 10).
   */
  wsOnly?: true;
}

export interface DiffRowsOptions {
  columns: number;
  /** hard cap on produced rows; the last one becomes the `more` row when anything was dropped */
  maxRows: number;
  g?: GlyphSet;
  /** §6.2: two number columns at ≥ 60 columns, the new side alone from 20, none below (and none at all when false) */
  lineNumbers?: boolean;
  /** `counts` (default) `M calc/ops.py  +12 −3` · `fence` `╶──── calc/ops.py` (F-E1, §3.6's proposal preview) · `none` when the caller drew its own header */
  fileRow?: 'counts' | 'fence' | 'none';
  /** §6.3 item 2: the card shows the summary block for every file but the hunks of the **first** file only */
  firstFileOnly?: boolean;
  /** §6.3 edge 8: a file on the secret denylist shows its row and one `content withheld (secret path)` row, never a line of it */
  withhold?: (path: string) => boolean;
}

/** §6.2: the two-column form needs this many columns; below it the old side drops. */
export const DIFF_TWO_COLUMN_MIN = 60;
/** §6.2 edge 12: below this the numbers and the `│` separator drop and a row is sign + text. */
export const DIFF_NUMBERS_MIN = 20;
/** §6.2: each number column is at least this wide — three cells, so the `old` / `new` heading row aligns with them. */
export const DIFF_NUMBER_MIN_CELLS = 3;
/** §6.3 edge 8 / §12: the one row a withheld file's body becomes. */
export const WITHHELD_ROW_TEXT = 'content withheld (secret path)';
/** A cut row keeps at least this much text before the `(+N chars)` tail is worth printing (§6.2 edge 5). */
const CUT_MIN_CELLS = 8;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** §6.2 edge 2: trailing whitespace made visible, for the one case where it is the whole change. */
function markTrailing(s: string): string {
  const m = /[ \t]+$/.exec(s);
  if (m === null) return s;
  return s.slice(0, m.index) + '·'.repeat(m[0].length);
}

// ---------------------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------------------

interface Body {
  sign: ' ' | '+' | '-';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}
type Unit = { k: 'file'; touch: FileTouch } | { k: 'hunk'; text: string; section: string } | { k: 'meta'; text: string } | ({ k: 'body' } & Body);

/** One file section: the header fields `finishTouch` reads, plus the rows the section produced, in order. */
interface Section extends TouchDraft {
  units: Unit[];
}

function newSection(): Section {
  return { ...newTouchDraft(), units: [] };
}

/**
 * One pass: the units of the diff in order. The parser is **section-oriented** — a `diff --git` (or a `---` that
 * follows a body) closes the section and opens the next — so a rename or a copy that also has hunks yields exactly
 * ONE `file` row with the right letter and the right counts (it used to yield two, the first `A +0 −0`, which made
 * the card's `firstFileOnly` mode show the bogus row and no diff body at all), and a section with **no** hunks at
 * all — a binary patch, a mode-only change — still yields its `file` row instead of nothing (§14.2 items 3, 4).
 */
function parseUnits(diff: string): Unit[] {
  const out: Unit[] = [];
  let sec: Section | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;

  const need = (): Section => (sec ??= newSection());
  const peek = (): Section | null => sec;
  const close = (): void => {
    const s = sec;
    sec = null;
    if (s === null) return;
    const touch = finishTouch(s);
    if (touch !== null) out.push({ k: 'file', touch });
    out.push(...s.units);
  };

  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      const ch = line.charAt(0);
      const s = need();
      if (ch === ' ' || line.length === 0) {
        oldLeft--;
        newLeft--;
        s.units.push({ k: 'body', sign: ' ', text: line.slice(1), oldNo: ++oldNo, newNo: ++newNo });
        continue;
      }
      if (ch === '-') {
        oldLeft--;
        s.deleted++;
        s.units.push({ k: 'body', sign: '-', text: line.slice(1), oldNo: ++oldNo, newNo: null });
        continue;
      }
      if (ch === '+') {
        newLeft--;
        s.added++;
        s.units.push({ k: 'body', sign: '+', text: line.slice(1), oldNo: null, newNo: ++newNo });
        continue;
      }
      if (ch === '\\') {
        // §6.2 edge 8: git's own text, kept verbatim — it does not consume a counted body line
        s.units.push({ k: 'meta', text: NO_EOL_TEXT });
        continue;
      }
      // §6.2 edge 10: a malformed hunk ends here; numbering stops until the next `@@`
      oldLeft = 0;
      newLeft = 0;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      const s = need();
      oldNo = Number(hunk[1]) - 1;
      newNo = Number(hunk[3]) - 1;
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      s.bodySeen = true;
      s.units.push({ k: 'hunk', text: `@@ -${hunk[1]}${hunk[2] === undefined ? '' : `,${hunk[2]}`} +${hunk[3]}${hunk[4] === undefined ? '' : `,${hunk[4]}`} @@`, section: (hunk[5] ?? '').trim() });
      continue;
    }
    if (line.startsWith('@@')) {
      // §6.2 edge 10: `@@` without ranges is a meta row and nothing throws
      need().units.push({ k: 'meta', text: line });
      continue;
    }
    if (line.startsWith('\\ ')) {
      need().units.push({ k: 'meta', text: line });
      continue;
    }
    if (line.startsWith('diff --git ')) {
      close();
      const paths = parseDiffGitLine(line);
      const s = need();
      if (paths !== null) {
        s.oldPath = paths.oldPath;
        s.newPath = paths.newPath;
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      // a `---` after a body is the next file's header only when no `diff --git` announced it
      const open = peek();
      if (open !== null && open.bodySeen) close();
      need().oldPath = headerPath(line, '--- ');
      continue;
    }
    if (line.startsWith('+++ ')) {
      need().newPath = headerPath(line, '+++ ');
      continue;
    }
    if (line.startsWith('new file mode ')) need().created = true;
    else if (line.startsWith('deleted file mode ')) need().deletedFile = true;
    else if (line.startsWith('old mode ') || line.startsWith('new mode ')) need().modeSeen = true;
    else if (line.startsWith('rename from ')) need().renameFrom = sectionPath(line.slice('rename from '.length));
    else if (line.startsWith('rename to ')) need().renameTo = sectionPath(line.slice('rename to '.length));
    else if (line.startsWith('copy to ')) {
      // §6.1 edge 4: a copy is a new file at the destination
      const s = need();
      s.renameTo = sectionPath(line.slice('copy to '.length));
      s.created = true;
    } else if (line === 'GIT binary patch' || line.startsWith('Binary files ') || line.startsWith('Binary file ')) need().binary = true;
    else {
      const open = peek();
      if (open !== null && open.binary) {
        const lit = /^(?:literal|delta) (\d+)$/.exec(line);
        if (lit) open.bytes.push(Number(lit[1]));
      }
    }
    // everything else (`index`, `similarity index`, …) is the plumbing §6.2 collapses away
  }
  close();
  return out;
}

// ---------------------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------------------

/** §6.3 item 3 / §6.2 edge 15: the tail row's text. `expandsTo` absent → the bare `…[+N rows]` form. */
export function moreRowText(hidden: number, expandsTo: number | null = null, g: GlyphSet = GLYPHS.unicode): string {
  const n = Math.max(1, Math.floor(hidden));
  return expandsTo === null ? `${g.ellipsis}[+${n} rows]` : `${g.ellipsis}[+${n} rows ${g.dot} e expands to ${expandsTo}]`;
}

function numberMode(columns: number, lineNumbers: boolean): 'both' | 'new' | 'none' {
  if (!lineNumbers) return 'none';
  if (columns >= DIFF_TWO_COLUMN_MIN) return 'both';
  return columns >= DIFF_NUMBERS_MIN ? 'new' : 'none';
}

function digits(n: number): number {
  return String(Math.max(0, Math.floor(n))).length;
}

/**
 * §6.2: the rows of a unified diff at `columns` cells. `[]` for an empty or unparseable diff (edge 14) — the caller
 * then keeps whatever it printed before. Never throws, never wraps, never emits a tab or a control character, and
 * never returns a row wider than `columns`.
 */
export function diffRows(diff: string, o: DiffRowsOptions): DiffRow[] {
  const g = o.g ?? GLYPHS.unicode;
  const columns = Number.isFinite(o.columns) ? Math.max(1, Math.floor(o.columns)) : 80;
  const maxRows = Number.isFinite(o.maxRows) ? Math.max(0, Math.floor(o.maxRows)) : Number.MAX_SAFE_INTEGER;
  if (maxRows === 0 || diff.length === 0) return [];
  const units = parseUnits(diff);
  if (units.length === 0) return [];

  const firstOnly = o.firstFileOnly === true;
  const withhold = o.withhold;
  const kept: Unit[] = [];
  let files = 0;
  let hidingBody = false;
  for (const u of units) {
    if (u.k === 'file') {
      files += 1;
      if (firstOnly && files > 1) break;
      // §6.3 edge 8: a file on the secret denylist shows its row and ONE withheld row — never a line of it
      hidingBody = withhold !== undefined && withhold(u.touch.path);
      kept.push(u);
      if (hidingBody) kept.push({ k: 'meta', text: WITHHELD_ROW_TEXT });
      continue;
    }
    if (hidingBody) continue;
    kept.push(u);
  }

  const mode = numberMode(columns, o.lineNumbers !== false);
  let maxOld = 0;
  let maxNew = 0;
  for (const u of kept) {
    if (u.k !== 'body') continue;
    if (u.oldNo !== null && u.oldNo > maxOld) maxOld = u.oldNo;
    if (u.newNo !== null && u.newNo > maxNew) maxNew = u.newNo;
  }
  // §6.2 edge 11: five- and six-digit line numbers widen both columns and shrink the text column; the row never overflows
  const wOld = Math.max(DIFF_NUMBER_MIN_CELLS, digits(maxOld));
  const wNew = Math.max(DIFF_NUMBER_MIN_CELLS, digits(maxNew));
  const gutter = mode === 'both' ? wOld + 1 + wNew + 1 + cellWidth(g.vbar) : mode === 'new' ? wNew + 1 + cellWidth(g.vbar) : 0;

  // §6.2 edge 2: the whitespace-only pairing is decided on the PARSED bodies — the rendered rows carry their number
  // columns and their sign, so comparing those could never find a pair that differs by whitespace alone. A pair whose
  // two sides are BLANK once trimmed (four spaces removed from an empty line) is the commonest trailing-whitespace
  // diff there is, and is exactly the case the row grammar renders as a bare `-` beside a bare `+`, so it is marked
  // like every other (§14.2 review item 7).
  const wsOnly = new Set<number>();
  for (let i = 0; i + 1 < kept.length; i++) {
    const a = kept[i];
    const b = kept[i + 1];
    if (a === undefined || b === undefined || a.k !== 'body' || b.k !== 'body' || a.sign !== '-' || b.sign !== '+') continue;
    if (a.text === b.text || a.text.trimEnd() !== b.text.trimEnd()) continue;
    wsOnly.add(i);
    wsOnly.add(i + 1);
  }

  const rows: DiffRow[] = [];
  // rows past `maxRows` are counted but never built: a 5 000-line diff costs one pass and `maxRows + 1` strings
  let produced = 0;
  const emit = (make: () => DiffRow): void => {
    if (rows.length <= maxRows) rows.push(make());
    produced += 1;
  };

  // §6.2: in the two-column form the FIRST hunk of a file is introduced by the `old  new` heading instead of its
  // `@@ -a,b +c,d @@` row — the two number columns already say where the reader is, and F-E1's card cannot spare
  // the row. A later hunk keeps its `@@` row: that one marks a jump, which the numbers alone do not. With the
  // columns off (an `edit`, whose numbers are snippet-relative — `diffNumbersAbsolute`) the `@@` row stays: it is
  // the only thing left that is honest about where the reader is.
  let hunksInFile = 0;
  for (const [index, u] of kept.entries()) {
    switch (u.k) {
      case 'file': {
        hunksInFile = 0;
        if (o.fileRow === 'none') break;
        emit(() => {
          const t = u.touch;
          const label = t.from !== null && t.from !== t.path ? `${t.from} ${g.arrow} ${t.path}` : t.path;
          const text = o.fileRow === 'fence' ? `${g.fence}${g.rule.repeat(4)} ${label}` : fileTouchText(t, columns, g);
          return { kind: 'file', text: truncateCells(text, columns, g), oldNo: null, newNo: null };
        });
        break;
      }
      case 'hunk': {
        const first = hunksInFile === 0;
        hunksInFile += 1;
        if (first && mode === 'both') {
          emit(() => ({ kind: 'meta', text: truncateCells(`${padStartCells('old', wOld)} ${padStartCells('new', wNew)}`, columns, g), oldNo: null, newNo: null }));
          break;
        }
        emit(() => ({ kind: 'hunk', text: truncateCells(sanitiseCell(u.section === '' ? u.text : `${u.text} ${u.section}`), columns, g), oldNo: null, newNo: null }));
        break;
      }
      case 'meta':
        emit(() => ({ kind: 'meta', text: truncateCells(sanitiseCell(u.text), columns, g), oldNo: null, newNo: null }));
        break;
      case 'body': {
        const ws = wsOnly.has(index);
        emit(() => {
          const prefix = mode === 'both' ? `${padStartCells(u.oldNo === null ? '' : String(u.oldNo), wOld)} ${padStartCells(u.newNo === null ? '' : String(u.newNo), wNew)} ${g.vbar}` : mode === 'new' ? `${padStartCells(u.newNo === null ? '' : String(u.newNo), wNew)} ${g.vbar}` : '';
          const cell = ws ? markTrailing(sanitiseCell(u.text)) : sanitiseCell(u.text);
          return {
            kind: u.sign === '+' ? 'add' : u.sign === '-' ? 'del' : 'ctx',
            text: `${prefix}${u.sign}${fitBody(cell, Math.max(0, columns - gutter - 1), g)}`,
            oldNo: u.oldNo,
            newNo: u.newNo,
            ...(ws ? { wsOnly: true as const } : {}),
          };
        });
        break;
      }
    }
  }
  if (produced <= maxRows) return rows;
  const out = rows.slice(0, Math.max(0, maxRows - 1));
  const hidden = produced - out.length;
  out.push({ kind: 'more', text: truncateCells(moreRowText(hidden, null, g), columns, g), oldNo: null, newNo: null, hidden });
  return out;
}

/**
 * §6.2 edge 5: a line longer than the row is cut with `…` and, when there is room, a `(+N chars)` tail — never
 * wrapped. The count is derived from the cut that is actually **emitted** (the one at `avail − tailWidth`), not
 * from the wider cut at `avail`, so `shown + N === the original length` exactly; the loop re-runs when the count's
 * own digit width changes the tail (§14.2 review item 11).
 */
function fitBody(body: string, avail: number, g: GlyphSet): string {
  if (avail <= 0) return '';
  if (cellWidth(body) <= avail) return body;
  const shown = truncateCells(body, avail, g);
  let tail = ` (+${body.length} chars)`;
  for (let i = 0; i < 4; i++) {
    const room = avail - cellWidth(tail);
    if (room < CUT_MIN_CELLS) return shown;
    const cut = truncateCells(body, room, g);
    const dropped = body.length - Math.max(0, cut.length - g.ellipsis.length);
    const next = ` (+${dropped} chars)`;
    if (next === tail) return `${cut}${tail}`;
    tail = next;
  }
  return shown;
}
