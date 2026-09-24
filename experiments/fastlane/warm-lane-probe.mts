/**
 * Ring-0 probe P2 for wave S1 (docs/HARNESS-NEXT-DESIGN.md §5): the median wall of ONE REAL
 * candidate run, cold-spawn versus through the warm lane runner of §3 M6.
 *
 * `npx tsx experiments/fastlane/warm-lane-probe.mts [--reps 30]`
 *
 * No network, no API, no Jev: it drives the sieve's own fixtures (three QuixBugs programs and
 * one ladder task) through the same `src/sandbox/run.ts` the lanes use. Warm and cold runs are
 * INTERLEAVED, one for one, because the design's §4.2 load caveat applies here too: an absolute
 * number taken on a loaded machine means little, while the ratio of two measurements taken
 * milliseconds apart under the same load is exactly what M6's gate is about.
 *
 * Gate (§6 S1): the warm path must be at least 2x on this probe, or the mechanism is dropped.
 *
 * `--profile seatbelt` runs both paths under the real `sandbox-exec`, which is the configuration
 * the design's justification rests on: the warm worker is started through `ctx.sandbox.run`
 * precisely so that it inherits the profile, and mkfifo / fork / setsid / a 30-minute process
 * are all things a cold run never asks of it. Default `none`, because the ratio is the point and
 * the seatbelt taxes both paths; run it once per change under `seatbelt` as well.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SandboxProfile } from '../../src/core/types.js';
import { createSandbox } from '../../src/sandbox/run.js';
import type { Lane } from '../../src/jev-modes/synth/search/types.js';
import { quixbugsTestCommand } from '../../src/jev-modes/synth/verify/quixbugs.js';
import { summarize } from '../../src/jev-modes/synth/verify/index.js';
import { WarmPlane } from '../../src/jev-modes/synth/warm/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../..');
const QUIXBUGS = join(REPO, 'bench/data/quixbugs');
const LADDER = join(REPO, 'bench/data/ladder/tasks');

const repsArg = process.argv.indexOf('--reps');
const REPS = repsArg === -1 ? 30 : Math.max(3, Number(process.argv[repsArg + 1] ?? 30));
const profileArg = process.argv.indexOf('--profile');
const PROFILE: SandboxProfile = profileArg !== -1 && process.argv[profileArg + 1] === 'seatbelt' ? 'seatbelt' : 'none';

/**
 * The sandbox scrubs the environment and remaps HOME, so a `pip install --user` pytest is not
 * importable inside it. A real workspace carries a `.venv` (which the sandbox puts on PATH); on a
 * developer machine the site directory is handed to BOTH paths, so the comparison stays honest.
 */
const site = (spawnSync('python3', ['-c', 'import os, pytest; print(os.path.dirname(os.path.dirname(pytest.__file__)))'], { encoding: 'utf8', timeout: 20_000 }).stdout ?? '').trim();
const ENV: Record<string, string> = site === '' ? { PYTHONDONTWRITEBYTECODE: '1' } : { PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: site };

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}
function pct(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

interface Row {
  task: string;
  /** a hang-dominated run is reported but not gated: its wall IS the per-case cap on both paths */
  gated: boolean;
  coldP50: number;
  coldP95: number;
  warmP50: number;
  warmP95: number;
  ratio: number;
  agree: boolean;
}

async function measure(task: string, mode: 'quixbugs' | 'pytest', setUp: (laneDir: string) => string, gated = true): Promise<Row> {
  const tmp = mkdtempSync(join(tmpdir(), 'jev-probe-'));
  const ws = join(tmp, 'ws');
  const runDir = join(tmp, 'run');
  const laneDir = join(runDir, 'tmp/synth/lane0');
  mkdirSync(ws, { recursive: true });
  mkdirSync(laneDir, { recursive: true });
  const sandbox = createSandbox({ workspaceRoot: ws, runDir, profile: PROFILE, noNetwork: false, secretReadDenies: [], redact: (s) => s });
  const signal = new AbortController().signal;
  const lane: Lane = { index: 0, dir: laneDir, mode: 'candidate_file', busy: false };
  const command = setUp(laneDir);
  const env = ENV;
  const plane = new WarmPlane({ sandbox, signal, runDir, workspaceRoot: ws, mode, interpreter: 'python3', bootEnv: env });
  const cold: number[] = [];
  const warm: number[] = [];
  let agree = true;
  try {
    // one of each first, off the record: the cold path warms the page cache, the warm path boots
    await sandbox.run(command, { timeoutMs: 120_000, maxOutputBytes: 262_144, signal, cwd: laneDir, env });
    const first = await plane.serve(lane, command, 120_000, env);
    if (first === null) throw new Error(`the warm plane refused to serve: ${command}`);
    for (let i = 0; i < REPS; i++) {
      let t = performance.now();
      const c = await sandbox.run(command, { timeoutMs: 120_000, maxOutputBytes: 262_144, signal, cwd: laneDir, env });
      cold.push(performance.now() - t);
      t = performance.now();
      const w = await plane.serve(lane, command, 120_000, env);
      warm.push(performance.now() - t);
      if (w === null) throw new Error('the warm plane fell back mid-probe');
      const a = summarize(command, c, 1);
      const b = summarize(command, w, 1);
      if (a.passed !== b.passed || a.failed !== b.failed || a.errors !== b.errors || a.total !== b.total || a.failing.join('|') !== b.failing.join('|')) agree = false;
    }
  } finally {
    plane.dispose();
    await sandbox.killAll();
    rmSync(tmp, { recursive: true, force: true });
  }
  return { task, gated, coldP50: median(cold), coldP95: pct(cold, 95), warmP50: median(warm), warmP95: pct(warm, 95), ratio: median(cold) / Math.max(0.001, median(warm)), agree };
}

const quixbugs = (name: string, gated: boolean): Promise<Row> =>
  measure(
    `quixbugs/${name}`,
    'quixbugs',
    (laneDir) => {
      const candidate = join(laneDir, `${name}.py`);
      copyFileSync(join(QUIXBUGS, `programs/${name}.py`), candidate);
      return quixbugsTestCommand(QUIXBUGS, name, candidate, { timeoutSec: 2 });
    },
    gated,
  );

const rows: Row[] = [];
for (const name of ['gcd', 'kth', 'sieve']) rows.push(await quixbugs(name, true));
rows.push(
  await measure('ladder/account', 'pytest', (laneDir) => {
    cpSync(join(LADDER, 'account'), laneDir, { recursive: true });
    return 'python3 -m pytest -q';
  }),
);
// The control: `bitcount`'s buggy program hangs on every case, so its wall is 9 cases against the
// 2 s per-case cap on both paths. The warm runner cannot (and must not) make a hang cheaper; what
// this row proves is that it does not make it dearer, and that the cap still fires inside the fork.
rows.push(await quixbugs('bitcount', false));

const cell = (n: number): string => n.toFixed(1).padStart(8);
console.log(`\nP2 lane-run, ${REPS} interleaved repetitions per task, sandbox profile ${PROFILE} (ms)\n`);
console.log('task                 cold p50  cold p95  warm p50  warm p95     ratio  verdicts');
for (const r of rows) console.log(`${r.task.padEnd(20)}${cell(r.coldP50)}${cell(r.coldP95)}${cell(r.warmP50)}${cell(r.warmP95)}${r.ratio.toFixed(2).padStart(10)}x  ${r.agree ? 'identical' : 'DIFFER'}${r.gated ? '' : '  (hang-dominated control, not gated)'}`);
const worst = Math.min(...rows.filter((r) => r.gated).map((r) => r.ratio));
const allAgree = rows.every((r) => r.agree);
console.log(`\nworst ratio ${worst.toFixed(2)}x against the >= 2x gate: ${worst >= 2 ? 'PASS' : 'FAIL'}; verdicts ${allAgree ? 'identical everywhere' : 'DIFFER — the mechanism is unsafe'}`);
if (!allAgree) process.exitCode = 1;
