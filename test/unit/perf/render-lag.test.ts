/**
 * `src/perf/render-lag.ts` pure parts: the child's `LAG_JSON` parser, the probe-floor calibration (`baselineFrom`,
 * `netLagP95`, `lagVerdict`: the gate is on the p95 net of the floor's median, raw when the floor is unusable, max
 * always raw) and the geometry label; plus a real run of the baseline probe source itself.
 */
import { describe, expect, it } from 'vitest';
import { BASELINE_SECONDS, LAG_MAX_MS, LAG_P95_MS, LAG_PROBE_SOURCE, baselineFrom, describeGeometry, lagVerdict, measureLagBaseline, netLagP95, parseLag, type LagBaseline } from '../../../src/perf/render-lag.js';
import type { LagGeometry } from '../../../src/perf/render-lag.js';

const floor: LagBaseline = { seconds: 17, samples: 1300, p50: 1.83, p95: 2.08, max: 2.71, ok: true };
const noisy: LagBaseline = { seconds: 17, samples: 1300, p50: 4.1, p95: 6.2, max: 9, ok: false };

describe('parseLag / baselineFrom', () => {
  it('reads LAG_JSON out of a capture and marks a floor usable only when its p95 is under the gate', () => {
    expect(parseLag('noise LAG_JSON={"p50":1.8,"p95":2.1,"max":2.7,"samples":1300} tail')).toEqual({ p50: 1.8, p95: 2.1, max: 2.7, samples: 1300 });
    expect(parseLag('no probe output')).toBeNull();
    expect(parseLag('LAG_JSON={"p50":null,"p95":null,"max":0,"samples":0}')).toEqual({ p50: null, p95: null, max: 0, samples: 0 });
    expect(baselineFrom({ p50: 1.8, p95: 2.1, max: 2.7, samples: 1300 }, 17)).toEqual({ seconds: 17, samples: 1300, p50: 1.8, p95: 2.1, max: 2.7, ok: true });
    expect(baselineFrom({ p50: 4.1, p95: LAG_P95_MS, max: 9, samples: 1300 }, 17).ok).toBe(false);
    expect(baselineFrom(null, 17)).toEqual({ seconds: 17, samples: 0, p50: null, p95: null, max: null, ok: false });
  });
});

describe('netLagP95 / lagVerdict', () => {
  it('subtracts the floor median from the raw p95, never below 0, and leaves the raw value when the floor is unusable', () => {
    expect(netLagP95(4.98, floor)).toBeCloseTo(3.15, 5);
    expect(netLagP95(1.0, floor)).toBe(0);
    expect(netLagP95(null, floor)).toBeNull();
    expect(netLagP95(4.98, noisy)).toBe(4.98);
  });
  it('gates net p95 < 5 ms and raw max < 50 ms, and needs samples', () => {
    expect(lagVerdict({ p50: 2.03, p95: 5.35, max: 17.37, samples: 1354 }, floor)).toEqual({ netP95: expect.closeTo(3.52, 5) as number, ok: true });
    expect(lagVerdict({ p50: 2.03, p95: 5.35, max: 17.37, samples: 1354 }, noisy)).toEqual({ netP95: 5.35, ok: false });
    expect(lagVerdict({ p50: 2.03, p95: 6.9, max: 17.37, samples: 1354 }, floor).ok).toBe(false);
    expect(lagVerdict({ p50: 2.03, p95: 4.0, max: LAG_MAX_MS, samples: 1354 }, floor).ok).toBe(false);
    expect(lagVerdict({ p50: null, p95: null, max: 0, samples: 0 }, floor)).toEqual({ netP95: null, ok: false });
    expect(lagVerdict(null, floor)).toEqual({ netP95: null, ok: false });
  });
  it('describeGeometry names the rows, reduced motion and the stress profile', () => {
    const g = { rows: 40, reducedMotion: false, profile: 'realistic' } as LagGeometry;
    expect(describeGeometry(g)).toBe('rows 40');
    expect(describeGeometry({ ...g, reducedMotion: true })).toBe('rows 40 reduced motion');
    expect(describeGeometry({ ...g, profile: 'stress' })).toBe('rows 40 stress');
  });
});

describe('measureLagBaseline (the probe source runs in a bare node)', () => {
  it('prints LAG_JSON after the requested seconds with samples of a 10 ms interval', async () => {
    expect(LAG_PROBE_SOURCE).toContain("'LAG_JSON='");
    expect(BASELINE_SECONDS).toBe(17);
    const b = await measureLagBaseline(1.2);
    // 1.2 s minus the 500 ms warm-up at a 10 ms interval: about 70 samples; the floor is machine-dependent, only its shape is asserted
    expect(b.seconds).toBe(1.2);
    expect(b.samples).toBeGreaterThan(40);
    expect(b.p50).not.toBeNull();
    expect(b.p95).not.toBeNull();
    expect(b.max).not.toBeNull();
    expect(b.p50!).toBeLessThanOrEqual(b.p95!);
    expect(b.p95!).toBeLessThanOrEqual(b.max!);
  }, 15_000);
});
