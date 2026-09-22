/**
 * contract 1.7 items 2 and 8 (docs/TUI-DESIGN-4.md §3.5 D-W, §7.2 P-D2) — the two named engine edits of §9's
 * ownership table, both independent of the orchestration gate:
 *
 *   1. `Engine.annotateBlock(head, rows, opts)` — one `notice ui` per row, HEAD FIRST, so a command block issued
 *      while a run is live writes the same rows to `transcript.log` from the TUI as `--plain` writes from its own
 *      `note(head); for (const l of lines) note(l)` loop (`session.ts:1364–1371`). Returns false when no run is
 *      live, exactly like `annotate`. Bounded at `BLOCK_LOG_MAX` rows plus a final `… +N more rows` (edge 2).
 *   2. the degrade emit — a write failure the ENGINE never awaited still reaches `checkpoint:degraded`, once per
 *      `<file>:<code>` key, because the store reports its own classification through a listener.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCK_LOG_MAX } from '../../../src/loop/engine.js';
import { formatTranscriptItem, itemsFromEvent } from '../../../src/tui/plain.js';
import type { Harness } from './fakes.js';
import { makeEngine, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> {
  const h = await makeEngine(...args);
  harnesses.push(h);
  return h;
}

const readTurns = (n: number) => Array.from({ length: n }, () => turn({ kind: 'read', paths: ['src/a.py'] }));

describe('annotateBlock (TUI-DESIGN-4 §3.5 D-W)', () => {
  it('emits one `notice ui` per row with the head first, and transcript.log holds the same rows in the same order', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    expect(h.engine.annotateBlock?.('/cost', ['run $0.01 of $2.00 (1 %)', 'jev $0.00', 'generator $0.01'])).toBe(false);
    let accepted: boolean | null = null;
    h.engine.events.on('step:start', () => {
      accepted = h.engine.annotateBlock?.('/cost', ['run $0.01 of $2.00 (1 %)', 'jev $0.00', 'generator $0.01']) ?? null;
    });
    await h.engine.run();
    expect(accepted).toBe(true);
    const notices = h.of('notice').filter((n) => n.kind === 'ui');
    expect(notices.map((n) => n.text)).toEqual(['/cost', 'run $0.01 of $2.00 (1 %)', 'jev $0.00', 'generator $0.01']);
    for (const n of notices) expect(n).toMatchObject({ kind: 'ui', level: 'info', label: '[ui]', step: 1 });
    // the four transcript lines are the four renderer lines, in order — the D-W identity
    const lines = h.store.transcript.filter((l) => l.startsWith('[ui] '));
    expect(lines).toEqual(['[ui] /cost', '[ui] run $0.01 of $2.00 (1 %)', '[ui] jev $0.00', '[ui] generator $0.01']);
    expect(notices.map((n, i) => formatTranscriptItem(itemsFromEvent(n, i)[0]!))).toEqual(lines);
    // and false once the run is over, exactly like annotate()
    expect(h.engine.annotateBlock?.('/cost', ['late'])).toBe(false);
    expect(h.of('notice').filter((n) => n.kind === 'ui')).toHaveLength(4);
  });

  it('a head with no rows is one notice; label and level ride every row; redaction applies to each row', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    h.engine.events.on('run:ready', () => {
      h.engine.annotateBlock?.('/config', [], { label: '[config]', level: 'warn' });
      h.engine.annotateBlock?.('/keys', ['openrouter sk-or-v1-SECRETSECRETSECRETSECRET', 'anthropic none'], { label: '[config]', level: 'warn' });
    });
    await h.engine.run();
    const ui = h.of('notice').filter((n) => n.kind === 'ui');
    expect(ui.map((n) => n.text)).toEqual(['/config', '/keys', 'openrouter [REDACTED:test]', 'anthropic none']);
    for (const n of ui) expect(n).toMatchObject({ label: '[config]', level: 'warn', step: null });
    expect(h.store.transcript).toContain('[config] openrouter [REDACTED:test]');
    expect(h.store.transcript.filter((l) => l.includes('sk-or-v1'))).toEqual([]);
  });

  it('edge 2: a block longer than BLOCK_LOG_MAX is cut to that many rows plus a final `… +N more rows`', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    const rows = Array.from({ length: 42 }, (_, i) => `row ${i + 1}`);
    h.engine.events.on('run:ready', () => {
      h.engine.annotateBlock?.('/config', rows);
    });
    await h.engine.run();
    const ui = h.of('notice').filter((n) => n.kind === 'ui');
    // head + BLOCK_LOG_MAX rows + the overflow row
    expect(ui).toHaveLength(1 + BLOCK_LOG_MAX + 1);
    expect(ui[0]!.text).toBe('/config');
    expect(ui[1]!.text).toBe('row 1');
    expect(ui[BLOCK_LOG_MAX]!.text).toBe(`row ${BLOCK_LOG_MAX}`);
    expect(ui.at(-1)!.text).toBe(`… +${42 - BLOCK_LOG_MAX} more rows`);
    // exactly BLOCK_LOG_MAX = 24 per the design's bound, so the cost of a 42-row /config while live is bounded
    expect(BLOCK_LOG_MAX).toBe(24);
  });

  it('edge 1: the loop is atomic with respect to isFinished() — a block started while live emits every row even if the run ends mid-block', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    let emitted = 0;
    h.engine.events.on('step:start', () => {
      // a listener that pauses the engine from inside the block's own emit loop must not truncate the block
      h.engine.events.on('notice', () => {
        emitted += 1;
        if (emitted === 2) h.engine.pause();
      });
      h.engine.annotateBlock?.('/cost', ['a', 'b', 'c']);
    });
    await h.engine.run();
    expect(h.of('notice').filter((n) => n.kind === 'ui').map((n) => n.text)).toEqual(['/cost', 'a', 'b', 'c']);
  });
});

describe('the degrade emit (TUI-DESIGN-4 §7.2 P-D2 item 1)', () => {
  it('a store write failure the engine never awaited still emits `checkpoint:degraded`, once per <file>:<code>', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    // the store classifies and reports; the engine dedupes by key and emits
    const reported = h.store.degradeListener;
    expect(typeof reported).toBe('function');
    h.store.reportDegrade({ code: 'EACCES', file: 'steps.jsonl', text: 'checkpoint degraded: EACCES on steps.jsonl', sentence: 'checkpoint degraded: EACCES on steps.jsonl — the run directory is not writable; this run cannot be resumed', key: 'steps.jsonl:EACCES' });
    h.store.reportDegrade({ code: 'EACCES', file: 'steps.jsonl', text: 'checkpoint degraded: EACCES on steps.jsonl', sentence: 'checkpoint degraded: EACCES on steps.jsonl — the run directory is not writable; this run cannot be resumed', key: 'steps.jsonl:EACCES' });
    h.store.reportDegrade({ code: 'ENOENT', file: 'steps.jsonl', text: 'checkpoint degraded: ENOENT on steps.jsonl', sentence: 'checkpoint degraded: ENOENT on steps.jsonl — the run directory was removed during the run; this run cannot be resumed', key: 'steps.jsonl:ENOENT' });
    await h.engine.run();
    const degraded = h.of('notice').filter((n) => n.kind === 'checkpoint:degraded');
    // edge 1: the dedupe key is <file>:<code>, so a DIFFERENT code on the same file degrades again
    // contract 1.7 (§7.2 edge 6): the notice carries the whole sentence, and edge 1's key is <file>:<code>, so a
    // DIFFERENT code on the same file degrades again
    expect(degraded.map((n) => n.text)).toEqual([
      'checkpoint degraded: EACCES on steps.jsonl — the run directory is not writable; this run cannot be resumed',
      'checkpoint degraded: ENOENT on steps.jsonl — the run directory was removed during the run; this run cannot be resumed',
    ]);
    for (const n of degraded) expect(n.level).toBe('error');
  });

  it('the listener is detached once the run has finished, so a late store failure never emits into a dead engine', async () => {
    const h = await build({ turns: readTurns(1), limits: { maxSteps: 1 } });
    await h.engine.run();
    const before = h.of('notice').filter((n) => n.kind === 'checkpoint:degraded').length;
    h.store.reportDegrade({ code: 'EIO', file: 'jev.jsonl', text: 'checkpoint degraded: EIO on jev.jsonl', sentence: 'checkpoint degraded: EIO on jev.jsonl — the disk reported an I/O error; this run cannot be resumed', key: 'jev.jsonl:EIO' });
    expect(h.of('notice').filter((n) => n.kind === 'checkpoint:degraded')).toHaveLength(before);
  });
});
