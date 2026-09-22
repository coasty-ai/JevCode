/**
 * The decompose stage (docs/ORCHESTRATION-DESIGN.md §3, §8.2 D1 item 15).
 *
 * gate → the generator's one option → enumerate → normalise → rank → manifest → confirm, in §3's order and
 * entirely through the `src/orchestrate/index.ts` facade (§8.1 rule 2: nothing here reaches into
 * `src/orchestrate/split/*`). It NEVER touches the workspace — §3's opening sentence, and the reason a
 * rule-1 discard of a `decompose` step costs one Jev request and nothing else: no branch, no worktree, no
 * file. The manifest is WRITTEN by the engine, after the human approved it; this module only builds it.
 *
 * Three properties this module exists to hold, each with its own test:
 *
 *   **O1(a).** If only `no_split` survives, no Jev request is made at all. `rankSplits` enforces it
 *   (`rankable.length === 0` returns before `deps.ask` is read) and `decompose.test.ts` asserts the seam
 *   was never called — the assertion is on the SEAM, not on a count, because a count can be right for the
 *   wrong reason.
 *
 *   **Jev routes, never gates.** Every path of §3.5's exhaustive list — decider error, timeout, 401,
 *   `jev-off`, below `PAIRED_NOUL_FLOOR`, the `none_of_these` escape, an agent below
 *   `selfContainedFloor`, `--no-input` with `split: 'ask'` — lands on `no_split` and the run continues
 *   single-threaded. Nothing here throws on Jev's behalf and nothing here opens a pane: corner row 33's
 *   rule is that coordination-class calls never open one, so the failure is a single
 *   `notice { kind: 'orchestration', level: 'info' }`.
 *
 *   **Zero cost when shut.** The gate is pure over `DecomposeFacts`; the engine short-circuits `split: 'off'`
 *   and `orchestration.depth === 1` BEFORE it gathers any of them (M2). A shut gate emits nothing at all
 *   unless `verbose` is set, which is `--json=verbose` — the one line that makes the gate testable (§3.1).
 */
import { HEADLINE_ROWS_MAX } from '../../core/limits.js';
import { RISK_DIMENSIONS, type Answer, type CheckpointState, type ConfirmOutcome, type ConfirmRequest, type Decision, type EngineEvent, type EngineMode, type Json, type Plan, type PlanDraft, type Proposal, type Question, type RiskAssessment, type RiskDimensionResult } from '../../core/types.js';
import {
  DEFAULT_SPLIT_POLICY,
  buildManifest,
  enumerateSplits,
  manifestPath,
  normalizeSplit,
  prefixTree,
  rankSplits,
  topLevelDirs,
  type DraftSplit,
  type GateReason,
  type Manifest,
  type NormalizedSplit,
  type PreflightReason,
  type RejectedOption,
  type SplitPolicy,
  type SyncedDirtyEntry,
  splitGate,
} from '../../orchestrate/index.js';

// ---------------------------------------------------------------------------------------
// §3.7 [D5c] — the synthetic proposal and risk, spelled out so the implementer does not choose them
// ---------------------------------------------------------------------------------------

/**
 * §3.7 [D5c]. The design's literal also lists `taskImpossible: 0` and `text: '…'`; neither is a member of
 * `RiskDimensionResult` (`src/core/types.ts:332`) — both belong to `ReplanDirective`, which sits
 * immediately above it in that file, and the design copied them across. The seven fields below are the
 * seven the type declares, with [D5c]'s values. Do not "restore" the other two: they would not compile,
 * and no surface can read them anyway — with `headline` set, [D5]'s five render branches never touch
 * `risk` at all.
 */
export const ZERO_DIM: RiskDimensionResult = { risk: 0, probability: 1, expected: 0, tailMass: 0, bound: 'expected', confidence: 1, level: 0 };

/** §3.7 [D5c], verbatim. */
export const DECOMPOSE_RISK_REASON = 'a decomposition proposal: nothing is written until you approve';

/** §3.7 [D5c]: `risk` stays REQUIRED on `ConfirmRequest`, so it is constructed — identically, every time. */
export function decomposeRisk(): RiskAssessment {
  return {
    dims: Object.fromEntries(RISK_DIMENSIONS.map((d) => [d, { ...ZERO_DIM }])) as RiskAssessment['dims'],
    risk: 0,
    verdict: 'review',
    reason: DECOMPOSE_RISK_REASON,
  };
}

/**
 * §3.7 [D5c]: `proposal` stays REQUIRED too. The action is a `read` of the manifest's own relative path —
 * the one honest thing a decomposition card could be said to "do" — and the plan is the current
 * `PlanDraft`, unchanged. `rawText` is `''` because no model wrote this.
 */
export function decomposeProposal(splitKind: string, agents: number, plan: PlanDraft, step: number): Proposal {
  return {
    goal: `delegate: ${splitKind} — ${agents} agents`,
    action: { kind: 'read', paths: [manifestPath(step)] },
    plan,
    rawText: '',
  };
}

// ---------------------------------------------------------------------------------------
// The seams
// ---------------------------------------------------------------------------------------

/**
 * The structural subset of `src/loop/engine.ts`'s `StageContext` this stage uses, plus the generator's one
 * `propose_split` call. Declared as its own interface (rather than taken as `StageContext`) for two
 * reasons: the stage needs no workspace, sandbox or patch targets — it must not have them, because §3 says
 * it never touches the workspace — and a unit test can then drive every §3.5 fallback without an engine.
 */
export interface DecomposeStageContext {
  readonly step: number;
  readonly mode: EngineMode;
  readonly task: string;
  redact(s: string): string;
  now(): number;
  emit(e: EngineEvent): void;
  /** §3.5 request 1. Rejects on decider error / timeout / 401 — which is a fallback, never a throw out of this stage. */
  ask(state: Json, questions: Record<string, Question>, annotate?: (answers: Record<string, Answer>, rows: Decision[]) => void): Promise<{ answers: Record<string, Answer>; rows: Decision[] }>;
  /**
   * §3.3: the generator's ONE call at the gate. `null` = nothing usable came back (and `jev-only` never
   * calls it at all). Its prose is discarded by the caller; only the structured split arrives here.
   */
  proposeSplit(): Promise<DraftSplit | null>;
}

/**
 * Every environmental fact the gate and the planner need, ALREADY MEASURED. This shape is the M2 contract:
 * the engine may not compute a single one of these fields while the gate is shut, which is why they are an
 * argument and not a probe.
 */
export interface DecomposeFacts {
  /** §3.1 [G5]. No ledger → no delegation: children could not be tracked, so the gate stays shut. */
  hasLedger: boolean;
  git: { isRepo: boolean; headBorn: boolean; worktreeSupported: boolean };
  baseSha: string;
  repoKey: string | null;
  /** short `refs/heads/*` names, for §3.4 rule 1's collision rename */
  existingBranches: readonly string[];
  /** §3.4 rule 2: `.git`, every submodule path, every `secretPaths` entry */
  deny: readonly string[];
  fold: boolean;
  /** every real repo path, for §3.4 rule 8's [G11] token resolution */
  repoPaths: readonly string[];
  /** `git ls-files`, the prefix-tree source */
  listing: readonly string[];
  /** parallel to `plan.remaining` */
  itemFiles: readonly (readonly string[])[];
  testImports: Readonly<Record<string, readonly string[]>>;
  packages: readonly { name: string; dir: string }[];
  lastTestRun: { failingFiles: readonly string[] } | null;
  /** TRACKED `statusPorcelain` entries (corner row 16) */
  dirtyEntries: number;
  syncedDirty: readonly SyncedDirtyEntry[];
  /** [D1]: the subset of `syncedDirty` inside some agent's `own` — the card's first headline row */
  dirtyOverlap: readonly string[];
  liveChildren: number;
  splits: number;
  lastSplitStep: number | null;
  /** §3.6's answer: how many agents actually fit. Below 2 is `no_split` with the reason. */
  maxAgentsAllowed: number;
  preflightReasons: readonly PreflightReason[];
  availableParallelism: number;
  freeMemBytes: number;
  freeDiskBytes: number;
  repoBytes: number;
  /** [D6] ALREADY net of holds */
  sessionRemainingUsd: number;
  isReplanStep: boolean;
  orchestrationProblemAgeSteps: number | null;
  /** §5.1's resolved command set; empty means the split can only be research-only */
  verification: readonly string[];
  /** `/split`, a one-shot flag consumed like a pending limit */
  humanAsked: boolean;
}

export interface DecomposeInput {
  policy: SplitPolicy;
  /** `EngineOptions.orchestration.depth` */
  depth: number;
  runId: string;
  sessionId: string;
  plan: Plan;
  /** the current `PlanDraft`, handed to [D5c]'s synthetic proposal UNCHANGED */
  planDraft: PlanDraft;
  /** §6.1's arithmetic, done by the engine (it owns the meter) */
  reserveUsd: number;
  reserveFrom: 'session' | 'run';
  facts: DecomposeFacts;
  /** §3.4 rule 9: the HIT COUNT of `core/redact.ts detectSecrets`, never a value */
  detectSecrets(s: string): number;
  /** `--json=verbose`: the one condition under which a shut gate says anything (§3.1, M2) */
  verbose: boolean;
  /** false under `--no-input` / a pipe / the bench: the confirm cannot be answered (corner row 11) */
  hasBlocker: boolean;
  /** the EXISTING `Confirmer` path, reached through the engine's `confirm()` — never a second confirmer */
  confirm(req: ConfirmRequest): Promise<ConfirmOutcome>;
}

export type DecomposeResult =
  /** the gate was shut: nothing was asked, nothing was built (§3.1) */
  | { kind: 'skipped'; why: GateReason }
  /** §3.5's fallback on every path. `problem` is the `orchestration` HarnessProblem text, or null when the step simply had nothing to split */
  | { kind: 'no_split'; reason: string; problem: string | null; rejected: readonly RejectedOption[] }
  /** corner row 9: an ordinary `declined` outcome; the reason reaches Jev and the generator, and the caller records the problem */
  | { kind: 'declined'; reason: string; note?: string; manifest: Manifest }
  /** the human said `[y]` (or `split: 'auto'` with a research-only split): the caller writes the manifest and reaches P9 */
  | { kind: 'proposed'; manifest: Manifest; request: ConfirmRequest };

// ---------------------------------------------------------------------------------------
// The card (§3.7). The BODY is `src/tui/agents/lines.ts` (wave D3 item 32) — this is the bounded fallback.
// ---------------------------------------------------------------------------------------

const NUMERALS: readonly string[] = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function numeral(n: number): string {
  return NUMERALS[n] ?? String(n);
}

/**
 * §3.7 [D1], in its exact prose shape. This is the ONE fact that changes what `/land` will do later, which
 * is why it takes the first headline row whenever `dirtyOverlap` is non-empty — ahead of the split kind,
 * the money and the verdict.
 */
export function dirtyOverlapWarning(dirtyCount: number, overlap: readonly string[]): string | null {
  if (overlap.length === 0) return null;
  const named = overlap.slice(0, 4).join(', ');
  const more = overlap.length > 4 ? ` and ${overlap.length - 4} more` : '';
  if (overlap.length === 1) {
    return `⚠ your checkout has ${dirtyCount} uncommitted files; 1 of them (${named}) is inside an agent's slice — /land will ask you to commit or stash it before it merges`;
  }
  return `⚠ your checkout has ${dirtyCount} uncommitted files; ${overlap.length} of them (${named}${more}) are inside an agent's slice — /land will ask you to commit or stash those ${numeral(overlap.length)} before it merges`;
}

/** §3.7 [D4]: at most `HEADLINE_ROWS_MAX` rows, and the [D1] warning is always the first of them. */
export function decomposeHeadline(m: Manifest, dirtyCount: number): string[] {
  const rows: string[] = [];
  const warning = dirtyOverlapWarning(dirtyCount, m.dirtyOverlap);
  if (warning !== null) rows.push(warning);
  rows.push(`${m.splitKind}: ${m.agents.length} agents on ${m.dockBranch} from ${m.baseSha.slice(0, 8)}`);
  rows.push(`reserve $${m.reserveUsd.toFixed(2)} from the ${m.reserveFrom} budget, split by item count`);
  rows.push(`${m.verdict} p=${m.probability.toFixed(2)} confidence=${m.confidence.toFixed(2)}, demand: ${m.demand}`);
  if (m.rejected.length > 0) rows.push(`${m.rejected.length} option${m.rejected.length === 1 ? '' : 's'} rejected — see the body`);
  return rows.slice(0, HEADLINE_ROWS_MAX);
}

/**
 * The plain, bounded fallback body. `src/tui/agents/lines.ts` (wave D3 item 32) REPLACES this with the real
 * card: every agent with its `own`, `verify`, caps and mode, the reserve arithmetic, and the rejected
 * options with their reasons and probabilities, all cell-measured. Until it lands, the card must still
 * render something true — [G2]'s whole point is that a blank body is not acceptable.
 */
export function decomposeBody(m: Manifest): string[] {
  const rows: string[] = [`${m.agents.length} agents, ${m.splitKind}, dock ${m.dockBranch}:`];
  for (const a of m.agents) {
    rows.push(`  ${a.slug} [${a.role}] $${a.capUsd.toFixed(2)} · ${a.maxSteps} steps · ${Math.round(a.maxWallMs / 60_000)} min · ${a.branch ?? 'no branch'}`);
    rows.push(`    owns ${a.own.join(' ')}`);
    if (a.verify.length > 0) rows.push(`    verify ${a.verify.join(' && ')}`);
    rows.push(`    ${a.task.slice(0, 160)}`);
  }
  if (m.dirtyOverlap.length > 0) rows.push(`  dirty and owned: ${m.dirtyOverlap.join(' ')}`);
  for (const r of m.rejected.slice(0, 8)) rows.push(`  rejected ${r.kind}: ${r.reason}${r.probability === null ? '' : ` (p=${r.probability.toFixed(2)})`}`);
  return rows;
}

/** §3.4 rule 9 / §3.7: a COUNT in the badge, never a value. */
export function decomposeBadge(secretHits: number): string {
  return secretHits > 0 ? `delegate ⚠ secret? ×${secretHits}` : 'delegate';
}

// ---------------------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------------------

function noSplit(reason: string, problem: string | null, rejected: readonly RejectedOption[] = []): DecomposeResult {
  return { kind: 'no_split', reason, problem, rejected };
}

/** corner rows 4 and 33: ONE info notice, never a pane, whatever went wrong with the decider. */
function orchestrationNotice(ctx: DecomposeStageContext, text: string): void {
  ctx.emit({ type: 'notice', step: ctx.step, kind: 'orchestration', level: 'info', text });
}

export async function runDecomposeStage(ctx: DecomposeStageContext, input: DecomposeInput): Promise<DecomposeResult> {
  const { facts } = input;
  const policy = input.policy;

  // ---- §3.1: the gate. Pure over facts; the FIRST failing condition is the reason. ----
  const researchOnly = facts.verification.length === 0;
  const verdict = splitGate({
    policy,
    depth: input.depth,
    hasLedger: facts.hasLedger,
    git: facts.git,
    plan: { remaining: input.plan.remaining, unverified: input.plan.unverified },
    verificationResolvable: facts.verification.length > 0,
    researchOnly,
    dirtyEntries: facts.dirtyEntries,
    liveChildren: facts.liveChildren,
    splits: facts.splits,
    step: ctx.step,
    lastSplitStep: facts.lastSplitStep,
    availableParallelism: facts.availableParallelism,
    freeMemBytes: facts.freeMemBytes,
    agentMemBytes: 3 * 1024 ** 3,
    freeDiskBytes: facts.freeDiskBytes,
    repoBytes: facts.repoBytes,
    sessionRemainingUsd: facts.sessionRemainingUsd,
    isReplanStep: facts.isReplanStep,
    orchestrationProblemAgeSteps: facts.orchestrationProblemAgeSteps,
    demand: {
      directories: topLevelDirs(facts.itemFiles.flatMap((f) => [...f])),
      failingTestFiles: facts.lastTestRun?.failingFiles ?? [],
      humanAsked: facts.humanAsked,
    },
  });
  if (!verdict.open) {
    // §3.1: "A shut gate emits nothing — not even a transcript line — except under `--json=verbose`."
    if (input.verbose) ctx.emit({ type: 'decompose:skipped', step: ctx.step, why: verdict.why });
    return { kind: 'skipped', why: verdict.why };
  }

  // ---- §3.6: how many agents fit, decided before anything is enumerated at that width ----
  if (facts.maxAgentsAllowed < 2) {
    const why = facts.preflightReasons.map((r) => r.text).join('; ');
    return noSplit(`resources allow ${facts.maxAgentsAllowed} agents${why.length > 0 ? `: ${why}` : ''}`, null);
  }
  const effective: SplitPolicy = { ...policy, maxAgents: Math.min(policy.maxAgents, facts.maxAgentsAllowed) };

  // ---- §3.3: the generator writes ONE option, and only one. Never in jev-only. ----
  let asWritten: DraftSplit | null = null;
  if (ctx.mode !== 'jev-only') {
    try {
      asWritten = await ctx.proposeSplit();
    } catch {
      // §3.3's answer is one option among six. A generator that fails costs the option, not the stage.
      asWritten = null;
    }
  }

  // ---- §3.2 / §3.4: code builds the options, the normaliser deletes them ----
  const enumerated = enumerateSplits({
    plan: { remaining: input.plan.remaining },
    itemFiles: facts.itemFiles,
    listing: facts.listing,
    lastTestRun: facts.lastTestRun,
    testImports: facts.testImports,
    packages: facts.packages,
    asWritten,
    policy: effective,
    verifyFor: () => facts.verification,
  });
  const survivors: NormalizedSplit[] = [];
  const rejected: RejectedOption[] = [...enumerated.rejected];
  let secretHits = 0;
  for (const option of enumerated.options) {
    const r = normalizeSplit({
      option,
      policy: effective,
      existingBranches: facts.existingBranches,
      deny: facts.deny,
      fold: facts.fold,
      repoPaths: facts.repoPaths,
      plan: { remaining: input.plan.remaining },
      itemFiles: facts.itemFiles,
      task: ctx.task,
      baseSha: facts.baseSha,
      mode: ctx.mode,
      reserveUsd: input.reserveUsd,
      detectSecrets: input.detectSecrets,
    });
    if (r.ok) survivors.push(r.split);
    else rejected.push(r.rejected);
  }

  // §4.1: `options` is how many candidates reached ranking — `no_split` is the escape, not a candidate.
  ctx.emit({ type: 'decompose:start', step: ctx.step, options: survivors.length });

  // ---- §3.5: Jev ranks. `jev-off` has no decider, so it takes the code fallback WITHOUT calling anything. ----
  const ask =
    ctx.mode === 'jev-off'
      ? null
      : async (state: Json, questions: Record<string, Question>): Promise<{ answers: Record<string, Answer>; rows: Decision[] }> => ctx.ask(state, questions);
  const ranked = await rankSplits(
    {
      task: ctx.task,
      remaining: input.plan.remaining,
      unverified: input.plan.unverified.map((u) => u.text),
      directories: prefixTree(facts.listing),
      failingTests: facts.lastTestRun?.failingFiles ?? [],
      verification: facts.verification,
      options: survivors,
      rejected,
      policy: effective,
      // §3.5's deterministic path. `split: 'off'` cannot reach here at all (the gate shut on it).
      auto: policy.split === 'auto',
      deny: facts.deny,
      fold: facts.fold,
    },
    { ask },
  );
  ctx.emit({
    type: 'decompose:ranked',
    step: ctx.step,
    splitKind: ranked.splitKind,
    verdict: ranked.verdict,
    probability: ranked.probability,
    agents: ranked.split?.agents.length ?? 0,
    rejected: ranked.rejected.length,
  });

  if (ranked.split === null) {
    // corner rows 4 / 5 / 6 / 7: every one of them is `no_split`, and the ones Jev was asked about get the
    // single info notice. `askedJev === false` means code decided alone — that is not a failure to report.
    const reason = ranked.rejected.at(-1)?.reason ?? 'no split survived';
    if (ranked.askedJev) {
      orchestrationNotice(ctx, `no delegation this step: ${reason} — continuing single-threaded`);
      return noSplit(reason, `a decomposition was attempted at step ${ctx.step} and did not produce a split: ${reason}`, ranked.rejected);
    }
    return noSplit(reason, null, ranked.rejected);
  }
  secretHits = ranked.split.secretHits;

  // ---- §3.7: the manifest (built here, WRITTEN by the caller after approval) ----
  const built = buildManifest({
    split: ranked.split,
    verdict: ranked.verdict,
    probability: ranked.probability,
    confidence: ranked.confidence,
    runId: input.runId,
    sessionId: input.sessionId,
    step: ctx.step,
    task: ctx.task,
    remaining: input.plan.remaining,
    baseSha: facts.baseSha,
    repoKey: facts.repoKey,
    syncedDirty: facts.syncedDirty,
    dirtyOverlap: facts.dirtyOverlap,
    reserveUsd: input.reserveUsd,
    reserveFrom: input.reserveFrom,
    rejected: ranked.rejected,
    demand: verdict.demand,
    redact: (s) => ctx.redact(s),
    now: () => ctx.now(),
  });
  if (!built.ok) {
    orchestrationNotice(ctx, `no delegation this step: ${built.reason} — continuing single-threaded`);
    return noSplit(built.reason, `the manifest could not be built at step ${ctx.step}: ${built.reason}`, ranked.rejected);
  }
  const manifest = built.manifest;

  // ---- §3.7's policy: who has to say `[y]` ----
  const everyAgentIsResearch = manifest.agents.every((a) => a.role === 'research');
  const needsConfirm = policy.split === 'ask' || !everyAgentIsResearch;
  if (!needsConfirm) return { kind: 'proposed', manifest, request: buildConfirmRequest(input, manifest, secretHits, ctx.step) };

  // corner row 11: `--no-input` / a pipe / the bench has no blocker, so the confirm answers `stop`. It is
  // NOT auto-approved and NOT auto-declined-with-a-problem: headless delegation needs the explicit flag.
  if (!input.hasBlocker) {
    return noSplit(
      `a ${manifest.agents.length}-agent split was ready but there is no reviewer to approve it (--no-input / a pipe / the bench); headless delegation needs --split=auto with a research-only split, or --yes-split`,
      null,
      ranked.rejected,
    );
  }

  const request = buildConfirmRequest(input, manifest, secretHits, ctx.step);
  const outcome = await input.confirm(request);
  if (outcome.approved) return { kind: 'proposed', manifest, request };
  const reason = `the ${manifest.agents.length}-agent ${manifest.splitKind} split was declined${outcome.note !== undefined ? `: ${outcome.note}` : ''}`;
  return { kind: 'declined', reason, ...(outcome.note !== undefined ? { note: outcome.note } : {}), manifest };
}

/**
 * §3.7 [G2] [D4] [D5]: the one confirm. `title` / `headline` / `body` / `badge` carry the whole card, and
 * `proposal` / `risk` are [D5c]'s fixed literals — with `headline` set, none of the five render branches
 * reads either of them, which is the property `review.test.tsx` asserts. `matchesIntent` is left ABSENT.
 */
function buildConfirmRequest(input: DecomposeInput, m: Manifest, secretHits: number, step: number): ConfirmRequest {
  return {
    id: `${input.runId}:${step}:delegate`,
    step,
    proposal: decomposeProposal(m.splitKind, m.agents.length, input.planDraft, step),
    risk: decomposeRisk(),
    title: `delegate ${m.agents.length} agents — ${m.splitKind}`,
    headline: decomposeHeadline(m, input.facts.syncedDirty.length),
    body: decomposeBody(m),
    badge: decomposeBadge(secretHits),
  };
}

/**
 * §3.1 [G21] / §2.5(e): the ONE short-circuit, in one named place. `split: 'off'` (the shipping default)
 * and `orchestration.depth === 1` are decided from the resolved options ALONE — no `statusPorcelain`, no
 * `availableParallelism()`, no `os.freemem()`, no `statfs`, no measured repo size. That is M2: with the
 * gate shut nothing may be measured, so the cost of the feature is this comparison and nothing else.
 *
 * It returns the same `GateReason` `splitGate` would have returned, so `decompose:skipped` reads the same
 * under `--json=verbose` whether the short-circuit or the gate proper refused.
 */
export function decomposeShutByOptions(policy: SplitPolicy | undefined, depth: number | undefined, hasLedger?: boolean): GateReason | null {
  if ((policy ?? DEFAULT_SPLIT_POLICY).split === 'off') return 'split_off';
  if ((depth ?? 0) !== 0) return 'child_depth';
  // [G5]: absent reads as false. Degraded CONTROL is dropped, so without a ledger `orchestrate.split` resolves to
  // `off` — and this is decided from the options alone, which keeps the M2 property whatever the setting says.
  if (hasLedger !== true) return 'no_ledger';
  return null;
}

/** §3.3: the prefix tree the generator's split prompt is shown, bounded by `PREFIX_TREE_MAX`. */
export function splitPrefixTree(listing: readonly string[]): string[] {
  return prefixTree(listing);
}

/**
 * §4.1 `CheckpointState.orchestration`, built here so the shape has ONE author: the engine writes it at P9
 * and corner row 12 compares it back on resume. Every agent starts `planned` with no run and no commit —
 * the supervisor (wave D2) is what moves them.
 */
export function checkpointOrchestration(m: Manifest): NonNullable<CheckpointState['orchestration']> {
  return {
    manifestId: m.manifestId,
    step: m.step,
    dockBranch: m.dockBranch,
    agents: m.agents.map((a) => ({ slug: a.slug, state: 'planned' as const, runId: null, commit: null })),
  };
}

/**
 * §3.3: the generator's `propose_split` argument, validated into a `DraftSplit`.
 *
 * Nothing here is trusted — `normalizeSplit` (§3.4) re-derives every safety property of what comes back, and
 * §3.3 says the prose is discarded outright — so this function only has to be TOTAL: every shape other than
 * `{ agents: [{ slug, task, own[], verify[] }] }` yields `null`, the `as_written` option is simply absent,
 * and the decomposition looks exactly like `jev-only`'s. It never throws.
 */
export function parseSplitDraft(value: unknown): DraftSplit | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = (value as { agents?: unknown }).agents;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const agents: { slug: string; task: string; own: string[]; verify: string[] }[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const a = entry as { slug?: unknown; task?: unknown; own?: unknown; verify?: unknown };
    if (typeof a.slug !== 'string' || typeof a.task !== 'string') return null;
    if (!Array.isArray(a.own) || !a.own.every((x): x is string => typeof x === 'string')) return null;
    const verify = Array.isArray(a.verify) && a.verify.every((x): x is string => typeof x === 'string') ? a.verify : [];
    agents.push({ slug: a.slug, task: a.task, own: [...a.own], verify: [...verify] });
  }
  return { kind: 'as_written', agents };
}
