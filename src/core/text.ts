/** Text-bounding helpers shared by the window, the Jev state builder and the transcript. */

export const HEAD_TAIL_MARKER = (dropped: number): string => `\n…[${dropped} chars omitted]…\n`;

/** Keep the first `head` and last `tail` characters, marking how much was dropped. */
export function headTail(s: string, head: number, tail: number): string {
  if (s.length <= head + tail) return s;
  const dropped = s.length - head - tail;
  return s.slice(0, head) + HEAD_TAIL_MARKER(dropped) + (tail > 0 ? s.slice(s.length - tail) : '');
}

/** Clip to `max` characters, marking the truncation. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Byte length of a UTF-8 string. */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Keep at most `maxBytes` of UTF-8 (whole characters), returning the kept text and dropped byte count. */
export function clipBytes(s: string, maxBytes: number): { text: string; truncatedBytes: number } {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return { text: s, truncatedBytes: 0 };
  let end = maxBytes;
  // back up to a UTF-8 boundary
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncatedBytes: buf.length - end };
}

/** One-line summary of a multi-line string. */
export function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

/**
 * Normalisation used for loop signatures (§6): strips digits, hex hashes, timestamps,
 * durations and the workspace path so that "the same failure" hashes identically.
 */
export function normaliseForSignature(s: string, workspaceRoot?: string): string {
  let out = s;
  if (workspaceRoot) out = out.split(workspaceRoot).join('<ws>');
  return out
    .replace(/\b[0-9a-f]{7,64}\b/gi, '<hex>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|m|min|mins|minutes|h|hours)\b/gi, '<dur>')
    .replace(/\d+/g, '<n>')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * TUI-DESIGN-4 §3.4: the ONE path shortener — `/status`, `/config`, `/export`, `/report`, the epilogue, `/diff`
 * heads, `[sandbox]` and every error that names a file go through it.
 *
 *  - inside `root` → workspace-relative (`src/app.py`; the root itself is `.`);
 *  - else inside `home` → `~`-abbreviated (a literal `$HOME` PREFIX only, so a directory named `~x` is untouched);
 *  - else left-elided to `width`, keeping the last two segments (`…/runs/20260922-035503-kntk2yw3`).
 *
 * It NEVER breaks a run id: when the last segment alone exceeds `width` the whole (shortened) path is returned and
 * the row wraps instead. A relative path is returned unchanged, and a UNC / Windows path gets no substitution.
 * `redact` runs FIRST at the call site (§3.4 edge 6) — this function never inspects content.
 *
 * `measure` keeps `src/core/**` free of a `src/tui/**` import (it imports nothing today and the first-frame path
 * reaches it): the default counts code points, which is exact for the ASCII paths every gate samples; the TUI
 * callers pass `cellWidth` from `src/tui/glyphs.ts` so §3.4 edge 5's wide graphemes measure correctly.
 */
export function shortPath(abs: string, o: { root: string; home?: string; width: number; measure?: (s: string) => number; ellipsis?: string }): string {
  const measure = o.measure ?? ((s: string): number => [...s].length);
  const ell = o.ellipsis ?? '…';
  const width = Number.isFinite(o.width) ? Math.floor(o.width) : 0;
  const fit = (s: string): string => {
    if (width <= 0 || measure(s) <= width) return s;
    const segs = s.split('/').filter((x) => x !== '');
    const last = segs.length > 0 ? segs[segs.length - 1]! : s;
    // a run id is never cut: hand the caller the whole thing and let the row wrap
    if (measure(last) + measure(ell) + 1 > width) return s;
    for (let keep = Math.min(2, segs.length); keep >= 1; keep--) {
      const tail = `${ell}/${segs.slice(segs.length - keep).join('/')}`;
      if (measure(tail) <= width) return tail;
    }
    return s;
  };
  const trimSlash = (s: string): string => (s.length > 1 && s.endsWith('/') ? s.replace(/\/+$/, '') : s);
  // (3) a relative path is returned unchanged; (4) a UNC / Windows path gets no substitution but must not throw
  if (!abs.startsWith('/')) return abs;
  const path = trimSlash(abs);
  const root = trimSlash(o.root);
  const home = o.home === undefined || o.home === '' ? null : trimSlash(o.home);
  // (1) root === home → `~` wins
  const rootWins = root !== '' && root !== '/' && (home === null || root !== home);
  if (rootWins && (path === root || path.startsWith(`${root}/`))) {
    const rel = path === root ? '.' : path.slice(root.length + 1);
    return fit(rel);
  }
  if (home !== null && home !== '/' && (path === home || path.startsWith(`${home}/`))) {
    return fit(path === home ? '~' : `~/${path.slice(home.length + 1)}`);
  }
  return fit(path);
}
