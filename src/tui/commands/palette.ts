/**
 * Palette and help rendering (TUI-DESIGN §5.3, A34, A16), pure strings shared by the Ink overlay, the
 * `--plain` composer and the screen-reader twin. Rows ≤ 8: `▌ /name   one-line title   arg hint` with a
 * Suggested group first (keyed on state), then score order; aliases hidden; unavailable rows carry
 * `(idle only)` / `(live only)`; argument sub-rows of the highlighted command fill spare rows; the last row
 * is `(i/N)  Tab completes · Enter runs an exact match · Esc closes` with `▲`/`▼` when scrolled.
 * Widths are O2's `stringWidth` (§4.2, cell-identical with string-width@8.2.2); cuts are by grapheme
 * cluster, and a parenthesised list is cut at a comma so the title ends `…)` as frame F-K shows.
 */
import type { StopReason } from '../../core/types.js';
import { cellWidth, stringWidth } from '../composer/width.js';
import { KEY_ACTIONS, KEY_CONTEXTS, displayKey, type Bindings, type KeyContext } from '../keys/bindings.js';
import { rank } from './fuzzy.js';
import { COMMANDS, type CommandSpec } from './registry.js';

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
}

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
}

/** TUI-DESIGN §5.3: the palette footer, verbatim (§24), before the `▲`/`▼` scroll marks. */
export const PALETTE_FOOTER = 'Tab completes · Enter runs an exact match · Esc closes';
/** TUI-DESIGN §24: the Suggested tag. */
export const SUGGESTED = 'Suggested';
/** TUI-DESIGN §5.3: the ≤ 8 rows of the overlay slot. */
export const PALETTE_ROWS = 8;
/** TUI-DESIGN §5.3: the help block is at most this many lines. */
export const HELP_MAX_LINES = 60;
const REWIND_MENU: readonly string[] = ['rewind', 'undo', 'resume', 'new'];
const NAME_COL = 15;
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
 * parenthesised list (`show or set caps (spend-cap, session-spend-cap, max-steps, …)`) the list is cut at
 * its last whole item and closed as `…)` — `show or set caps (spend-cap, session-spend-cap, …)`; a
 * parenthetical with no whole item left is elided as `(…)`; anything else is a plain cell cut.
 */
export function cutTitle(s: string, max: number, ascii = false): string {
  if (!Number.isFinite(max) || max <= 0) return '';
  if (cells(s) <= max) return s;
  const open = s.indexOf('(');
  if (open > 0 && s.endsWith(')')) {
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
  readonly spans: readonly [number, number][];
  readonly score: number;
}

/**
 * TUI-DESIGN §5.3 `paletteMatches` — the ranked commands for a query (the text after `/`, up to the first
 * space): the Suggested group first in table order, then score order; aliases match but are never shown
 * as rows (the alias resolves to its command).
 */
export function paletteMatches(query: string, state: PaletteState): PaletteMatch[] {
  const q = query.replace(/^\//, '').split(/\s/)[0] ?? '';
  const pool = state.rewindMenu ? COMMANDS.filter((c) => REWIND_MENU.includes(c.name)) : COMMANDS;
  const names = pool.map((c) => c.name);
  const byName = new Map(pool.map((c) => [c.name, c]));
  const ranked = q === '' ? names.map((n) => ({ candidate: n, score: 0, spans: [] as [number, number][] })) : rank(q, names, Number.POSITIVE_INFINITY);
  const seen = new Set<string>();
  const out: PaletteMatch[] = [];
  for (const r of ranked) {
    const spec = byName.get(r.candidate) as CommandSpec;
    seen.add(spec.name);
    out.push({ spec, suggested: isSuggested(spec, state), spans: r.spans.map(([a, b]) => [a + 1, b + 1] as [number, number]), score: r.score });
  }
  if (q !== '') {
    // an alias typed exactly or as a prefix pulls its command in
    for (const spec of pool) {
      if (seen.has(spec.name)) continue;
      if (spec.aliases.some((a) => a.startsWith(q))) out.push({ spec, suggested: isSuggested(spec, state), spans: [], score: 0 });
    }
  }
  const suggested = out.filter((m) => m.suggested);
  const rest = out.filter((m) => !m.suggested);
  return [...suggested, ...rest];
}

/** TUI-DESIGN §5.3: ghost text — the rest of the top match after the typed token, and how many other matches there are. */
export function paletteGhost(query: string, matches: readonly PaletteMatch[]): { rest: string; more: number } | null {
  const top = matches[0];
  if (top === undefined) return null;
  const q = query.replace(/^\//, '').split(/\s/)[0] ?? '';
  if (!top.spec.name.startsWith(q) || top.spec.name === q) return null;
  return { rest: top.spec.name.slice(q.length), more: matches.length - 1 };
}

/**
 * TUI-DESIGN §5.3 `paletteRows` — the rows for `rows` lines of the overlay slot (footer last), `selected`
 * highlighted with `▌` (`>` in ASCII); command rows scroll around the selection; spare rows show the
 * selected command's argument values (`/budget spend-cap <usd>   run cap for the next /resume or run`).
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
  const commandRows = Math.min(total, body);
  let start = 0;
  if (total > commandRows) start = Math.min(Math.max(0, sel - Math.floor(commandRows / 2)), total - commandRows);
  const out: PaletteRow[] = [];
  const nameCol = Math.min(NAME_COL, Math.floor(width / 2));
  for (let i = start; i < start + commandRows; i++) {
    const m = matches[i] as PaletteMatch;
    const isSel = i === sel;
    const name = `/${m.spec.name}`;
    const unavailable = (m.spec.availableDuringTask === 'idle' && state.live) || (m.spec.availableDuringTask === 'live' && !state.live);
    const tagText = unavailable ? (m.spec.availableDuringTask === 'idle' ? ' (idle only)' : ' (live only)') : '';
    const suggestedTag = m.suggested ? `  ${SUGGESTED}` : '';
    const head = `${isSel ? marker : blank}${pad(name, nameCol)}`;
    const avail = width - cells(head) - cells(suggestedTag) - cells(tagText);
    const title = avail > 0 ? cutTitle(m.spec.title, avail, ascii) : '';
    const text = cut(`${head}${title}${tagText}${suggestedTag}`, width, ascii);
    const shift = isSel ? marker.length : blank.length;
    out.push({ kind: 'command', text, selected: isSel, name, dim: unavailable, spans: m.spans.map(([a, b]) => [a + shift, b + shift] as [number, number]), suggested: m.suggested });
  }
  // argument sub-rows of the selected command
  const selSpec = matches[sel]?.spec;
  const arg0 = selSpec?.args[0];
  if (selSpec !== undefined && arg0?.values !== undefined && out.length < body) {
    for (const v of arg0.values) {
      if (out.length >= body) break;
      const hint = arg0.valueHints?.[v];
      const label = `/${selSpec.name} ${v}${hint?.args ? ` ${hint.args}` : ''}`;
      const head = `${blank}${pad(label, VALUE_COL)}${cells(label) >= VALUE_COL ? ' ' : ''}`;
      const avail = width - cells(head);
      const text = cut(`${head}${hint ? cut(hint.title, Math.max(0, avail), ascii) : ''}`, width, ascii);
      out.push({ kind: 'value', text, selected: false, name: `/${selSpec.name} ${v}`, dim: false, spans: [], suggested: false });
    }
  }
  out.push(footer(sel, total, start > 0, start + commandRows < total, width, ascii));
  return out;
}

function footer(sel: number, total: number, up: boolean, down: boolean, width: number, ascii: boolean): PaletteRow {
  const marks = `${up ? (ascii ? ' ^' : ' ▲') : ''}${down ? (ascii ? ' v' : ' ▼') : ''}`;
  const text = cut(`  (${total === 0 ? 0 : sel + 1}/${total})  ${ascii ? PALETTE_FOOTER.replace(/ · /g, ' - ') : PALETTE_FOOTER}${marks}`, width, ascii);
  return { kind: 'footer', text, selected: false, dim: false, spans: [], suggested: false };
}

/** TUI-DESIGN §5.3 `paletteLines` — the plain-string rows (the `lines()` twin the four renderers share). */
export function paletteLines(query: string, state: PaletteState, selected: number, rows: number, columns: number, ascii = false): string[] {
  return paletteRows(query, state, selected, rows, columns, ascii).map((r) => r.text);
}

/** TUI-DESIGN §5.3: the per-terminal notes of the help block, verbatim. */
export const HELP_NOTES: readonly string[] = ['Shift+Enter needs a keyboard protocol: use Ctrl+J or \\ then Enter', 'macOS: turn on "Option as Meta" for Alt-b/Alt-f'];

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

/**
 * TUI-DESIGN §5.3 `helpLines` — the one `<Static>` block `?`/F1/`/help` append (≤ 60 lines): keys grouped by
 * context (effective bindings when given), then commands with one-liners, then the per-terminal notes.
 * `topic` narrows it to keys or commands. Compaction levels keep the cap: the context name shares the first
 * packed line; then only the primary key of each action is shown; then the tail is cut with a pointer to
 * docs/KEYS.md and docs/COMMANDS.md.
 */
export function helpLines(columns: number, opts: { bindings?: Bindings; ascii?: boolean; topic?: 'all' | 'keys' | 'commands' } = {}): string[] {
  const width = Math.max(20, Math.floor(Number.isFinite(columns) ? columns : 80));
  const ascii = opts.ascii ?? false;
  const topic = opts.topic ?? 'all';
  const sep = ascii ? ' - ' : ' · ';
  const render = (level: 0 | 1 | 2): string[] => {
    const lines: string[] = [];
    if (topic !== 'commands') {
      lines.push('keys');
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
        if (level === 0) {
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
    }
    if (topic !== 'keys') {
      lines.push('commands');
      for (const c of COMMANDS) {
        const usage = c.usage === '—' ? '' : ` ${c.usage}`;
        const head = pad(`  /${c.name}${usage}`, Math.min(40, Math.floor(width / 2)));
        lines.push(cut(`${head} ${c.title}${c.availableDuringTask === 'any' ? '' : ` (${c.availableDuringTask} only)`}`, width, ascii));
      }
    }
    if (topic === 'all') {
      if (level === 0) lines.push('notes');
      for (const n of HELP_NOTES) lines.push(cut(`  ${n}`, width, ascii));
    }
    return lines;
  };
  let lines = render(0);
  if (lines.length > HELP_MAX_LINES) lines = render(1);
  if (lines.length > HELP_MAX_LINES) lines = render(2);
  if (lines.length > HELP_MAX_LINES) {
    const kept = lines.slice(0, HELP_MAX_LINES - 1);
    kept.push(cut('  … see docs/KEYS.md and docs/COMMANDS.md for the rest', width, ascii));
    return kept;
  }
  return lines;
}
