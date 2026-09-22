/**
 * Probe P2 `lane-run` (HARNESS-NEXT-DESIGN §5 Ring 0) — the gate wave S1's top lever is judged by, plus P2b
 * `sandbox-spawn`.
 *
 * The probes spawn real interpreters, so what is unit-tested here is the part a wave could be waved through on:
 * the gate arithmetic. A missing warm arm must read `pending`, never `pass`; a warm arm that answers differently
 * from the cold arm must fail at any speed (§8 R-1 — that is the false-pass channel, not a slow lane); and the
 * ≥ 2× bar must be exactly the bar (§6 S1: "dropped, not softened"). The spawn probe is report-only by
 * construction, which is also asserted, because §5 says a pool measured against a 2.8 ms floor proves nothing.
 */
import { describe, expect, it } from 'vitest';

import { WARM_SPEEDUP_GATE, laneGate, type LaneSeries } from '../../../src/perf/lane-run.js';
import { measureSandboxSpawn } from '../../../src/perf/sandbox-spawn.js';

const series = (arm: string, p50: number, disagreements = 0): LaneSeries => ({ arm, samples: [p50], p50, p95: p50, disagreements });

describe('the lane-run gate', () => {
  it('is pending, never pass, while no warm runner exists', () => {
    const v = laneGate(series('cold', 80), null, 10);
    expect(v.gate).toBe('pending');
    expect(v.speedup).toBeNull();
    expect(v.note).toContain('src/sandbox/pool.ts');
  });

  it('passes at the bar and fails just under it', () => {
    expect(laneGate(series('cold', 80), series('warm', 40), 10).gate).toBe('pass');
    expect(laneGate(series('cold', 80), series('warm', 40.1), 10).gate).toBe('FAIL');
    expect(laneGate(series('cold', 80), series('warm', 40), 10).speedup).toBeCloseTo(WARM_SPEEDUP_GATE, 6);
  });

  it('fails a warm arm that disagreed with the cold exit code, however fast it was (§8 R-1)', () => {
    const v = laneGate(series('cold', 80), series('warm', 2, 1), 10);
    expect(v.gate).toBe('FAIL');
    expect(v.speedup).toBeNull();
    expect(v.note).toContain('dropped, not softened');
  });

  it('fails rather than divides by zero when an arm produced no usable p50', () => {
    expect(laneGate(series('cold', 80), { arm: 'warm', samples: [], p50: null, p95: null, disagreements: 0 }, 10).gate).toBe('FAIL');
  });
});

describe('the sandbox-spawn probe', () => {
  it('measures the wrapper and is report-only (§5: it is never a gate)', async () => {
    const r = await measureSandboxSpawn({ runs: 2 });
    expect(r.pass).toBe(true);
    expect(r.bare.samples).toHaveLength(2);
    expect(r.bare.p50).toBeGreaterThan(0);
    // on darwin the seatbelt arm runs and the wrapper cost is the difference; elsewhere both are null
    if (r.seatbelt !== null) {
      expect(r.seatbelt.level).toBe('seatbelt');
      expect(r.wrapperMs).not.toBeNull();
    } else {
      expect(r.wrapperMs).toBeNull();
    }
  }, 30_000);
});
