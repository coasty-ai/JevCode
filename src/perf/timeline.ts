/**
 * The per-step timing buckets and timeline of HARNESS-NEXT-DESIGN §4.4 / §6 S0 (wave S0).
 *
 * §4.1 states the measured problem in one line: "a step is not one cost, it is six queues", and only `synthMs` — the
 * whole synthesizer as a single number — is recorded today. This module is the missing breakdown. It records, per
 * step, the wall of each queue:
 *
 *   `lane`   — sandboxed process runs outside the execute stage: candidate verification, lane setup, `ast.parse`
 *              checks (queues 1 and 5 of §4.1). Labelled by argv0, so `git` spawns separate from `python3` ones.
 *   `sample` — generator wait (queue 2): the wall of `provider.generate`, one label per sample.
 *   `jev`    — decider wait (queue 3), one label per stage, which in §3.x is one label per router (`jevWaitMs`).
 *   `exec`   — the agent's own command, inside the execute stage; already `StepTiming.execMs`, recorded here so the
 *              buckets add up to the step's wall.
 *   `images` / `store` / `serialise` / `listing` — SUB-buckets of the harness (queue 6): they overlap `harnessMs`
 *              rather than partitioning the step, and exist because S0 owes a fix to the 50 ms gate and the fix has
 *              to be aimed at a measured contributor (§5 Ring 0, §8 R-4).
 *
 * `harnessMs = wall − lane − sample − jev − exec` mirrors the engine's own subtraction, so a timeline row is
 * comparable with `StepRecord.timing` without changing that contract (S0 may not touch `src/core/types.ts` this
 * round; the additive `StepTiming` fields of §4.4 are declared in `contract_changes` instead).
 *
 * Overlap is handled the way the design reads the numbers: a bucket's `ms` is the union (occupancy) of its spans, so
 * eight lanes running concurrently for 1 s contribute 1 s of lane wall, not 8 s; `sumMs` keeps the summed busy time
 * beside it, and `n` the count. That is what makes "`jevWaitMs` must stay ≈ 0" (§5) a checkable statement.
 *
 * Cost: disabled by default. With `JEVCODE_TIMELINE` unset every entry point is an early return and `span()` returns a
 * shared no-op, so the recorder cannot show up in the `step-overhead` gate (§8 R-4: new work is off the step or it
 * does not ship). Enabled, one span is two `performance.now()` calls and one object mutation; entries are capped at
 * `MAX_ENTRIES` per step with a dropped count, because a QuixBugs step runs ~1,375 candidates (§1.1).
 *
 * One recorder per process. A second run beginning while another is open (two engines in one process) sets
 * `contended` and stops recording rather than blending two runs into one table; the bench runs one task per worker
 * process, which is the shape this is for.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { percentile } from '../core/time.js';

export const TIMELINE_BUCKETS = ['lane', 'sample', 'jev', 'exec', 'images', 'store', 'serialise', 'listing'] as const;
export type TimelineBucket = (typeof TIMELINE_BUCKETS)[number];

/** the buckets that partition the step beside the harness remainder (the others are harness sub-buckets) */
export const TOP_LEVEL_BUCKETS: readonly TimelineBucket[] = ['lane', 'sample', 'jev', 'exec'];

export interface BucketTotal {
  /** union of the spans (occupancy): concurrent lanes count once */
  ms: number;
  /** summed busy time over the spans */
  sumMs: number;
  n: number;
}

export interface TimelineEntry {
  bucket: TimelineBucket;
  label: string;
  /** ms since the step began */
  atMs: number;
  ms: number;
}

export interface StepTimeline {
  step: number;
  wallMs: number;
  /** wall − lane − sample − jev − exec (the same subtraction `StepTiming.harnessMs` makes) */
  harnessMs: number;
  buckets: Record<TimelineBucket, BucketTotal>;
  /** `<bucket>:<label>` → total; this is "Jev wait per router" once the §3.x routers label their asks */
  labels: Record<string, BucketTotal>;
  entries: TimelineEntry[];
  droppedEntries: number;
}

export interface RunTimeline {
  runId: string;
  mode: string;
  steps: StepTimeline[];
  /** true when a second run opened while this one was recording: the numbers are not trustworthy and were dropped */
  contended: boolean;
}

export const MAX_ENTRIES_PER_STEP = 500;

export function timelineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['JEVCODE_TIMELINE'];
  return v !== undefined && v !== '' && v !== '0' && v !== 'off';
}

function emptyTotals(): Record<TimelineBucket, BucketTotal> {
  const out = {} as Record<TimelineBucket, BucketTotal>;
  for (const b of TIMELINE_BUCKETS) out[b] = { ms: 0, sumMs: 0, n: 0 };
  return out;
}

interface Open {
  depth: number;
  since: number;
}

const NOOP = (): void => undefined;

/**
 * The recorder. Every method is a no-op while disabled or between steps, so call sites need no `if` of their own —
 * `const end = stepTimeline.span('lane', 'python3'); … end();` is the whole idiom.
 */
export class TimelineRecorder {
  private enabled: boolean;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private runId: string | null = null;
  private mode = '';
  private contended = false;
  private steps: StepTimeline[] = [];
  private current: StepTimeline | null = null;
  private t0 = 0;
  private open = new Map<TimelineBucket, Open>();
  /** the stage the engine is in, used to attribute a process run to `exec` or `lane` */
  private stageName = '';

  constructor(opts: { enabled?: boolean; now?: () => number; maxEntries?: number } = {}) {
    this.enabled = opts.enabled ?? false;
    this.now = opts.now ?? ((): number => performance.now());
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES_PER_STEP;
  }

  isEnabled(): boolean {
    return this.enabled && !this.contended;
  }

  /** Open a run. A second open run marks the recorder contended and it records nothing further. */
  beginRun(runId: string, mode: string): void {
    if (!this.enabled) return;
    if (this.runId !== null && this.runId !== runId) {
      this.contended = true;
      this.current = null;
      return;
    }
    this.runId = runId;
    this.mode = mode;
    this.steps = [];
    this.current = null;
  }

  beginStep(step: number): void {
    if (!this.isEnabled() || this.runId === null) return;
    this.endStep();
    this.t0 = this.now();
    this.open.clear();
    this.current = { step, wallMs: 0, harnessMs: 0, buckets: emptyTotals(), labels: {}, entries: [], droppedEntries: 0 };
  }

  /** The engine's current stage name; a process run outside `execute` is lane work (§4.1 queues 1 and 5). */
  stage(name: string): void {
    this.stageName = name;
  }

  currentStage(): string {
    return this.stageName;
  }

  add(bucket: TimelineBucket, ms: number, label = ''): void {
    const cur = this.current;
    if (cur === null || !this.isEnabled() || !Number.isFinite(ms)) return;
    const d = Math.max(0, ms);
    const t = cur.buckets[bucket];
    t.ms += d;
    t.sumMs += d;
    t.n += 1;
    this.label(cur, bucket, label, d);
    this.entry(cur, bucket, label, d, this.now() - d);
  }

  /** Start a span; the returned function closes it. Safe to call while disabled (it returns the shared no-op). */
  span(bucket: TimelineBucket, label = ''): () => void {
    const cur = this.current;
    if (cur === null || !this.isEnabled()) return NOOP;
    const started = this.now();
    let o = this.open.get(bucket);
    if (o === undefined) {
      o = { depth: 0, since: started };
      this.open.set(bucket, o);
    }
    if (o.depth === 0) o.since = started;
    o.depth += 1;
    let closed = false;
    return (): void => {
      if (closed) return;
      closed = true;
      const end = this.now();
      const ms = Math.max(0, end - started);
      // the step may have been closed under a long span (an abort): the totals of a closed step stay as they were
      if (this.current !== cur) return;
      const t = cur.buckets[bucket];
      t.sumMs += ms;
      t.n += 1;
      const open = this.open.get(bucket);
      if (open !== undefined) {
        open.depth = Math.max(0, open.depth - 1);
        if (open.depth === 0) t.ms += Math.max(0, end - open.since);
      }
      this.label(cur, bucket, label, ms);
      this.entry(cur, bucket, label, ms, started);
    };
  }

  /** Measure an awaited call. */
  async measure<T>(bucket: TimelineBucket, label: string, fn: () => Promise<T>): Promise<T> {
    const end = this.span(bucket, label);
    try {
      return await fn();
    } finally {
      end();
    }
  }

  endStep(): StepTimeline | null {
    const cur = this.current;
    if (cur === null) return null;
    const end = this.now();
    // close any span still open (a stage that threw): the bucket keeps what it had
    for (const [bucket, o] of this.open) {
      if (o.depth > 0) {
        cur.buckets[bucket].ms += Math.max(0, end - o.since);
        o.depth = 0;
      }
    }
    this.open.clear();
    cur.wallMs = Math.max(0, end - this.t0);
    let off = 0;
    for (const b of TOP_LEVEL_BUCKETS) off += cur.buckets[b].ms;
    cur.harnessMs = Math.max(0, cur.wallMs - off);
    this.current = null;
    this.steps.push(cur);
    return cur;
  }

  snapshot(): RunTimeline {
    return { runId: this.runId ?? '', mode: this.mode, steps: [...this.steps], contended: this.contended };
  }

  /** Testing and the perf probes: a fresh recorder state without a new instance. */
  reset(opts: { enabled?: boolean } = {}): void {
    this.enabled = opts.enabled ?? this.enabled;
    this.runId = null;
    this.mode = '';
    this.contended = false;
    this.steps = [];
    this.current = null;
    this.open.clear();
    this.stageName = '';
  }

  private label(cur: StepTimeline, bucket: TimelineBucket, label: string, ms: number): void {
    if (label === '') return;
    const key = `${bucket}:${label}`;
    const t = (cur.labels[key] ??= { ms: 0, sumMs: 0, n: 0 });
    t.ms += ms;
    t.sumMs += ms;
    t.n += 1;
  }

  private entry(cur: StepTimeline, bucket: TimelineBucket, label: string, ms: number, started: number): void {
    if (cur.entries.length >= this.maxEntries) {
      cur.droppedEntries += 1;
      return;
    }
    cur.entries.push({ bucket, label, atMs: Math.max(0, started - this.t0), ms });
  }
}

/** The process recorder. Off unless `JEVCODE_TIMELINE` is set (see the header). */
export const stepTimeline = new TimelineRecorder({ enabled: timelineEnabled() });

export const TIMELINE_FILE = 'timeline.json';

/**
 * Flush the run's timeline to `<runDir>/timeline.json` — once, at the end of the run, never per step (§8 R-4: new
 * work is off the step or it does not ship). A no-op while disabled, and a failed write is swallowed: a measurement
 * artefact may not fail a run.
 */
export async function writeTimelineFile(dir: string, recorder: TimelineRecorder = stepTimeline): Promise<void> {
  if (!recorder.isEnabled()) return;
  try {
    await writeFile(join(dir, TIMELINE_FILE), `${JSON.stringify(recorder.snapshot(), null, 2)}\n`, 'utf8');
  } catch {
    /* a timeline that cannot be written is not a run failure */
  }
}

/** argv0 of a shell command, for the `lane` bucket's label (`python3 -m pytest …` → `python3`). */
export function commandLabel(command: string): string {
  const tokens = command.trim().split(/\s+/).filter((t) => t !== '');
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1; // leading VAR=value
  const raw = (tokens[i] ?? '').replace(/^[('"]+/, '');
  const base = raw.slice(raw.lastIndexOf('/') + 1);
  if (base === '') return 'sh';
  // a bare `git` label hides which spawn is expensive; the subcommand is what the gate work is about
  if (base !== 'git') return base.slice(0, 28);
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.startsWith('-')) {
      if (t === '-c' || t === '-C') j += 1; // the flag's own value is not the subcommand
      continue;
    }
    if (t.includes('=')) continue;
    return `git-${t}`.slice(0, 28);
  }
  return 'git';
}

export interface BucketStat {
  bucket: string;
  p50: number | null;
  p95: number | null;
  totalMs: number;
  n: number;
}

/** Per-bucket p50/p95 over the steps, plus the derived harness row; the table §5 "what is measured" asks for. */
export function bucketStats(run: RunTimeline): BucketStat[] {
  const rows: BucketStat[] = [];
  const push = (bucket: string, series: number[], n: number): void => {
    rows.push({ bucket, p50: percentile(series, 50), p95: percentile(series, 95), totalMs: series.reduce((a, b) => a + b, 0), n });
  };
  push('wall', run.steps.map((s) => s.wallMs), run.steps.length);
  for (const b of TIMELINE_BUCKETS) {
    const series = run.steps.map((s) => s.buckets[b].ms);
    const n = run.steps.reduce((a, s) => a + s.buckets[b].n, 0);
    if (n > 0) push(b, series, n);
  }
  push('harness', run.steps.map((s) => s.harnessMs), run.steps.length);
  return rows;
}

/** The label rows (`jev:propose`, `lane:python3`, …), heaviest first. */
export function labelStats(run: RunTimeline, limit = 12): BucketStat[] {
  const agg = new Map<string, { ms: number; n: number; series: number[] }>();
  for (const s of run.steps) {
    for (const [key, t] of Object.entries(s.labels)) {
      const cur = agg.get(key) ?? { ms: 0, n: 0, series: [] };
      cur.ms += t.ms;
      cur.n += t.n;
      cur.series.push(t.ms);
      agg.set(key, cur);
    }
  }
  return [...agg]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, limit)
    .map(([bucket, v]) => ({ bucket, p50: percentile(v.series, 50), p95: percentile(v.series, 95), totalMs: v.ms, n: v.n }));
}

const ms = (v: number | null): string => (v === null ? '—' : v.toFixed(1));

/** One plain-text table per run, used by the perf probes and `experiments/harness-next/quick.mts`. */
export function formatTimeline(run: RunTimeline): string {
  const lines: string[] = [];
  lines.push(`timeline ${run.runId || '(no run)'} ${run.mode} — ${run.steps.length} step(s)${run.contended ? ' CONTENDED (not trustworthy)' : ''}`);
  lines.push('bucket      p50 ms     p95 ms    total ms      n');
  for (const r of bucketStats(run)) lines.push(`${r.bucket.padEnd(10)} ${ms(r.p50).padStart(7)}   ${ms(r.p95).padStart(8)}  ${r.totalMs.toFixed(0).padStart(9)} ${String(r.n).padStart(6)}`);
  const labels = labelStats(run);
  if (labels.length > 0) {
    lines.push('label                      p50 ms     p95 ms    total ms      n');
    for (const r of labels) lines.push(`${r.bucket.padEnd(24)} ${ms(r.p50).padStart(7)}   ${ms(r.p95).padStart(8)}  ${r.totalMs.toFixed(0).padStart(9)} ${String(r.n).padStart(6)}`);
  }
  return lines.join('\n');
}
