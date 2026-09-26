/**
 * `/exit` hands the terminal back with the cursor BELOW the console box, so the shell prints its next prompt under the
 * box's bottom edge. The composer places the real cursor on its input row in every frame, and Ink's `log.done()` does
 * not move a placed cursor back down, so before the renderer's `unmount()` committed a last frame that places no cursor
 * (`Bridge.closing`), the shell's prompt was drawn inside the box, over the input row: `│ › demo-py $  question, or
 * /command…` (the take behind docs/media/demo.md). What a shell writes next is appended to the capture and the capture
 * is replayed through the pty helpers' emulator, so the assertion is on the screen a user is left with.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_OPEN, EXIT_IDLE, PLACEHOLDER_FOLLOWUP, cleanupScratch, drive, echoStep, hasExpect, labelStep, screenAtEnd } from './helpers.js';

afterEach(cleanupScratch);

/** what an interactive shell writes once the session has exited: its prompt, at the cell the session left the cursor on */
const SHELL_PROMPT = 'shell $ ';

describe.skipIf(!hasExpect)('pty: after /exit the shell prompt lands below the console box, never inside it', () => {
  const scenarios: Array<{ name: string; rows: number; cols: number; steps: readonly string[] }> = [
    { name: 'exit-cursor-idle-24x80', rows: 24, cols: 80, steps: [...CHAT_OPEN, 'sleep 0.3', ...EXIT_IDLE] },
    {
      // the demo's shape: a reply, then /exit from the follow-up composer
      name: 'exit-cursor-reply-30x100',
      rows: 30,
      cols: 100,
      steps: [...CHAT_OPEN, 'sleep 0.3', 'send hi', echoStep('hi'), 'send \\r', labelStep('you', 'hi'), labelStep('jevcode', 'Hi\\.'), `expect ${PLACEHOLDER_FOLLOWUP}`, 'sleep 0.3', ...EXIT_IDLE],
    },
  ];
  for (const s of scenarios) {
    it(`${s.name}: the prompt is on the row under ╰…╯ at column 0, and every row of the box is intact`, async () => {
      const r = await drive({ name: s.name, args: ['chat', '--mock'], rows: s.rows, cols: s.cols, steps: s.steps });
      expect(r.timeouts).toBe(0);
      expect(r.code).toBe(0);
      const end = screenAtEnd(`${r.text}${SHELL_PROMPT}`, s.rows, s.cols);
      const shown = end.screen.map((l, i) => `${String(i).padStart(2)} ${l}`).join('\n');
      const top = end.screen.findLastIndex((l) => l.startsWith('╭'));
      const bottom = end.screen.findLastIndex((l) => l.startsWith('╰'));
      expect(top, shown).toBeGreaterThanOrEqual(0);
      expect(bottom, shown).toBeGreaterThan(top);
      // the prompt: the row right under the box's bottom edge, from column 0, and nowhere else
      expect(end.row, shown).toBe(bottom + 1);
      expect(end.screen[bottom + 1], shown).toBe(SHELL_PROMPT.trimEnd());
      expect(end.col, shown).toBe(SHELL_PROMPT.length);
      expect(end.screen.filter((l) => l.includes(SHELL_PROMPT.trimEnd())), shown).toHaveLength(1);
      // the box is whole: both corners of each edge, and every row between them still opens and closes with a side
      expect(end.screen[top]!.endsWith('╮'), shown).toBe(true);
      expect(end.screen[bottom]!.endsWith('╯'), shown).toBe(true);
      for (let row = top + 1; row < bottom; row++) {
        const line = end.screen[row]!;
        expect(/^[│├]/.test(line) && /[│┤]$/.test(line), `row ${row}\n${shown}`).toBe(true);
      }
    });
  }
});
