/**
 * The ambiguity confirmation (TUI-DESIGN-2 §3.7, §12 "Cards"), shared by Ink, `--plain` and the screen reader: the
 * card title and body of the boxed tier, the one-row flat form by width (95 / 70 / 39 cells), the readline prompt and
 * the SR selection lines, plus the placeholder, status word and toast. Never a silent run: `y` runs, `n` chats, anything
 * else keeps the text. Pure strings; `--ascii` needs no twin (no rule glyphs here).
 */
import { cellWidth, truncateCells } from '../tui/glyphs.js';
import { intakeKeptEcho, oneLine } from '../tui/plain.js';

export const INTAKE_CARD_TITLE = 'run this as a task?';
export const INTAKE_CARD_BODY = '[y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)';
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

/** `--plain` readline twin: `y`/`yes` run, `n`/`no` chat; empty or anything else keeps (five invalid answers = keep, READLINE_MAX_PROMPTS) */
export const INTAKE_READLINE_PROMPT = 'run this as a task? [y] run it  [n] just chatting  [Esc/empty] keep the text > ';
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
