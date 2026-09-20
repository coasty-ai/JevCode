/**
 * §10 height budget. Ink's debug mode (which ink-testing-library also uses) writes
 * `fullStaticOutput + dynamicFrame` on every frame, so the transcript scrollback and the live
 * panes arrive in one string. The App draws a full-width rule ("─" × columns) as the first
 * dynamic row; the dynamic region is everything from the last such line onwards, which is
 * what the budget bounds (rows − 2). Static rows above it are unbounded by design.
 */
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { App, RULE_CHAR, computeLayout } from '../../../src/tui/App.js';
import { LIVE_FLUSH_MS, createEventBus, createTuiConfirmer } from '../../../src/tui/useEngine.js';
import type { Action } from '../../../src/core/types.js';
import { mkConfirmRequest, mkDecision, mkStatus, tick } from '../../fixtures/tui/fixtures.js';

class StubStdout extends EventEmitter {
  frames: string[] = [];
  rows: number;
  columns: number;
  constructor(rows: number, columns: number) {
    super();
    this.rows = rows;
    this.columns = columns;
  }
  write = (s: string): boolean => {
    this.frames.push(s);
    return true;
  };
  lastFrame(): string {
    return this.frames[this.frames.length - 1] ?? '';
  }
}
class StubStdin extends EventEmitter {
  isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): null {
    return null;
  }
}

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
});

function dynamicRegion(frame: string, columns: number): string[] {
  const lines = frame.replace(/\n$/, '').split('\n');
  const rule = RULE_CHAR.repeat(columns);
  const idx = lines.lastIndexOf(rule);
  expect(idx, 'rule line present').toBeGreaterThanOrEqual(0);
  return lines.slice(idx);
}

async function renderBusy(rows: number, columns: number, action?: Action): Promise<{ frame: string; staticRows: number }> {
  const stdout = new StubStdout(rows, columns);
  const stdin = new StubStdin();
  const bus = createEventBus();
  const confirmer = createTuiConfirmer();
  const instance = render(<App task="budget task" resumeId={null} source={bus} confirmer={confirmer} onAbort={() => undefined} />, {
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
  const req = mkConfirmRequest('c1', 1, action);
  bus.emit({ type: 'confirm:request', request: req });
  void confirmer.confirm(req, { signal: new AbortController().signal }).catch(() => undefined);
  await tick(LIVE_FLUSH_MS * 3);
  const frame = stdout.lastFrame();
  const staticRows = frame.replace(/\n$/, '').split('\n').length - dynamicRegion(frame, columns).length;
  return { frame, staticRows };
}

const bigWrite: Action = { kind: 'write', path: 'big.txt', content: Array.from({ length: 40 }, (_, i) => `content line ${i}`).join('\n') };

describe('height budget (§10)', () => {
  it.each([12, 24])('rows=%i columns=80: dynamic region ≤ rows − 2 with 200 streamed lines, 30 decisions and a pending confirmation', async (rows) => {
    const { frame, staticRows } = await renderBusy(rows, 80, bigWrite);
    const dyn = dynamicRegion(frame, 80);
    expect(dyn.length).toBeLessThanOrEqual(rows - 2);
    expect(dyn.length).toBe(computeLayout(rows, true, 40).total);
    for (const line of dyn) expect(line.length).toBeLessThanOrEqual(80);
    const text = dyn.join('\n');
    expect(text).toContain('streamed line 199');
    expect(text).toContain('confirm c1 step 1');
    expect(text).toContain('[y] approve  [n] decline');
    expect(text).toContain('step 1/40');
    // the scrollback above the rule holds the committed rows (run:start, run:ready) and is not budgeted
    expect(staticRows).toBeGreaterThanOrEqual(2);
    if (rows === 24) {
      expect(text).toContain('content line 0');
      expect(text).toContain('[block]');
      expect(text).toContain('[review]');
      expect(text).not.toContain('content line 39');
    }
    if (rows === 12) {
      expect(text).not.toContain('content line');
      expect(text).not.toContain('dim29');
    }
  });

  it('a 40-row terminal shows the decisions pane, a clipped preview and still fits', async () => {
    const { frame } = await renderBusy(40, 100, bigWrite);
    const dyn = dynamicRegion(frame, 100);
    expect(dyn.length).toBeLessThanOrEqual(38);
    expect(dyn.join('\n')).toContain('dim29');
    // MAX_PREVIEW_ROWS = 8: seven content rows plus the "…[N more preview lines]" marker
    expect(dyn.filter((l) => l.includes('content line')).length).toBe(7);
    expect(dyn.filter((l) => l.includes('more preview lines')).length).toBe(1);
  });
});
