/**
 * State-size discipline for the localizer. Jev's wire cap is 32,768 input tokens for the state
 * plus the longest single question; code listings tokenize at roughly three characters per
 * token, so we estimate conservatively from the serialised length and shrink listings until the
 * estimate fits. Nothing here asks Jev to count: every bound is computed in code.
 */
import type { Json, Question } from '../../core/types.js';

/** Characters per token assumed for JSON-wrapped source code (conservative; measured 3–3.5). */
export const CHARS_PER_TOKEN = 3;
/** Task text kept in every state; longer texts are cut with a marker (SWE-bench statements run to 6k). */
export const TASK_CHARS_MAX = 6_000;
/** Tail of the traceback kept in the state: the innermost frames carry the signal. */
export const TRACEBACK_CHARS_MAX = 1_500;
/** Per-field bound for expected/actual/call strings in failure views. */
export const FAILURE_FIELD_CHARS_MAX = 400;
/** Per-line bound in a listing (a minified 2k-character line would swamp the state). */
export const LINE_CHARS_MAX = 200;

export function estimateTokens(state: Json): number {
  return Math.ceil(JSON.stringify(state).length / CHARS_PER_TOKEN);
}

/** A state with its questions, as handed to JevAsk. */
export interface JevRequestShape {
  state: Json;
  questions: Record<string, Question>;
}

/**
 * What the wire caps: the state plus the longest single question (REPORT §14). A line Choice's
 * options repeat the listing, so its question is as large as `program` and must be counted.
 */
export function estimateRequestTokens(state: Json, questions: Record<string, Question>): number {
  let longest = 0;
  for (const q of Object.values(questions)) longest = Math.max(longest, JSON.stringify(q).length);
  return estimateTokens(state) + Math.ceil(longest / CHARS_PER_TOKEN);
}

/** Cut `text` to `max` characters with a marker that says how much was dropped. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `${text.slice(0, max)}… [${dropped} more characters]`;
}

/** Keep the last `max` characters (for tracebacks: the innermost frames are at the end). */
export function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `[${dropped} earlier characters omitted] …${text.slice(-max)}`;
}

/**
 * Build a state at decreasing detail levels until it fits `cap`. `build(level)` returns null
 * when it has nothing smaller to offer; the last non-null state is returned even if it still
 * exceeds the cap (the caller then trusts the wire to reject it, which is loud, not silent).
 */
export function fitToCap(cap: number, build: (level: number) => Json | null): { state: Json; level: number; tokens: number } {
  const r = fitGeneric(cap, build, estimateTokens);
  return { state: r.value, level: r.level, tokens: r.tokens };
}

/** fitToCap over a whole request, measured as the wire does (state + longest question). */
export function fitRequestToCap<R extends JevRequestShape>(cap: number, build: (level: number) => R | null): { request: R; level: number; tokens: number } {
  const r = fitGeneric(cap, build, (req) => estimateRequestTokens(req.state, req.questions));
  return { request: r.value, level: r.level, tokens: r.tokens };
}

function fitGeneric<T>(cap: number, build: (level: number) => T | null, measure: (value: T) => number): { value: T; level: number; tokens: number } {
  let last: { value: T; level: number; tokens: number } | null = null;
  for (let level = 0; ; level++) {
    const value = build(level);
    if (value === null) break;
    const tokens = measure(value);
    last = { value, level, tokens };
    if (tokens <= cap) return last;
  }
  if (last === null) throw new Error('fitToCap: build(0) returned null');
  return last;
}

/**
 * Choose up to `max` consecutive entries of `lines` (ascending line numbers) centred on `focus`;
 * the whole list when it already fits. Centring on a traceback or SBFL line keeps the suspicious
 * region when a listing must be cut.
 */
export function centredWindow<T extends { line: number }>(lines: readonly T[], max: number, focus: number | null): T[] {
  if (lines.length <= max) return [...lines];
  if (max <= 0) return [];
  let centre = 0;
  if (focus !== null) {
    let best = Infinity;
    lines.forEach((l, i) => {
      const d = Math.abs(l.line - focus);
      if (d < best) {
        best = d;
        centre = i;
      }
    });
  } else centre = Math.floor(lines.length / 2);
  let start = Math.max(0, centre - Math.floor(max / 2));
  if (start + max > lines.length) start = lines.length - max;
  return lines.slice(start, start + max);
}
