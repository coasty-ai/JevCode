/**
 * `src/perf/readme.ts`: the README Performance section is generated from a `PerfResult` — the failing-gate list, the
 * table rows (shared with the console table), the section text, and the in-place replacement that touches only the
 * `## Performance` section of a README. The render-lag fixture has the three realistic-rate geometries (gated) and the
 * stress row (lag and frame rate reported only); the composer fixture has the six series.
 *
 * Plus the guard on the write path itself (F01): `updateReadmePerformance` rewrites the `## Performance` section of
 * whatever file it is handed, and `jevcode perf` used to hand it `<cwd>/README.md` on the strength of `!partial`
 * alone — which says which probes were *asked for*, never whose README this is. `rewriteReadmePerformance` is the
 * only caller in the command, and it writes nothing outside a JevCode checkout.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { PerfResult } from '../../../src/perf/main.js';
import { README_NOT_A_CHECKOUT, isJevCodeCheckout, rewriteReadmePerformance } from '../../../src/perf/main.js';
import type { LagGeometry } from '../../../src/perf/render-lag.js';
import type { ComposerSeries } from '../../../src/perf/composer-latency.js';
import type { IntakeSeries } from '../../../src/perf/intake-latency.js';
import type { IdleGeometry } from '../../../src/perf/idle-frames.js';
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
    splashFrames: 14,
    splashStaticFrames: 1,
    splashKeyFrames: 0,
    splashWordmarkFrames: 13,
    splashWindowMs: 700,
    splashInFirstFrame: true,
    splashGate: 22,
    splashOk: true,
    runStartFrames: 19,
    runStartGate: 31,
    runStartOk: true,
    frameClasses: { static: 180, key: 150, dynamic: 70 },
    regionMax: rows - 2,
    // TUI-DESIGN-4 §11's two new measured rows: zero in a healthy capture
    esc3J: 0,
    tallFrames: 0,
    tallFrameMax: 0,
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

/** an intake series (TUI-DESIGN-2 §3.12): 20 messages, bubble and reply frames located for every one */
function intake(name: IntakeSeries['name'], over: Partial<IntakeSeries> = {}): IntakeSeries {
  return {
    name,
    rows: 24,
    columns: 80,
    jevMs: 0,
    messages: 20,
    dropped: 0,
    bubble: { samples: 20, p50: 4.1, p95: 7.2, max: 9.9, raw: [] },
    reply: { samples: 20, p50: 4.1, p95: 7.2, max: 9.9, raw: [] },
    replyNet: { samples: 20, p50: 4.1, p95: 7.2, max: 9.9, raw: [] },
    thinkingSeen: 0,
    runsStarted: 0,
    clears: 0,
    regionMax: 6,
    exitCode: 0,
    timedOut: false,
    bubbleOk: true,
    replyOk: true,
    hygieneOk: true,
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
      series: [
        { command: 'chat', rows: 24, columns: 80, cold: { runs: [110, 112], median: 111, p95: 112 }, warm: { runs: [90], median: 90, p95: 90 }, slowest: null, clean: true, wordmarkExpected: true, wordmarkRuns: 3, splashOk: true, timeOk: true, pass: true },
        { command: 'chat', rows: 8, columns: 40, cold: { runs: [108], median: 108, p95: 108 }, warm: { runs: [89], median: 89, p95: 89 }, slowest: null, clean: true, wordmarkExpected: false, wordmarkRuns: 0, splashOk: true, timeOk: true, pass: true },
      ],
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
      // docs/COORDINATION-DESIGN.md §8.9 / §8.3: the relaxed context's rows
      promptBuildMs: [1.1, 1.4],
      promptBuildP50: 1.1,
      promptBuildP95: 1.4,
      promptBuildGateMs: 5,
      promptBuildWithinGate: true,
      coldPromptBuildMs: 8.2,
      coldGateMs: 25,
      coldWithinGate: true,
      recentSteps: { whole: 2, clipped: 4, oneLine: 6, reads: 3 },
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
      timeline: null,
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
        series('idle-loop', { latency: { samples: 200, p50: 2.4, p95: 4.1, max: 9.8, raw: [] }, frameClasses: { static: 1, key: 200, dynamic: 14 } }),
        series('live', { stepMs: 200, fpsMax: 45, fpsStaticMax: 15, fpsKeyMax: 10, fpsDynamicMax: 32, fpsExercised: true, fpsGated: true, fpsOk: false, pass: false, regionMax: 22, stepSeen: 90 }),
        series('live-stress', { stepMs: 0, stress: true, gated: false, latency: { samples: 200, p50: 2.5, p95: 8, max: 12.5, raw: [] }, fpsMax: 151, fpsStaticMax: 103, fpsKeyMax: 10, fpsDynamicMax: 48, fpsExercised: true, fpsGated: false, fpsOk: false, regionMax: 22, stepSeen: 740 }),
        series('palette', { regionMax: 11 }),
        series('review', { cursorGated: false, cursorFramesWithoutShow: 206 }),
        series('burst30', { spacingMs: 30, spacingMeasuredMs: 30.01, keysPerSecond: 33.3, fpsMax: 34, fpsKeyMax: 34, fpsDynamicMax: 1, fpsExercised: true, fpsGated: true, gated: false }),
      ],
      deviations: ['200 keys per series'],
      pass: false,
    },
    intakeLatency: {
      gateBubbleMs: 16,
      gateReplyMs: 40,
      series: [intake('mock0'), intake('mock150', { jevMs: 150, reply: { samples: 20, p50: 158.2, p95: 163.4, max: 170.1, raw: [] }, replyNet: { samples: 20, p50: 8.2, p95: 13.4, max: 20.1, raw: [] }, thinkingSeen: 20 })],
      deviations: ['the live gate is the S6 scenario'],
      pass: true,
    },
    // TUI-DESIGN-4 §11 / D-S: the fullscreen scroll probe is not part of this fixture's board
    scrollLatency: null,
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
    idleFrames: {
      fpsPeakGate: 4,
      fpsMeanGate: 2,
      bytesPeakGate: 12 * 1024,
      bytesMeanGate: 5 * 1024,
      windowMs: { from: 1000, to: 31_000 },
      geometries: [idle(24, 80), idle(40, 120, { bytesMax: 11_400, bytesMean: 4400, frameBytesMax: 2850 })],
      deviations: ['the CPU figure is reported'],
      pass: true,
    },
    jevLatency: null,
    // §5 Ring 0 probes: opt-in, never in a release result (a named Ring-0 probe makes the run `partial`)
    laneRun: null,
    sandboxSpawn: null,
    pass: false,
  };
}

/** an idle-frames geometry (TUI-DESIGN-3 §3.9): the design pass — 48 dynamic frames over 30 s, peak 4, mean 1.6 */
function idle(rows: number, columns: number, over: Partial<IdleGeometry> = {}): IdleGeometry {
  return {
    rows,
    columns,
    wordmark: 'sweep',
    settleAt: 562,
    seconds: 30,
    frames: 66,
    dynamicFrames: 48,
    fpsMax: 4,
    fpsMean: 1.6,
    buckets: Array.from({ length: 30 }, (_, i) => (i % 10 >= 5 && i % 10 < 9 ? 4 : 0)),
    bytesMax: 8600,
    bytesMean: 3400,
    frameBytesMax: 2150,
    wordmarkFrames: 48,
    staticFrames: 0,
    clears: 0,
    regionMax: rows - 13,
    cpu: { startMs: 350, endMs: 890, deltaMs: 540, perSecondMs: 18 },
    exitCode: 0,
    timedOut: false,
    fpsOk: true,
    bytesOk: true,
    hygieneOk: true,
    pass: true,
    ...over,
  };
}

describe('failures()', () => {
  it('names every failing gate and only those: the stress row and live-stress series never count, hygiene always does', () => {
    expect(failures(result())).toEqual(['event-loop lag (rows 40)', 'dynamic frame rate (rows 12)', 'composer live (dynamic frame rate)']);
    const r = result();
    r.renderLag!.stress = geometry(40, { profile: 'stress', stepMs: 0, gated: false, clears: 1, hygieneOk: false, pass: false });
    expect(failures(r)).toContain('render-lag hygiene (rows 40 stress)');
    expect(failures(r)).not.toContain('event-loop lag (rows 40 stress)');
    // TUI-DESIGN-2 §9: the splash bucket and the intake series are gates of their own
    r.renderLag!.rows40Reduced = geometry(40, { reducedMotion: true, splashFrames: 35, splashOk: false, pass: false });
    r.intakeLatency!.series[1] = intake('mock150', { jevMs: 150, replyOk: false, pass: false });
    expect(failures(r)).toContain('splash frame count (rows 40 reduced motion)');
    expect(failures(r)).toContain('intake latency (mock150)');
    // TUI-DESIGN-2 §9 row 1: "the first frame is splash frame 0" is a gate of the first-frame probe, named apart from the time gate
    const ff = result();
    ff.firstFrame!.series[0] = { ...ff.firstFrame!.series[0]!, wordmarkRuns: 2, splashOk: false, pass: false };
    ff.firstFrame!.pass = false;
    expect(failures(ff)).toContain('first frame (splash frame 0)');
    expect(failures(ff)).not.toContain('first frame');
    ff.firstFrame!.series[1] = { ...ff.firstFrame!.series[1]!, clean: false, timeOk: false, pass: false };
    expect(failures(ff)).toContain('first frame');
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
    // TUI-DESIGN-3 §9: the `idle-loop` series sits between `idle` and `live`
    expect(by('Frames per second while typing, busiest bucket, `static` · `key` · `dynamic` (`idle`')).toMatchObject({ result: '0 · 10 · 0 n/e / 0 · 10 · 0 n/e / 15 · 10 · 32 / 103 · 10 · 48 (report) / 0 · 10 · 0 n/e / 0 · 10 · 0 n/e / 0 · 34 · 1', status: 'FAIL' });
    expect(by('Composer series hygiene')).toMatchObject({ result: '0 · 5 · 0 / 0 · 5 · 0 / 0 · 22 · 0 / 0 · 22 · 0 / 0 · 11 · 0 / 0 · 5 · 206 (report) / 0 · 5 · 0', status: 'pass' });
    expect(by('(`idle-loop`:')).toMatchObject({ result: '2.4 ms / 4.1 ms / 9.8 ms', gate: 'p95 < 16 ms, max < 50 ms', status: 'pass' });
    // TUI-DESIGN-3 §3.9 / §9: the idle animation rows and the run-start bucket
    expect(by('Idle animation — `dynamic` frames per second')).toMatchObject({ result: '4 · 1.6 / 4 · 1.6', gate: expect.stringContaining('≤ 4 in every second · mean ≤ 2/s'), status: 'pass' });
    expect(by('Idle animation bytes')).toMatchObject({ result: '8600 · 3400 · 2150 B / 11400 · 4400 · 2850 B', status: 'pass' });
    expect(by('Idle animation hygiene')).toMatchObject({ result: '0 · 11 · 48 · 540 ms (18.0 ms/s) / 0 · 27 · 48 · 540 ms (18.0 ms/s)', status: 'pass' });
    expect(by('Run-start bucket')).toMatchObject({ result: '19 / 19 / 19 / 19', gate: expect.stringContaining('≤ maxFps + 1 = 31'), status: 'pass' });
    expect(by('`resize-live` 40×120 (typist)')).toMatchObject({ result: '0 (0) · 1 (1) · 0 (0) · 0 (0) · 0 · 1 (+2.1 ms) · 10', status: 'pass' });
    expect(by('Ctrl+L repaint')).toMatchObject({ result: 'true (1 frame)', status: 'pass' });
    // TUI-DESIGN-2 §5 / §9: splash frame 0 per first-frame series, the splash bucket per lag geometry, the intake rows
    expect(by('Splash frame 0 is the first frame')).toMatchObject({ result: '3/3 · 0/2 (flat, none expected)', gate: expect.stringContaining('TUI-DESIGN-2 §9 row 1'), status: 'pass' });
    // the splash bucket row: `dynamic` · `static` · `key` · wordmark · first frame, gated at ⌈31 × 0.7⌉ = 22 dynamic frames; a clipped window is named
    expect(by('Splash bucket')).toMatchObject({ result: '14 · 1 · 0 · 13 · true / 14 · 1 · 0 · 13 · true / 14 · 1 · 0 · 13 · true / 14 · 1 · 0 · 13 · true', gate: '`dynamic` ≤ ⌈(maxFps + 1) × 0.7⌉ = 22 (realistic geometries; stress reported)', status: 'pass' });
    const clipped = result();
    clipped.renderLag!.stress = geometry(40, { profile: 'stress', gated: false, splashFrames: 9, splashKeyFrames: 2, splashWindowMs: 420, splashGate: 14 });
    clipped.firstFrame!.series[0] = { ...clipped.firstFrame!.series[0]!, splashOk: false, pass: false };
    const rows2 = resultRows(clipped);
    expect(rows2.find((r) => r.measurement.includes('Splash bucket'))!.result).toBe('14 · 1 · 0 · 13 · true / 14 · 1 · 0 · 13 · true / 14 · 1 · 0 · 13 · true / 9 · 1 · 2 · 13 · true (window 420 ms)');
    expect(rows2.find((r) => r.measurement.includes('Splash frame 0 is the first frame'))!.status).toBe('FAIL');
    expect(by('Intake reply latency, `mock0`')).toMatchObject({ measurement: expect.stringContaining('20 greetings and tool questions, 20 located, 24×80'), result: '4.1 ms / 7.2 ms / 9.9 ms · 4.1 ms / 7.2 ms / 9.9 ms', gate: expect.stringContaining('bubble p95 < 16 ms · reply p95 ≤ 40 ms'), status: 'pass' });
    const dropped = result();
    dropped.intakeLatency!.series[0] = intake('mock0', { dropped: 1, reply: { samples: 19, p50: 4.1, p95: 7.2, max: 9.9, raw: [] }, bubble: { samples: 19, p50: 4.1, p95: 7.2, max: 9.9, raw: [] }, bubbleOk: false, replyOk: false, pass: false });
    expect(resultRows(dropped).find((r) => r.measurement.includes('Intake reply latency, `mock0`'))).toMatchObject({ measurement: expect.stringContaining('19 located, 1 Enter not located'), status: 'FAIL' });
    expect(by('Intake reply latency, `mock150`')).toMatchObject({ measurement: expect.stringContaining('`JEVCODE_MOCK_JEV_MS=150`'), result: '4.1 ms / 7.2 ms / 9.9 ms · 158.2 ms / 163.4 ms / 170.1 ms (net p95 13.4 ms)', gate: expect.stringContaining('net of the delay'), status: 'pass' });
    expect(by('Intake hygiene')).toMatchObject({ result: '0 · 0 · 6 / 0 · 0 · 6', gate: '0 · 0 · ≤ 22', status: 'pass' });
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
    expect(s).toContain('Declared deviations from docs/TUI-DESIGN.md §18 and docs/TUI-DESIGN-2.md §9');
    expect(s).toContain('- 200 keys per series');
    expect(s).toContain('- the lag window is the whole session');
    expect(s).toContain('- the live gate is the S6 scenario');
    expect(s).toContain("the startup splash's frame 0");
    expect(s).toContain('3/3 first frames at the');
    expect(s).toContain('gated per series (TUI-DESIGN-2 §9 row 1): every series as designed');
    expect(s).toContain('the typist lets the splash settle for 800 ms before its first key');
    expect(s).toContain('Intake reply latency (TUI-DESIGN-2 §3.12): 20 greetings');
    expect(s).toContain('read p95 7.2 ms at 0 ms and 7.2 ms with the mock delayed 150 ms');
    expect(s).toContain('read p95 7.2 ms at 0 ms and 13.4 ms net of the delay');
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

describe('rewriteReadmePerformance() writes only inside a JevCode checkout (F01)', () => {
  const temps: string[] = [];
  const dir = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    temps.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Someone else's project, standing in the CWD when `jevcode perf` is typed. */
  const FOREIGN = ['# Some Other Project', '', 'intro', '', '## Performance', '', 'Handles 40k requests per second.', '', '## Licence', '', 'MIT', ''].join('\n');

  it('leaves a foreign README byte-identical and says why, even when the tree carries a bin/jevcode.js', () => {
    const root = dir('jevcode-perf-foreign-');
    writeFileSync(join(root, 'README.md'), FOREIGN);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'someone-elses-project', version: '9.9.9' }));
    // a vendored copy of the binary is not a checkout: `package.json` decides whose README this is
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'bin/jevcode.js'), '#!/usr/bin/env node\n');
    expect(isJevCodeCheckout(root)).toBe(false);

    const line = rewriteReadmePerformance(root, 'perf/results/latest.json', result());
    expect(line).toBe(README_NOT_A_CHECKOUT);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(FOREIGN);
  });

  it('leaves a README alone in a directory with no package.json and in one with no perf binary', () => {
    const bare = dir('jevcode-perf-bare-');
    writeFileSync(join(bare, 'README.md'), FOREIGN);
    expect(rewriteReadmePerformance(bare, 'out.json', result())).toBe(README_NOT_A_CHECKOUT);
    expect(readFileSync(join(bare, 'README.md'), 'utf8')).toBe(FOREIGN);

    const noBin = dir('jevcode-perf-nobin-');
    writeFileSync(join(noBin, 'README.md'), FOREIGN);
    writeFileSync(join(noBin, 'package.json'), JSON.stringify({ name: 'jevcode' }));
    expect(isJevCodeCheckout(noBin)).toBe(false);
    expect(rewriteReadmePerformance(noBin, 'out.json', result())).toBe(README_NOT_A_CHECKOUT);
    expect(readFileSync(join(noBin, 'README.md'), 'utf8')).toBe(FOREIGN);
  });

  it('rewrites the section in a real checkout, and reports a checkout README that has no such section', () => {
    const root = dir('jevcode-perf-checkout-');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(join(root, 'bin/jevcode.js'), '#!/usr/bin/env node\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'jevcode', version: '0.0.0-test' }));
    writeFileSync(join(root, 'README.md'), '# JevCode\n\n## Performance\n\nold table\n\n## Bench\n\nbench text\n');
    expect(isJevCodeCheckout(root)).toBe(true);

    expect(rewriteReadmePerformance(root, 'perf/results/latest.json', result())).toBe('README Performance section rewritten from perf/results/latest.json\n');
    const written = readFileSync(join(root, 'README.md'), 'utf8');
    expect(written).toContain('| Measurement | Result | Gate | Status |');
    expect(written).toContain('Measured 2026-09-21 (10:00Z)');
    // only that section moved
    expect(written.startsWith('# JevCode\n')).toBe(true);
    expect(written).toContain('\n## Bench\n\nbench text\n');
    expect(written).not.toContain('old table');

    writeFileSync(join(root, 'README.md'), '# JevCode\n\nno such section\n');
    expect(rewriteReadmePerformance(root, 'out.json', result())).toBe('README.md has no "## Performance" section; nothing rewritten\n');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# JevCode\n\nno such section\n');
  });
});

/**
 * C-06: the three cases above exercise the guarded helper, which is what F01 added — but nothing pinned that the
 * COMMAND still goes through it. Re-introducing `updateReadmePerformance(resolve(root, 'README.md'), result)` at
 * the call site, the exact regression F01 is about, left every one of them green.
 *
 * `measureAll` is not exported and its write path only runs after a complete release set of real pty probes, so
 * there is no in-process seam to assert against. The call site is a source fact, so it is asserted as one: the
 * only `updateReadmePerformance(` call in `src/perf/main.ts` is the one inside `rewriteReadmePerformance`, and
 * that function still refuses ahead of it.
 */
describe('the command reaches the README only through the guarded helper (C-06)', () => {
  const MAIN_TS = join(dirname(fileURLToPath(import.meta.url)), '../../../src/perf/main.ts');

  it('has exactly one updateReadmePerformance( call in src/perf/main.ts, inside rewriteReadmePerformance, behind the checkout guard', () => {
    const src = readFileSync(MAIN_TS, 'utf8');
    const from = src.indexOf('export function rewriteReadmePerformance(');
    expect(from, 'rewriteReadmePerformance must still be the guarded helper in src/perf/main.ts').toBeGreaterThan(-1);
    // a top-level function ends at the first `}` in column 0 after its header
    const close = src.indexOf('\n}\n', from);
    expect(close).toBeGreaterThan(from);
    const body = src.slice(from, close);

    const calls = [...src.matchAll(/updateReadmePerformance\s*\(/g)].map((m) => m.index ?? -1);
    expect(calls, 'the README writer must still be called: a vacuous pass here is the regression').toHaveLength(1);
    for (const at of calls) {
      const line = src.slice(0, at).split('\n').length;
      expect(at >= from && at < close, `src/perf/main.ts:${line} calls updateReadmePerformance( outside rewriteReadmePerformance — that is the unguarded write F01 removed`).toBe(true);
    }
    // and the refusal is still ahead of the call, not beside it
    expect(body).toContain('if (!isJevCodeCheckout(root)) return README_NOT_A_CHECKOUT;');
    expect(body.indexOf('isJevCodeCheckout')).toBeLessThan(body.indexOf('updateReadmePerformance('));
  });
});
