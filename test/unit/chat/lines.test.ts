/**
 * TUI-DESIGN-2 §3.7 (S3, §8.1 row `lines.test.ts`): `intakeRowLines` at 40/80/100/120 (the three flat forms, 95 / 70 / 39 cells),
 * the card title (narrow and wide, message ≤ 40 cells, one line), the body, the readline and SR twins, `parseIntakeAnswer`.
 */
import { describe, expect, it } from 'vitest';
import {
  GATE_ARM_MS,
  INTAKE_BODY_RUNGS,
  INTAKE_CARD_BODY,
  INTAKE_KEPT_MARKER,
  INTAKE_CARD_TITLE,
  INTAKE_KEPT_ECHO,
  INTAKE_PENDING_TOAST,
  INTAKE_PLACEHOLDER,
  INTAKE_READLINE_PROMPT,
  INTAKE_READLINE_RUNGS,
  intakeReadlinePrompt,
  INTAKE_ROW_MEDIUM,
  INTAKE_ROW_NARROW,
  INTAKE_ROW_WIDE,
  intakeCardBody,
  INTAKE_SR_LINES,
  INTAKE_STATUS_WORD,
  intakeCardTitle,
  intakeRowLines,
  parseIntakeAnswer,
} from '../../../src/chat/lines.js';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';

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
    // TUI-DESIGN-4 §5.6 P-C17 / §14.2 review item 17: the readline twin is a LADDER, and the exported constant is
    // its 80-column rung — the 96-cell top rung wrapped on the default terminal and put the answer cursor on a
    // continuation line, which is the one thing a prompt may not do.
    expect(INTAKE_READLINE_PROMPT).toBe('run this as a task? [y] run it  [n] just chatting  [Esc/empty] keep the text > ');
    expect(cellWidth(INTAKE_READLINE_PROMPT)).toBeLessThanOrEqual(80);
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

// ---------------------------------------------------------------------------------------------------------------
// TUI-DESIGN-4 §5.6 P-C17 (D-Y, ratified as amended): the boxed card's body is a `fitRung` ladder that drops
// `Ctrl-C cancels` BEFORE `Enter does nothing`; the three FLAT tiers are unchanged and still measure 95 / 70 / 39.
// ---------------------------------------------------------------------------------------------------------------

describe('§5.6: the intake body ladder and the unchanged flat tiers', () => {
  it('the four rungs measure exactly 91 / 73 / 47 / 20 cells, and rung 2 is today\'s body unchanged', () => {
    expect(INTAKE_BODY_RUNGS.map((r) => cellWidth(r))).toEqual([91, 73, 47, 20]);
    expect(INTAKE_BODY_RUNGS[0]).toBe('[y] run it   [n] just chatting   (Esc keeps the text · Enter does nothing · Ctrl-C cancels)');
    expect(INTAKE_BODY_RUNGS[1]).toBe(INTAKE_CARD_BODY);
    expect(INTAKE_BODY_RUNGS[2]).toBe('[y] run it   [n] just chatting   (Esc keeps it)');
    expect(INTAKE_BODY_RUNGS[3]).toBe('[y] run it  [n] chat');
  });

  it('`Ctrl-C cancels` is dropped before `Enter does nothing`, and the inert-Enter clause survives to 73 cells', () => {
    expect(intakeCardBody(91)).toBe(INTAKE_BODY_RUNGS[0]);
    expect(intakeCardBody(90)).toBe(INTAKE_CARD_BODY);
    expect(intakeCardBody(73)).toBe(INTAKE_CARD_BODY);
    expect(intakeCardBody(72)).toBe(INTAKE_BODY_RUNGS[2]);
    expect(intakeCardBody(46)).toBe(INTAKE_BODY_RUNGS[3]);
    // the top rung is only reachable from 95 columns (a boxed card's inner width is `columns − 4`)
    expect(intakeCardBody(95 - 4)).toBe(INTAKE_BODY_RUNGS[0]);
    expect(intakeCardBody(94 - 4)).toBe(INTAKE_CARD_BODY);
    // every rung down to 73 still explains the inert Enter (`Overlay.tsx:34–36`)
    for (const cells of [73, 80, 91, 200]) expect(intakeCardBody(cells)).toContain('Enter does nothing');
  });

  it('every width 1…200 fits, in both glyph sets, and the row is never empty', () => {
    for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
      for (let cells = 1; cells <= 200; cells++) {
        const row = intakeCardBody(cells, g);
        expect(cellWidth(row), `${g.mode} ${cells}: ${row}`).toBeLessThanOrEqual(cells);
        if (cells >= 4) expect(row.length).toBeGreaterThan(0);
      }
    }
    expect(intakeCardBody(91, GLYPHS.ascii)).toBe('[y] run it   [n] just chatting   (Esc keeps the text - Enter does nothing - Ctrl-C cancels)');
  });

  it('the three flat tiers are unchanged and still measure 95 / 70 / 39 (§5.6 edge cases)', () => {
    expect([INTAKE_ROW_WIDE, INTAKE_ROW_MEDIUM, INTAKE_ROW_NARROW].map((r) => cellWidth(r))).toEqual([95, 70, 39]);
    expect(intakeRowLines(100)).toEqual([INTAKE_ROW_WIDE]);
    expect(intakeRowLines(72)).toEqual([INTAKE_ROW_MEDIUM]);
    expect(intakeRowLines(40)).toEqual([INTAKE_ROW_NARROW]);
  });

  it('§5.6 P-C17 (a) / §12: the kept-message marker is one `[ui]` row, and it never says the message was sent', () => {
    expect(INTAKE_KEPT_MARKER).toBe('(message kept in the composer, not sent)');
    expect(INTAKE_KEPT_MARKER).not.toMatch(/sent\b(?!\))/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// TUI-DESIGN-4 §5.6 / §2.6 P-R7 / §14.2 review item 17: the `--plain` readline prompt is a ladder too.
// ---------------------------------------------------------------------------------------------------------------

describe('§5.6: the --plain readline prompt ladder', () => {
  it('the five rungs measure 96 / 79 / 68 / 50 / 28 cells, drop `[Ctrl-C] cancel` first, and all end in `> `', () => {
    expect(INTAKE_READLINE_RUNGS.map((r) => cellWidth(r))).toEqual([96, 79, 68, 50, 28]);
    expect(INTAKE_READLINE_RUNGS[0]).toContain('[Ctrl-C] cancel');
    // the very next rung drops Ctrl-C and keeps the escape route, exactly as the card's body ladder does
    expect(INTAKE_READLINE_RUNGS[1]).not.toContain('Ctrl-C');
    expect(INTAKE_READLINE_RUNGS[1]).toContain('[Esc/empty] keep the text');
    for (const r of INTAKE_READLINE_RUNGS) expect(r.endsWith('> ')).toBe(true);
  });

  it('for every width 10…160 the prompt fits the terminal — the defect was a 96-cell literal at 80 columns', () => {
    for (let c = 10; c <= 160; c++) {
      const row = intakeReadlinePrompt(c);
      expect(cellWidth(row)).toBeLessThanOrEqual(c);
      expect(row.length).toBeGreaterThan(0);
    }
    expect(intakeReadlinePrompt(200)).toBe(INTAKE_READLINE_RUNGS[0]);
    expect(intakeReadlinePrompt(96)).toBe(INTAKE_READLINE_RUNGS[0]);
    expect(intakeReadlinePrompt(95)).toBe(INTAKE_READLINE_RUNGS[1]);
    expect(intakeReadlinePrompt(80)).toBe(INTAKE_READLINE_PROMPT);
    expect(intakeReadlinePrompt(70)).toBe(INTAKE_READLINE_RUNGS[2]);
    expect(intakeReadlinePrompt(60)).toBe(INTAKE_READLINE_RUNGS[3]);
    expect(intakeReadlinePrompt(30)).toBe(INTAKE_READLINE_RUNGS[4]);
  });

  it('the --ascii twin carries no unicode glyph and still fits', () => {
    for (const c of [20, 40, 80, 120]) {
      const row = intakeReadlinePrompt(c, GLYPHS.ascii);
      expect(cellWidth(row)).toBeLessThanOrEqual(c);
      // eslint-disable-next-line no-control-regex
      expect(row).toMatch(/^[\x20-\x7e]*$/);
    }
  });
});
