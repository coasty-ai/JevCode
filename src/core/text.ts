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
