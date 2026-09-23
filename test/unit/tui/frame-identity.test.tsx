/**
 * Frame identity for the render-cost work outside the App (the Console, Pane and Overlay boxes, the Console's memoised
 * builders, the bounded `stringWidth` cache). Those changes are meant to make a frame cheaper and nothing else, so the
 * real `<App>` is mounted at 24×80, 40×120, 12×60 and 30×40 in six states and every frame string is pinned byte for byte,
 * SGR included: `idle`, `thinking` (the chat's intake phase), `streaming` (a chat reply's live text with newlines, wide
 * and combining glyphs, and a non-ASCII draft in the composer), `review` (a pending confirm during a run), `palette`
 * (`/` opens the commands card — the Overlay's palette rows) and `panel` (the open decisions panel — the Pane's rows).
 *
 * The snapshots were written on the tree BEFORE the render-cost changes, so a diff here is a visible change, not noise.
 *
 * Determinism: Ink runs in debug mode (every commit writes the whole frame, unthrottled), motion is reduced (the splash
 * is done at mount, the spinner and the 3D indicator are still frames), the clock is a constant, the 1 Hz tick is off,
 * and each state waits until the stub has seen no write for a quiet window. Colour is forced at truecolor so the SGR
 * bytes are part of the pin: `FORCE_COLOR` is set before chalk is first imported (vitest runs each file in its own
 * worker), and the App reads its own depth from the `env` prop.
 *
 * A version bump that changes the wordmark's `◆ x.y.z` suffix re-pins these with `npx vitest run -u` on this file.
 */
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaunchSettings } from '../../../src/core/types.js';
import { App, createBridge, type Bridge } from '../../../src/tui/App.js';
import { createEventBus, createTuiConfirmer, type UiAction } from '../../../src/tui/useEngine.js';
import { mkConfirmRequest, mkDecision, mkStatus } from '../../fixtures/tui/fixtures.js';
import { StubStdin, StubStdout } from './stub-stdout.js';

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
});

const SIZES = [
  [24, 80],
  [40, 120],
  [12, 60],
  [30, 40],
] as const;
const STATES = ['idle', 'thinking', 'streaming', 'review', 'palette', 'panel'] as const;
type FrameState = (typeof STATES)[number];

const STILL: LaunchSettings = { fps: 30, renderMode: 'standard', screenReader: false, ascii: false, noColor: false, reducedMotion: true };
const NOW = 1_000_000;
/** the chat reply mid-stream: two finished lines and a partial one, with CJK, an emoji with a skin tone, a combining mark and box glyphs */
const LIVE = 'Here is the plan:\n1. read the 失敗 test ─┤ café\u0301 👍🏽 and the fixture\n2. fix parse_date in src/dates.py — 日本語 partial';
const DRAFT = 'also check 日本語 ✓ edge';

interface Mounted {
  stdout: StubStdout;
  stdin: StubStdin;
  bus: ReturnType<typeof createEventBus>;
  confirmer: ReturnType<typeof createTuiConfirmer>;
  bridge: Bridge;
}

function mount(rows: number, columns: number): Mounted {
  const stdout = new StubStdout(rows, columns);
  const stdin = new StubStdin();
  const bus = createEventBus();
  const confirmer = createTuiConfirmer();
  const bridge: Bridge = createBridge(null, null);
  const instance = render(
    <App task="" resumeId={null} source={bus} confirmer={confirmer} onAbort={() => undefined} mode="session" cwd="/Users/x/proj" tickMs={0} now={() => NOW} bridge={bridge} launch={STILL} env={{ FORCE_COLOR: '3' }} />,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  unmounts.push(() => instance.unmount());
  return { stdout, stdin, bus, confirmer, bridge };
}

/** Resolve once the stub has seen no write for `quietMs` (every commit writes in debug mode), bounded by `maxMs`. */
async function settle(stdout: StubStdout, quietMs = 80, maxMs = 4000): Promise<void> {
  const until = Date.now() + maxMs;
  let seen = stdout.frames.length;
  let quietSince = Date.now();
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10));
    if (stdout.frames.length !== seen) {
      seen = stdout.frames.length;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) return;
  }
}

function goLive(m: Mounted): void {
  m.bus.emit({ type: 'run:start', runId: 'r1', task: 'Fix the failing test', mode: 'jev-on', resumedFromStep: null });
  m.bus.emit({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 'Fix the failing test', resumed: false });
  m.bus.emit({ type: 'status', status: mkStatus(1, 'propose') });
}

async function frameFor(rows: number, columns: number, state: FrameState): Promise<string> {
  const m = mount(rows, columns);
  await settle(m.stdout);
  const dispatch = (action: UiAction): void => m.bridge.command({ type: 'dispatch', action });
  switch (state) {
    case 'idle':
      break;
    case 'thinking':
      dispatch({ type: 'thinking', phase: 'intake' });
      break;
    case 'streaming':
      m.stdin.write(DRAFT);
      await settle(m.stdout);
      dispatch({ type: 'thinking', phase: 'replying' });
      dispatch({ type: 'live', text: LIVE });
      break;
    case 'review': {
      goLive(m);
      const req = mkConfirmRequest('c1', 1);
      m.bus.emit({ type: 'confirm:request', request: req });
      void m.confirmer.confirm(req, { signal: new AbortController().signal }).catch(() => undefined);
      break;
    }
    case 'palette':
      m.stdin.write('/');
      break;
    case 'panel':
      goLive(m);
      for (let i = 0; i < 8; i++) m.bus.emit({ type: 'decision', decision: mkDecision({ id: `d${i}`, step: 1, verdict: i % 3 === 0 ? 'block' : i % 3 === 1 ? 'review' : 'ok' }) });
      dispatch({ type: 'panel', panel: 'open' });
      break;
  }
  await settle(m.stdout);
  return m.stdout.lastFrame();
}

describe('frame identity: the real App, byte for byte (SGR included)', () => {
  for (const [rows, columns] of SIZES) {
    for (const state of STATES) {
      it(`${rows}x${columns} ${state}`, async () => {
        const frame = await frameFor(rows, columns, state);
        expect(frame.length).toBeGreaterThan(0);
        expect(frame).toMatchSnapshot();
      });
    }
  }
});
