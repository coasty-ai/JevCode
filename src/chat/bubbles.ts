/**
 * Bubbles (TUI-DESIGN-2 §3.10; TUI-DESIGN-4 §5.2, D-Y): `[you]` / `[jevcode]` are transcript items, one per line,
 * redacted at emission — `formatTranscriptItem` prints `[you] hi` / `[jevcode] Hi. I'm ready …` and `--plain`, the
 * `<Static>` rows and the `--json` `ui` lines carry the same text. `bubbleLines` is the one splitter every sink
 * shares: the composer's acknowledged spans were `addSecret`ed one line earlier, so a pasted secret is masked exactly
 * as the engine masks the task, and a multi-line draft yields one item per line instead of `oneLine()`'s ` ⏎ `
 * flattening.
 *
 * Round 4 (P-C4, P-C5) stops misrepresenting pasted code: a blank line the author wrote **survives** as an empty
 * item (a run of more than two collapses to two), a tab advances to the next **4**-column stop instead of becoming
 * one space, and a clipped message says how much is missing instead of ending in a bare `…`.
 */
import type { ChatLabel } from '../core/types.js';
import { TRANSCRIPT_TEXT_MAX } from '../tui/plain.js';
import { clip } from '../core/text.js';
import { expandTabs as expandTabsAt } from '../tui/diff/text.js';

export type ChatRole = 'you' | 'jevcode';

export const CHAT_LABELS: Readonly<Record<ChatRole, ChatLabel>> = { you: '[you]', jevcode: '[jevcode]' };

export function isChatLabel(label: string | undefined): label is ChatLabel {
  return label === '[you]' || label === '[jevcode]';
}

/** §5.2 P-C4: at most this many consecutive blank lines survive inside one turn. */
export const BUBBLE_BLANK_RUN_MAX = 2;
/** §5.2 P-C4: a tab advances to the next multiple of this many columns (pasted code keeps its shape). */
export const BUBBLE_TAB_STOP = 4;

/**
 * Tab → the next `stop`-column boundary, counted from the start of the line. **One** implementation, shared with
 * the diff renderer: round 4's first draft duplicated it here to avoid pulling `undo/diff.ts` in behind the diff
 * module, and then imported `TRANSCRIPT_TEXT_MAX` from `plain.ts`, which imported it anyway. `tui/diff/text.ts`
 * imports nothing at all, so the dependency is gone for both of us (§14.2 review item 13).
 */
export function expandTabs(s: string, stop: number = BUBBLE_TAB_STOP): string {
  return expandTabsAt(s, stop);
}

function group(n: number): string {
  return String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** §5.2 P-C5 / §12: the one row a clipped turn ends with — the full text is still in the ledger and in `/copy last`. */
export function clipMarkerText(missing: number): string {
  return `…(+${group(missing)} characters not shown — /copy last copies the whole message)`;
}

/**
 * §5.2: `redact(text)` split per line, each line's tabs expanded and each clipped to `TRANSCRIPT_TEXT_MAX`.
 * Interior blank lines survive (a run of more than two collapses to two); leading and trailing blank lines are
 * dropped, so a turn never opens or closes with a gap. When any line was clipped one extra row is appended
 * carrying the **summed** number of characters not shown — counted **after** `redact`, so a redaction that
 * lengthens the text can never leak the original length.
 */
export function bubbleLines(text: string, redact: (s: string) => string): string[] {
  const raw = redact(text).split(/\r\n|\r|\n/);
  // drop the leading and trailing blank lines of a paste before anything else
  let from = 0;
  let to = raw.length;
  while (from < to && (raw[from] ?? '').trim() === '') from++;
  while (to > from && (raw[to - 1] ?? '').trim() === '') to--;
  const out: string[] = [];
  let missing = 0;
  let blanks = 0;
  for (let i = from; i < to; i++) {
    const line = expandTabs(raw[i] ?? '').trimEnd();
    if (line === '') {
      blanks += 1;
      if (blanks <= BUBBLE_BLANK_RUN_MAX) out.push('');
      continue;
    }
    blanks = 0;
    const cut = clip(line, TRANSCRIPT_TEXT_MAX);
    if (cut.length < line.length) missing += line.length - (cut.length - 1);
    out.push(cut);
  }
  if (missing > 0) out.push(clipMarkerText(missing));
  return out;
}

/** §3.10 identity rule: the row text every sink prints for one bubble line (an empty line is the bare label). */
export function bubbleText(role: ChatRole, line: string): string {
  return `${CHAT_LABELS[role]} ${line}`.trimEnd();
}
