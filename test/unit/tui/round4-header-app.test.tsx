/**
 * TUI-DESIGN-4 §1 / §10 S1 — slot S1's **own** App-level tests over the real Ink renderer on a stub TTY
 * (`debug: true`, so every commit is a frame). Never in `app.test.tsx` / `round2-app.test.tsx` /
 * `round3-*-app.test.tsx` (§9.1): the one declared carve-out there is `app.test.tsx:106`.
 *
 * What is pinned here:
 *  - **P-H1 / D-T a** — after the first `run:ready` the rule row's strip carries `◆ jevcode`, **whether or not**
 *    the 5-row mark is up (F-H1, F-H2; TD3 §729 F-W5 "the strip keeps its information; the mark sits under it");
 *  - **P-H2 / D-T b** — the mark stays up during a live run at `rows ≥ WORDMARK_LIVE_MIN_ROWS = 32`, yields at 31,
 *    and the idle sweep is **frozen** while live, so a run still writes zero decoration frames (the `idle-frames`
 *    and `dynamic ≤ maxFps + 1` gates are untouched);
 *  - **P-H3** — the wordmark renders inside `<PaneBoundary pane="wordmark">` and `mark.spans()` inside `guard()`:
 *    an injected fault degrades the five rows to blanks and appends one `[ui]` item, and the frame survives;
 *  - **D-F / the memoised `SplashRow`** — a keystroke while the mark is up leaves the five mark rows byte-identical;
 *  - **§1.4** — the real renderer's clear on a shrink resize carries `ESC[2J` and **never** `ESC[3J`.
 */
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import type { LaunchSettings } from '../../../src/core/types.js';
import { App, SYNC_COMMIT_MIN_MS, createBridge, createTuiRenderer, shouldSyncCommit, type Bridge } from '../../../src/tui/App.js';
import { WORDMARK } from '../../../src/tui/splash.js';
import { alternateScreenEntered, markAlternateScreen } from '../../../src/tui/terminal.js';
import { WORDMARK_LIVE_MIN_ROWS } from '../../../src/tui/wordmark.js';
import { createEventBus, createTuiConfirmer } from '../../../src/tui/useEngine.js';
import { mkRunResult, mkStatus, tick } from '../../fixtures/tui/fixtures.js';
import { StubStdin, StubStdout, dynamicRegion, stripSgr } from './stub-stdout.js';

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
});

/** motion allowed, colour on (`FORCE_COLOR` → depth 16, so the idle loop is `enabled`), no SSH */
const MOTION: LaunchSettings & { reducedMotion: boolean } = { fps: 30, renderMode: 'standard', screenReader: false, ascii: false, noColor: false, reducedMotion: false };
const ENV: NodeJS.ProcessEnv = { FORCE_COLOR: '1' };
const markRow = (r: number, columns: number): string => `${' '.repeat(Math.floor((columns - 56) / 2))}${WORDMARK[r]}`.replace(/\s+$/, '');

interface M {
  stdout: StubStdout;
  stdin: StubStdin;
  bus: ReturnType<typeof createEventBus>;
  bridge: Bridge;
  dyn: () => string[];
  frame: () => string;
  frames: () => string[][];
}

function mount(rows: number, columns: number, o: { fault?: string; tickMs?: number } = {}): M {
  const stdout = new StubStdout(rows, columns, true);
  const stdin = new StubStdin();
  const bus = createEventBus();
  const bridge = createBridge(null, null);
  const instance = render(
    <App task="" resumeId={null} source={bus} confirmer={createTuiConfirmer()} onAbort={() => undefined} mode="session" cwd="/tmp/proj" tickMs={o.tickMs ?? 0} bridge={bridge} launch={MOTION} env={ENV} {...(o.fault === undefined ? {} : { fault: o.fault })} />,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  unmounts.push(() => instance.unmount());
  return {
    stdout,
    stdin,
    bus,
    bridge,
    dyn: () => dynamicRegion(stripSgr(stdout.lastFrame()), columns),
    frame: () => stripSgr(stdout.lastFrame()),
    frames: () => stdout.frames.map((f) => dynamicRegion(stripSgr(f), columns)),
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}

const settle = async (m: M): Promise<void> => {
  m.bridge.command({ type: 'dispatch', action: { type: 'splash:done' } });
  await tick(30);
};
const startRun = (m: M): void => {
  m.bus.emit({ type: 'run:start', runId: 'r1', task: 'Fix the failing test', mode: 'jev-on', resumedFromStep: null });
};
const readyRun = (m: M, step = 3): void => {
  m.bus.emit({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 'Fix the failing test', resumed: false });
  m.bus.emit({ type: 'status', status: mkStatus(step, 'propose') });
};
const endRun = (m: M): void => {
  m.bus.emit({ type: 'run:end', result: { ...mkRunResult('complete'), steps: 3 }, exitCode: 0 });
};
const hasMark = (dyn: readonly string[], columns: number): boolean => dyn.includes(markRow(1, columns));
const ruleRow = (m: M): string => m.dyn()[0] ?? '';

describe('P-H1 (D-T a): the brand never leaves the rule row once a run has been ready', () => {
  it('F-H1 at 24×80: the strip leads with `◆ jevcode` and the 5-row mark sits UNDER it (the two coexist)', async () => {
    const m = mount(24, 80);
    await settle(m);
    startRun(m);
    readyRun(m);
    await waitFor(() => ruleRow(m).includes('▸ jev'));
    endRun(m);
    await waitFor(() => hasMark(m.dyn(), 80));
    const dyn = m.dyn();
    expect(dyn[0]).toMatch(/^─── ◆ jevcode ─ ▸ jev /);
    expect([...stripSgr(dyn[0] ?? '')]).toHaveLength(80);
    // F-W5 / F-H1: the mark is below the strip in the SAME frame
    expect(hasMark(dyn, 80)).toBe(true);
    expect(dyn.indexOf(markRow(1, 80))).toBeGreaterThan(0);
  });

  it('the brand is absent before the first `run:ready` (the rule row is the plain rule under the mark / the brand row)', async () => {
    const m = mount(24, 80);
    await settle(m);
    await waitFor(() => hasMark(m.dyn(), 80));
    expect(ruleRow(m)).toBe('─'.repeat(80));
    startRun(m);
    // `run:start` alone: the brand ROW (round 2's) takes the rule row, not the strip
    await waitFor(() => /^─── ◆ jevcode \S+ ─+$/.test(ruleRow(m)));
    expect(ruleRow(m)).not.toContain('▸ jev');
  });

  it('the brand is dropped first below 64 columns, and the strip is still exactly `columns` cells (edge 1)', async () => {
    const m = mount(24, 44);
    await settle(m);
    startRun(m);
    readyRun(m);
    await waitFor(() => ruleRow(m).includes('▸ jev'));
    expect(ruleRow(m)).not.toContain('jevcode');
    expect([...ruleRow(m)]).toHaveLength(44);
  });
});

describe('P-H2 (D-T b): the mark stays up during a live run at >= 32 rows, with the sweep frozen', () => {
  it('F-H2: at 34×80 the mark is present in a frame captured WHILE the run is live, under the branded strip', async () => {
    const m = mount(34, 80);
    await settle(m);
    startRun(m);
    readyRun(m);
    await waitFor(() => ruleRow(m).includes('▸ jev'));
    expect(m.bridge.stateReader?.()?.run).toBe('live');
    expect(hasMark(m.dyn(), 80)).toBe(true);
    expect(m.dyn()[0]).toMatch(/^─── ◆ jevcode ─ ▸ jev /);
  });

  it('at 31 rows the run needs the rows: the mark yields (the boundary is exactly WORDMARK_LIVE_MIN_ROWS)', async () => {
    expect(WORDMARK_LIVE_MIN_ROWS).toBe(32);
    const m = mount(31, 80);
    await settle(m);
    startRun(m);
    readyRun(m);
    await waitFor(() => ruleRow(m).includes('▸ jev'));
    expect(hasMark(m.dyn(), 80)).toBe(false);
    const at32 = mount(32, 80);
    await settle(at32);
    startRun(at32);
    readyRun(at32);
    await waitFor(() => ruleRow(at32).includes('▸ jev'));
    expect(hasMark(at32.dyn(), 80)).toBe(true);
  });

  it('the idle sweep is FROZEN while live: a quiet second with the mark up writes no decoration frame', async () => {
    const m = mount(34, 80);
    await settle(m);
    startRun(m);
    readyRun(m);
    await waitFor(() => hasMark(m.dyn(), 80));
    // §11's `idle-animation` live row: the run's busiest second must be UNCHANGED by the mark. The run's own spinner
    // keeps writing either way, so the measurement is the 34-row frame count (mark up) against the 31-row one
    // (mark down) over the same window — the sweep would show up as the difference.
    const down = mount(31, 80);
    await settle(down);
    startRun(down);
    readyRun(down);
    await waitFor(() => ruleRow(down).includes('▸ jev'));
    expect(hasMark(down.dyn(), 80)).toBe(false);
    const a0 = m.stdout.frames.length;
    const b0 = down.stdout.frames.length;
    await tick(700);
    const withMark = m.stdout.frames.length - a0;
    const withoutMark = down.stdout.frames.length - b0;
    expect(Math.abs(withMark - withoutMark), `${withMark} vs ${withoutMark}`).toBeLessThanOrEqual(2);
    // and the five mark rows are byte-identical (SGR included) across the whole window: the sweep painted nothing
    const markCells = (raw: string): string => {
      const lines = raw.split('\n');
      const at = lines.findIndex((l) => stripSgr(l).trimEnd() === markRow(1, 80));
      return at === -1 ? '' : lines.slice(at, at + 4).join('\n');
    };
    const seen = new Set(m.stdout.frames.slice(a0).map(markCells).filter((x) => x !== ''));
    expect(seen.size, [...seen].join(' | ').slice(0, 400)).toBeLessThanOrEqual(1);
    expect(hasMark(m.dyn(), 80)).toBe(true);
    // ...and once the run ends the sweep is allowed again (the mark stays, the machinery is not disabled)
    endRun(m);
    await waitFor(() => (m.bridge.stateReader?.()?.run ?? 'live') === 'none');
    expect(hasMark(m.dyn(), 80)).toBe(true);
  });

  it('D-F / the memoised SplashRow: a keystroke while the mark is up leaves the five mark rows byte-identical', async () => {
    const m = mount(34, 80);
    await settle(m);
    startRun(m);
    readyRun(m);
    await waitFor(() => hasMark(m.dyn(), 80));
    const rowsOf = (d: readonly string[]): string[] => {
      const at = d.indexOf(markRow(1, 80));
      return d.slice(at - 1, at + 4);
    };
    const before = rowsOf(m.dyn());
    expect(before.filter((r) => r.trim() !== '')).toHaveLength(5);
    m.stdin.write('h');
    await waitFor(() => m.frame().includes('› h'));
    expect(rowsOf(m.dyn())).toEqual(before);
  });
});

describe('P-H3: the wordmark renders inside a boundary and its spans are guarded', () => {
  /**
   * `render:wordmark` is the **boundary's** fault string (`renderFaultFor`); `render:wordmark:lines` is the
   * **guard's** (`builderFaultFor`). The two take different paths and P-H3's deliverable is the second one: the
   * `guard('wordmark', () => mark.spans(loop.band), null)` whose fallback is blank rows of the SAME height.
   */
  it("the guard() path (`render:wordmark:lines`): the five rows stay, blank, and the frame keeps its height", async () => {
    const m = mount(24, 80, { fault: 'render:wordmark:lines' });
    // The injected builder fault is ONE-SHOT (`RENDER_FAULTS_FIRED`) and `mark` is a fresh object every render, so
    // the guard fires on the FIRST render in which the mark exists — the splash's own frame — and the mark is back
    // on the next one. The degradation is therefore asserted on the captured frame, not on `lastFrame()`.
    const first = m.frames()[0] ?? [];
    const edge = first.findIndex((l) => l.startsWith('╭─'));
    expect(edge, first.join('|')).toBeGreaterThan(0);
    // the five rows `computeLayout` granted are all there and all BLANK: the rendered height still equals the
    // allocated height (§1.3.2 edge 5 / P-H3), and not one `█` of the mark was drawn
    const between = first.slice(1, edge);
    expect(between, first.join('|')).toHaveLength(5);
    expect(between.every((l) => l.trim() === ''), JSON.stringify(between)).toBe(true);
    expect(first[0]).toBe('─'.repeat(80));
    expect(hasMark(first, 80)).toBe(false);
    // the guard reports AFTER commit: exactly one `[ui]` item, and the console and composer survive
    await waitFor(() => m.frame().includes('ui: wordmark'));
    expect(m.frame().split('ui: wordmark').length - 1).toBe(1);
    expect(m.frame()).toContain('? help');
    // and the fault is one-shot, so the idle tenant comes back on the next render (no permanent degradation)
    await settle(m);
    expect(await waitFor(() => hasMark(m.dyn(), 80))).toBe(true);
  });

  it('an injected RENDER fault degrades the mark to BLANK rows of the same height, appends one `[ui]` item, and the rest of the frame survives', async () => {
    const m = mount(24, 80, { fault: 'render:wordmark' });
    await settle(m);
    startRun(m);
    readyRun(m);
    await waitFor(() => ruleRow(m).includes('▸ jev'));
    endRun(m);
    await waitFor(() => m.frame().includes('wordmark'));
    // the idle tenant disappears silently — blank rows, not a crashed frame
    expect(hasMark(m.dyn(), 80)).toBe(false);
    expect(m.frame()).toContain('ui: wordmark pane failed to render');
    // the rule row, the console and the composer are all still there
    expect(ruleRow(m)).toMatch(/^─── ◆ jevcode ─ ▸ jev /);
    expect(m.frame()).toContain('? help');
  });
});

describe('§1.4: the real renderer never writes ESC[3J', () => {
  /**
   * The shrink must be one Ink actually clears for, or the assertion is vacuous. `shouldClearTerminalForFrame`
   * (`ink.js:89–110`) takes the branch when the PREVIOUS frame was at least as tall as the new viewport, so the
   * resize has to go below the dynamic region's own height (~11 rows at 24×80) — 24 → 8. The unguarded control
   * below proves Ink really does write `ESC[3J` here, so the guard is the only reason it is absent above.
   */
  const shrinkCapture = async (guarded: boolean): Promise<{ clears: number; saved: number; writes: number }> => {
    const stdout = new StubStdout(24, 80, true);
    const stdin = new StubStdin();
    let stop: () => Promise<void> | void;
    if (guarded) {
      const r = createTuiRenderer({
        task: 'x',
        resumeId: null,
        mode: 'session',
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        env: ENV,
        launch: MOTION,
        onAbort: () => undefined,
      });
      await r.firstFrame();
      stop = () => r.unmount();
    } else {
      const bus = createEventBus();
      const bridge = createBridge(null, null);
      const inst = render(
        <App task="" resumeId={null} source={bus} confirmer={createTuiConfirmer()} onAbort={() => undefined} mode="session" cwd="/tmp/proj" bridge={bridge} launch={MOTION} env={ENV} />,
        { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false },
      );
      stop = () => inst.unmount();
    }
    await tick(80);
    stdout.resize(8, 80);
    await tick(140);
    await stop();
    await tick(30);
    const all = stdout.frames.join('');
    return { clears: all.split('\u001b[2J').length - 1, saved: all.split('\u001b[3J').length - 1, writes: stdout.frames.length };
  };

  it('a shrink resize through `createTuiRenderer` writes a clear WITH `ESC[2J` and WITHOUT the saved-lines erase', async () => {
    const guarded = await shrinkCapture(true);
    // the positive half — without it the `not.toContain` below could pass on a capture with no clears at all
    expect(guarded.clears, `writes: ${guarded.writes}`).toBeGreaterThanOrEqual(1);
    expect(guarded.saved).toBe(0);
    // §11's strengthened row: at most ONE clear for the whole shrink transition (P-R1 commits before Ink repaints)
    expect(guarded.clears).toBeLessThanOrEqual(1);
  });

  it('the control: the SAME shrink on an unguarded stdout does write `ESC[3J`, so the test is not vacuous', async () => {
    const raw = await shrinkCapture(false);
    expect(raw.clears, `writes: ${raw.writes}`).toBeGreaterThanOrEqual(1);
    expect(raw.saved).toBeGreaterThanOrEqual(1);
    expect(raw.saved).toBe(raw.clears);
  });
});

/**
 * TUI-DESIGN-4 §1.3 — the opt-in `fullscreen` renderer, mounted through the real `<App>` on a stub TTY.
 *
 * The three things that must hold for it to be shippable at all: the tree is EXACTLY `rows` lines (§1.3.2 edge 5 —
 * one row of error is a full-screen clear per keystroke), the header is at row 1, and `classic` is untouched.
 */
describe('§1.3: the fullscreen renderer', () => {
  const mountFull = (rows: number, columns: number): M => {
    const stdout = new StubStdout(rows, columns, true);
    const stdin = new StubStdin();
    const bus = createEventBus();
    const bridge = createBridge(null, null);
    const instance = render(
      <App task="" resumeId={null} source={bus} confirmer={createTuiConfirmer()} onAbort={() => undefined} mode="session" cwd="/tmp/proj" tickMs={0} bridge={bridge} launch={MOTION} env={ENV} renderer="fullscreen" />,
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false },
    );
    unmounts.push(() => instance.unmount());
    return {
      stdout,
      stdin,
      bus,
      bridge,
      dyn: () => stripSgr(stdout.lastFrame()).replace(/\n$/, '').split('\n'),
      frame: () => stripSgr(stdout.lastFrame()),
      frames: () => stdout.frames.map((f) => dynamicRegion(stripSgr(f), columns)),
    };
  };

  it('the frame is EXACTLY `rows` lines at every tier, with nothing above row 1', async () => {
    for (const [rows, columns] of [
      [24, 80],
      [30, 120],
      [20, 80],
      [18, 40],
      [24, 44],
      [40, 200],
    ] as const) {
      const m = mountFull(rows, columns);
      await tick(40);
      m.bridge.command({ type: 'dispatch', action: { type: 'splash:done' } });
      await tick(30);
      for (let i = 0; i < 12; i++) m.bus.emit({ type: 'notice', step: null, kind: 'ui', level: 'info', text: `row ${i} of a transcript long enough to wrap at every width in this sweep`, label: '[ui]' });
      await tick(60);
      const lines = m.dyn();
      expect(lines.length, `${rows}x${columns}: ${lines.length}`).toBe(rows);
      for (const l of lines) expect([...l].length, `${rows}x${columns}: ${JSON.stringify(l)}`).toBeLessThanOrEqual(columns);
      unmounts.pop()?.();
    }
  });

  it('the header is at ROW 1: the 5-row mark at 24×80, P-H1’s brand strip in the compact tier at 20×80', async () => {
    const tall = mountFull(24, 80);
    await tick(40);
    tall.bridge.command({ type: 'dispatch', action: { type: 'splash:done' } });
    await tick(40);
    expect(tall.dyn()[0]).toBe(markRow(0, 80));
    expect(tall.dyn()).toHaveLength(24);
    unmounts.pop()?.();
    const compact = mountFull(20, 80);
    await tick(40);
    compact.bridge.command({ type: 'dispatch', action: { type: 'splash:done' } });
    await tick(40);
    // the compact header IS P-H1's strip, verbatim — brand first, the position segment right-aligned
    expect(compact.dyn()[0]).toMatch(/^─── ◆ jevcode ─ ▸ jev /);
    expect(compact.dyn()[0]).toMatch(/ 100 %( · PgUp)? ─+$/);
    expect(compact.dyn()).toHaveLength(20);
  });

  it('PgUp scrolls the viewport and the position segment follows; Ctrl+End reattaches', async () => {
    const m = mountFull(24, 80);
    await tick(40);
    m.bridge.command({ type: 'dispatch', action: { type: 'splash:done' } });
    await tick(30);
    for (let i = 0; i < 60; i++) m.bus.emit({ type: 'notice', step: null, kind: 'ui', level: 'info', text: `scrollback row ${i}`, label: '[ui]' });
    await tick(80);
    const atBottomRow = m.dyn()[5] ?? '';
    expect(atBottomRow).toMatch(/100 %/);
    m.stdin.write('\u001b[5~'); // PgUp
    await waitFor(() => !/100 %/.test(m.dyn()[5] ?? ''));
    expect(m.dyn()[5], m.dyn()[5]).toMatch(/\d+ %/);
    expect(m.dyn()).toHaveLength(24);
    // the `▲ n earlier rows · PgUp` marker takes the viewport's FIRST row, never an extra one
    expect(m.dyn()[6]).toContain('earlier rows');
    m.stdin.write('\u001b[1;5F'); // Ctrl+End
    await waitFor(() => /100 %/.test(m.dyn()[5] ?? ''));
    expect(m.dyn()).toHaveLength(24);
  });

  it('`createTuiRenderer` refuses fullscreen below 18 rows and says so once, in classic', async () => {
    const stdout = new StubStdout(14, 80, true);
    const stdin = new StubStdin();
    const r = createTuiRenderer({
      task: 'x',
      resumeId: null,
      mode: 'session',
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      env: { ...ENV, TERM: 'xterm-256color' },
      launch: { ...MOTION, renderer: 'fullscreen' },
      onAbort: () => undefined,
    });
    await r.firstFrame();
    await tick(80);
    const all = stripSgr(stdout.frames.join(''));
    expect(all).toContain('fullscreen needs 18 rows (now 14) — the classic renderer is used');
    expect(all.split('fullscreen needs 18 rows').length - 1).toBe(1);
    // classic: no alternate screen was entered
    expect(stdout.frames.join('')).not.toContain('\u001b[?1049h');
    await r.unmount();
  });

  it('`createTuiRenderer` enters the alternate screen when fullscreen is accepted, and leaves it at exit', async () => {
    const stdout = new StubStdout(30, 100, true);
    const stdin = new StubStdin();
    const r = createTuiRenderer({
      task: 'x',
      resumeId: null,
      mode: 'session',
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      env: { ...ENV, TERM: 'xterm-256color' },
      launch: { ...MOTION, renderer: 'fullscreen' },
      onAbort: () => undefined,
    });
    await r.firstFrame();
    await tick(60);
    const all = stdout.frames.join('');
    expect(all).toContain('\u001b[?1049h');
    expect(all).not.toContain('\u001b[3J');
    expect(alternateScreenEntered()).toBe(true);
    await r.unmount();
    expect(stdout.frames.join('')).not.toContain('\u001b[3J');
    markAlternateScreen(false);
  });
});

/**
 * TUI-DESIGN-4 §2.2 P-R1 — the synchronous commit, measured at the renderer from S1's side (S2 owns
 * `renderer-resize.test.tsx`; S1 owns the code and must not ship it untested).
 *
 * `instance.rerender` is `updateContainerSync` + `flushSyncWork`, so a synchronous commit writes a frame **inside**
 * the `resize()` call; Ink's own `resized()` handler is asynchronous, so nothing else can. Counting the writes
 * across the call is therefore an exact observation of whether P-R1 fired.
 */
describe('§2.2 P-R1: the synchronous commit on a shrinking dimension and on every width change', () => {
  const g = (rows: number, columns: number): { rows: number; columns: number } => ({ rows, columns });
  /** far past the guard, so the rate limit is out of the way */
  const LATE = 1_000;

  it('commits for ↓rows, ↓cols, ↔rows/↓cols and ↑rows/↓cols; a pure ↑rows does not', () => {
    expect(shouldSyncCommit(g(40, 120), g(30, 120), LATE, 0), '↓rows').toBe(true);
    expect(shouldSyncCommit(g(40, 120), g(40, 100), LATE, 0), '↓cols').toBe(true);
    expect(shouldSyncCommit(g(40, 120), g(24, 80), LATE, 0), '↓rows ↓cols').toBe(true);
    expect(shouldSyncCommit(g(24, 120), g(40, 80), LATE, 0), '↑rows ↓cols').toBe(true);
    expect(shouldSyncCommit(g(24, 80), g(40, 80), LATE, 0), '↑rows').toBe(false);
    expect(shouldSyncCommit(g(24, 80), g(24, 80), LATE, 0), 'no change').toBe(false);
  });

  /**
   * §2.2's prose and its own patch say "on any shrinking dimension and on **every** width change"; §10's S2 row
   * says "none for ↑rows/↑cols". They disagree about a pure width GROW, and the code follows the prose, because
   * that is what the measured defect needs: A2's `out/tear` capture found the stray `│` with dead space after it
   * on a **grow** frame — the box edges follow `columns` immediately while the body still wrapped at the old
   * width. The report carries the §9.2 request to S2 to amend the `renderer-resize.test.tsx` row.
   */
  it('a width GROW also commits (the §2.2 prose wins over §10 S2 — the measured tear is a grow frame)', () => {
    expect(shouldSyncCommit(g(24, 60), g(24, 120), LATE, 0), '↑cols').toBe(true);
    expect(shouldSyncCommit(g(24, 60), g(40, 120), LATE, 0), '↑rows ↑cols').toBe(true);
  });

  it('SYNC_COMMIT_MIN_MS is the storm guard: inside 8 ms of the last commit, nothing commits', () => {
    expect(SYNC_COMMIT_MIN_MS).toBe(8);
    for (let dt = 0; dt < 8; dt++) expect(shouldSyncCommit(g(40, 120), g(30, 100), 1_000 + dt, 1_000), `${dt} ms`).toBe(false);
    expect(shouldSyncCommit(g(40, 120), g(30, 100), 1_008, 1_000), '8 ms').toBe(true);
    // 20 driver resizes inside one 8 ms window are ~40 events and exactly ONE commit
    let lastSyncAt = -SYNC_COMMIT_MIN_MS;
    let prev = g(40, 120);
    let commits = 0;
    for (let n = 0; n < 40; n++) {
      const next = g(40 - (n % 3), 120 - n);
      const now = 1_000 + n * 0.2; // ~8 ms for the whole storm
      if (shouldSyncCommit(prev, next, now, lastSyncAt)) {
        commits += 1;
        lastSyncAt = now;
      }
      prev = next;
    }
    expect(commits).toBe(1);
  });

  it('through the real renderer: a shrink writes a frame SYNCHRONOUSLY, inside the `resize()` call', async () => {
    const stdout = new StubStdout(40, 120, true);
    const r = createTuiRenderer({
      task: 'x',
      resumeId: null,
      mode: 'session',
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new StubStdin() as unknown as NodeJS.ReadStream,
      env: ENV,
      launch: MOTION,
      onAbort: () => undefined,
    });
    await r.firstFrame();
    await tick(80);
    // P-R1's listener is registered BEFORE `render()`, so it is listener 0; drop Ink's own (also synchronous) one
    // so the writes inside the call can only be the synchronous commit.
    for (const l of stdout.listeners('resize').slice(1)) stdout.off('resize', l as () => void);
    const before = stdout.frames.length;
    stdout.resize(24, 80);
    expect(stdout.frames.length - before, 'no synchronous commit').toBeGreaterThan(0);
    await r.unmount();
  });
});
