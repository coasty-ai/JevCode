/**
 * Bubbles (TUI-DESIGN-2 §3.10): `[you]` / `[jevcode]` are transcript items, one per line, redacted at emission —
 * `formatTranscriptItem` prints `[you] hi` / `[jevcode] Hi. I'm ready …` and `--plain`, the `<Static>` rows and the
 * `--json` `ui` lines carry the same text. `bubbleLines` is the one splitter every sink shares: the composer's
 * acknowledged spans were `addSecret`ed one line earlier, so a pasted secret is masked exactly as the engine masks the
 * task, and a multi-line draft yields one item per line instead of `oneLine()`'s ` ⏎ ` flattening.
 */
import type { ChatLabel } from '../core/types.js';
import { TRANSCRIPT_TEXT_MAX } from '../tui/plain.js';
import { clip } from '../core/text.js';

export type ChatRole = 'you' | 'jevcode';

export const CHAT_LABELS: Readonly<Record<ChatRole, ChatLabel>> = { you: '[you]', jevcode: '[jevcode]' };

export function isChatLabel(label: string | undefined): label is ChatLabel {
  return label === '[you]' || label === '[jevcode]';
}

/** `redact(text)` split per line, blank lines dropped, each ≤ TRANSCRIPT_TEXT_MAX (never `oneLine`-flattened) */
export function bubbleLines(text: string, redact: (s: string) => string): string[] {
  return redact(text)
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\t/g, ' ').trimEnd())
    .filter((l) => l.trim() !== '')
    .map((l) => clip(l, TRANSCRIPT_TEXT_MAX));
}

/** §3.10 identity rule: the row text every sink prints for one bubble line */
export function bubbleText(role: ChatRole, line: string): string {
  return `${CHAT_LABELS[role]} ${line}`;
}
