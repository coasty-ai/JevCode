/**
 * Oracle from the issue (Jev-only): code extracts candidate reproduction snippets from the task
 * text, one Jev request judges which block reproduces the bug / shows the expected output and
 * what kind of failure it is, code turns the pick into a runnable script with a pass criterion,
 * and goal.ts hands the result to the search as one failing test `repro::<sha8>`. Measured on
 * the 30 SWE-bench Verified instances in experiments/results/oracle-from-issue.md.
 */
export type { BlockJudgement, BlockKind, BlockOrigin, CodeBlock, Criterion, CriterionStrength, Expectation, ExpectationPattern, ExpectedValue, Extraction, FailureKind, FrameJudgement, NormalisedRepl, OracleJudgement, ReplStatement, ReplTranscript, ReproException, ReproRunResult, StatementResult, Traceback, TracebackFrame, Verdict } from './types.js';
export { BLOCK_CHARS_MAX, EXPECTATION_CHARS_MAX, MAX_BLOCKS, exceptionTypeIn, expectationsIn, expectedActualOf, extractBlocks, isTestModule, looksLikeCode, normaliseRepl, parseRepl, parseTraceback, stripTrailingComment, tracebacksIn } from './extract.js';
export { FAILURE_KINDS, FAILURE_KIND_ID, FRAME_IN_FIX_CRITERIA, FRAME_IN_FIX_PREFIX, ISSUE_CHARS_MAX, IS_REPRODUCTION_PREFIX, MAX_FRAMES, PICK_THRESHOLD, REPRODUCTION_CRITERIA, TIE_MARGIN, SHOWS_ACTUAL_CRITERIA, SHOWS_ACTUAL_PREFIX, SHOWS_EXPECTED_CRITERIA, SHOWS_EXPECTED_PREFIX, chooseBlocks, framesToOffer, isFailureKind, isRunnable, oracleQuestions, readOracleAnswers } from './questions.js';
export type { BlockChoice, OracleQuestionInput, OracleQuestionSet } from './questions.js';
export { NETWORK_ERROR_TYPES, OUTPUT_TAIL_CHARS, REPRO_MAX_OUTPUT_BYTES, REPRO_SENTINEL, REPRO_TIMEOUT_MS, VALUE_CHARS_MAX, boundNames, buildCriterion, buildReproScript, chunksOf, chunksWithContext, describeCriterion, detectNetworkUse, evaluateCriterion, evidenceStatements, normaliseValue, parseReproOutput, reproCommand, runRepro, valuesEqual, valuesEqualLoose } from './runner.js';
export type { BuiltCriterion, ChunksWithContext, CriterionInput, NetworkUse, ReproRunOptions, ReproScriptOptions } from './runner.js';
export { REGRESSION_FILES_MAX, REPRO_ID_PREFIX, callOf, regressionScope, reproTestId, reproductionGoal, summaryOf, verifyRepro } from './goal.js';
export type { RegressionScope, RegressionScopeOptions, ReproGoal, ReproSpec, ReproductionGoalInput, VerifyReproResult } from './goal.js';
export { BEST_GUESS_ID_PREFIX, BEST_GUESS_NOTE, BEST_GUESS_PARK_REASON, BEST_GUESS_REJECTED_REASON, INSTALL_GENERATED_FILES, NETWORK_ORACLE_OPEN_PROBLEM, REGRESSION_SCOPE_MAX, RELATED_FILLS_FIRST, REPOSITORY_MIN_SOURCE_FILES, REPOSITORY_MIN_TEST_FILES, bestGuessFailure, bestGuessTestId, chooseRegressionScope, emptyScopedSummary, findIssueOracle, frameworkOf, isBestGuessTestId, isRepositoryWorkspace, isReproTestId, isScopeTestModule, mergeSummaries, moduleStems, oracleNeedsArbitration, oracleYieldsGoal, packageNameOf, regressionCommandTemplate, scopeCommand, scopedPartOf, snippetIncomplete, stemRelatedTestFiles, tracebackTextFor, venvPython } from './search.js';
export type { ChooseScopeOptions, OracleAsk, OracleOutcome, OracleSearch, OracleSearchInput, RegressionScopeChoice, ScopeTier } from './search.js';
export { UNSTABLE_ACTUAL_PREFIX, compareRank, isUnstableOutcome, laneEnv, restoreGeneratedFiles, runRepositoryQueue, runSamplesOf } from './verify.js';
export type { RepositoryQueueOptions } from './verify.js';
