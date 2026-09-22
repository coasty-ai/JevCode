/**
 * Palette and help rendering (TUI-DESIGN §5.3, A34, A16; TUI-DESIGN-3 §4.1–§4.2, D-K), pure strings shared by the Ink overlay,
 * the `--plain` composer and the screen-reader twin. Rows ≤ 8: `▌ /name   a  one-line title   tag` with a Suggested group first
 * (keyed on state), then — for an empty query — the Recent group (≤ 3 distinct commands, newest first, tag `recent`), the Popular
 * group (`POPULAR`, no tag: the alias column is the cue) and the rest in table order; a non-empty query collapses the groups into
 * score order (Suggested first), and an exact alias pins its owner to the top (score 1000, like an exact name — `/s` shows `/status`
 * before `/steer`). Command rows carry a 3-cell dim alias column (the shortest alias) between the name and the title, hidden below
 * 50 columns; every command row is exactly the width. Unavailable rows carry `(idle only)` / `(live only)`; argument sub-rows of
 * the highlighted command fill spare rows (the `/mode` row equal to `DEFAULT_MODE` reads ` (default)`, and TUI-DESIGN-4
 * §4.3 puts the value cursor `▹` on the one the keys are walking); the last row is `(i/N)  <state footer>` with `▲`/`▼`
 * when scrolled — TUI-DESIGN-4 §4.4 makes that footer say what Enter does **in this state** (`paletteFooterText`), and
 * §4.7 E2 replaces the empty card with a sentence. Widths are O2's `stringWidth` (§4.2, cell-identical with
 * string-width@8.2.2); cuts are by grapheme cluster, and a parenthesised list is cut at a comma so the title ends `…)`
 * as frame F-K shows. TUI-DESIGN-4 §4.6 adds `paletteNumberedLines`, the one numbered formatter `--plain` and the
 * screen reader share.
 */
import type { StopReason } from '../../core/types.js';
import { cellWidth, stringWidth } from '../composer/width.js';
import { KEY_ACTIONS, KEY_CONTEXTS, displayKey, type Bindings, type KeyContext } from '../keys/bindings.js';
import { rank } from './fuzzy.js';
import { paletteNavState, type PaletteNavState } from './nav.js';
import { COMMANDS, POPULAR, findCommand, shortestAlias, type CommandSpec } from './registry.js';

/** TUI-DESIGN §5.3: the state that decides the Suggested group. */
export interface PaletteState {
  /** the last run's stop reason (null before any run ended) */
  readonly lastStop: StopReason | null;
  /** a 401 pane was shown for the last run */
  readonly unauthorized: boolean;
  /** the last run changed files */
  readonly changedFiles: boolean;
  /** the Esc Esc menu opened the palette (pre-filtered to /rewind /undo /resume /new) */
  readonly rewindMenu: boolean;
  /** a run is live (idle-only rows dim) */
  readonly live: boolean;
  /**
   * TUI-DESIGN-3 §4.1 rule 6: the Recent group — command names (or aliases; resolved to their owner here), newest first, as
   * `recentCommands()` (local.ts) reads them from the history once at palette open. Absent = no Recent group.
   */
  readonly recent?: readonly string[];
}

/** TUI-DESIGN-3 §4.1 rule 6: the right-hand group tag of a command row (`Suggested` today, `recent` new; Popular rows carry none). */
export type PaletteTag = 'Suggested' | 'recent';

/** TUI-DESIGN §5.3: one row of the palette, structured so the Ink overlay can colour the parts. */
export interface PaletteRow {
  /** TUI-DESIGN-4 §4.7 E2: `note` is the S-NONE inline row (`no command matches /zz — keep typing, or Esc to clear`). */
  readonly kind: 'command' | 'value' | 'footer' | 'note';
  readonly text: string;
  readonly selected: boolean;
  /** command rows: the `/name`; value rows: `/name value` */
  readonly name?: string;
  /** unavailable now (`(idle only)` / `(live only)`) */
  readonly dim: boolean;
  /** matched code-unit spans inside `text` (bold), command rows only */
  readonly spans: readonly [number, number][];
  readonly suggested: boolean;
  /** TUI-DESIGN-3 §4.1 rule 6: the group tag drawn dim at the right edge; null for Popular rows and the rest */
  readonly tag: PaletteTag | null;
  /** TUI-DESIGN-3 §4.1 rule 4: the alias shown in the alias column (the shortest), null when the command has none or the column is hidden */
  readonly alias?: string | null;
}

/**
 * TUI-DESIGN-4 §4.4: the footer is **state-aware** — `paletteFooterText(state, ctx)` replaces round 3's one constant,
 * which said "Enter runs an exact match" while the draft was `/` and Enter did not. `PALETTE_FOOTER` is kept as the
 * S-BROWSE rendering (the footer a bare `/` draws), the one importers reference.
 */
export const PALETTE_FOOTER = 'Enter next · Tab picks · Esc closes';
/** TUI-DESIGN-4 §4.7 E2: the S-NONE inline row, before the `(0/0)` footer. */
export function noMatchRow(tok: string, ascii = false): string {
  return `no command matches ${tok} ${ascii ? '-' : '—'} keep typing, or Esc to clear`;
}
/** TUI-DESIGN-4 §4.3 P-P4: the value cursor of an argument sub-row — never the command marker `▌` (`>`). */
export const VALUE_MARKER = '▹ ';
export const VALUE_MARKER_ASCII = '- ';
/** TUI-DESIGN §24: the Suggested tag. */
export const SUGGESTED = 'Suggested';
/** TUI-DESIGN-3 §4.1 rule 6 / §10: the Recent tag. */
export const RECENT = 'recent';
/** TUI-DESIGN-3 §4.1 rule 6: the Recent group holds at most this many distinct commands. */
export const RECENT_MAX = 3;
/** TUI-DESIGN §5.3: the ≤ 8 rows of the overlay slot. */
export const PALETTE_ROWS = 8;
/** TUI-DESIGN §5.3: the help block is at most this many lines. */
export const HELP_MAX_LINES = 60;
/** TUI-DESIGN-3 §4.1 rule 4: the alias column is hidden below this many columns. */
export const ALIAS_MIN_COLUMNS = 50;
/** TUI-DESIGN-3 §4.1 rule 4: `/name` column (was 15) — the alias column takes the other 3 cells, so the title budget is unchanged. */
export const NAME_COL = 12;
/** TUI-DESIGN-3 §4.1 rule 4: the alias `padEnd(2)` plus one space. */
export const ALIAS_COL = 3;
const REWIND_MENU: readonly string[] = ['rewind', 'undo', 'resume', 'new'];
const VALUE_COL = 35;

let segmenter: Intl.Segmenter | null = null;
function graphemes(s: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const out: string[] = [];
  for (const g of segmenter.segment(s)) out.push(g.segment);
  return out;
}

/** TUI-DESIGN §4.2: the cell width of a string (O2's `stringWidth`; kept under the palette's historical name). */
export function cells(s: string): number {
  return stringWidth(s);
}

/** cut by grapheme cluster to `max` cells with a trailing `…` (or `...` in ASCII); never splits a cluster */
export function cut(s: string, max: number, ascii = false): string {
  if (!Number.isFinite(max) || max <= 0) return '';
  if (cells(s) <= max) return s;
  const ell = ascii ? '...' : '…';
  const room = max - cells(ell);
  if (room <= 0) return ell.slice(0, Math.floor(max));
  let out = '';
  let w = 0;
  for (const g of graphemes(s)) {
    const cw = cellWidth(g);
    if (w + cw > room) break;
    out += g;
    w += cw;
  }
  return out + ell;
}

/**
 * TUI-DESIGN §5.3 / frame F-K: cut a title to `max` cells; when the cut falls inside a trailing
 * parenthesised **list** (`show or set caps (spend-cap, session-spend-cap, max-steps, …)`) the list is cut at
 * its last whole item and closed as `…)` — `show or set caps (spend-cap, session-spend-cap, …)`; a list
 * with no whole item left is elided as `(…)`; anything else — a single-item parenthetical included
 * (`(verify-before-write)`, TUI-DESIGN-3 §4.2 F-P1) — is a plain cell cut.
 */
export function cutTitle(s: string, max: number, ascii = false): string {
  if (!Number.isFinite(max) || max <= 0) return '';
  if (cells(s) <= max) return s;
  const open = s.indexOf('(');
  if (open > 0 && s.endsWith(')') && s.indexOf(', ', open) > 0) {
    const ell = ascii ? '...' : '…';
    const tail = `${ell})`;
    const room = max - cells(tail);
    // the last ", " whose prefix (kept with the comma and space) still fits
    let at = -1;
    for (let i = s.indexOf(', ', open); i >= 0 && i < s.length - 1; i = s.indexOf(', ', i + 1)) {
      if (cells(s.slice(0, i + 2)) <= room) at = i + 2;
      else break;
    }
    if (at > open + 1) return s.slice(0, at) + tail;
    if (cells(s.slice(0, open + 1)) <= room) return s.slice(0, open + 1) + tail;
  }
  return cut(s, max, ascii);
}

function pad(s: string, width: number): string {
  const w = cells(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/** TUI-DESIGN §5.3: true when `state` puts `spec` in the Suggested group. */
export function isSuggested(spec: CommandSpec, state: PaletteState): boolean {
  switch (spec.suggestWhen) {
    case 'stop':
      return state.lastStop !== null;
    case 'budget-stop':
      return state.lastStop === 'spend_cap' || state.lastStop === 'token_cap';
    case 'unauthorized':
      return state.unauthorized;
    case 'changed-files':
      return state.changedFiles && !state.live;
    case 'rewind-menu':
      return state.rewindMenu;
    default:
      return false;
  }
}

/** TUI-DESIGN §5.3: one ranked palette match. */
export interface PaletteMatch {
  readonly spec: CommandSpec;
  readonly suggested: boolean;
  /** TUI-DESIGN-3 §4.1 rule 6: in the Recent group (empty query only; never when Suggested) */
  readonly recent: boolean;
  readonly spans: readonly [number, number][];
  readonly score: number;
}

/** the token of a query: the text after `/`, up to the first whitespace, case-folded */
function tokenOf(query: string): string {
  return (query.replace(/^\//, '').split(/\s/)[0] ?? '').toLowerCase();
}

/** TUI-DESIGN-3 §4.3: the first argument token of a query (`/budget sp` → `sp`), case-folded; null when the query is the name alone */
export function argTokenOf(query: string): string | null {
  const m = /^\/?\S*\s+(\S*)/.exec(query.trimStart());
  return m === null ? null : (m[1] ?? '').toLowerCase();
}

/** TUI-DESIGN-3 §4.1 rule 6: the Recent names resolved to their owners (an alias entry resolves before de-duplication; a Suggested command keeps its group), ≤ RECENT_MAX. */
function recentOwners(state: PaletteState, pool: readonly CommandSpec[]): string[] {
  const out: string[] = [];
  for (const n of state.recent ?? []) {
    const spec = findCommand(n);
    if (spec === null || !pool.includes(spec) || out.includes(spec.name) || isSuggested(spec, state)) continue;
    out.push(spec.name);
    if (out.length >= RECENT_MAX) break;
  }
  return out;
}

/**
 * TUI-DESIGN §5.3 `paletteMatches` — the ranked commands for a query (the text after `/`, up to the first
 * space): the Suggested group first in table order, then score order; aliases match but are never shown
 * as rows (the alias resolves to its command). TUI-DESIGN-3 §4.1: an exact alias pins its owner to the top
 * (score 1000, ahead of the Suggested group — Enter runs it, so the highlight agrees with Enter); a prefix alias
 * still pulls its command in last; an empty query orders Suggested → Recent → Popular → the rest (rule 6; the
 * `rewindMenu` pool keeps its table order).
 */
export function paletteMatches(query: string, state: PaletteState): PaletteMatch[] {
  const q = tokenOf(query);
  const pool = state.rewindMenu ? COMMANDS.filter((c) => REWIND_MENU.includes(c.name)) : COMMANDS;
  const mk = (spec: CommandSpec, score: number, spans: readonly [number, number][], recent = false): PaletteMatch => ({ spec, suggested: isSuggested(spec, state), recent: recent && !isSuggested(spec, state), spans, score });
  if (q === '') {
    if (state.rewindMenu) {
      const all = pool.map((spec) => mk(spec, 0, []));
      return [...all.filter((m) => m.suggested), ...all.filter((m) => !m.suggested)];
    }
    const seen = new Set<string>();
    const out: PaletteMatch[] = [];
    const push = (spec: CommandSpec, recent = false): void => {
      if (seen.has(spec.name)) return;
      seen.add(spec.name);
      out.push(mk(spec, 0, [], recent));
    };
    for (const spec of pool) if (isSuggested(spec, state)) push(spec);
    for (const name of recentOwners(state, pool)) push(findCommand(name) as CommandSpec, true);
    for (const name of POPULAR) {
      const spec = findCommand(name);
      if (spec !== null) push(spec);
    }
    for (const spec of pool) push(spec);
    return out;
  }
  const names = pool.map((c) => c.name);
  const byName = new Map(pool.map((c) => [c.name, c]));
  const ranked = rank(q, names, Number.POSITIVE_INFINITY);
  const pinnedSpec = pool.find((c) => c.aliases.includes(q)) ?? null;
  const pinned: PaletteMatch[] = [];
  const body: PaletteMatch[] = [];
  const seen = new Set<string>();
  for (const r of ranked) {
    const spec = byName.get(r.candidate) as CommandSpec;
    seen.add(spec.name);
    const spans = r.spans.map(([a, b]) => [a + 1, b + 1] as [number, number]);
    if (spec === pinnedSpec) pinned.push(mk(spec, 1000, spans));
    else body.push(mk(spec, r.score, spans));
  }
  if (pinnedSpec !== null && !seen.has(pinnedSpec.name)) {
    seen.add(pinnedSpec.name);
    pinned.push(mk(pinnedSpec, 1000, []));
  }
  // an alias typed as a prefix pulls its command in (last, score 0: its name did not match)
  const tail: PaletteMatch[] = [];
  for (const spec of pool) {
    if (seen.has(spec.name)) continue;
    if (spec.aliases.some((a) => a.startsWith(q))) tail.push(mk(spec, 0, []));
  }
  // the exact token (alias or name, score 1000) leads: Enter runs it, so the highlight and the ghost agree with Enter; then the
  // Suggested group, then score order
  const exactName = pinned.length > 0 ? pinned : body.filter((m) => m.score === 1000);
  const others = [...body.filter((m) => !exactName.includes(m)), ...tail];
  return [...exactName, ...others.filter((m) => m.suggested), ...others.filter((m) => !m.suggested)];
}

/**
 * TUI-DESIGN-4 §4.3 P-P2: the ghost **is** the highlight. Three shapes, one union:
 * `rest` — the marked row extends the typed token (`/mo` ▸ `de +1`); `arrow` — it does not, because the token is an
 * alias or a fuzzy hit (`/q` ▸ ` → /exit +2`; this subsumes TD3 §4.1 rule 3, so the two rounds land one type);
 * `value` — an argument value of the marked sub-row (`/mode j` ▸ `ev-on +1`). `more` is the count of the other rows
 * of the same list in every shape.
 */
export type PaletteGhost =
  | { readonly kind: 'rest'; readonly rest: string; readonly more: number }
  | { readonly kind: 'arrow'; readonly target: string; readonly more: number }
  | { readonly kind: 'value'; readonly rest: string; readonly more: number };

/**
 * TUI-DESIGN-3 §4.1 rule 3: round 3's two-member shape, still what `App.tsx` reads at `:1709` and `:2157`. Kept until
 * S1 lands §9.2's `App.tsx` row (`paletteGhostFor(query, matches, pal.selected)`); `Composer.tsx` renders both.
 */
export type PaletteGhostLegacy = { readonly rest: string; readonly more: number; readonly arrow?: string };

/** TUI-DESIGN-3 §4.1 rule 3 `paletteGhost` — the round-3 entry point: the ghost of `matches[0]`, in the legacy shape. */
export function paletteGhost(query: string, matches: readonly PaletteMatch[]): PaletteGhostLegacy | null {
  const g = paletteGhostFor(query, matches, 0);
  if (g === null) return null;
  if (g.kind === 'arrow') return { rest: '', more: g.more, arrow: g.target };
  return { rest: g.rest, more: g.more };
}

function wrapIndex(i: number, n: number): number {
  if (n <= 0) return 0;
  const k = Math.floor(Number.isFinite(i) ? i : 0) % n;
  return k < 0 ? k + n : k;
}

/**
 * TUI-DESIGN-4 §4.3 P-P2 `paletteGhostFor` — "what will Tab give me" and "what is the marker on" are one question, so
 * the ghost reads `matches[selected]`, never `matches[0]` (A4 p5 captured a marker on `/llm` beside a `/mode +5`
 * ghost). With an argument token typed, `selected` is the **value** cursor `j` over the filtered sub-rows, exactly as
 * `completeDraft` already uses it, and the ghost previews `V[j]`. Null when there is nothing to preview.
 */
export function paletteGhostFor(query: string, matches: readonly PaletteMatch[], selected: number): PaletteGhost | null {
  const q = tokenOf(query);
  const argToken = argTokenOf(query);
  const spec = q === '' ? null : findCommand(q);
  if (argToken !== null && spec !== null) {
    const list = argValues(spec, argToken);
    const v = list[wrapIndex(selected, list.length)];
    if (v === undefined) return null;
    // the same rule the command branch uses (P-P2): a marked row that **extends** the token ghosts its rest, one that
    // does not ghosts the arrow. `rank` is a subsequence scorer, so `/mode j` marks `llm-jev` as well as the three
    // `jev-*` values — without the arrow the ghost would vanish on exactly the row Tab is about to accept, which is
    // the defect this round exists to close.
    if (!v.toLowerCase().startsWith(argToken)) return { kind: 'arrow', target: `/${spec.name} ${v}`, more: list.length - 1 };
    const rest = v.slice(argToken.length);
    return rest === '' ? null : { kind: 'value', rest, more: list.length - 1 };
  }
  const top = matches[Math.min(Math.max(0, Math.floor(selected) || 0), Math.max(0, matches.length - 1))];
  if (top === undefined) return null;
  const more = matches.length - 1;
  const name = top.spec.name;
  if (q !== '' && top.spec.aliases.includes(q)) return { kind: 'arrow', target: `/${name}`, more };
  if (name.startsWith(q)) return name === q ? null : { kind: 'rest', rest: name.slice(q.length), more };
  return { kind: 'arrow', target: `/${name}`, more };
}

/**
 * TUI-DESIGN-4 §4.3 P-P4: the arg-0 sub-rows for a typed argument token — `rank`ed by the partial as round 3 landed it,
 * falling back to the whole list when nothing ranks (S-ARGBAD: the user must still be able to see the valid values).
 */
export function argValues(spec: CommandSpec, argToken: string): readonly string[] {
  const all = spec.args[0]?.values;
  if (all === undefined) return [];
  if (argToken === '') return all;
  const ranked = rank(argToken, all, Number.POSITIVE_INFINITY).map((r) => r.candidate);
  return ranked.length === 0 ? all : ranked;
}

/** TUI-DESIGN-4 §4.4: what the state footer needs beyond the state itself. */
export interface PaletteFooterCtx {
  /** the resolved owner, without `/` — the marked row in BROWSE/ONE/ARMED/PICKED, the draft's command in the arg states */
  readonly name?: string | null;
  /** the arg-0 token as typed (S-ARGDONE / S-ARGBAD) */
  readonly arg?: string | null;
  /** the command cannot run now — S-ARMED says so and the whole row is drawn dim */
  readonly unavailable?: 'idle' | 'live' | null;
  /** arg 0 carries enum / `setting` values, so Tab adds an argument */
  readonly hasValues?: boolean;
  /** S-FREE: the name of arg 0 (`type the title`) */
  readonly argName?: string | null;
  readonly ascii?: boolean;
}

/**
 * TUI-DESIGN-4 §4.4 `paletteFooterText` — the footer says what Enter does, in every state. The command name is always
 * the **resolved owner** (`/q` reads `Enter runs /exit`), which is the single best guard against an alias surprise.
 * `·` → ` - ` under `--ascii`, as round 3's constant already did.
 */
export function paletteFooterText(state: PaletteNavState, ctx: PaletteFooterCtx = {}): string {
  const name = ctx.name == null || ctx.name === '' ? null : `/${ctx.name}`;
  const parts: string[] = [];
  switch (state) {
    case 'none':
      break;
    case 'one':
      parts.push(name === null ? 'Enter picks' : `Enter picks ${name}`);
      break;
    case 'browse':
      parts.push('Enter next', 'Tab picks');
      break;
    case 'picked':
      parts.push(name === null ? 'Tab picks' : `Tab picks ${name}`, 'Enter next');
      break;
    case 'armed':
      parts.push(`Enter runs ${name ?? ''}`.trimEnd());
      if (ctx.unavailable === 'idle' || ctx.unavailable === 'live') parts.push(`${ctx.unavailable} only`);
      else if (ctx.hasValues === true) parts.push('Tab adds an argument');
      break;
    case 'free':
      parts.push(`Enter runs ${name ?? ''}`.trimEnd());
      if (ctx.argName != null && ctx.argName !== '') parts.push(`type the ${ctx.argName}`);
      break;
    case 'arg':
      parts.push('Enter next value', 'Tab picks');
      break;
    case 'argdone':
      parts.push(`Enter runs ${[name, ctx.arg].filter((x) => x != null && x !== '').join(' ')}`.trimEnd());
      break;
    case 'argbad':
      parts.push(`Enter runs ${[name, ctx.arg].filter((x) => x != null && x !== '').join(' ')}`.trimEnd(), 'no such value');
      break;
  }
  parts.push('Esc closes');
  return parts.join(ctx.ascii === true ? ' - ' : ' · ');
}

/** TUI-DESIGN-4 §4.4: the footer context for a `(query, state, selected)` — the one place the states and their names agree. */
function footerCtxFor(nav: PaletteNavState, query: string, state: PaletteState, matches: readonly PaletteMatch[], sel: number, ascii: boolean): PaletteFooterCtx {
  const q = tokenOf(query);
  const draftSpec = q === '' ? null : findCommand(q);
  const marked = matches[sel]?.spec ?? null;
  const spec = nav === 'free' || nav === 'arg' || nav === 'argdone' || nav === 'argbad' ? draftSpec : marked;
  const a0 = spec?.args[0];
  const unavailable = spec === null || spec === undefined || spec.availableDuringTask === 'any' ? null : (spec.availableDuringTask === 'idle') === state.live ? spec.availableDuringTask : null;
  return {
    name: spec?.name ?? null,
    arg: argTokenOf(query),
    unavailable,
    hasValues: a0?.values !== undefined,
    argName: a0?.name ?? null,
    ascii,
  };
}

/**
 * TUI-DESIGN §5.3 `paletteRows` — the rows for `rows` lines of the overlay slot (footer last), `selected`
 * highlighted with `▌` (`>` in ASCII); command rows scroll around the selection; spare rows show the
 * selected command's argument values (`/budget spend-cap <usd>   run cap for the next /resume or run`).
 * TUI-DESIGN-3 §4.1 rule 4 / §4.2 row anatomy (76 cells inside the card, 60 flat): marker `▌ ` / two spaces (2) ·
 * name `padEnd(12)` · alias `padEnd(2)` + space (3, ≥ 50 columns) · title clipped with `…` to the remaining budget ·
 * two spaces + the group tag at the right edge when one exists; every row (command, value, footer) is exactly `columns` cells.
 *
 * TUI-DESIGN-4 §4.3 / §4.4 / §4.7 E2 add: the value cursor `▹` (`-`) on `V[valueIndex]` whenever an argument token is
 * present (never confused with the command marker), a `… +N more` clause when the row budget cuts values, the
 * **state** footer (which is all a one-row palette keeps), and the S-NONE inline row in place of the blank card.
 * `selected` is the command marker `i` and `valueIndex` the **value** cursor `j` (§4.3 P-P3: two cursors, never one
 * number). `j` defaults to 0, so a caller that does not track it yet marks the first value; in the argument states
 * the marker is pinned to the draft's own command row, because §4.2's keys move `j` there and never `i`.
 */
export function paletteRows(query: string, state: PaletteState, selected: number, rows: number, columns: number, ascii = false, valueIndex?: number): PaletteRow[] {
  const n = Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  if (n === 0) return [];
  const width = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 80));
  const matches = paletteMatches(query, state);
  const total = matches.length;
  const marker = ascii ? '> ' : '▌ ';
  const blank = '  ';
  const sel = total === 0 ? 0 : Math.min(Math.max(0, Math.floor(selected) || 0), total - 1);
  const nav = paletteNavState(query, matches, sel);
  const argToken = argTokenOf(query);
  // TUI-DESIGN-4 §4.3 P-P3: `i` and `j` are **two** cursors and one number can never stand for both. In the argument
  // states §4.2's keys walk `V`, so the command marker is pinned to the draft's own row (`/mode j` keeps `▌` on
  // `/mode` however far `i` was moved before the argument was typed) and `j` comes from `valueIndex` alone. Deriving
  // the value cursor from `selected` put `▌` on `/model`, dropped every sub-row and printed `(0/0)`.
  const draftTok = tokenOf(query);
  const draftSpec = draftTok === '' ? null : findCommand(draftTok);
  const overValues = nav === 'arg' || nav === 'argdone' || nav === 'argbad';
  const draftAt = draftSpec === null ? -1 : matches.findIndex((m) => m.spec === draftSpec);
  const mark = overValues && draftAt >= 0 ? draftAt : sel;
  const fctx = footerCtxFor(nav, query, state, matches, mark, ascii);
  const selSpec = matches[mark]?.spec;
  const arg0 = selSpec?.args[0];
  const values = selSpec === undefined || arg0?.values === undefined ? [] : argValues(selSpec, argToken ?? '');
  // the `(i/N)` prefix counts the list the keys are walking: the values in the argument states, the matches elsewhere
  const vsel = values.length === 0 ? 0 : wrapIndex(valueIndex ?? 0, values.length);
  const mkFooter = (up: boolean, down: boolean, shown: number): PaletteRow =>
    footerRow(nav, fctx, overValues ? vsel : mark, overValues ? values.length : total, up, down, width, ascii, overValues ? Math.max(0, values.length - shown) : 0);
  if (n === 1) return [mkFooter(false, false, values.length)];
  const body = n - 1;
  // TUI-DESIGN-4 §4.7 E2: zero matches draws a sentence, never an empty card
  if (total === 0) {
    const note = pad(cut(`  ${noMatchRow(tokenOf(query) === '' ? query.trim() : `/${tokenOf(query)}`, ascii)}`, width, ascii), width);
    return [{ kind: 'note', text: note, selected: false, dim: false, spans: [], suggested: false, tag: null }, mkFooter(false, false, 0)];
  }
  // TUI-DESIGN-3 §4.2 F-P2: an exact token (`/m`) whose command has value sub-rows keeps them on screen even when the matches
  // overflow — the command rows shrink to `max(2, body − values)` and the footer's ▼ says the rest scrolls; otherwise the
  // matches come first and the sub-rows take the spare rows (F-K)
  const exactValues = draftSpec !== null && draftSpec === matches[mark]?.spec ? (draftSpec.args[0]?.values?.length ?? 0) : 0;
  const commandRows = total > body && exactValues > 0 ? Math.min(total, body, Math.max(2, body - exactValues)) : Math.min(total, body);
  let start = 0;
  if (total > commandRows) start = Math.min(Math.max(0, mark - Math.floor(commandRows / 2)), total - commandRows);
  const out: PaletteRow[] = [];
  // TUI-DESIGN-3 §4.1 rule 4: the alias column is hidden below 50 columns — the name column then keeps today's 15 cells
  const aliasCol = width >= ALIAS_MIN_COLUMNS;
  const nameCol = aliasCol ? NAME_COL : Math.min(NAME_COL + ALIAS_COL, Math.floor(width / 2));
  for (let i = start; i < start + commandRows; i++) {
    const m = matches[i] as PaletteMatch;
    const isSel = i === mark;
    const name = `/${m.spec.name}`;
    const alias = shortestAlias(m.spec);
    const unavailable = (m.spec.availableDuringTask === 'idle' && state.live) || (m.spec.availableDuringTask === 'live' && !state.live);
    const tagText = unavailable ? (m.spec.availableDuringTask === 'idle' ? ' (idle only)' : ' (live only)') : '';
    const tag: PaletteTag | null = m.suggested ? SUGGESTED : m.recent ? RECENT : null;
    const groupTag = tag === null ? '' : `  ${tag}`;
    const head = `${isSel ? marker : blank}${pad(name, nameCol)}${aliasCol ? `${pad(alias ?? '', ALIAS_COL - 1)} ` : ''}`;
    const avail = width - cells(head) - cells(groupTag) - cells(tagText);
    const title = avail > 0 ? cutTitle(m.spec.title, avail, ascii) : '';
    const text = cut(`${pad(`${head}${title}${tagText}`, width - cells(groupTag))}${groupTag}`, width, ascii);
    const shift = isSel ? marker.length : blank.length;
    out.push({ kind: 'command', text, selected: isSel, name, dim: unavailable, spans: m.spans.map(([a, b]) => [a + shift, b + shift] as [number, number]), suggested: m.suggested, tag, alias: aliasCol ? alias : null });
  }
  // argument sub-rows of the selected command; TUI-DESIGN-3 §4.3 filters them to the same candidates Tab cycles through and
  // TUI-DESIGN-4 §4.3 P-P4 puts the value cursor `▹` on `V[j]` (only once an argument token exists: an armed command with
  // no argument yet previews its values with no cursor)
  let shownValues = 0;
  if (selSpec !== undefined && arg0?.values !== undefined && out.length < body) {
    const cursor = ascii ? VALUE_MARKER_ASCII : VALUE_MARKER;
    for (let vi = 0; vi < values.length; vi++) {
      const v = values[vi] as string;
      if (out.length >= body) break;
      const isCur = argToken !== null && vi === vsel;
      const hint = arg0.valueHints?.[v];
      const label = `/${selSpec.name} ${v}${hint?.args ? ` ${hint.args}` : ''}`;
      const head = `${isCur ? cursor : blank}${pad(label, VALUE_COL)}${cells(label) >= VALUE_COL ? ' ' : ''}`;
      const avail = width - cells(head);
      // the ` (default)` suffix survives the cut: the title is cut to the room left beside it
      const suffix = arg0.defaultValue === v ? ' (default)' : '';
      const hintText = hint ? `${cut(hint.title, Math.max(0, avail - cells(suffix)), ascii)}${suffix}` : '';
      const text = pad(cut(`${head}${hintText}`, width, ascii), width);
      out.push({ kind: 'value', text, selected: isCur, name: `/${selSpec.name} ${v}`, dim: false, spans: [], suggested: false, tag: null });
      shownValues++;
    }
  }
  out.push(mkFooter(start > 0, start + commandRows < total, shownValues));
  return out;
}

function footerRow(nav: PaletteNavState, ctx: PaletteFooterCtx, sel: number, total: number, up: boolean, down: boolean, width: number, ascii: boolean, hiddenValues: number): PaletteRow {
  const marks = `${up ? (ascii ? ' ^' : ' ▲') : ''}${down ? (ascii ? ' v' : ' ▼') : ''}`;
  const more = hiddenValues > 0 ? `${ascii ? ' - ' : ' · '}${ascii ? '...' : '…'} +${hiddenValues} more` : '';
  const text = pad(cut(`  (${total === 0 ? 0 : sel + 1}/${total})  ${paletteFooterText(nav, ctx)}${more}${marks}`, width, ascii), width);
  return { kind: 'footer', text, selected: false, dim: false, spans: [], suggested: false, tag: null };
}

/** TUI-DESIGN §5.3 `paletteLines` — the plain-string rows (the `lines()` twin the four renderers share). */
export function paletteLines(query: string, state: PaletteState, selected: number, rows: number, columns: number, ascii = false): string[] {
  return paletteRows(query, state, selected, rows, columns, ascii).map((r) => r.text);
}

/** TUI-DESIGN-4 §4.6: the numbered block caps at this many command rows, then names where the rest is. */
export const NUMBERED_MAX_ROWS = 40;

/**
 * TUI-DESIGN-4 §4.6: how many command rows the block shows. The cap never fires at `NUMBERED_MAX_ROWS + 1`: a
 * `… 1 more — /help commands` tail costs exactly the row it replaces, and hiding one command would make it
 * unpickable by number while the header still counted it (with 41 commands that command is `/ui`). From two hidden
 * rows up the tail earns its place.
 */
export function numberedShown(total: number): number {
  const n = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  return n <= NUMBERED_MAX_ROWS + 1 ? n : NUMBERED_MAX_ROWS;
}

/** TUI-DESIGN-4 §4.6: the one-shot `--plain` prompt for the turn in which a bare integer picks a command. */
export function numberedPrompt(n: number): string {
  return `pick 1-${n}, or type a message > `;
}

/**
 * TUI-DESIGN-4 §4.6 `paletteNumberedLines` — **one formatter for both twins**: the `--plain` composer's answer to a
 * submitted `/`, and the screen reader's palette block. Neither surface has a palette today, so the numbered list is
 * the whole affordance; Gemini CLI's numbered radio options are the precedent.
 *
 *   commands (41) — type a number or a name, then Enter
 *     1  /help        keys by context, commands with one-liners, per-terminal notes
 *    41  /exit        leave (exit 0; confirms first while a run is live)
 *
 * The rows are `paletteMatches` in palette order, so the number the user types and the row they read can never
 * disagree; `numberedPick` resolves one back to its command.
 */
export function paletteNumberedLines(query: string, state: PaletteState, columns: number, ascii = false): string[] {
  const width = Math.max(20, Math.floor(Number.isFinite(columns) ? columns : 80));
  const matches = paletteMatches(query, state);
  const total = matches.length;
  const dash = ascii ? '-' : '—';
  const out = [cut(`commands (${total}) ${dash} type a number or a name, then Enter`, width, ascii)];
  const shown = numberedShown(total);
  const numCol = String(shown).length + 1;
  for (let i = 0; i < shown; i++) {
    const m = matches[i] as PaletteMatch;
    const head = `${String(i + 1).padStart(numCol)}  ${pad(`/${m.spec.name}`, NAME_COL)} `;
    out.push(cut(`${head}${m.spec.title}`, width, ascii));
  }
  if (total > shown) out.push(cut(`${ascii ? '...' : '…'} ${total - shown} more ${dash} /help commands`, width, ascii));
  return out;
}

/** TUI-DESIGN-4 §4.6: the command a number picks out of `paletteNumberedLines` (1-based, `null` outside `1..N`). */
export function numberedPick(query: string, state: PaletteState, n: number): CommandSpec | null {
  if (!Number.isInteger(n)) return null;
  const matches = paletteMatches(query, state);
  return n >= 1 && n <= numberedShown(matches.length) ? ((matches[n - 1] as PaletteMatch).spec) : null;
}

/**
 * TUI-DESIGN-4 §4.6: the one line a screen reader hears on every highlight change — `--plain --screen-reader` and the
 * TUI under SR emit it byte-identically (the declared SR-only normaliser; precedent `SR_REVIEW_MENU`). The caller
 * coalesces to at most one per `SR_PALETTE_COALESCE_MS` so hammering Enter cannot flood.
 */
export function srPaletteLine(index: number, total: number, spec: CommandSpec): string {
  return `palette: ${index + 1} of ${total} · /${spec.name} · ${spec.title} · Enter next, Tab picks, Esc closes`;
}
/** TUI-DESIGN-4 §4.6: at most one screen-reader palette line per this many ms. */
export const SR_PALETTE_COALESCE_MS = 400;

/** TUI-DESIGN §5.3 / TUI-DESIGN-3 §10: the per-terminal notes of the help block, verbatim (the two theme notes are round 3's). */
export const HELP_NOTES: readonly string[] = [
  'Shift+Enter needs a keyboard protocol: use Ctrl+J or \\ then Enter',
  'macOS: turn on "Option as Meta" for Alt-b/Alt-f',
  'colour-blind? /theme daltonized',
  'light terminal? /theme light',
];

function contextTitle(c: KeyContext): string {
  switch (c) {
    case 'global':
      return 'global';
    case 'composer':
      return 'composer';
    case 'review':
      return 'review box';
    case 'picker':
      return 'session picker';
    case 'palette':
      return 'palette';
  }
}

/** pack `items` into lines of at most `width` cells joined by ` · `, each line indented by `indent` */
function packLines(items: readonly string[], width: number, indent: string, sep: string): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const it of items) {
    const piece = cut(it, Math.max(1, width - indent.length), false);
    if (cur === '') cur = piece;
    else if (cells(indent) + cells(cur) + cells(sep) + cells(piece) <= width) cur += sep + piece;
    else {
      lines.push(indent + cur);
      cur = piece;
    }
  }
  if (cur !== '') lines.push(indent + cur);
  return lines;
}

/** TUI-DESIGN §5.3: the help block's tail pointer when even the last compaction level overflows `HELP_MAX_LINES`. */
export const HELP_POINTER = '  … see docs/KEYS.md and docs/COMMANDS.md for the rest';
/** the compaction ladder of `helpLines`, in order; `HELP_COMPACTION_LEVELS[k]` documents level `k` */
export const HELP_COMPACTION_LEVELS: readonly string[] = [
  'every binding, one context title line per key context, the `notes` header',
  'the context title shares its first packed line; no `notes` header',
  'only the primary key of each action',
  'the key contexts packed into one block (`<context>: …` markers) — every command keeps its own line',
  'the per-terminal notes are dropped — a command line (`/exit`) outranks a terminal tip — and the `keys` header shares the first packed row',
  'the key table gives way to one pointer row — `/help keys` still prints it, and no command is ever cut (TUI-DESIGN-4: 41 commands)',
];
/**
 * TUI-DESIGN-4 §3.3 / §4.6: level 5's key row. With 41 commands the level-4 block is 61 rows at 80 columns, one over
 * `HELP_MAX_LINES`, and the tail cut would drop `/peers` and `/ui` — the two commands a user is least likely to know.
 * The keys are the part that has both its own topic (`/help keys`) and a generated document, so they yield first.
 */
export const HELP_KEYS_POINTER = '  … /help keys prints the key table (docs/KEYS.md has it too)';

/** TUI-DESIGN-3 §4.1 rule 7: the head of a command's help line — `  /status, /s [usage]` (aliases after the name, table order). */
export function helpCommandHead(c: CommandSpec): string {
  const usage = c.usage === '—' ? '' : ` ${c.usage}`;
  return `  /${c.name}${c.aliases.map((a) => `, /${a}`).join('')}${usage}`;
}

/** TUI-DESIGN §5.3 `helpLines` options; TUI-DESIGN-3 §4.4 F9: `live` given → only the tag that applies now (`(idle only)` while live, `(live only)` while idle). */
export interface HelpOptions {
  bindings?: Bindings;
  ascii?: boolean;
  topic?: 'all' | 'keys' | 'commands';
  /** a run is live; undefined = state unknown, every non-`any` command carries its tag */
  live?: boolean;
}

/**
 * TUI-DESIGN §5.3 `helpLines` — the one `<Static>` block `?`/F1/`/help` append (≤ 60 lines): keys grouped by
 * context (effective bindings when given), then commands with one-liners (aliases shown, TUI-DESIGN-3 §4.1 rule 7),
 * then the per-terminal notes. `topic` narrows it to keys or commands. Compaction levels keep the cap
 * (`HELP_COMPACTION_LEVELS`): the context name shares the first packed line; then only the primary key of each action is
 * shown; then the key contexts pack into one block; then the notes go; only then is the tail cut with a pointer to
 * docs/KEYS.md and docs/COMMANDS.md. Every command has its own `  /<name>` line at every level. TUI-DESIGN-3 §4.4 F9:
 * the one help formatter for both renderers — the controller calls it with `columns()` (80 on a pipe) and `live`.
 */
export function helpLines(columns: number, opts: HelpOptions = {}): string[] {
  const width = Math.max(20, Math.floor(Number.isFinite(columns) ? columns : 80));
  const ascii = opts.ascii ?? false;
  const topic = opts.topic ?? 'all';
  const sep = ascii ? ' - ' : ' · ';
  const availTag = (c: CommandSpec): string => {
    if (c.availableDuringTask === 'any') return '';
    if (opts.live === undefined) return ` (${c.availableDuringTask} only)`;
    if (c.availableDuringTask === 'idle') return opts.live ? ' (idle only)' : '';
    return opts.live ? '' : ' (live only)';
  };
  const render = (level: 0 | 1 | 2 | 3 | 4 | 5): string[] => {
    const lines: string[] = [];
    if (topic !== 'commands' && level >= 5 && topic !== 'keys') {
      // TUI-DESIGN-4: the keys give way to their pointer before any command line is cut
      lines.push('keys', cut(ascii ? HELP_KEYS_POINTER.replace('…', '...') : HELP_KEYS_POINTER, width, ascii));
    } else if (topic !== 'commands') {
      // TUI-DESIGN-4: at level ≥ 4 the `keys` header shares the first packed row (level 1's rule for context titles),
      // which is the one row that keeps the whole key table at the default 80 columns with 41 commands
      const keyHead: string[] = [];
      if (level < 4) lines.push('keys');
      /** level ≥ 3: one packed block, each context's first item prefixed `<context>: ` */
      const merged: string[] = [];
      for (const ctx of KEY_CONTEXTS) {
        const items: string[] = [];
        for (const a of KEY_ACTIONS) {
          if (a.context !== ctx) continue;
          const keys = opts.bindings?.keysOf.get(a.id) ?? a.keys;
          if (keys.length === 0) continue;
          const shown = level >= 2 ? keys.slice(0, 1) : keys;
          items.push(`${shown.map((k) => displayKey(k, ascii)).join('/')} ${a.short}`);
        }
        if (items.length === 0) continue;
        const title = contextTitle(ctx);
        if (level >= 3) {
          merged.push(...items.map((it, i) => (i === 0 ? `${title}: ${it}` : it)));
        } else if (level === 0) {
          lines.push(`  ${title}`);
          lines.push(...packLines(items, width, '    ', sep));
        } else {
          const indent = ' '.repeat(Math.min(16, title.length + 4));
          const packed = packLines(items, width, indent, sep);
          const first = packed[0] ?? indent;
          lines.push(`  ${title}  ${first.slice(indent.length)}`.slice(0, Math.max(0, width)));
          lines.push(...packed.slice(1));
        }
      }
      if (level >= 3) {
        const packed = packLines(merged, width, '  ', sep);
        if (level >= 4 && packed.length > 0) {
          keyHead.push(cut(`keys  ${(packed[0] as string).trimStart()}`, width, ascii), ...packed.slice(1));
          lines.push(...keyHead);
        } else lines.push(...packed);
      }
      if (level >= 4 && lines.length === 0) lines.push('keys');
    }
    if (topic !== 'keys') {
      lines.push('commands');
      for (const c of COMMANDS) {
        const head = pad(helpCommandHead(c), Math.min(40, Math.floor(width / 2)));
        const tag = availTag(c);
        // the availability tag survives the cut: the title is cut to the room left beside it
        lines.push(`${cut(`${head} ${c.title}`, Math.max(1, width - cells(tag)), ascii)}${tag}`);
      }
    }
    if (topic === 'all' && level < 4) {
      // level 0: a `notes` header and one note per line; compacted levels pack the short notes (`colour-blind? …` · `light terminal? …`) into one line
      if (level === 0) {
        lines.push('notes');
        for (const n of HELP_NOTES) lines.push(cut(`  ${n}`, width, ascii));
      } else lines.push(...packLines(HELP_NOTES, width, '  ', sep));
    }
    return lines;
  };
  let lines = render(0);
  for (const level of [1, 2, 3, 4, 5] as const) if (lines.length > HELP_MAX_LINES) lines = render(level);
  if (lines.length > HELP_MAX_LINES) {
    const kept = lines.slice(0, HELP_MAX_LINES - 1);
    kept.push(cut(HELP_POINTER, width, ascii));
    return kept;
  }
  return lines;
}
