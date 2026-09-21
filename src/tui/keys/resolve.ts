/**
 * The one key resolver (TUI-DESIGN §3.1–§3.3, F4, F5): `resolveKey(ui, k, nowMs)` turns one Ink
 * `useInput` event (or a paste, or the Esc re-buffer's expiry) into the ordered list of actions the
 * controller executes. Pure: no I/O, no clock (the caller passes `nowMs`), no Ink import. Contexts in
 * precedence order: Minsize · Overlay · Picker · Composer · Global. The arm windows (Ctrl-C, Esc, Ctrl-D,
 * the Esc re-buffer, chords) live in `KeyState.armed`; every change is returned as an `arm` action so the
 * caller stores it — the resolver itself never mutates its input.
 */
import type { OverlayKind } from '../layout.js';
import { DEFAULT_BINDINGS, isChordPrefix, lookupBinding, type Bindings, type KeyContext } from './bindings.js';
import { CHORD_WINDOW_MS, ESC_REBUFFER_MS, WHY_WINDOW_MS, reduceInterrupts, type InterruptAction } from './interrupts.js';

/** TUI-DESIGN §3.1: the boolean part of Ink 7.1.1's `Key` (kitty fields included for forward compatibility). */
export interface KeyFlags {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
  super: boolean;
  hyper: boolean;
  eventType?: 'press' | 'repeat' | 'release';
}

/** TUI-DESIGN §3.1: one input event as `<App>` sees it. */
export interface KeyEvent {
  /** Ink's `input` (the sequence with a leading ESC stripped; '' for named keys) */
  readonly input: string;
  readonly key: KeyFlags;
  /**
   * parse-keypress's key name when the caller has it (`f1`…`f12`, `insert`); Ink's `useInput` delivers
   * F1 as `input === ''` with every flag false, so F1 is only recognisable through this field.
   */
  readonly name?: string;
  /** true for a `usePaste` body (bracketed paste) */
  readonly paste?: boolean;
  /** the Esc re-buffer timer fired: act as a lone Esc for the current state (§3.3) */
  readonly escExpired?: boolean;
}

/**
 * TUI-DESIGN §15 item 20 `RunPhase` as the resolver sees it (no `'paused'`: a blocking pause is overlay
 * `'blocking'` with run `'live'`, §13.3, and `human_pause` ends the run). Mirrors the design's union
 * verbatim until O1 lands `RunPhase` in `src/core/types.ts`; then this becomes a re-export.
 */
export type KeyRunPhase = 'none' | 'starting' | 'live' | 'aborting' | 'pausing';

/**
 * TUI-DESIGN §3.3 / §3.4: arm timestamps. `chord.first` is either the canonical first key of a two-key
 * §3.4 binding (`ctrl+x`) or the action id of one of the two built-in two-step actions — `review:why`
 * (`w` then 1–5, §6.2) and `picker:delete` (`x` then `y`, §8.4) — so a rebound `w`/`x` never collides
 * with a user chord (an action id contains `:`, a key string never does).
 */
export interface Armed {
  ctrlCAt: number | null;
  escAt: number | null;
  ctrlDAt: number | null;
  escBufferAt: number | null;
  chord: { first: string; at: number } | null;
}

/** TUI-DESIGN §6.2: `armed.chord.first` while `w` waits for its digit. */
export const WHY_ARM = 'review:why';
/** TUI-DESIGN §8.4: `armed.chord.first` while `x` waits for its `y`. */
export const DELETE_ARM = 'picker:delete';

/**
 * TUI-DESIGN §3.1 `KeyState` — the mirror the resolver reads. Additive to the design's shape: `picker`
 * (the session/rewind picker is modal in the pane slot, §3.1), `overlayArmed` (every y-gated overlay is
 * armed one frame after it is drawn, §6.3; `reviewArmed` keeps the review's own flag), `minsize` (rows < 8,
 * §3.1's first context) and `armed.chord` (§3.4 chords, `w`+digit, `x`+`y`).
 */
export interface KeyState {
  overlay: OverlayKind;
  /** the review box was drawn on a previous frame (§6.4) */
  reviewArmed: boolean;
  run: KeyRunPhase;
  draftEmpty: boolean;
  /** the cursor's visual row; `'only'` = a one-row draft, which is both the first and the last row (§4.6: Up recalls older, Down newer) */
  cursorRow: 'first' | 'mid' | 'last' | 'only';
  historySearch: boolean;
  /** queued steers */
  queue: number;
  mode: 'session' | 'one-shot';
  /** the review's `d` note field owns the composer row */
  noteMode: boolean;
  armed: Armed;
  /** the session / rewind picker is open in the pane slot (composer = filter) */
  picker: boolean;
  /** a y-gated overlay other than the review was drawn on a committed frame ≥ 150 ms after the Enter (§6.3) */
  overlayArmed: boolean;
  /** rows < 8: Ctrl-C/D, Enter and text only (§3.1), plus Ctrl+Z / Ctrl+L (§14.2 terminal hygiene) */
  minsize: boolean;
  /** the retry row is up (`UiState.retrying !== null`, §13.2): a bare `r` on an empty draft is `[r] retry now` */
  retrying: boolean;
}

/** TUI-DESIGN §3.1: a fresh state for a mounted session or one-shot renderer. */
export function initialKeyState(mode: 'session' | 'one-shot' = 'session'): KeyState {
  return {
    overlay: 'none',
    reviewArmed: false,
    run: 'none',
    draftEmpty: true,
    cursorRow: 'first',
    historySearch: false,
    queue: 0,
    mode,
    noteMode: false,
    armed: { ctrlCAt: null, escAt: null, ctrlDAt: null, escBufferAt: null, chord: null },
    picker: false,
    overlayArmed: false,
    minsize: false,
    retrying: false,
  };
}

/** TUI-DESIGN §4.1 motions the resolver emits (word motions use the composer's segmenter). */
export type Motion = 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'wordLeft' | 'wordRight';

/** TUI-DESIGN §3.1: what the controller executes, in order. */
export type KeyAction =
  | { type: 'arm'; armed: Armed }
  | { type: 'interrupt'; action: InterruptAction }
  | { type: 'escBuffer' }
  | { type: 'insert'; text: string }
  | { type: 'paste'; text: string }
  | { type: 'newline' }
  | { type: 'submit' }
  | { type: 'move'; to: Motion }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'kill'; what: 'toEnd' | 'toStart' | 'wordBack' | 'wordForward' }
  | { type: 'yank' }
  | { type: 'yankPop' }
  | { type: 'transpose' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'history'; dir: -1 | 1 }
  | { type: 'unsteer' }
  | { type: 'retryNow' }
  | { type: 'historySearch'; op: 'open' | 'older' | 'newer' | 'accept' | 'acceptSubmit' | 'cancel' | 'widen' | 'backspace' | 'query'; text?: string }
  | { type: 'complete'; dir: 1 | -1 }
  | { type: 'openPalette' }
  | { type: 'openMention' }
  | { type: 'help' }
  | { type: 'detail' }
  | { type: 'editor' }
  | { type: 'repaint' }
  | { type: 'suspend' }
  | { type: 'paneTab'; dir: 1 | -1 }
  /** TUI-DESIGN-2 §4.6: Alt+J toggles the panel, Alt+Shift+J opens it full, Alt+D/P/T/S open a tab (a second press on the same tab collapses) */
  | { type: 'panel'; op: 'toggle' | 'full' | 'tab'; tab?: 'd' | 'p' | 't' | 's' }
  | { type: 'export' }
  | { type: 'palette'; op: 'move' | 'page' | 'accept' | 'run' | 'close'; by?: -1 | 1 }
  | { type: 'picker'; op: 'move' | 'page' | 'open' | 'accept' | 'preview' | 'allWorkspaces' | 'rename' | 'deleteArm' | 'deleteConfirm' | 'close'; by?: -1 | 1 }
  | { type: 'review'; op: 'approve' | 'decline' | 'note' | 'expand' | 'whyArm' | 'why' | 'noteSubmit' | 'noteCancel'; dim?: 1 | 2 | 3 | 4 | 5 }
  | { type: 'gate'; op: 'send' | 'dismiss' }
  | { type: 'followup'; op: 'start' | 'raise' | 'cancel' }
  | { type: 'undoPrompt'; op: 'yes' | 'no' | 'all' | 'skipRest' | 'abort' }
  | { type: 'exitConfirm'; op: 'abortExit' | 'stay' }
  /** TUI-DESIGN-2 §3.7: the intake card — `y` runs (armed), `n` replies from the answers in hand, Esc / Ctrl-C keep the text */
  | { type: 'intake'; op: 'run' | 'chat' | 'keep' }
  | { type: 'wizard'; op: 'input' | 'submit' | 'back' | 'backspace' | 'clear'; text?: string }
  | { type: 'blocking'; key: 'r' | 'c' | 'q' | 'p' | 'l' }
  | { type: 'toast'; text: string }
  | { type: 'filtered'; reason: string };

/** TUI-DESIGN §24: the toast for a non-key printable while the review box owns the input. */
export const REVIEW_PENDING_TOAST = 'review pending: y n d e w · Esc declines';
/** TUI-DESIGN-2 §3.7 / §12 "Status": the toast for a printable while the intake card owns the input. */
export const INTAKE_PENDING_TOAST = 'intake pending: y n · Esc keeps the text';

const CSI_LEAK = /^\[(?:I|O|\?\d+[uc]|\d+;\d+R|27;\d+;\d+~|<\d+;\d+;\d+[Mm]|\?62;[\d;]*c)$/;
const OSC_LEAK = /^\]\d+;/;
const XTERM_NEWLINE = /^\[27;[2-8];13~$/;

let graphemes: Intl.Segmenter | null = null;
/** one lazily created grapheme segmenter (never on the first-frame path, §4.1) */
function graphemeCount(s: string): number {
  if (s.length < 2) return s.length;
  graphemes ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let n = 0;
  for (const _ of graphemes.segment(s)) {
    n++;
    if (n > 1) return n;
  }
  return n;
}

function isCtrl(k: KeyEvent, letter: string): boolean {
  return k.key.ctrl && !k.key.meta && k.input === letter;
}

/** true when the event is a lone Enter (no shift/meta — those are newline keys) */
function isEnter(k: KeyEvent): boolean {
  return k.key.return && !k.key.shift && !k.key.meta && !k.key.ctrl;
}

/** TUI-DESIGN §3.2 row 2: the universal newline keys */
function isNewlineKey(k: KeyEvent): boolean {
  if (k.key.return && (k.key.meta || k.key.shift)) return true;
  if (!k.key.ctrl && !k.key.meta && k.input === '\n') return true;
  if (!k.key.ctrl && !k.key.meta && XTERM_NEWLINE.test(k.input)) return true;
  return false;
}

function hasNamedKey(k: KeyEvent): boolean {
  const f = k.key;
  return f.upArrow || f.downArrow || f.leftArrow || f.rightArrow || f.pageUp || f.pageDown || f.home || f.end || f.return || f.escape || f.tab || f.backspace || f.delete;
}

/** TUI-DESIGN §3.4: the canonical key string of an event (`ctrl+k`, `meta+b`, `shift+tab`, `up`, `?`); null for text that is not a single key. */
export function keyString(k: KeyEvent): string | null {
  const f = k.key;
  const mods = `${f.ctrl ? 'ctrl+' : ''}${f.meta ? 'meta+' : ''}`;
  const named = f.upArrow
    ? 'up'
    : f.downArrow
      ? 'down'
      : f.leftArrow
        ? 'left'
        : f.rightArrow
          ? 'right'
          : f.pageUp
            ? 'pageup'
            : f.pageDown
              ? 'pagedown'
              : f.home
                ? 'home'
                : f.end
                  ? 'end'
                  : f.return
                    ? 'return'
                    : f.escape
                      ? 'escape'
                      : f.tab
                        ? 'tab'
                        : f.backspace
                          ? 'backspace'
                          : f.delete
                            ? 'delete'
                            : null;
  if (named !== null) return `${mods}${f.shift ? 'shift+' : ''}${named}`;
  if (k.name !== undefined && /^f\d{1,2}$/.test(k.name) && k.input === '') return `${mods}${k.name}`;
  if (k.name === 'insert' && k.input === '') return `${mods}insert`;
  const cps = [...k.input];
  if (cps.length !== 1) return null;
  const ch = cps[0] as string;
  if (ch === '\u001f') return 'ctrl+_';
  if (ch === '\u001e') return 'ctrl+^';
  if (ch === '\u001a') return 'ctrl+z';
  if (ch === '\n') return 'ctrl+j';
  if (ch === ' ') return `${mods}space`;
  // TUI-DESIGN-2 §4.6: a shifted letter under a modifier keeps its shift (`meta+shift+j` is Alt+Shift+J, never Alt+J)
  if ((f.ctrl || f.meta) && /^[a-z]$/i.test(ch)) return `${mods}${f.shift || ch !== ch.toLowerCase() ? 'shift+' : ''}${ch.toLowerCase()}`;
  if (f.ctrl || f.meta) return `${mods}${ch.toLowerCase()}`;
  return ch;
}

/** TUI-DESIGN §4.4: text the composer may insert — no modifiers, no named key, at least one code point ≥ 0x20 or a tab. */
export function isPrintable(k: KeyEvent): boolean {
  if (k.key.ctrl || k.key.meta || k.key.super || k.key.hyper) return false;
  if (hasNamedKey(k)) return false;
  if (k.input === '') return false;
  if (k.name !== undefined && /^f\d{1,2}$/.test(k.name)) return false;
  if (k.input.length === 1 && k.input < ' ') return k.input === '\t';
  return true;
}

/** a key that may complete a Meta chord after a lone ESC (a printable, Enter, Backspace, Delete) — never a bracketed paste */
function chordable(k: KeyEvent): boolean {
  if (k.paste === true) return false;
  if (k.key.ctrl || k.key.meta || k.key.escape) return false;
  if (k.key.return || k.key.backspace || k.key.delete) return true;
  return isPrintable(k) && graphemeCount(k.input) === 1;
}

function textActions(k: KeyEvent): KeyAction[] {
  if (k.input.length > 1) {
    if (CSI_LEAK.test(k.input) || OSC_LEAK.test(k.input)) return [{ type: 'filtered', reason: 'csi-leak' }];
    if (graphemeCount(k.input) > 1) return [{ type: 'paste', text: k.input }];
  }
  return [{ type: 'insert', text: k.input }];
}

function filtered(reason: string): KeyAction[] {
  return [{ type: 'filtered', reason }];
}

function chordFirst(s: KeyState, first: string, now: number, windowMs: number): boolean {
  const c = s.armed.chord;
  return c !== null && c.first === first && now - c.at >= 0 && now - c.at <= windowMs;
}

interface Step {
  state: KeyState;
  actions: KeyAction[];
}

function withArmed(s: KeyState, patch: Partial<Armed>): KeyState {
  return { ...s, armed: { ...s.armed, ...patch } };
}

function interrupt(s: KeyState, key: 'ctrl-c' | 'esc' | 'ctrl-d', now: number): Step {
  const r = reduceInterrupts(s, key, now);
  const actions: KeyAction[] = [];
  if (r.action === 'DELETE_FORWARD') actions.push({ type: 'delete' });
  else if (r.action !== 'NONE') actions.push({ type: 'interrupt', action: r.action });
  return { state: r.state, actions };
}

/** the action id → KeyAction table for the composer and global contexts */
function composerAction(id: string, s: KeyState, k: KeyEvent): KeyAction[] | null {
  switch (id) {
    case 'global:help':
      return s.draftEmpty || k.input === '' ? [{ type: 'help' }] : textActions(k);
    case 'global:detail':
      return [{ type: 'detail' }];
    case 'global:repaint':
      return [{ type: 'repaint' }];
    case 'global:suspend':
      return [{ type: 'suspend' }];
    case 'global:paneNext':
      return s.draftEmpty ? [{ type: 'paneTab', dir: 1 }] : textActions(k);
    case 'global:panePrev':
      return s.draftEmpty ? [{ type: 'paneTab', dir: -1 }] : textActions(k);
    case 'global:panelToggle':
      return [{ type: 'panel', op: 'toggle' }];
    case 'global:panelFull':
      return [{ type: 'panel', op: 'full' }];
    case 'global:panelDecisions':
      return [{ type: 'panel', op: 'tab', tab: 'd' }];
    case 'global:panelPlan':
      return [{ type: 'panel', op: 'tab', tab: 'p' }];
    case 'global:panelTimeline':
      return [{ type: 'panel', op: 'tab', tab: 't' }];
    case 'global:panelSynth':
      return [{ type: 'panel', op: 'tab', tab: 's' }];
    case 'session:export':
      return [{ type: 'export' }];
    case 'composer:newline':
      return [{ type: 'newline' }];
    case 'composer:lineStart':
      return [{ type: 'move', to: 'home' }];
    case 'composer:lineEnd':
      return [{ type: 'move', to: 'end' }];
    case 'composer:left':
      return [{ type: 'move', to: 'left' }];
    case 'composer:right':
      return [{ type: 'move', to: 'right' }];
    case 'composer:wordLeft':
      return [{ type: 'move', to: 'wordLeft' }];
    case 'composer:wordRight':
      return [{ type: 'move', to: 'wordRight' }];
    case 'composer:killLine':
      return [{ type: 'kill', what: 'toEnd' }];
    case 'composer:killLineBack':
      return [{ type: 'kill', what: 'toStart' }];
    case 'composer:killWordBack':
      return [{ type: 'kill', what: 'wordBack' }];
    case 'composer:killWordForward':
      return [{ type: 'kill', what: 'wordForward' }];
    case 'composer:yank':
      return [{ type: 'yank' }];
    case 'composer:yankPop':
      return [{ type: 'yankPop' }];
    case 'composer:transpose':
      return [{ type: 'transpose' }];
    case 'composer:undo':
      return [{ type: 'undo' }];
    case 'composer:redo':
      return [{ type: 'redo' }];
    case 'composer:backspace':
      return [{ type: 'backspace' }];
    case 'composer:delete':
      return [{ type: 'delete' }];
    case 'composer:up':
      // §3.2 / §4.6: history on the first visual row; a one-row draft (`'only'`) is its first and last row at once
      if (s.cursorRow === 'first' || s.cursorRow === 'only' || s.draftEmpty) return s.queue > 0 && s.draftEmpty ? [{ type: 'unsteer' }] : [{ type: 'history', dir: -1 }];
      return [{ type: 'move', to: 'up' }];
    case 'composer:down':
      if (s.cursorRow === 'last' || s.cursorRow === 'only' || s.draftEmpty) return [{ type: 'history', dir: 1 }];
      return [{ type: 'move', to: 'down' }];
    case 'composer:historyPrev':
      return [{ type: 'history', dir: -1 }];
    case 'composer:historyNext':
      return [{ type: 'history', dir: 1 }];
    case 'composer:historySearch':
      return [{ type: 'historySearch', op: 'open' }];
    case 'composer:complete':
      return [{ type: 'complete', dir: 1 }];
    case 'composer:completeBack':
      return [{ type: 'complete', dir: -1 }];
    case 'composer:palette':
      return s.draftEmpty ? [{ type: 'insert', text: k.input }, { type: 'openPalette' }] : textActions(k);
    case 'composer:mention':
      return [{ type: 'insert', text: k.input }, { type: 'openMention' }];
    case 'composer:externalEditor':
      return [{ type: 'editor' }];
    default:
      return null;
  }
}

/** true when `armed.chord` is a §3.4 key chord (not one of the two built-in two-step arms) */
function isKeyChord(c: { first: string }): boolean {
  return !c.first.includes(':');
}

interface Lookup {
  id: string | null;
  state: KeyState;
  /** the key started a chord: hold it (3 s) and do nothing else */
  armedChord: boolean;
  /** a chord was armed but this key completes no binding: the key is swallowed (Emacs `C-x y is undefined`) */
  chordMiss: boolean;
}

/**
 * TUI-DESIGN §3.4: look a key up in `contexts` in order, honouring an armed chord (completed within 3 s;
 * an unbound completion is a miss, never the second key on its own) and arming a chord prefix. A single
 * binding wins over a chord prefix, which is why `buildBindings` reports that collision.
 */
function lookup(s: KeyState, ks: string, contexts: readonly KeyContext[], now: number, b: Bindings): Lookup {
  const c = s.armed.chord;
  if (c !== null && isKeyChord(c)) {
    const state = withArmed(s, { chord: null });
    if (now - c.at >= 0 && now - c.at <= CHORD_WINDOW_MS) {
      for (const ctx of contexts) {
        const id = lookupBinding(b, ctx, `${c.first} ${ks}`);
        if (id !== null) return { id, state, armedChord: false, chordMiss: false };
      }
      return { id: null, state, armedChord: false, chordMiss: true };
    }
    return lookup(state, ks, contexts, now, b);
  }
  for (const ctx of contexts) {
    const id = lookupBinding(b, ctx, ks);
    if (id !== null) return { id, state: s, armedChord: false, chordMiss: false };
  }
  for (const ctx of contexts) {
    if (isChordPrefix(b, ctx, ks)) return { id: null, state: withArmed(s, { chord: { first: ks, at: now } }), armedChord: true, chordMiss: false };
  }
  return { id: null, state: s, armedChord: false, chordMiss: false };
}

function resolveComposer(s: KeyState, k: KeyEvent, now: number, b: Bindings, contexts: readonly KeyContext[]): Step {
  if (isCtrl(k, 'c')) return interrupt(s, 'ctrl-c', now);
  if (isCtrl(k, 'd')) return interrupt(s, 'ctrl-d', now);
  if (k.key.escape) {
    if (k.key.meta) {
      // ESC ESC in one chunk = Esc ×2
      const first = interrupt(s, 'esc', now);
      const second = interrupt(first.state, 'esc', now);
      return { state: second.state, actions: [...first.actions, ...second.actions] };
    }
    return interrupt(s, 'esc', now);
  }
  if (s.run === 'aborting') return { state: s, actions: [] }; // S6: printable, Enter and paste are ignored
  // any other key clears the Ctrl-C / Esc / Ctrl-D arms (§3.3 "other")
  const cleared = reduceInterrupts(s, 'other', now).state;
  if (k.paste) return { state: cleared, actions: [{ type: 'paste', text: k.input }] };
  if (isNewlineKey(k)) return { state: cleared, actions: [{ type: 'newline' }] };
  if (isEnter(k)) return { state: cleared, actions: s.draftEmpty ? [] : [{ type: 'submit' }] };
  // §13.2 `[r] retry now`: a bare `r` on an empty draft while the retry row is up (the `[`/`]` empty-draft rule's shape;
  // with a draft, or once `retry:settled` cleared the row, `r` is text again)
  if (s.retrying && s.draftEmpty && k.input === 'r' && !k.key.shift && isPrintable(k)) return { state: cleared, actions: [{ type: 'retryNow' }] };
  const ks = keyString(k);
  if (ks !== null) {
    const found = lookup(cleared, ks, contexts, now, b);
    if (found.armedChord) return { state: found.state, actions: [] };
    if (found.chordMiss) return { state: found.state, actions: filtered('unbound-chord') };
    if (found.id !== null) {
      const a = composerAction(found.id, found.state, k);
      if (a !== null) return { state: found.state, actions: a };
    }
    if (isPrintable(k)) return { state: found.state, actions: textActions(k) };
    return { state: found.state, actions: filtered(k.key.ctrl || k.key.meta ? 'unbound-modifier' : 'unbound-key') };
  }
  if (k.key.super || k.key.hyper) return { state: cleared, actions: filtered('super-hyper') };
  if (isPrintable(k)) return { state: cleared, actions: textActions(k) };
  return { state: cleared, actions: filtered('unbound-key') };
}

function resolveHistorySearch(s: KeyState, k: KeyEvent, now: number): Step {
  const hs = (op: Extract<KeyAction, { type: 'historySearch' }>['op'], text?: string): Step => ({
    state: s,
    actions: [text === undefined ? { type: 'historySearch', op } : { type: 'historySearch', op, text }],
  });
  if (k.paste) return hs('query', k.input);
  if (isCtrl(k, 'c') || k.key.escape) return hs('cancel');
  if (isEnter(k)) return hs('acceptSubmit');
  if (isCtrl(k, 'r')) return hs('older');
  if (isCtrl(k, 's')) return hs('newer');
  if (isCtrl(k, 'a')) return hs('widen');
  if ((k.key.tab && !k.key.shift) || k.key.rightArrow) return hs('accept');
  if (k.key.backspace) return hs('backspace');
  if (isPrintable(k) && !k.key.tab) return hs('query', k.input);
  void now;
  return { state: s, actions: [] };
}

function resolveReview(s: KeyState, k: KeyEvent, now: number, b: Bindings): Step {
  if (s.noteMode) {
    if (isCtrl(k, 'c')) return interrupt(s, 'ctrl-c', now);
    if (k.key.escape) return { state: s, actions: [{ type: 'review', op: 'noteCancel' }] };
    if (isEnter(k)) return { state: s, actions: [{ type: 'review', op: 'noteSubmit' }] };
    if (k.paste) return { state: s, actions: [{ type: 'paste', text: k.input }] };
    if (isNewlineKey(k) || k.key.tab) return { state: s, actions: [] }; // single-line note
    if (isCtrl(k, 'd')) return s.draftEmpty ? { state: s, actions: [] } : { state: s, actions: [{ type: 'delete' }] };
    const ks = keyString(k);
    if (ks !== null) {
      const id = lookupBinding(b, 'composer', ks);
      if (id !== null && id !== 'composer:palette' && id !== 'composer:mention' && id !== 'composer:historySearch' && id !== 'composer:externalEditor') {
        const a = composerAction(id, s, k);
        if (a !== null) return { state: s, actions: a };
      }
    }
    if (isPrintable(k)) return { state: s, actions: textActions(k) };
    return { state: s, actions: [] };
  }
  if (k.paste) return { state: s, actions: [] }; // a pasted string never matches a key (§6.2)
  if (isCtrl(k, 'c')) return interrupt(s, 'ctrl-c', now);
  if (isCtrl(k, 'd')) return interrupt(s, 'ctrl-d', now);
  if (k.key.escape) return interrupt(s, 'esc', now);
  if (isEnter(k) || isNewlineKey(k)) return { state: s, actions: [] }; // Enter never approves (A40)
  const ks = keyString(k);
  if (ks !== null) {
    if (/^[1-5]$/.test(ks) && chordFirst(s, WHY_ARM, now, WHY_WINDOW_MS)) {
      return { state: withArmed(s, { chord: null }), actions: [{ type: 'review', op: 'why', dim: Number(ks) as 1 | 2 | 3 | 4 | 5 }] };
    }
    const cleared = s.armed.chord?.first === WHY_ARM ? withArmed(s, { chord: null }) : s;
    const found = lookup(cleared, ks, ['review'], now, b);
    if (found.armedChord) return { state: found.state, actions: [] };
    if (found.chordMiss) return { state: found.state, actions: [] };
    switch (found.id) {
      case 'review:approve':
        return { state: found.state, actions: [{ type: 'review', op: 'approve' }] };
      case 'review:decline':
        return { state: found.state, actions: [{ type: 'review', op: 'decline' }] };
      case 'review:declineNote':
        return { state: found.state, actions: [{ type: 'review', op: 'note' }] };
      case 'review:expand':
        return { state: found.state, actions: [{ type: 'review', op: 'expand' }] };
      case 'review:why':
        return { state: withArmed(found.state, { chord: { first: WHY_ARM, at: now } }), actions: [{ type: 'review', op: 'whyArm' }] };
      default:
        break;
    }
    if (lookupBinding(b, 'global', ks) === 'global:detail') return { state: found.state, actions: [{ type: 'detail' }] };
    if (isPrintable(k)) return { state: found.state, actions: [{ type: 'toast', text: REVIEW_PENDING_TOAST }] };
    return { state: found.state, actions: [] };
  }
  if (isPrintable(k)) return { state: s, actions: [{ type: 'toast', text: REVIEW_PENDING_TOAST }] };
  return { state: s, actions: [] };
}

function resolveYGated(s: KeyState, k: KeyEvent, now: number, b: Bindings): Step {
  const none: Step = { state: s, actions: [] };
  const one = (a: KeyAction): Step => ({ state: s, actions: [a] });
  const y = !k.key.ctrl && !k.key.meta && (k.input === 'y' || k.input === 'Y');
  const n = !k.key.ctrl && !k.key.meta && (k.input === 'n' || k.input === 'N');
  switch (s.overlay) {
    case 'secret': {
      if (isCtrl(k, 'c')) return interrupt(s, 'ctrl-c', now); // cancel the send and clear the draft (§10.7)
      if (k.paste) return none;
      if (k.key.escape || isEnter(k) || isCtrl(k, 'd')) return one({ type: 'gate', op: 'dismiss' });
      // §4.10 / §6.3: only an armed `y` sends; an early one (before the committed frame + 150 ms) is ignored — never a
      // dismissal and never text, for the composer gate and the controller's argv-task prompt alike
      if (y) return s.overlayArmed ? one({ type: 'gate', op: 'send' }) : none;
      // anything else dismisses and is then handled by the composer
      const rest = resolveComposer({ ...s, overlay: 'none' }, k, now, b, ['composer', 'global']);
      return { state: { ...rest.state, overlay: s.overlay }, actions: [{ type: 'gate', op: 'dismiss' }, ...rest.actions] };
    }
    case 'followup':
      if (isCtrl(k, 'c') || k.key.escape) return one({ type: 'followup', op: 'cancel' });
      if (isEnter(k) || isCtrl(k, 'd') || k.paste) return none;
      if (y) return s.overlayArmed ? one({ type: 'followup', op: 'start' }) : none;
      if (!k.key.ctrl && !k.key.meta && k.input === 'r') return one({ type: 'followup', op: 'raise' });
      if (n) return one({ type: 'followup', op: 'cancel' });
      return none;
    case 'undo':
      if (isCtrl(k, 'c') || k.key.escape) return one({ type: 'undoPrompt', op: 'abort' });
      if (isEnter(k)) return one({ type: 'undoPrompt', op: 'no' });
      if (isCtrl(k, 'd') || k.paste) return none;
      if (y) return s.overlayArmed ? one({ type: 'undoPrompt', op: 'yes' }) : none;
      if (n) return one({ type: 'undoPrompt', op: 'no' });
      if (!k.key.ctrl && !k.key.meta && k.input === 'a') return one({ type: 'undoPrompt', op: 'all' });
      if (!k.key.ctrl && !k.key.meta && k.input === 's') return one({ type: 'undoPrompt', op: 'skipRest' });
      return none;
    case 'exitConfirm':
      if (isCtrl(k, 'c') || k.key.escape) return one({ type: 'exitConfirm', op: 'stay' });
      if (isEnter(k) || isCtrl(k, 'd') || k.paste) return none;
      if (y) return s.overlayArmed ? one({ type: 'exitConfirm', op: 'abortExit' }) : none;
      if (n) return one({ type: 'exitConfirm', op: 'stay' });
      return none;
    case 'intake':
      // TUI-DESIGN-2 §3.7: Esc / Ctrl-C keep the text; Enter inert; a paste never matches; `y` only once armed (committed frame + 150 ms)
      if (isCtrl(k, 'c') || k.key.escape) return one({ type: 'intake', op: 'keep' });
      if (isEnter(k) || isCtrl(k, 'd') || k.paste) return none;
      if (y) return s.overlayArmed ? one({ type: 'intake', op: 'run' }) : none;
      if (n) return one({ type: 'intake', op: 'chat' });
      if (isPrintable(k)) return one({ type: 'toast', text: INTAKE_PENDING_TOAST });
      return none;
    default:
      return none;
  }
}

function resolveWizard(s: KeyState, k: KeyEvent, now: number): Step {
  const one = (a: KeyAction): Step => ({ state: s, actions: [a] });
  if (isCtrl(k, 'c')) return interrupt(s, 'ctrl-c', now);
  if (k.paste) return one({ type: 'wizard', op: 'input', text: k.input });
  if (k.key.escape) return one({ type: 'wizard', op: 'back' });
  if (isEnter(k)) return one({ type: 'wizard', op: 'submit' });
  if (isCtrl(k, 'd') || isNewlineKey(k) || k.key.tab) return { state: s, actions: [] };
  if (isCtrl(k, 'u')) return one({ type: 'wizard', op: 'clear' });
  if (k.key.backspace || k.key.delete) return one({ type: 'wizard', op: 'backspace' });
  if (isPrintable(k)) return one({ type: 'wizard', op: 'input', text: k.input });
  return { state: s, actions: [] };
}

function resolveBlocking(s: KeyState, k: KeyEvent, now: number): Step {
  if (isCtrl(k, 'c')) return interrupt(s, 'ctrl-c', now);
  if (k.paste || k.key.escape || isEnter(k) || isCtrl(k, 'd')) return { state: s, actions: [] };
  if (!k.key.ctrl && !k.key.meta && /^[rcqpl]$/.test(k.input)) return { state: s, actions: [{ type: 'blocking', key: k.input as 'r' | 'c' | 'q' | 'p' | 'l' }] };
  if (isCtrl(k, 'o')) return { state: s, actions: [{ type: 'detail' }] };
  return { state: s, actions: [] };
}

function resolvePalette(s: KeyState, k: KeyEvent, now: number, b: Bindings): Step {
  const one = (a: KeyAction): Step => ({ state: s, actions: [a] });
  if (isCtrl(k, 'c')) return interrupt(s, 'ctrl-c', now);
  if (isCtrl(k, 'd')) return interrupt(s, 'ctrl-d', now);
  if (k.key.escape) return interrupt(s, 'esc', now);
  if (k.paste) return one({ type: 'paste', text: k.input });
  if (isEnter(k)) return one({ type: 'palette', op: 'run' });
  if (isNewlineKey(k)) return { state: s, actions: [] };
  const ks = keyString(k);
  if (ks !== null) {
    const found = lookup(s, ks, ['palette'], now, b);
    if (found.armedChord) return { state: found.state, actions: [] };
    if (found.chordMiss) return { state: found.state, actions: [] };
    const at = (a: KeyAction): Step => ({ state: found.state, actions: [a] });
    switch (found.id) {
      case 'palette:up':
        return at({ type: 'palette', op: 'move', by: -1 });
      case 'palette:down':
        return at({ type: 'palette', op: 'move', by: 1 });
      case 'palette:pageUp':
        return at({ type: 'palette', op: 'page', by: -1 });
      case 'palette:pageDown':
        return at({ type: 'palette', op: 'page', by: 1 });
      case 'palette:accept':
        return at({ type: 'palette', op: 'accept' });
      default:
        break;
    }
    if (k.key.tab && k.key.shift) return at({ type: 'palette', op: 'move', by: -1 });
    const cid = lookupBinding(b, 'composer', ks) ?? lookupBinding(b, 'global', ks);
    if (cid !== null && cid !== 'composer:palette' && cid !== 'composer:mention' && cid !== 'composer:up' && cid !== 'composer:down' && cid !== 'composer:historyPrev' && cid !== 'composer:historyNext' && cid !== 'composer:complete' && cid !== 'composer:completeBack' && cid !== 'global:help' && cid !== 'global:paneNext' && cid !== 'global:panePrev') {
      const a = composerAction(cid, { ...found.state, draftEmpty: false }, k);
      if (a !== null) return { state: found.state, actions: a };
    }
    if (isPrintable(k)) return { state: found.state, actions: textActions(k) };
    return { state: found.state, actions: [] };
  }
  if (isPrintable(k)) return { state: s, actions: textActions(k) };
  return { state: s, actions: [] };
}

function resolvePicker(s: KeyState, k: KeyEvent, now: number, b: Bindings): Step {
  const one = (a: KeyAction, state: KeyState = s): Step => ({ state, actions: [a] });
  if (isCtrl(k, 'c') || k.key.escape) return one({ type: 'picker', op: 'close' });
  if (isCtrl(k, 'd') || isNewlineKey(k)) return { state: s, actions: [] };
  if (k.paste) return one({ type: 'paste', text: k.input });
  if (isEnter(k)) return one({ type: 'picker', op: 'open' });
  const ks = keyString(k);
  if (ks !== null) {
    if (ks === 'y' && chordFirst(s, DELETE_ARM, now, CHORD_WINDOW_MS)) return one({ type: 'picker', op: 'deleteConfirm' }, withArmed(s, { chord: null }));
    const armedDelete = s.armed.chord?.first === DELETE_ARM ? withArmed(s, { chord: null }) : s;
    const found = lookup(armedDelete, ks, ['picker'], now, b);
    if (found.armedChord) return { state: found.state, actions: [] };
    if (found.chordMiss) return { state: found.state, actions: [] };
    const cleared = found.state;
    switch (found.id) {
      case 'picker:up':
        return one({ type: 'picker', op: 'move', by: -1 }, cleared);
      case 'picker:down':
        return one({ type: 'picker', op: 'move', by: 1 }, cleared);
      case 'picker:pageUp':
        return one({ type: 'picker', op: 'page', by: -1 }, cleared);
      case 'picker:pageDown':
        return one({ type: 'picker', op: 'page', by: 1 }, cleared);
      case 'picker:accept':
        return one({ type: 'picker', op: 'accept' }, cleared);
      case 'picker:preview':
        return one({ type: 'picker', op: 'preview' }, cleared);
      case 'picker:allWorkspaces':
        return one({ type: 'picker', op: 'allWorkspaces' }, cleared);
      case 'picker:rename':
        return one({ type: 'picker', op: 'rename' }, cleared);
      case 'picker:delete':
        return one({ type: 'picker', op: 'deleteArm' }, withArmed(cleared, { chord: { first: DELETE_ARM, at: now } }));
      default:
        break;
    }
    const cid = lookupBinding(b, 'composer', ks) ?? lookupBinding(b, 'global', ks);
    if (cid !== null && (cid.startsWith('composer:kill') || cid === 'composer:left' || cid === 'composer:right' || cid === 'composer:lineStart' || cid === 'composer:lineEnd' || cid === 'composer:wordLeft' || cid === 'composer:wordRight' || cid === 'composer:backspace' || cid === 'composer:delete' || cid === 'composer:undo' || cid === 'composer:redo' || cid === 'global:repaint' || cid === 'global:detail')) {
      const a = composerAction(cid, { ...cleared, draftEmpty: false }, k);
      if (a !== null) return { state: cleared, actions: a };
    }
    if (isPrintable(k)) return { state: cleared, actions: textActions(k) };
    return { state: cleared, actions: [] };
  }
  if (isPrintable(k)) return { state: s, actions: textActions(k) };
  return { state: s, actions: [] };
}

function resolveMinsize(s: KeyState, k: KeyEvent, now: number): Step {
  if (isCtrl(k, 'c')) return interrupt(s, 'ctrl-c', now);
  if (isCtrl(k, 'd')) return interrupt(s, 'ctrl-d', now);
  if (k.paste) return { state: s, actions: [{ type: 'paste', text: k.input }] };
  if (isEnter(k)) return { state: s, actions: s.draftEmpty ? [] : [{ type: 'submit' }] };
  if (isNewlineKey(k)) return { state: s, actions: [{ type: 'newline' }] };
  if (k.key.backspace) return { state: s, actions: [{ type: 'backspace' }] };
  if (k.key.delete) return { state: s, actions: [{ type: 'delete' }] };
  if (k.key.leftArrow) return { state: s, actions: [{ type: 'move', to: 'left' }] };
  if (k.key.rightArrow) return { state: s, actions: [{ type: 'move', to: 'right' }] };
  if (isPrintable(k)) return { state: s, actions: textActions(k) };
  return { state: s, actions: [] };
}

/**
 * TUI-DESIGN §3.1 Global / §14.2: Ctrl+Z (suspend) and Ctrl+L (repaint) are terminal hygiene, not composer
 * keys — in raw mode the byte never reaches the shell, so they must work in every context (picker, armed
 * review, wizard, blocking pane, minsize, palette, history search). Only a non-printable binding is honoured
 * here (a printable rebinding would hijack the wizard's key field); it counts as "other" for the arms.
 */
function globalStructural(s: KeyState, k: KeyEvent, now: number, b: Bindings): Step | null {
  if (k.paste === true || isPrintable(k)) return null;
  const ks = keyString(k);
  if (ks === null) return null;
  const id = lookupBinding(b, 'global', ks);
  if (id !== 'global:suspend' && id !== 'global:repaint') return null;
  return { state: reduceInterrupts(s, 'other', now).state, actions: [id === 'global:suspend' ? { type: 'suspend' } : { type: 'repaint' }] };
}

/** one event against one state, the Esc re-buffer already applied */
function resolveOne(s: KeyState, k: KeyEvent, now: number, b: Bindings): Step {
  const structural = globalStructural(s, k, now, b);
  if (structural !== null) return structural;
  if (s.minsize) return resolveMinsize(s, k, now);
  switch (s.overlay) {
    case 'review':
      if (s.reviewArmed) return resolveReview(s, k, now, b);
      // §6.3: the box is drawn but not yet armed. Nothing typed may reach the composer any more (a `y` here became
      // draft text in the first live session, docs/live/tui attempt 2) and nothing may approve: printable keys and
      // pastes get the pending toast, everything else is ignored. The deferral BEFORE the box (overlay still 'none')
      // is the phase in which keys go to the composer as text. Ctrl-C kept its live-run meaning in globalStructural.
      if (k.key.ctrl && (k.input === 'c' || k.input === 'd')) break; // Ctrl-C / Ctrl-D keep their live-run meaning (F5) through the composer path
      return { state: s, actions: isPrintable(k) || k.paste === true ? [{ type: 'toast', text: REVIEW_PENDING_TOAST }] : [] };
    case 'wizard':
      return resolveWizard(s, k, now);
    case 'blocking':
      return resolveBlocking(s, k, now);
    case 'secret':
    case 'followup':
    case 'undo':
    case 'exitConfirm':
    case 'intake':
      return resolveYGated(s, k, now, b);
    case 'palette':
      return resolvePalette(s, k, now, b);
    default:
      break;
  }
  if (s.picker) return resolvePicker(s, k, now, b);
  if (s.historySearch) return resolveHistorySearch(s, k, now);
  return resolveComposer(s, k, now, b, ['composer', 'global']);
}

const PLAIN_ESC: KeyEvent = {
  input: '',
  key: { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, home: false, end: false, return: false, escape: true, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, super: false, hyper: false },
  escExpired: true,
};

function sameArmed(a: Armed, b: Armed): boolean {
  return a.ctrlCAt === b.ctrlCAt && a.escAt === b.escAt && a.ctrlDAt === b.ctrlDAt && a.escBufferAt === b.escBufferAt && a.chord === b.chord;
}

/**
 * TUI-DESIGN §3.1 `resolveKey` — every key goes through here, never through handler order. Returns the
 * actions in execution order; an `arm` action (first) carries the new `KeyState.armed` whenever a window
 * changed. Esc re-buffer (§3.3): a lone Esc arms `escBufferAt` and returns `escBuffer` (the caller starts
 * a 30 ms timer and re-dispatches with `escExpired: true`); a printable / Enter / Backspace inside the
 * window is re-dispatched as the Meta chord; a later key first fires the pending Esc. `eventType`
 * release/repeat are dropped (A5). `d p t s` are never keys: on an empty composer only `[`, `]`, `/`, `@`
 * and `?` are bound (plus `r` while the retry row is up, §13.2). A bracketed paste never completes a Meta chord (the pending Esc fires first). Ctrl+Z
 * and Ctrl+L (§14.2) resolve in every context; a §3.4 chord arms in every context that binds one.
 */
export function resolveKey(ui: KeyState, k: KeyEvent, nowMs: number, bindings: Bindings = DEFAULT_BINDINGS): KeyAction[] {
  if (k.key.eventType === 'release' || k.key.eventType === 'repeat') return filtered('event-type');
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  let state = ui;
  const actions: KeyAction[] = [];
  let ev = k;
  const loneEsc = ev.key.escape && ev.input === '' && !ev.key.meta && ev.paste !== true && ev.escExpired !== true;
  const bufAt = state.armed.escBufferAt;
  if (ev.escExpired === true) {
    if (bufAt === null) return []; // a stale timer: the buffer was already consumed
    state = withArmed(state, { escBufferAt: null });
    ev = PLAIN_ESC;
  } else if (bufAt !== null) {
    state = withArmed(state, { escBufferAt: null });
    if (!loneEsc && now - bufAt >= 0 && now - bufAt <= ESC_REBUFFER_MS && chordable(ev)) {
      ev = { ...ev, key: { ...ev.key, meta: true } };
    } else {
      // another key (or a second Esc): the pending Esc fires first, then this key is resolved on its own
      const esc = resolveOne(state, PLAIN_ESC, now, bindings);
      state = esc.state;
      actions.push(...esc.actions);
    }
  }
  if (loneEsc) {
    state = withArmed(state, { escBufferAt: now });
    return [{ type: 'arm', armed: state.armed }, ...actions, { type: 'escBuffer' }];
  }
  const step = resolveOne(state, ev, now, bindings);
  actions.push(...step.actions);
  const out: KeyAction[] = sameArmed(step.state.armed, ui.armed) ? [] : [{ type: 'arm', armed: step.state.armed }];
  out.push(...actions);
  return out;
}
