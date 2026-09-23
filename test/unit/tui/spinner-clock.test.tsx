/**
 * TUI map top change 4 (slice S5a): one clock while text flows. `useSpinner(active, reducedMotion, flowing)` advances its
 * frame on every tick but renders on its own only when no stream paint happened within the tick — so a streaming frame
 * and a tick frame never double the frame rate, and the spinner / mini indicator / caret ride the stream's frames. No
 * timer at all while inactive (the idle-frames gate).
 */
import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { SPINNER_INTERVAL_MS, useSpinner } from '../../../src/tui/spinner.js';
import { tick } from '../../fixtures/tui/fixtures.js';

afterEach(() => cleanup());

let renders = 0;
function Probe({ active, flowing }: { active: boolean; flowing: () => boolean }): React.JSX.Element {
  renders += 1;
  const frame = useSpinner(active, false, flowing);
  return <Text>{`f${frame}`}</Text>;
}

describe('useSpinner: one clock while text flows', () => {
  it('ticks render on their own while nothing streams', async () => {
    renders = 0;
    render(<Probe active flowing={() => false} />);
    await tick(SPINNER_INTERVAL_MS * 4 + 40);
    expect(renders).toBeGreaterThanOrEqual(4);
  });

  it('while text flows the tick renders nothing itself, yet the frame keeps advancing for the next (stream) render', async () => {
    renders = 0;
    const r = render(<Probe active flowing={() => true} />);
    await tick(SPINNER_INTERVAL_MS * 4 + 40);
    expect(renders).toBe(1);
    // the next render (a stream flush) shows the advanced frame
    r.rerender(<Probe active flowing={() => true} />);
    expect(r.lastFrame()).toMatch(/^f[3-9]/);
  });

  it('no timer and no render while inactive', async () => {
    renders = 0;
    const r = render(<Probe active={false} flowing={() => false} />);
    await tick(SPINNER_INTERVAL_MS * 3);
    expect(renders).toBe(1);
    expect(r.lastFrame()).toBe('f0');
  });
});
