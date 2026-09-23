/**
 * Session picker rows (TUI-DESIGN §8.4, A56, 10 §15.6; pure). The picker renders in the pane slot with the composer as
 * its filter: header `─── sessions · <ws> (Ctrl-A all) · by updated ─ ↑↓ Enter Space Ctrl-R x Esc ────`, one row per
 * session `time ago │ steps │ stop │ $cost │ title-or-task60 │ (workspace when widened) │ ● live`. Shared by the Ink,
 * `--plain` (`--list-sessions`) and screen-reader twins; `--ascii` substitutes per §14.1. No clock inside: `nowMs` is passed.
 */
import type { SessionRow, StopReason } from '../core/types.js';
import { formatDuration } from '../core/time.js';
import { stringWidth } from '../tui/composer/width.js';

export type PickerSort = 'updated' | 'created';

/**
 * TUI-DESIGN §4.2 (A2): the picker measures with the composer's `stringWidth` — the same string-width@8.2.2 rules Ink
 * lays out with — so a row clipped to `columns` never wraps. `approxCellWidth` below is the table-free fallback.
 */
export const pickerCellWidth: (s: string) => number = stringWidth;

let graphemeSegmenter: Intl.Segmenter | null = null;
/** Grapheme clusters of `s` (a ZWJ family, a flag pair or a keycap is one unit, never split by a clip). */
function graphemes(s: string): string[] {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const out: string[] = [];
  for (const { segment } of graphemeSegmenter.segment(s)) out.push(segment);
  return out;
}

export interface PickerOptions {
  /** the current workspace realpath; rows are filtered to it unless `widened` */
  workspace: string;
  /** Ctrl-A: every workspace, with the workspace column */
  widened: boolean;
  nowMs: number;
  columns: number;
  sort?: PickerSort;
  /** the composer text: case-folded subsequence over title, task60 and ids */
  filter?: string;
  /** `● live` when a live `run.lock` exists for the row's newest run (§8.5); the index's own `live` flag is ANDed with it */
  live?: (runId: string) => boolean;
  /** TUI-DESIGN §14.1 glyph substitution */
  ascii?: boolean;
  /** cell-width function; `pickerCellWidth` (O2's `stringWidth`) by default */
  cellWidth?: (s: string) => number;
}

/** Wide code points outside the contiguous blocks below (East Asian Width W in U+2300–U+2BFF: clocks, weather, chess, dice …). */
const WIDE_SINGLES: ReadonlySet<number> = new Set<number>([
  0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4,
  0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797,
  0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55, 0x1f004, 0x1f0cf, 0x1f18e, 0x1f201, 0x1f21a, 0x1f22f,
]);

/** Contiguous wide ranges (inclusive): CJK, Hangul, fullwidth forms, the emoji blocks (misc symbols & pictographs, transport & map, supplemental, extended-A). */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2648, 0x2653],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f191, 0x1f19a],
  [0x1f1e6, 0x1f1ff],
  [0x1f232, 0x1f23a],
  [0x1f250, 0x1f251],
  [0x1f300, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

/** Zero-width code points: combining marks, ZWJ/ZWNJ/ZWSP, variation selectors, tag characters, emoji skin-tone modifiers ride on their base. */
function isZeroWidth(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp < 0xa0) ||
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0020 && cp <= 0xe007f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff)
  );
}

function isWideCodePoint(cp: number): boolean {
  if (WIDE_SINGLES.has(cp)) return true;
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

/**
 * Table-free width heuristic (East Asian Wide/Fullwidth blocks and the emoji blocks → 2, marks / ZWJ / VS / skin tones →
 * 0, a ZWJ-joined sequence of pictographs → 2 as one cluster). The default is `pickerCellWidth`; this stays exported for
 * callers without O2's table and never under-measures a row the table would.
 */
export function approxCellWidth(s: string): number {
  let w = 0;
  for (const cluster of graphemes(s)) {
    let cw = 0;
    let joined = false;
    let regional = 0;
    for (const ch of cluster) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0x200d) joined = true;
      if (cp >= 0x1f1e6 && cp <= 0x1f1ff) regional++;
      if (isZeroWidth(cp)) continue;
      cw += isWideCodePoint(cp) ? 2 : 1;
    }
    // a ZWJ sequence or a regional-indicator pair (a flag) is one 2-cell glyph
    w += (joined && cw > 2) || regional === 2 ? 2 : cw;
  }
  return w;
}

/** Clip to `cells` columns, ending in `…` (or `~` under ASCII) when anything was dropped; never splits a grapheme cluster. */
export function truncateToCells(s: string, cells: number, width: (s: string) => number = pickerCellWidth, ascii = false): string {
  if (!Number.isFinite(cells) || cells <= 0) return '';
  if (width(s) <= cells) return s;
  const mark = ascii ? '~' : '…';
  const room = cells - 1;
  let out = '';
  let used = 0;
  for (const g of graphemes(s)) {
    const w = width(g);
    if (used + w > room) break;
    out += g;
    used += w;
  }
  return out + mark;
}

/** Keep the tail of `s` within `cells` columns, starting with `…` (or `~`) when anything was dropped — for paths, whose end matters. */
export function truncateLeftToCells(s: string, cells: number, width: (s: string) => number = pickerCellWidth, ascii = false): string {
  if (!Number.isFinite(cells) || cells <= 0) return '';
  if (width(s) <= cells) return s;
  const mark = ascii ? '~' : '…';
  const room = cells - 1;
  const gs = graphemes(s);
  let out = '';
  let used = 0;
  for (let i = gs.length - 1; i >= 0; i--) {
    const g = gs[i]!;
    const w = width(g);
    if (used + w > room) break;
    out = g + out;
    used += w;
  }
  return mark + out;
}

const AGO_UNITS: readonly { ms: number; unit: string }[] = [
  { ms: 365 * 86_400_000, unit: 'y' },
  { ms: 30 * 86_400_000, unit: 'mo' },
  { ms: 7 * 86_400_000, unit: 'w' },
  { ms: 86_400_000, unit: 'd' },
  { ms: 3_600_000, unit: 'h' },
  { ms: 60_000, unit: 'm' },
];

/** `just now` · `3m ago` · `2h ago` · `5d ago` · `3w ago` · `4mo ago` · `1y ago`; `?` for an unparsable time; a future time is `just now`. */
export function timeAgo(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return '?';
  const delta = nowMs - t;
  if (delta < 60_000) return 'just now';
  for (const u of AGO_UNITS) {
    if (delta >= u.ms) return `${Math.floor(delta / u.ms)}${u.unit} ago`;
  }
  return 'just now';
}

/** Case-folded subsequence match (the §5.4 scorer's acceptance rule; ranking is the scorer's job, O3). */
export function isSubsequence(query: string, candidate: string): boolean {
  const q = [...query.toLowerCase()];
  const c = candidate.toLowerCase();
  let i = 0;
  for (const ch of c) {
    if (i < q.length && ch === q[i]) i++;
  }
  return i === q.length;
}

/** TUI-DESIGN §8.4: typing filters by title, task and id (session or any run id). */
export function filterSessions(sessions: readonly SessionRow[], filter: string | undefined): SessionRow[] {
  const q = (filter ?? '').trim();
  if (q === '') return [...sessions];
  return sessions.filter((s) => isSubsequence(q, s.title) || isSubsequence(q, s.task60) || isSubsequence(q, s.sessionId) || s.runs.some((r) => isSubsequence(q, r.runId)));
}

/** TUI-DESIGN §8.4: sort updated (default, `lastUsed` desc) or created (`createdAt` desc); stable on ties. */
export function sortSessions(sessions: readonly SessionRow[], sort: PickerSort = 'updated'): SessionRow[] {
  const key = sort === 'created' ? (s: SessionRow) => s.createdAt : (s: SessionRow) => s.lastUsed;
  return sessions.map((s, i) => ({ s, i })).sort((a, b) => (key(a.s) < key(b.s) ? 1 : key(a.s) > key(b.s) ? -1 : a.i - b.i)).map((x) => x.s);
}

/** The newest run of a session by start time (the row's steps / stop / live come from it). */
export function newestRun(s: SessionRow): SessionRow['runs'][number] | null {
  let best: SessionRow['runs'][number] | null = null;
  for (const r of s.runs) if (best === null || r.startedAt >= best.startedAt) best = r;
  return best;
}

/** TUI-DESIGN §8.4 stop column: the verdict word; `live` while a run is open; `—` before any run. */
export function stopWord(stop: StopReason | null, live: boolean): string {
  if (live) return 'live';
  return stop ?? '—';
}

function glyphs(ascii: boolean): { bar: string; live: string; rule: string; arrows: string; dot: string } {
  return ascii ? { bar: '|', live: '*', rule: '-', arrows: '^v', dot: '-' } : { bar: '│', live: '●', rule: '─', arrows: '↑↓', dot: '·' };
}

/** The shortest rule tail the header keeps to its right. */
const HEADER_MIN_TAIL = 4;

/**
 * TUI-DESIGN §24 rule row: `─── sessions · <ws> (Ctrl-A all) · by updated ─ ↑↓ Enter Space Ctrl-R x Esc ────`, padded to
 * `columns`. A long workspace path is squeezed first, from the left (`…/me/proj`, down to a lone `…`), so the key hints
 * survive whenever the fixed text fits (73 cells + the 4-cell tail); only below that is the row clipped from the right.
 */
export function pickerHeader(o: { workspace: string; widened: boolean; sort?: PickerSort; columns: number; ascii?: boolean; cellWidth?: (s: string) => number }): string {
  const g = glyphs(o.ascii === true);
  const ascii = o.ascii === true;
  const width = o.cellWidth ?? pickerCellWidth;
  const ws = o.widened ? 'all' : o.workspace;
  const build = (w: string): string => `${g.rule.repeat(3)} sessions ${g.dot} ${w} (Ctrl-A all) ${g.dot} by ${o.sort ?? 'updated'} ${g.rule} ${g.arrows} Enter Space Ctrl-R x Esc `;
  const columns = Math.max(0, Math.floor(Number.isFinite(o.columns) ? o.columns : 0));
  if (columns === 0) return build(ws) + g.rule.repeat(HEADER_MIN_TAIL);
  let text = build(ws);
  if (width(text) + HEADER_MIN_TAIL > columns) {
    const room = columns - HEADER_MIN_TAIL - width(build(''));
    if (room >= 1) text = build(truncateLeftToCells(ws, room, width, ascii));
  }
  const clipped = truncateToCells(text, columns, width, ascii);
  return clipped + g.rule.repeat(Math.max(0, columns - width(clipped)));
}

/** The sessions the picker shows: filtered to the workspace unless widened, then by the composer filter, then sorted. */
export function pickerSessions(sessions: readonly SessionRow[], o: Pick<PickerOptions, 'workspace' | 'widened' | 'filter' | 'sort'>): SessionRow[] {
  const scoped = o.widened ? [...sessions] : sessions.filter((s) => s.workspace === o.workspace);
  return sortSessions(filterSessions(scoped, o.filter), o.sort);
}

/**
 * TUI-DESIGN §8.4 `pickerRows`: one row per session, `time ago │ steps │ stop │ $cost │ title-or-task60 │ (workspace when
 * widened) │ ● live`, each clipped to `columns` cells. Empty input → `[]` (the caller renders `no session in <path> yet`).
 */
export function pickerRows(sessions: readonly SessionRow[], o: PickerOptions): string[] {
  const g = glyphs(o.ascii === true);
  const width = o.cellWidth ?? pickerCellWidth;
  const columns = Math.max(0, Math.floor(Number.isFinite(o.columns) ? o.columns : 0));
  const rows: string[] = [];
  for (const s of pickerSessions(sessions, o)) {
    const run = newestRun(s);
    const live = run !== null && run.live && (o.live ? o.live(run.runId) : true);
    const ago = timeAgo(s.lastUsed, o.nowMs).padEnd(8);
    const steps = String(run?.steps ?? (live ? '…' : '–')).padStart(3);
    const stop = stopWord(run?.stopReason ?? null, live).padEnd(12);
    const cost = (Number.isFinite(s.totalUsd) ? `$${s.totalUsd.toFixed(3)}` : '$?').padStart(8);
    const title = s.title !== '' ? s.title : s.task60 !== '' ? s.task60 : s.sessionId;
    const parts = [ago, steps, stop, cost, title];
    if (o.widened) parts.push(s.workspace);
    if (live) parts.push(`${g.live} live`);
    const row = parts.join(` ${g.bar} `);
    rows.push(columns > 0 ? truncateToCells(row, columns, width, o.ascii === true) : row);
  }
  return rows;
}

/**
 * TUI-DESIGN §8.4 `--resume <id|title>`: a run id, then an exact title, then a unique case-insensitive title prefix.
 * `{ kind: 'ambiguous' }` lists the candidates for the `--resume: "<x>" matches N sessions: <list>` ConfigError.
 */
export function resolveResumeTarget(
  sessions: readonly SessionRow[],
  value: string,
): { kind: 'run'; session: SessionRow; runId: string } | { kind: 'session'; session: SessionRow } | { kind: 'ambiguous'; candidates: SessionRow[] } | { kind: 'none' } {
  const v = value.trim();
  if (v === '') return { kind: 'none' };
  for (const s of sessions) for (const r of s.runs) if (r.runId === v) return { kind: 'run', session: s, runId: r.runId };
  const exact = sessions.filter((s) => s.title === v);
  if (exact.length === 1) return { kind: 'session', session: exact[0]! };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };
  const lower = v.toLowerCase();
  const prefixed = sessions.filter((s) => s.title.toLowerCase().startsWith(lower));
  if (prefixed.length === 1) return { kind: 'session', session: prefixed[0]! };
  if (prefixed.length > 1) return { kind: 'ambiguous', candidates: prefixed };
  return { kind: 'none' };
}

/** TUI-DESIGN §24: `--resume: "<x>" matches N sessions: <list>`. */
export function ambiguousResumeMessage(value: string, candidates: readonly SessionRow[]): string {
  return `--resume: "${value}" matches ${candidates.length} sessions: ${candidates.map((s) => `${s.sessionId} "${s.title}"`).join(', ')}`;
}

/**
 * TUI-DESIGN §24: `[ui] recent: "<title>" · <ago> — Enter continues, /resume browses` — the dim hint the LINE
 * renderers print after the first frame. The quiet start (2026-09) drops the parenthesis (one thought, one row) and
 * takes the item out of the TUI entirely: there the offer is the composer's own placeholder (`recentTaskPlaceholder`).
 */
export function recentSessionHint(s: SessionRow, nowMs: number, ascii = false): string {
  const dot = ascii ? '-' : '·';
  const dash = ascii ? '-' : '—';
  return `recent: "${s.title}" ${dot} ${timeAgo(s.lastUsed, nowMs)} ${dash} Enter continues, /resume browses`;
}

/** TUI-DESIGN §24: `no session in <path> yet`. */
export function noSessionMessage(workspace: string): string {
  return `no session in ${workspace} yet`;
}

// ── TUI-DESIGN-5 §2.8: the resume card (slot R5-1) ───────────────────────────────────────────────────────────────

/**
 * §2.8 / §10: the eight card branches. Exactly one is chosen per card; the branch decides the status row, the
 * explanatory note and whether `[r] replay the paused proposal` is offered at all.
 *
 *   `fresh`              — a plain pause with nothing cached to replay
 *   `replayable`         — `PausePoint.replayable === true` AND every `targetsSha` still matches
 *   `targets-moved`      — the proposal is cached but a target changed under it (S23; `[r]` withheld, reason named)
 *   `imported`           — the run's bodies stayed on the origin device (S24)
 *   `crashed`            — no clean pause point; the step restarts (S25)
 *   `live-elsewhere`     — a peer holds this run right now (S26; the key row becomes watch / tell / ask-to-pause)
 *   `taken-over`         — a QUALIFIED foreign claim outranks this one (S11; `--force-takeback` is the escape)
 *   `forked-unverified`  — an UNQUALIFIED foreign claim; annotates, never refuses (S12, §7 row 28)
 */
export type ResumeCardBranch = 'fresh' | 'replayable' | 'targets-moved' | 'imported' | 'crashed' | 'live-elsewhere' | 'taken-over' | 'forked-unverified';

export const RESUME_CARD_BRANCHES: readonly ResumeCardBranch[] = ['fresh', 'replayable', 'targets-moved', 'imported', 'crashed', 'live-elsewhere', 'taken-over', 'forked-unverified'];

/**
 * Everything the card renders, as plain data. §2.8 says "round 5 threads a `Fold` in"; what is threaded in is the
 * **view** (`SessionActivityView`, §2.3 / §14.2 #12 — one row model, not two), projected by `src/session/peers.ts`,
 * so this module keeps its zero coordination imports and stays a pure, table-testable builder.
 */
export interface ResumeCardInput {
  runId: string;
  title: string;
  branch: ResumeCardBranch;
  /** wall ms of the pause (or of the crash); `null` before any pause point was written */
  pausedAtMs: number | null;
  step: number | null;
  /** the pause point in its own words — `pause now during propose, 62 % streamed` */
  pauseDetail: string | null;
  steersPending: number;
  head: { from: string; to: string; commits: number; by: string; subjects: readonly string[] } | null;
  changedSince: readonly string[];
  /** the live peer on this repo, from `SessionActivityView` */
  livePeer: { label: string; step: number | null; editing: string | null } | null;
  spend: { usd: number; capUsd: number } | null;
  wallMs: number | null;
  maxWallMs: number | null;
  /**
   * §7 row 38: built from `CheckpointState.lastPromptChars` alone and **omitted, not zeroed**, when absent. A live
   * `ctx 0%` is informative; a resumed `ctx 0%` before any prompt was read is a lie.
   */
  ctxPct: number | null;
  /** `targets-moved` (S23) */
  targetsMoved: { path: string; by: string; head: string } | null;
  /** `imported` (S24) */
  importedFrom: string | null;
  /** `crashed` (S25) */
  crashed: { agoMs: number; step: number; stage: string; intoMs: number } | null;
  /** `taken-over` (S11) */
  takenOver: { label: string; at: string; epoch: number } | null;
  /** `forked-unverified` (S12) */
  forked: { label: string; epoch: number } | null;
}

export interface ResumeCardOptions {
  nowMs: number;
  columns: number;
  ascii?: boolean;
  cellWidth?: (s: string) => number;
}

/** §12.1 S11. */
export function takenOverLine(o: { label: string; at: string; epoch: number }): string {
  return `taken over by ${o.label} at ${o.at} (claim ${o.epoch}); /resume --force-takeback re-takes it`;
}

/** §12.1 S12 — the UNQUALIFIED claim: a card line, never a refusal (§7 row 28). */
export function unqualifiedClaimLine(o: { label: string; epoch: number }): string {
  return `${o.label} claims ${o.epoch} (unverified) — ignored; sessions pair to make it count`;
}

/** §12.1 S23. */
export function targetsMovedLine(o: { path: string; by: string; head: string }): string {
  return `targets changed since the proposal (${o.path} by ${o.by}@${o.head}) — replay unavailable`;
}

/** §12.1 S24. */
export function importedRunLine(label: string): string {
  return `the paused proposal and its samples stayed on ${label} — resuming starts a fresh step`;
}

/**
 * §12.1 S25, verbatim: `crashed 3 m ago during step 8 (propose, 41 s in) — step 8 restarts`.
 *
 * The elapsed cell is this module's own `shortAgo` (`41 s`, a space), **not** `core/time.ts`'s `formatDuration`
 * (`41s`, no space): §13.4 makes S25 a greppable anchor, and one character of drift is a zero-match grep, which
 * that section calls a hard failure (round-5 fix pass, finding 13).
 */
export function crashedLine(c: { agoMs: number; step: number; stage: string; intoMs: number }, ascii = false): string {
  const dash = ascii ? '--' : '—';
  return `crashed ${shortAgo(c.agoMs)} ago during step ${c.step} (${c.stage}, ${shortAgo(c.intoMs)} in) ${dash} step ${c.step} restarts`;
}

/** §12.1 S26 — the key row of a run that is live on another session. */
export function liveElsewhereRow(label: string, ascii = false): string {
  const dash = ascii ? '--' : '—';
  const dot = ascii ? '-' : '·';
  const glyph = ascii ? '*' : '●';
  return `${glyph} live on ${label} ${dash} [w] watch (read-only tail) ${dot} [t] tell ${dot} [p] ask to pause ${dot} [Esc]`;
}

/** `42 m` · `3 h` · `2 d` — the card's own age cell (`paused 42 m ago`). */
function shortAgo(ms: number): string {
  const v = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (v < 60_000) return `${Math.floor(v / 1000)} s`;
  if (v < 3_600_000) return `${Math.floor(v / 60_000)} m`;
  if (v < 86_400_000) return `${Math.floor(v / 3_600_000)} h`;
  return `${Math.floor(v / 86_400_000)} d`;
}

/** §2.8's `[Enter] … [Esc]` row, with three rungs so 40 columns keeps the two keys that matter. */
export function resumeCardKeys(input: ResumeCardInput, columns: number, ascii = false): string {
  const dot = ascii ? '-' : '·';
  if (input.branch === 'live-elsewhere') {
    if (columns >= 72) return liveElsewhereRow(input.livePeer?.label ?? '?', ascii);
    const glyph = ascii ? '*' : '●';
    return columns >= 44 ? `${glyph} live elsewhere ${dot} w watch ${dot} t tell ${dot} p ask to pause ${dot} Esc` : `${glyph} live ${dot} w watch ${dot} Esc`;
  }
  const replay = input.branch === 'replayable';
  const stepWord = input.step === null ? 'fresh' : `fresh step ${input.step}`;
  if (columns >= 96) {
    const parts = [`[Enter] resume (${stepWord})`];
    if (replay) parts.push('[r] replay the paused proposal');
    parts.push('[f] fresh', '[d] diff since pause', '[w] who', '[Esc]');
    return parts.join('   ');
  }
  if (columns >= 52) {
    const parts = ['Enter resume'];
    if (replay) parts.push('r replay');
    parts.push('f fresh', 'd diff', 'w who', 'Esc');
    return parts.join(` ${dot} `);
  }
  const parts = ['Enter resume'];
  if (replay) parts.push('r replay');
  parts.push('Esc');
  return parts.join(` ${dot} `);
}

/**
 * TUI-DESIGN-5 §2.8: the expanded resume card — a rule head, the pause/crash row, the HEAD-drift row, the
 * live-on-this-repo row, the branch's own explanation and the key row, each clipped to `columns`.
 *
 * Every row is a plain string at the caller's width, exactly as `pickerHeader` / `pickerRows` are, so the `--plain`
 * twin, the screen-reader twin and `transcript.log` print the row the TUI drew (§13). The card is a FOCUSED
 * SUB-STATE of the picker (`PickerState.card`, §2.8 / §7 row 91) — the last row says so, because the composer's
 * filter is inert while it is open.
 */
export function resumeCardRows(input: ResumeCardInput, o: ResumeCardOptions): string[] {
  const ascii = o.ascii === true;
  const g = glyphs(ascii);
  const width = o.cellWidth ?? pickerCellWidth;
  const columns = Math.max(0, Math.floor(Number.isFinite(o.columns) ? o.columns : 0));
  const dot = g.dot;
  const dash = ascii ? '--' : '—';
  const clip = (s: string): string => (columns > 0 ? truncateToCells(s, columns, width, ascii) : s);
  const rows: string[] = [];

  // 1 — the rule head
  const head = `${g.rule} resume ${input.runId} ${dot} "${input.title}" `;
  const headClipped = clip(head);
  rows.push(columns > 0 ? headClipped + g.rule.repeat(Math.max(0, columns - width(headClipped))) : head);

  // 2 — where it stopped
  if (input.branch === 'crashed' && input.crashed !== null) {
    rows.push(clip(crashedLine(input.crashed, ascii)));
  } else {
    const parts: string[] = [];
    parts.push(input.pausedAtMs === null ? 'paused' : `paused ${shortAgo(o.nowMs - input.pausedAtMs)} ago`);
    if (input.step !== null) parts.push(`now at step ${input.step}${input.pauseDetail === null ? '' : ` (${input.pauseDetail})`}`);
    if (input.steersPending > 0) parts.push(`${input.steersPending} steer${input.steersPending === 1 ? '' : 's'} pending`);
    rows.push(clip(parts.join(` ${dot} `)));
  }

  // 3 — HEAD drift and the files that moved under the pause
  if (input.head !== null) {
    const h = input.head;
    const subjects = h.subjects.length === 0 ? '' : `: ${h.subjects.map((s) => `"${s}"`).join(', ')}`;
    const commits = `(${h.commits} commit${h.commits === 1 ? '' : 's'} by ${h.by}${subjects})`;
    const changed = input.changedSince.length === 0 ? '' : ` ${dot} changed since: ${input.changedSince.join(', ')}`;
    rows.push(clip(`HEAD ${h.from} ${ascii ? '->' : '→'} ${h.to} ${commits}${changed}`));
  }

  // 4 — who else is on this repo, and what this run spent
  const live: string[] = [];
  if (input.livePeer !== null) {
    const p = input.livePeer;
    const detail = [p.step === null ? null : `step ${p.step}`, p.editing === null ? null : `editing ${p.editing}`].filter((x): x is string => x !== null).join(', ');
    live.push(`live on this repo: ${p.label}${detail === '' ? '' : ` (${detail})`}`);
  }
  if (input.spend !== null) live.push(`spend $${input.spend.usd.toFixed(2)}/${input.spend.capUsd.toFixed(2)}`);
  if (input.wallMs !== null) live.push(`wall ${formatDuration(input.wallMs)}${input.maxWallMs === null ? '' : `/${formatDuration(input.maxWallMs)}`}`);
  // §7 row 38: OMITTED, never `ctx 0%`, when there is no `lastPromptChars` behind it
  if (input.ctxPct !== null) live.push(`ctx ${Math.round(input.ctxPct)}%`);
  if (live.length > 0) rows.push(clip(live.join(` ${dot} `)));

  // 5 — the branch's own sentence
  const note = resumeCardNote(input);
  if (note !== null) rows.push(clip(note));

  // 6 — the keys, and the sub-state's own escape (§7 row 91)
  rows.push(clip(resumeCardKeys(input, columns === 0 ? 120 : columns, ascii)));
  if (columns === 0 || columns >= 52) rows.push(clip(`Esc returns to the list${input.branch === 'taken-over' ? ` ${dash} /resume --force-takeback re-takes the run` : ''}`));
  return rows;
}

/** The one sentence a branch adds beneath the facts, or `null` for the two branches that add none. */
export function resumeCardNote(input: ResumeCardInput): string | null {
  switch (input.branch) {
    case 'targets-moved':
      return input.targetsMoved === null ? null : targetsMovedLine(input.targetsMoved);
    case 'imported':
      return input.importedFrom === null ? null : importedRunLine(input.importedFrom);
    case 'taken-over':
      return input.takenOver === null ? null : takenOverLine(input.takenOver);
    case 'forked-unverified':
      return input.forked === null ? null : unqualifiedClaimLine(input.forked);
    // `fresh`, `replayable`, `crashed` and `live-elsewhere` say everything they have to say in the status and key
    // rows (S25 and S26 ARE those rows), so a note here would be a second copy of a pinned string.
    case 'fresh':
    case 'replayable':
    case 'crashed':
    case 'live-elsewhere':
      return null;
  }
}

/** §7 row 82: the screen-reader form of the card — every fact the sighted card carries, in words. */
export function resumeCardSentence(input: ResumeCardInput, nowMs: number): string {
  const parts: string[] = [`Resume ${input.runId}, ${input.title}.`];
  if (input.branch === 'crashed' && input.crashed !== null) {
    parts.push(`Crashed ${shortAgo(input.crashed.agoMs)} ago during step ${input.crashed.step} ${input.crashed.stage}; step ${input.crashed.step} restarts.`);
  } else if (input.pausedAtMs !== null) {
    parts.push(`Paused ${shortAgo(nowMs - input.pausedAtMs)} ago${input.step === null ? '' : ` at step ${input.step}`}.`);
  }
  if (input.steersPending > 0) parts.push(`${input.steersPending} steers pending.`);
  if (input.ctxPct !== null) parts.push(`Context ${Math.round(input.ctxPct)} percent.`);
  const note = resumeCardNote(input);
  if (note !== null) parts.push(`${note}.`);
  parts.push(input.branch === 'replayable' ? 'Press Enter to resume fresh, r to replay the paused proposal, Escape to return to the list.' : 'Press Enter to resume, Escape to return to the list.');
  return parts.join(' ');
}
