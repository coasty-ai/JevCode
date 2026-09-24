/**
 * TUI-DESIGN-2 §9 "keystroke → frame" / decision D-F: a key's frame takes Ink's immediate render path.
 *
 * Ink 7.1.1 throttles `onRender` at `ceil(1000 / maxFps)` = 34 ms (`ink.js`, `throttle(…, { leading: true,
 * trailing: true })`), so a commit that lands inside the window after a spinner or 1 Hz tick frame waits for the
 * trailing edge — the every-5th / every-10th slow key the perf probe measured (p95 36–44 ms against the 16 ms gate).
 * A commit that updated the `<Static>` box runs `onImmediateRender` instead (`reconciler.js` `commitUpdate` →
 * `isStaticDirty`). `<Transcript keySeq>` hands `<Static>` a fresh `style` object per key, so the key's commit is
 * written at once. Both halves are asserted here against the real Ink renderer on a stub TTY: the plain commit inside
 * the window is deferred, the key commit inside the window is synchronous.
 */
import { Box, Text, render } from 'ink';
import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../../../src/tui/plain.js';
import { Transcript } from '../../../src/tui/Transcript.js';
import { StubStdin, StubStdout } from './stub-stdout.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const THROTTLE_MS = 34;
/** One array for every render: a fresh `items` would itself re-render `<Static>` (the App's `visible` is memoised the same way). */
const NO_ITEMS: readonly TranscriptItem[] = [];

function Probe({ keySeq, text }: { keySeq: number; text: string }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Transcript items={NO_ITEMS} keySeq={keySeq} columns={40} />
      <Text>{text}</Text>
    </Box>
  );
}

function mount(): { stdout: StubStdout; painted: () => string; rerender: (keySeq: number, text: string) => void; unmount: () => void } {
  const stdout = new StubStdout(24, 40, true);
  const stdin = new StubStdin();
  const inst = render(<Probe keySeq={0} text="frame-0" />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: false,
    maxFps: 30,
    patchConsole: false,
    exitOnCtrlC: false,
    // the stub is a TTY; without this Ink's `is-in-ci` (CI=true on every runner) makes it non-interactive and it writes only at unmount
    interactive: true,
  });
  return {
    stdout,
    painted: () => strip(stdout.frames.join('')),
    rerender: (keySeq, text) => inst.rerender(<Probe keySeq={keySeq} text={text} />),
    unmount: () => inst.unmount(),
  };
}

describe('key frames bypass Ink\'s render throttle (TUI-DESIGN-2 §9 D-F)', () => {
  it('control: a plain commit inside the 34 ms window after a frame waits for the trailing edge', async () => {
    const m = mount();
    try {
      await sleep(THROTTLE_MS * 3); // past the mount frame's window
      m.rerender(0, 'leading-1'); // leading edge: written synchronously
      expect(m.painted()).toContain('leading-1');
      m.rerender(0, 'deferred-1'); // inside the window, no key: deferred to the trailing edge
      expect(m.painted()).not.toContain('deferred-1');
      await sleep(THROTTLE_MS * 3);
      expect(m.painted()).toContain('deferred-1');
    } finally {
      m.unmount();
    }
  });

  it('a commit with a new keySeq inside the window is written synchronously (the <Static> style update takes onImmediateRender)', async () => {
    const m = mount();
    try {
      await sleep(THROTTLE_MS * 3);
      m.rerender(0, 'leading-2');
      expect(m.painted()).toContain('leading-2');
      m.rerender(1, 'key-2'); // the key's commit, inside the window
      expect(m.painted()).toContain('key-2');
      // and again right away (a second key in the same window)
      m.rerender(2, 'key-3');
      expect(m.painted()).toContain('key-3');
      // no scrollback is written by the style change: <Static> has no items
      expect(m.painted()).not.toMatch(/\[run\]|\[you\]/);
    } finally {
      m.unmount();
    }
  });

  it('only keys take the immediate path: a tick-like commit inside the window stays throttled even with a key frame between', async () => {
    const m = mount();
    try {
      await sleep(THROTTLE_MS * 3);
      m.rerender(0, 'leading-4'); // leading edge through the throttle: opens the window
      expect(m.painted()).toContain('leading-4');
      m.rerender(1, 'key-4'); // the key inside the window: immediate (does not go through the throttle at all)
      expect(m.painted()).toContain('key-4');
      m.rerender(1, 'tick-4'); // a tick-like commit still inside leading-4's window: deferred to the trailing edge
      expect(m.painted()).not.toContain('tick-4');
      await sleep(THROTTLE_MS * 3);
      expect(m.painted()).toContain('tick-4');
    } finally {
      m.unmount();
    }
  });
});
