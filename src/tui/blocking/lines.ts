/**
 * Blocking panes and the severity → surface map (TUI-DESIGN §13.1, §13.3, §24) — pure.
 *
 * `blockingLines(req, rows, columns, g)` renders every `BlockingRequest` kind into ≤ 4 rows for the overlay slot,
 * shared by the Ink overlay, `--plain` and the screen-reader twin. The width reaches the kind (so a keys rung
 * ladder picks its rung rather than being truncated) and so does the glyph set (so the `--ascii` twin of a row's
 * em dash is produced here, not left to the caller). The `*Detail` builders fix how the engine
 * encodes each kind's facts into `BlockingRequest.detail` so the rows can be rendered from the contract alone.
 * Rows are measured and cut in cells (O2's `width.ts`, §4.2), never by Ink wrapping (§2.1).
 */
import type { BlockingKind, BlockingRequest, EngineEvent, PeerView } from '../../core/types.js';
import { type DiskErrorCode, DISK_ERROR_CODES, degradedConsequence } from '../../checkpoint/store.js';
import { explainFsError } from '../../errors.js';
import { JEV_RETRY } from '../../jev/types.js';
import { stringWidth, truncateCells } from '../composer/width.js';
import { fitRung } from '../fit.js';
import { GLYPHS } from '../glyphs.js';
import type { GlyphSet } from '../glyphs.js';
import { sanitizeStream } from '../plain.js';

export const BLOCKING_MAX_ROWS = 4;
/** Provider messages are clipped to this many characters (TUI-DESIGN §13.3). */
export const BLOCKING_MESSAGE_MAX = 120;
/** The Jev retry chain length the unreachable pane names (`jev unreachable after 3 attempts`, TUI-DESIGN §13.3). */
export const JEV_ATTEMPTS: number = JEV_RETRY.attempts;
/** The file the checkpoint-degraded rows name when the detail carries none (TUI-DESIGN §24: `state.json could not be written …`). */
export const CHECKPOINT_DEGRADED_DEFAULT_FILE = 'state.json';

// ---------------------------------------------------------------------------------------
// Untrusted text (TUI-DESIGN §14.1)
// ---------------------------------------------------------------------------------------

/**
 * TUI-DESIGN §14.1: the bidi controls a provider or generator string could use to reorder a row visually
 * (trojan-source style) — ALM, LRM/RLM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI — plus the BOM. `sanitizeStream`
 * (the single choke point, `plain.ts`) owns C0/C1; this list is the §14.1 extension until O10 folds it in.
 */
// eslint-disable-next-line no-misleading-character-class
const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * TUI-DESIGN §14.1 untrusted text on one row: newlines and U+2028/U+2029 collapse to a space, tabs to a space,
 * C0/C1 controls and DEL are dropped through `sanitizeStream`, bidi controls are dropped, then trimmed. Pure.
 */
export function terminalSafeLine(s: string): string {
  return sanitizeStream(s.replace(/\r\n|\r|\n|\u2028|\u2029/g, ' ').replace(/\t/g, ' '))
    .replace(BIDI_CONTROL_RE, '')
    .trim();
}

/** TUI-DESIGN §13.3 (`≤ 120 chars`): clip to `max` code points with `…` (never splits a surrogate pair). */
export function clipCodePoints(s: string, max: number): string {
  const cps = [...s];
  if (cps.length <= max) return s;
  return `${cps.slice(0, Math.max(0, max - 1)).join('')}…`;
}

// ---------------------------------------------------------------------------------------
// detail encodings (builders + parsers keep the round trip in one module)
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN §13.3 / §24: `HTTP 401 — "User not found."` — the parenthetical of the key-rejected title (message clipped to 120, one line). */
export function keyRejectedDetail(status: number, message: string): string {
  return `HTTP ${status} — "${clipCodePoints(terminalSafeLine(message), BLOCKING_MESSAGE_MAX)}"`;
}

/** `ENOSPC on state.json` (TUI-DESIGN §13.3; the store's classifyDiskError produces the same text after `checkpoint degraded: `). */
export function checkpointDegradedDetail(code: string, file: string): string {
  return `${code} on ${file}`;
}

/**
 * TUI-DESIGN §13.3: inverse of checkpointDegradedDetail. A detail that is not `<code> on <file>` reads as the
 * code alone (`unknown` when empty) against the default `state.json`, so the rows never show an empty name.
 */
export function parseCheckpointDegradedDetail(detail: string): { code: string; file: string } {
  const text = terminalSafeLine(detail);
  const m = /^(\S+) on (\S.*)$/.exec(text);
  if (m && m[1] !== undefined && m[2] !== undefined) return { code: m[1], file: m[2].trim() };
  return { code: text.length > 0 ? text : 'unknown', file: CHECKPOINT_DEGRADED_DEFAULT_FILE };
}

/** TUI-DESIGN §13.3: `<configured> → <served>` for the first-call alias drift pane. */
export function driftDetail(configured: string, served: string): string {
  return `${configured} → ${served}`;
}

/** TUI-DESIGN §13.3: inverse of driftDetail; a detail without the arrow reads as `served` alone. */
export function parseDriftDetail(detail: string): { configured: string; served: string } {
  const m = /^(.*?)\s+(?:→|->)\s+(.*)$/.exec(detail);
  if (m && m[1] !== undefined && m[2] !== undefined) return { configured: m[1], served: m[2] };
  return { configured: detail, served: detail };
}

/** TUI-DESIGN §13.3 (`retrying in 30 s`, `5 min`): the auto-retry countdown text. */
export function formatRetryIn(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs === 0 ? `${m} min` : `${m} min ${rs} s`;
}

// ---------------------------------------------------------------------------------------
// rows (§24 "Blocking panes")
// ---------------------------------------------------------------------------------------

/**
 * The rows of one pane before fitting: the reason (`title`; for the single-row kinds its ` · `-separated
 * segments), the informative middle rows and the keys. `inline` marks the kinds whose §24 text is one row
 * (title segments and keys joined with ` · `).
 */
export interface BlockingRows {
  title: string[];
  middle: string[];
  keys: string;
  inline: boolean;
  /**
   * TUI-DESIGN-5 §12 S39c: the separator an `inline` kind joins its title segments and keys with. Optional and
   * defaulting to ` · `, so every landed kind is unchanged; `land-preflight` pins ` — ` because §12 writes it
   * that way (`7 uncommitted files, … — [c] commit them …`).
   */
  joiner?: string;
}

/** TUI-DESIGN-5 §12: the default `inline` separator, unchanged from round 1. */
export const INLINE_JOINER = ' · ';

function joinerOf(s: BlockingRows): string {
  return s.joiner ?? INLINE_JOINER;
}

function sideWord(req: BlockingRequest): 'jev' | 'generator' {
  return req.side ?? 'jev';
}

function isDiskCode(code: string): code is DiskErrorCode {
  return (DISK_ERROR_CODES as readonly string[]).includes(code);
}

/** TUI-DESIGN-4 §7.2 edge 6: the consequence clause, or today's wording for a code the store does not classify. */
function consequenceFor(code: string): string {
  return isDiskCode(code) ? degradedConsequence(code) : 'the run cannot be resumed from here';
}

/**
 * TUI-DESIGN-4 §7.4 item 6: the one-row fix `explainFsError` names for this errno, or null when it has none.
 * The pane has no path, so the generic `run-dir` wording is used — the row is the *fix*, not the location.
 */
function fsFixFor(code: string): string | null {
  const x = explainFsError({ code }, { op: 'run-dir' });
  return x === null ? null : (x.fix[0] ?? null);
}

// ---------------------------------------------------------------------------------------
// The peer-lease pane (TUI-DESIGN-4 §7.10 item 3, P-D10)
// ---------------------------------------------------------------------------------------

/** TUI-DESIGN-4 §7.10 item 3 / §12: the keys when a live peer holds the exclusive lease. */
export const PEER_LEASE_KEYS = '[w] wait for it   [r] read-only session   [q] quit';
/** TUI-DESIGN-4 §7.10 edge 1 / §12: a stale entry from a killed instance must never block. */
export const PEER_STALE_KEYS = '[c] continue';

/**
 * TUI-DESIGN-4 §7.10 item 3: the blocking pane shown when a peer holds an exclusive lease on this workspace and
 * this instance would write.
 *
 * Structure only, through the same `blockingRowsStructured` shape, so `blockingLines`' fitting, the `--plain`
 * twin and the screen-reader twin are the existing ones. It is **not** a `BlockingKind`: the registry is another
 * design's (`docs/COORDINATION-DESIGN.md`) and contract 1.7 adds no blocking kind, so nothing in `core/types.ts`
 * moves for it. Edge 1: with only stale entries the pane offers `[c] continue` and never waits. Edge 5: the pane
 * is dismissible — a peer problem must never wedge the composer (§7.1's lesson).
 */
export function peerLeaseRows(view: PeerView): BlockingRows {
  const live = Number.isFinite(view.live) ? Math.max(0, Math.floor(view.live)) : 0;
  const stale = Number.isFinite(view.stale) ? Math.max(0, Math.floor(view.stale)) : 0;
  const blocking = view.exclusive && live > 1;
  const title = blocking
    ? [`another jevcode holds this workspace (${live} here${stale > 0 ? `, ${stale} stale` : ''})`]
    : [`the peer registry lists ${stale} stale entr${stale === 1 ? 'y' : 'ies'} for this workspace`];
  return {
    title,
    middle: blocking ? ['a read-only session can browse the transcript and run /diff, but writes nothing.'] : ['a stale entry is left by a killed instance and never blocks.'],
    keys: blocking ? PEER_LEASE_KEYS : PEER_STALE_KEYS,
    inline: false,
  };
}

/** TUI-DESIGN-4 §7.10 item 3: `peerLeaseRows` fitted to the overlay slot, exactly like `blockingLines`. */
export function peerLeaseLines(view: PeerView, rows: number, columns: number): string[] {
  const budget = Math.min(BLOCKING_MAX_ROWS, Number.isFinite(rows) ? Math.floor(rows) : 0);
  const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  if (budget <= 0) return [];
  const s = peerLeaseRows(view);
  return fitRows([s.title.join(' · '), ...s.middle, s.keys], budget).map((r) => truncateCells(r, cols));
}

/**
 * TUI-DESIGN-4 §7.10 item 2 / §12: the `[ui]` item at session open —
 * `another jevcode is working in this workspace (started 4m ago) — /peers lists them`. Null when this is the only
 * instance. `/peers` is a real command this round (§7.10 item 2), so the pointer is never dead.
 */
export function peerOpenNotice(view: PeerView | null): string | null {
  if (view === null || !Number.isFinite(view.live) || view.live <= 1) return null;
  const ago = view.oldestStartedMsAgo;
  const when = ago === null || !Number.isFinite(ago) || ago < 0 ? '' : ` (started ${peerAgoText(ago)} ago)`;
  return `another jevcode is working in this workspace${when} — /peers lists them`;
}

/** TUI-DESIGN-4 §12's `started 4m ago`: the compact form (`<n>s` · `<n>m` · `<n>h`), never a date. */
export function peerAgoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

// ---------------------------------------------------------------------------------------
// The lease-conflict and land-pre-flight panes (TUI-DESIGN-5 §2.11, §12 S39–S39c; D-AF)
// ---------------------------------------------------------------------------------------

/**
 * TUI-DESIGN-5 §12 S39 / S3: the coarse age words the coordination rows use — `41 s` · `3 m` · `2 h`, **with** the
 * space, which is how §12 writes every one of them (`last beat 4 m ago`, `(mbp, step 12, 3 m)`). Deliberately not
 * `peerAgoText` (`4m`, round 4's compact form) and not `formatRetryIn` (`3 min`): three forms, three §12 strings.
 */
export function beatAgoText(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m} m`;
  return `${Math.floor(m / 60)} h`;
}

/** TUI-DESIGN-5 §12 S39a / §7 row 96: the armed wait's elapsed counter — `41s` · `2m14s` · `1h02m`, compact because it ticks. */
export function waitElapsedText(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * TUI-DESIGN-5 §2.11 / §7 rows 95–97: what the lease-conflict pane renders. `holderLiveness` is
 * `Liveness` (`src/coordination/types.ts:403`) — all five members, because a `'stale-reused-pid'` holder is a
 * different card from a `'stale'` one is a different card from `'gone'`, and narrowing loses a real state.
 */
export interface LeaseConflictState {
  /** the toplevel-relative path the holder leases (never an absolute path, §2.9's rule) */
  readonly path: string;
  /** the holder's device label */
  readonly holder: string;
  /** the holder's step, or null when the beat did not carry one */
  readonly step: number | null;
  /** how long the lease has been held, ms; null = unknown */
  readonly heldMs: number | null;
  /** the holder's liveness right now — the card and `[w]`'s meaning change with it (§7 row 95) */
  readonly holderLiveness: 'live' | 'stale' | 'stale-reused-pid' | 'gone' | 'unknown';
  /** how long `[w]` has been armed, ms; null = it is not (§7 row 96) */
  readonly waitingMs?: number | null;
  /** the holder's last beat, ms ago — the stale card's number (§12 S39a) */
  readonly beatAgeMs?: number | null;
}

/** TUI-DESIGN-5 §12 S39, rung 1: the live-holder keys, four rungs through `fitRung` (TD4 §2.6). */
export const LEASE_CONFLICT_KEY_RUNGS: readonly string[] = [
  '[w] wait for it   [r] read-only session   [t] relocate to a worktree   [q] quit',
  '[w] wait   [r] read-only   [t] worktree   [q] quit',
  'w wait · r read-only · t worktree · q quit',
  'w · r · t · q',
];
/** TUI-DESIGN-5 §12 S39a: the stale-holder keys — `[w]` means **take it** on this card, and the card says so. */
export const LEASE_STALE_KEY_RUNGS: readonly string[] = [
  '[w] take it  [r] read-only  [q] quit',
  'w take · r read-only · q quit',
  'w · r · q',
];
/** TUI-DESIGN-5 §12 S39c: the land pre-flight keys (`Engine.land(input, ask?)`'s `[c]/[s]/[x]`; `ask` absent ⇒ `[x]`, CD §F). */
export const LAND_PREFLIGHT_KEY_RUNGS: readonly string[] = [
  '[c] commit them  [s] stash them  [x] cancel the land',
  '[c] commit  [s] stash  [x] cancel',
  'c commit · s stash · x cancel',
  'c · s · x',
];

/** TUI-DESIGN-5 §12 S39a / §7 row 96: `[w] waiting 2m14s — Esc gives up` — the armed clause, a named anchor so §13.4's pin test can grep it. */
export function waitArmedKey(waitingMs: number, g: GlyphSet = GLYPHS.unicode): string {
  return `[w] waiting ${waitElapsedText(waitingMs)} ${g.dash} Esc gives up`;
}

/**
 * TUI-DESIGN-5 §7 row 97 / §12 S39b: a lease whose holder is `gone` is **not a conflict** — the pane never opens.
 * `false` here is the whole of §1.4 promise 3 for this surface: never block on a dead peer.
 */
export function leaseConflictOpens(holderLiveness: LeaseConflictState['holderLiveness']): boolean {
  return holderLiveness !== 'gone';
}

/** TUI-DESIGN-5 §12 S39b: the one `[ui]` line a `gone` holder's lease produces instead of a pane. */
export function leaseGoneNotice(holder: string, atHHMM: string): string {
  return `took a lease left by a session that is gone (${terminalSafeLine(holder)}, ${terminalSafeLine(atHHMM)})`;
}

/**
 * TUI-DESIGN-5 §2.11 / §12 S39, S39a: the lease-conflict card, at the widest keys rung that fits `columns`.
 *
 * Three cards, one builder (§7 rows 95–97): a **live** holder gets S39 and `[w] wait for it`; a holder that turned
 * `stale` / `stale-reused-pid` while `[w]` was armed gets S39a and `[w] take it` — it never silently proceeds; a
 * `gone` holder never reaches here (`leaseConflictOpens` is false and §12 S39b's `[ui]` line records it), and if a
 * caller renders one anyway it is shown as stale rather than waited on.
 */
export function leaseConflictRows(st: LeaseConflictState, columns = Number.POSITIVE_INFINITY, g: GlyphSet = GLYPHS.unicode): BlockingRows {
  const holder = terminalSafeLine(st.holder);
  const beating = st.holderLiveness === 'live' || st.holderLiveness === 'unknown';
  const rungs = beating ? LEASE_CONFLICT_KEY_RUNGS : LEASE_STALE_KEY_RUNGS;
  let keys = fitRung(rungs, columns);
  if (beating && st.waitingMs !== undefined && st.waitingMs !== null) {
    // §7 row 96: an armed `[w]` shows its elapsed counter and its escape, so the wait is never one that cannot be woken
    keys = fitRung([`${waitArmedKey(st.waitingMs, g)}   ${LEASE_CONFLICT_KEY_RUNGS[1] ?? ''}`, waitArmedKey(st.waitingMs, g), ...rungs], columns);
  }
  if (!beating) {
    // §12 S39a / §7 row 95 / §2.13's 80-column cell: ONE row, joined by an em dash —
    // `the holder stopped beating 2 m ago — [w] take it  [r] read-only  [q] quit` (72 cells, so it fits at 80).
    // `blockingLines` splits it at narrower widths exactly as it splits every other `inline` kind.
    const age = beatAgoText(st.beatAgeMs ?? st.heldMs ?? 0);
    return { title: [`the holder stopped beating ${age} ago`], middle: [], keys, inline: true, joiner: ` ${g.dash} ` };
  }
  const facts = [holder, st.step === null ? null : `step ${Math.max(0, Math.floor(st.step))}`, st.heldMs === null ? null : beatAgoText(st.heldMs)].filter((x): x is string => x !== null);
  return { title: [`another session holds ${terminalSafeLine(st.path)} (${facts.join(', ')})`], middle: [], keys, inline: false };
}

/**
 * TUI-DESIGN-5 §2.11 / §12 S39c: the land pre-flight card. One row —
 * `7 uncommitted files, 2 inside an agent's slice — [c] commit them  [s] stash them  [x] cancel the land` — so it
 * is `inline` with the ` — ` joiner §12 writes, not the ` · ` every other inline kind uses.
 */
export function landPreflightRows(dirty: number, inSlice: number, columns = Number.POSITIVE_INFINITY, g: GlyphSet = GLYPHS.unicode): BlockingRows {
  const files = Math.max(0, Math.floor(Number.isFinite(dirty) ? dirty : 0));
  const inside = Math.max(0, Math.floor(Number.isFinite(inSlice) ? inSlice : 0));
  return {
    title: [`${files} uncommitted file${files === 1 ? '' : 's'}, ${inside} inside an agent's slice`],
    middle: [],
    keys: fitRung(LAND_PREFLIGHT_KEY_RUNGS, columns),
    inline: true,
    joiner: ` ${g.dash} `,
  };
}

/**
 * TUI-DESIGN-5 §2.11: `<path>|<holder>|<step>|<heldMs>|<liveness>` — how the engine encodes the lease-conflict
 * facts into `BlockingRequest.detail`, kept beside its parser exactly like the other kinds' `*Detail` pairs.
 */
export function leaseConflictDetail(st: Pick<LeaseConflictState, 'path' | 'holder' | 'step' | 'heldMs' | 'holderLiveness'>): string {
  return [st.path, st.holder, st.step ?? '', st.heldMs ?? '', st.holderLiveness].join('|');
}

const LIVENESS_WORDS: readonly LeaseConflictState['holderLiveness'][] = ['live', 'stale', 'stale-reused-pid', 'gone', 'unknown'];

/** TUI-DESIGN-5 §2.11: inverse of `leaseConflictDetail`; a detail in any other shape reads as the path alone with an unknown holder, so the card never shows an empty name. */
export function parseLeaseConflictDetail(detail: string): LeaseConflictState {
  const parts = terminalSafeLine(detail).split('|');
  const num = (v: string | undefined): number | null => {
    if (v === undefined || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const word = parts[4];
  const liveness = word !== undefined && (LIVENESS_WORDS as readonly string[]).includes(word) ? (word as LeaseConflictState['holderLiveness']) : 'unknown';
  return {
    path: parts[0] ?? '',
    holder: parts[1] !== undefined && parts[1] !== '' ? parts[1] : 'another session',
    step: num(parts[2]),
    heldMs: num(parts[3]),
    holderLiveness: parts.length >= 5 ? liveness : 'live',
  };
}

/** TUI-DESIGN-5 §2.11: `<dirty>|<inSlice>` — the land pre-flight's detail encoding. */
export function landPreflightDetail(dirty: number, inSlice: number): string {
  return `${Math.max(0, Math.floor(dirty))}|${Math.max(0, Math.floor(inSlice))}`;
}

/** TUI-DESIGN-5 §2.11: inverse of `landPreflightDetail`; an unparseable detail reads as `0|0` rather than `NaN`. */
export function parseLandPreflightDetail(detail: string): { dirty: number; inSlice: number } {
  const [a, b] = terminalSafeLine(detail).split('|');
  const n = (v: string | undefined): number => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0;
  };
  return { dirty: n(a), inSlice: n(b) };
}

/**
 * TUI-DESIGN §24 blocking panes as structure: title, middle rows, keys, per kind. Pure.
 *
 * **`columns` and `g` are threaded, not defaulted away (the fix pass).** The two round-5 kinds pick their keys row
 * with `fitRung`, and a `blockingRowsStructured(req)` that always answered rung 0 made all four rungs dead on the
 * only path the Ink overlay and `--plain` use: `blockingLines` then hard-truncated the row, so at 40–60 columns the
 * lease-conflict pane lost `[t]` and `[q]` — a modal with no visible way out (§2.13 pins all four keys at 40).
 * `g` is threaded for the same reason: `land-preflight`'s ` — ` joiner and the stale card's are the first non-ASCII
 * characters on this path and had no `--ascii` twin through it. Both default to the round-1 behaviour (no width
 * limit, unicode), so every landed caller is byte-identical.
 */
export function blockingRowsStructured(req: BlockingRequest, columns: number = Number.POSITIVE_INFINITY, g: GlyphSet = GLYPHS.unicode): BlockingRows {
  const exit = `(exit ${req.exitCode})`;
  switch (req.kind) {
    case 'key-rejected': {
      const side = sideWord(req);
      const which = side === 'jev' ? 'decider' : 'generator';
      const sources = (req.sources ?? []).map((s) => terminalSafeLine(s)).join(', ');
      return {
        title: [`${side}: key rejected (${terminalSafeLine(req.detail)})`],
        middle: [`Set the ${which} key and retry. Consulted: ${sources.length > 0 ? sources : 'none'}`, 'The key is never printed or logged.'],
        keys: `[r] retry with the current key   [l] /login   [q] stop ${exit}`,
        inline: false,
      };
    }
    case 'spend-limit':
      return {
        title: [`provider: spend limit reached — "${clipCodePoints(terminalSafeLine(req.detail), BLOCKING_MESSAGE_MAX)}"`, 'this keeps failing until access resumes'],
        middle: [],
        keys: `[q] stop ${exit}`,
        inline: true,
      };
    case 'jev-unreachable': {
      const last = terminalSafeLine(req.detail);
      return {
        title: [`jev unreachable after ${JEV_ATTEMPTS} attempts`, `retrying in ${formatRetryIn(req.retryInMs ?? 30_000)} (auto, doubles to 5 min)`],
        middle: last.length > 0 ? [`last: ${clipCodePoints(last, BLOCKING_MESSAGE_MAX)}`] : [],
        keys: '[r] now  [q] stop',
        inline: true,
      };
    }
    case 'checkpoint-degraded': {
      const { code, file } = parseCheckpointDegradedDetail(req.detail);
      /**
       * TUI-DESIGN-4 §7.4 item 6: the same explanation `explainFsError` gives the epilogue must be reachable from
       * the blocking pane, so §7.2's degraded pane names the fix instead of an errno. The second middle row is
       * the fix; it is dropped first by `fitRows` when the slot is short, and the reason row survives.
       */
      const fix = fsFixFor(code);
      return {
        title: [`checkpoint degraded: ${checkpointDegradedDetail(code, file)}`],
        middle: [`${file} could not be written since step ${req.step} — ${consequenceFor(code)}.`, ...(fix === null ? [] : [fix])],
        keys: `[r] retry the write   [c] continue without checkpoints   [q] stop now ${exit}`,
        inline: false,
      };
    }
    case 'drift': {
      const { configured, served } = parseDriftDetail(terminalSafeLine(req.detail));
      return {
        title: [`jev: model alias ${configured} resolved to ${served} on the first call`],
        middle: [],
        keys: `[p] pin --jev-model ${served} for the next run   [q] stop ${exit}`,
        inline: false,
      };
    }
    case 'sandbox-unavailable':
      return { title: ['sandbox: seatbelt requested but sandbox-exec is unavailable'], middle: [], keys: `[q] stop ${exit}`, inline: false };
    // TUI-DESIGN-5 §2.11 / §12 S39, S39c (D-AF): contract 1.4/1.5's two placeholder rows, restyled on the real
    // members. Neither keys row carries `(exit <n>)`: §12 writes them verbatim without it, and `[q]`/`[x]` here are
    // a CHOICE between resumable outcomes (`wait` · `worktree` · `stop`), not the "this run is over" marker the
    // other kinds append.
    case 'land-preflight': {
      const { dirty, inSlice } = parseLandPreflightDetail(req.detail);
      return landPreflightRows(dirty, inSlice, columns, g);
    }
    case 'lease-conflict':
      return leaseConflictRows(parseLeaseConflictDetail(req.detail), columns, g);
  }
}

/**
 * TUI-DESIGN §24 blocking panes: every row at full height and width — the §24 text verbatim, first = reason, keys
 * last or inline. `g` folds the glyphs an `--ascii` `--plain` session must not print (`src/cli/session.ts`'s
 * `createPlainPrompter` passes `glyphSet({ ascii: o.ascii })`).
 */
export function blockingRowsFull(req: BlockingRequest, g: GlyphSet = GLYPHS.unicode): string[] {
  const s = blockingRowsStructured(req, Number.POSITIVE_INFINITY, g);
  return s.inline ? [[...s.title, s.keys].join(joinerOf(s)), ...s.middle] : [s.title.join(INLINE_JOINER), ...s.middle, s.keys];
}

/** Middle rows are dropped last-first so the title and the keys survive; at one row title and keys share it. */
function fitRows(rows: string[], budget: number): string[] {
  if (budget <= 0 || rows.length === 0) return [];
  if (rows.length <= budget) return rows;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  if (budget === 1) return [rows.length === 1 ? first : `${first}  ${last}`];
  const middle = rows.slice(1, -1).slice(0, budget - 2);
  return [first, ...middle, last];
}

/** Greedy packing of ` · ` segments into rows of at most `columns` cells; a segment wider than the row stands alone (clipped later). */
function packSegments(segments: readonly string[], columns: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const seg of segments) {
    const next = cur.length === 0 ? seg : `${cur} · ${seg}`;
    if (cur.length > 0 && stringWidth(next) > columns) {
      out.push(cur);
      cur = seg;
    } else {
      cur = next;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * TUI-DESIGN §13.3 / §24: the overlay rows for a blocking pause, at most `min(rows, 4)`, each cut to `columns`
 * cells. Row 1 is the reason and the last row the keys whenever two or more rows are available: a §24 single-row
 * kind wider than the columns is split at its ` · ` separators with the keys on their own row (or joined to the
 * last title row when nothing else is shown and it fits), and the informative middle rows are dropped first when
 * the slot is short. Pure; the same rows feed the Ink overlay, `--plain` and the screen reader.
 */
export function blockingLines(req: BlockingRequest, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  const budget = Math.min(BLOCKING_MAX_ROWS, Number.isFinite(rows) ? Math.floor(rows) : 0);
  const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  if (budget <= 0) return [];
  // the width reaches the kind, so a rung ladder picks its rung here rather than being truncated below
  const s = blockingRowsStructured(req, cols, g);
  const joiner = joinerOf(s);
  let out: string[];
  if (!s.inline) {
    out = [s.title.join(INLINE_JOINER), ...s.middle, s.keys];
  } else {
    const one = [...s.title, s.keys].join(joiner);
    if (budget === 1 || stringWidth(one) <= cols) {
      out = [one, ...s.middle];
    } else {
      const head = packSegments(s.title, cols);
      const lastHead = head[head.length - 1] ?? '';
      const joined = `${lastHead}${joiner}${s.keys}`;
      if (s.middle.length === 0 && head.length > 0 && stringWidth(joined) <= cols) out = [...head.slice(0, -1), joined];
      else out = [...head, ...s.middle, s.keys];
    }
  }
  return fitRows(out, budget).map((r) => truncateCells(r, cols));
}

/** The status left-zone word while a blocking pause is up (`paused: <reason>`, TUI-DESIGN §13.1, §24). */
export function blockingStatusWord(kind: BlockingKind): string {
  switch (kind) {
    case 'jev-unreachable':
      return 'paused: jev unreachable';
    case 'key-rejected':
      return 'paused: key rejected';
    case 'checkpoint-degraded':
      return 'paused: checkpoint degraded';
    case 'spend-limit':
      return 'paused: spend limit';
    case 'drift':
      return 'paused: model drift';
    case 'sandbox-unavailable':
      return 'paused: sandbox unavailable';
    case 'land-preflight':
      return 'paused: land pre-flight';
    case 'lease-conflict':
      return 'paused: lease conflict';
  }
}

/** Screen-reader twin: reason and middle rows as a numbered list, the keys row last unnumbered (TUI-DESIGN §14.2 "reviews, wizard and pickers as numbered lists"). */
export function blockingLinesScreenReader(req: BlockingRequest, g: GlyphSet = GLYPHS.unicode): string[] {
  const s = blockingRowsStructured(req, Number.POSITIVE_INFINITY, g);
  const numbered = [s.title.join(INLINE_JOINER), ...s.middle].map((r, i) => `${i + 1} ${r}`);
  return [...numbered, s.keys];
}

// ---------------------------------------------------------------------------------------
// Severity → surface (TUI-DESIGN §13.1, 17 §4.1)
// ---------------------------------------------------------------------------------------

export type Severity = 'info' | 'notice' | 'warning' | 'error' | 'blocking' | 'fatal';

export interface SeveritySurface {
  /** what the status left zone shows */
  statusZone: 'none' | 'progress-word' | 'error-badge' | 'paused' | 'done-error';
  /** toast duration in ms; 0 = no toast */
  toastMs: 0 | 2000 | 4000;
  /** the `<Static>` item, if any */
  staticItem: 'none' | 'dim' | 'only-when-failed-or-slow' | 'warning' | 'error' | 'red-then-dim' | 'run-end';
  liveRegion: 'none' | 'retry-row' | 'cleared';
  overlay: 'none' | 'blocking';
  log: 'info' | 'info-or-warn' | 'warn' | 'error' | 'error-and-epilogue';
}

/** TUI-DESIGN §13.1 as data: one row per severity. */
export const SEVERITY_SURFACES: Readonly<Record<Severity, SeveritySurface>> = {
  info: { statusZone: 'none', toastMs: 0, staticItem: 'dim', liveRegion: 'none', overlay: 'none', log: 'info' },
  notice: { statusZone: 'progress-word', toastMs: 2000, staticItem: 'only-when-failed-or-slow', liveRegion: 'retry-row', overlay: 'none', log: 'info-or-warn' },
  warning: { statusZone: 'error-badge', toastMs: 2000, staticItem: 'warning', liveRegion: 'none', overlay: 'none', log: 'warn' },
  error: { statusZone: 'error-badge', toastMs: 4000, staticItem: 'error', liveRegion: 'none', overlay: 'none', log: 'error' },
  blocking: { statusZone: 'paused', toastMs: 0, staticItem: 'red-then-dim', liveRegion: 'none', overlay: 'blocking', log: 'error' },
  fatal: { statusZone: 'done-error', toastMs: 0, staticItem: 'run-end', liveRegion: 'cleared', overlay: 'none', log: 'error-and-epilogue' },
};

/** TUI-DESIGN §13.1: the surface set for a severity. */
export function surfaceFor(severity: Severity): SeveritySurface {
  return SEVERITY_SURFACES[severity];
}

/** A retry chain earns a `warning:` item only when it failed or lasted longer than this (TUI-DESIGN §13.1, §15.1). */
export const RETRY_SLOW_MS = 10_000;

/**
 * TUI-DESIGN §13.1: classify an engine event into a severity; null for events that carry no error surface
 * (pane-only progress, ordinary transcript lines). `notice checkpoint:degraded` is `error` (§15 item 20 counts it
 * in `errors`; the `disk ×N` word and the blocking pause follow), not the self-healing `notice` row. Pure.
 */
export function severityOfEvent(e: EngineEvent): Severity | null {
  switch (e.type) {
    case 'error':
      return e.fatal ? 'fatal' : 'error';
    case 'blocking:request':
      return 'blocking';
    case 'retry':
      return 'notice';
    case 'retry:settled':
      return !e.ok || e.totalWaitMs > RETRY_SLOW_MS ? 'warning' : 'notice';
    case 'notice':
      if (e.kind === 'offline' || e.kind === 'online') return 'notice';
      if (e.kind === 'checkpoint:degraded') return 'error';
      return e.level === 'error' ? 'error' : e.level === 'warn' ? 'warning' : 'info';
    case 'transcript':
      return e.level === 'error' ? 'error' : e.level === 'warn' ? 'warning' : 'info';
    case 'run:end':
      return e.result.stopReason === 'error' ? 'fatal' : null;
    default:
      return null;
  }
}

/** The toast text for a severity and short message (`! <short>` / `! <code>: <short>`; TUI-DESIGN §13.1). */
export function severityToast(severity: Severity, short: string, code?: string): string | null {
  const s = clipCodePoints(terminalSafeLine(short), 60);
  if (severity === 'warning') return `! ${s}`;
  if (severity === 'error') return `! ${code ? `${code}: ` : ''}${s}`;
  return null;
}
