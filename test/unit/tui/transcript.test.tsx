/**
 * TUI-DESIGN §19.3 / §13.4 / §14.1 A28 (`Transcript.tsx`): every `<Static>` item renders inside its own `PaneBoundary`
 * — one throwing item costs one `ui: static pane failed to render (…)` row and every later item keeps flowing into
 * the scrollback (finding 6); the header is printed with epoch 0 only and never again after the soft-cap remount
 * (finding 16); `itemLines` splits the detail body; label-aware rows print `[ui]` instead of `stepLabel()`.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STATIC_ITEM_MAX_ROWS, STATIC_ITEM_PANE, Transcript, bodyRows, bodyRowsCut, bodyWidth, cappedTailRow, cappedTailRowAscii, cappedTailRungs, gutterIndent, gutterMode, isBlockItem, isCapRow, isTurnContinuation, itemFailedRow, itemLines, itemRenderRows, labelProps, normaliseRows, spacerAbove } from '../../../src/tui/Transcript.js';
import { textProps, themeFor } from '../../../src/tui/theme.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import { wrapBody } from '../../../src/tui/transcript/wrap.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { renderFaultFor, resetRenderFaults, type PaneFailure } from '../../../src/tui/PaneBoundary.js';
import { formatTranscriptItem, localItem, sessionHeaderItem, type TranscriptItem } from '../../../src/tui/plain.js';

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
    // TUI-DESIGN-4 §7.12 (S6's `paneFailedLine`): the headline is shorter and names the log it can actually reach
    expect(itemFailedRow('TypeError', 'run.log')).toBe('ui: static failed (TypeError) — run continues; see run.log');
  });

  it('later appends keep rendering after a fault (the boundary is per item, not per transcript)', () => {
    const header = sessionHeaderItem('/tmp/proj');
    const ui = render(<Transcript items={items(1)} header={header} fault={renderFaultFor('static')} />);
    ui.rerender(<Transcript items={items(3)} header={header} fault={renderFaultFor('static')} />);
    const all = ui.frames.map(strip).join('\n');
    expect(all).toContain('[ui] item number 1');
    expect(all).toContain('[ui] item number 2');
    // one fallback row in the scrollback (the test stdout re-emits the static output per frame, so count within one)
    expect(strip(ui.lastFrame()).split('ui: static failed').length - 1).toBeLessThanOrEqual(1);
    expect(strip(ui.frames[0]).split('ui: static failed').length - 1).toBe(1);
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

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-4 §2.3 (D-AB) / §5.1 P-C3 / §2.4 (P-R3) — the narrow ladder, the per-item cap,
// the command-block exemption and the cut-aware identity normaliser.
// ---------------------------------------------------------------------------------------

/** the 296-character step item A7 measured: 258 committed rows at 10 columns before the cap. */
const LONG = `run $ python -m pytest -q tests/test_core.py::test_parse_date_handles_dst_boundaries · risk 0.00 ok · tests 41p/3f/0e · judge 0.49 · 4.9s · $0.006 · edited packages/app/src/components/SomeVeryLongName.test.tsx and src/core/parse_date.py in one step, then re-ran the whole test suite again`;

describe('the narrow ladder (TUI-DESIGN-4 §2.3, D-AB)', () => {
  it('the gutter/stacked/flush table, and bodyWidth follows it', () => {
    expect(LONG.length).toBe(288); // the 296-cell class of step item A7 measured at 258 rows / 10 columns
    expect([gutterMode(80), gutterMode(34), gutterMode(33), gutterMode(24), gutterMode(23), gutterMode(10)]).toEqual(['gutter', 'gutter', 'stacked', 'stacked', 'flush', 'flush']);
    expect(bodyWidth(80, '[ui]')).toBe(70);
    expect(bodyWidth(30, '[ui]')).toBe(28); // stacked ignores the label
    expect(bodyWidth(10, '[ui]')).toBe(10); // flush: the whole row
  });

  it('§10 S2: `bodyRows(item).length` at 8/10/12/16/20/24/30/34/40/80 against a bound table — a 258-row wall becomes ≤ 24', () => {
    const capped = (c: number): number => bodyRows(LONG, c, '[step 7]', GLYPHS.unicode, true).length;
    // the measured "before" (round 3's 1-cell floor at `columns − max(9, label) − 1`): 8 → 288, 10 → 258, 16 → 63
    const floored = (c: number): number => wrapBody(LONG, Math.max(1, c - 10)).length;
    expect(floored(10)).toBeGreaterThan(200);
    expect(floored(16)).toBeGreaterThan(50);
    // the ladder alone (no cap) already removes the wall from 16 columns up; the cap closes 8…12
    expect({ 8: capped(8), 10: capped(10), 12: capped(12), 16: capped(16), 20: capped(20), 24: capped(24), 30: capped(30), 34: capped(34), 40: capped(40), 80: capped(80) }).toEqual({ 8: 24, 10: 24, 12: 24, 16: 21, 20: 18, 24: 17, 30: 12, 34: 17, 40: 12, 80: 6 });
    for (let c = 1; c <= 200; c++) expect(capped(c), `${c}`).toBeLessThanOrEqual(STATIC_ITEM_MAX_ROWS);
    // ≥ 34 the cap changes nothing at all: the rows are round 3's
    for (const c of [34, 40, 80, 120, 200]) expect(capped(c), `${c}`).toBe(bodyRows(LONG, c, '[step 7]', GLYPHS.unicode, false).length);
    expect(bodyRows(LONG, 40, '[step 7]', GLYPHS.unicode, true).at(-1)).not.toMatch(/transcript\.log/);
  });

  it('§2.3 / §11 "no row wider than the terminal": the cap tail is a ladder too, never a truncation', () => {
    expect(cappedTailRungs(9)).toEqual(['… +9 rows (transcript.log)', '… +9 rows (log)', '… +9 rows', '… +9', '…+9']);
    expect(cappedTailRow(9)).toBe('… +9 rows (transcript.log)');
    expect(cappedTailRow(9, 26)).toBe('… +9 rows (transcript.log)');
    expect(cappedTailRow(9, 25)).toBe('… +9 rows (log)');
    expect(cappedTailRow(9, 14)).toBe('… +9 rows');
    expect(cappedTailRow(9, 8)).toBe('… +9');
    expect(cappedTailRow(9, 3)).toBe('…+9');
    expect(cappedTailRowAscii(9, 20)).toBe('... +9 rows (log)');
    expect(cappedTailRowAscii(9, 16)).toBe('... +9 rows');
    for (const r of cappedTailRungs(9)) expect(isCapRow(r)).toBe(true);
    for (const r of cappedTailRungs(9, true)) expect(isCapRow(r)).toBe(true);
    expect(isCapRow('run $ pytest')).toBe(false);
    // round-4 review finding 8: a bare ellipsis row is body text, never the marker the identity gate skips on
    expect(isCapRow('…')).toBe(false);
    expect(isCapRow('...')).toBe(false);
    // the rendered tail is never wider than the body it sits in, at every width
    for (let c = 1; c <= 60; c++) {
      const rows = bodyRows(LONG, c, '[ui]', GLYPHS.unicode, true);
      const last = rows.at(-1)!;
      if (isCapRow(last)) expect(stringWidth(last), `${c}`).toBeLessThanOrEqual(bodyWidth(c, gutterMode(c) === 'gutter' ? '[ui]' : ''));
    }
  });

  it('§2.3 edges 1 and 9: no row is empty, none has a trailing space, and none is wider than its body width, at every width 1…120', () => {
    for (let c = 1; c <= 120; c++) {
      for (const label of ['[ui]', '[step 1000]', '[jevcode]']) {
        const rows = bodyRows(LONG, c, label, GLYPHS.unicode, true);
        expect(rows.length, `${c}`).toBeGreaterThanOrEqual(1);
        for (const r of rows) {
          expect(r, `${c}: ${JSON.stringify(r)}`).not.toBe('');
          expect(r, `${c}: ${JSON.stringify(r)}`).not.toMatch(/ $/);
        }
      }
    }
  });

  it('§2.3: an item carrying `detailRows` from a command block is EXEMPT — `/diff --all` at 10 columns keeps its full row count', () => {
    const engine = localItem(LONG, 1, { label: '[ui]' });
    const block: TranscriptItem = { ...localItem(LONG, 2, { label: '[ui]' }), detailRows: [{ text: 'M a.ts  +1 −0', role: 'dim' }], detailKind: 'table' } as TranscriptItem;
    expect(isBlockItem(engine)).toBe(false);
    expect(isBlockItem(block)).toBe(true);
    const engineRows = bodyRows(LONG, 10, '[ui]', GLYPHS.unicode, !isBlockItem(engine));
    const blockRows = bodyRows(LONG, 10, '[ui]', GLYPHS.unicode, !isBlockItem(block));
    expect(engineRows).toHaveLength(STATIC_ITEM_MAX_ROWS);
    expect(blockRows.length).toBeGreaterThan(STATIC_ITEM_MAX_ROWS);
    expect(blockRows.at(-1)).not.toMatch(/transcript\.log/);
    expect(isCapRow(engineRows.at(-1)!)).toBe(true);
    expect(isCapRow(blockRows.at(-1)!)).toBe(false);
  });

  it('round-4 review finding 2: the cap is the ITEM’s budget — an engine item carrying a plain `detail` is bounded too', () => {
    // §2.3 keys the cap on the item's SOURCE and exempts only a command block's `detailRows`. `clipDetail` bounds a
    // detail's source LINES, not its rendered rows, so at a narrow rung each of the `[run] end` epilogue's lines
    // re-wraps into four to eight rows: measured on this tree before the fix, one such item drew 27 rows at 10
    // columns and 34 at 16, with `isBlockItem(item) === false` — exactly the wall D-AB exists to close.
    const detail = [
      'run        20260921-212813-uo5luiq4',
      'files      ~/.jevcode/runs/20260921-212813-uo5luiq4/  (transcript.log, state.json, jevcode.log)',
      'resume     jevcode run --resume 20260921-212813-uo5luiq4',
      'report     jevcode report 20260921-212813-uo5luiq4   (redacted bundle written locally; nothing is sent)',
      'restored   3 files',
      'skipped    1 file',
    ].join('\n');
    const item = localItem('stopped — replan_stop (exit 4)', 1, { label: '[ui]', detail });
    expect(isBlockItem(item)).toBe(false);
    for (const columns of [8, 10, 16, 24, 34, 40, 80]) {
      const ui = render(<Transcript items={[item]} columns={columns} />);
      const drawn = strip(ui.lastFrame()).split('\n').filter((r) => r.trim() !== '');
      expect(drawn.length, `${columns}: ${drawn.length} rows`).toBeLessThanOrEqual(STATIC_ITEM_MAX_ROWS);
      for (const r of drawn) expect(stringWidth(r), `${columns}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(columns);
      cleanup();
    }
    // the narrow widths are the ones that used to overflow, and the tail names everything not drawn
    for (const columns of [8, 10, 16, 24]) {
      const ui = render(<Transcript items={[item]} columns={columns} />);
      const drawn = strip(ui.lastFrame()).split('\n').filter((r) => r.trim() !== '');
      expect(drawn, `${columns}`).toHaveLength(STATIC_ITEM_MAX_ROWS);
      expect(isCapRow(drawn.at(-1)!.trimStart()), `${columns}: ${drawn.at(-1)}`).toBe(true);
      cleanup();
    }
    // …and the same item as a command BLOCK keeps every row (§3.1.5's own cap and footer own it)
    const block: TranscriptItem = { ...item, detailRows: [{ text: 'M a.ts  +1 −0', role: 'dim' }] } as TranscriptItem;
    expect(isBlockItem(block)).toBe(true);
    const blockUi = render(<Transcript items={[block]} columns={10} />);
    expect(strip(blockUi.lastFrame()).split('\n').filter((r) => r.trim() !== '').length).toBeGreaterThan(STATIC_ITEM_MAX_ROWS);
  });

  it('round-4 review finding 2: `itemRenderRows` splits the capped budget between the body and the detail', () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i} of the detail body`).join('\n');
    const item = localItem('short head', 1, { label: '[ui]', detail: many });
    const r = itemRenderRows(item, 80);
    expect(r.capped).toBe(true);
    expect(r.body.length + r.detail.length).toBe(STATIC_ITEM_MAX_ROWS);
    expect(r.body).toEqual(['short head']); // the cut fell inside the detail, so the body is whole
    expect(isCapRow(r.detail.at(-1)!)).toBe(true);
    expect(r.detail.at(-1)).toContain('+18');
    // a body that alone exceeds the cap swallows the whole budget and the detail is not drawn at all
    const long = itemRenderRows(localItem(LONG, 2, { label: '[ui]', detail: many }), 10);
    expect(long.body).toHaveLength(STATIC_ITEM_MAX_ROWS);
    expect(long.detail).toEqual([]);
    expect(isCapRow(long.body.at(-1)!)).toBe(true);
    // an uncapped item reports `capped: false` and every row
    const small = itemRenderRows(localItem('hello', 3, { label: '[ui]', detail: 'one\ntwo' }), 80);
    expect(small).toMatchObject({ capped: false, body: ['hello'], detail: ['one', 'two'] });
  });

  it('§2.3 identity: `gutter` and `flush` re-join to formatTranscriptItem; `stacked` needs the one declared clause (the label row)', () => {
    const item = localItem('edited packages/app/src/components/SomeVeryLongName.test.tsx in one step', 9, { label: '[ui]' });
    const text = formatTranscriptItem(item);
    for (const c of [40, 60, 80, 120]) {
      const out = bodyRowsCut(item.text, c, '[ui]');
      expect(normaliseRows(['     [ui]', ...out.rows], out.cuts.map((k) => k + 1)), `gutter ${c}`).toBe(text);
    }
    for (const c of [24, 28, 30, 33]) {
      const out = bodyRowsCut(item.text, c, ''); // stacked: the label is its own row
      expect(normaliseRows(['[ui]', ...out.rows], out.cuts.map((k) => k + 1)), `stacked ${c}`).toBe(text);
    }
    for (const c of [10, 16, 20, 23]) {
      const out = bodyRowsCut(`[ui] ${item.text}`, c, ''); // flush: the label is row 0's first token
      expect(normaliseRows(out.rows, out.cuts), `flush ${c}`).toBe(text);
    }
  });

  it('§2.3 edge 4 / §14.1: the `--ascii` twin caps to the same row count and its tail is the ascii ellipsis', () => {
    const rows = bodyRows(LONG, 10, '[ui]', GLYPHS.ascii, true);
    expect(rows).toHaveLength(STATIC_ITEM_MAX_ROWS);
    expect(rows.at(-1)).toBe('... +9');
    expect(isCapRow(rows.at(-1)!)).toBe(true);
    expect(bodyRows(LONG, 30, '[ui]', GLYPHS.ascii, true).length).toBe(bodyRows(LONG, 30, '[ui]', GLYPHS.ascii, false).length);
  });
});

describe('<Transcript> renders the rung it is given (§2.3, §5.1 P-C3)', () => {
  const rowsOf = (frame: string | undefined): string[] => strip(frame).split('\n').filter((l) => l.trim() !== '');

  it('gutter at 80: the label sits in the 10-cell column, unchanged from round 3', () => {
    const ui = render(<Transcript items={[localItem('hello there', 1, { label: '[ui]' })]} columns={80} />);
    expect(rowsOf(ui.lastFrame())[0]).toBe('     [ui] hello there');
  });

  it('stacked at 30: the label takes its own row and the body hangs at 2 — every character survives', () => {
    const text = 'edited packages/app/src/components/SomeVeryLongName.test.tsx in one step';
    const ui = render(<Transcript items={[localItem(text, 1, { label: '[ui]' })]} columns={30} />);
    const rows = rowsOf(ui.lastFrame());
    expect(rows[0]).toBe('[ui]');
    expect(rows.slice(1).every((r) => r.startsWith('  '))).toBe(true);
    for (const r of rows) expect(stringWidth(r), r).toBeLessThanOrEqual(30);
    const out = bodyRowsCut(text, 30, '');
    expect(normaliseRows(rows, out.cuts.map((k) => k + 1))).toBe(`[ui] ${text}`);
  });

  it('P-C3 at 10 columns: no label box, the label is the first token of row 0, and the body is never zero-width', () => {
    const ui = render(<Transcript items={[localItem('hello there world', 1, { label: '[ui]' })]} columns={10} />);
    const rows = rowsOf(ui.lastFrame());
    expect(rows[0]?.startsWith('[ui]')).toBe(true);
    for (const r of rows) expect(stringWidth(r), r).toBeLessThanOrEqual(10);
    expect(normaliseRows(rows)).toBe('[ui] hello there world');
  });

  it('§2.3: one engine item at 2×10 commits at most 24 rows, where the audit measured 183', () => {
    const ui = render(<Transcript items={[localItem(LONG, 1, { label: '[sandbox]' })]} columns={10} />);
    const rows = rowsOf(ui.lastFrame());
    expect(rows.length).toBeLessThanOrEqual(STATIC_ITEM_MAX_ROWS);
    expect(isCapRow(rows.at(-1)!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-4 §5.1 (D-Y, as ratified: "dim label on every continuation row") — colour only.
// ---------------------------------------------------------------------------------------
describe('the turn label: full weight on the first item, dim on every continuation (§5.1, D-Y)', () => {
  const theme = themeFor('dark');
  const you = (text: string, key: number): TranscriptItem => localItem(text, key, { label: '[you]' });
  const bot = (text: string, key: number): TranscriptItem => localItem(text, key, { label: '[jevcode]' });

  it('isTurnContinuation: a turn is a maximal run of contiguous items sharing one chat label', () => {
    expect(isTurnContinuation(you('b', 2), you('a', 1))).toBe(true);
    expect(isTurnContinuation(you('a', 1), null)).toBe(false);
    expect(isTurnContinuation(you('b', 2), bot('a', 1))).toBe(false);
    expect(isTurnContinuation(bot('b', 2), bot('a', 1))).toBe(true);
    // a `[ui]` / `[step]` item is its own block and never a continuation, even after itself
    expect(isTurnContinuation(localItem('x', 2, { label: '[ui]' }), localItem('x', 1, { label: '[ui]' }))).toBe(false);
    // the surviving blank line of a paste (§5.2 P-C4) is a continuation like any other item
    expect(isTurnContinuation(you('', 2), you('a', 1))).toBe(true);
  });

  it('the first item of a turn keeps its pink and its bold; a continuation is the same text at `dim`', () => {
    expect(labelProps(you('a', 1), theme, 24)).toEqual({ ...textProps(theme, 'you', 24), bold: true });
    expect(labelProps(you('b', 2), theme, 24, true)).toEqual(textProps(theme, 'dim', 24));
    expect(labelProps(bot('b', 2), theme, 24, true)).toEqual(textProps(theme, 'dim', 24));
    // a non-chat label was already dim, so the flag changes nothing there
    expect(labelProps(localItem('x', 1), theme, 24, true)).toEqual(labelProps(localItem('x', 1), theme, 24));
    // …and it is never bold, which is the whole point of the rule
    expect(labelProps(you('b', 2), theme, 24, true).bold).toBeUndefined();
  });

  it('P-C1 (round-4 review finding 12): ONE spacer per turn — the dim label and the blank row never contradict each other', () => {
    // D-Y's dim continuation label says "same turn"; round 3's unconditional `[you]` spacer said "new block" one row
    // above it. §5.1's table wants one signal: `isChatLabel(item.label) ⇒ prev.label !== item.label`, which is
    // exactly `isTurnContinuation`'s negation, so the two halves of D-Y ship together.
    expect(spacerAbove(you('b', 2), you('a', 1))).toBe(false);
    expect(spacerAbove(bot('b', 2), bot('a', 1))).toBe(false);
    expect(spacerAbove(you('a', 1), bot('b', 0))).toBe(true);
    expect(spacerAbove(bot('a', 1), you('b', 0))).toBe(true);
    expect(spacerAbove(you('a', 1), null)).toBe(false);
    expect(spacerAbove(you('a', 2), localItem('x', 1))).toBe(true);
    for (const item of [you('b', 2), bot('b', 2)]) for (const prev of [you('a', 1), bot('a', 1), localItem('a', 1), null]) {
      expect(spacerAbove(item, prev), `${item.label}/${prev?.label ?? 'null'}`).toBe(!isTurnContinuation(item, prev) && prev !== null);
    }
    // the measured payoff: a 3-line `[you]` turn is 4 rows (one spacer, three labels), not 6
    const rows = strip(render(<Transcript items={[localItem('head', 0, { label: '[ui]' }), you('one', 1), you('two', 2), you('three', 3)]} columns={80} />).lastFrame()).replace(/\n$/, '').split('\n');
    expect(rows).toEqual(['     [ui] head', '', '    [you] one', '    [you] two', '    [you] three']);
  });

  it('the change is COLOUR ONLY: the label text is printed on every item and NO_COLOR rows are byte-identical', () => {
    const turn = [you('first line', 1), you('second line', 2), you('third line', 3)];
    const plain = render(<Transcript items={turn} columns={80} color={false} />);
    const rows = strip(plain.lastFrame()).split('\n').filter((r) => r.trim() !== '');
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r, JSON.stringify(r)).toMatch(/^ {4}\[you\] /);
    expect(labelProps(you('b', 2), theme, false, true)).toEqual({});
    cleanup();
    // with colour the rows still carry the same visible text — only the SGR run differs
    const coloured = render(<Transcript items={turn} columns={80} color={24} />);
    expect(strip(coloured.lastFrame()).split('\n').filter((r) => r.trim() !== '')).toEqual(rows);
    const raw = (coloured.lastFrame() ?? '').split('\n').filter((r) => r.trim() !== '');
    expect(raw[0]).not.toBe(raw[1]);
  });
});

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-4 §2.9 (V23) — no continuation row over-indents the gutter of its rung.
// ---------------------------------------------------------------------------------------
describe('V23 in process: no continuation row over-indents its rung (§2.9, A2 D10)', () => {
  it('every rendered row of an item is indented by at most the rung gutter, at widths 1…120', () => {
    for (const columns of [1, 4, 8, 10, 16, 20, 23, 24, 30, 33, 34, 40, 44, 60, 80, 120]) {
      for (const label of ['[ui]', '[jevcode]', '[step 1000]']) {
        const ui = render(<Transcript items={[localItem(LONG, 1, { label: label as '[ui]' })]} columns={columns} />);
        const rows = strip(ui.lastFrame()).split('\n').filter((r) => r.trim() !== '');
        const gutter = gutterIndent(columns, stringWidth(label));
        for (const r of rows) {
          expect(stringWidth(r), `${columns}/${label}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(columns);
          expect((/^ */.exec(r))![0].length, `${columns}/${label}: ${JSON.stringify(r)}`).toBeLessThanOrEqual(gutter);
        }
        cleanup();
      }
    }
  });

  it('`wrapBody` itself never produces a row that begins with a space, at any width (the source of V23)', () => {
    for (let w = 1; w <= 120; w++) for (const r of wrapBody(LONG, w)) expect(r, `${w}: ${JSON.stringify(r)}`).not.toMatch(/^ /);
  });
});
