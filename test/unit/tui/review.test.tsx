/**
 * TUI-DESIGN §19.3 (`review.test.tsx`): the review box draws `reviewHeaderLines(req, n, columns)` unchanged at every
 * n (the ladder is the function's), the `d` note field replaces row 2 (and its own secret gate renders there), the
 * preview is `confirmPreviewLines` through `reviewPreviewLines` with the `e expands` tail, every row ≤ columns cells,
 * the note cursor lands after the label, and the component never exceeds header + preview rows.
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { CursorPosition } from 'ink';
import { NOTE_LABEL, Review, maskGlyphFor, maskHits, noteFieldRow, previewWant, reviewPreview, reviewRows } from '../../../src/tui/Review.js';
import { REVIEW_KEYS_80 as KEYS_80 } from '../../../src/tui/review/lines.js';
import { REVIEW_KEYS_80, REVIEW_KEYS_120, reviewHeaderLines } from '../../../src/tui/review/lines.js';
import { stringWidth } from '../../../src/tui/composer/width.js';
import { detectSecrets } from '../../../src/core/redact.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import { mkConfirmRequest } from '../../fixtures/tui/fixtures.js';
import { workedRequest } from './pane/helpers.js';

afterEach(() => cleanup());

const big = mkConfirmRequest('c1', 7, { kind: 'write', path: 'big.txt', content: Array.from({ length: 30 }, (_, i) => `content line ${i}`).join('\n') });

describe('reviewRows / reviewPreview (§6.1, §6.2)', () => {
  it.each([8, 7, 6, 5, 4, 3, 2])('n=%i at 80 and 120 columns equals reviewHeaderLines and keeps the keys line', (n) => {
    for (const columns of [80, 120]) {
      const rows = reviewRows(workedRequest(), n, columns);
      expect(rows).toEqual(reviewHeaderLines(workedRequest(), n, columns));
      expect(rows.length).toBeLessThanOrEqual(n);
      expect(rows.length).toBeGreaterThanOrEqual(Math.min(n, 3));
      expect(rows[1]).toBe(columns >= 120 ? REVIEW_KEYS_120 : REVIEW_KEYS_80);
      for (const r of rows) expect(stringWidth(r)).toBeLessThanOrEqual(columns);
    }
  });

  it('the note field replaces row 2 for its lifetime; the gate line replaces it while the note has a hit', () => {
    const rows = reviewRows(workedRequest(), 8, 80, undefined, { text: 'skip the tests', gate: null });
    expect(rows[1]).toBe(`${NOTE_LABEL}skip the tests`);
    expect(rows[0]).toBe(reviewHeaderLines(workedRequest(), 8, 80)[0]);
    const gated = reviewRows(workedRequest(), 8, 80, undefined, { text: 'x', gate: 'Looks like this contains a secret (sk-ant-…). Send anyway? y/N' });
    expect(gated[1]).toBe('Looks like this contains a secret (sk-ant-…). Send anyway? y/N');
    expect(noteFieldRow({ text: 'a'.repeat(200), gate: null }, 40)).toMatch(/…$/);
    expect(stringWidth(noteFieldRow({ text: 'a'.repeat(200), gate: null }, 40))).toBeLessThanOrEqual(40);
  });

  it('the preview is confirmPreviewLines indented, cut to the rows with the `…[k more preview lines · e expands]` tail only when rows are hidden', () => {
    expect(previewWant(big)).toBe(30);
    const four = reviewPreview(big, 4, 80);
    expect(four).toHaveLength(4);
    expect(four[0]).toBe('  content line 0');
    expect(four[3]).toBe('…[27 more preview lines · e expands]');
    const all = reviewPreview(big, 40, 80);
    expect(all).toHaveLength(30);
    expect(all.some((l) => l.includes('more preview'))).toBe(false);
    expect(reviewPreview(big, 0, 80)).toEqual([]);
    expect(previewWant(mkConfirmRequest('c2', 1, { kind: 'read', paths: ['a.py'] }))).toBe(0);
  });
});

describe('<Review>', () => {
  it('renders header + preview rows exactly and places the note cursor after the label on row 2', () => {
    const positions: (CursorPosition | undefined)[] = [];
    const ui = render(<Review req={big} rows={8} previewRows={4} columns={80} top={3} note={{ text: 'ok', gate: null }} cursor={(p) => positions.push(p)} />);
    const lines = (ui.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    expect(lines).toHaveLength(12);
    expect(lines[1]).toBe(`${NOTE_LABEL}ok`);
    expect(lines[8]).toBe('  content line 0');
    expect(positions.at(-1)).toEqual({ x: NOTE_LABEL.length + 2, y: 4 });
  });

  it('renders nothing when granted no rows, and the F-I 3-row header at rows 8', () => {
    const none = render(<Review req={big} rows={0} previewRows={0} columns={80} top={0} />);
    expect(none.lastFrame()).toBe('');
    cleanup();
    const three = render(<Review req={workedRequest()} rows={3} previewRows={0} columns={80} top={0} />);
    const lines = (three.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('3 plan_mismatch L2 r=0.44 tail c=0.61 | 1 destructive L1 r=0.25 exp c=0.93');
  });
});

describe('the note row masks secret spans (§4.3 / §10.2, finding 3)', () => {
  const canary = `sk-ant-api03-${'R'.repeat(40)}`;

  it('maskHits replaces every code point of a hit with mask glyphs of the same width; nothing else moves', () => {
    expect(maskHits('abc', [], '•')).toBe('abc');
    expect(maskHits('key is secret ok', [{ start: 7, end: 13 }], '•')).toBe('key is •••••• ok');
    expect(maskHits('ééé', [{ start: 1, end: 2 }], '*')).toBe('é*é');
    expect(maskHits('a漢b', [{ start: 1, end: 2 }], '•')).toBe('a••b'); // a wide cell masks to two glyphs
    expect(maskGlyphFor(GLYPHS.unicode)).toBe('•');
    expect(maskGlyphFor(GLYPHS.ascii)).toBe('*');
  });

  it('noteFieldRow renders the detected spans as • cells (never the bytes) and keeps the label; the cursor lands after the masked text', () => {
    const text = `key is ${canary}`;
    const hits = detectSecrets(text);
    expect(hits.length).toBeGreaterThan(0);
    const row = noteFieldRow({ text, gate: null, spans: hits.map((h) => ({ start: h.start, end: h.end })) }, 120);
    expect(row).not.toContain(canary);
    expect(row).toBe(`${NOTE_LABEL}key is ${'•'.repeat(canary.length)}`);
    expect(stringWidth(row)).toBe(stringWidth(`${NOTE_LABEL}${text}`));
    // without spans the text is printed as typed (the caller decides; the App always passes the hits)
    expect(noteFieldRow({ text: 'plain', gate: null }, 80)).toBe(`${NOTE_LABEL}plain`);
    const positions: (CursorPosition | undefined)[] = [];
    render(<Review req={workedRequest()} rows={8} previewRows={0} columns={120} top={2} note={{ text, gate: null, spans: hits.map((h) => ({ start: h.start, end: h.end })) }} cursor={(p) => positions.push(p)} />);
    expect(positions.at(-1)).toEqual({ x: stringWidth(`${NOTE_LABEL}${text}`), y: 3 });
  });
});

describe('the review card arm (TUI-DESIGN-3 §5.2 A8: drawing only — `resolveKey` decides what `y` does)', () => {
  /** the `<Text>` props the component asked for, recorded through a stub theme lookup: every row's text with its role */
  it('unarmed: the keys row is the same text (nothing moves, nothing is hidden); armed (default): the same rows — the arm changes colour only', () => {
    const rows = (armed: boolean | undefined, boxed: boolean): string[] => {
      const ui = render(<Review req={workedRequest()} rows={boxed ? 9 : 8} previewRows={0} columns={80} top={0} {...(armed === undefined ? {} : { armed })} boxed={boxed} />);
      const out = (ui.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
      cleanup();
      return out;
    };
    for (const boxed of [false, true]) {
      const unarmed = rows(false, boxed);
      const armed = rows(true, boxed);
      const dflt = rows(undefined, boxed);
      expect(unarmed).toEqual(armed);
      expect(dflt).toEqual(armed);
      // the keys row is present in both frames: only `y` approves, whatever the colour says
      expect(unarmed.some((r) => r.includes(KEYS_80.trim()) || r.includes('[y] approve'))).toBe(true);
    }
  });
  it('the review invariants stay: Enter is drawn nowhere as a default, the keys line reads `[y] approve` first', () => {
    const ui = render(<Review req={workedRequest()} rows={8} previewRows={0} columns={80} top={0} armed={false} />);
    const text = (ui.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toContain('[y] approve');
    expect(text).not.toMatch(/Enter (approves|accepts)/);
  });
});
