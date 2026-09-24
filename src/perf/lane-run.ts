/**
 * Probe P2 `lane-run` (HARNESS-NEXT-DESIGN §5 Ring 0) — **the gate for the top lever**.
 *
 * One *real* candidate verification run, end to end, in both lane modes the synthesizer uses:
 *
 *   `candidate_file`  `python3 run_tests.py <name> <candidate>`   (bench/data/quixbugs)
 *   `pytest`          `python3 -m pytest -q`                       (bench/data/ladder/tasks/<t>)
 *
 * cold-spawn (today: a fresh `sandbox-exec -f <profile> /bin/sh -c …` per candidate, `src/sandbox/run.ts`) against
 * the persistent runner of M6. **M6 ships only if the warm path is ≥ 2× on this probe** (§6 S1 gate), and the
 * design is explicit that it is "dropped, not softened" below that (§8 R-1).
 *
 * §5 re-specified this probe for a reason worth repeating at the call site: the draft compared pooled against
 * unpooled `sandbox.run('true')`, and that comparison is meaningless — the wrapper is ≈ 4 ms on a 2.8 ms floor
 * (measure it with `sandbox-spawn`), so a pool clears a ≥ 2× bar there while removing none of the cost. What a
 * warm runner actually removes is the interpreter and the test framework: `python3 -c pass` 13.4 ms,
 * `import pytest` 67.3 ms, a real QuixBugs candidate run 74.3 ms sandboxed, a real ladder candidate run 182.7 ms.
 * So the probe runs the candidate, not `true`, and reports the floor rows beside it so the removable fraction of
 * each mode is readable rather than asserted.
 *
 * **Wave S0 lands the cold arm and the gate; the warm arm is `null` until `src/sandbox/pool.ts` exists (wave S1).**
 * `warmRunner` is the injection point: S1 passes a runner and the same gate arithmetic decides the mechanism.
 * A `null` warm arm reports `gate: 'pending'` — never `pass` — so S1 cannot be waved through on a probe that did
 * not measure it.
 *
 * Every arm is *validated* before it is timed: the run has to have produced the output its framework produces
 * (`run_tests.py`'s one JSON line, pytest's summary). This is not defensive padding — the pytest mode fails this
 * check on a bare checkout, and silently: the sandbox scrubs `HOME` to `<runDir>/home`, so a `pytest` installed in
 * the user site-packages is not importable and `python3 -m pytest` exits 1 in 30 ms with
 * `No module named pytest`. Timed without the check that reads as a lane run three times *faster* than the
 * interpreter floor, i.e. as a free 2× for any warm arm to beat. The mode reports `unavailable` with the reason
 * instead; point `env` at a venv (or give the workspace a `.venv/bin`, which `src/sandbox/run.ts` puts on PATH by
 * itself) to measure it.
 *
 * No network, no API. Needs `python3` on PATH; without it every series reports `unavailable` and the probe is
 * skipped rather than failed. Off the release set (it spawns interpreters): `JEVCODE_PERF_ONLY=lane-run jevcode perf`.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { percentile } from '../core/time.js';
import { createSandbox } from '../sandbox/run.js';
import type { ExecResult, SandboxRunOptions } from '../core/types.js';

/** the gate of §6 S1: the warm path must be at least this many times the cold path's p50 */
export const WARM_SPEEDUP_GATE = 2;

/** What S1's `src/sandbox/pool.ts` plugs in: run one command on a warm worker, same contract as `Sandbox.run`. */
export interface WarmRunner {
  name: string;
  run(command: string, opts: { cwd: string; timeoutMs: number }): Promise<{ code: number | null }>;
  dispose?(): Promise<void>;
}

export interface LaneSeries {
  /** 'cold' or the warm runner's name */
  arm: string;
  samples: number[];
  p50: number | null;
  p95: number | null;
  /** runs that did not produce the exit code the cold arm produced — a warm arm that answers differently is not a lane */
  disagreements: number;
}

export interface LaneMode {
  /** `candidate_file` (QuixBugs run_tests.py) or `pytest` (a ladder task) */
  mode: 'candidate_file' | 'pytest';
  command: string;
  cwd: string;
  cold: LaneSeries | null;
  warm: LaneSeries | null;
  /** cold p50 / warm p50; null while the warm arm is pending */
  speedup: number | null;
  /** 'pass' / 'FAIL' once both arms ran; 'pending' while M6 does not exist; 'unavailable' without the fixture */
  gate: 'pass' | 'FAIL' | 'pending' | 'unavailable';
  note: string;
}

export interface LaneRunResult {
  runs: number;
  python: string | null;
  /** §5's floor table, re-measured here so the removable fraction of each mode is readable */
  floors: { name: string; p50: number | null }[];
  modes: LaneMode[];
  gateSpeedup: number;
  /** false only when a warm arm was supplied and missed the gate; a pending probe never fails the run */
  pass: boolean;
}

function stats(arm: string, samples: number[], disagreements: number): LaneSeries {
  return { arm, samples, p50: percentile(samples, 50), p95: percentile(samples, 95), disagreements };
}

function pythonOnPath(): string | null {
  for (const candidate of ['python3', 'python']) {
    const r = spawnSync(candidate, ['-c', 'pass'], { stdio: 'ignore' });
    if (r.status === 0) return candidate;
  }
  return null;
}

/** p50 of `n` bare `spawnSync` runs, for the floor rows (`/bin/sh -c true`, `python3 -c pass`, `import pytest`). */
function floor(file: string, args: readonly string[], n: number): number | null {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    spawnSync(file, [...args], { stdio: 'ignore' });
    samples.push(performance.now() - t0);
  }
  return percentile(samples, 50);
}

/**
 * The §6 S1 gate, as arithmetic: the warm arm ships only at ≥ `WARM_SPEEDUP_GATE`× the cold p50 **and** only if it
 * agreed with the cold arm's exit code on every run. Disagreement is not a slower pass, it is §8 R-1's false-pass
 * channel (a warm interpreter keeping `sys.modules` between candidates), and the design's rule for it is "dropped,
 * not softened". A missing warm arm is `pending`, never `pass`: S1 cannot be waved through on an unmeasured gate.
 */
export function laneGate(cold: LaneSeries, warm: LaneSeries | null, runs: number): { speedup: number | null; gate: LaneMode['gate']; note: string } {
  if (warm === null) return { speedup: null, gate: 'pending', note: 'warm arm pending: src/sandbox/pool.ts (wave S1, M6) — pass a WarmRunner to close the gate' };
  if (warm.disagreements > 0) {
    return { speedup: null, gate: 'FAIL', note: `${warm.disagreements} of ${runs} warm runs disagreed with the cold exit code — dropped, not softened (§8 R-1)` };
  }
  const speedup = warm.p50 !== null && warm.p50 > 0 && cold.p50 !== null ? cold.p50 / warm.p50 : null;
  if (speedup === null) return { speedup: null, gate: 'FAIL', note: 'no usable p50 on one of the arms' };
  return { speedup, gate: speedup >= WARM_SPEEDUP_GATE ? 'pass' : 'FAIL', note: `${speedup.toFixed(2)}× against the ≥ ${WARM_SPEEDUP_GATE}× gate` };
}

/** the first non-empty line of a run's output, for the `unavailable` reason (never more than 120 chars). */
function firstLine(r: ExecResult): string {
  const line = `${r.stderr}\n${r.stdout}`.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '(no output)';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * `root` is the checkout the fixtures are resolved against — `PerfRunOptions.cwd`, which is `process.cwd()` in
 * production. It is passed in rather than read here so that what a `runPerf` was told its working directory is, is
 * also what this probe measures; reading `process.cwd()` made the injection silently untrue for the one probe that
 * depends on tree layout.
 */
export async function measureLaneRun(opts: { runs?: number; root?: string; warmRunner?: WarmRunner | null; env?: Record<string, string>; onProgress?: (line: string) => void } = {}): Promise<LaneRunResult> {
  const runs = opts.runs ?? 10;
  const progress = opts.onProgress ?? ((): void => undefined);
  const python = pythonOnPath();
  const repo = opts.root ?? process.cwd();
  const quixbugs = resolve(repo, 'bench/data/quixbugs');
  const ladder = resolve(repo, 'bench/data/ladder/tasks/account');

  const result: LaneRunResult = { runs, python, floors: [], modes: [], gateSpeedup: WARM_SPEEDUP_GATE, pass: true };
  if (python === null) {
    progress('python3 is not on PATH: lane-run reports unavailable (this probe measures a real candidate run)');
    for (const mode of ['candidate_file', 'pytest'] as const) {
      result.modes.push({ mode, command: '', cwd: '', cold: null, warm: null, speedup: null, gate: 'unavailable', note: 'python3 not on PATH' });
    }
    return result;
  }

  result.floors = [
    { name: '/bin/sh -c true', p50: floor('/bin/sh', ['-c', 'true'], runs) },
    { name: `${python} -c pass`, p50: floor(python, ['-c', 'pass'], runs) },
    { name: `${python} -c "import pytest"`, p50: floor(python, ['-c', 'import pytest'], runs) },
  ];
  for (const f of result.floors) progress(`floor ${f.name.padEnd(26)} p50 ${(f.p50 ?? 0).toFixed(1)} ms`);

  const dir = mkdtempSync(join(tmpdir(), 'jevcode-perf-lane-'));
  try {
    interface Spec {
      mode: LaneMode['mode'];
      command: string;
      cwd: string;
      available: boolean;
      why: string;
      /** the reason this run is not a lane run, or null when it is (see the header: an unimportable pytest is fast) */
      invalid: (r: ExecResult) => string | null;
    }
    const specs: Spec[] = [
      {
        mode: 'candidate_file',
        command: `${python} run_tests.py gcd programs/gcd.py`,
        cwd: quixbugs,
        available: existsSync(join(quixbugs, 'run_tests.py')) && existsSync(join(quixbugs, 'programs', 'gcd.py')),
        why: 'bench/data/quixbugs/run_tests.py is not in this tree',
        // run_tests.py prints exactly one JSON line with the case counts; anything else means it never ran the cases
        invalid: (r) => (/"total"\s*:/.test(r.stdout) ? null : `run_tests.py printed no result line (exit ${String(r.exitCode)}): ${firstLine(r)}`),
      },
      {
        mode: 'pytest',
        command: `${python} -m pytest -q -p no:cacheprovider`,
        cwd: ladder,
        available: existsSync(join(ladder, 'pytest.ini')),
        why: 'bench/data/ladder/tasks/account is not in this tree',
        invalid: (r) =>
          /No module named pytest/.test(r.stderr)
            ? 'pytest is not importable under the sandbox env scrub (HOME is <runDir>/home, so the user site-packages is out of reach) — give the workspace a .venv/bin or pass env'
            : /\d+ (?:passed|failed|error)/.test(r.stdout)
              ? null
              : `pytest printed no summary (exit ${String(r.exitCode)}): ${firstLine(r)}`,
      },
    ];

    for (const spec of specs) {
      if (!spec.available) {
        result.modes.push({ mode: spec.mode, command: spec.command, cwd: spec.cwd, cold: null, warm: null, speedup: null, gate: 'unavailable', note: spec.why });
        progress(`${spec.mode.padEnd(14)} unavailable: ${spec.why}`);
        continue;
      }
      // the real cold path: one fresh sandboxed shell per candidate, exactly what src/jev-modes/synth/sieve/runner.ts does
      const sandbox = createSandbox({ workspaceRoot: spec.cwd, runDir: join(dir, spec.mode), profile: 'auto', noNetwork: true, secretReadDenies: [], redact: (s) => s });
      const runOpts: SandboxRunOptions = { timeoutMs: 120_000, maxOutputBytes: 64 * 1024, signal: new AbortController().signal, cwd: spec.cwd, ...(opts.env !== undefined ? { env: opts.env } : {}) };
      const first: ExecResult = await sandbox.run(spec.command, runOpts); // warm-up: the OS page cache and the .pyc are not what this measures
      const invalid = spec.invalid(first);
      if (invalid !== null) {
        result.modes.push({ mode: spec.mode, command: spec.command, cwd: spec.cwd, cold: null, warm: null, speedup: null, gate: 'unavailable', note: invalid });
        progress(`${spec.mode.padEnd(14)} unavailable: ${invalid}`);
        continue;
      }
      const expected = first.exitCode;
      const cold: number[] = [];
      let coldDisagree = 0;
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        const r = await sandbox.run(spec.command, runOpts);
        cold.push(performance.now() - t0);
        if (r.exitCode !== expected) coldDisagree += 1;
      }
      const coldSeries = stats('cold', cold, coldDisagree);
      progress(`${spec.mode.padEnd(14)} cold  p50 ${(coldSeries.p50 ?? 0).toFixed(1)} ms  p95 ${(coldSeries.p95 ?? 0).toFixed(1)} ms  (${spec.command})`);

      let warmSeries: LaneSeries | null = null;
      const runner = opts.warmRunner ?? null;
      if (runner !== null) {
        const warm: number[] = [];
        let warmDisagree = 0;
        await runner.run(spec.command, { cwd: spec.cwd, timeoutMs: 120_000 });
        for (let i = 0; i < runs; i++) {
          const t0 = performance.now();
          const r = await runner.run(spec.command, { cwd: spec.cwd, timeoutMs: 120_000 });
          warm.push(performance.now() - t0);
          if (r.code !== expected) warmDisagree += 1;
        }
        warmSeries = stats(runner.name, warm, warmDisagree);
        progress(`${spec.mode.padEnd(14)} warm  p50 ${(warmSeries.p50 ?? 0).toFixed(1)} ms  p95 ${(warmSeries.p95 ?? 0).toFixed(1)} ms  (${runner.name})`);
      }

      const verdict = laneGate(coldSeries, warmSeries, runs);
      if (verdict.gate === 'FAIL') result.pass = false;
      result.modes.push({ mode: spec.mode, command: spec.command, cwd: spec.cwd, cold: coldSeries, warm: warmSeries, ...verdict });
      progress(`${spec.mode.padEnd(14)} gate  ${verdict.gate}: ${verdict.note}`);
    }
    return result;
  } finally {
    await opts.warmRunner?.dispose?.().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}
