/**
 * `jevcode perf` (DESIGN.md §12; TUI-DESIGN §18; TUI-DESIGN-2 §9): first frame (run + chat, three geometries; the
 * first frame is splash frame 0), harness overhead per step with images, Static append bytes, render lag while typing
 * during a live mocked run paced by `JEVCODE_MOCK_STEP_MS` (three geometries at the realistic 200 ms rate, gated; one
 * zero-latency stress row, reported; a splash frame-count bucket per geometry), composer keystroke latency (six
 * series), the intake reply latency (Enter → `[you]` bubble, Enter → `[jevcode]` reply, mock at 0 ms and delayed
 * 150 ms), zero clears per state, and (with --live) Jev latency. Writes perf/results/latest.json, prints a table,
 * rewrites the README's Performance section from the result (`readme.ts`; complete runs only) and exits 1 when a gate
 * fails.
 *
 * The machine must be quiet: the 1-minute load average is read first and, above `LOAD_MAX`, the run waits
 * `LOAD_WAIT_MS` and re-reads it up to three times (the load at measurement start and end is recorded either way). A
 * release number additionally needs the load ≤ `LOAD_QUIET` at both ends (`load.quiet` in the result): the harness
 * gate passes by a few milliseconds and flips under modest load (`step-overhead.ts`).
 *
 * `JEVCODE_PERF_ONLY=first-frame,states` (comma list of probe names) runs a subset — for iterating on one probe; a
 * subset result is written with `partial: true`, never counts as the release number and never reaches the README.
 *
 * The Static microbenchmark mounts the real Ink App in-process (`static-append.ts`); Ink's cursor helper registers an
 * exit hook that writes `ESC[?25h` to `process.stderr` (`restore-cursor`: `signalExit(() => process.stderr.write(…))`),
 * which would corrupt the perf command's own output at exit, so the parent runs it in a child `jevcode perf` process
 * (`JEVCODE_PERF_ONLY=static-append`, `JEVCODE_PERF_CHILD=1`, stdio piped) and reads its JSON.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ParsedFlags } from '../cli/args.js';
import { measureFirstFrame, type FirstFrameResult } from './first-frame.js';
import { measureStepOverhead, type StepOverheadResult } from './step-overhead.js';
import { REALISTIC_STEP_MS, measureRenderLag, type RenderLagResult } from './render-lag.js';
import { measureComposerLatency, type ComposerLatencyResult } from './composer-latency.js';
import { measureIntakeLatency, type IntakeLatencyResult } from './intake-latency.js';
import { measureStates, type StatesResult } from './states.js';
import type { StaticAppendResult } from './static-append.js';
import type { JevLatencyResult } from './jev-latency.js';
import { resultRows, updateReadmePerformance } from './readme.js';

export const LOAD_MAX = 8;
/** a release number is taken with the 1-minute load ≤ this at the start and the end of the run */
export const LOAD_QUIET = 2;
export const LOAD_WAIT_MS = 30_000;
export const LOAD_RETRIES = 3;

export type ProbeName = 'first-frame' | 'step-overhead' | 'static-append' | 'render-lag' | 'composer-latency' | 'intake-latency' | 'states';
const ALL_PROBES: readonly ProbeName[] = ['first-frame', 'step-overhead', 'static-append', 'render-lag', 'composer-latency', 'intake-latency', 'states'];

export interface PerfResult {
  measuredAt: string;
  node: string;
  machine: { cpus: number; model: string; memGiB: number; os: string };
  load: { atStart: number; atEnd: number; waitedMs: number; max: number; quietMax: number; quiet: boolean };
  /** other pty drivers alive when the run started (`pgrep -fl 'drive.exp|pty_type.py'`, other agents' smokes): the run's conditions, recorded for the reader */
  foreignDrivers: string[];
  probes: ProbeName[];
  partial: boolean;
  firstFrame: FirstFrameResult | null;
  stepOverhead: StepOverheadResult | null;
  staticAppend: StaticAppendResult | null;
  renderLag: RenderLagResult | null;
  composerLatency: ComposerLatencyResult | null;
  /** TUI-DESIGN-2 §3.12 / §9: Enter → bubble and Enter → reply against the mock decider (null before round 2's `intake-latency` probe ran) */
  intakeLatency: IntakeLatencyResult | null;
  states: StatesResult | null;
  jevLatency: JevLatencyResult | null;
  pass: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function selectedProbes(env: NodeJS.ProcessEnv): ProbeName[] {
  const only = env['JEVCODE_PERF_ONLY'];
  if (only === undefined || only.trim() === '') return [...ALL_PROBES];
  const wanted = new Set(only.split(',').map((s) => s.trim()).filter(Boolean));
  const unknown = [...wanted].filter((w) => !ALL_PROBES.includes(w as ProbeName));
  if (unknown.length > 0) throw new Error(`JEVCODE_PERF_ONLY: unknown probe(s) ${unknown.join(', ')} (known: ${ALL_PROBES.join(', ')})`);
  return ALL_PROBES.filter((p) => wanted.has(p));
}

/** Wait for a quiet machine: 1-minute load ≤ LOAD_MAX, re-read up to LOAD_RETRIES times LOAD_WAIT_MS apart. */
async function awaitQuietMachine(log: (s: string) => void): Promise<{ load: number; waitedMs: number }> {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const load = loadavg()[0] ?? 0;
    if (load <= LOAD_MAX || attempt >= LOAD_RETRIES) {
      if (load > LOAD_MAX) log(`perf: load average ${load.toFixed(2)} still above ${LOAD_MAX} after ${LOAD_RETRIES} waits; measuring anyway (recorded in the result)\n`);
      return { load, waitedMs: waited };
    }
    log(`perf: load average ${load.toFixed(2)} > ${LOAD_MAX}; waiting ${LOAD_WAIT_MS / 1000} s (${attempt + 1}/${LOAD_RETRIES})…\n`);
    await sleep(LOAD_WAIT_MS);
    waited += LOAD_WAIT_MS;
  }
}

/**
 * The pty driver processes among `pgrep -fl` lines: an `expect` running `scripts/pty/drive.exp` or a `python3` running
 * `perf/drivers/pty_type.py` — not every process whose argv merely mentions those names (a shell carrying a script
 * text, an editor). One truncated `pid command` line each.
 */
export function driverLines(pgrepOutput: string): string[] {
  const driver = /^\d+\s+(?:\S*\/)?(?:expect\b.*drive\.exp|python3?\b.*pty_type\.py)/;
  return pgrepOutput
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => driver.test(l))
    .map((l) => (l.length > 160 ? `${l.slice(0, 159)}…` : l));
}

/** Other pty driver processes alive right now (drive.exp / pty_type.py of other agents). */
export function foreignPtyDrivers(): string[] {
  try {
    return driverLines(execFileSync('pgrep', ['-fl', 'drive\\.exp|pty_type\\.py'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    // pgrep exits 1 when nothing matches
    return [];
  }
}

/**
 * Run the Static microbenchmark in a child `jevcode perf` (see the header) and return its result; the child's progress
 * lines (two-space indented) are forwarded, everything else it prints is dropped. Null when the child failed.
 */
async function measureStaticAppendInChild(bin: string, progress: (line: string) => void): Promise<StaticAppendResult | null> {
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-perf-static-'));
  const out = join(dir, 'static-append.json');
  const env: Record<string, string | undefined> = { ...process.env, JEVCODE_PERF_ONLY: 'static-append', JEVCODE_PERF_CHILD: '1', NODE_ENV: 'production' };
  delete env['CI'];
  try {
    const code = await new Promise<number | null>((done) => {
      const child = spawn(process.execPath, [bin, 'perf', '--out', out], { stdio: ['ignore', 'pipe', 'pipe'], env });
      let buffered = '';
      child.stdout.on('data', (b: Buffer) => {
        buffered += b.toString('utf8');
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) if (line.startsWith('  ')) progress(line.slice(2));
      });
      child.stderr.on('data', () => undefined);
      const killer = setTimeout(() => child.kill('SIGKILL'), 300_000);
      child.on('close', (c) => {
        clearTimeout(killer);
        done(c);
      });
    });
    if (code !== 0) return null;
    const parsed: unknown = JSON.parse(readFileSync(out, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const sa = (parsed as { staticAppend?: StaticAppendResult | null }).staticAppend;
    return sa ?? null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runPerf(flags: ParsedFlags): Promise<number> {
  const root = process.cwd();
  const bin = resolve(root, 'bin/jevcode.js');
  const out = flags.out ?? 'perf/results/latest.json';
  const child = process.env['JEVCODE_PERF_CHILD'] === '1';
  const log = (s: string): void => {
    process.stdout.write(s);
  };
  const progress = (line: string): void => log(`  ${line}\n`);
  const probes = selectedProbes(process.env);
  const partial = probes.length !== ALL_PROBES.length;
  // the parent already waited for a quiet machine; a child measures right away
  const quiet = child ? { load: loadavg()[0] ?? 0, waitedMs: 0 } : await awaitQuietMachine(log);
  log(`perf: load average ${quiet.load.toFixed(2)} at start (limit ${LOAD_MAX}, release ≤ ${LOAD_QUIET}); probes: ${probes.join(', ')}${partial ? ' (PARTIAL)' : ''}\n`);
  const foreignDrivers = child ? [] : foreignPtyDrivers();
  if (foreignDrivers.length > 0) log(`perf: ${foreignDrivers.length} other pty driver process(es) alive at the start (recorded in the result):\n${foreignDrivers.map((d) => `  ${d}`).join('\n')}\n`);

  let firstFrame: FirstFrameResult | null = null;
  let overhead: StepOverheadResult | null = null;
  let staticAppend: StaticAppendResult | null = null;
  let lag: RenderLagResult | null = null;
  let composer: ComposerLatencyResult | null = null;
  let intake: IntakeLatencyResult | null = null;
  let states: StatesResult | null = null;
  let jev: JevLatencyResult | null = null;

  if (probes.includes('first-frame')) {
    log('perf: first frame (run + chat × 40x120 / 24x80 / 8x40; 10 cold + 10 warm runs each under a pseudo-TTY, zero network asserted)…\n');
    firstFrame = await measureFirstFrame({ bin, runs: 10, onProgress: progress });
  }
  if (probes.includes('step-overhead')) {
    log('perf: harness overhead per step (mocked, zero latency, 50 steps, 5,000-file fixture, 50 dirty files / 15 MiB, one 60 MiB artefact)…\n');
    overhead = await measureStepOverhead({ steps: 50 });
    progress(`harness p50 ${overhead.p50?.toFixed(1)} ms, p95 ${overhead.p95?.toFixed(1)} ms (run steps p95 ${overhead.harnessRunP95?.toFixed(1)} / p50 ${overhead.harnessRunP50?.toFixed(1)} ms, other steps p95 ${overhead.harnessOtherP95?.toFixed(1)} ms); imagesMs p50 ${overhead.imagesP50?.toFixed(1)} p95 ${overhead.imagesP95?.toFixed(1)} ms (run steps p95 ${overhead.imagesRunP95?.toFixed(1)} ms); hashSkipped ${String(overhead.hashSkipped)} at step ${overhead.artefactStep}`);
    // HARNESS-NEXT-DESIGN §6 S0: with JEVCODE_TIMELINE set, where that p95 went (never in a gated run: the recorder would measure itself)
    for (const r of [...(overhead.timeline?.buckets ?? []), ...(overhead.timeline?.labels ?? [])]) {
      progress(`  ${r.bucket.padEnd(24)} p50 ${(r.p50 ?? 0).toFixed(1).padStart(7)} ms  p95 ${(r.p95 ?? 0).toFixed(1).padStart(7)} ms  total ${r.totalMs.toFixed(0).padStart(6)} ms  n ${r.n}`);
    }
  }
  if (probes.includes('static-append')) {
    log('perf: Static append bytes per committed line (in-process fake TTY 24x80: live + 6-row draft, review pending, idle)…\n');
    if (child) {
      const { measureStaticAppend } = await import('./static-append.js');
      staticAppend = await measureStaticAppend({ onProgress: progress });
    } else {
      staticAppend = await measureStaticAppendInChild(bin, progress);
      if (staticAppend === null) progress('static append: the child probe failed (no result) → FAIL');
    }
  }
  if (probes.includes('render-lag')) {
    log(`perf: render lag while typing 10 keys/s during a live mocked run (real pty, 120 columns: rows 40, rows 12, rows 40 reduced motion at JEVCODE_MOCK_STEP_MS=${REALISTIC_STEP_MS} — gated; rows 40 at 0 ms — the stress row, reported)…\n`);
    lag = await measureRenderLag({ root, bin, onProgress: progress });
  }
  if (probes.includes('composer-latency')) {
    log(`perf: composer keystroke → frame latency (real pty 24x80: idle, live at the A109 region at JEVCODE_MOCK_STEP_MS=${REALISTIC_STEP_MS}, live-stress at 0 ms (reported), palette, review; 200 keys 100 ms apart; burst30 latency reported, dynamic frame rate gated)…\n`);
    composer = await measureComposerLatency({ root, bin, onProgress: progress });
  }
  if (probes.includes('intake-latency')) {
    log('perf: intake reply latency (real pty 24x80, chat --mock: 20 greetings and tool questions, Enter → [you] bubble frame and Enter → [jevcode] reply frame; mock decider at 0 ms, then delayed 150 ms through JEVCODE_MOCK_JEV_MS)…\n');
    intake = await measureIntakeLatency({ root, bin, onProgress: progress });
  }
  if (probes.includes('states')) {
    log('perf: zero clears per state and geometry segment (review, palette, picker, wizard, secret row, intake card, render faults, resize idle/live 40→12→40, Ctrl+L)…\n');
    states = await measureStates({ root, bin, onProgress: progress });
  }
  if (flags.live) {
    log('perf: Jev latency (live)…\n');
    const { measureJevLatency } = await import('./jev-latency.js');
    jev = await measureJevLatency(flags);
  }
  const loadEnd = loadavg()[0] ?? 0;

  const staticPass = probes.includes('static-append') ? (staticAppend?.pass ?? false) : undefined;
  const gates: boolean[] = [firstFrame?.pass, overhead?.pass, staticPass, lag?.pass, composer?.pass, intake?.pass, states?.pass].filter((v): v is boolean => v !== undefined);
  const pass = gates.length > 0 && gates.every(Boolean);
  const cpu = cpus();
  const result: PerfResult = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    machine: { cpus: cpu.length, model: cpu[0]?.model ?? 'unknown', memGiB: Math.round(totalmem() / 2 ** 30), os: `darwin ${release()}` },
    load: { atStart: quiet.load, atEnd: loadEnd, waitedMs: quiet.waitedMs, max: LOAD_MAX, quietMax: LOAD_QUIET, quiet: quiet.load <= LOAD_QUIET && loadEnd <= LOAD_QUIET },
    foreignDrivers,
    probes,
    partial,
    firstFrame,
    stepOverhead: overhead,
    staticAppend,
    renderLag: lag,
    composerLatency: composer,
    intakeLatency: intake,
    states,
    jevLatency: jev,
    pass,
  };
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));

  const rows = resultRows(result).map((r) => [r.measurement.replace(/`/g, ''), r.result, r.gate.replace(/`/g, ''), r.status] as const);
  const w = rows.reduce((m, r) => Math.max(m, r[0].length), 0);
  const w1 = rows.reduce((m, r) => Math.max(m, r[1].length), 0);
  for (const r of rows) log(`${r[0].padEnd(w)}  ${r[1].padEnd(w1)}  ${r[2].padEnd(26)} ${r[3]}\n`);
  log(`load average ${quiet.load.toFixed(2)} at start, ${loadEnd.toFixed(2)} at end (limit ${LOAD_MAX}; release number needs ≤ ${LOAD_QUIET} at both ends: ${result.load.quiet ? 'met' : 'NOT met'})\n`);
  log(`written ${out}${partial ? ' (PARTIAL: not a release number)' : ''}\n`);
  if (!partial && !child) {
    const readme = resolve(root, 'README.md');
    const ok = updateReadmePerformance(readme, result);
    log(ok ? `README Performance section rewritten from ${out}\n` : `README.md has no "## Performance" section; nothing rewritten\n`);
  }
  log(`perf: ${pass ? 'all gates pass' : 'GATE FAILURE'}\n`);
  return pass ? 0 : 1;
}
