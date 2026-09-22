/**
 * TUI-DESIGN §19.0: every cell of the §3.3 Ctrl-C / Esc / Ctrl-D matrix (S0–S7) and the S5 sub-rows with
 * injected clocks at the 1.5 s / 2 s / 800 ms boundaries; S4 empty → ABORT_REVIEW, S4 text → CLEAR_DRAFT.
 */
import { describe, expect, it } from 'vitest';
import {
  CTRL_C_WINDOW_MS,
  CTRL_D_WINDOW_MS,
  ESC_WINDOW_MS,
  interruptHint,
  reduceInterrupts,
  type InterruptAction,
  type InterruptKey,
} from '../../../../src/tui/keys/interrupts.js';
import { initialKeyState, type KeyState } from '../../../../src/tui/keys/resolve.js';

function st(o: Partial<KeyState> = {}, armed: Partial<KeyState['armed']> = {}): KeyState {
  const base = initialKeyState('session');
  return { ...base, ...o, armed: { ...base.armed, ...armed } };
}

const S0 = st();
const S1 = st({ draftEmpty: false });
const S2 = st({ run: 'live' });
const S2starting = st({ run: 'starting' });
const S3 = st({ run: 'live', draftEmpty: false });
const S4 = st({ run: 'live', overlay: 'review', reviewArmed: true });
const S4text = st({ run: 'live', overlay: 'review', reviewArmed: true, draftEmpty: false });
const S6 = st({ run: 'aborting' });
const S7 = st({ run: 'pausing' });

function act(s: KeyState, key: InterruptKey, now = 10_000): InterruptAction {
  return reduceInterrupts(s, key, now).action;
}

/** press twice with `gap` ms between */
function twice(s: KeyState, key: InterruptKey, gap: number): [InterruptAction, InterruptAction] {
  const a = reduceInterrupts(s, key, 10_000);
  const b = reduceInterrupts(a.state, key, 10_000 + gap);
  return [a.action, b.action];
}

describe('Ctrl-C column (TUI-DESIGN §3.3)', () => {
  it('S0 idle·empty: ×1 hints and arms 1.5 s; ×2 ≤ 1.5 s exits 0; a late second press hints again', () => {
    expect(act(S0, 'ctrl-c')).toBe('HINT_CTRL_C');
    expect(reduceInterrupts(S0, 'ctrl-c', 5).state.armed.ctrlCAt).toBe(5);
    expect(twice(S0, 'ctrl-c', CTRL_C_WINDOW_MS)).toEqual(['HINT_CTRL_C', 'EXIT_0']);
    expect(twice(S0, 'ctrl-c', CTRL_C_WINDOW_MS + 1)).toEqual(['HINT_CTRL_C', 'HINT_CTRL_C']);
  });
  it('S0 one-shot before the run: same as session', () => {
    const s = st({ mode: 'one-shot' });
    expect(twice(s, 'ctrl-c', 100)).toEqual(['HINT_CTRL_C', 'EXIT_0']);
  });
  it('S1 idle·text: clears the draft to history and arms nothing; ×2 is then S0 (hint)', () => {
    const a = reduceInterrupts(S1, 'ctrl-c', 10_000);
    expect(a.action).toBe('CLEAR_DRAFT');
    expect(a.state.armed.ctrlCAt).toBeNull();
    // after the clear the draft is empty → S0
    expect(act({ ...a.state, draftEmpty: true }, 'ctrl-c', 10_100)).toBe('HINT_CTRL_C');
  });
  it('S2 live·empty: one-shot → ABORT_EXIT_130; session → ABORT_STAY (no exit); `starting` counts as live', () => {
    expect(act({ ...S2, mode: 'one-shot' }, 'ctrl-c')).toBe('ABORT_EXIT_130');
    expect(act(S2, 'ctrl-c')).toBe('ABORT_STAY');
    expect(act(S2starting, 'ctrl-c')).toBe('ABORT_STAY');
    expect(act({ ...S2starting, mode: 'one-shot' }, 'ctrl-c')).toBe('ABORT_EXIT_130');
  });
  it('S3 live·text: clears the draft, never aborts with text present (F5)', () => {
    expect(act(S3, 'ctrl-c')).toBe('CLEAR_DRAFT');
    expect(act({ ...S3, mode: 'one-shot' }, 'ctrl-c')).toBe('CLEAR_DRAFT');
    expect(twice(S3, 'ctrl-c', 10)).toEqual(['CLEAR_DRAFT', 'CLEAR_DRAFT']);
  });
  it('S4 review, empty draft: ABORT_REVIEW only (engine.abort, never resolveDetailed)', () => {
    expect(act(S4, 'ctrl-c')).toBe('ABORT_REVIEW');
  });
  it('S4 review, draft typed during the deferral: CLEAR_DRAFT and the box stays (F5 precedence)', () => {
    expect(act(S4text, 'ctrl-c')).toBe('CLEAR_DRAFT');
  });
  it('S4 not yet armed (deferral): Ctrl-C keeps its live-run meaning', () => {
    expect(act(st({ run: 'live', overlay: 'review', reviewArmed: false }), 'ctrl-c')).toBe('ABORT_STAY');
    expect(act(st({ run: 'live', overlay: 'review', reviewArmed: false, mode: 'one-shot' }), 'ctrl-c')).toBe('ABORT_EXIT_130');
  });
  it('S6 aborting: every Ctrl-C is process.exit(130) — never a hint, draft or not, in both modes', () => {
    expect(act(S6, 'ctrl-c')).toBe('EXIT_NOW_130');
    expect(act({ ...S6, draftEmpty: false }, 'ctrl-c')).toBe('EXIT_NOW_130');
    expect(act({ ...S6, mode: 'one-shot' }, 'ctrl-c')).toBe('EXIT_NOW_130');
    expect(twice(S6, 'ctrl-c', 1)).toEqual(['EXIT_NOW_130', 'EXIT_NOW_130']);
  });
  it('S7 pausing: abort now → S6 (session stays, one-shot exits 130)', () => {
    expect(act(S7, 'ctrl-c')).toBe('ABORT_STAY');
    expect(act({ ...S7, mode: 'one-shot' }, 'ctrl-c')).toBe('ABORT_EXIT_130');
    expect(act({ ...S7, draftEmpty: false }, 'ctrl-c')).toBe('CLEAR_DRAFT');
  });
});

describe('Esc column (TUI-DESIGN §3.3)', () => {
  it('S0: ×1 no-op and arms; ×2 ≤ 2 s opens the rewind/steer menu; > 2 s is a no-op that re-arms', () => {
    const a = reduceInterrupts(S0, 'esc', 1000);
    expect(a.action).toBe('NONE');
    expect(a.state.armed.escAt).toBe(1000);
    expect(twice(S0, 'esc', ESC_WINDOW_MS)).toEqual(['NONE', 'OPEN_REWIND_MENU']);
    expect(twice(S0, 'esc', ESC_WINDOW_MS + 1)).toEqual(['NONE', 'NONE']);
  });
  it('S1: ×1 arms with the hint; ×2 ≤ 2 s clears the draft', () => {
    expect(twice(S1, 'esc', 1999)).toEqual(['HINT_ESC', 'CLEAR_DRAFT']);
    expect(twice(S1, 'esc', 2001)).toEqual(['HINT_ESC', 'HINT_ESC']);
  });
  it('S2: ×1 pauses (→ S7) with the hint; ×2 ≤ 2 s aborts', () => {
    const a = reduceInterrupts(S2, 'esc', 0);
    expect(a.action).toBe('PAUSE');
    // the controller moves run → 'pausing' (S7); the second Esc within 2 s aborts
    expect(act({ ...a.state, run: 'pausing' }, 'esc', ESC_WINDOW_MS)).toBe('ABORT');
    expect(act({ ...a.state, run: 'pausing' }, 'esc', ESC_WINDOW_MS + 1)).toBe('NONE');
    // even if the phase did not change yet, a second Esc within 2 s aborts
    expect(twice(S2, 'esc', 500)).toEqual(['PAUSE', 'ABORT']);
  });
  it('S3: arms; ×2 clears the draft (never pauses with text present)', () => {
    expect(twice(S3, 'esc', 100)).toEqual(['HINT_ESC', 'CLEAR_DRAFT']);
  });
  it('S4 review: declines (armed or not, Esc under a visible review is decline)', () => {
    expect(act(S4, 'esc')).toBe('DECLINE');
    expect(act(S4text, 'esc')).toBe('DECLINE');
  });
  it('S6 aborting: no-op', () => {
    expect(act(S6, 'esc')).toBe('NONE');
    expect(twice(S6, 'esc', 10)).toEqual(['NONE', 'NONE']);
  });
  it('S7 pausing: ×1 no-op, ×2 ≤ 2 s aborts → S6', () => {
    expect(twice(S7, 'esc', 1500)).toEqual(['NONE', 'ABORT']);
  });
});

describe('Ctrl-D column (TUI-DESIGN §3.3)', () => {
  it('S0: hint + arm 800 ms; second press ≤ 800 ms exits 0', () => {
    expect(twice(S0, 'ctrl-d', CTRL_D_WINDOW_MS)).toEqual(['HINT_CTRL_D', 'EXIT_0']);
    expect(twice(S0, 'ctrl-d', CTRL_D_WINDOW_MS + 1)).toEqual(['HINT_CTRL_D', 'HINT_CTRL_D']);
  });
  it('S1 / S3: delete-forward, never an exit', () => {
    expect(act(S1, 'ctrl-d')).toBe('DELETE_FORWARD');
    expect(act(S3, 'ctrl-d')).toBe('DELETE_FORWARD');
    expect(twice(S1, 'ctrl-d', 1)).toEqual(['DELETE_FORWARD', 'DELETE_FORWARD']);
  });
  it('S2: hint `run is live — Ctrl-D again to choose`; second press ≤ 800 ms opens the exitConfirm overlay', () => {
    const a = reduceInterrupts(S2, 'ctrl-d', 0);
    expect(a.action).toBe('HINT_CTRL_D');
    expect(interruptHint(a.action, S2)).toBe('run is live — Ctrl-D again to choose');
    expect(act(a.state, 'ctrl-d', 800)).toBe('OPEN_EXIT_CONFIRM');
    expect(act(a.state, 'ctrl-d', 801)).toBe('HINT_CTRL_D');
  });
  it('S4 / S6: ignored; S7: as S2', () => {
    expect(act(S4, 'ctrl-d')).toBe('NONE');
    expect(act(S6, 'ctrl-d')).toBe('NONE');
    expect(twice(S7, 'ctrl-d', 100)).toEqual(['HINT_CTRL_D', 'OPEN_EXIT_CONFIRM']);
  });
});

describe('S5 sub-rows (TUI-DESIGN §3.3)', () => {
  const live = (overlay: KeyState['overlay'], o: Partial<KeyState> = {}): KeyState => st({ run: 'live', overlay, ...o });
  it('palette: Ctrl-C close (draft kept), Esc close, Ctrl-D close', () => {
    const s = live('palette', { draftEmpty: false });
    expect(act(s, 'ctrl-c')).toBe('CLOSE_OVERLAY');
    expect(act(s, 'esc')).toBe('CLOSE_OVERLAY');
    expect(act(s, 'ctrl-d')).toBe('CLOSE_OVERLAY');
    expect(act(st({ overlay: 'palette' }), 'ctrl-c')).toBe('CLOSE_OVERLAY');
  });
  it('TUI-DESIGN-4 §4.7 E12: the palette + a token-only draft is CLOSE_OVERLAY_AND_CLEAR; with an argument it stays CLOSE_OVERLAY; Ctrl-C twice still exits 0', () => {
    // the measured trap: `/zz` then Ctrl-C left the card gone, the draft `/zz` still in the composer and no
    // placeholder — half the reason the audit could not get back to a clean prompt
    const tokenOnly = st({ overlay: 'palette', draftEmpty: false, draftTokenOnly: true });
    expect(act(tokenOnly, 'ctrl-c')).toBe('CLOSE_OVERLAY_AND_CLEAR');
    expect(act(st({ run: 'live', overlay: 'palette', draftEmpty: false, draftTokenOnly: true }), 'ctrl-c')).toBe('CLOSE_OVERLAY_AND_CLEAR');
    // a draft with an argument (`/budget 5`) keeps today's behaviour: there is something worth keeping
    expect(act(st({ overlay: 'palette', draftEmpty: false, draftTokenOnly: false }), 'ctrl-c')).toBe('CLOSE_OVERLAY');
    // Esc and Ctrl-D are UNCHANGED in both shapes (E13: Esc keeps the draft and remembers the token)
    for (const key of ['esc', 'ctrl-d'] as const) expect(act(tokenOnly, key), key).toBe('CLOSE_OVERLAY');
    // the flag is absent by default, so the rule is inert until the controller supplies it
    expect(act(st({ overlay: 'palette', draftEmpty: false }), 'ctrl-c')).toBe('CLOSE_OVERLAY');
    // Ctrl-C twice still exits 0: the first press closed the overlay and cleared, the second is S0 (hint), the third exits
    const one = reduceInterrupts(tokenOnly, 'ctrl-c', 10_000);
    expect(one.action).toBe('CLOSE_OVERLAY_AND_CLEAR');
    const two = reduceInterrupts({ ...one.state, overlay: 'none', draftEmpty: true, draftTokenOnly: false }, 'ctrl-c', 10_100);
    expect(two.action).toBe('HINT_CTRL_C');
    expect(reduceInterrupts(two.state, 'ctrl-c', 10_200).action).toBe('EXIT_0');
  });
  it('secret gate: Ctrl-C cancels the send and clears the draft; Esc / Ctrl-D dismiss (draft kept)', () => {
    const s = live('secret', { draftEmpty: false });
    expect(act(s, 'ctrl-c')).toBe('CLEAR_DRAFT');
    expect(act(s, 'esc')).toBe('CLOSE_OVERLAY');
    expect(act(s, 'ctrl-d')).toBe('CLOSE_OVERLAY');
  });
  it('follow-up confirm: Ctrl-C cancel (draft kept), Esc cancel, Ctrl-D ignored', () => {
    const s = st({ overlay: 'followup', draftEmpty: false });
    expect(act(s, 'ctrl-c')).toBe('CLOSE_OVERLAY');
    expect(act(s, 'esc')).toBe('CLOSE_OVERLAY');
    expect(act(s, 'ctrl-d')).toBe('NONE');
  });
  it('undo prompt: Ctrl-C / Esc abort the undo; Ctrl-D ignored', () => {
    const s = st({ overlay: 'undo' });
    expect(act(s, 'ctrl-c')).toBe('CLOSE_OVERLAY');
    expect(act(s, 'esc')).toBe('CLOSE_OVERLAY');
    expect(act(s, 'ctrl-d')).toBe('NONE');
  });
  it('exitConfirm: Ctrl-C = [n] stay, Esc stay, Ctrl-D ignored', () => {
    const s = live('exitConfirm');
    expect(act(s, 'ctrl-c')).toBe('CLOSE_OVERLAY');
    expect(act(s, 'esc')).toBe('CLOSE_OVERLAY');
    expect(act(s, 'ctrl-d')).toBe('NONE');
  });
  it('wizard: Ctrl-C exits 2 only when no run exists; mid-run /login closes the wizard; Esc / Ctrl-D are its own', () => {
    expect(act(st({ overlay: 'wizard' }), 'ctrl-c')).toBe('WIZARD_EXIT_2');
    expect(act(live('wizard'), 'ctrl-c')).toBe('CLOSE_OVERLAY');
    expect(act(st({ overlay: 'wizard', run: 'starting' }), 'ctrl-c')).toBe('CLOSE_OVERLAY');
    expect(act(st({ overlay: 'wizard' }), 'esc')).toBe('NONE');
    expect(act(st({ overlay: 'wizard' }), 'ctrl-d')).toBe('NONE');
  });
  it('blocking pane: Ctrl-C = that pane’s [q]; Esc no-op; Ctrl-D ignored', () => {
    const s = live('blocking');
    expect(act(s, 'ctrl-c')).toBe('PANE_Q');
    expect(act(s, 'esc')).toBe('NONE');
    expect(act(s, 'ctrl-d')).toBe('NONE');
  });
  it('an S5 overlay while aborting: Ctrl-C still exits 130 at once', () => {
    expect(act(st({ run: 'aborting', overlay: 'blocking' }), 'ctrl-c')).toBe('EXIT_NOW_130');
  });
});

describe('arm bookkeeping', () => {
  it('`other` clears all three arms and is otherwise NONE', () => {
    const s = st({}, { ctrlCAt: 1, escAt: 2, ctrlDAt: 3, escBufferAt: 4, chord: { first: 'w', at: 5 } });
    const r = reduceInterrupts(s, 'other', 10);
    expect(r.action).toBe('NONE');
    expect(r.state.armed).toEqual({ ctrlCAt: null, escAt: null, ctrlDAt: null, escBufferAt: 4, chord: { first: 'w', at: 5 } });
  });
  it('a press of one key disarms the other two (Ctrl-C after Esc is not Esc ×2)', () => {
    const a = reduceInterrupts(S0, 'esc', 0);
    const b = reduceInterrupts(a.state, 'ctrl-c', 10);
    expect(b.state.armed.escAt).toBeNull();
    expect(act(b.state, 'esc', 20)).toBe('NONE');
  });
  it('never mutates its input', () => {
    const s = st();
    const frozen = JSON.stringify(s);
    reduceInterrupts(s, 'ctrl-c', 1);
    reduceInterrupts(s, 'esc', 1);
    reduceInterrupts(s, 'ctrl-d', 1);
    expect(JSON.stringify(s)).toBe(frozen);
  });
  it('a clock that goes backwards or is not finite never counts as "within the window"', () => {
    const a = reduceInterrupts(S0, 'ctrl-c', 10_000);
    expect(act(a.state, 'ctrl-c', 9_000)).toBe('HINT_CTRL_C');
    expect(act(a.state, 'ctrl-c', Number.NaN)).toBe('HINT_CTRL_C');
    expect(act(a.state, 'ctrl-c', Number.POSITIVE_INFINITY)).toBe('HINT_CTRL_C');
  });
  it('hint texts are the §24 strings', () => {
    expect(interruptHint('HINT_CTRL_C', S0)).toBe('press Ctrl-C again to exit');
    expect(interruptHint('HINT_CTRL_D', S0)).toBe('press Ctrl-D again to exit');
    expect(interruptHint('HINT_CTRL_D', S2)).toBe('run is live — Ctrl-D again to choose');
    expect(interruptHint('HINT_ESC', S1)).toBe('Esc again clears the draft');
    expect(interruptHint('PAUSE', S2)).toBe('Esc again aborts the run');
    expect(interruptHint('EXIT_0', S0)).toBeNull();
  });
});

describe('the whole matrix as one table (row = key, column = state)', () => {
  const states: Record<string, KeyState> = { S0, S1, S2, S3, S4, S6, S7 };
  const expected: Record<InterruptKey, Record<string, InterruptAction>> = {
    'ctrl-c': { S0: 'HINT_CTRL_C', S1: 'CLEAR_DRAFT', S2: 'ABORT_STAY', S3: 'CLEAR_DRAFT', S4: 'ABORT_REVIEW', S6: 'EXIT_NOW_130', S7: 'ABORT_STAY' },
    esc: { S0: 'NONE', S1: 'HINT_ESC', S2: 'PAUSE', S3: 'HINT_ESC', S4: 'DECLINE', S6: 'NONE', S7: 'NONE' },
    'ctrl-d': { S0: 'HINT_CTRL_D', S1: 'DELETE_FORWARD', S2: 'HINT_CTRL_D', S3: 'DELETE_FORWARD', S4: 'NONE', S6: 'NONE', S7: 'HINT_CTRL_D' },
    other: { S0: 'NONE', S1: 'NONE', S2: 'NONE', S3: 'NONE', S4: 'NONE', S6: 'NONE', S7: 'NONE' },
  };
  const cases = (Object.keys(expected) as InterruptKey[]).flatMap((key) => Object.keys(states).map((name) => ({ key, name })));
  it.each(cases)('$key ×1 in $name', ({ key, name }) => {
    expect(act(states[name] as KeyState, key)).toBe(expected[key][name]);
  });
});
