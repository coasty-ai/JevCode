/**
 * Toasts (TUI-DESIGN §7.5, A37): `! <text>` for 2 s (4 s for errors) and `✓ <text>` replace the
 * status line's left zone. The queue holds at most four; an error toast pre-empts an info toast.
 *
 * Toasts display one at a time — every unexpired error in queue order, then every other toast in
 * queue order (`activeToast`) — so a toast's `untilMs` is stamped for the moment it becomes
 * visible, not for the moment it was pushed: a burst of four toasts shows all four, each for its
 * full duration. A pushed error shifts the queued non-error toasts by its own duration (they
 * resume after it); removing a toast pulls its successors forward by the time it would still have
 * been visible. The clock is `nowMs`, passed in by the 1 Hz tick (§15 item 20), never read here;
 * the only process-wide state is the id high-water mark, so an id is never reused across frames.
 */
import { GLYPHS } from './glyphs.js';
import { oneLine } from './plain.js';

/** TUI-DESIGN §15 item 20: `UiState.toasts` element (O9 imports this shape rather than redefining it). */
export interface Toast {
  id: number;
  text: string;
  level: 'info' | 'error' | 'ok';
  untilMs: number;
}

/** TUI-DESIGN §7.5: the queue never holds more than four toasts. */
export const TOAST_MAX = 4;
/** TUI-DESIGN §7.5: info and `✓` toasts last 2 s. */
export const TOAST_INFO_MS = 2000;
/** TUI-DESIGN §7.5: error toasts last 4 s. */
export const TOAST_ERROR_MS = 4000;
/** Storage bound of a toast's text in UTF-16 code units, cut on a grapheme boundary (the status line clips by cell). */
export const TOAST_TEXT_MAX = 400;

/** TUI-DESIGN §7.5 / §15 item 20: `toast` (push), `tick` (expiry), `dismiss` (one), `clear` (all). */
export type ToastAction =
  | { type: 'toast'; text: string; level: Toast['level']; ms?: number }
  | { type: 'tick' }
  | { type: 'dismiss'; id: number }
  | { type: 'clear' };

/** TUI-DESIGN §7.5: the duration a toast of `level` stays visible. */
export function toastDurationMs(level: Toast['level']): number {
  return level === 'error' ? TOAST_ERROR_MS : TOAST_INFO_MS;
}

/** TUI-DESIGN-3 §5.2 A7: a toast's text is `dim` for its final second (`untilMs − nowMs ≤ TOAST_FADE_MS`). */
export const TOAST_FADE_MS = 1000;

/** TUI-DESIGN-3 §5.2 A7: `visible` until the last second, `fading` inside it (⇔ `untilMs − nowMs ≤ 1000`); a dim step is not motion, so reduced motion draws it too. */
export function toastPhase(t: Pick<Toast, 'untilMs'>, nowMs: number): 'visible' | 'fading' {
  const now = Number.isNaN(nowMs) || nowMs === Number.NEGATIVE_INFINITY ? 0 : nowMs;
  return t.untilMs - now <= TOAST_FADE_MS ? 'fading' : 'visible';
}

/** TUI-DESIGN-3 §5.2 A7: the colour role of a toast by level — `!` info `accent`, `✓` ok `ok`, `!` error `error`. */
export function toastRole(level: Toast['level']): 'accent' | 'ok' | 'error' {
  return level === 'ok' ? 'ok' : level === 'error' ? 'error' : 'accent';
}

// ---------------------------------------------------------------------------------------
// Text hygiene (§14.1) shared with the status line's centre zone
// ---------------------------------------------------------------------------------------

// Bidi controls (ALM, LRM/RLM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI) and every other Format character except the ZWJ
// (U+200D), which emoji sequences need: a `/rename` title or toast must never reorder or hide part of the status row.
const BIDI_AND_FORMAT_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]|(?!\u200d)\p{Cf}/gu;
const LINE_SEP_RE = /[\u2028\u2029]/g;
const SPACE_RUN_RE = / {2,}/g;

/**
 * TUI-DESIGN §14.1: `oneLine` (C0/C1 dropped, line breaks → ` ⏎ `, tabs → space) plus what `sanitizeStream`
 * promises and `plain.ts` does not yet strip — bidi controls and invisible Format characters (ZWJ excepted so
 * emoji families survive) — with U+2028/2029 treated as line breaks and space runs collapsed. Pure.
 */
export function oneLineSafe(s: string): string {
  const text = typeof s === 'string' ? s : String(s);
  return oneLine(text.replace(LINE_SEP_RE, '\n')).replace(BIDI_AND_FORMAT_RE, '').replace(SPACE_RUN_RE, ' ');
}

let foldRe: RegExp | null = null;
let foldMap: Map<string, string> | null = null;

function foldTable(): { re: RegExp; map: Map<string, string> } {
  if (foldRe === null || foldMap === null) {
    const map = new Map<string, string>();
    const u = GLYPHS.unicode;
    const a = GLYPHS.ascii;
    for (const key of Object.keys(u) as (keyof typeof u)[]) {
      if (key === 'mode') continue;
      const from = u[key];
      const to = a[key];
      if (typeof from === 'string' && typeof to === 'string') {
        if (from !== to && from.length > 0) map.set(from, to);
      } else if (Array.isArray(from) && Array.isArray(to) && key !== 'spinner') {
        from.forEach((f, i) => {
          const t = to[i];
          if (typeof t === 'string' && f.length > 0 && f !== t) map.set(f, t);
        });
      }
    }
    map.set('⏎', '|');
    const alts = [...map.keys()].sort((x, y) => y.length - x.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    foldRe = new RegExp(alts.join('|'), 'g');
    foldMap = map;
  }
  return { re: foldRe, map: foldMap };
}

/** TUI-DESIGN §14.1: substitute every glyph of the table by its `--ascii` twin (`—`→`-`, `✓`→`+`, `…`→`...`, `⏎`→`|`, …) in free text. */
export function asciiFold(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const { re, map } = foldTable();
  return s.replace(re, (m) => map.get(m) ?? m).replace(SPACE_RUN_RE, ' ');
}

let graphemeSegmenter: Intl.Segmenter | null = null;

/** Cut to at most `max` code units on a grapheme boundary (never a lone surrogate or a split emoji sequence). */
function clipUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let out = '';
  for (const { segment } of graphemeSegmenter.segment(s.slice(0, max + 32))) {
    if (out.length + segment.length > max) break;
    out += segment;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------------------

/** NaN and −Infinity read as 0 (nothing has expired); +Infinity is kept so an infinite clock expires everything. */
function clock(nowMs: number): number {
  return Number.isNaN(nowMs) || nowMs === Number.NEGATIVE_INFINITY ? 0 : nowMs;
}

function unexpired(toasts: readonly Toast[], now: number): Toast[] {
  return toasts.filter((t) => t.untilMs > now);
}

/** Indices of `queue` in display order: errors first (queue order), then everything else (queue order). */
function displayOrder(queue: readonly Toast[]): number[] {
  const errors: number[] = [];
  const others: number[] = [];
  queue.forEach((t, i) => (t.level === 'error' ? errors : others).push(i));
  return errors.concat(others);
}

/** Remove `queue[i]` and pull every toast that displays after it forward by the time it would still have been visible. */
function removeAt(queue: Toast[], i: number, now: number): void {
  const order = displayOrder(queue);
  const pos = order.indexOf(i);
  const victim = queue[i]!;
  const pred = pos > 0 ? queue[order[pos - 1]!] : undefined;
  const start = pred === undefined ? now : Math.max(now, pred.untilMs);
  const gain = Math.max(0, victim.untilMs - start);
  if (gain > 0) {
    for (let k = pos + 1; k < order.length; k++) {
      const j = order[k]!;
      const t = queue[j]!;
      queue[j] = { ...t, untilMs: t.untilMs - gain };
    }
  }
  queue.splice(i, 1);
}

let idHighWater = 0;

/** The next id: above every id ever handed out by this process and above every id in `seen` (a caller-built array included). */
function nextId(seen: readonly Toast[]): number {
  let m = idHighWater;
  for (const t of seen) if (Number.isFinite(t.id) && t.id > m) m = Math.floor(t.id);
  idHighWater = m + 1;
  return idHighWater;
}

/**
 * TUI-DESIGN §7.5: the toast reducer. `toast` appends with a deadline chained after the toasts it displays
 * behind (a repeat of the same text and level while that toast is visible refreshes it instead of duplicating
 * it); `tick` drops expired toasts; `dismiss` removes one; `clear` empties the queue. Capacity: at four, an
 * error toast evicts the oldest non-error toast (or the oldest toast when all four are errors); an info/ok
 * toast evicts the oldest non-error toast and is dropped when the queue holds only errors. Never mutates its
 * input; returns the input array when nothing changed.
 */
export function toastReducer(toasts: readonly Toast[], action: ToastAction, nowMs: number): readonly Toast[] {
  const now = clock(nowMs);
  const base = Number.isFinite(now) ? now : 0;
  const live = unexpired(toasts, now);
  const unchanged = (): readonly Toast[] => (live.length === toasts.length ? toasts : live);
  switch (action.type) {
    case 'tick':
      return unchanged();
    case 'clear':
      return toasts.length === 0 ? toasts : [];
    case 'dismiss': {
      const i = live.findIndex((t) => t.id === action.id);
      if (i === -1) return unchanged();
      const next = live.slice();
      removeAt(next, i, base);
      return next;
    }
    case 'toast': {
      const text = clipUnits(oneLineSafe(action.text).trim(), TOAST_TEXT_MAX);
      if (text.length === 0) return unchanged();
      const level: Toast['level'] = action.level === 'error' || action.level === 'ok' ? action.level : 'info';
      const ms = action.ms !== undefined && Number.isFinite(action.ms) && action.ms > 0 ? action.ms : toastDurationMs(level);
      const dup = live.findIndex((t) => t.text === text && t.level === level);
      if (dup !== -1) {
        const order = displayOrder(live);
        if (order[0] !== dup) return unchanged(); // queued: it already has its full duration ahead of it
        const t = live[dup]!;
        const until = Math.max(t.untilMs, base + ms);
        const delta = until - t.untilMs;
        if (delta === 0) return unchanged();
        const refreshed = live.slice();
        refreshed[dup] = { ...t, untilMs: until };
        for (let k = 1; k < order.length; k++) {
          const j = order[k]!;
          refreshed[j] = { ...refreshed[j]!, untilMs: refreshed[j]!.untilMs + delta };
        }
        return refreshed;
      }
      const queue = live.slice();
      const isError = level === 'error';
      if (queue.length >= TOAST_MAX) {
        const victim = queue.findIndex((t) => t.level !== 'error');
        if (victim !== -1) removeAt(queue, victim, base);
        else if (isError) removeAt(queue, 0, base);
        else return unchanged();
      }
      // chain: an error displays after the queued errors, anything else after every queued toast
      let start = base;
      for (const t of queue) if ((!isError || t.level === 'error') && t.untilMs > start) start = t.untilMs;
      if (isError) {
        // pre-emption: the queued non-error toasts resume after this error
        for (let i = 0; i < queue.length; i++) {
          const t = queue[i]!;
          if (t.level !== 'error') queue[i] = { ...t, untilMs: t.untilMs + ms };
        }
      }
      queue.push({ id: nextId(toasts), text, level, untilMs: start + ms });
      return queue;
    }
  }
}

/** TUI-DESIGN §7.5: the toast the left zone shows now — the oldest unexpired error, else the oldest unexpired toast. */
export function activeToast(toasts: readonly Toast[], nowMs: number): Toast | null {
  const now = clock(nowMs);
  let first: Toast | null = null;
  for (const t of toasts) {
    if (t.untilMs <= now) continue;
    if (t.level === 'error') return t;
    if (first === null) first = t;
  }
  return first;
}

/** TUI-DESIGN §7.5 / §14.1: `! <text>` for info and errors, `✓ <text>` for ok (`+` under --ascii, where the text is glyph-folded too). */
export function toastText(t: Pick<Toast, 'text' | 'level'>, ascii = false): string {
  const mark = t.level === 'ok' ? (ascii ? GLYPHS.ascii.check : GLYPHS.unicode.check) : '!';
  return `${mark} ${ascii ? asciiFold(t.text) : t.text}`;
}

/** TUI-DESIGN §7.5: the next `tick` deadline (ms) that could change the visible toast, or null when the queue is idle. */
export function nextToastExpiry(toasts: readonly Toast[], nowMs: number): number | null {
  const now = clock(nowMs);
  let next: number | null = null;
  for (const t of toasts) if (t.untilMs > now && (next === null || t.untilMs < next)) next = t.untilMs;
  return next;
}

// ---------------------------------------------------------------------------------------
// Cross-session messages (TUI-DESIGN-5 §2.9, §12 S6, S31–S34) — which surface each verb takes
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN-5 §2.9: the three verbs that write into another session's mailbox. */
export type MessageVerb = 'tell' | 'headsup' | 'request';

/**
 * TUI-DESIGN-5 §2.9: the three gated verbs a `request` can ask for. Structurally `RequestVerb`
 * (`src/tui/commands/dispatch.ts`), spelled again here so this module stays import-free of the dispatcher — the
 * dependency runs the other way (`dispatch.ts` is the command layer, `toasts.ts` the render layer).
 */
export type MessageRequestVerb = 'pause' | 'end' | 'steer';

/**
 * TUI-DESIGN-5 §2.9's toast rules, as data so the App cannot re-derive them differently from the CLI:
 *
 * - `headsup` is a **toast** and nothing else — it is informational and nobody is waiting on an answer.
 * - `tell` is a **toast plus the `✉` count** in the peer zone, so a message read past its 2 s is still findable.
 * - `request` is **never a toast** — it is a persistent row, because it needs an answer (§12 S32).
 *
 * Every applied remote verb also writes a `[session]` transcript item (§2.9, §13.1): "a toast is never the only
 * record", which is why `transcriptItem` is true for all three.
 */
export interface MessageSurface {
  readonly toast: boolean;
  readonly persistentRow: boolean;
  readonly mailCount: boolean;
  readonly transcriptItem: true;
}
export const MESSAGE_SURFACES: Readonly<Record<MessageVerb, MessageSurface>> = {
  tell: { toast: true, persistentRow: false, mailCount: true, transcriptItem: true },
  headsup: { toast: true, persistentRow: false, mailCount: false, transcriptItem: true },
  request: { toast: false, persistentRow: true, mailCount: false, transcriptItem: true },
};

/** TUI-DESIGN-5 §2.9: the surface set for a verb. */
export function messageSurface(verb: MessageVerb): MessageSurface {
  return MESSAGE_SURFACES[verb];
}

/**
 * TUI-DESIGN-5 §2.9 / §7 row 18: a message from a device this one has not paired with is rendered with
 * `(unverified)` and **never auto-applies**. The suffix is the whole rendering difference — the row is still shown,
 * because hiding it would make an unpaired peer invisible rather than untrusted.
 */
export const UNVERIFIED_SUFFIX = ' (unverified)';

function withAuthority(text: string, verified: boolean): string {
  return verified ? text : `${text}${UNVERIFIED_SUFFIX}`;
}

/**
 * TUI-DESIGN-5 §12 S31: the body of the `[session]` transcript item — `mbp: committed 3f9a2c1 on main — engine.ts,
 * store.ts`. The label itself is `UiLabel '[session]'` (contract 1.8 item 2) and is the renderer's, not this
 * string's; `labelRole` gives it `'dim'` (§8.1 item 2's decision, recorded in `theme.ts`).
 */
export function sessionMessageText(from: string, text: string, verified = true): string {
  return withAuthority(`${oneLineSafe(from)}: ${oneLineSafe(text)}`, verified);
}

/**
 * TUI-DESIGN-5 §12 S32 (`pause`) and its two siblings, one per `RequestVerb`: the persistent `request` row —
 * never a toast, because it needs an answer.
 *
 * **Only the `pause` arm is a landed §12 string.** The `end` and `steer` bodies are new this round and are filed
 * for §12.1 as **S32a** and **S32b** in the W5 docs PR, the same way S43a/S43b/S43c were — §13.4 requires every
 * §12 string to be an anchor, and an invented string that no table carries is exactly what that rule forbids.
 * `end` says **session**, not run: §2.7 makes `/end` a session verb (it writes `RunMeta.ended` and one
 * `session:end` line), so a row that said "end this run" would name an object the verb does not act on.
 *
 * All three offer the same answers the local ladder does, so `[Y]` means the same thing at both ends.
 */
export function requestRowText(from: string, verb: MessageRequestVerb, verified = true): string {
  const body =
    verb === 'pause'
      ? 'pause this run — [y] pause at step end  [Y] pause now  [n] ignore'
      : verb === 'end'
        ? 'end this session — [y] end at step end  [Y] end now  [n] ignore'
        : 'take a steer — [y] take it  [n] ignore';
  return withAuthority(`${oneLineSafe(from)} asks to ${body}`, verified);
}

/** TUI-DESIGN-5 §12 S32 / S32a / S32b, as data — the row per verb, so a caller cannot spell one of them itself. */
export const REQUEST_ROW_ANCHORS: Readonly<Record<MessageRequestVerb, string>> = {
  pause: '<from> asks to pause this run — [y] pause at step end  [Y] pause now  [n] ignore',
  end: '<from> asks to end this session — [y] end at step end  [Y] end now  [n] ignore',
  steer: '<from> asks to take a steer — [y] take it  [n] ignore',
};

/** TUI-DESIGN-5 §12 S33: the `headsup` broadcast body — `heads-up: editing src/loop/engine.ts (+1) for: <task60>`. */
export function headsUpText(files: readonly string[], task60: string): string {
  const first = oneLineSafe(files[0] ?? '');
  const more = files.length > 1 ? ` (+${files.length - 1})` : '';
  const head = first === '' ? 'heads-up' : `heads-up: editing ${first}${more}`;
  const task = oneLineSafe(task60).trim();
  return task === '' ? head : `${head} for: ${task}`;
}

/** TUI-DESIGN-5 §12 S34: the `request-release` body — `mbp is waiting for src/x.ts — commit and move on when you can`. */
export function waitingForText(from: string, path: string): string {
  return `${oneLineSafe(from)} is waiting for ${oneLineSafe(path)} — commit and move on when you can`;
}

/**
 * TUI-DESIGN-5 §2.2 / §12 S6: the **one** screen-reader announcement the peer zone makes. The status line is never
 * read live (TD4 §5.8's rule); only a 0 → ≥ 1 change in unread directed messages announces, once —
 * `1 message from mbp — /inbox reads it`. `null` when the count did not cross zero, so a re-render never repeats it.
 *
 * §12 S6's SR cell gives the singular only; the plural (`3 messages from mbp — /inbox reads it`), which a crossing
 * from 0 to 3 in one fold produces, is filed for §12.1 as **S6a** in the W5 docs PR.
 */
export function unreadAnnounce(before: number, after: number, from: string): string | null {
  if (before > 0 || after < 1) return null;
  const n = Math.max(1, Math.floor(after));
  return `${n} message${n === 1 ? '' : 's'} from ${oneLineSafe(from)} — /inbox reads it`;
}
