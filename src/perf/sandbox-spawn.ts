/**
 * Probe P2b `sandbox-spawn` (HARNESS-NEXT-DESIGN §5 Ring 0): what the seatbelt wrapper alone costs.
 *
 * `sandbox-exec -f <profile> /bin/sh -c true` against a bare `/bin/sh -c true`, through the real
 * `src/sandbox/run.ts` so the number includes everything a lane run pays before the candidate starts: the env
 * scrub, the stream collectors, the abort plumbing and the `detached` spawn.
 *
 * **Report only, never a gate** — and the design says why (§5, "Why P2 had to be re-specified"). The wrapper is
 * ≈ 4 ms on a 2.8 ms floor, so a pool measured against *this* baseline would show a double-digit ratio while
 * telling you nothing: the cost a warm lane runner removes is the interpreter and the test framework, which is
 * what P2 `lane-run` measures. This probe exists so that ratio can be *subtracted* rather than guessed at, and so
 * a regression in the wrapper itself (a bigger profile, an extra realpath) is visible on its own.
 *
 * No network, no API, ≈ 1 s. Off the release set: `JEVCODE_PERF_ONLY=sandbox-spawn jevcode perf`.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { percentile } from '../core/time.js';
import { createSandbox } from '../sandbox/run.js';
import { detectSandboxLevel } from '../sandbox/seatbelt.js';
import type { SandboxLevel, SandboxProfile } from '../core/types.js';

export interface SpawnSeries {
  name: string;
  level: SandboxLevel;
  samples: number[];
  p50: number | null;
  p95: number | null;
}

export interface SandboxSpawnResult {
  runs: number;
  bare: SpawnSeries;
  seatbelt: SpawnSeries | null;
  /** seatbelt p50 − bare p50; null when this platform has no seatbelt */
  wrapperMs: number | null;
  /** report only: this probe never fails the perf run */
  pass: true;
}

function series(name: string, level: SandboxLevel, samples: number[]): SpawnSeries {
  return { name, level, samples, p50: percentile(samples, 50), p95: percentile(samples, 95) };
}

async function timeRuns(profile: SandboxProfile, root: string, runDir: string, runs: number): Promise<{ level: SandboxLevel; samples: number[] }> {
  const sandbox = createSandbox({ workspaceRoot: root, runDir, profile, noNetwork: true, secretReadDenies: [], redact: (s) => s });
  const signal = new AbortController().signal;
  const samples: number[] = [];
  // one warm-up: the first spawn pays the profile write and the OS's first lookup of sandbox-exec
  await sandbox.run('true', { timeoutMs: 30_000, maxOutputBytes: 4096, signal });
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await sandbox.run('true', { timeoutMs: 30_000, maxOutputBytes: 4096, signal });
    samples.push(performance.now() - t0);
  }
  return { level: sandbox.level, samples };
}

export async function measureSandboxSpawn(opts: { runs?: number; onProgress?: (line: string) => void } = {}): Promise<SandboxSpawnResult> {
  const runs = opts.runs ?? 15;
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-perf-spawn-'));
  const root = join(dir, 'ws');
  const runDir = join(dir, 'run');
  try {
    mkdirSync(root, { recursive: true });
    const bare = await timeRuns('none', root, join(runDir, 'bare'), runs);
    const bareSeries = series('bare /bin/sh -c true', bare.level, bare.samples);
    opts.onProgress?.(`bare            p50 ${(bareSeries.p50 ?? 0).toFixed(2)} ms  p95 ${(bareSeries.p95 ?? 0).toFixed(2)} ms  (n ${runs})`);

    let seatbeltSeries: SpawnSeries | null = null;
    if (detectSandboxLevel('seatbelt') === 'seatbelt') {
      const sb = await timeRuns('seatbelt', root, join(runDir, 'sb'), runs);
      seatbeltSeries = series('sandbox-exec -f <profile> /bin/sh -c true', sb.level, sb.samples);
      opts.onProgress?.(`seatbelt        p50 ${(seatbeltSeries.p50 ?? 0).toFixed(2)} ms  p95 ${(seatbeltSeries.p95 ?? 0).toFixed(2)} ms  (n ${runs})`);
    } else {
      opts.onProgress?.('seatbelt        not available on this platform (report only)');
    }
    const wrapperMs = seatbeltSeries?.p50 !== undefined && seatbeltSeries.p50 !== null && bareSeries.p50 !== null ? seatbeltSeries.p50 - bareSeries.p50 : null;
    if (wrapperMs !== null) opts.onProgress?.(`the wrapper alone: ${wrapperMs.toFixed(2)} ms per spawn — subtract this from any pool claim (§5)`);
    return { runs, bare: bareSeries, seatbelt: seatbeltSeries, wrapperMs, pass: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
