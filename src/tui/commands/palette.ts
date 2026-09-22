/**
 * Palette and help rendering (TUI-DESIGN §5.3, A34, A16; TUI-DESIGN-3 §4.1–§4.2, D-K), pure strings shared by the Ink overlay,
 * the `--plain` composer and the screen-reader twin. Rows ≤ 8: `▌ /name   a  one-line title   tag` with a Suggested group first
 * (keyed on state), then — for an empty query — the Recent group (≤ 3 distinct commands, newest first, tag `recent`), the Popular
 * group (`POPULAR`, no tag: the alias column is the cue) and the rest in table order; a non-empty query collapses the groups into
 * score order (Suggested first), and an exact alias pins its owner to the top (score 1000, like an exact name — `/s` shows `/status`
 * before `/steer`). Command rows carry a 3-cell dim alias column (the shortest alias) between the name and the title, hidden below
 * 50 columns; every command row is exactly the width. Unavailable rows carry `(idle only)` / `(live only)`; argument sub-rows of
 * the highlighted command fill spare rows (the `/mode` row equal to `DEFAULT_MODE` reads ` (default)`); the last row is
 * `(i/N)  Tab completes · Enter runs an exact match · Esc closes` with `▲`/`▼` when scrolled. Widths are O2's `stringWidth` (§4.2, cell-identical with string-width@8.2.2); cuts are by grapheme
 * cluster, and a parenthesised list is cut at a comma so the title ends `…)` as frame F-K shows.
 */
import type { StopReason } from '../../core/types.js';
import { cellWidth, stringWidth } from '../composer/width.js';
import { KEY_ACTIONS, KEY_CONTEXTS, displayKey, type Bindings, type KeyContext } from '../keys/bindings.js';
import { rank } from './fuzzy.js';
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
  readonly kind: 'command' | 'value' | 'footer';
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

/** TUI-DESIGN §5.3: the palette footer, verbatim (§24), before the `▲`/`▼` scroll marks. */
export const PALETTE_FOOTER = 'Tab completes · Enter runs an exact match · Esc closes';
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
function argTokenOf(query: string): string | null {
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
 * TUI-DESIGN §5.3 / TUI-DESIGN-3 §4.1 rule 3: the ghost after the typed token. A prefix of the top match ghosts its rest
 * (`+tatus (+N)`); an alias hit (the token is an alias of the top match, exactly or as a prefix, so the name does not simply
 * extend it) ghosts the arrow ` → /status` — `arrow` set, `rest` empty — and `→` at the end of the text accepts it as `/status `.
 * `more` is the count of other matches in both forms. Null when the token is the exact name or nothing matches.
 */
export type PaletteGhost = { readonly rest: string; readonly more: number; readonly arrow?: string };

/** TUI-DESIGN §5.3 / TUI-DESIGN-3 §4.1 rule 3 `paletteGhost` — see `PaletteGhost`. */
export function paletteGhost(query: string, matches: readonly PaletteMatch[]): PaletteGhost | null {
  const top = matches[0];
  if (top === undefined) return null;
  const q = tokenOf(query);
  const more = matches.length - 1;
  if (q !== '' && top.spec.aliases.includes(q)) return { rest: '', more, arrow: `/${top.spec.name}` };
  if (top.spec.name.startsWith(q)) return top.spec.name === q ? null : { rest: top.spec.name.slice(q.length), more };
  if (q !== '' && top.spec.aliases.some((a) => a.startsWith(q))) return { rest: '', more, arrow: `/${top.spec.name}` };
  return null;
}

/**
 * TUI-DESIGN §5.3 `paletteRows` — the rows for `rows` lines of the overlay slot (footer last), `selected`
 * highlighted with `▌` (`>` in ASCII); command rows scroll around the selection; spare rows show the
 * selected command's argument values (`/budget spend-cap <usd>   run cap for the next /resume or run`).
 * TUI-DESIGN-3 §4.1 rule 4 / §4.2 row anatomy (76 cells inside the card, 60 flat): marker `▌ ` / two spaces (2) ·
 * name `padEnd(12)` · alias `padEnd(2)` + space (3, ≥ 50 columns) · title clipped with `…` to the remaining budget ·
 * two spaces + the group tag at the right edge when one exists; every row (command, value, footer) is exactly `columns` cells.
 */
export function paletteRows(query: string, state: PaletteState, selected: number, rows: number, columns: number, ascii = false): PaletteRow[] {
  const n = Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  if (n === 0) return [];
  const width = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 80));
  const matches = paletteMatches(query, state);
  const total = matches.length;
  const marker = ascii ? '> ' : '▌ ';
  const blank = '  ';
  const sel = total === 0 ? 0 : Math.min(Math.max(0, Math.floor(selected) || 0), total - 1);
  if (n === 1) return [footer(sel, total, false, false, width, ascii)];
  const body = n - 1;
  // TUI-DESIGN-3 §4.2 F-P2: an exact token (`/m`) whose command has value sub-rows keeps them on screen even when the matches
  // overflow — the command rows shrink to `max(2, body − values)` and the footer's ▼ says the rest scrolls; otherwise the
  // matches come first and the sub-rows take the spare rows (F-K)
  const exactSpec = tokenOf(query) === '' ? null : findCommand(tokenOf(query));
  const exactValues = exactSpec !== null && exactSpec === matches[sel]?.spec ? (exactSpec.args[0]?.values?.length ?? 0) : 0;
  const commandRows = total > body && exactValues > 0 ? Math.min(total, body, Math.max(2, body - exactValues)) : Math.min(total, body);
  let start = 0;
  if (total > commandRows) start = Math.min(Math.max(0, sel - Math.floor(commandRows / 2)), total - commandRows);
  const out: PaletteRow[] = [];
  // TUI-DESIGN-3 §4.1 rule 4: the alias column is hidden below 50 columns — the name column then keeps today's 15 cells
  const aliasCol = width >= ALIAS_MIN_COLUMNS;
  const nameCol = aliasCol ? NAME_COL : Math.min(NAME_COL + ALIAS_COL, Math.floor(width / 2));
  for (let i = start; i < start + commandRows; i++) {
    const m = matches[i] as PaletteMatch;
    const isSel = i === sel;
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
  // argument sub-rows of the selected command; TUI-DESIGN-3 §4.3: a typed partial (`/budget sp`) filters them to the same
  // candidates Tab cycles through, the value equal to the token highlighted
  const selSpec = matches[sel]?.spec;
  const arg0 = selSpec?.args[0];
  if (selSpec !== undefined && arg0?.values !== undefined && out.length < body) {
    const argToken = argTokenOf(query);
    const values = argToken === null || argToken === '' ? arg0.values : rank(argToken, arg0.values, Number.POSITIVE_INFINITY).map((r) => r.candidate);
    for (const v of values) {
      if (out.length >= body) break;
      const hint = arg0.valueHints?.[v];
      const label = `/${selSpec.name} ${v}${hint?.args ? ` ${hint.args}` : ''}`;
      const head = `${blank}${pad(label, VALUE_COL)}${cells(label) >= VALUE_COL ? ' ' : ''}`;
      const avail = width - cells(head);
      // the ` (default)` suffix survives the cut: the title is cut to the room left beside it
      const suffix = arg0.defaultValue === v ? ' (default)' : '';
      const hintText = hint ? `${cut(hint.title, Math.max(0, avail - cells(suffix)), ascii)}${suffix}` : '';
      const text = pad(cut(`${head}${hintText}`, width, ascii), width);
      out.push({ kind: 'value', text, selected: argToken !== null && argToken !== '' && v.toLowerCase() === argToken, name: `/${selSpec.name} ${v}`, dim: false, spans: [], suggested: false, tag: null });
    }
  }
  out.push(footer(sel, total, start > 0, start + commandRows < total, width, ascii));
  return out;
}

function footer(sel: number, total: number, up: boolean, down: boolean, width: number, ascii: boolean): PaletteRow {
  const marks = `${up ? (ascii ? ' ^' : ' ▲') : ''}${down ? (ascii ? ' v' : ' ▼') : ''}`;
  const text = pad(cut(`  (${total === 0 ? 0 : sel + 1}/${total})  ${ascii ? PALETTE_FOOTER.replace(/ · /g, ' - ') : PALETTE_FOOTER}${marks}`, width, ascii), width);
  return { kind: 'footer', text, selected: false, dim: false, spans: [], suggested: false, tag: null };
}

/** TUI-DESIGN §5.3 `paletteLines` — the plain-string rows (the `lines()` twin the four renderers share). */
export function paletteLines(query: string, state: PaletteState, selected: number, rows: number, columns: number, ascii = false): string[] {
  return paletteRows(query, state, selected, rows, columns, ascii).map((r) => r.text);
}

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
  'the per-terminal notes are dropped — a command line (`/exit`) outranks a terminal tip',
];

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
  const render = (level: 0 | 1 | 2 | 3 | 4): string[] => {
    const lines: string[] = [];
    if (topic !== 'commands') {
      lines.push('keys');
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
      if (level >= 3) lines.push(...packLines(merged, width, '  ', sep));
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
  for (const level of [1, 2, 3, 4] as const) if (lines.length > HELP_MAX_LINES) lines = render(level);
  if (lines.length > HELP_MAX_LINES) {
    const kept = lines.slice(0, HELP_MAX_LINES - 1);
    kept.push(cut(HELP_POINTER, width, ascii));
    return kept;
  }
  return lines;
}
