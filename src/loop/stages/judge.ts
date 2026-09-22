/**
 * Judge stage (DESIGN.md §5.5 judge): Nouls succeeded / error_present / new_information,
 * tests_pass_unparsed when the test command ran without a parsable summary, one done_<j>
 * per newly claimed plan item; batched with the completion Noul (complete.ts) in one request.
 *
 * llm-jev (docs/LLM-JEV-DESIGN.md §3 row 7, §6.3): the judge is code on every step. A `run`'s
 * JudgeResult is computed from the parsed counts against the baseline's known failures
 * (`evidence.completion.knownFailures`, complete.ts: pre-existing failures are not the engineer's to act
 * on — §9 class E′), the plan claims are
 * accepted by arithmetic (the suite passed, or the claim's goal tests are in the confirmed
 * `newlyPassing`), and Q21 `done_<j>` / Q22 `task_complete` are asked in one request and recorded
 * only — a disagreement with the code verdict is logged, never consumed. `tests_pass_unparsed` is
 * consumed only when the parser read nothing. `patch`/`read`/`edit`/`write` steps have `judge: null`
 * and ask nothing (patches claim nothing); a `done` records Q22 and its claims follow the code fact
 * the engine computed (`verifiedDone`).
 */
import { noul, ref } from '../../jev/questions.js';
import { routeSpeculative, type StepToken } from '../../jev/router.js';
import { RL4_JUDGE_DEADLINE_MS, noteStepRoute, routersOn, stepTokenFor } from '../routers.js';
import { clip } from '../../core/text.js';
import type { Answer, Decision, DoneClaimResult, JsonObject, JudgeResult, Proposal, ProposalEvidence, Question } from '../../core/types.js';
import type { StageContext } from '../engine.js';
import { buildJudgeState, type ExecutedInfo, type ExecutedTests } from '../state.js';
import { PLAN_ACCEPT_THRESHOLD } from '../plan.js';
import { TASK_COMPLETE_ID, TESTS_PASS_UNPARSED_THRESHOLD, buildCompleteQuestion, completeQuestionDue, knownFailureCount, knownFailuresOf, unexpectedFailures } from './complete.js';

export function doneClaimId(j: number): string {
  return `done_${j}`;
}

function testsPassUnparsedQuestion(): Question {
  return noul(`Does ${ref('executed.output')} show the test command finishing with every test passing?`, {
    true: { definition: 'a final summary reporting only passes/skips, exit code 0', examples: ['12 passed in 3.1s', 'ok  pkg/foo  0.412s', 'PASS'] },
    false: {
      definition: 'any failed/error count, a traceback after the summary, non-zero exit, or no summary because the run was cut off',
      examples: ['1 failed, 11 passed', 'FAIL  pkg/foo', 'ERRORS', 'Killed / timed out'],
    },
  });
}

function doneClaimQuestion(j: number): Question {
  return noul(`Do ${ref('executed')} and ${ref('recent')} show that \`claims[${j}]\` is finished?`, {
    true: {
      definition:
        'the item\'s outcome is visible in `executed.output`, `executed.changedFiles`, or `executed.tests.parsed`, or in an earlier `recent` entry\'s output (a passing test run, an applied edit whose effect is then verified, a command that produced the required artefact)',
      examples: ['12 passed after the edit to src/a.py', 'artefact build/report.html listed by ls'],
    },
    false: {
      definition: 'claimed but not shown; shown only by the engineer\'s own text or summary; attempted but failed or blocked; or its verification has not run yet',
      examples: ['plan says fixed, no test run since the edit', 'exit 1 on the command that was to produce it'],
    },
  });
}

export function buildJudgeQuestions(opts: { testsUnparsed: boolean; claims: readonly string[]; read?: boolean }): Record<string, Question> {
  const qs: Record<string, Question> = {
    succeeded: noul(`Do ${ref('executed.output')} and ${ref('executed.changedFiles')} show that ${ref('proposal.goal')} happened?`, {
      true: {
        definition: 'the output or changed files show the goal occurred: an edit applied once, a command exited 0 with the expected effect, a read returned the requested content',
        examples: ['edit applied to src/a.py (1 match)', 'exit 0, 12 passed'],
      },
      false: {
        definition: 'no match / N matches, non-zero exit, timeout, truncated before the result, or the goal is only asserted in the engineer\'s text',
        examples: ['EditError: 2 matches', 'exit 1', 'timed out after 120s'],
      },
    }),
  };
  // §6 read row: a read shows file contents, so `error_present` (a command failure) is not asked.
  if (!opts.read) {
    qs['error_present'] = noul(`Does ${ref('executed.output')} contain a failure the engineer must act on?`, {
      true: {
        definition: 'a traceback ending in an exception, a non-zero exit with a diagnostic, a failed assertion, a missing module/command/file',
        examples: ['ModuleNotFoundError: No module named x', 'AssertionError', 'sh: cmd: not found'],
      },
      false: {
        definition: 'warnings, deprecation notices, the words error/ERROR inside passing output or as log-level names, expected failures (xfail), `0 errors`, tests that deliberately exercise error paths',
        examples: ['DeprecationWarning: …', 'ERROR root:app.py:12 handled (test passed)', '0 errors, 14 passed', 'XFAIL'],
      },
    });
  }
  qs['new_information'] = noul(`Does ${ref('executed.output')} contain a fact not in ${ref('plan')} or ${ref('recent')} that changes what to do next?`, {
    true: {
      definition: 'a new failing test, a missing dependency, a different root cause, an unexpected file layout',
      examples: ['a second test fails after the fix', 'package requires Python ≥3.10'],
    },
    false: {
      definition: 'confirmation of what the plan already says or a repeat of a known failure',
      examples: ['same traceback as step 5', 'tests pass as expected'],
    },
  });
  if (opts.testsUnparsed) qs['tests_pass_unparsed'] = testsPassUnparsedQuestion();
  opts.claims.forEach((_claim, j) => {
    qs[doneClaimId(j)] = doneClaimQuestion(j);
  });
  return qs;
}

/** llm-jev: Q21 `done_<j>` (+ `tests_pass_unparsed` when the parser read nothing) and Q22, the same wordings, recorded only. */
export function buildRecordOnlyQuestions(opts: { testsUnparsed: boolean; claims: readonly string[]; completeDue?: boolean }): Record<string, Question> {
  const qs: Record<string, Question> = {};
  if (opts.testsUnparsed) qs['tests_pass_unparsed'] = testsPassUnparsedQuestion();
  opts.claims.forEach((_claim, j) => {
    qs[doneClaimId(j)] = doneClaimQuestion(j);
  });
  // OOS 2026-09-22 ranked change 6 (Q2(d)): on this path Q22 is recorded and never consulted
  // — `isCompleteByFact` is the stop — and 87.7 % of its 127 answers were below 0.5. It is due
  // only when this step closed a goal or the plan has nothing left (complete.ts
  // `completeQuestionDue`); absent means due, so every other caller is unchanged.
  if (opts.completeDue !== false) qs[TASK_COMPLETE_ID] = buildCompleteQuestion();
  return qs;
}

export interface JudgeStageResult {
  /** null on a noop (done) step; llm-jev: null on every step but a `run` */
  judge: JudgeResult | null;
  /** `task_complete`; null when it was not asked (llm-jev patch/read steps) */
  completion: number | null;
  /** per-claim verdicts for the plan (Jev's `done_<j>`, or the code verdicts in llm-jev); null when the step carries no claim evidence */
  claimProbabilities: Map<string, number> | null;
}

export interface JudgeStageOptions {
  /** llm-jev (docs/LLM-JEV-DESIGN.md §6.6): the `done` is verified by the engine's own passing, current run — its claims are accepted by code */
  verifiedDone?: boolean;
}

/** The executed run as the code judge reads it (llm-jev). */
export interface CodeJudgeRun {
  /** the executed run when it was the workspace test command (command, parsed counts, allPassed); null for another command */
  tests: ExecutedTests | null;
  /** exit code of the executed command when known (non-test runs are judged on it) */
  exitCode: number | null;
  /** the proposal's shadow-run evidence: its `newlyPassing` ids are the executed run's when the parsed counts agree */
  evidence: Pick<ProposalEvidence, 'after' | 'newlyPassing'> | null;
  /** the recorded `tests_pass_unparsed` answer; consumed only when the parser read nothing */
  testsPassUnparsed: number | null;
  /**
   * `evidence.completion.knownFailures` (complete.ts): the scoped tests that already failed at the base
   * commit. The suite counts as passing when nothing fails beyond them — `sympy-11618`'s claiming run
   * reads `644 passed / 0 failed / 43 errors` on an environment that had those 43 errors before the
   * patch, and judging it against zero cost that run 7 steps and its `complete` (§9 class E′). Default 0.
   */
  knownFailures?: number;
}

// the ledger grammar of synth/search/memory.ts planItemFor: `fix <test>[, +N more] in <path>`; test ids may contain " in ", paths never contain spaces
const LEDGER_CLAIM_RE = /^fix (.+) in (?:\S+|the workspace)$/;
const LEDGER_MORE_RE = /^(.*), \+\d+ more$/;

/**
 * The test ids each claim names: the ledger item's first test, widened to the goal's full test set when the
 * proposal's `evidence.goalTests` contains it (the item names one test and `+N more`); a claim outside the
 * grammar (e.g. the standing verification item) names none and is accepted only by a passing suite.
 */
export function ledgerGoalsOf(claims: readonly string[], goalTests: readonly string[] = []): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const claim of claims) {
    const m = LEDGER_CLAIM_RE.exec(claim.trim());
    if (m === null || m[1] === undefined) {
      out.set(claim, []);
      continue;
    }
    const first = (LEDGER_MORE_RE.exec(m[1])?.[1] ?? m[1]).trim();
    out.set(claim, goalTests.includes(first) ? [...goalTests] : [first]);
  }
  return out;
}

/**
 * docs/LLM-JEV-DESIGN.md §3 row 7: the JudgeResult of a `run` from harness data alone. `succeeded` = every test passed
 * (`failed = errors = 0`, `passed > 0`; `tests_pass_unparsed >= 0.85` stands in when the parser read nothing), `errorPresent`
 * = the parser counted errors, `newInfo` = 0 (nothing is inferred), a claim is accepted iff the test suite passed or its
 * goal tests are all in the `newlyPassing` the executed counts confirm; a non-test command's `succeeded` is its exit code,
 * which accepts no claim (exit 0 of `echo ok` says nothing about the ledger).
 */
export function codeJudge(run: CodeJudgeRun, claims: readonly string[], ledgerGoals: ReadonlyMap<string, readonly string[]>): JudgeResult {
  const parsed = run.tests?.parsed ?? null;
  // §6.6 as amended: "every test passed" means nothing failed beyond the baseline's known failures; with
  // none declared this is the original `failed = errors = 0` and the runner's own `allPassed` is required
  const known = knownFailureCount(run.knownFailures);
  const unexpected = parsed === null ? 0 : unexpectedFailures(parsed, known);
  let allPassed: boolean;
  if (parsed !== null) allPassed = (known > 0 || run.tests?.allPassed === true) && unexpected === 0 && parsed.passed > 0;
  else if (run.tests !== null) allPassed = run.testsPassUnparsed !== null && run.testsPassUnparsed >= TESTS_PASS_UNPARSED_THRESHOLD;
  else allPassed = run.exitCode === 0;
  const e = run.evidence;
  const countsAgree = parsed !== null && e !== null && e.after.passed === parsed.passed && e.after.failed === parsed.failed && e.after.errors === parsed.errors;
  const newlyPassing: readonly string[] = countsAgree && e !== null ? e.newlyPassing : [];
  // §3 row 7: only the passing test suite accepts every claim; a non-test command's exit 0 says nothing about the ledger
  const suitePassed = run.tests !== null && allPassed;
  const doneClaims: DoneClaimResult[] = claims.map((text) => {
    const goals = ledgerGoals.get(text) ?? [];
    const judged = suitePassed || (goals.length > 0 && goals.every((t) => newlyPassing.includes(t))) ? 1 : 0;
    return { text, judged, accepted: judged >= PLAN_ACCEPT_THRESHOLD };
  });
  let tests: JudgeResult['tests'] = null;
  if (run.tests !== null) {
    tests = parsed !== null
      ? { source: 'parsed', allPassed: run.tests.allPassed === true, passed: parsed.passed, failed: parsed.failed, errors: parsed.errors }
      : { source: 'judged', allPassed: run.testsPassUnparsed ?? 0 };
  }
  // an error the engineer must act on is one the baseline did not already have (the judge's `error_present 1.00`
  // on 43 pre-existing collection errors is what tripped sympy-11618's replan)
  const errorPresent = parsed !== null ? (parsed.errors > 0 && unexpected > 0 ? 1 : 0) : run.tests === null && run.exitCode !== null && run.exitCode !== 0 ? 1 : 0;
  return { succeeded: allPassed ? 1 : 0, errorPresent, newInfo: 0, tests, doneClaims, source: 'code' };
}

function noulOf(answers: Record<string, Answer>, id: string, fallback: number): number {
  const a = answers[id];
  return a && a.type === 'noul' ? a.noul : fallback;
}

/**
 * One request: judge Nouls (+ done_<j>) and task_complete, or task_complete alone for a
 * `noop` step (§6 done path). The task_complete row is labelled stage 'complete' for the pane.
 */
export async function runJudgeStage(ctx: StageContext, common: JsonObject, proposal: Proposal, executed: ExecutedInfo, claims: readonly string[], opts: JudgeStageOptions = {}): Promise<JudgeStageResult> {
  if (ctx.mode === 'llm-jev') return runCodeJudgeStage(ctx, common, proposal, executed, claims, opts);
  const reduced = executed.outcome.status === 'noop';
  const read = proposal.action.kind === 'read';
  const testsUnparsed = executed.tests !== null && executed.tests.parsed === null;
  const questions: Record<string, Question> = reduced ? {} : buildJudgeQuestions({ testsUnparsed, claims, read });
  questions[TASK_COMPLETE_ID] = buildCompleteQuestion();
  const state = buildJudgeState(common, proposal, executed, reduced ? [] : claims, ctx.redact);
  let judge: JudgeResult | null = null;
  let completion: number | null = 0;
  const claimProbabilities = new Map<string, number>();
  // I4 at the WRITE site: the step's own token, held from before the ask so a late answer can see that its step
  // has committed. Null on the routers-off path, where this callback is the pre-1.9 one, byte for byte.
  let routed: StepToken | null = null;
  const asked = async (signal?: AbortSignal): Promise<JudgeAsked> => {
    let out: JudgeAsked = { judge: null, completion: 0, claims: [] };
    // jev-contract: RL4 judge + RL5 completion (docs/LLM-LOOP-DESIGN.md §2.2, §2.5)
    //   escape:   Q19/Q21 and Q22 carry their escapes; an unanswered Noul is inert.
    //   guard:    with routers on this ask is issued through routeSpeculative under the step signal with a 400 ms
    //             deadline and a step-scoped token, and a PARSED test run overrides Jev's outcome with the code
    //             comparison of the parsed counts (codeJudge) — Jev's Nouls are then data in decisions.jsonl.
    //   fallback: codeJudge() over the harness's own parsed counts and exit code, with completion `null` ("not answered", which no stop rule reads as complete) — test: test/unit/loop/router.test.ts
    //   no-gating: with routers on nothing here can end a run: a dropped answer judges by code and completes
    //             nothing. With routers off this site is exactly the pre-1.9 stage.
    await ctx.ask(
      'judge',
      state,
      questions,
      (answers, rows: Decision[]) => {
      // review 2026-09-22 defect 2: the router's signal, threaded. A dropped ask (deadline, committed token, settled
      // work) is CANCELLED by routeSpeculative, and a cancelled answer is not this step's answer: it annotates
      // nothing and applies nothing. The belt stays even though §7.5 seam (a) has landed and `askRecorded` now
      // abandons the call before this callback can run: the token check is the ONE drop the signal cannot see.
      if (signal?.aborted === true || routed?.valid === false) return;
      for (const r of rows) if (r.id === TASK_COMPLETE_ID) r.stage = 'complete';
      const askedCompletion = noulOf(answers, TASK_COMPLETE_ID, 0);
      if (reduced) {
        out = { judge: null, completion: askedCompletion, claims: [] };
        return;
      }
      const doneClaims: DoneClaimResult[] = claims.map((text, j) => {
        const p = noulOf(answers, doneClaimId(j), 0);
        return { text, judged: p, accepted: p >= PLAN_ACCEPT_THRESHOLD };
      });
      let tests: JudgeResult['tests'] = null;
      if (executed.tests) {
        const parsed = executed.tests.parsed;
        tests = parsed
          ? { source: 'parsed', allPassed: executed.tests.allPassed === true, passed: parsed.passed, failed: parsed.failed, errors: parsed.errors }
          : { source: 'judged', allPassed: noulOf(answers, 'tests_pass_unparsed', 0) };
      }
      // errorPresent is 0 (not asked) on a read: file contents are not a command failure.
      out = {
        judge: { succeeded: noulOf(answers, 'succeeded', 0), errorPresent: read ? 0 : noulOf(answers, 'error_present', 0), newInfo: noulOf(answers, 'new_information', 0), tests, doneClaims },
        completion: askedCompletion,
        claims: doneClaims,
      };
      },
      // §7.5 seam (a): the PER-CALL signal — a dropped ask is cancelled AND charges nothing. Absent (and so the
      // pre-1.9 call) on the routers-off path.
      signal,
    );
    return out;
  };
  const apply = (a: JudgeAsked): void => {
    judge = a.judge;
    completion = a.completion;
    for (const c of a.claims) claimProbabilities.set(c.text, c.judged);
  };
  if (!routersOn(ctx.mode, ctx.routers)) {
    apply(await asked());
  } else {
    routed = stepTokenFor(ctx.runId, ctx.step);
    const route = await routeSpeculative<JudgeAsked>({
      id: 'RL4',
      token: routed,
      codeOrder: [codeJudgeAsked(proposal, executed, claims, reduced)],
      deadlineMs: RL4_JUDGE_DEADLINE_MS,
      signal: ctx.signal,
      ask: async (signal) => [await asked(signal)],
    });
    noteStepRoute(ctx.runId, ctx.step, route);
    const chosen = route.order[0]!;
    // §2.2 RL4: recorded-only wherever the harness has the fact — a parsed run is judged by the code comparison
    // of its counts, whatever Jev answered; only an unparsed run keeps Jev's reading.
    const parsedRun = executed.tests !== null && executed.tests.parsed !== null;
    apply(route.dropped || parsedRun ? { ...codeJudgeAsked(proposal, executed, claims, reduced), completion: route.dropped ? null : chosen.completion } : chosen);
  }
  ctx.emit({ type: 'judge', step: ctx.step, judge, completion });
  return { judge, completion, claimProbabilities };
}

/** what one judge request produced; the stage's three outputs in one value, so a late answer can be dropped whole */
interface JudgeAsked {
  judge: JudgeResult | null;
  completion: number | null;
  claims: readonly DoneClaimResult[];
}

/**
 * contract 1.9 (Fastlane) §2.2 RL4: the judge the CODE computes for a jev-on step — the same `codeJudge()` the
 * llm-jev path has used since §3 row 7, over this step's parsed counts, exit code and claims. Sufficient alone:
 * it is what the stage returns when the router drops, and what overrides a Jev answer on a parsed run.
 */
export function codeJudgeAsked(proposal: Proposal, executed: ExecutedInfo, claims: readonly string[], reduced: boolean): JudgeAsked {
  if (reduced) return { judge: null, completion: null, claims: [] };
  const exec = executed.outcome.status === 'executed' ? executed.outcome.exec : null;
  const exitCode = typeof exec?.exitCode === 'number' ? exec.exitCode : null;
  const judged = codeJudge(
    { tests: executed.tests, exitCode, evidence: proposal.evidence ?? null, testsPassUnparsed: null, knownFailures: knownFailuresOf(proposal.evidence?.completion) },
    claims,
    ledgerGoalsOf(claims, proposal.evidence?.goalTests ?? []),
  );
  return { judge: judged, completion: null, claims: judged.doneClaims };
}

/** llm-jev (docs/LLM-JEV-DESIGN.md §3 row 7): code on every step; Q21/Q22 recorded only. */
async function runCodeJudgeStage(ctx: StageContext, common: JsonObject, proposal: Proposal, executed: ExecutedInfo, claims: readonly string[], opts: JudgeStageOptions): Promise<JudgeStageResult> {
  const kind = proposal.action.kind;
  const claimProbabilities = new Map<string, number>();
  // ranked change 6: the Q22 gate, from the claims this step makes and what the plan still lists
  const completeDue = completeQuestionDue({ goalJustClosed: claims.length > 0, planRemaining: proposal.plan.remaining.length });
  if (kind === 'done' && executed.outcome.status === 'noop') {
    // Q22 recorded; the stop is the engine's code fact (isCompleteByFact) and the claims follow the same fact.
    // Not due (ranked change 6) means NOT ASKED, which is `null` — 0 would read back as a recorded
    // 0.00 in the window note and in the step record, claiming an answer nobody gave.
    let completion: number | null = completeDue ? 0 : null;
    if (completeDue) {
      // jev-contract: RL5 completion (docs/LLM-LOOP-DESIGN.md §2.5) — llm-jev's own rule, unchanged by contract 1.9.
      //   escape:   Q22 carries its escape.
      //   guard:    the stop is `Engine.completeAfter` -> `isCompleteByFact()` (complete.ts) over the engine's OWN
      //             current, passing run; `task_complete` is written to the record and read by no stop rule here.
      //   fallback: isCompleteByFact() is code and needs no answer; a throwing decider leaves completion unanswered and the run continues — test: test/unit/loop/router.test.ts
      //   no-gating: recorded-only: a missing or wrong Noul cannot complete a run and cannot prevent one completing.
      await ctx.ask('judge', buildJudgeState(common, proposal, executed, [], ctx.redact), { [TASK_COMPLETE_ID]: buildCompleteQuestion() }, (answers, rows: Decision[]) => {
        for (const r of rows) if (r.id === TASK_COMPLETE_ID) r.stage = 'complete';
        completion = noulOf(answers, TASK_COMPLETE_ID, 0);
      });
    }
    for (const text of claims) claimProbabilities.set(text, opts.verifiedDone === true ? 1 : 0);
    ctx.emit({ type: 'judge', step: ctx.step, judge: null, completion });
    return { judge: null, completion, claimProbabilities };
  }
  if (kind !== 'run' || executed.outcome.status !== 'executed') {
    // patch / read / edit / write: nothing is judged and nothing is asked — patches claim nothing (§3 row 7)
    ctx.emit({ type: 'judge', step: ctx.step, judge: null, completion: null });
    return { judge: null, completion: null, claimProbabilities: null };
  }
  const testsUnparsed = executed.tests !== null && executed.tests.parsed === null;
  const state = buildJudgeState(common, proposal, executed, claims, ctx.redact);
  let completion: number | null = completeDue ? 0 : null;
  let testsPassUnparsed: number | null = null;
  let jevClaims: number[] = [];
  // with Q22 not due, a parsed run that claims nothing has no record-only question left to ask
  const recordOnly = buildRecordOnlyQuestions({ testsUnparsed, claims, completeDue });
  if (Object.keys(recordOnly).length > 0) {
    // jev-contract: RL4 judge (docs/LLM-LOOP-DESIGN.md §2.2) — llm-jev's own rule, unchanged by contract 1.9.
    //   escape:   Q19/Q21/Q22 carry their escapes; the batch is built by buildRecordOnlyQuestions().
    //   guard:    the outcome is `codeJudge()` over the harness's own parsed counts below; Jev's Nouls are
    //             compared to it and a disagreement is written to the transcript, never consumed.
    //   fallback: the code comparison of the parsed failing counts (codeJudge), which needs no answer — test: test/unit/loop/router.test.ts
    //   no-gating: recorded-only — `tests_pass_unparsed` is consulted only where the parser read nothing.
    await ctx.ask('judge', state, recordOnly, (answers, rows: Decision[]) => {
      for (const r of rows) if (r.id === TASK_COMPLETE_ID) r.stage = 'complete';
      // review finding 3: the batch is still asked when Q22 is NOT due (the unparsed path, or a
      // step with claims), and the callback ran unconditionally — recording a 0 for a question
      // nobody was asked. `null` is the type's own word for "not asked".
      if (completeDue) completion = noulOf(answers, TASK_COMPLETE_ID, 0);
      if (testsUnparsed) testsPassUnparsed = noulOf(answers, 'tests_pass_unparsed', 0);
      jevClaims = claims.map((_c, j) => noulOf(answers, doneClaimId(j), 0));
    });
  }
  const exec = executed.outcome.exec;
  const exitCode = typeof exec?.exitCode === 'number' ? exec.exitCode : null;
  const judge = codeJudge({ tests: executed.tests, exitCode, evidence: proposal.evidence ?? null, testsPassUnparsed, knownFailures: knownFailuresOf(proposal.evidence?.completion) }, claims, ledgerGoalsOf(claims, proposal.evidence?.goalTests ?? []));
  judge.doneClaims.forEach((c, j) => {
    claimProbabilities.set(c.text, c.judged);
    const jev = jevClaims[j];
    if (jev !== undefined && jev >= PLAN_ACCEPT_THRESHOLD !== c.accepted) {
      ctx.emit({ type: 'transcript', step: ctx.step, level: 'info', text: `judge: Jev ${doneClaimId(j)}=${jev.toFixed(2)} disagrees with the code verdict ${c.judged} for '${clip(c.text, 80)}' (recorded only)` });
    }
  });
  ctx.emit({ type: 'judge', step: ctx.step, judge, completion });
  return { judge, completion, claimProbabilities };
}
