/**
 * The review box (TUI-DESIGN §6, F6, F-G…F-J, F-X, §24 "Review box"): `reviewHeaderLines(req, n, columns)` from
 * `src/tui/review/lines.ts` is the one header builder (the ladder for n < 8 is the function's, never Ink
 * clipping); the preview is `confirmPreviewLines(req)` through `reviewPreviewLines()` with the
 * `…[k more preview lines · e expands]` tail; the `d` note field replaces row 2 (the keys line) for its lifetime
 * so the single overlay slot is never double-booked (§6.3), and the note's own secret gate renders in that same
 * row. Keys (`y n Esc d e w+digit Ctrl-C`) are resolved by `resolveKey` in `<App>`; this component only draws.
 */
import { Box, Text } from 'ink';
import type { CursorPosition } from 'ink';
import type { ConfirmRequest } from '../core/types.js';
import { NOTE_LABEL } from './composer/Composer.js';
import { stringWidth } from './composer/width.js';
import { GLYPHS, type GlyphSet, truncateCells } from './glyphs.js';
import { confirmPreviewLines } from './plain.js';
import { reviewHeaderLines, reviewPreviewLines } from './review/lines.js';
import { textProps, themeFor, type Theme } from './theme.js';

export { NOTE_LABEL };

/** §6.2: the note field in the header's row 2 — `note (≤ 600, Enter sends, Esc cancels): <text>`; the gate line replaces it while the note's own secret gate is up. */
export interface ReviewNote {
  text: string;
  /** the §4.10 gate row for the note (only `y` sends), null when no hit */
  gate: string | null;
  /** §4.3 / §10.2: detected secret spans of `text` (logical offsets); rendered as `•` cells so no frame carries the bytes */
  spans?: readonly Span[];
}

/** A half-open span in logical-text coordinates (the composer's `Span` shape). */
export interface Span {
  start: number;
  end: number;
}

/** §4.3 / §14.1: the mask glyph — `•` normally, `*` under `--ascii`. */
export function maskGlyphFor(g: GlyphSet): string {
  return g.mode === 'ascii' ? '*' : '•';
}

/**
 * §4.3 / §10.2 / §19.4: every code point inside a hit span becomes mask glyphs of the same cell width (a combining mark
 * masks to nothing), so the masked text keeps the width the cursor arithmetic was computed with. Pure.
 */
export function maskHits(text: string, spans: readonly Span[], glyph = '•'): string {
  if (spans.length === 0 || text.length === 0) return text;
  const inHit = (from: number, to: number): boolean => spans.some((s) => s.start < to && s.end > from);
  let out = '';
  let i = 0;
  for (const cp of text) {
    const len = cp.length;
    out += inHit(i, i + len) ? glyph.repeat(stringWidth(cp)) : cp;
    i += len;
  }
  return out;
}

/** §6.2 / §24: the note field row; the note's detected spans render as `•` cells (the composer's §4.3 rule applies to the note too). */
export function noteFieldRow(note: ReviewNote, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  if (note.gate !== null) return truncateCells(note.gate, columns, g);
  return truncateCells(`${NOTE_LABEL}${maskHits(note.text, note.spans ?? [], maskGlyphFor(g))}`, columns, g);
}

/** §6.1 + §6.2: the header rows, row 2 replaced by the note field while the note is open. Pure. */
export function reviewRows(req: ConfirmRequest, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode, note: ReviewNote | null = null): string[] {
  const n = Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  if (n === 0) return [];
  const lines = reviewHeaderLines(req, n, columns, g);
  if (note !== null && lines.length >= 2) lines[1] = noteFieldRow(note, columns, g);
  return lines;
}

/** §6.1: the preview rows granted by the layout (`confirmPreviewLines(req)` indented, tail when cut). Pure. */
export function reviewPreview(req: ConfirmRequest, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  return reviewPreviewLines(confirmPreviewLines(req), rows, columns, g);
}

/** `LayoutInput.previewWant` for a request (§2.1). */
export function previewWant(req: ConfirmRequest): number {
  return confirmPreviewLines(req).length;
}

export interface ReviewProps {
  req: ConfirmRequest;
  /** header rows granted (`layout.overlay`) */
  rows: number;
  /** preview rows granted (`layout.preview`) */
  previewRows: number;
  columns: number;
  /** the row the header starts on inside the dynamic region (for the note cursor) */
  top: number;
  note?: ReviewNote | null;
  /** the App's single `useCursor` setter; called during render only while the note field is open */
  cursor?: (pos: CursorPosition | undefined) => void;
  glyphs?: GlyphSet;
  theme?: Theme;
  color?: boolean;
}

/** §6: the review header (title and keys in the verdict colour) and the dim preview, as fixed-height truncating rows. */
export function Review(p: ReviewProps): React.JSX.Element | null {
  const g = p.glyphs ?? GLYPHS.unicode;
  const theme = p.theme ?? themeFor('dark');
  const color = p.color ?? true;
  const header = reviewRows(p.req, p.rows, p.columns, g, p.note ?? null);
  const preview = reviewPreview(p.req, p.previewRows, p.columns, g);
  const total = header.length + preview.length;
  if (total === 0) return null;
  const verdict = p.req.risk.verdict === 'block' ? 'block' : 'review';
  if (p.note && p.cursor && header.length >= 2) {
    const x = p.note.gate === null ? Math.min(p.columns - 1, stringWidth(`${NOTE_LABEL}${maskHits(p.note.text, p.note.spans ?? [], maskGlyphFor(g))}`)) : 0;
    p.cursor({ x, y: p.top + 1 });
  }
  return (
    <Box flexDirection="column" height={total} overflow="hidden">
      {header.map((line, i) => (
        <Text key={`h${i}`} wrap="truncate" {...(i === 0 || (i === 1 && !p.note) ? textProps(theme, verdict, color) : i === 1 && p.note?.gate ? textProps(theme, 'secret', color) : {})} bold={i === 1 && !p.note}>
          {line}
        </Text>
      ))}
      {preview.map((line, i) => (
        <Text key={`p${i}`} wrap="truncate" {...textProps(theme, 'dim', color)}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
