/**
 * The code judge and the completion fact of llm-jev (docs/LLM-JEV-DESIGN.md §3 row 7, §6.6): a `run`'s JudgeResult
 * from the parsed counts, claim acceptance by arithmetic (the suite passed, or the goal tests are in the confirmed
 * `newlyPassing`), `tests_pass_unparsed` consumed only when the parser read nothing, Q21/Q22 built as record-only
 * questions, and `isCompleteByFact` on the claiming run and on a verified `done`.
 */
import { describe, expect, it } from 'vitest';
import { assertQuestionBatch } from '../../../src/jev/questions.js';
import type { CompletionEvidence } from '../../../src/core/types.js';
import { completionEvidenceHolds, isCompleteByFact, knownFailureCount, knownFailuresOf, unexpectedFailures, type ClaimingCompletionEvidence } from '../../../src/loop/stages/complete.js';
import { buildRecordOnlyQuestions, codeJudge, ledgerGoalsOf, type CodeJudgeRun } from '../../../src/loop/stages/judge.js';

const T1 = 'tests/test_a.py::test_f';
const T2 = 'tests/test_a.py::test_g';
const ITEM = `fix ${T1} in src/a.py`;
const VERIFY = 'verify the full test suite passes';

function run(over: Partial<CodeJudgeRun> = {}): CodeJudgeRun {
  return { tests: { command: 'pytest -q', parsed: { passed: 2, failed: 0, errors: 0, skipped: 0 }, allPassed: true }, exitCode: 0, evidence: null, testsPassUnparsed: null, ...over };
}
const goals = (claims: readonly string[]): Map<string, readonly string[]> => ledgerGoalsOf(claims, [T1, T2]);

describe('codeJudge (llm-jev)', () => {
  it('a passing parsed run: succeeded 1, no error, nothing inferred, every claim accepted, source code', () => {
    const j = codeJudge(run(), [ITEM, VERIFY], goals([ITEM, VERIFY]));
    expect(j).toMatchObject({ succeeded: 1, errorPresent: 0, newInfo: 0, source: 'code', tests: { source: 'parsed', allPassed: true, passed: 2, failed: 0, errors: 0 } });
    expect(j.doneClaims).toEqual([
      { text: ITEM, judged: 1, accepted: true },
      { text: VERIFY, judged: 1, accepted: true },
    ]);
  });

  it('a failing run accepts a claim only when its goal tests are in the newlyPassing the executed counts confirm', () => {
    const parsed = { passed: 2, failed: 1, errors: 1, skipped: 0 };
    const tests = { command: 'pytest -q', parsed, allPassed: false };
    const agreeing = { after: { passed: 2, failed: 1, errors: 1, total: 4 }, newlyPassing: [T1, T2] };
    const j = codeJudge(run({ tests, evidence: agreeing }), [ITEM, VERIFY], goals([ITEM, VERIFY]));
    expect(j).toMatchObject({ succeeded: 0, errorPresent: 1, tests: { source: 'parsed', allPassed: false, passed: 2, failed: 1, errors: 1 } });
    expect(j.doneClaims).toEqual([
      { text: ITEM, judged: 1, accepted: true },
      { text: VERIFY, judged: 0, accepted: false },
    ]);
    // counts that disagree with the shadow run confirm nothing
    const disagreeing = { after: { passed: 3, failed: 0, errors: 1, total: 4 }, newlyPassing: [T1, T2] };
    expect(codeJudge(run({ tests, evidence: disagreeing }), [ITEM], goals([ITEM])).doneClaims).toEqual([{ text: ITEM, judged: 0, accepted: false }]);
    // a goal test outside newlyPassing is not accepted
    const partial = { after: { passed: 2, failed: 1, errors: 1, total: 4 }, newlyPassing: [T2] };
    expect(codeJudge(run({ tests, evidence: partial }), [ITEM], goals([ITEM])).doneClaims[0]?.accepted).toBe(false);
  });

  it('tests_pass_unparsed stands in only when the parser read nothing; a non-test command is judged on its exit code', () => {
    const unparsed = { command: 'pytest -q', parsed: null, allPassed: null };
    const green = codeJudge(run({ tests: unparsed, testsPassUnparsed: 0.9 }), [ITEM], goals([ITEM]));
    expect(green).toMatchObject({ succeeded: 1, errorPresent: 0, tests: { source: 'judged', allPassed: 0.9 } });
    expect(green.doneClaims[0]?.accepted).toBe(true);
    const unsure = codeJudge(run({ tests: unparsed, testsPassUnparsed: 0.6 }), [ITEM], goals([ITEM]));
    expect(unsure.succeeded).toBe(0);
    expect(unsure.doneClaims[0]?.accepted).toBe(false);
    // parsed counts win over the recorded Noul
    expect(codeJudge(run({ testsPassUnparsed: 0.1 }), [], new Map()).succeeded).toBe(1);
    // §3 row 7: `echo ok` exiting 0 succeeds as a command but accepts no ledger claim — only the test suite does
    const echoOk = codeJudge(run({ tests: null, exitCode: 0 }), [ITEM, VERIFY], goals([ITEM, VERIFY]));
    expect(echoOk).toMatchObject({ succeeded: 1, errorPresent: 0, tests: null });
    expect(echoOk.doneClaims).toEqual([
      { text: ITEM, judged: 0, accepted: false },
      { text: VERIFY, judged: 0, accepted: false },
    ]);
    expect(codeJudge(run({ tests: null, exitCode: 1 }), [ITEM], goals([ITEM]))).toMatchObject({ succeeded: 0, errorPresent: 1, tests: null });
  });

  it('ledgerGoalsOf: the item names one test, widened to the goal set when the evidence contains it; other claims name none', () => {
    const m = ledgerGoalsOf([`fix ${T1}, +1 more in src/a.py`, `fix ${T1} in the workspace`, 'fix tests/test_b.py::test_x in src/b.py', VERIFY], [T1, T2]);
    expect(m.get(`fix ${T1}, +1 more in src/a.py`)).toEqual([T1, T2]);
    expect(m.get(`fix ${T1} in the workspace`)).toEqual([T1, T2]);
    expect(m.get('fix tests/test_b.py::test_x in src/b.py')).toEqual(['tests/test_b.py::test_x']);
    expect(m.get(VERIFY)).toEqual([]);
  });

  it('record-only questions: done_<j>, tests_pass_unparsed when unparsed, task_complete — nothing else', () => {
    const qs = buildRecordOnlyQuestions({ testsUnparsed: true, claims: [ITEM, VERIFY] });
    expect(Object.keys(qs)).toEqual(['tests_pass_unparsed', 'done_0', 'done_1', 'task_complete']);
    assertQuestionBatch(qs);
    expect(Object.keys(buildRecordOnlyQuestions({ testsUnparsed: false, claims: [] }))).toEqual(['task_complete']);
  });
});

describe('isCompleteByFact (§6.6)', () => {
  const CMD = 'pytest -q';
  const parsed = { command: CMD, parsed: { passed: 2, failed: 0, errors: 0, skipped: 0 }, allPassed: true };
  const completion: CompletionEvidence = { ledgerFixed: true, testsChanged: [], guardPending: false, repro: 'none', oracle: null, command: CMD };
  const base = { action: 'run' as const, outcome: 'executed' as const, tests: parsed, testsCurrent: true, completion, testsPassUnparsed: null, verifiedDone: false };
  it('the claiming run: executed test command, parsed green, current, declared on the evidence', () => {
    expect(isCompleteByFact(base)).toBe(true);
    expect(isCompleteByFact({ ...base, completion: undefined })).toBe(false);
    expect(isCompleteByFact({ ...base, tests: { ...parsed, parsed: { passed: 2, failed: 1, errors: 0, skipped: 0 }, allPassed: false } })).toBe(false);
    expect(isCompleteByFact({ ...base, tests: { ...parsed, parsed: { passed: 0, failed: 0, errors: 0, skipped: 0 }, allPassed: true } })).toBe(false);
    expect(isCompleteByFact({ ...base, tests: null })).toBe(false);
    expect(isCompleteByFact({ ...base, outcome: 'failed' })).toBe(false);
    expect(isCompleteByFact({ ...base, testsCurrent: false })).toBe(false);
    // unparseable runner: the recorded tests_pass_unparsed stands in at 0.85
    expect(isCompleteByFact({ ...base, tests: { command: CMD, parsed: null, allPassed: null }, testsPassUnparsed: 0.9 })).toBe(true);
    expect(isCompleteByFact({ ...base, tests: { command: CMD, parsed: null, allPassed: null }, testsPassUnparsed: 0.8 })).toBe(false);
  });
  it('every synthesizer fact is required: ledger fixed, no test file touched, guard settled, the declared command', () => {
    expect(isCompleteByFact({ ...base, completion: { ...completion, ledgerFixed: false } })).toBe(false);
    expect(isCompleteByFact({ ...base, completion: { ...completion, testsChanged: ['tests/test_a.py'] } })).toBe(false);
    expect(isCompleteByFact({ ...base, completion: { ...completion, guardPending: true } })).toBe(false);
    expect(isCompleteByFact({ ...base, completion: { ...completion, command: 'pytest tests/test_a.py' } })).toBe(false);
    // no declared command: the executed test command is taken as the suite
    const undeclared: CompletionEvidence = { ...completion };
    delete undeclared.command;
    expect(isCompleteByFact({ ...base, completion: undeclared })).toBe(true);
  });
  it('repository class: the reproduction passes under a code oracle; an LLM-written or absent oracle never completes', () => {
    const repo = (repro: CompletionEvidence['repro'], oracle: CompletionEvidence['oracle']): boolean => completionEvidenceHolds({ ...completion, repro, oracle }, CMD);
    expect(repo('pass', 'valid')).toBe(true);
    expect(repo('pass', 'valid_weak')).toBe(true);
    expect(repo('pass', 'weak_network')).toBe(true);
    expect(repo('fail', 'valid')).toBe(false);
    expect(repo('none', 'valid')).toBe(false);
    expect(repo('pass', 'llm_valid')).toBe(false);
    expect(repo('pass', 'llm_weak')).toBe(false);
    expect(repo('pass', 'no_blocks')).toBe(false);
    // a reproduction verdict with no oracle at all is a repository run that found no oracle
    expect(repo('pass', null)).toBe(false);
    expect(isCompleteByFact({ ...base, completion: { ...completion, repro: 'pass', oracle: 'llm_valid' } })).toBe(false);
    expect(isCompleteByFact({ ...base, completion: { ...completion, repro: 'pass', oracle: 'valid' } })).toBe(true);
  });
  it('a done completes only when the engine verified it; patches never complete', () => {
    expect(isCompleteByFact({ ...base, action: 'done', outcome: 'noop', tests: null, completion: undefined, verifiedDone: true })).toBe(true);
    expect(isCompleteByFact({ ...base, action: 'done', outcome: 'noop', tests: null, completion: undefined, verifiedDone: false })).toBe(false);
    expect(isCompleteByFact({ ...base, action: 'patch', verifiedDone: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Head-to-head v2, class E′ (experiments/results/llm-jev-headtohead-v2.md §9): sympy-11618's
// claiming run reads 644 passed / 0 failed / 43 errors on a scoped suite that had those 43
// collection errors before the patch
// ---------------------------------------------------------------------------------------

describe('pre-existing failures: the claiming run is judged against the baseline\'s knownFailures, not against zero', () => {
  const CMD = 'python -m pytest -q sympy/printing/tests/test_latex.py';
  const KNOWN = 43;
  const counts = (errors: number, failed = 0): { passed: number; failed: number; errors: number; skipped: number } => ({ passed: 644, failed, errors, skipped: 0 });
  const tests = (errors: number, failed = 0): CodeJudgeRun['tests'] => ({ command: CMD, parsed: counts(errors, failed), allPassed: false });
  const completion: ClaimingCompletionEvidence = { ledgerFixed: true, testsChanged: [], guardPending: false, repro: 'pass', oracle: 'valid', command: CMD, knownFailures: KNOWN };
  const fact = { action: 'run' as const, outcome: 'executed' as const, tests: { command: CMD, parsed: counts(KNOWN), allPassed: false }, testsCurrent: true, completion, testsPassUnparsed: null, verifiedDone: false };

  it('the code judge: 43 pre-existing errors are not a failure and not an `error_present`; one error beyond them is both', () => {
    const green = codeJudge(run({ tests: tests(KNOWN), exitCode: 1, knownFailures: KNOWN }), [ITEM], goals([ITEM]));
    expect(green).toMatchObject({ succeeded: 1, errorPresent: 0, source: 'code', tests: { source: 'parsed', allPassed: false, passed: 644, failed: 0, errors: KNOWN } });
    expect(green.doneClaims).toEqual([{ text: ITEM, judged: 1, accepted: true }]);
    // the patch fixed one of them as well: still no failure beyond the baseline
    expect(codeJudge(run({ tests: tests(KNOWN - 1), exitCode: 1, knownFailures: KNOWN }), [ITEM], goals([ITEM])).succeeded).toBe(1);
    // one error more than the baseline had, or a newly failing test: the run did not succeed and the error is the engineer's
    expect(codeJudge(run({ tests: tests(KNOWN + 1), exitCode: 1, knownFailures: KNOWN }), [ITEM], goals([ITEM]))).toMatchObject({ succeeded: 0, errorPresent: 1 });
    expect(codeJudge(run({ tests: tests(KNOWN, 1), exitCode: 1, knownFailures: KNOWN }), [ITEM], goals([ITEM]))).toMatchObject({ succeeded: 0, errorPresent: 1 });
    // undeclared (every QuixBugs / ladder run): the old rule stands — the parser's own allPassed and zero failures
    expect(codeJudge(run({ tests: tests(KNOWN), exitCode: 1 }), [ITEM], goals([ITEM]))).toMatchObject({ succeeded: 0, errorPresent: 1 });
    expect(codeJudge(run({ tests: { command: CMD, parsed: counts(0), allPassed: true } }), [ITEM], goals([ITEM])).succeeded).toBe(1);
  });

  it('the completion fact: the claiming run completes on the declared known failures (the run ends `complete` instead of re-claiming `done partial`)', () => {
    expect(isCompleteByFact(fact)).toBe(true);
    // without the declaration the same run is not complete — this is the v2 behaviour that cost sympy-11618 7 steps
    const undeclared: ClaimingCompletionEvidence = { ...completion };
    delete undeclared.knownFailures;
    expect(isCompleteByFact({ ...fact, completion: undeclared })).toBe(false);
    // a failure beyond the baseline's, no passing test, a stale run, or a reproduction that does not pass: still not complete
    expect(isCompleteByFact({ ...fact, tests: { command: CMD, parsed: counts(KNOWN + 1), allPassed: false } })).toBe(false);
    expect(isCompleteByFact({ ...fact, tests: { command: CMD, parsed: counts(KNOWN, 2), allPassed: false } })).toBe(false);
    expect(isCompleteByFact({ ...fact, tests: { command: CMD, parsed: { passed: 0, failed: 0, errors: KNOWN, skipped: 0 }, allPassed: false } })).toBe(false);
    expect(isCompleteByFact({ ...fact, testsCurrent: false })).toBe(false);
    expect(isCompleteByFact({ ...fact, completion: { ...completion, repro: 'fail' } })).toBe(false);
    expect(isCompleteByFact({ ...fact, completion: { ...completion, oracle: 'llm_valid' } })).toBe(false);
    // a green run with nothing declared is unaffected (the QuixBugs path)
    expect(isCompleteByFact({ ...fact, tests: { command: CMD, parsed: counts(0), allPassed: true }, completion: { ...undeclared, repro: 'none', oracle: null } })).toBe(true);
  });

  it('knownFailuresOf / knownFailureCount / unexpectedFailures: a missing, zero or nonsense declaration means none', () => {
    expect([knownFailuresOf(undefined), knownFailuresOf(completion), knownFailuresOf({ ...completion, knownFailures: 0 }), knownFailuresOf({ ...completion, knownFailures: -3 })]).toEqual([0, KNOWN, 0, 0]);
    expect([knownFailureCount(undefined), knownFailureCount(Number.NaN), knownFailureCount(2.7), knownFailureCount(43)]).toEqual([0, 0, 2, 43]);
    expect([unexpectedFailures({ failed: 0, errors: 43 }, 43), unexpectedFailures({ failed: 1, errors: 43 }, 43), unexpectedFailures({ failed: 0, errors: 2 }, 0), unexpectedFailures({ failed: 0, errors: 40 }, 43)]).toEqual([0, 1, 2, 0]);
  });
});
