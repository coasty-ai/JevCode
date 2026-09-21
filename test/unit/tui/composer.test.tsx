/**
 * TUI-DESIGN §19.3 / §19.0 (`Composer.tsx`): the pure view (`composerView`: prompt / continuation prefixes, the
 * viewport that keeps the cursor row visible, `↑N`/`↓N` markers, `•` cells over secret spans with widths and the
 * cursor unchanged, chip labels atomic), the placeholders (§24, short review form below 16 rows), `draftRows`, and
 * the mounted component (placeholder as a dim sibling, the cursor handed to the App-owned setter at
 * `{ x: gutter + cursorX, y: top + row − scrollTop }`, hidden when inactive).
 */
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from 'ink-testing-library';
import type { CursorPosition } from 'ink';
import { Composer, PLACEHOLDERS, PROMPT, PROMPT_UNICODE, composerView, draftRows, hitSpans, placeholderFor, placeholderParts, placeholderRow, promptFor } from '../../../src/tui/composer/Composer.js';
import { createBuffer, reduceBuffer } from '../../../src/tui/composer/buffer.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { detectSecrets } from '../../../src/core/redact.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';

afterEach(() => cleanup());

const CANARY = `sk-ant-api03-${'B'.repeat(40)}`;

describe('composerView (§4.3)', () => {
  it('row 0 carries `› ` (`> ` under --ascii and in --plain), continuation rows two spaces; every row ≤ columns cells; the cursor is gutter + x', () => {
    const text = 'first line of the draft\nsecond line';
    const v = composerView({ text, cursor: text.length, chips: [], columns: 40, height: 6, scrollTop: 0 });
    expect(v.rows[0]).toBe('› first line of the draft');
    expect(PROMPT).toBe('> ');
    expect(PROMPT_UNICODE).toBe('› ');
    expect(promptFor(GLYPHS.ascii)).toBe('> ');
    expect(promptFor(GLYPHS.unicode)).toBe('› ');
    expect(composerView({ text, cursor: 0, chips: [], columns: 40, height: 2, scrollTop: 0, glyphs: GLYPHS.ascii }).rows[0]).toBe('> first line of the draft');
    expect(v.rows[1]).toBe('  second line');
    expect(v.rows).toHaveLength(6);
    expect(v.rows.slice(2)).toEqual(['', '', '', '']);
    for (const r of v.rows) expect(stringWidth(r)).toBeLessThanOrEqual(40);
    expect(v.cursor).toEqual({ row: 1, x: 2 + 'second line'.length });
    expect(v.cursorRow).toBe('last');
    expect(v.totalRows).toBe(2);
  });

  it('the viewport keeps the cursor row visible; `↑N` / `↓N` mark hidden rows on the first / last visible row (F-T, F-AA)', () => {
    const text = Array.from({ length: 9 }, (_, i) => `row ${i}`).join('\n');
    const bottom = composerView({ text, cursor: text.length, chips: [], columns: 80, height: 6, scrollTop: 0 });
    expect(bottom.scrollTop).toBe(3);
    expect(bottom.hiddenAbove).toBe(3);
    expect(bottom.hiddenBelow).toBe(0);
    expect(bottom.rows[0]).toMatch(/^ {2}row 3 +↑3$/);
    expect(stringWidth(bottom.rows[0] ?? '')).toBe(80);
    const top = composerView({ text, cursor: 0, chips: [], columns: 80, height: 6, scrollTop: 3 });
    expect(top.scrollTop).toBe(0);
    expect(top.rows[5]).toMatch(/^ {2}row 5 +↓3$/);
    expect(top.rows[0]).toBe('› row 0');
    expect(top.cursorRow).toBe('first');
    // ASCII twins of the markers
    const ascii = composerView({ text, cursor: text.length, chips: [], columns: 80, height: 6, scrollTop: 0, glyphs: GLYPHS.ascii });
    expect(ascii.rows[0]).toMatch(/\^3$/);
  });

  it('detected secret spans render as `•` cells of the same width; the row width and the cursor arithmetic are unchanged (F-V)', () => {
    const text = `use this key for the smoke test only: ${CANARY} and then remove it`;
    const hits = detectSecrets(text);
    expect(hits.length).toBeGreaterThan(0);
    const plain = composerView({ text, cursor: text.length, chips: [], columns: 80, height: 3, scrollTop: 0 });
    const masked = composerView({ text, cursor: text.length, chips: [], columns: 80, height: 3, scrollTop: 0, spans: hitSpans(hits) });
    expect(masked.rows.join('\n')).not.toContain(CANARY);
    expect(masked.rows.join('\n')).not.toContain('B'.repeat(8));
    // the span wraps across two rows: the bullets total the masked span's width
    const bullets = masked.rows.join('').split('•').length - 1;
    expect(bullets).toBe(hits.reduce((n, h) => n + (h.end - h.start), 0));
    expect(masked.rows.map(stringWidth)).toEqual(plain.rows.map(stringWidth));
    expect(masked.cursor).toEqual(plain.cursor);
    const ascii = composerView({ text, cursor: 0, chips: [], columns: 80, height: 3, scrollTop: 0, spans: hitSpans(hits), glyphs: GLYPHS.ascii });
    expect(ascii.rows.join('').split('*').length - 1).toBe(hits.reduce((n, h) => n + (h.end - h.start), 0));
  });

  it('a chip label is atomic in the wrap: it never splits across rows', () => {
    let b = createBuffer();
    b = reduceBuffer(b, { type: 'insert', text: 'x'.repeat(30) });
    b = reduceBuffer(b, { type: 'chip', chip: { n: 1, lines: 42, bytes: 900, label: '[Pasted #1, 42 lines]' } });
    const v = composerView({ text: b.text, cursor: b.cursor, chips: b.chips, columns: 40, height: 4, scrollTop: 0 });
    expect(v.rows.some((r) => r.includes('[Pasted #1, 42 lines]'))).toBe(true);
    expect(v.rows.some((r) => /\[Pasted #1, 42$/.test(r))).toBe(false);
  });

  it('the picker filter prompt `> filter: ` replaces `> `', () => {
    const v = composerView({ text: 'par', cursor: 3, chips: [], columns: 80, height: 1, scrollTop: 0, prompt: '> filter: ' });
    expect(v.rows[0]).toBe('> filter: par');
    expect(v.cursor).toEqual({ row: 0, x: '> filter: '.length + 3 });
  });

  it('draftRows counts visual rows (≥ 1) for LayoutInput.composerWant', () => {
    expect(draftRows('', [], 80)).toBe(1);
    expect(draftRows('a\nb\nc', [], 80)).toBe(3);
    expect(draftRows('x'.repeat(200), [], 80)).toBe(3);
  });
});

describe('placeholders (TUI-DESIGN-2 §4.4, verbatim)', () => {
  it('every mode has its verbatim string; the hint is appended at ≥ 100 inner cells; the review form is short below 16 rows', () => {
    expect(placeholderFor('task', 24)).toBe('Say hi, ask a question, or describe a task…');
    expect(placeholderFor('task', 24, 76)).toBe('Say hi, ask a question, or describe a task…');
    expect(placeholderFor('task', 24, 100)).toBe('Say hi, ask a question, or describe a task…   / commands · @ files');
    expect(placeholderFor('followup', 24)).toBe('Follow-up, question, or /command…');
    expect(placeholderFor('followup', 24, 116)).toBe('Follow-up, question, or /command…   ↑ history · Esc Esc menu');
    expect(placeholderFor('steer', 24)).toBe('Type to steer the next step…  Esc pauses');
    expect(placeholderFor('steer', 24, 116)).toBe('Type to steer the next step…  Esc pauses   Esc Esc aborts');
    expect(placeholderFor('review', 24)).toBe('(review pending — keys in the card; d opens a note)');
    expect(placeholderFor('review', 12)).toBe('(review pending)');
    expect(placeholderFor('thinking', 24)).toBe('(thinking…)');
    expect(placeholderFor('intakeWait', 24)).toBe('(waiting for y/n)');
    // the console right-aligns the task / follow-up hint (H-A1w, H-B2w) and appends the steer hint (H-D1w)
    expect(placeholderParts('task', 24, 116).align).toBe('right');
    expect(placeholderParts('steer', 24, 116).align).toBe('inline');
    expect(placeholderRow('task', 24, 116, 2)).toBe(`Say hi, ask a question, or describe a task…${' '.repeat(116 - 2 - 43 - 20)}/ commands · @ files`);
    expect(placeholderRow('steer', 24, 116, 2)).toBe('Type to steer the next step…  Esc pauses   Esc Esc aborts');
    expect(placeholderRow('task', 24, 76, 2)).toBe('Say hi, ask a question, or describe a task…');
    expect(placeholderFor('followupWait', 24)).toBe('(waiting for y/r/n)');
    expect(placeholderFor('exitWait', 24)).toBe('(waiting for y/n)');
    expect(placeholderFor('blocked', 24)).toBe('(paused — answer the pane above)');
    // one-shot after run:end (§1 "mounted for steering only", §3.3 "no idle states"): nothing invites input
    expect(placeholderFor('done', 24)).toBe('');
    expect(PLACEHOLDERS.filter).toBe('filter: ');
  });
});

describe('<Composer> (§4.3)', () => {
  function mountComposer(text: string, over: Partial<Parameters<typeof Composer>[0]> = {}) {
    const positions: (CursorPosition | undefined)[] = [];
    let b = createBuffer();
    if (text) b = reduceBuffer(b, { type: 'insert', text });
    const ui = render(<Composer buffer={b} columns={80} height={3} top={5} scrollTop={0} cursor={(p) => positions.push(p)} active mode="task" rows={24} {...over} />);
    return { ui, positions, frame: () => (ui.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '') };
  }

  it('renders exactly `height` rows, the placeholder as a sibling of the prompt when empty, and places the cursor at the prompt', () => {
    const { frame, positions } = mountComposer('');
    const lines = frame().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`${PROMPT_UNICODE}${PLACEHOLDERS.task}`);
    expect(positions.at(-1)).toEqual({ x: 2, y: 5 });
  });

  it('places the cursor at gutter + cursorX on the cursor row offset by `top`; hides it when inactive', () => {
    const text = 'hello\nworld';
    const a = mountComposer(text);
    expect(a.positions.at(-1)).toEqual({ x: 2 + 5, y: 5 + 1 });
    cleanup();
    const b = mountComposer(text, { active: false });
    expect(b.positions.at(-1)).toBeUndefined();
    expect(b.frame()).toContain('› hello');
  });

  it('shows the ghost completion dim after the cursor and the Ctrl-R search row', () => {
    const g = mountComposer('/bud', { ghost: { rest: 'get', more: 2 } });
    expect(g.frame().split('\n')[0]).toBe('› /budget +2');
    cleanup();
    const s = mountComposer('fix parse_date', { searchRow: "(reverse-i-search)'par': fix parse_date" });
    expect(s.frame().split('\n')[0]).toBe("(reverse-i-search)'par': fix parse_date");
  });
});
