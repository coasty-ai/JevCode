/**
 * docs/IMPORT-DESIGN.md §7.6 row 46 / §8.5: the import perf rows exist, their budgets are the
 * design's, and both generated corpora build and tear down. The real gate runs at `scale(2000)`
 * under `jevcode perf`; this test runs the same code at a tiny size so the harness itself cannot
 * rot silently (the budgets are NOT asserted here — a unit run under load would flap).
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { IMPORT_PERF_BUDGETS, measureImport, realshape, scale } from '../../../src/perf/import.js';

describe('import perf rows (§7.6 row 46)', () => {
  it('carries the three §8.5 budgets', () => {
    expect(IMPORT_PERF_BUDGETS.discoverP95Ms).toBe(1_500);
    expect(IMPORT_PERF_BUDGETS.planP95Ms).toBe(400);
    expect(IMPORT_PERF_BUDGETS.probeP95Ms).toBe(50);
  });

  it('realshape() builds the author’s shape in miniature and cleans up after itself', () => {
    const c = realshape({ slugs: 2, topicsPerSlug: 2, transcripts: 4, worktrees: 1, largestTranscriptBytes: 1024 });
    try {
      expect(existsSync(c.home)).toBe(true);
      expect(existsSync(c.workspace)).toBe(true);
      expect(c.counts.topics).toBe(4);
    } finally {
      c.cleanup();
    }
    expect(existsSync(c.home)).toBe(false);
  });

  it('scale(n) yields n classified candidates with overlapping token sets', () => {
    const cands = scale(8);
    expect(cands).toHaveLength(8);
    for (const c of cands) {
      expect(c.doc).toBeDefined();
      expect(c.item.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // the shared sentence means every pair overlaps, which is what the dedupe pass must survive
    const a = new Set(cands[0]!.doc!.tokens);
    const b = new Set(cands[1]!.doc!.tokens);
    const shared = [...a].filter((t) => b.has(t));
    expect(shared.length).toBeGreaterThan(3);
  });

  it('measureImport() runs all three rows end to end at a tiny size', async () => {
    const r = await measureImport({ reps: 2, planRows: 12, realShape: { slugs: 2, topicsPerSlug: 2, transcripts: 4, worktrees: 1, largestTranscriptBytes: 1024 } });
    expect(r.rows.map((x) => x.name)).toEqual(['discover', 'plan', 'probe']);
    for (const row of r.rows) {
      expect(row.raw).toHaveLength(2);
      expect(row.p95).not.toBeNull();
      expect(row.budgetMs).toBeGreaterThan(0);
    }
    expect(r.shape.planRows).toBe(12);
  });
});
