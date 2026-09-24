/**
 * Ranking the surviving split options (docs/ORCHESTRATION-DESIGN.md §3.5), and the landing order (§5.2/§5.5).
 *
 * THE INVARIANT OF THIS MODULE, and the one M2 asserts: **when only `no_split` survives, no Jev request is
 * made at all.** `deps.ask` is not merely ignored, it is never reached: the check is the first statement of
 * `rankSplits`, before the state is built and before the questions are built. That is O1(a). The unit test
 * binds an `ask` that fails the test when invoked. The check counts RANKABLE options — those with a Choice
 * option key — not array length, because a list holding only a `no_split`-kind split would otherwise build
 * an empty Choice and throw (review 2026-09-22 finding 11).
 *
 * The second invariant: this module RETURNS ON EVERY PATH. A decider error, a timeout, a 401, a below-floor
 * Noul, the escape, `jev-off`, `--split=auto` — each has a code answer, none throws, and none opens a
 * `jev-unreachable` pane (CD §11 row 33: coordination-class calls never open a pane).
 */
import { clip } from '../../core/text.js';
import { AGENT_TASK_CHARS, OWN_GLOBS_MAX } from '../../core/limits.js';
import { annotateChoiceRows, resolveChoice, type ChoiceResolution } from '../../jev-modes/stages/choose.js';
import { disjoint, parseOwnGlob, validateOwnList, type OwnGlob } from './globs.js';
import { hasDependencyCycle, mergeAgentFields } from './normalize.js';
import { SPLIT_ESCAPE, SPLIT_KIND_OF, WHICH_SPLIT, buildDecomposeState, optionKeyOf, planDecomposeQuestions, selfContainedId } from './questions.js';
import type { Answer, Decision } from '../../core/types.js';
import type { AgentSpec, AskFn, NormalizedSplit, RankedSplit, RejectedOption, SplitPolicy } from '../types.js';

export interface RankInput {
  task: string;
  remaining: readonly string[];
  unverified: readonly string[];
  directories: readonly string[];
  failingTests: readonly string[];
  verification: readonly string[];
  /** the survivors of normalisation, EXCLUDING `no_split`; in `enumerate.ts`'s fixed order */
  options: readonly NormalizedSplit[];
  rejected: readonly RejectedOption[];
  policy: SplitPolicy;
  /** §3.5's deterministic path: `split: 'auto'` takes the first option in enumerate order and asks nothing */
  auto: boolean;
  /**
   * §3.4 rule 2's deny list (`.git`, submodules, `secretPaths`) and the volume's case folding — the
   * SAME values `normalizeSplit` was given. The drop rule merges `own` sets after normalisation has
   * finished, so without them the merge is the one widening path with nothing downstream to catch it
   * (re-review R1).
   */
  deny: readonly string[];
  fold: boolean;
}

/** What `applyDropRule` needs from §3.4 to re-validate a merge it performed. */
export interface DropContext {
  deny: readonly string[];
  fold: boolean;
}

/** §3.5: `no_split` is the fallback of every path, and it is what this builds. */
function noSplit(verdict: RankedSplit['verdict'], askedJev: boolean, rejected: readonly RejectedOption[]): RankedSplit {
  return { split: null, splitKind: 'no_split', verdict, probability: 0, confidence: 0, rejected: [...rejected], askedJev };
}

function loser(o: NormalizedSplit, reason: string, probability: number | null): RejectedOption {
  return { kind: o.kind, reason, probability };
}

function noulOf(answers: Record<string, Answer>, id: string): number | null {
  const a = answers[id];
  return a !== undefined && a.type === 'noul' ? a.noul : null;
}

function probabilitiesOf(answers: Record<string, Answer>): Readonly<Record<string, number>> {
  const a = answers[WHICH_SPLIT];
  return a !== undefined && a.type === 'choice' ? a.probabilities : {};
}

// ---------------------------------------------------------------------------------------
// §3.5 corner row 7 — the drop rule
// ---------------------------------------------------------------------------------------

function parseOwn(own: readonly string[]): OwnGlob[] {
  const out: OwnGlob[] = [];
  for (const raw of own) {
    const p = parseOwnGlob(raw);
    if (p.ok) out.push(p.glob);
  }
  return out;
}

function sharedSegments(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n += 1;
  return n;
}

/** The surviving agent owning the nearest directory: the longest shared path prefix of the two `own` lists. */
function nearestAgent(dropped: AgentSpec, survivors: readonly AgentSpec[]): number {
  const mine = parseOwn(dropped.own);
  let best = -1;
  let bestScore = -1;
  for (const [i, s] of survivors.entries()) {
    let score = 0;
    for (const a of mine) for (const b of parseOwn(s.own)) score = Math.max(score, sharedSegments(a.dir, b.dir));
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Merge a dropped agent into its nearest neighbour, through the ONE `mergeAgentFields` that rule 7's
 * clamp also uses (review 2026-09-22 finding 10: two merges had drifted apart, and this was the only
 * one that unioned `verify`). `AgentSpec` carries no `items`, so the task text is what moves.
 *
 * Finding 9 lives in the shared function: a `research` receiver absorbing a `code` agent is promoted
 * to `code` and gets its branch back, because a `research` agent has `branch: null` and never lands —
 * without the promotion the dropped agent's `own`, `verify` and money all moved somewhere structurally
 * incapable of landing any of it.
 *
 * A full re-normalisation of the merged option (coverage, disjointness, the caps) belongs to the
 * decompose stage, which owns §3.4; that is why the merged split's `manifestId` is blanked below.
 */
function mergeInto(receiver: AgentSpec, dropped: AgentSpec, ctx: DropContext): AgentSpec {
  const merged = mergeAgentFields(receiver, dropped, { fold: ctx.fold, deny: ctx.deny });
  return {
    ...receiver,
    task: clip(`${receiver.task} Also, merged from the dropped agent \`${dropped.slug}\`: ${dropped.task}`, AGENT_TASK_CHARS),
    own: merged.own,
    verify: merged.verify,
    role: merged.role,
    branch: merged.branch,
    capUsd: merged.capUsd,
  };
}

/**
 * Re-validate the merge at `at` against §3.4 rules 2 and 3 (re-review R1). Returns the reason the
 * merge is not representable, or null.
 *
 * Rule 2 is re-run through `validateOwnList`, which is the same call the normaliser used: it parses,
 * applies the deny list, prefix-collapses WITHOUT widening past a denied prefix, and enforces
 * `OWN_GLOBS_MAX`. Rule 3 is re-run because a receiver widened by the collapse can reach into a THIRD
 * agent's slice even though it was disjoint from the dropped agent's.
 */
function mergeFault(agents: readonly AgentSpec[], at: number, ctx: DropContext): string | null {
  const receiver = agents[at];
  if (receiver === undefined) return null;
  const valid = validateOwnList(receiver.own, { max: OWN_GLOBS_MAX, deny: ctx.deny, fold: ctx.fold });
  if (!valid.ok) return `leaves \`${receiver.slug}\` with an own set that is not legal: ${valid.reason}`;
  for (const [i, other] of agents.entries()) {
    if (i === at) continue;
    const theirs = parseOwn(other.own);
    const clash = disjoint(valid.globs, theirs, ctx.fold);
    if (!clash.ok) return `makes \`${receiver.slug}\` and \`${other.slug}\` both own ${clash.left} / ${clash.right}`;
  }
  return null;
}

export interface DropResult {
  split: NormalizedSplit | null;
  rejected: readonly RejectedOption[];
}

/**
 * §3.5 / corner row 7: an agent whose `agent_<slug>_is_self_contained` Noul is below
 * `policy.selfContainedFloor` is dropped and merged into the agent owning the nearest directory; below two
 * agents the result is `no_split`. An agent with NO Noul (the ≤ 13 bound dropped its question, or it is not
 * an agent of the leading option) is never dropped: absence is not "below the floor".
 */
export function applyDropRule(split: NormalizedSplit, answers: Record<string, Answer>, policy: SplitPolicy, ctx: DropContext): DropResult {
  const rejected: RejectedOption[] = [];
  let agents: AgentSpec[] = [...split.agents];
  const doomed = agents.filter((a) => {
    const v = noulOf(answers, selfContainedId(a.slug));
    return v !== null && v < policy.selfContainedFloor;
  });
  if (doomed.length === 0) return { split, rejected };

  for (const d of doomed) {
    const survivors = agents.filter((a) => a.slug !== d.slug);
    const v = noulOf(answers, selfContainedId(d.slug)) ?? 0;
    rejected.push({ kind: split.kind, reason: `agent \`${d.slug}\` dropped: is_self_contained ${v.toFixed(2)} is below the floor ${policy.selfContainedFloor}`, probability: v });
    if (survivors.length < 2) return { split: null, rejected };
    const at = nearestAgent(d, survivors);
    const next = survivors.map((a, i) => (i === at ? mergeInto(a, d, ctx) : a));
    // R1: this merge runs AFTER `normalizeSplit`, and the result is returned with `manifestId: ''`
    // and no further checking, so it is the ONE place an `own` set can widen with no downstream
    // belt. Re-run rule 2 (sub-language, deny list, cap after collapse) on the receiver and rule 3
    // (pairwise disjointness) across the survivors; a merge that cannot satisfy both is not a
    // split, so the option becomes `no_split` rather than something the queue would mis-own.
    const fault = mergeFault(next, at, ctx);
    if (fault !== null) {
      rejected.push({ kind: split.kind, reason: `merging \`${d.slug}\` away ${fault}`, probability: null });
      return { split: null, rejected };
    }
    // Repoint, do not delete: the receiver now holds the dropped agent's work, so anything that waited
    // on `d` must wait on the receiver. Deleting the edge would let a dependant land FIRST and see none
    // of the work it declared a dependency on (the same class as review finding 3, one layer up).
    const receiver = next[at]?.slug ?? null;
    const repoint = (a: AgentSpec): AgentSpec => {
      const kept: string[] = [];
      for (const s of a.dependsOn.map((x) => (x === d.slug ? receiver : x))) {
        if (s !== null && s !== a.slug && !kept.includes(s)) kept.push(s);
      }
      return { ...a, dependsOn: kept };
    };
    const repointed = next.map(repoint);
    // …unless the repoint would close a loop (X depended on the dropped agent, and the receiver
    // depends on X). A cycle leaves every member blocked by a non-terminal member and the landing
    // queue never settles, so in that one case the edge is dropped instead — losing an ordering
    // constraint is recoverable, a wedged queue is not.
    agents = hasDependencyCycle(repointed)
      ? next.map((a) => ({ ...a, dependsOn: a.dependsOn.filter((s) => s !== d.slug) }))
      : repointed;
  }
  if (agents.length < 2) return { split: null, rejected };
  // The merged option is NOT re-normalised here (§3.4 is the decompose stage's), so its id is recomputed by
  // `manifest.ts buildManifest` from `canonical.ts` rather than carried stale.
  return { split: { ...split, agents, manifestId: '' }, rejected };
}

// ---------------------------------------------------------------------------------------
// §3.5 — ranking
// ---------------------------------------------------------------------------------------

export async function rankSplits(input: RankInput, deps: { ask: AskFn | null }): Promise<RankedSplit> {
  // ---- M2 / O1(a): only `no_split` survived. NO JEV REQUEST IS MADE. `deps.ask` is not touched. ----
  // `no_split` has no Choice option key (it is the fallback, not a candidate), so an `options` list
  // that holds only `no_split`-kind splits builds an EMPTY Choice and `choice()` throws
  // `QuestionBuildError` — against this function's "returns a value on every path" contract, and
  // outside the try below, so it escaped to the caller (review 2026-09-22 finding 11). Filter first:
  // the M2 guard is about what can actually be ranked, not about array length.
  const rankable = input.options.filter((o) => optionKeyOf(o.kind) !== null);
  if (rankable.length === 0) return noSplit('code', false, input.rejected);

  const first = rankable[0];
  // (e) `split: 'auto'`: the first option in enumerate order, deterministically, with nothing asked.
  if (input.auto && first !== undefined) {
    const rejected = [...input.rejected, ...rankable.slice(1).map((o) => loser(o, `not the first option in enumerate order, which is what --split=auto takes (\`${first.kind}\`)`, null))];
    return { split: first, splitKind: first.kind, verdict: 'code', probability: 0, confidence: 0, rejected, askedJev: false };
  }

  // (a) jev-off, or the caller refuses to ask: `no_split`, still without calling anything.
  if (deps.ask === null) return noSplit('code', false, [...input.rejected, ...rankable.map((o) => loser(o, 'no decider: the split was not ranked', null))]);

  const plan = planDecomposeQuestions(rankable, first ?? null);
  const state = buildDecomposeState({
    task: input.task,
    remaining: input.remaining,
    unverified: input.unverified,
    directories: input.directories,
    failingTests: input.failingTests,
    verification: input.verification,
    options: rankable,
  });

  let answers: Record<string, Answer>;
  let rows: Decision[];
  try {
    // jev-contract: WHICH_SPLIT — the split ranking (ORCHESTRATION-DESIGN §3.5; contract 1.5)
    //   escape: planDecomposeQuestions builds the Choice through src/jev/questions.ts choice(), so SPLIT_ESCAPE (`none_of_these`) and the paired `can_` Nouls are always present; the options are the splits the enumerators produced
    //   guard: every later line narrows — the PAIRED_NOUL_FLOOR check, SPLIT_KIND_OF, the winner-must-be-a-surviving-split lookup, then applyDropRule over the deny list and the fold, then the code critic downstream
    //   fallback: fellBack()/noSplit() answer `no_split` on a reject, a missing or non-Choice answer, a floor miss or an unknown kind; test: test/unit/orchestrate/rank.test.ts
    //   no-gating: ordering only — the answer divides work among agents; correctness stays the harness's own verification and the landing queue's merge
    const got = await deps.ask(state, plan.questions);
    answers = got.answers;
    rows = got.rows;
  } catch {
    // (b) corner row 4: the decider rejected (error, timeout, 401). Never rethrow, never open a pane.
    return noSplit('fallback', true, [...input.rejected, ...rankable.map((o) => loser(o, 'the decider did not answer; the split was not ranked', null))]);
  }

  const keys = plan.optionKeys;
  const probs = probabilitiesOf(answers);
  const pOf = (o: NormalizedSplit): number | null => {
    const key = optionKeyOf(o.kind);
    const p = key === null ? undefined : probs[key];
    return typeof p === 'number' && Number.isFinite(p) ? p : null;
  };
  const resolved = resolveChoice({ choiceId: WHICH_SPLIT, answers, options: keys, escape: SPLIT_ESCAPE, fallback: SPLIT_ESCAPE });
  const confidence = rows.find((r) => r.id === WHICH_SPLIT)?.confidence ?? 0;
  const raw = answers[WHICH_SPLIT];

  const fellBack = (reason: string): RankedSplit => {
    // The decisions pane must read `fallback` on the Choice row whatever `resolveChoice` would have written.
    const forced: ChoiceResolution<string> = { option: SPLIT_ESCAPE, verdict: 'fallback', answer: resolved.answer, probability: resolved.probability, pairedNoul: 0 };
    annotateChoiceRows(rows, WHICH_SPLIT, forced);
    const out = noSplit('fallback', true, [...input.rejected, ...rankable.map((o) => loser(o, reason, pOf(o)))]);
    return { ...out, confidence };
  };

  // (d) corner row 6: the escape was picked. Identical to row 5 — the escape is never an instruction, and it
  // is never turned into an option by the paired Nouls either, which is where this departs from
  // `resolveChoice`'s ordinary override rule. §3.5's exhaustive list: "Escape chosen → no_split".
  if (raw === undefined || raw.type !== 'choice') return fellBack('the decider returned no `which_split` answer');
  if (raw.choice === SPLIT_ESCAPE) return fellBack('Jev answered `none_of_these`: no listed split was applicable');
  // (c) corner row 5: every paired Noul below PAIRED_NOUL_FLOOR.
  if (resolved.verdict === 'fallback') return fellBack('no paired Noul reached the floor; the option was not delegable');

  const kind = SPLIT_KIND_OF[resolved.option];
  const winner = kind === undefined ? undefined : rankable.find((o) => o.kind === kind);
  if (winner === undefined) return fellBack('the ranked option is not one of the surviving splits');
  annotateChoiceRows(rows, WHICH_SPLIT, resolved);

  const dropped = applyDropRule(winner, answers, input.policy, { deny: input.deny, fold: input.fold });
  const losers = rankable.filter((o) => o !== winner).map((o) => loser(o, 'ranked below the chosen split', pOf(o)));
  const rejected = [...input.rejected, ...losers, ...dropped.rejected];
  if (dropped.split === null) {
    return { ...noSplit('fallback', true, [...rejected, loser(winner, 'fewer than two agents were self-contained', resolved.probability)]), confidence };
  }
  return { split: dropped.split, splitKind: dropped.split.kind, verdict: resolved.verdict, probability: resolved.probability, confidence, rejected, askedJev: true };
}

// ---------------------------------------------------------------------------------------
// §5.2 "Order:" / §5.5 — the landing order
// ---------------------------------------------------------------------------------------

export interface LandingAgent {
  slug: string;
  dependsOn: readonly string[];
}

/**
 * §5.2: topological over `dependsOn` first (prelude agents first), then by the §5.5 Score descending, then by
 * slug. With no scores at all — `critic: 'off'`, request 2 unavailable, or the decider down — every agent
 * scores 0 and the same code yields §3.5's pure fallback: topological, then slug.
 */
export function rankLandingOrder(scores: Readonly<Record<string, number>>, agents: readonly LandingAgent[]): string[] {
  const slugs = new Set(agents.map((a) => a.slug));
  const pending = new Map<string, Set<string>>();
  for (const a of agents) pending.set(a.slug, new Set(a.dependsOn.filter((d) => slugs.has(d) && d !== a.slug)));
  const scoreOf = (slug: string): number => {
    const s = scores[slug];
    return typeof s === 'number' && Number.isFinite(s) ? s : 0;
  };
  const better = (x: string, y: string): number => scoreOf(y) - scoreOf(x) || (x < y ? -1 : x > y ? 1 : 0);

  const out: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending.entries()].filter(([, deps]) => deps.size === 0).map(([s]) => s);
    // A cycle cannot reach here (rule 6 deletes one), but if it did the remainder is emitted in score order
    // rather than dropped: a landing queue that silently loses an agent would lose its branch too.
    const take = (ready.length > 0 ? ready : [...pending.keys()]).sort(better)[0];
    if (take === undefined) break;
    out.push(take);
    pending.delete(take);
    for (const deps of pending.values()) deps.delete(take);
  }
  return out;
}
