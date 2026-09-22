/**
 * TUI-DESIGN-4 §10 S3 / §11: `renderBlock` of the **largest** block the product has — `/config` at 42 rows — at
 * 200 columns, under **2 ms**. The gate exists because `block()` is on the command path of a live TUI: a command
 * issued while a run is live renders its body inside the key→frame budget of D-F (16 ms p95), and `renderBlock`
 * does the whole column arithmetic, the ` · ` packing and the truncation for every row of the block.
 *
 * The machine this runs on is shared, so the gate takes the **best of five** samples (the rule commit 32299bd
 * introduced for the `parseMarkdown` gates): load can make one sample slow, but a real regression — a quadratic
 * layout pass, a `String.length` measurement replaced by a per-grapheme scan — fails every sample.
 */
import { describe, expect, it } from 'vitest';
import { configTableLines } from '../../../../src/cli/config-table.js';
import { blockWidth, renderBlock, type BlockRow } from '../../../../src/tui/block/lines.js';
import type { ConfigRecordValue } from '../../../../src/core/types.js';

/** the measured shape of A3's `/config`: 42 rows, the widest value an absolute path */
const RECORD: Record<string, ConfigRecordValue> = Object.fromEntries(
  Array.from({ length: 42 }, (_, i) => [
    `section${i % 6}.setting${i}`,
    i % 7 === 0
      ? { value: `/Users/someone/Library/Application Support/jevcode/runs/20260922-035503-kntk2yw3/value-${i}`, source: 'env' as const }
      : { value: `value-${i}-${'x'.repeat(i % 13)}`, source: i % 3 === 0 ? ('default' as const) : (`file:/Users/someone/proj/jevcode.json` as const) },
  ]),
);

/** the same 42 rows as `BlockRow[]`, so the bench measures `renderBlock` itself and not `configBlock`'s layout */
const ROWS: BlockRow[] = Object.entries(RECORD).flatMap(([setting, v]) => [
  { kind: 'table' as const, cells: [setting, typeof v.value === 'string' ? v.value : ''] },
]);

function bestOf(n: number, run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    run();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe('renderBlock is fast enough for the live command path (§10 S3, §11)', () => {
  it('renders the 42-row `/config` body at 200 columns in under 2 ms', () => {
    const width = blockWidth(200);
    expect(ROWS.length).toBe(42);
    // warm the JIT: the gate is about the steady state, not the first call
    for (let i = 0; i < 20; i++) renderBlock(ROWS, width);
    const ms = bestOf(5, () => {
      renderBlock(ROWS, width);
    });
    expect(ms, `renderBlock(42 rows, ${width}) took ${ms.toFixed(3)} ms`).toBeLessThan(2);
  });

  it('the whole `/config` block — layout, fold, problems, sandbox footer — stays under 2 ms at 200 columns', () => {
    const width = blockWidth(200);
    for (let i = 0; i < 20; i++) configTableLines(RECORD, { sandboxLevel: 'seatbelt', width, all: true });
    const ms = bestOf(5, () => {
      configTableLines(RECORD, { sandboxLevel: 'seatbelt', width, all: true });
    });
    expect(ms, `configTableLines(42 rows, ${width}) took ${ms.toFixed(3)} ms`).toBeLessThan(2);
  });

  it('is linear, not quadratic, in the row count (10× the rows costs well under 20× the time)', () => {
    const width = blockWidth(200);
    const big: BlockRow[] = Array.from({ length: ROWS.length * 10 }, (_, i) => ROWS[i % ROWS.length] as BlockRow);
    for (let i = 0; i < 10; i++) {
      renderBlock(ROWS, width);
      renderBlock(big, width);
    }
    const small = bestOf(5, () => {
      renderBlock(ROWS, width);
    });
    const large = bestOf(5, () => {
      renderBlock(big, width);
    });
    // 10× the rows: a linear pass lands near 10×; a quadratic one lands near 100×. 20× is the honest guard band.
    expect(large, `${small.toFixed(3)} ms → ${large.toFixed(3)} ms`).toBeLessThan(Math.max(small * 20, 2));
  });
});
