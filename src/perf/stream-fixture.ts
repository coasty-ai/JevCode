/**
 * The known replies the stream probe streams through the `--mock` chat path (`src/perf/stream-latency.ts`), shared by
 * the mock (`src/cli/mock-trajectory.ts` `mockChatReplyFromEnv`, `JEVCODE_MOCK_CHAT_STREAM=<preset>`) and the probe, so
 * both sides read one list of deltas and one list of markers.
 *
 * Every delta that carries text ends in a **marker**: a lowercase letter and two digits (three in `long`), unique in
 * the reply (`k01`, `p17`, `b02`, `c01`, …). A delta counts as painted in the first frame whose visible rows contain its
 * marker as a whole token (`markerRe`); the deltas that carry only line structure (`\n`, a fence line) have none and are
 * not measured one by one — they show up in `blankLinesDropped` and the commit comparison instead. Markers are ASCII,
 * so a latin1 capture keeps them intact.
 *
 *   mixed  the prototype's reply (46 deltas, 421 characters, 40 markers): a greeting line split across two deltas, two
 *          short lines, a blank line, a 30-word paragraph wider than two 80-column rows, a blank line, three bullets,
 *          a blank line, a ```ts fence with two lines, and a closing line with no newline.
 *   long   ≈ 8 KB of paragraphs (24 × 22 words, a blank line between them): the long-reply series at a 2 ms gap, where
 *          anything per-delta that grows with the text so far (whole-text redaction, re-wrapping) shows up.
 */

export type StreamPresetName = 'mixed' | 'long';
export const STREAM_PRESETS: readonly StreamPresetName[] = ['mixed', 'long'];

export interface StreamPreset {
  name: StreamPresetName;
  /** the deltas, in emission order */
  deltas: readonly string[];
  /** `markers[i]` is the marker delta `i` carries, or null for a structure-only delta */
  markers: readonly (string | null)[];
  /** the whole reply (`deltas.join('')`) */
  text: string;
}

/** a marker: a lowercase letter then two or three digits, as a whole token */
const MARKER_IN_DELTA = /(?<![A-Za-z0-9])([a-z]\d{2,3})(?![0-9])/g;

/** The last marker in a delta, or null. */
export function markerOf(delta: string): string | null {
  let last: string | null = null;
  for (const m of delta.matchAll(MARKER_IN_DELTA)) last = m[1] ?? null;
  return last;
}

/** A regex that finds `marker` as a whole token in a row (never inside a longer word or number: `p1` never matches `p17`). */
export function markerRe(marker: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${marker}(?![0-9])`);
}

function mixedDeltas(): string[] {
  const paragraph: string[] = [];
  for (let i = 1; i <= 30; i++) paragraph.push(`word p${String(i).padStart(2, '0')} `);
  return [
    'Sure k01.',
    ' Here is the plan k02.\n',
    'Short line k03.\n',
    'Another k04.\n',
    '\n',
    ...paragraph,
    '\n',
    '\n',
    '- first b01\n',
    '- second b02\n',
    '- third b03\n',
    '\n',
    '```ts\n',
    'const c01 = 1;\n',
    'const c02 = 2;\n',
    '```\n',
    'Done k05.',
  ];
}

const LONG_WORDS = ['streaming', 'rendering', 'painting', 'buffering', 'committing', 'wrapping', 'measuring', 'scrolling'];

function longDeltas(): string[] {
  const out: string[] = [];
  let n = 0;
  for (let p = 0; p < 24; p++) {
    if (p > 0) out.push('\n\n');
    for (let w = 0; w < 22; w++) {
      n += 1;
      out.push(`${LONG_WORDS[n % LONG_WORDS.length]} n${String(n).padStart(3, '0')} `);
    }
  }
  return out;
}

/** The preset's deltas, markers and text. */
export function streamPreset(name: StreamPresetName): StreamPreset {
  const deltas = name === 'long' ? longDeltas() : mixedDeltas();
  return { name, deltas, markers: deltas.map(markerOf), text: deltas.join('') };
}

/** `JEVCODE_MOCK_CHAT_STREAM`'s value as a preset name, or null (unset, empty or unknown). */
export function streamPresetName(v: string | undefined): StreamPresetName | null {
  const t = v?.trim();
  return t === 'mixed' || t === 'long' ? t : null;
}
