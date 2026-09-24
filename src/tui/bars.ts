/**
 * Probability bars and the Jev latency sparkline (TUI-DESIGN §7.2 "Bars", §7.4 sparkline).
 * Every bar cell is width 1 (11 §3.1); `--ascii` draws `#` on `-` with digit eighths; the
 * screen-reader twin is the aria label. Pure.
 */
import { GLYPHS, type GlyphSet } from './glyphs.js';

/** The sparkline's fixed scale (§7.4): 0–1000 ms; anything slower is the top cell. */
export const SPARKLINE_MAX_MS = 1000;
/** Requests shown in the status-line sparkline (§7.4 "last 12 requests"). */
export const SPARKLINE_CELLS = 12;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return x === Number.POSITIVE_INFINITY ? 1 : 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** TUI-DESIGN §7.2: `'█'.repeat(⌊p·cells⌋)` + one partial eighth cell `▏▎▍▌▋▊▉` + `·` fill; exactly `cells` cells wide; NaN → empty track, ∞ → full. */
export function eighthBar(p: number, cells = 10, g: GlyphSet = GLYPHS.unicode): string {
  const n = Math.max(0, Math.floor(Number.isFinite(cells) ? cells : 0));
  if (n === 0) return '';
  const v = clamp01(p);
  const x = v * n;
  // ⌊p·cells⌋ full cells (the epsilon absorbs binary noise such as 0.7·10 = 7.000000000000001); the rounding lives only inside the partial cell, capped at ▉ so a probability below 1 never draws a full bar
  const full = Math.min(n, Math.floor(x + 1e-9));
  const rem = full >= n ? 0 : Math.min(7, Math.round(Math.max(0, x - full) * 8));
  let out = g.full.repeat(full);
  let used = full;
  if (rem > 0 && used < n) {
    out += g.eighths[rem] ?? g.full;
    used += 1;
  }
  return out + g.dot.repeat(n - used);
}

/** TUI-DESIGN §7.2 SR twin: the bar's aria label `probability 0.44 of 1`. */
export function barAriaLabel(p: number): string {
  return `probability ${clamp01(p).toFixed(2)} of 1`;
}

/** TUI-DESIGN §7.4: sparkline over the last `cells` Jev latencies on the fixed 0–1000 ms scale; `null` (a failed attempt) is a space; fewer samples pad on the left. */
export function sparkline(latenciesMs: readonly (number | null)[], g: GlyphSet = GLYPHS.unicode, cells = SPARKLINE_CELLS): string {
  const n = Math.max(0, Math.floor(Number.isFinite(cells) ? cells : 0));
  if (n === 0) return '';
  const last = latenciesMs.slice(-n);
  let out = '';
  for (const ms of last) {
    if (ms === null || !Number.isFinite(ms)) {
      out += g.spark[0] ?? ' ';
      continue;
    }
    const level = ms <= 0 ? 1 : Math.min(8, Math.max(1, Math.ceil((Math.min(ms, SPARKLINE_MAX_MS) / SPARKLINE_MAX_MS) * 8)));
    out += g.spark[level] ?? g.full;
  }
  return out.padStart(n, ' ');
}

/** The sparkline's aria label (§14.2: bars are `aria-hidden`, the label carries the numbers): `jev latency last N: 231 198 244 ms`. */
export function sparklineAriaLabel(latenciesMs: readonly (number | null)[], cells = SPARKLINE_CELLS): string {
  const last = latenciesMs.slice(-Math.max(0, cells));
  if (last.length === 0) return 'jev latency: no requests yet';
  return `jev latency last ${last.length}: ${last.map((ms) => (ms === null || !Number.isFinite(ms) ? 'failed' : String(Math.round(ms)))).join(' ')} ms`;
}
