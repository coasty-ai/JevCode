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
 * TUI-DESIGN-5 §2.7 / §12 S27: the `/end` ladder, widest first (the four rungs §2.7 writes verbatim). Ending a
 * session is irreversible — a `/resume` afterwards needs `--force` — so it joins `destructive: true` and its Enter
 * is inert, exactly like `/new`, `/abort` and `/exit`.
 */
export const CONFIRM_END_RUNGS: readonly string[] = [
  'end this session: [y] at step boundary  [Y] now  [n] stay',
  'end session: [y] at step end  [Y] now  [n] stay',
  'end: [y] step end  [Y] now  [n] stay',
  'y end · Y now · n stay',
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
    case 'end':
      return CONFIRM_END_RUNGS;
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
 * command reached by number gets the same gate, here as a readline prompt. The question is the narrowest rung's
 * sentence (readline has no inert Enter to explain: an empty line is "no").
 *
 * **A ladder with more than two answers spells all of them (the fix pass).** `/end` is a THREE-answer ladder
 * (§12 S27: `[y]` at the step boundary, `[Y]` now, `[n]` stay), and a `[y/N]` prompt would have offered the reader
 * no way to reach `[Y] now` and no way to know it existed — breaking `transcript.log == --plain == TUI` for the
 * one new ladder. Its twin is the widest rung with its colon turned into a question mark, so every answer the TUI
 * draws is on the readline row too. The two-answer ladders (`new`, `abort`, `exit`) are unchanged.
 */
export function confirmPlainPrompt(kind: ConfirmKind): string {
  const rungs = confirmRungs(kind);
  const narrow = rungs[rungs.length - 1] ?? '';
  const q = narrow.indexOf('?');
  if (q >= 0) return `${narrow.slice(0, q + 1)} [y/N]`;
  // TUI-DESIGN-5 §2.7 / §12 S27: the `/end` ladder STATES rather than asks (`end this session: [y] …`), so its
  // narrowest rung carries no `?`. The readline twin asks the widest rung verbatim, keeping all three answers;
  // an empty line is still "no" (`confirmAnswer`), which is what the TUI's inert Enter means.
  const widest = rungs[0] ?? '';
  const colon = widest.indexOf(':');
  return colon >= 0 ? `${widest.slice(0, colon)}?${widest.slice(colon + 1)}` : `${widest}?`;
}

/**
 * TUI-DESIGN-5 §2.7 / §12 S27: the three answers a confirm ladder can take, so the `--plain` twin and the TUI
 * agree on what a key means. `'yes-now'` exists only for `'end'`.
 */
export type ConfirmAnswer = 'no' | 'yes' | 'yes-now';

/**
 * TUI-DESIGN-4 §4.5 / TUI-DESIGN-5 §2.7: read one readline answer against a ladder. **Case-sensitive for `'end'`
 * alone**: `Y` there is `[Y] now`, a different outcome from `[y] at step boundary`, and lower-casing the answer
 * silently turned "now" into "at the step boundary". Everything that is not an affirmative — including the empty
 * line readline's Enter produces — is `'no'`, which is the readline twin of the TUI's inert Enter.
 */
export function confirmAnswer(kind: ConfirmKind, raw: string): ConfirmAnswer {
  const t = raw.trim();
  if (kind === 'end' && t === 'Y') return 'yes-now';
  const a = t.toLowerCase();
  return a === 'y' || a === 'yes' ? 'yes' : 'no';
}

/**
 * TUI-DESIGN-5 §2.7: the line a `'yes-now'` answer re-dispatches — `/end …` with `now` as its first argument, so
 * the ONE dispatch path produces `EndOptions.at: 'now'` and nothing re-models the action. Identity for every other
 * kind and for a line that already says `now`.
 */
export function confirmNowLine(kind: ConfirmKind, line: string): string {
  if (kind !== 'end') return line;
  const m = /^(\/\S+)\s*([\s\S]*)$/.exec(line.trim());
  if (m === null) return line;
  const rest = (m[2] ?? '').trim();
  if (/^now\b/i.test(rest)) return line;
  return rest === '' ? `${m[1] as string} now` : `${m[1] as string} now ${rest}`;
}
