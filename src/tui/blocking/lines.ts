/**
 * Blocking panes and the severity → surface map (TUI-DESIGN §13.1, §13.3, §24) — pure.
 *
 * `blockingLines(req, rows, columns)` renders every `BlockingRequest` kind into ≤ 4 rows for the overlay slot,
 * shared by the Ink overlay, `--plain` and the screen-reader twin. The `*Detail` builders fix how the engine
 * encodes each kind's facts into `BlockingRequest.detail` so the rows can be rendered from the contract alone.
 * Rows are measured and cut in cells (O2's `width.ts`, §4.2), never by Ink wrapping (§2.1).
 */
import type { BlockingKind, BlockingRequest, EngineEvent } from '../../core/types.js';
import { JEV_RETRY } from '../../jev/types.js';
import { stringWidth, truncateCells } from '../composer/width.js';
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
}

function sideWord(req: BlockingRequest): 'jev' | 'generator' {
  return req.side ?? 'jev';
}

/** TUI-DESIGN §24 blocking panes as structure: title, middle rows, keys, per kind. Pure. */
export function blockingRowsStructured(req: BlockingRequest): BlockingRows {
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
      return {
        title: [`checkpoint degraded: ${checkpointDegradedDetail(code, file)}`],
        middle: [`${file} could not be written since step ${req.step} — the run cannot be resumed from here.`],
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
  }
}

/** TUI-DESIGN §24 blocking panes: every row at full height and width — the §24 text verbatim, first = reason, keys last or inline. */
export function blockingRowsFull(req: BlockingRequest): string[] {
  const s = blockingRowsStructured(req);
  return s.inline ? [[...s.title, s.keys].join(' · '), ...s.middle] : [s.title.join(' · '), ...s.middle, s.keys];
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
export function blockingLines(req: BlockingRequest, rows: number, columns: number): string[] {
  const budget = Math.min(BLOCKING_MAX_ROWS, Number.isFinite(rows) ? Math.floor(rows) : 0);
  const cols = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  if (budget <= 0) return [];
  const s = blockingRowsStructured(req);
  let out: string[];
  if (!s.inline) {
    out = [s.title.join(' · '), ...s.middle, s.keys];
  } else {
    const one = [...s.title, s.keys].join(' · ');
    if (budget === 1 || stringWidth(one) <= cols) {
      out = [one, ...s.middle];
    } else {
      const head = packSegments(s.title, cols);
      const lastHead = head[head.length - 1] ?? '';
      const joined = `${lastHead} · ${s.keys}`;
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
  }
}

/** Screen-reader twin: reason and middle rows as a numbered list, the keys row last unnumbered (TUI-DESIGN §14.2 "reviews, wizard and pickers as numbered lists"). */
export function blockingLinesScreenReader(req: BlockingRequest): string[] {
  const s = blockingRowsStructured(req);
  const numbered = [s.title.join(' · '), ...s.middle].map((r, i) => `${i + 1} ${r}`);
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
