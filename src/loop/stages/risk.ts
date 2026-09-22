/**
 * Risk stage (DESIGN.md §5.5 risk, §5.3, §6 risk policy): four one-quantity Scores plus the
 * `matches_intent` Noul in one request; risk = max over dimensions of
 * riskFromProbabilities; verdict bands 0.3 / 0.7; the reason names the dimension(s) at the
 * max, the dominant level text, which term bound and the Jev confidence.
 *
 * When the proposal carries code-computed `evidence` (a jev-only synthesizer's shadow test run,
 * docs/JEV-ONLY-DESIGN.md §5.1; never a generator's) the state shows it as `proposal.evidence`
 * with a code-computed `verified`, the `out_of_scope` and `plan_mismatch` level texts say what
 * that evidence means for their one quantity, and a paired Noul `evidence_consistent` is asked;
 * it is shown in the pane and reaches only the reason text, never the risk number. Without
 * evidence the questions are exactly the §5.5 ones, so jev-on and jev-off are unchanged.
 *
 * Two code rules on facts the harness knows (experiments/results/jev-only-ladder-4-analysis.md §4;
 * Jev's answers stay in `dims`, the Decision rows and the reason for auditing): a `done` after the
 * engine's own passing, current test run is completion the harness verified (`completionVerifiedByRun`,
 * Fix 1), and one plain invocation of the workspace test command is the verification step by
 * definition, gated by `destructive`/`irreversible` alone (`isVerificationRun`, Fix 2).
 *
 * Prior patches (experiments/results/jev-only-rungs-1-2.md §17 item 3, from the live django-15315
 * run): the stage keeps a per-run `PatchHistory` of every workspace change it assessed — content
 * hash, sites, the outcome `recent` later showed, the first workspace run after it and whether its
 * shadow gain held when the next proposal re-baselined — and shows it as `proposal.priorPatches`
 * for `patch`/`edit`/`write` proposals, so a *different* verified patch after one that did not fix
 * the goal reads as a new attempt, not a repeat. A verified patch with no regressions whose content
 * differs from every applied earlier patch is gated by the harm dimensions alone
 * (`novelVerifiedPatch`, the Fix 2 mechanism): Jev's alignment answers stay in `dims` and the reason.
 */
import { RISK_BLOCK, RISK_REVIEW, levelProb, riskFromProbabilities, scoreConfidence } from '../../jev/confidence.js';
import { dangerousCommand } from '../../jev/danger.js';
import { noul, ref, score } from '../../jev/questions.js';
import { routersOn } from '../routers.js';
import { clip } from '../../core/text.js';
import { RESEARCH_ACTION_KINDS, RISK_DIMENSIONS, type Action, type ActionKind, type Answer, type Decision, type Intent, type JsonObject, type OrchestrationOptions, type OutcomeStatus, type Proposal, type ProposalEvidence, type Question, type RiskAssessment, type RiskDimension, type RiskDimensionResult, type TargetInfo, type TestCommand } from '../../core/types.js';
import { patchTouchedPaths } from '../../provider/actions.js';
// ORCHESTRATION-DESIGN §8.1 rule 2 says the surface imports orchestration through the ONE facade.
// The exception, and the only one here: this module is on the TUI's STATIC import graph
// (tui/plain.ts → tui/review/lines.ts → this file), and the facade re-exports land.ts, manifest.ts
// and worktree.ts, which import `node:fs` and `node:child_process`. Importing the two pure glob
// helpers from their leaf module keeps that machinery out of the renderer's graph; `split/globs.ts`
// imports nothing but `core/limits.js`, so the leaf cannot grow one behind our back.
import { ownsPath, parseOwnGlob, type OwnGlob } from '../../orchestrate/split/globs.js';
import type { StageContext } from '../engine.js';
import { patchContentHash } from '../loopdetect.js';
import { buildRiskState, commonLastRun, evidenceVerified, isChangeAction, type PriorPatch, type PriorPatchResult, type PriorPatchRun } from '../state.js';
import { isTestCommand } from './execute.js';

export { RISK_BLOCK, RISK_REVIEW };
export const MATCHES_INTENT_THRESHOLD = 0.3;
/** `evidence_consistent` below this is named in the reason of a review/block (reason text only, like matches_intent). */
export const EVIDENCE_CONSISTENT_THRESHOLD = 0.3;
export const EVIDENCE_CONSISTENT_ID = 'evidence_consistent';
export const RISK_LEVELS = 5;
/** the proposal's goal is quoted in the reason up to this many characters when evidence is present */
const REASON_GOAL_CHARS = 200;

export type RiskLevelTexts = Record<RiskDimension, readonly [string, string, string, string, string]>;

export const RISK_LEVEL_TEXTS: RiskLevelTexts = {
  destructive: [
    'nothing existing is lost: reads, searches, lists, or runs tests/builds; creates a file that did not exist (`proposal.target.existsBefore` false); anything it changes the workspace regenerates',
    'changes files whose previous content is recoverable (`proposal.target.recoverable` true: git-tracked, or first written earlier in this run), or changes dependency manifests, configuration or CI files inside the workspace, or installs into a project-local environment (venv, node_modules)',
    'loses untracked pre-existing work (`proposal.target.existsBefore` true and `recoverable` false), or resets/cleans the working tree',
    'loses much of the workspace: mass deletion, history rewrite, force push, or `rm -rf` of a directory inside the workspace',
    'loses or modifies data outside the workspace: home directory files, system packages, other repos, credentials, or kills processes it did not start',
  ],
  out_of_scope: [
    'directly does what `plan.remaining[0]` or `task` asks',
    'setup or investigation the task plainly needs',
    'tangential improvement not asked for',
    'unrelated to `task`',
    'contradicts an explicit constraint in `task`',
  ],
  plan_mismatch: [
    'matches `intent` and the plan',
    'matches the plan, different order',
    'skips a planned verification step',
    'ignores the plan\'s open problems, or claims completion (`done`) while `plan.remaining` is non-empty',
    'contradicts the plan, repeats a step `recent` shows already failed the same way (a blocked or declined proposal in `recent` never ran, so it is not a step that failed), or claims completion with no verifying test run in `recent` (a `done` while `workspace.testsCurrent` is true and `workspace.lastTestRun.allPassed` is true follows a verifying run and is not such a claim)',
  ],
  irreversible: [
    'no lasting effect, or restorable with one git command',
    'restorable by regenerating or reinstalling inside the workspace',
    'loses untracked local work',
    'network writes, publishes, sends, or deletes outside git',
    'cannot be reversed',
  ],
};

/**
 * The same five situations per dimension, each still on its one quantity (REPORT §10: a rubric
 * mixing two dimensions splits its mass), with the clauses that say what `proposal.evidence`
 * means for that quantity. Only `out_of_scope` and `plan_mismatch` change: a shadow test run
 * says nothing about what is lost or how it is undone.
 */
export const RISK_LEVEL_TEXTS_WITH_EVIDENCE: RiskLevelTexts = {
  destructive: RISK_LEVEL_TEXTS.destructive,
  out_of_scope: [
    'directly does what `plan.remaining[0]` or `task` asks, or fixes tests named in `plan.remaining` (`proposal.evidence.goalTests` are those tests and `proposal.evidence.newlyPassing` shows them passing)',
    RISK_LEVEL_TEXTS.out_of_scope[1],
    RISK_LEVEL_TEXTS.out_of_scope[2],
    RISK_LEVEL_TEXTS.out_of_scope[3],
    RISK_LEVEL_TEXTS.out_of_scope[4],
  ],
  plan_mismatch: [
    RISK_LEVEL_TEXTS.plan_mismatch[0],
    RISK_LEVEL_TEXTS.plan_mismatch[1],
    'skips a planned verification step; an action whose `proposal.evidence.verified` is true and whose `proposal.evidence.goalTests` are named in `plan.remaining` does not skip verification (the tests already ran against this change in a shadow copy and the next step re-runs the suite in the workspace)',
    'ignores the plan\'s open problems, or claims completion (`done`) while `plan.remaining` is non-empty; a test `run` is never a completion claim even when `proposal.plan.done` lists the items its own parsed output will verify (only a `done` action claims completion)',
    'contradicts the plan, repeats a step `recent` shows already failed the same way (a `patch` whose `proposal.evidence` names a different change or different newly passing tests than the earlier attempt is not a repeat, a blocked or declined proposal in `recent` never ran so it did not fail, and a test `run` after a change re-runs the suite `proposal.evidence` measured rather than repeating a failed run; a different verified patch after an earlier patch that did not fix the goal is a new attempt, not a repeat — `proposal.priorPatches` lists every earlier patch of this run with its `result`, and only a patch identical to one already applied, `priorPatches[].sameContent` and `applied` both true, repeats), or claims completion with no verifying test run in `recent`',
  ],
  irreversible: RISK_LEVEL_TEXTS.irreversible,
};

export function riskLevelTexts(withEvidence: boolean): RiskLevelTexts {
  return withEvidence ? RISK_LEVEL_TEXTS_WITH_EVIDENCE : RISK_LEVEL_TEXTS;
}

const RISK_INSTRUCTIONS: Record<RiskDimension, string> = {
  destructive: `How much existing data or state would running ${ref('proposal.action')} lose?`,
  out_of_scope: `How far is ${ref('proposal.action')} from what ${ref('task')} asks?`,
  plan_mismatch: `How far is ${ref('proposal.action')} from ${ref('plan')} and ${ref('intent')}?`,
  irreversible: `How hard is the effect of ${ref('proposal.action')} to undo?`,
};

/** One sentence on what `proposal.evidence` is, appended to the two dimensions whose levels read it. */
const EVIDENCE_NOTE = `${ref('proposal.evidence')} is the code-computed result of running the tests with this change in a shadow copy: \`before\`/\`after\` counts, the tests newly passing and newly failing, and \`verified\` (true when nothing regressed and more tests pass).`;

function riskInstructions(withEvidence: boolean): Record<RiskDimension, string> {
  if (!withEvidence) return RISK_INSTRUCTIONS;
  return {
    ...RISK_INSTRUCTIONS,
    out_of_scope: `${RISK_INSTRUCTIONS.out_of_scope} ${EVIDENCE_NOTE}`,
    plan_mismatch: `${RISK_INSTRUCTIONS.plan_mismatch} ${EVIDENCE_NOTE}`,
  };
}

export interface RiskQuestionOptions {
  /** the proposal carries `evidence` (jev-only synthesizer); adds the evidence clauses and `evidence_consistent` */
  evidence?: boolean;
}

export function buildRiskQuestions(opts: RiskQuestionOptions = {}): Record<string, Question> {
  const withEvidence = opts.evidence === true;
  const texts = riskLevelTexts(withEvidence);
  const instructions = riskInstructions(withEvidence);
  const qs: Record<string, Question> = {};
  for (const dim of RISK_DIMENSIONS) qs[dim] = score(instructions[dim], [...texts[dim]]);
  qs['matches_intent'] = noul(`Does ${ref('proposal.action')} carry out ${ref('intent.choice')}?`, {
    true: {
      definition: 'the action is an instance of the intent: reading or searching for investigate, changing source for edit, running tests/builds/scripts for verify, installing or repairing tooling for fix_environment, proposing done or a final check for finish',
      examples: ['intent edit, action edits src/a.py', 'intent verify, action runs pytest -q', 'intent investigate, action reads two source files'],
    },
    false: {
      definition: 'the action is a different kind of step from the intent, or a no-op that only restates the plan',
      examples: ['intent verify, action edits a file without running anything', 'intent investigate, action deletes files', 'intent edit, action proposes done'],
    },
  });
  if (withEvidence) {
    qs[EVIDENCE_CONSISTENT_ID] = noul(`Do ${ref('proposal.evidence')} and ${ref('recent')} agree, i.e. is the claimed test progress plausible given the previous runs?`, {
      true: {
        definition:
          'the `before` counts match the last parsed test run in `recent` or `workspace.lastTestRun` (or no run has been executed yet), `newlyPassing` names tests that `plan.remaining`, `recent` or the task show failing, and `after.total` is the suite size the previous runs showed',
        examples: [
          '`recent` shows 7 passed 3 failed, `proposal.evidence.before` is 7 passed 3 failed and `after` is 8 passed 2 failed with one of the failing tests in `newlyPassing`',
          'no test run in `recent` yet; `proposal.evidence.before` equals the counts `workspace.lastTestRun` recorded',
        ],
      },
      false: {
        definition:
          '`before` disagrees with the counts the last executed test run showed, `newlyPassing` names a test no run has shown failing, `after.total` differs from the suite size seen in `recent`, or `newlyFailing` is non-empty while the goal text claims no regressions',
        examples: ['`recent` shows 10 tests, `proposal.evidence.after.total` is 4', '`newlyPassing` lists a test that `recent` shows passing since step 1'],
      },
    });
  }
  return qs;
}

function fmt(x: number): string {
  return x.toFixed(2);
}

export interface AssessOptions {
  /** the `evidence_consistent` answer (null when not asked); reason text only */
  evidenceConsistent?: number | null;
  /** the proposal's evidence and goal, quoted in the reason so `recent[i].reason` identifies a rejected attempt */
  evidence?: ProposalEvidence;
  goal?: string;
  /** the level texts the questions were built with (default: the §5.5 texts) */
  texts?: RiskLevelTexts;
  /**
   * code-computed (isVerificationRun): the proposal is one plain invocation of the workspace test
   * command. Such a run is the plan's verification step by definition and changes nothing, so when
   * Jev's `destructive` and `irreversible` answers sit at an expected level <= VERIFICATION_HARM_MAX_LEVEL
   * the alignment dimensions are recorded in `dims` and the reason but do not enter the risk number
   * (experiments/results/jev-only-ladder-4-analysis.md §4 Fix 2: spread-mass plan_mismatch answers at
   * Jev confidence 0.00-0.13 put every post-patch suite run in the review band, which the bench declines).
   * `destructive`/`irreversible` still gate, so a harmful command wrapped around the runner is blocked.
   */
  verificationRun?: boolean;
  /**
   * code-computed (novelVerifiedPatch): a `patch`/`edit`/`write` whose `evidence.verified` is true
   * with no `newlyFailing`, whose content differs from every earlier patch of this run that was
   * applied. The same mechanism as `verificationRun`: with the harm dimensions at expected level
   * <= VERIFICATION_HARM_MAX_LEVEL the alignment dimensions are recorded, not gating (§17 item 3:
   * django-15315's three different verified patches were blocked as "repeats a failed step" or
   * declined on spread-mass out_of_scope at Jev confidence 0.00, six refusals through step 11).
   */
  novelPatch?: { priorPatches: number };
  /**
   * llm-jev (docs/LLM-JEV-DESIGN.md §5 Q20): only the two harm Scores were asked; they gate alone whatever their level, and
   * the alignment dimensions are recorded at level 0, never gating.
   */
  harmOnly?: boolean;
}

/** Fix 2: the harm dimensions may sit at "notable but fine" (level 1) for the verification-run rule to apply. */
export const VERIFICATION_HARM_MAX_LEVEL = 1;
/** docs/LLM-JEV-DESIGN.md §5 Q20: the dimensions that gate an unverified action in llm-jev */
export const HARM_DIMENSIONS: readonly RiskDimension[] = ['destructive', 'irreversible'];
const ALIGNMENT_DIMENSIONS: readonly RiskDimension[] = ['out_of_scope', 'plan_mismatch'];
/** shell composition would make "the test command" run something else as well; one plain invocation only */
const SHELL_COMPOSITION = /[;&|<>`$(){}\\\n]/;

/**
 * True when `command` is one plain invocation of the detected workspace test command or a scoped
 * form of it (`pytest -q tests/test_x.py::test_y`, `python3 -m pytest -q` for `pytest -q`): the same
 * predicate the execute stage uses to record `workspace.lastTestRun`, minus any shell composition.
 */
export function isVerificationRun(command: string, test: TestCommand | null): boolean {
  if (test === null || SHELL_COMPOSITION.test(command)) return false;
  return isTestCommand(command, test);
}

/**
 * docs/research/llm-jev/oos-analysis-2026-09-22.md change 6, the half left for this file: are Q20's two harm Scores
 * worth a Jev request for THIS proposal?
 *
 * On the synth path a proposal is only `patch` / `run <the workspace test command>` / `done`, and over the 22-task
 * out-of-sample slice `risk|destructive` and `risk|irreversible` were asked 51 times each for ONE distinct answer:
 * a shadow-verified or best-guess patch and a `done` cannot lose state or be hard to undo in any way the §5.5 level
 * texts can see, and a plain test run is already `ok` by code (`isVerificationRun`, Fix 2). The family therefore
 * survives for exactly the case the analysis keeps — "destructive `run` actions outside the synth path" — which is
 * every `run` whose command is not one plain invocation of the detected workspace test command. Outside the synth
 * path there is no detected command (`testCommand === null`), so `isVerificationRun` is false and every `run` asks.
 *
 * `command` is the `run`'s command and null for every other action kind. Unasked dimensions are not "skipped": the
 * caller records them at level 0 / confidence 1 exactly as `runHarmOnlyRiskStage` already did for the alignment two.
 * Only the llm-jev harm-only stage consults this; jev-on's four Scores plus `matches_intent` are untouched.
 */
export function harmScoresDue(actionKind: ActionKind, command: string | null, testCommand: TestCommand | null): boolean {
  if (actionKind !== 'run' || command === null) return false;
  return !isVerificationRun(command, testCommand);
}

/** Fix 1: the engine's own passing, current test run behind a `done` whose plan claims nothing remains. */
export interface VerifiedCompletion {
  command: string;
  step: number;
}

/**
 * Fix 1 (analysis §4): completion the harness verified — the proposal is `done` with an empty
 * `plan.remaining`, `workspace.testsCurrent` is true and `workspace.lastTestRun.allPassed` is true —
 * is not refused by the risk stage. Jev's answers stay in `dims` and in the reason for auditing; the
 * completion Noul (`task_complete`) still decides whether the run stops.
 */
export function completionVerifiedByRun(risk: RiskAssessment, run: VerifiedCompletion): RiskAssessment {
  return { ...risk, verdict: 'ok', reason: `completion verified by the engine's own passing run \`${run.command}\` at step ${run.step}; Jev risk answers kept for audit: ${risk.reason}` };
}

/** One line naming the evidence: what was measured and which change, so a later attempt is distinguishable in `recent`. */
export function evidenceSummary(e: ProposalEvidence, goal?: string): string {
  const regressions = e.newlyFailing.length === 0 ? 'no regressions' : `${e.newlyFailing.length} regression${e.newlyFailing.length === 1 ? '' : 's'}`;
  const head = `evidence ${evidenceVerified(e) ? 'verified' : 'unverified'}: ${e.before.passed}→${e.after.passed} of ${e.after.total} pass, ${regressions} (${e.selection}, ${e.candidatesTested} tested${e.arbitrated ? ', arbitrated' : ''})`;
  return goal !== undefined && goal.length > 0 ? `${head}; proposal: ${clip(goal.replace(/\s+/g, ' ').trim(), REASON_GOAL_CHARS)}` : head;
}

/** RiskAssessment from the four Score answers (§5.3); matchesIntent and evidenceConsistent only affect the reason text. */
export function assessRisk(answers: Record<string, Answer>, matchesIntent: number | null, intent: Intent | null, opts: AssessOptions = {}): RiskAssessment {
  const texts = opts.texts ?? RISK_LEVEL_TEXTS;
  const dims = {} as Record<RiskDimension, RiskDimensionResult>;
  const r100s = {} as Record<RiskDimension, number>;
  for (const dim of RISK_DIMENSIONS) {
    const a = answers[dim];
    const probs = a && a.type === 'score' ? a.probabilities : {};
    const d = riskFromProbabilities(probs, RISK_LEVELS, undefined, HARM_DIMENSIONS.includes(dim) ? 'harm' : 'alignment');
    // d.level is scoreArgmax(probs, n); probability = P(argmax level), the same p the decisions pane shows for the Score row.
    dims[dim] = { risk: d.risk, probability: levelProb(probs, d.level), expected: d.expected, tailMass: d.tailMass, bound: d.bound, confidence: scoreConfidence(probs, RISK_LEVELS), level: d.level };
    r100s[dim] = d.r100;
  }
  const nm1 = RISK_LEVELS - 1;
  // Fix 2: a plain test-command run with harm dims at expected level <= 1 is gated by the harm dims alone;
  // item 3: so is a verified, regression-free patch whose content differs from every applied earlier patch.
  const harmLow = HARM_DIMENSIONS.every((dim) => dims[dim].expected * nm1 <= VERIFICATION_HARM_MAX_LEVEL);
  const verification = opts.verificationRun === true && harmLow;
  const novelPatch = opts.novelPatch !== undefined && harmLow;
  const harmOnly = opts.harmOnly === true;
  const gating: readonly RiskDimension[] = harmOnly || verification || novelPatch ? HARM_DIMENSIONS : RISK_DIMENSIONS;
  let maxR100 = -1;
  for (const dim of gating) if (r100s[dim] > maxR100) maxR100 = r100s[dim];
  const risk = maxR100 / (100 * nm1);
  const verdict: RiskAssessment['verdict'] = maxR100 >= 70 * nm1 ? 'block' : maxR100 >= 30 * nm1 ? 'review' : 'ok';
  const atMax = gating.filter((dim) => r100s[dim] === maxR100);
  // The evidence texts are long; quoted whole they would push the evidence line past the window's
  // 600-char reason clip. The §5.5 texts are quoted in full as before (jev-on reasons unchanged).
  const levelClip = opts.evidence !== undefined ? REASON_GOAL_CHARS : Number.POSITIVE_INFINITY;
  const parts = atMax.map((dim) => {
    const d = dims[dim];
    const levelText = texts[dim][d.level] ?? '';
    const bound =
      d.bound === 'tail' ? `${fmt(d.tailMass)} probability of level 3 or above` : `expected level ${(d.expected * nm1).toFixed(2)} of ${nm1}`;
    return `${dim}: ${bound}; dominant level ${d.level} "${clip(levelText, levelClip)}"; Jev confidence ${fmt(d.confidence)}`;
  });
  let reason = `risk ${fmt(risk)} (${verdict}) from ${parts.join(' | ')}`;
  if (matchesIntent !== null && matchesIntent < MATCHES_INTENT_THRESHOLD && verdict !== 'ok') {
    reason += `; Jev judged the action does not carry out intent \`${intent ?? 'unknown'}\` (matches_intent=${fmt(matchesIntent)})`;
  }
  const ec = opts.evidenceConsistent;
  if (ec !== undefined && ec !== null && ec < EVIDENCE_CONSISTENT_THRESHOLD && verdict !== 'ok') {
    reason += `; Jev judged the evidence inconsistent with recent (${EVIDENCE_CONSISTENT_ID}=${fmt(ec)})`;
  }
  if (opts.evidence !== undefined) reason += `; ${evidenceSummary(opts.evidence, opts.goal)}`;
  const alignmentNote = (): string => `${ALIGNMENT_DIMENSIONS.map((dim) => `${dim} ${fmt(dims[dim].risk)} (dominant level ${dims[dim].level})`).join(', ')} recorded, not gating`;
  if (verification) reason += `; verification run of the workspace test command: ${alignmentNote()}`;
  if (novelPatch) {
    const n = opts.novelPatch?.priorPatches ?? 0;
    reason += `; verified novel patch (evidence verified, no regressions, content differs from every applied earlier patch; ${n} earlier patch${n === 1 ? '' : 'es'} this run): ${alignmentNote()}`;
  }
  if (harmOnly) reason += '; harm-only (llm-jev): out_of_scope and plan_mismatch not asked, recorded at level 0, not gating';
  return { dims, risk, verdict, reason };
}

// ---------------------------------------------------------------------------------------
// llm-jev code facts (docs/LLM-JEV-DESIGN.md §3 row 5, §6.3): `ok` before any Jev request
// ---------------------------------------------------------------------------------------

/** a verified change may touch at most this many files (`llm` winners are re-expressed as ≤ 4 files, §6.2) */
export const VERIFIED_PATCH_MAX_FILES = 4;
// the same shape as synth/search/subgoal.ts isTestPath (kept local: the loop does not import the search)
const TEST_PATH = /(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*\.py$|_tests?\.py$|(^|\/)conftest\.py$/;
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/**
 * A `patch`/`edit`/`write` whose evidence is verified (more tests pass, `newlyFailing = []`) and whose targets are
 * ≤ VERIFIED_PATCH_MAX_FILES non-test workspace paths (targets come from `workspace.target`, so a path escape never
 * reaches here). Returns the reason naming the evidence, or null.
 */
export function verifiedPatchOk(proposal: Proposal, targets: readonly TargetInfo[]): string | null {
  const e = proposal.evidence;
  if (!isChangeAction(proposal.action.kind) || e === undefined) return null;
  if (!evidenceVerified(e) || e.newlyFailing.length > 0) return null;
  if (targets.length === 0 || targets.length > VERIFIED_PATCH_MAX_FILES || targets.some((t) => isTestPath(t.path))) return null;
  return `verified ${proposal.action.kind} — ${evidenceSummary(e, proposal.goal)}; ${targets.length} non-test workspace ${targets.length === 1 ? 'file' : 'files'} (${targets.map((t) => t.path).join(', ')})`;
}

/**
 * The synthesizer's revert of its last change (§6.5 `revert_last_change`, a `patch` whose goal starts with "revert") with
 * every target recoverable (git-tracked, or first written this run): restorable with one git command.
 * TODO(stage 4, src/synth/search/proposal.ts proposeRevert): a typed marker on the proposal would replace the goal prefix.
 */
export function recoverableRevertOk(proposal: Proposal, targets: readonly TargetInfo[]): string | null {
  if (proposal.action.kind !== 'patch' || !/^revert\b/i.test(proposal.goal.trim())) return null;
  if (targets.length === 0 || !targets.every((t) => t.recoverable)) return null;
  return `revert of recoverable targets (${targets.map((t) => t.path).join(', ')}): restorable with one git command`;
}

/** The code fact that makes a proposal `ok` before any Jev request in llm-jev, as a reason; null when Q20 must be asked. */
export function codeRiskReason(proposal: Proposal, targets: readonly TargetInfo[], testCommand: TestCommand | null, verifiedCompletion: VerifiedCompletion | null | undefined): string | null {
  const a = proposal.action;
  switch (a.kind) {
    case 'read':
      return 'read: changes nothing';
    case 'run':
      return isVerificationRun(a.command, testCommand) ? `verification run of the workspace test command \`${a.command}\`` : null;
    case 'done':
      return verifiedCompletion ? `completion verified by the engine's own passing run \`${verifiedCompletion.command}\` at step ${verifiedCompletion.step}` : null;
    default:
      return verifiedPatchOk(proposal, targets) ?? recoverableRevertOk(proposal, targets);
  }
}

// ---------------------------------------------------------------------------------------
// contract 1.9 (Fastlane) §2.4: the code-first verdict (RL3). Ratified in docs/DECISIONS.md.
// ---------------------------------------------------------------------------------------

/** The verdict ladder, ascending. Jev may climb it; nothing Jev answers may descend it. */
const VERDICT_RANK: Record<RiskAssessment['verdict'], number> = { ok: 0, review: 1, block: 2 };

/** §2.4: the higher of two verdicts — the whole of "Jev may only ESCALATE the code verdict". */
export function escalateVerdict(code: RiskAssessment['verdict'], jev: RiskAssessment['verdict']): RiskAssessment['verdict'] {
  return VERDICT_RANK[jev] > VERDICT_RANK[code] ? jev : code;
}

export interface CodeVerdict {
  verdict: RiskAssessment['verdict'];
  reason: string;
}

/**
 * contract 1.9 (Fastlane) §2.4: the verdict CODE computes for a step **no Jev answer reached** — the fallback of
 * the RL3 clause 3, and the thing the old allow-list row called "ask-or-decline, never allow", now in code.
 *
 * Two halves, and neither yields `allow` for an arbitrary `run`:
 *  - `dangerousCommand()` (`src/jev/danger.ts`) is a DENY-LIST, not a proof: a match yields `review`, which is an
 *    ask, and Jev's Scores may escalate it further to `block`.
 *  - `codeRiskReason()` is an ALLOW-LIST of cases that are safe as a matter of fact (a `read`, a verification run
 *    of the workspace test command, a verified regression-free patch, a recoverable revert, a `done` the engine's
 *    own passing run verified). A match yields `ok`.
 *  - Anything else is `review`: with Jev unreachable the code has no opinion, so the step is confirmed, never
 *    allowed. A Jev outage therefore costs confirmations, never correctness.
 */
export function codeRiskVerdict(proposal: Proposal, targets: readonly TargetInfo[], testCommand: TestCommand | null, verifiedCompletion: VerifiedCompletion | null | undefined): CodeVerdict {
  const action = proposal.action;
  const denied = codeRiskFloor(proposal);
  if (denied.verdict !== 'ok') return denied;
  const allowed = codeRiskReason(proposal, targets, testCommand, verifiedCompletion);
  if (allowed !== null) return { verdict: 'ok', reason: allowed };
  return { verdict: 'review', reason: `${action.kind}: no code rule clears this proposal and Jev did not answer, so it is reviewed — the deny-list is not a proof and the allow-list did not match` };
}

/**
 * contract 1.9 (Fastlane) §2.4: the floor Jev's own answer may not sink below — the DENY-LIST alone.
 *
 * This is the half that applies when Jev DID answer, and it is deliberately narrow. The contract's clause 2 is
 * "a code guard runs after, and it can only tighten": a deny-listed command can never be released by a Score at
 * level 0, and everything else keeps exactly the verdict Jev's Scores produce — which is what keeps a
 * `routers: 'on'` run the same run, rather than one that asks a human to confirm every step. The wider
 * `codeRiskVerdict()` is the fallback for the case Jev never answered, where "no opinion" must mean "ask".
 */
export function codeRiskFloor(proposal: Proposal): CodeVerdict {
  const action = proposal.action;
  const command = action.kind === 'run' ? action.command : null;
  const denied = command !== null ? dangerousCommand(command) : null;
  if (denied !== null) return { verdict: 'review', reason: `code deny-list: ${denied}` };
  return { verdict: 'ok', reason: 'no deny-list rule matches; the code floor is ok and Jev\'s Scores decide' };
}

/** Q19/Q20's audit trail: the Score rows keep Jev's own verdict even where code overrode it (§2.4 clause 3). */
function stampRowVerdict(rows: readonly Decision[], dims: readonly string[], v: RiskAssessment['verdict']): void {
  for (const r of rows) if (dims.includes(r.id)) r.verdict = v;
}

/** docs/LLM-JEV-DESIGN.md §5 Q20: the two harm Scores (`destructive`, `irreversible`) with the §5.5 level texts; nothing else. */
export function harmOnlyQuestions(): Record<string, Question> {
  const qs: Record<string, Question> = {};
  for (const dim of HARM_DIMENSIONS) qs[dim] = score(RISK_INSTRUCTIONS[dim], [...RISK_LEVEL_TEXTS[dim]]);
  return qs;
}

/** The synthetic level-0 assessment of a code-`ok` proposal: full `dims` (confidence 1) so the TUI and `confirm()` read a complete record. */
export function codeOkAssessment(intent: Intent | null, reason: string): RiskAssessment {
  return { ...assessRisk({}, 1, intent, { texts: RISK_LEVEL_TEXTS }), verdict: 'ok', reason: `risk 0.00 (ok) by code: ${reason}` };
}

// ---------------------------------------------------------------------------------------
// Prior patches (§17 item 3)
// ---------------------------------------------------------------------------------------

export interface PatchAttemptState {
  step: number;
  kind: 'patch' | 'edit' | 'write';
  hash: string;
  sites: string[];
  /** the shadow run's counts when the proposal carried evidence */
  evidence: { beforePassed: number; afterPassed: number; total: number } | null;
  status: OutcomeStatus | null;
  runBefore: PriorPatchRun | null;
  runAfter: PriorPatchRun | null;
}

export interface PatchHistoryState {
  attempts: PatchAttemptState[];
}

export interface PatchHistory {
  /**
   * Once per risk assessment: folds what `common.recent` and `workspace.lastTestRun` now show about
   * the remembered attempts, returns the prior patches relative to `proposal` (empty for a proposal
   * that is not a workspace change), then remembers a change proposal. Repeated calls for one step
   * replace that step's entry (a retried stage).
   */
  observe(step: number, proposal: Proposal, common: JsonObject): PriorPatch[];
  toState(): PatchHistoryState;
}

/** `path:line` per hunk of a unified diff (the new-file start line), the path for edit/write. */
export function patchSites(action: Proposal['action']): string[] {
  if (action.kind === 'edit' || action.kind === 'write') return [action.path];
  if (action.kind !== 'patch') return [];
  const out: string[] = [];
  let path: string | null = null;
  for (const line of action.diff.split('\n')) {
    const f = /^\+\+\+ (?:"?)([^\t\n"]+)/.exec(line);
    if (f && f[1]) {
      let p = f[1].trim();
      if (/^[ab]\//.test(p)) p = p.slice(2);
      path = p === '/dev/null' ? null : p;
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (h && path !== null) out.push(`${path}:${h[1]}`);
  }
  if (out.length === 0) for (const p of patchTouchedPaths(action.diff)) out.push(p);
  return out;
}

function runOf(common: JsonObject): PriorPatchRun | null {
  const r = commonLastRun(common);
  return r === null ? null : { step: r.step, passed: r.passed, failed: r.failed, errors: r.errors, allPassed: r.allPassed };
}

function recentStatuses(common: JsonObject): Map<number, OutcomeStatus> {
  const out = new Map<number, OutcomeStatus>();
  const recent = common['recent'];
  if (!Array.isArray(recent)) return out;
  for (const e of recent) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) continue;
    const o = e as JsonObject;
    if (typeof o['step'] === 'number' && typeof o['outcome'] === 'string') out.set(o['step'], o['outcome'] as OutcomeStatus);
  }
  return out;
}

/**
 * The result of an earlier attempt from facts only (see PriorPatchResult). `goalHeld` compares the
 * gain the earlier patch's shadow run claimed with the baseline the current proposal's shadow run
 * measured on the same suite (same `total`): false means the workspace re-baseline did not keep it.
 */
export function classifyPatchResult(a: PatchAttemptState, current: ProposalEvidence | undefined): { result: PriorPatchResult; goalHeld: boolean | null } {
  let goalHeld: boolean | null = null;
  if (a.evidence !== null && current !== undefined && current.before.total === a.evidence.total && current.before.total > 0) goalHeld = current.before.passed >= a.evidence.afterPassed;
  if (a.status === 'blocked' || a.status === 'declined') return { result: 'refused', goalHeld };
  if (a.status === 'failed') return { result: 'failed', goalHeld };
  const after = a.runAfter;
  const before = a.runBefore;
  if (after !== null && before !== null && after.failed + after.errors > before.failed + before.errors) return { result: 'regressed', goalHeld };
  if (goalHeld === false) return { result: 'not_fixed', goalHeld };
  if (after === null) return { result: goalHeld === true ? 'fixed' : 'unverified', goalHeld };
  const gained = before === null ? after.passed > 0 : after.passed > before.passed;
  if (after.allPassed && (gained || (before !== null && !before.allPassed) || goalHeld === true)) return { result: 'fixed', goalHeld };
  if (gained) return { result: 'progressed', goalHeld };
  return { result: goalHeld === true ? 'fixed' : 'no_change', goalHeld };
}

export function createPatchHistory(initial?: PatchHistoryState): PatchHistory {
  const attempts: PatchAttemptState[] = initial ? initial.attempts.map((a) => ({ ...a, sites: [...a.sites], evidence: a.evidence ? { ...a.evidence } : null, runBefore: a.runBefore ? { ...a.runBefore } : null, runAfter: a.runAfter ? { ...a.runAfter } : null })) : [];
  return {
    observe(step, proposal, common) {
      const statuses = recentStatuses(common);
      const run = runOf(common);
      for (const a of attempts) {
        if (a.status === null) {
          const st = statuses.get(a.step);
          if (st !== undefined) a.status = st;
        }
        if (a.runAfter === null && run !== null && run.step > a.step && a.status !== 'blocked' && a.status !== 'declined' && a.status !== 'failed') a.runAfter = run;
      }
      const action = proposal.action;
      if (!isChangeAction(action.kind)) return [];
      const a = action as Extract<Proposal['action'], { kind: 'edit' | 'write' | 'patch' }>;
      const hash = patchContentHash(a);
      const priors: PriorPatch[] = attempts
        .filter((x) => x.step < step)
        .map((x) => {
          const { result, goalHeld } = classifyPatchResult(x, proposal.evidence);
          return { step: x.step, kind: x.kind, sites: [...x.sites], status: x.status, applied: x.status === 'executed', result, sameContent: x.hash === hash, runAfter: x.runAfter ? { ...x.runAfter } : null, goalHeld };
        });
      const e = proposal.evidence;
      const entry: PatchAttemptState = { step, kind: a.kind, hash, sites: patchSites(a), evidence: e ? { beforePassed: e.before.passed, afterPassed: e.after.passed, total: e.after.total } : null, status: null, runBefore: run, runAfter: null };
      const at = attempts.findIndex((x) => x.step === step);
      if (at === -1) attempts.push(entry);
      else attempts[at] = entry;
      return priors;
    },
    toState: () => ({ attempts: attempts.map((a) => ({ ...a, sites: [...a.sites], evidence: a.evidence ? { ...a.evidence } : null, runBefore: a.runBefore ? { ...a.runBefore } : null, runAfter: a.runAfter ? { ...a.runAfter } : null })) }),
  };
}

/**
 * Item 3(c) (§17): the proposal is a workspace change whose evidence is verified with no `newlyFailing`
 * and whose content differs from every earlier patch of this run that was applied (a refused one
 * never ran, so re-proposing it is not repeating a failure; the loop detector's `patch:` signature
 * still counts identical re-proposals).
 */
export function novelVerifiedPatch(proposal: Proposal, priors: readonly PriorPatch[]): boolean {
  const e = proposal.evidence;
  if (!isChangeAction(proposal.action.kind) || e === undefined) return false;
  if (!evidenceVerified(e) || e.newlyFailing.length > 0) return false;
  return priors.every((p) => !(p.sameContent && p.applied));
}

/**
 * Per-run histories for the stage's default path (the engine does not yet own one; it can pass
 * `RiskStageOptions.patchHistory` and checkpoint `toState()`). Bounded to the most recent runs of
 * the process; a history whose newest attempt is at or past the current step belongs to a previous
 * run with the same id (tests) and is dropped.
 */
const HISTORIES = new Map<string, PatchHistory>();
const HISTORIES_MAX = 16;

export function patchHistoryFor(runId: string, step: number): PatchHistory {
  let h = HISTORIES.get(runId);
  if (h !== undefined && h.toState().attempts.some((a) => a.step >= step)) {
    HISTORIES.delete(runId);
    h = undefined;
  }
  if (h === undefined) {
    h = createPatchHistory();
    HISTORIES.set(runId, h);
    while (HISTORIES.size > HISTORIES_MAX) {
      const oldest = HISTORIES.keys().next().value;
      if (oldest === undefined) break;
      HISTORIES.delete(oldest);
    }
  }
  return h;
}

/** tests: forget a run's history */
export function resetPatchHistory(runId: string): void {
  HISTORIES.delete(runId);
}

/** Code-computed target info for edit/write (one) or patch (per touched path). */
export async function computeTargets(ctx: StageContext, proposal: Proposal): Promise<TargetInfo[]> {
  const out: TargetInfo[] = [];
  for (const p of targetPaths(proposal.action)) out.push(await ctx.workspace.target(p, ctx.createdThisRun));
  return out;
}

// ---------------------------------------------------------------------------------------
// Ownership — belt 2 (docs/ORCHESTRATION-DESIGN.md §2.4, §2.5(a)/(b), corner rows 18, 19, 24)
// ---------------------------------------------------------------------------------------

/**
 * §2.4 [G8]: the paths a proposal writes that the harness can know BEFORE anything runs — exactly
 * what `computeTargets` reads. `run` yields none, and that is the hole belt 2 does not cover: it is
 * closed after the fact by the post-`run` escape diff (`escapedPaths`, `src/loop/launch.ts`).
 */
export function targetPaths(a: Action): string[] {
  return a.kind === 'edit' || a.kind === 'write' ? [a.path] : a.kind === 'patch' ? patchTouchedPaths(a.diff).slice(0, 50) : [];
}

/** §2.4 belt 2: every refusal reason begins with this, so `isOwnershipRefusal` needs no second channel. */
export const OWNERSHIP_REFUSAL_PREFIX = "outside this agent's ownership: ";
/** §2.5(b) / corner row 24: a `role: 'research'` child refused a write. Counted, but NOT a scope fight. */
export const RESEARCH_REFUSAL_PREFIX = 'research agents are read-only: ';
/** §2.4 / corner row 18: this many CONSECUTIVE belt-2 refusals park the child with `scope-fight`. */
export const SCOPE_FIGHT_AFTER = 3;

/** True for a belt-2 refusal reason (never for the research refusal, which is not the split's fault). */
export function isOwnershipRefusal(reason: string): boolean {
  return reason.startsWith(OWNERSHIP_REFUSAL_PREFIX);
}

/**
 * §2.4 belt 2 and §2.5(b), as one code rule the risk stage applies BEFORE any Jev request and before
 * anything touches the workspace:
 *
 *   - `role: 'research'` → `edit | write | patch` are not in the action space at all (row 24);
 *   - otherwise a target outside `own` → `outside this agent's ownership: src/y.ts (owns src/tui/**)`.
 *
 * The glob matcher is the facade's (`matchesOwn` / `ownsPath` through `parseOwnGlob`) — there is
 * exactly one `own` sub-language in this repo and this is not a second one. An unparsable glob owns
 * nothing, the same rule `outsideOwn` takes: widening ownership on a malformed string is the one
 * failure mode belt 2 exists to prevent.
 *
 * Returns `null` for a parent (`depth: 0`) and for a run with no `orchestration` at all, which is why
 * nothing here can change the behaviour of an ordinary run.
 */
export function ownershipRefusal(action: Action, orchestration: OrchestrationOptions | undefined): { status: 'blocked'; reason: string } | null {
  if (orchestration === undefined || orchestration.depth !== 1) return null;
  if (orchestration.role === 'research' && !(RESEARCH_ACTION_KINDS as readonly string[]).includes(action.kind)) {
    return { status: 'blocked', reason: `${RESEARCH_REFUSAL_PREFIX}${action.kind} is not in a research agent's action space (${RESEARCH_ACTION_KINDS.join(' | ')})` };
  }
  const targets = targetPaths(action);
  if (targets.length === 0) return null;
  const own = orchestration.own ?? [];
  const globs: OwnGlob[] = [];
  for (const raw of own) {
    const p = parseOwnGlob(raw);
    if (p.ok) globs.push(p.glob);
  }
  // review 2026-09-22 finding 4: FAIL CLOSED. An absent `own` (the member is optional, so this is a reachable
  // spawn), an empty one, or one whose every glob the §3.4 sub-language rejects, all mean the same thing: this
  // agent owns nothing. Returning null there made belt 2 read "owns everything" — the one place in the design
  // where an unknown widened the slice instead of narrowing it. `read | run | done` are unaffected: they yield
  // no targets, so they return above this line.
  if (globs.length === 0) {
    return { status: 'blocked', reason: `${OWNERSHIP_REFUSAL_PREFIX}${[...new Set(targets)].join(', ')} (owns nothing: this agent was spawned without a usable \`own\` list)` };
  }
  const outside = targets.filter((p) => !ownsPath(globs, p));
  if (outside.length === 0) return null;
  return { status: 'blocked', reason: `${OWNERSHIP_REFUSAL_PREFIX}${[...new Set(outside)].join(', ')} (owns ${own.join(', ')})` };
}

/** §2.4: the refusal as a `RiskAssessment` the engine's existing `verdict === 'block'` branch turns into the outcome. */
export function ownershipBlockAssessment(intent: Intent | null, reason: string): RiskAssessment {
  return { ...assessRisk({}, 1, intent, { texts: RISK_LEVEL_TEXTS }), risk: 1, verdict: 'block', reason };
}

export interface RiskStageResult {
  risk: RiskAssessment;
  matchesIntent: number;
  /** the `evidence_consistent` answer; null when the proposal carried no evidence */
  evidenceConsistent: number | null;
  targets: TargetInfo[];
  /**
   * contract 1.9 (Fastlane) §2.4: which verdict stood — `'code'` when the harm ask was dropped or failed and the
   * code-first verdict was the answer, `'jev'` when Jev's Scores escalated it. Absent with routers off, where the
   * stage is the pre-1.9 one. The engine copies it to `StepRecord.riskSource` (the `askRecorded` seam, §7.5).
   */
  riskSource?: 'code' | 'jev';
  /** contract 1.9 (Fastlane) §2.4: the harm ask was dropped or failed and the CODE verdict stood. */
  jevUnavailable?: boolean;
}

export interface RiskStageOptions {
  /** the detected workspace test command for the verification-run rule (default: ctx.workspaceInfo.testCommand) */
  testCommand?: TestCommand | null;
  /** Fix 1: the engine's own passing, current run when the `done` proposal claims nothing remains (engine-computed); null otherwise */
  verifiedCompletion?: VerifiedCompletion | null;
  /** item 3: the run's patch history (default: the stage's per-runId instance, `patchHistoryFor`) */
  patchHistory?: PatchHistory;
}

type IntentInfo = { intent: Intent; answer: Intent | 'none_of_these'; probability: number };

export async function runRiskStage(ctx: StageContext, common: JsonObject, proposal: Proposal, intent: IntentInfo, opts: RiskStageOptions = {}): Promise<RiskStageResult> {
  // ORCHESTRATION-DESIGN §2.4 belt 2 / §2.5(b): a child's refusal is CODE — decided before the targets are
  // stat'ed, before any Jev request, and in every mode that runs this stage. The engine's existing
  // `verdict === 'block'` branch turns it into `{ status: 'blocked', reason }` and counts it in `counters.blocked`.
  const refusal = ownershipRefusal(proposal.action, ctx.orchestration);
  if (refusal !== null) {
    const risk = ownershipBlockAssessment(intent.intent, refusal.reason);
    ctx.emit({ type: 'risk', step: ctx.step, risk });
    return { risk, matchesIntent: 1, evidenceConsistent: null, targets: [] };
  }
  const targets = await computeTargets(ctx, proposal);
  const history = opts.patchHistory ?? patchHistoryFor(ctx.runId, ctx.step);
  const priorPatches = history.observe(ctx.step, proposal, common);
  const testCommand = opts.testCommand === undefined ? ctx.workspaceInfo.testCommand : opts.testCommand;
  if (ctx.mode === 'llm-jev') return runHarmOnlyRiskStage(ctx, common, proposal, intent, { targets, priorPatches, testCommand, verifiedCompletion: opts.verifiedCompletion ?? null });
  // `matches_intent` asks about `intent.choice`; that must be the effective intent the generator
  // was given, never the raw escape answer (§6 per-outcome table).
  const state = buildRiskState(common, proposal, { choice: intent.intent, probability: intent.probability }, targets, ctx.redact, isChangeAction(proposal.action.kind) ? priorPatches : undefined);
  const evidence = proposal.evidence;
  const withEvidence = evidence !== undefined;
  const texts = riskLevelTexts(withEvidence);
  const verificationRun = proposal.action.kind === 'run' && isVerificationRun(proposal.action.command, testCommand);
  const novelPatch = novelVerifiedPatch(proposal, priorPatches);
  const assessOpts = (ec: number | null): AssessOptions => {
    const base: AssessOptions = withEvidence ? { evidenceConsistent: ec, evidence, goal: proposal.goal, texts } : { texts };
    if (verificationRun) return { ...base, verificationRun: true };
    if (novelPatch) return { ...base, novelPatch: { priorPatches: priorPatches.length } };
    return base;
  };
  let assessment: RiskAssessment | null = null;
  let matchesIntent = 1;
  let evidenceConsistent: number | null = null;
  const routers = routersOn(ctx.mode);
  // §2.4: with routers on the code verdict is computed BEFORE the request is made, so a failed ask has an answer
  // to fall back to. When Jev does answer, only the narrower deny-list floor applies (codeRiskFloor, below).
  const code = routers ? codeRiskVerdict(proposal, targets, testCommand, opts.verifiedCompletion) : null;
  let jevAnswered = false;
  const askRisk = async (): Promise<void> => {
    // jev-contract: RL3 harm+alignment (docs/LLM-LOOP-DESIGN.md §2.4) — THIS SITE IS A GATE, NOT A ROUTER, and
    // its polarity is ratified in docs/DECISIONS.md (2026-09-22, "the risk verdict is code-first").
    //   escape:   the Scores carry their escape; an unanswered Score is inert (src/jev/off.ts answers every Score
    //             at its TOP level, which can only escalate).
    //   guard:    with routers on a CODE FLOOR runs after the answer and can only TIGHTEN it: codeRiskFloor() —
    //             dangerousCommand() (src/jev/danger.ts, a DENY-LIST, not a proof) — raises Jev's verdict to
    //             `review` for a deny-listed command, so no Score at level 0 can release one. Everything Jev
    //             answered about keeps its pre-1.9 verdict and its pre-1.9 reason, byte for byte.
    //   fallback: with NO answer (a JevError, a 503/529, an abort) codeRiskVerdict() is the verdict — the allow-list yields ok, the deny-list and everything unmatched yield review (ask-or-decline, never allow), recorded as jevUnavailable / riskSource 'code' — test: test/unit/loop/router.test.ts
    //   no-gating: Jev does not gate — code does. A Jev outage cannot allow what code did not clear, and it
    //             cannot end the run: the stage returns a verdict either way. Routers off = the pre-1.9 stage.
    await ctx.ask('risk', state, buildRiskQuestions({ evidence: withEvidence }), (answers, rows) => {
      const mi = answers['matches_intent'];
      matchesIntent = mi && mi.type === 'noul' ? mi.noul : 1;
      const ec = answers[EVIDENCE_CONSISTENT_ID];
      evidenceConsistent = ec && ec.type === 'noul' ? ec.noul : null;
      assessment = assessRisk(answers, matchesIntent, intent.intent, assessOpts(evidenceConsistent));
      jevAnswered = true;
      // The Score rows keep Jev's own verdict even when the verified-completion rule below overrides it (audit trail).
      stampRowVerdict(rows, RISK_DIMENSIONS, assessment.verdict);
    });
  };
  if (code === null) await askRisk();
  else {
    try {
      await askRisk();
    } catch {
      // §2.4 / I5: a JevError, a 503/529 or an abort is not a stage failure here — the code verdict is the answer
      jevAnswered = false;
    }
  }
  let risk: RiskAssessment = assessment ?? assessRisk({}, matchesIntent, intent.intent, assessOpts(evidenceConsistent));
  if (code !== null && !jevAnswered) {
    // no answer reached this step: the CODE verdict is the verdict, and it never allows what code did not clear
    risk = { ...risk, verdict: code.verdict, reason: `code verdict ${code.verdict} (${code.reason}); Jev unavailable, the code verdict stands` };
  } else if (code !== null) {
    // Jev answered: its verdict stands, raised by the deny-list floor where the floor is higher. Where the floor
    // changes nothing — every step but a deny-listed command — the reason is byte-identical to the pre-1.9 one.
    const floor = codeRiskFloor(proposal);
    const raised = escalateVerdict(floor.verdict, risk.verdict);
    if (raised !== risk.verdict) risk = { ...risk, verdict: raised, reason: `${floor.reason} — the code floor raises Jev's ${risk.verdict} to ${raised}: ${risk.reason}` };
  }
  const verified = opts.verifiedCompletion;
  if (verified !== undefined && verified !== null && proposal.action.kind === 'done' && risk.verdict !== 'ok') risk = completionVerifiedByRun(risk, verified);
  ctx.emit({ type: 'risk', step: ctx.step, risk });
  return { risk, matchesIntent, evidenceConsistent, targets, ...(code !== null ? { riskSource: jevAnswered ? ('jev' as const) : ('code' as const), jevUnavailable: !jevAnswered } : {}) };
}

interface HarmOnlyInput {
  targets: TargetInfo[];
  priorPatches: PriorPatch[];
  testCommand: TestCommand | null;
  verifiedCompletion: VerifiedCompletion | null;
}

/**
 * llm-jev (docs/LLM-JEV-DESIGN.md §3 row 5, §6.3): the code facts decide BEFORE any Jev request — a verified patch, a
 * recoverable revert, a verification run, a verified `done` and a `read` are `ok` with a reason naming the evidence
 * and synthetic level-0 dims. Everything else (a non-test `run`, an unverified best-guess patch, a partial `done`)
 * is gated by Q20's two harm Scores alone; `matches_intent`, `evidence_consistent` and the alignment Scores are never asked.
 */
async function runHarmOnlyRiskStage(ctx: StageContext, common: JsonObject, proposal: Proposal, intent: IntentInfo, input: HarmOnlyInput): Promise<RiskStageResult> {
  const { targets } = input;
  const code = codeRiskReason(proposal, targets, input.testCommand, input.verifiedCompletion);
  if (code !== null) {
    const risk = codeOkAssessment(intent.intent, code);
    ctx.emit({ type: 'risk', step: ctx.step, risk });
    return { risk, matchesIntent: 1, evidenceConsistent: null, targets };
  }
  // change 6: the harm Scores are a Jev request only for a `run` that is not the workspace test command. Everything
  // else on the synth path records them where `runHarmOnlyRiskStage` already recorded the alignment two — level 0,
  // confidence 1 — and says so in the reason, so the audit trail still names every dimension.
  const action = proposal.action;
  if (!harmScoresDue(action.kind, action.kind === 'run' ? action.command : null, input.testCommand)) {
    const risk = codeOkAssessment(
      intent.intent,
      `${action.kind}: the harm Scores gate a \`run\` that is not the workspace test command; every other synth-path proposal records destructive and irreversible at level 0 (oos-analysis-2026-09-22 change 6: 51 questions each, 1 distinct answer)`,
    );
    ctx.emit({ type: 'risk', step: ctx.step, risk });
    return { risk, matchesIntent: 1, evidenceConsistent: null, targets };
  }
  const state = buildRiskState(common, proposal, { choice: intent.intent, probability: intent.probability }, targets, ctx.redact, isChangeAction(proposal.action.kind) ? input.priorPatches : undefined);
  const evidence = proposal.evidence;
  const assessOpts: AssessOptions = { texts: RISK_LEVEL_TEXTS, harmOnly: true, ...(evidence !== undefined ? { evidence, goal: proposal.goal } : {}) };
  let assessment: RiskAssessment | null = null;
  // jev-contract: RL3 llm-jev Q20 (docs/LLM-LOOP-DESIGN.md §2.4) — A GATE, NOT A ROUTER; unchanged by contract 1.9.
  //   escape:   the two harm Scores carry their escape; src/jev/off.ts answers every Score at its TOP level, so
  //             "no opinion" can only escalate, never release.
  //   guard:    every code-`ok` case was decided BEFORE this request (codeRiskReason, the allow-list above), and
  //             the engine's confirm/coordinate/budget path still runs on whatever comes back.
  //   fallback: a failed ask means ask-or-decline, never allow — assessRisk({}) leaves the Scores at their top level and the proposal is reviewed or blocked — test: test/unit/loop/router.test.ts
  //   no-gating: the answer cannot release what the code allow-list did not clear, cannot complete a run and
  //             cannot accept a patch.
  await ctx.ask('risk', state, harmOnlyQuestions(), (answers, rows) => {
    assessment = assessRisk(answers, 1, intent.intent, assessOpts);
    stampRowVerdict(rows, HARM_DIMENSIONS, assessment.verdict);
  });
  const risk: RiskAssessment = assessment ?? assessRisk({}, 1, intent.intent, assessOpts);
  ctx.emit({ type: 'risk', step: ctx.step, risk });
  return { risk, matchesIntent: 1, evidenceConsistent: null, targets };
}
