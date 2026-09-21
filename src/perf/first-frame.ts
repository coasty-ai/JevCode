/**
 * First-frame probe (DESIGN.md §12; TUI-DESIGN §18 row 1): spawns the real CLI under a pseudo-TTY (`script -q
 * /dev/null`), sets the geometry with `stty`, and measures spawn -> first appearance of the status-line sentinel
 * `step 0/` in the accumulated pty bytes, for BOTH entry points (`run "<task>"` and `chat`) at 40×120, 24×80 and
 * 8×40. Cold runs use a fresh NODE_COMPILE_CACHE directory; warm runs keep it. The ordering contract is verified on
 * every run: `JEVCODE_ASSERT_NO_NETWORK=1` (any http(s) fetch before the frame throws), `JEVCODE_HOME` pointing at a
 * directory that does not exist (the index fold must not run before the frame) and an unreadable `--config`.
 * Gate: cold p95 < 300 ms on every series. A separate traced pass (`JEVCODE_TRACE`, three runs, not gated) gives the
 * breakdown node boot → renderer mounted (bundle evaluated, first synchronous render) → frame flushed.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { percentile } from '../core/time.js';

export type FirstFrameCommand = 'run' | 'chat';

export interface FirstFrameRun {
  ms: number;
  exitCode: number | null;
  /** the child's `FIRST_FRAME_MS=` (performance.now() at the flushed frame; excludes nothing — the time origin is process start) */
  childMs: number | null;
  transcript: string;
}
export interface FirstFrameSeries {
  command: FirstFrameCommand;
  rows: number;
  columns: number;
  cold: { runs: number[]; median: number | null; p95: number | null };
  warm: { runs: number[]; median: number | null; p95: number | null };
  slowest: FirstFrameRun | null;
  /** every run exited 0 with no `network before first frame` in the pty */
  clean: boolean;
  pass: boolean;
}
export interface FirstFrameBreakdown {
  command: FirstFrameCommand;
  rows: number;
  columns: number;
  /** spawn → sentinel on the harness clock (same as the gated number) */
  harnessMs: number | null;
  /** process start → `render()` returned (`main.renderer tui mounted` in the trace): Node boot + launcher + bundle evaluation + first synchronous render */
  mountedMs: number | null;
  /** process start → the frame flushed (`FIRST_FRAME_MS`) */
  flushedMs: number | null;
  /** bare `node -e ''` under the same `script` wrapper, spawn → exit (median of 5) */
  bareNodeMs: number | null;
}
export interface FirstFrameResult {
  gateMs: number;
  series: FirstFrameSeries[];
  breakdown: FirstFrameBreakdown[];
  pass: boolean;
}

const SENTINEL = 'step 0/';
export const FIRST_FRAME_GEOMETRIES: readonly { rows: number; columns: number }[] = [
  { rows: 40, columns: 120 },
  { rows: 24, columns: 80 },
  { rows: 8, columns: 40 },
];

function childArgs(bin: string, command: FirstFrameCommand, workspace: string): string {
  const task = command === 'run' ? ' "perf probe"' : '';
  return `"${process.execPath}" "${bin}" ${command}${task} --workspace "${workspace}" --config "${join(workspace, 'no-such-config.json')}" --perf-exit-after-first-frame`;
}

function oneRun(bin: string, command: FirstFrameCommand, rows: number, columns: number, workspace: string, cacheDir: string, extraEnv: Record<string, string> = {}, timeoutMs = 20_000): Promise<FirstFrameRun> {
  return new Promise((resolve) => {
    const cmd = `stty rows ${rows} cols ${columns}; exec ${childArgs(bin, command, workspace)}`;
    const t0 = performance.now();
    const child = spawn('/usr/bin/script', ['-q', '/dev/null', 'sh', '-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: process.env['HOME'] ?? workspace,
        TERM: 'xterm-256color',
        NODE_ENV: 'production',
        JEVCODE_ASSERT_NO_NETWORK: '1',
        JEVCODE_HOME: join(workspace, 'no-runs-dir'),
        XDG_CONFIG_HOME: join(workspace, 'no-xdg'),
        NODE_COMPILE_CACHE: cacheDir,
        ...extraEnv,
      },
    });
    let acc = '';
    let firstMs: number | null = null;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const onChunk = (b: Buffer): void => {
      acc += b.toString('utf8');
      if (firstMs === null && acc.includes(SENTINEL)) firstMs = performance.now() - t0;
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('close', (code) => {
      clearTimeout(timer);
      const m = /FIRST_FRAME_MS=([0-9.]+)/.exec(acc);
      resolve({ ms: firstMs ?? Number.POSITIVE_INFINITY, exitCode: code, childMs: m ? Number(m[1]) : null, transcript: acc.slice(0, 4000) });
    });
  });
}

function bareNode(rows: number, columns: number, timeoutMs = 20_000): Promise<number> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn('/usr/bin/script', ['-q', '/dev/null', 'sh', '-c', `stty rows ${rows} cols ${columns}; exec "${process.execPath}" -e ''`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? tmpdir(), TERM: 'xterm-256color', NODE_ENV: 'production' },
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', () => undefined);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(performance.now() - t0);
    });
  });
}

function clean(r: FirstFrameRun): boolean {
  return r.exitCode === 0 && Number.isFinite(r.ms) && !r.transcript.includes('network before first frame');
}

async function measureSeries(bin: string, command: FirstFrameCommand, rows: number, columns: number, runs: number, gateMs: number): Promise<FirstFrameSeries> {
  const workspace = mkdtempSync(join(tmpdir(), 'jevcode-perf-ws-'));
  const cold: FirstFrameRun[] = [];
  const warm: FirstFrameRun[] = [];
  try {
    for (let i = 0; i < runs; i++) {
      const cache = mkdtempSync(join(tmpdir(), 'jevcode-perf-cc-'));
      cold.push(await oneRun(bin, command, rows, columns, workspace, cache));
      rmSync(cache, { recursive: true, force: true });
    }
    const warmCache = mkdtempSync(join(tmpdir(), 'jevcode-perf-cc-'));
    for (let i = 0; i < runs; i++) warm.push(await oneRun(bin, command, rows, columns, workspace, warmCache));
    rmSync(warmCache, { recursive: true, force: true });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  const coldMs = cold.map((r) => r.ms);
  const warmMs = warm.map((r) => r.ms);
  const all = [...cold, ...warm];
  const slowest = all.length ? all.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;
  const p95 = percentile(coldMs, 95);
  const ok = all.every(clean);
  return {
    command,
    rows,
    columns,
    cold: { runs: coldMs, median: percentile(coldMs, 50), p95 },
    warm: { runs: warmMs, median: percentile(warmMs, 50), p95: percentile(warmMs, 95) },
    slowest,
    clean: ok,
    pass: ok && p95 !== null && Number.isFinite(p95) && p95 < gateMs,
  };
}

/** Three traced cold runs (median of each figure); `JEVCODE_TRACE` adds a file open to the launch, so this pass is reported, never gated. */
async function measureBreakdown(bin: string, command: FirstFrameCommand, rows: number, columns: number): Promise<FirstFrameBreakdown> {
  const workspace = mkdtempSync(join(tmpdir(), 'jevcode-perf-ws-'));
  const harness: number[] = [];
  const mounted: number[] = [];
  const flushed: number[] = [];
  const bare: number[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const cache = mkdtempSync(join(tmpdir(), 'jevcode-perf-cc-'));
      const traceFile = join(workspace, `trace-${i}.log`);
      const r = await oneRun(bin, command, rows, columns, workspace, cache, { JEVCODE_TRACE: traceFile });
      rmSync(cache, { recursive: true, force: true });
      if (!clean(r)) continue;
      harness.push(r.ms);
      if (r.childMs !== null) flushed.push(r.childMs);
      let trace = '';
      try {
        trace = readFileSync(traceFile, 'utf8');
      } catch {
        trace = '';
      }
      const m = /main\.renderer \w+ mounted[^\n]*? t=([0-9.]+)/.exec(trace);
      if (m) mounted.push(Number(m[1]));
    }
    for (let i = 0; i < 5; i++) bare.push(await bareNode(rows, columns));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  return { command, rows, columns, harnessMs: percentile(harness, 50), mountedMs: percentile(mounted, 50), flushedMs: percentile(flushed, 50), bareNodeMs: percentile(bare, 50) };
}

export async function measureFirstFrame(opts: { bin: string; runs?: number; gateMs?: number; commands?: readonly FirstFrameCommand[]; geometries?: readonly { rows: number; columns: number }[]; onProgress?: (line: string) => void }): Promise<FirstFrameResult> {
  const runs = opts.runs ?? 10;
  const gateMs = opts.gateMs ?? 300;
  const commands = opts.commands ?? (['run', 'chat'] as const);
  const geometries = opts.geometries ?? FIRST_FRAME_GEOMETRIES;
  const series: FirstFrameSeries[] = [];
  for (const command of commands) {
    for (const g of geometries) {
      const s = await measureSeries(opts.bin, command, g.rows, g.columns, runs, gateMs);
      opts.onProgress?.(`first frame ${command} ${g.rows}x${g.columns}: cold p95 ${s.cold.p95?.toFixed(1)} ms, median ${s.cold.median?.toFixed(1)} ms, warm median ${s.warm.median?.toFixed(1)} ms${s.clean ? '' : ' (UNCLEAN RUN)'}`);
      series.push(s);
    }
  }
  const breakdown: FirstFrameBreakdown[] = [];
  for (const command of commands) breakdown.push(await measureBreakdown(opts.bin, command, 24, 80));
  return { gateMs, series, breakdown, pass: series.every((s) => s.pass) };
}
