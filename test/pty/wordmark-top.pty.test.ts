/**
 * THE OWNER'S DIRECTIVE (2026-09-23), in a real pty: "Keep jevcode branding on top only and even after chat starts keep
 * it there only and chats appear after that" / "make sure the jevcode ascii design stays at top and chat is below the
 * ascii design". The classic renderer commits the settled wordmark as the FIRST `<Static>` block of the session, so on
 * the captured screen the mark's rows are ABOVE the `[you]` bubble, the reply is below that, and the console is at the
 * bottom — at 30×100 and 24×80. The mark is committed exactly once; no frame after the commit draws it in the dynamic
 * region; zero clears.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_OPEN, EXIT_IDLE, afterFirstFrame, cleanupScratch, committedMark, countClears, drive, echoStep, finalScreen, frames, hasExpect, isWordmarkRow, labelStep } from './helpers.js';

afterEach(cleanupScratch);

describe.skipIf(!hasExpect)('pty: the wordmark heads the scrollback, the chat is below it', () => {
  for (const [rows, cols] of [
    [30, 100],
    [24, 80],
  ] as const) {
    it(`${rows}x${cols}: after 'hi' + the reply the wordmark rows are ABOVE the [you] row, the reply below it, the console at the bottom; one mark, never redrawn, zero clears`, async () => {
      const r = await drive({ name: `wordmark-top-${rows}x${cols}`, args: ['chat', '--mock'], rows, cols, steps: [...CHAT_OPEN, 'sleep 0.3', 'send hi', echoStep('hi'), 'send \\r', labelStep('you', 'hi'), labelStep('jevcode', 'Hi\\.'), 'sleep 0.4', ...EXIT_IDLE] });
      expect(r.timeouts).toBe(0);
      expect(r.code).toBe(0);
      // the scrollback: the mark is its first block, committed once, the bubble and the reply below it
      const mark = committedMark(r.text);
      expect(mark.blocks, mark.scroll.join('\n')).toBe(1);
      expect(mark.rows).toHaveLength(5);
      const you = mark.scroll.findIndex((l) => /^ {4}\[you\] hi$/.test(l));
      const reply = mark.scroll.findIndex((l) => /^\[jevcode\] Hi\./.test(l));
      expect(mark.at).toBeGreaterThanOrEqual(0);
      expect(you).toBeGreaterThan(mark.at + 4);
      expect(reply).toBeGreaterThan(you);
      // nothing but the mark's own blank padding between its last glyph row and the bubble
      expect(mark.scroll.slice(mark.at + 5, you).every((l) => l === '')).toBe(true);
      // the captured screen, top to bottom: mark → [you] → [jevcode] → the rule → the composer
      const screen = finalScreen(r.text, rows);
      const sMark = screen.findIndex((l) => isWordmarkRow(l));
      const sYou = screen.findIndex((l) => /^ {4}\[you\] hi$/.test(l));
      const sReply = screen.findIndex((l) => /^\[jevcode\] Hi\./.test(l));
      const sEdge = screen.findIndex((l) => l.startsWith('╭─'));
      expect(sMark, screen.join('\n')).toBeGreaterThanOrEqual(0);
      expect(sMark).toBeLessThan(sYou);
      expect(sYou).toBeLessThan(sReply);
      expect(sReply).toBeLessThan(sEdge);
      // after the commit no frame draws a wordmark row in its dynamic region (the mark is scrollback, never repainted)
      const fs = frames(r.text);
      const committedAt = fs.findIndex((u) => u.staticRows.some((l) => isWordmarkRow(l)));
      expect(committedAt).toBeGreaterThanOrEqual(0);
      for (const u of fs.slice(committedAt)) expect(u.lines.slice(u.ruleIndex).some((l) => isWordmarkRow(l))).toBe(false);
      expect(countClears(afterFirstFrame(r.text))).toBe(0);
      console.log(`wordmark-top ${rows}x${cols}: screen rows mark ${sMark} · [you] ${sYou} · [jevcode] ${sReply} · console ${sEdge}\n${screen.join('\n')}`);
    });
  }
});
