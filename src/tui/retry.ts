/**
 * The retry row model (TUI-DESIGN §13.2, §7 live region, F-R, F-Y, §24 "Retry row", D10): a 1 Hz countdown in
 * live row 1 — `jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)    [r] retry now` — and the
 * `last: HTTP 529 overloaded · request-id req_…` cause row when the cause changed; `Retry-After` capped at 60 s;
 * cleared in the same action as `retry:settled` (the reducer nulls `retrying`). `startTicker` is the one
 * generic `setInterval` owner the reducer's 1 Hz `tick` uses (§14.2 allows `setInterval` here and in spinner.ts).
 */
import type { RetryCause } from '../core/types.js';
import { GLYPHS, type GlyphSet, truncateCells } from './glyphs.js';

/** TUI-DESIGN §15 item 20 `RetryView` (`retryAfter` and `requestId` are additive: the row prints them). */
export interface RetryView {
  side: 'jev' | 'generator';
  attempt: number;
  maxAttempts: number;
  untilMs: number;
  cause: RetryCause;
  lastCause: RetryCause | null;
  retryAfter?: boolean;
}

/** TUI-DESIGN §13.2: `Retry-After` shown as capped at 60 s. */
export const RETRY_AFTER_CAP_S = 60;
/** The 1 Hz tick (§13.2). */
export const RETRY_TICK_MS = 1000;
export const RETRY_NOW_KEY = '[r] retry now';

/** Whole seconds left until `untilMs`, never negative. */
export function secondsLeft(untilMs: number, nowMs: number): number {
  if (!Number.isFinite(untilMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
}

function hostOf(message: string): string {
  const m = /([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?/i.exec(message);
  return m ? m[0] : 'the host';
}

/**
 * TUI-DESIGN §13.2 / §24: the short cause — `HTTP 429 rate limited`, `HTTP 529 overloaded`, `HTTP <status> <short>`;
 * network causes use the offline copy (`offline: DNS lookup failed for <host>`, `offline: cannot reach <host>`,
 * `no response from <host> in 10 s`); host only, never a URL. `retryAfter` appends ` (Retry-After)`.
 */
export function retryCauseText(cause: RetryCause, retryAfter = false): string {
  let text: string;
  const msg = cause.message.trim();
  switch (cause.kind) {
    case 'http': {
      const status = cause.status ?? 0;
      const word = status === 429 ? 'rate limited' : status === 529 || status === 503 ? 'overloaded' : status === 500 || status === 502 ? 'server error' : msg === '' ? 'failed' : msg;
      text = `HTTP ${status} ${word}`;
      break;
    }
    case 'network': {
      const code = cause.code ?? '';
      const host = hostOf(msg);
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') text = `offline: DNS lookup failed for ${host}`;
      else if (code === 'ETIMEDOUT') text = `no response from ${host} in 10 s`;
      else text = `offline: cannot reach ${host}`;
      break;
    }
    case 'timeout':
      text = `no response from ${hostOf(msg)} in 10 s`;
      break;
    case 'invalid':
      text = msg === '' ? 'invalid response' : `invalid response: ${msg}`;
      break;
    case 'stream':
      text = msg === '' ? 'stream interrupted' : `stream interrupted: ${msg}`;
      break;
  }
  return retryAfter ? `${text} (Retry-After)` : text;
}

/**
 * TUI-DESIGN §24: `jev: retrying 2/3 in 12 s · HTTP 429 rate limited (Retry-After)    [r] retry now` — the `[r]`
 * hint right-aligned when the width allows, dropped first when it does not.
 */
export function retryRow(v: RetryView, nowMs: number, columns: number, g: GlyphSet = GLYPHS.unicode): string {
  const left = `${v.side}: retrying ${v.attempt}/${v.maxAttempts} in ${Math.min(secondsLeft(v.untilMs, nowMs), v.retryAfter === true ? RETRY_AFTER_CAP_S : Number.MAX_SAFE_INTEGER)} s ${g.dot} ${retryCauseText(v.cause, v.retryAfter === true)}`;
  const w = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 80));
  const gap = w - left.length - RETRY_NOW_KEY.length;
  if (gap >= 4) return `${left}${' '.repeat(gap)}${RETRY_NOW_KEY}`;
  if (gap >= 1) return `${left} ${RETRY_NOW_KEY}`.slice(0, w);
  return truncateCells(left, w, g);
}

/** TUI-DESIGN §13.2: `last: HTTP 529 overloaded · request-id req_…` — only when the cause changed since the previous attempt. */
export function retryLastRow(v: RetryView, columns: number, g: GlyphSet = GLYPHS.unicode): string | null {
  const last = v.lastCause;
  if (last === null) return null;
  if (last.kind === v.cause.kind && last.status === v.cause.status && last.code === v.cause.code && last.message === v.cause.message) return null;
  const id = /(request-id|x-request-id|id)[:= ]+([A-Za-z0-9_-]{6,})/i.exec(last.message);
  const tail = id ? ` ${g.dot} request-id ${id[2]}` : '';
  return truncateCells(`last: ${retryCauseText(last)}${tail}`, Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 80)), g);
}

/** TUI-DESIGN §7 / §13.2: the live-region rows during a retry — the countdown row, then the cause row when it fits. */
export function retryLiveLines(v: RetryView, nowMs: number, rows: number, columns: number, g: GlyphSet = GLYPHS.unicode): string[] {
  const n = Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0));
  if (n === 0) return [];
  const out = [retryRow(v, nowMs, columns, g)];
  const last = retryLastRow(v, columns, g);
  if (n >= 2 && last !== null) out.push(last);
  return out;
}

/** TUI-DESIGN §15 item 20 `retry` row: the view for a `retry` event, `lastCause` = the previous attempt's cause. */
export function retryViewFrom(e: { side: 'jev' | 'generator'; info: { attempt: number; maxAttempts: number; waitMs: number; retryAfter: boolean; cause: RetryCause } }, prev: RetryView | null, nowMs: number): RetryView {
  return {
    side: e.side,
    attempt: e.info.attempt,
    maxAttempts: e.info.maxAttempts,
    untilMs: nowMs + Math.max(0, Number.isFinite(e.info.waitMs) ? e.info.waitMs : 0),
    cause: e.info.cause,
    lastCause: prev !== null && prev.side === e.side ? prev.cause : null,
    retryAfter: e.info.retryAfter,
  };
}

/**
 * The 1 Hz ticker the reducer's `tick` action and the retry row share (§13.2, §15 item 20): one `setInterval`,
 * unref'd so it never keeps the process alive; returns the stop function.
 */
export function startTicker(fn: () => void, ms: number = RETRY_TICK_MS): () => void {
  const t = setInterval(fn, Math.max(1, Math.floor(Number.isFinite(ms) ? ms : RETRY_TICK_MS)));
  t.unref();
  return () => clearInterval(t);
}
