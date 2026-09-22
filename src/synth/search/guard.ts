/**
 * The overfit guard and the decision on a run batch (docs/JEV-ONLY-DESIGN.md §2.6; wordings §2.7
 * Q15/Q16, measured in experiments/contrarian/arbitrate.mts → contrarian-arbitrate.{truth,all}.jsonl).
 *
 * Code first, Jev only where tests cannot decide:
 *   0 plausible → hold the best partial (bases.ts) and keep searching;
 *   1 plausible → commit; tests are the oracle and no Noul threshold withholds a clean lone passer
 *                 (`quicksort` gold Noul 0.15). Within the step two holds delay it
 *                 (jev-only-quixbugs-3-inspection.md §1: `detect_cycle` and `wrap` committed the
 *                 first lone passer of the step while the gold's site was still unvisited):
 *                 (a) SIEVE mode: a lone passer waits until its site's other seed sources ran, so
 *                     the decision sees the whole site batch (`pending`, rule (a) below);
 *                 (b) a lone passer that is structurally suspicious by code-computed signals
 *                     (deletes a statement, duplicates a block, guards a different variable than
 *                     the failing traceback dereferences, guards an expression nothing reads, ADDS
 *                     a special-case guard or literal — `if x:`, `return 0`, `** 2`) is put to Q16
 *                     as an advisory whenever a Jev request is left; below LONE_PASSER_HOLD_MAX_NOUL
 *                     it is held as the `suspect` and that hold is NEVER released — not on the
 *                     budget reserve, not at step end (`commitSuspect` returns null and the step
 *                     ends on its honest partial or parks); with two or more signals a p below
 *                     LONE_PASSER_VOUCH_MIN_NOUL holds it too, released on the reserve or at step
 *                     end as `possible overfit` as before. A later passer is decided against it.
 *                 The pending hold and the vouch-bound hold are released by the next decision once
 *                 the step's budget is inside HOLD_RESERVE_*, and by `commitSuspect` at step end.
 *   ≥ 2        → cluster by behaviour on code-generated perturbed inputs (perturb.ts: the goal's
 *                 calls, the JSON cases, the linked lists the tests build, the harvested test calls
 *                 of a ladder-class workspace; elsewhere the P2P outcome vector). Generality by
 *                 code before Jev (llm-jev-headtohead.md §9 class A: `wrap`'s Q15 chose GLM's
 *                 `if text:` variant at 0.95 over the gold seed):
 *                   - one cluster mixing a code seed and an LLM candidate → its LLM member (§6.2);
 *                   - a cluster holding a strict MAJORITY of the independent support (distinct
 *                     source × site pairs, `clusterSupport`) → its representative;
 *                   - clusters split, some cluster holding an LLM member or the supports differing
 *                     → the representative adding the FEWEST special-case guards
 *                     (`specialCaseScore`: conditionals + literals beyond the replaced line);
 *                   - clusters split with NO LLM member and equal support (`seedOnlySplit`, class A′
 *                     of llm-jev-headtohead-v2.md §9: the count committed `stats` and `detect_cycle`
 *                     as overfits) → the cluster agreeing with the passers' majority on the
 *                     perturbed inputs (`probeMajorityCluster`), and NEVER the count: when the probe
 *                     separates none of them the request below decides;
 *                   - a residual tie (or a single all-seed cluster of ≥ 2) → ONE request: Q15
 *                     `genuine_fix` Choice over ≤ 20 representatives + Q16 `general_<xx>` Nouls,
 *                     with the PERTURBATION TABLE (which inputs differ, each output) in the state.
 *                 The all-overfit signature (P(escape) ≥ SUSPECT_ESCAPE_MIN ∧ max Noul <
 *                 SUSPECT_NOUL_MAX) DROPS the set: nothing is held or committed, the search goes on
 *                 with the batch's best partial held; otherwise the Choice argmax is committed,
 *                 with the Choice/Noul override rule of DESIGN §5.4 and the others as fallbacks.
 *
 * The guard never overrides the tests upward: a candidate failing a goal test is never proposed.
 * It does refuse passers: one whose arbitration answered the all-overfit signature, and a lone
 * passer Jev confidently doubted, are never committed (head-to-head v1 committed 5 overfits where
 * the baseline committed 0; experiments/results/llm-jev-headtohead.md §5, §9).
 *
 * **Structural refusals (2026-09-22, ranked change 5 of docs/research/llm-jev/oos-analysis-2026-09-22.md).**
 * Before any rule above runs, `decide` drops a passer that `structuralRejection` refuses: one that
 * adds an implicit-`None` exit to a function whose every other exit returns a value, or that mutates
 * in place a parameter the pre-patch code left alone. Both are read off the patched file's source
 * (src/synth/py/structure.ts `fallsOffEnd` / `mutatedParameters`) before and after the patch, so
 * they have no threshold, no task name and no Jev cost; the probe's own post-call argument diff
 * (`perturb.ts ladderOutputText`) refuses the same shape at run time when a signature carries it.
 * The two records behind them (Q6) are the ones the guard committed with everything else working:
 * `20260922-013715-nlsygcax` (noul 0.44, above `SUSPECT_NOUL_MAX`, so no all-overfit drop) and
 * `20260922-014311-65ul43qh` (decided by `probeMajorityCluster`/majority, no `genuine_fix` request).
 */
import type { Json, StageName, SynthesisContext } from '../../core/types.js';
import { choice, ESCAPE_KEY, noul } from '../../jev/questions.js';
import type { NoulCriteriaSpec } from '../../jev/questions.js';
import { codeLines, moduleCodeLines } from '../localize/index.js';
import { analyse, codeTokens, fallsOffEnd, guardClauses, guardsDerivedLocal, isKeyword, isLateGuard, levenshtein, mutatedParameters, normaliseLine, qualifiedName, statementKinds, tokenizeFragment } from '../py/index.js';
import type { Block, GuardClause, PyModule, ReturnFact, StatementKind } from '../py/index.js';
import type { LanePool } from '../sieve/lanes.js';
import type { AppliedCandidate, Candidate, CandidateSourceName, FailureView, JevAsk, SourceFile } from '../types.js';
import { RUN_FAILURE_ID } from '../verify/text.js';
import { MAX_PARTIALS_REMEMBERED, appliedOnCommitted, commitPartial, committedBase, guardState, holdBestPartial, isPartial, outcomeSummary, siteKeyOf } from './bases.js';
import type { GuardMemory, HeldPasser, PartialAdvice } from './bases.js';
import { SIEVE_MAX_T_RUN_MS } from './budget.js';
import { DEFAULT_PROBE_TIMEOUT_MS, LADDER_MAX_PROBE_INPUTS, MAX_PERTURBED_INPUTS, TEST_SOURCE_MAX_BYTES, createLadderProbe, createLaneProbe, describeInput, harvestLadderInputs, inputKey, ladderLayoutOf, perturbedInputs, perturbedInputsFor, programNameOf, readTestSources } from './perturb.js';
import type { BehaviourProbe, LadderLayout, PerturbedInput } from './perturb.js';
import type { Arbitration, BehaviourCluster, Decision, Goal, OracleModel, StepBudget, VerifyOutcome } from './types.js';

export {
  DEFAULT_PROBE_TIMEOUT_MS,
  LADDER_HARNESS,
  LADDER_MAX_PROBE_INPUTS,
  MAX_PERTURBED_INPUTS,
  PROBE_OUTPUT_BOUND,
  behaviourProbeCommand,
  createLadderProbe,
  createLaneProbe,
  describeInput,
  harvestLadderInputs,
  ladderHarvestCommand,
  ladderLayoutOf,
  ladderReplayCommand,
  linkedListInputs,
  linkedListShape,
  parseBehaviourProbe,
  parseLadderHarvest,
  parseLadderReplay,
  parseQuixbugsCall,
  perturbationsOf,
  perturbedInputs,
  perturbedInputsFor,
  perturbedInputsFromCases,
  probeTimeoutMs,
  programNameOf,
  readTestSources,
} from './perturb.js';
export type { BehaviourProbe, HarvestedCall, LadderHarvest, LadderLayout, LinkedListShape, PerturbationKind, PerturbedInput, ProbeCommandOptions, TestSources } from './perturb.js';

// ---------------------------------------------------------------------------------------
// Constants (each with the measurement behind it)
// ---------------------------------------------------------------------------------------

/**
 * The all-overfit signature (§2.6): the sets where every passer overfits answered P(escape) 0.90
 * with max Noul 0.06 (`depth_first_search`, 7 candidates, contrarian-arbitrate.all.jsonl), 0.89 /
 * 0.90 / 0.88 / 0.91 / 0.88 with max Noul 0.05–0.07 (`wrap`, the duplicated-loop passers of
 * jev-only-quixbugs-4-overfit, §13 of jev-only-rungs-1-2.md), 0.75 / 0.67 with max Noul 0.08
 * (ladder `masked` runs 3 and 3b, §20: five `return 0` inserts into `total_ms`) and, in the
 * llm-jev head-to-head (llm-jev-headtohead.md §5.2, §9 class A), 0.86 / 0.12 (`textstats`,
 * `tokens.append(n)` inside `ngrams`) and 0.78 / 0.11 (`django-15315`, a dead-code donor) — the
 * last two committed under the old Noul bound of 0.1. Every set containing the gold had P(escape)
 * ≤ 0.38 and a Noul ≥ 0.45. Both halves must hold (`arbitrate`). The Noul bound is the
 * "confidently false" 0.3 of DESIGN §5.4 (OVERRIDE_LOW): 0.18 above the two new sets, 0.15 under
 * the lowest gold Noul. The escape bound stays at 0.5, between the highest gold escape (0.38) and
 * the lowest all-overfit one (0.67): the fix brief's 0.7 would let `masked` 3b through again, and
 * 0.5 ∧ 0.3 is a superset of it. A flagged set is DROPPED (rule (1) of the head-to-head fix):
 * its passers stay in `tried`, nothing is held, no reserve or step-end release exists for them,
 * and the search goes on with the batch's best partial held. Before 2026-09-21 the smallest edit
 * was held as the `suspect` and committed at step end as `possible overfit`.
 */
export const SUSPECT_ESCAPE_MIN = 0.5;
export const SUSPECT_NOUL_MAX = 0.3;
/** Rows of the perturbation table Jev sees with Q15: inputs on which the representatives' outputs differ (the probes run 16–32 inputs). */
export const PERTURBATION_ROWS_MAX = 12;
/** One output in that table is cut here (repr() or the exception class; the clustering compares the full text). */
export const PERTURBATION_OUTPUT_MAX = 120;
/** Explains the `perturbations` table; added to the measured state only when the probe ran and the representatives differ somewhere. */
export const PERTURBATION_NOTE =
  'Each row of `perturbations` is an input derived from the tests by a structural perturbation, with what every candidate returns on it (repr() of the result, or the exception class; `[arguments mutated to …]` when the call changed its own input). The candidates agree on every input not listed. The genuine fix is right on every valid input, not only on `tests`.';
/**
 * DESIGN §5.4 Choice/Noul resolution rule: the Choice argmax is overridden only when its own Noul
 * is confidently false (< 0.3) and another representative's is confidently true (≥ 0.7). Gold
 * Nouls ranged 0.15–0.96 (below 0.7 on 4/10, below 0.3 on 1/10), so the Noul stays advisory.
 */
export const OVERRIDE_LOW = 0.3;
export const OVERRIDE_HIGH = 0.7;
/**
 * Rule (b): a lone passer with ONE structural signal is held when its Q16 `general` p is below
 * this (the "confidently false" bound of OVERRIDE_LOW; 1/10 measured golds sat below it, and a
 * held gold is only delayed within the step, never withheld).
 */
export const LONE_PASSER_HOLD_MAX_NOUL = OVERRIDE_LOW;
/**
 * A lone passer with TWO OR MORE structural signals is committed at once only when Jev vouches
 * for it confidently (the "confidently true" bound of OVERRIDE_HIGH); anything less holds it. The
 * first live run of the rule (jev-only-rungs-1-2.md §13) had `detect_cycle`'s committed guard —
 * a copied block, guarding a variable the traceback never dereferences, read by nothing — answer
 * 0.39 and commit under the single bound.
 */
export const LONE_PASSER_VOUCH_MIN_NOUL = OVERRIDE_HIGH;
/** Signals from which the stronger (vouch) bound applies. */
export const STRONG_SIGNALS_MIN = 2;
/**
 * OOS iteration 3, item 2: the signals that may say a POOL contains no gold, as opposed to the
 * ones that only doubt a single passer. Membership is not "is this a good signal" — every
 * `SuspicionSignal` is one — it is "has this signal been SWEPT against the golds and found on
 * none of them". A signal a gold can carry turns a pool the gold is IN into a pool the rule calls
 * gold-free, and then the arbitration's vouch bound refuses the fix.
 *
 * FIVE qualify today. `mutates_new_argument` was swept over the whole gold corpus by
 * review-oos-iter-1-2026-09-22.md finding 2 ("Sweep of all 41 QuixBugs golds and 20 ladder
 * golds: zero refusals"). The other four are OOS iteration 4, items B and C, swept over all 198
 * gold patches by `test/unit/synth/search/signal-sweeps.test.ts` (QuixBugs 41, ladder 65,
 * SWE-bench Verified 92 Python hunks of which 30 do not tokenize as fragments and are reported
 * as skipped rather than clean):
 *   - `guards_other_variable` — 0 fires as it stood;
 *   - `dead_guard` — 2 gold fires as it stood (`sympy__sympy-17139`'s `rv.exp.is_real`, a
 *     predicate attribute the function never names, and `pytest-dev__pytest-10081`'s `skipped`,
 *     a local the patch itself introduces). Narrowed to "the subject OCCURS in the pre-patch
 *     function and is never dereferenced there", which is exactly `detect_cycle`'s
 *     `tortoise.successor`, and 0 fires after;
 *   - `duplicates_block` — 1 gold fire as it stood (`sympy__sympy-12489`, an in-place rename:
 *     abstracting identifiers is what makes a renamed line look like the line it replaced).
 *     Narrowed to "the patch RAISES the count of that normalised line", which is exactly
 *     `wrap`'s loop copied under itself, and 0 fires after;
 *   - `guards_derived_local` (item B) — 0 fires, and it FIRES on 2 of the 3 recorded iteration-1
 *     overfits (`stats`, `detect_cycle`; not `token_bucket`, whose overfit and gold guard the
 *     same two parameters and differ only in placement). Both halves of the bar, so it is the
 *     first signal admitted to the pool with positive evidence behind it as well as a clean
 *     sweep — which is what `late_guard` lacked.
 *
 * Every other signal is excluded, each for a measured reason:
 *   - `adds_special_case` is the input of `fewestSpecialCases` and the golds add special cases
 *     too (`detect_cycle`'s gold adds one conditional and one literal);
 *   - `deletes_statement` fires on a gold-shaped REWRITE, which deletes statements by
 *     construction. Measured: ladder `units` with Jev on (run `20260922-165453-txeukybg`) —
 *     "…the pick `composite/donor_body_unit:parse_size:2stmt` (deletes_statement,
 *     adds_special_case) answered general 0.50 < 0.7; dropping the 3 passers" — and the `units`
 *     gold IS a rewrite of `parse_duration`'s three statements into five;
 *   - `late_guard` was admitted by iteration 3 and is WITHDRAWN by its review. The rule it now
 *     implements (a dereference of the exact operand path, with no bind and no narrowing in
 *     front) is silent on all 41 QuixBugs golds, all 65 ladder gold files and all 92 Python hunks
 *     of `bench/data/swebench-verified-30.gold.json` — but it is also silent on all three of
 *     iteration 1's recorded overfits (`stats` binds `ordered` in front, `token_bucket` only
 *     plain-reads `cost`, `detect_cycle` never dereferences `hare.successor.successor`). A signal
 *     with no positive evidence on the records cannot be the evidence that a pool holds no gold.
 *     Iteration 4 left that ruling standing: the sweep is clean, the records are silent, so it
 *     is a LONE-PASSER signal, where one Q16 answer decides and nothing is dropped.
 */
export const POOL_SUSPECT_SIGNALS: ReadonlySet<SuspicionSignal> = new Set<SuspicionSignal>(['mutates_new_argument', 'guards_other_variable', 'dead_guard', 'duplicates_block', 'guards_derived_local']);
/**
 * A hold is started or kept only while the step has this much left: the wall of ~15 median
 * QuixBugs runs per lane and two lanes' worth of SIEVE batches, so the decision that releases the
 * hold always comes before `visitSource` finds no run left (jev-only-rungs-1-2.md §13). A hold
 * otherwise lasts to the step end (`commitSuspect`): the phase that visits the remaining sites of
 * a single-file workspace (WIDENED) is three phases after SEEDS, so no phase count bounds it.
 */
export const HOLD_RESERVE_WALL_MS = 15_000;
export const HOLD_RESERVE_RUNS = 16;
/**
 * The seed sources a site's batch consists of in SEEDS/WIDENED (subgoal.ts SEED_SOURCES, listed
 * here rather than imported so the guard does not depend on the controller). Composite runs after
 * these are exhausted at the site and never delays a passer.
 */
export const SITE_BATCH_SOURCES: readonly CandidateSourceName[] = ['mutation', 'template', 'donor'];
/** Q15 offered ≤ 20 representatives (contrarian §3.4; the measured sets had 2–7). */
export const MAX_REPRESENTATIVES = 20;
/** One cluster of ≥ 2 passers is still arbitrated (judge 2), over its ≤ 5 smallest-edit members. */
export const SINGLE_CLUSTER_MAX_MEMBERS = 5;
/** The measured state listed the first 4 tests. */
export const TESTS_IN_STATE = 4;
/** Program lines shown to Jev in the Q15 state (Q5's Choice window; measured programs were ≤ 20 lines). */
export const PROGRAM_LINES_MAX = 254;

export class GuardError extends Error {
  constructor(message: string) {
    super(`GuardError: ${message}`);
    this.name = 'GuardError';
  }
}

// ---------------------------------------------------------------------------------------
// Behaviour signatures and clustering (code)
// ---------------------------------------------------------------------------------------

/** The pytest signature: which tests pass in the widest run available (the P2P outcome vector). */
export function p2pVector(o: VerifyOutcome): string {
  const s = outcomeSummary(o);
  const failing = [...s.failing].sort();
  return `p2p:${s.passed}/${s.total};failing=${failing.join(',')}`;
}

/** Combine the P2P vector with a probe result (identical behaviour ⇔ identical string). */
export function behaviourSignature(o: VerifyOutcome, probe: string | null): string {
  return probe === null ? p2pVector(o) : `${p2pVector(o)}|${probe}`;
}

function tokensOf(text: string): string[] {
  return codeTokens(tokenizeFragment(text)).map((t) => t.text);
}

/**
 * Token edit distance between the site's current line and the candidate (plus the tokens of any
 * extra edits): the code-only notion of "minimal edit" the contrarian baseline measured (3/10 on
 * its own, so it only picks representatives and breaks ties here, never the fix).
 */
export function editCost(c: Candidate): number {
  const base = c.site.kind === 'replace' ? tokensOf(c.site.currentLine) : [];
  let cost = levenshtein(base, tokensOf(c.text));
  for (const e of c.extraEdits ?? []) cost += e.kind === 'delete' ? 1 : tokensOf(e.text ?? '').length;
  return cost;
}

function byEditCost(a: VerifyOutcome, b: VerifyOutcome): number {
  return editCost(a.applied.candidate) - editCost(b.applied.candidate) || a.applied.candidate.text.length - b.applied.candidate.text.length || a.applied.candidate.id.localeCompare(b.applied.candidate.id);
}

function isLlm(o: VerifyOutcome): boolean {
  return o.applied.candidate.source === 'llm';
}

/** docs/LLM-JEV-DESIGN.md §6.2: on a Choice tie an `llm` member goes before a code seed (negative when `a` is the LLM one). */
function llmFirst(a: VerifyOutcome, b: VerifyOutcome): number {
  return Number(isLlm(b)) - Number(isLlm(a));
}

/**
 * docs/LLM-JEV-DESIGN.md §6.2 `preferLlmInCluster`: the representative of a behaviour cluster is its
 * `llm` member with the most agreement (`Candidate.prior`, the folded-duplicate count; ties by edit
 * cost), else the min-edit member. Measured: GLM 16/16 gold-or-equivalent vs 7 seed overfits in 53
 * solves; jev-only committed 2/40 QuixBugs and 5/14 ladder overfits a larger LLM fix would have avoided.
 */
export function preferLlmInCluster(members: readonly VerifyOutcome[]): VerifyOutcome {
  const llm = members.filter(isLlm).sort((a, b) => (b.applied.candidate.prior ?? 0) - (a.applied.candidate.prior ?? 0) || byEditCost(a, b));
  const first = llm[0];
  return first ?? minEdit(members);
}

/** A cluster that holds candidates of the LLM and of a code source (the §6.2 code rule applies, no Jev request). */
export function mixedSourceCluster(c: Pick<BehaviourCluster, 'members'>): boolean {
  return c.members.some(isLlm) && c.members.some((m) => !isLlm(m));
}

/** The smallest-edit member of a set (the `suspect` when every passer looks like an overfit). */
export function minEdit(outcomes: readonly VerifyOutcome[]): VerifyOutcome {
  const sorted = [...outcomes].sort(byEditCost);
  const first = sorted[0];
  if (first === undefined) throw new GuardError('minEdit of an empty set');
  return first;
}

/**
 * Group plausible candidates whose behaviour is identical: the P2P outcome vector always, joined
 * with the probe signature when `signatures` (keyed by candidate id) has one, so two candidates
 * that agree on every perturbed input but not on the suite never share a cluster. Members are
 * ordered by edit cost and the representative is the smallest edit — or, when the cluster has an
 * `llm` member, that member (`preferLlmInCluster`, docs/LLM-JEV-DESIGN.md §6.2), moved to the
 * front so the single-cluster representatives include it; clusters are ordered by size, then
 * representative cost.
 */
export function clusterByBehaviour(outcomes: readonly VerifyOutcome[], signatures: ReadonlyMap<string, string> = new Map()): BehaviourCluster[] {
  const groups = new Map<string, VerifyOutcome[]>();
  for (const o of outcomes) {
    const sig = behaviourSignature(o, signatures.get(o.applied.candidate.id) ?? null);
    const list = groups.get(sig) ?? [];
    list.push(o);
    groups.set(sig, list);
  }
  const clusters = [...groups.entries()].map(([signature, members]) => {
    const sorted = [...members].sort(byEditCost);
    const representative = members.some(isLlm) ? preferLlmInCluster(members) : sorted[0];
    if (representative === undefined) throw new GuardError('empty behaviour cluster');
    return { id: '', members: [representative, ...sorted.filter((m) => m !== representative)], representative, signature };
  });
  clusters.sort((a, b) => b.members.length - a.members.length || byEditCost(a.representative, b.representative));
  return clusters.map((c, i) => ({ ...c, id: `cluster_${i + 1}` }));
}

/**
 * The independent support of a behaviour cluster: its distinct source × site pairs. Members of one
 * source at one site are near-duplicates — the mutation operators write `>=`, `not <` and
 * `not (<)` for one wrong boundary (`next_permutation`: three overfits against two golds, the
 * measured Q15 set), so a head count would crown the overfit; a seed and an LLM sample, or seeds
 * at two sites, agreeing on every perturbed input are separate derivations of one behaviour.
 */
export function clusterSupport(c: Pick<BehaviourCluster, 'members'>): number {
  return new Set(c.members.map((m) => `${m.applied.candidate.source}@${siteKeyOf(m.applied.candidate)}`)).size;
}

/**
 * Rule (2) of the head-to-head fix, first half: the cluster whose support is a strict majority of
 * every cluster's support together (more than all the others combined), else null. Its
 * representative (`preferLlmInCluster` when it has an LLM member) is committed by code, no Jev.
 */
export function majorityCluster(clusters: readonly BehaviourCluster[]): BehaviourCluster | null {
  if (clusters.length < 2) return null;
  const support = clusters.map((c) => clusterSupport(c));
  const total = support.reduce((a, b) => a + b, 0);
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    if (c !== undefined && (support[i] ?? 0) * 2 > total) return c;
  }
  return null;
}

/**
 * Rule (2), second half: when the clusters split (no majority), the representative that adds the
 * fewest special-case guards (`specialCaseScore`), when it is alone at the minimum; null on a tie,
 * which goes to Q15. `wrap` (llm-jev-headtohead.md §8.1): the gold `lines.append(text)` adds 0,
 * GLM's `if text:` variant 1, the copied loop 5 — code picks the gold that Jev's Choice had at 0.05.
 *
 * **Not applicable to an all-seed split of equal support** (`seedOnlySplit`, class A′ of
 * llm-jev-headtohead-v2.md §9): there the count is not evidence at all and `decide` never reaches
 * this rule — `probeMajorityCluster` decides, or Jev does.
 */
export function fewestSpecialCases(reps: readonly VerifyOutcome[]): VerifyOutcome | null {
  let best: VerifyOutcome | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let tied = false;
  for (const r of reps) {
    const s = specialCaseScore(r.applied.candidate).total;
    if (s < bestScore) {
      best = r;
      bestScore = s;
      tied = false;
    } else if (s === bestScore) tied = true;
  }
  return tied ? null : best;
}

/** The prefix and separator of a behaviour-probe signature that carries per-input outputs (`perturb.ts` `parseBehaviourProbe` / `parseLadderReplay`). */
export const PROBE_OUTPUTS_PREFIX = 'outputs:';
export const PROBE_OUTPUT_SEP = '\u001f';

/** The per-input outputs of a probe signature, or null for a P2P-only, `import_error:` or foreign one. */
export function probeOutputs(signature: string | undefined): string[] | null {
  return signature !== undefined && signature.startsWith(PROBE_OUTPUTS_PREFIX) ? signature.slice(PROBE_OUTPUTS_PREFIX.length).split(PROBE_OUTPUT_SEP) : null;
}

/**
 * An all-seed split of equal support: every cluster carries the same independent support
 * (`clusterSupport`) and none holds an `llm` member. Class A′ (llm-jev-headtohead-v2.md §9): this is
 * exactly the shape in which `fewestSpecialCases` committed two overfits — `stats`
 * (`values.remove(mid)` +0c beat the gold `if not values: raise` +1c/+1l, because the defect *was* a
 * missing guard) and `detect_cycle` (`if not hare.successor.successor: break` +1c beat
 * `guard_empty_return` +1c/+1l, because the least-guarded of three guards was the wrong guard) —
 * with the LLM sample gone (timed out at 20 s, cancelled at 19.3 s) so `preferLlmInCluster` and
 * Q15/Q16 never entered. The count decides nothing here; the probe (§6.2) or Jev does.
 */
export function seedOnlySplit(clusters: readonly BehaviourCluster[]): boolean {
  if (clusters.length < 2) return false;
  if (clusters.some((c) => c.members.some(isLlm))) return false;
  const support = clusters.map((c) => clusterSupport(c));
  return support.every((s) => s === support[0]);
}

export interface ProbeMajority {
  /** cluster id → the number of differing perturbed inputs on which its behaviour was the majority */
  agreement: Map<string, number>;
  /** perturbed inputs on which the clusters' probe outputs differ at all: the only ones that can separate them */
  differing: number;
  /** the cluster alone at the top of `agreement` (with at least one input behind it), else null — the probe separates none of them */
  winner: BehaviourCluster | null;
}

/**
 * Class A′, the code half: **prefer the cluster that agrees with the majority on the perturbed
 * inputs**. On every input where the clusters' probe outputs differ the passers vote — a cluster
 * casts one vote per member, since every member of a cluster produced that behaviour from its own
 * edit — and the output with the strictly largest vote is the majority behaviour on that input;
 * each cluster that produced it agrees once. The cluster alone at the top of the agreement count
 * wins; a split vote (`stats` has none, `detect_cycle`'s three clusters can) names no majority on
 * that input, and when no cluster is alone at the top the probe has not separated them and Jev
 * decides on the perturbation table.
 *
 * Why member votes and not `clusterSupport`: the callers gate this rule on equal support
 * (`seedOnlySplit`), so the near-duplicate worry `clusterSupport` documents (three mutation forms
 * of one wrong boundary at one site) cannot decide anything here, while the 4-vs-1 member count of
 * `stats`'s guard family against the single `values.remove(mid)` mutation — available to the rule
 * that committed the overfit and unused — can.
 */
export function probeMajorityCluster(clusters: readonly BehaviourCluster[], signatures: ReadonlyMap<string, string>): ProbeMajority {
  const outputsOf = new Map<string, string[]>();
  const weightOf = new Map<string, number>();
  for (const c of clusters) {
    weightOf.set(c.id, c.members.length);
    for (const m of c.members) {
      const outs = probeOutputs(signatures.get(m.applied.candidate.id));
      // every member of a cluster shares its behaviour signature: the first one that carries outputs speaks for it
      if (outs !== null) {
        outputsOf.set(c.id, outs);
        break;
      }
    }
  }
  const agreement = new Map<string, number>(clusters.map((c) => [c.id, 0]));
  let differing = 0;
  const width = outputsOf.size < 2 ? 0 : Math.min(...[...outputsOf.values()].map((o) => o.length));
  for (let k = 0; k < width; k++) {
    const votes = new Map<string, number>();
    for (const [id, outs] of outputsOf) {
      const o = outs[k];
      if (o === undefined) continue;
      votes.set(o, (votes.get(o) ?? 0) + (weightOf.get(id) ?? 0));
    }
    // every cluster behaves alike on this input: it separates nothing and is not counted
    if (votes.size < 2) continue;
    differing += 1;
    const top = Math.max(...votes.values());
    if ([...votes.values()].filter((v) => v === top).length > 1) continue;
    for (const [id, outs] of outputsOf) {
      const o = outs[k];
      if (o !== undefined && votes.get(o) === top) agreement.set(id, (agreement.get(id) ?? 0) + 1);
    }
  }
  const scored = [...clusters].sort((a, b) => (agreement.get(b.id) ?? 0) - (agreement.get(a.id) ?? 0));
  const first = scored[0];
  const second = scored[1];
  const best = first === undefined ? 0 : (agreement.get(first.id) ?? 0);
  const runnerUp = second === undefined ? 0 : (agreement.get(second.id) ?? 0);
  return { agreement, differing, winner: first !== undefined && best > 0 && best > runnerUp ? first : null };
}

// ---------------------------------------------------------------------------------------
// Structural rejection of a passer (ranked change 5 of the OOS analysis, its Q6 table)
// ---------------------------------------------------------------------------------------

/**
 * The two shapes a passing candidate is REFUSED for, whatever the rest of the guard would have
 * decided. Both are differences between the patched file's source before and after the patch, so
 * they cost nothing and ask nobody (`decide` runs them before any rule below can pick a candidate);
 * neither has a threshold, and neither knows a task exists.
 *
 * `adds_implicit_none_exit` — the patch opens a path that leaves a function with an implicit
 * `return None` while every other exit of it returns a value. Record `20260922-013715-nlsygcax`:
 * the committed template `guard_empty_break` put `if not hare.successor.successor: break` inside
 * `while True:`, so the loop the pre-patch code could only `return` out of now falls off the end
 * of the function. The guard saw 5 plausible, 3 clusters, arbitrated, `general_cand_01` noul 0.44
 * — ABOVE `SUSPECT_NOUL_MAX` 0.3 — so the all-overfit drop never fired and `probeMajorityCluster`
 * / the Choice argmax committed it.
 *
 * `mutates_new_argument` — the patch makes a function mutate a parameter in place that the
 * pre-patch code left alone, so the caller's object changes. Record `20260922-014311-65ul43qh`:
 * `values.remove(mid)` made `median([])` raise ValueError incidentally (the goal test's
 * `pytest.raises`), broke `median([2, 2])` and mutated the caller's list, where the gold adds
 * `if not values: raise ValueError`. 5 plausible, 2 clusters, arbitrated, no `genuine_fix`
 * request — `probeMajorityCluster`/majority decided it.
 */
export type StructuralRejection = 'adds_implicit_none_exit' | 'mutates_new_argument';

/** What a refusal says in the transcript. */
export const STRUCTURAL_REJECTION_WHY: Readonly<Record<StructuralRejection, string>> = {
  adds_implicit_none_exit: 'adds a path that leaves a function with an implicit `return None`, while every other exit of that function returns a value',
  mutates_new_argument: 'mutates in place a parameter the pre-patch code left alone, so the caller\'s object changes',
};

/**
 * Review finding 2: argument mutation is a SUSPICION, not a refusal.
 *
 * `values.sort(); return values[-1]` and `if k not in d: d[k] = 0` are ordinary in-place APIs;
 * refusing them costs solves on the SWE class, where in-place is often the contract. The two
 * idioms are exempted in `py/structure.ts mutatedParameterDetails`, and what survives that is
 * still only evidence: it never drops a SOLE passer (there is nothing better to fall back to,
 * and `holdBestPartial` would throw the run's only fix away), and with two or more contenders it
 * is handed to the arbitration that already exists (Q15/Q16) as a named signal.
 *
 * The one shape that stays an outright refusal is the one the record shows going wrong, stated
 * structurally: an in-place method on a parameter the function NEVER hands back, in a goal whose
 * tests expect a raise. That is `stats`' `values.remove(mid)` — the mutation is invisible to the
 * function's own result, so no caller could have wanted it, and the `raises` goal is what the
 * candidate satisfied incidentally (analysis Q6 (ii)).
 */
export function raisesGoal(goal: Pick<Goal, 'failures'>): boolean {
  return goal.failures.some((f) => /\braise[sd]?\b|Error\b|Exception\b/.test(`${f.expected} ${f.actual}`));
}

/**
 * The mark `perturb.ts ladderOutputText` writes into a replayed output whose call changed its own
 * arguments — the post-call argument diff the replay harness already runs, reused here rather than
 * re-derived (a unit test asserts the two agree, so the literal cannot drift).
 */
export const ARGS_MUTATED_MARK = '[arguments mutated to ';

/**
 * The statement kinds that own a suite, so introducing one changes the shape `suiteExits` walks
 * (review finding 1). `def` / `class` are absent on purpose: `statementKinds` already excludes
 * nested block bodies, and a patch that adds a helper `def` does not change how its parent exits.
 */
const SUITE_SHAPE_KINDS: ReadonlySet<StatementKind> = new Set(['if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with']);

/** A function's `return` facts, or none when the block is not a `def` of this module. */
function returnsOf(mod: PyModule, block: Block): readonly ReturnFact[] {
  return mod.functions.find((f) => f.blockIndex === block.index)?.returns ?? [];
}

/**
 * Does this function have a None exit — control reaching the end of the body (`fallsOffEnd`) or a
 * bare `return`? `return None` is an exit its author wrote on purpose and counts as a value exit.
 */
function noneExit(mod: PyModule, block: Block): boolean {
  return fallsOffEnd(mod, block) || returnsOf(mod, block).some((r) => r.expr === null);
}

/** Exits of this function that hand a value back. */
function valueExits(mod: PyModule, block: Block): number {
  return returnsOf(mod, block).filter((r) => r.expr !== null).length;
}

/** The `def`s a patch's file has in BOTH revisions, matched by qualified name; a function the patch adds has no pre-patch half and is not compared. */
function functionPairs(before: PyModule, after: PyModule): { before: Block; after: Block }[] {
  const byName = new Map<string, Block>();
  for (const b of before.blocks) {
    if (b.kind !== 'def') continue;
    const name = qualifiedName(before, b);
    if (!byName.has(name)) byName.set(name, b);
  }
  const out: { before: Block; after: Block }[] = [];
  const seen = new Set<string>();
  for (const a of after.blocks) {
    if (a.kind !== 'def') continue;
    const name = qualifiedName(after, a);
    const b = byName.get(name);
    if (b === undefined || seen.has(name)) continue;
    seen.add(name);
    out.push({ before: b, after: a });
  }
  return out;
}

/**
 * One decision's parsed revisions, keyed by source text: every candidate of a batch patches the
 * same base, so the pre-patch analysis is shared instead of repeated per candidate (on a
 * repository-class file that is the difference between one tokenizer pass and one per passer).
 */
export type ParseCache = Map<string, PyModule | null>;

/** `analyse` of a revision, or null when the text does not tokenize (it then says nothing about the candidate). */
function parsed(src: string, cache?: ParseCache): PyModule | null {
  const hit = cache?.get(src);
  if (hit !== undefined) return hit;
  let mod: PyModule | null;
  try {
    mod = analyse(src);
  } catch {
    mod = null;
  }
  cache?.set(src, mod);
  return mod;
}

/**
 * The first structural refusal the patch earns, or null. Reads only `AppliedCandidate.files`
 * (the touched files' text before and after), so it works on every candidate source and needs no
 * run, no probe and no Jev request.
 */
export function structuralRejection(applied: Pick<AppliedCandidate, 'files'>, cache?: ParseCache): StructuralRejection | null {
  for (const f of applied.files) {
    const before = parsed(f.before, cache);
    const after = parsed(f.after, cache);
    if (before === null || after === null) continue;
    for (const p of functionPairs(before, after)) {
      // Review finding 1: the difference argument requires the two revisions to be built from the
      // same constructs. A patch that introduces a COMPOUND statement — one that owns a suite, so
      // it changes the shape the exit analysis walks — is exactly where "unmodelled cancels out"
      // stops being true; wrapping exiting code in `try/except` is a large fraction of real
      // repository fixes. Leaf statements (`break`, `return`, `pass`, an expression) are NOT this:
      // they sit inside a suite the analysis already walks and are precisely what the difference
      // is built to see — `detect_cycle`'s added `break` must still be caught.
      const wasShapes = new Set([...statementKinds(before, p.before)].filter((k) => SUITE_SHAPE_KINDS.has(k)));
      if ([...statementKinds(after, p.after)].some((k) => SUITE_SHAPE_KINDS.has(k) && !wasShapes.has(k))) continue;
      if (!noneExit(before, p.before) && noneExit(after, p.after) && valueExits(after, p.after) > 0) return 'adds_implicit_none_exit';
    }
  }
  return null;
}

/** The parameters a patch newly mutates in place, exemptions already applied (`mutatedParameterDetails`). */
export function newlyMutatedParameters(applied: Pick<AppliedCandidate, 'files'>, cache?: ParseCache): { fn: Block; mod: PyModule; names: string[] }[] {
  const out: { fn: Block; mod: PyModule; names: string[] }[] = [];
  for (const f of applied.files) {
    const before = parsed(f.before, cache);
    const after = parsed(f.after, cache);
    if (before === null || after === null) continue;
    for (const p of functionPairs(before, after)) {
      const was = new Set(mutatedParameters(before, p.before));
      const names = mutatedParameters(after, p.after).filter((n) => !was.has(n));
      if (names.length > 0) out.push({ fn: p.after, mod: after, names });
    }
  }
  return out;
}

/**
 * The narrow refusal of review finding 2: the patch newly mutates a parameter the function never
 * hands back, and the goal's tests expect a raise. Everything else that `newlyMutatedParameters`
 * finds is a suspicion signal, not a refusal.
 */
export function mutationRefused(applied: Pick<AppliedCandidate, 'files'>, goal: Pick<Goal, 'failures'>, cache?: ParseCache): boolean {
  if (!raisesGoal(goal)) return false;
  return newlyMutatedParameters(applied, cache).some(({ fn, mod, names }) => {
    const returned = mod.functions.find((x) => x.blockIndex === fn.index)?.returns ?? [];
    return names.some((n) => !returned.some((r) => r.expr !== null && new RegExp(`^${n}\\s*(?:$|[[.])`).test(r.expr.trim())));
  });
}

/**
 * The runtime half of the argument-mutation rule, for a mutation the token scan cannot see (one
 * through a helper, or a form `mutatedParameters` does not model): the replay harness's own
 * post-call argument diff marked at least one of this candidate's outputs, and NO function of the
 * pre-patch file mutated a parameter at all — so the mutation is the patch's. Free: the signature
 * is the one the probe already produced for clustering.
 */
export function probeArgumentMutation(o: VerifyOutcome, signature: string | undefined, cache?: ParseCache): boolean {
  const outs = probeOutputs(signature);
  if (outs === null || !outs.some((t) => t.includes(ARGS_MUTATED_MARK))) return false;
  return o.applied.files.every((f) => {
    const before = parsed(f.before, cache);
    return before !== null && before.blocks.every((b) => mutatedParameters(before, b).length === 0);
  });
}

/**
 * Guard clauses of one function, memoised per (module, block). Review finding 15: `newlyLateGuards`
 * runs once per contender and `collectGuards` is O(n²) in a suite's length, so an 8-contender
 * decision on a 5,801-line repository module repeated a 59 ms walk eight times. The `ParseCache`
 * already shares the `PyModule`; this shares the clause list keyed off that same object.
 */
const CLAUSE_CACHE = new WeakMap<PyModule, Map<number, readonly GuardClause[]>>();
function clausesOf(mod: PyModule, block: Block): readonly GuardClause[] {
  let byBlock = CLAUSE_CACHE.get(mod);
  if (byBlock === undefined) {
    byBlock = new Map();
    CLAUSE_CACHE.set(mod, byBlock);
  }
  const hit = byBlock.get(block.index);
  if (hit !== undefined) return hit;
  const built = guardClauses(mod, block);
  byBlock.set(block.index, built);
  return built;
}

/**
 * OOS iteration 3, item 1: the guard clauses this patch ADDS that are LATE — placed behind a
 * DEREFERENCE of their own operand that the value they reject would have made fail, with nothing
 * in front binding or narrowing it (`py/structure.ts isLateGuard`).
 *
 * A clause is the patch's when no clause of the same function's pre-patch revision spells the same
 * test, and the two ways of adding one are told apart by the clause's sibling PATH, which a
 * condition rewrite leaves alone and an insertion shifts:
 *
 *   - INSERTED (no pre-patch guard clause at that path): judged on all of its operand paths.
 *   - EDITED (a pre-patch guard clause stands at that path): judged only on the operand paths the
 *     edit ADDED — the position was not the patch's choice.
 *
 * Review finding 1: the rule no longer has a second "hoistable" shape, and the dereference is
 * matched on the exact dotted path, so `self.logger.debug(…)` is not evidence about `self.handler`
 * and `len(xs)` is not evidence about `xs`.
 */
export function newlyLateGuards(applied: Pick<AppliedCandidate, 'files'>, cache?: ParseCache): { path: string; fn: string; guard: GuardClause }[] {
  const out: { path: string; fn: string; guard: GuardClause }[] = [];
  for (const f of applied.files) {
    const before = parsed(f.before, cache);
    const after = parsed(f.after, cache);
    if (before === null || after === null) continue;
    for (const p of functionPairs(before, after)) {
      const wasClauses = clausesOf(before, p.before);
      const wasTests = new Set(wasClauses.map((g) => g.test));
      const atPath = new Map(wasClauses.map((g) => [g.path.join('.'), g] as const));
      for (const g of clausesOf(after, p.after)) {
        if (wasTests.has(g.test)) continue;
        // A clause at the same path in a suite of the same length is the SAME clause with a
        // rewritten condition; anything else (a suite that grew or shrank, a path nothing stood at)
        // is the patch placing a guard where none was, and the whole placement is the patch's.
        const at = atPath.get(g.path.join('.'));
        const stood = at !== undefined && at.siblings === g.siblings ? at : undefined;
        const late = stood === undefined ? isLateGuard(g) : isLateGuard(g, { operands: g.operands.filter((p2) => !stood.operands.includes(p2)) });
        if (late) out.push({ path: f.path, fn: qualifiedName(after, p.after), guard: g });
      }
    }
  }
  return out;
}

/**
 * OOS iteration 4, item B: the guard clauses this patch ADDS that guard a value the function
 * DERIVED from its own parameters, placed behind the code that already used that value
 * (`py/structure.ts guardsDerivedLocal`).
 *
 * This is the property the iteration-3 author's disagreement 1 named and iteration 3 could not
 * express: what separates the three recorded overfits from their golds is DATA FLOW, not
 * position. A function's contract is about its parameters, so a guard on a parameter is a
 * precondition; a guard on a local the function computed for itself, inserted after the first
 * statement that used that local, is a patch for the one path the tests took.
 *
 *   `stats`      gold `if not values:` at the top (the parameter) vs the overfit
 *                `if not ordered:` after `mid = len(ordered) // 2` — `ordered = sorted(values)`.
 *   `detect_cycle` gold adds `hare is None` to the clause at the TOP of the `while` body, where
 *                nothing has read `hare` yet, vs the overfit `if not hare.successor.successor:`
 *                two statements further down, behind `if hare.successor is None:`.
 *
 * The patch's own clauses are told from the pre-patch ones exactly as `newlyLateGuards` tells
 * them: a clause whose `test` no pre-patch clause of the same function spells, judged on all of
 * its operands when it was INSERTED (the sibling path moved or nothing stood there) and on the
 * operands the edit ADDED when a clause stood at the same path in a suite of the same length.
 */
export function newlyDerivedLocalGuards(applied: Pick<AppliedCandidate, 'files'>, cache?: ParseCache): { path: string; fn: string; guard: GuardClause }[] {
  const out: { path: string; fn: string; guard: GuardClause }[] = [];
  for (const f of applied.files) {
    const before = parsed(f.before, cache);
    const after = parsed(f.after, cache);
    if (before === null || after === null) continue;
    for (const p of functionPairs(before, after)) {
      const wasClauses = clausesOf(before, p.before);
      const wasTests = new Set(wasClauses.map((g) => g.test));
      const atPath = new Map(wasClauses.map((g) => [g.path.join('.'), g] as const));
      for (const g of clausesOf(after, p.after)) {
        if (wasTests.has(g.test)) continue;
        const at = atPath.get(g.path.join('.'));
        const stood = at !== undefined && at.siblings === g.siblings ? at : undefined;
        const hit = stood === undefined ? guardsDerivedLocal(after, p.after, g) : guardsDerivedLocal(after, p.after, g, { operands: g.operands.filter((p2) => !stood.operands.includes(p2)) });
        if (hit) out.push({ path: f.path, fn: qualifiedName(after, p.after), guard: g });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Structural suspicion signals (code) on a lone passer
// ---------------------------------------------------------------------------------------

export type SuspicionSignal = 'deletes_statement' | 'duplicates_block' | 'guards_other_variable' | 'dead_guard' | 'adds_special_case' | 'mutates_new_argument' | 'late_guard' | 'guards_derived_local';

// ---------------------------------------------------------------------------------------
// Special-case guards (code metric): the conditionals and literals a candidate adds
// ---------------------------------------------------------------------------------------

/** Keywords that open or extend a condition (a ternary's `if` included; `not` negates and guards nothing). */
const CONDITION_KEYWORDS: ReadonlySet<string> = new Set(['if', 'elif', 'while', 'and', 'or', 'except']);
const LITERAL_NAMES: ReadonlySet<string> = new Set(['None', 'True', 'False']);

export interface SpecialCaseScore {
  /** condition keywords the candidate's lines have beyond the line it replaces */
  conditionals: number;
  /** number, string and None/True/False tokens beyond the replaced line's */
  literals: number;
  total: number;
}

function countSpecialCases(text: string): { conditionals: number; literals: number } {
  let conditionals = 0;
  let literals = 0;
  for (const t of codeTokens(tokenizeFragment(text))) {
    if (t.type === 'NAME' && CONDITION_KEYWORDS.has(t.text)) conditionals += 1;
    else if (t.type === 'NUMBER' || t.type === 'STRING' || (t.type === 'NAME' && LITERAL_NAMES.has(t.text))) literals += 1;
  }
  return { conditionals, literals };
}

/**
 * How many special-case guards a candidate ADDS (the head-to-head's failure class A,
 * llm-jev-headtohead.md §9): condition keywords and literal tokens in its lines beyond those of
 * the line it replaces — counts, not a multiset, so `== 0` → `<= 1` changes a literal and adds
 * none; an insert adds everything it says. The committed overfits all add at least one: `if text:`
 * (a conditional), `return 0` and `subtotal ** 2` (a literal), `if tortoise.successor is None:
 * return False` (one conditional, two literals), `wrap`'s copied loop (a `while` and four
 * literals). The golds beside them added none (`lines.append(text)`, `>=` for `>`, `sum` for
 * `len`) or fewer (`detect_cycle`'s `hare is None or …`: one conditional, one literal).
 */
export function specialCaseScore(c: Candidate): SpecialCaseScore {
  const after = countSpecialCases(candidateLines(c).join('\n'));
  const before = c.site.kind === 'replace' ? countSpecialCases(c.site.currentLine) : { conditionals: 0, literals: 0 };
  const conditionals = Math.max(0, after.conditionals - before.conditionals);
  const literals = Math.max(0, after.literals - before.literals);
  return { conditionals, literals, total: conditionals + literals };
}

/** The candidate's own lines (site text and non-delete extra edits), trimmed, non-empty. */
function candidateLines(c: Candidate): string[] {
  const raw = [...c.text.split('\n'), ...(c.extraEdits ?? []).filter((e) => e.kind !== 'delete').flatMap((e) => (e.text ?? '').split('\n'))];
  return raw.map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
}

/** Code lines of the site's enclosing block (the whole file at module level), with their numbers. */
function functionLines(c: Candidate): { line: number; text: string }[] {
  const mod = c.site.file.mod;
  const start = c.site.block?.startLine ?? 1;
  const end = c.site.block?.endLine ?? mod.lines.length;
  const out: { line: number; text: string }[] = [];
  for (let line = start; line <= end; line++) {
    const text = (mod.lines[line - 1] ?? '').trim();
    if (text !== '' && !text.startsWith('#')) out.push({ line, text });
  }
  return out;
}

const NONE_GUARD = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s+is\s+None\b/g;
const NOT_GUARD = /(?<!\bis\s)\bnot\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\b(?!\s*\()/g;
const CONDITION_HEAD = /^(?:if|elif|while)\b/;

/**
 * `X` of every `X is None` / `not X` in the condition lines of `text`.
 *
 * OOS iteration 4, item C. A subject whose head is a Python KEYWORD is not a subject: `NOT_GUARD`
 * reads the `in` of `nextnode not in ordered_nodes` as the guarded name, and the QuixBugs gold
 * `topological_ordering.py` — whose whole patch is `outgoing_nodes` → `incoming_nodes` inside
 * exactly that condition — then fired `dead_guard`, because nothing in the function
 * "dereferences" a variable called `in`. That is the one false positive the item-C sweep turned
 * up, and it is shown in `test/unit/synth/search/signal-sweeps.test.ts`. `not in` and `is not`
 * are comparison operators; neither guards a value against being absent.
 */
function guardSubjectsIn(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!CONDITION_HEAD.test(t)) continue;
    for (const m of t.matchAll(NONE_GUARD)) out.push(m[1] ?? '');
    for (const m of t.matchAll(NOT_GUARD)) out.push(m[1] ?? '');
  }
  return out.filter((s) => s !== '' && s !== 'None' && s !== 'True' && s !== 'False' && !isKeyword(s.split('.')[0] ?? s));
}

/** Null/empty-guard subjects the candidate ADDS: those of its lines minus those already on the site's current line. */
export function guardSubjects(c: Candidate): string[] {
  const own = guardSubjectsIn(candidateLines(c).join('\n'));
  const before = new Set(c.site.kind === 'replace' ? guardSubjectsIn(c.site.currentLine) : []);
  return [...new Set(own.filter((s) => !before.has(s)))];
}

const NONE_ATTRIBUTE = /'NoneType' object has no attribute '([A-Za-z_]\w*)'/;
const NONE_OPERATION = /'NoneType' object is not (?:subscriptable|iterable|callable)|unsupported operand type\(s\)[^\n]*'NoneType'/;
const TRACE_LINE = /(?:^|\s)([^\s:'"]+\.py):(\d+)(?=:|\s|$)/gm;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The dereference the failing tests crash on: the attribute a `'NoneType' object has no attribute`
 * message names (or a subscript/iteration/call on None), and the root variables dereferenced that
 * way on the traceback line of the site's file (`detect_cycle.py:5: AttributeError` in the test
 * output tail → line 5 `if hare.successor is None:` → `hare`). Null when the failure is not a
 * None dereference or the traceback line is not in the tail.
 */
export function noneDereference(failures: readonly FailureView[], outputTail: string, file: SourceFile): { attr: string | null; receivers: Set<string>; line: number } | null {
  let attr: string | null = null;
  let none = false;
  for (const f of failures) {
    const m = NONE_ATTRIBUTE.exec(f.actual);
    if (m !== null) {
      attr = m[1] ?? null;
      none = true;
      break;
    }
    if (NONE_OPERATION.test(f.actual)) none = true;
  }
  if (!none) return null;
  const base = file.path.split('/').pop() ?? file.path;
  let line: number | null = null;
  for (const m of outputTail.matchAll(TRACE_LINE)) {
    const path = m[1] ?? '';
    if ((path.split('/').pop() ?? path) !== base) continue;
    const n = Number(m[2]);
    if (Number.isInteger(n) && n >= 1 && n <= file.mod.lines.length) line = n;
  }
  if (line === null) return null;
  const text = file.mod.lines[line - 1] ?? '';
  const receivers = new Set<string>();
  if (attr !== null) {
    for (const m of text.matchAll(new RegExp(`([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)\\.${escapeRe(attr)}\\b`, 'g'))) receivers.add((m[1] ?? '').split('.')[0] ?? '');
  } else {
    for (const m of text.matchAll(/([A-Za-z_]\w*)\s*[[(]/g)) receivers.add(m[1] ?? '');
  }
  receivers.delete('');
  return { attr, receivers, line };
}

/** True when the expression `s` is read somewhere in `lines` other than as a bare value: `s.`, `s[`, `s(`, `in s`, passed to a call. */
function isUsed(s: string, lines: readonly string[]): boolean {
  const e = escapeRe(s);
  const patterns = [new RegExp(`(?:^|[^\\w.])${e}\\s*[.[(]`), new RegExp(`\\bin\\s+${e}\\b`), new RegExp(`\\(\\s*${e}\\s*[,)]`), new RegExp(`,\\s*${e}\\s*[,)]`)];
  return lines.some((l) => patterns.some((p) => p.test(l)));
}

/** True when the exact dotted expression `s` occurs anywhere in `lines`, however it is used. */
function occursIn(s: string, lines: readonly string[]): boolean {
  const re = new RegExp(`(?<![\\w.])${escapeRe(s)}(?![\\w.])`);
  return lines.some((l) => re.test(l));
}

/**
 * For the candidate's own file: normalised line → how many MORE times the patch's AFTER image
 * holds it than its BEFORE image did.
 *
 * OOS iteration 4, item C. `duplicates_block` asked only "is this added line, identifiers and
 * literals abstracted, a line the function already has" — which is true of every in-place
 * RENAME, because abstracting the identifiers is exactly what makes the renamed line look like
 * the original. The SWE-bench Verified gold `sympy__sympy-12489` is that patch and nothing else
 * (`_af_new` → `cls._af_new`, `Perm` → `cls`, and a `coerse` → `coerce` typo in a docstring), and
 * it fired. "Duplicates" means the count went UP: `wrap`'s copied loop takes its normalised line
 * from one occurrence to two, while a rename removes one and adds one.
 */
function normalisedLineGrowth(applied: Pick<AppliedCandidate, 'files'>, path: string): Map<string, number> {
  const out = new Map<string, number>();
  const f = applied.files.find((x) => x.path === path);
  if (f === undefined) return out;
  const count = (src: string, sign: number): void => {
    for (const raw of src.split('\n')) {
      const t = raw.trim();
      if (t === '' || t.startsWith('#')) continue;
      const k = normaliseLine(t).join(' ');
      out.set(k, (out.get(k) ?? 0) + sign);
    }
  };
  count(f.after, 1);
  count(f.before, -1);
  return out;
}

/**
 * Code-computed reasons to doubt a lone passer before it is committed (rule (b)); each is a
 * shape the run-3 overfits had and the golds did not:
 *   - `deletes_statement`: an extra edit deletes a line, or the replacement is empty / `pass`;
 *   - `duplicates_block`: ≥ 2 added lines and at least half of them (≥ 2) are, identifiers and
 *     literals abstracted, lines the function already has (`wrap`: the loop copied under itself);
 *   - `guards_other_variable`: the tests crash dereferencing None and the added `X is None` /
 *     `not X` guards name no root variable dereferenced on the traceback line (`detect_cycle`:
 *     `tortoise.successor` guarded, `hare.successor` crashed);
 *   - `dead_guard`: an added guard statement whose subject expression nothing in the function
 *     reads (`tortoise.successor` is never dereferenced, indexed, iterated or passed);
 *   - `adds_special_case`: the edit adds a conditional or a literal over the line it replaces
 *     (`specialCaseScore` > 0: `if x:`, `return 0`, `subtotal ** 2` — the shape of every lone
 *     passer the head-to-head committed as an overfit, llm-jev-headtohead.md §9 class A);
 *   - `mutates_new_argument`: a parameter mutation the exemptions did not excuse (review finding 2);
 *   - `late_guard` (OOS iteration 3, item 1): the patch adds a guard clause BEHIND statements that
 *     already read its operands, or one that could stand at the top of its block unchanged —
 *     `stats`' `if not ordered: raise …` after `mid = len(ordered) // 2`, `token_bucket`'s
 *     `cost > self.capacity` after `if self.tokens >= cost`. Both golds are the same guard at the
 *     top of the block (`py/structure.ts isLateGuard`, `newlyLateGuards` above).
 *   - `guards_derived_local` (OOS iteration 4, item B): the patch guards a value the function
 *     DERIVED from its own parameters, behind the first statement that used that value —
 *     `stats`' `if not ordered:` (`ordered = sorted(values)`) after `mid = len(ordered) // 2`,
 *     `detect_cycle`'s `if not hare.successor.successor:` (`hare = tortoise = node`) behind
 *     `if hare.successor is None:`. Both golds guard a PARAMETER, or add their operand to the
 *     clause at the top of the block where nothing has read it yet
 *     (`py/structure.ts guardsDerivedLocal`, `newlyDerivedLocalGuards` above).
 * The signals trigger a Q16 question; what Jev answers decides the hold (`decide`, rule (b)). On a
 * batch of ≥ 2 passers they travel into the Q15/Q16 state instead (`arbitrationSignals`), and a
 * pool in which EVERY contender carries one is never committed by a code rule (item 2).
 */
export function suspicionSignals(o: VerifyOutcome, goal: Pick<Goal, 'failures'>, cache?: ParseCache): SuspicionSignal[] {
  const c = o.applied.candidate;
  const out: SuspicionSignal[] = [];
  const added = candidateLines(c);
  if ((c.extraEdits ?? []).some((e) => e.kind === 'delete') || (c.site.kind === 'replace' && /^(?:pass)?$/.test(c.text.trim()))) out.push('deletes_statement');

  const fn = functionLines(c).filter((l) => !(c.site.kind === 'replace' && l.line === c.site.line));
  if (added.length >= 2) {
    const norm = new Set(fn.map((l) => normaliseLine(l.text).join(' ')));
    // OOS iteration 4, item C: a copy, not a rename — the patch must RAISE the count of the
    // normalised line, or `sympy__sympy-12489`'s in-place rename reads as a copied block.
    const growth = normalisedLineGrowth(o.applied, c.site.file.path);
    const dup = added.filter((l) => {
      const k = normaliseLine(l).join(' ');
      return norm.has(k) && (growth.get(k) ?? 0) > 0;
    }).length;
    if (dup >= Math.max(2, Math.ceil(added.length / 2))) out.push('duplicates_block');
  }

  const subjects = guardSubjects(c);
  if (subjects.length > 0) {
    const deref = noneDereference(goal.failures, o.job.base.summary.outputTail, c.site.file);
    if (deref !== null && deref.receivers.size > 0 && subjects.every((s) => !deref.receivers.has(s.split('.')[0] ?? s))) out.push('guards_other_variable');
    // an added guard statement (an insert, or a replace that wraps the current line in new lines)
    const addsStatement = c.site.kind === 'insert' || added.length >= 2;
    // OOS iteration 4, item C: "nothing reads it" is evidence only about a value the code HAS.
    // The subject must OCCUR in the pre-patch function and never be dereferenced there — that is
    // `detect_cycle`'s `tortoise.successor` (`tortoise = tortoise.successor`, never dereferenced)
    // and not `sympy__sympy-17139`'s `rv.exp.is_real`, a predicate attribute `_f` never names at
    // all, nor `pytest-dev__pytest-10081`'s `skipped`, a local the patch itself introduces two
    // lines above its own guard. Both were gold fires of the old rule.
    const fnText = fn.map((l) => l.text);
    if (addsStatement && subjects.some((s) => occursIn(s, fnText)) && subjects.every((s) => !isUsed(s, fnText))) out.push('dead_guard');
  }
  if (specialCaseScore(c).total > 0) out.push('adds_special_case');
  // review finding 2: a mutation the exemptions did not excuse is a signal on a lone passer —
  // Q16 decides the hold, and the passer is never simply dropped
  if (newlyMutatedParameters(o.applied, cache).length > 0) out.push('mutates_new_argument');
  // OOS iteration 3, item 1: a guard clause the patch put behind the code it should protect
  if (newlyLateGuards(o.applied, cache).length > 0) out.push('late_guard');
  // OOS iteration 4, item B: a guard on a value the function derived from its own parameters,
  // added behind the first statement that used it — the data-flow shape that separates `stats`
  // and `detect_cycle` from their golds where placement alone does not
  if (newlyDerivedLocalGuards(o.applied, cache).length > 0) out.push('guards_derived_local');
  return out;
}

// ---------------------------------------------------------------------------------------
// Q15 + Q16: one request
// ---------------------------------------------------------------------------------------

/** Measured task text (arbitrate.mts, the `--include-nogold` variant: nothing here knows a gold exists). */
export const ARBITRATE_TASK =
  'The Python function in `program` had a bug. Every entry of `candidates` is a replacement for the line named in its `line` field that makes ALL of the program\'s tests pass. At most one of them is the genuine fix that is correct for every valid input; the others only satisfy the tests. It is possible that none is a genuine fix (for example when the real fix needs a new statement rather than a changed line).';
/** Q15, measured verbatim. */
export const GENUINE_FIX_INSTRUCTIONS =
  'Every option makes all tests pass. Which option is the genuine fix of the defect: the replacement that makes `program` correct for every valid input, not only for `tests`? Read each option literally. Answer carefully and literally.';
export const GENUINE_FIX_ID = 'genuine_fix';
export const GENERAL_PREFIX = 'general_';

/**
 * Q16 criteria — measured wording, with the ONE example pair OOS iteration 3 item 2 added.
 *
 * Why the pair. `20260922-013715-nlsygcax` answered 0.44 on `detect_cycle`'s
 * `if not hare.successor.successor: break`, and the record says why: the `true` side's third
 * example, "a missing guard added exactly where the failing input reaches", READS AS SATISFIED by
 * it — the patch is literally a missing guard being added — while the `false` side had no example
 * of a guard that is added in the wrong PLACE or on the wrong VARIABLE. Both of the shapes the
 * code-computed signals see (`guards_other_variable`, `late_guard`) were therefore unnamed on the
 * side they belong to. The `true` example is kept and made explicit about WHERE the guard goes;
 * the `false` side gains the two counter-examples. Both sides keep ≥ 2 examples
 * (`src/jev/questions.ts` enforces it) and the question still never counts anything.
 *
 * Review finding 4: the `true` example must NOT also require the guard to name the variable the
 * failure names, and the `false` counter-example must not be a name match. `stats`' own gold
 * guards the parameter `values` while the failure is an `IndexError` on the derived local
 * `ordered` (`src/stats.py:22`, `ordered[mid - 1]`); a name match marks that gold DOWN, and
 * guarding the parameter while the traceback names a derived local is the majority shape. The
 * counter-example is therefore about the DATA PATH from the failing input to the failure — which
 * `values → ordered` is on and `detect_cycle`'s `tortoise.successor` is not.
 *
 * Review findings 8 and 13: the signals are NOT shown to Jev. The 0.3 / 0.7 bounds were
 * calibrated on a signal-free state and the recorded 0.44 / 0.49 / 0.39 answers were measured on
 * one, so a state that names a candidate's suspicious properties would depress the very Noul
 * those bounds gate on (and an annotation present on some options and absent on others reads as
 * "not computed" rather than "clean"). The signals stay code-side: they decide whether the code
 * ranking rules are skipped and which bound applies, never what Jev is told.
 */
export const GENERAL_CRITERIA: NoulCriteriaSpec = {
  true: {
    definition: 'The replacement repairs the actual defect; the algorithm is now correct in general and the change is the minimal one a maintainer would write.',
    examples: [
      'an off-by-one bound corrected so every element is visited',
      'swapped arguments restored to the order the algorithm requires',
      'a missing guard added in front of the code that uses the value',
    ],
  },
  false: {
    definition:
      'The replacement makes the listed tests pass by coincidence: it special-cases the tested inputs, changes an unrelated part of the line, removes functionality the tests do not exercise, is a boundary the tests cannot distinguish, or puts a guard somewhere only the tested path reaches.',
    examples: [
      'a condition that happens to hold for the tested inputs only',
      'deleting a branch no test reaches',
      'returning a constant that matches the tested cases',
      'a guard added after the statements that already use the value it guards, so the earlier uses stay unprotected',
      'a guard on a variable that is not on the path from the failing input to the failure',
    ],
  },
};

/** What a code-computed suspicion signal says, in the words the Q15/Q16 state shows Jev. */
export const SUSPICION_SIGNAL_WHY: Readonly<Record<SuspicionSignal, string>> = {
  deletes_statement: 'deletes a statement the program had',
  duplicates_block: 'repeats lines the function already contains',
  guards_other_variable: 'guards a variable the failing traceback never dereferences',
  dead_guard: 'guards an expression nothing else in the function reads',
  adds_special_case: 'adds a conditional or a literal beyond the line it replaces',
  mutates_new_argument: 'mutates in place a parameter the pre-patch code left alone',
  late_guard: 'adds a guard behind statements that already use the value it guards, where the same guard could have stood at the top of the block',
  guards_derived_local: 'guards a value the function computed from its own arguments, added behind the first statement that used that value, rather than guarding the argument itself',
};

export function generalInstructions(key: string): string {
  return `Is \`candidates.${key}\` a correct general fix: with this replacement, does \`program\` compute the right result for every valid input, not just for the listed \`tests\`?`;
}

export interface ArbitrateContext {
  goal: Goal;
  /** default 'propose' so the rows land in decisions.jsonl with the synthesizer's other questions */
  stage?: StageName;
}

export interface Representative {
  key: string;
  outcome: VerifyOutcome;
  cluster: BehaviourCluster;
}

export interface ArbitrationResult extends Arbitration {
  representatives: Representative[];
  state: Json;
  /**
   * Per representative key: did Jev actually return a Noul for it? `noul` maps a missing or
   * wrong-shaped answer to 0, which a caller cannot tell from a confident "no" — and review
   * finding 11 is precisely a caller that refused a whole pool on that 0.
   */
  noulAnswered: Record<string, boolean>;
}

/**
 * Who gets asked about (§2.6): one representative per cluster (smallest edit) when clusters
 * disagree, ≤ MAX_REPRESENTATIVES; when there is a single cluster of ≥ 2 passers its
 * ≤ SINGLE_CLUSTER_MAX_MEMBERS smallest-edit members, so an all-overfit set is still caught.
 */
export function representativesOf(clusters: readonly BehaviourCluster[]): Representative[] {
  const picked: { outcome: VerifyOutcome; cluster: BehaviourCluster }[] = [];
  if (clusters.length === 1) {
    const only = clusters[0];
    if (only !== undefined) for (const m of only.members.slice(0, SINGLE_CLUSTER_MAX_MEMBERS)) picked.push({ outcome: m, cluster: only });
  } else {
    for (const c of clusters.slice(0, MAX_REPRESENTATIVES)) picked.push({ outcome: c.representative, cluster: c });
  }
  return picked.map((p, i) => ({ key: `cand_${String(i + 1).padStart(2, '0')}`, ...p }));
}

function lineKeyOf(line: number): string {
  return `L${line}`;
}

/** The outermost def/class containing `line` (a nested function's fix is judged with its enclosing function, as the measured state showed the whole program). */
function outermostBlock(file: SourceFile, line: number): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  for (const b of file.mod.blocks) {
    if (b.startLine > line || line > b.endLine) continue;
    if (best === null || b.startLine < best.start || (b.startLine === best.start && b.endLine > best.end)) best = { start: b.startLine, end: b.endLine };
  }
  return best;
}

/**
 * `program` for the Q15 state: every code line of the file when it fits PROGRAM_LINES_MAX (the
 * measured shape: the whole QuixBugs program), otherwise the outermost functions enclosing the
 * edited lines (module-level code when an edit sits outside every def), cut at the cap.
 */
function listing(file: SourceFile, siteLines: readonly number[]): { [k: string]: Json } {
  const seen = new Set<number>();
  const out: { [k: string]: Json } = {};
  let lines = codeLines(file.mod, 1, file.mod.lines.length);
  if (lines.length > PROGRAM_LINES_MAX) {
    const ranges = siteLines.map((l) => outermostBlock(file, l)).filter((r): r is { start: number; end: number } => r !== null);
    lines = ranges.length === 0 ? moduleCodeLines(file.mod) : ranges.flatMap((r) => codeLines(file.mod, r.start, r.end));
  }
  for (const l of lines.sort((a, b) => a.line - b.line)) {
    if (seen.has(l.line) || seen.size >= PROGRAM_LINES_MAX) continue;
    seen.add(l.line);
    out[lineKeyOf(l.line)] = l.text;
  }
  return out;
}

function testsJson(failures: readonly FailureView[]): Json[] {
  return failures.slice(0, TESTS_IN_STATE).map((f) => ({ input: f.call, expected: f.expected }));
}

function candidateJson(c: Candidate, primaryPath: string): Json {
  const entry: { [k: string]: Json } = { line: lineKeyOf(c.site.line), replaces: c.site.kind === 'replace' ? c.site.currentLine.trim() : null, with: c.text.trim() };
  if (c.site.kind === 'insert') entry['position'] = `inserted before ${lineKeyOf(c.site.line)}`;
  if (c.site.file.path !== primaryPath) entry['file'] = c.site.file.path;
  if (c.extraEdits !== undefined && c.extraEdits.length > 0) entry['also_edits'] = c.extraEdits.map((e) => ({ line: lineKeyOf(e.line), kind: e.kind, text: (e.text ?? '').trim() }));
  return entry;
}

function optionDescription(c: Candidate): string {
  return c.site.kind === 'replace' ? `${lineKeyOf(c.site.line)}: ${c.text.trim()}` : `insert before ${lineKeyOf(c.site.line)}: ${c.text.trim()}`;
}

/**
 * The measured state: `{ task, program, tests, buggy_program_failure, candidates }`, verbatim.
 *
 * Review findings 8 and 13: it carries NO code signals. The lone-passer bounds were calibrated on
 * this state and `adviseLonePasser` asks on this state, so the pool path must gate on a Noul
 * measured on the same one.
 */
export function arbitrateState(ctx: ArbitrateContext, reps: readonly Representative[]): { [k: string]: Json } {
  const files = new Map<string, { file: SourceFile; lines: number[]; n: number }>();
  for (const r of reps) {
    const site = r.outcome.applied.candidate.site;
    const entry = files.get(site.file.path) ?? { file: site.file, lines: [], n: 0 };
    entry.n++;
    entry.lines.push(site.line);
    files.set(site.file.path, entry);
  }
  // The program listing is the file most representatives edit; other files are listed beside it.
  const ordered = [...files.values()].sort((a, b) => b.n - a.n || a.file.path.localeCompare(b.file.path));
  const primary = ordered[0];
  if (primary === undefined) throw new GuardError('arbitrateState needs at least one representative');
  const state: { [k: string]: Json } = {
    task: ARBITRATE_TASK,
    program: listing(primary.file, primary.lines),
    tests: testsJson(ctx.goal.failures),
    buggy_program_failure: null,
  };
  const first = ctx.goal.failures[0];
  if (first !== undefined) state['buggy_program_failure'] = { input: first.call, expected: first.expected, actual: first.actual };
  if (ordered.length > 1) {
    const others: { [k: string]: Json } = {};
    for (const o of ordered.slice(1)) others[o.file.path] = listing(o.file, o.lines);
    state['other_files'] = others;
  }
  const candidates: { [k: string]: Json } = {};
  for (const r of reps) candidates[r.key] = candidateJson(r.outcome.applied.candidate, primary.file.path);
  state['candidates'] = candidates;
  return state;
}

/** One row of the perturbation table Jev sees with Q15: an input on which the representatives' outputs differ. */
export interface PerturbationRow {
  /** the call text, the expressions, or the JSON arguments (`describeInput`) */
  input: string;
  /** the perturbation that produced it */
  how: string;
  /** representative key → its output on this input */
  outputs: Record<string, string>;
}

/**
 * The inputs on which ≥ 2 representatives' probe outputs differ, each one's output beside it
 * (repr() or the exception class; `[arguments mutated to …]` when a call changed its input), in
 * input order, ≤ PERTURBATION_ROWS_MAX. Only `outputs:` signatures (`createLaneProbe`,
 * `createLadderProbe`) carry per-input outputs; a P2P-only or foreign signature contributes
 * nothing, and fewer than two representatives with outputs give no table.
 */
export function perturbationTable(reps: readonly Representative[], inputs: readonly PerturbedInput[], signatures: ReadonlyMap<string, string>): PerturbationRow[] {
  const outputsOf = new Map<string, string[]>();
  for (const r of reps) {
    const outs = probeOutputs(signatures.get(r.outcome.applied.candidate.id));
    if (outs !== null) outputsOf.set(r.key, outs);
  }
  if (outputsOf.size < 2) return [];
  const rows: PerturbationRow[] = [];
  inputs.forEach((p, k) => {
    if (rows.length >= PERTURBATION_ROWS_MAX) return;
    const outputs: Record<string, string> = {};
    const distinct = new Set<string>();
    for (const [key, outs] of outputsOf) {
      const o = outs[k];
      if (o === undefined) continue;
      outputs[key] = o.length > PERTURBATION_OUTPUT_MAX ? `${o.slice(0, PERTURBATION_OUTPUT_MAX - 1)}…` : o;
      distinct.add(o);
    }
    if (distinct.size >= 2) rows.push({ input: describeInput(p), how: p.how, outputs });
  });
  return rows;
}

export interface ArbitrateExtras {
  /** the perturbation table (`perturbationTable`), shown to Jev as `perturbations` when non-empty */
  perturbations?: readonly PerturbationRow[];
}

/**
 * Q15 + Q16 in one request over the representatives of `clusters`. Returns the Choice argmax as
 * `pick` after the §5.4 override rule, the suspect flag, and the other representatives as
 * fallbacks ordered by Choice probability. With `extras.perturbations` the measured state gains
 * the table and its note, so Jev judges on which inputs the options differ and what each returns,
 * not on the diffs alone. Throws GuardError when Jev's answer shape is wrong.
 */
export async function arbitrate(ctx: ArbitrateContext, clusters: readonly BehaviourCluster[], ask: JevAsk, extras: ArbitrateExtras = {}): Promise<ArbitrationResult> {
  const reps = representativesOf(clusters);
  if (reps.length < 2) throw new GuardError(`arbitrate needs at least two representatives, got ${reps.length}`);
  const state = arbitrateState(ctx, reps);
  if (extras.perturbations !== undefined && extras.perturbations.length > 0) {
    state['perturbations_note'] = PERTURBATION_NOTE;
    state['perturbations'] = extras.perturbations.map((r): Json => ({ input: r.input, how: r.how, outputs: { ...r.outputs } }));
  }
  const options: Record<string, Json | null> = {};
  for (const r of reps) options[r.key] = optionDescription(r.outcome.applied.candidate);
  const questions = { [GENUINE_FIX_ID]: choice(GENUINE_FIX_INSTRUCTIONS, options) };
  const withNouls: Record<string, ReturnType<typeof noul>> = { ...questions };
  for (const r of reps) withNouls[`${GENERAL_PREFIX}${r.key}`] = noul(generalInstructions(r.key), GENERAL_CRITERIA);

  const res = await ask(ctx.stage ?? 'propose', state, withNouls);
  const answer = res.answers[GENUINE_FIX_ID];
  if (answer === undefined || answer.type !== 'choice') throw new GuardError(`${GENUINE_FIX_ID} answer missing or not a choice`);
  const pChoice: Record<string, number> = {};
  const nouls: Record<string, number> = {};
  const noulAnswered: Record<string, boolean> = {};
  for (const r of reps) {
    pChoice[r.key] = answer.probabilities[r.key] ?? 0;
    const n = res.answers[`${GENERAL_PREFIX}${r.key}`];
    noulAnswered[r.key] = n !== undefined && n.type === 'noul';
    nouls[r.key] = n !== undefined && n.type === 'noul' ? n.noul : 0;
  }
  const pEscape = answer.probabilities[ESCAPE_KEY] ?? 0;
  const maxNoul = Math.max(...reps.map((r) => nouls[r.key] ?? 0));
  const suspect = pEscape >= SUSPECT_ESCAPE_MIN && maxNoul < SUSPECT_NOUL_MAX;

  // Choice argmax (ties → the LLM member, then the smaller edit; §6.2), then the override rule.
  const byChoice = [...reps].sort((a, b) => (pChoice[b.key] ?? 0) - (pChoice[a.key] ?? 0) || llmFirst(a.outcome, b.outcome) || byEditCost(a.outcome, b.outcome));
  let pick = byChoice[0];
  if (pick === undefined) throw new GuardError('no representative to pick');
  if ((nouls[pick.key] ?? 0) < OVERRIDE_LOW) {
    const confident = reps.filter((r) => (nouls[r.key] ?? 0) >= OVERRIDE_HIGH).sort((a, b) => (nouls[b.key] ?? 0) - (nouls[a.key] ?? 0) || byEditCost(a.outcome, b.outcome));
    const c = confident[0];
    if (c !== undefined) pick = c;
  }
  const chosen = pick;
  const fallbacks = byChoice.filter((r) => r.key !== chosen.key).map((r) => r.outcome);
  return { pick: chosen.outcome, fallbacks, pChoice, pEscape, noul: nouls, suspect, requests: 1, representatives: reps, state, noulAnswered };
}

/** The one-candidate key of the Q16 advisory (rule (b)): the same state shape as an arbitration over one representative. */
export const LONE_PASSER_KEY = 'cand_01';

/**
 * Rule (b)'s advisory: Q16 `general_cand_01` alone (no Choice: one option is not a choice) over the
 * arbitration state of the lone passer. Returns Jev's p, or null when the answer is not a Noul.
 */
export async function adviseLonePasser(ctx: ArbitrateContext, o: VerifyOutcome, ask: JevAsk): Promise<{ p: number | null; requests: number; state: Json }> {
  const reps = representativesOf(clusterByBehaviour([o]));
  const state = arbitrateState(ctx, reps);
  const id = `${GENERAL_PREFIX}${LONE_PASSER_KEY}`;
  const res = await ask(ctx.stage ?? 'propose', state, { [id]: noul(generalInstructions(LONE_PASSER_KEY), GENERAL_CRITERIA) });
  const a = res.answers[id];
  return { p: a !== undefined && a.type === 'noul' ? a.noul : null, requests: 1, state };
}

// ---------------------------------------------------------------------------------------
// decide (§2.6 pseudo-code, with the two within-step holds)
// ---------------------------------------------------------------------------------------

export type HoldKind = 'pending' | 'suspect';

/** The code rule that decided a commit without a Jev request (rule (2) and DESIGN §22.5), when one did. */
export type CodeRule = 'llm_in_cluster' | 'majority_cluster' | 'probe_majority' | 'fewest_special_cases';

/** The bookkeeping every guard decision carries beside the Decision itself. */
export interface GuardFields {
  /** plausible candidates in THIS batch (held ones are not counted again) */
  plausible: number;
  clusters: number;
  arbitrated: boolean;
  requests: number;
  /** other arbitrated (or code-ranked) representatives, for later steps if the judge rejects the pick */
  fallbacks: VerifyOutcome[];
  /** the behaviour probe failed and clustering fell back to the P2P vectors (message), else null */
  probeError: string | null;
  /** a lone passer is being held (rule (a) `pending`, rule (b) `suspect`) after this decision */
  held: HoldKind | null;
  /** the structural signals computed on a fresh lone passer this decision */
  signals: SuspicionSignal[];
  /** passers dropped by the all-overfit signature this decision (they stay in `tried`; none is ever committed) */
  dropped: number;
  /** passers refused by a structural rule this decision (`structuralRejection`; no Jev request, none is ever committed). Optional so hand-built fields need not state it; `decide` always does. */
  structuralDrops?: number;
  /** the code rule that committed without Jev, if any */
  codeRule: CodeRule | null;
}

export type GuardDecision = Decision & GuardFields;

/** What a hold reads from the step budget (search/types.ts StepBudget). */
export type HoldBudget = Pick<StepBudget, 'exhausted' | 'testWallLeftMs' | 'testRunsLeft' | 'jevRequestsLeft'>;

export interface DecideOptions {
  /** stage of the Q15/Q16 requests (default 'propose') */
  stage?: StageName;
  /** e.g. "the Python function `gcd`" for the arbitration state */
  subject?: string;
  /** for `perturbedInputs` and the SIEVE hold; absent → P2P vectors only, no hold */
  oracle?: OracleModel;
  /** runs the behaviour probe on the lanes; absent → P2P vectors only */
  probe?: BehaviourProbe;
  /** extra probe inputs beyond the goal's calls (test-file-derived or harvested, perturb.ts), fetched only when ≥ 2 passers need them */
  inputs?: (plausible: readonly VerifyOutcome[]) => Promise<readonly PerturbedInput[]>;
  /** cap of the probe's input set (default MAX_PERTURBED_INPUTS; the ladder harvest allows LADDER_MAX_PROBE_INPUTS) */
  inputsMax?: number;
  /** the step budget; a hold is started or kept only inside HOLD_RESERVE_* (absent → no budget limit, as in unit tests) */
  budget?: HoldBudget;
  /** transcript note (`synth` event) for holds and releases */
  note?: (detail: string) => void;
}

/**
 * Plausible in the design's sense (§2.6): every test of the GOAL passes in the goal-subset run and
 * in the full-suite regression run, which exists, finished, and shows nothing newly failing. The
 * check is goal-relative on purpose: on a multi-goal task (ladder, 2–3 independent hunks) the
 * other goals' tests still fail after a genuine fix of this one, and the ledger commits one
 * verified sub-goal per step. The runner's status is trusted but re-checked, so a passer whose
 * regression run was skipped is never committed as plausible.
 */
export function isPlausible(o: VerifyOutcome, goal: Pick<Goal, 'tests'>): boolean {
  if (o.status !== 'plausible') return false;
  if (o.full === undefined || o.full.timedOut || o.subset.timedOut || o.progress.regressed) return false;
  for (const run of [o.subset, o.full]) {
    if (run.total === 0) return false;
    // nothing passed, or an error the base did not have (a collection error names the module in
    // `failing`, never a goal test): the goal's tests did not run, let alone pass
    if (run.passed === 0 || run.errors > o.progress.before.errors) return false;
    const failing = new Set(run.failing);
    if (failing.has(RUN_FAILURE_ID) || goal.tests.some((t) => failing.has(t))) return false;
    // with passing ids (pytest -rA) a goal test that vanished from the run is not a pass
    if (run.passing.length > 0) {
      const passing = new Set(run.passing);
      if (goal.tests.some((t) => !passing.has(t))) return false;
    }
  }
  return true;
}

/**
 * Tests are the oracle before Jev is: among plausible candidates, only those whose full-suite run
 * passes the most tests stay in contention. A goal is one failing-test cluster, and on pytest
 * workspaces the clusters are one test each (tracebacks show only test frames, goals.ts), so a
 * candidate that special-cases the attacked test is "plausible" for it while the genuine fix also
 * turns its sibling tests green (the ladder's two tests per hunk, bench/data/ladder/README.md);
 * the sibling count separates them at no Jev cost. Ties (the common case) go on to clustering
 * and Q15/Q16 as before.
 */
export function mostPassing(plausible: readonly VerifyOutcome[]): VerifyOutcome[] {
  let best = -1;
  for (const o of plausible) best = Math.max(best, o.full?.passed ?? o.subset.passed);
  return plausible.filter((o) => (o.full?.passed ?? o.subset.passed) === best);
}

/** A commit is always a patch of the committed workspace, whichever base the candidate ran on. */
function commit(mem: GuardMemory, o: VerifyOutcome, extra: GuardFields & { note?: 'possible overfit' }): GuardDecision {
  return { kind: 'commit', applied: appliedOnCommitted(mem, o), allGoalTestsPass: true, outcome: o, ...extra, clusters: Math.max(1, extra.clusters) };
}

/** The passers held for `goal` (rule (a) pending, rule (b) suspect), pending first. */
function heldPassers(mem: GuardMemory, goal: Pick<Goal, 'id'>): VerifyOutcome[] {
  const st = guardState(mem);
  const out: VerifyOutcome[] = [];
  if (st.pending !== null && st.pending.goalId === goal.id) out.push(st.pending.outcome);
  if (st.suspect !== null && st.suspect.goalId === goal.id && !out.includes(st.suspect.outcome)) out.push(st.suspect.outcome);
  return out;
}

function clearHeld(mem: GuardMemory, goal: Pick<Goal, 'id'>): void {
  const st = guardState(mem);
  if (st.pending !== null && st.pending.goalId === goal.id) st.pending = null;
  if (st.suspect !== null && st.suspect.goalId === goal.id) st.suspect = null;
}

function dedupeById(outcomes: readonly VerifyOutcome[]): VerifyOutcome[] {
  const seen = new Set<string>();
  const out: VerifyOutcome[] = [];
  for (const o of outcomes) {
    const id = o.applied.candidate.id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(o);
  }
  return out;
}

/** The step can still afford to keep a passer waiting (see HOLD_RESERVE_*); no budget → yes. */
export function budgetAllowsHold(budget: HoldBudget | undefined): boolean {
  if (budget === undefined) return true;
  return !budget.exhausted() && budget.testWallLeftMs >= HOLD_RESERVE_WALL_MS && budget.testRunsLeft >= HOLD_RESERVE_RUNS && budget.jevRequestsLeft >= 1;
}

/**
 * Rule (a): does the batch that just ran tell us the pending passer's site batch is over? A batch
 * from another site or from composite (which only runs after the seed sources) says yes; a batch
 * at the same site says yes when no seed source other than its own is left to run there (the
 * controller marks a source exhausted after its batch, so the batch's own source is counted as
 * done). An empty batch (every job deferred) says nothing.
 */
export function siteBatchDone(goal: Pick<Goal, 'exhausted'>, results: readonly VerifyOutcome[], pendingSiteKey: string): boolean {
  const first = results[0]?.job.candidate;
  if (first === undefined) return false;
  if (first.source === 'composite' || siteKeyOf(first) !== pendingSiteKey) return true;
  const exhausted = goal.exhausted.get(pendingSiteKey) ?? new Set<CandidateSourceName>();
  return SITE_BATCH_SOURCES.every((s) => s === first.source || exhausted.has(s));
}

/**
 * Rule (a) applies to a fresh lone passer when the tests are the ranker (SIEVE: t_run within
 * budget.SIEVE_MAX_T_RUN_MS) in a seed phase and another seed source is still to run at its site.
 */
export function sieveHoldApplies(goal: Pick<Goal, 'phase' | 'exhausted'>, o: VerifyOutcome, oracle: OracleModel | undefined): boolean {
  if (oracle === undefined || oracle.tRunMs.goalSubset > SIEVE_MAX_T_RUN_MS) return false;
  if (goal.phase !== 'SEEDS' && goal.phase !== 'WIDENED') return false;
  const c = o.applied.candidate;
  if (!SITE_BATCH_SOURCES.includes(c.source)) return false;
  const exhausted = goal.exhausted.get(siteKeyOf(c)) ?? new Set<CandidateSourceName>();
  return SITE_BATCH_SOURCES.some((s) => s !== c.source && !exhausted.has(s));
}

/** Probe inputs for the goal: its calls' perturbations plus the test-file-derived (or harvested) ones, deduplicated and bounded. */
async function probeInputs(goal: Goal, opts: DecideOptions, plausible: readonly VerifyOutcome[]): Promise<PerturbedInput[]> {
  if (opts.oracle === undefined) return [];
  const max = opts.inputsMax ?? MAX_PERTURBED_INPUTS;
  const out: PerturbedInput[] = [];
  const seen = new Set<string>();
  const add = (list: readonly PerturbedInput[]): void => {
    for (const p of list) {
      if (out.length >= max) return;
      const k = inputKey(p);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  };
  add(perturbedInputs(goal, opts.oracle));
  if (opts.inputs !== undefined) add(await opts.inputs(plausible));
  return out;
}

function describe(o: VerifyOutcome): string {
  const c = o.applied.candidate;
  return `${c.source}/${c.op} at ${siteKeyOf(c)}`;
}

/**
 * Rule (3) of the head-to-head fix: a held passer Jev confidently doubted (Q16 `general` below
 * LONE_PASSER_HOLD_MAX_NOUL) is never released — not by the budget reserve, not by `commitSuspect`
 * at step end. The step ends on its honest partial or parks; the passer stays in `tried`.
 * `shipping` (llm-jev-headtohead.md §5.2): `subtotal ** 2` was committed with 14 s of test wall
 * left, inside the reserve, with no advisory asked.
 */
export function unreleasable(h: Pick<HeldPasser, 'noul'>): boolean {
  return h.noul !== undefined && h.noul < LONE_PASSER_HOLD_MAX_NOUL;
}

function supportSummary(clusters: readonly BehaviourCluster[]): string {
  return clusters.map((c) => `${c.id} ${c.members.length} member${c.members.length === 1 ? '' : 's'}/support ${clusterSupport(c)}`).join(', ');
}

function scoreSummary(reps: readonly VerifyOutcome[]): string {
  return reps
    .map((r) => {
      const s = specialCaseScore(r.applied.candidate);
      return `${describe(r)} +${s.conditionals}c/+${s.literals}l`;
    })
    .join('; ');
}

/**
 * The decision on one run batch. Nothing here writes to the workspace: regressed, unchanged and
 * timed-out candidates are simply dropped (they are already in `tried`). Passers held from
 * earlier batches of the goal join this batch's before anything is decided.
 */
export async function decide(results: readonly VerifyOutcome[], mem: GuardMemory, goal: Goal, ask: JevAsk, opts: DecideOptions = {}): Promise<GuardDecision> {
  const st = guardState(mem);
  const note = opts.note ?? ((): void => undefined);
  // Ranked change 5 of the OOS analysis (its Q6 table): a passer with one of the two structural
  // defects is refused HERE, before any rule below can pick it — the two committed overfits of Q6
  // were decided by rules (`probeMajorityCluster`, the Choice argmax) that never saw the defect,
  // and the all-overfit drop could not fire at noul 0.44. Costs no Jev request and no run.
  const refused = new Map<string, StructuralRejection>();
  const parseCache: ParseCache = new Map();
  const admissible = (o: VerifyOutcome): boolean => {
    // Review finding 2: argument mutation no longer refuses on its own. Only the none-exit rule
    // and the narrow `stats` shape (an in-place method on a parameter the function never returns,
    // in a goal whose tests expect a raise) drop a candidate here; every other mutation becomes
    // the `mutates_new_argument` suspicion signal below, which never drops a SOLE passer.
    const why = structuralRejection(o.applied, parseCache) ?? (mutationRefused(o.applied, goal, parseCache) ? 'mutates_new_argument' : null);
    if (why === null) return true;
    refused.set(o.applied.candidate.id, why);
    return false;
  };
  const fresh = mostPassing(results.filter((o) => isPlausible(o, goal)).filter(admissible));
  const partial = results.filter((o) => !isPlausible(o, goal) && isPartial(o));
  const carried = heldPassers(mem, goal).filter(admissible);
  // a held passer this rule refuses is dropped with its hold, so no step-end `commitSuspect` revives it
  if (st.pending !== null && st.pending.goalId === goal.id && refused.has(st.pending.outcome.applied.candidate.id)) st.pending = null;
  if (st.suspect !== null && st.suspect.goalId === goal.id && refused.has(st.suspect.outcome.applied.candidate.id)) st.suspect = null;
  for (const [id, why] of refused) note(`${goal.id}: refuses the passing candidate ${id} — it ${STRUCTURAL_REJECTION_WHY[why]} (structural rule, no Jev request); it stays in tried and the search goes on`);
  const plausible = mostPassing(dedupeById([...carried, ...fresh]));
  const base = { plausible: fresh.length, clusters: 0, arbitrated: false, requests: 0, fallbacks: [] as VerifyOutcome[], probeError: null as string | null, held: null as HoldKind | null, signals: [] as SuspicionSignal[], dropped: 0, structuralDrops: refused.size, codeRule: null as CodeRule | null };

  if (plausible.length === 0) {
    // Code only: strictly more passed wins, ties by the bases.ts tie-break rule (no Jev request).
    holdBestPartial(mem, partial, goal);
    return { kind: 'continue', ...base };
  }

  const only = plausible[0];
  if (plausible.length === 1 && only !== undefined) {
    const budgetOk = budgetAllowsHold(opts.budget);
    // A held passer, still alone: keep it, or release it when the step cannot afford more — unless
    // Jev confidently doubted it (rule (3), `unreleasable`): that hold outlasts the reserve, and
    // `commitSuspect` drops it at step end.
    if (st.suspect !== null && st.suspect.goalId === goal.id && st.suspect.outcome === only) {
      if (!budgetOk && !unreleasable(st.suspect)) {
        clearHeld(mem, goal);
        note(`${goal.id}: releases the held suspect ${describe(only)} (budget reserve); committing as possible overfit`);
        return commit(mem, only, { ...base, note: 'possible overfit' });
      }
      if (!budgetOk) note(`${goal.id}: the budget reserve is spent but the held suspect ${describe(only)} (general ${st.suspect.noul?.toFixed(2) ?? 'n/a'} < ${LONE_PASSER_HOLD_MAX_NOUL}) is not released; the step ends on its partial or parks`);
      return { kind: 'continue', ...base, held: 'suspect' };
    }
    if (st.pending !== null && st.pending.goalId === goal.id && st.pending.outcome === only) {
      const siteKey = st.pending.siteKey;
      const done = siteBatchDone(goal, results, siteKey);
      if (done || !budgetOk) {
        clearHeld(mem, goal);
        note(`${goal.id}: site batch ${siteKey} ${done ? 'complete' : 'cut by the budget reserve'}; committing its lone passer ${describe(only)}`);
        return commit(mem, only, base);
      }
      return { kind: 'continue', ...base, held: 'pending' };
    }
    // A fresh lone passer (a held one with fewer passing tests, if any, is dropped by mostPassing).
    clearHeld(mem, goal);
    const signals = suspicionSignals(only, goal);
    let requests = 0;
    let doubted = false;
    // The advisory is asked whenever a request is left, reserve or not: `shipping`'s `** 2` was
    // committed unasked inside the reserve. A confidently doubted passer holds without a release
    // (rule (3)); a doubted one with strong signals holds as before while the step can afford it.
    const canAsk = opts.budget === undefined || opts.budget.jevRequestsLeft >= 1;
    if (signals.length > 0 && canAsk) {
      const arbCtx: ArbitrateContext = { goal };
      if (opts.stage !== undefined) arbCtx.stage = opts.stage;
      const adv = await adviseLonePasser(arbCtx, only, ask);
      requests += adv.requests;
      const bound = signals.length >= STRONG_SIGNALS_MIN ? LONE_PASSER_VOUCH_MIN_NOUL : LONE_PASSER_HOLD_MAX_NOUL;
      if (adv.p !== null && adv.p < LONE_PASSER_HOLD_MAX_NOUL) {
        const held: HeldPasser = { goalId: goal.id, outcome: only, phase: goal.phase, signals, noul: adv.p };
        st.suspect = held;
        note(`${goal.id}: holds the lone passer ${describe(only)} as suspect (${signals.join(', ')}; general ${adv.p.toFixed(2)} < ${LONE_PASSER_HOLD_MAX_NOUL}): never released on the budget reserve — the step ends on its partial or parks unless a later passer wins`);
        return { kind: 'continue', ...base, requests, signals, held: 'suspect' };
      }
      if (adv.p !== null && adv.p < bound) {
        doubted = true;
        if (budgetOk) {
          const held: HeldPasser = { goalId: goal.id, outcome: only, phase: goal.phase, signals, noul: adv.p };
          st.suspect = held;
          note(`${goal.id}: holds the lone passer ${describe(only)} as suspect (${signals.join(', ')}; general ${adv.p.toFixed(2)} < ${bound}); searching on through the step's remaining sources and sites`);
          return { kind: 'continue', ...base, requests, signals, held: 'suspect' };
        }
        note(`${goal.id}: lone passer ${describe(only)} looks ${signals.join(', ')} and general ${adv.p.toFixed(2)} < ${bound}, but the budget reserve is spent; committing as possible overfit`);
      } else note(`${goal.id}: lone passer ${describe(only)} looks ${signals.join(', ')} but general ${adv.p === null ? 'n/a' : adv.p.toFixed(2)} ≥ ${bound} keeps it`);
    } else if (signals.length > 0) note(`${goal.id}: lone passer ${describe(only)} looks ${signals.join(', ')} and no Jev request is left to ask about it; committing it`);
    if (doubted) return commit(mem, only, { ...base, requests, signals, note: 'possible overfit' });
    if (budgetOk && sieveHoldApplies(goal, only, opts.oracle)) {
      st.pending = { goalId: goal.id, outcome: only, siteKey: siteKeyOf(only.applied.candidate), phase: goal.phase };
      note(`${goal.id}: holds the lone passer ${describe(only)} until its site's seed sources ran`);
      return { kind: 'continue', ...base, requests, signals, held: 'pending' };
    }
    return commit(mem, only, { ...base, requests, signals });
  }

  // ≥ 2 passers (this batch's and the held ones). The probe is best effort: a lane or interpreter
  // failure must not abort a step that has test-passing candidates, so it degrades to the P2P
  // vectors (the design's pytest behaviour).
  let signatures: ReadonlyMap<string, string> = new Map();
  let probeError: string | null = null;
  let inputs: readonly PerturbedInput[] = [];
  if (opts.probe !== undefined && opts.oracle !== undefined) {
    try {
      inputs = await probeInputs(goal, opts, plausible);
      if (inputs.length > 0) signatures = await opts.probe(plausible, inputs);
    } catch (e) {
      probeError = e instanceof Error ? e.message : String(e);
    }
  }
  // The runtime half of the argument-mutation rule (ranked change 5): the replay harness already
  // diffed each call's arguments after it ran (`perturb.ts ladderOutputText`), so a passer whose own
  // signature carries that mark while the pre-patch file mutated no parameter is refused here, at
  // the cost of reading a signature the clustering needed anyway.
  const mutators = plausible.filter((o) => probeArgumentMutation(o, signatures.get(o.applied.candidate.id), parseCache));
  // Review finding 2, runtime half: a replayed call that changed its own arguments refuses the
  // candidate only in the narrow `raises`-goal shape; otherwise it is evidence that demotes it
  // among its peers. And it NEVER empties the field: if refusing would leave no contender, the
  // refusals are withdrawn and the candidates go to arbitration carrying the signal instead.
  const runtimeRefused = mutators.filter((o) => mutationRefused(o.applied, goal, parseCache));
  const dropped = runtimeRefused.length < plausible.length ? runtimeRefused : [];
  for (const o of dropped) {
    refused.set(o.applied.candidate.id, 'mutates_new_argument');
    note(`${goal.id}: refuses the passing candidate ${describe(o)} — its replayed calls ${STRUCTURAL_REJECTION_WHY.mutates_new_argument}, on a parameter it never returns, for a goal whose tests expect a raise (the probe's own post-call argument diff, no Jev request)`);
  }
  const contenders = dropped.length === 0 ? plausible : plausible.filter((o) => !refused.has(o.applied.candidate.id));
  // the surviving mutators keep the signal; `arbitrationSignals` hands it to Q15/Q16 below
  const mutationSuspects = new Set(mutators.filter((o) => !refused.has(o.applied.candidate.id)).map((o) => o.applied.candidate.id));
  for (const o of contenders) if (mutationSuspects.has(o.applied.candidate.id)) note(`${goal.id}: ${describe(o)} mutates an argument the pre-patch code left alone — recorded as a suspicion signal for the arbitration, not a refusal (review finding 2)`);
  base.structuralDrops = refused.size;
  if (contenders.length === 0) {
    clearHeld(mem, goal);
    holdBestPartial(mem, partial, goal);
    return { kind: 'continue', ...base, probeError };
  }
  // OOS iteration 3, item 2 (`arbitrationSignals`): until now the code-computed signals existed
  // only on the lone-passer path — the moment a second passer arrived they were thrown away, and
  // nothing downstream recomputed them. `20260922-013715-nlsygcax` is exactly that hole: the held
  // suspect carried `duplicates_block, guards_other_variable, dead_guard, adds_special_case` at
  // general 0.44, a fifth passer arrived, and `fewestSpecialCases` then committed a DIFFERENT
  // guard insert ("+1c/+0l") by code, with no Jev request and no signal in sight. Every contender
  // of that batch was a guard inserted at L9/L10 while the gold replaces L4 — a GOLD-FREE POOL —
  // and the code rules can only rank suspects against each other there.
  const arbitrationSignals = new Map<string, SuspicionSignal[]>();
  for (const o of contenders) {
    const found = suspicionSignals(o, goal, parseCache);
    if (mutationSuspects.has(o.applied.candidate.id) && !found.includes('mutates_new_argument')) found.push('mutates_new_argument');
    arbitrationSignals.set(o.applied.candidate.id, found);
  }
  /** Every contender carries a SHAPE signal: no code rule may commit, and the pick must be vouched for. */
  const poolSuspect = contenders.every((o) => (arbitrationSignals.get(o.applied.candidate.id) ?? []).some((s) => POOL_SUSPECT_SIGNALS.has(s)));
  const clusters = clusterByBehaviour(contenders, signatures);
  const probeNote = opts.probe === undefined ? 'no probe' : `probe ${inputs.length} inputs, ${signatures.size}/${plausible.length} signatures${probeError === null ? '' : `, error: ${probeError}`}`;
  const common = { ...base, plausible: fresh.length, clusters: clusters.length, probeError };
  const single = clusters.length === 1 ? clusters[0] : undefined;
  if (single !== undefined && mixedSourceCluster(single)) {
    // docs/LLM-JEV-DESIGN.md §6.2: a seed and an LLM candidate that pass the same tests and behave alike — the LLM
    // candidate is committed by code rule (the correctness witness among test-equivalent passers); no Jev request
    clearHeld(mem, goal);
    const pick = single.representative;
    note(`${goal.id}: ${contenders.length} passers in one behaviour cluster with a code seed and an LLM candidate (${probeNote}); committing the LLM member ${describe(pick)} by the preferLlmInCluster rule (no arbitration)`);
    return commit(mem, pick, { ...common, clusters: 1, fallbacks: single.members.filter((m) => m !== pick), codeRule: 'llm_in_cluster' });
  }
  // OOS iteration 3, item 2: the pool has no structurally clean candidate. `preferLlmInCluster`
  // above still stands — an LLM candidate that behaves exactly like a code seed is an independent
  // correctness witness, not a ranking — but the three RANKING rules below would be ranking
  // suspects against each other, so the batch goes to Q15/Q16 instead.
  //
  // Review finding 6: only when there is a request to spend. The lone-passer advisory is gated on
  // `jevRequestsLeft` and this was not, so a step that had exhausted its Jev budget either
  // overspent it or threw out of `decide` where it used to commit by code with `requests: 0`.
  const canAskPool = opts.budget === undefined || opts.budget.jevRequestsLeft >= 1;
  const poolAsk = poolSuspect && canAskPool;
  if (poolSuspect) {
    const why = contenders.map((o) => `${describe(o)}: ${(arbitrationSignals.get(o.applied.candidate.id) ?? []).join('/')}`).join('; ');
    note(
      poolAsk
        ? `${goal.id}: every one of the ${contenders.length} passers carries a swept code signal (${why}); the code ranking rules cannot separate a gold-free pool, so this batch is arbitrated`
        : `${goal.id}: every one of the ${contenders.length} passers carries a swept code signal (${why}) but no Jev request is left to arbitrate them; the code ranking rules decide as before`,
    );
  }
  /**
   * The three code RANKING rules of rule (2), as one call so the pool path can both skip them and
   * come back to them when Jev declined to answer (review finding 11). Returns null when none of
   * them decides; every branch is exactly what it was before this iteration.
   */
  const byCodeRules = (basis: GuardFields): GuardDecision | null => {
    if (clusters.length < 2) return null;
    const majority = majorityCluster(clusters);
    if (majority !== null) {
      clearHeld(mem, goal);
      const pick = majority.representative;
      const fallbacks = clusters.filter((c) => c !== majority).map((c) => c.representative);
      guardState(mem).fallbacks = { goalId: goal.id, outcomes: fallbacks };
      note(`${goal.id}: ${contenders.length} passers (${carried.length} held) in ${clusters.length} behaviour clusters (${probeNote}; ${supportSummary(clusters)}); ${majority.id} holds the majority of the independent support; committing its representative ${describe(pick)} by code (no arbitration)`);
      return commit(mem, pick, { ...basis, fallbacks, codeRule: 'majority_cluster' });
    }
    const reps = clusters.map((c) => c.representative);
    const split = `${goal.id}: ${contenders.length} passers (${carried.length} held) in ${clusters.length} behaviour clusters (${probeNote}; ${supportSummary(clusters)}); the clusters split`;
    if (seedOnlySplit(clusters)) {
      // Class A′ (llm-jev-headtohead-v2.md §8.2, §9): no cluster holds an LLM member and every cluster
      // carries the same independent support, so the special-case count is not evidence — it committed
      // `stats` and `detect_cycle` as overfits. The probe's majority decides; when it separates none of
      // them Q15/Q16 does, with the perturbation table, and the all-overfit signature still drops the set.
      const maj = probeMajorityCluster(clusters, signatures);
      const agreement = clusters.map((c) => `${c.id} ${maj.agreement.get(c.id) ?? 0}/${maj.differing}`).join(', ');
      if (maj.winner !== null) {
        const winner = maj.winner;
        clearHeld(mem, goal);
        const pick = winner.representative;
        const fallbacks = clusters.filter((c) => c !== winner).map((c) => c.representative);
        guardState(mem).fallbacks = { goalId: goal.id, outcomes: fallbacks };
        note(`${split} with no LLM member and equal support; committing ${describe(pick)} — ${winner.id} agrees with the passers' majority on the perturbed inputs (${agreement}; ${scoreSummary(reps)}) by code (no arbitration)`);
        return commit(mem, pick, { ...basis, fallbacks, codeRule: 'probe_majority' });
      }
      note(`${split} with no LLM member and equal support, and the probe separates none of them (${maj.differing} differing input${maj.differing === 1 ? '' : 's'}; ${agreement}); the special-case count does not decide here (${scoreSummary(reps)}) — arbitrating`);
    } else {
      const fewest = fewestSpecialCases(reps);
      if (fewest !== null) {
        clearHeld(mem, goal);
        const fallbacks = reps.filter((r) => r !== fewest).sort((a, b) => specialCaseScore(a.applied.candidate).total - specialCaseScore(b.applied.candidate).total || byEditCost(a, b));
        guardState(mem).fallbacks = { goalId: goal.id, outcomes: fallbacks };
        note(`${split}; committing ${describe(fewest)} with the fewest added special-case guards (${scoreSummary(reps)}) by code (no arbitration)`);
        return commit(mem, fewest, { ...basis, fallbacks, codeRule: 'fewest_special_cases' });
      }
    }
    return null;
  };
  if (!poolAsk) {
    const byCode = byCodeRules(common);
    if (byCode !== null) return byCode;
  }
  // The residual: a single all-seed cluster of ≥ 2, or split clusters whose representatives tie on
  // the code metric. One Q15 + Q16 request, with the perturbation table in the state.
  const arbCtx: ArbitrateContext = { goal };
  if (opts.stage !== undefined) arbCtx.stage = opts.stage;
  const table = perturbationTable(representativesOf(clusters), inputs, signatures);
  const extras: ArbitrateExtras = {};
  if (table.length > 0) extras.perturbations = table;
  const arb = await arbitrate(arbCtx, clusters, ask, extras);
  const arbitrated = { ...common, arbitrated: true, requests: arb.requests };
  note(`${goal.id}: arbitrated ${contenders.length} passers (${carried.length} held) in ${clusters.length} cluster${clusters.length === 1 ? '' : 's'} (${probeNote}${table.length > 0 ? `, ${table.length} differing input${table.length === 1 ? '' : 's'} shown` : ''}); escape ${arb.pEscape.toFixed(2)}, max general ${Math.max(...Object.values(arb.noul)).toFixed(2)}; ${arb.suspect ? 'all-overfit signature' : `pick ${describe(arb.pick)}`}`);

  if (!arb.suspect && poolAsk) {
    // OOS iteration 3, item 2, as the review re-specified it. The pool held no structurally clean
    // candidate, so the pick faces exactly the rule a LONE passer with the same signals faces
    // (rule (b)) — and, review finding 2, exactly the same DISPOSITION: it is HELD as the
    // `suspect`, so the budget-reserve release and step-end `commitSuspect` apply to it just as
    // they do on the lone path. The previous `dropped` was strictly harsher than the rule it
    // claimed to copy: the same `stats` candidate at 0.49 was held-then-committed alone and
    // killed outright in a pool of two.
    const picked = arb.representatives.find((r) => r.outcome === arb.pick);
    const pickSignals = arbitrationSignals.get(arb.pick.applied.candidate.id) ?? [];
    // review finding 9: only a SWEPT signal raises the bound. `adds_special_case` rides on every
    // inserted guard, so counting every signal made `>= STRONG_SIGNALS_MIN` true for essentially
    // every guard pool and the 0.3 branch dead.
    const strong = pickSignals.filter((x) => POOL_SUSPECT_SIGNALS.has(x));
    const bound = strong.length >= STRONG_SIGNALS_MIN ? LONE_PASSER_VOUCH_MIN_NOUL : LONE_PASSER_HOLD_MAX_NOUL;
    const answered = picked !== undefined && (arb.noulAnswered[picked.key] ?? false);
    const p = picked === undefined ? 0 : (arb.noul[picked.key] ?? 0);
    if (!answered) {
      // review finding 11: a Jev that escaped the Noul, or answered the wrong shape, is not
      // evidence against the pool. `arbitrate` maps such an answer to 0, which would have refused
      // every contender; the code rules decide instead, exactly as they did before this iteration.
      note(`${goal.id}: every passer is structurally suspect but Jev returned no Noul for the pick ${describe(arb.pick)}; the code ranking rules decide (no refusal on a missing answer)`);
      const byCode = byCodeRules(arbitrated);
      if (byCode !== null) return byCode;
    } else if (p < bound) {
      const budgetOk = budgetAllowsHold(opts.budget);
      const held: HeldPasser = { goalId: goal.id, outcome: arb.pick, phase: goal.phase, signals: pickSignals, noul: p };
      if (budgetOk || unreleasable(held)) {
        clearHeld(mem, goal);
        guardState(mem).suspect = held;
        note(`${goal.id}: every passer is structurally suspect and the pick ${describe(arb.pick)} (${pickSignals.join(', ')}) answered general ${p.toFixed(2)} < ${bound}; holding it as suspect (released on the budget reserve or at step end exactly as a lone passer is), searching on`);
        return { kind: 'continue', ...arbitrated, signals: pickSignals, held: 'suspect' };
      }
      note(`${goal.id}: every passer is structurally suspect and the pick ${describe(arb.pick)} answered general ${p.toFixed(2)} < ${bound}, but the budget reserve is spent; committing as possible overfit`);
      clearHeld(mem, goal);
      guardState(mem).fallbacks = { goalId: goal.id, outcomes: arb.fallbacks };
      return commit(mem, arb.pick, { ...arbitrated, signals: pickSignals, fallbacks: arb.fallbacks, note: 'possible overfit' });
    } else {
      note(`${goal.id}: every passer is structurally suspect but the pick ${describe(arb.pick)} (${pickSignals.join(', ')}) is vouched for at general ${p.toFixed(2)} ≥ ${bound}; committing it`);
    }
  }
  if (arb.suspect) {
    // Rule (1): every passer looks like an overfit (P(escape) ≥ SUSPECT_ESCAPE_MIN, max general <
    // SUSPECT_NOUL_MAX). None is committed — not now, not on the reserve, not at step end: the set
    // is dropped (its diffs are in `tried`), a held passer among it goes too, and the search runs
    // on with the batch's best partial held for the step's honest progress commit.
    clearHeld(mem, goal);
    holdBestPartial(mem, partial, goal);
    note(`${goal.id}: all-overfit signature (escape ${arb.pEscape.toFixed(2)} ≥ ${SUSPECT_ESCAPE_MIN}, max general ${Math.max(...Object.values(arb.noul)).toFixed(2)} < ${SUSPECT_NOUL_MAX}); dropping the ${contenders.length} passer${contenders.length === 1 ? '' : 's'} (kept in tried, none is committed); searching on${partial.length > 0 ? ` with the batch's best partial held` : ''}`);
    return { kind: 'continue', ...arbitrated, dropped: contenders.length };
  }
  clearHeld(mem, goal);
  guardState(mem).fallbacks = { goalId: goal.id, outcomes: arb.fallbacks };
  return commit(mem, arb.pick, { ...arbitrated, fallbacks: arb.fallbacks });
}

/**
 * Step-end rule (§2.3): a passer held for `goal` is still proposed — rule (a)'s pending passer as
 * a plain commit, rule (b)'s vouch-bound suspect marked `possible overfit` — EXCEPT a suspect Jev
 * confidently doubted (`unreleasable`, rule (3) of the head-to-head fix): that one is dropped and
 * null is returned, so the caller ends the step on its honest partial or parks (subgoal.ts
 * exitOnBudget / step end, index.ts). Clears the hold so the next step starts clean; another
 * goal's hold is left alone (and null is returned). Without `goal` any held passer is decided
 * (callers that search one goal per step should pass it so a parked goal's flagged passer never
 * surfaces under a later goal).
 */
export function commitSuspect(mem: GuardMemory, goal?: Pick<Goal, 'id'>): Decision | null {
  const st = guardState(mem);
  const p = st.pending;
  if (p !== null && (goal === undefined || p.goalId === goal.id)) {
    st.pending = null;
    if (st.suspect !== null && st.suspect.goalId === p.goalId) st.suspect = null;
    return { kind: 'commit', applied: appliedOnCommitted(mem, p.outcome), allGoalTestsPass: true, outcome: p.outcome };
  }
  const s = st.suspect;
  if (s === null || (goal !== undefined && s.goalId !== goal.id)) return null;
  st.suspect = null;
  if (unreleasable(s)) return null;
  return { kind: 'commit', applied: appliedOnCommitted(mem, s.outcome), allGoalTestsPass: true, note: 'possible overfit', outcome: s.outcome };
}

// ---------------------------------------------------------------------------------------
// The gate on a progress commit: the held partial at a budget exit or at exhaustion
// ---------------------------------------------------------------------------------------

export type PartialVerdict = 'clean' | 'vouched' | 'held' | 'no_request';

export interface PartialGate {
  /** the progress commit, or null when the partial stays held (doubtful, or no request left to ask) */
  decision: Decision | null;
  requests: number;
  signals: SuspicionSignal[];
  /** Jev's Q16 `general` p on the partial when asked (this step or an earlier one), else null */
  noul: number | null;
  verdict: PartialVerdict;
}

function rememberAdvice(mem: GuardMemory, id: string, advice: PartialAdvice): void {
  const st = guardState(mem);
  st.partialAdvice.set(id, advice);
  while (st.partialAdvice.size > MAX_PARTIALS_REMEMBERED) {
    const oldest = st.partialAdvice.keys().next().value;
    if (oldest === undefined) break;
    st.partialAdvice.delete(oldest);
  }
}

/**
 * The guard on a progress commit (subgoal.ts commitProgress), exactly rule (b) on a lone passer:
 * the code-computed suspicion signals on `verified` — the held partial with its full-suite
 * regression run attached — and, when any fires, ONE Q16 advisory over the same one-candidate
 * arbitration state. No signal → commit. Signals → held below LONE_PASSER_HOLD_MAX_NOUL (one
 * signal) or LONE_PASSER_VOUCH_MIN_NOUL (two or more), committed at or above. The advisory is
 * cached per candidate in the guard state: a partial that stays the incumbent across steps is
 * asked about once, and one Jev rated doubtful stays held without another request. A flagged
 * partial the step cannot ask about (no Jev request left) is held as well and asked next step —
 * unlike a lone passer, a partial closes no goal, so a step's wait withholds nothing the tests
 * decided. Held means: the base stays in the beam (a strictly better partial may replace it, a
 * later batch may still pass every goal test) and the controller's budget/park bookkeeping
 * applies as before; an all-signals doubtful partial is never committed.
 */
export async function gateHeldPartial(mem: GuardMemory, goal: Goal, verified: VerifyOutcome, ask: JevAsk, opts: { budget?: Pick<HoldBudget, 'jevRequestsLeft'>; stage?: StageName; note?: (detail: string) => void } = {}): Promise<PartialGate> {
  const st = guardState(mem);
  const note = opts.note ?? ((): void => undefined);
  const signals = suspicionSignals(verified, goal);
  const after = outcomeSummary(verified);
  const id = verified.applied.candidate.id;
  if (signals.length === 0) return { decision: commitPartial(mem, goal, { outcome: verified, after }), requests: 0, signals, noul: null, verdict: 'clean' };

  let advice = st.partialAdvice.get(id);
  let requests = 0;
  if (advice === undefined || advice.noul === null) {
    const canAsk = opts.budget === undefined || opts.budget.jevRequestsLeft >= 1;
    if (!canAsk) {
      note(`${goal.id}: the held partial ${describe(verified)} looks ${signals.join(', ')} and no Jev request is left to ask about it; held until the next step`);
      return { decision: null, requests, signals, noul: null, verdict: 'no_request' };
    }
    const arbCtx: ArbitrateContext = { goal };
    if (opts.stage !== undefined) arbCtx.stage = opts.stage;
    const adv = await adviseLonePasser(arbCtx, verified, ask);
    requests += adv.requests;
    advice = { goalId: goal.id, signals: [...signals], noul: adv.p };
    rememberAdvice(mem, id, advice);
  }
  const bound = signals.length >= STRONG_SIGNALS_MIN ? LONE_PASSER_VOUCH_MIN_NOUL : LONE_PASSER_HOLD_MAX_NOUL;
  const p = advice.noul;
  if (p !== null && p >= bound) {
    note(`${goal.id}: the held partial ${describe(verified)} looks ${signals.join(', ')} but general ${p.toFixed(2)} ≥ ${bound} keeps it; committing it as a partial fix`);
    return { decision: commitPartial(mem, goal, { outcome: verified, after }), requests, signals, noul: p, verdict: 'vouched' };
  }
  note(`${goal.id}: holds the partial ${describe(verified)} (${signals.join(', ')}; general ${p === null ? 'n/a' : p.toFixed(2)} < ${bound}); not committed`);
  return { decision: null, requests, signals, noul: p, verdict: 'held' };
}

// ---------------------------------------------------------------------------------------
// Adapter for the sub-goal controller (search/subgoal.ts SubGoalDeps.guard)
// ---------------------------------------------------------------------------------------

/**
 * What the adapter reads from the run's SearchMemory (memory.ts, sieve/runner.ts RunnerMemory):
 * `oracle` selects the runner for perturbed inputs, `stepBudget` bounds the holds, `lanes` (the
 * runner's pool, present once a batch ran) executes the behaviour probe.
 */
export interface SearchMemoryLike extends GuardMemory {
  oracle?: OracleModel;
  stepBudget?: StepBudget;
  lanes?: LanePool;
}

const PROBE_INPUTS = new WeakMap<GuardMemory, Map<string, PerturbedInput[]>>();

/** Read a workspace file through the engine's Workspace; null when unreadable, absent or truncated. */
async function readWorkspaceFile(ctx: Pick<SynthesisContext, 'workspace'>, path: string): Promise<string | null> {
  try {
    const view = await ctx.workspace.read(path, TEST_SOURCE_MAX_BYTES);
    return view.truncatedBytes > 0 ? null : view.content;
  } catch {
    return null;
  }
}

/**
 * The test-file-derived probe inputs of a goal (perturb.ts `perturbedInputsFor`), read through the
 * workspace once per goal and memory (the tests never change during a run).
 */
async function testDerivedInputs(ctx: Pick<SynthesisContext, 'workspace'>, mem: SearchMemoryLike, goal: Goal, program: string): Promise<PerturbedInput[]> {
  let cache = PROBE_INPUTS.get(mem);
  if (cache === undefined) {
    cache = new Map();
    PROBE_INPUTS.set(mem, cache);
  }
  const hit = cache.get(goal.id);
  if (hit !== undefined) return hit;
  const files = committedBase(mem).files;
  const sources = await readTestSources((path) => readWorkspaceFile(ctx, path), goal, program);
  const inputs = perturbedInputsFor(goal, mem.oracle ?? { runner: 'other' }, program, files, sources);
  cache.set(goal.id, inputs);
  return inputs;
}

/**
 * The harvested test calls of a ladder-class goal (perturb.ts `harvestLadderInputs`), run once per
 * goal and memory on a lane holding the committed tree; a harvest that gives no protocol line is
 * remembered as empty (the probe then degrades to the P2P vectors for the run). `plausible` only
 * lends the lane API a candidate to name.
 */
async function harvestedInputs(ctx: SynthesisContext, mem: SearchMemoryLike, pool: LanePool, goal: Goal, layout: LadderLayout, plausible: readonly VerifyOutcome[]): Promise<PerturbedInput[]> {
  let cache = PROBE_INPUTS.get(mem);
  if (cache === undefined) {
    cache = new Map();
    PROBE_INPUTS.set(mem, cache);
  }
  const hit = cache.get(goal.id);
  if (hit !== undefined) return hit;
  const sample = plausible[0]?.applied;
  if (sample === undefined) return [];
  const harvest = await harvestLadderInputs(ctx, pool, committedBase(mem).files, sample, layout);
  const inputs = harvest?.inputs ?? [];
  cache.set(goal.id, inputs);
  const errors = harvest === null ? '' : Object.entries(harvest.importErrors).map(([m, e]) => `${m}: ${e}`).join(', ');
  ctx.emit({ type: 'synth', step: ctx.step, phase: 'guard', detail: harvest === null ? `${goal.id}: the test-call harvest on ${layout.modules.join(', ')} gave no protocol line; clustering on the P2P vectors` : `${goal.id}: harvested ${harvest.recorded} test calls over ${harvest.functions} functions of ${layout.modules.join(', ')} (${layout.testModules.join(', ')}); ${inputs.length} perturbed inputs for the probe${errors === '' ? '' : `; import errors: ${errors}`}` });
  return inputs;
}

/**
 * `decide` in the controller's argument order, with `ctx.ask` as the Jev, `mem.oracle` as the
 * oracle and `mem.stepBudget` as the hold bound. On a QuixBugs-layout workspace (a test module
 * `tests/<name>_test.py` or `tests/test_<name>.py` beside `<name>.py`, `programNameOf`) whose
 * lanes exist, the behaviour probe runs on them (perturb.ts `createLaneProbe`) with the goal's
 * calls, its JSON cases and the linked lists its test module builds as inputs. On a ladder-class
 * layout (`src/<module>.py` + `tests/test_*.py`, `ladderLayoutOf`) the probe replays the
 * harvested test calls and their perturbations (`createLadderProbe`, `harvestLadderInputs`). The
 * gate is the layout, not `oracle.runner`: the bench's QuixBugs workspaces are pytest modules and
 * `fitOracle` labels them `pytest`. Elsewhere (repositories, or a `probe` given here) candidates
 * cluster on their P2P vectors, which is the design's pytest behaviour and still arbitrates a
 * single cluster of ≥ 2.
 */
export function createDecide(opts: { probe?: BehaviourProbe; stage?: StageName } = {}): (ctx: SynthesisContext, mem: SearchMemoryLike, goal: Goal, results: readonly VerifyOutcome[]) => Promise<Decision> {
  return (ctx, mem, goal, results) => {
    const o: DecideOptions = { stage: opts.stage ?? 'propose', note: (detail) => ctx.emit({ type: 'synth', step: ctx.step, phase: 'guard', detail }) };
    if (mem.oracle !== undefined) o.oracle = mem.oracle;
    if (mem.stepBudget !== undefined) o.budget = mem.stepBudget;
    if (opts.probe !== undefined) o.probe = opts.probe;
    else if (mem.oracle !== undefined && mem.lanes !== undefined) {
      const lanes = mem.lanes;
      const files = committedBase(mem).files;
      const program = programNameOf(goal, files);
      if (program !== null) {
        const perInput = Math.min(mem.oracle.perTestTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS);
        o.probe = createLaneProbe(ctx, lanes, program, perInput);
        o.inputs = () => testDerivedInputs(ctx, mem, goal, program);
      } else {
        const layout = ladderLayoutOf(goal, files);
        if (layout !== null) {
          o.probe = createLadderProbe(ctx, lanes);
          o.inputs = (plausible) => harvestedInputs(ctx, mem, lanes, goal, layout, plausible);
          o.inputsMax = LADDER_MAX_PROBE_INPUTS;
        }
      }
    }
    return decide(results, mem, goal, ctx.ask, o);
  };
}

/** The default adapter (lane probe on QuixBugs oracles, P2P-vector clustering elsewhere). */
export const decideForSearch = createDecide();
