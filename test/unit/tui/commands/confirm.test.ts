/**
 * The confirm gate of TUI-DESIGN-4 §4.5 (D-X), as rungs: the three ladders, their measured widths, the selection
 * against the **card's inner width** and the `--plain` twin. §10 S4's row for the ladders is `overlay.test.tsx`
 * (S2's file, which renders them); this file owns the pure half — the literals, the ladder order and `fitRung`'s
 * choice for every width 20…200 — so a rung that stops fitting fails here first, in the module that declares it.
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIRM_ABORT_RUNGS,
  CONFIRM_EXIT_RUNGS,
  CONFIRM_NEW_RUNGS,
  confirmPlainPrompt,
  confirmRow,
  confirmRungs,
} from '../../../../src/tui/commands/confirm.js';
import type { ConfirmKind } from '../../../../src/tui/commands/dispatch.js';
import { GLYPHS, cellWidth } from '../../../../src/tui/glyphs.js';

const KINDS: readonly ConfirmKind[] = ['new', 'abort', 'exit'];

describe('the three confirm ladders (TUI-DESIGN-4 §4.5, §12)', () => {
  it('every rung is the §4.5 literal at its documented cell width, widest first', () => {
    expect(CONFIRM_NEW_RUNGS).toEqual([
      'end this session and start fresh? [y] yes  [n] keep it  (Enter does nothing)',
      'start fresh? [y] yes  [n] keep it  (Enter does nothing)',
      'start fresh? [y] yes  [n] no',
    ]);
    expect(CONFIRM_ABORT_RUNGS).toEqual([
      'abort the run now? the step in flight is discarded. [y] abort  [n] keep running',
      'abort the run? [y] abort  [n] keep running  (Enter does nothing)',
      'abort? [y] yes  [n] no',
    ]);
    expect(CONFIRM_EXIT_RUNGS).toEqual([
      'leave JevCode? [y] exit  [n] stay  (Enter does nothing)',
      'leave JevCode? [y] yes  [n] no',
      'leave? [y] yes  [n] no',
    ]);
    // the measured widths of §4.5 — the whole reason these are ladders and not literals (the single-literal forms
    // are 87 / 101 / 87 cells and all three overflow the card's 76 inner cells at 24×80)
    expect(CONFIRM_NEW_RUNGS.map(cellWidth)).toEqual([76, 55, 28]);
    expect(CONFIRM_ABORT_RUNGS.map(cellWidth)).toEqual([79, 64, 22]);
    expect(CONFIRM_EXIT_RUNGS.map(cellWidth)).toEqual([55, 30, 22]);
    for (const rungs of [CONFIRM_NEW_RUNGS, CONFIRM_ABORT_RUNGS, CONFIRM_EXIT_RUNGS]) {
      const w = rungs.map(cellWidth);
      expect(w.every((c, i) => i === 0 || c < (w[i - 1] as number))).toBe(true);
    }
  });
  it('the abort ladder drops `(Enter does nothing)` before the sentence that says what is lost, and the rung below restores it', () => {
    expect(CONFIRM_ABORT_RUNGS[0]).toContain('the step in flight is discarded');
    expect(CONFIRM_ABORT_RUNGS[0]).not.toContain('Enter does nothing');
    expect(CONFIRM_ABORT_RUNGS[1]).toContain('Enter does nothing');
    expect(CONFIRM_ABORT_RUNGS[1]).not.toContain('the step in flight');
  });
  it('§10 S2/S4: for widths 20…200 the chosen rung fits the card\'s inner width and still contains `[y]` and `[n]`', () => {
    for (const kind of ['new', 'abort', 'exit'] as const) {
      for (let columns = 20; columns <= 200; columns++) {
        const inner = Math.max(1, columns - 4);
        const row = confirmRow(kind, inner);
        expect(typeof row, `${kind}@${columns}`).toBe('string');
        expect(row, `${kind}@${columns}`).toContain('[y]');
        expect(row, `${kind}@${columns}`).toContain('[n]');
        const rungs = confirmRungs(kind);
        const narrowest = cellWidth(rungs[rungs.length - 1] as string);
        // the narrowest rung of every ladder is ≤ 28 cells, so it fits the card from 32 columns up; below that the
        // fallback is the narrowest rung (the caller truncates as a last resort) and it is never empty
        if (inner >= narrowest) expect(cellWidth(row), `${kind}@${columns}`).toBeLessThanOrEqual(inner);
        else expect(row).toBe(rungs[rungs.length - 1]);
        // and it is the WIDEST rung that fits, never a narrower one
        const widest = rungs.find((r) => cellWidth(r) <= inner);
        expect(row, `${kind}@${columns}`).toBe(widest ?? rungs[rungs.length - 1]);
      }
    }
  });
  it('the boundary widths: 80 columns (76 inner) takes the top `new` rung, the top `abort` rung needs 83', () => {
    expect(confirmRow('new', 76)).toBe(CONFIRM_NEW_RUNGS[0]);
    expect(confirmRow('new', 75)).toBe(CONFIRM_NEW_RUNGS[1]);
    expect(confirmRow('abort', 76)).toBe(CONFIRM_ABORT_RUNGS[1]);
    expect(confirmRow('abort', 79)).toBe(CONFIRM_ABORT_RUNGS[0]);
    expect(confirmRow('exit', 76)).toBe(CONFIRM_EXIT_RUNGS[0]);
    // 40 columns (36 inner): the audit's modal-with-no-visible-way-out is gone — every row still names both keys
    expect(confirmRow('abort', 36)).toBe(CONFIRM_ABORT_RUNGS[2]);
    expect(confirmRow('new', 36)).toBe(CONFIRM_NEW_RUNGS[2]);
    expect(confirmRow('exit', 36)).toBe(CONFIRM_EXIT_RUNGS[1]);
  });
  it('`--ascii` is byte-identical (the rungs carry no non-ASCII glyph today) and a NaN width takes the narrowest rung', () => {
    for (const kind of ['new', 'abort', 'exit'] as const) {
      expect(confirmRow(kind, 200, GLYPHS.ascii)).toBe(confirmRow(kind, 200));
      const row = confirmRow(kind, 200);
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7e]*$/.test(row)).toBe(true);
      expect(confirmRow(kind, Number.NaN)).toBe(confirmRungs(kind)[2]);
    }
  });
  it('`/history clear` keeps its own y/N (registry.ts), so it is not a ConfirmKind and every kind has a ladder', () => {
    // §4.5's fourth destructive command has no rung ladder, so it is NOT a `ConfirmKind`: a fourth member would be a
    // kind for which `confirmRow` must answer null — an overlay asked to draw an empty body for a command whose
    // Enter is inert. `confirmFor` answers null for the `historyClear` action instead (dispatch.test.ts).
    expect(KINDS).toHaveLength(3);
    for (const k of KINDS) {
      expect(confirmRungs(k), k).toHaveLength(3);
      expect(confirmRow(k, 76).length, k).toBeGreaterThan(0);
      expect(confirmPlainPrompt(k), k).toMatch(/\[y\/N\]$/);
    }
    // the type itself: the union has exactly the three kinds that own a ladder, so `'history-clear'` cannot be
    // passed by accident (dispatch.test.ts pins the other half: `confirmFor` answers null for its action)
    expect(KINDS).toEqual(['new', 'abort', 'exit']);
  });
  it('§4.6 (a): the `--plain` numbered pick is a selection surface too, so it gets the same gate as a readline y/N', () => {
    expect(confirmPlainPrompt('new')).toBe('start fresh? [y/N]');
    expect(confirmPlainPrompt('abort')).toBe('abort? [y/N]');
    expect(confirmPlainPrompt('exit')).toBe('leave? [y/N]');
  });
});
