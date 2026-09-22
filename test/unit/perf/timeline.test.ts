/**
 * The per-step timing buckets of HARNESS-NEXT-DESIGN §4.4 (wave S0): occupancy vs summed time, the derived harness
 * remainder, the entry cap, contention between two runs in one process, and the rule that matters for the 50 ms
 * gate — a disabled recorder costs nothing and records nothing.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_ENTRIES_PER_STEP, TIMELINE_FILE, TimelineRecorder, bucketStats, commandLabel, formatTimeline, labelStats, timelineEnabled, writeTimelineFile } from '../../../src/perf/timeline.js';

/** a clock the test drives by hand, so the numbers are exact instead of nearly right */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('timeline recorder', () => {
  it('records a bucket as the union of its spans, keeps the summed time beside it, and derives the harness remainder', () => {
    const c = fakeClock();
    const r = new TimelineRecorder({ enabled: true, now: c.now });
    r.beginRun('run-1', 'llm-jev');
    r.beginStep(1);
    // two lanes overlapping: 0..60 and 20..80 — 80 ms of wall, 120 ms of busy
    const laneA = r.span('lane', 'python3');
    c.advance(20);
    const laneB = r.span('lane', 'python3');
    c.advance(40);
    laneA();
    c.advance(20);
    laneB();
    const jev = r.span('jev', 'propose');
    c.advance(10);
    jev();
    c.advance(10); // pure harness
    const step = r.endStep();
    expect(step).not.toBeNull();
    expect(step!.wallMs).toBe(100);
    expect(step!.buckets.lane).toEqual({ ms: 80, sumMs: 120, n: 2 });
    expect(step!.buckets.jev.ms).toBe(10);
    expect(step!.harnessMs).toBe(10);
    expect(step!.labels['jev:propose']).toEqual({ ms: 10, sumMs: 10, n: 1 });
    expect(step!.labels['lane:python3']?.n).toBe(2);
  });

  it('is inert while disabled: no steps, no entries, and span() is a no-op the caller can still call', () => {
    const r = new TimelineRecorder({ enabled: false });
    r.beginRun('run-1', 'jev-on');
    r.beginStep(1);
    const end = r.span('lane', 'python3');
    r.add('images', 12);
    end();
    expect(r.endStep()).toBeNull();
    expect(r.isEnabled()).toBe(false);
    expect(r.snapshot().steps).toEqual([]);
  });

  it('stops recording when a second run opens while the first still has a step open, rather than blending the two', () => {
    const r = new TimelineRecorder({ enabled: true, now: fakeClock().now });
    r.beginRun('run-1', 'llm-jev');
    r.beginStep(1); // still open: the two runs would interleave into one set of buckets
    r.beginRun('run-2', 'llm-jev');
    r.beginStep(1);
    expect(r.isEnabled()).toBe(false);
    expect(r.snapshot().contended).toBe(true);
    expect(r.endStep()).toBeNull();
  });

  it('keeps measuring a second run that starts after the first finished (a session host runs engines in sequence)', () => {
    const c = fakeClock();
    const r = new TimelineRecorder({ enabled: true, now: c.now });
    r.beginRun('run-1', 'llm-jev');
    r.beginStep(1);
    r.add('lane', 5, 'python3');
    r.endStep();
    r.endRun(); // what writeTimelineFile does once the snapshot is on disk
    r.beginRun('run-2', 'llm-jev');
    r.beginStep(1);
    r.add('lane', 7, 'python3');
    const step = r.endStep();
    expect(r.isEnabled()).toBe(true);
    expect(r.snapshot().contended).toBe(false);
    expect(r.snapshot().runId).toBe('run-2');
    expect(step?.buckets.lane.sumMs).toBe(7); // run 1's 5 ms did not leak in
    expect(r.snapshot().steps).toHaveLength(1);
  });

  it('caps the entry list per step and counts what it dropped (a QuixBugs step runs ~1,375 candidates)', () => {
    const c = fakeClock();
    const r = new TimelineRecorder({ enabled: true, now: c.now, maxEntries: 4 });
    r.beginRun('run-1', 'llm-jev');
    r.beginStep(1);
    for (let i = 0; i < 10; i++) r.add('lane', 1, 'python3');
    const step = r.endStep()!;
    expect(step.entries).toHaveLength(4);
    expect(step.droppedEntries).toBe(6);
    expect(step.buckets.lane.n).toBe(10);
    expect(MAX_ENTRIES_PER_STEP).toBeGreaterThan(4);
  });

  it('closes a span left open by a stage that threw, and ignores a span closed after its step', () => {
    const c = fakeClock();
    const r = new TimelineRecorder({ enabled: true, now: c.now });
    r.beginRun('run-1', 'llm-jev');
    r.beginStep(1);
    const leaked = r.span('sample', 'sample0');
    c.advance(30);
    const step1 = r.endStep()!;
    expect(step1.buckets.sample.ms).toBe(30);
    r.beginStep(2);
    c.advance(5);
    leaked(); // the late close belongs to a closed step: it must not touch step 2
    const step2 = r.endStep()!;
    expect(step2.buckets.sample.ms).toBe(0);
  });

  it('summarises buckets and labels, heaviest label first, and renders a table', () => {
    const c = fakeClock();
    const r = new TimelineRecorder({ enabled: true, now: c.now });
    r.beginRun('run-1', 'llm-jev');
    for (const step of [1, 2]) {
      r.beginStep(step);
      r.add('lane', 100, 'python3');
      r.add('jev', 5, 'propose');
      c.advance(200);
      r.endStep();
    }
    const snap = r.snapshot();
    const rows = bucketStats(snap);
    expect(rows.map((x) => x.bucket)).toEqual(['wall', 'lane', 'jev', 'harness']);
    expect(rows.find((x) => x.bucket === 'lane')?.p50).toBe(100);
    expect(labelStats(snap)[0]?.bucket).toBe('lane:python3');
    const text = formatTimeline(snap);
    expect(text).toContain('timeline run-1 llm-jev — 2 step(s)');
    expect(text).toContain('lane:python3');
  });

  it('writes the run timeline once, and never fails a run when it cannot', async () => {
    const c = fakeClock();
    const r = new TimelineRecorder({ enabled: true, now: c.now });
    r.beginRun('run-9', 'llm-jev');
    r.beginStep(1);
    r.add('images', 7, 'pre');
    c.advance(9);
    r.endStep();
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-timeline-'));
    dirs.push(dir);
    await writeTimelineFile(dir, r);
    const written = JSON.parse(readFileSync(join(dir, TIMELINE_FILE), 'utf8')) as { runId: string; steps: { buckets: { images: { ms: number } } }[] };
    expect(written.runId).toBe('run-9');
    expect(written.steps[0]?.buckets.images.ms).toBe(7);
    await expect(writeTimelineFile(join(dir, 'does', 'not', 'exist'), r)).resolves.toBeUndefined();
  });

  it('labels a command by argv0, and a git spawn by its subcommand', () => {
    expect(commandLabel('python3 -m pytest -q tests/test_x.py')).toBe('python3');
    expect(commandLabel('/usr/bin/env python3 run_tests.py gcd')).toBe('env');
    expect(commandLabel("LC_ALL=C git -c core.quotepath=false status --porcelain")).toBe('git-status');
    expect(commandLabel('git ls-files -z')).toBe('git-ls-files');
    expect(commandLabel('   ')).toBe('sh');
  });

  it('reads the switch from the environment, and is off unless it is set', () => {
    expect(timelineEnabled({})).toBe(false);
    expect(timelineEnabled({ JEVCODE_TIMELINE: '' })).toBe(false);
    expect(timelineEnabled({ JEVCODE_TIMELINE: '0' })).toBe(false);
    expect(timelineEnabled({ JEVCODE_TIMELINE: 'off' })).toBe(false);
    expect(timelineEnabled({ JEVCODE_TIMELINE: '1' })).toBe(true);
  });
});
