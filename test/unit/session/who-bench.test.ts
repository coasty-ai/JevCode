/**
 * TUI-DESIGN-5 gate **G-R5-4** / §7 row 88 / §10 (slot R5-1): `/who` builds in **< 20 ms** over a 200-row fold,
 * and the status zone's data source in **< 1 ms**. Neither is on the per-frame path more than once per fold change.
 *
 * `peerZoneText` itself is R5-2's (`src/tui/status/lines.ts`); the half this slot owns and can measure today is
 * `peerViewOf`, which is what that segment reads, so the `< 1 ms` half is measured on it. The file lives under
 * `test/unit/session/**` (R5-1's §9.1 cell) rather than `test/unit/perf/**`, which §9.1 gives to no round-5 slot;
 * it needs no pty and no network, so the `unit` project is the right home.
 */
import { describe, expect, it } from 'vitest';
import { emptyFold } from '../../../src/coordination/fold.js';
import { listSessions, type Fold, type Heartbeat, type Liveness } from '../../../src/coordination/index.js';
import { activityView, peerViewOf, whoRows } from '../../../src/session/peers.js';
import { DEV_A, T0, TRUSTED, iso, makeHeartbeat, makeLease, makeSelf, runId } from '../coordination/helpers.js';
import { GLYPHS } from '../../../src/tui/glyphs.js';
import type { SessionActivityView } from '../../../src/core/types.js';

const NOW = { wallMs: T0, monoMs: 1_000_000 };
const SELF_ID = makeSelf({ hostKey: 'deadbeefcafe1234' });

/** 200 rows: 160 live, 30 gone, 10 forks, a quarter of them bench, each with two leases (§7 row 88's fold). */
function bigFold(rows: number): Fold {
  const fold = emptyFold(NOW);
  for (let i = 0; i < rows; i++) {
    const rid = runId(i + 1);
    const deviceId = `dev${String(i % 12).padStart(5, '0')}`;
    const bench = i % 4 === 0;
    const hb: Heartbeat = makeHeartbeat({
      deviceId,
      label: `peer-${i % 12}`,
      pid: 1000 + i,
      runId: rid,
      startedAt: iso(T0 - 60_000 - i * 1_000),
      touched: { step: 7, files: ['src/loop/engine.ts', 'src/tui/App.tsx'] },
      subwork: [
        { kind: 'lane', id: 'l1', since: iso(T0), stage: 'execute', detail60: '' },
        { kind: 'sample', id: 's1', since: iso(T0), stage: 'propose', detail60: '' },
        { kind: 'sample', id: 's2', since: iso(T0), stage: 'propose', detail60: '' },
      ],
      ...(bench ? { kind: 'bench' as const, bench: { benchId: `bench-${i}`, tasks: { live: 4, done: 12, total: 30 }, lanes: 8, spendUsd: 1 } } : {}),
    });
    const verdict: Liveness = i < rows * 0.8 ? 'live' : i < rows * 0.95 ? 'gone' : 'stale';
    fold.origins.set(`${deviceId}/${rid}`, TRUSTED);
    fold.liveness.set(`${deviceId}/${rid}/${hb.pid}`, verdict);
    const withArrival = { ...hb, arrivalMono: NOW.monoMs - 2_000 };
    if (verdict === 'live') fold.live.set(rid, withArrival);
    else fold.gone.set(rid, { ...withArrival, goneAtMono: NOW.monoMs - 120_000 });
    for (let l = 0; l < 2; l++) fold.leases.set(`${rid}-${l}`, makeLease({ leaseId: `${rid}-${l}`, runId: rid, deviceId, type: l === 0 ? 'exclusive' : 'intent' }));
  }
  fold.origins.set(`${DEV_A}/${SELF_ID.runId ?? ''}`, { self: true, source: null, authenticated: true });
  return fold;
}

function bestOf(n: number, fn: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

describe('G-R5-4 — /who over a 200-row fold', () => {
  const fold = bigFold(200);
  const self = { deviceId8: DEV_A, label: 'mbp', sameDeviceCount: 1 };

  it('the fold really carries 200 rows of two shapes', () => {
    const rows = listSessions(fold, SELF_ID, { all: true });
    expect(rows.length).toBe(200);
    expect(rows.filter((r) => r.kind === 'bench').length).toBe(50);
    expect(fold.leases.size).toBe(400);
  });

  it('builds in < 20 ms at 120 columns — the whole chain: listSessions → activityView → whoRows', () => {
    let built: unknown[] = [];
    const ms = bestOf(9, () => {
      const views: SessionActivityView[] = listSessions(fold, SELF_ID, { all: true }).map(activityView);
      built = whoRows(views, self, { width: 120, g: GLYPHS.unicode, all: true });
    });
    process.stdout.write(`[measured] /who over a 200-row fold: best of 9 = ${ms.toFixed(2)} ms (gate G-R5-4: < 20 ms), ${built.length} block rows\n`);
    expect(built.length).toBeGreaterThanOrEqual(200);
    expect(ms).toBeLessThan(20);
  });

  it('the two mappers alone are the cheap half (`activityView` × 200 well under the same budget)', () => {
    const activities = listSessions(fold, SELF_ID, { all: true });
    const ms = bestOf(9, () => {
      for (const a of activities) activityView(a);
    });
    process.stdout.write(`[measured] activityView × 200: best of 9 = ${ms.toFixed(2)} ms\n`);
    expect(ms).toBeLessThan(20);
  });

  it('`peerViewOf` — the status zone’s data source — is < 1 ms over the same fold (the `peerZoneText` half is R5-2’s)', () => {
    let v = peerViewOf(fold, SELF_ID);
    const ms = bestOf(25, () => {
      v = peerViewOf(fold, SELF_ID);
    });
    process.stdout.write(`[measured] peerViewOf over a 200-row fold: best of 25 = ${ms.toFixed(3)} ms (gate G-R5-4: < 1 ms)\n`);
    expect(v.live + v.stale).toBe(200);
    expect(ms).toBeLessThan(1);
  });

  it('every width the block ladder uses stays inside the budget (40 / 80 / 120)', () => {
    const views = listSessions(fold, SELF_ID, { all: true }).map(activityView);
    for (const width of [40, 80, 120]) {
      const ms = bestOf(5, () => {
        whoRows(views, self, { width, g: GLYPHS.unicode });
      });
      expect(ms, `${width} columns`).toBeLessThan(20);
    }
  });
});
