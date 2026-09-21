/**
 * `src/perf/readme.ts`: the README Performance section is generated from a `PerfResult` — the failing-gate list, the
 * table rows (shared with the console table), the section text, and the in-place replacement that touches only the
 * `## Performance` section of a README. The render-lag fixture has the three realistic-rate geometries (gated) and the
 * stress row (lag and frame rate reported only); the composer fixture has the six series.
 */
import { describe, expect, it } from 'vitest';
import type { PerfResult } from '../../../src/perf/main.js';
import type { LagGeometry } from '../../../src/perf/render-lag.js';
import type { ComposerSeries } from '../../../src/perf/composer-latency.js';
import { failures, performanceSection, replacePerformanceSection, resultRows } from '../../../src/perf/readme.js';

function geometry(rows: number, over: Partial<LagGeometry> = {}): LagGeometry {
  return {
    rows,
    columns: 120,
    reducedMotion: false,
    profile: 'realistic',
    stepMs: 200,
    gated: true,
    lagP50: 2.0,
    lagP95: 4.2,
    lagMax: 12.3,
    samples: 1400,
    lagNetP95: 2.4,
    lagOk: true,
    clears: 0,
    frames: 400,
    fpsMax: 40,
    fpsMean: 30,
    fpsStaticMax: 14,
    fpsKeyMax: 10,
    fpsDynamicMax: 20,
    throttleMs: 34,
    fpsGate: 31,
    fpsOk: true,
    frameClasses: { static: 180, key: 150, dynamic: 70 },
    regionMax: rows - 2,
    cursorHidesMaxPerFrame: 1,
    cursorFramesWithoutShow: 0,
    cursorShownAtEnd: true,
    typing: { samples: 150, p50: 3.2, p95: 6.5, max: 9.5, raw: [] },
    keysWhileLive: 150,
    stepsSeen: 70,
    stepsPerSecond: 4.6,
    staticRowsPerSecond: 21,
    mockSteps: 3000,
    exitCode: 0,
    timedOut: false,
    hygieneOk: true,
    pass: true,
    ...over,
  };
}

function series(name: ComposerSeries['name'], over: Partial<ComposerSeries> = {}): ComposerSeries {
  return {
    name,
    rows: 24,
    columns: 80,
    stepMs: null,
    stress: false,
    spacingMs: 100,
    spacingMeasuredMs: 100.02,
    keysPerSecond: 9.998,
    keys: 200,
    latency: { samples: 200, p50: 2.1, p95: 3.6, max: 5.4, raw: [] },
    frames: 206,
    fpsMax: 10,
    fpsMean: 9.8,
    fpsStaticMax: 0,
    fpsKeyMax: 10,
    fpsDynamicMax: 0,
    frameClasses: { static: 1, key: 200, dynamic: 5 },
    fpsGate: 31,
    fpsExercised: false,
    fpsGated: false,
    fpsOk: true,
    regionMax: 5,
    clears: 0,
    cursorHidesMaxPerFrame: 1,
    cursorFramesWithoutShow: 0,
    cursorGated: true,
    exitCode: 0,
    timedOut: false,
    stepSeen: 0,
    gated: true,
    pass: true,
    ...over,
  };
}

function result(): PerfResult {
  return {
    measuredAt: '2026-09-21T10:00:00.000Z',
    node: 'v22.23.2',
    machine: { cpus: 15, model: 'Apple M5 Pro', memGiB: 24, os: 'darwin 25.6.0' },
    load: { atStart: 1.5, atEnd: 1.9, waitedMs: 0, max: 8, quietMax: 2, quiet: true },
    foreignDrivers: ['18589 expect scripts/pty/drive.exp /tmp/jevpty/chat1.steps …'],
    probes: ['first-frame', 'step-overhead', 'static-append', 'render-lag', 'composer-latency', 'states'],
    partial: false,
    firstFrame: {
      gateMs: 300,
      series: [{ command: 'chat', rows: 24, columns: 80, cold: { runs: [110, 112], median: 111, p95: 112 }, warm: { runs: [90], median: 90, p95: 90 }, slowest: null, clean: true, pass: true }],
      breakdown: [{ command: 'chat', rows: 24, columns: 80, harnessMs: 111, mountedMs: 99.9, flushedMs: 103.7, bareNodeMs: 24.2 }],
      pass: true,
    },
    stepOverhead: {
      steps: 50,
      harnessMs: [],
      p50: 24.9,
      p95: 46.8,
      harnessRun: [44, 42.3, 43.3],
      harnessRunP50: 43.8,
      harnessRunP95: 46.8,
      harnessOtherP95: 26.1,
      imagesMs: [],
      imagesP50: 1.2,
      imagesP95: 20.0,
      imagesRunP95: 20.7,
      imagesTargetMs: 15,
      imagesWithinTarget: false,
      hashSkipped: true,
      artefactStep: 11,
      dirtyFiles: 50,
      dirtyBytes: 50 * 300 * 1024,
      pass: true,
      gateMs: 50,
    },
    staticAppend: { regions: [{ name: 'live22', rows: 24, columns: 80, regionRows: 22, lines: 60, frames: 60, appendFrameMedian: 2015, appendFrameMean: 2018, appendFrameMax: 2100, bytesPerLineMedian: 2015, bytesPerLineMean: 2018, bytesPerLineMax: 2100, bytesTotal: 121000 }], withinBudget: true, pass: true },
    renderLag: {
      clearReSelfTest: true,
      maxFps: 30,
      throttleMs: 34,
      realisticStepMs: 200,
      baseline: { seconds: 17, samples: 1300, p50: 1.8, p95: 2.1, max: 2.7, ok: true },
      rows40: geometry(40, { lagP95: 7.44, lagNetP95: 5.64, lagOk: false, pass: false }),
      rows12: geometry(12, { fpsDynamicMax: 33, fpsOk: false, pass: false }),
      rows40Reduced: geometry(40, { reducedMotion: true, fpsStaticMax: 12, fpsDynamicMax: 9 }),
      // the storm: over both gates, reported only; hygiene holds so it passes
      stress: geometry(40, { profile: 'stress', stepMs: 0, gated: false, lagP50: 0.65, lagP95: 5.5, lagNetP95: 3.7, lagMax: 15.9, lagOk: true, fpsMax: 169, fpsStaticMax: 116, fpsKeyMax: 10, fpsDynamicMax: 43, fpsOk: false, stepsPerSecond: 35, staticRowsPerSecond: 457, frames: 2072, frameClasses: { static: 1381, key: 150, dynamic: 541 }, pass: true }),
      deviations: ['the lag window is the whole session'],
      pass: false,
    },
    composerLatency: {
      gateP95Ms: 16,
      gateMaxMs: 50,
      maxFps: 30,
      throttleMs: 34,
      series: [
        series('idle'),
        series('live', { stepMs: 200, fpsMax: 45, fpsStaticMax: 15, fpsKeyMax: 10, fpsDynamicMax: 32, fpsExercised: true, fpsGated: true, fpsOk: false, pass: false, regionMax: 22, stepSeen: 90 }),
        series('live-stress', { stepMs: 0, stress: true, gated: false, latency: { samples: 200, p50: 2.5, p95: 8, max: 12.5, raw: [] }, fpsMax: 151, fpsStaticMax: 103, fpsKeyMax: 10, fpsDynamicMax: 48, fpsExercised: true, fpsGated: false, fpsOk: false, regionMax: 22, stepSeen: 740 }),
        series('palette', { regionMax: 11 }),
        series('review', { cursorGated: false, cursorFramesWithoutShow: 206 }),
        series('burst30', { spacingMs: 30, spacingMeasuredMs: 30.01, keysPerSecond: 33.3, fpsMax: 34, fpsKeyMax: 34, fpsDynamicMax: 1, fpsExercised: true, fpsGated: true, gated: false }),
      ],
      deviations: ['200 keys per series'],
      pass: false,
    },
    states: {
      clearReSelfTest: true,
      scenarios: [
        { name: 'review', rows: 24, columns: 80, driver: 'expect', exitCode: 0, expectedExit: 0, timedOut: false, segments: [{ label: 'whole', rows: 24, fromRows: 24, clears: 0, clearMatches: 0, allowed: 0, regionMax: 22, resizeAt: null, clearFramePainted: null, inFlightPaints: 0, inFlightMs: null, stalePaints: 0, budgetOk: true, frames: 27 }], clearsTotal: 0, clearMatchesTotal: 0, forbidden: 0, frames: 28, pass: true },
        {
          name: 'resize-live',
          rows: 40,
          columns: 120,
          driver: 'typist',
          exitCode: 0,
          expectedExit: 0,
          timedOut: false,
          segments: [
            { label: '→A (40→40 rows)', rows: 40, fromRows: 40, clears: 0, clearMatches: 0, allowed: 0, regionMax: 15, resizeAt: null, clearFramePainted: null, inFlightPaints: 0, inFlightMs: null, stalePaints: 0, budgetOk: true, frames: 20 },
            { label: '→B (40→12 rows)', rows: 12, fromRows: 40, clears: 1, clearMatches: 2, allowed: 1, regionMax: 10, resizeAt: 30000, clearFramePainted: 10, inFlightPaints: 1, inFlightMs: 2.1, stalePaints: 0, budgetOk: true, frames: 2 },
            { label: '→C (12→40 rows)', rows: 40, fromRows: 12, clears: 0, clearMatches: 0, allowed: 0, regionMax: 15, resizeAt: 37000, clearFramePainted: null, inFlightPaints: 0, inFlightMs: null, stalePaints: 0, budgetOk: true, frames: 2 },
            { label: 'after C (40 rows)', rows: 40, fromRows: 40, clears: 0, clearMatches: 0, allowed: 0, regionMax: 15, resizeAt: null, clearFramePainted: null, inFlightPaints: 0, inFlightMs: null, stalePaints: 0, budgetOk: true, frames: 4 },
          ],
          clearsTotal: 1,
          clearMatchesTotal: 2,
          forbidden: 0,
          frames: 29,
          pass: true,
        },
        { name: 'ctrl-l', rows: 24, columns: 80, driver: 'expect', exitCode: 0, expectedExit: 0, timedOut: false, segments: [], clearsTotal: 0, clearMatchesTotal: 0, forbidden: 0, frames: 27, repaintEqual: true, repaintFrames: 1, pass: true },
      ],
      notDriven: [],
      pass: true,
    },
    jevLatency: null,
    pass: false,
  };
}

describe('failures()', () => {
  it('names every failing gate and only those: the stress row and live-stress series never count, hygiene always does', () => {
    expect(failures(result())).toEqual(['event-loop lag (rows 40)', 'dynamic frame rate (rows 12)', 'composer live (dynamic frame rate)']);
    const r = result();
    r.renderLag!.stress = geometry(40, { profile: 'stress', stepMs: 0, gated: false, clears: 1, hygieneOk: false, pass: false });
    expect(failures(r)).toContain('render-lag hygiene (rows 40 stress)');
    expect(failures(r)).not.toContain('event-loop lag (rows 40 stress)');
  });
});

describe('resultRows()', () => {
  it('renders the shared table: harness margin, imagesMs as a report row, realistic-rate lag triple, the static · key · dynamic split, the stress row, hygiene quads, composer series and resize segments', () => {
    const rows = resultRows(result());
    const by = (needle: string) => rows.find((r) => r.measurement.includes(needle));
    expect(by('`run` steps alone')).toMatchObject({ result: '46.8 ms / 43.8 ms · 26.1 ms', status: '3.2 ms margin' });
    expect(by('`imagesMs` p95')).toMatchObject({ gate: expect.stringContaining('report only, not a gate'), status: 'above target (reported)' });
    expect(by('Event-loop lag while typing')).toMatchObject({ measurement: expect.stringContaining('`JEVCODE_MOCK_STEP_MS=200`'), result: '5.64 ms (7.44 ms) / 2.40 ms (4.20 ms) / 2.40 ms (4.20 ms)', gate: '< 5 ms net', status: 'FAIL' });
    expect(by('Lag probe idle floor')).toMatchObject({ result: '1.80 ms / 2.10 ms / 2.70 ms', status: 'applied' });
    expect(by('Event-loop lag, max, raw')).toMatchObject({ result: '12.30 ms / 12.30 ms / 12.30 ms', status: 'pass' });
    expect(by('Mocked run rate')).toMatchObject({ result: '4.6 · 21 / 4.6 · 21 / 4.6 · 21' });
    expect(by('split into `static` · `key` · `dynamic`')).toMatchObject({ result: '14 · 10 · 20 / 14 · 10 · 33 / 12 · 10 · 9', gate: expect.stringContaining('`dynamic` ≤ maxFps + 1 = 31'), status: 'FAIL' });
    expect(by('Stress row')).toMatchObject({ measurement: expect.stringContaining('35.0 steps/s, 457 `<Static>` rows/s'), result: '3.70 ms (5.50 ms) / 15.90 ms · 116 · 10 · 43', gate: expect.stringContaining('not gated'), status: 'over the realistic-rate gates (expected)' });
    expect(by('Terminal clears after the first frame')).toMatchObject({ result: '0 / 0 / 0 / 0', status: 'pass' });
    expect(by('Dynamic region, tallest painted')).toMatchObject({ result: '38 rows / 10 rows / 38 rows / 38 rows', status: 'pass' });
    expect(by('(`live`:')).toMatchObject({ measurement: expect.stringContaining('live run at `JEVCODE_MOCK_STEP_MS=200`'), gate: 'p95 < 16 ms, max < 50 ms', status: 'FAIL' });
    expect(by('(`live-stress`:')).toMatchObject({ measurement: expect.stringContaining('`JEVCODE_MOCK_STEP_MS=0`'), gate: expect.stringContaining('latency report only (the zero-latency storm)'), status: 'pass' });
    expect(by('(`burst30`:')).toMatchObject({ measurement: expect.stringContaining('33.3 keys/s achieved'), gate: expect.stringContaining('`dynamic` frame rate ≤ 31 gated'), status: 'pass' });
    expect(by('(`review`:')).toMatchObject({ measurement: expect.stringContaining('200/200 `e` toggles located') });
    expect(by('Frames per second while typing, busiest bucket, `static` · `key` · `dynamic` (`idle`')).toMatchObject({ result: '0 · 10 · 0 n/e / 15 · 10 · 32 / 103 · 10 · 48 (report) / 0 · 10 · 0 n/e / 0 · 10 · 0 n/e / 0 · 34 · 1', status: 'FAIL' });
    expect(by('Composer series hygiene')).toMatchObject({ result: '0 · 5 · 0 / 0 · 22 · 0 / 0 · 22 · 0 / 0 · 11 · 0 / 0 · 5 · 206 (report) / 0 · 5 · 0', status: 'pass' });
    expect(by('`resize-live` 40×120 (typist)')).toMatchObject({ result: '0 (0) · 1 (1) · 0 (0) · 0 (0) · 0 · 1 (+2.1 ms) · 10', status: 'pass' });
    expect(by('Ctrl+L repaint')).toMatchObject({ result: 'true (1 frame)', status: 'pass' });
    // no cell may break the Markdown table
    for (const r of rows) for (const v of [r.measurement, r.result, r.gate, r.status]) expect(v).not.toContain('|');
  });
});

describe('performanceSection() / replacePerformanceSection()', () => {
  it('writes the heading, the table, the measured line with the load rule and the outcome, the notes and the deviations', () => {
    const s = performanceSection(result());
    expect(s.startsWith('## Performance\n')).toBe(true);
    expect(s).toContain('| Measurement | Result | Gate | Status |');
    expect(s).toContain('Measured 2026-09-21 (10:00Z)');
    expect(s).toContain('a release number needs ≤ 2 at both ends — met here); 1 other pty driver process (other agents\' `drive.exp` / `pty_type.py` smokes) was alive at the start, listed under `foreignDrivers` in the JSON.');
    expect(s).toContain('**3 gates fail: event-loop lag (rows 40); dynamic frame rate (rows 12); composer live (dynamic frame rate)**');
    expect(s).toContain('paced by `JEVCODE_MOCK_STEP_MS=200`');
    expect(s).toContain('p50 1.80 ms, p95 2.10 ms, max 2.70 ms here');
    expect(s).toContain('5.64 ms / 2.40 ms / 2.40 ms net (7.44 ms / 4.20 ms / 4.20 ms raw');
    expect(s).toContain('4.6 / 4.6 / 4.6 mocked steps/s');
    expect(s).toContain('35.0 steps/s and 457 `<Static>` rows/s');
    expect(s).toContain('`isStaticDirty` → `onImmediateRender`');
    expect(s).toContain('14 · 10 · 20 / 14 · 10 · 33 / 12 · 10 · 9 static · key · dynamic');
    expect(s).toContain('Declared deviations from docs/TUI-DESIGN.md §18');
    expect(s).toContain('- 200 keys per series');
    expect(s).toContain('- the lag window is the whole session');
    expect(s).not.toContain('\n## Bench');
  });
  it('replaces only the Performance section of a README and reports a missing heading', () => {
    const readme = '# JevCode\n\nintro\n\n## Performance\n\nold table\n\nold notes\n\n## Bench\n\nbench text\n';
    const next = replacePerformanceSection(readme, '## Performance\n\nnew\n');
    expect(next).toBe('# JevCode\n\nintro\n\n## Performance\n\nnew\n\n## Bench\n\nbench text\n');
    expect(replacePerformanceSection('# JevCode\n\n## Performance\n\nlast section\n', '## Performance\n\nnew\n')).toBe('# JevCode\n\n## Performance\n\nnew\n');
    expect(replacePerformanceSection('# JevCode\n\nno such section\n', '## Performance\n')).toBeNull();
  });
});
