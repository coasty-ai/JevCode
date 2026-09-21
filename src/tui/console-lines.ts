/**
 * The console (TUI-DESIGN-2 §4.3, §4.8, §10.3): in the boxed tier (rows ≥ 16, columns ≥ 40, no screen reader) the
 * composer and the status bar share one rounded box — top edge `╭─ <badge>[ · next run] ──…── <dir> ─╮` (a hosted
 * title such as `setup · generator key` or `sessions · filter` replaces the badge), the hosted secret-gate row, the
 * composer rows (`› ` on row 0, two spaces on continuations), the divider `├──┤`, `statusLineText(state, W)` and the
 * bottom edge `╰──╯`, at the inner width `W = columns − 4`. These are the shared `lines()` for Ink (`Console.tsx`),
 * the frame tests and `--ascii`; text rows, never `<Box borderStyle>`, because every row must exist as a string
 * (§10.3). Every row is exactly `columns` cells. Pure.
 */
import { cardBottom, cardRow, cardTop } from './card.js';
import { GLYPHS, cellWidth, truncateCells, type GlyphSet } from './glyphs.js';

/** `╭─ ` + badge + ` ` + fill + ` ` + dir + ` ─╮`: the cells the badge and the dir do not take. */
const TOP_EDGE_FIXED = 8;
/** the shortest fill between the badge and the dir before the dir is cut, then dropped */
const MIN_TOP_FILL = 1;

/** TUI-DESIGN-2 §4.3: the inner width of the console — `columns − 4` (the two edge glyphs and their spaces), never below 1. */
export function consoleInnerWidth(columns: number): number {
  return Math.max(1, (Number.isFinite(columns) ? Math.floor(columns) : 0) - 4);
}

/** The five parts of the top edge, so the Ink twin can colour the badge without re-deriving the string (`join` = `consoleTopEdge`). */
export interface ConsoleTopEdgeParts {
  left: string;
  badge: string;
  fill: string;
  dir: string;
  right: string;
}

/** TUI-DESIGN-2 §4.3: `╭─ <badge or title> ──…── <dir> ─╮` as parts; the dir is cut, then dropped, before the fill would go negative; a long badge is cut like a card title. */
export function consoleTopEdgeParts(badgeOrTitle: string, dir: string, columns: number, g: GlyphSet = GLYPHS.unicode): ConsoleTopEdgeParts {
  const w = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  const bare = (): ConsoleTopEdgeParts => ({ left: '', badge: cardTop(badgeOrTitle, w, g), fill: '', dir: '', right: '' });
  if (w < 4 || dir === '') return bare();
  const badge = truncateCells(badgeOrTitle, Math.max(0, w - TOP_EDGE_FIXED - MIN_TOP_FILL), g);
  const bw = cellWidth(badge);
  const room = w - TOP_EDGE_FIXED - bw - MIN_TOP_FILL;
  if (room < 1) return bare();
  const d = truncateCells(dir, room, g);
  if (d === '') return bare();
  const fill = w - TOP_EDGE_FIXED - bw - cellWidth(d);
  return { left: `${g.roundTopLeft}${g.rule} `, badge, fill: ` ${g.rule.repeat(fill)} `, dir: d, right: ` ${g.rule}${g.roundTopRight}` };
}

/** TUI-DESIGN-2 §4.3: the top edge as one string of exactly `columns` cells. */
export function consoleTopEdge(badgeOrTitle: string, dir: string, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  const p = consoleTopEdgeParts(badgeOrTitle, dir, columns, g);
  return `${p.left}${p.badge}${p.fill}${p.dir}${p.right}`;
}

/** TUI-DESIGN-2 §4.3: `│ ` + fitCells(text, columns − 4) + ` │`. */
export function consoleRow(text: string, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  return cardRow(text, columns, g);
}

/** TUI-DESIGN-2 §4.3: the divider between the composer and the status compartment `├──…──┤`. */
export function consoleDivider(columns: number, g: GlyphSet = GLYPHS.unicode): string {
  const w = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  if (w === 0) return '';
  if (w < 4) return g.rule.repeat(w);
  return `${g.teeLeft}${g.rule.repeat(w - 2)}${g.teeRight}`;
}

/** TUI-DESIGN-2 §4.3: the bottom edge `╰──…──╯`. */
export function consoleBottom(columns: number, g: GlyphSet = GLYPHS.unicode): string {
  return cardBottom(columns, g);
}

export interface ConsoleInput {
  columns: number;
  /** the mode badge (`jev-only`, `jev+llm · next run`) — replaced by `title` when a hosted flow owns the console */
  badge: string;
  /** the workspace basename, right-aligned in the top edge ('' drops it) */
  dir: string;
  /** `setup · generator key`, `sessions · filter`, … (TUI-DESIGN-2 §12 "Console") */
  title?: string | null;
  /** the composer rows (or the wizard's rows), already prefixed */
  body: readonly string[];
  /** the hosted secret-gate row above the draft (boxed tier only, §4.2) */
  gate?: string | null;
  /** `statusLineText(state, consoleInnerWidth(columns))` */
  status: string;
  glyphs?: GlyphSet;
}

/** TUI-DESIGN-2 §4.3: top, gate?, body…, divider, status, bottom — `body.length + (gate ? 1 : 0) + 4` rows, each exactly `columns` cells. */
export function consoleLines(i: ConsoleInput): string[] {
  const g = i.glyphs ?? GLYPHS.unicode;
  const head = i.title !== undefined && i.title !== null && i.title !== '' ? i.title : i.badge;
  const out: string[] = [consoleTopEdge(head, i.dir, i.columns, g)];
  if (i.gate !== undefined && i.gate !== null) out.push(consoleRow(i.gate, i.columns, g));
  for (const b of i.body) out.push(consoleRow(b, i.columns, g));
  out.push(consoleDivider(i.columns, g), consoleRow(i.status, i.columns, g), consoleBottom(i.columns, g));
  return out;
}
