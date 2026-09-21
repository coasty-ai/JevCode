/**
 * TUI-DESIGN-2 §3.7 (S3, §8.1 row `lines.test.ts`): `intakeRowLines` at 40/80/100/120 (the three flat forms, 95 / 70 / 39 cells),
 * the card title (narrow and wide, message ≤ 40 cells, one line), the body, the readline and SR twins, `parseIntakeAnswer`.
 */
import { describe, expect, it } from 'vitest';
import {
  GATE_ARM_MS,
  INTAKE_CARD_BODY,
  INTAKE_CARD_TITLE,
  INTAKE_KEPT_ECHO,
  INTAKE_PENDING_TOAST,
  INTAKE_PLACEHOLDER,
  INTAKE_READLINE_PROMPT,
  INTAKE_ROW_MEDIUM,
  INTAKE_ROW_NARROW,
  INTAKE_ROW_WIDE,
  INTAKE_SR_LINES,
  INTAKE_STATUS_WORD,
  intakeCardTitle,
  intakeRowLines,
  parseIntakeAnswer,
} from '../../../src/chat/lines.js';
import { cellWidth } from '../../../src/tui/glyphs.js';

describe('§3.7 the ambiguity confirmation', () => {
  it('the three flat rows measure 95 / 70 / 39 cells and read verbatim', () => {
    expect(INTAKE_ROW_WIDE).toBe('run this as a task?   [y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)');
    expect(INTAKE_ROW_MEDIUM).toBe('run this as a task?  [y] run it  [n] just chatting  Esc keeps the text');
    expect(INTAKE_ROW_NARROW).toBe('run this as a task?  [y] [n]  Esc keeps');
    expect([cellWidth(INTAKE_ROW_WIDE), cellWidth(INTAKE_ROW_MEDIUM), cellWidth(INTAKE_ROW_NARROW)]).toEqual([95, 70, 39]);
  });

  it('intakeRowLines picks the row by width: ≥ 100 wide · ≥ 72 medium · else narrow (cut when the terminal is narrower still)', () => {
    expect(intakeRowLines(120)).toEqual([INTAKE_ROW_WIDE]);
    expect(intakeRowLines(100)).toEqual([INTAKE_ROW_WIDE]);
    expect(intakeRowLines(99)).toEqual([INTAKE_ROW_MEDIUM]);
    expect(intakeRowLines(80)).toEqual([INTAKE_ROW_MEDIUM]);
    expect(intakeRowLines(72)).toEqual([INTAKE_ROW_MEDIUM]);
    expect(intakeRowLines(71)).toEqual([INTAKE_ROW_NARROW]);
    expect(intakeRowLines(40)).toEqual([INTAKE_ROW_NARROW]);
    for (const w of [30, 40, 72, 80, 100, 120]) {
      const [row] = intakeRowLines(w);
      expect(row).toBeDefined();
      expect(cellWidth(row!)).toBeLessThanOrEqual(w);
    }
  });

  it('the card: title `run this as a task?` below 100 inner cells, quoted one-line message ≤ 40 cells from 100; the body is the §12 line', () => {
    expect(intakeCardTitle('the date parsing', 76)).toBe(INTAKE_CARD_TITLE);
    expect(intakeCardTitle('the date parsing', 116)).toBe('"the date parsing" — run this as a task?');
    const long = intakeCardTitle('a very long message that keeps going\nand has a second line too and more words', 116);
    expect(long.startsWith('"')).toBe(true);
    expect(long).not.toMatch(/\n/);
    expect(cellWidth(long.slice(1, long.indexOf('" — ')))).toBeLessThanOrEqual(40);
    expect(INTAKE_CARD_BODY).toBe('[y] run it   [n] just chatting   (Esc keeps the text; Enter does nothing)');
  });

  it('the readline and screen-reader twins, the placeholder, status word, toast and arm delay', () => {
    expect(INTAKE_READLINE_PROMPT).toBe('run this as a task? [y] run it  [n] just chatting  [Esc/empty] keep the text > ');
    expect(INTAKE_SR_LINES).toEqual(['1 run it  2 just chatting  3 keep the text', 'Enter selection (1-3):']);
    expect(INTAKE_PLACEHOLDER).toBe('(waiting for y/n)');
    expect(INTAKE_STATUS_WORD).toBe('asking');
    expect(INTAKE_PENDING_TOAST).toBe('intake pending: y n · Esc keeps the text');
    expect(GATE_ARM_MS).toBe(150);
  });

  it('the --plain twin of restoreDraft echoes the kept text as one bare `(kept: …)` line (TD §15.1 toast form)', () => {
    expect(INTAKE_KEPT_ECHO('the date parsing')).toBe('(kept: the date parsing)');
    expect(INTAKE_KEPT_ECHO('two\nlines\u001b[2J')).toBe('(kept: two ⏎ lines[2J)');
  });

  it('parseIntakeAnswer: y/yes/1 run · n/no/2 chat · empty/3 keep · anything else invalid (asked again)', () => {
    expect(['y', 'Y', 'yes', '1', 'run'].map(parseIntakeAnswer)).toEqual(['run', 'run', 'run', 'run', 'run']);
    expect(['n', 'no', '2', 'chat'].map(parseIntakeAnswer)).toEqual(['chat', 'chat', 'chat', 'chat']);
    expect(['', '  ', '3', 'keep', 'esc'].map(parseIntakeAnswer)).toEqual(['keep', 'keep', 'keep', 'keep', 'keep']);
    expect(['maybe', 'yn', 'q'].map(parseIntakeAnswer)).toEqual([null, null, null]);
  });
});
