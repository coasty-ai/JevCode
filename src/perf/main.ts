/**
 * `jevcode perf` (DESIGN.md §12): first frame, harness overhead per step, render lag, and
 * (with --live) Jev latency. Writes perf/results/latest.json and prints a table; exits 1
 * when a gate fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ParsedFlags } from '../cli/args.js';
import { measureFirstFrame } from './first-frame.js';
import { measureStepOverhead } from './step-overhead.js';
import { measureRenderLag } from './render-lag.js';

export async function runPerf(flags: ParsedFlags): Promise<number> {
  const bin = resolve('bin/jevcode.js');
  const out = flags.out ?? 'perf/results/latest.json';
  process.stdout.write('perf: first frame (10 cold + 10 warm runs under a pseudo-TTY)…\n');
  const firstFrame = await measureFirstFrame({ bin, runs: 10 });
  process.stdout.write('perf: harness overhead per step (mocked, zero latency, 50 steps)…\n');
  const overhead = await measureStepOverhead({ steps: 50 });
  process.stdout.write('perf: render lag under the TUI (mocked, 60 steps, rows 40 and rows 12)…\n');
  const lag = await measureRenderLag({ bin, steps: 60 });
  let jev: Awaited<ReturnType<typeof import('./jev-latency.js')['measureJevLatency']>> | null = null;
  if (flags.live) {
    process.stdout.write('perf: Jev latency (live)…\n');
    const { measureJevLatency } = await import('./jev-latency.js');
    jev = await measureJevLatency(flags);
  }
  const pass = firstFrame.pass && overhead.pass && lag.pass;
  const result = { measuredAt: new Date().toISOString(), node: process.version, firstFrame, stepOverhead: overhead, renderLag: lag, jevLatency: jev, pass };
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
  const f = (v: number | null | undefined): string => (v == null ? '–' : `${v.toFixed(1)} ms`);
  const rows: [string, string, string, string][] = [
    ['first frame cold p95 (10 runs)', f(firstFrame.cold.p95), '< 300 ms', firstFrame.pass ? 'pass' : 'FAIL'],
    ['first frame cold median', f(firstFrame.cold.median), '', ''],
    ['first frame warm median', f(firstFrame.warm.median), '', ''],
    ['harness overhead per step p95', f(overhead.p95), '< 50 ms', overhead.pass ? 'pass' : 'FAIL'],
    ['harness overhead per step p50', f(overhead.p50), '', ''],
    ['event-loop lag p95 (rows 40 / 12)', `${f(lag.rows40.lagP95)} / ${f(lag.rows12.lagP95)}`, '< 5 ms', lag.pass ? 'pass' : 'FAIL'],
    ['event-loop lag max (rows 40 / 12)', `${f(lag.rows40.lagMax)} / ${f(lag.rows12.lagMax)}`, '< 50 ms', ''],
    ['terminal clears after first frame (rows 40 / 12)', `${lag.rows40.clears} / ${lag.rows12.clears}`, '0', ''],
  ];
  if (jev) rows.push(['Jev latency p50 / p95 (live)', `${f(jev.p50)} / ${f(jev.p95)}`, 'report', '']);
  const w = rows.reduce((m, r) => Math.max(m, r[0].length), 0);
  for (const r of rows) process.stdout.write(`${r[0].padEnd(w)}  ${r[1].padEnd(22)}  ${r[2].padEnd(9)} ${r[3]}\n`);
  process.stdout.write(`written ${out}\n`);
  return pass ? 0 : 1;
}
