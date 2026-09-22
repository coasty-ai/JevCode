/**
 * Orchestration contract types (docs/ORCHESTRATION-DESIGN.md §4.1, "contract 1.5").
 *
 * The move is DONE: every contract shape now lives in `src/core/types.ts` under the `// contract 1.5` header,
 * which is where §4.1 always said it belongs ("orchestration rebases onto the commit that lands 1.4 and never
 * edits above it"). This file re-exports them so that `src/orchestrate/index.ts` and every existing importer
 * keeps working unchanged, and declares only what §8.1 rule 1 says is a seam rather than a contract shape:
 * `RunGit`, `RunGitOptions`, `Clock`, `AskFn`, `CommitIdentity`, `DEFAULT_SPLIT_POLICY` and the
 * planner-internal drafts. `SplitPolicy` is the local name of core's `OrchestrationPolicy` — the body lives in
 * core because §4.1 needs `EngineOptions.splitPolicy?` and `src/core/types.ts` may not import from here.
 *
 * §8.1 rule 1: nothing under `src/orchestrate/**` imports from `src/tui/**`, `src/cli/**`,
 * `src/session/**` or `src/config/**`. Everything that would come from there — `home`, the clock, git,
 * the ledger handle, identity, the resolved settings — arrives as an argument.
 */
import type { AgentRole, AgentSpec, Answer, ChoiceVerdict, Decision, ExecResult, Json, OrchestrationPolicy, Question, RejectedOption, SplitKind } from '../core/types.js';

// ---------------------------------------------------------------------------------------
// §4.1 — the contract shapes, now declared in `src/core/types.ts // contract 1.5`
// ---------------------------------------------------------------------------------------

export type {
  AgentRef,
  AgentRole,
  AgentRow,
  AgentSpec,
  AgentState,
  DemandReason,
  GateReason,
  LandAttempt,
  Manifest,
  RejectedOption,
  SplitKind,
  SyncedDirtyEntry,
  VerifyResult,
} from '../core/types.js';

// ---------------------------------------------------------------------------------------
// §8.1 rule 1 — the seams (these are declared HERE, not in core: they are wiring, not contract)
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
 * The body is `OrchestrationPolicy` in `src/core/types.ts` (core may not import from `src/orchestrate/**`,
 * and §4.1 puts `EngineOptions.splitPolicy?` in the contract); this alias is the name the planner uses.
 */
export type SplitPolicy = OrchestrationPolicy;

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
