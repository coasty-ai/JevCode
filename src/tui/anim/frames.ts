/**
 * The mini indicators (AGENT-LOOP-DESIGN §A3 / §A5; slice S5a): the waiting state lives in the console's status row, in
 * the cell the spinner glyph used to take, as a tiny braille animation keyed on what is running —
 *
 * - `donut` — a model turn (and the chat's thinking): an oval ring with a dark arc travelling round it clockwise;
 * - `globe` — read-only observing (reads, greps, globs; a Jev / model call in the legacy modes): a ring with a meridian
 *   sweeping across its face;
 * - `cube`  — an edit, a write or a mutating command: a box whose inner edge sweeps across as it turns;
 * - `wave`  — the harness's test run: a sine travelling left to right.
 *
 * Each exists in two widths. The WIDE form is 3 cells (a 6 × 4 braille dot grid: wide enough for the ring to have a hole,
 * which is what makes it read as a donut at one row); the NARROW form is the old glyph slot's 1 cell (a 2 × 4 grid: the
 * classic rotating-gap ring, an orbiting dot, a bouncing block, a rising and falling dot). The status row draws the wide
 * form only while the row has room for it — the two extra cells are the first thing the row gives up, before `? help` —
 * so at 80 columns during a busy run it is exactly the old slot and nothing else is dropped for it.
 *
 * The frames were chosen by rendering candidates to text and looking at them (a physically projected torus at 4 dot rows
 * is a blob with no hole; a crisp ring with a moving gap reads as a spinning donut). They are constants — nothing is
 * computed at import or at runtime — and the frame is `frames[tick % n]` of the existing spinner tick (125 ms), so the
 * indicator adds no timer and no frame of its own. `--ascii` / `NO_COLOR` draw a one-cell ASCII twin; reduced motion and
 * SSH draw the still frame; a screen reader gets none (the caller keeps the plain status word).
 */

/** The four shapes. */
export type IndicatorKind = 'donut' | 'globe' | 'cube' | 'wave';

export const INDICATOR_KINDS: readonly IndicatorKind[] = ['donut', 'globe', 'cube', 'wave'];

/** The wide form's cells (6 × 4 braille dots). */
export const MINI_WIDE_CELLS = 3;
/** The narrow form's cells — the status row's original glyph slot. */
export const MINI_NARROW_CELLS = 1;

const WIDE: Readonly<Record<IndicatorKind, readonly string[]>> = {
  // the ring ⢎⣉⡱ with a two-dot dark arc travelling clockwise (12 positions: 1.5 s a turn at 8 fps)
  donut: ['⢆⣈⡱', '⢎⣀⡱', '⢎⣁⡰', '⢎⣉⡠', '⢎⣉⡁', '⢎⣉⠑', '⢎⡉⠱', '⢎⠉⡱', '⠎⢉⡱', '⠊⣉⡱', '⢈⣉⡱', '⢄⣉⡱'],
  // the ring with a meridian crossing its face left to right, then passing behind (each position held two ticks)
  globe: ['⢾⣉⡱', '⢾⣉⡱', '⢎⣏⡱', '⢎⣏⡱', '⢎⣹⡱', '⢎⣹⡱', '⢎⣉⡷', '⢎⣉⡷', '⢎⣉⡱', '⢎⣉⡱'],
  // the box with its inner vertical edge sweeping across as it turns (each position held two ticks)
  cube: ['⣿⣉⣹', '⣿⣉⣹', '⣏⣏⣹', '⣏⣏⣹', '⣏⣹⣹', '⣏⣹⣹', '⣏⣉⣿', '⣏⣉⣿', '⣏⣉⣹', '⣏⣉⣹'],
  // one period of a sine travelling right (12 phases)
  wave: ['⠌⠑⣀', '⠔⠑⢄', '⡠⠉⢂', '⡠⠊⠢', '⣀⠌⠡', '⢄⠔⠑', '⢄⡠⠉', '⠢⡠⠊', '⠡⣀⠌', '⠑⢄⠔', '⠉⢂⡠', '⠊⠢⡠'],
};

const NARROW: Readonly<Record<IndicatorKind, readonly string[]>> = {
  // the eight-dot ring with one dot dark, turning clockwise
  donut: ['⣾', '⣷', '⣯', '⣟', '⡿', '⢿', '⣻', '⣽'],
  // one dot orbiting the cell
  globe: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
  // a block bouncing in the cell, squashed flat where it meets the floor and the ceiling
  cube: ['⠛', '⠶', '⣤', '⣀', '⣤', '⠶', '⠛', '⠉'],
  // a dot rising on the left and falling on the right
  wave: ['⡀', '⠄', '⠂', '⠁', '⠈', '⠐', '⠠', '⢀'],
};

const ASCII: Readonly<Record<IndicatorKind, readonly string[]>> = {
  donut: ['-', '\\', '|', '/'],
  globe: ['.', 'o', 'O', 'o'],
  cube: ['#', '+', '#', '+'],
  wave: ['_', '-', '~', '-'],
};

/** The still frame of each shape (reduced motion, SSH): the full ring, a meridian on the face, a turned box, a crest. */
const STILL_WIDE: Readonly<Record<IndicatorKind, string>> = { donut: '⢎⣉⡱', globe: '⢎⣏⡱', cube: '⣏⣏⣹', wave: '⠌⠑⣀' };
const STILL_NARROW: Readonly<Record<IndicatorKind, string>> = { donut: '⣾', globe: '⠁', cube: '⠶', wave: '⠂' };

/** The frames of a shape at a width (`MINI_WIDE_CELLS` or `MINI_NARROW_CELLS`), or its ASCII twin (always one cell). */
export function miniFrames(kind: IndicatorKind, cells: number, ascii = false): readonly string[] {
  if (ascii) return ASCII[kind];
  return cells >= MINI_WIDE_CELLS ? WIDE[kind] : NARROW[kind];
}

/** How a frame is picked. */
export interface MiniFrameOptions {
  /** `--ascii` / `NO_COLOR`: the one-cell ASCII twin */
  readonly ascii?: boolean;
  /** reduced motion or SSH: the still frame, whatever the tick */
  readonly still?: boolean;
}

/** The frame of `kind` at `tick` (the spinner's frame counter) and width. */
export function miniFrame(kind: IndicatorKind, tick: number, cells: number, o: MiniFrameOptions = {}): string {
  if (o.ascii === true) {
    const a = ASCII[kind];
    return o.still === true ? a[0]! : a[mod(tick, a.length)]!;
  }
  const wide = cells >= MINI_WIDE_CELLS;
  if (o.still === true) return wide ? STILL_WIDE[kind] : STILL_NARROW[kind];
  const f = wide ? WIDE[kind] : NARROW[kind];
  return f[mod(tick, f.length)]!;
}

function mod(t: number, n: number): number {
  const i = Number.isFinite(t) ? Math.floor(t) : 0;
  return ((i % n) + n) % n;
}
