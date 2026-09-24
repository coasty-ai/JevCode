/**
 * TUI-DESIGN-4 §1.3.4 — what the alternate screen takes away, and how it is paid back.
 *
 * Two mechanisms, one shared producer:
 *   · `/scrollback` — suspend (which leaves the alternate screen), print the whole transcript to the PRIMARY
 *     screen, wait for a key, resume.
 *   · the on-exit dump — after `ESC[?1049l`, the same bytes, so the session ends with the scrollback classic
 *     would have left.
 *
 * The property that makes both worth having is that the dump is byte-identical to a `--plain` run of the same
 * script: both go through `formatTranscriptItem` and the launch glyph table, which is exactly what
 * `createPlainRenderer` writes (`src/tui/plain.ts:1289, :1320`). That identity is the first test here.
 */
import { describe, expect, it } from 'vitest';
import { GLYPHS } from '../../../../src/tui/glyphs.js';
import { SCROLLBACK_CHUNK_CHARS, formatTranscriptItem, itemsFromEvent, localItem, transcriptDumpChunks, type TranscriptItem } from '../../../../src/tui/plain.js';
import { SCROLLBACK_RESUME_ROW, printToPrimaryScreen, waitForAnyKey } from '../../../../src/tui/terminal.js';
import type { EngineEvent } from '../../../../src/core/types.js';

const EVENTS: readonly EngineEvent[] = [
  { type: 'run:start', runId: '20260922-030000-abcd1234', mode: 'jev-on', resumedFromStep: null, task: 'fix the failing test' },
  { type: 'transcript', step: 1, level: 'info', text: 'a long body that will certainly not need wrapping here' },
  { type: 'transcript', step: 2, level: 'warn', text: 'something to say' },
];

function items(): TranscriptItem[] {
  let seq = 0;
  const out: TranscriptItem[] = [];
  for (const e of EVENTS) {
    const made = itemsFromEvent(e, seq);
    seq += made.length;
    out.push(...made);
  }
  out.push(localItem('a local row', 0));
  return out;
}

describe('transcriptDumpChunks (§1.3.4)', () => {
  it('is exactly what `createPlainRenderer` writes for the same items, row for row, in both glyph sets', () => {
    for (const g of [GLYPHS.unicode, GLYPHS.ascii]) {
      const list = items();
      // the plain renderer's own loop: `write(`${formatTranscriptItem(item)}\n`)` through the glyph table
      const plain = list.map((i) => `${g.mode === 'ascii' ? asciiTwin(formatTranscriptItem(i)) : formatTranscriptItem(i)}\n`).join('');
      expect(transcriptDumpChunks(list, g).join('')).toBe(plain);
    }
  });

  it('an empty transcript produces no chunks at all — §1.3.4 skips the dump rather than flashing the screen', () => {
    expect(transcriptDumpChunks([], GLYPHS.unicode)).toEqual([]);
  });

  it('chunks are bounded and never split a row, so a slow link cannot push the exit past UNMOUNT_TIMEOUT_MS', () => {
    const many = Array.from({ length: 4000 }, (_x, i) => localItem(`row ${i} ${'x'.repeat(40)}`, i));
    const chunks = transcriptDumpChunks(many, GLYPHS.unicode, 1024);
    expect(chunks.length).toBeGreaterThan(50);
    for (const c of chunks) {
      expect(c.endsWith('\n')).toBe(true);
      // a chunk may exceed the limit only when ONE row does
      expect(c.length <= 1024 || c.split('\n').filter((r) => r !== '').length === 1).toBe(true);
    }
    expect(chunks.join('')).toBe(transcriptDumpChunks(many, GLYPHS.unicode, Number.POSITIVE_INFINITY).join(''));
    expect(SCROLLBACK_CHUNK_CHARS).toBe(64 * 1024);
  });
});

describe('printToPrimaryScreen (§1.3.4)', () => {
  function suspension(log: string[]): () => Promise<{ resume: () => Promise<void>; [Symbol.asyncDispose]: () => Promise<void> }> {
    return async () => {
      log.push('suspend');
      const resume = async (): Promise<void> => {
        log.push('resume');
      };
      return { resume, [Symbol.asyncDispose]: resume };
    };
  }

  it('suspends, writes every chunk, waits for a key, then resumes — and the queue brackets the whole thing (§4.8)', async () => {
    const log: string[] = [];
    const written: string[] = [];
    await printToPrimaryScreen({
      chunks: ['one\n', 'two\n'],
      suspendTerminal: suspension(log),
      write: (t) => {
        written.push(t);
        log.push('write');
      },
      waitForKey: async () => {
        log.push('key');
      },
      onQueue: { suspend: () => log.push('queue:suspend'), resume: () => log.push('queue:resume') },
      repaint: () => log.push('repaint'),
    });
    expect(log).toEqual(['queue:suspend', 'suspend', 'write', 'write', 'write', 'key', 'resume', 'queue:resume', 'repaint']);
    expect(written.slice(0, 2)).toEqual(['one\n', 'two\n']);
    expect(written[2]).toBe(`${SCROLLBACK_RESUME_ROW}\n`);
  });

  it('the on-exit form takes no key and prints no resume row', async () => {
    const written: string[] = [];
    await printToPrimaryScreen({ chunks: ['one\n'], suspendTerminal: suspension([]), write: (t) => written.push(t) });
    expect(written).toEqual(['one\n']);
  });

  it('a write that throws still resumes Ink and the queue — a dead pipe can never strand the session outside Ink', async () => {
    const log: string[] = [];
    await expect(
      printToPrimaryScreen({
        chunks: ['boom\n'],
        suspendTerminal: suspension(log),
        write: () => {
          throw new Error('EPIPE');
        },
        onQueue: { suspend: () => log.push('queue:suspend'), resume: () => log.push('queue:resume') },
      }),
    ).rejects.toThrow('EPIPE');
    expect(log).toEqual(['queue:suspend', 'suspend', 'resume', 'queue:resume']);
  });

  it('an empty transcript never suspends', async () => {
    const log: string[] = [];
    await printToPrimaryScreen({ chunks: [], suspendTerminal: suspension(log), write: () => log.push('write') });
    expect(log).toEqual([]);
  });
});

describe('waitForAnyKey (§1.3.4)', () => {
  it('a non-TTY stdin resolves at once rather than hanging the session', async () => {
    await expect(waitForAnyKey({ isTTY: false })).resolves.toBeUndefined();
    await expect(waitForAnyKey({ isTTY: true })).resolves.toBeUndefined();
  });

  it('enters raw mode for the read and leaves it exactly as it was found', async () => {
    const calls: boolean[] = [];
    let fire: (() => void) | null = null;
    const stdin = {
      isTTY: true,
      isRaw: false,
      setRawMode: (m: boolean) => calls.push(m),
      once: (_e: 'readable' | 'data', fn: () => void) => {
        fire = fn;
      },
      resume: () => undefined,
    };
    const p = waitForAnyKey(stdin);
    expect(calls).toEqual([true]);
    (fire as unknown as () => void)();
    await p;
    expect(calls).toEqual([true, false]);
  });

  it('a stdin already raw (Ink mid-session) is left raw', async () => {
    const calls: boolean[] = [];
    let fire: (() => void) | null = null;
    const p = waitForAnyKey({ isTTY: true, isRaw: true, setRawMode: (m: boolean) => calls.push(m), once: (_e: 'readable' | 'data', fn: () => void) => (fire = fn) });
    expect(calls).toEqual([]);
    (fire as unknown as () => void)();
    await p;
    expect(calls).toEqual([]);
  });
});

/** the `--ascii` twin of a row, the way `glyphTwin` does it (the test re-derives it so the assertion is independent) */
function asciiTwin(s: string): string {
  const m: Record<string, string> = { '·': '-', '…': '...', '→': '->', '✓': 'v', '✗': 'x', '↑': '^', '↓': 'v', '•': '*', '▲': '^' };
  let out = '';
  for (const ch of s) out += m[ch] ?? ch;
  return out;
}
