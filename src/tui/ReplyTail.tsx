/**
 * The reply block (AGENT-LOOP-DESIGN §9.4, §A1; slice S5a; TUI map top change 6): the agent's prose as it streams, ABOVE
 * the rule, in the rows it will keep. It draws the live buffer's uncommitted lines (`pendingItems`) with the very row
 * builder `<Static>` uses for a committed prose item (`proseItemRows`), so when a line commits the same rows move from
 * this block into the scrollback and nothing on screen moves. Readable words from the first token: a line with no
 * newline yet is drawn as text (never a `streaming… N chars` counter), wrapped, with the streaming caret on its last row.
 *
 * The block is tail-aligned: it shows the LAST `rows` rows when it has more than the layout granted it (the frame between
 * a shrinking budget and the reducer's overflow commit), and it is exactly `rows` rows tall, so the region's height is the
 * layout's number. Every row is one `wrap="truncate"` Text laid out within `columns`, so the box clips vertically only.
 */
import { Box } from 'ink';
import type { GlyphSet } from './glyphs.js';
import type { TranscriptItem } from './plain.js';
import { proseItemRows } from './Transcript.js';
import type { ColorOn, Theme } from './theme.js';

export interface ReplyTailProps {
  /** the uncommitted lines as prose pseudo-items (`pendingItems(live, reply, step)`) */
  readonly items: readonly TranscriptItem[];
  /** the last item the transcript shows — the first row is spaced and labelled against it, as `<Static>` will do */
  readonly prev: TranscriptItem | null;
  /** rows granted by the layout */
  readonly rows: number;
  readonly columns: number;
  readonly theme: Theme;
  readonly color: ColorOn;
  readonly glyphs: GlyphSet;
  /** the caret glyph while text streams (`▍`, `|` under `--ascii`), '' in its off phase or when nothing streams */
  readonly caret: string;
}

/** Every row the block would draw, before the tail cut (the tests count and compare them). */
export function replyTailRows(p: Omit<ReplyTailProps, 'rows'>): React.JSX.Element[] {
  const out: React.JSX.Element[] = [];
  let prev = p.prev;
  p.items.forEach((it, i) => {
    out.push(...proseItemRows(it, prev, p.columns, p.theme, p.color, p.glyphs, i === p.items.length - 1 ? { text: p.caret } : null));
    prev = it;
  });
  return out;
}

export function ReplyTail(p: ReplyTailProps): React.JSX.Element | null {
  const n = Math.max(0, Math.floor(p.rows));
  if (n === 0 || p.items.length === 0) return null;
  const all = replyTailRows(p);
  const shown = all.length > n ? all.slice(all.length - n) : all;
  return (
    <Box flexDirection="column" height={n} overflowY="hidden">
      {shown}
    </Box>
  );
}
