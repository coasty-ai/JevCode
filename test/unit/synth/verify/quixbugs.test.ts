import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { summarize } from '../../../../src/synth/verify/index.js';
import { CASE_TIMEOUT_ENV, caseTimeoutLimitMs, countCaseTimeouts, hangsOnEveryFailure, isCaseNotRun, isCaseTimeout, MAX_CASE_TIMEOUTS_ENV, parseRunTestsJson, quixbugsTestCommand, quixbugsTestId, summaryFromRunTests } from '../../../../src/synth/verify/quixbugs.js';
import { progress } from '../../../../src/synth/verify/progress.js';
import { fixture, QUIXBUGS_DIR } from './helpers.js';

const ctx = { command: 'python3 run_tests.py gcd gcd.py', exitCode: 1, timedOut: false, durationMs: 300, outputTail: '' };

describe('run_tests.py JSON → summary (saved fixtures)', () => {
  it('buggy gcd: 1 passed, 5 errors, ids derived from the inputs', () => {
    const report = parseRunTestsJson(fixture('quixbugs-gcd-buggy.json'));
    expect(report).not.toBeNull();
    if (report === null || 'error' in report) throw new Error('unexpected');
    expect(report).toMatchObject({ name: 'gcd', passed: 1, failed: 0, errors: 5, timeouts: 0, skipped: 0, total: 6 });
    const s = summaryFromRunTests(report, ctx);
    expect(s.failing).toEqual(['gcd(13, 13)', 'gcd(37, 600)', 'gcd(20, 100)', 'gcd(624129, 2061517)', 'gcd(3, 12)']);
    expect(s.passing).toEqual([]);
    expect(s.failures[0]).toEqual({ testId: 'gcd(13, 13)', call: 'gcd(13, 13)', expected: '13', actual: 'RecursionError: maximum recursion depth exceeded in comparison' });
    expect(s.total).toBe(6);
  });
  it('correct gcd: 6 passed, nothing failing', () => {
    const s = summarize('cmd', { stdout: fixture('quixbugs-gcd-correct.json'), exitCode: 0 }, 1);
    expect(s).toMatchObject({ passed: 6, failed: 0, errors: 0, total: 6, failing: [], failures: [] });
  });
  it('module-tested program (breadth_first_search): label is the id, expected is "pass"', () => {
    const s = summarize('cmd', { stdout: fixture('quixbugs-bfs-buggy.json'), exitCode: 1 }, 1);
    expect(s).toMatchObject({ passed: 4, errors: 1, total: 5 });
    expect(s.failures[0]).toMatchObject({ testId: 'test3: Case 3: Two unconnected nodes in graph', expected: 'pass' });
    expect(s.failures[0]?.actual.startsWith('IndexError: pop from an empty deque')).toBe(true);
  });
  it('the runner\'s own error line becomes a synthetic run failure', () => {
    const s = summarize('cmd', { stdout: '{"name": "gcd", "error": "candidate not found: /x.py"}', exitCode: 2 }, 1);
    expect(s.failing).toEqual(['<test run>']);
    expect(s.failures[0]?.actual).toBe('run_tests.py: candidate not found: /x.py');
    expect(s.errors).toBe(1);
  });
  it('parse tolerates noise before the JSON line and rejects incomplete objects', () => {
    expect(parseRunTestsJson('warning\n{"passed": 1}\n{"name":"x","passed":1,"failed":0,"errors":0,"timeouts":0,"skipped":0,"total":1,"failures":[]}\n')).toMatchObject({ passed: 1, total: 1 });
    expect(parseRunTestsJson('{"passed": 1}')).toBeNull();
    expect(parseRunTestsJson('')).toBeNull();
  });
  it('ids: arrays as calls, strings verbatim, others as JSON', () => {
    expect(quixbugsTestId('f', [1, 'a', [2]])).toBe('f(1, "a", [2])');
    expect(quixbugsTestId('f', 'label')).toBe('label');
    expect(quixbugsTestId('f', 3)).toBe('f(3)');
  });
  it('quixbugsTestCommand lifts the failure cap and quotes paths', () => {
    const cmd = quixbugsTestCommand("/tmp/q's", 'gcd', '/w/gcd.py', { timeoutSec: 3 });
    expect(cmd).toBe("PYTHONDONTWRITEBYTECODE=1 python3 '/tmp/q'\\''s/run_tests.py' 'gcd' '/w/gcd.py' --max-failures 1000 --timeout 3");
  });
});

describe('per-case timeout texts (§4.1)', () => {
  const f = (actual: string) => ({ testId: actual, call: actual, expected: '', actual });
  it('recognises both runners\' timeout texts and the design\'s, and reads the limit back', () => {
    expect(isCaseTimeout('TIMEOUT after 2s')).toBe(true);
    expect(caseTimeoutLimitMs('TIMEOUT after 0.5s')).toBe(500);
    expect(isCaseTimeout('test_bitcount.CaseTimeout: no result after 2s')).toBe(true);
    expect(caseTimeoutLimitMs('test_bitcount.CaseTimeout: no result after 0.1s')).toBe(100);
    expect(caseTimeoutLimitMs('Timeout: the program did not finish within 2 seconds (probable infinite loop)')).toBe(2000);
    expect(isCaseTimeout('RecursionError: maximum recursion depth exceeded')).toBe(false);
    expect(isCaseTimeout('timeout after 3 s')).toBe(false); // the sandbox kill's `<test run>` text is not a case timeout
    expect(caseTimeoutLimitMs('0')).toBeNull();
    expect(isCaseNotRun('test_x.CaseNotRun: not run: 1 earlier case(s) timed out')).toBe(true);
    expect(isCaseNotRun('not run: 3 earlier case(s) timed out')).toBe(true);
    expect(isCaseNotRun('TIMEOUT after 2s')).toBe(false);
    expect(CASE_TIMEOUT_ENV).toBe('JEVCODE_CASE_TIMEOUT_MS');
    expect(MAX_CASE_TIMEOUTS_ENV).toBe('JEVCODE_MAX_CASE_TIMEOUTS');
  });
  it('countCaseTimeouts and hangsOnEveryFailure', () => {
    const hang = { failures: [f('TIMEOUT after 2s'), f('TIMEOUT after 2s')] };
    expect(countCaseTimeouts(hang)).toEqual({ timeouts: 2, notRun: 0, limitMs: 2000 });
    expect(hangsOnEveryFailure(hang)).toBe(true);
    const stopped = { failures: [f('test_x.CaseTimeout: no result after 0.5s'), f('test_x.CaseNotRun: not run: 1 earlier case(s) timed out')] };
    expect(countCaseTimeouts(stopped)).toEqual({ timeouts: 1, notRun: 1, limitMs: 500 });
    expect(hangsOnEveryFailure(stopped)).toBe(true);
    // a wrong value beside the timeouts: the candidate does not only hang
    expect(hangsOnEveryFailure({ failures: [f('TIMEOUT after 2s'), f('6')] })).toBe(false);
    // stop-rule skips with no timeout at all (cannot happen, but is not a hang), and nothing failing
    expect(hangsOnEveryFailure({ failures: [f('not run: 1 earlier case(s) timed out')] })).toBe(false);
    expect(hangsOnEveryFailure({ failures: [] })).toBe(false);
    expect(countCaseTimeouts({ failures: [f('TIMEOUT after 0.5s'), f('TIMEOUT after 2s')] }).limitMs).toBe(2000);
  });
});

const havePython = spawnSync('python3', ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)'], { encoding: 'utf8', timeout: 10_000 }).status === 0;
const haveRunner = existsSync(join(QUIXBUGS_DIR, 'run_tests.py'));

describe.skipIf(!havePython || !haveRunner)('the real run_tests.py through child_process', () => {
  const run = (candidate: string) => {
    const r = spawnSync('python3', [join(QUIXBUGS_DIR, 'run_tests.py'), 'gcd', candidate, '--max-failures', '100'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    return summarize('run_tests.py gcd', { stdout: r.stdout, stderr: r.stderr, exitCode: r.status }, 100);
  };
  it('buggy and correct gcd reproduce the saved fixtures and their progress is a clean fix', () => {
    const before = run(join(QUIXBUGS_DIR, 'programs/gcd.py'));
    const after = run(join(QUIXBUGS_DIR, 'correct/gcd.py'));
    expect({ passed: before.passed, errors: before.errors, total: before.total, failing: before.failing }).toEqual({
      passed: 1,
      errors: 5,
      total: 6,
      failing: ['gcd(13, 13)', 'gcd(37, 600)', 'gcd(20, 100)', 'gcd(624129, 2061517)', 'gcd(3, 12)'],
    });
    expect(before.exitCode).toBe(1);
    expect(after).toMatchObject({ passed: 6, total: 6, failing: [], exitCode: 0 });
    const p = progress(before, after);
    expect(p).toMatchObject({ allPass: true, improved: true, regressed: false, newlyFailing: [] });
    expect(p.newlyPassing).toEqual(before.failing);
  });
});
