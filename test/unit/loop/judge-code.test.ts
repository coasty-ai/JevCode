/**
 * The code judge and the completion fact of llm-jev (docs/LLM-JEV-DESIGN.md §3 row 7, §6.6): a `run`'s JudgeResult
 * from the parsed counts, claim acceptance by arithmetic (the suite passed, or the goal tests are in the confirmed
 * `newlyPassing`), `tests_pass_unparsed` consumed only when the parser read nothing, Q21/Q22 built as record-only
 * questions, and `isCompleteByFact` on the claiming run and on a verified `done`.
 */
import { describe, expect, it } from 'vitest';
import { assertQuestionBatch } from '../../../src/jev/questions.js';
import { isCompleteByFact } from '../../../src/loop/stages/complete.js';
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
    expect(codeJudge(run({ tests: null, exitCode: 0 }), [ITEM], goals([ITEM]))).toMatchObject({ succeeded: 1, errorPresent: 0, tests: null });
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
  const parsed = { parsed: { passed: 2, failed: 0, errors: 0, skipped: 0 }, allPassed: true };
  const completion = { command: 'pytest -q', allPassed: true, total: 2, step: 1 };
  const base = { action: 'run' as const, outcome: 'executed' as const, tests: parsed, completion, testsPassUnparsed: null, verifiedDone: false };
  it('the claiming run: executed, parsed green, declared on the evidence', () => {
    expect(isCompleteByFact(base)).toBe(true);
    expect(isCompleteByFact({ ...base, completion: undefined })).toBe(false);
    expect(isCompleteByFact({ ...base, completion: { ...completion, allPassed: false } })).toBe(false);
    expect(isCompleteByFact({ ...base, tests: { parsed: { passed: 2, failed: 1, errors: 0, skipped: 0 }, allPassed: false } })).toBe(false);
    expect(isCompleteByFact({ ...base, tests: { parsed: { passed: 0, failed: 0, errors: 0, skipped: 0 }, allPassed: true } })).toBe(false);
    expect(isCompleteByFact({ ...base, tests: null })).toBe(false);
    expect(isCompleteByFact({ ...base, outcome: 'failed' })).toBe(false);
    // unparseable runner: the recorded tests_pass_unparsed stands in at 0.85
    expect(isCompleteByFact({ ...base, tests: { parsed: null, allPassed: null }, testsPassUnparsed: 0.9 })).toBe(true);
    expect(isCompleteByFact({ ...base, tests: { parsed: null, allPassed: null }, testsPassUnparsed: 0.8 })).toBe(false);
  });
  it('a done completes only when the engine verified it; patches never complete', () => {
    expect(isCompleteByFact({ ...base, action: 'done', outcome: 'noop', tests: null, completion: undefined, verifiedDone: true })).toBe(true);
    expect(isCompleteByFact({ ...base, action: 'done', outcome: 'noop', tests: null, completion: undefined, verifiedDone: false })).toBe(false);
    expect(isCompleteByFact({ ...base, action: 'patch', verifiedDone: true })).toBe(false);
  });
});
