/**
 * TUI-DESIGN-4 §2 / §10 S2 (`round4-resize-app.test.tsx`) — the resize matrix's in-process half.
 *
 * Three things the pty suite cannot do cheaply and this file can:
 *
 *  1. **the exhaustive `computeLayout` invariant sweep** the audit ran (rows 0–60 × widths × overlay kinds × overlay
 *     wants × composer wants), folded in as a bounded property test: `total ≤ rows − 2` at every geometry, the
 *     minsize order of P-R5, and P-R6's `composer === 0, overlay ≥ 1` under `overlay: 'wizard'`;
 *  2. **V22 in process** — after a resize no *frame* is drawn at two widths: every box row of a frame is exactly that
 *     frame's rule-row width and none ends in the truncation ellipsis (A2 measured 4 of 24 frames failing this, D1);
 *  3. **the forbidden sequences** — zero `ESC[3J`, zero `ESC c`, zero `ESC[?1049h` across a whole resize ladder, and
 *     the clear budget of §2.1 counted per **driver resize step**, not per geometry segment (§2.0 consequence (d)).
 *
 * `App.tsx` is S1's file: P-R1's synchronous geometry commit lands there (§9.1, §9.2). These assertions are written so
 * they hold **before and after** that commit — they pin the property (`no frame is two widths`), never the mechanism.
 */
import { Box, Text, render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { App, createBridge, createTuiRenderer, type Bridge, type TuiRenderer } from '../../../src/tui/App.js';
import { CAP, MIN_COLUMNS, MIN_ROWS, chromeRows, computeLayout, type LayoutInput, type OverlayKind } from '../../../src/tui/layout.js';
import type { LaunchSettings } from '../../../src/core/types.js';
import { createEventBus, createTuiConfirmer } from '../../../src/tui/useEngine.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { GLYPHS, cellWidth } from '../../../src/tui/glyphs.js';
import { STATIC_ITEM_MAX_ROWS, bodyRows, bodyWidth, gutterMode, isCapRow } from '../../../src/tui/Transcript.js';
import { minsizeNotice } from '../../../src/tui/Overlay.js';
import { clearReSelfTest, clearStats, countClears } from '../../../src/perf/pty.js';
import { wizardMinsizeRow } from '../../../src/tui/onboarding/lines.js';
import { INITIAL_ONBOARDING, onboardingReducer } from '../../../src/tui/onboarding/reducer.js';
import { mkStatus, tick } from '../../fixtures/tui/fixtures.js';
import { StubStdin, StubStdout, dynamicRegion, stripSgr } from './stub-stdout.js';
import { mulberry32, pick } from './composer/helpers.js';

// `createTuiRenderer` mounts add Ink's own `beforeExit` hook; this file mounts several in one process
process.setMaxListeners(64);

const unmounts: Array<() => void> = [];
const renderers: TuiRenderer[] = [];
afterEach(async () => {
  for (const u of unmounts.splice(0)) u();
  for (const r of renderers.splice(0)) await r.unmount();
});

/** TUI-DESIGN-2 §5.3: reduced motion mounts with the splash `done`, so no frame depends on the animation clock. */
const STILL: LaunchSettings & { reducedMotion: boolean } = { fps: 30, renderMode: 'standard', screenReader: false, ascii: false, noColor: true, reducedMotion: true };

/** the wizard state `bridge.command({ type: 'wizard', detect })` produces below (the provider step). */
const WIZARD_AT_PROVIDER = onboardingReducer(INITIAL_ONBOARDING, { type: 'detect', missing: ['generator.apiKey'], mode: 'jev-on', provider: 'anthropic', trustNeeded: false });

const KINDS: readonly OverlayKind[] = ['none', 'review', 'wizard', 'followup', 'secret', 'blocking', 'palette', 'undo', 'exitConfirm', 'intake'];

function layoutInput(o: Partial<LayoutInput> & { rows: number; columns: number }): LayoutInput {
  return {
    overlay: 'none',
    overlayWant: 0,
    previewWant: 0,
    expanded: false,
    composerWant: 1,
    queueWant: 0,
    liveWant: 0,
    bannerWant: 0,
    paneWant: 0,
    chrome: 0,
    gate: 0,
    ...o,
  };
}

// ---------------------------------------------------------------------------------------
// 1. the exhaustive computeLayout invariant sweep (§2.1, §10 S2, §11 "rows − 2 at every geometry")
// ---------------------------------------------------------------------------------------
describe('computeLayout holds its invariants at every geometry of the resize matrix (§2.1, §11)', () => {
  const WIDTHS = [0, 1, 2, 10, 12, 16, 20, 23, 24, 30, 33, 34, 39, 40, 44, 60, 64, 80, 120, 200];

  it('rows 0…60 × 20 widths × 10 overlay kinds: `total === budget − remainder ≤ rows − 2`, every field ≥ 0, never NaN', () => {
    let cases = 0;
    for (let rows = 0; rows <= 60; rows++) {
      for (const columns of WIDTHS) {
        for (const overlay of KINDS) {
          for (const overlayWant of [0, 1, 4, 9]) {
            const chrome = chromeRows(rows, columns, false);
            const l = computeLayout(layoutInput({ rows, columns, overlay, overlayWant, composerWant: 3, previewWant: 4, liveWant: 2, queueWant: 2, bannerWant: 1, paneWant: 12, chrome }));
            cases += 1;
            expect(l.budget, `${rows}x${columns}`).toBe(Math.max(0, rows - 2));
            expect(l.total, `${rows}x${columns}/${overlay}`).toBeLessThanOrEqual(l.budget);
            for (const [k, v] of Object.entries(l)) {
              if (typeof v !== 'number') continue;
              expect(Number.isInteger(v), `${k} at ${rows}x${columns}`).toBe(true);
              expect(v, `${k} at ${rows}x${columns}`).toBeGreaterThanOrEqual(0);
            }
            const sum = l.status + l.rule + l.live + l.banner + l.pane + l.queue + l.overlay + l.preview + l.composer + l.chrome;
            expect(sum, `${rows}x${columns}/${overlay}`).toBe(l.total);
          }
        }
      }
    }
    expect(cases).toBe(61 * WIDTHS.length * KINDS.length * 4);
    // round-4 review finding 13: 48,800 cases take ~2.4 s isolated and ~24 s in-suite under a concurrent bench, over
    // the unit project's 20 s `testTimeout`. The sweep is the gate, so it keeps its size and carries its own budget.
  }, 60_000);

  it('`rows < 3` is static-only and grants nothing; minsize is everything below 40×8 and nothing at or above it', () => {
    for (let rows = 0; rows <= 2; rows++) {
      const l = computeLayout(layoutInput({ rows, columns: 80 }));
      expect(l.degraded).toBe('static-only');
      expect(l.total).toBe(0);
    }
    expect(computeLayout(layoutInput({ rows: MIN_ROWS, columns: MIN_COLUMNS })).degraded).toBe('none');
    expect(computeLayout(layoutInput({ rows: MIN_ROWS - 1, columns: MIN_COLUMNS })).degraded).toBe('minsize');
    expect(computeLayout(layoutInput({ rows: MIN_ROWS, columns: MIN_COLUMNS - 1 })).degraded).toBe('minsize');
    for (let rows = 3; rows <= 60; rows++) {
      for (const columns of WIDTHS) {
        const l = computeLayout(layoutInput({ rows, columns }));
        expect(l.degraded, `${rows}x${columns}`).toBe(rows < MIN_ROWS || columns < MIN_COLUMNS ? 'minsize' : 'none');
      }
    }
  });

  it('a 5,000-case random property sweep (the audit ran 829,600): no invariant violation, ≤ 20 µs per call', () => {
    const rnd = mulberry32(20260922);
    const started = performance.now();
    for (let i = 0; i < 5000; i++) {
      const rows = Math.floor(rnd() * 61);
      const columns = pick(rnd, WIDTHS);
      const l = computeLayout(
        layoutInput({
          rows,
          columns,
          overlay: pick(rnd, KINDS),
          overlayWant: Math.floor(rnd() * 10),
          previewWant: Math.floor(rnd() * 9),
          expanded: rnd() < 0.2,
          composerWant: 1 + Math.floor(rnd() * 8),
          queueWant: Math.floor(rnd() * 9),
          liveWant: Math.floor(rnd() * 3),
          bannerWant: rnd() < 0.3 ? 1 : 0,
          paneWant: pick(rnd, [0, 5, 6, 12]),
          chrome: chromeRows(rows, columns, rnd() < 0.2),
          gate: rnd() < 0.2 ? 1 : 0,
          paneWhole: rnd() < 0.5,
        }),
      );
      expect(l.total, `${rows}x${columns}`).toBeLessThanOrEqual(Math.max(0, rows - 2));
      expect(l.overlay).toBeLessThanOrEqual(Math.max(0, rows - 2));
      expect(l.chrome === 0 || l.chrome === CAP.chrome).toBe(true);
    }
    // 5,000 calls well under a second even on a loaded machine; the design's budget is ≤ 5 µs each
    expect(performance.now() - started).toBeLessThan(2000);
  }, 60_000);

  it('§10 S2 / P-R6 (D4): the minsize allocation at budgets 0…3, and the wizard keeps an overlay row at every one', () => {
    // §10 S2's `layout.test.ts` row, folded in here because `layout.ts` is S1's file: the assertions are on the
    // allocation, not on the allocator's source. Budget = rows − 2, so rows 2…5 are budgets 0…3.
    const at = (rows: number, overlay: 'none' | 'wizard'): ReturnType<typeof computeLayout> =>
      computeLayout(layoutInput({ rows, columns: 38, overlay, overlayWant: overlay === 'wizard' ? 3 : 0 }));
    expect(at(2, 'none').degraded).toBe('static-only'); // budget 0: nothing dynamic at all
    expect(at(2, 'none').total).toBe(0);
    for (const rows of [3, 4, 5, 6, 7]) {
      for (const overlay of ['none', 'wizard'] as const) {
        const l = at(rows, overlay);
        expect(l.degraded, `${rows}/${overlay}`).toBe('minsize');
        expect(l.total, `${rows}/${overlay}`).toBe(Math.min(3, rows - 2));
        expect(l.status + l.overlay + l.composer, `${rows}/${overlay}`).toBe(l.total);
      }
      // the half that matters to the user: from budget 2 up the notice slot exists, so the wizard has a row to draw in
      if (rows >= 4) expect(at(rows, 'wizard').overlay, `${rows}`).toBeGreaterThanOrEqual(1);
    }
    // P-R5 / P-R6 are still S1's (§9.2's `layout.ts` row): notice before composer at budget 1, and `composer === 0`
    // under `overlay: 'wizard'`. Both are REQUESTS, and neither is what closes D4 — see the App-level case below:
    // `Overlay.tsx` now draws the wizard's own row when the layout grants ONE, so the first-run user is told what is
    // wrong at every minsize geometry `computeLayout` can currently produce.
    expect(at(7, 'wizard').overlay).toBeGreaterThanOrEqual(1);
  });

  it('round-4 review finding 1 (D4): the minsize wizard row reaches a REAL frame at 38×7, through App.tsx', async () => {
    // Every earlier minsize-wizard test rendered `<Overlay kind="wizard" degraded="minsize">` directly — a prop
    // combination `App.tsx` cannot produce, because `App.tsx:2248` is
    // `kind={layout.degraded === 'minsize' ? 'none' : overlayKind}`. The overlay's dispatch now keys on
    // `data.wizard`, so this mounts the App at a minsize geometry with the wizard open and looks at the frame.
    const stdout = new StubStdout(7, 38);
    const bridge: Bridge = createBridge(null, null);
    const instance = render(<App task="setup task" resumeId={null} source={createEventBus()} confirmer={createTuiConfirmer()} onAbort={() => undefined} mode="session" tickMs={0} bridge={bridge} launch={STILL} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new StubStdin() as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    unmounts.push(() => instance.unmount());
    await tick(20);
    bridge.command({ type: 'wizard', detect: { missing: ['generator.apiKey'], mode: 'jev-on', provider: 'anthropic', trustNeeded: false } });
    // poll rather than sleep: the whole unit suite runs in parallel and a fixed `tick(40)` is a load-dependent flake
    // P-R6 is LANDED (integrator 2026-09-22): the minsize branch now grants notice(1) · wizard(1) and NO composer,
    // so the frame carries BOTH rows and the wizard's own row leads with the choices (`alone: false`) — the notice
    // above it already says why the panes are gone. §2.5's promise is unchanged: no caret, no key byte, no composer.
    const want = wizardMinsizeRow(WIZARD_AT_PROVIDER, 38, false, { alone: false });
    let rows: string[] = [];
    let wizardRow: string | undefined;
    for (let i = 0; i < 100 && wizardRow === undefined; i++) {
      await tick(20);
      rows = stripSgr(stdout.lastFrame()).split('\n').filter((r) => r.trim() !== '');
      wizardRow = rows.find((r) => r.trimEnd() === want);
    }
    expect(wizardRow, `no wizard row (${JSON.stringify(want)}) in ${JSON.stringify(rows)}`).toBeDefined();
    expect(want).toBe('1 anthropic  2 openrouter');
    // the notice sits above it and names the size, so the reason the panes are gone is on screen
    const notice = rows.find((r) => r.includes('40×8 minimum'));
    expect(notice, JSON.stringify(rows)).toBeDefined();
    expect(rows.indexOf(notice as string)).toBeLessThan(rows.indexOf(wizardRow as string));
    // §2.5's promise: read-only — never a caret and never a key byte, and no composer row at all
    for (const r of rows) expect(r).not.toContain('›');
    // the one-row form still names the size, for the `rows < 2` rung of the same ladder
    expect(wizardMinsizeRow(WIZARD_AT_PROVIDER, 38, false, { alone: true })).toBe('setup · provider — ≥ 40×8 to continue');
    for (const r of rows) expect(stringWidth(r), JSON.stringify(r)).toBeLessThanOrEqual(38);
  }, 60_000);

  it('P-R5: at minsize the notice is allocated before the composer, so budget 1 explains itself — the REQUEST to S1', () => {
    // today: status → notice → composer, so at budget 1 (rows 3) the user gets a status row and no explanation
    const l = computeLayout(layoutInput({ rows: 3, columns: 20 }));
    expect(l.budget).toBe(1);
    expect(l.total).toBe(1);
    // the string that must survive the reorder — already fits at 20 cells today (§2.5 P-R4)
    expect(cellWidth(minsizeNotice(20, 3))).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------------------
// 2 + 3. the mounted App across the §2.1 ladder
// ---------------------------------------------------------------------------------------

interface Mounted {
  stdout: StubStdout;
  stdin: StubStdin;
  bridge: Bridge;
  bus: ReturnType<typeof createEventBus>;
}

function mountAt(rows: number, columns: number): Mounted {
  const stdout = new StubStdout(rows, columns);
  const stdin = new StubStdin();
  const bus = createEventBus();
  const confirmer = createTuiConfirmer();
  const bridge: Bridge = createBridge(null, null);
  const instance = render(<App task="resize task" resumeId={null} source={bus} confirmer={confirmer} onAbort={() => undefined} mode="one-shot" tickMs={0} bridge={bridge} launch={STILL} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  unmounts.push(() => instance.unmount());
  return { stdout, stdin, bridge, bus };
}

const BOX_START = /^[╭│├╰+|]/;

/** V22 in process: a frame's rule-row width, or `null` when it has none (minsize / static-only / screen reader). */
function ruleWidth(frame: string): number | null {
  let w: number | null = null;
  for (const line of stripSgr(frame).split('\n')) {
    if (/^─{3,}/.test(line) || /^-{3,}/.test(line)) w = stringWidth(line);
  }
  return w;
}

/** V22: every row that starts with a box glyph is exactly `width` cells, and none ends in the truncation ellipsis. */
function v22(frame: string, width: number): { bad: string[]; checked: number } {
  const bad: string[] = [];
  let checked = 0;
  for (const line of stripSgr(frame).split('\n')) {
    if (!BOX_START.test(line)) continue;
    checked += 1;
    if (stringWidth(line) !== width || line.endsWith(GLYPHS.unicode.ellipsis)) bad.push(line);
  }
  return { bad, checked };
}

describe('V22 in process: after a resize no frame is drawn at two widths (§2.2 P-R1/P-R2, D1)', () => {
  it('the §2.1 ladder 24×80 → 12×60 → 8×40 → 5×30 → 40×120 → 24×80 with a 120-char draft: 0 frames flagged by V22', async () => {
    const m = mountAt(24, 80);
    await tick(5);
    m.stdin.write('x'.repeat(120));
    await tick(20);
    const ladder: [number, number][] = [
      [12, 60],
      [8, 40],
      [5, 30],
      [40, 120],
      [24, 80],
    ];
    let ruled = 0;
    for (const [rows, columns] of ladder) {
      const before = m.stdout.frames.length;
      // §2.0: one driver `resize R C` is TWO SIGWINCHes on macOS — (newRows, oldCols) then (newRows, newCols)
      const oldColumns = m.stdout.columns;
      m.stdout.resize(rows, oldColumns);
      m.stdout.resize(rows, columns);
      await tick(80);
      const frames = m.stdout.frames.slice(before);
      expect(frames.length, `${rows}x${columns}`).toBeGreaterThan(0);
      for (const f of frames) {
        const w = ruleWidth(f);
        if (w === null) continue; // minsize / static-only frames have no rule row (V22 exempts them)
        ruled += 1;
        const { bad } = v22(f, w);
        expect(bad, `${rows}x${columns}: ${JSON.stringify(bad.slice(0, 2))}`).toEqual([]);
      }
    }
    // round-4 review finding 4: the sweep must have LOOKED at something. This ladder drops below `BOXED_MIN_ROWS`
    // on its first shrink, so `checked` is legitimately 0 on the narrow rungs — the rung with box rows is the
    // width-only one below, and the count of frames that even had a rule row is pinned here so a future geometry
    // change cannot make the whole describe silently vacuous.
    expect(ruled, 'no frame of the ladder had a rule row to measure against').toBeGreaterThan(0);
  });

  it('round-4 review finding 4: the A2 TEAR geometry — 24 rows, width-only 80→60→100→44→80, where the box rows exist', async () => {
    // the shipped ladder never reaches a boxed frame: 24×80 → 12×60 is already under `BOXED_MIN_ROWS = 16`, so
    // `BOX_START` matched nothing on all three shrink steps (measured: boxRowsChecked = 0, 0, 0) and the D1 tear this
    // describe exists to catch was untested in process. A2 measured the tear at **24 rows, width-only**, with a
    // 120-char draft: 4 of 24 frames carried a box row whose right border was the truncation ellipsis.
    const m = mountAt(24, 80);
    await tick(5);
    m.stdin.write('x'.repeat(120));
    await tick(20);
    let checked = 0;
    let frames = 0;
    for (const columns of [60, 100, 44, 80]) {
      const before = m.stdout.frames.length;
      m.stdout.resize(24, m.stdout.columns); // §2.0: two SIGWINCHes per driver step, rows first
      m.stdout.resize(24, columns);
      await tick(80);
      for (const f of m.stdout.frames.slice(before)) {
        const w = ruleWidth(f);
        if (w === null) continue;
        frames += 1;
        const r = v22(f, w);
        checked += r.checked;
        expect(r.bad, `${columns}: ${JSON.stringify(r.bad.slice(0, 2))}`).toEqual([]);
      }
    }
    expect(frames, 'the tear ladder produced no frame with a rule row').toBeGreaterThan(0);
    expect(checked, 'V22 examined no box row at a BOXED geometry — the assertion would be vacuous').toBeGreaterThan(0);
  });

  it('§2.1 row 17, the storm: 20 resizes in one tick leave a settled frame that is self-consistent at the final width', async () => {
    const m = mountAt(24, 80);
    await tick(5);
    m.stdin.write('hello there, this is a draft that wraps at some widths');
    await tick(20);
    for (let i = 0; i < 20; i++) m.stdout.resize(20 + (i % 9), 40 + i * 7);
    m.stdout.resize(24, 80);
    await tick(120);
    const last = m.stdout.lastFrame();
    const w = ruleWidth(last);
    expect(w).toBe(80);
    expect(v22(last, 80).bad).toEqual([]);
    expect(v22(last, 80).checked).toBeGreaterThan(0);
  });

  it('a grow step and a shrink step both settle to a DYNAMIC region with no row wider than the terminal (V6)', async () => {
    const m = mountAt(24, 80);
    await tick(5);
    m.bus.emit({ type: 'run:start', runId: 'r1', task: 'resize task', mode: 'jev-on', resumedFromStep: null });
    m.bus.emit({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 'resize task', resumed: false });
    m.bus.emit({ type: 'status', status: mkStatus(1, 'risk') });
    await tick(40);
    for (const [rows, columns] of [[24, 44] as const, [40, 120] as const]) {
      m.stdout.resize(rows, m.stdout.columns);
      m.stdout.resize(rows, columns);
      await tick(80);
      // §2.3 edge 7: rows already committed to `<Static>` are NOT re-wrapped (the terminal hard-wraps them), and Ink's
      // debug mode replays `fullStaticOutput` on every frame — so V6 is asserted over the dynamic region, exactly as
      // the pty gate does per geometry segment
      const region = dynamicRegion(stripSgr(m.stdout.lastFrame()), columns);
      expect(region.length, `${rows}x${columns}`).toBeGreaterThan(0);
      for (const line of region) {
        expect(stringWidth(line), `${rows}x${columns}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(columns);
      }
    }
  });
});

describe('the forbidden sequences and the clear budget (§2.1, §11)', () => {
  // Round-4 review finding 3: the first version of this describe could not fail. It mounted with Ink's `debug: true`,
  // whose render path writes `fullStaticOutput + output` straight to stdout and never calls `this.log(…)`, so
  // logUpdate's line counter stays 0 and **no clear is ever emitted** — measured 0 clears at every rung, before and
  // after the fix. It also matched a private `/\x1b\[2J/` instead of the product's `CLEAR_RE`.
  //
  // Three things change. (a) The mount is the PRODUCT's: `createTuiRenderer`, which is where P-R1's `resize` listener
  // and §1.4's `guardStdout` live — a raw `render(<App/>)` has neither, and measured 3 clear events and a 30-cell
  // rule row ending in `…` at the 8×40 → 5×30 rung without them. (b) The counter is `clearStats` /
  // `countClears` from `src/perf/pty.ts`, the same code the pty gate uses — and it counts **events**, because Ink's
  // `clearTerminal` is `ESC[2J ESC[3J ESC[H`, two `CLEAR_RE` matches for one clear. (c) A harness self-test proves a
  // clear IS observable here, so the budget can never go vacuous again.
  function mountRenderer(rows: number, columns: number): { stdout: StubStdout; stdin: StubStdin; renderer: TuiRenderer } {
    const stdout = new StubStdout(rows, columns, true);
    const stdin = new StubStdin();
    const renderer = createTuiRenderer({
      task: 'resize task',
      resumeId: null,
      onAbort: () => undefined,
      mode: 'one-shot',
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      env: { NO_COLOR: '1', JEVCODE_REDUCED_MOTION: '1' },
      interactive: true,
    });
    renderers.push(renderer);
    return { stdout, stdin, renderer };
  }

  it('the harness CAN observe a clear — the self-test the vacuous version was missing', async () => {
    // `CLEAR_RE` matches the four forms and not `ESC[2K` (the product's own self-test, run before any clear gate)
    expect(clearReSelfTest()).toBe(true);
    // and this recorder sees Ink's real `clearTerminal`: a tree one row taller than the viewport takes the
    // `shouldClearTerminalForFrame` branch (`ink.js:89–112`, the cliff A1 measured at 37 clears / 36 frames)
    const probe = new StubStdout(6, 40, true);
    const tall = (n: number): React.JSX.Element => <Box flexDirection="column">{Array.from({ length: n }, (_, i) => <Text key={i}>{`row ${i}`}</Text>)}</Box>;
    const inst = render(tall(20), { stdout: probe as unknown as NodeJS.WriteStream, stdin: new StubStdin() as unknown as NodeJS.ReadStream, patchConsole: false });
    await tick(20);
    inst.rerender(tall(21));
    await tick(40);
    const seen = clearStats(probe.frames.join(''));
    expect(seen.events, 'the harness must be able to see a clear, or the budget below is vacuous').toBeGreaterThanOrEqual(1);
    expect(seen.matches).toBeGreaterThanOrEqual(seen.events);
    inst.unmount();
  });

  it('§2.1 / §11: ≤ 1 clear per driver resize STEP that shrinks, 0 per grow, and zero forbidden sequences', async () => {
    const m = mountRenderer(24, 80);
    await tick(30);
    m.stdin.write('x'.repeat(120)); // the 120-char draft of §2.1 state 4
    await tick(30);
    // §2.0 consequence (d): the budget is per USER resize, counted across the whole two-SIGWINCH transition — keyed
    // per geometry segment it would permit exactly the 2 clears A2 measured and could not detect the defect
    const ladder: Array<[number, number, number]> = [
      [12, 60, 1], // §2.1's falsifiable baseline: 2 clears today, 1 after §2.2
      [8, 40, 1],
      [5, 30, 1],
      [40, 120, 0], // a grow is 0 either way
      [24, 80, 0],
    ];
    const all: string[] = [];
    for (const [rows, columns, max] of ladder) {
      const before = m.stdout.frames.length;
      const oldColumns = m.stdout.columns;
      m.stdout.resize(rows, oldColumns);
      m.stdout.resize(rows, columns);
      await tick(80);
      const step = m.stdout.frames.slice(before).join('');
      all.push(step);
      const st = clearStats(step);
      expect(st.events, `${rows}x${columns}: ${st.events} clear events`).toBeLessThanOrEqual(max);
      expect(st.ris, `${rows}x${columns}`).toBe(0);
      expect(st.altScreen, `${rows}x${columns}`).toBe(0);
    }
    const whole = all.join('');
    // §11's new row: **no `ESC[3J` ever** — `guardStdout` rewrites Ink's 11-character `clearTerminal` in the
    // product path, and this is the assertion that proves the guard is actually on the stream `render()` was given
    expect(whole).not.toContain('\x1b[3J');
    expect(whole).not.toContain('\x1bc');
    expect(whole).not.toContain('\x1b[?1049h');
    expect(whole).not.toContain('\x1b[?1049l');
    expect(countClears(whole)).toBe(clearStats(whole).events); // every clear left is the safe `ESC[2J ESC[H`
  });

  it('§2.2: not one frame of the ladder is drawn at two widths — the rule row never ends in the truncation ellipsis', async () => {
    // the D1 tear, measured directly on the bytes: without `createTuiRenderer`'s P-R1 listener the 8×40 → 5×30 rung
    // writes `─── ◆ jevcode 0.4.0 ─────────…` — the whole tree laid out at 40 and cut to 30 by Ink
    const m = mountRenderer(24, 80);
    await tick(30);
    m.stdin.write('x'.repeat(120));
    await tick(30);
    for (const [rows, columns] of [[12, 60], [8, 40], [5, 30], [40, 120], [24, 80]] as const) {
      const before = m.stdout.frames.length;
      m.stdout.resize(rows, m.stdout.columns);
      m.stdout.resize(rows, columns);
      await tick(80);
      const text = stripSgr(m.stdout.frames.slice(before).join(''));
      const torn = text.split('\n').filter((l) => /^[─-]{3}/.test(l) && l.endsWith(GLYPHS.unicode.ellipsis));
      expect(torn, `${rows}x${columns}: ${JSON.stringify(torn)}`).toEqual([]);
    }
  });
});

describe('the narrow ladder reaches the mounted App (§2.3, D-AB)', () => {
  it('an engine item committed at 10 columns is capped; the same item at 80 is not', async () => {
    const long = `run $ pytest -q ${'tests/test_core.py::test_a_very_long_name '.repeat(10)}`.trim();
    for (const [columns, capped] of [
      [10, true],
      [80, false],
    ] as const) {
      const rows = bodyRows(long, columns, '[step 1]', GLYPHS.unicode, true);
      expect(rows.length, `${columns}`).toBeLessThanOrEqual(STATIC_ITEM_MAX_ROWS);
      expect(isCapRow(rows.at(-1)!), `${columns}: ${rows.at(-1)}`).toBe(capped);
      for (const r of rows) expect(stringWidth(r), `${columns}: ${r}`).toBeLessThanOrEqual(bodyWidth(columns, gutterMode(columns) === 'gutter' ? '[step 1]' : ''));
    }
    // at 34 and up the cap is inert: the rung alone keeps the item under 24 rows
    expect(bodyRows(long, 34, '[step 1]', GLYPHS.unicode, true)).toEqual(bodyRows(long, 34, '[step 1]', GLYPHS.unicode, false));
  });

  it('§2.3 edge 7: a resize does NOT re-wrap items already in `<Static>` — only new items use the new rung', async () => {
    const m = mountAt(24, 80);
    await tick(5);
    m.bus.emit({ type: 'run:start', runId: 'r1', task: 'resize task', mode: 'jev-on', resumedFromStep: null });
    await tick(20);
    const wide = m.stdout.lastFrame();
    m.stdout.resize(24, 30);
    m.stdout.resize(24, 30);
    await tick(80);
    const narrow = stripSgr(m.stdout.lastFrame());
    // the rows the App already committed are byte-identical in the new frame (Ink replays `fullStaticOutput`)
    for (const line of stripSgr(wide).split('\n').filter((l) => l.includes('[run]') && l.trim() !== '')) {
      expect(narrow, line).toContain(line.trimEnd());
    }
  });
});
