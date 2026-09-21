/**
 * TUI-DESIGN §19.3 / §13.4 / §14.1 A28 (`Transcript.tsx`): every `<Static>` item renders inside its own `PaneBoundary`
 * — one throwing item costs one `ui: static pane failed to render (…)` row and every later item keeps flowing into
 * the scrollback (finding 6); the header is printed with epoch 0 only and never again after the soft-cap remount
 * (finding 16); `itemLines` splits the detail body; label-aware rows print `[ui]` instead of `stepLabel()`.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STATIC_ITEM_PANE, Transcript, itemFailedRow, itemLines } from '../../../src/tui/Transcript.js';
import { renderFaultFor, resetRenderFaults, type PaneFailure } from '../../../src/tui/PaneBoundary.js';
import { localItem, sessionHeaderItem, type TranscriptItem } from '../../../src/tui/plain.js';

afterEach(() => cleanup());
beforeEach(() => resetRenderFaults());

const strip = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

function items(n: number, from = 0): TranscriptItem[] {
  return Array.from({ length: n }, (_, i) => localItem(`item number ${from + i}`, from + i, { label: '[ui]' }));
}

describe('<Transcript> per-item boundary (§13.4, finding 6)', () => {
  it('one throwing item degrades to the one-row fallback; the items before and after it are all in the scrollback; onFail reports pane `static` once', () => {
    const failures: PaneFailure[] = [];
    const header = sessionHeaderItem('/tmp/proj');
    const ui = render(<Transcript items={items(3)} header={header} fault={renderFaultFor('static')} onFail={(f) => failures.push(f)} />);
    const out = strip(ui.lastFrame());
    // the injected fault fires once, on the first item rendered (the header); the three items follow
    expect(out).toContain(itemFailedRow('InjectedRenderFault'));
    expect(out).not.toContain('jevcode session · proj');
    expect(out).toContain('[ui] item number 0');
    expect(out).toContain('[ui] item number 1');
    expect(out).toContain('[ui] item number 2');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.pane).toBe(STATIC_ITEM_PANE);
    expect(failures[0]?.error.name).toBe('InjectedRenderFault');
    expect(itemFailedRow('TypeError', 'run.log')).toBe('ui: static pane failed to render (TypeError) — run continues; details in run.log');
  });

  it('later appends keep rendering after a fault (the boundary is per item, not per transcript)', () => {
    const header = sessionHeaderItem('/tmp/proj');
    const ui = render(<Transcript items={items(1)} header={header} fault={renderFaultFor('static')} />);
    ui.rerender(<Transcript items={items(3)} header={header} fault={renderFaultFor('static')} />);
    const all = ui.frames.map(strip).join('\n');
    expect(all).toContain('[ui] item number 1');
    expect(all).toContain('[ui] item number 2');
    // one fallback row in the scrollback (the test stdout re-emits the static output per frame, so count within one)
    expect(strip(ui.lastFrame()).split('failed to render').length - 1).toBeLessThanOrEqual(1);
    expect(strip(ui.frames[0]).split('failed to render').length - 1).toBe(1);
  });
});

describe('<Transcript> header and epoch (§14.1 A28, finding 16)', () => {
  it('prints the header with epoch 0 only; a soft-cap remount (epoch 1, fresh array) never reprints it', () => {
    const header = sessionHeaderItem('/tmp/proj');
    const ui = render(<Transcript items={items(2)} header={header} epoch={0} />);
    expect(strip(ui.lastFrame())).toContain('[run] jevcode session · proj | step 0/– starting');
    const before = ui.frames.length;
    ui.rerender(<Transcript items={items(2, 20_000)} header={header} epoch={1} />);
    const after = ui.frames.slice(before).map(strip).join('\n');
    expect(after).toContain('[ui] item number 20000');
    expect(after).not.toContain('jevcode session · proj');
  });

  it('itemLines: the label-aware line and the detail body split on newlines, glyph twins applied under --ascii', () => {
    const item = localItem('why s7.risk.plan_mismatch', 3, { label: '[ui]', detail: 'line one\nline two' });
    expect(itemLines(item)).toEqual({ line: '[ui] why s7.risk.plan_mismatch', detail: ['line one', 'line two'] });
    expect(itemLines(localItem('plain', 4, { label: '[setup]' })).detail).toEqual([]);
  });
});
