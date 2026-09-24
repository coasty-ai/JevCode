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
 * The wordmark's `◆ <version>` suffix is masked as `x.y.z` before the pin, so a release's version bump changes no snapshot.
 *
 * The second half is the invariant that makes the clipping change safe everywhere, not only in these frames: a box that
 * clips vertically only (`overflowY="hidden"` without `overflow`/`overflowX`) must wrap nothing but `wrap="truncate"`
 * Texts — exactly one in a row-direction box, one pre-fitted row per child in a column box — laid out inside the box's
 * width, with no border. Ink truncates such a Text to its node's width, so the horizontal clip it no longer runs
 * (`Output.get`: getWidestLine + sliceAnsi per line) could never have removed a cell. Both halves are checked on the
 * mounted App's Ink DOM in every state above and on every `Overlay` kind and `Pane` form rendered alone at 40–120
 * columns: the structure, and the output itself re-rendered with those boxes flipped back to `overflow="hidden"`.
 */
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '3';
});

import { Box, Text, render } from 'ink';
// Ink keeps its instance map, DOM types and frame renderer private (`exports` maps only `.`); the pinned ink 7.1.1
// modules are reached by path — the same module instances `render()` uses (round2-console.test.tsx does the same)
import instances from '../../../node_modules/ink/build/instances.js';
import inkRenderer from '../../../node_modules/ink/build/renderer.js';
import type { DOMElement } from '../../../node_modules/ink/build/dom.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockingRequest, LaunchSettings } from '../../../src/core/types.js';
import { detectSecrets } from '../../../src/core/redact.js';
import { App, createBridge, type Bridge } from '../../../src/tui/App.js';
import { versionFree } from '../helpers/version-free.js';
import { Overlay, type OverlayData } from '../../../src/tui/Overlay.js';
import { Pane } from '../../../src/tui/Pane.js';
import { CAP, chromeRows, type OverlayKind } from '../../../src/tui/layout.js';
import { createEventBus, createTuiConfirmer, type UiAction } from '../../../src/tui/useEngine.js';
import { mkConfirmRequest, mkDecision, mkStatus, mkUiConfig } from '../../fixtures/tui/fixtures.js';
import { paneState } from './pane/helpers.js';
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
  // a session past startup: the config has arrived (`setUi`), so the reduced-motion mount commits its mark in frame 0
  bridge.ui = mkUiConfig(STILL);
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

async function frameFor(rows: number, columns: number, state: FrameState): Promise<{ frame: string; root: DOMElement }> {
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
  return { frame: m.stdout.lastFrame(), root: rootOf(m.stdout) };
}

/** The Ink DOM root behind a stub stdout (the instance keeps it private). */
function rootOf(stdout: StubStdout): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream);
  if (instance === undefined) throw new Error('no Ink instance for this stdout');
  return (instance as unknown as { rootNode: DOMElement }).rootNode;
}

function boxesOf(root: DOMElement, pick: (e: DOMElement) => boolean): DOMElement[] {
  const out: DOMElement[] = [];
  const walk = (n: DOMElement): void => {
    if (pick(n)) out.push(n);
    for (const c of n.childNodes) if (c.nodeName !== '#text') walk(c);
  };
  walk(root);
  return out;
}

/** A box that clips vertically only: the boxes the render-cost change moved off Ink's horizontal clip path. */
const verticalOnly = (n: DOMElement): boolean => n.nodeName === 'ink-box' && n.style.overflowY === 'hidden' && n.style.overflow !== 'hidden' && n.style.overflowX !== 'hidden';

function textOf(n: DOMElement): string {
  let s = '';
  for (const c of n.childNodes) s += c.nodeName === '#text' ? c.nodeValue : textOf(c);
  return s;
}

/** Every way a vertical-only box can break the invariant (empty when it holds). */
function clipViolations(box: DOMElement): string[] {
  const label = JSON.stringify(textOf(box).slice(0, 40));
  const out: string[] = [];
  const width = box.yogaNode?.getComputedWidth() ?? Number.NaN;
  const row = box.style.flexDirection === undefined || box.style.flexDirection === 'row' || box.style.flexDirection === 'row-reverse';
  if (box.style.borderStyle !== undefined) out.push(`${label}: the box has a border`);
  if (row && box.childNodes.length !== 1) out.push(`${label}: a row box wraps ${box.childNodes.length} children, not exactly one`);
  for (const c of box.childNodes) {
    if (c.nodeName !== 'ink-text') {
      out.push(`${label}: a ${c.nodeName} child (only truncate Texts may lose the horizontal clip)`);
      continue;
    }
    const wrap = c.style.textWrap ?? 'wrap';
    if (!wrap.startsWith('truncate')) out.push(`${label}: a Text child wraps with "${wrap}", not truncate`);
    const left = c.yogaNode?.getComputedLeft() ?? Number.NaN;
    const w = c.yogaNode?.getComputedWidth() ?? Number.NaN;
    if (!(left >= 0 && left + w <= width)) out.push(`${label}: a Text child spans ${left}..${left + w} outside the box's 0..${width}`);
  }
  return out;
}

/**
 * The output with every vertical-only box as drawn, and again with those boxes flipped back to `overflow="hidden"`
 * (Ink never passes `overflow` to Yoga, so the layout is the same; only the clip differs). Styles are restored after.
 */
function clipFlip(root: DOMElement): { boxes: number; asIs: string; flipped: string } {
  const boxes = boxesOf(root, verticalOnly);
  const asIs = inkRenderer(root, false);
  const saved = boxes.map((b) => b.style);
  for (const b of boxes) b.style = { ...b.style, overflow: 'hidden' };
  const flipped = inkRenderer(root, false);
  boxes.forEach((b, i) => {
    b.style = saved[i] ?? b.style;
  });
  return { boxes: boxes.length, asIs: asIs.staticOutput + asIs.output, flipped: flipped.staticOutput + flipped.output };
}

describe('frame identity: the real App, byte for byte (SGR included)', () => {
  for (const [rows, columns] of SIZES) {
    for (const state of STATES) {
      it(`${rows}x${columns} ${state}`, async () => {
        const { frame, root } = await frameFor(rows, columns, state);
        expect(frame.length).toBeGreaterThan(0);
        // the wordmark's `◆ <version>` is masked, so a release bump never re-pins the frames (test/unit/helpers/version-free.ts)
        expect(versionFree(frame)).toMatchSnapshot();
        // the vertical-only boxes of this frame hold the invariant, and flipping them back changes no byte
        const boxes = boxesOf(root, verticalOnly);
        expect(boxes.flatMap(clipViolations)).toEqual([]);
        // in the boxed tier the console alone is five of them (top edge, a composer row, divider, status row, bottom
        // edge); the flat tier (12x60) draws the composer and the status line without the console box
        if (chromeRows(rows, columns, false) === CAP.chrome) expect(boxes.length).toBeGreaterThanOrEqual(5);
        const flip = clipFlip(root);
        expect(flip.flipped).toBe(flip.asIs);
      });
    }
  }
});

const blocking: BlockingRequest = { id: 'b1', step: 0, kind: 'key-rejected', side: 'jev', detail: 'HTTP 401 — "User not found." while resolving the 日本語 key ─┤ from the environment and the config file', sources: ['env JEV_API_KEY', 'OPENROUTER_API_KEY'], stop: 'error', exitCode: 2 };
const followup = { runCapUsd: 2, clampedToUsd: 0.42, sessionSpentUsd: 9.58, sessionCapUsd: 10, runs: 5, lastRunUsd: 0.71 };
const paletteState = { lastStop: null, unauthorized: false, changedFiles: false, rewindMenu: false, live: false };
const LONG = `wide 日本語テキスト ${'─'.repeat(30)} café\u0301 👍🏽 ${'x'.repeat(140)}`;

/** Every `Overlay` kind that draws `Rows`, `Card` or a palette box, in both tiers. */
const OVERLAYS: readonly { name: string; kind: OverlayKind; rows: number; data: OverlayData; degraded?: 'minsize' }[] = [
  { name: 'followup', kind: 'followup', rows: 5, data: { followup } },
  { name: 'secret', kind: 'secret', rows: 1, data: { secret: { hits: detectSecrets(`key sk-ant-api03-${'A'.repeat(40)} 日本語 ${'y'.repeat(120)}`) } } },
  { name: 'blocking', kind: 'blocking', rows: 5, data: { blocking } },
  { name: 'palette /', kind: 'palette', rows: 8, data: { palette: { query: '/', state: paletteState, selected: 1 } } },
  { name: 'palette /b', kind: 'palette', rows: 6, data: { palette: { query: '/b', state: paletteState, selected: 0 } } },
  { name: 'mention', kind: 'palette', rows: 5, data: { mention: { rows: ['src/a.py', `src/${'日本語/'.repeat(12)}deep.py`, `tests/${'z'.repeat(150)}.py`], selected: 1 } } },
  { name: 'undo', kind: 'undo', rows: 3, data: { undo: { row: `undo step 3? ${LONG}` } } },
  { name: 'exitConfirm', kind: 'exitConfirm', rows: 3, data: {} },
  { name: 'minsize', kind: 'none', rows: 1, data: {}, degraded: 'minsize' },
];

function mountAlone(el: React.JSX.Element, columns: number, rows = 40): { root: DOMElement; unmount: () => void } {
  const stdout = new StubStdout(rows, columns);
  const instance = render(el, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: new StubStdin() as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  return { root: rootOf(stdout), unmount: () => instance.unmount() };
}

describe('vertical-only clip boxes: one truncate Text per row, and the horizontal clip was a no-op', () => {
  for (const columns of [40, 60, 80, 120]) {
    for (const o of OVERLAYS) {
      for (const chrome of [0, 3] as const) {
        it(`Overlay ${o.name} chrome ${chrome} at ${columns} columns`, () => {
          const m = mountAlone(<Overlay kind={o.kind} rows={o.rows} previewRows={0} columns={columns} terminalRows={o.degraded ? 5 : 24} top={0} data={o.data} chrome={chrome} color={24} {...(o.degraded ? { degraded: o.degraded } : {})} />, columns);
          unmounts.push(m.unmount);
          const boxes = boxesOf(m.root, verticalOnly);
          expect(boxes.length).toBeGreaterThan(0);
          expect(boxes.flatMap(clipViolations)).toEqual([]);
          const flip = clipFlip(m.root);
          expect(flip.asIs.length).toBeGreaterThan(0);
          expect(flip.flipped).toBe(flip.asIs);
        });
      }
    }
    for (const size of [undefined, 'open', 'full'] as const) {
      it(`Pane ${size ?? 'tab'} at ${columns} columns, and the picker's override rows`, () => {
        const built = mountAlone(<Pane state={paneState()} rows={6} columns={columns} overlay="none" terminalRows={40} color={24} {...(size ? { size } : {})} />, columns);
        const picker = mountAlone(<Pane state={paneState()} rows={4} columns={columns} overlay="none" terminalRows={40} lines={[LONG, `▌ ${'─'.repeat(200)}`, 'short', `  👍🏽 ${'日本'.repeat(80)}`]} selected={1} color={24} />, columns);
        unmounts.push(built.unmount, picker.unmount);
        for (const m of [built, picker]) {
          const boxes = boxesOf(m.root, verticalOnly);
          expect(boxes).toHaveLength(1);
          expect(boxes.flatMap(clipViolations)).toEqual([]);
          const flip = clipFlip(m.root);
          expect(flip.flipped).toBe(flip.asIs);
        }
      });
    }
  }

  it('the check has teeth: a row box holding two Texts, or a non-truncating Text, is reported', () => {
    const m = mountAlone(<Overlay kind="undo" rows={1} previewRows={0} columns={40} terminalRows={24} top={0} data={{ undo: { row: LONG } }} />, 40);
    unmounts.push(m.unmount);
    const [box] = boxesOf(m.root, verticalOnly);
    expect(box).toBeDefined();
    if (box === undefined) return;
    const text = box.childNodes[0];
    expect(text?.nodeName).toBe('ink-text');
    if (text === undefined || text.nodeName === '#text') return;
    const savedBox = box.style;
    const savedText = text.style;
    box.style = { ...box.style, flexDirection: 'row' };
    box.childNodes.push(text);
    expect(clipViolations(box).some((v) => v.includes('not exactly one'))).toBe(true);
    box.childNodes.pop();
    text.style = { ...text.style, textWrap: 'wrap' };
    expect(clipViolations(box).some((v) => v.includes('not truncate'))).toBe(true);
    box.style = savedBox;
    text.style = savedText;
    expect(clipViolations(box)).toEqual([]);
  });

  it('…and the flip has teeth: content wider than a vertical-only box shows up as a byte difference', () => {
    const m = mountAlone(
      <Box width={10} height={1} overflowY="hidden">
        <Box width={30} flexShrink={0}>
          <Text>{'x'.repeat(30)}</Text>
        </Box>
      </Box>,
      40,
    );
    unmounts.push(m.unmount);
    const [box] = boxesOf(m.root, verticalOnly);
    expect(box === undefined ? [] : clipViolations(box)).toContainEqual(expect.stringContaining('ink-box child'));
    const flip = clipFlip(m.root);
    expect(flip.asIs).toContain('x'.repeat(30));
    expect(flip.flipped).not.toContain('x'.repeat(11));
  });
});
