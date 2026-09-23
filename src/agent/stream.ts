/**
 * The prose stream shaper (docs/AGENT-LOOP-DESIGN.md §9.3). `generator:delta` stays the raw chunk stream; the shaper
 * turns the same chunks into `assistant:text` line commits for scrollback:
 *
 *  - whole lines are committed as soon as they are complete (everything up to the last newline);
 *  - inside an open code fence (an odd count of lines starting with three backticks) lines are held until the fence closes
 *    or the pending text passes 2,000 chars, so a code block lands in one piece;
 *  - the end of the turn commits the remainder with `final: true` (an empty remainder commits nothing);
 *  - a provider retry after bytes streamed (`onAttemptReset`) drops what is pending and emits `assistant:reset`, because
 *    committed lines cannot be taken back from scrollback — the restart is explicit instead of silently doubled.
 *
 * Codex commits streamed markdown at newlines the same way (`codex-rs/tui/src/markdown_stream.rs`).
 */
import type { EngineEvent } from '../core/types.js';

/** pending text above this is committed even inside an open fence */
export const FENCE_HOLD_MAX_CHARS = 2_000;

const FENCE_LINE = /^ {0,3}```/;

export interface ProseShaper {
  push(chunk: string): void;
  /** the end of the turn: commit the remainder */
  finish(): void;
  /** a provider retry restarted the turn */
  reset(attempt: number): void;
}

export function createProseShaper(o: { step: number; turn: number; emit: (e: EngineEvent) => void; redact: (s: string) => string }): ProseShaper {
  let attempt = 1;
  let pending = '';
  let fenceOpen = false;

  const commit = (text: string, final: boolean): void => {
    o.emit({ type: 'assistant:text', step: o.step, turn: o.turn, attempt, text: o.redact(text), final });
  };

  const flush = (): void => {
    const lastNl = pending.lastIndexOf('\n');
    if (lastNl < 0) return;
    const lines = pending.slice(0, lastNl).split('\n');
    let open = fenceOpen;
    let commitThrough = -1;
    let openAfterCommit = fenceOpen;
    lines.forEach((line, i) => {
      if (FENCE_LINE.test(line)) open = !open;
      if (!open) {
        commitThrough = i;
        openAfterCommit = false;
      }
    });
    if (pending.length > FENCE_HOLD_MAX_CHARS) {
      commitThrough = lines.length - 1;
      openAfterCommit = open;
    }
    if (commitThrough < 0) return;
    const committed = lines.slice(0, commitThrough + 1).join('\n');
    const rest = lines.slice(commitThrough + 1);
    pending = [...rest, pending.slice(lastNl + 1)].join('\n');
    fenceOpen = openAfterCommit;
    commit(committed, false);
  };

  return {
    push(chunk) {
      if (chunk.length === 0) return;
      pending += chunk;
      flush();
    },
    finish() {
      if (pending.length > 0) commit(pending, true);
      pending = '';
      fenceOpen = false;
    },
    reset(next) {
      pending = '';
      fenceOpen = false;
      attempt = next;
      o.emit({ type: 'assistant:reset', step: o.step, turn: o.turn, attempt: next });
    },
  };
}
