import { describe, expect, it } from 'vitest';
import { cellWidth } from '../../../../src/tui/glyphs.js';
import { NO_SYNTH_YET, synthLines, synthRows } from '../../../../src/tui/pane/synth.js';
import { paneState } from './helpers.js';

describe('synth tab (TUI-DESIGN §7.2 `s`, §15.3 verbatim phase + detail)', () => {
  it('renders `synth  <phase>: <detail>` and the candidates/tested row', () => {
    expect(synthRows(paneState({ tab: 's' }), 12, 80)).toEqual(['synth  verify: tested 37/137 candidates at kth.py:12', '       candidates=137 tested=37']);
    expect(synthLines({ step: 1, phase: 'localize', detail: 'site kth.py:12' })).toEqual(['synth  localize: site kth.py:12']);
    expect(synthLines({ step: 1, phase: 'x', detail: '', tested: 3 })).toEqual(['synth  x:', '       tested=3']);
  });
  it('keeps a multi-line detail verbatim, one row per line, controls stripped', () => {
    expect(synthLines({ step: 1, phase: 'verify', detail: 'line one\r\nline two\n\n\u001b[2Jline three' })).toEqual(['synth  verify: line one', '       line two', '       [2Jline three']);
  });
  it('drops bidi controls and turns U+2028/2029 into row breaks-as-spaces (§14.1)', () => {
    const rows = synthLines({ step: 1, phase: 'ver\u202eify', detail: 'site \u202ekth.py:12\u202c\u2028fixed \u2066x\u2069\ny' });
    expect(rows).toEqual(['synth  verify: site kth.py:12 fixed x', '       y']);
    for (const l of synthRows(paneState({ synth: { step: 1, phase: 'p', detail: 'a\u200e\u200fb\u061c' } }), 5, 80)) expect(l).toBe('synth  p: ab');
  });
  it('caps at rows, truncates to columns, renders the placeholder', () => {
    const s = paneState({ tab: 's' });
    expect(synthRows(s, 1, 80).length).toBe(1);
    expect(synthRows(s, 0, 80)).toEqual([]);
    for (const c of [10, 30, 59]) for (const l of synthRows(s, 5, c)) expect(cellWidth(l)).toBeLessThanOrEqual(c);
    expect(synthRows(paneState({ synth: null }), 5, 80)).toEqual([NO_SYNTH_YET]);
    const huge = paneState({ synth: { step: 1, phase: 'p', detail: 'x'.repeat(100_000) } });
    expect(cellWidth(synthRows(huge, 5, 80)[0]!)).toBe(80);
  });
});
