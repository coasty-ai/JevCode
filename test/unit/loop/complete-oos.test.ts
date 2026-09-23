/**
 * Out-of-sample iteration 1, changes 6(b) and 8 (docs/research/llm-jev/oos-analysis-2026-09-22.md).
 *
 * 6(b) `complete|task_complete` was asked on every step — 127 questions, 87.7 % below 0.5 — while
 *      `isCompleteByFact` decides the stop and the answer is "recorded, never consulted".
 * 8    `sympy-20428` (`20260922-063746-h3qflvih`): step 2 committed an `llm`-sourced patch whose
 *      claiming-run evidence read `319 → 320 passed` with `newlyPassing: ["repro::8813d39a"]` and
 *      `completion.oracle: "llm_valid"`; the step-3 claiming run was therefore refused by
 *      `completionEvidenceHolds`, and the run self-terminated `complete` one step later on the
 *      step-4 `done`, which asked for nothing but `verifiedDone`. SWE-bench eval returned 1.
 */
import { describe, expect, it } from 'vitest';
import type { CompletionEvidence } from '../../../src/core/types.js';
import {
  INDEPENDENT_WITNESSES_REQUIRED,
  completeQuestionDue,
  completionEvidenceHolds,
  completionFactsHold,
  doneCompletionAllowed,
  independentWitnessSelections,
  isCompleteByFact,
  isRepositoryClass,
  scopedSuiteVerified,
  secondWitnessHolds,
  type ClaimingCompletionEvidence,
  type CompletionFactInput,
} from '../../../src/loop/stages/complete.js';

/** the command sympy-20428's scoped baseline ran (run.json / steps.jsonl step 3), shortened */
const SCOPED = 'python bin/test -C --verbose sympy/polys/tests/test_densebasic.py';
const REPRO = 'repro::8813d39a';

/** the completion evidence the step-3 claiming run of 20260922-063746-h3qflvih actually carried */
const SYMPY_20428: ClaimingCompletionEvidence = { ledgerFixed: true, testsChanged: [], guardPending: false, repro: 'pass', oracle: 'llm_valid', command: SCOPED };
/** the same run with a code oracle, so only the witness rule can refuse it */
const CODE_ORACLE: ClaimingCompletionEvidence = { ...SYMPY_20428, oracle: 'valid' };

function doneFact(completion: ClaimingCompletionEvidence | undefined): CompletionFactInput {
  return { action: 'done', outcome: 'noop', tests: null, testsCurrent: true, completion, testsPassUnparsed: null, verifiedDone: true };
}

describe('change 6(b): completeQuestionDue', () => {
  it('127 askings, 87.7 % below 0.5: the question is due only when a goal just closed or nothing is left to close', () => {
    expect(completeQuestionDue({ goalJustClosed: true, planRemaining: 3 })).toBe(true);
    expect(completeQuestionDue({ goalJustClosed: false, planRemaining: 0 })).toBe(true);
    expect(completeQuestionDue({ goalJustClosed: true, planRemaining: 0 })).toBe(true);
    // the 87.7 %: a step that closed nothing with work still listed
    expect(completeQuestionDue({ goalJustClosed: false, planRemaining: 1 })).toBe(false);
    expect(completeQuestionDue({ goalJustClosed: false, planRemaining: 7 })).toBe(false);
  });
});

describe('a best-guess goal verified by its scoped suite (no reproduction oracle) completes on the scoped-suite fact', () => {
  /** the claiming run of a no-oracle repository run (the demo-py hero task): nothing verifies it until the scope flips */
  const NO_ORACLE: ClaimingCompletionEvidence = { ledgerFixed: true, testsChanged: [], guardPending: false, repro: 'none', oracle: 'no_blocks', command: SCOPED };
  const SCOPED_VERIFIED: ClaimingCompletionEvidence = { ...NO_ORACLE, scopedSuite: { failingAtBase: 3, total: 7 } };

  it('the repository class with nothing verifying it never completes; with the scoped suite flipped it holds, as a claiming run and as a `done`', () => {
    expect(isRepositoryClass(NO_ORACLE)).toBe(true);
    expect(scopedSuiteVerified(NO_ORACLE)).toBe(false);
    expect(completionFactsHold(NO_ORACLE)).toBe(false);
    expect(scopedSuiteVerified(SCOPED_VERIFIED)).toBe(true);
    expect(completionFactsHold(SCOPED_VERIFIED)).toBe(true);
    expect(completionEvidenceHolds(SCOPED_VERIFIED, SCOPED)).toBe(true);
    expect(completionEvidenceHolds(SCOPED_VERIFIED, 'pytest -q')).toBe(false);
    expect(secondWitnessHolds(SCOPED_VERIFIED)).toBe(true);
    expect(doneCompletionAllowed(SCOPED_VERIFIED)).toBe(true);
    expect(isCompleteByFact(doneFact(SCOPED_VERIFIED))).toBe(true);
    expect(isCompleteByFact(doneFact(NO_ORACLE))).toBe(false);
  });

  it('the fact needs a scope that failed at the base commit and no reproduction: a green-at-base scope, an impossible count or a reproduction alongside never qualifies', () => {
    expect(scopedSuiteVerified({ ...NO_ORACLE, scopedSuite: { failingAtBase: 0, total: 7 } })).toBe(false);
    expect(scopedSuiteVerified({ ...NO_ORACLE, scopedSuite: { failingAtBase: 8, total: 7 } })).toBe(false);
    expect(scopedSuiteVerified({ ...SCOPED_VERIFIED, repro: 'fail' })).toBe(false);
    expect(completionFactsHold({ ...SCOPED_VERIFIED, repro: 'fail' })).toBe(false);
    expect(completionFactsHold({ ...SCOPED_VERIFIED, ledgerFixed: false })).toBe(false);
    expect(completionFactsHold({ ...SCOPED_VERIFIED, testsChanged: ['tests/test_core.py'] })).toBe(false);
  });
});

describe('change 8: a second, independently derived witness before a repository-class `complete`', () => {
  it('independence is the distinct selection, not the number of entries', () => {
    expect(INDEPENDENT_WITNESSES_REQUIRED).toBe(2);
    expect(independentWitnessSelections(undefined)).toEqual([]);
    expect(independentWitnessSelections({ witnesses: [] })).toEqual([]);
    // two entries, ONE derivation: the same selection twice is not a second witness
    expect(independentWitnessSelections({ witnesses: [{ kind: 'repro', selection: REPRO }, { kind: 'regression', selection: ` ${REPRO} ` }] })).toEqual([REPRO]);
    expect(independentWitnessSelections({ witnesses: [{ kind: 'repro', selection: REPRO }, { kind: 'regression', selection: 'test_densebasic.py::test_dmp_strip' }] })).toEqual([REPRO, 'test_densebasic.py::test_dmp_strip'].sort());
    // a blank selection is no selection
    expect(independentWitnessSelections({ witnesses: [{ kind: 'repro', selection: '   ' }] })).toEqual([]);
  });

  it('the repository class is where the rule applies; off it (QuixBugs, the ladder) every run is unchanged', () => {
    const plain: CompletionEvidence = { ledgerFixed: true, testsChanged: [], guardPending: false, repro: 'none', oracle: null };
    expect(isRepositoryClass(plain)).toBe(false);
    expect(secondWitnessHolds(plain)).toBe(true);
    expect(isRepositoryClass(CODE_ORACLE)).toBe(true);
    expect(secondWitnessHolds(CODE_ORACLE)).toBe(false);
    expect(secondWitnessHolds({ ...CODE_ORACLE, witnesses: [{ kind: 'repro', selection: REPRO }] })).toBe(false);
    expect(secondWitnessHolds({ ...CODE_ORACLE, witnesses: [{ kind: 'repro', selection: REPRO }, { kind: 'regression', selection: 'sympy/polys/tests/test_densebasic.py::test_dmp_strip' }] })).toBe(true);
    // a second reproduction VARIANT is the other admissible witness
    expect(secondWitnessHolds({ ...CODE_ORACLE, witnesses: [{ kind: 'repro', selection: REPRO }, { kind: 'repro', selection: 'repro::deadbeef01' }] })).toBe(true);
  });

  it('20260922-063746-h3qflvih: the step-4 `done` no longer self-terminates on the issue reproduction alone', () => {
    // as recorded: repro::8813d39a is the only failing → passing selection, so there is one witness
    const asRecorded: ClaimingCompletionEvidence = { ...SYMPY_20428, witnesses: [{ kind: 'repro', selection: REPRO }] };
    // the behavioural regression: before change 8 this `done` returned true on `verifiedDone` alone
    expect(isCompleteByFact(doneFact(asRecorded))).toBe(false);
    expect(doneCompletionAllowed(asRecorded)).toBe(false);
    // and it is refused twice over: `llm_valid` is not a COMPLETING_ORACLE_OUTCOMES code oracle, which is
    // exactly why its own step-3 claiming run was already refused — the `done` asked for none of that
    expect(completionFactsHold(SYMPY_20428)).toBe(false);
    expect(completionEvidenceHolds(SYMPY_20428, SCOPED)).toBe(false);
    expect(isCompleteByFact(doneFact({ ...CODE_ORACLE, witnesses: [{ kind: 'repro', selection: REPRO }] }))).toBe(false);
  });

  it('a `done` with a second witness on a different selection still completes, and so does every `done` that declares no evidence', () => {
    const witnessed: ClaimingCompletionEvidence = { ...CODE_ORACLE, witnesses: [{ kind: 'repro', selection: REPRO }, { kind: 'regression', selection: 'sympy/polys/tests/test_polytools.py::test_clear_denoms' }] };
    expect(isCompleteByFact(doneFact(witnessed))).toBe(true);
    // QuixBugs / ladder / jev-only: no declared completion evidence on the `done`, nothing to hold it to
    expect(isCompleteByFact(doneFact(undefined))).toBe(true);
    // the other two `done` conditions still gate
    expect(isCompleteByFact({ ...doneFact(witnessed), verifiedDone: false })).toBe(false);
    expect(isCompleteByFact({ ...doneFact(witnessed), outcome: 'executed' })).toBe(false);
  });

  it('the claiming-run path is unchanged: `completionEvidenceHolds` weighs the §6.6 facts and the command, never the witnesses', () => {
    expect(completionEvidenceHolds(CODE_ORACLE, SCOPED)).toBe(true);
    expect(completionEvidenceHolds({ ...CODE_ORACLE, witnesses: [] }, SCOPED)).toBe(true);
    expect(completionEvidenceHolds(CODE_ORACLE, 'pytest -q')).toBe(false);
    expect(completionEvidenceHolds({ ...CODE_ORACLE, repro: 'fail' }, SCOPED)).toBe(false);
    expect(completionEvidenceHolds({ ...CODE_ORACLE, ledgerFixed: false }, SCOPED)).toBe(false);
    expect(completionEvidenceHolds({ ...CODE_ORACLE, guardPending: true }, SCOPED)).toBe(false);
    expect(completionEvidenceHolds({ ...CODE_ORACLE, testsChanged: ['sympy/polys/tests/test_densebasic.py'] }, SCOPED)).toBe(false);
    const run: CompletionFactInput = {
      action: 'run',
      outcome: 'executed',
      tests: { command: SCOPED, parsed: { passed: 320, failed: 0, errors: 0, skipped: 0 }, allPassed: true },
      testsCurrent: true,
      completion: CODE_ORACLE,
      testsPassUnparsed: null,
      verifiedDone: false,
    };
    expect(isCompleteByFact(run)).toBe(true);
  });
});
