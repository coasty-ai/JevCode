/**
 * TUI-DESIGN-4 §2.2 (P-R1) / §10 S2 (`renderer-resize.test.tsx`) — **the mechanism**, not the property.
 *
 * `round4-resize-app.test.tsx` pins what a user sees (no frame is two widths, ≤ 1 clear per driver resize step);
 * this file pins the machine underneath it, which is the half §10 S2 names explicitly and nothing tested before:
 * `createTuiRenderer` registers its own `resize` listener **before** Ink's (`App.tsx`, `stdout.on('resize',
 * onEarlyResize)` runs above `render()`), stores the new geometry on the bridge, and — when a dimension shrank or
 * the width changed at all — commits the tree **synchronously** with `instance.rerender()`
 * (`updateContainerSync` + `flushSyncWork`) before Ink's own `resized()` repaints. `SYNC_COMMIT_MIN_MS = 8` is the
 * storm guard, because §2.0's two-ioctl `stty` makes 20 driver resizes ≈ 40 events.
 *
 * The observable is exact: a synchronous commit writes bytes to the stream **before the `emit('resize')` call
 * returns**, so a test that does not `await` between the SIGWINCH and the measurement sees the commit and nothing
 * else. `StubStdout` is the fake stdout §10 S2 asks for (settable `rows`/`columns`, `resize()` emits the signal).
 *
 * **One deviation from §10 S2's wording, taken from §2.2's normative patch.** §10 says "**none** for ↑rows/↑cols";
 * §2.2's code is `if ((shrank || widthChanged) && …)`, and ↑rows/↑cols *is* a width change, so it commits — which is
 * the point of P-R2 (a grow that widens the box must widen the draft in the same frame, or the box edge is one width
 * and the body another). The transition that commits nothing is ↑rows with the columns **unchanged**, and that is
 * what the table below pins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SYNC_COMMIT_MIN_MS, createTuiRenderer, type TuiRenderer } from '../../../src/tui/App.js';
import { StubStdin, StubStdout } from './stub-stdout.js';
import { tick } from '../../fixtures/tui/fixtures.js';

// every `createTuiRenderer` mount adds Ink's own `beforeExit` hook; this file mounts a dozen of them in one process
process.setMaxListeners(64);

const mounted: TuiRenderer[] = [];
afterEach(async () => {
  for (const r of mounted.splice(0)) await r.unmount();
});

/** everything a terminal writes that is not text: SGR, cursor moves, erases, the synchronised-update pair. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][A-B0-2]/g, '');

interface Mounted {
  stdout: StubStdout;
  stdin: StubStdin;
  renderer: TuiRenderer;
}

function mount(rows: number, columns: number): Mounted {
  const stdout = new StubStdout(rows, columns, true);
  const stdin = new StubStdin();
  const renderer = createTuiRenderer({
    task: 'resize mechanism',
    resumeId: null,
    onAbort: () => undefined,
    mode: 'one-shot',
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    // offline and still: no animation clock decides whether a frame is written
    env: { NO_COLOR: '1', JEVCODE_REDUCED_MOTION: '1' },
    interactive: true,
  });
  mounted.push(renderer);
  return { stdout, stdin, renderer };
}

/** the bytes written **synchronously** by one SIGWINCH — the commit P-R1 performs inside the listener. */
function sigwinch(m: Mounted, rows: number, columns: number): string {
  const before = m.stdout.frames.length;
  m.stdout.resize(rows, columns); // no await: everything below happened inside the emit
  return m.stdout.frames.slice(before).join('');
}

describe('P-R1: the renderer commits the geometry synchronously (TUI-DESIGN-4 §2.2, §10 S2)', () => {
  it('the storm guard is the documented 8 ms and is exported for the perf harness', () => {
    expect(SYNC_COMMIT_MIN_MS).toBe(8);
  });

  it('the listener is registered BEFORE Ink’s, so the commit wins the race against `resized()`', async () => {
    const m = mount(24, 80);
    await tick(30);
    const listeners = m.stdout.listeners('resize');
    // two: `onEarlyResize` (registered above `render()` in `createTuiRenderer`) and Ink’s own `resized`
    expect(listeners.length).toBeGreaterThanOrEqual(2);
    // Node calls them in registration order, and P-R1 must be first: Ink’s `resized()` renders the tree from the
    // App’s CURRENT props, so a commit that lands after it paints one frame at the old geometry (D1’s torn frame)
    expect(listeners[0]?.name).toBe('onEarlyResize');
  });

  it('§2.2: a shrinking dimension or ANY width change commits synchronously; ↑rows at the same width commits nothing', async () => {
    const table: Array<[string, number, number, boolean]> = [
      ['↓rows, same cols', 12, 80, true],
      ['↓cols, same rows', 24, 44, true],
      ['↓rows and ↓cols', 12, 44, true],
      ['↑rows, ↓cols', 40, 60, true],
      ['↑rows, ↑cols (a width change — §2.2, not §10’s wording)', 40, 120, true],
      ['↑rows, SAME cols — the one transition with nothing to re-lay-out', 40, 80, false],
      ['no change at all', 24, 80, false],
    ];
    for (const [name, rows, columns, commits] of table) {
      const m = mount(24, 80);
      await tick(30);
      m.stdin.write('x'.repeat(120)); // a draft that wraps differently at every width
      await tick(30);
      const sync = sigwinch(m, rows, columns);
      expect(sync.length > 0, `${name}: ${sync.length} bytes`).toBe(commits);
      await tick(60);
    }
  });

  it('the synchronous frame carries the NEW width — never the old one (D1: a frame is never two widths)', async () => {
    for (const columns of [44, 60, 70]) {
      const m = mount(24, 80);
      await tick(30);
      m.stdin.write('x'.repeat(120));
      await tick(30);
      const sync = stripAnsi(sigwinch(m, 24, columns));
      const rows = sync.split('\n').filter((l) => l.trim() !== '');
      expect(rows.length, `${columns}`).toBeGreaterThan(0);
      for (const r of rows) expect([...r].length, `${columns}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(columns);
      // …and it is a real frame at that width, not a stray cursor move: the rule row is exactly `columns`
      expect(rows.some((r) => /^[─-]{3}/.test(r) && [...r].length === columns), `${columns}: ${JSON.stringify(rows.slice(0, 3))}`).toBe(true);
      await tick(60);
    }
  });

  it('§2.0 + the 8 ms guard: 20 SIGWINCHes in one tick cost far less than 20 commits, and the tail still settles', async () => {
    const one = mount(24, 80);
    await tick(30);
    one.stdin.write('x'.repeat(120));
    await tick(30);
    const single = sigwinch(one, 24, 79).length;
    expect(single).toBeGreaterThan(0);
    await tick(60);

    const m = mount(24, 80);
    await tick(30);
    m.stdin.write('x'.repeat(120));
    await tick(30);
    const before = m.stdout.frames.length;
    // §2.1 row 17: the storm. Every one of these lands inside the same 8 ms window, so the guard must swallow
    // almost all of the synchronous commits — the debounce catches the tail either way.
    let bytes = 0;
    for (let i = 0; i < 20; i++) bytes += sigwinch(m, 24, 79 - i).length;
    expect(bytes).toBeLessThan(single * 20);
    expect(m.stdout.frames.length).toBeGreaterThan(before);
    await tick(150);
    // the settled frame is at the final width and nothing is wider than it
    const settled = stripAnsi(m.stdout.frames.slice(-4).join('')).split('\n').filter((l) => l.trim() !== '');
    for (const r of settled) expect([...r].length, JSON.stringify(r)).toBeLessThanOrEqual(60);
  });
});
