/**
 * `fitRung` — one ladder helper for every keys row (TUI-DESIGN-4 §2.6, P-R7; D5). Pure, no Ink, no state.
 *
 * The defect it closes was measured at 40 columns on the review card: `review/lines.ts` picks `REVIEW_KEYS_120` at
 * `columns >= 120` and the 76-cell `REVIEW_KEYS_80` otherwise, then hard-truncates, so the reviewer reads
 * `│ [y] approve [n] decline [d] decline+not… │` and `[e] expand`, `[w]1-5 why` and **`[esc] decline`** are invisible
 * on the one row a reviewer must read. The fix is a ladder, not a truncation: the caller hands over the rungs from
 * widest to narrowest and `fitRung` returns the widest one that fits.
 *
 * Two rules the callers must keep, both from §2.6 edge 4 and §2.5 (P-R4):
 *
 *  1. **rungs are templates, measured after filling.** The letters come from the effective bindings
 *     (`setBindings`, TUI-DESIGN-3 §4.4 F10), never from a literal — a rebound approve key must print the right
 *     letter *and* the rung that is selected must still fit. `fillRung` does the substitution; `fitRung` measures
 *     the **rendered** string. The same rule makes `minsizeNotice`'s ladder correct: its top rung interpolates
 *     `${columns}×${rows}` and is 72 cells at `30×5`, 73 at `100×5` and 75 at `100×120`, so no constant threshold
 *     can choose it.
 *  2. **selection takes the inner width**, not the terminal width — the card's body is `columns − 4` cells
 *     (`cardRow`), and the flat tier has no card so it passes `columns`. `truncateCells` stays only as a last
 *     resort, for the case where even the narrowest rung is wider than the row.
 */
import { cellWidth, type GlyphSet, glyphTwin } from './glyphs.js';

/**
 * TUI-DESIGN-4 §2.6: the index of the widest rung that fits `cells`, or `rungs.length − 1` (the narrowest) when none
 * does; `-1` for an empty ladder. An **unbounded** width (`Infinity`) is the flat tier with no card, a `--plain` twin
 * and a log sink: it takes the widest rung, never the narrowest (`gutter.ts`'s `cappedTailRow` reads `Infinity` the
 * same way, and the two helpers must not disagree). `NaN` and `-Infinity` are "no room at all" → the narrowest.
 */
export function fitRungIndex(rungs: readonly string[], cells: number): number {
  if (rungs.length === 0) return -1;
  const room = cells === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Number.isFinite(cells) ? Math.floor(cells) : 0;
  for (let i = 0; i < rungs.length; i++) {
    if (cellWidth(rungs[i] ?? '') <= room) return i;
  }
  return rungs.length - 1;
}

/**
 * TUI-DESIGN-4 §2.6 (P-R7): the widest rung of `rungs` (ordered widest first) whose cell width is at most `cells`.
 * When nothing fits the narrowest rung is returned — the caller truncates it as a last resort, so the row is never
 * empty. An empty ladder returns `''`.
 */
export function fitRung(rungs: readonly string[], cells: number): string {
  const i = fitRungIndex(rungs, cells);
  return i < 0 ? '' : (rungs[i] ?? '');
}

/**
 * TUI-DESIGN-4 §2.6 edge 4: fill a rung template's `{name}` placeholders from the effective bindings (or any other
 * value table) before it is measured. An unknown placeholder is left as it stands, so a typo is visible in a frame
 * test instead of silently emptying a slot; a value of `null` **drops the whole whitespace-delimited slot the
 * placeholder sits in — its own brackets included — and the run of spaces that follows it**, then right-trims what
 * is left. Two callers need exactly that: §2.6 edge 5's trailing `[ctrl-c] abort run` slot, which leaves the template
 * when no run is live (behind a six-space run) so the rung is re-measured shorter rather than truncated, and a
 * *middle* slot such as `[{n}] decline`, which must not leave `[] decline` behind.
 */
export function fillRung(template: string, values: Readonly<Record<string, string | null>>): string {
  let dropped = false;
  // `[^\s{}]*` on each side is the slot's own literal punctuation (`[` … `]`), never the next placeholder: the scan
  // is left to right, so a template like `[{y}] ok [{n}] no` fills both slots and a `null` drops `[{n}] ` whole.
  const out = template.replace(/([^\s{}]*)\{(\w+)\}([^\s{}]*)( *)/g, (whole, before: string, name: string, after: string, gap: string) => {
    if (!(name in values)) return whole;
    const v = values[name];
    if (v !== null) return `${before}${v}${after}${gap}`;
    dropped = true;
    return '';
  });
  // a dropped slot leaves no padding behind: §2.6 edge 5's `[ctrl-c] abort run` sits behind a six-space run at the
  // end of rung 113, and the rung must be re-measured *shorter*, not measured with the gap that led to it
  return dropped ? out.replace(/ +$/, '') : out;
}

/** TUI-DESIGN-4 §2.6 edge 2: fill, apply the glyph twins (`·` → `-` under `--ascii`), then pick — the rung is always measured in the glyph set it will be drawn in. */
export function fitRungIn(rungs: readonly string[], cells: number, g: GlyphSet, values?: Readonly<Record<string, string | null>>): string {
  const rendered = rungs.map((r) => glyphTwin(values ? fillRung(r, values) : r, g));
  return fitRung(rendered, cells);
}
