import { exec } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExecResult, SandboxRunOptions } from '../../../../src/core/types.js';
import { fitOracle, LANE_MAX_CASE_TIMEOUTS, laneRunTimeout, RETRY_CASE_TIMEOUT_MS, RETRY_TIMEOUTS_MAX_PER_BATCH, shellWords } from '../../../../src/synth/search/budget.js';
import type { OracleModel, VerifyOutcome, VerifyStatus } from '../../../../src/synth/search/types.js';
import { sha12 } from '../../../../src/core/hash.js';
import { classifyOutcome, forgetUnchangedTried, fullSuiteCommand, goalPasses, goalTestFiles, LANE_RUN_ENV, laneRunEnv, MAX_FULL_SUITE_RUNS_PER_STEP, restrictToFiles, type RunnerContext, type RunnerMemory, runQueue, runRegressionCheck, subsetCommand, subsetScope, timeoutKind } from '../../../../src/synth/sieve/runner.js';
import { applyCandidate } from '../../../../src/synth/verify/apply.js';
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
  it('a run whose every failing case hit the per-case alarm (or was not run after one) is `timeout`, even where the base hung on the same cases', () => {
    const hangText = 'test_sqrt.CaseTimeout: no result after 0.5s';
    const notRun = 'test_sqrt.CaseNotRun: not run: 1 earlier case(s) timed out';
    const ids = ['t::a', 't::b', 't::c'];
    const hangAll = summary({ failing: ids, failures: ids.map((id) => ({ testId: id, call: id, expected: '1', actual: hangText })) });
    const hangBase = summary({ failing: ids, failures: ids.map((id) => ({ testId: id, call: id, expected: '1', actual: 'test_sqrt.CaseTimeout: no result after 2s' })) });
    // same failing ids as the base: the old table said `unchanged`; the candidate hangs, so it is `timeout` (§4.1: never a base)
    expect(progress(hangBase, hangAll).regressed).toBe(false);
    expect(classifyOutcome({ subset: hangAll, subsetProgress: progress(hangBase, hangAll), passesGoal: false })).toBe('timeout');
    // the lanes' stop rule: one alarm, the rest "not run" — still a hang; a passing case beside them changes nothing
    const stopped = summary({ passing: ['t::z'], failing: ids, failures: [{ testId: 't::a', call: 't::a', expected: '1', actual: hangText }, ...ids.slice(1).map((id) => ({ testId: id, call: id, expected: '1', actual: notRun }))] });
    expect(classifyOutcome({ subset: stopped, subsetProgress: progress(before, stopped), passesGoal: false })).toBe('timeout');
    // a wrong value among the failures: the candidate does not merely hang; the ordinary table applies (here: regressed against `before`)
    const mixed = summary({ failing: ids, failures: [{ testId: 't::a', call: 't::a', expected: '1', actual: hangText }, { testId: 't::b', call: 't::b', expected: '1', actual: '0' }, { testId: 't::c', call: 't::c', expected: '1', actual: notRun }] });
    expect(classifyOutcome({ subset: mixed, subsetProgress: progress(before, mixed), passesGoal: false })).toBe('regressed');
    // a subset passer whose full suite hangs elsewhere is `timeout` too
    const pass = summary({ passing: ['t::a', 't::b', 't::c'] });
    expect(classifyOutcome({ subset: pass, subsetProgress: progress(before, pass), passesGoal: true, full: hangAll, fullProgress: progress(before, hangAll) })).toBe('timeout');
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
    // one oracle per scenario: the runner refines the oracle it is given in place (t_run, and lanes once a run measures under 1 s)
    const o = () => oracle({ runner: 'quixbugs', lanes: 2 });
    const jobs = () => [cands.unchanged, cands.unchanged, cands.unchanged, cands.unchanged].map((c) => job(c, b0));
    const q1 = fifoQueue(jobs());
    expect((await runQueue(ctxFor(quixbugsFake()), memFor(o()), q1, GOAL, 2)).length).toBe(2);
    expect(q1.size).toBe(2);
    const q2 = fifoQueue(jobs());
    const mem2 = memFor(o(), { stepBudget: budget({ testRunsLeft: 1 }) });
    expect((await runQueue(ctxFor(quixbugsFake()), mem2, q2, GOAL, 100)).length).toBe(1);
    // two lanes popped two jobs; the second found no run left and was deferred, not lost
    expect(q2.size).toBe(2);
    expect(mem2.deferred?.get(GOAL.id)).toHaveLength(1);
    expect(mem2.stepBudget.testRunsLeft).toBe(0);
    expect(mem2.stepBudget.exhausted()).toBe(true);
    const q3 = fifoQueue(jobs());
    expect((await runQueue(ctxFor(quixbugsFake()), memFor(o(), { stepBudget: budget({ testWallLeftMs: 0 }) }), q3, GOAL, 100)).length).toBe(0);
    expect(q3.size).toBe(4);
    // the wall is charged by elapsed time, measured with the injected clock
    let t = 1000;
    const mem4 = memFor(o(), { stepBudget: budget({ testWallLeftMs: 5000 }) });
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
  it('runs `oracle.lanes` candidates concurrently: the peak of overlapping test runs equals the lane count', async () => {
    let inFlight = 0;
    let peak = 0;
    const sb = fakeSandbox(async (cmd): Promise<Partial<ExecResult>> => {
      if (!cmd.includes('run_tests.py')) return {};
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 25));
      inFlight -= 1;
      return { stdout: `${runTestsJson(GCD_BUGGY_INPUTS)}\n`, exitCode: 1, durationMs: 25 };
    });
    const mem = memFor(oracle({ runner: 'quixbugs', lanes: 8 }));
    const out = await runQueue(ctxFor(sb), mem, fifoQueue(Array.from({ length: 24 }, () => job(cands.unchanged, b0))), GOAL, 100);
    expect(out).toHaveLength(24);
    expect(peak).toBe(8);
    expect(mem.lanes?.lanes).toHaveLength(8);
    // a narrower oracle overlaps less
    let peak2 = 0;
    let inFlight2 = 0;
    const sb2 = fakeSandbox(async (cmd): Promise<Partial<ExecResult>> => {
      if (!cmd.includes('run_tests.py')) return {};
      inFlight2 += 1;
      peak2 = Math.max(peak2, inFlight2);
      await new Promise((r) => setTimeout(r, 10));
      inFlight2 -= 1;
      return { stdout: `${runTestsJson(GCD_BUGGY_INPUTS)}\n`, exitCode: 1, durationMs: 10 };
    });
    await runQueue(ctxFor(sb2), memFor(oracle({ runner: 'quixbugs', lanes: 3 })), fifoQueue(Array.from({ length: 9 }, () => job(cands.unchanged, b0))), GOAL, 100);
    expect(peak2).toBe(3);
  });
  it('a pool built for fewer lanes than the re-fitted oracle wants is rebuilt at the new width', async () => {
    const sb = quixbugsFake();
    const mem = memFor(oracle({ runner: 'quixbugs', lanes: 2 }));
    await runQueue(ctxFor(sb), mem, fifoQueue([job(cands.unchanged, b0)]), GOAL, 10);
    expect(mem.lanes?.lanes).toHaveLength(2);
    const old = mem.lanes;
    mem.oracle = oracle({ runner: 'quixbugs', lanes: 8 });
    await runQueue(ctxFor(sb), mem, fifoQueue([job(cands.unchanged, b0)]), GOAL, 10);
    expect(mem.lanes).not.toBe(old);
    expect(mem.lanes?.lanes).toHaveLength(8);
    expect(sb.calls.filter((c) => c.command.startsWith('rm -rf')).length).toBeGreaterThanOrEqual(2); // the old lanes were disposed
    // a wider pool than the oracle wants is kept (workers are capped at oracle.lanes)
    mem.oracle = oracle({ runner: 'quixbugs', lanes: 4 });
    const keep = mem.lanes;
    await runQueue(ctxFor(sb), mem, fifoQueue([job(cands.unchanged, b0)]), GOAL, 10);
    expect(mem.lanes).toBe(keep);
  });
  it('a refined t_run under 1 s widens the oracle to 8 lanes and the pool follows at the next call', async () => {
    const withDuration = (ms: number) =>
      fakeSandbox((cmd): Partial<ExecResult> => (cmd.includes('run_tests.py') ? { stdout: `${runTestsJson(GCD_BUGGY_INPUTS)}\n`, exitCode: 1, durationMs: ms } : {}));
    // a 1.5 s baseline burst fitted 4 lanes; the lanes measure 686 ms
    const mem = memFor(oracle({ runner: 'quixbugs', lanes: 4, tRunMs: { goalSubset: 1500, fullSuite: 1500 } }));
    const ctx = ctxFor(withDuration(686));
    await runQueue(ctx, mem, fifoQueue([job(cands.unchanged, b0), job(cands.unchanged, b0)]), GOAL, 10);
    expect(mem.oracle.tRunMs.goalSubset).toBe(686);
    expect(mem.oracle.lanes).toBe(8);
    expect(mem.lanes?.lanes).toHaveLength(4); // the running batch kept its pool
    expect(ctx.events[0]?.detail).toMatch(/t_run 686 ms, lanes 4 → 8/);
    await runQueue(ctx, mem, fifoQueue([job(cands.unchanged, b0)]), GOAL, 10);
    expect(mem.lanes?.lanes).toHaveLength(8);
    // a slow measurement never narrows
    const slow = memFor(oracle({ runner: 'quixbugs', lanes: 8, tRunMs: { goalSubset: 300, fullSuite: 300 } }));
    await runQueue(ctxFor(withDuration(3500)), slow, fifoQueue([job(cands.unchanged, b0)]), GOAL, 10);
    expect(slow.oracle.lanes).toBe(8);
  });
  it('the sandbox timeout of a lane run is laneRunTimeout(oracle, baseline), tighter than the workspace timeout', async () => {
    const timeouts: number[] = [];
    const sb = quixbugsFake((cmd, opts) => {
      if (cmd.includes('run_tests.py')) timeouts.push(opts.timeoutMs);
    });
    // a bitcount-like oracle: 66 s workspace timeout, 738 ms adjusted t_run, 500 ms per test over gcd's 6 cases
    const o = oracle({ runner: 'quixbugs', lanes: 1, runTimeoutMs: 66_000, tRunMs: { goalSubset: 738, fullSuite: 738 }, perTestTimeoutMs: 500 });
    await runQueue(ctxFor(sb), memFor(o), fifoQueue([job(cands.unchanged, b0)]), GOAL, 10);
    expect(timeouts).toEqual([laneRunTimeout(o, GCD_BASELINE)]);
    expect(timeouts[0]).toBe(Math.max(3 * 738 + 10_000, 200 + 6 * 500 + 10_000));
    expect(timeouts[0]).toBeLessThan(66_000);
  });
  it('t_run refinement keeps a sieve-eligible estimate through a load spike (≤ 1.5 × 2 s) and takes a real slowdown', async () => {
    const withDuration = (ms: number) =>
      fakeSandbox((cmd): Partial<ExecResult> => (cmd.includes('run_tests.py') ? { stdout: `${runTestsJson(GCD_BUGGY_INPUTS)}\n`, exitCode: 1, durationMs: ms } : {}));
    const jobs = () => [job(cands.unchanged, b0), job(cands.unchanged, b0), job(cands.unchanged, b0)];
    const spike = memFor(oracle({ runner: 'quixbugs', lanes: 8, tRunMs: { goalSubset: 580, fullSuite: 580 } }));
    await runQueue(ctxFor(withDuration(2500)), spike, fifoQueue(jobs()), GOAL, 10);
    expect(spike.oracle.tRunMs.goalSubset).toBe(580);
    const loaded = memFor(oracle({ runner: 'quixbugs', lanes: 8, tRunMs: { goalSubset: 580, fullSuite: 580 } }));
    await runQueue(ctxFor(withDuration(650)), loaded, fifoQueue(jobs()), GOAL, 10);
    expect(loaded.oracle.tRunMs.goalSubset).toBe(650);
    const slow = memFor(oracle({ runner: 'quixbugs', lanes: 8, tRunMs: { goalSubset: 580, fullSuite: 580 } }));
    await runQueue(ctxFor(withDuration(3500)), slow, fifoQueue(jobs()), GOAL, 10);
    expect(slow.oracle.tRunMs.goalSubset).toBe(3500);
  });
});

describe('laneRunEnv (§4.1: the per-test timeout reaches the generated pytest module)', () => {
  it('pytest with a per-test timeout: the limit in ms and the stop rule; the QuixBugs runner and `other` get only the bytecode guard', () => {
    expect(laneRunEnv({ runner: 'pytest', perTestTimeoutMs: 500 })).toEqual({ ...LANE_RUN_ENV, JEVCODE_CASE_TIMEOUT_MS: '500', JEVCODE_MAX_CASE_TIMEOUTS: String(LANE_MAX_CASE_TIMEOUTS) });
    expect(laneRunEnv({ runner: 'pytest', perTestTimeoutMs: 686.6 })).toMatchObject({ JEVCODE_CASE_TIMEOUT_MS: '687' });
    expect(laneRunEnv({ runner: 'pytest', perTestTimeoutMs: null })).toEqual({ ...LANE_RUN_ENV });
    // without the stop rule (the module's own default: no limit)
    expect(laneRunEnv({ runner: 'pytest', perTestTimeoutMs: RETRY_CASE_TIMEOUT_MS }, { stopRule: false })).toEqual({ ...LANE_RUN_ENV, JEVCODE_CASE_TIMEOUT_MS: '2000' });
    expect(laneRunEnv({ runner: 'pytest', perTestTimeoutMs: 500 }, { stopRule: true })).toEqual(laneRunEnv({ runner: 'pytest', perTestTimeoutMs: 500 }));
    expect(laneRunEnv({ runner: 'quixbugs', perTestTimeoutMs: 500 })).toEqual({ ...LANE_RUN_ENV });
    expect(laneRunEnv({ runner: 'other', perTestTimeoutMs: null })).toEqual({ PYTHONDONTWRITEBYTECODE: '1' });
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
    // the oracle's per-test timeout and the stop rule reach the generated module through the environment (every lane run, subset and full)
    expect(runs.every((c) => c.env?.['JEVCODE_CASE_TIMEOUT_MS'] === '2000' && c.env?.['JEVCODE_MAX_CASE_TIMEOUTS'] === '1')).toBe(true);
    expect(mem.stepBudget.testRunsLeft).toBe(16 - 3);
    expect(mem.oracle.tRunMs).toEqual({ goalSubset: 800, fullSuite: 2500 });
    expect(mem.lanes?.mode).toBe('worktree');
    expect(sb.calls.some((c) => c.command === 'git checkout -- . && git clean -fdq')).toBe(true);
    // the `unchanged` verdict is remembered under the goal — a progress commit forgets it (the failure it was judged
    // against is gone); the passer's verdict stays tried
    const unchangedHash = sha12(applyCandidate(candidate(site(mod, 1), 'X = 3'), pyBase.files).diff);
    expect([...(mem.unchangedTried?.get(pyGoal.id) ?? [])]).toEqual([unchangedHash]);
    expect(mem.tried.size).toBe(2);
    expect(forgetUnchangedTried(mem, pyGoal.id)).toBe(1);
    expect(mem.tried.has(unchangedHash)).toBe(false);
    expect(mem.tried.size).toBe(1);
    expect(forgetUnchangedTried(mem, pyGoal.id)).toBe(0);
    expect(forgetUnchangedTried(mem, 'other-goal')).toBe(0);
  });
  it('a subset passer whose full suite breaks another test is regressed', async () => {
    const sb = pytestFake('tests/test_a.py::test_x PASSED\ntests/test_a.py::test_y PASSED\ntests/test_b.py::test_z FAILED\nFAILED tests/test_b.py::test_z - boom\n1 failed, 2 passed in 0.02s\n', 1);
    writeFileSync(join(ws, 'mod.py'), 'X = 1\n');
    const mem = memFor(oracle({ runner: 'pytest', lanes: 4, tRunMs: { goalSubset: 3000, fullSuite: 3000 } }), { baseline: PY_BASE });
    const out = await runQueue(ctxFor(sb), mem, fifoQueue([job(candidate(site(mod, 1), 'X = 2'), pyBase)]), pyGoal, 10);
    expect(out[0]?.status).toBe('regressed');
    expect(out[0]?.progress.newlyFailing).toEqual(['tests/test_b.py::test_z']);
  });
  it('runRegressionCheck: one full-suite run of a partial on a lane at the reference settings (no stop rule), applied over its base files, charged as one run and reported; null before any pool exists', async () => {
    // the batch classifies a partial from the goal subset alone (X = 3 leaves test_x failing: unchanged here, a partial in shape); the check runs the whole suite
    const sb = pytestFake('tests/test_a.py::test_x FAILED\ntests/test_a.py::test_y PASSED\ntests/test_b.py::test_z PASSED\nFAILED tests/test_a.py::test_x - assert 1 == 2\n1 failed, 2 passed in 0.02s\n', 1);
    writeFileSync(join(ws, 'mod.py'), 'X = 1\n');
    const mem = memFor(oracle({ runner: 'pytest', lanes: 4, tRunMs: { goalSubset: 3000, fullSuite: 3000 } }), { baseline: PY_BASE, stepBudget: budget({ testRunsLeft: 16, testWallLeftMs: 40_000 }) });
    const c = candidate(site(mod, 1), 'X = 3');
    const applied = applyCandidate(c, pyBase.files);
    const subset = summary({ command: `python3 -m pytest -q 'tests/test_a.py'`, passing: ['tests/test_a.py::test_y'], failing: ['tests/test_a.py::test_x'] });
    const partial: VerifyOutcome = { job: job(c, pyBase), applied, subset, progress: progress(PY_BASE, subset), status: 'partial' };
    // no pool yet: nothing ran this step, nothing can be verified
    expect(await runRegressionCheck(ctxFor(sb), mem, pyGoal, partial)).toBeNull();
    // a batch builds the pool (one subset run, no passer so no full-suite run of its own)
    await runQueue(ctxFor(sb), mem, fifoQueue([job(c, pyBase)]), pyGoal, 10);
    expect(sb.calls.filter((x) => x.command === 'python3 -m pytest -q')).toHaveLength(0);
    const runsBefore = mem.stepBudget.testRunsLeft;
    const ctx = ctxFor(sb);
    const full = await runRegressionCheck(ctx, mem, pyGoal, partial);
    expect(full?.passed).toBe(2);
    expect(full?.failing).toEqual(['tests/test_a.py::test_x']);
    expect(mem.stepBudget.testRunsLeft).toBe(runsBefore - 1);
    const fullRuns = sb.calls.filter((x) => x.command === 'python3 -m pytest -q');
    expect(fullRuns).toHaveLength(1);
    // on a lane, with the candidate applied there; reference settings: the per-case cap without the stop rule
    expect(fullRuns[0]?.cwd?.startsWith(join(runDir, 'tmp', 'synth', 'lane'))).toBe(true);
    expect(readFileSync(join(fullRuns[0]?.cwd ?? '', 'mod.py'), 'utf8')).toBe('X = 3\n');
    expect(fullRuns[0]?.env?.['JEVCODE_CASE_TIMEOUT_MS']).toBeDefined();
    expect(fullRuns[0]?.env?.['JEVCODE_MAX_CASE_TIMEOUTS']).toBeUndefined();
    expect(fullRuns[0]?.env?.['PYTHONDONTWRITEBYTECODE']).toBe('1');
    expect(ctx.events.some((e) => e.phase === 'verify' && /full-suite regression run of the held partial mutation\/\S+ at mod\.py:1: 2\/3 pass, 1 failed, 0 errors in \d+ ms/.test(e.detail))).toBe(true);
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
  it('in-flight timeouts: a batch whose every run the sandbox killed under load is re-queued once (not tried) with the lane timeout scaled by the load and classified by that retry; a killed run beside a finished one is a hang', async () => {
    writeFileSync(join(ws, 'mod.py'), 'X = 1\n');
    let starved = true;
    const timeouts: number[] = [];
    const ALL_GREEN = 'tests/test_a.py::test_x PASSED\ntests/test_a.py::test_y PASSED\ntests/test_b.py::test_z PASSED\n3 passed in 0.02s\n';
    const sb = fakeSandbox((cmd, opts): Partial<ExecResult> => {
      if (!cmd.startsWith('python3')) return {};
      timeouts.push(opts.timeoutMs);
      const src = readFileSync(join(opts.cwd ?? '', 'mod.py'), 'utf8');
      // the starved lanes return nothing before the sandbox kills the run; `X = 4` never returns, load or not
      if (starved || src.includes('X = 4')) return { killedBy: 'timeout', exitCode: null, stdout: '', durationMs: opts.timeoutMs };
      const fixed = src.includes('X = 2');
      if (cmd === `python3 -m pytest -q 'tests/test_a.py'`) return { stdout: subsetOut(fixed), exitCode: fixed ? 0 : 1, durationMs: 800 };
      return { stdout: ALL_GREEN, exitCode: 0, durationMs: 900 };
    });
    // the ladder shape: pytest without per-case knobs, a 0.5 s subset, lane timeout 3 × 500 + 10 000 ms
    const o = oracle({ runner: 'pytest', lanes: 2, perTestTimeoutMs: null, tRunMs: { goalSubset: 500, fullSuite: 500 }, runTimeoutMs: 11_500 });
    const laneTimeout = laneRunTimeout(o, PY_BASE);
    expect(laneTimeout).toBe(11_500);
    const mem = memFor(o, { baseline: PY_BASE });
    const ctx = ctxFor(sb);
    const out = await runQueue(ctx, mem, fifoQueue([job(candidate(site(mod, 1), 'X = 2'), pyBase), job(candidate(site(mod, 1), 'X = 3'), pyBase)]), pyGoal, 10);
    // nothing classified, nothing tried: both wait for their retry, whose lane timeout is twice the batch's (the load read 23×, the factor bounds it)
    expect(out).toEqual([]);
    expect(mem.tried.size).toBe(0);
    expect(mem.retryTimeouts?.get(pyGoal.id)?.map((r) => r.runTimeoutMs)).toEqual([laneTimeout * 2, laneTimeout * 2]);
    expect(timeouts).toEqual([laneTimeout, laneTimeout]);
    expect(mem.stepBudget.testRunsLeft).toBe(1500 - 2);
    expect(ctx.events[0]?.detail).toMatch(/0 tested on 2 lanes \(nothing ran\).*; 2 in-flight timeouts under load ×23\.0: re-queued once, lane timeout 11500→23000 ms/);
    // the next call for the goal: the retries run first, at the scaled timeout, and classify (the gold: subset then full suite)
    starved = false;
    const again = await runQueue(ctxFor(sb), mem, fifoQueue([]), pyGoal, 10);
    expect(again.map((r) => r.status)).toEqual(['plausible', 'unchanged']);
    expect(timeouts.slice(2)).toEqual([laneTimeout * 2, laneTimeout * 2, laneTimeout * 2]);
    expect(mem.tried.size).toBe(2);
    expect(mem.retryTimeouts?.get(pyGoal.id)).toHaveLength(0);
    // one killed run beside a finished one is the candidate's own hang: final, tried, no retry
    const mem2 = memFor(o, { baseline: PY_BASE });
    const out2 = await runQueue(ctxFor(sb), mem2, fifoQueue([job(candidate(site(mod, 1), 'X = 4'), pyBase), job(candidate(site(mod, 1), 'X = 3'), pyBase)]), pyGoal, 10);
    expect(out2.map((r) => r.status)).toEqual(['timeout', 'unchanged']);
    expect(mem2.tried.size).toBe(2);
    expect(mem2.retryTimeouts?.get(pyGoal.id)).toHaveLength(0);
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

describe('timeoutKind (pure): when a `timeout` verdict is final and when it awaits the retry at the full cap', () => {
  const ids = ['t::a', 't::b', 't::c'];
  const alarm = (s: string): string => `test_x.CaseTimeout: no result after ${s}`;
  const notRun = 'test_x.CaseNotRun: not run: 1 earlier case(s) timed out';
  const f = (id: string, actual: string) => ({ testId: id, call: id, expected: '1', actual });
  /** a baseline that finished every case (one wrong value), 100 ms session: the tail bound of its finished cases is 50 ms */
  const finishedBase = summary({ passing: ['t::a', 't::b'], failing: ['t::c'], failures: [f('t::c', '0')], durationMs: 700, outputTail: '1 failed, 2 passed in 0.10s\n' });
  const firstCaseRun = summary({ passed: 0, failing: ids, failures: [f('t::a', alarm('0.5s')), f('t::b', notRun), f('t::c', notRun)] });
  it('a sandbox-killed run, or alarms only on cases the baseline hangs on, are genuine hangs', () => {
    const killed = summary({ timedOut: true, failing: ['<test run>'] });
    expect(timeoutKind({ run: killed, base: finishedBase, runner: 'pytest', caseTimeoutMs: 500, loadRatio: 1 })).toBe('hang');
    // bitcount: the buggy program hangs on every case; a candidate that still hangs on the first gets no retry
    const hangBase = summary({ failing: ids, failures: ids.map((id) => f(id, alarm('2s'))) });
    expect(timeoutKind({ run: firstCaseRun, base: hangBase, runner: 'pytest', caseTimeoutMs: 500, loadRatio: 9 })).toBe('hang');
    // after passing a case, an alarm on a case the baseline hangs on, at a cap below 2 s: levenshtein's exponential
    // reference (1.0 s idle where the buggy program alarms at 2 s) — provisional; at the full cap the retry could add nothing → hang
    const midOnHung = summary({ passing: ['t::a'], failing: ['t::b', 't::c'], failures: [f('t::b', alarm('0.5s')), f('t::c', notRun)] });
    const partHangBase = summary({ passing: ['t::a'], failing: ['t::b', 't::c'], failures: [f('t::b', alarm('2s')), f('t::c', '0')] });
    expect(timeoutKind({ run: midOnHung, base: partHangBase, runner: 'pytest', caseTimeoutMs: 500, loadRatio: 1 })).toBe('provisional');
    const midOnHungFull = summary({ passing: ['t::a'], failing: ['t::b', 't::c'], failures: [f('t::b', alarm('2s')), f('t::c', notRun)] });
    expect(timeoutKind({ run: midOnHungFull, base: partHangBase, runner: 'pytest', caseTimeoutMs: RETRY_CASE_TIMEOUT_MS, loadRatio: 1 })).toBe('hang');
    // the QuixBugs runner's texts and ids (nothing passed: the baseline's hang)
    const qbBase = summary({ failing: ['sqrt(2, 0.01)'], failures: [f('sqrt(2, 0.01)', 'TIMEOUT after 2s')] });
    const qbRun = summary({ passed: 0, failing: ['sqrt(2, 0.01)'], failures: [f('sqrt(2, 0.01)', 'TIMEOUT after 0.5s')] });
    expect(timeoutKind({ run: qbRun, base: qbBase, runner: 'quixbugs', caseTimeoutMs: 500, loadRatio: 1 })).toBe('hang');
    expect(timeoutKind({ run: { ...qbRun, passed: 1 }, base: qbBase, runner: 'quixbugs', caseTimeoutMs: 500, loadRatio: 1 })).toBe('provisional');
    // a run with no alarmed case at all is not the cap's doing
    expect(timeoutKind({ run: summary({ failing: ['t::a'], failures: [f('t::a', '0')] }), base: finishedBase, runner: 'pytest', caseTimeoutMs: 500, loadRatio: 1 })).toBe('hang');
  });
  it('the alarm on the first case: a hang when 3 × the baseline\'s time for it × the observed load fits the cap, else provisional', () => {
    // no per-case times: the tail bound (50 ms) × 3 = 150 ≤ 500 → hang; under 4× load 600 > 500 → provisional
    expect(timeoutKind({ run: firstCaseRun, base: finishedBase, runner: 'pytest', caseTimeoutMs: 500, loadRatio: 1 })).toBe('hang');
    expect(timeoutKind({ run: firstCaseRun, base: finishedBase, runner: 'pytest', caseTimeoutMs: 500, loadRatio: 4 })).toBe('provisional');
    // pytest's durations table names the case: 10 ms → 3 × 10 × 4 = 120 ≤ 500, hang even under load
    const table = (aMs: number): TestRunSummaryLike => ({ ...finishedBase, outputTail: `=== slowest durations ===\n0.04s call     t::b\n${(aMs / 1000).toFixed(2)}s call     t::a\n\n1 failed, 2 passed in 0.10s\n` });
    expect(timeoutKind({ run: firstCaseRun, base: table(10), runner: 'pytest', caseTimeoutMs: 500, loadRatio: 4 })).toBe('hang');
    // a 180 ms first case (LCS's slow case first): 540 ≤ 552 idle → hang; under 4× load 2 160 > 552 → provisional
    expect(timeoutKind({ run: firstCaseRun, base: table(180), runner: 'pytest', caseTimeoutMs: 552, loadRatio: 1 })).toBe('hang');
    expect(timeoutKind({ run: firstCaseRun, base: table(180), runner: 'pytest', caseTimeoutMs: 552, loadRatio: 4 })).toBe('provisional');
    // the QuixBugs runner runs its cases in parallel: no first case, so a hang on a case the baseline finished is provisional
    const qbRun = summary({ passed: 0, failing: ['gcd(13, 13)'], failures: [f('gcd(13, 13)', 'TIMEOUT after 0.5s')] });
    expect(timeoutKind({ run: qbRun, base: GCD_BASELINE, runner: 'quixbugs', caseTimeoutMs: 500, loadRatio: 1 })).toBe('provisional');
  });
  it('an alarm after passing cases, on a case the baseline finished, is provisional whatever the load', () => {
    const mid = summary({ passing: ['t::a'], failing: ['t::b', 't::c'], failures: [f('t::b', alarm('0.5s')), f('t::c', notRun)] });
    expect(timeoutKind({ run: mid, base: finishedBase, runner: 'pytest', caseTimeoutMs: 500, loadRatio: 1 })).toBe('provisional');
    expect(timeoutKind({ run: mid, base: finishedBase, runner: 'pytest', caseTimeoutMs: 2000, loadRatio: 1 })).toBe('provisional');
    // a wrong value among the failures never reaches timeoutKind (classifyOutcome says regressed/unchanged); if it did, it is not a first-case hang
    const mixed = summary({ passed: 0, failing: ids, failures: [f('t::a', alarm('0.5s')), f('t::b', '0'), f('t::c', notRun)] });
    expect(timeoutKind({ run: mixed, base: finishedBase, runner: 'pytest', caseTimeoutMs: 500, loadRatio: 1 })).toBe('provisional');
  });
});
type TestRunSummaryLike = ReturnType<typeof summary>;

describe('provisional timeouts on the lanes: slow is not hanging (jev-only-quixbugs-3-inspection.md §2)', () => {
  /** An LCS-like generated module: ten cases, the buggy program fails four on values, every case finishes; `pytest -q` baseline (no durations table). */
  const IDS = Array.from({ length: 10 }, (_, i) => `tests/test_lcs.py::test_lcs[${i}-x]`);
  const BUGGY_FAILS = [3, 5, 6, 7];
  const LCS_BASE = summary({
    command: 'python3 -m pytest -q',
    passing: IDS.filter((_, i) => !BUGGY_FAILS.includes(i)),
    failing: BUGGY_FAILS.map((i) => IDS[i] ?? ''),
    failures: BUGGY_FAILS.map((i) => ({ testId: IDS[i] ?? '', call: IDS[i] ?? '', expected: "'BCBA'", actual: "'BBDAB'" })),
    durationMs: 700,
    outputTail: '4 failed, 6 passed in 0.45s\n',
  });
  const lcsGoal = goal(BUGGY_FAILS.map((i) => IDS[i] ?? ''), { suspectedFiles: ['lcs.py'] });
  const lcs = sourceFile('lcs.py', 'X = 1\n');
  const lcsBase = base([lcs], LCS_BASE);
  /** Candidate markers the fake keys off: the gold whose case 3 takes 800 ms; a hang on the first case; a hang on case 3 after three passes; the buggy behaviour. */
  const SLOW = 'X = 2';
  const HANG_FIRST = 'X = 3';
  const HANG_MID = 'X = 4';
  const SAME = 'X = 5';
  const SLOW_CASE_MS = 800;
  type Verdict = 'pass' | 'fail' | 'hang';
  /** `pytest -q`-shaped output of the generated module: verbose status lines, the short summary with the module's texts, the counts line. */
  function moduleOutput(verdict: (i: number) => Verdict, capMs: number, stopRule: boolean): { stdout: string; exitCode: number } {
    const lines: string[] = [];
    const short: string[] = [];
    let passed = 0;
    let failed = 0;
    let alarms = 0;
    for (let i = 0; i < IDS.length; i++) {
      const id = IDS[i] ?? '';
      if (stopRule && alarms >= 1) {
        lines.push(`${id} FAILED`);
        short.push(`FAILED ${id} - test_lcs.CaseNotRun: not run: ${alarms} earlier case(s) timed out`);
        failed += 1;
        continue;
      }
      const v = verdict(i);
      if (v === 'pass') {
        lines.push(`${id} PASSED`);
        passed += 1;
      } else if (v === 'fail') {
        lines.push(`${id} FAILED`);
        short.push(`FAILED ${id} - AssertionError: lcs -> 'BBDAB', expected 'BCBA'`);
        failed += 1;
      } else {
        alarms += 1;
        lines.push(`${id} FAILED`);
        short.push(`FAILED ${id} - test_lcs.CaseTimeout: no result after ${capMs / 1000}s`);
        failed += 1;
      }
    }
    const counts = `${failed > 0 ? `${failed} failed, ` : ''}${passed} passed in 0.45s`;
    return { stdout: `${lines.join('\n')}\n=========================== short test summary info ============================\n${short.join('\n')}\n${counts}\n`, exitCode: failed > 0 ? 1 : 0 };
  }
  /** The lanes' sandbox: reads the lane's lcs.py and the two env knobs, answers as the module would; `durationMs` is the measured run time. */
  function lcsFake(durationMs: () => number = () => 300, hook?: (cmd: string, opts: SandboxRunOptions) => void) {
    return fakeSandbox((cmd, opts): Partial<ExecResult> => {
      if (!cmd.startsWith('python3')) return {};
      hook?.(cmd, opts);
      const src = readFileSync(join(opts.cwd ?? '', 'lcs.py'), 'utf8');
      const capMs = Number(opts.env?.['JEVCODE_CASE_TIMEOUT_MS'] ?? 2000);
      const stopRule = opts.env?.['JEVCODE_MAX_CASE_TIMEOUTS'] !== undefined;
      const verdict = (i: number): Verdict => {
        if (src.includes(SLOW)) return i === 3 && capMs < SLOW_CASE_MS ? 'hang' : 'pass';
        if (src.includes(HANG_FIRST)) return i === 0 ? 'hang' : 'pass';
        if (src.includes(HANG_MID)) return i === 3 ? 'hang' : 'pass';
        return BUGGY_FAILS.includes(i) ? 'fail' : 'pass';
      };
      return { ...moduleOutput(verdict, capMs, stopRule), durationMs: durationMs() };
    });
  }
  const pyOracle = (over: Partial<OracleModel> = {}): OracleModel => oracle({ runner: 'pytest', lanes: 1, perTestTimeoutMs: 500, tRunMs: { goalSubset: 300, fullSuite: 300 }, runTimeoutMs: 12_100, ...over });
  const pyRuns = (sb: { calls: { command: string }[] }): number => sb.calls.filter((c) => c.command.startsWith('python3')).length;

  it('the gold slow on a case the baseline finished: provisional at 500 ms, retried at 2 s, plausible; tried only then', async () => {
    writeFileSync(join(ws, 'lcs.py'), 'X = 1\n');
    const mem = memFor(pyOracle({ lanes: 2 }), { baseline: LCS_BASE });
    const seen: { cap: string | undefined; stop: string | undefined; triedBefore: number }[] = [];
    const sb = lcsFake(() => 300, (_cmd, opts) => seen.push({ cap: opts.env?.['JEVCODE_CASE_TIMEOUT_MS'], stop: opts.env?.['JEVCODE_MAX_CASE_TIMEOUTS'], triedBefore: mem.tried.size }));
    const ctx = ctxFor(sb);
    const out = await runQueue(ctx, mem, fifoQueue([job(candidate(site(lcs, 1), SLOW), lcsBase), job(candidate(site(lcs, 1), SAME), lcsBase)]), lcsGoal, 10);
    expect(out.map((r) => r.status)).toEqual(['plausible', 'unchanged']);
    const gold = out[0] as VerifyOutcome;
    expect(gold.subset.passed).toBe(10);
    expect(gold.full?.passed).toBe(10);
    expect(gold.progress.newlyPassing).toEqual(lcsGoal.tests);
    // runs: the two first runs at 500 ms with the stop rule (the gold: 3 passed, the alarm on case 3, six not run);
    // then the gold's retry — subset and full suite — at 2 000 ms, the stop rule kept
    expect(seen.map((s) => `${s.cap}/${s.stop ?? '-'}`)).toEqual(['500/1', '500/1', '2000/1', '2000/1']);
    expect(seen[2]?.triedBefore).toBe(1); // only the buggy-behaviour candidate was tried before the retry
    expect(mem.tried.size).toBe(2);
    expect(mem.tried.has(sha12(gold.applied.diff))).toBe(true);
    expect(mem.retryTimeouts?.get(lcsGoal.id)).toHaveLength(0);
    expect(mem.stepBudget.testRunsLeft).toBe(1500 - 4);
    expect(ctx.events[0]?.detail).toMatch(/2 tested on 2 lanes \(1 plausible, 1 unchanged\)/);
    expect(ctx.events[0]?.detail).toMatch(/1 provisional timeout: 1 retried at 2000 ms \(1 plausible\), 0 pending/);
    // the retries do not refine t_run (2 s a case, no stop rule): the two first runs do
    expect(mem.oracle.tRunMs.goalSubset).toBe(300);
    // the lane timeout of the retry follows the full cap, bounded by the oracle's run timeout
    const retryTimeout = sb.calls.filter((c) => c.command.startsWith('python3'))[2]?.timeoutMs;
    expect(retryTimeout).toBe(laneRunTimeout({ ...mem.oracle, perTestTimeoutMs: RETRY_CASE_TIMEOUT_MS }, LCS_BASE));
  });
  it('genuine hangs are classified without a retry (first-case alarm, the baseline finished it quickly); a mid-run hang is retried once and stays timeout', async () => {
    writeFileSync(join(ws, 'lcs.py'), 'X = 1\n');
    // the cap fitOracle gives this baseline: 3 × the 400 ms finished-case bound (no durations table) = 1 200 ms
    expect(fitOracle(LCS_BASE, { commandTimeoutMs: 120_000, wallRemainingMs: 600_000, workspace: { git: true } }).perTestTimeoutMs).toBe(1200);
    const mem = memFor(pyOracle({ perTestTimeoutMs: 1200 }), { baseline: LCS_BASE });
    const sb = lcsFake();
    const ctx = ctxFor(sb);
    const out = await runQueue(ctx, mem, fifoQueue([job(candidate(site(lcs, 1), HANG_FIRST), lcsBase)]), lcsGoal, 10);
    expect(out.map((r) => r.status)).toEqual(['timeout']);
    expect(pyRuns(sb)).toBe(1);
    expect(mem.tried.size).toBe(1);
    expect(mem.retryTimeouts?.get(lcsGoal.id)).toHaveLength(0);
    expect(ctx.events[0]?.detail).not.toMatch(/provisional/);
    // with a durations table naming the first case (10 ms) the same verdict comes at a 500 ms cap
    const withTable = { ...LCS_BASE, outputTail: `=== slowest durations ===\n0.18s call     ${IDS[3]}\n0.01s call     ${IDS[0]}\n\n4 failed, 6 passed in 0.45s\n` };
    const mem2 = memFor(pyOracle(), { baseline: withTable });
    const sb2 = lcsFake();
    const out2 = await runQueue(ctxFor(sb2), mem2, fifoQueue([job(candidate(site(lcs, 1), HANG_FIRST), base([lcs], withTable))]), lcsGoal, 10);
    expect(out2.map((r) => r.status)).toEqual(['timeout']);
    expect(pyRuns(sb2)).toBe(1);
    // the mid-run hang (three passes, then case 3 never returns): provisional, retried at 2 s with the stop rule
    // (one alarm, the six cases after it not run: a genuine hang costs the retry one alarm, not seven), timeout — final
    const mem3 = memFor(pyOracle(), { baseline: LCS_BASE });
    const sb3 = lcsFake();
    const ctx3 = ctxFor(sb3);
    const out3 = await runQueue(ctx3, mem3, fifoQueue([job(candidate(site(lcs, 1), HANG_MID), lcsBase)]), lcsGoal, 10);
    expect(out3.map((r) => r.status)).toEqual(['timeout']);
    expect(pyRuns(sb3)).toBe(2);
    expect(out3[0]?.subset.failures.filter((f) => /CaseTimeout/.test(f.actual))).toHaveLength(1);
    expect(out3[0]?.subset.failures.filter((f) => /CaseNotRun/.test(f.actual))).toHaveLength(6);
    expect(out3[0]?.subset.passed).toBe(3);
    expect(mem3.tried.size).toBe(1);
    expect(ctx3.events[0]?.detail).toMatch(/1 provisional timeout: 1 retried at 2000 ms \(1 timeout\), 0 pending/);
  });
  it('load: once four runs measure above 2 × the estimate, the rest of the batch runs at the scaled cap and the event says so', async () => {
    writeFileSync(join(ws, 'lcs.py'), 'X = 1\n');
    const caps: string[] = [];
    const mem = memFor(pyOracle({ tRunMs: { goalSubset: 500, fullSuite: 500 } }), { baseline: LCS_BASE });
    const sb = lcsFake(() => 1150, (_cmd, opts) => caps.push(opts.env?.['JEVCODE_CASE_TIMEOUT_MS'] ?? '-'));
    const ctx = ctxFor(sb);
    const jobs = [...Array.from({ length: 5 }, () => job(candidate(site(lcs, 1), SAME), lcsBase)), job(candidate(site(lcs, 1), SLOW), lcsBase)];
    const out = await runQueue(ctx, mem, fifoQueue(jobs), lcsGoal, 10);
    expect(out.map((r) => r.status)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged', 'plausible']);
    // the first four runs at the oracle's cap; the median (1 150 ms) is 2.3 × the 500 ms estimate → 1 150 ms for the rest;
    // the gold's slow case (800 ms) then fits its first run: no provisional verdict, no retry (the sixth and seventh calls are its subset and full suite)
    expect(caps).toEqual(['500', '500', '500', '500', '1150', '1150', '1150']);
    expect(ctx.events[0]?.detail).toMatch(/load ×2\.3, case timeout 500→1150 ms/);
    expect(ctx.events[0]?.detail).not.toMatch(/provisional/);
    expect(mem.oracle.perTestTimeoutMs).toBe(500); // the oracle's own cap is not rewritten: the next batch re-measures
    expect(mem.oracle.tRunMs.goalSubset).toBe(1150);
    // the scale is bounded by the 2 s cap
    const caps2: string[] = [];
    const mem2 = memFor(pyOracle({ tRunMs: { goalSubset: 200, fullSuite: 200 } }), { baseline: LCS_BASE });
    await runQueue(ctxFor(lcsFake(() => 1800, (_cmd, opts) => caps2.push(opts.env?.['JEVCODE_CASE_TIMEOUT_MS'] ?? '-'))), mem2, fifoQueue(Array.from({ length: 5 }, () => job(candidate(site(lcs, 1), SAME), lcsBase))), lcsGoal, 10);
    expect(caps2).toEqual(['500', '500', '500', '500', '2000']);
    // below 2 × the estimate nothing changes
    const caps3: string[] = [];
    const mem3 = memFor(pyOracle({ tRunMs: { goalSubset: 500, fullSuite: 500 } }), { baseline: LCS_BASE });
    const ctx3 = ctxFor(lcsFake(() => 900, (_cmd, opts) => caps3.push(opts.env?.['JEVCODE_CASE_TIMEOUT_MS'] ?? '-')));
    await runQueue(ctx3, mem3, fifoQueue(Array.from({ length: 5 }, () => job(candidate(site(lcs, 1), SAME), lcsBase))), lcsGoal, 10);
    expect(caps3).toEqual(['500', '500', '500', '500', '500']);
    expect(ctx3.events[0]?.detail).not.toMatch(/load ×/);
  });
  it('at most 16 retries a batch; the rest wait in mem.retryTimeouts (not tried), a re-enumerated copy is skipped, they are retried first next call, and a re-baseline drops them', async () => {
    writeFileSync(join(ws, 'lcs.py'), 'X = 1\n');
    expect(RETRY_TIMEOUTS_MAX_PER_BATCH).toBe(16);
    const mem = memFor(pyOracle({ lanes: 8 }), { baseline: LCS_BASE });
    const sb = lcsFake();
    const ctx = ctxFor(sb);
    const hangs = Array.from({ length: 18 }, (_, k) => candidate(site(lcs, 1), `${HANG_MID}  # ${k}`));
    const out = await runQueue(ctx, mem, fifoQueue(hangs.map((c) => job(c, lcsBase))), lcsGoal, 100);
    expect(out).toHaveLength(RETRY_TIMEOUTS_MAX_PER_BATCH);
    expect(out.every((r) => r.status === 'timeout')).toBe(true);
    expect(mem.tried.size).toBe(16);
    expect(mem.retryTimeouts?.get(lcsGoal.id)).toHaveLength(2);
    expect(mem.stepBudget.testRunsLeft).toBe(1500 - 18 - 16);
    expect(ctx.events[0]?.detail).toMatch(/18 provisional timeouts: 16 retried at 2000 ms \(16 timeout\), 2 pending/);
    // the next call for the goal: a re-enumerated copy of a pending candidate is skipped (no run); the two pending are retried first
    const pending = (mem.retryTimeouts?.get(lcsGoal.id) ?? []).map((p) => p.job.candidate);
    const before = pyRuns(sb);
    const again = await runQueue(ctxFor(sb), mem, fifoQueue([job(pending[0] as Candidate, lcsBase)]), lcsGoal, 100);
    expect(again.map((r) => r.status)).toEqual(['timeout', 'timeout']);
    expect(pyRuns(sb) - before).toBe(2);
    expect(mem.tried.size).toBe(18);
    expect(mem.retryTimeouts?.get(lcsGoal.id)).toHaveLength(0);
    // another goal's call does not touch g1's pending retries
    const mem2 = memFor(pyOracle(), { baseline: LCS_BASE, stepBudget: budget({ testRunsLeft: 1 }) });
    const r2 = await runQueue(ctxFor(lcsFake()), mem2, fifoQueue([job(candidate(site(lcs, 1), HANG_MID), lcsBase)]), lcsGoal, 10);
    expect(r2).toEqual([]); // one run left: the first run was charged, the retry found none
    expect(mem2.retryTimeouts?.get(lcsGoal.id)).toHaveLength(1);
    expect(mem2.tried.size).toBe(0);
    mem2.stepBudget = budget();
    expect(await runQueue(ctxFor(lcsFake()), mem2, fifoQueue([]), goal(lcsGoal.tests, { id: 'g2', suspectedFiles: ['lcs.py'] }), 10)).toEqual([]);
    expect(mem2.retryTimeouts?.get(lcsGoal.id)).toHaveLength(1);
    // a re-baseline (index.ts replaces mem.baseline after a commit): the pending retry was judged against the old baseline → dropped, not tried
    mem2.baseline = { ...LCS_BASE };
    expect(await runQueue(ctxFor(lcsFake()), mem2, fifoQueue([]), lcsGoal, 10)).toEqual([]);
    expect(mem2.retryTimeouts?.get(lcsGoal.id)).toHaveLength(0);
    expect(mem2.tried.size).toBe(0);
  });
  it('the measured goal-subset baseline (pytest -q, no passing ids) runs at the module defaults — 2 s a case, no stop rule — not the lane cap', async () => {
    writeFileSync(join(ws, 'lcs.py'), 'X = 1\n');
    // the same baseline without passing ids: the reference is measured once on the clean lane
    const qBase = summary({ ...LCS_BASE, passing: [], passed: 6 });
    const seen: string[] = [];
    const mem = memFor(pyOracle({ lanes: 1 }), { baseline: qBase });
    const sb = lcsFake(() => 300, (_cmd, opts) => seen.push(`${opts.env?.['JEVCODE_CASE_TIMEOUT_MS']}/${opts.env?.['JEVCODE_MAX_CASE_TIMEOUTS'] ?? '-'}`));
    const out = await runQueue(ctxFor(sb), mem, fifoQueue([job(candidate(site(lcs, 1), SAME), base([lcs], qBase))]), lcsGoal, 10);
    // reference at 2000 ms without the stop rule; the candidate at the oracle's 500 ms cap with it
    expect(seen).toEqual(['2000/-', '500/1']);
    expect(out.map((r) => r.status)).toEqual(['unchanged']);
    expect(mem.subsetBaselines?.get('b0|tests/test_lcs.py')?.passed).toBe(6);
  });
  it('a retry the step wall cuts short stays pending (not tried); the retry phase charges runs but not runsAllowed', async () => {
    writeFileSync(join(ws, 'lcs.py'), 'X = 1\n');
    let t = 0;
    // 5 s of wall: the first run (600 ms) fits, the retry would be cut below the lane timeout → deferred back to pending
    const mem = memFor(pyOracle(), { baseline: LCS_BASE, stepBudget: budget({ testWallLeftMs: 5000 }) });
    const sb = lcsFake(() => 600, () => (t += 600));
    const ctx = ctxFor(sb);
    const out = await runQueue(ctx, mem, fifoQueue([job(candidate(site(lcs, 1), SLOW), lcsBase)]), lcsGoal, 1, { now: () => t });
    // runsAllowed = 1 was spent on the first run; the retry ran anyway (it is a re-run of a dispatched candidate)
    expect(out.map((r) => r.status)).toEqual(['plausible']);
    expect(pyRuns(sb)).toBe(3);
    expect(mem.stepBudget.testRunsLeft).toBe(1500 - 3);
    expect(mem.stepBudget.testWallLeftMs).toBe(5000 - 3 * 600);
  });
});
