import { describe, expect, it } from 'vitest';
import { terminalTitle } from '../../../src/tui/App.js';

// TUI-DESIGN §14.1 / C14: the window title is opt-in (`ui.title`), sanitised, clipped and cleared on exit
describe('terminalTitle', () => {
  it('wraps the text in OSC 2 … BEL', () => {
    expect(terminalTitle('jevcode · fix the tests')).toBe('\u001b]2;jevcode · fix the tests\u0007');
  });
  it('resets the title with an empty OSC 2 when given null', () => {
    expect(terminalTitle(null)).toBe('\u001b]2;\u0007');
  });
  it('strips control characters (incl. BEL, ESC and C1) so a task cannot end the sequence early, and clips to 80 cells', () => {
    const out = terminalTitle('a\u0007b\u001b]0;evil\u0007c\u009bd\n\te');
    expect(out).toBe('\u001b]2;a b ]0;evil c d e\u0007');
    const long = terminalTitle('x'.repeat(200));
    expect(long).toBe(`\u001b]2;${'x'.repeat(80)}\u0007`);
  });
});
