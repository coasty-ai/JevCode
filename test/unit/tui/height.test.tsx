/**
 * TUI-DESIGN §2 / §19.3 height budget. Ink's debug mode writes `fullStaticOutput + dynamicFrame` on every frame, so
 * the transcript scrollback and the live panes arrive in one string. The App draws the rule row as the first dynamic
 * row (`─` × columns before a run, the pane's tab header once the pane has rows); the dynamic region is everything
 * from the last such row onwards, which is what the budget bounds (rows − 2) and what equals `computeLayout().total`.
 * Static rows above it are unbounded by design.
 */
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/tui/App.js';
import { CAP, computeLayout } from '../../../src/tui/layout.js';
import { LIVE_FLUSH_MS, createEventBus, createTuiConfirmer } from '../../../src/tui/useEngine.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import type { Action } from '../../../src/core/types.js';
import { mkConfirmRequest, mkDecision, mkStatus, tick } from '../../fixtures/tui/fixtures.js';
import { StubStdin, StubStdout, dynamicRegion, stripSgr } from './stub-stdout.js';

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
});

interface Busy {
  frame: string;
  staticRows: number;
  stdout: StubStdout;
}

async function renderBusy(rows: number, columns: number, action?: Action, opts: { review?: boolean; wait?: number } = {}): Promise<Busy> {
  const stdout = new StubStdout(rows, columns);
  const stdin = new StubStdin();
  const bus = createEventBus();
  const confirmer = createTuiConfirmer();
  const instance = render(<App task="budget task" resumeId={null} source={bus} confirmer={confirmer} onAbort={() => undefined} mode="one-shot" tickMs={0} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  unmounts.push(() => instance.unmount());

  bus.emit({ type: 'run:start', runId: 'r1', task: 'budget task', mode: 'jev-on', resumedFromStep: null });
  bus.emit({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 'budget task', resumed: false });
  bus.emit({ type: 'generator:start', step: 1, attempt: 1 });
  for (let i = 0; i < 200; i++) bus.emit({ type: 'generator:delta', step: 1, text: `streamed line ${i} ${'x'.repeat(120)}\n` });
  for (let i = 0; i < 30; i++) bus.emit({ type: 'decision', decision: mkDecision({ id: `dim${i}`, step: 1, verdict: i % 3 === 0 ? 'block' : i % 3 === 1 ? 'review' : 'ok' }) });
  bus.emit({ type: 'status', status: mkStatus(1, 'risk') });
  if (opts.review !== false) {
    const req = mkConfirmRequest('c1', 1, action);
    bus.emit({ type: 'confirm:request', request: req });
    void confirmer.confirm(req, { signal: new AbortController().signal }).catch(() => undefined);
  }
  // the review box appears after the §6.3 deferral (~1 s idle)
  await tick(opts.wait ?? (opts.review === false ? LIVE_FLUSH_MS * 3 : 1250));
  const frame = stripSgr(stdout.lastFrame());
  const staticRows = frame.replace(/\n$/, '').split('\n').length - dynamicRegion(frame, columns).length;
  return { frame, staticRows, stdout };
}

const bigWrite: Action = { kind: 'write', path: 'big.txt', content: Array.from({ length: 40 }, (_, i) => `content line ${i}`).join('\n') };

const reviewInput = (rows: number, columns: number) => ({ rows, columns, overlay: 'review' as const, overlayWant: CAP.reviewHeader, previewWant: 40, expanded: false, composerWant: 1, queueWant: 0, liveWant: 0, bannerWant: 0 as const, paneWant: CAP.pane });

describe('height budget (§2)', () => {
  it.each([12, 24])('rows=%i columns=80: dynamic region ≤ rows − 2 and equal to computeLayout().total with 200 streamed lines, 30 decisions and a pending review', async (rows) => {
    const { frame, staticRows } = await renderBusy(rows, 80, bigWrite);
    const dyn = dynamicRegion(frame, 80);
    expect(dyn.length).toBeLessThanOrEqual(rows - 2);
    expect(dyn.length).toBe(computeLayout(reviewInput(rows, 80)).total);
    for (const line of dyn) expect(stringWidth(line)).toBeLessThanOrEqual(80);
    const text = dyn.join('\n');
    expect(text).toContain('review  step 1');
    expect(text).toContain('[y] approve [n] decline');
    expect(text).toContain('step 1/40');
    // a pending review reclaims the live rows (A42) and collapses the composer to one inactive row
    expect(text).not.toContain('streamed line');
    expect(text).toContain('(review pending');
    expect(staticRows).toBeGreaterThanOrEqual(2);
    if (rows === 24) {
      // F-G: rule 1 + pane 7 + header 8 + preview 4 + composer 1 + status 1 = 22
      expect(text).toContain('content line 0');
      expect(text).toContain('[review]');
      expect(text).not.toContain('content line 39');
    }
    if (rows === 12) {
      // F-H: header cut to 7 by reviewHeaderLines(req, 7): the keys line survives, no preview, no pane
      expect(text).not.toContain('content line');
      expect(text).not.toContain('dim29');
    }
  });

  it('a 40-row terminal shows the decisions pane, a clipped preview with the `e expands` tail and still fits', async () => {
    const { frame } = await renderBusy(40, 100, bigWrite);
    const dyn = dynamicRegion(frame, 100);
    expect(dyn.length).toBeLessThanOrEqual(38);
    expect(dyn.length).toBe(computeLayout(reviewInput(40, 100)).total);
    expect(dyn.join('\n')).toContain('dim29');
    // CAP.preview = 8: seven content rows plus the `…[k more preview lines · e expands]` tail
    expect(dyn.filter((l) => l.includes('content line')).length).toBe(7);
    expect(dyn.filter((l) => l.includes('more preview lines · e expands')).length).toBe(1);
  });

  it('live streaming without a review: live 2 + pane + composer 1 + status; the last two stream lines show', async () => {
    const { frame } = await renderBusy(24, 80, undefined, { review: false });
    const dyn = dynamicRegion(frame, 80);
    expect(dyn.length).toBeLessThanOrEqual(22);
    expect(dyn.length).toBe(computeLayout({ ...reviewInput(24, 80), overlay: 'none', overlayWant: 0, previewWant: 0, liveWant: 2 }).total);
    expect(dyn.join('\n')).toContain('streamed line 199');
    expect(dyn.join('\n')).toContain('streamed line 198');
    expect(dyn.join('\n')).toContain('Type to steer the next step…');
  });

  it.each([8, 12, 24, 40, 50])('rows=%i: every dynamic row is ≤ 80 cells and the region never exceeds rows − 2', async (rows) => {
    const { frame } = await renderBusy(rows, 80, bigWrite);
    const dyn = dynamicRegion(frame, 80);
    expect(dyn.length).toBeLessThanOrEqual(rows - 2);
    for (const line of dyn) expect(stringWidth(line)).toBeLessThanOrEqual(80);
  });

  it('the minimum-size notice replaces the panes below 40×8 and the transcript keeps flowing above', async () => {
    const { frame } = await renderBusy(6, 80, undefined, { review: false });
    const lines = stripSgr(frame).replace(/\n$/, '').split('\n');
    expect(lines.some((l) => l.includes('terminal 80×6 is below the 40×8 minimum — panes hidden, transcript above'))).toBe(true);
    expect(lines.some((l) => l.includes('[run] ready r1 step 0/40'))).toBe(true);
    expect(lines.at(-1)).toContain('step 1/40');
  });

  it('resize 40 → 12 → 40 keeps the draft and never exceeds the new budget', async () => {
    const stdout = new StubStdout(40, 80);
    const stdin = new StubStdin();
    const bus = createEventBus();
    const instance = render(<App task="" resumeId={null} source={bus} confirmer={createTuiConfirmer()} onAbort={() => undefined} mode="session" cwd="/tmp/proj" tickMs={0} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    unmounts.push(() => instance.unmount());
    await tick(20);
    stdin.write('a draft that survives a resize');
    await tick(80);
    stdout.resize(12, 60);
    await tick(120);
    let dyn = dynamicRegion(stripSgr(stdout.lastFrame()), 60);
    expect(dyn.length).toBeLessThanOrEqual(10);
    expect(dyn.join('\n')).toContain('a draft that survives a resize');
    stdout.resize(40, 80);
    await tick(120);
    dyn = dynamicRegion(stripSgr(stdout.lastFrame()), 80);
    expect(dyn.length).toBeLessThanOrEqual(38);
    expect(dyn.join('\n')).toContain('a draft that survives a resize');
  });
});

describe('height budget across columns (§2.2 × §19.3: rows 8/12/24/40/50 × columns 40/80/120)', () => {
  it.each([
    [8, 40],
    [8, 120],
    [12, 40],
    [12, 120],
    [24, 40],
    [24, 120],
    [40, 40],
    [40, 120],
    [50, 40],
    [50, 120],
  ])('rows=%i columns=%i (live, no review): the region is ≤ rows − 2, equals computeLayout().total and every row fits the width', async (rows, columns) => {
    const { frame } = await renderBusy(rows, columns, undefined, { review: false });
    const dyn = dynamicRegion(frame, columns);
    expect(dyn.length).toBeLessThanOrEqual(rows - 2);
    expect(dyn.length).toBe(computeLayout({ ...reviewInput(rows, columns), overlay: 'none', overlayWant: 0, previewWant: 0, liveWant: 2 }).total);
    for (const line of dyn) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
    expect(frame).toContain('step 1/40');
  });

  it.each([40, 80, 120])('columns=%i rows=24 with a pending review: the header ladder fits the width and the budget', async (columns) => {
    const { frame } = await renderBusy(24, columns, bigWrite);
    const dyn = dynamicRegion(frame, columns);
    expect(dyn.length).toBeLessThanOrEqual(22);
    expect(dyn.length).toBe(computeLayout(reviewInput(24, columns)).total);
    for (const line of dyn) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
    expect(dyn.join('\n')).toContain('review  step 1');
    expect(dyn.join('\n')).toContain('[y] approve');
  });

  it.each([40, 80, 120])('columns=%i: the normalised session first frame matches its snapshot', async (columns) => {
    const stdout = new StubStdout(24, columns);
    const stdin = new StubStdin();
    const bus = createEventBus();
    const instance = render(<App task="" resumeId={null} source={bus} confirmer={createTuiConfirmer()} onAbort={() => undefined} mode="session" cwd="/tmp/proj" tickMs={0} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    unmounts.push(() => instance.unmount());
    await tick(20);
    // the normalised serializer: SGR stripped, trailing spaces trimmed, the trailing newline dropped
    const normalised = stripSgr(stdout.lastFrame())
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n$/, '');
    expect(normalised).toMatchSnapshot();
  });
});
