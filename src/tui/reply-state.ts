/**
 * The agent's streamed reply in the TUI (AGENT-LOOP-DESIGN §9.3–§9.4, §A1; slice S5a; TUI map top change 6): a pure
 * model of the prose between the provider and `<Static>`.
 *
 * The raw stream (`generator:delta`) accumulates in the live buffer — `UiState.live` in agent mode. The reply block above
 * the rule draws that buffer's uncommitted part as `[jevcode]` rows; finished lines move into `<Static>` as `[jevcode]`
 * items drawn by the SAME layout (`proseLayout`), so a line lands in scrollback in exactly the rows it streamed in: the
 * commit moves nothing on screen (zero jump) and clears nothing.
 *
 * Three things commit:
 * - `assistant:text` (the engine's shaper: whole lines, a code block in one piece) commits the buffer up to its last
 *   newline, or all of it for the turn's `final` remainder; the buffer keeps the text after that newline — not a clear;
 * - an OVERFLOW: when the uncommitted rows outgrow the rows the layout grants the block (a long paragraph, a code block
 *   the shaper holds, or a budget that shrank because the composer grew, an overlay opened or the terminal shrank), the
 *   oldest rows commit early — whole lines first, then the finished rows of a line still streaming (they cannot change:
 *   `wrapProse` is prefix-stable), never its last row;
 * - a new turn or the end of the run commits whatever is left.
 *
 * `assistant:reset` (a provider retry after bytes streamed) drops the uncommitted text; the caller adds the dim notice.
 * A committed item carries the whole source line and the display range it draws (`ProseInfo`), which is how a line cut by
 * an overflow commit is drawn as a head and a label-less continuation that together are the line's rows.
 */
import { patternRedact } from '../core/redact.js';
import { GLYPHS, type GlyphSet } from './glyphs.js';
import { LABEL_GUTTER, gutterBodyWidth, gutterIndent, gutterMode, type GutterMode } from './gutter.js';
import { isChatLabel, isRunHeaderItem, sanitizeStream, type ProseInfo, type TranscriptItem } from './plain.js';
import { stringWidth } from './composer/width.js';
import { isFenceLine, parseProse, proseRows, type ProseRole, type ProseRow } from './transcript/markdown.js';

/** The label every prose row carries (one shared label key, so a reply is one contiguous block, §A1 / peer D). */
export const PROSE_LABEL = '[jevcode]' as const;

/** The reply's commit bookkeeping over the live buffer. */
export interface ReplyState {
  /** raw chars at the start of the live buffer already committed as whole lines (each ends with `\n`) */
  readonly done: number;
  /** display chars of the line starting at `done` already committed by an overflow cut */
  readonly offset: number;
  /** the text at `done` is inside an open code fence */
  readonly fence: boolean;
}

export const EMPTY_REPLY: ReplyState = { done: 0, offset: 0, fence: false };

/** The reply block's geometry, from the App's layout: the rows it may take at most and the terminal width. */
export interface ReplyGeometry {
  readonly rows: number;
  readonly columns: number;
}

/** One line of the live buffer as the block draws it (a pseudo-item until it commits). */
export interface PendingLine {
  readonly line: string;
  readonly role: ProseRole;
  /** display offset already committed (the continuation of an overflow cut) */
  readonly from: number;
  /** the buffer's last line, still streaming */
  readonly partial: boolean;
  /** raw offset of this line in the live buffer */
  readonly at: number;
  /** raw length including its `\n` (0 extra for the partial line) */
  readonly length: number;
}

/**
 * The text a line is drawn from, live and committed alike: control characters and a stray CR dropped, format-pattern
 * keys redacted. ONE text, so the reply block's rows, the offsets of an overflow cut and the committed item's rows are
 * in one coordinate space (a key on a line would otherwise shift every cut after it).
 */
function committedLine(line: string): string {
  return patternRedact(sanitizeStream(line).replace(/\r/g, ''));
}

/**
 * The uncommitted lines of `live` under `reply` — every line after `done`, the first one from `offset`, the last one
 * partial. An EMPTY partial line (the buffer ends with its newline) is not drawn: the rows the block shows are then
 * exactly the rows the commit of those lines draws, and the caret sits at the end of the last written line. `line` is
 * the drawn text (`committedLine`); `at` / `length` index the raw buffer.
 */
export function pendingLines(live: string, reply: ReplyState): PendingLine[] {
  if (reply.done >= live.length) return [];
  const rest = live.slice(reply.done);
  const parts = rest.split('\n');
  const closed = parts.length > 1 && parts[parts.length - 1] === '';
  if (closed) parts.pop();
  const out: PendingLine[] = [];
  let fence = reply.fence;
  let at = reply.done;
  parts.forEach((raw, i) => {
    const partial = i === parts.length - 1 && !closed;
    const line = committedLine(raw);
    const role: ProseRole = isFenceLine(line) ? 'fence' : fence ? 'code' : 'text';
    if (role === 'fence') fence = !fence;
    out.push({ line, role, from: i === 0 ? reply.offset : 0, partial, at, length: raw.length + (partial ? 0 : 1) });
    at += raw.length + 1;
  });
  return out;
}

/** A prose pseudo-item (the block) or item (`<Static>`) for one line — `[jevcode]`, kind `chat`, the prose info. */
export function proseItem(key: string, seq: number, step: number | null, info: ProseInfo, text: string): TranscriptItem {
  return { key, seq, step, kind: 'chat', level: 'info', text, label: PROSE_LABEL, prose: info };
}

/** The pseudo-items the reply block draws for the uncommitted text (keys are stable per line position). */
export function pendingItems(live: string, reply: ReplyState, step: number | null): TranscriptItem[] {
  return pendingLines(live, reply).map((p, i) =>
    proseItem(`reply:${i}`, -1, step, { role: p.role, line: p.line, ...(p.from > 0 ? { from: p.from } : {}), ...(p.partial ? { partial: true } : {}) }, p.line),
  );
}

/**
 * The last item the transcript SHOWS — not hidden, not a run header — which the block's first row is spaced and
 * labelled against (`<Transcript>` draws the same predecessor).
 */
export function lastVisibleItem(items: readonly (TranscriptItem & { readonly hidden?: boolean })[]): TranscriptItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.hidden === true || isRunHeaderItem(it)) continue;
    return it;
  }
  return null;
}

/** A prose item's continuation of an earlier cut: no label, no spacer. */
export function isProseContinuation(item: TranscriptItem): boolean {
  return item.prose !== undefined && (item.prose.from ?? 0) > 0;
}

/**
 * The chat spacing rule for a prose row (Transcript.tsx `spacerAbove` for a `[jevcode]` item, restated here so this module
 * stays Ink-free): one blank row above the first row of a reply block — after a `[you]` bubble, a step row, a `[ui]` note —
 * and none inside it. A continuation never has one.
 */
export function proseSpacerAbove(item: TranscriptItem, prev: TranscriptItem | null): boolean {
  if (prev === null || isProseContinuation(item)) return false;
  return !(isChatLabel(item.label) && prev.label === item.label);
}

/** How one prose item is laid out at a terminal width: the spacer, a label row (stacked / flush rungs), the body rows. */
export interface ProseLayout {
  readonly mode: GutterMode;
  readonly spacer: boolean;
  /** the label takes its own row (the `stacked` and `flush` rungs), and this item is not a continuation */
  readonly labelRow: boolean;
  /** the label is drawn in the gutter cell of the first body row (`gutter` rung, not a continuation) */
  readonly labelCell: boolean;
  /** cells before each body row (the gutter plus its space, or the stacked indent) */
  readonly indent: number;
  readonly width: number;
  readonly rows: readonly ProseRow[];
}

/** The body width without geometry (a test with no columns): effectively one row per line. */
const NO_WIDTH = 4096;

/** AGENT-LOOP-DESIGN §9.4: the layout of one prose item — `<Static>` and the reply block both draw from this. */
export function proseLayout(item: TranscriptItem, prev: TranscriptItem | null, columns: number | undefined, g: GlyphSet = GLYPHS.unicode): ProseLayout {
  const info = item.prose ?? { role: 'text' as const, line: item.text };
  const hasWidth = columns !== undefined && Number.isFinite(columns) && columns > 0;
  const mode: GutterMode = hasWidth ? gutterMode(columns) : 'gutter';
  const cont = isProseContinuation(item);
  const labelCells = stringWidth(PROSE_LABEL);
  const width = !hasWidth ? NO_WIDTH : mode === 'gutter' ? gutterBodyWidth(columns, labelCells) : mode === 'stacked' ? Math.max(1, columns - 2) : Math.max(1, columns);
  const indent = !hasWidth ? LABEL_GUTTER : mode === 'gutter' ? gutterIndent(columns, labelCells) : mode === 'stacked' ? 2 : 0;
  const rows = proseRows(info.line, info.role, width, { ...(info.from !== undefined ? { from: info.from } : {}), ...(info.to !== undefined ? { to: info.to } : {}), partial: info.partial === true, glyphs: g });
  return { mode, spacer: proseSpacerAbove(item, prev), labelRow: !cont && mode !== 'gutter', labelCell: !cont && mode === 'gutter', indent, width, rows };
}

/** The terminal rows one prose item takes. */
export function proseLayoutRows(l: ProseLayout): number {
  return (l.spacer ? 1 : 0) + (l.labelRow ? 1 : 0) + l.rows.length;
}

/** The rows the reply block would draw for `items` after `prev`. */
export function pendingRows(items: readonly TranscriptItem[], prev: TranscriptItem | null, columns: number | undefined, g: GlyphSet = GLYPHS.unicode): number {
  let n = 0;
  let p = prev;
  for (const it of items) {
    n += proseLayoutRows(proseLayout(it, p, columns, g));
    p = it;
  }
  return n;
}

/** What a commit hands the reducer: the items to append and the reply / live buffer after them. */
export interface ReplyCommit {
  readonly items: readonly TranscriptItem[];
  readonly reply: ReplyState;
  readonly live: string;
  readonly seq: number;
}

/**
 * A committed prose item. A whole line keeps its source text (what transcript.log prints for it); the two halves of a
 * line an overflow cut split keep the display text they draw, so a dump of the TUI's items reads them as two lines.
 */
function commitItem(step: number | null, seq: number, role: ProseRole, line: string, from: number, to?: number): TranscriptItem {
  const text = from === 0 && to === undefined ? line : parseProse(line, role).display.slice(from, to);
  return proseItem(`${step ?? 'run'}:chat:${seq}`, seq, step, { role, line, ...(from > 0 ? { from } : {}), ...(to !== undefined ? { to } : {}) }, text);
}

/**
 * Commit the lines of `live` from the reply's position up to raw offset `cut` (a line start, or `live.length` for the
 * final remainder): every line becomes one `[jevcode]` item (its first from the reply's offset, a continuation when the
 * line was cut before). The live buffer keeps `live.slice(cut)`.
 */
export function commitThrough(live: string, reply: ReplyState, cut: number, step: number | null, seq: number): ReplyCommit {
  const end = Math.max(reply.done, Math.min(cut, live.length));
  const body = live.slice(reply.done, end);
  if (body === '' && end >= live.length) return { items: [], reply: EMPTY_REPLY, live: live.slice(end), seq };
  if (body === '') {
    // nothing whole to commit (the cut is at the partial line's start); the partial line keeps its offset
    return { items: [], reply: { done: 0, offset: reply.offset, fence: reply.fence }, live: live.slice(end), seq };
  }
  const lines = (body.endsWith('\n') ? body.slice(0, -1) : body).split('\n');
  const items: TranscriptItem[] = [];
  let fence = reply.fence;
  let s = seq;
  lines.forEach((raw, i) => {
    const role: ProseRole = isFenceLine(raw) ? 'fence' : fence ? 'code' : 'text';
    if (role === 'fence') fence = !fence;
    items.push(commitItem(step, s, role, committedLine(raw), i === 0 ? reply.offset : 0));
    s += 1;
  });
  return { items, reply: { done: 0, offset: 0, fence }, live: live.slice(end), seq: s };
}

/** The raw offset an `assistant:text` commits through: the buffer's last line start, or all of it for the `final` remainder. */
export function commitCut(live: string, final: boolean): number {
  return final ? live.length : live.lastIndexOf('\n') + 1;
}

/** A character a format-pattern key can contain (core/redact.ts FORMAT_PATTERNS; chat/stream-redact.ts's KEY_CHAR). */
const KEY_CHAR_RE = /[A-Za-z0-9_-]/;
/** core/redact.ts HEADER_PATTERN's anchors: the value after one spans whitespace. */
const HEADER_ANCHOR_RE = /authorization:|x-api-key:/i;

/**
 * The display offset up to which a line still streaming is final under redaction: a key lives inside one run of key
 * characters, so the trailing run may still grow into one (and turn into the marker), and a header anchor's value may
 * still arrive. An overflow cut of a partial line never falls past it, so no later delta can rewrite a committed row —
 * a key hard-split across rows would otherwise land half raw in the scrollback and shift the continuation.
 */
function stableEnd(display: string): number {
  let end = display.length;
  while (end > 0 && KEY_CHAR_RE.test(display[end - 1]!)) end--;
  const h = display.search(HEADER_ANCHOR_RE);
  return h >= 0 ? Math.min(end, h) : end;
}

/**
 * The overflow commit: when the uncommitted rows exceed `geom.rows`, commit the oldest rows until they fit — whole
 * complete lines first, then the finished rows of the next line (never its last row, which may still change, and never
 * past what redaction may still rewrite). A cut takes at least one body row with the item's spacer / label row: the
 * block must never shed those alone (its tail cut would move every row up one, and the commit of the next row move them
 * back). Returns null when nothing needs to (or can) move.
 */
export function commitOverflow(live: string, reply: ReplyState, geom: ReplyGeometry, prev: TranscriptItem | null, step: number | null, seq: number, g: GlyphSet = GLYPHS.unicode): ReplyCommit | null {
  const cap = Math.max(1, Math.floor(geom.rows));
  const lines = pendingLines(live, reply);
  if (lines.length === 0) return null;
  const items = lines.map((p) => proseItem('', -1, step, { role: p.role, line: p.line, ...(p.from > 0 ? { from: p.from } : {}), ...(p.partial ? { partial: true } : {}) }, p.line));
  const layouts: ProseLayout[] = [];
  let total = 0;
  let p: TranscriptItem | null = prev;
  for (const it of items) {
    const l = proseLayout(it, p, geom.columns, g);
    layouts.push(l);
    total += proseLayoutRows(l);
    p = it;
  }
  let excess = total - cap;
  if (excess <= 0) return null;
  const out: TranscriptItem[] = [];
  let s = seq;
  let done = reply.done;
  let offset = reply.offset;
  let fence = reply.fence;
  for (let i = 0; i < lines.length && excess > 0; i++) {
    const pl = lines[i]!;
    const l = layouts[i]!;
    const n = proseLayoutRows(l);
    const line = pl.line;
    // a complete line goes whole when it cannot be cut (one row) — one row more than needed moves nothing on screen
    if (!pl.partial && (n <= excess || l.rows.length === 1)) {
      out.push(commitItem(step, s, pl.role, line, pl.from));
      s += 1;
      excess -= n;
      done = pl.at + pl.length;
      offset = 0;
      if (pl.role === 'fence') fence = !fence;
      continue;
    }
    // cut inside this line: the spacer and the label row go with the head, with at least one body row; keep at least
    // one body row back; a partial line is cut only where redaction can no longer change the rows before the cut
    const fixed = (l.spacer ? 1 : 0) + (l.labelRow ? 1 : 0);
    let k = Math.min(Math.max(1, excess - fixed), l.rows.length - 1);
    if (pl.partial) {
      const limit = stableEnd(parseProse(line, pl.role, g, true).display);
      while (k > 0 && l.rows[k]!.start > limit) k--;
    }
    if (k <= 0) break;
    const cutAt = l.rows[k]!.start;
    out.push(commitItem(step, s, pl.role, line, pl.from, cutAt));
    s += 1;
    done = pl.at;
    offset = cutAt;
    excess -= fixed + k;
    break;
  }
  if (out.length === 0) return null;
  return { items: out, reply: { done, offset, fence }, live, seq: s };
}
