/**
 * OOS iteration 2, defects 2 and 4 (experiments/results/llm-jev-iter2.md §10): the warm plane's
 * counters as a RECORD, not as free text.
 *
 * Defect 2. `WarmStats` — `disabledReason`, `fallbacks`, `restarts`, `mismatches`, the screened
 * count — existed only in the clause `warmNote()` appends to the sieve's `synth · verify` event.
 * No archived record carried it (`steps.jsonl`'s `verify` object had no warm field) and
 * `--archive-runs` does not copy `transcript.log`, so the warm A/B iteration 2 was asked for could
 * not be audited from the committed artefacts at all: every warm number in that report was
 * harvested by hand out of `~/.jevcode/runs/<runId>/` before the next arm overwrote it.
 * `src/synth/search/types.ts` had flagged it as "a field and an assignment".
 *
 * Defect 4. `JEVCODE_WARM=on` is a silent no-op when the oracle's runner is not `quixbugs` or
 * `pytest` (`warmModeFor`). SWE-bench's runner is `other`, so iteration 2's "18-task warm A/B" was
 * really an A/B on 14 of them and nothing in any output said so.
 *
 * Both are now on `RunnerMemory.warmStep`, which `search/index.ts` reports as
 * `StepRecord.verify.warm` (core/types.ts `StepWarmSummary`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Lane, VerifyJob } from '../../../../src/synth/search/types.js';
import { emptyStepWarm, recordWarmStep, runQueue, stepWarmFrom, warmPlaneFor, type RunnerContext, type RunnerMemory, type SuiteSpec } from '../../../../src/synth/sieve/runner.js';
import { emptyWarmStats, type WarmRunResult, type WarmScreen, type WarmStats } from '../../../../src/synth/warm/index.js';
import { base, budget, candidate, fakeSandbox, fifoQueue, GCD_BASELINE, GCD_BUGGY, GCD_TESTS, goal, job, oracle, runTestsJson, site, sourceFile } from './helpers.js';

const PREV_JEVCODE_WARM = process.env['JEVCODE_WARM'];
beforeAll(() => {
  process.env['JEVCODE_WARM'] = 'on';
});
afterAll(() => {
  if (PREV_JEVCODE_WARM === undefined) delete process.env['JEVCODE_WARM'];
  else process.env['JEVCODE_WARM'] = PREV_JEVCODE_WARM;
});

let tmp: string;
let ws: string;
let runDir: string;
const emitted: string[] = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jev-warmrec-'));
  ws = join(tmp, 'ws');
  runDir = join(tmp, 'run');
  mkdirSync(ws);
  mkdirSync(runDir);
  writeFileSync(join(ws, 'gcd.py'), GCD_BUGGY);
  emitted.length = 0;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const gcd = sourceFile('gcd.py', GCD_BUGGY);
const GOAL = goal(GCD_TESTS);
const b0 = base([gcd], GCD_BASELINE);
const UNCHANGED = runTestsJson([[13, 13], [37, 600], [20, 100], [624129, 2061517], [3, 12]]);

function ctxFor(sandbox: ReturnType<typeof fakeSandbox>, step = 1): RunnerContext {
  return { runDir, sandbox, signal: new AbortController().signal, workspaceInfo: { root: ws, git: false }, step, emit: (e) => emitted.push(e.detail) };
}
const spec = (command: string): SuiteSpec => ({ command, workspaceRoot: ws });
const hot = (durationMs: number, timedOut = false): WarmRunResult => ({ stdout: UNCHANGED, stderr: '', exitCode: 1, timedOut, truncated: false, durationMs });

function scriptedScreen(answer: (n: number) => WarmRunResult | null): WarmScreen {
  const counts: WarmStats = emptyWarmStats();
  let n = 0;
  let off = false;
  return {
    get disabled(): boolean {
      return off;
    },
    async serve(_lane: Lane, _command: string): Promise<WarmRunResult | null> {
      n += 1;
      counts.offered += 1;
      const r = answer(n);
      if (r === null) counts.fallbacks += 1;
      else {
        counts.screened += 1;
        counts.screenMs += r.durationMs;
      }
      return r;
    },
    confirmed(ms: number): void {
      counts.confirmed += 1;
      counts.confirmMs += ms;
    },
    mismatch(): void {
      counts.mismatches += 1;
      off = true;
      counts.disabledReason = 'screen/confirm mismatch';
    },
    scopeUnusable(): void {
      counts.scopeUnusable += 1;
    },
    deadlineRecheck(): void {
      counts.deadlineRechecks += 1;
    },
    stats: (): WarmStats => ({ ...counts }),
    dispose(): void {
      off = true;
    },
  };
}

function jobsFor(n: number): VerifyJob[] {
  return Array.from({ length: n }, (_, i) => job(candidate(site(gcd, 2), `return a % b  # ${i}`), b0));
}

describe('the step carries the warm counters (iteration-2 defect 2)', () => {
  it('a batch records offered / screened / fallbacks / deadline rechecks on the step, not only in the event text', async () => {
    // 6 offers: 4 served, 1 refused (a fallback), 1 served but timed out and re-run cold
    const screen = scriptedScreen((n) => (n === 5 ? null : n === 6 ? hot(900, true) : hot(120)));
    const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: UNCHANGED, exitCode: 1, durationMs: 400 } : {}));
    const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: oracle({ lanes: 1 }), stepBudget: budget(), tried: new Set(), warm: screen };
    await runQueue(ctxFor(sandbox), mem, fifoQueue(jobsFor(6)), GOAL, 6);
    const w = mem.warmStep;
    expect(w?.step).toBe(1);
    expect(w?.warm.mode).toBe('on');
    expect(w?.warm.offered).toBe(6);
    expect(w?.warm.screened).toBe(5);
    expect(w?.warm.fallbacks).toBe(1);
    expect(w?.warm.deadlineRechecks).toBe(1);
    expect(w?.warm.mismatches).toBe(0);
    expect(w?.warm.screenMs).toBe(4 * 120 + 900);
    expect(w?.warm.disabledReason).toBeUndefined();
    // the same numbers the free text says, which is the point: the record and the transcript agree
    expect(emitted.join('\n')).toContain('warm 5/6');
  });

  it('the counters are the STEP’s: two batches of one step sum, a new step starts over', async () => {
    const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: UNCHANGED, exitCode: 1, durationMs: 400 } : {}));
    // 8 lanes from the start: a `refineLanes` widening rebuilds the lane pool, and a rebuilt pool
    // disposes the plane with it (the workers' cwd is a lane directory that no longer exists)
    const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: oracle({ lanes: 8 }), stepBudget: budget(), tried: new Set(), warm: scriptedScreen(() => hot(100)) };
    await runQueue(ctxFor(sandbox, 1), mem, fifoQueue(jobsFor(2)), GOAL, 2);
    await runQueue(ctxFor(sandbox, 1), mem, fifoQueue(jobsFor(3)), GOAL, 3);
    expect(mem.warmStep?.warm.offered).toBe(5);
    await runQueue(ctxFor(sandbox, 2), mem, fifoQueue(jobsFor(1)), GOAL, 1);
    expect(mem.warmStep?.step).toBe(2);
    // a per-step field summed over the steps must not be a running total
    expect(mem.warmStep?.warm.offered).toBe(1);
  });

  it('a screen/confirm mismatch puts its one-way reason on the record', async () => {
    const PASSING = runTestsJson([]);
    const screen = scriptedScreen(() => ({ stdout: PASSING, stderr: '', exitCode: 0, timedOut: false, truncated: false, durationMs: 40 }));
    // the cold confirmation disagrees: the plane is off for the run and says why
    const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: UNCHANGED, exitCode: 1, durationMs: 400 } : {}));
    const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: oracle({ lanes: 1 }), stepBudget: budget(), tried: new Set(), warm: screen };
    await runQueue(ctxFor(sandbox), mem, fifoQueue([job(candidate(site(gcd, 2), 'return a % b'), b0)]), GOAL, 1);
    expect(mem.warmStep?.warm.mismatches).toBe(1);
    expect(mem.warmStep?.warm.disabledReason).toBe('screen/confirm mismatch');
  });

  it('records nothing at all when the flag never asked for the plane', async () => {
    const prev = process.env['JEVCODE_WARM'];
    process.env['JEVCODE_WARM'] = 'off';
    try {
      const sandbox = fakeSandbox((command) => (/run_tests\.py/.test(command) ? { stdout: UNCHANGED, exitCode: 1, durationMs: 400 } : {}));
      const mem: RunnerMemory = { baseline: GCD_BASELINE, oracle: oracle({ lanes: 1 }), stepBudget: budget(), tried: new Set() };
      await runQueue(ctxFor(sandbox), mem, fifoQueue(jobsFor(2)), GOAL, 2);
      // every warm-off record stays byte-identical to one written before the field existed
      expect(mem.warmStep).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env['JEVCODE_WARM'];
      else process.env['JEVCODE_WARM'] = prev;
    }
  });

  it('recordWarmStep sums, keeps the first disabled reason, and lets `on` win the mode', () => {
    const mem: Pick<RunnerMemory, 'warmStep'> = {};
    recordWarmStep(mem, 3, { ...emptyStepWarm('unsupported-runner'), offered: 0 });
    recordWarmStep(mem, 3, { ...emptyStepWarm('on'), offered: 4, screened: 4, screenMs: 80, disabledReason: 'lane 2 stopped answering' });
    recordWarmStep(mem, 3, { ...emptyStepWarm('on'), offered: 1, fallbacks: 1, disabledReason: 'a later reason' });
    expect(mem.warmStep?.warm.mode).toBe('on');
    expect(mem.warmStep?.warm.offered).toBe(5);
    expect(mem.warmStep?.warm.screenMs).toBe(80);
    expect(mem.warmStep?.warm.disabledReason).toBe('lane 2 stopped answering');
  });

  it('stepWarmFrom drops a null disabledReason rather than writing one', () => {
    expect(stepWarmFrom('on', { ...emptyWarmStats(), offered: 2, screened: 2 })).toEqual({ ...emptyStepWarm('on'), offered: 2, screened: 2 });
    expect(stepWarmFrom('on', { ...emptyWarmStats(), disabledReason: 'why' }).disabledReason).toBe('why');
  });
});

describe('an unsupported runner is recorded, not silently cold (iteration-2 defect 4)', () => {
  it('JEVCODE_WARM=on against a `other` runner records mode = unsupported-runner and says so once', () => {
    const sandbox = fakeSandbox();
    const mem: Pick<RunnerMemory, 'warm' | 'warmStep'> = {};
    const ctx = ctxFor(sandbox);
    // SWE-bench's oracle: `… (repository, other, python…` — `warmModeFor` admits quixbugs and pytest only
    expect(warmPlaneFor(ctx, mem, oracle({ runner: 'other' }), spec('python3 tests/runtests.py'))).toBeNull();
    expect(mem.warmStep?.warm.mode).toBe('unsupported-runner');
    expect(mem.warmStep?.warm.offered).toBe(0);
    expect(emitted.filter((d) => d.includes('unsupported-runner'))).toHaveLength(1);
    expect(emitted.join('\n')).toContain('JEVCODE_WARM=on');
    expect(emitted.join('\n')).toContain('`other` runner has no warm shape');
    // every later batch of the same step records it too, and says it once
    expect(warmPlaneFor(ctx, mem, oracle({ runner: 'other' }), spec('python3 tests/runtests.py'))).toBeNull();
    expect(emitted.filter((d) => d.includes('unsupported-runner'))).toHaveLength(1);
    expect(warmPlaneFor(ctxFor(sandbox, 2), mem, oracle({ runner: 'other' }), spec('python3 tests/runtests.py'))).toBeNull();
    expect(emitted.filter((d) => d.includes('unsupported-runner'))).toHaveLength(2);
  });

  it('a supported runner whose command names no interpreter records unsupported-command', () => {
    const mem: Pick<RunnerMemory, 'warm' | 'warmStep'> = {};
    // a bare `pytest` head: the plane would have to read a shebang to know the interpreter, so it refuses
    expect(warmPlaneFor(ctxFor(fakeSandbox()), mem, oracle({ runner: 'pytest' }), spec('pytest -q'))).toBeNull();
    expect(mem.warmStep?.warm.mode).toBe('unsupported-command');
    expect(emitted.join('\n')).toContain('unsupported-command');
  });

  it('with the flag off an unsupported runner records nothing and says nothing', () => {
    const prev = process.env['JEVCODE_WARM'];
    process.env['JEVCODE_WARM'] = 'off';
    try {
      const mem: Pick<RunnerMemory, 'warm' | 'warmStep'> = {};
      expect(warmPlaneFor(ctxFor(fakeSandbox()), mem, oracle({ runner: 'other' }), spec('python3 tests/runtests.py'))).toBeNull();
      expect(mem.warmStep).toBeUndefined();
      expect(emitted).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env['JEVCODE_WARM'];
      else process.env['JEVCODE_WARM'] = prev;
    }
  });
});
