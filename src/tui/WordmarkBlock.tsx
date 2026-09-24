/**
 * The wordmark's Ink half (TUI-DESIGN-2 §5.1, TUI-DESIGN-3 §3; the owner's directive of 2026-09-23 "keep jevcode
 * branding on top only … chats appear after that"): `SplashRow`, one mark row with its cells coloured by the frame's
 * spans (the splash box, the fullscreen header), and the COMMITTED mark — the settled mark frozen at the commit and
 * written once as the first `<Static>` block of a classic session (`Transcript.tsx` renders it at index 0, the App
 * decides when). `committedMark` is pure; `WordmarkBlock` draws its rows: the blank padding, the five glyph rows (the
 * tagline on row 0 where it fits, the caption `◆ <version>` on row 4), the blank padding. Ink writes a `<Static>` item
 * once and never lays it out again, so the block's rows are fixed at the commit's width and theme.
 */
import { memo } from 'react';
import { Box, Text } from 'ink';
import { textProps, type ColorOn, type ColorRole, type Theme } from './theme.js';
import type { RestingFrame } from './splash.js';

/** One coloured run of a mark row (`splash.ts` `SplashSpan`, read-only). */
export type MarkSpan = { readonly row: number; readonly from: number; readonly to: number; readonly role: ColorRole };
export const NO_MARK_SPANS: readonly MarkSpan[] = [];

function SplashRowImpl({ row, spans, theme, color }: { row: string; spans: readonly { from: number; to: number; role: ColorRole }[]; theme: Theme; color: ColorOn }): React.JSX.Element {
  const cells = [...row];
  const parts: React.JSX.Element[] = [];
  let at = 0;
  const sorted = [...spans].filter((s) => s.from < cells.length).sort((a, b) => a.from - b.from);
  // the sweep band paints over the letter roles: later spans win inside their range
  const roleAt = (i: number): ColorRole | null => {
    let role: ColorRole | null = null;
    for (const s of sorted) if (i >= s.from && i < s.to) role = s.role;
    return role;
  };
  // a run of blanks carries no visible colour: it joins the preceding coloured part instead of opening a part of its own
  const isBlank = (i: number): boolean => cells[i] === ' ';
  while (at < cells.length) {
    const role = roleAt(at);
    let end = at + 1;
    while (end < cells.length && (roleAt(end) === role || (isBlank(end) && role !== null))) end++;
    const text = cells.slice(at, end).join('');
    parts.push(
      <Text key={`p${at}`} {...(role === null ? {} : textProps(theme, role, color))}>
        {text}
      </Text>,
    );
    at = end;
  }
  return (
    <Box height={1} overflowY="hidden">
      <Text wrap="truncate">{parts}</Text>
    </Box>
  );
}

/** TUI-DESIGN-3 §3 (integration): memoised by value so a key frame (which re-renders the App) leaves the mark rows untouched. */
export const SplashRow = memo(SplashRowImpl, (a, b) => a.row === b.row && a.theme === b.theme && a.color === b.color && a.spans.length === b.spans.length && a.spans.every((s, i) => s.from === b.spans[i]!.from && s.to === b.spans[i]!.to && s.role === b.spans[i]!.role));

/**
 * The committed mark: the resting frame's rows and per-row spans (no sweep band — a committed mark is never repainted),
 * its padding and the width it was centred for. `wordmark: true` tells it apart from a `TranscriptItem` in the
 * `<Static>` array; `key` is its React key there.
 */
export interface CommittedMark {
  readonly wordmark: true;
  readonly key: string;
  readonly rows: readonly string[];
  readonly spans: readonly (readonly MarkSpan[])[];
  readonly padTop: number;
  readonly padBottom: number;
  readonly columns: number;
}

/** The committed block's total height: padding + glyph rows + padding. */
export function committedMarkRows(m: CommittedMark): number {
  return m.padTop + m.rows.length + m.padBottom;
}

/** True for the committed mark in a mixed `<Static>` array. */
export function isCommittedMark(x: unknown): x is CommittedMark {
  return typeof x === 'object' && x !== null && (x as { wordmark?: unknown }).wordmark === true;
}

/** Freeze the settled mark for the scrollback: `frame.spans(null)` split per row, `pad` blank rows above and below. Pure. */
export function committedMark(frame: RestingFrame, pad: number, columns: number, key = 'wordmark'): CommittedMark {
  const all = frame.spans(null);
  const spans = frame.rows.map((_row, i) => all.filter((sp) => sp.row === i));
  const p = Number.isFinite(pad) ? Math.max(0, Math.floor(pad)) : 0;
  return Object.freeze({ wordmark: true as const, key, rows: Object.freeze([...frame.rows]), spans: Object.freeze(spans), padTop: p, padBottom: p, columns: Math.max(0, Math.floor(columns)) });
}

/** The committed block: the blank rows, the glyph rows, the blank rows — laid out at the commit's width. */
export function WordmarkBlock({ mark, theme, color }: { mark: CommittedMark; theme: Theme; color: ColorOn }): React.JSX.Element {
  return (
    <Box flexDirection="column" {...(mark.columns > 0 ? { width: mark.columns } : {})}>
      {Array.from({ length: mark.padTop }, (_unused, i) => (
        <Text key={`mt${i}`} wrap="truncate">
          {' '}
        </Text>
      ))}
      {mark.rows.map((row, i) => (
        <SplashRow key={`mr${i}`} row={row} spans={mark.spans[i] ?? NO_MARK_SPANS} theme={theme} color={color} />
      ))}
      {Array.from({ length: mark.padBottom }, (_unused, i) => (
        <Text key={`mb${i}`} wrap="truncate">
          {' '}
        </Text>
      ))}
    </Box>
  );
}

/** The committed block's boundary fallback: blank rows of the same height (TUI-DESIGN-4 §1.2 P-H3 — the mark degrades silently). */
export function WordmarkBlankBlock({ rows }: { rows: number }): React.JSX.Element {
  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {Array.from({ length: rows }, (_unused, i) => (
        <Text key={`mf${i}`} wrap="truncate">
          {' '}
        </Text>
      ))}
    </Box>
  );
}
