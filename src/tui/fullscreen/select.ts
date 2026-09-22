/**
 * TUI-DESIGN-4 §1.3.1 — the mount-time renderer selection, and the refusal note.
 *
 * `ui.renderer: fullscreen` (`--fullscreen`, `--renderer fullscreen`, `JEVCODE_RENDERER`) is a **launch** setting:
 * Ink fixes `alternateScreen` in its constructor (`node_modules/ink/build/ink.js:256`), so the choice cannot be
 * toggled in place and `createTuiRenderer` must decide before `render()`. This module is that decision, kept pure so
 * it can be tested without a terminal: geometry, the screen reader and `TERM` in, one of two renderers and at most
 * one `[ui]` note out.
 *
 * The non-TTY / CI / `--plain` / `--json` rows of §1.3.1's table are **silent** — there is no TUI at all in those
 * cases and `createTuiRenderer` is never constructed — but `interactive === false` can still reach a mount in tests
 * and in a piped session, so it is refused here too, silently (`refusal: null`, `renderer: 'classic'`).
 *
 * Pure: no I/O, no clock, no Ink.
 */
import { fullscreenRefusal } from './layout.js';

/** §1.3.1: what the launch layer asked for, and what the terminal can actually do. */
export interface RendererSelectionInput {
  /** `launch.renderer ?? ui.renderer ?? 'classic'` — the reader idiom of §8 item 6, resolved by the caller */
  wanted: 'classic' | 'fullscreen' | undefined;
  rows: number;
  columns: number;
  screenReader: boolean;
  /** `process.env.TERM`; absent or `dumb` refuses */
  term: string | undefined;
  /** `stdout.isTTY === true` */
  isTTY: boolean;
  /** Ink's `interactive` option when the caller pinned it (CI / a pipe) */
  interactive?: boolean | undefined;
}

/** §1.3.1: the renderer that will actually mount, and the one `[ui]` note when fullscreen was asked for and refused. */
export interface RendererSelection {
  renderer: 'classic' | 'fullscreen';
  /** the sentence for the single `[ui]` note, or null (asked for classic, or refused silently) */
  refusal: string | null;
}

/**
 * §1.3.1: `fullscreen` is entered only with `alternateScreen: true` **and** `incrementalRendering: true`, both forced
 * by the caller, and only when every row of the refusal matrix passes. Anything else falls back to `classic`; the
 * geometry, screen-reader and `TERM` rows name their reason, the non-TTY rows do not.
 */
export function selectRenderer(i: RendererSelectionInput): RendererSelection {
  if (i.wanted !== 'fullscreen') return { renderer: 'classic', refusal: null };
  // silent rows: there is no interactive frame to pin a header to, so there is nothing to tell the user
  if (!i.isTTY || i.interactive === false) return { renderer: 'classic', refusal: null };
  const refusal = fullscreenRefusal({ rows: i.rows, columns: i.columns, screenReader: i.screenReader, term: i.term });
  return refusal === null ? { renderer: 'fullscreen', refusal: null } : { renderer: 'classic', refusal };
}
