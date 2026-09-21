/**
 * The Ctrl-C / Esc / Ctrl-D reducer (TUI-DESIGN §3.3, D2, F5): pure over `(state, key, nowMs)`; the
 * states are S0 idle·empty, S1 idle·text, S2 live·empty, S3 live·text, S4 review armed, S5 other
 * overlay (per-overlay sub-rows), S6 aborting, S7 pausing. Windows: Ctrl-C 1.5 s, Esc Esc 2 s, Ctrl-D
 * 800 ms. F5 precedence: the draft rule outranks the review rule (Ctrl-C with a draft under a visible
 * review clears the draft and leaves the box; only an empty-draft Ctrl-C aborts).
 */
import type { KeyState } from './resolve.js';

/** TUI-DESIGN §3.3: Ctrl-C ×2 window. */
export const CTRL_C_WINDOW_MS = 1500;
/** TUI-DESIGN §3.3: Esc Esc window. */
export const ESC_WINDOW_MS = 2000;
/** TUI-DESIGN §3.3: Ctrl-D ×2 window. */
export const CTRL_D_WINDOW_MS = 800;
/** TUI-DESIGN §3.3: a lone Esc waits this long for a Meta chord's second byte (07 §1.5). */
export const ESC_REBUFFER_MS = 30;

/** TUI-DESIGN §3.3: the three arm timestamps (ms; null = not armed). */
export interface Interrupt {
  ctrlCAt: number | null;
  escAt: number | null;
  ctrlDAt: number | null;
}

/** TUI-DESIGN §3.3: what the controller executes for one interrupt key. */
export type InterruptAction =
  | 'HINT_CTRL_C'
  | 'EXIT_0'
  | 'ABORT_STAY'
  | 'ABORT_EXIT_130'
  | 'EXIT_NOW_130'
  | 'CLEAR_DRAFT'
  | 'ABORT_REVIEW'
  | 'DECLINE'
  | 'PAUSE'
  | 'ABORT'
  | 'OPEN_REWIND_MENU'
  | 'HINT_ESC'
  | 'HINT_CTRL_D'
  | 'OPEN_EXIT_CONFIRM'
  | 'DELETE_FORWARD'
  | 'CLOSE_OVERLAY'
  | 'PANE_Q'
  | 'WIZARD_EXIT_2'
  | 'NONE';

/** TUI-DESIGN §3.3: the key classes the reducer distinguishes. */
export type InterruptKey = 'ctrl-c' | 'esc' | 'ctrl-d' | 'other';

/** TUI-DESIGN §3.3: true while a run exists and is not finished (S2/S3/S6/S7 and `starting`). */
export function isLive(s: KeyState): boolean {
  return s.run !== 'none';
}

/** TUI-DESIGN §3.3 S4: the review box is drawn and armed, so its keys own the input. */
export function isReviewArmed(s: KeyState): boolean {
  return s.overlay === 'review' && s.reviewArmed;
}

function within(at: number | null, now: number, windowMs: number): boolean {
  return at !== null && Number.isFinite(now) && now - at >= 0 && now - at <= windowMs;
}

function arm(s: KeyState, patch: Partial<KeyState['armed']>): KeyState {
  return { ...s, armed: { ...s.armed, ...patch } };
}

function disarm(s: KeyState): KeyState {
  return arm(s, { ctrlCAt: null, escAt: null, ctrlDAt: null });
}

function result(state: KeyState, action: InterruptAction): { state: KeyState; action: InterruptAction } {
  return { state, action };
}

/**
 * TUI-DESIGN §3.3 `reduceInterrupts` — every cell of the matrix and the S5 sub-rows:
 * ctrl-c: aborting → EXIT_NOW_130; S5 overlay → per its row (wizard: WIZARD_EXIT_2 when no run exists, else
 * CLOSE_OVERLAY; blocking → PANE_Q; secret gate → CLEAR_DRAFT, which also cancels the send; palette /
 * follow-up / undo / exitConfirm → CLOSE_OVERLAY); text → CLEAR_DRAFT (also under a visible review);
 * review && draftEmpty → ABORT_REVIEW; live && one-shot → ABORT_EXIT_130; live && session → ABORT_STAY;
 * idle → armed ≤ 1.5 s ? EXIT_0 : HINT_CTRL_C (arm).
 * esc: S5 overlay → CLOSE_OVERLAY (blocking and wizard: NONE — the wizard's Esc is its own back/clear action);
 * review → DECLINE; text → armed ≤ 2 s ? CLEAR_DRAFT : HINT_ESC (arm); live → armed ≤ 2 s ? ABORT : PAUSE
 * (arm; pausing: NONE, aborting: NONE); idle → armed ≤ 2 s ? OPEN_REWIND_MENU : NONE (arm).
 * ctrl-d: S5 palette/secret → CLOSE_OVERLAY, others NONE; review → NONE; text → DELETE_FORWARD; live → armed
 * ≤ 800 ms ? OPEN_EXIT_CONFIRM : HINT_CTRL_D (arm); idle → armed ≤ 800 ms ? EXIT_0 : HINT_CTRL_D (arm).
 * other: clears all three arms.
 */
export function reduceInterrupts(s: KeyState, key: InterruptKey, now: number): { state: KeyState; action: InterruptAction } {
  if (key === 'other') return result(disarm(s), 'NONE');
  const overlay = s.overlay;
  const otherOverlay = overlay !== 'none' && overlay !== 'review';
  const review = isReviewArmed(s);
  const live = isLive(s);

  if (key === 'ctrl-c') {
    if (s.run === 'aborting') return result(s, 'EXIT_NOW_130');
    if (otherOverlay) {
      switch (overlay) {
        case 'wizard':
          return result(disarm(s), s.run === 'none' ? 'WIZARD_EXIT_2' : 'CLOSE_OVERLAY');
        case 'blocking':
          return result(disarm(s), 'PANE_Q');
        case 'secret':
          return result(disarm(s), 'CLEAR_DRAFT');
        default:
          return result(disarm(s), 'CLOSE_OVERLAY');
      }
    }
    if (!s.draftEmpty) return result(disarm(s), 'CLEAR_DRAFT'); // F5: the text rule outranks the review rule
    if (review) return result(disarm(s), 'ABORT_REVIEW');
    if (live) {
      if (s.mode === 'one-shot') return result(disarm(s), 'ABORT_EXIT_130');
      return result(arm(disarm(s), { ctrlCAt: now }), 'ABORT_STAY');
    }
    if (within(s.armed.ctrlCAt, now, CTRL_C_WINDOW_MS)) return result(disarm(s), 'EXIT_0');
    return result(arm(disarm(s), { ctrlCAt: now }), 'HINT_CTRL_C');
  }

  if (key === 'esc') {
    if (otherOverlay) {
      if (overlay === 'blocking' || overlay === 'wizard') return result(disarm(s), 'NONE');
      return result(disarm(s), 'CLOSE_OVERLAY');
    }
    if (review) return result(disarm(s), 'DECLINE');
    if (s.run === 'aborting') return result(disarm(s), 'NONE');
    const armed = within(s.armed.escAt, now, ESC_WINDOW_MS);
    if (!s.draftEmpty) {
      if (armed) return result(disarm(s), 'CLEAR_DRAFT');
      return result(arm(disarm(s), { escAt: now }), 'HINT_ESC');
    }
    if (live) {
      if (armed) return result(disarm(s), 'ABORT');
      if (s.run === 'pausing') return result(arm(disarm(s), { escAt: now }), 'NONE');
      return result(arm(disarm(s), { escAt: now }), 'PAUSE');
    }
    if (armed) return result(disarm(s), 'OPEN_REWIND_MENU');
    return result(arm(disarm(s), { escAt: now }), 'NONE');
  }

  // ctrl-d
  if (otherOverlay) {
    if (overlay === 'palette' || overlay === 'secret') return result(disarm(s), 'CLOSE_OVERLAY');
    return result(disarm(s), 'NONE');
  }
  if (review) return result(disarm(s), 'NONE');
  if (s.run === 'aborting') return result(disarm(s), 'NONE');
  if (!s.draftEmpty) return result(disarm(s), 'DELETE_FORWARD');
  const armedD = within(s.armed.ctrlDAt, now, CTRL_D_WINDOW_MS);
  if (live) {
    if (armedD) return result(disarm(s), 'OPEN_EXIT_CONFIRM');
    return result(arm(disarm(s), { ctrlDAt: now }), 'HINT_CTRL_D');
  }
  if (armedD) return result(disarm(s), 'EXIT_0');
  return result(arm(disarm(s), { ctrlDAt: now }), 'HINT_CTRL_D');
}

/** TUI-DESIGN §3.4: a two-key chord (and the picker's `x` then `y`) completes within this window. */
export const CHORD_WINDOW_MS = 3000;
/** TUI-DESIGN §6.2: `w` then a digit 1–5 within this window appends the /why block. */
export const WHY_WINDOW_MS = 1500;

/**
 * TUI-DESIGN §3.3 / §24: the 2 s toast text for a hint action in the given state, or null when the
 * action is not a hint (Ctrl-C/Ctrl-D hints become `<Static>` items only when the second press follows).
 */
export function interruptHint(action: InterruptAction, s: KeyState): string | null {
  switch (action) {
    case 'HINT_CTRL_C':
      return 'press Ctrl-C again to exit';
    case 'HINT_CTRL_D':
      return isLive(s) ? 'run is live — Ctrl-D again to choose' : 'press Ctrl-D again to exit';
    case 'HINT_ESC':
      return 'Esc again clears the draft';
    case 'PAUSE':
      return 'Esc again aborts the run';
    default:
      return null;
  }
}
