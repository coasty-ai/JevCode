/**
 * The ambiguity confirmation (TUI-DESIGN-2 §3.7, §12 "Cards"), shared by Ink, `--plain` and the screen reader: the
 * card title and body of the boxed tier, the one-row flat form by width (95 / 70 / 39 cells), the readline prompt and
 * the SR selection lines, plus the placeholder, status word and toast. Never a silent run: `y` runs, `n` chats, anything
 * else keeps the text. Pure strings; `--ascii` needs no twin (no rule glyphs here).
 */
import { GLYPHS, cellWidth, truncateCells, type GlyphSet } from '../tui/glyphs.js';
import { fitRungIn } from '../tui/fit.js';
import { intakeKeptEcho, oneLine } from '../tui/plain.js';

export const INTAKE_CARD_TITLE = 'run this as a task?';
export const INTAKE_CARD_BODY = '[y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)';

/**
 * TUI-DESIGN-4 §5.6 P-C17 (b) (D-Y, ratified as amended): the boxed card's body is a **`fitRung` ladder**, dropping
 * `Ctrl-C cancels` **before** `Enter does nothing`. Enter on the intake card does nothing, and `Overlay.tsx:34–36`
 * records that clause as "the statement that justifies the inert Enter" — dropping it would leave a user who
 * pressed the most natural key on a two-choice prompt with silence and no explanation anywhere on screen. The
 * rungs are widest first and measure 91 / 73 / 47 / 20 cells (§12); rung 2 is today's `INTAKE_CARD_BODY`, unchanged.
 */
export const INTAKE_BODY_RUNGS: readonly string[] = [
  '[y] run it   [n] just chatting   (Esc keeps the text · Enter does nothing · Ctrl-C cancels)',
  INTAKE_CARD_BODY,
  '[y] run it   [n] just chatting   (Esc keeps it)',
  '[y] run it  [n] chat',
];

/**
 * §5.6 (b): the widest body rung that fits the card's **inner** width. The top rung is only reachable from 95
 * columns (a boxed card's inner width is `columns − 4`), which is why the three flat tiers below are unchanged.
 */
export function intakeCardBody(innerCells: number, g: GlyphSet = GLYPHS.unicode): string {
  const cells = Math.max(0, Math.floor(Number.isFinite(innerCells) ? innerCells : 0));
  return truncateCells(fitRungIn(INTAKE_BODY_RUNGS, cells, g), cells, g);
}

/**
 * §5.6 P-C17 (a) / §12: an `ambiguous` reading leaves an **orphan** `[you]` bubble on Esc, so one logical message
 * shows twice. The bubble must stay where it is — the `intake-latency` gate requires it to commit **before** the
 * Jev request — so on `keep` the controller appends this one marker instead.
 */
export const INTAKE_KEPT_MARKER = '(message kept in the composer, not sent)';
/** the quoted message of the wide title (≥ 100 inner cells) */
export const INTAKE_TITLE_MESSAGE_CELLS = 40;
export const INTAKE_CARD_WIDE_CELLS = 100;

/** boxed tier: `run this as a task?` below 100 inner cells, `"<message ≤ 40, one line>" — run this as a task?` from 100 */
export function intakeCardTitle(message: string, innerCells: number): string {
  if (innerCells < INTAKE_CARD_WIDE_CELLS) return INTAKE_CARD_TITLE;
  return `"${truncateCells(oneLine(message).trim(), INTAKE_TITLE_MESSAGE_CELLS)}" — ${INTAKE_CARD_TITLE}`;
}

/** the three flat rows of §3.7 */
export const INTAKE_ROW_WIDE = 'run this as a task?   [y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)'; // 95 cells
export const INTAKE_ROW_MEDIUM = 'run this as a task?  [y] run it  [n] just chatting  Esc keeps the text'; // 70 cells
export const INTAKE_ROW_NARROW = 'run this as a task?  [y] [n]  Esc keeps'; // 39 cells
export const INTAKE_ROW_WIDE_COLUMNS = 100;
export const INTAKE_ROW_MEDIUM_COLUMNS = 72;

/** flat tier: one row by width (≥ 100 → 95 cells · ≥ 72 → 70 · else 39, cut to the columns when narrower) */
export function intakeRowLines(columns: number): string[] {
  const row = columns >= INTAKE_ROW_WIDE_COLUMNS ? INTAKE_ROW_WIDE : columns >= INTAKE_ROW_MEDIUM_COLUMNS ? INTAKE_ROW_MEDIUM : INTAKE_ROW_NARROW;
  return [cellWidth(row) <= columns ? row : truncateCells(row, Math.max(0, columns))];
}

/**
 * §5.6 / §2.6 P-R7 / §14.2 review item 17: the `--plain` readline twin is a ladder too, dropping `[Ctrl-C] cancel`
 * first exactly as the boxed card's body does. The first draft gave the card a four-rung ladder and left its
 * readline twin one fixed 96-cell literal, so on any terminal ≤ 95 columns — the default 80 included — the prompt
 * wrapped and the answer cursor landed on a continuation line. Widest first; the rungs measure 96 / 79 / 68 / 50 /
 * 28 cells, and every one ends in `> ` because readline writes the caret itself.
 */
export const INTAKE_READLINE_RUNGS: readonly string[] = [
  'run this as a task? [y] run it  [n] just chatting  [Esc/empty] keep the text  [Ctrl-C] cancel > ',
  'run this as a task? [y] run it  [n] just chatting  [Esc/empty] keep the text > ',
  'run this as a task? [y] run it  [n] just chatting  [Esc] keeps it > ',
  'run this as a task? [y] yes  [n] no  [Esc] keep > ',
  'task? [y] [n]  [Esc] keep > ',
];

/** §5.6: the widest readline rung that fits `columns`. The caller passes the terminal width (no card, no inner margin). */
export function intakeReadlinePrompt(columns: number, g: GlyphSet = GLYPHS.unicode): string {
  const cells = Math.max(0, Math.floor(Number.isFinite(columns) ? columns : 0));
  return truncateCells(fitRungIn(INTAKE_READLINE_RUNGS, cells, g), cells, g);
}

/**
 * `--plain` readline twin at the default 80 columns: `y`/`yes` run, `n`/`no` chat; empty or anything else keeps
 * (five invalid answers = keep, `READLINE_MAX_PROMPTS`). Kept as a constant because `src/cli/session.ts:1024` is
 * S3's file — the request to pass `intakeReadlinePrompt(columns())` there is in S5's report.
 */
export const INTAKE_READLINE_PROMPT = INTAKE_READLINE_RUNGS[1] ?? '';
/** screen reader: the typed-line rule (TD §6.5) */
export const INTAKE_SR_LINES: readonly [string, string] = ['1 run it  2 just chatting  3 keep the text', 'Enter selection (1-3):'];

export type IntakeAnswer = 'run' | 'chat' | 'keep';

/** a typed answer → the decision; null = invalid (the readline asks again, ≤ READLINE_MAX_PROMPTS) */
export function parseIntakeAnswer(line: string): IntakeAnswer | null {
  const t = line.trim().toLowerCase();
  if (t === '' || t === '3' || t === 'keep' || t === 'esc') return 'keep';
  if (t === 'y' || t === 'yes' || t === '1' || t === 'run') return 'run';
  if (t === 'n' || t === 'no' || t === '2' || t === 'chat') return 'chat';
  return null;
}

/** `--plain` twin of `Renderer.restoreDraft` (§3.7 / §6 item 11): the kept draft echoed as a bare `(kept: <text>)` line — defined beside `oneLine` in tui/plain.ts */
export const INTAKE_KEPT_ECHO: (text: string) => string = intakeKeptEcho;

export const INTAKE_PLACEHOLDER = '(waiting for y/n)';
export const INTAKE_STATUS_WORD = 'asking';
export const INTAKE_PENDING_TOAST = 'intake pending: y n · Esc keeps the text';
/** TD §6.3 arm: the committed frame AND this delay before a key can answer (the submitting Enter never answers `y`) */
export const GATE_ARM_MS = 150;
