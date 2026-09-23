/**
 * The palette's Enter-cycling model (TUI-DESIGN-4 §4.2, D-X), pure: no Ink, no I/O, no clock.
 *
 *   **Tab goes deeper. Enter runs what is written. Enter with nothing written yet walks the list.**
 *
 * `paletteNavState` is an **ordered if-chain** over `(draft, matches, selected)` — nine states, total and disjoint by
 * construction (NONE → ONE/BROWSE → ARMED/PICKED → FREE → ARGDONE → ARG → ARGBAD) — and `paletteStep` maps one
 * `(state, key)` cell of §4.2's table to a `NavEffect` the controller executes. Cycling never calls `routeSubmit`,
 * `parseCommand` or `dispatchCommand`, which is what keeps a held Enter inside D-F.
 *
 * §4.1's safety theorem holds structurally: from `/` the draft is not an exact command, so the chain yields BROWSE (or
 * ONE), whose Enter is `move` / `accept` — neither touches the draft except the zero-ambiguity S-ONE accept, so no
 * sequence consisting only of Enter presses can ever reach `run` from a `/` with two or more matches. `nav.test.ts`
 * asserts it as a property test.
 *
 * `arg0` / `restTail` (§14.2 review item 27): `arg0` is the **first** whitespace-delimited token after the command —
 * `null` with no whitespace after the token, `''` when the draft ends in whitespace — and `restTail` is everything
 * after it. `restTail` is never part of the S-ARG / S-ARGDONE predicates, so `/budget spend-cap 5` is S-ARGDONE and
 * Enter runs it.
 */
import { commandToken } from './parse.js';
import type { PaletteMatch } from './palette.js';
import { findCommand, type CommandSpec } from './registry.js';

/** TUI-DESIGN-4 §4.2: the nine palette states, in chain order. */
export type PaletteNavState = 'none' | 'one' | 'browse' | 'armed' | 'picked' | 'free' | 'argdone' | 'arg' | 'argbad';

/** TUI-DESIGN-4 §4.2 / §10 S4: every state, in chain order — the table test iterates it. */
export const PALETTE_NAV_STATES: readonly PaletteNavState[] = ['none', 'one', 'browse', 'armed', 'picked', 'free', 'argdone', 'arg', 'argbad'];

/** TUI-DESIGN-4 §4.2: the seven keys the state machine answers (printable text and Esc are the composer's, not the machine's). */
export type NavKey = 'enter' | 'tab' | 'shifttab' | 'up' | 'down' | 'pageup' | 'pagedown';

/** TUI-DESIGN-4 §4.2 / §10 S4: every key, in table-column order. */
export const PALETTE_NAV_KEYS: readonly NavKey[] = ['enter', 'tab', 'shifttab', 'up', 'down', 'pageup', 'pagedown'];

/** TUI-DESIGN-4 §4.2: PgUp/PgDn move this many rows (clamped, never wrapped). */
export const PALETTE_PAGE = 7;

/**
 * TUI-DESIGN-4 §4.2: what one key does.
 * - `move` — the marker only: `over: 'matches'` moves the command marker `i`, `over: 'values'` the value cursor `j`;
 *   `wrap` is true for ±1 (Enter cycles) and false for the page keys, which clamp. **Never touches the draft.**
 * - `accept` — put the marked row in the draft (`case 'complete'`: the one accept shared by Tab, `→` and S-ONE's Enter).
 * - `run` — today's `onEnter()` → `routeSubmit` path, through §4.5's confirm gate.
 * - `appendSpace` — append one space to the draft (only when it does not already end in whitespace), so the argument
 *   sub-rows take over.
 * - `toast` / `none` — a 2 s toast, or nothing at all.
 */
export type NavEffect =
  | { readonly kind: 'move'; readonly by: number; readonly over: 'matches' | 'values'; readonly wrap: boolean }
  | { readonly kind: 'accept' }
  | { readonly kind: 'run' }
  | { readonly kind: 'appendSpace' }
  | { readonly kind: 'toast'; readonly text: string }
  | { readonly kind: 'none' };

/** TUI-DESIGN-4 §4.2: what `paletteStep` reads — the draft, the ranked matches and the command marker. */
export interface NavCtx {
  readonly draft: string;
  readonly matches: readonly PaletteMatch[];
  readonly selected: number;
}

/**
 * TUI-DESIGN-3 §4.3 / §10: the toast when the argument under the cursor has no candidates. Lives here — the lowest
 * module of the palette stack — so `local.ts` (which imports `palette.ts`) and `palette.ts` can both reach it without
 * a cycle; `local.ts` re-exports it under its round-3 name.
 */
export function noCompletionsToast(arg: string): string {
  return `no completions for ${arg}`;
}

/** TUI-DESIGN-4 §12: the S-NONE toast (Enter and Tab alike). */
export function nothingToPickToast(tok: string): string {
  return `nothing to pick — no command matches ${tok}`;
}

/** TUI-DESIGN-4 §12: Tab on a command that takes no arguments at all. */
export function takesNoArgumentsToast(name: string): string {
  return `/${name} takes no arguments`;
}

/** TUI-DESIGN-4 §12: Tab in S-ARGBAD — the typed arg-0 token matches no value of the command. */
export function noValueMatchesToast(name: string, arg0: string): string {
  return `no value of /${name} matches ${arg0}`;
}

function clampIndex(i: number, n: number): number {
  if (n <= 0) return 0;
  const k = Math.floor(Number.isFinite(i) ? i : 0);
  return k < 0 ? 0 : k > n - 1 ? n - 1 : k;
}

/**
 * TUI-DESIGN-4 §4.2: the **first** whitespace-delimited token after the command — `null` when the draft has no
 * whitespace after the token, `''` when it ends in whitespace with nothing after it. Case is preserved (the
 * predicates fold).
 */
export function arg0Of(draft: string): string | null {
  const s = draft.trimStart();
  const m = /^\/\S*\s+([\s\S]*)$/.exec(s);
  if (m === null) return null;
  return /^(\S*)/.exec(m[1] ?? '')?.[1] ?? '';
}

/**
 * TUI-DESIGN-4 §4.2: everything after `arg0`, trimmed (`''` when there is nothing). **Never** part of the S-ARG /
 * S-ARGDONE predicates — `/budget spend-cap 5` is S-ARGDONE, and Enter runs it.
 */
export function restTailOf(draft: string): string {
  const a0 = arg0Of(draft);
  if (a0 === null) return '';
  const s = draft.trimStart();
  const m = /^\/\S*\s+([\s\S]*)$/.exec(s);
  const after = (m?.[1] ?? '').slice(a0.length);
  return after.trim();
}

/** the command the draft names exactly (a name or an alias), or null */
function specOf(draft: string): CommandSpec | null {
  const tok = commandToken(draft.trimStart());
  return tok === '' ? null : findCommand(tok);
}

/** the arg-0 values of a spec, or undefined when it has none (`rest`/`text`/`path`/`run`/`step`/`int`/`usd`) */
function values0(spec: CommandSpec): readonly string[] | undefined {
  return spec.args[0]?.values;
}

/**
 * TUI-DESIGN-4 §4.2 `paletteNavState` — the ordered if-chain. The order is **normative**: every state names its chain
 * position, and `nav.test.ts` asserts totality and disjointness as a property test.
 *
 * 1 `|M| === 0` → S-NONE · 2/3 no exact command → S-ONE (`|M| === 1`) / S-BROWSE · 4/5 exact, no `arg0` → S-ARMED
 * (the marker is on the draft's own row) / S-PICKED · 6 arg 0 has no `values` → S-FREE · 7 `arg0` is exactly a value →
 * S-ARGDONE · 8 `arg0` is `''` or a prefix of some value → S-ARG · 9 otherwise → S-ARGBAD.
 */
export function paletteNavState(draft: string, matches: readonly PaletteMatch[], selected: number): PaletteNavState {
  if (matches.length === 0) return 'none';
  const spec = specOf(draft);
  if (spec === null) return matches.length === 1 ? 'one' : 'browse';
  const a0 = arg0Of(draft);
  if (a0 === null) return matches[clampIndex(selected, matches.length)]?.spec === spec ? 'armed' : 'picked';
  const vals = values0(spec);
  if (vals === undefined) return 'free';
  const lower = a0.toLowerCase();
  // AGENT-LOOP-DESIGN §14.1: a value the dispatcher accepts without listing it (`/mode jev-on` once `/mode` lists agent · jev-only ·
  // legacy) is as exact as a listed one — Enter runs it; without this `jev-on`, a prefix of the listed `jev-only`, walked the list
  if (vals.some((v) => v.toLowerCase() === lower) || (spec.args[0]?.accepts ?? []).some((v) => v.toLowerCase() === lower)) return 'argdone';
  if (a0 === '' || vals.some((v) => v.toLowerCase().startsWith(lower))) return 'arg';
  return 'argbad';
}

const NONE: NavEffect = { kind: 'none' };
const ACCEPT: NavEffect = { kind: 'accept' };
const RUN: NavEffect = { kind: 'run' };

function move(by: number, over: 'matches' | 'values', wrap: boolean): NavEffect {
  return { kind: 'move', by, over, wrap };
}

function toast(text: string): NavEffect {
  return { kind: 'toast', text };
}

/** ±1 wraps, PgUp/PgDn move `PALETTE_PAGE` and clamp; `enter`/`tab`/`shifttab` are handled per state. */
function arrowMove(key: NavKey, over: 'matches' | 'values'): NavEffect | null {
  switch (key) {
    case 'up':
      return move(-1, over, true);
    case 'down':
      return move(1, over, true);
    case 'pageup':
      return move(-PALETTE_PAGE, over, false);
    case 'pagedown':
      return move(PALETTE_PAGE, over, false);
    default:
      return null;
  }
}

/**
 * TUI-DESIGN-4 §4.2 S-ARMED Tab: an enum / `setting` arg 0 grows the draft by a space; a command with a **free** arg 0
 * says so with round 3's `no completions for <arg>` (TD3 §4.3, the text the same Tab produces today); only a command
 * with no arguments at all answers `/<name> takes no arguments`.
 */
function armedTab(spec: CommandSpec): NavEffect {
  if (values0(spec) !== undefined) return { kind: 'appendSpace' };
  const a0 = spec.args[0];
  return a0 === undefined ? toast(takesNoArgumentsToast(spec.name)) : toast(noCompletionsToast(a0.name));
}

/** TUI-DESIGN-4 §4.2 S-ARGDONE Tab: arg 1 takes the draft deeper only when it has its own values and nothing follows arg 0. */
function argdoneTab(spec: CommandSpec, restTail: string): NavEffect {
  const a1 = spec.args[1];
  if (a1?.values !== undefined && restTail === '') return { kind: 'appendSpace' };
  return a1 === undefined ? toast(takesNoArgumentsToast(spec.name)) : toast(noCompletionsToast(a1.name));
}

/**
 * TUI-DESIGN-4 §4.2 `paletteStep` — one cell of the 9 × 7 table. Pure; the caller owns `i`, `j` and the draft, so a
 * `move` effect is the **only** thing a cycle does. `Esc` is not a key of this machine (it closes the overlay through
 * the interrupt reducer, §4.7 E13), and neither is a printable (the composer inserts it and resets the marker, P-P3).
 */
export function paletteStep(state: PaletteNavState, key: NavKey, ctx: NavCtx): NavEffect {
  const spec = specOf(ctx.draft);
  switch (state) {
    case 'none': {
      if (key === 'enter' || key === 'tab') return toast(nothingToPickToast(commandToken(ctx.draft.trimStart()) || ctx.draft.trim()));
      return NONE;
    }
    case 'one':
      return key === 'enter' || key === 'tab' || key === 'shifttab' ? ACCEPT : NONE;
    case 'browse':
    case 'picked': {
      if (key === 'enter') return move(1, 'matches', true);
      if (key === 'tab') return ACCEPT;
      if (key === 'shifttab') return move(-1, 'matches', true);
      return arrowMove(key, 'matches') ?? NONE;
    }
    case 'armed': {
      if (spec === null) return NONE;
      if (key === 'enter') return RUN;
      if (key === 'tab') return armedTab(spec);
      if (key === 'shifttab') return move(-1, 'matches', true);
      return arrowMove(key, 'matches') ?? NONE;
    }
    case 'free': {
      if (spec === null) return NONE;
      if (key === 'enter') return RUN;
      if (key === 'tab') return toast(noCompletionsToast(spec.args[0]?.name ?? `/${spec.name}`));
      if (key === 'shifttab') return NONE;
      return arrowMove(key, 'matches') ?? NONE;
    }
    case 'argdone': {
      if (spec === null) return NONE;
      if (key === 'enter') return RUN;
      if (key === 'tab') return argdoneTab(spec, restTailOf(ctx.draft));
      if (key === 'shifttab') return move(-1, 'values', true);
      return arrowMove(key, 'values') ?? NONE;
    }
    case 'arg': {
      if (key === 'enter') return move(1, 'values', true);
      if (key === 'tab') return ACCEPT;
      if (key === 'shifttab') return move(-1, 'values', true);
      return arrowMove(key, 'values') ?? NONE;
    }
    case 'argbad': {
      if (spec === null) return NONE;
      if (key === 'enter') return RUN;
      if (key === 'tab') return toast(noValueMatchesToast(spec.name, arg0Of(ctx.draft) ?? ''));
      if (key === 'shifttab') return move(-1, 'values', true);
      return arrowMove(key, 'values') ?? NONE;
    }
  }
}

/**
 * TUI-DESIGN-4 §4.2: apply a `move` effect to an index — ±1 wraps, a page clamps. One helper so the controller, the
 * `--plain` twin and the tests all walk the list the same way.
 */
export function moveIndex(i: number, e: Extract<NavEffect, { kind: 'move' }>, count: number): number {
  if (count <= 0) return 0;
  const from = clampIndex(i, count);
  if (!e.wrap) return clampIndex(from + e.by, count);
  const k = (from + e.by) % count;
  return k < 0 ? k + count : k;
}
