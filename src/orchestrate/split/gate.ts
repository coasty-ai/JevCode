/**
 * The split gate (docs/ORCHESTRATION-DESIGN.md §3.1): pure code, zero cost when shut.
 *
 * Every all-of condition of the §3.1 table is evaluated in the table's own order and the FIRST
 * failing one is returned, because `GateReason` is what `decompose:skipped` prints and what M2
 * asserts: reordering the checks would change a testable output, so the order is part of the
 * contract, not an implementation detail.
 *
 * The non-obvious invariant: a DIRTY parent is the normal case and is deliberately NOT a reason to
 * shut the gate [D1] — §2.6 keeps the dirt off the agent branches, §3.7's card names any overlap up
 * front, and §5.7 refuses to merge over it. Only the 200-entry cap on TRACKED entries shuts it
 * (corner row 16).
 *
 * Zero I/O: every fact — the git probe, the resource measurements, the money — arrives on `GateInput`.
 */
import { DIRTY_ENTRIES_MAX } from '../../core/limits.js';
import type { DemandReason, GateReason, SplitPolicy } from '../types.js';

export type GateVerdict = { open: false; why: GateReason } | { open: true; demand: DemandReason };

export interface GateInput {
  policy: SplitPolicy;
  /** `EngineOptions.orchestration.depth`; only a depth-0 run may become a parent (§2.1) */
  depth: number;
  /** [G5] a coordination ledger handle exists */
  hasLedger: boolean;
  /** the `GitState` probe, cached by the caller (corner row 14) */
  git: { isRepo: boolean; headBorn: boolean; worktreeSupported: boolean };
  plan: {
    remaining: readonly string[];
    unverified: readonly { text: string }[];
  };
  /** §5.1 resolved to a non-empty command set */
  verificationResolvable: boolean;
  /** the split would be research-only, so it needs no verification set */
  researchOnly: boolean;
  /** TRACKED entries of `statusPorcelain` (corner row 16) */
  dirtyEntries: number;
  liveChildren: number;
  /** splits already consumed by a *written* manifest this run */
  splits: number;
  step: number;
  lastSplitStep: number | null;
  /** `os.availableParallelism()` */
  availableParallelism: number;
  freeMemBytes: number;
  agentMemBytes: number;
  freeDiskBytes: number;
  /** the measured size of `.git` + the checkout (§3.6) */
  repoBytes: number;
  /** [D6] ALREADY net of holds: `sessionRemainingUsd(sessionCapOf(), sessionTotal(), heldUsd())` */
  sessionRemainingUsd: number;
  isReplanStep: boolean;
  /** steps since the newest `orchestration` harness problem; null when there is none */
  orchestrationProblemAgeSteps: number | null;
  demand: {
    /** the disjoint top-level source directories the remaining items' files span */
    directories: readonly string[];
    failingTestFiles: readonly string[];
    /** `/split`, a one-shot flag consumed like a pending limit */
    humanAsked: boolean;
  };
}

/**
 * A divisor of 0, NaN or Infinity means the measurement is unavailable, not that nothing fits: the
 * §3.6 pre-flight re-does this arithmetic with measured numbers before any worktree is created, so
 * the gate treats an unknown denominator as unbounded rather than shutting on a missing probe.
 */
function fits(free: number, per: number): number {
  if (!Number.isFinite(per) || per <= 0) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(free)) return free > 0 ? Number.POSITIVE_INFINITY : 0;
  return Math.floor(free / per);
}

export function splitGate(input: GateInput): GateVerdict {
  const { policy, plan, demand } = input;

  // 1. the setting and the depth constant
  if (policy.split === 'off') return { open: false, why: 'split_off' };
  if (input.depth !== 0) return { open: false, why: 'child_depth' };

  // 2. [G5] no ledger, no delegation: the children's leases and heartbeats have nowhere to live
  if (!input.hasLedger) return { open: false, why: 'no_ledger' };

  // 3. corner row 14: a worktree needs a repository, a born HEAD and git >= 2.5
  if (!input.git.isRepo) return { open: false, why: 'not_git' };
  if (!input.git.headBorn) return { open: false, why: 'unborn_head' };
  if (!input.git.worktreeSupported) return { open: false, why: 'no_worktree_support' };

  // 4. enough plan to divide, and a plan that is not gated behind one unverified fact. "Blocks every
  //    remaining one" means literally that: every remaining item IS an unverified item, so whatever
  //    the agents did would rest on the same unchecked assumption and they would all be wrong together.
  if (plan.remaining.length < 3) return { open: false, why: 'plan_too_small' };
  if (plan.unverified.length > 0 && plan.remaining.every((r) => plan.unverified.some((u) => u.text === r))) {
    return { open: false, why: 'blocking_unverified' };
  }

  // 5. §5.1 resolved something, or nobody is going to write code anyway
  if (!input.verificationResolvable && !input.researchOnly) return { open: false, why: 'no_verification' };

  // 6. [D1] the dirty parent is the NORMAL case, not a blocker; only the cap shuts the gate (row 16)
  if (input.dirtyEntries > DIRTY_ENTRIES_MAX) return { open: false, why: 'dirty_too_large' };

  // 7. one delegation at a time, bounded per run, with a cooldown between them
  if (input.liveChildren !== 0) return { open: false, why: 'children_live' };
  if (input.splits >= policy.maxSplits) return { open: false, why: 'max_splits' };
  if (input.lastSplitStep !== null && input.step - input.lastSplitStep < policy.splitEvery) return { open: false, why: 'cooldown' };

  // 8. resources: two agents have to fit in cpu, memory and disk at once
  const affordable = Math.min(
    policy.maxAgents,
    input.availableParallelism - 1,
    fits(input.freeMemBytes, input.agentMemBytes),
    fits(input.freeDiskBytes, input.repoBytes),
  );
  if (!(affordable >= 2)) return { open: false, why: 'resources' };

  // 9. money. `sessionRemainingUsd` is already net of holds [D6]; POSITIVE_INFINITY is "no session cap"
  //    and passes, because Infinity x reserveFraction is still Infinity.
  if (!(input.sessionRemainingUsd * policy.reserveFraction >= 2 * policy.minAgentUsd)) return { open: false, why: 'money' };

  // 10. not while the loop detector is already re-planning, and not straight after an orchestration problem
  if (input.isReplanStep) return { open: false, why: 'replan_step' };
  if (input.orchestrationProblemAgeSteps !== null && input.orchestrationProblemAgeSteps < policy.splitEvery) {
    return { open: false, why: 'orchestration_problem' };
  }

  // …and one demand reason, in this order
  if (demand.directories.length >= 2) return { open: true, demand: 'disjoint_directories' };
  if (demand.failingTestFiles.length >= 2) return { open: true, demand: 'failing_tests' };
  if (demand.humanAsked) return { open: true, demand: 'human' };
  return { open: false, why: 'no_demand' };
}

const REASON_TEXT: Record<GateReason, string> = {
  split_off: 'orchestrate.split is off',
  child_depth: 'this run is already an agent, and agents do not spawn agents',
  no_ledger: 'the coordination ledger is not available',
  not_git: 'agents need a git worktree (git ≥ 2.5) and a committed HEAD',
  unborn_head: 'agents need a git worktree (git ≥ 2.5) and a committed HEAD',
  no_worktree_support: 'agents need a git worktree (git ≥ 2.5) and a committed HEAD',
  plan_too_small: 'the plan has fewer than three remaining items',
  blocking_unverified: 'one unverified assumption blocks every remaining item',
  no_verification: 'no verification command could be resolved for this workspace',
  dirty_too_large: `the workspace has more than ${DIRTY_ENTRIES_MAX} changed tracked files`,
  children_live: 'this session already has live agents',
  max_splits: 'this run has already used every split it is allowed',
  cooldown: 'the last split is too recent',
  resources: 'there is not enough cpu, memory or disk for two agents',
  money: 'the remaining budget cannot fund two agents',
  replan_step: 'this step is a replan',
  orchestration_problem: 'a recent orchestration problem still suppresses the gate',
  no_demand: 'nothing about this task asks for more than one agent',
};

/**
 * One short sentence per reason: the text of the `decompose:skipped` line under `--json=verbose` and
 * of the one-time hint. Corner row 14's three git reasons deliberately share one sentence — the human
 * fix is the same for all three, and naming which probe failed helps nobody.
 */
export function gateReasonText(why: GateReason): string {
  return REASON_TEXT[why];
}
