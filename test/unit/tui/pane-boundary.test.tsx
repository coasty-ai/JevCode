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
    expect(frame).toContain(`ui: live pane failed to render (RangeError) — run continues; details in ${DEFAULT_LOG_NAME}`);
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
    expect(lastFrame()).toBe('ui: pane pane failed to render (NonError) — run continues; details in /tmp/runs/r1/jevcode.log');
    expect(paneFailedLine('status', 'Error')).toBe('ui: status pane failed to render (Error) — run continues; details in jevcode.log');
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
    expect(frame).toContain('ui: pane pane failed to render (InjectedRenderFault)');
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
    expect(ui.lastFrame()).toContain('pane pane failed to render (Error)');
    shouldThrow = false;
    ui.rerender(
      <PaneBoundary pane="pane" resetKey="run-1">
        <Maybe />
      </PaneBoundary>,
    );
    expect(ui.lastFrame()).toContain('failed to render'); // same key: stays degraded
    ui.rerender(
      <PaneBoundary pane="pane" resetKey="run-2">
        <Maybe />
      </PaneBoundary>,
    );
    expect(ui.lastFrame()).toBe('recovered');
  });
});
