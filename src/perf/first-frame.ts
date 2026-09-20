/**
 * First-frame probe (DESIGN.md §12): spawns the real CLI under a pseudo-TTY (`script -q
 * /dev/null`), sets the geometry with `stty`, and measures spawn -> first appearance of the
 * status-line sentinel `step 0/` in the accumulated pty bytes. Cold runs use a fresh
 * NODE_COMPILE_CACHE directory; warm runs keep it. Gate: cold p95 < 300 ms, zero network.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { percentile } from '../core/time.js';

export interface FirstFrameRun {
  ms: number;
  exitCode: number | null;
  childMs: number | null;
  transcript: string;
}
export interface FirstFrameResult {
  cold: { runs: number[]; median: number | null; p95: number | null };
  warm: { runs: number[]; median: number | null; p95: number | null };
  slowest: FirstFrameRun | null;
  pass: boolean;
  gateMs: number;
}

const SENTINEL = 'step 0/';

function oneRun(bin: string, workspace: string, cacheDir: string, timeoutMs = 20_000): Promise<FirstFrameRun> {
  return new Promise((resolve) => {
    const cmd = `stty rows 40 cols 120; exec "${process.execPath}" "${bin}" run "perf probe" --workspace "${workspace}" --config "${join(workspace, 'no-such-config.json')}" --perf-exit-after-first-frame`;
    const t0 = performance.now();
    const child = spawn('/usr/bin/script', ['-q', '/dev/null', 'sh', '-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: process.env['HOME'] ?? workspace,
        TERM: 'xterm-256color',
        JEVCODE_ASSERT_NO_NETWORK: '1',
        JEVCODE_HOME: join(workspace, 'no-runs-dir'),
        NODE_COMPILE_CACHE: cacheDir,
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

export async function measureFirstFrame(opts: { bin: string; runs?: number; gateMs?: number }): Promise<FirstFrameResult> {
  const runs = opts.runs ?? 10;
  const gateMs = opts.gateMs ?? 300;
  const workspace = mkdtempSync(join(tmpdir(), 'jevcode-perf-ws-'));
  const cold: FirstFrameRun[] = [];
  const warm: FirstFrameRun[] = [];
  try {
    for (let i = 0; i < runs; i++) {
      const cache = mkdtempSync(join(tmpdir(), 'jevcode-perf-cc-'));
      cold.push(await oneRun(opts.bin, workspace, cache));
      rmSync(cache, { recursive: true, force: true });
    }
    const warmCache = mkdtempSync(join(tmpdir(), 'jevcode-perf-cc-'));
    for (let i = 0; i < runs; i++) warm.push(await oneRun(opts.bin, workspace, warmCache));
    rmSync(warmCache, { recursive: true, force: true });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  const coldMs = cold.map((r) => r.ms);
  const warmMs = warm.map((r) => r.ms);
  const all = [...cold, ...warm];
  const slowest = all.length ? all.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;
  const p95 = percentile(coldMs, 95);
  const okExit = all.every((r) => r.exitCode === 0 && !r.transcript.includes('network before first frame'));
  return {
    cold: { runs: coldMs, median: percentile(coldMs, 50), p95 },
    warm: { runs: warmMs, median: percentile(warmMs, 50), p95: percentile(warmMs, 95) },
    slowest,
    pass: okExit && p95 !== null && Number.isFinite(p95) && p95 < gateMs,
    gateMs,
  };
}
