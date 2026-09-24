/**
 * THE OWNER'S DIRECTIVE (2026-09-23), in a real pty: "Keep jevcode branding on top only and even after chat starts keep
 * it there only and chats appear after that" / "make sure the jevcode ascii design stays at top and chat is below the
 * ascii design". The classic renderer commits the settled wordmark as the FIRST `<Static>` block of the session, so on
 * the captured screen the mark's rows are ABOVE the `[you]` bubble, the reply is below that, and the console is at the
 * bottom — at 30×100 and 24×80. The mark is committed exactly once; no frame after the commit draws it in the dynamic
 * region; zero clears. And NOTHING moves at the commit: the splash box is the top of the dynamic region, in exactly the
 * rows the committed block takes, so on the emulated screen the glyph rows and the rule row keep their rows from the
 * held splash frame through the commit (24×80, 30×100, 40×120).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_OPEN, EXIT_IDLE, FIRST_FRAME_STEP, IDLE_STEP, RAW_MODE_STEP, afterFirstFrame, cleanupScratch, committedMark, countClears, drive, echoStep, finalScreen, frames, hasExpect, isWordmarkRow, labelStep, PLACEHOLDER_TASK, syncScreens } from './helpers.js';

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
      // (`region`: Ink's own accounting, so a splash box left above the rule would count)
      for (const u of fs.slice(committedAt)) expect((u.region ?? []).some((l) => isWordmarkRow(l))).toBe(false);
      expect(countClears(afterFirstFrame(r.text))).toBe(0);
      console.log(`wordmark-top ${rows}x${cols}: screen rows mark ${sMark} · [you] ${sYou} · [jevcode] ${sReply} · console ${sEdge}\n${screen.join('\n')}`);
    });
  }

  for (const [rows, cols] of [
    [24, 80],
    [30, 100],
    [40, 120],
  ] as const) {
    it(`${rows}x${cols}: NOTHING moves at the commit — on the emulated screen the glyph rows and the rule row keep their rows from frame 0 through the commit to the first key, zero clears`, async () => {
      const r = await drive({ name: `wordmark-still-${rows}x${cols}`, args: ['chat', '--mock'], rows, cols, steps: [FIRST_FRAME_STEP, 'expect step 0/', RAW_MODE_STEP, 'expect ◆(?:\\x1b\\[[0-9;]*m)* (?:\\x1b\\[[0-9;]*m)*\\d+\\.\\d+\\.\\d+', IDLE_STEP, 'sleep 0.3', 'send h', echoStep('h'), 'send \\x03', `expect ${PLACEHOLDER_TASK}`, ...EXIT_IDLE] });
      expect(r.timeouts).toBe(0);
      expect(r.code).toBe(0);
      const screens = syncScreens(r.text, rows, cols);
      const echo = screens.findIndex((s) => s.some((l) => /[›>] h/.test(l)));
      expect(echo).toBeGreaterThan(1);
      const ruleAt = (s: readonly string[]): number => s.findIndex((l) => /^─{10}/.test(l));
      const glyphsAt = (s: readonly string[]): number[] => s.flatMap((l, i) => (isWordmarkRow(l) ? [i] : []));
      // the rule row never moves, from frame 0 to the key: not at the settle, not at the commit
      const rule0 = ruleAt(screens[0]!);
      expect(rule0).toBeGreaterThan(0);
      for (const [i, s] of screens.slice(0, echo + 1).entries()) expect(ruleAt(s), `frame ${i}:\n${s.join('\n')}`).toBe(rule0);
      // the five glyph rows sit above it on the same rows in every frame that shows the whole mark (the held splash frame,
      // the commit, the settled frames), and the console's top edge directly below the rule
      const whole = screens.slice(0, echo + 1).filter((s) => glyphsAt(s).length === 5);
      expect(whole.length).toBeGreaterThan(1);
      for (const s of whole) expect(glyphsAt(s)).toEqual(glyphsAt(whole[0]!));
      expect(glyphsAt(whole[0]!).at(-1)!).toBeLessThan(rule0);
      for (const s of screens.slice(0, echo + 1)) expect(s[rule0 + 1]!.startsWith('╭─')).toBe(true);
      // the commit happened in this window (the mark is scrollback by the key) and wrote no clear
      const mark = committedMark(r.text);
      expect(mark.blocks).toBe(1);
      expect(countClears(afterFirstFrame(r.text))).toBe(0);
      console.log(`wordmark-still ${rows}x${cols}: rule row ${rule0}, glyph rows ${glyphsAt(whole[0]!).join(',')} in ${whole.length} whole-mark frame(s) of ${echo + 1}`);
    });
  }
});
