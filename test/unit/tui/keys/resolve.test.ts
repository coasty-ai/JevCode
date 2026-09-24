/**
 * TUI-DESIGN §19.0: `resolveKey` over the §3.1 contexts and the §3.3 cells with injected clocks —
 * the Esc re-buffer (30 ms; a bracketed paste never completes a Meta chord), S4 empty → ABORT_REVIEW /
 * S4 text → CLEAR_DRAFT, S7 pausing (Enter with text submits, printable inserts), `d p t s` insert text,
 * every overlay's sub-row, the picker, history search, minsize, chords in every context (arm, fire ≤ 3 s,
 * expire, miss), Ctrl+Z / Ctrl+L in every context, and filtered input.
 */
import { describe, expect, it } from 'vitest';
import { buildBindings } from '../../../../src/tui/keys/bindings.js';
import { CHORD_WINDOW_MS, ESC_REBUFFER_MS, WHY_WINDOW_MS } from '../../../../src/tui/keys/interrupts.js';
import { DELETE_ARM, MOUSE_RE, REVIEW_PENDING_TOAST, WHY_ARM, initialKeyState, isPrintable, keyString, resolveKey, type KeyAction, type KeyEvent, type KeyFlags, type KeyState } from '../../../../src/tui/keys/resolve.js';

const FLAGS: KeyFlags = { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false };

/** build an event from a canonical-ish key description as Ink would deliver it */
function k(desc: string, extra: Partial<KeyEvent> = {}): KeyEvent {
  const parts = desc.split('+');
  const base = parts.pop() as string;
  const flags: KeyFlags = { ...FLAGS };
  for (const m of parts) {
    if (m === 'ctrl') flags.ctrl = true;
    else if (m === 'meta') flags.meta = true;
    else if (m === 'shift') flags.shift = true;
  }
  let input = '';
  switch (base) {
    case 'up': flags.upArrow = true; break;
    case 'down': flags.downArrow = true; break;
    case 'left': flags.leftArrow = true; break;
    case 'right': flags.rightArrow = true; break;
    case 'home': flags.home = true; break;
    case 'end': flags.end = true; break;
    case 'pageup': flags.pageUp = true; break;
    case 'pagedown': flags.pageDown = true; break;
    case 'return': flags.return = true; input = flags.meta || flags.shift ? '' : '\r'; break;
    case 'escape': flags.escape = true; break;
    case 'tab': flags.tab = true; break;
    case 'backspace': flags.backspace = true; break;
    case 'delete': flags.delete = true; break;
    case 'space': input = ' '; break;
    case 'f1': return { input: '', key: flags, name: 'f1', ...extra };
    default: input = base;
  }
  return { input, key: flags, ...extra };
}
const text = (s: string): KeyEvent => ({ input: s, key: { ...FLAGS } });
const paste = (s: string): KeyEvent => ({ input: s, key: { ...FLAGS }, paste: true });
const ESC_EXPIRED: KeyEvent = { input: '', key: { ...FLAGS, escape: true }, escExpired: true };

function st(o: Partial<KeyState> = {}, armed: Partial<KeyState['armed']> = {}): KeyState {
  const base = initialKeyState('session');
  return { ...base, ...o, armed: { ...base.armed, ...armed } };
}
/** actions without the bookkeeping `arm` entry */
function acts(s: KeyState, e: KeyEvent, now = 10_000, b = buildBindings()): KeyAction[] {
  return resolveKey(s, e, now, b).filter((a) => a.type !== 'arm');
}
function armOf(s: KeyState, e: KeyEvent, now = 10_000): KeyState['armed'] {
  const a = resolveKey(s, e, now).find((x) => x.type === 'arm');
  return a?.type === 'arm' ? a.armed : s.armed;
}
/** apply the returned arm to the state so a follow-up key sees it */
function after(s: KeyState, e: KeyEvent, now: number): KeyState {
  return { ...s, armed: armOf(s, e, now) };
}

const idle = st();
const idleText = st({ draftEmpty: false, cursorRow: 'mid' });
const live = st({ run: 'live' });
const liveText = st({ run: 'live', draftEmpty: false, cursorRow: 'mid' });
const review = st({ run: 'live', overlay: 'review', reviewArmed: true });

describe('composer context: text and the five bound printables (TUI-DESIGN §3.1)', () => {
  it('d p t s insert text on an empty composer (they are never keys)', () => {
    for (const ch of ['d', 'p', 't', 's', 'y', 'n', 'e', 'w', 'x', 'q', 'r']) expect(acts(idle, text(ch))).toEqual([{ type: 'insert', text: ch }]);
  });
  it('only [ ] / @ ? are bound on an empty composer', () => {
    expect(acts(idle, text('/'))).toEqual([{ type: 'insert', text: '/' }, { type: 'openPalette' }]);
    expect(acts(idle, text('@'))).toEqual([{ type: 'insert', text: '@' }, { type: 'openMention' }]);
    expect(acts(idle, text('?'))).toEqual([{ type: 'help' }]);
    expect(acts(idle, text(']'))).toEqual([{ type: 'paneTab', dir: 1 }]);
    expect(acts(idle, text('['))).toEqual([{ type: 'paneTab', dir: -1 }]);
  });
  it('with text present / ? [ ] insert; @ still opens the mention popup (anywhere)', () => {
    expect(acts(idleText, text('/'))).toEqual([{ type: 'insert', text: '/' }]);
    expect(acts(idleText, text('?'))).toEqual([{ type: 'insert', text: '?' }]);
    expect(acts(idleText, text('['))).toEqual([{ type: 'insert', text: '[' }]);
    expect(acts(idleText, text(']'))).toEqual([{ type: 'insert', text: ']' }]);
    expect(acts(idleText, text('@'))).toEqual([{ type: 'insert', text: '@' }, { type: 'openMention' }]);
  });
  it('unicode: a single grapheme of several code points inserts; several graphemes in one chunk are a paste (IME commit stays text)', () => {
    expect(acts(idle, text('👨‍👩‍👧'))).toEqual([{ type: 'insert', text: '👨‍👩‍👧' }]);
    expect(acts(idle, text('é'))).toEqual([{ type: 'insert', text: 'é' }]);
    expect(acts(idle, text('日'))).toEqual([{ type: 'insert', text: '日' }]);
    expect(acts(idle, text('hello world'))).toEqual([{ type: 'paste', text: 'hello world' }]);
    expect(acts(idle, paste('a\nb'))).toEqual([{ type: 'paste', text: 'a\nb' }]);
  });
  it('CSI / OSC leak-through is filtered, never inserted (§4.4)', () => {
    for (const leak of ['[I', '[O', '[24;80R', '[27;2;14~', '[?0u', '[?62;22c', '[<64;10;5M', ']11;rgb:0000/0000/0000']) {
      expect(acts(idle, text(leak))[0]?.type, leak).toBe('filtered');
    }
    // an OSC string terminator ESC \ reaches Ink as meta+\ (unbound → filtered); a typed backslash is text (needed for \ + Enter)
    expect(acts(idle, k('meta+\\'))[0]?.type).toBe('filtered');
    expect(acts(idle, text('\\'))).toEqual([{ type: 'insert', text: '\\' }]);
  });
  it('drops kitty release/repeat events and super/hyper chords', () => {
    expect(resolveKey(idle, { ...text('a'), key: { ...FLAGS, eventType: 'release' } }, 0)).toEqual([{ type: 'filtered', reason: 'event-type' }]);
    expect(resolveKey(idle, { ...text('a'), key: { ...FLAGS, eventType: 'repeat' } }, 0)).toEqual([{ type: 'filtered', reason: 'event-type' }]);
    expect(acts(idle, { input: 'a', key: { ...FLAGS, super: true } })[0]?.type).toBe('filtered');
    expect(acts(idle, k('ctrl+q'))[0]?.type).toBe('filtered');
  });
  it('Enter: empty draft → no-op; text → submit (routing decides steer vs task); newline keys insert a newline', () => {
    expect(acts(idle, k('return'))).toEqual([]);
    expect(acts(idleText, k('return'))).toEqual([{ type: 'submit' }]);
    expect(acts(liveText, k('return'))).toEqual([{ type: 'submit' }]);
    expect(acts(live, k('return'))).toEqual([]);
    expect(acts(idleText, text('\n'))).toEqual([{ type: 'newline' }]);
    expect(acts(idleText, k('meta+return'))).toEqual([{ type: 'newline' }]);
    expect(acts(idleText, k('shift+return'))).toEqual([{ type: 'newline' }]);
    expect(acts(idleText, text('[27;2;13~'))).toEqual([{ type: 'newline' }]);
    expect(acts(idleText, text('[27;5;13~'))).toEqual([{ type: 'newline' }]);
  });
  it('the readline set maps to buffer actions', () => {
    const s = idleText;
    expect(acts(s, k('ctrl+a'))).toEqual([{ type: 'move', to: 'home' }]);
    expect(acts(s, k('home'))).toEqual([{ type: 'move', to: 'home' }]);
    expect(acts(s, k('ctrl+e'))).toEqual([{ type: 'move', to: 'end' }]);
    expect(acts(s, k('ctrl+b'))).toEqual([{ type: 'move', to: 'left' }]);
    expect(acts(s, k('right'))).toEqual([{ type: 'move', to: 'right' }]);
    expect(acts(s, k('meta+b'))).toEqual([{ type: 'move', to: 'wordLeft' }]);
    expect(acts(s, k('ctrl+right'))).toEqual([{ type: 'move', to: 'wordRight' }]);
    expect(acts(s, k('ctrl+k'))).toEqual([{ type: 'kill', what: 'toEnd' }]);
    expect(acts(s, k('ctrl+u'))).toEqual([{ type: 'kill', what: 'toStart' }]);
    expect(acts(s, k('ctrl+w'))).toEqual([{ type: 'kill', what: 'wordBack' }]);
    expect(acts(s, k('meta+backspace'))).toEqual([{ type: 'kill', what: 'wordBack' }]);
    expect(acts(s, k('meta+delete'))).toEqual([{ type: 'kill', what: 'wordForward' }]);
    expect(acts(s, k('ctrl+delete'))).toEqual([{ type: 'kill', what: 'wordForward' }]);
    // TUI-DESIGN-2 §4.6: Alt+D/P/T/S open a panel tab, Alt+J toggles, Alt+Shift+J opens it full (Alt+D left kill-word-forward)
    expect(acts(s, k('meta+d'))).toEqual([{ type: 'panel', op: 'tab', tab: 'd' }]);
    expect(acts(s, k('meta+p'))).toEqual([{ type: 'panel', op: 'tab', tab: 'p' }]);
    expect(acts(s, k('meta+t'))).toEqual([{ type: 'panel', op: 'tab', tab: 't' }]);
    expect(acts(s, k('meta+s'))).toEqual([{ type: 'panel', op: 'tab', tab: 's' }]);
    expect(acts(s, k('meta+j'))).toEqual([{ type: 'panel', op: 'toggle' }]);
    expect(acts(s, k('meta+shift+j'))).toEqual([{ type: 'panel', op: 'full' }]);
    expect(acts(s, { input: 'J', key: { ...k('meta+j').key, shift: true } })).toEqual([{ type: 'panel', op: 'full' }]);
    expect(acts(s, k('ctrl+y'))).toEqual([{ type: 'yank' }]);
    expect(acts(s, k('meta+y'))).toEqual([{ type: 'yankPop' }]);
    expect(acts(s, k('ctrl+t'))).toEqual([{ type: 'transpose' }]);
    expect(acts(s, text('\u001f'))).toEqual([{ type: 'undo' }]);
    expect(acts(s, text('\u001e'))).toEqual([{ type: 'redo' }]);
    expect(acts(s, k('backspace'))).toEqual([{ type: 'backspace' }]);
    expect(acts(s, k('delete'))).toEqual([{ type: 'delete' }]);
    expect(acts(s, k('ctrl+d'))).toEqual([{ type: 'delete' }]);
    expect(acts(s, k('ctrl+p'))).toEqual([{ type: 'history', dir: -1 }]);
    expect(acts(s, k('ctrl+n'))).toEqual([{ type: 'history', dir: 1 }]);
    expect(acts(s, k('ctrl+r'))).toEqual([{ type: 'historySearch', op: 'open' }]);
    expect(acts(s, k('tab'))).toEqual([{ type: 'complete', dir: 1 }]);
    expect(acts(s, k('shift+tab'))).toEqual([{ type: 'complete', dir: -1 }]);
    expect(acts(s, k('ctrl+g'))).toEqual([{ type: 'editor' }]);
    expect(acts(s, k('ctrl+o'))).toEqual([{ type: 'detail' }]);
    expect(acts(s, k('ctrl+l'))).toEqual([{ type: 'repaint' }]);
    expect(acts(s, k('ctrl+z'))).toEqual([{ type: 'suspend' }]);
    expect(acts(s, text('\u001a'))).toEqual([{ type: 'suspend' }]);
    expect(acts(s, k('f1'))).toEqual([{ type: 'help' }]);
  });
  it('↑/↓: visual rows in the middle; history on the first/last row; unsteer on the first row with steers queued and an empty draft', () => {
    expect(acts(idleText, k('up'))).toEqual([{ type: 'move', to: 'up' }]);
    expect(acts(idleText, k('down'))).toEqual([{ type: 'move', to: 'down' }]);
    expect(acts(st({ draftEmpty: false, cursorRow: 'first' }), k('up'))).toEqual([{ type: 'history', dir: -1 }]);
    expect(acts(st({ draftEmpty: false, cursorRow: 'last' }), k('down'))).toEqual([{ type: 'history', dir: 1 }]);
    expect(acts(idle, k('up'))).toEqual([{ type: 'history', dir: -1 }]);
    expect(acts(idle, k('down'))).toEqual([{ type: 'history', dir: 1 }]);
    expect(acts(st({ run: 'live', queue: 2 }), k('up'))).toEqual([{ type: 'unsteer' }]);
    expect(acts(st({ run: 'live', queue: 2, draftEmpty: false, cursorRow: 'first' }), k('up'))).toEqual([{ type: 'history', dir: -1 }]);
  });
  it('a one-row draft (`cursorRow: only`) satisfies both history rules: Up recalls older, Down recalls newer; on a mid row both move (§4.6)', () => {
    const one = st({ draftEmpty: false, cursorRow: 'only' });
    expect(acts(one, k('up'))).toEqual([{ type: 'history', dir: -1 }]);
    expect(acts(one, k('down'))).toEqual([{ type: 'history', dir: 1 }]);
    expect(acts(st({ run: 'live', queue: 1, draftEmpty: false, cursorRow: 'only' }), k('up'))).toEqual([{ type: 'history', dir: -1 }]); // unsteer needs an empty draft
    expect(acts(st({ draftEmpty: false, cursorRow: 'mid' }), k('up'))).toEqual([{ type: 'move', to: 'up' }]);
  });
  it('`r` on an empty draft while the retry row is up is retryNow (§13.2); with a draft, without the row, shifted, pasted, or in another context it is text / its own key', () => {
    const retrying = st({ run: 'live', retrying: true });
    expect(acts(retrying, text('r'))).toEqual([{ type: 'retryNow' }]);
    expect(acts(retrying, text('r'), 10_000, buildBindings(new Map([['composer:killLine', ['none']]])))).toEqual([{ type: 'retryNow' }]);
    expect(acts(st({ run: 'live', retrying: true, draftEmpty: false, cursorRow: 'only' }), text('r'))).toEqual([{ type: 'insert', text: 'r' }]);
    expect(acts(st({ run: 'live' }), text('r'))).toEqual([{ type: 'insert', text: 'r' }]);
    expect(acts(retrying, text('R'))).toEqual([{ type: 'insert', text: 'R' }]);
    expect(acts(retrying, paste('r'))).toEqual([{ type: 'paste', text: 'r' }]);
    expect(acts(st({ run: 'live', retrying: true, picker: true }), text('r'))).toEqual([{ type: 'insert', text: 'r' }]); // the picker's filter (Ctrl-R is rename)
    expect(acts(st({ run: 'live', retrying: true, overlay: 'blocking' }), text('r'))).toEqual([{ type: 'blocking', key: 'r' }]);
    expect(acts(st({ run: 'live', retrying: true, historySearch: true }), text('r'))).toEqual([{ type: 'historySearch', op: 'query', text: 'r' }]);
    // the arms are cleared like any other key (it is "other" for §3.3)
    expect(acts({ ...retrying, armed: { ...retrying.armed, ctrlCAt: 9_000 } }, text('r'))).toEqual([{ type: 'retryNow' }]);
    expect(armOf({ ...retrying, armed: { ...retrying.armed, ctrlCAt: 9_000 } }, text('r')).ctrlCAt).toBeNull();
  });
  it('S6 aborting: printable, Enter and paste are ignored; Ctrl-C exits 130 at once', () => {
    const s = st({ run: 'aborting' });
    expect(acts(s, text('a'))).toEqual([]);
    expect(acts(s, k('return'))).toEqual([]);
    expect(acts(s, paste('x'))).toEqual([]);
    expect(acts(s, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'EXIT_NOW_130' }]);
  });
});

describe('interrupt keys through the resolver (TUI-DESIGN §3.3)', () => {
  it('Ctrl-C ×1 idle hints and arms; ×2 within 1.5 s exits; a printable in between disarms', () => {
    const first = resolveKey(idle, k('ctrl+c'), 1000);
    expect(first).toEqual([{ type: 'arm', armed: { ...idle.armed, ctrlCAt: 1000 } }, { type: 'interrupt', action: 'HINT_CTRL_C' }]);
    const armed = after(idle, k('ctrl+c'), 1000);
    expect(acts(armed, k('ctrl+c'), 2500)).toEqual([{ type: 'interrupt', action: 'EXIT_0' }]);
    expect(acts(armed, k('ctrl+c'), 2501)).toEqual([{ type: 'interrupt', action: 'HINT_CTRL_C' }]);
    const typed = after(armed, text('a'), 1100);
    expect(typed.armed.ctrlCAt).toBeNull();
    expect(acts(typed, k('ctrl+c'), 1200)).toEqual([{ type: 'interrupt', action: 'HINT_CTRL_C' }]);
    expect(acts({ ...typed, draftEmpty: false }, k('ctrl+c'), 1200)).toEqual([{ type: 'interrupt', action: 'CLEAR_DRAFT' }]);
  });
  it('S1/S3 Ctrl-C clears the draft; S2 Ctrl-C aborts and stays in session mode, exits 130 one-shot', () => {
    expect(acts(idleText, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'CLEAR_DRAFT' }]);
    expect(acts(liveText, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'CLEAR_DRAFT' }]);
    expect(acts(live, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'ABORT_STAY' }]);
    expect(acts({ ...live, mode: 'one-shot' }, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'ABORT_EXIT_130' }]);
  });
  it('Ctrl-D: empty idle hints then exits; live hints then opens exitConfirm; with text deletes forward', () => {
    const a = after(idle, k('ctrl+d'), 0);
    expect(acts(idle, k('ctrl+d'), 0)).toEqual([{ type: 'interrupt', action: 'HINT_CTRL_D' }]);
    expect(acts(a, k('ctrl+d'), 800)).toEqual([{ type: 'interrupt', action: 'EXIT_0' }]);
    const l = after(live, k('ctrl+d'), 0);
    expect(acts(l, k('ctrl+d'), 799)).toEqual([{ type: 'interrupt', action: 'OPEN_EXIT_CONFIRM' }]);
    expect(acts(l, k('ctrl+d'), 801)).toEqual([{ type: 'interrupt', action: 'HINT_CTRL_D' }]);
    expect(acts(idleText, k('ctrl+d'))).toEqual([{ type: 'delete' }]);
  });
});

describe('Esc re-buffer (TUI-DESIGN §3.3, 30 ms)', () => {
  it('a lone Esc arms the buffer and asks for the timer; nothing else fires', () => {
    expect(resolveKey(live, k('escape'), 5000)).toEqual([{ type: 'arm', armed: { ...live.armed, escBufferAt: 5000 } }, { type: 'escBuffer' }]);
  });
  it('a letter within 30 ms is the Meta chord (ESC b = word left); Enter within it is Alt+Enter = newline', () => {
    const buffered = after(liveText, k('escape'), 5000);
    expect(resolveKey(buffered, text('b'), 5000 + ESC_REBUFFER_MS)).toEqual([{ type: 'arm', armed: liveText.armed }, { type: 'move', to: 'wordLeft' }]);
    expect(acts(buffered, text('f'), 5010)).toEqual([{ type: 'move', to: 'wordRight' }]);
    expect(acts(buffered, text('d'), 5010)).toEqual([{ type: 'panel', op: 'tab', tab: 'd' }]); // ESC d = Alt+D = the decisions tab (TUI-DESIGN-2 §4.6)
    expect(acts(buffered, text('y'), 5010)).toEqual([{ type: 'yankPop' }]);
    expect(acts(buffered, k('return'), 5010)).toEqual([{ type: 'newline' }]);
    expect(acts(buffered, k('backspace'), 5010)).toEqual([{ type: 'kill', what: 'wordBack' }]);
  });
  it('on expiry the Esc action of the current state fires (live → PAUSE; text → HINT_ESC; idle → arm only)', () => {
    expect(acts(after(live, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'interrupt', action: 'PAUSE' }]);
    expect(acts(after(liveText, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'interrupt', action: 'HINT_ESC' }]);
    expect(acts(after(idle, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([]);
    const idleArmed = { ...idle, armed: armOf(after(idle, k('escape'), 0), ESC_EXPIRED, 31) };
    expect(idleArmed.armed.escAt).toBe(31);
    expect(idleArmed.armed.escBufferAt).toBeNull();
  });
  it('a stale expiry (buffer already consumed) does nothing', () => {
    expect(resolveKey(idle, ESC_EXPIRED, 100)).toEqual([]);
  });
  it('a key arriving after the window fires the pending Esc first, then itself', () => {
    const buffered = after(liveText, k('escape'), 0);
    expect(acts(buffered, text('b'), ESC_REBUFFER_MS + 1)).toEqual([{ type: 'interrupt', action: 'HINT_ESC' }, { type: 'insert', text: 'b' }]);
    // a non-chordable key inside the window also fires the Esc first (an arrow is its own key)
    expect(acts(buffered, k('up'), 10)).toEqual([{ type: 'interrupt', action: 'HINT_ESC' }, { type: 'move', to: 'up' }]);
  });
  it('Esc Esc: a second lone Esc fires the first, re-buffers, and the expiry completes the double press (clear / abort / menu)', () => {
    let s = after(liveText, k('escape'), 0);
    s = after(s, k('escape'), 40); // fires the first Esc (arms escAt) and buffers the second
    expect(s.armed.escAt).toBe(40);
    expect(s.armed.escBufferAt).toBe(40);
    expect(acts(s, ESC_EXPIRED, 71)).toEqual([{ type: 'interrupt', action: 'CLEAR_DRAFT' }]);
    let l = after(live, k('escape'), 0);
    l = after(l, ESC_EXPIRED, 31);
    expect(acts(l, ESC_EXPIRED, 62)).toEqual([]); // stale
    l = after(l, k('escape'), 500);
    expect(acts(l, ESC_EXPIRED, 531)).toEqual([{ type: 'interrupt', action: 'ABORT' }]);
    let i = after(idle, k('escape'), 0);
    i = after(i, ESC_EXPIRED, 31);
    i = after(i, k('escape'), 800);
    expect(acts(i, ESC_EXPIRED, 831)).toEqual([{ type: 'interrupt', action: 'OPEN_REWIND_MENU' }]);
  });
  it('`escape && meta` (ESC ESC in one chunk) is Esc ×2 at once', () => {
    expect(acts(liveText, k('meta+escape'))).toEqual([{ type: 'interrupt', action: 'HINT_ESC' }, { type: 'interrupt', action: 'CLEAR_DRAFT' }]);
    expect(acts(live, k('meta+escape'))).toEqual([{ type: 'interrupt', action: 'PAUSE' }, { type: 'interrupt', action: 'ABORT' }]);
    expect(acts(idle, k('meta+escape'))).toEqual([{ type: 'interrupt', action: 'OPEN_REWIND_MENU' }]);
  });
  it('Esc Esc within 2 s across separate presses (with expiries) clears the draft; later than 2 s only re-arms', () => {
    let s = after(idleText, k('escape'), 0);
    s = after(s, ESC_EXPIRED, 31);
    expect(s.armed.escAt).toBe(31);
    s = after(s, k('escape'), 2000);
    expect(acts(s, ESC_EXPIRED, 2031)).toEqual([{ type: 'interrupt', action: 'CLEAR_DRAFT' }]);
    let late = after(idleText, k('escape'), 0);
    late = after(late, ESC_EXPIRED, 31);
    late = after(late, k('escape'), 2100);
    expect(acts(late, ESC_EXPIRED, 2131)).toEqual([{ type: 'interrupt', action: 'HINT_ESC' }]);
  });
});

describe('S4 review context (TUI-DESIGN §3.3, §6.2)', () => {
  it('y approves; n / Esc decline; d opens the note; e expands; Enter is inert; paste never matches', () => {
    expect(acts(review, text('y'))).toEqual([{ type: 'review', op: 'approve' }]);
    expect(acts(review, text('n'))).toEqual([{ type: 'review', op: 'decline' }]);
    expect(acts(review, k('escape'), 0)).toEqual([{ type: 'escBuffer' }]);
    expect(acts(after(review, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'interrupt', action: 'DECLINE' }]);
    expect(acts(review, text('d'))).toEqual([{ type: 'review', op: 'note' }]);
    expect(acts(review, text('e'))).toEqual([{ type: 'review', op: 'expand' }]);
    expect(acts(review, k('return'))).toEqual([]);
    expect(acts(review, paste('y'))).toEqual([]);
    expect(acts(review, paste('yes'))).toEqual([]);
  });
  it('an upper-case Y, other printables and multi-char chunks are not keys: toast `review pending: y n d e w · Esc declines`', () => {
    expect(acts(review, text('Y'))).toEqual([{ type: 'toast', text: REVIEW_PENDING_TOAST }]);
    expect(acts(review, text('a'))).toEqual([{ type: 'toast', text: REVIEW_PENDING_TOAST }]);
    expect(acts(review, text('yes'))).toEqual([{ type: 'toast', text: REVIEW_PENDING_TOAST }]);
    expect(acts(review, k('up'))).toEqual([]);
    expect(acts(review, k('tab'))).toEqual([]);
  });
  it('w then 1–5 within 1.5 s appends the /why block; later the digit is just a non-key', () => {
    const w = resolveKey(review, text('w'), 1000);
    expect(w).toEqual([{ type: 'arm', armed: { ...review.armed, chord: { first: WHY_ARM, at: 1000 } } }, { type: 'review', op: 'whyArm' }]);
    const armed = after(review, text('w'), 1000);
    expect(resolveKey(armed, text('3'), 1000 + WHY_WINDOW_MS)).toEqual([{ type: 'arm', armed: review.armed }, { type: 'review', op: 'why', dim: 3 }]);
    expect(acts(armed, text('5'), 1500)).toEqual([{ type: 'review', op: 'why', dim: 5 }]);
    expect(acts(armed, text('3'), 1000 + WHY_WINDOW_MS + 1)).toEqual([{ type: 'toast', text: REVIEW_PENDING_TOAST }]);
    expect(acts(armed, text('6'), 1100)).toEqual([{ type: 'toast', text: REVIEW_PENDING_TOAST }]);
    expect(acts(armed, text('y'), 1100)).toEqual([{ type: 'review', op: 'approve' }]);
    // the arm belongs to the action, not the key: a rebound review:why (`q`) still takes its digit, and `w` is then a non-key
    const q = buildBindings(new Map([['review:why', ['q']]]));
    expect(acts(review, text('q'), 0, q)).toEqual([{ type: 'review', op: 'whyArm' }]);
    const qArmed = { ...review, armed: { ...review.armed, chord: { first: WHY_ARM, at: 0 } } };
    expect(acts(qArmed, text('2'), 500, q)).toEqual([{ type: 'review', op: 'why', dim: 2 }]);
    expect(acts(review, text('w'), 0, q)).toEqual([{ type: 'toast', text: REVIEW_PENDING_TOAST }]);
  });
  it('Ctrl-C: empty draft → ABORT_REVIEW; draft typed during the deferral → CLEAR_DRAFT (F5); Ctrl-D ignored', () => {
    expect(acts(review, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'ABORT_REVIEW' }]);
    expect(acts({ ...review, draftEmpty: false }, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'CLEAR_DRAFT' }]);
    expect(acts(review, k('ctrl+d'))).toEqual([]);
  });
  it('box drawn but not yet armed: printable keys and pastes get the pending toast and never reach the composer, Enter/Esc are ignored, Ctrl-C keeps its live meaning (§6.3)', () => {
    // the deferral BEFORE the box (overlay 'none') routes keys to the composer; once the box is on screen a `y`
    // must neither approve nor become draft text (docs/live/tui attempt 2 turned the next task into "yAdd …")
    const drawn = st({ run: 'live', overlay: 'review', reviewArmed: false });
    expect(acts(drawn, text('y'))).toEqual([{ type: 'toast', text: REVIEW_PENDING_TOAST }]);
    expect(acts(drawn, paste('yes please'))).toEqual([{ type: 'toast', text: REVIEW_PENDING_TOAST }]);
    expect(acts(drawn, k('return'))).toEqual([]);
    expect(acts(drawn, k('escape'))).toEqual([{ type: 'escBuffer' }]); // the 30 ms Esc re-buffer; the expired Esc is then ignored
    expect(acts(drawn, ESC_EXPIRED)).toEqual([]);
    expect(acts(drawn, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'ABORT_STAY' }]);
    const beforeBox = st({ run: 'live', overlay: 'none', reviewArmed: false });
    expect(acts(beforeBox, text('y'))).toEqual([{ type: 'insert', text: 'y' }]);
  });
  it('note mode: printable inserts, Enter sends, Esc cancels, Ctrl-C with text clears, chips/newlines disabled', () => {
    const note = { ...review, noteMode: true };
    expect(acts(note, text('y'))).toEqual([{ type: 'insert', text: 'y' }]);
    expect(acts(note, k('return'))).toEqual([{ type: 'review', op: 'noteSubmit' }]);
    expect(acts(after(note, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'review', op: 'noteCancel' }]);
    expect(acts(note, text('\n'))).toEqual([]);
    expect(acts(note, k('backspace'))).toEqual([{ type: 'backspace' }]);
    expect(acts(note, k('ctrl+a'))).toEqual([{ type: 'move', to: 'home' }]);
    expect(acts({ ...note, draftEmpty: false }, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'CLEAR_DRAFT' }]);
    expect(acts(note, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'ABORT_REVIEW' }]);
    expect(acts(note, paste('a b'))).toEqual([{ type: 'paste', text: 'a b' }]);
  });
});

describe('S5 overlays (TUI-DESIGN §3.3 sub-rows)', () => {
  it('secret gate: y sends only when armed; an unarmed y is ignored (§6.3: neither a dismissal nor text); Esc/Enter/Ctrl-D dismiss; Ctrl-C clears the draft; other keys dismiss then reach the composer', () => {
    const gate = st({ overlay: 'secret', draftEmpty: false, cursorRow: 'last', overlayArmed: true });
    expect(acts(gate, text('y'))).toEqual([{ type: 'gate', op: 'send' }]);
    expect(acts(gate, text('Y'))).toEqual([{ type: 'gate', op: 'send' }]);
    expect(acts({ ...gate, overlayArmed: false }, text('y'))).toEqual([]);
    expect(acts({ ...gate, overlayArmed: false }, text('Y'))).toEqual([]);
    expect(acts({ ...gate, overlayArmed: false }, text('n'))).toEqual([{ type: 'gate', op: 'dismiss' }, { type: 'insert', text: 'n' }]);
    expect(acts(after(gate, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'gate', op: 'dismiss' }]);
    expect(acts(gate, k('return'))).toEqual([{ type: 'gate', op: 'dismiss' }]);
    expect(acts(gate, k('ctrl+d'))).toEqual([{ type: 'gate', op: 'dismiss' }]);
    expect(acts(gate, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'CLEAR_DRAFT' }]);
    expect(acts(gate, text('n'))).toEqual([{ type: 'gate', op: 'dismiss' }, { type: 'insert', text: 'n' }]);
    expect(acts(gate, k('backspace'))).toEqual([{ type: 'gate', op: 'dismiss' }, { type: 'backspace' }]);
    expect(acts(gate, paste('x'))).toEqual([]);
  });
  it('follow-up confirm: y (armed) starts, r prefills the raise, n / Esc / Ctrl-C cancel, Enter inert, Ctrl-D ignored', () => {
    const f = st({ overlay: 'followup', draftEmpty: false, overlayArmed: true });
    expect(acts(f, text('y'))).toEqual([{ type: 'followup', op: 'start' }]);
    expect(acts({ ...f, overlayArmed: false }, text('y'))).toEqual([]);
    expect(acts(f, text('r'))).toEqual([{ type: 'followup', op: 'raise' }]);
    expect(acts(f, text('n'))).toEqual([{ type: 'followup', op: 'cancel' }]);
    expect(acts(after(f, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'followup', op: 'cancel' }]);
    expect(acts(f, k('ctrl+c'))).toEqual([{ type: 'followup', op: 'cancel' }]);
    expect(acts(f, k('return'))).toEqual([]);
    expect(acts(f, k('ctrl+d'))).toEqual([]);
    expect(acts(f, text('a'))).toEqual([]);
  });
  it('undo prompt: y n a s; Enter = n; Esc / Ctrl-C abort; Ctrl-D ignored', () => {
    const u = st({ overlay: 'undo', overlayArmed: true });
    expect(acts(u, text('y'))).toEqual([{ type: 'undoPrompt', op: 'yes' }]);
    expect(acts({ ...u, overlayArmed: false }, text('y'))).toEqual([]);
    expect(acts(u, text('n'))).toEqual([{ type: 'undoPrompt', op: 'no' }]);
    expect(acts(u, text('a'))).toEqual([{ type: 'undoPrompt', op: 'all' }]);
    expect(acts(u, text('s'))).toEqual([{ type: 'undoPrompt', op: 'skipRest' }]);
    expect(acts(u, k('return'))).toEqual([{ type: 'undoPrompt', op: 'no' }]);
    expect(acts(after(u, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'undoPrompt', op: 'abort' }]);
    expect(acts(u, k('ctrl+c'))).toEqual([{ type: 'undoPrompt', op: 'abort' }]);
    expect(acts(u, k('ctrl+d'))).toEqual([]);
  });
  it('exitConfirm: y (armed) aborts and exits, n / Esc / Ctrl-C stay, Enter inert, Ctrl-D ignored', () => {
    const e = st({ run: 'live', overlay: 'exitConfirm', overlayArmed: true });
    expect(acts(e, text('y'))).toEqual([{ type: 'exitConfirm', op: 'abortExit' }]);
    expect(acts({ ...e, overlayArmed: false }, text('y'))).toEqual([]);
    expect(acts(e, text('n'))).toEqual([{ type: 'exitConfirm', op: 'stay' }]);
    expect(acts(after(e, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'exitConfirm', op: 'stay' }]);
    expect(acts(e, k('ctrl+c'))).toEqual([{ type: 'exitConfirm', op: 'stay' }]);
    expect(acts(e, k('return'))).toEqual([]);
    expect(acts(e, k('ctrl+d'))).toEqual([]);
  });
  it('wizard: digits and text are field input, Enter submits, Esc steps back, Backspace/Delete, Ctrl-U clears, paste is input; Ctrl-C exits 2 with no run, closes mid-run', () => {
    const w = st({ overlay: 'wizard' });
    expect(acts(w, text('1'))).toEqual([{ type: 'wizard', op: 'input', text: '1' }]);
    expect(acts(w, text('k'))).toEqual([{ type: 'wizard', op: 'input', text: 'k' }]);
    expect(acts(w, paste('sk-ant-abcdefghijkl'))).toEqual([{ type: 'wizard', op: 'input', text: 'sk-ant-abcdefghijkl' }]);
    expect(acts(w, text('sk-ant-abcdefghijkl'))).toEqual([{ type: 'wizard', op: 'input', text: 'sk-ant-abcdefghijkl' }]);
    expect(acts(w, k('return'))).toEqual([{ type: 'wizard', op: 'submit' }]);
    expect(acts(after(w, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'wizard', op: 'back' }]);
    expect(acts(w, k('backspace'))).toEqual([{ type: 'wizard', op: 'backspace' }]);
    expect(acts(w, k('delete'))).toEqual([{ type: 'wizard', op: 'backspace' }]);
    expect(acts(w, k('ctrl+u'))).toEqual([{ type: 'wizard', op: 'clear' }]);
    expect(acts(w, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'WIZARD_EXIT_2' }]);
    expect(acts({ ...w, run: 'live' }, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'CLOSE_OVERLAY' }]);
    expect(acts(w, k('ctrl+d'))).toEqual([]);
    expect(acts(w, k('up'))).toEqual([]);
  });
  it('blocking pane: r c q p l as listed; Ctrl-C = [q]; Esc no-op; Enter inert; other keys ignored', () => {
    const b = st({ run: 'live', overlay: 'blocking' });
    for (const key of ['r', 'c', 'q', 'p', 'l'] as const) expect(acts(b, text(key))).toEqual([{ type: 'blocking', key }]);
    expect(acts(b, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'PANE_Q' }]);
    expect(acts(after(b, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([]);
    expect(acts(b, k('return'))).toEqual([]);
    expect(acts(b, text('x'))).toEqual([]);
    expect(acts(b, paste('q'))).toEqual([]);
  });
  it('palette: printable filters, ↑↓/Ctrl-P/N/PgUp/PgDn move, Tab accepts, Enter is the nav machine\'s `enter` (TUI-DESIGN-4 §4.2 P-P1), Esc/Ctrl-C/Ctrl-D close', () => {
    const p = st({ overlay: 'palette', draftEmpty: false, cursorRow: 'first' });
    expect(acts(p, text('b'))).toEqual([{ type: 'insert', text: 'b' }]);
    expect(acts(p, text('/'))).toEqual([{ type: 'insert', text: '/' }]);
    expect(acts(p, k('up'))).toEqual([{ type: 'palette', op: 'move', by: -1 }]);
    expect(acts(p, k('ctrl+n'))).toEqual([{ type: 'palette', op: 'move', by: 1 }]);
    expect(acts(p, k('pagedown'))).toEqual([{ type: 'palette', op: 'page', by: 1 }]);
    expect(acts(p, k('tab'))).toEqual([{ type: 'palette', op: 'accept' }]);
    expect(acts(p, k('shift+tab'))).toEqual([{ type: 'palette', op: 'move', by: -1 }]);
    // TUI-DESIGN-4 §4.2 P-P1: `run` became `enter` — the controller decides between cycling, accepting and running
    expect(acts(p, k('return'))).toEqual([{ type: 'palette', op: 'enter' }]);
    expect(acts(after(p, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'interrupt', action: 'CLOSE_OVERLAY' }]);
    expect(acts(p, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'CLOSE_OVERLAY' }]);
    expect(acts(p, k('ctrl+d'))).toEqual([{ type: 'interrupt', action: 'CLOSE_OVERLAY' }]);
    expect(acts(p, k('backspace'))).toEqual([{ type: 'backspace' }]);
    expect(acts(p, k('left'))).toEqual([{ type: 'move', to: 'left' }]);
    expect(acts(p, k('ctrl+w'))).toEqual([{ type: 'kill', what: 'wordBack' }]);
  });
});

describe('picker context (TUI-DESIGN §3.1, §8.4)', () => {
  const p = st({ picker: true });
  it('navigation, open, accept, preview, all workspaces, rename, close', () => {
    expect(acts(p, k('up'))).toEqual([{ type: 'picker', op: 'move', by: -1 }]);
    expect(acts(p, k('ctrl+p'))).toEqual([{ type: 'picker', op: 'move', by: -1 }]);
    expect(acts(p, k('down'))).toEqual([{ type: 'picker', op: 'move', by: 1 }]);
    expect(acts(p, k('pageup'))).toEqual([{ type: 'picker', op: 'page', by: -1 }]);
    expect(acts(p, k('return'))).toEqual([{ type: 'picker', op: 'open' }]);
    expect(acts(p, k('tab'))).toEqual([{ type: 'picker', op: 'accept' }]);
    expect(acts(p, k('space'))).toEqual([{ type: 'picker', op: 'preview' }]);
    expect(acts(p, k('ctrl+a'))).toEqual([{ type: 'picker', op: 'allWorkspaces' }]);
    expect(acts(p, k('ctrl+r'))).toEqual([{ type: 'picker', op: 'rename' }]);
    expect(acts(after(p, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'picker', op: 'close' }]);
    expect(acts(p, k('ctrl+c'))).toEqual([{ type: 'picker', op: 'close' }]);
    expect(acts(p, k('ctrl+d'))).toEqual([]);
  });
  it('printable filters (d p t s included); x then y within 3 s deletes, later y is filter text', () => {
    expect(acts(p, text('p'))).toEqual([{ type: 'insert', text: 'p' }]);
    expect(acts(p, text('y'))).toEqual([{ type: 'insert', text: 'y' }]);
    const armed = after(p, text('x'), 1000);
    expect(acts(p, text('x'), 1000)).toEqual([{ type: 'picker', op: 'deleteArm' }]);
    expect(armed.armed.chord).toEqual({ first: DELETE_ARM, at: 1000 });
    expect(acts(armed, text('y'), 1000 + CHORD_WINDOW_MS)).toEqual([{ type: 'picker', op: 'deleteConfirm' }]);
    expect(acts(armed, text('y'), 1000 + CHORD_WINDOW_MS + 1)).toEqual([{ type: 'insert', text: 'y' }]);
    expect(acts(armed, text('a'), 1500)).toEqual([{ type: 'insert', text: 'a' }]);
    expect(armOf(armed, text('a'), 1500).chord).toBeNull();
  });
});

describe('history search context (TUI-DESIGN §3.2 Ctrl-R)', () => {
  const h = st({ historySearch: true, draftEmpty: false });
  it('query, older, newer, accept, accept + submit, cancel, widen, backspace', () => {
    expect(acts(h, text('p'))).toEqual([{ type: 'historySearch', op: 'query', text: 'p' }]);
    expect(acts(h, k('ctrl+r'))).toEqual([{ type: 'historySearch', op: 'older' }]);
    expect(acts(h, k('ctrl+s'))).toEqual([{ type: 'historySearch', op: 'newer' }]);
    expect(acts(h, k('tab'))).toEqual([{ type: 'historySearch', op: 'accept' }]);
    expect(acts(h, k('right'))).toEqual([{ type: 'historySearch', op: 'accept' }]);
    expect(acts(h, k('return'))).toEqual([{ type: 'historySearch', op: 'acceptSubmit' }]);
    expect(acts(after(h, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'historySearch', op: 'cancel' }]);
    expect(acts(h, k('ctrl+c'))).toEqual([{ type: 'historySearch', op: 'cancel' }]);
    expect(acts(h, k('ctrl+a'))).toEqual([{ type: 'historySearch', op: 'widen' }]);
    expect(acts(h, k('backspace'))).toEqual([{ type: 'historySearch', op: 'backspace' }]);
    expect(acts(h, paste('ab'))).toEqual([{ type: 'historySearch', op: 'query', text: 'ab' }]);
    expect(acts(h, k('up'))).toEqual([]);
  });
});

describe('minsize context (rows < 8)', () => {
  const m = st({ minsize: true, draftEmpty: false });
  it('Ctrl-C/D, Enter and text only', () => {
    expect(acts(m, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'CLEAR_DRAFT' }]);
    expect(acts({ ...m, draftEmpty: true }, k('ctrl+d'))).toEqual([{ type: 'interrupt', action: 'HINT_CTRL_D' }]);
    expect(acts(m, k('ctrl+d'))).toEqual([{ type: 'delete' }]);
    expect(acts(m, k('return'))).toEqual([{ type: 'submit' }]);
    expect(acts(m, text('a'))).toEqual([{ type: 'insert', text: 'a' }]);
    expect(acts(m, k('backspace'))).toEqual([{ type: 'backspace' }]);
    expect(acts(m, k('up'))).toEqual([]);
    expect(acts(m, k('ctrl+r'))).toEqual([]);
    expect(acts(m, text('?'))).toEqual([{ type: 'insert', text: '?' }]);
    expect(acts({ ...m, draftEmpty: true }, text('/'))).toEqual([{ type: 'insert', text: '/' }]);
  });
});

describe('keybindings file chords and overrides through the resolver (TUI-DESIGN §3.4)', () => {
  const b = buildBindings(new Map<string, readonly string[]>([
    ['session:export', ['ctrl+x ctrl+s']],
    ['composer:killLine', []],
    ['global:help', ['f1']],
  ]));
  it('a chord arms on its first key and completes within 3 s; after 3 s the second key is on its own', () => {
    const first = resolveKey(idle, k('ctrl+x'), 1000, b);
    expect(first).toEqual([{ type: 'arm', armed: { ...idle.armed, chord: { first: 'ctrl+x', at: 1000 } } }]);
    const armed = { ...idle, armed: { ...idle.armed, chord: { first: 'ctrl+x', at: 1000 } } };
    expect(resolveKey(armed, k('ctrl+s'), 1000 + CHORD_WINDOW_MS, b)).toEqual([{ type: 'arm', armed: idle.armed }, { type: 'export' }]);
    expect(acts(armed, k('ctrl+s'), 1000 + CHORD_WINDOW_MS + 1, b)[0]?.type).toBe('filtered');
    // inside the window a key that completes no chord is swallowed (Emacs: "C-x a is undefined"), never inserted
    expect(resolveKey(armed, text('a'), 1500, b)).toEqual([{ type: 'arm', armed: idle.armed }, { type: 'filtered', reason: 'unbound-chord' }]);
    // after the window the same key is on its own again
    expect(acts(armed, text('a'), 1000 + CHORD_WINDOW_MS + 1, b)).toEqual([{ type: 'insert', text: 'a' }]);
  });
  it('chords arm and fire in the review, picker and palette contexts too (§3.4 contexts); a miss is swallowed; the window is 3 s', () => {
    const cb = buildBindings(new Map<string, readonly string[]>([
      ['review:expand', ['ctrl+x e']],
      ['picker:rename', ['ctrl+x r']],
      ['palette:pageDown', ['ctrl+x n']],
    ]));
    const cases: [string, KeyState, KeyEvent, KeyAction][] = [
      ['review', review, text('e'), { type: 'review', op: 'expand' }],
      ['picker', st({ picker: true }), text('r'), { type: 'picker', op: 'rename' }],
      ['palette', st({ overlay: 'palette', draftEmpty: false }), text('n'), { type: 'palette', op: 'page', by: 1 }],
    ];
    for (const [name, s, second, action] of cases) {
      const first = resolveKey(s, k('ctrl+x'), 1000, cb);
      expect(first, name).toEqual([{ type: 'arm', armed: { ...s.armed, chord: { first: 'ctrl+x', at: 1000 } } }]);
      const armed = { ...s, armed: { ...s.armed, chord: { first: 'ctrl+x', at: 1000 } } };
      expect(resolveKey(armed, second, 1000 + CHORD_WINDOW_MS, cb), name).toEqual([{ type: 'arm', armed: s.armed }, action]);
      // a miss inside the window is swallowed, in every context
      expect(acts(armed, text('z'), 1500, cb), name).toEqual([]);
      // the plain single key still means what it meant (the default `e`/`r` keys were not displaced: the chord is on ctrl+x)
      expect(acts(armed, second, 1000 + CHORD_WINDOW_MS + 1, cb).length, name).toBeGreaterThan(0);
    }
    // the review's own `e` default is gone (replaced by the chord); a plain `e` is now a non-key toast
    expect(acts(review, text('e'), 0, cb)).toEqual([{ type: 'toast', text: REVIEW_PENDING_TOAST }]);
    // an unbound chord prefix in a context does nothing (ctrl+x is only a prefix where a chord is bound)
    expect(acts(st({ overlay: 'wizard' }), k('ctrl+x'), 0, cb)).toEqual([]);
  });
  it('a chord whose first key is a bound single key: the single key was displaced at build time, so the prefix arms (the warning is the loader\'s)', () => {
    const b2 = buildBindings(new Map([['session:export', ['ctrl+k ctrl+s']]]));
    expect(b2.warnings).toHaveLength(1);
    expect(acts(idleText, k('ctrl+k'), 0, b2)).toEqual([]); // arms, no kill
    const armed = { ...idleText, armed: { ...idleText.armed, chord: { first: 'ctrl+k', at: 0 } } };
    expect(acts(armed, k('ctrl+s'), 100, b2)).toEqual([{ type: 'export' }]);
  });
  it('TUI-DESIGN-3 §4.5: a rebound command action fires `{ type: "slash", line }` — a chord (`ctrl+x c` → /cost) or a single key (`f5` → /status); unbound by default nothing fires; the review context never sees them', () => {
    const cb = buildBindings(new Map<string, readonly string[]>([
      ['session:cost', ['ctrl+x c']],
      ['session:status', ['f5']],
      ['session:mode', ['f6']],
      ['files:diff', ['f7']],
      ['files:undo', ['f8']],
      ['ui:copy', ['f9']],
    ]));
    expect(cb.warnings).toEqual([]);
    /** an F-key as Ink delivers it: `input === ''`, every flag false, parse-keypress's name */
    const fkey = (name: string): KeyEvent => ({ input: '', key: { ...FLAGS }, name });
    const first = resolveKey(idle, k('ctrl+x'), 1000, cb);
    expect(first).toEqual([{ type: 'arm', armed: { ...idle.armed, chord: { first: 'ctrl+x', at: 1000 } } }]);
    const armed = { ...idle, armed: { ...idle.armed, chord: { first: 'ctrl+x', at: 1000 } } };
    expect(resolveKey(armed, text('c'), 1500, cb)).toEqual([{ type: 'arm', armed: idle.armed }, { type: 'slash', line: '/cost' }]);
    expect(acts(idle, fkey('f5'), 0, cb)).toEqual([{ type: 'slash', line: '/status' }]);
    expect(acts(idleText, fkey('f6'), 0, cb)).toEqual([{ type: 'slash', line: '/mode' }]);
    expect(acts(live, fkey('f7'), 0, cb)).toEqual([{ type: 'slash', line: '/diff' }]);
    expect(acts(idle, fkey('f8'), 0, cb)).toEqual([{ type: 'slash', line: '/undo' }]);
    expect(acts(idle, fkey('f9'), 0, cb)).toEqual([{ type: 'slash', line: '/copy' }]);
    // defaults: F5 is an unbound key, a plain `c` is text
    expect(acts(idle, fkey('f5'))).toEqual([{ type: 'filtered', reason: 'unbound-key' }]);
    expect(acts(idle, text('c'))).toEqual([{ type: 'insert', text: 'c' }]);
    // the review box keeps its own keys: f5 there is filtered, never a command
    expect(acts(review, fkey('f5'), 0, cb)[0]?.type).not.toBe('slash');
  });
  it('"none" unbinds (Ctrl-K becomes an unbound modifier key); a rebound `?` inserts text', () => {
    expect(acts(idleText, k('ctrl+k'), 0, b)).toEqual([{ type: 'filtered', reason: 'unbound-modifier' }]);
    expect(acts(idle, text('?'), 0, b)).toEqual([{ type: 'insert', text: '?' }]);
    expect(acts(idle, k('f1'), 0, b)).toEqual([{ type: 'help' }]);
    // F1 follows the table too: unbinding global:help entirely leaves F1 unbound
    expect(acts(idle, k('f1'), 0, buildBindings(new Map([['global:help', []]])))).toEqual([{ type: 'filtered', reason: 'unbound-key' }]);
  });
  it('default table: keyString canonical forms', () => {
    expect(keyString(k('ctrl+k'))).toBe('ctrl+k');
    expect(keyString(k('meta+b'))).toBe('meta+b');
    expect(keyString(k('shift+tab'))).toBe('shift+tab');
    expect(keyString(k('ctrl+left'))).toBe('ctrl+left');
    expect(keyString(text('\u001f'))).toBe('ctrl+_');
    expect(keyString(text('\u001e'))).toBe('ctrl+^');
    expect(keyString(text(' '))).toBe('space');
    expect(keyString(text('Y'))).toBe('Y');
    expect(keyString(text('ab'))).toBeNull();
    expect(keyString(k('f1'))).toBe('f1');
    expect(isPrintable(text('a'))).toBe(true);
    expect(isPrintable(text('\t'))).toBe(true);
    expect(isPrintable(text('\u0001'))).toBe(false);
    expect(isPrintable(k('ctrl+a'))).toBe(false);
  });
});

describe('S7 pausing through the resolver (TUI-DESIGN §3.3 column S7)', () => {
  const pausing = st({ run: 'pausing' });
  const pausingText = st({ run: 'pausing', draftEmpty: false, cursorRow: 'mid' });
  it('Enter with text → submit (the router steers it into pendingDirectives); empty → no-op', () => {
    expect(acts(pausingText, k('return'))).toEqual([{ type: 'submit' }]);
    expect(acts(pausing, k('return'))).toEqual([]);
  });
  it('printable → insert (y included: a review is not armed), paste → paste, newline keys → newline', () => {
    expect(acts(pausing, text('y'))).toEqual([{ type: 'insert', text: 'y' }]);
    expect(acts(pausing, text('a'))).toEqual([{ type: 'insert', text: 'a' }]);
    for (const ch of ['d', 'p', 't', 's']) expect(acts(pausing, text(ch))).toEqual([{ type: 'insert', text: ch }]);
    expect(acts(pausing, paste('a\nb'))).toEqual([{ type: 'paste', text: 'a\nb' }]);
    expect(acts(pausingText, text('\n'))).toEqual([{ type: 'newline' }]);
    expect(acts(pausingText, k('ctrl+k'))).toEqual([{ type: 'kill', what: 'toEnd' }]);
  });
  it('interrupts: Ctrl-C aborts now (one-shot exits 130), Esc ×1 no-op then Esc ×2 aborts, Ctrl-D as S2', () => {
    expect(acts(pausing, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'ABORT_STAY' }]);
    expect(acts({ ...pausing, mode: 'one-shot' }, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'ABORT_EXIT_130' }]);
    expect(acts(pausingText, k('ctrl+c'))).toEqual([{ type: 'interrupt', action: 'CLEAR_DRAFT' }]);
    const once = after(pausing, k('escape'), 0);
    expect(acts(once, ESC_EXPIRED, 31)).toEqual([]);
    let s = { ...once, armed: armOf(once, ESC_EXPIRED, 31) };
    s = after(s, k('escape'), 500);
    expect(acts(s, ESC_EXPIRED, 531)).toEqual([{ type: 'interrupt', action: 'ABORT' }]);
    expect(acts(pausing, k('ctrl+d'))).toEqual([{ type: 'interrupt', action: 'HINT_CTRL_D' }]);
    expect(acts(pausingText, k('ctrl+d'))).toEqual([{ type: 'delete' }]);
  });
});

describe('Ctrl+Z suspend and Ctrl+L repaint work in every context (TUI-DESIGN §3.1 Global, §14.2)', () => {
  const contexts: [string, KeyState][] = [
    ['composer idle', idle],
    ['composer text', idleText],
    ['live', live],
    ['pausing', st({ run: 'pausing' })],
    ['aborting', st({ run: 'aborting' })],
    ['review armed', review],
    ['review note', { ...review, noteMode: true }],
    ['review deferred', st({ run: 'live', overlay: 'review', reviewArmed: false })],
    ['picker', st({ picker: true })],
    ['palette', st({ overlay: 'palette', draftEmpty: false })],
    ['wizard', st({ overlay: 'wizard' })],
    ['blocking', st({ run: 'live', overlay: 'blocking' })],
    ['secret gate', st({ overlay: 'secret', draftEmpty: false, overlayArmed: true })],
    ['follow-up', st({ overlay: 'followup', overlayArmed: true })],
    ['undo prompt', st({ overlay: 'undo', overlayArmed: true })],
    ['exitConfirm', st({ run: 'live', overlay: 'exitConfirm', overlayArmed: true })],
    ['history search', st({ historySearch: true, draftEmpty: false })],
    ['minsize', st({ minsize: true, draftEmpty: false })],
  ];
  it.each(contexts)('%s: Ctrl+Z → suspend, byte 0x1a → suspend, Ctrl+L → repaint', (_name, s) => {
    expect(acts(s, k('ctrl+z'))).toEqual([{ type: 'suspend' }]);
    expect(acts(s, text('\u001a'))).toEqual([{ type: 'suspend' }]);
    expect(acts(s, k('ctrl+l'))).toEqual([{ type: 'repaint' }]);
  });
  it('they count as "other" for the Ctrl-C / Esc / Ctrl-D arms and a pasted 0x1a is text, never a suspend', () => {
    const armed = after(idle, k('ctrl+c'), 1000);
    expect(resolveKey(armed, k('ctrl+z'), 1100)[0]).toEqual({ type: 'arm', armed: idle.armed });
    expect(acts(idle, paste('\u001a'))).toEqual([{ type: 'paste', text: '\u001a' }]);
    // a printable rebinding of suspend is honoured only where the composer table applies (a wizard field keeps typing)
    const zb = buildBindings(new Map([['global:suspend', ['z']]]));
    expect(acts(idle, text('z'), 0, zb)).toEqual([{ type: 'suspend' }]);
    expect(acts(st({ overlay: 'wizard' }), text('z'), 0, zb)).toEqual([{ type: 'wizard', op: 'input', text: 'z' }]);
    expect(acts(review, text('z'), 0, zb)).toEqual([{ type: 'toast', text: REVIEW_PENDING_TOAST }]);
    // unbinding suspend disables it everywhere
    const none = buildBindings(new Map([['global:suspend', []]]));
    expect(acts(review, k('ctrl+z'), 0, none)).toEqual([]);
    expect(acts(st({ picker: true }), k('ctrl+z'), 0, none)).toEqual([]);
  });
});

describe('Esc re-buffer and bracketed paste (TUI-DESIGN §3.3)', () => {
  it('a single-grapheme paste inside the 30 ms window is never a Meta chord: the pending Esc fires, then the paste is its own event', () => {
    const buffered = after(live, k('escape'), 0);
    // the Esc fires (PAUSE, arming Esc Esc), then the paste is "other" and clears the arms again (§3.3)
    expect(resolveKey(buffered, paste('b'), 10)).toEqual([{ type: 'arm', armed: live.armed }, { type: 'interrupt', action: 'PAUSE' }, { type: 'paste', text: 'b' }]);
    const bufferedText = after(liveText, k('escape'), 0);
    expect(acts(bufferedText, paste('b'), 10)).toEqual([{ type: 'interrupt', action: 'HINT_ESC' }, { type: 'paste', text: 'b' }]);
    expect(acts(bufferedText, paste('\r'), 10)).toEqual([{ type: 'interrupt', action: 'HINT_ESC' }, { type: 'paste', text: '\r' }]);
    // the same byte typed (not pasted) is the chord
    expect(acts(bufferedText, text('b'), 10)).toEqual([{ type: 'move', to: 'wordLeft' }]);
    // under an armed review a pasted `y` after Esc: decline fires, the paste is ignored (a pasted string never matches a key)
    const rev = after(review, k('escape'), 0);
    expect(acts(rev, paste('y'), 10)).toEqual([{ type: 'interrupt', action: 'DECLINE' }]);
  });
});

describe('TUI-DESIGN-4 §4.7 E9 / E10 / E13: one-chunk `/m`, mouse reports and the reopen rule', () => {
  it('E9: a NON-paste chunk that is `/` + up to eight name characters on an empty draft opens the palette with the remainder as the query', () => {
    // measured: `send /m` arrives as ONE useInput with input === '/m', which matches no key binding, so today the
    // frame reads `› /m` with no palette at all
    expect(acts(st(), text('/m'))).toEqual([{ type: 'insert', text: '/m' }, { type: 'openPalette' }]);
    expect(acts(st(), text('/budget'))).toEqual([{ type: 'insert', text: '/budget' }, { type: 'openPalette' }]);
    expect(acts(st(), text('/history-'))).toEqual([{ type: 'insert', text: '/history-' }, { type: 'openPalette' }]);
    // a BRACKETED paste never opens it (pastes are handled first)
    expect(acts(st(), paste('/m'))).toEqual([{ type: 'paste', text: '/m' }]);
    // the length and charset bound keeps a burst text: nine name characters, an interior space, a capital, no slash
    expect(acts(st(), text('/abcdefghi'))).toEqual([{ type: 'paste', text: '/abcdefghi' }]);
    expect(acts(st(), text('/m x'))).toEqual([{ type: 'paste', text: '/m x' }]);
    expect(acts(st(), text('/M'))).toEqual([{ type: 'paste', text: '/M' }]);
    expect(acts(st(), text('//m'))).toEqual([{ type: 'paste', text: '//m' }]);
    // and only on an EMPTY draft — mid-prompt it is ordinary text
    expect(acts(st({ draftEmpty: false }), text('/m'))).toEqual([{ type: 'paste', text: '/m' }]);
    // a bare `/` is round 3's single-character binding, unchanged
    expect(acts(st(), text('/'))).toEqual([{ type: 'insert', text: '/' }, { type: 'openPalette' }]);
  });
  it('E10: an SGR or X10 mouse report from an outer program is dropped in EVERY context, so it can never reach a draft or a query', () => {
    expect(MOUSE_RE.test('[<64;10;5M')).toBe(true);
    expect(MOUSE_RE.test('[<0;12;30m')).toBe(true);
    expect(MOUSE_RE.test('[M !!')).toBe(true);
    expect(MOUSE_RE.test('[<64;10;5')).toBe(false);
    expect(MOUSE_RE.test('hello')).toBe(false);
    for (const s0 of [st(), st({ draftEmpty: false }), st({ overlay: 'palette', draftEmpty: false }), st({ overlay: 'wizard' }), st({ overlay: 'review', reviewArmed: true, run: 'live' }), st({ overlay: 'secret' }), st({ overlay: 'blocking' }), st({ run: 'live' }), st({ minsize: true })]) {
      expect(acts(s0, text('[<64;10;5M')), JSON.stringify(s0.overlay)).toEqual([{ type: 'filtered', reason: 'mouse-report' }]);
      expect(acts(s0, text('[M !!')), JSON.stringify(s0.overlay)).toEqual([{ type: 'filtered', reason: 'mouse-report' }]);
    }
    // a bracketed paste is the user's content, whatever it looks like
    expect(acts(st(), paste('[<64;10;5M'))).toEqual([{ type: 'paste', text: '[<64;10;5M' }]);
  });
  it('E13: `/` typed at the END of a draft that is exactly a `/token` REOPENS the palette and is NOT inserted; Esc keeps its contract', () => {
    const closed = st({ draftEmpty: false, draftTokenOnly: true, cursorAtEnd: true });
    // the draft is left EXACTLY as it stands: a second slash would make it `/mode/`, a token that matches nothing,
    // so the reopened card would read `no command matches /mode/` — worse than the trap the rule exists to undo
    expect(acts(closed, text('/'))).toEqual([{ type: 'openPalette' }]);
    expect(acts(closed, text('/')).some((a) => a.type === 'insert')).toBe(false);
    // not mid-token (the cursor is elsewhere), not with an argument, and not by default
    expect(acts(st({ draftEmpty: false, draftTokenOnly: true, cursorAtEnd: false }), text('/'))).toEqual([{ type: 'insert', text: '/' }]);
    expect(acts(st({ draftEmpty: false, draftTokenOnly: false, cursorAtEnd: true }), text('/'))).toEqual([{ type: 'insert', text: '/' }]);
    expect(acts(st({ draftEmpty: false }), text('/'))).toEqual([{ type: 'insert', text: '/' }]);
    expect(initialKeyState('session').draftTokenOnly).toBe(false);
    // an EMPTY draft still inserts the slash it opens on (round 3's rule, and the first half of `//`)
    expect(acts(st(), text('/'))).toEqual([{ type: 'insert', text: '/' }, { type: 'openPalette' }]);
    // …and `//` at column 0 still escapes: the second slash is typed with the CARD OPEN, where `resolvePalette`
    // sends a printable straight to the buffer and never reaches the `composer:palette` branch
    expect(acts(st({ overlay: 'palette', draftEmpty: false, draftTokenOnly: true, cursorAtEnd: true }), text('/'))).toEqual([{ type: 'insert', text: '/' }]);
  });
});

describe('purity and bookkeeping', () => {
  it('never mutates its input and emits `arm` only when a window changed', () => {
    const s = st({ draftEmpty: false });
    const frozen = JSON.stringify(s);
    const a = resolveKey(s, text('a'), 5);
    expect(JSON.stringify(s)).toBe(frozen);
    expect(a.some((x) => x.type === 'arm')).toBe(false);
    const withArm = st({}, { ctrlCAt: 1 });
    expect(resolveKey(withArm, text('a'), 5)[0]).toEqual({ type: 'arm', armed: { ...withArm.armed, ctrlCAt: null } });
  });
  it('a non-finite clock is treated as 0 (never within a window)', () => {
    expect(acts(idle, k('ctrl+c'), Number.NaN)).toEqual([{ type: 'interrupt', action: 'HINT_CTRL_C' }]);
  });
});

// ---------------------------------------------------------------------------------------
// TUI-DESIGN-5 §4.3 / §7 rows 91, 99: the one new rung and the picker's card sub-state (R5-4's §10 `keys.test.ts`)
// ---------------------------------------------------------------------------------------

describe("the `agents` rung (TUI-DESIGN-5 §4.3, §14.2 #41)", () => {
  const focused = st({ paneFocus: true, tab: 'a' });

  it("resolves p / t / d / k / l / + ONLY when paneFocus && tab === 'a'", () => {
    expect(acts(focused, text('p'))).toEqual([{ type: 'agents', op: 'pause' }]);
    expect(acts(focused, text('t'))).toEqual([{ type: 'agents', op: 'steer' }]);
    expect(acts(focused, text('d'))).toEqual([{ type: 'agents', op: 'diff' }]);
    expect(acts(focused, text('k'))).toEqual([{ type: 'agents', op: 'kick' }]);
    expect(acts(focused, text('l'))).toEqual([{ type: 'agents', op: 'land' }]);
    expect(acts(focused, text('+'))).toEqual([{ type: 'agents', op: 'budget' }]);
    expect(acts(focused, k('return'))).toEqual([{ type: 'agents', op: 'attach' }]);
  });

  it('without focus, and on any other tab, the same letters are composer text (the §14.2 #41 defect)', () => {
    for (const s of [st({ paneFocus: false, tab: 'a' }), st({ paneFocus: true, tab: 'd' }), st()]) {
      for (const letter of ['p', 't', 'd', 'k', 'l', '+']) expect(acts(s, text(letter)), letter).toEqual([{ type: 'insert', text: letter }]);
    }
  });

  it('it sits BELOW Picker and ABOVE Composer', () => {
    // below Picker: with the picker open the same letters are the picker's filter text, focus or no focus
    const picker = st({ picker: true, paneFocus: true, tab: 'a' });
    expect(acts(picker, text('p'))).toEqual([{ type: 'insert', text: 'p' }]);
    // above Composer: the letters never reach the draft while focused
    expect(acts(focused, text('p'))).not.toEqual([{ type: 'insert', text: 'p' }]);
    // and an overlay still outranks it
    expect(acts(st({ paneFocus: true, tab: 'a', overlay: 'review', reviewArmed: true }), text('p'))).not.toEqual([{ type: 'agents', op: 'pause' }]);
  });

  it('x twice drops, one x only arms (an agent drop loses its uncommitted diff, §4.3)', () => {
    expect(acts(focused, text('x'))).toEqual([{ type: 'agents', op: 'dropArm' }]);
    const armed = after(focused, text('x'), 1_000);
    expect(acts(armed, text('x'), 1_000 + CHORD_WINDOW_MS - 1)).toEqual([{ type: 'agents', op: 'dropConfirm' }]);
    // a different key inside the window is swallowed, never a drop
    expect(acts(armed, text('z'), 1_000 + 10)).toEqual([]);
    // and the arm expires
    expect(acts(armed, text('x'), 1_000 + CHORD_WINDOW_MS + 1)).toEqual([{ type: 'agents', op: 'dropArm' }]);
  });

  it('Esc unfocuses (the tab is a focus state, not an overlay); ↑ / ↓ move the cursor', () => {
    expect(acts(after(focused, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'paneFocus', on: false }]);
    expect(acts(focused, k('up'))).toEqual([{ type: 'agents', op: 'move', by: -1 }]);
    expect(acts(focused, k('down'))).toEqual([{ type: 'agents', op: 'move', by: 1 }]);
  });

  it('anything the rung does not claim falls through to the composer (a focused tab is not a modal)', () => {
    expect(acts(focused, text('q'))).toEqual([{ type: 'insert', text: 'q' }]);
    expect(acts(focused, text('/'))).toEqual([{ type: 'insert', text: '/' }, { type: 'openPalette' }]);
    expect(acts(focused, k('ctrl+l'))).toEqual([{ type: 'repaint' }]);
    expect(acts(focused, paste('hello world'))).toEqual([{ type: 'paste', text: 'hello world' }]);
  });

  it('§7 row 99: Alt+A focuses on an empty draft and is REFUSED with a non-empty one (S86a)', () => {
    expect(acts(st(), k('meta+a'))).toEqual([{ type: 'paneFocus', on: true }]);
    expect(acts(st({ draftEmpty: false }), k('meta+a'))).toEqual([{ type: 'toast', text: 'finish or clear the line first — Alt+A then focuses the agents tab' }]);
  });

  it('§7 row 99 holds for the whole focused lifetime: a PASTE, then `l`, is text — not `agents:land`', () => {
    /**
     * The rung deliberately lets a paste through to the composer, so the draft can become non-empty while focus
     * is still on. Gating the rung only at focus-GRANT time left the eight letters live over that draft: typing
     * `land it` fired `agents:land` on the `l` and `agents:attach` on the Enter — the half-typed line row 99
     * exists to protect. `draftEmpty` is therefore part of the rung's own gate.
     */
    expect(acts(focused, paste('land'))).toEqual([{ type: 'paste', text: 'land' }]);
    const typing = st({ paneFocus: true, tab: 'a', draftEmpty: false });
    for (const key of ['l', 'p', 't', 'd', 'k', 'x', '+']) expect(acts(typing, text(key)), key).toEqual([{ type: 'insert', text: key }]);
    expect(acts(typing, k('return'))).toEqual([{ type: 'submit' }]);
    // clear the draft and the tab's keys are live again — the focus state itself never moved
    expect(acts(st({ paneFocus: true, tab: 'a', draftEmpty: true }), text('l'))).toEqual([{ type: 'agents', op: 'land' }]);
  });
});

describe("the resume card's sub-state (TUI-DESIGN-5 §2.8, §7 row 91)", () => {
  it("`'off'` is round 3 byte for byte: Enter resumes, Esc closes, r/f/d/w are filter text", () => {
    const p = st({ picker: true });
    expect(acts(p, k('return'))).toEqual([{ type: 'picker', op: 'open' }]);
    expect(acts(p, k('ctrl+c'))).toEqual([{ type: 'picker', op: 'close' }]);
    for (const letter of ['r', 'f', 'd', 'w']) expect(acts(p, text(letter)), letter).toEqual([{ type: 'insert', text: letter }]);
  });

  it("`'closed'`: Enter OPENS the card; the four letters are still filter text", () => {
    const p = st({ picker: true, pickerCard: 'closed' });
    expect(acts(p, k('return'))).toEqual([{ type: 'picker', op: 'cardOpen' }]);
    for (const letter of ['r', 'f', 'd', 'w']) expect(acts(p, text(letter)), letter).toEqual([{ type: 'insert', text: letter }]);
  });

  it("`'open'`: the four letters resolve, Esc returns to the LIST and Enter resumes", () => {
    const p = st({ picker: true, pickerCard: 'open' });
    expect(acts(p, text('r'))).toEqual([{ type: 'picker', op: 'cardReplay' }]);
    expect(acts(p, text('f'))).toEqual([{ type: 'picker', op: 'cardFresh' }]);
    expect(acts(p, text('d'))).toEqual([{ type: 'picker', op: 'cardDiff' }]);
    expect(acts(p, text('w'))).toEqual([{ type: 'picker', op: 'cardWho' }]);
    expect(acts(p, k('return'))).toEqual([{ type: 'picker', op: 'open' }]);
    expect(acts(after(p, k('escape'), 0), ESC_EXPIRED, 31)).toEqual([{ type: 'picker', op: 'cardClose' }]);
  });

  /**
   * §7 row 91's NEGATIVE half, which the first cut of this file got backwards: the card is a **focused**
   * sub-state, so the list's own keys are inert while it is open — including the two that do something
   * irreversible.
   *
   * The measured defect: `x` armed the delete chord behind the card (`pickerLines`' card branch returns before
   * `PICKER_DELETE_HINT` is ever built, so nothing on screen said so) and the following `y` reached
   * `deleteConfirm`, which the App turns into `moveRunsToTrash`. A run directory in the trash with no visible
   * arm is exactly what the two-key chord exists to prevent, and "the card never steals a landed key" was the
   * wrong reading of row 91 — the row says only r/f/d/w and Esc route.
   */
  it('everything else is INERT while the card is open: no filter text, no preview, no rename, and `x` then `y` can never trash a run', () => {
    const p = st({ picker: true, pickerCard: 'open' });
    // the filter is inert: a printable that is not one of the four letters produces nothing at all
    for (const key of ['q', 'z', '1', 'g', 'e']) expect(acts(p, text(key)), key).toEqual([]);
    // Space is `picker:preview` in the list and nothing here
    expect(acts(p, text(' '))).toEqual([]);
    // Ctrl-R cannot start a rename the card's own keys row does not advertise
    expect(acts(p, k('ctrl+r'))).toEqual([]);
    // Ctrl-A cannot widen the list that is not on screen
    expect(acts(p, k('ctrl+a'))).toEqual([]);
    // and the chord: `x` does not arm …
    const armed = after(p, text('x'), 0);
    expect(acts(p, text('x'))).toEqual([]);
    // … so a `y` inside the window is not a confirmation of anything
    expect(acts(armed, text('y'), 10)).toEqual([]);
    // the same `x` `y` pair in the LIST is round 3's arm-then-confirm, unchanged
    const list = st({ picker: true });
    expect(acts(list, text('x')).at(-1)).toEqual({ type: 'picker', op: 'deleteArm' });
    expect(acts(after(list, text('x'), 0), text('y'), 10)).toEqual([{ type: 'picker', op: 'deleteConfirm' }]);
    // a paste is filter text too, and filter text is inert
    expect(acts(p, paste('anything'))).toEqual([]);
  });
});
