/**
 * The confirm rows of TUI-DESIGN-4 §4.5 (D-X), pure strings: a destructive command reached **through a selection
 * surface** — the palette's accept or cycle, the `--plain` numbered pick — gets one row in the existing `exitConfirm`
 * overlay slot, with Enter inert exactly as TD §2149 already specifies for the exit confirm.
 *
 * **Each is a rung ladder, never a single literal.** The single-literal forms are 87 / 101 / 87 cells and all three
 * overflow the card's 76 inner cells at 24×80; at 40 columns the abort row would read `abort the run now? the step in
 * flight i…` — a modal with no visible way out and a deliberately inert Enter. That is the safety surface of the
 * whole Enter-cycling model, so it gets the same treatment `Overlay.tsx:31–39` already gives the exit confirm.
 *
 * The abort ladder's top rung drops `(Enter does nothing)` rather than the sentence that says what is lost, because
 * the abort card is the only one where the *consequence* is the safety information; the rung below restores the Enter
 * clause once the sentence no longer fits.
 */
import { fitRungIn } from '../fit.js';
import { GLYPHS, type GlyphSet } from '../glyphs.js';
import type { ConfirmKind } from './dispatch.js';

/** TUI-DESIGN-4 §4.5 / §12: the `/new` ladder, widest first (76 / 55 / 28 cells). */
export const CONFIRM_NEW_RUNGS: readonly string[] = [
  'end this session and start fresh? [y] yes  [n] keep it  (Enter does nothing)',
  'start fresh? [y] yes  [n] keep it  (Enter does nothing)',
  'start fresh? [y] yes  [n] no',
];

/** TUI-DESIGN-4 §4.5 / §12: the `/abort` ladder, widest first (79 / 64 / 22 cells). */
export const CONFIRM_ABORT_RUNGS: readonly string[] = [
  'abort the run now? the step in flight is discarded. [y] abort  [n] keep running',
  'abort the run? [y] abort  [n] keep running  (Enter does nothing)',
  'abort? [y] yes  [n] no',
];

/** TUI-DESIGN-4 §4.5 / §12: the `/exit` ladder, widest first (55 / 30 / 22 cells). */
export const CONFIRM_EXIT_RUNGS: readonly string[] = [
  'leave JevCode? [y] exit  [n] stay  (Enter does nothing)',
  'leave JevCode? [y] yes  [n] no',
  'leave? [y] yes  [n] no',
];

/**
 * TUI-DESIGN-4 §4.5: the ladder of a confirm kind. **Total** — every `ConfirmKind` has a ladder, because the one
 * destructive command that has none (`/history clear`, which keeps its own `y/N` in `registry.ts` / `session.ts`)
 * is not a `ConfirmKind`: `confirmFor` answers `null` for it, so the overlay is never asked to draw an empty body.
 */
export function confirmRungs(kind: ConfirmKind): readonly string[] {
  switch (kind) {
    case 'new':
      return CONFIRM_NEW_RUNGS;
    case 'abort':
      return CONFIRM_ABORT_RUNGS;
    case 'exit':
      return CONFIRM_EXIT_RUNGS;
  }
}

/**
 * TUI-DESIGN-4 §4.5 `confirmRow` — the rung for a card whose **inner** width is `innerCells`
 * (`Overlay.tsx`: `Math.max(1, columns - 4)`, i.e. 76 at the default 80 columns), never `columns`. **Never null** —
 * the caller can render it unconditionally. `--ascii` substitutes the glyph table (the rungs are plain ASCII today,
 * so the twin is byte-identical; the substitution is applied anyway so a future rung cannot regress).
 */
export function confirmRow(kind: ConfirmKind, innerCells: number, g: GlyphSet = GLYPHS.unicode): string {
  const rungs = confirmRungs(kind);
  // §2.6 edge 2: the rung is measured in the glyph set it will be drawn in — `fitRungIn` is S2's `src/tui/fit.ts`,
  // the one cross-slot rung helper (§9.2), so the confirm ladder, the review keys row, the minsize notice and the
  // intake row all pick the same way.
  return fitRungIn(rungs, innerCells, g);
}

/**
 * TUI-DESIGN-4 §4.5 / §4.6 (a): the `--plain` twin — the numbered pick is a selection surface too, so a destructive
 * command reached by number gets the same gate, here as a readline `y/N`. The question is the narrowest rung's
 * sentence (readline has no inert Enter to explain: an empty line is "no").
 */
export function confirmPlainPrompt(kind: ConfirmKind): string {
  const rungs = confirmRungs(kind);
  const narrow = rungs[rungs.length - 1] ?? '';
  const question = narrow.slice(0, narrow.indexOf('?') + 1);
  return `${question} [y/N]`;
}
