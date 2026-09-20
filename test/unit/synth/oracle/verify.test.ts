/**
 * Candidate verification on a repository workspace (oracle/verify.ts runRepositoryQueue) with a
 * fake lane pool and a fake sandbox: the reproduction gates the regression run, statuses follow
 * the code rules (plausible / unchanged / regressed), the budget is charged per run, classified
 * diffs are `tried`, the regression-only mode (no oracle) treats every no-regression run as
 * plausible, and the lane environment points the module path at the lane.
 */
import { describe, expect, it } from 'vitest';

import { sha12 } from '../../../../src/core/hash.js';
import type { ExecResult, SandboxRunOptions } from '../../../../src/core/types.js';
import type { ReproSpec } from '../../../../src/synth/oracle/goal.js';
import { REPRO_SENTINEL } from '../../../../src/synth/oracle/runner.js';
import { mergeSummaries } from '../../../../src/synth/oracle/search.js';
import { laneEnv, runRepositoryQueue } from '../../../../src/synth/oracle/verify.js';
import { committedBase } from '../../../../src/synth/search/index.js';
import type { Lane, VerifyJob } from '../../../../src/synth/search/types.js';
import type { LanePool } from '../../../../src/synth/sieve/lanes.js';
import type { RunnerContext, RunnerMemory } from '../../../../src/synth/sieve/runner.js';
import type { AppliedCandidate } from '../../../../src/synth/types.js';
import { GCD_BUGGY, cand, fakeBudget, fakeGoal, siteAt, sourceFile, summary } from '../search/controller-fakes.js';

const REPRO_ID = 'repro::abcd1234';
const SCOPED = 'python -m pytest -q -rA tests/test_gcd.py';
const spec: ReproSpec = { testId: REPRO_ID, chunks: ['from gcd import gcd', 'gcd(13, 13)'], criterion: { form: 'values', expected: [{ chunk: 'last', text: '13' }] }, expectedText: '13', blockIndex: 0, options: { packageName: 'gcd', framework: null, timeoutMs: 30_000 } };

function exec(stdout: string, exitCode: number, durationMs = 50): ExecResult {
  return { ok: exitCode === 0, exitCode, signal: null, stdout, stderr: '', truncated: false, bytesSeen: stdout.length, killedBy: null, timedOut: false, orphans: [], sandboxExecDenied: false, durationMs };
}

function sentinel(value: string | null, exception: { type: string; message: string } | null): string {
  const results = [
    { chunk: 0, stmt: 0, source: 'from gcd import gcd', kind: 'stmt', value: null, stdout: '', exception: null, fixup: null, environment: false, ms: 1 },
    { chunk: 1, stmt: 0, source: 'gcd(13, 13)', kind: 'expr', value, type_name: value === null ? null : 'int', stdout: '', exception: exception === null ? null : { ...exception, frames: [] }, fixup: null, environment: false, ms: 2 },
  ];
  return `${REPRO_SENTINEL}${JSON.stringify({ ok: true, python: '3.9.6', results })}\n`;
}

const GREEN = '..                                                                       [100%]\n=========================== short test summary info ============================\nPASSED tests/test_gcd.py::test_gcd\nPASSED tests/test_gcd.py::test_other\n============================== 2 passed in 0.10s ===============================\n';
const REGRESSED = '.F                                                                       [100%]\n=========================== short test summary info ============================\nPASSED tests/test_gcd.py::test_gcd\nFAILED tests/test_gcd.py::test_other - assert 1 == 2\n========================= 1 failed, 1 passed in 0.10s ==========================\n';

interface Harness {
  ctx: RunnerContext;
  mem: RunnerMemory;
  jobs: VerifyJob[];
  commands: { command: string; cwd: string | undefined; env: Record<string, string> | undefined }[];
  applied: AppliedCandidate[];
  events: string[];
}

/** One fake lane at /lanes/lane0; the fake sandbox answers the reproduction from the candidate text (FIX passes, else the buggy value) and the regression run (BREAK regresses). */
function harness(texts: string[], o: { runs?: number; wallMs?: number } = {}): Harness {
  const file = sourceFile('gcd.py', GCD_BUGGY);
  const scoped = summary({ command: SCOPED, passing: ['tests/test_gcd.py::test_gcd', 'tests/test_gcd.py::test_other'], failing: [], durationMs: 100 });
  const baseline = mergeSummaries(scoped, summary({ command: `python <${REPRO_ID}>`, failing: [REPRO_ID], failures: [{ testId: REPRO_ID, call: 'gcd(13, 13)', expected: '13', actual: 'RecursionError: x' }] }));
  const base = committedBase(new Map([[file.path, file]]), baseline);
  const jobs: VerifyJob[] = texts.map((t, i) => ({ candidate: cand(siteAt(file, 5), t), base, p: 0.9 - i * 0.1, sourcePrior: 1, key: [base.summary.passed, 0.9 - i * 0.1, 1] }));
  const lane: Lane = { index: 0, dir: '/lanes/lane0', mode: 'worktree', busy: false };
  const applied: AppliedCandidate[] = [];
  const pool: LanePool = {
    mode: 'worktree',
    lanes: [lane],
    workspaceRoot: '/work',
    pathInLane: (l, p) => `${l.dir}/${p}`,
    withLane: async (fn) => fn(lane),
    applyToLane: async (_l, a) => {
      applied.push(a);
    },
    resetLane: async () => undefined,
    disposeLanes: async () => undefined,
  };
  const commands: Harness['commands'] = [];
  const events: string[] = [];
  const ctx: RunnerContext = {
    runDir: '/runs/r',
    sandbox: {
      run: async (command: string, opts: SandboxRunOptions): Promise<ExecResult> => {
        commands.push({ command, cwd: opts.cwd, env: opts.env });
        const current = applied.at(-1)?.candidate.text ?? '';
        if (command.includes('<jevcode-repro>')) return exec(current.includes('FIX') ? sentinel('13', null) : sentinel(null, { type: 'RecursionError', message: 'maximum recursion depth exceeded' }), 0, 610);
        return exec(current.includes('BREAK') ? REGRESSED : GREEN, current.includes('BREAK') ? 1 : 0, 2000);
      },
    },
    signal: new AbortController().signal,
    workspaceInfo: { root: '/work', git: true },
    step: 3,
    emit: (e) => {
      events.push(`${e.phase}: ${e.detail}`);
    },
  };
  const mem: RunnerMemory = { baseline, oracle: { runner: 'pytest', lanes: 1, tRunMs: { goalSubset: 600, fullSuite: 2000 }, perTestTimeoutMs: null, runTimeoutMs: 60_000, baselineDurationMs: 2000 }, stepBudget: fakeBudget({ runs: o.runs ?? 16, wallMs: o.wallMs ?? 600_000 }), tried: new Set(), lanes: pool };
  return { ctx, mem, jobs, commands, applied, events };
}

describe('runRepositoryQueue with a reproduction', () => {
  it('a candidate that passes the reproduction gets the scoped regression run: plausible, full = scoped + reproduction, two runs charged', async () => {
    const h = harness(['return gcd(b, a % b)  # FIX']);
    const out = await runRepositoryQueue(h.ctx, h.mem, { pop: (n) => h.jobs.splice(0, n) }, fakeGoal({ id: 'g1', tests: [REPRO_ID] }), 1, { spec, regression: { command: SCOPED, timeoutMs: 120_000 }, python: '/work/.venv/bin/python' });
    expect(out).toHaveLength(1);
    const o = out[0]!;
    expect(o.status).toBe('plausible');
    expect(o.subset).toMatchObject({ passed: 1, failed: 0, passing: [REPRO_ID] });
    expect(o.full).toMatchObject({ passed: 3, failed: 0, total: 3 });
    expect(o.full?.passing).toEqual(['tests/test_gcd.py::test_gcd', 'tests/test_gcd.py::test_other', REPRO_ID]);
    expect(o.progress.newlyPassing).toEqual([REPRO_ID]);
    expect(o.progress.regressed).toBe(false);
    expect(h.mem.stepBudget.testRunsLeft).toBe(14);
    expect(h.mem.tried.has(sha12(o.applied.diff))).toBe(true);
    // the reproduction ran first, with the venv python and cwd = lane; the regression command second, with the lane on the module path
    expect(h.commands.map((c) => c.cwd)).toEqual(['/lanes/lane0', '/lanes/lane0']);
    expect(h.commands[0]?.command).toContain("'/work/.venv/bin/python' -c");
    expect(h.commands[1]?.command).toBe(SCOPED);
    expect(h.commands[1]?.env).toEqual({ PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '/lanes/lane0' });
    // the oracle learnt the measured reproduction and regression times
    expect(h.mem.oracle.tRunMs).toEqual({ goalSubset: 610, fullSuite: 2000 });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatch(/^verify: g1: 1 tested on 1 lane \(1 plausible\); reproduction repro::abcd1234 then regression/);
  });
  it('a candidate that fails the reproduction is unchanged, costs one run and no regression run; a passer that breaks a scoped test is regressed', async () => {
    const h = harness(['return gcd(a % b, a)', 'return gcd(b, a % b)  # FIX BREAK']);
    const out = await runRepositoryQueue(h.ctx, h.mem, { pop: (n) => h.jobs.splice(0, n) }, fakeGoal({ id: 'g1', tests: [REPRO_ID] }), 2, { spec, regression: { command: SCOPED, timeoutMs: 120_000 } });
    expect(out.map((o) => o.status)).toEqual(['unchanged', 'regressed']);
    expect(out[0]?.full).toBeUndefined();
    expect(out[0]?.progress.newlyPassing).toEqual([]);
    expect(out[1]?.progress.newlyFailing).toEqual(['tests/test_gcd.py::test_other']);
    expect(out[1]?.progress.regressed).toBe(true);
    expect(h.mem.stepBudget.testRunsLeft).toBe(13); // 1 + (1 + 1)
    expect(h.commands).toHaveLength(3);
    expect(h.mem.tried.size).toBe(2);
    // without a python the runner's own pick is in the command
    expect(h.commands[0]?.command).toContain('.venv/bin/python; else JEV_PY=python3');
  });
  it('honours runsAllowed and the run budget: the rest is deferred under the goal', async () => {
    const h = harness(['a', 'b', 'c'], { runs: 1 });
    const out = await runRepositoryQueue(h.ctx, h.mem, { pop: (n) => h.jobs.splice(0, n) }, fakeGoal({ id: 'g1', tests: [REPRO_ID] }), 3, { spec, regression: { command: SCOPED, timeoutMs: 120_000 } });
    expect(out).toHaveLength(1);
    expect(h.mem.stepBudget.testRunsLeft).toBe(0);
    // the remaining jobs were never popped (dispatch stopped on the budget), nothing deferred from a started run
    expect(h.jobs).toHaveLength(2);
    expect(h.mem.deferred?.get('g1')).toEqual([]);
  });
});

describe('runRepositoryQueue without a reproduction (best guess)', () => {
  it('every candidate gets the scoped run alone; nothing newly failing is plausible, a newly failing test is regressed', async () => {
    const h = harness(['return gcd(b, a % b)', 'return gcd(b, a % b)  # BREAK']);
    // a best-guess base has no reproduction test in its baseline
    const scoped = summary({ command: SCOPED, passing: ['tests/test_gcd.py::test_gcd', 'tests/test_gcd.py::test_other'], failing: [], durationMs: 100 });
    h.mem.baseline = scoped;
    for (const j of h.jobs) j.base = { ...j.base, summary: scoped };
    const out = await runRepositoryQueue(h.ctx, h.mem, { pop: (n) => h.jobs.splice(0, n) }, fakeGoal({ id: 'g1', tests: ['issue::00000000'] }), 2, { spec: null, regression: { command: SCOPED, timeoutMs: 120_000 } });
    expect(out.map((o) => o.status)).toEqual(['plausible', 'regressed']);
    expect(out[0]?.full).toMatchObject({ passed: 2, failed: 0 });
    expect(out[0]?.subset).toBe(out[0]?.full);
    expect(out[0]?.progress.newlyPassing).toEqual([]);
    expect(out[1]?.progress.newlyFailing).toEqual(['tests/test_gcd.py::test_other']);
    expect(h.commands.every((c) => c.command === SCOPED)).toBe(true);
    expect(h.mem.stepBudget.testRunsLeft).toBe(14);
    expect(h.events[0]).toContain('regression only');
  });
});

describe('laneEnv', () => {
  it('puts the lane (and its src/ when the checkout has one) first on the module path, no bytecode', () => {
    const lane: Lane = { index: 2, dir: '/runs/r/tmp/synth/lane2', mode: 'worktree', busy: false };
    expect(laneEnv(lane, false)).toEqual({ PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '/runs/r/tmp/synth/lane2' });
    expect(laneEnv(lane, true)).toEqual({ PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: '/runs/r/tmp/synth/lane2/src:/runs/r/tmp/synth/lane2' });
  });
});
