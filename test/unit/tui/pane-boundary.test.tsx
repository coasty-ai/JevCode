/**
 * TUI-DESIGN §13.4 / §19.0 / §19.3: one pane degrades to the one-row notice while its siblings render; a failed
 * Overlay reports through onFail (the App declines the review there); a failed Composer renders its fallback; a
 * failed StatusLine renders `statusLineText()`; `componentStack` is a real string under React 19;
 * `JEVCODE_FAULT=render:<pane>` throws once per fault store; Ink's InternalErrorBoundary never fires.
 */
import { Box, Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOG_NAME, PaneBoundary, RENDER_FAULTS_FIRED, paneFailedLine, renderFaultFor, resetRenderFaults, type PaneFailure } from '../../../src/tui/PaneBoundary.js';
import { statusLineText, type StatusLineState } from '../../../src/tui/status/lines.js';

afterEach(() => {
  cleanup();
  resetRenderFaults();
});

function Boom({ name = 'RangeError' }: { name?: string }): never {
  const err = new Error('pane exploded');
  err.name = name;
  throw err;
}

function ThrowValue(): never {
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw 'not an error';
}

/** The idle status state O5's `statusLineText` reads (§7.4); every required member of `StatusLineState`. */
function idleStatus(): StatusLineState {
  return {
    run: 'none',
    mode: null,
    status: null,
    ready: null,
    done: null,
    runId: null,
    overlay: 'none',
    pendingReview: null,
    retrying: null,
    blocking: null,
    errors: 0,
    stageStartedAt: null,
    toasts: [],
    git: null,
    spend: { run: null, session: null },
    draft: { secretHits: 0 },
    nowMs: 0,
  };
}

describe('<PaneBoundary> (§13.4)', () => {
  it('degrades only the failing pane to the one-row notice; siblings keep rendering', () => {
    const { lastFrame } = render(
      <Box flexDirection="column">
        <PaneBoundary pane="live">
          <Boom />
        </PaneBoundary>
        <PaneBoundary pane="status">
          <Text>status line ok</Text>
        </PaneBoundary>
      </Box>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(`ui: live failed (RangeError) — run continues; see ${DEFAULT_LOG_NAME}`);
    expect(frame).toContain('status line ok');
    // never Ink's 42-row overview
    expect(frame).not.toContain('ERROR');
    expect(frame.split('\n').length).toBeLessThanOrEqual(3);
  });

  it('reports { pane, error, componentStack } through onFail exactly once; a failed Overlay lets the App decline the review', () => {
    const failures: PaneFailure[] = [];
    const resolveDetailed = vi.fn();
    render(
      <PaneBoundary
        pane="overlay"
        onFail={(f) => {
          failures.push(f);
          resolveDetailed('c1', { approved: false });
        }}
      >
        <Boom name="TypeError" />
      </PaneBoundary>,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.pane).toBe('overlay');
    expect(failures[0]?.error.name).toBe('TypeError');
    expect(failures[0]?.error.message).toBe('pane exploded');
    // React 19 hands the boundary a real component stack naming the thrower
    expect(typeof failures[0]?.componentStack).toBe('string');
    expect(failures[0]?.componentStack?.length).toBeGreaterThan(0);
    expect(failures[0]?.componentStack).toContain('Boom');
    expect(resolveDetailed).toHaveBeenCalledWith('c1', { approved: false });
  });

  it('a failed Composer renders its fallback (a single-row plain input) instead of the notice', () => {
    const { lastFrame } = render(
      <PaneBoundary pane="composer" fallback={(f) => <Text>{`> plain input (${f.error.name})`}</Text>}>
        <Boom />
      </PaneBoundary>,
    );
    expect(lastFrame()).toBe('> plain input (RangeError)');
    expect(lastFrame()).not.toContain('failed to render');
  });

  it('a failed StatusLine renders `statusLineText()` in a bare <Text> through the same fallback prop', () => {
    const expected = statusLineText(idleStatus(), 80);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected).toContain('idle');
    const { lastFrame } = render(
      <PaneBoundary pane="status" fallback={() => <Text>{expected}</Text>}>
        <Boom name="StatusBug" />
      </PaneBoundary>,
    );
    expect(lastFrame()).toBe(expected);
    expect(lastFrame()).not.toContain('failed to render');
  });

  it('names the log in the notice and copes with a thrown non-Error', () => {
    const { lastFrame } = render(
      <PaneBoundary pane="pane" log="/tmp/runs/r1/jevcode.log">
        <ThrowValue />
      </PaneBoundary>,
    );
    expect(lastFrame()).toBe('ui: pane failed (NonError) — run continues; see /tmp/runs/r1/jevcode.log');
    expect(paneFailedLine('status', 'Error')).toBe('ui: status failed (Error) — run continues; see jevcode.log');
  });

  it('renders children untouched when nothing fails (null children too)', () => {
    const ok = render(
      <PaneBoundary pane="static">
        <Text>all good</Text>
      </PaneBoundary>,
    );
    expect(ok.lastFrame()).toBe('all good');
    const empty = render(<PaneBoundary pane="static" />);
    expect(empty.lastFrame()).toBe('');
  });

  it('JEVCODE_FAULT=render:<pane> throws once inside the boundary; other panes and a second mount are unaffected', () => {
    const onFail = vi.fn();
    const first = render(
      <Box flexDirection="column">
        <PaneBoundary pane="pane" fault={renderFaultFor('pane')} onFail={onFail}>
          <Text>pane body</Text>
        </PaneBoundary>
        <PaneBoundary pane="status" fault={renderFaultFor('pane')}>
          <Text>status body</Text>
        </PaneBoundary>
      </Box>,
    );
    const frame = first.lastFrame() ?? '';
    expect(frame).toContain('ui: pane failed (InjectedRenderFault)');
    expect(frame).toContain('status body');
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(RENDER_FAULTS_FIRED.has('render:pane')).toBe(true);
    first.unmount();
    // once: the same fault value no longer throws
    const second = render(
      <PaneBoundary pane="pane" fault={renderFaultFor('pane')}>
        <Text>pane body again</Text>
      </PaneBoundary>,
    );
    expect(second.lastFrame()).toBe('pane body again');
    expect(renderFaultFor('composer')).toBe('render:composer');
  });

  it('the fault store is scoped by the `faults` prop: separate stores each fire once, a shared store fires once for both', () => {
    const a = new Set<string>();
    const b = new Set<string>();
    const ui = render(
      <Box flexDirection="column">
        <PaneBoundary pane="pane" fault={renderFaultFor('pane')} faults={a}>
          <Text>A</Text>
        </PaneBoundary>
        <PaneBoundary pane="pane" fault={renderFaultFor('pane')} faults={b}>
          <Text>B</Text>
        </PaneBoundary>
      </Box>,
    );
    const frame = ui.lastFrame() ?? '';
    expect(frame.split('\n').filter((l) => l.includes('InjectedRenderFault'))).toHaveLength(2);
    expect([...a]).toEqual(['render:pane']);
    expect([...b]).toEqual(['render:pane']);
    // the module singleton was never touched
    expect(RENDER_FAULTS_FIRED.size).toBe(0);
    ui.unmount();
    // a store that already holds the fault renders the children at once
    const again = render(
      <PaneBoundary pane="pane" fault={renderFaultFor('pane')} faults={a}>
        <Text>A again</Text>
      </PaneBoundary>,
    );
    expect(again.lastFrame()).toBe('A again');
    // resetRenderFaults clears a given store too
    resetRenderFaults(a);
    expect(a.size).toBe(0);
  });

  it('resetKey lets the pane try again (the next run remounts it)', () => {
    let shouldThrow = true;
    function Maybe(): React.JSX.Element {
      if (shouldThrow) throw new Error('first render fails');
      return <Text>recovered</Text>;
    }
    const ui = render(
      <PaneBoundary pane="pane" resetKey="run-1">
        <Maybe />
      </PaneBoundary>,
    );
    expect(ui.lastFrame()).toContain('ui: pane failed (Error)');
    shouldThrow = false;
    ui.rerender(
      <PaneBoundary pane="pane" resetKey="run-1">
        <Maybe />
      </PaneBoundary>,
    );
    expect(ui.lastFrame()).toContain('ui: pane failed ('); // same key: stays degraded
    ui.rerender(
      <PaneBoundary pane="pane" resetKey="run-2">
        <Maybe />
      </PaneBoundary>,
    );
    expect(ui.lastFrame()).toBe('recovered');
  });
});

/**
 * TUI-DESIGN-4 §7.12 (P-D11) / §10 (S6 `pane-boundary.test.tsx`): the §7.12 widths and the no-log case, and a
 * thrown object with a 10 000-character `name`.
 *
 * Measured before round 4: `paneFailedLine` was 76 characters and wrapped to 2–3 rows below 64 columns — the very
 * frame where rows are scarcest — and with no log open it said `details in jevcode.log`, a file that was never
 * created (`App.tsx` used `log.file || 'jevcode.log'`).
 */
describe('paneFailedLine width and log (§7.12)', () => {
  it('the three rooms of the table', async () => {
    const { PANE_NOTICE_WIDE_MIN, paneFailedDetail, paneRecoveredLine } = await import('../../../src/tui/PaneBoundary.js');
    // >= 64: the whole sentence
    expect(paneFailedLine('status', 'TypeError', 'jevcode.log', 80)).toBe('ui: status failed (TypeError) — run continues; see jevcode.log');
    expect(paneFailedLine('status', 'TypeError', 'jevcode.log', PANE_NOTICE_WIDE_MIN)).toContain('see jevcode.log');
    // < 64: the headline only, the log in the detail
    expect(paneFailedLine('status', 'TypeError', 'jevcode.log', PANE_NOTICE_WIDE_MIN - 1)).toBe('ui: status failed (TypeError)');
    expect(paneFailedLine('status', 'TypeError', 'jevcode.log', 40)).toBe('ui: status failed (TypeError)');
    // no log open: the headline drops the clause at every width, and the detail says how to open one
    expect(paneFailedLine('status', 'TypeError', null, 120)).toBe('ui: status failed (TypeError)');
    expect(paneFailedDetail(null)).toBe('the run log (start with --log <file>)');
    expect(paneFailedDetail('/runs/r1/jevcode.log')).toBe('/runs/r1/jevcode.log');
    // §7.1: the unlatch row
    expect(paneRecoveredLine('transcript')).toBe('ui: transcript pane recovered');
  });

  it('the notice fits its width for every pane at 40 and 64 columns', () => {
    for (const pane of ['live', 'pane', 'overlay', 'composer', 'status', 'static', 'transcript', 'wordmark', 'rule', 'banner', 'queue']) {
      expect(paneFailedLine(pane, 'TypeError', 'jevcode.log', 40).length, pane).toBeLessThanOrEqual(40);
    }
  });

  it('edge 1: an attacker-influenced Error.name is made terminal-safe and clipped to 32', async () => {
    const { PANE_ERROR_NAME_MAX } = await import('../../../src/tui/PaneBoundary.js');
    const long = paneFailedLine('pane', 'N'.repeat(10_000), 'jevcode.log', 200);
    expect(long.length).toBeLessThan(120);
    expect(long).toContain(`(${'N'.repeat(PANE_ERROR_NAME_MAX - 1)}…)`);
    // controls, newlines and bidi overrides never reach the row
    expect(paneFailedLine('pane', 'Ev\u0007il\nName‮', null, 200)).toBe('ui: pane failed (Evil Name)');
    // an empty name still reads
    expect(paneFailedLine('pane', '   ', null, 200)).toBe('ui: pane failed (Error)');
  });

  it('the boundary renders the narrow form when it is given the frame width', () => {
    const wide = render(
      <PaneBoundary pane="pane" columns={80} log="jevcode.log">
        <Boom name="TypeError" />
      </PaneBoundary>,
    );
    expect(wide.lastFrame()).toBe('ui: pane failed (TypeError) — run continues; see jevcode.log');
    cleanup();
    const narrow = render(
      <PaneBoundary pane="pane" columns={44} log="jevcode.log">
        <Boom name="TypeError" />
      </PaneBoundary>,
    );
    expect(narrow.lastFrame()).toBe('ui: pane failed (TypeError)');
  });
});

/** TUI-DESIGN-4 §7.11 scenario 1: `render:<pane>:sticky` throws on **every** render, which is what §7.1's latch must survive. */
describe('the sticky render fault (§7.11 scenario 1)', () => {
  it('a sticky fault re-throws after a resetKey change; a once fault does not', async () => {
    const { stickyRenderFaultFor } = await import('../../../src/tui/PaneBoundary.js');
    const store = new Set<string>();
    const ui = render(
      <PaneBoundary pane="pane" faults={store} fault={stickyRenderFaultFor('pane')} resetKey="run-1">
        <Text>body</Text>
      </PaneBoundary>,
    );
    expect(ui.lastFrame()).toContain('ui: pane failed (InjectedRenderFault)');
    // a sticky fault is never recorded as fired
    expect(store.size).toBe(0);
    ui.rerender(
      <PaneBoundary pane="pane" faults={store} fault={stickyRenderFaultFor('pane')} resetKey="run-2">
        <Text>body</Text>
      </PaneBoundary>,
    );
    expect(ui.lastFrame()).toContain('ui: pane failed (InjectedRenderFault)');
    cleanup();
    // the once form still clears on the next resetKey
    const store2 = new Set<string>();
    const once = render(
      <PaneBoundary pane="pane" faults={store2} fault={renderFaultFor('pane')} resetKey="run-1">
        <Text>body</Text>
      </PaneBoundary>,
    );
    expect(once.lastFrame()).toContain('ui: pane failed (InjectedRenderFault)');
    expect(store2.has('render:pane')).toBe(true);
    once.rerender(
      <PaneBoundary pane="pane" faults={store2} fault={renderFaultFor('pane')} resetKey="run-2">
        <Text>body</Text>
      </PaneBoundary>,
    );
    expect(once.lastFrame()).toBe('body');
  });
});

/**
 * TUI-DESIGN-4 §7.11 (review finding 17): the boundary matches the fault through the TYPED parser, not by string
 * comparison. The consequence the string compare had: `render:transcript:lines:sticky` — the exact value
 * `test/pty/smoke/fault-persistent.steps` injects — matched nothing anywhere, so the scenario had no consumer.
 */
describe('the boundary reads the typed fault, not a string (§7.11)', () => {
  it('the `:lines` variants belong to the App guard, never to the boundary; `:sticky` alone does not', async () => {
    const { linesFaultFor, stickyRenderFaultFor } = await import('../../../src/tui/PaneBoundary.js');
    const { parseFault, renderFaultMode } = await import('../../../src/tui/faults.js');
    // the value the pty scenario injects parses, names the transcript, and selects the LINE builder, sticky
    expect(parseFault('render:transcript:lines:sticky')).toEqual({ kind: 'render', pane: 'transcript', lines: true, sticky: true });
    expect(renderFaultMode(parseFault('render:transcript:lines:sticky'), 'transcript')).toBeNull();
    expect(renderFaultMode(parseFault('render:transcript:lines:sticky'), 'transcript', { lines: true })).toBe('sticky');
    expect(linesFaultFor('transcript', { sticky: true })).toBe('render:transcript:lines:sticky');

    // the boundary itself does NOT throw on a `:lines` fault — the line builder above it does
    const store = new Set<string>();
    const ui = render(
      <PaneBoundary pane="transcript" faults={store} fault={linesFaultFor('transcript', { sticky: true })}>
        <Text>body</Text>
      </PaneBoundary>,
    );
    expect(ui.lastFrame()).toBe('body');
    cleanup();

    // and a value that is not a fault at all is inert rather than a coincidence
    const junk = render(
      <PaneBoundary pane="transcript" faults={store} fault="render:transcriptx">
        <Text>body</Text>
      </PaneBoundary>,
    );
    expect(junk.lastFrame()).toBe('body');
    cleanup();

    // the sticky form still fires on the boundary it names
    const hit = render(
      <PaneBoundary pane="transcript" faults={store} fault={stickyRenderFaultFor('transcript')}>
        <Text>body</Text>
      </PaneBoundary>,
    );
    expect(hit.lastFrame()).toContain('ui: transcript failed (InjectedRenderFault)');
  });
});
