/**
 * TUI-DESIGN-5 §4.3 / §7 row 99 (R5-4's §10 `round5-agents-app.test.tsx`): the `'a'` pane tab through the MOUNTED
 * `<App>` — the tab is invisible until something delegates, `]`/`[` skip it, `Alt+A` focuses it (and is refused
 * with a non-empty draft), Esc unfocuses, and focus is dropped automatically when the last agent ends.
 *
 * This is the shared-React-shell PR's own test (§9.2): the state lives on `UiState`, the routing in `App.tsx` and
 * the rung in `keys/resolve.ts`, and none of them is provable from a pure unit test alone.
 */
import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { ESC, goLive, mountApp, waitFor, type Mounted } from './app-harness.js';
import { F54_ROWS, mkAgentRow } from './agents/fixtures.js';

afterEach(() => cleanup());

const ALT_A = `${ESC}a`;

async function delegating(m: Mounted): Promise<void> {
  m.dispatch({ type: 'agents', rows: F54_ROWS });
  await waitFor(() => (m.state()?.agents.length ?? 0) > 0);
}

describe("the `'a'` tab through <App> (TUI-DESIGN-5 §4.3)", () => {
  it('is absent with no delegation and present once rows arrive (§4.0: invisible in production)', async () => {
    const m = mountApp({ mode: 'session' });
    goLive(m);
    m.stdin.write('/panel full\r');
    await waitFor(() => m.lastFrame().includes('[d]'));
    expect(m.state()?.agents).toEqual([]);
    expect(m.lastFrame()).not.toContain('[a]gents');
    expect(m.lastFrame()).not.toContain('[a] ');

    await delegating(m);
    await waitFor(() => m.lastFrame().includes('[a]'));
    expect(m.lastFrame()).toMatch(/\[a\]gents|\[a\] /);
  });

  it(']/[ skip the tab while nothing delegates, and reach it once something does', async () => {
    const m = mountApp({ mode: 'session' });
    goLive(m);
    // TUI-DESIGN-2 §4.6: the first `]` on a collapsed panel OPENS it; the cycling starts from the second
    m.stdin.write(']');
    await waitFor(() => m.lastFrame().includes('[d]'));
    // d → p → t → s → d, never 'a'
    for (const expected of ['p', 't', 's', 'd']) {
      m.stdin.write(']');
      await waitFor(() => m.state()?.tab === expected);
      expect(m.state()?.tab).toBe(expected);
    }

    await delegating(m);
    for (const expected of ['p', 't', 's', 'a', 'd']) {
      m.stdin.write(']');
      await waitFor(() => m.state()?.tab === expected);
      expect(m.state()?.tab, `] → ${expected}`).toBe(expected);
    }
    // and backwards
    m.stdin.write('[');
    await waitFor(() => m.state()?.tab === 'a');
    expect(m.state()?.tab).toBe('a');
  });

  it('Alt+A focuses the tab; Esc unfocuses it; the focused rule row says so (S86b)', async () => {
    const m = mountApp({ mode: 'session' });
    goLive(m);
    await delegating(m);
    m.stdin.write(ALT_A);
    await waitFor(() => m.state()?.paneFocus === true);
    expect(m.state()?.tab).toBe('a');
    await waitFor(() => m.lastFrame().includes('Esc unfocuses'));
    expect(m.lastFrame()).toContain('Esc unfocuses');

    m.stdin.write(ESC);
    await waitFor(() => m.state()?.paneFocus === false);
    expect(m.state()?.paneFocus).toBe(false);
  });

  it('§7 row 99: Alt+A with a non-empty draft is REFUSED, with S86a, and the draft is untouched', async () => {
    const m = mountApp({ mode: 'session' });
    goLive(m);
    await delegating(m);
    m.stdin.write('half a thought');
    await waitFor(() => m.lastFrame().includes('half a thought'));
    m.stdin.write(ALT_A);
    await waitFor(() => m.lastFrame().includes('finish or clear the line'));
    // the toast row is cut to the console width (the agents strip shares it), so the assertion is on its head
    expect(m.lastFrame()).toContain('finish or clear the line');
    expect(m.state()?.paneFocus).toBe(false);
    expect(m.lastFrame()).toContain('half a thought');
  });

  it('Alt+A with nothing delegating answers honestly (D-AN) and never focuses a tab that is not there', async () => {
    const m = mountApp({ mode: 'session' });
    goLive(m);
    m.stdin.write(ALT_A);
    await waitFor(() => m.lastFrame().includes('not available in this build'));
    expect(m.state()?.paneFocus).toBe(false);
  });

  it('the eight letters resolve while focused and are composer text the moment focus drops', async () => {
    const m = mountApp({ mode: 'session' });
    goLive(m);
    await delegating(m);
    m.stdin.write(ALT_A);
    await waitFor(() => m.state()?.paneFocus === true);
    m.stdin.write('p');
    await waitFor(() => m.lastFrame().includes('agents pause'));
    expect(m.lastFrame()).toContain('agents pause is not avail');
    expect(m.lastFrame()).not.toMatch(/›\s*p\b/);

    m.stdin.write(ESC);
    await waitFor(() => m.state()?.paneFocus === false);
    m.stdin.write('zqz');
    await waitFor(() => m.lastFrame().includes('zqz'));
    expect(m.lastFrame()).toContain('zqz');
  });

  it('focus and the active tab follow the rows: the last agent ending drops both, never a dangling focus', async () => {
    const m = mountApp({ mode: 'session' });
    goLive(m);
    await delegating(m);
    m.stdin.write(ALT_A);
    await waitFor(() => m.state()?.paneFocus === true);
    m.dispatch({ type: 'agents', rows: [] });
    await waitFor(() => m.state()?.paneFocus === false);
    expect(m.state()?.paneFocus).toBe(false);
    expect(m.state()?.tab).toBe('d');
  });

  it('§13.2 clause 6: ↑ / ↓ move the cursor and the VIEWPORT follows — row 29 of a 30-row tree is reachable', async () => {
    /**
     * The tab could never scroll: nothing held a cursor, `tabLines` always called `agentTabRows` with the default
     * `cursor: 0`, and every `{ op: 'move' }` was answered with the `not available` toast — so with 30 agents the
     * marker said `↓18 below` and no key in the build could reach them.
     */
    const m = mountApp({ mode: 'session' });
    goLive(m);
    const rows = Array.from({ length: 30 }, (_, i) => mkAgentRow({ slug: `agent-${i}` }));
    m.dispatch({ type: 'agents', rows });
    m.stdin.write('/panel full\r');
    await waitFor(() => m.lastFrame().includes('[a]'));
    m.stdin.write(ALT_A);
    await waitFor(() => m.state()?.paneFocus === true);
    await waitFor(() => m.lastFrame().includes('agent-0'));
    expect(m.lastFrame()).not.toContain('agent-29');
    expect(m.state()?.agentCursor).toBe(0);

    // ↓ moves the cursor, and it is NOT a `not available` toast
    m.stdin.write('\x1b[B');
    await waitFor(() => m.state()?.agentCursor === 1);
    expect(m.lastFrame()).not.toContain('agents move is not available');

    // hold ↓ past the viewport and the window follows the cursor to the last row
    for (let i = 0; i < 40; i++) m.stdin.write('\x1b[B');
    await waitFor(() => m.state()?.agentCursor === 29);
    expect(m.state()?.agentCursor).toBe(29);
    await waitFor(() => m.lastFrame().includes('agent-29'));
    expect(m.lastFrame()).toContain('agent-29');

    // ↑ comes back, and the cursor never leaves the range
    for (let i = 0; i < 40; i++) m.stdin.write('\x1b[A');
    await waitFor(() => m.state()?.agentCursor === 0);
    expect(m.state()?.agentCursor).toBe(0);
  });

  it('a supervisor VERB still answers honestly, and the refusal never leaks an internal op name (D-AN)', async () => {
    const m = mountApp({ mode: 'session' });
    goLive(m);
    await delegating(m);
    m.stdin.write(ALT_A);
    await waitFor(() => m.state()?.paneFocus === true);
    m.stdin.write('x');
    await waitFor(() => m.lastFrame().includes('is not available in this build'));
    // `dropArm` is the chord's internal op; the user pressed `x`, and the word is `drop`.
    // (the toast row shares the status line, so it is cut — the assertion is on its head)
    expect(m.lastFrame()).toContain('agents drop is not availa');
    expect(m.lastFrame()).not.toContain('dropArm');
  });

  it('the tab renders the rows it was given, with the keys row only while focused (§4.3)', async () => {
    const m = mountApp({ mode: 'session' });
    goLive(m);
    m.dispatch({ type: 'agents', rows: [mkAgentRow({ slug: 'tui-rows' })] });
    m.stdin.write('/panel full\r');
    await waitFor(() => m.lastFrame().includes('[a]'));
    m.stdin.write(ALT_A);
    await waitFor(() => m.state()?.paneFocus === true);
    await waitFor(() => m.lastFrame().includes('tui-rows'));
    expect(m.lastFrame()).toContain('tui-rows');
    expect(m.lastFrame()).toContain('Enter');
  });
});

describe('the collapsed strip in the status line (§4.4 / §4.11 F-55)', () => {
  it('the segment is OMITTED with no agents and appears beside `run` once rows arrive (§13.2 clause 5)', async () => {
    const m = mountApp({ mode: 'session' });
    goLive(m);
    await waitFor(() => m.lastFrame().includes('run $'));
    expect(m.lastFrame()).not.toContain('agents ');

    await delegating(m);
    await waitFor(() => m.lastFrame().includes('agents 5'));
    const row = m.lastFrame().split('\n').find((l) => l.includes('agents 5')) ?? '';
    // §2.2's one order: step · run · agents · …
    expect(row.indexOf('run $')).toBeLessThan(row.indexOf('agents 5'));
    expect(row).toContain('$0.44/1.50');
  });
});
