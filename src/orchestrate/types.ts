/**
 * Orchestration contract types (docs/ORCHESTRATION-DESIGN.md §4.1, "contract 1.5").
 *
 * EVERY exported type in the first two sections below MOVES TO `src/core/types.ts` under the
 * `// contract 1.5` header once coordination's `// contract 1.4` line is in the tree (§4.1: "orchestration
 * rebases onto the commit that lands 1.4 and never edits above it"). They are declared here, locally, so
 * that this wave can land without touching `src/core/types.ts` at all. When they move, this file keeps
 * only the seams of §8.1 rule 1 (`RunGit`, `Clock`, `AskFn`, `SplitPolicy`) and re-exports the rest.
 *
 * §8.1 rule 1: nothing under `src/orchestrate/**` imports from `src/tui/**`, `src/cli/**`,
 * `src/session/**` or `src/config/**`. Everything that would come from there — `home`, the clock, git,
 * the ledger handle, identity, the resolved settings — arrives as an argument.
 */
import type { ExecResult, Json, Question, Answer, Decision, ChoiceVerdict, EngineMode, StageName, TestCounts } from '../core/types.js';

// ---------------------------------------------------------------------------------------
// §4.1 — new unions (move to core/types.ts, contract 1.5)
// ---------------------------------------------------------------------------------------

/** §3.2 + §3.4: the escape `no_split` is always present and is always the fallback. */
export type SplitKind = 'by_plan_item' | 'by_directory' | 'by_failing_test' | 'by_layer' | 'as_written' | 'no_split';

/** §2.5 / §3.4 rule 5 / §5.6: `research` is read-only and never lands; `critic` writes only test globs. */
export type AgentRole = 'code' | 'research' | 'critic';

/** §2.8: sixteen states; `paused` (a human asked) and `parked` (the child stopped itself) are separate [G22]. */
export type AgentState =
  | 'planned'
  | 'starting'
  | 'running'
  | 'paused'
  | 'parked'
  | 'review'
  | 'stalled'
  | 'done'
  | 'landing'
  | 'landed'
  | 'conflicted'
  | 'failed-verify'
  | 'kicked'
  | 'dropped'
  | 'crashed'
  | 'failed-start';

/** §3.1: the gate opens only when one of these holds as well as every all-of condition. */
export type DemandReason = 'disjoint_directories' | 'failing_tests' | 'human';

/** §3.1: why the gate is shut. One typed reason, so `decompose:skipped` is testable (M2). */
export type GateReason =
  | 'split_off'
  | 'child_depth'
  | 'no_ledger'
  | 'not_git'
  | 'unborn_head'
  | 'no_worktree_support'
  | 'plan_too_small'
  | 'blocking_unverified'
  | 'no_verification'
  | 'dirty_too_large'
  | 'children_live'
  | 'max_splits'
  | 'cooldown'
  | 'resources'
  | 'money'
  | 'replan_step'
  | 'orchestration_problem'
  | 'no_demand';

// ---------------------------------------------------------------------------------------
// §4.1 — new interfaces (move to core/types.ts, contract 1.5)
// ---------------------------------------------------------------------------------------

/** [D2] §2.3: one entry per file the worktree dirty-set sync wrote, binary-safe [G9]. */
export interface SyncedDirtyEntry {
  path: string;
  /** sha256 of the BYTES written into the worktree; '' for a file the sync deleted */
  sha256: string;
  /** st_mode & 0o7777 as the sync set it */
  mode: number;
}

/** §3.7: one row of the manifest. Produced only by the normaliser (§3.4). */
export interface AgentSpec {
  slug: string;
  /** <= AGENT_TASK_CHARS after redact + one-lining */
  task: string;
  /** <= OWN_GLOBS_MAX globs of the §3.4 rule 2 sub-language */
  own: readonly string[];
  role: AgentRole;
  /** <= VERIFY_COMMANDS_MAX commands, <= OWN_GLOB_CHARS chars each; [] only for 'research' */
  verify: readonly string[];
  /** slugs; a DAG of depth <= DEPENDS_DEPTH_MAX */
  dependsOn: readonly string[];
  capUsd: number;
  maxSteps: number;
  maxWallMs: number;
  mode: EngineMode;
  /** `jevcode/<slug>`; null for 'research' (§2.2, §3.4 rule 5) */
  branch: string | null;
}

/** §3.4: an option deleted by a normalisation rule, or clamped by rule 7. */
export interface RejectedOption {
  kind: SplitKind;
  reason: string;
  /** Jev's probability when the option reached ranking; null when code deleted it first */
  probability: number | null;
}

/** §3.7: the decomposition record, written to `<runDir>/orchestrate/manifest-<step>.json`. */
export interface Manifest {
  v: 1;
  manifestId: string;
  runId: string;
  sessionId: string;
  step: number;
  splitKind: SplitKind;
  verdict: ChoiceVerdict;
  probability: number;
  confidence: number;
  baseSha: string;
  repoKey: string | null;
  dockBranch: string;
  /**
   * [D2] what §2.3's `dirtySync` replayed into every agent worktree: excluded from each agent's commit
   * set (§2.6) unless that agent changed it, from §5.3's outside-`own` computation, and from the land diff.
   */
  syncedDirty: readonly SyncedDirtyEntry[];
  /** [D1] the subset of `syncedDirty` inside some agent's `own`: the paths §5.7's launch must ask about */
  dirtyOverlap: readonly string[];
  agents: readonly AgentSpec[];
  reserveUsd: number;
  reserveFrom: 'session' | 'run';
  rejected: readonly RejectedOption[];
  demand: DemandReason;
  createdAt: string;
  checksum: string;
}

/** §5.1 / §5.2: one verification command's result against a tree. */
export interface VerifyResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  /** <= VERIFY_TAIL_LINES lines of the combined output, redacted by the caller */
  tail: readonly string[];
  /** parsed by `workspace/tests.ts parseTestOutput` when the runner is known; null otherwise */
  counts: TestCounts | null;
  /** the command was killed by its timeout or the tree kill */
  killed: boolean;
}

/** §5.2: one append-only line of `<runDir>/orchestrate/land.jsonl`. */
export interface LandAttempt {
  at: string;
  slug: string;
  /** [G3] the sha the branch resolved to ONCE, before verification; never a ref */
  pinned: string;
  /** the dock head the merge started from — what a failure resets to */
  dockHead: string;
  outcome: 'landed' | 'conflicted' | 'failed-verify' | 'refused';
  /** the merge commit, when it landed */
  commit?: string;
  verify?: readonly VerifyResult[];
  /** the §5.3 hard rule that refused it */
  rule?: string;
  /** conflicting paths, for `conflicted` */
  conflicts?: readonly string[];
  /** 0 on the first attempt; the kick number afterwards (§5.4) */
  kick: number;
}

/** §2.2: how the surface names one child. */
export interface AgentRef {
  slug: string;
  /** null until the child's process reports `run:ready` */
  runId: string | null;
  sessionId: string | null;
}

/**
 * §4.6: the one row model every surface renders — the Ink tab, `--plain`, the screen-reader twin
 * and `jevcode agents list`. Declared here with the rest of contract 1.5; the pure row STRINGS are
 * built by `src/tui/agents/lines.ts` (wave D3 item 32), which is not this slot's file.
 */
export interface AgentRow {
  slug: string;
  state: AgentState;
  step: number;
  maxSteps: number;
  stage: StageName | 'idle';
  spendUsd: number;
  capUsd: number;
  wallMs: number;
  maxWallMs: number;
  own: readonly string[];
  branch: string | null;
  verify: readonly string[];
  /** the last transcript line of the child, clipped by the renderer */
  last: string;
  /** why it is `parked` / `stalled` / `failed-verify`; '' otherwise */
  why: string;
}

// ---------------------------------------------------------------------------------------
// §8.1 rule 1 — the seams (these STAY here when the rest moves to core/types.ts)
// ---------------------------------------------------------------------------------------

export interface RunGitOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

/**
 * The single git seam. Production binds it to `workspace/git.ts runGit(sandbox, dir, args, opts)` with
 * the per-worktree `Sandbox` of [D10]; tests bind it to a plain spawn against a real temp repo. Nothing
 * under `src/orchestrate/**` spawns git any other way.
 */
export type RunGit = (cwd: string, args: readonly string[], opts?: RunGitOptions) => Promise<ExecResult>;

/** Milliseconds since the epoch. `stall.ts` is pure over a fake one (§7.1). */
export type Clock = () => number;

/**
 * §3.5: one Jev request. `null` means no decider (jev-off, or the caller refuses to ask) and every
 * caller must then take its code fallback WITHOUT calling anything — that is the M2 property.
 */
export type AskFn = (state: Json, questions: Record<string, Question>) => Promise<{ answers: Record<string, Answer>; rows: Decision[] }>;

/** §2.6 [G1]: the identity every harness commit is made under; never the user's. */
export interface CommitIdentity {
  name: string;
  email: string;
}

/**
 * §4.1 `EngineOptions.splitPolicy` — every `orchestrate.*` setting this slot reads, already resolved.
 * `src/orchestrate/**` never imports `src/config/**` (§8.1 rule 1); wave D3 item 26 builds this object
 * from the `SETTINGS` rows of §6.4 and hands it in.
 */
export interface SplitPolicy {
  split: 'off' | 'ask' | 'auto';
  maxAgents: number;
  /** [G15] `coordination.maxChildren` — the ceiling `maxAgents` is clamped by */
  maxChildren: number;
  maxSplits: number;
  splitEvery: number;
  preludeMaxFiles: number;
  selfContainedFloor: number;
  reserveFraction: number;
  maxReserveUsd: number;
  minAgentUsd: number;
  agentMaxSteps: number;
  agentMaxWallMs: number;
  agentStallMs: number;
  onStall: 'notify' | 'pause' | 'kick';
  maxKicks: number;
  critic: 'tests' | 'run' | 'off';
  verify: readonly string[];
  verifyRetries: number;
  testGlobs: readonly string[];
  land: 'step' | 'branch';
  incidentalGlobs: readonly string[];
  agentMode: 'worktree' | 'copy';
  agentInclude: readonly string[];
  dockCleanExclude: readonly string[];
}

/**
 * §6.4's defaults, in one object, so every unit test and every pure function has a base to spread over.
 * The authoritative copy is the `SETTINGS` table (wave D3 item 26); `contract.test.ts` asserts the two
 * agree once that wave lands. `split` ships `off` [G21].
 */
export const DEFAULT_SPLIT_POLICY: SplitPolicy = {
  split: 'off',
  maxAgents: 3,
  maxChildren: 3,
  maxSplits: 2,
  splitEvery: 8,
  preludeMaxFiles: 8,
  selfContainedFloor: 0.5,
  reserveFraction: 0.5,
  maxReserveUsd: 2.0,
  minAgentUsd: 0.2,
  agentMaxSteps: 12,
  agentMaxWallMs: 15 * 60_000,
  agentStallMs: 10 * 60_000,
  onStall: 'notify',
  maxKicks: 1,
  critic: 'tests',
  verify: [],
  verifyRetries: 0,
  testGlobs: ['test/**', 'tests/**', 'spec/**', '**/*_test.*', '**/*.test.*', '**/test_*.py', '**/conftest.py'],
  land: 'step',
  incidentalGlobs: [],
  agentMode: 'worktree',
  agentInclude: ['.env', '.env.*'],
  dockCleanExclude: ['node_modules/', '.venv/', 'target/', '.gradle/', '.tox/', '.mypy_cache/'],
};

// ---------------------------------------------------------------------------------------
// Planner-internal shapes (§3.2 → §3.4 → §3.5); not part of contract 1.5
// ---------------------------------------------------------------------------------------

/**
 * §3.2 / §3.3: what an enumerator (or the generator's `propose_split`) produces, BEFORE the
 * normaliser assigns role, caps, `branch` and the `manifestId`.
 */
export interface DraftAgent {
  slug: string;
  task: string;
  own: readonly string[];
  verify: readonly string[];
  dependsOn?: readonly string[];
  role?: AgentRole;
  /** indices into `plan.remaining` this agent covers — the coverage rule 4 input and the §6.1 money weight `w_i` */
  items?: readonly number[];
}

/** §3.2: one candidate option. `no_split` is the zero-agent one and is always present. */
export interface DraftSplit {
  kind: SplitKind;
  agents: readonly DraftAgent[];
}

/** §3.4's output for one option: the normalised agents, or the first rule that deleted it. */
export type NormalizeResult = { ok: true; split: NormalizedSplit } | { ok: false; rejected: RejectedOption };

/** §3.4: an option that survived all nine rules. `manifestId` is computed here (§2.2's fixed order). */
export interface NormalizedSplit {
  kind: SplitKind;
  agents: readonly AgentSpec[];
  manifestId: string;
  /** §3.4 rule 9: `detectSecrets` hit the task or `own` of this many agents — a count, never a value */
  secretHits: number;
  /** rule 7's clamp, when one was applied ('3 agents clamped to 2 by coordination.maxChildren') */
  clampReason: string | null;
}

/** The whole enumerate → normalise → rank pipeline's answer (§3.4's last paragraph, §3.5). */
export interface RankedSplit {
  split: NormalizedSplit | null;
  splitKind: SplitKind;
  verdict: ChoiceVerdict;
  probability: number;
  confidence: number;
  rejected: readonly RejectedOption[];
  /** true when no Jev request was made at all — the O1(a) / M2 property */
  askedJev: boolean;
}
