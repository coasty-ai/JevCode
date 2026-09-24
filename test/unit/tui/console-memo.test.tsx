/**
 * The Console's memoised builders (render cost outside the App). The App re-renders the Console on every delta, spinner
 * and indicator tick with fresh objects — `statusView(...)`, `statusOpts`, `hitSpans(...)`, a rebuilt `git` zone — so
 * `statusSpans`, `composerView` and `consoleTopEdgeParts` are memoised on the values inside them. Pinned here:
 *   - an unchanged re-render (fresh objects, same values) recomputes none of the three, and the cursor is still reset by
 *     the host and placed again by the Console on that render (the Console is deliberately not `React.memo`);
 *   - each input invalidates exactly the builders that read it;
 *   - `statusMemoDeps` moves when any `StatusLineState` member or option moves (the base below is typed
 *     `Required<StatusLineState>`, so a new member fails typecheck here as it does in Console.tsx), and does not move
 *     when only the identity of the App's per-render `git` / `draft` objects changes;
 *   - end to end, through the real Ink renderer on a stub TTY, every frame of a streamed reply still ends with ESC[?25h.
 */
import type { CursorPosition } from 'ink';
import { render as inkRender } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHead, LaunchSettings } from '../../../src/core/types.js';
import { App, createBridge } from '../../../src/tui/App.js';
import { Console, statusMemoDeps, type ConsoleProps } from '../../../src/tui/Console.js';
import { createBuffer, reduceBuffer } from '../../../src/tui/composer/buffer.js';
import type { GitZone, StatusLineOptions, StatusLineState } from '../../../src/tui/status/lines.js';
import type { Toast } from '../../../src/tui/toasts.js';
import { createEventBus, createTuiConfirmer } from '../../../src/tui/useEngine.js';
import { cursorStats, splitFrames } from '../../../src/perf/pty.js';
import { StubStdin, StubStdout } from './stub-stdout.js';

const calls = vi.hoisted(() => ({ statusSpans: 0, composerView: 0, topEdge: 0 }));

vi.mock('../../../src/tui/status/lines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/tui/status/lines.js')>();
  return {
    ...actual,
    statusSpans: (...args: Parameters<typeof actual.statusSpans>) => {
      calls.statusSpans += 1;
      return actual.statusSpans(...args);
    },
  };
});
vi.mock('../../../src/tui/composer/Composer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/tui/composer/Composer.js')>();
  return {
    ...actual,
    composerView: (...args: Parameters<typeof actual.composerView>) => {
      calls.composerView += 1;
      return actual.composerView(...args);
    },
  };
});
vi.mock('../../../src/tui/console-lines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/tui/console-lines.js')>();
  return {
    ...actual,
    consoleTopEdgeParts: (...args: Parameters<typeof actual.consoleTopEdgeParts>) => {
      calls.topEdge += 1;
      return actual.consoleTopEdgeParts(...args);
    },
  };
});

afterEach(() => {
  cleanup();
  calls.statusSpans = 0;
  calls.composerView = 0;
  calls.topEdge = 0;
});

// values the reducer keeps by identity across renders
const HEAD: GitHead = { kind: 'branch', name: 'main', oid: 'abc1234' };
const DIRTY = { modified: 2, staged: 1, untracked: 0 };
const TOASTS: readonly Toast[] = [];
const SPEND: StatusLineState['spend'] = { run: null, session: { totalUsd: 0.25, capUsd: 5 } };
const ZONE: GitZone = { head: HEAD, ahead: 1, behind: 0, dirty: DIRTY, linkedWorktree: false, frozen: false };

/** A status the way the App builds it: a fresh object with a fresh `git` zone and `draft` every render, same values. */
function freshStatus(over: Partial<StatusLineState> = {}): StatusLineState {
  return { run: 'none', mode: null, status: null, ready: null, done: null, runId: null, overlay: 'none', pendingReview: null, retrying: null, blocking: null, errors: 0, stageStartedAt: null, toasts: TOASTS, git: { head: HEAD, ahead: 1, behind: 0, dirty: DIRTY, linkedWorktree: false, frozen: false }, spend: SPEND, draft: { secretHits: 0 }, nowMs: 5_000, thinking: 'replying', ...over };
}
const freshOptions = (over: StatusLineOptions = {}): StatusLineOptions => ({ ascii: false, reducedMotion: false, spinnerFrame: 3, mode: 'session', flatBadge: false, terminalColumns: 80, ...over });

const buffer = reduceBuffer(createBuffer(), { type: 'insert', text: 'fix the 日本語 test' });

function Host(p: ConsoleProps): React.JSX.Element {
  // the App's protocol: the cursor is reset before the children render, and the Console places it again
  p.cursor(undefined);
  return <Console {...p} />;
}

function harness(): { positions: (CursorPosition | undefined)[]; props: (over?: Partial<ConsoleProps>) => ConsoleProps } {
  const positions: (CursorPosition | undefined)[] = [];
  const cursor = (pos: CursorPosition | undefined): void => {
    positions.push(pos);
  };
  const props = (over: Partial<ConsoleProps> = {}): ConsoleProps => ({ buffer, columns: 80, height: 1, top: 1, scrollTop: 0, cursor, active: true, mode: 'task', rows: 24, badge: 'jev-only', dir: 'proj', status: freshStatus(), statusOptions: freshOptions(), spans: [], ...over });
  return { positions, props };
}

describe('<Console> memoises its pure builders on values, and still places the cursor every render', () => {
  it('an unchanged re-render (fresh objects, same values) recomputes nothing and re-places the cursor', () => {
    const h = harness();
    const ui = render(<Host {...h.props()} />);
    expect(calls).toEqual({ statusSpans: 1, composerView: 1, topEdge: 1 });
    const placed = h.positions.at(-1);
    expect(placed).toEqual({ x: 2 + 2 + 'fix the 日本語 test'.length + 3, y: 2 });
    const frame = ui.lastFrame();
    for (let i = 0; i < 5; i++) {
      h.positions.length = 0;
      ui.rerender(<Host {...h.props({ spans: [] })} />);
      expect(calls).toEqual({ statusSpans: 1, composerView: 1, topEdge: 1 });
      // reset by the host, then placed by the Console — on this render, at the same cell
      expect(h.positions).toEqual([undefined, placed]);
      expect(ui.lastFrame()).toBe(frame);
    }
  });

  it('each input invalidates exactly the builders that read it', () => {
    const h = harness();
    const ui = render(<Host {...h.props()} />);
    expect(calls).toEqual({ statusSpans: 1, composerView: 1, topEdge: 1 });
    ui.rerender(<Host {...h.props({ statusOptions: freshOptions({ spinnerFrame: 4 }) })} />);
    expect(calls).toEqual({ statusSpans: 2, composerView: 1, topEdge: 1 });
    ui.rerender(<Host {...h.props({ statusOptions: freshOptions({ spinnerFrame: 4 }), status: freshStatus({ nowMs: 6_000 }) })} />);
    expect(calls).toEqual({ statusSpans: 3, composerView: 1, topEdge: 1 });
    const typed = reduceBuffer(buffer, { type: 'insert', text: '!' });
    ui.rerender(<Host {...h.props({ buffer: typed, statusOptions: freshOptions({ spinnerFrame: 4 }), status: freshStatus({ nowMs: 6_000 }) })} />);
    expect(calls).toEqual({ statusSpans: 3, composerView: 2, topEdge: 1 });
    expect(h.positions.at(-1)).toEqual({ x: 2 + 2 + 'fix the 日本語 test!'.length + 3, y: 2 });
    ui.rerender(<Host {...h.props({ buffer: typed, statusOptions: freshOptions({ spinnerFrame: 4 }), status: freshStatus({ nowMs: 6_000 }), spans: [{ start: 0, end: 3 }] })} />);
    expect(calls).toEqual({ statusSpans: 3, composerView: 3, topEdge: 1 });
    ui.rerender(<Host {...h.props({ buffer: typed, statusOptions: freshOptions({ spinnerFrame: 4 }), status: freshStatus({ nowMs: 6_000 }), spans: [{ start: 0, end: 3 }], title: 'sessions · filter' })} />);
    expect(calls).toEqual({ statusSpans: 3, composerView: 3, topEdge: 2 });
    ui.rerender(<Host {...h.props({ buffer: typed, statusOptions: freshOptions({ spinnerFrame: 4 }), status: freshStatus({ nowMs: 6_000 }), spans: [{ start: 0, end: 3 }], title: 'sessions · filter', columns: 100 })} />);
    expect(calls).toEqual({ statusSpans: 4, composerView: 4, topEdge: 3 });
  });

  it('an inactive console hides the cursor on every render, memo or not', () => {
    const h = harness();
    const ui = render(<Host {...h.props({ active: false })} />);
    ui.rerender(<Host {...h.props({ active: false })} />);
    expect(calls.statusSpans).toBe(1);
    expect(h.positions.every((p) => p === undefined)).toBe(true);
  });
});

describe('statusMemoDeps: every value the status row reads, flattened', () => {
  // `Required<>` lists every member: a member added to StatusLineState is a type error here until it is covered
  const base: Required<StatusLineState> = {
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
    toasts: TOASTS,
    git: ZONE,
    spend: SPEND,
    draft: { secretHits: 0 },
    nowMs: 5_000,
    title: null,
    sandbox: null,
    noNetwork: false,
    diskErrors: 0,
    jevLatencies: [],
    picker: false,
    wallMs: null,
    doneExitCode: null,
    modeBadge: null,
    thinking: null,
    peers: null,
    fold: null,
    selfId: null,
    ctx: null,
    ctxShort: null,
    agents: null,
    agentWord: null,
  };
  const options: Required<StatusLineOptions> = { ascii: false, reducedMotion: false, spinnerFrame: 0, mode: 'session', flatBadge: false, terminalColumns: 80, indicatorWide: '⢎⣉⡱', indicatorNarrow: '⣾' };
  const same = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const deps = (s: StatusLineState, o: StatusLineOptions = options, inner = 76): unknown[] => statusMemoDeps(s, inner, o);

  it('moves when any member moves', () => {
    const d0 = deps(base);
    for (const key of Object.keys(base)) {
      const moved = { ...base, [key]: { moved: key } } as unknown as StatusLineState;
      expect(same(deps(moved), d0), key).toBe(false);
    }
  });

  it('moves with every field of the git zone and the draft, not with their per-render identity', () => {
    const d0 = deps(base);
    expect(same(deps({ ...base, git: { ...ZONE }, draft: { ...base.draft } }), d0)).toBe(true);
    expect(same(deps({ ...base, git: null }), d0)).toBe(false);
    expect(same(deps({ ...base, git: { ...ZONE, head: { kind: 'detached', oid: 'def5678' } } }), d0)).toBe(false);
    expect(same(deps({ ...base, git: { ...ZONE, ahead: 2 } }), d0)).toBe(false);
    expect(same(deps({ ...base, git: { ...ZONE, behind: 1 } }), d0)).toBe(false);
    expect(same(deps({ ...base, git: { ...ZONE, dirty: { ...DIRTY } } }), d0)).toBe(false);
    expect(same(deps({ ...base, git: { ...ZONE, linkedWorktree: true } }), d0)).toBe(false);
    expect(same(deps({ ...base, git: { ...ZONE, frozen: true } }), d0)).toBe(false);
    expect(same(deps({ ...base, draft: { secretHits: 1 } }), d0)).toBe(false);
  });

  it('moves with every option and the inner width, and keeps one length for every shape', () => {
    const d0 = deps(base);
    const moved: StatusLineOptions[] = [{ ...options, ascii: true }, { ...options, reducedMotion: true }, { ...options, spinnerFrame: 1 }, { ...options, mode: 'one-shot' }, { ...options, flatBadge: true }, { ...options, terminalColumns: 120 }, { ...options, indicatorWide: '⢎⣀⡱' }, { ...options, indicatorNarrow: '⣷' }];
    for (const o of moved) expect(same(deps(base, o), d0), JSON.stringify(o)).toBe(false);
    expect(same(deps(base, options, 77), d0)).toBe(false);
    expect(Object.keys(moved[0] ?? {})).toHaveLength(Object.keys(options).length);
    // git null vs a zone, options absent vs present, optional members absent: the deps array never changes length
    const minimal: StatusLineState = { run: 'none', mode: null, status: null, ready: null, done: null, runId: null, overlay: 'none', pendingReview: null, retrying: null, blocking: null, errors: 0, stageStartedAt: null, toasts: [], git: null, spend: { run: null, session: null }, draft: { secretHits: 0 }, nowMs: 0 };
    expect(deps(minimal, {}).length).toBe(d0.length);
  });
});

describe('the cursor protocol end to end: every frame of a streamed reply ends with ESC[?25h', () => {
  it('the real App on a stub TTY (standard log-update, 30 fps), 40 live deltas with a draft in the composer', async () => {
    const stdout = new StubStdout(24, 80, true);
    const stdin = new StubStdin();
    const bus = createEventBus();
    const bridge = createBridge(null, null);
    const launch: LaunchSettings = { fps: 30, renderMode: 'standard', screenReader: false, ascii: false, noColor: false, reducedMotion: true };
    const inst = inkRender(<App task="" resumeId={null} source={bus} confirmer={createTuiConfirmer()} onAbort={() => undefined} mode="session" cwd="/Users/x/proj" tickMs={0} bridge={bridge} launch={launch} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: false,
      interactive: true,
      maxFps: 30,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      await sleep(150);
      stdin.write('also 日本語');
      await sleep(80);
      bridge.command({ type: 'dispatch', action: { type: 'thinking', phase: 'replying' } });
      await sleep(80);
      const from = stdout.frames.join('').length;
      const before = { ...calls };
      let text = 'Here is the plan:\n';
      for (let i = 0; i < 40; i++) {
        text += `w${i}${i % 6 === 5 ? '\n' : ' '}`;
        bridge.command({ type: 'dispatch', action: { type: 'live', text } });
        await sleep(12);
      }
      await sleep(120);
      const capture = stdout.frames.join('').slice(from);
      const { frames } = splitFrames(capture);
      expect(frames.length).toBeGreaterThan(5);
      const stats = cursorStats(frames, capture);
      expect(stats.framesWithoutShow).toBe(0);
      expect(stats.hidesMaxPerFrame).toBeLessThanOrEqual(1);
      expect(stats.shownAtEnd).toBe(true);
      expect(capture).toContain('w39');
      // the real wiring keys the memos right: 40 text-only commits rebuilt neither the status row nor the composer
      // (the App's statusView / statusOpts / hitSpans objects are fresh on every one of them)
      expect(calls.statusSpans - before.statusSpans).toBe(0);
      expect(calls.composerView - before.composerView).toBe(0);
      expect(calls.topEdge - before.topEdge).toBe(0);
    } finally {
      inst.unmount();
    }
  });
});
