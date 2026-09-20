import { describe, expect, it } from 'vitest';

import type { ExecResult, Sandbox, SandboxRunOptions } from '../../../../src/core/types.js';
import { createVerifier, detectFormat, sandboxRunFn, summarize } from '../../../../src/synth/verify/index.js';
import type { VerifyRunOptions } from '../../../../src/synth/verify/types.js';
import { fixture } from './helpers.js';

describe('createVerifier().runTests through a scripted run function', () => {
  it('passes the command, timeout, output cap and cwd; appends quoted files', async () => {
    const calls: { command: string; opts: VerifyRunOptions }[] = [];
    const v = createVerifier({
      run: async (command, opts) => {
        calls.push({ command, opts });
        return { stdout: fixture('pytest-q.txt'), exitCode: 1, durationMs: 77 };
      },
      cwd: '/ws',
      timeoutMs: 5000,
    });
    const s = await v.runTests('pytest -q', ['tests/test a.py', 'tests/test_b.py::test_x']);
    expect(calls[0]).toEqual({ command: "pytest -q 'tests/test a.py' 'tests/test_b.py::test_x'", opts: { timeoutMs: 5000, maxOutputBytes: 256 * 1024, cwd: '/ws' } });
    expect(s.command).toBe("pytest -q 'tests/test a.py' 'tests/test_b.py::test_x'");
    expect(s).toMatchObject({ total: 16, failed: 10, errors: 1, durationMs: 77, exitCode: 1 });
    const s2 = await v.runTests('pytest -q', undefined, { timeoutMs: 9, cwd: '/other' });
    expect(calls[1]?.opts).toEqual({ timeoutMs: 9, maxOutputBytes: 256 * 1024, cwd: '/other' });
    expect(s2.command).toBe('pytest -q');
  });
  it('the QuixBugs runner JSON is detected on stdout', async () => {
    const v = createVerifier({ run: async () => ({ stdout: fixture('quixbugs-gcd-buggy.json'), stderr: '', exitCode: 1 }) });
    const s = await v.runTests('python3 run_tests.py gcd gcd.py');
    expect(s).toMatchObject({ passed: 1, errors: 5, total: 6 });
    expect(s.failing).toHaveLength(5);
  });
  it('the verifier exposes the pure functions', () => {
    const v = createVerifier({ run: async () => ({ stdout: '', exitCode: 0 }) });
    expect(typeof v.progress).toBe('function');
    expect(typeof v.route).toBe('function');
    expect(typeof v.applyCandidate).toBe('function');
    expect(typeof v.progressQuestions).toBe('function');
    expect(typeof v.pickNextFailingTest).toBe('function');
    expect(typeof v.judgeProgress).toBe('function');
  });
});

describe('summarize(): killed and result-less runs', () => {
  it('a timeout adds the synthetic <test run> failure and keeps whatever parsed', () => {
    const s = summarize('pytest -q', { stdout: 'test_x.py::test_a PASSED [ 50%]\n', exitCode: null, timedOut: true }, 30_000);
    expect(s.timedOut).toBe(true);
    expect(s.failing).toEqual(['<test run>']);
    expect(s.passing).toEqual(['test_x.py::test_a']);
    expect(s.total).toBe(2);
    expect(s.failures[0]).toMatchObject({ testId: '<test run>', call: 'pytest -q', actual: 'timeout after 30 s' });
  });
  it('killedBy === "timeout" is read when timedOut is absent', () => {
    const s = summarize('cmd', { stdout: '', exitCode: null, killedBy: 'timeout' }, 100);
    expect(s.timedOut).toBe(true);
    expect(s.failing).toEqual(['<test run>']);
  });
  it('unknown output with a non-zero exit is a run failure carrying the last line', () => {
    const s = summarize('python3 x.py', { stdout: '', stderr: 'Traceback...\nSyntaxError: invalid syntax', exitCode: 1 }, 5);
    expect(detectFormat('', 'Traceback...\nSyntaxError: invalid syntax')).toBe('unknown');
    expect(s.failing).toEqual(['<test run>']);
    expect(s.failures[0]?.actual).toBe('exit 1: SyntaxError: invalid syntax');
    expect(s).toMatchObject({ errors: 1, total: 1, passed: 0 });
  });
  it('a recognised format with a non-zero exit but no parsed failure (truncated / crashed) is a run failure, never a pass', async () => {
    const { progress } = await import('../../../../src/synth/verify/progress.js');
    // pytest exited 1 (tests failed) but the output we got only shows a pass: the tail was lost
    const after = summarize('pytest -v', { stdout: 'test_x.py::test_a PASSED [ 50%]\n', exitCode: 1 }, 5);
    expect(after.failing).toEqual(['<test run>']);
    expect(after.failures[0]?.actual).toMatch(/^exit 1 with no failing test in the parsed output/);
    expect(after).toMatchObject({ passed: 1, errors: 1, total: 2 });
    const before = summarize('pytest -v', { stdout: 'test_x.py::test_a PASSED [ 50%]\ntest_x.py::test_b FAILED [100%]\n1 failed, 1 passed in 0.01s\n', exitCode: 1 }, 5);
    expect(progress(before, after).allPass).toBe(false);
    // the same with a signal kill (exit null) and with the QuixBugs JSON claiming success on exit 1
    expect(summarize('pytest -q', { stdout: '2 passed in 0.01s\n', exitCode: null }, 5).failing).toEqual(['<test run>']);
    expect(summarize('cmd', { stdout: fixture('quixbugs-gcd-correct.json'), exitCode: 1 }, 1).failing).toEqual(['<test run>']);
    // a consistent run is untouched
    expect(summarize('pytest -q', { stdout: fixture('pytest-allpass.txt'), exitCode: 0 }, 5).failing).toEqual([]);
    expect(summarize('pytest -q', { stdout: fixture('pytest-q.txt'), exitCode: 1 }, 5).failing).not.toContain('<test run>');
  });
  it('unknown output with exit 0 or pytest exit 5 is simply an empty run', () => {
    expect(summarize('true', { stdout: '', exitCode: 0 }, 1)).toMatchObject({ total: 0, failing: [] });
    expect(summarize('pytest', { stdout: '', exitCode: 5 }, 1)).toMatchObject({ total: 0, failing: [] });
  });
  it('the same synthetic id in before and after reads as no change, so a hang before and after is not a regression', async () => {
    const { progress } = await import('../../../../src/synth/verify/progress.js');
    const hang = summarize('pytest -q', { stdout: '', exitCode: null, timedOut: true }, 1000);
    const p = progress(hang, hang);
    expect(p).toMatchObject({ improved: false, regressed: false, allPass: false, newlyFailing: [], newlyPassing: [] });
  });
  it('detectFormat', () => {
    expect(detectFormat(fixture('quixbugs-gcd-correct.json'), '')).toBe('quixbugs_json');
    expect(detectFormat('', fixture('pytest-q.txt'))).toBe('pytest');
    expect(detectFormat('', 'nothing')).toBe('unknown');
  });
});

describe('sandboxRunFn adapts Sandbox.run', () => {
  it('forwards options with the signal and maps the ExecResult', async () => {
    const seen: { command: string; opts: SandboxRunOptions }[] = [];
    const exec: ExecResult = { ok: false, exitCode: 1, signal: null, stdout: 'out', stderr: 'err', truncated: false, bytesSeen: 6, killedBy: null, timedOut: false, orphans: [], sandboxExecDenied: false, durationMs: 12 };
    const sandbox: Sandbox = {
      level: 'none',
      run: async (command, opts) => {
        seen.push({ command, opts });
        return exec;
      },
      killAll: async () => undefined,
    };
    const ctl = new AbortController();
    const run = sandboxRunFn(sandbox, ctl.signal);
    const r = await run('pytest -q', { timeoutMs: 10, maxOutputBytes: 20 });
    expect(seen[0]?.opts).toEqual({ timeoutMs: 10, maxOutputBytes: 20, signal: ctl.signal });
    expect(r).toEqual({ stdout: 'out', stderr: 'err', exitCode: 1, timedOut: false, killedBy: null, durationMs: 12 });
    await run('x', { timeoutMs: 1, maxOutputBytes: 2, cwd: '/w' });
    expect(seen[1]?.opts.cwd).toBe('/w');
  });
});
