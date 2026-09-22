/**
 * TUI-DESIGN-3 §8 S5 (`round3-polish-app.test.tsx`, over the shared harness): P7 — after Enter no frame reads `Type to steer` or
 * `│ starting`; the 10-cell label gutter in a mounted App (D-L); the §5.3 identity normaliser over the whole scripted run at 80
 * columns — every engine item's rows (the padded label row and its hanging continuations) re-join to `formatTranscriptItem(item)`,
 * step rows break at ` · ` with the separator leading, and no continuation row is an orphan; the status row never carries the run
 * id (rule 7); the console prompt at rest and while live (D-O, observed through the roles the rows are built from).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from 'ink-testing-library';
import { createBridge } from '../../../src/tui/App.js';
import { LIVE_FLUSH_MS } from '../../../src/tui/useEngine.js';
import { formatTranscriptItem, itemsFromEvent } from '../../../src/tui/plain.js';
import { PLACEHOLDERS } from '../../../src/tui/composer/Composer.js';
import { LABEL_GUTTER, bodyRows, gutterLabel, normaliseRows } from '../../../src/tui/Transcript.js';
import { ORPHAN_MIN_CELLS } from '../../../src/tui/transcript/wrap.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { loadRunEvents, mkRisk, tick } from '../../fixtures/tui/fixtures.js';
import { makeStepRecord } from '../../fixtures/checkpoint/make.js';
import { dynamicLines, fakeHost, mountApp, stripSgr, waitFor, type Mounted } from './app-harness.js';

afterEach(() => cleanup());

const G = ' '.repeat(LABEL_GUTTER);

/** a host whose `submit` stays pending until `release()` — the intake in flight */
function pendingHost(): { host: ReturnType<typeof fakeHost>; release: (outcome?: unknown) => void } {
  const host = fakeHost();
  let release: (outcome?: unknown) => void = () => undefined;
  host.submit = (text, opts) => {
    host.order.push('submit');
    host.submitted.push({ text, kind: opts.kind, secretSpans: opts.secretSpans, pinnedFiles: opts.pinnedFiles });
    return new Promise<unknown>((r) => {
      release = r;
    }) as Promise<void>;
  };
  return { host, release: (o) => release(o) };
}

async function settleSplash(m: Mounted): Promise<void> {
  m.dispatch({ type: 'splash:done' });
  await waitFor(() => m.state()?.splash === 'done');
  await tick(20);
}

/** the scrollback rows of a frame (everything above the last rule row) */
function scrollback(frame: string): string[] {
  const lines = stripSgr(frame).split('\n');
  const dyn = dynamicLines(stripSgr(frame));
  return lines.slice(0, lines.length - dyn.length);
}

describe('P7 — no wrong chrome between Enter and the bubble (TUI-DESIGN-3 §5.2)', () => {
  it('after Enter, no frame carries `Type to steer` or `│ starting`; the first frames read the thinking word or the idle word', async () => {
    const { host, release } = pendingHost();
    const m = mountApp({ mode: 'session', host });
    await settleSplash(m);
    const before = m.frames.length;
    m.stdin.write('hi\r');
    await waitFor(() => m.state()?.run === 'starting');
    await tick(60);
    const after = m.frames.slice(before).map(stripSgr);
    expect(after.length).toBeGreaterThan(0);
    for (const f of after) {
      expect(f).not.toContain(PLACEHOLDERS.steer);
      expect(f).not.toMatch(/│ starting/);
    }
    // S2's `send()` dispatches the intake phase with `run:starting`, so the row reads the thinking word from the first frame on
    expect(m.state()?.thinking).toBe('intake');
    expect(m.lastFrame()).toContain(PLACEHOLDERS.thinking);
    // the phase clears before the reply lands: the row falls back to the idle word, never to `starting`
    m.dispatch({ type: 'thinking', phase: null });
    await waitFor(() => m.state()?.thinking === null);
    await tick(40);
    expect(m.lastFrame()).not.toMatch(/│ starting/);
    expect(m.lastFrame()).toMatch(/│ idle /);
    release({ became: 'nothing' });
    await waitFor(() => m.state()?.run === 'none');
  });
});

describe('the label gutter and the §5.3 identity in a mounted App (TUI-DESIGN-3 §5.1, D-L)', () => {
  it('the header and the `[you]` bubble start at column 10; the `[jevcode]` label sits flush', async () => {
    const host = fakeHost();
    const m = mountApp({ mode: 'session', host });
    await settleSplash(m);
    const rows = scrollback(m.lastFrame());
    expect(rows[0]).toMatch(/^    \[run\] jevcode session · \S+ \| step 0\/– starting$/);
    // the bubbles are the controller's items (TUI-DESIGN-2 §3.10): the App renders what the host appends — here through the bridge
    m.dispatch({ type: 'local', text: 'hi', label: '[you]' });
    m.dispatch({ type: 'local', text: 'Hi. I am ready when you are — describe a change you want in proj, or ask what I can do.', label: '[jevcode]' });
    await waitFor(() => m.lastFrame().includes('[jevcode] Hi.'));
    const after = scrollback(m.lastFrame());
    expect(after.some((r) => r === '    [you] hi')).toBe(true);
    const bot = after.findIndex((r) => r.startsWith('[jevcode] Hi.'));
    expect(bot).toBeGreaterThan(0);
    expect(after[bot - 1]).toBe('');
    expect(gutterLabel('[jevcode]')).toBe('[jevcode]');
    expect(gutterLabel('[you]')).toBe('    [you]');
  });

  it('every engine item of the scripted run at 80 columns re-joins to formatTranscriptItem(item); step rows break at ` · `; no orphan continuation; the run id is never in the status row', async () => {
    const bridge = createBridge(null, null);
    bridge.geometry = { rows: 24, columns: 80 };
    const m = mountApp({ mode: 'session', bridge });
    m.dispatch({ type: 'transcript', view: 'full' });
    await tick(10);
    // the scripted run plus one `step:end` summary wide enough to wrap at the 70-cell body (the F-R4 row, TUI-DESIGN-2 §4.5 / §6 item 3)
    const record = makeStepRecord(3, {
      proposal: { goal: 'run the tests', action: { kind: 'run', command: 'python -m pytest -q tests/test_core.py' }, plan: { done: [], remaining: [], openProblems: [] }, rawText: '' },
      risk: { ...mkRisk('ok'), risk: 0 },
      judge: { succeeded: 0.49, errorPresent: 0.1, newInfo: 0.3, tests: { source: 'parsed', allPassed: false, passed: 4, failed: 3, errors: 0 }, doneClaims: [] },
      timing: { generatorMs: 0, jevMs: 0, execMs: 0, harnessMs: 0, totalMs: 4900 },
    });
    const events = [...loadRunEvents()];
    const endAt = events.findIndex((e) => e.type === 'run:end');
    events.splice(endAt, 0, { type: 'step:end', record, costUsd: { generator: 0.005, jev: 0.001 } });
    for (const e of events) m.bus.emit(e);
    await tick(LIVE_FLUSH_MS * 2);
    const frame = stripSgr(m.lastFrame());
    const rows = scrollback(frame);
    for (const r of rows) expect(stringWidth(r), r).toBeLessThanOrEqual(80);
    let seq = 0;
    let wrapped = 0;
    let stepRows = 0;
    for (const e of events) {
      for (const item of itemsFromEvent(e, seq)) {
        seq += 1;
        const label = item.label ?? (item.step === null ? '[run]' : `[step ${item.step}]`);
        const expected = bodyRows(item.text, 80, label).map((b, i) => (i === 0 ? `${gutterLabel(label)} ${b}` : `${' '.repeat(Math.max(LABEL_GUTTER - 1, stringWidth(label)) + 1)}${b}`));
        // the item's rows appear consecutively in the scrollback
        const at = rows.findIndex((_r, i) => expected.every((x, k) => rows[i + k] === x));
        expect(at, `missing rows for ${formatTranscriptItem(item)}: ${JSON.stringify(expected)} in ${JSON.stringify(rows.filter((r) => r.includes(label)).slice(0, 6))} (dyn ${dynamicLines(frame).length} of ${frame.split('\n').length})`).toBeGreaterThanOrEqual(0);
        const got = rows.slice(at, at + expected.length);
        expect(normaliseRows(got)).toBe(formatTranscriptItem(item));
        if (expected.length > 1) wrapped += 1;
        for (const cont of got.slice(1)) {
          expect(cont.startsWith(G)).toBe(true);
          const own = cont.slice(LABEL_GUTTER).replace(/^· /, '');
          expect(stringWidth(own), cont).toBeGreaterThanOrEqual(ORPHAN_MIN_CELLS);
        }
        if (item.kind === 'step' && expected.length > 1) {
          stepRows += 1;
          for (const cont of got.slice(1)) expect(cont.startsWith(`${G}· `)).toBe(true);
        }
      }
    }
    expect(wrapped).toBeGreaterThan(0);
    expect(stepRows).toBeGreaterThan(0);
    // rule 7: the status row (the dynamic region's console) never shows the run id
    const runId = events.find((e) => e.type === 'run:start');
    expect(runId).toBeDefined();
    const status = dynamicLines(frame).find((l) => /step \d+\/\d+/.test(l) && l.startsWith('│')) ?? '';
    expect(status).not.toContain('20260919-120000-ab12');
    expect(frame).toContain('idle exit 4');
    expect(m.state()?.run).toBe('none');
  });
});
