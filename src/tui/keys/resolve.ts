/**
 * The one key resolver (TUI-DESIGN §3.1–§3.3, F4, F5): `resolveKey(ui, k, nowMs)` turns one Ink
 * `useInput` event (or a paste, or the Esc re-buffer's expiry) into the ordered list of actions the
 * controller executes. Pure: no I/O, no clock (the caller passes `nowMs`), no Ink import. Contexts in
 * precedence order: Minsize · Overlay · Picker · Composer · Global. The arm windows (Ctrl-C, Esc, Ctrl-D,
 * the Esc re-buffer, chords) live in `KeyState.armed`; every change is returned as an `arm` action so the
 * caller stores it — the resolver itself never mutates its input.
 */
import { FOCUS_REFUSED } from '../agents/lines.js';
import type { OverlayKind } from '../layout.js';
import { COMMAND_KEY_ACTIONS, DEFAULT_BINDINGS, isChordPrefix, lookupBinding, type Bindings, type KeyContext } from './bindings.js';
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
  /**
   * TUI-DESIGN-4 §4.7 E12 / E13: the whole draft is a `/token` (`draft.trim() === commandToken(draft.trim())`).
   * Optional and **false by default**, so both rules are inert until the controller supplies it (§9.2's `App.tsx`
   * request): Ctrl-C then also clears the draft, and `/` at the end of such a draft **reopens** the palette — it is
   * not inserted, because a second slash would make the draft `/mode/`, a token that matches nothing.
   */
  draftTokenOnly?: boolean;
  /** TUI-DESIGN-4 §4.7 E13: the cursor sits at the end of the draft — the reopen rule never fires mid-token. */
  cursorAtEnd?: boolean;
  /**
   * TUI-DESIGN-5 §4.3 (§14.2 #41): the pane holds focus. Optional and **false by default**, so the whole agents
   * rung is inert until the controller supplies it — `UiState.paneFocus` (`src/tui/useEngine.tsx`) is its source.
   */
  paneFocus?: boolean;
  /** TUI-DESIGN-5 §4.3: the pane's active tab. The agents rung resolves only for `'a'`. */
  tab?: 'd' | 'p' | 't' | 's' | 'a';
  /**
   * TUI-DESIGN-5 §2.8: the picker's expanded resume card. **Three states, not a boolean**, and `'off'` by default —
   *  - `'off'` (round 3, unchanged): this picker has no card. Enter resumes the row, Esc closes the picker, and
   *    `r`/`f`/`d`/`w` are filter text. The whole sub-state is inert until R5-1's `/resume` card lands.
   *  - `'closed'`: the card exists but is not expanded. Enter **opens** it (`cardOpen`), Esc closes the picker.
   *  - `'open'`: the sub-state. Enter resumes, Esc returns to the list (`cardClose`), and the four letters resolve
   *    (§7 row 91: the filter is inert and the card says `Esc returns to the list`).
   */
  pickerCard?: 'off' | 'closed' | 'open';
  /**
   * TUI-DESIGN-5 §6.4 (D-AQ): **this picker's composer is a free-text query, not a session filter.** The models
   * picker lives in the same pane slot with the same "the composer IS the filter" contract, but three of the
   * session picker's ops are bound to keys a query needs — `space` (`picker:preview`), `x` (`picker:delete`) and
   * `ctrl+a` (`picker:allWorkspaces`) — and none of the three has any meaning for a catalogue row. With this set
   * they resolve as **text** (or as nothing, for the non-printable one), so `z-ai/glm 5` types and `x` is an `x`.
   *
   * Optional and **false by default**: the sessions and rewind arms are byte-for-byte round 3's.
   */
  pickerFilter?: boolean;
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
    draftTokenOnly: false,
    cursorAtEnd: true,
    paneFocus: false,
    tab: 'd',
    pickerCard: 'off',
    pickerFilter: false,
  };
}

/** TUI-DESIGN §4.1 motions the resolver emits (word motions use the composer's segmenter). */
export type Motion = 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'wordLeft' | 'wordRight';

/**
 * TUI-DESIGN §8.4 / TUI-DESIGN-5 §2.8 (§14.2 #33, #40): the picker's closed op union, **extracted from the inline
 * `KeyAction` arm it used to be** so §2.8's six card members have a name to join and the App's reducer can switch
 * on it exhaustively. The first ten are round 3's, unchanged and in order.
 *
 * The six new members are the resume card's focused **sub-state** (§2.8): `cardOpen` (Enter on a row expands it),
 * `cardClose` (Esc returns to the list) and the four card letters `r` / `f` / `d` / `w`, which resolve **only while
 * `card !== null`**. Outside the sub-state those four are filter text — the picker's composer *is* its filter
 * (`src/session/picker-lines.ts:1–33`) and `picker:delete` already owns a bare `x`, so binding them at picker scope
 * would take four more letters away from typing (§7 row 91).
 */
export type PickerOp = 'move' | 'page' | 'open' | 'accept' | 'preview' | 'allWorkspaces' | 'rename' | 'deleteArm' | 'deleteConfirm' | 'close' | 'cardOpen' | 'cardClose' | 'cardReplay' | 'cardFresh' | 'cardDiff' | 'cardWho';

/** TUI-DESIGN-5 §4.3 / F-54's keys row: the agents tab's ops. `dropArm`/`dropConfirm` are the `x` `x` chord. */
export type AgentsOp = 'move' | 'attach' | 'pause' | 'steer' | 'budget' | 'diff' | 'kick' | 'dropArm' | 'dropConfirm' | 'land' | 'unfocus';

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
  /** TUI-DESIGN-3 §4.5: a rebound key that equals a command (`session:cost` → `/cost`, `files:undo` → `/undo`, …); the App routes the line as typed */
  | { type: 'slash'; line: string }
  /**
   * TUI-DESIGN-4 §4.2 P-P1: Enter is `enter` — the controller runs it through `paletteNavState` / `paletteStep`, which
   * is the only place that knows whether the draft is armed. `run` is round 3's op, no longer emitted by the resolver;
   * it stays in the union so an out-of-tree dispatcher keeps compiling until §9.2's `App.tsx` row lands.
   */
  | { type: 'palette'; op: 'move' | 'page' | 'accept' | 'enter' | 'run' | 'close'; by?: -1 | 1 }
  | { type: 'picker'; op: PickerOp; by?: -1 | 1 }
  /**
   * TUI-DESIGN-5 §4.3 / §7 row 99: focus the `'a'` pane tab so its eight single letters resolve at all. Refused
   * with a non-empty draft (S86a, the same `when: 'empty draft'` guard `global:paneNext` carries), and dropped
   * automatically by the controller when `paneTabsFor(...)` stops containing `'a'`.
   */
  | { type: 'paneFocus'; on: boolean }
  /** TUI-DESIGN-5 §4.3 / F-54: the agents tab's own keys — resolved only while `paneFocus && tab === 'a'`. */
  | { type: 'agents'; op: AgentsOp; by?: -1 | 1 }
  | { type: 'review'; op: 'approve' | 'decline' | 'note' | 'expand' | 'whyArm' | 'why' | 'noteSubmit' | 'noteCancel'; dim?: 1 | 2 | 3 | 4 | 5 }
  | { type: 'gate'; op: 'send' | 'dismiss' }
  | { type: 'followup'; op: 'start' | 'raise' | 'cancel' }
  | { type: 'undoPrompt'; op: 'yes' | 'no' | 'all' | 'skipRest' | 'abort' }
  | { type: 'exitConfirm'; op: 'abortExit' | 'stay' }
  /**
   * TUI-DESIGN-5 §5.2 / §7 row 59: the import overlay. The ops are `ImportAction`'s own names
   * (`src/tui/import/reducer.ts`), so the App's arm is one `importDispatch({ type: action.op })` and the reducer
   * stays the single owner of what each key means. **No new `KeyContext`**: like every other y-gated overlay
   * (`resolveYGated`) the keys are literal here, so `KeyContext` stays the six members gate G-R5-10 pins.
   */
  | { type: 'import'; op: 'move' | 'open' | 'back' | 'toggle' | 'all' | 'none' | 'review' | 'apply' | 'escape'; by?: -1 | 1 }
  | { type: 'wizard'; op: 'input' | 'submit' | 'back' | 'backspace' | 'clear'; text?: string }
  | { type: 'blocking'; key: 'r' | 'c' | 'q' | 'p' | 'l' }
  | { type: 'toast'; text: string }
  | { type: 'filtered'; reason: string };

/** TUI-DESIGN §24: the toast for a non-key printable while the review box owns the input. */
export const REVIEW_PENDING_TOAST = 'review pending: y n d e w · Esc declines';
/** TUI-DESIGN-5 §5.2 / §12.4 S91: the toast for a non-key printable while the import overlay owns the input. */
export const IMPORT_PENDING_TOAST = 'import open: y r Space Enter · Esc closes (the plan is kept)';

const CSI_LEAK = /^\[(?:I|O|\?\d+[uc]|\d+;\d+R|27;\d+;\d+~|<\d+;\d+;\d+[Mm]|\?62;[\d;]*c)$/;
/**
 * TUI-DESIGN-4 §4.7 E10: an SGR (`[<64;10;5M`) or X10 (`[M` + three bytes) mouse report from an **outer** program's
 * tracking mode is delivered by Ink as text. It is dropped in every context, so it can never reach a draft, a palette
 * query or a wizard field.
 */
export const MOUSE_RE = /^\[(?:<[0-9;]+[Mm]|M[\s\S]{3})$/;
const OSC_LEAK = /^\]\d+;/;
const XTERM_NEWLINE = /^\[27;[2-8];13~$/;
/** TUI-DESIGN-4 §4.7 E9: `/` plus up to eight name characters in one unbracketed chunk still opens the palette. */
const PALETTE_CHUNK_RE = /^\/[a-z0-9-]{0,8}$/;

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
    // (`MOUSE_RE` is applied once, at the top of `resolveKey`, so every context drops a mouse report — §4.7 E10)
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
    case 'global:paneFocus':
      // TUI-DESIGN-5 §7 row 99 / S86a: focus is REFUSED while the draft is non-empty — the eight agents letters
      // must never eat a half-typed line. The refusal is a toast, not silence, so the key is never a no-op.
      return s.draftEmpty ? [{ type: 'paneFocus', on: true }] : [{ type: 'toast', text: FOCUS_REFUSED }];
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
    case 'session:cost':
    case 'session:status':
    case 'session:mode':
    case 'files:diff':
    case 'files:undo':
    case 'ui:copy':
      return [{ type: 'slash', line: COMMAND_KEY_ACTIONS[id] as string }];
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
      // TUI-DESIGN-4 §4.7 E13: at the **end** of a draft that is exactly a `/token` the slash **reopens** the card
      // and is NOT inserted — a second slash would make the draft `/mode/`, whose token matches nothing, so the
      // reopened card would read `no command matches /mode/`: worse than the trap the rule exists to undo. It
      // cannot fire mid-prompt (a prompt has a space or does not start with `/`). `//` at column 0 still escapes:
      // the first `/` opens the card, so the second one is typed **with the palette open** and is resolved by
      // `resolvePalette` (which sends a printable straight to `textActions`), never by this branch — this case is
      // reached only with the card closed, i.e. after an Esc.
      if (s.draftTokenOnly === true && s.cursorAtEnd === true) return [{ type: 'openPalette' }];
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
  // TUI-DESIGN-4 §4.7 E9: a **non-paste** chunk that is `/` plus up to eight name characters, delivered as one
  // `useInput` on an empty draft, opens the palette with the remainder as the query. Measured: `send /m` arrives as a
  // single `input === '/m'`, which matches no key binding, so today it draws `› /m` with no palette at all. The length
  // and charset bound keeps a 2 KB unbracketed burst text, and a bracketed paste never reaches here (handled above).
  if (s.draftEmpty && k.input.length > 1 && PALETTE_CHUNK_RE.test(k.input) && isPrintable(k) && lookupBinding(b, 'composer', '/') === 'composer:palette') {
    return { state: cleared, actions: [{ type: 'insert', text: k.input }, { type: 'openPalette' }] };
  }
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
    default:
      return none;
  }
}

/**
 * TUI-DESIGN-5 §5.2 / IMPORT-DESIGN §5.2 / §7 row 59: the import overlay's keys, in one place.
 *
 * `y` **is not y-gated here.** `overlayArmed` exists for the confirms that let a model's proposal touch the
 * workspace (§6.3); `/import` is a human-initiated command whose overlay the human just asked for, and the
 * design's own keys row (`[y] import all 41`) is armed from the frame it is drawn. What `y` applies is decided
 * by `selectedRowIds` (`applicableRows` ∩ the human's selection, never a `secret` row) — the guard is the
 * reducer's, not a frame timer's.
 *
 * Esc / Ctrl-C are **one op** (`escape`) because §7 row 59's three behaviours are three reducer states, not three
 * keys: during `applying` it stops at the row boundary and keeps the resume hint; inside an expanded group or the
 * review queue it steps back; at the top it closes and the plan is kept.
 */
function resolveImport(s: KeyState, k: KeyEvent): Step {
  const one = (a: KeyAction): Step => ({ state: s, actions: [a] });
  const none: Step = { state: s, actions: [] };
  if (isCtrl(k, 'c') || k.key.escape) return one({ type: 'import', op: 'escape' });
  if (k.paste === true) return none;
  if (isCtrl(k, 'd') || isNewlineKey(k)) return none;
  if (isEnter(k)) return one({ type: 'import', op: 'open' });
  if (k.key.upArrow) return one({ type: 'import', op: 'move', by: -1 });
  if (k.key.downArrow) return one({ type: 'import', op: 'move', by: 1 });
  if (k.key.leftArrow || k.key.backspace) return one({ type: 'import', op: 'back' });
  if (k.key.ctrl || k.key.meta) return none;
  if (k.input === ' ') return one({ type: 'import', op: 'toggle' });
  switch (k.input) {
    case 'y':
    case 'Y':
      return one({ type: 'import', op: 'apply' });
    case 'r':
    case 'R':
      return one({ type: 'import', op: 'review' });
    case 'a':
    case 'A':
      return one({ type: 'import', op: 'all' });
    case 'n':
    case 'N':
      return one({ type: 'import', op: 'none' });
    default:
      break;
  }
  // every other printable is answered by the hint row rather than falling into the collapsed composer (§5.2)
  return isPrintable(k) ? one({ type: 'toast', text: IMPORT_PENDING_TOAST }) : none;
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
  // TUI-DESIGN-4 §4.2: Enter is not "run" — the nav machine decides between cycling, accepting and running, and a
  // pasted CR never gets here (`k.paste` is handled above), so §4.1's theorem holds for a held Enter as well.
  if (isEnter(k)) return one({ type: 'palette', op: 'enter' });
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

/** TUI-DESIGN-5 §2.8: the four card letters, by action id — consulted ONLY while `pickerCard === true` (§7 row 91). */
const CARD_OPS: Readonly<Record<string, PickerOp>> = {
  'picker:cardReplay': 'cardReplay',
  'picker:cardFresh': 'cardFresh',
  'picker:cardDiff': 'cardDiff',
  'picker:cardWho': 'cardWho',
};

function resolvePicker(s: KeyState, k: KeyEvent, now: number, b: Bindings): Step {
  const one = (a: KeyAction, state: KeyState = s): Step => ({ state, actions: [a] });
  const card = s.pickerCard === 'open';
  // §2.8: Esc in the sub-state returns to the list; Enter on a list row expands it. The two keys keep their
  // reserved bindings (`picker:close` / `picker:open`) and are re-read here, which is why `picker:cardOpen` and
  // `picker:cardClose` carry no keys of their own in the registry.
  if (isCtrl(k, 'c') || k.key.escape) return one({ type: 'picker', op: card ? 'cardClose' : 'close' });
  if (isCtrl(k, 'd') || isNewlineKey(k)) return { state: s, actions: [] };
  // §7 row 91: the filter is inert in the card, and a paste is filter text like any other
  if (k.paste) return card ? { state: s, actions: [] } : one({ type: 'paste', text: k.input });
  if (isEnter(k)) return one({ type: 'picker', op: s.pickerCard === 'closed' ? 'cardOpen' : 'open' });
  const ks = keyString(k);
  if (ks !== null) {
    /**
     * §2.8 / §7 row 91: with the card OPEN the picker is a **focused sub-state**, and this is the whole of it.
     * Enter (resume) and Esc (back to the list) were handled above; of everything else only the four card
     * letters route, and every other key — printable or not — resolves to NOTHING.
     *
     * The early return is the point, not a tidiness: with the fallthrough in place the list's own bindings
     * still fired behind a pane that is showing the card, so `x` armed the delete chord while `pickerLines`'
     * card branch had already returned (no `PICKER_DELETE_HINT` row was ever built), and the following `y`
     * reached `deleteConfirm` → `moveRunsToTrash`. A run directory trashed with no visible arm is exactly the
     * outcome the two-key chord exists to prevent, so the sub-state takes the y-gated-overlay shape: one gate,
     * above the lookup, with no `textActions` behind it.
     */
    if (card) {
      const cardId = lookupBinding(b, 'picker', ks);
      const op = cardId === null ? undefined : CARD_OPS[cardId];
      if (op !== undefined) return one({ type: 'picker', op });
      return { state: s, actions: [] };
    }
    if (ks === 'y' && s.pickerFilter !== true && chordFirst(s, DELETE_ARM, now, CHORD_WINDOW_MS)) return one({ type: 'picker', op: 'deleteConfirm' }, withArmed(s, { chord: null }));
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
      // §6.4: `space`, `x`, `ctrl+a` and `ctrl+r` belong to a SESSION row. In a free-text picker (`pickerFilter`)
      // they are query characters — or, for the two chords, nothing at all — never a preview, a delete arm, a
      // workspace widening or a rename of a row that is a model id.
      case 'picker:preview':
        if (s.pickerFilter === true) break;
        return one({ type: 'picker', op: 'preview' }, cleared);
      case 'picker:allWorkspaces':
        if (s.pickerFilter === true) break;
        return one({ type: 'picker', op: 'allWorkspaces' }, cleared);
      case 'picker:rename':
        if (s.pickerFilter === true) break;
        return one({ type: 'picker', op: 'rename' }, cleared);
      case 'picker:delete':
        if (s.pickerFilter === true) break;
        return one({ type: 'picker', op: 'deleteArm' }, withArmed(cleared, { chord: { first: DELETE_ARM, at: now } }));
      // §7 row 91: with the card CLOSED the four card letters are filter text, exactly as they were in round 3 —
      // they fall through to `textActions` below, never to a picker op.
      case 'picker:cardReplay':
      case 'picker:cardFresh':
      case 'picker:cardDiff':
      case 'picker:cardWho':
        return { state: cleared, actions: isPrintable(k) ? textActions(k) : [] };
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
  // the same gate for a printable `keyString` cannot name (an emoji, a combining sequence): inert in the card
  if (isPrintable(k) && !card) return { state: s, actions: textActions(k) };
  return { state: s, actions: [] };
}

/**
 * TUI-DESIGN-5 §4.3 (§14.2 #41), the **one new rung**, between Picker and Composer: the agents tab's eight keys.
 *
 * Placing it below Picker keeps §2.8's resume-card sub-state unambiguous; placing it **above** Composer is what
 * makes eight bare letters reachable at all — `resolveKey`'s chain had no pane rung, so a sixth `KeyContext` with
 * nowhere to sit would mean `p` types a `p`. The gate is `ui.paneFocus === true && ui.tab === 'a'`, and focus is
 * only ever granted on an empty draft (S86a), so nothing here can eat a half-typed line.
 *
 * Anything this rung does not claim falls through to the composer, so `/`, `@`, `?`, `[`, `]` and every editing
 * key keep working with the tab focused; Esc unfocuses (the tab is a focus state, not an overlay).
 */
function resolveAgents(s: KeyState, k: KeyEvent, now: number, b: Bindings): Step | null {
  const one = (a: KeyAction, state: KeyState = s): Step => ({ state, actions: [a] });
  // a paste is the user's text, whatever it looks like: it falls to the composer, and the `draftEmpty` term of the
  // rung's own gate (`resolveOne`) then keeps every following letter there too until the draft is cleared
  if (k.paste === true) return null;
  if (k.key.escape && k.input === '') return one({ type: 'paneFocus', on: false });
  if (k.key.upArrow) return one({ type: 'agents', op: 'move', by: -1 });
  if (k.key.downArrow) return one({ type: 'agents', op: 'move', by: 1 });
  const ks = keyString(k);
  if (ks === null) return null;
  // the `x` `x` drop chord runs through the ONE chord machine (`lookup`), the same one `ctrl+x ctrl+s` uses —
  // §4.3: a tmux pane kill loses no committed work, dropping an agent loses its uncommitted diff, so it takes two.
  const found = lookup(s, ks, ['agents'], now, b);
  if (found.armedChord) return one({ type: 'agents', op: 'dropArm' }, found.state);
  if (found.chordMiss) return { state: found.state, actions: [] };
  const st = found.state;
  switch (found.id) {
    case 'agents:attach':
      return one({ type: 'agents', op: 'attach' }, st);
    case 'agents:pause':
      return one({ type: 'agents', op: 'pause' }, st);
    case 'agents:steer':
      return one({ type: 'agents', op: 'steer' }, st);
    case 'agents:budget':
      return one({ type: 'agents', op: 'budget' }, st);
    case 'agents:diff':
      return one({ type: 'agents', op: 'diff' }, st);
    case 'agents:kick':
      return one({ type: 'agents', op: 'kick' }, st);
    case 'agents:land':
      return one({ type: 'agents', op: 'land' }, st);
    case 'agents:drop':
      return one({ type: 'agents', op: 'dropConfirm' }, st);
    default:
      return null;
  }
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
      return resolveYGated(s, k, now, b);
    case 'import':
      return resolveImport(s, k);
    case 'palette':
      return resolvePalette(s, k, now, b);
    default:
      break;
  }
  if (s.picker) return resolvePicker(s, k, now, b);
  /**
   * TUI-DESIGN-5 §4.3 / §7 row 99: the one pane rung — below Picker, above Composer. `null` = this rung claims
   * nothing, so the key continues down the chain exactly as it did before round 5.
   *
   * **`draftEmpty` is part of the gate, not only of the focus grant.** §7 row 99's guard is applied when focus is
   * *granted*, but the rung deliberately lets a paste through to the composer (`resolveAgents` returns `null` for
   * `k.paste`), so the draft can become non-empty while focus is still on — and then `land it` would fire
   * `agents:land` on the `l` and `agents:attach` on the Enter. Re-reading the same guard here is what makes the
   * row's promise ("eight single letters can never eat a half-typed line") hold for the whole focused lifetime;
   * the letters fall to the composer while a draft exists, and Esc Esc clears it back into the tab's keys.
   */
  if (s.paneFocus === true && s.tab === 'a' && s.draftEmpty !== false) {
    const agents = resolveAgents(s, k, now, b);
    if (agents !== null) return agents;
  }
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
  // TUI-DESIGN-4 §4.7 E10: with no tracking enabled the terminal sends nothing, or `ESC[A`/`ESC[B`, which move the
  // marker — desirable. If SGR reporting is on from an **outer** program Ink delivers `[<64;10;5M` as text, so it is
  // dropped here, before the context dispatch: a mouse click must never reach a draft, a palette query or a wizard
  // field. A bracketed paste is left alone (its content is the user's, whatever it looks like).
  if (k.paste !== true && k.input.length > 1 && MOUSE_RE.test(k.input)) return filtered('mouse-report');
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
