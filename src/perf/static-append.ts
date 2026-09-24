/**
 * Static append microbenchmark (TUI-DESIGN §18 "Static microbenchmark", 08 §11 re-run on the real App): the bytes Ink
 * writes per committed `<Static>` line, in-process, on a fake 24×80 TTY (a stub `WriteStream` with `isTTY`, `rows`,
 * `columns`; Ink is told it is interactive so it brackets frames and erases lines exactly as in a pty). The real
 * `<App mode="session">` is mounted through `createTuiRenderer` and fed engine events through a fake engine's
 * emitter (`attach(engine)`), so the pane, live rows, composer and status line are the real ones.
 *
 * Three regions at rows 24 (budget 22):
 *   live22    a live run (pane 12 + live rows) with the composer typed to its 6-row cap → 22 dynamic rows
 *             (the A109 region of §2.2 "idle, 6-row draft" / "live, 2 queued, 3-row draft" family)
 *   review22  a review pending (pane 7 + review header 8 + preview 4 + composer 1) → 22 dynamic rows
 *   idle15    idle after the run (pane 12 + composer 1) → 15 dynamic rows
 * Each appends `lines` transcript items one at a time (one frame each: the append waits past Ink's 34 ms throttle),
 * and reports bytes per committed line (median and mean), frames per line and the region height seen. Report only,
 * no gate (08 §11 measured ≈ 1,600 B per keystroke at 24×80 for a 22-row region).
 */
import { EventEmitter } from 'node:events';
import type { Answer, ConfirmRequest, Decision, Engine, EngineEvent, EngineStatus, Question, RiskAssessment, RunResult } from '../core/types.js';
import { createEmitter } from '../core/events.js';
import { percentile } from '../core/time.js';
import { resolveLaunchSettings } from '../config/launch.js';
import type { TuiConfirmer } from '../tui/useEngine.js';
import { splitFrames } from './pty.js';

export interface StaticRegion {
  name: string;
  rows: number;
  columns: number;
  /** dynamic rows the region occupied (from the frames' erase counts, `pty.ts` `Frame.height`) */
  regionRows: number;
  lines: number;
  /** frames written during the appends (more than `lines` when the spinner or live rows also repainted) */
  frames: number;
  /** bytes of the one frame that committed each line (BSU…ESU inclusive): the Static append itself */
  appendFrameMedian: number | null;
  appendFrameMean: number | null;
  appendFrameMax: number | null;
  /** every byte written per appended line, concurrent frames included */
  bytesPerLineMedian: number | null;
  bytesPerLineMean: number | null;
  bytesPerLineMax: number | null;
  bytesTotal: number;
}
export interface StaticAppendResult {
  regions: StaticRegion[];
  /** the budget of rows − 2 held in every region */
  withinBudget: boolean;
  pass: boolean;
}

class StubStdout extends EventEmitter {
  bytes = 0;
  chunks: string[] = [];
  rows: number;
  columns: number;
  isTTY = true;
  constructor(rows: number, columns: number) {
    super();
    this.rows = rows;
    this.columns = columns;
  }
  write = (s: string | Uint8Array): boolean => {
    const text = typeof s === 'string' ? s : Buffer.from(s).toString('utf8');
    this.bytes += Buffer.byteLength(text, 'utf8');
    this.chunks.push(text);
    return true;
  };
}

class StubStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  private buffered: string | null = null;
  setEncoding(): void {}
  setRawMode(on: boolean): void {
    this.isRaw = on;
  }
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    const d = this.buffered;
    this.buffered = null;
    return d;
  }
  /** deliver bytes the way a terminal does (Ink reads on `readable`) */
  type(data: string): void {
    this.buffered = (this.buffered ?? '') + data;
    this.emit('readable');
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** past Ink's 34 ms throttle (maxFps 30) and the App's 50 ms live flush, so each append is its own frame */
const FRAME_SETTLE_MS = 70;

function status(step: number, stage: EngineStatus['stage']): EngineStatus {
  const usage = { inputTokens: 10_000, outputTokens: 2_300, costUsd: 0.12, calls: 3 };
  const jev = { inputTokens: 4_100, outputTokens: 0, costUsd: 0.01, calls: 9 };
  return { step, maxSteps: 40, wallMs: 72_000, maxWallMs: 1_800_000, stage, spend: { generator: usage, jev, totalUsd: 0.13, capUsd: 2, exceeded: false }, stopReason: null };
}

function decision(i: number): Decision {
  const question: Question = { type: 'score', instructions: 'how much is lost?', criteria: ['nothing', 'recoverable', 'untracked work', 'much of the workspace', 'outside'] };
  const answer: Answer = { type: 'score', score: 1, legend: {}, probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 }, confidence: 0.8 };
  return { step: 1, stage: 'risk', id: `dimension_${i}`, question, answer, probability: 0.8, confidence: 0.83, latencyMs: 170, requestHash: `hash${i}` };
}

function risk(): RiskAssessment {
  const dim = (level: number, r: number): RiskAssessment['dims']['destructive'] => ({ risk: r, probability: 0.6, expected: r, tailMass: 0, bound: 'expected', confidence: 0.7, level });
  return { dims: { destructive: dim(2, 0.5), out_of_scope: dim(0, 0.05), plan_mismatch: dim(0, 0.05), irreversible: dim(1, 0.25) }, risk: 0.5, verdict: 'review', reason: 'destructive: level 2 (0.50)' };
}

function confirmRequest(): ConfirmRequest {
  const action = { kind: 'edit', path: 'src/a.py', old: 'x = 1\n', new: 'x = 2\n' } as const;
  return { id: 'c1', step: 1, proposal: { goal: 'fix the off-by-one', action, plan: { done: ['read a.py'], remaining: ['run tests', 'fix'], openProblems: [] }, rawText: '{}' }, risk: risk() };
}

function runResult(): RunResult {
  const usage = { inputTokens: 10_000, outputTokens: 2_300, costUsd: 0.12, calls: 4 };
  const jev = { inputTokens: 4_100, outputTokens: 0, costUsd: 0.01, calls: 12 };
  return {
    runId: 'r1',
    mode: 'jev-on',
    stopReason: 'complete',
    steps: 4,
    wallMs: 95_000,
    usage: { generator: usage, jev },
    timing: { generatorMs: 1, jevMs: 2, execMs: 3, harnessMs: 4, totalMs: 10 },
    tokensPerStep: [1, 2, 3, 4],
    generatorTokensPerStep: [1, 1, 2, 3],
    jevTokensPerStep: [0, 1, 1, 1],
    jevLatencyMs: [170, 160],
    jevQuestions: 12,
    counters: { blocked: 0, reviews: 1, declined: 0, failed: 0, loops: 0, replans: 0, reads: 1 },
    finalPlan: { done: [], remaining: [], unverified: [], openProblems: [], harnessProblems: [] },
    resolvedJevModel: 'jev-1.13-20260917',
    jevModelDrift: null,
  };
}

/** A recording engine: the renderer subscribes to `events`; nothing else is ever called during the benchmark. */
function fakeEngine(): { engine: Engine; emit: (e: EngineEvent) => void } {
  const events = createEmitter(() => undefined);
  const controller = new AbortController();
  const engine: Engine = {
    runId: 'r1',
    events,
    signal: controller.signal,
    run: () => new Promise<RunResult>(() => undefined),
    abort: () => controller.abort(),
    status: () => status(1, 'propose'),
    snapshotState: () => null,
    steer: () => ({ ok: true, index: 0, queued: 1 }),
    unsteer: () => null,
    pause: () => undefined,
    retryNow: () => false,
    annotate: () => false,
  };
  return { engine, emit: (e) => events.emit(e) };
}

const LINE_TEXTS = [
  'ran printf ok 12: exit 0 in 4 ms, 6 B stdout — scratch_12.py unchanged',
  'wrote scratch_13.py (14 B) — VALUE_13 = 13; plan done=3 remaining=3 open=0',
  'read scratch_12.py (14 B) in 1 ms — 1 file, 0.0kB of 3 candidates',
  'edit scratch_10.py: VALUE_10 = 10 → VALUE_10 = 13 (1 hunk, 14 B)',
];

export async function measureStaticAppend(opts: { lines?: number; rows?: number; columns?: number; onProgress?: (line: string) => void }): Promise<StaticAppendResult> {
  const lines = opts.lines ?? 60;
  const rows = opts.rows ?? 24;
  const columns = opts.columns ?? 80;
  const stdout = new StubStdout(rows, columns);
  const stdin = new StubStdin();
  const { createTuiRenderer } = await import('../tui/App.js');
  const renderer = createTuiRenderer({
    task: '',
    resumeId: null,
    onAbort: () => undefined,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    mode: 'session',
    cwd: '/tmp/perf-project',
    env: { TERM: 'xterm-256color' },
    launch: resolveLaunchSettings({}, { TERM: 'xterm-256color' }),
    interactive: true,
  });
  const regions: StaticRegion[] = [];
  try {
    await renderer.firstFrame();
    const fe = fakeEngine();
    renderer.attach(fe.engine);
    fe.emit({ type: 'run:start', runId: 'r1', task: 'perf: static append', mode: 'jev-on', resumedFromStep: null });
    fe.emit({ type: 'run:ready', runId: 'r1', step: 0, maxSteps: 40, task: 'perf: static append', resumed: false });
    fe.emit({ type: 'step:start', step: 1, startedAt: new Date().toISOString() });
    fe.emit({ type: 'status', status: status(1, 'propose') });
    for (let i = 0; i < 12; i++) fe.emit({ type: 'decision', decision: decision(i) });
    fe.emit({ type: 'generator:delta', step: 1, text: 'I will make parse_date return an aware datetime by replacing strptime with fromisoformat\nand normalising naive inputs to UTC before the comparison.\n' });
    await sleep(FRAME_SETTLE_MS);
    // a 6-row draft: 30 chunks of 16 letters, delivered like fast typing
    for (let i = 0; i < 30; i++) {
      stdin.type('ABCDEFGHIJKLMNOP');
      await sleep(8);
    }
    await sleep(FRAME_SETTLE_MS);

    const appendRegion = async (name: string): Promise<void> => {
      const perLine: number[] = [];
      const appendFrame: number[] = [];
      const startChunk = stdout.chunks.length;
      for (let i = 0; i < lines; i++) {
        const before = stdout.bytes;
        const chunkAt = stdout.chunks.length;
        const marker = `#${name}-${i}`;
        fe.emit({ type: 'transcript', step: 1, level: 'info', text: `${LINE_TEXTS[i % LINE_TEXTS.length]!} ${marker}` });
        await sleep(FRAME_SETTLE_MS);
        perLine.push(stdout.bytes - before);
        // the frame that carried the new Static line (a spinner or live-row repaint in the same window is not the append)
        const frame = splitFrames(stdout.chunks.slice(chunkAt).join('')).frames.find((f) => f.body.includes(marker));
        if (frame) appendFrame.push(Buffer.byteLength(frame.body, 'utf8') + 16);
      }
      const written = stdout.chunks.slice(startChunk).join('');
      const { frames } = splitFrames(written);
      const regionRows = frames.reduce((m, f) => Math.max(m, f.height), 0);
      const total = perLine.reduce((a, b) => a + b, 0);
      const appendTotal = appendFrame.reduce((a, b) => a + b, 0);
      const r: StaticRegion = {
        name,
        rows,
        columns,
        regionRows,
        lines,
        frames: frames.length,
        appendFrameMedian: percentile(appendFrame, 50),
        appendFrameMean: appendFrame.length ? appendTotal / appendFrame.length : null,
        appendFrameMax: appendFrame.length ? Math.max(...appendFrame) : null,
        bytesPerLineMedian: percentile(perLine, 50),
        bytesPerLineMean: perLine.length ? total / perLine.length : null,
        bytesPerLineMax: perLine.length ? Math.max(...perLine) : null,
        bytesTotal: total,
      };
      regions.push(r);
      opts.onProgress?.(`static append ${name}: ${r.lines} lines, region ${r.regionRows} rows, ${r.frames} frames; append frame ${r.appendFrameMedian?.toFixed(0)} B median / ${r.appendFrameMean?.toFixed(0)} B mean / ${r.appendFrameMax} B max (${appendFrame.length} located); all bytes per line ${r.bytesPerLineMedian?.toFixed(0)} B median`);
    };

    await appendRegion('live22');

    // review pending: the box collapses the composer to one inactive row (§2.1); the region is pane 7 + header 8 + preview 4 + composer 1
    const req = confirmRequest();
    const ac = new AbortController();
    const pending = renderer.confirmer.confirm(req, { signal: ac.signal }).catch(() => false);
    await sleep(FRAME_SETTLE_MS * 3);
    await appendRegion('review22');
    (renderer.confirmer as TuiConfirmer).resolve(req.id, false);
    await pending;
    await sleep(FRAME_SETTLE_MS);

    // idle after the run: the draft is still there (typed while live, kept as the follow-up draft); clear it with Ctrl-C (§3.3 S1) so the composer is one row
    fe.emit({ type: 'run:end', result: runResult(), exitCode: 0 });
    await sleep(FRAME_SETTLE_MS * 2);
    stdin.type('\x03');
    await sleep(FRAME_SETTLE_MS * 2);
    await appendRegion('idle15');
  } finally {
    await renderer.unmount();
  }
  const withinBudget = regions.every((r) => r.regionRows <= rows - 2);
  return { regions, withinBudget, pass: withinBudget && regions.length === 3 };
}
