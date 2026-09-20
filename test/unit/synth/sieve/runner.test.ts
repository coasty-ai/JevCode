import { exec } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExecResult, SandboxRunOptions } from '../../../../src/core/types.js';
import { fitOracle, shellWords } from '../../../../src/synth/search/budget.js';
import type { OracleModel, VerifyOutcome, VerifyStatus } from '../../../../src/synth/search/types.js';
import { sha12 } from '../../../../src/core/hash.js';
import { classifyOutcome, fullSuiteCommand, goalPasses, goalTestFiles, MAX_FULL_SUITE_RUNS_PER_STEP, restrictToFiles, type RunnerContext, type RunnerMemory, runQueue, subsetCommand, subsetScope } from '../../../../src/synth/sieve/runner.js';
import { progress } from '../../../../src/synth/verify/progress.js';
import { summarize } from '../../../../src/synth/verify/index.js';
import type { Candidate } from '../../../../src/synth/types.js';
import { base, budget, candidate, execResult, fakeSandbox, fifoQueue, GCD_BASELINE, GCD_BUGGY, GCD_BUGGY_INPUTS, GCD_CORRECT, GCD_TESTS, goal, job, oracle, QUIXBUGS_DIR, runTestsJson, site, sourceFile, summary } from './helpers.js';

let tmp: string;
let ws: string;
let runDir: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jev-runner-'));
  ws = join(tmp, 'ws');
  runDir = join(tmp, 'run');
  mkdirSync(ws);
  mkdirSync(runDir);
  writeFileSync(join(ws, 'gcd.py'), GCD_BUGGY);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const gcd = sourceFile('gcd.py', GCD_BUGGY);
const GOAL = goal(GCD_TESTS);
const b0 = base([gcd], GCD_BASELINE);

interface Emitted {
  phase: string;
  detail: string;
  candidates?: number;
  tested?: number;
}
function ctxFor(sandbox: RunnerContext['sandbox'], over: Partial<RunnerContext> = {}): RunnerContext & { events: Emitted[] } {
  const events: Emitted[] = [];
  return {
    runDir,
    sandbox,
    signal: new AbortController().signal,
    workspaceInfo: { root: ws, git: true },
    step: 3,
    emit: (e) => events.push({ phase: e.phase, detail: e.detail, ...(e.candidates !== undefined ? { candidates: e.candidates } : {}), ...(e.tested !== undefined ? { tested: e.tested } : {}) }),
    events,
    ...over,
  };
}
function memFor(o: OracleModel, over: Partial<RunnerMemory> = {}): RunnerMemory {
  return { baseline: GCD_BASELINE, oracle: o, stepBudget: budget(), tried: new Set(), ...over };
}

/** Candidate texts carry markers the fake runner keys off (the real one only sees the file). */
const FIX = 'return gcd(b, a % b)';
const cands = {
  plausible: candidate(site(gcd, 5), FIX),
  partial: candidate(site(gcd, 5), 'return gcd(a % b, b)  # PARTIAL'),
  regressed: candidate(site(gcd, 5), 'return gcd(a % b, b)  # REGRESS'),
  unchanged: candidate(site(gcd, 5), 'return gcd(a % b, a)'),
  timeout: candidate(site(gcd, 5), 'return gcd(a, b)  # TIMEOUT'),
  stale: { ...candidate(site(gcd, 5), FIX), site: { ...site(gcd, 5), currentLine: '        return something_else' } } as Candidate,
};

/** A run_tests.py-shaped sandbox: reads the lane's candidate file and answers with canned JSON. */
function quixbugsFake(hook?: (cmd: string, opts: SandboxRunOptions) => void) {
  return fakeSandbox((cmd, opts): Partial<ExecResult> => {
    hook?.(cmd, opts);
    const words = shellWords(cmd);
    const at = words.findIndex((w) => w.endsWith('run_tests.py'));
    if (at === -1) return {};
    const src = readFileSync(words[at + 2] ?? '', 'utf8');
    if (src.includes('TIMEOUT')) return { killedBy: 'timeout', exitCode: null, stdout: '', durationMs: 2000 };
    if (src.includes(FIX)) return { stdout: `${runTestsJson([])}\n`, exitCode: 0, durationMs: 250 };
    if (src.includes('PARTIAL')) return { stdout: `${runTestsJson(GCD_BUGGY_INPUTS.slice(0, 2))}\n`, exitCode: 1, durationMs: 260 };
    if (src.includes('REGRESS')) return { stdout: `${runTestsJson([...GCD_BUGGY_INPUTS, [17, 0]])}\n`, exitCode: 1, durationMs: 270 };
    return { stdout: `${runTestsJson(GCD_BUGGY_INPUTS)}\n`, exitCode: 1, durationMs: 300 };
  });
}

describe('command builders', () => {
  const lane = { index: 0, dir: '/run/synth/lane0', mode: 'candidate_file' as const, busy: false };
  it('QuixBugs: run_tests.py <name> <lane candidate> with the adaptive per-test timeout; the full suite is the same command', () => {
    const o = fitOracle(GCD_BASELINE, { commandTimeoutMs: 120_000, wallRemainingMs: 600_000, workspace: { git: true } });
    const cmd = subsetCommand(o, GOAL, lane, { command: GCD_BASELINE.command, workspaceRoot: ws });
    expect(cmd).toBe(`PYTHONDONTWRITEBYTECODE=1 python3 '${QUIXBUGS_DIR}/run_tests.py' 'gcd' '/run/synth/lane0/gcd.py' --max-failures 1000 --timeout 0.5`);
    expect(fullSuiteCommand(o, lane, { command: GCD_BASELINE.command, workspaceRoot: ws })).toBe(cmd);
    // an absolute program path on the baseline command is made lane-relative; --slow is kept
    const abs = `python3 '${QUIXBUGS_DIR}/run_tests.py' knapsack '${ws}/knapsack.py' --slow`;
    expect(subsetCommand({ ...o, perTestTimeoutMs: null }, GOAL, lane, { command: abs, workspaceRoot: ws })).toBe(`PYTHONDONTWRITEBYTECODE=1 python3 '${QUIXBUGS_DIR}/run_tests.py' 'knapsack' '/run/synth/lane0/knapsack.py' --max-failures 1000 --slow`);
    expect(subsetScope(o, GOAL)).toEqual({ kind: 'full' });
    // the context form builds the same command for the workspace (the engine's goal-subset `run` step)
    const ctx = { workspaceInfo: { root: ws, git: true } };
    expect(subsetCommand(ctx, { oracle: o, baseline: GCD_BASELINE }, GOAL)).toBe(`PYTHONDONTWRITEBYTECODE=1 python3 '${QUIXBUGS_DIR}/run_tests.py' 'gcd' '${ws}/gcd.py' --max-failures 1000 --timeout 0.5`);
    expect(() => subsetCommand(ctx, { oracle: o, baseline: null }, GOAL)).toThrow(/RunnerError: subsetCommand needs a baseline/);
    // a run_tests.py named relative to the workspace is anchored there: the lane command runs with cwd = lane
    expect(subsetCommand({ ...o, perTestTimeoutMs: null }, GOAL, lane, { command: 'python3 quixbugs/run_tests.py gcd gcd.py', workspaceRoot: ws })).toBe(`PYTHONDONTWRITEBYTECODE=1 python3 '${ws}/quixbugs/run_tests.py' 'gcd' '/run/synth/lane0/gcd.py' --max-failures 1000`);
  });
  it('pytest: the goal test files (failing tests plus the passing tests beside them); full command unchanged', () => {
    const o = oracle({ runner: 'pytest' });
    const g = goal(['tests/test_a.py::test_x[0]', 'tests/test_a.py::test_y', 'tests/test b.py::T::test_z', '<test run>']);
    expect(goalTestFiles(g)).toEqual(['tests/test_a.py', 'tests/test b.py']);
    const spec = { command: 'python3 -m pytest -q', workspaceRoot: ws };
    expect(subsetCommand(o, g, lane, spec)).toBe(`python3 -m pytest -q 'tests/test_a.py' 'tests/test b.py'`);
    expect(fullSuiteCommand(o, lane, spec)).toBe('python3 -m pytest -q');
    expect(subsetCommand(o, goal(['<test run>']), lane, spec)).toBe('python3 -m pytest -q');
    expect(subsetCommand({ workspaceInfo: { root: ws, git: true } }, { oracle: o, baseline: summary({ command: 'python3 -m pytest -q', failing: g.tests }) }, g)).toBe(`python3 -m pytest -q 'tests/test_a.py' 'tests/test b.py'`);
    expect(subsetCommand(oracle({ runner: 'other' }), g, lane, { command: 'npm test', workspaceRoot: ws })).toBe('npm test');
  });
});

describe('classification (pure)', () => {
  const before = summary({ passing: ['t::a', 't::b'], failing: ['t::c'] });
  it('the status table', () => {
    const pass = summary({ passing: ['t::a', 't::b', 't::c'] });
    const pP = progress(before, pass);
    expect(goalPasses({ tests: ['t::c'] }, pass, pP)).toBe(true);
    expect(classifyOutcome({ subset: pass, subsetProgress: pP, passesGoal: true, full: pass, fullProgress: pP })).toBe('plausible');
    const broke = summary({ passing: ['t::c', 't::b'], failing: ['t::a'] });
    expect(classifyOutcome({ subset: pass, subsetProgress: pP, passesGoal: true, full: broke, fullProgress: progress(before, broke) })).toBe('regressed');
    expect(classifyOutcome({ subset: broke, subsetProgress: progress(before, broke), passesGoal: false })).toBe('regressed');
    const partial = summary({ passing: ['t::a', 't::b', 't::c'], failing: ['t::d'] });
    const wider = summary({ passing: ['t::a', 't::b'], failing: ['t::c', 't::d'] });
    expect(classifyOutcome({ subset: partial, subsetProgress: progress(wider, partial), passesGoal: false })).toBe('partial');
    expect(classifyOutcome({ subset: before, subsetProgress: progress(before, before), passesGoal: false })).toBe('unchanged');
    const killed = summary({ timedOut: true, failing: ['<test run>'] });
    expect(classifyOutcome({ subset: killed, subsetProgress: progress(before, killed), passesGoal: false })).toBe('timeout');
    expect(classifyOutcome({ subset: pass, subsetProgress: pP, passesGoal: true, full: killed, fullProgress: progress(before, killed) })).toBe('timeout');
  });
  it('goalPasses: a collection error (nothing passed, one error the base did not have, the module as the failing id) is never a pass', () => {
    // the first live run: an IndentationError candidate → `ERROR tests/test_inventory.py`, 0 passed; the goal test is not in `failing`
    const collection = summary({ passed: 0, errors: 1, failing: ['t'], passing: [] });
    expect(goalPasses({ tests: ['t::c'] }, collection, progress(before, collection))).toBe(false);
    expect(classifyOutcome({ subset: collection, subsetProgress: progress(before, collection), passesGoal: false })).toBe('regressed');
    // more errors than the base (a test now errors instead of failing) is not a pass either
    const erroring = summary({ passed: 2, errors: 1, failing: [], passing: ['t::a', 't::b'] });
    expect(goalPasses({ tests: ['t::c'] }, erroring, progress(before, erroring))).toBe(false);
    // the base's own errors are tolerated: the goal test passing alongside them is a pass
    const baseWithError = summary({ passing: ['t::a'], failing: ['t::c'], errors: 1 });
    const passWithError = summary({ passing: ['t::a', 't::c'], errors: 1 });
    expect(goalPasses({ tests: ['t::c'] }, passWithError, progress(baseWithError, passWithError))).toBe(true);
  });
  it('goalPasses: a vanished goal test, a run failure or an empty run is never a pass', () => {
    const vanished = summary({ passing: ['t::a', 't::b'] });
    expect(goalPasses({ tests: ['t::c'] }, vanished, progress(before, vanished))).toBe(false);
    const runFail = summary({ passing: ['t::a', 't::b', 't::c'], failing: ['<test run>'] });
    expect(goalPasses({ tests: ['t::c'] }, runFail, progress(before, runFail))).toBe(false);
    const empty = summary({});
    expect(goalPasses({ tests: ['t::c'] }, empty, progress(before, empty))).toBe(false);
  });
  it('restrictToFiles keeps only the goal files when the ids are known', () => {
    const s = summary({ passing: ['tests/a.py::x', 'tests/b.py::y'], failing: ['tests/a.py::z'] });
    expect(restrictToFiles(s, ['tests/a.py'])).toMatchObject({ passing: ['tests/a.py::x'], failing: ['tests/a.py::z'], passed: 1, failed: 1, total: 2 });
    expect(restrictToFiles(summary({ passed: 3, failing: ['tests/a.py::z'] }), ['tests/a.py'])).toBeNull();
  });
});

describe('runQueue on the QuixBugs runner (scripted run_tests.py JSON)', () => {
  it('classifies every status, charges the budget, records tried, refines t_run, emits one synth event', async () => {
    const sb = quixbugsFake();
    const ctx = ctxFor(sb);
    const o = oracle({ runner: 'quixbugs', lanes: 8, perTestTimeoutMs: 500 });
    const mem = memFor(o);
    const q = fifoQueue([cands.plausible, cands.partial, cands.regressed, cands.unchanged, cands.timeout, cands.stale].map((c) => job(c, b0)));
    const out = await runQueue(ctx, mem, q, GOAL, 100);
    expect(out.map((r) => r.status)).toEqual<VerifyStatus[]>(['plausible', 'partial', 'regressed', 'unchanged', 'timeout', 'apply_failed']);
    const plausible = out[0] as VerifyOutcome;
    expect(plausible.full).toBe(plausible.subset); // the JSON suite is the whole suite: no second run
    expect(plausible.progress.allPass).toBe(true);
    expect(plausible.progress.newlyPassing).toEqual(GCD_TESTS);
    expect(plausible.applied.files[0]?.after).toContain(FIX);
    expect(out[1]?.progress.newlyPassing).toEqual(GCD_TESTS.slice(2));
    expect(out[2]?.progress.newlyFailing).toEqual(['gcd(17, 0)']);
    expect(out[4]?.subset.timedOut).toBe(true);
    expect(out[5]?.subset.failures[0]?.actual).toMatch(/stale site/);
    expect(out[5]?.full).toBeUndefined();

    const runs = sb.calls.filter((c) => c.command.includes('run_tests.py'));
    expect(runs).toHaveLength(5); // the stale candidate never ran
    expect(runs.every((c) => c.cwd !== undefined && c.cwd.startsWith(join(runDir, 'tmp', 'synth', 'lane')))).toBe(true);
    expect(runs.every((c) => c.command.includes('--timeout 0.5') && c.timeoutMs === o.runTimeoutMs)).toBe(true);
    expect(mem.stepBudget.testRunsLeft).toBe(1500 - 5);
    expect(mem.stepBudget.testWallLeftMs).toBeLessThanOrEqual(90_000);
    expect(mem.tried.size).toBe(5);
    expect(mem.tried.has(sha12(plausible.applied.diff))).toBe(true);
    expect(mem.oracle.tRunMs.goalSubset).toBe(270); // median of 250, 260, 270, 300, 2000
    expect(mem.lanes?.mode).toBe('candidate_file');
    expect(ctx.events).toEqual([{ phase: 'verify', detail: expect.stringMatching(/^g1: 6 tested on 8 lanes \(1 plausible, 1 partial, 1 regressed, 1 unchanged, 1 timeout, 1 apply_failed\); runs left 1495/), candidates: 6, tested: 6 }]);
    expect(readFileSync(join(ws, 'gcd.py'), 'utf8')).toBe(GCD_BUGGY); // the workspace is untouched
    await mem.lanes?.disposeLanes();
  });
  it('runsAllowed, testRunsLeft and testWallLeftMs each stop dispatch; the rest stays queued', async () => {
    const o = oracle({ runner: 'quixbugs', lanes: 2 });
    const jobs = () => [cands.unchanged, cands.unchanged, cands.unchanged, cands.unchanged].map((c) => job(c, b0));
    const q1 = fifoQueue(jobs());
    expect((await runQueue(ctxFor(quixbugsFake()), memFor(o), q1, GOAL, 2)).length).toBe(2);
    expect(q1.size).toBe(2);
    const q2 = fifoQueue(jobs());
    const mem2 = memFor(o, { stepBudget: budget({ testRunsLeft: 1 }) });
    expect((await runQueue(ctxFor(quixbugsFake()), mem2, q2, GOAL, 100)).length).toBe(1);
    // two lanes popped two jobs; the second found no run left and was deferred, not lost
    expect(q2.size).toBe(2);
    expect(mem2.deferred?.get(GOAL.id)).toHaveLength(1);
    expect(mem2.stepBudget.testRunsLeft).toBe(0);
    expect(mem2.stepBudget.exhausted()).toBe(true);
    const q3 = fifoQueue(jobs());
    expect((await runQueue(ctxFor(quixbugsFake()), memFor(o, { stepBudget: budget({ testWallLeftMs: 0 }) }), q3, GOAL, 100)).length).toBe(0);
    expect(q3.size).toBe(4);
    // the wall is charged by elapsed time, measured with the injected clock
    let t = 1000;
    const mem4 = memFor(o, { stepBudget: budget({ testWallLeftMs: 5000 }) });
    await runQueue(ctxFor(quixbugsFake(() => (t += 700))), mem4, fifoQueue(jobs()), GOAL, 100, { now: () => t });
    expect(mem4.stepBudget.testWallLeftMs).toBe(5000 - 4 * 700);
  });
  it('the fifth passer stops dispatch (§4.3), but a QuixBugs passer whose run already completed is never thrown away', async () => {
    // one lane: dispatch stops after the fifth passer, the rest stays in the queue (nothing was spent on it)
    const q1 = fifoQueue(Array.from({ length: 7 }, () => job(cands.plausible, b0)));
    const mem1 = memFor(oracle({ runner: 'quixbugs', lanes: 1 }));
    const out1 = await runQueue(ctxFor(quixbugsFake()), mem1, q1, GOAL, 100);
    expect(out1).toHaveLength(MAX_FULL_SUITE_RUNS_PER_STEP);
    expect(q1.size).toBe(2);
    expect(mem1.deferred?.get(GOAL.id) ?? []).toHaveLength(0);
    // eight lanes: all 7 were popped and run concurrently; the JSON suite is the full suite, so every
    // completed run decides (tests are the oracle) instead of being discarded and re-run next step
    const q2 = fifoQueue(Array.from({ length: 7 }, () => job(cands.plausible, b0)));
    const mem2 = memFor(oracle({ runner: 'quixbugs', lanes: 8 }));
    const out2 = await runQueue(ctxFor(quixbugsFake()), mem2, q2, GOAL, 100);
    expect(out2).toHaveLength(7);
    expect(out2.every((r) => r.status === 'plausible')).toBe(true);
    expect(mem2.stepBudget.testRunsLeft).toBe(1500 - 7);
    expect(mem2.deferred?.get(GOAL.id) ?? []).toHaveLength(0);
    expect(mem2.tried.size).toBe(1); // one distinct diff
  });
  it('a run killed on a timeout the step wall cut short is deferred, not classified timeout or marked tried', async () => {
    const timeouts: number[] = [];
    const sb = quixbugsFake((cmd, opts) => {
      if (cmd.includes('run_tests.py')) timeouts.push(opts.timeoutMs);
    });
    // 2 s of step wall left against a 10 s run timeout: the sandbox kill says nothing about the candidate
    const mem = memFor(oracle({ runner: 'quixbugs', lanes: 1, runTimeoutMs: 10_000 }), { stepBudget: budget({ testWallLeftMs: 2000 }) });
    const out = await runQueue(ctxFor(sb), mem, fifoQueue([job(cands.timeout, b0)]), GOAL, 10, { now: () => 1000 });
    expect(out).toEqual([]);
    // exactly one run: a job deferred during a call is not re-dispatched (and re-charged) within the same call
    expect(timeouts).toEqual([2000]);
    expect(mem.stepBudget.testRunsLeft).toBe(1500 - 1);
    expect(mem.deferred?.get(GOAL.id)).toHaveLength(1);
    expect(mem.tried.size).toBe(0);
    // with the full run timeout the same kill is the candidate's own (probable infinite loop): timeout, tried
    const mem2 = memFor(oracle({ runner: 'quixbugs', lanes: 1, runTimeoutMs: 10_000 }));
    const out2 = await runQueue(ctxFor(quixbugsFake()), mem2, fifoQueue([job(cands.timeout, b0)]), GOAL, 10);
    expect(out2.map((r) => r.status)).toEqual(['timeout']);
    expect(mem2.tried.size).toBe(1);
  });
  it('deferred jobs belong to their goal: a job deferred for g1 is not run against g2', async () => {
    const o = oracle({ runner: 'quixbugs', lanes: 2 });
    const mem = memFor(o, { stepBudget: budget({ testRunsLeft: 1 }) });
    // two lanes pop both jobs; one run is left, so one of them is deferred
    const first = await runQueue(ctxFor(quixbugsFake()), mem, fifoQueue([job(cands.plausible, b0), job(cands.plausible, b0)]), GOAL, 100);
    expect(first.map((r) => r.status)).toEqual(['plausible']);
    expect(mem.deferred?.get(GOAL.id)).toHaveLength(1);
    mem.stepBudget = budget();
    const g2 = goal(['gcd(3, 12)'], { id: 'g2' });
    expect(await runQueue(ctxFor(quixbugsFake()), mem, fifoQueue([]), g2, 100)).toEqual([]);
    expect(mem.deferred?.get(GOAL.id)).toHaveLength(1);
    expect(mem.tried.size).toBe(1);
    const again = await runQueue(ctxFor(quixbugsFake()), mem, fifoQueue([]), GOAL, 100);
    expect(again.map((r) => r.status)).toEqual(['plausible']);
    expect(mem.deferred?.get(GOAL.id)).toHaveLength(0);
  });
  it('ctx.signal: an aborted run is requeued and nothing more is dispatched', async () => {
    const ac = new AbortController();
    const sb = fakeSandbox((cmd) => {
      if (!cmd.includes('run_tests.py')) return {};
      ac.abort();
      return { killedBy: 'abort', exitCode: null, stdout: '' };
    });
    const ctx = ctxFor(sb, { signal: ac.signal });
    const q = fifoQueue([cands.plausible, cands.unchanged, cands.partial].map((c) => job(c, b0)));
    const mem = memFor(oracle({ runner: 'quixbugs', lanes: 1 }));
    const out = await runQueue(ctx, mem, q, GOAL, 100);
    expect(out).toEqual([]);
    expect(q.size).toBe(2);
    expect(mem.deferred?.get(GOAL.id)).toHaveLength(1);
    expect(mem.tried.size).toBe(0); // an aborted run is not "tried"
    expect(sb.calls.filter((c) => c.command.includes('run_tests.py'))).toHaveLength(1);
    expect(ctx.events[0]?.detail).toMatch(/aborted$/);
    // dispatch never starts on an already-aborted signal
    const out2 = await runQueue(ctx, mem, q, GOAL, 100);
    expect(out2).toEqual([]);
    expect(q.size).toBe(2);
    expect(mem.deferred?.get(GOAL.id)).toHaveLength(1);
  });
  it('a sandbox failure is a run failure for that candidate, not an exception for the batch', async () => {
    const sb = fakeSandbox();
    sb.run = async (cmd, opts) => {
      if (cmd.includes('run_tests.py')) throw new Error('SandboxError: cwd outside the run dir');
      return fakeSandbox().run(cmd, opts);
    };
    const out = await runQueue(ctxFor(sb), memFor(oracle({ runner: 'quixbugs', lanes: 1 })), fifoQueue([job(cands.plausible, b0)]), GOAL, 1);
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe('regressed'); // a synthetic <test run> failure the baseline did not have
    expect(out[0]?.subset.failures[0]?.actual).toMatch(/SandboxError/);
  });
  it('throws without a baseline', async () => {
    await expect(runQueue(ctxFor(quixbugsFake()), memFor(oracle(), { baseline: null }), fifoQueue([]), GOAL, 1)).rejects.toThrow(/RunnerError: runQueue needs a baseline/);
  });
});

describe('runQueue on pytest (worktree lanes, scripted output)', () => {
  const PY_BASE = summary({ command: 'python3 -m pytest -q', passing: ['tests/test_a.py::test_y', 'tests/test_b.py::test_z'], failing: ['tests/test_a.py::test_x'], durationMs: 3000 });
  const pyGoal = goal(['tests/test_a.py::test_x'], { suspectedFiles: ['mod.py'] });
  const mod = sourceFile('mod.py', 'X = 1\n');
  const pyBase = base([mod], PY_BASE);
  const subsetOut = (pass: boolean) => (pass ? 'tests/test_a.py::test_x PASSED\ntests/test_a.py::test_y PASSED\n2 passed in 0.01s\n' : 'tests/test_a.py::test_x FAILED\ntests/test_a.py::test_y PASSED\nFAILED tests/test_a.py::test_x - assert 1 == 2\n1 failed, 1 passed in 0.01s\n');
  function pytestFake(fullOut: string, fullExit: number) {
    return fakeSandbox((cmd, opts): Partial<ExecResult> => {
      if (!cmd.startsWith('python3')) return {}; // git / mkdir / rm bookkeeping
      const lane = opts.cwd ?? '';
      const fixed = readFileSync(join(lane, 'mod.py'), 'utf8').includes('X = 2');
      if (cmd === `python3 -m pytest -q 'tests/test_a.py'`) return { stdout: subsetOut(fixed), exitCode: fixed ? 0 : 1, durationMs: 800 };
      if (cmd === 'python3 -m pytest -q') return { stdout: fullOut, exitCode: fullExit, durationMs: 2500 };
      throw new Error(`unexpected command ${cmd}`);
    });
  }
  it('runs the subset on every candidate and the full suite only for the passer; plausible when nothing newly fails', async () => {
    const sb = pytestFake('tests/test_a.py::test_x PASSED\ntests/test_a.py::test_y PASSED\ntests/test_b.py::test_z PASSED\n3 passed in 0.02s\n', 0);
    writeFileSync(join(ws, 'mod.py'), 'X = 1\n');
    const mem = memFor(oracle({ runner: 'pytest', lanes: 4, tRunMs: { goalSubset: 3000, fullSuite: 3000 } }), { baseline: PY_BASE, stepBudget: budget({ testRunsLeft: 16, testWallLeftMs: 40_000 }) });
    const q = fifoQueue([job(candidate(site(mod, 1), 'X = 2'), pyBase), job(candidate(site(mod, 1), 'X = 3'), pyBase)]);
    const out = await runQueue(ctxFor(sb), mem, q, pyGoal, 10);
    expect(out.map((r) => r.status)).toEqual(['plausible', 'unchanged']);
    expect(out[0]?.full?.passed).toBe(3);
    expect(out[0]?.progress.newlyPassing).toEqual(['tests/test_a.py::test_x']);
    expect(out[1]?.full).toBeUndefined();
    const runs = sb.calls.filter((c) => c.command.startsWith('python3'));
    // two subset runs (one per candidate, overlapping on the lanes) and exactly one full-suite run
    expect(runs.map((c) => c.command).sort()).toEqual(['python3 -m pytest -q', `python3 -m pytest -q 'tests/test_a.py'`, `python3 -m pytest -q 'tests/test_a.py'`]);
    expect(runs.map((c) => c.cwd?.startsWith(join(runDir, 'tmp', 'synth', 'lane')))).toEqual([true, true, true]);
    // no bytecode is written on the lanes: a stale .pyc (same size, same mtime second) would run the previous candidate
    expect(runs.every((c) => c.env?.['PYTHONDONTWRITEBYTECODE'] === '1')).toBe(true);
    expect(mem.stepBudget.testRunsLeft).toBe(16 - 3);
    expect(mem.oracle.tRunMs).toEqual({ goalSubset: 800, fullSuite: 2500 });
    expect(mem.lanes?.mode).toBe('worktree');
    expect(sb.calls.some((c) => c.command === 'git checkout -- . && git clean -fdq')).toBe(true);
  });
  it('a subset passer whose full suite breaks another test is regressed', async () => {
    const sb = pytestFake('tests/test_a.py::test_x PASSED\ntests/test_a.py::test_y PASSED\ntests/test_b.py::test_z FAILED\nFAILED tests/test_b.py::test_z - boom\n1 failed, 2 passed in 0.02s\n', 1);
    writeFileSync(join(ws, 'mod.py'), 'X = 1\n');
    const mem = memFor(oracle({ runner: 'pytest', lanes: 4, tRunMs: { goalSubset: 3000, fullSuite: 3000 } }), { baseline: PY_BASE });
    const out = await runQueue(ctxFor(sb), mem, fifoQueue([job(candidate(site(mod, 1), 'X = 2'), pyBase)]), pyGoal, 10);
    expect(out[0]?.status).toBe('regressed');
    expect(out[0]?.progress.newlyFailing).toEqual(['tests/test_b.py::test_z']);
  });
  it('pytest -q baseline without passing ids: the goal subset is measured once on the clean lane and cached per base', async () => {
    const qBase = summary({ command: 'python3 -m pytest -q', passed: 2, failing: ['tests/test_a.py::test_x'], durationMs: 3000 });
    const sb = pytestFake('3 passed in 0.02s\n', 0);
    writeFileSync(join(ws, 'mod.py'), 'X = 1\n');
    const mem = memFor(oracle({ runner: 'pytest', lanes: 1, tRunMs: { goalSubset: 3000, fullSuite: 3000 } }), { baseline: qBase });
    const b = base([mod], qBase);
    const out = await runQueue(ctxFor(sb), mem, fifoQueue([job(candidate(site(mod, 1), 'X = 3'), b), job(candidate(site(mod, 1), 'X = 2'), b)]), pyGoal, 10);
    expect(out.map((r) => r.status)).toEqual(['unchanged', 'plausible']);
    const runs = sb.calls.filter((c) => c.command.startsWith('python3')).map((c) => c.command);
    // baseline subset, candidate 1 subset, candidate 2 subset, candidate 2 full
    expect(runs).toEqual([`python3 -m pytest -q 'tests/test_a.py'`, `python3 -m pytest -q 'tests/test_a.py'`, `python3 -m pytest -q 'tests/test_a.py'`, 'python3 -m pytest -q']);
    expect(mem.subsetBaselines?.size).toBe(1);
    expect(mem.subsetBaselines?.get(`b0|tests/test_a.py`)?.failing).toEqual(['tests/test_a.py::test_x']);
    expect(mem.stepBudget.testRunsLeft).toBe(1500 - 4);
  });
  it('full-suite runs stop after the fifth passer; later passers wait in mem.deferred under the goal and run first next call', async () => {
    const sb = pytestFake('3 passed in 0.02s\n', 0);
    writeFileSync(join(ws, 'mod.py'), 'X = 1\n');
    const mem = memFor(oracle({ runner: 'pytest', lanes: 8, tRunMs: { goalSubset: 3000, fullSuite: 3000 } }), { baseline: PY_BASE });
    const out = await runQueue(ctxFor(sb), mem, fifoQueue(Array.from({ length: 7 }, () => job(candidate(site(mod, 1), 'X = 2'), pyBase))), pyGoal, 100);
    expect(out).toHaveLength(MAX_FULL_SUITE_RUNS_PER_STEP);
    expect(out.every((r) => r.status === 'plausible')).toBe(true);
    const fullRuns = () => sb.calls.filter((c) => c.command === 'python3 -m pytest -q').length;
    expect(fullRuns()).toBe(MAX_FULL_SUITE_RUNS_PER_STEP);
    expect(mem.deferred?.get(pyGoal.id)).toHaveLength(2);
    const again = await runQueue(ctxFor(sb), mem, fifoQueue([]), pyGoal, 100);
    expect(again.map((r) => r.status)).toEqual(['plausible', 'plausible']);
    expect(fullRuns()).toBe(MAX_FULL_SUITE_RUNS_PER_STEP + 2);
    expect(mem.deferred?.get(pyGoal.id)).toHaveLength(0);
  });
  it('a lane that cannot be restored stops dispatch, keeps the batch outcomes, defers its job; with nothing completed it throws', async () => {
    writeFileSync(join(ws, 'mod.py'), 'X = 1\n');
    let resets = 0;
    const failingReset = (failFrom: number) =>
      fakeSandbox((cmd, opts): Partial<ExecResult> => {
        if (cmd === 'git checkout -- . && git clean -fdq') {
          resets += 1;
          return resets >= failFrom ? { exitCode: 128, stderr: 'fatal: unable to write index' } : {};
        }
        if (!cmd.startsWith('python3')) return {};
        const fixed = readFileSync(join(opts.cwd ?? '', 'mod.py'), 'utf8').includes('X = 2');
        return { stdout: subsetOut(fixed), exitCode: fixed ? 0 : 1, durationMs: 800 };
      });
    // the second reset fails: candidate 1 is classified, candidate 2 is deferred, candidate 3 is never popped
    const sb = failingReset(2);
    const ctx = ctxFor(sb);
    const mem = memFor(oracle({ runner: 'pytest', lanes: 1, tRunMs: { goalSubset: 3000, fullSuite: 3000 } }), { baseline: PY_BASE });
    const q = fifoQueue([job(candidate(site(mod, 1), 'X = 3'), pyBase), job(candidate(site(mod, 1), 'X = 4'), pyBase), job(candidate(site(mod, 1), 'X = 5'), pyBase)]);
    const out = await runQueue(ctx, mem, q, pyGoal, 100);
    expect(out.map((r) => r.status)).toEqual(['unchanged']);
    expect(mem.deferred?.get(pyGoal.id)?.map((j) => j.candidate.text)).toEqual(['X = 4']);
    expect(q.size).toBe(1);
    expect(ctx.events[0]?.detail).toMatch(/lane failure: LaneError: `git checkout -- \. && git clean -fdq` failed \(exit 128\)/);
    // the very first reset fails and nothing completed: the step must see the error (the lane pool is unusable)
    resets = 0;
    const mem2 = memFor(oracle({ runner: 'pytest', lanes: 1, tRunMs: { goalSubset: 3000, fullSuite: 3000 } }), { baseline: PY_BASE });
    await expect(runQueue(ctxFor(failingReset(1)), mem2, fifoQueue([job(candidate(site(mod, 1), 'X = 3'), pyBase)]), pyGoal, 100)).rejects.toThrow(/RunnerError: lane failure during g1: LaneError/);
    expect(mem2.deferred?.get(pyGoal.id)).toHaveLength(1);
  });
});

describe('a real QuixBugs run through child_process (gcd)', () => {
  /** A sandbox that really runs `sh -c` in the lane; the only external process the unit tests spawn (run_tests.py is stdlib). */
  function realSandbox() {
    return fakeSandbox(
      (cmd, opts) =>
        new Promise<Partial<ExecResult>>((resolve) => {
          const started = Date.now();
          exec(cmd, { cwd: opts.cwd, timeout: opts.timeoutMs }, (err, stdout, stderr) => {
            const code = err !== null && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code?: number }).code ?? 1) : err === null ? 0 : null;
            resolve({ stdout, stderr, exitCode: code, killedBy: err !== null && (err as { killed?: boolean }).killed === true ? 'timeout' : null, durationMs: Date.now() - started });
          });
        }),
    );
  }
  it('the subset command built for a lane fails the buggy program and passes the correct one', async () => {
    const o = fitOracle(GCD_BASELINE, { commandTimeoutMs: 120_000, wallRemainingMs: 600_000, workspace: { git: true } });
    const lane = { index: 0, dir: join(runDir, 'lane0'), mode: 'candidate_file' as const, busy: false };
    mkdirSync(lane.dir);
    const spec = { command: GCD_BASELINE.command, workspaceRoot: ws };
    const cmd = subsetCommand(o, GOAL, lane, spec);
    const sb = realSandbox();
    writeFileSync(join(lane.dir, 'gcd.py'), GCD_BUGGY);
    const buggy = await sb.run(cmd, { timeoutMs: 60_000, maxOutputBytes: 1 << 20, signal: new AbortController().signal, cwd: lane.dir });
    const sBuggy = summarize(cmd, buggy, buggy.durationMs);
    expect(sBuggy.exitCode).toBe(1);
    expect(sBuggy.total).toBe(6);
    expect(sBuggy.failing).toEqual(expect.arrayContaining(GCD_TESTS));
    writeFileSync(join(lane.dir, 'gcd.py'), GCD_CORRECT);
    const good = await sb.run(cmd, { timeoutMs: 60_000, maxOutputBytes: 1 << 20, signal: new AbortController().signal, cwd: lane.dir });
    const sGood = summarize(cmd, good, good.durationMs);
    expect(sGood).toMatchObject({ exitCode: 0, passed: 6, failed: 0, errors: 0, failing: [] });
    expect(progress(sBuggy, sGood).allPass).toBe(true);
  }, 60_000);
  it('runQueue end to end: the gold line is plausible, a wrong mutation is unchanged', async () => {
    const sb = realSandbox();
    const ctx = ctxFor(sb);
    const o = fitOracle(GCD_BASELINE, { commandTimeoutMs: 120_000, wallRemainingMs: 600_000, workspace: { git: true } });
    const mem = memFor(o);
    const out = await runQueue(ctx, mem, fifoQueue([job(cands.plausible, b0), job(cands.unchanged, b0)]), GOAL, 10);
    expect(out.map((r) => r.status)).toEqual(['plausible', 'unchanged']);
    expect(out[0]?.subset.passed).toBe(6);
    expect(mem.oracle.tRunMs.goalSubset).toBeGreaterThan(0);
    expect(sb.calls.filter((c) => c.command.includes('run_tests.py')).every((c) => c.command.includes('--timeout 0.5'))).toBe(true);
    await mem.lanes?.disposeLanes();
    expect(execResult().ok).toBe(true);
  }, 60_000);
});
