/**
 * Warm/cold verdict parity over EVERY QuixBugs program, buggy and fixed (docs/HARNESS-NEXT-DESIGN.md
 * §6 S1: "a zygote-vs-cold output-equality test over all QuixBugs programs", risk R-1).
 *
 * `npx tsx experiments/fastlane/warm-parity-sweep.mts [--timeout 2] [--programs gcd,kth]`
 *
 * It lives here rather than in `test/unit/` because 41 programs x {buggy, correct} is 82 cold
 * `run_tests.py` processes plus 82 warm ones — minutes of real interpreter work, and the buggy
 * programs that hang cost a per-case cap each. `test/unit/synth/warm/parity.test.ts` keeps the
 * shapes that can regress cheaply (JSON cases, module tests, an unimportable candidate, pytest,
 * a runaway output); this is the exhaustive run, and it is also the instrument that measures the
 * ONE thing the two paths can legitimately disagree about: a deadline.
 *
 * The cold cap covers interpreter start, importing run_tests.py and importing the candidate; the
 * warm one covers a fork. The worker measures that difference and subtracts it, so the same
 * `--timeout T` buys the same candidate compute on both paths. Run this at a small T (0.5) to
 * see how close that gets, and at a realistic one (2, 6) to see the residue. Any disagreement
 * that is NOT a timeout is a real parity bug and exits non-zero.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSandbox } from '../../src/sandbox/run.js';
import type { Lane } from '../../src/synth/search/types.js';
import type { TestRunSummary } from '../../src/synth/types.js';
import { summarize } from '../../src/synth/verify/index.js';
import { quixbugsTestCommand } from '../../src/synth/verify/quixbugs.js';
import { WarmPlane, WARM_OUTPUT_BYTES } from '../../src/synth/warm/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUIXBUGS = join(HERE, '../../bench/data/quixbugs');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const TIMEOUT = Number(arg('timeout', '2'));
const ONLY = arg('programs', '');
/**
 * `--against cold` replaces the warm run with a SECOND cold run: the control. At a small cap a
 * timing-sensitive program disagrees with itself, and a warm/cold disagreement is only evidence
 * against the warm path if cold/cold does not show the same thing under the same load.
 */
const AGAINST = arg('against', 'warm') === 'cold' ? 'cold' : 'warm';

const site = (spawnSync('python3', ['-c', 'import os, pytest; print(os.path.dirname(os.path.dirname(pytest.__file__)))'], { encoding: 'utf8', timeout: 20_000 }).stdout ?? '').trim();
const ENV: Record<string, string> = site === '' ? { PYTHONDONTWRITEBYTECODE: '1' } : { PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: site };

/**
 * Everything a verdict rests on. Object identities in a `repr` (`<generator object flatten at
 * 0x10a…>`) are addresses, not behaviour: two cold runs disagree on them too, so they are
 * normalised away rather than reported as a parity break.
 */
function verdict(s: TestRunSummary): string {
  const norm = (t: string): string => t.replace(/0x[0-9a-f]{6,}/g, '0xADDR');
  return JSON.stringify({
    passed: s.passed,
    failed: s.failed,
    errors: s.errors,
    skipped: s.skipped,
    total: s.total,
    failing: s.failing,
    passing: s.passing,
    exitCode: s.exitCode,
    timedOut: s.timedOut,
    failures: s.failures.map((f) => [f.testId, norm(f.expected), norm(f.actual)]),
  });
}

/** Which side hit the cap; '' when both or neither did, i.e. when the difference is not the cap. */
function capSide(warm: string, cold: string): '' | 'warm' | 'cold' {
  const w = /TIMEOUT after/.test(warm);
  const c = /TIMEOUT after/.test(cold);
  if (w === c) return '';
  return w ? 'warm' : 'cold';
}

const base = mkdtempSync(join(tmpdir(), 'jev-sweep-'));
const ws = join(base, 'ws');
const runDir = join(base, 'run');
const laneDir = join(runDir, 'tmp/synth/lane0');
mkdirSync(ws, { recursive: true });
mkdirSync(laneDir, { recursive: true });
const sandbox = createSandbox({ workspaceRoot: ws, runDir, profile: 'none', noNetwork: false, secretReadDenies: [], redact: (s) => s });
const signal = new AbortController().signal;
const lane: Lane = { index: 0, dir: laneDir, mode: 'candidate_file', busy: false };
const plane = new WarmPlane({ sandbox, signal, runDir, workspaceRoot: ws, mode: 'quixbugs', interpreter: 'python3', bootEnv: ENV });

const all = readdirSync(join(QUIXBUGS, 'programs'))
  .filter((f) => f.endsWith('.py'))
  .map((f) => f.slice(0, -3))
  .sort();
const programs = ONLY === '' ? all : ONLY.split(',').filter((p) => all.includes(p));

let same = 0;
let timeoutOnly = 0;
let warmStricter = 0;
let coldStricter = 0;
const real: string[] = [];
const started = Date.now();
try {
  for (const name of programs) {
    for (const kind of ['programs', 'correct'] as const) {
      const candidate = join(laneDir, `${name}.py`);
      copyFileSync(join(QUIXBUGS, kind, `${name}.py`), candidate);
      const command = quixbugsTestCommand(QUIXBUGS, name, candidate, { timeoutSec: TIMEOUT });
      let a: string;
      if (AGAINST === 'cold') {
        const twin = await sandbox.run(command, { timeoutMs: 300_000, maxOutputBytes: WARM_OUTPUT_BYTES, signal, cwd: laneDir, env: ENV });
        a = verdict(summarize(command, twin, 1));
      } else {
        const hot = await plane.serve(lane, command, 300_000, ENV);
        if (hot === null) throw new Error(`the plane refused to serve ${command}`);
        a = verdict(summarize(command, hot, 1));
      }
      const res = await sandbox.run(command, { timeoutMs: 300_000, maxOutputBytes: WARM_OUTPUT_BYTES, signal, cwd: laneDir, env: ENV });
      const b = verdict(summarize(command, res, 1));
      const label = `${name}/${kind === 'programs' ? 'buggy' : 'correct'}`;
      const side = capSide(a, b);
      if (a === b) same += 1;
      else if (side !== '') {
        timeoutOnly += 1;
        if (side === 'warm') warmStricter += 1;
        else coldStricter += 1;
        console.log(`  ~ ${label}: only the ${side === 'warm' && AGAINST === 'cold' ? 'first' : side} run hit the ${TIMEOUT}s cap`);
      } else {
        real.push(label);
        console.log(`  x ${label}\n    warm ${a.slice(0, 300)}\n    cold ${b.slice(0, 300)}`);
      }
    }
  }
} finally {
  plane.dispose();
  await sandbox.killAll();
  rmSync(base, { recursive: true, force: true });
}

const total = programs.length * 2;
console.log(`\n${programs.length} programs x {buggy, correct} = ${total} pairs at --timeout ${TIMEOUT}, ${AGAINST === 'cold' ? 'COLD vs cold (control)' : 'warm vs cold'}, in ${Math.round((Date.now() - started) / 1000)} s`);
console.log(`identical ${same}/${total}; cap-boundary disagreements ${timeoutOnly} (warm-only ${warmStricter}, cold-only ${coldStricter}); real parity breaks ${real.length}${real.length === 0 ? '' : `: ${real.join(', ')}`}`);
// A warm-only cap hit is the safe direction and is handled: `runTests` discards any warm run
// that hit a deadline and re-runs the command cold (src/synth/sieve/runner.ts, `hitADeadline`),
// so it costs one cold run and cannot become a verdict. A cold-only cap hit is the dangerous
// one — the warm screen would classify a candidate the cold path calls `timeout` — and it is
// what subtracting the measured start-up allowance from the warm cap removes.
console.log(`warm screened ${plane.stats().screened}, fallbacks ${plane.stats().fallbacks}, invalidations ${plane.stats().invalidations}`);
if (real.length > 0) process.exitCode = 1;
